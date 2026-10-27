// render-verify: the canvases hold exactly the client's frames. Right after a PixMap that owns its canvas draws (the
// mobile layout's surfaces; client patch 0026 sends only the changed pixels), every `every`th time, the canvas is read
// back and compared with the PixMap's pixels: what the 3D check proves for the buffer, this proves for the screen.
// window.__rvShown.start({ every }) / .report()
(() => {
    if (window.__rvShown) return;
    const S = (window.__rvShown = { on: false, every: 25, reads: 0, differing: 0, differingPx: 0, byArea: {}, first: [] });
    let installed = false;
    const rgba = p => ((p & 0xff0000) >> 16) | (p & 0xff00) | ((p & 0xff) << 16) | 0xff000000;
    const install = () => {
        const L = window.__lc;
        const c = window.__client;
        if (installed || !L?.PixMap || !c) return installed;
        const PP = L.PixMap.prototype;
        const draw = PP.draw;
        const counts = new WeakMap();
        PP.draw = function (...a) {
            const r = draw.apply(this, a);
            // (every world draw should follow a renderAll: a build that skipped renderAll for a frame would escape the
            // oracle, so the report compares the two counts)
            if (S.on && this === c.areaGame && c.ingame && c.sceneState === 2) S.worldDraws++;
            if (!S.on || !this.ctx || !this.own) return r;
            const n = (counts.get(this) ?? 0) + 1;
            counts.set(this, n);
            if (n % S.every !== 0) return r;
            const area = ['areaGame', 'areaMap', 'areaSide', 'areaChat'].find(k => c[k] === this) ?? '?';
            const got = new Int32Array(this.ctx.getImageData(0, 0, this.width, this.height).data.buffer);
            let bad = 0;
            for (let i = 0; i < got.length; i++) if (got[i] !== rgba(this.data[i])) bad++;
            S.reads++;
            const z = (S.byArea[area] ??= { reads: 0, differing: 0 });
            z.reads++;
            if (bad) {
                S.differing++;
                S.differingPx += bad;
                z.differing++;
                if (S.first.length < 20) S.first.push({ area, px: bad, scene: window.__rv?.scene, t: Date.now() });
            }
            return r;
        };
        installed = true;
        return true;
    };
    S.start = (o = {}) => {
        if (!install()) return 'not ready';
        Object.assign(S, { every: 25, reads: 0, differing: 0, differingPx: 0, byArea: {}, first: [], worldDraws: 0 }, o, { on: true });
        return 'ok';
    };
    S.report = () => ({ every: S.every, reads: S.reads, differing: S.differing, differingPx: S.differingPx, byArea: S.byArea, first: S.first, worldDraws: S.worldDraws, renderAlls: window.__rv?.stats?.frames ?? null });
})();
