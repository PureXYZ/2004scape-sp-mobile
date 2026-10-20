// port (the realism work, phase 7: the language model): the situation a reply is written for, from the bot's real state
// (port/BotModelTypes Situation), and the prompts rendered from it: `renderLocal` for the on-device model (short: the
// fine-tuned model knows the voice, so the prompt carries the facts) and `renderOnline` for Claude (a static guide to the
// 2004 voice, cached, then the same facts). Grounding is the point: every fact a reply may use is here, from the game's
// state, and nothing else; the rules' own answer (the hint) carries the facts of a question they understood.
//
// renderLocal's text IS THE TRAINING FORMAT of the fine-tuned model: change it
// and the model is retrained (the training data keeps situations, so a retrain re-renders them: about an hour).
//
// Pure: no dice, no game effect (a sim runs the same with situations taken).
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import type Player from '#/engine/entity/Player.js';
import World from '#/engine/World.js';
import { toDisplayName } from '#/util/JString.js';
import { activityLine } from '#/engine/bot/port/BotActivity.js';
import { loginTickOf, recentEventsOf } from '#/engine/bot/port/BotChatter.js';
import { cliqueOf } from '#/engine/bot/port/BotCliques.js';
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';
import { historyFor, ownLinesOf } from '#/engine/bot/port/BotModelHistory.js';
import type { LocalPrompt, OnlinePrompt, ReplyVia, Situation, SituationLine } from '#/engine/bot/port/BotModelTypes.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { isRude } from '#/engine/bot/port/BotPersona.js';
import { placePhrase } from '#/engine/bot/port/BotPlaces.js';
import { botPersona } from '#/engine/bot/port/BotTiming.js';
import { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';

/** What situationOf needs of a reply (port/BotChat ReplyRequest's fields). */
export interface SituationRequest {
    bot: Player;
    to: Player;
    heard: string;
    channel: 'public' | 'private';
    via: ReplyVia;
    greeted: boolean;
    intent: { id: string; text: string } | null;
}

/** 274's skills by stat index, as players shortened them (18 and 19 are unused in 274) */
export const SKILL_SHORT: readonly (string | null)[] = ['att', 'def', 'str', 'hp', 'range', 'pray', 'mage', 'cook', 'wc', 'fletch', 'fish', 'fm', 'craft', 'smith', 'mine', 'herb', 'agil', 'thief', null, null, 'rc'];
/** the order the levels are listed in (combat first, as a player reads them off the skills tab) */
const SKILL_ORDER = ['att', 'str', 'def', 'hp', 'range', 'pray', 'mage', 'wc', 'fish', 'mine', 'cook', 'fm', 'smith', 'craft', 'fletch', 'rc', 'agil', 'herb', 'thief'];
const SKILL_LONG: Readonly<Record<string, string>> = {
    attack: 'att', defence: 'def', strength: 'str', hitpoints: 'hp', ranged: 'range', prayer: 'pray', magic: 'mage', cooking: 'cook', woodcutting: 'wc', fletching: 'fletch',
    fishing: 'fish', firemaking: 'fm', crafting: 'craft', smithing: 'smith', mining: 'mine', herblore: 'herb', agility: 'agil', thieving: 'thief', runecraft: 'rc', runecrafting: 'rc'
};

/** worn slots, the most visible first (weapon, body, legs, head, shield, cape, neck, feet, hands, ring, ammo) */
const WORN_ORDER = [3, 4, 7, 0, 5, 1, 2, 10, 9, 12, 13];
/** how far back a bot's events count (10 minutes) */
const EVENTS_TICKS = 1000;
/** what a noted event is, in plain words ('' leaves it out) */
const EVENT_WORDS: Readonly<Record<string, string>> = {
    death: 'died',
    'wild-death': 'died in the wild',
    'rune-drop': 'got a rune drop',
    drop: 'got a good drop',
    'big-bones': 'got big bones',
    'close-call': 'nearly died',
    hurt: 'got hurt',
    'tree-taken': 'someone took its tree',
    'tree-fell': 'its tree fell',
    'rock-stolen': 'someone took its rock',
    'full-pack': 'pack got full',
    'forgot-food': 'forgot food',
    misclick: 'misclicked',
    'out-of-arrows': 'ran out of arrows',
    'out-of-runes': 'ran out of runes',
    'clue-scroll': 'got a clue scroll',
    alch: 'alching',
    wolves: 'wolves attacked it',
    arrival: '',
    unanswered: '',
    'train-seen': '',
    'pk-team-seen': 'saw a pk team',
    'clan-seen': 'saw a clan walk by'
};

function nameOf(player: Player): string {
    return player.displayName || toDisplayName(player.username);
}

function cheb(a: Player, b: Player): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

function itemName(id: number): string | null {
    const type = ObjType.get(id);
    const name = type?.name ?? null;
    return name ? name.toLowerCase() : null;
}

function wornOf(player: Player, max: number): string[] {
    const worn = player.getInventory(InvType.WORN);
    if (!worn) return [];
    const out: string[] = [];
    for (const slot of WORN_ORDER) {
        const item = worn.get(slot);
        if (!item) continue;
        const name = itemName(item.id);
        if (name && !out.includes(name)) out.push(name);
        if (out.length >= max) break;
    }
    return out;
}

/** "12k", "1.2m": coins as players said them */
function gp(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
    if (n >= 10_000) return `${Math.round(n / 1000)}k`;
    return String(n);
}

/** the coins and the three biggest stacks it carries */
function carryingOf(player: Player): string[] {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return [];
    const counts = new Map<string, number>();
    let coins = 0;
    for (let i = 0; i < inv.capacity; i++) {
        const item = inv.get(i);
        if (!item) continue;
        const type = ObjType.get(item.id);
        const name = type?.name?.toLowerCase();
        if (!name) continue;
        if (name === 'coins') {
            coins += item.count;
            continue;
        }
        counts.set(name, (counts.get(name) ?? 0) + item.count);
    }
    const stacks = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
    const out = stacks.map(([name, n]) => (n > 1 ? `${n} ${name}` : name));
    if (coins > 0) out.push(`coins ${gp(coins)}`);
    return out;
}

function minutesAgo(now: number, tick: number): string {
    const min = Math.round(((now - tick) * 0.6) / 60);
    return min <= 0 ? 'just now' : `${min} min ago`;
}

function eventsOf(bot: Player, now: number): string[] {
    const out: string[] = [];
    for (const e of recentEventsOf(bot, now, EVENTS_TICKS)) {
        let words: string;
        if (e.name === 'levelup') {
            const skill = e.stat ? (SKILL_LONG[e.stat.toLowerCase()] ?? e.stat.toLowerCase()) : null;
            words = skill && e.level ? `levelled ${skill} to ${e.level}` : 'levelled up';
        } else if (e.name.startsWith('random-') || e.kind) {
            words = e.kind ? `had a random event (${e.kind.replace(/-/g, ' ')})` : 'had a random event';
        } else {
            words = EVENT_WORDS[e.name] ?? e.name.replace(/-/g, ' ');
        }
        if (words) out.push(`${words}, ${minutesAgo(now, e.tick)}`);
        if (out.length >= 4) break;
    }
    return out;
}

function friendsNearOf(bot: Player): string[] {
    const names = cliqueOf(bot.username) ?? [];
    const out: string[] = [];
    for (const name of names) {
        if (name === bot.username) continue;
        const p = World.getPlayerByUsername(name);
        if (p && p.slot !== -1 && p.level === bot.level && cheb(p, bot) <= 15) out.push(nameOf(p));
    }
    return out.slice(0, 4);
}

/** the rules' answer as a fact to keep: their {name} slot left out (a reply says the human's name at its own rate) */
function hintText(text: string): string {
    return text.replaceAll('{name}', '').replace(/\s+([,?!.])/g, '$1').replace(/\s{2,}/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '');
}

/**
 * The situation of a reply: the bot's state now, its last lines, the human's line and the rules' answer. `now` is the
 * tick the line came (the default: this tick). Pure.
 */
export function situationOf(req: SituationRequest, now: number = World.currentTick): Situation {
    const { bot, to: human } = req;
    const persona = botPersona(bot);
    const levels: Record<string, number> = {};
    let total = 0;
    for (let stat = 0; stat < SKILL_SHORT.length; stat++) {
        const short = SKILL_SHORT[stat];
        if (!short) continue;
        levels[short] = bot.baseLevels[stat];
        total += bot.baseLevels[stat];
    }
    const login = loginTickOf(bot);
    const distance = cheb(bot, human);
    const activity = activityLine(bot);
    return {
        v: 1,
        bot: {
            name: nameOf(bot),
            age: persona.age,
            ageBand: persona.ageBand,
            region: persona.region,
            kind: String(bot.botPlanner ?? 'random'),
            newbie: isNewbie(bot),
            voice: {
                friendliness: Math.round(persona.friendliness * 100) / 100,
                helpfulness: Math.round(persona.helpfulness * 100) / 100,
                chattiness: Math.round(persona.chattiness * 10) / 10,
                abbreviate: Math.round(persona.style.abbreviate * 100) / 100,
                rude: isRude(persona),
                meme: persona.meme
            }
        },
        world: { members: isMembersWorld() },
        facts: {
            combat: bot.combatLevel,
            total,
            levels,
            hp: [bot.levels[3], bot.baseLevels[3]],
            place: placePhrase(bot.x, bot.z),
            activity: activity ? activity.charAt(0).toLowerCase() + activity.slice(1) : null,
            worn: wornOf(bot, 8),
            carrying: carryingOf(bot),
            online: login === null ? 0 : Math.max(0, Math.round(((now - login) * 0.6) / 60)),
            wilderness: wildernessLevelAt(bot.x, bot.z),
            events: eventsOf(bot, now),
            friendsNear: friendsNearOf(bot)
        },
        human: {
            name: nameOf(human),
            combat: human.combatLevel,
            worn: wornOf(human, 4),
            distance: req.channel === 'private' && (distance > 15 || human.level !== bot.level) ? -1 : distance
        },
        history: historyFor(bot, human, req.channel, req.heard, now),
        heard: { text: req.heard, channel: req.channel, via: req.via, greeted: req.greeted },
        hint: req.intent ? { intent: req.intent.id, text: hintText(req.intent.text) } : null,
        // (phase 7, Track E: the guard's repeat check; never rendered, so renderLocal's text, the training format, is as it was)
        said: ownLinesOf(bot, now)
    };
}

// ── the prompts ─────────────────────────────────────────────────────────────────────────────────────────────────────

function voiceWords(s: Situation): string {
    const v = s.bot.voice;
    const words: string[] = [];
    words.push(v.rude ? 'rude' : v.friendliness < 0.15 ? 'blunt' : v.friendliness > 0.6 ? 'friendly' : 'chill');
    words.push(v.abbreviate >= 0.5 ? 'lots of abbreviations (u ur r plz)' : v.abbreviate >= 0.2 ? 'some abbreviations' : 'types words out');
    if (v.helpfulness >= 0.6) words.push('helpful');
    words.push(v.chattiness >= 12 ? 'chatty' : v.chattiness <= 3 ? 'quiet' : 'says a bit');
    return words.join(', ');
}

function whoWords(s: Situation): string {
    const b = s.bot;
    const kind = b.newbie ? 'a new player' : b.kind === 'extras_pker' || b.kind === 'extras_edgeville_pker' ? 'a pker' : b.kind === 'extras_vendor' ? 'a merchant' : 'a player';
    return `${kind}, ${b.age}, from ${b.region}`;
}

function levelsLine(s: Situation): string {
    const parts: string[] = [];
    for (const short of SKILL_ORDER) {
        const level = s.facts.levels[short];
        if (level !== undefined) parts.push(`${short} ${level}`);
    }
    return parts.join(' ');
}

function factsBlock(s: Situation): string {
    const f = s.facts;
    const lines: string[] = [];
    lines.push(`You: combat ${f.combat}, total ${f.total}. ${levelsLine(s)}. HP ${f.hp[0]}/${f.hp[1]}.`);
    const now = f.activity ?? (f.place ? `standing ${f.place}` : 'standing around');
    lines.push(`Now: ${now}${f.wilderness > 0 ? `, wilderness level ${f.wilderness}` : ''}. Online ${f.online} min.`);
    if (f.worn.length) lines.push(`Wearing: ${f.worn.join(', ')}.`);
    if (f.carrying.length) lines.push(`Carrying: ${f.carrying.join(', ')}.`);
    if (f.events.length) lines.push(`Lately: ${f.events.join('; ')}.`);
    if (f.friendsNear.length) lines.push(`Friends here: ${f.friendsNear.join(', ')}.`);
    const h = s.human;
    const where = h.distance < 0 ? 'messaging you privately' : h.distance <= 1 ? 'next to you' : `${h.distance} tiles away`;
    lines.push(`${h.name}: combat ${h.combat}, ${where}${h.worn.length ? `, wearing ${h.worn.join(', ')}` : ''}.`);
    return lines.join('\n');
}

function chatLine(s: Situation, line: SituationLine): string {
    return `${line.pm ? '[pm] ' : ''}${line.name}: ${line.text}`;
}

function chatBlock(s: Situation): string {
    const lines = s.history.map(line => chatLine(s, line));
    lines.push(`${s.heard.channel === 'private' ? '[pm] ' : ''}${s.human.name}: ${s.heard.text}`);
    if (s.hint) lines.push(`(answer idea: ${s.hint.text})`);
    return lines.join('\n');
}

/**
 * The on-device model's prompt (THE TRAINING FORMAT, see the header): the setting, who the bot is and how it types,
 * its facts, then the chat with the human's line last and the rules' answer as an idea.
 */
export function renderLocal(s: Situation): LocalPrompt {
    const system = [
        `RuneScape, late 2004, ${s.world.members ? 'members' : 'free'} world. You are ${s.bot.name}, ${whoWords(s)}. Reply to ${s.human.name} in one short chat line.`,
        `Voice: ${voiceWords(s)}.`,
        factsBlock(s)
    ].join('\n');
    return { system, user: chatBlock(s) };
}

/**
 * Claude's guide to the 2004 voice (the cached part of every online prompt: the same for every bot and request; above
 * the model's cacheable minimum). The bot's facts follow it as `context`.
 */
export const ONLINE_GUIDE = `You write one chat line for a player of RuneScape 2 as it was in late 2004 (the game's revision 274), on a world full of other players. You are that player, typing into the game's chat box. You are not an assistant and nobody must suspect you are anything but a person playing.

How players typed in 2004:
- Short lines: most are 1 to 8 words. Mostly lowercase. Little punctuation. No emoji: only :) :( :P :D ;) xD.
- Slang: lol, lmao, rofl, haha, k, kk, ok, ya, yea, yep, nah, nope, np, ty, thx, gz, gj, gl, brb, gtg, cya, idk, nvm, omg, wtf, noob, n00b, newb, pwned, sry, u, ur, r, y, plz, m8, cuz, wanna, gonna, lvl, cb, xp, hp, att, str, def, mage, range, pray, wc, fm, rc, f2p, p2p, members, wildy, pk, pking, skilling, training.
- Places as players said them: lumby, fally, varrock, draynor, edge, al kharid, port sarim, karamja, barb village, seers, ardy, catherby, the wildy, the duel arena.
- Money in gp, with k and m: 500gp, 15k, 1.2m.
- Many players were kids or teens from the US and the UK; some typed properly with full words, many did not.

What did not exist in late 2004 (never mention it): the Grand Exchange, Slayer, Construction, Hunter, Summoning, Dungeoneering, Old School, OSRS, RS3, Jagex accounts, the RuneScape Wiki, Discord, Twitch, YouTube, Reddit, smartphones, TikTok, chatbots, AI. Players used RuneHQ, Tip.It, Zybez, MSN, AIM, TeamSpeak and Ventrilo.

Rules for your line:
- Use only the facts given about you: your levels, where you are, what you are doing, what you wear and carry, what happened lately. If asked something those facts do not answer, answer as a player would who does not know or does not care ("idk", "no idea", "dunno", "not sure").
- When an answer idea is given, keep its facts (numbers, places, yes or no) and say them in your own way.
- Never say or hint that you are a bot, an AI, a program or a language model. If someone calls you a bot, react like an amused or annoyed player ("no lol", "wtf no", "do i look like a bot").
- Never offer or promise anything you would then have to do: trading, following, meeting somewhere, giving items or coins, teaching, going somewhere together. Only an answer idea may agree to such a thing.
- No speeches, lists, explanations or advice columns; no "I'd be happy to", "Certainly", "Great question", "feel free", "let me know".
- Swearing happens (the game's filter stars it). No slurs, no threats of real harm, no real personal details beyond your age and country.
- Match the voice you are given: rude players are curt or mocking, friendly ones warm, quiet ones terse; match the abbreviations.

Answer with the line only: no quotes, no name in front, no newline, at most 80 characters.`;

/** Claude's prompt: the guide (cached), the bot's facts, then the chat and the task. */
export function renderOnline(s: Situation): OnlinePrompt {
    const context = [
        `Setting: RuneScape, late 2004, ${s.world.members ? 'a members' : 'a free'} world. You are ${s.bot.name}, ${whoWords(s)}.`,
        `Your voice: ${voiceWords(s)}.`,
        factsBlock(s)
    ].join('\n');
    const user = `${chatBlock(s)}\n\nWrite ${s.bot.name}'s reply to ${s.human.name}: one chat line, at most 80 characters.`;
    return { system: ONLINE_GUIDE, context, user };
}
