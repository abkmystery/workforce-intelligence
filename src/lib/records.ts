import { randomUUID } from 'node:crypto';
import { transaction, type DbClient } from './db';
import { domains } from './registry';
import { AppError, invariant } from './errors';
import { mutationSchema, validateData, isoDate } from './validation';
import { assertFresh, assertPermission, scopePredicate } from './policy';
import { audit } from './audit';
import type { Actor, RecordRow, RecordFilter, MutationInput } from './types';
import {effectiveRows} from './dating';
import {reportRequest,assertReportTarget} from './report-contract';
import { consideredForRoles, considerationPredicate } from './role-consideration';

export const today = () => new Date().toISOString().slice(0,10);
const dateString=(v:unknown)=>v instanceof Date?v.toISOString().slice(0,10):String(v);
export function recordRow(row:Record<string,any>):RecordRow{return {id:row.id,tenantId:row.tenant_id,orgId:row.org_id,workerId:row.worker_id,validFrom:dateString(row.valid_from),validTo:row.valid_to?dateString(row.valid_to):null,version:row.version,state:row.state,data:row.data};}
export function definition(domain:string){const d=domains[domain];if(!d)throw new AppError(404,'UNKNOWN_DOMAIN');return d;}
// A stable record ID may have future revisions. Select the newest revision effective at the requested date.
export function datedSource(domain:string):string{definition(domain);return effectiveRows(domain);}
export async function listRecords(actor:Actor,domain:string,filter:RecordFilter&{operation?:string}={}):Promise<{rows:RecordRow[];total:number}>{
 const d=definition(domain);const date=isoDate.parse(filter.date??today());const page=Math.max(1,Math.floor(filter.page??1)),pageSize=Math.min(200,Math.max(1,Math.floor(filter.pageSize??50)));
 return transaction(actor.tenantId,async tx=>{await assertFresh(actor,tx);const values:unknown[]=[actor.tenantId,date];const where=[`r.tenant_id=$1`,`(r.valid_to IS NULL OR r.valid_to>$2::date)`,scopePredicate(actor,domain,'READ','r',values,date)];
 if(filter.operation)where.push(scopePredicate(actor,domain,filter.operation,'r',values,date));
 const bind=(v:unknown)=>{values.push(v);return '$'+values.length;};
 if(filter.orgId)where.push(scopePredicate({...actor,grants:[{domain,operation:'READ',dataClass:d.dataClass,orgId:filter.orgId,scope:'subtree',validFrom:'0001-01-01',validTo:null}]},domain,'READ','r',values,date));
 if(filter.state)where.push('r.state='+bind(filter.state));else where.push("r.state<>'archived'");
 if(filter.roleId)where.push("r.data->>'roleId'="+bind(filter.roleId));
 if(domain==='redeployments'&&filter.considerForRoles!==undefined)where.push((filter.considerForRoles?'':'NOT ')+considerationPredicate('r'));
 if(filter.search){const safeFields=Object.entries(d.fields).filter(([,f])=>f.type==='text'&&!f.sensitive).map(([k])=>k);const p=bind('%'+filter.search.replace(/[\\%_]/g,'\\$&').slice(0,120)+'%');where.push(safeFields.length?'('+safeFields.map(k=>`r.data->>'${k}' ILIKE ${p}`).join(' OR ')+')':'FALSE');}
 if(['saved-views','report-schedules'].includes(domain))where.push("r.data->>'ownerId'="+bind(actor.userId));
 if(domain==='notifications')where.push("r.data->>'recipientId'="+bind(actor.userId));
 if(domain==='scenario-deltas')where.push("(r.data->>'domain'<>'compensation' OR "+scopePredicate(actor,'compensation','READ','r',values,date)+')');
 if(domain==='overrides')where.push("(r.data->>'domain' NOT IN ('identities','compensation') OR (r.data->>'domain'='identities' AND "+scopePredicate(actor,'identities','READ','r',values,date)+") OR (r.data->>'domain'='compensation' AND "+scopePredicate(actor,'compensation','READ','r',values,date)+'))');
 let order='r.id';if(filter.sort==='validFrom')order='r.valid_from';else if(filter.sort==='state')order='r.state';else if(filter.sort&&d.fields[filter.sort])order=`r.data->>'${filter.sort}'`;
 const source=datedSource(domain);const condition=where.join(' AND ');const total=Number((await tx.query(`SELECT count(*) n FROM ${source} r WHERE ${condition}`,values)).rows[0].n);
 const limit=bind(pageSize),offset=bind((page-1)*pageSize);const rows=(await tx.query(`SELECT r.* FROM ${source} r WHERE ${condition} ORDER BY ${order} ${filter.direction==='desc'?'DESC':'ASC'},r.id LIMIT ${limit} OFFSET ${offset}`,values)).rows.map(recordRow);
 if(['identity','salary','cost'].includes(d.dataClass))await audit(tx,actor,'READ',domain,null,{count:rows.length});return {rows,total};
 });
}
export async function readLocked(tx:DbClient,actor:Actor,domain:string,id:string,operation='READ',authorizationDate?:string):Promise<RecordRow>{const d=definition(domain);const result=await tx.query(`SELECT * FROM ${d.table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[actor.tenantId,id]);if(!result.rows[0])throw new AppError(404,'RECORD_NOT_FOUND');const row=recordRow(result.rows[0]);await assertPermission(actor,domain,operation,row.orgId,d.dataClass,tx,authorizationDate??row.validFrom,domain==='workers'?row.id:row.workerId);return row;}
export async function getRecord(actor:Actor,domain:string,id:string,date?:string):Promise<RecordRow>{return transaction(actor.tenantId,async tx=>{
 let row:RecordRow;
 if(date!==undefined){
  const asOf=isoDate.parse(date);definition(domain);await assertFresh(actor,tx);
  const values:unknown[]=[actor.tenantId,asOf,id];const scope=scopePredicate(actor,domain,'READ','r',values,asOf);
  const result=await tx.query(`SELECT r.* FROM ${datedSource(domain)} r WHERE r.id=$3::uuid AND (r.valid_to IS NULL OR r.valid_to>$2::date) AND ${scope}`,values);
  if(!result.rows[0])throw new AppError(404,'RECORD_NOT_FOUND');row=recordRow(result.rows[0]);
 }else row=await readLocked(tx,actor,domain,id);
 await protectEmbedded(actor,domain,row,tx);if(['identity','salary','cost'].includes(definition(domain).dataClass))await audit(tx,actor,'READ',domain,id);return row;
 });}
async function protectEmbedded(actor:Actor,domain:string,row:RecordRow,tx:DbClient){if(['overrides','scenario-deltas'].includes(domain)&&typeof row.data.domain==='string'&&domains[row.data.domain])await assertPermission(actor,row.data.domain,'READ',row.orgId,undefined,tx,row.validFrom,row.workerId);if(['saved-views','report-schedules'].includes(domain)&&row.data.ownerId!==actor.userId)throw new AppError(404,'RECORD_NOT_FOUND');if(domain==='notifications'&&row.data.recipientId!==actor.userId)throw new AppError(404,'RECORD_NOT_FOUND');}
const workerRequired=new Set(['identities','directory-accounts','external-identifiers','reporting-lines','occupancy','hired-for','worker-skills','contracts','assignments','availability','redeployments','fulfillments','movements','compensation','cost-allocations','reveals','privacy-requests']);
const references:Record<string,string>={homeOrgId:'org-units',parentId:'org-units',childId:'org-units',sourceOrgId:'org-units',destinationOrgId:'org-units',roleId:'roles',familyId:'role-families',activityId:'activities',skillId:'skills',managerId:'workers',destinationManagerId:'workers',placementId:'redeployments',positionId:'positions',calendarId:'calendars',demandId:'demands',sourceAssignmentId:'assignments',scenarioId:'scenarios',movementId:'movements'};
async function fieldPolicy(tx:DbClient,actor:Actor,domain:string,row:RecordRow,field:string){
 return (await tx.query(`SELECT p.data FROM ${datedSource('field-policies')} p WHERE p.state<>'archived' AND (p.valid_to IS NULL OR p.valid_to>$2::date) AND p.data->>'domain'=$3 AND p.data->>'field'=$4 AND (p.org_id IS NULL OR p.org_id=$5::uuid) AND (p.worker_id IS NULL OR p.worker_id=$6::uuid) ORDER BY (p.worker_id IS NOT NULL) DESC,(p.org_id IS NOT NULL) DESC,p.valid_from DESC,p.version DESC,p.id LIMIT 1`,[actor.tenantId,row.validFrom,domain,field,row.orgId,domain==='workers'?row.id:row.workerId])).rows[0]?.data;
}
async function checkReferences(tx:DbClient,actor:Actor,domain:string,row:RecordRow){
 if(workerRequired.has(domain))invariant(row.workerId,'WORKER_REQUIRED');
 if(row.workerId){
  const worker=await tx.query('SELECT id FROM workers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,row.workerId]);invariant(worker.rows[0],'INVALID_WORKER');
  const effective=(await tx.query(`SELECT org_id FROM ${datedSource('workers')} w WHERE w.id=$3 AND w.state<>'archived' AND (w.valid_to IS NULL OR w.valid_to>$2::date)`,[actor.tenantId,row.validFrom,row.workerId])).rows[0];invariant(effective,'WORKER_NOT_EFFECTIVE');
  await assertPermission(actor,'workers','READ',effective.org_id,undefined,tx,row.validFrom,row.workerId);
  if(['identities','directory-accounts','external-identifiers','contracts','hired-for','worker-skills','compensation','reveals','redeployments'].includes(domain))invariant(effective.org_id===row.orgId,'WORKER_HOME_SCOPE_MISMATCH');
 }
 for(const [key,value]of Object.entries(row.data)){
  let target=references[key];if(key==='parentId'&&domain==='scenarios')target='scenarios';if(!target||!value)continue;
  // A completed movement remains the provenance for the source allocation restored after its end.
  if(key==='movementId'){await readLocked(tx,actor,'movements',String(value));continue;}
  if(domain==='movements'&&row.data.kind==='transfer'&&key==='sourceAssignmentId'){
   const source=await readLocked(tx,actor,'assignments',String(value),'READ',row.validFrom);
   invariant(source.workerId===row.workerId&&source.orgId===row.data.sourceOrgId&&source.validFrom<=row.validFrom&&source.state!=='archived','INVALID_SOURCE_ASSIGNMENT');continue;
  }
  const result=await tx.query(`SELECT id,org_id,worker_id FROM ${datedSource(target)} r WHERE r.id=$3 AND r.state<>'archived' AND (r.valid_to IS NULL OR r.valid_to>$2::date)`,[actor.tenantId,row.validFrom,value]);invariant(result.rows[0],'INVALID_REFERENCE');await assertPermission(actor,target,'READ',result.rows[0].org_id,undefined,tx,row.validFrom,target==='workers'?result.rows[0].id:result.rows[0].worker_id);
  if(domain==='request-skills'&&key==='demandId')invariant(row.orgId===result.rows[0].org_id,'REQUEST_SKILL_SCOPE_MISMATCH');
 }
 if(domain==='workers')invariant(row.orgId===row.data.homeOrgId,'HOME_ORG_MISMATCH');
 if(domain==='redeployments'){
  invariant(String(row.data.reason).trim()&&String(row.data.location).trim(),'PLACEMENT_REASON_AND_LOCATION_REQUIRED');
  invariant(Number(row.data.fte)>0&&Number(row.data.fte)<=1,'INVALID_FTE');
  invariant(!row.data.placementDeadline||String(row.data.placementDeadline)>String(row.data.availableFrom),'INVALID_PLACEMENT_WINDOW');
  const duplicate=await tx.query('SELECT 1 FROM redeployments WHERE tenant_id=$1 AND worker_id=$2 AND id<>$3',[actor.tenantId,row.workerId,row.id]);
  invariant(!duplicate.rowCount,'PERSON_ALREADY_HAS_PLACEMENT_RECORD',409);
 }
 if(domain==='demands'&&row.data.headcount!=null)invariant(Number.isInteger(row.data.headcount)&&Number(row.data.headcount)>0,'INVALID_HEADCOUNT');
 if(domain==='demands'&&row.data.maxAnnualSalary!=null){
  invariant(Number(row.data.maxAnnualSalary)>=0,'INVALID_SALARY_BUDGET');
  invariant(/^[A-Z]{3}$/.test(String(row.data.salaryCurrency??'')),'SALARY_BUDGET_CURRENCY_REQUIRED');
 }
 if(['assignments','contracts','cost-allocations'].includes(domain))invariant(Number(row.data[domain==='cost-allocations'?'fraction':'fte'])>0&&Number(row.data[domain==='cost-allocations'?'fraction':'fte'])<=1,'INVALID_FTE');
 if(['demands','fulfillments','positions','vacancies','occupancy','movements'].includes(domain))invariant(Number(row.data.fte??row.data.fundedFte)>0,'INVALID_QUANTITY');
 if(domain==='availability')invariant(Number(row.data.fraction)>=0&&Number(row.data.fraction)<=1,'INVALID_FRACTION');
 if(domain==='compensation'){invariant(Number(row.data.amount)>=0&&Number(row.data.burdenPercent)>=0,'INVALID_PAY');invariant(/^[A-Z]{3}$/.test(String(row.data.currency)),'INVALID_CURRENCY');}
 if(domain==='fx-rates')invariant(Number(row.data.rate)>0,'INVALID_FX_RATE');
 if(domain==='calendars')invariant(/^[1-7](,[1-7])*$/.test(String(row.data.weekdays))&&Number(row.data.hoursPerDay)>0,'INVALID_CALENDAR');
 if(domain==='report-schedules'&&row.state!=='archived'){
  const request=reportRequest(row.data,today());if(row.data.enabled===true)await assertReportTarget(actor,request,tx);
 }
 if(domain==='overrides'){
  const targetDomain=String(row.data.domain),target=await readLocked(tx,actor,targetDomain,String(row.data.recordId),'OVERRIDE');
  invariant(target.orgId===row.orgId&&target.workerId===row.workerId,'OVERRIDE_SCOPE_MISMATCH');
  const field=String(row.data.field);invariant(definition(targetDomain).fields[field]&&field!=='objectId','INVALID_OVERRIDE_FIELD');
  const policy=await fieldPolicy(tx,actor,targetDomain,{...target,validFrom:row.validFrom},field);invariant(policy?.overrideAllowed===true,'OVERRIDE_NOT_ALLOWED');
 }
 if(domain==='notifications')invariant(String(row.data.link).startsWith('/workspace/')&&!String(row.data.link).includes('..'),'INVALID_LINK');
 if(domain==='scenario-deltas'){let payload:Record<string,unknown>;try{payload=JSON.parse(String(row.data.payload));}catch{throw new AppError(422,'INVALID_CHANGE_JSON');}invariant(payload&&typeof payload==='object'&&!Array.isArray(payload),'INVALID_CHANGE_JSON');const target=String(row.data.domain);await assertPermission(actor,target,String(row.data.operation),row.orgId,undefined,tx,row.validFrom,row.workerId);if(target==='compensation')await assertPermission(actor,target,'READ',row.orgId,undefined,tx,row.validFrom,row.workerId);}
}
async function checkDating(tx:DbClient,actor:Actor,domain:string,row:RecordRow){
 if(row.state==='archived')return;
 if(domain==='org-edges'||domain==='reporting-lines'){
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor.tenantId+':hierarchy']);
  const org=domain==='org-edges';const parent=String(row.data[org?'parentId':'managerId']),child=org?String(row.data.childId):row.workerId;
  invariant(parent!==child,'HIERARCHY_CYCLE');
  const table=org?'org_edges':'reporting_lines',childExpr=org?"(e.data->>'childId')::uuid":'e.worker_id',parentExpr=org?"(e.data->>'parentId')::uuid":"(e.data->>'managerId')::uuid";
  const result=await tx.query(`WITH RECURSIVE descendants(id,path) AS (SELECT $2::uuid,ARRAY[$2::uuid] UNION ALL SELECT ${childExpr},d.path||${childExpr} FROM ${table} e JOIN descendants d ON ${parentExpr}=d.id WHERE e.tenant_id=$1 AND e.id<>$4 AND e.state<>'archived' AND daterange(e.valid_from,e.valid_to,'[)') && daterange($5::date,$6::date,'[)') AND NOT ${childExpr}=ANY(d.path)) SELECT 1 FROM descendants WHERE id=$3 LIMIT 1`,[actor.tenantId,child,parent,row.id,row.validFrom,row.validTo]);invariant(!result.rowCount,'HIERARCHY_CYCLE');
 }
 if(domain==='assignments'&&['committed','actual'].includes(String(row.data.allocationStatus))){
  // The worker lock in checkReferences serializes concurrent allocations, including imports and movements.
  const result=await tx.query(`WITH intervals AS (SELECT valid_from,valid_to,(data->>'fte')::numeric fte FROM assignments WHERE tenant_id=$1 AND worker_id=$2 AND id<>$3 AND state<>'archived' AND data->>'allocationStatus' IN ('committed','actual') AND daterange(valid_from,valid_to,'[)') && daterange($4::date,$5::date,'[)') UNION ALL SELECT $4::date,$5::date,$6::numeric),points AS (SELECT valid_from point FROM intervals UNION SELECT valid_to FROM intervals WHERE valid_to IS NOT NULL) SELECT 1 FROM points p WHERE (SELECT sum(i.fte) FROM intervals i WHERE i.valid_from<=p.point AND (i.valid_to IS NULL OR i.valid_to>p.point))>1 LIMIT 1`,[actor.tenantId,row.workerId,row.id,row.validFrom,row.validTo,row.data.fte]);invariant(!result.rowCount,'OVER_ALLOCATION');
 }
}
export async function persistRevision(tx:DbClient,actor:Actor,domain:string,row:RecordRow,action:string){
 const d=definition(domain);const written=await tx.query(`INSERT INTO ${d.table}(id,tenant_id,org_id,worker_id,valid_from,valid_to,version,state,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,id) DO UPDATE SET org_id=EXCLUDED.org_id,worker_id=EXCLUDED.worker_id,valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,version=EXCLUDED.version,state=EXCLUDED.state,data=EXCLUDED.data,updated_at=now() WHERE ${d.table}.version=EXCLUDED.version-1 AND ${d.table}.valid_from<=EXCLUDED.valid_from`,[row.id,actor.tenantId,row.orgId,row.workerId,row.validFrom,row.validTo,row.version,row.state,row.data]);
 invariant(written.rowCount,'PERSISTENCE_VERSION_OR_DATE_CONFLICT',409);
 await tx.query('INSERT INTO record_history(tenant_id,domain,record_id,version,snapshot,actor_id) VALUES($1,$2,$3,$4,$5,$6)',[actor.tenantId,domain,row.id,row.version,row,actor.userId]);await audit(tx,actor,action,domain,row.id,{version:row.version,fields:Object.keys(row.data)});
}
export async function mutateRecord(actor:Actor,domain:string,raw:MutationInput,existingTx?:DbClient):Promise<RecordRow>{
 const d=definition(domain),input=mutationSchema.parse(raw);const run=async(tx:DbClient)=>{
  await assertFresh(actor,tx);let prior:RecordRow|undefined;
  if(input.operation!=='CREATE'){invariant(input.id&&input.version,'ID_AND_VERSION_REQUIRED');prior=await readLocked(tx,actor,domain,input.id,input.operation,domain==='redeployments'?input.validFrom??today():undefined);invariant(prior.version===input.version,'VERSION_CONFLICT',409);await protectEmbedded(actor,domain,prior,tx);}
  const changesConsideration=domain==='redeployments'&&(['ARCHIVE','RESTORE'].includes(input.operation)||(input.data?.considerForRoles!==undefined&&(input.data.considerForRoles!==false)!==(prior?.data.considerForRoles!==false)));
  const date=input.validFrom??(changesConsideration?today():prior?.validFrom??today());const data={...prior?.data,...input.data};
  if(domain==='redeployments'&&!prior&&data.considerForRoles===undefined)data.considerForRoles=true;
  if(['saved-views','report-schedules'].includes(domain))data.ownerId=actor.userId;
  if(domain==='notifications'){
   if(!prior)data.recipientId=actor.userId;
   else if(input.operation!=='UPDATE'||Object.keys(input.data??{}).some(field=>field!=='read'))throw new AppError(422,'NOTIFICATION_FIELDS_READ_ONLY');
  }
  if(['demands','reveals','overrides'].includes(domain)&&!prior)data.requesterId=actor.userId;
  if(domain==='scenarios'&&!prior)data.scenarioVersion=1;
  const row:RecordRow={id:prior?.id??input.id??randomUUID(),tenantId:actor.tenantId,orgId:input.orgId!==undefined?input.orgId:prior?.orgId??null,workerId:input.workerId!==undefined?input.workerId:prior?.workerId??null,validFrom:date,validTo:input.validTo!==undefined?input.validTo:prior?.validTo??null,version:(prior?.version??0)+1,state:input.operation==='ARCHIVE'?'archived':input.operation==='RESTORE'?(prior?.data._previousState as string??'active'):prior?.state??(['demands','movements','scenarios','reveals','overrides','privacy-requests'].includes(domain)?'draft':'active'),data:validateData(domain,data)};
  invariant(!row.validTo||row.validTo>row.validFrom,'INVALID_DATE_RANGE');if(prior)invariant(row.validFrom>=prior.validFrom,'HISTORY_REWRITE_REQUIRES_CORRECTION');
  if(domain==='redeployments'&&prior)invariant(row.workerId===prior.workerId,'PLACEMENT_PERSON_IMMUTABLE');
  if(domain==='redeployments'&&prior?.state==='placed'&&input.operation==='UPDATE'&&input.data?.considerForRoles===true)row.state='active';
  if(domain==='org-units')row.orgId=row.id;
  if(input.operation==='RESTORE'){
   const old=(await tx.query("SELECT snapshot->>'state' state FROM record_history WHERE tenant_id=$1 AND domain=$2 AND record_id=$3 AND snapshot->>'state'<>'archived' ORDER BY version DESC LIMIT 1",[actor.tenantId,domain,row.id])).rows[0];row.state=old?.state??'active';
  }
  await assertPermission(actor,domain,input.operation,row.orgId,d.dataClass,tx,date,domain==='workers'?row.id:row.workerId);
  if(domain==='redeployments'&&(
   consideredForRoles(row)!==(prior?consideredForRoles(prior):false)||
   (prior&&(prior.data.considerForRoles!==false)!==(row.data.considerForRoles!==false))||
   (consideredForRoles(row)&&prior&&(row.orgId!==prior.orgId||row.validFrom!==prior.validFrom||row.validTo!==prior.validTo))
  )){
   // HR grants can cover an organization; manager grants can cover dated reports.
   // A role name or ordinary planning CRUD permission is not sufficient.
   if(prior)await assertPermission(actor,domain,'FLAG_FOR_ROLES',prior.orgId,undefined,tx,date,prior.workerId);
   await assertPermission(actor,domain,'FLAG_FOR_ROLES',row.orgId,undefined,tx,row.validFrom,row.workerId);
  }
  if(prior&&['approved','committed','filled','partially-filled'].includes(prior.state)&&input.operation!=='ARCHIVE')throw new AppError(409,'APPROVED_RECORD_REQUIRES_WORKFLOW');
  if(['fulfillments','availability','worker-skills'].includes(domain)&&(row.data.approved===true||row.data.verified===true||prior?.data.approved===true||prior?.data.verified===true))await assertPermission(actor,domain,'APPROVE',row.orgId,undefined,tx,date,row.workerId);
  if(domain==='directory-accounts'||domain==='external-identifiers')await assertPermission(actor,domain,'LINK',row.orgId,undefined,tx,date,row.workerId);
  if(['reveals','overrides'].includes(domain))invariant(String(row.data.expiresOn)>today(),'EXPIRY_MUST_BE_FUTURE');
  await checkReferences(tx,actor,domain,row);await checkDating(tx,actor,domain,row);
  // Configured upstream owners cannot be overwritten through generic HR edits.
  if(input.data&&prior)for(const field of Object.keys(input.data)){const policy=await fieldPolicy(tx,actor,domain,row,field);if((policy?.owner??d.fields[field]?.owner)==='Entra')throw new AppError(409,'UPSTREAM_FIELD_REQUIRES_OVERRIDE');}
  await persistRevision(tx,actor,domain,row,input.operation);
  for(const field of Object.keys(input.data??{}))await tx.query(`INSERT INTO field_provenance(tenant_id,domain,record_id,field,owner,actor_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,domain,record_id,field) DO UPDATE SET owner=EXCLUDED.owner,actor_id=EXCLUDED.actor_id,seen_at=now()`,[actor.tenantId,domain,row.id,field,d.fields[field]?.owner??'application',actor.userId]);
  return row;
 };return existingTx?run(existingTx):transaction(actor.tenantId,run);
}
export async function recordHistory(actor:Actor,domain:string,id:string){return transaction(actor.tenantId,async tx=>{await readLocked(tx,actor,domain,id);const result=await tx.query('SELECT snapshot FROM record_history WHERE tenant_id=$1 AND domain=$2 AND record_id=$3 ORDER BY version DESC LIMIT 200',[actor.tenantId,domain,id]);const allowed:RecordRow[]=[];for(const item of result.rows){const row=item.snapshot as RecordRow;try{await assertPermission(actor,domain,'READ',row.orgId,undefined,tx,row.validFrom,domain==='workers'?row.id:row.workerId);await protectEmbedded(actor,domain,row,tx);allowed.push(row);}catch(e){if(!(e instanceof AppError&&e.status===403))throw e;}}await audit(tx,actor,'HISTORY_READ',domain,id,{count:allowed.length});return {rows:allowed,provenance:(await tx.query('SELECT field,owner,confidence,seen_at FROM field_provenance WHERE tenant_id=$1 AND domain=$2 AND record_id=$3',[actor.tenantId,domain,id])).rows};});}
