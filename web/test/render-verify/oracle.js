// render-verify oracle (in the page, injected at document start; needs a debug bundle with globalThis.__lc, which
// lib.mjs exposeClient() adds). Every frame it checks the 3D frame a build's World.renderAll leaves in Pix2D.pixels
// (partial or full) against a plain upstream full render of the same frame, and the renderer state a full render
// would leave behind:
//   pixels    every pixel of the 3D viewport (the frame before the overlays are drawn on it)
//   picking   Model.pickedCount and the picked typecodes in order (the options menu), World.groundX/groundZ and
//             World.click (the tile a tap walks to)
//   heights   every player's and NPC's height (where their chat, health bar and hitsplats go)
//   minY      every drawn ModelSource's minY (the next frame's occlusion tests read it)
//   textures  whether textures 17 and 24 animate after this frame (textureRunAnims runs only when the frame fetched
//             the texture: a frame that skips the water shifts its animation for good)
//   locanims  every ClientLocAnim's animation state against an upstream-timeline shadow (getTempModel advances it
//             lazily and clamps a gap of more than 100 cycles, so skipped calls can shift its phase for good)
// The reference render starts from the frame-start state (picking, the texture cycles, every minY the build changed,
// the loc animations' shadows) with a texel pool of its own, and everything is put back afterwards, so the build under
// test runs exactly as it would without the check.
//
// window.__rv.start({ impl, every }) once the world is up; __rv.mark(label) names the scenario step;
// __rv.report() -> counts and mismatches; __rv.stop().
// impl: 'none' (no incremental render: the oracle checks itself), 'prototype' (prototype-incr.js, the performance
// investigation's prototype), 'native' (the client's own, branch perf-render: hooks in native-hooks.js), 'mutant-freeze' /
// 'mutant-pick' / 'mutant-water' (deliberately broken renders the oracle must catch).
(() => {
    if (window.__rv) return;
    const RV = (window.__rv = { on: false, impl: null, every: 1, installed: false, scene: '' });
    const now = () => performance.now();

    const resetStats = () => {
        RV.stats = {
            frames: 0, // renderAll calls while on
            checked: 0, // frames compared with a reference render
            partial: 0, // frames the build drew partially (as far as its adapter can tell)
            full: 0,
            unknownKind: 0,
            checkedPartial: 0,
            mismatchFrames: 0, // checked frames with any differing pixel
            partialMismatchFrames: 0,
            mismatchPx: 0,
            state: { picking: 0, ground: 0, heights: 0, minY: 0, textures: 0, locanims: 0 },
            implMs: 0,
            refMs: 0,
            checkMs: 0,
            errors: 0,
            firstError: null,
            startedAt: Date.now()
        };
        RV.mismatches = []; // pixel mismatches, one entry per frame (capped)
        RV.stateMismatches = []; // state mismatches (capped)
        RV.saved = []; // crops of the first mismatching frames: { frame, x, y, w, h, impl, ref } (base64 Int32 RGB)
        RV.timeline = []; // per second: { t, frames, checked, partial, bad, scene }
        RV.scenes = {}; // per scene label: { frames, checked, checkedPartial, mismatchFrames, partialMismatchFrames, mismatchPx, state }
    };
    const sceneOf = () => (RV.scenes[RV.scene] ??= { frames: 0, checked: 0, checkedPartial: 0, mismatchFrames: 0, partialMismatchFrames: 0, mismatchPx: 0, state: {} });
    resetStats();
    const cap = (list, item, n = 400) => {
        if (list.length < n) list.push(item);
    };

    // install(impl): wraps World.prototype.renderAll from outside, around whatever it is now (so a runtime prototype must
    // be installed first, which this does for 'prototype')
    RV.install = implName => {
        if (RV.installed) return true;
        const L = window.__lc;
        const c = window.__client;
        if (!L?.World || !c) return false;
        const P2 = L.Pix2D, P3 = L.Pix3D, M = L.Model, WC = L.World, WP = WC.prototype;
        const MSP = L.ModelSource.prototype;
        const CLA = L.ClientLocAnim?.prototype;
        RV.L = L;

        // ---- the adapter: the build's renderAll (impl), a clean upstream full render that touches no incremental
        // state (ref), and whether the last frame was partial (kind)
        const upstream = WP.renderAll;
        let A;
        if (implName === 'none') {
            A = { impl: upstream, ref: upstream, kind: () => 'full' };
        } else if (implName === 'prototype') {
            const I = window.__incr;
            if (!I?.install()) throw new Error('prototype-incr.js is not loaded or did not install');
            I.on = true;
            I.verify = 0; // (its own verify re-renders with the shared state; this oracle replaces it)
            A = { impl: WP.renderAll, ref: window.__incrOrig.WP.renderAll, before: () => I.stats.partial, kind: b => (I.stats.partial > b ? 'partial' : 'full'), stats: () => ({ ...I.stats, mismatches: undefined, firstMismatch: undefined }) };
        } else if (implName === 'native' || implName === 'native-mutant') {
            A = window.__rvNativeHooks?.(L, c, implName === 'native-mutant');
            if (!A) throw new Error('no native incremental-render hooks for this build (native-hooks.js)');
        } else if (implName === 'mutant-freeze') {
            // keeps the 3D frame of every 25th frame and shows it for the next 24
            let frozen = null, at = -1e9;
            A = {
                ref: upstream,
                kind: () => 'partial',
                impl: function (...a) {
                    const O = P2.pixels;
                    upstream.apply(this, a);
                    if (!frozen || frozen.length !== O.length || RV.stats.frames - at >= 25) {
                        frozen = O.slice();
                        at = RV.stats.frames;
                    } else O.set(frozen);
                }
            };
        } else if (implName === 'mutant-pick') {
            // the right pixels, but the last picked entity is dropped (a menu option would be missing)
            A = { ref: upstream, kind: () => 'partial', impl: function (...a) { upstream.apply(this, a); if (M.pickedCount > 0) M.pickedCount--; } };
        } else if (implName === 'mutant-water') {
            // draws everything but the textures' animation fetch: texture 17 never animates (a frozen water phase)
            A = { ref: upstream, kind: () => 'partial', impl: function (...a) { const c17 = P3.texCycle[17]; upstream.apply(this, a); P3.texCycle[17] = c17; } };
        } else throw new Error(`unknown impl ${implName}`);
        RV.impl = implName;
        RV.adapter = A;

        // ---- phases: null (outside renderAll), 'impl' (the build's renderAll), 'ref' (the reference render)
        let phase = null;
        // ModelSource.worldRender sets minY: the frame-start value of every source the build drew this frame, and the
        // build's own values, put back after the reference
        let startMinY = new Map(); // source -> minY before the build's first draw of it this frame
        let keptMinY = new Map(); // source -> the build's minY, restored after the reference
        let refMinY = new Map(); // source -> minY the reference left
        const origMSWR = MSP.worldRender;
        MSP.worldRender = function (...a) {
            if (phase === 'impl') {
                if (!startMinY.has(this)) startMinY.set(this, this.minY);
            } else if (phase === 'ref') {
                if (!keptMinY.has(this)) keptMinY.set(this, this.minY);
            }
            const r = origMSWR.apply(this, a);
            if (phase === 'ref') refMinY.set(this, this.minY);
            return r;
        };

        // what the frame holds (counted in the reference render, a full one): triangles with the animated textures 17 and
        // 24, animated locs drawn, dynamic sprites; per scene the most seen in a frame, to show a scenario exercises them
        const content = { tex17: 0, tex24: 0, locanims: 0 };
        const origTT = P3.textureTriangle;
        P3.textureTriangle = function (...a) {
            if (phase === 'ref') {
                if (a[18] === 17) content.tex17++;
                else if (a[18] === 24) content.tex24++;
            }
            return origTT.apply(this, a);
        };

        // ClientLocAnim: an upstream-timeline shadow of each one's animation state
        const locShadow = new WeakMap(); // loc -> [anim, animFrame, animCycle] as upstream would have it
        let locStart = new Map(); // loc -> its state before the build's first call this frame
        let locTouched = new Set();
        if (CLA) {
            const origGTM = CLA.getTempModel;
            CLA.getTempModel = function () {
                if (phase === 'impl') {
                    if (!locStart.has(this)) locStart.set(this, [this.anim, this.animFrame, this.animCycle]);
                    locTouched.add(this);
                    return origGTM.call(this);
                }
                if (phase === 'ref') {
                    content.locanims++;
                    const mine = [this.anim, this.animFrame, this.animCycle];
                    const sh = locShadow.get(this) ?? locStart.get(this) ?? mine;
                    this.anim = sh[0];
                    this.animFrame = sh[1];
                    this.animCycle = sh[2];
                    try {
                        return origGTM.call(this);
                    } finally {
                        locShadow.set(this, [this.anim, this.animFrame, this.animCycle]);
                        locTouched.add(this);
                        this.anim = mine[0];
                        this.animFrame = mine[1];
                        this.animCycle = mine[2];
                    }
                }
                return origGTM.call(this);
            };
        }
        // getTempModel's advance without the model: where a lazily advanced state stands at loop cycle `at`
        const advance = (anim, frame, cycle, at) => {
            if (!anim) return [null, 0, 0];
            let delta = at - cycle;
            if (delta > 100 && anim.loops > 0) delta = 100;
            while (delta > anim.getDelay(frame)) {
                delta -= anim.getDelay(frame);
                frame++;
                if (frame < anim.numFrames) continue;
                frame -= anim.loops;
                if (frame < 0 || frame >= anim.numFrames) return [null, 0, 0];
            }
            return [anim, frame, at - delta];
        };

        // a texel pool of the reference's own (texels are a pure function of the texture and its palette, so a fresh
        // pool gives the same texels without touching the build's pool, its LRU or its cycles)
        let refPool = null;
        const refTexels = () => {
            const n = P3.texelPool ? P3.texelPool.length : 20;
            const size = P3.texelPool?.[0]?.length ?? P3.activeTexels.find(t => t)?.length ?? 65536;
            if (!refPool || refPool.length !== n || refPool[0].length !== size) refPool = Array.from({ length: n }, () => new Int32Array(size));
            return { active: new Array(P3.activeTexels.length).fill(null), pool: refPool.slice(), size: n };
        };

        // the entities whose height a full render sets (players, NPCs)
        const entities = () => {
            const out = [];
            if (c.localPlayer) out.push(c.localPlayer);
            for (let i = 0; i < c.playerCount; i++) {
                const p = c.players[c.playerIds[i]];
                if (p) out.push(p);
            }
            for (let i = 0; i < c.npcCount; i++) {
                const n = c.npc[c.npcIds[i]];
                if (n) out.push(n);
            }
            return out;
        };
        const b64 = arr => {
            const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
            let s = '';
            for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
            return btoa(s);
        };

        let V = null; // the reference frame
        let lastSecond = 0, secFrames = 0, secChecked = 0, secPartial = 0, secBad = 0;
        let depth = 0; // renderAll inside renderAll (a patch drawing upstream's traversal from its own) passes through
        const wrapped = function (eyeX, eyeY, eyeZ, maxLevel, eyeYaw, eyePitch) {
            if (depth > 0) return A.impl.apply(this, arguments);
            depth++;
            try {
                return checked.call(this, eyeX, eyeY, eyeZ, maxLevel, eyeYaw, eyePitch);
            } finally {
                depth--;
            }
        };
        const checked = function (eyeX, eyeY, eyeZ, maxLevel, eyeYaw, eyePitch) {
            if (!RV.on) return A.impl.apply(this, arguments);
            const S = RV.stats;
            const Z = sceneOf();
            S.frames++;
            Z.frames++;
            const check = S.frames % RV.every === 0;
            const t0 = now();
            // the state the frame starts from (which the reference starts from too)
            const pre = check
                ? { mouseCheck: M.mouseCheck, mouseX: M.mouseX, mouseY: M.mouseY, pickedCount: M.pickedCount, click: WC.click, clickX: WC.clickX, clickY: WC.clickY, groundX: WC.groundX, groundZ: WC.groundZ, cycle: P3.cycle, texCycle: P3.texCycle.slice() }
                : null;
            startMinY = new Map();
            locStart = new Map();
            locTouched = new Set();
            const before = A.before?.();
            phase = check ? 'impl' : null;
            try {
                A.impl.apply(this, arguments);
            } finally {
                phase = null;
            }
            const t1 = now();
            S.implMs += t1 - t0;
            const kind = A.kind?.(before) ?? 'unknown';
            if (kind === 'partial') S.partial++;
            else if (kind === 'full') S.full++;
            else S.unknownKind++;
            if (!check) return;
            S.checked++;
            Z.checked++;
            secChecked++;
            if (kind === 'partial') {
                S.checkedPartial++;
                Z.checkedPartial++;
                secPartial++;
            }
            try {
                const O = P2.pixels;
                const W = c.viewportWidth, H = (O.length / W) | 0;
                // the build's state after its frame
                const post = { pickedCount: M.pickedCount, picked: M.pickedEntityTypecode.slice(0, M.pickedCount), click: WC.click, groundX: WC.groundX, groundZ: WC.groundZ, cycle: P3.cycle, texCycle: P3.texCycle, active: P3.activeTexels, pool: P3.texelPool, poolSize: P3.poolSize };
                const ents = entities();
                const loopCycleNow = c.constructor.loopCycle;
                const heights = ents.map(e => e.height);
                const anim17 = post.texCycle[17] >= pre.cycle, anim24 = post.texCycle[24] >= pre.cycle;

                // the reference: the frame-start state, a texel pool of its own, a cleared target (Pix2D.cls)
                if (!V || V.length !== O.length) V = new Int32Array(O.length);
                else V.fill(0);
                M.mouseCheck = pre.mouseCheck;
                M.mouseX = pre.mouseX;
                M.mouseY = pre.mouseY;
                M.pickedCount = pre.pickedCount;
                WC.click = pre.click;
                WC.clickX = pre.clickX;
                WC.clickY = pre.clickY;
                WC.groundX = pre.groundX;
                WC.groundZ = pre.groundZ;
                P3.cycle = pre.cycle;
                P3.texCycle = pre.texCycle;
                const rt = refTexels();
                P3.activeTexels = rt.active;
                P3.texelPool = rt.pool;
                P3.poolSize = rt.size;
                keptMinY = new Map();
                refMinY = new Map();
                for (const [src, y] of startMinY) {
                    keptMinY.set(src, src.minY);
                    src.minY = y;
                }
                P2.pixels = V;
                content.tex17 = content.tex24 = content.locanims = 0;
                const t2 = now();
                let ref;
                phase = 'ref';
                try {
                    A.ref.call(this, eyeX, eyeY, eyeZ, maxLevel, eyeYaw, eyePitch);
                } finally {
                    phase = null;
                    S.refMs += now() - t2;
                    // the reference's state, then the build's back
                    ref = { pickedCount: M.pickedCount, picked: M.pickedEntityTypecode.slice(0, M.pickedCount), click: WC.click, groundX: WC.groundX, groundZ: WC.groundZ, anim17: P3.texCycle[17] >= pre.cycle, anim24: P3.texCycle[24] >= pre.cycle, heights: ents.map(e => e.height) };
                    P2.pixels = O;
                    M.pickedEntityTypecode.set(post.picked, 0);
                    M.pickedCount = post.pickedCount;
                    M.mouseCheck = pre.mouseCheck; // (renderAll leaves it as it was)
                    WC.click = post.click;
                    WC.groundX = post.groundX;
                    WC.groundZ = post.groundZ;
                    P3.cycle = post.cycle;
                    P3.texCycle = post.texCycle;
                    P3.activeTexels = post.active;
                    P3.texelPool = post.pool;
                    P3.poolSize = post.poolSize;
                    for (let i = 0; i < ents.length; i++) ents[i].height = heights[i];
                    for (const [src, y] of keptMinY) src.minY = y;
                }

                const mx = Z.max ?? (Z.max = { tex17: 0, tex24: 0, locanims: 0, dynamic: 0, players: 0, npcs: 0, projectiles: 0, spotanims: 0, hitsplats: 0 });
                const listLen = list => {
                    let n = 0;
                    const sentinel = list?.sentinel;
                    for (let node = sentinel?.next; node && node !== sentinel && n < 1000; node = node.next) n++;
                    return n;
                };
                mx.projectiles = Math.max(mx.projectiles, listLen(c.projectiles));
                mx.spotanims = Math.max(mx.spotanims, listLen(c.spotanims));
                let splats = 0;
                for (const e of ents) for (let k = 0; k < 4; k++) if (e.damageCycles?.[k] > loopCycleNow) splats++;
                mx.hitsplats = Math.max(mx.hitsplats, splats);
                mx.tex17 = Math.max(mx.tex17, content.tex17);
                mx.tex24 = Math.max(mx.tex24, content.tex24);
                mx.locanims = Math.max(mx.locanims, content.locanims);
                mx.dynamic = Math.max(mx.dynamic, this.dynamicCount ?? 0);
                mx.players = Math.max(mx.players, c.playerCount);
                mx.npcs = Math.max(mx.npcs, c.npcCount);

                // ---- pixels
                let bad = 0, x0 = W, x1 = -1, y0 = H, y1 = -1;
                const samples = [];
                for (let i = 0; i < O.length; i++) {
                    if (O[i] !== V[i]) {
                        bad++;
                        const x = i % W, y = (i / W) | 0;
                        if (x < x0) x0 = x;
                        if (x > x1) x1 = x;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                        if (samples.length < 8) samples.push([x, y, O[i], V[i]]);
                    }
                }
                const loopCycle = c.constructor.loopCycle;
                if (bad) {
                    S.mismatchFrames++;
                    Z.mismatchFrames++;
                    if (kind === 'partial') {
                        S.partialMismatchFrames++;
                        Z.partialMismatchFrames++;
                    }
                    S.mismatchPx += bad;
                    Z.mismatchPx += bad;
                    secBad++;
                    const info = { frame: S.frames, t: Date.now() - S.startedAt, loopCycle, kind, px: bad, bbox: [x0, x1, y0, y1], samples, scene: RV.scene, camera: [eyeX, eyeY, eyeZ, maxLevel, eyeYaw, eyePitch] };
                    if (A.diag) info.diag = A.diag(x0, x1, y0, y1);
                    cap(RV.mismatches, info);
                    Z.saved = (Z.saved ?? 0) + 1;
                    if (RV.saved.length < 60 && Z.saved <= (RV.maxSaved ?? 3)) {
                        // a crop around the differing pixels: the build's and the reference's
                        const cx0 = Math.max(0, x0 - 24), cx1 = Math.min(W - 1, x1 + 24), cy0 = Math.max(0, y0 - 24), cy1 = Math.min(H - 1, y1 + 24);
                        const w = cx1 - cx0 + 1, h = cy1 - cy0 + 1;
                        const a = new Int32Array(w * h), b = new Int32Array(w * h);
                        for (let y = 0; y < h; y++) {
                            a.set(O.subarray((cy0 + y) * W + cx0, (cy0 + y) * W + cx0 + w), y * w);
                            b.set(V.subarray((cy0 + y) * W + cx0, (cy0 + y) * W + cx0 + w), y * w);
                        }
                        RV.saved.push({ frame: S.frames, scene: RV.scene, kind, x: cx0, y: cy0, w, h, impl: b64(a), ref: b64(b) });
                    }
                }

                // ---- state
                const stateBad = (what, detail) => {
                    S.state[what]++;
                    Z.state[what] = (Z.state[what] ?? 0) + 1;
                    cap(RV.stateMismatches, { what, frame: S.frames, t: Date.now() - S.startedAt, loopCycle, kind, scene: RV.scene, ...detail }, 200);
                };
                let pickOk = post.pickedCount === ref.pickedCount;
                for (let i = 0; pickOk && i < post.pickedCount; i++) if (post.picked[i] !== ref.picked[i]) pickOk = false;
                if (!pickOk) stateBad('picking', { impl: Array.from(post.picked), ref: Array.from(ref.picked) });
                if (post.groundX !== ref.groundX || post.groundZ !== ref.groundZ || post.click !== ref.click) stateBad('ground', { impl: [post.groundX, post.groundZ, post.click], ref: [ref.groundX, ref.groundZ, ref.click] });
                const hb = [];
                for (let i = 0; i < ents.length; i++) if (heights[i] !== ref.heights[i]) hb.push([ents[i].constructor.name, heights[i], ref.heights[i]]);
                if (hb.length) stateBad('heights', { n: hb.length, first: hb.slice(0, 4) });
                const yb = [];
                for (const [src, y] of refMinY) {
                    const mine = keptMinY.get(src);
                    if (mine !== y) yb.push([src.constructor.name, mine, y, startMinY.has(src)]);
                }
                if (yb.length) stateBad('minY', { n: yb.length, first: yb.slice(0, 4) });
                if (anim17 !== ref.anim17 || anim24 !== ref.anim24) stateBad('textures', { impl: [anim17, anim24], ref: [ref.anim17, ref.anim24] });
                if (CLA) {
                    const lb = [];
                    for (const loc of locTouched) {
                        const sh = locShadow.get(loc);
                        if (!sh) continue;
                        const a = advance(loc.anim, loc.animFrame, loc.animCycle, loopCycle);
                        const b = advance(sh[0], sh[1], sh[2], loopCycle);
                        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) lb.push([loc.index, a[1], b[1], a[2], b[2]]);
                    }
                    if (lb.length) stateBad('locanims', { n: lb.length, first: lb.slice(0, 4) });
                }
            } catch (e) {
                S.errors++;
                if (!S.firstError) S.firstError = String(e?.stack ?? e);
            } finally {
                S.checkMs += now() - t1;
                secFrames++;
                const sec = Math.floor((Date.now() - S.startedAt) / 1000);
                if (sec !== lastSecond) {
                    if (RV.timeline.length < 4000) RV.timeline.push({ t: lastSecond, frames: secFrames, checked: secChecked, partial: secPartial, bad: secBad, scene: RV.scene });
                    lastSecond = sec;
                    secFrames = secChecked = secPartial = secBad = 0;
                }
            }
        };
        WP.renderAll = wrapped;
        RV.installed = true;
        return true;
    };

    RV.start = (o = {}) => {
        if (!RV.installed && !RV.install(o.impl ?? 'none')) return 'not ready';
        if (o.impl && o.impl !== RV.impl) throw new Error(`installed as ${RV.impl}; reload the page for ${o.impl}`);
        RV.every = o.every ?? 1;
        RV.maxSaved = o.maxSaved ?? 3; // crops kept per scene
        resetStats();
        RV.on = true;
        return JSON.stringify({ impl: RV.impl, every: RV.every });
    };
    RV.stop = () => {
        RV.on = false;
        return RV.report();
    };
    // A pointer that sweeps the world (when no finger is down), so every frame picks what lies under it: the options
    // menu's entries come from that picking, and a partial frame must pick exactly what a full one does.
    let sweepTimer = 0, sweepI = 0;
    RV.sweep = (on, stepPx = 37, everyMs = 90) => {
        clearInterval(sweepTimer);
        if (!on) return false;
        sweepTimer = setInterval(() => {
            const c = window.__client;
            if (!c?.ingame || c.pointerActive || c.isMenuOpen) return;
            const w = c.viewportWidth, h = c.viewportHeight, cols = Math.max(1, Math.floor(w / stepPx)), rows = Math.max(1, Math.floor(h / stepPx));
            const i = sweepI++ % (cols * rows);
            c.mouseX = c.viewportX + 8 + (i % cols) * stepPx + ((sweepI / (cols * rows)) | 0) % stepPx;
            c.mouseY = c.viewportY + 8 + ((i / cols) | 0) * stepPx;
        }, everyMs);
        return true;
    };
    // Full frames from fixed cameras, hashed, to compare builds (the patch's full-render path against main's upstream
    // one): rendered between frames into a buffer of its own, with no dynamic sprites (removed after each frame), the
    // colour table made without its random brightness jitter, animated locs at frame 0 and no picking. views:
    // [{ x, z, level, maxLevel, yaw, pitch, up }] (world tiles); bypass: World.incrBypass during the render (a patch).
    // Each view is rendered twice, a frame apart, so an unstable view (an animated texture) shows as such.
    RV.fixedFrames = async (views, bypass = false) => {
        const L = window.__lc, c = window.__client, P2 = L.Pix2D, P3 = L.Pix3D, WC = L.World, M = L.Model;
        const CLA = L.ClientLocAnim?.prototype;
        const out = [];
        const rnd = Math.random;
        Math.random = () => 0.5;
        try {
            P3.initColourTable(0.8);
        } finally {
            Math.random = rnd;
        }
        const frameOnce = v => {
            const saved = P2.pixels;
            const buf = new Int32Array(saved.length);
            const gtm = CLA?.getTempModel;
            if (CLA) CLA.getTempModel = function () { return L.LocType.list(this.index).getModel(this.shape, this.angle, this.heightSW, this.heightSE, this.heightNE, this.heightNW, -1); };
            const mc = M.mouseCheck, click = WC.click, on = RV.on;
            M.mouseCheck = false;
            WC.click = false;
            RV.on = false;
            if (bypass) WC.incrBypass = true;
            P2.pixels = buf;
            try {
                const lx = v.x - c.mapBuildBaseX, lz = v.z - c.mapBuildBaseZ, level = v.level ?? 0;
                const y = c.getAvH(lx * 128 + 64, lz * 128 + 64, level) - (v.up ?? 900);
                c.world.renderAll(lx * 128 + 64, y, lz * 128 + 64, v.maxLevel ?? 3, v.yaw, v.pitch);
            } finally {
                P2.pixels = saved;
                if (CLA) CLA.getTempModel = gtm;
                M.mouseCheck = mc;
                WC.click = click;
                RV.on = on;
                if (bypass) WC.incrBypass = false;
            }
            let h = 0x811c9dc5, lit = 0;
            for (let i = 0; i < buf.length; i++) {
                h = Math.imul(h ^ buf[i], 16777619);
                if (buf[i] !== 0) lit++;
            }
            return { hash: h >>> 0, lit };
        };
        for (const v of views) {
            const a = frameOnce(v);
            await new Promise(r => setTimeout(r, 120));
            const b = frameOnce(v);
            out.push({ ...v, hash: a.hash, lit: a.lit, stable: a.hash === b.hash });
        }
        return out;
    };
    RV.mark = label => {
        RV.scene = label;
        return label;
    };
    RV.report = (withSaved = false) => {
        const S = RV.stats;
        const out = { impl: RV.impl, ...S, scenes: RV.scenes, ms: { impl: +(S.implMs / Math.max(1, S.frames)).toFixed(3), ref: +(S.refMs / Math.max(1, S.checked)).toFixed(3), check: +(S.checkMs / Math.max(1, S.checked)).toFixed(3) }, mismatches: RV.mismatches, stateMismatches: RV.stateMismatches, timeline: RV.timeline };
        delete out.implMs;
        delete out.refMs;
        delete out.checkMs;
        if (RV.adapter?.stats) out.implStats = RV.adapter.stats();
        if (withSaved) out.saved = RV.saved;
        return out;
    };
})();
