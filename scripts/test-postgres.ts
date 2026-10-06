import {createIsolatedPostgres,runNode} from './isolated-postgres';

let completed=false;
process.on('exit',code=>{if(!completed)process.exitCode=code||1;});
const cluster=await createIsolatedPostgres('test');
try{
 await runNode('node_modules/tsx/dist/cli.mjs',['scripts/migrate.ts'],cluster.env);
 await runNode('node_modules/vitest/vitest.mjs',['run','tests/integration'],cluster.env);
}finally{await cluster.stop();}
completed=true;
console.log(JSON.stringify({result:'passed',clusterDir:cluster.clusterDir,port:cluster.port,synthetic:true,retained:cluster.retained}));
