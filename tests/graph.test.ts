import { describe, it, expect } from 'vitest';
import { GraphClient, GraphError, retryDelay, validateGraphUrl, type GraphReader } from '../src/lib/graph/client';
import { synchronizeUsers, USERS_INITIAL, type Checkpoint, type DirectoryStore, type DirectoryUser } from '../src/lib/graph/sync';

const guid = (n:number) => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const next = (n:number) => `https://graph.microsoft.com/v1.0/users/delta?$skiptoken=${n}`;
const delta = 'https://graph.microsoft.com/v1.0/users/delta?$deltatoken=done';
class MemoryStore implements DirectoryStore {
  state:Checkpoint={nextUrl:null,deltaUrl:null,generation:guid(999),fullScan:true};
  users=new Map<string,DirectoryUser>(); commits=0; failAt=0;
  async checkpoint(){return {...this.state};}
  async reset(generation:string){this.state={nextUrl:null,deltaUrl:null,generation,fullScan:true};}
  async commitPage(users:DirectoryUser[],state:Checkpoint){
    if(this.failAt===this.commits+1)throw new Error('simulated transaction failure');
    for(const user of users)this.users.set(user.id,user);
    this.state={...state};this.commits++;
  }
}
describe('read-only Graph security and resilience',()=>{
  it('rejects foreign hosts, path changes, credentials, fragments, and insecure URLs',()=>{
    for(const url of ['http://graph.microsoft.com/v1.0/users/delta','https://evil.example/v1.0/users/delta','https://graph.microsoft.com.evil.test/v1.0/users/delta','https://u:p@graph.microsoft.com/v1.0/users/delta','https://graph.microsoft.com/v1.0/users/delta#fragment','https://graph.microsoft.com/v1.0/groups'])expect(()=>validateGraphUrl(url,'/v1.0/users/delta')).toThrow();
    expect(validateGraphUrl(next(1),'/v1.0/users/delta').href).toBe(next(1));
  });
  it('uses GET only, rejects redirects and respects throttling before retrying',async()=>{
    const requests:RequestInit[]=[];const sleeps:number[]=[];let calls=0;
    const request=async(_url:unknown,init?:RequestInit)=>{requests.push(init!);calls++;return calls===1?new Response('',{status:429,headers:{'Retry-After':'2'}}):Response.json({value:[]});};
    const client=new GraphClient(async()=> 'fake-token',request as typeof fetch,async ms=>{sleeps.push(ms);});
    await client.get(USERS_INITIAL);
    expect(sleeps).toEqual([2000]);expect(requests.every(x=>x.method==='GET'&&x.redirect==='error')).toBe(true);
  });
  it('handles seconds and HTTP-date retry values and bounds retry attempts',async()=>{
    expect(retryDelay('3',0,0)).toBe(3000);expect(retryDelay('Thu, 01 Jan 1970 00:00:02 GMT',0,0)).toBe(2000);
    let calls=0;const client=new GraphClient(async()=> 'fake',async()=>{calls++;return new Response('',{status:503});},async()=>{});
    await expect(client.get(USERS_INITIAL)).rejects.toBeInstanceOf(GraphError);expect(calls).toBe(5);
  });
  it('follows empty pages, retains opaque links and resumes after an atomic page failure',async()=>{
    const store=new MemoryStore();store.failAt=2;
    const pages:Record<string,unknown>={ [USERS_INITIAL]:{value:[{id:guid(1)}],'@odata.nextLink':next(2)},[next(2)]:{value:[],'@odata.nextLink':next(3)},[next(3)]:{value:[{id:guid(2)}],'@odata.deltaLink':delta} };
    const seen:string[]=[];const graph:GraphReader={async get<T>(url:string){seen.push(url);return pages[url] as T;}};
    await expect(synchronizeUsers(graph,store)).rejects.toThrow('transaction');expect(store.state.nextUrl).toBe(next(2));expect(store.users.size).toBe(1);
    store.failAt=0;await synchronizeUsers(graph,store);expect(seen).toEqual([USERS_INITIAL,next(2),next(2),next(3)]);expect(store.users.size).toBe(2);expect(store.state.deltaUrl).toBe(delta);
  });
  it('resets an expired delta cursor for full reconciliation',async()=>{
    const store=new MemoryStore();store.state={...store.state,deltaUrl:delta,fullScan:false};
    const graph:GraphReader={async get<T>(url:string){if(url===delta)throw new GraphError(410);return {value:[{id:guid(1)}],'@odata.deltaLink':delta} as T;}};
    await synchronizeUsers(graph,store);expect(store.state.generation).not.toBe(guid(999));expect(store.state.fullScan).toBe(false);
  });
  it('processes 50,000 synthetic accounts across bounded pages',async()=>{
    const store=new MemoryStore();let calls=0;
    const graph:GraphReader={async get<T>(){const page=calls++;const value=Array.from({length:500},(_,i)=>({id:guid(page*500+i),accountEnabled:true,userType:'Member'}));return {value,...(page===99?{'@odata.deltaLink':delta}:{'@odata.nextLink':next(page+1)})} as T;}};
    expect(await synchronizeUsers(graph,store)).toBe(50_000);expect(calls).toBe(100);expect(store.commits).toBe(100);expect(store.users.size).toBe(50_000);
  });
  it('rejects poisoned continuations before any page commit',async()=>{
    const store=new MemoryStore();const graph:GraphReader={async get<T>(){return {value:[{id:guid(1)}],'@odata.nextLink':'https://localhost/admin'} as T;}};
    await expect(synchronizeUsers(graph,store)).rejects.toThrow();expect(store.commits).toBe(0);
  });
});
