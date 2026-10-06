import { z } from 'zod';
import { transaction, type DbClient } from './db';
import { assertFresh, scopePredicate } from './policy';
import { datedSource, recordRow, today } from './records';
import { isoDate } from './validation';
import { AppError } from './errors';
import { audit } from './audit';
import { placementEvidence, type MatchResult } from './matching-contract';
import type { Actor, RecordRow } from './types';
import { considerationPredicate } from './role-consideration';

export const matchQuery = z.object({ requestId: z.uuid(), date: isoDate.optional(), page: z.coerce.number().int().min(1).max(10000).default(1) });
async function readableRows(tx: DbClient, actor: Actor, domain: string, date: string, extra: string, params: unknown[]) {
  const values: unknown[] = [actor.tenantId, date, ...params];
  const scope = scopePredicate(actor, domain, 'READ', 'r', values, date);
  return (await tx.query(`SELECT r.* FROM ${datedSource(domain)} r WHERE r.state<>'archived' AND (r.valid_to IS NULL OR r.valid_to>$2::date) AND ${extra} AND ${scope}`, values)).rows.map(recordRow);
}
async function canReadPersonDomain(tx: DbClient, actor: Actor, domain: string, worker: RecordRow, date: string) {
  const values: unknown[] = [actor.tenantId, worker.orgId, worker.workerId ?? worker.id];
  const scope = scopePredicate(actor, domain, 'READ', 'r', values, date);
  return Boolean((await tx.query(`SELECT 1 FROM (SELECT $1::uuid tenant_id,$2::uuid org_id,$3::uuid worker_id,$3::uuid id) r WHERE ${scope}`, values)).rowCount);
}

export async function findMatches(actor: Actor, raw: z.input<typeof matchQuery>): Promise<MatchResult> {
  const input = matchQuery.parse(raw), asOf = input.date ?? today();
  return transaction(actor.tenantId, async tx => {
    await assertFresh(actor, tx);
    const [need] = await readableRows(tx, actor, 'demands', asOf, 'r.id=$3::uuid', [input.requestId]);
    if (!need || ['cancelled', 'rejected', 'filled'].includes(need.state)) throw new AppError(404, 'OPEN_REQUEST_NOT_FOUND');
    const neededFrom = String(need.data.expectedStart ?? need.validFrom);
    const requestSkillAccess = await canReadPersonDomain(tx, actor, 'request-skills', need, asOf);
    const requestSkills = await readableRows(tx, actor, 'request-skills', asOf, "r.data->>'demandId'=$3", [need.id]);
    const requiredSkillIds = [...new Set(requestSkills.filter(r => r.data.required === true).map(r => String(r.data.skillId)))];
    const values: unknown[] = [actor.tenantId, asOf];
    const poolScope = scopePredicate(actor, 'redeployments', 'READ', 'p', values, asOf);
    const workerScope = scopePredicate(actor, 'workers', 'READ', 'w', values, neededFrom);
    values.push(neededFrom); const start = '$' + values.length;
    values.push(51); const limit = '$' + values.length;
    values.push((input.page - 1) * 50); const offset = '$' + values.length;
    const pool = (await tx.query(`SELECT p.*,w.data AS worker_data,w.org_id AS worker_org FROM ${datedSource('redeployments')} p
      JOIN ${datedSource('workers').replaceAll('$2', start)} w ON w.id=p.worker_id
      WHERE ${considerationPredicate('p')} AND (p.valid_to IS NULL OR p.valid_to>$2::date) AND ${poolScope}
      AND w.state<>'archived' AND w.data->>'employmentStatus' IN ('active','leave') AND (w.valid_to IS NULL OR w.valid_to>${start}::date) AND ${workerScope}
      ORDER BY p.id LIMIT ${limit} OFFSET ${offset}`, values)).rows;
    const candidates = [];
    for (const item of pool.slice(0, 50)) {
      const placement = recordRow(item);
      const worker = { ...placement, id: placement.workerId!, orgId: item.worker_org, data: item.worker_data };
      const skillsReadable = requestSkillAccess && await canReadPersonDomain(tx, actor, 'worker-skills', worker, neededFrom);
      const skills = skillsReadable ? await readableRows(tx, actor, 'worker-skills', neededFrom, 'r.worker_id=$3::uuid', [worker.id]) : [];
      const verifiedSkillIds = skills.filter(r => r.data.verified === true && (!r.data.expiresOn || String(r.data.expiresOn) > neededFrom)).map(r => String(r.data.skillId));
      const salaryReadable = need.data.maxAnnualSalary != null && await canReadPersonDomain(tx, actor, 'compensation', worker, neededFrom);
      const payRows = salaryReadable ? await readableRows(tx, actor, 'compensation', neededFrom, 'r.worker_id=$3::uuid', [worker.id]) : [];
      if (salaryReadable) await audit(tx, actor, 'READ', 'compensation', worker.id, { count: payRows.length });
      const pay = payRows.length === 1 ? payRows[0].data : undefined;
      candidates.push({ placementId: placement.id, workerId: worker.id, code: String(worker.data.code), reason: String(placement.data.reason),
        availableFrom: String(placement.data.availableFrom), placementDeadline: placement.data.placementDeadline ? String(placement.data.placementDeadline) : null,
        evidence: placementEvidence({ neededFrom, availableFrom: String(placement.data.availableFrom), placementDeadline: placement.data.placementDeadline as string | null,
          requiredSkillIds, verifiedSkillIds, skillsReadable, needLocation: need.data.geography as string | undefined, location: String(placement.data.location),
          needWorkMode: need.data.workMode as string | undefined, workMode: String(placement.data.workMode), relocationPossible: placement.data.relocationPossible === true,
          neededFte: Number(need.data.fte), availableFte: Number(placement.data.fte), headcount: need.data.headcount as number | undefined,
          budget: need.data.maxAnnualSalary as number | undefined, currency: need.data.salaryCurrency as string | undefined, salaryReadable,
          pay: pay ? { amount: Number(pay.amount), currency: String(pay.currency), basis: String(pay.basis), paidFte: Number(pay.paidFte) } : undefined }),
      });
    }
    await assertFresh(actor, tx);
    return { requestId: need.id, code: String(need.data.code), neededFrom, asOf, page: input.page, hasMore: pool.length > 50, candidates };
  });
}
