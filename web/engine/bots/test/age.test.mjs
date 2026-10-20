#!/usr/bin/env node
// A new bot world's ages (port/BotAge, BOTS.md §4.4), in the real rev-274 world, on a members world and (in a child
// process, each world needs its own engine) on a free one:
//   same name   the same tier, stats, kit and start tile every time (a bot that leaves before its first save comes
//               back the same), whatever Math.random does
//   shares      over 2,000 names the tiers come out near 25/25/25/18/7 %
//   levels      each stat's level is its XP's; Hitpoints 1,154 + a third of the combat XP (±1 rounding); Herblore ≥ 3;
//               the combat level is the engine's; PKers untouched; social and vendor bots their levels and a look
//               (the realism work, phase 4: worn only, nothing in the pack or bank, the spawn; it was the levels only)
//   free world  no members item worn, carried or banked, members skills at 1 (Herblore 3), also after InitTask's
//               starter items and bank seed; no members food in the seed
//   start tile  aged levelling bots: a walkable tile, allowed on the world, by a bank; newcomers keep the spawn
//   InitTask    after ageing: no second armour set or weapon in the bank, no bronze axe or pickaxe over a better one
//   runes       (the realism work, phase 5a) from Magic 25 a teleporter's runes, from 55 an alcher's (no air runes beside
//               the kit's staff of air), from a seed of their own: the rest of the kit is unchanged
//
//   node web/engine/bots/test/age.test.mjs [--members=false]
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { BOTS_DIR } from './lib/paths.mjs';
import { importInEngine, simWorldConfig } from './lib/clone.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? 'true']));
const MEMBERS = (args.members ?? 'true') !== 'false';
for (const level of ['log', 'info', 'debug']) console[level] = () => {};
const consoleErrors = [];
const realError = console.error.bind(console);
console.error = (...a) => {
    const text = a.map(String).join(' ');
    if (!text.includes('ExperimentalWarning')) consoleErrors.push(text.slice(0, 300));
};
console.warn = () => {};

const lib = await importInEngine(path.join(BOTS_DIR, 'test/lib/age.ts'), `unit-age-${MEMBERS ? 'p2p' : 'f2p'}`, simWorldConfig({ members: MEMBERS }));
await lib.startWorld(MEMBERS);
const { InvType, ObjType, PLANNERS } = lib;

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
const LEVELLING = ['skiller', 'fighter', 'balanced', 'random'];
const debugname = id => ObjType.get(id)?.debugname ?? `#${id}`;
const roster = lib.BOT_NAMES.slice(0, 100).map((name, i) => ({ name, planner: PLANNERS[i % PLANNERS.length] }));
const aged = roster.map(({ name, planner }) => {
    const player = lib.freshBot(name);
    const fresh = lib.snapshotOf(player);
    const tier = lib.applyAge(player, name, planner, MEMBERS);
    return { name, planner, player, tier, fresh };
});

// ---- same name, same result (also with Math.random disturbed) ----
{
    const different = [];
    for (const a of aged) {
        Math.random(); Math.random();
        const again = lib.freshBot(a.name);
        lib.applyAge(again, a.name, a.planner, MEMBERS);
        if (lib.snapshotOf(again) !== lib.snapshotOf(a.player)) different.push(a.name);
        if (lib.ageTierFor(a.name, a.planner) !== a.tier) different.push(`${a.name} (tier)`);
    }
    check('same name: the same tier, stats, kit and start tile', different.length === 0, different.slice(0, 5).join(', ') || `${aged.length} bots`);
}

// ---- tier shares ----
{
    const counts = Object.fromEntries(lib.AGE_TIERS.map(t => [t.tier, 0]));
    const N = 2000;
    for (let i = 0; i < N; i++) counts[lib.ageTierFor(lib.normalizeBotName(`share ${i}`), 'balanced')]++;
    const off = lib.AGE_TIERS.filter(t => Math.abs(counts[t.tier] / N - t.share) > 0.035);
    check('tier shares: within 3.5 points of 25/25/25/18/7 % over 2,000 names', off.length === 0, lib.AGE_TIERS.map(t => `${t.tier} ${((100 * counts[t.tier]) / N).toFixed(1)} %`).join(', '));
    const pkersAged = roster.filter(r => r.planner.includes('pker')).filter(r => lib.ageTierFor(r.name, r.planner) !== 'newcomer');
    check('PKers are never aged (their tasks set their builds)', pkersAged.length === 0, pkersAged.map(r => r.name).join(', '));
}

// ---- levels ----
{
    const bad = [];
    const COMBAT = [0, 2, 1, 4, 6];
    for (const a of aged) {
        const p = a.player;
        for (let stat = 0; stat < p.stats.length; stat++) {
            if (stat === 18 || stat === 19) continue;
            if (p.baseLevels[stat] !== lib.getLevelByExp(p.stats[stat]) || p.levels[stat] !== p.baseLevels[stat]) bad.push(`${a.name}: stat ${stat} level ${p.baseLevels[stat]} for ${p.stats[stat]} XP`);
        }
        if (p.baseLevels[15] < 3) bad.push(`${a.name}: Herblore ${p.baseLevels[15]}`);
        if (p.combatLevel !== lib.combatLevelOf(p.baseLevels) || p.combatLevel !== p.getCombatLevel()) bad.push(`${a.name}: combat ${p.combatLevel}, engine ${p.getCombatLevel()}`);
        if (a.tier !== 'newcomer') {
            const combatXp = COMBAT.reduce((sum, s) => sum + p.stats[s], 0);
            const hp = p.stats[3];
            if (Math.abs(hp - (11540 + combatXp / 3)) > 20) bad.push(`${a.name}: Hitpoints XP ${hp / 10}, combat XP ${combatXp / 10}`);
        }
        if (a.planner.includes('pker') && lib.snapshotOf(p) !== a.fresh) bad.push(`${a.name}: a PKer was changed`);
        // (the variety work, round 1, track W: a newcomer whose name promises a class wears its cheapest piece, its
        // newcomerClassLook; nothing else of it changes)
        if (a.tier === 'newcomer' && !a.planner.includes('pker')) {
            const look = lib.newcomerClassLook?.(a.name, MEMBERS) ?? [];
            const worn = lib.items(p, InvType.WORN).map(it => it.id);
            const unworn = JSON.parse(lib.snapshotOf(p));
            const fresh = JSON.parse(a.fresh);
            unworn.worn = fresh.worn;
            const wornOk = look.length === 0 ? lib.snapshotOf(p) === a.fresh : look.every(id => worn.includes(id)) && JSON.stringify(unworn) === JSON.stringify(fresh);
            if (!wornOk) bad.push(`${a.name}: a newcomer was changed`);
        } else if (a.tier === 'newcomer' && lib.snapshotOf(p) !== a.fresh) bad.push(`${a.name}: a newcomer was changed`);
        // (the realism work, phase 4: a social or vendor bot gets a look, worn only: port/BotAge agedLook)
        if ((a.planner === 'extras_social' || a.planner === 'extras_vendor') && a.tier !== 'newcomer') {
            const nothing = lib.items(p, InvType.INV).length === 0 && lib.items(p, lib.bankId()).length === 0;
            const [x, z] = lib.Locations.LUMBRIDGE_SPAWN;
            if (!nothing || p.x !== x || p.z !== z) bad.push(`${a.name}: a ${a.planner} bot got kit in its pack or bank, or a tile`);
        }
    }
    check('levels: from their XP; Hitpoints from the combat XP; Herblore ≥ 3; the engine\'s combat level; PKers and newcomers untouched; social and vendor bots their levels and a look (worn only)', bad.length === 0, bad.slice(0, 5).join('; '));
    // what the tiers look like (the levelling planners)
    const byTier = new Map();
    for (const a of aged) {
        if (!LEVELLING.includes(a.planner)) continue;
        const list = byTier.get(a.tier) ?? [];
        list.push(a.player.combatLevel);
        byTier.set(a.tier, list);
    }
    const summary = lib.AGE_TIERS.map(t => {
        const list = (byTier.get(t.tier) ?? []).sort((x, y) => x - y);
        return list.length ? `${t.tier} ${list.length}: cb ${list[0]}–${list[list.length - 1]} (median ${list[Math.floor(list.length / 2)]})` : `${t.tier} 0`;
    });
    // and over 400 names per levelling planner: the combat levels each tier comes out at
    const wide = lib.AGE_TIERS.slice(1).map(t => {
        const list = [];
        for (const planner of LEVELLING) {
            for (let i = 0; i < 400; i++) {
                const name = lib.normalizeBotName(`cb ${planner.slice(0, 3)} ${i}`);
                if (lib.ageTierFor(name, planner) !== t.tier) continue;
                const p = lib.freshBot(name);
                lib.applyAge(p, name, planner, MEMBERS);
                list.push(p.combatLevel);
            }
        }
        list.sort((x, y) => x - y);
        const at = q => list[Math.min(list.length - 1, Math.floor(q * list.length))];
        return `${t.tier} cb ${at(0.1)}/${at(0.5)}/${at(0.9)}`;
    });
    summary.push(`(10th/50th/90th percentile over 1,600 names: ${wide.join(', ')})`);
    const vet = byTier.get('veteran') ?? [];
    const nov = byTier.get('novice') ?? [];
    check('tiers: higher tiers, higher combat (levelling bots of the roster)', nov.length > 0 && Math.max(...nov) < Math.max(...(byTier.get('experienced') ?? [0])), summary.join('; '));
}

// ---- free world ----
if (!MEMBERS) {
    const bad = [];
    for (const a of aged) {
        const p = a.player;
        for (const [inv, where] of [[InvType.WORN, 'worn'], [InvType.INV, 'pack'], [lib.bankId(), 'bank']]) {
            for (const it of lib.items(p, inv)) if (ObjType.get(it.id).members) bad.push(`${a.name}: ${debugname(it.id)} (${where})`);
        }
        for (const stat of [9, 16, 17]) if (p.baseLevels[stat] !== 1) bad.push(`${a.name}: members stat ${stat} at ${p.baseLevels[stat]}`);
        if (p.baseLevels[15] !== 3) bad.push(`${a.name}: Herblore ${p.baseLevels[15]}`);
    }
    check('free world: no members item worn, carried or banked; members skills at 1 (Herblore 3)', bad.length === 0, bad.slice(0, 5).join('; '));
}

// ---- start tiles ----
{
    const bad = [];
    const banks = new Set();
    for (const a of aged) {
        const p = a.player;
        const [sx, sz] = lib.Locations.LUMBRIDGE_SPAWN;
        const atSpawn = p.x === sx && p.z === sz;
        if (!LEVELLING.includes(a.planner) || a.tier === 'newcomer') {
            if (!atSpawn) bad.push(`${a.name} (${a.planner}, ${a.tier}) moved`);
            continue;
        }
        if (atSpawn) bad.push(`${a.name} (${a.tier}) kept the spawn`);
        if (!lib.walkable(p.x, p.z, p.level)) bad.push(`${a.name}: ${p.x},${p.z} not walkable`);
        if (!MEMBERS && !lib.freeToPlay(p.x, p.z)) bad.push(`${a.name}: ${p.x},${p.z} members-only`);
        banks.add(`${Math.round(p.x / 10) * 10},${Math.round(p.z / 10) * 10}`);
    }
    check('start tiles: aged levelling bots on a walkable tile by a bank (free on a free world); the others at the spawn', bad.length === 0, bad.slice(0, 5).join('; ') || `${banks.size} places`);
}

// ---- InitTask after ageing ----
{
    const bad = [];
    for (const a of aged) {
        if (!LEVELLING.includes(a.planner)) continue;
        const p = a.player;
        lib.runInitTask(p);
        const bank = lib.items(p, lib.bankId());
        const worn = lib.items(p, InvType.WORN);
        for (const w of worn) if (bank.some(b => b.id === w.id)) bad.push(`${a.name}: ${debugname(w.id)} worn and banked`);
        const pack = lib.items(p, InvType.INV).map(it => debugname(it.id));
        if (pack.includes('bronze_axe') && pack.some(n => /_axe$/.test(n) && n !== 'bronze_axe')) bad.push(`${a.name}: a bronze axe over its ${pack.find(n => /_axe$/.test(n) && n !== 'bronze_axe')}`);
        if (pack.includes('bronze_pickaxe') && pack.some(n => /_pickaxe$/.test(n) && n !== 'bronze_pickaxe')) bad.push(`${a.name}: a bronze pickaxe over a better one`);
        if (!MEMBERS) {
            for (const it of [...bank, ...lib.items(p, InvType.INV)]) if (ObjType.get(it.id).members) bad.push(`${a.name}: ${debugname(it.id)} after InitTask`);
        }
        // (earned gear: InitTask seeds no bank: no armour set, no 999,999,999 swordfish)
        if (bank.some(b => b.count >= 1_000_000)) bad.push(`${a.name}: a bank seed after InitTask (${debugname(bank.find(b => b.count >= 1_000_000).id)})`);
    }
    // and a fresh bot's starter items on this world: its tools, a bronze scimitar, some shrimps and coins, no bank seed
    const fresh = lib.freshBot('init test');
    lib.runInitTask(fresh);
    const pack = lib.items(fresh, InvType.INV);
    const freshBank = lib.items(fresh, lib.bankId());
    if (!MEMBERS) for (const it of [...pack, ...freshBank]) if (ObjType.get(it.id).members) bad.push(`fresh bot: ${debugname(it.id)}`);
    if (freshBank.length > 0) bad.push(`fresh bot: a bank seed (${freshBank.map(it => `${debugname(it.id)}×${it.count}`).slice(0, 4).join(', ')})`);
    for (const want of ['iron_scimitar', 'bronze_axe', 'bronze_pickaxe', 'shrimp', 'coins']) if (!pack.some(it => debugname(it.id) === want)) bad.push(`fresh bot: no ${want}`);
    check(`InitTask: no second set of what an aged bot wears, no bronze tools over better ones; a fresh bot gets its starter items and no bank seed (earned gear)${MEMBERS ? '' : ', nothing members-only'}`, bad.length === 0, bad.slice(0, 5).join('; ') || `${pack.length} starter stacks`);
}

// ---- runes (the realism work, phase 5a, Track M: teleport spells and alching; port/BotAge.magicKit, new bots only) ----
// (a revision of this test: the kit gained a bot's runes, from a seed of its own, so every other kit item is unchanged
// and the same-name check above still holds)
{
    const bad = [];
    let casters = 0;
    let alchers = 0;
    const [LAW, FIRE, EARTH, WATER, AIR, NATURE] = ['lawrune', 'firerune', 'earthrune', 'waterrune', 'airrune', 'naturerune'].map(n => ObjType.getId(n));
    const FIRE_STAFF = ObjType.getId('staff_of_fire');
    for (const a of aged) {
        if (!LEVELLING.includes(a.planner) || a.tier === 'newcomer') continue;
        const banked = new Set(lib.items(a.player, lib.bankId()).map(it => it.id));
        const magic = a.player.baseLevels[6];
        if (magic >= 25) {
            casters++;
            if (![LAW, FIRE, EARTH, WATER].every(id => banked.has(id))) bad.push(`${a.name}: Magic ${magic} without its teleport runes`);
        } else if (banked.has(LAW) || banked.has(NATURE)) bad.push(`${a.name}: Magic ${magic} with laws or natures`);
        if (banked.has(AIR)) bad.push(`${a.name}: air runes beside its staff of air`);
        if (magic >= 55) {
            alchers++;
            if (!banked.has(NATURE) || !banked.has(FIRE_STAFF)) bad.push(`${a.name}: Magic ${magic} without natures or a staff of fire`);
        }
    }
    check('runes (phase 5a): from Magic 25 laws, fire, earth and water in the bank (no air: its staff of air), from 55 natures and a staff of fire; none below 25', bad.length === 0, bad.slice(0, 5).join('; ') || `${casters} casters, ${alchers} alchers of the roster's aged levelling bots`);
}

check('errors: none', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

const out = s => process.stdout.write(s + '\n');
out(`age: ${MEMBERS ? 'members' : 'free'} world, ${aged.length} roster bots`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
let ok = checks.every(c => c.ok);
if (MEMBERS && args.child !== 'true') {
    // the free world needs an engine of its own
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--members=false', '--child'], { encoding: 'utf8' });
    process.stdout.write((r.stdout ?? '') + (r.status !== 0 ? r.stderr ?? '' : ''));
    ok &&= r.status === 0;
}
process.exit(ok ? 0 : 1);
