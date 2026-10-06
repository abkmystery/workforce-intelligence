import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { transaction, closeDatabase } from '../../src/lib/db';
import { mutateRecord, getRecord } from '../../src/lib/records';
import { findMatches } from '../../src/lib/matching';
import { domains } from '../../src/lib/registry';
import type { Actor, RecordRow } from '../../src/lib/types';

const tenantId = randomUUID(), userId = randomUUID();
const actor: Actor = { tenantId, userId, sessionId: 'synthetic', roles: [], authVersion: 1,
  grants: Object.values(domains).map(d => ({ domain: d.key, operation: '*', dataClass: d.dataClass, orgId: null, scope: 'tenant', validFrom: '2000-01-01', validTo: null })) };
describe.skipIf(!process.env.TEST_DATABASE_URL)('real PostgreSQL internal placement and privacy', () => {
  let source: string, destination: string, person: RecordRow, placement: RecordRow, need: RecordRow, pay: RecordRow, skill: string;
  const validFrom = '2026-01-01', asOf = '2026-10-02';
  const create = (domain: string, data: Record<string, unknown>, orgId?: string, workerId?: string) => mutateRecord(actor, domain, { operation: 'CREATE', validFrom, orgId, workerId, data });
  const planningActor = () => ({ ...actor, grants: actor.grants.filter(g => g.dataClass === 'planning') });
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await transaction(tenantId, async tx => {
      await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'SYNTHETIC RETENTION TEST']);
      await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)', [userId, tenantId, randomUUID()]);
    });
    source = (await create('org-units', { code: 'SOURCE', name: 'Synthetic source', orgType: 'Team' })).id;
    destination = (await create('org-units', { code: 'DEST', name: 'Synthetic destination', orgType: 'Team' })).id;
    const role = (await create('roles', { name: 'Synthetic analyst' })).id;
    skill = (await create('skills', { name: 'Synthetic SQL' })).id;
    person = await create('workers', { code: 'SYNTHETIC-PERSON', homeOrgId: source, workerType: 'manual-only', employmentStatus: 'active' }, source);
    placement = await create('redeployments', { reason: 'Project ending', availableFrom: '2026-11-01', placementDeadline: '2026-12-01', location: 'Chicago', workMode: 'hybrid', relocationPossible: false, fte: 1 }, source, person.id);
    need = await create('demands', { code: 'SYNTHETIC-NEED', roleId: role, requestType: 'transfer', fte: 1, priority: 'normal', businessCase: 'Retain internal skills', fundingStatus: 'funded', geography: 'Chicago', workMode: 'hybrid', expectedStart: '2026-11-01', maxAnnualSalary: 100000, salaryCurrency: 'USD' }, destination);
    await create('request-skills', { demandId: need.id, skillId: skill, required: true }, destination);
    await create('worker-skills', { skillId: skill, level: 'proficient', verified: true, expiresOn: '2027-01-01' }, source, person.id);
    pay = await create('compensation', { amount: 87654.32, currency: 'USD', basis: 'annual', burdenPercent: 0, paidFte: 1, source: 'SYNTHETIC' }, source, person.id);
    await create('identities', { displayName: 'SECRET SYNTHETIC NAME' }, source, person.id);
  });
  afterAll(closeDatabase);
  it('compares published people without identity or salary payload leakage or changing employment', async () => {
    const result = await findMatches(planningActor(), { requestId: need.id, date: asOf });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].evidence).toMatchObject({ skills: 'All required skills have current verified evidence', dates: 'Available by the requested start', salary: 'Salary permission required' });
    expect(JSON.stringify(result)).not.toMatch(/SECRET SYNTHETIC NAME|87654/);
    expect((await getRecord(actor, 'workers', person.id)).version).toBe(1);
    expect((await getRecord(actor, 'redeployments', placement.id)).state).toBe('active');
  });
  it('hidden salary cannot affect candidate order, evidence or visibility; authorized comparison is separate', async () => {
    const before = await findMatches(planningActor(), { requestId: need.id, date: asOf });
    expect((await findMatches(actor, { requestId: need.id, date: asOf })).candidates[0].evidence.salary).toContain('Within');
    pay = await mutateRecord(actor, 'compensation', { operation: 'UPDATE', id: pay.id, version: pay.version, data: { amount: 987654.32 } });
    expect(await findMatches(planningActor(), { requestId: need.id, date: asOf })).toEqual(before);
    expect((await findMatches(actor, { requestId: need.id, date: asOf })).candidates[0].evidence.salary).toContain('Above');
    await transaction(tenantId, async tx => {
      const payloads = (await tx.query("SELECT metadata FROM audit_events WHERE tenant_id=$1 AND domain='compensation'", [tenantId])).rows;
      expect(JSON.stringify(payloads)).not.toMatch(/987654|87654|SECRET/);
    });
  });
  it('enforces both person and pool organization scope and rejects guessed requests', async () => {
    const scoped: Actor = { ...planningActor(), grants: planningActor().grants.map(g => ({ ...g, scope: 'org', orgId: destination })) };
    expect((await findMatches(scoped, { requestId: need.id, date: asOf })).candidates).toEqual([]);
    const denied = { ...actor, grants: [] };
    await expect(findMatches(denied, { requestId: need.id, date: asOf })).rejects.toMatchObject({ status: 404 });
    await transaction(randomUUID(), async tx => { expect((await tx.query('SELECT * FROM redeployments')).rowCount).toBe(0); });
  });
  it('treats missing skill permission as unknown and expiry on the needed date as lacking evidence', async () => {
    const restricted = { ...planningActor(), grants: planningActor().grants.filter(g => g.domain !== 'worker-skills') };
    expect((await findMatches(restricted, { requestId: need.id, date: asOf })).candidates[0].evidence.skills).toContain('permission required');
    need = await mutateRecord(actor, 'demands', { operation: 'UPDATE', id: need.id, version: need.version, data: { expectedStart: '2027-01-01' } });
    const candidate = (await findMatches(actor, { requestId: need.id, date: asOf })).candidates[0];
    expect(candidate.evidence.skills).toContain('lack current verified evidence');
    expect(candidate.evidence.dates).toContain('misses the placement deadline');
  });
  it('preserves future placement revisions and validates the person, FTE and deadline', async () => {
    placement = await mutateRecord(actor, 'redeployments', { operation: 'UPDATE', id: placement.id, version: placement.version, validFrom: '2026-11-15', data: { reason: 'Future revised placement' } });
    expect((await findMatches(actor, { requestId: need.id, date: asOf })).candidates[0].reason).toBe('Project ending');
    expect((await findMatches(actor, { requestId: need.id, date: '2026-11-16' })).candidates[0].reason).toBe('Future revised placement');
    expect((await getRecord(actor, 'redeployments', placement.id, asOf)).data.reason).toBe('Project ending');
    expect((await getRecord(actor, 'redeployments', placement.id, '2026-11-16')).data.reason).toBe('Future revised placement');
    await expect(getRecord(planningActor(), 'compensation', pay.id, asOf)).rejects.toMatchObject({ status: 404 });
    await expect(getRecord(planningActor(), 'identities', randomUUID(), asOf)).rejects.toMatchObject({ status: 404 });
    await expect(mutateRecord(actor, 'redeployments', { operation: 'UPDATE', id: placement.id, version: placement.version, workerId: randomUUID() })).rejects.toMatchObject({ code: 'PLACEMENT_PERSON_IMMUTABLE' });
    await expect(mutateRecord(actor, 'redeployments', { operation: 'UPDATE', id: placement.id, version: placement.version, data: { fte: 2 } })).rejects.toMatchObject({ code: 'INVALID_FTE' });
    await expect(mutateRecord(actor, 'redeployments', { operation: 'UPDATE', id: placement.id, version: placement.version, data: { placementDeadline: '2026-11-01' } })).rejects.toMatchObject({ code: 'INVALID_PLACEMENT_WINDOW' });
  });
});
