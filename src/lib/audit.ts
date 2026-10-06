import {createHash} from 'node:crypto';
import type {DbClient} from './db';import type {Actor} from './types';
export async function audit(tx:DbClient,actor:Actor,action:string,domain:string,recordId:string|null,metadata:Record<string,unknown>={}){
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor.tenantId+':audit']);
 const {rows}=await tx.query('SELECT event_hash FROM audit_events WHERE tenant_id=$1 ORDER BY id DESC LIMIT 1',[actor.tenantId]);
 const previous=rows[0]?.event_hash??'GENESIS';
 // Caller supplies only operation metadata. Never pass full records, tokens, names or pay.
 const safe=Object.fromEntries(Object.entries(metadata).filter(([k])=>['version','fields','count','decision','reasonCode','jobId','batchId','stage'].includes(k)));
 const eventHash=createHash('sha256').update(JSON.stringify([previous,actor.tenantId,actor.userId,action,domain,recordId,safe])).digest('hex');
 await tx.query('INSERT INTO audit_events(tenant_id,actor_id,action,domain,record_id,metadata,previous_hash,event_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[actor.tenantId,actor.userId,action,domain,recordId,safe,previous,eventHash]);
}
