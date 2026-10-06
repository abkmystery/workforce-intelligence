import { NextResponse } from 'next/server';
import { appOrigin, assertSameOrigin, logout } from '@/lib/auth';
export async function POST(request: Request) {
 try{assertSameOrigin(request);await logout();return NextResponse.redirect(`${appOrigin()}/login`,303);}
 catch{return NextResponse.json({error:{code:'LOGOUT_REJECTED',message:'Invalid logout request.'}},{status:403});}
}
