// port: the walking graph for long bot walks (by design, after Phase 2: fix the routing). The engine's path
// search covers 128×128 tiles around a player, so upstream (and the port until now) walked far by aiming at a point
// up to 60 tiles along the straight line and searching to it: a wall, a fence or a river across that line left the
// bot pressed against it until a stuck detector jumped it on (Falador's walls, the farms south of Falador and west of
// Lumbridge, Karamja's jungle: most of the rescue jumps left in the 50-bot sims). This graph is the overworld's roads
// as 274's own path search walks them (data/walk_graph.json, made by test/walk-graph-build.mjs: a node every 16 tiles,
// an edge where a player walks from one to the next in at most 1.5× their distance + 6 tiles, doors and gates closed).
// A long walk follows it node to node, each leg well inside the search's reach; gates, boats, ladders and stairs stay
// BotAction's gateways (the graph has no edge through them).
import graphJson from '../../data/walk_graph.json';

interface Graph {
    grid: number;
    x0: number;
    z0: number;
    w: number;
    h: number;
    nodeX: Int32Array;
    nodeZ: Int32Array;
    /** the node of each cell, or -1 */
    cellNode: Int32Array;
    /** CSR adjacency, both ways */
    adjStart: Int32Array;
    adjNode: Int32Array;
    adjCost: Int32Array;
    /** port: the connected component of each node (the graph's regions between gateways) */
    comp: Int32Array;
}

let graph: Graph | null = null;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 to bytes (no atob: the engine runs where it may be missing) */
function decode64(s: string): Uint8Array {
    const clean = s.replace(/=+$/, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let bits = 0;
    let value = 0;
    let o = 0;
    for (let i = 0; i < clean.length; i++) {
        value = (value << 6) | B64.indexOf(clean[i]);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (value >> bits) & 0xff;
        }
    }
    return out;
}

function load(): Graph {
    if (graph) return graph;
    const { grid, x0, z0, w, h } = graphJson;
    const nb = decode64(graphJson.nodes);
    const eb = decode64(graphJson.edges);
    const n = nb.length / 3;
    const nodeX = new Int32Array(n);
    const nodeZ = new Int32Array(n);
    const cellOf = new Int32Array(n);
    const cellNode = new Int32Array(w * h).fill(-1);
    for (let i = 0; i < n; i++) {
        const cell = (nb[i * 3] << 8) | nb[i * 3 + 1];
        const off = nb[i * 3 + 2];
        nodeX[i] = x0 + (cell % w) * grid + (off >> 4);
        nodeZ[i] = z0 + Math.floor(cell / w) * grid + (off & 15);
        cellOf[i] = cell;
        cellNode[cell] = i;
    }
    const from: number[] = [];
    const to: number[] = [];
    const cost: number[] = [];
    let p = 0;
    for (let i = 0; i < n; i++) {
        const count = eb[p++];
        for (let k = 0; k < count; k++) {
            const step = eb[p++];
            const c = eb[p++];
            const j = cellNode[cellOf[i] + Math.floor(step / 5) * w + (step % 5) - 2];
            if (j < 0) continue;
            from.push(i, j);
            to.push(j, i);
            cost.push(c, c);
        }
    }
    const adjStart = new Int32Array(n + 1);
    for (const f of from) adjStart[f + 1]++;
    for (let i = 0; i < n; i++) adjStart[i + 1] += adjStart[i];
    const fill = adjStart.slice(0, n);
    const adjNode = new Int32Array(from.length);
    const adjCost = new Int32Array(from.length);
    for (let e = 0; e < from.length; e++) {
        const at = fill[from[e]]++;
        adjNode[at] = to[e];
        adjCost[at] = cost[e];
    }
    const comp = new Int32Array(n).fill(-1);
    for (let i = 0, c = 0; i < n; i++, c++) {
        if (comp[i] >= 0) { c--; continue; }
        const stack = [i];
        comp[i] = c;
        while (stack.length > 0) {
            const u = stack.pop()!;
            for (let e = adjStart[u]; e < adjStart[u + 1]; e++) if (comp[adjNode[e]] < 0) { comp[adjNode[e]] = c; stack.push(adjNode[e]); }
        }
    }
    graph = { grid, x0, z0, w, h, nodeX, nodeZ, cellNode, adjStart, adjNode, adjCost, comp };
    return graph;
}

export function nodeCount(): number {
    return load().nodeX.length;
}

/** port: the node's component (nodes of one component are joined by the graph) */
export function componentOf(i: number): number {
    return i < 0 ? -1 : load().comp[i];
}

/** port: the node standing on (x, z), or -1 */
export function nodeAt(x: number, z: number): number {
    const g = load();
    const gx = Math.floor((x - g.x0) / g.grid);
    const gz = Math.floor((z - g.z0) / g.grid);
    if (gx < 0 || gz < 0 || gx >= g.w || gz >= g.h) return -1;
    const i = g.cellNode[gz * g.w + gx];
    return i >= 0 && g.nodeX[i] === x && g.nodeZ[i] === z ? i : -1;
}

export function nodePos(i: number): [number, number] {
    const g = load();
    return [g.nodeX[i], g.nodeZ[i]];
}

/** The node's neighbours and their costs (for the tests). */
export function neighbours(i: number): [number, number][] {
    const g = load();
    const out: [number, number][] = [];
    for (let e = g.adjStart[i]; e < g.adjStart[i + 1]; e++) out.push([g.adjNode[e], g.adjCost[e]]);
    return out;
}

/** May the route use this tile? (a free world: not a members area) */
export type Allowed = (x: number, z: number) => boolean;

/**
 * The `count` nodes nearest (x, z) on the overworld (Chebyshev, then Manhattan; within two cells; ones the route may
 * use), nearest first. Level 0 only: the graph has no upstairs and no dungeons.
 */
const nearScores = new Float64Array(25);
const nearIds = new Int32Array(25);
export function nearestNodes(x: number, z: number, count: number, allowed?: Allowed): number[] {
    const g = load();
    const gx = Math.floor((x - g.x0) / g.grid);
    const gz = Math.floor((z - g.z0) / g.grid);
    // port (perf, 2026-10-23): the candidates (at most 25, one a cell) kept in the sort's order as they come (scores,
    // then node numbers), in two reused arrays: no pair array per candidate, no sort, slice and map per call
    let n = 0;
    const scores = nearScores;
    const ids = nearIds;
    for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
            const cx = gx + dx;
            const cz = gz + dz;
            if (cx < 0 || cz < 0 || cx >= g.w || cz >= g.h) continue;
            const i = g.cellNode[cz * g.w + cx];
            if (i < 0 || (allowed && !allowed(g.nodeX[i], g.nodeZ[i]))) continue;
            const score = Math.max(Math.abs(g.nodeX[i] - x), Math.abs(g.nodeZ[i] - z)) * 4 + Math.abs(g.nodeX[i] - x) + Math.abs(g.nodeZ[i] - z);
            let k = n++;
            while (k > 0 && (scores[k - 1] > score || (scores[k - 1] === score && ids[k - 1] > i))) {
                scores[k] = scores[k - 1];
                ids[k] = ids[k - 1];
                k--;
            }
            scores[k] = score;
            ids[k] = i;
        }
    }
    const out: number[] = [];
    for (let k = 0; k < n && k < count; k++) out.push(ids[k]);
    return out;
}

/** The node nearest (x, z) (nearestNodes), or -1. */
export function nearestNode(x: number, z: number, allowed?: Allowed): number {
    return nearestNodes(x, z, 1, allowed)[0] ?? -1;
}

/** A route's length: the sum of its edges' costs (the walk along it, in tiles). */
export function routeCost(nodes: readonly number[]): number {
    const g = load();
    let total = 0;
    for (let k = 1; k < nodes.length; k++) {
        const a = nodes[k - 1];
        const b = nodes[k];
        for (let e = g.adjStart[a]; e < g.adjStart[a + 1]; e++) {
            if (g.adjNode[e] === b) {
                total += g.adjCost[e];
                break;
            }
        }
    }
    return total;
}

/** the Wilderness on the overworld (BotWorldRules has the levels; this is only for the route's cost) */
function inWilderness(x: number, z: number): boolean {
    return z >= 3520 && z < 4000 && x >= 2944 && x < 3392;
}
/** a step through the Wilderness costs this much more, unless the walk is to it (bots walk round it, as players did) */
const WILDERNESS_COST = 4;

const cache = new Map<string, number[] | null>();
// route's arrays, kept between searches; a node's entries are the current search's only when its stamp is
let aDist = new Float64Array(0);
let aPrev = new Int32Array(0);
let aStamp = new Int32Array(0);
let aDone = new Int32Array(0);
let aGen = 0;
// ---- (bots ideas, round 3: H move) route variants: three routes cached per trip
// (variant 0, today's, and 1 and 2), so the cache holds three times as many: about 100 KB ----
const CACHE_SIZE = 1536;
/** a variant's edge costs: each edge's × (1 + VARIANT_NOISE × h), h a hash in [0, 1) of the edge's two nodes and the variant */
export const VARIANT_NOISE = 0.4;
/** the edge's hash for variant `v` (1 or 2): the same both ways along the edge (a trip back takes the same variant's way) */
export function variantHash(a: number, b: number, v: number): number {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    let h = Math.imul(lo + 1, 0x9e3779b1) ^ Math.imul(hi + 1, 0x85ebca77) ^ Math.imul(v, 0xc2b2ae3d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}
// ---- end of H move's variants ----

/**
 * The nodes from `start` to `goal`, both included (A*, Chebyshev), or null when the graph does not join them (another
 * region: a gateway lies between). Cached (the same trips repeat: a bank and a spot). (Bots ideas, round 1's left-overs:
 * `stepCost`, a factor of at least 1 on each step from a node to the next, port/BotDanger.fearCost; `allowedKey` names it
 * too. Bots ideas, round 3, theme H: `variant` 1 or 2, a route variant, each edge's cost noised by variantHash; 0, the
 * default, today's route.)
 */
export function route(start: number, goal: number, allowed?: Allowed, allowedKey = '', stepCost?: (from: number, to: number) => number, variant = 0): number[] | null {
    const g = load();
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [start];
    // (bots ideas, round 3: H move) a variant's own entry (variant 0's key as before)
    const key = `${start}>${goal}>${allowedKey}${variant ? `#${variant}` : ''}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
    }
    const tx = g.nodeX[goal];
    const tz = g.nodeZ[goal];
    const toWild = inWilderness(tx, tz);
    const n = g.nodeX.length;
    // port (perf, 2026-10-23): the search's arrays are kept between searches and told apart by a stamp (a node's dist,
    // prev and done are this search's only when its stamp is), and the heap swaps through temporaries: the same A*, the
    // same heap order, the same route, without 3 arrays of n nodes allocated and filled per search (A* was 2.5 % of the
    // world tick at 1000 bots in JavaScriptCore, its arrays 6 % of the bots' garbage)
    if (aStamp.length !== n || aGen === 0x7fffffff) {
        aDist = new Float64Array(n);
        aPrev = new Int32Array(n);
        aStamp = new Int32Array(n);
        aDone = new Int32Array(n);
        aGen = 0;
    }
    const gen = ++aGen;
    const dist = aDist;
    const prev = aPrev;
    const stamp = aStamp;
    const done = aDone;
    // a binary heap of [f, node]
    const heapF: number[] = [];
    const heapN: number[] = [];
    const push = (f: number, node: number): void => {
        let i = heapF.length;
        heapF.push(f);
        heapN.push(node);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heapF[parent] <= heapF[i]) break;
            const tf = heapF[parent];
            heapF[parent] = heapF[i];
            heapF[i] = tf;
            const tn = heapN[parent];
            heapN[parent] = heapN[i];
            heapN[i] = tn;
            i = parent;
        }
    };
    const pop = (): number => {
        const top = heapN[0];
        const lastF = heapF.pop()!;
        const lastN = heapN.pop()!;
        if (heapF.length > 0) {
            heapF[0] = lastF;
            heapN[0] = lastN;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let m = i;
                if (l < heapF.length && heapF[l] < heapF[m]) m = l;
                if (r < heapF.length && heapF[r] < heapF[m]) m = r;
                if (m === i) break;
                const tf = heapF[m];
                heapF[m] = heapF[i];
                heapF[i] = tf;
                const tn = heapN[m];
                heapN[m] = heapN[i];
                heapN[i] = tn;
                i = m;
            }
        }
        return top;
    };
    const h = (i: number): number => Math.max(Math.abs(g.nodeX[i] - tx), Math.abs(g.nodeZ[i] - tz));
    // dist[] is Infinity and prev[] -1 for a node this search has not reached (stamp !== gen)
    stamp[start] = gen;
    dist[start] = 0;
    prev[start] = -1;
    push(h(start), start);
    while (heapF.length > 0) {
        const u = pop();
        if (done[u] === gen) continue;
        done[u] = gen;
        if (u === goal) break;
        for (let e = g.adjStart[u]; e < g.adjStart[u + 1]; e++) {
            const v = g.adjNode[e];
            if (done[v] === gen) continue;
            const vx = g.nodeX[v];
            const vz = g.nodeZ[v];
            if (v !== goal && allowed && !allowed(vx, vz)) continue;
            let c = g.adjCost[e] * (!toWild && inWilderness(vx, vz) ? WILDERNESS_COST : 1) * (stepCost ? stepCost(u, v) : 1);
            // ---- (bots ideas, round 3: H move) a route variant's noise: costs only grow, so the heuristic stays admissible ----
            if (variant) c *= 1 + VARIANT_NOISE * variantHash(u, v, variant);
            // ---- end of H move's noise ----
            const nd = dist[u] + c;
            if (nd < (stamp[v] === gen ? dist[v] : Infinity)) {
                stamp[v] = gen;
                dist[v] = nd;
                prev[v] = u;
                push(nd + h(v), v);
            }
        }
    }
    let result: number[] | null = null;
    if (stamp[goal] === gen && dist[goal] < Infinity) {
        result = [goal];
        while (result[result.length - 1] !== start) result.push(prev[result[result.length - 1]]);
        result.reverse();
    }
    cache.set(key, result);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return result;
}
