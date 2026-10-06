import {z} from 'zod';
import {isoDate} from './validation';
import {domains} from './registry';
import {AppError} from './errors';
import {assertPermission,matchingGrants} from './policy';
import type {Actor} from './types';
import type {DbClient} from './db';
const filtersSchema=z.object({date:isoDate.optional(),orgId:z.uuid().optional()}).strict();
export type ScheduledReportRequest={domain:string;format:'csv'|'xlsx';date:string;orgId?:string};
export function reportRequest(data:Record<string,unknown>,runDate:string):ScheduledReportRequest{
 const domain=String(data.domain);if(!domains[domain])throw new AppError(422,'UNKNOWN_REPORT_DOMAIN');
 let filters:unknown;try{filters=JSON.parse(String(data.filters));}catch{throw new AppError(422,'INVALID_REPORT_FILTERS');}
 const parsed=filtersSchema.safeParse(filters);if(!parsed.success)throw new AppError(422,'INVALID_REPORT_FILTERS');
 const format=data.format??'csv';if(format!=='csv'&&format!=='xlsx')throw new AppError(422,'INVALID_REPORT_FORMAT');
 const interval=Number(data.intervalHours);if(!Number.isFinite(interval)||interval<1||interval>8760)throw new AppError(422,'INVALID_INTERVAL');
 return {domain,format,date:parsed.data.date??isoDate.parse(runDate),orgId:parsed.data.orgId};
}
export async function assertReportTarget(actor:Actor,request:ScheduledReportRequest,tx:DbClient){
 for(const operation of ['READ','EXPORT']){
  if(!matchingGrants(actor,request.domain,operation).length)throw new AppError(403,'REPORT_PERMISSION_DENIED');
  if(request.orgId)await assertPermission(actor,request.domain,operation,request.orgId,undefined,tx,request.date);
 }
}
