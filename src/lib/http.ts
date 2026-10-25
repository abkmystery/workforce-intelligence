import { ZodError } from 'zod';import { AppError } from './errors';import {getActor,assertSameOrigin} from './auth';import {transaction} from './db';import type {Actor} from './types';
export async function api(request:Request,fn:(actor:Actor)=>Promise<unknown>){try{if(!['GET','HEAD'].includes(request.method))assertSameOrigin(request);const actor=await getActor();await transaction(actor.tenantId,async tx=>{const result=await tx.query("INSERT INTO request_limits(tenant_id,principal_id,bucket,count) VALUES($1,$2,date_trunc('minute',now()),1) ON CONFLICT(tenant_id,principal_id,bucket) DO UPDATE SET count=request_limits.count+1 RETURNING count",[actor.tenantId,actor.userId]);if(result.rows[0].count>240)throw new AppError(429,'RATE_LIMITED');});const result=await fn(actor);return Response.json(result,{headers:{'Cache-Control':'no-store'}});}catch(error){const status=error instanceof AppError?error.status:error instanceof ZodError?422:503;const code=error instanceof AppError?error.code:error instanceof ZodError?'INVALID_INPUT':'SERVICE_UNAVAILABLE';return Response.json({error:{code,message:error instanceof AppError?error.message:error instanceof ZodError?'Check the submitted fields.':'The service is unavailable. Retry or contact an administrator.'}},{status,headers:{'Cache-Control':'no-store'}});}}
export async function jsonBody(request: Request) {
 const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
 if (contentType !== 'application/json') throw new AppError(415, 'JSON_REQUIRED');
 const limit = 128000;
 const length = request.headers.get('content-length');
 if (length && /^\d+$/.test(length) && Number(length) > limit) throw new AppError(413, 'REQUEST_TOO_LARGE');
 const reader = request.body?.getReader();
 const chunks: Uint8Array[] = [];
 let size = 0;
 if (reader) {
  try {
   while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
     await reader.cancel().catch(() => undefined);
     throw new AppError(413, 'REQUEST_TOO_LARGE');
    }
    chunks.push(value);
   }
  } finally { reader.releaseLock(); }
 }
 try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
 catch { throw new AppError(400, 'INVALID_JSON'); }
}
