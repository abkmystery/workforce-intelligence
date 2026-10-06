/** Server-side read-only Microsoft Graph transport. */
export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class GraphError extends Error { constructor(public status:number, public retryAfterMs=0){super(`Graph request failed (${status})`);} }
export function validateGraphUrl(value:string,expectedPath?:string):URL {
 const url=new URL(value);
 if(url.origin!==GRAPH_ORIGIN||url.protocol!=='https:'||url.username||url.password||url.hash||!url.pathname.startsWith('/v1.0/')||(expectedPath&&url.pathname!==expectedPath))throw new Error('Untrusted Graph continuation URL');
 return url;
}
export function retryDelay(value:string|null,attempt:number,now=Date.now()):number {
 if(value){const seconds=Number(value);const delay=Number.isFinite(seconds)?seconds*1000:Date.parse(value)-now;if(Number.isFinite(delay)&&delay>=0)return Math.min(delay,3_600_000);}
 return Math.min(1000*2**attempt,60_000);
}
export type GraphPage<T>={value:T[];'@odata.nextLink'?:string;'@odata.deltaLink'?:string};
export interface GraphReader {get<T>(url:string,expectedPath?:string):Promise<T>}
export class GraphClient implements GraphReader {
 constructor(private token:()=>Promise<string>,private request:typeof fetch=fetch,private sleep:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms))){}
 async get<T>(url:string,expectedPath?:string):Promise<T>{
  const safe=validateGraphUrl(url,expectedPath);
  for(let attempt=0;;attempt++){
   const response=await this.request(safe,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${await this.token()}`,Accept:'application/json'},signal:AbortSignal.timeout(30_000)});
   if(response.ok)return await response.json() as T;
   const delay=retryDelay(response.headers.get('retry-after'),attempt);
   if((response.status===429||response.status>=500)&&attempt<4&&delay<=30_000){await this.sleep(delay);continue;}
   throw new GraphError(response.status,delay);
  }
 }
}
export function clientCredentialToken(tenantId:string,clientId:string,secret:string,request:typeof fetch=fetch):()=>Promise<string>{
 if(!GUID.test(tenantId)||!GUID.test(clientId)||!secret)throw new Error('Graph credentials are not configured');
 let cached:{value:string;expires:number}|undefined;
 return async()=>{
  if(cached&&cached.expires>Date.now()+60_000)return cached.value;
  const response=await request(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:secret,grant_type:'client_credentials',scope:'https://graph.microsoft.com/.default'})});
  if(!response.ok)throw new Error(`Graph token acquisition failed (${response.status})`);
  const body=await response.json() as {access_token?:string;expires_in?:number;token_type?:string};
  if(!body.access_token||body.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(body.expires_in))throw new Error('Invalid token response');
  cached={value:body.access_token,expires:Date.now()+Number(body.expires_in)*1000};return cached.value;
 };
}
