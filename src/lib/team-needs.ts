import { z } from 'zod';
import { transaction } from './db';
import { mutateRecord } from './records';
import { mutationSchema } from './validation';
import type { Actor } from './types';
const inputSchema = z.object({ record: mutationSchema.extend({ operation: z.literal('CREATE') }), skillIds: z.array(z.uuid()).max(50) }).strict();
export async function createTeamNeed(actor: Actor, raw: unknown) {
  const input = inputSchema.parse(raw);
  return transaction(actor.tenantId, async tx => {
    const need = await mutateRecord(actor, 'demands', input.record, tx);
    for (const skillId of new Set(input.skillIds)) await mutateRecord(actor, 'request-skills', { operation: 'CREATE', orgId: need.orgId, validFrom: need.validFrom, validTo: need.validTo, data: { demandId: need.id, skillId, required: true } }, tx);
    return need;
  });
}
