import { getActor } from '@/lib/auth';
import { createStoredExport, exportRecords, requireFormat } from '@/lib/imports/service';
import { apiError, requireSameOrigin } from '@/lib/imports/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const actor = await getActor();
    const url = new URL(request.url);
    const domain = url.searchParams.get('domain') ?? '';
    const format = requireFormat(url.searchParams.get('format') ?? 'csv');
    const bytes = await exportRecords(actor,{ domain, format, date: url.searchParams.get('date') ?? undefined, orgId: url.searchParams.get('orgId') ?? undefined });
    return new Response(new Uint8Array(bytes),{ headers: { 'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${domain}-export.${format}"`, 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (Number(request.headers.get('content-length') ?? 0) > 4096) throw new Error('Export request is too large');
    const actor = await getActor();
    const body = await request.json() as { domain?: unknown; format?: unknown; date?: unknown; orgId?: unknown };
    if (typeof body.domain !== 'string' || typeof body.format !== 'string' || (body.date !== undefined && typeof body.date !== 'string') || (body.orgId !== undefined && typeof body.orgId !== 'string')) throw new Error('Invalid export request');
    const result = await createStoredExport(actor,{ domain: body.domain, format: requireFormat(body.format), date: body.date, orgId: body.orgId });
    return Response.json(result,{ status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
