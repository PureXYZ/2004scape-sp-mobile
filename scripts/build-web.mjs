#!/usr/bin/env node
// Builds build/Game — everything the apps bundle and serve at lostcity://game/ (iOS) and from their assets (Android):
// the engine worker + its runtime data, the patched web client + cache files, the host page, and the HUD's fonts and
// sprites (ui/).
//
//   node scripts/build-web.mjs            # release build (minified)
//   node scripts/build-web.mjs --debug    # unminified + sourcemaps + console output kept
//   node scripts/build-web.mjs --skip-pack  # don't run the engine's (incremental) packer, unless data/pack is missing
//   node scripts/build-web.mjs --autotest   # also inject web/test/autotest.js (in-app test run, see web/test/app-test.mjs)
//   node scripts/build-web.mjs --out <dir>  # build somewhere else than build/Game (e.g. to test beside another build)
//   node scripts/build-web.mjs --no-bots    # without the bots (docs/BOTS.md): engine.js only, as before them
//   node scripts/build-web.mjs --rebuild-bot-scripts   # recompile the bots' content-script overlay (else cached)
//   node scripts/build-web.mjs --bots-lib <dir>        # another bot library than web/engine/bots/src (e.g. the tests' stub)
//   node scripts/build-web.mjs --require-bots          # fail when the bots' overlay does not compile (else: built without
//                                                      # the bots, with a warning; the Bots setting then has no effect)
//   node scripts/build-web.mjs --allow-upstream-mismatch  # build although a checkout is not at upstream.json's commit
//                                                      # (a warning instead of an error; the bots' patches are tried anyway)
//
// Inputs are the revision-274 upstream checkouts engine/, content/ and webclient/, found by scripts/lib/upstream.mjs
// (LC_UPSTREAM_DIR, else <repo>/upstream from scripts/fetch-upstream.mjs, else the sibling ../Server), each at the
// commit upstream.json pins. This script never modifies them except for running the engine's own `npm run build`
// (the packer) when data/pack is missing or stale. The bots' overlay compile only reads them (it works in
// build/tmp/bots). It also writes build/Version.xcconfig (the iOS app's version, from VERSION).
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTENT_DIR as CONTENT, ENGINE_DIR as ENGINE, UPSTREAM_DIR, UPSTREAM_VIA, WEBCLIENT_DIR as WEBCLIENT, checkUpstream, describeUpstream, readPins } from './lib/upstream.mjs';

const IOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const OUT = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]) : path.join(IOS, 'build', 'Game');
const BOTS_LIB = argv.includes('--bots-lib') ? path.resolve(argv[argv.indexOf('--bots-lib') + 1]) : null;

const args = new Set(argv);
const debug = args.has('--debug');
const skipPack = args.has('--skip-pack');
const autotest = args.has('--autotest');
let bots = !args.has('--no-bots');
const requireBots = args.has('--require-bots');
const allowUpstreamMismatch = args.has('--allow-upstream-mismatch');
/** Why this build has no bots although they were not turned off (the overlay did not compile), or null. */
let botsSkipped = null;

function fail(message) {
    console.error(`\nbuild-web: ${message}`);
    process.exit(1);
}

function step(title) {
    console.log(`\n▸ ${title}`);
}

function gitRev(dir) {
    try {
        return execFileSync('git', ['-C', dir, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
}

function dirSize(dir) {
    let total = 0;
    let files = 0;
    const walk = d => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, entry.name);
            if (entry.isDirectory()) {
                walk(p);
            } else {
                total += fs.statSync(p).size;
                files++;
            }
        }
    };
    walk(dir);
    return { total, files };
}

// ---------------------------------------------------------------------------------------------------------------

// The upstream checkouts, each at the commit upstream.json pins (the client's and the bots' patches are made against
// those commits, web/client/patches/BASE and web/engine/bots/content/BASE)
const pins = readPins();
const upstreamState = checkUpstream();
console.log(`upstream: ${describeUpstream()}`);
for (const u of upstreamState.filter(u => !u.exists)) {
    fail(
        `missing ${u.dir}. Fetch the pinned sources with \`node scripts/fetch-upstream.mjs\` (into upstream/), or point ` +
            `LC_UPSTREAM_DIR at a folder holding engine/, content/ and webclient/ (${pins[u.name].repository}, branch ${pins[u.name].branch}).`
    );
}
const drifted = upstreamState.filter(u => !u.ok);
if (drifted.length) {
    const lines = drifted.map(u => `  ${u.name}: ${u.head ?? 'not a git checkout'} (${u.dir}), upstream.json pins ${u.expected}`).join('\n');
    const how =
        UPSTREAM_VIA === 'upstream'
            ? 'Run `node scripts/fetch-upstream.mjs` to check out the pinned commits'
            : `Check out the pinned commits in ${UPSTREAM_DIR} (git -C <dir> checkout <commit>), or use \`node scripts/fetch-upstream.mjs\` (upstream/; then unset LC_UPSTREAM_DIR)`;
    if (!allowUpstreamMismatch) {
        fail(`the upstream sources are not at the commits upstream.json pins:\n${lines}\n${how}, or pass --allow-upstream-mismatch to build anyway.`);
    }
    console.warn(`\n!! the upstream sources are not at the commits upstream.json pins (--allow-upstream-mismatch):\n${lines}`);
}

if (!fs.existsSync(path.join(IOS, 'web', 'node_modules', 'esbuild'))) {
    step('Installing web build tools (web)');
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: path.join(IOS, 'web'), stdio: 'inherit' });
    if (r.status !== 0) {
        fail('npm install in web failed');
    }
}

// Same as start.js: `npm install` in the engine, when it has never run or package-lock.json changed since (e.g. after
// "Update Source" pulled a new script compiler).
const engineLock = path.join(ENGINE, 'package-lock.json');
const installedLock = path.join(ENGINE, 'node_modules', '.package-lock.json');
const engineDepsStale =
    !fs.existsSync(path.join(ENGINE, 'node_modules')) ||
    (fs.existsSync(engineLock) && (!fs.existsSync(installedLock) || fs.statSync(engineLock).mtimeMs > fs.statSync(installedLock).mtimeMs));
if (engineDepsStale) {
    step(`Installing engine dependencies (${ENGINE})`);
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ENGINE, stdio: 'inherit' });
    if (r.status !== 0) {
        fail(`npm install in ${ENGINE} failed`);
    }
}

// The engine's packer turns content/ into the engine's data/pack. It is incremental (about 1 s when nothing changed) and
// tracks its own inputs (content, script compiler, cache formats), so let it decide on every build.
const PACK_MARKERS = ['data/pack/main_file_cache.dat', 'data/pack/server/script.dat', 'data/pack/.cache/maps-server.zip'].map(p => path.join(ENGINE, p));
const packMissing = PACK_MARKERS.some(p => !fs.existsSync(p));
if (packMissing || !skipPack) {
    step(packMissing ? 'Packing game data (first build, ~10 s)' : 'Packing game data (incremental)');
    const r = spawnSync('npm', ['run', 'build'], { cwd: ENGINE, stdio: 'inherit' });
    if (r.status !== 0) {
        fail(`the engine packer (npm run build in ${ENGINE}) failed`);
    }
}

const started = Date.now();

// The apps' version (VERSION: major.minor.patch). Android's Gradle reads VERSION itself; the iOS project includes
// build/Version.xcconfig (ios/Config/Signing.xcconfig) for its MARKETING_VERSION and CURRENT_PROJECT_VERSION.
const version = fs.readFileSync(path.join(IOS, 'VERSION'), 'utf8').trim();
const versionParts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!versionParts || versionParts.slice(2).some(n => Number(n) > 99)) {
    fail(`VERSION is '${version}': it must be major.minor.patch, minor and patch at most 99`);
}
const versionCode = Number(versionParts[1]) * 10000 + Number(versionParts[2]) * 100 + Number(versionParts[3]);
const versionXcconfig = `// Written by scripts/build-web.mjs from VERSION; included by ios/Config/Signing.xcconfig.\nMARKETING_VERSION = ${version}\nCURRENT_PROJECT_VERSION = ${versionCode}\n`;
const versionFile = path.join(IOS, 'build', 'Version.xcconfig');
if (!fs.existsSync(versionFile) || fs.readFileSync(versionFile, 'utf8') !== versionXcconfig) {
    fs.mkdirSync(path.dirname(versionFile), { recursive: true });
    fs.writeFileSync(versionFile, versionXcconfig);
}

// The bots' content-script overlay (web/engine/bots/content): cached by the vanilla script pack and the patches, so
// this costs a hash when nothing changed (also with --skip-pack); a recompile takes ~4 s. Before the output folder is
// cleaned, and not fatal by default: bots are optional (Settings › World › Bots), so a content update the bots'
// patches no longer apply to must not stop the app from building (with --allow-upstream-mismatch; without it a
// content checkout that is not at the patches' BASE fails the build here, before anything is compiled). Without the bots bundle the engine
// starts without bots and the page says so when they are asked for.
let overlay = null;
if (bots) {
    step('Bots: content-script overlay');
    const { compileBotScripts } = await import('../web/engine/bots/content/compile.mjs');
    try {
        overlay = await compileBotScripts({ engineDir: ENGINE, contentDir: CONTENT, force: args.has('--rebuild-bot-scripts'), allowBaseMismatch: allowUpstreamMismatch });
        console.log(`${overlay.scripts.length} scripts, ${(overlay.bytes / 1024).toFixed(1)} KB, ${overlay.reused ? 'cached' : `compiled in ${(overlay.timings.compileMs / 1000).toFixed(1)} s`} (key ${overlay.key.slice(0, 12)})`);
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (requireBots || e?.code === 'LC_BASE_MISMATCH') {
            fail(`the bots' content-script overlay: ${reason}`);
        }
        botsSkipped = `the bots' content-script overlay did not compile: ${reason.replace(/\s+/g, ' ').slice(0, 300)}`;
        bots = false;
        console.warn(`\n!! ${reason}\n!! BUILDING WITHOUT THE BOTS: the app works as before, but Settings › World › Bots has no effect.\n!! (fix the patches as web/engine/README.md "Bots" describes; --require-bots makes this an error)`);
    }
}

step(`Cleaning ${path.relative(IOS, OUT)}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

step(`Building engine worker (${debug ? 'debug' : 'release'}${bots ? ', with the bots bundle' : ', without bots'})`);
const { buildEngine } = await import('../web/engine/build.mjs');
let engineInfo;
try {
    engineInfo = await buildEngine({ out: OUT, debug, engineDir: ENGINE, contentDir: CONTENT, bots: bots ? { overlay, ...(BOTS_LIB ? { lib: BOTS_LIB } : {}) } : false });
} catch (e) {
    fail(`the engine build: ${e instanceof Error ? e.message : e}${bots ? '\n(build without the bots: --no-bots)' : ''}`);
}
if (engineInfo.bots) {
    const b = engineInfo.bots;
    console.log(`engine.js ${(engineInfo.bundle.bytes / 1024).toFixed(0)} KB; engine-bots.js ${(b.bundle.bytes / 1024).toFixed(0)} KB (${(b.bundle.gzip / 1024).toFixed(0)} KB gzip, ${b.bundle.libModules} bot modules from ${b.lib})`);
}

step(`Building web client (${debug ? 'debug' : 'release'})`);
const { buildClient } = await import('../web/client/build.mjs');
await buildClient({ out: OUT, debug, webclientDir: WEBCLIENT, engineDir: ENGINE });

step('Copying host page');
fs.cpSync(path.join(IOS, 'web', 'host'), OUT, { recursive: true });
if (autotest) {
    fs.copyFileSync(path.join(IOS, 'web', 'test', 'autotest.js'), path.join(OUT, 'autotest.js'));
    const index = path.join(OUT, 'index.html');
    const html = fs.readFileSync(index, 'utf8');
    const tag = '<script src="host.js"></script>';
    if (!html.includes(tag)) {
        fail(`--autotest: ${tag} not found in index.html`);
    }
    fs.writeFileSync(index, html.replace(tag, `${tag}\n    <script src="autotest.js"></script>`));
    console.log('autotest.js injected (test build: do not ship)');
}

step('Building HUD fonts and sprites');
const { buildUi } = await import('../web/ui/build.mjs');
await buildUi({ out: OUT, contentDir: CONTENT });

// The licences page (Settings › About › Licences): LICENSE and THIRD_PARTY_NOTICES.md as plain text, the notices of
// everything both apps ship (scripts/lib/notices.mjs; the bundles keep no licence comments of their own)
step('Writing licenses.txt');
const { renderNotices } = await import('./lib/notices.mjs');
const licenses = renderNotices(IOS);
fs.writeFileSync(path.join(OUT, 'licenses.txt'), licenses);
console.log(`licenses.txt ${(licenses.length / 1024).toFixed(0)} KB (LICENSE + THIRD_PARTY_NOTICES.md)`);

// web/engine/bots/UPSTREAM: "Upstream:  <url>" and "Commit:    <sha> (...)"
function upstream() {
    try {
        const text = fs.readFileSync(path.join(IOS, 'web/engine/bots/UPSTREAM'), 'utf8');
        return { repository: /^Upstream:\s+(\S+)/m.exec(text)?.[1] ?? null, commit: /^Commit:\s+([0-9a-f]+)/m.exec(text)?.[1] ?? null };
    } catch {
        return null;
    }
}

const info = {
    builtAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    debug,
    revision: 274,
    version,
    upstream: { via: UPSTREAM_VIA, matchesPins: drifted.length === 0 },
    engine: gitRev(ENGINE),
    content: gitRev(CONTENT),
    webclient: gitRev(WEBCLIENT),
    port: gitRev(IOS),
    autotest,
    bots: engineInfo.bots
        ? {
              included: true,
              upstream: upstream(),
              library: engineInfo.bots.lib,
              overlay: {
                  key: overlay.key,
                  contentBase: overlay.base,
                  patches: overlay.patches,
                  scriptsChanged: overlay.scripts.length,
                  // (the shipped scripts.bin and script.dat, as buildEngine wrote them: the same wherever the repo is)
                  bytes: engineInfo.bots.overlay.bytes,
                  reused: overlay.reused,
                  vanillaScriptDat: engineInfo.bots.overlay.vanillaScriptDat
              },
              bundle: { bytes: engineInfo.bots.bundle.bytes, gzip: engineInfo.bots.bundle.gzip, botModules: engineInfo.bots.bundle.libModules }
          }
        : { included: false, ...(botsSkipped ? { reason: botsSkipped } : {}) }
};
fs.writeFileSync(path.join(OUT, 'build-info.json'), JSON.stringify(info, null, 2));

step('Verifying output');
const required = [
    'index.html',
    'host.js',
    'host.css',
    'crc',
    'client/client.js',
    'client/tinymidipcm.wasm',
    'client/SCC1_Florestan.sf2',
    'cache/main_file_cache.dat',
    'cache/main_file_cache.idx0',
    'cache/main_file_cache.idx4',
    'engine/boot.js',
    'engine/engine.js',
    'engine/vfs-manifest.json',
    ...(bots ? ['engine/engine-bots.js', 'engine/vfs-manifest-bots.json'] : []),
    'ui/fonts/p12.ttf',
    'ui/sprites/sideicons-0.png',
    'ui/manifest.json',
    'licenses.txt'
];
const missing = required.filter(f => !fs.existsSync(path.join(OUT, f)));
if (missing.length) {
    fail(`build output is missing: ${missing.join(', ')}`);
}
// (each distinct licence's text, and the notices of the parts the licences page names: a notices file that lost a
// section must not ship)
const licensesText = fs.readFileSync(path.join(OUT, 'licenses.txt'), 'utf8');
const lostNotices = ['Copyright (c) 2026 PureXYZ', 'Copyright (c) 2023-2026 Lost City', '2004SP Progressive', 'The ggml authors', 'Alibaba Cloud', 'Apache License', 'ISC License', 'Blue Oak Model License', 'Julian R Seward', 'zlib License', 'Jagex Ltd'].filter(s => !licensesText.includes(s));
if (lostNotices.length) {
    fail(`licenses.txt has no ${lostNotices.map(s => `'${s}'`).join(', ')} (THIRD_PARTY_NOTICES.md)`);
}
for (const name of ['vfs-manifest.json', ...(bots ? ['vfs-manifest-bots.json'] : [])]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'engine', name), 'utf8'));
    const unresolved = manifest.filter(([, url]) => !fs.existsSync(path.resolve(OUT, 'engine', url)));
    if (unresolved.length) {
        fail(`engine ${name} entries without a file: ${unresolved.map(([p]) => p).join(', ')}`);
    }
}
if (bots) {
    // the overlay must be the one diffed against the script pack that ships (its header has that pack's sha256)
    const bin = fs.readFileSync(path.join(OUT, 'engine/vfs/bots/scripts.bin'));
    const shipped = crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, 'engine/vfs/data/pack/server/script.dat'))).digest('hex');
    if (bin.subarray(0, 8).toString('latin1') !== 'LCBOTSC1' || bin.subarray(8, 40).toString('hex') !== shipped) {
        fail('engine/vfs/bots/scripts.bin was not made from the script.dat that ships (run with --rebuild-bot-scripts)');
    }
    const engineJs = fs.readFileSync(path.join(OUT, 'engine/engine.js'), 'utf8');
    if (['LCBOTS01', '[bots]', 'P_ISBOT'].some(m => engineJs.includes(m))) {
        fail('engine/engine.js contains bot code: it must stay the vanilla engine (docs/BOTS.md §2)');
    }
}
// nothing in a release build may name the builder's folders (the script compiler's absolute source paths did;
// web/engine/build.mjs makes them relative). A debug build is scanned too, but only warns: debug builds are not
// published, and their sourcemaps' sources are relative (web/engine/build.mjs injects the Buffer shim by a bare id).
const privatePaths = [...new Set([IOS, fs.realpathSync(IOS), UPSTREAM_DIR, ...(fs.existsSync(UPSTREAM_DIR) ? [fs.realpathSync(UPSTREAM_DIR)] : []), os.homedir()])].filter(p => p.length > 1).map(p => Buffer.from(p));
const leaking = [];
const scanPaths = (d, base = OUT) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) scanPaths(p, base);
        else {
            const buf = fs.readFileSync(p);
            const hit = privatePaths.find(needle => buf.includes(needle));
            if (hit) leaking.push(`${path.relative(base, p)} (${hit})`);
        }
    }
};
scanPaths(OUT);
if (debug && leaking.length) {
    console.warn(`\n⚠ debug build names a local folder (fine locally; do not share this build):\n  ${leaking.join('\n  ')}`);
    leaking.length = 0;
}
// and the chat model the apps bundle beside it (ios/scripts/prepare-model.sh, android/scripts/prepare-model.sh), in
// every build: llama-quantize writes the imatrix's absolute paths into a GGUF's metadata
for (const dir of [path.join(IOS, 'build', 'Model'), path.join(IOS, 'android', 'build', 'model-assets', 'Model')]) {
    if (fs.existsSync(dir)) scanPaths(dir, IOS);
}
if (leaking.length) {
    fail(`build output names a local folder:\n  ${leaking.join('\n  ')}`);
}
const crc = fs.readFileSync(path.join(OUT, 'crc'));
const jagNames = ['title', 'config', 'interface', 'media', 'versionlist', 'textures', 'wordenc', 'sounds'];
for (let i = 0; i < jagNames.length; i++) {
    const value = crc.readInt32BE((i + 1) * 4);
    if (!fs.existsSync(path.join(OUT, `${jagNames[i]}${value}`))) {
        fail(`crc table names ${jagNames[i]}${value} but that archive was not written`);
    }
}

const { total, files } = dirSize(OUT);
console.log(`\n✓ ${path.relative(IOS, OUT)}: ${files} files, ${(total / 1048576).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s (${debug ? 'debug' : 'release'}${autotest ? ', autotest' : ''}${bots ? '' : botsSkipped ? ', WITHOUT THE BOTS (see the warning above)' : ', without bots'})`);
