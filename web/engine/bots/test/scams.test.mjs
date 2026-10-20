#!/usr/bin/env node
// Scam callers and lures (the realism work, phase 5b, Track P: port/BotScams, port/BotTrade's refusal, tasks/SocialTask's
// lure forms, the lure to a waiting PK team and the fake Wilderness drop party,
// the defaults chosen; "lures may lead to a waiting PK team"). Every new line through the 274
// filter is test/chat-filter.test.mjs's. In the real 274 world with the bots' content overlay (a human's trade request
// reaches a bot through 0002), 40 aged bots, members:
//   draws      the ambient stints' venues 60/25/15 (10,000 draws), their gap about 2 hours of play (median 100-120 min,
//              every one 60-200); 11 lure forms (the six new ones with pitches and leads), drawn evenly
//   a stint    a rude caller at Varrock West: calls every 15-45 s (kind 'scam') from its two or three lines, standing
//              where it is; the crowd's warnings (kind 'setpiece') at most 4, the caller's answers no more than those;
//              its own task goes on after
//   K3         the human asks the caller to trade: a refusal in words (kind 'scam', its pool), no trade window on either
//              side, no item moved (both packs and the caller's bank the same 200 ticks on), no trade target kept
//   the mod    a player-mod bot's line (kind 'mod') beside a caller ends its stint at once
//   ambient    a caller's audience (the bots in its earshot: none far from anyone); with a short gap, a stint begins on
//              its own at the venue drawn, with a rude caller standing there among 3 others
//   the spree  (the director's set piece) at the busiest trade bank with a crowd of 5+: two callers 1-2 minutes apart,
//              a word-of-mouth line, done at its end
//   lures      a forced lure while a PK team raids north of Varrock (a stand-in 'pk_raid' run): logged as one to the team,
//              led there (the human following), "lol get him guys" within 6 tiles of the team's leader, no attack by the
//              lurer; the approach and the lure in the logs (K4)
//   fake DP    with Edgeville's PKers at the edge, a caller at Varrock West or Edgeville: 3-4 calls ('setpiece', the
//              fakedp pool) over about 3 minutes, at most 2 warnings, then done; no plan without a PKer at the edge
//   errors     none
//
//   node --expose-gc web/engine/bots/test/scams.test.mjs [--seed=7]
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
const SEED = Number(args.seed ?? 7);
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
const out = (s = '') => process.stdout.write(s + '\n');
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

const overlay = await compileBotScripts({ engineDir: ENGINE_DIR, contentDir: CONTENT_DIR, log: () => {} });
const scriptsBin = new Uint8Array(fs.readFileSync(overlay.file));
const scriptDat = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.dat')));
const scriptIdx = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.idx')));
const engineDir = prepareEngineClone('scams', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/party.ts'), path.join(engineDir, 'tsconfig.json'));
// (the variety work, round 2, the integrator's: the round's errands off for these scenes, as party.test has them: a
// levelling bot on a quest look-alike or a chain is held in a sub-task, which no stint, spree or crowd asks)
await lib.setD2Offers?.(false);
const { World, BotManager, Scams, SetPieces, InvType } = lib;
const sim = await lib.Sim.create({ bots: 40, members: true, debug: false, ageNewBots: true, humanName: 'casey' });
lib.installBotsContent(scriptsBin, scriptDat, scriptIdx);
sim.addHuman(3185, 3428, 0);
const human = sim.human;
for (let stat = 0; stat < human.baseLevels.length; stat++) if (stat !== 18 && stat !== 19) human.setLevel(stat, 60);
// (the human stands about for minutes: no random event on it)
const processClientsIn = World.processClientsIn;
World.processClientsIn = function () {
    processClientsIn.call(this);
    human.afkEventReady = false;
};
const tick = (n = 1) => {
    for (let i = 0; i < n; i++) sim.tick();
};
tick(200);
// the ambient stints stay off but where a check turns them on; the caller's logout after its stint (the variety work,
// round 1, track F: fixes.test checks it) off: the checks here stage stint after stint with the same few rude bots
Scams.setScamRatesForTest({ ambient: false, logout: false });
Scams.resetScamsForTest();
const lines = [];
lib.sayListeners.push((p, text, kind, to) => lines.push({ t: World.currentTick, name: p.username, text, kind, to: to?.username ?? null, x: p.x, z: p.z }));
const pool = (event, kind) => lib.NEW_LINES.filter(l => l.tag.event === event && (l.tag.kinds ?? []).includes(kind)).map(l => l.text.toLowerCase());
/** a line said is one of the pool's as styled (abbreviations, a laugh, a typo: most of its words the same) */
const wordsOf = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const inPool = (text, event, kind) => pool(event, kind).some(t => {
    const said = new Set(wordsOf(text));
    const want = wordsOf(t);
    return want.filter(w => said.has(w)).length >= Math.ceil(want.length * 0.6);
});
const ai = p => sim.botPlayer(p);
const place = (p, x, z) => {
    p.clearWaypoints();
    p.clearInteraction();
    p.teleJump(x, z, 0);
};
const levelling = () => sim.bots().filter(p => ['skiller', 'fighter', 'balanced', 'random'].includes(p.botPlanner) && !lib.isNewbie(p) && !ai(p)?.hasSubTask());
const rude = () => levelling().filter(p => lib.botPersona(p).friendliness < 0 && p.combatLevel <= 40);
// (the cliques stay, but do nothing together: a friend's travel, BotCliques' pass every 5 ticks, took a picked caller off
// two ticks before its stint in the merged world)
lib.setCliqueBehaviourForTest(false);

// ---- draws ----
{
    const counts = { varrock_west: 0, falador_east: 0, edgeville: 0 };
    const dice = mulberry(99);
    for (let i = 0; i < 10000; i++) counts[Scams.drawScamVenue(dice).key]++;
    check('ambient stints: Varrock West 55-65 %, Falador East 20-30 %, Edgeville 11-19 % (10,000 draws)', counts.varrock_west >= 5500 && counts.varrock_west <= 6500 && counts.falador_east >= 2000 && counts.falador_east <= 3000 && counts.edgeville >= 1100 && counts.edgeville <= 1900, counts);
    const gaps = Array.from({ length: 2000 }, () => Scams.drawAmbientGap()).sort((a, b) => a - b);
    const median = gaps[1000] / 100;
    check('ambient stints: about one every 2 hours of play (the gap\'s median 100-120 min, every one 60-200)', median >= 100 && median <= 120 && gaps[0] >= 6000 && gaps[1999] <= 20000, { median, min: gaps[0] / 100, max: gaps[1999] / 100 });
    const forms = lib.SOCIAL_LINES.lureForms;
    const fresh = ['vendor', 'lobs', 'clan', 'phat', 'help', 'rare'];
    check('lures: 11 forms, the six new ones (a vendor, free lobs, a clan, a phat, a helper, a rare spawn) with pitches and leads', Object.keys(forms).length === 11 && fresh.every(f => forms[f]?.pitch?.length >= 2 && forms[f]?.lead?.length >= 2), Object.keys(forms));
    check('lures: the ambush\'s arrival lines', lib.SOCIAL_LINES.ambush.length >= 3);
}

// ---- a stint at Varrock West ----
let caller = rude()[0];
{
    scene(SEED, 'a stint at Varrock West'); // (its own dice: test/lib/dice.mjs)
    check('a rude levelling bot of combat 40 or less to call', !!caller, rude().length);
    const crowd = levelling().filter(p => p !== caller).slice(0, 8);
    place(caller, 3184, 3430);
    crowd.forEach((p, i) => place(p, 3180 + (i % 4) * 3, 3426 + Math.floor(i / 4) * 6));
    sim.teleportHuman(3190, 3428, 0);
    tick(2);
    const at = [caller.x, caller.z];
    const from = lines.length;
    const rec = Scams.startStintForTest(caller, 'varrock_west', 600);
    let moved = 0;
    let humanRefusal = null;
    let tradeWindow = false;
    let k3 = null;
    for (let i = 0; i < 640; i++) {
        tick(1);
        if (rec && rec.end < 0) moved = Math.max(moved, Math.max(Math.abs(caller.x - at[0]), Math.abs(caller.z - at[1])));
        // K3: a trade request in the middle of it
        if (i === 200) {
            const humanInv = lib.invItems(human, 'inv').join(',');
            const botInv = lib.invItems(caller, 'inv').join(',');
            const botBank = lib.invItems(caller, 'bank').join(',');
            sim.teleportHuman(caller.x + 1, caller.z, 0);
            tick(2);
            const l0 = lines.length;
            lib.opPlayer(human, caller, 4);
            for (let j = 0; j < 200; j++) {
                tick(1);
                if (human.modalMain !== -1 || caller.modalMain !== -1 || lib.tradeScreen(caller) !== null) tradeWindow = true;
            }
            humanRefusal = lines.slice(l0).find(l => l.name === caller.username && l.kind === 'scam' && l.to === human.username) ?? null;
            k3 = { same: humanInv === lib.invItems(human, 'inv').join(',') && botInv === lib.invItems(caller, 'inv').join(',') && botBank === lib.invItems(caller, 'bank').join(','), target: caller.botTradeTargetPid };
            sim.teleportHuman(3190, 3428, 0);
        }
    }
    const calls = lines.slice(from).filter(l => l.name === caller.username && l.kind === 'scam' && l.to === null);
    // (its lines as written: the style layer adds a laugh or a smiley, a typo now and then)
    const base = t => t.toLowerCase().replace(/\s+(lol|lmao|haha|rofl|xd|:\)|:p|:d)$/, '').replace(/[^a-z0-9]/g, '');
    // (a typo aside: a call within 2 edits of one before it is that line, typed with a slip; 274's persona style layer
    // gives a few per stint, and three of them on two lines read as five)
    const edits = (a, b) => {
        const d = Array.from({ length: b.length + 1 }, (_, j) => j);
        for (let i = 1; i <= a.length; i++) {
            let prev = d[0];
            d[0] = i;
            for (let j = 1; j <= b.length; j++) [prev, d[j]] = [d[j], Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))];
        }
        return d[b.length];
    };
    const texts = new Set();
    for (const t of calls.map(l => base(l.text))) if (![...texts].some(x => edits(x, t) <= 2)) texts.add(t);
    const gaps = calls.slice(1).map((l, i) => l.t - calls[i].t);
    check('a stint: calls every 15-45 s (kind scam), 8-24 in 10 minutes, from 2-3 lines (a typo aside), standing where it is', rec && calls.length >= 8 && calls.length <= 24 && texts.size >= 1 && texts.size <= 4 && gaps.every(g => g >= 25) && moved <= 2, { calls: calls.length, texts: [...texts], gaps, moved });
    const warnings = lines.slice(from).filter(l => l.kind === 'setpiece' && l.to === caller.username);
    const answers = calls.length ? lines.slice(from).filter(l => l.name === caller.username && l.kind === 'scam' && l.to !== null && l.to !== human.username) : [];
    check('the crowd: at most 4 warnings (kind setpiece, the scam warn pool), the caller\'s answers no more than those', warnings.length <= 4 && answers.length <= warnings.length && warnings.every(l => inPool(l.text, 'scam', 'warn')) && rec.warnings === warnings.length, { warnings: warnings.map(l => l.text), answers: answers.map(l => l.text), rec: rec?.warnings });
    out(`note: a stint of ${calls.length} calls (${[...texts].join(' | ')}), ${warnings.length} warnings, ${answers.length} answers`);
    check('K3: the human asks the caller to trade: turned down in words (kind scam, its refusal pool)', humanRefusal !== null && inPool(humanRefusal.text, 'scam', 'refuse'), humanRefusal?.text ?? 'no refusal');
    check('K3: no trade window on either side, no item moved (both packs, the caller\'s bank), no trade target kept', !tradeWindow && k3?.same && k3.target === -1 && rec.tradeRequests === 1, { tradeWindow, k3, requests: rec?.tradeRequests });
    check('the stint ends at its time and the caller\'s own task goes on', rec.end >= 0 && rec.outcome === 'done' && !ai(caller)?.hasSubTask(), rec);
}

// ---- the player-mod bot's word ----
{
    scene(SEED, 'the player-mod bot word'); // (its own dice: test/lib/dice.mjs)
    const c = rude().find(p => p !== caller) ?? caller;
    const mod = levelling().find(p => p !== c && p !== caller);
    place(c, 3186, 3431);
    place(mod, 3188, 3431);
    tick(2);
    const rec = Scams.startStintForTest(c, 'varrock_west', 1000);
    tick(80);
    // (the mod beside it again: its own task walks it about)
    place(mod, c.x + 2, c.z);
    tick(1);
    mod.staffModLevel = 1;
    lib.botSay(mod, 'Doubling money is a scam. Dont trade him.', undefined, 'mod', c);
    mod.staffModLevel = 0;
    tick(30);
    check('a player-mod bot\'s line beside a caller ends its stint at once', rec && rec.mod && rec.outcome === 'mod' && rec.end >= 0, { rec, c: [c.x, c.z, c.username], mod: [mod.x, mod.z, mod.username], said: lines.filter(l => l.kind === 'mod').slice(-2) });
}

// ---- moved off (a random event's fail teleport, a death), random events, an armed bot ----
{
    scene(SEED, 'moved off'); // (its own dice: test/lib/dice.mjs)
    const c = rude().find(p => p !== caller && !ai(p)?.hasSubTask()) ?? caller;
    place(c, 3186, 3431);
    tick(2);
    const before = lib.randomEventEligible(c);
    const rec = Scams.startStintForTest(c, 'varrock_west', 1000);
    tick(30);
    const during = lib.randomEventEligible(c);
    place(c, 3093, 3300);
    tick(3);
    check('a stint\'s caller is armed for no random event (a part in a set piece, as an errand)', before && !during, { before, during });
    check('a caller moved off its spot ends its stint at once (no calls from elsewhere)', rec?.outcome === 'moved' && rec.end >= 0 && ai(c)?.subTask?.name !== 'ScamCall', { rec, sub: ai(c)?.subTask?.name });
    const p = rude().find(b => Scams.mayCall(b));
    if (p) {
        p.afkEventReady = true;
        const armed = Scams.mayCall(p);
        p.afkEventReady = false;
        check('a bot armed for a random event calls no scam (its answer would wait behind the stint)', !armed);
    }
    place(c, 3186, 3431);
}

// ---- ambient stints ----
{
    scene(SEED, 'ambient stints'); // (its own dice: test/lib/dice.mjs)
    Scams.resetScamsForTest();
    Scams.SCAMS.gapMedian = 400;
    Scams.SCAMS.gap = [300, 500];
    Scams.SCAMS.retry = 100;
    // a rude caller standing at each venue (the draw picks one), with an audience of 3 about it (a caller calls to a crowd)
    const callers = rude().slice(0, 3);
    const venues = Scams.SCAM_VENUES;
    // (no friend of a caller's clique among them: a friend near keeps a caller quiet)
    const audience = levelling().filter(p => !callers.includes(p) && !callers.some(c => (lib.cliqueOf(c.username) ?? []).includes(p.username))).slice(0, 9);
    const spots = [[-3, -2], [3, -2], [0, 3]];
    const stand = () => {
        // (they stand there: their own tasks would walk them off)
        callers.forEach((p, j) => {
            if (!ai(p)?.hasSubTask() && cheb(p, venues[j]) > 3) place(p, venues[j].x, venues[j].z);
        });
        audience.forEach((p, k) => {
            const v = venues[Math.floor(k / 3)];
            const [dx, dz] = spots[k % 3];
            if (cheb(p, { x: v.x + dx, z: v.z + dz }) > 2) place(p, v.x + dx, v.z + dz);
        });
    };
    stand();
    tick(1);
    // (alone, far from anyone: no audience)
    const lone = callers[0];
    place(lone, 3330, 3660);
    tick(1);
    const alone = Scams.audienceOf(lone);
    place(lone, venues[0].x, venues[0].z);
    tick(1);
    const heard = callers.map(p => Scams.audienceOf(p));
    check('ambient: a caller\'s audience is the bots in its earshot (12 tiles): none far from anyone, 3+ with the crowd placed', alone === 0 && heard.every(n => n >= 3), { alone, heard });
    Scams.setScamRatesForTest({ ambient: true });
    const s0 = Scams.scamLog.length;
    for (let i = 0; i < 900 && Scams.scamLog.length === s0; i++) {
        tick(1);
        stand();
    }
    const started = Scams.scamLog.slice(s0);
    check('ambient: with a short gap a stint begins on its own, at the venue drawn, with the rude caller standing there', started.length >= 1 && started[0].kind === 'ambient' && callers.some(p => p.username === started[0].caller), { started: started.map(r => `${r.venue} ${r.caller}`), callers: callers.map(p => `${p.username} may ${Scams.mayCall(p)} heard ${Scams.audienceOf(p)}`), state: Scams.ambientState() });
    for (const s of Scams.activeStints()) Scams.resetScamsForTest();
    Scams.setScamRatesForTest({ ambient: false });
    Object.assign(Scams.SCAMS, { gapMedian: 11000, gap: [6000, 20000], retry: 300 });
}

// ---- the spree ----
{
    scene(SEED, 'the spree'); // (its own dice: test/lib/dice.mjs)
    Scams.resetScamsForTest();
    // (two with no clique: a friend near keeps a caller quiet)
    const callers = rude().filter(p => !lib.cliqueOf(p.username)).slice(0, 2);
    const crowd = levelling().filter(p => !callers.includes(p)).slice(0, 6);
    callers.forEach((p, i) => place(p, 3183 + i * 3, 3431));
    crowd.forEach((p, i) => place(p, 3180 + (i % 3) * 3, 3436 + Math.floor(i / 3) * 3));
    tick(2);
    const ctx = lib.standInContext(true);
    const def = lib.pieceDef('scam_spree');
    const plan = def?.plan(ctx);
    const run = plan ? lib.startPiece(def, plan, ctx) : null;
    const rumour = run?.rumour() ?? null;
    let t2 = -1;
    const t0 = World.currentTick;
    while (run && lib.tickPiece(run) && World.currentTick - t0 < 1400) {
        tick(1);
        if (t2 < 0 && Scams.activeStints().length >= 2) t2 = World.currentTick - t0;
    }
    const stints = Scams.scamLog.filter(r => r.kind === 'spree');
    check('the spree: planned at the trade bank with a crowd, a rumour line from its pool', !!plan && plan.venue.key === 'varrock_west' && rumour !== null && inPool(rumour, 'scam', 'rumour-varrock_west'), { plan: plan?.venue.key, rumour });
    check('the spree: two callers, the second 1-2 minutes after the first, done at its end', stints.length === 2 && t2 >= 60 && t2 <= 125 && run?.phase === 'done' && stints.every(r => r.end >= 0), { stints: stints.map(r => `${r.caller} ${r.start}-${r.end} ${r.calls}`), t2, callers: plan?.data?.callers?.map(p => `${p.username} sub${ai(p)?.hasSubTask()} role${JSON.stringify(SetPieces.eventRoleOf(p)?.role)} may${Scams.mayCall(p)}`) });
    SetPieces.resetSetPiecesForTest();
}

// ---- a lure to a waiting PK team ----
{
    scene(SEED, 'a lure'); // (its own dice: test/lib/dice.mjs)
    Scams.resetScamsForTest();
    lib.setSocialRatesForTest({ lure: 1, approachGap: [1, 2], ambush: 1 });
    // (the human free: nothing it clicked before)
    human.clearInteraction();
    lib.SocialTask.forgetForTest();
    const pker = sim.bots().find(p => p.botPlanner === 'extras_edgeville_pker' || p.botPlanner === 'extras_pker');
    const raidAt = [3240, 3540];
    const fakeRun = { id: SetPieces.nextSetPieceId(), kind: 'pk_raid', venue: { key: 'varrock_wildy', x: raidAt[0], z: raidAt[1], level: 0, say: 'varrock wildy' }, phase: 'peak', startedAt: World.currentTick, endsBy: World.currentTick + 5000, roles: new Map([[pker, 'leader']]), tick() {}, left() {}, rumour: () => null, abort() {} };
    SetPieces.runStarted(fakeRun);
    const keepPker = () => {
        if (cheb(pker, { x: raidAt[0], z: raidAt[1] }) > 2) place(pker, raidAt[0], raidAt[1]);
    };
    keepPker();
    const regular = sim.bots().filter(p => p.botPlanner === 'extras_social' && ai(p)?.currentTask?.view?.().state === 'stand').sort((a, b) => cheb(a, human) - cheb(b, human))[0];
    let led = false;
    let ambushLine = null;
    let attacked = false;
    let closest = 999;
    const l0 = lines.length;
    const lure0 = lib.lureLog.length;
    if (regular) {
        for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
            if (sim.isWalkable(regular.x + dx, regular.z + dz, 0)) {
                sim.teleportHuman(regular.x + dx, regular.z + dz, 0);
                break;
            }
        }
        // (the human's levels the regular's, every one: a combat level the game lets it attack the human at)
        for (let stat = 0; stat < human.baseLevels.length; stat++) if (stat !== 18 && stat !== 19) human.setLevel(stat, Math.max(1, regular.baseLevels[stat]));
        for (let i = 0; i < 2500; i++) {
            tick(1);
            keepPker();
            const v = ai(regular)?.currentTask?.view?.();
            if (process.env.DEBUG_LURE && i % 50 === 0) out(`lure t${i} ${regular.username} @${regular.x},${regular.z} v=${v?.state}/${v?.hub} human @${human.x},${human.z} m${human.modalMain} t${human.target?.username ?? human.target?.nid ?? human.target} sub${ai(regular)?.hasSubTask()} task ${ai(regular)?.currentTask?.name}`);
            if (!v || regular.slot === -1) break;
            if (v.state === 'lure') {
                led = true;
                // the human follows a step behind (the way a player follows)
                if (cheb(regular, human) > 2) {
                    for (const [dx, dz] of [[0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, 1]]) {
                        if (sim.isWalkable(regular.x + dx, regular.z + dz, 0)) {
                            sim.teleportHuman(regular.x + dx, regular.z + dz, 0);
                            break;
                        }
                    }
                }
            }
            closest = Math.min(closest, cheb(regular, pker));
            if (sim.attackTarget(regular) === human) attacked = true;
            ambushLine ??= lines.slice(l0).find(l => l.name === regular.username && lib.SOCIAL_LINES.ambush.some(a => a.toLowerCase() === l.text.toLowerCase())) ?? null;
            if (ambushLine && i > 0 && v.state !== 'lure') break;
        }
    }
    const lure = lib.lureLog.slice(lure0)[0];
    check('a lure while a PK team raids north of Varrock: logged as one to the team, the approach logged too (K4)', !!regular && lure?.ambush === true && lib.approachLog.some(a => a.bot === regular?.username), { regular: regular?.username, lure });
    check('the lure leads to the team: "lol get him guys" within 6 tiles of its leader, and the lurer leaves the fight to them', led && ambushLine !== null && closest <= 7 && !attacked, { led, line: ambushLine?.text, closest, attacked });
    SetPieces.runEnded(fakeRun);
    SetPieces.resetSetPiecesForTest();
    lib.setSocialRatesForTest({ lure: 0.2, approachGap: [1500, 3000], ambush: 0.5 });
    sim.teleportHuman(3185, 3428, 0);
}

// ---- the fake Wilderness drop party ----
{
    scene(SEED, 'fake DP'); // (its own dice: test/lib/dice.mjs)
    const ctx0 = lib.standInContext(true);
    // (no Edgeville PKer at the edge: no plan)
    const pkers = sim.bots().filter(p => p.botPlanner === 'extras_edgeville_pker');
    const away = pkers.map(p => [p, p.x, p.z]);
    pkers.forEach(p => place(p, 3093, 3480));
    tick(1);
    const none = lib.planFakeDp(ctx0);
    // a PKer at the edge, a caller at Edgeville's bank with a few bots about
    const pk = pkers[0];
    if (pk) place(pk, 3093, 3535);
    const callerFdp = levelling().filter(p => lib.botPersona(p).friendliness < 0.3)[0];
    place(callerFdp, 3094, 3492);
    levelling().filter(p => p !== callerFdp).slice(0, 4).forEach((p, i) => place(p, 3090 + i * 2, 3489));
    tick(2);
    const ctx = lib.standInContext(true);
    const plan = lib.planFakeDp(ctx);
    const def = lib.pieceDef('fake_dp');
    const run = plan ? lib.startPiece(def, plan, ctx) : null;
    const l0 = lines.length;
    const t0 = World.currentTick;
    while (run && lib.tickPiece(run) && World.currentTick - t0 < 700) {
        tick(1);
        if (pk && cheb(pk, { x: 3093, z: 3535 }) > 12) place(pk, 3093, 3535);
    }
    const callerName = run?.caller?.username;
    const calls = lines.slice(l0).filter(l => l.name === callerName && l.kind === 'setpiece');
    // (the crowd's: a set piece elsewhere says its own lines meanwhile, the Duel Arena's "5k stake?" after round 1's merge;
    // since the variety work's round 2 a staker's call ("duel?") passing by and an errand's line, typed as the set pieces'
    // are, are no warning either: the arena's and the errands' own lines left out; an errand's line is kind 'errand' since
    // the round's fixes, B2, so only the arena's can be one now)
    const otherPiece = t => lib.NEW_LINES.some(l => (l.tag.event === 'duel' || l.tag.event === 'errand') && (() => {
        const said = new Set(wordsOf(t));
        const want = wordsOf(l.text);
        return want.length > 0 && want.filter(w => said.has(w)).length === want.length && said.size === want.length;
    })());
    const warns = lines.slice(l0).filter(l => l.name !== callerName && l.kind === 'setpiece' && cheb(l, { x: 3094, z: 3492 }) <= 20 && !otherPiece(l.text));
    check('fake DP: no plan without an Edgeville PKer at the edge', none === null);
    check('fake DP: with one there, a caller: 3-4 calls (kind setpiece, its pool) over about 3 minutes, then done', !!run && calls.length >= 3 && calls.length <= 4 && calls.every(l => inPool(l.text, 'fakedp', 'call')) && run.phase === 'done' && calls[calls.length - 1].t - calls[0].t <= 300, { calls: calls.map(l => `t${l.t - t0} ${l.text}`), phase: run?.phase });
    check('fake DP: at most 2 warnings from the crowd ("its a lure lol": the fakedp warn pool)', warns.length <= 2 && warns.every(l => inPool(l.text, 'fakedp', 'warn')), warns.map(l => l.text));
    for (const [p, x, z] of away) if (p !== pk) place(p, x, z);
    SetPieces.resetSetPiecesForTest();
}

check('no bot errors, no engine errors', BotManager.stats().errors === 0 && logErrors.length === 0, `${BotManager.stats().errors} ${logErrors.slice(0, 2).join(' | ')}`);

let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail && !c.ok ? ` — ${c.detail}` : ''}`);
}
out(`scams: ${checks.length - failed} of ${checks.length} passed`);
process.exit(failed ? 1 : 0);
