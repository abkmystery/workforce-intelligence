import type { DbClient } from '../db';
import type { Actor } from '../types';
import { AppError } from '../errors';
import { assertPermission } from '../policy';
import { audit } from '../audit';
export type AccessValue={domain:string;operation:string;dataClass:string;orgId:string|null;scope:string;
 principalId?:string;validFrom?:string;validTo?:string|null;groupId?:string|null;appRole?:string|null};
export const sensitiveAccess=(value:AccessValue)=>['identity','salary','cost'].includes(value.dataClass);
export async function queueSensitiveAccess(tx:DbClient,actor:Actor,kind:'grants'|'mappings',value:AccessValue):Promise<string>{
 const row=(await tx.query(`INSERT INTO sensitive_access_requests(tenant_id,kind,payload,requested_by) VALUES($1,$2,$3,$4) RETURNING id`,[actor.tenantId,kind,JSON.stringify(value),actor.userId])).rows[0];
 await audit(tx,actor,'REQUEST_ACCESS','settings',row.id);return row.id;
}
export async function approveSensitiveAccess(tx:DbClient,actor:Actor,requestId:string):Promise<void>{
 const request=(await tx.query(`SELECT * FROM sensitive_access_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[actor.tenantId,requestId])).rows[0];
 if(!request||request.state!=='pending')throw new AppError(409,'ACCESS_REQUEST_NOT_PENDING');
 if(request.requested_by===actor.userId)throw new AppError(403,'INDEPENDENT_APPROVER_REQUIRED');
 const value=request.payload as AccessValue;
 await assertPermission(actor,value.domain,'ADMIN',value.orgId,value.dataClass,tx);
 if(request.kind==='grants'){
  if(value.principalId===actor.userId)throw new AppError(403,'SELF_APPROVAL_FORBIDDEN');
  await tx.query(`INSERT INTO access_grants(id,tenant_id,principal_id,domain,operation,data_class,org_id,scope,valid_from,valid_to,source)
   VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,'manual')`,[actor.tenantId,value.principalId,value.domain,value.operation,value.dataClass,value.orgId,value.scope,value.validFrom,value.validTo]);
 }else{
  if(value.appRole&&actor.roles.includes(value.appRole))throw new AppError(403,'SELF_APPROVAL_FORBIDDEN');
  if(value.groupId){
   const member=await tx.query(`SELECT 1 FROM graph_group_memberships g JOIN principals p ON p.tenant_id=g.tenant_id AND p.entra_object_id=g.object_id
    WHERE g.tenant_id=$1 AND g.group_id=$2 AND p.id=$3`,[actor.tenantId,value.groupId,actor.userId]);
   const fresh=await tx.query(`SELECT 1 FROM sync_checkpoints WHERE tenant_id=$1 AND stream=$2
    AND next_url IS NULL AND full_scan=false AND updated_at>now()-interval '15 minutes'`,[actor.tenantId,`group:${value.groupId}`]);
   if(!fresh.rowCount)throw new AppError(409,'ENTITLEMENTS_REFRESH_REQUIRED');
   if(member.rowCount)throw new AppError(403,'SELF_APPROVAL_FORBIDDEN');
  }
  await tx.query(`INSERT INTO group_mappings(id,tenant_id,group_id,app_role,domain,operation,data_class,org_id,scope,enabled)
   VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,true)`,[actor.tenantId,value.groupId,value.appRole,value.domain,value.operation,value.dataClass,value.orgId,value.scope]);
 }
 await tx.query(`UPDATE sensitive_access_requests SET state='approved',approved_by=$3,decided_at=now() WHERE tenant_id=$1 AND id=$2`,[actor.tenantId,requestId,actor.userId]);
 await audit(tx,actor,'APPROVE_ACCESS','settings',requestId);
}
