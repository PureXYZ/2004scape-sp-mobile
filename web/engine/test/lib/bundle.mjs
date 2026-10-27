// Bundles a small entry with exactly the engine build's resolution (shims, aliases, defines) so unit tests can import
// engine and shim modules in Node.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

import { bundleOptions } from '../../build.mjs';
import { IOS, SERVER } from './fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');

/**
 * @param contents TypeScript entry source (imports resolve from web/engine/src). Returns the imported module.
 * @param plugins esbuild plugins that run before the engine build's own (e.g. to stub a module's imports).
 */
export async function importBundled(name, contents, engineDir = path.join(SERVER, 'engine'), plugins = []) {
    const outfile = path.join(IOS, 'build/tmp/engine/unit', `${name}.mjs`);
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    const options = bundleOptions(engineDir);
    await esbuild.build({ ...options, plugins: [...plugins, ...options.plugins], stdin: { contents, resolveDir: SRC, loader: 'ts', sourcefile: `${name}.ts` }, outfile, minify: false });
    return import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}
