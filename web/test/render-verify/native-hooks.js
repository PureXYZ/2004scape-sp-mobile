// render-verify: the adapter for the client's own incremental render (patch 0029, branch perf-render). It needs, from
// the patch: World.incrBypass (true: renderAll draws upstream's frame and touches no incremental state) and
// World.incrLast ('partial' or 'full:<why>', what the last renderAll did). The oracle (oracle.js) wraps renderAll around
// the patched one; the patch calls renderAll again from inside for upstream's traversal, which the oracle passes
// straight through.
// mutant (impl 'native-mutant'): the patch with one step broken on purpose (what the reference drew and this frame did not
// is no longer redrawn: IncrRender.markRef does nothing), which the oracle must catch as soon as something moves.
window.__rvNativeHooks = (L, c, mutant = false) => {
    const W = L.World;
    if (!('incrBypass' in W) || !('incrLast' in W)) return null;
    if (mutant) {
        if (typeof L.IncrRender?.markRef !== 'function') return null;
        L.IncrRender.markRef = () => {};
    }
    const impl = W.prototype.renderAll;
    const reasons = {};
    return {
        impl,
        ref: function (...a) {
            W.incrBypass = true;
            try {
                return impl.apply(this, a);
            } finally {
                W.incrBypass = false;
            }
        },
        kind: () => {
            const last = String(W.incrLast);
            const why = last.startsWith('partial') ? 'partial' : last;
            reasons[why] = (reasons[why] ?? 0) + 1;
            return last.startsWith('partial') ? 'partial' : last.startsWith('full') ? 'full' : 'unknown';
        },
        stats: () => ({ last: W.incrLast, reasons, enabled: L.IncrRender?.enabled, verify: L.IncrRender?.verify })
    };
};
