import { getActor } from '@/lib/auth';
import { apiError } from '@/lib/imports/http';
import { downloadStoredExport } from '@/lib/imports/service';

export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor();
    const { id } = await context.params;
    const { bytes, domain, format } = await downloadStoredExport(actor,id);
    return new Response(new Uint8Array(bytes),{ headers: {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${domain}-export.${format}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) { return apiError(error); }
}
