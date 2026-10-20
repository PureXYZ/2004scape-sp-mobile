#!/usr/bin/env node
// Groups on the move (the realism work, phase 5b, Track D: port/BotClanWalk, port/BotPkTeam, port/BotTrains,
// port/BotFollow's chain; "PK teams, clan walks in matching capes, newbie follow trains", and at 5b's go-ahead
// "red capes from Thessalia for saved bots, new bots their clique's colour", "PK teams pile onto the human in multi-combat:
// yes, no warning needed"):
//   map        every clan hub on the walking graph; every leg joined with no gateway and out of the Wilderness, 40-260
//              tiles; a walk from each hub of 2-4 legs (a free world's never through a members hub); the PK raid's patrol
//              points multi-combat in the Wilderness at levels 3-7, its meeting short of it, the Edgeville edge single-combat
//   clan walk  the real 274 world, 60 bots: a clique of 4 with no cape near Varrock: a red walk (Thessalia's), each buys its
//              red cape there (4-ish gp, the shop's window) and puts it on; they gather at the hub (the leader's call), walk
//              its legs in a line (each follows the one ahead with the game's Follow, the leader walking, never running),
//              stop at each hub on tiles of their own, and end there (every one wearing the cape: G3); then no part, their own
//              tasks; the human's "can i join ur clan?" gets the leader's answer, no other bot's; a clique whose members wear
//              their own colour walks in it, buying nothing
//   PK raid    3 Edgeville PKers of a clique: they bank, meet north of Edgeville (the leader's call), walk east into the
//              Varrock Wilderness and patrol there; the human there (its combat theirs) is piled on: 2-3 of the team at once,
//              never more, each where the human stands in multi-combat; no two bots on one target in a single-combat zone;
//              two members beaten (under 40 % with no food) and the team goes home
//   trains     a newbie in Lumbridge asks a passer-by "can i follow u?", follows it once it says yes (the game's Follow), a
//              second newbie joins behind the first (behind the last: since the variety work, any low-level may join); it ends (the leader still, far, or its time) and they are newbies at
//              their own tasks again, no part; the human asked: "sure" and the newbie follows it, "stop following me" ends it
//   errors     none
//
//   node --expose-gc web/engine/bots/test/groups.test.mjs [--seed=5]
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { scene } from './lib/dice.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const SEED = Number(args.seed ?? 5);
const N = 60;
const out = (s = '') => process.stdout.write(s + '\n');
function mulberry(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
Math.random = mulberry(SEED);

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const logErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    console[level] = (...a) => {
        if (level !== 'error') return;
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (!text.includes('ExperimentalWarning')) logErrors.push(text.slice(0, 300));
    };
}
const engineDir = prepareEngineClone('groups', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/groups.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, SetPieces, Director: D, ClanWalk, PkTeam, Trains, Cliques, WalkGraph } = lib;
// (the variety work, round 2, the integrator's: the round's errands off for these scenes: a clan's member or a newbie on
// a quest look-alike or a chain is held in a sub-task, which no clan walk, raid or train asks; at seed 5 no walk formed)
await lib.setD2Offers?.(false);

// ---- 1. the map ----
{
    const far = ClanWalk.CLAN_HUBS.filter(h => {
        const n = WalkGraph.nearestNode(h.x, h.z);
        return n < 0 || cheb({ x: h.x, z: h.z }, { x: WalkGraph.nodePos(n)[0], z: WalkGraph.nodePos(n)[1] }) > 12;
    });
    check('every clan hub stands on the walking graph (a node within 12 tiles)', far.length === 0, far.map(h => h.key).join(', '));
    const byKey = new Map(ClanWalk.CLAN_HUBS.map(h => [h.key, h]));
    const bad = [];
    for (const [a, b] of ClanWalk.CLAN_LEGS) {
        const ha = byKey.get(a);
        const hb = byKey.get(b);
        if (!ha || !hb) {
            bad.push(`${a}-${b}: no hub`);
            continue;
        }
        const tiles = ClanWalk.clanLegTiles(ha, hb);
        const nodes = WalkGraph.route(WalkGraph.nearestNode(ha.x, ha.z), WalkGraph.nearestNode(hb.x, hb.z));
        const wild = (nodes ?? []).some(i => lib.wildLevel(...WalkGraph.nodePos(i)) > 0);
        if (!Number.isFinite(tiles) || tiles < 40 || tiles > 260 || wild || (!!ha.members !== !!hb.members && !(ha.members && hb.members))) bad.push(`${a}-${b}: ${tiles}${wild ? ' wild' : ''}`);
    }
    check('every leg: the walking graph joins it (no gateway), 40-260 tiles, out of the Wilderness, members hubs only to members hubs', bad.length === 0, bad.join(', '));
    const dice = Math.random;
    const noRoute = ClanWalk.CLAN_HUBS.filter(h => !ClanWalk.clanRoute(h, true, dice));
    check('a walk of 2-4 legs from (nearly) every hub', noRoute.length <= 2, noRoute.map(h => h.key).join(', '));
    let membersOnFree = 0;
    for (const h of ClanWalk.CLAN_HUBS.filter(x => !x.members)) for (let i = 0; i < 5; i++) for (const s of ClanWalk.clanRoute(h, false, dice) ?? []) if (s.members) membersOnFree++;
    check("a free world's walks never pass a members hub", membersOnFree === 0, `${membersOnFree}`);
}

// ---- the world ----
const saves = new Map();
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, saves, ackLogouts: true, extra: { savedNames: () => [...saves.keys()] } });
sim.addHuman(3165, 3480, 0);
// (no random event on a bot either, as chat.test and duel.test: the variety work's round 1 drew a fail teleport that
// took the train's newbie to Camelot mid-follow, and the train was lost)
lib.setEventRatesForTest?.({ odds: 0 });
// (no random event on the human: one took it across the map, as in the other tests)
{
    const clientsIn = World.processClientsIn;
    World.processClientsIn = function () {
        clientsIn.call(this);
        sim.human.afkEventReady = false;
    };
}
const human = sim.human;
const lines = [];
lib.sayListeners.push((p, text, kind, to) => lines.push({ t: World.currentTick, name: p.username, text, kind, to: to?.username ?? null, x: p.x, z: p.z }));
const run = (ticks, each) => {
    for (let i = 0; i < ticks; i++) {
        sim.tick();
        if (each && each(World.currentTick) === true) return i + 1;
    }
    return -1;
};
run(400, () => sim.bots().length >= N);
run(100);
check(`${N} bots in the world`, sim.bots().length >= N - 2, sim.bots().length);
// (the map's multi-combat zones, once the world loaded them: content/maps/multiway.csv)
{
    const points = PkTeam.PATROL_POINTS.map(([x, z]) => ({ x, z, multi: lib.isMultiCombat(x, z, 0), wild: lib.wildLevel(x, z), node: WalkGraph.nearestNode(x, z) }));
    check("the raid's patrol points: multi-combat, the Wilderness's levels 3-7, on the walking graph", points.every(p => p.multi && p.wild >= 3 && p.wild <= 7 && p.node >= 0), points.filter(p => !p.multi || p.wild < 3 || p.wild > 7 || p.node < 0));
    check("the team meets short of the Wilderness; the Edgeville edge is single-combat (no pile there)", lib.wildLevel(...PkTeam.EDGE_MEET) === 0 && !lib.isMultiCombat(3093, 3540, 0) && lib.isMultiCombat(3176, 3544, 0));
}
const taskOf = p => sim.botPlayer(p)?.currentTask ?? null;
const subOf = p => sim.botPlayer(p)?.subTask ?? null;
const levelling = p => ['skiller', 'fighter', 'balanced', 'random'].includes(p.botPlanner);
const used = new Set();
const take = pred => {
    const p = sim.bots().find(b => !used.has(b) && pred(b));
    if (p) used.add(p);
    return p;
};
/** a walkable tile within r of (x, z) not stood on */
function tileNear(x, z, r = 4) {
    for (let d = 0; d <= r; d++) for (let dx = -d; dx <= d; dx++) for (let dz = -d; dz <= d; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d || !sim.isWalkable(x + dx, z + dz, 0)) continue;
        if (sim.bots().some(b => b.x === x + dx && b.z === z + dz) || (human.x === x + dx && human.z === z + dz)) continue;
        return [x + dx, z + dz];
    }
    return [x, z];
}
function capesOff(p) {
    const W = lib.wardrobeItems();
    const all = [...W.capes, W.legendsCape];
    const worn = p.getInventory(lib.InvType.WORN);
    if (worn?.get(1)) worn.delete(1);
    for (const inv of [p.getInventory(lib.InvType.INV), p.getInventory(lib.bankInvId())]) {
        if (!inv) continue;
        for (let s = 0; s < inv.capacity; s++) if (inv.get(s) && all.includes(inv.get(s).id)) inv.delete(s);
    }
}
function coinsOf(p) {
    let n = 0;
    for (const inv of [p.getInventory(lib.InvType.INV), p.getInventory(lib.bankInvId())]) {
        if (!inv) continue;
        for (let s = 0; s < inv.capacity; s++) if (inv.get(s)?.id === 995) n += inv.get(s).count;
    }
    return n;
}
const isFollowing = (p, t) => p.target === t && (p.targetOp === lib.ServerTriggerType.APPLAYER3 || p.targetOp === lib.ServerTriggerType.OPPLAYER3);
const attacking = p => (p.target && p.target.username !== undefined && (p.targetOp === lib.ServerTriggerType.APPLAYER2 || p.targetOp === lib.ServerTriggerType.OPPLAYER2) ? p.target : null);

// ---- 2. a clan walk, saved bots: red capes from Thessalia's ----
{
    scene(SEED, 'clan walk saved'); // (its own dice: test/lib/dice.mjs)
    const clan = [];
    for (let i = 0; i < 4; i++) {
        const p = take(b => levelling(b) && !lib.isNewbie(b) && b.combatLevel >= 15 && !sim.botPlayer(b)?.hasSubTask());
        if (p) clan.push(p);
    }
    Cliques.setCliquesForTest([clan.map(p => p.username)]);
    const coins = new Map();
    for (const p of clan) {
        capesOff(p);
        lib.giveItems(p, [[995, 60]], false);
        coins.set(p.username, coinsOf(p));
        const [x, z] = tileNear(3205 + clan.indexOf(p) * 3, 3424);
        p.clearWaypoints();
        p.teleJump(x, z, 0);
    }
    run(2);
    D.resetDirectorForTest();
    D.setDirectorForTest({ first: 5, firstKinds: ['clan_walk'], kinds: ['clan_walk'] });
    let walk = null;
    const seen = { phases: new Set(), followTicks: 0, memberWalkTicks: 0, chainOk: 0, chainTicks: 0, leaderRuns: 0, leaderSteps: 0, stopTicks: 0, stopStacked: 0, stopFollowing: 0, gathered: false, capesAtPeak: null, legsReached: 0, joinAsked: false };
    let last = null;
    let joinAt = -1;
    run(6000, tick => {
        const runs = SetPieces.runningSetPieces();
        const r = runs.find(x => x.kind === 'clan_walk') ?? null;
        if (r && !walk) walk = r;
        if (!walk) return false;
        seen.phases.add(walk.phase);
        if (walk.phase === 'build' && walk.line.every(m => cheb(m, walk.route[0]) <= 8)) seen.gathered = true;
        if (walk.phase === 'peak' && !seen.capesAtPeak) seen.capesAtPeak = [walk.leader, ...walk.line].map(p => p.getInventory(lib.InvType.WORN)?.get(1)?.id === walk.capeId);
        seen.legsReached = Math.max(seen.legsReached, walk.leg);
        if (walk.walking) {
            const lp = [walk.leader.x, walk.leader.z];
            if (last) {
                const d = Math.max(Math.abs(lp[0] - last[0]), Math.abs(lp[1] - last[1]));
                if (d > 0) seen.leaderSteps++;
                if (d === 2) seen.leaderRuns++;
            }
            last = lp;
            for (const m of walk.line) {
                seen.memberWalkTicks++;
                const ahead = walk.aheadOf(m);
                if (isFollowing(m, ahead) || cheb(m, ahead) <= 3) seen.followTicks++;
                if (walk.line.indexOf(m) > 0) {
                    seen.chainTicks++;
                    if (!isFollowing(m, walk.leader)) seen.chainOk++;
                }
            }
            // (the human asks to join, once, beside the leader)
            if (!seen.joinAsked && walk.leg >= 2) {
                seen.joinAsked = true;
                const [x, z] = tileNear(walk.leader.x + 2, walk.leader.z);
                sim.teleportHuman(x, z, 0);
                joinAt = tick;
                lib.BotChat.onPublicMessage(human, 'can i join ur clan?');
            }
        } else last = null;
        if (walk.phase === 'peak' && walk.stopUntil >= 0 && tick < walk.stopUntil - 40 && tick > walk.stopUntil - 100) {
            seen.stopTicks++;
            const tiles = new Set();
            for (const m of [walk.leader, ...walk.line]) {
                const k = `${m.x},${m.z}`;
                if (tiles.has(k)) seen.stopStacked++;
                tiles.add(k);
                if (walk.line.includes(m) && isFollowing(m, walk.aheadOf(m))) seen.stopFollowing++;
            }
        }
        return walk.phase === 'done';
    });
    run(60);
    const rec = D.directorLog.find(e => e.kind === 'clan_walk');
    check('a clan walk of the clique starts (forced early: the runner\'s --director-first) and ends at its last hub', !!walk && walk.outcome === 'done' && seen.legsReached >= walk.route.length - 1, walk ? `${walk.route.map(h => h.key).join(' > ')}; outcome ${walk.outcome}; ${walk.line.length + 1} walkers; phases ${[...seen.phases].join(' ')}` : `none; ${D.directorLog.length} events`);
    const walkers = walk ? clan.filter(p => rec?.recruits.some(r => r.name === p.username && r.left === null)) : [];
    check('saved bots: a red walk (Thessalia\'s): each walker bought its red cape there (a few coins) and wore it on the walk (G3)', !!walk && walk.colour === 0 && walkers.length >= 3 && !!seen.capesAtPeak && seen.capesAtPeak.every(Boolean) && walkers.every(p => coins.get(p.username) - coinsOf(p) >= 1 && coins.get(p.username) - coinsOf(p) <= 20), { colour: walk?.colour, capes: seen.capesAtPeak, walkers: walkers.map(p => p.username), spent: clan.map(p => `${p.username} ${coins.get(p.username) - coinsOf(p)}`) });
    const leaderLines = lines.filter(l => l.kind === 'setpiece' && l.name === walk?.leader.username).map(l => l.text);
    check("they gathered at the hub, the leader's call and lines (a set piece's: out of H7)", seen.gathered && leaderLines.length >= 2, { gathered: seen.gathered, leaderLines });
    check('a line: each follows the one ahead (the game\'s Follow, near it, 70 %+ of the walk), not all the leader', seen.memberWalkTicks > 100 && seen.followTicks >= seen.memberWalkTicks * 0.7 && seen.chainOk >= seen.chainTicks * 0.9, seen);
    check('the leader walks, never runs (the line\'s pace)', seen.leaderSteps > 50 && seen.leaderRuns <= seen.leaderSteps * 0.05, `${seen.leaderRuns} running of ${seen.leaderSteps} steps`);
    check('at each stop they stand on tiles of their own beside the leader, out of the line', seen.stopTicks > 0 && seen.stopStacked === 0 && seen.stopFollowing <= seen.stopTicks, seen);
    const answer = lines.find(l => l.t > joinAt && l.t <= joinAt + 40 && l.to === human.username && l.kind === 'setpiece');
    // (answers only: a social regular's own approach to the human, "hey", "nice to meet u!", is none: the merged world's)
    const others = lines.filter(l => l.t > joinAt && l.t <= joinAt + 40 && l.to === human.username && l.name !== walk?.leader.username && (l.kind === 'reply' || l.kind === 'setpiece'));
    check('"can i join ur clan?": the leader answers (the walk\'s colour: "need a red cape lol"), no other bot', joinAt > 0 && !!answer && answer.name === walk?.leader.username && others.length === 0, { answer, others: others.map(l => `${l.name}: ${l.text}`) });
    const after = clan.map(p => ({ name: p.username, role: SetPieces.eventRoleOf(p), sub: subOf(p)?.name ?? null, task: taskOf(p)?.name ?? null }));
    check('after it: no part, no walk sub-task, their own tasks again', after.every(a => a.role === null && a.sub !== 'ClanWalk' && a.task !== null), after);
    const said = lines.filter(l => l.kind === 'setpiece' && clan.some(p => p.username === l.name));
    out(`note: the clan said ${said.length} lines: ${said.slice(0, 10).map(l => JSON.stringify(l.text)).join(', ')}`);
}

// ---- 3. a clan walk, new bots: their clique's colour, nothing bought ----
{
    scene(SEED, 'clan walk new'); // (its own dice: test/lib/dice.mjs)
    const clan = [];
    for (let i = 0; i < 3; i++) {
        const p = take(b => levelling(b) && !lib.isNewbie(b) && b.combatLevel >= 15 && !sim.botPlayer(b)?.hasSubTask() && SetPieces.eventRoleOf(b) === null);
        if (p) clan.push(p);
    }
    Cliques.setCliquesForTest([clan.map(p => p.username)]);
    const colour = Cliques.cliqueColourOf(clan[0].username);
    const capeId = lib.wardrobeItems().capes[colour];
    const coins = new Map();
    for (const p of clan) {
        capesOff(p);
        p.getInventory(lib.InvType.WORN).set(1, { id: capeId, count: 1 });
        coins.set(p.username, coinsOf(p));
        const [x, z] = tileNear(3000 + clan.indexOf(p) * 3, 3380);
        p.clearWaypoints();
        p.teleJump(x, z, 0);
    }
    run(2);
    // (all three free at the park at once: one on a break, or walked off by its task, is put back meanwhile)
    run(600, () => {
        for (const p of clan) {
            if (cheb(p, { x: 3000, z: 3380 }) > 12) {
                const [x, z] = tileNear(3000 + clan.indexOf(p) * 3, 3380);
                p.clearWaypoints();
                p.teleJump(x, z, 0);
            }
        }
        return clan.every(p => D.isFreeForEvent(p));
    });
    D.resetDirectorForTest();
    D.setDirectorForTest({ first: 0, firstKinds: ['clan_walk'], kinds: ['clan_walk'] });
    let walk = null;
    run(5000, () => {
        if (!walk) {
            walk = SetPieces.runningSetPieces().find(x => x.kind === 'clan_walk') ?? null;
            // (the coins from the walk's start: before it, their own tasks earn and spend, a thief's pickpocketing)
            if (walk) for (const p of clan) coins.set(p.username, coinsOf(p));
        }
        return walk !== null && walk.phase === 'done';
    });
    if (!walk) out(`note: the second clan: ${clan.map(p => `${p.username} free ${D.isFreeForEvent(p)} sub ${subOf(p)?.name ?? '-'} away ${lib.isAway(p)} at ${p.x},${p.z} cb ${p.combatLevel}`).join('; ')}; director ${JSON.stringify(D.directorState())}`);
    check("new bots (the clique's colour worn): a walk in their own colour, nothing bought", !!walk && walk.colour === colour && clan.every(p => coinsOf(p) === coins.get(p.username)) && walk.outcome === 'done', walk ? { colour: walk.colour, want: colour, outcome: walk.outcome, spent: clan.map(p => coins.get(p.username) - coinsOf(p)) } : 'none');
    check("a clique member's new kit wears its clan's colour (port/BotLooks gearTaste: new bots only)", clan.every(p => { const t = lib.gearTaste(p.username); return t.cape === true && t.capeColour === colour; }), clan.map(p => lib.gearTaste(p.username)));
}

// ---- 4. a PK team raid into the Varrock Wilderness ----
{
    scene(SEED, 'PK team raid'); // (its own dice: test/lib/dice.mjs)
    // (a team of close combat levels: in the Wilderness at levels 3-7 each may fight one of its leader's level)
    const pkers = sim.bots().filter(b => b.botPlanner === 'extras_edgeville_pker' && taskOf(b)?.name === 'EdgevillePKer').sort((a, b) => a.combatLevel - b.combatLevel);
    let team = pkers.slice(0, 2);
    for (let i = 0; i + 1 < pkers.length; i++) {
        const group = pkers.slice(i, i + 3).filter(p => p.combatLevel - pkers[i].combatLevel <= 3);
        if (group.length > team.length || (group.length === team.length && group[group.length - 1].combatLevel - group[0].combatLevel < team[team.length - 1].combatLevel - team[0].combatLevel)) team = group;
    }
    out(`note: Edgeville PKers ${pkers.map(p => `${p.username} ${p.combatLevel}`).join(', ')}; the team ${team.map(p => p.username).join(', ')}`);
    for (const p of team) used.add(p);
    Cliques.setCliquesForTest([team.map(p => p.username)]);
    // (each healthy, near the edge, in no fight: out of its last one too, the game's logout timer run out, as the director's
    // first look comes a few ticks after this)
    for (const p of team) {
        p.levels[3] = p.baseLevels[3];
        p.clearPendingAction();
        p.preventLogoutUntil = -1;
        const [x, z] = tileNear(3093 + team.indexOf(p) * 2, 3505);
        p.teleJump(x, z, 0);
    }
    sim.teleportHuman(3165, 3480, 0);
    // (a hit on its way from the last fight sets the game's logout timer again: the director's look waits for both free)
    run(100, () => team.every(p => World.currentTick >= p.preventLogoutUntil && attacking(p) === null && p.levels[3] * 2 >= p.baseLevels[3]));
    D.resetDirectorForTest();
    D.setDirectorForTest({ first: 5, firstKinds: ['pk_raid'], kinds: ['pk_raid'] });
    let raid = null;
    const seen = { met: false, inStrip: 0, patrolSamples: 0, maxOn: 0, piled: false, attackers: new Set(), allMulti: true, singlePiles: 0, outAt: -1 };
    let humanIn = -1;
    run(4000, tick => {
        raid ??= SetPieces.runningSetPieces().find(x => x.kind === 'pk_raid') ?? null;
        // (no two bots on one target in a single-combat zone, anywhere, all along)
        const on = new Map();
        for (const b of sim.bots()) {
            const t = attacking(b);
            if (t) on.set(t, [...(on.get(t) ?? []), b]);
        }
        for (const [t, list] of on) if (list.length >= 2 && !lib.isMultiCombat(t.x, t.z, t.level)) seen.singlePiles++;
        if (!raid) return false;
        if (raid.phase === 'announce' && [...raid.roles.keys()].every(m => cheb(m, { x: PkTeam.EDGE_MEET[0], z: PkTeam.EDGE_MEET[1] }) <= 8)) seen.met = true;
        if (raid.phase === 'peak') {
            seen.patrolSamples++;
            for (const m of raid.roles.keys()) if (m.x >= PkTeam.RAID_ZONE.x0 - 12 && m.x <= PkTeam.RAID_ZONE.x1 + 12 && m.z >= PkTeam.RAID_ZONE.z0 - 12 && m.z <= PkTeam.RAID_ZONE.z1 + 12) seen.inStrip++;
            // (the human walks in beside the leader, its combat the team's: fair game in multi-combat; the team of one
            // combat level, as a 2004 team of friends of the same level was: else the game's level range splits it)
            if (humanIn < 0 && tick - raid.startedAt > 200) {
                humanIn = tick;
                for (const m of raid.roles.keys()) if (m !== raid.leader) for (let st = 0; st < 7; st++) if (raid.leader.baseLevels[st] > 1) m.setLevel(st, raid.leader.baseLevels[st]);
                sim.copyLevels(raid.leader);
                const [x, z] = tileNear(raid.leader.x + 3, raid.leader.z);
                sim.teleportHuman(x, z, 0);
            }
            if (humanIn > 0) {
                human.levels[3] = human.baseLevels[3];
                const list = on.get(human) ?? [];
                seen.maxOn = Math.max(seen.maxOn, list.length);
                if (list.length >= 2) seen.piled = true;
                for (const b of list) {
                    seen.attackers.add(b.username);
                    if (!lib.isMultiCombat(human.x, human.z, human.level)) seen.allMulti = false;
                }
                // (then two of the team beaten, no food: the team goes home)
                if (seen.piled && seen.outAt < 0 && tick - humanIn > 150) {
                    seen.outAt = tick;
                    for (const m of [...raid.roles.keys()].slice(0, 2)) {
                        m.levels[3] = Math.max(1, Math.floor(m.baseLevels[3] * 0.3));
                        m.getInventory(lib.InvType.INV)?.removeAll();
                    }
                }
                if (seen.outAt > 0 && tick - seen.outAt > 100) sim.teleportHuman(3165, 3480, 0);
            }
        }
        return raid.phase === 'done';
    });
    sim.teleportHuman(3165, 3480, 0);
    check('a PK team raid of the clique starts (forced early) and ends', team.length >= 2 && !!raid && raid.phase === 'done', raid ? `${raid.team.length} in the team; outcome ${raid.outcome}` : `none (${team.length} Edgeville PKers)`);
    check("an Edgeville team banks and meets north of Edgeville bank first", seen.met, seen);
    check('it walks east and patrols the Varrock Wilderness (levels 3-7)', seen.patrolSamples > 100 && seen.inStrip >= seen.patrolSamples * 0.6 * Math.max(1, (raid?.team.length ?? 1) - 1), seen);
    check('the human there is piled on in multi-combat (no warning needed): 2-3 of the team at once, never more', seen.piled && seen.maxOn >= 2 && seen.maxOn <= 3 && seen.allMulti && [...seen.attackers].every(n => team.some(p => p.username === n)), { maxOn: seen.maxOn, attackers: [...seen.attackers], allMulti: seen.allMulti });
    check('no two bots ever on one target in a single-combat zone', seen.singlePiles === 0, `${seen.singlePiles}`);
    check('two of the team beaten (under 40 % with no food): the team goes home', seen.outAt > 0 && raid?.outcome === 'beaten', `${raid?.outcome}`);
    const after = team.map(p => ({ role: SetPieces.eventRoleOf(p), task: taskOf(p)?.name ?? null }));
    check('after it: no part, each at its PK task again', after.every(a => a.role === null && a.task === 'EdgevillePKer'), after);
    // (a member that died, seen by its respawn's jump since the director's last step, is out; the rest go on. A run of
    // its own, not the director's: the PK tasks never see it)
    {
        const r = new PkTeam.PkRaidRun({ team, edge: true, first: PkTeam.PATROL_POINTS[0] }, World.currentTick);
        r.tick(World.currentTick);
        const victim = team[team.length - 1];
        const [x, z] = tileNear(3165, 3480);
        victim.teleJump(x, z, 0);
        run(5);
        r.tick(World.currentTick);
        // (a team of two: one left is too few, and it goes home)
        const goesOn = team.length >= 3 ? r.phase !== 'done' : r.outcome === 'too few';
        check("a raid's member that died (its respawn's jump) is out of the team; the rest go on (a team of two goes home)", !r.roles.has(victim) && r.roles.has(r.leader) && r.roles.size === team.length - 1 && goesOn, { team: team.length, roles: r.roles.size, phase: r.phase, outcome: r.outcome });
        r.abort('test');
    }
}

// ---- 5. a newbie follow train ----
{
    scene(SEED, 'newbie train'); // (its own dice: test/lib/dice.mjs)
    D.resetDirectorForTest();
    D.setDirectorForTest({ first: 1e9 });
    Trains.resetTrainsForTest();
    /**
     * a levelling bot made a newbie in Lumbridge's courtyard (levels 1, the newcomer's flag), standing about there (its
     * own task, a skill elsewhere, walked it off before it asked: the merged world's dice)
     */
    function newbieAt(x, z) {
        const p = take(b => levelling(b) && !sim.botPlayer(b)?.hasSubTask() && SetPieces.eventRoleOf(b) === null);
        for (let s = 0; s < 21; s++) p.setLevel(s, s === 3 ? 10 : 1);
        p.botNewbie = true;
        const [tx, tz] = tileNear(x, z);
        p.clearWaypoints();
        p.teleJump(tx, tz, 0);
        const bp = sim.botPlayer(p);
        const stand = { name: 'Newbie', interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, reset() {}, interrupt() {}, activityStep: () => null };
        bp.currentTask?.interrupt?.();
        bp.planner.pickTask = () => stand;
        bp.currentTask = stand;
        return p;
    }
    // (a passer-by: back and forth beside the newbie until a train forms behind it, then off up the road)
    class Stroll extends lib.BotTask {
        constructor(x, z, away) {
            super('Stroll');
            this.x = x;
            this.z = z;
            this.away = away;
            this.leg = 0;
        }
        shouldRun() {
            return true;
        }
        tick(p) {
            p.run = 0;
            if (p.hasWaypoints()) return;
            const tr = Trains.currentTrain();
            if (tr && tr.leader === p) return void (cheb(p, { x: this.away[0], z: this.away[1] }) > 2 && lib.walkTo(p, this.away[0], this.away[1], 0));
            const [x, z] = tileNear(this.x + (this.leg++ % 2 === 0 ? 4 : -4), this.z, 2);
            lib.walkTo(p, x, z, 0);
        }
        isComplete(p) {
            return Trains.trainsLog.length > 0 && !Trains.currentTrain() && cheb(p, { x: this.away[0], z: this.away[1] }) <= 2;
        }
    }
    const first = newbieAt(3222, 3218);
    const second = newbieAt(3200, 3245);
    // (only the first asks: the second is no newbie until a train has formed, then joins it)
    second.botNewbie = false;
    const stranger = take(b => levelling(b) && b.combatLevel >= 20 && !lib.isNewbie(b) && !sim.botPlayer(b)?.hasSubTask() && SetPieces.eventRoleOf(b) === null);
    const [sx, sz] = tileNear(3219, 3220);
    stranger.clearWaypoints();
    stranger.teleJump(sx, sz, 0);
    run(2);
    sim.botPlayer(stranger).setSubTask(new Stroll(first.x, first.z, [3216, 3262]));
    // (since the variety work's round 1, track F, ISS-6, any free low-level about Lumbridge may join a train, three to a
    // line: the others there are kept busy with a sub-task of the test's, so the second newbie is the one to join)
    const busy = () => ({ name: 'Idle', interrupted: false, state: 'idle', done: false, shouldRun: () => true, isComplete() { return this.done; }, tick() {}, reset() {}, interrupt() {}, activityStep: () => null });
    const busied = sim.bots().filter(b => b !== first && b !== second && b !== stranger && b.level === 0 && b.combatLevel <= 10 && cheb(b, first) <= 60 && !sim.botPlayer(b)?.hasSubTask()).map(b => {
        const t = busy();
        sim.botPlayer(b)?.setSubTask(t);
        return t;
    });
    Trains.setTrainRatesForTest({ ask: 1, form: 0, yes: 1, join: 1 });
    const t0 = World.currentTick;
    // (the merged world's dice: another passer-by in the courtyard, a bot of combat 20+, was asked first and walked off
    // before its yes, and a newbie asks again only 20 minutes on: until the train forms the staging keeps the others a few
    // steps off, so the stroller is the one passing by)
    const passersBy = () => sim.bots().filter(b => b !== first && b !== second && b !== stranger && b.level === 0 && cheb(b, first) <= 12 && (b.combatLevel >= 15 || b.botPlanner === 'extras_social') && !lib.isNewbie(b));
    let leader = null;
    let asked = null;
    let followed = false;
    let joined = false;
    let ended = null;
    run(1500, () => {
        const tr = Trains.currentTrain();
        if (!tr && !leader) {
            for (const b of passersBy()) {
                const [x, z] = tileNear(first.x + 18, first.z + 16, 4);
                b.clearWaypoints();
                b.teleJump(x, z, 0);
            }
        }
        if (tr && !leader) {
            leader = tr.leader;
            asked = lines.find(l => l.t >= t0 && l.name === first.username && l.kind === 'setpiece' && l.to === leader.username) ?? null;
            second.botNewbie = true;
            const [x, z] = tileNear(first.x + 1, first.z + 1, 3);
            second.clearWaypoints();
            second.teleJump(x, z, 0);
        }
        if (tr && tr.members[0] === first && isFollowing(first, tr.leader)) followed = true;
        // (the second newbie alongside the first until it joins: a newbie the train passes)
        if (tr && tr.members.length < 2 && World.currentTick % 10 === 0 && cheb(second, first) > 4) {
            const [x, z] = tileNear(first.x - 1, first.z - 1, 3);
            second.clearWaypoints();
            second.teleJump(x, z, 0);
        }
        // (since the variety work's round 1, track F, ISS-6, any free low-level about Lumbridge may join too: the second
        // newbie joins behind the last of the line, following the one ahead of it)
        if (tr && tr.members.indexOf(second) >= 1) {
            const ahead = tr.members[tr.members.indexOf(second) - 1];
            if (isFollowing(second, ahead) || cheb(second, ahead) <= 3) joined = true;
        }
        if (leader && !tr && Trains.trainsLog.length > 0) {
            ended = Trains.trainsLog[Trains.trainsLog.length - 1];
            return true;
        }
        return false;
    });
    check('a newbie asks a passer-by "can i follow u?" (a set piece\'s line to it)', !!asked, asked ?? lines.filter(l => l.t >= t0 && l.kind === 'setpiece').slice(0, 4));
    check('on its yes the newbie follows it (the game\'s Follow)', followed, `${leader?.username} (the stroller ${stranger.username})`);
    check('a second newbie joins the line behind the first (behind the last), following the one ahead of it', joined);
    check('the train ends (the leader still, far, or its time), its newbies in the log', !!ended && ended.members.length >= 2, ended);
    for (const t of busied) t.done = true;
    run(20);
    const after = [first, second].map(p => ({ role: SetPieces.eventRoleOf(p), sub: subOf(p)?.name ?? null, newbie: lib.isNewbie(p) }));
    check('after it: newbies still, no part, no follow', after.every(a => a.role === null && a.sub !== 'ChainFollow' && a.newbie), after);

    // the human asked as it walks by (pacing beside a newbie; a bot passer-by's train let go): "sure", then "stop following me"
    Trains.resetTrainsForTest();
    first.botNewbie = false;
    second.botNewbie = false;
    const third = newbieAt(3160, 3205);
    const [hx, hz] = tileNear(third.x + 3, third.z);
    sim.teleportHuman(hx, hz, 0);
    const t1 = World.currentTick;
    let ask = null;
    run(800, tick => {
        const tr = Trains.currentTrain();
        if (tr && !tr.human) Trains.resetTrainsForTest();
        // (the human paces up and down; the newbie stays near it, as one standing by the road)
        if (!human.hasWaypoints()) {
            const [x, z] = tileNear(3160 + (human.x >= 3160 ? -4 : 4), 3205, 2);
            lib.walkTo(human, x, z, 0);
        }
        if (tick % 20 === 0 && cheb(third, human) > 4) {
            const [x, z] = tileNear(human.x + 2, human.z + 1, 3);
            third.clearWaypoints();
            third.teleJump(x, z, 0);
        }
        ask = lines.find(l => l.t >= t1 && l.kind === 'setpiece' && l.to === human.username && l.name === third.username) ?? null;
        return ask !== null;
    });
    if (!ask) out(`note: the human was not asked: ${third.username} newbie ${lib.isNewbie(third)} sub ${subOf(third)?.name ?? '-'} away ${lib.isAway(third)} at ${third.x},${third.z} hp ${third.levels[3]}/${third.baseLevels[3]}; the human at ${human.x},${human.z} waypoints ${human.hasWaypoints()}; train ${JSON.stringify(Trains.trainsLog.slice(-2))}`);
    run(4);
    human.clearWaypoints();
    lib.BotChat.onPublicMessage(human, 'sure');
    let followsHuman = false;
    run(80, () => {
        const tr = Trains.currentTrain();
        if (tr?.human && tr.members[0] === third && isFollowing(third, human)) followsHuman = true;
        return followsHuman;
    });
    lib.BotChat.onPublicMessage(human, 'stop following me');
    run(5);
    const last = Trains.trainsLog[Trains.trainsLog.length - 1];
    check('the human asked as it walks by; "sure": the newbie follows it; "stop following me" ends it', !!ask && followsHuman && last?.human === true && last.reason === 'told off', { ask: ask?.text, followsHuman, last });
    Trains.setTrainRatesForTest(null);
}

check('no bot errors', BotManager.stats().errors === 0 && logErrors.length === 0, logErrors.slice(0, 3));
let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(`groups: ${checks.length - failed} of ${checks.length} passed`);
process.exit(failed ? 1 : 0);
