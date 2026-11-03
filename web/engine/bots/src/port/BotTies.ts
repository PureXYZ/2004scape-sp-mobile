// port (bots ideas, round 2, theme D: word that travels, D2 and the KS war): saved ties between bots, bots only, never toward the human. Before, two bots that stood side
// by side at the same rocks every evening never knew each other (port/BotThreads' pair memory lasts a session), and a
// stolen rock was one exchange of lines and forgotten.
//
//   Acquaintances (saved: port/BotArcsStore, `+` ties):
//     the co-presence pass every 25 play ticks (registerArcsTick), bucketed by 8x8 tiles: settled bots (levelling bots
//     at the same task kind and not walking, social regulars at their spot, vendors at their stall, Edgeville PKers at the
//     edge) within 6 tiles of each other add their time together; at 10 minutes together in a session a pair's tie gets
//     +1, once a session pair, with chance 0.25 + 0.5 x their mean sociability. Strength 1-9, "known" from 2 (two
//     sessions together); at most 6 a bot (a new one replaces the weakest, then the oldest: trimArcs); -1 per 24 hours of
//     play without meeting (lazily: a tie's strength is its stored one less a step a day since it last met), gone at 0.
//   Grudges (saved, `-` ties), from the bus (both players bots, else nothing):
//     a meant KS or rock steal: the victim's +2 against the stealer; one noticed but not meant +1; a PK kill between
//     bots: the victim's +2 against its killer, and two Edgeville PKers a rivalry both ways (the killer's +1); an
//     argument (the victim's line and the stealer's answer) +1 both ways. Strength 1-5, at most 2 a bot, -1 per 6 hours
//     of play. (Theme C's wedding: its couple's tie +2.)
//   Effects:
//     greeting  at the first meeting of a session (both free, within 12 tiles, an acquaintance of 2+, not clique mates:
//               they have their own), the more sociable one says "hey again", "sup {nick}" ... with chance 0.3 + 0.4 x
//               sociability, else now and then a wave; the other answers 40 % ("hey", "lol hi"). Both countAsChatter (the
//               clique greeting's rule)
//     "u again" at a grudge's first sight in a session (2+, within 15 tiles): 0.5 ("u again", "{nick} the ks guy", "stay
//               off my rocks"), own slot; the other answers 0.3 ("lol", "cry more"), own slot
//     threads   a tied partner (2+) weighs x3 in port/BotThreads' partner pick, depth 6 at 4+ (its block)
//     KS war    a rude (port/BotPersona rudeActs) or tilted (theme C's moodOf, 0.4+) grudge-holder's steal roll against its
//               enemy x3 (tasks/CombatTask, tasks/MiningTask blocks); port/BotRude's caps unchanged (one steal a bot per
//               15 minutes), and maySteal still asks rudeActs: a polite bot never steals, tilted or not
//     rivals    an Edgeville PKer with a grudge against another at the edge prefers it among findNearbyTarget's valid
//               targets (combat range, the Wilderness level, not claimed, single-combat rules: tasks/EdgevillePKerTask's
//               block); "rematch?", "sit again lol" now and then (LineKind pk, the edge's banter)
//   tieOf(a, b) for theme C (port/BotArcsEvents provideArcs: its 99 guests, its tilt's grudge bonus).
//
// Dice: theme D's own (port/BotWordHooks wordRoll, seeded from Math.random), no wall clock: the arcs' play clock
// (arcsPlay). Per tick nothing; the pass every 25 ticks is O(bots + pairs in buckets) plus a look at each online bot's
// ties (at most 8).
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import { arcsMood, arcsPlay, onArcs, provideArcs, registerArcsTick } from '#/engine/bot/port/BotArcsEvents.js';
import { arcsOf, peekArcs, trimArcs, type TieRecord } from '#/engine/bot/port/BotArcsStore.js';
import { arcLines, sayArcLine } from '#/engine/bot/port/BotArcsSay.js';
import { BotChat, inFightQuick, isBusy } from '#/engine/bot/port/BotChat.js';
import { nickOf, sameClique } from '#/engine/bot/port/BotCliques.js';
import { everydayEmote } from '#/engine/bot/port/BotEmote.js';
import { habitOf, isAway } from '#/engine/bot/port/BotHabits.js';
import { isLevelling, type PlannerKey } from '#/engine/bot/port/BotRoster.js';
import { rudeActs, type Incident } from '#/engine/bot/port/BotRude.js';
import { inThread } from '#/engine/bot/port/BotThreads.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { stallOf } from '#/engine/bot/port/BotTradeSpots.js';
import { wordHooks, wordRandInt, wordRoll } from '#/engine/bot/port/BotWordHooks.js';

// ── the defaults ───────────────────────────────────────────────────────────────────────────────────

/** the co-presence pass, every this many play ticks */
export const PASS_TICKS = 25;
/** two settled bots within this of each other are together */
export const TOGETHER_TILES = 6;
/** this long together in a session makes a pair's tie +1 (once a session pair), with chance FORM_BASE + FORM_SOCIABLE x mean sociability */
export const TOGETHER_TICKS = 1000;
export const FORM_BASE = 0.25;
export const FORM_SOCIABLE = 0.5;
/** an acquaintance is known (greeted, a thread partner) from this strength; a thread's depth 6 from THREAD_DEEP */
export const KNOWN = 2;
export const THREAD_DEEP = 4;
/** the strengths' tops, and a step's decay (play ticks): an acquaintance a day, a grudge 6 hours */
export const ACQUAINTANCE_MAX = 9;
export const GRUDGE_MAX = 5;
export const ACQUAINTANCE_DECAY = 144_000;
export const GRUDGE_DECAY = 36_000;
/** a greeting: within this, with chance GREET_BASE + GREET_SOCIABLE x sociability (else a wave now and then); the answer's chance */
export const GREET_TILES = 12;
export const GREET_BASE = 0.3;
export const GREET_SOCIABLE = 0.4;
export const GREET_WAVE = 0.3;
export const GREET_BACK = 0.4;
/** a grudge's first sight: within this, its line's chance, the answer's */
export const GRUDGE_TILES = 15;
export const GRUDGE_LINE = 0.5;
export const GRUDGE_BACK = 0.3;
/** the KS war's factor on the steal roll, and the tilt that makes a grudge-holder fight it */
export const KS_WAR = 3;
export const KS_WAR_TILT = 0.4;
/** an Edgeville rival's line when it picks it (once a session pair) */
export const RIVAL_LINE = 0.3;
/** the pair accumulators at most */
const PAIRS_MOST = 20_000;

const DEFAULT_RATES = { on: true, form: FORM_BASE, formSociable: FORM_SOCIABLE, together: TOGETHER_TICKS, greet: GREET_BASE, greetSociable: GREET_SOCIABLE, wave: GREET_WAVE, greetBack: GREET_BACK, grudgeLine: GRUDGE_LINE, grudgeBack: GRUDGE_BACK, rivalLine: RIVAL_LINE };
/** the rates in use (tests change them: setTiesForTest) */
export const tieRates = { ...DEFAULT_RATES };
/** Tests only: other rates, or ties off (null: the defaults). Never set by the game. */
export function setTiesForTest(rates: Partial<typeof DEFAULT_RATES> | null): void {
    Object.assign(tieRates, DEFAULT_RATES, rates ?? {});
}

/** what the ties did (the humanlike runner's WT5, WT6, the tests) */
export const tieStats = { formed: 0, rolled: 0, refreshed: 0, greetings: 0, waves: 0, greetBacks: 0, grudges: 0, grudgeLines: 0, grudgeBacks: 0, rivalPicks: 0, rivalLines: 0, warRolls: 0, wedding: 0 };
/** the lines and moments, newest last (capped): { t, kind: 'greet' | 'wave' | 'greet-back' | 'grudge' | 'grudge-back' | 'rival' | 'formed' | 'grudge-formed', a, b } */
export const tieLog: { t: number; kind: string; a: string; b: string; why?: string }[] = [];
function note(kind: string, a: string, b: string, why?: string): void {
    tieLog.push({ t: World.currentTick, kind, a, b, ...(why ? { why } : {}) });
    if (tieLog.length > 5000) tieLog.splice(0, tieLog.length - 5000);
}

/** Tests only: the session's accumulators and greetings forgotten (the saved ties are port/BotArcsStore's). */
export function resetTiesForTest(): void {
    pairs.clear();
    pairsByName.clear();
    tieLog.length = 0;
    recentIncidents.length = 0;
    for (const k of Object.keys(tieStats) as (keyof typeof tieStats)[]) tieStats[k] = 0;
}

// ── the ties ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** a tie's strength now (its stored one less a step for each decay period since it last met) */
function effective(t: TieRecord, play: number): number {
    const step = t.sign > 0 ? ACQUAINTANCE_DECAY : GRUDGE_DECAY;
    return Math.max(0, t.strength - Math.max(0, Math.floor((play - t.last) / step)));
}

function tieRecord(a: string, b: string, sign: 1 | -1): TieRecord | undefined {
    return peekArcs(a)?.ties?.find(t => t.other === b && t.sign === sign);
}

/** the strength now of a's tie of this sign to b (0: none) */
export function tieStrength(a: string, b: string, sign: 1 | -1, play: number = arcsPlay()): number {
    const t = tieRecord(a, b, sign);
    return t ? effective(t, play) : 0;
}

/** a's tie to b changes by `delta` (a meeting, a grudge fed): strength from its decayed one, last met now; at 0 it goes */
function addTie(a: string, b: string, sign: 1 | -1, delta: number, play: number = arcsPlay()): number {
    if (a === b) return 0;
    const rec = arcsOf(a);
    const ties = (rec.ties ??= []);
    let t = ties.find(x => x.other === b && x.sign === sign);
    const before = t ? effective(t, play) : 0;
    const strength = Math.max(0, Math.min(sign > 0 ? ACQUAINTANCE_MAX : GRUDGE_MAX, before + delta));
    if (strength <= 0) {
        if (t) rec.ties = ties.filter(x => x !== t);
        if (rec.ties!.length === 0) delete rec.ties;
        return 0;
    }
    if (!t) ties.push((t = { other: b, sign, strength, last: play }));
    else {
        t.strength = strength;
        t.last = play;
    }
    trimArcs(rec);
    // (it may have been trimmed: a new weak tie past the cap)
    return tieRecord(a, b, sign) ? strength : 0;
}

/** they met again: the tie's last meeting now (its strength from its decayed one) */
function refresh(a: string, b: string, play: number): void {
    const t = tieRecord(a, b, 1);
    if (!t) return;
    t.strength = effective(t, play);
    t.last = play;
    if (t.strength <= 0) addTie(a, b, 1, 0, play);
    else tieStats.refreshed++;
}

/** (theme C asks through port/BotArcsEvents arcsTie) a's tie to b: its acquaintance (0-9) and grudge (0-5) now, or null (none) */
export function tieOf(a: string, b: string): { acquaintance: number; grudge: number } | null {
    const play = arcsPlay();
    const acquaintance = tieStrength(a, b, 1, play);
    const grudge = tieStrength(a, b, -1, play);
    return acquaintance > 0 || grudge > 0 ? { acquaintance, grudge } : null;
}

/** the ties gone to 0 dropped (an hourly sweep: the store keeps only live ones) */
function sweep(play: number): void {
    for (const p of BotManager.activeBots()) {
        const rec = peekArcs(p.username);
        if (!rec?.ties) continue;
        const kept = rec.ties.filter(t => effective(t, play) > 0);
        if (kept.length !== rec.ties.length) {
            if (kept.length) rec.ties = kept;
            else delete rec.ties;
        }
    }
}

// ── who is settled (the co-presence pass) ────────────────────────────────────────────────────────────────────────

/** the task kinds of levelling bots on the move or at a shop: never settled */
const TRANSIT = new Set(['none', 'Idle', 'Bank', 'ShopTrip', 'FoodTrip', 'Walk', 'Travel', 'PartyGuest']);

/** at the edge, where the Edgeville PKers patrol (tasks/EdgevillePKerTask's zone, a little past it) */
function atTheEdge(p: Player): boolean {
    return Math.abs(p.x - 3093) <= 18 && p.z >= 3522 && p.z <= 3563;
}

/** a settled bot's group (bots of one group at one place get to know each other), or null: not settled */
function groupOf(p: Player): string | null {
    if (p.is_bot !== true || p.slot === -1 || p.hasWaypoints()) return null;
    const planner = p.botPlanner as PlannerKey;
    if (isLevelling(planner)) {
        const name = BotManager.botFor(p)?.currentTask?.name ?? 'none';
        const kind = name.split(':')[0];
        return TRANSIT.has(kind) ? null : `L:${kind}`;
    }
    if (planner === 'extras_social') return BotManager.botFor(p)?.currentTask?.name === 'Social' ? 'H' : null;
    if (planner === 'extras_vendor') return stallOf(p) !== null ? 'H' : null;
    if (planner === 'extras_edgeville_pker') return atTheEdge(p) ? 'E' : null;
    return null;
}

interface Pair {
    a: Player;
    b: Player;
    ticks: number;
    done: boolean;
}
const pairs = new Map<string, Pair>();
const pairsByName = new Map<string, Set<string>>();

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

function track(key: string, name: string): void {
    let set = pairsByName.get(name);
    if (!set) pairsByName.set(name, (set = new Set()));
    set.add(key);
}

/** a pair together for one pass: its time, and at TOGETHER_TICKS its roll (once a session pair) */
function together(p: Player, q: Player, play: number): void {
    const [a, b] = p.username < q.username ? [p, q] : [q, p];
    const key = `${a.username}|${b.username}`;
    let pair = pairs.get(key);
    if (!pair || pair.a !== a || pair.b !== b) {
        if (!pair && pairs.size >= PAIRS_MOST) return;
        pairs.set(key, (pair = { a, b, ticks: 0, done: false }));
        track(key, a.username);
        track(key, b.username);
    }
    pair.ticks += PASS_TICKS;
    // (two who know each other met again: their ties' last meeting is now)
    if (pair.ticks === PASS_TICKS) {
        refresh(a.username, b.username, play);
        refresh(b.username, a.username, play);
    }
    if (pair.done || pair.ticks < tieRates.together) return;
    pair.done = true;
    // (ten minutes side by side: no "hey again" this session, the next meeting's)
    mark(greeted, a, b);
    tieStats.rolled++;
    const sociable = (botPersona(a).sociability + botPersona(b).sociability) / 2;
    if (wordRoll() >= tieRates.form + tieRates.formSociable * sociable) return;
    addTie(a.username, b.username, 1, 1, play);
    addTie(b.username, a.username, 1, 1, play);
    tieStats.formed++;
    note('formed', a.username, b.username);
}

/** the co-presence pass: settled bots by 8x8 cell, each pair within TOGETHER_TILES of one group once */
function copresence(play: number): void {
    const cells = new Map<number, Player[]>();
    const groups = new Map<Player, string>();
    for (const p of BotManager.activeBots()) {
        const g = groupOf(p);
        if (g === null) continue;
        groups.set(p, g);
        const key = cellKey(p.x >> 3, p.z >> 3, p.level);
        let list = cells.get(key);
        if (!list) cells.set(key, (list = []));
        list.push(p);
    }
    const near = (p: Player, q: Player): boolean => p.level === q.level && Math.max(Math.abs(p.x - q.x), Math.abs(p.z - q.z)) <= TOGETHER_TILES && groups.get(p) === groups.get(q);
    for (const [key, list] of cells) {
        const cx = (key >> 14) & 0x3fff;
        const cz = key & 0x3fff;
        const level = key >>> 28;
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (near(list[i], list[j])) together(list[i], list[j], play);
        // (the cells after this one: east, south-west, south, south-east; each pair of cells once)
        for (const [dx, dz] of [[1, 0], [-1, 1], [0, 1], [1, 1]] as const) {
            const other = cells.get(cellKey(cx + dx, cz + dz, level));
            if (!other) continue;
            for (const p of list) for (const q of other) if (near(p, q)) together(p, q, play);
        }
    }
}

const cellKey = (cx: number, cz: number, level: number): number => ((level & 3) << 28) | ((cx & 0x3fff) << 14) | (cz & 0x3fff);

// ── greetings and "u again" ──────────────────────────────────────────────────────────────────────────────────────

/** two bots that met this session (each pair once: a greeting, a grudge's first sight) */
const greeted = new WeakMap<Player, WeakSet<Player>>();
const sighted = new WeakMap<Player, WeakSet<Player>>();
function seen(map: WeakMap<Player, WeakSet<Player>>, a: Player, b: Player): boolean {
    return map.get(a)?.has(b) === true;
}
function mark(map: WeakMap<Player, WeakSet<Player>>, a: Player, b: Player): void {
    for (const [x, y] of [[a, b], [b, a]]) {
        let set = map.get(x);
        if (!set) map.set(x, (set = new WeakSet()));
        set.add(y);
    }
}

/** free for a word: playing, not away, busy (a fight, a trade, a window), on its way out, or talking already */
function free(p: Player): boolean {
    if (p.slot === -1 || !BotManager.botFor(p) || isAway(p) || isBusy(p) || inFightQuick(p) || habitOf(p) === 'leaving') return false;
    return !BotChat.inConversation(p) && !BotChat.midTalk(p) && !inThread(p);
}

let namesTick = -1;
const byName = new Map<string, Player>();
function botNamed(name: string): Player | null {
    const now = World.currentTick;
    if (namesTick !== now) {
        namesTick = now;
        byName.clear();
        for (const p of BotManager.activeBots()) byName.set(p.username, p);
    }
    const p = byName.get(name);
    return p && p.slot !== -1 ? p : null;
}

/** why a grudge was last fed (the line's kind: 'ks', 'rock', 'pk'), session-only */
const grudgeWhy = new Map<string, string>();

/** each online bot's known ties near it: a greeting at the first meeting, "u again" at a grudge's first sight */
function meetings(play: number): void {
    for (const p of BotManager.activeBots()) {
        const ties = peekArcs(p.username)?.ties;
        if (!ties) continue;
        for (const t of ties) {
            const q = botNamed(t.other);
            if (!q || q === p || q.level !== p.level) continue;
            const d = Math.max(Math.abs(p.x - q.x), Math.abs(p.z - q.z));
            if (t.sign > 0) {
                if (d > GREET_TILES || seen(greeted, p, q) || effective(t, play) < KNOWN || sameClique(p.username, q.username)) continue;
                if (!free(p) || !free(q)) continue;
                mark(greeted, p, q);
                greet(p, q);
            } else {
                if (d > GRUDGE_TILES || seen(sighted, p, q) || effective(t, play) < KNOWN) continue;
                if (!free(p) || !free(q)) continue;
                mark(sighted, p, q);
                grudgeLine(p, q, grudgeWhy.get(`${p.username}|${q.username}`) ?? 'any');
            }
        }
    }
}

/** two acquaintances meet: the more sociable one (now and then the other) greets; the other may answer */
function greet(a: Player, b: Player): void {
    let [g, o] = botPersona(a).sociability >= botPersona(b).sociability ? [a, b] : [b, a];
    if (wordRoll() < 0.25) [g, o] = [o, g];
    if (wordRoll() >= tieRates.greet + tieRates.greetSociable * botPersona(g).sociability) {
        if (wordRoll() < tieRates.wave && everydayEmote(g, 'wave')) {
            tieStats.waves++;
            note('wave', g.username, o.username);
        }
        return;
    }
    const nick = nickOf(o) ?? '';
    const said = sayArcLine(g, arcLines('word-greet'), { nick }, {
        kind: 'event',
        budget: 'chatter',
        to: o,
        random: wordRoll,
        then: () => {
            if (!free(o) || o.level !== g.level || Math.max(Math.abs(o.x - g.x), Math.abs(o.z - g.z)) > GREET_TILES + 3 || wordRoll() >= tieRates.greetBack) return;
            if (sayArcLine(o, arcLines('word-greet-back'), {}, { kind: 'botreply', budget: 'chatter', to: g, random: wordRoll }) !== null) {
                tieStats.greetBacks++;
                note('greet-back', o.username, g.username);
            }
        }
    });
    if (said === null) return;
    tieStats.greetings++;
    note('greet', g.username, o.username);
}

/** a grudge's first sight in a session: "u again" now and then (own slot); the other may answer (own slot) */
function grudgeLine(holder: Player, enemy: Player, why: string): void {
    if (wordRoll() >= tieRates.grudgeLine) return;
    const pool = why === 'any' ? arcLines('word-grudge', 'any') : [...arcLines('word-grudge', why), ...arcLines('word-grudge', 'any')];
    const said = sayArcLine(holder, pool, { nick: nickOf(enemy) ?? '' }, {
        kind: 'event',
        budget: 'own',
        to: enemy,
        random: wordRoll,
        then: () => {
            if (!free(enemy) || enemy.level !== holder.level || Math.max(Math.abs(enemy.x - holder.x), Math.abs(enemy.z - holder.z)) > GRUDGE_TILES + 3 || wordRoll() >= tieRates.grudgeBack) return;
            if (sayArcLine(enemy, arcLines('word-grudge-back'), {}, { kind: 'botreply', budget: 'own', to: holder, random: wordRoll }) !== null) {
                tieStats.grudgeBacks++;
                note('grudge-back', enemy.username, holder.username);
            }
        }
    });
    if (said === null) return;
    tieStats.grudgeLines++;
    note('grudge', holder.username, enemy.username, why);
}

// ── grudges (the bus) ────────────────────────────────────────────────────────────────────────────────────────────

/** a's grudge against b fed by `delta` (bots only), for `why` */
function grudge(a: Player, b: Player, delta: number, why: string): void {
    if (!tieRates.on || a.is_bot !== true || b.is_bot !== true || a === b) return;
    // (the moment itself is this session's sight of each other: "u again" waits for their next session's first meeting)
    mark(sighted, a, b);
    if (addTie(a.username, b.username, -1, delta) > 0) {
        grudgeWhy.set(`${a.username}|${b.username}`, why);
        if (grudgeWhy.size > 10_000) grudgeWhy.clear();
    }
    tieStats.grudges++;
    note('grudge-formed', a.username, b.username, why);
}

/** the bot-bot steals lately, for their arguments (the victim's line and the stealer's answer: +1 both ways, once) */
const recentIncidents: { incident: Incident; stealer: Player; victim: Player; argued: boolean }[] = [];

function onSteal(incident: Incident, stealer: Player, victim: Player, again: boolean): void {
    if (stealer.is_bot !== true || victim.is_bot !== true) return;
    // (KS between a grudge pair: the stealer held one against its victim: WT6's detail)
    if (tieStrength(stealer.username, victim.username, -1) > 0) incidentWar.add(incident.id);
    if (again) grudge(victim, stealer, 1, incident.kind);
    else grudge(victim, stealer, incident.deliberate ? 2 : 1, incident.kind);
    if (!recentIncidents.some(x => x.incident === incident)) {
        recentIncidents.push({ incident, stealer, victim, argued: false });
        if (recentIncidents.length > 50) recentIncidents.shift();
    }
}

/** the steals made by a bot against a bot it held a grudge against (incident ids: WT6's "KS between a grudge pair") */
export const incidentWar = new Set<number>();

function arguments_(now: number): void {
    for (const x of recentIncidents) {
        if (x.argued || x.incident.victimLine < 0 || x.incident.stealerLine < 0) continue;
        x.argued = true;
        grudge(x.victim, x.stealer, 1, x.incident.kind);
        grudge(x.stealer, x.victim, 1, x.incident.kind);
    }
    while (recentIncidents.length > 0 && now - recentIncidents[0].incident.tick > 1200) recentIncidents.shift();
}

function onKill(killer: Player, victim: Player, edge: boolean): void {
    if (killer.is_bot !== true || victim.is_bot !== true) return;
    grudge(victim, killer, 2, 'pk');
    // (two Edgeville PKers: a rivalry both ways)
    if (edge && killer.botPlanner === 'extras_edgeville_pker' && victim.botPlanner === 'extras_edgeville_pker') grudge(killer, victim, 1, 'pk');
}

// ── the KS war and the rivals (the hooks) ────────────────────────────────────────────────────────────────────────

/** the steal roll's factor against `victim`: KS_WAR for a rude or tilted bot with a grudge against it, else 1 */
export function stealFactor(bot: Player, victim: Player): number {
    if (!tieRates.on || victim.is_bot !== true || tieStrength(bot.username, victim.username, -1) < 1) return 1;
    if (!rudeActs(bot) && (arcsMood(bot)?.tilt ?? 0) < KS_WAR_TILT) return 1;
    tieStats.warRolls++;
    return KS_WAR;
}

const rivalSaid = new WeakMap<Player, WeakSet<Player>>();

/** an Edgeville PKer's rival at the edge among the valid targets within `radius` (a grudge of 1+), or null */
function rival(bot: Player, radius: number, valid: (p: Player) => boolean): Player | null {
    if (!tieRates.on || bot.botPlanner !== 'extras_edgeville_pker') return null;
    const ties = peekArcs(bot.username)?.ties;
    if (!ties) return null;
    const play = arcsPlay();
    let best: Player | null = null;
    let bestD = Infinity;
    for (const t of ties) {
        if (t.sign > 0 || effective(t, play) < 1) continue;
        const p = botNamed(t.other);
        if (!p || p.botPlanner !== 'extras_edgeville_pker' || p.level !== bot.level || !atTheEdge(p)) continue;
        const d = Math.max(Math.abs(p.x - bot.x), Math.abs(p.z - bot.z));
        if (d > radius || d >= bestD || !valid(p)) continue;
        best = p;
        bestD = d;
    }
    if (!best) return null;
    tieStats.rivalPicks++;
    // ("rematch?", "sit again lol": the edge's banter, now and then, once a session pair)
    if (!seen(rivalSaid, bot, best) && wordRoll() < tieRates.rivalLine) {
        mark(rivalSaid, bot, best);
        if (sayArcLine(bot, arcLines('word-rival'), {}, { kind: 'pk', budget: 'slot', to: best, random: wordRoll }) !== null) {
            tieStats.rivalLines++;
            note('rival', bot.username, best.username);
        }
    }
    return best;
}

// ── the bus and the passes ───────────────────────────────────────────────────────────────────────────────────────

onArcs('steal', e => onSteal(e.incident, e.stealer, e.victim, e.again === true));
onArcs('kill', e => {
    if (tieRates.on) onKill(e.killer, e.victim, e.edge);
});
onArcs('logout', e => {
    // (its session's pairs end: a pair's next session starts its time again)
    const keys = pairsByName.get(e.name);
    if (!keys) return;
    for (const key of keys) pairs.delete(key);
    pairsByName.delete(e.name);
});
// (theme C's wedding: its couple's tie +2 both ways, through the bus only)
onArcs('wedding', e => {
    if (!tieRates.on) return;
    const [a, b] = e.couple;
    if (a.is_bot !== true || b.is_bot !== true) return;
    addTie(a.username, b.username, 1, 2);
    addTie(b.username, a.username, 1, 2);
    tieStats.wedding++;
});
registerArcsTick((now, play) => {
    if (!tieRates.on) return;
    copresence(play);
    meetings(play);
    arguments_(now);
    if (play % 6000 === 0) sweep(play);
}, PASS_TICKS);
provideArcs('tieOf', tieOf);
wordHooks.stealFactor = stealFactor;
wordHooks.rival = rival;

/** (tests) a pair's time together this session (ticks), and the run of a pass now */
export function togetherTicks(a: Player, b: Player): number {
    return pairs.get(pairKey(a.username, b.username))?.ticks ?? 0;
}
export function passForTest(play: number = arcsPlay()): void {
    copresence(play);
    meetings(play);
    arguments_(World.currentTick);
}
/**
 * (tests) a new session for two bots without their logout and login (a staged world cannot bring a given bot back at
 * once): their time together and their meeting this session forgotten, as a new login's new Player would have them
 */
export function newSessionForTest(a: Player, b: Player): void {
    pairs.delete(pairKey(a.username, b.username));
    for (const map of [greeted, sighted, rivalSaid]) {
        map.get(a)?.delete(b);
        map.get(b)?.delete(a);
    }
}
/** (tests) feed a grudge or a tie as the game would */
export const tieForTest = { add: addTie, grudge, effective, groupOf };
