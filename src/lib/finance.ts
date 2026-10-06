import Decimal from 'decimal.js';
import type { Actor } from './types';
import { transaction } from './db';
import { AppError } from './errors';
import { matchingGrants, assertFresh, assertPermission, scopePredicate } from './policy';
import { datedSource } from './records';
import { isoDate } from './validation';
import { loadedCost } from './math';
import { audit } from './audit';

// Month-start forecast only. Complete period costing and anti-differencing controls
// remain required before this report is suitable for production financial disclosure.
export async function financeReport(actor:Actor,date:string,orgId:string|undefined,currency='USD'){
 isoDate.parse(date);if(!/^[A-Z]{3}$/.test(currency))throw new AppError(422,'INVALID_CURRENCY');
 if(!matchingGrants(actor,'compensation','AGGREGATE','cost').length)throw new AppError(403,'COST_AGGREGATE_PERMISSION_REQUIRED');
 const from=date.slice(0,7)+'-01';const end=new Date(from+'T00:00:00Z');end.setUTCMonth(end.getUTCMonth()+1);const to=end.toISOString().slice(0,10),days=(end.getTime()-Date.parse(from))/86400000;const year=Number(from.slice(0,4)),yearDays=(Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/86400000;
 return transaction(actor.tenantId,async tx=>{
  await assertFresh(actor,tx);
  const support=['contracts','fx-rates'].every(domain=>[...matchingGrants(actor,domain,'READ'),...matchingGrants(actor,domain,'AGGREGATE')].some(g=>g.scope==='tenant'));
  if(!support)return {period:{from,to},currency,cost:'unavailable',budget:'unavailable',variance:'unavailable',cohort:'unavailable',definition:'Complete aggregate access to contracts and exchange rates is required.'};
  const values:unknown[]=[actor.tenantId,from];const permission=scopePredicate(actor,'compensation','AGGREGATE','p',values,from,'cost');let org='';if(orgId){values.push(orgId);org='AND p.org_id=$'+values.length+'::uuid';}
  const rows=(await tx.query(`SELECT p.worker_id,p.data,c.data contract,count(*) OVER(PARTITION BY p.worker_id) source_count FROM ${datedSource('compensation')} p LEFT JOIN ${datedSource('contracts')} c ON c.worker_id=p.worker_id AND c.state<>'archived' AND (c.valid_to IS NULL OR c.valid_to>$2::date) WHERE p.state<>'archived' AND (p.valid_to IS NULL OR p.valid_to>$2::date) AND ${permission} ${org}`,values)).rows;
  const cohort=new Set(rows.map(r=>r.worker_id)).size;const setting=(await tx.query('SELECT settings FROM tenants WHERE id=$1',[actor.tenantId])).rows[0]?.settings??{};const configuredMinimum=Number(setting.minimumCostCohort??5),minimum=Number.isSafeInteger(configuredMinimum)&&configuredMinimum>=5?configuredMinimum:5;
  await audit(tx,actor,'COST_AGGREGATE','compensation',null,{count:cohort});
  if(cohort<minimum)return {period:{from,to},currency,cost:'suppressed',budget:'suppressed',variance:'suppressed',cohort:'suppressed',definition:'Monthly payroll forecast using effective rates at the first day of the month. Small cohorts are suppressed.'};
  const fx=(await tx.query(`SELECT DISTINCT ON(f.data->>'fromCurrency') f.data FROM ${datedSource('fx-rates')} f WHERE f.state<>'archived' AND (f.valid_to IS NULL OR f.valid_to>$2::date) AND f.data->>'toCurrency'=$3 ORDER BY f.data->>'fromCurrency',f.valid_from DESC,f.version DESC,f.id`,[actor.tenantId,from,currency])).rows;const rates=new Map(fx.map(r=>[String(r.data.fromCurrency),Number(r.data.rate)]));rates.set(currency,1);
  let cost=new Decimal(0);let missingRates=0,missingContracts=0;const ambiguousWorkers=new Set<string>();
  for(const row of rows){if(Number(row.source_count)!==1){ambiguousWorkers.add(row.worker_id);continue;}const data=row.data,rate=rates.get(String(data.currency));if(!rate){missingRates++;continue;}if(!row.contract){missingContracts++;continue;}cost=cost.plus(loadedCost({amount:data.amount,basis:data.basis,paidFte:data.paidFte,bonus:data.bonus,burdenPercent:data.burdenPercent,fx:rate,periodDays:days,yearDays,weeklyHours:row.contract.weeklyHours}));}
  let canReadBudget=matchingGrants(actor,'budgets','READ','cost').some(g=>g.scope==='tenant');
  if(!canReadBudget&&orgId){try{await assertPermission(actor,'budgets','READ',orgId,'cost',tx,from);canReadBudget=true;}catch(error){if(!(error instanceof AppError&&error.status===403))throw error;}}
  const bv:unknown[]=[actor.tenantId,from];const bp=scopePredicate(actor,'budgets','READ','b',bv,from,'cost');let bo='';if(orgId){bv.push(orgId);bo='AND b.org_id=$'+bv.length+'::uuid';}bv.push(currency);const cp='$'+bv.length;bv.push(String(year));const yp='$'+bv.length;
  const budgets=canReadBudget?(await tx.query(`SELECT COALESCE(sum((b.data->>'amount')::numeric),0) amount FROM ${datedSource('budgets')} b WHERE b.state<>'archived' AND (b.valid_to IS NULL OR b.valid_to>$2::date) AND b.data->>'currency'=${cp} AND b.data->>'fiscalYear'=${yp} AND b.data->>'kind'='budget' AND ${bp} ${bo}`,bv)).rows[0]:undefined;
  const budget=budgets?new Decimal(budgets.amount).mul(days).div(yearDays):undefined,incomplete=missingRates>0||missingContracts>0||ambiguousWorkers.size>0;
  return {period:{from,to},currency,cost:incomplete?'incomplete':cost.toFixed(2),budget:budget?.toFixed(2)??'unavailable',variance:!budget?'unavailable':incomplete?'incomplete':budget.minus(cost).toFixed(2),cohort,quality:{missingRates,missingContracts,ambiguousWorkers:ambiguousWorkers.size},definition:'Monthly payroll forecast, using effective rates at month start, paid FTE, burden, FX and calendar-day proration. Annual budget for the matching fiscal year is prorated to this month. Reallocating cost centers does not create enterprise savings.'};
 });
}
