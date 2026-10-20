#!/usr/bin/env node
// Looks (the realism work, phase 4, track A; docs/BOTS.md §5; "2004 bodies", "patchwork gear" and "rares and
// veterans"), in the real rev-274 world:
//   same name    the same gender, body, colours, starter weapon and aged look every time (Math.random disturbed between)
//   gender       matched to the name (words, first names, middle names); 10-20 % women in the first 200 and 1,000 names
//                (the pools of 100 and 500 online) and over the whole list
//   palette      kits valid for the gender; colours within the server's design check (12/16/16/6/8: the client's
//                ClientPlayer.recol1d, read from the webclient), every one of them used
//   newcomer     the design screen's clothes (the first kit of each part that is not disabled, colour 0), its own head
//                (a man the screen's bald head and goatee a third of the time), nothing worn
//   aged looks   over 1,600 names: matching metal sets at most 40 % of combat 11-60, accessories at least 30 % of levelling
//                combat 30+, a skiller's look without plate, nothing a bot's Defence cannot wear, no members item on a
//                free world, social and vendor bots worn only
//   rares        about 1 bot online in 60, most of them vendors and regulars at the hubs, experienced and veteran only,
//                never a PKer; holiday items veterans only (about 1 in 4); the top veterans at combat 100-120, about 1 bot
//                in 100
//   untradeable  the bunny ears and the scythe: tradeable=no in 274, in no bankstander's, gear shop's or vendor's list
//   shops        every piece of gear and wardrobe item a bot buys is in 274's shop stock (content's .inv) with some in it
//   purchases    by taste: the weapon (the kind it likes: the variety work), then the body, legs, helm and shield of the kind it likes, then an accessory; no helm
//                over a signature hat; nothing below the reserve
//   at a skill   port/BotGear dressForSkill: the plate to the bank, the outfit on, a signature hat kept, a veteran's scythe
//                in hand; a fight's bank trip (bankedArmourToWear) takes the armour back
//   in the world a new character's newcomers in the design screen's clothes wield the tutorial's sword and shield; a woodcutter in
//                plate takes it off at its bank stop; its fight puts it back on (its cape stays)
//
//   node --expose-gc web/engine/bots/test/looks.test.mjs [--seed=3]
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, CONTENT_DIR, WEBCLIENT_DIR, importTs } from './lib/paths.mjs';
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
        if (process.env.LOOKS_DEBUG) error(...a);
    };
}
const engineDir = prepareEngineClone('looks', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/looks.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, InvType, ObjType, IdkType, Looks, Gear, Age } = lib;
const saves = new Map();
const TIMING = { session: [1e7, 1e7], away: [1e7, 1e7], newcomer: [1e7, 1e7], newCharacterCount: [2, 2], newCharacterDelay: [5, 10], returnGap: [5, 30], emptyWorld: 50, busyGiveUp: 600, leaveGiveUp: 50 };
const sim = await lib.Sim.create({ bots: 8, members: true, debug: false, ageNewBots: true, saves, ackLogouts: true, extra: { timing: TIMING, savedNames: () => [...saves.keys()] } });
sim.addHuman(3222, 3218, 0);
const dn = id => ObjType.get(id)?.debugname ?? `#${id}`;
const norm = n => lib.normalizeBotName(n);
const W = Looks.wardrobeItems();
const LEVELLING = new Set(['skiller', 'fighter', 'balanced', 'random']);
const COSMETIC = new Set(['extras_social', 'extras_vendor']);
const wornNames = p => {
    const w = p.getInventory(InvType.WORN);
    const names = [];
    for (let s = 0; s < (w?.capacity ?? 0); s++) names.push(w.get(s) ? dn(w.get(s).id) : null);
    return names;
};

// ---- same name, same body ----
{
    const different = [];
    const names = [...lib.BOT_NAMES.slice(0, 300), ...lib.BOT_NAMES.slice(2000, 2100)].map(norm);
    for (const [i, name] of names.entries()) {
        const newcomer = i % 7 === 0;
        const a = lib.freshBot(name);
        lib.BotAppearance.randomize(a, { newcomer });
        Math.random();
        Math.random();
        const b = lib.freshBot(name);
        lib.BotAppearance.randomize(b, { newcomer });
        if (lib.bodyOf(a) !== lib.bodyOf(b)) different.push(name);
    }
    check('same name: the same gender, body, colours and starter weapon (Math.random disturbed between)', different.length === 0, different.slice(0, 5).join(', ') || `${names.length} names`);
}

// ---- gender ----
{
    const share = names => pct(names.filter(n => Looks.genderOf(norm(n)) === 1).length, names.length);
    const s200 = share(lib.BOT_NAMES.slice(0, 200));
    const s1000 = share(lib.BOT_NAMES.slice(0, 1000));
    const sAll = share(lib.BOT_NAMES);
    check('gender: 10-20 % women in the first 200 and 1,000 names (the pools of 100 and 500 online) and over all of them (Jagex: 84-90 % men)', [s200, s1000, sAll].every(s => s >= 10 && s <= 20), `${s200.toFixed(1)} %, ${s1000.toFixed(1)} %, ${sAll.toFixed(1)} % of ${lib.BOT_NAMES.length}`);
    const expect = { 'Sarah Jane': 1, 'Kevin1991': 0, 'Lady Luck': 1, 'Mr Bargain': 0, 'Holly Mae': 1, 'Wizard Tim': 0, 'Gamer Girl 3': 1, 'Danny Boy 7': 0, 'Market Mary': 1, 'Becky Lou': 1, 'Owen Jones': 0, 'Paulie G': 0 };
    const wrong = Object.entries(expect).filter(([n, g]) => Looks.genderOf(norm(n)) !== g).map(([n]) => n);
    const bySource = { women: 0, men: 0, dice: 0, diceWomen: 0 };
    const misfit = [];
    for (const n of lib.BOT_NAMES) {
        const name = norm(n);
        const source = Looks.genderSourceOf(name);
        const g = Looks.genderOf(name);
        if (source === 'dice') {
            bySource.dice++;
            if (g === 1) bySource.diceWomen++;
        } else if (source.startsWith('female')) {
            bySource.women++;
            if (g !== 1) misfit.push(n);
        } else {
            bySource.men++;
            if (g !== 0) misfit.push(n);
        }
    }
    // and the body a bot gets has that gender
    const bodies = lib.BOT_NAMES.slice(0, 200).map(norm).filter(name => {
        const p = lib.freshBot(name);
        lib.BotAppearance.randomize(p);
        return p.gender !== Looks.genderOf(name) || (p.gender === 1 ? p.body[1] !== -1 : p.body[1] === -1);
    });
    check('gender: matched to the name (a word, a first name, a middle name), the rest men but a few; the body has it', wrong.length === 0 && misfit.length === 0 && bodies.length === 0 && pct(bySource.diceWomen, bySource.dice) <= 6, `${wrong.join(', ') || 'the examples right'}; women's names ${bySource.women}, men's ${bySource.men}, by the dice ${bySource.dice} (${pct(bySource.diceWomen, bySource.dice).toFixed(1)} % women)${misfit.length ? `; misfit ${misfit.slice(0, 3).join(', ')}` : ''}${bodies.length ? `; bodies off: ${bodies.slice(0, 3).join(', ')}` : ''}`);
}

// ---- palette ----
{
    const sizes = lib.paletteSizes();
    // the client's palette (ClientPlayer.recol1d), read from the read-only webclient sources: its five arrays' lengths
    let client = null;
    try {
        const src = fs.readFileSync(path.join(WEBCLIENT_DIR, 'src/dash3d/ClientPlayer.ts'), 'utf8');
        const block = src.slice(src.indexOf('static readonly recol1d'), src.indexOf('];', src.indexOf('static readonly recol1d')));
        client = block
            .split(/\[\s*\/\/\s*\w+/)
            .slice(1)
            .map(part => part.split('\n').filter(l => /^\s*[A-Z][A-Za-z]+\.[A-Z_]+/.test(l)).length);
    } catch {
        client = null;
    }
    const used = sizes.map(() => new Set());
    const bad = [];
    for (let i = 0; i < 2000; i++) {
        const name = norm(`palette ${i}`);
        const p = lib.freshBot(name);
        lib.BotAppearance.randomize(p);
        p.colors.forEach((c, slot) => {
            used[slot].add(c);
            if (c < 0 || c >= sizes[slot]) bad.push(`${name}: colour ${slot} = ${c}`);
        });
        for (let part = 0; part < 7; part++) {
            const id = p.body[part];
            if (id === -1) {
                if (!(p.gender === 1 && part === 1)) bad.push(`${name}: part ${part} empty`);
                continue;
            }
            const idk = IdkType.get(id);
            if (!idk || idk.disable || idk.type !== part + (p.gender === 1 ? 7 : 0)) bad.push(`${name}: part ${part} kit ${id}`);
        }
    }
    const allUsed = used.every((set, slot) => set.size === sizes[slot]);
    check('palette: colours within the design check (hair, torso, legs, feet, skin 12/16/16/6/8, as the client) and every one used; kits valid for the gender', JSON.stringify(sizes) === '[12,16,16,6,8]' && (!client || JSON.stringify(client) === JSON.stringify(sizes)) && allUsed && bad.length === 0, `server ${JSON.stringify(sizes)}, client ${client ? JSON.stringify(client) : '(not read)'}; used ${used.map(s => s.size).join('/')}${bad.length ? `; ${bad.slice(0, 3).join('; ')}` : ''}`);
}

// ---- a newcomer: the design screen's clothes ----
{
    // Client.validateIdkDesign, again: the first kit of each part not disabled, for the gender
    const defaults = gender => {
        const outKits = [];
        for (let part = 0; part < 7; part++) {
            let found = -1;
            for (let id = 0; id < IdkType.count; id++) {
                const k = IdkType.get(id);
                if (k && !k.disable && k.type === part + (gender === 1 ? 7 : 0)) {
                    found = id;
                    break;
                }
            }
            outKits.push(found);
        }
        return outKits;
    };
    // (the integration of phase 4: the clothes are the screen's, the head the player's; a man keeps the screen's bald head
    // and goatee about a third of the time, a woman never: all newcomers in one head were a row of clones at Lumbridge)
    const bad = [];
    const seen = { 0: 0, 1: 0 };
    let menDefaultHead = 0;
    const heads = new Set();
    for (const n of [...lib.BOT_NAMES.slice(0, 120), 'Sarah Jane', 'Lady Luck']) {
        const name = norm(n);
        const p = lib.freshBot(name);
        lib.BotAppearance.randomize(p, { newcomer: true });
        seen[p.gender]++;
        const d = defaults(p.gender);
        const body = Array.from(p.body);
        const clothes = body.slice(2).every((k, i) => k === d[i + 2]) && p.colors[1] === 0 && p.colors[2] === 0 && p.colors[3] === 0;
        const defaultHead = body[0] === d[0] && body[1] === d[1] && p.colors[0] === 0 && p.colors[4] === 0;
        if (p.gender === 0 && defaultHead) menDefaultHead++;
        heads.add(`${body[0]}/${body[1]}/${p.colors[0]}/${p.colors[4]}`);
        // (the variety work, round 2, track W2: WEAR-9) a few newbies wear Imp Catcher's amulet of accuracy, nothing else
        const worn = lib.items(p, InvType.WORN).map(it => it.id);
        const accuracy = lib.Fashion?.newbieAccuracyOf?.(name) === true;
        const wornOk = accuracy ? worn.length === 1 && worn[0] === lib.ObjType.getId('amulet_of_accuracy') : worn.length === 0;
        if (!clothes || (p.gender === 1 && body[0] === d[0]) || !wornOk) bad.push(name);
    }
    const share = seen[0] ? menDefaultHead / seen[0] : 0;
    check("a newcomer: the design screen's clothes for its gender (the first kits, colour 0), its own head (a man the screen's a third of the time, a woman never bald), nothing worn (but the amulet of accuracy of a few: variety round 2)", bad.length === 0 && seen[0] > 0 && seen[1] > 0 && share >= 0.2 && share <= 0.5 && heads.size >= 20, `men ${JSON.stringify(defaults(0))}, women ${JSON.stringify(defaults(1))}; ${seen[0]} men (${(100 * share).toFixed(0)} % the default head), ${seen[1]} women; ${heads.size} heads${bad.length ? `; off: ${bad.slice(0, 3).join(', ')}` : ''}`);
}

// ---- aged looks over 1,600 names ----
const TIERS = ['bronze', 'iron', 'steel', 'black', 'mithril', 'adamant', 'rune', 'dragon'];
const tierOf = n => (n ? TIERS.find(t => n.startsWith(`${t}_`)) ?? null : null);
const aged = [];
{
    for (let i = 0; i < 1600; i++) {
        const name = norm(lib.BOT_NAMES[i]);
        const planner = lib.PLANNERS[i % lib.PLANNERS.length];
        const p = lib.freshBot(name, planner);
        lib.BotAppearance.randomize(p);
        const tier = Age.applyAge(p, name, planner, true);
        aged.push({ name, planner, tier, p, worn: wornNames(p), bank: lib.items(p, lib.bankId()).map(it => dn(it.id)), pack: lib.items(p, InvType.INV) });
    }
    const mid = aged.filter(a => a.p.combatLevel >= 11 && a.p.combatLevel <= 60);
    const matching = mid.filter(a => {
        const set = [0, 4, 5, 7].map(s => a.worn[s]);
        if (!set.every(Boolean)) return false;
        const t = new Set(set.map(tierOf));
        return t.size === 1 && !t.has(null);
    });
    const vets = aged.filter(a => LEVELLING.has(a.planner) && a.p.combatLevel >= 30);
    const accessorised = vets.filter(a => [1, 2, 9, 10].some(s => a.worn[s]));
    check('aged looks: matching metal sets at most 40 % of combat 11-60 (H12), accessories at least 30 % of levelling combat 30+ (H12b)', pct(matching.length, mid.length) <= 40 && pct(accessorised.length, vets.length) >= 30, `${matching.length} of ${mid.length} (${pct(matching.length, mid.length).toFixed(1)} %; ${pct(mid.filter(a => [0, 4, 5, 7].every(s => a.worn[s])).length, mid.length).toFixed(1)} % wear all four); ${accessorised.length} of ${vets.length} (${pct(accessorised.length, vets.length).toFixed(1)} %)`);
    // a skiller's look: no plate on, its plate (if any) in the bank; nothing worn above its Defence; cosmetic bots worn only
    const bad = [];
    let skillerLooks = 0;
    let mixed = 0;
    for (const a of aged) {
        const defence = a.p.baseLevels[1];
        for (const name of a.worn) {
            if (!name) continue;
            const piece = Looks.armourPieceOf(ObjType.getId(name));
            if (piece && !Looks.canWearPiece(piece, defence)) bad.push(`${a.name}: ${name} at Defence ${defence}`);
        }
        if (LEVELLING.has(a.planner) && a.tier !== 'newcomer' && Looks.skillerLook(a.name, a.planner)) {
            skillerLooks++;
            if ([0, 4, 5, 7].some(s => a.worn[s] && tierOf(a.worn[s]))) bad.push(`${a.name}: a skiller in plate (${a.worn.filter(Boolean).join(', ')})`);
        }
        if (COSMETIC.has(a.planner) && (a.bank.length || a.pack.length)) bad.push(`${a.name}: a ${a.planner} bot with kit in its pack or bank`);
        const metals = new Set([0, 4, 5, 7].map(s => tierOf(a.worn[s])).filter(Boolean));
        if (metals.size > 1) mixed++;
    }
    check("aged looks: a skiller's look has no plate on; nothing above the bot's Defence; social and vendor bots' looks worn only; mixed metals common", bad.length === 0 && skillerLooks > 50 && mixed > aged.length / 10, `${skillerLooks} skillers' looks, ${mixed} bots in mixed metals${bad.length ? `; ${bad.slice(0, 3).join('; ')}` : ''}`);
    // a free world's: no members item (agedLook with the free world's levels)
    const membersItems = [];
    for (let i = 0; i < 1600; i++) {
        const name = norm(lib.BOT_NAMES[i]);
        const planner = lib.PLANNERS[i % lib.PLANNERS.length];
        const stats = Age.agedStats(name, planner, false);
        if (!stats) continue;
        const levels = stats.xp.map(v => lib.getLevelByExp(v));
        const look = Age.agedLook(name, stats.tier, levels, false, planner);
        for (const id of [...look.worn, ...look.bank]) if (ObjType.get(id).members) membersItems.push(`${name}: ${dn(id)}`);
    }
    check('aged looks on a free world: no members item worn or banked', membersItems.length === 0, membersItems.slice(0, 4).join('; '));
    out(`  e.g. ${aged.filter(a => a.tier !== 'newcomer').slice(0, 6).map(a => `${a.name} (${a.planner}, ${a.tier}, cb ${a.p.combatLevel}): ${a.worn.filter(Boolean).join(' ')}`).join(' | ')}`);
}

// ---- rares, holiday items, the top veterans ----
{
    const isRare = n => n && /partyhat|santa_hat|halloweenmask/.test(n);
    const rare = aged.filter(a => a.worn.some(isRare));
    const lowRare = rare.filter(a => !['experienced', 'veteran'].includes(a.tier) || a.planner.includes('pker'));
    const partyhats = rare.filter(a => a.worn.some(n => n && /partyhat/.test(n)));
    // the share online: each planner's rate in the sample by its share of the bots online (the role mix: 17.5 % each
    // levelling planner, 7.5 % each extra)
    const ONLINE = { skiller: 0.175, fighter: 0.175, balanced: 0.175, random: 0.175, extras_vendor: 0.075, extras_social: 0.075, extras_pker: 0.075, extras_edgeville_pker: 0.075 };
    let online = 0;
    for (const [planner, weight] of Object.entries(ONLINE)) {
        const of = aged.filter(a => a.planner === planner);
        online += weight * (of.length ? rare.filter(a => a.planner === planner).length / of.length : 0);
    }
    const atHubs = rare.filter(a => COSMETIC.has(a.planner)).length;
    check('rares: about 1 bot online in 60 (1 in 35-100), most of them vendors and regulars at the hubs, experienced and veteran only, never a PKer; about a quarter of them partyhats', online >= 0.01 && online <= 1 / 35 && atHubs > rare.length / 2 && lowRare.length === 0 && partyhats.length >= 1 && partyhats.length < rare.length, `1 in ${(1 / Math.max(1e-9, online)).toFixed(0)} online (${rare.length} of 1,600 names, ${atHubs} vendors and regulars), ${partyhats.length} partyhats; ${rare.slice(0, 4).map(a => `${a.name} (${a.planner}, ${a.tier}): ${a.worn.find(isRare)}`).join(', ')}${lowRare.length ? `; low: ${lowRare.map(a => a.name).join(', ')}` : ''}`);
    const holiday = aged.filter(a => [...a.worn, ...a.bank].some(n => n === 'bunnyears' || n === 'scythe'));
    const levellingVets = aged.filter(a => LEVELLING.has(a.planner) && a.tier === 'veteran');
    const nonVet = holiday.filter(a => a.tier !== 'veteran');
    check('holiday items: veterans only, about 1 in 4 of the levelling veterans (10-45 %)', nonVet.length === 0 && pct(holiday.length, levellingVets.length) >= 10 && pct(holiday.length, levellingVets.length) <= 45, `${holiday.length} of ${levellingVets.length} levelling veterans: ${holiday.slice(0, 4).map(a => `${a.name} ${[...a.worn, ...a.bank].find(n => n === 'bunnyears' || n === 'scythe')}`).join(', ')}`);
    const top = aged.filter(a => a.p.combatLevel >= 100);
    const offTop = top.filter(a => a.p.combatLevel > 120 || a.tier !== 'veteran' || a.planner === 'skiller');
    check('top veterans: combat 100-120, veterans that are no skillers, about 1 bot in 100 (1 in 60-200 over 1,600 names)', top.length >= 1600 / 200 && top.length <= 1600 / 60 && offTop.length === 0, `${top.length} (1 in ${(1600 / Math.max(1, top.length)).toFixed(0)}): ${top.slice(0, 5).map(a => `${a.name} (${a.planner}) cb ${a.p.combatLevel}`).join(', ')}${offTop.length ? `; off: ${offTop.map(a => `${a.name} cb ${a.p.combatLevel}`).join(', ')}` : ''}`);
}

// ---- untradeable, and the shops' stock ----
{
    const holiday = Looks.holidayItems();
    const tradeable = holiday.filter(id => ObjType.get(id).tradeable);
    const inLists = holiday.filter(id => lib.viableItemIds.includes(id) || Gear.gearShopOf(id) !== undefined || Looks.rareItems().includes(id));
    // (the vendors' items: VendorTask's list, the economy work's)
    const vendorList = (lib.Vendor.vendorStock?.() ?? []).map(v => v.itemId);
    const inVendor = holiday.filter(id => vendorList.includes(id));
    check("untradeable: the bunny ears and the scythe are tradeable=no in 274, in no bankstander's, gear shop's or vendor's list", holiday.length === 2 && tradeable.length === 0 && inLists.length === 0 && inVendor.length === 0, `${holiday.map(dn).join(', ')}; ${vendorList.length} vendor items checked`);

    // 274's shops: their stock by owned_shop (content .inv), the shop keys port/BotGear uses
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
    const SHOP_INV = { AL_KHARID_SCIMITARS: 'scimitarshop', BARBARIAN_HELMETS: 'helmetshop', VARROCK_ARMOUR: 'armourshop', FALADOR_CHAINS: 'chainmailshop', AL_KHARID_LEGS: 'legsshop', RANAEL_SKIRTS: 'skirtshop', FALADOR_SHIELDS: 'shieldshop', THESSALIA_CLOTHES: 'clotheshop', BETTY_MAGIC: 'magicshop', VARROCK_FANCY_DRESS: 'fancyclothesstore', CHAMPIONS_SCAVVO: 'runiteshop', CHAMPIONS_VALAINE: 'championshop', OZIACH: 'runeplateshop' };
    const candidates = [...Looks.armourPieces().map(p => p.id), ...lib.SCIMITAR_TIERS.map(t => t.itemId), ...Object.values(W).flat()];
    const bad = [];
    let sold = 0;
    for (const id of new Set(candidates)) {
        const shop = Gear.gearShopOf(id);
        if (!shop) continue;
        sold++;
        const inv = invStock.get(SHOP_INV[shop]);
        if (!inv || !(inv.get(dn(id)) > 0)) bad.push(`${dn(id)} at ${shop} (${SHOP_INV[shop] ?? '?'}: ${inv?.get(dn(id)) ?? 'not listed'})`);
    }
    // and the shopkeepers stand where ShopTripTask looks for them (the wardrobe's shops)
    const npcs = (lib.ShopTripTask.NPC_NAMES ?? {});
    const missing = Object.keys(Gear.WARDROBE_SHOPS).filter(k => !npcs[k]);
    check("shops: every piece and wardrobe item a bot buys is in 274's stock with some in it (content's .inv), each shop's keeper known", sold > 30 && bad.length === 0 && missing.length === 0, `${sold} items${bad.length ? `; not for sale: ${bad.slice(0, 4).join('; ')}` : ''}${missing.length ? `; no keeper: ${missing.join(', ')}` : ''}`);
}

// ---- purchases by taste ----
{
    const find = pred => lib.BOT_NAMES.map(norm).find(n => pred(Looks.gearTaste(n), n));
    // (realism phase 5b, Track D: a cape it buys is its own liking, ownCape; a clique member's kit wears its clan's cape
    // whatever it likes, so `cape` is the kit's: port/BotLooks gearTaste)
    const medHelm = find(t => t.helm === 'med' && t.body === 'chain' && t.shield === 'sq' && t.ownCape);
    const bot = lib.freshBot(medHelm, 'fighter');
    for (const [stat, level] of [[0, 20], [1, 20], [2, 20], [3, 25]]) {
        bot.baseLevels[stat] = level;
        bot.levels[stat] = level;
        bot.stats[stat] = lib.getExpByLevel(level);
    }
    bot.combatLevel = bot.getCombatLevel();
    bot.x = 3213;
    bot.z = 3424; // Varrock
    bot.getInventory(lib.bankId()).add(lib.Items.COINS, 50_000);
    const bought = [];
    for (let i = 0; i < 12; i++) {
        const next = Gear.nextGearUpgrade(bot, lib.SCIMITAR_TIERS);
        if (!next) break;
        bought.push(`${dn(next.itemId)} (${next.shopKey})`);
        bot.getInventory(lib.bankId()).add(next.itemId, 1);
    }
    const kinds = bought.map(b => b.split(' ')[0]);
    const okTaste = kinds.some(k => /_med_helm$/.test(k)) && kinds.some(k => /_chainbody$/.test(k)) && kinds.some(k => /_sq_shield$/.test(k)) && !kinds.some(k => /_full_helm$|_platebody$|_kiteshield$/.test(k));
    // (the variety work, round 1, track W: WEAR-2, weapon taste) the weapon first is of the kind the bot likes, not always
    // a scimitar (phase 4 bought scimitars only): this bot's is port/BotOutfits weaponKindOf's
    const firstWeapon = lib.Outfits.meleeWeaponOf(ObjType.getId(kinds[0] ?? ''));
    const likedKind = lib.Outfits.weaponKindOf(medHelm);
    const okOrder = firstWeapon?.kind === (lib.Gear.gearShopOf(lib.Outfits.weaponOf(likedKind, 4)?.id ?? -1) ? likedKind : 'scimitar') && kinds.includes('red_cape') && kinds.indexOf('red_cape') > kinds.findIndex(k => /_sq_shield$/.test(k));
    // no helm over a signature hat; nothing below the reserve
    const hatted = lib.freshBot(find(t => t.helm !== 'none'), 'fighter');
    hatted.baseLevels[1] = 20;
    hatted.getInventory(InvType.WORN).set(0, { id: W.partyhats[2], count: 1 });
    hatted.getInventory(lib.bankId()).add(lib.Items.COINS, 50_000);
    const hatBuys = [];
    for (let i = 0; i < 10; i++) {
        const next = Gear.nextGearUpgrade(hatted, lib.SCIMITAR_TIERS);
        if (!next) break;
        hatBuys.push(dn(next.itemId));
        hatted.getInventory(lib.bankId()).add(next.itemId, 1);
    }
    const poor = lib.freshBot(medHelm, 'fighter');
    poor.getInventory(InvType.INV).add(lib.Items.COINS, 90);
    // a skiller's wardrobe: its apron and its wizard hat (Thessalia's, Betty's) before the accessories; none it has
    const skillerName = find((t, n) => t.apron && t.hat === 'wizard' && Looks.skillerLook(n, 'skiller'));
    const skiller = lib.freshBot(skillerName, 'skiller');
    skiller.x = 3100;
    skiller.z = 3250; // Draynor: Thessalia's and Betty's within reach
    const wardrobe = [];
    for (let i = 0; i < 6; i++) {
        const next = Gear.nextAccessory(skiller, 1000, 'skiller');
        if (!next) break;
        wardrobe.push(`${dn(next.itemId)} (${next.shopKey})`);
        skiller.getInventory(lib.bankId()).add(next.itemId, 1);
    }
    const okWardrobe = /_apron \(THESSALIA_CLOTHES\)/.test(wardrobe[0] ?? '') && /wizhat \(BETTY_MAGIC\)/.test(wardrobe[1] ?? '') && new Set(wardrobe).size === wardrobe.length;
    check("purchases: the weapon (of the kind the bot likes), then the body, legs, helm and shield of the kind the taste likes, then an accessory; no helm over a signature hat; nothing below the reserve; a skiller's apron and wizard hat first, each once", okTaste && okOrder && !hatBuys.some(n => /helm/.test(n)) && Gear.nextGearUpgrade(poor, lib.SCIMITAR_TIERS) === null && okWardrobe, `${medHelm}: ${bought.join(', ')}; under a partyhat: ${hatBuys.join(', ') || '-'}; skiller ${skillerName}: ${wardrobe.join(', ')}`);
}

// ---- at a skill: plate to the bank, the outfit on; a fight's bank trip takes it back ----
{
    const name = norm(lib.BOT_NAMES[3]);
    const p = lib.freshBot(name, 'balanced');
    p.baseLevels[1] = 30;
    const worn = p.getInventory(InvType.WORN);
    const bank = p.getInventory(lib.bankId());
    const I = lib.Items;
    for (const id of [I.ADAMANT_FULL_HELM, I.MITHRIL_CHAINBODY, I.ADAMANT_PLATELEGS, I.IRON_SQ_SHIELD, I.ADAMANT_SCIMITAR]) worn.set(ObjType.get(id).wearpos, { id, count: 1 });
    bank.add(W.wizardHat, 1);
    bank.add(W.capes[2], 1);
    bank.add(W.boots, 1);
    lib.setTask(p, 'Combat');
    Gear.dressForSkill(p);
    const untouched = wornNames(p).filter(Boolean).length === 5;
    lib.setTask(p, 'Woodcut:1519');
    Gear.dressForSkill(p);
    const after = wornNames(p);
    const plateOff = [0, 4, 5, 7].every(s => !after[s] || !tierOf(after[s]));
    const outfitOn = after[0] === 'bluewizhat' && after[1] === dn(W.capes[2]) && after[10] === 'leather_boots' && after[3] === 'adamant_scimitar';
    const banked = lib.items(p, lib.bankId()).map(it => dn(it.id));
    const back = Gear.bankedArmourToWear(p).map(dn).sort();
    // a signature hat stays, a veteran's scythe goes in hand
    const v = lib.freshBot(norm(lib.BOT_NAMES[11]), 'skiller');
    v.baseLevels[1] = 40;
    v.getInventory(InvType.WORN).set(0, { id: W.santaHat, count: 1 });
    v.getInventory(InvType.WORN).set(4, { id: I.RUNE_PLATEBODY, count: 1 });
    v.getInventory(InvType.WORN).set(3, { id: I.RUNE_SCIMITAR, count: 1 });
    v.getInventory(lib.bankId()).add(W.scythe, 1);
    v.getInventory(lib.bankId()).add(I.RUNE_FULL_HELM, 1);
    lib.setTask(v, 'Fish');
    Gear.dressForSkill(v);
    const vw = wornNames(v);
    const vBack = Gear.bankedArmourToWear(v).map(dn);
    check('at a skill: the plate goes to the bank and the outfit comes on (a fight changes nothing); a fight takes the armour back; a signature hat stays, a scythe goes in hand', untouched && plateOff && outfitOn && back.join(',') === 'adamant_full_helm,adamant_platelegs,iron_sq_shield,mithril_chainbody' && ['adamant_full_helm', 'mithril_chainbody'].every(n => banked.includes(n)) && vw[0] === 'santa_hat' && vw[3] === 'scythe' && !vw[4] && JSON.stringify(vBack) === JSON.stringify(['rune_platebody']), `woodcutter: ${after.filter(Boolean).join(' ')}; back for a fight: ${back.join(', ')}; veteran: ${vw.filter(Boolean).join(' ')}, back: ${vBack.join(', ')}`);
}

// ---- in the world ----
const taskKind = p => (sim.botPlayer(p)?.currentTask?.name ?? 'none').split(':')[0];
const run = (ticks, each) => {
    for (let i = 0; i < ticks; i++) {
        sim.tick();
        each?.();
    }
};
// (no hang-out, break or linger: they hold a bot at its bank stop for minutes, its task waiting; nor a login's linger by
// the human, the variety work's round 1 track F: a newcomer would stand 10-40 s in the courtyard before its InitTask arms it)
lib.setHangoutRateForTest(0);
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0 });
lib.setLingerForTest(false);
run(30);
{
    // a new character's newcomers: the design screen's clothes, the tutorial's sword and shield in hand
    BotManager.newCharacter();
    run(60);
    const newbies = sim.bots().filter(p => p.botNewbie === true);
    const defaultsOf = g => lib.designDefaults(g);
    const off = newbies.filter(p => JSON.stringify(Array.from(p.body).slice(2)) !== JSON.stringify(defaultsOf(p.gender).slice(2)) || p.colors[1] !== 0 || p.colors[2] !== 0 || p.colors[3] !== 0);
    const armed = newbies.filter(p => {
        const w = wornNames(p);
        return w[3] === 'bronze_sword' && w[5] === 'wooden_shield';
    });
    check("in the world: a new character's newcomers in the design screen's clothes wield the tutorial's sword and shield", newbies.length >= 2 && off.length === 0 && armed.length === newbies.length, newbies.map(p => `${p.username} (g${p.gender}): ${wornNames(p).filter(Boolean).join(' ') || 'nothing'}`).join(', '));
}
{
    // a woodcutter in plate at Draynor's willows with a full pack: its bank stop takes the plate off; then a fight puts it on
    // (the variety work, round 1, Track D: one that banks its willows; a power-dropper, 1 in 5, drops them where it stands)
    const p = sim.bots().find(b => b.botNewbie !== true && lib.isLevelling(b.botPlanner) && b.level === 0 && !lib.isDropper(b.username));
    const bot = p ? sim.botPlayer(p) : null;
    let detail = 'no levelling bot';
    let ok = false;
    if (p && bot) {
        const I = lib.Items;
        for (const [stat, level] of [[0, 30], [1, 30], [2, 30], [3, 30], [8, 30]]) p.setLevel(stat, level);
        const worn = p.getInventory(InvType.WORN);
        for (let s = 0; s < worn.capacity; s++) worn.delete(s);
        for (const id of [I.ADAMANT_MED_HELM, I.ADAMANT_PLATEBODY, I.ADAMANT_PLATELEGS, I.ADAMANT_KITESHIELD, I.ADAMANT_SCIMITAR, W.capes[0]]) worn.set(ObjType.get(id).wearpos, { id, count: 1 });
        const inv = p.getInventory(InvType.INV);
        for (let s = 0; s < inv.capacity; s++) inv.delete(s);
        inv.add(I.STEEL_AXE, 1);
        for (let i = 0; i < 27; i++) inv.add(I.WILLOW_LOGS, 1);
        p.getInventory(lib.bankId()).add(W.wizardHat, 1);
        p.clearPendingAction();
        p.clearWaypoints();
        p.teleJump(3088, 3235, 0);
        const willows = lib.SkillProgression.WOODCUTTING.find(s => s.itemGained === I.WILLOW_LOGS && Math.abs(s.location[0] - 3088) < 30 && Math.abs(s.location[1] - 3235) < 30) ?? lib.SkillProgression.WOODCUTTING.find(s => s.itemGained === I.WILLOW_LOGS);
        bot.planner.pickTask = () => new lib.WoodcuttingTask(willows);
        bot.currentTask?.interrupt();
        let offAt = -1;
        run(400, () => {
            if (offAt >= 0) return;
            const w = wornNames(p);
            if (taskKind(p) === 'Woodcut' && !w[4] && !w[7]) offAt = World.currentTick;
        });
        const atSkill = wornNames(p);
        const step = lib.SkillProgression.ATTACK.find(s => s.extra?.npcType === 'chicken') ?? lib.SkillProgression.ATTACK[0];
        bot.planner.pickTask = () => new lib.CombatTask(step, 0);
        bot.currentTask?.interrupt();
        let onAt = -1;
        const trace = [];
        run(600, () => {
            if (process.env.LOOKS_DEBUG && World.currentTick % 10 === 0) trace.push(`t${World.currentTick} ${taskKind(p)}/${sim.botPlayer(p)?.currentTask?.state ?? '-'} ${p.x},${p.z} ${wornNames(p).filter(Boolean).join(' ')}`);
            if (onAt >= 0) return;
            const w = wornNames(p);
            if (taskKind(p) === 'Combat' && w[4] === 'adamant_platebody' && w[7] === 'adamant_platelegs') onAt = World.currentTick;
        });
        if (process.env.LOOKS_DEBUG) out(trace.join('\n'));
        const fighting = wornNames(p);
        ok = offAt >= 0 && onAt >= 0 && atSkill[1] === dn(W.capes[0]) && fighting[1] === dn(W.capes[0]) && fighting[0] === 'adamant_med_helm';
        detail = `${p.username}: at the skill (t${offAt}) ${atSkill.filter(Boolean).join(' ')}; fighting (t${onAt}) ${fighting.filter(Boolean).join(' ')}`;
    }
    check('in the world: a woodcutter in plate takes it off at its bank stop (its hat on, its cape kept); its fight puts the armour back on', ok, detail);
}
check('errors: none (bot errors, console errors)', BotManager.stats().errors === 0 && logErrors.length === 0, `${BotManager.stats().errors} bot errors; ${logErrors.slice(0, 2).join(' | ')}`);

out(`looks: ${lib.BOT_NAMES.length} names, a world of ${sim.bots().length} bots, seed ${SEED}`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
