import {randomUUID} from 'node:crypto';import type {DbClient} from './db';import {transaction} from './db';import type {Actor,Grant} from './types';import {AppError} from './errors';import {audit} from './audit';
export async function enqueue(tx:DbClient,actor:Actor,kind:string,payload:Record<string,unknown>){const id=randomUUID();await tx.query('INSERT INTO jobs(id,tenant_id,actor_id,kind,payload) VALUES($1,$2,$3,$4,$5)',[id,actor.tenantId,actor.userId,kind,payload]);await audit(tx,actor,'ENQUEUE','jobs',id,{jobId:id});return id;}
export async function actorForPrincipal(tenantId:string,userId:string,existingTx?:DbClient):Promise<Actor>{
 const load=async(tx:DbClient):Promise<Actor>=>{
  const p=(await tx.query('SELECT * FROM principals WHERE tenant_id=$1 AND id=$2 AND enabled=true',[tenantId,userId])).rows[0];if(!p)throw new AppError(403,'JOB_ACTOR_REVOKED');
  const rows=(await tx.query("SELECT * FROM access_grants g WHERE tenant_id=$1 AND principal_id=$2 AND valid_from<=CURRENT_DATE AND (valid_to IS NULL OR valid_to>CURRENT_DATE) AND (COALESCE(source,'manual')<>'group' OR EXISTS(SELECT 1 FROM graph_entitlement_refresh WHERE tenant_id=$1 AND checked_at>now()-interval '15 minutes')) AND (COALESCE(source,'manual')<>'role' OR EXISTS(SELECT 1 FROM sessions s WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.auth_version=$3 AND s.expires_at>now() AND s.entitlements_checked_at>now()-interval '8 hours'))",[tenantId,userId,p.auth_version])).rows;
  const date=(v:any)=>v instanceof Date?v.toISOString().slice(0,10):v;
  const grants:Grant[]=rows.map(g=>({domain:g.domain,operation:g.operation,dataClass:g.data_class,orgId:g.org_id,scope:g.scope,validFrom:date(g.valid_from),validTo:date(g.valid_to)}));
  if(!grants.length)throw new AppError(403,'JOB_ACTOR_REVOKED');
  return {tenantId,userId,sessionId:'worker',roles:p.roles,authVersion:p.auth_version,grants};
 };
 return existingTx?load(existingTx):transaction(tenantId,load);
}
