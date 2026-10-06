import { getActor } from '@/lib/auth';
import { template, requireFormat } from '@/lib/imports/service';
import { requireTemplateAccess, apiError } from '@/lib/imports/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const actor = await getActor();
    const url = new URL(request.url);
    const domain = url.searchParams.get('domain') ?? '';
    const format = requireFormat(url.searchParams.get('format') ?? 'xlsx');
    requireTemplateAccess(actor,domain);
    const bytes = await template(domain,format,url.searchParams.get('example') === 'true');
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${domain}-template-v1.${format}"`, 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
