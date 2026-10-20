#!/usr/bin/env node
// PKer bots and the combat bots' searches, in the real rev-274 world on a free world (Settings › World › Members off):
//   1. the free world's PK profiles (port/BotPkGear.ts) hold only free items, each the 274 object its key names, worn
//      where its slot says (no shield with a 2h sword); on a free world no PKer or Edgeville PKer wears or carries a
//      members item, also one that arrives from a members world with members gear on and in its pack, and every worn
//      item sits in its own wear position
//   2. target claims: two PKers that see the same human in a multi-combat zone at the same moment do not both go for
//      it (upstream read `bot.task`, which BotPlayer does not have, so a target was never claimed)
//   3. the combat bots' NPC claims hold while the NPC moves (keyed by its nid; 274's Npc has no `index`)
//   4. the gate predicate: doors and gates (in walls, and the centrepiece ones), never drawers, cupboards, wardrobes,
//      coffins or trapdoors
//   5. smarter PKers (port/BotPkTactics): the target's style from its weapon; prayers on the prayer tab (Protect Item
//      and the protection against the style, switched with it, off after; with honour, Edgeville's, no protection prayer
//      at all, and a target with one on called out); a kill ends the fight (getting out, eating, potions and the KO:
//      test/pkfight.test.mjs, on a members world)
//
//   node web/engine/bots/test/pk.test.mjs [--ticks=400] [--seed=N] [--debug]
//
// Exit code 1 if a check fails. Nothing is written outside build/tmp/bots.
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const TICKS = Number(args.ticks ?? 400);
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

const engineDir = prepareEngineClone('pk-f2p', simWorldConfig({ members: false }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/pk.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, InvType, ObjType, LocType, CategoryType, Loc, EntityLifeCycle, LocShape, PlayerStat } = lib;

const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok: !!ok, detail });
}
const debugname = id => ObjType.get(id)?.debugname ?? `#${id}`;
function items(player, invId) {
    const inv = player.getInventory(invId);
    const list = [];
    for (let slot = 0; slot < (inv?.capacity ?? 0); slot++) {
        const it = inv.get(slot);
        if (it) list.push({ slot, id: it.id, count: it.count });
    }
    return list;
}

const N = 6; // three of each PK task
const sim = await lib.Sim.create({ bots: N, members: false, debug: DEBUG, spawnPerTick: N });
sim.addHuman(3222, 3218, 0);
const human = sim.human;
const tickOnce = () => sim.tick();

// ---- 1a. the free profiles ----
const EXPECTED = {
    RUNE_SCIMITAR: 'rune_scimitar', RUNE_2H_SWORD: 'rune_2h_sword', RUNE_FULL_HELM: 'rune_full_helm', RUNE_PLATEBODY: 'rune_platebody',
    RUNE_PLATELEGS: 'rune_platelegs', RUNE_KITESHIELD: 'rune_kiteshield', ADAMANT_FULL_HELM: 'adamant_full_helm',
    ADAMANT_PLATEBODY: 'adamant_platebody', ADAMANT_PLATELEGS: 'adamant_platelegs', ADAMANT_KITESHIELD: 'adamant_kiteshield',
    COIF: 'coif', LEATHER_COWL: 'leather_cowl', LEATHER_BODY: 'leather_armour', MONK_ROBE_TOP: 'monkrobetop',
    GREEN_DHIDE_CHAPS: 'dragonhide_chaps', GREEN_DHIDE_VAMBRACES: 'dragon_vambraces', AMULET_OF_STRENGTH: 'amulet_of_strength',
    AMULET_OF_POWER: 'amulet_of_power', LEATHER_BOOTS: 'leather_boots', RED_CAPE: 'red_cape', BLACK_CAPE: 'black_cape',
    BLUE_CAPE: 'blue_cape', YELLOW_CAPE: 'yellow_cape', GREEN_CAPE: 'green_cape', PURPLE_CAPE: 'purple_cape',
    ORANGE_CAPE: 'orange_cape', SWORDFISH: 'swordfish', LOBSTER: 'lobster', STRENGTH_POTION4: 'strength4',
    OAK_SHORTBOW: 'oak_shortbow', STEEL_ARROW: 'steel_arrow'
};
{
    const wrong = [];
    for (const [key, id] of Object.entries(lib.F2P_PK_ITEMS)) {
        const obj = ObjType.get(id);
        if (!obj) wrong.push(`${key}=${id}: no such obj`);
        else if (obj.debugname !== EXPECTED[key]) wrong.push(`${key}=${id} is ${obj.debugname}, expected ${EXPECTED[key]}`);
        else if (obj.members) wrong.push(`${key}=${id} (${obj.debugname}) is members-only`);
    }
    for (const key of Object.keys(EXPECTED)) if (!(key in lib.F2P_PK_ITEMS)) wrong.push(`${key} is not in F2P_PK_ITEMS`);
    check('free PK items: each is the 274 object its key names, and none is members-only', wrong.length === 0, wrong.slice(0, 4).join('; ') || `${Object.keys(EXPECTED).length} items`);

    // the slot each profile field is worn in (274 wearpos), and what a free player can do with the rest
    const SLOTS = { weapon: 3, helm: 0, body: 4, legs: 7, shield: 5, neck: 2, cape: 1, boots: 10, gloves: 9, ammo: 13 };
    const profiles = lib.freeWorldPkProfiles();
    const bad = [];
    for (const p of profiles) {
        for (const [field, slot] of Object.entries(SLOTS)) {
            const id = p[field];
            if (id === -1) continue;
            const obj = ObjType.get(id);
            if (obj.members) bad.push(`${p.name}.${field} ${obj.debugname} is members-only`);
            if (obj.wearpos !== slot) bad.push(`${p.name}.${field} ${obj.debugname} is worn in slot ${obj.wearpos}, not ${slot}`);
        }
        if (ObjType.get(p.weapon).wearpos2 === SLOTS.shield && p.shield !== -1) bad.push(`${p.name}: a shield with the two-handed ${debugname(p.weapon)}`);
        for (const id of [p.specWeapon, p.rangeWeapon, p.food, ...p.pots]) if (id !== -1 && ObjType.get(id).members) bad.push(`${p.name}: ${debugname(id)} is members-only`);
        // (no special weapon on a free world; the bow it switches to for a runner, port/BotPkTactics, is a free one)
        if (p.specWeapon !== -1) bad.push(`${p.name}: a special weapon`);
        if (p.rangeWeapon !== lib.F2P_PK_ITEMS.OAK_SHORTBOW || p.ammo !== lib.F2P_PK_ITEMS.STEEL_ARROW) bad.push(`${p.name}: not the oak shortbow and steel arrows`);
    }
    check(`free PK profiles: ${profiles.length} profiles, only free items, each worn in its own slot`, profiles.length === 60 && bad.length === 0, bad.slice(0, 4).join('; '));
}

// ---- 1b. no members item on a PKer on a free world, also one from a members world ----
while (sim.bots().length < N && World.currentTick < 20) tickOnce();
const pkers = sim.bots();
const MEMBERS_WORN = { 0: 'dragon_med_helm', 1: 'zamorak_cape', 2: 'amulet_of_glory', 3: 'dragon_longsword', 4: 'black_dragonhide_body', 7: 'black_dragonhide_chaps', 9: 'black_dragon_vambraces', 13: 'rune_arrow' };
const MEMBERS_PACK = ['shark', 'shark', '4dose2attack', '4dose2strength', 'dragon_dagger_p', 'magic_shortbow'];
pkers.forEach((player, i) => {
    const bot = sim.botPlayer(player);
    const Task = i < 3 ? lib.PKerTask : lib.EdgevillePKerTask;
    bot.planner.pickTask = () => new Task();
    // as a members world leaves a PKer in its save
    const worn = player.getInventory(InvType.WORN);
    for (const [slot, name] of Object.entries(MEMBERS_WORN)) worn.set(Number(slot), { id: ObjType.getId(name), count: name === 'rune_arrow' ? 50 : 1 });
    const inv = player.getInventory(InvType.INV);
    for (const name of MEMBERS_PACK) inv.add(ObjType.getId(name), 1);
});
check('setup: the PK bots start with members gear on and in their packs', pkers.every(p => items(p, InvType.WORN).some(it => ObjType.get(it.id).members) && items(p, InvType.INV).some(it => ObjType.get(it.id).members)), `${pkers.length} bots`);

const violations = [];
const misplaced = [];
let firstAiTick = -1;
for (let t = 0; t < TICKS; t++) {
    tickOnce();
    for (const player of pkers) {
        const task = sim.botPlayer(player)?.currentTask;
        if (!task) continue;
        if (firstAiTick === -1) firstAiTick = World.currentTick;
        for (const [invId, where] of [[InvType.WORN, 'worn'], [InvType.INV, 'in the pack']]) {
            for (const it of items(player, invId)) {
                if (ObjType.get(it.id).members) violations.push(`t${World.currentTick} ${player.username} (${task.name}/${task.state}): ${debugname(it.id)} ${where}`);
            }
        }
        const worn = player.getInventory(InvType.WORN);
        for (const it of items(player, InvType.WORN)) {
            if (ObjType.get(it.id).wearpos !== it.slot) misplaced.push(`t${World.currentTick} ${player.username}: ${debugname(it.id)} in worn slot ${it.slot}`);
        }
        if (worn.items?.[-1] !== undefined) misplaced.push(`t${World.currentTick} ${player.username}: something in worn slot -1`);
    }
}
const summary = pkers
    .map(p => {
        const task = sim.botPlayer(p)?.currentTask;
        return `${p.username} ${task?.name}/${task?.state} ${task?.profile?.name ?? '-'} worn [${items(p, InvType.WORN).map(it => debugname(it.id)).join(',')}]`;
    })
    .join('; ');
check(`free world: no PKer wears or carries a members item (${TICKS} ticks from their first task tick)`, violations.length === 0, violations.length ? `${violations.length} bot-ticks: ${violations.slice(0, 4).join('; ')}` : summary.slice(0, 600));
check('free world: every PKer used a free profile and is geared from it', pkers.every(p => /^f2p-/.test(sim.botPlayer(p)?.currentTask?.profile?.name ?? '') && items(p, InvType.WORN).some(it => it.slot === 3)), pkers.map(p => `${p.username}:${sim.botPlayer(p)?.currentTask?.profile?.name ?? '-'}`).join(' '));
// ---- 1d. a PKer's build is its own: from its name, the same at every login (sessions log bots in and out) ----
{
    const names = lib.BOT_NAMES.slice(0, 100);
    const sameEachTime = names.every(n => lib.pkerProfileFor(n) === lib.pkerProfileFor(n) && lib.edgevillePkerProfileFor(n) === lib.edgevillePkerProfileFor(n));
    const free = names.every(n => /^f2p-/.test(lib.pkerProfileFor(n).name) && /^f2p-/.test(lib.edgevillePkerProfileFor(n).name));
    const builds = new Set(names.map(n => lib.pkerProfileFor(n).name)).size;
    // the tables themselves come out the same at every start (seeded), so the same index is the same build
    const json = f => JSON.stringify(f());
    const tablesStable = json(lib.freeWorldPkProfiles) === json(lib.freeWorldPkProfiles) && json(lib.generatePkerProfiles) === json(lib.generatePkerProfiles) && json(lib.generateEdgevillePkerProfiles) === json(lib.generateEdgevillePkerProfiles);
    const used = pkers.every(p => {
        const task = sim.botPlayer(p)?.currentTask;
        return task?.profile === (task instanceof lib.PKerTask ? lib.pkerProfileFor : lib.edgevillePkerProfileFor)(p.username);
    });
    check('PK builds: from the bot\'s name (the same at every login), free ones on a free world, tables the same at every start', sameEachTime && free && tablesStable && used && builds >= 20, `same each time ${sameEachTime}, all free ${free}, tables stable ${tablesStable}, the PKers use theirs ${used}; ${builds} different builds over ${names.length} names`);
}
check('worn items: each in its own wear position (none in slot -1, no 2h sword over a shield)', misplaced.length === 0, misplaced.slice(0, 4).join('; '));
const bankedMembers = pkers.reduce((n, p) => n + items(p, InvType.getId('bank')).filter(it => ObjType.get(it.id).members).length, 0);
check('free world: a PKer keeps its members gear in its bank (bots keep their items)', bankedMembers > 0, `${bankedMembers} members stacks banked across ${pkers.length} bots`);
check('usableOnThisWorld: false for a members item on a free world, true for a free one', !lib.usableOnThisWorld(ObjType.getId('shark')) && lib.usableOnThisWorld(ObjType.getId('swordfish')) && !lib.usableOnThisWorld(-1));

// ---- 2. target claims: two PKers, one human, a multi-combat zone ----
{
    const [a, b] = pkers.filter(p => sim.botPlayer(p)?.currentTask instanceof lib.PKerTask);
    const ta = sim.botPlayer(a).currentTask;
    const tb = sim.botPlayer(b).currentTask;
    // the other PKers stand aside (and stop hunting) in Lumbridge
    for (const p of pkers) {
        if (p === a || p === b) continue;
        sim.botPlayer(p).tick = () => {};
        p.clearWaypoints();
        p.clearPendingAction();
        p.teleJump(3222 + pkers.indexOf(p), 3220, 0);
    }
    // a walkable multi-combat tile deep in the wilderness, with walkable tiles 2 east and 2 west of it
    let spot = null;
    for (let dx = 0; dx < 30 && !spot; dx++) {
        for (const [x, z] of [[3235 + dx, 3663], [3235 - dx, 3663], [3050 + dx, 3695]]) {
            const ok = [-2, 0, 2].every(o => sim.isWalkable(x + o, z, 0) && lib.isMulti(x + o, z, 0)) && lib.wildernessLevelAt(x, z) >= 15;
            if (ok) {
                spot = [x, z];
                break;
            }
        }
    }
    if (!spot) {
        check('claims: a multi-combat tile in the deep wilderness', false, 'none found');
    } else {
        // both PKers and the human the same combat level, side by side; both scan for a target on their next tick
        tb.profile = ta.profile;
        for (let stat = 0; stat < a.baseLevels.length; stat++) b.setLevel(stat, a.baseLevels[stat]);
        sim.copyLevels(a);
        sim.teleportHuman(spot[0], spot[1], 0);
        a.teleJump(spot[0] - 2, spot[1], 0);
        b.teleJump(spot[0] + 2, spot[1], 0);
        for (const [p, task] of [[a, ta], [b, tb]]) {
            p.clearWaypoints();
            p.clearPendingAction();
            Object.assign(task, { state: 'patrol', rescanTimer: 0, cooldown: 0, target: null, respawnTimer: 0, zoneTicks: 0 });
            task.blacklist.clear();
            task.stuck.reset(); // (the teleport is no sign of a stuck walk)
            task.watchdog.notifyActivity();
        }
        tickOnce(); // the teleports land
        for (const task of [ta, tb]) Object.assign(task, { state: 'patrol', rescanTimer: 0, cooldown: 0, target: null });
        let most = 0;
        let anyone = false;
        const seen = [];
        for (let t = 0; t < 12; t++) {
            tickOnce();
            const on = [ta, tb].filter(task => task.target === human).length;
            most = Math.max(most, on);
            anyone ||= on > 0;
            seen.push(`${ta.state[0]}${tb.state[0]}${on}`);
        }
        check(
            'claims: two PKers that see the same human in a multi-combat zone do not both go for it',
            anyone && most === 1,
            `human cb ${human.combatLevel} at ${human.x},${human.z} (wild ${lib.wildernessLevelAt(human.x, human.z)}, multi ${lib.isMulti(human.x, human.z, 0)}); PKers cb ${a.combatLevel}/${b.combatLevel}; at most ${most} on the human at once (${seen.join(' ')})`
        );
    }
}

// ---- 1c. the PK equip helper (port/BotPkGear.ts pkEquipItem: the PK tasks' equipItem) ----
{
    const p = pkers.find(q => !(sim.botPlayer(q)?.currentTask instanceof lib.PKerTask)); // one that stands aside
    const worn = p.getInventory(InvType.WORN);
    const inv = p.getInventory(InvType.INV);
    worn.removeAll();
    inv.removeAll();
    const id = name => ObjType.getId(name);
    const wornId = slot => worn.get(slot)?.id ?? -1;
    const results = [];
    // a members weapon on a free world: not put on (the wear script would have; 274 only hides its Wield op)
    inv.add(id('dragon_dagger_p'), 1);
    lib.pkEquipItem(p, id('dragon_dagger_p'));
    results.push(['a members weapon stays in the pack', wornId(3) === -1 && inv.getItemCount(id('dragon_dagger_p')) === 1]);
    // an item that cannot be worn (979, upstream's highwayman mask among the pures' hats, is 274's quest mask with no
    // wear position) is not put anywhere
    inv.add(979, 1);
    lib.pkEquipItem(p, 979);
    results.push(['an unwearable item (979) stays in the pack', ObjType.get(979).wearpos === -1 && inv.getItemCount(979) === 1 && worn.items?.[-1] === undefined]);
    // a shield over a two-handed weapon: the weapon comes off, and so does the special attack the bot had set (else
    // 274's sa_enabled reads the param of an empty weapon slot on its next attack: a script error)
    worn.set(3, { id: id('rune_2h_sword'), count: 1 });
    p.setVar(301, 1); // sa_attack
    inv.add(id('rune_kiteshield'), 1);
    lib.pkEquipItem(p, id('rune_kiteshield'));
    results.push(['a shield takes a 2h weapon off and ends the special attack', wornId(5) === id('rune_kiteshield') && wornId(3) === -1 && inv.getItemCount(id('rune_2h_sword')) === 1 && p.getVar(301) === 0]);
    // a 2h sword while the wear script cannot run (no protected access): put on directly, and the shield comes off
    p.protect = true;
    lib.pkEquipItem(p, id('rune_2h_sword'));
    p.protect = false;
    results.push(['a 2h sword without the wear script takes the shield off', wornId(3) === id('rune_2h_sword') && wornId(5) === -1 && inv.getItemCount(id('rune_kiteshield')) === 1]);
    // the KO weapon's swap (port/BotPkFight: the PK tasks' KO switch, upstream's useSpecial before it): the weapon it
    // replaces goes into the pack once. Upstream's own worn.set had dropped it and put it back in the pack there: with
    // the port's helpers that was a second copy at every special (three rune scimitars in a pack, observe run A). A free
    // world's KO weapon: the rune 2h sword after the scimitar
    worn.removeAll();
    inv.removeAll();
    worn.set(3, { id: id('rune_scimitar'), count: 1 });
    inv.add(id('rune_2h_sword'), 1);
    const swapped = lib.pkTryEquipFromInventory(p, id('rune_2h_sword'));
    results.push(['a KO weapon swap puts one copy of the weapon it replaces in the pack', swapped && wornId(3) === id('rune_2h_sword') && inv.getItemCount(id('rune_scimitar')) === 1]);
    p.setVar(301, 1); // (a special attack left set)
    // a special attack left set without a special weapon in hand is dropped (port/BotPkGear pkDropStaleSpecial: with
    // the weapon slot empty later, 274's [proc,sa_enabled] read obj -1 at every attack, a script error), and kept with one
    lib.pkDropStaleSpecial(p);
    const droppedNoSpecial = p.getVar(301) === 0;
    worn.set(3, null);
    p.setVar(301, 1);
    lib.pkDropStaleSpecial(p);
    const droppedEmpty = p.getVar(301) === 0;
    // (a members world's dragon dagger, worn on a free world: 274 takes its special away, the param with it)
    worn.set(3, { id: id('dragon_dagger'), count: 1 });
    p.setVar(301, 1);
    lib.pkDropStaleSpecial(p);
    const droppedMembers = p.getVar(301) === 0 && !lib.wieldsSpecialWeapon(p);
    worn.set(3, null);
    p.setVar(301, 0);
    results.push(['a special attack left set is dropped without a special weapon in hand (a plain one, none, a members one on a free world)', droppedNoSpecial && droppedEmpty && droppedMembers]);
    const failed = results.filter(([, ok]) => !ok).map(([what]) => what);
    check('PK equip: no members item on a free world, nothing unwearable, the wear script\'s conflicts (2h and shield), a special attack ends with the weapon', failed.length === 0, failed.join('; ') || results.map(([what]) => what).join('; '));
}

// ---- 3. the combat bots' NPC claims ----
{
    let npc = null;
    for (const n of World.npcs) {
        if (n && n.nid >= 0 && n.target === null && n.isActive) {
            npc = n;
            break;
        }
    }
    const step = lib.SkillProgression.ATTACK[0];
    const t1 = new lib.CombatTask(step, PlayerStat.ATTACK);
    const t2 = new lib.CombatTask(step, PlayerStat.ATTACK);
    t1._claimNpc(npc);
    const claimed = !t2._isNpcAvailable(npc);
    const [x, z] = [npc.x, npc.z];
    npc.x += 1; // it walks a tile
    const stillClaimed = !t2._isNpcAvailable(npc);
    npc.x = x;
    npc.z = z;
    t1._releaseNpc();
    const released = t2._isNpcAvailable(npc);
    check("combat: a claimed NPC stays claimed when it moves, and is free once released (the key is its nid; 274's Npc has no index)", claimed && stillClaimed && released && !('index' in npc), `npc ${npc.nid} type ${npc.type}: claimed ${claimed}, after a step ${stillClaimed}, released ${released}`);
}

// ---- 4. the gate predicate ----
{
    const loc = (name, shape) => new Loc(0, 3222, 3222, 1, 1, EntityLifeCycle.RESPAWN, LocType.getId(name), shape, 0);
    const WALL = LocShape.WALL_STRAIGHT;
    const CENTRE = LocShape.CENTREPIECE_STRAIGHT;
    const gates = [
        ['loc_1530', WALL, 'a door'],
        ['loc_1530', LocShape.WALL_DIAGONAL, 'a diagonal door'],
        ['loc_1551', WALL, 'a gate'],
        ['loc_1528', WALL, 'the Al Kharid palace curtain'],
        ['gnome_areagate', CENTRE, 'the Gnome Stronghold gate (a centrepiece)'],
        ['treedoorl', CENTRE, 'a tree door (a centrepiece)']
    ];
    const notGates = [
        ['drawers2', CENTRE, 'drawers'],
        ['cupboard', CENTRE, 'a cupboard'],
        ['blackarmcupboardshut', CENTRE, 'a cupboard without the category'],
        ['spookywardrobe', CENTRE, 'a wardrobe'],
        ['coffin', CENTRE, 'a coffin'],
        ['shutghostcoffin', CENTRE, "the Restless Ghost's coffin"],
        ['manholeclosed', CENTRE, 'a manhole'],
        ['percy_sacks', CENTRE, 'sacks'],
        ['trapdoor', LocShape.GROUND_DECOR, 'a trapdoor'],
        ['border_gate_toll_left', WALL, 'the toll gate (bots cross it by teleport)'],
        ['wiztowerportal', CENTRE, 'a portal']
    ];
    const wrong = [];
    for (const [name, shape, what] of gates) if (!lib._isClosedGate(loc(name, shape))) wrong.push(`${what} (${name}) is not a gate`);
    for (const [name, shape, what] of notGates) if (lib._isClosedGate(loc(name, shape))) wrong.push(`${what} (${name}) is a gate`);
    // and in the world: no furniture at all
    const drawer = CategoryType.getId('drawer');
    const cupboard = CategoryType.getId('cupboard_closed');
    let passing = 0;
    let furniture = 0;
    for (const l of lib.allLocs()) {
        if (!lib._isClosedGate(l)) continue;
        passing++;
        const t = LocType.get(l.type);
        if (t.forceapproach !== 0 || t.category === drawer || t.category === cupboard || l.shape === LocShape.GROUND_DECOR) {
            furniture++;
            if (furniture <= 3) wrong.push(`${t.debugname} at ${l.x},${l.z} passes`);
        }
    }
    check('gates: doors and gates (also centrepiece ones) pass; drawers, cupboards, wardrobes, coffins, trapdoors and the toll gate do not', wrong.length === 0, wrong.slice(0, 5).join('; ') || `${passing} closed doors and gates in the free world's map, no furniture`);
}

// ---- 5. smarter PKers (port/BotPkTactics): the target's style, prayers on the prayer tab, the kill ----
{
    const a = pkers[0];
    const bot = sim.botPlayer(a);
    bot.tick = () => {}; // (its AI off: the tactics are called here)
    a.clearPendingAction();
    a.clearWaypoints();
    sim.teleportHuman(3100, 3540, 0); // (by Edgeville, in the Wilderness)
    a.teleJump(3101, 3540, 0);
    for (let i = 0; i < 3; i++) tickOnce();
    const wear = (player, name) => player.getInventory(InvType.WORN).set(3, { id: ObjType.getId(name), count: 1 });
    // the target's style, from what it wields
    const styles = [['oak_shortbow', 'missiles'], ['staff_of_air', 'magic'], ['rune_scimitar', 'melee']].map(([name, want]) => {
        wear(human, name);
        return [name, lib.pkStyleOf(human), want];
    });
    check("PK tactics: the target's style from its weapon (a bow: missiles, a staff: magic, else melee)", styles.every(([, got, want]) => got === want), styles.map(([n, g]) => `${n}: ${g}`).join(', '));
    // prayers: on with the game's buttons (Protect Item, then the protection against the target's style), switched, off
    const varp = name => a.getVar(lib.VarPlayerType.getByName(name).id);
    a.setLevel(PlayerStat.PRAYER, 70);
    const press = fn => {
        let pressed = 0;
        for (let i = 0; i < 8 && fn(); i++) {
            pressed++;
            tickOnce();
        }
        return pressed;
    };
    press(() => lib.pkPrayersOff(a)); // (from its fights before)
    wear(human, 'rune_scimitar');
    const on = press(() => lib.pkPrayers(a, human));
    const melee = [varp('prayer8'), varp('prayer14')];
    wear(human, 'oak_shortbow');
    press(() => lib.pkPrayers(a, human));
    const missiles = [varp('prayer8'), varp('prayer13'), varp('prayer14')];
    press(() => lib.pkPrayersOff(a));
    const off = ['prayer8', 'prayer12', 'prayer13', 'prayer14'].map(varp);
    check('PK tactics: prayers through the prayer tab: Protect Item and Protect from Melee for a melee target, Missiles for a bow (Melee off), all off after', on === 2 && melee.every(v => v === 1) && missiles.join() === '1,1,0' && off.every(v => v === 0), `pressed ${on}; melee ${melee}; missiles ${missiles}; off ${off}`);
    // an Edgeville PKer's honour (EdgevillePKerTask): Protect Item, no protection prayer
    // (one on from before goes off), against a sword, a bow or a staff alike
    wear(human, 'rune_scimitar');
    const honourOn = press(() => lib.pkPrayers(a, human, { honour: true }));
    const honourMelee = ['prayer8', 'prayer12', 'prayer13', 'prayer14'].map(varp);
    press(() => lib.pkPrayers(a, human));
    const meleeBefore = varp('prayer14');
    press(() => lib.pkPrayers(a, human, { honour: true }));
    const meleeAfter = varp('prayer14');
    wear(human, 'oak_shortbow');
    press(() => lib.pkPrayers(a, human));
    const missilesBefore = varp('prayer13');
    press(() => lib.pkPrayers(a, human, { honour: true }));
    const honourBow = ['prayer8', 'prayer12', 'prayer13', 'prayer14'].map(varp);
    wear(human, 'staff_of_air');
    press(() => lib.pkPrayers(a, human, { honour: true }));
    const honourStaff = ['prayer8', 'prayer12', 'prayer13', 'prayer14'].map(varp);
    press(() => lib.pkPrayersOff(a));
    check('PK tactics: with honour (Edgeville) Protect Item but no protection prayer against a sword, a bow or a staff; one on before goes off', honourOn === 1 && honourMelee.join() === '1,0,0,0' && meleeBefore === 1 && meleeAfter === 0 && missilesBefore === 1 && honourBow.join() === '1,0,0,0' && honourStaff.join() === '1,0,0,0', `pressed ${honourOn}; melee target ${honourMelee}; melee on before ${meleeBefore}, after ${meleeAfter}; missiles on before ${missilesBefore}; bow ${honourBow}; staff ${honourStaff}`);
    // the kill (the escape when beaten is port/BotPkFight's: test/pkfight.test.mjs)
    const tactics = lib.newPkTactics();
    human.levels[PlayerStat.HITPOINTS] = 0;
    const killed = lib.pkEngageTactics(a, human, tactics);
    human.levels[PlayerStat.HITPOINTS] = human.baseLevels[PlayerStat.HITPOINTS];
    const alive = lib.pkEngageTactics(a, human, lib.newPkTactics());
    check('PK tactics: a kill ends the fight; a live target fights on', killed === 'killed' && alive === null, `${killed}, ${alive}`);
    // the call-out: with honour (Edgeville), a target with a protection prayer on (Melee
    // here, then Missiles) hears "no honour" and the like, once a fight (7 in 10: the roll taken here); without honour
    // (deep PKers), nothing
    {
        const heard = [];
        const listen = (p, text, kind) => { if (p === a && kind === 'pk') heard.push(text); };
        lib.sayListeners.push(listen);
        const melee = lib.VarPlayerType.getByName('prayer14').id;
        a.setLevel(PlayerStat.PRAYER, 1); // (no prayers of its own: none pressed, so no attack clicked again)
        wear(human, 'rune_scimitar');
        human.setVar(melee, 1);
        const roll = Math.random;
        Math.random = () => 0;
        const engage = (code, ticks) => {
            const t = lib.newPkTactics();
            for (let i = 0; i < ticks; i++) {
                lib.pkEngageTactics(a, human, t, code);
                tickOnce();
            }
        };
        engage({}, 20);
        const deep = heard.length;
        engage({ honour: true }, 40);
        const edge = [...heard];
        const missiles = lib.VarPlayerType.getByName('prayer13').id;
        human.setVar(melee, 0);
        human.setVar(missiles, 1);
        engage({ honour: true }, 40);
        const edgeMissiles = heard.slice(edge.length);
        Math.random = roll;
        human.setVar(missiles, 0);
        lib.sayListeners.splice(lib.sayListeners.indexOf(listen), 1);
        check('PK tactics: an Edgeville PKer calls out a target praying Melee or Missiles ("no honour"), once a fight; a deep PKer does not', deep === 0 && edge.length === 1 && lib.PK_LINES.honour.includes(edge[0]) && edgeMissiles.length === 1 && lib.PK_LINES.honour.includes(edgeMissiles[0]), `deep ${deep}; edge melee ${edge.join(' | ')}; edge missiles ${edgeMissiles.join(' | ')}`);
    }
    sim.teleportHuman(3222, 3218, 0);
}

check('errors: none (bot errors, console errors)', BotManager.stats().errors === 0 && consoleErrors.length === 0, `${BotManager.stats().errors} bot errors, ${consoleErrors.length} console errors ${consoleErrors.slice(0, 2).join(' | ')}`);

out(`pk: ${N} PK bots on a free world, ${TICKS} ticks, seed ${args.seed ?? 1}`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
