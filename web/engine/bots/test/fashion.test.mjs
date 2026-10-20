#!/usr/bin/env node
// Fashion (the variety work, round 2, track W2; docs/BOTS.md §5 WEAR-4, -7, -8, -9, -10;
// status gear on about 1 rich bot in 5 with vendors at estimated prices, new outfits reach saved bots
// through play, a new bot's aged kit may hold anything from its own seed), in the real rev-274 world:
//   seeds        each new trait a seed of its own, in port/BotFashion or BotAppearance; the same name gives the same
//                status kit, members fashion, novelty pieces, battlestaff and PK outfit; with the round's pass off, every
//                name's look is round 1's, and a name the round gives nothing keeps it whole
//   status       274's trims, god and gilded pieces (50); armour of their metal and a little more (rune (g) over rune, under
//                dragon), worn by their Defence; in the aged kits about 1 rich bot in 5 (experienced and veterans), the social
//                and vendor bots more often, a full set about 1 in 5 of them, no piece above the bot's Defence, gilded only
//                on a members world
//   members      on a members world only: clue hats on about 1 levelling bot in 20, Fremennik helms (45 Defence), clothes,
//                snelms, god books, Canifis and gnome robes, each 3-10 % of those it is for; never on a free world
//   novelty      the mime's outfit on about 1 veteran in 100, a holy symbol on prayer trainers and monks, the amulet of
//                accuracy on a few novices and newbies, gem amulets on crafters
//   kits         a melee or cosmetic bot wears its status pieces, a skiller, ranger or mage banks them; no Fremennik shirt or
//                robe over metal, no god book with a two-hander, a novelty amulet only into an empty neck slot
//   bodies       fewer bald women (new bodies); 3 in 10 of a levelling clique's members in its colour
//   PKers        the outfit varies from the profile's seed (70 %+ distinct among PKers), every piece wearable at its levels
//                and on its world; a class name keeps its hat; a saved PKer keeps its profile unless its save shows the variety
//   notable      notableGearOf: a rare first, then status, dragon, members show pieces, with 2004's nicknames
//   wealth       a bot's bank value without what it shows off; a vendor is never rich
//   prices       every status piece and Fremennik helm in data/street_prices.json, labelled an estimate; the vendors'
//                status stock's ids are status pieces of their names
//   purchases    a yellow-liker's yellow cape at the Varrock tailor's; a warhammer-liker's mace on a free world, a warhammer at
//                Skulgrimen's near Rellekka; a members bot's Fremennik cloak near Rellekka, nothing far away; a mage's battlestaff
//   shops        the new keepers (Yrsa, Skulgrimen, Barker; round 1's unreachable: Scavvo, Valaine, Helemos upstairs, Oziach)
//                within 8 tiles of their shop's place, the items in their stock; a rune longsword and rune legs at Scavvo's,
//                a ranger's green d'hide body at Oziach's
//   dressing     a skill's bank stop banks a status piece and puts a show hat and Fremennik cloak on; a rich melee bot puts its
//                (g) on at Varrock West's bank, a poor one or one away from the hubs does not; before a Wilderness fight its
//                partyhat and (g) go to the bank and plain rune goes on
//   in the world a rich bot's show-off visit buys a vendor's (g) platebody through the trade screens and wears it; a bot
//                buys the coif upstairs at Scavvo's (the stairs walked) and Oziach's d'hide body (his dialogue); a new PKer
//                wears its varied outfit
//
//   node --expose-gc web/engine/bots/test/fashion.test.mjs [--seed=3]
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, CONTENT_DIR, ENGINE_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { mulberry, scene } from './lib/dice.mjs';
import { compileBotScripts } from '../content/compile.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const SEED = Number(args.seed ?? 3);
const out = (s = '') => process.stdout.write(s + '\n');
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
        if (process.env.FASHION_DEBUG) error(...a);
    };
}
// (the content overlay, as the app puts it in place: a bot vendor answers a buyer's trade request through [opplayer4,_])
const content = {
    bin: new Uint8Array(fs.readFileSync((await compileBotScripts({ engineDir: ENGINE_DIR, contentDir: CONTENT_DIR, log: () => {} })).file)),
    dat: new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.dat'))),
    idx: new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.idx')))
};
const engineDir = prepareEngineClone('fashion', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/fashion.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, InvType, ObjType, Looks, Gear, Age, Outfits: O, Fashion: F } = lib;
const saves = new Map();
const TIMING = { session: [1e7, 1e7], away: [1e7, 1e7], newcomer: [1e7, 1e7], newCharacterCount: [2, 2], newCharacterDelay: [5, 10], returnGap: [5, 30], emptyWorld: 50, busyGiveUp: 600, leaveGiveUp: 50 };
const sim = await lib.Sim.create({ bots: 16, members: true, debug: false, ageNewBots: true, saves, ackLogouts: true, extra: { timing: TIMING, savedNames: () => [...saves.keys()] } });
lib.installBotsContent(content.bin, content.dat, content.idx);
sim.addHuman(3222, 3218, 0);
const dn = id => (id === -1 || id === undefined ? '' : (ObjType.get(id)?.debugname ?? `#${id}`));
const idOf = name => ObjType.getId(name);
const norm = n => lib.normalizeBotName(n);
const NAMES = lib.BOT_NAMES.map(norm);
const I = lib.Items;
const LEVELLING = new Set(['skiller', 'fighter', 'balanced', 'random']);
const COSMETIC = new Set(['extras_social', 'extras_vendor']);
const PLANNER_OF = new Map(NAMES.map((n, i) => [n, lib.PLANNERS[i % lib.PLANNERS.length]]));
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
const give = (p, invId, items) => {
    for (const [i, n] of items) p.getInventory(invId).add(i, n);
};
const levelsFrom = xp => xp.map(v => lib.getLevelByExp(v));
const OIF = () => O.outfitItems();
const statusOn = ids => ids.filter(i => F.statusPieceOf(i)).length;

// ---- seeds ----
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
    // (and the show-off visits' cadence a draw of its own: port/BotShowOff, not the world's Math.random)
    const NEW = ['status-gear', 'members-fashion', 'novelty', 'battlestaff-kind', '${salt}:pk-variety', 'woman-hair', 'clan-clothes', 'show-off'];
    const wrong = NEW.filter(s => !(salts.get(s) ?? []).length || (salts.get(s) ?? []).some(f => !(s === 'show-off' ? /BotShowOff/ : /BotFashion|BotAppearance/).test(f)) || (s !== 'novelty' && new Set(salts.get(s)).size !== 1));
    const different = [];
    for (const name of NAMES.slice(0, 400)) {
        const a = () => JSON.stringify([F.statusKitOf(name, 'veteran', 60, true, { cosmetic: false, legs: 'platelegs', shield: true }), F.membersFashionOf(name, 'veteran', { defence: 60, ranged: 60 }, 'melee', { prayer: true, robes: true }), F.noveltyOf(name, 'veteran', 70, { prayer: true, monk: false, crafter: true }), F.battlestaffOf(name)]);
        const x = a();
        Math.random();
        if (x !== a()) different.push(name);
    }
    check("seeds: the round's new traits each a salt of its own in port/BotFashion or BotAppearance (the show-off's cadence in port/BotShowOff); the same name gives the same status kit, members fashion, novelty and battlestaff", wrong.length === 0 && different.length === 0, `${NEW.map(s => `${s}: ${(salts.get(s) ?? []).join('/') || 'none'}`).join('; ')}${different.length ? `; differ: ${different.slice(0, 3).join(', ')}` : ''}`);
    // the pass off: round 1's looks; a name the round gives nothing keeps its look whole
    let same = 0;
    let only = 0;
    const changed = [];
    for (const name of NAMES.slice(0, 1600)) {
        const planner = PLANNER_OF.get(name);
        const stats = Age.agedStats(name, planner, true);
        if (!stats) continue;
        const levels = levelsFrom(stats.xp);
        lib.setFashionPassForTest(false);
        const before = Age.agedLook(name, stats.tier, levels, true, planner);
        lib.setFashionPassForTest(true);
        const after = Age.agedLook(name, stats.tier, levels, true, planner);
        const a = JSON.stringify([before.worn.slice().sort(), before.bank.slice().sort()]);
        const b = JSON.stringify([after.worn.slice().sort(), after.bank.slice().sort()]);
        if (a === b) {
            same++;
            continue;
        }
        // (what changed: only round 2's pieces came, and what they replaced went to the bank or off)
        const added = after.worn.filter(i => !before.worn.includes(i));
        if (added.every(i => F.statusPieceOf(i) || F.fashionItemIds().includes(i) || i === -1)) only++;
        else changed.push(`${name}: ${added.map(dn).join(' ')}`);
    }
    check("seeds: with the round's pass off a new bot's look is round 1's; with it on, only the round's pieces come (most names unchanged)", changed.length === 0 && same >= 0.6 * (same + only), `${same} names unchanged, ${only} with round 2's pieces only${changed.length ? `; other: ${changed.slice(0, 3).join('; ')}` : ''}`);
}

// ---- status pieces ----
{
    const pieces = F.statusPieces();
    const bad = [];
    for (const p of pieces) {
        const a = Looks.armourPieceOf(p.id);
        if (!a || a.status !== p.family || Math.floor(a.tier) !== p.metal || a.tier <= p.metal) bad.push(`${dn(p.id)}: ${JSON.stringify(a)}`);
        if (Looks.canWearPiece(a, F.statusDefence(p) - 1) || !Looks.canWearPiece(a, F.statusDefence(p))) bad.push(`${dn(p.id)}: Defence ${F.statusDefence(p)}`);
        if (ObjType.get(p.id).members !== (p.family === 'gilded')) bad.push(`${dn(p.id)}: members ${ObjType.get(p.id).members}`);
    }
    const rune = Looks.armourPieceOf(I.RUNE_PLATEBODY);
    const g = Looks.armourPieceOf(idOf('rune_platebody_gold'));
    const plain = Looks.pieceOf('plate', 6);
    check("status: 274's trims, god and gilded pieces (50), each armour of its metal and a little more, worn by its metal's Defence, members only the gilded; pieceOf finds the plain piece", pieces.length === 50 && bad.length === 0 && g.tier > rune.tier && g.tier < 7 && plain?.id === I.RUNE_PLATEBODY, `${pieces.length} pieces${bad.length ? `; ${bad.slice(0, 4).join('; ')}` : ''}`);
}

// ---- status kits over 2,400 names ----
{
    let rich = 0;
    let richWith = 0;
    let cosmeticRich = 0;
    let cosmeticWith = 0;
    let sets = 0;
    let withAny = 0;
    const bad = [];
    const byFamily = {};
    for (const name of NAMES) {
        const planner = PLANNER_OF.get(name);
        if (planner === 'extras_pker' || planner === 'extras_edgeville_pker') continue;
        const stats = Age.agedStats(name, planner, true);
        if (!stats) continue;
        const levels = levelsFrom(stats.xp);
        const cosmetic = COSMETIC.has(planner);
        for (const members of [true, false]) {
            const kit = F.statusKitOf(name, stats.tier, levels[1], members, { cosmetic, legs: 'platelegs', shield: true });
            for (const i of kit) {
                const p = F.statusPieceOf(i);
                if (!p || levels[1] < F.statusDefence(p)) bad.push(`${name}: ${dn(i)} at Defence ${levels[1]}`);
                if (!members && ObjType.get(i).members) bad.push(`${name}: ${dn(i)} on a free world`);
            }
            if (!members) continue;
            if (kit.length) {
                withAny++;
                if (kit.length >= 3) sets++;
                const fam = F.statusPieceOf(kit[0]).family;
                byFamily[fam] = (byFamily[fam] ?? 0) + 1;
            }
            if (stats.tier === 'experienced' || stats.tier === 'veteran') {
                if (cosmetic) {
                    cosmeticRich++;
                    if (kit.length) cosmeticWith++;
                } else {
                    rich++;
                    if (kit.length) richWith++;
                }
            }
        }
    }
    const share = pct(richWith, rich);
    const cshare = pct(cosmeticWith, cosmeticRich);
    check('status: in the aged kits about 1 rich bot in 5 (experienced and veteran levelling bots 12-25 %), the social and vendor bots too (their dice half as much again), a full set about 1 in 5, nothing above the Defence, nothing members on a free world', share >= 12 && share <= 25 && cshare >= 12 && pct(sets, withAny) >= 10 && pct(sets, withAny) <= 32 && bad.length === 0, `levelling ${richWith} of ${rich} (${share.toFixed(1)} %), social and vendor ${cosmeticWith} of ${cosmeticRich} (${cshare.toFixed(1)} %); sets ${sets} of ${withAny}; ${JSON.stringify(byFamily)}${bad.length ? `; ${bad.slice(0, 3).join('; ')}` : ''}`);
}

// ---- members fashion and novelty over 2,400 names ----
{
    const counts = { clue: [0, 0], helm: [0, 0], frem: [0, 0], snelm: [0, 0], book: [0, 0], robes: [0, 0], mime: [0, 0], holy: [0, 0], accuracy: [0, 0], gem: [0, 0] };
    const m = F.membersItems();
    const clueHats = new Set([...m.clueHats.berets, ...m.clueHats.cavaliers, ...m.clueHats.headbands, m.clueHats.pirate, m.clueHats.robinHood]);
    const helms = new Set(Object.values(m.fremennikHelms));
    let freeAny = 0;
    for (const name of NAMES) {
        const planner = PLANNER_OF.get(name);
        if (!LEVELLING.has(planner)) continue;
        const stats = Age.agedStats(name, planner, true);
        const tier = stats?.tier ?? 'newcomer';
        const levels = stats ? levelsFrom(stats.xp) : new Array(21).fill(1);
        const rich = tier === 'experienced' || tier === 'veteran';
        const style = O.combatStyleOf(name);
        const prayer = O.prayerTrainer(levels);
        const mf = F.membersFashionOf(name, tier, { defence: levels[1], ranged: levels[4] }, style, { prayer, robes: true });
        const nov = F.noveltyOf(name, tier, levels[12], { prayer, monk: O.nameClassOf(name) === 'monk', crafter: O.mainSkillOf(levels) === 'crafting' });
        counts.clue[1]++;
        if (clueHats.has(mf.hat)) counts.clue[0]++;
        if (rich && levels[1] >= 45) {
            counts.helm[1]++;
            if (helms.has(mf.hat)) counts.helm[0]++;
        }
        if (rich) {
            counts.frem[1]++;
            if (m.fremennikCloaks.includes(mf.cape)) counts.frem[0]++;
            counts.robes[1]++;
            if ([...m.wolfenRobes, ...m.gnomeRobes].some(r => r[0] === mf.body)) counts.robes[0]++;
        }
        if (tier !== 'newcomer' && tier !== 'novice') {
            counts.snelm[1]++;
            if (m.snelms.includes(mf.hat)) counts.snelm[0]++;
        }
        if (tier === 'veteran' && (prayer || style === 'mage')) {
            counts.book[1]++;
            if (mf.shield !== -1) counts.book[0]++;
        }
        if (tier === 'veteran') {
            counts.mime[1]++;
            if (nov.mime.length) counts.mime[0]++;
        }
        if (prayer) {
            counts.holy[1]++;
            if (nov.neck === F.noveltyItems().holySymbol) counts.holy[0]++;
        }
        if (tier === 'novice') {
            counts.accuracy[1]++;
            if (nov.neck === F.noveltyItems().accuracy) counts.accuracy[0]++;
        }
        if (O.mainSkillOf(levels) === 'crafting') {
            counts.gem[1]++;
            if (F.noveltyItems().gemAmulets.some(([i]) => i === nov.neck)) counts.gem[0]++;
        }
        // a free world: no members item in any kit (port/BotAge's `usable`)
        if (stats) {
            const look = Age.agedLook(name, tier, levels, false, planner);
            if ([...look.worn, ...look.bank].some(i => ObjType.get(i).members)) freeAny++;
        }
    }
    const share = k => pct(counts[k][0], counts[k][1]);
    const show = Object.keys(counts).map(k => `${k} ${counts[k][0]}/${counts[k][1]} (${share(k).toFixed(1)} %)`).join(', ');
    const inBand = ['helm', 'frem', 'snelm', 'robes'].every(k => share(k) >= 2 && share(k) <= 12) && share('clue') >= 3 && share('clue') <= 8 && share('book') >= 10 && share('book') <= 40;
    check("members fashion: clue hats on about 1 levelling bot in 20, Fremennik helms, clothes, snelms and robes 3-10 % of those they are for, god books on a few prayer and magic veterans; none on a free world", inBand && freeAny === 0, `${show}; free-world kits with a members item ${freeAny}`);
    check('novelty: the mime on about 1 veteran in 100, a holy symbol on 4 prayer trainers in 10, the amulet of accuracy on a few novices, gem amulets on crafters', share('mime') <= 4 && share('holy') >= 25 && share('holy') <= 55 && share('accuracy') >= 3 && share('accuracy') <= 14 && share('gem') >= 20 && share('gem') <= 60, show);
}

// ---- kits: where the round's pieces go ----
{
    const bad = [];
    let wornStatus = 0;
    let bankedStatus = 0;
    for (const name of NAMES.slice(0, 2000)) {
        const planner = PLANNER_OF.get(name);
        const stats = Age.agedStats(name, planner, true);
        if (!stats || planner === 'extras_pker' || planner === 'extras_edgeville_pker') continue;
        const levels = levelsFrom(stats.xp);
        const look = Age.agedLook(name, stats.tier, levels, true, planner);
        const cosmetic = COSMETIC.has(planner);
        const skiller = !cosmetic && Looks.skillerLook(name, planner);
        const style = O.nameClassOf(name) === 'mage' || O.nameClassOf(name) === 'ranger' ? O.nameClassOf(name) : skiller || cosmetic ? 'melee' : O.combatStyleOf(name);
        const worn = look.worn;
        for (const i of worn) {
            const p = F.statusPieceOf(i);
            if (p) {
                wornStatus++;
                if (!(cosmetic || (!skiller && style === 'melee'))) bad.push(`${name} (${planner}, ${skiller ? 'skiller' : style}) wears ${dn(i)}`);
                if (levels[1] < F.statusDefence(p)) bad.push(`${name}: ${dn(i)} at Defence ${levels[1]}`);
            }
        }
        bankedStatus += look.bank.filter(i => F.statusPieceOf(i)).length;
        const at = pos => worn.filter(i => ObjType.get(i).wearpos === pos);
        const metal = pos => at(pos).some(i => (Looks.armourPieceOf(i)?.tier ?? -1) >= 0);
        const m = F.membersItems();
        if (at(4).some(i => [...m.fremennikShirts, ...m.wolfenRobes.map(r => r[0]), ...m.gnomeRobes.map(r => r[0])].includes(i)) && metal(4)) bad.push(`${name}: a shirt over metal`);
        if (at(5).some(i => m.godBooks.includes(i)) && at(3).some(i => ObjType.get(i).wearpos2 === 5)) bad.push(`${name}: a god book with a two-hander`);
        if (at(2).length > 1) bad.push(`${name}: two amulets`);
        const slots = worn.map(i => ObjType.get(i).wearpos);
        if (new Set(slots).size !== slots.length) bad.push(`${name}: two items in a slot (${worn.map(dn).join(' ')})`);
    }
    check("kits: a melee or social bot wears its status pieces, a skiller, ranger or mage banks them; no shirt or robe over metal, no god book with a two-hander, one item a slot, nothing above the Defence", bad.length === 0 && wornStatus > 0 && bankedStatus > 0, `${wornStatus} worn, ${bankedStatus} banked${bad.length ? `; ${bad.slice(0, 4).join('; ')}` : ''}`);
}

// ---- bodies: fewer bald women, clan colours ----
{
    const bald = lib.designDefaults(1)[0];
    let women = 0;
    let baldWomen = 0;
    let members = 0;
    let inColour = 0;
    const COLOUR = [6, 1, 7, 9, 8, 10, 11];
    for (const name of NAMES) {
        const p = lib.freshBot(name, PLANNER_OF.get(name));
        lib.BotAppearance.randomize(p, { newcomer: false });
        if (p.gender === 1) {
            women++;
            if (p.body[0] === bald) baldWomen++;
        }
        const clan = lib.cliqueColourOf(name);
        if (clan !== null) {
            members++;
            const c = COLOUR[clan % COLOUR.length];
            if (p.colors[1] === c || p.colors[2] === c + 1) inColour++;
        }
    }
    const baldShare = pct(baldWomen, women);
    const clanShare = pct(inColour, members);
    // (a member's own dice give its clan's colour now and then too: 1 in 16)
    check('bodies: fewer bald women (new bodies: under 6 %, was 10-14 %); about 3 in 10 of a levelling clique\'s members in its colour (torso or legs)', baldShare < 6 && clanShare >= 22 && clanShare <= 45, `bald ${baldWomen} of ${women} women (${baldShare.toFixed(1)} %); clan colour ${inColour} of ${members} members (${clanShare.toFixed(1)} %)`);
}

// ---- PKers: the variety ----
{
    const looks = new Set();
    let n = 0;
    const bad = [];
    const SLOTS = ['weapon', 'helm', 'body', 'legs', 'shield', 'neck', 'cape', 'boots', 'gloves'];
    const pkNames = NAMES.filter(x => PLANNER_OF.get(x) === 'extras_pker' || PLANNER_OF.get(x) === 'extras_edgeville_pker');
    for (const members of [true, false]) {
        const profiles = members ? lib.generatePkerProfiles() : lib.freeWorldPkProfiles();
        for (const [i, name] of pkNames.entries()) {
            const base = profiles[i % profiles.length];
            const p = F.pkVariedProfile(name, base, 'pker', members);
            if (members) {
                looks.add(SLOTS.map(s => p[s]).join(','));
                n++;
            }
            for (const s of SLOTS) {
                const id = p[s];
                if (id === -1 || id === undefined) continue;
                if (!members && ObjType.get(id).members) bad.push(`${name}: ${dn(id)} on a free world`);
                const piece = Looks.armourPieceOf(id);
                if (piece && piece.tier >= 0 && !Looks.canWearPiece(piece, p.def)) bad.push(`${name}: ${dn(id)} at Defence ${p.def}`);
                if (/viking_helmet/.test(dn(id)) && p.def < 45) bad.push(`${name}: ${dn(id)} at Defence ${p.def}`);
                const need = { dragon_vambraces: 40, blue_dragon_vambraces: 50, red_dragon_vambraces: 60, black_dragon_vambraces: 70, blue_dragonhide_chaps: 50, red_dragonhide_chaps: 60, black_dragonhide_chaps: 70, dragonhide_chaps: 40, boots_ranger: 40 }[dn(id)];
                if (need && p.range < need) bad.push(`${name}: ${dn(id)} at Ranged ${p.range}`);
            }
            if (p.shield !== -1 && ObjType.get(p.weapon).wearpos2 === 5) bad.push(`${name}: a shield with ${dn(p.weapon)}`);
        }
    }
    // saved: the profile as before unless the save shows the variety
    const name = pkNames[0];
    const base = lib.generatePkerProfiles()[0];
    const varied = F.pkVariedProfile(name, base, 'pker', true);
    const fresh = F.pkVarietyAtLogin(name, base, 'pker', true, false, () => false);
    const savedBase = F.pkVarietyAtLogin(name, base, 'pker', true, true, id => [base.weapon, base.helm, base.body, base.legs, base.neck, base.boots, base.gloves, base.cape].includes(id));
    const shown = ['gloves', 'boots', 'neck', 'legs', 'weapon'].find(f => varied[f] !== base[f] && varied[f] !== -1);
    const savedVaried = shown ? F.pkVarietyAtLogin(name, base, 'pker', true, true, id => id === varied[shown]) : varied;
    const classed = NAMES.find(x => O.nameClassOf(x) === 'mage');
    const mage = O.classPkProfile(classed, lib.generatePkerProfiles()[40], 'pker');
    const kept = F.pkVariedProfile(classed, mage, 'pker', true, true).helm === mage.helm;
    const share = pct(looks.size, n);
    check('PKers: the outfit varies from the profile\'s seed (70 %+ distinct among the PKers\' names), every piece wearable at its levels and world, no shield with a 2h; a class name keeps its hat; a saved PKer keeps its profile unless its save shows the variety, a new one wears it', share >= 70 && bad.length === 0 && JSON.stringify(fresh) === JSON.stringify(varied) && JSON.stringify(savedBase) === JSON.stringify(base) && JSON.stringify(savedVaried) === JSON.stringify(varied) && kept, `${looks.size} distinct of ${n} (${share.toFixed(1)} %); shown by ${shown}${bad.length ? `; ${bad.slice(0, 4).join('; ')}` : ''}`);
}

// ---- notable gear and wealth ----
{
    const p = lib.freshBot(NAMES[3], 'balanced');
    clear(p, InvType.WORN);
    wear(p, [idOf('red_partyhat'), idOf('rune_platebody_gold'), I.DRAGON_SQ_SHIELD, idOf('amulet_of_glory'), idOf('rune_platelegs')]);
    const notable = F.notableGearOf(p);
    const kinds = notable.map(x => x.kind).join(',');
    const nicks = notable.map(x => x.nick).join(', ');
    const w0 = F.wealthOf(p);
    give(p, lib.bankId(), [[I.COINS, 80000]]);
    const w1 = F.wealthOf(p);
    const vendor = lib.freshBot(NAMES[5], 'extras_vendor');
    vendor.botPlanner = 'extras_vendor';
    give(vendor, InvType.INV, [[I.COINS, 500000000]]);
    const expected = [I.DRAGON_SQ_SHIELD, idOf('amulet_of_glory'), idOf('rune_platelegs')].reduce((a, i) => a + (lib.streetPrice(i) ?? ObjType.get(i).cost), 0);
    check("notable gear: a rare first, then status, dragon, members show pieces, with 2004's nicknames; wealth leaves out what it shows off (the partyhat, the (g)), a vendor is never rich", kinds === 'rare,status,dragon,members' && /phat/.test(nicks) && /rune \(g\) plate/.test(nicks) && /d sq/.test(nicks) && /glory/.test(nicks) && w1 - w0 === 80000 && w0 === expected && F.isRich(p) === w1 >= F.RICH_WEALTH && !F.isRich(vendor), `${kinds}: ${nicks}; wealth ${w0} (the d sq, glory and legs ${expected}) then ${w1}`);
}

// ---- prices and the vendors' status stock ----
{
    const rows = lib.streetRows();
    const missing = [];
    for (const p of F.statusPieces()) {
        const row = rows[dn(p.id)];
        if (!row || !/^estimate/.test(row.source)) missing.push(dn(p.id));
    }
    for (const helm of Object.values(F.membersItems().fremennikHelms)) if (!/^estimate/.test(rows[dn(helm)]?.source ?? '')) missing.push(dn(helm));
    const wrongIds = lib.STATUS_STOCK.filter(([id, name]) => ObjType.get(id)?.name !== name || !F.statusPieceOf(id)).map(([id, name]) => `${id} is ${ObjType.get(id)?.name} (${dn(id)}), not ${name}`);
    const order = ['black_platebody_trim', 'black_platebody_gold', 'adamant_platebody_trim', 'adamant_platebody_gold', 'rune_platebody_trim', 'rune_platebody_gold', 'rune_platebody_goldplate'].map(n => lib.streetPrice(idOf(n)));
    const rising = order.every((v, i) => i === 0 || v > order[i - 1]);
    check('prices: every status piece and Fremennik helm in data/street_prices.json, labelled an estimate, dearer up the metals and families; the vendors\' status stock\'s ids are status pieces of those names', missing.length === 0 && wrongIds.length === 0 && rising && lib.STATUS_STOCK.length >= 10, `${F.statusPieces().length} pieces; ${order.join(' < ')}${missing.length ? `; missing ${missing.slice(0, 4).join(', ')}` : ''}${wrongIds.length ? `; ${wrongIds.join('; ')}` : ''}`);
}

// ---- 274's shops: the new keepers and their stock ----
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
                    const stock = line.match(/^stock\d+=([\w+]+),(\d+)/);
                    if (stock && current) invStock.get(current).set(stock[1], Number(stock[2]));
                }
            }
        }
    })(path.join(CONTENT_DIR, 'scripts'));
    const SHOP_INV = { RELLEKKA_CLOTHES: 'viking_clothes_shop', RELLEKKA_WEAPONS: 'viking_weapons_shop', CANIFIS_CLOTHES: 'werewolfstore2', VARROCK_FANCY_DRESS: 'fancyclothesstore', ZAFF_STAFFS: 'memberstaffshop', CHAMPIONS_SCAVVO: 'runiteshop', CHAMPIONS_VALAINE: 'championshop', OZIACH: 'runeplateshop', HEROES_HELEMOS: 'dragonaxeshop' };
    const m = F.membersItems();
    const guild = [I.RUNE_PLATELEGS, I.RUNE_PLATESKIRT, I.RUNE_CHAINBODY, OIF().coif, OIF().dhideChaps[0], OIF().dhideVambraces[0], I.BLACK_FULL_HELM, I.ADAMANT_PLATEBODY, I.RUNE_PLATEBODY, OIF().dhideBodies[0], ...O.meleeWeapons().filter(w => w.tier >= 6 && Gear.gearShopsOf(w.id).length).map(w => w.id)];
    const items = [...Object.values(m.fremennikHelms), ...m.fremennikShirts, ...m.fremennikCloaks, m.fremennikBoots, ...m.wolfenRobes.flat(), F.noveltyItems().yellowCape, O.outfitItems().battlestaff, ...O.meleeWeapons().filter(w => w.kind === 'warhammer' && w.tier <= 5).map(w => w.id), ...guild];
    const bad = [];
    for (const item of items) {
        for (const shop of Gear.gearShopsOf(item)) {
            if (!SHOP_INV[shop]) continue;
            if (!(invStock.get(SHOP_INV[shop])?.get(dn(item)) > 0)) bad.push(`${dn(item)} at ${shop}`);
        }
        if (!Gear.gearShopsOf(item).length) bad.push(`${dn(item)}: no shop`);
    }
    const npcIds = new Map();
    for (const line of fs.readFileSync(path.join(CONTENT_DIR, 'pack/npc.pack'), 'utf8').split('\n')) {
        const mm = line.match(/^(\d+)=(\w+)/);
        if (mm) npcIds.set(Number(mm[1]), mm[2]);
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
            const x = inNpc && line.match(/^(\d+) (\d+) (\d+): (\d+)/);
            if (!x) continue;
            const name = npcIds.get(Number(x[4]));
            if (name) spawns.set(name, [...(spawns.get(name) ?? []), [Number(mm[1]) * 64 + Number(x[2]), Number(mm[2]) * 64 + Number(x[3]), Number(x[1])]]);
        }
    }
    const npcs = lib.ShopTripTask.NPC_NAMES ?? {};
    const far = [];
    for (const key of ['RELLEKKA_CLOTHES', 'RELLEKKA_WEAPONS', 'CANIFIS_CLOTHES', 'CHAMPIONS_SCAVVO', 'CHAMPIONS_VALAINE', 'OZIACH', 'HEROES_HELEMOS']) {
        const npc = npcs[key];
        const [x, z, level] = Gear.WARDROBE_SHOPS[key].location;
        const at = (spawns.get(npc) ?? []).find(([sx, sz, sl]) => sl === level && Math.max(Math.abs(sx - x), Math.abs(sz - z)) <= 8);
        if (!npc || !at) far.push(`${key} (${npc ?? 'no keeper'})`);
    }
    check("shops: the round's pieces are in their shops' 274 stock with some in it; the new keepers (Yrsa, Skulgrimen, Barker; Scavvo, Valaine and Helemos upstairs, Oziach) known to ShopTripTask, each within 8 tiles of its shop's place (on its floor)", bad.length === 0 && far.length === 0, `${items.length} items${bad.length ? `; ${bad.slice(0, 4).join('; ')}` : ''}${far.length ? `; keepers: ${far.join('; ')}` : ''}`);
}

// ---- purchases (pure: a bot not in the world) ----
{
    const W = Looks.wardrobeItems();
    const yellowIdx = W.capes.indexOf(F.noveltyItems().yellowCape);
    const yName = NAMES.find(n => Looks.gearTaste(n).ownCape && Looks.gearTaste(n).capeColour % W.capes.length === yellowIdx && LEVELLING.has(PLANNER_OF.get(n)) && O.combatStyleOf(n) === 'melee' && !O.nameClassOf(n));
    const y = lib.freshBot(yName, 'fighter');
    setLevels(y, { 0: 1, 1: 1, 2: 40, 3: 40 });
    y.x = 3210;
    y.z = 3420;
    give(y, InvType.INV, [[I.COINS, 1000]]);
    const yBuy = Gear.nextAccessory(y, 900, 'fighter');
    // a warhammer-liker: a mace on a free world (and away from Rellekka), a warhammer at Skulgrimen's near it on a members world
    const wName = NAMES.find(n => O.weaponKindOf(n) === 'warhammer' && LEVELLING.has(PLANNER_OF.get(n)));
    const wh = lib.freshBot(wName, 'fighter');
    setLevels(wh, { 0: 20, 1: 1, 2: 20, 3: 20 });
    give(wh, InvType.INV, [[I.COINS, 20000]]);
    wh.x = 2950;
    wh.z = 3390;
    const farKind = Gear.buyingKindOf(wh);
    wh.x = 2700;
    wh.z = 3600;
    const nearKind = Gear.buyingKindOf(wh);
    const nearBuy = Gear.nextGearUpgrade(wh, lib.SCIMITAR_TIERS);
    check("purchases: a yellow-liker's cape is the Varrock tailor's yellow one; a warhammer-liker away from Rellekka buys a mace, near it on a members world a warhammer at Skulgrimen's", yBuy?.itemId === F.noveltyItems().yellowCape && yBuy?.shopKey === 'VARROCK_FANCY_DRESS' && farKind === 'mace' && nearKind === 'warhammer' && /warhammer/.test(dn(nearBuy?.itemId)) && nearBuy?.shopKey === 'RELLEKKA_WEAPONS', `${yName}: ${dn(yBuy?.itemId)} at ${yBuy?.shopKey}; ${wName}: far ${farKind}, near ${nearKind} (${dn(nearBuy?.itemId)} at ${nearBuy?.shopKey})`);
    // a members bot that likes a Fremennik cloak buys it near Rellekka, not far away
    const m = F.membersItems();
    const cName = NAMES.find(n => LEVELLING.has(PLANNER_OF.get(n)) && F.membersFashionOf(n, 'experienced', { defence: 1, ranged: 1 }, O.combatStyleOf(n), { prayer: false, robes: false }).cape !== -1);
    const c = lib.freshBot(cName, PLANNER_OF.get(cName));
    setLevels(c, { 0: 1, 1: 1 });
    give(c, lib.bankId(), [[I.COINS, 200000]]);
    c.x = 2725;
    c.z = 3490;
    const cNear = Gear.nextOutfitPiece(c, 150000);
    c.x = 3210;
    c.z = 3420;
    const cFar = Gear.nextOutfitPiece(c, 150000);
    check('purchases: a members bot that likes a Fremennik cloak buys it at Yrsa\'s from Seers (within reach of Rellekka), nothing from Varrock', m.fremennikCloaks.includes(cNear?.itemId) && cNear?.shopKey === 'RELLEKKA_CLOTHES' && !(cFar && m.fremennikCloaks.includes(cFar.itemId)), `${cName}: from Seers ${dn(cNear?.itemId)} at ${cNear?.shopKey}; from Varrock ${dn(cFar?.itemId) || 'nothing'}`);
}

// ---- purchases at the shops round 1 could not reach (pure) ----
{
    // rune platelegs at Scavvo for a platelegs-liker of 40 Defence with the coins; a rune longsword for a longsword-liker
    // of 40 Attack; Oziach's green d'hide body for a ranger of 40 that likes d'hide
    const legsName = NAMES.find(n => LEVELLING.has(PLANNER_OF.get(n)) && O.combatStyleOf(n) === 'melee' && Looks.gearTaste(n).legs === 'platelegs' && O.weaponKindOf(n) === 'longsword');
    const a = lib.freshBot(legsName, 'fighter');
    setLevels(a, { 0: 40, 1: 40, 2: 40, 3: 40 });
    give(a, lib.bankId(), [[I.COINS, 200000], [I.RUNE_PLATEBODY, 1], [I.RUNE_FULL_HELM, 1], [I.RUNE_KITESHIELD, 1], [I.RUNE_SCIMITAR, 1]]);
    a.x = 3210;
    a.z = 3420;
    const first = Gear.nextGearUpgrade(a, lib.SCIMITAR_TIERS);
    give(a, lib.bankId(), [[first?.itemId ?? -1, 1]]);
    const second = Gear.nextGearUpgrade(a, lib.SCIMITAR_TIERS);
    const rName = NAMES.find(n => LEVELLING.has(PLANNER_OF.get(n)) && O.combatStyleOf(n) === 'ranger' && O.rangerPieces(n, 45, 45, false).body === OIF().dhideBodies[0]);
    const r = lib.freshBot(rName, 'fighter');
    r.botPlanner = 'fighter';
    setLevels(r, { 0: 1, 1: 45, 4: 45 });
    // (its weapon already the best its Attack allows: the ranger's pieces come after the weapon)
    give(r, lib.bankId(), [[I.COINS, 50000], [O.weaponOf(O.weaponKindOf(rName), 1)?.id ?? I.IRON_SCIMITAR, 1]]);
    const ranger = Gear.nextGearUpgrade(r, lib.SCIMITAR_TIERS);
    check("purchases: round 1's unreachable shops: a longsword-liker of 40 Attack buys a rune longsword at Scavvo's, then a platelegs-liker of 40 Defence rune platelegs there; a ranger that likes d'hide buys Oziach's green d'hide body", dn(first?.itemId) === 'rune_longsword' && first?.shopKey === 'CHAMPIONS_SCAVVO' && dn(second?.itemId) === 'rune_platelegs' && second?.shopKey === 'CHAMPIONS_SCAVVO' && ranger?.itemId === OIF().dhideBodies[0] && ranger?.shopKey === 'OZIACH', `${legsName}: ${dn(first?.itemId)} at ${first?.shopKey}, then ${dn(second?.itemId)} at ${second?.shopKey}; ${rName}: ${dn(ranger?.itemId)} at ${ranger?.shopKey}`);
}

// ---- dressing (pure: a bot not in the world, its task a stand-in) ----
{
    const m = F.membersItems();
    const name = NAMES.find(n => LEVELLING.has(PLANNER_OF.get(n)) && O.combatStyleOf(n) === 'melee' && !O.nameClassOf(n) && !O.wieldsTools(n));
    // a skill's bank stop: the status piece to the bank, a show hat and a Fremennik cloak on
    const s = lib.freshBot(name, 'balanced');
    setLevels(s, { 0: 40, 1: 40, 8: 40 });
    clear(s, InvType.WORN);
    wear(s, [idOf('rune_platebody_gold'), I.RUNE_FULL_HELM]);
    give(s, lib.bankId(), [[m.clueHats.cavaliers[0], 1], [m.fremennikCloaks[0], 1]]);
    lib.setTask(s, 'Fish:317');
    Gear.dressForSkill(s);
    const atSkill = wornNames(s);
    const skillOk = !atSkill[4] && atSkill[0] === dn(m.clueHats.cavaliers[0]) && atSkill[1] === dn(m.fremennikCloaks[0]) && bankNames(s).includes('rune_platebody_gold');
    // at Varrock West's bank, a rich melee bot not at a skill puts its (g) on over its plain rune; a poor one does not
    const rich = lib.freshBot(name, 'balanced');
    setLevels(rich, { 0: 40, 1: 40 });
    clear(rich, InvType.WORN);
    wear(rich, [I.RUNE_PLATEBODY, I.RUNE_SCIMITAR]);
    give(rich, lib.bankId(), [[idOf('rune_platebody_gold'), 1], [I.COINS, 150000]]);
    rich.x = 3185;
    rich.z = 3440;
    lib.setTask(rich, 'ShopTrip');
    Gear.dressForSkill(rich);
    const hub = wornNames(rich)[4];
    rich.x = 3100;
    rich.z = 3300;
    const awayBot = lib.freshBot(name, 'balanced');
    setLevels(awayBot, { 0: 40, 1: 40 });
    clear(awayBot, InvType.WORN);
    wear(awayBot, [I.RUNE_PLATEBODY]);
    give(awayBot, lib.bankId(), [[idOf('rune_platebody_gold'), 1], [I.COINS, 150000]]);
    awayBot.x = 3222;
    awayBot.z = 3218;
    lib.setTask(awayBot, 'ShopTrip');
    Gear.dressForSkill(awayBot);
    const away = wornNames(awayBot)[4];
    const poor = lib.freshBot(name, 'balanced');
    setLevels(poor, { 0: 40, 1: 40 });
    clear(poor, InvType.WORN);
    wear(poor, [I.RUNE_PLATEBODY]);
    give(poor, lib.bankId(), [[idOf('rune_platebody_gold'), 1]]);
    poor.x = 3185;
    poor.z = 3440;
    lib.setTask(poor, 'ShopTrip');
    Gear.dressForSkill(poor);
    const poorWorn = wornNames(poor)[4];
    check("dressing: a skill's bank stop banks a status piece and puts a show hat (a cavalier) and a Fremennik cloak on; at Varrock West's bank a rich melee bot puts its (g) on over plain rune, not one away from the hubs or a poor one", skillOk && hub === 'rune_platebody_gold' && away === 'rune_platebody' && poorWorn === 'rune_platebody', `at a skill ${atSkill.filter(Boolean).join(' ')}; at the hub ${hub}; away ${away}; poor ${poorWorn}`);
    // a show-off visit's dressing: a skiller in its apron and wizard hat puts its (t) on over them at the hub's booth; at
    // another bank stop there the apron and hat stay (dressForHub without `showingOff`)
    const sName = NAMES.find(n => PLANNER_OF.get(n) === 'skiller' && !O.nameClassOf(n) && O.combatStyleOf(n) !== 'mage' && O.combatStyleOf(n) !== 'ranger');
    const showOff = [];
    for (const showing of [false, true]) {
        const so = lib.freshBot(sName, 'skiller');
        setLevels(so, { 0: 40, 1: 40 });
        clear(so, InvType.WORN);
        wear(so, [idOf('bluewizhat'), idOf('brown_apron')]);
        give(so, lib.bankId(), [[idOf('adamant_platebody_trim'), 1], [idOf('adamant_full_helm_trim'), 1], [I.COINS, 150000]]);
        so.x = 3185;
        so.z = 3440;
        lib.setTask(so, showing ? 'ShowOff' : 'ShopTrip');
        Gear.dressForHub(so, showing);
        showOff.push(wornNames(so));
    }
    check("dressing: on a show-off visit a skiller puts its (t) helm and platebody on over its wizard hat and apron at the hub's booth; at another bank stop there they stay", showOff[0][0] === 'bluewizhat' && showOff[0][4] === 'brown_apron' && showOff[1][0] === 'adamant_full_helm_trim' && showOff[1][4] === 'adamant_platebody_trim', `${sName}: another stop ${showOff[0].filter(Boolean).join(' ')}; show-off ${showOff[1].filter(Boolean).join(' ')}`);
    // before a Wilderness fight: the partyhat and the (g) to the bank, plain rune on
    const wb = lib.freshBot(name, 'balanced');
    setLevels(wb, { 0: 40, 1: 40 });
    clear(wb, InvType.WORN);
    wear(wb, [idOf('red_partyhat'), idOf('rune_platebody_gold'), I.RUNE_SCIMITAR]);
    give(wb, lib.bankId(), [[I.RUNE_PLATEBODY, 1], [I.RUNE_FULL_HELM, 1]]);
    const wildStep = { location: [3100, 3600, 0] };
    wb._bot = { currentTask: { name: 'Combat:1', activityStep: () => wildStep } };
    const needs = Gear.needsFightDress(wb);
    Gear.dressForFight(wb);
    const wild = wornNames(wb);
    const safe = lib.freshBot(name, 'balanced');
    clear(safe, InvType.WORN);
    wear(safe, [idOf('red_partyhat')]);
    safe._bot = { currentTask: { name: 'Combat:1', activityStep: () => ({ location: [3250, 3270, 0] }) } };
    check('dressing: before a Wilderness fight a rich bot banks its partyhat and (g) platebody and wears its plain rune (its first walk goes to the bank for it); away from the Wilderness nothing', needs && wild[0] === 'rune_full_helm' && wild[4] === 'rune_platebody' && bankNames(wb).includes('red_partyhat') && bankNames(wb).includes('rune_platebody_gold') && !Gear.needsWildernessStrip(safe), `needs ${needs}: ${wild.filter(Boolean).join(' ')}`);
}

// ---- in the world: staged bots ----
lib.setHangoutRateForTest(0);
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0 });
lib.setCliqueBehaviourForTest(false);
lib.resetDirectorForTest();
lib.setDirectorForTest({ first: 1e9 });
lib.setEventRatesForTest({ odds: 0 });
lib.setArenaRatesForTest(0);
lib.ShowOff.setShowOffForTest(Infinity);
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
/** a staged bot: no newbie, no sub-task; clean pack, worn and bank; full run energy; at a tile */
function stage(pred, levels, at) {
    const p = sim.bots().find(b => !used.has(b) && b.botNewbie !== true && b.level === 0 && !sim.botPlayer(b)?.subTask && pred(b));
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
const assign = (p, task) => {
    const bot = sim.botPlayer(p);
    bot.planner.pickTask = () => task;
    bot.currentTask?.interrupt();
};
{
    scene(SEED, 'a show-off buys a status piece');
    const buyer = stage(b => lib.isLevelling(b.botPlanner) && O.combatStyleOf(b.username) === 'melee' && !O.nameClassOf(b.username), { 0: 50, 1: 50, 2: 50, 3: 50 }, [3180, 3433]);
    const vendor = stage(b => b.botPlanner === 'extras_vendor' || (b !== buyer && !lib.isLevelling(b.botPlanner) && b.botPlanner !== 'extras_pker' && b.botPlanner !== 'extras_edgeville_pker'), { 0: 40, 1: 40, 3: 40 }, [3184, 3443]);
    let detail = 'no bots';
    let ok = false;
    if (buyer && vendor) {
        vendor.botPlanner = 'extras_vendor';
        wear(buyer, [I.RUNE_PLATEBODY, I.RUNE_SCIMITAR]);
        give(buyer, lib.bankId(), [[I.COINS, 400000], [I.TROUT, 5]]);
        // the vendor: a VendorTask stocked with a rune (g) platebody (its own stocking, then the stock set)
        const vTask = new lib.VendorTask();
        assign(vendor, vTask);
        run(5);
        const g = idOf('rune_platebody_gold');
        const row = lib.Vendor.vendorStock?.().find?.(s => s.itemId === g);
        let stocked = false;
        for (let i = 0; i < 400 && !stocked; i++) {
            if (row && sim.botPlayer(vendor)?.currentTask === vTask && vTask.state !== 'init') {
                vTask._stock(vendor, row);
                stocked = lib.vendorAskOf(vendor, g) !== null;
            }
            if (!stocked) run(1);
        }
        const price = lib.vendorAskOf(vendor, g);
        const visit = new lib.ShowOff.ShowOffTask(lib.TRADE_BANKS.find(b => b.key === 'varrock_west'));
        assign(buyer, visit);
        let bought = -1;
        let worn = -1;
        let traded = false;
        const trace = [];
        run(1500, () => {
            if (process.env.FASHION_TRACE && World.currentTick < 60) trace.push(`t${World.currentTick} ${visit.state} b@${buyer.x},${buyer.z} v@${vendor.x},${vendor.z} vt=${vendor.botTradeTargetPid} bt=${buyer.botTradeTargetPid} vs=${vTask.state} bs=${lib.tradeScreen(buyer)} vscr=${lib.tradeScreen(vendor)} vtask=${taskKind(vendor)} btask=${taskKind(buyer)} ph=${visit.session?.phase} pu=${visit.session?.partnerUid} vuid=${vendor.uid} bvar=${buyer.getVar(lib.VarPlayerType.getId('tradepartner'))} vvar=${vendor.getVar(lib.VarPlayerType.getId('tradepartner'))} found=${!!World.getPlayerByUid(vendor.uid)}`);
            if (lib.tradeScreen(buyer) !== null) traded = true;
            if (bought < 0 && lib.ShowOff.showOffStats.bought > 0) bought = World.currentTick;
            if (bought >= 0 && wornNames(buyer)[4] === 'rune_platebody_gold') {
                worn = World.currentTick;
                return true;
            }
        });
        if (process.env.FASHION_TRACE) out(trace.slice(0, 80).join('\n'));
        ok = stocked && traded && bought >= 0 && worn >= 0;
        detail = `${buyer.username} buys from ${vendor.username} (asks ${price}): stocked ${stocked}, trade screens ${traded}, bought at t${bought}, worn at t${worn} (${wornNames(buyer).filter(Boolean).join(' ')}); stats ${JSON.stringify(lib.ShowOff.showOffStats)}`;
    }
    check("in the world: a rich bot's show-off visit at Varrock West buys a vendor's rune (g) platebody through the trade screens and wears it", ok, detail);
}
{
    // (round 1's leftover) the shops it could not reach: Scavvo upstairs in the Champions' Guild (the stairs), Oziach (his dialogue)
    scene(SEED, 'the guild and Oziach');
    const results = [];
    for (const [shopKey, item, at] of [['CHAMPIONS_SCAVVO', OIF().coif, [3210, 3420]], ['OZIACH', OIF().dhideBodies[0], [3093, 3491]]]) {
        const p = stage(b => lib.isLevelling(b.botPlanner), { 0: 45, 1: 45, 2: 45, 3: 45, 4: 45 }, at);
        if (!p) {
            results.push(`${shopKey}: no bot`);
            continue;
        }
        give(p, InvType.INV, [[I.COINS, 50000]]);
        const cost = Math.ceil(ObjType.get(item).cost * 1.3);
        assign(p, new lib.ShopTripTask(shopKey, item, 1, cost));
        let bought = -1;
        let upstairs = false;
        run(900, () => {
            if (p.level === 1) upstairs = true;
            if (packNames(p).includes(dn(item)) || wornNames(p).includes(dn(item))) {
                bought = World.currentTick;
                return true;
            }
        });
        const r = { shopKey, bot: p.username, item: dn(item), bought, upstairs, at: [p.x, p.z, p.level] };
        // (and from Scavvo's floor out again, down the stairs and out of the hall's door (the ChampionsGuild0 gateway: from
        // the hall a far walk found no way out, and a rescue jump took the bot 220 tiles), to Varrock's tailor, in by the
        // street to his north-west (his back is to the city's east wall): a yellow cape, no rescue jump on the way)
        if (shopKey === 'CHAMPIONS_SCAVVO' && bought >= 0) {
            const cape = idOf('yellow_cape');
            const jumps = lib.teleportStats?.jumps ?? 0;
            assign(p, new lib.ShopTripTask('VARROCK_FANCY_DRESS', cape, 1, Math.ceil(ObjType.get(cape).cost * 1.3)));
            let got = -1;
            run(900, () => {
                if (packNames(p).includes('yellow_cape') || wornNames(p).includes('yellow_cape')) {
                    got = World.currentTick;
                    return true;
                }
            });
            r.tailor = { got, jumps: (lib.teleportStats?.jumps ?? 0) - jumps, at: [p.x, p.z, p.level] };
        }
        results.push(r);
    }
    const [scavvo, oziach] = results;
    check("in the world: a bot buys the coif upstairs at Scavvo's (the Champions' Guild's stairs, walked) and Oziach's green d'hide body (his dialogue answered); from Scavvo's it walks out of the guild and in to Varrock's tailor for a yellow cape, no rescue jump", scavvo?.bought >= 0 && scavvo?.upstairs && oziach?.bought >= 0 && scavvo?.tailor?.got >= 0 && scavvo?.tailor?.jumps === 0, JSON.stringify(results));
}
{
    scene(SEED, 'a new PKer in its varied outfit');
    const pk = sim.bots().find(b => b.botPlanner === 'extras_pker' && !used.has(b));
    let detail = 'no PKer';
    let ok = false;
    if (pk) {
        used.add(pk);
        const profile = lib.pkerProfileFor(pk.username, pk);
        run(400, () => {
            const w = pk.getInventory(InvType.WORN);
            return [profile.gloves, profile.boots, profile.neck].every(i => i === -1 || [...Array(14).keys()].some(s => w.get(s)?.id === i));
        });
        const w = wornNames(pk);
        ok = [profile.gloves, profile.boots, profile.neck].every(i => i === -1 || w.includes(dn(i)));
        detail = `${pk.username}: profile ${profile.name} gloves ${dn(profile.gloves) || 'none'}, boots ${dn(profile.boots) || 'none'}, neck ${dn(profile.neck)}; worn ${w.filter(Boolean).join(' ')}`;
    }
    check('in the world: a new PKer wears its varied gloves, boots and amulet', ok, detail);
}

check('errors: none (bot errors, console errors)', BotManager.stats().errors === 0 && logErrors.length === 0, `${BotManager.stats().errors} bot errors; ${logErrors.slice(0, 2).join(' | ')}`);

out(`fashion: ${NAMES.length} names, a world of ${sim.bots().length} bots, seed ${SEED}`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
