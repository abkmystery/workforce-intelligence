import {beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({query:vi.fn(),txQuery:vi.fn(),transactions:[] as string[][]}));
vi.mock('../src/lib/db',()=>({query:mocks.query,transaction:async(_tenant:string,fn:(tx:unknown)=>Promise<unknown>)=>{const calls:string[]=[];mocks.transactions.push(calls);return fn({query:async(sql:string,values:unknown[])=>{calls.push(sql);return mocks.txQuery(sql,values);}});}}));
vi.mock('../src/lib/audit',()=>({audit:vi.fn()}));
vi.mock('../src/lib/policy',()=>({assertPermission:vi.fn()}));
import {refreshGroups} from '../src/lib/graph/worker';
import {GraphClient} from '../src/lib/graph/client';
const tenant='10000000-0000-0000-0000-000000000000';const group='20000000-0000-0000-0000-000000000000';
const connection={tenant_id:tenant,enabled:true,paused:false,include_guests:false,inclusion_groups:[group]};
beforeEach(()=>{vi.clearAllMocks();mocks.transactions.length=0;mocks.txQuery.mockImplementation(async(sql:string)=>({rows:sql.includes('SELECT DISTINCT group_id')?[{group_id:group}]:sql.includes('SELECT * FROM sync_checkpoints')?[{next_url:null,generation:'30000000-0000-0000-0000-000000000000'}]:[],rowCount:0}));});
describe('group entitlement refresh fail-closed behavior',()=>{
 it('replaces group grants and invalidates grantless sessions atomically after empty membership result',async()=>{
  const graph=new GraphClient(async()=> 'synthetic',async()=>Response.json({value:[]}));
  expect(await refreshGroups(tenant,connection,graph)).toBe(0);
  const replacement=mocks.transactions.find(statements=>statements.some(sql=>sql.includes("DELETE FROM access_grants WHERE tenant_id=$1 AND source='group'")));
  expect(replacement).toBeDefined();expect(replacement!.some(sql=>sql.includes('INSERT INTO access_grants'))).toBe(true);
  expect(replacement!.some(sql=>sql.includes('DELETE FROM sessions'))).toBe(true);expect(replacement!.some(sql=>sql.includes('INSERT INTO graph_entitlement_refresh'))).toBe(true);
 });
 it('does not replace entitlements or mark them fresh after a failed membership page',async()=>{
  const graph=new GraphClient(async()=> 'synthetic',async()=>new Response('',{status:403}));
  await expect(refreshGroups(tenant,connection,graph)).rejects.toThrow();
  expect(mocks.txQuery.mock.calls.some(([sql])=>sql.includes('INSERT INTO graph_entitlement_refresh')||sql.includes('DELETE FROM access_grants'))).toBe(false);
 });
});
