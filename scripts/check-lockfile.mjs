// Fails if package-lock.json resolves any package from somewhere other than the public npm
// registry, so the published lockfile works for everyone and points at nothing private.
import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const bad = Object.entries(lock.packages ?? {})
  .filter(([, p]) => p.resolved && !p.resolved.startsWith('https://registry.npmjs.org/'))
  .map(([name]) => name);
if (bad.length) {
  console.error(`package-lock.json resolves ${bad.length} package(s) outside https://registry.npmjs.org/, e.g. ${bad.slice(0, 3).join(', ')}.`);
  console.error('Regenerate the lockfile against the public registry before committing.');
  process.exit(1);
}
console.log('package-lock.json: all packages from the public npm registry');
