#!/usr/bin/env node
// PK tactics (port/BotPkFight; play-testing notes on the Edgeville PKers), in the real rev-274 world on a
// members world:
//   1. the kits: a melee PKer has no bow and a dragon dagger (p), longsword or mace to switch to; a ranger the magic
//      shortbow, rune arrows, a dragon dagger (p) and no scimitar; never a dragon battleaxe special; a free world's
//      kit only free items (a rune 2h sword after a scimitar); deep PKers carry a way out more often than the edge's
//   2. the KO switch through the game's own scripts: the dragon dagger's special on the scimitar's tick (274's
//      %action_delay), again while the target is in reach and the bar has the energy, the scimitar back on after; a
//      rune 2h sword's hit 4 ticks after the scimitar's, not 7
//   3. potions through the game's Drink: a dose a tick, the lowest vial first, 274's boosts; none once boosted
//   4. eating: not at high Hitpoints, at its own line, sooner against a dragon dagger in the target's hand
//   5. getting out: low and out of food it leaves (on foot, or by its teleport), not with the target in its KO reach;
//      the glory's Rub lands it at Edgeville (a charge gone), the Varrock teleport in Varrock (a law gone)
//   6. fights: Edgeville PKers fighting each other for a while: potions, specials (none a dragon battleaxe's), KO
//      switches on the fast tick, escapes as well as deaths; (round 2) the boost prayers on, a PJer watching fights
// Round 2 (the second round of notes): 1-Attack rangers in the kits; the melee boost prayers through the
// prayer tab (all fight long, or for the KO; none for a ranger), a prayer potion's sip; PJing: a PJer waits by a fight
// and jumps the one left once 274's single-way lock (8 ticks) is over, and the game takes the attack
//
//   node web/engine/bots/test/pkfight.test.mjs [--ticks=2400] [--seed=N] [--debug] [--deaths] [--eatlog=NAME]
//
//   --deaths      each death in the fights with its last 10 ticks (state, attacker, Hitpoints, the foe's weapon and HP)
//   --eatlog=NAME every eat decision of that bot under 50 Hitpoints
//
// Exit code 1 if a check fails. Nothing is written outside build/tmp/bots.
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { levelRequirements, shortOf } from './lib/levelrequire.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const TICKS = Number(args.ticks ?? 2400);
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

const engineDir = prepareEngineClone('pkfight', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/pkfight.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, InvType, ObjType, PlayerStat, Fight: F } = lib;

const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok: !!ok, detail });
}
const id = n => ObjType.getId(n);
const debugname = i => (i === -1 ? '-' : ObjType.get(i)?.debugname ?? `#${i}`);
const varpOf = (p, name) => p.getVar(lib.VarPlayerType.getByName(name).id);
const setVarpOf = (p, name, v) => p.setVar(lib.VarPlayerType.getByName(name).id, v);
const wielded = p => p.getInventory(InvType.WORN).get(3)?.id ?? -1;
const count = (p, i) => {
    const inv = p.getInventory(InvType.INV);
    let n = 0;
    for (let s = 0; s < inv.capacity; s++) if (inv.get(s)?.id === i) n += inv.get(s).count;
    return n;
};

const N = 4;
const sim = await lib.Sim.create({ bots: N, members: true, debug: DEBUG, spawnPerTick: N });
sim.addHuman(3222, 3218, 0);
const human = sim.human;
const tickOnce = () => sim.tick();
while (sim.bots().length < N && World.currentTick < 20) tickOnce();
const bots = sim.bots();
const K = F.pkKitItems(); // (once the configs are loaded)

// ---- 1. the kits ----
check('kits: every item of the kits is a 274 object', Object.values(K).every(x => x !== -1), Object.entries(K).filter(([, x]) => x === -1).map(([k]) => k).join(', '));
{
    const names = lib.BOT_NAMES.slice(0, 400);
    const bad = [];
    const styles = { melee: 0, ranged: 0, archer: 0 };
    let prayerPots = 0;
    const kos = {};
    const ways = { edge: { glory: 0, spell: 0, run: 0 }, deep: { glory: 0, spell: 0, run: 0 } };
    for (const n of names) {
        for (const [where, fn] of [['edge', lib.edgevillePkerProfileFor], ['deep', lib.pkerProfileFor]]) {
            const p = fn(n);
            if (fn(n) !== p) bad.push(`${n}: not the same object twice`);
            styles[p.style] = (styles[p.style] ?? 0) + 1;
            kos[debugname(p.specWeapon)] = (kos[debugname(p.specWeapon)] ?? 0) + 1;
            ways[where][p.tele ?? 'run']++;
            if (p.specWeapon === K.dba) bad.push(`${n} (${where}): a dragon battleaxe special`);
            if (p.style === 'ranged' && p.atk === 1) {
                // (round 2) a 1-Attack ranger: the bow alone, its own special the KO; d'hide with 40 Defence
                styles.archer++;
                if (p.str !== 1 || p.weapon !== K.msb || p.specWeapon !== K.msb || p.ammo !== K.runeArrow || p.shield !== -1 || p.pots.includes(K.superStr) || !p.pots.includes(K.ranging) || ![1, 40].includes(p.def) || (p.def === 40 && !/dragonhide_body$/.test(debugname(p.body)))) bad.push(`${n} (${where}) 1-Attack ranger: ${debugname(p.weapon)}/${debugname(p.specWeapon)}, str ${p.str}, def ${p.def} ${debugname(p.body)}`);
            } else if (p.style === 'ranged') {
                if (p.weapon !== K.msb || p.rangeWeapon !== K.msb || p.specWeapon !== K.dds || p.ammo !== K.runeArrow || !(p.ammoCount >= 120 && p.ammoCount <= 250) || p.shield !== -1 || !p.pots.includes(K.ranging) || p.def > 1) bad.push(`${n} (${where}) ranger: ${debugname(p.weapon)}/${debugname(p.specWeapon)}/${debugname(p.ammo)} x${p.ammoCount}, shield ${debugname(p.shield)}, def ${p.def}`);
            } else if (p.style === 'melee') {
                if (p.rangeWeapon !== -1 || p.ammo !== -1 || /bow/.test(debugname(p.weapon)) || ![K.dds, K.dlong, K.dmace, K.rune2h].includes(p.specWeapon) || (p.specWeapon === K.rune2h && p.def > 1)) bad.push(`${n} (${where}) melee: ${debugname(p.weapon)}/${debugname(p.specWeapon)}/${debugname(p.rangeWeapon)} def ${p.def}`);
                if (p.pray >= 31) {
                    if (p.pots.includes(K.prayer)) prayerPots++;
                    else bad.push(`${n} (${where}) melee at Prayer ${p.pray}: no prayer potion`);
                }
            } else bad.push(`${n} (${where}): no style`);
            if (p.tele === 'spell' && !(p.magic >= 25 && p.magic <= 50)) bad.push(`${n}: spell at Magic ${p.magic}`);
        }
    }
    check('kits (members): a melee PKer has no bow and a dragon dagger, longsword or mace to switch to (a pure also a rune 2h sword), a prayer potion with 31+ Prayer; a ranger the magic shortbow, rune arrows, a dragon dagger and no scimitar; a 1-Attack ranger the bow alone; no dragon battleaxe special', bad.length === 0 && styles.ranged > 0 && styles.archer > 0 && styles.ranged + styles.archer < styles.melee && prayerPots > 0, `${bad.length ? bad.slice(0, 4).join('; ') + ' — ' : ''}${JSON.stringify(styles)}; KO ${JSON.stringify(kos)}; ${prayerPots} melee with a prayer potion`);
    const teleShare = w => (ways[w].glory + ways[w].spell) / names.length;
    check('kits: deep PKers carry a way out (a glory, the Varrock teleport) more often than the edge\'s', teleShare('deep') > teleShare('edge') && teleShare('edge') > 0, `edge ${JSON.stringify(ways.edge)}, deep ${JSON.stringify(ways.deep)}`);
    // (play-testing: a level 3 in the Wilderness with a magic shortbow and d'hide) a new bot (every stat 1, Hitpoints
    // 10) given a 1-Attack ranger's build gets all of its levels, Attack 1 already its own
    {
        const archerName = names.find(n => { const p = lib.edgevillePkerProfileFor(n); return p.style === 'ranged' && p.atk === 1; });
        const archer = lib.edgevillePkerProfileFor(archerName);
        const p = bots[0];
        const had = [...p.baseLevels];
        for (const s of [PlayerStat.ATTACK, PlayerStat.STRENGTH, PlayerStat.DEFENCE, PlayerStat.RANGED, PlayerStat.PRAYER]) p.setLevel(s, 1);
        p.setLevel(PlayerStat.HITPOINTS, 10);
        F.pkSetLevels(p, archer);
        const got = { atk: p.baseLevels[PlayerStat.ATTACK], str: p.baseLevels[PlayerStat.STRENGTH], def: p.baseLevels[PlayerStat.DEFENCE], hp: p.baseLevels[PlayerStat.HITPOINTS], range: p.baseLevels[PlayerStat.RANGED], pray: p.baseLevels[PlayerStat.PRAYER] };
        const want = { atk: archer.atk, str: archer.str, def: archer.def, hp: archer.hp, range: archer.range, pray: archer.pray };
        const level = p.combatLevel;
        check('kits: a new bot with a 1-Attack ranger\'s build gets all its levels (not a level 3 in the kit)', JSON.stringify(got) === JSON.stringify(want) && level === p.getCombatLevel() && level > 3, `${archerName}: ${JSON.stringify(got)} want ${JSON.stringify(want)}, combat ${level}`);
        had.forEach((l, s) => { if (p.baseLevels[s] !== l) p.setLevel(s, l); });
    }
    // (play-testing: no gear above a bot's levels; the PK tasks' gear goes on past the wear script) every kit's items,
    // the KO weapon too, within its build's levels by 274's levelrequire scripts: members (both tasks) and free
    {
        const SLOTS = ['helm', 'body', 'legs', 'shield', 'neck', 'cape', 'boots', 'gloves', 'weapon', 'specWeapon', 'rangeWeapon', 'ammo'];
        const misfits = new Map();
        let kits = 0;
        const fits = (where, p) => {
            kits++;
            for (const slot of SLOTS) {
                if (p[slot] === undefined || p[slot] === -1) continue;
                const short = shortOf(debugname(p[slot]), { atk: p.atk, str: p.str, def: p.def, range: p.range, magic: p.magic || 1 });
                if (short) misfits.set(`${where} ${p.name} ${slot} ${debugname(p[slot])}: ${short}`, (misfits.get(`${where} ${p.name} ${slot} ${debugname(p[slot])}: ${short}`) ?? 0) + 1);
            }
        };
        for (const n of lib.BOT_NAMES.slice(0, 1500)) {
            fits('edge', lib.edgevillePkerProfileFor(n));
            fits('deep', lib.pkerProfileFor(n));
        }
        lib.freeWorldPkProfiles().forEach((p, i) => {
            fits('free', p);
            for (const salt of ['edgeville_pker', 'pker']) fits(`free ${salt}`, F.pkKitted(`free ${i}`, p, salt, false));
        });
        check('kits: every kit\'s gear within its build\'s levels (274\'s levelrequire scripts)', misfits.size === 0 && levelRequirements().size > 300, `${kits} kits, ${levelRequirements().size} items with a requirement; ${[...misfits].slice(0, 4).map(([k, c]) => `${c}x ${k}`).join('; ')}`);
    }
    const free = lib.freeWorldPkProfiles();
    const freeBad = [];
    free.forEach((p, i) => {
        const k = F.pkKitted(`free ${i}`, p, i % 2 ? 'pker' : 'edgeville_pker', false);
        const ids = [k.weapon, k.specWeapon, k.rangeWeapon, k.ammo, ...k.pots, ...F.pkTeleItems(k).map(([x]) => x)].filter(x => x !== -1);
        if (ids.some(x => ObjType.get(x).members)) freeBad.push(`${p.name}: ${ids.filter(x => ObjType.get(x).members).map(debugname)}`);
        if (k.specWeapon !== -1 && (k.specWeapon !== K.rune2h || k.weapon !== K.runeScim)) freeBad.push(`${p.name}: KO ${debugname(k.specWeapon)} with ${debugname(k.weapon)}`);
        if (k.tele === 'glory' || k.rangeWeapon !== -1) freeBad.push(`${p.name}: ${k.tele} ${debugname(k.rangeWeapon)}`);
    });
    const free2h = free.filter((p, i) => F.pkKitted(`free ${i}`, p, i % 2 ? 'pker' : 'edgeville_pker', false).specWeapon === K.rune2h).length;
    check('kits (free world): only free items, no bow, a rune 2h sword to switch to after a scimitar (some), no glory', freeBad.length === 0 && free2h > 0, `${freeBad.slice(0, 4).join('; ')} ${free2h} of ${free.length} with the 2h`);
}

// ---- the stage: one bot, its AI off, and the human by Edgeville (Wilderness level 3); the others aside ----
const a = bots[0];
const bot = sim.botPlayer(a);
bot.tick = () => {};
for (const p of bots.slice(1)) {
    sim.botPlayer(p).tick = () => {};
    p.clearWaypoints();
    p.clearPendingAction();
    p.teleJump(3222 + bots.indexOf(p), 3220, 0);
}
const SPOT = [3093, 3540];
const stage = () => {
    a.clearPendingAction();
    a.clearWaypoints();
    sim.teleportHuman(SPOT[0], SPOT[1], 0);
    a.teleJump(SPOT[0] + 1, SPOT[1], 0);
    for (let i = 0; i < 2; i++) tickOnce();
};
for (const [stat, level] of [[PlayerStat.ATTACK, 70], [PlayerStat.STRENGTH, 99], [PlayerStat.DEFENCE, 1], [PlayerStat.HITPOINTS, 99], [PlayerStat.RANGED, 99], [PlayerStat.PRAYER, 1], [PlayerStat.MAGIC, 1]]) a.setLevel(stat, level);
sim.copyLevels(a);
human.setLevel(PlayerStat.DEFENCE, 1);
human.setLevel(PlayerStat.MAGIC, 1);
human.setLevel(PlayerStat.PRAYER, 1);
stage();
const worn = a.getInventory(InvType.WORN);
const inv = a.getInventory(InvType.INV);
const clear = () => {
    for (let s = 0; s < inv.capacity; s++) inv.set(s, null);
    for (let s = 0; s < worn.capacity; s++) worn.set(s, null);
};
const base = lib.edgevillePkerProfileFor(lib.BOT_NAMES[0]);
const profileWith = fields => ({ ...base, style: 'melee', shield: -1, rangeWeapon: -1, ammo: -1, pots: [], tele: null, food: id('shark'), ...fields });
const heal = p => (p.levels[PlayerStat.HITPOINTS] = p.baseLevels[PlayerStat.HITPOINTS]);

/** fights the human with the KO step each tick; the attacks it made: [tick, weapon, its speed, special energy after] */
function koFight(profile, ticks, reach) {
    const ways = F.pkWaysOf(a.username);
    const keep = ways.koReach;
    const fight = new F.PkFight(a, human, profile, false);
    const attacks = [];
    let last = varpOf(a, 'action_delay');
    lib.interactPlayerOp(a, human.slot, 2);
    for (let t = 0; t < ticks; t++) {
        tickOnce();
        heal(a);
        heal(human); // (as if it ate: the fight goes on)
        fight.observe(a);
        const d = varpOf(a, 'action_delay');
        if (d !== last && d > World.currentTick) attacks.push([World.currentTick, debugname(wielded(a)), d - World.currentTick, varpOf(a, 'sa_energy')]);
        last = d;
        // in reach from its first hit on, while `reach(attacks)` says so
        ways.koReach = attacks.length >= 1 && reach(attacks) ? 100 : 0;
        fight.koStep(a);
        if (a.target !== human) lib.interactPlayerOp(a, human.slot, 2);
    }
    ways.koReach = keep;
    a.clearPendingAction();
    return attacks;
}

// ---- 2. the KO switch ----
{
    stage();
    clear();
    worn.set(3, { id: K.runeScim, count: 1 });
    inv.add(K.dds, 1);
    setVarpOf(a, 'sa_energy', 1000);
    setVarpOf(a, 'sa_attack', 0);
    F.pkFightStats.reset();
    // in reach until it has made 5 attacks: the scimitar's, then four specials (the bar's 1000 at 250 a spec)
    const attacks = koFight(profileWith({ weapon: K.runeScim, specWeapon: K.dds }), 34, list => list.length < 6);
    const [first, ...rest] = attacks;
    const specs = rest.filter(([, w]) => w === 'dragon_dagger_p');
    const gap = rest[0] ? rest[0][0] - first[0] : -1;
    const after = rest.find(([, w], i) => i > 0 && w === 'rune_scimitar');
    check(
        'KO switch: the dragon dagger\'s special comes on the scimitar\'s tick (4 ticks after its hit), again while in reach and the bar has the energy (4 at 1000), then the scimitar is back on',
        first?.[1] === 'rune_scimitar' && rest[0]?.[1] === 'dragon_dagger_p' && gap === 4 && specs.length === 4 && specs.at(-1)?.[3] === 0 && after && F.pkFightStats.specs === 4 && F.pkFightStats.koOnFastTick >= 1,
        attacks.map(([t, w, r, e]) => `t${t} ${w}/${r} sa ${e}`).join(', ')
    );
}
{
    stage();
    clear();
    worn.set(3, { id: K.runeScim, count: 1 });
    inv.add(K.rune2h, 1);
    F.pkFightStats.reset();
    const attacks = koFight(profileWith({ weapon: K.runeScim, specWeapon: K.rune2h }), 24, list => list.length < 2);
    const i2h = attacks.findIndex(([, w]) => w === 'rune_2h_sword');
    const gap = i2h > 0 ? attacks[i2h][0] - attacks[i2h - 1][0] : -1;
    const next = attacks[i2h + 1];
    check(
        'KO switch: a rune 2h sword\'s hit 4 ticks after the scimitar\'s (its own speed is 7), the scimitar back on for the next, 7 ticks after the 2h',
        i2h > 0 && attacks[i2h - 1][1] === 'rune_scimitar' && gap === 4 && next?.[1] === 'rune_scimitar' && next[0] - attacks[i2h][0] === 7 && F.pkFightStats.koOnFastTick === 1,
        attacks.map(([t, w, r]) => `t${t} ${w}/${r}`).join(', ')
    );
}

{
    // a ranger at range: its own shortbow's special (274: 35 % a spec, two arrows), no dragon dagger out of melee reach
    stage();
    clear();
    worn.set(3, { id: K.msb, count: 1 });
    worn.set(13, { id: K.runeArrow, count: 100 });
    inv.add(K.dds, 1);
    a.teleJump(SPOT[0] + 4, SPOT[1], 0);
    tickOnce();
    setVarpOf(a, 'sa_energy', 1000);
    setVarpOf(a, 'sa_attack', 0);
    F.pkFightStats.reset();
    const attacks = koFight(profileWith({ style: 'ranged', weapon: K.msb, rangeWeapon: K.msb, ammo: K.runeArrow, specWeapon: K.dds }), 12, list => list.length < 3);
    const first = attacks.findIndex(([, , , e]) => e < 1000);
    const far = Math.max(Math.abs(a.x - human.x), Math.abs(a.z - human.z));
    check(
        'KO at range: a ranger specs with its own shortbow (35 % a spec, 274) at a target out of melee reach, not the dragon dagger',
        first > 0 && attacks[first][1] === 'magic_shortbow' && attacks[first][3] === 650 && F.pkFightStats.specsByWeapon.magic_shortbow >= 1 && !F.pkFightStats.specsByWeapon.dragon_dagger_p,
        `${attacks.map(([t, w, r, e]) => `t${t} ${w}/${r} sa ${e}`).join(', ')}; ${far} tiles off at the end`
    );
}

// ---- 3. potions ----
{
    stage();
    clear();
    worn.set(3, { id: K.runeScim, count: 1 });
    for (const n of ['4dose2strength', '1dose2strength', '4dose2attack']) inv.add(id(n), 1);
    for (const s of [PlayerStat.STRENGTH, PlayerStat.ATTACK]) a.levels[s] = a.baseLevels[s];
    const fight = new F.PkFight(a, human, profileWith({ pots: [K.superStr, K.superAtt] }), false);
    const did = [];
    for (let i = 0; i < 9; i++) {
        did.push(fight.potions(a) ? 'D' : '.');
        tickOnce();
    }
    const str = a.levels[PlayerStat.STRENGTH];
    const att = a.levels[PlayerStat.ATTACK];
    const want = b => b + 5 + Math.floor((b * 15) / 100);
    const left = ['4dose2strength', '1dose2strength', '3dose2attack', 'vial_empty'].map(n => count(a, id(n)));
    const sips = did.join('');
    check(
        'potions: through the game\'s Drink, a sip and its 2 held ticks (the 1-dose vial first), 274\'s super boosts (+5 and 15 %), none once boosted',
        sips.replaceAll('.', '') === 'DD' && sips.indexOf('D', 1) >= 3 && str === want(a.baseLevels[PlayerStat.STRENGTH]) && att === want(a.baseLevels[PlayerStat.ATTACK]) && left.join() === '1,0,1,1',
        `sips ${sips}; strength ${str}, attack ${att}; 4-dose str, 1-dose str, 3-dose att, empty vial: ${left}`
    );
    for (const s of [PlayerStat.STRENGTH, PlayerStat.ATTACK]) a.levels[s] = a.baseLevels[s];
}

// ---- 3b. (round 2) the boost prayers and the prayer potion ----
{
    stage();
    clear();
    worn.set(3, { id: K.runeScim, count: 1 });
    a.setLevel(PlayerStat.PRAYER, 44);
    const on = n => varpOf(a, n) === 1;
    const ways = F.pkWaysOf(a.username);
    const keep = ways.pray;
    const prof = profileWith({ weapon: K.runeScim, specWeapon: -1 });
    const run = (fight, ticks) => {
        const tactics = lib.Tactics.newPkTactics();
        for (let i = 0; i < ticks; i++) {
            lib.Tactics.pkEngageTactics(a, human, tactics, { honour: true, offence: fight.offence(a) });
            tickOnce();
            heal(a);
            heal(human);
        }
    };
    ways.pray = 'fight';
    const maxBefore = F.meleeMaxHit(a, K.runeScim);
    run(new F.PkFight(a, human, prof, false), 6);
    const fightOn = ['prayer8', 'prayer10', 'prayer11'].map(on);
    const noProtect = !['prayer12', 'prayer13', 'prayer14'].some(on);
    const maxWith = F.meleeMaxHit(a, K.runeScim);
    // 'ko': off with the target well clear of its reach, on once in reach
    ways.pray = 'ko';
    run(new F.PkFight(a, human, prof, false), 4);
    const koOff = !on('prayer10') && !on('prayer11');
    const fightKo = new F.PkFight(a, human, prof, false);
    const tactics = lib.Tactics.newPkTactics();
    let koOn = false;
    for (let i = 0; i < 4; i++) {
        human.levels[PlayerStat.HITPOINTS] = 3;
        lib.Tactics.pkEngageTactics(a, human, tactics, { honour: true, offence: fightKo.offence(a) });
        tickOnce();
    }
    koOn = on('prayer10') && on('prayer11');
    heal(human);
    // a ranger: none (274 has no Ranged boost)
    ways.pray = 'fight';
    const ranger = new F.PkFight(a, human, profileWith({ style: 'ranged', weapon: K.msb, specWeapon: K.msb }), false).offence(a);
    ways.pray = keep;
    const offTicks = [];
    for (let i = 0; i < 8 && lib.Tactics.pkPrayersOff(a); i++) {
        offTicks.push(i);
        tickOnce();
    }
    check(
        'boost prayers: through the prayer tab, Ultimate Strength and Incredible Reflexes (44 Prayer) and Protect Item all fight long, no protection prayer at the edge; the max hit up; for the KO only when the target is in reach; none for a ranger; off after',
        fightOn.every(Boolean) && noProtect && maxWith > maxBefore && koOff && koOn && ranger === false && !['prayer8', 'prayer10', 'prayer11'].some(on),
        `on (item, str, att): ${fightOn}; max ${maxBefore} -> ${maxWith}; ko habit: off at full ${koOff}, on at 3 HP ${koOn}; ranger ${ranger}; off in ${offTicks.length} presses`
    );
    // a prayer potion's sip with the points low: 274's 7 and a quarter of the level
    clear();
    inv.add(K.prayer, 1);
    a.levels[PlayerStat.PRAYER] = 5;
    const fight = new F.PkFight(a, human, profileWith({ pots: [K.prayer] }), false);
    const sipped = fight.potions(a);
    tickOnce();
    tickOnce();
    const points = a.levels[PlayerStat.PRAYER];
    const again = fight.potions(a);
    check(
        'prayer potion: a sip with the points low (+7 and a quarter of 44 = 18), not again once restored',
        sipped && points === 5 + 18 && !again && count(a, id('3doseprayerrestore')) === 1,
        `sipped ${sipped}, points 5 -> ${points}, again ${again}`
    );
    a.setLevel(PlayerStat.PRAYER, 1);
}

// ---- 4. eating ----
{
    stage();
    clear();
    worn.set(3, { id: K.runeScim, count: 1 });
    for (let i = 0; i < 6; i++) inv.add(id('shark'), 1);
    const ways = F.pkWaysOf(a.username);
    const max = a.baseLevels[PlayerStat.HITPOINTS];
    const prof = profileWith({});
    sim.human.getInventory(InvType.WORN).set(3, null);
    a.levels[PlayerStat.HITPOINTS] = max - 4;
    const high = new F.PkFight(a, human, prof, false).eat(a);
    const lineHp = Math.floor(max * ways.eatAt) - 1;
    a.levels[PlayerStat.HITPOINTS] = lineHp;
    const low = new F.PkFight(a, human, prof, false).eat(a);
    tickOnce();
    const healed = a.levels[PlayerStat.HITPOINTS] - lineHp;
    // a dragon dagger in the target's hand: its two hits are the line (at most 80 % of its Hitpoints)
    sim.human.getInventory(InvType.WORN).set(3, { id: K.dds, count: 1 });
    const threat = F.threatOf(human);
    const hp = Math.min(Math.floor(max * 0.8) - 1, threat, max - 13);
    a.levels[PlayerStat.HITPOINTS] = hp;
    const vsDds = hp > max * ways.eatAt ? new F.PkFight(a, human, prof, false).eat(a) : 'n/a';
    sim.human.getInventory(InvType.WORN).set(3, null);
    a.levels[PlayerStat.HITPOINTS] = hp;
    const vsNone = hp > max * ways.eatAt && hp > F.threatOf(human) + 1 ? new F.PkFight(a, human, prof, false).eat(a) : 'n/a';
    heal(a);
    check(
        'eating: not at high Hitpoints, a shark at its own line (+20), sooner against a dragon dagger in the target\'s hand',
        high === false && low === true && healed === 20 && vsDds !== false && vsNone !== true,
        `at ${max - 4}: ${high}; at ${lineHp} (its line ${(ways.eatAt * 100).toFixed(0)} %): ${low}, +${healed}; at ${hp} against a dragon dagger (threat ${threat}): ${vsDds}, against fists: ${vsNone}`
    );
}

// ---- 5. getting out ----
{
    stage();
    clear();
    worn.set(3, { id: K.runeScim, count: 1 });
    const max = a.baseLevels[PlayerStat.HITPOINTS];
    heal(human);
    const ways = F.pkWaysOf(a.username);
    a.levels[PlayerStat.HITPOINTS] = Math.floor(max * Math.min(0.25, ways.fleeEmpty - 0.05));
    const runner = new F.PkFight(a, human, profileWith({ tele: null }), false).flee(a);
    inv.add(id('amulet_of_glory_4'), 1);
    const deep = new F.PkFight(a, human, profileWith({ tele: 'glory' }), true).flee(a);
    human.levels[PlayerStat.HITPOINTS] = 2;
    const forKill = new F.PkFight(a, human, profileWith({ tele: 'glory' }), true).flee(a);
    heal(human);
    for (let i = 0; i < 10; i++) inv.add(id('shark'), 1);
    heal(a);
    const healthy = new F.PkFight(a, human, profileWith({ tele: 'glory' }), true).flee(a);
    check(
        'getting out: out of food and hurt it leaves (on foot without a teleport, by its glory deep), not with the target in its KO reach, not healthy with food',
        runner === 'run' && deep === 'tele' && forKill === null && healthy === null,
        `no teleport: ${runner}; a glory, deep: ${deep}; target at 2 HP: ${forKill}; healthy with food: ${healthy}`
    );

    // the glory's Rub: "Edgeville." (274's amulet_of_glory.rs2), a charge gone
    const teleport = (profile, ticks = 14) => {
        const tp = new F.PkTeleport(a, profile);
        const steps = [];
        let st = 'casting';
        for (let i = 0; i < ticks && st === 'casting'; i++) {
            st = tp.tick(a);
            steps.push(st[0]);
            if (st === 'casting') tickOnce();
        }
        return [st, steps.join('')];
    };
    stage();
    clear();
    inv.add(id('amulet_of_glory_4'), 1);
    const [glory, gSteps] = teleport(profileWith({ tele: 'glory' }));
    const atEdge = Math.max(Math.abs(a.x - 3087), Math.abs(a.z - 3496)) <= 2;
    const charges = count(a, id('amulet_of_glory_3'));
    stage();
    clear();
    for (const [n, c] of [['lawrune', 2], ['airrune', 6], ['firerune', 2]]) inv.add(id(n), c);
    a.setLevel(PlayerStat.MAGIC, 40);
    const [spell, sSteps] = teleport(profileWith({ tele: 'spell' }));
    const inVarrock = Math.max(Math.abs(a.x - 3213), Math.abs(a.z - 3424)) <= 3;
    const laws = count(a, id('lawrune'));
    a.setLevel(PlayerStat.MAGIC, 1);
    check(
        'getting out: the glory\'s Rub lands it at Edgeville (a charge gone), the Varrock teleport in Varrock (a law gone)',
        glory === 'out' && atEdge && charges === 1 && spell === 'out' && inVarrock && laws === 1,
        `glory ${glory} (${gSteps}) at ${atEdge}, glory(3) ${charges}; spell ${spell} (${sSteps}) in Varrock ${inVarrock}, laws ${laws}`
    );
}

// ---- 5b. (round 2) PJing: a PJer waits by a fight and jumps the one left once the game's lock is over ----
{
    stage();
    clear();
    worn.set(3, { id: K.runeScim, count: 1 });
    const [b, c] = bots.slice(1, 3);
    for (const p of [b, c]) {
        // (the PJer's levels: in its combat range at level 3)
        for (const stat of [PlayerStat.ATTACK, PlayerStat.STRENGTH, PlayerStat.DEFENCE, PlayerStat.HITPOINTS, PlayerStat.RANGED, PlayerStat.PRAYER, PlayerStat.MAGIC]) p.setLevel(stat, a.baseLevels[stat]);
        p.combatLevel = p.getCombatLevel();
        p.clearPendingAction();
        p.clearWaypoints();
    }
    sim.teleportHuman(3222, 3218, 0);
    b.teleJump(SPOT[0] - 6, SPOT[1], 0);
    c.teleJump(SPOT[0] - 7, SPOT[1], 0);
    a.teleJump(SPOT[0] + 2, SPOT[1], 0);
    tickOnce();
    lib.interactPlayerOp(b, c.slot, 2);
    lib.interactPlayerOp(c, b.slot, 2);
    for (let i = 0; i < 6; i++) {
        tickOnce();
        heal(b);
        heal(c);
    }
    F.pkFightStats.reset();
    const watch = lib.Pj.pkFightToWatch(a, 22, () => true);
    const during = watch ? watch.next(a, () => true, 22) : 'none';
    // its attack refused while they fight (the game's "Someone else is already fighting your opponent.")
    // c teleports off; b is left: free for a third player 8 ticks after its last hit
    c.clearPendingAction();
    b.clearPendingAction();
    c.teleJump(3222, 3222, 0);
    const lastHit = varpOf(b, 'lastcombat');
    let jumped = null;
    let at = -1;
    for (let i = 0; i < 16 && !jumped; i++) {
        tickOnce();
        const n = watch?.next(a, () => true, 22);
        if (n && n !== 'over') {
            jumped = n;
            at = World.currentTick;
        }
    }
    let landed = false;
    if (jumped) {
        lib.interactPlayerOp(a, jumped.slot, 2);
        const hpWas = jumped.levels[PlayerStat.HITPOINTS];
        const delayWas = varpOf(a, 'action_delay');
        for (let i = 0; i < 16 && !landed; i++) {
            tickOnce();
            landed = varpOf(a, 'action_delay') !== delayWas || jumped.levels[PlayerStat.HITPOINTS] < hpWas;
        }
    }
    a.clearPendingAction();
    check(
        'PJing: a fight near it found to wait by, nobody to jump while it goes on; the one left jumped once 8 ticks passed since its last hit (274\'s single-way lock), and the game takes the attack',
        watch !== null && during === null && jumped === b && at - lastHit >= 8 && landed && F.pkFightStats.pj.watches === 1 && F.pkFightStats.pj.jumps === 1,
        `watch ${watch ? 'found' : 'none'}, during ${during}; jumped ${jumped?.username ?? 'none'} ${at - lastHit} ticks after its last hit; attack landed ${landed}`
    );
    for (const p of [b, c]) {
        p.clearPendingAction();
        p.teleJump(3222 + bots.indexOf(p), 3220, 0);
    }
}

// ---- 6. fights: Edgeville PKers fighting each other ----
{
    sim.teleportHuman(3222, 3218, 0);
    clear();
    const tasks = [];
    bots.forEach((p, i) => {
        const b = sim.botPlayer(p);
        delete b.tick;
        b.planner.pickTask = () => new lib.EdgevillePKerTask();
        if (b.currentTask) b.currentTask.interrupt?.();
        p.clearWaypoints();
        p.clearPendingAction();
        p.teleJump(3088 + i * 3, 3532 + (i % 2) * 4, 0);
    });
    // their own kits at the same levels (a pure's: every kit's gear goes on), so any two may fight at level 2-5
    // (round 2: 52 Prayer, for the boosts; one of them a PJer)
    const LEVELS = { atk: 75, str: 99, def: 1, hp: 85, range: 90, pray: 52 };
    F.pkWaysOf(bots[N - 1].username).pj = true;
    for (let t = 0; t < 60 && tasks.length < N; t++) {
        tickOnce();
        for (const p of bots) {
            const task = sim.botPlayer(p)?.currentTask;
            if (!(task instanceof lib.EdgevillePKerTask) || tasks.some(x => x.task === task) || !task.profile) continue;
            task.profile = { ...task.profile, ...LEVELS };
            p.baseLevels[PlayerStat.ATTACK] = 0; // (its build's levels again: handleInit)
            Object.assign(task, { state: 'init', respawnTimer: 0, cooldown: 0 });
            tasks.push({ p, task });
        }
    }
    F.pkFightStats.reset();
    if (args.eatlog) {
        const eat = F.PkFight.prototype.eat;
        F.PkFight.prototype.eat = function (p) {
            const before = p.levels[PlayerStat.HITPOINTS];
            const r = eat.call(this, p);
            if (before < 50 && p.username === args.eatlog) process.stderr.write(`eat t${World.currentTick} ${p.username} hp ${before} -> ${r} (eatAt ${this.eatAt}, threat ${this.threat()}, protect ${p.protect}, delayed ${p.delayed}, food ${F.pkFoodLeft(p, this.profile)}, hp now ${p.levels[PlayerStat.HITPOINTS]})\n`);
            return r;
        };
    }
    const deaths = { total: 0, withFood: 0 };
    const hpWas = new Map(bots.map(p => [p, p.levels[PlayerStat.HITPOINTS]]));
    const trail = new Map(bots.map(p => [p, []]));
    const deathLog = [];
    const deathAt = [];
    // (play-testing: a PKer switched from its dragon dagger to its scimitar hit with the dagger's animation) at
    // every attack (%action_delay moved on), %com_attackanim, which pvp_melee plays, is one of the weapon's own
    const attackAnims = ['stabattack_anim', 'slashattack_anim', 'crushattack_anim', 'rangeattack_anim'].map(n => lib.ParamType.getByName(n).id);
    const animsOf = w => attackAnims.map(param => lib.ParamHelper.getIntParam(param, ObjType.get(w), -1));
    const swings = { checked: 0, stale: [] };
    // (play-testing: the ditch "a little too quiet", "like trash talk", "the same lines like cya a lot") every
    // PK line of the fights, by its pool (the PKer's own subset of each: port/BotLines pkSubset)
    const banterKinds = ['taunt', 'hit', 'lucky', 'ate', 'low', 'lag', 'back', 'gl', 'kill', 'escape', 'ran', 'pjed', 'honour', 'patrol'];
    const kindOf = (name, text) => banterKinds.find(k => lib.pkSubset(name, k, []).includes(text) || (k === 'gl' && /^gl/i.test(text))) ?? 'other';
    const pkSaid = [];
    lib.sayListeners.push((player, text, kind) => {
        if (kind === 'pk' && bots.includes(player)) pkSaid.push({ t: World.currentTick, name: player.username, text, kind: kindOf(player.username, text), sq: `${player.x >> 3}_${player.z >> 3}` });
    });
    const delayWas = new Map(bots.map(p => [p, varpOf(p, 'action_delay')]));
    for (let t = 0; t < TICKS; t++) {
        tickOnce();
        for (const p of bots) {
            const delay = varpOf(p, 'action_delay');
            const w = wielded(p);
            if (delay !== delayWas.get(p) && w !== -1) {
                swings.checked++;
                const anim = varpOf(p, 'com_attackanim');
                if (!animsOf(w).includes(anim)) swings.stale.push(`t${World.currentTick} ${p.username} ${debugname(w)} anim ${anim}`);
            }
            delayWas.set(p, delay);
            const hp = p.levels[PlayerStat.HITPOINTS];
            const task = sim.botPlayer(p)?.currentTask;
            const foe = task?.target;
            const tr = trail.get(p);
            const by = bots.find(o => o !== p && o.target === p);
            tr.push(`${(task?.state ?? '?')[0]}${task?.cooldown ?? ''}${task?.fight ? (task.fight.target === foe ? 'F' : 'x') : '-'}${p.delayed ? 'd' : ''}${by ? '<' + by.username.slice(0, 3) + (by.targetOp ?? '') : ''}${hp}${foe ? '/' + debugname(wielded(foe)).replace(/^(rune|dragon|magic)_/, '').slice(0, 5) + ':' + foe.levels[PlayerStat.HITPOINTS] : ''}`);
            if (tr.length > 10) tr.shift();
            if (hp <= 0 && hpWas.get(p) > 0) {
                deaths.total++;
                const food = F.pkFoodLeft(p, task?.profile ?? base);
                if (food > 0) deaths.withFood++;
                deathAt.push([p.username, World.currentTick]);
                deathLog.push(`${p.username} (${task?.profile?.style}, food ${food}, eat ${F.pkWaysOf(p.username).eatAt.toFixed(2)}): ${tr.join(' ')}`);
            }
            hpWas.set(p, hp);
        }
    }
    if (DEBUG || args.deaths) for (const d of deathLog) process.stderr.write(`death ${d}\n`);
    const S = F.pkFightStats;
    const flees = S.flees.run + S.flees.tele;
    // a flee that ended in a death within 40 ticks was caught
    const caught = S.fleeLog.filter(f => deathAt.some(([n, t]) => n === f.name && t >= f.tick && t - f.tick <= 40)).length;
    const summary = `${tasks.length} PKers ${tasks.map(({ task }) => `${task.profile.style}/${debugname(task.profile.specWeapon)}/${task.profile.tele ?? 'run'}`).join(' ')}; ${TICKS} ticks: ${S.fights} fights, ${S.eats} bites, ${S.doses} doses, ${S.koSwitches} KO switches (${S.koOnFastTick} on the fast tick), specials ${JSON.stringify(S.specsByWeapon)}, ${S.boostedFights} fights boosted, PJ ${JSON.stringify(S.pj)}, flees ${JSON.stringify(S.flees)} (${caught} caught), deaths ${deaths.total} (${deaths.withFood} with food left)`;
    check('fights: Edgeville PKers fought each other, drank their potions, ate, specced (no dragon battleaxe special)', tasks.length === N && S.fights >= 4 && S.doses >= 2 && S.eats >= 2 && S.specs >= 1 && !S.specsByWeapon.dragon_battleaxe, summary);
    check('fights: some got out (a run or a teleport), not every fight ends in a death', flees >= 1 && deaths.total < S.fights, summary);
    const said = {};
    for (const l of pkSaid) said[l.kind] = (said[l.kind] ?? 0) + 1;
    // (a reflex line, "gl" "gf" "brb", not twice in a square within 10 minutes: port/BotLines pkLine)
    const REFLEX = new Set(['gl', 'gf', 'brb', 'cya', 'lol', 'ty', 'k', 'kk', 'ok', 'nice', 'wow', 'yo']);
    const repeats = pkSaid.filter((l, i) => REFLEX.has(l.text.toLowerCase()) && pkSaid.some((m, j) => j < i && m.text.toLowerCase() === l.text.toLowerCase() && m.sq === l.sq && l.t - m.t < 1000));
    const banterDetail = `${pkSaid.length} PK lines ${JSON.stringify(said)}; reflex repeats ${repeats.length} ${repeats.slice(0, 2).map(l => `t${l.t} ${l.text}`).join(', ')}; e.g. ${pkSaid.filter(l => ['taunt', 'hit', 'back'].includes(l.kind)).slice(0, 6).map(l => `${l.kind}: ${l.text}`).join(' | ')}`;
    check('fights: banter: taunts, a word after a big hit, answers to a taunt; no reflex line twice in a square in 10 minutes', (said.taunt ?? 0) >= 3 && (said.hit ?? 0) + (said.lucky ?? 0) >= 3 && (said.back ?? 0) >= 1 && repeats.length === 0, banterDetail);
    check('fights: every attack plays the wielded weapon\'s own animation (a switch while delayed too)', swings.checked >= 50 && swings.stale.length === 0, `${swings.checked} attacks, ${swings.stale.length} with another weapon's animation ${swings.stale.slice(0, 3).join(', ')}; ${S.koSwitches} KO switches`);
    check('fights (round 2): boost prayers in some fights; the PJer watched a fight', S.boostedFights >= 1 && S.pj.watches >= 1, summary);
}

check('errors: none (bot errors, console errors)', BotManager.stats().errors === 0 && consoleErrors.length === 0, `${BotManager.stats().errors} bot errors, ${consoleErrors.length} console errors ${consoleErrors.slice(0, 2).join(' | ')}`);

out(`pkfight: ${N} PK bots on a members world, ${TICKS} ticks of fights, seed ${args.seed ?? 1}`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
