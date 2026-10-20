// Imported first by the entry: fails fast, with a useful message, when the bundle is evaluated before boot.js
// preloaded the vfs (engine modules read files while they evaluate).
import { getStore } from './vfs.js';

const store = getStore();
const required = ['/engine/data/config/private.pem', '/engine/data/config/world.json', '/engine/data/pack/main_file_cache.dat', '/engine/data/pack/server/script.dat'];
const missing = required.filter(p => !store.files.has(p) && !store.urls.has(p));
if (missing.length) {
    throw new Error(`[engine] virtual file system not preloaded (missing ${missing.join(', ')}). Load the engine through boot.js.`);
}
