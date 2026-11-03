#!/usr/bin/env node
// PKers loot the human's death pile, vultures, the loot ledger (bots ideas round 1, track B), in the real rev-274 world on a members world with the content overlay as the runtime
// installs it (a bot keeps its items when it dies: patch 0003). Each scene has its own dice (test/lib/dice.mjs), clean
// packs, full run energy, the director, cliques, breaks and random events off, and bots held with a stand task.
//   edgeville  (scene 1) a real EdgevillePKerTask kills a kitted human at Wilderness level 3: the killer takes its most
//              valuable stacks before the reveal, most valuable first (LV1, LV2); a rude levelling bot near enrols,
//              waits on a tile of its own, takes nothing before the reveal (LV3) and a leftover within 8 ticks of it
//              (LV5); every item of the pile is taken or gone, never twice (LV6); the killer banks at the Edgeville
//              booth: the looted items in its bank, none deleted by its restock (LV7)
//   full pack  (scene 2) a killer with a full pack eats at most 4 of its own food for a stack worth 1k or more, drops
//              nothing
//   npc death  (scene 3) the human dies of a queued damage_player in Lumbridge: a looter takes within 15 ticks of the
//              drop, a picker waits 60 ticks or more, a polite bot never takes, at most 2 enrol; a friendly bot's word
//              when the human is back by its items
//   multi      (scene 4) a kill in the Wilderness's multi-combat north of Varrock: only the hero takes before the reveal,
//              its clique mate enrols at the reveal and takes leftovers after it
//   death      (scene 5) a PKer killed carrying the human's items keeps them (0003), banks them after its respawn before
//              it walks out; it is held from logging out meanwhile; its ledger goes into the saved world and comes back
//   arena      (scene 6) a death at the Duel Arena: no pile, nobody enrols
//   lines      (scene 7) a loot line with an item the filter would star is said without it
//   temple     (B4) the Chaos Temple's yard is a deep PKers' zone, walked to, picked at a zone change at one zone's time
//   camps      (A8) the lever camps (the west Lava Maze ladder, the Demonic Ruins): the campers go for 1 in 3 of the
//              passing bossers (the same answer through a pass), attack one in range and never a bot that is no bosser
//   wine       (A6) the wine crowd's number from N; a bot that may grab is offered a stint while it is short; 3 grabbers
//              each on a tile of its own, each wine to one of them (the grabs that landed are the wines owned), lost
//              grabs, the lost word and the winner's answer within their gaps; a grabber with only an air staff wields
//              it for its stint and its scimitar again after
//   safespots  (A7) from each of the 3 tiles a ranger shoots its giant (kept alive, chasing it) 100 ticks unmoved and
//              unhit; a ranger's own task claims a tile and holds it 70 %+ of the time; all taken, a newcomer asks and
//              the other answers, and it waits its turn
//   (round 1's fixes, the review's findings)
//   hurt killer  (B2) a killer at 40 % of its Hitpoints still takes before the reveal, a bite of its food while it waits
//   pj           (B1) a PJer's attack the tick after a Take ends the killer's loot: the take that landed is in its ledger
//   own drop     (B4) a fighter's own fresh drop (private to it) 2 tiles from the human's death is not the pile
//   stint cut    (B3) a wine stint switched away from, or failed out of the temple, after its air staff was wielded: its
//                own weapon in hand again, its temple tile given back
//   (round 1's left-overs)
//   wine         (T1) each grab clicked a person's moment after the wine came back (a spread of delays, seldom two grabs
//                in a row the same apart: H18), from the grabber's own tile only (T2); the reaction draw's spread
//   wine exit    (T2) after a stint long enough for the door to shut behind it, the grabber opens it from inside and
//                walks out to the bank: no rescue jump, no leap
//   wine sight   (T2) a grab's tile claimed out of the table's sight (behind the altar) is given up for one in sight: no
//                "I can't reach that!", its wines grabbed
//   safespot move (T3) a ranger whose tile's giant is gone moves to a free tile whose giant it can shoot; one in its scan
//                with no tile takes one
//   stale restore (B6) a ledger restored newer than the PKer's own save banks only what the save holds of the human's
//   quit         (B5) a PKer out of the pool for good takes its ledger with it (none saved after)
//
//   node --expose-gc web/engine/bots/test/loot.test.mjs [--seed=N] [--debug]
//
// Exit code 1 if a check fails. Nothing is written outside build/tmp/bots.
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, CONTENT_DIR, ENGINE_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { compileBotScripts } from '../content/compile.mjs';
import { scene } from './lib/dice.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const SEED = Number(args.seed ?? 1) >>> 0 || 1;
const DEBUG = args.debug === 'true';
scene(SEED, 'world');
const consoleErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const real = console[level].bind(console);
    console[level] = (...a) => {
        const text = a.map(String).join(' ');
        if (level === 'error' && !text.includes('ExperimentalWarning')) consoleErrors.push(text.slice(0, 300));
        if (DEBUG) real(...a);
    };
}
const out = s => process.stdout.write(s + '\n');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });

// ---- the world, the overlay ----
const overlay = await compileBotScripts({ engineDir: ENGINE_DIR, contentDir: CONTENT_DIR, log: () => {} });
const scriptsBin = new Uint8Array(fs.readFileSync(overlay.file));
const scriptDat = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.dat')));
const scriptIdx = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.idx')));
const engineDir = prepareEngineClone('loot', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/loot.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, InvType, PlayerStat, Loot, ObjType, Obj } = lib;

const N = 24;
const sim = await lib.Sim.create({ bots: N, members: true, debug: DEBUG, spawnPerTick: N });
const replaced = lib.installBotsContent(scriptsBin, scriptDat, scriptIdx);
sim.addHuman(3222, 3218, 0);
const human = sim.human;
// (the human's own random events off, as the bots' are below: the game's Swarm attacked it at the hurt killer's spot and
// killed it, an NPC's death with no hero, its pile public at once: seed 2)
{
    const processClientsIn = World.processClientsIn;
    World.processClientsIn = function () {
        processClientsIn.call(this);
        human.afkEventReady = false;
    };
}
while (sim.bots().length < N && World.currentTick < 30) sim.tick();
check('the world: 24 bots online, the overlay in place', sim.bots().length === N && replaced > 0, `${sim.bots().length} bots, ${replaced} scripts`);
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0, abrupt: 0 });
lib.setHangoutRateForTest(0.0001);
lib.setArenaRatesForTest(0);
lib.setDirectorForTest({ first: 1e9, gap: 1e9 });
lib.resetDirectorForTest(); // (the first piece drawn at the fill dropped: none comes)
lib.setCliqueBehaviourForTest(false);
lib.setEventRatesForTest({ odds: 0 });
lib.setTrainRatesForTest({ ask: 0, form: 0, yes: 0, join: 0 });
lib.setAlchRateForTest(0);
lib.setScamRatesForTest({ ambient: false });
// (no witness of a death, a fight or gear: their words are BotWitness's, not this test's)
lib.setWitnessRatesForTest({ death: 0, drop: 0, human: 0, show: 0, gear: 0, level: 0, respond: 0, fight: 0 });

const id = n => ObjType.getId(n);
const name = i => ObjType.get(i)?.debugname ?? `#${i}`;
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
/**
 * a player dying, as the bots see a death (port/BotWitness playerDying): its Hitpoints at 0, or at 1 in its death (a
 * killing hit in its regen's tick: the human of seeds 6 and 10 died at 1, unseen by a wait for 0)
 */
const dying = p => lib.Witness.playerDying(p);
const STAND = { name: 'Idle', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
function hold(p) {
    const ai = sim.botPlayer(p);
    ai.currentTask = Object.create(STAND);
    ai.planEnds = World.currentTick + 1e6;
    p.clearWaypoints();
    p.clearPendingAction();
}
function assign(p, task) {
    task.reset();
    const ai = sim.botPlayer(p);
    ai.currentTask = task;
    ai.planEnds = World.currentTick + 1e6;
    p.clearWaypoints();
    p.clearPendingAction();
}
const run = (max, until = () => false) => {
    for (let i = 0; i < max; i++) {
        sim.tick();
        if (until()) return i + 1;
    }
    return -1;
};
const subTaskOf = p => sim.botPlayer(p)?.subTask ?? null;
/** a clean pack (and bank), full run energy, no sub-task, nothing it was doing */
function clean(p, bankToo = true) {
    p.clearPendingAction();
    p.clearWaypoints();
    p.activeScript = null;
    p.getInventory(InvType.INV).removeAll();
    if (bankToo) p.getInventory(lib.bankInvId()).removeAll();
    p.runenergy = 10000;
    p.levels[PlayerStat.HITPOINTS] = p.baseLevels[PlayerStat.HITPOINTS];
}
const place = (p, x, z, level = 0) => {
    p.teleJump(x, z, level);
};
/** the human's kit: full rune worn (it keeps the 3 priciest: body, legs, helm), a rune scimitar, and a pack of loot */
function dressHuman(pack) {
    for (const t of [InvType.INV, InvType.WORN]) {
        const inv = human.getInventory(t);
        for (let s = 0; s < inv.capacity; s++) inv.set(s, null);
    }
    const worn = human.getInventory(InvType.WORN);
    worn.set(0, { id: id('rune_full_helm'), count: 1 });
    worn.set(2, { id: id('amulet_of_strength'), count: 1 });
    worn.set(3, { id: id('rune_scimitar'), count: 1 });
    worn.set(4, { id: id('rune_platebody'), count: 1 });
    worn.set(7, { id: id('rune_platelegs'), count: 1 });
    const inv = human.getInventory(InvType.INV);
    let s = 0;
    for (const [n, c] of pack) inv.set(s++, { id: id(n), count: c });
    human.buildAppearance(InvType.WORN);
}
/** the human at the PKer's levels exactly (so their combat levels match) */
function matchHuman(k) {
    for (let stat = 0; stat < k.baseLevels.length; stat++) if (human.baseLevels[stat] !== k.baseLevels[stat]) human.setLevel(stat, k.baseLevels[stat]);
    human.combatLevel = human.getCombatLevel();
}
const LOOT_PACK = [['coins', 6000], ['lawrune', 30], ['naturerune', 40], ['deathrune', 50], ['mithril_scimitar', 1], ['rune_med_helm', 1], ['adamant_kiteshield', 1], ['adamant_platelegs', 1], ['lobster', 1], ['lobster', 1], ['lobster', 1], ['swordfish', 1]];
const piles = () => Loot.activePiles();
const events = (pile, kind) => Loot.lootLog.filter(e => e.pile === pile && (!kind || e.kind === kind));
/** a stand-in human death: its Hitpoints to 0 by the game's own damage script (no hero: an NPC's) */
function npcDeath() {
    const script = lib.ScriptProvider.getByName('[queue,damage_player]');
    human.enqueueScript(script, lib.PlayerQueueType.NORMAL, 0, [human.levels[PlayerStat.HITPOINTS]]);
}
/**
 * after a death: the human back in the world, healed and cured (a poison left from an earlier scene's fight, a DDS's,
 * killed it before the next scene's killer struck: no hero, its drop public at once; seed 3)
 */
function humanBack(x, z) {
    run(30, () => human.levels[PlayerStat.HITPOINTS] > 0 && !human.delayed && !dying(human));
    sim.teleportHuman(x, z, 0);
    human.setVar(lib.VarPlayerType.getByName('poison').id, 0);
    human.clearTimer(lib.ScriptProvider.getByName('[timer,poison]').id);
    for (const name of ['[queue,poison_player]', '[queue,poison_damage]']) human.unlinkQueuedScript(lib.ScriptProvider.getByName(name).id);
    human.levels[PlayerStat.HITPOINTS] = human.baseLevels[PlayerStat.HITPOINTS];
    human.heroPoints.clear();
}
/** every item of a pile ended once: taken or gone (LV6), the counts taken never more than dropped */
function conserved(pile) {
    const drops = events(pile, 'drop');
    const ends = Loot.lootLog.filter(e => e.pile === pile && (e.kind === 'take' || e.kind === 'gone'));
    const byItem = new Map();
    for (const d of drops) byItem.set(d.item, (byItem.get(d.item) ?? 0) + d.count);
    for (const e of ends) byItem.set(e.item, (byItem.get(e.item) ?? 0) - e.count);
    const off = [...byItem].filter(([, n]) => n !== 0);
    return { ok: drops.length > 0 && ends.length === drops.length && off.length === 0, detail: `${drops.length} items dropped, ${ends.length} ended; off: ${off.map(([i, n]) => `${name(i)} ${n}`).join(', ') || 'none'}` };
}

// (round 1's left-overs: T1, T2) the Asgarnian Chaos Temple: its wine on the table, its door, its floor
const WINE_AT = [2930, 3515];
function wineOnTable() {
    const zone = World.gameMap.getZone(WINE_AT[0], WINE_AT[1], 0);
    for (const o of zone?.getAllObjsSafe() ?? []) if (o.type === id('wine_of_zamorak') && o.x === WINE_AT[0] && o.z === WINE_AT[1]) return o;
    return null;
}
function templeDoorShut() {
    const zone = World.gameMap.getZone(2941, 3517, 0);
    const shut = lib.LocType.getId('loc_1530');
    for (const loc of zone?.getAllLocsSafe() ?? []) if (loc.type === shut && loc.x === 2941 && loc.z === 3517) return true;
    return false;
}
/** the temple's own floor (its walls round it): BotMagicRuns' TEMPLE_TILES, from the probe's walk with the door shut */
const TEMPLE_FLOOR = new Set([[2939, 3518], ...[2932, 2933, 2935, 2936, 2937, 2938, 2939, 2940].map(x => [x, 3517]), ...[2931, 2932, 2933, 2934, 2935, 2936, 2937, 2938, 2939].map(x => [x, 3516]), ...[2931, 2932, 2933, 2934, 2935, 2936].map(x => [x, 3515]), ...[2930, 2931, 2932, 2933, 2934, 2935, 2936].map(x => [x, 3514]), [2935, 3513]].map(([x, z]) => `${x},${z}`));
const templeFloor = p => p.level === 0 && TEMPLE_FLOOR.has(`${p.x},${p.z}`);
/**
 * every grab's click (a grabber's target becomes the wine): how long after the wine came back to the table, the grabber's
 * clicks (two in a row the same apart: H18's measure), and whether it stood on its own tile (lib.standTileOf)
 */
function wineGrabWatch(grabbers) {
    let backAt = -1;
    let there = false;
    const delays = [];
    const clicks = new Map(grabbers.map(p => [p, []]));
    const lastTarget = new Map();
    let offTile = 0;
    return {
        tick() {
            const w = wineOnTable();
            if (w && !there) backAt = World.currentTick;
            there = !!w;
            for (const p of grabbers) {
                const t = p.target;
                if (t && t !== lastTarget.get(p) && t.type === id('wine_of_zamorak')) {
                    clicks.get(p).push(World.currentTick);
                    if (backAt >= 0) delays.push(World.currentTick - backAt);
                    const st = lib.standTileOf(p);
                    if (!st || st[0] !== p.x || st[1] !== p.z) offTile++;
                }
                lastTarget.set(p, t);
            }
        },
        result() {
            let pairs = 0;
            let same = 0;
            for (const ts of clicks.values()) {
                const iv = ts.slice(1).map((t, i) => t - ts[i]);
                for (let i = 1; i < iv.length; i++) {
                    if (iv[i] > 100 || iv[i - 1] > 100) continue;
                    pairs++;
                    if (iv[i] === iv[i - 1]) same++;
                }
            }
            const sorted = [...delays].sort((a, b) => a - b);
            return { delays, distinct: new Set(delays).size, median: sorted[sorted.length >> 1] ?? -1, pairs, same: pairs ? Math.round((1000 * same) / pairs) / 10 : 0, offTile };
        }
    };
}

const bots = sim.bots();
for (const b of bots) hold(b);
const edgePkers = bots.filter(p => p.botPlanner === 'extras_edgeville_pker');
const levelling = bots.filter(p => lib.isLevelling(p.botPlanner));
check('the world: 2 Edgeville PKers and 10 levelling bots to stage', edgePkers.length >= 2 && levelling.length >= 10, `${edgePkers.length} Edgeville PKers, ${levelling.length} levelling`);
// (everyone out of the way: Lumbridge's courtyard's far side; the scenes take whom they need)
const parkAt = (p, i) => place(p, 3200 + (i % 6), 3200 + Math.floor(i / 6));
bots.forEach(parkAt);
run(3);

// ---- scene 1: Edgeville, Wilderness level 3: the killer, a vulture, the ledger, the booth ----
const SPOT = [3093, 3540];
const K = edgePkers[0];
const V = levelling.find(p => !lib.personaOf(p.username, p.botPlanner).meme) ?? levelling[0];
let pile1 = null;
{
    scene(SEED, 'edgeville');
    Loot.setLootRatesForTest({ trait: p => (p === V ? 'looter' : null), enrol: 1 });
    clean(K);
    place(K, SPOT[0] + 2, SPOT[1] + 1);
    assign(K, new lib.EdgevillePKerTask());
    // (its build's levels and kit at its init: then the human at its levels, low on Hitpoints)
    run(8);
    matchHuman(K);
    sim.teleportHuman(SPOT[0], SPOT[1], 0);
    dressHuman(LOOT_PACK);
    human.levels[PlayerStat.HITPOINTS] = 6;
    clean(V);
    place(V, SPOT[0] + 4, SPOT[1] + 3);
    const bankBefore = K.getInventory(lib.bankInvId()).items?.slice?.() ?? null;
    let died = -1;
    run(400, () => {
        if (died < 0 && dying(human)) died = World.currentTick;
        return died >= 0;
    });
    check('edgeville: the Edgeville PKer killed the kitted human at Wilderness level 3', died > 0, `${K.username} cb ${K.combatLevel}, human cb ${human.combatLevel}; ${died}`);
    // (its fight's turn comes every other tick: the kill seen a tick or two later)
    run(3);
    pile1 = piles().find(p => p.human === human)?.id ?? null;
    const pile = piles().find(p => p.id === pile1);
    check('edgeville: a pile noted at the death, with its killer on its sub-task and the vulture enrolled', pile && pile.killer === K && pile.vultures.includes(V) && subTaskOf(K)?.role === 'killer' && subTaskOf(V)?.role === 'vulture', { killer: pile?.killer?.username, vultures: pile?.vultures.map(v => v.username), k: subTaskOf(K)?.name, v: subTaskOf(V)?.name });
    // to the pile's end
    let vTile = null;
    let vBefore = 0;
    run(260, () => {
        if (pile && World.currentTick < pile.revealAt && pile.dropAt !== null) {
            if (subTaskOf(V)?.role === 'vulture' && !V.hasWaypoints() && cheb(V, pile) >= 2) vTile = [V.x, V.z];
            vBefore += events(pile1, 'take').filter(e => e.who === V.username).length;
        }
        return pile && World.currentTick > pile.goneAt + 4;
    });
    const drops = events(pile1, 'drop');
    const takes = events(pile1, 'take');
    const kTakes = takes.filter(e => e.who === K.username);
    const vTakes = takes.filter(e => e.who === V.username);
    const dropAt = pile?.dropAt ?? -1;
    const revealAt = pile?.revealAt ?? -1;
    check('edgeville: the pile is the killer\'s: its items private to it at the drop, revealed 100 ticks on (274)', drops.length >= 8 && drops.every(d => d.hero === K.username) && revealAt - dropAt === 100, `${drops.length} items, heroes ${[...new Set(drops.map(d => d.hero))]}, reveal ${revealAt - dropAt} after the drop at ${dropAt}`);
    // (a full pack: a bite for room first, its 3 ticks and a click each)
    const bitesFirst = events(pile1, 'eat').filter(e => e.who === K.username && kTakes.length && e.t <= kTakes[0].t).length;
    check('edgeville: the killer took stacks before the reveal (LV1), its first a few ticks after the drop (LV2: 3-15, and 10 a bite for room first)', kTakes.length >= 2 && kTakes.every(e => e.early) && kTakes[0].t - dropAt >= 2 && kTakes[0].t - dropAt <= 15 + 10 * bitesFirst, `${kTakes.map(e => `${name(e.item)}x${e.count} +${e.t - dropAt}`).join(', ')}; ${bitesFirst} bites first`);
    const values = kTakes.slice(0, 3).map(e => e.value);
    const top = drops.map(d => d.value).sort((a, b) => b - a).slice(0, 3);
    check('edgeville: its first takes the most valuable stacks, in order', values.length >= 2 && values.every((v, i) => i === 0 || v <= values[i - 1]) && values[0] === top[0], { values, top });
    check('edgeville: nobody but the hero took before the reveal (LV3)', takes.filter(e => e.early && e.who !== K.username).length === 0, takes.filter(e => e.early && e.who !== K.username));
    check('edgeville: the vulture waited on a tile of its own 2-4 off the pile, took nothing before the reveal', vTile !== null && vBefore === 0, { vTile, pile: [pile?.x, pile?.z] });
    check('edgeville: the vulture took a leftover within 8 ticks of the reveal (LV5)', vTakes.length >= 1 && vTakes[0].t - revealAt >= 0 && vTakes[0].t - revealAt <= 8, vTakes.map(e => `${name(e.item)} +${e.t - revealAt}`).join(', '));
    const c = conserved(pile1);
    check('edgeville: every item of the pile taken or gone, once (LV6)', c.ok, c.detail);
    // the killer banks: its take is worth 10k+, so it goes at once (after its sub-task) to the Edgeville booth
    const looted = new Map();
    for (const e of kTakes) looted.set(e.item, (looted.get(e.item) ?? 0) + e.count);
    run(500, () => !Loot.holdsLoot(K));
    const bank = K.getInventory(lib.bankInvId());
    const inBank = [...looted].map(([item, n]) => [name(item), n, bank.getItemCount(item)]);
    check('edgeville: the killer banked its loot at the Edgeville booth: every looted item in its bank, its ledger empty (LV7)', !Loot.holdsLoot(K) && inBank.every(([, n, b]) => b >= n) && Loot.lootLog.some(e => e.kind === 'bank' && e.who === K.username), { inBank, at: [K.x, K.z] });
    run(30);
    const kept = [...looted].every(([item, n]) => bank.getItemCount(item) >= n);
    check('edgeville: its restock after the booth deleted none of it, and it walks out again', kept && subTaskOf(K) === null, { state: sim.botPlayer(K).currentTask?.state });
    void bankBefore;
    // (held, out of the way: walked out to its post by the spot, it killed the next scene's human before that scene's
    // killer could, at seeds 12 and 15)
    hold(K);
    parkAt(K, bots.indexOf(K));
}

// ---- scene 2: a full pack: bites of its own food for room, never a drop ----
{
    scene(SEED, 'full pack');
    Loot.setLootRatesForTest({ trait: () => null });
    humanBack(SPOT[0], SPOT[1]);
    const K2 = edgePkers[1] ?? edgePkers[0];
    clean(K2);
    place(K2, SPOT[0] + 2, SPOT[1] - 1);
    assign(K2, new lib.EdgevillePKerTask());
    run(8);
    // its pack full of its own food
    const inv = K2.getInventory(InvType.INV);
    const food = inv.get([...Array(inv.capacity).keys()].find(s => inv.get(s) && ['shark', 'swordfish'].includes(name(inv.get(s).id))))?.id ?? id('shark');
    for (let s = 0; s < inv.capacity; s++) if (!inv.get(s)) inv.set(s, { id: food, count: 1 });
    matchHuman(K2);
    dressHuman([['rune_med_helm', 1], ['adamant_platelegs', 1], ['coins', 3000]]);
    human.levels[PlayerStat.HITPOINTS] = 6;
    let died = -1;
    run(400, () => {
        if (died < 0 && dying(human)) died = World.currentTick;
        return died >= 0;
    });
    const pile = piles().find(p => p.human === human && p.diedAt >= died - 1);
    let strayDrops = 0;
    const addObj = World.addObj;
    World.addObj = function (obj, receiver64, duration) {
        // (after the pile's drop: anything of its, or anyone's beside it)
        if (pile?.dropAt !== null && World.currentTick > pile.dropAt + 1 && (receiver64 === K2.hash64 || (receiver64 === Obj.NO_RECEIVER && Math.abs(obj.x - K2.x) <= 2 && Math.abs(obj.z - K2.z) <= 2))) strayDrops++;
        return addObj.call(this, obj, receiver64, duration);
    };
    run(60);
    World.addObj = addObj;
    if (DEBUG) {
        const near = [];
        for (const dx of [-8, 0, 8]) for (const dz of [-8, 0, 8]) for (const o of World.gameMap.getZone((pile?.x ?? SPOT[0]) + dx, (pile?.z ?? SPOT[1]) + dz, 0).getAllObjsUnsafe()) if (Math.abs(o.x - (pile?.x ?? 0)) <= 3 && Math.abs(o.z - (pile?.z ?? 0)) <= 3) near.push(`${name(o.type)}@${o.x},${o.z} r${o.receiver64 === Obj.NO_RECEIVER ? '-' : o.receiver64 === K2.hash64 ? 'K2' : o.receiver64 === human.hash64 ? 'H' : '?'} life${o.lifecycleTick}`);
        out(`full pack debug: pile ${pile?.id} at ${pile?.x},${pile?.z} died ${pile?.diedAt} drop ${pile?.dropAt} objs ${pile?.objs.length}; near: ${near.join(' ')}; human pack ${human.getInventory(InvType.INV).freeSlotCount}`);
    }
    const eats = events(pile?.id, 'eat').filter(e => e.who === K2.username);
    const took = events(pile?.id, 'take').filter(e => e.who === K2.username);
    check('full pack: the killer ate for room (1-4 bites) and took the stacks worth 1k+', died > 0 && eats.length >= 1 && eats.length <= 4 && took.some(e => e.value >= 1000), { eats: eats.length, took: took.map(e => `${name(e.item)} ${e.value}`), died, killer: pile?.killer?.username, k2: K2.username, heroes: [...new Set(events(pile?.id, 'drop').map(d => d.hero))], giveup: events(pile?.id, 'giveup').map(e => `${e.who} ${e.role}`) });
    check('full pack: it dropped nothing (no new item of its on the ground)', strayDrops === 0, `${strayDrops}`);
    hold(K2);
}

// ---- scene 3: an NPC's death in Lumbridge: public at once ----
{
    scene(SEED, 'npc death');
    humanBack(3222, 3218);
    const [L1, P, L2, Q] = levelling.filter(p => p !== V).slice(0, 4);
    const friendly = levelling.find(p => p !== V && ![L1, P, L2].includes(p) && lib.personaOf(p.username, p.botPlanner).friendliness > 0.4 && Loot.vultureOf(p.username, p.botPlanner) !== 'looter') ?? Q;
    const traits = new Map([[L1, 'looter'], [P, 'picker'], [L2, 'looter']]);
    Loot.setLootRatesForTest({ trait: p => traits.get(p) ?? null, enrol: 1, polite: 1 });
    const DEATH = [3226, 3221];
    for (const p of [L1, P, L2, friendly]) clean(p);
    sim.teleportHuman(DEATH[0], DEATH[1], 0);
    dressHuman(LOOT_PACK);
    human.heroPoints.clear();
    place(L1, DEATH[0] + 2, DEATH[1]);
    place(P, DEATH[0] - 3, DEATH[1] + 1);
    place(L2, DEATH[0] + 5, DEATH[1] - 3);
    place(friendly, DEATH[0] - 2, DEATH[1] - 3);
    run(2);
    npcDeath();
    run(15, () => dying(human));
    const pile = piles().find(p => p.human === human && World.currentTick - p.diedAt <= 3);
    const enrolled = events(pile?.id, 'enrol').map(e => e.who);
    check('npc death: a pile, at most 2 vultures (the cap), nearest first', pile && !pile.pvp && enrolled.length === 2 && enrolled.includes(L1.username) && enrolled.includes(P.username), { enrolled, pvp: pile?.pvp });
    // the human respawns in Lumbridge's courtyard, within 8 tiles of its items: the polite word; then it walks off
    let polite = null;
    const listen = (p, line, kind, to) => {
        if (to === human && p === friendly) polite = line;
    };
    lib.sayListeners.push(listen);
    const htrace = [];
    run(40, () => {
        if (DEBUG && World.currentTick % 3 === 0) htrace.push(`${World.currentTick} ${human.x},${human.z} hp ${human.levels[PlayerStat.HITPOINTS]} drop ${pile?.dropAt} items ${pile?.objs.filter(o => o.isActive).length}`);
        return polite !== null;
    });
    if (DEBUG) out(`polite trace: ${htrace.join(' | ')}`);
    sim.teleportHuman(3210, 3240, 0);
    run(200, () => pile && World.currentTick > pile.dropAt + 110);
    lib.sayListeners.splice(lib.sayListeners.indexOf(listen), 1);
    const takes = events(pile?.id, 'take');
    const first = who => takes.find(e => e.who === who.username);
    const dropAt = pile?.dropAt ?? 0;
    // (its notice, at most 8 ticks, and 3-10 more, then the click: 21 at most)
    check('npc death: the looter took within 21 ticks of the drop (a moment\'s notice and 3-10 ticks, then the click)', first(L1) && first(L1).t - dropAt <= 21, first(L1) && `+${first(L1).t - dropAt}`);
    check('npc death: the picker waited 60 ticks or more (a minute\'s courtesy)', !first(P) || first(P).t - dropAt >= 60, first(P) && `+${first(P).t - dropAt}`);
    check('npc death: the polite bot and the third looter (past the cap) took nothing', !first(friendly) && !first(L2), takes.map(e => e.who));
    check('npc death: a friendly bot by the items said a word to the human ("ur stuff is still here")', polite !== null, polite ?? { friendly: friendly.username, friendliness: lib.personaOf(friendly.username, friendly.botPlanner).friendliness, trait: Loot.vultureOf(friendly.username, friendly.botPlanner), at: [friendly.x, friendly.z], human: [human.x, human.z], politeStats: Loot.politeStats, lines: Loot.lootLog.filter(e => e.pile === pile?.id && e.kind === 'line').map(e => `${e.who} ${e.role}`) });
    for (const p of [L1, P, L2, friendly]) hold(p);
}

// ---- scene 4: multi-combat north of Varrock: the hero alone before the reveal, its clique mate after it ----
{
    scene(SEED, 'multi');
    const MULTI = [3192, 3543];
    const M = levelling.find(p => p !== V && !subTaskOf(p)) ?? levelling[1];
    lib.setCliquesForTest([[K.username, M.username]]);
    Loot.setLootRatesForTest({ trait: p => (p === M ? 'looter' : null), enrol: 1 });
    humanBack(MULTI[0], MULTI[1]);
    clean(K, false);
    clean(M);
    place(K, MULTI[0] + 2, MULTI[1] - 1);
    place(M, MULTI[0] - 3, MULTI[1] + 2);
    assign(K, new lib.EdgevillePKerTask());
    run(8);
    matchHuman(K);
    dressHuman(LOOT_PACK);
    human.levels[PlayerStat.HITPOINTS] = 6;
    check('multi: the spot is multi-combat Wilderness', lib.isMultiCombat(MULTI[0], MULTI[1], 0) && lib.wildernessLevelAt(MULTI[0], MULTI[1]) >= 3, lib.wildernessLevelAt(MULTI[0], MULTI[1]));
    // (out here its post is the edge, 90 tiles west: the human attacks it, and it fights back)
    lib.interactPlayerOp(human, K.slot, 2);
    let died = -1;
    const trace4 = [];
    run(400, () => {
        if (died < 0 && dying(human)) died = World.currentTick;
        if (DEBUG && World.currentTick % 20 === 0) trace4.push(`${World.currentTick} K ${K.x},${K.z} ${sim.botPlayer(K).currentTask?.state} t ${sim.botPlayer(K).currentTask?.target?.username} hum ${human.x},${human.z} hp ${human.levels[PlayerStat.HITPOINTS]} cb ${human.combatLevel}/${K.combatLevel}`);
        return died >= 0;
    });
    if (DEBUG) out(trace4.join('\n'));
    const pile = piles().find(p => p.human === human && p.diedAt >= died - 1);
    run(260, () => pile && World.currentTick > pile.goneAt + 4);
    const takes = events(pile?.id, 'take');
    const enrol = events(pile?.id, 'enrol').filter(e => e.who === M.username);
    const mTakes = takes.filter(e => e.who === M.username);
    check('multi: only the hero took before the reveal', died > 0 && takes.some(e => e.who === K.username && e.early) && takes.filter(e => e.early && e.who !== K.username).length === 0, takes.map(e => `${e.who} ${e.early ? 'early' : ''}`));
    check('multi: its clique mate enrolled at the reveal (not before), took leftovers after it', enrol.length === 1 && enrol[0].t >= (pile?.revealAt ?? Infinity) && enrol[0].mate === true && mTakes.length >= 1 && mTakes.every(e => !e.early), { enrol, mTakes: mTakes.map(e => `${name(e.item)} +${e.t - pile?.revealAt}`) });
    const c = conserved(pile?.id);
    check('multi: every item of the pile taken or gone, once', c.ok, c.detail);
    lib.setCliquesForTest(null);
    // (the killer banks what it took before the next scene)
    run(500, () => !Loot.holdsLoot(K));
    check('multi: the killer banked its take', !Loot.holdsLoot(K), [...Loot.ledgerOf(K.username)]);
    hold(K);
    hold(M);
}

// ---- scene 6: the Duel Arena: no pile ----
{
    scene(SEED, 'arena');
    humanBack(3360, 3240);
    Loot.setLootRatesForTest({ trait: () => 'looter', enrol: 1 });
    const near = levelling.slice(0, 2);
    for (const p of near) {
        clean(p);
        place(p, 3362, 3241);
    }
    dressHuman([['coins', 100]]);
    const before = Loot.lootLog.length;
    run(2);
    npcDeath();
    run(20);
    check('arena: a death at the Duel Arena: no pile, nobody enrols', Loot.lootLog.slice(before).filter(e => e.kind === 'death' || e.kind === 'enrol').length === 0, Loot.lootLog.slice(before).map(e => e.kind));
    for (const p of near) hold(p);
}

// ---- scene 5: a PKer killed carrying the human's items: kept, banked after its respawn; saved with the world ----
{
    scene(SEED, 'death');
    Loot.setLootRatesForTest({ trait: () => null });
    humanBack(3222, 3230);
    const K3 = edgePkers[2] ?? edgePkers[0];
    clean(K3);
    place(K3, 3093, 3530);
    assign(K3, new lib.EdgevillePKerTask());
    run(10);
    const inv = K3.getInventory(InvType.INV);
    const scim = id('rune_scimitar');
    // (the human's items: a rune scimitar and coins, as a take puts them in its pack and ledger)
    for (let s = inv.capacity - 1; s >= inv.capacity - 2; s--) inv.set(s, null);
    inv.add(scim, 1);
    inv.add(id('coins'), 4000);
    Loot.addToLedgerForTest(K3, scim, 1);
    Loot.addToLedgerForTest(K3, id('coins'), 4000);
    const saved = BotManager.exportWorld()?.loot?.[K3.username] ?? null;
    check('death: the ledger is in the saved world (BotWorldState.loot)', Array.isArray(saved) && saved.some(([i, n]) => i === scim && n === 1), saved);
    // (held: 'busy' for its ledger, or 'fight' first while it is in combat; the ledger's hold without the fight checked
    // apart from the other holds: none but it)
    const hold0 = BotManager._busy(K3, World.currentTick);
    const until = K3.preventLogoutUntil;
    K3.preventLogoutUntil = -1;
    const holdLoot = BotManager._busy(K3, World.currentTick);
    K3.preventLogoutUntil = until;
    check('death: a PKer holding the human\'s items is held from logging out (BotManager._busy: its ledger)', hold0 !== null && holdLoot === 'busy', { hold0, holdLoot });
    // killed (the game's damage script): patch 0003 keeps its items
    const script = lib.ScriptProvider.getByName('[queue,damage_player]');
    K3.enqueueScript(script, lib.PlayerQueueType.NORMAL, 0, [K3.levels[PlayerStat.HITPOINTS]]);
    run(20, () => dying(K3));
    run(20, () => !dying(K3));
    check('death: it kept the human\'s items (0003) and its ledger', inv.getItemCount(scim) >= 1 && Loot.holdsLoot(K3), { scim: inv.getItemCount(scim), at: [K3.x, K3.z] });
    let wentOut = false;
    const trace = [];
    run(900, () => {
        if (Loot.holdsLoot(K3) && K3.z >= 3520) wentOut = true;
        if (DEBUG && World.currentTick % 50 === 0) trace.push(`${World.currentTick} ${K3.x},${K3.z} ${sim.botPlayer(K3).currentTask?.name}/${sim.botPlayer(K3).currentTask?.state} sub ${subTaskOf(K3)?.name}`);
        return !Loot.holdsLoot(K3);
    });
    if (DEBUG) out(trace.join('\n'));
    const bank = K3.getInventory(lib.bankInvId());
    check('death: after its respawn it banked them at the Edgeville booth before walking out', !Loot.holdsLoot(K3) && !wentOut && bank.getItemCount(scim) >= 1 && bank.getItemCount(id('coins')) >= 4000, { left: [...Loot.ledgerOf(K3.username)], at: [K3.x, K3.z], bank: bank.getItemCount(scim) });
    // a restart: the saved ledger comes back as it was
    const world = { [K3.username]: [[scim, 1], [id('coins'), 4000]] };
    Loot.restoreLoot(JSON.parse(JSON.stringify(world)));
    check('death: a restored ledger is the saved one (a forced logout before the bank loses nothing)', Loot.ledgerOf(K3.username).get(scim) === 1 && Loot.ledgerOf(K3.username).get(id('coins')) === 4000, [...Loot.ledgerOf(K3.username)]);
    hold(K3);
}

// ---- (B4) the Chaos Temple: a deep PKer's zone (the yard, multi-combat), reached on foot, picked at a zone change ----
const deepPkers = bots.filter(p => p.botPlanner === 'extras_pker');
{
    scene(SEED, 'temple');
    Loot.setLootRatesForTest({ trait: () => null });
    const D = deepPkers[0];
    const TEMPLE = [2947, 3820];
    check('temple: the yard is walkable, multi-combat, Wilderness level 38', sim.isWalkable(2952, 3822, 0) && lib.isMultiCombat(2952, 3822, 0) && lib.wildernessLevelAt(2952, 3822) >= 37, lib.wildernessLevelAt(2952, 3822));
    clean(D);
    place(D, 3050, 3790);
    const task = new lib.PKerTask();
    assign(D, task);
    run(6);
    task.zonePoolIdx = 11;
    task.zoneChosen = true;
    task.state = 'walk';
    task.zoneTicks = 0;
    let near = -1;
    run(400, () => {
        if (near < 0 && cheb(D, { x: TEMPLE[0], z: TEMPLE[1] }) <= 20) near = World.currentTick;
        return near >= 0;
    });
    check('temple: a deep PKer of its zone walks there and patrols by the temple', near > 0, { at: [D.x, D.z], state: task.state });
    // a zone change picks it at one zone's weight (0 of 1,000 picks from zone 8 before: never among anyone's two nearest)
    let picks = 0;
    for (let i = 0; i < 1200; i++) if (task._neighbourZone(8) === 11) picks++;
    check('temple: a zone change picks it about one time in 28 (half a zone\'s picks, twice its stay: one zone\'s time)', picks >= 20 && picks <= 75, `${picks} of 1200`);
    hold(D);
}

// ---- (A8) the lever camps: the west Lava Maze ladder and the Demonic Ruins; a passing bosser, 1 in 3 ----
{
    scene(SEED, 'camps');
    Loot.setLootRatesForTest({ trait: () => null });
    const LADDER = [3017, 3846];
    const RUINS = [3287, 3880];
    check('camps: both camps walkable deep Wilderness (the ladder 42, the ruins 45)', sim.isWalkable(...LADDER, 0) && sim.isWalkable(...RUINS, 0) && lib.wildernessLevelAt(...LADDER) >= 40 && lib.wildernessLevelAt(...RUINS) >= 44, [lib.wildernessLevelAt(...LADDER), lib.wildernessLevelAt(...RUINS)]);
    // 1 in 3 of the bossers who pass, decided once a pass
    const fakes = Array.from({ length: 600 }, () => ({ x: LADDER[0], z: LADDER[1] }));
    for (const f of fakes) lib.setRole(f, 'bosser');
    const yes = fakes.filter(f => lib.campMayAttack(f, LADDER)).length;
    const again = fakes.every(f => lib.campMayAttack(f, LADDER) === lib.campMayAttack(f, LADDER));
    for (const f of fakes) lib.clearRole(f);
    check('camps: the campers go for about 1 in 3 of the bossers who pass, the same answer through a pass', yes >= 160 && yes <= 240 && again, `${yes} of 600`);
    // a camper at the ladder: a passing bosser attacked (the pass drawn yes), a bot that is no bosser never
    const C = deepPkers[1] ?? deepPkers[0];
    const [B1, B2] = levelling.filter(p => !subTaskOf(p)).slice(-2);
    for (const p of [C, B1, B2]) clean(p);
    place(C, LADDER[0] + 2, LADDER[1] - 2);
    const task = new lib.PKerTask();
    assign(C, task);
    run(6);
    task.zonePoolIdx = 12;
    task.zoneChosen = true;
    task.state = 'walk';
    lib.setCampRateForTest(1);
    // (a bosser is a veteran: within the camper's combat range at level 42; the other bot too, so only its role differs)
    for (const b of [B1, B2]) {
        for (let stat = 0; stat < C.baseLevels.length; stat++) if (C.baseLevels[stat] > 1) b.setLevel(stat, C.baseLevels[stat]);
        b.combatLevel = b.getCombatLevel();
    }
    lib.setRole(B1, 'bosser');
    place(B1, LADDER[0] - 3, LADDER[1] + 1);
    place(B2, LADDER[0] + 4, LADDER[1] + 3);
    let onB1 = -1;
    let onB2 = false;
    run(150, () => {
        if (task.target === B2) onB2 = true;
        if (onB1 < 0 && task.target === B1) onB1 = World.currentTick;
        return onB1 >= 0;
    });
    let attacked = false;
    run(10, () => (attacked = sim.attackTarget(C) === B1));
    check('camps: a camper at the KBD ladder goes for a passing bosser (the game\'s attack on it); never a bot that is no bosser', onB1 > 0 && !onB2 && attacked, { onB1, target: task.target?.username, state: task.state });
    lib.setCampRateForTest(0);
    lib.clearRole(B1);
    for (const p of [C, B1, B2]) {
        hold(p);
        p.levels[PlayerStat.HITPOINTS] = p.baseLevels[PlayerStat.HITPOINTS];
    }
    lib.setCampRateForTest(null);
}

// ---- (A6) the wine crowd at the Asgarnian Chaos Temple: grabbers on their own tiles, the race, the rivalry ----
{
    scene(SEED, 'wine');
    Loot.setLootRatesForTest({ trait: () => null });
    const MR = lib.MagicRuns;
    check('wine: the crowd\'s number clamp(round(N/120), 1, 5): 1 at 100, 2 at 250, 4 at 500, 5 at 1000', [100, 250, 500, 1000].map(MR.wineCrowdTarget).join() === '1,2,4,5', [100, 250, 500, 1000].map(MR.wineCrowdTarget));
    MR.setWineRatesForTest({ offer: 1, lost: 1, won: 1 });
    const grabbers = levelling.filter(p => !subTaskOf(p)).slice(0, 3);
    const I = lib.Items;
    for (const p of grabbers) {
        clean(p);
        for (const [stat, lvl] of [[PlayerStat.MAGIC, 45], [PlayerStat.ATTACK, 30], [PlayerStat.STRENGTH, 30], [PlayerStat.DEFENCE, 30], [PlayerStat.HITPOINTS, 30]]) p.setLevel(stat, lvl);
        p.combatLevel = p.getCombatLevel();
        const bank = p.getInventory(lib.bankInvId());
        bank.add(I.LAW_RUNE, 30);
        bank.add(I.AIR_RUNE, 30);
        place(p, 2946, 3368);
    }
    // the offer: a bot that may grab gets a stint while the crowd (1 at 24 online) is short; then none
    const first = MR.magicRunFor(grabbers[0], 1);
    check('wine: a bot that may grab is offered a stint while the crowd is short (whatever the run share\'s roll)', first?.name.startsWith('Telegrab:'), first?.name);
    for (const p of grabbers) assign(p, MR.magicRunTask('telegrab'));
    const wine0 = Object.fromEntries(grabbers.map(p => [p.username, 0]));
    const lines = [];
    const listen = (p, line, kind) => {
        if (grabbers.includes(p) && kind !== 'trade') lines.push({ t: World.currentTick, who: p.username, line });
    };
    lib.sayListeners.push(listen);
    const log0 = MR.wineLog.length;
    const log0Tick = World.currentTick;
    let together = 0;
    let stacked = 0;
    // (round 1's left-overs: T1, T2) each grab's click: how long after the wine came back, each grabber's clicks, and
    // where it stood (its own tile)
    const grabs = wineGrabWatch(grabbers);
    const watch = () => {
        const inside = grabbers.filter(p => cheb(p, { x: 2934, z: 3516 }) <= 6 && !p.hasWaypoints());
        if (inside.length >= 2) together++;
        if (inside.some((a, i) => inside.some((b, j) => j > i && a.x === b.x && a.z === b.z))) stacked++;
        grabs.tick();
    };
    run(1100, () => {
        watch();
        return false;
    });
    // (and on to the wine back on the table: a grab's outcome is read at the grabber's next turn after the spell's hold,
    // up to 20 ticks after its cast, and the respawn is 48; the merge's seed 11 stopped between a grab landed and its
    // reading, 18 wines owned and 17 grabs won)
    run(80, () => {
        watch();
        return wineOnTable() !== null;
    });
    lib.sayListeners.splice(lib.sayListeners.indexOf(listen), 1);
    const owned = p => p.getInventory(InvType.INV).getItemCount(id('wine_of_zamorak')) + p.getInventory(lib.bankInvId()).getItemCount(id('wine_of_zamorak'));
    const wines = grabbers.reduce((n, p) => n + owned(p) - wine0[p.username], 0);
    const log = MR.wineLog.slice(log0);
    const won = log.filter(e => e.outcome === 'won').length;
    const lost = log.filter(e => e.outcome === 'lost').length;
    check('wine: two or more grabbers in the temple together, each on a tile of its own', together >= 100 && stacked <= together * 0.05, { together, stacked });
    check('wine: each wine to one of them (the race is the game\'s: the grabs that landed are the wines owned; a lost one, "Too late", when two cast at once)', won >= 3 && wines === won, { won, wines, lost });
    const wineLines = Loot.lootLog.filter(e => e.kind === 'line' && (e.role === 'wine-lost' || e.role === 'wine-won') && e.t >= log0Tick);
    const lostWords = wineLines.filter(e => e.role === 'wine-lost');
    const spaced = lostWords.every((e, i) => lostWords.slice(0, i).every(f => f.who !== e.who || e.t - f.t >= 300));
    check('wine: a lost grab gets a word and the winner answers (with their chances at 1); at most one lost word a bot in 3 minutes', (lost === 0 || (lostWords.length >= 1 && wineLines.some(e => e.role === 'wine-won'))) && spaced, { lost, words: wineLines.map(e => `${e.t} ${e.who} ${e.role}`) });
    // (round 1's left-overs: T1) a person's moment after the wine is back, not a poll's: a 5-tick look clicked within 5
    // ticks of it, every time (42897d7: 0 of 53 later); the clicks now spread past it, and every click from the grabber's
    // own tile (none from its way to it, T2). The race's first click is the quickest of three draws, so its spread is
    // narrower than one grabber's (6-9 values over 25-30 grabs). Two grabs in a row the same apart (the humanlike
    // report's H18) are the draw's check below: three racing grabbers make few such pairs here (2-8: one alike is up to
    // 50 %), so `same` is the detail only
    const g1 = grabs.result();
    const quick = g1.delays.filter(d => d < 60);
    const late = quick.filter(d => d > 5).length;
    check('wine: each grab clicked a person\'s moment after the wine came back (T1): its delays over 6+ values, a fifth of them past 5 ticks, median 3+, none off its tile', quick.length >= 15 && g1.distinct >= 6 && late >= quick.length / 5 && g1.median >= 3 && g1.offTile === 0, { ...g1, late });
    // the draw itself (each grabber's persona; 4,000 draws a grabber): two in a row alike at most 8 % (the world's H18 is
    // this, the respawn being the game's), a median of 4-10 ticks, a tail (a look away, a slip). (400 draws a grabber
    // failed at seeds 7, 9, 11, 12 and 17, a grabber at 8.0-8.8 %: the quickest personas' draw is 6.3 % alike (a million
    // draws; 'next' floored at a reaction of 1), and 399 pairs read it ± 1.2 %, 8 %+ for one grabber in ten; 3,999 pairs,
    // ± 0.4 %.) On dice of their own, put back after: the air staff's stint below draws the same whatever their number
    const dice = Math.random;
    scene(SEED, 'wine draw');
    const draws = grabbers.map(p => Array.from({ length: 4000 }, () => MR.wineReactionForTest?.(p) ?? 0));
    Math.random = dice;
    const alike = draws.map(xs => xs.slice(1).filter((x, i) => x === xs[i]).length / (xs.length - 1));
    const sorted = draws.flat().sort((a, b) => a - b);
    check('wine: the grab\'s reaction draw: two in a row alike at most 8 % for each grabber, median 4-10 ticks, a tenth 15+ (T1)', alike.every(a => a <= 0.08) && sorted[sorted.length >> 1] >= 4 && sorted[sorted.length >> 1] <= 10 && sorted[Math.floor(sorted.length * 0.9)] >= 15, { alike: alike.map(a => Math.round(a * 1000) / 10), median: sorted[sorted.length >> 1], p90: sorted[Math.floor(sorted.length * 0.9)] });
    MR.setWineRatesForTest(null);
    for (const p of grabbers) hold(p);
    // a grabber with an air staff in its bank and no air runes: the staff wielded for its 5 grabs, its scimitar again
    // after (a fighter left with the staff in hand and its scimitar banked: fixes.test's sewers fighter, seed 3)
    const g = levelling.find(p => !subTaskOf(p) && !grabbers.includes(p));
    clean(g);
    for (const [stat, lvl] of [[PlayerStat.MAGIC, 45], [PlayerStat.ATTACK, 30], [PlayerStat.STRENGTH, 30], [PlayerStat.DEFENCE, 30], [PlayerStat.HITPOINTS, 30]]) g.setLevel(stat, lvl);
    g.combatLevel = g.getCombatLevel();
    const gBank = g.getInventory(lib.bankInvId());
    gBank.add(I.LAW_RUNE, 5);
    gBank.add(I.STAFF_OF_AIR, 1);
    const gWorn = g.getInventory(InvType.WORN);
    const gHeld = gWorn.get(3)?.id ?? -1;
    gWorn.set(3, { id: I.IRON_SCIMITAR, count: 1 });
    lib.refreshWorn(g, gHeld);
    place(g, 2946, 3368);
    const gTask = MR.magicRunTask('telegrab');
    assign(g, gTask);
    let staffed = false;
    const gWines = gBank.getItemCount(id('wine_of_zamorak'));
    const gDone = run(4000, () => {
        if (gWorn.get(3)?.id === I.STAFF_OF_AIR) staffed = true;
        return gTask.isComplete(g);
    });
    check('wine: a grabber with an air staff banked and no air runes wields it for the stint; after it, its scimitar in hand again and the staff banked with the wine', gDone > 0 && staffed && gWorn.get(3)?.id === I.IRON_SCIMITAR && gBank.getItemCount(I.STAFF_OF_AIR) === 1 && gBank.getItemCount(id('wine_of_zamorak')) > gWines, { done: gDone, staffed, held: gWorn.get(3)?.id ?? -1, staffBanked: gBank.getItemCount(I.STAFF_OF_AIR), wines: gBank.getItemCount(id('wine_of_zamorak')) - gWines });
    hold(g);
}

// (round 1's left-overs: T2) a grabber's way out after a stint long enough for the temple's door to shut behind it (274
// shuts it 500 ticks after it was opened): it opens the door from inside and walks out to the bank, no rescue jump; its
// grabs from its own tile only
{
    scene(SEED, 'wine exit');
    Loot.setLootRatesForTest({ trait: () => null });
    const MR = lib.MagicRuns;
    const I = lib.Items;
    sim.teleportHuman(3222, 3218, 0);
    const g = levelling.filter(p => !subTaskOf(p) && p !== levelling[0]).slice(-2)[0];
    clean(g);
    for (const [stat, lvl] of [[PlayerStat.MAGIC, 45], [PlayerStat.ATTACK, 30], [PlayerStat.STRENGTH, 30], [PlayerStat.DEFENCE, 30], [PlayerStat.HITPOINTS, 30]]) g.setLevel(stat, lvl);
    g.combatLevel = g.getCombatLevel();
    const bank = g.getInventory(lib.bankInvId());
    bank.add(I.LAW_RUNE, 12);
    bank.add(I.AIR_RUNE, 12);
    place(g, 2946, 3368);
    const task = MR.magicRunTask('telegrab');
    assign(g, task);
    const jumps0 = lib.teleportStats.jumps;
    const grabs = wineGrabWatch([g]);
    // (the door when its grab step ended; opened while it stood on the temple's floor; a move of more than 2 tiles a tick)
    let shutAtEnd = null;
    let state = task.state;
    let leap = 0;
    let last = { x: g.x, z: g.z, level: g.level };
    let openedInside = 0;
    let wasShut = templeDoorShut();
    const done = run(5000, () => {
        grabs.tick();
        if (state === 'telegrab' && task.state !== 'telegrab' && shutAtEnd === null) shutAtEnd = templeDoorShut();
        state = task.state;
        const shut = templeDoorShut();
        if (wasShut && !shut && templeFloor(g)) openedInside++;
        wasShut = shut;
        if (g.level !== last.level || cheb(g, last) > 2) leap++;
        last = { x: g.x, z: g.z, level: g.level };
        return task.isComplete(g);
    });
    const r = grabs.result();
    const atBank = cheb(g, { x: 2946, z: 3368 }) <= 6;
    check('wine exit: after a stint the door shut behind it opened from inside, the grabber out of the temple and at the bank, no rescue jump and no leap (T2)', done > 0 && task.outcome === 'done' && r.delays.length >= 8 && shutAtEnd === true && openedInside >= 1 && atBank && lib.teleportStats.jumps === jumps0 && leap === 0 && r.offTile === 0, { done, outcome: task.outcome, grabs: r.delays.length, shutAtEnd, openedInside, atBank, at: [g.x, g.z], jumps: lib.teleportStats.jumps - jumps0, leap, offTile: r.offTile, wines: bank.getItemCount(id('wine_of_zamorak')) });
    hold(g);
}

// (round 1's left-overs: T2) a grab's tile out of the table's sight (the temple's east end, behind its altar): a grabber
// whose tile was one cast "I can't reach that!" a whole stint (40 casts, no wine, the m100 probe run); its tile now is
// one the grab reaches the table from (the engine's own approach: in sight, within 10), and it grabs
{
    scene(SEED, 'wine sight');
    Loot.setLootRatesForTest({ trait: () => null });
    const MR = lib.MagicRuns;
    const I = lib.Items;
    const sees = (x, z) => Math.max(Math.abs(x - WINE_AT[0]), Math.abs(z - WINE_AT[1])) <= 10 && lib.isApproached(0, x, z, WINE_AT[0], WINE_AT[1], 1, 1, 1, 1);
    const blind = [...TEMPLE_FLOOR].map(k => k.split(',').map(Number)).filter(([x, z]) => Math.max(Math.abs(x - 2934), Math.abs(z - 3516)) <= 6 && !sees(x, z));
    const g = levelling.filter(p => !subTaskOf(p) && p !== levelling[0]).slice(-3)[0];
    clean(g);
    for (const [stat, lvl] of [[PlayerStat.MAGIC, 45], [PlayerStat.ATTACK, 30], [PlayerStat.STRENGTH, 30], [PlayerStat.DEFENCE, 30], [PlayerStat.HITPOINTS, 30]]) g.setLevel(stat, lvl);
    g.combatLevel = g.getCombatLevel();
    const bank = g.getInventory(lib.bankInvId());
    bank.add(I.LAW_RUNE, 6);
    bank.add(I.AIR_RUNE, 6);
    place(g, 2946, 3368);
    const task = MR.magicRunTask('telegrab');
    assign(g, task);
    let unreached = 0;
    const mes = g.messageGame;
    g.messageGame = function (text) {
        if (typeof text === 'string' && /can't reach/i.test(text)) unreached++;
        return mes.call(this, text);
    };
    const grabs = wineGrabWatch([g]);
    let staged = null;
    let tiles = [];
    const done = run(4000, () => {
        // (as it walks in: a claim of one of the blind tiles, as a grab's tile could be before)
        if (!staged && blind.length && task.state === 'in the temple' && templeFloor(g)) {
            staged = blind[0];
            lib.claimStandTile(g, staged[0], staged[1], 0, 0, (x, z) => x === staged[0] && z === staged[1]);
        }
        const st = lib.standTileOf(g);
        if (st && task.state === 'telegrab' && !tiles.some(t => t[0] === st[0] && t[1] === st[1])) tiles.push([st[0], st[1]]);
        grabs.tick();
        return task.isComplete(g);
    });
    g.messageGame = mes;
    const r = grabs.result();
    const wines = bank.getItemCount(id('wine_of_zamorak'));
    check('wine sight: a grab\'s tile is one in sight of the table (a claimed tile out of its sight, behind the altar, given up): no "I can\'t reach that!", its wines grabbed (T2)', blind.length > 0 && staged !== null && done > 0 && unreached === 0 && tiles.length > 0 && tiles.every(([x, z]) => sees(x, z)) && wines >= 3, { blind: blind.map(t => t.join(',')).join(' '), staged, done, outcome: task.outcome, unreached, tiles, wines, grabs: r.delays.length });
    hold(g);
}

// ---- (A7) safespots at the Edgeville dungeon's hill giants ----
{
    scene(SEED, 'safespots');
    Loot.setLootRatesForTest({ trait: () => null });
    const SS = lib.Safespots;
    const step = lib.SkillProgression.RANGED.find(s => s.location === lib.Locations.HILL_GIANTS_EDGEVILLE);
    const tiles = SS.safespotTiles();
    check('safespots: 3 tiles at the Edgeville dungeon\'s hill giants (the probe\'s sweep), the giants\' ranged and magic steps theirs', tiles.length === 3 && SS.safespotOf(step)?.key === 'edgeville-hill-giants' && SS.safespotOf(lib.SkillProgression.MAGIC.find(s => s.location === lib.Locations.HILL_GIANTS_EDGEVILLE))?.key === 'edgeville-hill-giants', tiles.length);
    // each tile: a ranger on it shoots its giant (kept alive, chasing it) 100 ticks: never moved off, never hit
    const R = levelling.filter(p => !subTaskOf(p))[0];
    const I = lib.Items;
    const bow = (p, arrows = 2000) => {
        const worn = p.getInventory(InvType.WORN);
        const previous = worn.get(3)?.id ?? -1;
        worn.set(3, { id: I.OAK_SHORTBOW, count: 1 });
        worn.set(13, { id: id('iron_arrow'), count: arrows });
        lib.refreshWorn(p, previous);
    };
    clean(R);
    for (const [stat, lvl] of [[PlayerStat.RANGED, 45], [PlayerStat.HITPOINTS, 60], [PlayerStat.DEFENCE, 30]]) R.setLevel(stat, lvl);
    const spot = SS.safespotOf(step);
    const bad = [];
    let tries = 0;
    const hitTries = [];
    const notesSafe = [];
    const homeGiants = () => {
        for (const t of spot.tiles) for (const [hx, hz] of t.giants) {
            const g = SS.giantOf(hx, hz, 0);
            if (!g) continue;
            g.resetDefaults?.();
            g.teleJump(hx, hz, 0);
        }
    };
    for (const tile of spot.tiles) {
        for (const [gx, gz] of tile.giants) {
            const giant = SS.giantOf(gx, gz, 0);
            if (!giant) {
                bad.push(`${tile.at}: no giant`);
                continue;
            }
            // up to 3 tries, each from a start in the giant's wander from which the tile shoots it (the scene's dice); a try
            // counts when the shots landed and the giant chased the ranger
            let counted = 0;
            for (let attempt = 0; attempt < 3 && counted === 0; attempt++) {
                homeGiants();
                bow(R);
                R.clearPendingAction();
                R.clearWaypoints();
                place(R, ...tile.at, 0);
                // (the ranger's AI off: a monster on a bot whose task is not a fight sets it running, port/BotDefence)
                sim.botPlayer(R).tick = () => {};
                run(1);
                let spotG = [gx, gz];
                for (let tries = 0; tries < 30; tries++) {
                    const tx = gx + Math.floor(Math.random() * 7) - 3;
                    const tz = gz + Math.floor(Math.random() * 7) - 3;
                    if (!sim.isWalkable(tx, tz, 0) || (tx === tile.at[0] && tz === tile.at[1])) continue;
                    giant.teleJump(tx, tz, 0);
                    run(1);
                    if (SS.inShot(R, giant)) {
                        spotG = [tx, tz];
                        break;
                    }
                }
                let hits = 0;
                let moved = 0;
                let chased = 0;
                const xp0 = R.stats[PlayerStat.RANGED];
                const dbg = [];
                for (let t = 0; t < 100; t++) {
                    if (DEBUG && t < 8) dbg.push(`t${t} R ${R.x},${R.z} g ${giant.x},${giant.z} shot ${SS.inShot(R, giant)} tgt ${R.target ? 'npc' : '-'} wp ${R.hasWaypoints()} w ${R.getInventory(InvType.WORN).get(3)?.id}/${R.getInventory(InvType.WORN).get(13)?.id}x${R.getInventory(InvType.WORN).get(13)?.count}`);
                    // (as the task does: off its tile, back to it; on it, the giant out of its shot, the attack stopped
                    // (safespotGuard); in it, shot)
                    if (R.x !== tile.at[0] || R.z !== tile.at[1]) {
                        if (R.target) R.clearPendingAction();
                        if (!R.hasWaypoints()) lib.walkTo(R, tile.at[0], tile.at[1]);
                    } else if (!SS.inShot(R, giant)) {
                        R.clearPendingAction();
                        R.clearWaypoints();
                    } else if (!R.target) lib.interactNpcOp(R, giant, 2);
                    giant.levels[PlayerStat.HITPOINTS] = Math.max(giant.levels[PlayerStat.HITPOINTS], 60);
                    const hp = R.levels[PlayerStat.HITPOINTS];
                    run(1);
                    if (R.levels[PlayerStat.HITPOINTS] < hp) hits++;
                    R.levels[PlayerStat.HITPOINTS] = R.baseLevels[PlayerStat.HITPOINTS];
                    if (R.x !== tile.at[0] || R.z !== tile.at[1]) moved++;
                    if (giant.target === R) chased++;
                }
                R.clearPendingAction();
                delete sim.botPlayer(R).tick;
                tries++;
                if (hits > 0) hitTries.push(`${tile.at} from ${spotG}: ${hits} hits, ${moved} ticks off it${DEBUG ? ' ' + dbg.join(' | ') : ''}`);
                // (a try counts when the shots landed and the giant chased it; on the tile at most of its ticks: the engine's
                // approach can step a ranger a tile or two toward a giant at its first shot from some of its places, and the
                // task walks it back)
                if (chased >= 30 && R.stats[PlayerStat.RANGED] > xp0) {
                    counted++;
                    if (moved > 20) bad.push(`${tile.at} giant ${gx},${gz} from ${spotG}: ${moved} of 100 ticks off its tile`);
                }
            }
            if (counted === 0) bad.push(`${tile.at} giant ${gx},${gz}: never shot and chased in 3 tries`);
        }
    }
    notesSafe.push(`hit in ${hitTries.length} of ${tries} tries${hitTries.length ? ': ' + hitTries.join('; ') : ''}`);
    homeGiants();
    run(5);
    check('safespots: from each tile a ranger shoots its giant (kept alive, chasing it) 100 ticks, the shot stopped while the giant is out of it as the task does, on its tile 80 %+ of the ticks; its hits reported', bad.length === 0, bad.length ? bad : notesSafe.join(' '));
    // a ranger's own task at the giants: a free tile claimed, walked onto, held; its shots from there
    const others = levelling.filter(p => p !== R && !subTaskOf(p)).slice(0, 8);
    clean(R);
    bow(R);
    R.setLevel(PlayerStat.RANGED, 45);
    place(R, 3112, 9840, 0);
    const task = new lib.RangedMagicTask(step, PlayerStat.RANGED);
    assign(R, task);
    sim.botPlayer(R).planner.pickTask = () => task;
    let onTile = 0;
    let samples = 0;
    const xp0 = R.stats[PlayerStat.RANGED];
    const offTrace = [];
    run(500, () => {
        const held = SS.safespotHeld(R);
        if (World.currentTick % 5 === 0 && held) {
            samples++;
            if (R.x === held[0] && R.z === held[1]) onTile++;
            else if (DEBUG) offTrace.push(`${World.currentTick} ${R.x},${R.z} ${task.state} hp ${R.levels[PlayerStat.HITPOINTS]} wp ${R.hasWaypoints()} t ${R.target?.constructor?.name}`);
        }
        return false;
    });
    if (DEBUG) out(offTrace.join('\n'));
    // (while it holds it: a tile whose giant it has had nothing of for 3 minutes is given up, before a long idle stand)
    check('safespots: a ranger at the giants claims a tile, stands on it most of the time it holds it (EG8: 70 %+), and its shots land', samples >= 30 && onTile / samples >= 0.7 && R.stats[PlayerStat.RANGED] > xp0, { samples, onTile, xp: R.stats[PlayerStat.RANGED] - xp0, held: SS.safespotHeld(R) });
    // every tile taken (7 held bots on the others): a newcomer asks the nearest, who answers; then it waits its turn
    const mine = SS.safespotHeld(R);
    // (the ranger held on its tile too, as the others: every tile taken however long the newcomer's wait; on its own it
    // gives a tile up whose giant it has not shot for 3 minutes)
    if (mine) {
        hold(R);
        place(R, ...mine, 0);
    }
    const held = others.slice(0, spot.tiles.length - (mine ? 1 : 0));
    let k = 0;
    for (const tile of spot.tiles) {
        if (mine && tile.at[0] === mine[0] && tile.at[1] === mine[1]) continue;
        const p = held[k++];
        clean(p);
        place(p, ...tile.at, 0);
    }
    run(2);
    for (const p of held) SS.safespotTurn(p, step, () => false);
    const N2 = others[7];
    clean(N2);
    bow(N2);
    N2.setLevel(PlayerStat.RANGED, 45);
    place(N2, 3110, 9838, 0);
    SS.setSafespotRatesForTest({ choice: 'ask', answer: 1 });
    const said = [];
    const listen = (p, line, kind, to) => {
        if (p === N2 || held.includes(p) || p === R) said.push({ who: p.username, line, to: to?.username });
    };
    lib.sayListeners.push(listen);
    const stats0 = { ...SS.safespotStats };
    const task2 = new lib.RangedMagicTask(step, PlayerStat.RANGED);
    assign(N2, task2);
    sim.botPlayer(N2).planner.pickTask = () => task2;
    // (its 120 ticks, and on to the answer, within the wait's 3 minutes: an ask not said at its look (a practice, a line
    // it typed) is said later in the wait (port/BotSafespots safespotAskDue), its answer typed after it; seed 1's came
    // after the 120)
    const t2 = World.currentTick;
    run(340, () => World.currentTick - t2 >= 120 && said.some(l => l.to === N2.username));
    lib.sayListeners.splice(lib.sayListeners.indexOf(listen), 1);
    check('safespots: every tile taken, the newcomer asks one on a tile ("u using this spot?"), who answers, and it waits its turn fighting as before', SS.safespotStats.asks > stats0.asks && SS.safespotStats.answers > stats0.answers && SS.safespotHeld(N2) === null && said.some(l => l.who === N2.username) && said.some(l => l.to === N2.username), { said, stats: SS.safespotStats, n2: [N2.x, N2.z], holders: [R, ...held].map(p => [p.username, p.x, p.z, SS.safespotHeld(p)]), lines: Loot.lootLog.filter(e => e.kind === 'line' && e.who === N2.username).map(e => e.role) });
    SS.setSafespotRatesForTest(null);
    for (const p of [R, N2, ...held]) {
        sim.botPlayer(p).windDown();
        hold(p);
    }
}

// (round 1's left-overs: T3) a ranger whose tile's giant is gone (killed by others, its respawn far off) moves to a free
// tile whose giant it can shoot, before its 3 idle minutes become 6 of fighting off the tiles; one with no tile in its
// scan (after a kill, its loot) takes a free one a moment later
{
    scene(SEED, 'safespot move');
    Loot.setLootRatesForTest({ trait: () => null });
    const SS = lib.Safespots;
    const I = lib.Items;
    const step = lib.SkillProgression.RANGED.find(s => s.location === lib.Locations.HILL_GIANTS_EDGEVILLE);
    const spot = SS.safespotOf(step);
    SS.resetSafespotsForTest();
    // (the last scene's bots out of the room: they were held standing on its tiles)
    bots.forEach((p, i) => {
        if (p.z > 6400) parkAt(p, i);
    });
    run(2);
    for (const t of spot.tiles) for (const [hx, hz] of t.giants) {
        const g = SS.giantOf(hx, hz, 0);
        if (!g) continue;
        g.resetDefaults?.();
        g.teleJump(hx, hz, 0);
    }
    const R = levelling.filter(p => !subTaskOf(p))[0];
    clean(R);
    const worn = R.getInventory(InvType.WORN);
    const previous = worn.get(3)?.id ?? -1;
    worn.set(3, { id: I.OAK_SHORTBOW, count: 1 });
    worn.set(13, { id: id('iron_arrow'), count: 2000 });
    lib.refreshWorn(R, previous);
    for (const [stat, lvl] of [[PlayerStat.RANGED, 45], [PlayerStat.HITPOINTS, 60], [PlayerStat.DEFENCE, 30]]) R.setLevel(stat, lvl);
    place(R, 3112, 9840, 0);
    const task = new lib.RangedMagicTask(step, PlayerStat.RANGED);
    assign(R, task);
    sim.botPlayer(R).planner.pickTask = () => task;
    const onHeld = () => {
        const h = SS.safespotHeld(R);
        return h !== null && R.x === h[0] && R.z === h[1];
    };
    // (the free tiles' giants where their tiles shoot them, the nearest such tile of its wander to its spawn, and held
    // there (no wander) while the ranger looks for a free one: what the checks ask. The game's wander had both round a
    // corner, out of their tiles' sight, at its give-up (the merge's seed 3: no move, it fought off the tiles and rejoined
    // later) and at its scan's look (seed 7, the merge's seed 1))
    const shotSpot = tile => {
        const g = SS.giantOf(...tile.giants[0], 0);
        if (!g) return null;
        const [sx, sz] = tile.giants[0];
        const sees = (x, z) => Math.max(Math.abs(x - tile.at[0]), Math.abs(z - tile.at[1])) <= 7 && lib.isApproached(0, tile.at[0], tile.at[1], x, z, 1, 1, g.width ?? 1, g.length ?? 1);
        const wander = [];
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) wander.push([sx + dx, sz + dz]);
        wander.sort((a, b) => Math.max(Math.abs(a[0] - sx), Math.abs(a[1] - sz)) - Math.max(Math.abs(b[0] - sx), Math.abs(b[1] - sz)));
        const at = wander.find(([x, z]) => sim.isWalkable(x, z, 0) && sees(x, z));
        return at ? { g, at } : null;
    };
    const holdGiants = except => {
        for (const t of spot.tiles) {
            const s = t === except ? null : shotSpot(t);
            if (!s) continue;
            if (s.g.x !== s.at[0] || s.g.z !== s.at[1]) {
                s.g.resetDefaults?.();
                s.g.teleJump(s.at[0], s.at[1], 0);
            }
            s.g.targetOp = lib.NpcMode.NONE;
        }
    };
    const freeGiants = () => {
        for (const t of spot.tiles) {
            const g = SS.giantOf(...t.giants[0], 0);
            if (g && g.targetOp === lib.NpcMode.NONE) g.resetDefaults?.();
        }
    };
    const first = run(300, onHeld) > 0 ? SS.safespotHeld(R) : null;
    const tileA = first ? spot.tiles.find(t => t.at[0] === first[0] && t.at[1] === first[1]) : null;
    // its giant out of the world for 1000 ticks (killed, the respawn far off: staged)
    const gA = tileA ? SS.giantOf(...tileA.giants[0], 0) : null;
    if (gA) World.removeNpc(gA, 1000);
    const moves0 = { moved: 0, rejoined: 0, ...(SS.safespotMoves ?? {}) };
    const idle0 = SS.safespotStats.idle;
    holdGiants(tileA);
    const moved = run(500, () => {
        const h = SS.safespotHeld(R);
        if (first && h && h[0] === first[0] && h[1] === first[1]) holdGiants(tileA);
        return onHeld() && (h[0] !== first[0] || h[1] !== first[1]);
    });
    freeGiants();
    const second = SS.safespotHeld(R);
    check('safespot move: its tile\'s giant gone 3 minutes, the ranger gives the tile up for a free one whose giant it can shoot and stands on it (T3)', first !== null && gA !== null && moved > 0 && SS.safespotStats.idle === idle0 + 1 && (SS.safespotMoves?.moved ?? 0) === moves0.moved + 1 && onHeld(), { first, second, moved, at: [R.x, R.z], state: task.state, idle: SS.safespotStats.idle - idle0, moves: SS.safespotMoves });
    // its tile given up (as after a fight begun on its way in), in its scan: a free tile taken a moment later. (Its scan as
    // the game enters one, after a kill: its last target's claim given back. Its fight on its tile left the claim of that
    // tile's giant, which its own look then took for another's: seed 7, the merge's seed 1)
    SS.releaseSafespot(R);
    R.clearWaypoints();
    R.clearPendingAction();
    task._releaseNpc();
    task.currentNpc = null;
    place(R, 3112, 9840, 0);
    task.state = 'scan';
    task.watchdog?.notifyActivity?.();
    holdGiants(null);
    const rejoined = run(80, () => {
        if (!SS.safespotHeld(R)) holdGiants(null);
        return onHeld();
    });
    freeGiants();
    check('safespot move: a ranger in its scan with no tile takes a free one whose giant it can shoot and walks onto it (T3)', rejoined > 0 && (SS.safespotMoves?.rejoined ?? 0) > moves0.rejoined, { rejoined, held: SS.safespotHeld(R), at: [R.x, R.z], state: task.state, moves: SS.safespotMoves });
    sim.botPlayer(R).windDown();
    hold(R);
}

// ---- scene 7: lines ----
{
    scene(SEED, 'lines');
    const b = levelling[5];
    const said = [];
    const listen = (p, line) => {
        if (p === b) said.push(line);
    };
    lib.sayListeners.push(listen);
    for (let i = 0; i < 6; i++) {
        Loot.sayLootLine(b, 'pk-loot', { item: 'rune 2h', kind: 'pk', delay: 0 });
        run(25);
    }
    lib.sayListeners.splice(lib.sayListeners.indexOf(listen), 1);
    check('lines: a loot line is never said starred (an item the filter would star: the line without it)', said.length >= 3 && said.every(l => !l.includes('*')), said);
}

// ---- (round 1's fixes) the review's findings, staged ----
const HP = PlayerStat.HITPOINTS;
/** a PKer kills the kitted human (its pack `pack`, 6 Hitpoints) where it stands: the tick of the death, or -1 */
function killHuman(k, pack, attack = false) {
    // (more than 20 ticks after the human's last death: one within them is that death's pile (port/BotLoot
    // notePileDeath), as the pj's kill at seed 2 was the hurt killer's, 20 ticks on)
    const last = Loot.lootLog.filter(e => e.kind === 'death' && e.who === human.username).at(-1);
    if (last) run(Math.max(0, last.t + 21 - World.currentTick));
    matchHuman(k);
    dressHuman(pack);
    human.levels[HP] = 6;
    if (attack) lib.interactPlayerOp(human, k.slot, 2);
    let died = -1;
    run(400, () => {
        if (died < 0 && dying(human)) died = World.currentTick;
        return died >= 0;
    });
    return died;
}
const NO_KIT = [['rune_med_helm', 1], ['adamant_platelegs', 1], ['mithril_scimitar', 1], ['adamant_kiteshield', 1], ['coins', 5000]];

// (B2) a killer below half its Hitpoints loots all the same (only a player's attack ends its loot), a bite while it waits
{
    scene(SEED, 'hurt killer');
    Loot.setLootRatesForTest({ trait: () => null });
    humanBack(SPOT[0], SPOT[1]);
    const KH = edgePkers[1] ?? edgePkers[0];
    Loot.dropLedger?.(KH.username);
    clean(KH);
    place(KH, SPOT[0] + 2, SPOT[1] - 1);
    assign(KH, new lib.EdgevillePKerTask());
    run(8);
    const died = killHuman(KH, NO_KIT);
    // its Hitpoints at 40 % from the death until its loot began (its PK task eats meanwhile): its loot's first ticks hurt
    const low = Math.max(1, Math.floor(KH.baseLevels[HP] * 0.4));
    let seen = 0;
    run(10, () => {
        if (seen === 0) KH.levels[HP] = low;
        if (seen > 0 || subTaskOf(KH)?.role === 'killer') seen++;
        return seen >= 2;
    });
    const pile = piles().find(p => p.human === human && p.diedAt >= died - 1);
    run(150, () => pile && pile.dropAt !== null && World.currentTick > pile.revealAt);
    const took = events(pile?.id, 'take').filter(e => e.who === KH.username);
    const bites = events(pile?.id, 'eat').filter(e => e.who === KH.username && e.role === 'hurt');
    check('hurt killer: a killer at 40 % of its Hitpoints still takes the human\'s stacks before the reveal (B2: only an attack ends its loot)', died > 0 && seen >= 2 && took.length >= 2 && took.every(e => e.early), { died, low, base: KH.baseLevels[HP], took: took.map(e => `${name(e.item)} +${e.t - (pile?.dropAt ?? 0)}`), giveup: events(pile?.id, 'giveup').map(e => `${e.who} ${e.role}`) });
    check('hurt killer: it eats one bite of its own food while it waits for the drop', bites.length === 1 && bites[0].t <= (pile?.dropAt ?? -1) + 1, bites.map(e => `${name(e.item)} ${e.t - (pile?.diedAt ?? 0)}`));
    hold(KH);
    KH.levels[HP] = KH.baseLevels[HP];
    Loot.dropLedger?.(KH.username);
}

// (B1) a PJer jumps the killer the tick after a Take of its: the take that landed is in its ledger, none lands after
{
    scene(SEED, 'pj');
    Loot.setLootRatesForTest({ trait: () => null });
    const MULTI = [3192, 3543];
    humanBack(MULTI[0], MULTI[1]);
    const PJ = deepPkers[0];
    Loot.dropLedger?.(K.username);
    clean(K);
    clean(PJ);
    place(K, MULTI[0] + 2, MULTI[1] - 1);
    assign(K, new lib.EdgevillePKerTask());
    run(8);
    // (the PJer at the killer's levels: the game lets it attack in the multi-combat)
    for (let stat = 0; stat < K.baseLevels.length; stat++) if (PJ.baseLevels[stat] !== K.baseLevels[stat]) PJ.setLevel(stat, K.baseLevels[stat]);
    PJ.combatLevel = PJ.getCombatLevel();
    // (what its pack and its ledger held before: a ledger left from an earlier scene is no take of this one)
    const inv = K.getInventory(InvType.INV);
    const ids = new Set([...NO_KIT.map(([n]) => id(n)), ...['rune_full_helm', 'amulet_of_strength', 'rune_scimitar', 'rune_platebody', 'rune_platelegs'].map(id)]);
    const before = new Map([...ids].map(i => [i, [inv.getItemCount(i), Loot.ledgerKeep(K, i)]]));
    // (out here its post is the edge: the human attacks it, and it fights back)
    const died = killHuman(K, NO_KIT, true);
    const pile = piles().find(p => p.human === human && p.diedAt >= died - 1);
    // its Take clicked on the pile's tile (the game takes it the next tick): the PJer's attack set before that tick
    let jumped = -1;
    let jumpedOn = -1;
    run(80, () => {
        const st = subTaskOf(K);
        if (jumped < 0 && st?.role === 'killer' && st.click && K.x === st.click.obj.x && K.z === st.click.obj.z) {
            jumpedOn = st.click.type;
            place(PJ, K.x - 3, K.z + 1);
            lib.interactPlayerOp(PJ, K.slot, 2);
            jumped = World.currentTick;
        }
        return jumped >= 0 && World.currentTick >= jumped + 4;
    });
    // (each of the human's items its pack gained since: its ledger gained as many)
    const gained = [...ids].map(i => [name(i), inv.getItemCount(i) - before.get(i)[0], Loot.ledgerKeep(K, i) - before.get(i)[1]]).filter(([, n, l]) => n !== 0 || l !== 0);
    check('pj: a PJer\'s attack the tick after its Take ends the killer\'s loot (B1), and the take that landed is in its ledger: every item of the human\'s its pack gained is', died > 0 && jumped > 0 && inv.getItemCount(jumpedOn) > (before.get(jumpedOn)?.[0] ?? Infinity) && gained.every(([, n, l]) => n <= l) && subTaskOf(K)?.role !== 'killer', { jumped: jumped - (pile?.dropAt ?? 0), on: name(jumpedOn), gained, attacker: sim.attackTarget(PJ)?.username });
    PJ.clearPendingAction();
    K.clearPendingAction();
    hold(PJ);
    hold(K);
    for (const p of [PJ, K]) p.levels[HP] = p.baseLevels[HP];
    Loot.dropLedger?.(K.username);
}

// (B4) a bot's own fresh drop by the human's death (a giant it killed: private to it) is not the human's pile
{
    scene(SEED, 'own drop');
    Loot.setLootRatesForTest({ trait: () => null });
    humanBack(3222, 3218);
    const F = levelling.find(p => !subTaskOf(p) && p !== V);
    clean(F);
    const DEATH = [3226, 3221];
    sim.teleportHuman(DEATH[0], DEATH[1], 0);
    dressHuman(LOOT_PACK);
    human.heroPoints.clear();
    place(F, DEATH[0] + 2, DEATH[1] + 1);
    // (well after the last scene's death: a death within 20 ticks of one is the same death's pile)
    run(25);
    npcDeath();
    run(15, () => dying(human));
    const pile = piles().find(p => p.human === human && World.currentTick - p.diedAt <= 3);
    // three ticks after the death, before the human's drop: the fighter's own drop on its tile (a full life, its own)
    run(Math.max(0, (pile?.diedAt ?? 0) + 3 - World.currentTick));
    const own = [new Obj(0, F.x, F.z, lib.EntityLifeCycle.DESPAWN, id('big_bones'), 1), new Obj(0, F.x, F.z, lib.EntityLifeCycle.DESPAWN, id('coins'), 250)];
    for (const o of own) World.addObj(o, F.hash64, 200);
    run(25);
    const objs = pile?.objs ?? [];
    check('own drop: a fighter\'s own fresh drop 2 tiles from the human\'s death is not the pile (B4): the pile is the human\'s items on its tile, nobody\'s, and the fighter is no killer', pile && pile.dropAt >= pile.diedAt + 5 && pile.hero === null && objs.length >= 8 && own.every(o => !objs.includes(o)) && objs.every(o => o.x === objs[0].x && o.z === objs[0].z && o.receiver64 === Obj.NO_RECEIVER) && subTaskOf(F)?.role !== 'killer', { died: pile?.diedAt, drop: pile?.dropAt, hero: pile?.hero?.username, objs: objs.map(o => `${name(o.type)}@${o.x},${o.z}`).join(' '), fighter: subTaskOf(F)?.name, hp: human.levels[HP], now: World.currentTick, piles: piles().map(p => [p.id, p.diedAt, p.dropAt]), deaths: Loot.lootLog.filter(e => e.kind === 'death').slice(-2).map(e => [e.pile, e.t]) });
    hold(F);
}

// (B3) a wine stint cut short after its air staff is wielded: its own weapon in hand again, its temple tile given back
{
    scene(SEED, 'stint cut');
    Loot.setLootRatesForTest({ trait: () => null });
    const MR = lib.MagicRuns;
    const I = lib.Items;
    const g = levelling.filter(p => !subTaskOf(p) && p !== V).slice(-1)[0];
    const stint = () => {
        clean(g);
        for (const [stat, lvl] of [[PlayerStat.MAGIC, 45], [PlayerStat.ATTACK, 30], [PlayerStat.STRENGTH, 30], [PlayerStat.DEFENCE, 30], [HP, 30]]) g.setLevel(stat, lvl);
        g.combatLevel = g.getCombatLevel();
        const bank = g.getInventory(lib.bankInvId());
        bank.add(I.LAW_RUNE, 5);
        bank.add(I.STAFF_OF_AIR, 1);
        const worn = g.getInventory(InvType.WORN);
        const previous = worn.get(3)?.id ?? -1;
        worn.set(3, { id: I.IRON_SCIMITAR, count: 1 });
        lib.refreshWorn(g, previous);
        place(g, 2946, 3368);
        const task = MR.magicRunTask('telegrab');
        assign(g, task);
        return task;
    };
    const wornNow = () => g.getInventory(InvType.WORN).get(3)?.id ?? -1;
    // a rescan's switch (interrupt, reset) after the staff is in hand
    const t1 = stint();
    const staffed = run(400, () => wornNow() === I.STAFF_OF_AIR);
    t1.interrupt();
    t1.reset();
    hold(g);
    run(4);
    check('stint cut: a stint switched away from after its air staff is wielded: its scimitar in hand again, the staff in its pack (B3)', staffed > 0 && wornNow() === I.IRON_SCIMITAR && g.getInventory(InvType.INV).getItemCount(I.STAFF_OF_AIR) === 1, { staffed, held: name(wornNow()), staffInPack: g.getInventory(InvType.INV).getItemCount(I.STAFF_OF_AIR) });
    // taken out of the temple mid stint: the errand fails ('left the temple')
    const t2 = stint();
    const inside = run(1500, () => lib.standTileOf(g) !== null && wornNow() === I.STAFF_OF_AIR);
    place(g, 2946, 3368);
    const over = run(30, () => t2.isComplete(g));
    run(4);
    check('stint cut: a grabber out of the temple mid stint (its errand failed): its scimitar in hand again, its temple tile given back (B3)', inside > 0 && over > 0 && wornNow() === I.IRON_SCIMITAR && lib.standTileOf(g) === null, { inside, over, outcome: t2.outcome, held: name(wornNow()), tile: lib.standTileOf(g) });
    hold(g);
}

// (B6) a ledger restored from a world saved after the PKer's own last save: what it took after that save is not banked
{
    scene(SEED, 'stale restore');
    const KS = edgePkers[2] ?? edgePkers[0];
    hold(KS);
    Loot.dropLedger?.(KS.username);
    clean(KS);
    const inv = KS.getInventory(InvType.INV);
    for (let i = 0; i < 10; i++) inv.add(id('shark'), 1);
    inv.add(id('adamant_kiteshield'), 1);
    const pt = KS.playtime;
    // a kiteshield taken, (its save), then 4 sharks taken; the world saved after both
    Loot.addToLedgerForTest(KS, id('adamant_kiteshield'), 1);
    KS.playtime = pt + 50;
    Loot.addToLedgerForTest(KS, id('shark'), 4);
    const saved = JSON.parse(JSON.stringify(BotManager.exportWorld()?.loot ?? {}));
    Loot.dropLedger?.(KS.username);
    // a restart: its save from between the two (its pack: the kiteshield, its kit's own 10 sharks)
    KS.playtime = pt + 10;
    Loot.restoreLoot(saved);
    const bank = KS.getInventory(lib.bankInvId());
    const banked = Loot.bankLoot(KS, bank);
    check('stale restore: a ledger restored newer than the PKer\'s own save banks only what its save holds of the human\'s (the kiteshield), never its kit\'s sharks (B6)', bank.getItemCount(id('adamant_kiteshield')) === 1 && bank.getItemCount(id('shark')) === 0 && inv.getItemCount(id('shark')) === 10 && !Loot.holdsLoot(KS), { banked, bank: [bank.getItemCount(id('adamant_kiteshield')), bank.getItemCount(id('shark'))], saved: saved[KS.username] });
    KS.playtime = pt + 50;
    clean(KS);
}

// (B5) a PKer that leaves the pool for good (a quit; a human's login with its name: BotManager._drop) takes its ledger
// with it: none is saved for it after (the last scene: the bot is out of the pool)
{
    scene(SEED, 'quit');
    const KQ = edgePkers[1] ?? edgePkers[0];
    Loot.addToLedgerForTest(KQ, id('rune_med_helm'), 1);
    const before = BotManager.exportWorld()?.loot?.[KQ.username] ?? null;
    BotManager.release(KQ.username);
    const after = BotManager.exportWorld()?.loot?.[KQ.username] ?? null;
    check('quit: a PKer out of the pool for good takes its ledger with it: none saved for it after, nor held (B5)', before !== null && after === null && Loot.ledgerOf(KQ.username).size === 0, { before, after, ledger: [...Loot.ledgerOf(KQ.username)] });
}

check('errors: none (bot errors, console errors)', BotManager.stats().errors === 0 && consoleErrors.length === 0, `${BotManager.stats().errors} bot errors, ${consoleErrors.length} console errors ${consoleErrors.slice(0, 2).join(' | ')}`);

out(`loot: ${N} bots and the human on a members world, seed ${SEED}`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
const failed = checks.filter(c => !c.ok).length;
out(`${failed} FAIL; loot: ${checks.length - failed} of ${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
