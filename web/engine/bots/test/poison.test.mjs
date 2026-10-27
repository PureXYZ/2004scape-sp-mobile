#!/usr/bin/env node
// Death cures poison (content patch 0005, bots/content): the real rev-274 world headless, first with the vanilla
// scripts, then with the compiled content overlay put in place by the runtime's own overlay.ts. Checks:
//   - the window: a poison splat that kills leaves the death for the next tick (it was the queue's last entry), and a
//     poisonous NPC's hit in that tick queues poison_player behind the death; the vanilla scripts poison the player
//     again at Lumbridge (what 0005 fixes), the overlay's clear_poison drops it: no "You have been poisoned!", no
//     poison splat after the respawn
//   - a poison hit queued while the death animation plays: the same
//   - a poisoned player who dies is cured (both)
//
//   node --expose-gc web/engine/bots/test/poison.test.mjs [--debug]
//
// Exit code 1 if a check fails. Nothing is written outside build/tmp/bots.
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, CONTENT_DIR, ENGINE_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { compileBotScripts } from '../content/compile.mjs';

const DEBUG = process.argv.includes('--debug');
const out = (s = '') => process.stdout.write(s + '\n');
const t0 = performance.now();

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

// ---- the world, then the overlay ----
const overlay = await compileBotScripts({ engineDir: ENGINE_DIR, contentDir: CONTENT_DIR, log: () => {} });
const scriptsBin = new Uint8Array(fs.readFileSync(overlay.file));
const scriptDat = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.dat')));
const scriptIdx = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.idx')));
const engineDir = prepareEngineClone('poison', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const P = await importTs(path.join(BOTS_DIR, 'test/lib/poison.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, PlayerStat, ScriptProvider, VarPlayerType, PlayerQueueType } = P;

const sim = await P.Sim.create({ bots: 1, members: true, debug: DEBUG, spawnPerTick: 1 });
const FIELD = [3240, 3276]; // Lumbridge's cow field: single-way, open
const LUMBRIDGE = [3221, 3218]; // the death's respawn (0_50_50_21_18)
sim.addHuman(FIELD[0], FIELD[1], 0);
const human = sim.human;
for (let i = 0; i < 5; i++) sim.tick();
sim.freezeBots();
for (const bot of sim.bots()) bot.teleJump(3200, 3200, 0);

const messages = [];
const messageGame = human.messageGame.bind(human);
human.messageGame = text => {
    messages.push(text);
    return messageGame(text);
};
const splats = []; // the hitmark types the human takes
const applyDamage = human.applyDamage.bind(human);
human.applyDamage = (amount, type) => {
    splats.push(type);
    return applyDamage(amount, type);
};
const HITMARK_POISON = 2;

const POISON = VarPlayerType.getByName('poison').id;
const DEATH = VarPlayerType.getByName('death').id;
const script = name => {
    const s = ScriptProvider.getByName(name);
    if (!s) throw new Error(`no ${name}`);
    return s;
};
const queue = (name, ...args) => human.enqueueScript(script(name), PlayerQueueType.NORMAL, 0, args);
const queued = name => [...human.queue.all()].some(r => r.script.id === script(name).id);
const atLumbridge = () => Math.abs(human.x - LUMBRIDGE[0]) <= 3 && Math.abs(human.z - LUMBRIDGE[1]) <= 3;

/** The human at the field, full Hitpoints, not poisoned, nothing queued or timed. */
function stage() {
    human.setVar(POISON, 0);
    human.clearTimer(script('[timer,poison]').id);
    for (const name of ['[queue,poison_player]', '[queue,poison_damage]']) human.unlinkQueuedScript(script(name).id);
    sim.teleportHuman(FIELD[0], FIELD[1], 0);
    human.setLevel(PlayerStat.HITPOINTS, 30);
    for (let i = 0; i < 3; i++) sim.tick();
}

/** Ticks until the death is over (the human at Lumbridge), then 40 more: what the respawned human got. */
function afterRespawn(m0) {
    for (let i = 0; i < 30 && !atLumbridge(); i++) sim.tick();
    const respawned = atLumbridge();
    const s0 = splats.length;
    let poison = human.getVar(POISON);
    for (let i = 0; i < 40; i++) {
        sim.tick();
        poison = Math.max(poison, human.getVar(POISON));
    }
    const said = messages.slice(m0);
    const dead = said.indexOf('Oh dear you are dead!');
    return {
        respawned,
        poison,
        poisonedAgain: dead >= 0 && said.slice(dead + 1).includes('You have been poisoned!'),
        poisonSplats: splats.slice(s0).filter(t => t === HITMARK_POISON).length,
        said
    };
}
const clean = r => r.respawned && r.poison === 0 && !r.poisonedAgain && r.poisonSplats === 0;

/** The window: poisoned at 3 Hitpoints, a poison splat kills; the death waits a tick; a poisonous NPC hits in it. */
function windowCase() {
    stage();
    const m0 = messages.length;
    queue('[queue,poison_player]', 27);
    sim.tick();
    human.levels[PlayerStat.HITPOINTS] = 3;
    queue('[queue,poison_damage]', 6); // the poison timer's splat, the queue's last entry
    sim.tick();
    const waiting = human.levels[PlayerStat.HITPOINTS] === 0 && queued('[queue,player_death]') && human.getVar(DEATH) === 0;
    queue('[queue,poison_player]', 27); // a poison spider's hit: the NPCs move before the players, %death still 0
    return { waiting, ...afterRespawn(m0) };
}

/** A poison hit queued while the death animation plays. */
function duringCase() {
    stage();
    const m0 = messages.length;
    queue('[queue,player_death]', 0);
    sim.tick();
    const dying = human.delayed && human.getVar(DEATH) === 1;
    queue('[queue,poison_player]', 30);
    return { dying, ...afterRespawn(m0) };
}

/** Poisoned, then dies: cured. */
function controlCase() {
    stage();
    const m0 = messages.length;
    queue('[queue,poison_player]', 30);
    sim.tick();
    const poisoned = human.getVar(POISON) === 30;
    queue('[queue,player_death]', 0);
    return { poisoned, ...afterRespawn(m0) };
}
const brief = r => ({ respawned: r.respawned, poison: r.poison, poisonedAgain: r.poisonedAgain, poisonSplats: r.poisonSplats, said: r.said });

// ---- the vanilla scripts: the bug is there (the checks below can fail) ----
{
    const w = windowCase();
    check('the window: a poison splat that kills leaves the death for the next tick (%death still 0)', w.waiting, brief(w));
    check('vanilla 274 scripts: a poison hit in that tick poisons the player again at Lumbridge (what patch 0005 fixes)', w.respawned && w.poison > 0 && w.poisonedAgain && w.poisonSplats > 0, brief(w));
    const d = duringCase();
    check('vanilla 274 scripts: a poison hit queued during the death animation comes back at Lumbridge too', d.dying && d.respawned && d.poison > 0 && d.poisonedAgain, brief(d));
}

// ---- the overlay ----
const applied = P.installBotsContent(scriptsBin, scriptDat, scriptIdx);
check(`the overlay is in place (${overlay.scripts.length} scripts), [proc,clear_poison] among them (patch 0005)`, applied === overlay.scripts.length && overlay.patches.some(p => /^0005-poison/.test(p)) && overlay.scripts.some(s => (s.name ?? s) === '[proc,clear_poison]'), { applied, patches: overlay.patches, scripts: overlay.scripts.map(s => s.name ?? s) });
{
    const w = windowCase();
    check('the window: the respawned player is not poisoned (no "You have been poisoned!", no poison splat in 40 ticks)', w.waiting && clean(w), brief(w));
    const d = duringCase();
    check('a poison hit queued during the death animation: not poisoned after the respawn', d.dying && clean(d), brief(d));
    const c = controlCase();
    check('a poisoned player who dies is cured', c.poisoned && clean(c), brief(c));
}
check('no bot errors', P.BotManager.stats().errors === 0, P.BotManager.stats().errors);
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).map(e => e.split('\n')[0]));

out(`  ${checks.filter(c => c.ok).length}/${checks.length} checks passed, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
