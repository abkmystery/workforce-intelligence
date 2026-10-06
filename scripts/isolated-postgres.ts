import EmbeddedPostgres from 'embedded-postgres';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { access, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';

export function runNode(file:string,args:string[],env:NodeJS.ProcessEnv){
 return runProcess(process.execPath,[file,...args],env);
}
function runProcess(file:string,args:string[],env=process.env){
 return new Promise<void>((resolve,reject)=>{
  const child=spawn(file,args,{env,stdio:'inherit',windowsHide:true});
  child.once('error',reject);
  child.once('exit',code=>code===0?resolve():reject(new Error('Local test command failed: '+code)));
 });
}

/** Always creates a new loopback-only synthetic cluster; ignores external database URLs. */
export async function createIsolatedPostgres(purpose:'test'|'load'|'e2e'){
 const clusterDir=path.resolve('.local','postgres-'+purpose+'-'+randomUUID());
 await mkdir(clusterDir,{recursive:true});
 const reservation=createServer();
 await new Promise<void>((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
 const port=(reservation.address() as {port:number}).port;
 await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
 const pg=new EmbeddedPostgres({databaseDir:clusterDir,port,user:'postgres',password:'synthetic-test-only',authMethod:'scram-sha-256',persistent:true,createPostgresUser:false,postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:error=>console.error(String(error))});
 const retained=purpose==='load'||process.env.KEEP_SYNTHETIC_TEST_DATABASES==='true';
 const cleanup=async()=>{
  if(retained)return;
  const target=await realpath(clusterDir).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!target)return;
  const workspace=await realpath(process.cwd()),relative=path.relative(workspace,target);
  if(path.isAbsolute(relative)||relative.startsWith('..')||path.dirname(target)!==await realpath(path.join(workspace,'.local'))||path.basename(target)!==path.basename(clusterDir))throw new Error('Refusing cleanup outside the generated workspace cluster');
  const running=await access(path.join(target,'postmaster.pid')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  if(running)throw new Error('Refusing cleanup of a running PostgreSQL cluster');
  await rm(target,{recursive:true,force:true});
 };
 // The package's Windows stop uses taskkill, which hangs under restricted process access.
 // pg_ctl performs PostgreSQL's own bounded, graceful shutdown for this exact cluster.
 if(process.platform==='win32'){
  const packageName='@embedded-postgres/windows-x64';
  const binaries=await import(packageName) as {pg_ctl:string};
  let started=false,stopping:Promise<void>|undefined;
  const start=pg.start.bind(pg);
  pg.start=async()=>{await start();started=true;};
  pg.stop=async()=>{if(!started)return;return stopping??=runProcess(binaries.pg_ctl,['-D',clusterDir,'-m','fast','-w','-t','30','stop']).then(()=>{started=false;});};
 }
 try{
  await pg.initialise();await pg.start();await pg.createDatabase('workforce_test');
  const admin=pg.getPgClient('workforce_test','127.0.0.1');await admin.connect();
  try{await admin.query("CREATE ROLE workforce_app LOGIN PASSWORD 'synthetic-test-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE");}finally{await admin.end();}
  const migration='postgresql://postgres:synthetic-test-only@127.0.0.1:'+port+'/workforce_test';
  const runtime='postgresql://workforce_app:synthetic-test-only@127.0.0.1:'+port+'/workforce_test';
  const env={...process.env,MIGRATION_DATABASE_URL:migration,DATABASE_URL:runtime,TEST_DATABASE_URL:runtime,DATABASE_APP_ROLE:'workforce_app'};
  await runNode('node_modules/tsx/dist/cli.mjs',['scripts/migrate.ts'],env);
  let stopped:Promise<void>|undefined;
  return {pg,clusterDir,port,env,retained,stop:()=>stopped??=pg.stop().then(cleanup)};
 }catch(error){await pg.stop();await cleanup();throw error;}
}
