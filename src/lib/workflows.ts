import { createHash } from 'node:crypto';
import { transaction, type DbClient } from './db';
import type { Actor, RecordRow, MutationInput } from './types';
import { AppError, invariant } from './errors';
import { assertPermission } from './policy';
import { readLocked, persistRevision, mutateRecord, recordRow, today } from './records';
import { audit } from './audit';
import { movementImpact } from './math';
import { assertTransferDetails, commitPermanentTransfer } from './transfers';

type ActionInput={action:string;domain:string;id:string;version:number;stage?:string;comment?:string;historyVersion?:number;name?:string};
const approvalDomains=new Set(['demands','movements','scenarios','reveals','overrides','privacy-requests']);
async function revision(tx:DbClient,actor:Actor,domain:string,row:RecordRow,state:string,action:string){const next={...row,version:row.version+1,state};await persistRevision(tx,actor,domain,next,action);return next;}
async function requiredStages(tx:DbClient,tenantId:string,domain:string):Promise<string[]>{const settings=(await tx.query('SELECT settings FROM tenants WHERE id=$1',[tenantId])).rows[0]?.settings??{};const configured=settings.approvals?.[domain];if(Array.isArray(configured)&&configured.length>0&&configured.every((s:unknown)=>typeof s==='string'))return configured;return domain==='movements'?['source-manager','destination-manager','HR','Finance']:domain==='demands'?['manager','HR']:['HR','Finance'];}
export async function performAction(actor:Actor,input:ActionInput){
 invariant(input&&typeof input.id==='string'&&Number.isInteger(input.version),'INVALID_ACTION');
 return transaction(actor.tenantId,async tx=>{
  const row=await readLocked(tx,actor,input.domain,input.id,'READ');invariant(row.version===input.version,'VERSION_CONFLICT',409);
  const action=input.action.toLowerCase();
  if(action==='fork')return forkScenario(tx,actor,row,input.name);
  if(action==='compare')return scenarioComparison(tx,actor,row);
  if(action==='commit'){await assertPermission(actor,input.domain,'COMMIT',row.orgId,undefined,tx,row.validFrom,row.workerId);invariant(row.state==='approved','APPROVAL_REQUIRED',409);if(input.domain==='movements')return commitMovement(tx,actor,row);if(input.domain==='scenarios')return commitScenario(tx,actor,row);throw new AppError(422,'UNSUPPORTED_COMMIT');}
  if(action==='restore-version'){
   await assertPermission(actor,input.domain,'UPDATE',row.orgId,undefined,tx,row.validFrom,row.workerId);
   invariant(row.state==='draft'||row.state==='returned','DRAFT_REQUIRED');
   const snapshot=(await tx.query('SELECT snapshot FROM record_history WHERE tenant_id=$1 AND domain=$2 AND record_id=$3 AND version=$4',[actor.tenantId,input.domain,row.id,input.historyVersion])).rows[0]?.snapshot as RecordRow|undefined;
   invariant(snapshot,'VERSION_NOT_FOUND');return mutateRecord(actor,input.domain,{operation:'UPDATE',id:row.id,version:row.version,data:snapshot.data},tx);
  }
  if(action==='resolve'){await assertPermission(actor,input.domain,'UPDATE',row.orgId,undefined,tx,row.validFrom,row.workerId);invariant(input.domain==='reconciliation','INVALID_RESOLUTION');invariant(input.comment&&input.comment.length>=5,'RESOLUTION_REQUIRED');return revision(tx,actor,input.domain,{...row,data:{...row.data,resolution:input.comment}},'resolved','RESOLVE');}
  if(action==='revoke'&&input.domain==='reveals'){await assertPermission(actor,'reveals','APPROVE',row.orgId,undefined,tx,row.validFrom,row.workerId);await tx.query("DELETE FROM access_grants WHERE tenant_id=$1 AND source='reveal' AND source_key=$2",[actor.tenantId,row.id]);return revision(tx,actor,'reveals',row,'revoked','REVOKE');}
  invariant(approvalDomains.has(input.domain),'WORKFLOW_NOT_SUPPORTED');
  if(action==='submit'){
   await assertPermission(actor,input.domain,'UPDATE',row.orgId,undefined,tx,row.validFrom,row.workerId);invariant(['draft','returned'].includes(row.state),'INVALID_TRANSITION',409);
   if(input.domain==='scenarios')await captureBaseline(tx,actor,row);
   if(input.domain==='movements'&&row.data.kind==='transfer')assertTransferDetails(row);
   const result=await revision(tx,actor,input.domain,row,'submitted','SUBMIT');await notifyApprovers(tx,actor,input.domain,result);return result;
  }
  if(action==='cancel'){await assertPermission(actor,input.domain,'UPDATE',row.orgId,undefined,tx,row.validFrom,row.workerId);invariant(!['committed','filled','cancelled'].includes(row.state),'INVALID_TRANSITION');return revision(tx,actor,input.domain,row,'cancelled','CANCEL');}
  invariant(['approve','reject','return'].includes(action),'UNKNOWN_ACTION');invariant(['submitted','review'].includes(row.state),'INVALID_TRANSITION',409);
  const stages=await requiredStages(tx,actor.tenantId,input.domain);const stage=input.stage??stages[0];invariant(stages.includes(stage),'INVALID_APPROVAL_STAGE');
  const stageOrg=input.domain==='movements'&&stage==='source-manager'?String(row.data.sourceOrgId):input.domain==='movements'&&stage==='destination-manager'?String(row.data.destinationOrgId):row.orgId;
  await assertPermission(actor,input.domain,'APPROVE:'+stage,stageOrg,undefined,tx,row.validFrom,row.workerId);
  const creator=(await tx.query('SELECT actor_id FROM record_history WHERE tenant_id=$1 AND domain=$2 AND record_id=$3 ORDER BY version LIMIT 1',[actor.tenantId,input.domain,row.id])).rows[0]?.actor_id;
  invariant(creator!==actor.userId&&row.data.requesterId!==actor.userId,'SELF_APPROVAL_FORBIDDEN',403);
  const samePerson=await tx.query('SELECT 1 FROM approvals WHERE tenant_id=$1 AND domain=$2 AND record_id=$3 AND record_version=$4 AND actor_id=$5',[actor.tenantId,input.domain,row.id,row.version,actor.userId]);invariant(!samePerson.rowCount,'INDEPENDENT_APPROVER_REQUIRED',403);
  await tx.query('INSERT INTO approvals(tenant_id,domain,record_id,record_version,stage,actor_id,decision,comment) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[actor.tenantId,input.domain,row.id,row.version,stage,actor.userId,action==='approve'?'approved':action==='reject'?'rejected':'returned',(input.comment??'').slice(0,2000)]);
  await audit(tx,actor,'APPROVAL',input.domain,row.id,{stage,decision:action,version:row.version});
  if(action!=='approve')return revision(tx,actor,input.domain,row,action==='reject'?'rejected':'returned',action.toUpperCase());
  const approved=(await tx.query("SELECT stage FROM approvals WHERE tenant_id=$1 AND domain=$2 AND record_id=$3 AND record_version=$4 AND decision='approved'",[actor.tenantId,input.domain,row.id,row.version])).rows.map(r=>r.stage);
  if(!stages.every(s=>approved.includes(s)))return {...row,approvalProgress:{approved,required:stages}};
  if(input.domain==='reveals'){
   invariant(String(row.data.expiresOn)>today(),'REVEAL_EXPIRED');
   // Reveal grants are resource-specific in revealIdentity; never grant an org-wide identity view.
  }
  return revision(tx,actor,input.domain,row,'approved','APPROVE');
 });
}
async function notifyApprovers(tx:DbClient,actor:Actor,domain:string,row:RecordRow){
 const principals=(await tx.query("SELECT DISTINCT principal_id FROM access_grants WHERE tenant_id=$1 AND domain=$2 AND operation ILIKE 'APPROVE:%' AND (scope='tenant' OR org_id=$3) AND valid_from<=CURRENT_DATE AND (valid_to IS NULL OR valid_to>CURRENT_DATE) LIMIT 1000",[actor.tenantId,domain,row.orgId])).rows;
 for(const principal of principals)await tx.query("INSERT INTO notifications(tenant_id,org_id,valid_from,state,data) VALUES($1,$2,CURRENT_DATE,'active',$3)",[actor.tenantId,row.orgId,{title:'Approval required',link:'/workspace/'+(domain==='movements'?'mobility':domain==='demands'?'demand':domain)+'?id='+row.id,recipientId:principal.principal_id,read:false}]);
}
async function commitMovement(tx:DbClient,actor:Actor,proposal:RecordRow){
 if(proposal.data.kind==='transfer')return commitPermanentTransfer(tx,actor,proposal);
 invariant(proposal.data.kind==='loan','UNSUPPORTED_MOVEMENT_KIND');
 const data=proposal.data;invariant(proposal.validTo,'MOVEMENT_END_REQUIRED');
 const source=await readLocked(tx,actor,'assignments',String(data.sourceAssignmentId),'UPDATE');
 const demand=await readLocked(tx,actor,'demands',String(data.demandId),'UPDATE');
 invariant(source.version===Number(data.sourceVersion)&&demand.version===Number(data.destinationVersion),'STALE_MOVEMENT_BASELINE',409);
 invariant(source.orgId===data.sourceOrgId&&demand.orgId===data.destinationOrgId&&source.workerId===proposal.workerId,'MOVEMENT_SCOPE_MISMATCH');
 invariant(['approved','partially-filled','sourcing'].includes(demand.state),'APPROVED_DEMAND_REQUIRED');
 invariant(source.validFrom<=proposal.validFrom&&(!source.validTo||source.validTo>=proposal.validTo),'MOVEMENT_OUTSIDE_SOURCE_DATES');
 const quantity=Number(data.fte),sourceFte=Number(source.data.fte);invariant(quantity>0&&quantity<=sourceFte,'INSUFFICIENT_SOURCE_ALLOCATION');
 const contract=(await tx.query("SELECT data FROM contracts WHERE tenant_id=$1 AND worker_id=$2 AND valid_from<=$3 AND (valid_to IS NULL OR valid_to>=$4) AND state<>'archived' FOR UPDATE",[actor.tenantId,proposal.workerId,proposal.validFrom,proposal.validTo])).rows[0];
 invariant(contract?.data.movable===true&&contract.data.confirmedOn,'MANAGER_CAPACITY_CONFIRMATION_REQUIRED');
 const leave=await tx.query("SELECT 1 FROM availability WHERE tenant_id=$1 AND worker_id=$2 AND state<>'archived' AND data->>'approved'='true' AND (data->>'fraction')::numeric>0 AND daterange(valid_from,valid_to,'[)') && daterange($3::date,$4::date,'[)')",[actor.tenantId,proposal.workerId,proposal.validFrom,proposal.validTo]);invariant(!leave.rowCount,'LEAVE_OR_CONSTRAINT_REQUIRES_REVISED_PROPOSAL');
 const supply=quantity*Number(contract.data.fte);
 const priorFills=(await tx.query("SELECT COALESCE(sum((data->>'fte')::numeric),0) fte FROM fulfillments WHERE tenant_id=$1 AND data->>'demandId'=$2 AND data->>'approved'='true' AND state<>'archived' AND daterange(valid_from,valid_to,'[)') && daterange($3::date,$4::date,'[)')",[actor.tenantId,demand.id,proposal.validFrom,proposal.validTo])).rows[0];
 invariant(Number(priorFills.fte)+supply<=Number(demand.data.fte),'DEMAND_OVERFULFILLMENT');
 if(source.validFrom<proposal.validFrom)await mutateRecord(actor,'assignments',{operation:'UPDATE',id:source.id,version:source.version,validTo:proposal.validFrom},tx);
 else await mutateRecord(actor,'assignments',{operation:'ARCHIVE',id:source.id,version:source.version},tx);
 const make=(orgId:string|null,from:string,to:string|null,fte:number,kind:string)=>mutateRecord(actor,'assignments',{operation:'CREATE',orgId,workerId:source.workerId,validFrom:from,validTo:to,data:{...source.data,roleId:orgId===data.destinationOrgId?data.roleId:source.data.roleId,fte,kind,movementId:proposal.id,allocationStatus:'committed'}},tx);
 if(sourceFte>quantity)await make(source.orgId,proposal.validFrom,proposal.validTo,sourceFte-quantity,String(source.data.kind));
 await make(String(data.destinationOrgId),proposal.validFrom,proposal.validTo,quantity,'loan');
 if(!source.validTo||source.validTo>proposal.validTo)await make(source.orgId,proposal.validTo,source.validTo,sourceFte,String(source.data.kind));
 await mutateRecord(actor,'fulfillments',{operation:'CREATE',orgId:demand.orgId,workerId:source.workerId,validFrom:proposal.validFrom,validTo:proposal.validTo,data:{demandId:demand.id,fte:supply,kind:String(data.kind)==='loan'?'loan':'transfer',approved:true,movementId:proposal.id}},tx);
 await revision(tx,actor,'demands',demand,Number(priorFills.fte)+supply===Number(demand.data.fte)?'filled':'partially-filled','FULFILL');
 const committed=await revision(tx,actor,'movements',proposal,'committed','COMMIT');return {record:committed,impact:movementImpact(supply)};
}
async function captureBaseline(tx:DbClient,actor:Actor,scenario:RecordRow){
 const deltas=(await tx.query("SELECT * FROM scenario_deltas WHERE tenant_id=$1 AND data->>'scenarioId'=$2 AND state<>'archived' ORDER BY id FOR UPDATE",[actor.tenantId,scenario.id])).rows.map(recordRow);
 invariant(deltas.length>0,'SCENARIO_HAS_NO_CHANGES');
 await tx.query('DELETE FROM scenario_baselines WHERE tenant_id=$1 AND scenario_id=$2',[actor.tenantId,scenario.id]);
 for(const delta of deltas){await assertPermission(actor,'scenario-deltas','READ',delta.orgId,undefined,tx,delta.validFrom,delta.workerId);const domain=String(delta.data.domain);await assertPermission(actor,domain,String(delta.data.operation),delta.orgId,undefined,tx,delta.validFrom,delta.workerId);if(delta.data.targetId){const target=await readLocked(tx,actor,domain,String(delta.data.targetId));invariant(target.version===Number(delta.data.targetVersion),'STALE_SCENARIO_BASELINE',409);await tx.query('INSERT INTO scenario_baselines(tenant_id,scenario_id,domain,record_id,version,snapshot) VALUES($1,$2,$3,$4,$5,$6)',[actor.tenantId,scenario.id,domain,target.id,target.version,target]);}}
 const fingerprint=createHash('sha256').update(JSON.stringify(deltas.map(d=>[d.id,d.version,d.data]))).digest('hex');scenario.data={...scenario.data,baselineHash:fingerprint};
}
async function commitScenario(tx:DbClient,actor:Actor,scenario:RecordRow){
 const deltas=(await tx.query("SELECT * FROM scenario_deltas WHERE tenant_id=$1 AND data->>'scenarioId'=$2 AND state<>'archived' ORDER BY id FOR UPDATE",[actor.tenantId,scenario.id])).rows.map(recordRow);
 const fingerprint=createHash('sha256').update(JSON.stringify(deltas.map(d=>[d.id,d.version,d.data]))).digest('hex');invariant(fingerprint===scenario.data.baselineHash,'SCENARIO_CHANGED_AFTER_APPROVAL',409);
 for(const delta of deltas){const domain=String(delta.data.domain);if(delta.data.targetId){const current=await readLocked(tx,actor,domain,String(delta.data.targetId));invariant(current.version===Number(delta.data.targetVersion),'STALE_SCENARIO_BASELINE',409);}const payload=JSON.parse(String(delta.data.payload));await mutateRecord(actor,domain,{...payload,operation:String(delta.data.operation) as MutationInput['operation'],id:delta.data.targetId?String(delta.data.targetId):undefined,version:delta.data.targetVersion?Number(delta.data.targetVersion):undefined,orgId:delta.orgId,workerId:delta.workerId,validFrom:delta.validFrom,validTo:delta.validTo},tx);}
 return revision(tx,actor,'scenarios',scenario,'committed','COMMIT');
}
async function forkScenario(tx:DbClient,actor:Actor,row:RecordRow,name?:string){invariant(row.data.scenarioVersion!==undefined,'SCENARIO_REQUIRED');const fork=await mutateRecord(actor,'scenarios',{operation:'CREATE',orgId:row.orgId,validFrom:row.validFrom,validTo:row.validTo,data:{...row.data,name:name??String(row.data.name)+' — copy',parentId:row.id,baselineHash:undefined,scenarioVersion:1}},tx);const deltas=(await tx.query("SELECT * FROM scenario_deltas WHERE tenant_id=$1 AND data->>'scenarioId'=$2 AND state<>'archived'",[actor.tenantId,row.id])).rows.map(recordRow);for(const delta of deltas)await mutateRecord(actor,'scenario-deltas',{operation:'CREATE',orgId:delta.orgId,workerId:delta.workerId,validFrom:delta.validFrom,validTo:delta.validTo,data:{...delta.data,scenarioId:fork.id}},tx);return fork;}
async function scenarioComparison(tx:DbClient,actor:Actor,row:RecordRow){const deltas=(await tx.query("SELECT * FROM scenario_deltas WHERE tenant_id=$1 AND data->>'scenarioId'=$2 AND state<>'archived' ORDER BY id",[actor.tenantId,row.id])).rows.map(recordRow);const changes=[];for(const delta of deltas){const domain=String(delta.data.domain);await assertPermission(actor,domain,'READ',delta.orgId,undefined,tx,delta.validFrom,delta.workerId);const before=delta.data.targetId?await readLocked(tx,actor,domain,String(delta.data.targetId)):null;changes.push({domain,before,proposed:JSON.parse(String(delta.data.payload)),assumptions:delta.data.assumptions,liveChanged:false});}return {scenario:row,changes};}
export async function revealIdentity(actor:Actor,revealId:string){return transaction(actor.tenantId,async tx=>{const reveal=await readLocked(tx,actor,'reveals',revealId);invariant(reveal.state==='approved'&&reveal.data.requesterId===actor.userId&&String(reveal.data.expiresOn)>today(),'REVEAL_NOT_AUTHORIZED',403);const result=await tx.query("SELECT * FROM identities WHERE tenant_id=$1 AND worker_id=$2 AND state<>'archived'",[actor.tenantId,reveal.workerId]);await audit(tx,actor,'IDENTITY_REVEAL','identities',reveal.workerId);return {rows:result.rows.map(recordRow),expiresOn:reveal.data.expiresOn};});}
