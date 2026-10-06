import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {readManager} from '../src/lib/graph/managers';
import {GraphError,type GraphReader} from '../src/lib/graph/client';
const objectId='00000000-0000-0000-0000-000000000001';
const managerId='00000000-0000-0000-0000-000000000002';
describe('manager observation contract',()=>{
 it('pins the per-user URL and records only a validated manager ID',async()=>{
  const get=vi.fn(async()=>({id:managerId}));
  expect(await readManager({get} as GraphReader,objectId,true)).toEqual({managerId,resolution:'resolved'});
  expect(get).toHaveBeenCalledWith(`https://graph.microsoft.com/v1.0/users/${objectId}/manager?$select=id`,`/v1.0/users/${objectId}/manager`);
 });
 it('clears inactive source observations without a remote call',async()=>{
  const get=vi.fn();expect(await readManager({get},objectId,false)).toEqual({managerId:null,resolution:'inactive'});expect(get).not.toHaveBeenCalled();
 });
 it('records 404 as missing but never converts permission or transient failures into removal',async()=>{
  for(const status of [403,404,429,503]){
   const graph:GraphReader={async get(){throw new GraphError(status);}};
   if(status===404)expect(await readManager(graph,objectId,true)).toEqual({managerId:null,resolution:'missing'});
   else await expect(readManager(graph,objectId,true)).rejects.toMatchObject({status});
  }
 });
 it('rejects malformed upstream IDs and source IDs',async()=>{
  const graph:GraphReader={async get<T>(){return {id:'not-an-id'} as T;}};
  await expect(readManager(graph,objectId,true)).rejects.toThrow('Invalid manager');
  await expect(readManager(graph,'../../users',true)).rejects.toThrow('Invalid directory object');
 });
});
