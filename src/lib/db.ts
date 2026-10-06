import pg from 'pg';
import type { QueryResultRow, PoolClient } from 'pg';
pg.types.setTypeParser(1082, value => value);
export type DbClient=PoolClient;
let pool:pg.Pool|undefined;
export function database(){ if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required'); return pool ??=new pg.Pool({connectionString:process.env.DATABASE_URL,max:12,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,application_name:'workforce'}); }
export async function query<T extends QueryResultRow=QueryResultRow>(text:string,values:unknown[]=[]):Promise<T[]>{return (await database().query<T>(text,values)).rows;}
export async function transaction<T>(tenantId:string,fn:(tx:DbClient)=>Promise<T>):Promise<T>{const tx=await database().connect();try{await tx.query('BEGIN');await tx.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);await tx.query("SET LOCAL statement_timeout='15s'");const result=await fn(tx);await tx.query('COMMIT');return result;}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}}
export async function closeDatabase(){await pool?.end();pool=undefined;}
