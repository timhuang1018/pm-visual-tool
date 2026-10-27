// Development entry: API on :4317 with this repo's data/ folder and the sample project.
// The UI runs separately under Vite (npm run dev → http://localhost:5173).
// For the packaged tool, `pmv serve` (cli/main.ts) starts the same server with the built UI.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './app';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 4317);
const dataDir = process.env.PM_DATA_DIR ?? path.join(ROOT, 'data');
const ui = path.join(ROOT, 'dist', 'ui');

// Backlog and brief paths are relative to this folder (the CLI's working folder when it linked them).
const root = process.env.PM_ROOT ?? ROOT;
const s = await startServer({ port, dataDir, uiDir: existsSync(ui) ? ui : null, seedSample: process.env.PM_SEED_SAMPLE !== '0', root });
console.log(`pm-visual API on ${s.url}  (data: ${path.relative(ROOT, dataDir) || dataDir})`);

const shutdown = () => s.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
