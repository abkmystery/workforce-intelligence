import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transaction,closeDatabase} from '../../src/lib/db';
import {mutateRecord} from '../../src/lib/records';
import {financeReport} from '../../src/lib/finance';
import {domains} from '../../src/lib/registry';
import type {Actor} from '../../src/lib/types';

const tenantId=randomUUID(),userId=randomUUID();
const actor:Actor={tenantId,userId,sessionId:'synthetic-finance',roles:[],authVersion:1,grants:[...Object.values(domains).map(d=>({domain:d.key,operation:'*',dataClass:d.dataClass,orgId:null,scope:'tenant' as const,validFrom:'2000-01-01',validTo:null})),{domain:'compensation',operation:'AGGREGATE',dataClass:'cost',orgId:null,scope:'tenant',validFrom:'2000-01-01',validTo:null}]};
describe.skipIf(!process.env.TEST_DATABASE_URL)('financial forecast scope and source integrity',()=>{
 let org:string,smallOrg:string;
 beforeAll(async()=>{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  await transaction(tenantId,async tx=>{await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[tenantId,'SYNTHETIC finance']);await tx.query('INSERT INTO principals(id,tenant_id,entra_object_id) VALUES($1,$2,$3)',[userId,tenantId,randomUUID()]);});
  org=(await mutateRecord(actor,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'SYN-FIN',name:'Synthetic finance',orgType:'Team'}})).id;
  smallOrg=(await mutateRecord(actor,'org-units',{operation:'CREATE',validFrom:'2026-01-01',data:{code:'SYN-SMALL',name:'Synthetic small team',orgType:'Team'}})).id;
  const calendar=await mutateRecord(actor,'calendars',{operation:'CREATE',validFrom:'2026-01-01',data:{name:'Synthetic weekdays',weekdays:'1,2,3,4,5',hoursPerDay:8}});
  for(let i=0;i<6;i++){
   const workerOrg=i===5?smallOrg:org;
   const w=await mutateRecord(actor,'workers',{operation:'CREATE',orgId:workerOrg,validFrom:'2026-01-01',data:{code:'SYN-FIN-'+i,workerType:'manual-only',employmentStatus:'active',homeOrgId:workerOrg}});
   await mutateRecord(actor,'contracts',{operation:'CREATE',orgId:workerOrg,workerId:w.id,validFrom:'2026-01-01',data:{fte:1,weeklyHours:40,calendarId:calendar.id,movable:false}});
   await mutateRecord(actor,'compensation',{operation:'CREATE',orgId:workerOrg,workerId:w.id,validFrom:'2026-01-01',data:{amount:36500,currency:'EUR',basis:'annual',paidFte:1,burdenPercent:0,source:'Synthetic fixture'}});
  }
  const fx=await mutateRecord(actor,'fx-rates',{operation:'CREATE',validFrom:'2026-01-01',data:{fromCurrency:'EUR',toCurrency:'USD',rate:2,source:'Synthetic'}});
  await mutateRecord(actor,'fx-rates',{operation:'UPDATE',id:fx.id,version:fx.version,validFrom:'2026-10-01',data:{rate:3}});
  for(const [fiscalYear,amount]of [[2026,365000],[2025,99999999]])await mutateRecord(actor,'budgets',{operation:'CREATE',orgId:org,validFrom:'2025-01-01',data:{name:'Synthetic annual budget',amount,currency:'USD',ownerId:userId,fiscalYear,kind:'budget'}});
 });
 afterAll(closeDatabase);
 it('uses the dated FX revision and matching fiscal-year budget',async()=>{const r=await financeReport(actor,'2026-09-23',org);expect(r.cost).toBe('30000.00');expect(r.budget).toBe('30000.00');expect(r.variance).toBe('0.00');expect(JSON.stringify(r)).not.toContain('36500');});
 it('reports a hidden budget as unavailable, not zero',async()=>{const viewer={...actor,grants:actor.grants.filter(g=>g.domain!=='budgets')};const r=await financeReport(viewer,'2026-09-23',org);expect(r.cost).toBe('30000.00');expect(r.budget).toBe('unavailable');expect(r.variance).toBe('unavailable');});
 it('does not calculate from hidden contract or FX records',async()=>{for(const hidden of ['contracts','fx-rates']){const r=await financeReport({...actor,grants:actor.grants.filter(g=>g.domain!==hidden)},'2026-09-23',org);expect(r.cost).toBe('unavailable');expect(r.cohort).toBe('unavailable');}});
 it('does not treat a salary read role as a cost-aggregate grant',async()=>{await expect(financeReport({...actor,grants:actor.grants.filter(g=>g.dataClass!=='cost')},'2026-09-23',org)).rejects.toMatchObject({code:'COST_AGGREGATE_PERMISSION_REQUIRED'});});
 it('does not report zero for a budget permission limited to a different organization',async()=>{
  const viewer:Actor={...actor,grants:actor.grants.map(g=>g.domain==='budgets'?{...g,orgId:smallOrg,scope:'org'}:g)};
  expect((await financeReport(viewer,'2026-09-23',org)).budget).toBe('unavailable');
  expect((await financeReport(viewer,'2026-09-23',undefined)).budget).toBe('unavailable');
 });
 it('fails closed on malformed cohort settings for a single-worker team',async()=>{
  await transaction(tenantId,tx=>tx.query('UPDATE tenants SET settings=$2 WHERE id=$1',[tenantId,{minimumCostCohort:'invalid'}]));
  try{const report=await financeReport(actor,'2026-09-23',smallOrg);expect(report.cost).toBe('suppressed');expect(report.cohort).toBe('suppressed');}
  finally{await transaction(tenantId,tx=>tx.query("UPDATE tenants SET settings='{}' WHERE id=$1",[tenantId]));}
 });
});
