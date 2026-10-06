import { api } from '@/lib/http';
import { financeReport } from '@/lib/finance';
export async function GET(request:Request){const q=new URL(request.url).searchParams;return api(request,actor=>financeReport(actor,q.get('date')??new Date().toISOString().slice(0,10),q.get('orgId')??undefined,q.get('currency')??'USD'));}
