#!/usr/bin/env node
// The Duel Arena and the player-mod bot (the realism work, phase 5b, Track A: port/BotArena, port/BotDuel,
// tasks/DuelArenaTask, port/BotModBot), in the real 274 world
// (members) with the content overlay as the runtime installs it. The human clicks through the engine's own packet handlers
// (their checks: a visible component, a transmitted inventory). Checks:
//   bots      two stakers at the arena duel through 274's real screens (the challenge, the answer, the rules the challenger
//             sets, the stakes with the count answered, both accepts, the confirm, 274's jump into an arena, the countdown,
//             the fight, the win screen closed): the stake goes to the winner exactly, zero-sum, no other item moves, both
//             come back to the hospital with no screen or count dialog open, 274's two jumps marked 'duel'; a watcher by a
//             wall throws 1-3 rotten tomatoes at them, 10+ ticks apart, and the duel's record counts them and its watchers
//   human     no challenge before the human stands in the challenge area; the first 30-120 s after they come, the call before
//             the click; their "no" gets a word and that bot never again; the next challenge 5+ minutes on; on the screens
//             the bot mirrors their coins, offers at most its cap ("max 20k"), never accepts items ("i only stake gp") or a
//             fight it cannot make by melee, accepts their cap; the duel; the purse (their winnings), and the bot they beat
//             declines in a word ever after; a bot of a lower combat declines; a spent purse ends every challenge
//   visits    the planner's hook: a combat 20+ bot with 5k+ coins on a members world gets a visit when one is due, not a
//             newbie, a low level, a poor or a far bot, never two in a row, never past the arena's room
//   big stake the director's duel_stake (its plan and start with a context of bots near the arena): two rich regulars, a
//             stake of 50k-half the poorer's coins, a crowd; the duel, zero-sum; the run done
//   mod       the pick: the first ranked candidate in the pool, the silver crown on its lines only; a scam call within 25
//             tiles: it walks within 6, a duty line (kind mod) 3-10 s on, not again for 2 minutes; the human's spam told off,
//             not again for 10 minutes, never a Jmod; "is there a mod here" answered by the mod near (the bots near quiet),
//             "r u a mod" by name; the others' answers; every crowned line the mod's
//
//   node --expose-gc web/engine/bots/test/duel.test.mjs [--seed=N] [--debug]
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
const DEBUG = args.debug === 'true';
const out = (s = '') => process.stdout.write(s + '\n');
const t0 = performance.now();

// ---- a deterministic Math.random ----
{
    let s = Number(args.seed ?? 7) >>> 0 || 1;
    Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- console: keep the errors, print only ours ----
const consoleErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const real = console[level].bind(console);
    console[level] = (...a) => {
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (level === 'error' && !text.includes('ExperimentalWarning')) consoleErrors.push(text);
        if (DEBUG) real(...a);
    };
}

const checks = [];
function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, detail: ok ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail) });
    return !!ok;
}

// ---- the world, the overlay ----
const overlay = await compileBotScripts({ engineDir: ENGINE_DIR, contentDir: CONTENT_DIR, log: () => {} });
const scriptsBin = new Uint8Array(fs.readFileSync(overlay.file));
const scriptDat = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.dat')));
const scriptIdx = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.idx')));
const engineDir = prepareEngineClone('duel', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const T = await importTs(path.join(BOTS_DIR, 'test/lib/duel.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, BotChat, InvType, Items, Arena, Duel, ModBot } = T;
const N = 20;
const sim = await T.Sim.create({ bots: N, members: true, debug: DEBUG, humanName: 'casey' });
T.installBotsContent(scriptsBin, scriptDat, scriptIdx);
sim.addHuman(3200, 3200, 0);
const human = sim.human;
// the human stands about for minutes: no random event (a Mysterious box would close a duel screen)
{
    const processClientsIn = World.processClientsIn;
    World.processClientsIn = function () {
        processClientsIn.call(this);
        human.afkEventReady = false;
    };
}
const COINS = Items.COINS;
const TOMATO = T.ObjType.getId('rotten_tomato');

const says = [];
T.sayListeners.push((player, text, kind, to) => says.push({ t: World.currentTick, who: player.username, text, kind: kind ?? null, rights: player.chatRights, to: to?.username ?? null }));
const told = [];
{
    const messageGame = human.messageGame.bind(human);
    human.messageGame = text => {
        told.push({ t: World.currentTick, text });
        return messageGame(text);
    };
}

const tick = (n = 1) => {
    for (let i = 0; i < n; i++) sim.tick();
};
const waitUntil = (fn, max) => {
    for (let i = 0; i < max && !fn(); i++) tick(1);
    return !!fn();
};
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
/** a line as said fits a pool's line: port/BotStyle's typos ("gp oly"), stretched letters ("nooo"), a word on the end */
function fits(said, line) {
    const norm = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/(.)\1+/g, '$1').replace(/\s+/g, ' ').trim();
    const a = norm(said);
    const b = norm(line);
    if (!a || !b) return false;
    if (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true;
    // (the edit distance of their starts: two letters at most, one in a short line, none in a word or two)
    const most = b.length >= 8 ? 2 : b.length >= 5 ? 1 : 0;
    if (most === 0) return false;
    const x = a.slice(0, b.length + 1);
    const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= x.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === b[j - 1] ? 0 : 1));
    return Math.min(...d.map(row => row[b.length])) <= most;
}
const bankOf = p => p.getInventory(T.bankInvId());
const coinsOf = p => T.invTotal(p, 'inv', COINS) + (bankOf(p)?.getItemCount(COINS) ?? 0);
const FOOD = new Set(T.edibleFoodIds());
/** every item a bot owns but coins, food and tomatoes (pack, bank, worn), as id -> count */
function belongings(p) {
    const all = new Map();
    for (const inv of [p.getInventory(InvType.INV), bankOf(p), p.getInventory(InvType.WORN)]) {
        for (let s = 0; inv && s < inv.capacity; s++) {
            const it = inv.get(s);
            if (!it || it.id === COINS || it.id === TOMATO || FOOD.has(it.id)) continue;
            const id = T.ObjType.get(it.id).certlink !== -1 && T.ObjType.get(it.id).certtemplate !== -1 ? T.ObjType.get(it.id).certlink : it.id;
            all.set(id, (all.get(id) ?? 0) + it.count);
        }
    }
    return all;
}
const sameMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
const saidBy = (bot, from) => says.slice(from).filter(s => s.who === bot.username);
function stop(bot) {
    bot.clearWaypoints();
    bot.clearInteraction();
}
function place(bot, x, z) {
    stop(bot);
    bot.teleJump(x, z, 0);
    tick(1);
    stop(bot);
}
/** The bot does `task` from now on (the planner's picks give it back); its task before is over (BotPlayer's switch). */
function force(bot, task) {
    const bp = sim.botPlayer(bot);
    bp.currentTask?.interrupt?.();
    task.reset();
    bp.planner.pickTask = () => task;
    bp.currentTask = task;
    return task;
}
/** a fighter: attack, strength, defence, hitpoints, ranged, prayer and magic `lvl` (one combat level for one `lvl`), full Hitpoints, coins banked */
function fighter(bot, lvl, coins) {
    for (const s of [0, 1, 2, 3, 4, 5, 6]) bot.setLevel(s, lvl);
    bot.levels[3] = bot.baseLevels[3];
    if (coins) bankOf(bot).add(COINS, coins);
}
/** the human steps next to the bot (the human's clicks walk nowhere here: no client sends a route) */
function beside(bot) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (sim.isWalkable(bot.x + dx, bot.z + dz, bot.level) && sim.walkDistance(bot, bot.x + dx, bot.z + dz) === 1) {
            sim.teleportHuman(bot.x + dx, bot.z + dz, bot.level);
            tick(1);
            return true;
        }
    }
    return false;
}
/** the human steps to a tile 2-3 from the bot that a walk from the bot reaches in a few steps (no wall or fence between:
 * 274's challenge walks the challenger up to them), in the challenge area */
function nearBy(bot) {
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [-2, 1], [1, 2], [1, -2], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
        const x = bot.x + dx;
        const z = bot.z + dz;
        if (!sim.isWalkable(x, z, bot.level) || !Duel.inChallengeArea(x, z, bot.level)) continue;
        const steps = sim.walkDistance(bot, x, z);
        if (steps >= 1 && steps <= 4) {
            sim.teleportHuman(x, z, bot.level);
            return true;
        }
    }
    sim.teleportHuman(bot.x + 2, bot.z, bot.level);
    return false;
}
/** a bot idle where it stands (a task that does nothing) */
function idle(bot) {
    return force(bot, { name: 'Idle', interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, reset() {}, interrupt() {}, activityStep: () => null });
}

tick(Math.ceil(N / 5) + 20);
const levelling = sim.bots().filter(b => T.isLevelling(b.botPlanner));
check(`${N} bots in the world, levelling ones among them`, levelling.length >= 8, levelling.length);
if (levelling.length < 8) {
    for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    process.exit(1);
}
// (the bots in the checks stand still between them: the rest play on; no break and no random event for them: a genie
// let pass sent the mod 480 tiles off by the game's own fail teleport, seed 1)
for (const b of levelling) idle(b);
T.setHabitRatesForTest?.(0);
T.setEventRatesForTest?.({ odds: 0 });

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// bots: a staked duel between two stakers, a watcher's tomatoes
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
    scene(Number(args.seed ?? 7), 'bots duel'); // (its own dice: test/lib/dice.mjs)
    const [A, B, W] = levelling;
    fighter(A, 45, 100000);
    fighter(B, 45, 100000);
    place(A, 3378, 3268);
    place(B, 3379, 3269);
    place(W, 3377, 3267);
    W.getInventory(InvType.INV).add(TOMATO, 10);
    Arena.setDuelDealForTest({ stake: 1000, rules: Arena.rulesOf('melee') });
    const before = { a: coinsOf(A), b: coinsOf(B), ia: belongings(A), ib: belongings(B) };
    const marks0 = T.teleportStats.marks.length;
    const tA = force(A, new T.DuelArenaTask('staker'));
    const tB = force(B, new T.DuelArenaTask('staker'));
    const tW = force(W, new T.DuelArenaTask('watcher'));
    // the watcher's tomato stack, each tick (a throw takes one: 274's inv_delslot)
    const throws = [];
    let held = T.invTotal(W, 'inv', TOMATO);
    const done = () => Arena.duelLog.some(r => r.end >= 0 && [r.a, r.b].includes(A.username)) && !tA.inDuel() && !tB.inDuel();
    for (let i = 0; i < 3000 && !done(); i++) {
        tick(1);
        const h = T.invTotal(W, 'inv', TOMATO);
        if (h < held) throws.push(World.currentTick);
        held = h;
    }
    // (both stand still from here: they would duel again at once)
    for (const b of [A, B]) idle(b);
    tick(20);
    const rec = Arena.duelLog.find(r => [r.a, r.b].includes(A.username));
    check('bots: two stakers at the arena duel each other through the real screens (a fight, a winner)', rec && rec.start >= 0 && rec.end >= rec.start && [A.username, B.username].includes(rec.winner), rec);
    if (rec) {
        check('bots: the agreed deal held (1,000 coins, melee only: no ranged, no magic)', rec.stake === 1000 && rec.rules === Arena.rulesOf('melee'), rec);
        const winner = rec.winner === A.username ? A : B;
        const loser = winner === A ? B : A;
        const gain = coinsOf(winner) - (winner === A ? before.a : before.b);
        const loss = (loser === A ? before.a : before.b) - coinsOf(loser);
        check('bots: the stake goes to the winner exactly, zero-sum (pack and bank)', gain === 1000 && loss === 1000, { gain, loss });
        check('bots: no other item moved (but food eaten)', sameMap(belongings(A), before.ia) && sameMap(belongings(B), before.ib), { a: [...belongings(A)].length, ia: [...before.ia].length });
    }
    check('bots: no duel screen left open, the win screen closed (274 pays out on its close)', Duel.duelScreen(A) === null && Duel.duelScreen(B) === null, [A.modalMain, B.modalMain]);
    check('bots: both back out of the arenas (the hospital, the challenge area)', !Duel.inFightZone(A.x, A.z, A.level) && !Duel.inFightZone(B.x, B.z, B.level), [A.x, A.z, B.x, B.z]);
    const countDialog = p => p.activeScript?.execution === T.ScriptState.COUNTDIALOG;
    check('bots: no count dialog left open (the stake\'s count answered in its own call)', !countDialog(A) && !countDialog(B));
    const marks = T.teleportStats.marks.slice(marks0).filter(m => m.cls === 'duel');
    check("bots: 274's jumps into the arena and back marked 'duel' for both (the humanlike report lists them apart)", [A, B].every(p => marks.filter(m => m.name === p.username).length >= 2), marks);
    check('bots: the duellists keep no role after the duel (BotManager no longer holds their logout)', T.SetPieces.eventRoleOf(A) === null && T.SetPieces.eventRoleOf(B) === null);
    const gaps = throws.slice(1).map((t, i) => t - throws[i]);
    check('bots: the watcher threw 1-3 rotten tomatoes at the duel, 10+ ticks apart', throws.length >= 1 && throws.length <= 3 && gaps.every(g => g >= 10), { throws, state: tW.state, wall: tW.wall });
    check("bots: the duel's record counts the tomatoes and its watchers", rec && rec.tomatoes === throws.length && rec.spectators >= 1, rec);
    Arena.setDuelDealForTest(null);
    idle(W);
    tick(20);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// the human
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
    scene(Number(args.seed ?? 7), 'the human'); // (its own dice: test/lib/dice.mjs)
    const [, , , C, E] = levelling;
    fighter(C, 45, 150000);
    fighter(E, 45, 250000);
    place(C, 3378, 3268);
    place(E, 3380, 3268);
    sim.copyLevels(C);
    human.getInventory(InvType.INV).add(COINS, 100000);
    human.getInventory(InvType.INV).add(T.ObjType.getId('bronze_dagger'), 1);
    sim.teleportHuman(3300, 3240, 0); // (outside the arena's walls: not in the challenge area)
    // (one staker at a time: two of about one combat level would duel each other)
    const tC = force(C, new T.DuelArenaTask('staker', { stay: 20000 }));
    tick(120);
    const outside = told.filter(m => m.text.endsWith(':duelreq:')).length;
    check('human: the staker is standing in the challenge area', tC.state === 'stand' && Duel.inChallengeArea(C.x, C.z, 0), [tC.state, C.x, C.z]);
    tick(200);
    check('human: no challenge while the human is outside the challenge area', told.filter(m => m.text.endsWith(':duelreq:')).length === outside);

    // in: the first challenge 30-120 s after (from whichever staker is within 10 tiles)
    nearBy(C);
    tick(1);
    const entered = World.currentTick;
    const m0 = told.length;
    const s0 = says.length;
    // (the human keeps near it: a staker moves over to the others now and then)
    waitUntil(() => {
        if (cheb(human, C) > 5 && !C.hasWaypoints() && !tC.inDuel()) nearBy(C);
        return told.slice(m0).some(m => m.text.endsWith(':duelreq:'));
    }, 400);
    const req = told.slice(m0).find(m => m.text.endsWith(':duelreq:'));
    const first = req ? req.t - entered : -1;
    check('human: the first challenge comes 30-120 s after the human enters the challenge area (and the walk up)', first >= 50 && first <= 240, first);
    const challenger = req && req.text.toLowerCase().startsWith(C.displayName.toLowerCase()) ? C : null;
    const call = challenger ? says.slice(s0).find(s => s.who === challenger.username && s.kind === 'setpiece') : null;
    check("human: the challenger's call (kind setpiece) comes before its click", call && req && call.t <= req.t, { call, req });
    // their "no": a word, off, never again from that bot
    BotChat.onPublicMessage(human, 'no ty');
    tick(30);
    const st = Arena.humanArenaState(human.username);
    check('human: their "no" gets a word ("k") and the challenge is off; that bot is refused for good', challenger && st && st.refused.includes(challenger.username) && st.pending === null && saidBy(challenger, s0).some(s => Arena.arenaLines('duel-refused').some(l => fits(s.text, l))), { st, said: challenger ? saidBy(challenger, s0).map(s => s.text) : null });
    check('human: the refused bot challenges no more (the policy passes it over)', Arena.challengeHumanNow(C, 100000) === null);
    // the next: 5+ minutes after the first, from another staker
    idle(C);
    const other = E;
    const tE = force(E, new T.DuelArenaTask('staker', { stay: 20000 }));
    // (on its tile: standing still in the challenge area a while)
    let still = 0;
    waitUntil(() => {
        still = tE.state === 'stand' && !E.hasWaypoints() && Duel.inChallengeArea(E.x, E.z, 0) && cheb(E, { x: 3382, z: 3268 }) > 8 ? still + 1 : 0;
        return still >= 10;
    }, 400);
    nearBy(other);
    const m1 = told.length;
    // (the human keeps near it: a staker moves over to the others now and then)
    waitUntil(() => {
        if (cheb(human, other) > 5 && !other.hasWaypoints() && !tE.inDuel()) nearBy(other);
        return told.slice(m1).some(m => m.text.endsWith(':duelreq:'));
    }, 900);
    const req2 = told.slice(m1).find(m => m.text.endsWith(':duelreq:'));
    check('human: the next challenge comes 5+ minutes after the first, from another bot', req && req2 && req2.t - req.t >= 500 && req2.text.toLowerCase().startsWith(other.displayName.toLowerCase()), { first: req?.t, next: req2?.t, text: req2?.text });
    check('human: the refused bot never challenged again', !told.slice(m1).some(m => m.text.toLowerCase().startsWith(C.displayName.toLowerCase())));

    // the screens with `other` (its cap as it challenged: its coins then)
    const capWant = Arena.humanCap(other, human, tE.carry);
    tick(8);
    check('human: the human accepts the challenge (Challenge back): both screens open', T.opPlayer(human, other, 1) && waitUntil(() => Duel.duelScreen(human) === 'select' && Duel.duelScreen(other) === 'select', 8), [Duel.duelScreen(human), Duel.duelScreen(other)]);
    const offerOf = p => Duel.duelInv(p, 'offer');
    const coinsOffered = p => offerOf(p).get(COINS) ?? 0;
    T.invButton(human, 'duel_side:inv', 'inv', COINS, 5, 5000);
    check('human: the bot mirrors their 5k', waitUntil(() => coinsOffered(other) === 5000, 25), coinsOffered(other));
    const s1 = says.length;
    T.invButton(human, 'duel_side:inv', 'inv', COINS, 5, 55000);
    waitUntil(() => coinsOffered(other) !== 5000, 25);
    tick(15);
    const cap = coinsOffered(other);
    // (its line typed: a person's typing time, up to 30 ticks more; the 15 ticks above were all it had, and a world whose
    // draws moved, since the variety work's round 2, had it still typing)
    const capSaid = () => saidBy(other, s1).some(s => /max (is )?\d+k/.test(s.text.toLowerCase()) && s.text.includes(String(cap / 1000)));
    waitUntil(capSaid, 30);
    check('human: over its cap the bot offers its cap (min(25k, 10 % of its coins), a round sum) and says so ("max 20k")', cap === capWant && capSaid(), { cap, capWant, said: saidBy(other, s1).map(s => s.text) });
    let acceptedMismatch = false;
    const watchAccept = n => {
        for (let i = 0; i < n; i++) {
            tick(1);
            if (Duel.duelStatus(other) === Duel.DuelStatus.PENDING_ACCEPT) acceptedMismatch = true;
        }
    };
    watchAccept(20);
    check('human: the bot never accepts while their coins are over its cap', !acceptedMismatch);
    T.invButton(human, 'duel_select_type:inv', 'dueloffer', COINS, 5, 60000 - cap);
    check('human: their coins down to its cap: the bot accepts', waitUntil(() => Duel.duelStatus(other) === Duel.DuelStatus.PENDING_ACCEPT, 25), Duel.duelStatus(other));
    const s2 = says.length;
    T.invButton(human, 'duel_side:inv', 'inv', T.ObjType.getId('bronze_dagger'), 1);
    acceptedMismatch = false;
    watchAccept(25);
    check('human: an item in their stake: the bot takes no accept and says it stakes gp only', !acceptedMismatch && saidBy(other, s2).some(s => Arena.arenaLines('duel-screen', 'items').some(l => fits(s.text, l))), saidBy(other, s2).map(s => s.text));
    T.invButton(human, 'duel_select_type:inv', 'dueloffer', T.ObjType.getId('bronze_dagger'), 1);
    tick(3);
    T.ifButton(human, 'duel_select_type:no_melee');
    acceptedMismatch = false;
    watchAccept(25);
    check('human: No Melee: the bot will not fight it (no accept)', !acceptedMismatch && (Duel.duelOptions(human) & (1 << Duel.Rule.NO_MELEE)) !== 0, Duel.duelOptions(human));
    T.ifButton(human, 'duel_select_type:no_melee');
    check('human: back to its terms: the bot accepts again', waitUntil(() => Duel.duelStatus(other) === Duel.DuelStatus.PENDING_ACCEPT, 25));
    T.ifButton(human, 'duel_select_type:accept');
    check('human: the confirm screen for both; the bot confirms after a moment', waitUntil(() => Duel.duelScreen(other) === 'confirm' && Duel.duelScreen(human) === 'confirm', 10) && waitUntil(() => Duel.duelStatus(other) === Duel.DuelStatus.PENDING_CONFIRM, 15));
    const humanCoins = T.invTotal(human, 'inv', COINS) + coinsOffered(human);
    const botCoins = coinsOf(other) + coinsOffered(other);
    T.ifButton(human, 'duel_confirm:accept');
    check('human: the fight starts (274 jumps both into an arena, FIGHT!)', waitUntil(() => Duel.duelStatus(other) === Duel.DuelStatus.START, 20) && Duel.inFightZone(other.x, other.z, 0));
    // the human wins: the bot kept at 2 Hitpoints (its food would heal it), the human unhurt
    for (let i = 0; i < 400 && Duel.duelStatus(human) !== Duel.DuelStatus.RESET; i++) {
        if (other.levels[3] > 2) other.levels[3] = 2;
        human.levels[3] = human.baseLevels[3];
        if (!human.target) T.opPlayer(human, other, 2);
        tick(1);
    }
    if (Duel.duelScreen(human) === 'win') T.closeModal(human);
    tick(30);
    const humanGain = T.invTotal(human, 'inv', COINS) - humanCoins;
    check('human: the human won the bot\'s cap, exactly', humanGain === cap, { humanGain, cap, bot: botCoins - coinsOf(other) });
    check('human: the purse counts it (their net winnings from bots)', Arena.purseLeft(human.username) === 50000 - cap, Arena.purseLeft(human.username));
    const beat = Arena.humanArenaState(human.username);
    check('human: the bot they beat is never staked again (no rematch)', beat?.beaten.includes(other.username) && Arena.refuseHuman(other, human, 100000) === 'beaten', beat);
    // they challenge it again: a word, no screens
    tick(40);
    const s3 = says.length;
    beside(other);
    T.opPlayer(human, other, 1);
    const declined = () => saidBy(other, s3).some(s => Arena.arenaLines('duel-decline', 'beaten').some(l => fits(s.text, l)));
    waitUntil(declined, 70);
    check('human: their own challenge to the bot they beat: a word ("no rematch lol"), no screens', Duel.duelScreen(human) === null && declined(), saidBy(other, s3).map(s => s.text));
    // a bot of a lower combat declines; a spent purse ends every challenge
    const low = levelling[5];
    fighter(low, 20, 50000);
    check('human: a bot more than 3 combat levels under the human declines ("ur higher than me lol")', Arena.refuseHuman(low, human, 50000) === 'higher', [low.combatLevel, human.combatLevel]);
    Arena.noteHumanDuel(human.username, 'somebody', 'lost', 50000);
    check('human: with the purse spent (50k won from bots this hour) no bot stakes them', Arena.purseLeft(human.username) === 0 && Arena.humanCap(C, human, 100000) === 0 && Arena.refuseHuman(E, human, 100000) !== null);
    // (a restart: the world's store brings back the purse and the bots they beat; nothing to farm by closing the app)
    {
        const play = BotManager.stats().playTicks;
        const saved = JSON.parse(JSON.stringify(Arena.exportArena(play)));
        Arena.forgetHumansForTest();
        const forgot = Arena.purseLeft(human.username) === 50000 && Arena.refuseHuman(other, human, 100000) !== 'beaten';
        Arena.restoreArena(saved, play);
        check('human: a restart forgets neither the purse nor the bot they beat (the world\'s store)', forgot && Arena.purseLeft(human.username) === 0 && Arena.refuseHuman(other, human, 100000) === 'beaten', saved);
    }
    for (const b of [C, E]) idle(b);
    sim.teleportHuman(3200, 3200, 0);
    tick(20);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// visits (the planner's hook)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
    scene(Number(args.seed ?? 7), 'visits'); // (its own dice: test/lib/dice.mjs)
    Arena.setArenaRatesForTest(1e6);
    const [, , , , , , G, H] = levelling;
    fighter(G, 40, 20000);
    place(G, 3260, 3170); // (Al Kharid: within its reach)
    tick(2);
    const visit = Arena.arenaVisitFor(G, null);
    check('visits: a combat 20+ bot with 5k+ coins near enough gets a visit when one is due', visit && visit.name === 'DuelArena' && ['staker', 'watcher'].includes(visit.role), visit?.role);
    check('visits: never two in a row', Arena.arenaVisitFor(G, 'DuelArena') === null);
    fighter(H, 5, 0);
    for (const s of [0, 1, 2, 3]) H.setLevel(s, 5);
    place(H, 3261, 3171);
    check('visits: not a low level (combat under 20)', Arena.arenaVisitFor(H, null) === null, H.combatLevel);
    fighter(H, 40, 0);
    for (const inv of [H.getInventory(InvType.INV), bankOf(H)]) inv.remove(COINS, inv.getItemCount(COINS));
    H.getInventory(InvType.INV).add(COINS, 4000);
    Arena.setArenaRatesForTest(1e6); // (every check its own fresh schedule: a no puts the next look a quarter of an hour on)
    check('visits: not a bot with under 5k coins', Arena.arenaVisitFor(H, null) === null && !Arena.mayVisit(H), coinsOf(H));
    place(G, 2725, 3490); // (Seers, 635 tiles off: within the 900 since the visits' tuning)
    check('visits: a bot at Seers comes too (within 900 tiles)', Arena.arenaVisitFor(G, null) !== null);
    Arena.setArenaRatesForTest(1e6);
    place(G, 2400, 3480); // (the Gnome Stronghold, 960 tiles off: too far)
    check('visits: not a bot far off (900+ tiles)', Arena.arenaVisitFor(G, null) === null && !Arena.mayVisit(G));
    check("visits: the arena's room: 8 per 100 online (2 at the least)", Arena.arenaCap() === Math.min(24, Math.max(2, Math.round(0.08 * N))), Arena.arenaCap());
    Arena.setArenaRatesForTest(1);
    place(G, 3200, 3200);
    place(H, 3201, 3200);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// the big stake (the director's duel_stake, its plan and start with a context of bots)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
    scene(Number(args.seed ?? 7), 'the big stake'); // (its own dice: test/lib/dice.mjs)
    const [, , , , , , , , J, K, ...crowd] = levelling;
    fighter(J, 50, 300000);
    fighter(K, 50, 400000);
    place(J, 3360, 3262);
    place(K, 3362, 3262);
    crowd.slice(0, 4).forEach((p, i) => place(p, 3364 + i, 3264));
    // (one of the crowd on a visit of its own, a watcher: the big stake's part takes it for a while, its visit goes on)
    const visitor = crowd[0];
    const visit = force(visitor, new T.DuelArenaTask('watcher', { stay: 30000 }));
    tick(2);
    const listed = () => Arena.arenaVisitors().some(([p, t]) => p === visitor && t === visit);
    const listedBefore = listed();
    const ctx = {
        now: World.currentTick,
        play: BotManager.stats().playTicks,
        members: true,
        online: sim.bots().length,
        census: new Map(),
        freeBots: (x, z, level, radius, ok, max = 99) => sim.bots().filter(p => p.level === level && Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) <= radius && !sim.botPlayer(p)?.hasSubTask() && (!ok || ok(p))).sort((a, b) => cheb(a, { x, z }) - cheb(b, { x, z })).slice(0, max),
        sessionLeft: () => Infinity,
        dice: Math.random
    };
    const plan = Arena.BIG_STAKE.plan(ctx);
    const pd = plan?.data;
    const rich = p => T.coinsOwned(p) >= 100000 && p.combatLevel >= 40;
    check('big stake: its plan picks two rich bots of about one combat level near the arena, a stake of 50k to half the poorer\'s coins', plan && rich(pd.a) && rich(pd.b) && Math.abs(pd.a.combatLevel - pd.b.combatLevel) <= 15 && pd.stake >= 50000 && pd.stake <= Math.floor(Math.min(T.coinsOwned(pd.a), T.coinsOwned(pd.b)) / 2) && pd.stake % 10000 === 0, pd ? { a: pd.a.username, b: pd.b.username, stake: pd.stake } : plan);
    const run = plan ? Arena.BIG_STAKE.start(plan, ctx) : null;
    const [P, Q] = pd ? [pd.a, pd.b] : [J, K];
    check('big stake: its run: two duellists and a crowd, each with its sub-task', run && run.roles.get(P) === 'duellist' && run.roles.get(Q) === 'duellist' && [...run.roles.values()].filter(r => r === 'crowd').length >= 1 && sim.botPlayer(P).hasSubTask() && sim.botPlayer(Q).hasSubTask(), run ? [...run.roles].map(([p, r]) => `${p.username}:${r}`) : null);
    if (run) {
        T.SetPieces.runStarted(run);
        const before = coinsOf(P) + coinsOf(Q);
        for (let i = 0; i < 4000 && run.phase !== 'done'; i++) {
            tick(1);
            if (World.currentTick % 5 === 0) run.tick(World.currentTick);
        }
        T.SetPieces.runEnded(run);
        waitUntil(() => [...run.roles].every(([p]) => !sim.botPlayer(p)?.hasSubTask()), 40);
        const rec = Arena.duelLog.find(r => r.big && [r.a, r.b].includes(P.username));
        check('big stake: the duel was fought for the agreed stake, a winner', rec && rec.stake === pd.stake && rec.winner !== null, rec);
        check('big stake: zero-sum (the two duellists\' coins together unchanged)', coinsOf(P) + coinsOf(Q) === before, { before, after: coinsOf(P) + coinsOf(Q), duels: Arena.duelLog.filter(r => [r.a, r.b].includes(P.username) || [r.a, r.b].includes(Q.username)), floor: [P, Q].map(p => [p.username, T.invTotal(p, 'inv', COINS), bankOf(p).getItemCount(COINS)]) });
        const crowdLeft = [...run.roles].filter(([p, r]) => r === 'crowd' && sim.botPlayer(p)?.hasSubTask()).length;
        check('big stake: the run ends (done) and its parts are over', run.phase === 'done' && !sim.botPlayer(P).hasSubTask() && !sim.botPlayer(Q).hasSubTask() && crowdLeft === 0, { phase: run.phase, crowdLeft });
        if (run.roles.has(visitor)) {
            waitUntil(listed, 10);
            check('big stake: a visitor it took for its crowd is a visitor again after (the others find it: no ghost)', listedBefore && listed(), { listedBefore, state: visit.state });
        }
        check('big stake: its rumour names the duel arena', /arena/.test(Arena.arenaLines('duel-big').join(' ')));
    }
    for (const p of levelling) idle(p);
    tick(10);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// the player-mod bot
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
    scene(Number(args.seed ?? 7), 'the player-mod bot'); // (its own dice: test/lib/dice.mjs)
    // the pick: the first ranked candidate the pool holds (the pool: BotManager's), 1 at this size
    ModBot.repickModsForTest();
    const ranked = ModBot.rankedModCandidates();
    const inPool = ranked.filter(n => BotManager.sessionLeftOf(n) !== Infinity);
    const picked = [...ModBot.playerModNames()];
    check('mod: the pick is the first ranked candidate in the pool (one at this size)', picked.length === (inPool.length ? 1 : 0) && (inPool.length === 0 || picked[0] === inPool[0]), { picked, inPool: inPool.slice(0, 3) });
    check('mod: the candidates are levelling bots aged experienced or veteran, friendly, no meme persona', ranked.slice(0, 20).every(n => T.isLevelling(T.plannerOf(n)) && ['experienced', 'veteran'].includes(T.ageTierFor(n, T.plannerOf(n))) && T.personaOf(n).friendliness >= 0.3 && !T.personaOf(n).meme));
    const crowned = sim.bots().filter(b => b.staffModLevel !== 0);
    check('mod: the silver crown at spawn on the mod only (staff level 1), never a gold one', crowned.every(b => b.staffModLevel === 1 && picked.includes(b.username)) && sim.bots().filter(b => picked.includes(b.username)).every(b => b.staffModLevel === 1), crowned.map(b => `${b.username}:${b.staffModLevel}`));

    // its duty, with a mod of the test's choosing (a levelling bot online)
    // (the variety work, round 1, track F: no ambient scam stint meanwhile: one begun at Varrock West by chance, its caller
    // the bystander, had the mod tell it off and its caps then held for the human's spam)
    T.setScamRatesForTest({ ambient: false });
    T.resetScamsForTest();
    const [mod, scammer, bystander] = levelling.slice(-3);
    ModBot.setModNamesForTest([mod.username]);
    mod.staffModLevel = 1;
    for (const p of [mod, scammer, bystander]) {
        const bp = sim.botPlayer(p);
        delete bp.planner.pickTask;
        idle(p);
    }
    place(mod, 3185, 3436);
    place(scammer, 3190, 3448);
    place(bystander, 3188, 3440);
    tick(3);
    const s0 = says.length;
    T.botSay(scammer, 'Doubling gold trade me', undefined, 'idle');
    let near = -1;
    for (let i = 0; i < 100 && !says.slice(s0).some(s => s.who === mod.username && s.kind === 'mod'); i++) {
        tick(1);
        if (near < 0 && cheb(mod, scammer) <= 6) near = World.currentTick;
    }
    const duty = says.slice(s0).find(s => s.who === mod.username && s.kind === 'mod');
    check('mod: a scam call within 25 tiles: it walks within 6 tiles and says a duty line (kind mod, the crown on it) 3-10 s after', duty && near >= 0 && duty.t - near >= 4 && duty.t - near <= 20 && duty.rights === 1 && Arena.arenaLines('mod-scam').includes(duty.text), { duty, near, at: [mod.x, mod.z], scammer: [scammer.x, scammer.z] });
    const s1 = says.length;
    T.botSay(scammer, 'Trimming armour, 25k gp', undefined, 'idle');
    tick(80);
    check('mod: not again within 2 minutes', !says.slice(s1).some(s => s.who === mod.username && s.kind === 'mod'));
    // the human's spam
    tick(150);
    sim.teleportHuman(mod.x + 3, mod.z, 0);
    tick(2);
    const s2 = says.length;
    for (let i = 0; i < 3; i++) {
        BotChat.onPublicMessage(human, 'selling lobs 160 ea');
        tick(12);
    }
    waitUntil(() => says.slice(s2).some(s => s.who === mod.username && s.kind === 'mod'), 90);
    const told1 = says.slice(s2).find(s => s.who === mod.username && s.kind === 'mod');
    check("mod: the human's spam (the same line 3 times in a minute): told off, to them", told1 && told1.to === human.username && Arena.arenaLines('mod-spam').includes(told1.text), { told1 });
    tick(300);
    const s3 = says.length;
    for (let i = 0; i < 3; i++) {
        BotChat.onPublicMessage(human, 'buying coal 140 ea');
        tick(12);
    }
    tick(80);
    check('mod: the human not again within 10 minutes', !says.slice(s3).some(s => s.who === mod.username && s.kind === 'mod'));
    tick(700);
    human.staffModLevel = 4;
    const s4 = says.length;
    for (let i = 0; i < 3; i++) {
        BotChat.onPublicMessage(human, 'buying coal 140 ea');
        tick(12);
    }
    tick(80);
    check('mod: never a Jmod (a gold crown is not told off by a silver one)', !says.slice(s4).some(s => s.who === mod.username && s.kind === 'mod'));
    human.staffModLevel = 0;
    // "is there a mod here": the mod near answers, the bots near keep quiet
    sim.teleportHuman(mod.x + 2, mod.z, 0);
    tick(2);
    const s5 = says.length;
    BotChat.onPublicMessage(human, 'is there a mod here?');
    tick(30);
    const answers = says.slice(s5).filter(s => s.to === human.username && s.kind === 'reply');
    check('mod: "is there a mod here" said near the mod: it answers ("Yes, I\'m a player mod..."), no other bot does', answers.length === 1 && answers[0].who === mod.username && T.ANSWER_LINES.modYes.includes(answers[0].text), answers);
    const s6 = says.length;
    BotChat.onPublicMessage(human, `${mod.displayName} r u a mod`);
    waitUntil(() => says.slice(s6).some(s => s.who === mod.username && s.to === human.username), 60);
    check('mod: "r u a mod" by its name: yes', says.slice(s6).some(s => s.who === mod.username && T.ANSWER_LINES.modYes.some(l => s.text.startsWith(l))), saidBy(mod, s6).map(s => s.text));
    const ask = (bot, msg) => T.stateAnswer({ bot, persona: T.personaOf(bot.username), asker: human, raw: msg, msg, pick: l => l[0] });
    check('mod: another bot asked "are you a mod": no; "how do i become a mod": not the mod\'s answer', T.ANSWER_LINES.modNo.includes(ask(bystander, 'are you a mod')?.text) && T.ANSWER_LINES.modHowOther.includes(ask(bystander, 'how do i become a mod')?.text) && T.ANSWER_LINES.modHow.includes(ask(mod, 'how do i become a mod')?.text));
    check('mod: "is there a mod here" to a bot beside the mod: it points to it', T.ANSWER_LINES.modThere.includes(ask(bystander, 'is there a mod here')?.text), ask(bystander, 'is there a mod here'));
    ModBot.setModNamesForTest(null);
    mod.staffModLevel = 0;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// everything
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
    const crownedLines = says.filter(s => s.rights > 0);
    const mods = new Set(crownedLines.filter(s => s.rights === 1).map(s => s.who));
    check('every crowned line came from a mod bot (one name, the silver crown)', crownedLines.every(s => s.rights === 1) && mods.size <= 2, [...mods]);
    // (a "*word" line is a typo's correction, port/BotStyle's: no filter's star)
    const setpiece = says.filter(s => (s.kind === 'setpiece' || s.kind === 'mod') && !/^\*[a-z0-9]+$/i.test(s.text));
    check("the set piece's lines pass the 274 filter as written (no starred word)", setpiece.every(s => !s.text.includes('*')), setpiece.filter(s => s.text.includes('*')).map(s => s.text));
    const stuck = sim.bots().filter(b => Duel.duelScreen(b) !== null || b.activeScript?.execution === T.ScriptState.COUNTDIALOG);
    check('no bot left with a duel screen or a count dialog open', stuck.length === 0, stuck.map(b => `${b.username}:${b.modalMain}`));
    check('no bot errors', BotManager.stats().errors === 0 && consoleErrors.length === 0, consoleErrors.slice(0, 3));
}

let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail.slice(0, 600)}` : ''}`);
}
out(`duel: ${checks.length - failed} of ${checks.length} passed (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(failed ? 1 : 0);
