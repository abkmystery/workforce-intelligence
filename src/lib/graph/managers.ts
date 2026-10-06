import 'server-only';
import {randomUUID} from 'node:crypto';
import {transaction,type DbClient} from '../db';
import {assertPermission} from '../policy';
import {audit} from '../audit';
import type {Actor} from '../types';
import {GraphError,GUID,type GraphReader} from './client';

type Cursor={generation:string;after_object_id:string|null;upper_object_id:string|null;completed_at:Date|null};
type Observation={managerId:string|null;resolution:'resolved'|'missing'|'inactive'};
const candidates=`SELECT object_id FROM graph_directory_projection WHERE tenant_id=$1 AND active
 UNION SELECT object_id FROM graph_manager_projection WHERE tenant_id=$1`;

/** A 404 means no observable manager, not proof that the user was deleted. */
export async function readManager(graph:GraphReader,objectId:string,active:boolean):Promise<Observation>{
 if(!GUID.test(objectId))throw new Error('Invalid directory object');
 if(!active)return {managerId:null,resolution:'inactive'};
 const path=`/v1.0/users/${objectId}/manager`;
 try{
  const result=await graph.get<{id:string}>(`https://graph.microsoft.com${path}?$select=id`,path);
  if(!result||!GUID.test(result.id))throw new Error('Invalid manager');
  return {managerId:result.id,resolution:'resolved'};
 }catch(error){
  if(error instanceof GraphError&&error.status===404)return {managerId:null,resolution:'missing'};
  throw error;
 }
}
async function authorize(tx:DbClient,actor:Actor){
 await assertPermission(actor,'settings','ADMIN',null,'configuration',tx);
 const config=(await tx.query('SELECT enabled,paused FROM sync_connections WHERE tenant_id=$1',[actor.tenantId])).rows[0];
 if(!config?.enabled||config.paused)throw new Error('Connector paused during manager refresh');
}
async function lockCursor(tx:DbClient,tenantId:string,expected:Cursor){
 const actual=(await tx.query('SELECT * FROM graph_manager_checkpoints WHERE tenant_id=$1 FOR UPDATE',[tenantId])).rows[0];
 if(!actual||actual.generation!==expected.generation||actual.after_object_id!==expected.after_object_id||actual.completed_at)throw new Error('Manager checkpoint changed concurrently');
}
/** The durable worker serializes tenant jobs; cursor comparisons also reject stale writers. */
export async function refreshManagers(tenantId:string,graph:GraphReader,actor?:Actor):Promise<number>{
 if(!actor||actor.tenantId!==tenantId)throw new Error('Manager refresh requires an authorized tenant actor');
 const cursor:Cursor=await transaction(tenantId,async tx=>{
  await authorize(tx,actor);
  await tx.query(`INSERT INTO graph_manager_checkpoints(tenant_id,generation,completed_at) VALUES($1,$2,now()) ON CONFLICT DO NOTHING`,[tenantId,randomUUID()]);
  let row=(await tx.query('SELECT * FROM graph_manager_checkpoints WHERE tenant_id=$1 FOR UPDATE',[tenantId])).rows[0];
  if(row.completed_at){
   // Fix a finite upper bound for this cycle. Lower-ID arrivals are picked up next cycle.
   const upper=(await tx.query(`SELECT object_id FROM (${candidates}) candidates ORDER BY object_id DESC LIMIT 1`,[tenantId])).rows[0]?.object_id??null;
   row=(await tx.query(`UPDATE graph_manager_checkpoints SET generation=$2,after_object_id=NULL,upper_object_id=$3,
    started_at=now(),completed_at=NULL,processed=0,updated_at=now() WHERE tenant_id=$1 RETURNING *`,[tenantId,randomUUID(),upper])).rows[0];
  }
  return row;
 });
 let count=0;
 for(;;){
  const rows=await transaction(tenantId,async tx=>{
   await authorize(tx,actor);
   return (await tx.query(`SELECT c.object_id,COALESCE(d.active,false) active FROM (${candidates}) c
    LEFT JOIN graph_directory_projection d ON d.tenant_id=$1 AND d.object_id=c.object_id
    WHERE ($2::uuid IS NULL OR c.object_id>$2) AND c.object_id<=$3 ORDER BY c.object_id LIMIT 100`,[tenantId,cursor.after_object_id,cursor.upper_object_id])).rows;
  });
  if(!rows.length){
   await transaction(tenantId,async tx=>{
    await authorize(tx,actor);await lockCursor(tx,tenantId,cursor);
    const result=await tx.query(`UPDATE graph_manager_checkpoints SET completed_at=now(),updated_at=now() WHERE tenant_id=$1 RETURNING processed`,[tenantId]);
    await audit(tx,actor,'GRAPH_MANAGER_CYCLE','directory-accounts',null,{count:result.rows[0].processed});
   });
   return count;
  }
  for(const row of rows){
   // Recheck before every remote read and again in the atomic write transaction.
   await transaction(tenantId,tx=>authorize(tx,actor));
   const observed=await readManager(graph,row.object_id,row.active);
   await transaction(tenantId,async tx=>{
    await authorize(tx,actor);await lockCursor(tx,tenantId,cursor);
    const active=(await tx.query('SELECT active FROM graph_directory_projection WHERE tenant_id=$1 AND object_id=$2 FOR SHARE',[tenantId,row.object_id])).rows[0]?.active;
    const current=active?observed:{managerId:null,resolution:'inactive'};
    await tx.query(`INSERT INTO graph_manager_projection(tenant_id,object_id,manager_object_id,resolution) VALUES($1,$2,$3,$4)
     ON CONFLICT(tenant_id,object_id) DO UPDATE SET manager_object_id=EXCLUDED.manager_object_id,resolution=EXCLUDED.resolution,checked_at=now()`,[tenantId,row.object_id,current.managerId,current.resolution]);
    await tx.query(`UPDATE graph_manager_checkpoints SET after_object_id=$2,processed=processed+1,updated_at=now() WHERE tenant_id=$1`,[tenantId,row.object_id]);
   });
   cursor.after_object_id=row.object_id;count++;
  }
 }
}
