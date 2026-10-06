import {api} from '@/lib/http';import {recordHistory} from '@/lib/records';
export async function GET(request:Request,context:{params:Promise<{domain:string;id:string}>}){const {domain,id}=await context.params;return api(request,actor=>recordHistory(actor,domain,id));}
