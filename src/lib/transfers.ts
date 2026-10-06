import Decimal from 'decimal.js';
import { z } from 'zod';
import { transaction, type DbClient } from './db';
import { assertPermission } from './policy';
import { invariant } from './errors';
import { mutateRecord, persistRevision, readLocked, recordRow } from './records';
import { consideredForRoles } from './role-consideration';
import { isoDate } from './validation';
import { domains } from './registry';
import type { Actor, RecordRow } from './types';

const proposalInput = z.object({ placementId: z.uuid(), demandId: z.uuid(), destinationManagerId: z.uuid(), effectiveFrom: isoDate, reason: z.string().trim().min(5).max(2000) }).strict();
const homeDomains = ['identities', 'directory-accounts', 'external-identifiers', 'contracts', 'hired-for', 'worker-skills', 'compensation', 'reveals', 'redeployments'] as const;

export function assertTransferDetails(proposal: RecordRow) {
  invariant(proposal.data.destinationManagerId && proposal.data.workerVersion && proposal.data.placementId && proposal.data.placementVersion, 'TRANSFER_DETAILS_REQUIRED', 422, 'Choose a considered person and destination manager through Find matches.');
  invariant(!proposal.validTo, 'PERMANENT_TRANSFER_END_NOT_ALLOWED');
}

// Capture live versions on the server; callers cannot invent a matching or capacity baseline.
export async function proposeTransfer(actor: Actor, raw: unknown) {
  const input = proposalInput.parse(raw);
  return transaction(actor.tenantId, async tx => {
    const placement = await readLocked(tx, actor, 'redeployments', input.placementId, 'READ', input.effectiveFrom);
    invariant(consideredForRoles(placement), 'PERSON_NOT_CONSIDERED', 409);
    const worker = await readLocked(tx, actor, 'workers', String(placement.workerId), 'READ', input.effectiveFrom);
    const demand = await readLocked(tx, actor, 'demands', input.demandId, 'READ', input.effectiveFrom);
    invariant(['approved', 'partially-filled', 'sourcing'].includes(demand.state), 'APPROVED_DEMAND_REQUIRED', 409, 'The team request must be approved before proposing a transfer.');
    const source = (await tx.query("SELECT * FROM assignments WHERE tenant_id=$1 AND worker_id=$2 AND org_id=$3 AND state<>'archived' AND valid_from<=$4 AND data->>'kind'='primary' AND data->>'allocationStatus' IN ('committed','actual') ORDER BY valid_from DESC,id LIMIT 1 FOR UPDATE", [actor.tenantId, worker.id, worker.orgId, input.effectiveFrom])).rows[0];
    invariant(source, 'PRIMARY_ASSIGNMENT_REQUIRED');
    const assignment = recordRow(source);
    await assertPermission(actor, 'assignments', 'READ', assignment.orgId, undefined, tx, input.effectiveFrom, worker.id);
    return mutateRecord(actor, 'movements', { operation: 'CREATE', orgId: demand.orgId, workerId: worker.id, validFrom: input.effectiveFrom, data: {
      demandId: demand.id, sourceOrgId: worker.orgId, destinationOrgId: demand.orgId, sourceAssignmentId: assignment.id,
      sourceVersion: assignment.version, destinationVersion: demand.version, workerVersion: worker.version,
      placementId: placement.id, placementVersion: placement.version, destinationManagerId: input.destinationManagerId,
      roleId: demand.data.roleId, fte: assignment.data.fte, kind: 'transfer', businessCase: input.reason,
    } }, tx);
  });
}

async function endRecord(tx: DbClient, actor: Actor, domain: string, row: RecordRow, date: string) {
  await assertPermission(actor, domain, 'UPDATE', row.orgId, undefined, tx, date, row.workerId);
  invariant(row.validFrom <= date, 'FUTURE_RECORD_REQUIRES_REVISED_PROPOSAL', 409);
  if (row.validTo && row.validTo <= date) return;
  const next = row.validFrom === date ? { ...row, state: 'archived' } : { ...row, validTo: date };
  await persistRevision(tx, actor, domain, { ...next, version: row.version + 1 }, 'TRANSFER_END');
}

export async function commitPermanentTransfer(tx: DbClient, actor: Actor, proposal: RecordRow) {
  assertTransferDetails(proposal);
  const date = proposal.validFrom, data = proposal.data, workerId = String(proposal.workerId);
  // The worker lock serializes competing moves and the ordinary assignment allocator.
  const worker = await readLocked(tx, actor, 'workers', workerId, 'UPDATE', date);
  const source = await readLocked(tx, actor, 'assignments', String(data.sourceAssignmentId), 'UPDATE', date);
  const demand = await readLocked(tx, actor, 'demands', String(data.demandId), 'UPDATE', date);
  const placement = await readLocked(tx, actor, 'redeployments', String(data.placementId), 'UPDATE', date);
  invariant(worker.version === Number(data.workerVersion) && source.version === Number(data.sourceVersion) && demand.version === Number(data.destinationVersion) && placement.version === Number(data.placementVersion), 'STALE_MOVEMENT_BASELINE', 409);
  invariant(worker.orgId === data.sourceOrgId && source.orgId === worker.orgId && source.workerId === worker.id && placement.workerId === worker.id && placement.orgId === worker.orgId && demand.orgId === data.destinationOrgId && proposal.orgId === demand.orgId && worker.orgId !== demand.orgId, 'MOVEMENT_SCOPE_MISMATCH');
  invariant(worker.state === 'active' && worker.data.employmentStatus === 'active' && worker.validFrom <= date && (!worker.validTo || worker.validTo > date), 'ACTIVE_WORKER_REQUIRED');
  invariant(['approved', 'partially-filled', 'sourcing'].includes(demand.state) && demand.validFrom <= date && (!demand.validTo || demand.validTo > date), 'APPROVED_DEMAND_REQUIRED');
  invariant(data.roleId === demand.data.roleId && (!demand.data.expectedStart || date >= String(demand.data.expectedStart)), 'MOVEMENT_REQUEST_MISMATCH');
  invariant(consideredForRoles(placement) && placement.validFrom <= date && (!placement.validTo || placement.validTo > date) && String(placement.data.availableFrom) <= date && (!placement.data.placementDeadline || date < String(placement.data.placementDeadline)), 'PERSON_NOT_AVAILABLE', 409);
  const quantity = new Decimal(String(data.fte));
  invariant(source.state !== 'archived' && source.validFrom <= date && source.data.kind === 'primary' && ['committed', 'actual'].includes(String(source.data.allocationStatus)) && quantity.equals(String(source.data.fte)), 'FULL_PRIMARY_TRANSFER_REQUIRED');
  const manager = await readLocked(tx, actor, 'workers', String(data.destinationManagerId), 'READ', date);
  invariant(manager.id !== worker.id && manager.orgId === demand.orgId && manager.validFrom <= date && (!manager.validTo || manager.validTo > date) && manager.state === 'active' && manager.data.employmentStatus === 'active', 'INVALID_DESTINATION_MANAGER');
  await assertPermission(actor, 'workers', 'UPDATE', demand.orgId, undefined, tx, date, worker.id);
  await assertPermission(actor, 'redeployments', 'FLAG_FOR_ROLES', placement.orgId, undefined, tx, date, worker.id);
  await assertPermission(actor, 'redeployments', 'FLAG_FOR_ROLES', demand.orgId, undefined, tx, date, worker.id);

  // TRANSFER_SCOPE authorizes metadata relocation only. It grants neither reading nor changing pay/identity fields.
  // Check every class before inspecting its records, so a denied caller cannot infer protected record existence.
  for (const domain of homeDomains) for (const orgId of [worker.orgId, demand.orgId])
    await assertPermission(actor, domain, 'TRANSFER_SCOPE', orgId, domains[domain].dataClass, tx, date, worker.id);
  const related: { domain: string; row: RecordRow }[] = [];
  for (const domain of homeDomains) {
    const rows = (await tx.query(`SELECT * FROM ${domains[domain].table} WHERE tenant_id=$1 AND worker_id=$2 AND state<>'archived' AND (valid_to IS NULL OR valid_to>$3) ORDER BY id FOR UPDATE`, [actor.tenantId, worker.id, date])).rows.map(recordRow);
    for (const row of rows) {
      invariant(row.validFrom <= date, 'FUTURE_RECORD_REQUIRES_REVISED_PROPOSAL', 409);
      invariant(row.orgId === worker.orgId, 'WORKER_HOME_SCOPE_MISMATCH');
      related.push({ domain, row });
    }
  }
  const contracts = related.filter(item => item.domain === 'contracts');
  invariant(contracts.length === 1 && (!contracts[0].row.validTo || (worker.validTo && contracts[0].row.validTo >= worker.validTo)) && contracts[0].row.data.movable === true && contracts[0].row.data.confirmedOn && String(contracts[0].row.data.confirmedOn) <= date, 'MANAGER_CAPACITY_CONFIRMATION_REQUIRED');
  const other = await tx.query("SELECT 1 FROM assignments WHERE tenant_id=$1 AND worker_id=$2 AND id<>$3 AND state<>'archived' AND data->>'allocationStatus' IN ('committed','actual') AND (valid_to IS NULL OR valid_to>$4) LIMIT 1", [actor.tenantId, worker.id, source.id, date]);
  invariant(!other.rowCount, 'OTHER_ASSIGNMENTS_REQUIRE_REVISED_PROPOSAL');
  const constraints = await tx.query("SELECT 1 FROM availability WHERE tenant_id=$1 AND worker_id=$2 AND state<>'archived' AND data->>'approved'='true' AND (data->>'fraction')::numeric>0 AND (valid_to IS NULL OR valid_to>$3) LIMIT 1", [actor.tenantId, worker.id, date]);
  invariant(!constraints.rowCount, 'LEAVE_OR_CONSTRAINT_REQUIRES_REVISED_PROPOSAL');
  const fillEnd = [worker.validTo, demand.validTo].filter((end): end is string => end !== null).sort()[0] ?? null;
  const supply = quantity.mul(String(contracts[0].row.data.fte));
  invariant(supply.lte(String(placement.data.fte)), 'INSUFFICIENT_PLACEMENT_FTE');
  // Check each dated fulfillment boundary; an ended fill must not consume future capacity.
  const fills = (await tx.query("SELECT * FROM fulfillments WHERE tenant_id=$1 AND data->>'demandId'=$2 AND data->>'approved'='true' AND state<>'archived' AND (valid_to IS NULL OR valid_to>$3) ORDER BY id FOR UPDATE", [actor.tenantId, demand.id, date])).rows.map(recordRow);
  const points = new Set([date, ...fills.flatMap(row => [row.validFrom, ...(row.validTo ? [row.validTo] : [])]).filter(point => point >= date)]);
  for (const point of points) {
    if (fillEnd && point >= fillEnd) continue;
    const used = fills.filter(row => row.validFrom <= point && (!row.validTo || row.validTo > point)).reduce((total, row) => total.plus(String(row.data.fte)), new Decimal(0));
    invariant(used.plus(supply).lte(String(demand.data.fte)), 'DEMAND_OVERFULFILLMENT');
  }
  const lines = (await tx.query("SELECT * FROM reporting_lines WHERE tenant_id=$1 AND worker_id=$2 AND state<>'archived' AND (valid_to IS NULL OR valid_to>$3) ORDER BY id FOR UPDATE", [actor.tenantId, worker.id, date])).rows.map(recordRow);
  for (const line of lines) await endRecord(tx, actor, 'reporting-lines', line, date);
  await endRecord(tx, actor, 'assignments', source, date);
  await mutateRecord(actor, 'workers', { operation: 'UPDATE', id: worker.id, version: worker.version, orgId: demand.orgId, validFrom: date, data: { homeOrgId: demand.orgId } }, tx);
  for (const { domain, row } of related) {
    const moved = { ...row, orgId: demand.orgId, validFrom: date, version: row.version + 1 };
    if (domain === 'redeployments') { moved.state = 'placed'; moved.data = { ...row.data, considerForRoles: false }; }
    if (domain === 'reveals') {
      moved.state = 'revoked';
      await tx.query("DELETE FROM access_grants WHERE tenant_id=$1 AND source='reveal' AND source_key=$2", [actor.tenantId, row.id]);
    }
    await persistRevision(tx, actor, domain, moved, 'TRANSFER_SCOPE');
  }
  await mutateRecord(actor, 'reporting-lines', { operation: 'CREATE', orgId: demand.orgId, workerId, validFrom: date, validTo: [worker.validTo, manager.validTo].filter((end): end is string => end !== null).sort()[0] ?? null, data: { managerId: manager.id, kind: 'primary' } }, tx);
  await mutateRecord(actor, 'assignments', { operation: 'CREATE', orgId: demand.orgId, workerId, validFrom: date, validTo: worker.validTo, data: { roleId: data.roleId, fte: quantity.toNumber(), kind: 'primary', allocationStatus: 'committed', managerConfirmed: true, movementId: proposal.id } }, tx);
  await mutateRecord(actor, 'fulfillments', { operation: 'CREATE', orgId: demand.orgId, workerId, validFrom: date, validTo: fillEnd, data: { demandId: demand.id, fte: supply.toNumber(), kind: 'transfer', approved: true, movementId: proposal.id } }, tx);
  const coversNeed = (end: string | null) => !end || (!!demand.validTo && end >= demand.validTo);
  const atStart = fills.filter(row => row.validFrom <= date && coversNeed(row.validTo)).reduce((total, row) => total.plus(String(row.data.fte)), coversNeed(fillEnd) ? supply : new Decimal(0));
  await persistRevision(tx, actor, 'demands', { ...demand, validFrom: date, version: demand.version + 1, state: atStart.equals(String(demand.data.fte)) ? 'filled' : 'partially-filled' }, 'FULFILL');
  const committed = { ...proposal, version: proposal.version + 1, state: 'committed' };
  await persistRevision(tx, actor, 'movements', committed, 'COMMIT');
  return { record: committed, impact: { transferredFte: supply.toFixed(2), enterprisePayrollSavings: '0.00' } };
}
