#!/usr/bin/env node
// Drop parties and the Seers' Party Room (the realism work, phase 5b, Track P: port/BotParty, tasks/PartyHostTask,
// tasks/PartyGuestTask, the defaults chosen). In the real 274 world,
// 40 aged bots, a stand-in for Track D's director (test/lib/party.ts) planning, starting and ticking the pieces:
//   data       every kit item of data/party.json is a 274 item; the venues' drop squares are walkable; the Party Room's
//              chest, lever and Party Pete are where the data says
//   kits       from aged bots' banks: never a tool, a rare, an untradeable or a members item on a free world; F2P 12-28
//              piles within the budget (2-10k); the Party Room's stacks at most 25, notes 15, single items worth 100+;
//              one better item 5-17 % of kits, the knights 15-35 %, a joke coin pile 5-25 % (600 kits)
//   venue      the F2P venue with the most free bots within 60 tiles; the same plan wherever the human stands
//   F2P        a drop party at Falador park end to end: the host's bank and pack less exactly the piles dropped (coins
//              too); each pile the host's own for 100 ticks (no guest takes one sooner; the human's click on one then
//              takes nothing), then everyone's (the human takes one with the item's own Take); guests take 2-5 each, at
//              most 60 % within 10 ticks of the reveal; the host's 3-6 calls, the guests' few lines (kind setpiece); done,
//              the guests back at their own tasks, their tiles given back; nobody of it stuck there 10 minutes on
//   Party Room the host's kit into the shared chest through its window, the lever's 1,000 coins (the knights' 500 1 in 4),
//              200 balloons, pops by guests and the items theirs, the chest mostly emptied, the host's owned less exactly
//              the kit and the lever's coins
//   no Pete    Party Pete away: the lever does nothing, the party is called off ('no pete'), the kit left in the chest
//   host gone  the host leaves mid-party: the party is called off, the guests' parts end
//   free world (a child process: --members=false) no Party Room plan; no members item in a kit; a drop party at Lumbridge's
//              courtyard end to end
//   errors     none
//
//   node --expose-gc web/engine/bots/test/party.test.mjs [--members=false] [--seed=5]
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { scene } from './lib/dice.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const MEMBERS = (args.members ?? 'true') !== 'false';
const SEED = Number(args.seed ?? 5);
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
const check = (name, ok, detail = '') => checks.push({ name: `${MEMBERS ? '' : 'free world: '}${name}`, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const logErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    console[level] = (...a) => {
        if (level !== 'error') return;
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (!text.includes('ExperimentalWarning')) logErrors.push(text.slice(0, 300));
    };
}

const engineDir = prepareEngineClone(`party-${MEMBERS ? 'p2p' : 'f2p'}`, simWorldConfig({ members: MEMBERS }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/party.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, Party, SetPieces, ObjType, InvType } = lib;
// (the variety work, round 2, Track D2: the round's errands off for these scenes. They hold levelling bots in sub-tasks,
// which no party asks: the free world's "moved off" scene found one guest of the 8 it staged)
await lib.setD2Offers?.(false);
const sim = await lib.Sim.create({ bots: 40, members: MEMBERS, debug: false, ageNewBots: true, humanName: 'casey' });
sim.addHuman(2997, 3383, 0);
const human = sim.human;
for (let stat = 0; stat < human.baseLevels.length; stat++) if (stat !== 18 && stat !== 19) human.setLevel(stat, 60);
const processClientsIn = World.processClientsIn;
World.processClientsIn = function () {
    processClientsIn.call(this);
    human.afkEventReady = false;
};
const tick = (n = 1) => {
    for (let i = 0; i < n; i++) sim.tick();
};
tick(220);
const lines = [];
lib.sayListeners.push((p, text, kind) => lines.push({ t: World.currentTick, name: p.username, text, kind }));
const ai = p => sim.botPlayer(p);
// (a bot moved mid-dialogue first closes it, as a player's window shuts with a teleport: the variety work's round 1 drew
// a fletcher talking to Al Kharid's border guard, and its pass through the gate then walked the 300 tiles back from
// the venue one step a call, a script stack overflow)
const place = (p, x, z) => {
    p.closeModal();
    p.clearWaypoints();
    p.clearInteraction();
    p.teleJump(x, z, 0);
};
// (not one in a script's delay: an agility obstacle walks a bot one tile a tick toward the end it worked out, 274's
// agility_walk, and a bot placed elsewhere mid-obstacle overflowed its stack: the PK tactics' new dice drew one)
const levelling = () => sim.bots().filter(p => ['skiller', 'fighter', 'balanced', 'random'].includes(p.botPlanner) && !lib.isNewbie(p) && !ai(p)?.hasSubTask() && !SetPieces.eventRoleOf(p) && !p.delayed);
const name = id => ObjType.get(id)?.debugname ?? String(id);
const bankId = InvType.getId('bank');
/** what a bot owns in its bank and pack, by item (a note counted as its item) */
function owned(p) {
    const m = new Map();
    for (const inv of [p.getInventory(bankId), p.getInventory(InvType.INV)]) {
        for (let s = 0; inv && s < inv.capacity; s++) {
            const it = inv.get(s);
            if (!it) continue;
            const t = ObjType.get(it.id);
            const id = t.certtemplate !== -1 && t.certlink !== -1 ? t.certlink : it.id;
            m.set(id, (m.get(id) ?? 0) + it.count);
        }
    }
    return m;
}
function less(before, after) {
    const d = new Map();
    for (const [id, n] of before) if (n - (after.get(id) ?? 0) !== 0) d.set(name(id), n - (after.get(id) ?? 0));
    for (const [id, n] of after) if (!before.has(id)) d.set(name(id), -n);
    return d;
}
const rich = () => levelling().filter(p => Party.coinsOwned(p) >= 5000).sort((a, b) => Party.coinsOwned(b) - Party.coinsOwned(a));
/** a forced party: a host placed by a bank near the venue, guests placed within 60 tiles; the run ticked to its end */
function party(kind, venueKey, opts = {}) {
    const hosts = rich();
    const host = opts.host ?? hosts.find(p => Party.planKit(p, kind, mulberry(1)) !== null);
    if (!host) return { error: 'no host' };
    const [hx, hz] = opts.hostAt;
    place(host, hx, hz);
    // (a host as the planner finds one: unhurt and not armed for a random event (BotParty hostFree); the richest with a
    // kit was a fighter at 29 of its 63 Hitpoints after round 1's merge, and the Party Room had no host)
    host.levels[3] = host.baseLevels[3];
    host.afkEventReady = false;
    const guests = levelling().filter(p => p !== host && Party.guestFree(p)).slice(0, opts.guests ?? 8);
    guests.forEach((p, i) => place(p, opts.guestsAt[0] + (i % 4) * 4, opts.guestsAt[1] + Math.floor(i / 4) * 6));
    tick(2);
    const ctx = lib.standInContext(MEMBERS);
    const plan = kind === 'drop_party' ? Party.planDropParty(ctx, venueKey) : Party.planPartyRoom(ctx);
    if (!plan) {
        const v = Party.VENUES.find(x => (venueKey ? x.key === venueKey : x.kind === kind));
        const pool = ctx.freeBots(v.drop[0], v.drop[1], 0, 60, p => Party.guestFree(p) && ctx.sessionLeft(p) >= 3000).length;
        const hostsNear = ctx.freeBots(v.drop[0], v.drop[1], 0, kind === 'drop_party' ? 80 : 120).filter(p => Party.coinsOwned(p) >= 3000).map(p => `${p.username}:${Party.planKit(p, kind, mulberry(2)) ? 'kit' : 'nokit'}`);
        return { error: `no plan (guests ${pool}, hosts ${hostsNear.join(' ')}, placed ${host.username} ${Party.coinsOwned(host)} free ${ctx.freeBots(host.x, host.z, 0, 1).includes(host)})` };
    }
    // (the host the test placed: the plan picks the nearest with a kit)
    const before = owned(plan.data.bot);
    const coinsBefore = Party.coinsOwned(plan.data.bot);
    const def = kind === 'drop_party' ? Party.DROP_PARTY : Party.PARTY_ROOM;
    const l0 = lines.length;
    const run = lib.startPiece(def, plan, ctx);
    if (!run) return { error: 'no run' };
    opts.started?.(run);
    let after = null;
    const t0 = World.currentTick;
    while (lib.tickPiece(run) && World.currentTick - t0 < 2400) {
        tick(1);
        opts.each?.(run);
        if (run.phase === 'done' && !after) after = owned(run.host);
    }
    after ??= owned(run.host);
    return { run, plan, before, after, coinsBefore, said: lines.slice(l0), t0 };
}

// ---- data ----
{
    const missing = Party.KIT_NAMES.filter(n => ObjType.getId(n) === -1);
    check("every kit item of data/party.json is a 274 item", missing.length === 0, missing);
    const blocked = Party.VENUES.filter(v => (MEMBERS || !v.members) && !sim.isWalkable(v.drop[0], v.drop[1], 0));
    check("the venues' drop squares are walkable", blocked.length === 0, blocked.map(v => v.key));
    const room = Party.VENUES.find(v => v.kind === 'party_room');
    const chest = lib.findLocByName(room.chest[0], room.chest[1], 0, 'loc_2417', 1) ?? lib.findLocByName(room.chest[0], room.chest[1], 0, 'partyroom_chestopen', 1);
    const lever = lib.findLocByName(room.lever[0], room.lever[1], 0, 'loc_2416', 1);
    const pete = lib.findNpcByName(room.pete[0], room.pete[1], 0, 'partyroom_pete', 12);
    if (MEMBERS) check("the Party Room's chest, lever and Party Pete are where the data says", chest?.x === room.chest[0] && chest?.z === room.chest[1] && lever?.x === room.lever[0] && lever?.z === room.lever[1] && !!pete, { chest: chest && [chest.x, chest.z], lever: lever && [lever.x, lever.z], pete: pete && [pete.x, pete.z] });
}

// ---- kits ----
{
    const hosts = rich().slice(0, 8);
    const kinds = MEMBERS ? ['drop_party', 'party_room'] : ['drop_party'];
    const bad = [];
    let kits = 0;
    let better = 0;
    let knights = 0;
    let joke = 0;
    let room = 0;
    const dice = mulberry(31);
    // (600 kits, the variety work's round 1: at 300 a world's hosts drew the knights' 1 in 4 at 14 of 99, 20-23 % at
    // 600 and 1,200: the sample, not the rule)
    for (let i = 0; i < 600; i++) {
        const host = hosts[i % hosts.length];
        const kind = kinds[i % kinds.length];
        const kit = Party.planKit(host, kind, dice);
        if (!kit) continue;
        kits++;
        if (kit.better) better++;
        if (kit.coins > 0 && kit.coins <= 10) joke++;
        if (kind === 'party_room') {
            room++;
            if (kit.knights) knights++;
        }
        for (const p of kit.picks) {
            const t = ObjType.get(p.id);
            const cls = Party.kitClassOf(p.id, MEMBERS);
            if (!t.tradeable || (t.members && !MEMBERS) || Party.isTool(p.id) || cls === null) bad.push(`${t.debugname}: not a kit item`);
            if (kind === 'party_room') {
                const carried = ObjType.get(p.as);
                if (carried.stackable && p.as === p.id && p.count > 25) bad.push(`${t.debugname} x${p.count}: a stack over 25 in the chest`);
                if (p.as !== p.id && p.count > 15) bad.push(`${t.debugname} x${p.count}: a note over 15`);
                if (!carried.stackable && lib.itemValue(p.id) < 100) bad.push(`${t.debugname}: a single worth under 100 (Pete's reject)`);
            }
        }
        // (the better item comes on top of the budget: "1 party in 10 adds one better item (<= 30k)")
        const betterValue = kit.picks.filter(p => p.cls === 'better').reduce((n, p) => n + p.value, 0);
        if (betterValue > 30000) bad.push(`a better item worth ${betterValue}`);
        if (kind === 'drop_party' && (kit.drops < 12 || kit.drops > 28 || kit.value - betterValue > kit.budget * 1.05 || kit.budget < 2000 || kit.budget > 10000)) bad.push(`F2P kit: ${kit.drops} piles, ${kit.value} of ${kit.budget}`);
    }
    check(`kits: never a tool, a rare, an untradeable, a members item on a free world; F2P 12-28 piles within the 2-10k budget; the Party Room's stacks <= 25, notes <= 15, singles 100+ (${kits} kits)`, kits >= 200 && bad.length === 0, bad.slice(0, 6));
    // (a free world has no natures to give and fewer mithril or adamant pieces in its banks: at most the 1 in 10 there)
    check('kits: one better item 5-17 % (a free world at most that), a joke coin pile 5-25 %, the knights 15-35 % of Party Room kits', (!MEMBERS || better / kits >= 0.05) && better / kits <= 0.17 && joke / kits >= 0.05 && joke / kits <= 0.25 && (!MEMBERS || (knights / room >= 0.15 && knights / room <= 0.35)), { kits, better, joke, room, knights });
}

// ---- the venue: where the bots are, never where the human is ----
{
    scene(SEED, 'the venue'); // (its own dice: test/lib/dice.mjs)
    const free = levelling();
    // most free bots near Varrock square
    free.slice(0, 14).forEach((p, i) => place(p, 3205 + (i % 7) * 2, 3420 + Math.floor(i / 7) * 10));
    const host = rich().find(p => !free.slice(0, 14).includes(p)) ?? rich()[0];
    place(host, 3185, 3440);
    tick(2);
    const plan1 = Party.planDropParty(lib.standInContext(MEMBERS, mulberry(5)));
    sim.teleportHuman(2997, 3383, 0);
    const plan2 = Party.planDropParty(lib.standInContext(MEMBERS, mulberry(5)));
    sim.teleportHuman(3222, 3222, 0);
    const plan3 = Party.planDropParty(lib.standInContext(MEMBERS, mulberry(5)));
    check('the venue: the one with the most free bots within 60 tiles (Varrock square), the same plan wherever the human stands', plan1?.venue.key === 'varrock_square' && plan2?.venue.key === plan1.venue.key && plan3?.venue.key === plan1.venue.key && plan2?.data.bot === plan1.data.bot && plan3?.data.bot === plan1.data.bot, [plan1?.venue.key, plan2?.venue.key, plan3?.venue.key]);
    sim.teleportHuman(2997, 3383, 0);
}

// ---- F2P: a drop party at Falador park ----
{
    scene(SEED, 'F2P drop party'); // (its own dice: test/lib/dice.mjs)
    let humanEarly = null;
    let humanTook = null;
    const r = party('drop_party', 'falador_park', {
        hostAt: [3013, 3358],
        guestsAt: [2988, 3362],
        guests: 8,
        each(run) {
            // the human: a click on a pile while it is still the host's (nothing), then on one shown to everyone
            const now = World.currentTick;
            const first = run.drops[0];
            if (first && humanEarly === null && now === first.note.t + 50) {
                sim.teleportHuman(first.obj.x, first.obj.z + 1, 0);
                const n = lib.invItems(human, 'inv').length;
                lib.interactObjOp(human, first.obj, 3);
                tick(3);
                humanEarly = { took: lib.invItems(human, 'inv').length > n, still: first.obj.isActive };
            }
            const last = run.drops[run.drops.length - 1];
            if (last && humanTook === null && run.dropsDone && now === last.note.t + 101 && last.obj.isActive && last.obj.receiver64 === lib.Obj.NO_RECEIVER) {
                sim.teleportHuman(last.obj.x, last.obj.z, 0);
                const before = lib.invItems(human, 'inv').join(',');
                lib.interactObjOp(human, last.obj, 3);
                tick(2);
                humanTook = lib.invItems(human, 'inv').join(',') !== before && !last.obj.isActive;
            }
        }
    });
    const run = r.run;
    if (!run) check('a drop party at Falador park ran', false, { error: r.error, rich: rich().length, free: levelling().filter(p => Party.guestFree(p)).length });
    else {
        const rec = run.record;
        const dropped = new Map();
        for (const d of rec.drops) dropped.set(d.item, (dropped.get(d.item) ?? 0) + d.count);
        const lost = less(r.before, r.after);
        const same = [...lost].every(([k, n]) => dropped.get(k) === n) && [...dropped].every(([k, n]) => lost.get(k) === n);
        check("F2P: the host's bank and pack less exactly the piles it dropped (coins too)", rec.drops.length >= 12 && same, { lost: Object.fromEntries(lost), dropped: Object.fromEntries(dropped) });
        const early = rec.drops.filter(d => d.by === 'bot' && d.goneAt < d.revealAt);
        check("F2P: each pile the host's own for 100 ticks: no guest takes one sooner, the human's click then takes nothing", early.length === 0 && humanEarly && !humanEarly.took && humanEarly.still, { early: early.length, humanEarly });
        check("F2P: once shown to everyone, the human takes one with the item's own Take", humanTook === true, humanTook);
        const byBot = rec.drops.filter(d => d.by === 'bot');
        const quick = byBot.filter(d => d.goneAt - d.revealAt <= 10);
        const per = {};
        for (const d of byBot) per[d.name] = (per[d.name] ?? 0) + 1;
        check('F2P: guests take 2-5 piles each at most, at most 60 % of the piles within 10 ticks of showing', Object.values(per).every(n => n <= 5) && quick.length <= 0.6 * rec.drops.length, { per, quick: quick.length, piles: rec.drops.length, other: rec.drops.filter(d => d.by === 'other').length });
        const host = r.said.filter(l => l.name === run.host.username && l.kind === 'setpiece');
        const guests = r.said.filter(l => l.name !== run.host.username && l.kind === 'setpiece');
        check("F2P: the host's 3-6 calls and the guests' few lines, all kind setpiece", host.length >= 3 && host.length <= 6 && guests.length <= 12, { host: host.map(l => l.text), guests: guests.map(l => l.text) });
        const guestBots = [...run.guests.keys()];
        tick(30);
        const stillIn = guestBots.filter(p => ai(p)?.hasSubTask() && (ai(p)?.subTask?.name ?? '').startsWith('Party'));
        // (a tile at the venue still held: its own task may hold one elsewhere, a thief's or a smith's)
        const [vx, vz] = run.venue.drop;
        const tiles = guestBots.filter(p => {
            const t = p.slot !== -1 ? lib.standTileOf(p) : null;
            return t && Math.max(Math.abs(t[0] - vx), Math.abs(t[1] - vz)) <= 8 && !ai(p)?.hasSubTask();
        });
        check('F2P: the party done, its guests back at their own tasks, their tiles given back', rec.outcome === 'done' && rec.asked >= 3 && rec.came >= 2 && stillIn.length === 0 && tiles.length === 0 && run.phase === 'done' && !ai(run.host)?.hasSubTask(), { outcome: rec.outcome, asked: rec.asked, came: rec.came, stillIn: stillIn.length, tiles: tiles.map(p => p.username) });
        tick(1010);
        check('F2P: nobody of the party stuck at the venue 10 minutes on', rec.stuckAfter === 0, rec.stuckAfter);
        out(`note: F2P party: ${rec.drops.length} piles worth ${rec.kitValue} (budget ${rec.budget}), ${rec.came} guests of ${rec.asked} asked, peak ${rec.peak}, taken: ${JSON.stringify(per)}, ${quick.length} within 10 ticks`);
    }
}

// ---- the Party Room ----
if (MEMBERS) {
    scene(SEED, 'the Party Room'); // (its own dice: test/lib/dice.mjs)
    const chest0 = lib.chestItems().length;
    const r = party('party_room', null, { hostAt: [2725, 3490], guestsAt: [2716, 3478], guests: 8 });
    const run = r.run;
    if (!run) check('a Party Room party ran', false, r.error);
    else {
        const rec = run.record;
        const lever = 1000 + (rec.knights ? 500 : 0);
        const lost = less(r.before, r.after);
        const kit = new Map();
        for (const p of run.kit.picks) kit.set(name(p.id), (kit.get(name(p.id)) ?? 0) + p.count);
        kit.set('coins', (kit.get('coins') ?? 0) + run.kit.coins + lever);
        // (less what the host's own pops gave it back: 274 gives a pop's item to the popper)
        for (const g of rec.hostGot) {
            const t = ObjType.get(ObjType.getId(g.item));
            const item = t.certtemplate !== -1 && t.certlink !== -1 ? name(t.certlink) : g.item;
            kit.set(item, (kit.get(item) ?? 0) - g.count);
            if (kit.get(item) === 0) kit.delete(item);
        }
        const same = [...lost].every(([k, n]) => kit.get(k) === n) && [...kit].every(([k, n]) => lost.get(k) === n);
        check("the Party Room: the host's bank and pack less exactly the kit and the lever's coins (the knights' too)", rec.lever && same, { lost: Object.fromEntries(lost), kit: Object.fromEntries(kit), knights: rec.knights });
        check("the Party Room: the kit into the shared chest through its window (its slots in it), the lever pulled", rec.chest.after - rec.chest.before >= Math.min(8, run.kit.drops) && rec.lever, rec.chest);
        check('the Party Room: guests popped balloons and picked their own items up, the chest emptied of some', rec.pops.guests >= 10 && rec.pops.items >= 3 && rec.chest.end < rec.chest.after, { pops: rec.pops, chest: rec.chest });
        out(`note: Party Room: kit ${rec.kitValue} in ${run.kit.drops} slots, ${rec.came} guests of ${rec.asked}, pops ${JSON.stringify(rec.pops)}, chest ${JSON.stringify(rec.chest)}, knights ${rec.knights}, ${r.said.filter(l => l.kind === 'setpiece').length} lines`);
    }
    void chest0;

    // Party Pete away: the lever does nothing, the party is called off, the kit left in the chest
    scene(SEED, 'no Pete');
    const room = Party.VENUES.find(v => v.kind === 'party_room');
    const pete = lib.findNpcByName(room.pete[0], room.pete[1], 0, 'partyroom_pete', 16);
    let removed = false;
    const r2 = party('party_room', null, {
        hostAt: [2725, 3490],
        guestsAt: [2716, 3478],
        guests: 4,
        each(run) {
            // (from the chest on: the lever's stage is a few ticks, and at track D's head it went by unseen once)
            if (!removed && (run.hostTask.stage === 'chest' || run.hostTask.stage === 'lever') && pete) {
                World.removeNpc(pete, 600);
                removed = true;
            }
        }
    });
    const coinsAfter = r2.run ? Party.coinsOwned(r2.run.host) : -1;
    check('no Pete: the lever does nothing, the party is called off, the kit left in the chest, no lever coins spent', removed && r2.run?.record.outcome === 'no pete' && !r2.run.record.lever && r2.run.record.chest.after > r2.run.record.chest.before && r2.coinsBefore - coinsAfter === r2.run.kit.coins, { removed, outcome: r2.run?.record.outcome, chest: r2.run?.record.chest, coins: [r2.coinsBefore, coinsAfter, r2.run?.kit.coins] });
}

// ---- the host leaves mid-party ----
{
    scene(SEED, 'the host leaves'); // (its own dice: test/lib/dice.mjs)
    const r = party('drop_party', 'falador_park', {
        hostAt: [3013, 3358],
        guestsAt: [2988, 3362],
        guests: 8,
        each(run) {
            if (run.phase === 'build' && run.guests.size > 0 && !run._left) {
                run._left = true;
                run.left(run.host, 'logout');
            }
        }
    });
    const guests = r.run ? [...r.run.guests.keys()] : [];
    tick(3);
    // (a part over is one finished: a guest held by a fight on its way, a replacement from further off since the variety
    // work's round 1, drops it once the fight is done)
    const partOn = p => (ai(p)?.subTask?.name ?? '').startsWith('Party') && !ai(p).subTask.isComplete(p);
    check('the host leaves: the party is called off, the guests\' parts end', r.run?.record.outcome === 'host logout' && guests.every(p => !partOn(p)), { outcome: r.run?.record.outcome, guests: guests.length, on: guests.filter(partOn).map(p => p.username), error: r.error });
}

// ---- moved off mid-party (a random event's fail teleport, a death) ----
{
    scene(SEED, 'moved off'); // (its own dice: test/lib/dice.mjs)
    let moved = null;
    let movedAt = -1;
    let guestGone = null;
    let hostMoved = false;
    const r = party('drop_party', 'falador_park', {
        hostAt: [3013, 3358],
        guestsAt: [2988, 3362],
        guests: 8,
        each(run) {
            const now = World.currentTick;
            if (!moved) {
                // (a guest waiting at the venue is moved 100 tiles off)
                const waiting = [...run.guests].find(([, t]) => t.stage === 'wait');
                if (waiting && run.phase === 'build') {
                    moved = waiting[0];
                    movedAt = now;
                    place(moved, 3093, 3300);
                }
            } else if (guestGone === null && now - movedAt >= 10) {
                guestGone = { stage: run.guests.get(moved)?.stage ?? 'gone', sub: ai(moved)?.subTask?.name ?? null, others: [...run.guests].filter(([p, t]) => p !== moved && t.stage !== 'done').length };
                // (then the host, waiting at the venue)
                if (run.phase === 'build') {
                    hostMoved = true;
                    place(run.host, 3093, 3300);
                }
            }
        }
    });
    tick(3);
    check('moved off: a waiting guest moved 100 tiles off leaves the party at once (the others come or wait on)',guestGone && guestGone.stage === 'done' && guestGone.sub !== 'PartyGuest' && guestGone.others >= 1, { guestGone, error: r.error });
    check('moved off: the host moved off the venue calls the party off', hostMoved && r.run?.record.outcome === 'host moved', { hostMoved, outcome: r.run?.record.outcome });
    // a bot armed for a random event (port/BotRandomEvents keeps the game's flag only on one it armed) is asked to no party
    const p = levelling().find(b => Party.guestFree(b));
    if (p) {
        p.afkEventReady = true;
        const armed = Party.guestFree(p);
        p.afkEventReady = false;
        check('a bot armed for a random event is no guest (its answer would wait behind the party)', !armed);
    }
}

check('no bot errors, no engine errors', BotManager.stats().errors === 0 && logErrors.length === 0, `${BotManager.stats().errors} ${logErrors.slice(0, 2).join(' | ')}`);

// ---- a free world (a child process) ----
if (MEMBERS && args.child !== 'false') {
    const here = fileURLToPath(import.meta.url);
    const child = spawnSync(process.execPath, ['--expose-gc', here, '--members=false', `--seed=${SEED}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const lines2 = (child.stdout ?? '').trim().split('\n').filter(l => l.startsWith('ok ') || l.startsWith('FAIL') || l.startsWith('note'));
    for (const l of lines2) {
        if (l.startsWith('note')) out(l);
        else checks.push({ name: l.replace(/^(ok {3}|FAIL )/, ''), ok: l.startsWith('ok'), detail: '' });
    }
    if (child.status !== 0 && !lines2.some(l => l.startsWith('FAIL'))) check('the free world\'s run', false, (child.stderr ?? '').slice(-400));
}
if (!MEMBERS) {
    const ctx = lib.standInContext(false);
    check('no Party Room plan on a free world', Party.planPartyRoom(ctx) === null);
    const r = party('drop_party', 'lumbridge_courtyard', { hostAt: [3215, 3240], guestsAt: [3212, 3205], guests: 7 });
    const rec = r.run?.record;
    const members = (rec?.drops ?? []).filter(d => ObjType.get(ObjType.getId(d.item))?.members);
    check('a drop party at Lumbridge\'s courtyard end to end, no members item among its piles', rec?.outcome === 'done' && rec.drops.length >= 12 && members.length === 0 && rec.drops.some(d => d.by === 'bot'), { outcome: rec?.outcome, piles: rec?.drops.length, members: members.map(d => d.item), error: r.error });
    check('free world: no bot errors, no engine errors', BotManager.stats().errors === 0 && logErrors.length === 0, `${BotManager.stats().errors} ${logErrors.slice(0, 2).join(' | ')}`);
}

let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail && !c.ok ? ` — ${c.detail}` : ''}`);
}
out(`party: ${checks.length - failed} of ${checks.length} passed`);
process.exit(failed ? 1 : 0);
