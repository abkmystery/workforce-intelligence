import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transaction,closeDatabase} from '../../src/lib/db';
import {mutateRecord,listRecords,getRecord,recordHistory} from '../../src/lib/records';
import {overview} from '../../src/lib/reporting';
import {domains} from '../../src/lib/registry';
import type {Actor} from '../../src/lib/types';
const tenantId=randomUUID(),userId=randomUUID();
const actor:Actor={tenantId,userId,sessionId:'test',roles:[],authVersion:1,grants:Object.values(domains).map(d=>({domain:d.key,operation:'*',dataClass:d.dataClass,orgId:null,scope:'tenant',validFrom:'2000-01-01',validTo:null}))};
describe.skipIf(!process.env.TEST_DATABASE_URL)('scoped historical reporting',()=>{
 let parent:string,child:string,manager:string,report:string,calendarId:string;
 beforeAll(async()=>{process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;await transaction(tenantId,async tx=>{await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[tenantId,'SYNTHETIC reporting']);await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[userId,tenantId,randomUUID()]);});parent=(await mutateRecord(actor,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'ROOT',name:'Synthetic root',orgType:'Division'}})).id;child=(await mutateRecord(actor,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'CHILD',name:'Synthetic child',orgType:'Team'}})).id;await mutateRecord(actor,'org-edges',{operation:'CREATE',orgId:parent,validFrom:'2026-01-01',data:{parentId:parent,childId:child,hierarchy:'primary'}});
 const calendar=await mutateRecord(actor,'calendars',{operation:'CREATE',validFrom:'2026-01-01',data:{name:'Weekdays',weekdays:'1,2,3,4,5',hoursPerDay:8}});calendarId=calendar.id;const role=await mutateRecord(actor,'roles',{operation:'CREATE',validFrom:'2026-01-01',data:{name:'Analyst'}});
 for(let i=0;i<6;i++){const w=await mutateRecord(actor,'workers',{operation:'CREATE',orgId:child,validFrom:'2026-01-01',data:{code:'SYN-'+i,workerType:'manual-only',employmentStatus:'active',homeOrgId:child}});if(i===0)manager=w.id;if(i===1)report=w.id;await mutateRecord(actor,'contracts',{operation:'CREATE',orgId:child,workerId:w.id,validFrom:'2026-01-01',data:{fte:1,weeklyHours:40,calendarId:calendar.id,movable:true,confirmedOn:'2026-09-01'}});await mutateRecord(actor,'assignments',{operation:'CREATE',orgId:child,workerId:w.id,validFrom:'2026-01-01',data:{roleId:role.id,fte:0.5,allocationStatus:'committed',kind:'primary'}});}
 await mutateRecord(actor,'reporting-lines',{operation:'CREATE',orgId:child,workerId:report,validFrom:'2026-01-01',data:{managerId:manager,kind:'primary'}});await mutateRecord(actor,'holidays',{operation:'CREATE',orgId:child,validFrom:'2026-01-01',data:{calendarId:calendar.id,date:'2026-09-24',name:'Synthetic holiday'}});
 });afterAll(closeDatabase);
 it('AC04 hidden contracts cannot leak through dashboard metrics',async()=>{const scoped={...actor,grants:actor.grants.filter(g=>g.domain==='workers')};const result=await overview(scoped,'2026-09-23');expect(result.metrics.find(m=>m.label==='Unique active people')?.value).toBe(6);expect(result.metrics.find(m=>m.label==='Contracted FTE')?.value).toBe('unavailable');});
 it('AC11 reports grants resolve worker IDs for lists, details and history',async()=>{const scoped:Actor={...actor,grants:[{domain:'workers',operation:'READ',dataClass:'planning',orgId:manager,scope:'reports',validFrom:'2000-01-01',validTo:null}]};const result=await listRecords(scoped,'workers',{date:'2026-09-23'});expect(result.rows.map(r=>r.id)).toEqual([report]);expect((await getRecord(scoped,'workers',report)).id).toBe(report);expect((await recordHistory(scoped,'workers',report)).rows.map(row=>row.id)).toEqual([report]);await expect(getRecord(scoped,'workers',manager)).rejects.toMatchObject({status:403});await expect(recordHistory(scoped,'workers',manager)).rejects.toMatchObject({status:403});});
 it('AC11 subtree filters include authorized descendants',async()=>{const result=await listRecords(actor,'workers',{date:'2026-09-23',orgId:parent});expect(result.total).toBe(6);});
 it('AC13 capacity observes holidays and recent manager confirmation',async()=>{const working=await overview(actor,'2026-09-23',parent);expect(working.metrics.find(m=>m.label==='Confirmed available FTE')?.value).toBe(3);const holiday=await overview(actor,'2026-09-24',parent);expect(holiday.metrics.find(m=>m.label==='Work-eligible FTE')?.value).toBe(0);});
 it('holiday duplicates cannot multiply capacity and expired holiday records do not block work',async()=>{
  for(let i=0;i<2;i++)await mutateRecord(actor,'holidays',{operation:'CREATE',orgId:child,validFrom:'2026-01-01',validTo:'2026-09-26',data:{calendarId,date:'2026-09-25',name:'Synthetic duplicate '+i}});
  const duplicate=await overview(actor,'2026-09-25',parent);expect(duplicate.metrics.find(m=>m.label==='Contracted FTE')?.value).toBe(6);expect(duplicate.metrics.find(m=>m.label==='Work-eligible FTE')?.value).toBe(0);
  await mutateRecord(actor,'holidays',{operation:'CREATE',orgId:child,validFrom:'2026-01-01',validTo:'2026-09-28',data:{calendarId,date:'2026-09-28',name:'Expired synthetic holiday'}});
  expect((await overview(actor,'2026-09-28',parent)).metrics.find(m=>m.label==='Work-eligible FTE')?.value).toBe(6);
 });
 it('authorizes historical child records against the worker home effective on that date',async()=>{
  const w=await mutateRecord(actor,'workers',{operation:'CREATE',orgId:child,validFrom:'2026-01-01',data:{code:'SYN-MOVE',workerType:'manual-only',employmentStatus:'active',homeOrgId:child}});
  await mutateRecord(actor,'workers',{operation:'UPDATE',id:w.id,version:w.version,orgId:parent,validFrom:'2027-01-01',data:{homeOrgId:parent}});
  const steward:Actor={...actor,grants:[{domain:'workers',operation:'READ',dataClass:'planning',orgId:child,scope:'org',validFrom:'2000-01-01',validTo:null},{domain:'identities',operation:'CREATE',dataClass:'identity',orgId:child,scope:'org',validFrom:'2000-01-01',validTo:null}]};
  const identity=await mutateRecord(steward,'identities',{operation:'CREATE',orgId:child,workerId:w.id,validFrom:'2026-06-01',data:{displayName:'Synthetic historical identity'}});
  expect(identity.orgId).toBe(child);
  await expect(mutateRecord(steward,'identities',{operation:'CREATE',orgId:child,workerId:w.id,validFrom:'2027-06-01',data:{displayName:'Synthetic wrong organization'}})).rejects.toMatchObject({status:403});
 });
 it('combines current and historical allocations and leave without replacing past worker or contract state',async()=>{
  const org=await mutateRecord(actor,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'CAPACITY-HISTORY',name:'Synthetic dated capacity',orgType:'Team'}});
  const role=(await listRecords(actor,'roles',{date:'2026-09-23'})).rows[0];
  for(let i=0;i<5;i++){
   const w=await mutateRecord(actor,'workers',{operation:'CREATE',orgId:org.id,validFrom:'2026-01-01',data:{code:'SYN-CAPACITY-HISTORY-'+i,workerType:'manual-only',employmentStatus:'active',homeOrgId:org.id}});
   const contract=await mutateRecord(actor,'contracts',{operation:'CREATE',orgId:org.id,workerId:w.id,validFrom:'2026-01-01',data:{fte:1,weeklyHours:40,calendarId,movable:true,confirmedOn:'2026-09-23'}});
   await mutateRecord(actor,'assignments',{operation:'CREATE',orgId:org.id,workerId:w.id,validFrom:'2026-01-01',data:{roleId:role.id,fte:0.4,allocationStatus:'committed',kind:'project'}});
   const allocation=await mutateRecord(actor,'assignments',{operation:'CREATE',orgId:org.id,workerId:w.id,validFrom:'2026-01-01',data:{roleId:role.id,fte:0.2,allocationStatus:'committed',kind:'project'}});
   await mutateRecord(actor,'availability',{operation:'CREATE',orgId:org.id,workerId:w.id,validFrom:'2026-01-01',data:{fraction:0.1,approved:true,kind:'leave'}});
   const leave=await mutateRecord(actor,'availability',{operation:'CREATE',orgId:org.id,workerId:w.id,validFrom:'2026-01-01',data:{fraction:0.2,approved:true,kind:'leave'}});
   await mutateRecord(actor,'workers',{operation:'UPDATE',id:w.id,version:w.version,validFrom:'2027-01-01',data:{employmentStatus:'ended'}});
   await mutateRecord(actor,'contracts',{operation:'UPDATE',id:contract.id,version:contract.version,validFrom:'2027-01-01',data:{fte:0.8}});
   await mutateRecord(actor,'assignments',{operation:'UPDATE',id:allocation.id,version:allocation.version,validFrom:'2027-01-01',data:{fte:0.1}});
   await mutateRecord(actor,'availability',{operation:'UPDATE',id:leave.id,version:leave.version,validFrom:'2027-01-01',data:{fraction:0.1}});
  }
  const result=await overview(actor,'2026-09-23',org.id);const metric=(label:string)=>result.metrics.find(m=>m.label===label)?.value;
  expect(metric('Unique active people')).toBe(5);expect(metric('Contracted FTE')).toBe(5);expect(metric('Work-eligible FTE')).toBe(3.5);expect(metric('Committed allocation FTE')).toBe(2.1);expect(metric('Confirmed available FTE')).toBe(1.4);
 });
});
