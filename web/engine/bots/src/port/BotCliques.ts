// port (the realism work, phase 3: population; "bot friend cliques"): groups of 3-6 friends that log
// in, train, travel (the game's Follow) and PK together. 2004's players were 51 % alone, 21 % with a few others and 9 %
// in clans (Jagex's polls); PKers went "in 2s and 3s" (Sal's tips, F23).
//
// Who is in a clique is a pure function of the names (no save format): the roster (data/names.json, append only) is
// read in blocks of consecutive names of a kind (levelling bots, deep-Wilderness PKers, Edgeville PKers), so the pool of
// about 2N, a prefix of the roster plus newcomers taken in order, holds whole cliques. In each block of 18 levelling
// names one clique of 3-6 forms around one name (the lowest of its seed): the names of the block most like it, the same
// home region (port/BotPersona) and an age tier near its own (port/BotAge), a little unlike at most: about a quarter of
// the levelling bots. PKers: a clique of 2-4 in each block of 6 of the same kind. A member that quits leaves its place
// empty until the roster changes; only a whole block forms (names appended later make their own).
//
// What a clique does (tickCliques, from BotManager.tick: every 5 ticks a pass over the bots online, then over each
// clique's members online, at most 6):
//   - log in together: cliqueReturnBonus, a score bonus BotManager._pickReturner adds (the arrivals work calls it);
//   - train together: cliqueStepFor, a clique-mate's step this bot can do at its level (the crowds work's planner asks);
//   - travel together: two or more on the same floor within 15 tiles whose tasks take them the same way (destinations
//     within 20 tiles of each other, 30 or more away): the one nearest its destination leads, the others follow it with
//     the game's Follow (port/BotFollow CliqueFollowTask, a sub-task: the one behind runs to catch up) until it
//     arrives; now and then a word ("follow me");
//   - greet: two that meet in a login, one says the other's first name ("yo kev"), the other answers ("sup");
//   - answer each other first (port/BotChat's responders weigh a clique-mate more) and leave together now and then: a
//     goodbye names a friend near ("cya kev": port/BotChatter.sayOccasion asks cliqueDeparture), the friend answers, and
//     now and then says "ya me too gtg" and logs out within 1-2 minutes (BotManager's callback);
//   - PK together: pkCliqueLeader, the first of a PK clique online, whom the others follow on patrol (tasks/PKerTask,
//     tasks/EdgevillePKerTask: the moves only; the fight rules are theirs, one attacker a target).
//   - (the realism work, phase 5b, Track D) walk as a clan in matching capes: cliqueColourOf, a levelling clique's colour
//     from its names, worn in a new member's kit (port/BotLooks) and on a clan walk (port/BotClanWalk); a PK clique raids
//     the Varrock Wilderness as a team (port/BotPkTeam).
//   - (the variety work, round 2, Track S2: P8, banter) talk while together: two mates within 6 tiles, free, now and then
//     (a heavy-tailed gap of the clique's time together) one says a word to the other ("lol ur so slow kev", "race u to
//     the bank"), the clique's own in-joke now and then (one per clique, from its names' seed: "remember the goblin lol"),
//     or opens a thread of up to 6 turns (port/BotThreads); the other answers a word now and then ("lol shut up"). Each
//     line one of the speaker's own (port/BotChatter.countAsChatter: its talk budget), none over its voice's share of a
//     busy place (port/BotVoice). Talk only: where they go is unchanged (G1).
// Every roll is Math.random (seeded in the sims) or the names' seeds; no wall clock. Per bot and tick nothing; the pass
// every 5 ticks is O(bots online) plus O(members²) per clique.
import WordEnc from '#/cache/wordenc/WordEnc.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { SkillProgression, suitedSteps, VARIETY_LEVEL_WINDOW, type SkillStep } from '#/engine/bot/BotKnowledge.js';
import { ageTierFor, type AgeTier } from '#/engine/bot/port/BotAge.js';
import { BotChat, botPersona, firstNameOf, inFightQuick, isBusy, sayTyped } from '#/engine/bot/port/BotChat.js';
import { countAsChatter, countAsOwnLine } from '#/engine/bot/port/BotChatter.js';
import { CliqueFollowTask } from '#/engine/bot/port/BotFollow.js';
import { habitOf, isAway } from '#/engine/bot/port/BotHabits.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { freshLine, isFresh, noteSaid } from '#/engine/bot/port/BotLines.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import { BOT_NAMES, botNameKey, isLevelling, normalizeBotName, plannerOf, PLANNERS, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { hashString, nameSeed } from '#/engine/bot/port/BotSeed.js';
import { reactionTicks } from '#/engine/bot/port/BotTiming.js';
import socialJson from '../../data/social.json';
import { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
// (the realism work, phase 5b, Track D: a clique's cape colour for new bots' looks)
import { setCliqueColourSource } from '#/engine/bot/port/BotLooks.js';
// (the variety work, round 2, Track S2: P8, banter: threads between mates, a busy place's voices)
import { DEPTH_FRIENDS, inThread, startThread } from '#/engine/bot/port/BotThreads.js';
import { voiceFree } from '#/engine/bot/port/BotVoice.js';
import { logNormal } from '#/engine/bot/port/BotTiming.js';

type Kind = 'levelling' | 'extras_pker' | 'extras_edgeville_pker';
interface Clique {
    id: number;
    kind: Kind;
    /** its names, in the roster's order (the first online of a PK clique leads) */
    names: readonly string[];
}

/** a block of this many names of a kind holds one clique of this size (drawn from the block's names) */
const LEVELLING_BLOCK = 18;
const LEVELLING_SIZE: [number, number] = [3, 6];
const PK_BLOCK = 6;
const PK_SIZE: [number, number] = [2, 4];
/** how unlike the clique's first name a member may be: another home region 2, each age tier apart 1 */
const MOST_UNLIKE = 2;
const TIER_RANK: Readonly<Record<AgeTier, number>> = { newcomer: 0, novice: 1, intermediate: 2, experienced: 3, veteran: 4 };

/** the pass over the cliques online, every this many ticks */
const CLIQUE_EVERY = 5;
/** log in together: the bonus for one clique-mate online, each one more, at most (under one bot of the role mix) */
const RETURN_BONUS = 0.5;
const RETURN_BONUS_STEP = 0.15;
const RETURN_BONUS_MAX = 0.9;
/** travel together: within this of each other to set off (the one behind catches up), destinations within this of
 * each other, at least this far */
const FOLLOW_START = 15;
const SAME_WAY = 20;
const TRIP = 30;
/** after a clique follow ends, not another for this long (ticks) */
const FOLLOW_AGAIN = 300;
/** a word when they set off: the leader's ("follow me") and the follower's ("k") chance */
const LEAD_WORD = 0.2;
const FOLLOW_WORD = 0.12;
/** greet: two of a clique within this of each other, once a login; the greeter's chance (by sociability), the answer's */
const GREET_RANGE = 12;
const GREET_CHANCE: [number, number] = [0.25, 0.4];
const GREET_BACK_CHANCE: [number, number] = [0.4, 0.3];
/** leave together: a goodbye names a friend within this; this share of goodbyes with one near; the friend leaves too this often */
const BYE_RANGE = 15;
const BYE_NAMED = 0.7;
const LEAVE_TOGETHER = 0.3;
/** a friend who leaves too logs out within this many play ticks (its wrap-up after), and says no second goodbye for this long */
const LEAVE_SOON: [number, number] = [30, 120];
const NO_SECOND_BYE = 1500;

/** The lines (data/social.json "clique"), for test/chat-filter.test.mjs. */
export const CLIQUE_LINES = socialJson.clique;

// ── who is in a clique (a pure function of the names) ──────────────────────────────────────────────────────────

let cliques: Clique[] | null = null;
const byName = new Map<string, Clique>();
/** tests: cliques given by hand (setCliquesForTest) */
let testCliques: Clique[] | null = null;

function kindOf(planner: PlannerKey): Kind | null {
    if (isLevelling(planner)) return 'levelling';
    return planner === 'extras_pker' || planner === 'extras_edgeville_pker' ? planner : null;
}

function built(): Clique[] {
    if (testCliques) return testCliques;
    if (cliques) return cliques;
    cliques = cliquesOfRoster(BOT_NAMES).map((c, id) => ({ id, kind: c.kind, names: Object.freeze(c.names) }));
    for (const clique of cliques) for (const name of clique.names) byName.set(name, clique);
    return cliques;
}

/**
 * The cliques of a roster: a pure function of the names (names[i] has the planner PLANNERS[i % 8], as the roster's), in
 * whole blocks of a kind; a name in at most one. Exported for the tests (the same names, the same cliques; a longer list
 * keeps a shorter one's).
 */
export function cliquesOfRoster(roster: readonly string[]): { kind: Kind; names: string[] }[] {
    const out: { kind: Kind; names: string[] }[] = [];
    const lists: Record<Kind, string[]> = { levelling: [], extras_pker: [], extras_edgeville_pker: [] };
    roster.forEach((name, i) => {
        const kind = kindOf(PLANNERS[i % PLANNERS.length]);
        if (kind) lists[kind].push(name);
    });
    const order = new Map(roster.map((name, i) => [name, i]));
    for (const kind of Object.keys(lists) as Kind[]) {
        const names = lists[kind];
        const block = kind === 'levelling' ? LEVELLING_BLOCK : PK_BLOCK;
        const size = kind === 'levelling' ? LEVELLING_SIZE : PK_SIZE;
        for (let b = 0; b + block <= names.length; b += block) {
            const members = form(names.slice(b, b + block), kind, size);
            if (!members) continue;
            members.sort((x, y) => order.get(x)! - order.get(y)!);
            out.push({ kind, names: members });
        }
    }
    return out;
}

/** a clique of the block's names around its first (the lowest seed), the most like it; null when too few are */
function form(block: string[], kind: Kind, [lo, hi]: [number, number]): string[] | null {
    const size = lo + (hashString(`clique#${block.join(',')}`) % (hi - lo + 1));
    const seedOf = (name: string) => nameSeed(name, 'clique');
    const anchor = block.reduce((a, b) => (seedOf(b) < seedOf(a) ? b : a));
    const traits = (name: string) => ({ region: personaOf(name).region, tier: kind === 'levelling' ? TIER_RANK[ageTierFor(name, plannerOf(name) ?? 'skiller')] : 0 });
    const first = traits(anchor);
    const ranked = block
        .filter(name => name !== anchor)
        .map(name => {
            const t = traits(name);
            // (ties broken by the name's own seed, under half a step)
            return { name, unlike: (t.region === first.region ? 0 : 2) + Math.abs(t.tier - first.tier), tie: seedOf(name) / 2 ** 33 };
        })
        .filter(c => c.unlike <= MOST_UNLIKE)
        .sort((a, b) => a.unlike + a.tie - (b.unlike + b.tie));
    const members = [anchor, ...ranked.slice(0, size - 1).map(c => c.name)];
    return members.length >= lo ? members : null;
}

function cliqueByName(name: string): Clique | undefined {
    built();
    const map = testCliques ? testByName : byName;
    // (a Player's username is stored normalised already: the base37 round trip only for a display name)
    return map.get(botNameKey(name));
}

/** The names of the bot's clique, itself included (in the roster's order); null: it has none. */
export function cliqueOf(name: string): readonly string[] | null {
    return cliqueByName(name)?.names ?? null;
}

/** Are the two bots of one clique? */
export function sameClique(a: string, b: string): boolean {
    if (a === b) return false;
    const c = cliqueByName(a);
    return c !== undefined && c === cliqueByName(b);
}

/** Every clique (tests, the humanlike report). */
export function allCliques(): readonly { kind: Kind; names: readonly string[] }[] {
    return built();
}

/** port (the realism work, phase 5b): the bot's clique (its kind and names, in the roster's order), or null. */
export function cliqueInfoOf(name: string): { kind: Kind; names: readonly string[] } | null {
    return cliqueByName(name) ?? null;
}

/** the capes a clan wears, by colour (port/BotLooks wardrobeItems().capes: red, black, blue, yellow, green, purple, orange) */
export const CLAN_COLOURS = 7;

/**
 * port (the realism work, phase 5b, Track D: "clan walks in matching capes"): the colour of a levelling clique's capes,
 * an index into port/BotLooks wardrobeItems().capes (0 is red, Thessalia's), from its names alone (the same every run);
 * null for a bot in no levelling clique. New bots of a clique wear it (port/BotLooks gearTaste, the aged kit of
 * port/BotAge); saved bots keep their looks and buy a red cape at Thessalia's for a walk (port/BotClanWalk).
 */
export function cliqueColourOf(name: string): number | null {
    const clique = cliqueByName(name);
    if (!clique || clique.kind !== 'levelling') return null;
    return hashString(`clan#${clique.names.join(',')}`) % CLAN_COLOURS;
}
// (port/BotLooks asks for it without importing this module: it is loaded early, and this one with its graph later)
setCliqueColourSource(cliqueColourOf);

// ── tests ──────────────────────────────────────────────────────────────────────────────────────────────────────

const testByName = new Map<string, Clique>();
/** behaviour on (tests switch it off: the humanlike report's chance level for G1) */
let behaviour = true;

/** Tests only: these groups are the cliques (null: the roster's again). Never called by the game. */
export function setCliquesForTest(groups: string[][] | null): void {
    testByName.clear();
    if (!groups) {
        testCliques = null;
        return;
    }
    testCliques = groups.map((names, id) => {
        const norm = names.map(normalizeBotName);
        const kind = kindOf(plannerOf(norm[0]) ?? 'skiller') ?? 'levelling';
        return { id, kind, names: Object.freeze(norm) };
    });
    for (const c of testCliques) for (const name of c.names) testByName.set(name, c);
}

/** Tests only: the cliques do nothing together (they still exist: cliqueOf). Never called by the game. */
export function setCliqueBehaviourForTest(on: boolean): void {
    behaviour = on;
}

// ── who is online (refreshed every CLIQUE_EVERY ticks) ─────────────────────────────────────────────────────────

const online = new Map<string, Player>();

function refreshOnline(): void {
    online.clear();
    for (const p of BotManager.activeBots()) if (cliqueByName(p.username)) online.set(p.username, p);
}

/** in the world and playing (the map is a few ticks old: a mate that left since is out) */
function playing(p: Player | undefined): p is Player {
    return p !== undefined && p.slot !== -1 && BotManager.botFor(p) !== null;
}

/** the bot's clique-mates online, nearest first */
function matesOnline(bot: Player): Player[] {
    const clique = cliqueByName(bot.username);
    if (!clique) return [];
    const mates: Player[] = [];
    for (const name of clique.names) {
        if (name === bot.username) continue;
        const p = online.get(name);
        if (playing(p)) mates.push(p);
    }
    return mates.sort((a, b) => cheb(a, bot) - cheb(b, bot));
}

/** A clique-mate on its floor within `distance` tiles, playing and not away (the nearest), or null. */
export function cliqueMateNear(bot: Player, distance: number): Player | null {
    for (const mate of matesOnline(bot)) if (mate.level === bot.level && cheb(mate, bot) <= distance && !isAway(mate)) return mate;
    return null;
}

// ── log in together, train together (the other tracks' hooks) ──────────────────────────────────────────────────

/**
 * A score bonus for BotManager._pickReturner: a due bot whose clique-mates are online comes sooner. 0 with none online;
 * 0.5 for one, 0.65 for two, at most 0.9: under one bot of the role mix (a group short of its place still goes first).
 */
export function cliqueReturnBonus(name: string, isOnline: (name: string) => boolean): number {
    if (!behaviour) return 0;
    const clique = cliqueByName(name);
    if (!clique) return 0;
    const self = botNameKey(name);
    let n = 0;
    for (const mate of clique.names) if (mate !== self && isOnline(mate)) n++;
    return n === 0 ? 0 : Math.min(RETURN_BONUS_MAX, RETURN_BONUS + RETURN_BONUS_STEP * (n - 1));
}

/**
 * A clique-mate's current step (the nearest mate's first) of this skill that this bot can do at its level and that
 * suits it (within VARIETY_LEVEL_WINDOW of the best step the level allows: not chickens for a level 50, nor yews for a
 * level 15), as the skill's own step object; null: none. The planner checks the rest (a weapon, food, a fare).
 */
export function cliqueStepFor(bot: Player, skill: string, level: number): SkillStep | null {
    if (!behaviour) return null;
    const steps = SkillProgression[skill];
    if (!steps || steps.length === 0) return null;
    for (const mate of matesOnline(bot)) {
        if (!isLevelling(mate.botPlanner as PlannerKey)) continue;
        let step: SkillStep | null = null;
        try {
            step = BotManager.botFor(mate)?.currentTask?.activityStep() ?? null;
        } catch {
            step = null;
        }
        if (!step) continue;
        // (the same spot in this skill's list: the combat skills keep a list each, with the same spots)
        const same = steps.find(s => s === step || (s.action === step.action && s.location[0] === step.location[0] && s.location[1] === step.location[1] && s.location[2] === step.location[2]));
        if (!same || level < same.minLevel || level > same.maxLevel) continue;
        const eligible = steps.filter(s => level >= s.minLevel && level <= s.maxLevel);
        if (suitedSteps(eligible, VARIETY_LEVEL_WINDOW).includes(same)) return same;
    }
    return null;
}

/**
 * The skills a clique-mate online trains now (the nearest mate's first: the skills whose steps hold its current step's
 * spot; the three melee skills share their spots), for a planner that would rather train with a friend: it may try one
 * of these first, then cliqueStepFor gives the step. Empty: no mate at a step.
 */
export function cliqueSkillsFor(bot: Player): string[] {
    if (!behaviour) return [];
    for (const mate of matesOnline(bot)) {
        if (!isLevelling(mate.botPlanner as PlannerKey)) continue;
        let step: SkillStep | null = null;
        try {
            step = BotManager.botFor(mate)?.currentTask?.activityStep() ?? null;
        } catch {
            step = null;
        }
        if (!step) continue;
        const skills = Object.keys(SkillProgression).filter(skill => SkillProgression[skill]!.some(s => s === step || (s.action === step.action && s.location[0] === step.location[0] && s.location[1] === step.location[1] && s.location[2] === step.location[2])));
        if (skills.length > 0) return skills;
    }
    return [];
}

// ── PK together ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The PKer this one follows on patrol: the first of its PK clique (in the roster's order) online as a PKer of the same
 * kind; null when it is that one itself (it leads), or none is online.
 */
export function pkCliqueLeader(bot: Player): Player | null {
    if (!behaviour) return null;
    const clique = cliqueByName(bot.username);
    if (!clique || clique.kind === 'levelling') return null;
    for (const name of clique.names) {
        if (name === bot.username) return null;
        const p = online.get(name);
        if (playing(p) && p.botPlanner === bot.botPlanner) return p;
    }
    return null;
}

/** The PKer's clique-mates online as PKers of its kind, nearest first (a leader stands by a friend in a fight) */
export function pkCliqueMates(bot: Player): Player[] {
    if (!behaviour) return [];
    const clique = cliqueByName(bot.username);
    if (!clique || clique.kind === 'levelling') return [];
    return matesOnline(bot).filter(p => p.botPlanner === bot.botPlanner);
}

// ── the pass (BotManager.tick) ─────────────────────────────────────────────────────────────────────────────────

/** friends that leave with another: their names and how soon (BotManager's callback, at the next pass) */
const leavingSoon = new Map<string, number>();
/** two bots of a clique met this login (each pair once: the greeting) */
const met = new WeakMap<Player, WeakSet<Player>>();
/** a bot's clique follow (port/BotFollow), and the tick its last one ended */
const following = new WeakMap<Player, CliqueFollowTask>();
const followEnded = new WeakMap<Player, number>();
/** the tick a bot said a goodbye to a friend leaving, or its "me too" */
const byeSaid = new WeakMap<Player, number>();

/**
 * BotManager.tick, every tick a human is in the world: every CLIQUE_EVERY ticks, who of each clique is online; two who
 * meet greet, those going the same way travel together. `leaveSoon(name, ticks)`: BotManager ends that bot's session
 * within `ticks` play ticks (a friend that leaves with another).
 */
export function tickCliques(leaveSoon: (name: string, ticks: number) => void): void {
    const now = World.currentTick;
    if (leavingSoon.size > 0) {
        for (const [name, ticks] of leavingSoon) leaveSoon(name, ticks);
        leavingSoon.clear();
    }
    if (now % CLIQUE_EVERY !== 0) return;
    refreshOnline();
    if (!behaviour || online.size < 2) return;
    const groups = new Map<Clique, Player[]>();
    for (const p of online.values()) {
        if (!playing(p)) continue;
        const clique = cliqueByName(p.username)!;
        let list = groups.get(clique);
        if (!list) groups.set(clique, (list = []));
        list.push(p);
    }
    for (const [clique, members] of groups) {
        if (members.length < 2) continue;
        greet(members, now);
        if (clique.kind === 'levelling') travel(members, now);
        // (variety round 2, S2-4: talk while together)
        banter(clique, members, now);
    }
}

// ── (the variety work, round 2, Track S2: P8) banter between mates ─────────────────────────────────────────────

/** two mates within this of each other are together (they talk) */
const BANTER_RANGE = 6;
/**
 * a clique's next word a heavy-tailed while of its time together later: log-normal around BANTER_GAP (σ BANTER_SIGMA), at
 * least BANTER_MIN; the share of them a thread (port/BotThreads, up to 6 turns), an in-joke, else a word; the mate's
 * answer to a word at BANTER_BACK
 */
const BANTER_GAP = 1300;
const BANTER_SIGMA = 0.8;
const BANTER_MIN = 300;
const BANTER_THREAD = 0.3;
const BANTER_IN_JOKE = 0.15;
const BANTER_BACK = 0.45;
/** each clique's time together left before its next word (ticks of the pass: it counts down only while mates are together) */
const banterLeft = new Map<number, number>();

/** A clique's own in-joke (from its names' seed: the same at every login, another clique's never). */
export function inJokeOf(names: readonly string[]): string {
    const jokes = CLIQUE_LINES.inJokes;
    return jokes[hashString(`in-joke#${names.join(',')}`) % jokes.length];
}

function banter(clique: Clique, members: Player[], now: number): void {
    let pair: [Player, Player] | null = null;
    for (let i = 0; i < members.length && !pair; i++) {
        for (let j = i + 1; j < members.length && !pair; j++) {
            const [a, b] = [members[i], members[j]];
            if (a.level === b.level && cheb(a, b) <= BANTER_RANGE && free(a) && free(b)) pair = [a, b];
        }
    }
    if (!pair) return;
    const gap = (): number => banterGapForTest ?? Math.max(BANTER_MIN, Math.round(logNormal(BANTER_GAP, BANTER_SIGMA)));
    const left = (banterLeft.get(clique.id) ?? gap()) - CLIQUE_EVERY;
    if (left > 0) {
        banterLeft.set(clique.id, left);
        return;
    }
    banterLeft.set(clique.id, gap());
    // (the chattier one most of the time)
    let [g, o] = botPersona(pair[0]).sociability >= botPersona(pair[1]).sociability ? pair : [pair[1], pair[0]];
    if (Math.random() < 0.35) [g, o] = [o, g];
    if (!voiceFree(g, now)) return;
    if (Math.random() < BANTER_THREAD && startThread(g, 'clique', o, DEPTH_FRIENDS)) return;
    const joke = Math.random() < BANTER_IN_JOKE;
    const line = joke ? inJokeLine(g, clique, o) : lineFor(g, CLIQUE_LINES.banter, CLIQUE_LINES.banterPlain, o);
    if (line === null) return;
    // (in the place of its next line of its own: the talk budget)
    countAsOwnLine(g);
    banterStats.words++;
    if (joke) banterStats.inJokes++;
    sayTyped(g, line, {
        to: o,
        kind: 'idle',
        then: () => {
            if (!free(o) || o.level !== g.level || cheb(o, g) > BANTER_RANGE + 4 || Math.random() >= BANTER_BACK * (0.5 + botPersona(o).sociability)) return;
            const back = lineFor(o, CLIQUE_LINES.banterBack, CLIQUE_LINES.banterBackPlain, g);
            if (back === null) return;
            banterStats.backs++;
            countAsOwnLine(o);
            sayTyped(o, back, { to: g, kind: 'botreply' }, reactionTicks(botPersona(o), 'notice'));
        }
    }, reactionTicks(botPersona(g), 'notice'));
}

/** the clique's in-joke, its {nick} the mate's (a fresh one: the registry), else a word of banter */
function inJokeLine(bot: Player, clique: Clique, other: Player): string | null {
    const joke = inJokeOf(clique.names);
    const nick = nickOf(other);
    const line = joke.includes('{nick}') ? (nick ? joke.replaceAll('{nick}', nick) : null) : joke;
    if (line !== null && WordEnc.filter(line) === line && isFresh(bot.username, line, bot.x, bot.z, bot.level, World.currentTick)) {
        noteSaid(bot, line);
        return line;
    }
    return lineFor(bot, CLIQUE_LINES.banter, CLIQUE_LINES.banterPlain, other);
}

/** (the humanlike runner, tests) the cliques' words, in-jokes and the mates' answers so far */
export const banterStats = { words: 0, inJokes: 0, backs: 0 };

/** Tests only: a clique's time together between two words (null: the game's draw); the counts forgotten. Never called by the game. */
let banterGapForTest: number | null = null;
export function setBanterGapForTest(ticks: number | null): void {
    banterGapForTest = ticks;
    banterLeft.clear();
}

/** free for a walk with a friend: playing, not away, busy (a fight, a trade, a window, someone it follows) or on its way out */
function freeToWalk(p: Player): boolean {
    return playing(p) && !isAway(p) && !isBusy(p) && !inFightQuick(p) && habitOf(p) !== 'leaving';
}

/** free for a word with a friend: free to walk, and not talking with someone or typing a line already */
function free(p: Player): boolean {
    return freeToWalk(p) && !BotChat.inConversation(p) && !BotChat.midTalk(p) && !inThread(p);
}

function greet(members: Player[], now: number): void {
    for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
            const a = members[i];
            const b = members[j];
            if (a.level !== b.level || cheb(a, b) > GREET_RANGE || hasMet(a, b)) continue;
            // (met once both are free: a pair that met while one fought, banked or talked was marked met at once and never
            // greeted that login; still near when the other is free, they greet then)
            if (!free(a) || !free(b)) continue;
            markMet(a, b);
            // (the more sociable one, now and then the other)
            let [g, o] = botPersona(a).sociability >= botPersona(b).sociability ? [a, b] : [b, a];
            if (Math.random() < 0.25) [g, o] = [o, g];
            if (Math.random() >= GREET_CHANCE[0] + GREET_CHANCE[1] * botPersona(g).sociability) continue;
            const line = lineFor(g, CLIQUE_LINES.greet, CLIQUE_LINES.greetPlain, o);
            if (line === null) continue;
            // (one of its persona's lines: port/BotChatter's next comes after a quiet)
            countAsChatter(g);
            sayTyped(g, line, {
                to: o,
                kind: 'event',
                then: () => {
                    if (!free(o) || o.level !== g.level || cheb(o, g) > GREET_RANGE + 3) return;
                    if (Math.random() >= GREET_BACK_CHANCE[0] + GREET_BACK_CHANCE[1] * botPersona(o).sociability) return;
                    const back = lineFor(o, CLIQUE_LINES.greetBack, CLIQUE_LINES.greetBackPlain, g);
                    if (back !== null) sayTyped(o, back, { to: g, kind: 'botreply' }, reactionTicks(botPersona(o), 'notice'));
                }
            }, reactionTicks(botPersona(g), 'notice'));
        }
    }
}

function hasMet(a: Player, b: Player): boolean {
    return met.get(a)?.has(b) === true;
}
function markMet(a: Player, b: Player): void {
    for (const [x, y] of [[a, b], [b, a]]) {
        let set = met.get(x);
        if (!set) met.set(x, (set = new WeakSet()));
        set.add(y);
    }
}

interface Trip {
    p: Player;
    dest: readonly [number, number, number];
    d: number;
}

/** members going the same way: the one nearest its destination leads, those near it follow (once a round) */
function travel(members: Player[], now: number): void {
    const trips: Trip[] = [];
    for (const p of members) {
        // (a line it types meanwhile is no matter: players type while they walk)
        // (port, phase 5b: nor one in a set piece, port/BotSetPieces)
        if (!isLevelling(p.botPlanner as PlannerKey) || isNewbie(p) || !freeToWalk(p) || eventRoleOf(p)) continue;
        const bot = BotManager.botFor(p);
        if (!bot || bot.hasSubTask() || p.botComeHereReturnX !== -1 || p.botTradeTargetPid !== -1) continue;
        let step: SkillStep | null = null;
        try {
            step = bot.currentTask?.activityStep() ?? null;
        } catch {
            step = null;
        }
        if (!step) continue;
        const d = Math.max(Math.abs(p.x - step.location[0]), Math.abs(p.z - step.location[1]));
        if (d > TRIP) trips.push({ p, dest: step.location, d });
    }
    if (trips.length < 2) return;
    trips.sort((a, b) => a.d - b.d);
    for (const lead of trips) {
        const followers = trips.filter(t => t !== lead && t.p.level === lead.p.level && cheb(t.p, lead.p) <= FOLLOW_START && sameWay(t.dest, lead.dest) && now - (followEnded.get(t.p) ?? -Infinity) >= FOLLOW_AGAIN);
        if (followers.length === 0) continue;
        for (const f of followers) startFollow(f, lead, now);
        return;
    }
}

function sameWay(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
    return a[2] === b[2] && Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) <= SAME_WAY;
}

function startFollow(f: Trip, lead: Trip, now: number): void {
    const bot = BotManager.botFor(f.p);
    if (!bot) return;
    const ticks = Math.max(200, Math.min(2000, lead.d * 3 + 100));
    const follower = f.p;
    const task = new CliqueFollowTask(lead.p, lead.dest, ticks, () => followEnded.set(follower, World.currentTick));
    bot.setSubTask(task);
    following.set(follower, task);
    followEnded.set(follower, now);
    // (a word now and then: "follow me", "k")
    if (Math.random() < LEAD_WORD) {
        const word = freshLine(lead.p, CLIQUE_LINES.lead);
        if (word !== null) {
            countAsChatter(lead.p);
            sayTyped(lead.p, word, { to: follower, kind: 'event' }, reactionTicks(botPersona(lead.p), 'notice'));
        }
    } else if (Math.random() < FOLLOW_WORD) {
        const word = freshLine(follower, CLIQUE_LINES.follow);
        if (word !== null) {
            countAsChatter(follower);
            sayTyped(follower, word, { to: lead.p, kind: 'event' }, reactionTicks(botPersona(follower), 'notice'));
        }
    }
}

/** The bot's last clique follow (tests: its leader, why it ended), or null. */
export function lastCliqueFollow(bot: Player): CliqueFollowTask | null {
    return following.get(bot) ?? null;
}

/** The friend of its clique the bot follows now (port/BotFollow's clique follow), or null. */
export function followsFriend(bot: Player): Player | null {
    const task = following.get(bot);
    // (one that ended, or that another sub-task replaced: BotPlayer no longer runs it)
    return task && !task.isComplete() && World.currentTick - task.lastTickAt <= 2 ? task.leaderPlayer : null;
}

// ── leave together (port/BotChatter.sayOccasion('departure')) ──────────────────────────────────────────────────

/**
 * The bot leaves the game: a goodbye naming a friend of its clique near it ("cya kev"), or null (none near, or it says an
 * ordinary one). The friend answers ("cya"), and now and then leaves too ("ya me too gtg", then its session ends within
 * LEAVE_SOON). A bot that answered so says no second goodbye of its own (saidGoodbyeLately).
 */
export function cliqueDeparture(bot: Player): string | null {
    if (!behaviour) return null;
    const mate = cliqueMateNear(bot, BYE_RANGE);
    if (!mate || Math.random() >= BYE_NAMED) return null;
    const text = lineFor(bot, CLIQUE_LINES.bye, CLIQUE_LINES.byePlain, mate);
    if (text === null) return null;
    if (free(mate)) {
        const persona = botPersona(mate);
        if (Math.random() < LEAVE_TOGETHER && now() - (byeSaid.get(mate) ?? -Infinity) >= NO_SECOND_BYE) {
            // (its answer to the friend; it logs out soon after, with no goodbye of its own: saidGoodbyeLately)
            sayTyped(mate, freshLine(mate, CLIQUE_LINES.meToo) ?? pick(CLIQUE_LINES.meToo), {
                to: bot,
                kind: 'botreply',
                then: () => {
                    byeSaid.set(mate, World.currentTick);
                    leavingSoon.set(mate.username, LEAVE_SOON[0] + Math.floor(Math.random() * (LEAVE_SOON[1] - LEAVE_SOON[0] + 1)));
                }
            }, reactionTicks(persona, 'notice'));
        } else if (Math.random() < 0.4 + 0.5 * persona.sociability) {
            const back = lineFor(mate, CLIQUE_LINES.byeBack, CLIQUE_LINES.byeBackPlain, bot);
            if (back !== null) sayTyped(mate, back, { to: bot, kind: 'botreply' }, reactionTicks(persona, 'notice'));
        }
    }
    return text;
}

/** The bot said "me too" to a friend leaving lately: its own wrap-up says no second goodbye. */
export function saidGoodbyeLately(bot: Player): boolean {
    return now() - (byeSaid.get(bot) ?? -Infinity) < NO_SECOND_BYE;
}

// ── names ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** words a one-word name may start with that are no first name ("dark1", "iron99") */
const NOT_NICKS = new Set(['the', 'mr', 'mrs', 'sir', 'lord', 'king', 'lil', 'big', 'dark', 'iron', 'rune', 'steel', 'gold', 'fire', 'ice', 'death', 'pk', 'pker', 'noob', 'newb', 'xx', 'xxx', 'pro', 'super', 'mega', 'evil', 'mad', 'red', 'blue', 'green', 'black', 'white']);

/**
 * What a friend calls the bot: its first name (port/BotChat.firstNameOf: "matty" of Matty B), or for a one-word name its
 * letters before any digits ("kevin" of Kevin1991), 3-10 letters; null when it has none.
 */
export function nickOf(bot: Player): string | null {
    const first = firstNameOf(bot);
    if (first) return first;
    const display = bot.displayName.toLowerCase().replace(/_/g, ' ').trim();
    if (display.includes(' ')) return null;
    const m = display.match(/^[a-z]+/);
    return m && m[0].length >= 3 && m[0].length <= 10 && !NOT_NICKS.has(m[0]) ? m[0] : null;
}

/** a line of `pool` with the other's nick in it, or null (no nick, or the filter would change the line) */
function named(pool: readonly string[], other: Player): string | null {
    const nick = nickOf(other);
    if (!nick) return null;
    const line = pick(pool).replaceAll('{nick}', nick);
    return WordEnc.filter(line) === line ? line : null;
}

/**
 * what `bot` says to `other`: a line of `pool` with the other's nick, else one of `plain`, either one fresh (port/BotLines'
 * repetition registry: not one another bot said in this map square lately, nor one of its own last lines), noted as said;
 * null: none is (it says nothing)
 */
function lineFor(bot: Player, pool: readonly string[], plain: readonly string[], other: Player): string | null {
    const line = named(pool, other);
    if (line !== null && isFresh(bot.username, line, bot.x, bot.z, bot.level, World.currentTick)) {
        noteSaid(bot, line);
        return line;
    }
    return freshLine(bot, plain);
}

function pick<T>(list: readonly T[]): T {
    return list[Math.floor(Math.random() * list.length)];
}

function cheb(a: Player, b: Player): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

function now(): number {
    return World.currentTick;
}
