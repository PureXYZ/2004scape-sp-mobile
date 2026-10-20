#!/usr/bin/env node
// Every content name the bot library uses resolves in the rev-274 data (Server/engine/data/pack, the packs the iOS
// build ships). Names drifted between 254 and 274 (agility obstacles, flax, the spinning wheel, ranges, fletching
// dialogs, a param id…) and a missing name never errors: the task just wanders forever. So:
//   1. every call that looks a name up (findLocByName, findNpcByPrefix, Component.getId, setVarp, …) is found in
//      the source (TypeScript AST); a literal argument is checked directly, a computed one must be declared below
//      with the data it comes from (a new computed lookup fails until it is declared);
//   2. the data tables (SkillProgression extras, AgilityCourses, ShopTripTask's NPCs, Items) are checked;
//   3. the quest varps every bot gets match varp.pack and the completion test in quests.rs2.
//
//   node web/engine/bots/test/content-names.test.mjs
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, CONTENT_DIR, typescript } from './lib/paths.mjs';
import { importInEngine } from './lib/clone.mjs';
import { reachableBotModules } from './lib/graph.mjs';

const ts = await typescript();
const lib = await importInEngine(path.join(BOTS_DIR, 'test/lib/content.ts'), 'unit');
lib.load('data/pack');
const configs = lib.configs();

// ---- what a name must resolve to ----
const failures = [];
const checked = new Map(); // `${kind}:${mode}:${name}` -> sites
function check(kind, mode, name, site) {
    const key = `${kind}:${mode}:${name}`;
    if (!checked.has(key)) checked.set(key, []);
    checked.get(key).push(site);
}
function resolves(kind, mode, name) {
    const c = configs[kind];
    switch (mode) {
        case 'exact':
            return c.getId(name) !== -1;
        case 'prefix':
            return name === '' || c.names.some(n => n.startsWith(name));
        case 'suffix':
            return c.names.some(n => n.endsWith(name));
        case 'exactOrPrefix': // npcMatchesName, ThievingTask: exact debugname, else a prefix
            return c.getId(name) !== -1 || c.names.some(n => n.startsWith(name));
    }
    throw new Error(mode);
}

// ---- 1. lookups in the source ----
const CALLS = {
    findLocByName: [3, 'loc', 'exact'],
    findLocByNameWhere: [3, 'loc', 'exact'],
    findNpcByName: [3, 'npc', 'exact'],
    findNpcByNameExcluding: [3, 'npc', 'exact'],
    findObjByName: [4, 'obj', 'exact'],
    findLocByPrefix: [3, 'loc', 'prefix'],
    findLocByPrefixWhere: [3, 'loc', 'prefix'],
    findNpcByPrefix: [3, 'npc', 'prefix'],
    findNpcBySuffix: [3, 'npc', 'suffix'],
    findObjByPrefix: [4, 'obj', 'prefix'],
    npcMatchesName: [1, 'npc', 'exactOrPrefix'],
    interactIfButtonByName: [1, 'com', 'exact'],
    // (realism phase 5b: port/BotScreens' helpers, an interface and an inventory by name: the interface's checked here; when
    // a track first reaches port/BotScreens, its own lookups need DYNAMIC entries built from these call sites:
    // 'port/BotScreens.ts:Component.getId(comName)' and 'port/BotScreens.ts:InvType.getId(invName)', the 2nd and 3rd
    // arguments of pressInvButtonExact and pressInvButtonAll in every reachable file)
    pressInvButtonExact: [1, 'com', 'exact'],
    pressInvButtonAll: [1, 'com', 'exact'],
    setVarp: [1, 'varp', 'exact'],
    'LocType.getId': [0, 'loc', 'exact'],
    'NpcType.getId': [0, 'npc', 'exact'],
    'ObjType.getId': [0, 'obj', 'exact'],
    'Component.getId': [0, 'com', 'exact'],
    'ParamType.getId': [0, 'param', 'exact'],
    'SeqType.getId': [0, 'seq', 'exact'],
    'SpotanimType.getId': [0, 'spotanim', 'exact'],
    'InvType.getId': [0, 'inv', 'exact'],
    'CategoryType.getId': [0, 'category', 'exact'],
    'VarPlayerType.getId': [0, 'varp', 'exact'],
    'VarPlayerType.getByName': [0, 'varp', 'exact']
};

// the modules the runtime can reach (unused upstream files are not in the bundle)
const sources = new Map([...(await reachableBotModules())].map(([file, { sf }]) => [file, sf]));

/** The string values an expression can have, if they are all literals (else null). */
function literals(node, sf) {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return literals(node.expression, sf);
    if (ts.isConditionalExpression(node)) {
        const a = literals(node.whenTrue, sf);
        const b = literals(node.whenFalse, sf);
        return a && b ? [...a, ...b] : null;
    }
    if (ts.isIdentifier(node)) {
        // a const in the same file with a literal initializer
        let found = null;
        (function visit(n) {
            if (found) return;
            if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === node.text && n.initializer && (n.parent.flags & ts.NodeFlags.Const)) {
                found = literals(n.initializer, sf);
            }
            ts.forEachChild(n, visit);
        })(sf);
        return found;
    }
    return null;
}

function calleeName(call) {
    const e = call.expression;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) {
        const obj = e.expression;
        return ts.isIdentifier(obj) ? `${obj.text}.${e.name.text}` : e.name.text;
    }
    return null;
}

const dynamicSites = [];
for (const [file, sf] of sources) {
    (function visit(n) {
        if (ts.isCallExpression(n)) {
            const name = calleeName(n);
            const spec = name && CALLS[name];
            if (spec && n.arguments.length > spec[0]) {
                const [index, kind, mode] = spec;
                const arg = n.arguments[index];
                const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
                const values = literals(arg, sf);
                if (values) {
                    for (const v of values) check(kind, mode, v, `${file}:${line}`);
                    if (name === 'setVarp') {
                        // setVarp(player, name, id, value): the id must be that varp's
                        const id = n.arguments[2];
                        if (values.length === 1 && ts.isNumericLiteral(id) && configs.varp.getId(values[0]) !== Number(id.text)) {
                            failures.push(`${file}:${line}: setVarp('${values[0]}', ${id.text}): the 274 id is ${configs.varp.getId(values[0])}`);
                        }
                    }
                } else if (!(file === 'BotAction.ts' && isLibraryWrapper(n))) {
                    dynamicSites.push({ key: `${file}:${name}(${arg.getText(sf)})`, site: `${file}:${line}` });
                }
            }
        }
        ts.forEachChild(n, visit);
    })(sf);
}

/** BotAction's own helpers pass their parameter on (findLocByName → LocType.getId(locName)): checked at their callers. */
function isLibraryWrapper(call) {
    const arg = call.arguments[CALLS[calleeName(call)][0]];
    if (!ts.isIdentifier(arg)) return false;
    for (let p = call.parent; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p)) return p.parameters.some(param => ts.isIdentifier(param.name) && param.name.text === arg.text);
    }
    return false;
}

// computed lookups and the data they come from
function stringsIn(file, predicate) {
    const sf = sources.get(file);
    const out = [];
    (function visit(n) {
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && predicate(n)) out.push(n.text);
        ts.forEachChild(n, visit);
    })(sf);
    return out;
}
function insideMethod(name) {
    return n => {
        for (let p = n.parent; p; p = p.parent) if (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) return p.name?.getText() === name;
        return false;
    };
}
function insideVariable(name) {
    return n => {
        for (let p = n.parent; p; p = p.parent) if (ts.isVariableDeclaration(p)) return p.name.getText() === name;
        return false;
    };
}
function returnedIn(name) {
    const inside = insideMethod(name);
    return n => inside(n) && ts.isReturnStatement(n.parent);
}
function pushedIn(name) {
    const inside = insideMethod(name);
    return n => inside(n) && ts.isCallExpression(n.parent) && n.parent.expression.getText().endsWith('.push');
}
function propertyValue(prop) {
    return n => ts.isPropertyAssignment(n.parent) && n.parent.initializer === n && n.parent.name.getText() === prop;
}
function callArg(callee, index) {
    return n => ts.isCallExpression(n.parent) && n.parent.arguments[index] === n && n.parent.expression.getText().endsWith(callee);
}
/** (realism phase 5a) an element of the array a `for (const <name> of [...])` walks */
function forOfOver(name) {
    return n => ts.isArrayLiteralExpression(n.parent) && ts.isForOfStatement(n.parent.parent) && n.parent.parent.expression === n.parent && n.parent.parent.initializer.getText() === `const ${name}`;
}
/** (realism phase 5a) the property names of a variable's object literal */
function keysOf(file, name) {
    const out = [];
    (function visit(n) {
        if (ts.isVariableDeclaration(n) && n.name.getText() === name && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
            for (const p of n.initializer.properties) if (p.name) out.push(p.name.getText().replace(/^['"]|['"]$/g, ''));
        }
        ts.forEachChild(n, visit);
    })(sources.get(file));
    return out;
}
const steps = Object.entries(lib.SkillProgression).flatMap(([skill, list]) => list.map(step => ({ skill, step })));
const extras = key => steps.flatMap(({ step }) => [step.extra?.[key]].flat().filter(v => typeof v === 'string'));
const agilityNames = Object.values(lib.AgilityCourses).flatMap(list => list.map(o => o.name));

const DYNAMIC = {
    'tasks/AgilityTask.ts:findLocByNameWhere(name)': ['loc', 'exact', () => agilityNames],
    'tasks/AgilityTask.ts:findLocByName(name)': ['loc', 'exact', () => agilityNames],
    'tasks/HerbloreTask.ts:findNpcByName(npcName)': ['npc', 'exact', () => stringsIn('tasks/HerbloreTask.ts', callArg('_runShopPhase', 2))],
    'tasks/HerbloreTask.ts:findNpcByPrefix(npcName)': ['npc', 'prefix', () => stringsIn('tasks/HerbloreTask.ts', callArg('_runShopPhase', 2))],
    'tasks/ThievingTask.ts:findNpcByName(npcName)': ['npc', 'exactOrPrefix', () => ['man', ...extras('npcName'), ...extras('npcType')]],
    'tasks/ThievingTask.ts:findNpcByPrefix(npcName)': ['npc', 'exactOrPrefix', () => ['man', ...extras('npcName'), ...extras('npcType')]],
    // (realism phase 3: a mark no other thief works, of the step's kind: its type, else a debugname it starts)
    'tasks/ThievingTask.ts:NpcType.getId(npcName)': ['npc', 'exactOrPrefix', () => ['man', ...extras('npcName'), ...extras('npcType')]],
    'tasks/ThievingTask.ts:findLocByName(locName)': ['loc', 'exactOrPrefix', () => extras('locName')],
    'tasks/ThievingTask.ts:findLocByPrefix(locName)': ['loc', 'exactOrPrefix', () => extras('locName')],
    'tasks/FletchingTask.ts:interactIfButtonByName(comName)': ['com', 'exact', () => stringsIn('tasks/FletchingTask.ts', returnedIn('_dialogComponent')).filter(s => s)],
    'tasks/FletchingTask.ts:findLocByPrefixWhere(this._treePrefix())': ['loc', 'prefix', () => stringsIn('tasks/FletchingTask.ts', returnedIn('_treePrefix'))],
    'tasks/WoodcuttingTask.ts:findLocByPrefixWhere(this._treePrefix())': ['loc', 'prefix', () => stringsIn('tasks/WoodcuttingTask.ts', returnedIn('_treePrefix'))],
    // the rocks the Mining level allows (_getAvailableOrePrefixes) and each ore's own rocks (ORE_ROCKS)
    'tasks/MiningTask.ts:findLocByPrefixWhere(prefix)': ['loc', 'prefix', () => [
        ...stringsIn('tasks/MiningTask.ts', pushedIn('_getAvailableOrePrefixes')),
        ...stringsIn('tasks/MiningTask.ts', n => ts.isPropertyAssignment(n.parent) && n.parent.initializer === n && ts.isVariableDeclaration(n.parent.parent.parent) && n.parent.parent.parent.name.getText() === 'ORE_ROCKS')
    ]],
    'BotManager.ts:setVarp(TUTORIAL_VARP[0])': ['varp', 'exact', () => ['tutorial']],
    'BotManager.ts:setVarp(varp)': ['varp', 'exact', () => lib.BOT_VARPS.map(([name]) => name)],
    'BotManager.ts:VarPlayerType.getByName(HORROR_VARP[0])': ['varp', 'exact', () => ['deephorror']],
    'port/BotContent.ts:LocType.getId(name)': ['loc', 'exact', () => stringsIn('port/BotContent.ts', insideMethod('tollGateIds'))],
    'tasks/CombatTask.ts:npcMatchesName(name)': ['npc', 'exactOrPrefix', () => [...extras('npcType'), ...extras('npcTypes'), ...extras('npcName')]],
    // weak foes (fitToFight): the combat steps' monsters by their exact names (a prefix gives -1: not weak)
    'tasks/CombatTask.ts:NpcType.getId(name)': ['npc', 'exactOrPrefix', () => [...extras('npcType'), ...extras('npcTypes')]],
    'tasks/RangedMagicTask.ts:npcMatchesName(name)': ['npc', 'exactOrPrefix', () => [...extras('npcType'), ...extras('npcTypes')]],
    // what a bot says it is doing: a combat or pickpocketing step's monsters, by their names in the game
    'port/BotActivity.ts:NpcType.getId(name)': ['npc', 'exactOrPrefix', () => [...extras('npcType'), ...extras('npcTypes')]],
    // what a bot's step works on, as its lines name it ("cow", "al kharid warrior"): the same monsters
    'port/BotLines.ts:NpcType.getId(n)': ['npc', 'exactOrPrefix', () => [...extras('npcType'), ...extras('npcTypes')]],
    // the emote buttons of the controls tab
    'port/BotEmote.ts:interactIfButtonByName(BUTTONS[emote])': ['com', 'exact', () => stringsIn('port/BotEmote.ts', insideVariable('BUTTONS'))],
    // a PKer's prayers: their buttons on the prayer tab, and the varps that show them on
    'port/BotPkTactics.ts:interactIfButtonByName(PRAYERS[key].button)': ['com', 'exact', () => stringsIn('port/BotPkTactics.ts', propertyValue('button'))],
    'port/BotPkTactics.ts:VarPlayerType.getByName(PRAYERS[key].varp)': ['varp', 'exact', () => stringsIn('port/BotPkTactics.ts', propertyValue('varp'))],
    // (PK tactics, 2026-10-19) a PKer's kit, its potions' vials, the glories, its food; the params and varps it reads
    'port/BotPkFight.ts:ObjType.getId(n)': ['obj', 'exact', () => stringsIn('port/BotPkFight.ts', n => insideVariable('NAMES')(n) || insideVariable('VIALS')(n) || insideMethod('glories')(n) || insideMethod('pkFoods')(n))],
    // (round 2) the d'hide tiers of a 1-Attack ranger's body (and their chaps, matched)
    'port/BotPkFight.ts:ObjType.getId(tier.body)': ['obj', 'exact', () => stringsIn('port/BotPkFight.ts', insideVariable('DHIDE'))],
    'port/BotPkFight.ts:ParamType.getId(name)': ['param', 'exact', () => stringsIn('port/BotPkFight.ts', callArg('objParam', 1))],
    'port/BotPkFight.ts:VarPlayerType.getByName(name)': ['varp', 'exact', () => stringsIn('port/BotPkFight.ts', callArg('varp', 1))],
    'tasks/RangedMagicTask.ts:findNpcByName(this.currentShop.npcName)': ['npc', 'exact', () => stringsIn('tasks/RangedMagicTask.ts', propertyValue('npcName'))],
    'tasks/ShopTripTask.ts:findNpcByName(this.npcName)': ['npc', 'exact', () => lib.shopNpcNames()],
    // the leather_crafting buttons of each product, and the tanner's two "tan all" buttons
    'tasks/CraftingTask.ts:interactIfButtonByName(button)': ['com', 'exact', () => [...stringsIn('tasks/CraftingTask.ts', insideMethod('_leatherButton')), ...stringsIn('tasks/CraftingTask.ts', insideMethod('_tannerButton'))]],
    // the altars' names in ALTARS: 'Air' -> air_altar
    'tasks/RunecraftingTask.ts:findLocByName(`${this.currentAltar.name.toLowerCase()}_altar`)': ['loc', 'exact', () => stringsIn('tasks/RunecraftingTask.ts', propertyValue('name')).map(n => `${n.toLowerCase()}_altar`)],
    // the altars' ruins and temple portals in ALTARS (ruinsLoc, portalLoc)
    'tasks/RunecraftingTask.ts:findLocByName(altar.ruinsLoc)': ['loc', 'exact', () => stringsIn('tasks/RunecraftingTask.ts', propertyValue('ruinsLoc'))],
    'tasks/RunecraftingTask.ts:findLocByName(altar.portalLoc)': ['loc', 'exact', () => stringsIn('tasks/RunecraftingTask.ts', propertyValue('portalLoc'))],
    // the scripted crossings' NPCs (SCRIPTED_CROSSINGS: the toll gate's guards, the boat's sailors) and the ships' gangplanks (SHIP_PLANKS)
    'BotAction.ts:findNpcByName(name)': ['npc', 'exact', () => stringsIn('BotAction.ts', n => ts.isArrayLiteralExpression(n.parent) && ts.isPropertyAssignment(n.parent.parent) && n.parent.parent.name.getText() === 'npcs')],
    'BotAction.ts:findLocByName(name)': ['loc', 'exact', () => stringsIn('BotAction.ts', insideVariable('SHIP_PLANKS'))],
    // (realism phase 4, economy) the December 2004 street table's items, by debugname (data/street_prices.json)
    'port/BotPrices.ts:ObjType.getId(debugname)': ['obj', 'exact', () => Object.keys(JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/street_prices.json'), 'utf8')).items)],
    // (realism phase 5a, Track M) the staves that pay an element (274's magic_staff_table), and the teleport spells' buttons
    'port/BotTeleport.ts:ObjType.getId(name)': ['obj', 'exact', () => stringsIn('port/BotTeleport.ts', insideMethod('staves'))],
    'port/BotTeleport.ts:interactIfButtonByName(cast.plan.spell.com)': ['com', 'exact', () => stringsIn('port/BotTeleport.ts', propertyValue('com'))],
    // (realism phase 5a, track E: random events) content()'s objects by name: obj()'s (the lamp, the box, the handles,
    // the triffid's fruit), and its `for (const n of [...])` lists: the tool heads and the tools a big fish takes
    'port/BotRandomEvents.ts:ObjType.getId(n)': ['obj', 'exact', () => [
        ...stringsIn('port/BotRandomEvents.ts', n => insideMethod('content')(n) && callArg('obj', 0)(n)),
        ...stringsIn('port/BotRandomEvents.ts', n => insideMethod('content')(n) && forOfOver('n')(n))
    ]],
    // the old man's gifts (giftOf's [name, gift] pairs)
    'port/BotRandomEvents.ts:ObjType.getId(name)': ['obj', 'exact', () => stringsIn('port/BotRandomEvents.ts', n => insideMethod('giftOf')(n) && ts.isArrayLiteralExpression(n.parent) && n.parent.elements[0] === n && ts.isArrayLiteralExpression(n.parent.parent))],
    // the lamp's skill buttons: one for every skill it knows (STAT_OF's keys)
    'port/RandomEventTask.ts:interactIfButtonByName(`xplamp:${st.lampSkill}`)': ['com', 'exact', () => keysOf('port/RandomEventTask.ts', 'STAT_OF').map(s => `xplamp:${s}`)],
    // the strange box's three answers (pressed is 0-2) and the mime's eight emotes (com_2..com_9, n is 0-7)
    'port/RandomEventTask.ts:interactIfButtonByName(`macro_cube:answer_button${pressed + 1}`)': ['com', 'exact', () => [1, 2, 3].map(i => `macro_cube:answer_button${i}`)],
    'port/RandomEventTask.ts:interactIfButtonByName(`macro_mime_emotes:com_${2 + n}`)': ['com', 'exact', () => Array.from({ length: 8 }, (_, i) => `macro_mime_emotes:com_${2 + i}`)],
    // the interfaces whose root tells that one is open (rootOf's callers)
    'port/RandomEventTask.ts:Component.getId(comName)': ['com', 'exact', () => stringsIn('port/RandomEventTask.ts', callArg('rootOf', 0))],
    // ---- (realism phase 5b, tracks P and A) port/BotScreens' own lookups: the interfaces and inventories its callers name
    // (the 2nd and 3rd arguments of pressInvButtonExact and pressInvButtonAll in every reachable file: the Party Room's
    // chest window, the duel's stake screens: duel_side:inv, duel_select_type:inv) ----
    'port/BotScreens.ts:Component.getId(comName)': ['com', 'exact', () => screensArgs(1)],
    'port/BotScreens.ts:InvType.getId(invName)': ['inv', 'exact', () => screensArgs(2)],
    // (Track A: the Duel Arena) the duel's rule buttons (RULE_BUTTONS, by %dueloptions bit), and its two accepts
    // (acceptWhenRead's button)
    'port/BotDuel.ts:interactIfButtonByName(RULE_BUTTONS[bit])': ['com', 'exact', () => stringsIn('port/BotDuel.ts', insideVariable('RULE_BUTTONS'))],
    'port/BotDuel.ts:interactIfButtonByName(button)': ['com', 'exact', () => stringsIn('port/BotDuel.ts', callArg('acceptWhenRead', 3))],
    // ---- end of phase 5b's block ----
    // ---- (variety round 1, Track D: what and where) the dungeons' ways in and out (BotKnowledge DUNGEON_ENTRIES: each
    // route's `enter` and `exit` locs, their `loc` properties), clicked by port/BotDungeons' leg ----
    'port/BotDungeons.ts:findLocByName(enter[i].loc)': ['loc', 'exact', () => stringsIn('BotKnowledge.ts', propertyValue('loc'))],
    // (variety round 2, the fixes: a dungeon on another floor's way up, BotAction._otherFloorExit: the routes' `exit` locs)
    'BotAction.ts:findLocByName(route.exit.loc)': ['loc', 'exact', () => stringsIn('BotKnowledge.ts', propertyValue('loc'))],
    // ---- end of Track D's (variety) block ----
    // ---- (variety round 1, Track W: what they wear) port/BotOutfits' objects: the outfit's (outfitItems' id(...)), every
    // weapon kind's by metal (WEAPON_NAMES), a veteran's dragon weapon, the axes and pickaxes ----
    'port/BotOutfits.ts:ObjType.getId(name)': ['obj', 'exact', () => [...stringsIn('port/BotOutfits.ts', n => insideMethod('outfitItems')(n) && callArg('id', 0)(n)), ...stringsIn('port/BotOutfits.ts', n => insideVariable('WEAPON_NAMES')(n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n))]],
    'port/BotOutfits.ts:ObjType.getId(pick)': ['obj', 'exact', () => stringsIn('port/BotOutfits.ts', n => insideMethod('dragonWeaponOf')(n) && !callArg('nameSeed', 1)(n))],
    'port/BotOutfits.ts:ObjType.getId(n)': ['obj', 'exact', () => stringsIn('port/BotOutfits.ts', insideMethod('toolLadders'))],
    // ---- end of Track W's (variety) block ----
    // ---- (variety round 2, Track D2: new activities) the errand engine's lookups, their names from the plans (port/BotChains,
    // BotErrands, BotMagicRuns, BotHerbRuns, BotWildTrips) and the rides (port/BotTravel's hops) ----
    'tasks/ErrandTask.ts:ObjType.getId(name)': ['obj', 'exact', () => D2_FILES.flatMap(f => [...stringsIn(f, callArg('obj', 0)), ...stringsIn(f, n => ['PICKAXES', 'AXES', 'BURNT_FISH', 'pickaxes'].some(v => insideVariable(v)(n)) && ts.isArrayLiteralExpression(n.parent)), ...stringsIn(f, n => ts.isArrayLiteralExpression(n.parent) && ts.isCallExpression(n.parent.parent?.parent ?? n) && false)]).concat(stringsIn('port/BotMagicRuns.ts', n => ts.isArrayLiteralExpression(n.parent) && ts.isPropertyAccessExpression(n.parent.parent) && n.parent.parent.name.getText() === 'map'))],
    'tasks/ErrandTask.ts:LocType.getId(name)': ['loc', 'exact', () => [...new Set(D2_FILES.flatMap(f => stringsIn(f, n => ts.isArrayLiteralExpression(n.parent) && (D2_LOC_CALLS.some(([c, i]) => callArg(c, i)(n.parent)) || (ts.isPropertyAssignment(n.parent.parent) && n.parent.parent.name.getText() === 'locs')))))]],
    'tasks/ErrandTask.ts:findNpcByName(npcName)': ['npc', 'exact', () => [...new Set(D2_FILES.flatMap(f => [...stringsIn(f, callArg('talk', 0)), ...stringsIn(f, callArg('shop', 0))]).concat(['generalshopkeeper1', 'generalshopkeeper2', 'generalshopkeeper3', 'generalshopkeeper4', 'generalshopkeeper5', 'generalshopkeeper6'].filter(n => stringsIn('port/BotChains.ts', () => true).includes(n))))]],
    // (2026-10-18) a fighter's junk sale at the general store nearest its spot (port/BotChains GENERAL_STORES)
    'tasks/CombatTask.ts:findNpcByName(keeper)': ['npc', 'exact', () => ['generalshopkeeper1', 'generalshopkeeper2', 'generalshopkeeper3', 'generalshopkeeper4', 'generalshopkeeper5', 'generalshopkeeper6'].filter(n => stringsIn('port/BotChains.ts', () => true).includes(n))],
    'tasks/ErrandTask.ts:findNpcByName(name)': ['npc', 'exact', () => [...new Set(D2_FILES.flatMap(f => stringsIn(f, n => ts.isArrayLiteralExpression(n.parent) && callArg('useOnNpc', 1)(n.parent))))]],
    'tasks/ErrandTask.ts:interactIfButtonByName(button)': ['com', 'exact', () => [...new Set(D2_FILES.flatMap(f => stringsIn(f, callArg('answerMake', 1))))]],
    'tasks/ErrandTask.ts:findNpcBySuffix(suffix)': ['npc', 'suffix', () => [...new Set(D2_FILES.flatMap(f => stringsIn(f, n => ts.isArrayLiteralExpression(n.parent) && ts.isPropertyAssignment(n.parent.parent) && n.parent.parent.name.getText() === 'npcs')))]],
    'port/BotMagicRuns.ts:LocType.getId(name)': ['loc', 'exact', () => stringsIn('port/BotMagicRuns.ts', callArg('locNearIs', 1))],
    'port/BotChains.ts:LocType.getId(name)': ['loc', 'exact', () => stringsIn('port/BotChains.ts', callArg('locNearBot', 1))],
    'port/BotTravel.ts:LocType.getId(name)': ['loc', 'exact', () => stringsIn('port/BotTravel.ts', propertyValue('loc'))],
    'port/BotTravel.ts:findNpcByName(hop.npc)': ['npc', 'exact', () => stringsIn('port/BotTravel.ts', propertyValue('npc'))],
    'port/BotTravel.ts:Component.getId(hop.button)': ['com', 'exact', () => stringsIn('port/BotTravel.ts', propertyValue('button'))],
    'port/BotTravel.ts:interactIfButtonByName(hop.button)': ['com', 'exact', () => stringsIn('port/BotTravel.ts', propertyValue('button'))],
    // ---- end of Track D2's (variety) block ----
    // ---- (variety round 2, Track M: members places and minigames) the Trawler's catch worth taking (KEEP) and the wreck's
    // barrels, the NPCs the talk clues name (port/BotClues TALK_CLUES' npcs), the upstairs flights' ladders (BotUpstairs) ----
    'tasks/TrawlerTask.ts:ObjType.getId(n)': ['obj', 'exact', () => stringsIn('tasks/TrawlerTask.ts', insideVariable('KEEP'))],
    'tasks/TrawlerTask.ts:findLocByNameWhere(name)': ['loc', 'exact', () => stringsIn('tasks/TrawlerTask.ts', forOfOver('name'))],
    'tasks/TreasureTrailTask.ts:findNpcByName(name)': ['npc', 'exact', () => stringsIn('port/BotClues.ts', n => insideVariable('TALK_CLUES')(n) && ts.isArrayLiteralExpression(n.parent) && ts.isPropertyAssignment(n.parent.parent) && n.parent.parent.name.getText() === 'npcs')],
    'port/BotUpstairs.ts:findLocByName(flight.loc)': ['loc', 'exact', () => stringsIn('port/BotUpstairs.ts', propertyValue('loc'))],
    // ---- end of Track M's (variety) block ----
    // ---- (variety round 2, Track W2: fashion) port/BotFashion's objects: the status pieces (STATUS_NAMES), the robes
    // (ROBE_NAMES), the members fashion's, the novelty pieces' and the PK variety's (membersItems, noveltyItems, pkItems), id()'s ----
    'port/BotFashion.ts:ObjType.getId(name)': ['obj', 'exact', () => stringsIn('port/BotFashion.ts', n => insideVariable('STATUS_NAMES')(n) || insideVariable('ROBE_NAMES')(n) || insideMethod('membersItems')(n) || insideMethod('noveltyItems')(n) || insideMethod('pkItems')(n) || callArg('id', 0)(n))]
    // ---- end of Track W2's (variety) block ----
};
/** (variety round 2, Track D2) the plans' files, and the engine's steps that take loc names (callee, argument index) */
const D2_FILES = ['port/BotChains.ts', 'port/BotErrands.ts', 'port/BotMagicRuns.ts', 'port/BotHerbRuns.ts', 'port/BotWildTrips.ts'];
const D2_LOC_CALLS = [['clickLoc', 0], ['useOnLoc', 1], ['climb', 0], ['locAt', 0]];
/** (realism phase 5b, tracks P and A) the literal `index`th arguments of BotScreens' inventory-button helpers in every reachable file */
function screensArgs(index) {
    const out = [];
    for (const [, sf] of sources) {
        (function visit(n) {
            if (ts.isCallExpression(n) && ['pressInvButtonExact', 'pressInvButtonAll'].includes(calleeName(n)) && n.arguments.length > index) out.push(...(literals(n.arguments[index], sf) ?? []));
            ts.forEachChild(n, visit);
        })(sf);
    }
    return [...new Set(out)];
}
for (const { key, site } of dynamicSites) {
    const decl = DYNAMIC[key];
    if (!decl) {
        failures.push(`${site}: a computed content name (${key}) that this test does not know: declare where its values come from in DYNAMIC`);
        continue;
    }
    const [kind, mode, values] = decl;
    const list = values();
    if (list.length === 0) failures.push(`${site}: ${key}: its declared data source is empty`);
    for (const v of list) check(kind, mode, v, `${site} (${key})`);
}
for (const key of Object.keys(DYNAMIC)) {
    if (!dynamicSites.some(d => d.key === key)) failures.push(`DYNAMIC declares ${key}, which the source no longer has`);
}

// ---- 2. data tables ----
for (const v of [...extras('owner'), ...extras('guards')]) check('npc', 'exactOrPrefix', v, 'BotKnowledge.ts THIEVING owner/guards');
for (const v of extras('npcPrefix')) check('npc', 'prefix', v, 'BotKnowledge.ts extra.npcPrefix');
for (const v of extras('npcSuffix')) check('npc', 'suffix', v, 'BotKnowledge.ts extra.npcSuffix');
for (const v of extras('itemsGained')) check('obj', 'exact', v, 'BotKnowledge.ts extra.itemsGained');
for (const { skill, step } of steps) {
    for (const id of [step.itemGained, step.itemConsumed, ...step.toolItemIds].filter(id => id !== undefined && id !== -1)) {
        if (lib.objName(id) === null) failures.push(`SkillProgression.${skill} ${step.action}: obj ${id} does not exist`);
    }
}
// Items: each id must be the object its key names (compared lower case, letters and digits only), or the 274
// debugname listed here. Upstream's table had herring as burnt fish, raw beef as a burnt bread banknote, five maces
// as banknotes, the cut gems one gem off and short and long bows swapped; an id that exists but is the wrong object
// never errors either.
const ITEM_DEBUGNAMES = {
    BALL_WOOL: 'ball_of_wool', SMALL_FISHING_NET: 'net', BIG_FISHING_NET: 'big_net', ARRAV_SHIELD_LEFT: 'arravshield1',
    ARRAV_SHIELD_RIGHT: 'arravshield2', MISC_KEY_HERO: 'misc_key', GOBLIN_MAIL: 'goblin_armour', RUNE_ESSENCE: 'blankrune',
    DRAGON_BODY: 'dragonhide_body', DRAGON_LEATHER_GREEN: 'dragon_leather', DRAGON_BODY_GREEN: 'dragonhide_body',
    DRAGON_BODY_BLUE: 'blue_dragonhide_body', DRAGON_BODY_RED: 'red_dragonhide_body', DRAGON_BODY_BLACK: 'black_dragonhide_body',
    DRAGON_VAMBRACES_GREEN: 'dragon_vambraces', DRAGON_VAMBRACES_BLUE: 'blue_dragon_vambraces',
    DRAGON_VAMBRACES_RED: 'red_dragon_vambraces', DRAGON_VAMBRACES_BLACK: 'black_dragon_vambraces',
    DRAGON_CHAPS_GREEN: 'dragonhide_chaps', DRAGON_CHAPS_BLUE: 'blue_dragonhide_chaps', DRAGON_CHAPS_RED: 'red_dragonhide_chaps',
    DRAGON_CHAPS_BLACK: 'black_dragonhide_chaps',
    GRIMY_GUAM: 'unidentified_guam', GRIMY_MARRENTILL: 'unidentified_marentill', GRIMY_TARROMIN: 'unidentified_tarromin',
    GRIMY_HARRALANDER: 'unidentified_harralander', GRIMY_RANARR: 'unidentified_ranarr', GRIMY_IRIT: 'unidentified_irit',
    GRIMY_AVANTOE: 'unidentified_avantoe', GRIMY_KWUARM: 'unidentified_kwuarm', GRIMY_CADANTINE: 'unidentified_cadantine',
    GRIMY_DWARF_WEED: 'unidentified_dwarf_weed', GRIMY_TORSTOL: 'unidentified_torstol',
    CLEAN_GUAM: 'guam_leaf', CLEAN_MARRENTILL: 'marentill', CLEAN_TARROMIN: 'tarromin', CLEAN_HARRALANDER: 'harralander',
    CLEAN_RANARR: 'ranarr_weed', CLEAN_IRIT: 'irit_leaf', CLEAN_AVANTOE: 'avantoe', CLEAN_KWUARM: 'kwuarm',
    CLEAN_CADANTINE: 'cadantine', CLEAN_DWARF_WEED: 'dwarf_weed', CLEAN_TORSTOL: 'torstol',
    VIAL_OF_WATER: 'vial_water', UNFINISHED_GUAM: 'guamvial', UNFINISHED_MARRENTILL: 'marrentillvial',
    UNFINISHED_TARROMIN: 'tarrominvial', UNFINISHED_HARRALANDER: 'harralandervial', UNFINISHED_RANARR: 'ranarrvial',
    ATTACK_POTION: '4dose1attack', ATTACK_POTION_3: '3dose1attack', ANTIPOISON_POTION_3: '3doseantipoison',
    STRENGTH_POTION_3: '3dose1strength', RESTORE_POTION_3: '3dosestatrestore', PRAYER_POTION_3: '3doseprayerrestore',
    LEATHER_BODY: 'leather_armour', BLACK_WIZARD_HAT: 'blackwizhat', ZAMORAK_ROBE_BOTTOM: 'zamrobebottom',
    ZAMORAK_ROBE_TOP: 'zamrobetop', GREEN_HALLOWEEN_MASK: 'halloweenmask_green', BLUE_HALLOWEEN_MASK: 'halloweenmask_blue',
    RED_HALLOWEEN_MASK: 'halloweenmask_red', SPICE: 'spicespot', POT: 'pot_empty', BUCKET: 'bucket_empty',
    BUCKET_OF_WATER: 'bucket_water', JUG: 'jug_empty', JUG_OF_WATER: 'jug_water'
};
const plain = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
for (const [key, id] of Object.entries(lib.Items)) {
    const name = lib.objName(id);
    const expected = ITEM_DEBUGNAMES[key];
    if (name === null) failures.push(`Items.${key} = ${id}: no such obj`);
    else if (expected ? name !== expected : plain(name) !== plain(key)) failures.push(`Items.${key} = ${id} is '${name}'${expected ? `, expected '${expected}'` : ''}`);
}
for (const key of Object.keys(ITEM_DEBUGNAMES)) {
    if (!(key in lib.Items)) failures.push(`ITEM_DEBUGNAMES lists ${key}, which Items no longer has`);
}

// ---- 3. quest varps (BotManager.BOT_VARPS) against quests.rs2 [proc,count_questpoints] ----
const constants = new Map();
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.constant')) {
            for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
                const m = l.match(/^\^([a-z0-9_]+)\s*=\s*(-?\d+)/);
                if (m) constants.set(m[1], Number(m[2]));
            }
        }
    }
})(path.join(CONTENT_DIR, 'scripts'));
const questsRs2 = fs.readFileSync(path.join(CONTENT_DIR, 'scripts/general/scripts/quests.rs2'), 'utf8');
const countProc = questsRs2.slice(questsRs2.indexOf('[proc,count_questpoints]')).split('\n[')[0];
const completion = new Map();
for (const m of countProc.matchAll(/%([a-z0-9_]+)\s*(=|>=)\s*\^([a-z0-9_]+)/g)) completion.set(m[1], { op: m[2], value: constants.get(m[3]), constant: m[3] });
let questVarps = 0;
for (const [name, id, value] of lib.BOT_VARPS) {
    const realId = configs.varp.getId(name);
    if (realId !== id) failures.push(`BOT_VARPS ${name}: id ${id}, but varp.pack has ${realId}`);
    const done = completion.get(name);
    if (done) {
        questVarps++;
        const ok = done.op === '=' ? value === done.value : value >= done.value;
        if (!ok) failures.push(`BOT_VARPS ${name} = ${value}: quests.rs2 counts it complete at ${done.op} ^${done.constant} (${done.value})`);
    }
}
// every quest 274 counts, except those tracked by bits or a proc (checked by hand in BotManager)
const byHand = new Set(['phoenixgang', 'horrorquest']);
for (const name of completion.keys()) {
    if (!byHand.has(name) && !lib.BOT_VARPS.some(([n]) => n === name)) failures.push(`quests.rs2 counts ${name}, which no bot gets complete`);
}

// ---- resolve ----
let names = 0;
for (const [key, sites] of checked) {
    const [kind, mode, ...rest] = key.split(':');
    const name = rest.join(':');
    names++;
    if (!resolves(kind, mode, name)) failures.push(`${kind} ${mode} '${name}' does not resolve in 274 (${[...new Set(sites)].slice(0, 3).join(', ')})`);
}

console.log(`content names: ${names} distinct names (${[...checked.keys()].filter(k => k.startsWith('loc')).length} loc, ${[...checked.keys()].filter(k => k.startsWith('npc')).length} npc, ${[...checked.keys()].filter(k => k.startsWith('com')).length} interface, ${[...checked.keys()].filter(k => k.startsWith('varp')).length} varp, others), ${dynamicSites.length} computed lookups, ${steps.length} progression steps, ${Object.keys(lib.Items).length} items, ${questVarps} quest varps`);
if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`${failures.length} failure(s)`);
    process.exit(1);
}
console.log('all resolve');
