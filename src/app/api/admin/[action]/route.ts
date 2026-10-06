import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin,getActor } from '@/lib/auth';
import { transaction } from '@/lib/db';
import { assertPermission } from '@/lib/policy';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/jobs';
import { testGraphConnection } from '@/lib/graph/worker';
import { AppError } from '@/lib/errors';
import { domains } from '@/lib/registry';
import { approveSensitiveAccess,queueSensitiveAccess,sensitiveAccess } from '@/lib/graph/admin-access';
const scope=z.enum(['tenant','org','subtree','reports']);
const operation=z.enum(['READ','CREATE','UPDATE','ARCHIVE','RESTORE','IMPORT','EXPORT','APPROVE','ADMIN','REVEAL']);
const access={domain:z.string().refine(x=>Boolean(domains[x])),operation,dataClass:z.string(),orgId:z.string().uuid().nullable().default(null),scope};
const grantSchema=z.object({...access,principalId:z.string().uuid(),validFrom:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),validTo:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null)}).strict();
const mappingSchema=z.object({...access,groupId:z.string().uuid().nullable().default(null),appRole:z.string().min(1).max(120).nullable().default(null)}).strict().refine(x=>Boolean(x.groupId)!==Boolean(x.appRole));
function fail(error:unknown){
 if(error instanceof AppError)return NextResponse.json({error:{code:error.code,message:error.message}},{status:error.status,headers:{'Cache-Control':'no-store'}});
 if(error instanceof z.ZodError)return NextResponse.json({error:{code:'INVALID_INPUT',message:'Invalid administration input.'}},{status:400});
 return NextResponse.json({error:{code:'ADMIN_FAILED',message:'The administration operation could not be completed.'}},{status:500});
}
export async function GET(_request:Request,context:{params:Promise<{action:string}>}){
 try{
  const actor=await getActor();await assertPermission(actor,'settings','ADMIN',null,'configuration');
  if((await context.params).action!=='settings')throw new AppError(404,'NOT_FOUND');
  const data=await transaction(actor.tenantId,async tx=>({
   connection:(await tx.query('SELECT * FROM sync_connections WHERE tenant_id=$1',[actor.tenantId])).rows[0]??null,
   runs:(await tx.query('SELECT * FROM sync_runs WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 30',[actor.tenantId])).rows,
   mappings:(await tx.query('SELECT * FROM group_mappings WHERE tenant_id=$1',[actor.tenantId])).rows,
   grants:(await tx.query('SELECT * FROM access_grants WHERE tenant_id=$1',[actor.tenantId])).rows,
   departmentMappings:(await tx.query('SELECT * FROM graph_department_mappings WHERE tenant_id=$1',[actor.tenantId])).rows,
   accessRequests:(await tx.query('SELECT * FROM sensitive_access_requests WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[actor.tenantId])).rows
  }));return NextResponse.json(data,{headers:{'Cache-Control':'no-store'}});
 }catch(error){return fail(error);}
}
export async function POST(request:Request,context:{params:Promise<{action:string}>}){
 try{
  assertSameOrigin(request);const actor=await getActor();await assertPermission(actor,'settings','ADMIN',null,'configuration');
  const {action}=await context.params;const body=await request.json();
  if(action==='connection-test'){await testGraphConnection(actor.tenantId);return NextResponse.json({ok:true});}
  const result=await transaction(actor.tenantId,async tx=>{
   await assertPermission(actor,'settings','ADMIN',null,'configuration',tx);
   if(action==='settings'){
    const value=z.object({enabled:z.boolean(),includeGuests:z.boolean().default(false),inclusionGroups:z.array(z.string().uuid()).max(100).default([])}).strict().parse(body);
    await tx.query(`INSERT INTO sync_connections(tenant_id,enabled,paused,include_guests,inclusion_groups) VALUES($1,$2,true,$3,$4)
     ON CONFLICT(tenant_id) DO UPDATE SET enabled=$2,paused=true,include_guests=$3,inclusion_groups=$4,updated_at=now()`,[actor.tenantId,value.enabled,value.includeGuests,JSON.stringify(value.inclusionGroups)]);
    await tx.query(`DELETE FROM sync_checkpoints WHERE tenant_id=$1 AND stream='users'`,[actor.tenantId]);
   }else if(action==='department-mapping'){
    const value=z.object({department:z.string().min(1).max(256),orgId:z.string().uuid()}).strict().parse(body);
    await assertPermission(actor,'org-units','ADMIN',value.orgId,'planning',tx);
    await tx.query(`INSERT INTO graph_department_mappings(tenant_id,department,org_id) VALUES($1,$2,$3) ON CONFLICT(tenant_id,department) DO UPDATE SET org_id=$3`,[actor.tenantId,value.department,value.orgId]);
    await tx.query(`DELETE FROM sync_checkpoints WHERE tenant_id=$1 AND stream='users'`,[actor.tenantId]);
   }else if(action==='pause'||action==='resume'){
    await tx.query('UPDATE sync_connections SET paused=$2,updated_at=now() WHERE tenant_id=$1',[actor.tenantId,action==='pause']);
   }else if(['sync','manager-refresh','group-refresh'].includes(action)){
    const id=await enqueue(tx,actor,action==='sync'?'graph.sync':action==='manager-refresh'?'graph.managers':'graph.groups',{});
    await audit(tx,actor,action,'settings',id);return {jobId:id};
   }else if(action==='mappings'||action==='grants'){
    const value=action==='mappings'?mappingSchema.parse(body):grantSchema.parse(body);
    if((value.scope==='tenant')!==(value.orgId===null)||value.dataClass!==domains[value.domain].dataClass)throw new AppError(400,'INVALID_SCOPE');
    await assertPermission(actor,value.domain,'ADMIN',value.orgId,value.dataClass,tx);
    if('principalId' in value&&value.validTo&&value.validTo<=value.validFrom)throw new AppError(400,'INVALID_DATES');
    if(sensitiveAccess(value)){const requestId=await queueSensitiveAccess(tx,actor,action as 'mappings'|'grants',value);return {requestId,status:'pending',requiresIndependentApproval:true};}
    if('principalId' in value){
     if(value.validTo&&value.validTo<=value.validFrom)throw new AppError(400,'INVALID_DATES');
     const principal=await tx.query('SELECT id FROM principals WHERE tenant_id=$1 AND id=$2',[actor.tenantId,value.principalId]);if(!principal.rowCount)throw new AppError(404,'PRINCIPAL_NOT_FOUND');
     await tx.query(`INSERT INTO access_grants(id,tenant_id,principal_id,domain,operation,data_class,org_id,scope,valid_from,valid_to,source) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,'manual')`,[actor.tenantId,value.principalId,value.domain,value.operation,value.dataClass,value.orgId,value.scope,value.validFrom,value.validTo]);
    }else await tx.query(`INSERT INTO group_mappings(id,tenant_id,group_id,app_role,domain,operation,data_class,org_id,scope,enabled) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,true)`,[actor.tenantId,value.groupId,value.appRole,value.domain,value.operation,value.dataClass,value.orgId,value.scope]);
   }else if(action==='approve-access'){
    const {requestId}=z.object({requestId:z.string().uuid()}).strict().parse(body);
    await approveSensitiveAccess(tx,actor,requestId);return {ok:true};
   }else if(action==='revoke'){
    const value=z.object({principalId:z.string().uuid().optional(),grantId:z.string().uuid().optional(),mappingId:z.string().uuid().optional()}).strict().refine(x=>Number(Boolean(x.principalId))+Number(Boolean(x.grantId))+Number(Boolean(x.mappingId))===1).parse(body);
    if(value.principalId){await tx.query('DELETE FROM access_grants WHERE tenant_id=$1 AND principal_id=$2',[actor.tenantId,value.principalId]);await tx.query('UPDATE principals SET enabled=false,auth_version=auth_version+1 WHERE tenant_id=$1 AND id=$2',[actor.tenantId,value.principalId]);await tx.query('DELETE FROM sessions WHERE tenant_id=$1 AND principal_id=$2',[actor.tenantId,value.principalId]);}
    if(value.grantId){
     await tx.query(`UPDATE principals SET auth_version=auth_version+1 WHERE tenant_id=$1 AND id IN(SELECT principal_id FROM access_grants WHERE tenant_id=$1 AND id=$2)`,[actor.tenantId,value.grantId]);
     await tx.query('DELETE FROM access_grants WHERE tenant_id=$1 AND id=$2',[actor.tenantId,value.grantId]);
    }
    if(value.mappingId){
     await tx.query(`UPDATE principals SET auth_version=auth_version+1 WHERE tenant_id=$1 AND id IN(SELECT principal_id FROM access_grants WHERE tenant_id=$1 AND source_key=$2 AND source IN ('group','role'))`,[actor.tenantId,value.mappingId]);
     await tx.query('UPDATE group_mappings SET enabled=false WHERE tenant_id=$1 AND id=$2',[actor.tenantId,value.mappingId]);
     await tx.query("DELETE FROM access_grants WHERE tenant_id=$1 AND source_key=$2 AND source IN ('group','role')",[actor.tenantId,value.mappingId]);
    }
    await tx.query(`DELETE FROM sessions s USING principals p WHERE s.tenant_id=$1 AND p.tenant_id=s.tenant_id AND p.id=s.principal_id AND s.auth_version<>p.auth_version`,[actor.tenantId]);
   }else if(action==='simulate'){
    const value=z.object({domain:z.string(),operation:z.string(),orgId:z.string().uuid().nullable(),dataClass:z.string()}).strict().parse(body);
    await assertPermission(actor,value.domain,value.operation,value.orgId,value.dataClass,tx);return {allowed:true};
   }else throw new AppError(404,'NOT_FOUND');
   await audit(tx,actor,action,'settings',null);return {ok:true};
  });return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}});
 }catch(error){return fail(error);}
}
