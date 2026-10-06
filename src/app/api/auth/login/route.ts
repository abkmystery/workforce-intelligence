import { NextResponse } from 'next/server';
import { createLogin } from '@/lib/auth';
export async function GET(request: Request) {
 try {return NextResponse.redirect(await createLogin(new URL(request.url).searchParams.get('tenant')??undefined));}
 catch{return NextResponse.json({error:{code:'LOGIN_UNAVAILABLE',message:'Sign-in is not configured or is unavailable.'}},{status:503,headers:{'Cache-Control':'no-store'}});}
}
