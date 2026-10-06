import {randomUUID} from 'node:crypto';
import {transaction} from './db';
import {actorForPrincipal,enqueue} from './jobs';
import {assertPermission} from './policy';
import {readLocked,recordRow,persistRevision,today} from './records';
import {reportRequest,assertReportTarget,type ScheduledReportRequest} from './report-contract';
import {createStoredExport} from './imports/service';
import type {ExportArtifactStore} from './imports/artifacts';
import {audit} from './audit';
import {AppError} from './errors';
import type {Actor,RecordRow} from './types';

/** Called under the worker's per-tenant lock. Missed intervals coalesce to one run. */
export async function queueDueReportSchedules(tenantId:string){
 return transaction(tenantId,async tx=>{
  if(!(await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',[tenantId+':report-scheduler'])).rows[0].locked)return [];
  const candidates=(await tx.query(`SELECT r.*,c.next_run_at,c.schedule_version cursor_version FROM report_schedules r
   LEFT JOIN report_schedule_cursors c ON c.tenant_id=r.tenant_id AND c.schedule_id=r.id
   WHERE r.tenant_id=$1 AND r.state='active' AND r.data->>'enabled'='true'
    AND r.valid_from<=CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to>CURRENT_DATE)
    AND (c.schedule_id IS NULL OR c.schedule_version<>r.version OR c.next_run_at<=now())
   ORDER BY COALESCE(c.next_run_at,r.created_at),r.id FOR UPDATE OF r SKIP LOCKED LIMIT 25`,[tenantId])).rows;
  const jobs:string[]=[];
  for(const raw of candidates){
   const schedule=recordRow(raw),ownerId=String(schedule.data.ownerId);
   const interval=Number(schedule.data.intervalHours);
   let errorCode:string|null=null;
   try{
    const actor=await actorForPrincipal(tenantId,ownerId,tx);
    await assertPermission(actor,'report-schedules','READ',schedule.orgId,undefined,tx,today());
    const request=reportRequest(schedule.data,today());await assertReportTarget(actor,request,tx);
    const runId=randomUUID();const jobId=await enqueue(tx,actor,'REPORT_EXPORT',{runId});
    await tx.query(`INSERT INTO report_runs(id,tenant_id,schedule_id,schedule_version,actor_id,due_at,request,job_id)
     VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now()),$7,$8)`,[runId,tenantId,schedule.id,schedule.version,ownerId,raw.cursor_version===schedule.version?raw.next_run_at:null,request,jobId]);
    jobs.push(jobId);
   }catch(error){if(!(error instanceof AppError))throw error;errorCode=error.code;}
   // Invalid/revoked schedules cannot busy-loop or generate an unbounded backlog.
   await tx.query(`INSERT INTO report_schedule_cursors(tenant_id,schedule_id,schedule_version,next_run_at,error_code)
    VALUES($1,$2,$3,now()+($4::numeric*interval '1 hour'),$5) ON CONFLICT(tenant_id,schedule_id)
    DO UPDATE SET schedule_version=EXCLUDED.schedule_version,next_run_at=EXCLUDED.next_run_at,error_code=EXCLUDED.error_code`,[tenantId,schedule.id,schedule.version,Number.isFinite(interval)&&interval>=1&&interval<=8760?interval:1,errorCode]);
  }
  return jobs;
 });
}

export async function processScheduledReport(actor:Actor,runId:string,storage?:ExportArtifactStore){
 if(!/^[0-9a-f-]{36}$/i.test(runId))throw new AppError(422,'INVALID_REPORT_RUN');
 return transaction(actor.tenantId,async tx=>{
  const run=(await tx.query('SELECT * FROM report_runs WHERE tenant_id=$1 AND id=$2 AND actor_id=$3 FOR UPDATE',[actor.tenantId,runId,actor.userId])).rows[0];
  if(!run)throw new AppError(404,'REPORT_RUN_NOT_FOUND');
  const schedule=await readLocked(tx,actor,'report-schedules',run.schedule_id);
  if(schedule.data.ownerId!==actor.userId)throw new AppError(404,'REPORT_RUN_NOT_FOUND');
  if(schedule.state!=='active'||schedule.data.enabled!==true||schedule.version!==run.schedule_version||schedule.validFrom>today()||(schedule.validTo&&schedule.validTo<=today()))throw new AppError(409,'REPORT_SCHEDULE_CHANGED');
  const request=run.request as ScheduledReportRequest;await assertReportTarget(actor,request,tx);
  if(run.completed_at)return {exportId:run.export_id};
  // The run lock serializes retries. A crash after artifact creation reuses this stable ID.
  const exported=await createStoredExport(actor,request,storage,run.id);
  const notification:RecordRow={id:run.id,tenantId:actor.tenantId,orgId:schedule.orgId,workerId:null,validFrom:today(),validTo:null,version:1,state:'active',data:{title:'Scheduled report ready',link:'/workspace/exports?exportId='+exported.exportId,recipientId:actor.userId,read:false}};
  await persistRevision(tx,actor,'notifications',notification,'REPORT_NOTIFICATION');
  await tx.query('UPDATE report_runs SET export_id=$3,completed_at=now() WHERE tenant_id=$1 AND id=$2',[actor.tenantId,run.id,exported.exportId]);
  await audit(tx,actor,'REPORT_READY','report-schedules',schedule.id,{jobId:run.job_id});
  return {exportId:exported.exportId};
 });
}
