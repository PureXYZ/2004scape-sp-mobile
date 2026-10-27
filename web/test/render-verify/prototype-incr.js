// The incremental-render prototype of the perf investigation, unchanged
// (its patch form was the same less its `cheapHash` option). A runtime monkey patch of
// the exposed debug bundle; the suite runs it with --impl prototype on builds without the client's own incremental
// render.

// Prototype: incremental 3D render while the camera is still. A monkey patch of the exposed debug bundle (__lc).
// window.__incr.set({ on, verify }) ; window.__incr.stats
//
// Painter's algorithm: a pixel's final value is the last write to it in draw order. Re-running the frame's draw order
// but skipping every triangle whose screen bbox misses a region R, into a scratch buffer, gives exactly the full
// render's pixels inside R (the skipped triangles never touch R; the drawn ones are drawn whole). So, while the
// camera, the level and the static scene are unchanged since the last full render, only R needs redrawing:
//   R = bbox of every dynamic sprite (players, NPCs, projectiles, spot anims) now and in the previous frame
//     + bbox of every animated static (non-Model ModelSource: animated locs, ground items) now and before
//     + bbox of every triangle drawn with an animated texture (17, 24) in the last full render
//     + the mouse point (so picking sees the same models as a full render)
// in 16x16 px tiles. The persistent buffer B holds the last 3D-only frame; the output gets B, then the overlays.
// Any change to the static scene (World set/del calls), the camera arguments, the viewport, the colour table or
// textures forces a full render. verify: N = every Nth partial frame is also fully rendered and compared.
(() => {
    const I = (window.__incr = { on: false, verify: 0, maxDirty: 0.6 });
    const resetStats = () => (I.stats = { frames: 0, full: 0, partial: 0, fullReasons: {}, dirtyTiles: 0, tilesTotal: 0, trisDrawn: 0, trisSkipped: 0, models: 0, modelsSkipped: 0, verified: 0, mismatchFrames: 0, mismatchPx: 0, firstMismatch: null });
    resetStats();
    let installed = false;

    I.install = () => {
        if (installed) return true;
        const L = window.__lc;
        const c = window.__client;
        if (!L || !c?.world) return false;
        installed = true;
        const P2 = L.Pix2D, P3 = L.Pix3D, M = L.Model, MP = M.prototype, WC = L.World, WP = WC.prototype;
        const MSP = Object.getPrototypeOf(MP); // ModelSource.prototype
        const T = I.tile || 16; // tile size (px) of the dirty mask
        // re-installable: the first install keeps the originals; later ones restore them before wrapping again
        const ORIG = (window.__incrOrig = window.__incrOrig || { WP: {}, P3: {}, MP: {}, MSP: {} });
        const keep = (store, obj, name) => {
            if (!(name in store)) store[name] = obj[name];
            else obj[name] = store[name];
        };
        for (const n of ['setLayer', 'setGroundDecor', 'delGroundDecor', 'setObj', 'delObj', 'setWall', 'delWall', 'setDecor', 'delDecor', 'moveDecor', 'addScenery', 'delLoc', 'resetMap', 'fillBaseLevel', 'pushDown', 'shareLight', 'setGround', 'setTile', 'addTile', 'setBridge', 'setDrawLevel', 'renderAll']) if (typeof WP[n] === 'function' || n in ORIG.WP) keep(ORIG.WP, WP, n);
        for (const n of ['initColourTable', 'unpackTextures', 'clearTexels', 'setClipping', 'setRenderClipping', 'gouraudTriangle', 'flatTriangle', 'textureTriangle']) if (typeof P3[n] === 'function' || n in ORIG.P3) keep(ORIG.P3, P3, n);
        keep(ORIG.MP, MP, 'render2');
        keep(ORIG.MSP, MSP, 'worldRender');
        if (c.world && Object.hasOwn(c.world, 'renderAll')) delete c.world.renderAll; // (the probe re-wraps the instance)

        let W = 0, H = 0, tw = 0, th = 0;
        let mask = null; // tiles drawn (cull test) in this partial frame: the commit tiles grown by one more tile
        let cmask = null; // tiles committed: the dirty tiles grown by one tile (the blends read the pixel to their right)
        let B = null, S = null, V = null;
        let lastKey = null;
        let forceFull = 'start';
        let mode = 0; // 0 normal, 1 measure (bbox only, no drawing), 2 partial (cull), 3 full + record
        let bx0, bx1, by0, by1; // measure accumulator
        let mh1 = 0, mh2 = 0; // measure hash accumulator
        const arrayIds = new WeakMap();
        let nextArrayId = 1;
        let animTex = []; // flat [x0, x1, y0, y1, ...] of animated-texture triangles in the last full render
        let animLocs = []; // [source, yaw, rx, ry, rz, typecode] drawn in the last full render
        let prevDyn = new Map(); // source -> bbox + hash of dynamic sprites + animated statics in the previous frame
        let dynSet = new Set();
        let skippedTris = [];
        let probeLog = null;

        const full = why => {
            if (!forceFull) forceFull = why;
        };

        // ---- any change to the static scene forces a full render
        for (const name of ['setLayer', 'setGroundDecor', 'delGroundDecor', 'setObj', 'delObj', 'setWall', 'delWall', 'setDecor', 'delDecor', 'moveDecor', 'addScenery', 'delLoc', 'resetMap', 'fillBaseLevel', 'pushDown', 'shareLight', 'setGround', 'setTile', 'addTile', 'setBridge', 'setDrawLevel']) {
            const f = WP[name];
            if (typeof f !== 'function') continue;
            WP[name] = function (...a) {
                full(`world.${name}`);
                return f.apply(this, a);
            };
        }
        for (const name of ['initColourTable', 'unpackTextures', 'clearTexels', 'setClipping', 'setRenderClipping']) {
            const f = P3[name];
            if (typeof f !== 'function') continue;
            P3[name] = function (...a) {
                full(`Pix3D.${name}`);
                return f.apply(this, a);
            };
        }

        // ---- triangles: measure / cull / record
        const hit = (x0, x1, y0, y1) => {
            if (x1 < 0 || y1 < 0 || x0 >= W || y0 >= H) return false;
            if (x0 < 0) x0 = 0;
            if (y0 < 0) y0 = 0;
            if (x1 >= W) x1 = W - 1;
            if (y1 >= H) y1 = H - 1;
            const tx0 = (x0 / T) | 0, tx1 = (x1 / T) | 0, ty0 = (y0 / T) | 0, ty1 = (y1 / T) | 0;
            for (let ty = ty0; ty <= ty1; ty++) {
                const row = ty * tw;
                for (let tx = tx0; tx <= tx1; tx++) if (mask[row + tx]) return true;
            }
            return false;
        };
        const wrapTri = (name, textured) => {
            const orig = P3[name];
            P3[name] = function (xA, xB, xC, yA, yB, yC) {
                if (I.probe && probeLog) {
                    const [px, py] = I.probe;
                    if (Math.min(xA, xB, xC) - 2 <= px && Math.max(xA, xB, xC) + 2 >= px && Math.min(yA, yB, yC) - 2 <= py && Math.max(yA, yB, yC) + 2 >= py) {
                        probeLog.push({ fn: name, mode, args: Array.prototype.slice.call(arguments), hclip: P3.hclip, trans: P3.trans, drawn: mode !== 1 && (mode !== 2 || hit(Math.min(xA, xB, xC) - 1, Math.max(xA, xB, xC) + 1, Math.min(yA, yB, yC) - 1, Math.max(yA, yB, yC) + 1)) });
                    }
                }
                if (mode === 0) return orig.apply(this, arguments);
                const x0 = (xA < xB ? (xA < xC ? xA : xC) : xB < xC ? xB : xC) - 1;
                const x1 = (xA > xB ? (xA > xC ? xA : xC) : xB > xC ? xB : xC) + 1;
                const y0 = (yA < yB ? (yA < yC ? yA : yC) : yB < yC ? yB : yC) - 1;
                const y1 = (yA > yB ? (yA > yC ? yA : yC) : yB > yC ? yB : yC) + 1;
                if (mode === 1) {
                    if (x0 < bx0) bx0 = x0;
                    if (x1 > bx1) bx1 = x1;
                    if (y0 < by0) by0 = y0;
                    if (y1 > by1) by1 = y1;
                    return;
                }
                if (mode === 2) {
                    if (!hit(x0, x1, y0, y1)) {
                        I.stats.trisSkipped++;
                        if (I.debug) skippedTris.push([orig, Array.prototype.slice.call(arguments), P3.hclip, P3.trans]);
                        return;
                    }
                    I.stats.trisDrawn++;
                    return orig.apply(this, arguments);
                }
                if (textured) {
                    const tex = arguments[18];
                    if (tex === 17 || tex === 24) animTex.push(x0, x1, y0, y1);
                }
                return orig.apply(this, arguments);
            };
        };
        wrapTri('gouraudTriangle', false);
        wrapTri('flatTriangle', false);
        wrapTri('textureTriangle', true);

        // ---- models: in measure mode, the bbox of the projected vertices (no face work); in partial mode, skip a
        // model whose vertices miss R unless it is a picking candidate
        const origRender2 = MP.render2;
        MP.render2 = function (clipped, picking, typecode) {
            if (mode === 0 || mode === 3) return origRender2.call(this, clipped, picking, typecode);
            const sx = M.vertexScreenX, sy = M.vertexScreenY;
            let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, near = false;
            for (let v = 0; v < this.numPoints; v++) {
                const x = sx[v];
                if (x === -5000) {
                    near = true;
                    break;
                }
                const y = sy[v];
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
            if (near) {
                // near-plane clipped faces can land anywhere: the whole screen
                x0 = 0;
                y0 = 0;
                x1 = W - 1;
                y1 = H - 1;
            }
            if (mode === 1) {
                if (this.numPoints > 0) {
                    if (x0 - 1 < bx0) bx0 = x0 - 1;
                    if (x1 + 1 > bx1) bx1 = x1 + 1;
                    if (y0 - 1 < by0) by0 = y0 - 1;
                    if (y1 + 1 > by1) by1 = y1 + 1;
                    // what the model draws: projected vertices (position, yaw, animation frame, depth order) and faces
                    const sz = M.vertexScreenZ;
                    let h1 = mh1 ^ this.numPoints, h2 = mh2 ^ this.numFaces;
                    for (let v = 0; v < this.numPoints; v++) {
                        h1 = Math.imul(h1 ^ sx[v], 16777619);
                        h1 = Math.imul(h1 ^ sy[v], 16777619);
                        h2 = Math.imul(h2 ^ sz[v], 2246822519);
                        h2 = Math.imul(h2 ^ sx[v], 2654435761);
                    }
                    for (const a of [this.faceColourA, this.faceColourB, this.faceColourC, this.faceColour, this.faceAlpha, this.faceRenderType, this.facePriority, this.faceVertexA, this.faceVertexB, this.faceVertexC]) {
                        if (!a) {
                            h1 = Math.imul(h1 ^ 0x5bd1e995, 16777619);
                            continue;
                        }
                        if (I.cheapHash && a !== this.faceAlpha) {
                            // the face arrays by identity (an id per array object), contents only for alpha (which fades)
                            let id = arrayIds.get(a);
                            if (id === undefined) arrayIds.set(a, (id = nextArrayId++));
                            h1 = Math.imul(h1 ^ id, 16777619);
                            h2 = Math.imul(h2 ^ id, 2246822519);
                            continue;
                        }
                        for (let f = 0; f < this.numFaces; f++) {
                            h1 = Math.imul(h1 ^ a[f], 16777619);
                            h2 = Math.imul(h2 ^ a[f], 2246822519);
                        }
                    }
                    mh1 = h1;
                    mh2 = h2;
                }
                return;
            }
            I.stats.models++;
            if (!I.noModelSkip && !picking && !hit(x0 - 1, x1 + 1, y0 - 1, y1 + 1)) {
                I.stats.modelsSkipped++;
                return;
            }
            return origRender2.call(this, clipped, picking, typecode);
        };

        // ---- animated statics (non-Model ModelSources that are not this frame's dynamic sprites) seen in a full render
        const origMSWR = MSP.worldRender;
        MSP.worldRender = function (yaw, sp, cp, sy, cy, rx, ry, rz, typecode) {
            if (mode === 3 && !dynSet.has(this)) animLocs.push([this, yaw, rx, ry, rz, typecode]);
            return origMSWR.call(this, yaw, sp, cp, sy, cy, rx, ry, rz, typecode);
        };

        const measure = (src, yaw, rx, ry, rz, typecode) => {
            bx0 = 1e9;
            bx1 = -1e9;
            by0 = 1e9;
            by1 = -1e9;
            mh1 = 0x811c9dc5;
            mh2 = 0x01000193;
            const saved = M.mouseCheck;
            M.mouseCheck = false;
            mode = 1;
            try {
                src.worldRender(yaw, WC.cameraSinX, WC.cameraCosX, WC.cameraSinY, WC.cameraCosY, rx, ry, rz, typecode);
            } finally {
                mode = 0;
                M.mouseCheck = saved;
            }
            return bx1 >= bx0 ? [bx0, bx1, by0, by1, `${mh1}:${mh2}:${yaw}:${rx}:${ry}:${rz}`] : null;
        };
        const measureDynamic = world => {
            const out = new Map();
            dynSet = new Set();
            for (let i = 0; i < world.dynamicCount; i++) {
                const s = world.dynamicSprites[i];
                if (!s?.model) continue;
                dynSet.add(s.model);
                const b = measure(s.model, s.yaw, s.x - WC.cx, s.y - WC.cy, s.z - WC.cz, s.typecode);
                if (b) out.set(s.model, b);
            }
            for (const [src, yaw, rx, ry, rz, tc] of animLocs) {
                const b = measure(src, yaw, rx, ry, rz, tc);
                if (b) out.set(src, b);
            }
            return out;
        };
        // the bboxes that changed: new, gone, or drawn differently (hash) -> flat rects (old and new)
        const changed = (prev, cur) => {
            const r = [];
            for (const [src, b] of cur) {
                const p = prev.get(src);
                if (p && p[4] === b[4] && p[0] === b[0] && p[1] === b[1] && p[2] === b[2] && p[3] === b[3]) continue;
                r.push(b[0], b[1], b[2], b[3]);
                if (p) r.push(p[0], p[1], p[2], p[3]);
            }
            for (const [src, p] of prev) if (!cur.has(src)) r.push(p[0], p[1], p[2], p[3]);
            return r;
        };
        const markRects = rects => {
            for (let i = 0; i < rects.length; i += 4) {
                let x0 = rects[i], x1 = rects[i + 1], y0 = rects[i + 2], y1 = rects[i + 3];
                if (x1 < 0 || y1 < 0 || x0 >= W || y0 >= H) continue;
                if (x0 < 0) x0 = 0;
                if (y0 < 0) y0 = 0;
                if (x1 >= W) x1 = W - 1;
                if (y1 >= H) y1 = H - 1;
                for (let ty = (y0 / T) | 0; ty <= ((y1 / T) | 0); ty++) for (let tx = (x0 / T) | 0; tx <= ((x1 / T) | 0); tx++) mask[ty * tw + tx] = 1;
            }
        };
        const eachTile = (fn, m = mask) => {
            for (let ty = 0; ty < th; ty++)
                for (let tx = 0; tx < tw; tx++) {
                    if (!m[ty * tw + tx]) continue;
                    const x0 = tx * T, y0 = ty * T, x1 = Math.min(W, x0 + T), y1 = Math.min(H, y0 + T);
                    for (let y = y0; y < y1; y++) fn(y * W + x0, y * W + x1);
                }
        };

        const origRenderAll = WP.renderAll;
        WP.renderAll = function (eyeX, eyeY, eyeZ, maxLevel, eyeYaw, eyePitch) {
            if (!I.on) {
                lastKey = null;
                return origRenderAll.call(this, eyeX, eyeY, eyeZ, maxLevel, eyeYaw, eyePitch);
            }
            I.stats.frames++;
            const O = P2.pixels;
            if (W !== c.viewportWidth || H !== c.viewportHeight || !B || O.length !== W * H) {
                W = c.viewportWidth;
                H = c.viewportHeight;
                tw = Math.ceil(W / T);
                th = Math.ceil(H / T);
                B = new Int32Array(W * H);
                S = new Int32Array(W * H);
                V = new Int32Array(W * H);
                mask = new Uint8Array(tw * th);
                cmask = new Uint8Array(tw * th);
                full('viewport');
            }
            const key = `${eyeX},${eyeY},${eyeZ},${maxLevel},${eyeYaw},${eyePitch},${P3.originX},${P3.originY},${this.minLevel}`;
            if (key !== lastKey) full('camera');
            if (I.fullEvery && I.stats.frames % I.fullEvery === 0) full('periodic');
            if (O.length !== W * H) full('target');

            let partial = !forceFull;
            let rects = null;
            if (partial) {
                // R: dynamic sprites + animated statics now and in the previous frame, animated textures, the mouse
                const tm = performance.now();
                const cur = measureDynamic(this);
                I.stats.measureMs = (I.stats.measureMs || 0) + performance.now() - tm;
                mask.fill(0);
                markRects(I.allDynamic ? [...cur.values(), ...prevDyn.values()].flatMap(b => b.slice(0, 4)) : changed(prevDyn, cur));
                markRects(animTex);
                if (M.mouseCheck) markRects([M.mouseX - 1, M.mouseX + 1, M.mouseY - 1, M.mouseY + 1]);
                // a blended span reads the pixel right of the one it writes (upstream's dst[off++] = ... dst[off]): a pixel
                // left of a changed one can change too, and a changed pixel depends on its right neighbour's earlier draws.
                // Commit the dirty tiles grown by one tile; draw (cull with) those grown by one more.
                const grow = (src, dst) => {
                    dst.fill(0);
                    for (let ty = 0; ty < th; ty++)
                        for (let tx = 0; tx < tw; tx++) {
                            if (!src[ty * tw + tx]) continue;
                            for (let y = Math.max(0, ty - 1); y <= Math.min(th - 1, ty + 1); y++) for (let x = Math.max(0, tx - 1); x <= Math.min(tw - 1, tx + 1); x++) dst[y * tw + x] = 1;
                        }
                };
                if (!I.noGrow) {
                    grow(mask, cmask);
                    grow(cmask, mask);
                } else {
                    cmask.set(mask);
                }
                let n = 0;
                for (let i = 0; i < mask.length; i++) n += mask[i];
                if (n > mask.length * I.maxDirty) {
                    partial = false;
                    forceFull = 'too dirty';
                } else {
                    rects = cur;
                    I.stats.dirtyTiles += n;
                    I.stats.tilesTotal += mask.length;
                }
            }
            if (!partial) {
                I.stats.full++;
                I.stats.fullReasons[forceFull] = (I.stats.fullReasons[forceFull] || 0) + 1;
                forceFull = null;
                animTex = [];
                animLocs = [];
                // (dynSet for this frame, so the recorder can tell dynamic sprites from animated statics)
                dynSet = new Set();
                for (let i = 0; i < this.dynamicCount; i++) if (this.dynamicSprites[i]?.model) dynSet.add(this.dynamicSprites[i].model);
                mode = 3;
                try {
                    origRenderAll.call(this, eyeX, eyeY, eyeZ, maxLevel, eyeYaw, eyePitch);
                } finally {
                    mode = 0;
                }
                B.set(O);
                // bboxes for the next frame's R, once the camera has stopped (the same key two frames running); while it
                // moves every frame is full anyway, so this pass would be wasted
                if (key === lastKey || I.alwaysMeasure) {
                    const tm = performance.now();
                    prevDyn = measureDynamic(this);
                    I.stats.measureMs = (I.stats.measureMs || 0) + performance.now() - tm;
                    lastKey = key;
                } else {
                    prevDyn = new Map();
                    lastKey = key;
                    forceFull = 'settling';
                }
                return;
            }
            // partial: render R into the scratch, commit R into B, B to the output
            I.stats.partial++;
            skippedTris = [];
            const logPartial = I.probe ? [] : null;
            probeLog = logPartial;
            P2.pixels = S;
            eachTile((a, b) => S.fill(0, a, b));
            mode = 2;
            try {
                origRenderAll.call(this, eyeX, eyeY, eyeZ, maxLevel, eyeYaw, eyePitch);
            } finally {
                mode = 0;
                P2.pixels = O;
            }
            eachTile((a, b) => B.set(S.subarray(a, b), a), cmask);
            O.set(B);
            I.lastPrev = prevDyn;
            prevDyn = rects;
            if (I.verify && I.stats.partial % I.verify === 0) {
                // the same frame rendered in full (the picking state saved and restored around it)
                const pc = M.pickedCount, mc = M.mouseCheck;
                const gx = WC.groundX, gz = WC.groundZ, click = WC.click;
                M.mouseCheck = false;
                WC.click = false;
                P2.pixels = V;
                V.fill(0);
                const logFull = I.probe ? [] : null;
                probeLog = logFull;
                try {
                    origRenderAll.call(this, eyeX, eyeY, eyeZ, maxLevel, eyeYaw, eyePitch);
                } finally {
                    P2.pixels = O;
                    M.pickedCount = pc;
                    M.mouseCheck = mc;
                    WC.groundX = gx;
                    WC.groundZ = gz;
                    WC.click = click;
                }
                probeLog = null;
                if (I.probe) {
                    const pi = I.probe[1] * W + I.probe[0];
                    if (V[pi] !== B[pi] && !I.probeResult) I.probeResult = { full: logFull, partial: logPartial, prevFull: I.prevProbeFull, V: V[pi], B: B[pi], S: S[pi], prevV: I.prevProbeV };
                    I.prevProbeFull = logFull;
                    I.prevProbeV = V[pi];
                }
                let bad = 0, first = -1, inR = 0, mx0 = W, mx1 = -1, my0 = H, my1 = -1;
                for (let i = 0; i < V.length; i++)
                    if (V[i] !== B[i]) {
                        bad++;
                        if (first < 0) first = i;
                        const x = i % W, y = (i / W) | 0;
                        if (mask[((y / T) | 0) * tw + ((x / T) | 0)]) inR++;
                        if (x < mx0) mx0 = x;
                        if (x > mx1) mx1 = x;
                        if (y < my0) my0 = y;
                        if (y > my1) my1 = y;
                    }
                I.stats.verified++;
                if (bad) {
                    I.stats.mismatchFrames++;
                    I.stats.mismatchPx += bad;
                    const info = { frame: I.stats.frames, px: bad, inR, bbox: [mx0, mx1, my0, my1], cycle: c.constructor.loopCycle, dyn: rects.size, changed: changed(I.lastPrev ?? new Map(), rects).length / 4 };
                    (I.stats.mismatches ||= []).push(info);
                    if (I.autoProbe && !I.probe) I.probe = [first % W, (first / W) | 0];
                    if (!I.stats.firstMismatch) {
                        I.stats.firstMismatch = info;
                        I.lastBad = { V: V.slice(), B: B.slice(), mask: mask.slice() };
                    }
                    if (I.debug && !I.culprits) {
                        const bad = [];
                        for (let i = 0; i < V.length; i++) if (V[i] !== B[i]) bad.push(i);
                        const T2 = new Int32Array(W * H);
                        const found = [];
                        P2.pixels = T2;
                        const sh = P3.hclip, st = P3.trans;
                        for (const [fn, args, hclip, trans] of skippedTris) {
                            T2.fill(0x7f00ff);
                            P3.hclip = hclip;
                            P3.trans = trans;
                            try {
                                fn.apply(P3, args);
                            } catch {}
                            const hitBad = bad.filter(i => T2[i] !== 0x7f00ff).length;
                            if (hitBad) found.push({ fn: fn.name, args: args.slice(0, 9), hitBad });
                            if (found.length > 5) break;
                        }
                        P2.pixels = O;
                        P3.hclip = sh;
                        P3.trans = st;
                        I.culprits = { badPx: bad.length, skipped: skippedTris.length, found };
                    }
                }
            }
        };
        I.forceFull = why => full(why ?? 'manual');
        return true;
    };

    I.set = (o = {}) => {
        if (!I.install()) return 'not ready';
        Object.assign(I, o);
        resetStats();
        return JSON.stringify({ on: I.on, verify: I.verify });
    };
})();
