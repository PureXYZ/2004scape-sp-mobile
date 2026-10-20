// Builds data/walk_graph.json, the walking graph long bot walks follow (port/BotWalkGraph.ts). Run it again only when
// the map changes (another revision): node web/engine/bots/test/walk-graph-build.mjs [--check]
//   --check  builds it and compares with the committed file (exit 1 if they differ)
//
// The overworld (level 0, x 2048-3455, z 2496-3967) in cells of 16×16 tiles. In each cell, one node: the walkable
// tile with the most walkable neighbours (3×3, at least 7), nearest the cell's middle. Between two nodes up to two
// cells apart, an edge where 274's own path search (rsmod, as the server walks a player: doors and gates as the map
// has them, closed) walks from one to the other in at most 1.5× their distance + 6 tiles; its cost is that walk's
// length. The search does not see NPCs that block players (BlockWalk.ALL: Draynor Manor's nasty trees, which never
// move), but a player's step does: no node stands on one's tile, and no edge walks across one. Nodes with no edge
// are dropped. Gates, the toll gate, boats, ladders and stairs are not edges: BotAction's
// gateways cross those, so the graph falls apart into the regions between them (the mainland from Falador to Al
// Kharid and the Wilderness; Kandarin with Taverley; Karamja; ...).
//
// Encoding (base64, big endian), node order = cell order (z major):
//   nodes  per node: u16 cell index (gz * w + gx), u8 tile in the cell ((dx << 4) | dz)
//   edges  per node: u8 count, then per edge to a node later in cell order: u8 cell step ((dz * 5) + dx + 2: dz 0-2,
//          dx -2..2, dx > 0 when dz = 0), u8 cost
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const CHECK = process.argv.includes('--check');
const OUT = path.join(BOTS_DIR, 'data/walk_graph.json');
const G = 16;
const X0 = 2048;
const Z0 = 2496;
const X1 = 3456;
const Z1 = 3968;
const W = (X1 - X0) / G;
const H = (Z1 - Z0) / G;
const MIN_OPEN = 7;
const REACH = 2;

for (const l of ['log', 'info', 'debug', 'warn']) console[l] = () => {};
const engineDir = prepareEngineClone('walk-graph', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/simworld.ts'), path.join(engineDir, 'tsconfig.json'));
await lib.World.start(false, false);
// (an NPC that blocks players marks its tile BLOCK_NPC_AND_PLAYERS: routefinder flags.ts)
const BLOCK_NPC_AND_PLAYERS = 0x100000;
const npcBlocks = (x, z) => lib.routefinder.collisionFlags.isFlagged(x, z, 0, BLOCK_NPC_AND_PLAYERS);
const walkable = (x, z) => lib.Sim.prototype.isWalkable.call(null, x, z, 0) && !npcBlocks(x, z);
const t0 = performance.now();

// ---- nodes ----
const cellNode = new Int32Array(W * H).fill(-1);
const nodes = []; // [cell, x, z]
for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
        const cx = X0 + gx * G + G / 2;
        const cz = Z0 + gz * G + G / 2;
        let best = null;
        let bestScore = -1;
        for (let z = Z0 + gz * G; z < Z0 + gz * G + G; z++) {
            for (let x = X0 + gx * G; x < X0 + gx * G + G; x++) {
                if (!walkable(x, z)) continue;
                let open = 0;
                for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (walkable(x + dx, z + dz)) open++;
                const score = open * 1000 - (Math.abs(x - cx) + Math.abs(z - cz));
                if (score > bestScore) {
                    bestScore = score;
                    best = [x, z];
                }
            }
        }
        if (best && bestScore >= MIN_OPEN * 1000 - G) {
            cellNode[gz * W + gx] = nodes.length;
            nodes.push([gz * W + gx, best[0], best[1]]);
        }
    }
}

// ---- edges: forward only (to a later cell), as stored ----
const forward = nodes.map(() => []);
let searches = 0;
for (let i = 0; i < nodes.length; i++) {
    const [cell, ax, az] = nodes[i];
    const gx = cell % W;
    const gz = Math.floor(cell / W);
    for (let dz = 0; dz <= REACH; dz++) {
        for (let dx = -REACH; dx <= REACH; dx++) {
            if (dz === 0 && dx <= 0) continue;
            const bx = gx + dx;
            const bz = gz + dz;
            if (bx < 0 || bx >= W || bz >= H) continue;
            const j = cellNode[bz * W + bx];
            if (j < 0) continue;
            const [, tx, tz] = nodes[j];
            searches++;
            const route = lib.routefinder.findPath(0, ax, az, tx, tz, 1, 1, 1, 0, -1, false, 0, 25, 0);
            if (route.length === 0) continue;
            let len = 0;
            let blocked = false;
            let [px, pz] = [ax, az];
            for (const packed of route) {
                const wx = (packed >> 14) & 0x3fff;
                const wz = packed & 0x3fff;
                len += Math.max(Math.abs(wx - px), Math.abs(wz - pz));
                // tile by tile: one an NPC blocks stops a player's walk there
                while (px !== wx || pz !== wz) {
                    px += Math.sign(wx - px);
                    pz += Math.sign(wz - pz);
                    if (npcBlocks(px, pz)) blocked = true;
                }
            }
            if (blocked || px !== tx || pz !== tz) continue;
            if (len > 1.5 * Math.max(Math.abs(tx - ax), Math.abs(tz - az)) + 6) continue;
            forward[i].push([dz * 5 + dx + 2, len]);
        }
    }
}

// ---- drop nodes with no edge (either way), re-index ----
const degree = new Int32Array(nodes.length);
for (let i = 0; i < nodes.length; i++) {
    const [cell] = nodes[i];
    for (const [step] of forward[i]) {
        const j = cellNode[cell + Math.floor(step / 5) * W + (step % 5) - 2];
        degree[i]++;
        degree[j]++;
    }
}
const kept = nodes.map((_, i) => degree[i] > 0);

// ---- encode ----
const nodeBytes = [];
const edgeBytes = [];
let edges = 0;
for (let i = 0; i < nodes.length; i++) {
    if (!kept[i]) continue;
    const [cell, x, z] = nodes[i];
    const gx = cell % W;
    const gz = Math.floor(cell / W);
    nodeBytes.push(cell >> 8, cell & 0xff, ((x - (X0 + gx * G)) << 4) | (z - (Z0 + gz * G)));
    // (an edge always joins two kept nodes: both ends have a degree)
    edgeBytes.push(forward[i].length);
    for (const [step, cost] of forward[i]) {
        edgeBytes.push(step, cost);
        edges++;
    }
}
const nodeCount = nodeBytes.length / 3;
const graph = {
    v: 1,
    about: 'the walking graph of the rev-274 overworld for long bot walks: made by test/walk-graph-build.mjs (see there), read by src/port/BotWalkGraph.ts',
    grid: G,
    x0: X0,
    z0: Z0,
    w: W,
    h: H,
    nodeCount,
    edgeCount: edges,
    nodes: Buffer.from(nodeBytes).toString('base64'),
    edges: Buffer.from(edgeBytes).toString('base64')
};
const text = JSON.stringify(graph, null, 1) + '\n';
const ms = Math.round(performance.now() - t0);
process.stdout.write(`walk graph: ${nodeCount} nodes, ${edges} edges (${searches} path searches, ${ms} ms), ${text.length} bytes\n`);
if (CHECK) {
    const same = fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === text;
    process.stdout.write(same ? 'the committed walk_graph.json is up to date\n' : 'walk_graph.json differs from the map: run test/walk-graph-build.mjs\n');
    process.exit(same ? 0 : 1);
}
fs.writeFileSync(OUT, text);
process.stdout.write(`wrote ${path.relative(process.cwd(), OUT)}\n`);
process.exit(0);
