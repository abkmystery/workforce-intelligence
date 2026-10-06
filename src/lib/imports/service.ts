import { createHash, randomUUID } from 'node:crypto';
import { transaction, type DbClient } from '@/lib/db';
import { domains } from '@/lib/registry';
import { getRecord, listRecords, mutateRecord, recordRow } from '@/lib/records';
import { assertFresh, assertPermission, matchingGrants } from '@/lib/policy';
import { AppError } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/jobs';
import type { Actor, RecordRow } from '@/lib/types';
import { buildTemplate, parseUpload, toCsv, toXlsx, columnsForDomain, type ImportFormat } from './format';
import { prepareRow, type ImportOperation, type Mutation } from './semantics';
import { azureExportArtifactStore, exportStorageKey, EXPORT_TTL_HOURS, MAX_EXPORT_ARTIFACT_BYTES, type ExportArtifactStore } from './artifacts';

type Batch = { id: string; tenant_id: string; actor_id: string; domain: string; operation: ImportOperation; mode: string; status: string; auth_version: number; schema_hash: string; permission_hash: string; preview_hash: string; row_count: number; valid_count: number; selected_rows: number[] | null; job_id: string | null; error: string | null; created_at: string; committed_at: string | null; reversed_at: string | null };
type ImportRow = { row_number: number; raw: Record<string, string>; mutation: Mutation | null; preview_diff: { before: RecordRow | null; after: RecordRow } | null; errors: string[]; status: string; prior_snapshot: RecordRow | null; applied_snapshot: RecordRow | null; outcome: Record<string, unknown> | null };
const operations = new Set(['CREATE','UPDATE','UPSERT','ARCHIVE','RESTORE','VALIDATE_ONLY']);
const formats = new Set(['csv','xlsx']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message: string): never => { throw new Error(message); };

export function requireDomain(key: string) { return domains[key] ?? fail('Unknown domain'); }
export function requireFormat(value: string): ImportFormat { return formats.has(value) ? value as ImportFormat : fail('Unsupported format'); }
export function requireOperation(value: string): ImportOperation { return operations.has(value) ? value as ImportOperation : fail('Unsupported operation'); }
function permissionHash(actor: Actor): string { return digest({ authVersion: actor.authVersion, grants: actor.grants.slice().sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }); }
function exportPermissionHash(actor: Actor, domain: string): string {
  const grants = [...matchingGrants(actor,domain,'READ'),...matchingGrants(actor,domain,'EXPORT')];
  return digest({ authVersion: actor.authVersion, grants: grants.map(grant => JSON.stringify(grant)).sort() });
}
function schemaHash(domain: string): string { return digest({ templateVersion: 1, definition: requireDomain(domain) }); }
function eligibleActor(actor: Actor, batch: Batch): void {
  if (batch.tenant_id !== actor.tenantId || batch.actor_id !== actor.userId) fail('Batch is unavailable');
  if (batch.auth_version !== actor.authVersion || batch.permission_hash !== permissionHash(actor)) fail('Permissions changed; create a new preview');
  if (batch.schema_hash !== schemaHash(batch.domain)) fail('Template changed; create a new preview');
}

export async function template(domainKey: string, format: ImportFormat, example: boolean): Promise<Buffer> {
  return buildTemplate(requireDomain(domainKey), format, example);
}

export async function previewImport(actor: Actor, input: { domain: string; operation: ImportOperation; mode: 'ALL' | 'SELECTED'; format: ImportFormat; fileName: string; bytes: Buffer; mapping?: Record<string,string> }) {
  const domain = requireDomain(input.domain);
  if (!['ALL','SELECTED'].includes(input.mode)) fail('Unsupported import mode');
  const parsed = await parseUpload(input.bytes, input.format, domain, input.mapping);
  if (!parsed.length) fail('No data rows');
  const prepared: ReturnType<typeof prepareRow>[] = [];
  const targets = new Set<string>();
  for (const parsedRow of parsed) {
    const row = prepareRow(parsedRow, domain, input.operation);
    if (row.mutation) {
      try {
        const mutation = row.mutation;
        let orgId = mutation.orgId ?? null;
        let workerId = mutation.workerId ?? null;
        let targetDate = mutation.validFrom;
        let before: RecordRow | null = null;
        if (mutation.id) {
          if (targets.has(mutation.id)) throw new Error('Duplicate target record');
          targets.add(mutation.id);
          const existing = await getRecord(actor, input.domain, mutation.id);
          before = existing;
          orgId = mutation.orgId === undefined ? existing.orgId : mutation.orgId;
          workerId = mutation.workerId === undefined ? existing.workerId : mutation.workerId;
          targetDate ??= existing.validFrom;
          if (mutation.version !== existing.version) throw new Error('Record version changed');
        }
        await assertPermission(actor, input.domain, 'IMPORT', orgId, domain.dataClass, undefined, targetDate, workerId);
        await assertPermission(actor, input.domain, mutation.operation, orgId, domain.dataClass, undefined, targetDate, workerId);
        const after = await transaction(actor.tenantId,async tx => {
          await tx.query('SAVEPOINT import_preview');
          try { return await mutateRecord(actor,input.domain,mutation,tx); }
          finally {
            await tx.query('ROLLBACK TO SAVEPOINT import_preview');
            await tx.query('RELEASE SAVEPOINT import_preview');
          }
        });
        if (mutation.operation === 'CREATE') mutation.id = after.id;
        row.diff = { before, after };
      } catch (error) { row.errors.push((error as Error).message); row.mutation = null; }
    }
    prepared.push(row);
  }
  const batchId = randomUUID();
  const fileSha256 = createHash('sha256').update(input.bytes).digest('hex');
  const previewHash = digest({ batchId, actor: actor.userId, tenant: actor.tenantId, authVersion: actor.authVersion, permissionHash: permissionHash(actor), schemaHash: schemaHash(input.domain), domain: input.domain, operation: input.operation, mode: input.mode, fileSha256, rows: prepared });
  await transaction(actor.tenantId, async tx => {
    await tx.query('INSERT INTO import_batches(id,tenant_id,actor_id,domain,operation,mode,format,file_name,file_sha256,schema_hash,permission_hash,auth_version,preview_hash,status,row_count,valid_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)', [batchId,actor.tenantId,actor.userId,input.domain,input.operation,input.mode,input.format,input.fileName.slice(0,255),fileSha256,schemaHash(input.domain),permissionHash(actor),actor.authVersion,previewHash,input.operation === 'VALIDATE_ONLY' ? 'validated' : 'previewed',prepared.length,prepared.filter(row => !row.errors.length).length]);
    for (const row of prepared) await tx.query('INSERT INTO import_rows(tenant_id,batch_id,row_number,raw,mutation,preview_diff,errors,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [actor.tenantId,batchId,row.rowNumber,JSON.stringify(row.values),row.mutation ? JSON.stringify(row.mutation) : null,row.diff ? JSON.stringify(row.diff) : null,JSON.stringify(row.errors),row.errors.length ? 'invalid' : 'valid']);
    await audit(tx,actor,'PREVIEW_IMPORT',input.domain,batchId,{ rowCount: prepared.length, validCount: prepared.filter(row => !row.errors.length).length });
  });
  return { batchId, hash: previewHash, status: input.operation === 'VALIDATE_ONLY' ? 'validated' : 'previewed', rowCount: prepared.length, validCount: prepared.filter(row => !row.errors.length).length, rows: prepared.map(row => ({ rowNumber: row.rowNumber, values: row.values, errors: row.errors, status: row.errors.length ? 'invalid' : 'valid', diff: row.diff ?? null })) };
}

export async function getImport(actor: Actor, id: string) {
  return transaction(actor.tenantId,async tx => {
    const batches = (await tx.query<Batch>('SELECT * FROM import_batches WHERE tenant_id=$1 AND id=$2 AND actor_id=$3', [actor.tenantId,id,actor.userId])).rows;
    const batch = batches[0] ?? fail('Batch is unavailable');
    eligibleActor(actor,batch);
    const rows = (await tx.query<ImportRow>('SELECT row_number,raw,mutation,preview_diff,errors,status,prior_snapshot,applied_snapshot,outcome FROM import_rows WHERE tenant_id=$1 AND batch_id=$2 ORDER BY row_number', [actor.tenantId,id])).rows;
    return { batchId: batch.id, hash: batch.preview_hash, domain: batch.domain, operation: batch.operation, mode: batch.mode, status: batch.status, rowCount: batch.row_count, validCount: batch.valid_count, jobId: batch.job_id, error: batch.error, rows: rows.map(row => ({ rowNumber: row.row_number, values: row.raw, errors: row.errors, status: row.status, diff: row.preview_diff, outcome: row.outcome })) };
  });
}

export async function queueImport(actor: Actor, id: string, hash: string, selectedRows?: number[]) {
  return transaction(actor.tenantId, async tx => {
    const result = await tx.query<Batch>('SELECT * FROM import_batches WHERE tenant_id=$1 AND id=$2 AND actor_id=$3 FOR UPDATE', [actor.tenantId,id,actor.userId]);
    const batch = result.rows[0] ?? fail('Batch is unavailable');
    eligibleActor(actor,batch);
    if (hash !== batch.preview_hash) fail('Preview hash mismatch');
    if (batch.status === 'queued' || batch.status === 'processing' || batch.status === 'completed') return { batchId: id, status: batch.status, jobId: batch.job_id };
    if (batch.status !== 'previewed') fail('Batch cannot be committed');
    const resultRows = await tx.query<ImportRow>('SELECT row_number,status FROM import_rows WHERE tenant_id=$1 AND batch_id=$2 ORDER BY row_number', [actor.tenantId,id]);
    const valid = new Set(resultRows.rows.filter(row => row.status === 'valid').map(row => row.row_number));
    const chosen = selectedRows ?? (batch.mode === 'SELECTED' ? fail('Select valid rows') : [...valid]);
    if (!Array.isArray(chosen) || !chosen.length || new Set(chosen).size !== chosen.length || chosen.some(row => !Number.isInteger(row) || !valid.has(row))) fail('Selection contains invalid or duplicate rows');
    if (batch.mode === 'ALL' && chosen.length !== resultRows.rows.length) fail('ALL mode requires every row to be valid and selected');
    const jobId = await enqueue(tx,actor,'IMPORT_COMMIT',{ batchId: id });
    await tx.query('UPDATE import_batches SET status=$3,selected_rows=$4,job_id=$5 WHERE tenant_id=$1 AND id=$2', [actor.tenantId,id,'queued',JSON.stringify(chosen),jobId]);
    await audit(tx,actor,'QUEUE_IMPORT',batch.domain,id,{ selectedCount: chosen.length, jobId });
    return { batchId: id, status: 'queued', jobId };
  });
}

async function currentSnapshot(tx: DbClient, actor: Actor, table: string, id: string): Promise<RecordRow | null> {
  const result = await tx.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId,id]);
  return result.rows[0] ? recordRow(result.rows[0]) : null;
}

export async function processImport(actor: Actor, batchId: string): Promise<number> {
  try {
    return await transaction(actor.tenantId, async tx => {
      const batchResult = await tx.query<Batch>('SELECT * FROM import_batches WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [actor.tenantId,batchId]);
      const batch = batchResult.rows[0] ?? fail('Batch is unavailable');
      eligibleActor(actor,batch);
      if (batch.status === 'completed') return 0;
      if (batch.status !== 'queued') fail('Batch is not queued');
      const definition = requireDomain(batch.domain);
      const selected = new Set(batch.selected_rows ?? []);
      const rows = (await tx.query<ImportRow>('SELECT * FROM import_rows WHERE tenant_id=$1 AND batch_id=$2 ORDER BY row_number FOR UPDATE', [actor.tenantId,batchId])).rows;
      let applied = 0;
      for (const row of rows) {
        if (!selected.has(row.row_number)) { await tx.query('UPDATE import_rows SET status=$4 WHERE tenant_id=$1 AND batch_id=$2 AND row_number=$3',[actor.tenantId,batchId,row.row_number,'skipped']); continue; }
        if (row.status !== 'valid' || !row.mutation) throw new Error(`Row ${row.row_number} is invalid`);
        const mutation = row.mutation;
        const prior = mutation.operation !== 'CREATE' && mutation.id ? await currentSnapshot(tx,actor,definition.table,mutation.id) : null;
        if (mutation.operation !== 'CREATE' && mutation.id && !prior) throw new Error(`Row ${row.row_number} target disappeared`);
        const orgId = mutation.orgId === undefined ? prior?.orgId ?? null : mutation.orgId;
        const workerId = mutation.workerId === undefined ? prior?.workerId ?? null : mutation.workerId;
        const targetDate = mutation.validFrom ?? prior?.validFrom;
        await assertPermission(actor,batch.domain,'IMPORT',orgId,definition.dataClass,tx,targetDate,workerId);
        await assertPermission(actor,batch.domain,mutation.operation,orgId,definition.dataClass,tx,targetDate,workerId);
        if (prior && Number(prior.version) !== mutation.version) fail(`Row ${row.row_number} version changed`);
        const changed = await mutateRecord(actor,batch.domain,mutation,tx);
        await tx.query('UPDATE import_rows SET status=$4,prior_snapshot=$5,applied_snapshot=$6,outcome=$7 WHERE tenant_id=$1 AND batch_id=$2 AND row_number=$3',[actor.tenantId,batchId,row.row_number,'applied',prior ? JSON.stringify(prior) : null,JSON.stringify(changed),JSON.stringify({ recordId: changed.id, version: changed.version, operation: mutation.operation })]);
        applied++;
      }
      await tx.query('UPDATE import_batches SET status=$3,committed_at=now(),error=NULL WHERE tenant_id=$1 AND id=$2',[actor.tenantId,batchId,'completed']);
      await audit(tx,actor,'COMMIT_IMPORT',batch.domain,batchId,{ appliedCount: applied });
      return applied;
    });
  } catch (error) {
    await transaction(actor.tenantId,tx => tx.query('UPDATE import_batches SET status=$3,error=$4 WHERE tenant_id=$1 AND id=$2 AND status=$5',[actor.tenantId,batchId,'failed',String((error as Error).message).slice(0,500),'queued']).then(() => undefined));
    throw error;
  }
}

export async function reverseImport(actor: Actor, batchId: string) {
  return transaction(actor.tenantId, async tx => {
    const result = await tx.query<Batch>('SELECT * FROM import_batches WHERE tenant_id=$1 AND id=$2 AND actor_id=$3 FOR UPDATE',[actor.tenantId,batchId,actor.userId]);
    const batch = result.rows[0] ?? fail('Batch is unavailable');
    eligibleActor(actor,batch);
    if (batch.status === 'reversed') return { batchId, status: 'reversed' };
    if (batch.status !== 'completed') fail('Only completed imports can be reversed');
    const definition = requireDomain(batch.domain);
    const rows = (await tx.query<ImportRow>('SELECT * FROM import_rows WHERE tenant_id=$1 AND batch_id=$2 AND status=$3 ORDER BY row_number DESC FOR UPDATE',[actor.tenantId,batchId,'applied'])).rows;
    for (const row of rows) {
      const applied = row.applied_snapshot;
      if (!applied) throw new Error('Missing applied snapshot');
      const current = await currentSnapshot(tx,actor,definition.table,applied.id);
      if (!current || Number(current.version) !== applied.version) throw new Error(`Record ${applied.id} changed after import`);
      const orgId = current.orgId;
      await assertPermission(actor,batch.domain,'IMPORT',orgId,definition.dataClass,tx,current.validFrom,current.workerId);
      const prior = row.prior_snapshot;
      const operation = prior ? (prior.state === 'archived' ? 'ARCHIVE' : applied.state === 'archived' ? 'RESTORE' : 'UPDATE') : 'ARCHIVE';
      if (prior && prior.state !== 'active' && prior.state !== 'archived' && applied.state !== prior.state) throw new Error('Prior workflow state cannot be safely restored');
      await assertPermission(actor,batch.domain,operation,orgId,definition.dataClass,tx,current.validFrom,current.workerId);
      const changedFields = Object.keys(row.mutation?.data ?? {});
      const restoreData = prior ? Object.fromEntries(changedFields.map(key => {
        if (Object.hasOwn(prior.data,key)) return [key,prior.data[key]];
        if (definition.fields[key]?.nullable) return [key,null];
        throw new Error(`Field ${key} cannot be safely removed`);
      })) : undefined;
      await mutateRecord(actor,batch.domain,{ operation, id: applied.id, version: applied.version, orgId: prior?.orgId, workerId: prior?.workerId, validFrom: prior?.validFrom, validTo: prior?.validTo, data: restoreData },tx);
      await tx.query('UPDATE import_rows SET status=$4 WHERE tenant_id=$1 AND batch_id=$2 AND row_number=$3',[actor.tenantId,batchId,row.row_number,'reversed']);
    }
    await tx.query('UPDATE import_batches SET status=$3,reversed_at=now() WHERE tenant_id=$1 AND id=$2',[actor.tenantId,batchId,'reversed']);
    await audit(tx,actor,'REVERSE_IMPORT',batch.domain,batchId,{ reversedCount: rows.length });
    return { batchId, status: 'reversed' };
  });
}

export type ExportRequest = { domain: string; format: ImportFormat; date?: string; orgId?: string };

async function buildExport(actor: Actor, input: ExportRequest) {
  const definition = requireDomain(input.domain);
  if (!matchingGrants(actor,input.domain,'EXPORT').length || !matchingGrants(actor,input.domain,'READ').length) throw new Error('Export permission denied');
  const rows: RecordRow[] = [];
  let page = 1;
  while (true) {
    const result = await listRecords(actor,input.domain,{ date: input.date, orgId: input.orgId, page, pageSize: 500, operation: 'EXPORT' } as Parameters<typeof listRecords>[2]);
    rows.push(...result.rows);
    if (result.total > 50000 || rows.length > 50000) fail('Export exceeds 50000 rows');
    if (rows.length >= result.total || !result.rows.length) break;
    page++;
  }
  const columns = columnsForDomain(definition);
  const flat = rows.map(row => ({ _id: row.id, _version: row.version, _org_id: row.orgId, _worker_id: row.workerId, _valid_from: row.validFrom, _valid_to: row.validTo, ...row.data }));
  const bytes = input.format === 'csv' ? toCsv(columns,flat) : await toXlsx(columns,flat);
  return { bytes, rowCount: rows.length, recordsHash: digest(flat) };
}

export async function exportRecords(actor: Actor, input: ExportRequest) {
  const { bytes, rowCount } = await buildExport(actor,input);
  await transaction(actor.tenantId, async tx => {
    await tx.query('INSERT INTO export_files(tenant_id,actor_id,domain,format,row_count,scope) VALUES($1,$2,$3,$4,$5,$6)',[actor.tenantId,actor.userId,input.domain,input.format,rowCount,JSON.stringify({ date: input.date ?? null, orgId: input.orgId ?? null })]);
    await audit(tx,actor,'EXPORT',input.domain,null,{ count: rowCount });
  });
  return bytes;
}

type StoredExport = { id: string; tenant_id: string; actor_id: string; domain: string; format: ImportFormat; scope: { date?: unknown; orgId?: unknown; recordsHash?: unknown }; storage_key: string; sha256: string; byte_count: number; expires_at: Date | string; auth_version: number; permission_hash: string };
const exportIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storedExportColumns = 'id,tenant_id,actor_id,domain,format,scope,storage_key,sha256,byte_count,expires_at,auth_version,permission_hash';
function reusableExport(actor: Actor, row: StoredExport, input: ExportRequest & { date: string }) {
  if (row.tenant_id !== actor.tenantId || row.actor_id !== actor.userId || row.domain !== input.domain || row.format !== input.format || row.scope?.date !== input.date || row.scope?.orgId !== (input.orgId ?? null) || row.auth_version !== actor.authVersion || row.permission_hash !== exportPermissionHash(actor,input.domain) || new Date(row.expires_at).getTime() <= Date.now()) throw new AppError(409,'EXPORT_IDEMPOTENCY_CONFLICT');
  return { exportId: row.id, expiresAt: new Date(row.expires_at).toISOString(), downloadPath: `/api/exports/${row.id}` };
}

export async function createStoredExport(actor: Actor, input: ExportRequest, storage: ExportArtifactStore = azureExportArtifactStore(), stableExportId?: string) {
  if (stableExportId !== undefined && !exportIdPattern.test(stableExportId)) throw new AppError(422,'INVALID_EXPORT_ID');
  const datedInput = { ...input, date: input.date ?? new Date().toISOString().slice(0,10) };
  if (stableExportId) {
    const existing = await transaction(actor.tenantId,async tx => {
      await assertFresh(actor,tx);
      return (await tx.query<StoredExport>(`SELECT ${storedExportColumns} FROM export_files WHERE tenant_id=$1 AND id=$2 AND storage_key IS NOT NULL`,[actor.tenantId,stableExportId])).rows[0];
    });
    if (existing) return reusableExport(actor,existing,datedInput);
  }
  const { bytes, rowCount, recordsHash } = await buildExport(actor,datedInput);
  if (bytes.length > MAX_EXPORT_ARTIFACT_BYTES) throw new AppError(413,'EXPORT_TOO_LARGE');
  const id = stableExportId ?? randomUUID();
  // Stable IDs identify the database row. A unique key per attempt prevents a losing
  // concurrent attempt from overwriting or deleting the winner's Blob.
  const key = exportStorageKey(actor.tenantId,stableExportId ? randomUUID() : id,input.format);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const expiresAt = new Date(Date.now() + EXPORT_TTL_HOURS * 3600000);
  try { await storage.put(key,bytes,input.format); }
  catch { throw new AppError(503,'EXPORT_STORAGE_UNAVAILABLE'); }
  let winner: StoredExport | undefined;
  try {
    winner = await transaction(actor.tenantId,async tx => {
      await assertFresh(actor,tx);
      if (!matchingGrants(actor,input.domain,'EXPORT').length || !matchingGrants(actor,input.domain,'READ').length) throw new AppError(403,'EXPORT_PERMISSION_CHANGED');
      const inserted = await tx.query<Pick<StoredExport,'id'>>(`INSERT INTO export_files(id,tenant_id,actor_id,domain,format,row_count,scope,storage_key,sha256,byte_count,expires_at,auth_version,permission_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)${stableExportId ? ' ON CONFLICT (id) DO NOTHING RETURNING id' : ''}`,[id,actor.tenantId,actor.userId,input.domain,input.format,rowCount,JSON.stringify({ date: datedInput.date, orgId: input.orgId ?? null, recordsHash }),key,sha256,bytes.length,expiresAt,actor.authVersion,exportPermissionHash(actor,input.domain)]);
      if (stableExportId && !inserted.rows.length) {
        const result = await tx.query<StoredExport>(`SELECT ${storedExportColumns} FROM export_files WHERE tenant_id=$1 AND id=$2 AND storage_key IS NOT NULL`,[actor.tenantId,id]);
        const existing = result.rows[0];
        if (!existing) throw new AppError(409,'EXPORT_IDEMPOTENCY_CONFLICT');
        reusableExport(actor,existing,datedInput);
        return existing;
      }
      await audit(tx,actor,'STORE_EXPORT',input.domain,id,{ count: rowCount });
      return undefined;
    });
  } catch (error) {
    await storage.remove(key).catch(() => undefined);
    throw error;
  }
  if (winner) {
    await storage.remove(key).catch(() => undefined);
    return reusableExport(actor,winner,datedInput);
  }
  return { exportId: id, expiresAt: expiresAt.toISOString(), downloadPath: `/api/exports/${id}` };
}

export async function downloadStoredExport(actor: Actor, id: string, storage: ExportArtifactStore = azureExportArtifactStore()) {
  if (!exportIdPattern.test(id)) throw new AppError(404,'EXPORT_NOT_FOUND');
  const file = await transaction(actor.tenantId,async tx => {
    await assertFresh(actor,tx);
    const result = await tx.query<StoredExport>(`SELECT ${storedExportColumns} FROM export_files WHERE tenant_id=$1 AND id=$2 AND actor_id=$3 AND storage_key IS NOT NULL`,[actor.tenantId,id,actor.userId]);
    const row = result.rows[0];
    if (!row) throw new AppError(404,'EXPORT_NOT_FOUND');
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new AppError(410,'EXPORT_EXPIRED');
    if (row.auth_version !== actor.authVersion || row.permission_hash !== exportPermissionHash(actor,row.domain)) throw new AppError(403,'EXPORT_PERMISSION_CHANGED');
    if (!matchingGrants(actor,row.domain,'EXPORT').length || !matchingGrants(actor,row.domain,'READ').length) throw new AppError(403,'EXPORT_PERMISSION_CHANGED');
    await audit(tx,actor,'DOWNLOAD_EXPORT_REQUEST',row.domain,id);
    return row;
  });
  const scope = file.scope;
  if (!scope || typeof scope.date !== 'string' || (scope.orgId !== null && typeof scope.orgId !== 'string') || typeof scope.recordsHash !== 'string') throw new AppError(403,'EXPORT_REVALIDATION_REQUIRED');
  const current = await buildExport(actor,{domain:file.domain,format:file.format,date:scope.date,orgId:scope.orgId ?? undefined});
  if (current.recordsHash !== scope.recordsHash) throw new AppError(403,'EXPORT_SCOPE_CHANGED');
  let bytes: Buffer;
  try { bytes = await storage.get(file.storage_key); }
  catch { throw new AppError(503,'EXPORT_STORAGE_UNAVAILABLE'); }
  if (bytes.length !== file.byte_count || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new AppError(503,'EXPORT_ARTIFACT_INVALID');
  if (new Date(file.expires_at).getTime() <= Date.now()) throw new AppError(410,'EXPORT_EXPIRED');
  return { bytes, format: file.format, domain: file.domain };
}
