import { getActor } from '@/lib/auth';
import { queueImport } from '@/lib/imports/service';
import { apiError, requireSameOrigin } from '@/lib/imports/http';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await getActor();
    const body = await request.json() as { batchId?: string; hash?: string; selectedRows?: number[] };
    if (!body.batchId || !body.hash) throw new Error('batchId and hash are required');
    const result = await queueImport(actor,body.batchId,body.hash,body.selectedRows);
    return Response.json(result,{ status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
