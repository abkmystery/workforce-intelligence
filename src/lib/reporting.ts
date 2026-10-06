import type {Actor} from './types';
import {transaction} from './db';
import {assertFresh,matchingGrants,scopePredicate} from './policy';
import {datedSource,today} from './records';
import {isoDate} from './validation';
import {AppError} from './errors';
import {currentRows,historicalRows,effectiveRowsById} from './dating';
export async function overview(actor:Actor,inputDate?:string,orgId?:string){
 const date=isoDate.parse(inputDate??today());
 if(!matchingGrants(actor,'workers','READ').length&&!matchingGrants(actor,'workers','AGGREGATE').length)throw new AppError(403,'PERMISSION_DENIED');
 // Hidden assignments must never appear as free capacity.
 const canCalculate=['contracts','assignments','availability','calendars','holidays'].every(d=>[...matchingGrants(actor,d,'READ'),...matchingGrants(actor,d,'AGGREGATE')].some(g=>g.scope==='tenant'));
 return transaction(actor.tenantId,async tx=>{
  await assertFresh(actor,tx);
  // The measured 100k-worker aggregates spilled at PostgreSQL's 4MB default.
  // Bound this transaction to 32MB per plan operation, without changing the
  // connection pool's global memory settings or the statement timeout.
  await tx.query("SET LOCAL work_mem='32MB'");
  const values:unknown[]=[actor.tenantId,date];
  const predicate='('+scopePredicate(actor,'workers','READ','w',values,date)+' OR '+scopePredicate(actor,'workers','AGGREGATE','w',values,date)+')';
  const org=orgId?' AND '+scopePredicate({...actor,grants:[{domain:'workers',operation:'READ',dataClass:'planning',orgId,scope:'subtree',validFrom:'0001-01-01',validTo:null}]},'workers','READ','w',values,date):'';
  const scope=`SELECT w.* FROM ${effectiveRowsById('workers')} w WHERE w.state<>'archived' AND w.data->>'employmentStatus' IN ('active','leave') AND (w.valid_to IS NULL OR w.valid_to>$2::date) AND ${predicate}${org}`;
  const count=Number((await tx.query(`SELECT count(*) n FROM (${scope}) visible`,values)).rows[0].n);
  const show=(value:unknown)=>count<5?'suppressed':Number(value);
  const metrics:{label:string;value:number|string;description:string}[]=[{label:'Unique active people',value:show(count),description:'Stable resource IDs counted once by primary home organization.'}];
  if(!canCalculate){for(const label of ['Contracted FTE','Work-eligible FTE','Committed allocation FTE','Confirmed available FTE'])metrics.push({label,value:'unavailable',description:'Complete aggregate access to contracts, assignments, leave and calendars is required.'});return {asOf:date,metrics,quality:[{label:'Capacity evidence',value:'permission incomplete'}]};}
  const result=await tx.query(`WITH scoped AS (${scope}),
  contracts_at AS (SELECT c.* FROM ${datedSource('contracts')} c WHERE c.state<>'archived' AND (c.valid_to IS NULL OR c.valid_to>$2::date)),
  holiday_at AS (SELECT DISTINCT (h.data->>'calendarId')::uuid calendar_id FROM ${datedSource('holidays')} h WHERE h.state<>'archived' AND h.data->>'date'=$2::text AND (h.valid_to IS NULL OR h.valid_to>$2::date)),
  calendar_at AS MATERIALIZED (SELECT c.id,extract(isodow from $2::date)::text=ANY(string_to_array(c.data->>'weekdays',',')) AND h.calendar_id IS NULL working_day FROM ${datedSource('calendars')} c LEFT JOIN holiday_at h ON h.calendar_id=c.id WHERE c.state<>'archived' AND (c.valid_to IS NULL OR c.valid_to>$2::date)),
  alloc_at AS (SELECT a.worker_id,sum((a.data->>'fte')::numeric) fte FROM ${currentRows('assignments')} a WHERE a.state<>'archived' AND a.data->>'allocationStatus' IN ('committed','actual') AND (a.valid_to IS NULL OR a.valid_to>$2::date) GROUP BY a.worker_id),
  alloc_history AS (SELECT a.worker_id,sum((a.data->>'fte')::numeric) fte FROM ${historicalRows('assignments')} a WHERE a.state<>'archived' AND a.data->>'allocationStatus' IN ('committed','actual') AND (a.valid_to IS NULL OR a.valid_to>$2::date) GROUP BY a.worker_id),
  leave_at AS (SELECT l.worker_id,sum((l.data->>'fraction')::numeric) fraction FROM ${currentRows('availability')} l WHERE l.state<>'archived' AND l.data->>'approved'='true' AND (l.valid_to IS NULL OR l.valid_to>$2::date) GROUP BY l.worker_id),
  leave_history AS (SELECT l.worker_id,sum((l.data->>'fraction')::numeric) fraction FROM ${historicalRows('availability')} l WHERE l.state<>'archived' AND l.data->>'approved'='true' AND (l.valid_to IS NULL OR l.valid_to>$2::date) GROUP BY l.worker_id),
  capacity AS MATERIALIZED (SELECT c.id IS NULL missing_contract,COALESCE((c.data->>'fte')::numeric,0) fte,
  CASE WHEN cal.id IS NULL THEN NULL WHEN cal.working_day THEN GREATEST(0,1-COALESCE(l.fraction,0)-COALESCE(lh.fraction,0)) ELSE 0 END eligible_fraction,
  c.data->>'movable'='true' AND (c.data->>'confirmedOn')::date BETWEEN $2::date-30 AND $2::date confirmed_movable,
  COALESCE(a.fte,0)+COALESCE(ah.fte,0) committed FROM scoped w LEFT JOIN contracts_at c ON c.worker_id=w.id LEFT JOIN calendar_at cal ON cal.id=(c.data->>'calendarId')::uuid LEFT JOIN alloc_at a ON a.worker_id=w.id LEFT JOIN alloc_history ah ON ah.worker_id=w.id LEFT JOIN leave_at l ON l.worker_id=w.id LEFT JOIN leave_history lh ON lh.worker_id=w.id)
  SELECT count(*) FILTER(WHERE missing_contract OR eligible_fraction IS NULL) unknown,COALESCE(sum(fte),0) contracted,
  COALESCE(sum(fte*eligible_fraction),0) eligible,COALESCE(sum(fte*eligible_fraction*committed),0) allocated,
  COALESCE(sum(fte*eligible_fraction*GREATEST(0,1-committed)) FILTER(WHERE confirmed_movable),0) available FROM capacity`,values);
  const r=result.rows[0];
  for(const [label,key,description]of [
   ['Contracted FTE','contracted','Effective work contracts. Missing contracts remain unknown.'],
   ['Work-eligible FTE','eligible','Contracts adjusted for calendars, holidays and approved leave.'],
   ['Committed allocation FTE','allocated','Eligible FTE multiplied by committed or actual allocation fractions.'],
   ['Confirmed available FTE','available','Uncommitted capacity confirmed by a manager within 30 days; review skills and constraints before moving.']
  ])metrics.push({label,value:show(r[key]),description});
  return {asOf:date,metrics,quality:[{label:'Unknown contract or calendar',value:show(r.unknown)}]};
 });
}

