import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createIsolatedPostgres } from './isolated-postgres';
import { listRecords } from '../src/lib/records';
import { overview } from '../src/lib/reporting';
import { closeDatabase, transaction } from '../src/lib/db';
import type { Actor, Grant } from '../src/lib/types';

// Synthetic-only service/SQL benchmark. It never connects to a supplied DATABASE_URL.
// Fixed budgets are declared before measurement; failures remain failures in the report.
const count=100_000,date='2026-09-23',samples=10;
const cluster=await createIsolatedPostgres('load');
process.env.DATABASE_URL=cluster.env.DATABASE_URL;
const tenantId=randomUUID(),userId=randomUUID(),otherTenant=randomUUID();
const grant=(domain:string,scope:Grant['scope']='tenant',orgId:string|null=null,dataClass='planning'):Grant=>({domain,operation:'READ',dataClass,orgId,scope,validFrom:'2000-01-01',validTo:null});
const actor:Actor={tenantId,userId,sessionId:'synthetic-load',roles:[],authVersion:1,grants:['workers','contracts','assignments','availability','calendars','holidays'].map(d=>grant(d))};
const results:{name:string;samples:number;concurrency:number;budgetMs:number;p50Ms:number;p95Ms:number;maxMs:number;passed:boolean}[]=[];
const failures:{name:string;stage:string;code?:string;message:string}[]=[];
let fatalError:string|undefined;
let seedMs=0,complete=false,passed=false;
process.on('exit',code=>{if(!complete)process.exitCode=code||1;});
const started=performance.now();
async function benchmark(name:string,budgetMs:number,run:()=>Promise<void>,concurrency=1){
 let stage='warmup';
 try{
 await run(); // Separate warmup; measured samples below are not claimed as cold starts.
 stage='measured samples';
 const durations:number[]=[];
 for(let batch=0;batch<samples;batch+=concurrency){
  await Promise.all(Array.from({length:Math.min(concurrency,samples-batch)},async()=>{const begin=performance.now();await run();durations.push(performance.now()-begin);}));
 }
 durations.sort((a,b)=>a-b);
 const percentile=(p:number)=>Math.round(durations[Math.ceil(durations.length*p)-1]);
 const result={name,samples:durations.length,concurrency,budgetMs,p50Ms:percentile(.5),p95Ms:percentile(.95),maxMs:Math.round(durations.at(-1)!),passed:percentile(.95)<=budgetMs};
 results.push(result);console.log(JSON.stringify(result));
 }catch(error){const e=error as Error&{code?:string};const failure={name,stage,code:e.code,message:e.message};failures.push(failure);console.error(JSON.stringify({event:'benchmark_failed',...failure}));}
}
try{
 const admin=cluster.pg.getPgClient('workforce_test','127.0.0.1');await admin.connect();
 let orgId:string,divisionId:string,managerId:string;
 try{
  await admin.query('BEGIN');
  await admin.query('INSERT INTO tenants(id,name,settings) VALUES($1,$3,$4),($2,$3,$4)',[tenantId,otherTenant,'SYNTHETIC LOAD ONLY',{synthetic:true}]);
  await admin.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[userId,tenantId,randomUUID()]);
  // Eleven hierarchy branches, one hundred teams and 1,000 workers per team.
  await admin.query(`INSERT INTO org_units(id,tenant_id,org_id,valid_from,data) SELECT md5($1||':org:'||n)::uuid,$1::uuid,md5($1||':org:'||n)::uuid,'2026-01-01',jsonb_build_object('code','SYN-ORG-'||n,'name','Synthetic unit '||n,'orgType',CASE WHEN n=0 THEN 'Company' WHEN n<=10 THEN 'Division' ELSE 'Team' END) FROM generate_series(0,110) n`,[tenantId]);
  await admin.query(`INSERT INTO org_edges(id,tenant_id,org_id,valid_from,data) SELECT gen_random_uuid(),$1::uuid,md5($1||':org:'||n)::uuid,'2026-01-01',jsonb_build_object('parentId',md5($1||':org:'||CASE WHEN n<=10 THEN 0 ELSE 1+(n-11)/10 END)::uuid,'childId',md5($1||':org:'||n)::uuid,'hierarchy','primary') FROM generate_series(1,110) n`,[tenantId]);
  await admin.query(`INSERT INTO workers(id,tenant_id,org_id,valid_from,data) SELECT md5($1||':worker:'||n)::uuid,$1::uuid,md5($1||':org:'||(11+(n-1)%100))::uuid,'2026-01-01',jsonb_build_object('code','SYN-W-'||lpad(n::text,6,'0'),'workerType','manual-only','employmentStatus','active','homeOrgId',md5($1||':org:'||(11+(n-1)%100))::uuid,'title','Synthetic role '||n%20) FROM generate_series(1,$2::int) n`,[tenantId,count]);
  await admin.query(`INSERT INTO workers(tenant_id,valid_from,data) VALUES($1,'2026-01-01','{"code":"SYN-FOREIGN","workerType":"manual-only","employmentStatus":"active"}')`,[otherTenant]);
  await admin.query(`INSERT INTO calendars(id,tenant_id,valid_from,data) VALUES(md5($1||':calendar')::uuid,$1::uuid,'2026-01-01','{"name":"Synthetic weekdays","weekdays":"1,2,3,4,5","hoursPerDay":8}')`,[tenantId]);
  await admin.query(`INSERT INTO roles(id,tenant_id,valid_from,data) VALUES(md5($1||':role')::uuid,$1::uuid,'2026-01-01','{"name":"Synthetic role"}')`,[tenantId]);
  await admin.query(`INSERT INTO contracts(tenant_id,org_id,worker_id,valid_from,data) SELECT tenant_id,org_id,id,'2026-01-01',jsonb_build_object('fte',1,'weeklyHours',40,'calendarId',md5($1||':calendar')::uuid,'movable',true,'confirmedOn',$2::text) FROM workers WHERE tenant_id=$1::uuid`,[tenantId,date]);
  await admin.query(`INSERT INTO assignments(tenant_id,org_id,worker_id,valid_from,data) SELECT w.tenant_id,w.org_id,w.id,'2026-01-01',jsonb_build_object('roleId',md5($1||':role')::uuid,'fte',0.4,'allocationStatus','committed','kind',CASE WHEN n=1 THEN 'primary' ELSE 'project' END) FROM workers w CROSS JOIN generate_series(1,2) n WHERE tenant_id=$1::uuid`,[tenantId]);
  await admin.query(`INSERT INTO availability(tenant_id,org_id,worker_id,valid_from,data) SELECT tenant_id,org_id,id,'2026-01-01','{"fraction":0.5,"approved":true,"kind":"leave"}' FROM workers WHERE tenant_id=$1::uuid AND (substring(data->>'code' from 7)::int)%10=0`,[tenantId]);
  await admin.query(`INSERT INTO identities(tenant_id,org_id,worker_id,valid_from,data) SELECT tenant_id,org_id,id,'2026-01-01',jsonb_build_object('displayName','SYNTHETIC PROTECTED NAME','email','synthetic@example.invalid') FROM workers WHERE tenant_id=$1::uuid`,[tenantId]);
  await admin.query(`INSERT INTO compensation(tenant_id,org_id,worker_id,valid_from,data) SELECT tenant_id,org_id,id,'2026-01-01','{"amount":123456.78,"currency":"USD","basis":"annual","paidFte":1,"bonus":0,"burdenPercent":20,"source":"Synthetic fixture"}' FROM workers WHERE tenant_id=$1::uuid`,[tenantId]);
  await admin.query(`INSERT INTO reporting_lines(tenant_id,org_id,worker_id,valid_from,data) SELECT $1::uuid,md5($1||':org:'||(11+(n-1)%100))::uuid,md5($1||':worker:'||n)::uuid,'2026-01-01',jsonb_build_object('managerId',md5($1||':worker:1')::uuid,'kind','primary') FROM generate_series(2,100) n`,[tenantId]);
  // Mirror real creation histories to exercise effective-date lookup alongside current rows.
  for(const domain of ['workers','contracts','assignments','availability','identities','compensation','org-units','org-edges','reporting-lines','calendars']){
   const table=domain.replaceAll('-','_');
   await admin.query(`INSERT INTO record_history(tenant_id,domain,record_id,version,snapshot,actor_id) SELECT tenant_id,$2,id,version,jsonb_build_object('id',id,'tenantId',tenant_id,'orgId',org_id,'workerId',worker_id,'validFrom',valid_from,'validTo',valid_to,'state',state,'version',version,'data',data),$3 FROM ${table} WHERE tenant_id=$1::uuid`,[tenantId,domain,userId]);
  }
  await admin.query('COMMIT');await admin.query('VACUUM (ANALYZE)');
  const ids=(await admin.query(`SELECT md5($1||':org:11')::uuid org,md5($1||':org:1')::uuid division,md5($1||':worker:1')::uuid manager`,[tenantId])).rows[0];
  orgId=ids.org;divisionId=ids.division;managerId=ids.manager;
 }finally{await admin.end();}
 seedMs=Math.round(performance.now()-started);console.log(JSON.stringify({event:'synthetic_seeded',workers:count,seedMs}));
 const scoped:Actor={...actor,grants:[grant('workers','org',orgId!)]};
 const subtree:Actor={...actor,grants:[grant('workers','subtree',divisionId!)]};
 const reports:Actor={...actor,grants:[grant('workers','reports',managerId!)]};
 const payroll:Actor={...actor,grants:[grant('compensation','org',orgId!,'salary')]};
 await transaction(tenantId,async tx=>{assert.equal((await tx.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0].rolbypassrls,false);assert.equal((await tx.query('SELECT id FROM workers WHERE tenant_id=$1::uuid',[otherTenant])).rowCount,0);});
 await benchmark('worker page / tenant',2000,async()=>{const r=await listRecords(actor,'workers',{date,pageSize:50});assert.equal(r.total,count);assert.equal(r.rows.length,50);assert.ok(r.rows.every(w=>w.tenantId===tenantId&&!('email' in w.data)&&!('amount' in w.data)));});
 await benchmark('worker page / org',2000,async()=>{const r=await listRecords(scoped,'workers',{date,pageSize:50});assert.equal(r.total,1000);assert.ok(r.rows.every(w=>w.orgId===orgId));});
 await benchmark('worker page / subtree',2000,async()=>{const r=await listRecords(subtree,'workers',{date,pageSize:50});assert.equal(r.total,10000);});
 await benchmark('worker page / reports',2000,async()=>{const r=await listRecords(reports,'workers',{date,pageSize:50});assert.equal(r.total,99);});
 await benchmark('search / org / server sort',2000,async()=>{const r=await listRecords(scoped,'workers',{date,pageSize:50,search:'SYN-W-',sort:'code',direction:'desc'});assert.equal(r.total,1000);assert.ok(String(r.rows[0].data.code)>String(r.rows[1].data.code));});
 await benchmark('restricted payroll page',2000,async()=>{const r=await listRecords(payroll,'compensation',{date,pageSize:50});assert.equal(r.total,1000);assert.ok(r.rows.every(p=>p.orgId===orgId));});
 await benchmark('forbidden payroll query',1000,async()=>{const r=await listRecords(scoped,'compensation',{date,pageSize:50});assert.equal(r.total,0);assert.deepEqual(r.rows,[]);});
 await benchmark('capacity dashboard / tenant',3000,async()=>{const r=await overview(actor,date);assert.equal(r.metrics.find(m=>m.label==='Unique active people')?.value,count);assert.equal(r.metrics.find(m=>m.label==='Work-eligible FTE')?.value,95000);assert.equal(r.metrics.find(m=>m.label==='Confirmed available FTE')?.value,19000);});
 await benchmark('worker page / 5 concurrent',5000,async()=>{assert.equal((await listRecords(scoped,'workers',{date,pageSize:50})).total,1000);},5);
 complete=true;
}catch(error){fatalError=(error as Error).message;throw error;}finally{
 await closeDatabase();await cluster.stop();
 const report={timestamp:new Date().toISOString(),synthetic:true,workers:count,seedMs,clusterDir:cluster.clusterDir,platform:process.platform,node:process.version,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,memoryGiB:Math.round(os.totalmem()/1024**3),postgres:'18.4 embedded native',scope:'Warm service/SQL reads after bulk VACUUM ANALYZE; not HTTP, browser, production Azure or sustained traffic. Bulk fixture preparation is excluded from request latency.',results,failures,fatalError,completed:complete,passed:complete&&failures.length===0&&results.every(r=>r.passed)};
 await writeFile('.local/load-results-'+report.timestamp.replaceAll(/[:.]/g,'-')+'.json',JSON.stringify(report,null,2));
 await writeFile('.local/load-results.json',JSON.stringify(report,null,2));
 passed=report.passed;
 if(!report.passed)process.exitCode=1;
 console.log(JSON.stringify({result:report.passed?'passed':'failed',report:'.local/load-results.json'}));
}
if(!passed)throw new Error('Load assertions or response budgets failed; see .local/load-results.json');
