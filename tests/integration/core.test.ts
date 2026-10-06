import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database, transaction, closeDatabase } from '../../src/lib/db';
import { mutateRecord, getRecord, listRecords, persistRevision } from '../../src/lib/records';
import { domains } from '../../src/lib/registry';
import type { Actor } from '../../src/lib/types';
const configured=Boolean(process.env.TEST_DATABASE_URL);const tenantId=randomUUID(),userId=randomUUID();
const actor:Actor={tenantId,userId,sessionId:'test',roles:[],authVersion:1,grants:Object.values(domains).map(d=>({domain:d.key,operation:'*',dataClass:d.dataClass,orgId:null,scope:'tenant',validFrom:'2000-01-01',validTo:null}))};
describe.skipIf(!configured)('real PostgreSQL tenant, dating and transaction invariants',()=>{
 let orgId:string,roleId:string,workerId:string;
 beforeAll(async()=>{process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;await transaction(tenantId,async tx=>{await tx.query('INSERT INTO tenants(id,name,settings) VALUES($1,$2,$3)',[tenantId,'SYNTHETIC TEST',{synthetic:true}]);await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[userId,tenantId,randomUUID()]);});orgId=(await mutateRecord(actor,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'TEST-'+randomUUID(),name:'Synthetic test team',orgType:'Team'}})).id;roleId=(await mutateRecord(actor,'roles',{operation:'CREATE',validFrom:'2026-01-01',data:{name:'Data analyst'}})).id;});
 afterAll(async()=>{await closeDatabase();});
 it('AC01 preserves stable ID and history across edits/archive/restore',async()=>{const worker=await mutateRecord(actor,'workers',{operation:'CREATE',orgId,validFrom:'2026-01-01',data:{code:'TEST-'+randomUUID(),workerType:'manual-only',employmentStatus:'active',homeOrgId:orgId}});workerId=worker.id;const changed=await mutateRecord(actor,'workers',{operation:'UPDATE',id:worker.id,version:worker.version,validFrom:'2026-03-01',data:{title:'New synthetic title'}});expect(changed.id).toBe(worker.id);expect((await listRecords(actor,'workers',{date:'2026-02-01'})).rows.find(r=>r.id===worker.id)?.data.title).toBeUndefined();const archived=await mutateRecord(actor,'workers',{operation:'ARCHIVE',id:worker.id,version:changed.version});const restored=await mutateRecord(actor,'workers',{operation:'RESTORE',id:worker.id,version:archived.version});expect(restored.id).toBe(worker.id);expect(restored.state).toBe('active');});
 it('AC04 denies guessed UUID and admin implicit salary access',async()=>{const restricted={...actor,roles:['SecurityAdmin'],grants:[]};await expect(getRecord(restricted,'workers',workerId)).rejects.toMatchObject({status:403});expect((await listRecords(restricted,'workers',{date:'2026-09-01'})).rows).toEqual([]);await transaction(tenantId,async tx=>{const other=randomUUID();const rows=await tx.query('SELECT * FROM workers WHERE tenant_id=$1',[other]);expect(rows.rowCount).toBe(0);});});
 it('AC10 blocks optimistic races',async()=>{const w=await getRecord(actor,'workers',workerId);const attempts=await Promise.allSettled([1,2].map(i=>mutateRecord(actor,'workers',{operation:'UPDATE',id:w.id,version:w.version,data:{title:'Race '+i}})));expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(attempts.filter(x=>x.status==='rejected')).toHaveLength(1);});
 it('AC11 blocks org cycles',async()=>{const child=await mutateRecord(actor,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'TEST-'+randomUUID(),name:'Synthetic child',orgType:'Team'}});await mutateRecord(actor,'org-edges',{operation:'CREATE',orgId,validFrom:'2026-01-01',data:{parentId:orgId,childId:child.id,hierarchy:'primary'}});await expect(mutateRecord(actor,'org-edges',{operation:'CREATE',orgId,validFrom:'2026-01-01',data:{parentId:child.id,childId:orgId,hierarchy:'primary'}})).rejects.toMatchObject({code:'HIERARCHY_CYCLE'});});
 it('AC12 serializes allocation races and rejects aggregate over-allocation',async()=>{const results=await Promise.allSettled([0.6,0.6].map(fte=>mutateRecord(actor,'assignments',{operation:'CREATE',orgId,workerId,validFrom:'2026-03-01',data:{roleId,fte,allocationStatus:'committed',kind:'primary'}})));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);});
 it('runtime connection is not superuser or RLS bypass',async()=>{const {rows}=await database().query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');expect(rows[0]).toEqual({rolsuper:false,rolbypassrls:false});});
 it('RLS isolates unfiltered reads and rejects writes without matching transaction context',async()=>{
  const foreignTenant=randomUUID();
  await transaction(foreignTenant,async tx=>{await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[foreignTenant,'SYNTHETIC FOREIGN']);await tx.query("INSERT INTO workers(tenant_id,valid_from,data) VALUES($1,'2026-01-01','{}')",[foreignTenant]);});
  await transaction(tenantId,async tx=>{const rows=(await tx.query('SELECT DISTINCT tenant_id FROM workers')).rows;expect(rows).toEqual([{tenant_id:tenantId}]);expect((await tx.query('SELECT * FROM workers WHERE tenant_id=$1',[foreignTenant])).rowCount).toBe(0);});
  await expect(transaction(tenantId,tx=>tx.query("INSERT INTO workers(tenant_id,valid_from,data) VALUES($1,'2026-01-01','{}')",[foreignTenant]))).rejects.toMatchObject({code:'42501'});
  const client=await database().connect();
  try{await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id','',true)");expect((await client.query('SELECT * FROM workers')).rowCount).toBe(0);await client.query('ROLLBACK');}finally{client.release();}
 });
 it('effective reads preserve historical revisions without resurrecting expired intervals',async()=>{
  const code='TEST-DATED-'+randomUUID();
  let row=await mutateRecord(actor,'workers',{operation:'CREATE',orgId,validFrom:'2026-01-01',data:{code,workerType:'manual-only',employmentStatus:'active',homeOrgId:orgId,title:'Original'}});
  row=await mutateRecord(actor,'workers',{operation:'UPDATE',id:row.id,version:row.version,validFrom:'2026-03-01',validTo:'2026-04-01',data:{title:'Spring'}});
  row=await mutateRecord(actor,'workers',{operation:'UPDATE',id:row.id,version:row.version,validFrom:'2026-06-01',validTo:'2026-07-01',data:{title:'Summer'}});
  expect((await listRecords(actor,'workers',{date:'2026-02-01',search:code})).rows[0]?.data.title).toBe('Original');
  expect((await listRecords(actor,'workers',{date:'2026-05-01',search:code})).total).toBe(0);
  expect((await listRecords(actor,'workers',{date:'2026-06-15',search:code})).rows[0]?.data.title).toBe('Summer');
  expect((await listRecords(actor,'workers',{date:'2026-08-01',search:code})).total).toBe(0);
  await mutateRecord(actor,'workers',{operation:'ARCHIVE',id:row.id,version:row.version});
  expect((await listRecords(actor,'workers',{date:'2026-06-15',search:code})).total).toBe(0);
  expect((await listRecords(actor,'workers',{date:'2026-02-01',search:code})).rows[0]?.data.title).toBe('Original');
 });
 it('shared persistence rejects duplicate-create IDs and backwards effective starts',async()=>{
  const row=await getRecord(actor,'workers',workerId);
  await expect(mutateRecord(actor,'workers',{operation:'CREATE',id:row.id,orgId,validFrom:row.validFrom,data:{code:'TEST-SHADOW',workerType:'manual-only',employmentStatus:'active',homeOrgId:orgId}})).rejects.toMatchObject({code:'PERSISTENCE_VERSION_OR_DATE_CONFLICT'});
  await expect(transaction(tenantId,tx=>persistRevision(tx,actor,'workers',{...row,version:row.version+1,validFrom:'2000-01-01'},'UPDATE'))).rejects.toMatchObject({code:'PERSISTENCE_VERSION_OR_DATE_CONFLICT'});
  expect((await getRecord(actor,'workers',workerId)).version).toBe(row.version);
 });
});
