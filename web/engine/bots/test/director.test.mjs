#!/usr/bin/env node
// The director (the realism work, phase 5b, Track D: port/BotDirector,
// "Round 5b"; "about hourly, where the bots are"):
//   schedule   200 simulated hours of play on a clock of the test's own, every kind registered (stubs: Track P's and A's
//              pieces are built in parallel, and Track D's own are tested in test/groups.test.mjs): about one event an hour
//              (0.85-1.2), the first 20-50 minutes in, starts at least 30 minutes apart, the gaps' median 50-60 and mean
//              50-70 minutes, none over 110; no kind twice in a row, no venue again within 3 events; each kind about its
//              weight's share; a free world never a members-only kind
//   retry      nothing can run: a look again every 5 minutes, a fresh gap after 30 minutes of that (an hour may pass with no
//              event), then on again
//   census     bots only: a human in the list is never counted, and the events are the same wherever the human is
//   restart    the schedule round-trips the store: reset and restored, the next event comes as far away as it was, not of the
//              last kind nor at the last venues; a state of another shape is ignored
//   world      the real 274 world with 30 bots and a human: a stub piece forced early recruits through freeBots (bots with
//              no sub-task and no part, within its 60 tiles, never a newbie, a vendor or a PKer), they get their parts and
//              lose them at its end, back at their own doings 2 minutes later (V3) and not recruited again within 2 hours;
//              its rumours (at most 4, and one near the human) are kind 'rumour', from bots within 150 tiles of it
//   errors     none
//
//   node --expose-gc web/engine/bots/test/director.test.mjs [--seed=5]
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const SEED = Number(args.seed ?? 5);
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
const logErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    console[level] = (...a) => {
        if (level !== 'error') return;
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (!text.includes('ExperimentalWarning')) logErrors.push(text.slice(0, 300));
    };
}
const engineDir = prepareEngineClone('director', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/director.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, SetPieces, Director: D } = lib;
const HOUR = 6000;
const median = xs => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ---- stub pieces: every kind of the defaults table, at its weights (members / free) ----
const KINDS = [
    { kind: 'drop_party', members: false, weight: { members: 15, free: 30 }, venues: ['falador', 'varrock', 'lumbridge'] },
    { kind: 'party_room', members: true, weight: { members: 10, free: 0 }, venues: ['seers'] },
    { kind: 'clan_walk', members: false, weight: { members: 20, free: 25 }, venues: ['lumbridge', 'draynor', 'falador', 'varrock', 'edgeville', 'al_kharid', 'seers', 'catherby'] },
    { kind: 'pk_raid', members: false, weight: { members: 15, free: 20 }, venues: ['edgeville'] },
    { kind: 'duel_stake', members: true, weight: { members: 15, free: 0 }, venues: ['duel_arena'] },
    { kind: 'scam_spree', members: false, weight: { members: 15, free: 15 }, venues: ['varrock', 'falador', 'edgeville'] },
    { kind: 'fake_dp', members: false, weight: { members: 10, free: 10 }, venues: ['varrock', 'edgeville'] }
];
let feasible = true;
const started = [];
function stub({ kind, members, weight, venues }) {
    return {
        kind,
        members,
        weight,
        plan(ctx) {
            if (!feasible) return null;
            // (a venue where the bots are: weighted by the census's count, the piece's own dice)
            const counts = venues.map(v => [v, ctx.census.get(v)?.length ?? 0]).filter(([, n]) => n > 0);
            if (!counts.length) return null;
            let x = ctx.dice() * counts.reduce((s, [, n]) => s + n, 0);
            let key = counts[counts.length - 1][0];
            for (const [v, n] of counts) {
                x -= n;
                if (x < 0) {
                    key = v;
                    break;
                }
            }
            const r = D.CENSUS_REGIONS.find(c => c.key === key);
            return { kind, venue: { key, x: r.x, z: r.z, level: 0, say: key }, score: 1 };
        },
        start(plan, ctx) {
            const length = 1000 + Math.floor(ctx.dice() * 1500);
            started.push({ kind, venue: plan.venue.key, play: ctx.play });
            return {
                id: SetPieces.nextSetPieceId(),
                kind,
                venue: plan.venue,
                phase: 'announce',
                startedAt: ctx.now,
                endsBy: ctx.now + length,
                roles: new Map(),
                tick(now) {
                    const f = (now - this.startedAt) / length;
                    this.phase = f < 0.15 ? 'announce' : f < 0.3 ? 'build' : f < 0.85 ? 'peak' : f < 1 ? 'end' : 'done';
                },
                left() {},
                rumour: () => null,
                abort(why) {
                    this.phase = 'done';
                    this.outcome = why;
                }
            };
        }
    };
}
for (const k of KINDS) SetPieces.register(stub(k));

// a world of bots for the census (fakes: the census reads is_bot, x, z only) and a human
const fakeBots = [];
const spread = { varrock: 22, falador: 16, lumbridge: 16, draynor: 8, edgeville: 9, al_kharid: 7, seers: 8, catherby: 5, duel_arena: 5, ardougne: 4 };
for (const [key, n] of Object.entries(spread)) {
    const r = D.CENSUS_REGIONS.find(c => c.key === key);
    for (let i = 0; i < n; i++) fakeBots.push({ is_bot: true, username: `${key}_${i}`, x: r.x + ((i * 7) % 21) - 10, z: r.z + ((i * 13) % 21) - 10, level: 0, slot: 1 });
}
const human = { is_bot: false, username: 'sim human', x: 3212, z: 3428, level: 0, slot: 2 };

/** the director's step on the test's clock for `hours` of play (from `play`), returning the play tick reached */
function runHours(hours, play = 0, members = true) {
    D.setDirectorForTest({ bots: () => [...fakeBots, human], members });
    const end = play + hours * HOUR;
    for (; play < end; play += 5) D.directorStepForTest(play, 100000 + play);
    return play;
}

// ---- 1. the schedule over 200 hours ----
let members200 = null;
{
    D.resetDirectorForTest();
    started.length = 0;
    runHours(200);
    const events = [...D.directorLog];
    members200 = events.map(e => [e.kind, e.venue, e.startPlay]);
    const perHour = events.length / 200;
    const gaps = events.slice(1).map((e, i) => (e.startPlay - events[i].startPlay) / 100);
    check('about one event an hour of play (0.85-1.2 over 200 hours)', perHour >= 0.85 && perHour <= 1.2, `${events.length} events, ${perHour.toFixed(2)} an hour`);
    check('the first event 20-50 minutes in', events.length > 0 && events[0].startPlay >= 2000 && events[0].startPlay <= 5005, `${(events[0]?.startPlay ?? -1) / 100} min`);
    check('starts at least 30 minutes apart, none over 110', gaps.length > 0 && Math.min(...gaps) >= 30 && Math.max(...gaps) <= 110.1, `${Math.min(...gaps)}-${Math.max(...gaps)} min`);
    check("the gaps: median 50-60 minutes, mean 50-70 (log-normal round 55, σ 0.35)", median(gaps) >= 50 && median(gaps) <= 60 && mean(gaps) >= 50 && mean(gaps) <= 70, `median ${median(gaps)}, mean ${mean(gaps).toFixed(1)}`);
    const twice = events.slice(1).filter((e, i) => e.kind === events[i].kind).length;
    check('no kind twice in a row', twice === 0, `${twice}`);
    let again = 0;
    for (let i = 0; i < events.length; i++) for (let j = Math.max(0, i - 3); j < i; j++) if (events[j].venue === events[i].venue) again++;
    check('no venue again within 3 events', again === 0, `${again}`);
    const total = KINDS.reduce((s, k) => s + k.weight.members, 0);
    const shares = KINDS.map(k => [k.kind, events.filter(e => e.kind === k.kind).length / events.length, k.weight.members / total]);
    check("each kind about its weight's share (within 0.5-1.6 of it; members world)", shares.every(([, got, want]) => got >= want * 0.5 && got <= want * 1.6), shares.map(([k, got, want]) => `${k} ${(got * 100).toFixed(0)} % (${(want * 100).toFixed(0)})`).join(', '));
    const done = events.filter(e => e.end >= 0 && e.outcome === 'done').length;
    check('each event ran to its end', done >= events.length - 1, `${done} of ${events.length}`);
}

// ---- 2. a free world ----
{
    D.resetDirectorForTest();
    runHours(50, 0, false);
    const kinds = new Set(D.directorLog.map(e => e.kind));
    check('a free world: never a members-only kind (the Party Room, the Duel Arena)', D.directorLog.length >= 35 && !kinds.has('party_room') && !kinds.has('duel_stake'), `${D.directorLog.length} events: ${[...kinds].join(', ')}`);
}

// ---- 3. nothing can run: retries, a fresh gap, then on again ----
{
    D.resetDirectorForTest();
    let play = runHours(2);
    const before = D.directorLog.length;
    feasible = false;
    const nexts = [];
    const from = play;
    D.setDirectorForTest({ bots: () => [...fakeBots, human], members: true });
    for (const end = play + 3 * HOUR; play < end; play += 5) {
        D.directorStepForTest(play, 100000 + play);
        if (play % 100 === 0) nexts.push([play - from, D.directorState().next - play]);
    }
    const during = D.directorLog.length - before;
    feasible = true;
    play = runHours(4, play);
    const after = D.directorLog.length - before;
    // (once due while nothing could run: looks again within 5 minutes for 30, then a fresh gap of 30+ minutes)
    const looking = nexts.filter(([t, n]) => n >= 0 && n <= 500).length;
    const fresh = nexts.some(([, n]) => n >= 2500);
    check('nothing can run: no event; a look again every 5 minutes, then a fresh gap after 30 (an hour may pass with none)', during === 0 && looking > 0 && fresh, `${during} events in 3 hours; ${looking} samples looking again within 5 min; a fresh gap ${fresh}`);
    check('...and on again once something can', after >= 2, `${after} events in the 4 hours after`);
}

// ---- 4. the census: bots only, the human's place no matter ----
{
    D.setDirectorForTest({ bots: () => [...fakeBots, human], members: true });
    const ctx = D.directorContextForTest(1000, 101000);
    let humans = 0;
    let counted = 0;
    for (const list of ctx.census.values()) {
        counted += list.length;
        humans += list.filter(p => p.is_bot !== true).length;
    }
    check('the census counts bots only (the human beside them is never in it)', humans === 0 && counted >= fakeBots.length - 10 && ctx.online === fakeBots.length, `${counted} in regions, ${ctx.online} online, ${humans} humans`);
    // the same 30 hours, the same dice, with the human at Varrock's square and then at Seers': the same events
    const runWith = (hx, hz) => {
        D.resetDirectorForTest();
        Math.random = mulberry(SEED + 1);
        human.x = hx;
        human.z = hz;
        runHours(30);
        return D.directorLog.map(e => [e.kind, e.venue, e.startPlay].join('|'));
    };
    const first = runWith(3212, 3428);
    const second = runWith(2725, 3485);
    check("the events are the same wherever the human is (never staged round it)", first.length > 20 && first.join(',') === second.join(','), `${first.length} vs ${second.length} events; first difference at ${first.findIndex((e, i) => e !== second[i])}`);
}

// ---- 5. a restart: the schedule round-trips the store ----
{
    D.resetDirectorForTest();
    check('no schedule before the first look: nothing for the store', D.exportDirector() === null);
    let play = runHours(10);
    const saved = JSON.parse(JSON.stringify(D.exportDirector()));
    const state = D.directorState();
    const ok = saved && saved.v === 1 && saved.next === state.next - state.play && saved.recent.length === 3 && saved.last === state.lastKind;
    check('the store gets the next event (play ticks from now), the last 3 venues and the last kind', ok, saved);
    // a new run of the app: the director reset (its log too), the store restored
    D.resetDirectorForTest();
    for (const bad of [null, 'x', 7, { v: 2, next: 100 }, { v: 1, next: 'soon' }, { v: 1 }]) D.restoreDirector(bad);
    check('a state of another shape is ignored (nothing scheduled)', D.directorState().next === -1, D.directorState());
    D.restoreDirector(saved);
    check('restored: the next event as far away as it was', D.directorState().next === saved.next, `${D.directorState().next} vs ${saved.next}`);
    play = runHours(1, 0);
    const next = D.directorLog[0];
    check('...and it comes then, not of the last kind, not at the last venues', !!next && Math.abs(next.startPlay - saved.next) <= 5 && next.kind !== saved.last && !saved.recent.includes(next.venue), next ? `${next.kind}@${next.venue} at ${next.startPlay} (saved: next ${saved.next}, last ${saved.last}, recent ${saved.recent.join(' ')})` : 'none');
}

// ---- 6. the real world: recruits, parts, back on task, the cooldown, rumours ----
D.resetDirectorForTest();
D.setDirectorForTest(null);
for (const k of KINDS) SetPieces.register(stub(k));
{
    const sim = await lib.Sim.create({ bots: 30, members: true, debug: false, ageNewBots: true });
    sim.addHuman(3212, 3428, 0);
    {
        const clientsIn = World.processClientsIn;
        World.processClientsIn = function () {
            clientsIn.call(this);
            sim.human.afkEventReady = false;
        };
    }
    const lines = [];
    lib.sayListeners.push((p, text, kind) => lines.push({ t: World.currentTick, name: p.username, text, kind, x: p.x, z: p.z }));
    for (let i = 0; i < 300 && sim.bots().length < 30; i++) sim.tick();
    for (let i = 0; i < 200; i++) sim.tick();

    // the stub: a gathering at the census's busiest region, its recruits from freeBots, a part each (a stand there)
    class Gather extends lib.BotTask {
        constructor(run, x, z) {
            super('Gather');
            this.run = run;
            this.x = x;
            this.z = z;
            this.ticks = 0;
        }
        shouldRun() {
            return true;
        }
        tick(p) {
            this.ticks++;
            if (Math.max(Math.abs(p.x - this.x), Math.abs(p.z - this.z)) > 6 && !p.hasWaypoints()) lib.walkTo(p, this.x, this.z, 0);
        }
        isComplete() {
            return this.run.phase === 'done';
        }
    }
    let recruitsAtStart = [];
    let freeBefore = null;
    SetPieces.register({
        kind: 'fake_dp',
        weight: { members: 10, free: 10 },
        plan(ctx) {
            let best = null;
            for (const [key, list] of ctx.census) if (!best || list.length > best.n) best = { key, n: list.length };
            if (!best || best.n < 2) return null;
            const r = D.CENSUS_REGIONS.find(c => c.key === best.key);
            const recruits = ctx.freeBots(r.x, r.z, 0, 60, undefined, 4);
            if (recruits.length < 2) return null;
            freeBefore = recruits.map(p => ({ name: p.username, sub: sim.botPlayer(p)?.hasSubTask() ?? null, role: SetPieces.eventRoleOf(p), planner: p.botPlanner, newbie: lib.isNewbie(p), d: Math.max(Math.abs(p.x - r.x), Math.abs(p.z - r.z)) }));
            return { kind: 'fake_dp', venue: { key: best.key, x: r.x, z: r.z, level: 0, say: best.key }, score: 1, data: recruits };
        },
        start(plan, ctx) {
            const run = {
                id: SetPieces.nextSetPieceId(),
                kind: 'fake_dp',
                venue: plan.venue,
                phase: 'announce',
                startedAt: ctx.now,
                endsBy: ctx.now + 600,
                roles: new Map(plan.data.map(p => [p, 'guest'])),
                tick(now) {
                    this.phase = now - this.startedAt < 100 ? 'announce' : now - this.startedAt < 500 ? 'peak' : 'done';
                },
                left(p) {
                    this.roles.delete(p);
                },
                rumour: () => 'drop party at fally park!!',
                abort(why) {
                    this.phase = 'done';
                    this.outcome = why;
                }
            };
            for (const p of plan.data) sim.botPlayer(p)?.setSubTask(new Gather(run, plan.venue.x, plan.venue.z));
            recruitsAtStart = [...plan.data];
            return run;
        }
    });
    // (forced now, the world filled: the schedule drawn afresh at the next look)
    D.resetDirectorForTest();
    D.setDirectorForTest({ first: 20, firstKinds: ['fake_dp'], kinds: ['fake_dp'] });
    let during = null;
    for (let i = 0; i < 1200; i++) {
        sim.tick();
        const st = D.directorState();
        if (st.running === 'fake_dp' && !during && World.currentTick % 5 === 0 && recruitsAtStart.length) {
            const run = SetPieces.runningSetPieces().find(r => r.kind === 'fake_dp');
            if (run && run.phase === 'peak') during = recruitsAtStart.map(p => ({ role: SetPieces.eventRoleOf(p)?.role ?? null, sub: sim.botPlayer(p)?.hasSubTask() ?? null }));
        }
    }
    const rec = D.directorLog.find(e => e.kind === 'fake_dp');
    check('a piece forced early starts (the runner\'s --director-first) and ends', !!rec && rec.end > rec.start && rec.outcome === 'done', rec ? `${rec.kind}@${rec.venue} ${rec.start}-${rec.end} ${rec.outcome}` : 'none');
    check('its recruits came from freeBots: no sub-task, no part, within 60 tiles; never a newbie, a vendor or a PKer', !!freeBefore && freeBefore.every(f => f.sub === false && f.role === null && f.d <= 60 && !f.newbie && !['extras_vendor', 'extras_pker', 'extras_edgeville_pker'].includes(f.planner)), freeBefore);
    check('each had its part during it (a role, its sub-task), noted by the director', !!during && during.every(d => d.role === 'guest' && d.sub === true) && rec?.recruits.length === recruitsAtStart.length, { during, noted: rec?.recruits.length });
    const after = recruitsAtStart.map(p => ({ role: SetPieces.eventRoleOf(p), sub: sim.botPlayer(p)?.hasSubTask() ?? null }));
    check('after its end: no part, the sub-task gone', after.every(a => a.role === null && a.sub === false), after);
    const looked = rec?.recruits.filter(r => r.back !== undefined && r.back !== null) ?? [];
    const back = looked.filter(r => r.back === true).length;
    check('2 minutes after: back at their own doings (V3: 90 %+)', looked.length > 0 && back >= looked.length * 0.9, rec?.recruits.map(r => `${r.name} ${r.back}`).join(', '));
    const ctx = D.directorContextForTest(BotManager.stats().playTicks, World.currentTick);
    const again = ctx.freeBots(rec?.x ?? 3212, rec?.z ?? 3428, 0, 200);
    check('none of them recruited again within 2 hours (the cooldown: freeBots leaves them out)', recruitsAtStart.every(p => D.recruitedLately(p.username) && !again.includes(p)), recruitsAtStart.map(p => D.recruitedLately(p.username)));
    const rumours = rec?.rumours ?? [];
    const rumourLines = lines.filter(l => l.kind === 'rumour');
    check('its rumours: at most 4 (and one near the human), kind rumour, from bots within 150 tiles of it, not at it', rumours.filter(r => !r.nearHuman).length <= 4 && rumours.filter(r => r.nearHuman).length <= 1 && rumourLines.length === rumours.length && rumourLines.every(l => !recruitsAtStart.some(p => p.username === l.name)), { rumours, lines: rumourLines.map(l => `${l.name}: ${l.text}`) });
    out(`note: rumours: ${rumours.map(r => `${r.name}${r.nearHuman ? ' (near the human)' : ''}: ${r.text}`).join(' | ') || 'none'}`);
    check('no bot errors', BotManager.stats().errors === 0 && logErrors.length === 0, logErrors.slice(0, 3));
}

let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(`director: ${checks.length - failed} of ${checks.length} passed`);
process.exit(failed ? 1 : 0);
