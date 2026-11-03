// port (bots ideas, round 2: the arcs foundation): what a
// bot's life carries across its sessions and the app's restarts, bots only: its goal (theme C), its ties to other bots
// (acquaintances and grudges, theme D) and the catchphrases it borrowed from other bots (theme D). Never the human: a
// record is a pool bot's, a tie names a bot of data/names.json (a name outside it cannot be written), and BotManager
// forgets a name that leaves the pool (forgetArcs: a quit, a human taking the name), its record and every tie to it.
//
// Saved with the living world (BotManager.exportWorld → BotWorldState.arcs, which rides in every bots.sav write as
// _meta.world: no new write), compact:
//   { "v": 1, "t": <play tick of the export>, "b": { "<id36>": "<goal>|<ties>|<phrases>" } }
//   id36      the bot's index in data/names.json in base 36 (append only, locked by test/names.test.mjs)
//   goal      <kind><stat36: L only, one char><target36>.<age36>.<base36>[.<flags36>]   (kinds L G M C T)
//   ties      <id36><+|-><strength 1-9>@<age36>, comma-separated: + an acquaintance, - a grudge
//   phrases   <index36><strength 1-9>@<age36>, comma-separated: an index into port/BotLines' CATCHPHRASE_LIST
//   ages      minutes of play before t (a goal's `since`, a tie's or a phrase's `last`): a restore needs no clock, and a
//             time is in the play ticks of this run (negative for one before it)
// Empty sections at the end are left out: "L81o.gg.3op5", "|q5+4@25p", "||182@cd".
//
// Caps: per bot ARCS_CAPS.acquaintances (6), .grudges (2) and .phrases (2), the strongest then the latest kept (trimArcs;
// the export and the restore keep them too); the whole section at most ARCS_CAPS.bytes (160 KB): over it the export
// drops the weakest ties first (lowest strength, then the oldest), then phrases, then goals (the oldest). At 1,000 bots
// online (a pool of 2,000) a world at every cap is about 213 KB, so the cap bites only there; typical is 45 bytes a bot.
// exportArcs returns null when there is nothing to save (the world JSON is then byte-identical to a library without
// arcs). restoreArcs never throws: another v, a section that is not an object, a malformed entry, tie or phrase is
// skipped; a record of a name the pool does not hold (`known`: quit, a human's), a tie to one, a tie to itself, is dropped.
//
// The records live here; the C and D modules own their meaning (goals, ties, slang). No dice, no clock: bookkeeping,
// a leaf module (worker-safe).
import { BOT_NAMES, botNameKey } from '#/engine/bot/port/BotRoster.js';

/** L a level (stat, target level), G gear (an item id), M money (target coins / 1000), C combat level, T total level */
export type GoalKind = 'L' | 'G' | 'M' | 'C' | 'T';

export interface GoalRecord {
    kind: GoalKind;
    target: number;
    /** the skill of an L goal (PlayerStat, 0-35) */
    stat?: number;
    /** the play tick it was set */
    since: number;
    /** the progress measure then (XP/10, coins, a level: the goal's owner decides) */
    base: number;
    /** the owner's bits (a 99 goal, a vendor-only piece ...) */
    flags?: number;
}

/** +1 an acquaintance, -1 a grudge; strength 1-9; last: the play tick they last met (or the grudge last fed) */
export interface TieRecord {
    other: string;
    sign: 1 | -1;
    strength: number;
    last: number;
}

/** a borrowed catchphrase: its index in port/BotLines' CATCHPHRASE_LIST, strength 1-9, last: the play tick it was last heard or said */
export interface PhraseRecord {
    phrase: number;
    strength: number;
    last: number;
}

export interface ArcsRecord {
    goal?: GoalRecord;
    ties?: TieRecord[];
    phrases?: PhraseRecord[];
}

export const ARCS_CAPS = { acquaintances: 6, grudges: 2, phrases: 2, bytes: 160_000 } as const;
/** a tie's and a phrase's strength at most (one digit in the export) */
export const ARCS_STRENGTH_MAX = 9;
/** the section's version (BotWorldState.arcs.v): another is not read */
export const ARCS_VERSION = 1;
const TICKS_PER_MINUTE = 100;
const GOAL_KINDS: ReadonlySet<string> = new Set(['L', 'G', 'M', 'C', 'T']);

/** every bot's record, by its name as the engine stores it (normalised) */
const records = new Map<string, ArcsRecord>();
let lastBytes = 0;

// ── names and ids ────────────────────────────────────────────────────────────────────────────────────────────────

let nameIndex: Map<string, number> | null = null;
function indexOfName(name: string): number {
    if (nameIndex === null) {
        nameIndex = new Map();
        BOT_NAMES.forEach((n, i) => {
            if (!nameIndex!.has(n)) nameIndex!.set(n, i);
        });
    }
    return nameIndex.get(botNameKey(name)) ?? -1;
}

/** a bot name's id in the export (its index in data/names.json, base 36), or null for a name that is not a bot's */
export function arcsIdOf(name: string): string | null {
    const i = indexOfName(name);
    return i < 0 ? null : i.toString(36);
}

/** the bot name of an id in the export, or null */
export function arcsNameOf(id: string): string | null {
    if (!/^[0-9a-z]{1,4}$/.test(id)) return null;
    return BOT_NAMES[parseInt(id, 36)] ?? null;
}

// ── the records ──────────────────────────────────────────────────────────────────────────────────────────────────

/** the bot's record, made on demand */
export function arcsOf(name: string): ArcsRecord {
    const key = botNameKey(name);
    let rec = records.get(key);
    if (!rec) records.set(key, (rec = {}));
    return rec;
}

/** the bot's record, or undefined (none made) */
export function peekArcs(name: string): ArcsRecord | undefined {
    return records.get(botNameKey(name));
}

/** every record (the runner, the tests; the C and D modules' passes), by normalised name */
export function arcsEntries(): IterableIterator<[string, ArcsRecord]> {
    return records.entries();
}

/** A bot left the pool for good (it quit, or a human has the name now): its record and every tie to it go. */
export function forgetArcs(name: string): void {
    const key = botNameKey(name);
    records.delete(key);
    for (const rec of records.values()) {
        if (rec.ties && rec.ties.some(t => t.other === key)) {
            rec.ties = rec.ties.filter(t => t.other !== key);
            if (rec.ties.length === 0) delete rec.ties;
        }
    }
}

/** the strongest, then the latest, `n` of `list`, in their order */
function strongest<T extends { strength: number; last: number }>(list: readonly T[], n: number): T[] {
    if (list.length <= n) return [...list];
    const kept = new Set([...list].sort((a, b) => b.strength - a.strength || b.last - a.last).slice(0, n));
    return list.filter(x => kept.has(x));
}

/** one tie a pair and sign (the stronger, then the latest), then the caps: 6 acquaintances, 2 grudges */
function cappedTies(ties: readonly TieRecord[]): TieRecord[] {
    const best = new Map<string, TieRecord>();
    for (const t of ties) {
        const k = `${t.sign}${t.other}`;
        const was = best.get(k);
        if (!was || t.strength > was.strength || (t.strength === was.strength && t.last > was.last)) best.set(k, t);
    }
    const unique = ties.filter(t => best.get(`${t.sign}${t.other}`) === t);
    const plus = strongest(
        unique.filter(t => t.sign > 0),
        ARCS_CAPS.acquaintances
    );
    const minus = strongest(
        unique.filter(t => t.sign < 0),
        ARCS_CAPS.grudges
    );
    const kept = new Set([...plus, ...minus]);
    return unique.filter(t => kept.has(t));
}

function cappedPhrases(phrases: readonly PhraseRecord[]): PhraseRecord[] {
    const best = new Map<number, PhraseRecord>();
    for (const p of phrases) {
        const was = best.get(p.phrase);
        if (!was || p.strength > was.strength || (p.strength === was.strength && p.last > was.last)) best.set(p.phrase, p);
    }
    return strongest(
        phrases.filter(p => best.get(p.phrase) === p),
        ARCS_CAPS.phrases
    );
}

/** The record within its caps (a tie a pair and sign; the strongest, then the latest, kept): for the modules after an addition. */
export function trimArcs(rec: ArcsRecord): void {
    if (rec.ties) {
        rec.ties = cappedTies(rec.ties);
        if (rec.ties.length === 0) delete rec.ties;
    }
    if (rec.phrases) {
        rec.phrases = cappedPhrases(rec.phrases);
        if (rec.phrases.length === 0) delete rec.phrases;
    }
}

// ── the export ───────────────────────────────────────────────────────────────────────────────────────────────────

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const minutesBefore = (t: number, at: number): string => Math.max(0, Math.floor((t - at) / TICKS_PER_MINUTE)).toString(36);
const strengthOf = (s: number): number => Math.max(0, Math.min(ARCS_STRENGTH_MAX, Math.floor(s)));

function encodeGoal(g: GoalRecord, t: number): string | null {
    if (!g || !GOAL_KINDS.has(g.kind) || !isInt(g.target) || g.target < 0 || !Number.isFinite(g.since) || !Number.isFinite(g.base)) return null;
    let s: string = g.kind;
    if (g.kind === 'L') {
        if (!isInt(g.stat) || g.stat < 0 || g.stat > 35) return null;
        s += g.stat.toString(36);
    }
    s += `${g.target.toString(36)}.${minutesBefore(t, g.since)}.${Math.round(g.base).toString(36)}`;
    if (isInt(g.flags) && g.flags > 0) s += `.${g.flags.toString(36)}`;
    return s;
}

interface Item {
    text: string;
    strength: number;
    last: number;
}
interface Entry {
    id: string;
    goal: string;
    since: number;
    ties: Item[];
    phrases: Item[];
    value: string;
}

function valueOf(e: Entry): string {
    const sections = [e.goal, e.ties.map(i => i.text).join(','), e.phrases.map(i => i.text).join(',')];
    while (sections.length > 0 && sections[sections.length - 1] === '') sections.pop();
    return sections.join('|');
}

/** an entry's bytes in the JSON, with its comma ("id":"value",) */
const entryBytes = (e: Entry): number => (e.value === '' ? 0 : e.id.length + e.value.length + 6);

/**
 * The section for the store (BotWorldState.arcs) at play tick `play`, or null when there is nothing to save. Within the
 * caps; over ARCS_CAPS.bytes the weakest ties go first, then phrases, then goals (the records in memory keep them).
 */
export function exportArcs(play: number): unknown | null {
    const t = Math.floor(play);
    const entries: Entry[] = [];
    for (const [name, rec] of records) {
        const id = arcsIdOf(name);
        if (id === null) continue;
        const goal = rec.goal ? encodeGoal(rec.goal, t) : null;
        const ties: Item[] = [];
        for (const tie of rec.ties ? cappedTies(rec.ties) : []) {
            const other = arcsIdOf(tie.other);
            const strength = strengthOf(tie.strength);
            if (other === null || other === id || strength < 1 || (tie.sign !== 1 && tie.sign !== -1) || !Number.isFinite(tie.last)) continue;
            ties.push({ text: `${other}${tie.sign > 0 ? '+' : '-'}${strength}@${minutesBefore(t, tie.last)}`, strength, last: tie.last });
        }
        const phrases: Item[] = [];
        for (const p of rec.phrases ? cappedPhrases(rec.phrases) : []) {
            const strength = strengthOf(p.strength);
            if (!isInt(p.phrase) || p.phrase < 0 || strength < 1 || !Number.isFinite(p.last)) continue;
            phrases.push({ text: `${p.phrase.toString(36)}${strength}@${minutesBefore(t, p.last)}`, strength, last: p.last });
        }
        const e: Entry = { id, goal: goal ?? '', since: rec.goal?.since ?? 0, ties, phrases, value: '' };
        e.value = valueOf(e);
        if (e.value !== '') entries.push(e);
    }
    const head = `{"v":${ARCS_VERSION},"t":${t},"b":{`;
    // (the JSON's size: the head, each entry with its comma (the last one's comma is the closing's "}}" less one))
    const bytes = head.length + 1 + entries.reduce((n, e) => n + entryBytes(e), 0);
    if (bytes > ARCS_CAPS.bytes) trimToCap(entries, bytes);
    const kept = entries.filter(e => e.value !== '');
    if (kept.length === 0) {
        lastBytes = 0;
        return null;
    }
    const b: Record<string, string> = {};
    for (const e of kept) b[e.id] = e.value;
    const out = { v: ARCS_VERSION, t, b };
    lastBytes = JSON.stringify(out).length;
    return out;
}

/** drops the weakest ties, then phrases, then goals, until the section's `bytes` fit */
function trimToCap(entries: Entry[], bytes: number): void {
    const drop = (e: Entry, change: () => void): void => {
        const before = entryBytes(e);
        change();
        e.value = valueOf(e);
        bytes += entryBytes(e) - before;
    };
    const weakest = (a: { item: Item }, b: { item: Item }): number => a.item.strength - b.item.strength || a.item.last - b.item.last;
    const ties = entries.flatMap(e => e.ties.map(item => ({ e, item }))).sort(weakest);
    for (const { e, item } of ties) {
        if (bytes <= ARCS_CAPS.bytes) return;
        drop(e, () => (e.ties = e.ties.filter(i => i !== item)));
    }
    const phrases = entries.flatMap(e => e.phrases.map(item => ({ e, item }))).sort(weakest);
    for (const { e, item } of phrases) {
        if (bytes <= ARCS_CAPS.bytes) return;
        drop(e, () => (e.phrases = e.phrases.filter(i => i !== item)));
    }
    for (const e of entries.filter(x => x.goal !== '').sort((a, b) => a.since - b.since)) {
        if (bytes <= ARCS_CAPS.bytes) return;
        drop(e, () => (e.goal = ''));
    }
}

/** the last export's size in bytes (its JSON; 0 when it was null): the stats, the tests */
export function arcsBytes(): number {
    return lastBytes;
}

// ── the restore ──────────────────────────────────────────────────────────────────────────────────────────────────

const B36 = /^[0-9a-z]{1,12}$/;
const B36_SIGNED = /^-?[0-9a-z]{1,12}$/;
const TIE = /^([0-9a-z]{1,4})([+-])([1-9])@([0-9a-z]{1,8})$/;
const PHRASE = /^([0-9a-z]{1,4})([1-9])@([0-9a-z]{1,8})$/;

function decodeGoal(s: string, play: number): GoalRecord | null {
    const parts = s.split('.');
    if (parts.length < 3 || parts.length > 4) return null;
    const [head, age, base, flags] = parts;
    const kind = head[0];
    if (!GOAL_KINDS.has(kind)) return null;
    let rest = head.slice(1);
    let stat: number | undefined;
    if (kind === 'L') {
        if (rest.length < 2) return null;
        stat = parseInt(rest[0], 36);
        rest = rest.slice(1);
    }
    if (!B36.test(rest) || !B36.test(age) || !B36_SIGNED.test(base) || (flags !== undefined && !B36.test(flags))) return null;
    const goal: GoalRecord = { kind: kind as GoalKind, target: parseInt(rest, 36), since: play - parseInt(age, 36) * TICKS_PER_MINUTE, base: parseInt(base, 36) };
    if (stat !== undefined) goal.stat = stat;
    if (flags !== undefined && parseInt(flags, 36) > 0) goal.flags = parseInt(flags, 36);
    return Number.isFinite(goal.target) && Number.isFinite(goal.since) && Number.isFinite(goal.base) ? goal : null;
}

/**
 * The last run's section (BotWorldState.arcs) at play tick `play`: the records again, every time relative to `play`.
 * `known`: the names the pool holds (a record of any other, and a tie to one, is dropped). Never throws; another
 * version, or a section that is not one, restores nothing; a malformed entry, tie or phrase is skipped.
 */
export function restoreArcs(raw: unknown, play: number, known: (name: string) => boolean): void {
    try {
        const section = raw as { v?: unknown; t?: unknown; b?: unknown } | null | undefined;
        if (!section || typeof section !== 'object' || section.v !== ARCS_VERSION || !isInt(section.t) || !section.b || typeof section.b !== 'object' || Array.isArray(section.b)) return;
        const isKnown = (name: string): boolean => {
            try {
                return known(name) === true;
            } catch {
                return false;
            }
        };
        const restored = new Map<string, ArcsRecord>();
        for (const [id, value] of Object.entries(section.b as Record<string, unknown>)) {
            if (typeof value !== 'string' || value.length > 400) continue;
            const name = arcsNameOf(id);
            if (name === null || !isKnown(name) || restored.has(name)) continue;
            const [goalText = '', tiesText = '', phrasesText = '', ...extra] = value.split('|');
            if (extra.length > 0) continue;
            const rec: ArcsRecord = {};
            const goal = goalText ? decodeGoal(goalText, play) : null;
            if (goal) rec.goal = goal;
            const ties: TieRecord[] = [];
            for (const part of tiesText ? tiesText.split(',') : []) {
                const m = TIE.exec(part);
                if (!m) continue;
                const other = arcsNameOf(m[1]);
                if (other === null || other === name || !isKnown(other)) continue;
                ties.push({ other, sign: m[2] === '+' ? 1 : -1, strength: Number(m[3]), last: play - parseInt(m[4], 36) * TICKS_PER_MINUTE });
            }
            if (ties.length > 0) rec.ties = ties;
            const phrases: PhraseRecord[] = [];
            for (const part of phrasesText ? phrasesText.split(',') : []) {
                const m = PHRASE.exec(part);
                if (!m) continue;
                phrases.push({ phrase: parseInt(m[1], 36), strength: Number(m[2]), last: play - parseInt(m[3], 36) * TICKS_PER_MINUTE });
            }
            if (phrases.length > 0) rec.phrases = phrases;
            trimArcs(rec);
            if (rec.goal || rec.ties || rec.phrases) restored.set(name, rec);
        }
        records.clear();
        for (const [name, rec] of restored) records.set(name, rec);
    } catch {
        // (never throws: what could not be read is not restored)
    }
}

/** (tests) forget every record */
export function resetArcsForTest(): void {
    records.clear();
    lastBytes = 0;
}
