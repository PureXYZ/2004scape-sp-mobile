#!/usr/bin/env node
// Set pieces: the foundation (the realism work, phase 5b, "Foundation
// (5b)"), in the real 274 world with a few bots. The tracks' tests check the pieces themselves (director, groups, party,
// scams, duel):
//   registry   a piece registers; a run's roles say who is in it (eventRoleOf), a role outside a run too (setRole),
//              and none after; BotManager holds a bot's logout while it has one; the planner's hook offers a piece's
//              task, never to a bot in a piece already; the director's and the trains' stubs run
//   emotes     all twelve of the controls tab's emotes play their animation; none with a screen open
//   crown      a bot's line carries its staff level's crown (the player-mod bot's silver crown), 0 for the rest
//   lines      a listener on the human's lines that answers one keeps the bots near from answering it too
//   screens    an item used on a player (a rotten tomato thrown), as OpPlayerUHandler takes the click
//
//   node --expose-gc web/engine/bots/test/setpieces.test.mjs
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const out = (s = '') => process.stdout.write(s + '\n');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};

const engineDir = prepareEngineClone('setpieces', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/setpieces.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, SetPieces } = lib;
const sim = await lib.Sim.create({ bots: 6, members: true, debug: false });
sim.addHuman(3212, 3428, 0);
const run = (ticks, until) => {
    for (let i = 0; i < ticks; i++) {
        sim.tick();
        if (until && until()) return i + 1;
    }
    return -1;
};
run(300, () => sim.bots().length >= 6);
run(20);
const bots = sim.bots();
check('six bots in the world', bots.length >= 3, bots.length);
if (bots.length < 3) {
    out(`FAIL only ${bots.length} bots came into the world`);
    process.exit(1);
}
const [a, b, c] = bots;

// ---- registry ----
{
    const kind = 'fake_dp';
    SetPieces.register({ kind, weight: { members: 1, free: 1 }, plan: () => null, start: () => null });
    check('a piece registers (the registry lists it)', SetPieces.registeredSetPieces().some(d => d.kind === kind));
    const roles = new Map([[a, 'host']]);
    const fake = { id: SetPieces.nextSetPieceId(), kind, venue: { key: 'test', x: a.x, z: a.z, level: 0, say: 'here' }, phase: 'peak', startedAt: World.currentTick, endsBy: World.currentTick + 100, roles, tick() {}, left() {}, rumour: () => null, abort() {} };
    SetPieces.runStarted(fake);
    const role = SetPieces.eventRoleOf(a);
    check("a run's role: its host is in it, a bot outside is not", role?.role === 'host' && role.run === fake && SetPieces.eventRoleOf(b) === null, { a: role?.role, b: SetPieces.eventRoleOf(b) });
    check("BotManager holds the logout of a bot in a set piece ('busy')", BotManager._busy(a, World.currentTick) === 'busy' && BotManager._busy(c, World.currentTick) !== 'busy', { a: BotManager._busy(a, World.currentTick), c: BotManager._busy(c, World.currentTick) });
    const task = { name: 'FakePiece' };
    SetPieces.registerPlannerHook(p => (p === a || p === b ? task : null));
    check("the planner's hook: a piece's task for a bot outside a piece, none for one in it", SetPieces.setPieceTaskFor(b, null) === task && SetPieces.setPieceTaskFor(a, null) === null && SetPieces.setPieceTaskFor(c, null) === null);
    check('no hang-out for a bot in a set piece', lib.hangoutFor(a, null) === null);
    fake.phase = 'done';
    check('a run that is done: its roles no longer count', SetPieces.eventRoleOf(a) === null);
    SetPieces.runEnded(fake);
    SetPieces.setRole(b, 'duellist');
    const own = SetPieces.eventRoleOf(b);
    check("a role outside a run (a duellist on its own arena visit), then none", own?.role === 'duellist' && own.run === null && (SetPieces.clearRole(b), SetPieces.eventRoleOf(b) === null));
    // (the review of the merge: a sub-task replaced, by a "come here" or a follow, is over: BotPlayer interrupts it, so a
    // part's role and screens are released; it once stayed set for good and held the bot's logout)
    {
        const ai = BotManager.botFor(b);
        const held = { name: 'Held', interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, reset() {}, interrupt() { this.interrupted = true; SetPieces.clearRole(b); }, activityStep: () => null };
        const next = { name: 'Next', interrupted: false, shouldRun: () => true, isComplete: () => false, tick() {}, reset() {}, interrupt() {}, activityStep: () => null };
        ai.setSubTask(held);
        SetPieces.setRole(b, 'duellist');
        ai.setSubTask(next);
        check('a sub-task replaced is interrupted: its role released (no logout held for good)', held.interrupted && SetPieces.eventRoleOf(b) === null, { interrupted: held.interrupted, role: SetPieces.eventRoleOf(b) });
        ai.setSubTask({ ...next, isComplete: () => true });
    }
    SetPieces.logSetPiece({ id: fake.id, kind, venue: 'test', x: 0, z: 0, level: 0, start: 1, end: 2, outcome: 'done', roles: 1 });
    check('the log keeps what ran', SetPieces.setPieceLog.some(e => e.id === fake.id && e.outcome === 'done'));
    // (revised by phase 5b's Track D, which filled the stubs: the director's schedule round-trips the store, and a state
    // of another shape is ignored; test/director.test.mjs checks the schedule itself)
    let stubs = true;
    let saved = null;
    try {
        lib.tickDirector();
        lib.tickTrains();
        lib.restoreDirector({ next: 5 });
        lib.restoreDirector({ v: 1, next: 4321, recent: ['test_venue'], last: 'clan_walk' });
        saved = lib.exportDirector();
        stubs = saved !== null && saved.v === 1 && Math.abs(saved.next - 4321) <= 1 && saved.recent.includes('test_venue') && saved.last === 'clan_walk';
    } catch (err) {
        stubs = false;
        saved = String(err);
    }
    check("the director and the trains tick; the director's schedule round-trips the store (Track D's)", stubs, saved);
    check('the session left of a bot online (play ticks), Infinity for a name the pool does not hold', BotManager.sessionLeftOf(c.username) > 0 && Number.isFinite(BotManager.sessionLeftOf(c.username)) && BotManager.sessionLeftOf('nobody_here') === Infinity, BotManager.sessionLeftOf(c.username));
    SetPieces.resetSetPiecesForTest();
}

// (the bots stand still from here: their tasks would walk them off and click things)
sim.freezeBots();

// ---- emotes ----
{
    const played = [];
    for (const emote of lib.EMOTES) {
        c.animId = -1;
        const ok = lib.botEmote(c, emote);
        // (the button's script plays it at once; the engine clears animId once the tick's player info is sent)
        const seq = lib.SeqType.getId(`emote_${emote}`);
        played.push({ emote, ok, anim: seq !== -1 && c.animId === seq });
        run(5);
    }
    check("all twelve of the controls tab's emotes, each playing its own animation", played.length === 12 && played.every(p => p.ok && p.anim), played.filter(p => !p.ok || !p.anim));
    c.modalMain = 0;
    const withScreen = lib.botEmote(c, 'clap');
    c.modalMain = -1;
    check('no emote with a screen open', withScreen === false);
}

// ---- crown ----
{
    const rights = [];
    lib.sayListeners.push(p => rights.push([p.username, p.chatRights]));
    // (the others: a bot without the crown; since phase 5b's Track A the world has its own mod, port/BotModBot's pick)
    const other = bots.find(p => p !== a && p.staffModLevel === 0) ?? b;
    const was = a.staffModLevel;
    a.staffModLevel = 1;
    lib.botSay(a, 'please dont spam', undefined, 'mod');
    lib.botSay(other, 'hi', undefined, 'idle');
    a.staffModLevel = was;
    const of = n => rights.find(([u]) => u === n)?.[1];
    check("a bot's line carries its crown: the player-mod bot's silver crown (staff level 1), none for the others", of(a.username) === 1 && of(other.username) === 0, rights);
}

// ---- the human's lines ----
{
    const human = sim.human;
    sim.teleportHuman(b.x + 1, b.z, b.level);
    run(2);
    const heard = [];
    const said = [];
    // (an answer to the human: a reply, or a line to it; the world's own chatter meanwhile, "bored lol" and a "same" to it,
    // is none: phase 5b's Track D revised this, as with other dice two such lines fell in the 30 ticks)
    lib.sayListeners.push((p, text, kind, to) => said.push([p.username, text, kind, to?.username ?? null]));
    lib.humanLineListeners.push((h, text) => {
        heard.push(text);
        return text.includes('stake');
    });
    const n0 = said.length;
    lib.BotChat.onPublicMessage(human, `stake ${b.displayName}?`);
    run(30);
    const answers = said.slice(n0).filter(([, , kind, to]) => kind === 'reply' || to === human.username);
    check("a set piece's listener hears the human's line first, and one it answers is no other bot's to answer", heard.includes(`stake ${b.displayName}?`) && answers.length === 0, { heard, answers, said: said.slice(n0) });
    lib.humanLineListeners.length = 0;
}

// ---- screens ----
{
    const tomato = lib.ObjType.getId('rotten_tomato');
    lib.giveItems(a, [[tomato, 1]], false);
    b.teleJump(a.x + 2, a.z, a.level);
    run(2);
    const used = lib.useItemOnPlayer(a, b, tomato);
    const set = a.target === b && a.targetOp === lib.ServerTriggerType.APPLAYERU;
    const thrown = run(15, () => !a.getInventory(lib.InvType.INV).hasAt?.(0, tomato) && !(a.getInventory(lib.InvType.INV).getItemCount(tomato) > 0));
    check('an item used on a player, as the client clicks it: a rotten tomato thrown (274 takes it from the pack)', used && set && thrown > 0, { used, set, thrown });
}

check('no bot errors', BotManager.stats().errors === 0, BotManager.stats().errors);

let failed = 0;
for (const c2 of checks) {
    if (!c2.ok) failed++;
    out(`${c2.ok ? 'ok  ' : 'FAIL'} ${c2.name}${c2.detail ? ` — ${c2.detail}` : ''}`);
}
out(`setpieces: ${checks.length - failed} of ${checks.length} passed`);
process.exit(failed ? 1 : 0);
