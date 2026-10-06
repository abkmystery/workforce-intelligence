import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/lib/types';

const state = vi.hoisted(() => ({ batch: null as Record<string, unknown> | null, rows: [] as Record<string, any>[], beforeRecord: null as Record<string, unknown> | null, enqueues: 0, mutations: 0, rollbacks: 0, rejectName: '' }));
vi.mock('@/lib/db', () => ({
  transaction: async (_tenant: string, fn: (tx: unknown) => Promise<unknown>) => fn({ query: async (sql: string, values: unknown[]) => {
    if (sql.startsWith('INSERT INTO import_batches')) {
      state.batch = { id: values[0], tenant_id: values[1], actor_id: values[2], domain: values[3], operation: values[4], mode: values[5], schema_hash: values[9], permission_hash: values[10], auth_version: values[11], preview_hash: values[12], status: values[13], row_count: values[14], valid_count: values[15], selected_rows: null, job_id: null };
      return { rows: [] };
    }
    if (sql.startsWith('ROLLBACK TO SAVEPOINT')) { state.rollbacks++; return { rows: [] }; }
    if (sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE SAVEPOINT')) return { rows: [] };
    if (sql.startsWith('INSERT INTO import_rows')) { state.rows.push({ row_number: Number(values[2]), mutation: values[4] ? JSON.parse(String(values[4])) : null, diff: values[5] ? JSON.parse(String(values[5])) : null, status: String(values[7]) }); return { rows: [] }; }
    if (sql.startsWith('SELECT * FROM import_batches')) return { rows: state.batch ? [state.batch] : [] };
    if (sql.startsWith('SELECT row_number,status FROM import_rows')) return { rows: state.rows };
    if (sql.startsWith('SELECT * FROM import_rows')) return { rows: state.rows };
    if (sql.startsWith('SELECT * FROM skills')) return { rows: state.beforeRecord ? [state.beforeRecord] : [] };
    if (sql.startsWith('UPDATE import_batches') && sql.includes('selected_rows')) { Object.assign(state.batch!, { status: values[2], selected_rows: JSON.parse(String(values[3])), job_id: values[4] }); return { rows: [] }; }
    if (sql.startsWith('UPDATE import_batches') && sql.includes('error=')) { Object.assign(state.batch!, { status: values[2], error: values[3] }); return { rows: [] }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  } }),
}));
vi.mock('@/lib/policy', () => ({ assertPermission: vi.fn(), matchingGrants: vi.fn() }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));
vi.mock('@/lib/jobs', () => ({ enqueue: async () => { state.enqueues++; return '33333333-3333-4333-8333-333333333333'; } }));
vi.mock('@/lib/records', () => ({
  getRecord: vi.fn(), listRecords: vi.fn(),
  mutateRecord: async (_actor: Actor, _domain: string, mutation: { id?: string; data?: Record<string,unknown> }) => { state.mutations++; if (mutation.data?.name === state.rejectName) throw new Error('Central validation rejected row'); return {id:mutation.id ?? '44444444-4444-4444-8444-444444444444',tenantId:actor.tenantId,orgId:null,workerId:null,validFrom:'2026-09-24',validTo:null,version:1,state:'active',data:mutation.data ?? {}}; },
  recordRow: (row: Record<string, any>) => ({ id: row.id, tenantId: row.tenant_id, orgId: row.org_id, workerId: row.worker_id, validFrom: row.valid_from, validTo: row.valid_to, version: row.version, state: row.state, data: row.data }),
}));

import { previewImport, queueImport, processImport, reverseImport } from '../src/lib/imports/service';

const actor: Actor = { tenantId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sessionId:'s', roles:[], authVersion:1, grants:[] };

beforeEach(() => { state.batch = null; state.rows = []; state.beforeRecord = null; state.enqueues = 0; state.mutations = 0; state.rollbacks = 0; state.rejectName = ''; });

describe('preview-bound commit', () => {
  it('runs central mutation checks under a savepoint and persists a stable diff', async () => {
    state.rejectName = 'Rejected';
    const preview = await previewImport(actor,{ domain:'skills', operation:'CREATE', mode:'SELECTED', format:'csv', fileName:'skills.csv', bytes:Buffer.from('_valid_from,name\n2026-09-24,Alpha\n2026-09-24,Rejected\n') });
    expect(state.rollbacks).toBe(2);
    expect(preview.validCount).toBe(1);
    expect(preview.rows[0].diff?.after.id).toBe('44444444-4444-4444-8444-444444444444');
    expect(state.rows[0].mutation.id).toBe(preview.rows[0].diff?.after.id);
    expect(preview.rows[1].errors).toContain('Central validation rejected row');
    expect(state.rows[1].mutation).toBeNull();
  });

  it('binds hash, actor version and selected valid rows, and queues once', async () => {
    const preview = await previewImport(actor,{ domain:'skills', operation:'CREATE', mode:'SELECTED', format:'csv', fileName:'skills.csv', bytes:Buffer.from('_valid_from,name\n2026-09-24,Alpha\n2026-09-24,\n') });
    expect(preview.validCount).toBe(1);
    expect(preview.rows.map(row => row.status)).toEqual(['valid','invalid']);
    await expect(queueImport(actor,preview.batchId,'tampered',[2])).rejects.toThrow(/hash/i);
    await expect(queueImport({...actor,authVersion:2},preview.batchId,preview.hash,[2])).rejects.toThrow(/Permissions changed/);
    await expect(queueImport(actor,preview.batchId,preview.hash,[3])).rejects.toThrow(/invalid/i);
    const first = await queueImport(actor,preview.batchId,preview.hash,[2]);
    const repeat = await queueImport(actor,preview.batchId,preview.hash,[2]);
    expect(first.status).toBe('queued');
    expect(repeat.jobId).toBe(first.jobId);
    expect(state.enqueues).toBe(1);
    expect(state.batch?.selected_rows).toEqual([2]);
  });
});

describe('version safety at execution and reversal', () => {
  const recordId = '11111111-1111-4111-8111-111111111111';
  const snapshot = (version: number) => ({ id:recordId, tenant_id:actor.tenantId, org_id:null, worker_id:null, valid_from:'2026-09-24', valid_to:null, version, state:'active', data:{name:'Alpha'} });
  it('refuses a target whose version changed after preview', async () => {
    const preview = await previewImport(actor,{domain:'skills',operation:'CREATE',mode:'SELECTED',format:'csv',fileName:'x.csv',bytes:Buffer.from('_valid_from,name\n2026-09-24,Alpha\n')});
    state.mutations = 0;
    Object.assign(state.batch!,{status:'queued',selected_rows:[2]});
    state.rows = [{row_number:2,status:'valid',mutation:{operation:'UPDATE',id:recordId,version:1,data:{name:'Beta'}}}];
    state.beforeRecord = snapshot(2);
    await expect(processImport(actor,preview.batchId)).rejects.toThrow(/version changed/);
    expect(state.mutations).toBe(0);
    expect(state.batch?.status).toBe('failed');
  });

  it('refuses reversal after an intervening edit', async () => {
    const preview = await previewImport(actor,{domain:'skills',operation:'CREATE',mode:'SELECTED',format:'csv',fileName:'x.csv',bytes:Buffer.from('_valid_from,name\n2026-09-24,Alpha\n')});
    state.mutations = 0;
    Object.assign(state.batch!,{status:'completed'});
    state.rows = [{row_number:2,status:'applied',mutation:{operation:'CREATE'},prior_snapshot:null,applied_snapshot:{id:recordId,version:2,state:'active'}}];
    state.beforeRecord = snapshot(3);
    await expect(reverseImport(actor,preview.batchId)).rejects.toThrow(/changed after import/);
    expect(state.mutations).toBe(0);
    expect(state.batch?.status).toBe('completed');
  });
});
