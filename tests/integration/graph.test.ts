import {beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
vi.mock('server-only',()=>({}));
import {transaction,closeDatabase} from '../../src/lib/db';
import {makeDirectoryStore,refreshGroups,refreshManagers,synchronizeDirectory} from '../../src/lib/graph/worker';
import {synchronizeUsers,USERS_INITIAL} from '../../src/lib/graph/sync';
import {GraphClient,GraphError,type GraphReader} from '../../src/lib/graph/client';
import {materializeLoginGroupGrants} from '../../src/lib/graph/login-grants';
import {mutateRecord,listRecords} from '../../src/lib/records';
import {domains} from '../../src/lib/registry';
import type {Actor} from '../../src/lib/types';
const configured=Boolean(process.env.TEST_DATABASE_URL);
const delta='https://graph.microsoft.com/v1.0/users/delta?$deltatoken=synthetic';
let tenantId:string,orgId:string,objectId:string,actor:Actor;
const connection=()=>({tenant_id:tenantId,enabled:true,paused:false,include_guests:false,inclusion_groups:[]});
const page=(value:unknown[]):GraphReader=>({async get<T>(){return {value,'@odata.deltaLink':delta} as T;}});
async function initial(){await synchronizeUsers(page([{id:objectId,displayName:'Synthetic Directory Person',mail:'synthetic@example.invalid',userPrincipalName:'synthetic@example.invalid',accountEnabled:true,userType:'Member',department:'Research',jobTitle:'Directory title'}]),makeDirectoryStore(tenantId,connection(),actor));}
describe.skipIf(!configured)('real PostgreSQL Graph projections and tenant boundaries',()=>{
 beforeEach(async()=>{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;tenantId=randomUUID();orgId=randomUUID();objectId=randomUUID();
  actor={tenantId,userId:randomUUID(),sessionId:'integration',roles:[],authVersion:1,grants:Object.values(domains).map(d=>({domain:d.key,operation:'*',dataClass:d.dataClass,orgId:null,scope:'tenant' as const,validFrom:'2000-01-01',validTo:null}))};
  await transaction(tenantId,async tx=>{
   await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[tenantId,'SYNTHETIC GRAPH TEST']);
   await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[actor.userId,tenantId,randomUUID()]);
   await tx.query('INSERT INTO org_units(id,tenant_id,org_id,data) VALUES($1,$2,$1,$3)',[orgId,tenantId,{code:randomUUID(),name:'Synthetic research',orgType:'Team'}]);
   await tx.query('INSERT INTO sync_connections(tenant_id,enabled,paused) VALUES($1,true,false)',[tenantId]);
   await tx.query('INSERT INTO graph_department_mappings(tenant_id,department,org_id) VALUES($1,$2,$3)',[tenantId,'Research',orgId]);
  });
 });
 afterAll(closeDatabase);
 it('does not turn a partial group page into login grants despite a fresh prior global snapshot',async()=>{
  const principalId=randomUUID(),groupId=randomUUID(),generation=randomUUID();
  await transaction(tenantId,async tx=>{
   await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[principalId,tenantId,objectId]);
   await tx.query(`INSERT INTO group_mappings(tenant_id,group_id,domain,operation,data_class,scope,enabled) VALUES($1,$2,'workers','READ','planning','tenant',true)`,[tenantId,groupId]);
   await tx.query('INSERT INTO graph_entitlement_refresh(tenant_id,checked_at) VALUES($1,now())',[tenantId]);
   await tx.query('INSERT INTO graph_group_memberships(tenant_id,group_id,object_id,generation) VALUES($1,$2,$3,$4)',[tenantId,groupId,objectId,generation]);
   await tx.query(`INSERT INTO sync_checkpoints(tenant_id,stream,generation,next_url,full_scan) VALUES($1,$2,$3,'https://graph.microsoft.com/v1.0/groups/next',true)`,[tenantId,`group:${groupId}`,generation]);
   await materializeLoginGroupGrants(tx,tenantId,principalId,objectId);
   expect((await tx.query('SELECT id FROM access_grants WHERE tenant_id=$1 AND principal_id=$2',[tenantId,principalId])).rowCount).toBe(0);
   await tx.query('UPDATE sync_checkpoints SET next_url=NULL,full_scan=false WHERE tenant_id=$1',[tenantId]);
   await materializeLoginGroupGrants(tx,tenantId,principalId,objectId);
   expect((await tx.query('SELECT id FROM access_grants WHERE tenant_id=$1 AND principal_id=$2',[tenantId,principalId])).rowCount).toBe(1);
   await tx.query(`UPDATE sync_checkpoints SET updated_at=now()-interval '16 minutes' WHERE tenant_id=$1`,[tenantId]);
   await materializeLoginGroupGrants(tx,tenantId,principalId,objectId);
   expect((await tx.query('SELECT id FROM access_grants WHERE tenant_id=$1 AND principal_id=$2',[tenantId,principalId])).rowCount).toBe(0);
   expect((await tx.query('SELECT auth_version FROM principals WHERE tenant_id=$1 AND id=$2',[tenantId,principalId])).rows[0].auth_version).toBe(2);
  });
 });
 it('revokes an absent full-scan principal as well as deleting its browser sessions',async()=>{
  await initial();const principalId=randomUUID();
  await transaction(tenantId,async tx=>{
   await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[principalId,tenantId,objectId]);
   await tx.query(`INSERT INTO sessions(id,tenant_id,principal_id,token_hash,expires_at,auth_version) VALUES($1,$2,$3,$4,now()+interval '1 hour',1)`,[randomUUID(),tenantId,principalId,randomUUID()]);
  });
  const store=makeDirectoryStore(tenantId,connection(),actor);await store.reset(randomUUID());
  await synchronizeUsers(page([]),store);
  await transaction(tenantId,async tx=>{
   expect((await tx.query('SELECT enabled,auth_version FROM principals WHERE tenant_id=$1 AND id=$2',[tenantId,principalId])).rows[0]).toEqual({enabled:false,auth_version:2});
   expect((await tx.query('SELECT id FROM sessions WHERE tenant_id=$1 AND principal_id=$2',[tenantId,principalId])).rowCount).toBe(0);
  });
 });
 it('resumes a manager cycle from the first uncommitted object, then begins a fresh cycle',async()=>{
  const ids=[1,2,3].map(n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`);const manager=randomUUID();
  await transaction(tenantId,async tx=>{for(const id of ids)await tx.query('INSERT INTO graph_directory_projection(tenant_id,object_id,active) VALUES($1,$2,true)',[tenantId,id]);});
  const seen:string[]=[];let fail=true;
  const graph:GraphReader={async get<T>(url:string){const id=new URL(url).pathname.split('/')[3];seen.push(id);if(id===ids[1]&&fail)throw new GraphError(503);return {id:manager} as T;}};
  await expect(refreshManagers(tenantId,graph,actor)).rejects.toMatchObject({status:503});
  const first=await transaction(tenantId,async tx=>{const cp=(await tx.query('SELECT * FROM graph_manager_checkpoints WHERE tenant_id=$1',[tenantId])).rows[0];expect(cp.after_object_id).toBe(ids[0]);expect(cp.processed).toBe(1);expect(cp.completed_at).toBeNull();expect((await tx.query('SELECT object_id FROM graph_manager_projection WHERE tenant_id=$1',[tenantId])).rows.map(r=>r.object_id)).toEqual([ids[0]]);return cp;});
  fail=false;expect(await refreshManagers(tenantId,graph,actor)).toBe(2);expect(seen).toEqual([ids[0],ids[1],ids[1],ids[2]]);
  await transaction(tenantId,async tx=>{const cp=(await tx.query('SELECT * FROM graph_manager_checkpoints WHERE tenant_id=$1',[tenantId])).rows[0];expect(cp.generation).toBe(first.generation);expect(cp.processed).toBe(3);expect(cp.completed_at).not.toBeNull();});
  seen.length=0;expect(await refreshManagers(tenantId,graph,actor)).toBe(3);expect(seen).toEqual(ids);
  await transaction(tenantId,async tx=>{expect((await tx.query('SELECT generation FROM graph_manager_checkpoints WHERE tenant_id=$1',[tenantId])).rows[0].generation).not.toBe(first.generation);});
 });
 it('commits neither manager nor cursor if the connector pauses after the response',async()=>{
  await initial();const graph:GraphReader={async get<T>(){await transaction(tenantId,async tx=>{await tx.query('UPDATE sync_connections SET paused=true WHERE tenant_id=$1',[tenantId]);});return {id:randomUUID()} as T;}};
  await expect(refreshManagers(tenantId,graph,actor)).rejects.toThrow('paused');
  await transaction(tenantId,async tx=>{expect((await tx.query('SELECT * FROM graph_manager_projection WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);const cp=(await tx.query('SELECT * FROM graph_manager_checkpoints WHERE tenant_id=$1',[tenantId])).rows[0];expect(cp.after_object_id).toBeNull();expect(cp.processed).toBe(0);await tx.query('UPDATE sync_connections SET paused=false WHERE tenant_id=$1',[tenantId]);});
  expect(await refreshManagers(tenantId,{async get<T>(){return {id:randomUUID()} as T;}},actor)).toBe(1);
 });
 it('clears missing and removed observations without corrupting effective reporting history',async()=>{
  await initial();const worker=(await listRecords(actor,'workers',{})).rows[0];const currentDate=new Date().toISOString().slice(0,10);const nextDate=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const businessManager=await mutateRecord(actor,'workers',{operation:'CREATE',orgId,validFrom:currentDate,data:{code:'SYN-MANAGER',workerType:'manual-only',employmentStatus:'active',homeOrgId:orgId}});
  const line=await mutateRecord(actor,'reporting-lines',{operation:'CREATE',orgId,workerId:worker.id,validFrom:currentDate,data:{managerId:businessManager.id,kind:'primary'}});
  await mutateRecord(actor,'reporting-lines',{operation:'UPDATE',id:line.id,version:line.version,validFrom:nextDate,data:{kind:'dotted'}});
  const history=()=>transaction(tenantId,async tx=>(await tx.query(`SELECT record_id,version,snapshot FROM record_history WHERE tenant_id=$1 AND domain='reporting-lines' ORDER BY record_id,version`,[tenantId])).rows);
  const before=await history();const upstreamManager=randomUUID();await refreshManagers(tenantId,{async get<T>(){return {id:upstreamManager} as T;}},actor);
  await refreshManagers(tenantId,{async get(){throw new GraphError(404);}},actor);
  await transaction(tenantId,async tx=>{const r=(await tx.query('SELECT * FROM graph_manager_projection WHERE tenant_id=$1',[tenantId])).rows[0];expect(r.manager_object_id).toBeNull();expect(r.resolution).toBe('missing');expect(r.checked_at).toBeInstanceOf(Date);await tx.query('UPDATE graph_directory_projection SET active=false WHERE tenant_id=$1',[tenantId]);});
  const get=vi.fn();expect(await refreshManagers(tenantId,{get},actor)).toBe(1);expect(get).not.toHaveBeenCalled();
  await transaction(tenantId,async tx=>{const r=(await tx.query('SELECT manager_object_id,resolution FROM graph_manager_projection WHERE tenant_id=$1',[tenantId])).rows[0];expect(r).toEqual({manager_object_id:null,resolution:'inactive'});});
  expect(await history()).toEqual(before);
  expect((await listRecords(actor,'reporting-lines',{date:currentDate})).rows[0].data).toEqual({managerId:businessManager.id,kind:'primary'});
  expect((await listRecords(actor,'reporting-lines',{date:nextDate})).rows[0].data).toEqual({managerId:businessManager.id,kind:'dotted'});
 });
 it('tenant RLS isolates manager checkpoints and empty scans complete cleanly',async()=>{
  const graph={get:vi.fn()};expect(await refreshManagers(tenantId,graph,actor)).toBe(0);expect(graph.get).not.toHaveBeenCalled();
  const other=randomUUID();await transaction(other,async tx=>{await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[other,'SYNTHETIC OTHER MANAGER']);await tx.query('INSERT INTO graph_manager_checkpoints(tenant_id,generation) VALUES($1,$2)',[other,randomUUID()]);});
  await transaction(tenantId,async tx=>{const rows=(await tx.query('SELECT tenant_id,completed_at FROM graph_manager_checkpoints')).rows;expect(rows).toHaveLength(1);expect(rows[0].tenant_id).toBe(tenantId);expect(rows[0].completed_at).not.toBeNull();expect((await tx.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='graph_manager_checkpoints'")).rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});});
 });
 it('creates stable separate worker/identity/directory rows with version history and preserves application fields',async()=>{
  await initial();
  const result=await transaction(tenantId,async tx=>({link:(await tx.query('SELECT * FROM graph_object_links WHERE tenant_id=$1',[tenantId])).rows[0],worker:(await tx.query('SELECT * FROM workers WHERE tenant_id=$1',[tenantId])).rows[0],history:(await tx.query('SELECT domain FROM record_history WHERE tenant_id=$1',[tenantId])).rows}));
  expect(result.worker.data.displayName).toBeUndefined();expect(result.worker.data.email).toBeUndefined();expect(result.worker.data.workerType).toBe('manual-only');expect(result.history.map(x=>x.domain)).toContain('workers');expect(result.history.map(x=>x.domain)).toContain('identities');
  await mutateRecord(actor,'workers',{operation:'UPDATE',id:result.worker.id,version:result.worker.version,data:{title:'Application-approved title'}});
  await synchronizeUsers(page([{id:objectId,jobTitle:'Changed directory title'}]),makeDirectoryStore(tenantId,connection(),actor));
  await transaction(tenantId,async tx=>{const worker=(await tx.query('SELECT * FROM workers WHERE tenant_id=$1',[tenantId])).rows[0];const directory=(await tx.query('SELECT * FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rows[0];expect(worker.id).toBe(result.link.worker_id);expect(worker.data.title).toBe('Application-approved title');expect(directory.data.directoryTitle).toBe('Changed directory title');expect(directory.data.directoryDepartment).toBe('Research');expect((await tx.query("SELECT count(*)::int count FROM record_history WHERE tenant_id=$1 AND domain='directory-accounts'",[tenantId])).rows[0].count).toBeGreaterThanOrEqual(3);});
 });
 it('excludes guests and routes missing department mappings to reconciliation without inventing a worker',async()=>{
  await synchronizeUsers(page([{id:objectId,accountEnabled:true,userType:'Guest',department:'Research'},{id:randomUUID(),accountEnabled:true,userType:'Member',department:'Unmapped'}]),makeDirectoryStore(tenantId,connection(),actor));
  await transaction(tenantId,async tx=>{expect((await tx.query('SELECT * FROM workers WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);expect((await tx.query('SELECT * FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rowCount).toBe(1);expect((await tx.query('SELECT data FROM reconciliation WHERE tenant_id=$1',[tenantId])).rows[0].data.reason).toBe('UNMAPPED_DIRECTORY_DEPARTMENT');});
 });
 it('resumes a committed nextLink after failure without duplicating workers',async()=>{
  const next='https://graph.microsoft.com/v1.0/users/delta?$skiptoken=next';
  const failing:GraphReader={async get<T>(url:string){if(url!==USERS_INITIAL)throw new Error('synthetic transport interruption');return {value:[{id:objectId,accountEnabled:true,userType:'Member',department:'Research'}],'@odata.nextLink':next} as T;}};
  await expect(synchronizeUsers(failing,makeDirectoryStore(tenantId,connection(),actor))).rejects.toThrow('interruption');
  const urls:string[]=[];const resumed:GraphReader={async get<T>(url:string){urls.push(url);return {value:[],'@odata.deltaLink':delta} as T;}};
  await synchronizeUsers(resumed,makeDirectoryStore(tenantId,connection(),actor));expect(urls).toEqual([next]);
  await transaction(tenantId,async tx=>{expect((await tx.query('SELECT * FROM workers WHERE tenant_id=$1',[tenantId])).rowCount).toBe(1);expect((await tx.query("SELECT * FROM sync_checkpoints WHERE tenant_id=$1 AND stream='users'",[tenantId])).rows[0].delta_url).toBe(delta);});
 });
 it('revokes deleted account sessions and group refresh cannot reactivate a tombstone',async()=>{
  await initial();const principal=randomUUID();await transaction(tenantId,async tx=>{await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[principal,tenantId,objectId]);await tx.query("INSERT INTO sessions(tenant_id,principal_id,token_hash,expires_at,auth_version) VALUES($1,$2,$3,now()+interval '1 hour',1)",[tenantId,principal,randomUUID()]);});
  await synchronizeUsers(page([{id:objectId,'@removed':{reason:'deleted'}}]),makeDirectoryStore(tenantId,connection(),actor));
  const graph=new GraphClient(async()=> 'synthetic',async()=>{throw new Error('No group network call expected');});await refreshGroups(tenantId,connection(),graph,actor);
  await transaction(tenantId,async tx=>{expect((await tx.query('SELECT * FROM sessions WHERE tenant_id=$1',[tenantId])).rowCount).toBe(0);expect((await tx.query('SELECT enabled FROM principals WHERE tenant_id=$1 AND id=$2',[tenantId,principal])).rows[0].enabled).toBe(false);expect((await tx.query('SELECT active,account_enabled FROM graph_directory_projection WHERE tenant_id=$1',[tenantId])).rows[0]).toEqual({active:false,account_enabled:false});});
 });
 it('forces RLS on Graph tables and hides another tenant without relying on an explicit filter',async()=>{
  await initial();const other=randomUUID();await transaction(other,async tx=>{await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[other,'SYNTHETIC OTHER']);await tx.query('INSERT INTO graph_directory_projection(tenant_id,object_id) VALUES($1,$2)',[other,randomUUID()]);});
  await transaction(tenantId,async tx=>{const rows=(await tx.query('SELECT tenant_id FROM graph_directory_projection')).rows;expect(rows.length).toBe(1);expect(rows.every(x=>x.tenant_id===tenantId)).toBe(true);const flags=(await tx.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='graph_directory_projection'")).rows[0];expect(flags).toEqual({relrowsecurity:true,relforcerowsecurity:true});});
 });
 it('preserves application-owned directory metadata and records the latest upstream value separately',async()=>{
  await initial();
  const directory=await transaction(tenantId,async tx=>{
   await tx.query(`INSERT INTO field_policies(tenant_id,data) VALUES($1,$2)`,[tenantId,{domain:'directory-accounts',field:'directoryTitle',owner:'application',overrideAllowed:false}]);
   return (await tx.query('SELECT * FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rows[0];
  });
  await mutateRecord(actor,'directory-accounts',{operation:'UPDATE',id:directory.id,version:directory.version,data:{directoryTitle:'Application controlled title'}});
  await synchronizeDirectory(page([{id:objectId,jobTitle:'New source title'}]),tenantId,connection(),actor);
  await transaction(tenantId,async tx=>{
   expect((await tx.query('SELECT data FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rows[0].data.directoryTitle).toBe('Application controlled title');
   expect((await tx.query('SELECT job_title FROM graph_directory_projection WHERE tenant_id=$1',[tenantId])).rows[0].job_title).toBe('New source title');
   expect((await tx.query(`SELECT data FROM reconciliation WHERE tenant_id=$1 AND data->>'reason'='FIELD_OWNER_CONFLICT:directoryTitle'`,[tenantId])).rowCount).toBe(1);
  });
 });
 it('applies an approved exact-target override then restores upstream on expiry despite an unchanged delta',async()=>{
  await initial();const overrideId=randomUUID();const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);const date=new Date().toISOString().slice(0,10);
  await transaction(tenantId,async tx=>{
   const directory=(await tx.query('SELECT * FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rows[0];
   await tx.query('INSERT INTO field_policies(tenant_id,data) VALUES($1,$2)',[tenantId,{domain:'directory-accounts',field:'directoryTitle',owner:'Entra',overrideAllowed:true}]);
   await tx.query(`INSERT INTO overrides(id,tenant_id,org_id,worker_id,state,data) VALUES($1,$2,$3,$4,'approved',$5)`,[overrideId,tenantId,orgId,directory.worker_id,{domain:'directory-accounts',recordId:directory.id,field:'directoryTitle',value:'Synthetic approved override',reason:'Synthetic approved business reason',expiresOn:tomorrow,requesterId:actor.userId}]);
   // A valid approval for a different target must never influence this account.
   await tx.query(`INSERT INTO overrides(tenant_id,org_id,state,data) VALUES($1,$2,'approved',$3)`,[tenantId,orgId,{domain:'directory-accounts',recordId:randomUUID(),field:'directoryTitle',value:'Wrong-target override',reason:'Synthetic reason',expiresOn:tomorrow,requesterId:actor.userId}]);
  });
  await synchronizeDirectory(page([{id:objectId,jobTitle:'Latest upstream during override'}]),tenantId,connection(),actor);
  await transaction(tenantId,async tx=>{
   expect((await tx.query('SELECT data FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rows[0].data.directoryTitle).toBe('Synthetic approved override');
   expect((await tx.query('SELECT job_title FROM graph_directory_projection WHERE tenant_id=$1',[tenantId])).rows[0].job_title).toBe('Latest upstream during override');
   expect((await tx.query(`SELECT override_id FROM field_provenance WHERE tenant_id=$1 AND domain='directory-accounts' AND field='directoryTitle'`,[tenantId])).rows[0].override_id).toBe(overrideId);
   await tx.query(`UPDATE overrides SET data=jsonb_set(data,'{expiresOn}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2`,[tenantId,overrideId,date]);
  });
  expect(await synchronizeDirectory(page([]),tenantId,connection(),actor)).toBe(0);
  await transaction(tenantId,async tx=>{
   expect((await tx.query('SELECT data FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rows[0].data.directoryTitle).toBe('Latest upstream during override');
   expect((await tx.query(`SELECT override_id FROM field_provenance WHERE tenant_id=$1 AND domain='directory-accounts' AND field='directoryTitle'`,[tenantId])).rows[0].override_id).toBeNull();
   expect((await tx.query(`SELECT data FROM reconciliation WHERE tenant_id=$1 AND data->>'reason'='DIRECTORY_OVERRIDE_EXPIRED:directoryTitle'`,[tenantId])).rowCount).toBe(1);
   const audit=(await tx.query('SELECT metadata FROM audit_events WHERE tenant_id=$1',[tenantId])).rows;expect(JSON.stringify(audit)).not.toContain('Synthetic approved override');expect(JSON.stringify(audit)).not.toContain('Latest upstream during override');
  });
  await synchronizeDirectory(page([]),tenantId,connection(),actor);
  await transaction(tenantId,async tx=>{expect((await tx.query(`SELECT id FROM reconciliation WHERE tenant_id=$1 AND data->>'reason'='DIRECTORY_OVERRIDE_EXPIRED:directoryTitle'`,[tenantId])).rowCount).toBe(1);});
 });
 it('does not overwrite a new source owner when an earlier override expires',async()=>{
  await initial();const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);const date=new Date().toISOString().slice(0,10);const overrideId=randomUUID();
  await transaction(tenantId,async tx=>{const directory=(await tx.query('SELECT * FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rows[0];await tx.query('INSERT INTO field_policies(tenant_id,data) VALUES($1,$2)',[tenantId,{domain:'directory-accounts',field:'directoryTitle',owner:'Entra',overrideAllowed:true}]);await tx.query(`INSERT INTO overrides(id,tenant_id,org_id,state,data) VALUES($1,$2,$3,'approved',$4)`,[overrideId,tenantId,orgId,{domain:'directory-accounts',recordId:directory.id,field:'directoryTitle',value:'Retained approved value',reason:'Synthetic reason',expiresOn:tomorrow,requesterId:actor.userId}]);});
  await synchronizeDirectory(page([]),tenantId,connection(),actor);
  await transaction(tenantId,async tx=>{await tx.query(`UPDATE field_policies SET data=jsonb_set(data,'{owner}','"HR"'::jsonb) WHERE tenant_id=$1`,[tenantId]);await tx.query(`UPDATE overrides SET data=jsonb_set(data,'{expiresOn}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2`,[tenantId,overrideId,date]);});
  await synchronizeDirectory(page([]),tenantId,connection(),actor);
  await transaction(tenantId,async tx=>{expect((await tx.query('SELECT data FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rows[0].data.directoryTitle).toBe('Retained approved value');expect((await tx.query(`SELECT id FROM reconciliation WHERE tenant_id=$1 AND data->>'reason'='EXPIRED_OVERRIDE_OWNER_CONFLICT:directoryTitle'`,[tenantId])).rowCount).toBe(1);});
 });
 it('ignores field policies and approvals scoped to another organization',async()=>{
  await initial();const otherOrg=randomUUID();const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  await transaction(tenantId,async tx=>{
   const directory=(await tx.query('SELECT * FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rows[0];
   await tx.query('INSERT INTO org_units(id,tenant_id,org_id,data) VALUES($1,$2,$1,$3)',[otherOrg,tenantId,{code:randomUUID(),name:'Synthetic other scope',orgType:'Team'}]);
   await tx.query('INSERT INTO field_policies(tenant_id,org_id,data) VALUES($1,$2,$3)',[tenantId,otherOrg,{domain:'directory-accounts',field:'directoryTitle',owner:'HR',overrideAllowed:true}]);
   await tx.query(`INSERT INTO overrides(tenant_id,org_id,state,data) VALUES($1,$2,'approved',$3)`,[tenantId,otherOrg,{domain:'directory-accounts',recordId:directory.id,field:'directoryTitle',value:'Wrong-scope approval',reason:'Synthetic reason',expiresOn:tomorrow,requesterId:actor.userId}]);
  });
  await synchronizeDirectory(page([{id:objectId,jobTitle:'Correct scoped source'}]),tenantId,connection(),actor);
  await transaction(tenantId,async tx=>{expect((await tx.query('SELECT data FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rows[0].data.directoryTitle).toBe('Correct scoped source');expect((await tx.query(`SELECT id FROM reconciliation WHERE tenant_id=$1 AND data->>'reason'='FIELD_OWNER_CONFLICT:directoryTitle'`,[tenantId])).rowCount).toBe(0);});
 });
 it('keeps the currently effective source owner when a policy has a future revision',async()=>{
  await initial();const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const policy=await mutateRecord(actor,'field-policies',{operation:'CREATE',orgId,validFrom:yesterday,data:{domain:'directory-accounts',field:'directoryTitle',owner:'HR',overrideAllowed:false}});
  await mutateRecord(actor,'field-policies',{operation:'UPDATE',id:policy.id,version:policy.version,validFrom:tomorrow,data:{owner:'Entra'}});
  await synchronizeDirectory(page([{id:objectId,jobTitle:'Future policy must not authorize this overwrite'}]),tenantId,connection(),actor);
  await transaction(tenantId,async tx=>{expect((await tx.query('SELECT data FROM directory_accounts WHERE tenant_id=$1',[tenantId])).rows[0].data.directoryTitle).toBe('Directory title');expect((await tx.query('SELECT job_title FROM graph_directory_projection WHERE tenant_id=$1',[tenantId])).rows[0].job_title).toBe('Future policy must not authorize this overwrite');});
 });
});
