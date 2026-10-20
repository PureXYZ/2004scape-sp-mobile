#!/usr/bin/env node
// Teleport spells, alching, wrong turns and law runs (the realism work, phase 5a, Track M: movement and magic; spec
// the research), in the real 274 world (members; the free world in a child process: each world
// needs its own engine). One bot, put where each check needs it, its task replaced by the check's driver:
//   cast        a bot at Draynor bank with Magic 60, laws, fire runes and a staff of air in its bank, walking to Varrock
//               West: it casts the Varrock teleport (the law and the fire out of its bank, its staff of air on for the
//               air), lands within 4 tiles of the landing, the runes gone and 35 XP come, it stands still while the
//               script holds it (no step during the delay), its scimitar back on after; the move marked 'spell'
//   refused     the same, its law gone between the staff and the button: the script refuses, the cast counts as failed,
//               the bot walks on (no second try for the trip)
//   free world  (child process) no Camelot or Ardougne at Magic 99, whatever the trip; Falador's cast works
//   seed        teleporters are the same names every time (about 70 %); with Math.random seeded alike the trips' decisions
//               repeat
//   wrong turn  a walk with wrong turns forced: it heads off the route to a neighbour node, looks round, comes back and
//               gets there; no rescue jump
//   crossing    a bot at Catherby bank bound for Taverley over White Wolf Mountain (no spell): it packs 3-5 food, eats to
//               80 % and waits for 40 % run energy at the bank, then runs
//   alching     a stint at Varrock West: one of each item kept, coins from the spell only (the alch value each), a nature
//               a cast, the staff of fire on and the weapon back; no profit loop: nothing an alcher may alch sells in a
//               274 shop below its alch value, no shop the bots buy at lists natures, the stint opens no shop
//   law run     from Yanille bank: coins out, the guild's door and stairs, laws bought through the shop window, banked
//   RangedMagic no unseen jump after shopping (its source)
//
//   node --expose-gc web/engine/bots/test/teleport.test.mjs [--members=false]
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? 'true']));
const MEMBERS = (args.members ?? 'true') !== 'false';
const out = (s = '') => process.stdout.write(s + '\n');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
const consoleErrors = [];
console.error = (...a) => {
    const text = a.map(String).join(' ');
    if (!text.includes('ExperimentalWarning')) consoleErrors.push(text.slice(0, 300));
};
let seed = 5;
Math.random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
};

const engineDir = prepareEngineClone(`teleport-${MEMBERS ? 'p2p' : 'f2p'}`, simWorldConfig({ members: MEMBERS }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/teleport.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, Items, InvType, ObjType, Teleport: T } = lib;
const sim = await lib.Sim.create({ bots: 1, members: MEMBERS, debug: false });
sim.addHuman(3100, 3300, 0);
for (let i = 0; i < 40 && sim.bots().length < 1; i++) sim.tick();
for (let i = 0; i < 3; i++) sim.tick();
const bot = sim.bots()[0];
const BANK = InvType.getId('bank');
const name = id => (id === -1 ? '-' : ObjType.get(id).debugname);
const count = (inv, id) => {
    let n = 0;
    for (let i = 0; inv && i < inv.capacity; i++) if (inv.get(i)?.id === id) n += inv.get(i).count;
    return n;
};
const pack = () => bot.getInventory(InvType.INV);
const bank = () => bot.getInventory(BANK);
const weapon = () => bot.getInventory(InvType.WORN).get(3)?.id ?? -1;
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

/** the bot at (x, z) with Magic `magic` (its XP too), an empty pack and these in its bank; no task (`drive` drives it) */
function setup(x, z, magic, banked = [], level = 0) {
    lib.BotPlayer.prototype.tick = function () {};
    bot.clearWaypoints();
    bot.clearPendingAction();
    bot.teleJump(x, z, level);
    sim.tick();
    bot.stats[6] = lib.getExpByLevel(magic);
    bot.baseLevels[6] = magic;
    bot.levels[6] = magic;
    bot.levels[3] = bot.baseLevels[3];
    bot.runenergy = 10000;
    for (const inv of [pack(), bank()]) for (let i = 0; i < inv.capacity; i++) inv.delete(i);
    for (const [id, n] of banked) bank().add(id, n);
}

/** each tick: the cast hold, else a walk to (x, z, level) */
function walker(x, z, level = 0, before = () => {}) {
    lib.BotPlayer.prototype.tick = function () {
        before(this.player);
        if (T.isCastHeld(this.player)) return;
        lib.walkTo(this.player, x, z, level);
    };
}

if (MEMBERS) {
    // ---- cast ----
    {
        T.setTeleportRatesForTest({ teleporter: true, trip: 1 });
        setup(3092, 3245, 60, [[Items.LAW_RUNE, 20], [Items.FIRE_RUNE, 20], [Items.STAFF_OF_AIR, 1]]);
        const scimitar = weapon();
        const marks = lib.teleportStats.marks.length;
        const xp = bot.stats[6];
        const plan = T.teleportPlan(bot, 3185, 3436, 0);
        walker(3185, 3436);
        const trace = [];
        let clicked = -1;
        let jumped = -1;
        let movedWhileDelayed = false;
        let prev = [bot.x, bot.z];
        for (let t = 0; t < 30; t++) {
            sim.tick();
            const at = [bot.x, bot.z];
            trace.push({ t, at, delayed: bot.delayed, weapon: name(weapon()) });
            if (clicked < 0 && bot.delayed) clicked = t;
            if (clicked >= 0 && jumped < 0 && cheb(at, prev) > 10) jumped = t;
            if (bot.delayed && cheb(at, prev) > 0 && cheb(at, prev) <= 2) movedWhileDelayed = true;
            prev = at;
        }
        const landing = T.SPELLS.find(s => s.key === 'varrock').landing;
        const landed = jumped >= 0 ? trace[jumped].at : null;
        check('cast: a teleporter with Magic 60 and the runes in its bank casts Varrock on the way from Draynor to Varrock West (a trip of 150+ by the graph, the landing near)', plan.verdict === 'cast' && plan.reason === 'varrock' && clicked >= 0, { plan: [plan.verdict, plan.reason, plan.trip.tiles, plan.rest], clicked });
        check('cast: it lands within 4 tiles of the landing, 2-4 ticks after the click', landed && cheb(landed, landing) <= 4 && jumped - clicked >= 2 && jumped - clicked <= 4, { landed, landing, clicked, jumped });
        check('cast: the runes go (a law, a fire; its staff of air pays the air) and the XP comes (35)', count(bank(), Items.LAW_RUNE) + count(pack(), Items.LAW_RUNE) === 19 && count(bank(), Items.FIRE_RUNE) + count(pack(), Items.FIRE_RUNE) === 19 && bot.stats[6] - xp >= 350, { laws: count(bank(), Items.LAW_RUNE) + count(pack(), Items.LAW_RUNE), fire: count(bank(), Items.FIRE_RUNE) + count(pack(), Items.FIRE_RUNE), xp: (bot.stats[6] - xp) / 10 });
        check('cast: no step while the spell\'s script holds the bot (its delay)', !movedWhileDelayed && clicked >= 0 && trace.slice(clicked, jumped).every(e => e.at[0] === trace[clicked].at[0] && e.at[1] === trace[clicked].at[1]), trace.slice(Math.max(0, clicked - 1), jumped + 1).map(e => `${e.at}${e.delayed ? 'd' : ''}`).join(' '));
        check('cast: the staff of air on for the cast, its scimitar back on after; the move marked a spell (the runner\'s H21)', trace.some(e => e.weapon === 'staff_of_air') && weapon() === scimitar && lib.teleportStats.marks.slice(marks).some(m => m.cls === 'spell' && m.name === bot.username.toLowerCase()), { weapons: [...new Set(trace.map(e => e.weapon))], now: name(weapon()) });
        check('cast: then it walks on from the landing to Varrock West', cheb([bot.x, bot.z], [3185, 3436]) < cheb(landed ?? [0, 0], [3185, 3436]), [bot.x, bot.z]);
    }

    // ---- refused ----
    {
        setup(3092, 3245, 60, [[Items.LAW_RUNE, 5], [Items.FIRE_RUNE, 5], [Items.STAFF_OF_AIR, 1]]);
        const before = { failed: T.teleportSpellStats.failed, casts: T.teleportSpellStats.casts, refused: T.teleportSpellStats.failReasons.refused ?? 0 };
        // (its law leaves the pack between the staff going on and the button: the script refuses, "not enough Law Runes")
        let took = false;
        // (Varrock East: the cast check's trip to Varrock West is still under way, decided)
        walker(3253, 3420, 0, p => {
            if (!took && count(pack(), Items.LAW_RUNE) > 0) {
                pack().remove(Items.LAW_RUNE, count(pack(), Items.LAW_RUNE));
                took = true;
            }
        });
        const start = [bot.x, bot.z];
        for (let t = 0; t < 30; t++) sim.tick();
        const s = T.teleportSpellStats;
        check('refused: a cast the script refuses (no law in the pack after all) counts as failed, and the bot walks instead (no second try)', took && s.failed === before.failed + 1 && (s.failReasons.refused ?? 0) === before.refused + 1 && s.casts === before.casts + 1 && cheb([bot.x, bot.z], start) >= 8 && cheb([bot.x, bot.z], start) < 80, { took, failed: s.failed - before.failed, casts: s.casts - before.casts, reasons: s.failReasons, walked: cheb([bot.x, bot.z], start), at: [bot.x, bot.z] });
        check('refused: its scimitar back on (the staff came off)', name(weapon()) !== 'staff_of_air', name(weapon()));
    }

    // ---- Ardougne (members; 274 also asks that Plague City's scroll was read: bots log in with it read) ----
    {
        T.setTeleportRatesForTest({ teleporter: true, trip: 1 });
        setup(2725, 3493, 60, [[Items.LAW_RUNE, 10], [Items.WATER_RUNE, 10]]);
        const plan = T.teleportPlan(bot, 2655, 3283, 0);
        walker(2655, 3283);
        const laws = count(bank(), Items.LAW_RUNE);
        let landed = null;
        let prev = [bot.x, bot.z];
        for (let t = 0; t < 20 && !landed; t++) {
            sim.tick();
            if (cheb([bot.x, bot.z], prev) > 10) landed = [bot.x, bot.z];
            prev = [bot.x, bot.z];
        }
        check('Ardougne: from Seers\' bank to Ardougne South the Ardougne teleport (two waters, two laws) lands in the market (Plague City done and its scroll read at login)', plan.reason === 'ardougne' && landed && cheb(landed, T.SPELLS.find(sp => sp.key === 'ardougne').landing) <= 4 && laws - (count(bank(), Items.LAW_RUNE) + count(pack(), Items.LAW_RUNE)) === 2, { plan: [plan.verdict, plan.reason], landed, varp: bot.getVar?.(165) });
        T.setTeleportRatesForTest(null);
    }

    // ---- seed ----
    {
        T.setTeleportRatesForTest(null);
        const names = Array.from({ length: 1000 }, (_, i) => `seed name ${i}`);
        const first = names.map(n => T.isTeleporter(n));
        Math.random();
        const again = names.map(n => T.isTeleporter(n));
        const share = first.filter(Boolean).length / names.length;
        check('seed: the same names are teleporters every time, about 70 % (the rest save their laws)', JSON.stringify(first) === JSON.stringify(again) && share > 0.65 && share < 0.75, `${(100 * share).toFixed(1)} %`);
        // the trip's own dice: Math.random seeded alike, the same decisions
        setup(3092, 3245, 60, [[Items.LAW_RUNE, 20], [Items.FIRE_RUNE, 20], [Items.EARTH_RUNE, 20], [Items.WATER_RUNE, 20], [Items.STAFF_OF_AIR, 1]]);
        T.setTeleportRatesForTest({ teleporter: true });
        const dests = [[3185, 3436], [2965, 3380], [3222, 3218], [2757, 3480], [3253, 3420], [2662, 3305]];
        const run = s0 => {
            seed = s0;
            return dests.map(([x, z]) => {
                const p = T.teleportPlan(bot, x, z, 0);
                return `${p.verdict}:${p.reason}`;
            });
        };
        const a = run(11);
        const b = run(11);
        check('seed: with the dice seeded alike, the trips\' decisions repeat (and the 85 % trip dice walk now and then)', JSON.stringify(a) === JSON.stringify(b), a.join(' '));
        T.setTeleportRatesForTest(null);
    }

    // ---- wrong turn ----
    {
        setup(3222, 3218, 1, []);
        lib.setWrongTurnRateForTest(1000);
        const w0 = { ...lib.wrongTurnStats };
        const jumps0 = lib.teleportStats.jumps;
        const dest = [3013, 3355];
        walker(dest[0], dest[1]);
        let arrived = -1;
        let farthestOff = 0;
        let still = 0;
        let maxStill = 0;
        let prev = [bot.x, bot.z];
        for (let t = 0; t < 900 && arrived < 0; t++) {
            sim.tick();
            const at = [bot.x, bot.z];
            if (cheb(at, prev) === 0) maxStill = Math.max(maxStill, ++still);
            else still = 0;
            prev = at;
            if (lib.wrongTurnStats.turns > w0.turns && lib.wrongTurnStats.back === w0.back) farthestOff = Math.max(farthestOff, cheb(at, dest));
            if (cheb(at, dest) <= 3) arrived = t;
        }
        const w = lib.wrongTurnStats;
        lib.setWrongTurnRateForTest(1);
        check('wrong turn: a walk of 80+ tiles (Lumbridge to Falador East) takes its wrong turn: off the route to a neighbour node, a look round, back on the route', w.walks > w0.walks && w.turns === w0.turns + 1 && w.back === w0.back + 1 && maxStill >= 2, { walks: w.walks - w0.walks, turns: w.turns - w0.turns, back: w.back - w0.back, maxStill });
        check('wrong turn: and still gets there, with no rescue jump', arrived >= 0 && lib.teleportStats.jumps === jumps0, { arrived, jumps: lib.teleportStats.jumps - jumps0 });
    }

    // ---- crossing (White Wolf Mountain on foot) ----
    {
        // (the scene's own dice, seeded here: the world's draws before it (the planner's picks at the logins, more since the
        // variety work's round 2 errands) made this bot's careless roll come up, and it left unprepared)
        seed = 5;
        T.setTeleportRatesForTest({ teleporter: true, trip: 1 });
        setup(2809, 3440, 1, [[Items.LOBSTER, 10]]);
        bot.levels[3] = Math.max(1, Math.floor(bot.baseLevels[3] / 2));
        bot.runenergy = 3000;
        const c0 = { ...T.teleportSpellStats.crossings };
        const plan = T.teleportPlan(bot, 2895, 3443, 0);
        walker(2895, 3443);
        let left = -1;
        let hpAtLeave = 0;
        let runAtLeave = 0;
        let foodAtLeave = 0;
        let ran = false;
        // (its energy and Hitpoints the last tick it stood at the bank: running off spends some)
        let standing = { hp: 0, run: 0 };
        let prev = [bot.x, bot.z];
        for (let t = 0; t < 900; t++) {
            sim.tick();
            if (left < 0 && cheb([bot.x, bot.z], prev) === 0) standing = { hp: bot.levels[3] / bot.baseLevels[3], run: bot.runenergy };
            prev = [bot.x, bot.z];
            if (left < 0 && cheb([bot.x, bot.z], [2809, 3440]) > 8) {
                left = t;
                hpAtLeave = standing.hp;
                runAtLeave = standing.run;
                foodAtLeave = count(pack(), Items.LOBSTER);
            }
            if (left >= 0 && bot.run === 1) ran = true;
            if (left >= 0 && t - left > 40) break;
        }
        const c = T.teleportSpellStats.crossings;
        check('crossing: Catherby to Taverley is a multi-combat route that hunts a level-3 (White Wolf Mountain)', plan.trip.danger && plan.trip.multi, plan.trip);
        check('crossing: at its bank it packs 3-5 food, eats to 80 % and waits for 40 % run energy, then runs across', c.prepared === c0.prepared + 1 && left > 0 && hpAtLeave >= 0.8 && runAtLeave >= 4000 && foodAtLeave >= 1 && ran, { left, hp: hpAtLeave.toFixed(2), run: runAtLeave, food: foodAtLeave, ran, careless: c.careless - c0.careless });
        T.setTeleportRatesForTest(null);
    }

    // ---- alching ----
    {
        setup(3185, 3436, 60, [[Items.NATURE_RUNE, 20], [Items.STAFF_OF_FIRE, 1], [Items.YEW_LONGBOW, 6], [Items.ADAMANT_SCIMITAR, 2], [Items.COINS, 100]]);
        // (its weapon one it could alch, two spares in the bank: the one it wears goes in its pack under the staff of fire
        // and back on after, never alched; one spare is, one kept)
        bot.getInventory(InvType.WORN).set(3, { id: Items.ADAMANT_SCIMITAR, count: 1 });
        bot.stats[0] = lib.getExpByLevel(40);
        bot.baseLevels[0] = bot.levels[0] = 40;
        const scimitar = weapon();
        const a0 = { ...lib.Alch.alchStats };
        const may = lib.BotAlch.mayAlch(bot);
        const task = new lib.Alch.AlchTask(lib.TRADE_BANKS.find(b => b.key === 'varrock_west'), World.currentTick + 900);
        lib.BotPlayer.prototype.tick = function () {
            if (!task.isComplete(this.player)) task.tick(this.player);
        };
        let shopOpened = false;
        let coinsDown = false;
        let lastCoins = count(pack(), Items.COINS) + count(bank(), Items.COINS);
        let staffOn = false;
        for (let t = 0; t < 400 && !task.isComplete(bot); t++) {
            sim.tick();
            if (lib.openShopStock(bot)) shopOpened = true;
            const coins = count(pack(), Items.COINS) + count(bank(), Items.COINS);
            if (coins < lastCoins) coinsDown = true;
            lastCoins = coins;
            if (weapon() === Items.STAFF_OF_FIRE) staffOn = true;
        }
        const a = lib.Alch.alchStats;
        const value = lib.Alch.alchValue(Items.YEW_LONGBOW);
        const spareValue = lib.Alch.alchValue(Items.ADAMANT_SCIMITAR);
        check('alching: a Magic-60 bot with natures, a staff of fire, its yew longbows and a spare scimitar may alch; a stint at Varrock West alchs all but one of each, a nature each', may && task.isComplete(bot) && a.casts - a0.casts === 6 && count(bank(), Items.YEW_LONGBOW) === 1 && count(bank(), Items.ADAMANT_SCIMITAR) === 1 && count(bank(), Items.NATURE_RUNE) === 14, { may, casts: a.casts - a0.casts, bows: count(bank(), Items.YEW_LONGBOW), spares: count(bank(), Items.ADAMANT_SCIMITAR), natures: count(bank(), Items.NATURE_RUNE) });
        check('alching: the coins are the spell\'s, the alch value each (0.6 x the value), and never fewer at any tick (it buys nothing, opens no shop)', count(bank(), Items.COINS) + count(pack(), Items.COINS) === 100 + 5 * value + spareValue && !coinsDown && !shopOpened, { coins: count(bank(), Items.COINS) + count(pack(), Items.COINS), each: value, spare: spareValue, coinsDown, shopOpened });
        check('alching: its staff of fire on for the stint, the weapon it wore (one it could alch) back on after, never alched', staffOn && weapon() === scimitar && scimitar === Items.ADAMANT_SCIMITAR && lib.Alch.isAlchable(scimitar), { staffOn, now: name(weapon()) });
        // no profit loop: an alcher never buys (the stint above: no coin down, no shop opened; AlchTask's source opens no
        // shop window and talks to no shopkeeper), natures in no shop the bots buy at; never coins, runes, any staff
        // (battlestaves and mystic staves too), food, tools or arrows. (Not every 274 shop sells at the item's value or
        // more: Irksol sells ruby rings at about half; no bot buys there, and an alcher buys nothing anywhere.)
        let alchable = 0;
        const staves = [];
        for (let id = 0; id < ObjType.count; id++) {
            if (!lib.Alch.isAlchable(id)) continue;
            alchable++;
            if ((ObjType.get(id).debugname ?? '').includes('staff')) staves.push(name(id));
        }
        const alchSource = fs.readFileSync(path.join(BOTS_DIR, 'src/tasks/AlchTask.ts'), 'utf8');
        const buys = ['openShopStock', 'buyFromOpenShop', 'interactNpcOp', 'ShopTripTask'].filter(w => alchSource.includes(w));
        const natureShops = Object.entries(lib.Shops).filter(([, shop]) => shop.stock.some(s => s.itemId === Items.NATURE_RUNE)).map(([k]) => k);
        const never = [Items.COINS, Items.NATURE_RUNE, Items.LAW_RUNE, Items.FIRE_RUNE, Items.STAFF_OF_FIRE, Items.STAFF_OF_AIR, ObjType.getId('battlestaff'), ObjType.getId('mystic_fire_staff'), Items.LOBSTER, Items.SHARK, Items.RUNE_PICKAXE ?? -1, Items.RUNE_AXE ?? -1, Items.BRONZE_ARROW].filter(id => id !== -1 && lib.Alch.isAlchable(id));
        check('alching: no profit loop: an alcher buys nothing (no shop in its source), natures in no shop the bots buy at, never coins, runes, a staff of any kind, food, tools or arrows', buys.length === 0 && natureShops.length === 0 && never.length === 0 && staves.length === 0 && alchable > 100, { alchable, buys, natureShops, never: never.map(name), staves: staves.slice(0, 5) });
    }

    // ---- law run ----
    {
        T.setTeleportRatesForTest({ teleporter: true, trip: 1 });
        setup(2612, 3093, 70, [[Items.COINS, 10000], [Items.LAW_RUNE, 2]]);
        const jumps0 = lib.teleportStats.jumps;
        const task = new lib.Law.LawTripTask(25);
        lib.BotPlayer.prototype.tick = function () {
            if (!task.isComplete(this.player)) task.tick(this.player);
        };
        let upstairs = false;
        let shop = false;
        for (let t = 0; t < 400 && !task.isComplete(bot); t++) {
            sim.tick();
            if (bot.level === 1) upstairs = true;
            if (lib.openShopStock(bot)) shop = true;
        }
        const coins = count(bank(), Items.COINS) + count(pack(), Items.COINS);
        check('law run: from Yanille bank up the Wizards\' Guild\'s stairs (Magic 70 at its doors), 25 laws through the shop window (about their value, 40 gp, each), banked at Yanille; no jump', task.isComplete(bot) && upstairs && shop && count(bank(), Items.LAW_RUNE) === 27 && coins < 10000 - 25 * 30 && coins > 10000 - 25 * 100 && lib.teleportStats.jumps === jumps0 && bot.level === 0, { done: task.isComplete(bot), upstairs, shop, laws: count(bank(), Items.LAW_RUNE), spent: 10000 - coins, jumps: lib.teleportStats.jumps - jumps0 });
        T.setTeleportRatesForTest(null);
    }

    // ---- the new bots' rune seed (port/BotAge.magicKit) ----
    {
        const kit = lib.magicKit('kit check', 'experienced', Object.assign(new Array(21).fill(1), { 6: 60, 9: 72 }), true);
        const ids = kit.map(([id]) => id);
        const low = lib.magicKit('kit check', 'novice', Object.assign(new Array(21).fill(1), { 6: 20 }), true);
        const again = lib.magicKit('kit check', 'experienced', Object.assign(new Array(21).fill(1), { 6: 60, 9: 72 }), true);
        check('seed: a new bot of Magic 60 gets laws, fire, earth and water, natures, a staff of fire and yew longbows to alch (its Fletching 72); none under Magic 25; the same for the same name; no air runes (its staff of air)', [Items.LAW_RUNE, Items.FIRE_RUNE, Items.EARTH_RUNE, Items.WATER_RUNE, Items.NATURE_RUNE, Items.STAFF_OF_FIRE, Items.YEW_LONGBOW].every(id => ids.includes(id)) && !ids.includes(Items.AIR_RUNE) && low.length === 0 && JSON.stringify(kit) === JSON.stringify(again), kit.map(([id, n]) => `${name(id)} ${n}`).join(', '));
    }

    // ---- RangedMagic: no unseen jump after shopping ----
    {
        const src = fs.readFileSync(path.join(BOTS_DIR, 'src/tasks/RangedMagicTask.ts'), 'utf8');
        const calls = [...src.matchAll(/botTeleport\(([^)]*)\)/g)].map(m => m[1]);
        check('RangedMagic: no unseen jump after its shopping (its only rescue jump is a dungeon\'s way in without a ladder)', !src.includes('_shouldTeleportAfterShop') && calls.every(c => c.includes("'dungeon'")), calls.join(' | '));
    }
} else {
    // ---- free world ----
    const spells = (() => {
        setup(3092, 3245, 99, []);
        return T.spellsFor(bot).map(s => s.key);
    })();
    check('free world: at Magic 99 no Camelot or Ardougne (members spells: 274 refuses them)', spells.join(',') === 'varrock,lumbridge,falador', spells.join(','));
    T.setTeleportRatesForTest({ teleporter: true, trip: 1 });
    setup(3092, 3245, 99, [[Items.LAW_RUNE, 50], [Items.AIR_RUNE, 500], [Items.FIRE_RUNE, 50], [Items.WATER_RUNE, 50], [Items.EARTH_RUNE, 50]]);
    const picked = new Set();
    for (const [x, z] of [[3185, 3436], [2965, 3380], [3222, 3218], [2945, 3368], [3013, 3355], [3093, 3491], [3253, 3420], [3269, 3163], [3045, 3236]]) {
        const p = T.teleportPlan(bot, x, z, 0);
        picked.add(`${p.verdict}:${p.reason}`);
    }
    check('free world: trips from Draynor to the free towns pick only free spells', ![...picked].some(k => k.includes('camelot') || k.includes('ardougne')) && [...picked].some(k => k.startsWith('cast:')), [...picked].join(' '));
    setup(3092, 3245, 60, [[Items.LAW_RUNE, 5], [Items.WATER_RUNE, 5], [Items.AIR_RUNE, 30]]);
    walker(2946, 3368);
    const xp = bot.stats[6];
    let landed = null;
    let prev = [bot.x, bot.z];
    for (let t = 0; t < 20 && !landed; t++) {
        sim.tick();
        if (cheb([bot.x, bot.z], prev) > 10) landed = [bot.x, bot.z];
        prev = [bot.x, bot.z];
    }
    check('free world: the Falador teleport from Draynor to Falador West works (air runes, no staff)', landed && cheb(landed, T.SPELLS.find(s => s.key === 'falador').landing) <= 4 && bot.stats[6] - xp >= 480, { landed, xp: (bot.stats[6] - xp) / 10 });
    T.setTeleportRatesForTest(null);
}

check('errors: none', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

let failed = 0;
for (const c of checks) {
    if (!c.ok) failed++;
    out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
out(`teleport (${MEMBERS ? 'members' : 'free'} world): ${checks.length - failed} of ${checks.length} passed`);
if (MEMBERS) {
    const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--members=false'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    for (const l of `${child.stdout ?? ''}`.split('\n').filter(l => l && !l.includes('ExperimentalWarning'))) out(l);
    if (child.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
