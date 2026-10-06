import { getActor } from '@/lib/auth';
import { reverseImport } from '@/lib/imports/service';
import { apiError, requireSameOrigin } from '@/lib/imports/http';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await getActor();
    const body = await request.json() as { batchId?: string };
    if (!body.batchId) throw new Error('batchId is required');
    return Response.json(await reverseImport(actor,body.batchId),{ headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
