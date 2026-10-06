import { randomUUID } from 'node:crypto';
import { database, query, transaction } from './lib/db';
import { actorForPrincipal } from './lib/jobs';
import { processImport } from './lib/imports/service';
import { processGraphJob } from './lib/graph/worker';
import { audit } from './lib/audit';
import { AppError } from './lib/errors';
import { assertPermission } from './lib/policy';
import {queueDueReportSchedules,processScheduledReport} from './lib/report-schedules';

const workerId=randomUUID();let stopped=false;
process.on('SIGINT',()=>{stopped=true;});process.on('SIGTERM',()=>{stopped=true;});
async function runTenant(tenantId:string){
 const lock=await database().connect();
 try{
  const obtained=(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked',[tenantId+':worker'])).rows[0].locked;if(!obtained)return;
  await queueDueReportSchedules(tenantId);
  const job=await transaction(tenantId,async tx=>{
   await tx.query("UPDATE jobs SET status='queued',locked_at=NULL,locked_by=NULL WHERE tenant_id=$1 AND status='running' AND locked_at<now()-interval '10 minutes'",[tenantId]);
   return (await tx.query("UPDATE jobs SET status='running',attempts=attempts+1,locked_at=now(),locked_by=$2,updated_at=now() WHERE id=(SELECT id FROM jobs WHERE tenant_id=$1 AND status='queued' AND run_after<=now() ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",[tenantId,workerId])).rows[0];
  });
  if(!job)return;
  try{
   const actor=await actorForPrincipal(tenantId,job.actor_id);
   if(job.kind==='IMPORT_COMMIT')await processImport(actor,job.payload.batchId);
   else if(job.kind==='REPORT_EXPORT')await processScheduledReport(actor,job.payload.runId);
   else if(job.kind.startsWith('graph.')){await assertPermission(actor,'settings','ADMIN',null,'configuration');await processGraphJob(job,actor);}
   else throw new AppError(422,'UNKNOWN_JOB_KIND');
   await transaction(tenantId,async tx=>{await tx.query("UPDATE jobs SET status='succeeded',locked_at=NULL,locked_by=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,job.id]);await audit(tx,actor,'JOB_SUCCEEDED','jobs',job.id,{jobId:job.id});});
  }catch(error){
   const code=error instanceof AppError?error.code:'JOB_FAILED';const retryMs=Math.max(Math.min(1000*2**job.attempts,300000),Number((error as {retryAfterMs?:number})?.retryAfterMs??0));
   await transaction(tenantId,async tx=>{await tx.query("UPDATE jobs SET status=$3,error_code=$4,run_after=now()+($5::int*interval '1 millisecond'),locked_at=NULL,locked_by=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,job.id,job.attempts>=5?'dead':'queued',code,retryMs]);});
   console.error(JSON.stringify({event:'job_failed',jobId:job.id,code}));
  }
 }finally{await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[tenantId+':worker']);lock.release();}
}
while(!stopped){try{const tenants=await query<{id:string}>('SELECT id FROM tenants ORDER BY id');for(const tenant of tenants){if(stopped)break;await runTenant(tenant.id);}}catch{console.error(JSON.stringify({event:'worker_database_unavailable'}));}if(!stopped)await new Promise(resolve=>setTimeout(resolve,2000));}
await database().end();
