import { randomUUID } from 'node:crypto';
import { transaction, type DbClient } from '../db';
import type { Actor } from '../types';
import { datedSource, recordRow, today } from '../records';
import { audit } from '../audit';
import { domains } from '../registry';
import { assertPermission } from '../policy';
import { resolveDirectoryFields, type DirectoryOverride, type DirectoryFieldPolicy } from './ownership';

/** Only approved department mappings create workers. Names and email never serve as identity keys. */
export async function projectDirectoryAccount(tx:DbClient,tenantId:string,objectId:string,actor:Actor):Promise<void>{
 const row=(await tx.query('SELECT * FROM graph_directory_projection WHERE tenant_id=$1 AND object_id=$2',[tenantId,objectId])).rows[0];
 if(!row)return;
 let linkedNow=false;
 let link=(await tx.query('SELECT * FROM graph_object_links WHERE tenant_id=$1 AND object_id=$2 FOR UPDATE',[tenantId,objectId])).rows[0];
 if(!link){
  const existing=(await tx.query("SELECT id FROM directory_accounts WHERE tenant_id=$1 AND data->>'objectId'=$2",[tenantId,objectId])).rows[0];
  if(existing){await reconcile(tx,tenantId,objectId,'EXISTING_DIRECTORY_REQUIRES_STEWARD_LINK',actor);return;}
  if(!row.active)return;
  const directoryId=randomUUID();
  await tx.query(`INSERT INTO directory_accounts(id,tenant_id,data) VALUES($1,$2,$3)`,[directoryId,tenantId,JSON.stringify({objectId,enabled:row.account_enabled,userType:row.user_type,directoryTitle:row.job_title??'',directoryDepartment:row.department??'',lastSeen:new Date().toISOString().slice(0,10)})]);
  await snapshot(tx,actor,'directory-accounts',directoryId,objectId);
  await tx.query(`INSERT INTO graph_object_links(tenant_id,object_id,directory_id) VALUES($1,$2,$3)`,[tenantId,objectId,directoryId]);
  link={directory_id:directoryId,worker_id:null,identity_id:null};
 }
 if(!link.worker_id&&row.active){
  const mapping=(await tx.query(`SELECT m.org_id FROM graph_department_mappings m JOIN org_units o ON o.tenant_id=m.tenant_id AND o.id=m.org_id
   WHERE m.tenant_id=$1 AND m.department=$2 AND o.state<>'archived' AND o.valid_from<=CURRENT_DATE AND (o.valid_to IS NULL OR o.valid_to>CURRENT_DATE)`,[tenantId,row.department])).rows[0];
  if(!mapping){await reconcile(tx,tenantId,objectId,'UNMAPPED_DIRECTORY_DEPARTMENT',actor);}
  else{
   const workerId=randomUUID();const identityId=randomUUID();
   await tx.query(`INSERT INTO workers(id,tenant_id,org_id,data) VALUES($1,$2,$3,$4)`,[workerId,tenantId,mapping.org_id,JSON.stringify({code:`WI-${workerId.toUpperCase()}`,workerType:'manual-only',employmentStatus:'active',homeOrgId:mapping.org_id})]);
   await snapshot(tx,actor,'workers',workerId,objectId);
   await tx.query(`INSERT INTO identities(id,tenant_id,org_id,worker_id,data) VALUES($1,$2,$3,$4,$5)`,[identityId,tenantId,mapping.org_id,workerId,JSON.stringify({displayName:row.display_name??'Directory account',email:row.mail??'',upn:row.user_principal_name??''})]);
   await snapshot(tx,actor,'identities',identityId,objectId);
   await tx.query(`UPDATE graph_object_links SET worker_id=$3,identity_id=$4 WHERE tenant_id=$1 AND object_id=$2`,[tenantId,objectId,workerId,identityId]);
   await tx.query('UPDATE directory_accounts SET worker_id=$3,org_id=$4 WHERE tenant_id=$1 AND id=$2',[tenantId,link.directory_id,workerId,mapping.org_id]);
   link.worker_id=workerId;
   linkedNow=true;
   const resolved=await tx.query(`UPDATE reconciliation SET state='resolved',version=version+1,updated_at=now() WHERE tenant_id=$1 AND data->>'sourceKey'=$2 AND data->>'reason'='UNMAPPED_DIRECTORY_DEPARTMENT' AND state='active' RETURNING id`,[tenantId,objectId]);
   for(const item of resolved.rows)await snapshot(tx,actor,'reconciliation',item.id,objectId);
  }
 }
 // Existing worker/identity fields remain application-owned after initial creation.
 await applyDirectoryFields(tx,actor,objectId,link.directory_id,linkedNow);
}
/** The raw upstream projection is never replaced by an override. */
export async function applyDirectoryFields(tx:DbClient,actor:Actor,objectId:string,directoryId:string,forceRevision=false):Promise<void>{
 const date=today();
 const projection=(await tx.query('SELECT * FROM graph_directory_projection WHERE tenant_id=$1 AND object_id=$2',[actor.tenantId,objectId])).rows[0];
 const currentRaw=(await tx.query(`SELECT * FROM directory_accounts WHERE tenant_id=$1 AND id=$2 AND state<>'archived'
  AND valid_from<=$3::date AND (valid_to IS NULL OR valid_to>$3::date) FOR UPDATE`,[actor.tenantId,directoryId,date])).rows[0];
 if(!projection||!currentRaw)return;
 const current=recordRow(currentRaw);
 const policies=(await tx.query(`SELECT data FROM ${datedSource('field-policies')} p WHERE tenant_id=$1 AND data->>'domain'='directory-accounts'
  AND state='active' AND valid_from<=$2::date AND (valid_to IS NULL OR valid_to>$2::date)
  AND (org_id IS NULL OR org_id=$3::uuid) AND (worker_id IS NULL OR worker_id=$4::uuid)
  ORDER BY (worker_id IS NOT NULL) DESC,(org_id IS NOT NULL) DESC,valid_from DESC,version DESC,id`,[actor.tenantId,date,current.orgId,current.workerId])).rows.map(row=>row.data as DirectoryFieldPolicy);
 const overrideRows=(await tx.query(`SELECT o.* FROM ${datedSource('overrides')} o WHERE tenant_id=$1 AND data->>'domain'='directory-accounts'
  AND data->>'recordId'=$3 AND org_id IS NOT DISTINCT FROM $4::uuid AND (worker_id IS NULL OR worker_id=$5::uuid)
  AND state='approved' ORDER BY valid_from DESC,version DESC,id`,[actor.tenantId,date,directoryId,current.orgId,current.workerId])).rows;
 const overrides:DirectoryOverride[]=overrideRows.map(raw=>{const row=recordRow(raw);return {id:row.id,state:row.state,validFrom:row.validFrom,validTo:row.validTo,field:String(row.data.field),value:row.data.value,expiresOn:String(row.data.expiresOn),reason:String(row.data.reason??'')};});
 const lastSeen=projection.updated_at instanceof Date?projection.updated_at.toISOString().slice(0,10):String(projection.updated_at).slice(0,10);
 const source={enabled:projection.account_enabled&&projection.active,userType:projection.user_type,directoryTitle:projection.job_title??'',directoryDepartment:projection.department??'',lastSeen};
 const resolution=resolveDirectoryFields(current.data,source,domains['directory-accounts'].fields,policies,overrides,date);
 const changed=Object.keys(resolution.data).filter(field=>!Object.is(current.data[field],resolution.data[field]));
 if(changed.length||forceRevision){
  await tx.query(`UPDATE directory_accounts SET data=$3,valid_from=$4::date,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2`,[actor.tenantId,directoryId,resolution.data,date]);
  await snapshot(tx,actor,'directory-accounts',directoryId,objectId,[]);
 }
 const prior=(await tx.query(`SELECT field,override_id FROM field_provenance WHERE tenant_id=$1 AND domain='directory-accounts' AND record_id=$2`,[actor.tenantId,directoryId])).rows;
 for(const [field,value]of Object.entries(resolution.provenance)){
  const old=prior.find(row=>row.field===field);
  if(!changed.includes(field)&&old&&old.override_id===value.overrideId)continue;
  await tx.query(`INSERT INTO field_provenance(tenant_id,domain,record_id,field,owner,source_key,actor_id,override_id,confidence)
   VALUES($1,'directory-accounts',$2,$3,'Entra',$4,$5,$6,$7) ON CONFLICT(tenant_id,domain,record_id,field)
   DO UPDATE SET owner='Entra',source_key=$4,actor_id=$5,override_id=$6,confidence=$7,seen_at=now()`,[actor.tenantId,directoryId,field,objectId,actor.userId,value.overrideId,value.overrideId?'approved-override':'verified']);
  if(value.overrideId&&old?.override_id!==value.overrideId)await audit(tx,actor,'GRAPH_OVERRIDE_APPLIED','overrides',value.overrideId,{fields:[field]});
  if(old?.override_id&&!value.overrideId)await audit(tx,actor,'GRAPH_OVERRIDE_ENDED','overrides',old.override_id,{fields:[field]});
 }
 for(const issue of resolution.issues)await reconcileFieldIssue(tx,actor,objectId,directoryId,current.orgId,current.workerId,issue.field,issue.reason,issue.overrideId);
}
async function reconcileFieldIssue(tx:DbClient,actor:Actor,objectId:string,directoryId:string,orgId:string|null,workerId:string|null,field:string,reason:string,overrideId?:string){
 const reasonCode=`${reason}:${field}`;const sourceKey=overrideId??objectId;
 // Keep resolved expiry events deduplicated; mutable ownership conflicts may reopen after a steward's review.
 const expiry=reason.includes('EXPIRED');
 const created=await tx.query(`INSERT INTO reconciliation(tenant_id,org_id,worker_id,data) SELECT $1,$2,$3,$4::jsonb WHERE NOT EXISTS
  (SELECT 1 FROM reconciliation WHERE tenant_id=$1 AND data->>'sourceKey'=$5 AND data->>'recordId'=$6 AND data->>'reason'=$7 AND ($8 OR state='active')) RETURNING id`,
 [actor.tenantId,orgId,workerId,JSON.stringify({kind:'directory-field',domain:'directory-accounts',recordId:directoryId,reason:reasonCode,sourceKey}),sourceKey,directoryId,reasonCode,expiry]);
 for(const row of created.rows)await snapshot(tx,actor,'reconciliation',row.id,sourceKey);
}
/** Revisit override targets after every successful sync, including unchanged delta rounds. */
export async function sweepDirectoryOverrides(actor:Actor):Promise<number>{
 let cursor='00000000-0000-0000-0000-000000000000';let count=0;
 for(;;){
  const batch=await transaction(actor.tenantId,async tx=>{
   await assertPermission(actor,'settings','ADMIN',null,'configuration',tx);
   const connection=(await tx.query('SELECT enabled,paused FROM sync_connections WHERE tenant_id=$1',[actor.tenantId])).rows[0];
   if(!connection?.enabled||connection.paused)throw new Error('Connector paused during override sweep');
   const rows=(await tx.query(`SELECT l.object_id,l.directory_id FROM graph_object_links l WHERE l.tenant_id=$1 AND l.object_id>$2::uuid
    AND (EXISTS(SELECT 1 FROM overrides o WHERE o.tenant_id=l.tenant_id AND o.data->>'domain'='directory-accounts' AND o.data->>'recordId'=l.directory_id::text)
      OR EXISTS(SELECT 1 FROM field_provenance p WHERE p.tenant_id=l.tenant_id AND p.domain='directory-accounts' AND p.record_id=l.directory_id AND p.override_id IS NOT NULL))
    ORDER BY l.object_id LIMIT 200`,[actor.tenantId,cursor])).rows;
   for(const row of rows)await applyDirectoryFields(tx,actor,row.object_id,row.directory_id);
   return rows;
  });
  if(!batch.length)return count;
  cursor=batch[batch.length-1].object_id;count+=batch.length;
 }
}
async function reconcile(tx:DbClient,tenantId:string,objectId:string,reason:string,actor:Actor){
 const created=await tx.query(`INSERT INTO reconciliation(tenant_id,data) SELECT $1,$2::jsonb WHERE NOT EXISTS
  (SELECT 1 FROM reconciliation WHERE tenant_id=$1 AND data->>'sourceKey'=$3 AND data->>'reason'=$4 AND state='active') RETURNING id`,
 [tenantId,JSON.stringify({kind:'directory-link',domain:'directory-accounts',reason,sourceKey:objectId}),objectId,reason]);
 for(const item of created.rows)await snapshot(tx,actor,'reconciliation',item.id,objectId);
}
export async function snapshot(tx:DbClient,actor:Actor,domain:'workers'|'identities'|'directory-accounts'|'reconciliation',id:string,sourceKey:string,provenanceFields?:string[]){
 const table=domain.replaceAll('-','_');
 const row=recordRow((await tx.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2`,[actor.tenantId,id])).rows[0]);
 await tx.query(`INSERT INTO record_history(tenant_id,domain,record_id,version,snapshot,actor_id) VALUES($1,$2,$3,$4,$5,$6)`,[actor.tenantId,domain,id,row.version,row,actor.userId]);
 await tx.query(`INSERT INTO field_provenance(tenant_id,domain,record_id,field,owner,source_key,actor_id)
  SELECT $1,$2,$3,field,$5,$6,$7 FROM unnest($4::text[]) field
  ON CONFLICT(tenant_id,domain,record_id,field) DO UPDATE SET source_key=$6,seen_at=now(),actor_id=$7`,[actor.tenantId,domain,id,provenanceFields??Object.keys(row.data),domain==='directory-accounts'?'Entra':'application',sourceKey,actor.userId]);
 await audit(tx,actor,'GRAPH_SYNC',domain,id,{version:row.version,fields:Object.keys(row.data)});
}
