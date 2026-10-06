import { getActor } from '@/lib/auth';
import { previewImport, requireFormat, requireOperation } from '@/lib/imports/service';
import { apiError, requireSameOrigin } from '@/lib/imports/http';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await getActor();
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new Error('File is required');
    const name = file.name.toLowerCase();
    if (name.endsWith('.xlsm') || name.endsWith('.xls') || !/\.(csv|xlsx)$/.test(name)) throw new Error('Only CSV and XLSX files are accepted');
    const format = requireFormat(name.endsWith('.csv') ? 'csv' : 'xlsx');
    if (file.size > 5 * 1024 * 1024) throw new Error('File exceeds 5 MiB');
    const suppliedFormat = form.get('format');
    if (suppliedFormat && suppliedFormat !== format) throw new Error('Format does not match file');
    const mappingText = form.get('mapping');
    const mapping = mappingText ? JSON.parse(String(mappingText)) as Record<string,string> : undefined;
    if (mapping && (typeof mapping !== 'object' || Array.isArray(mapping))) throw new Error('Invalid mapping');
    const mode = String(form.get('mode') ?? 'ALL');
    if (mode !== 'ALL' && mode !== 'SELECTED') throw new Error('Unsupported import mode');
    const result = await previewImport(actor,{ domain: String(form.get('domain') ?? ''), operation: requireOperation(String(form.get('operation') ?? '')), mode, format, fileName: file.name, bytes: Buffer.from(await file.arrayBuffer()), mapping });
    return Response.json(result,{ headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
