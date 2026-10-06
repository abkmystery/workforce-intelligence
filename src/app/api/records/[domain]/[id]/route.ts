import {api} from '@/lib/http';import {getRecord} from '@/lib/records';
export async function GET(request:Request,context:{params:Promise<{domain:string;id:string}>}){const {domain,id}=await context.params;return api(request,actor=>getRecord(actor,domain,id,new URL(request.url).searchParams.get('date')??undefined));}
