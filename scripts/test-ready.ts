import { runNode } from './isolated-postgres';
// Database and browser runners always create their own synthetic loopback cluster.
const checks: [string, string, string[]][] = [
  ['Route types', 'node_modules/next/dist/bin/next', ['typegen']],
  ['TypeScript', 'node_modules/typescript/bin/tsc', ['--noEmit']],
  ['Lint', 'node_modules/eslint/bin/eslint.js', ['src','scripts','tests']],
  ['Unit tests', 'node_modules/vitest/vitest.mjs', ['run','--exclude','tests/integration/**','--exclude','tests/e2e/**']],
  ['Native PostgreSQL integration', 'node_modules/tsx/dist/cli.mjs', ['scripts/test-postgres.ts']],
  ['Production build', 'node_modules/next/dist/bin/next', ['build']],
];
for (const [name, entry, args] of checks) {
  console.log(`Checking ${name}`);
  await runNode(entry, args, process.env);
}
await runNode('tests/e2e/run-authenticated.ts', [], {...process.env, NODE_OPTIONS: '--conditions=react-server --import=tsx'});
console.log('All test-readiness checks passed, including the authenticated retention transfer journey.');
