// port (bots ideas, round 2: the arcs foundation):
// the one way themes C and D say a line, so the talk budget (the humanlike report's H7, non-trade lines a bot-hour) cannot
// be forgotten. sayArcLine(bot, pool, slots, opts):
//   - a template of `pool` (from a random start, each once) with its {slots} filled from `slots` (a template with a slot
//     left unfilled is no candidate), that the 274 word filter and the chat codec leave whole (port/BotStyle sayable), and
//     fresh (port/BotLines' registry: not one of the bot's own last 20, nor heard by the human lately, nor said in this
//     map square lately; a slot line by its template too);
//   - noted in the registry as picked, styled as the speaker types (port/BotStyle; the line as written when the styled one
//     would not survive the filter), and said: typed (port/BotChat sayTyped: its typing time after `delay`), or for
//     budget 'slot' at once (the chatter's due line: its timing was the typing);
//   - counted in the speaker's budget:
//       slot      the due line itself (the caller is port/BotChatter's due line: the level-up's line, the idle line it
//                 replaces): the chatter's own timing counts it; nothing here
//       own       port/BotChatter countAsOwnLine: the speaker's next due line is skipped (an exact substitution)
//       budgeted  countAsBudgetedLine: its next due line is pushed out (the set pieces' and the new texture's rule)
//       chatter   countAsChatter: the cliques' greeting rule (a burst of its own: its next line after a quiet)
//   - its 'said' event (port/BotArcsEvents) carries opts.arc (theme D: a rumour's id).
// A line kind of 'setpiece' or 'rumour' (port/BotSay) is out of H7 and reported in X2; the others are in H7 and must take
// a due line's place ('slot' or 'own'), or count against it ('budgeted', 'chatter').
// It returns the line as said, or null (nothing fresh and whole: silence, the moment passes).
//
// arcLines(event, kind?) is a pool: the texts of the 2004 groups (port/BotLines NEW_LINES; data/lines2004-arcs.json for C,
// lines2004-word.json for D) whose tag has that event (and kind), members' lines only on a members world. Such a group's
// event must be one no chatter event uses, so the idle picker never says its lines out of turn, and its {slots} are the
// caller's (not port/BotSlots'), filled here: test/chat-filter.test.mjs checks every one filled.
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import type { ArcTag, SaidTags } from '#/engine/bot/port/BotArcsEvents.js';
import { botPersona, sayTyped } from '#/engine/bot/port/BotChat.js';
import { countAsBudgetedLine, countAsChatter, countAsOwnLine } from '#/engine/bot/port/BotChatter.js';
import { NEW_LINES, isFresh, noteSaid } from '#/engine/bot/port/BotLines.js';
import { botSay, type LineKind } from '#/engine/bot/port/BotSay.js';
import { noteSpoke, type SpokeKind } from '#/engine/bot/port/BotSpoke.js';
import { sayable, styleLine } from '#/engine/bot/port/BotStyle.js';
import { reactionTicks } from '#/engine/bot/port/BotTiming.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';

export type ArcBudget = 'slot' | 'own' | 'budgeted' | 'chatter';
/** a template's slot values ({goal}, {left}, {nick}, {place} ...) */
export type ArcSlots = Readonly<Record<string, string | number>>;

export interface ArcLineOptions {
    /** its LineKind (port/BotSay): 'setpiece' and 'rumour' are out of H7, the rest in it */
    kind: LineKind;
    /** its place in the speaker's talk budget (above) */
    budget: ArcBudget;
    /** whom it is said to (the say listeners: a bot; never staged at the human) */
    to?: Player | null;
    /** once it is said (typed lines: when the last part is out) */
    then?: (said: string) => void;
    /** ticks before it starts typing (default: the speaker's 'notice' reaction; 'slot': none, said at once) */
    delay?: number;
    /** the speaker's style layer (default on) */
    styled?: boolean;
    /** what its 'said' event carries (port/BotArcsEvents ArcTag) */
    arc?: ArcTag;
    /** noted for port/BotSpoke once said (a human's answer finds it: 'idle', 'event', 'question' ...) */
    spoke?: SpokeKind;
    random?: () => number;
}

const SLOT = /\{([a-z][a-z0-9_]*)\}/g;

/** `template` with its {slots} from `slots`, or null when one has no value */
export function fillArcSlots(template: string, slots: ArcSlots): string | null {
    let missing = false;
    const text = template.replace(SLOT, (all, key: string) => {
        const v = slots[key];
        if (v === undefined || v === null || v === '') {
            missing = true;
            return all;
        }
        return String(v);
    });
    return missing ? null : text;
}

/** the slots in a template, each once, in order */
export function arcSlotsIn(template: string): string[] {
    const out: string[] = [];
    for (const m of template.matchAll(SLOT)) if (!out.includes(m[1])) out.push(m[1]);
    return out;
}

const pools = new Map<string, readonly string[]>();
/** The texts of the 2004 groups of `event` (and `kind`), members' lines only on a members world. */
export function arcLines(event: string, kind?: string): readonly string[] {
    const members = isMembersWorld();
    // (bots ideas, round 2: C arcs and D word: ':' between the parts, not '|': test/chat-filter.test.mjs follows a said
    // line's names through the file, and reached this key once theme C's and D's modules made the module part of the
    // bundle; a '|' does not travel in the chat codec)
    const key = `${event}:${kind ?? ''}:${members}`;
    let pool = pools.get(key);
    if (!pool) {
        pool = NEW_LINES.filter(l => l.tag.event === event && (kind === undefined || (l.tag.kinds ?? []).includes(kind)) && (members || !l.tag.members)).map(l => l.text);
        pools.set(key, pool);
    }
    return pool;
}

/** A fresh, whole line of `pool` for the bot here with `slots` filled ({ text, template }), or null. No line is said. */
export function pickArcLine(bot: Player, pool: readonly string[], slots: ArcSlots, random: () => number = Math.random): { text: string; template: string } | null {
    if (pool.length === 0) return null;
    const now = World.currentTick;
    const start = Math.floor(random() * pool.length);
    for (let i = 0; i < pool.length; i++) {
        const template = pool[(start + i) % pool.length];
        const text = fillArcSlots(template, slots);
        if (text === null || !sayable(text)) continue;
        if (!isFresh(bot.username, text, bot.x, bot.z, bot.level, now, true, text === template ? undefined : template)) continue;
        return { text, template };
    }
    return null;
}

/** The bot says a line of `pool` (above): the line as said, or null (none fresh and whole, or the bot is not in the world). */
export function sayArcLine(bot: Player, pool: readonly string[], slots: ArcSlots, opts: ArcLineOptions): string | null {
    if (bot.slot === -1 || !bot.is_bot) return null;
    const random = opts.random ?? Math.random;
    const picked = pickArcLine(bot, pool, slots, random);
    if (!picked) return null;
    const now = World.currentTick;
    const persona = botPersona(bot);
    const said = opts.styled === false ? picked.text : styleLine(picked.text, persona, random).line;
    // (the registry notes the line as picked, before its style: the key isFresh checks; a slot line's template too)
    noteSaid(bot, picked.text, now, picked.text === picked.template ? undefined : picked.template);
    if (opts.budget === 'own') countAsOwnLine(bot);
    else if (opts.budget === 'budgeted') countAsBudgetedLine(bot);
    else if (opts.budget === 'chatter') countAsChatter(bot);
    const to = opts.to ?? null;
    const tags: SaidTags | undefined = opts.arc ? { arc: opts.arc } : undefined;
    const done = (): void => {
        if (opts.spoke) noteSpoke(bot, opts.spoke, World.currentTick, to);
        opts.then?.(said);
    };
    if (opts.budget === 'slot' && !opts.delay) {
        botSay(bot, said, undefined, opts.kind, to, tags);
        done();
    } else {
        sayTyped(bot, said, { to, kind: opts.kind, then: done, tags }, opts.delay ?? reactionTicks(persona, 'notice', random));
    }
    return said;
}
