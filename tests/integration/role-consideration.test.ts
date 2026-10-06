import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { transaction, closeDatabase } from '../../src/lib/db';
import { mutateRecord, listRecords, getRecord, recordHistory } from '../../src/lib/records';
import { findMatches } from '../../src/lib/matching';
import { domains } from '../../src/lib/registry';
import type { Actor, Grant, RecordRow } from '../../src/lib/types';

const tenantId = randomUUID(), userId = randomUUID(), managerId = randomUUID(), hrId = randomUUID();
const owner: Actor = { tenantId, userId, sessionId: 'synthetic-owner', roles: [], authVersion: 1,
  grants: Object.values(domains).map(d => ({ domain: d.key, operation: '*', dataClass: d.dataClass, scope: 'tenant', orgId: null, validFrom: '2000-01-01', validTo: null })) };
const grant = (domain: string, operation: string, scope: Grant['scope'], orgId: string): Grant => ({ domain, operation, scope, orgId, dataClass: 'planning', validFrom: '2000-01-01', validTo: null });
describe.skipIf(!process.env.TEST_DATABASE_URL)('HR and manager role consideration on PostgreSQL', () => {
  let orgId: string, otherOrgId: string, managerWorkerId: string, workerId: string, otherWorkerId: string;
  let manager: Actor, hr: Actor, placement: RecordRow, need: RecordRow;
  const create = (domain: string, data: Record<string, unknown>, org?: string, worker?: string) => mutateRecord(owner, domain, { operation: 'CREATE', orgId: org, workerId: worker, validFrom: '2026-01-01', data });
  const person = (code: string, org: string) => create('workers', { code, homeOrgId: org, workerType: 'manual-only', employmentStatus: 'active' }, org);
  const details = { reason: 'Project ending, consider internal roles', availableFrom: '2026-11-01', placementDeadline: '2026-12-01', location: 'Chicago', workMode: 'hybrid', relocationPossible: false, fte: 1 };
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await transaction(tenantId, async tx => {
      await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'SYNTHETIC ROLE CONSIDERATION']);
      for (const id of [userId, managerId, hrId]) await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)', [id, tenantId, randomUUID()]);
    });
    orgId = (await create('org-units', { code: 'ROLE-SOURCE', name: 'Synthetic source', orgType: 'Team' })).id;
    otherOrgId = (await create('org-units', { code: 'ROLE-OTHER', name: 'Synthetic other', orgType: 'Team' })).id;
    managerWorkerId = (await person('SYNTHETIC-MANAGER', orgId)).id;
    workerId = (await person('SYNTHETIC-REPORT', orgId)).id;
    otherWorkerId = (await person('SYNTHETIC-OUTSIDE-REPORTS', otherOrgId)).id;
    await mutateRecord(owner, 'reporting-lines', { operation: 'CREATE', orgId, workerId, validFrom: '2026-01-01', data: { managerId: managerWorkerId, kind: 'primary' } });
    manager = { ...owner, userId: managerId, roles: ['Manager'], grants: [grant('workers', 'READ', 'reports', managerWorkerId),
      ...['READ', 'CREATE', 'UPDATE', 'ARCHIVE', 'RESTORE', 'FLAG_FOR_ROLES'].map(op => grant('redeployments', op, 'reports', managerWorkerId))] };
    hr = { ...owner, userId: hrId, roles: ['HR'], grants: [grant('workers', 'READ', 'org', orgId),
      ...['READ', 'CREATE', 'UPDATE', 'ARCHIVE', 'RESTORE', 'FLAG_FOR_ROLES'].map(op => grant('redeployments', op, 'org', orgId))] };
    const roleId = (await create('roles', { name: 'Synthetic retention role' })).id;
    need = await create('demands', { code: 'ROLE-NEED', roleId, requestType: 'transfer', fte: 1, priority: 'normal', businessCase: 'Keep internal skills', fundingStatus: 'funded', expectedStart: '2026-11-01' }, otherOrgId);
  });
  afterAll(closeDatabase);

  it('a scoped manager can flag a report without an employee request or identity/pay grants', async () => {
    placement = await mutateRecord(manager, 'redeployments', { operation: 'CREATE', orgId, workerId, validFrom: '2026-10-02', data: details });
    expect(placement.data.considerForRoles).toBe(true);
    expect((await findMatches(owner, { requestId: need.id, date: '2026-10-02' })).candidates.map(r => r.workerId)).toEqual([workerId]);
    expect((await getRecord(owner, 'workers', workerId))).toMatchObject({ version: 1, data: { employmentStatus: 'active' } });
    const history = await recordHistory(owner, 'redeployments', placement.id);
    expect(history.rows[0].data.considerForRoles).toBe(true);
    await transaction(tenantId, async tx => {
      expect((await tx.query('SELECT actor_id FROM record_history WHERE tenant_id=$1 AND domain=$2 AND record_id=$3', [tenantId, 'redeployments', placement.id])).rows).toEqual([{ actor_id: managerId }]);
    });
  });
  it('an HR role label and ordinary CRUD cannot toggle, archive or change publication dates', async () => {
    const ordinary = { ...hr, grants: hr.grants.filter(g => g.operation !== 'FLAG_FOR_ROLES') };
    for (const input of [
      { operation: 'UPDATE' as const, data: { considerForRoles: false } },
      { operation: 'ARCHIVE' as const },
      { operation: 'UPDATE' as const, validTo: '2026-10-03' },
    ]) await expect(mutateRecord(ordinary, 'redeployments', { id: placement.id, version: placement.version, ...input })).rejects.toMatchObject({ status: 403 });
    expect((await getRecord(owner, 'redeployments', placement.id)).version).toBe(1);
  });
  it('manager reports and HR organization scope block flagging a person outside scope', async () => {
    for (const actor of [manager, hr]) await expect(mutateRecord(actor, 'redeployments', { operation: 'CREATE', orgId: otherOrgId, workerId: otherWorkerId, validFrom: '2026-10-02', data: details })).rejects.toMatchObject({ status: 403 });
    await expect(mutateRecord({ ...owner, grants: [], roles: ['HR', 'Manager'] }, 'redeployments', { operation: 'CREATE', orgId, workerId: managerWorkerId, validFrom: '2026-10-02', data: details })).rejects.toMatchObject({ status: 403 });
  });
  it('HR can stop consideration, excluding matches/counts while retaining history and worker state', async () => {
    placement = await mutateRecord(hr, 'redeployments', { operation: 'UPDATE', id: placement.id, version: placement.version, validFrom: '2026-10-03', data: { considerForRoles: false } });
    expect((await findMatches(owner, { requestId: need.id, date: '2026-10-03' })).candidates).toEqual([]);
    expect((await listRecords(owner, 'redeployments', { date: '2026-10-03', considerForRoles: true })).total).toBe(0);
    expect((await listRecords(owner, 'redeployments', { date: '2026-10-03', considerForRoles: false })).total).toBe(1);
    expect((await findMatches(owner, { requestId: need.id, date: '2026-10-02' })).candidates).toHaveLength(1);
    expect((await recordHistory(owner, 'redeployments', placement.id)).rows).toHaveLength(2);
    expect((await getRecord(owner, 'workers', workerId)).version).toBe(1);
  });
  it('a manager can date a future reflag without making it effective early', async () => {
    placement = await mutateRecord(manager, 'redeployments', { operation: 'UPDATE', id: placement.id, version: placement.version, validFrom: '2026-10-10', data: { considerForRoles: true } });
    expect((await findMatches(owner, { requestId: need.id, date: '2026-10-09' })).candidates).toEqual([]);
    expect((await findMatches(owner, { requestId: need.id, date: '2026-10-10' })).candidates).toHaveLength(1);
    await expect(mutateRecord(hr, 'redeployments', { operation: 'UPDATE', id: placement.id, version: placement.version - 1, data: { considerForRoles: false } })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('ordinary editing cannot use a new unflagged person to enable matching without the flag grant', async () => {
    const ordinary = { ...owner, grants: owner.grants.filter(g => g.domain !== 'redeployments').concat(['READ', 'CREATE', 'UPDATE'].map(op => grant('redeployments', op, 'org', otherOrgId))) };
    const draft = await mutateRecord(ordinary, 'redeployments', { operation: 'CREATE', orgId: otherOrgId, workerId: otherWorkerId, validFrom: '2026-10-02', data: { ...details, considerForRoles: false } });
    await expect(mutateRecord(ordinary, 'redeployments', { operation: 'UPDATE', id: draft.id, version: draft.version, data: { considerForRoles: true } })).rejects.toMatchObject({ status: 403 });
    expect((await findMatches(owner, { requestId: need.id, date: '2026-10-10' })).candidates.map(r => r.workerId)).toEqual([workerId]);
  });
  it('uses the decision-date reporting relationship when a manager inherits a previously flagged person', async () => {
    const incomingManager = (await person('SYNTHETIC-INCOMING-MANAGER', orgId)).id;
    const inheritedWorker = (await person('SYNTHETIC-INHERITED-REPORT', orgId)).id;
    await mutateRecord(owner, 'reporting-lines', { operation: 'CREATE', orgId, workerId: inheritedWorker, validFrom: '2026-01-01', validTo: '2026-10-01', data: { managerId: managerWorkerId, kind: 'primary' } });
    await mutateRecord(owner, 'reporting-lines', { operation: 'CREATE', orgId, workerId: inheritedWorker, validFrom: '2026-10-01', data: { managerId: incomingManager, kind: 'primary' } });
    let inherited = await mutateRecord(owner, 'redeployments', { operation: 'CREATE', orgId, workerId: inheritedWorker, validFrom: '2026-01-02', data: details });
    const incoming = { ...manager, grants: manager.grants.map(g => ({ ...g, orgId: incomingManager })) };
    expect((await getRecord(incoming, 'redeployments', inherited.id, '2026-10-02')).id).toBe(inherited.id);
    expect((await getRecord(incoming, 'workers', inheritedWorker, '2026-10-02')).data.code).toBe('SYNTHETIC-INHERITED-REPORT');
    await expect(getRecord(manager, 'redeployments', inherited.id, '2026-10-02')).rejects.toMatchObject({ status: 404 });
    inherited = await mutateRecord(incoming, 'redeployments', { operation: 'UPDATE', id: inherited.id, version: inherited.version, validFrom: '2026-10-02', data: { considerForRoles: false } });
    expect(inherited.data.considerForRoles).toBe(false);
    await expect(mutateRecord(manager, 'redeployments', { operation: 'UPDATE', id: inherited.id, version: inherited.version, validFrom: '2026-10-02', data: { considerForRoles: true } })).rejects.toMatchObject({ status: 403 });
  });
});
