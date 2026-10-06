import type {Actor} from './types';
import type {DbClient} from './db';
import {transaction} from './db';
import {domains} from './registry';
import {AppError} from './errors';
import {effectiveRows} from './dating';
export function matchingGrants(actor:Actor,domain:string,operation:string,dataClass=domains[domain]?.dataClass??'configuration'){
 const today=new Date().toISOString().slice(0,10);
 return actor.grants.filter(g=>(g.domain===domain||g.domain==='*')&&(g.operation.toLowerCase()===operation.toLowerCase()||g.operation==='*')&&g.dataClass===dataClass&&g.validFrom<=today&&(!g.validTo||g.validTo>today));
}
export async function assertFresh(actor:Actor,tx:DbClient){const {rows}=await tx.query('SELECT enabled,auth_version FROM principals WHERE tenant_id=$1 AND id=$2',[actor.tenantId,actor.userId]);if(!rows[0]?.enabled||rows[0].auth_version!==actor.authVersion)throw new AppError(401,'AUTHORIZATION_EXPIRED');}
export function scopePredicate(actor:Actor,domain:string,operation:string,alias:string,values:unknown[],date:string,dataClass?:string):string{
 const grants=matchingGrants(actor,domain,operation,dataClass);
 if(!grants.length)return 'FALSE';
 const p=(v:unknown)=>{values.push(v);return '$'+values.length;};
 return '('+grants.map(g=>{
  if(g.scope==='tenant')return 'TRUE';
  if(g.scope==='org')return alias+'.org_id='+p(g.orgId)+'::uuid';
  const root=p(g.orgId),asOf=p(date),tenant=p(actor.tenantId);
  // Tenant is fixed by the authenticated actor and RLS. An outer-row correlation
  // here would recompute the entire hierarchy for every returned business row.
  if(g.scope==='subtree')return `${alias}.org_id IN (WITH RECURSIVE tree(id,path) AS (SELECT ${root}::uuid,ARRAY[${root}::uuid] UNION ALL SELECT (e.data->>'childId')::uuid,t.path||(e.data->>'childId')::uuid FROM ${effectiveRows('org-edges',tenant,asOf)} e JOIN tree t ON (e.data->>'parentId')::uuid=t.id WHERE e.tenant_id=${tenant}::uuid AND e.data->>'hierarchy'='primary' AND e.state<>'archived' AND (e.valid_to IS NULL OR e.valid_to>${asOf}::date) AND NOT (e.data->>'childId')::uuid=ANY(t.path)) SELECT id FROM tree)`;
  return `${alias}${domain==='workers'?'.id':'.worker_id'} IN (WITH RECURSIVE reports(id,path) AS (SELECT ${root}::uuid,ARRAY[${root}::uuid] UNION ALL SELECT r.worker_id,t.path||r.worker_id FROM ${effectiveRows('reporting-lines',tenant,asOf)} r JOIN reports t ON (r.data->>'managerId')::uuid=t.id WHERE r.tenant_id=${tenant}::uuid AND r.state<>'archived' AND (r.valid_to IS NULL OR r.valid_to>${asOf}::date) AND NOT r.worker_id=ANY(t.path)) SELECT id FROM reports WHERE id<>${root}::uuid)`;
 }).join(' OR ')+')';
}
export async function assertPermission(actor:Actor,domain:string,operation:string,orgId:string|null,dataClass?:string,tx?:DbClient,date=new Date().toISOString().slice(0,10),workerId?:string|null):Promise<void>{
 const run=async(c:DbClient)=>{await assertFresh(actor,c);const values:unknown[]=[actor.tenantId,orgId,workerId??null];const predicate=scopePredicate(actor,domain,operation,'r',values,date,dataClass);const {rows}=await c.query('SELECT 1 FROM (SELECT $1::uuid tenant_id,$2::uuid org_id,$3::uuid worker_id,$3::uuid id) r WHERE '+predicate,values);if(!rows.length)throw new AppError(403,'PERMISSION_DENIED');};
 if(tx)return run(tx);return transaction(actor.tenantId,run);
}
