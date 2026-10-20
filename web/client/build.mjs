#!/usr/bin/env node
// LostCity iOS port: builds the Client-TS 274 web client (Server/webclient) with the iOS patches and overrides.
//
//   export async function buildClient({ out, debug = false, webclientDir, engineDir })
//   node web/client/build.mjs --out <GameDir> [--debug] [--webclient <dir>] [--engine <dir>]
//
// Writes (docs/ARCHITECTURE.md §2):
//   <out>/client/client.js [+ client.js.map in debug], <out>/client/tinymidipcm.wasm, <out>/client/SCC1_Florestan.sf2
//   <out>/client/mapview.js [+ map] and <out>/worldmap.jag: the HUD's world map (MobileMapView, patch 0018)
//   <out>/crc and <out>/<title|config|...><crc>: what the engine serves at those URLs (src/web.ts), derived from
//   <engineDir>/data/pack/main_file_cache.* so that the client's CRC table always matches the engine's.
// Steps: copy webclient/{src,tsconfig.json,package.json} to build/tmp/client/work-<mode>, `git apply` patches/*.patch,
// alias overrides/<path> over <path>, esbuild (esm, browser, safari16), then check the bundle and write it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

import {
    DEFAULT_ENGINE_DIR,
    DEFAULT_WEBCLIENT_DIR,
    OVERRIDES_DIR,
    TMP_DIR,
    WEB_DIR,
    applyPatches,
    copyUpstreamTree,
    listOverrides,
    listPatches,
    patchedFiles,
    readBaseCommit,
    webclientCommit
} from './lib/tree.mjs';
import { JAG_FILE_RE, deriveClientFiles, readJag, readPack, validateOnDemand } from './lib/cache.mjs';

// Build tools are pinned in web/package.json (esbuild 0.28.0, fflate 0.8.3, node-forge 1.4.0).
const requireWeb = createRequire(path.join(WEB_DIR, 'package.json'));

// Client fields/methods the host touches by name at runtime (ARCHITECTURE.md §6). esbuild never mangles property
// names unless asked to, but a future minifier setting must not silently break the host, so the build checks them.
const HOST_FIELDS = [
    'keyHeld', 'timeoutTimer', 'idleTimer', 'noTimeoutTimer', 'ingame', 'loginscreen', 'loginSelect', 'loginUser', 'loginPass',
    'chatInput', 'dialogInputOpen', 'dialogInput', 'socialInputOpen', 'socialInput', 'socialInputHeader', 'socialInputType', 'reportAbuseInput',
    'setTargetedFramerate', 'mainModalId', 'sideModalId', 'reportAbuseComId', 'chatModalId', 'isMenuOpen',
    'loginMes1', 'loginMes2', 'titleFlames', 'lastProgressPercent', 'keyQueueReadPos', 'keyQueueWritePos', 'nextMouseClickX',
    'nextMouseClickY', 'nextMouseClickTime', 'nextMouseClickButton', 'tfps', 'errorLoading', 'errorHost', 'errorStarted',
    // the mobile HUD (patch 0011)
    'setSurfaceLayout', 'setViewportInsets', 'cancelPointer', 'cancelPointerOn', 'tapAt', 'hudState', 'hudChatLines', 'hudSetRun',
    'reconnecting',
    // host menus, pinch zoom, the compass (patch 0012)
    'setHostMenus', 'hudMenu', 'hudMenuSelect', 'hudMenuClose', 'setCameraZoom', 'hudFaceNorth',
    // the touch model (patch 0013) and the dialogue helpers (patch 0014): methods, and hudState() keys
    'longPressable', 'hudContinue', 'hudDialog', 'hudCancelInput', 'chatContinue', 'tutorialKey', 'tutorialMessage',
    // the world map (patch 0018)
    'hudPlayerTile',
    // tap-to-drop (patch 0019): the method and its hudState() key
    'setTapToDrop', 'tapToDrop'
];

function modPow(b, e, m) {
    let r = 1n;
    b %= m;
    while (e > 0n) {
        if (e & 1n) {
            r = (r * b) % m;
        }
        e >>= 1n;
        b = (b * b) % m;
    }
    return r;
}

// LOGIN_RSAN/LOGIN_RSAE from the engine's private key (World.ts:104 reads data/config/private.pem; public.pem has n
// and e swapped and nothing reads it). Asserts that a login-shaped block encrypted the client's way (m^E mod N,
// Packet.rsaenc) decrypts the engine's way (CRT with p, q, dP, dQ, qInv: engine Packet.rsadec).
function rsaDefines(pemFile) {
    const forge = requireWeb('node-forge');
    const priv = forge.pki.privateKeyFromPem(fs.readFileSync(pemFile, 'ascii'));
    const big = x => BigInt(`0x${x.toString(16)}`);
    const [n, e, d, p, q, dP, dQ, qInv] = [priv.n, priv.e, priv.d, priv.p, priv.q, priv.dP, priv.dQ, priv.qInv].map(big);
    const user = Buffer.from('iosbuild\n'), pass = Buffer.from('roundtrip\n');
    const block = Buffer.concat([Buffer.from([10]), crypto.randomBytes(16), Buffer.from([0, 0, 5, 57]), user, pass]); // magic 10, seeds, uid 1337
    const m = BigInt(`0x${block.toString('hex')}`);
    if (m >= n) {
        throw new Error(`RSA: ${n.toString(2).length}-bit modulus is too small for a login block`);
    }
    const c = modPow(m, e, n);
    const mP = modPow(c, dP, p);
    const mQ = modPow(c, dQ, q);
    const h = (((qInv * (mP - mQ)) % p) + p) % p;
    const crt = mQ + h * q;
    if (crt !== m || modPow(c, d, n) !== m) {
        throw new Error(`RSA round trip failed with ${pemFile}: the client key would not match the engine`);
    }
    return { LOGIN_RSAN: n.toString(10), LOGIN_RSAE: e.toString(10), bits: n.toString(2).length };
}

// esbuild plugin: overrides/<rel> stands in for <tree>/<rel>. Every import is resolved normally first, so all
// specifier forms (#/..., relative) hit the same override; a `#/` import of a module that exists only in overrides/
// (a new iOS module such as src/client/LcHost.ts) resolves there.
function overridesPlugin(treeDir, overrides) {
    const set = new Set(overrides);
    const used = new Set();
    return {
        used,
        plugin: {
            name: 'ios-overrides',
            setup(build) {
                build.onResolve({ filter: /.*/ }, async args => {
                    if (args.pluginData?.iosOverrides || args.kind === 'entry-point') {
                        return undefined;
                    }
                    const r = await build.resolve(args.path, {
                        kind: args.kind,
                        importer: args.importer,
                        resolveDir: args.resolveDir,
                        pluginData: { iosOverrides: true }
                    });
                    if (r.errors.length > 0) {
                        if (args.path.startsWith('#/')) {
                            const rel = `src/${args.path.slice(2)}`.replace(/\.js$/, '.ts');
                            if (set.has(rel)) {
                                used.add(rel);
                                return { path: path.join(OVERRIDES_DIR, rel) };
                            }
                        }
                        return { errors: r.errors };
                    }
                    const rel = path.relative(treeDir, r.path).split(path.sep).join('/');
                    if (set.has(rel)) {
                        used.add(rel);
                        return { path: path.join(OVERRIDES_DIR, rel) };
                    }
                    return r;
                });
            }
        }
    };
}

function rel(p) {
    return path.relative(process.cwd(), p) || '.';
}

export async function buildClient({ out, debug = false, webclientDir = DEFAULT_WEBCLIENT_DIR, engineDir = DEFAULT_ENGINE_DIR, log = console.log } = {}) {
    if (!out) {
        throw new Error('buildClient: `out` (the Game root, e.g. build/Game) is required');
    }
    const t0 = performance.now();
    out = path.resolve(out);
    webclientDir = path.resolve(webclientDir);
    engineDir = path.resolve(engineDir);

    const input = {
        clientEntry: path.join(webclientDir, 'src/client/Client.ts'),
        wasm: path.join(webclientDir, 'src/3rdparty/tinymidipcm/tinymidipcm.wasm'),
        sf2: path.join(engineDir, 'public/client/SCC1_Florestan.sf2'),
        pem: path.join(engineDir, 'data/config/private.pem'),
        pack: path.join(engineDir, 'data/pack'),
        worldmap: path.join(engineDir, 'data/pack/mapview/worldmap.jag') // the world map's data (the engine's packer)
    };
    for (const [k, f] of Object.entries(input)) {
        if (!fs.existsSync(f)) {
            throw new Error(`buildClient: missing input ${k}: ${f}`);
        }
    }

    // 1. cache-derived HTTP files (cheap; validates the pack first)
    const cache = readPack(input.pack);
    const derived = deriveClientFiles(cache, engineDir);

    // 2. RSA defines
    const rsa = rsaDefines(input.pem);

    // 3. patched source tree
    const tree = path.join(TMP_DIR, debug ? 'work-debug' : 'work-release');
    copyUpstreamTree(webclientDir, tree);
    const patches = listPatches();
    const overrides = listOverrides();
    for (const patch of patches) {
        const clash = patchedFiles(patch).filter(f => overrides.includes(f));
        if (clash.length) {
            throw new Error(`${path.basename(patch)} patches ${clash.join(', ')}, which overrides/ replaces wholesale: the patch would be ignored`);
        }
    }
    const base = readBaseCommit();
    const head = webclientCommit(webclientDir);
    applyPatches(tree, patches, { baseCommit: base, webclientCommit: head });
    if (base && head && base !== head) {
        log(`client: note: webclient is at ${head}, patches were made against ${base} (they still apply)`);
    }

    // 4. versionlist check with the client's own bzip2 decoder (from the tree we just prepared)
    const { bunzip2 } = await import(pathToFileURL(path.join(tree, 'src/io/BZip2.js')).href);
    const versionlist = readJag(derived.jags.find(j => j.name === 'versionlist').data, bunzip2);
    const od = validateOnDemand(cache, versionlist);
    if (od.bad.length > 0) {
        throw new Error(`client cache: ${od.bad.length} OnDemand file(s) fail versionlist validation, e.g. ${od.bad.slice(0, 5).join('; ')}`);
    }

    // 5. bundle
    const esbuild = requireWeb('esbuild');
    const { plugin, used } = overridesPlugin(tree, overrides);
    const outfile = path.join(out, 'client', 'client.js');
    const result = await esbuild.build({
        entryPoints: [path.join(tree, 'src/client/Client.ts')],
        absWorkingDir: tree,
        outfile,
        write: false,
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: ['safari16'],
        tsconfig: path.join(tree, 'tsconfig.json'),
        nodePaths: [path.join(WEB_DIR, 'node_modules')], // fflate (the webclient has no node_modules)
        define: {
            'process.env.SECURE_ORIGIN': JSON.stringify('false'),
            'process.env.LOGIN_RSAN': JSON.stringify(rsa.LOGIN_RSAN),
            'process.env.LOGIN_RSAE': JSON.stringify(rsa.LOGIN_RSAE),
            'process.env.BUILD_TIME': JSON.stringify(new Date().toISOString())
        },
        // release: minify whitespace/syntax/identifiers but never property names (the host reads client fields by
        // name) and drop console.*; debug: readable output, linked source map, console kept
        minify: !debug,
        drop: debug ? [] : ['console'],
        sourcemap: debug ? 'linked' : false,
        // (the notices of everything in the bundle are in build/Game/licenses.txt, scripts/lib/notices.mjs; the
        // sources' licence lines, e.g. audio.js's "MIT license", are plain comments that minifying drops anyway)
        legalComments: 'none',
        logLevel: 'silent',
        metafile: true,
        plugins: [plugin]
    });
    for (const w of result.warnings) {
        log(`client: esbuild warning: ${w.text} (${w.location?.file}:${w.location?.line})`);
    }
    const missingOverrides = overrides.filter(o => !used.has(o));
    if (missingOverrides.length) {
        throw new Error(`overrides not used by the bundle (path no longer exists upstream?): ${missingOverrides.join(', ')}`);
    }

    const js = result.outputFiles.find(f => f.path === outfile);
    const map = result.outputFiles.find(f => f.path === `${outfile}.map`);
    const code = js.text;

    // 5b. the world map (patch 0018): MobileMapView, the 2004 map applet with touch controls, a page of its own in the
    // HUD's World map window (web/host/mapview.html)
    const mapOutfile = path.join(out, 'client', 'mapview.js');
    const mapResult = await esbuild.build({
        entryPoints: [path.join(tree, 'src/mapview/MobileMapView.ts')],
        absWorkingDir: tree,
        outfile: mapOutfile,
        write: false,
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: ['safari16'],
        tsconfig: path.join(tree, 'tsconfig.json'),
        nodePaths: [path.join(WEB_DIR, 'node_modules')],
        define: { 'process.env.SECURE_ORIGIN': JSON.stringify('false') },
        minify: !debug,
        drop: debug ? [] : ['console'],
        sourcemap: debug ? 'linked' : false,
        legalComments: 'none',
        logLevel: 'silent',
        plugins: [overridesPlugin(tree, overrides).plugin]
    });
    for (const w of mapResult.warnings) {
        log(`client: mapview esbuild warning: ${w.text} (${w.location?.file}:${w.location?.line})`);
    }
    const mapJs = mapResult.outputFiles.find(f => f.path === mapOutfile);
    const mapMap = mapResult.outputFiles.find(f => f.path === `${mapOutfile}.map`);

    // 6. bundle sanity checks
    const problems = [];
    if (!/export\s*\{[^}]*\bas Client\b|export\s*\{[^}]*\bClient\b[^}]*\}/.test(code)) {
        problems.push('no `Client` export');
    }
    for (const f of HOST_FIELDS) {
        if (!code.includes(f)) {
            problems.push(`host-visible member \`${f}\` missing`);
        }
    }
    if (/process\.env\./.test(code)) {
        problems.push('unreplaced process.env reference');
    }
    if (!mapJs.text.includes('lcMap') || !mapJs.text.includes('worldmap.jag') || /process\.env\./.test(mapJs.text)) {
        problems.push('mapview.js: no MobileMapView, or an unreplaced process.env reference');
    }
    if (/ondemandworker\.js/i.test(code) || /new Worker\(/.test(code)) {
        problems.push('the bundle still spawns a worker (LocalOnDemand override not in effect?)');
    }
    if (!code.includes('__LC_CACHE__') || !code.includes('lcHost')) {
        problems.push('iOS overrides missing from the bundle');
    }
    if (problems.length) {
        const dump = path.join(TMP_DIR, 'failed-client.js');
        fs.writeFileSync(dump, js.contents);
        throw new Error(`client bundle check failed: ${problems.join('; ')} (bundle saved to ${dump})`);
    }

    // 7. write. out/client is ours: replace it wholesale so no stale map/wasm survives a debug->release switch.
    const clientDir = path.join(out, 'client');
    fs.rmSync(clientDir, { recursive: true, force: true });
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(outfile, js.contents);
    if (map) {
        fs.writeFileSync(`${outfile}.map`, map.contents);
    }
    fs.writeFileSync(mapOutfile, mapJs.contents);
    if (mapMap) {
        fs.writeFileSync(`${mapOutfile}.map`, mapMap.contents);
    }
    fs.copyFileSync(input.wasm, path.join(clientDir, 'tinymidipcm.wasm'));
    fs.copyFileSync(input.worldmap, path.join(out, 'worldmap.jag')); // (MapView fetches /worldmap.jag)
    fs.copyFileSync(input.sf2, path.join(clientDir, 'SCC1_Florestan.sf2'));

    // jag archives at the Game root, named with their signed decimal CRC (the client requests `/${name}${crc}`).
    // Only stale *jag-named* files are removed; everything else in out/ belongs to other build steps.
    const wanted = new Set(derived.jags.map(j => j.file));
    for (const f of fs.readdirSync(out)) {
        if (JAG_FILE_RE.test(f) && !wanted.has(f)) {
            fs.rmSync(path.join(out, f));
        }
    }
    for (const j of derived.jags) {
        fs.writeFileSync(path.join(out, j.file), j.data);
    }
    fs.writeFileSync(path.join(out, 'crc'), derived.crcBuffer);

    const summary = {
        out,
        debug,
        ms: Math.round(performance.now() - t0),
        webclientCommit: head,
        patchBase: base,
        patches: patches.map(p => path.basename(p)),
        overrides,
        clientJsBytes: js.contents.length,
        mapviewJsBytes: mapJs.contents.length,
        sourcemapBytes: map ? map.contents.length : 0,
        crcs: derived.crcs,
        crcHash: derived.hash,
        crcTableCrc32: derived.crc32OfTable,
        jags: derived.jags.map(j => ({ file: j.file, bytes: j.data.length })),
        crossChecked: derived.crossChecked,
        ondemand: { ok: od.ok, zeroVersion: od.zeroVersion },
        rsaBits: rsa.bits
    };
    log(
        `client: ${debug ? 'debug' : 'release'} build -> ${rel(out)} in ${summary.ms} ms: client.js ${(summary.clientJsBytes / 1024).toFixed(0)} KB` +
            `${map ? ` (+map ${(summary.sourcemapBytes / 1024).toFixed(0)} KB)` : ''}, ${patches.length} patches, ${overrides.length} overrides, ` +
            `crc hash ${derived.hash}, ${od.ok} OnDemand files verified`
    );
    return summary;
}

// ---- CLI ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const argv = process.argv.slice(2);
    const opts = { debug: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') {
            opts.out = argv[++i];
        } else if (a === '--debug') {
            opts.debug = true;
        } else if (a === '--webclient') {
            opts.webclientDir = argv[++i];
        } else if (a === '--engine') {
            opts.engineDir = argv[++i];
        } else if (a === '--json') {
            opts.json = true;
        } else {
            console.error(`unknown argument ${a}\nusage: node web/client/build.mjs --out <GameDir> [--debug] [--webclient <dir>] [--engine <dir>] [--json]`);
            process.exit(2);
        }
    }
    if (!opts.out) {
        console.error('usage: node web/client/build.mjs --out <GameDir> [--debug] [--webclient <dir>] [--engine <dir>] [--json]');
        process.exit(2);
    }
    try {
        const summary = await buildClient(opts);
        if (opts.json) {
            console.log(JSON.stringify(summary, null, 1));
        }
    } catch (e) {
        console.error(`client build failed: ${e.message ?? e}`);
        process.exit(1);
    }
}
