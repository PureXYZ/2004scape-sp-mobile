#!/usr/bin/env node
// The pinned upstream sources (upstream.json, scripts/lib/upstream.mjs, scripts/fetch-upstream.mjs): the pins are
// well formed, the patches' BASE files name the same commits (web/client/patches/BASE: webclient,
// web/engine/bots/content/BASE: content), the resolver's order (LC_UPSTREAM_DIR, LC_SERVER_DIR, <repo>/upstream, the
// sibling ../Server), derived tsconfigs, and fetch-upstream.mjs --check on a folder without checkouts. No network.
//
//   node web/test/upstream.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NAMES, REPO_DIR, derivedTsconfig, readPins, resolveUpstream } from '../../scripts/lib/upstream.mjs';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const pins = readPins();
check('upstream.json: revision 274, the three repositories on branch 274 with full commits', pins.revision === 274 && NAMES.every(n => pins[n].branch === '274' && /^[0-9a-f]{40}$/.test(pins[n].commit) && pins[n].repository.startsWith('https://github.com/LostCityRS/')));

const base = file => fs.readFileSync(path.join(REPO_DIR, file), 'utf8').trim().split(/\s+/)[0];
const clientBase = base('web/client/patches/BASE');
const botsBase = base('web/engine/bots/content/BASE');
check('web/client/patches/BASE is upstream.json\'s webclient commit', clientBase === pins.webclient.commit, `${clientBase} vs ${pins.webclient.commit}`);
check('web/engine/bots/content/BASE is upstream.json\'s content commit', botsBase === pins.content.commit, `${botsBase} vs ${pins.content.commit}`);

// the resolver's order, against a scratch "repo"
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-upstream-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const r = (env, dir = repo) => resolveUpstream(env, dir);
check('no setting, no upstream/: the sibling ../Server', r({}).dir === path.join(tmp, 'Server') && r({}).via === 'sibling');
fs.mkdirSync(path.join(repo, 'upstream'));
check('upstream/ exists: it wins over the sibling', r({}).dir === path.join(repo, 'upstream') && r({}).via === 'upstream');
check('LC_SERVER_DIR (the older name) wins over upstream/', r({ LC_SERVER_DIR: path.join(tmp, 'a') }).dir === path.join(tmp, 'a') && r({ LC_SERVER_DIR: path.join(tmp, 'a') }).via === 'LC_SERVER_DIR');
check('LC_UPSTREAM_DIR wins over LC_SERVER_DIR', r({ LC_UPSTREAM_DIR: path.join(tmp, 'b'), LC_SERVER_DIR: path.join(tmp, 'a') }).dir === path.join(tmp, 'b'));

// derived tsconfigs: the ../Server paths moved, the repo's own kept, every one absolute
const moved = path.join(tmp, 'elsewhere');
const derived = JSON.parse(fs.readFileSync(derivedTsconfig(path.join(REPO_DIR, 'web/engine/test/fixtures/stub-bots/tsconfig.json'), moved), 'utf8'));
const paths = derived.compilerOptions.paths;
check(
    'derivedTsconfig: extends the committed file, #/* into the given folder, the stub library in the repo, typeRoots moved',
    derived.extends === path.join(REPO_DIR, 'web/engine/test/fixtures/stub-bots/tsconfig.json') &&
        paths['#/*'][0] === path.join(moved, 'engine/src/*') &&
        paths['#/engine/bot/*'][0] === path.join(REPO_DIR, 'web/engine/test/fixtures/stub-bots/*') &&
        derived.compilerOptions.typeRoots[0] === path.join(moved, 'engine/node_modules/@types') &&
        Object.values(paths).flat().every(p => path.isAbsolute(p)),
    JSON.stringify(paths['#/*'])
);

// fetch-upstream.mjs --check on a folder with nothing in it: reports each missing, exit 1
const empty = path.join(tmp, 'none');
const res = spawnSync(process.execPath, [path.join(REPO_DIR, 'scripts/fetch-upstream.mjs'), '--check', '--dir', empty], { encoding: 'utf8' });
check('fetch-upstream.mjs --check --dir <empty>: the three missing, exit 1', res.status === 1 && NAMES.every(n => new RegExp(`${n}\\s+missing`).test(res.stdout)), res.stdout.trim().split('\n').join(' | '));
const bad = spawnSync(process.execPath, [path.join(REPO_DIR, 'scripts/fetch-upstream.mjs'), '--frobnicate'], { encoding: 'utf8' });
check('fetch-upstream.mjs: an unknown option is refused (exit 2)', bad.status === 2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nupstream: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
