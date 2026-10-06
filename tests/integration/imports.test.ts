import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { transaction, closeDatabase } from '../../src/lib/db';
import { domains } from '../../src/lib/registry';
import { mutateRecord, getRecord } from '../../src/lib/records';
import { previewImport, queueImport, processImport, reverseImport, getImport, createStoredExport, downloadStoredExport } from '../../src/lib/imports/service';
import type { ExportArtifactStore } from '../../src/lib/imports/artifacts';
import type { Actor } from '../../src/lib/types';

const configured = Boolean(process.env.TEST_DATABASE_URL);
const tenantId = randomUUID(), userId = randomUUID();
const actor: Actor = { tenantId, userId, sessionId:'imports-test', roles:[], authVersion:1, grants:Object.values(domains).map(domain => ({domain:domain.key,operation:'*',dataClass:domain.dataClass,orgId:null,scope:'tenant',validFrom:'2000-01-01',validTo:null})) };
const csv = (lines: string[]) => Buffer.from(lines.join('\n') + '\n');

describe.skipIf(!configured)('real PostgreSQL import transactions', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await transaction(tenantId,async tx => {
      await tx.query('INSERT INTO tenants(id,name,settings) VALUES($1,$2,$3)',[tenantId,'SYNTHETIC IMPORT TEST',{synthetic:true}]);
      await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[userId,tenantId,randomUUID()]);
    });
  });
  afterAll(async () => { await closeDatabase(); });

  it('dry-runs central reference checks and keeps preview writes rolled back', async () => {
    const name = 'Synthetic role '+randomUUID();
    const before = await transaction(tenantId,async tx => (await tx.query('SELECT count(*)::int n FROM roles WHERE tenant_id=$1',[tenantId])).rows[0].n as number);
    const preview = await previewImport(actor,{domain:'roles',operation:'CREATE',mode:'SELECTED',format:'csv',fileName:'roles.csv',bytes:csv(['_valid_from,name,familyId',`2026-09-24,${name},${randomUUID()}`])});
    expect(preview.rows[0].status).toBe('invalid');
    expect(preview.rows[0].errors.join(' ')).toMatch(/reference/i);
    const after = await transaction(tenantId,async tx => (await tx.query('SELECT count(*)::int n FROM roles WHERE tenant_id=$1',[tenantId])).rows[0].n as number);
    expect(after).toBe(before);
  });

  it('commits only once and reverses created records safely', async () => {
    const first = 'Synthetic skill '+randomUUID(), second = 'Synthetic skill '+randomUUID();
    const preview = await previewImport(actor,{domain:'skills',operation:'CREATE',mode:'ALL',format:'csv',fileName:'skills.csv',bytes:csv(['_valid_from,name',`2026-09-24,${first}`,`2026-09-24,${second}`])});
    expect(preview.validCount).toBe(2);
    const ids = preview.rows.map(row => row.diff!.after.id);
    const beforeCommit = await transaction(tenantId,async tx => (await tx.query('SELECT count(*)::int n FROM skills WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenantId,ids])).rows[0].n as number);
    expect(beforeCommit).toBe(0);
    const queued = await queueImport(actor,preview.batchId,preview.hash);
    expect((await queueImport(actor,preview.batchId,preview.hash)).jobId).toBe(queued.jobId);
    expect(await processImport(actor,preview.batchId)).toBe(2);
    expect(await processImport(actor,preview.batchId)).toBe(0);
    expect((await getImport(actor,preview.batchId)).rows.map(row => row.status)).toEqual(['applied','applied']);
    expect((await getRecord(actor,'skills',ids[0])).state).toBe('active');
    expect((await reverseImport(actor,preview.batchId)).status).toBe('reversed');
    expect((await reverseImport(actor,preview.batchId)).status).toBe('reversed');
    expect((await getRecord(actor,'skills',ids[0])).state).toBe('archived');
  });

  it('rolls back earlier selected rows when a later target version is stale', async () => {
    const first = await mutateRecord(actor,'skills',{operation:'CREATE',validFrom:'2026-09-24',data:{name:'Original '+randomUUID()}});
    const second = await mutateRecord(actor,'skills',{operation:'CREATE',validFrom:'2026-09-24',data:{name:'Original '+randomUUID()}});
    const preview = await previewImport(actor,{domain:'skills',operation:'UPDATE',mode:'ALL',format:'csv',fileName:'changes.csv',bytes:csv(['_id,_version,name',`${first.id},1,Changed first`,`${second.id},1,Changed second`])});
    expect(preview.validCount).toBe(2);
    expect((await getRecord(actor,'skills',first.id)).version).toBe(1);
    await mutateRecord(actor,'skills',{operation:'UPDATE',id:second.id,version:1,data:{name:'Concurrent edit'}});
    await queueImport(actor,preview.batchId,preview.hash);
    await expect(processImport(actor,preview.batchId)).rejects.toThrow(/version changed/i);
    const unchanged = await getRecord(actor,'skills',first.id);
    expect(unchanged.version).toBe(1);
    expect(unchanged.data.name).toBe(first.data.name);
    expect((await getImport(actor,preview.batchId)).status).toBe('failed');
  });

  it('stores a private export and denies changed grants, expiry and corrupt bytes', async () => {
    const blobs = new Map<string,Buffer>();
    const storage: ExportArtifactStore = {
      async put(key,bytes) { blobs.set(key,Buffer.from(bytes)); },
      async get(key) { const value=blobs.get(key); if (!value) throw new Error('Missing artifact'); return Buffer.from(value); },
      async remove(key) { blobs.delete(key); },
    };
    await mutateRecord(actor,'skills',{operation:'CREATE',validFrom:'2026-09-24',data:{name:'Export fixture '+randomUUID()}});
    const created = await createStoredExport(actor,{domain:'skills',format:'csv',date:'2026-09-24'},storage);
    expect(created.downloadPath).toBe(`/api/exports/${created.exportId}`);
    const downloaded = await downloadStoredExport(actor,created.exportId,storage);
    expect(downloaded.bytes.toString('utf8')).toContain('Export fixture');
    const otherUserId = randomUUID();
    await transaction(tenantId,tx => tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[otherUserId,tenantId,randomUUID()]).then(() => undefined));
    await expect(downloadStoredExport({ ...actor, userId: otherUserId },created.exportId,storage)).rejects.toMatchObject({status:404,code:'EXPORT_NOT_FOUND'});
    const withoutExport = { ...actor, grants: actor.grants.filter(grant => grant.domain !== 'skills') };
    await expect(downloadStoredExport(withoutExport,created.exportId,storage)).rejects.toMatchObject({status:403,code:'EXPORT_PERMISSION_CHANGED'});
    const blobKey = [...blobs.keys()][0];
    blobs.set(blobKey,Buffer.from('corrupt'));
    await expect(downloadStoredExport(actor,created.exportId,storage)).rejects.toMatchObject({status:503,code:'EXPORT_ARTIFACT_INVALID'});
    await transaction(tenantId,tx => tx.query('UPDATE export_files SET expires_at=now()-interval \'1 second\' WHERE tenant_id=$1 AND id=$2',[tenantId,created.exportId]).then(() => undefined));
    await expect(downloadStoredExport(actor,created.exportId,storage)).rejects.toMatchObject({status:410,code:'EXPORT_EXPIRED'});
  });
});
