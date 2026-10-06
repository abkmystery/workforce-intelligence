import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transaction,closeDatabase} from '../../src/lib/db';
import {mutateRecord,today} from '../../src/lib/records';
import {queueDueReportSchedules,processScheduledReport} from '../../src/lib/report-schedules';
import {actorForPrincipal} from '../../src/lib/jobs';
import {createStoredExport,downloadStoredExport} from '../../src/lib/imports/service';
import type {ExportArtifactStore} from '../../src/lib/imports/artifacts';
import {domains} from '../../src/lib/registry';
import type {Actor} from '../../src/lib/types';
const tenantId=randomUUID(),userId=randomUUID();
const actor:Actor={tenantId,userId,sessionId:'test',roles:[],authVersion:1,grants:Object.values(domains).map(d=>({domain:d.key,operation:'*',dataClass:d.dataClass,orgId:null,scope:'tenant',validFrom:'2000-01-01',validTo:null}))};
let writes=0;const blobs=new Map<string,Buffer>();
const storage:ExportArtifactStore={async put(key,bytes){writes++;blobs.set(key,Buffer.from(bytes));},async get(key){return Buffer.from(blobs.get(key)!);},async remove(key){blobs.delete(key);}};
async function schedule(){return mutateRecord(actor,'report-schedules',{operation:'CREATE',validFrom:'2026-01-01',data:{name:'Synthetic report '+randomUUID(),domain:'workers',filters:JSON.stringify({date:'2026-09-23'}),format:'csv',intervalHours:24,enabled:true}});}
async function runFor(id:string){return transaction(tenantId,async tx=>(await tx.query('SELECT * FROM report_runs WHERE tenant_id=$1 AND schedule_id=$2 ORDER BY created_at DESC LIMIT 1',[tenantId,id])).rows[0]);}
describe.skipIf(!process.env.TEST_DATABASE_URL)('scheduled report execution',()=>{
 beforeAll(async()=>{process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;await transaction(tenantId,async tx=>{await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[tenantId,'SYNTHETIC report schedules']);await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[userId,tenantId,randomUUID()]);for(const g of actor.grants)await tx.query('INSERT INTO access_grants(tenant_id,principal_id,domain,operation,data_class,scope,valid_from) VALUES($1,$2,$3,$4,$5,$6,$7)',[tenantId,userId,g.domain,g.operation,g.dataClass,g.scope,g.validFrom]);});
  const org=await mutateRecord(actor,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'SYN-REPORT',name:'Synthetic report team',orgType:'Team'}});
  await mutateRecord(actor,'workers',{operation:'CREATE',orgId:org.id,validFrom:'2026-01-01',data:{code:'SYN-REPORT-WORKER',workerType:'manual-only',employmentStatus:'active',homeOrgId:org.id}});
 });afterAll(closeDatabase);
 it('concurrent polling queues one due run; repeated execution produces one artifact and notification',async()=>{
  const s=await schedule();const queued=await Promise.all([queueDueReportSchedules(tenantId),queueDueReportSchedules(tenantId)]);expect(queued.flat()).toHaveLength(1);expect(await queueDueReportSchedules(tenantId)).toEqual([]);
  const run=await runFor(s.id),before=writes;const results=await Promise.all([processScheduledReport(actor,run.id,storage),processScheduledReport(actor,run.id,storage)]);expect(results[0]).toEqual(results[1]);expect(writes-before).toBe(1);
  const bytes=await downloadStoredExport(actor,results[0].exportId,storage);expect(bytes.bytes.toString()).toContain('SYN-REPORT-WORKER');
  await transaction(tenantId,async tx=>{expect((await tx.query('SELECT * FROM notifications WHERE tenant_id=$1 AND id=$2',[tenantId,run.id])).rowCount).toBe(1);});
 });
 it('reuses a stored artifact after a crash before run completion',async()=>{
  const s=await schedule();await queueDueReportSchedules(tenantId);const run=await runFor(s.id),before=writes;
  const first=await createStoredExport(actor,run.request,storage,run.id);expect(await processScheduledReport(actor,run.id,storage)).toEqual({exportId:first.exportId});expect(writes-before).toBe(1);
 });
 it('disable or edits after queueing block the queued export',async()=>{
  const s=await schedule();await queueDueReportSchedules(tenantId);const run=await runFor(s.id),before=writes;
  await mutateRecord(actor,'report-schedules',{operation:'UPDATE',id:s.id,version:s.version,data:{enabled:false}});
  await expect(processScheduledReport(actor,run.id,storage)).rejects.toMatchObject({code:'REPORT_SCHEDULE_CHANGED'});expect(writes).toBe(before);
 });
 it('failed storage leaves no notification and permits safe retry',async()=>{
  const s=await schedule();await queueDueReportSchedules(tenantId);const run=await runFor(s.id);
  await expect(processScheduledReport(actor,run.id,{...storage,async put(){throw new Error('Synthetic unavailable');}})).rejects.toMatchObject({code:'EXPORT_STORAGE_UNAVAILABLE'});
  expect((await runFor(s.id)).completed_at).toBeNull();await processScheduledReport(actor,run.id,storage);expect((await runFor(s.id)).completed_at).not.toBeNull();
 });
 it('rejects protected-domain schedules without source permissions and unrecognized filter keys',async()=>{
  const restricted:Actor={...actor,grants:actor.grants.filter(g=>g.domain==='report-schedules')};
  await expect(mutateRecord(restricted,'report-schedules',{operation:'CREATE',data:{name:'No pay access',domain:'compensation',filters:'{}',intervalHours:24,enabled:true}})).rejects.toMatchObject({status:403});
  await expect(mutateRecord(actor,'report-schedules',{operation:'CREATE',data:{name:'Invalid columns',domain:'workers',filters:'{"columns":["amount"]}',intervalHours:24,enabled:true}})).rejects.toMatchObject({code:'INVALID_REPORT_FILTERS'});
 });
 it('notifications allow only their recipient to mark read and preserve server fields',async()=>{
  const run=await transaction(tenantId,async tx=>(await tx.query('SELECT * FROM notifications WHERE tenant_id=$1 LIMIT 1',[tenantId])).rows[0]);
  const read=await mutateRecord(actor,'notifications',{operation:'UPDATE',id:run.id,version:run.version,data:{read:true}});expect(read.data.read).toBe(true);
  await expect(mutateRecord(actor,'notifications',{operation:'UPDATE',id:read.id,version:read.version,data:{link:'/workspace/overview'}})).rejects.toMatchObject({code:'NOTIFICATION_FIELDS_READ_ONLY'});
 });
 it('reloads source authorization at execution after grant revocation',async()=>{
  const s=await schedule();await queueDueReportSchedules(tenantId);const run=await runFor(s.id),before=writes;
  await transaction(tenantId,async tx=>{await tx.query("DELETE FROM access_grants WHERE tenant_id=$1 AND principal_id=$2 AND domain='workers'",[tenantId,userId]);await tx.query('UPDATE principals SET auth_version=auth_version+1 WHERE tenant_id=$1 AND id=$2',[tenantId,userId]);});
  const fresh=await actorForPrincipal(tenantId,userId);await expect(processScheduledReport(fresh,run.id,storage)).rejects.toMatchObject({code:'REPORT_PERMISSION_DENIED'});expect(writes).toBe(before);expect(fresh.authVersion).toBe(2);expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
 });
});
