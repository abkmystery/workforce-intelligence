import {api,jsonBody} from '@/lib/http';import {performAction,revealIdentity} from '@/lib/workflows';
export async function POST(request:Request){return api(request,async actor=>{const body=await jsonBody(request);return body.action==='reveal'?revealIdentity(actor,body.id):performAction(actor,body);});}
