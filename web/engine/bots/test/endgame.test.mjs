#!/usr/bin/env node
// The period endgame (bots ideas round 1, Track A), in the real 274 world (members):
//   lines     every moment's lines exist (data/lines2004-endgame.json, event 'endgame')
//   map       the endgame's NPCs and locs where the places say (the jailer, Velrak, the dusty-key door, the dragons and
//             demons, the KBD's ladder, levers and the KBD, Kolodion, the Kalphite Queen, the Duke)
//   traits    the bosser trait and the taste from the name's own seeds; the offer only to an eligible bosser, its share,
//             its gap, its food gate, the capacities; Velrak's errand first for a Taverley spot without the dusty key
//   velrak    the dusty key for real: down the Taverley ladder, the jailer fought, his jail key taken, used on the cell's
//             door, Velrak's answers, the key owned; walked, no unseen jump
//   taverley  a solo trip to Taverley's blue dragons: the bank (food, key, shield), the shield worn, through the dusty-key
//             door with the key, the fight (XP, the shield on), out and banked; the role 'bosser' while on it, off after
//   demons    the Edgeville dungeon's black demons: Protect from Melee pressed while it fights (the prayer tab), off after
//   exits     a bot left in each lair walks out by the game's clicks: the KBD's lever and ladder, the Mage Arena's pool
//             and ladder, the deep Wilderness dungeon's gates and stairs, the Heroes' Guild's
//             basement, the Edgeville black demons' doors; no unseen jump
//   drops     a notable drop's moment: its line, the gz of the bots near (at most 3), the rare-drop event; the pack's gains
//             noted for a sale
//   sale      a sale stint of its own drops: walked to its trade bank, the stock only its own loot, its advert in the
//             period's form ("selling rune chain 44k"); (round 1 fixes, A3, A6) out of the bank only its drop's count,
//             a sale spends it (nothing more for sale, the stint over), the planner's rescan leaves the stint be, a
//             stint cut short at its bank puts its stock back
//   (round 1 fixes)
//   gates     A5: a bosser whose best weapon is a two-hander gets no shield spot and no KBD; A4: the Wilderness's
//             endgame spots' food gate (12 good food owned) and its 15-20 carried
//   deaths    A1: a bosser killed on its way (274's death queued: a solo trip, a Wilderness endgame trip on its
//             waypoints, a KBD leader and member near the ladder) never walks back from Lumbridge, its trip is over and
//             logged a death; the KBD team ended with its leader (A2)
//   kbd-abort A2: a KBD leader's errand cut short on the way: the team over, its member stops following
//   food-out  A7: a trip's fight over with 2 food left: its line 'eg-food-out'
//   (the KQ track: A4, Kalphite Queen attempts)
//   kq        a whole attempt: the leader's 2 ropes from Ned in Draynor, the call at Al Kharid bank and a team of 4-5,
//             each one's 2 waterskins and pass from Shantay, the Shantay Pass's gate the game's way (the pass handed over,
//             the poster's choice, no jump), the leader's rope on the burrow and each down within its 200 ticks, the
//             tunnels, the second rope, Protect from Magic on in the chamber, each leave by its rule (under 40 % with 2
//             or fewer pieces of food) or the team's run, home north of the pass; walked, no unseen jump
//   kq-death  (with the content overlay, as the app runs: patch 0003) a member killed in the chamber: its trip over at
//             Lumbridge, logged a death, its rune kit kept, never walked back; another hurt with 2 sharks left leaves by
//             its rule, by the chamber's rope, the burrow's and the pass (or dies on the way, logged); half gone, the
//             team runs
//   kq-kill   the queen's Hitpoints staged to 1 in each form: "phase 2", the kill, her drop from 274's table
//             (kalphite_queen.rs2) with a receiver in the team, the bossKill event
//   kq-cap    the bar and 3 more of it free: may lead, no dice drawn; 2 more: no team can form, no KQ offer, no dice;
//             the planner's offer may be the KQ; a team under way and the world's 4-hour cap from an attempt's call
//   (the KQ fixes)
//   kq-tele   KQ-1: a member's own Lumbridge Teleport on its way (it lands a tile from the respawn) is no death: its
//             errand goes on (the church's altar, the bank) to the meeting; (the door-walk fix) it prayed at the altar
//   errors    none
// Each scene has its own dice (test/lib/dice.mjs), clean packs, full run energy, the director and cliques off, staged
// bots held with a stand task. It should pass at every seed: node web/engine/bots/test/seeds.mjs endgame.test.mjs --seeds=1-10
//
//   node --expose-gc web/engine/bots/test/endgame.test.mjs [--seed=5] [--only=velrak]
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { scene } from './lib/dice.mjs';
// (the KQ track: the death scene's world with the content overlay as the runtime installs it: a bot keeps its items)
import fs from 'fs';
import { CONTENT_DIR, ENGINE_DIR } from './lib/paths.mjs';
import { compileBotScripts } from '../content/compile.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const SEED = Number(args.seed ?? 5);
const ONLY = args.only ?? null;
const out = (s = '') => process.stdout.write(s + '\n');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const errors = [];
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
console.error = (...a) => {
    const text = a.map(String).join(' ');
    if (!text.includes('ExperimentalWarning') && !text.includes('--trace-warnings')) errors.push(text.slice(0, 300));
};
scene(SEED, 'world');

// (the KQ track: the overlay compiled before the clone, as test/loot.test does, for the KQ death scene only)
const wantOverlay = ONLY === null || ONLY.split(',').some(n => 'kq-death'.includes(n));
const overlayBins = wantOverlay
    ? await (async () => {
          const overlay = await compileBotScripts({ engineDir: ENGINE_DIR, contentDir: CONTENT_DIR, log: () => {} });
          return { bin: new Uint8Array(fs.readFileSync(overlay.file)), dat: new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.dat'))), idx: new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.idx'))) };
      })()
    : null;
const engineDir = prepareEngineClone('endgame', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/endgame.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, Endgame, Core, Fight, Velrak, DropSale, Items, Locations, PlayerStat } = lib;
const cheb = (ax, az, bx, bz) => Math.max(Math.abs(ax - bx), Math.abs(az - bz));
const want = name => ONLY === null || name.includes(ONLY) || ONLY.split(',').includes(name);
const id = name => lib.ObjType.getId(name);

// ---- the world ----
const sim = await lib.Sim.create({ bots: 14, members: true, debug: false });
sim.addHuman(3222, 3218, 0);
for (let i = 0; i < 400 && sim.bots().length < 14; i++) sim.tick();
for (let i = 0; i < 12; i++) sim.tick();
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0, abrupt: 0 });
lib.setHangoutRateForTest(0.0001);
lib.setArenaRatesForTest(0);
lib.setDirectorForTest({ first: 1e9, gap: 1e9 });
// (and its schedule drawn before it was off, its recruits' cooldowns: none)
lib.resetDirectorForTest();
lib.setCliqueBehaviourForTest(false);
lib.setEventRatesForTest({ odds: 0 });
lib.setTrainRatesForTest({ ask: 0, form: 0, yes: 0, join: 0 });
lib.setAlchRateForTest(0);
lib.setOutingRatesForTest(0);
check('the world: 14 bots online', sim.bots().length === 14, `${sim.bots().length}`);

const bots = sim.bots();
const free = [...bots];
const take = f => {
    const i = free.findIndex(f);
    return i === -1 ? null : free.splice(i, 1)[0];
};
const levelling = p => lib.isLevelling(p.botPlanner) && !sim.botPlayer(p)?.hasSubTask();
function assign(p, task) {
    const ai = sim.botPlayer(p);
    // (as BotPlayer switches: the task it leaves is over)
    const old = ai.currentTask;
    if (old && old !== task) {
        old.interrupt?.();
        old.reset?.();
    }
    task.reset();
    ai.currentTask = task;
    ai.planEnds = World.currentTick + 30000;
    p.clearWaypoints();
    p.clearPendingAction();
}
function run(ticks, until = () => false) {
    for (let i = 0; i < ticks; i++) {
        sim.tick();
        if (until()) return i + 1;
    }
    return -1;
}
/** a clean pack and bank with these items, worn these, its run energy full */
function kit(p, items, bankItems = [], worn = []) {
    p.clearPendingAction();
    p.clearWaypoints();
    p.activeScript = null;
    p.getInventory(lib.InvType.INV).removeAll();
    p.getInventory(lib.InvType.WORN).removeAll();
    const bank = p.getInventory(lib.bankInvId());
    bank?.removeAll();
    lib.giveItems(p, items, false);
    if (bankItems.length) lib.giveItems(p, bankItems, true);
    lib.wearItems(p, worn);
    p.runenergy = 10000;
}
function levels(p, map) {
    for (const [stat, lv] of Object.entries(map)) p.setLevel(PlayerStat[stat], lv);
    p.combatLevel = p.getCombatLevel();
}
function place(p, x, z, level = 0) {
    p.teleJump(x, z, level);
    run(1);
}
const STAND = { name: 'Stand', reset() {}, interrupt() {}, interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, activityStep: () => null };
const hold = p => {
    // (its sub-task too: a trip's fight left running carried on under the stand)
    const ai = sim.botPlayer(p);
    if (ai?.subTask) {
        ai.subTask.interrupt?.();
        ai._dropSubTask?.();
    }
    p.clearPendingAction();
    p.clearWaypoints();
    assign(p, Object.create(STAND));
};
for (const p of bots) hold(p);
/** the bot's moves of more than a step that are not the game's (its marked moves) */
function watchMoves(p) {
    const own = [];
    let last = [p.x, p.z, p.level];
    const marks0 = lib.teleportStats.marks.length;
    return {
        tick() {
            const d = p.level !== last[2] ? 99 : cheb(p.x, p.z, last[0], last[1]);
            if (d > 2) own.push({ t: World.currentTick, from: last, to: [p.x, p.z, p.level] });
            last = [p.x, p.z, p.level];
        },
        /** the jumps no mark of the bot's covers (as the humanlike runner classes them: a floor's step, a dungeon's way, a deck) */
        unseen() {
            const marks = lib.teleportStats.marks.slice(marks0).filter(m => m.name === p.username.toLowerCase());
            const dist = j => cheb(j.from[0], j.from[1], j.to[0], j.to[1]);
            return own.filter(j => !(j.from[2] !== j.to[2] && dist(j) <= 3) && Math.abs(j.to[1] - j.from[1]) < 5000 && !((j.from[2] === 1 || j.to[2] === 1) && Math.abs(j.to[0] - j.from[0]) + Math.abs(j.to[1] - j.from[1]) > 20) && !marks.some(m => m.tick >= j.t - 12 && m.tick <= j.t + 3));
        }
    };
}
const causesNow = () => new Map([...lib.teleportStats.byCause].map(([k, [j]]) => [k, j]));
const causesSince = c0 => [...lib.teleportStats.byCause].filter(([k, [j]]) => j > (c0.get(k) ?? 0)).map(([k, [j]]) => `${k} ${j - (c0.get(k) ?? 0)}`);
const lines = [];
lib.sayListeners.push((player, line, kind) => lines.push({ name: player.username, line, kind, t: World.currentTick }));
const veteran = { ATTACK: 85, STRENGTH: 88, DEFENCE: 82, HITPOINTS: 88, PRAYER: 52, RANGED: 40, MAGIC: 45 };
const runeKit = () => [Items.RUNE_SCIMITAR, id('rune_full_helm'), id('rune_chainbody'), id('rune_platelegs')];
const sword = id('swordfish');

// ---- the lines: every moment's ----
{
    const kinds = ['eg-go-dragons', 'eg-go-demons', 'eg-go-hounds', 'eg-food-out', 'eg-done', 'eg-velrak-go', 'eg-velrak-got', 'eg-drop-rune-chain', 'eg-drop-rune-med', 'eg-drop-rune-full', 'eg-drop-rune', 'eg-drop-dmed', 'eg-drop-dchain', 'eg-drop-dragon', 'eg-drop-halfkey', 'eg-drop-big', 'eg-gz'];
    // (the KQ track's moments)
    kinds.push('kq-call', 'kq-meet', 'kq-omw', 'kq-here', 'kq-who-rope', 'kq-rope', 'kq-nvm', 'kq-go', 'kq-rope-on', 'kq-in', 'kq-phase2', 'kq-flee', 'kq-run', 'kq-wipe', 'kq-impossible', 'kq-kill');
    const missing = kinds.filter(k => lib.pieceLines('endgame', k).length === 0);
    check("lines: every endgame moment has its lines (data/lines2004-endgame.json, event 'endgame')", missing.length === 0, missing.join(', ') || `${kinds.length} moments`);
}

// ---- the map ----
if (want('map')) {
    const npc = (name, [x, z, l], r = 8) => lib.findNpcByName(x, z, l, name, r) !== null;
    const loc = (name, [x, z, l], r = 3) => lib.findLocByName(x, z, l, name, r) !== null;
    const at = {
        jailer: npc('jailer', Locations.TAVERLEY_JAILER, 6),
        velrak: npc('velrak_the_explorer', Locations.TAVERLEY_VELRAK, 4),
        deepDoor: loc('deepdungeondoor', Locations.TAVERLEY_DEEP_DOOR, 1),
        jailDoor: loc('dungeonjail', Locations.TAVERLEY_JAIL_DOOR, 1),
        blue: npc('blue_dragon', Locations.TAVERLEY_BLUE_DRAGONS, 8),
        hounds: npc('hellhound', Locations.TAVERLEY_HELLHOUNDS, 10),
        demons: npc('black_demon', Locations.TAVERLEY_BLACK_DEMONS, 10),
        heroes: npc('blue_dragon', Locations.HEROES_BLUE_DRAGON, 5),
        edgeDemons: npc('black_demon', Locations.EDGEVILLE_BLACK_DEMONS, 8),
        fireGiants: npc('firegiant', Locations.FIRE_GIANTS_WATERFALL_DUNGEON, 10),
        ruins: npc('greater_demon', Locations.DEMONIC_RUINS, 20),
        redDragons: npc('red_dragon', Locations.RED_DRAGONS_WILDERNESS, 25),
        kbdLadder: loc('wildymirrorladdertop1', Locations.KBD_LADDER, 2),
        leverIn: loc('dragonkinginlever', Locations.KBD_LEVER_ROOM, 4),
        leverOut: loc('dragonkingoutlever', Locations.KBD_LAIR, 3),
        // (the KQ track: 12, the KBD wanders its lair: 6 missed it at seed 1, on 3e35448 as well)
        kbd: npc('king_dragon', Locations.KBD, 12),
        kolodion: npc('arenamage1', Locations.MAGE_ARENA_CELLAR, 4),
        queen: npc('kalphite_queen', Locations.KALPHITE_QUEEN, 10),
        duke: npc('duke_of_lumbridge', [3211, 3220, 1], 4),
        chaosAltar: loc('chaosaltar', Locations.CHAOS_TEMPLE_ALTAR, 3),
        varrockAltar: loc('altar', Locations.VARROCK_CHURCH_ALTAR, 3)
    };
    check('map: the endgame\'s NPCs and locs where the places say', Object.values(at).every(Boolean), Object.entries(at).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'all');
    const keys = Object.entries(lib.KEY_DOORS).map(([door, key]) => [door, id(key)]);
    check('map: the key doors\' keys are 274 items (dusty key, jail key)', keys.every(([, k]) => k !== -1), keys);
}

// ---- traits and the offer ----
if (want('traits')) {
    scene(SEED, 'traits');
    const names = lib.BOT_NAMES.slice(0, 2000);
    const share = names.filter(n => Endgame.hasBosserTrait(n)).length / names.length;
    check('traits: the bosser trait for about 0.6 of names (its own seed)', share > 0.55 && share < 0.65, share.toFixed(3));
    const t1 = Endgame.endgameTaste(names[3]);
    const t2 = Endgame.endgameTaste(names[3]);
    check('traits: the taste the same for the same name', JSON.stringify(t1) === JSON.stringify(t2) && t1.dragons >= 0.2 && t1.dragons <= 1, t1);
    const p = take(b => levelling(b) && Endgame.hasBosserTrait(b.username) && b.botPlanner !== 'skiller');
    check('traits: a levelling bosser to stage', p !== null);
    if (p) {
        Core.resetEndgameTripsForTest();
        // (Prayer 40: no demon spot, no KBD team; the dragons' and hounds' spots its offers)
        levels(p, { ...veteran, PRAYER: 40 });
        kit(p, [], [[sword, 20], [Items.COINS, 5000]], runeKit());
        place(p, 2946, 3372);
        const offer = Endgame.endgameFor(p, 0);
        check('traits: an eligible bosser without the dusty key is offered Velrak\'s errand or a keyless spot (roll 0)', offer !== null && (offer.name === 'Velrak:dusty-key' || offer.name === 'Endgame:heroes-blue'), offer?.name ?? null);
        kit(p, [], [[sword, 20], [id('dusty_key'), 1], [Items.COINS, 5000]], runeKit());
        const trip = Endgame.endgameFor(p, 0);
        check('traits: with the key, a solo trip or (fit for it) a KBD team (roll 0)', trip !== null && (trip.name.startsWith('Endgame:') || trip.name === 'KbdTeam:kbd'), trip?.name ?? null);
        check('traits: not over its share (roll 0.99)', Endgame.endgameFor(p, 0.99) === null);
        kit(p, [], [[sword, 8], [id('dusty_key'), 1]], runeKit());
        check('traits: not without 12 pieces of good food (the food gate)', Endgame.endgameFor(p, 0) === null);
        kit(p, [], [[sword, 20], [id('dusty_key'), 1]], runeKit());
        levels(p, { ATTACK: 50, STRENGTH: 50, DEFENCE: 50, HITPOINTS: 50, PRAYER: 20 });
        check('traits: not below combat 85', Endgame.endgameFor(p, 0) === null);
        levels(p, { ...veteran, PRAYER: 40 });
        // (a started trip: its gap)
        const task = Endgame.soloTripTask('taverley-hounds');
        assign(p, task);
        run(3);
        check('traits: on a trip it carries the role \'bosser\' and is on the registry', lib.eventRoleOf(p)?.role === 'bosser' && Core.tripOf(p)?.spot === 'taverley-hounds', { role: lib.eventRoleOf(p), trip: Core.tripOf(p) });
        hold(p);
        run(2);
        check('traits: its role and its registry entry gone when the trip is dropped', lib.eventRoleOf(p) === null && Core.tripOf(p) === null, { role: lib.eventRoleOf(p) });
        check('traits: no second start within 45 minutes of play', Endgame.endgameFor(p, 0) === null);
        const notBosser = bots.find(b => lib.isLevelling(b.botPlanner) && !Endgame.hasBosserTrait(b.username));
        if (notBosser) {
            const saved = [notBosser.x, notBosser.z];
            levels(notBosser, veteran);
            kit(notBosser, [], [[sword, 20], [id('dusty_key'), 1]], runeKit());
            check('traits: never a bot without the trait', Endgame.endgameFor(notBosser, 0) === null);
            hold(notBosser);
            void saved;
        }
        Core.resetEndgameTripsForTest();
        hold(p);
        free.push(p);
    }
}

// ---- the dusty key ----
if (want('velrak')) {
    scene(SEED, 'velrak');
    const p = take(levelling);
    levels(p, veteran);
    kit(p, [], [[sword, 20], [Items.COINS, 1000]], runeKit());
    place(p, 2946, 3372);
    const moves = watchMoves(p);
    const c0 = causesNow();
    const s0 = { ...Velrak.velrakStats };
    const task = Velrak.velrakTask();
    assign(p, task);
    const t = run(9000, () => {
        moves.tick();
        return task.isComplete(p);
    });
    const dusty = (p.getInventory(lib.InvType.INV).getItemCount(id('dusty_key')) ?? 0) + (p.getInventory(lib.bankInvId())?.getItemCount(id('dusty_key')) ?? 0);
    const st = Velrak.velrakStats;
    check('velrak: the jailer\'s jail key taken, the cell opened with it, Velrak\'s answers: a dusty key owned', dusty === 1 && st.jailKeys > s0.jailKeys && st.cells > s0.cells && st.keys > s0.keys, { t, dusty, st, outcome: task.outcome, state: task.state, at: [p.x, p.z, p.level] });
    check('velrak: the jail key dropped, not kept', (p.getInventory(lib.InvType.INV).getItemCount(id('jail_key')) ?? 0) === 0 && (p.getInventory(lib.bankInvId())?.getItemCount(id('jail_key')) ?? 0) === 0);
    check('velrak: walked, no unseen jump', moves.unseen().length === 0, { unseen: moves.unseen().slice(0, 3), causes: causesSince(c0) });
    hold(p);
    free.push(p);
}

// ---- a solo trip to Taverley's blue dragons ----
if (want('taverley')) {
    scene(SEED, 'taverley');
    Core.resetEndgameTripsForTest();
    Endgame.setEndgameTripTicksForTest([500, 500]);
    const p = take(levelling);
    levels(p, veteran);
    const shield = id('antidragonbreathshield');
    kit(p, [], [[sword, 20], [id('dusty_key'), 1], [shield, 1], [Items.COINS, 1000]], runeKit());
    place(p, 2946, 3372);
    const moves = watchMoves(p);
    const c0 = causesNow();
    const xp0 = p.stats[PlayerStat.ATTACK] + p.stats[PlayerStat.STRENGTH] + p.stats[PlayerStat.DEFENCE] + p.stats[PlayerStat.HITPOINTS];
    const task = Endgame.soloTripTask('taverley-blue');
    assign(p, task);
    let inside = -1;
    let shieldOnInside = false;
    let roleInside = false;
    const t = run(9000, () => {
        moves.tick();
        if (inside < 0 && p.z > 6400 && cheb(p.x, p.z, 2900, 9800) <= 10 && p.x < 2923) {
            inside = World.currentTick;
            shieldOnInside = p.getInventory(lib.InvType.WORN).get(5)?.id === shield;
            roleInside = lib.eventRoleOf(p)?.role === 'bosser';
        }
        return task.isComplete(p);
    });
    const xp = p.stats[PlayerStat.ATTACK] + p.stats[PlayerStat.STRENGTH] + p.stats[PlayerStat.DEFENCE] + p.stats[PlayerStat.HITPOINTS] - xp0;
    check('taverley: through the dusty-key door to the blue dragons, the anti-dragon shield worn, the role \'bosser\'', inside > 0 && shieldOnInside && roleInside, { inside, shieldOnInside, roleInside, at: [p.x, p.z], state: task.state, outcome: task.outcome });
    check('taverley: fought there (XP), the trip over, banked', t > 0 && xp > 0 && task.outcome === 'done', { t, xp, outcome: task.outcome, at: [p.x, p.z] });
    check('taverley: the role off and the trip in the log after', lib.eventRoleOf(p) === null && Core.tripLog.some(r => r.name === p.username && r.spot === 'taverley-blue' && r.end > 0));
    check('taverley: walked, no unseen jump', moves.unseen().length === 0, { unseen: moves.unseen().slice(0, 3), causes: causesSince(c0) });
    Endgame.setEndgameTripTicksForTest(null);
    hold(p);
    free.push(p);
}

// ---- the Edgeville dungeon's black demons: Protect from Melee ----
if (want('demons')) {
    scene(SEED, 'demons');
    Core.resetEndgameTripsForTest();
    Endgame.setEndgameTripTicksForTest([400, 400]);
    const p = take(levelling);
    levels(p, { ATTACK: 92, STRENGTH: 95, DEFENCE: 90, HITPOINTS: 92, PRAYER: 60, RANGED: 50, MAGIC: 50 });
    kit(p, [], [[id('shark'), 20], [Items.COINS, 500]], runeKit());
    // (its prayer down a little: the altar first)
    p.levels[PlayerStat.PRAYER] = 50;
    place(p, 3094, 3493);
    const moves = watchMoves(p);
    const c0 = causesNow();
    const altars0 = Endgame.endgameStats.altars;
    const xp0 = p.stats[PlayerStat.STRENGTH] + p.stats[PlayerStat.HITPOINTS];
    const task = Endgame.soloTripTask('edge-demons');
    assign(p, task);
    let prayed = 0;
    let atDemons = 0;
    const t = run(7000, () => {
        moves.tick();
        if (p.z > 9940 && cheb(p.x, p.z, 3089, 9959) <= 12) {
            atDemons++;
            if (p.getVar(lib.VarPlayerType.getId('prayer14')) === 1) prayed++;
        }
        return task.isComplete(p);
    });
    const xp = p.stats[PlayerStat.STRENGTH] + p.stats[PlayerStat.HITPOINTS] - xp0;
    check('demons: the altar first (its prayer down), then the black demons, Protect from Melee on while it fights there', Endgame.endgameStats.altars > altars0 && atDemons > 0 && prayed > 0 && xp > 0, { altars: Endgame.endgameStats.altars - altars0, atDemons, prayed, xp, outcome: task.outcome, state: task.state, at: [p.x, p.z] });
    check('demons: the protection off after, the trip over', t > 0 && p.getVar(lib.VarPlayerType.getId('prayer14')) === 0, { t, outcome: task.outcome });
    check('demons: walked, no unseen jump', moves.unseen().length === 0, { unseen: moves.unseen().slice(0, 3), causes: causesSince(c0) });
    Endgame.setEndgameTripTicksForTest(null);
    hold(p);
    free.push(p);
}

// ---- a Wilderness endgame spot: the deep dungeon's fire giants ----
if (want('wild')) {
    scene(SEED, 'wild');
    Core.resetEndgameTripsForTest();
    lib.WildTrips.setWildTripTicksForTest([1200, 1200]); // (the trip's clock runs from the bank: the walk north is about 500 steps)
    const p = take(b => levelling(b) && lib.WildTrips.isWildBold(b.username));
    check('wild: a bold levelling bot to stage', p !== null);
    if (p) {
        levels(p, veteran);
        kit(p, [], [[sword, 20], [Items.COINS, 500]], runeKit());
        place(p, 3094, 3493);
        const moves = watchMoves(p);
        const c0 = causesNow();
        const xp0 = p.stats[PlayerStat.STRENGTH] + p.stats[PlayerStat.HITPOINTS];
        const task = lib.WildTrips.wildTripTask(args.wild ?? 'firegiants');
        assign(p, task);
        let there = -1;
        let role = false;
        const t = run(7000, () => {
            moves.tick();
            if (args.debug && World.currentTick % 25 === 0) out(`t${World.currentTick} ${p.x},${p.z},${p.level} ${task.state} sub=${sim.botPlayer(p).subTask?.name ?? '-'}:${sim.botPlayer(p).subTask?.inner?.state ?? ''}`);
            if (there < 0 && p.z > 10300 && cheb(p.x, p.z, 3049, 10342) <= 10) {
                there = World.currentTick;
                role = lib.eventRoleOf(p)?.role === 'bosser';
            }
            return task.isComplete(p);
        });
        const xp = p.stats[PlayerStat.STRENGTH] + p.stats[PlayerStat.HITPOINTS] - xp0;
        check('wild: north to the deep Wilderness dungeon\'s stairs, through its gates to the fire giants, the role \'bosser\', fought (XP)', there > 0 && role && xp > 0, { there, role, xp, outcome: task.outcome, state: task.state, at: [p.x, p.z] });
        check('wild: the trip over, on the endgame\'s log, the role off', t > 0 && Core.tripLog.some(r => r.name === p.username && r.spot === 'firegiants') && lib.eventRoleOf(p) === null, { t });
        const unseen = moves.unseen().filter(j => cheb(j.to[0], j.to[1], 3222, 3218) > 12);
        check('wild: walked, no unseen jump', unseen.length === 0, { unseen: unseen.slice(0, 3), causes: causesSince(c0) });
    }
    lib.WildTrips.setWildTripTicksForTest(null);
    if (p) {
        hold(p);
        free.push(p);
    }
}

// ---- a KBD team ----
if (want('kbd')) {
    scene(SEED, 'kbd');
    Core.resetEndgameTripsForTest();
    lib.Teams.resetTeamsForTest();
    lib.Teams.setTeamTicksForTest(600);
    const big = { ATTACK: 92, STRENGTH: 95, DEFENCE: 90, HITPOINTS: 92, PRAYER: 60, RANGED: 50, MAGIC: 50 };
    const shield = id('antidragonbreathshield');
    const shark = id('shark');
    const team = [];
    for (let i = 0; i < 3; i++) {
        const b = take(x => levelling(x) && Endgame.hasBosserTrait(x.username));
        if (b) team.push(b);
    }
    check('kbd: three levelling bossers to stage', team.length === 3, team.length);
    // (no director's recruit cooldown on the staged bots; no other bot fit for a team: the earlier scenes' veterans' banks
    // and packs emptied)
    lib.resetDirectorForTest();
    // (and no other bot's planner offers a trip meanwhile: the staged leader's is the scene's)
    Endgame.setEndgameOffersForTest(false);
    for (const b of bots) {
        if (team.includes(b)) continue;
        hold(b);
        kit(b, [], [], []);
    }
    if (team.length === 3) {
        const [leader, ...rest] = team;
        team.forEach((b, i) => {
            levels(b, big);
            kit(b, [], [[shark, 20], [shield, 1], [Items.COINS, 500]], runeKit());
            place(b, 3092 + i, 3493);
            hold(b);
        });
        for (const b of rest) hold(b);
        const moves = team.map(watchMoves);
        const c0 = causesNow();
        const l0 = lines.length;
        const xp0 = team.map(b => b.stats[PlayerStat.STRENGTH] + b.stats[PlayerStat.HITPOINTS] + b.stats[PlayerStat.ATTACK] + b.stats[PlayerStat.DEFENCE]);
        if (args.debug) for (const b of rest) out(`recruit ${b.username}: free ${lib.isFreeForEvent(b)} session ${lib.BotManager.sessionLeftOf?.(b.username)} sub ${sim.botPlayer(b).hasSubTask()} fit ${lib.Teams.kbdFit(b)} wild ${lib.wildernessLevelAt(b.x, b.z)} role ${JSON.stringify(lib.eventRoleOf(b))} away ${lib.isAway(b)} conv ${lib.BotChat.inConversation(b)} fight ${World.currentTick < b.preventLogoutUntil} delayed ${b.delayed} trade ${b.botTradeTargetPid} come ${b.botComeHereReturnX} hp ${b.levels[PlayerStat.HITPOINTS]} habit ${lib.habitOf(b)} hold ${lib.holdsLogout(b)} recruited ${lib.recruitedLately(b.username)} ai ${!!lib.BotManager.botFor?.(b)}`);
        const task = lib.Teams.kbdLeaderTask(Endgame.shieldSteps, q => Endgame.hasBosserTrait(q.username));
        assign(leader, task);
        const inLair = new Set();
        let prayed = 0;
        const onTrip = new Set();
        const held = new Set();
        const t = run(6000, () => {
            // (each bot's moves while on its trip: after it, its next task's are its own)
            moves.forEach((m, i) => Core.tripOf(team[i])?.kind === 'kbd' && m.tick());
            // (round 1 fixes: each held once its KBD trip is over: its next pick may be a Wilderness endgame trip, a
            // bosser's errand too (the red dragons from Edgeville at seed 9), which kept the scene waiting)
            for (const b of team) {
                if (Core.tripOf(b)?.kind === 'kbd') onTrip.add(b);
                else if (onTrip.has(b) && !held.has(b)) {
                    held.add(b);
                    hold(b);
                }
            }
            if (args.debug && World.currentTick % 20 === 0) out(`t${World.currentTick} ${lib.Teams.kbdTeam()?.state} ` + team.map(b => `${b.username}@${b.x},${b.z},${b.level} run${b.run} tgt=${b.target?.username ?? b.target?.nid ?? '-'} op${b.targetOp} ${sim.botPlayer(b).currentTask?.state ?? sim.botPlayer(b).currentTask?.name} sub=${sim.botPlayer(b).subTask?.inner?.state ?? sim.botPlayer(b).subTask?.name ?? '-'} hp${b.levels[PlayerStat.HITPOINTS]}`).join(' | '));
            for (const b of team) {
                if (b.z > 6400 && b.x < 2800) inLair.add(b.username);
                if (b.z > 6400 && b.x < 2800 && b.getVar(lib.VarPlayerType.getId('prayer14')) === 1) prayed++;
            }
            return task.isComplete(leader) && team.every(b => !Core.tripOf(b));
        });
        const said = lines.slice(l0).filter(l => team.some(b => b.username === l.name));
        const calls = said.filter(l => l.kind === 'setpiece');
        const xp = team.map((b, i) => b.stats[PlayerStat.STRENGTH] + b.stats[PlayerStat.HITPOINTS] + b.stats[PlayerStat.ATTACK] + b.stats[PlayerStat.DEFENCE] - xp0[i]);
        const stats = lib.Teams.teamStats;
        // (the team: the leader and its 1-3 recruits, TEAM_SIZE's draw)
        const went = new Set(lib.Teams.teamLog.at(-1)?.members ?? []);
        check('kbd: the call at Edgeville bank (a set piece\'s line), a team of 2-3 of the three formed', calls.length >= 1 && stats.formed === 1 && stats.members[0] >= 2 && stats.members[0] <= 3, { calls: calls.slice(0, 4), stats, went: [...went] });
        check('kbd: the team down the west ladder and through the lever into the lair', went.size >= 2 && [...went].every(n => inLair.has(n)), { went: [...went], inLair: [...inLair] });
        check('kbd: fought the KBD (XP each), Protect from Melee on in the lair', team.every((b, i) => !went.has(b.username) || xp[i] > 0) && prayed > 0, { xp, prayed });
        check('kbd: the members near the leader on the way north (TRAVEL_NEAR, 5 tiles: a Follow trails a running leader; 60 %+)', stats.travelSamples > 0 && stats.travelNear / stats.travelSamples >= 0.6, { near: stats.travelNear, of: stats.travelSamples });
        // (round 1 fixes: the team's bots, the roles of all: a staged bot never recruited is let go by the planner's
        // 15 minutes without XP, and walked into the Edgeville dungeon at seed 9)
        check('kbd: out by the lever and the ladder, home, the roles off', t > 0 && team.every(b => (!went.has(b.username) || b.z < 6400) && lib.eventRoleOf(b) === null), { t, at: team.map(b => [b.x, b.z]), outcome: task.outcome, state: task.state });
        if (!(t > 0 && inLair.size >= 2)) out(`kbd debug: ${JSON.stringify(Core.tripLog.filter(r => team.some(b => b.username === r.name)))}`);
        // (a death's respawn at Lumbridge is the game's: the trip's own log has it, and none came back)
        const unseen = moves.flatMap(m => m.unseen()).filter(j => cheb(j.to[0], j.to[1], 3222, 3218) > 12);
        const deaths = Core.tripLog.filter(r => team.some(b => b.username === r.name) && r.died).length;
        check('kbd: walked, no unseen jump', unseen.length === 0, { unseen: unseen.slice(0, 3), causes: causesSince(c0) });
        check('kbd: no deaths in a short fight with 20 sharks each (the leave rule keeps food for the way home)', deaths === 0, { deaths, log: Core.tripLog.filter(r => team.some(b => b.username === r.name)) });
    }
    lib.Teams.setTeamTicksForTest(null);
    Endgame.setEndgameOffersForTest(true);
    for (const b of team) {
        hold(b);
        free.push(b);
    }
}

// ---- the lairs' ways out ----
if (want('exits')) {
    const cases = [
        ['kbd lair', [2717, 9806, 0], [3016, 3852, 0]],
        ['mage arena chamber', [2509, 4692, 0], [3092, 3953, 0]],
        ['deep wild dungeon', [3049, 10342, 0], [3044, 3929, 0]],
        ['heroes basement', [2906, 9905, 0], [2893, 3509, 0]],
        ['edgeville black demons', [3089, 9959, 0], [3096, 3470, 0]]
    ];
    for (const [name, from, to] of cases) {
        scene(SEED, `exit ${name}`);
        const p = take(levelling);
        levels(p, veteran);
        kit(p, [], [], []);
        // (only a bot that finished the Mage Arena is ever in its chamber: 274's pool takes no one else there)
        const arenaVarp = lib.VarPlayerType.getId('magearena');
        p.setVar(arenaVarp, name.startsWith('mage arena') ? 8 : 0);
        place(p, from[0], from[1], from[2]);
        const moves = watchMoves(p);
        const c0 = causesNow();
        const plan = { kind: 'Walk', key: name, at: to, build: () => [lib.Endgame.goTo(to, 3, 3000, 'out')] };
        const task = new lib.ErrandTask(plan);
        assign(p, task);
        const t = run(3500, () => {
            moves.tick();
            return task.isComplete(p);
        });
        const there = p.level === to[2] && cheb(p.x, p.z, to[0], to[1]) <= 6;
        check(`exits: from the ${name} out by the game's clicks, no unseen jump`, there && moves.unseen().length === 0, { t, at: [p.x, p.z, p.level], outcome: task.outcome, unseen: moves.unseen().slice(0, 2), causes: causesSince(c0) });
        hold(p);
        free.push(p);
    }
}

// ---- a drop's moment ----
if (want('drops')) {
    scene(SEED, 'drops');
    const p = take(levelling);
    // (any bots near: the gz is a bot's, whatever its kind)
    const near = [take(() => true), take(() => true), take(() => true), take(() => true)].filter(Boolean);
    near.forEach(b => hold(b));
    hold(p);
    place(p, 2900, 3420);
    near.forEach((b, i) => place(b, 2902 + i, 3422));
    const events = [];
    const off = Core.onEndgameEvent(e => events.push(e));
    const d0 = Fight.dropLog.length;
    // (three drops, a while apart: each its line, each its gz of 0-3 (0.5 a bot near): at least one gz in the three)
    const moments = [];
    for (const item of ['dragon_med_helm', 'dragon_chainbody', 'dragon_spear']) {
        // (round 1 fixes: the dropper back by the bots near if something it began before it was held moved it off: at
        // seed 9 it was 400 tiles west, by the Gnome Stronghold's agility course, when its drops came)
        if (p.level !== 0 || cheb(p.x, p.z, 2900, 3420) > 3) {
            hold(p);
            place(p, 2900, 3420);
        }
        const l0 = lines.length;
        Fight.dropMoment(p, id(item));
        run(40);
        const said = lines.slice(l0);
        // (its drop line: one of the endgame's pools; anything else it says meanwhile, a greeting, is its own business)
        const pool = new Set(['eg-drop-dmed', 'eg-drop-dchain', 'eg-drop-dragon'].flatMap(k => lib.pieceLines('endgame', k).map(l => l.text.toLowerCase())));
        moments.push({ own: said.filter(l => l.name === p.username && pool.has(l.line.toLowerCase().replace(/[^a-z ]/g, '').trim()) || (l.name === p.username && [...pool].some(t => l.line.toLowerCase().startsWith(t.slice(0, 5))))), gz: said.filter(l => l.name !== p.username && l.kind === 'botreply') });
    }
    off();
    check('drops: a dragon item\'s line always (kind event)', moments.every(m => m.own.length === 1 && m.own[0].kind === 'event'), moments.map(m => m.own));
    check('drops: the bots near say gz, at most 3 a drop', moments.some(m => m.gz.length >= 1) && moments.every(m => m.gz.length <= 3), { gz: moments.map(m => m.gz.length), near: near.length, log: Fight.dropLog.slice(d0), nearAt: near.map(b => [b.username, b.x, b.z, b.level, b.slot, b.is_bot]) });
    check('drops: the rare-drop event', events.filter(e => e.kind === 'rareDrop' && e.bot === p).length === 3, events.map(e => e.kind));
    check('drops: logged with its gz', Fight.dropLog.length === d0 + 3 && Fight.dropLog.slice(d0).every((d, i) => d.gz === moments[i].gz.length), Fight.dropLog.slice(d0));
    for (const b of [p, ...near]) {
        hold(b);
        free.push(b);
    }
}

// ---- a sale stint of its own drops ----
if (want('sale')) {
    scene(SEED, 'sale');
    DropSale.resetDropSalesForTest();
    const p = take(levelling);
    const chain = id('rune_chainbody');
    // (round 1 fixes, A3: two in its bank, one of them its drop)
    kit(p, [], [[chain, 2], [Items.COINS, 500]], []);
    place(p, 3180, 3436);
    check('sale: no stint without its own loot', Endgame.dropSaleFor(p, 0) === null);
    DropSale.noteDropGain(p, chain, 1);
    const stock = DropSale.saleStock(p);
    check('sale: the stock is its own loot it still owns', stock.get(chain) === 1 && stock.size === 1, [...stock]);
    const task = Endgame.dropSaleFor(p, 0);
    check('sale: a stint offered (the loot worth 10k+)', task !== null && task.name === 'DropSale', task?.name ?? null);
    check('sale: not again within 2 hours of play', Endgame.dropSaleFor(p, 0) === null);
    if (task) {
        sim.addHuman(3182, 3438, 0);
        assign(p, task);
        const l0 = lines.length;
        run(1500, () => lines.slice(l0).some(l => l.name === p.username && l.kind === 'trade'));
        const adverts = lines.slice(l0).filter(l => l.name === p.username && l.kind === 'trade');
        check('sale: its advert in the period\'s form ("selling rune chain 44k")', adverts.length > 0 && /rune chain/.test(adverts[0].line) && /\d+(\.\d)?k/.test(adverts[0].line), adverts.slice(0, 2));
        // ---- (round 1 fixes, A3, A6) its stock spent by its sales, the stint kept, put back when cut short ----
        const note = lib.ObjType.get(chain).certlink;
        const pack = () => p.getInventory(lib.InvType.INV);
        const packChains = () => (pack().getItemCount(chain) ?? 0) + (pack().getItemCount(note) ?? 0);
        const bankChains = () => p.getInventory(lib.bankInvId())?.getItemCount(chain) ?? 0;
        check('sale: out of the bank only its drop (1 rune chain), its own other chain left there', task.hasBanked && packChains() === 1 && bankChains() === 1, { pack: packChains(), bank: bankChains(), stock: [...task.stock] });
        const ai = sim.botPlayer(p);
        ai.planEnds = World.currentTick - 1;
        ai.rescanTimer = 599;
        run(3);
        check('sale: the planner\'s rescan (its plan over, as after 15 minutes without XP) leaves the stint be', ai.currentTask === task && !task.interrupted, ai.currentTask?.name ?? null);
        // (a sale: the note gone to a buyer and its coins in, the trade screens' end: tasks/BankstandTask afterTrade)
        const sold0 = Object.values(DropSale.saleStats.sold).reduce((a, n) => a + n, 0);
        pack().remove(note, 1);
        pack().add(Items.COINS, 40000);
        task.afterTrade(p, 'done');
        const sold = Object.values(DropSale.saleStats.sold).reduce((a, n) => a + n, 0) - sold0;
        check('sale: the sale noted and its stock spent: nothing more for sale, the stint over, its own chain still banked, no drop left on record', sold === 1 && task.stock.size === 0 && task.isComplete() && bankChains() === 1 && DropSale.saleStock(p).size === 0, { sold, stock: [...task.stock], over: task.isComplete(), bank: bankChains(), record: [...DropSale.saleStock(p)] });
        DropSale.noteDropGain(p, chain, 1);
        const again = Endgame.dropSaleTask(DropSale.saleStock(p));
        assign(p, again);
        run(800, () => again.hasBanked && again.state === 'idle');
        const carried = packChains();
        hold(p);
        check('sale: a stint cut short at its bank puts its stock back (no note left in the pack)', carried === 1 && packChains() === 0 && bankChains() === 1, { carried, pack: packChains(), bank: bankChains() });
    }
    hold(p);
    free.push(p);
}

// ---- (round 1 fixes, A5, A4) the gates: a two-hander's bosser; the Wilderness endgame spots' food ----
if (want('gates')) {
    scene(SEED, 'gates');
    Core.resetEndgameTripsForTest();
    const p = take(levelling);
    const big = { ATTACK: 92, STRENGTH: 95, DEFENCE: 90, HITPOINTS: 92, PRAYER: 60, RANGED: 50, MAGIC: 50 };
    levels(p, big);
    const shieldSpots = ['taverley-blue', 'taverley-black', 'heroes-blue'];
    kit(p, [], [[sword, 20], [id('dusty_key'), 1], [id('rune_2h_sword'), 1], [Items.COINS, 500]], [id('rune_full_helm'), id('rune_chainbody'), id('rune_platelegs')]);
    place(p, 2946, 3372);
    const twoHanded = Endgame.openSpots(p).map(s => s.key);
    check('gates: a bosser whose best weapon is a rune 2h: no shield spot (no shield beside it), no KBD', !twoHanded.some(k => shieldSpots.includes(k)) && !lib.Teams.kbdFit(p), { open: twoHanded, kbd: lib.Teams.kbdFit(p) });
    kit(p, [], [[sword, 20], [id('dusty_key'), 1], [Items.COINS, 500]], runeKit());
    const scimitar = Endgame.openSpots(p).map(s => s.key);
    check('gates: its best a rune scimitar, the shield spots and the KBD open', shieldSpots.every(k => scimitar.includes(k)) && lib.Teams.kbdFit(p), { open: scimitar, kbd: lib.Teams.kbdFit(p) });
    levels(p, veteran);
    kit(p, [], [[Items.COINS, 500]], runeKit());
    place(p, 3094, 3493);
    const ruins = lib.WildTrips.wildTripTask('ruins');
    check('gates: no Demonic Ruins trip without 12 pieces of good food (at full Hitpoints)', ruins !== null && !ruins.plan.ok(p), ruins?.name ?? null);
    kit(p, [], [[sword, 20], [Items.COINS, 500]], runeKit());
    check('gates: 20 swordfish banked: it may go', ruins !== null && ruins.plan.ok(p));
    if (ruins) {
        assign(p, ruins);
        run(400, () => (p.getInventory(lib.InvType.INV).getItemCount(sword) ?? 0) > 0);
        run(2);
        const carried = p.getInventory(lib.InvType.INV).getItemCount(sword) ?? 0;
        check('gates: its bank stop takes 15-20 of them (the solo trips\' carry)', carried >= 15 && carried <= 20, { carried, state: ruins.state });
    }
    hold(p);
    free.push(p);
}

// ---- (round 1 fixes, A1, A2) bossers killed on the way: never back north from Lumbridge ----
const DEATH = lib.ScriptProvider.getByName('[queue,player_death]');
const SPAWN = [3222, 3218];
/**
 * `bots` killed (274's death queued) once `ready()`: each one's trip over at Lumbridge, how far from the spawn a respawned
 * one walked while still on its trip (a walk back north), whether its trip's log has the death
 */
function killOnTheWay(bots, ready, maxTicks = 4000) {
    const t0 = run(maxTicks, ready);
    if (t0 < 0) return { t0, t1: -1 };
    for (const b of bots) b.enqueueScript(DEATH, lib.PlayerQueueType.NORMAL, 0, []);
    const back = new Set();
    const held = new Set();
    let far = 0;
    const t1 = run(900, () => {
        for (const b of bots) {
            if (!back.has(b) && b.level === 0 && cheb(b.x, b.z, SPAWN[0], SPAWN[1]) <= 12) back.add(b);
            if (!back.has(b)) continue;
            if (Core.tripOf(b)) far = Math.max(far, cheb(b.x, b.z, SPAWN[0], SPAWN[1]));
            else if (!held.has(b)) {
                held.add(b);
                hold(b);
            }
        }
        return bots.every(b => back.has(b) && !Core.tripOf(b));
    });
    const died = bots.map(b => Core.tripLog.filter(r => r.name === b.username).at(-1)?.died ?? false);
    return { t0, t1, back: back.size, far, died };
}
/** the KBD scenes' bots: `n` levelling bossers fit for the KBD at Edgeville bank, every other bot held and fit for nothing */
function kbdStage(n) {
    Core.resetEndgameTripsForTest();
    lib.Teams.resetTeamsForTest();
    lib.resetDirectorForTest();
    Endgame.setEndgameOffersForTest(false);
    const big = { ATTACK: 92, STRENGTH: 95, DEFENCE: 90, HITPOINTS: 92, PRAYER: 60, RANGED: 50, MAGIC: 50 };
    const team = [];
    for (let i = 0; i < n; i++) {
        const b = take(x => levelling(x) && Endgame.hasBosserTrait(x.username));
        if (b) team.push(b);
    }
    for (const b of bots) {
        if (team.includes(b)) continue;
        hold(b);
        kit(b, [], [], []);
    }
    team.forEach((b, i) => {
        levels(b, big);
        kit(b, [], [[id('shark'), 20], [id('antidragonbreathshield'), 1], [Items.COINS, 500]], runeKit());
        place(b, 3092 + i, 3493);
        hold(b);
    });
    return team;
}
function kbdUnstage(team) {
    Endgame.setEndgameOffersForTest(true);
    for (const b of team) {
        hold(b);
        free.push(b);
    }
}
if (want('deaths')) {
    // a solo trip: on its way from Falador to Taverley's hellhounds
    scene(SEED, 'deaths solo');
    Core.resetEndgameTripsForTest();
    const p = take(levelling);
    levels(p, veteran);
    kit(p, [], [[sword, 20], [id('dusty_key'), 1], [Items.COINS, 500]], runeKit());
    place(p, 2946, 3372);
    const solo = Endgame.soloTripTask('taverley-hounds');
    assign(p, solo);
    const s = killOnTheWay([p], () => solo.state === 'to the spot' && cheb(p.x, p.z, 2946, 3372) >= 15, 1500);
    check('deaths: a solo trip\'s bosser killed on its way: its trip over at Lumbridge, logged a death, never walked back', s.t1 > 0 && s.far <= 12 && s.died.every(Boolean), s);
    hold(p);
    free.push(p);
    // a Wilderness endgame trip: on its waypoints north to the deep dungeon's fire giants
    scene(SEED, 'deaths wild');
    Core.resetEndgameTripsForTest();
    const w = take(levelling);
    levels(w, veteran);
    kit(w, [], [[sword, 20], [Items.COINS, 500]], runeKit());
    place(w, 3094, 3493);
    const wild = lib.WildTrips.wildTripTask('firegiants');
    assign(w, wild);
    const r = killOnTheWay([w], () => wild.state === 'via' && w.z >= 3535, 1500);
    check('deaths: a Wilderness endgame trip\'s bosser killed on its waypoints: its trip over, logged a death, never walked back', r.t1 > 0 && r.far <= 12 && r.died.every(Boolean), r);
    hold(w);
    free.push(w);
    // a KBD team: its leader and its member near the ladder (Track B's lever camp 12, 4 tiles from it)
    scene(SEED, 'deaths kbd');
    const team = kbdStage(2);
    check('deaths: two levelling bossers for a KBD team', team.length === 2, team.length);
    if (team.length === 2) {
        const [leader] = team;
        const task = lib.Teams.kbdLeaderTask(Endgame.shieldSteps, q => Endgame.hasBosserTrait(q.username));
        assign(leader, task);
        const LADDER = Locations.KBD_LADDER;
        const k = killOnTheWay(team, () => lib.Teams.kbdTeam()?.state === 'travel' && leader.level === 0 && leader.z < 6400 && cheb(leader.x, leader.z, LADDER[0], LADDER[1]) <= 25);
        check('deaths: a KBD leader and member killed near the ladder: their trips over at Lumbridge, logged deaths, neither walked back', k.t1 > 0 && k.far <= 12 && k.died.every(Boolean), k);
        check('deaths: the team over with its leader (no team left set world-wide)', lib.Teams.kbdTeam() === null && lib.Teams.teamLog.at(-1)?.outcome === 'died', { team: lib.Teams.kbdTeam()?.state ?? null, log: lib.Teams.teamLog.at(-1) });
    }
    kbdUnstage(team);
}

// ---- (round 1 fixes, A2) a KBD leader's errand cut short on the way: the team ends with it ----
if (want('kbd-abort')) {
    scene(SEED, 'kbd-abort');
    const team = kbdStage(2);
    check('kbd-abort: two levelling bossers for a KBD team', team.length === 2, team.length);
    if (team.length === 2) {
        const [leader, member] = team;
        const task = lib.Teams.kbdLeaderTask(Endgame.shieldSteps, q => Endgame.hasBosserTrait(q.username));
        assign(leader, task);
        const t0 = run(3000, () => lib.Teams.kbdTeam()?.state === 'travel' && sim.botPlayer(member).currentTask?.state === 'follow the leader');
        run(20);
        const aborted0 = lib.Teams.teamStats.aborted;
        // (its errand cut short, as the danger check, a session's end or a "come here" cut a task)
        hold(leader);
        const t1 = run(60, () => lib.Teams.kbdTeam() === null && !Core.tripOf(member));
        check('kbd-abort: the leader\'s errand cut short on the way: the team over (aborted), a KBD team free to call again', t0 > 0 && lib.Teams.kbdTeam() === null && lib.Teams.teamStats.aborted === aborted0 + 1, { t0, team: lib.Teams.kbdTeam()?.state ?? null, aborted: lib.Teams.teamStats.aborted - aborted0, log: lib.Teams.teamLog.at(-1) });
        check('kbd-abort: its member stops following, its trip over', t1 > 0 && !Core.tripOf(member), { t1, state: sim.botPlayer(member).currentTask?.state ?? null });
    }
    kbdUnstage(team);
}

// ---- (round 1 fixes, A7) a solo trip's last line: its food as the fight ended ----
if (want('food-out')) {
    scene(SEED, 'food-out');
    const p = take(levelling);
    const mate = take(() => true);
    levels(p, veteran);
    hold(p);
    place(p, 2946, 3372);
    if (mate) {
        hold(mate);
        place(mate, 2948, 3373);
    }
    const spot = Endgame.SOLO_SPOTS.find(s => s.key === 'heroes-blue');
    const kinds0 = { ...Fight.endgameLineStats.byKind };
    for (let i = 0; i < 40; i++) {
        // (the trip begins with its pack full; its fight ends with 2 left; then its last steps: the prayers, the line)
        kit(p, [[sword, 20]], [], runeKit());
        const steps = Endgame.soloTrip(spot).build(p);
        kit(p, [[sword, 2]], [], runeKit());
        let k = steps.findIndex(st => /prayers off/.test(st.label));
        for (let n = 0; n < 2 && k >= 0 && k < steps.length; n++) if (steps[k].tick(p, null) === 'done') k++;
        run(1);
    }
    const said = kind => (Fight.endgameLineStats.byKind[kind] ?? 0) - (kinds0[kind] ?? 0);
    check("food-out: a trip's fight over with 2 pieces of food left: its line 'eg-food-out', never 'eg-done'", said('eg-food-out') >= 1 && said('eg-done') === 0, { foodOut: said('eg-food-out'), done: said('eg-done') });
    hold(p);
    free.push(p);
    if (mate) free.push(mate);
}

// ---- (bots ideas, the KQ track: A4) a Kalphite Queen attempt, the real way in, the fight, the way out ----
const Kq = lib.Kq;
const KQ_BIG = { ATTACK: 92, STRENGTH: 95, DEFENCE: 90, HITPOINTS: 92, PRAYER: 60, RANGED: 50, MAGIC: 50 };
/** the KQ scenes' bots: `n` levelling bossers of the bar (`leaderAt` the first's tile, the rest by Al Kharid bank), every other bot held and fit for nothing; `ropes` banked by the leader */
function kqStage(n, leaderAt, ropes = 0) {
    Core.resetEndgameTripsForTest();
    lib.Teams.resetTeamsForTest();
    Kq.resetKqForTest();
    lib.resetDirectorForTest();
    Endgame.setEndgameOffersForTest(false);
    queenReset();
    const team = [];
    for (let i = 0; i < n; i++) {
        const b = take(x => levelling(x) && Endgame.hasBosserTrait(x.username));
        if (b) team.push(b);
    }
    for (const b of bots) {
        if (team.includes(b)) continue;
        hold(b);
        kit(b, [], [], []);
    }
    team.forEach((b, i) => {
        levels(b, KQ_BIG);
        kit(b, [], [[id('shark'), 20], [Items.COINS, 1000], ...(i === 0 && ropes ? [[id('rope'), ropes]] : [])], runeKit());
        if (i === 0) place(b, leaderAt[0], leaderAt[1]);
        else place(b, 3268 + i, 3166);
        hold(b);
    });
    return team;
}
/** (each KQ scene from the queen's first form at her full Hitpoints: an earlier scene's fight may have left her flying) */
function queenReset() {
    const q = lib.findNpcFiltered(3476, 9498, 0, n => [lib.NpcType.getId('kalphite_queen'), lib.NpcType.getId('kalphite_flyingqueen')].includes(n.type) && n.isActive, 30);
    if (q) q.resetEntity(true);
}
function kqUnstage(team) {
    Endgame.setEndgameOffersForTest(true);
    Kq.setChamberTicksForTest(null);
    for (const b of team) {
        hold(b);
        free.push(b);
    }
}
const queenTypes = () => [lib.NpcType.getId('kalphite_queen'), lib.NpcType.getId('kalphite_flyingqueen')];
const queenNow = () => lib.findNpcFiltered(3476, 9498, 0, n => queenTypes().includes(n.type) && n.isActive && n.levels[3] > 0, 30);
/**
 * the attempt run with its leader's task: each bot's journey watched (its passes, waterskins, ropes, the gate's crossing,
 * Protect from Magic in the chamber, its moves), until the leader's task is over and no bot is on the trip
 */
function kqRun(team, task, maxTicks, during = () => {}) {
    const [leader] = team;
    const pass = id('shantay_pass');
    const skin = id('water_skin4');
    const rope = id('rope');
    const disclaimer = id('thshantaydisc');
    const watch = new Map(team.map(b => [b, { pass: 0, skins: 0, ropes: 0, coins0: b.getInventory(lib.InvType.INV).getItemCount(Items.COINS), crossed: -1, passAt: -1, disclaimer: false, prayed: 0, inChamber: 0, moves: watchMoves(b), onTrip: false, held: false }]));
    const c0 = causesNow();
    const l0 = lines.length;
    assign(leader, task);
    let lastNorth = new Map();
    const t = run(maxTicks, () => {
        for (const b of team) {
            const w = watch.get(b);
            const inv = b.getInventory(lib.InvType.INV);
            if (Core.tripOf(b)?.kind === 'kq') {
                w.onTrip = true;
                w.moves.tick();
            } else if (w.onTrip && !w.held) {
                w.held = true;
                hold(b);
            }
            w.pass = Math.max(w.pass, inv.getItemCount(pass));
            w.skins = Math.max(w.skins, inv.getItemCount(skin) + inv.getItemCount(id('water_skin3')) + inv.getItemCount(id('water_skin2')));
            w.ropes = Math.max(w.ropes, inv.getItemCount(rope));
            if (inv.getItemCount(disclaimer) > 0) w.disclaimer = true;
            // (the gate: from its north side to its south side, the pass handed over)
            if (b.level === 0 && b.z >= 3117 && b.z <= 3125 && Math.abs(b.x - 3303) <= 4) lastNorth.set(b, World.currentTick);
            if (w.crossed < 0 && b.level === 0 && b.z <= 3115 && b.z >= 3110 && Math.abs(b.x - 3303) <= 4 && lastNorth.has(b)) {
                w.crossed = World.currentTick;
                w.passAt = inv.getItemCount(pass);
            }
            if (Kq.inChamber(b)) {
                w.inChamber++;
                if (b.getVar(lib.VarPlayerType.getId('prayer12')) === 1) w.prayed++;
            }
        }
        during();
        if (args.debug && World.currentTick % 25 === 0) {
            const tm = Kq.kqTeam();
            const q = queenNow();
            out(`t${World.currentTick} ${tm?.state ?? '-'} q=${q ? `${lib.NpcType.get(q.type).debugname}:${q.levels[3]}` : '-'} ` + team.map(b => `${b.username}@${b.x},${b.z},${b.level} hp${b.levels[PlayerStat.HITPOINTS]} pr${b.levels[PlayerStat.PRAYER]} f${Fight.goodFoodCarried(b)} ${sim.botPlayer(b).currentTask?.state ?? sim.botPlayer(b).currentTask?.name}`).join(' | '));
        }
        return task.isComplete(leader) && team.every(b => !Core.tripOf(b));
    });
    const said = lines.slice(l0).filter(l => team.some(b => b.username === l.name));
    const unseen = team.flatMap(b => watch.get(b).moves.unseen()).filter(j => cheb(j.to[0], j.to[1], 3222, 3218) > 12);
    return { t, watch, said, unseen, causes: causesSince(c0), log: Kq.kqLog.at(-1) ?? null };
}
if (want('kq')) {
    // the whole attempt: the leader from Draynor (Ned's ropes), its recruits by Al Kharid bank
    scene(SEED, 'kq');
    const team = kqStage(5, [3092, 3247]);
    check('kq: five levelling bossers of the bar to stage', team.length === 5 && team.every(b => Kq.kqFit(b)), team.map(b => [b.username, b.combatLevel, Kq.kqFit(b)]));
    if (team.length === 5) {
        const [leader] = team;
        const task = Kq.kqLeaderTask(q => Endgame.hasBosserTrait(q.username));
        const tm = () => Kq.kqTeam();
        let kept = null;
        const r = kqRun(team, task, 9000, () => {
            if (tm()) kept = tm();
        });
        const went = kept ? [...kept.members] : [];
        const w = b => r.watch.get(b);
        const stats = Kq.kqStats;
        check('kq: the leader bought 2 ropes from Ned (15 coins each)', w(leader).ropes === 2 && stats.ropes === 2, { ropes: w(leader).ropes, stats });
        check('kq: the call at Al Kharid bank (a set piece\'s line), a team of 4-5 formed', stats.calls === 1 && stats.formed === 1 && went.length >= 4 && went.length <= 5 && r.said.some(l => l.kind === 'setpiece'), { stats, went: went.map(b => b.username), said: r.said.slice(0, 6) });
        check('kq: each bought 2 waterskins and a pass from Shantay', went.every(b => w(b).skins >= 2 && w(b).pass >= 1), went.map(b => [b.username, w(b).skins, w(b).pass]));
        check('kq: each through the Shantay Pass the game\'s way (the pass handed over, the disclaimer given, no jump)', went.every(b => w(b).crossed > 0 && w(b).passAt === 0 && w(b).disclaimer) && !r.causes.some(c => /ShantayPass/.test(c)), { crossed: went.map(b => [b.username, w(b).crossed, w(b).passAt, w(b).disclaimer]), causes: r.causes });
        const rope0 = kept?.burrowRoped ?? -1;
        check('kq: the leader\'s rope on the burrow, each down within its 200 ticks', rope0 > 0 && went.every(b => kept.downAt.has(b) && kept.downAt.get(b) - rope0 <= Kq.ROPE_TICKS), { rope0, down: went.map(b => [b.username, kept?.downAt.get(b) ?? null]) });
        // (each that came through the tunnels alive: their soldiers and guardians hunt everyone)
        const throughTunnels = went.filter(b => kept?.chamberAt.has(b) || !kept?.died.has(b));
        check('kq: the second rope on the chamber\'s entrance, each through the tunnels down into the chamber', (kept?.chamberRoped ?? -1) > rope0 && throughTunnels.length >= 4 && throughTunnels.every(b => kept.chamberAt.has(b)), { chamberRoped: kept?.chamberRoped, chamber: went.map(b => [b.username, kept?.chamberAt.get(b) ?? null, kept?.died.has(b) ?? null]) });
        const inside = went.filter(b => kept?.chamberAt.has(b));
        check('kq: Protect from Magic on in the chamber, each', inside.length > 0 && inside.every(b => w(b).prayed > 0), went.map(b => [b.username, w(b).inChamber, w(b).prayed]));
        const flee = (kept?.leaves ?? []).filter(l => l.why === 'flee');
        check('kq: a bot that left by its own rule did so under 40 % of its Hitpoints with 2 or fewer pieces of food', flee.every(l => l.hp < Kq.KQ_FLEE_HP && l.food <= Kq.KQ_FLEE_FOOD) && (kept?.leaves.length ?? 0) + (kept?.died.size ?? 0) >= went.length, { leaves: kept?.leaves, died: [...(kept?.died ?? [])].map(b => b.username) });
        check('kq: the attempt over, logged; the roles off; the survivors out of the lair and north of the pass', r.t > 0 && r.log !== null && team.every(b => lib.eventRoleOf(b) === null) && went.filter(b => !kept.died.has(b)).every(b => b.z < 6400 && b.z > 3116), { t: r.t, log: r.log, at: team.map(b => [b.username, b.x, b.z, b.level]) });
        check('kq: walked, no unseen jump (a death\'s respawn aside)', r.unseen.length === 0, { unseen: r.unseen.slice(0, 3), causes: r.causes });
        out(`kq: the attempt: ${JSON.stringify(r.log)}; lines: ${r.said.map(l => `${l.name}: ${l.line}`).join(' / ')}`);
    }
    kqUnstage(team);
}

// ---- (the KQ track) a member killed in the chamber (274's death queued), another hurt with its food nearly gone: its own
// leave rule, out by the chamber's rope and the burrow's, north of the pass; half gone, the team runs ----
if (want('kq-death')) {
    // (the overlay put in place as the runtime does, from here on: a bot's death as in the app, its items kept; the
    // scenes before ran the vanilla scripts as always)
    const replaced = overlayBins ? lib.installBotsContent(overlayBins.bin, overlayBins.dat, overlayBins.idx) : 0;
    check('kq-death: the content overlay in place (patch 0003: a bot keeps its items when it dies)', replaced > 0, `${replaced} scripts`);
    scene(SEED, 'kq-death');
    const team = kqStage(4, [3271, 3164], 2);
    check('kq-death: four levelling bossers of the bar to stage', team.length === 4, team.length);
    if (team.length === 4) {
        const task = Kq.kqLeaderTask(q => Endgame.hasBosserTrait(q.username));
        let kept = null;
        let dead = null;
        let hurt = null;
        let killedAt = -1;
        let hurtAt = -1;
        const back = { far: 0, atSpawn: -1, worn: null };
        const path = { tunnels: -1, surface: -1, north: -1 };
        const r = kqRun(team, task, 7000, () => {
            const t = Kq.kqTeam();
            if (t) kept = t;
            if (!kept) return;
            // (once all four fight in the chamber a while: one killed, another hurt with 2 pieces of food left)
            if (killedAt < 0 && kept.state === 'chamber' && kept.chamberAt.size === 4 && World.currentTick - kept.fightAt >= 20) {
                dead = team.find(b => b !== team[0] && Kq.inChamber(b));
                hurt = team.find(b => b !== team[0] && b !== dead && Kq.inChamber(b));
                if (dead && hurt) {
                    killedAt = World.currentTick;
                    dead.enqueueScript(DEATH, lib.PlayerQueueType.NORMAL, 0, []);
                    hurtAt = World.currentTick;
                    const inv = hurt.getInventory(lib.InvType.INV);
                    for (const n of Fight.ENDGAME_FOOD) {
                        const f = id(n);
                        const have = inv.getItemCount(f);
                        if (have > 0) inv.remove(f, have);
                    }
                    inv.add(id('shark'), 2);
                    hurt.levels[PlayerStat.HITPOINTS] = Math.floor(hurt.baseLevels[PlayerStat.HITPOINTS] * 0.38);
                }
            }
            if (dead && killedAt > 0) {
                if (back.atSpawn < 0 && dead.level === 0 && cheb(dead.x, dead.z, SPAWN[0], SPAWN[1]) <= 12) {
                    back.atSpawn = World.currentTick;
                    const worn = dead.getInventory(lib.InvType.WORN);
                    back.worn = [];
                    for (let k = 0; k < worn.capacity; k++) if (worn.get(k)) back.worn.push(lib.ObjType.get(worn.get(k).id).debugname);
                }
                if (back.atSpawn > 0 && Core.tripOf(dead)) back.far = Math.max(back.far, cheb(dead.x, dead.z, SPAWN[0], SPAWN[1]));
            }
            if (hurt && hurtAt > 0) {
                if (path.tunnels < 0 && Kq.inTunnels(hurt)) path.tunnels = World.currentTick;
                if (path.tunnels > 0 && path.surface < 0 && hurt.z < 6400) path.surface = World.currentTick;
                if (path.surface > 0 && path.north < 0 && hurt.z >= 3117 && hurt.z < 3200) path.north = World.currentTick;
            }
        });
        const deadLog = dead ? Core.tripLog.filter(x => x.name === dead.username).at(-1) : null;
        check('kq-death: a member killed in the chamber: its trip over at Lumbridge, logged a death, never walked back', killedAt > 0 && back.atSpawn > 0 && back.far <= 12 && deadLog?.died === true && kept?.died.has(dead), { killedAt, back, deadLog });
        check('kq-death: its items kept, as every bot\'s death today (its rune kit still worn)', ['rune_chainbody', 'rune_platelegs', 'rune_full_helm'].every(n => back.worn?.includes(n)), { worn: back.worn });
        const hurtLeave = hurt ? kept?.leaves.find(l => l.name === hurt.username) : null;
        check('kq-death: the hurt one leaves by its own rule (under 40 %, 2 pieces of food or fewer)', hurtLeave?.why === 'flee' && hurtLeave.hp < Kq.KQ_FLEE_HP && hurtLeave.food <= Kq.KQ_FLEE_FOOD, { hurtLeave, leaves: kept?.leaves });
        // (or dead on its way out, the chamber's spines and guardians at it: logged a death, never back)
        const hurtDied = hurt ? Core.tripLog.filter(x => x.name === hurt.username).at(-1)?.died === true : false;
        check('kq-death: out by the chamber\'s rope, then the burrow\'s, then north through the pass (or dead on the way, logged)', (path.tunnels > hurtAt && path.surface > path.tunnels && path.north > path.surface) || (hurtDied && kept?.died.has(hurt)), { ...path, hurtDied });
        check('kq-death: half of the chamber gone: the team runs ("nvm run"), every bot out of the chamber', kept !== null && kept.leaves.filter(l => l.why === 'team').length >= 1 && team.every(b => !Kq.inChamber(b) && !Kq.inTunnels(b)), { leaves: kept?.leaves, at: team.map(b => [b.username, b.x, b.z, b.level]) });
        check('kq-death: walked, no unseen jump (the death\'s respawn aside)', r.unseen.length === 0, { unseen: r.unseen.slice(0, 3), causes: r.causes });
    }
    kqUnstage(team);
}

// ---- (the KQ track) a staged kill: the queen's Hitpoints set to 1 in each form, the bots' own blows end her: 274's death
// scripts and her drop table (kalphite_queen.rs2) ----
if (want('kq-kill')) {
    scene(SEED, 'kq-kill');
    const team = kqStage(4, [3271, 3164], 2);
    check('kq-kill: four levelling bossers of the bar to stage', team.length === 4, team.length);
    if (team.length === 4) {
        const task = Kq.kqLeaderTask(q => Endgame.hasBosserTrait(q.username));
        const events = [];
        const off = Core.onEndgameEvent(e => events.push(e));
        const hashes = new Set(team.map(b => b.hash64));
        const drops = new Map();
        let kept = null;
        const staged = new Set();
        const r = kqRun(team, task, 7000, () => {
            const t = Kq.kqTeam();
            if (t) kept = t;
            if (!kept || kept.fightAt < 0 || World.currentTick - kept.fightAt < 10) return;
            const q = queenNow();
            if (q && kept.state === 'chamber' && !staged.has(q.type) && q.levels[3] > 1) {
                staged.add(q.type);
                q.levels[3] = 1;
            }
            if (args.debug && kept.kill && !drops.size) {
                for (let zx = 3456; zx <= 3500; zx += 8) for (let zz = 9480; zz <= 9520; zz += 8) for (const o of World.gameMap.getZone(zx, zz, 0)?.getAllObjsSafe() ?? []) out(`obj ${lib.ObjType.get(o.type).debugname}@${o.x},${o.z} r=${o.receiver64} team=${[...hashes].join(',')}`);
            }
            // (the drops in the chamber whose receiver is one of the team)
            // (the whole chamber: she moves while she fights)
            for (let zx = 3448; zx <= 3528; zx += 8) {
                for (let zz = 9464; zz <= 9536; zz += 8) {
                    for (const o of World.gameMap.getZone(zx, zz, 0)?.getAllObjsSafe() ?? []) if (hashes.has(o.receiver64)) drops.set(o, lib.ObjType.get(o.type).debugname);
                }
            }
        });
        off();
        const TABLE = /^(rune_chainbody|lava_battlestaff|rune_warhammer|rune_axe|adamant_spear|mithril_arrow|iron_arrow|rune_arrow|bigoysterpearls|bloodrune|naturerune|firerune|lawrune|deathrune|cert_wine_of_zamorak|amulet_of_power|lobster|dragon_chainbody)$|uncut|gem|sapphire|emerald|ruby|diamond|dragonstone|half|tooth|loop|clue|trail/;
        const items = [...drops.values()];
        // (the KQ fixes, KQ-2: form 1's fall logged as all of it dealt: form1Low 0, not her last Hitpoints seen in it)
        check('kq-kill: form 1 fell ("phase 2"), then form 2: the kill seen, logged (form 1 dealt in full)', kept?.phase2 === true && kept?.kill === true && r.log?.outcome === 'kill' && r.log?.form1Low === 0 && Kq.kqStats.kills === 1, { log: r.log, staged: [...staged] });
        check('kq-kill: her drop the game\'s table\'s (kalphite_queen.rs2), its receiver one of the team', items.length >= 1 && items.every(n => TABLE.test(n)), items);
        check('kq-kill: the kill\'s event (bossKill at the KQ)', events.some(e => e.kind === 'bossKill' && e.data.spot === 'kq'), events.map(e => `${e.kind}:${e.data.spot ?? e.data.kind ?? ''}`));
        check('kq-kill: walked, no unseen jump', r.unseen.length === 0, { unseen: r.unseen.slice(0, 3), causes: r.causes });
        out(`kq-kill: drops ${items.join(', ')}; lines: ${r.said.filter(l => l.kind !== 'idle').map(l => `${l.name}: ${l.line}`).join(' / ')}`);
    }
    kqUnstage(team);
}

// ---- (the KQ track) who may lead: the bar, 3 more free of it (no team can form: no offer, no dice), the world's 4-hour
// cap from an attempt's call ----
if (want('kq-cap')) {
    scene(SEED, 'kq-cap');
    const team = kqStage(4, [3271, 3164], 2);
    check('kq-cap: four levelling bossers of the bar to stage', team.length === 4, team.length);
    if (team.length === 4) {
        const [leader, a, b, c] = team;
        const bosser = q => Endgame.hasBosserTrait(q.username);
        const draws = f => {
            const r0 = Math.random;
            let n = 0;
            Math.random = () => {
                n++;
                return r0();
            };
            try {
                return [f(), n];
            } finally {
                Math.random = r0;
            }
        };
        const [ok4, d4] = draws(() => Kq.mayLeadKq(leader, bosser));
        check('kq-cap: the leader and 3 more of the bar free: it may lead, no dice drawn', ok4 === true && d4 === 0, { ok4, d4 });
        // (one of them without its food: 2 more only)
        kit(c, [], [[Items.COINS, 1000]], runeKit());
        const [ok3, d3] = draws(() => Kq.mayLeadKq(leader, bosser));
        check('kq-cap: only 2 more of the bar: no team can form, no offer, no dice drawn', ok3 === false && d3 === 0 && !Kq.kqFit(c), { ok3, d3 });
        // (the planner's offers on for the leader's: the scene's other bots are held, their kits empty)
        Endgame.setEndgameOffersForTest(true);
        Core.resetEndgameTripsForTest();
        const offers = [];
        for (let i = 0; i < 300; i++) offers.push(Endgame.endgameFor(leader, 0)?.name ?? null);
        check('kq-cap: its planner\'s offers never a KQ then', !offers.includes('KqTeam:kq'), [...new Set(offers)]);
        kit(c, [], [[id('shark'), 20], [Items.COINS, 1000]], runeKit());
        Core.resetEndgameTripsForTest();
        // (300 draws: the KQ's weight is the bot's taste for demons, as low as 0.2 against 5-6 other spots: 30 missed it at seed 4)
        const offers2 = [];
        for (let i = 0; i < 300; i++) {
            offers2.push(Endgame.endgameFor(leader, 0)?.name ?? null);
            Core.resetEndgameTripsForTest();
        }
        check('kq-cap: with 3 more free, the offer may be a KQ attempt (among its spots, by taste)', offers2.includes('KqTeam:kq'), [...new Set(offers2)]);
        Endgame.setEndgameOffersForTest(false);
        // (an attempt's call: the cap from then, world-wide)
        const task = Kq.kqLeaderTask(bosser);
        assign(leader, task);
        const t0 = run(2000, () => Kq.kqStats.calls === 1);
        check('kq-cap: the call made (a team of the four)', t0 > 0 && Kq.kqTeam() !== null, { t0, team: Kq.kqTeam()?.members.map(m => m.username) });
        check('kq-cap: a team under way: no other may lead', !Kq.mayLeadKq(a, bosser));
        for (const x of team) hold(x);
        run(5, () => Kq.kqTeam() === null);
        check('kq-cap: the attempt over (cut short): still none for 4 hours of play world-wide', Kq.kqTeam() === null && !Kq.mayLeadKq(a, bosser) && !Kq.mayLeadKq(b, bosser), { team: Kq.kqTeam()?.state ?? null });
        // (as 4 hours of play on: the bots' own trip gaps over, the director's cooldowns gone)
        Core.resetEndgameTripsForTest();
        lib.resetDirectorForTest();
        Kq.noteKqCallForTest(World.currentTick - Kq.KQ_GAP + 1);
        const just = Kq.mayLeadKq(a, bosser);
        Kq.noteKqCallForTest(World.currentTick - Kq.KQ_GAP);
        check('kq-cap: 4 hours of play after the call, an attempt may come again (not a tick before)', !just && Kq.mayLeadKq(a, bosser), { just });
        // (a call nobody can answer: 2 of the four without food; it calls again twice, 3 minutes apart, then gives up, and
        // takes nothing of the world's gap)
        Kq.resetKqForTest();
        Core.resetEndgameTripsForTest();
        lib.resetDirectorForTest();
        for (const x of [b, c]) kit(x, [], [[Items.COINS, 1000]], runeKit());
        const l0 = lines.length;
        const lone = Kq.kqLeaderTask(bosser);
        assign(leader, lone);
        const tn = run(2000, () => Kq.kqStats.nobody === 1);
        const calls = lines.slice(l0).filter(l => l.name === leader.username && l.kind === 'setpiece').map(l => l.line);
        check('kq-cap: fewer than 3 free: the leader calls 3 times, 3 minutes apart (the one free answers and sets off), then "nvm"; no team', tn > 0 && Kq.kqStats.calls === 1 && Kq.kqStats.recalls === 2 && Kq.kqStats.formed === 0 && Kq.kqTeam() === null && calls.length >= 3 && Kq.kqLog.at(-1)?.outcome === 'nobody' && Kq.kqLog.at(-1)?.members.includes(a.username), { tn, stats: Kq.kqStats, calls, log: Kq.kqLog.at(-1) });
        run(30);
        check('kq-cap: the one that set off: its trip over with the team, its role off', !Core.tripOf(a) && lib.eventRoleOf(a) === null, { trip: Core.tripOf(a), role: lib.eventRoleOf(a) });
        for (const x of team) hold(x);
        for (const x of [b, c]) kit(x, [], [[id('shark'), 20], [Items.COINS, 1000]], runeKit());
        Core.resetEndgameTripsForTest();
        lib.resetDirectorForTest();
        check('kq-cap: and the world\'s gap untaken: a team may still come', Kq.mayLeadKq(leader, bosser));
    }
    kqUnstage(team);
}

// ---- (the KQ fixes, KQ-1) a member's own Lumbridge Teleport on its way (its prayer down: the church's altar first; the
// spell lands a tile from the respawn): no death, its errand goes on, it banks and comes to the meeting ----
if (want('kq-tele')) {
    scene(SEED, 'kq-tele');
    const team = kqStage(4, [3271, 3164], 2);
    check('kq-tele: four levelling bossers of the bar to stage', team.length === 4, team.length);
    if (team.length === 4) {
        const far = team[3];
        // (at Varrock west bank, the runes of one Lumbridge Teleport and its laws to spare in its pack, its prayer down)
        place(far, 3185, 3436);
        hold(far);
        lib.giveItems(far, [[Items.EARTH_RUNE, 5], [Items.AIR_RUNE, 15], [Items.LAW_RUNE, 5]], false);
        far.levels[PlayerStat.PRAYER] = 10;
        lib.Teleport.setTeleportRatesForTest({ teleporter: true, trip: 1 });
        const casts0 = lib.Teleport.teleportSpellStats.bySpell.lumbridge ?? 0;
        const events = [];
        const off = Core.onEndgameEvent(e => events.push(e));
        const task = Kq.kqLeaderTask(q => Endgame.hasBosserTrait(q.username));
        assign(team[0], task);
        let kept = null;
        let landed = null;
        const t = run(2500, () => {
            const tm = Kq.kqTeam();
            if (tm) kept = tm;
            if (!landed && lib.Teleport.lastCastAt(far) > 0 && far.level === 0 && cheb(far.x, far.z, 3221, 3218) <= 3) landed = [far.x, far.z, World.currentTick];
            return kept !== null && (kept.ready.has(far) || kept.died.has(far) || kept.ended);
        });
        off();
        const cast = (lib.Teleport.teleportSpellStats.bySpell.lumbridge ?? 0) - casts0;
        check('kq-tele: the far member cast Lumbridge Teleport on its way, landed by the respawn', cast === 1 && landed !== null, { cast, landed, at: [far.x, far.z, far.level] });
        check('kq-tele: no death of it (no bossDeath, not on the team\'s dead, no death counted)', !kept?.died.has(far) && !events.some(e => e.kind === 'bossDeath' && e.bot === far) && Kq.kqStats.deaths === 0, { died: kept?.died.has(far) ?? null, events: events.map(e => `${e.kind}:${e.bot.username}`), deaths: Kq.kqStats.deaths });
        // (its errand went on: the altar's step, the bank, the walk to the meeting)
        check('kq-tele: its errand went on: banked and came to the meeting', t > 0 && kept?.ready.has(far) && Fight.goodFoodCarried(far) >= 12, { t, ready: kept?.ready.has(far) ?? null, food: Fight.goodFoodCarried(far), prayer: far.levels[PlayerStat.PRAYER], state: sim.botPlayer(far).currentTask?.state ?? null, at: [far.x, far.z] });
        // (bots ideas, the door-walk fix) and it prayed at the church's altar on the way: the walk's door entry left from
        // opening the church's door took the altar's one click before (BotAction._continueDoorWalk; test/fixes.test.mjs)
        check('kq-tele: it prayed at Lumbridge church\'s altar on the way (its Prayer back from 10)', far.levels[PlayerStat.PRAYER] === far.baseLevels[PlayerStat.PRAYER], { prayer: far.levels[PlayerStat.PRAYER], base: far.baseLevels[PlayerStat.PRAYER] });
        lib.Teleport.setTeleportRatesForTest(null);
    }
    kqUnstage(team);
}

check('errors: none', errors.length === 0 && lib.botErrorCount?.() === 0, errors.slice(0, 3).join(' | '));

// ---- report ----
let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(`endgame: ${checks.length - failed} of ${checks.length} checks ok`);
process.exit(failed ? 1 : 0);
