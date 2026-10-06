import {api} from '@/lib/http';import {overview} from '@/lib/reporting';
export async function GET(request:Request){const q=new URL(request.url).searchParams;return api(request,actor=>overview(actor,q.get('date')??undefined,q.get('orgId')??undefined));}
