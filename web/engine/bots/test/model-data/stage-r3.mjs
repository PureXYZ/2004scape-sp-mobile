#!/usr/bin/env node
// The r3 retrain's staged situations (the bots ideas work, round 5: theme I stage 2).
// The natural capture (sample.mjs --set=r3: humanlike --model-capture) hears few reactions to the human and
// little of the bots' own talk near it (a 250-bot hour at a hub: about 15 reactions and 10 bot-to-bot lines; round 4
// measured about 10 bot-to-bot lines an hour at a 500-bot hub), so this world stages more of each where the bots already
// are, in the real 274 world as the game runs it (an aged store, the living world's sessions, every theme on), and
// captures them as humanlike does (port/BotModelAmbient's listeners: the situation each line's prompt is rendered from,
// the rules' line, the event):
//   - before each event the human goes to a crowd (a bot with 2 or more others within 8 tiles, on the surface, outside the
//     Wilderness; a bank's for gear, Edgeville's ditch and Wilderness for those), 2-4 tiles off, with a plain kit and
//     levels drawn for it (the prompts' variety: what the bots see of it);
//   - then one event, the kinds in turn: a thread between two bots of the crowd (port/BotThreads.startThread, or drawn and
//     begun when the place's own pace refuses: its turns after the opener), a bot's question to the crowd (one of the bots'
//     own question lines, said, then port/BotChat.onBotLine: another bot's answer), and the reactions: a level-up (gz; a
//     milestone at a level of ten or 99), a wave, a follow (20 s), standing next to a still bot (30 s), its death (near the
//     crowd; by a PKer in Edgeville's Wilderness, 274's hero points), a kill (a monster of level 25+ with bots by it), a
//     dance or another emote, over the ditch (or into the Wilderness), notable gear at a bank, its high level passing;
//   - the reactions' chances forced for the event's window (setReactionRatesForTest, setWitnessRatesForTest: their dice
//     drawn as in the game) and the human's own gaps forgotten (each kind still waits its turn: 15 kinds in turn).
// Nothing here writes a line: every line captured is the rules' own, said by a bot of the world. The staging's choices are
// on dice of their own (--seed); the world's are seeded too (Math.random), so a run repeats.
// Out: JSON lines as humanlike's capture ({t, kind, react, topic, turn, hint, ruleText, event, situation} with the world's seed,
// members, xpRate, bots) and `staged` (the event staged when the line came). A heavy process (an engine world): run it
// under the shared lock, one at a time.
//
//   node --expose-gc web/engine/bots/test/model-data/stage-r3.mjs --out=FILE [--bots=250] [--members=true] [--xprate=10]
//        [--seed=71] [--warm=1500] [--events=150] [--only=thread,botanswer,gz,...]
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, importTs } from '../lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from '../lib/clone.mjs';
import { mulberry } from '../lib/dice.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
if (!args.out || args.out === 'true') {
    console.error('stage-r3: --out=FILE is needed');
    process.exit(2);
}
const OUT = path.resolve(args.out);
const N = Number(args.bots ?? 250);
const MEMBERS = (args.members ?? 'true') !== 'false';
const XPRATE = Number(args.xprate ?? 10);
const SEED = Number(args.seed ?? 71);
const WARM = Number(args.warm ?? 1500);
const EVENTS = Number(args.events ?? 150);
/** the events in turn (threads and questions more often: a thread gives 1-3 turns a model words, a reaction one or two) */
const ORDER = ['thread', 'gz', 'botanswer', 'wave', 'followed', 'thread', 'died', 'kill', 'dance', 'botanswer', 'milestone', 'nextto', 'thread', 'wildy', 'gear', 'pked', 'emote', 'level'];
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const KINDS = ORDER.filter(k => !ONLY || ONLY.has(k));

const errors = [];
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
const say = (...a) => process.stdout.write(`${a.join(' ')}\n`);
console.error = (...a) => {
    const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
    if (!text.includes('ExperimentalWarning') && !text.includes('--trace-warnings')) errors.push(text.slice(0, 400));
};
Math.random = mulberry(SEED * 7919 + 13);
const dice = mulberry(SEED);
const pick = list => list[Math.floor(dice() * list.length)];
const between = (lo, hi) => lo + Math.floor(dice() * (hi - lo + 1));

const engineDir = prepareEngineClone(`stage-r3-${MEMBERS ? 'p2p' : 'f2p'}`, simWorldConfig({ members: MEMBERS, xpRate: XPRATE }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/modelstage.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, BotChat, Ambient: A, Threads: T, wildernessLevelAt } = lib;

const saves = new Map();
const quit = new Set();
const sim = await lib.Sim.create({
    bots: N,
    members: MEMBERS,
    debug: false,
    ageNewBots: true,
    saves,
    ackLogouts: true,
    outings: true,
    lives: true,
    word: true,
    period: true,
    movement: true,
    extra: { timing: {}, savedNames: () => [...saves.keys()], isQuit: n => quit.has(n), onQuit: n => (saves.delete(n), quit.add(n)) }
});
sim.addHuman(3222, 3218, 0);
const human = sim.human;
const tick = (n = 1) => {
    for (let i = 0; i < n; i++) sim.tick();
};

// ---- the capture (humanlike's, with the event staged) ----
const rows = [];
let staged = 'warm';
A.setAmbientReactionsForTest(true);
A.ambientListeners.push((req, situation) => {
    rows.push({ t: World.currentTick, kind: req.kind, react: req.react ?? null, topic: req.topic ?? null, turn: req.turn ?? null, hint: req.hint, ruleText: req.ruleText, event: req.event ?? null, staged, situation });
});

// ---- the human's kit and levels (what the bots see of it) ----
const OBJ = new Map();
for (let id = 0; id < lib.ObjType.count; id++) {
    const t = lib.ObjType.get(id);
    if (!t?.name || t.wearpos < 0 || t.certtemplate !== -1 || (!MEMBERS && t.members)) continue;
    const key = t.name.toLowerCase();
    if (!OBJ.has(key)) OBJ.set(key, id);
}
const ids = names => names.map(n => OBJ.get(n.toLowerCase())).filter(id => id !== undefined);
const PLAIN = {
    weapon: ['bronze scimitar', 'iron scimitar', 'steel scimitar', 'mithril scimitar', 'adamant scimitar', 'rune scimitar', 'steel longsword', 'mithril longsword', 'adamant longsword', 'rune longsword', 'mithril battleaxe', 'adamant battleaxe', 'rune battleaxe', 'staff of air', 'staff of fire', 'shortbow', 'oak shortbow', 'willow shortbow', 'maple shortbow', 'steel 2h sword', 'adamant 2h sword', 'rune 2h sword', 'iron dagger', 'steel axe', 'rune pickaxe'],
    body: ['leather body', 'hardleather body', 'studded body', 'iron chainbody', 'steel platebody', 'mithril chainbody', 'mithril platebody', 'adamant platebody', 'adamant chainbody', 'black platebody', 'rune chainbody', 'wizard robe', 'priest gown'],
    legs: ['leather chaps', 'studded chaps', 'iron platelegs', 'steel platelegs', 'mithril platelegs', 'adamant platelegs', 'black platelegs', 'rune platelegs', 'iron plateskirt', 'mithril plateskirt'],
    head: ['iron full helm', 'steel full helm', 'mithril full helm', 'adamant full helm', 'black full helm', 'rune med helm', 'adamant med helm', 'leather cowl', 'coif', 'wizard hat'],
    shield: ['wooden shield', 'iron sq shield', 'steel kiteshield', 'mithril kiteshield', 'adamant kiteshield', 'rune kiteshield', 'black kiteshield', 'anti-dragon shield'],
    extra: ['black cape', 'red cape', 'blue cape', 'green cape', 'amulet of strength', 'amulet of power', 'leather boots', 'leather gloves', 'team-5 cape', 'climbing boots']
};
/** notable gear the bots remark on (port/BotReactions GEAR, port/BotWitness notableGearOf), sets as worn */
const NOTABLE = [
    ['blue partyhat'], ['red partyhat'], ['yellow partyhat'], ['green partyhat'], ['purple partyhat'], ['white partyhat'], ['santa hat'], ['green halloween mask'], ['red halloween mask'], ['blue halloween mask'], ['bunny ears'], ['scythe'],
    ['dragon med helm'], ['dragon longsword'], ['dragon battleaxe'], ['dragon dagger'], ['dragon mace'],
    ['rune full helm', 'rune platebody', 'rune platelegs', 'rune kiteshield'], ['rune platebody'], ['rune full helm (t)', 'rune platebody (t)', 'rune platelegs (t)', 'rune kiteshield (t)'], ['rune full helm (g)', 'rune platebody (g)', 'rune platelegs (g)'], ['adam platebody (t)'], ['zamorak platebody', 'zamorak full helm'], ['saradomin plate', 'saradomin full'], ['guthix platebody'],
    ['amulet of glory'], ['mime mask', 'mime top', 'mime legs'], ['berserker helm'], ['warrior helm'], ['archer helm'], ['farseer helm'], ['holy symbol'], ['cape of legends']
].filter(set => ids(set).length === set.length);
function dress(notable = null) {
    const worn = human.getInventory(lib.InvType.WORN);
    if (worn) for (let slot = 0; slot < worn.capacity; slot++) worn.delete(slot);
    const kit = Object.values(PLAIN).map(list => (dice() < 0.75 ? pick(list) : null)).filter(Boolean);
    lib.wearItems(human, ids(kit));
    if (notable) lib.wearItems(human, ids(notable));
    human.buildAppearance(lib.InvType.WORN);
}
/** the human's levels: a combat profile (`top`: its melee levels about there) and skills of its own */
function levels(top = between(10, 80)) {
    for (let stat = 0; stat < 21; stat++) {
        if (stat === 18 || stat === 19) continue;
        const melee = stat <= 3;
        const lvl = melee ? Math.max(1, Math.min(99, top + between(-8, 8))) : dice() < 0.3 ? 1 : Math.max(1, Math.min(99, between(1, Math.max(10, top + 15))));
        human.setLevel(stat, stat === 3 ? Math.max(10, lvl) : lvl);
    }
}

// ---- where the bots are ----
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const bots = () => sim.bots().filter(p => p.slot !== -1 && BotManager.botFor(p) !== null);
const near = (p, d, list = bots()) => list.filter(q => q !== p && q.level === p.level && cheb(p, q) <= d);
/** a bot with 2+ others within 8 tiles (`where`: its tile's test) */
function crowd(where = (x, z, level) => level === 0 && wildernessLevelAt(x, z) === 0) {
    const all = bots();
    const found = all.filter(p => where(p.x, p.z, p.level) && near(p, 8, all).length >= 2);
    return found.length ? pick(found) : null;
}
/** the human 2-4 tiles from `p` (a free tile), then a few ticks for the bots to see it */
function goTo(p, lo = 2, hi = 4) {
    for (let tries = 0; tries < 30; tries++) {
        const x = p.x + between(-hi, hi);
        const z = p.z + between(-hi, hi);
        const d = Math.max(Math.abs(x - p.x), Math.abs(z - p.z));
        if (d < lo || d > hi || !sim.isWalkable(x, z, p.level)) continue;
        sim.teleportHuman(x, z, p.level);
        tick(3);
        return true;
    }
    return false;
}
function restoreHuman() {
    human.levels[3] = human.baseLevels[3];
    human.heroPoints.clear();
    human.clearInteraction?.();
}
const BANKS = [[3185, 3438], [3253, 3421], [2946, 3368], [3013, 3356], [3093, 3244], [3094, 3492], [3270, 3167], ...(MEMBERS ? [[2809, 3441], [2725, 3492], [2655, 3283], [2615, 3332], [2612, 3094]] : [])];
/** the bots' own questions to the crowd (none naming a player: one to the human is no bot's question to the bots) */
const QUESTIONS = lib.ALL_LINES.filter(l => l.tag?.c === 'question' && !l.named);
const EMOTES = ['emote_cheer', 'emote_laugh', 'emote_clap', 'emote_bow', 'emote_cry', 'emote_angry', 'emote_think', 'emote_beckon'].map(n => lib.SeqType.getId(n)).filter(id => id !== -1);
const SKILLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20];

// ---- the events ----
/** each staged kind: the human placed and the event done; false when it found no place for it */
const STAGE = {
    thread() {
        for (let tries = 0; tries < 4; tries++) {
            const a = crowd();
            if (!a) return false;
            const b = pick(near(a, 6));
            if (!b || !goTo(a, 3, 6)) continue;
            T.resetThreadsForTest();
            let ok = T.startThread(a, 'stage', b);
            if (!ok) {
                const lines = T.drawThread(a, b, between(3, 6));
                if (lines) {
                    T.begin(a, b, lines, World.currentTick, true);
                    ok = true;
                }
            }
            if (!ok) continue;
            for (let t = 0; t < 200 && (T.inThread(a) || T.inThread(b)); t++) tick();
            tick(6);
            return true;
        }
        return false;
    },
    botanswer() {
        const asker = crowd();
        if (!asker || !goTo(asker)) return false;
        const picked = lib.pickLine(lib.contextOf(asker), 'idle', Math.random, QUESTIONS);
        if (!picked) return false;
        const text = lib.styleLine(picked.text, lib.botPersona(asker)).line;
        lib.sayTyped(asker, text, {
            to: null,
            kind: 'idle',
            then: () => {
                // (its answer's chance forced, once: the dice drawn as in the game)
                const roll = lib.chatDice.roll;
                let once = true;
                lib.chatDice.roll = () => (once ? ((once = false), roll(), 0.01) : roll());
                try {
                    BotChat.onBotLine(asker, text, 'idle');
                } finally {
                    lib.chatDice.roll = roll;
                }
            }
        });
        tick(45);
        return true;
    },
    gz: () => levelUp(false),
    milestone: () => levelUp(true),
    wave() {
        const p = crowd();
        if (!p || !goTo(p)) return false;
        lib.setReactionRatesForTest({ wave: 1, hello: 1 });
        human.playAnimation(lib.SeqType.getId('emote_wave'), 0);
        tick(25);
        return true;
    },
    followed() {
        const p = crowd();
        if (!p || !goTo(p, 1, 3)) return false;
        lib.setReactionRatesForTest({ followed: 1 });
        human.setInteraction(lib.Interaction.ENGINE, p, lib.ServerTriggerType.APPLAYER3);
        tick(60);
        human.clearInteraction();
        return true;
    },
    nextto() {
        const all = bots();
        const still = all.filter(p => p.level === 0 && wildernessLevelAt(p.x, p.z) === 0 && !p.hasWaypoints() && near(p, 8, all).length >= 1);
        if (!still.length) return false;
        const p = pick(still);
        if (!goTo(p, 1, 2)) return false;
        lib.setReactionRatesForTest({ nextTo: 1 });
        tick(80);
        return true;
    },
    died() {
        const p = crowd();
        if (!p || !goTo(p, 1, 4)) return false;
        lib.setWitnessRatesForTest({ human: 1 });
        human.levels[3] = 0;
        tick(1);
        restoreHuman();
        tick(25);
        return true;
    },
    pked() {
        const all = bots();
        const wild = all.filter(p => p.level === 0 && wildernessLevelAt(p.x, p.z) >= 1 && wildernessLevelAt(p.x, p.z) <= 10);
        if (!wild.length) return false;
        const p = pick(wild);
        if (!goTo(p, 1, 4)) return false;
        const pkers = near(human, 10, all).filter(q => /pker/.test(String(q.botPlanner)));
        const killer = pkers.length ? pick(pkers) : p;
        lib.setWitnessRatesForTest({ human: 1 });
        human.heroPoints.addHero(killer.hash64, between(10, 40));
        human.levels[3] = 0;
        tick(1);
        restoreHuman();
        tick(25);
        return true;
    },
    kill() {
        const all = bots();
        const npcs = [];
        for (const npc of World.npcs) {
            if (!npc || npc.level !== 0 || (lib.NpcType.get(npc.type)?.vislevel ?? 0) < 25 || npc.levels[lib.NpcStat.HITPOINTS] <= 0) continue;
            if (all.some(q => q.level === 0 && cheb(q, npc) <= 8)) npcs.push(npc);
        }
        if (!npcs.length) return false;
        const npc = pick(npcs);
        if (!goTo(npc, 1, 2)) return false;
        // (a melee weapon: a bow with no arrows is a script error of 274's ranged attack)
        lib.wearItems(human, ids([pick(PLAIN.weapon.filter(w => /scimitar|longsword|battleaxe|2h sword|dagger/.test(w)))]));
        lib.setWitnessRatesForTest({ human: 1 });
        human.setInteraction(lib.Interaction.ENGINE, npc, lib.ServerTriggerType.APNPC2);
        tick(1);
        npc.heroPoints.addHero(human.hash64, between(20, 60));
        const hp = npc.levels[lib.NpcStat.HITPOINTS];
        npc.levels[lib.NpcStat.HITPOINTS] = 0;
        tick(2);
        npc.levels[lib.NpcStat.HITPOINTS] = Math.max(1, npc.baseLevels?.[lib.NpcStat.HITPOINTS] ?? hp);
        npc.heroPoints.clear();
        human.clearInteraction();
        restoreHuman();
        tick(25);
        return true;
    },
    dance() {
        const p = crowd();
        if (!p || !goTo(p)) return false;
        lib.setWitnessRatesForTest({ human: 1 });
        human.playAnimation(lib.SeqType.getId('emote_dance'), 0);
        tick(25);
        return true;
    },
    emote() {
        const p = crowd();
        if (!p || !goTo(p) || !EMOTES.length) return false;
        lib.setWitnessRatesForTest({ human: 1 });
        human.playAnimation(pick(EMOTES), 0);
        tick(25);
        return true;
    },
    wildy() {
        const all = bots();
        // (south of the ditch, or in the Wilderness's first levels: bots within 15 of the human's step over it)
        const edge = all.filter(p => p.level === 0 && p.x >= 2950 && p.x <= 3390 && p.z >= 3505 && p.z <= 3530);
        if (!edge.length) return false;
        const p = pick(edge);
        const x = p.x + between(-3, 3);
        if (!sim.isWalkable(x, 3518, 0) || !sim.isWalkable(x, 3523, 0)) return false;
        sim.teleportHuman(x, 3518, 0);
        tick(3);
        lib.setWitnessRatesForTest({ human: 1 });
        sim.teleportHuman(x, 3523, 0);
        tick(25);
        sim.teleportHuman(x, 3518, 0);
        tick(2);
        return true;
    },
    gear() {
        const all = bots();
        const banks = BANKS.filter(([bx, bz]) => all.filter(q => q.level === 0 && Math.max(Math.abs(q.x - bx), Math.abs(q.z - bz)) <= 8).length >= 2);
        if (!banks.length || !NOTABLE.length) return false;
        const [bx, bz] = pick(banks);
        const p = pick(all.filter(q => q.level === 0 && Math.max(Math.abs(q.x - bx), Math.abs(q.z - bz)) <= 8));
        dress(pick(NOTABLE));
        if (!goTo(p, 1, 3)) return false;
        lib.setReactionRatesForTest({ gear: 1 });
        lib.setWitnessRatesForTest({ gear: 1 });
        tick(110);
        return true;
    },
    level() {
        const p = crowd();
        if (!p) return false;
        levels(between(78, 99));
        if (!goTo(p, 2, 5)) return false;
        lib.setWitnessRatesForTest({ level: 1 });
        tick(110);
        return true;
    }
};
function levelUp(milestone) {
    const p = crowd();
    if (!p || !goTo(p)) return false;
    const stat = pick(SKILLS);
    let to;
    if (milestone) to = dice() < 0.1 ? 99 : pick([10, 20, 30, 40, 40, 50, 50, 60, 60, 70, 70, 80, 90]);
    else do to = between(3, 98); while (to % 10 === 0);
    human.setLevel(stat, to - 1);
    tick(2);
    lib.setReactionRatesForTest({ gz: 1 });
    human.setLevel(stat, to);
    tick(30);
    return true;
}

// ---- the run ----
const t0 = performance.now();
while (bots().length < N && World.currentTick < N) tick();
tick(WARM);
say(`stage-r3: ${bots().length} bots, warmed ${WARM} ticks (${Math.round((performance.now() - t0) / 1000)} s); ${NOTABLE.length} notable sets, ${QUESTIONS.length} question lines`);
const done = {};
for (let e = 0; e < EVENTS; e++) {
    const kind = KINDS[e % KINDS.length];
    staged = kind;
    lib.forgetReactionsForTest(human);
    lib.forgetWitnessForTest(human);
    dress();
    levels();
    const before = rows.length;
    let ok = false;
    try {
        ok = STAGE[kind]();
    } catch (err) {
        errors.push(`${kind}: ${err?.stack ?? err}`.slice(0, 400));
    }
    lib.setReactionRatesForTest(null);
    lib.setWitnessRatesForTest(null);
    restoreHuman();
    done[kind] ??= { tried: 0, staged: 0, rows: 0 };
    done[kind].tried++;
    if (ok) done[kind].staged++;
    done[kind].rows += rows.length - before;
    staged = 'between';
    tick(between(10, 30));
    if ((e + 1) % 25 === 0) say(`  ${e + 1}/${EVENTS} events, ${rows.length} lines, tick ${World.currentTick} (${Math.round((performance.now() - t0) / 1000)} s)`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, rows.map(r => JSON.stringify({ seed: SEED, members: MEMBERS, xpRate: XPRATE, bots: N, staging: true, ...r })).join('\n') + (rows.length ? '\n' : ''));
const byKind = {};
for (const r of rows) {
    const k = r.kind === 'reaction' ? `reaction/${r.react}` : r.kind;
    byKind[k] = (byKind[k] ?? 0) + 1;
}
say(`stage-r3: ${rows.length} lines -> ${OUT}`);
say(`  by kind: ${Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
say(`  events: ${Object.entries(done).map(([k, d]) => `${k} ${d.staged}/${d.tried} (${d.rows})`).join(', ')}`);
say(`  errors ${errors.length + lib.botErrorCount()}${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}; ${Math.round((performance.now() - t0) / 1000)} s`);
process.exit(0);
