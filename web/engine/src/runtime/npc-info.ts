// processInfo without the npcs whose rsbuf mirror already holds their info (installed by runtime/tick.ts on World;
// imports only rsbuf, so test/tick.test.mjs can install it on a stand-in World that runs upstream's own npc loop).
//
// World.processInfo calls rsbuf.computeNpc (28 arguments, a CoordGrid, ~27 stores into the npc's mirror) for every npc
// every tick, though most are just as their mirror holds them after its per-tick cleanup (Npc in rsbuf/npc.ts). For an
// npc with no masks, no step, no tele or jump and no face square, whose coord, type, active flag, face entity and
// orientation are those of its last computeNpc, the call would leave the mirror as it is - but for the fields read only
// under a mask (damage, hitpoints, anim, say, spotanim: computeInfo and the encoder read them only when the npc has that
// mask, and every computeNpc writes them all again first) - and computeInfo returns at once without masks. processInfo
// walks a view of World.npcs without those npcs (its loop is upstream's), and their mirror's cleanup, which would reset
// nothing, is skipped. What computeNpc was last given is noted per nid when the view hands the npc out; World.addNpc
// (rsbuf.addNpc: a new mirror) and World.removeNpc (rsbuf.removeNpc) forget it. Both are the only callers of those.
import { Npc as NpcMirror } from '#/network/rsbuf/npc.js';

type InfoNpc = {
    nid: number;
    type: number;
    x: number;
    z: number;
    level: number;
    isActive: boolean;
    masks: number;
    tele: boolean;
    jump: boolean;
    runDir: number;
    walkDir: number;
    faceSquareX: number;
    faceSquareZ: number;
    faceEntity: number;
    faceAngleX: number;
    faceAngleZ: number;
};

const NIDS = 16384; // rsbuf's NPCS (index.ts): every nid is below it
const noted = new Uint8Array(NIDS); // what computeNpc was last given is below (since the nid's mirror was made)
const computed = new Uint8Array(NIDS); // computeNpc ran this tick: the mirror needs its cleanup
const notedX = new Int32Array(NIDS);
const notedZ = new Int32Array(NIDS);
const notedLevel = new Int32Array(NIDS);
const notedType = new Int32Array(NIDS);
const notedActive = new Uint8Array(NIDS);
const notedFaceEntity = new Int32Array(NIDS);
const notedFaceAngleX = new Int32Array(NIDS);
const notedFaceAngleZ = new Int32Array(NIDS);

/** computeNpc(npc) would leave the npc's mirror as rsbuf.cleanup() left it. */
function mirrorCurrent(npc: InfoNpc, nid: number): boolean {
    return (
        noted[nid] === 1 &&
        npc.masks === 0 &&
        npc.walkDir === -1 &&
        npc.runDir === -1 &&
        npc.tele === false &&
        npc.jump === false &&
        npc.faceSquareX === -1 &&
        npc.faceSquareZ === -1 &&
        npc.x === notedX[nid] &&
        npc.z === notedZ[nid] &&
        npc.level === notedLevel[nid] &&
        npc.type === notedType[nid] &&
        (npc.isActive ? 1 : 0) === notedActive[nid] &&
        npc.faceEntity === notedFaceEntity[nid] &&
        npc.faceAngleX === notedFaceAngleX[nid] &&
        npc.faceAngleZ === notedFaceAngleZ[nid]
    );
}

class InfoNpcs {
    private readonly inner: Iterator<InfoNpc>;

    constructor(npcs: Iterable<InfoNpc>) {
        this.inner = npcs[Symbol.iterator]();
    }

    next(): IteratorResult<InfoNpc, undefined> {
        for (;;) {
            const r = this.inner.next();
            if (r.done) return { value: undefined, done: true };
            const npc = r.value;
            const nid = npc.nid;
            if (!(nid >= 0 && nid < NIDS)) return { value: npc, done: false };
            if (mirrorCurrent(npc, nid)) continue;
            // processInfo passes exactly these to rsbuf.computeNpc right after this step
            noted[nid] = 1;
            computed[nid] = 1;
            notedX[nid] = npc.x;
            notedZ[nid] = npc.z;
            notedLevel[nid] = npc.level;
            notedType[nid] = npc.type;
            notedActive[nid] = npc.isActive ? 1 : 0;
            notedFaceEntity[nid] = npc.faceEntity;
            notedFaceAngleX[nid] = npc.faceAngleX;
            notedFaceAngleZ[nid] = npc.faceAngleZ;
            return { value: npc, done: false };
        }
    }

    return(value?: unknown): IteratorResult<InfoNpc> {
        this.inner.return?.();
        return { value: value as InfoNpc, done: true };
    }

    [Symbol.iterator]() {
        return this;
    }
}

type WorldInfo = { npcs: Iterable<InfoNpc>; processInfo(): void; addNpc(npc: InfoNpc, ...a: unknown[]): void; removeNpc(npc: InfoNpc, ...a: unknown[]): void };

/** Patches `world` (World's prototype) and the rsbuf mirror's cleanup. */
export function installNpcInfoSkip(world: object, Mirror: typeof NpcMirror = NpcMirror): void {
    const proto = world as WorldInfo;
    const processInfo = proto.processInfo;
    proto.processInfo = function (this: WorldInfo) {
        const npcs = this.npcs;
        this.npcs = { [Symbol.iterator]: () => new InfoNpcs(npcs) }; // only processInfo's npc loop reads World.npcs here
        try {
            return processInfo.call(this);
        } finally {
            this.npcs = npcs;
        }
    };
    const addNpc = proto.addNpc;
    proto.addNpc = function (this: WorldInfo, npc: InfoNpc, ...a: unknown[]) {
        const nid = npc.nid;
        if (nid >= 0 && nid < NIDS) noted[nid] = 0; // (a first spawn makes a new mirror)
        return addNpc.call(this, npc, ...a);
    };
    const removeNpc = proto.removeNpc;
    proto.removeNpc = function (this: WorldInfo, npc: InfoNpc, ...a: unknown[]) {
        const nid = npc.nid; // (a despawn drops the mirror, and npc.cleanup() sets nid to -1)
        const r = removeNpc.call(this, npc, ...a);
        if (nid >= 0 && nid < NIDS) noted[nid] = 0;
        return r;
    };
    // rsbuf.cleanup() -> every mirror's cleanup(): only a computeNpc this tick can have set what it resets
    const cleanup = Mirror.prototype.cleanup;
    Mirror.prototype.cleanup = function (this: NpcMirror) {
        const nid = this.nid;
        if (nid >= 0 && nid < NIDS) {
            if (computed[nid] === 0) return;
            computed[nid] = 0;
        }
        return cleanup.call(this);
    };
}
