import { api } from '@/lib/http';
import { listRecords, today } from '@/lib/records';
import { isoDate } from '@/lib/validation';
import { z } from 'zod';

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  return api(request, async actor => {
    const date = isoDate.parse(q.get('date') ?? today());
    const orgId = z.uuid().optional().parse(q.get('orgId') ?? undefined);
    const filter = { date, orgId, pageSize: 1 };
    const [people, needs, transfers] = await Promise.all([
      listRecords(actor, 'redeployments', { ...filter, considerForRoles: true }),
      listRecords(actor, 'demands', filter),
      listRecords(actor, 'movements', filter),
    ]);
    return { asOf: date, quality: [], metrics: [
      { label: 'People considered for roles', value: people.total, description: 'People flagged by an authorized manager or HR for internal matching' },
      { label: 'Team requests', value: needs.total, description: 'Requests across draft, review and fulfillment stages' },
      { label: 'Transfer proposals', value: transfers.total, description: 'Proposals across review and committed stages' },
    ] };
  });
}
