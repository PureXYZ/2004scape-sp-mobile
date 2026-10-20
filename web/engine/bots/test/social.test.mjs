#!/usr/bin/env node
// Social life (the realism work, phase 3, track C: tasks/SocialTask, port/BotCliques, port/BotStage's hub exchanges,
// port/BotFollow's clique follow, the PK tasks' clique moves; every new line through the 274 filter is
// test/chat-filter.test.mjs's):
//   cliques    built the same from the same names with no dice (a pure function of the roster; a longer roster keeps a
//              shorter one's); levelling cliques of 3-6, PK cliques of 2-4, a name in at most one, one kind each; about
//              a quarter of the levelling names in one; each member like its clique's first (its home region, or its age
//              tier, at most a little off); cliqueOf the same for every member
//   log in     cliqueReturnBonus: 0 with no clique-mate online, more with more, always under one bot of the role mix; a
//              stand-in of BotManager._pickReturner (the arrivals work's call) brings back a mate of a bot online first,
//              never past a group's place
//   caps       a hub's cap: a quarter of 2004's crowd there per 100 online (at least 1), Lumbridge at most 3 per 100
//   a world    the real 274 world, 60 aged bots, a human at Varrock West (no random events on it):
//     regulars every social bot goes to a hub and stands there, on a tile of its own; no hub over its cap; no tour and
//              no tips (no coins put up, none gained, none traded)
//     lure     forced (setSocialRatesForTest): a regular approaches the human, pitches a 2004 lure and leads to
//              Edgeville; the human follows; it crosses into the Wilderness, betrays and attacks the human there (never
//              outside); another regular's approach within 30 minutes is no lure
//     train    cliqueStepFor: a clique-mate's step of the same skill at a level it suits, the skill's own object
//     travel   two of a clique going the same way: one follows the other with the game's Follow (op 3), near it, until
//              it arrives at their spot
//     greet    two of a clique that meet: one says the other's first name
//     goodbye  cliqueDeparture: a goodbye naming a friend near, a departure line
//     PK       two deep PKers of a clique patrol together (one zone, within 8 tiles most of the time); two Edgeville
//              PKers of a clique (two in no fight, if there are such) stand together at the edge (within 8 tiles most
//              of the time after a minute) and never fight each other
//     errors   none
//
//   node --expose-gc web/engine/bots/test/social.test.mjs [--seed=5]
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, BOTS_SRC, importTs } from './lib/paths.mjs';
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
const pct = (a, b) => (b ? (100 * a) / b : 0);
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

const logErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    console[level] = (...a) => {
        if (level !== 'error') return;
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (!text.includes('ExperimentalWarning')) logErrors.push(text.slice(0, 300));
    };
}
const engineDir = prepareEngineClone('social', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/social.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, Cliques } = lib;

// ---- 1. cliques from the names (no world needed) ----
{
    const roster = lib.BOT_NAMES;
    const random = Math.random;
    // (no dice: a build with Math.random gone gives the same)
    Math.random = () => {
        throw new Error('the cliques drew a die');
    };
    let built;
    let again;
    let threw = null;
    try {
        built = Cliques.cliquesOfRoster(roster);
        again = Cliques.cliquesOfRoster([...roster]);
    } catch (err) {
        threw = String(err);
    }
    Math.random = random;
    check('cliques: built the same from the same names, with no dice', threw === null && JSON.stringify(built) === JSON.stringify(again), threw ?? `${built.length} cliques`);
    const shorter = Cliques.cliquesOfRoster(roster.slice(0, 1200));
    const shorterKeys = new Set(shorter.map(c => c.names.join(',')));
    check('cliques: a longer roster keeps a shorter one\'s (append only: names added later make their own)', shorter.every(c => built.some(b => b.names.join(',') === c.names.join(','))) && shorterKeys.size === shorter.length, `${shorter.length} of the first 1,200 names' cliques`);
    const live = Cliques.allCliques();
    check('cliques: the game\'s are the roster\'s', JSON.stringify(live.map(c => [c.kind, c.names])) === JSON.stringify(built.map(c => [c.kind, [...c.names]])));
    const seen = new Map();
    let twice = 0;
    let badSize = 0;
    let mixed = 0;
    for (const c of built) {
        for (const name of c.names) {
            if (seen.has(name)) twice++;
            seen.set(name, c);
        }
        const [lo, hi] = c.kind === 'levelling' ? [3, 6] : [2, 4];
        if (c.names.length < lo || c.names.length > hi) badSize++;
        const kinds = new Set(c.names.map(n => (lib.isLevelling(lib.plannerOf(n)) ? 'levelling' : lib.plannerOf(n))));
        if (kinds.size !== 1 || ![...kinds][0] || [...kinds][0] !== c.kind) mixed++;
    }
    check('cliques: levelling 3-6, PK 2-4; a name in at most one; one kind each', twice === 0 && badSize === 0 && mixed === 0, `${twice} names twice, ${badSize} out of size, ${mixed} mixed`);
    const levelling = roster.filter(n => lib.isLevelling(lib.plannerOf(n)));
    const inLevelling = built.filter(c => c.kind === 'levelling').reduce((n, c) => n + c.names.length, 0);
    const share = pct(inLevelling, levelling.length);
    check('cliques: about a quarter of the levelling names in one (20-30 %)', share >= 20 && share <= 30, `${share.toFixed(1)} % of ${levelling.length}`);
    const pkCliques = built.filter(c => c.kind !== 'levelling');
    check('cliques: deep and Edgeville PKers have cliques of their own', pkCliques.some(c => c.kind === 'extras_pker') && pkCliques.some(c => c.kind === 'extras_edgeville_pker'), `${pkCliques.length} PK cliques`);
    // like their first: the same home region with an age tier at most 2 off, or another region with the same tier
    const TIER = { newcomer: 0, novice: 1, intermediate: 2, experienced: 3, veteran: 4 };
    let unlike = 0;
    let sameRegion = 0;
    let pairs = 0;
    for (const c of built.filter(c => c.kind === 'levelling')) {
        // (its first: the lowest seed; the list is in the roster's order, so compare every pair with the best match)
        const traits = c.names.map(n => ({ region: lib.personaOf(n).region, tier: TIER[lib.ageTierFor(n, lib.plannerOf(n))] }));
        const fits = a => traits.every(b => (a.region === b.region ? Math.abs(a.tier - b.tier) <= 2 : a.tier === b.tier));
        if (!traits.some(fits)) unlike++;
        for (let i = 0; i < traits.length; i++) for (let j = i + 1; j < traits.length; j++) {
            pairs++;
            if (traits[i].region === traits[j].region) sameRegion++;
        }
    }
    check('cliques: every member like its clique\'s first (its home region within 2 age tiers, or its age tier)', unlike === 0, `${unlike} cliques with no member all are like; ${pct(sameRegion, pairs).toFixed(0)} % of member pairs from one region`);
    const sample = built[3];
    check('cliques: cliqueOf gives each member the same clique, itself in it', sample.names.every(n => JSON.stringify(Cliques.cliqueOf(n)) === JSON.stringify(sample.names)) && Cliques.cliqueOf('nobody at all') === null);
}

// ---- 2. log in together: cliqueReturnBonus, and a stand-in for the arrivals work's call ----
{
    const c = Cliques.allCliques().find(c => c.kind === 'levelling' && c.names.length >= 4);
    const [a, b, d, e] = c.names;
    const none = Cliques.cliqueReturnBonus(a, () => false);
    const one = Cliques.cliqueReturnBonus(a, n => n === b);
    const three = Cliques.cliqueReturnBonus(a, n => n === b || n === d || n === e);
    const self = Cliques.cliqueReturnBonus(a, n => n === a);
    const loner = lib.BOT_NAMES.find(n => lib.isLevelling(lib.plannerOf(n)) && Cliques.cliqueOf(n) === null);
    check('log in together: no bonus without a clique-mate online (itself does not count), more with more, always under 1', none === 0 && self === 0 && one > 0 && three > one && three < 1 && Cliques.cliqueReturnBonus(loner, () => true) === 0, `0 / ${one} / ${three}`);
    // a stand-in of _pickReturner: the group most short of its place first, then the bonus, then the longest away
    const pickReturner = (due, online, want) => {
        let best = null;
        let top = -Infinity;
        for (const m of due) {
            const score = want[m.group] - (m.onlineInGroup ?? 0) + Cliques.cliqueReturnBonus(m.name, n => online.has(n));
            if (score > top) [top, best] = [score, m];
        }
        return best;
    };
    const other = lib.BOT_NAMES.find(n => lib.isLevelling(lib.plannerOf(n)) && !c.names.includes(n) && Cliques.cliqueOf(n) === null);
    const online = new Set([a]);
    const same = pickReturner([{ name: other, group: 'skiller' }, { name: b, group: 'skiller' }], online, { skiller: 1 });
    const short = pickReturner([{ name: other, group: 'fighter' }, { name: b, group: 'skiller' }], online, { skiller: 1, fighter: 2 });
    check('log in together: a stand-in of _pickReturner brings back the clique-mate of a bot online first, but a group short of its place still goes first', same?.name === b && short?.name === other, `${same?.name}, ${short?.name}`);
}

// ---- 3. caps ----
{
    lib.forgetCrowdsForTest();
    const hub = key => lib.HUBS.find(h => h.key === key);
    const caps = [25, 100, 250, 500].map(n => Object.fromEntries(lib.HUBS.map(h => [h.key, lib.hubCap(h, n)])));
    check('caps: at least 1 at every hub and size', caps.every(c => Object.values(c).every(v => v >= 1)));
    check('caps: Lumbridge at most 3 per 100 online (at least 1)', [25, 100, 250, 500].every(n => lib.hubCap(hub('lumbridge'), n) <= Math.max(1, Math.floor((3 * n) / 100))), caps.map(c => c.lumbridge).join('/'));
    check('caps: a quarter of 2004\'s crowd there per 100 online (Varrock West 1 at 100, 6 at 500)', caps[1].varrock_west === 1 && caps[3].varrock_west === 6 && caps[3].lumbridge === 5, JSON.stringify(caps[3]));
    check('caps: the hubs include Varrock square and Falador park', !!hub('varrock_square') && !!hub('falador_park'));
}

// ---- 4. the world ----
const saves = new Map();
const sim = await lib.Sim.create({ bots: N, members: true, debug: false, ageNewBots: true, saves, ackLogouts: true, extra: { savedNames: () => [...saves.keys()] } });
sim.addHuman(3183, 3428, 0);
// the human stands about for minutes: no random event (one took it across the map in the middle of a lure: 274's
// failed-event teleport), as in chat.test and trade.test
{
    const clientsIn = World.processClientsIn;
    World.processClientsIn = function () {
        clientsIn.call(this);
        sim.human.afkEventReady = false;
    };
}
const lines = [];
lib.sayListeners.push((p, text, kind, to) => lines.push({ t: World.currentTick, name: p.username, planner: p.botPlanner, text, kind, to: to?.username ?? null }));
const taskOf = p => sim.botPlayer(p)?.currentTask ?? null;
const socialView = p => {
    const task = taskOf(p);
    return task instanceof lib.SocialTask ? task.view() : null;
};
const coinsOf = p => {
    let n = 0;
    for (const inv of [p.getInventory(lib.InvType.INV), p.getInventory(lib.bankInvId())]) {
        if (!inv) continue;
        for (let i = 0; i < inv.capacity; i++) if (inv.get(i)?.id === 995) n += inv.get(i).count;
    }
    return n;
};
const run = (ticks, each) => {
    for (let i = 0; i < ticks; i++) {
        sim.tick();
        each?.(World.currentTick);
    }
};

// 4a. regulars
{
    scene(SEED, 'regulars'); // (its own dice: test/lib/dice.mjs)
    const coins = new Map();
    const states = new Set();
    let stacked = 0;
    let samples = 0;
    let overCap = 0;
    let traded = 0;
    const atHub = new Map();
    run(1500, tick => {
        for (const p of sim.bots()) {
            if (p.botPlanner !== 'extras_social') continue;
            if (!coins.has(p.username)) coins.set(p.username, coinsOf(p));
            if (p.botTradeTargetPid !== -1) traded++;
            const v = socialView(p);
            if (v) states.add(v.state);
        }
        if (tick < 700 || tick % 50 !== 0) return;
        samples++;
        const tiles = new Map();
        const byHub = lib.SocialTask.regularsByHub();
        for (const [key, n] of Object.entries(byHub)) if (n > lib.hubCap(lib.HUBS.find(h => h.key === key), N)) overCap++;
        for (const p of sim.bots()) {
            const v = socialView(p);
            if (!v || v.state !== 'stand' || !v.tile || p.x !== v.tile[0] || p.z !== v.tile[1]) continue;
            atHub.set(p.username, v.hub);
            const k = `${p.x},${p.z}`;
            if (tiles.has(k)) stacked++;
            tiles.set(k, p.username);
        }
    });
    const socials = sim.bots().filter(p => p.botPlanner === 'extras_social');
    const gained = socials.filter(p => coinsOf(p) - (coins.get(p.username) ?? 0) >= 10000);
    const src = fs.readFileSync(path.join(BOTS_SRC, 'tasks/SocialTask.ts'), 'utf8');
    check('regulars: no tour and no tips (no tour states or destinations, no coins put up, none gained, no trade)', ![...states].some(s => ['lead', 'arrived', 'reward', 'scan', 'move_area'].includes(s)) && !/SOCIAL_STARTING_COINS|REWARD_PHRASES|DESTINATIONS|TradeSession/.test(src) && gained.length === 0 && traded === 0, `states ${[...states].join(' ')}; ${gained.length} gained 10k+; ${traded} ticks in a trade`);
    check('regulars: every social bot online stands at a hub of its own by now', socials.length > 0 && socials.every(p => atHub.has(p.username)), `${atHub.size} of ${socials.length}: ${[...atHub.values()].join(', ')}`);
    check('regulars: no hub over its cap; no two on one tile', samples > 0 && overCap === 0 && stacked === 0, `${overCap} hub-samples over, ${stacked} stacked, ${samples} samples; ${JSON.stringify(lib.SocialTask.regularsByHub())}`);
    const greets = lines.filter(l => l.planner === 'extras_social' && l.kind === 'social' && l.to);
    out(`note: ${greets.length} lines of regulars to a passer-by or the human, e.g. ${greets.slice(0, 4).map(l => JSON.stringify(l.text)).join(', ')}`);
}

// 4b. a lure, forced, end to end
{
    scene(SEED, 'a lure'); // (its own dice: test/lib/dice.mjs)
    lib.setSocialRatesForTest({ lure: 1, approachGap: [1, 2] });
    lib.SocialTask.forgetForTest();
    const human = sim.human;
    // a regular standing at its hub (the nearest to the human first)
    const regulars = sim.bots().filter(p => socialView(p)?.state === 'stand').sort((a, b) => cheb(a, human) - cheb(b, human));
    const bot = regulars[0];
    let pitched = null;
    let betrayed = false;
    let attackedInWild = false;
    let attackedOutside = false;
    let reachedWild = false;
    let states = new Set();
    if (bot) {
        for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2]]) {
            if (sim.isWalkable(bot.x + dx, bot.z + dz, 0)) {
                sim.teleportHuman(bot.x + dx, bot.z + dz, 0);
                break;
            }
        }
        sim.copyLevels(bot);
        const from = lines.length;
        for (let i = 0; i < 2500; i++) {
            sim.tick();
            const v = socialView(bot);
            if (!v || bot.slot === -1) break;
            states.add(v.state);
            // the human follows a lure: a step behind the bot (the way a player follows)
            if ((v.state === 'lure' || v.state === 'wilderness_trap') && cheb(bot, human) > 2) {
                for (const [dx, dz] of [[0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, 1]]) {
                    if (sim.isWalkable(bot.x + dx, bot.z + dz, 0)) {
                        sim.teleportHuman(bot.x + dx, bot.z + dz, 0);
                        break;
                    }
                }
            }
            if (lib.wildLevel(bot.x, bot.z) > 0) reachedWild = true;
            if (sim.attackTarget(bot) === human) {
                if (lib.wildLevel(bot.x, bot.z) > 0 && lib.wildLevel(human.x, human.z) > 0) attackedInWild = true;
                else attackedOutside = true;
            }
            if (attackedInWild && i > 0 && v.state !== 'wilderness_trap') break;
            if (attackedInWild && human.levels[3] < human.baseLevels[3]) break;
        }
        const said = lines.slice(from).filter(l => l.name === bot.username);
        const pitches = Object.values(lib.SOCIAL_LINES.lureForms).flatMap(f => f.pitch);
        pitched = said.find(l => pitches.includes(l.text))?.text ?? null;
        betrayed = said.some(l => lib.SOCIAL_LINES.betray.includes(l.text));
    }
    check('lure: a regular approaches the human, pitches a lure (a 2004 form or upstream\'s) and leads it to Edgeville', !!bot && pitched !== null && states.has('lure'), `${bot?.username}: ${JSON.stringify(pitched)}; states ${[...states].join(' ')}`);
    check('lure: the human follows, the bot crosses into the Wilderness, betrays and attacks the human there', reachedWild && betrayed && attackedInWild, `wild ${reachedWild}, betrayed ${betrayed}, attacked ${attackedInWild}`);
    check('lure: never an attack on the human outside the Wilderness', !attackedOutside);

    // another approach within 30 minutes: no lure (at most one lure a human in 30 minutes)
    lib.SocialTask.forgetForTest(true);
    const second = sim.bots().filter(p => p !== bot && socialView(p)?.state === 'stand').sort((a, b) => cheb(a, human) - cheb(b, human))[0];
    const seen = new Set();
    if (second) {
        for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2]]) {
            if (sim.isWalkable(second.x + dx, second.z + dz, 0)) {
                sim.teleportHuman(second.x + dx, second.z + dz, 0);
                break;
            }
        }
        run(300, () => {
            const v = socialView(second);
            if (v) seen.add(v.state);
        });
    }
    check('lure: another regular\'s approach within 30 minutes is no lure', !!second && seen.has('chat') && !seen.has('lure'), `${second?.username}: ${[...seen].join(' ')}`);
    lib.setSocialRatesForTest({ lure: 0.2, approachGap: [1500, 3000] });
    sim.teleportHuman(3183, 3428, 0);
}

// 4c. train together, travel together (a pair at a time, up to three pairs: a monster on the way can hold one)
{
    scene(SEED, 'train together'); // (its own dice: test/lib/dice.mjs)
    const free = sim.bots().filter(p => lib.isLevelling(p.botPlanner) && sim.botPlayer(p) && !sim.botPlayer(p).hasSubTask() && !p.botNewbie && p.target === null && cheb(p, sim.human) > 40);
    let followed = false;
    let followTicks = 0;
    let near = 0;
    let arrived = false;
    let opFollow = false;
    let trainStep = null;
    let otherSkill = 'x';
    let leader = null;
    let follower = null;
    let tries = 0;
    let endReason = null;
    const ends = [];
    // the start: Varrock square (the human far off, at Lumbridge); their trees: the oaks by Varrock West, 46 tiles off
    sim.teleportHuman(3222, 3218, 0);
    const start = [3212, 3424];
    const step = lib.SkillProgression.WOODCUTTING.find(s => s.minLevel === 15);
    for (let pair = 0; pair < 3 && !(followed && arrived) && free.length >= 2 * pair + 2; pair++) {
        const [a, b] = free.slice(2 * pair, 2 * pair + 2);
        tries++;
        [followed, followTicks, near, arrived, opFollow, leader, follower] = [false, 0, 0, false, false, null, null];
        Cliques.setCliquesForTest([[a.username, b.username]]);
        // (the variety work, round 2, the integrator's: what each was doing let go first and its scripts' moment waited out
        // before the pack is cleared: a bury clicked a tick before read its emptied slot, 274's bury_bone.rs2 "oc_param ...
        // -1", at seed 5 once round 2 moved the dice; trade.test's force() does the same)
        for (const p of [a, b]) sim.botPlayer(p)?.windDown();
        run(2);
        for (const p of [a, b]) {
            p.setLevel(lib.PlayerStat.WOODCUTTING, 15);
            // (a clean pack and full run energy: the world's dice handed the test a bot with a full pack of raw chicken,
            // no room for the axe, so it went to the bank first, and its friend with no run energy lost it there)
            p.getInventory(lib.InvType.INV)?.removeAll();
            lib.giveItems(p, [[1351, 1]], false); // a bronze axe
            p.runenergy = 10000;
        }
        run(11); // (the cliques' pass, every 5 ticks, sees them online)
        // (at the start a tick before a cliques' pass (every 5 ticks, before the bots' own ticks), their tasks given then:
        // both set off under the pass, side by side. Given between passes, one set off on its own trip first (a bank stop
        // the other way) and followed 9 tiles behind at the same speed, never within 8)
        while ((World.currentTick + 1) % 5 !== 0) run(1);
        a.teleJump(start[0], start[1], 0);
        b.teleJump(start[0] + 1, start[1] + 1, 0);
        run(1);
        const task = new lib.WoodcuttingTask(step);
        task.reset();
        sim.botPlayer(a).currentTask = task;
        // b asks its clique: a's step (the crowds work's planner will)
        trainStep = Cliques.cliqueStepFor(b, 'WOODCUTTING', 15);
        otherSkill = Cliques.cliqueStepFor(b, 'MINING', 15);
        const taskB = new lib.WoodcuttingTask(trainStep ?? step);
        taskB.reset();
        sim.botPlayer(b).currentTask = taskB;
        // (their plans last the test: the rescan would hand them others)
        for (const p of [a, b]) sim.botPlayer(p).planEnds = World.currentTick + 6000;
        for (let i = 0; i < 500; i++) {
            sim.tick();
            for (const [x, y] of [[a, b], [b, a]]) {
                if (Cliques.followsFriend(x) === y) {
                    [follower, leader] = [x, y];
                    followed = true;
                    followTicks++;
                    if (cheb(x, y) <= 8) near++;
                    if (x.target === y && (x.targetOp === lib.ServerTriggerType.APPLAYER3 || x.targetOp === lib.ServerTriggerType.OPPLAYER3)) opFollow = true;
                }
            }
            if (followed && follower && !Cliques.followsFriend(follower)) {
                endReason = Cliques.lastCliqueFollow(follower)?.endReason ?? null;
                arrived = endReason === 'arrived' && cheb(leader, { x: step.location[0], z: step.location[1] }) <= 20;
                break;
            }
        }
        ends.push(`${a.username}/${b.username}: ${followed ? `${followTicks} ticks, ${endReason}` : 'no follow'}`);
        Cliques.setCliquesForTest(null);
    }
    sim.teleportHuman(3183, 3428, 0);
    check('train together: cliqueStepFor gives a clique-mate\'s step of the same skill (the skill\'s own object), none of another', trainStep !== null && lib.SkillProgression.WOODCUTTING.includes(trainStep) && otherSkill === null, `${trainStep?.action} at ${trainStep?.location}`);
    check('travel together: one follows the other with the game\'s Follow (op 3), near it (within 8 tiles 70 % of the way), until it arrives at their spot', followed && opFollow && near >= followTicks * 0.7 && arrived, `${follower?.username} after ${leader?.username}: ${followTicks} ticks, ${near} within 8 tiles; arrived ${arrived}; pair ${tries} of 3 (${ends.join('; ')})`);
}

// 4d. greetings by first name, goodbyes naming a friend
{
    scene(SEED, 'greetings'); // (its own dice: test/lib/dice.mjs)
    const named = sim.bots().filter(p => lib.isLevelling(p.botPlanner) && Cliques.nickOf(p) && sim.botPlayer(p) && !sim.botPlayer(p).hasSubTask() && !p.botNewbie);
    const pairs = [];
    for (let i = 0; i + 1 < named.length && pairs.length < 5; i += 2) pairs.push([named[i], named[i + 1]]);
    Cliques.setCliquesForTest(pairs.map(([x, y]) => [x.username, y.username]));
    const spots = [[3200, 3230], [3210, 3210], [3240, 3230], [3195, 3260], [3230, 3250]];
    pairs.forEach(([x, y], i) => {
        x.teleJump(spots[i][0], spots[i][1], 0);
        y.teleJump(spots[i][0] + 2, spots[i][1], 0);
    });
    const from = lines.length;
    run(60);
    const greetings = lines.slice(from).filter(l => pairs.some(([x, y]) => (l.name === x.username && l.to === y.username && l.text.toLowerCase().includes(Cliques.nickOf(y))) || (l.name === y.username && l.to === x.username && l.text.toLowerCase().includes(Cliques.nickOf(x)))));
    check('greet: two of a clique that meet: one says the other\'s first name', greetings.length > 0, greetings.slice(0, 3).map(l => `${l.name}: ${l.text}`).join(' | ') || `none of ${pairs.length} pairs`);
    // a goodbye naming a friend near (cliqueDeparture: the habits' sayOccasion('departure') asks it); a pair both online and
    // not away (a friend on an away break is no one to say goodbye to: the world's dice sent the first pair's on one)
    const [x, y] = pairs.find(([p, q]) => p.slot !== -1 && q.slot !== -1 && !lib.isAway(p) && !lib.isAway(q)) ?? pairs[0];
    x.teleJump(3200, 3230, 0);
    y.teleJump(3202, 3230, 0);
    run(2);
    let bye = null;
    for (let i = 0; i < 12 && !bye; i++) bye = Cliques.cliqueDeparture(x);
    const departure = /\b(gtg|g2g|gotta go|cya|bye|gn|good ?night)\b/i;
    check('goodbye: a goodbye names a friend near, and is a departure line', bye !== null && bye.includes(Cliques.nickOf(y)) && departure.test(bye), JSON.stringify(bye));
    Cliques.setCliquesForTest(null);
}

// 4e. PK cliques
{
    scene(SEED, 'PK cliques'); // (its own dice: test/lib/dice.mjs)
    const deep = sim.bots().filter(p => p.botPlanner === 'extras_pker' && taskOf(p) instanceof lib.PKerTask);
    let together = 0;
    let both = 0;
    let sameZone = 0;
    if (deep.length >= 2) {
        const [a, b] = deep;
        Cliques.setCliquesForTest([[a.username, b.username]]);
        // (both at the leader's zone, 12 tiles apart: they patrol from there; both with full run energy: the world's dice
        // handed the test a follower at 5 % that walked behind a running leader, 10-50 tiles back)
        const [zx, zz] = taskOf(a).cliqueView().centre;
        a.teleJump(zx, zz, 0);
        b.teleJump(zx + 12, zz, 0);
        for (const p of [a, b]) p.runenergy = 10000;
        const start = World.currentTick;
        // (a watch of 30 minutes: the share is of the samples on patrol, and 15 minutes' 110 or so gave 58-86 % at seeds 5-8
        // once round 1's second fixer gave each scenario its own dice; 30 minutes' 260 or so, 66-82 %)
        run(1800, tick => {
            if (tick % 5 !== 0 || tick - start < 100) return;
            const va = taskOf(a)?.cliqueView?.();
            const vb = taskOf(b)?.cliqueView?.();
            if (!va || !vb || va.state !== 'patrol' || vb.state !== 'patrol' || a.slot === -1 || b.slot === -1) return;
            both++;
            if (cheb(a, b) <= 8) together++;
            if (va.zone === vb.zone) sameZone++;
        });
        Cliques.setCliquesForTest(null);
    }
    check('PK: two deep PKers of a clique patrol together (one zone, within 8 tiles most of the time on patrol)', both > 50 && pct(together, both) >= 60 && pct(sameZone, both) >= 80, `${deep.length} deep PKers online; ${together} of ${both} samples within 8 tiles, ${sameZone} in one zone`);

    const edge = sim.bots().filter(p => p.botPlanner === 'extras_edgeville_pker' && taskOf(p) instanceof lib.EdgevillePKerTask);
    let close = 0;
    let atEdge = 0;
    let fought = false;
    // (two not fighting each other now: once friends, they never start; two in no fight at all if there are such: a
    // fight going on when the test makes them friends keeps them apart until it is over)
    const pairs = edge.flatMap((a, i) => edge.slice(i + 1).map(b => [a, b])).filter(([a, b]) => sim.attackTarget(a) !== b && sim.attackTarget(b) !== a);
    const pair = pairs.find(([a, b]) => sim.attackTarget(a) === null && sim.attackTarget(b) === null) ?? pairs[0];
    if (pair) {
        const [a, b] = pair;
        Cliques.setCliquesForTest([[a.username, b.username]]);
        const start = World.currentTick;
        run(900, tick => {
            if (sim.attackTarget(a) === b || sim.attackTarget(b) === a) fought = true;
            // (a minute to find each other first, as the deep PKers' check)
            if (tick % 5 !== 0 || tick - start < 100) return;
            const edgeOf = p => p.z >= 3522 && p.z <= 3562 && Math.abs(p.x - 3093) <= 18;
            if (!edgeOf(a) || !edgeOf(b)) return;
            atEdge++;
            if (cheb(a, b) <= 8) close++;
        });
        Cliques.setCliquesForTest(null);
    }
    check('PK: two Edgeville PKers of a clique stand together at the edge, and never fight each other', atEdge > 30 && pct(close, atEdge) >= 50 && !fought, `${edge.length} Edgeville PKers online; ${close} of ${atEdge} samples within 8 tiles; fought ${fought}`);
}

check('errors: none', logErrors.length === 0 && lib.BotManager.stats().errors === 0, logErrors.slice(0, 3).join(' | '));

let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(failed ? `${failed} of ${checks.length} failed` : `all ${checks.length} passed`);
process.exit(failed ? 1 : 0);
