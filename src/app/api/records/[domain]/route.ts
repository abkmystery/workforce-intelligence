import {api,jsonBody} from '@/lib/http';import {listRecords,mutateRecord} from '@/lib/records';
import { z } from 'zod';
export const dynamic='force-dynamic';
type Context={params:Promise<{domain:string}>};
export async function GET(request:Request,context:Context){const {domain}=await context.params;const q=new URL(request.url).searchParams;return api(request,actor=>listRecords(actor,domain,{date:q.get('date')??undefined,orgId:q.get('orgId')??undefined,search:q.get('search')??undefined,state:q.get('state')??undefined,roleId:q.get('roleId')??undefined,considerForRoles:z.enum(['true','false']).transform(value=>value==='true').optional().parse(q.get('considerForRoles')??undefined),page:Number(q.get('page')??1),pageSize:Number(q.get('pageSize')??50),sort:q.get('sort')??undefined,direction:q.get('direction')??q.get('order')??undefined}));}
export async function POST(request:Request,context:Context){const {domain}=await context.params;return api(request,async actor=>mutateRecord(actor,domain,await jsonBody(request)));}
