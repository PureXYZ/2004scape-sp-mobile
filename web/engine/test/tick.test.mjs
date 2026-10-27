#!/usr/bin/env node
// runtime/npc-info.ts (processInfo leaves out the npcs whose rsbuf mirror holds their info) and runtime/lookups.ts
// (HuntType.get, ScriptRunner.HANDLERS) against the pinned upstream sources.
//
// npc info: upstream's own rsbuf (index.ts, the mirrors, renderers and encoders, bundled from the pinned sources) is
// driven by a stand-in World whose processInfo is upstream's npc loop, taken from World.ts as text, and whose
// addNpc/removeNpc call rsbuf as World's do. Seeded programs of npcs that rest, walk, run, teleport, jump, turn, change
// type, fight and talk (with stale hitmarks, anims and says left on the resting ones), despawn, respawn and reuse nids,
// seen by observers that come and go, give per tick every observer's npcInfo() bytes and every npc's observer count.
// The traces with the patch (and runtime/rsbuf.ts, as shipped) must equal upstream's, and five wrong patches (one
// check, or the forgetting on addNpc/removeNpc, left out) must be caught. The shapes the patch relies on are checked in the source:
// computeNpc, addNpc and removeNpc are called only from World.processInfo, World.addNpc and World.removeNpc, and every
// mirror field computeNpc writes is either compared by the patch or reset by the mirror's cleanup().
//
// lookups: HuntType.get matches the original for every id (the pinned get is `configs[id]`); the packed HANDLERS has
// the same handler (or undefined) at every opcode, takes later assignments, and is left alone for a table with other
// keys; only ScriptRunner reads HANDLERS, by opcode.
//
//   node web/engine/test/tick.test.mjs [--cases=40]
import fs from 'node:fs';
import path from 'node:path';

import * as esbuild from 'esbuild';

import { importBundled } from './lib/bundle.mjs';
import { SERVER } from './lib/fixture.mjs';

const CASES = Number((process.argv.find(a => a.startsWith('--cases=')) ?? '--cases=40').split('=')[1]);
const SRC = path.join(SERVER, 'engine/src');
const read = file => fs.readFileSync(path.join(SRC, file), 'utf8');
const failures = [];
const fail = message => failures.push(message);

/** The text of the `{...}` block that starts at the first `{` at or after `from`. */
function block(text, from) {
    const open = text.indexOf('{', from);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
    }
    throw new Error('unbalanced block');
}

/** The body of `name(` as a method in `text` (the first one declared). */
function method(text, name) {
    const m = new RegExp(`\\n    (?:(?:private|public|static|async) )*${name}\\(`).exec(text);
    if (!m) throw new Error(`no method ${name}`);
    return block(text, m.index);
}

// ---- shapes in the pinned source ---------------------------------------------------------------------------------

const WORLD = read('engine/World.ts');
const callers = { computeNpc: 'processInfo', addNpc: 'addNpc', removeNpc: 'removeNpc' };
const sources = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|mts)$/.test(e.name) && !p.includes(`${path.sep}network${path.sep}rsbuf${path.sep}`)) sources.push([path.relative(SRC, p), fs.readFileSync(p, 'utf8')]);
    }
})(SRC);
for (const [fn, inMethod] of Object.entries(callers)) {
    const calls = sources.flatMap(([file, text]) => [...text.matchAll(new RegExp(`\\b${fn}\\(`, 'g'))].filter(m => /rsbuf\.$/.test(text.slice(m.index - 6, m.index))).map(() => file));
    const named = sources.filter(([, text]) => new RegExp(`import \\{[^}]*\\b${fn}\\b[^}]*\\} from '#/network/rsbuf`).test(text)).map(([file]) => file);
    const inside = (method(WORLD, inMethod).match(new RegExp(`rsbuf\\.${fn}\\(`, 'g')) ?? []).length;
    if (calls.length !== 1 || calls[0] !== 'engine/World.ts' || inside !== 1 || named.length) fail(`rsbuf.${fn} is called from ${calls.join(', ') || 'nowhere'}${named.length ? ` and imported by name in ${named.join(', ')}` : ''}, not once from World.${inMethod}`);
}

const INDEX = read('network/rsbuf/index.ts');
const MIRROR = read('network/rsbuf/npc.ts');
const computeNpcBody = block(INDEX, INDEX.indexOf('export function computeNpc('));
const written = new Set([...computeNpcBody.matchAll(/\n\s+npc\.(\w+) = /g)].map(m => m[1]));
const reset = new Set([...method(MIRROR, 'cleanup').matchAll(/this\.(\w+) = /g)].map(m => m[1]));
const compared = new Set(['ntype', 'coord', 'active', 'faceEntity', 'orientationX', 'orientationZ']); // npc-info.ts mirrorCurrent: type, x/z/level, isActive, faceEntity, faceAngleX/Z
const unaccounted = [...written].filter(f => !compared.has(f) && !reset.has(f));
if (written.size < 20 || unaccounted.length) fail(`computeNpc writes mirror fields the patch neither compares nor sees reset: ${unaccounted.join(', ') || `(only ${written.size} found)`}`);

// upstream's npc loop, as processInfo runs it (after its early return without players)
const PROCESS_INFO = method(WORLD, 'processInfo');
if (!/^\{\s*if \(this\.getTotalPlayers\(\) === 0\) \{\s*return;\s*\}/.test(PROCESS_INFO)) fail('World.processInfo no longer starts with its return without players');
const loopAt = PROCESS_INFO.indexOf('for (const npc of this.npcs)');
if (loopAt < 0) throw new Error('World.processInfo: no npc loop found');
const LOOP = esbuild.transformSync(`for (const npc of this.npcs)${block(PROCESS_INFO, loopAt)}`, { loader: 'ts' }).code;
const LOOP_READS = new Set([...LOOP.matchAll(/\bnpc\.(\w+)/g)].map(m => m[1]));
const NPC_FIELDS = ['x', 'level', 'z', 'nid', 'type', 'tele', 'jump', 'runDir', 'walkDir', 'isActive', 'masks', 'faceEntity', 'faceSquareX', 'faceSquareZ', 'faceAngleX', 'faceAngleZ', 'hitmarkDamage', 'hitmarkType', 'hitmark2Damage', 'hitmark2Type', 'levels', 'baseLevels', 'animId', 'animDelay', 'sayMessage', 'spotanimId', 'spotanimHeight', 'spotanimTime'];
const unknownReads = [...LOOP_READS].filter(f => !NPC_FIELDS.includes(f));
if (unknownReads.length) fail(`upstream's npc loop reads npc fields this test does not make: ${unknownReads.join(', ')}`);

// ---- npc info: upstream vs the patch -----------------------------------------------------------------------------

const ENTRY = `export * as rsbuf from '#/network/rsbuf/index.js';
export { Npc as NpcMirror } from '#/network/rsbuf/npc.js';
export { NpcInfoProt } from '#/network/rsbuf/prot.js';
export { installNpcInfoSkip } from './runtime/npc-info.js';
export { installRendererResets } from './runtime/rsbuf.js';`;

/** npc-info.ts with every `from` replaced by `to` (a wrong patch). */
const mutate = (from, to) => ({
    name: 'npc-info-mutant',
    setup(build) {
        build.onLoad({ filter: /runtime[\\/]npc-info\.ts$/ }, args => {
            const text = fs.readFileSync(args.path, 'utf8');
            if (!text.includes(from)) throw new Error(`mutant: '${from}' not in npc-info.ts`);
            return { contents: text.replaceAll(from, to), loader: 'ts' };
        });
    }
});

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

const BASE_X = 3200;
const BASE_Z = 3200;
const SPREAD = 40; // npcs and observers within 40 tiles: zones crossed, npcs in and out of view (15)
const NpcStat = { HITPOINTS: 3 }; // NpcStat.ts (a const enum)
if (!/^\s*ATTACK,\s*DEFENCE,\s*STRENGTH,\s*HITPOINTS,/.test(block(read('engine/entity/NpcStat.ts'), 0).slice(1))) fail('NpcStat.HITPOINTS is no longer 3');

/** A stand-in World on one copy of rsbuf (`module`): upstream's processInfo npc loop, addNpc/removeNpc as World's; the
 *  patches installed once, as the entry does. */
function stand(module, patched) {
    const { rsbuf } = module;
    const processInfo = new Function('rsbuf', 'NpcStat', `return function processInfo() { if (this.getTotalPlayers() === 0) return; ${LOOP} }`)(rsbuf, NpcStat);
    class World {
        constructor() {
            this.npcs = [];
            this.players = 1;
        }
        getTotalPlayers() {
            return this.players;
        }
        addNpc(npc, firstSpawn = true) {
            // World.addNpc: a first spawn makes the mirror and enters the list
            if (firstSpawn) {
                rsbuf.addNpc(npc.nid, npc.type);
                this.npcs.push(npc);
                this.npcs.sort((a, b) => a.nid - b.nid);
            }
            npc.x = npc.startX;
            npc.z = npc.startZ;
            npc.isActive = true;
        }
        removeNpc(npc, despawn) {
            // World.removeNpc: inactive; a despawn drops the mirror, leaves the list and npc.cleanup() sets nid -1
            if (!npc.isActive) return;
            npc.isActive = false;
            if (despawn) {
                rsbuf.removeNpc(npc.nid);
                this.npcs.splice(this.npcs.indexOf(npc), 1);
                npc.nid = -1;
            }
        }
    }
    World.prototype.processInfo = processInfo;
    if (patched) {
        module.installRendererResets();
        module.installNpcInfoSkip(World.prototype, module.NpcMirror);
    }
    return { ...module, World };
}

/** One seeded program on a stand-in (`M`): its trace. Leaves rsbuf without npcs and players. */
function program(M) {
    const { rsbuf, NpcInfoProt } = M;
    const prots = Object.values(NpcInfoProt).filter(v => typeof v === 'number');
    const world = new M.World();
    const stale = npc => {
        // read by computeNpc every tick, sent only under a mask
        npc.hitmarkDamage = ri(40);
        npc.hitmarkType = ri(3);
        npc.hitmark2Damage = ri(40);
        npc.hitmark2Type = ri(3);
        npc.levels[NpcStat.HITPOINTS] = ri(99);
        npc.baseLevels[NpcStat.HITPOINTS] = 99;
        npc.animId = ri(3) ? -1 : ri(5000);
        npc.animDelay = ri(5);
        npc.sayMessage = ri(3) ? null : `hi ${ri(50)}`;
        npc.spotanimId = ri(3) ? -1 : ri(500);
        npc.spotanimHeight = ri(100);
        npc.spotanimTime = ri(10);
    };
    const rest = npc => {
        npc.masks = 0;
        npc.walkDir = npc.runDir = -1;
        npc.tele = npc.jump = false;
        npc.faceSquareX = npc.faceSquareZ = -1;
    };
    const free = [...Array(300).keys()].sort(() => rnd() - 0.5);
    const spawned = [];
    const spawn = like => {
        const nid = free.length && ri(3) ? free.shift() : (like?.oldNid ?? free.shift());
        if (nid === undefined) return;
        const fi = free.indexOf(nid);
        if (fi >= 0) free.splice(fi, 1);
        // `like`: an npc just despawned, spawned again where it stood, as it was (npc_del + npc_add in one script)
        const x = like ? like.x : BASE_X + ri(SPREAD * 2) - SPREAD;
        const z = like ? like.z : BASE_Z + ri(SPREAD * 2) - SPREAD;
        const npc = { nid, type: like ? like.type : ri(2000), startX: x, startZ: z, x, z, level: like ? like.level : ri(8) ? 0 : 1, isActive: false, faceEntity: like ? like.faceEntity : -1, faceAngleX: like ? like.faceAngleX : -1, faceAngleZ: like ? like.faceAngleZ : -1, levels: new Array(6).fill(1), baseLevels: new Array(6).fill(1) };
        rest(npc);
        stale(npc);
        world.addNpc(npc, true);
        spawned.push(npc);
    };
    for (let i = 10 + ri(40); i > 0; i--) spawn(null);
    const observers = [...Array(1 + ri(4))].map((_, pid) => ({ pid, x: BASE_X + ri(20) - 10, z: BASE_Z + ri(20) - 10, level: 0, lastX: 0, lastZ: 0, lastLevel: -1, on: true }));
    for (const o of observers) rsbuf.addPlayer(o.pid);

    const trace = [];
    for (let tick = 0, ticks = 30 + ri(60); tick < ticks; tick++) {
        // lifecycle: despawns (their nids reused, often by an npc just like them), respawns, observers leaving/coming back
        if (ri(4) === 0 && world.npcs.length) {
            const npc = world.npcs[ri(world.npcs.length)];
            const despawn = ri(2) === 0;
            const nid = npc.nid;
            world.removeNpc(npc, despawn);
            if (npc.nid === -1) {
                free.unshift(nid);
                if (ri(2)) spawn({ ...npc, oldNid: nid });
            }
        }
        if (ri(5) === 0) {
            const inactive = world.npcs.filter(n => !n.isActive);
            if (inactive.length) world.addNpc(inactive[ri(inactive.length)], false);
        }
        if (ri(10) === 0) spawn(null);
        if (ri(25) === 0) {
            const o = observers[ri(observers.length)];
            if (o.on) rsbuf.removePlayer(o.pid);
            else rsbuf.addPlayer(o.pid);
            o.on = !o.on;
            o.lastLevel = -1;
        }
        world.players = ri(15) === 0 ? 0 : observers.filter(o => o.on).length;

        for (const npc of world.npcs) {
            stale(npc);
            rest(npc);
            if (!npc.isActive || ri(4) !== 0) continue;
            const what = ri(12);
            if (what === 0) {
                let masks = 0;
                for (const p of prots) if (ri(3) === 0) masks |= p;
                npc.masks = masks;
                if (masks & NpcInfoProt.FACE_ENTITY) npc.faceEntity = ri(2) ? -1 : ri(40000);
                if (masks & NpcInfoProt.CHANGE_TYPE) npc.type = ri(2000);
                if (masks & NpcInfoProt.SAY) npc.sayMessage = `hello ${ri(50)}`; // (the engine sets SAY with a message)
            } else if (what === 1 || what === 2) {
                npc.walkDir = ri(8);
                npc.x += ri(3) - 1;
                npc.z += ri(3) - 1;
                if (what === 2) {
                    npc.runDir = ri(8);
                    npc.x += ri(3) - 1;
                }
            } else if (what === 3) {
                npc.tele = true;
                npc.x = BASE_X + ri(SPREAD * 2) - SPREAD;
                npc.z = BASE_Z + ri(SPREAD * 2) - SPREAD;
            } else if (what === 4) {
                npc.jump = true;
                npc.x += ri(5) - 2;
            } else if (what === 5) {
                npc.faceSquareX = BASE_X + ri(30);
                npc.faceSquareZ = BASE_Z + ri(30);
                npc.masks = NpcInfoProt.FACE_COORD;
            } else if (what === 6) {
                npc.faceAngleX = ri(2) ? -1 : (BASE_X + ri(30)) * 128 + 64; // an orientation change alone, masks 0
                npc.faceAngleZ = (BASE_Z + ri(30)) * 128 + 64;
            } else if (what === 7) {
                npc.faceEntity = ri(2) ? -1 : ri(40000); // likewise
            } else if (what === 8) {
                npc.type = ri(2000);
            } else if (what === 9) {
                npc.x += ri(3) - 1; // a move without a step (a blocked step, a script's coord)
                npc.z += ri(3) - 1;
            } else if (what === 10) {
                npc.level = npc.level ? 0 : 1;
            } else {
                npc.isActive = false; // (inactive in the list: until respawn)
            }
        }

        if (world.players > 0) {
            for (const o of observers) {
                if (!o.on) continue;
                if (ri(6) === 0) {
                    o.x += ri(3) - 1;
                    o.z += ri(3) - 1;
                } else if (ri(15) === 0) {
                    o.x = BASE_X + ri(SPREAD * 2) - SPREAD;
                    o.z = BASE_Z + ri(SPREAD * 2) - SPREAD;
                }
                const ox = (o.x >> 3) * 8 - 48;
                const oz = (o.z >> 3) * 8 - 48;
                rsbuf.computePlayer(o.x, o.level, o.z, ox, oz, o.pid, false, false, -1, -1, 0, true, 0, new Uint8Array(0), 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, null, null, -1, -1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1);
            }
            world.processInfo();
            for (const o of observers) {
                if (!o.on) continue;
                const bytes = rsbuf.npcInfo(0, o.pid, Math.abs(o.lastX - o.x), Math.abs(o.lastZ - o.z), o.lastLevel !== o.level);
                o.lastX = o.x;
                o.lastZ = o.z;
                o.lastLevel = o.level;
                let h = 2166136261;
                for (const b of bytes) h = fnv(h, b);
                trace.push(`o${o.pid}:${bytes.length}:${(h >>> 0).toString(16)}`);
            }
        }
        let h = 2166136261;
        for (const npc of spawned) if (npc.nid !== -1) h = fnv(fnv(h, npc.nid), rsbuf.getNpcObservers(npc.nid));
        trace.push(`t${tick}:${(h >>> 0).toString(16)}`);
        rsbuf.cleanup();
    }
    for (const npc of [...world.npcs]) {
        npc.isActive = true;
        world.removeNpc(npc, true);
    }
    for (const o of observers) if (o.on) rsbuf.removePlayer(o.pid);
    rsbuf.cleanup();
    return trace.join(' ');
}

const runAll = M => [...Array(CASES)].map((_, c) => ((seed = 9000 + c * 7919), program(M)));
const bundle = async (name, patched, plugins = []) => stand(await importBundled(name, ENTRY, undefined, plugins), patched);

const reference = runAll(await bundle('tick-upstream', false));
const patched = runAll(await bundle('tick-patched', true));
const differ = reference.filter((t, i) => t !== patched[i]).length;
if (differ) {
    const i = reference.findIndex((t, k) => t !== patched[k]);
    const a = reference[i].split(' ');
    const b = patched[i].split(' ');
    const at = a.findIndex((x, k) => x !== b[k]);
    fail(`npc info: ${differ} of ${CASES} programs differ from upstream (case ${i}, from step ${at}: ${a.slice(at, at + 4).join(' ')} vs ${b.slice(at, at + 4).join(' ')})`);
}
const views = patched.reduce((n, t) => n + t.split(' ').filter(s => s[0] === 'o').length, 0);

const MUTANTS = {
    'no mask check': ['npc.masks === 0 &&', ''],
    'no coord check': ['npc.x === notedX[nid] &&', ''],
    'no type check': ['npc.type === notedType[nid] &&', ''],
    'no orientation check': ['npc.faceAngleX === notedFaceAngleX[nid] &&\n        npc.faceAngleZ === notedFaceAngleZ[nid]', 'true'],
    'a new mirror keeps the note': ['if (nid >= 0 && nid < NIDS) noted[nid] = 0;', 'if (nid < 0) noted[nid] = 0;'] // (addNpc and removeNpc)
};
const caught = {};
for (const [name, [from, to]] of Object.entries(MUTANTS)) {
    const traces = runAll(await bundle(`tick-mutant-${Object.keys(caught).length}`, true, [mutate(from, to)]));
    caught[name] = traces.filter((t, i) => t !== reference[i]).length;
    if (!caught[name]) fail(`npc info: the wrong patch '${name}' was not caught`);
}

// ---- lookups -----------------------------------------------------------------------------------------------------

const L = await importBundled('tick-lookups', `export { default as HuntType } from '#/cache/config/HuntType.js';\nexport { installHuntGet, packHandlers } from './runtime/lookups.js';`);
if (!/^\{\s*return HuntType\.configs\[id\];\s*\}$/.test(method(read('cache/config/HuntType.ts'), 'static get'))) fail('HuntType.get is no longer `return HuntType.configs[id]`');
const { HuntType } = L;
HuntType.configs = [...Array(7)].map((_, id) => ({ id }));
const ids = [-1000, -2, -1, ...HuntType.configs.keys(), 7, 8, 10000];
const before = ids.map(id => HuntType.get(id));
L.installHuntGet(HuntType);
const after = ids.map(id => HuntType.get(id));
if (before.some((v, i) => v !== after[i])) fail(`HuntType.get differs at ids ${ids.filter((_, i) => before[i] !== after[i]).join(', ')}`);

const handlerReads = sources.flatMap(([file, text]) => [...text.matchAll(/\bHANDLERS\b(.{0,9})/g)].map(m => `${file}:${m[1]}`));
if (handlerReads.join('|') !== 'engine/script/ScriptRunner.ts:: Command|engine/script/ScriptRunner.ts:[opcode];') fail(`ScriptRunner.HANDLERS is used elsewhere or otherwise: ${handlerReads.join(', ')}`);
let handlerCases = 0;
for (let c = 0; c < 200; c++) {
    seed = 77 + c;
    // like upstream's: an object spread from several tables of opcode -> handler
    const parts = [...Array(1 + ri(16))].map(() => Object.fromEntries([...Array(ri(40))].map(() => [ri(2) ? ri(300) : ri(10004), () => c])));
    const table = Object.assign({}, ...parts);
    const Runner = { HANDLERS: table };
    L.packHandlers(Runner);
    const keys = Object.keys(table).map(Number);
    if (!keys.length) {
        if (Runner.HANDLERS !== table) fail('packHandlers replaced an empty table');
        continue;
    }
    const last = Math.max(...keys);
    const h = Runner.HANDLERS;
    if (!Array.isArray(h) || h.length !== last + 1 || Object.keys(h).length !== last + 1) fail(`HANDLERS case ${c}: not a packed array of ${last + 1}`);
    for (let op = -1; op <= last + 3; op++) if (h[op] !== table[op]) fail(`HANDLERS case ${c}: opcode ${op} differs`);
    const added = () => 'bot';
    h[10100] = added; // the bots glue (runtime/bots/scripts.ts)
    if (h[10100] !== added || h[10099] !== table[10099]) fail(`HANDLERS case ${c}: a later assignment does not read back`);
    handlerCases++;
}
for (const odd of [{ 1: 1, name: 2 }, { 1: 1, '-1': 2 }, { 1: 1, 1.5: 2 }, { 1: 1, 70000: 2 }, { 1: 1, [Symbol('x')]: 2 }]) {
    const Runner = { HANDLERS: odd };
    L.packHandlers(Runner);
    if (Runner.HANDLERS !== odd) fail(`packHandlers replaced a table with keys ${Object.keys(odd).join(', ')}`);
}

if (failures.length) {
    for (const f of failures) console.log(f);
    console.log(`tick: FAIL - ${failures.length} problem(s)`);
    process.exit(1);
}
console.log(
    `tick: PASS - npc info: ${CASES} programs (${views} npcInfo views) identical to upstream's loop, wrong patches caught: ${Object.entries(caught)
        .map(([k, n]) => `${k} (${n})`)
        .join(', ')}; upstream's shapes as relied on; HuntType.get same for ${ids.length} ids; HANDLERS packed same in ${handlerCases} tables, 5 odd ones left alone`
);
