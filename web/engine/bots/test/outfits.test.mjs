#!/usr/bin/env node
// What they wear (the variety work, round 1, track W; docs/BOTS.md §5 WEAR-1, -2, -3,
// -5, -6, BUG-a, BUG-c; the plan's "tools in hand for half the woodcutters and miners"), in the real rev-274 world:
//   seeds        each new trait has a seed of its own (no name's helm, cape, metal, gender or colours change: phase 4's
//                salts each used once, the new ones new); the same name gives the same style, weapon kind and clothes
//   names        a name's class from its words (Wizard Tim a mage, Elf Archer a ranger, Arrow Maker no ranger, Pickaxe Pat
//                a miner, Sir Loin a knight); about 1 name in 20
//   styles       ranger and mage by the name's dice (18.75 % and 12.5 % of the names without a class), class names forced
//   ladders      the ranger's pieces by 274's levels (a coif from 20 Ranged, studded at 20/20, d'hide at 40, its body at 40
//                Defence; blue, red, black only on a members world); the mage's (splitbark at 40/40, battlestaves and
//                mystic staves only on a members world)
//   weapons      the liked kinds' shares (scimitar 55 %, ...); new bots' kits: scimitars 45-70 % of the levelling bots'
//                melee weapons, 6+ kinds; dragon only for members veterans of 60 Attack
//   shops        every weapon and outfit piece a bot buys is in 274's stock with some in it, its keeper known to
//                ShopTripTask and standing within 8 tiles of the shop's place (the maps' NPC spawns)
//   purchases    a longsword-liker buys a longsword at Varrock's sword shop, a battleaxe-liker at the nearer of Brian's and
//                Bob's; a ranger a leather, then studded body; a mage a wizard hat and a skirt; a cook a white apron;
//                nothing below the reserve
//   kits         a ranger's kit wears no metal body (an archer's name holds a bow), a mage's a wizard hat or robe and a
//                staff; class names
//                in their class's look; chef's hats only on cooks, chefs' names and the joke; no social or vendor bot of
//                combat 20+ holds a starter tool (BUG-c)
//   loot         BotAction._equipLoot (BUG-a): a looted Black robe never goes on over an iron platebody, a rune axe is not
//                wielded over a scimitar, a mithril longsword is (the real wear op)
//   weapon       CombatTask's bank (BUG-b): the best weapon of any kind by metal, the liked kind at a metal; a held axe to
//                the bank, a two-hander's shield too
//   modes        dressForMode: a ranged fight's outfit without a metal body (the ranger's pieces on, a patchwork helm kept),
//                a magic fight's without metal (hat, robe, skirt on); a signature hat stays
//   at a skill   the chef's hat at the range only; the axe in a wielder's hand at the trees (the best its Attack allows),
//                back in the pack elsewhere; a crafter wears the leather it made; Agility dresses; (the fixes) an axe
//                stowed with a two-hander its best weapon and a wooden shield on: the shield to the bank, the 2h in hand
//   in the world a wielder woodcutter chops with its axe in hand and its fight puts its weapon back; a plated firemaker
//                and a plated agility bot stop at a bank first; a ranged fight's bank takes the plate off
//   PKers        a mage's name a wizard hat (a pure's the monk's robe), an archer's a coif (a pure's leather), builds kept;
//                (the fixes) only for a PKer new since round 1 or saved in that look: one saved before keeps its profile's
//                helm and body
//
//   node --expose-gc web/engine/bots/test/outfits.test.mjs [--seed=3]
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, CONTENT_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const SEED = Number(args.seed ?? 3);
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

for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
const logErrors = [];
{
    const error = console.error.bind(console);
    console.error = (...a) => {
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (!text.includes('ExperimentalWarning')) logErrors.push(text.slice(0, 300));
        if (process.env.OUTFITS_DEBUG) error(...a);
    };
}
const engineDir = prepareEngineClone('outfits', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/outfits.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, InvType, ObjType, Looks, Gear, Age, Outfits: O } = lib;
const saves = new Map();
const TIMING = { session: [1e7, 1e7], away: [1e7, 1e7], newcomer: [1e7, 1e7], newCharacterCount: [2, 2], newCharacterDelay: [5, 10], returnGap: [5, 30], emptyWorld: 50, busyGiveUp: 600, leaveGiveUp: 50 };
const sim = await lib.Sim.create({ bots: 12, members: true, debug: false, ageNewBots: true, saves, ackLogouts: true, extra: { timing: TIMING, savedNames: () => [...saves.keys()] } });
sim.addHuman(3222, 3218, 0);
const dn = id => (id === -1 || id === undefined ? '' : (ObjType.get(id)?.debugname ?? `#${id}`));
const id = name => ObjType.getId(name);
const norm = n => lib.normalizeBotName(n);
const NAMES = lib.BOT_NAMES.map(norm);
const W = Looks.wardrobeItems();
const OI = O.outfitItems();
const I = lib.Items;
const LEVELLING = new Set(['skiller', 'fighter', 'balanced', 'random']);
const COSMETIC = new Set(['extras_social', 'extras_vendor']);
const wornNames = p => {
    const w = p.getInventory(InvType.WORN);
    const names = [];
    for (let s = 0; s < (w?.capacity ?? 0); s++) names.push(w.get(s) ? dn(w.get(s).id) : null);
    return names;
};
const bankNames = p => lib.items(p, lib.bankId()).map(it => dn(it.id));
const packNames = p => lib.items(p, InvType.INV).map(it => dn(it.id));
const setLevels = (p, levels) => {
    for (const [stat, level] of Object.entries(levels)) {
        p.baseLevels[stat] = level;
        p.levels[stat] = level;
        p.stats[stat] = lib.getExpByLevel(level);
    }
    p.combatLevel = p.getCombatLevel();
};
const clear = (p, invId) => {
    const inv = p.getInventory(invId);
    for (let s = 0; inv && s < inv.capacity; s++) inv.delete(s);
};
const wear = (p, ids) => {
    const w = p.getInventory(InvType.WORN);
    for (const i of ids) w.set(ObjType.get(i).wearpos, { id: i, count: 1 });
};
const ST = { ATTACK: 0, DEFENCE: 1, STRENGTH: 2, HITPOINTS: 3, RANGED: 4, PRAYER: 5, MAGIC: 6, COOKING: 7, WOODCUTTING: 8, FISHING: 10, CRAFTING: 12, SMITHING: 13, MINING: 14 };

// ---- seeds: each new trait a seed of its own; the same name, the same traits ----
{
    const salts = new Map();
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.ts')) {
                for (const m of fs.readFileSync(p, 'utf8').matchAll(/nameSeed\([^,]+,\s*(['`])([^'`]+)\1\)/g)) salts.set(m[2], [...(salts.get(m[2]) ?? []), path.relative(path.join(BOTS_DIR, 'src'), p)]);
            }
        }
    })(path.join(BOTS_DIR, 'src'));
    const PHASE4 = ['gender', 'body', 'taste', 'skiller-look', 'rare', 'holiday', 'top', 'top-stats', 'age', 'kit', 'look', 'tile', 'runes'];
    const NEW = ['combat-style', 'ranger-outfit', 'mage-outfit', 'weapon-kind', 'weapon-dragon', 'weapon-rich', 'skill-clothes', 'tools-in-hand', 'trainer-outfit', 'knight-set', '${salt}-class'];
    // (a salt in one module only: BotAge's start bank and start tile share 'tile', the clothes and the joke 'skill-clothes')
    const reused = [...PHASE4, ...NEW].filter(s => new Set(salts.get(s) ?? []).size !== 1);
    const newOutside = NEW.filter(s => (salts.get(s) ?? []).some(f => !/BotOutfits|BotLooks/.test(f)));
    const different = [];
    for (const name of NAMES.slice(0, 400)) {
        const a = JSON.stringify([O.combatStyleOf(name), O.weaponKindOf(name), O.skillClothesOf(name, 'cooking', true), O.wieldsTools(name), O.rangerPieces(name, 45, 45, true), O.magePieces(name, 65, 45, 45, true, true)]);
        Math.random();
        const b = JSON.stringify([O.combatStyleOf(name), O.weaponKindOf(name), O.skillClothesOf(name, 'cooking', true), O.wieldsTools(name), O.rangerPieces(name, 45, 45, true), O.magePieces(name, 65, 45, 45, true, true)]);
        if (a !== b) different.push(name);
    }
    check("seeds: phase 4's salts each in one module, the new traits' salts new and in port/BotOutfits or BotLooks; the same name gives the same style, weapon kind, clothes and pieces", reused.length === 0 && newOutside.length === 0 && different.length === 0, `${salts.size} salts${reused.length ? `; used not once: ${reused.map(s => `${s} (${(salts.get(s) ?? []).join(', ') || 'none'})`).join('; ')}` : ''}${newOutside.length ? `; outside: ${newOutside.join(', ')}` : ''}${different.length ? `; differ: ${different.slice(0, 3).join(', ')}` : ''}`);
}

// ---- names that promise a class ----
{
    const expect = { 'Wizard Tim': 'mage', 'Elf Archer': 'ranger', 'Arrow Maker': null, 'Bow Stringer': null, 'Pickaxe Pat': 'miner', 'Sir Loin': 'knight', 'Holy Knight': 'knight', 'Holy Moly': 'monk', 'Chef Chloe': 'chef', 'Anvil Annie': 'smith', 'Dread Pirate': 'pirate', 'Magic Logger': 'woodcutter', 'Legolas 234': 'ranger', 'Kevin1991': null, 'Magic Lamp': null };
    const wrong = Object.entries(expect).filter(([n, c]) => O.nameClassOf(norm(n)) !== c).map(([n, c]) => `${n}: ${O.nameClassOf(norm(n))} (want ${c})`);
    const classed = NAMES.filter(n => O.nameClassOf(n));
    const share = pct(classed.length, NAMES.length);
    check('names: a class from the name\'s words (fletchers and traders no rangers, "Magic Logs" no mage), about 1 name in 20', wrong.length === 0 && share >= 3 && share <= 8, `${classed.length} of ${NAMES.length} (${share.toFixed(1)} %)${wrong.length ? `; wrong: ${wrong.join('; ')}` : ''}`);
}

// ---- styles ----
{
    const free = NAMES.filter(n => !O.nameClassOf(n));
    const ranger = pct(free.filter(n => O.combatStyleOf(n) === 'ranger').length, free.length);
    const mage = pct(free.filter(n => O.combatStyleOf(n) === 'mage').length, free.length);
    const forced = NAMES.filter(n => ['mage', 'ranger', 'knight'].includes(O.nameClassOf(n)));
    const off = forced.filter(n => O.combatStyleOf(n) !== { mage: 'mage', ranger: 'ranger', knight: 'melee' }[O.nameClassOf(n)]);
    // the levelling bots' looks: of those without a skiller's look, ranger and mage 18.75 % and 12.5 %; of all, about 12 % and 8 %
    const levelling = NAMES.map((n, i) => [n, lib.PLANNERS[i % lib.PLANNERS.length]]).filter(([, p]) => LEVELLING.has(p));
    const looks = levelling.map(([n, p]) => (Looks.skillerLook(n, p) ? 'skiller' : O.combatStyleOf(n)));
    const share = s => pct(looks.filter(x => x === s).length, looks.length);
    check('styles: ranger and mage by the name\'s dice (18.75 % and 12.5 % of the names without a class), class names forced; of the levelling bots\' looks about 12 % rangers and 8 % mages', Math.abs(ranger - 18.75) <= 3 && Math.abs(mage - 12.5) <= 3 && off.length === 0 && share('ranger') >= 9 && share('ranger') <= 16 && share('mage') >= 5 && share('mage') <= 11, `names: ranger ${ranger.toFixed(1)} %, mage ${mage.toFixed(1)} %; levelling looks: melee ${share('melee').toFixed(1)} %, skiller ${share('skiller').toFixed(1)} %, ranger ${share('ranger').toFixed(1)} %, mage ${share('mage').toFixed(1)} %${off.length ? `; off: ${off.slice(0, 3).join(', ')}` : ''}`);
}

// ---- ladders: 274's levels ----
{
    const bad = [];
    const need = (piece, r, d, m, a) => O.canWearOutfitPiece(piece, r, d, m, a);
    for (const name of NAMES.slice(0, 600)) {
        for (const [r, d] of [[1, 1], [15, 30], [25, 10], [25, 25], [45, 30], [45, 45], [65, 50], [75, 70]]) {
            for (const members of [true, false]) {
                const p = O.rangerPieces(name, r, d, members);
                for (const piece of [p.helm, p.body, p.legs, p.hands, p.feet]) {
                    if (piece === -1) continue;
                    if (!need(piece, r, d, 1, 1)) bad.push(`${name}: ${dn(piece)} at ${r}/${d}`);
                    if (!members && ObjType.get(piece).members) bad.push(`${name}: ${dn(piece)} on a free world`);
                }
            }
        }
        for (const [m, d, a] of [[1, 1, 1], [35, 10, 35], [45, 45, 45], [70, 50, 60]]) {
            for (const members of [true, false]) {
                const p = O.magePieces(name, m, d, a, members, true);
                for (const piece of [p.helm, p.body, p.legs, p.hands, p.feet, p.staff, p.cape, p.neck]) {
                    if (piece === -1) continue;
                    if (!need(piece, 1, d, m, a)) bad.push(`${name}: ${dn(piece)} at ${m}/${d}/${a}`);
                    if (!members && ObjType.get(piece).members) bad.push(`${name}: ${dn(piece)} on a free world`);
                }
            }
        }
    }
    const unpatched = NAMES.slice(0, 600).filter(n => O.rangerPieces(n, 25, 25, false).keepMetal !== 'helm');
    const coif = (600 * unpatched.filter(n => O.rangerPieces(n, 25, 25, false).helm === OI.coif).length) / unpatched.length;
    const studded = NAMES.slice(0, 600).filter(n => O.rangerPieces(n, 25, 25, false).body === OI.studdedBody).length;
    const dhide = NAMES.slice(0, 600).filter(n => O.rangerPieces(n, 45, 45, false).body === OI.dhideBodies[0]).length;
    const wizhat = NAMES.slice(0, 600).filter(n => [OI.blueWizardHat, OI.blackWizardHat].includes(O.magePieces(n, 20, 1, 1, false, false).helm)).length;
    check("ladders: a ranger's and a mage's pieces within 274's levels, members pieces only on a members world; a coif about half at 20 Ranged (of those that keep no metal helm), studded about 6 in 10 at 20/20, green d'hide about half at 40/40, a wizard hat 85 %", bad.length === 0 && Math.abs(coif / 6 - 50) <= 8 && Math.abs(studded / 6 - 60) <= 8 && Math.abs(dhide / 6 - 50) <= 8 && Math.abs(wizhat / 6 - 85) <= 6, `coif ${(coif / 6).toFixed(0)} %, studded ${(studded / 6).toFixed(0)} %, d'hide ${(dhide / 6).toFixed(0)} %, wizard hat ${(wizhat / 6).toFixed(0)} %${bad.length ? `; ${bad.slice(0, 4).join('; ')}` : ''}`);
}

// ---- weapons: the kinds and 274's ladders ----
{
    const counts = new Map();
    for (const n of NAMES) counts.set(O.weaponKindOf(n), (counts.get(O.weaponKindOf(n)) ?? 0) + 1);
    const off = O.WEAPON_KIND_SHARES.filter(([k, s]) => Math.abs(pct(counts.get(k) ?? 0, NAMES.length) - 100 * s) > 3.5);
    // every kind's metals that 274 has (no dragon scimitar, sword, 2h or warhammer), each by its kind and tier
    const missing = [];
    for (const [kind] of O.WEAPON_KIND_SHARES) for (let t = 0; t <= 6; t++) if (!O.weaponOf(kind, t)) missing.push(`${kind} ${t}`);
    const dragons = ['longsword', 'battleaxe', 'mace', 'dagger'].filter(k => O.weaponOf(k, 7)?.tier === 7);
    const misread = O.meleeWeapons().filter(w => O.meleeWeaponOf(w.id) !== w || !/scimitar|sword|mace|battleaxe|warhammer|dagger/.test(dn(w.id)));
    check("weapons: the liked kinds' shares (scimitar 55 %, longsword 14, battleaxe 8, 2h 7, mace 6, sword 5, dagger and warhammer 2.5 each, ±3.5); every kind from bronze to rune, dragon for the longsword, battleaxe, mace and dagger", off.length === 0 && missing.length === 0 && dragons.length === 4 && misread.length === 0, `${[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${pct(n, NAMES.length).toFixed(1)} %`).join(', ')}${missing.length ? `; missing ${missing.join(', ')}` : ''}${misread.length ? `; misread ${misread.length}` : ''}`);
}

// ---- 274's shops: the stock and the keepers ----
{
    const invStock = new Map();
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.inv')) {
                let current = null;
                for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
                    const head = line.match(/^\[(\w+)\]/);
                    if (head) invStock.set((current = head[1]), new Map());
                    const stock = line.match(/^stock\d+=(\w+),(\d+)/);
                    if (stock && current) invStock.get(current).set(stock[1], Number(stock[2]));
                }
            }
        }
    })(path.join(CONTENT_DIR, 'scripts'));
    const SHOP_INV = { AL_KHARID_SCIMITARS: ['scimitarshop'], THESSALIA_CLOTHES: ['clotheshop'], BETTY_MAGIC: ['magicshop'], VARROCK_ARMOUR: ['armourshop'], BOB_AXES: ['axeshop'], VARROCK_SWORDSHOP: ['swordshop'], BRIAN_BATTLEAXES: ['battleaxeshop'], FLYNN_MACES: ['maceshop'], VARROCK_FANCY_DRESS: ['fancyclothesstore'], ZAFF_STAFFS: ['staffshop', 'memberstaffshop'], GAIUS_2H: ['2handedshop'], RELLEKKA_WEAPONS: ['viking_weapons_shop'], RELLEKKA_CLOTHES: ['viking_clothes_shop'], CANIFIS_CLOTHES: ['werewolfstore2'], CHAMPIONS_SCAVVO: ['runiteshop'], CHAMPIONS_VALAINE: ['championshop'], OZIACH: ['runeplateshop'], HEROES_HELEMOS: ['dragonaxeshop'] };
    const candidates = new Set([...O.meleeWeapons().map(w => w.id), ...O.outfitItemIds(), ...Object.values(W).flat()]);
    const bad = [];
    let sold = 0;
    for (const item of candidates) {
        for (const shop of Gear.gearShopsOf(item)) {
            sold++;
            const invs = (SHOP_INV[shop] ?? []).map(k => invStock.get(k)).filter(Boolean);
            if (!invs.length) {
                if (!['BARBARIAN_HELMETS', 'FALADOR_CHAINS', 'AL_KHARID_LEGS', 'RANAEL_SKIRTS', 'FALADOR_SHIELDS'].includes(shop)) bad.push(`${dn(item)} at ${shop}: no .inv known`);
                continue;
            }
            if (!invs.some(inv => inv.get(dn(item)) > 0)) bad.push(`${dn(item)} at ${shop} (${invs.map(inv => inv.get(dn(item)) ?? 'not listed').join('/')})`);
        }
    }
    // the keepers: ShopTripTask knows each, and each stands within 8 tiles of the shop's place (the maps' NPC spawns)
    const npcIds = new Map();
    for (const line of fs.readFileSync(path.join(CONTENT_DIR, 'pack/npc.pack'), 'utf8').split('\n')) {
        const m = line.match(/^(\d+)=(\w+)/);
        if (m) npcIds.set(Number(m[1]), m[2]);
    }
    const spawns = new Map();
    for (const f of fs.readdirSync(path.join(CONTENT_DIR, 'maps'))) {
        const mm = f.match(/^m(\d+)_(\d+)\.jm2$/);
        if (!mm) continue;
        let inNpc = false;
        for (const line of fs.readFileSync(path.join(CONTENT_DIR, 'maps', f), 'utf8').split('\n')) {
            if (line.startsWith('====')) {
                inNpc = line.includes('NPC');
                continue;
            }
            const m = inNpc && line.match(/^(\d+) (\d+) (\d+): (\d+)/);
            if (!m) continue;
            const name = npcIds.get(Number(m[4]));
            if (name) spawns.set(name, [...(spawns.get(name) ?? []), [Number(mm[1]) * 64 + Number(m[2]), Number(mm[2]) * 64 + Number(m[3]), Number(m[1])]]);
        }
    }
    const NEW_SHOPS = ['VARROCK_SWORDSHOP', 'BRIAN_BATTLEAXES', 'FLYNN_MACES', 'VARROCK_FANCY_DRESS', 'ZAFF_STAFFS', 'GAIUS_2H', 'THESSALIA_CLOTHES', 'BETTY_MAGIC'];
    const npcs = lib.ShopTripTask.NPC_NAMES ?? {};
    const far = [];
    for (const key of NEW_SHOPS) {
        const npc = npcs[key];
        const [x, z, level] = Gear.WARDROBE_SHOPS[key].location;
        const at = (spawns.get(npc) ?? []).find(([sx, sz, sl]) => sl === level && Math.max(Math.abs(sx - x), Math.abs(sz - z)) <= 8);
        if (!npc || !at) far.push(`${key} (${npc ?? 'no keeper'}: ${JSON.stringify(spawns.get(npc) ?? [])})`);
    }
    check("shops: every weapon and outfit piece a bot buys is in 274's stock with some in it; each new shop's keeper known to ShopTripTask, standing within 8 tiles of its place", sold > 50 && bad.length === 0 && far.length === 0, `${sold} item-shops${bad.length ? `; ${bad.slice(0, 4).join('; ')}` : ''}${far.length ? `; keepers: ${far.join('; ')}` : ''}`);
}

// ---- purchases ----
{
    const find = pred => NAMES.find(n => pred(n));
    const melee = n => !O.nameClassOf(n) && O.combatStyleOf(n) === 'melee';
    const buyer = (name, levels, at = [3213, 3424]) => {
        const p = lib.freshBot(name, 'fighter');
        setLevels(p, levels);
        [p.x, p.z] = at;
        p.getInventory(lib.bankId()).add(I.COINS, 60_000);
        return p;
    };
    const longName = find(n => melee(n) && O.weaponKindOf(n) === 'longsword');
    const long = Gear.nextGearUpgrade(buyer(longName, { 0: 20, 1: 1, 2: 20 }), lib.SCIMITAR_TIERS);
    const axeName = find(n => melee(n) && O.weaponKindOf(n) === 'battleaxe');
    const axeLumb = Gear.nextGearUpgrade(buyer(axeName, { 0: 20, 1: 1, 2: 20 }, [3222, 3218]), lib.SCIMITAR_TIERS);
    const axeSarim = Gear.nextGearUpgrade(buyer(axeName, { 0: 20, 1: 1, 2: 20 }, [3027, 3250]), lib.SCIMITAR_TIERS);
    // a weapon of its liked kind owned: no sidegrade, no worse
    const owner = buyer(longName, { 0: 20, 1: 1, 2: 20 });
    owner.getInventory(lib.bankId()).add(id('mithril_longsword'), 1);
    const ownerNext = Gear.nextGearUpgrade(owner, lib.SCIMITAR_TIERS);
    // a ranger: its weapon owned, then a leather body (Ranged 10) and studded at 20/20
    const rangerName = find(n => !O.nameClassOf(n) && O.combatStyleOf(n) === 'ranger' && O.rangerPieces(n, 10, 5, true).body !== -1 && O.rangerPieces(n, 25, 25, true).body !== -1 && O.rangerPieces(n, 25, 25, true).legs !== -1);
    const r1 = buyer(rangerName, { 0: 5, 1: 5, 2: 5, 4: 10 });
    r1.getInventory(lib.bankId()).add(O.weaponOf(O.weaponKindOf(rangerName), 2)?.id ?? I.STEEL_SCIMITAR, 1);
    const rLow = Gear.nextGearUpgrade(r1, lib.SCIMITAR_TIERS);
    const r2 = buyer(rangerName, { 0: 20, 1: 25, 2: 20, 4: 25 });
    r2.getInventory(lib.bankId()).add(O.weaponOf(O.weaponKindOf(rangerName), 4)?.id ?? I.MITHRIL_SCIMITAR, 1);
    const rMid = Gear.nextGearUpgrade(r2, lib.SCIMITAR_TIERS);
    r2.getInventory(lib.bankId()).add(OI.studdedBody, 1);
    const rLegs = Gear.nextGearUpgrade(r2, lib.SCIMITAR_TIERS);
    // a mage: a wizard hat and a skirt
    const mageName = find(n => !O.nameClassOf(n) && O.combatStyleOf(n) === 'mage' && O.magePieces(n, 25, 1, 1, true, false).helm !== -1 && [OI.blueSkirt, OI.blackSkirt].includes(O.magePieces(n, 25, 1, 1, true, false).legs));
    const m1 = buyer(mageName, { 0: 5, 1: 1, 2: 5, 6: 25 });
    m1.getInventory(lib.bankId()).add(O.weaponOf(O.weaponKindOf(mageName), 2)?.id ?? I.STEEL_SCIMITAR, 1);
    const mHat = Gear.nextGearUpgrade(m1, lib.SCIMITAR_TIERS);
    if (mHat) m1.getInventory(lib.bankId()).add(mHat.itemId, 1);
    const mSkirt = Gear.nextGearUpgrade(m1, lib.SCIMITAR_TIERS);
    // a cook's white apron on a wardrobe trip
    const cookName = find(n => O.skillClothesOf(n, 'cooking', false).whiteApron && !Looks.skillerLook(n, 'fighter'));
    const cook = buyer(cookName, { 7: 40 });
    const apron = Gear.nextOutfitPiece(cook, 1000);
    const poor = lib.freshBot(longName, 'fighter');
    setLevels(poor, { 0: 20 });
    poor.getInventory(InvType.INV).add(I.COINS, 90);
    const show = b => (b ? `${dn(b.itemId)} (${b.shopKey})` : 'none');
    const ok =
        long?.itemId === id('mithril_longsword') && long.shopKey === 'VARROCK_SWORDSHOP' && axeLumb?.itemId === id('mithril_battleaxe') && axeLumb.shopKey === 'BOB_AXES' && axeSarim?.shopKey === 'BRIAN_BATTLEAXES' &&
        !(O.meleeWeaponOf(ownerNext?.itemId ?? -1)) &&
        rLow?.itemId === OI.leatherBody && rLow.shopKey === 'THESSALIA_CLOTHES' && rMid?.itemId === OI.studdedBody && rMid.shopKey === 'VARROCK_ARMOUR' && rLegs?.itemId === OI.studdedChaps &&
        [OI.blueWizardHat, OI.blackWizardHat].includes(mHat?.itemId) && [OI.blueSkirt, OI.blackSkirt].includes(mSkirt?.itemId) &&
        apron?.itemId === W.whiteApron && Gear.nextGearUpgrade(poor, lib.SCIMITAR_TIERS) === null;
    check("purchases: a longsword-liker's at Varrock's sword shop, a battleaxe-liker's at the nearer of Bob's and Brian's, no weapon below one it owns; a ranger's leather then studded body and chaps; a mage's wizard hat and skirt; a cook's white apron; nothing below the reserve", ok, `${longName}: ${show(long)}; ${axeName}: ${show(axeLumb)} by Lumbridge, ${show(axeSarim)} by Port Sarim; owner next ${show(ownerNext)}; ranger ${rangerName}: ${show(rLow)}, ${show(rMid)}, ${show(rLegs)}; mage ${mageName}: ${show(mHat)}, ${show(mSkirt)}; cook ${cookName}: ${show(apron)}`);
}

// ---- new bots' kits over 1,600 names ----
const STARTER = new Set(['bronze_axe', 'bronze_pickaxe', 'bronze_sword', 'bronze_scimitar', 'iron_axe', 'iron_scimitar']);
const aged = [];
{
    for (let i = 0; i < 1600; i++) {
        const name = NAMES[i];
        const planner = lib.PLANNERS[i % lib.PLANNERS.length];
        const p = lib.freshBot(name, planner);
        lib.BotAppearance.randomize(p);
        const tier = Age.applyAge(p, name, planner, true);
        aged.push({ name, planner, tier, p, worn: wornNames(p), bank: bankNames(p), pack: packNames(p) });
    }
    const real = aged.filter(a => a.tier !== 'newcomer' && !a.planner.includes('pker'));
    // weapons: the levelling bots' melee weapons in hand
    const levMelee = real.filter(a => LEVELLING.has(a.planner) && /scimitar|sword|mace|battleaxe|warhammer|dagger/.test(a.worn[3] ?? ''));
    const kinds = new Map();
    for (const a of levMelee) {
        const k = a.worn[3].replace(/^(bronze|iron|steel|black|mithril|adamant|adamnt|rune|dragon)_/, '');
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    const scim = pct(kinds.get('scimitar') ?? 0, levMelee.length);
    const dragonOff = real.filter(a => (a.worn[3] ?? '').startsWith('dragon_') && (a.tier !== 'veteran' || a.p.baseLevels[0] < 60));
    check("kits: of the levelling bots' melee weapons in hand 45-70 % scimitars, 6+ kinds; dragon weapons only on veterans of 60 Attack", scim >= 45 && scim <= 70 && kinds.size >= 6 && dragonOff.length === 0, `${scim.toFixed(1)} % of ${levMelee.length}: ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}${dragonOff.length ? `; dragon off: ${dragonOff.slice(0, 3).map(a => `${a.name} ${a.worn[3]}`).join(', ')}` : ''}`);
    // rangers and mages without a skiller's look
    const styled = s => real.filter(a => LEVELLING.has(a.planner) && (O.nameClassOf(a.name) === s || (!O.nameClassOf(a.name) && !Looks.skillerLook(a.name, a.planner) && O.combatStyleOf(a.name) === s)));
    const rangers = styled('ranger');
    // (an archer's name holds its bow; a ranger by the dice keeps its weapon in hand, the bow banked: a bow in hand makes
    // a Duel Arena visitor a watcher)
    const badR = rangers.filter(a => /_(platebody|chainbody)$/.test(a.worn[4] ?? '') || (O.nameClassOf(a.name) === 'ranger' ? !/bow$/.test(a.worn[3] ?? (a.worn.includes('scythe') ? 'bow' : '')) : /bow$/.test(a.worn[3] ?? '')));
    const mages = styled('mage');
    const badM = mages.filter(a => [0, 4, 5, 7].some(s => a.worn[s] && Looks.armourPieceOf(id(a.worn[s]))) || !/staff/.test(a.worn[3] ?? (a.worn.includes('scythe') ? 'staff' : '')));
    const mageDressed = pct(mages.filter(a => /wizhat/.test(a.worn[0] ?? '') || /robe|splitbark/.test(a.worn[4] ?? '')).length, mages.length);
    check("kits: a ranger's wears no metal body (an archer's name holds a bow, the rest their weapon), a mage's no metal, a staff in hand, most in a wizard hat or robe", rangers.length > 20 && mages.length > 15 && badR.length === 0 && badM.length === 0 && mageDressed >= 80, `${rangers.length} rangers (e.g. ${rangers.slice(0, 2).map(a => `${a.name}: ${a.worn.filter(Boolean).join(' ')}`).join(' | ')}), ${mages.length} mages (${mageDressed.toFixed(0)} % in a hat or robe; e.g. ${mages.slice(0, 2).map(a => `${a.name}: ${a.worn.filter(Boolean).join(' ')}`).join(' | ')})${badR.length ? `; rangers off: ${badR.slice(0, 2).map(a => `${a.name}: ${a.worn.filter(Boolean).join(' ')}`).join(' | ')}` : ''}${badM.length ? `; mages off: ${badM.slice(0, 2).map(a => `${a.name}: ${a.worn.filter(Boolean).join(' ')}`).join(' | ')}` : ''}`);
    // class names in their class's look (their kits); chef's hats only on cooks, chefs' names and the joke
    const named = real.filter(a => O.nameClassOf(a.name) && !(O.nameClassOf(a.name) === 'pirate'));
    const inLook = named.filter(a => O.inClassLook(a.name, (() => { const w = a.p.getInventory(InvType.WORN); const ids = []; for (let s = 0; s < 14; s++) ids.push(w.get(s)?.id ?? -1); return ids; })(), true));
    const hats = real.filter(a => a.worn[0] === 'chefs_hat');
    const offHats = hats.filter(a => !O.skillClothesOf(a.name, O.mainSkillOf(a.p.baseLevels), O.prayerTrainer(a.p.baseLevels)).chefsHat);
    check("kits: names that promise a class in its look (90 %+), chef's hats only on cooks, chefs' names and the joke", pct(inLook.length, named.length) >= 90 && offHats.length === 0, `${inLook.length} of ${named.length} named (${pct(inLook.length, named.length).toFixed(0)} %): ${named.filter(a => !inLook.includes(a)).slice(0, 3).map(a => `${a.name} (${O.nameClassOf(a.name)}): ${a.worn.filter(Boolean).join(' ')}`).join(' | ')}; ${hats.length} chef's hats${offHats.length ? `, off: ${offHats.slice(0, 3).map(a => a.name).join(', ')}` : ''}`);
    // BUG-c: no social or vendor bot of combat 20+ holds a starter tool (a trade's tool for a miner's or woodcutter's name)
    const cosmetic = real.filter(a => COSMETIC.has(a.planner) && a.p.combatLevel >= 20);
    const starter = cosmetic.filter(a => STARTER.has(a.worn[3] ?? '') && !['miner', 'woodcutter'].includes(O.nameClassOf(a.name)));
    check('kits (BUG-c): no social or vendor bot of combat 20+ holds a starter tool (a miner\'s or woodcutter\'s name its trade\'s tool)', cosmetic.length > 50 && starter.length === 0, `${cosmetic.length} social and vendor bots of combat 20+, ${cosmetic.filter(a => !a.worn[3]).length} empty-handed${starter.length ? `; ${starter.slice(0, 3).map(a => `${a.name} cb ${a.p.combatLevel}: ${a.worn[3]}`).join(', ')}` : ''}`);
}

// ---- PKers ----
{
    const mageName = NAMES.find(n => O.nameClassOf(n) === 'mage');
    const rangerName = NAMES.find(n => O.nameClassOf(n) === 'ranger');
    const plain = NAMES.find(n => !O.nameClassOf(n));
    const m = lib.pkerProfileFor(mageName);
    const r = lib.pkerProfileFor(rangerName);
    const e = lib.edgevillePkerProfileFor(mageName);
    const profiles = lib.generatePkerProfiles();
    // its build as before: the profile of its name's pick, but for the helm and body (and since the variety work's round 2,
    // track W2: WEAR-8, its outfit: gloves, boots, amulet, legs, weapon and shield vary from the profile's own seed; since
    // the PK tactics, 2026-10-19, its fight's kit too: port/BotPkFight pkKitted's KO weapon, bow, arrows, potions, way out)
    const OUTFIT = { helm: 0, body: 0, gloves: 0, boots: 0, neck: 0, legs: 0, weapon: 0, shield: 0, specWeapon: 0, rangeWeapon: 0, ammo: 0, pots: 0, style: 0, ammoCount: 0, tele: 0, magic: 0 };
    const same = (got, name) => {
        const base = profiles.find(p => p.name === got.name);
        return !!base && JSON.stringify({ ...base, ...OUTFIT }) === JSON.stringify({ ...got, ...OUTFIT });
    };
    const freePure = lib.freeWorldPkProfiles().find(p => p.def === 1);
    const free = O.classPkProfile(rangerName, freePure, 'pker');
    const ok = same(m, mageName) && same(r, rangerName) && [OI.blueWizardHat, OI.blackWizardHat].includes(m.helm) && (m.def < 40 ? m.body === OI.monkRobeTop : m.body !== OI.monkRobeTop) && [OI.blueWizardHat, OI.blackWizardHat].includes(e.helm) && r.helm === OI.coif && (r.def < 40 ? r.body === OI.leatherBody : r.body === OI.dhideBodies[0]) && free?.body === OI.leatherBody && !ObjType.get(free.helm).members && O.classPkProfile(plain, profiles[0], 'pker') === null && JSON.stringify(lib.pkerProfileFor(plain)) === JSON.stringify(lib.pkerProfileFor(plain));
    check("PKers: a mage's name in a wizard hat (a pure's the monk's robe: the hybrid pure), an archer's in a coif (a pure's leather, a main's green d'hide), their builds as before (the outfit's other pieces vary since round 2); other names as before", ok, `${mageName}: ${m.name} def ${m.def} ${dn(m.helm)} ${dn(m.body)}; edgeville ${e.name} ${dn(e.helm)}; ${rangerName}: ${r.name} def ${r.def} ${dn(r.helm)} ${dn(r.body)}; free world pure ${dn(free?.helm)} ${dn(free?.body)}`);
    // (the fixes: the integrator's rule) the class's look for a PKer new since this rule (no save at its login) or saved in
    // it; a PKer saved before keeps the profile as it was (its helm and body)
    {
        const base = profiles.find(p => p.name === m.name);
        const cls = O.classPkProfile(mageName, base, 'pker');
        const fresh = O.pkProfileAtLogin(mageName, base, 'pker', false, () => false);
        const old = O.pkProfileAtLogin(mageName, base, 'pker', true, id => id === base.helm || id === base.body);
        const inLook = O.pkProfileAtLogin(mageName, base, 'pker', true, id => id === cls.helm);
        const plainSaved = O.pkProfileAtLogin(plain, profiles[0], 'pker', true, () => false);
        check("PKers: a mage's name new since round 1 in its class's look; one saved before keeps its profile's helm and body; one saved in the class's look keeps that; other names as before", fresh === cls && old === base && inLook === cls && plainSaved === profiles[0] && cls.helm !== base.helm, `${mageName}: new ${dn(fresh.helm)} ${dn(fresh.body)}; saved before ${dn(old.helm)} ${dn(old.body)}; saved in the look ${dn(inLook.helm)}`);
    }
}

// ---- in the world: staged bots ----
lib.setHangoutRateForTest(0);
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0 });
lib.setCliqueBehaviourForTest(false);
lib.resetDirectorForTest();
lib.setDirectorForTest({ first: 1e9 });
lib.setEventRatesForTest({ odds: 0 });
lib.setArenaRatesForTest(0);
const taskKind = p => (sim.botPlayer(p)?.currentTask?.name ?? 'none').split(':')[0];
const run = (ticks, each) => {
    for (let i = 0; i < ticks; i++) {
        sim.tick();
        if (each?.() === true) return true;
    }
    return false;
};
run(30);
const used = new Set();
/** a staged bot: a levelling bot, no newbie, no sub-task; clean pack, worn and bank; full run energy; at a tile */
function stage(pred, levels, at) {
    const p = sim.bots().find(b => !used.has(b) && b.botNewbie !== true && lib.isLevelling(b.botPlanner) && b.level === 0 && !sim.botPlayer(b)?.subTask && pred(b.username));
    if (!p) return null;
    used.add(p);
    setLevels(p, levels);
    clear(p, InvType.WORN);
    clear(p, InvType.INV);
    clear(p, lib.bankId());
    p.runenergy = 10000;
    p.clearPendingAction();
    p.clearWaypoints();
    p.teleJump(at[0], at[1], 0);
    return p;
}
const give = (p, invId, items) => {
    for (const [i, n] of items) p.getInventory(invId).add(i, n);
};
const assign = (p, task) => {
    const bot = sim.botPlayer(p);
    bot.planner.pickTask = () => task;
    bot.currentTask?.interrupt();
};

// ---- loot (BUG-a) and the weapon at a fight's bank (BUG-b): in the world, the real wear op ----
{
    const p = stage(() => true, { 0: 40, 1: 30, 2: 30, 3: 30 }, [3185, 3436]);
    let detail = 'no bot';
    let ok = false;
    if (p) {
        sim.botPlayer(p).planner.pickTask = () => null;
        sim.botPlayer(p).currentTask?.interrupt();
        run(2);
        wear(p, [I.IRON_PLATEBODY, I.IRON_SCIMITAR]);
        give(p, InvType.INV, [[id('black_robe'), 1], [I.RUNE_AXE, 1]]);
        p.clearPendingAction();
        lib._equipLoot(p);
        const afterRobe = wornNames(p);
        give(p, InvType.INV, [[id('mithril_longsword'), 1]]);
        lib._equipLoot(p);
        const afterSword = wornNames(p);
        // BUG-b: a mithril 2h in the bank beats the iron scimitar it holds (its shield to the bank)
        clear(p, InvType.WORN);
        clear(p, InvType.INV);
        wear(p, [I.IRON_SCIMITAR, I.IRON_SQ_SHIELD]);
        give(p, lib.bankId(), [[id('mithril_2h_sword'), 1]]);
        const task = new lib.CombatTask(lib.SkillProgression.ATTACK[0], 0);
        task._withdrawAndEquipWeapon(p);
        const twoH = wornNames(p);
        const banked2h = bankNames(p);
        // the liked kind at a metal: a mithril one of its kind in the bank for a mithril weapon of another kind in hand
        const liked = O.weaponKindOf(p.username);
        const other = liked === 'scimitar' ? 'longsword' : 'scimitar';
        clear(p, InvType.WORN);
        clear(p, lib.bankId());
        wear(p, [O.weaponOf(other, 4).id]);
        give(p, lib.bankId(), [[O.weaponOf(liked, 4).id, 1]]);
        task._withdrawAndEquipWeapon(p);
        const likedHeld = wornNames(p)[3];
        // an axe in hand (from the trees): to the bank, its black scimitar on
        clear(p, InvType.WORN);
        clear(p, lib.bankId());
        wear(p, [I.RUNE_AXE]);
        give(p, lib.bankId(), [[I.BLACK_SCIMITAR, 1]]);
        task._withdrawAndEquipWeapon(p);
        const axeOff = wornNames(p)[3];
        const axeBanked = bankNames(p).includes('rune_axe');
        ok = afterRobe[4] === 'iron_platebody' && afterRobe[3] === 'iron_scimitar' && afterSword[3] === 'mithril_longsword' && twoH[3] === 'mithril_2h_sword' && !twoH[5] && banked2h.includes('iron_scimitar') && banked2h.includes('iron_sq_shield') && likedHeld === dn(O.weaponOf(liked, 4).id) && axeOff === 'black_scimitar' && axeBanked;
        detail = `${p.username}: a black robe and a rune axe in the pack: ${afterRobe[4]}, ${afterRobe[3]}; a mithril longsword: ${afterSword[3]}; a mithril 2h in the bank: ${twoH.filter(Boolean).join(' ')} (bank ${banked2h.join(', ')}); likes ${liked}: ${likedHeld}; a rune axe in hand: ${axeOff}${axeBanked ? ', the axe banked' : ''}`;
    }
    check("loot (BUG-a) and a fight's weapon (BUG-b): a looted Black robe never over an iron platebody, a rune axe never wielded over a scimitar, a mithril longsword is; the bank's mithril 2h over the iron scimitar (its shield banked); the liked kind at a metal; an axe in hand to the bank", ok, detail);
}

// ---- dressing (pure: a bot not in the world, its task a stand-in) ----
{
    // a ranged fight: the metal body to the bank, the ranger's pieces on; a patchwork helm kept; a magic fight: no metal
    const rName = NAMES.find(n => O.rangerPieces(n, 30, 30, true).keepMetal === null && LEVELLING.has('fighter'));
    const r = lib.freshBot(rName, 'fighter');
    setLevels(r, { 1: 30, 4: 30 });
    wear(r, [I.STEEL_FULL_HELM, I.STEEL_PLATEBODY, I.STEEL_PLATELEGS, I.STEEL_KITESHIELD]);
    give(r, lib.bankId(), [[OI.studdedBody, 1], [OI.coif, 1], [OI.leatherChaps, 1], [OI.leatherVambraces, 1]]);
    Gear.dressForMode(r, 'ranged');
    const rw = wornNames(r);
    const patchName = NAMES.find(n => O.rangerPieces(n, 30, 30, true).keepMetal === 'helm');
    const pr = lib.freshBot(patchName, 'fighter');
    setLevels(pr, { 1: 30, 4: 30 });
    wear(pr, [I.STEEL_FULL_HELM, I.STEEL_PLATEBODY]);
    give(pr, lib.bankId(), [[OI.leatherBody, 1]]);
    Gear.dressForMode(pr, 'ranged');
    const prw = wornNames(pr);
    const m = lib.freshBot(NAMES[5], 'balanced');
    setLevels(m, { 1: 30, 6: 30 });
    wear(m, [I.STEEL_FULL_HELM, I.STEEL_PLATEBODY, I.STEEL_PLATELEGS, I.STEEL_KITESHIELD]);
    give(m, lib.bankId(), [[OI.blueWizardHat, 1], [OI.wizardRobe, 1], [OI.blueSkirt, 1]]);
    const needs = Gear.needsModeDress(m, 'magic');
    Gear.dressForMode(m, 'magic');
    const mw = wornNames(m);
    // a signature hat stays at a magic fight
    const s = lib.freshBot(NAMES[6], 'balanced');
    wear(s, [W.santaHat, I.IRON_PLATEBODY]);
    give(s, lib.bankId(), [[OI.blueWizardHat, 1]]);
    Gear.dressForMode(s, 'magic');
    const sw = wornNames(s);
    // the other style's pieces for this fight's, when it owns them: a ranger's coif and studded for its wizard hat and robe
    const x = lib.freshBot(rName, 'fighter');
    setLevels(x, { 1: 30, 4: 30, 6: 30 });
    wear(x, [OI.coif, OI.studdedBody]);
    give(x, lib.bankId(), [[OI.blackWizardHat, 1], [OI.blackRobe, 1]]);
    Gear.dressForMode(x, 'magic');
    const xw = wornNames(x);
    const ok = xw[0] === 'blackwizhat' && xw[4] === 'black_robe' && bankNames(x).includes('coif') && rw[4] === 'studded_body' && rw[0] === 'coif' && rw[7] === 'leather_chaps' && rw[9] === 'leather_vambraces' && !rw[5] && prw[0] === 'steel_full_helm' && prw[4] === 'leather_armour' && needs && mw[0] === 'bluewizhat' && mw[4] === 'wizards_robe' && mw[7] === 'blue_skirt' && !mw[5] && sw[0] === 'santa_hat' && !sw[4];
    check("modes: a ranged fight's outfit without a metal body (coif, studded, chaps, vambraces on; no shield), a patchwork helm kept; a magic fight's without metal (hat, robe, skirt); a signature hat stays; a ranger's coif and studded for its wizard hat and robe at a magic fight", ok, `ranger ${rName}: ${rw.filter(Boolean).join(' ')}; patchwork ${patchName}: ${prw.filter(Boolean).join(' ')}; mage: ${mw.filter(Boolean).join(' ')} (needed the bank: ${needs}); santa: ${sw.filter(Boolean).join(' ')}; a ranger at a magic fight: ${xw.filter(Boolean).join(' ')}`);
}
{
    // the chef's hat: at the range on, elsewhere to the bank (a wizard hat instead)
    const cName = NAMES.find(n => !O.chefsHatAnywhere(n));
    const c = lib.freshBot(cName, 'skiller');
    give(c, lib.bankId(), [[W.chefsHat, 1], [W.wizardHat, 1], [W.whiteApron, 1]]);
    lib.setTask(c, 'Cook:315');
    Gear.dressForSkill(c);
    const atRange = wornNames(c);
    lib.setTask(c, 'Fish:317');
    clear(c, InvType.WORN);
    wear(c, [W.chefsHat]);
    Gear.dressForSkill(c);
    const atSea = wornNames(c);
    // the axe in a wielder's hand at the trees (the best its Attack allows), the scimitar to the bank; back elsewhere
    const wName = NAMES.find(n => O.wieldsTools(n) && !O.nameClassOf(n));
    const wc = lib.freshBot(wName, 'skiller');
    setLevels(wc, { 0: 30, 8: 45, 14: 45 });
    wear(wc, [I.MITHRIL_SCIMITAR]);
    give(wc, InvType.INV, [[I.STEEL_AXE, 1]]);
    give(wc, lib.bankId(), [[I.RUNE_AXE, 1], [I.ADAMANT_AXE, 1]]);
    lib.setTask(wc, 'Woodcut:1515');
    Gear.dressForSkill(wc);
    const atTrees = wornNames(wc);
    const treesBank = bankNames(wc);
    lib.setTask(wc, 'Fish:317');
    Gear.dressForSkill(wc);
    const away = wornNames(wc);
    const awayPack = packNames(wc);
    const nonName = NAMES.find(n => !O.wieldsTools(n) && !O.nameClassOf(n));
    const nw = lib.freshBot(nonName, 'skiller');
    setLevels(nw, { 0: 30 });
    wear(nw, [I.MITHRIL_SCIMITAR]);
    give(nw, InvType.INV, [[I.STEEL_AXE, 1]]);
    lib.setTask(nw, 'Woodcut:1515');
    Gear.dressForSkill(nw);
    const notWielder = wornNames(nw)[3];
    // a crafter wears the leather it made (from its pack); Agility takes the plate off
    const cr = lib.freshBot(NAMES[9], 'skiller');
    wear(cr, [I.STEEL_PLATEBODY]);
    give(cr, InvType.INV, [[OI.leatherBody, 3], [OI.leatherChaps, 2], [OI.leatherVambraces, 1]]);
    lib.setTask(cr, 'Crafting');
    Gear.dressForSkill(cr);
    const crafter = wornNames(cr);
    const ag = lib.freshBot(NAMES[10], 'balanced');
    wear(ag, [I.STEEL_PLATEBODY, I.STEEL_PLATELEGS]);
    lib.setTask(ag, 'Agility');
    Gear.dressForSkill(ag);
    const agility = wornNames(ag);
    const ok = atRange[0] === 'chefs_hat' && atRange[4] === 'white_apron' && atSea[0] === 'bluewizhat' && bankNames(c).includes('chefs_hat') && atTrees[3] === 'adamant_axe' && treesBank.includes('mithril_scimitar') && away[3] === 'mithril_scimitar' && awayPack.includes('adamant_axe') && notWielder === 'mithril_scimitar' && crafter[4] === 'leather_armour' && crafter[7] === 'leather_chaps' && crafter[9] === 'leather_vambraces' && !agility[4] && !agility[7];
    check("at a skill: the chef's hat at the range, to the bank elsewhere; a wielder's best axe for its Attack in hand at the trees (scimitar banked), back in the pack elsewhere; a crafter wears the leather it made; Agility takes the plate off", ok, `cook ${cName}: ${atRange.filter(Boolean).join(' ')}; fishing ${atSea.filter(Boolean).join(' ')}; wielder ${wName} at the trees ${atTrees.filter(Boolean).join(' ')}, fishing ${away.filter(Boolean).join(' ')} (pack ${awayPack.join(', ')}); ${nonName} ${notWielder}; crafter ${crafter.filter(Boolean).join(' ')}; agility ${agility.filter(Boolean).join(' ') || 'nothing'}`);
    // (the fixes, the reviewer's) the axe back in the pack with a two-hander its best weapon and a wooden shield on (a
    // skill's plate off leaves it): the shield to the bank first, never a 2h over a shield
    const tw = lib.freshBot(NAMES.find(n => O.wieldsTools(n) && !O.nameClassOf(n) && n !== wName), 'skiller');
    setLevels(tw, { 0: 30, 8: 45 });
    wear(tw, [I.STEEL_AXE, I.WOODEN_SHIELD]);
    give(tw, lib.bankId(), [[I.MITHRIL_2H_SWORD, 1]]);
    lib.setTask(tw, 'Fish:317');
    Gear.dressForSkill(tw);
    const twWorn = wornNames(tw);
    check('at a skill: an axe stowed with a two-hander its best weapon and a wooden shield on: the 2h in hand, the shield to the bank (never both)', twWorn[3] === 'mithril_2h_sword' && !twWorn[5] && bankNames(tw).includes('wooden_shield') && packNames(tw).includes('steel_axe'), `${twWorn.filter(Boolean).join(' ')}; bank ${bankNames(tw).join(', ')}; pack ${packNames(tw).join(', ')}`);
}

// ---- in the world: a wielder woodcutter, a plated firemaker, a plated agility bot, a ranged fight's bank ----
{
    const p = stage(n => O.wieldsTools(n), { 0: 30, 1: 30, 2: 30, 3: 30, 8: 35 }, [3092, 3243]);
    let detail = 'no wielder among the bots';
    let ok = false;
    if (p) {
        wear(p, [I.ADAMANT_SCIMITAR]);
        give(p, InvType.INV, [[I.STEEL_AXE, 1]]);
        for (let i = 0; i < 27; i++) give(p, InvType.INV, [[I.WILLOW_LOGS, 1]]);
        const willows = lib.SkillProgression.WOODCUTTING.find(s => s.itemGained === I.WILLOW_LOGS && Math.abs(s.location[0] - 3088) < 30 && Math.abs(s.location[1] - 3235) < 30) ?? lib.SkillProgression.WOODCUTTING.find(s => s.itemGained === I.WILLOW_LOGS);
        assign(p, new lib.WoodcuttingTask(willows));
        const xp0 = p.stats[8];
        let wieldedAt = -1;
        let chopped = -1;
        run(700, () => {
            if (wieldedAt < 0 && wornNames(p)[3] === 'steel_axe') wieldedAt = World.currentTick;
            if (wieldedAt >= 0 && p.stats[8] > xp0 && wornNames(p)[3] === 'steel_axe') {
                chopped = World.currentTick;
                return true;
            }
        });
        const trees = wornNames(p);
        const step = lib.SkillProgression.ATTACK.find(s => s.extra?.npcType === 'chicken') ?? lib.SkillProgression.ATTACK[0];
        assign(p, new lib.CombatTask(step, 0));
        let backAt = -1;
        run(700, () => {
            if (taskKind(p) === 'Combat' && wornNames(p)[3] === 'adamant_scimitar') {
                backAt = World.currentTick;
                return true;
            }
        });
        ok = wieldedAt >= 0 && chopped >= 0 && backAt >= 0;
        detail = `${p.username}: the axe in hand at t${wieldedAt}, chopping with it at t${chopped} (${trees.filter(Boolean).join(' ')}); its fight's scimitar back at t${backAt} (bank: ${bankNames(p).filter(n => /axe|scimitar/.test(n)).join(', ')})`;
    }
    check('in the world: a wielder woodcutter takes its axe in hand at its bank stop and chops with it; its fight puts its scimitar back', ok, detail);
}
{
    const p = stage(() => true, { 0: 30, 1: 30, 2: 30, 3: 30, 11: 30 }, [3185, 3436]);
    let detail = 'no bot';
    let ok = false;
    if (p) {
        wear(p, [I.ADAMANT_FULL_HELM, I.ADAMANT_PLATEBODY, I.ADAMANT_PLATELEGS, I.ADAMANT_SCIMITAR]);
        give(p, InvType.INV, [[I.TINDERBOX, 1]]);
        for (let i = 0; i < 20; i++) give(p, InvType.INV, [[I.OAK_LOGS, 1]]);
        const step = lib.SkillProgression.FIREMAKING.find(s => s.itemConsumed === I.OAK_LOGS && Math.abs(s.location[0] - 3185) < 60 && Math.abs(s.location[1] - 3436) < 60) ?? lib.SkillProgression.FIREMAKING.find(s => s.itemConsumed === I.OAK_LOGS);
        assign(p, new lib.FiremakingTask(step));
        let banked = -1;
        let litPlated = 0;
        let lit = -1;
        const xp0 = p.stats[11];
        run(600, () => {
            const state = sim.botPlayer(p)?.currentTask?.state;
            if (banked < 0 && !wornNames(p)[4]) banked = World.currentTick;
            if ((state === 'burn' || state === 'wait_burn') && /platebody/.test(wornNames(p)[4] ?? '')) litPlated++;
            if (p.stats[11] > xp0) {
                lit = World.currentTick;
                return true;
            }
        });
        ok = banked >= 0 && lit >= 0 && litPlated === 0;
        detail = `${p.username}: the plate off at t${banked}, a fire lit at t${lit}, ${litPlated} burn ticks in plate (${wornNames(p).filter(Boolean).join(' ')})`;
    }
    check('in the world: a firemaker in plate with its logs stops at its bank first (the plate off) and lights its logs without it', ok, detail);
}
{
    const p = stage(() => true, { 0: 30, 1: 30, 2: 30, 3: 30, 16: 40 }, [2725, 3485]);
    let detail = 'no bot';
    let ok = false;
    if (p) {
        wear(p, [I.STEEL_PLATEBODY, I.STEEL_PLATELEGS, I.STEEL_SCIMITAR]);
        const step = lib.SkillProgression.AGILITY?.[0];
        if (step) {
            assign(p, new lib.AgilityTask(step));
            let off = -1;
            run(200, () => {
                if (!wornNames(p)[4] && !wornNames(p)[7]) {
                    off = World.currentTick;
                    return true;
                }
            });
            ok = off >= 0 && bankNames(p).includes('steel_platebody');
            detail = `${p.username} at Seers' bank, its course at ${step.location.join(',')}: the plate off at t${off} (${wornNames(p).filter(Boolean).join(' ')})`;
        } else detail = 'no agility step';
    }
    check('in the world: an agility bot in plate stops at the bank nearest it first (the plate off), not on the course', ok, detail);
}
{
    const p = stage(n => O.rangerPieces(n, 30, 30, true).keepMetal === null, { 0: 30, 1: 30, 2: 30, 3: 30, 4: 30 }, [3185, 3436]);
    let detail = 'no bot';
    let ok = false;
    if (p) {
        wear(p, [I.STEEL_FULL_HELM, I.STEEL_PLATEBODY, I.STEEL_SCIMITAR]);
        give(p, lib.bankId(), [[I.SHORTBOW, 1], [I.BRONZE_ARROW, 500], [OI.leatherBody, 1], [I.COINS, 5000], [I.TROUT, 10]]);
        const step = lib.SkillProgression.RANGED?.find(s => Math.abs(s.location[0] - 3185) < 120 && Math.abs(s.location[1] - 3436) < 120) ?? lib.SkillProgression.RANGED?.[0];
        assign(p, new lib.RangedMagicTask(step, 4));
        let dressed = -1;
        run(400, () => {
            const w = wornNames(p);
            if (taskKind(p) === 'RangedMagic' && /bow$/.test(w[3] ?? '') && w[4] === 'leather_armour' && !w[0]) {
                dressed = World.currentTick;
                return true;
            }
        });
        ok = dressed >= 0 && bankNames(p).includes('steel_platebody');
        detail = `${p.username}: at t${dressed} ${wornNames(p).filter(Boolean).join(' ')}`;
    }
    check("in the world: a ranged fight's bank stop takes the metal body and helm off and puts the leather body on, the bow in hand", ok, detail);
}

check('errors: none (bot errors, console errors)', BotManager.stats().errors === 0 && logErrors.length === 0, `${BotManager.stats().errors} bot errors; ${logErrors.slice(0, 2).join(' | ')}`);

out(`outfits: ${NAMES.length} names, a world of ${sim.bots().length} bots, seed ${SEED}`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
