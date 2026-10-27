#!/usr/bin/env node
// A bot's arrows in PvP (content patch 0004), in the real rev-274 world on a members world, with the content overlay
// as the runtime installs it. Play-testing: free rune arrows on the ground about Edgeville (a PK ranger's kit is given
// at every restock, and 274 drops 4 in 5 of its arrows under the target, anyone's after 100 ticks). Checks:
//   bot -> human  a ranger bot shooting the human in the Wilderness uses its arrows up: none on the ground, now or after
//                 the 100 ticks a drop is its dropper's alone
//   bot -> bot    the same against another bot
//   human -> bot  the human's arrows drop as before: under the bot, about 4 in 5, theirs
//
//   node web/engine/bots/test/ammo.test.mjs [--ticks=30] [--seed=N] [--debug]
//
// Exit code 1 if a check fails. Nothing is written outside build/tmp/bots.
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, CONTENT_DIR, ENGINE_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { compileBotScripts } from '../content/compile.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const TICKS = Number(args.ticks ?? 30);
const DEBUG = args.debug === 'true';
{
    let s = Number(args.seed ?? 1) >>> 0 || 1;
    Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
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
function check(name, ok, detail = '') {
    checks.push({ name, ok: !!ok, detail });
}

// ---- the world, the overlay ----
const overlay = await compileBotScripts({ engineDir: ENGINE_DIR, contentDir: CONTENT_DIR, log: () => {} });
const scriptsBin = new Uint8Array(fs.readFileSync(overlay.file));
const scriptDat = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.dat')));
const scriptIdx = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.idx')));
const engineDir = prepareEngineClone('ammo', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/ammo.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, InvType, PlayerStat, Fight: F } = lib;

const N = 2;
const sim = await lib.Sim.create({ bots: N, members: true, debug: DEBUG, spawnPerTick: N });
const replaced = lib.installBotsContent(scriptsBin, scriptDat, scriptIdx);
sim.addHuman(3222, 3218, 0);
const human = sim.human;
const tickOnce = () => sim.tick();
while (sim.bots().length < N && World.currentTick < 20) tickOnce();
const [a, b] = sim.bots();
const K = F.pkKitItems(); // (once the configs are loaded)
check('overlay: in place', replaced > 0 && overlay.patches?.includes('0004-pvp-ranged-a-bots-arrows-are-used-up.patch'), `${replaced} scripts replaced; patches ${overlay.patches?.join(', ')}`);

// ---- the stage: both bots' AI off, by Edgeville (Wilderness level 3), the human beside them at the same levels ----
for (const p of [a, b]) {
    sim.botPlayer(p).tick = () => {};
    for (const [stat, level] of [[PlayerStat.ATTACK, 70], [PlayerStat.STRENGTH, 99], [PlayerStat.DEFENCE, 1], [PlayerStat.HITPOINTS, 99], [PlayerStat.RANGED, 99], [PlayerStat.PRAYER, 1], [PlayerStat.MAGIC, 1]]) p.setLevel(stat, level);
}
sim.copyLevels(a);
human.setLevel(PlayerStat.DEFENCE, 1);
human.setLevel(PlayerStat.MAGIC, 1);
human.setLevel(PlayerStat.PRAYER, 1);
const SPOT = [3093, 3540];
const heal = p => (p.levels[PlayerStat.HITPOINTS] = p.baseLevels[PlayerStat.HITPOINTS]);
const wornArrows = p => {
    const it = p.getInventory(InvType.WORN).get(13);
    return it?.id === K.runeArrow ? it.count : 0;
};
/** the magic shortbow and `arrows` rune arrows worn (0: nothing), 274's update_all after (the attack style, the anims) */
const kit = (p, arrows) => {
    const worn = p.getInventory(InvType.WORN);
    const previous = worn.get(3)?.id ?? -1;
    for (let s = 0; s < worn.capacity; s++) worn.set(s, null);
    if (arrows > 0) {
        worn.set(3, { id: K.msb, count: 1 });
        worn.set(13, { id: K.runeArrow, count: arrows });
    }
    lib.refreshWorn(p, previous);
};
/** rune arrows on the ground within 3 zones of the spot (by receiver: 'human', 'bot', 'none') and still to land */
function ground() {
    const by = { human: 0, bot: 0, none: 0 };
    for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
            const zone = World.gameMap.getZone(SPOT[0] + dx * 8, SPOT[1] + dz * 8, 0);
            for (const obj of zone.getAllObjsUnsafe()) {
                if (obj.type !== K.runeArrow || !obj.isActive) continue;
                const who = obj.receiver64 === human.hash64 ? 'human' : obj.receiver64 === a.hash64 || obj.receiver64 === b.hash64 ? 'bot' : 'none';
                by[who] += obj.count;
            }
        }
    }
    let pending = 0;
    for (const r of World.objDelayedQueue.all()) if (r.obj.type === K.runeArrow) pending += r.obj.count;
    return { ...by, pending, total: by.human + by.bot + by.none + pending };
}
/** `shooter` shoots `target` for TICKS ticks (both healed), then the 120 ticks past a drop's 100: what was shot, what lay about */
function shoot(shooter, target, others) {
    for (const p of [a, b, human]) {
        p.clearPendingAction();
        p.clearWaypoints();
    }
    sim.teleportHuman(...(human === target ? SPOT : human === shooter ? [SPOT[0] + 4, SPOT[1]] : [SPOT[0] - 6, SPOT[1]]), 0);
    shooter !== human && shooter.teleJump(SPOT[0] + 4, SPOT[1], 0);
    target !== human && target.teleJump(SPOT[0], SPOT[1], 0);
    for (const p of others) p.teleJump(SPOT[0] - 6, SPOT[1] + 2, 0);
    for (let i = 0; i < 2; i++) tickOnce();
    const before = wornArrows(shooter);
    lib.interactPlayerOp(shooter, target.slot, 2);
    let most = 0;
    for (let t = 0; t < TICKS; t++) {
        tickOnce();
        for (const p of [a, b, human]) heal(p);
        if (shooter.target !== target) lib.interactPlayerOp(shooter, target.slot, 2);
        most = Math.max(most, ground().total);
    }
    shooter.clearPendingAction();
    target.clearPendingAction();
    const shot = before - wornArrows(shooter);
    const during = ground();
    for (let t = 0; t < 120; t++) {
        tickOnce();
        most = Math.max(most, ground().total);
    }
    return { shot, during, after: ground(), most };
}
const show = r => `${r.shot} shot; on the ground at most ${r.most}, after the fight ${JSON.stringify(r.during)}, 120 ticks on ${JSON.stringify(r.after)}`;

// ---- bot -> human ----
{
    kit(a, 200);
    kit(human, 0);
    const r = shoot(a, human, [b]);
    check('bot -> human: a ranger bot\'s arrows are used up, none on the ground (now or once a drop would be anyone\'s)', r.shot >= 5 && r.most === 0, show(r));
}
// ---- bot -> bot ----
{
    kit(a, 200);
    kit(b, 0);
    const r = shoot(a, b, []);
    check('bot -> bot: the same against another bot', r.shot >= 5 && r.most === 0, show(r));
}
// ---- human -> bot ----
{
    kit(human, 200);
    kit(a, 0);
    kit(b, 0);
    const r = shoot(human, a, [b]);
    const landed = r.during.human + r.during.pending;
    check('human -> bot: the human\'s arrows drop under the bot as in 274 (about 4 in 5, theirs)', r.shot >= 5 && landed >= Math.floor(r.shot * 0.5) && landed <= r.shot && r.during.bot === 0 && r.during.none === 0, show(r));
}

check('errors: none (bot errors, console errors)', BotManager.stats().errors === 0 && consoleErrors.length === 0, `${BotManager.stats().errors} bot errors, ${consoleErrors.length} console errors ${consoleErrors.slice(0, 2).join(' | ')}`);

out(`ammo: ${N} bots and the human on a members world, ${TICKS} ticks a fight, seed ${args.seed ?? 1}`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
