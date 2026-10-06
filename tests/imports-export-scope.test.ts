import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, RecordRow } from '../src/lib/types';
import type { ExportArtifactStore } from '../src/lib/imports/artifacts';

const state = vi.hoisted(() => ({ rows: [] as unknown[], file: null as Record<string,unknown> | null, hideNextLookup:false, inserts:0 }));
vi.mock('@/lib/records', () => ({
  listRecords: async () => ({ rows: state.rows, total: state.rows.length }),
}));
vi.mock('@/lib/policy', () => ({
  matchingGrants: () => [{ domain:'skills', operation:'*', dataClass:'planning', scope:'tenant', orgId:null, validFrom:'2000-01-01', validTo:null }],
  assertFresh: async () => undefined,
}));
vi.mock('@/lib/audit', () => ({ audit: async () => undefined }));
vi.mock('@/lib/jobs', () => ({ enqueue: async () => 'job' }));
vi.mock('@/lib/db', () => ({
  transaction: async (_tenant: string, fn: (tx: {query: (sql:string,values:unknown[])=>Promise<{rows:Record<string,unknown>[]}>}) => Promise<unknown>) => fn({
    query: async (sql: string, values: unknown[]) => {
      if (sql.startsWith('INSERT INTO export_files')) {
        state.inserts++;
        if (state.file && sql.includes('ON CONFLICT')) return { rows: [] };
        state.file = { id:values[0], tenant_id:values[1], actor_id:values[2], domain:values[3], format:values[4], scope:JSON.parse(String(values[6])), storage_key:values[7], sha256:values[8], byte_count:values[9], expires_at:values[10], auth_version:values[11], permission_hash:values[12] };
        return { rows: sql.includes('RETURNING id') ? [{id:values[0]}] : [] };
      }
      if (sql.startsWith('SELECT id,tenant_id,actor_id,domain,format,scope,storage_key')) {
        if (state.hideNextLookup) { state.hideNextLookup=false; return { rows: [] }; }
        return { rows: state.file && state.file.tenant_id === values[0] && state.file.id === values[1] && (values.length === 2 || state.file.actor_id === values[2]) ? [state.file] : [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  }),
}));

import { createStoredExport, downloadStoredExport } from '../src/lib/imports/service';

const actor: Actor = { tenantId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sessionId:'test', roles:[], authVersion:1, grants:[] };
const row: RecordRow = { id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc', tenantId:actor.tenantId, orgId:null, workerId:null, validFrom:'2026-09-01', validTo:null, version:1, state:'active', data:{name:'Synthetic skill'} };
const blobs = new Map<string,Buffer>();
const storage: ExportArtifactStore = {
  async put(key,bytes) { blobs.set(key,Buffer.from(bytes)); },
  async get(key) { return Buffer.from(blobs.get(key)!); },
  async remove(key) { blobs.delete(key); },
};

beforeEach(() => { state.rows=[row]; state.file=null; state.hideNextLookup=false; state.inserts=0; blobs.clear(); });
afterEach(() => vi.restoreAllMocks());

describe('stored export authorization at download', () => {
  it('rejects an artifact after the current scoped cohort changes', async () => {
    const created = await createStoredExport(actor,{domain:'skills',format:'csv',date:'2026-09-24'},storage);
    expect((await downloadStoredExport(actor,created.exportId,storage)).bytes.toString()).toContain('Synthetic skill');
    state.rows=[];
    await expect(downloadStoredExport(actor,created.exportId,storage)).rejects.toMatchObject({status:403,code:'EXPORT_SCOPE_CHANGED'});
  });

  it('rechecks expiry after a slow Blob read', async () => {
    const created = await createStoredExport(actor,{domain:'skills',format:'csv',date:'2026-09-24'},storage);
    const slow: ExportArtifactStore = { ...storage, async get(key) { const bytes=await storage.get(key); vi.spyOn(Date,'now').mockReturnValue(Date.parse(created.expiresAt)+1); return bytes; } };
    await expect(downloadStoredExport(actor,created.exportId,slow)).rejects.toMatchObject({status:410,code:'EXPORT_EXPIRED'});
  });

  it('reuses a matching stable export ID and rejects changed request scope', async () => {
    const id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const input={domain:'skills',format:'csv' as const,date:'2026-09-24'};
    const first=await createStoredExport(actor,input,storage,id);
    const second=await createStoredExport(actor,input,storage,id);
    expect(second).toEqual(first);
    expect(state.inserts).toBe(1);
    expect(blobs.size).toBe(1);
    await expect(createStoredExport(actor,{...input,date:'2026-09-25'},storage,id)).rejects.toMatchObject({status:409,code:'EXPORT_IDEMPOTENCY_CONFLICT'});
    expect(blobs.size).toBe(1);
  });

  it('keeps the winning Blob when another stable-ID attempt loses the insert race', async () => {
    const id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const input={domain:'skills',format:'csv' as const,date:'2026-09-24'};
    const first=await createStoredExport(actor,input,storage,id);
    const winnerKey=[...blobs.keys()][0];
    state.hideNextLookup=true;
    const raced=await createStoredExport(actor,input,storage,id);
    expect(raced).toEqual(first);
    expect(state.inserts).toBe(2);
    expect([...blobs.keys()]).toEqual([winnerKey]);
    expect((await downloadStoredExport(actor,id,storage)).bytes.toString()).toContain('Synthetic skill');
  });
});
