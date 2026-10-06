import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transaction,closeDatabase} from '../../src/lib/db';
import {mutateRecord} from '../../src/lib/records';
import {domains} from '../../src/lib/registry';
import type {Actor,RecordRow} from '../../src/lib/types';

const tenantId=randomUUID(),userId=randomUUID();
const actor:Actor={tenantId,userId,sessionId:'synthetic',roles:[],authVersion:1,grants:Object.values(domains).map(d=>({domain:d.key,operation:'*',dataClass:d.dataClass,scope:'tenant',orgId:null,validFrom:'2000-01-01',validTo:null}))};
describe.skipIf(!process.env.TEST_DATABASE_URL)('effective scoped field policy enforcement',()=>{
 let org:string,otherOrg:string,worker:RecordRow,directory:RecordRow;
 beforeAll(async()=>{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  await transaction(tenantId,async tx=>{await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[tenantId,'SYNTHETIC policy test']);await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[userId,tenantId,randomUUID()]);});
  org=(await mutateRecord(actor,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'SYN-OWN',name:'Synthetic home',orgType:'Team'}})).id;
  otherOrg=(await mutateRecord(actor,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'SYN-OTHER',name:'Synthetic other',orgType:'Team'}})).id;
  worker=await mutateRecord(actor,'workers',{operation:'CREATE',orgId:org,validFrom:'2026-01-01',data:{code:'SYN-WORKER',homeOrgId:org,workerType:'manual-only',employmentStatus:'active',title:'Initial'}});
  directory=await mutateRecord(actor,'directory-accounts',{operation:'CREATE',orgId:org,workerId:worker.id,validFrom:'2026-01-01',data:{objectId:randomUUID(),enabled:true,directoryTitle:'Initial'}});
 });
 afterAll(closeDatabase);
 const policy=(domain:string,field:string,orgId:string|null,owner:string,overrideAllowed:boolean,validFrom='2026-01-01',validTo?:string)=>mutateRecord(actor,'field-policies',{operation:'CREATE',orgId,validFrom,validTo,data:{domain,field,owner,overrideAllowed}});
 const override=()=>mutateRecord(actor,'overrides',{operation:'CREATE',orgId:org,workerId:worker.id,validFrom:'2026-06-01',data:{domain:'directory-accounts',recordId:directory.id,field:'directoryTitle',value:'Approved alternative',reason:'Synthetic reconciliation',expiresOn:'2099-01-01'}});
 it('does not apply another organization or a future ownership policy to an edit',async()=>{
  await policy('workers','title',otherOrg,'Entra',false);
  await policy('workers','title',org,'Entra',false,'2027-01-01');
  const changed=await mutateRecord(actor,'workers',{operation:'UPDATE',id:worker.id,version:worker.version,validFrom:'2026-06-01',data:{title:'Permitted local edit'}});
  worker=changed;expect(changed.data.title).toBe('Permitted local edit');
  await expect(mutateRecord(actor,'workers',{operation:'UPDATE',id:worker.id,version:worker.version,validFrom:'2027-01-01',data:{title:'Blocked upstream edit'}})).rejects.toMatchObject({code:'UPSTREAM_FIELD_REQUIRES_OVERRIDE'});
 });
 it('does not authorize overrides from foreign, future or expired policy rows',async()=>{
  await policy('directory-accounts','directoryTitle',otherOrg,'Entra',true);
  await policy('directory-accounts','directoryTitle',org,'Entra',true,'2027-01-01');
  await policy('directory-accounts','directoryTitle',org,'Entra',true,'2025-01-01','2026-01-01');
  await expect(override()).rejects.toMatchObject({code:'OVERRIDE_NOT_ALLOWED'});
 });
 it('lets a specific deny override a tenant allow and a worker policy override an org policy',async()=>{
  await policy('directory-accounts','directoryTitle',null,'Entra',true);
  await policy('directory-accounts','directoryTitle',org,'Entra',false);
  await expect(override()).rejects.toMatchObject({code:'OVERRIDE_NOT_ALLOWED'});
  await mutateRecord(actor,'field-policies',{operation:'CREATE',orgId:org,workerId:worker.id,validFrom:'2026-01-01',data:{domain:'directory-accounts',field:'directoryTitle',owner:'Entra',overrideAllowed:true}});
  expect((await override()).state).toBe('draft');
 });
});
