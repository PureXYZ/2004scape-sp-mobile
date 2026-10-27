// rsbuf's per-tick reset of the info renderers, for what was written only (installed by runtime/tick.ts; imports only
// rsbuf, so test/rsbuf.test.mjs can install it on upstream's renderers and compare).
//
// rsbuf.cleanup() (every tick, rsbuf/index.ts:297) has each renderer clear its per-tick caches: highs.fill(0) and
// fill(null) over 8 caches of 16 384 npcs and 8 of 2 048 players, ~147 000 slots, though about 12 npcs cache anything in
// a tick. A renderer writes highs[id] only in computeInfo() (for its entity's id) and its caches only through cache()
// (computeInfo, and info.ts for face entity/coord), so those note the ids, and removeTemporary() resets exactly those
// ids: the arrays end up as after the fills (the lows and the players' APPEARANCE cache are not per-tick, as upstream).
// An id outside the arrays (none in practice) makes that tick's reset the original fills.
import { NpcInfoProt, PlayerInfoProt, npcInfoProtIndex, playerInfoProtIndex } from '#/network/rsbuf/prot.js';
import { NpcRenderer, PlayerRenderer } from '#/network/rsbuf/renderer.js';

type Renderer = { caches: Array<Array<Uint8Array | null>>; highs: Uint16Array };
type Written = { mark: Uint8Array; ids: number[]; outside: boolean };

const written = new WeakMap<Renderer, Written>();

function note(renderer: Renderer, id: number) {
    let w = written.get(renderer);
    if (w === undefined) written.set(renderer, (w = { mark: new Uint8Array(renderer.highs.length), ids: [], outside: false }));
    if (!(Number.isInteger(id) && id >= 0 && id < w.mark.length)) {
        w.outside = true;
    } else if (w.mark[id] === 0) {
        w.mark[id] = 1;
        w.ids.push(id);
    }
}

function resetWritten(R: { prototype: object }, idOf: (entity: never) => number, temporary: number[]) {
    const proto = R.prototype as Record<string, (this: Renderer, ...a: never[]) => unknown>;
    const computeInfo = proto.computeInfo;
    const cache = proto.cache;
    const removeTemporary = proto.removeTemporary;
    proto.computeInfo = function (this: Renderer, entity: never) {
        const r = computeInfo.call(this, entity);
        const id = idOf(entity);
        if (this.highs[id] > 0) note(this, id); // (an id outside the array reads undefined: nothing was written there)
        return r;
    };
    proto.cache = function (this: Renderer, id: number, message: never, prot: never) {
        note(this, id);
        return cache.call(this, id as never, message, prot);
    };
    proto.removeTemporary = function (this: Renderer) {
        const w = written.get(this);
        if (w === undefined) return; // nothing written since the renderer was made: every slot is 0 / null already
        const { mark, ids } = w;
        if (w.outside) {
            w.outside = false;
            for (let i = 0; i < ids.length; i++) mark[ids[i]] = 0;
            ids.length = 0;
            return removeTemporary.call(this);
        }
        const highs = this.highs;
        const caches = this.caches;
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            highs[id] = 0;
            for (let t = 0; t < temporary.length; t++) caches[temporary[t]][id] = null;
            mark[id] = 0;
        }
        ids.length = 0;
    };
}

/** Patches NpcRenderer and PlayerRenderer (once, before the first tick). */
export function installRendererResets(): void {
    // the caches removeTemporary() clears (renderer.ts:128, :233)
    resetWritten(
        NpcRenderer,
        (npc: { nid: number }) => npc.nid,
        [NpcInfoProt.ANIM, NpcInfoProt.FACE_ENTITY, NpcInfoProt.SAY, NpcInfoProt.DAMAGE, NpcInfoProt.DAMAGE2, NpcInfoProt.CHANGE_TYPE, NpcInfoProt.SPOT_ANIM, NpcInfoProt.FACE_COORD].map(npcInfoProtIndex)
    );
    resetWritten(
        PlayerRenderer,
        (player: { pid: number }) => player.pid,
        [PlayerInfoProt.ANIM, PlayerInfoProt.FACE_ENTITY, PlayerInfoProt.SAY, PlayerInfoProt.DAMAGE, PlayerInfoProt.DAMAGE2, PlayerInfoProt.FACE_COORD, PlayerInfoProt.CHAT, PlayerInfoProt.SPOT_ANIM].map(playerInfoProtIndex)
    );
}
