import 'server-only';
import { randomUUID } from 'node:crypto';
import { transaction, type DbClient } from '../db';
import { assertPermission } from '../policy';
import { GraphClient, clientCredentialToken, GUID, validateGraphUrl, GraphError, type GraphPage, type GraphReader } from './client';
import { synchronizeUsers, type Checkpoint, type DirectoryStore, type DirectoryUser } from './sync';
import { projectDirectoryAccount, applyDirectoryFields, sweepDirectoryOverrides } from './project';
import { audit } from '../audit';
import type { Actor } from '../types';
import { refreshManagers } from './managers';
export { refreshManagers } from './managers';

type Connection = { tenant_id: string; enabled: boolean; paused: boolean; include_guests: boolean; inclusion_groups: string[] };
const tenantQuery=(tenantId:string,sql:string,values:unknown[])=>transaction(tenantId,async tx=>(await tx.query(sql,values)).rows);
function graphFor(tenantId: string): GraphClient {
  // A separate server-only app registration can be used for the read-only directory connector.
  return new GraphClient(clientCredentialToken(tenantId, process.env.GRAPH_CLIENT_ID ?? '', process.env.GRAPH_CLIENT_SECRET ?? ''));
}
export function makeDirectoryStore(tenantId: string, connection: Connection, actor?: Actor): DirectoryStore {
  let prior: Checkpoint;
  return {
    async checkpoint() {
      const generation = randomUUID();
      await tenantQuery(tenantId,`INSERT INTO sync_checkpoints(tenant_id,stream,generation) VALUES($1,'users',$2) ON CONFLICT DO NOTHING`, [tenantId, generation]);
      const [row] = await tenantQuery(tenantId,`SELECT * FROM sync_checkpoints WHERE tenant_id=$1 AND stream='users'`, [tenantId]);
      prior = { nextUrl: row.next_url, deltaUrl: row.delta_url, generation: row.generation, fullScan: row.full_scan };
      return prior;
    },
    async reset(generation) {
      await tenantQuery(tenantId,`UPDATE sync_checkpoints SET next_url=NULL,delta_url=NULL,generation=$2,full_scan=true,updated_at=now()
        WHERE tenant_id=$1 AND stream='users'`, [tenantId, generation]);
    },
    async commitPage(users, next, final) {
      await transaction(tenantId, async tx => {
        if(actor)await assertPermission(actor,'settings','ADMIN',null,'configuration',tx);
        const current=(await tx.query(`SELECT * FROM sync_checkpoints WHERE tenant_id=$1 AND stream='users' FOR UPDATE`, [tenantId])).rows[0];
        const config=(await tx.query('SELECT enabled,paused FROM sync_connections WHERE tenant_id=$1',[tenantId])).rows[0];
        if(!config?.enabled||config.paused)throw new Error('Connector paused during sync');
        if(!current||current.generation!==prior.generation||current.next_url!==prior.nextUrl||current.delta_url!==prior.deltaUrl)throw new Error('Sync checkpoint changed concurrently');
        for (const user of users) {
          await projectUser(tx, tenantId, connection, user, next.generation);
          if(!actor)throw new Error('Directory projection requires an audit actor');
          await projectDirectoryAccount(tx,tenantId,user.id,actor);
        }
        if (final && prior.fullScan) {
          await tx.query(`UPDATE graph_directory_projection SET active=false,account_enabled=false,updated_at=now() WHERE tenant_id=$1 AND generation IS DISTINCT FROM $2`, [tenantId, next.generation]);
          await tx.query(`UPDATE principals p SET enabled=false,auth_version=p.auth_version+1
            FROM graph_directory_projection d WHERE p.tenant_id=$1 AND d.tenant_id=p.tenant_id
            AND d.object_id=p.entra_object_id AND d.generation IS DISTINCT FROM $2 AND p.enabled`, [tenantId,next.generation]);
          const deactivated=await tx.query(`SELECT d.id,l.object_id FROM directory_accounts d
            JOIN graph_object_links l ON l.tenant_id=d.tenant_id AND l.directory_id=d.id JOIN graph_directory_projection p ON p.tenant_id=l.tenant_id AND p.object_id=l.object_id
            WHERE d.tenant_id=$1 AND l.tenant_id=d.tenant_id AND d.id=l.directory_id AND NOT p.active AND d.data->>'enabled'='true'`,[tenantId]);
          if(actor)for(const item of deactivated.rows)await applyDirectoryFields(tx,actor,item.object_id,item.id);
          await tx.query(`DELETE FROM sessions s USING principals p,graph_directory_projection d WHERE s.tenant_id=$1
            AND p.tenant_id=s.tenant_id AND p.id=s.principal_id AND d.tenant_id=p.tenant_id AND d.object_id=p.entra_object_id AND NOT d.active`, [tenantId]);
        }
        await tx.query(`UPDATE sync_checkpoints SET next_url=$2,delta_url=$3,generation=$4,full_scan=$5,updated_at=now()
          WHERE tenant_id=$1 AND stream='users'`, [tenantId, next.nextUrl, next.deltaUrl, next.generation, next.fullScan]);
        if(actor)await audit(tx,actor,'GRAPH_PAGE','directory-accounts',null,{count:users.length});
      });
      prior = next;
    },
  };
}
async function projectUser(tx: DbClient, tenantId: string, connection: Connection, user: DirectoryUser, generation: string) {
  if (user['@removed']) {
    await tx.query(`UPDATE graph_directory_projection SET active=false,account_enabled=false,generation=$3,updated_at=now() WHERE tenant_id=$1 AND object_id=$2`, [tenantId,user.id,generation]);
    await tx.query(`UPDATE principals SET enabled=false,auth_version=auth_version+1 WHERE tenant_id=$1 AND entra_object_id=$2`, [tenantId,user.id]);
    await tx.query(`DELETE FROM sessions WHERE tenant_id=$1 AND principal_id IN (SELECT id FROM principals WHERE tenant_id=$1 AND entra_object_id=$2)`, [tenantId,user.id]);
    return;
  }
  const old = (await tx.query(`SELECT * FROM graph_directory_projection WHERE tenant_id=$1 AND object_id=$2`, [tenantId,user.id])).rows[0];
  const pick = (key: keyof DirectoryUser, column: string) => Object.prototype.hasOwnProperty.call(user,key) ? user[key] : old?.[column] ?? null;
  const enabled = pick('accountEnabled','account_enabled') === true;
  const userType = pick('userType','user_type');
  let included = connection.inclusion_groups.length === 0;
  if (!included) included = Boolean((await tx.query(`SELECT 1 FROM graph_group_memberships WHERE tenant_id=$1 AND object_id=$2 AND group_id=ANY($3::uuid[]) LIMIT 1`, [tenantId,user.id,connection.inclusion_groups])).rowCount);
  const active = enabled && included && (connection.include_guests || userType === 'Member');
  await tx.query(`INSERT INTO graph_directory_projection(tenant_id,object_id,display_name,mail,user_principal_name,job_title,department,account_enabled,user_type,active,generation)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,object_id) DO UPDATE SET
    display_name=EXCLUDED.display_name,mail=EXCLUDED.mail,user_principal_name=EXCLUDED.user_principal_name,
    job_title=EXCLUDED.job_title,department=EXCLUDED.department,account_enabled=EXCLUDED.account_enabled,
    user_type=EXCLUDED.user_type,active=EXCLUDED.active,generation=EXCLUDED.generation,updated_at=now()`,
    [tenantId,user.id,pick('displayName','display_name'),pick('mail','mail'),pick('userPrincipalName','user_principal_name'),
      pick('jobTitle','job_title'),pick('department','department'),enabled,userType,active,generation]);
  if (!enabled) {
    await tx.query(`UPDATE principals SET enabled=false,auth_version=auth_version+1 WHERE tenant_id=$1 AND entra_object_id=$2`, [tenantId,user.id]);
    await tx.query(`DELETE FROM sessions WHERE tenant_id=$1 AND principal_id IN(SELECT id FROM principals WHERE tenant_id=$1 AND entra_object_id=$2)`, [tenantId,user.id]);
  }
}
export async function refreshGroups(tenantId: string, connection: Connection, graph: GraphClient, actor?:Actor): Promise<number> {
  const mappings = await transaction(tenantId, async tx => (await tx.query(`SELECT DISTINCT group_id FROM (
    SELECT group_id FROM group_mappings WHERE tenant_id=$1 AND enabled AND group_id IS NOT NULL
    UNION SELECT (payload->>'groupId')::uuid FROM sensitive_access_requests WHERE tenant_id=$1 AND state='pending' AND kind='mappings' AND payload->>'groupId' IS NOT NULL) groups`, [tenantId])).rows);
  const groups = [...new Set([...connection.inclusion_groups, ...mappings.map(m => m.group_id as string)])];
  let count = 0;
  for (const group of groups) {
    if (!GUID.test(group)) throw new Error('Invalid configured group');
    const path = `/v1.0/groups/${group}/transitiveMembers/microsoft.graph.user`;
    const stream = `group:${group}`;
    await tenantQuery(tenantId,`INSERT INTO sync_checkpoints(tenant_id,stream,generation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId,stream,randomUUID()]);
    const [checkpoint] = await tenantQuery(tenantId,`SELECT * FROM sync_checkpoints WHERE tenant_id=$1 AND stream=$2`, [tenantId,stream]);
    const generation = checkpoint.next_url ? checkpoint.generation : randomUUID();
    if(!checkpoint.next_url)await tenantQuery(tenantId,`UPDATE sync_checkpoints SET generation=$3,full_scan=true WHERE tenant_id=$1 AND stream=$2`,[tenantId,stream,generation]);
    let url: string | undefined = checkpoint.next_url ?? `https://graph.microsoft.com${path}?$select=id&$top=999`;
    const seen = new Set<string>();
    while (url) {
      if (seen.has(url)) throw new Error('Group continuation cycle'); seen.add(url);
      const page: GraphPage<{id:string}> = await graph.get(url, path);
      if (!Array.isArray(page.value) || page.value.some(x => !GUID.test(x.id))) throw new Error('Invalid group page');
      const next: string | undefined = page['@odata.nextLink'];
      if (next) validateGraphUrl(next,path);
      await transaction(tenantId, async tx => {
        if(actor)await assertPermission(actor,'settings','ADMIN',null,'configuration',tx);
        for (const user of page.value) await tx.query(`INSERT INTO graph_group_memberships(tenant_id,group_id,object_id,generation)
          VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,group_id,object_id) DO UPDATE SET generation=$4,checked_at=now()`, [tenantId,group,user.id,generation]);
        if (!next) await tx.query(`DELETE FROM graph_group_memberships WHERE tenant_id=$1 AND group_id=$2 AND generation<>$3`, [tenantId,group,generation]);
        await tx.query(`UPDATE sync_checkpoints SET next_url=$3,generation=$4,full_scan=$5,updated_at=now() WHERE tenant_id=$1 AND stream=$2`, [tenantId,stream,next ?? null,generation,Boolean(next)]);
      });
      count += page.value.length; url = next;
    }
  }
  await transaction(tenantId, async tx => {
    if(actor)await assertPermission(actor,'settings','ADMIN',null,'configuration',tx);
    // Replacement is atomic; a removed member loses grants and active sessions immediately.
    await tx.query(`UPDATE principals p SET auth_version=p.auth_version+1 WHERE p.tenant_id=$1 AND EXISTS
      (SELECT 1 FROM access_grants a WHERE a.tenant_id=p.tenant_id AND a.principal_id=p.id AND a.source='group' AND NOT EXISTS
        (SELECT 1 FROM group_mappings m JOIN graph_group_memberships gm ON gm.tenant_id=m.tenant_id AND gm.group_id=m.group_id
         WHERE m.tenant_id=a.tenant_id AND m.id::text=a.source_key AND m.enabled AND gm.object_id=p.entra_object_id))`,[tenantId]);
    await tx.query(`DELETE FROM access_grants WHERE tenant_id=$1 AND source='group'`, [tenantId]);
    await tx.query(`INSERT INTO access_grants(id,tenant_id,principal_id,domain,operation,data_class,org_id,scope,valid_from,source,source_key)
      SELECT gen_random_uuid(),m.tenant_id,p.id,m.domain,m.operation,m.data_class,m.org_id,m.scope,CURRENT_DATE,'group',m.id::text
      FROM group_mappings m JOIN graph_group_memberships gm ON gm.tenant_id=m.tenant_id AND gm.group_id=m.group_id
      JOIN principals p ON p.tenant_id=gm.tenant_id AND p.entra_object_id=gm.object_id
      WHERE m.tenant_id=$1 AND m.enabled AND p.enabled`, [tenantId]);
    await tx.query(`DELETE FROM sessions WHERE tenant_id=$1 AND principal_id NOT IN
      (SELECT principal_id FROM access_grants WHERE tenant_id=$1 AND valid_from<=CURRENT_DATE AND (valid_to IS NULL OR valid_to>CURRENT_DATE))`, [tenantId]);
    await tx.query(`DELETE FROM sessions s USING principals p WHERE s.tenant_id=$1 AND p.tenant_id=s.tenant_id AND p.id=s.principal_id AND s.auth_version<>p.auth_version`,[tenantId]);
    await tx.query(`INSERT INTO graph_entitlement_refresh(tenant_id,checked_at) VALUES($1,now()) ON CONFLICT(tenant_id) DO UPDATE SET checked_at=now()`, [tenantId]);
    await tx.query(`UPDATE graph_directory_projection d SET active=d.account_enabled AND ($2 OR d.user_type='Member') AND
      (cardinality($3::uuid[])=0 OR EXISTS(SELECT 1 FROM graph_group_memberships g WHERE g.tenant_id=d.tenant_id AND g.object_id=d.object_id AND g.group_id=ANY($3::uuid[]))) WHERE d.tenant_id=$1`, [tenantId,connection.include_guests,connection.inclusion_groups]);
    const changed=await tx.query(`SELECT d.id,l.object_id FROM directory_accounts d
      JOIN graph_object_links l ON l.tenant_id=d.tenant_id AND l.directory_id=d.id JOIN graph_directory_projection p ON p.tenant_id=l.tenant_id AND p.object_id=l.object_id
      WHERE d.tenant_id=$1 AND l.tenant_id=d.tenant_id AND l.directory_id=d.id AND (d.data->>'enabled')::boolean IS DISTINCT FROM p.active`,[tenantId]);
    if(actor)for(const item of changed.rows)await applyDirectoryFields(tx,actor,item.object_id,item.id);
  });
  return count;
}
export async function processGraphJob(job: {id:string;tenant_id:string;kind:string;payload:unknown}, actor?:Actor): Promise<void> {
  if(!actor||actor.tenantId!==job.tenant_id)throw new Error('Graph job requires an authorized tenant actor');
  await assertPermission(actor,'settings','ADMIN',null,'configuration');
  const [connection] = await tenantQuery(job.tenant_id,`SELECT * FROM sync_connections WHERE tenant_id=$1`, [job.tenant_id]);
  if (!connection?.enabled || connection.paused) throw new Error('Graph connector is disabled or paused');
  const graph = graphFor(job.tenant_id); const run = randomUUID();
  await tenantQuery(job.tenant_id,`INSERT INTO sync_runs(id,tenant_id,kind,status) VALUES($1,$2,$3,'running')`, [run,job.tenant_id,job.kind]);
  try {
    let processed = 0;
    if (job.kind === 'graph.groups') processed = await refreshGroups(job.tenant_id,connection,graph,actor);
    else if (job.kind === 'graph.managers') processed = await refreshManagers(job.tenant_id,graph,actor);
    else if (job.kind === 'graph.sync') {
      await refreshGroups(job.tenant_id,connection,graph,actor);
      processed = await synchronizeDirectory(graph,job.tenant_id,connection,actor);
    } else throw new Error('Unsupported Graph job');
    await tenantQuery(job.tenant_id,`UPDATE sync_runs SET status='complete',processed=$2,completed_at=now() WHERE id=$1 AND tenant_id=$3`, [run,processed,job.tenant_id]);
  } catch (error) {
    await tenantQuery(job.tenant_id,`UPDATE sync_runs SET status='failed',error_code=$2,completed_at=now() WHERE id=$1 AND tenant_id=$3`, [run,error instanceof GraphError ? `GRAPH_${error.status}` : 'SYNC_FAILED',job.tenant_id]);
    throw error;
  }
}
export async function synchronizeDirectory(graph:GraphReader,tenantId:string,connection:Connection,actor:Actor):Promise<number>{
  const processed=await synchronizeUsers(graph,makeDirectoryStore(tenantId,connection,actor));
  await sweepDirectoryOverrides(actor);
  return processed;
}
export async function testGraphConnection(tenantId: string): Promise<void> {
  await graphFor(tenantId).get('https://graph.microsoft.com/v1.0/users?$select=id&$top=1');
}
