import type {DbClient} from '../db';

/** Page staging is not an entitlement snapshot. Call within the login transaction. */
export async function materializeLoginGroupGrants(tx:DbClient,tenantId:string,principalId:string,objectId:string):Promise<number|null>{
 const prior=(await tx.query(`SELECT source_key,domain,operation,data_class,org_id,scope FROM access_grants
  WHERE tenant_id=$1 AND principal_id=$2 AND source='group' FOR UPDATE`,[tenantId,principalId])).rows;
 await tx.query(`DELETE FROM access_grants WHERE tenant_id=$1 AND principal_id=$2 AND source='group'`,[tenantId,principalId]);
 const current=(await tx.query(`INSERT INTO access_grants(id,tenant_id,principal_id,domain,operation,data_class,org_id,scope,valid_from,source,source_key)
  SELECT gen_random_uuid(),m.tenant_id,$2,m.domain,m.operation,m.data_class,m.org_id,m.scope,CURRENT_DATE,'group',m.id::text
  FROM group_mappings m JOIN graph_group_memberships g ON g.tenant_id=m.tenant_id AND g.group_id=m.group_id
  JOIN graph_entitlement_refresh r ON r.tenant_id=m.tenant_id AND r.checked_at>now()-interval '15 minutes'
  JOIN sync_checkpoints c ON c.tenant_id=g.tenant_id AND c.stream='group:'||g.group_id::text
    AND c.generation=g.generation AND c.next_url IS NULL AND c.full_scan=false
    AND c.updated_at>now()-interval '15 minutes'
  WHERE m.tenant_id=$1 AND m.enabled AND g.object_id=$3
  RETURNING source_key,domain,operation,data_class,org_id,scope`,[tenantId,principalId,objectId])).rows;
 const key=(row:Record<string,unknown>)=>JSON.stringify([row.source_key,row.domain,row.operation,row.data_class,row.org_id,row.scope]);
 const retained=new Set(current.map(key));
 if(!prior.some(row=>!retained.has(key(row))))return null;
 // In-flight actors must also lose removed grants, even if a manual grant still permits login.
 const principal=(await tx.query(`UPDATE principals SET auth_version=auth_version+1 WHERE tenant_id=$1 AND id=$2 RETURNING auth_version`,[tenantId,principalId])).rows[0];
 return principal.auth_version;
}
