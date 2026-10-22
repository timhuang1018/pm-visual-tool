// Bundles the CLI and server into one file (dist/cli.js). The UI is built separately by Vite
// into dist/ui and served by `pmv serve`. Only `ws` stays an external runtime dependency.
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

await build({
  entryPoints: ['cli/main.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['ws', 'playwright-core'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});
chmodSync('dist/cli.js', 0o755);
console.log('built dist/cli.js');
