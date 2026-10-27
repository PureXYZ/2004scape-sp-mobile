#!/usr/bin/env node
// render-verify: puts the client into every situation where the 3D area changes while the camera stays still, and
// checks every frame against a full render (oracle.js), in headless Chrome (V8) and in a macOS WKWebView (JSC, the
// iPhone's WebKit). README.md says how to run it on any build.
//
//   node web/test/render-verify/run.mjs --game <debug Game dir> [--engine chrome|webkit|both] [--impl native|prototype|none|native-mutant|mutant-freeze|mutant-pick|mutant-water]
//        [--session world|bots|all] [--only a,b] [--skip a,b] [--scale 1] [--out <dir>] [--port 47660] [--keep-going]
//
// --session: 'world' (no bots: Lumbridge and around), 'bots' (500 bots: Varrock West, Edgeville), 'all' (both, one
// after the other). --only/--skip pick scenarios by name. --scale multiplies every scenario's duration (0.25 for a
// quick pass). Results: <out>/<engine>-<session>.json and a summary on stdout; the crops of the first mismatching
// frames as PNGs (the build's frame | the reference | the difference in magenta).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { serve } from '../serve.mjs';
import { exposeClient, game, IOS, pageScript, sleep, writeCrop } from './lib.mjs';
import { SESSIONS } from './scenarios.mjs';

const argv = process.argv.slice(2);
const opt = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : def;
};
const flag = name => argv.includes(`--${name}`);
const GAME = path.resolve(opt('game', path.join(IOS, 'build', 'Game')));
const ENGINES = opt('engine', 'chrome') === 'both' ? ['chrome', 'webkit'] : [opt('engine', 'chrome')];
const IMPL = opt('impl', 'native');
const SESSION_NAMES = opt('session', 'all') === 'all' ? Object.keys(SESSIONS) : opt('session').split(',');
const ONLY = opt('only', '') ? opt('only').split(',') : null;
const SKIP = opt('skip', '') ? opt('skip').split(',') : [];
const SCALE = Number(opt('scale', '1'));
const OUT = path.resolve(opt('out', path.join(IOS, 'build', 'tmp', 'render-verify')));
const PORT = Number(opt('port', '47660'));
const KEEP_GOING = flag('keep-going');
// --probe <module.mjs>: after the session's setup, run the module's run(ctx) instead of the scenarios (development)
const PROBE = opt('probe', null);
// --every N: check every Nth frame only (development: whether checking every frame changes what the build draws)
const EVERY = Number(opt('every', '1'));
// --bare: no oracle or wrappers in the page (development, with --probe: the build exactly as it runs)
const BARE = flag('bare');
// --platform android (Chrome only): the page as the Android app runs it (android-stub.mjs: LostCityNative, the
// Android user agent, the Medium Phone AVD's 914x411 at 2.625, an 800x360 world; patch 0026 then sends whole frames)
const PLATFORM = opt('platform', 'ios');
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(`[rv ${new Date().toISOString().slice(11, 19)}]`, ...a);
const { source: clientSource, exposed } = exposeClient(GAME);
log(`game ${GAME}: exposed ${exposed.join(', ')}`);

async function runSession(engine, sessionName) {
    const session = SESSIONS[sessionName];
    const scenarios = session.scenarios.filter(s => (!ONLY || ONLY.includes(s.name)) && !SKIP.includes(s.name));
    if (!scenarios.length && !PROBE) return null;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `rv-${engine}-${sessionName}-`));
    const saves = path.join(tmp, 'saves');
    const server = await serve({ port: PORT, root: GAME, saves, log: false, onLog: () => {}, routes: { '/client/client.js': async () => ({ body: clientSource, type: 'text/javascript; charset=utf-8' }) } });
    const settings = { seenHowToPlay: true, jmod: true, xpRate: 1, bots: session.bots, ...session.settings };
    let inject = pageScript({ settings, impl: IMPL, touch: engine === 'webkit', bare: BARE, safe: PLATFORM === 'android' ? { top: 0, right: 0, bottom: 0, left: 0 } : undefined });
    let d;
    if (engine === 'chrome') {
        const { openChrome } = await import('./chrome.mjs');
        const extra = {};
        if (PLATFORM === 'android') {
            const { ANDROID_SCREENS, ANDROID_UA, androidPageScript } = await import('../android-stub.mjs');
            const scr = ANDROID_SCREENS['a-medium'];
            inject = `${androidPageScript({ bridge: false })}\n;\n${inject}`;
            Object.assign(extra, { view: { ...scr.view, dpr: scr.dpr }, safe: scr.safe, ua: ANDROID_UA });
        }
        d = await openChrome({ url: server.url, inject, cdpPort: PORT + 1, profileDir: path.join(tmp, 'chrome'), log, ...extra });
    } else {
        const { openWebKit } = await import('./webkit.mjs');
        d = await openWebKit({ url: server.url, inject, log, tmp });
    }
    const g = game(d);
    const result = { engine, platform: PLATFORM, session: sessionName, impl: IMPL, game: GAME, started: new Date().toISOString(), scenarios: [], scale: SCALE };
    const file = path.join(OUT, `${engine}${PLATFORM === 'android' ? '-android' : ''}-${sessionName}.json`);
    const save = () => fs.writeFileSync(file, JSON.stringify(result, null, 1));
    try {
        const title = await g.title();
        log(`${engine}/${sessionName}: title ${title.ok} (${title.ms} ms)`);
        if (!title.ok) throw new Error('no title screen');
        // the oracle on from the title: the first world frames after the login are checked too
        if (!BARE) {
            const started = await d.eval(`window.__rv.start({ impl: ${JSON.stringify(IMPL)}, every: ${EVERY} })`);
            log(`oracle: ${started}`);
            if (started === 'not ready') throw new Error('oracle not ready at the title');
            await d.eval(`window.__rvShown.start({ every: 25 })`);
        }
        const ctx = { d, g, log, scale: SCALE, out: OUT, engine, session: sessionName, sleepScaled: ms => sleep(ms * SCALE) };
        await session.setup(ctx);
        if (PROBE) {
            const mod = await import(path.resolve(PROBE));
            result.probe = await mod.run(ctx);
            log(`probe: ${JSON.stringify(result.probe)?.slice(0, 4000)}`);
            scenarios.length = 0;
        }
        for (const sc of scenarios) {
            const t0 = Date.now();
            log(`${engine}/${sessionName}: ${sc.name} ...`);
            if (!BARE) await g.mark(sc.name);
            let error = null;
            let data;
            try {
                data = await sc.run(ctx);
            } catch (e) {
                error = String(e?.stack ?? e);
                log(`  ${sc.name} failed: ${error.split('\n')[0]}`);
            }
            await g.mark(`${sc.name}:after`);
            const rep = await d.eval('window.__rv.report()');
            const z = rep.scenes[sc.name] ?? {};
            const row = { name: sc.name, what: sc.what, seconds: Math.round((Date.now() - t0) / 1000), error, ...z, ...(data !== undefined ? { data } : {}) };
            result.scenarios.push(row);
            log(`  ${sc.name}: ${row.seconds} s, frames ${z.frames ?? 0}, checked ${z.checked ?? 0} (partial ${z.checkedPartial ?? 0}), mismatching ${z.mismatchFrames ?? 0} (${z.mismatchPx ?? 0} px), state ${JSON.stringify(z.state ?? {})}`);
            save();
            if (error && !KEEP_GOING && sc.required) break;
        }
    } finally {
        try {
            const rep = await d.eval('window.__rv.report(true)');
            const shown = await d.eval('window.__rvShown.report()');
            const saved = rep.saved ?? [];
            delete rep.saved;
            result.report = rep;
            result.shown = shown;
            result.console = d.consoleLines?.filter(l => /exception|error/i.test(l)).slice(0, 50);
            saved.forEach(crop => writeCrop(path.join(OUT, `${engine}-${sessionName}-${crop.scene || "start"}-f${crop.frame}.png`), crop));
            result.ended = new Date().toISOString();
            save();
            log(`${engine}/${sessionName}: frames ${rep.frames}, checked ${rep.checked} (partial ${rep.checkedPartial}), mismatching ${rep.mismatchFrames} (partial ${rep.partialMismatchFrames}, ${rep.mismatchPx} px), state ${JSON.stringify(rep.state)}, errors ${rep.errors}${rep.firstError ? ` (${rep.firstError.split('\n')[0]})` : ''}; canvases ${shown.reads} reads, ${shown.differing} differing; world draws ${shown.worldDraws} / renderAll calls ${shown.renderAlls}; ms/frame impl ${rep.ms.impl} ref ${rep.ms.ref} check ${rep.ms.check}`);
        } catch (e) {
            log(`report failed: ${e}`);
        }
        await d.close();
        await server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    return result;
}

let failed = false;
for (const engine of ENGINES) {
    for (const s of SESSION_NAMES) {
        try {
            const r = await runSession(engine, s);
            if (r && (r.report?.mismatchFrames || Object.values(r.report?.state ?? {}).some(Boolean) || r.shown?.differing || r.report?.errors)) failed = true;
        } catch (e) {
            log(`${engine}/${s} failed: ${e?.stack ?? e}`);
            failed = true;
        }
    }
}
log(`results in ${OUT}`);
process.exit(failed ? 1 : 0);
