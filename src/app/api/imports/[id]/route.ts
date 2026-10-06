import { getActor } from '@/lib/auth';
import { getImport } from '@/lib/imports/service';
import { apiError } from '@/lib/imports/http';

export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor();
    const { id } = await context.params;
    return Response.json(await getImport(actor,id),{ headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
