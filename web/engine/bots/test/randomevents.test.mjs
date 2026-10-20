#!/usr/bin/env node
// Random events on bots near the human (the realism work, phase 5a, Track E: port/BotRandomEvents, port/RandomEventTask;
// ), in the real 274 world (members):
//   unit      the fail teleport's spots (274's two enums) each have their way to the ground (FAIL_TELEPORT_EXITS), about
//             60 % upstairs or underground; the lamp's skill (60 % the bot's own activity, 25 % a slow skill, 15 % its
//             lowest combat stat); an event's lines fit only their kinds (port/BotLines kindFits), every kind a line
//             names is one the module notes
//   roll      only bots within 15 tiles of a human on its floor are armed (1,000 rolls, one bot each: near 1 in 12, one
//             that stood 1,000 ticks in its square 1 in 6, at 17 tiles, upstairs or far never); the cap: one at a time,
//             a winner the cap holds back waits within its roll's window, none within 5 minutes of the last start, a
//             bot once per 30 minutes; disarmed beyond 20 tiles; none in a trade, disarmed when one begins
//   answers   each kind through 274's own spawn procs on a live bot (its task idle): the genie talked to and the lamp
//             rubbed (10 × the stat's level in XP), the old man's gift, the dwarf's kebab and beer (a full pack: room
//             made), the triffid's fruit picked once ripe, the strange box solved, the mime copied and the bot home, the
//             maze finished unseen (its reward, home), a lost axe head picked up and fitted and the axe worn again (a
//             full pack, the axe worn), the lost pickaxe's, a big fish's net picked up, a whirlpool a hazard to most bots,
//             a gas rock and an ent left after a swing or three (if noticed), a swarm walked off by a fighter; each move
//             the game made marked real (BotAction.teleportStats.marks: H21 leaves it out); NPC events answered 60-90 %
//             at the default ignore share (40 events)
//   recovery  from every upstairs or underground fail-teleport spot to the ground within 150 ticks by stairs and ladders
//             (no fallback), its task re-planned; the unseen fallback where no stairs answer; an ignored genie's own
//             fail teleport about 80 ticks after it came, and the way back
//   box       never left: solved with every NPC event ignored, and by a bot that got it on a short break (once back)
//   flow      30 bots about the human for 10,000 ticks at 20 times the odds (274's 500-tick rolls, a 1-minute gap): events
//             through the real scripts (the bots' own general timers) only near the human, the cap, every lamp rubbed
//             within 5 minutes, no head left to be revealed, no logout mid-event, no errors; the same seed twice gives
//             the same events (determinism, two processes, their first 3,000 ticks)
//
//   node --expose-gc web/engine/bots/test/randomevents.test.mjs [--seed=5]   (--flow: one flow run, its JSON line)
import { spawnSync } from 'child_process';
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
const FLOW = args.flow === 'true';
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
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const errors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    console[level] = (...a) => {
        if (level !== 'error') return;
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (!text.includes('ExperimentalWarning')) errors.push(text.slice(0, 300));
    };
}

const engineDir = prepareEngineClone(FLOW ? 'randomevents-flow' : 'randomevents', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/events.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, ObjType, NpcType, LocType, InvType, PlayerStat } = lib;

const HUMAN_AT = [3222, 3218];
const notes = [];
lib.randomEventListeners.push(n => notes.push(n));
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const invHas = (b, name) => {
    const id = ObjType.getId(name);
    const inv = b.getInventory(InvType.INV);
    for (let s = 0; s < inv.capacity; s++) if (inv.get(s)?.id === id) return true;
    return false;
};
const wornHas = (b, name) => {
    const id = ObjType.getId(name);
    const w = b.getInventory(InvType.WORN);
    for (let s = 0; s < w.capacity; s++) if (w.get(s)?.id === id) return true;
    return false;
};

if (FLOW) await flow();

const sim = await lib.Sim.create({ bots: 14, members: true, debug: false, ageNewBots: true });
sim.addHuman(...HUMAN_AT, 0);
for (let i = 0; i < 60; i++) sim.tick();
// ---- unit ----
{
    const spots = new Set([...lib.failTeleportSpots(true), ...lib.failTeleportSpots(false)]);
    const missing = [...spots].filter(k => !lib.FAIL_TELEPORT_EXITS[k]);
    check("every fail-teleport spot of 274's two enums has its way to the ground (FAIL_TELEPORT_EXITS)", spots.size >= 30 && missing.length === 0 && Object.keys(lib.FAIL_TELEPORT_EXITS).every(k => spots.has(k)), `${spots.size} spots; missing ${missing.join(' ') || 'none'}`);
    const ups = [...spots].filter(k => lib.FAIL_TELEPORT_EXITS[k]?.way !== 'ground').length;
    check('about 60 % of them are upstairs or underground (the research: 274 puts most of its fail teleports there)', ups / spots.size > 0.5 && ups / spots.size < 0.75, `${ups} of ${spots.size}`);
}

lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0 });
lib.setHangoutRateForTest?.(0);
// (the bots stay where a check puts them: no friend walks off with one in a chain follow)
lib.BotCliques.setCliqueBehaviourForTest?.(false);
lib.setEventRatesForTest({ odds: 0, neighbour: 0 });
const bots = sim.bots();
const idle = b => {
    const ai = BotManager.botFor(b);
    // (its task interrupted first: since the variety work's round 2 an errand's sub-task (a hosted errand, its fight) ends
    // with it, and the bot stays where a check puts it; replaced only, the errand walked it off)
    ai?.currentTask?.interrupt?.();
    if (ai) ai.currentTask = new lib.IdleTask(1e7);
    b.clearPendingAction();
    b.clearWaypoints();
};
const place = (b, x, z, level = 0) => {
    b.clearPendingAction();
    b.clearWaypoints();
    b.teleJump(x, z, level);
};
const run = (ticks, until) => {
    for (let i = 0; i < ticks; i++) {
        sim.tick();
        if (until && until()) return i + 1;
    }
    return -1;
};

/** (the cap's checks) the bot's general event timer (274: every 500 ticks from its login, it reads the flag) held off, or let go */
const holdTimer = (b, held) => {
    const timer = [...b.timers.values()].find(t => t.script?.name?.includes('general_macro_events'));
    if (timer) timer.clock = held ? World.currentTick + 1e6 : World.currentTick;
};
/** a task that does nothing (its kind is the name's), noting an interrupt (the re-plan) */
const fakeTask = name => ({ name, interrupted: false, cooldown: 0, shouldRun: () => true, isComplete: () => false, tick() {}, interrupt() { this.interrupted = true; }, reset() {}, activityStep: () => null });
const roomFor = (b, n) => {
    const inv = b.getInventory(InvType.INV);
    for (let s = inv.capacity - 1; s >= 0 && inv.freeSlotCount < n; s--) inv.delete(s);
};
// ---- unit: the lamp's skill, the lines' kinds ----
{
    const b = bots.find(x => BotManager.botFor(x));
    idle(b);
    const random = (() => {
        const r = (() => mulberry(99))();
        return r;
    })();
    // (as a woodcutter: the WoodcuttingTask's kind)
    const ai = BotManager.botFor(b);
    const kinds = { own: 0, slow: 0, combat: 0 };
    const was = ai.currentTask;
    ai.currentTask = { name: 'Woodcut:1511' };
    const slow = new Set(['agility', 'herblore', 'runecraft', 'prayer']);
    for (let i = 0; i < 3000; i++) {
        const s = lib.lampSkill(b, random);
        if (s === 'woodcutting') kinds.own++;
        else if (slow.has(s)) kinds.slow++;
        else kinds.combat++;
    }
    ai.currentTask = was;
    check("the lamp's skill: about 60 % the bot's own activity, 25 % a slow skill, 15 % its lowest combat stat", Math.abs(kinds.own / 3000 - 0.6) < 0.04 && Math.abs(kinds.slow / 3000 - 0.25) < 0.04 && Math.abs(kinds.combat / 3000 - 0.15) < 0.04, kinds);
    // (revised in phase 5b, tracks P and A: the set pieces' own lines name kinds too, a party's 'call-first-falador_park'
    // under the event 'party' (port/BotPieceLines), the arena's under 'duel' and 'mod'; this check is the random events'
    // lines, their six events')
    const RANDOM_EVENT_EVENTS = new Set(['random-event', 'lamp', 'fail-teleported', 'axe-head', 'clue-scroll', 'random-near']);
    const lines = lib.NEW_LINES.filter(l => l.tag.kinds && RANDOM_EVENT_EVENTS.has(l.tag.event));
    const known = /^(genie|oldman|dwarf|triffid|swarm|golem|dryad|troll|zombie|shade|watchman|ent|bigfish|whirlpool|gas|gaschest|box|mime|maze|got|upstairs|basement|ground|axe|pickaxe|appear|afk|teled|oldman-(kebab|spinach|coins|casket)|dwarf-gift|triffid-fruit|box-done|box-wrong|mime-done|maze-done|gas-boom|ent-broke|appear-\w+|attack|strength|defence|hitpoints|ranged|magic|prayer|agility|herblore|thieving|crafting|runecraft|mining|smithing|fishing|cooking|firemaking|woodcutting|fletching)$/;
    const bad = lines.flatMap(l => l.tag.kinds.filter(k => !known.test(k)).map(k => `${l.text}: ${k}`));
    check('every kind an event line names is one the module notes', lines.length >= 40 && bad.length === 0, `${lines.length} lines with kinds; ${bad.slice(0, 3).join(' | ') || 'all known'}`);
    check("kinds fit their own and the ones under them ('oldman' takes 'oldman-kebab', 'appear' takes 'appear-genie'), nothing else", lib.kindFits(['oldman'], 'oldman-kebab') && lib.kindFits(['appear'], 'appear-genie') && !lib.kindFits(['genie'], 'oldman') && !lib.kindFits(['box'], 'boxer') && !lib.kindFits(['got'], undefined));
}

// ---- roll: only near a human, the odds, the cap ----
{
    scene(SEED, 'roll'); // (its own dice: test/lib/dice.mjs)
    // (no director's event here either, as the answers' below: after round 1's merge a clan walk took the cap's first
    // winner off to Varrock with its box unanswered, and the box held the cap past the held winner's window)
    lib.setDirectorForTest({ first: 1e9 });
    lib.resetDirectorForTest();
    const pool = bots.filter(b => BotManager.botFor(b)).slice(0, 4);
    // (the other bots far off: each roll is between these four)
    for (const b of bots) {
        idle(b);
        if (!pool.includes(b)) place(b, 3212 + (b.slot % 5), 3428);
    }
    // one bot near (8 tiles), one at 17, one upstairs, one far: 1,000 rolls each time a single bot is eligible
    place(pool[0], HUMAN_AT[0] + 8, HUMAN_AT[1]);
    place(pool[1], HUMAN_AT[0] + 17, HUMAN_AT[1]);
    place(pool[2], 3205, 3209, 1);
    place(pool[3], 3100, 3250);
    run(2);
    lib.setEventRatesForTest({ odds: 1, botGap: 0, gap: 0 });
    const armedBy = new Map();
    const before = notes.length;
    for (let i = 0; i < 1000; i++) {
        lib.rollForTest();
        for (const b of pool) {
            if (lib.isArmed(b)) {
                armedBy.set(b.username, (armedBy.get(b.username) ?? 0) + 1);
                // (disarmed at once: each roll alone)
                b.afkEventReady = false;
            }
        }
        lib.resetRandomEventsForTest();
    }
    const near = armedBy.get(pool[0].username) ?? 0;
    check('only a bot within 15 tiles of a human on its floor is armed: not at 17 tiles, upstairs or far', (armedBy.get(pool[1].username) ?? 0) === 0 && (armedBy.get(pool[2].username) ?? 0) === 0 && (armedBy.get(pool[3].username) ?? 0) === 0, Object.fromEntries(armedBy));
    const still = lib.zonesAfk(pool[0]);
    const want = still ? 1 / 6 : 1 / 12;
    check(`twice 274's odds: the bot within 15 tiles armed about 1 in ${still ? 6 : 12} rolls${still ? ' (it stood 1,000 ticks in its square)' : ''}`, Math.abs(near / 1000 - want) < 0.03, `${near} of 1,000`);
    notes.length = before;
    // the bot that stood 1,000 ticks in its 21x21 square: 1 in 6
    lib.setEventRatesForTest({ odds: 0 });
    run(1001);
    lib.setEventRatesForTest({ odds: 1 });
    let still2 = 0;
    for (let i = 0; i < 1000; i++) {
        lib.rollForTest();
        if (lib.isArmed(pool[0])) {
            still2++;
            pool[0].afkEventReady = false;
        }
        lib.resetRandomEventsForTest();
    }
    check("one that stood 1,000 ticks in its 21x21 square (274's zonesAfk, mirrored): about 1 in 6", lib.zonesAfk(pool[0]) && Math.abs(still2 / 1000 - 1 / 6) < 0.035, `${still2} of 1,000`);

    // the cap: one at a time; after a start, none for 5 minutes; a bot once per 30 minutes (from a roll's tick: 274's 500).
    // (the bots' general timers held off: a flag here is spent only where the check spends it)
    for (const b of pool) holdTimer(b, true);
    // (and the human's: a world whose draws moved since the variety work's round 2 gave the human its own event in the
    // 5 minutes below, whose fail teleport took it 65 tiles off the four)
    holdTimer(sim.human, true);
    lib.setEventRatesForTest({ odds: 0, botGap: lib.BOT_GAP_TICKS, gap: lib.EVENT_GAP_TICKS });
    place(pool[1], HUMAN_AT[0] + 3, HUMAN_AT[1]);
    // (to a tick just past a roll's: the engine's own roll, World.processClientsIn's, overwrites any flag set before it)
    run(3 + ((lib.ROLL_TICKS - ((World.currentTick + 2) % lib.ROLL_TICKS)) % lib.ROLL_TICKS));
    const T = World.currentTick;
    lib.setEventRatesForTest({ odds: 100 });
    lib.rollForTest();
    const armedNow = pool.filter(b => lib.isArmed(b));
    check('the cap: of two winners of the roll near the human, one is armed', T % lib.ROLL_TICKS === 1 && armedNow.length === 1, armedNow.map(b => b.username));
    const first = armedNow[0];
    lib.runProcForTest(first, 'macro_event_general_spawn', [6]);
    first.afkEventReady = false;
    lib.setEventRatesForTest({ odds: 0 });
    run(3);
    lib.setEventRatesForTest({ odds: 100 });
    const other = pool.find(b => b !== first && cheb(b, sim.human) <= 15);
    const deferred = lib.rollStats.deferred;
    lib.rollForTest();
    check('none armed while an event near the human is under way: the winner waits for the cap, within its roll\'s window', !pool.some(b => lib.isArmed(b)) && lib.rollStats.deferred === deferred + 1 && lib.pendingForTest()?.name === other?.username && lib.pendingForTest()?.until === T + lib.ROLL_TICKS - 2, { pending: lib.pendingForTest(), T });
    lib.setEventRatesForTest({ odds: 0 });
    run(T + lib.EVENT_GAP_TICKS + 2 - World.currentTick);
    const early = notes.filter(n => n.type === 'armed' && n.name === other?.username && n.tick < T + lib.EVENT_GAP_TICKS);
    check('none within 5 minutes of the last start (the held winner\'s window closed first)', early.length === 0, early.map(n => n.tick - T));
    lib.setEventRatesForTest({ odds: 100 });
    lib.rollForTest();
    check('5 minutes after the start, another bot is armed; the one that had it not (once per 30 minutes)', other && lib.isArmed(other) && !lib.isArmed(first), { other: other?.username, armed: pool.filter(b => lib.isArmed(b)).map(b => b.username) });
    // disarmed beyond 20 tiles
    place(other, HUMAN_AT[0] + 25, HUMAN_AT[1]);
    run(2);
    check('an armed bot that walks more than 20 tiles from every human is disarmed', !lib.isArmed(other) && notes.some(n => n.type === 'disarmed' && n.reason === 'far' && n.name === other.username));
    // a trade: no bot in one is armed, and an armed bot that begins one is disarmed (its outcome is the trade's)
    {
        lib.resetRandomEventsForTest();
        lib.setEventRatesForTest({ odds: 100, gap: 0, botGap: 0 });
        place(other, HUMAN_AT[0] + 4, HUMAN_AT[1] + 1);
        run(2);
        other.botTradeTargetPid = 1;
        const elig = lib.eligible(other);
        other.botTradeTargetPid = -1;
        lib.armForTest(other);
        other.botTradeTargetPid = 1;
        run(1);
        other.botTradeTargetPid = -1;
        check('a trade: a bot in one is not armed; one that begins one is disarmed', !elig && !lib.isArmed(other) && notes.some(n => n.type === 'disarmed' && n.reason === 'trade' && n.name === other.username));
        lib.setEventRatesForTest({ odds: 0 });
    }
    // a held winner is armed once the cap allows within its window (here a 100-tick gap: the box over, then armed)
    lib.resetRandomEventsForTest();
    lib.setEventRatesForTest({ odds: 0, gap: 100, botGap: 0 });
    place(other, HUMAN_AT[0] + 4, HUMAN_AT[1] + 1);
    run(3 + ((lib.ROLL_TICKS - ((World.currentTick + 2) % lib.ROLL_TICKS)) % lib.ROLL_TICKS));
    const T2 = World.currentTick;
    lib.armForTest(first);
    lib.runProcForTest(first, 'macro_event_general_spawn', [6]);
    first.afkEventReady = false;
    run(3);
    lib.setEventRatesForTest({ odds: 100 });
    lib.rollForTest();
    lib.setEventRatesForTest({ odds: 0 });
    const heldPending = lib.pendingForTest();
    const heldArmed = run(400, () => lib.isArmed(other));
    check('a winner the cap held back is armed once it allows (the event over, the gap past), within its roll\'s window', heldArmed > 0 && World.currentTick - T2 >= 100 && World.currentTick - T2 < lib.ROLL_TICKS, { armedAfter: World.currentTick - T2 });
    other.afkEventReady = false;
    lib.setEventRatesForTest({ gap: lib.EVENT_GAP_TICKS });
    for (const b of pool) holdTimer(b, false);
    run(200, () => lib.eventStateOf(first)?.boxSeen === -1 && !lib.responseDue(first, lib.eventStateOf(first), World.currentTick));
    lib.resetRandomEventsForTest();
    lib.setEventRatesForTest({ odds: 0, botGap: 0, gap: 0 });
}

// ---- answers: each kind through 274's own spawns ----
const marks = () => lib.teleportStats.marks;
function force(b, proc, procArgs = [], target = null) {
    const t0 = World.currentTick;
    lib.armForTest(b);
    const ok = lib.runProcForTest(b, proc, procArgs, target);
    b.afkEventReady = false;
    return ok ? t0 : -1;
}
const done = b => {
    const st = lib.eventStateOf(b);
    return !!st && !!st.ev && st.ev.endedAt >= 0 && !st.fail && !st.zoneKind && st.boxSeen < 0 && st.lampSeen < 0 && st.drops.length === 0 && !lib.responseDue(b, st, World.currentTick);
};
// (phase 5b: no director's event in the staging, and a picked bot free of any part: a clan walk's sub-task held one, its
// answer to the event waited behind it)
lib.setDirectorForTest({ first: 1e9 });
lib.resetDirectorForTest();
const pick = () => {
    const b = bots.find(x => x.slot !== -1 && BotManager.botFor(x) && !BotManager.botFor(x).hasSubTask() && lib.eventRoleOf(x) === null && !lib.eventStateOf(x)?.fail);
    bots.push(bots.splice(bots.indexOf(b), 1)[0]);
    idle(b);
    lib.resetRandomEventsForTest();
    sim.teleportHuman(...HUMAN_AT, 0);
    place(b, HUMAN_AT[0] + 2, HUMAN_AT[1] - 3);
    run(2);
    return b;
};
lib.setEventRatesForTest({ ignore: 0 });
{
    scene(SEED, 'answers 1'); // (its own dice: test/lib/dice.mjs)
    // the genie: talked to, the lamp rubbed for 10 × the level of its skill
    const b = pick();
    const t0 = force(b, 'macro_event_general_spawn', [2]);
    const answered = run(120, () => lib.eventStateOf(b)?.ev?.answered);
    const lampAt = notes.find(n => n.type === 'lamp-got' && n.name === b.username && n.tick >= t0)?.tick ?? -1;
    run(200, () => notes.some(n => n.type === 'lamp-rubbed' && n.name === b.username && n.tick >= t0));
    const rub = notes.find(n => n.type === 'lamp-rubbed' && n.name === b.username && n.tick >= t0);
    check('the genie: talked to within a person\'s moment (3-25 s, or after its first warning), its lamp rubbed 10-60 s later for 10 × the level of the skill', answered > 0 && answered <= 60 && lampAt > 0 && rub && rub.tick - lampAt >= 15 && rub.tick - lampAt <= 110 && rub.level > 0 && rub.xp === rub.level * 100 && !invHas(b, 'macro_genilamp'), { answered, lampAt: lampAt - t0, rub: rub && { at: rub.tick - lampAt, stat: rub.stat, xp: rub.xp, level: rub.level } });
    run(30, () => done(b));
}
{
    scene(SEED, 'answers 2'); // (its own dice: test/lib/dice.mjs)
    const b = pick();
    const gifts = ['kebab', 'spinach_roll', 'casket', 'coins'];
    const before = gifts.map(n => lib.countItem(b, ObjType.getId(n)));
    const t0 = force(b, 'macro_event_general_spawn', [4]);
    run(120, () => lib.eventStateOf(b)?.ev?.answered);
    run(20);
    const gift = gifts.filter((n, i) => lib.countItem(b, ObjType.getId(n)) > before[i]);
    check("the old man: talked to, his gift in the pack", lib.eventStateOf(b)?.ev?.answered && gift.length > 0, { gift, ticks: World.currentTick - t0 });
}
{
    scene(SEED, 'answers 3'); // (its own dice: test/lib/dice.mjs)
    const b = pick();
    // (a full pack: room made for the kebab and the beer)
    const inv = b.getInventory(InvType.INV);
    while (inv.freeSlotCount > 0) inv.add(ObjType.getId('logs'), 1);
    force(b, 'macro_event_general_spawn', [3]);
    run(120, () => lib.eventStateOf(b)?.ev?.answered);
    run(10);
    check('the drunken dwarf: talked to, his kebab and beer in the pack (a full pack: room made first, logs dropped)', lib.eventStateOf(b)?.ev?.answered && invHas(b, 'kebab') && invHas(b, 'beer'));
}
{
    scene(SEED, 'answers 4'); // (its own dice: test/lib/dice.mjs)
    const b = pick();
    const t0 = force(b, 'macro_event_general_spawn', [5]);
    const picked = run(150, () => invHas(b, 'macro_triffidfruit'));
    check("the triffid's strange plant: picked once it is ripe (45 ticks), the fruit in the pack", picked >= 44 && picked <= 95, { picked, answeredAt: notes.find(n => n.type === 'answered' && n.name === b.username && n.tick >= t0)?.tick - t0 });
}
{
    scene(SEED, 'answers 5'); // (its own dice: test/lib/dice.mjs)
    const b = pick();
    const t0 = force(b, 'macro_event_general_spawn', [6]);
    const solved = run(200, () => notes.some(n => n.type === 'box-solved' && n.name === b.username && n.tick >= t0));
    check('the strange box: opened 5-40 s after it came and solved (no box left)', solved > 0 && !invHas(b, 'macro_cube'), { solved });
}
{
    scene(SEED, 'answers 6'); // (its own dice: test/lib/dice.mjs)
    const b = pick();
    const home = [b.x, b.z];
    const marksBefore = marks().length;
    const t0 = force(b, 'macro_event_general_spawn', [7]);
    const inMime = run(10, () => lib.inMimeZone(b.x, b.z, b.level));
    const back = run(1150, () => !lib.inMimeZone(b.x, b.z, b.level));
    const m = marks().slice(marksBefore).filter(x => x.name === b.username.toLowerCase() && x.cls === 'event');
    check('the mime: copied (4 in a row, 10 % wrong), the bot home where it was, both moves marked real', inMime > 0 && back > 0 && cheb(b, { x: home[0], z: home[1] }) <= 2 && b.level === 0 && m.length >= 2, { back, at: [b.x, b.z], marks: m.length, ticks: World.currentTick - t0 });
}
{
    scene(SEED, 'answers 7'); // (its own dice: test/lib/dice.mjs)
    const b = pick();
    const home = [b.x, b.z];
    const items = () => b.getInventory(InvType.INV).items.reduce((n, it) => n + (it ? it.count : 0), 0);
    const before = items();
    const marksBefore = marks().length;
    force(b, 'macro_event_general_spawn', [8]);
    const inMaze = run(10, () => lib.inMazeZone(b.x, b.z, b.level));
    const back = run(500, () => !lib.inMazeZone(b.x, b.z, b.level));
    const m = marks().slice(marksBefore).filter(x => x.name === b.username.toLowerCase());
    check('the maze: finished unseen at its shrine after 90-240 s, its reward, the bot home; the moves marked real', inMaze > 0 && back >= 150 && back <= 460 && cheb(b, { x: home[0], z: home[1] }) <= 2 && items() > before && m.length >= 3, { back, at: [b.x, b.z], items: [before, items()], marks: m.length });
}
{
    scene(SEED, 'answers 8'); // (its own dice: test/lib/dice.mjs)
    // a lost axe head: the axe worn, a full pack: room made, the handle off, the head picked up and fitted, the axe worn again
    const b = pick();
    const axe = ObjType.getId('bronze_axe');
    const w = b.getInventory(InvType.WORN);
    const inv = b.getInventory(InvType.INV);
    const held = w.get(3);
    if (held) {
        w.delete(3);
        if (inv.freeSlotCount > 0) inv.add(held.id, 1);
    }
    w.set(3, { id: axe, count: 1 });
    while (inv.freeSlotCount > 0) inv.add(ObjType.getId('logs'), 1);
    // (no other axe: woodcutting_axe_checker picks the worn one)
    for (let s = 0; s < inv.capacity; s++) {
        const name = ObjType.get(inv.get(s)?.id ?? -1)?.debugname ?? '';
        if (/_axe$/.test(name)) inv.set(s, { id: ObjType.getId('logs'), count: 1 });
    }
    const t0 = force(b, 'macro_event_lost_axe_spawn');
    const dropped = notes.find(n => n.type === 'dropped' && n.name === b.username && n.tick >= t0);
    run(3);
    const drop = dropped ?? notes.find(n => n.type === 'dropped' && n.name === b.username && n.tick >= t0);
    const fixed = run(120, () => wornHas(b, 'bronze_axe') && !invHas(b, 'macro_hatchethandle') && !wornHas(b, 'macro_hatchethandle'));
    const picked = notes.find(n => n.type === 'picked' && n.name === b.username && n.tick >= t0);
    check('a lost axe head (the axe worn, a full pack): picked up 5-20 s after it landed (before 274 reveals it at 100 ticks), fitted, the axe in its hands again', drop && fixed > 0 && !drop.obj.isActive && picked && picked.tick - drop.tick >= 8 && picked.tick - drop.tick <= 60, { fixed, picked: picked ? picked.tick - drop.tick : null });
}
{
    scene(SEED, 'answers 9'); // (its own dice: test/lib/dice.mjs)
    const b = pick();
    const inv = b.getInventory(InvType.INV);
    for (let s = 0; s < inv.capacity; s++) if (/pickaxe/.test(ObjType.get(inv.get(s)?.id ?? -1)?.debugname ?? '')) inv.delete(s);
    // (the variety work, round 1, track W: a miner's name or a wielder holds its pickaxe now, and 274's event takes the
    // worn one's head first; this case is the pack's pickaxe: none in its hands)
    const worn = b.getInventory(InvType.WORN);
    if (/pickaxe/.test(ObjType.get(worn.get(3)?.id ?? -1)?.debugname ?? '')) worn.delete(3);
    lib.addItem(b, ObjType.getId('iron_pickaxe'));
    const t0 = force(b, 'macro_event_lost_pickaxe_spawn');
    const fixed = run(120, () => invHas(b, 'iron_pickaxe') && !invHas(b, 'macro_pickaxehandle'));
    const drop = notes.find(n => n.type === 'dropped' && n.name === b.username && n.tick >= t0);
    check('a lost pickaxe head: picked up and fitted (the pickaxe back in the pack)', drop && fixed > 0 && !drop.obj.isActive, { fixed });
}
// at Draynor: the fishing spots, the willows
const DRAYNOR = [3088, 3232];
function nearestSpot(x, z, suffix) {
    let best = null;
    for (const npc of World.npcs) {
        if (!npc || !npc.isActive) continue;
        const name = NpcType.get(npc.type)?.debugname ?? '';
        if (!name.endsWith(suffix) || name.startsWith('macro_')) continue;
        if (!best || cheb(npc, { x, z }) < cheb(best, { x, z })) best = npc;
    }
    return best;
}
function nearestLoc(x, z, radius, test) {
    for (let r = 0; r <= radius; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                for (const loc of World.gameMap.getZone(x + dx, z + dz, 0).getAllLocsSafe()) if (loc.isActive && loc.x === x + dx && loc.z === z + dz && test(loc)) return loc;
            }
        }
    }
    return null;
}
{
    scene(SEED, 'answers 10'); // (its own dice: test/lib/dice.mjs)
    const b = pick();
    sim.teleportHuman(...DRAYNOR, 0);
    lib.addItem(b, ObjType.getId('net'));
    const spot = nearestSpot(3086, 3228, '_saltfish');
    place(b, spot.x, spot.z + 1);
    run(2);
    const t0 = force(b, 'macro_event_bigfish_spawn', [ObjType.getId('net')], spot);
    const back = run(120, () => notes.some(n => n.type === 'picked' && n.name === b.username && n.tick >= t0));
    check("a big fish: the net it took from the bot picked up off the ground (before 274 reveals it)", back > 0 && invHas(b, 'net'), { back });
    // a whirlpool: noticed (90 %), its spot skipped by the finder
    const b2 = pick();
    sim.teleportHuman(...DRAYNOR, 0);
    place(b2, spot.x, spot.z + 1);
    run(2);
    force(b2, 'macro_event_whirlpool_spawn', [], spot);
    run(3);
    const pool = NpcType.get(spot.type)?.debugname ?? '';
    const noticed = lib.isEventHazard(b2, spot);
    const others = [];
    for (const x of bots.slice(0, 12)) others.push(lib.isEventHazard(x, spot));
    check('a whirlpool (the spot changed): a hazard to the bots that notice it (90 %), whose fishing skips it', pool.startsWith('macro_whirlpool') && others.filter(Boolean).length >= 8, { pool, noticed, others: others.filter(Boolean).length });
    run(65);
}
{
    scene(SEED, 'answers 11'); // (its own dice: test/lib/dice.mjs)
    // gas: a miner at a rock that turns to gas stops within a few swings when it notices (80 %)
    const results = [];
    for (let i = 0; i < 5; i++) {
        const b = pick();
        sim.teleportHuman(3082, 3425, 0);
        roomFor(b, 3);
        lib.addItem(b, ObjType.getId('bronze_pickaxe'));
        const rock = nearestLoc(3080 + i * 2, 3421, 10, l => /^(copper|tin)rock/.test(LocType.get(l.type)?.debugname ?? ''));
        place(b, rock.x, rock.z + 1);
        run(2);
        force(b, 'macro_event_gas_spawn', [], rock);
        run(3);
        const st = lib.eventStateOf(b);
        const noticedAt = st?.ev?.answerAt ?? -1;
        run(20);
        const stillAt = b.target === rock;
        results.push({ kind: st?.ev?.kind, noticed: noticedAt >= 0, left: st?.ev?.left, stillAt });
        run(60);
    }
    check('a gas rock: the miner that notices it (80 %) leaves it after a swing or three; it is a hazard to it after', results.every(r => r.kind === 'gas') && results.filter(r => r.noticed).every(r => r.left && !r.stillAt) && results.some(r => r.noticed), results);
}
{
    scene(SEED, 'answers 12'); // (its own dice: test/lib/dice.mjs)
    // an ent: the woodcutter's chop goes on to it; one that notices (85 %) stops
    const results = [];
    for (let i = 0; i < 4; i++) {
        const b = pick();
        sim.teleportHuman(...DRAYNOR, 0);
        lib.addItem(b, ObjType.getId('bronze_axe'));
        const tree = nearestLoc(3165 + i * 3, 3226, 30, l => /^tree\d*$/.test(LocType.get(l.type)?.debugname ?? '') && (LocType.get(l.type)?.op ?? []).includes('Chop down'));
        sim.teleportHuman(tree.x + 3, tree.z + 3, 0);
        roomFor(b, 3);
        place(b, tree.x - 1, tree.z);
        run(2);
        force(b, 'macro_event_ent_spawn', [], tree);
        run(3);
        const st = lib.eventStateOf(b);
        const ent = st?.ev?.npc;
        run(20);
        results.push({ kind: st?.ev?.kind, noticed: (st?.ev?.answerAt ?? -1) >= 0, left: st?.ev?.left, chopping: !!ent && b.target === ent });
        run(60);
    }
    // (variety round 2, the fixes: one that is not chopping it when its notice comes due has nothing to leave: its task had
    // gone on to another tree (left false, chopping false, seed 5 from round 2's merge on, where the world's dice moved);
    // the miss would be one that noticed and chops on)
    check('an ent: the woodcutter that notices it (85 %) stops chopping it', results.every(r => r.kind === 'ent') && results.filter(r => r.noticed).every(r => !r.chopping) && results.some(r => r.noticed && r.left), results);
}
{
    scene(SEED, 'answers 13'); // (its own dice: test/lib/dice.mjs)
    // a swarm on a fighter: walked off (its 255 Hitpoints)
    const b = pick();
    const ai = BotManager.botFor(b);
    ai.currentTask = fakeTask('Combat:fake');
    force(b, 'macro_event_general_spawn', [1]);
    run(3);
    const swarm = lib.eventStateOf(b)?.ev?.npc;
    const gone = run(80, () => !swarm || !swarm.isActive);
    idle(b);
    check('a swarm on a fighter: walked off (more than 3 tiles from it and it is gone)', lib.eventStateOf(b)?.ev?.kind === 'swarm' && gone > 0, { gone });
}

// ---- recovery: from every fail-teleport spot ----
{
    scene(SEED, 'recovery'); // (its own dice: test/lib/dice.mjs)
    const spots = Object.entries(lib.FAIL_TELEPORT_EXITS).filter(([, e]) => e.way !== 'ground');
    const results = [];
    sim.teleportHuman(...HUMAN_AT, 0);
    for (const [key, exit] of spots) {
        const b = pick();
        const [level, x, z] = key.split('_').map(Number);
        place(b, x, z, level);
        run(1);
        const ai = BotManager.botFor(b);
        const task = fakeTask('Woodcut:fake');
        ai.currentTask = task;
        const fallbacksBefore = notes.filter(n => n.type === 'recovered' && n.fallback).length;
        lib.failRecoveryForTest(b);
        const t = run(150, () => notes.some(n => n.type === 'recovered' && n.name === b.username && n.tick > World.currentTick - 2));
        const rec = notes.filter(n => n.type === 'recovered' && n.name === b.username).at(-1);
        results.push({ key, ok: t > 0 && b.level === 0 && b.z < 6400 && rec && !rec.fallback && task.interrupted, t, at: [b.x, b.z, b.level], exit: exit.exit, fallback: notes.filter(n => n.type === 'recovered' && n.fallback).length > fallbacksBefore });
        idle(b);
    }
    const bad = results.filter(r => !r.ok);
    check(`from every one of the ${spots.length} upstairs and underground fail-teleport spots: on the ground within 150 ticks by its stairs or ladders (no fallback), its task re-planned`, spots.length >= 20 && bad.length === 0, bad.length ? bad.slice(0, 4) : `slowest ${Math.max(...results.map(r => r.t))} ticks`);
    // the fallback: a bot upstairs where no stairs answer it (in a tower with its ladder gone: a far tile no climb reaches)
    const b = pick();
    place(b, 3221, 3474, 3);
    run(1);
    lib.failRecoveryForTest(b);
    const st = lib.eventStateOf(b);
    st.fail.lastClimb = 1e9; // (no climb: the stairs never answer)
    const t = run(160, () => notes.some(n => n.type === 'recovered' && n.name === b.username && n.fallback));
    check('where no stairs answer: the unseen jump to the spot\'s exit after 100 ticks, marked real', t >= 95 && b.level === 0 && marks().some(m => m.name === b.username.toLowerCase() && m.cls === 'event' && m.tick >= World.currentTick - t - 2), { t, at: [b.x, b.z, b.level] });
    idle(b);
}

// ---- answered: NPC events with the default ignore share (25 %; the bots idle, none at a gathering skill) ----
{
    scene(SEED, 'answered'); // (its own dice: test/lib/dice.mjs)
    lib.setEventRatesForTest({ ignore: -1 });
    const kinds = [2, 4, 3, 2, 4, 3, 2, 4];
    let started = 0;
    let answered = 0;
    const ignoredMarks = [];
    for (let round = 0; round < 5; round++) {
        const group = [];
        sim.teleportHuman(...HUMAN_AT, 0);
        for (let i = 0; i < 8; i++) {
            const b = bots.find(x => x.slot !== -1 && BotManager.botFor(x) && !group.includes(x) && !lib.eventStateOf(x)?.fail && !lib.eventStateOf(x)?.zoneKind);
            bots.push(bots.splice(bots.indexOf(b), 1)[0]);
            idle(b);
            place(b, HUMAN_AT[0] - 6 + i * 2, HUMAN_AT[1] - 4 + (round % 2) * 8);
            group.push(b);
        }
        run(2);
        lib.resetRandomEventsForTest();
        const t0 = World.currentTick;
        group.forEach((b, i) => force(b, 'macro_event_general_spawn', [kinds[i]]));
        run(260, () => group.every(b => done(b)));
        for (const b of group) {
            const st = lib.eventStateOf(b);
            if (!st?.ev || st.ev.start < t0) continue;
            started++;
            if (st.ev.answered) answered++;
            else ignoredMarks.push(st.ev.kind);
        }
        run(60, () => group.every(b => !lib.eventStateOf(b)?.fail));
    }
    check('NPC events answered 60-90 % with the default ignore share (25 %: they stand on, a fail teleport or the dwarf\'s stones)', started >= 36 && pct(answered, started) >= 60 && pct(answered, started) <= 90, { started, answered: pct(answered, started), ignored: ignoredMarks.join(' ') });
    lib.setEventRatesForTest({ ignore: 0 });
}

// ---- box: never left ----
{
    scene(SEED, 'box'); // (its own dice: test/lib/dice.mjs)
    lib.setEventRatesForTest({ ignore: 1 });
    const b = pick();
    const t0 = force(b, 'macro_event_general_spawn', [6]);
    const solved = run(250, () => notes.some(n => n.type === 'box-solved' && n.name === b.username && n.tick >= t0));
    check('a strange box is solved with every NPC event ignored', solved > 0 && !invHas(b, 'macro_cube'), { solved });
    // (a bot at its own skill takes breaks: 200 times its rate, one about every minute; it got the box on one)
    lib.setHabitRatesForTest({ breaks: 200, lingers: 0 });
    const breakKinds = new Set(['Woodcut', 'Mine', 'Fish', 'Cook', 'Smith', 'Crafting', 'Fletching', 'Firemaking', 'Combat']);
    lib.resetRandomEventsForTest();
    // (the bots back to their planners' tasks)
    for (const x of sim.bots()) {
        const ai = BotManager.botFor(x);
        if (ai && ai.currentTask?.name === 'Idle') ai.currentTask = null;
    }
    let b2 = null;
    const onBreak = run(3000, () => {
        b2 = sim.bots().find(x => lib.isAway(x) && breakKinds.has((BotManager.botFor(x)?.currentTask?.name ?? '').split(':')[0]) && !lib.eventStateOf(x)?.fail);
        return !!b2;
    });
    // (274 gives no strange box to a full pack: the old man's event becomes the maze; a gatherer on its break often has
    // one, the merged world's dice gave a crafter's)
    const inv2 = b2?.getInventory(InvType.INV);
    if (inv2 && inv2.freeSlotCount === 0) inv2.delete(inv2.capacity - 1);
    const t1 = force(b2, 'macro_event_general_spawn', [6]);
    let away = 0;
    let backAt = -1;
    let openedAway = 0;
    const cubeRoot = lib.Component.get(lib.Component.getId('macro_cube:answer_button1'))?.rootLayer ?? -2;
    const solved2 = run(900, () => {
        if (lib.isAway(b2)) {
            away++;
            if (b2.modalMain === cubeRoot) openedAway++;
        } else if (backAt < 0) backAt = World.currentTick - t1;
        return notes.some(n => n.type === 'box-solved' && n.name === b2.username && n.tick >= t1);
    });
    check('and by a bot that got it on a short break: solved once it is back, never opened while away', onBreak > 0 && solved2 > 0 && !invHas(b2, 'macro_cube') && away > 0 && openedAway === 0 && solved2 > backAt, { onBreak, solved: solved2, awayTicks: away, backAt });
    lib.setHabitRatesForTest({ breaks: 0 });
    lib.setEventRatesForTest({ ignore: 0 });
}

// ---- the ignored genie: the fail teleport in sight, the way down ----
{
    scene(SEED, 'the ignored genie'); // (its own dice: test/lib/dice.mjs)
    lib.setEventRatesForTest({ ignore: 1 });
    const b = pick();
    const marksBefore = marks().length;
    const t0 = force(b, 'macro_event_general_spawn', [2]);
    const moved = run(160, () => notes.some(n => n.type === 'move' && n.move === 'fail' && n.name === b.username && n.tick >= t0));
    const back = run(200, () => notes.some(n => n.type === 'recovered' && n.name === b.username && n.tick >= t0));
    const m = marks().slice(marksBefore).filter(x => x.name === b.username.toLowerCase() && x.cls === 'event');
    check("an ignored genie: 274's fail teleport about 80 ticks after it came (seen: no unseen rule for the game's own), marked real; the bot back on the ground", moved >= 70 && moved <= 100 && back > 0 && b.level === 0 && b.z < 6400 && m.length >= 1, { moved, back, at: [b.x, b.z, b.level] });
    lib.setEventRatesForTest({ ignore: 0 });
}

// ---- a jump of the bot's own while a genie waits (a climb, a boat, a spell): not the fail teleport ----
{
    scene(SEED, 'a jump'); // (its own dice: test/lib/dice.mjs)
    lib.setEventRatesForTest({ ignore: 1 });
    const b = pick();
    const t0 = force(b, 'macro_event_general_spawn', [2]);
    run(12);
    // (8 tiles off at once, on its floor, as a ladder or a boat moves a bot: the genie follows it, 274's macro_event_lost)
    place(b, b.x + 8, b.z);
    const early = run(30, () => notes.some(n => n.type === 'move' && n.move === 'fail' && n.name === b.username && n.tick >= t0));
    const st = lib.eventStateOf(b);
    const going = !!st?.ev && st.ev.endedAt < 0 && !st.ev.teleported && !st.fail;
    const moved = run(160, () => notes.some(n => n.type === 'move' && n.move === 'fail' && n.name === b.username && n.tick >= t0));
    const back = run(200, () => notes.some(n => n.type === 'recovered' && n.name === b.username && n.tick >= t0));
    const fails = notes.filter(n => n.type === 'move' && n.move === 'fail' && n.name === b.username && n.tick >= t0).length;
    check("a jump of the bot's own while a genie waits is not the fail teleport (the event goes on); 274's own later is, once, and the bot comes back to the ground", early === -1 && going && moved > 0 && fails === 1 && back > 0 && b.level === 0 && b.z < 6400, { early, going, moved, fails, back, at: [b.x, b.z, b.level] });
    lib.setEventRatesForTest({ ignore: 0 });
}

check('no errors in the forced runs', errors.length === 0, errors.slice(0, 3).join(' | '));

// ---- flow: two processes, the same seed ----
{
    const runFlow = (ticks = 10000) => {
        const r = spawnSync(process.execPath, ['--expose-gc', path.join(BOTS_DIR, 'test/randomevents.test.mjs'), '--flow', `--seed=${SEED}`, `--ticks=${ticks}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        const line = (r.stdout ?? '').split('\n').find(l => l.startsWith('{"flow"'));
        if (!line) throw new Error(`the flow run gave no report (exit ${r.status}): ${(r.stderr ?? '').slice(0, 400)}`);
        return JSON.parse(line).flow;
    };
    const a = runFlow();
    const b = runFlow(3000);
    // (revised in phase 5b, track P: 7, not 8: the starts are the world's dice, 8, 10, 9 and 8 at seeds 5, 1, 2 and 3 on
    // phase 5b's foundation and 7, 10, 9 and 8 with track P's line pools and clocks, the same 19 rolls; 8 failed one
    // world in five)
    check('flow: events through the real scripts (7 or more in 20 rolls, spent by the bots\' own general timers), all on bots within 15 tiles of the human when armed and 20 when they started', a.starts >= 7 && a.farArmed === 0 && a.farStarts === 0, { starts: a.starts, kinds: a.kinds, farArmed: a.farArmed, farStarts: a.farStarts, disarmed: a.disarmed, rolls: a.rolls });
    check('flow: the cap, one event at a time near the human (none armed while one is under way)', a.overlaps === 0, { overlaps: a.overlaps });
    check('flow: every lamp rubbed within 5 minutes', a.lamps === a.lampsQuick, { lamps: a.lamps, quick: a.lampsQuick });
    check('flow: no tool head or rod left to be revealed; no logout in the middle of an event', a.headsLeft === 0 && a.midEventLogouts === 0, { heads: a.heads, left: a.headsLeft, midEventLogouts: a.midEventLogouts });
    check('flow: no errors', a.errors === 0, a.errorText);
    check('the same seed gives the same events (two processes: their first 3,000 ticks)', a.hash3000 === b.hash3000 && !!a.hash3000, { a: a.hash3000, b: b.hash3000 });
}

let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(`randomevents: ${checks.length - failed} of ${checks.length} passed`);
process.exit(failed ? 1 : 0);

// ---- the flow run (a child process: --flow) ----
async function flow() {
    const N = 30;
    const TICKS = Number(args.ticks ?? 6000);
    const saves = new Map();
    const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, saves, ackLogouts: true, extra: { timing: { session: [1500, 4000], away: [600, 1200], newcomer: [1e7, 1e7], newCharacterCount: [0, 0] }, savedNames: () => [...saves.keys()] } });
    sim.addHuman(...HUMAN_AT, 0);
    // (274's cadence, a roll every 500 ticks; twenty times the odds and a 1-minute gap: an event most rolls; no friend
    // walks a gathered bot off in a chain follow)
    lib.setEventRatesForTest({ odds: 20, gap: 100, botGap: 1500 });
    lib.BotCliques.setCliqueBehaviourForTest?.(false);
    const human = sim.human;
    const logouts = [];
    let overlaps = 0;
    let hash = 2166136261;
    let hashAt = '';
    const mix = s => {
        for (let i = 0; i < s.length; i++) hash = Math.imul(hash ^ s.charCodeAt(i), 16777619) >>> 0;
    };
    lib.randomEventListeners.push(n => mix(`${n.tick}|${n.type}|${n.name}|${n.kind ?? ''}|${n.move ?? ''}`));
    const heads = [];
    lib.randomEventListeners.push(n => {
        if (n.type === 'dropped') heads.push({ obj: n.obj, t: n.tick, left: null });
    });
    for (let t = 0; t < TICKS; t++) {
        // (the human walks between three spots of Lumbridge, 10 minutes each: the bots near it change)
        if (t % 1000 === 0) {
            const spots = [HUMAN_AT, [3255, 3276], [3236, 3297]];
            sim.teleportHuman(...spots[(t / 1000) % 3], 0);
        }
        if (human.levels[3] < human.baseLevels[3]) human.levels[3] = human.baseLevels[3];
        // the bots gather round the human now and then (some always in its view at a roll; their tasks walk them off)
        if (t % 100 === 0) {
            for (const b of sim.bots()) {
                if (b.botPlanner === 'extras_pker' || b.botPlanner === 'extras_edgeville_pker') continue;
                const st = lib.eventStateOf(b);
                if (st && (st.fail || st.zoneKind || (st.ev && st.ev.endedAt < 0) || st.drops.length)) continue;
                const far = cheb(b, human) > 15;
                if (far && b.level === 0 && b.z < 6400) {
                    b.clearPendingAction();
                    b.clearWaypoints();
                    b.teleJump(human.x + ((b.slot % 9) - 4), human.z + ((b.slot % 7) - 3), 0);
                }
                // (they stand about, as a crowd does, a roll's window at a time; then they go on with their tasks)
                const ai = BotManager.botFor(b);
                if (ai && (far || t % 500 === 0) && cheb(b, human) <= 15) ai.currentTask = new lib.IdleTask(600);
            }
        }
        const before = new Set(sim.bots());
        sim.tick();
        const after = new Set(sim.bots());
        for (const b of before) {
            if (after.has(b)) continue;
            const st = lib.eventStateOf(b);
            if (st && (st.zoneKind || st.fail || st.boxSeen >= 0)) logouts.push(b.username);
        }
        // one at a time near the human: armed or under way (the cap)
        const now = World.currentTick;
        let underWay = 0;
        for (const b of after) {
            const st = lib.eventStateOf(b);
            if (lib.isArmed(b) || (st?.ev && st.ev.endedAt < 0 && st.ev.near && now - st.ev.start < 1000)) underWay++;
        }
        if (underWay > 1) overlaps++;
        for (const h of heads) if (h.left === null && now - h.t >= 99) h.left = h.obj.isActive === true;
        if (t === 2999) hashAt = hash.toString(16);
    }
    const starts = notes.filter(n => n.type === 'start' && n.kind !== 'none');
    const npcStarts = starts.filter(n => ['genie', 'oldman', 'dwarf', 'triffid'].includes(n.kind) && n.tick <= TICKS - 200);
    const answered = npcStarts.filter(s => notes.some(n => n.type === 'answered' && n.name === s.name && n.tick >= s.tick && n.tick - s.tick <= 400));
    const lamps = notes.filter(n => n.type === 'lamp-got' && n.tick <= TICKS - 500);
    const quick = lamps.filter(g => notes.some(n => n.type === 'lamp-rubbed' && n.name === g.name && n.tick >= g.tick && n.tick - g.tick <= 500));
    const kinds = {};
    for (const s of starts) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    const report = {
        starts: starts.length,
        kinds,
        disarmed: notes.filter(n => n.type === 'disarmed').map(n => n.reason).join(' '),
        farArmed: notes.filter(n => n.type === 'armed' && !(n.humanDist <= 15)).length,
        farStarts: starts.filter(n => !(n.humanDist <= 20)).length,
        overlaps,
        rolls: lib.rollStats,
        npc: npcStarts.length,
        answeredShare: pct(answered.length, npcStarts.length),
        lamps: lamps.length,
        lampsQuick: quick.length,
        heads: heads.length,
        headsLeft: heads.filter(h => h.left === true).length,
        midEventLogouts: logouts.length,
        errors: errors.length,
        errorText: errors.slice(0, 2).join(' | '),
        hash: hash.toString(16),
        hash3000: hashAt
    };
    out(JSON.stringify({ flow: report }));
    process.exit(0);
}
