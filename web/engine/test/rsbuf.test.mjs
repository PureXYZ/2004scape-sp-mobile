#!/usr/bin/env node
// runtime/rsbuf.ts (the info renderers reset only the ids written in a tick) against upstream's removeTemporary()
// fills: seeded programs drive upstream's own NpcRenderer and PlayerRenderer (bundled from the pinned sources) through
// ticks of computeInfo() with random masks, cache() as info.ts calls it (face entity/coord), removePermanent() and
// removeTemporary(), with ids that repeat, -1 and ids outside the arrays; after every removeTemporary() each array is
// hashed whole (highs, lows, every cache slot's bytes or null, and any key outside the slots). The traces of the same
// programs before and after installRendererResets() must be identical, and a reset that misses the cache() writes
// must be caught.
//
//   node web/engine/test/rsbuf.test.mjs [--cases=60]
import { importBundled } from './lib/bundle.mjs';

const CASES = Number((process.argv.find(a => a.startsWith('--cases=')) ?? '--cases=60').split('=')[1]);

const M = await importBundled(
    'rsbuf-test',
    `export { NpcRenderer, PlayerRenderer } from '#/network/rsbuf/renderer.js';
export { Npc } from '#/network/rsbuf/npc.js';
export { Player, Chat } from '#/network/rsbuf/player.js';
export { NpcInfoProt, PlayerInfoProt } from '#/network/rsbuf/prot.js';
export { NpcInfoFaceEntity, NpcInfoFaceCoord, PlayerInfoFaceEntity, PlayerInfoFaceCoord } from '#/network/rsbuf/messages.js';
export { installRendererResets } from './runtime/rsbuf.js';`
);
const { NpcRenderer, PlayerRenderer, Npc, Player, Chat, NpcInfoProt, PlayerInfoProt, installRendererResets } = M;

let seed = 1;
const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = n => Math.floor(rnd() * n);

function fnv(h, v) {
    h ^= v & 0xffff;
    h = Math.imul(h, 16777619);
    h ^= v >>> 16;
    return Math.imul(h, 16777619);
}

/** Every slot of the renderer's arrays, and any key outside them (an id the original fills would not reach). */
function snapshot(r) {
    let h = 2166136261;
    for (const a of [r.highs, r.lows]) for (let i = 0; i < a.length; i++) if (a[i] !== 0) h = fnv(fnv(h, i), a[i]);
    for (let c = 0; c < r.caches.length; c++) {
        const cache = r.caches[c];
        h = fnv(h, cache.length);
        for (let i = 0; i < cache.length; i++) {
            const b = cache[i];
            if (b === null) continue;
            if (b === undefined) {
                h = fnv(fnv(h, 9999), i); // a hole (the array grew past its slots)
                continue;
            }
            h = fnv(fnv(fnv(h, c), i), b.length);
            for (let k = 0; k < b.length; k++) h = fnv(h, b[k]);
        }
        for (const key of Object.keys(cache)) if (!(String(Number(key)) === key && Number(key) < cache.length)) h = fnv(fnv(h, 7777), key.length);
    }
    return (h >>> 0).toString(16);
}

const NPC_PROTS = Object.values(NpcInfoProt).filter(v => typeof v === 'number');
const PLAYER_PROTS = Object.values(PlayerInfoProt).filter(v => typeof v === 'number');

function program(kind) {
    const npc = kind === 'npc';
    const r = npc ? new NpcRenderer() : new PlayerRenderer();
    const size = r.highs.length;
    const pool = [...Array(6 + ri(10))].map(() => ri(size));
    const pick = () => (ri(40) === 0 ? [-1, size, size + 3][ri(3)] : pool[ri(pool.length)]);
    const mirrors = new Map();
    const mirror = id => {
        let m = mirrors.get(id);
        if (!m) mirrors.set(id, (m = npc ? new Npc(id, ri(3000)) : new Player(id)));
        return m;
    };
    const trace = [];
    for (let tick = 0, ticks = 4 + ri(12); tick < ticks; tick++) {
        for (let k = ri(12); k > 0; k--) {
            const op = ri(10);
            const id = pick();
            if (op < 6) {
                const m = mirror(id);
                let masks = 0;
                for (const p of npc ? NPC_PROTS : PLAYER_PROTS) if (ri(3) === 0) masks |= p;
                m.masks = ri(5) === 0 ? 0 : masks;
                m.animId = ri(5000);
                m.animDelay = ri(10);
                m.faceEntity = ri(2) ? -1 : ri(40000);
                m.faceX = ri(2) ? -1 : ri(13000);
                m.faceZ = ri(13000);
                m.say = ri(3) ? null : `hi ${ri(100)}`;
                m.damageTaken = ri(50);
                m.damageType = ri(3);
                m.damageTaken2 = ri(50);
                m.damageType2 = ri(3);
                m.currentHitpoints = ri(99);
                m.baseHitpoints = 99;
                m.graphicId = ri(500);
                m.graphicHeight = ri(100);
                m.graphicDelay = ri(10);
                if (npc) m.ntype = ri(3000);
                else {
                    if (ri(4) === 0) m.appearance = Uint8Array.from({ length: 8 + ri(8) }, () => ri(256));
                    m.chat = ri(2) ? null : new Chat(Uint8Array.from({ length: ri(6) }, () => ri(256)), ri(12), ri(6), 0);
                }
                trace.push(`c${id}:${r.computeInfo(m)}`);
            } else if (op < 9) {
                // info.ts: a newly seen entity's face entity / face coord
                const coord = ri(2);
                const message = npc ? (coord ? new M.NpcInfoFaceCoord(ri(13000), ri(13000)) : new M.NpcInfoFaceEntity(ri(40000))) : coord ? new M.PlayerInfoFaceCoord(ri(13000), ri(13000)) : new M.PlayerInfoFaceEntity(ri(40000));
                const prot = npc ? (coord ? NpcInfoProt.FACE_COORD : NpcInfoProt.FACE_ENTITY) : coord ? PlayerInfoProt.FACE_COORD : PlayerInfoProt.FACE_ENTITY;
                trace.push(`k${id}:${r.cache(id, message, prot)}`);
            } else {
                r.removePermanent(id);
                trace.push(`p${id}`);
            }
        }
        r.removeTemporary();
        trace.push(`t${tick}:${snapshot(r)}`);
    }
    return trace.join(' ');
}

const runAll = () => ['npc', 'player'].flatMap((kind, k) => [...Array(CASES)].map((_, c) => ((seed = 5000 + c * 7919 + k * 104729), program(kind))));

const reference = runAll();
const originalRemove = NpcRenderer.prototype.removeTemporary;
const upstreamCache = NpcRenderer.prototype.cache;
installRendererResets();
if (NpcRenderer.prototype.removeTemporary === originalRemove) {
    console.log('rsbuf: FAIL - installRendererResets did not patch the renderers');
    process.exit(1);
}
const patched = runAll();
const differences = reference.filter((t, i) => t !== patched[i]).length;
if (differences) {
    const i = reference.findIndex((t, k) => t !== patched[k]);
    console.log(`case ${i}\n  upstream: ${reference[i].slice(0, 600)}\n  patched:  ${patched[i].slice(0, 600)}`);
}

// a reset that forgets the ids cache() wrote (face entity/coord of newly seen npcs) must show
const patchedCache = NpcRenderer.prototype.cache;
NpcRenderer.prototype.cache = upstreamCache;
const mutant = runAll().filter((t, i) => t !== reference[i]).length;
NpcRenderer.prototype.cache = patchedCache;

const ok = differences === 0 && mutant > 0;
console.log(ok ? `rsbuf: PASS - ${reference.length} programs identical to upstream's fills (npc and player renderers); a reset missing cache()'s ids caught in ${mutant}` : `rsbuf: FAIL - ${differences} programs differ${mutant ? '' : ', the mutant was not caught'}`);
process.exit(ok ? 0 : 1);
