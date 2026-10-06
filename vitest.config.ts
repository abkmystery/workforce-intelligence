import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({resolve:{alias:{'@':path.resolve('src')}},test:{environment:'node',exclude:['node_modules/**','.next/**','tests/e2e/**'],testTimeout:30000,hookTimeout:60000}});
