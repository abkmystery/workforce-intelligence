import { NextResponse } from 'next/server';
import { appOrigin, completeLogin } from '@/lib/auth';
export async function GET(request: Request) {
 try{await completeLogin(new URL(request.url));return NextResponse.redirect(`${appOrigin()}/workspace/overview`);}
 catch{return NextResponse.json({error:{code:'LOGIN_REJECTED',message:'Sign-in could not be verified or access has not been granted.'}},{status:401,headers:{'Cache-Control':'no-store'}});}
}
