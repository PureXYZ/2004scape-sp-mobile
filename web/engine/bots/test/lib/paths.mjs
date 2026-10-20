// Where things are, for the bot library's tests. The rev-274 engine, content and webclient are read-only inputs,
// found by scripts/lib/upstream.mjs (LC_UPSTREAM_DIR or its older name LC_SERVER_DIR, <repo>/upstream, the sibling
// ../Server).
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { UPSTREAM_DIR, derivedTsconfig } from '../../../../../scripts/lib/upstream.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const BOTS_DIR = path.resolve(here, '../..');
/** The library under test; LC_BOTS_SRC runs the tests against another copy of it (an A/B run of a change). */
export const BOTS_SRC = process.env.LC_BOTS_SRC ? path.resolve(process.env.LC_BOTS_SRC) : path.join(BOTS_DIR, 'src');
/** web/engine/bots/tsconfig.json with its paths at the resolved upstream folder (its committed paths name ../Server). */
export const BOTS_TSCONFIG = derivedTsconfig(path.join(BOTS_DIR, 'tsconfig.json'));
export const PROJECT_DIR = path.resolve(BOTS_DIR, '../../..');
export const SERVER_DIR = UPSTREAM_DIR;
export const ENGINE_DIR = path.join(SERVER_DIR, 'engine');
export const CONTENT_DIR = path.join(SERVER_DIR, 'content');
export const WEBCLIENT_DIR = path.join(SERVER_DIR, 'webclient');
export const PACK_DIR = path.join(ENGINE_DIR, 'data/pack');
export const TMP_DIR = path.join(PROJECT_DIR, 'build/tmp/bots');

/** Imports a TypeScript module (and its '#/...' graph) through the engine's tsx, with the given tsconfig's paths. */
export async function importTs(file, tsconfig = BOTS_TSCONFIG) {
    const { tsImport } = await import(pathToFileURL(path.join(ENGINE_DIR, 'node_modules/tsx/dist/esm/api/index.mjs')).href);
    return tsImport(pathToFileURL(path.resolve(file)).href, { parentURL: import.meta.url, tsconfig });
}

/** The TypeScript compiler (for the static checks). */
export async function typescript() {
    return (await import(pathToFileURL(path.join(ENGINE_DIR, 'node_modules/typescript/lib/typescript.js')).href)).default;
}
