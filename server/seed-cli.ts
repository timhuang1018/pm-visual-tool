// npm run seed: recreate the sample project in data/ (restart the dev server afterwards).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new Store(path.join(ROOT, 'data'));
store.seedSample(true);
store.flush();
console.log('Recreated project "sample" in data/sample.json (restart the server if it is running).');
