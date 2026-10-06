import {beforeEach,describe,it,expect,vi} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({query:vi.fn(),txQuery:vi.fn(),committed:vi.fn(),rolledBack:vi.fn(),cookies: {get:vi.fn(),set:vi.fn()}}));
vi.mock('next/headers',()=>({cookies:async()=>mocks.cookies}));
vi.mock('../src/lib/db',()=>({query:mocks.query,transaction:async(_tenant:string,fn:(tx:unknown)=>Promise<unknown>)=>{try{const result=await fn({query:mocks.txQuery});mocks.committed();return result;}catch(error){mocks.rolledBack();throw error;}}}));
import {actorForSession,allowedTenants,completeLogin,hashToken,assertSameOrigin} from '../src/lib/auth';
const tenant='10000000-0000-0000-0000-000000000000';
const clientId='20000000-0000-0000-0000-000000000000';
const objectId='30000000-0000-0000-0000-000000000000';
const principalId='40000000-0000-0000-0000-000000000000';
const issuer=`https://login.microsoftonline.com/${tenant}/v2.0`;
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...keys.publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
function jwt(overrides:Record<string,unknown>={},badSignature=false){
 const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key',typ:'JWT'})).toString('base64url');
 const now=Math.floor(Date.now()/1000);
 const payload=Buffer.from(JSON.stringify({iss:issuer,aud:clientId,sub:'subject',oid:objectId,tid:tenant,iat:now,exp:now+300,nonce:'nonce-value',...overrides})).toString('base64url');
 const data=`${header}.${payload}`;return `${data}.${(badSignature?Buffer.alloc(256):sign('RSA-SHA256',Buffer.from(data),keys.privateKey)).toString('base64url')}`;
}
function fakeIdentityProvider(token:string){
 const request=vi.fn(async(input:RequestInfo|URL)=>{
  const url=input instanceof Request?input.url:String(input);
  if(url.includes('.well-known'))return Response.json({issuer,authorization_endpoint:`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,token_endpoint:`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,jwks_uri:`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_post','client_secret_basic']});
  if(url.endsWith('/keys'))return Response.json({keys:[jwk]});
  if(url.endsWith('/token'))return Response.json({token_type:'Bearer',access_token:'synthetic',expires_in:3600,id_token:token});
  throw new Error(`Unexpected request ${url}`);
 });vi.stubGlobal('fetch',request);return request;
}
beforeEach(()=>{
 vi.clearAllMocks();vi.unstubAllGlobals();
 process.env.ENTRA_ALLOWED_TENANTS=tenant;process.env.ENTRA_CLIENT_ID=clientId;process.env.ENTRA_CLIENT_SECRET='synthetic-test-secret';process.env.APP_URL='https://workforce.test';
 mocks.cookies.get.mockReturnValue({value:'b'.repeat(43)});
 mocks.query.mockResolvedValue([{tenant_id:tenant,state:'state-value',nonce:'nonce-value',verifier:'v'.repeat(43)}]);
 mocks.txQuery.mockImplementation(async(sql:string)=>{
  if(sql.includes('INSERT INTO principals'))return {rowCount:1,rows:[{id:principalId,enabled:true,auth_version:1}]};
  if(sql.startsWith('SELECT id FROM tenants')||sql.startsWith('SELECT id FROM access_grants'))return {rowCount:1,rows:[{id:tenant}]};
  return {rowCount:0,rows:[]};
 });
});
describe('Entra authentication boundaries',()=>{
 it('allowlists exact tenant GUIDs and rejects missing configuration',()=>{expect(allowedTenants()).toEqual([tenant]);process.env.ENTRA_ALLOWED_TENANTS='common';expect(()=>allowedTenants()).toThrow();});
 it('hashes opaque session secrets and rejects malformed tokens before a DB read',async()=>{expect(hashToken('secret')).not.toContain('secret');await expect(actorForSession('forged')).rejects.toMatchObject({status:401});expect(mocks.query).not.toHaveBeenCalled();});
 it('rejects cross-origin mutations',()=>{expect(()=>assertSameOrigin(new Request('https://workforce.test/api',{headers:{Origin:'https://evil.test'}}))).toThrow();});
 it('verifies a signed ID token using fetched JWKS before issuing a Secure HttpOnly session',async()=>{
  const fetch=fakeIdentityProvider(jwt());await completeLogin(new URL('https://workforce.test/api/auth/callback?code=synthetic&state=state-value'));
  expect(fetch.mock.calls.some(([url])=>String(url).endsWith('/keys'))).toBe(true);
  expect(mocks.cookies.set).toHaveBeenCalledWith('__Host-wi_session',expect.any(String),expect.objectContaining({secure:true,httpOnly:true,sameSite:'lax',path:'/'}));
 });
 it('commits verified role revocation before rejecting login without remaining grants',async()=>{
  fakeIdentityProvider(jwt({roles:[]}));
  mocks.txQuery.mockImplementation(async(sql:string)=>{
   if(sql.includes('INSERT INTO principals'))return {rowCount:1,rows:[{id:principalId,enabled:true,auth_version:2}]};
   if(sql.startsWith('SELECT id FROM tenants'))return {rowCount:1,rows:[{id:tenant}]};
   return {rowCount:0,rows:[]};
  });
  await expect(completeLogin(new URL('https://workforce.test/api/auth/callback?code=synthetic&state=state-value'))).rejects.toMatchObject({code:'NO_ACCESS_GRANTS'});
  expect(mocks.committed).toHaveBeenCalledOnce();expect(mocks.rolledBack).not.toHaveBeenCalled();
  expect(mocks.txQuery).toHaveBeenCalledWith(expect.stringContaining('auth_version<>$3'),[tenant,principalId,2]);
  expect(mocks.txQuery.mock.calls.some(([sql])=>sql.includes('INSERT INTO sessions'))).toBe(false);
  expect(mocks.cookies.set.mock.calls.some(([name])=>name==='__Host-wi_session')).toBe(false);
 });
 it('requires a completed fresh group generation before materializing login grants',async()=>{
  fakeIdentityProvider(jwt());await completeLogin(new URL('https://workforce.test/api/auth/callback?code=synthetic&state=state-value'));
  const grantSql=mocks.txQuery.mock.calls.find(([sql])=>sql.includes('INSERT INTO access_grants')&&sql.includes("CURRENT_DATE,'group'"))?.[0];
  expect(grantSql).toContain('c.generation=g.generation');expect(grantSql).toContain('c.next_url IS NULL AND c.full_scan=false');expect(grantSql).toContain("c.updated_at>now()-interval '15 minutes'");
 });
 it.each([
  ['signature',{},true],['audience',{aud:'wrong-client'},false],['issuer',{iss:'https://evil.test'},false],['expiry',{exp:1},false],['nonce',{nonce:'wrong'},false],['tenant',{tid:'50000000-0000-0000-0000-000000000000'},false]
 ])('rejects an invalid %s without issuing a session',async(_name,claims,badSignature)=>{
  fakeIdentityProvider(jwt(claims as Record<string,unknown>,badSignature as boolean));
  await expect(completeLogin(new URL('https://workforce.test/api/auth/callback?code=synthetic&state=state-value'))).rejects.toThrow();
  expect(mocks.cookies.set.mock.calls.some(([name])=>name==='__Host-wi_session')).toBe(false);
 });
 it('rejects state mismatch and a replayed browser transaction',async()=>{
  fakeIdentityProvider(jwt());await expect(completeLogin(new URL('https://workforce.test/api/auth/callback?code=x&state=wrong'))).rejects.toThrow();
  mocks.query.mockResolvedValue([]);await expect(completeLogin(new URL('https://workforce.test/api/auth/callback?code=x&state=state-value'))).rejects.toThrow();
 });
 it('denies a valid session after its last grant is removed and queries grants in tenant context',async()=>{
  mocks.query.mockResolvedValue([{tenant_id:tenant,principal_id:principalId,session_id:objectId,roles:['Admin'],auth_version:1}]);
  mocks.txQuery.mockResolvedValue({rows:[],rowCount:0});
  await expect(actorForSession('b'.repeat(43))).rejects.toMatchObject({status:403,code:'NO_ACCESS_GRANTS'});
  expect(mocks.txQuery).toHaveBeenCalledWith(expect.stringContaining("COALESCE(g.source,'manual')"),[tenant,principalId]);
 });
});
