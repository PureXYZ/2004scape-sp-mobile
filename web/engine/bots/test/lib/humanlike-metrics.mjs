// The humanlike report's measures (BOTS.md §7): how realistic the bots look and sound to a human player. test/humanlike.mjs
// runs the real 274 world as the app runs it and records it (the `record` below); this module turns a record into
// metrics, each with a target band and ✓/✗, and prints them. Pure JS (no engine, no files): test/humanlike-metrics.test.mjs
// feeds it synthetic records.
//
// Sources of the metrics and their bands (they are proposals unless marked otherwise):
//   H1-H22  the research (the research observer; H11's band is sourced: Jagex's 2008 and
//           2014 surveys, 84-90 % male players)
//   C2-C14  the research (bot-detection research turned into checks; C3's 2.7 words a line is sourced: Kwak &
//           Blackburn 2014)
//   P1, T2, M1  design decisions
//   G1      phase 3, track C ("bot friend cliques"): report only; its proposed band 5-20 % comes from
//           Jagex's 2004 polls (51 % played alone, 21 % with a few others, 9 % in clans: the research)
//   L1      phase 4, track A ("rares and veterans"): report only (the default: "one or two rich bots at
//           Varrock or Falador" at 100 online, about 1 bot in 60 in a rare, 1 veteran in 4 in bunny ears or a scythe)
//   E1, E2  phase 4, track B (December 2004 street prices):
//           E1's window 0.67-1.5× of the street table (data/street_prices.json: the research), E2's target 10 %
//   F1, F3, D1-D4, R1-R4  phase 5a, track F ("fallible bots" and "2004 rudeness"
//           (5a), proposed bands; a count under 5 is reported, not judged: the spec's "where a count is under 5")
// Basis per row: 'sourced' (a measured human reference), 'decided', 'proposed' (a research
// proposal), 'report' (shown, never judged).
//
// Line kinds. A line's kind comes, in this order, from: an explicit kind the library passes to its say listeners (a
// third argument `{ kind, to }` or a kind string: the chat engine of later phases), BotPlayer._say's own (idle,
// newbie, levelup: the runner wraps it), BotChat's reply counter (a public answer to the human: 'reply'), the line's
// text (upstream's "Alright, I'm off for now." is 'goodbye'), and last the speaker's task or planner (vendors and
// bankstanders 'trade', social bots 'social', PKers 'pk', anything else 'other'). Groups (kindGroup): trade, reply,
// levelup, pk, social, and 'chatter' for idle, newbie, other and any kind not listed here (a new kind of unprompted
// line). A new kind that is trade or an answer to the human goes into TRADE_KINDS / REPLY_KINDS.

export const TICKS_PER_MINUTE = 100;
export const TICKS_PER_HOUR = 6000;
export const TICK_SECONDS = 0.6;
/** 274 lists the players within 15 tiles (Chebyshev) of the player */
export const VIEW = 15;

// ---- places ----

/** Places a human would stand (level 0), the research observer's 34; `hotspot`: H1's 2004 hotspots; `members`: members-only */
export const HUBS = [
    ['lumbridge_courtyard', 3222, 3218, 'h'], ['lumbridge_castle', 3208, 3220], ['lumbridge_spawn_road', 3180, 3240],
    ['lumbridge_chickens', 3237, 3295, 'h'], ['lumbridge_cows', 3255, 3276, 'h'], ['lumbridge_goblins', 3258, 3236],
    ['lumbridge_swamp', 3200, 3170],
    ['varrock_west_bank', 3185, 3441, 'h'], ['varrock_west_road', 3183, 3428], ['varrock_square', 3212, 3428, 'h'],
    ['varrock_east_bank', 3253, 3420, 'h'], ['varrock_east_mine', 3285, 3365], ['varrock_west_mine', 3177, 3368],
    ['falador_park', 2997, 3375, 'h'], ['falador_west_bank', 2946, 3368, 'h'], ['falador_east_bank', 3013, 3355, 'h'],
    ['draynor_bank', 3092, 3245, 'h'], ['draynor_willows', 3086, 3234], ['draynor_market', 3080, 3250],
    ['edgeville_bank', 3093, 3491], ['wilderness_ditch', 3094, 3524], ['barbarian_village', 3082, 3420, 'h'],
    ['al_kharid_bank', 3269, 3167], ['al_kharid_mine', 3299, 3295, 'h'], ['al_kharid_gate', 3268, 3227],
    ['port_sarim', 3028, 3220], ['karamja_musa', 2924, 3173], ['rimmington', 2957, 3215],
    ['catherby', 2820, 3436, 'hm'], ['seers_bank', 2725, 3490, 'hm'], ['ardougne_market', 2662, 3305, 'hm'],
    ['ardougne_south_bank', 2655, 3283, 'm'], ['ardougne_north_bank', 2615, 3332, 'm'], ['taverley', 2895, 3445, 'm']
].map(([key, x, z, flags = '']) => ({ key, x, z, level: 0, hotspot: flags.includes('h'), members: flags.includes('m') }));

/** The places of a world (members-only ones on a members world only). */
export function hubsFor(members) {
    return HUBS.filter(h => members || !h.members);
}

/** Where the touring human stands, in order (never the Wilderness: it would be hunted); the research observer's tour */
export function tourStops(members) {
    return ['varrock_west_road', 'lumbridge_courtyard', 'varrock_square', 'falador_park', 'draynor_bank', 'edgeville_bank', 'al_kharid_bank', 'lumbridge_cows', 'barbarian_village', 'varrock_west_bank', 'falador_east_bank', 'port_sarim', ...(members ? ['catherby', 'seers_bank', 'ardougne_market'] : ['varrock_east_bank', 'al_kharid_mine', 'draynor_willows'])];
}

/** Lumbridge's castle, fields, swamp and cows (as test/sim.mjs counts them), level 0: P1's newbies */
export const LUMBRIDGE_AREA = { x0: 3140, x1: 3270, z0: 3140, z1: 3300 };
export function inLumbridge(x, z, level) {
    return level === 0 && x >= LUMBRIDGE_AREA.x0 && x <= LUMBRIDGE_AREA.x1 && z >= LUMBRIDGE_AREA.z0 && z <= LUMBRIDGE_AREA.z1;
}

export const LEVELLING = new Set(['skiller', 'fighter', 'balanced', 'random']);
/** the task kinds of a fight (a death there is no surprise) */
export const FIGHT_KINDS = new Set(['Combat', 'RangedMagic', 'PKer', 'EdgevillePKer', 'ComeHere']);
/** the task states of a stop at a bank (H18b), as the tasks name them */
export const BANK_STATES = new Set(['bank', 'banking', 'bank_done', 'bank_deposit', 'deposit', 'withdraw', 'coins_withdraw']);

// ---- line kinds ----

export const TRADE_KINDS = new Set(['trade', 'advert', 'market']);
/**
 * (realism phase 5b: set pieces) a set piece's own lines, word of mouth about one, a scam caller's calls, the player-mod
 * bot's duty lines (port/BotSay's LineKinds): kept out of the chatter measures (H6, H7, C2, C3, C6, ...) as trade is, and
 * reported on their own (X2)
 */
export const SETPIECE_KINDS = new Set(['setpiece', 'rumour', 'scam', 'mod']);
export const REPLY_KINDS = new Set(['reply', 'goodbye', 'answer']);
/** upstream's line for a conversation's end and a session that ends mid-conversation (BotChat ENDING) */
export const ENDING_LINE = "Alright, I'm off for now.";

/** trade | reply | levelup | pk | social | chatter */
export function kindGroup(kind) {
    if (TRADE_KINDS.has(kind)) return 'trade';
    if (SETPIECE_KINDS.has(kind)) return 'setpiece';
    if (REPLY_KINDS.has(kind)) return 'reply';
    if (kind === 'levelup' || kind === 'pk' || kind === 'social') return kind;
    return 'chatter';
}
export const isTrade = line => TRADE_KINDS.has(line.kind);
/** trade or a set piece's line: out of the chatter measures */
export const isAside = line => TRADE_KINDS.has(line.kind) || SETPIECE_KINDS.has(line.kind);

/**
 * A line's kind (see the header): `explicit` from the library, `tag` from BotPlayer._say, `reply` from BotChat's reply
 * counter, then the text, the task kind and the planner.
 */
export function lineKind({ explicit = null, tag = null, reply = false, text = '', task = 'none', planner = '' }) {
    if (explicit) return explicit;
    if (tag) return tag;
    if (text === ENDING_LINE) return 'goodbye';
    if (reply) return 'reply';
    if (task === 'Vendor' || task === 'Bankstand') return 'trade';
    if (task === 'Social') return 'social';
    if (task === 'PKer' || task === 'EdgevillePKer') return 'pk';
    if (task === 'none' || task === 'Init' || task === 'Idle') {
        if (planner === 'extras_vendor') return 'trade';
        if (planner === 'extras_social') return 'social';
        if (planner === 'extras_pker' || planner === 'extras_edgeville_pker') return 'pk';
    }
    return 'other';
}

// ---- text ----

// WordPack's characters (274 shows any other as a space), 80 at most, in its sentence case (WordPack.toSentenceCase)
const CHARSET = new Set([...' etaoihnsrdlumwcyfgpbvkxjqz0123456789!?.,:;()-&*\\\'@#+=£$%"[]']);
/** A line as the 274 client shows it. */
export function displayed(line) {
    const chars = [...String(line).slice(0, 80).toLowerCase()].map(c => (CHARSET.has(c) ? c : ' '));
    let punct = true;
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (punct && c >= 'a' && c <= 'z') {
            chars[i] = c.toUpperCase();
            punct = false;
        }
        if (c === '.' || c === '!') punct = true;
    }
    return chars.join('');
}

/** The words of a line (tokens with a letter or digit). */
export function words(text) {
    return String(text).split(/\s+/).filter(w => /[a-z0-9]/i.test(w));
}

/** lower case, letters, digits, stars and single spaces: the same line however it is punctuated */
export function normalized(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9*]+/g, ' ').trim();
}

export function isQuestion(text) {
    return text.includes('?') || /^(how|where|what|whats|who|why|when|which|anyone|any1|does anyone|is there|can (i|you|u|some|any))\b/i.test(text.trim());
}

/** "how do I / where is" questions (the research observer's list): a newbie's, odd from a veteran */
export const NEWBIE_QUESTION = /^(how do i|how do you|where do i|where can i|where is|where are|how can|what is|whats the best|should i|is there|is this game free|how do i get)/i;

/** a line announcing that the speaker leaves (logs out) now, not later ("gtg in 30 minutes") or for a moment ("gotta go afk") */
export const DEPARTURE = /\b(gtg|g2g|gotta go|got to go|have to go|need to go|need to log off|going to leave|logging out|logging off|log off|time for a break|night all|gn all|cya all|bye all|off for now|cya|bye|good ?night|gn)\b/i;
const NOT_DEPARTURE = /\b(gotta go|gtg|g2g|got to go|have to go|need to go) (to|in|get|afk)\b|\bin \d+ ?min|before logging|break a leg|see you in|taken a break/i;
export function isDeparture(text) {
    return DEPARTURE.test(text) && !NOT_DEPARTURE.test(text);
}
/** a line announcing a short break ("brb", "afk 5 min", "gotta go get food") */
export const BRB = /\b(brb|afk|be right back|bbl|gotta go get|gotta go afk)\b/i;

export const GZ = /\b(gz|gratz|grats|congrats|congratz|congratulations|gj|nice one|well done)\b/i;

/** lines anybody says alike; the same one from two bots in an area is no tell (C6) */
export const REFLEX_LINES = new Set(['gz', 'gratz', 'grats', 'gj', 'ty', 'thx', 'thanks', 'np', 'lol', 'lmao', 'haha', 'hah', 'hi', 'hey', 'hello', 'yo', 'sup', 'bye', 'cya', 'gl', 'gf', 'ok', 'k', 'kk', 'yes', 'no', 'ya', 'yeah', 'nice', 'brb', 'afk', 'wow', '']);

/**
 * Meta and post-2004 keywords (H22, report only: upstream's flavour is kept; they are gated, not rewritten): the
 * research observer's list, unchanged.
 */
export const META = /discord|osrs|2004 ?scape|poggers|\bpog\b|\bcope\b|seethe|rizz|gyatt|mewing|skibid|\bbased\b|vibe check|drip check|yoinky|stick ?bug|json|\bhdr\b|halo 5|vanguard|dougie|cat daddy|warranty|nightmare ?zone|fire cape|recipe for disaster|farming|\bge\b|grand exchange|bandos|kalphite|wise old man|lootshare|ironm[ae]n|sentient|k-andy|attackishere|\bsams\b|kingcobra|ra ra rasputin|never gonna|zoomies|thigh high|discord kitten|world of warcraft|stormwind|goldshire|wrath|star wars|american horror|microsoft points|\blowkey\b|\bngl\b|\bayo\b|bruh|\blit\b|\bfr\b|tilted|dongus|bloatscap|let us get this bread|\bstan\b|\bsus\b|\byeet\b|\belf\b|enjoy the respawn|private server|exp rate|vote|announc|youtube|subscribe|clan chat|::scripts/i;
/** 2004 shorthand (lol, u, ur, plz, gz, lvl...): information */
export const SLANG2004 = /\b(lol|u|ur|r|plz|pls|k|kk|gz|gl|ty|thx|np|brb|afk|noob|n00b|newb|lvl|xp|wc|rofl|lmao|omg|wtf|ppl|sry|srry|cya|gtg|g2g|m8|wanna|gonna|ftw|pk|wildy|lumby|fally|ardy|dds|whip)\b/i;

/**
 * Skill words (H8), word-bounded (the research's matched inside words: "ore" in "more", "axe" in "pickaxe"), by the
 * task kind they belong to.
 */
export const SKILL_WORDS = {
    Woodcut: /\bwoodcut\w*|\bchop\w*|\boaks?\b|\bwillows?\b|\byews?\b|\bmaples?\b|\blogs?\b|\btimber\b|\baxe\b|\bwc\b/i,
    Mine: /\bmin(e|es|ing|er|ers)\b|\bores?\b|\brocks?\b|\bcoal\b|\bpickaxe\b|\bessence\b|\bess\b/i,
    Fish: /\bfish\w*|\blobsters?\b|\blobs\b|\bsharks?\b|\bshrimps?\b|\btrout\b|\bsalmon\b|\bswordfish\b|\bharpoon\b/i,
    Combat: /\bkill\w*|\battack\w*|\bfight\w*|\bcombat\b|\bstr\b|\bstrength\b|\bcb\b/i,
    Cook: /\bcook\w*/i,
    Smith: /\bsmith\w*|\banvil\b|\bfurnace\b|\bbars?\b|\bsmelt\w*/i,
    Thieve: /\bthiev\w*|\bpickpocket\w*|\bstalls?\b/i,
    Agility: /\bagility\b|\bagil\b/i,
    Firemaking: /\bfiremak\w*|\bfires?\b|\bfm\b/i,
    Fletching: /\bfletch\w*|\bbows?\b|\bshortbows?\b|\blongbows?\b/i,
    Crafting: /\bcraft\w*|\bspin\w*|\bwool\b|\bleather\b/i,
    Runecrafting: /\brunecraft\w*|\brc\b/i,
    Herblore: /\bherb\w*/i
};
/** a task whose talk may name another skill's words and still fit (a firemaker's logs, a cook's lobsters) */
const ALSO_FITS = {
    Fletching: ['Woodcut'], BowStringing: ['Fletching', 'Crafting'], Firemaking: ['Woodcut'], Cook: ['Fish'], Smith: ['Mine'],
    Runecrafting: ['Mine'], RangedMagic: ['Combat'], PKer: ['Combat'], EdgevillePKer: ['Combat'], Newbie: ['Combat'], 'Pick Flax': ['Crafting']
};
/** Place names (H8): where, and how near a speaker must be (the radius × 1.5, as the research observer's) */
export const PLACES = [
    ['Lumbridge', /\blumbridge\b|\blumby\b/i, 3222, 3218, 40], ['Varrock', /\bvarrock\b/i, 3213, 3428, 50], ['Falador', /\bfalador\b|\bfally\b/i, 2985, 3365, 50],
    ['Draynor', /\bdraynor\b/i, 3093, 3250, 35], ['Edgeville', /\bedgeville\b/i, 3093, 3493, 30], ['Al Kharid', /\bal ?kharid\b|\bkharid\b/i, 3293, 3190, 40],
    ['Karamja', /\bkaramja\b|\bmusa point\b/i, 2900, 3160, 70], ['Port Sarim', /\bport sarim\b|\bsarim\b/i, 3030, 3220, 25], ['Catherby', /\bcatherby\b/i, 2809, 3436, 30],
    ['Seers', /\bseers\b/i, 2720, 3480, 30], ['Ardougne', /\bardougne\b|\bardy\b/i, 2662, 3305, 50], ['Yanille', /\byanille\b/i, 2560, 3090, 30],
    ['Camelot', /\bcamelot\b/i, 2757, 3500, 25], ['Taverley', /\btaverl[e]?y\b/i, 2900, 3440, 25], ['Barbarian Village', /\bbarbarian village\b|\bbarb village\b/i, 3082, 3420, 20],
    ['Rimmington', /\brimmington\b/i, 2957, 3215, 25]
];

/** Does an idle line fit its speaker? { skill: null | true | false, place: null | true | false } */
export function contextFit(text, task, x, z, level) {
    const hits = Object.keys(SKILL_WORDS).filter(k => SKILL_WORDS[k].test(text));
    let skill = null;
    if (hits.length) skill = hits.includes(task) || (ALSO_FITS[task] ?? []).some(k => hits.includes(k));
    let place = null;
    for (const [, rx, px, pz, r] of PLACES) {
        if (!rx.test(text)) continue;
        place = level === 0 && Math.max(Math.abs(x - px), Math.abs(z - pz)) <= r * 1.5;
        break;
    }
    return { skill, place };
}

const SKILL_TOKENS = /^(attack|atk|att|defence|defense|def|strength|str|hitpoints|hp|ranged|range|ranging|prayer|pray|magic|mage|cooking|cook|woodcutting|woodcut|wc|fletching|fletch|fishing|fish|firemaking|fm|crafting|craft|smithing|smith|mining|mine|herblore|herb|agility|agil|agi|thieving|thief|thieve|runecraft|runecrafting|rc|combat|cb|total|overall)$/;
/**
 * A level-up line's shape (H10): skill words become S, numbers N, a run of other words P, a dash stays, other
 * punctuation goes. Upstream's "Finally! - firemaking 17" and "Been waiting for this - woodcutting 20" are both "P - S N".
 */
export function levelupShape(text) {
    const out = [];
    for (const raw of String(text).toLowerCase().replace(/[^a-z0-9\- ]+/g, ' ').split(/\s+/)) {
        if (!raw) continue;
        const token = /^-+$/.test(raw) ? '-' : SKILL_TOKENS.test(raw) ? 'S' : /^\d+$/.test(raw) ? 'N' : /[a-z0-9]/.test(raw) ? 'P' : null;
        if (token === null || (token === 'P' && out.at(-1) === 'P')) continue;
        out.push(token);
    }
    return out.join(' ');
}

const GREETING_WORDS = new Set(['hello', 'hi', 'hey', 'heya', 'hiya', 'yo', 'yoyo', 'yoo', 'sup', 'wassup', 'wazzup', 'whats', 'what', 'up', 'yes', 'yeah', 'yea', 'ya', 'yep', 'oh', 'there', 'mate', 'alright', 'hows', 'how', 'it', 'going', 'do', 'you', 'u', 'need', 'greetings', 'wagwan', 'howdy', 'is', 'are', 'doing', 'can', 'i', 'help']);
/** Is a reply only a greeting ("Yes sim human?", "Hey mate, what's up?"), answering nothing? (H15) */
export function isGreetingOnly(text, humanName) {
    let t = String(text).toLowerCase();
    for (const n of nameForms(humanName)) t = t.split(n).join(' ');
    t = t.replace(/[:;]-?[)(dpo3]/g, ' ').replace(/'/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    return t.split(' ').every(w => w === '' || GREETING_WORDS.has(w));
}
const HELLO_WORDS = new Set(['hi', 'hey', 'hello', 'heya', 'hiya', 'yo', 'sup', 'wassup', 'wazzup', 'howdy', 'greetings', 'all', 'everyone', 'every1', 'guys', 'ppl', 'people', 'there']);
/** Is the human's line only a hello (to all, or to the bot it names)? A greeting is the right answer to it then (H15). */
export function isHello(text, botName = '') {
    let t = String(text).toLowerCase();
    for (const n of nameForms(botName)) t = t.split(n).join(' ');
    t = t.replace(/[^a-z0-9]+/g, ' ').trim();
    return t !== '' && t.split(' ').every(w => HELLO_WORDS.has(w));
}
function nameForms(name) {
    const n = String(name).toLowerCase();
    return [...new Set([n, n.replaceAll(' ', '_'), n.replaceAll('_', ' ')])].filter(Boolean);
}
/** Does a line contain the human's name? (H14) */
export function namesPlayer(text, name) {
    const t = String(text).toLowerCase();
    return nameForms(name).some(n => t.includes(n));
}

// ---- statistics ----

export function quantile(xs, q) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
export function median(xs) {
    return quantile(xs, 0.5);
}
export function mean(xs) {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
/** coefficient of variation (population standard deviation ÷ mean) */
export function cv(xs) {
    const m = mean(xs);
    if (!m) return null;
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
    return Math.sqrt(v) / m;
}
/** a share in percent, one decimal (null when there is nothing to share) */
export function pct(a, b) {
    return b ? Math.round((1000 * a) / b) / 10 : null;
}
const round = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// ---- the metrics ----
// Each takes the record (test/humanlike.mjs's, or a test's) and returns { value, shown?, ok?, detail?, data? }; value
// null = not measured in this run (no ✓ or ✗).

/** H1's band: at most 40 % of samples empty at 100 bots, 10 % at 500 (observe §5), log-interpolated between; 40 below 100 */
export function hotspotEmptyMax(bots) {
    if (bots <= 100) return 40;
    if (bots >= 500) return 10;
    return Math.round(40 - (30 * Math.log(bots / 100)) / Math.log(5));
}

function hotspotRows(r) {
    return hubsFor(r.meta.members)
        .filter(h => h.hotspot && r.hubs[h.key]?.samples)
        .map(h => {
            const a = r.hubs[h.key];
            return { key: h.key, empty: pct(a.empty, a.samples), avg: a.bots / a.samples };
        });
}

export function emptyHotspots(r) {
    const rows = hotspotRows(r);
    if (!rows.length) return { value: null };
    const worst = rows.reduce((a, b) => (b.empty > a.empty ? b : a));
    const band = hotspotEmptyMax(r.meta.bots);
    return {
        value: worst.empty,
        shown: `${worst.empty} % ${worst.key}`,
        detail: `${rows.filter(x => x.empty > band).length} of ${rows.length} over ${band} %: ${[...rows].sort((a, b) => b.empty - a.empty).map(x => `${x.key} ${Math.round(x.empty)}`).join(', ')}`,
        data: Object.fromEntries(rows.map(x => [x.key, x.empty]))
    };
}

export function crowdBalance(r) {
    const rows = hotspotRows(r);
    if (rows.length < 2) return { value: null };
    const busiest = rows.reduce((a, b) => (b.avg > a.avg ? b : a));
    const mid = median(rows.map(x => x.avg));
    return {
        value: round(busiest.avg / Math.max(mid, 0.1), 2),
        detail: `${busiest.key} ${round(busiest.avg)} in view on average; the median hotspot ${round(mid, 2)} (floored at 0.1)`
    };
}

/**
 * H3 judges a hub's crowds: the samples with at least this many bots in view. The tell it was made for is a mob of social
 * bots (Lumbridge's courtyard at 500 bots: 82 % of 12-19 in view); since phase 3 a hub's social regular may stand alone in
 * a quiet park ("social bots as regulars", one at least a hub), 100 % of one bot, which is no mob. Records
 * from before (no crowd counts) are judged on all their samples.
 */
export const MOB_MIN = 3;

export function socialShareInView(r) {
    const crowd = a => (a.crowdBots === undefined ? { bots: a.bots, social: a.social } : { bots: a.crowdBots, social: a.crowdSocial });
    const rows = hubsFor(r.meta.members)
        .map(h => ({ key: h.key, a: r.hubs[h.key] }))
        .filter(x => x.a && crowd(x.a).bots >= 100)
        .map(x => ({ key: x.key, share: pct(crowd(x.a).social, crowd(x.a).bots), all: pct(x.a.social, x.a.bots) }));
    if (!rows.length) return { value: null };
    rows.sort((a, b) => b.share - a.share);
    const allWorst = hubsFor(r.meta.members)
        .map(h => ({ key: h.key, a: r.hubs[h.key] }))
        .filter(x => x.a && x.a.bots >= 100)
        .map(x => ({ key: x.key, share: pct(x.a.social, x.a.bots) }))
        .sort((a, b) => b.share - a.share)[0];
    const mobs = r.hubs[rows[0].key]?.crowdBots !== undefined;
    return {
        value: rows[0].share,
        shown: `${rows[0].share} % ${rows[0].key}`,
        detail: `${mobs ? `with ${MOB_MIN}+ bots in view: ` : ''}${rows.slice(0, 4).map(x => `${x.key} ${x.share}`).join(', ')}${mobs && allWorst ? `; over all samples the worst ${allWorst.key} ${allWorst.share}` : ''}`
    };
}

export function idleStacking(r) {
    const s = r.stacks;
    if (!s?.botSamples) return { value: null };
    const top = Object.entries(s.byState ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return { value: pct(s.idleStacked, s.botSamples), detail: `${s.idleStacked} of ${s.botSamples} bot-samples${top.length ? `; ${top.map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}` };
}

// ---- phase 3, track C (social life): G1 ----

/** G1's proposed band (the 2004 polls: about 3 players in 10 played with others; less of their time): shown, not judged yet */
export const G1_PROPOSED = { min: 5, max: 20 };

/**
 * G1: the share of levelling bot-time spent within 3 tiles of a clique-mate (port/BotCliques) for 30 s or more (runs of
 * 10+ samples), of all levelling bot-time; the detail: the cliques' share of that time, a mate online, near one at all.
 */
export function cliqueTogether(r) {
    const g = r.groups;
    if (!g?.levelling) return { value: null };
    return {
        value: pct(g.near30, g.levelling),
        detail: `${g.near30} of ${g.levelling} levelling bot-samples near a clique-mate in runs of 30 s+ (proposed band ${G1_PROPOSED.min}-${G1_PROPOSED.max} %); clique members ${pct(g.clique, g.levelling)} % of the time, a mate online ${pct(g.mateOnline, g.clique) ?? '-'} % of theirs, within 3 tiles of one ${pct(g.nearAny, g.clique) ?? '-'} %, within 15 ${pct(g.inView ?? 0, g.clique) ?? '-'} %; logins of clique members with a mate online ${g.logins ? `${pct(g.loginsWithMate, g.logins)} % of ${g.logins}` : '-'}`,
        data: { ...g }
    };
}

export function popIn(r) {
    const at = r.popin?.at ?? {};
    if (at[100] === undefined || at[5] === undefined) return { value: null };
    if (!at[100]) return { value: null, detail: 'nobody in view 100 ticks after the login' };
    // (since the realism work's phase 3: of the t100 crowd, the bots that logged in within 15 tiles after t5, popped in;
    // the others were in the world by then and walked into view)
    const popped = r.popin?.popped;
    return { value: pct(at[5], at[100]), detail: `bots within 15 tiles after the login: ${Object.entries(at).map(([t, n]) => `t${t} ${n}`).join(', ')}${popped !== undefined ? `; of the ${at[100]} at t100, ${popped} logged in within 15 tiles after t5 (popped in), the rest walked in` : ''}` };
}

/** non-trade lines by session id, in order */
function nonTradeBySession(r) {
    const by = new Map();
    for (const l of r.lines) {
        if (isAside(l)) continue;
        let list = by.get(l.s);
        if (!list) by.set(l.s, (list = []));
        list.push(l.t);
    }
    return by;
}

export function quietShare(r) {
    const by = nonTradeBySession(r);
    let windows = 0;
    let quiet = 0;
    for (const s of r.sessions) {
        if (s.planner === 'extras_vendor') continue;
        const ticks = by.get(s.s) ?? [];
        let i = 0;
        for (let w = s.first; w + 1000 <= s.last + 1; w += 1000) {
            while (i < ticks.length && ticks[i] < w) i++;
            windows++;
            if (i >= ticks.length || ticks[i] >= w + 1000) quiet++;
        }
    }
    if (!windows) return { value: null };
    return { value: pct(quiet, windows), detail: `${quiet} of ${windows} ten-minute windows of non-vendor bots without a non-trade line` };
}

export function linesPerBotHour(r) {
    const hours = r.botTicks / TICKS_PER_HOUR;
    if (!hours) return { value: null };
    const nonTrade = r.lines.filter(l => !isAside(l));
    // per session (10+ minutes online): its non-trade lines an hour
    const by = nonTradeBySession(r);
    const rates = r.sessions.filter(s => s.last - s.first + 1 >= 1000).map(s => ((by.get(s.s)?.length ?? 0) * TICKS_PER_HOUR) / (s.last - s.first + 1));
    const kinds = {};
    for (const l of r.lines) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
    return {
        value: round(nonTrade.length / hours),
        detail: `${nonTrade.length} non-trade of ${r.lines.length} lines in ${round(hours)} bot-hours; per bot p10/p50/p90 ${rates.length ? [0.1, 0.5, 0.9].map(q => round(quantile(rates, q))).join('/') : '-'}, silent ${pct(rates.filter(x => x === 0).length, rates.length) ?? '-'} %; kinds ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${pct(n, r.lines.length)}`).join(', ')} %`,
        data: { lines: r.lines.length, nonTrade: nonTrade.length, botHours: round(hours, 2), kinds }
    };
}

/** H8 judges idle statements: a question about a place or a skill fits anywhere ("how do i get to ardougne?"; H8b judges
 * who asks), and a newbie's lines are its own pool (port/BotNewbie) */
export function contextFitShare(r) {
    let skill = 0, skillFit = 0, place = 0, placeFit = 0;
    for (const l of r.lines) {
        if (kindGroup(l.kind) !== 'chatter' || l.kind === 'newbie' || isQuestion(l.text)) continue;
        const f = contextFit(l.text, l.task, l.x, l.z, l.level);
        if (f.skill !== null) {
            skill++;
            if (f.skill) skillFit++;
        }
        if (f.place !== null) {
            place++;
            if (f.place) placeFit++;
        }
    }
    if (!skill && !place) return { value: null };
    return { value: pct(skillFit + placeFit, skill + place), detail: `skill words fit the speaker's task in ${skillFit} of ${skill}, places are where it is in ${placeFit} of ${place} (idle statements)` };
}

export function veteranNewbieQuestions(r) {
    const asked = r.lines.filter(l => kindGroup(l.kind) === 'chatter' && NEWBIE_QUESTION.test(l.text.trim()));
    if (!asked.length) return { value: null };
    const vets = asked.filter(l => l.cb >= 40);
    return { value: pct(vets.length, asked.length), detail: `${vets.length} of ${asked.length} "how do i / where is" questions from combat 40+${vets.length ? `, e.g. cb ${vets[0].cb} ${vets[0].task}: "${vets[0].shown}"` : ''}` };
}

/** the lines of the window (t, t + ticks] after line i, within `distance` tiles of it on its level, by another bot */
function* linesAfter(lines, i, ticks, distance) {
    const q = lines[i];
    for (let j = i + 1; j < lines.length && lines[j].t <= q.t + ticks; j++) {
        const l = lines[j];
        if (l.t <= q.t || l.name === q.name || l.level !== q.level || Math.max(Math.abs(l.x - q.x), Math.abs(l.z - q.z)) > distance) continue;
        yield l;
    }
}

export function answeredBotQuestions(r) {
    const end = r.meta.ticks - 50;
    let asked = 0;
    let answered = 0;
    let adjacent = 0;
    let chatter = 0;
    let inThread = 0;
    r.lines.forEach((q, i) => {
        if (kindGroup(q.kind) !== 'chatter' || q.t > end) return;
        chatter++;
        let any = false;
        let answer = false;
        const named = q.display ? new RegExp(`\\b${q.display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
        for (const l of linesAfter(r.lines, i, 50, VIEW)) {
            if (isAside(l)) continue;
            if (l.t <= q.t + 10) any = true;
            if (l.toName === q.name || named?.test(l.text)) answer = true;
        }
        if (any) adjacent++;
        if (!isQuestion(q.text) || q.to === 'human') return;
        // (the variety work, round 2, the integrator's: a question inside a conversation, a thread's or a practice's turn
        // (kind 'practice'), is answered by its partner by design; H9 is the questions put to the crowd)
        if (q.kind === 'practice') {
            inThread++;
            return;
        }
        asked++;
        if (answer) answered++;
    });
    if (!asked) return { value: null };
    return { value: pct(answered, asked), detail: `${answered} of ${asked} bots' questions got a line to the asker from another bot within 30 s (${inThread} more inside conversations, out); any other bot's line within 6 s and 15 tiles after ${pct(adjacent, chatter)} % of chatter` };
}

export function levelupTemplate(r) {
    const ups = r.lines.filter(l => l.kind === 'levelup');
    if (!ups.length) return { value: null };
    const shapes = new Map();
    for (const l of ups) {
        const s = levelupShape(l.text);
        shapes.set(s, (shapes.get(s) ?? 0) + 1);
    }
    const [top, n] = [...shapes].sort((a, b) => b[1] - a[1])[0];
    return { value: pct(n, ups.length), detail: `${n} of ${ups.length} level-up lines are "${top}"; ${shapes.size} shape(s)` };
}

export function femaleShare(r) {
    if (!r.looks.length) return { value: null };
    const f = r.looks.filter(l => l.gender === 1).length;
    return { value: pct(f, r.looks.length), detail: `${f} of ${r.looks.length} bots seen` };
}

const TIERS = ['bronze', 'iron', 'steel', 'black', 'mithril', 'adamant', 'rune', 'dragon'];
export function tierOf(name) {
    if (!name) return null;
    return TIERS.find(t => name.startsWith(`${t}_`)) ?? null;
}
// worn slots (274): 0 head, 1 cape, 2 neck, 3 weapon, 4 body, 5 shield, 7 legs, 9 hands, 10 feet, 12 ring, 13 ammo
const SET_SLOTS = [0, 4, 5, 7];
const ACCESSORY_SLOTS = [1, 2, 9, 10];

export function matchingSets(r) {
    const mid = r.looks.filter(l => l.cb >= 11 && l.cb <= 60);
    if (!mid.length) return { value: null };
    let full = 0;
    let matching = 0;
    for (const l of mid) {
        const names = SET_SLOTS.map(s => l.worn[s] ?? null);
        if (names.every(Boolean)) {
            full++;
            const tiers = new Set(names.map(tierOf));
            if (tiers.size === 1 && !tiers.has(null)) matching++;
        }
    }
    return { value: pct(matching, mid.length), detail: `${matching} of ${mid.length} bots of combat 11-60 in a helm, body, legs and shield of one metal (${pct(full, mid.length)} % wear all four)` };
}

export function accessories(r) {
    const vets = r.looks.filter(l => LEVELLING.has(l.planner) && l.cb >= 30);
    if (!vets.length) return { value: null };
    const n = vets.filter(l => ACCESSORY_SLOTS.some(s => l.worn[s])).length;
    return { value: pct(n, vets.length), detail: `${n} of ${vets.length} levelling bots of combat 30+ wear a cape, amulet, gloves or boots` };
}

// ---- (realism phase 4, track A: looks) ----
/** the rares (partyhats, the santa hat, the Halloween masks) and the 2003 holiday items (bunny ears, scythe): 274's debugnames */
export const RARE_NAMES = ['red_partyhat', 'yellow_partyhat', 'blue_partyhat', 'green_partyhat', 'purple_partyhat', 'white_partyhat', 'santa_hat', 'halloweenmask_green', 'halloweenmask_blue', 'halloweenmask_red'];
export const HOLIDAY_NAMES = ['bunnyears', 'scythe'];
/** a bot wearing one is counted again at the same hub after this long unseen there (ticks: 10 minutes) */
export const SHOW_OFF_AGAIN = 1000;

/**
 * L1 (report): rares and holiday items seen at the hubs: sightings an hour (a bot wearing one in view of a hub's vantage
 * point, counted again at that hub after 10 minutes unseen), the bots, items and hubs, the share of hub samples with one
 * in view, and what the touring human saw. "Rares and veterans": "one or two rich bots at Varrock or Falador"
 * at 100 online.
 */
export function showOffSeen(r) {
    const so = r.showOff;
    if (!so || !so.hubSamples) return { value: null };
    const hours = Math.max(1, r.meta.ticks - (r.meta.warmup ?? 0)) / TICKS_PER_HOUR;
    const list = so.sightings;
    const rares = list.filter(x => x.kind === 'rare').length;
    const wearers = new Set(list.map(x => x.name));
    const count = (key, from) => {
        const m = {};
        for (const x of from) m[x[key]] = (m[x[key]] ?? 0) + 1;
        return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };
    const hubs = count('hub', list).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(', ');
    const items = count('item', list).map(([k, n]) => `${k} ${n}`).join(', ');
    return {
        value: round(list.length / hours),
        detail: `${list.length} sightings in ${round(hours)} h (${rares} of rares, ${list.length - rares} of holiday items) of ${wearers.size} bots${list.length ? `: ${items}; at ${hubs}` : ''}; one in view in ${pct(so.hubSamplesWith, so.hubSamples)} % of hub samples; the touring human saw ${so.human.length} (${new Set(so.human.map(x => x.name)).size} bots)`
    };
}
// ---- end of track A's (phase 4) block ----

/** within 30 s after a line addressing a bot (--probe): that bot is in a conversation with the human */
const afterProbe = (r, t) => r.probes.some(p => p.kind === 'public' && t >= p.t && t - p.t <= 50);
/**
 * The bots' answers to the human: public replies to probe lines (by the probed bot) and to talk lines (any bot near;
 * not in a probe's conversation), PMs
 */
export function answers(r) {
    const pub = [];
    for (const p of r.probes) {
        if (p.kind !== 'public') continue;
        const a = r.lines.find(l => l.name === p.bot && l.t > p.t && l.t <= p.t + 25 && REPLY_KINDS.has(l.kind));
        if (a) pub.push({ latency: a.t - p.t, shown: a.shown, text: a.text, to: p.line, bot: p.bot });
    }
    for (const h of r.humanLines) {
        if (afterProbe(r, h.t)) continue;
        const a = r.lines.find(l => l.t > h.t && l.t <= h.t + 25 && REPLY_KINDS.has(l.kind) && l.humanDist <= VIEW + 1);
        if (a) pub.push({ latency: a.t - h.t, shown: a.shown, text: a.text, to: h.line });
    }
    const pm = [];
    for (const p of r.probes) {
        if (p.kind !== 'pm') continue;
        const a = r.pms.find(m => m.from === p.bot && m.t > p.t && m.t <= p.t + 40);
        if (a) pm.push({ latency: a.t - p.t, shown: displayed(a.text), text: a.text, to: p.line, bot: p.bot });
    }
    return { pub, pm };
}

export function typingSpeed(r) {
    const { pub } = answers(r);
    if (!pub.length) return { value: null };
    const cps = pub.map(a => a.shown.trim().length / (Math.max(1, a.latency) * TICK_SECONDS));
    return { value: round(median(cps)), detail: `${pub.length} public answers: characters a second p10/p50/p90 ${[0.1, 0.5, 0.9].map(q => round(quantile(cps, q))).join('/')}, max ${round(Math.max(...cps))}` };
}

export function replyLatency(r) {
    const { pub, pm } = answers(r);
    if (!pub.length) return { value: null };
    const lat = pub.map(a => a.latency);
    const [p10, p50, p90] = [0.1, 0.5, 0.9].map(q => quantile(lat, q));
    const pmLat = pm.map(a => a.latency);
    return {
        value: p50,
        shown: `${p10}-${p90} ticks`,
        ok: p10 >= 3 && p90 <= 15,
        detail: `public answers p10/p50/p90 ${p10}/${p50}/${p90} ticks (${round(p10 * TICK_SECONDS)}-${round(p90 * TICK_SECONDS)} s)${pmLat.length ? `; PMs ${[0.1, 0.5, 0.9].map(q => quantile(pmLat, q)).join('/')} ticks` : ''}`
    };
}

export function nameEcho(r) {
    const { pub, pm } = answers(r);
    const all = [...pub, ...pm];
    if (!all.length) return { value: null };
    const n = all.filter(a => namesPlayer(a.text, r.meta.humanName)).length;
    return { value: pct(n, all.length), detail: `${n} of ${all.length} answers (public and PM) name the human` };
}

export function emptyAnswers(r) {
    const { pub, pm } = answers(r);
    // (answers to a line with more than a hello: "hi" back to "hi" is right, upstream's "Yes Casey?" to a question is not)
    const all = [...pub, ...pm].filter(a => !isHello(a.to, a.bot));
    if (!all.length) return { value: null };
    const empty = all.filter(a => isGreetingOnly(a.text, r.meta.humanName));
    return { value: pct(empty.length, all.length), detail: `${empty.length} of ${all.length} answers to more than a hello are only a greeting${empty.length ? `, e.g. "${empty[0].to}" got "${empty[0].shown}"` : ''}` };
}

/** the tick each session ended (logged out), or undefined while it lasts */
function sessionEnds(r) {
    return new Map(r.sessions.filter(s => s.ended).map(s => [s.s, s.last]));
}

export function fakeDepartures(r) {
    const ends = sessionEnds(r);
    const said = r.lines.filter(l => (kindGroup(l.kind) === 'chatter' || l.kind === 'goodbye') && !l.toName && isDeparture(l.text) && l.t <= r.meta.ticks - 500);
    if (!said.length) return { value: null };
    const fake = said.filter(l => !(ends.has(l.s) && ends.get(l.s) - l.t <= 500));
    return { value: pct(fake.length, said.length), detail: `${fake.length} of ${said.length} goodbye lines not followed by a logout within 5 min${fake.length ? `, e.g. "${fake[0].shown}"` : ''}` };
}

export function fakeBrb(r) {
    const ends = sessionEnds(r);
    const stands = new Map();
    for (const st of r.idleStands) {
        if (st.len < 50) continue;
        if (!stands.has(st.s)) stands.set(st.s, []);
        stands.get(st.s).push(st);
    }
    const said = r.lines.filter(l => kindGroup(l.kind) === 'chatter' && !l.toName && BRB.test(l.text) && l.t <= r.meta.ticks - 200);
    if (!said.length) return { value: null };
    // (a stand that begins within 2 min, or one going on, lasting 30 s past the line)
    const fake = said.filter(l => !(stands.get(l.s) ?? []).some(st => st.start <= l.t + 200 && st.start + st.len >= l.t + 50) && !(ends.has(l.s) && ends.get(l.s) - l.t <= 200));
    return { value: pct(fake.length, said.length), detail: `${fake.length} of ${said.length} "brb/afk" lines not followed by a 30 s stand (or a logout) within 2 min` };
}

/** the game's auto-retaliations left out of H17 and H18, by task kind (the most first) */
function retaliationNote(r) {
    const rows = Object.entries(r.retaliations ?? {}).sort((a, b) => b[1] - a[1]);
    return rows.length ? `; the game's auto-retaliate left out: ${rows.slice(0, 4).map(([k, n]) => `${k} ${n}`).join(', ')}` : '';
}

export function instantReactions(r) {
    const rows = Object.entries(r.gaps)
        .filter(([, g]) => g.length >= 20)
        .map(([k, g]) => ({ k, n: g.length, le1: pct(g.filter(x => x <= 1).length, g.length) }))
        .sort((a, b) => b.le1 - a.le1);
    if (!rows.length) return { value: null };
    return { value: rows[0].le1, shown: `${rows[0].le1} % ${rows[0].k}`, detail: `target re-acquired within 1 tick: ${rows.slice(0, 6).map(x => `${x.k} ${x.le1} (${x.n})`).join(', ')}${retaliationNote(r)}` };
}

export function metronome(r) {
    const rows = Object.entries(r.cadence)
        .filter(([, c]) => c.pairs >= 50)
        .map(([k, c]) => ({ k, n: c.pairs, same: pct(c.identical, c.pairs) }))
        .sort((a, b) => b.same - a.same);
    if (!rows.length) return { value: null };
    return { value: rows[0].same, shown: `${rows[0].same} % ${rows[0].k}`, detail: `identical consecutive intervals between targets: ${rows.slice(0, 6).map(x => `${x.k} ${x.same}`).join(', ')}${retaliationNote(r)}` };
}

export function bankStopVariation(r) {
    const rows = Object.entries(r.bankStops)
        .filter(([, xs]) => xs.length >= 20)
        .map(([k, xs]) => ({ k, n: xs.length, cv: round(cv(xs), 2), p10: quantile(xs, 0.1), p90: quantile(xs, 0.9) }))
        .sort((a, b) => a.cv - b.cv);
    if (!rows.length) return { value: null };
    return { value: rows[0].cv, shown: `CV ${rows[0].cv} ${rows[0].k}`, detail: rows.slice(0, 5).map(x => `${x.k} CV ${x.cv} (${x.p10}-${x.p90} ticks, ${x.n})`).join(', ') };
}

/**
 * H19 counts a person's idle stands (AFK, a linger, watching): a stand at a hang-out (realism phase 3: a task of its own,
 * 'Hangout', at Falador park, Varrock square or a bank, every 1-2 hours of play) is left out and reported as C16. H19's
 * band (5-15 per 100 levelling bot-hours) was set for the idle moments of a session; hang-outs come 5-10 times as often,
 * by 2004 hotspots, and counted in H19 they would bury the measure it was made for.
 */
export function idleHumans(r) {
    const hours = r.levellingTicks / TICKS_PER_HOUR;
    if (!hours) return { value: null };
    const all = r.idleStands.filter(st => LEVELLING.has(st.planner) && st.len >= 200);
    // (realism phase 5b: a set piece's own stands are left out as a hang-out's: a party's guest waiting for the drop, a
    // scam caller at its spot (track P: DP and K measure them), a Duel Arena visit's staker waiting for a partner or a
    // watcher at a wall (track A: A1-A5))
    const stands = all.filter(st => st.kind !== HANGOUT_KIND && st.kind !== DUEL_ARENA_KIND && !SET_PIECE_TASK_KINDS.has(st.kind));
    const inBand = stands.filter(st => st.len <= 1000).length;
    const atHangouts = all.filter(st => st.kind === HANGOUT_KIND).length;
    const atArena = all.filter(st => st.kind === DUEL_ARENA_KIND).length;
    const inPieces = all.length - stands.length - atHangouts - atArena;
    return { value: round((100 * inBand) / hours), detail: `${inBand} idle stands of 2-10 min (standing, no target, no script, no XP) in ${round(hours)} levelling bot-hours${stands.length > inBand ? `; ${stands.length - inBand} longer` : ''}${atHangouts ? `; ${atHangouts} at a hang-out left out (C16)` : ''}${atArena ? `; ${atArena} at the Duel Arena left out (A1)` : ''}${inPieces ? `; ${inPieces} in a set piece left out` : ''}` };
}

export function walkingLogouts(r) {
    if (!r.logouts.length) return { value: null };
    const n = r.logouts.filter(l => l.moving).length;
    return { value: pct(n, r.logouts.length), detail: `${n} of ${r.logouts.length} logouts mid-walk; ${pct(r.logouts.filter(l => l.target).length, r.logouts.length)} % mid-interaction` };
}

export function politeLogouts(r) {
    if (!r.logouts.length) return { value: null };
    const bye = r.logouts.filter(l => l.lastDeparture >= 0 && l.t - l.lastDeparture <= 100);
    const bank = r.logouts.filter(l => l.atBank);
    const n = r.logouts.filter(l => (l.lastDeparture >= 0 && l.t - l.lastDeparture <= 100) || l.atBank).length;
    return { value: pct(n, r.logouts.length), detail: `${bye.length} after a goodbye (within 1 min), ${bank.length} at a bank, of ${r.logouts.length} logouts` };
}

// (the integration of phase 4: within the client's view, 15 tiles; it was 17, botTeleport's own margin, HUMAN_SIGHT. The
// runner has the bot's tile of the tick before the jump: a bot that stepped from 17 tiles to 18 and jumped, which
// botTeleport allows and no human sees, counted as seen; the human moves too)
/** (realism phase 5a) a mark covers a jump this many ticks after it (a cast lands about 3 ticks later) and this many before */
export const MARK_BEFORE_TICKS = 12;
export const MARK_AFTER_TICKS = 3;

/**
 * (realism phase 5a) Re-classes the jumps near a move the library marked real (BotAction.noteMove: 'spell' for a
 * teleport spell, 'event' for a random event's move), in place. `marks` is BotAction.teleportStats.marks, oldest first.
 */
export function classifyMarkedJumps(jumps, marks) {
    if (!marks.length) return;
    for (const j of jumps) {
        if (j.cls !== 'jump') continue;
        const who = String(j.name).toLowerCase();
        for (let i = marks.length - 1; i >= 0; i--) {
            const m = marks[i];
            if (m.tick < j.t - MARK_BEFORE_TICKS) break;
            if (m.name === who && m.tick <= j.t + MARK_AFTER_TICKS) {
                j.cls = m.cls;
                break;
            }
        }
    }
}

export function teleportsSeen(r) {
    const seen = r.jumps.filter(j => j.cls === 'jump' && !j.afterDeath && j.humanDist <= VIEW);
    const classes = {};
    for (const j of r.jumps) classes[j.afterDeath ? 'death' : j.cls] = (classes[j.afterDeath ? 'death' : j.cls] ?? 0) + 1;
    // (realism phase 5a: spells and random events' moves are classes of their own, listed with the rest, not counted)
    return { value: seen.length, detail: `${seen.length} jumps within the human's 15-tile view${seen.length ? ` (${seen.slice(0, 3).map(j => `t${j.t} ${j.name} ${j.task} ${j.from.join(',')} -> ${j.to.join(',')}`).join('; ')})` : ''}; all jumps by kind ${Object.entries(classes).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}` };
}

export function metaLines(r) {
    const pool = r.lines.filter(l => ['chatter', 'social', 'reply'].includes(kindGroup(l.kind)));
    if (!pool.length) return { value: null };
    const meta = pool.filter(l => META.test(l.text));
    const heard = meta.filter(l => l.humanDist <= VIEW).length;
    const slang = r.lines.filter(l => !isAside(l) && SLANG2004.test(l.text)).length;
    const nonTrade = r.lines.filter(l => !isAside(l)).length;
    return {
        value: pct(meta.length, pool.length),
        detail: `${meta.length} of ${pool.length} idle, social and reply lines; the human heard ${round((heard * TICKS_PER_HOUR) / r.meta.ticks)} an hour${meta.length ? `, e.g. "${meta[0].shown}"` : ''}; 2004 shorthand in ${pct(slang, nonTrade)} % of non-trade lines`
    };
}

export function burstiness(r) {
    const by = nonTradeBySession(r);
    const cvs = [];
    for (const ticks of by.values()) {
        if (ticks.length < 4) continue;
        const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
        const c = cv(gaps);
        if (c !== null) cvs.push(c);
    }
    if (!cvs.length) return { value: null };
    return { value: round(median(cvs), 2), detail: `${cvs.length} bots with 4+ non-trade lines in a session: CV p10/p50/p90 ${[0.1, 0.5, 0.9].map(q => round(quantile(cvs, q), 2)).join('/')}` };
}

function nonTradeWords(r) {
    return r.lines.filter(l => !isAside(l)).map(l => words(l.shown).length);
}
export function wordsPerLine(r) {
    const w = nonTradeWords(r);
    if (!w.length) return { value: null };
    return { value: round(mean(w), 2), detail: `${w.length} non-trade lines; median ${median(w)}` };
}
export function shortLines(r) {
    const w = nonTradeWords(r);
    if (!w.length) return { value: null };
    return { value: pct(w.filter(n => n <= 3).length, w.length), detail: 'non-trade lines of at most 3 words' };
}

/** An area: the 64×64 map square (274's), on its level */
const areaOf = l => `${l.x >> 6}_${l.z >> 6}_${l.level}`;
export function crossBotRepeats(r) {
    const recent = new Map(); // text -> [[t, name, area]]
    const perArea = new Map();
    let repeats = 0;
    let perBotRepeat = 0;
    const perBot = new Map(); // session -> Set(text)
    let considered = 0;
    for (const l of r.lines) {
        if (isAside(l)) continue;
        const text = normalized(l.shown);
        if (REFLEX_LINES.has(text)) continue;
        considered++;
        const area = areaOf(l);
        const list = (recent.get(text) ?? []).filter(e => l.t - e[0] <= 1000);
        if (list.some(e => e[1] !== l.name && e[2] === area)) {
            repeats++;
            const a = perArea.get(area) ?? { n: 0, x: l.x, z: l.z, top: new Map() };
            a.n++;
            a.top.set(l.shown, (a.top.get(l.shown) ?? 0) + 1);
            perArea.set(area, a);
        }
        list.push([l.t, l.name, area]);
        recent.set(text, list);
        let said = perBot.get(l.s);
        if (!said) perBot.set(l.s, (said = new Set()));
        if (said.has(text)) perBotRepeat++;
        said.add(text);
    }
    const tens = r.meta.ticks / 1000;
    if (!tens || !considered) return { value: null };
    const areas = [...perArea].sort((a, b) => b[1].n - a[1].n);
    if (!areas.length) return { value: 0, detail: 'no line said by two bots in one map square within 10 min' };
    const [, worst] = areas[0];
    const topLine = [...worst.top].sort((a, b) => b[1] - a[1])[0];
    return {
        value: round(worst.n / tens),
        shown: `${round(worst.n / tens)} near ${nearestHub(worst.x, worst.z)}`,
        detail: `${repeats} lines another bot said in the same map square within 10 min (${round(repeats / tens)} per 10 min in all); the worst square's top: "${topLine[0]}" ×${topLine[1]}; a bot repeating its own line in a session: ${perBotRepeat}`
    };
}
function nearestHub(x, z) {
    let best = null;
    let d = Infinity;
    for (const h of HUBS) {
        const e = Math.max(Math.abs(h.x - x), Math.abs(h.z - z));
        if (e < d) [best, d] = [h.key, e];
    }
    return d <= 64 ? best : `${x},${z}`;
}

export function gzReactions(r) {
    let near = 0;
    let gz = 0;
    r.lines.forEach((l, i) => {
        if (l.kind !== 'levelup' || l.near < 1 || l.t > r.meta.ticks - 50) return;
        near++;
        for (const o of linesAfter(r.lines, i, 50, VIEW)) {
            if (o.kind !== 'levelup' && GZ.test(o.text)) {
                gz++;
                break;
            }
        }
    });
    if (!near) return { value: null };
    return { value: pct(gz, near), detail: `${gz} of ${near} level-up lines with another bot within 15 tiles got a "gz" from a bot within 30 s` };
}

export function deepPkerStill(r) {
    const m = r.motion.extras_pker;
    const total = m ? m.reduce((a, b) => a + b, 0) : 0;
    if (!total) return { value: null };
    const share = p => {
        const x = r.motion[p];
        const t = x ? x.reduce((a, b) => a + b, 0) : 0;
        return t ? pct(x[0], t) : null;
    };
    return { value: pct(m[0], total), detail: `still share by planner: ${Object.keys(r.motion).sort().map(p => `${p} ${share(p)}`).join(', ')}` };
}

export function activityVariety(r) {
    if (!r.xp.levelling) return { value: null };
    const v = r.variety.filter(x => x.ticks >= 3000);
    const kinds = v.map(x => Object.keys(x.kinds).filter(k => !['Init', 'Idle', 'none'].includes(k)).length);
    const top = v.map(x => {
        const counts = Object.entries(x.kinds).filter(([k]) => !['Init', 'Idle', 'none'].includes(k)).map(([, n]) => n);
        const sum = counts.reduce((a, b) => a + b, 0);
        return sum ? Math.max(...counts) / sum : 0;
    });
    return {
        value: pct(r.xp.levelling - r.xp.active, r.xp.levelling),
        detail: `share of levelling bot-ticks without XP in the last 25 ticks; sessions of 30+ min: task kinds median ${median(kinds) ?? '-'}, the top kind's share median ${top.length ? round(100 * median(top)) : '-'} %`
    };
}

// ---- arrivals and sessions (the realism work, phase 3, track A: P1's make-up, S2) ----
/**
 * P1: bots of combat 5 or less in Lumbridge per 100 online. Since phase 3 its detail says who they are: social bots, newbie
 * newcomers (port/BotNewbie: newbie time measured in levels) and the rest (fresh accounts of a new world, low-level
 * skillers), and the newbies online anywhere per 100 online (5-10 by design)
 */
export function lumbridgeNewbies(r) {
    const p = r.lumbridge;
    if (!p?.samples || !p.online) return { value: null };
    const per100 = n => round((100 * (n ?? 0)) / p.online, 1);
    const makeUp = p.newbies === undefined ? '' : `; of them social bots ${per100(p.lowSocial)}, newbies ${per100(p.lowNewbie)}, others ${per100(p.low - (p.lowSocial ?? 0) - (p.lowNewbie ?? 0))}; newbies online anywhere ${per100(p.newbies)} per 100`;
    return { value: round((100 * p.low) / p.online, 1), detail: `bots of combat 5 or less in Lumbridge (castle, fields, swamp, cows): ${round(p.low / p.samples)} on average, per 100 online${makeUp}` };
}

/**
 * S2: the lengths of the sessions begun and ended in the run (logged in after the world filled, then out): p10, median and
 * p90 in minutes (biased short: a session longer than what is left of the run is not in it). The "heavier-tailed
 * sessions": 5 minutes to 6 hours, median about 42 minutes
 */
export function sessionSpread(r) {
    const done = r.sessions.filter(s => s.ended && s.first >= (r.meta.fillTick ?? 0) + 1);
    if (!done.length) return { value: null };
    const lens = done.map(s => (s.last - s.first + 1) / TICKS_PER_MINUTE);
    const [p10, p50, p90] = [0.1, 0.5, 0.9].map(q => round(quantile(lens, q), 1));
    return { value: p50, shown: `${p10}/${p50}/${p90} min`, detail: `p10/median/p90 of ${done.length} sessions begun and ended in the run; longest ${round(Math.max(...lens), 1)} min, over 2 h ${pct(lens.filter(x => x > 120).length, lens.length)} %` };
}
// ---- end of track A's block ----

/**
 * the human's questions and greetings said to nobody (--talk), and how many bots answered each within 15 s; not those
 * within 30 s of a line addressing a bot (--probe): that bot is in a conversation with the human and answers anything
 */
function crowdResponders(r) {
    const said = r.humanLines.filter(h => (isQuestion(h.line) || /^(hi|hey|hello|sup|yo)\b/i.test(h.line)) && !afterProbe(r, h.t));
    return said.map(h => ({ line: h.line, n: new Set(r.lines.filter(l => l.t > h.t && l.t <= h.t + 25 && REPLY_KINDS.has(l.kind) && l.humanDist <= VIEW + 1).map(l => l.name)).size }));
}
export function crowdAnswered(r) {
    const said = crowdResponders(r);
    if (!said.length) return { value: null };
    const answered = said.filter(x => x.n > 0);
    const silent = said.filter(x => x.n === 0).map(x => x.line);
    return { value: pct(answered.length, said.length), detail: `${answered.length} of ${said.length} questions and greetings said to nobody got an answer within 15 s${silent.length ? `; unanswered e.g. "${[...new Set(silent)].slice(0, 4).join('", "')}"` : ''}` };
}
export function crowdResponderCount(r) {
    const answered = crowdResponders(r).filter(x => x.n > 0);
    if (!answered.length) return { value: null };
    return { value: round(mean(answered.map(x => x.n)), 2), detail: `responders per answered line: ${answered.map(x => x.n).join(', ')}` };
}

export function pmAnswered(r) {
    const asked = r.probes.filter(p => p.kind === 'pm');
    if (!asked.length) return { value: null };
    const { pm } = answers(r);
    return { value: pct(pm.length, asked.length), detail: `${pm.length} of ${asked.length} PMs answered within 24 s` };
}

export function marketMessages(r) {
    const market = r.humanLines.filter(h => h.market);
    if (!market.length) return { value: null };
    const n = r.humanMes.filter(m => /^(No vendor is currently available|Marketplace:)/.test(m.text)).length;
    return { value: n, detail: `game messages after ${market.length} buying/selling lines (upstream's marketplace)` };
}

/** X2 (realism phase 5b): the set pieces' lines (SETPIECE_KINDS) an hour of the run, by kind, and those the human heard */
export function setPieceLines(r) {
    const hours = Math.max(1, r.meta.ticks - (r.meta.warmup ?? 0)) / TICKS_PER_HOUR;
    const list = r.lines.filter(l => SETPIECE_KINDS.has(l.kind));
    const by = {};
    for (const l of list) by[l.kind] = (by[l.kind] ?? 0) + 1;
    const heard = list.filter(l => l.humanDist <= VIEW).length;
    return { value: round(list.length / hours, 1), detail: `${list.length} lines (${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}), ${heard} heard by the human; out of H6, H7 and the other chatter measures` };
}

export function heardPerMinute(r) {
    const heard = r.lines.filter(l => l.humanDist <= VIEW);
    const minutes = r.meta.ticks / TICKS_PER_MINUTE;
    const v = r.view;
    return {
        value: round(heard.length / minutes, 2),
        detail: `${heard.filter(l => !isTrade(l)).length} of ${heard.length} heard are non-trade; nobody within 15 tiles of the human ${pct(v?.empty ?? 0, v?.samples ?? 0) ?? '-'} % of the time${v?.byStop ? `; by stop (avg in view / % empty): ${Object.entries(v.byStop).map(([k, s]) => `${k} ${round(s.sum / s.samples)}/${Math.round(pct(s.empty, s.samples))}`).join(', ')}` : ''}`
    };
}

export function sessionLengths(r) {
    const done = r.sessions.filter(s => s.ended && s.first >= (r.meta.fillTick ?? 0) + 1);
    if (!done.length) return { value: null };
    const lens = done.map(s => s.last - s.first + 1);
    return { value: pct(lens.filter(x => x < 1500).length, lens.length), detail: `${done.length} sessions begun and ended in the run: p10/p50/p90 ${[0.1, 0.5, 0.9].map(q => round(quantile(lens, q) / TICKS_PER_MINUTE)).join('/')} min (biased short: long ones outlast the run)` };
}

// ---- crowds (realism phase 3, "where bots are": C15 fighting at the 2004 crowd spots, C16 hang-outs) ----

/**
 * The 2004 combat crowds (2004's crowd spots: Lumbridge's chickens, cows and goblins, Al Kharid's
 * warriors, Barbarian Village's barbarians, Varrock's guards, the hill giants of the Edgeville dungeon, the moss giants of
 * the Varrock sewers, the ice giants; on a members world Taverley's dungeon and Kandarin's moss giants): their spawn
 * clusters on the 274 map, and the tiles round each a fighter there stands within.
 */
export const CROWD_SPOTS = [
    ['lumbridge_chickens', 3230, 3299, 12], ['lumbridge_chickens_west', 3188, 3278, 10], ['lumbridge_cows', 3252, 3284, 14], ['lumbridge_cows_west', 3175, 3328, 16],
    ['lumbridge_goblins', 3248, 3241, 16], ['lumbridge_goblins_west', 3160, 3244, 16], ['al_kharid_warriors', 3292, 3172, 14], ['barbarian_village', 3082, 3428, 16],
    ['varrock_guards_north', 3220, 3478, 20], ['varrock_guards_west', 3176, 3420, 12], ['varrock_guards_east', 3273, 3427, 10], ['hill_giants', 3111, 9838, 16],
    ['moss_giants_sewers', 3162, 9891, 16], ['ice_dungeon', 3055, 9575, 16],
    ['taverley_dungeon', 2920, 9825, 40, true], ['moss_giants_kandarin', 2560, 3404, 18, true]
].map(([key, x, z, r, members = false]) => ({ key, x, z, r, members }));
export const FIGHTING_KINDS = new Set(['Combat', 'RangedMagic']);
/** the task kind of a hang-out (port/BotHangout) */
export const HANGOUT_KIND = 'Hangout';
/** (realism phase 5b, track A) a Duel Arena visit's task kind (tasks/DuelArenaTask): its stands are the arena's, not H19's */
export const DUEL_ARENA_KIND = 'DuelArena';
/**
 * (realism phase 5b, track A) a duel lost at the Duel Arena: 274's death in a duel keeps the loser's items and wakes it in
 * the hospital (duel_reset_all), no death in the world's sense (D1, D2, D4 leave it out; A2 counts the duels): a visit's
 * task, or anywhere in the six arenas (a big stake's duellist fights on a sub-task)
 */
export function duelLoss(d) {
    return d.task === DUEL_ARENA_KIND || (d.x >= 3333 && d.x <= 3388 && d.z >= 3206 && d.z <= 3258);
}

/** The 2004 crowd spot a tile is at (level 0; a dungeon's are its z + 6400), or null. */
export function crowdSpotAt(x, z, level, members = true) {
    if (level !== 0) return null;
    for (const s of CROWD_SPOTS) if ((members || !s.members) && Math.abs(x - s.x) <= s.r && Math.abs(z - s.z) <= s.r) return s.key;
    return null;
}

/**
 * C15: of the levelling bots' fighting time (Combat, RangedMagic: sampled with the vantage points), the share at the
 * 2004 crowd spots. The band (proposed from the culture track: "in 2004, F2P life was mostly combat training at
 * well-known spots"): half or more. Its detail: how much of the levelling bots' time is fighting at all (2004: about a
 * fifth of a world in the combat fields; the bots before this work: 7 % of all bots), by planner, and where.
 */
export function fightingAtCrowds(r) {
    const f = r.fights;
    if (!f?.samples) return { value: null };
    const top = Object.entries(f.bySpot ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const other = Object.entries(f.elsewhere ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const planners = Object.entries(f.byPlanner ?? {}).sort().map(([p, [n, of]]) => `${p} ${pct(n, of)}`);
    return {
        value: pct(f.atCrowd, f.samples),
        detail: `fighting ${pct(f.samples, f.levelling)} % of levelling bot-time (${planners.join(', ')}); at the 2004 spots ${f.atCrowd} of ${f.samples} samples: ${top.map(([k, n]) => `${k} ${pct(n, f.samples)}`).join(', ') || '-'}${other.length ? `; elsewhere most near ${other.map(([k, n]) => `${k} ${pct(n, f.samples)}`).join(', ')}` : ''}`,
        data: { fighting: pct(f.samples, f.levelling), bySpot: f.bySpot }
    };
}

/** C16 (report): the levelling bots' hang-outs (port/BotHangout): how many per 100 levelling bot-hours, how long, where. */
export function hangoutsReport(r) {
    const hours = r.levellingTicks / TICKS_PER_HOUR;
    if (!hours) return { value: null };
    const list = r.hangouts ?? [];
    const lens = list.map(h => h.len);
    const where = {};
    for (const h of list) where[h.spot ?? '?'] = (where[h.spot ?? '?'] ?? 0) + 1;
    return {
        value: round((100 * list.length) / hours),
        detail: `${list.length} hang-outs in ${round(hours)} levelling bot-hours${lens.length ? `, p10/p50/p90 ${[0.1, 0.5, 0.9].map(q => round(quantile(lens, q) / TICKS_PER_MINUTE)).join('/')} min (walk and stand)` : ''}${list.length ? `; ${Object.entries(where).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`
    };
}

export function deathsReport(r) {
    const byTask = {};
    for (const d of r.deaths) byTask[d.task] = (byTask[d.task] ?? 0) + 1;
    const odd = r.deaths.filter(d => !FIGHT_KINDS.has(d.task));
    return { value: odd.length, detail: `${r.deaths.length} deaths (${Object.entries(byTask).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})${odd.length ? `: ${odd.slice(0, 3).map(d => `t${d.t} ${d.name} (${d.task}) by ${d.by}`).join('; ')}` : ''}` };
}

// ---- (realism phase 5a, Track M: movement and magic) TP1-TP4 teleport spells and rescue jumps, F2 wrong turns, AL1 alchers ----

/** the reasons a bot's pre-click step can fail (the cast never began: the bank, a full pack, the staff not going on) */
const PRE_CLICK_FAILURES = ['bank', 'pack full', 'wield'];

/**
 * TP1: of the qualifying long trips (port/BotTeleport: a route of 150+ tiles, 80+ over monsters that hunt the bot, with
 * a landing that helps) by bots with the level and the runes at hand, the share that were a spell (landed). The spec's
 * band 40-90 %: 70 % of the bots teleport at all, on 85 % of their trips, under 3 laws they walk. The detail: why the
 * rest walked, the spells, White Wolf Mountain on foot, and the long trips that were no opportunity.
 */
export function teleportTrips(r) {
    const sp = r.spells;
    if (!sp || !sp.opportunities) return { value: null, detail: sp ? `${sp.trips} trips decided, ${sp.longTrips} of 150+ tiles, none an opportunity` : '' };
    const walked = Object.entries(sp.walked ?? {}).sort((a, b) => b[1] - a[1]);
    const spells = Object.entries(sp.bySpell ?? {}).sort((a, b) => b[1] - a[1]);
    const c = sp.crossings ?? {};
    const bots = sp.byBot ?? [];
    const botText = bots.length ? `; by ${bots.length} bots (most: ${bots.slice(0, 3).map(b => `${b.name} ${b.trips}${b.saver ? ' saving its laws' : `, ${b.cast} cast`}`).join('; ')})` : '';
    return {
        value: pct(sp.landed, sp.opportunities),
        detail: `${sp.landed} spells of ${sp.opportunities} qualifying trips (${sp.trips} trips decided, ${sp.longTrips} of 150+ tiles)${botText}; walked: ${walked.map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; spells ${spells.map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; White Wolf Mountain on foot ${c.trips ?? 0} (from a bank and prepared ${c.prepared ?? 0}, food packed ${c.fed ?? 0}, careless ${c.careless ?? 0})`
    };
}

/** TP2: casts that failed (the script refused, no runes after all, busy; and the steps before the click) of the casts begun. */
export function castFailures(r) {
    const sp = r.spells;
    if (!sp) return { value: null };
    const reasons = sp.failReasons ?? {};
    const pre = PRE_CLICK_FAILURES.reduce((sum, k) => sum + (reasons[k] ?? 0), 0);
    const attempts = sp.casts + pre;
    if (!attempts) return { value: null };
    return { value: pct(sp.failed, attempts), detail: `${sp.failed} of ${attempts} casts begun failed${sp.failed ? ` (${Object.entries(reasons).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}; ${sp.landed} landed` };
}

/** TP3 (report): teleport spells (a jump the library marked 'spell') whose departure or landing the human saw, an hour. */
export function spellsSeen(r) {
    if (!r.spells && !r.jumps.some(j => j.cls === 'spell')) return { value: null };
    const hours = r.meta.ticks / TICKS_PER_HOUR;
    const spells = r.jumps.filter(j => j.cls === 'spell' && !j.afterDeath);
    const seen = spells.filter(j => j.humanDist <= VIEW);
    return { value: round(seen.length / hours), detail: `${seen.length} of ${spells.length} spells within the human's 15-tile view in ${round(hours)} h${seen.length ? ` (${seen.slice(0, 3).map(j => `t${j.t} ${j.name} ${(j.from ?? []).join(',')} -> ${(j.to ?? []).join(',')}`).join('; ')})` : ''}` };
}

/** TP4 (report): the unseen rescue jumps (BotAction.botTeleport: watchdog, stuck, gateway, dungeon, task) per 100 bot-hours; 'task' expected 0 (RangedMagic's went). A random event's moves ('event') are their own. */
export function rescueJumps(r) {
    const hours = r.botTicks / TICKS_PER_HOUR;
    if (!hours || !r.rescues) return { value: null };
    const byReason = {};
    let jumps = 0;
    let refused = 0;
    for (const { cause, jumps: j, refused: f } of r.rescues) {
        const reason = String(cause).split('/')[1]?.split(':')[0] ?? '?';
        if (reason === 'event') continue;
        byReason[reason] = (byReason[reason] ?? 0) + j;
        jumps += j;
        refused += f;
    }
    const top = r.rescues.filter(x => !String(x.cause).includes('/event') && x.jumps > 0).sort((a, b) => b.jumps - a.jumps).slice(0, 4);
    return { value: round((100 * jumps) / hours), detail: `${jumps} rescue jumps in ${round(hours)} bot-hours (${refused} refused in sight); by reason ${Object.entries(byReason).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; task ${byReason.task ?? 0}${top.length ? `; most ${top.map(x => `${x.cause} ${x.jumps}`).join(', ')}` : ''}` };
}

/** F2: wrong turns per 100 graph walks of 80+ tiles (BotAction's: 6 % x the persona's carelessness ÷ its median). */
export function wrongTurns(r) {
    const w = r.wrongTurns;
    if (!w || !w.walks) return { value: null };
    const lost = w.rolled !== undefined ? `; rolled ${w.rolled}: no junction ${w.noJunction}, the junction cut past or an errand ${w.cut}, the route planned anew ${w.dropped}` : '';
    return { value: round((100 * w.turns) / w.walks, 1), detail: `${w.turns} wrong turns in ${w.walks} walks of 80+ tiles (${w.back} back on the route)${lost}` };
}

/** AL1 (report): alchers the human saw at a trade bank, an hour (a bot again after 10 minutes); the world's alching beside. */
export function alchersSeen(r) {
    const a = r.alch;
    if (!a && !(r.alchSightings ?? []).length) return { value: null };
    const hours = r.meta.ticks / TICKS_PER_HOUR;
    const seen = r.alchSightings ?? [];
    const banks = {};
    for (const s of seen) banks[s.bank] = (banks[s.bank] ?? 0) + 1;
    const items = Object.entries(a?.items ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 3);
    return {
        value: round(seen.length / hours),
        detail: `${seen.length} sightings in ${round(hours)} h${seen.length ? ` (${Object.entries(banks).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}; in the world ${a?.stints ?? 0} stints, ${a?.casts ?? 0} alchs (${a?.refused ?? 0} refused), ${a?.coins ?? 0} coins${items.length ? `: ${items.map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}${a?.laws ? `; law runs ${a.laws.trips} (${a.laws.done} done, ${a.laws.laws} laws)` : ''}`
    };
}
// ---- end of Track M's (phase 5a) block ----

// ---- economy (realism phase 4, track B: E1 the vendors' asks against the street table, E2 their adverts' repetition) ----

/** E1's window: an ask this close to the December 2004 street price reads right (the spec's 0.67-1.5×) */
export const E1_WINDOW = [0.67, 1.5];
/** a vendor may sell a rare only at combat 40+ or a total level of 500+ */
export const RARE_COMBAT = 40;
export const RARE_TOTAL = 500;

/**
 * E1: the vendors' asks against the street table (data/street_prices.json, read by the runner whatever library it runs:
 * an A/B against older code measures that code's asks): each stocking of a table item (a vendor and an item in a
 * session, `record.vendorStocks`) is its ask ÷ the street price. The value is the share within E1_WINDOW; the median
 * ratio is shown with it; the detail has the spread, the farthest items, and the rares (who stocked them, noted or not).
 */
export function streetAsks(r) {
    const street = r.street ?? {};
    const stocks = r.vendorStocks ?? [];
    if (!stocks.length) return { value: null };
    const priced = stocks.filter(s => street[s.item] !== undefined).map(s => ({ ...s, ratio: s.ask / street[s.item] }));
    const rares = stocks.filter(s => s.rare);
    const lowRares = rares.filter(s => !(s.cb >= RARE_COMBAT || s.total >= RARE_TOTAL));
    const notedRares = rares.filter(s => s.noted);
    const atTradeBanks = stocks.filter(s => s.bankTrade === true || s.bankTrade === false);
    const rareText = `rares: ${rares.length} stocked${rares.length ? ` (${lowRares.length} by a vendor under combat ${RARE_COMBAT} and total ${RARE_TOTAL}, ${notedRares.length} noted${rares.length ? `; ${[...new Set(rares.map(s => `${s.itemName} ${formatPrice(s.ask)}`))].slice(0, 4).join(', ')}` : ''})` : ''}${atTradeBanks.length ? `; at a bank with a trade of its own ${atTradeBanks.filter(s => s.bankTrade).length} of ${atTradeBanks.length} stockings from it` : ''}`;
    if (!priced.length) return { value: null, detail: `${stocks.length} vendor stockings, none of a street-table item; ${rareText}` };
    const ratios = priced.map(p => p.ratio);
    const share = pct(ratios.filter(x => x >= E1_WINDOW[0] && x <= E1_WINDOW[1]).length, ratios.length);
    const med = round(median(ratios), 2);
    const far = [...priced].sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio))).slice(0, 3);
    return {
        value: share,
        shown: `${share} % (median ${med}×)`,
        detail: `${priced.length} of ${stocks.length} vendor stockings are of a street-table item: ask ÷ street p10/p50/p90 ${[0.1, 0.5, 0.9].map(q => round(quantile(ratios, q), 2)).join('/')}; farthest ${far.map(p => `${p.itemName} ${formatPrice(p.ask)} (street ${formatPrice(street[p.item])}, ${round(p.ratio, 2)}×)`).join(', ')}; ${rareText}`
    };
}

/** a price as a 2004 player wrote it (port/BotPrices.formatGp's rule) */
function formatPrice(n) {
    const one = x => String(Math.round(x * 10) / 10);
    if (n >= 1_000_000) return `${one(n / 1_000_000)}m`;
    if (n >= 10_000) return `${one(n / 1000)}k`;
    return String(n);
}

/** a vendor's advert: a trade line it says at its stall between trades (VendorTask's 'idle' state; not its chatter or answers) */
export const isAdvert = l => l.task === 'Vendor' && l.state === 'idle' && isTrade(l);

/**
 * E2: the vendors' most common advert (as shown, however punctuated) as a share of all their adverts (the spec's target
 * 10 % or less: 2004's sellers each had their own line, upstream's three forms repeated word for word). The detail: how
 * many adverts and distinct lines, the top three, the share in colour or with an effect, "noted" on a rare, and the
 * bankstanders' adverts for comparison. (2026-10-18) Hand-typed adverts only: an auto typer repeats its one line by
 * design (tasks/VendorTask); its adverts are counted in the detail.
 */
export function advertRepeats(r) {
    const all = r.lines.filter(isAdvert);
    const ads = all.filter(l => !l.typer);
    if (!ads.length) return { value: null };
    const counts = new Map();
    for (const l of ads) {
        const k = normalized(l.shown);
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1]);
    const styled = ads.filter(l => l.colour || l.effect).length;
    const perSession = new Map();
    for (const l of ads) {
        const set = perSession.get(l.s) ?? new Set();
        set.add(normalized(l.shown));
        perSession.set(l.s, set);
    }
    const bank = r.lines.filter(l => l.task === 'Bankstand' && l.state === 'idle' && isTrade(l));
    const bankTop = bank.length ? Math.max(...[...bank.reduce((m, l) => m.set(normalized(l.shown), (m.get(normalized(l.shown)) ?? 0) + 1), new Map()).values()]) : 0;
    // (C6 for adverts, which C6 leaves out as trade lines: one another vendor said in the same map square within 10 min)
    const recent = new Map();
    let echoed = 0;
    for (const l of ads) {
        const k = normalized(l.shown);
        const list = (recent.get(k) ?? []).filter(e => l.t - e[0] <= 1000);
        if (list.some(e => e[1] !== l.name && e[2] === areaOf(l))) echoed++;
        list.push([l.t, l.name, areaOf(l)]);
        recent.set(k, list);
    }
    const typed = all.filter(l => l.typer);
    return {
        value: pct(top[0][1], ads.length),
        detail: `${ads.length} adverts, ${counts.size} distinct; top ${top.slice(0, 3).map(([t, n]) => `"${t}" ×${n}`).join(', ')}; another vendor's same advert in the map square within 10 min ${echoed} (${pct(echoed, ads.length)} %); in colour or with an effect ${pct(styled, ads.length)} %; distinct lines a vendor's session (median) ${median([...perSession.values()].map(s => s.size))}; bankstanders' adverts ${bank.length}${bank.length ? `, their top ${pct(bankTop, bank.length)} %` : ''}${typed.length ? `; auto typers' adverts ${typed.length} (${new Set(typed.map(l => l.s)).size} sessions, ${pct(typed.length, all.length)} % of the vendors')` : ''}`
    };
}
// ---- end of track B's (economy) block ----

/**
 * Every place's numbers (the research's hubtable.py): bots in view on average and at most, the share of samples with
 * nobody, the share of social bots in view, and the lines a minute said within 15 tiles (all, non-trade).
 */
export function hubTable(r) {
    const minutes = r.meta.ticks / TICKS_PER_MINUTE;
    const heard = new Map();
    for (const l of r.lines) {
        for (const k of l.hubs ?? []) {
            const h = heard.get(k) ?? [0, 0];
            h[0]++;
            if (!isTrade(l)) h[1]++;
            heard.set(k, h);
        }
    }
    return hubsFor(r.meta.members)
        .filter(h => r.hubs[h.key]?.samples)
        .map(h => {
            const a = r.hubs[h.key];
            const [lines, nonTrade] = heard.get(h.key) ?? [0, 0];
            return { key: h.key, hotspot: h.hotspot, avg: round(a.bots / a.samples), max: a.max, emptyPct: pct(a.empty, a.samples), socialPct: pct(a.social, a.bots), linesPerMin: round(lines / minutes, 2), nonTradePerMin: round(nonTrade / minutes, 2) };
        });
}
export function formatHubTable(rows) {
    const out = ['  place                    in view  max  empty %  social %  lines/min  non-trade/min'];
    for (const h of rows) out.push(`  ${`${h.key}${h.hotspot ? ' *' : ''}`.padEnd(24)} ${String(h.avg).padStart(7)} ${String(h.max).padStart(4)} ${String(h.emptyPct).padStart(8)} ${String(h.socialPct ?? '-').padStart(9)} ${String(h.linesPerMin).padStart(10)} ${String(h.nonTradePerMin).padStart(14)}`);
    out.push('  (* a 2004 hotspot: H1, H2)');
    return out;
}

// ---- the table: id, group, title, unit, band, basis ----

const max = m => ({ max: m });
const min = m => ({ min: m });
const between = (a, b) => ({ min: a, max: b });

export const METRICS = [
    ['H1', 'presence', 'Empty hotspots: samples with nobody in view (worst)', '%', r => max(hotspotEmptyMax(r.meta.bots)), 'proposed', emptyHotspots],
    ['H2', 'presence', 'Crowd balance: busiest hotspot ÷ median hotspot', '×', () => max(4), 'proposed', crowdBalance],
    ['H3', 'presence', 'Social bots among the bots in view at a hub, when 3+ are (worst)', '%', () => max(25), 'proposed', socialShareInView],
    ['H4', 'presence', 'Idle stacking: bot-samples standing idle on a shared tile', '%', () => max(2), 'proposed', idleStacking],
    ['H5', 'presence', 'Pop-in: bots in view 5 ticks after login ÷ after 100', '%', () => min(80), 'proposed', popIn],
    ['P1', 'presence', 'Lumbridge newbies (combat ≤ 5) per 100 online', '', () => between(5, 10), 'decided', lumbridgeNewbies],
    // (phase 3, track C)
    ['G1', 'presence', 'Levelling bot-time within 3 tiles of a clique-mate for 30 s+', '%', () => null, 'report', cliqueTogether],
    ['H6', 'chat', 'Quiet share: 10-minute windows without a non-trade line', '%', () => between(50, 80), 'proposed', quietShare],
    ['H7', 'chat', 'Non-trade lines per bot-hour', '', () => between(4, 10), 'decided', linesPerBotHour],
    ['H8', 'chat', 'Context fit: skills and places in idle statements that fit the bot', '%', () => min(60), 'proposed', contextFitShare],
    ['H8b', 'chat', 'Newbie questions ("how do i...") asked by combat 40+', '%', () => max(10), 'decided', veteranNewbieQuestions],
    ['H9', 'chat', "Bots' questions answered by another bot within 30 s", '%', () => between(20, 50), 'proposed', answeredBotQuestions],
    ['H10', 'chat', 'Level-up lines in their most common shape', '%', () => max(20), 'proposed', levelupTemplate],
    ['H16', 'chat', 'Fake departures: goodbye lines not followed by a logout in 5 min', '%', () => max(10), 'proposed', fakeDepartures],
    ['C4', 'chat', 'Fake breaks: "brb/afk" lines not followed by a stand in 2 min', '%', () => max(10), 'proposed', fakeBrb],
    ['H22', 'chat', 'Meta or post-2004 keywords in idle, social and reply lines', '%', () => null, 'report', metaLines],
    ['C2', 'chat', 'Burstiness: median CV of a bot’s gaps between lines', '', () => min(1.3), 'proposed', burstiness],
    ['C3', 'chat', 'Words per non-trade line (mean)', '', () => between(2.5, 4), 'sourced', wordsPerLine],
    ['C3b', 'chat', 'Non-trade lines of at most 3 words', '%', () => min(50), 'proposed', shortLines],
    ['C6', 'chat', 'The same line from two bots in a map square in 10 min (worst, per 10 min)', '', () => max(1), 'proposed', crossBotRepeats],
    ['C8', 'chat', 'Level-ups near other bots that get a bot’s "gz" within 30 s', '%', () => min(30), 'proposed', gzReactions],
    ['X1', 'chat', 'Lines a minute the human heard', '', () => null, 'report', heardPerMinute],
    ['X2', 'chat', "Set pieces' lines an hour (stakes, parties, rumours, scam calls, the mod, outings' and minigame crews' calls: out of H7)", '', () => null, 'report', setPieceLines],
    ['H13', 'talk', 'Typing speed of public answers to the human (median)', 'ch/s', () => max(6), 'sourced', typingSpeed],
    ['H13b', 'talk', 'Answer latency p10-p90 (3-15 ticks)', '', () => between(3, 15), 'proposed', replyLatency],
    ['H14', 'talk', 'Answers that echo the human’s name', '%', () => max(25), 'proposed', nameEcho],
    ['H15', 'talk', 'Answers that are only a greeting', '%', () => max(15), 'proposed', emptyAnswers],
    ['T1', 'talk', 'The human’s questions and greetings to nobody that get an answer', '%', () => null, 'report', crowdAnswered],
    ['T1b', 'talk', 'Bots answering each such line (when answered)', '', () => between(1, 2), 'decided', crowdResponderCount],
    ['T2', 'talk', 'PMs answered', '%', () => null, 'report', pmAnswered],
    ['M1', 'talk', 'Marketplace system messages to the human', '', () => max(0), 'decided', marketMessages],
    ['H17', 'timing', 'Instant reactions: target re-acquired within 1 tick (worst kind)', '%', () => max(10), 'proposed', instantReactions],
    ['H18', 'timing', 'Metronome: identical consecutive target intervals (worst kind)', '%', () => max(10), 'proposed', metronome],
    ['H18b', 'timing', 'Bank stops: CV of their length (lowest)', '', () => min(0.3), 'proposed', bankStopVariation],
    ['H19', 'timing', 'Idle stands of 2-10 min per 100 levelling bot-hours', '', () => between(5, 15), 'proposed', idleHumans],
    ['C11', 'timing', 'Deep PKers standing still (share of their ticks)', '%', () => min(30), 'proposed', deepPkerStill],
    ['C14', 'timing', 'Levelling bots’ time without XP (banking, walking, idling)', '%', () => min(25), 'proposed', activityVariety],
    ['H21', 'timing', 'Teleports seen: unseen-policy jumps within the human’s 15-tile view (spells and event moves apart)', '', () => max(0), 'proposed', teleportsSeen],
    // (realism phase 5a, Track M: movement and magic)
    ['TP1', 'timing', 'Long trips by bots with the level and runes that were a spell (route 150+, 80+ over hunting monsters)', '%', () => between(40, 90), 'decided', teleportTrips],
    ['TP2', 'timing', 'Teleport casts that failed (refused, no runes, busy)', '%', () => max(5), 'proposed', castFailures],
    ['TP3', 'timing', 'Teleport spells the human saw, an hour', '', () => null, 'report', spellsSeen],
    ['TP4', 'timing', 'Rescue jumps per 100 bot-hours (task expected 0)', '', () => null, 'report', rescueJumps],
    ['F2', 'timing', 'Wrong turns per 100 walks of 80+ tiles', '', () => between(2, 10), 'proposed', wrongTurns],
    ['AL1', 'presence', 'Alchers seen at the trade banks, an hour', '', () => null, 'report', alchersSeen],
    // (realism phase 3, crowds)
    ['C15', 'presence', 'Fighting at the 2004 crowd spots (share of levelling bots’ fighting time)', '%', () => min(50), 'proposed', fightingAtCrowds],
    ['C16', 'presence', 'Hang-outs per 100 levelling bot-hours (park, square, banks)', '', () => null, 'report', hangoutsReport],
    ['H11', 'looks', 'Female share', '%', () => between(10, 20), 'sourced', femaleShare],
    ['H12', 'looks', 'Combat 11-60 in a matching metal set (helm, body, legs, shield)', '%', () => max(40), 'proposed', matchingSets],
    ['H12b', 'looks', 'Levelling combat 30+ with a cape, amulet, gloves or boots', '%', () => min(30), 'proposed', accessories],
    // (realism phase 4, track A: looks)
    ['L1', 'looks', 'Rares and holiday items seen at the hubs, an hour (a bot again after 10 min)', '', () => null, 'report', showOffSeen],
    // (realism phase 4, track B: economy)
    ['E1', 'economy', 'Vendors’ asks within 0.67-1.5× of the December 2004 street price', '%', () => min(90), 'decided', streetAsks],
    ['E2', 'economy', 'Vendors’ most common advert: its share of their adverts', '%', () => max(10), 'proposed', advertRepeats],
    ['H20', 'leaving', 'Logouts while walking', '%', () => max(25), 'proposed', walkingLogouts],
    ['H20b', 'leaving', 'Logouts after a goodbye or at a bank', '%', () => min(25), 'proposed', politeLogouts],
    ['S1', 'leaving', 'Sessions under 15 min (begun and ended in the run)', '%', () => null, 'report', sessionLengths],
    ['S2', 'leaving', 'Session lengths p10/median/p90 (begun and ended in the run)', 'min', () => null, 'report', sessionSpread],
    // (realism phase 5a, track F: banded, per 100 levelling bot-hours; it was the count, report)
    ['D1', 'leaving', 'Deaths outside a fight per 100 levelling bot-hours (a skill, an errand)', '', r => judged(r, deathsOutside(r).length, between(0.2, 2)), 'proposed', deathsOutsideFights]
].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }));

export const GROUPS = { presence: 'Where the crowd is', chat: 'What they say', talk: 'Talking to them', timing: 'Timing and movement', looks: 'Looks', economy: 'Prices and adverts', leaving: 'Arrivals and departures' };

export function inBand(value, band) {
    if (value === null || value === undefined || !band) return null;
    return (band.min === undefined || value >= band.min) && (band.max === undefined || value <= band.max);
}

/** Every metric of a record: [{ id, group, title, unit, basis, band, value, shown, ok, detail, data }] */
export function computeMetrics(record) {
    return METRICS.map(m => {
        const res = m.fn(record) ?? { value: null };
        const band = m.basis === 'report' ? null : m.band(record);
        const ok = res.value === null || res.value === undefined ? null : band ? (res.ok ?? inBand(res.value, band)) : null;
        return { id: m.id, group: m.group, title: m.title, unit: m.unit, basis: m.basis, band, value: res.value ?? null, shown: res.shown ?? null, ok, detail: res.detail ?? '', data: res.data };
    });
}

export function bandText(band, unit = '') {
    if (!band) return 'report';
    const u = unit === '%' ? ' %' : unit === '×' ? '' : unit ? ` ${unit}` : '';
    if (band.min !== undefined && band.max !== undefined) return band.min === band.max ? `${band.min}${u}` : `${band.min}-${band.max}${u}`;
    if (band.max !== undefined) return band.max === 0 ? '0' : `≤ ${band.max}${u}`;
    return `≥ ${band.min}${u}`;
}

export function valueText(m) {
    if (m.value === null) return 'n/a';
    if (m.shown) return m.shown;
    return `${m.value}${m.unit === '%' ? ' %' : m.unit && m.unit !== '×' ? ` ${m.unit}` : ''}`;
}

/** The report as lines of text (the runner prints them): a row per metric, its detail under it. */
export function formatMetrics(metrics, { details = true } = {}) {
    const out = [];
    for (const [group, title] of Object.entries(GROUPS)) {
        const rows = metrics.filter(m => m.group === group);
        if (!rows.length) continue;
        out.push(`  ${title}`);
        for (const m of rows) {
            const mark = m.ok === null ? (m.value === null ? '–' : ' ') : m.ok ? '✓' : '✗';
            out.push(`    ${mark} ${m.id.padEnd(4)} ${m.title.padEnd(76)} ${valueText(m).padEnd(30)} ${bandText(m.band, m.unit).padEnd(10)} ${m.basis}`);
            if (details && m.detail) out.push(`           ${m.detail}`);
        }
    }
    return out;
}

/** FNV-1a over the metrics' ids and values (no times): the same seed gives the same fingerprint */
export function fingerprint(metrics) {
    const text = JSON.stringify(metrics.map(m => [m.id, m.value, m.shown]));
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
    return h.toString(16).padStart(8, '0');
}

/** An empty record (the runner fills it; tests build on it). */
export function emptyRecord(meta = {}) {
    return {
        meta: { bots: 0, ticks: 0, members: true, xpRate: 1, seed: 1, humanName: 'sim human', fillTick: 0, ...meta },
        botTicks: 0,
        levellingTicks: 0,
        hubs: {},
        view: { samples: 0, empty: 0, sum: 0, byStop: {} },
        popin: { at: {} },
        stacks: { botSamples: 0, idleStacked: 0, byState: {} },
        lumbridge: { samples: 0, low: 0, online: 0 },
        lines: [],
        pms: [],
        probes: [],
        humanLines: [],
        humanMes: [],
        sessions: [],
        logouts: [],
        deaths: [],
        jumps: [],
        looks: [],
        motion: {},
        gaps: {},
        cadence: {},
        /** task kind -> new targets that were the game's auto-retaliate (left out of H17 and H18) */
        retaliations: {},
        bankStops: {},
        idleStands: [],
        xp: { levelling: 0, active: 0 },
        variety: [],
        // (realism phase 3, crowds) the levelling bots' fighting samples (C15), their hang-outs (C16)
        fights: { levelling: 0, samples: 0, atCrowd: 0, bySpot: {}, elsewhere: {}, byPlanner: {} },
        hangouts: [],
        /** (phase 3, track C) G1: levelling bot-samples, those of clique members, with a mate online, within 3 (and 15) tiles of
         * one, in runs of 30 s+; clique members' logins after the fill, those with a clique-mate online then */
        groups: { levelling: 0, clique: 0, mateOnline: 0, nearAny: 0, inView: 0, near30: 0, logins: 0, loginsWithMate: 0 },
        /** (phase 4, track A: looks) L1: hub samples, those with a rare or holiday item in view, the sightings (a bot again at
         * a hub after SHOW_OFF_AGAIN), and the touring human's sightings */
        showOff: { hubSamples: 0, hubSamplesWith: 0, sightings: [], human: [] },
        /** (realism phase 4, track B: economy) E1: each vendor's stocking (a session's item and ask: { t, s, name, item
         * (debugname), itemName, ask, value, rare, noted, count, cb, total, bank, bankTrade: from its bank's own trade, null
         * where the bank has none }), and the street table (debugname → price) */
        vendorStocks: [],
        street: {},
        /** (realism phase 5a, Track M) the library's counters at the end (port/BotTeleport's teleportSpellStats, BotAction's
         * wrongTurnStats, teleportStats.byCause as { cause, jumps, refused }, alching's and the law runs'; null with an older
         * library), and the alchers the human saw at a trade bank ({ t, name, bank, state }) */
        spells: null,
        wrongTurns: null,
        rescues: null,
        alch: null,
        alchSightings: []
    };
}

// ---- (realism phase 5a, track F: fights, skills and manners) F1 misclicks, F3 forgotten food, D1-D4 deaths, R1-R4
// rudeness (kill- and rock-stealing, rude replies, the arguments) ----
// The runner's record.texture (test/humanlike.mjs collectTexture: the library's port/BotFumble and port/BotRude logs, an
// older library's null: n/a) and its own deaths, fights and White Wolf Mountain crossings. A count under JUDGE_MIN is
// shown, not judged (the band is the record's: null then); F3's count is its forgotten trips, R3's the replies to the
// human (R3_JUDGE_MIN).

export const JUDGE_MIN = 5;
/** D4: a death this soon after the same bot's last is a repeat (30 minutes) */
export const REPEAT_DEATH_TICKS = 3000;
/** R4: a victim's line this soon after the steal counts (15 s) */
export const VICTIM_LINE_TICKS = 25;
/**
 * D3: White Wolf Mountain: its top (the multi-combat mapsquare 0_44_54, where a crossing goes and the wolves pile on), its
 * slopes and foot (port/BotChatter's box: a death there by a wolf counts too); the combat its wolves hunt (2 × 38)
 */
export const WWM_TOP = { x0: 2816, x1: 2879, z0: 3456, z1: 3519 };
export const WWM_BOX = { x0: 2816, x1: 2879, z0: 3436, z1: 3522 };
export const WWM_HUNTED_CB = 76;
export const onWwmTop = (x, z) => x >= WWM_TOP.x0 && x <= WWM_TOP.x1 && z >= WWM_TOP.z0 && z <= WWM_TOP.z1;
const onWwm = (x, z) => x >= WWM_BOX.x0 && x <= WWM_BOX.x1 && z >= WWM_BOX.z0 && z <= WWM_BOX.z1;
const wolvesDeath = d => onWwmTop(d.x, d.z) || (onWwm(d.x, d.z) && /wolf|ice/.test(String(d.by)));

/** the band, or null (report) when fewer than JUDGE_MIN events were counted */
function judged(_r, count, band) {
    return count >= JUDGE_MIN ? band : null;
}
const levellingHours = r => r.levellingTicks / TICKS_PER_HOUR;
/** the levelling bots' fighting time (Combat, RangedMagic), from the vantage samples (C15) */
const fightingHours = r => (r.fights?.samples ?? 0) * (r.meta.sampleEvery ?? 5) / TICKS_PER_HOUR;
/** the levelling bots' mining time (their sessions' time per task kind) */
const miningHours = r => (r.variety ?? []).reduce((sum, v) => sum + (v.kinds?.Mine ?? 0), 0) / TICKS_PER_HOUR;
const levellingDeath = d => LEVELLING.has(d.planner);
const fightKind = d => FIGHT_KINDS.has(d.task);
/** D1's deaths: levelling bots' outside a fight (at a skill, on an errand, walking) */
export function deathsOutside(r) {
    return r.deaths.filter(d => levellingDeath(d) && !fightKind(d) && !duelLoss(d));
}
const countText = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function deathsOutsideFights(r) {
    const hours = levellingHours(r);
    if (!hours) return { value: null };
    const odd = deathsOutside(r);
    const others = r.deaths.filter(d => !levellingDeath(d) && !fightKind(d) && !duelLoss(d));
    const duels = r.deaths.filter(duelLoss).length;
    const byTask = {};
    for (const d of r.deaths) byTask[d.task] = (byTask[d.task] ?? 0) + 1;
    const value = round((100 * odd.length) / hours, 2);
    return {
        value,
        shown: `${value} (${countText(odd.length, 'death')})`,
        detail: `${countText(odd.length, 'death')} of levelling bots outside a fight in ${round(hours)} levelling bot-hours${odd.length ? `: ${odd.slice(0, 4).map(d => `t${d.t} ${d.name} (${d.task}) by ${d.by} at ${d.x},${d.z}`).join('; ')}` : ''}${others.length ? `; others' outside a fight ${others.length}` : ''}${duels ? `; ${countText(duels, 'duel lost', 'duels lost')} left out (the Duel Arena's: 274 keeps the loser's items)` : ''}; all deaths ${r.deaths.length} (${Object.entries(byTask).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})${dangerText(r)}`
    };
}

/** the danger check's decisions (port/BotFumble dangerStats: an older library's none) */
const dangerText = r => {
    const d = r.texture?.danger;
    return d ? `; the danger check: ate ${d.eat}, fetched food ${d.fetch}, left to heal ${d.leave}, went on (careless) ${d.goOn}` : '';
};

export function deathsInFights(r) {
    const hours = fightingHours(r);
    if (!hours) return { value: null };
    const list = r.deaths.filter(d => levellingDeath(d) && (d.task === 'Combat' || d.task === 'RangedMagic') && !duelLoss(d));
    const pk = r.deaths.filter(d => d.task === 'PKer' || d.task === 'EdgevillePKer');
    const value = round((100 * list.length) / hours, 2);
    return { value, shown: `${value} (${countText(list.length, 'death')})`, detail: `${countText(list.length, 'death')} of levelling fighters in ${round(hours)} fighting bot-hours${list.length ? `: ${list.slice(0, 4).map(d => `t${d.t} ${d.name} (${d.task}) by ${d.by}`).join('; ')}` : ''}; PKers' deaths (the PK rules, not judged) ${pk.length}` };
}

export function wolvesDeaths(r) {
    const crossings = (r.texture?.wwm?.crossings ?? []).filter(c => c.cb <= WWM_HUNTED_CB);
    if (!r.texture?.wwm) return { value: null };
    const deaths = r.deaths.filter(wolvesDeath);
    if (!crossings.length) return { value: null, detail: `no crossing by a bot its wolves hunt (combat ${WWM_HUNTED_CB} or less)${deaths.length ? `; ${countText(deaths.length, 'death')} there` : ''}` };
    const value = round((100 * deaths.length) / crossings.length, 1);
    const tasks = {};
    for (const c of crossings) tasks[c.task ?? '?'] = (tasks[c.task ?? '?'] ?? 0) + 1;
    return { value, shown: `${value} (${countText(deaths.length, 'death')} in ${countText(crossings.length, 'crossing')})`, detail: `White Wolf Mountain: ${countText(crossings.length, 'crossing')} by bots of combat ${WWM_HUNTED_CB} or less (${(r.texture.wwm.crossings ?? []).length} by any; ${Object.entries(tasks).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(', ')}), ${countText(deaths.length, 'death')} there${deaths.length ? `: ${deaths.slice(0, 3).map(d => `t${d.t} ${d.name} by ${d.by}`).join('; ')}` : ''}` };
}

export function repeatDeaths(r) {
    const list = r.deaths.filter(d => levellingDeath(d) && !duelLoss(d)).sort((a, b) => a.t - b.t);
    if (!list.length) return { value: null };
    const last = new Map();
    let repeats = 0;
    for (const d of list) {
        const before = last.get(d.name);
        if (before !== undefined && d.t - before <= REPEAT_DEATH_TICKS) repeats++;
        last.set(d.name, d.t);
    }
    const value = pct(repeats, list.length);
    return { value, shown: `${value} % (${repeats} of ${list.length})`, detail: `${repeats} of ${countText(list.length, 'death')} of levelling bots within 30 min of the same bot's last` };
}

export function misclicks(r) {
    const hours = levellingHours(r);
    const list = r.texture?.fumbles;
    if (!hours || !list) return { value: null };
    const byKind = {};
    for (const f of list) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    const bots = new Set(list.map(f => f.name)).size;
    return { value: round(list.length / hours, 2), detail: `${list.length} misclicks by ${bots} bots in ${round(hours)} levelling bot-hours (${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}): an empty rock, a busy NPC, a tree of another kind` };
}

/** F3's forgotten trips: the bank stops with food in the bank that left with none (and none carried already) */
const forgottenTrips = r => (r.texture?.food ?? []).filter(f => f.took === 'none' && f.carried === 0);

export function forgottenFood(r) {
    const list = r.texture?.food;
    if (!list || !list.length) return { value: null };
    const none = forgottenTrips(r);
    const few = list.filter(f => f.took === 'few').length;
    const bots = new Set(none.map(f => f.name)).size;
    return { value: pct(none.length, list.length), detail: `${none.length} of ${list.length} fighters' bank stops with food in the bank left with none${none.length ? ` (by ${countText(bots, 'bot')})` : ''}; ${few} with only 2-4` };
}

/** the deliberate kill-steals (a rude bot's) and the other takes a victim bot noticed */
const steals = (r, kind) => (r.texture?.incidents ?? []).filter(i => i.kind === kind && i.deliberate);

export function killSteals(r) {
    const hours = fightingHours(r);
    if (!r.texture?.incidents || !hours) return { value: null };
    const list = steals(r, 'ks');
    const all = r.texture.incidents.filter(i => i.kind === 'ks');
    const onHuman = list.filter(i => i.victimHuman).length;
    const multi = list.filter(i => i.multi).length;
    const value = round((100 * list.length) / hours, 2);
    return { value, shown: `${value} (${countText(list.length, 'steal')})`, detail: `${countText(list.length, 'kill-steal')} by rude bots in ${round(hours)} fighting bot-hours (on the human ${onHuman}, in multi-combat ${multi}); NPCs another player took first, as their victim bots saw it, ${all.length - list.length}` };
}

export function killStealsOnHuman(r) {
    const work = r.texture?.work;
    if (!work || !work.cowTicks || !r.texture.incidents) return { value: null };
    const hours = work.cowTicks / TICKS_PER_HOUR;
    const list = steals(r, 'ks').filter(i => i.victimHuman);
    const value = round(list.length / hours, 2);
    return { value, shown: `${value} (${countText(list.length, 'steal')})`, detail: `${countText(list.length, 'kill-steal')} on the human in ${round(hours * 60)} minutes of its fighting (${work.cowClicks} cows clicked)` };
}

export function rockSteals(r) {
    const hours = miningHours(r);
    if (!r.texture?.incidents || !hours) return { value: null };
    const list = steals(r, 'rock');
    const c = r.texture.courtesy ?? {};
    const work = r.texture.work;
    const value = round((100 * list.length) / hours, 2);
    return { value, shown: `${value} (${countText(list.length, 'steal')})`, detail: `${countText(list.length, 'rock steal')} by rude miners in ${round(hours)} mining bot-hours (no free rock ${list.filter(i => i.how === 'none-free').length}, a lazy one ${list.filter(i => i.how === 'lazy').length}; the human's ${list.filter(i => i.victimHuman).length}); the human's rock: passed over ${c.passedOver ?? 0} picks (another free), shared ${c.shared ?? 0} (none free), taken ${c.stolen ?? 0}${work ? `; the human mined ${round(work.mineTicks / TICKS_PER_MINUTE)} minutes (${work.rockClicks} rocks clicked)` : ''}` };
}

/**
 * R3 is judged from this many replies to the human (a talk run's 20-30 hold a rude one or none, by chance: 3-12 % of 20 is
 * under one; the probe run's 190 hold 6-23): fewer are shown, not judged, as a count under 5 is
 */
export const R3_JUDGE_MIN = 100;
/** the bots' replies to the human, public and private */
function repliesToHuman(r) {
    const human = String(r.texture?.humanName ?? '').toLowerCase();
    return [...r.lines.filter(l => l.kind === 'reply' && l.to === 'human').map(l => ({ name: l.name, text: l.text })), ...(r.pms ?? []).filter(p => p.from && p.from !== human.replaceAll(' ', '_')).map(p => ({ name: p.from, text: p.text }))];
}

export function rudeReplyShare(r) {
    const rude = r.texture?.rudeReplies;
    if (!rude) return { value: null };
    const said = new Map();
    for (const x of rude) said.set(`${x.name}|${normalized(x.text)}`, (said.get(`${x.name}|${normalized(x.text)}`) ?? 0) + 1);
    const replies = repliesToHuman(r);
    if (!replies.length) return { value: null };
    let n = 0;
    const examples = [];
    for (const x of replies) {
        const key = `${x.name}|${normalized(x.text)}`;
        if ((said.get(key) ?? 0) > 0) {
            said.set(key, said.get(key) - 1);
            n++;
            if (examples.length < 4) examples.push(x.text);
        }
    }
    return { value: pct(n, replies.length), detail: `${n} of ${replies.length} replies to the human (public and private) rude${examples.length ? `: ${examples.map(t => JSON.stringify(t)).join(', ')}` : ''}` };
}

/** R4's incidents: a bot victim's, noticed (it gave its NPC up; its rock emptied by the stealer); an older record: all */
const noticedByBot = r => (r.texture?.incidents ?? []).filter(i => !i.victimHuman && (i.noticed === undefined || i.noticed >= 0));

export function argumentLines(r) {
    const list = noticedByBot(r);
    if (!r.texture?.incidents || !list.length) return { value: null };
    const lined = list.filter(i => i.victimLine >= 0 && i.victimLine - (i.noticed ?? i.tick) <= VICTIM_LINE_TICKS);
    const withLine = list.filter(i => i.victimLine >= 0 && !i.stealerHuman);
    const answered = withLine.filter(i => i.stealerLine >= 0).length;
    const victim = pct(lined.length, list.length);
    const answer = withLine.length ? pct(answered, withLine.length) : null;
    const meant = list.filter(i => i.deliberate).length;
    return {
        value: victim,
        shown: `${victim} % (${answer === null ? 'n/a' : `${answer} %`})`,
        ok: victim >= 20 && victim <= 60 && (answer === null || (answer >= 10 && answer <= 40)),
        detail: `${lined.length} of ${list.length} steals and takes from bots that the victim noticed (${meant} meant; ${list.filter(i => i.kind === 'rock').length} rocks) with its line within 15 s; ${answered} of ${withLine.length} lines with a bot stealer answered (band 10-40 %); never more than the two lines (port/BotChatter.argue)`
    };
}

if (!GROUPS.texture) GROUPS.texture = 'Fallible bots (realism phase 5a)';
if (!GROUPS.rudeness) GROUPS.rudeness = 'Manners (realism phase 5a)';
METRICS.push(
    ...[
        ['F1', 'texture', 'Misclicks per levelling bot-hour (empty rock, busy NPC, wrong tree)', '', () => between(0.5, 3), 'proposed', misclicks],
        ['F3', 'texture', "Fighters' bank trips without food while food was banked", '%', r => judged(r, forgottenTrips(r).length, between(3, 12)), 'proposed', forgottenFood],
        ['D2', 'leaving', 'Deaths in a fight per 100 fighting bot-hours (levelling fighters)', '', r => judged(r, r.deaths.filter(d => levellingDeath(d) && (d.task === 'Combat' || d.task === 'RangedMagic')).length, max(5)), 'proposed', deathsInFights],
        ['D3', 'leaving', 'White Wolf Mountain deaths per 100 crossings by bots it hunts', '', r => judged(r, (r.texture?.wwm?.crossings ?? []).filter(c => c.cb <= WWM_HUNTED_CB).length, max(5)), 'proposed', wolvesDeaths],
        ['D4', 'leaving', 'Repeat deaths: the same levelling bot within 30 min, of its deaths', '%', r => judged(r, r.deaths.filter(d => levellingDeath(d) && !duelLoss(d)).length, max(10)), 'proposed', repeatDeaths],
        ['R1', 'rudeness', 'Kill-steals per 100 fighting bot-hours', '', r => judged(r, steals(r, 'ks').length, between(1, 6)), 'proposed', killSteals],
        ['R1h', 'rudeness', "Kill-steals on the human per hour of the human's fighting (--work)", '', r => judged(r, steals(r, 'ks').filter(i => i.victimHuman).length, max(2)), 'proposed', killStealsOnHuman],
        ['R2', 'rudeness', 'Rock steals by rude miners per 100 mining bot-hours', '', r => judged(r, steals(r, 'rock').length, between(1, 8)), 'proposed', rockSteals],
        ['R3', 'rudeness', "Rude replies among bots' replies to the human", '%', r => (repliesToHuman(r).length >= R3_JUDGE_MIN ? between(3, 12) : null), 'proposed', rudeReplyShare],
        ['R4', 'rudeness', "Steals with a victim's line within 15 s (and a stealer's answer after one)", '%', r => judged(r, noticedByBot(r).length, between(20, 60)), 'proposed', argumentLines]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of track F's block ----
// ---- random events (realism phase 5a, track E: port/BotRandomEvents) ----
// The runner subscribes to the library's randomEventListeners (an older library has none: every RE metric is n/a) and
// keeps `record.randomEvents`: { notes: [{ t, name, type, kind, humanDist, move, ticks, fallback, stat, xp }], drops:
// [{ t, name, left }] (a tool head or a rod of a bot's on the ground: still there at 99 ticks, one before 274 reveals it
// to everyone), moves: [{ t, name, move, xpAt, gone }] (the fail teleport, the maze and the mime out, the unseen
// fallbacks: the bot's first XP after it, or its logout) }. Under RE_FEW samples a share is not judged (n/a, the count in
// the detail): a 2-hour run sees a handful of events.
export const RE_NEAR = 15;
export const RE_FAR = 20;
export const RE_FEW = 5;
/** the NPC events a bot answers (RE6) */
export const RE_NPC_KINDS = new Set(['genie', 'oldman', 'dwarf', 'triffid']);
/** RE3: a lamp rubbed within 5 minutes; RE5: back at an XP task within 10 minutes */
export const RE_LAMP_TICKS = 500;
export const RE_BACK_TICKS = 1000;

function reNotes(r) {
    return r.randomEvents?.notes ?? null;
}
const reHours = r => Math.max(1, r.meta.ticks - (r.meta.warmup ?? 0)) / TICKS_PER_HOUR;
function countBy(list, key) {
    const m = {};
    for (const x of list) m[x[key]] = (m[x[key]] ?? 0) + 1;
    return Object.entries(m)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
}

/** RE1: random events started on bots within 15 tiles of the human, an hour (by kind; the 16-20 band and the empty ones apart) */
export function eventsNearHuman(r) {
    const notes = reNotes(r);
    if (!notes) return { value: null };
    const starts = notes.filter(n => n.type === 'start');
    const real = starts.filter(n => n.kind !== 'none');
    const near = real.filter(n => n.humanDist <= RE_NEAR);
    const band = real.filter(n => n.humanDist > RE_NEAR && n.humanDist <= RE_FAR).length;
    const armed = notes.filter(n => n.type === 'armed').length;
    const disarmed = countBy(notes.filter(n => n.type === 'disarmed'), 'reason');
    const rolls = r.randomEvents?.rolls;
    const rollText = rolls ? `; ${rolls.rolls} rolls: ${rolls.candidates} bots near, ${rolls.eligible} eligible (${rolls.still ?? 0} still 1,000 ticks; not: ${Object.entries(rolls.why).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}), ${rolls.won} won, ${rolls.deferred ?? 0} held for the cap, ${rolls.capped} capped` : '';
    return {
        value: round(near.length / reHours(r)),
        detail: `${near.length} events within ${RE_NEAR} tiles in ${round(reHours(r))} h${near.length ? ` (${countBy(near, 'kind')})` : ''}; ${band} at 16-20 tiles; ${starts.length - real.length} flags spent with nothing spawned; ${armed} armed, disarmed: ${disarmed || 'none'}${rollText}`
    };
}

/** RE2: fail teleports seen (the poof within 15 tiles of the human), an hour */
export function failTeleportsSeen(r) {
    const notes = reNotes(r);
    if (!notes) return { value: null };
    const fails = notes.filter(n => n.type === 'move' && n.move === 'fail');
    const seen = fails.filter(n => n.humanDist <= RE_NEAR);
    const rec = notes.filter(n => n.type === 'recovered');
    const fallbacks = rec.filter(n => n.fallback).length;
    const ticks = rec.map(n => n.ticks).sort((a, b) => a - b);
    return {
        value: round(seen.length / reHours(r), 2),
        detail: `${seen.length} of ${fails.length} fail teleports within ${RE_NEAR} tiles${fails.length ? ` (landed ${fails.slice(0, 4).map(n => (n.to ?? []).join(',')).join('; ')})` : ''}; back on the ground ${rec.length} (median ${ticks.length ? ticks[Math.floor(ticks.length / 2)] : '-'} ticks), the unseen fallback ${fallbacks}`
    };
}

/** RE3: lamps rubbed within 5 minutes of the genie's gift (lamps got in the run's last 5 minutes left out) */
export function lampsRubbed(r) {
    const notes = reNotes(r);
    if (!notes) return { value: null };
    const got = notes.filter(n => n.type === 'lamp-got' && n.t <= r.meta.ticks - RE_LAMP_TICKS);
    let quick = 0;
    const skills = [];
    for (const g of got) {
        const rub = notes.find(n => n.type === 'lamp-rubbed' && n.name === g.name && n.t >= g.t);
        if (rub && rub.t - g.t <= RE_LAMP_TICKS) quick++;
        if (rub) skills.push({ skill: rub.stat });
    }
    const detail = `${quick} of ${got.length} lamps rubbed within 5 min${skills.length ? ` (${countBy(skills, 'skill')})` : ''}`;
    if (got.length < RE_FEW) return { value: null, detail: `${detail}: fewer than ${RE_FEW}, not judged` };
    return { value: pct(quick, got.length), detail };
}

/** RE4: events started on bots more than 20 tiles from every human (must be none) */
export function eventsFar(r) {
    const notes = reNotes(r);
    if (!notes) return { value: null };
    const far = notes.filter(n => n.type === 'start' && n.kind !== 'none' && !(n.humanDist <= RE_FAR));
    return { value: far.length, detail: `${far.length} events on bots more than ${RE_FAR} tiles from every human${far.length ? `: ${far.slice(0, 3).map(n => `t${n.t} ${n.name} ${n.kind} at ${n.humanDist}`).join('; ')}` : ''}` };
}

/**
 * RE5: levelling bots back at an XP-earning task within 10 minutes of an event move (the fail teleport, the maze and the
 * mime out; vendors, social bots and PKers earn none: left out)
 */
export function backAfterMoves(r) {
    const all = r.randomEvents?.moves;
    if (!all) return { value: null };
    const moves = all.filter(m => !m.planner || LEVELLING.has(m.planner));
    const judged = moves.filter(m => m.t <= r.meta.ticks - RE_BACK_TICKS && !(m.gone >= 0 && m.xpAt < 0));
    const back = judged.filter(m => m.xpAt >= 0 && m.xpAt - m.t <= RE_BACK_TICKS);
    const gone = moves.filter(m => m.gone >= 0 && m.xpAt < 0).length;
    const detail = `${back.length} of ${judged.length} levelling bots' moves (${countBy(moves, 'move') || 'none'}) followed by XP within 10 min; ${gone} logged out first; ${all.length - moves.length} of other bots left out`;
    if (judged.length < RE_FEW) return { value: null, detail: `${detail}: fewer than ${RE_FEW}, not judged` };
    return { value: pct(back.length, judged.length), detail };
}

/** RE6: NPC events (the genie, the old man, the dwarf, the triffid) answered */
export function npcEventsAnswered(r) {
    const notes = reNotes(r);
    if (!notes) return { value: null };
    const starts = notes.filter(n => n.type === 'start' && RE_NPC_KINDS.has(n.kind) && n.t <= r.meta.ticks - 200);
    const answered = starts.filter(s => notes.some(n => n.type === 'answered' && n.name === s.name && n.t >= s.t && n.t - s.t <= 400));
    const detail = `${answered.length} of ${starts.length} NPC events answered${starts.length ? ` (${countBy(starts, 'kind')})` : ''}`;
    if (starts.length < RE_FEW) return { value: null, detail: `${detail}: fewer than ${RE_FEW}, not judged` };
    return { value: pct(answered.length, starts.length), detail };
}

/** RE7: tool heads or rods of bots still on the ground one tick before 274 reveals them (must be none) */
export function dropsLeft(r) {
    const drops = r.randomEvents?.drops;
    if (!drops) return { value: null };
    const left = drops.filter(d => d.left === true);
    return { value: left.length, detail: `${left.length} of ${drops.length} tool heads and rods left until revealed${left.length ? `: ${left.slice(0, 3).map(d => `t${d.t} ${d.name}`).join('; ')}` : ''}` };
}

GROUPS.randomEvents = 'Random events (realism phase 5a)';
METRICS.push(
    ...[
        ['RE1', 'randomEvents', 'Random events started on bots within 15 tiles of the human, an hour', '', () => between(2, 10), 'proposed', eventsNearHuman],
        ['RE2', 'randomEvents', 'Fail teleports seen (the poof within 15 tiles), an hour', '', () => null, 'report', failTeleportsSeen],
        ['RE3', 'randomEvents', 'Lamps rubbed within 5 min', '%', () => min(80), 'proposed', lampsRubbed],
        ['RE4', 'randomEvents', 'Events on bots more than 20 tiles from every human', '', () => max(0), 'proposed', eventsFar],
        ['RE5', 'randomEvents', 'Levelling bots back at an XP task within 10 min of an event move', '%', () => min(90), 'proposed', backAfterMoves],
        ['RE6', 'randomEvents', 'NPC events answered (genie, old man, dwarf, triffid)', '%', () => between(60, 85), 'proposed', npcEventsAnswered],
        ['RE7', 'randomEvents', 'Tool heads or rods left on the ground until revealed', '', () => max(0), 'proposed', dropsLeft]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of track E's (phase 5a) block ----
// ---- (realism phase 5b, Track D: the director and groups) V1-V4 the director,
// G2-G5 groups on the move ----
// The runner keeps `record.setPieces` (test/humanlike.mjs: port/BotDirector's directorLog, port/BotTrains' trainsLog and
// its own samples every 5 ticks; an older library has neither module: every metric n/a):
//   events  [{ id, kind, venue, start, startPlay, end, outcome, recruits: [{ name, role, left, back }], rumours: [{ t, name, nearHuman }] }]
//   seen    [{ id, t }]: a bot with a part in a running event within 15 tiles of the human at its peak (a sample)
//   groups  [{ t, size, names }]: a line of 3+ following each other (the game's Follow) with one within 15 tiles of the
//           human; the same group again only after 10 minutes
//   capes   [{ id, name, match }]: each clan walker once a walk, at its peak: its cape the walk's colour
//   piles   [{ t, human, n, multi }]: 2+ bots attacking one player in the Wilderness for 3 samples in a row (15 ticks:
//           longer than a click or two the game refuses in single-combat), an episode a target per 100 ticks
//   brief   [{ t, multi }]: the shorter ones (a click the game refused: "Someone else is already fighting your opponent.")
//   trains  [{ start, end, members, human, reason }]
// A share is judged from SP_FEW samples (fewer: the count shown, not judged); V1 on runs of 2 hours or more. A library with
// the foundation's stubs (an A/B run) has no director's or trains' log: `noDirector`, `noTrains`, and V1-V4, G4 n/a.
export const SP_FEW = 5;
export const SP_V1_TICKS = 12000;
/** the run's play hours: the human is in the world all along (the director's clock is the play clock) */
const spHours = r => Math.max(1, r.meta.ticks) / TICKS_PER_HOUR;
const spCount = (list, key) => countBy(list, key);

/** V1: notable events (the director's) an hour of play */
export function eventsPerHour(r) {
    const sp = r.setPieces;
    if (!sp || sp.noDirector) return { value: null };
    const ev = sp.events;
    const ended = ev.filter(e => e.end >= 0);
    const first = ev[0] ? `the first at ${round(ev[0].startPlay / 100)} min of play` : 'none started';
    return {
        value: round(ev.length / spHours(r), 2),
        shown: `${round(ev.length / spHours(r), 2)} (${ev.length} in ${round(spHours(r))} h)`,
        detail: `${ev.length} events (${spCount(ev, 'kind') || 'none'}): ${first}; outcomes ${spCount(ended, 'outcome') || '-'}${r.meta.ticks < SP_V1_TICKS ? `; judged on runs of ${SP_V1_TICKS / 6000} h or more` : ''}`
    };
}

/** V2: events the human saw (a part's bot within 15 tiles at the peak) or heard of (a rumour within 15 tiles), an hour */
export function eventsNoticed(r) {
    const sp = r.setPieces;
    if (!sp || sp.noDirector) return { value: null };
    const seen = new Set(sp.seen.map(s => s.id));
    const heard = new Set();
    for (const e of sp.events) {
        const names = new Set(e.rumours.map(x => x.name));
        const until = (e.end >= 0 ? e.end : r.meta.ticks) + 300;
        if (r.lines.some(l => l.kind === 'rumour' && l.humanDist <= VIEW && names.has(l.name) && l.t >= e.start && l.t <= until)) heard.add(e.id);
    }
    const either = new Set([...seen, ...heard]);
    const rumours = sp.events.reduce((n, e) => n + e.rumours.length, 0);
    return { value: round(either.size / spHours(r), 2), detail: `${either.size} of ${sp.events.length} events: seen ${seen.size}, heard of ${heard.size} (${rumours} rumours said, ${sp.events.reduce((n, e) => n + e.rumours.filter(x => x.nearHuman).length, 0)} near the human)` };
}

/** V3: recruits back at their own doings 2 minutes after the event's end (the director's look: no part, a task, moving or working) */
export function recruitsBack(r) {
    const sp = r.setPieces;
    if (!sp || sp.noDirector) return { value: null };
    const all = sp.events.flatMap(e => e.recruits);
    const looked = all.filter(x => x.back === true || x.back === false);
    const back = looked.filter(x => x.back === true).length;
    const detail = `${back} of ${looked.length} recruits back within 2 min (${all.filter(x => x.left !== null).length} left mid-event, ${all.filter(x => x.back === null).length} out of the world by then)`;
    if (looked.length < SP_FEW) return { value: looked.length ? pct(back, looked.length) : null, detail: `${detail}: fewer than ${SP_FEW}, not judged` };
    return { value: pct(back, looked.length), detail };
}

/** V4: recruits who logged out mid-event */
export function recruitLogouts(r) {
    const sp = r.setPieces;
    if (!sp || sp.noDirector) return { value: null };
    const all = sp.events.flatMap(e => e.recruits);
    const out = all.filter(x => x.left === 'logout').length;
    const detail = `${out} of ${all.length} recruits logged out mid-event (other ways out: ${spCount(all.filter(x => x.left !== null && x.left !== 'logout'), 'left') || 'none'})`;
    if (all.length < SP_FEW) return { value: all.length ? pct(out, all.length) : null, detail: `${detail}: fewer than ${SP_FEW}, not judged` };
    return { value: pct(out, all.length), detail };
}

/** G2: groups of 3+ following one another seen by the human, an hour */
export function groupsSeen(r) {
    const sp = r.setPieces;
    if (!sp) return { value: null };
    const sizes = sp.groups.map(g => g.size);
    return { value: round(sp.groups.length / spHours(r), 2), detail: `${sp.groups.length} groups of 3+ in a line near the human (sizes ${sizes.join(', ') || '-'})${sp.groups.length ? `, e.g. ${sp.groups[0].names.join(' > ')}` : ''}` };
}

/** G3: clan walkers wearing their walk's cape colour (each once a walk, at its peak) */
export function clanCapes(r) {
    const sp = r.setPieces;
    if (!sp) return { value: null };
    const match = sp.capes.filter(c => c.match).length;
    const walks = new Set(sp.capes.map(c => c.id)).size;
    const detail = `${match} of ${sp.capes.length} walkers of ${walks} clan walks in its colour`;
    if (sp.capes.length < SP_FEW) return { value: sp.capes.length ? pct(match, sp.capes.length) : null, detail: `${detail}: fewer than ${SP_FEW}, not judged` };
    return { value: pct(match, sp.capes.length), detail };
}

/** G4: newbie follow trains an hour of play, and their length */
export function followTrains(r) {
    const sp = r.setPieces;
    if (!sp || sp.noTrains) return { value: null };
    const done = sp.trains.filter(t => t.end >= 0);
    const minutes = done.map(t => (t.end - t.start) / 100);
    return { value: round(sp.trains.length / spHours(r), 2), detail: `${sp.trains.length} trains (${sp.trains.filter(t => t.human).length} behind the human); length median ${minutes.length ? round(median(minutes)) : '-'} min; newbies ${done.map(t => t.members.length).join(', ') || '-'}; ended: ${spCount(done, 'reason') || '-'}` };
}

/** G5: PK piles (2+ bots on one player in the Wilderness for 15 ticks or more), an hour; those in a single-combat zone must be none */
export function pkPiles(r) {
    const sp = r.setPieces;
    if (!sp) return { value: null };
    const single = sp.piles.filter(p => !p.multi).length;
    const onHuman = sp.piles.filter(p => p.human).length;
    const most = sp.piles.reduce((m, p) => Math.max(m, p.n), 0);
    const first = sp.piles.find(p => !p.multi) ?? sp.piles[0];
    const example = first?.by ? `; e.g. t${first.t} ${first.target} at ${first.at.join(',')}${first.multi ? '' : ' (single)'} by ${first.by.join(', ')}` : '';
    const brief = sp.brief ?? [];
    const briefNote = `; shorter (a click the game refused): ${brief.filter(b => !b.multi).length} in single-combat, ${brief.filter(b => b.multi).length} in multi`;
    return { value: single, shown: `${single} in single-combat (${round(sp.piles.length / spHours(r), 2)} piles an hour)`, detail: `${sp.piles.length} piles (${onHuman} on the human), at most ${most} on one; ${single} in a single-combat zone${example}${briefNote}` };
}

GROUPS.setPieces = 'Set pieces (realism phase 5b)';
METRICS.push(
    ...[
        ['V1', 'setPieces', 'Notable events (the director) an hour of play', '', r => (r.meta.ticks >= SP_V1_TICKS ? between(0.5, 1.5) : null), 'decided', eventsPerHour],
        ['V2', 'setPieces', 'Events the human saw or heard of, an hour', '', () => null, 'report', eventsNoticed],
        ['V3', 'setPieces', 'Recruits back at their own doings within 2 min of the end', '%', r => ((r.setPieces?.events ?? []).flatMap(e => e.recruits).filter(x => x.back === true || x.back === false).length >= SP_FEW ? min(90) : null), 'proposed', recruitsBack],
        ['V4', 'setPieces', 'Recruits who logged out mid-event', '%', r => ((r.setPieces?.events ?? []).flatMap(e => e.recruits).length >= SP_FEW ? max(10) : null), 'proposed', recruitLogouts],
        ['G2', 'setPieces', 'Groups of 3+ moving together seen by the human, an hour (a group again after 10 min)', '', () => null, 'report', groupsSeen],
        ['G3', 'setPieces', "Clan walkers wearing their clan's cape colour", '%', r => ((r.setPieces?.capes ?? []).length >= SP_FEW ? min(80) : null), 'proposed', clanCapes],
        ['G4', 'setPieces', 'Newbie follow trains an hour of play (and their length)', '', () => null, 'report', followTrains],
        ['G5', 'setPieces', 'PK piles (2+ bots on one player for 15 ticks+) in a single-combat zone (and piles an hour)', '', () => max(0), 'decided', pkPiles]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of Track D's (phase 5b) block ----
// ---- (realism phase 5b, track P: parties, scams and lures: DP1-DP5
// R1-R5 renamed, the human's fair share among them (DP3b); K1-K4) ----
// The runner's record.parties (port/BotParty partyLog: per party its kind, venue, guests, peak crowd, piles with their
// reveal and who took them when, the chest, the pops, the bots stuck 10 minutes on), record.scams (port/BotScams scamLog:
// per stint its calls, warnings, answers, the human's trade requests), record.lures (tasks/SocialTask: the human's
// approaches and lures by form) and record.partyHuman (a forced party's human scramble: --party). An older library has
// none: n/a. A party forced by the runner (--party) is left out of DP1. Rare in a 2-hour run (the director's beat: a
// party every 3-4 hours of play): a count under JUDGE_MIN is shown, not judged; DP2-DP5 judge each party's own numbers.

/**
 * the set pieces' sub-tasks (the runner records a bot with a part in a piece by its sub-task's kind): a stand in one is the
 * piece's (H19 leaves it out, as a hang-out's)
 */
export const SET_PIECE_TASK_KINDS = new Set(['PartyGuest', 'PartyHost', 'ScamCall', 'Callout', 'DuelArena']);
/** DP3b: a pile taken this soon after it showed counts as snapped up (10 ticks: 6 s) */
export const DP_QUICK_TICKS = 10;
/** K2: a warning this soon after a call answers it (60 s), within this many tiles */
export const SCAM_ANSWER_TICKS = 100;
export const SCAM_ANSWER_TILES = 15;

const partyHours = r => Math.max(1, r.meta.ticks - (r.meta.warmup ?? 0)) / TICKS_PER_HOUR;
const directorParties = r => (r.parties ?? []).filter(p => !p.forced);
/** the F2P drop parties' piles that 274 showed to everyone */
const revealedPiles = r => (r.parties ?? []).filter(p => p.kind === 'drop_party').flatMap(p => p.drops.filter(d => d.revealAt >= 0));
// (a party still running when the run ended is left out: its pops and its chest are a part of a party's)
const roomParties = r => (r.parties ?? []).filter(p => p.kind === 'party_room' && p.lever && p.chest && p.chest.after > p.chest.before && p.outcome !== 'running');

export function partiesPerHour(r) {
    if (!r.parties) return { value: null };
    const list = directorParties(r);
    const value = round(list.length / partyHours(r), 2);
    const forced = r.parties.length - list.length;
    const notForced = (r.partyHuman?.forced ?? []).filter(f => !f.started).map(f => `${f.kind} at ${f.venue}: ${f.why ?? 'not begun'}`);
    return { value, shown: `${value} (${countText(list.length, 'party', 'parties')})`, detail: `${countText(list.length, 'party', 'parties')} begun by the director in ${round(partyHours(r))} h (${countBy(list, 'kind') || 'none'}; outcomes ${countBy(list, 'outcome') || 'none'})${forced ? `; ${forced} forced by the runner, left out` : ''}${notForced.length ? `; forced, not begun: ${notForced.join('; ')}` : ''}` };
}

export function guestsAtPeak(r) {
    const list = (r.parties ?? []).filter(p => p.outcome === 'done');
    if (!r.parties || !list.length) return { value: null, detail: r.parties ? `${r.parties.length} parties, none done` : '' };
    const peaks = list.map(p => p.peak).sort((a, b) => a - b);
    const value = peaks[Math.floor(peaks.length / 2)];
    return { value, shown: `${value} (${countText(list.length, 'party', 'parties')})`, detail: `bots within 8 tiles of the venue at the peak, the median of ${list.length} (${peaks.join(', ')}); guests asked ${list.map(p => p.asked).join(', ')}, came ${list.map(p => p.came).join(', ')}` };
}

export function itemsRevealed(r) {
    const list = (r.parties ?? []).filter(p => p.kind === 'drop_party' && p.drops.length);
    if (!list.length) return { value: null };
    const counts = list.map(p => p.drops.filter(d => d.revealAt >= 0).length);
    const value = round(counts.reduce((a, b) => a + b, 0) / counts.length, 1);
    return { value, detail: `piles shown to everyone per drop party (${counts.join(', ')}); worth ${list.map(p => p.kitValue).join(', ')} of budgets ${list.map(p => p.budget).join(', ')}` };
}

export function quickTakes(r) {
    const piles = revealedPiles(r);
    if (!piles.length) return { value: null };
    const quick = piles.filter(d => d.by === 'bot' && d.goneAt - d.revealAt <= DP_QUICK_TICKS);
    const human = r.partyHuman?.takes ?? [];
    const value = pct(quick.length, piles.length);
    return {
        value,
        shown: `${value} % (${quick.length} of ${piles.length})`,
        detail: `${quick.length} of ${piles.length} piles taken by bots within ${DP_QUICK_TICKS} ticks of showing; by bots ${piles.filter(d => d.by === 'bot').length}, by others (the human, a passer-by) ${piles.filter(d => d.by === 'other').length}, left to vanish ${piles.filter(d => d.by === 'despawned').length}${human.length || r.partyHuman?.clicks ? `; the scrambling human took ${human.length} (${r.partyHuman.clicks} clicks), ${human.length ? `${median(human.map(t => t.afterReveal))} ticks after showing (median)` : ''}` : ''}`
    };
}

export function roomPops(r) {
    const list = roomParties(r);
    if (!list.length) return { value: null, detail: (r.parties ?? []).some(p => p.kind === 'party_room') ? `Party Room parties without a pull: ${countBy((r.parties ?? []).filter(p => p.kind === 'party_room'), 'outcome')}` : '' };
    const pops = list.map(p => p.pops.host + p.pops.guests);
    const left = list.map(p => (p.chest.end - p.chest.before) / (p.chest.after - p.chest.before));
    const value = round(pops.reduce((a, b) => a + b, 0) / pops.length, 1);
    const leftPct = pct(left.reduce((a, b) => a + b, 0), left.length);
    return { value, shown: `${value} pops (${leftPct} % left)`, ok: value >= 30 && value <= 120 && leftPct <= 30, detail: `balloons popped by bots per Party Room party (${pops.join(', ')}; the host's ${list.map(p => p.pops.host).join(', ')}), the chest's slots left after ${leftPct} % (band 30 % at most), items to the poppers ${list.map(p => p.pops.items).join(', ')}; knights ${list.filter(p => p.knights).length}` };
}

export function stuckAtVenue(r) {
    const list = (r.parties ?? []).filter(p => p.stuckAfter >= 0);
    if (!list.length) return { value: null };
    const value = list.reduce((n, p) => n + p.stuckAfter, 0);
    return { value, detail: `bots of ${countText(list.length, 'party', 'parties')} still at the venue, where they stood when it ended, 10 minutes on` };
}

export function scamHeard(r) {
    if (!r.scams) return { value: null };
    const heard = r.lines.filter(l => l.kind === 'scam' && l.humanDist <= VIEW);
    // (a stint the runner forced is counted apart from the world's own: ambient, spree)
    const kinds = r.scams.map(s => ({ kind: s.forced ? 'forced by the runner' : s.kind }));
    const moved = r.scams.filter(s => s.outcome === 'moved').length;
    return { value: round(heard.length / partyHours(r), 2), detail: `${heard.length} scam lines heard; ${countText(r.scams.length, 'stint')} in the world (${countBy(kinds, 'kind') || 'none'}; ${r.scams.reduce((n, s) => n + s.calls, 0)} calls, ${r.scams.filter(s => s.mod).length} ended by the player-mod bot${moved ? `, ${moved} by the caller moved off` : ''})` };
}

export function scamWarned(r) {
    if (!r.scams) return { value: null };
    const calls = r.lines.filter(l => l.kind === 'scam' && l.to === null);
    if (!calls.length) return { value: null, detail: 'no scam calls' };
    let answered = 0;
    for (const c of calls) {
        if (r.lines.some(l => l.kind === 'setpiece' && l.toName === c.name && l.t > c.t && l.t - c.t <= SCAM_ANSWER_TICKS && l.level === c.level && Math.max(Math.abs(l.x - c.x), Math.abs(l.z - c.z)) <= SCAM_ANSWER_TILES)) answered++;
    }
    const value = pct(answered, calls.length);
    return { value, shown: `${value} % (${answered} of ${calls.length})`, detail: `${answered} of ${calls.length} scam calls followed by a bot's warning to the caller within 60 s; at most 4 a stint (the defaults: 0.3 a call)` };
}

export function scamTrades(r) {
    if (!r.scams) return { value: null };
    const n = r.scams.reduce((s, x) => s + x.tradeRequests, 0);
    return { value: n, detail: `trade requests to scam callers, each turned down in words with no window (items moved: none, test/scams.test.mjs's K3)` };
}

export function lureForms(r) {
    if (!r.lures) return { value: null };
    const approaches = r.lures.approaches.length;
    const lures = r.lures.lures;
    const forms = {};
    for (const l of lures) forms[l.form] = (forms[l.form] ?? 0) + 1;
    const top = Math.max(0, ...Object.values(forms));
    const share = lures.length ? pct(top, lures.length) : null;
    const perHour = round(approaches / partyHours(r), 2);
    const detail = `${approaches} approaches to the human (${perHour} an hour), ${countText(lures.length, 'lure')} (${Object.entries(forms).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; to a waiting PK team ${lures.filter(l => l.ambush).length}); the most common form's share judged from ${JUDGE_MIN} lures`;
    return { value: share, shown: share === null ? null : `${share} % (${perHour} approaches/h)`, detail };
}

if (!GROUPS.parties) GROUPS.parties = 'Parties, scams and lures (realism phase 5b)';
METRICS.push(
    ...[
        ['DP1', 'parties', 'Parties per hour of play (the director\'s; drop parties and the Party Room)', '', r => judged(r, directorParties(r).length, between(0.3, 0.8)), 'proposed', partiesPerHour],
        ['DP2', 'parties', "Bots at a party's peak (within 8 tiles; 100 bots)", '', r => (r.meta.bots <= 100 ? between(5, 20) : null), 'proposed', guestsAtPeak],
        ['DP3', 'parties', 'F2P drop party piles shown to everyone, per party', '', () => between(10, 28), 'proposed', itemsRevealed],
        ['DP3b', 'parties', 'Piles taken by bots within 10 ticks of showing (the human\'s fair share)', '%', r => (revealedPiles(r).length >= 6 ? max(60) : null), 'proposed', quickTakes],
        ['DP4', 'parties', 'Party Room: balloons popped by bots per party; the chest\'s slots left after', '', () => between(30, 120), 'proposed', roomPops],
        ['DP5', 'parties', 'Party bots stuck at the venue 10 min after it ended', '', () => max(0), 'proposed', stuckAtVenue],
        ['K1', 'parties', 'Scam calls heard by the human, an hour', '', () => null, 'report', scamHeard],
        ['K2', 'parties', "Scam calls answered by a bot's warning within 60 s", '%', r => judged(r, r.lines.filter(l => l.kind === 'scam' && l.to === null).length, min(30)), 'proposed', scamWarned],
        ['K3', 'parties', 'Trade requests to scam callers (no window opens: items moved 0, the unit test)', '', () => null, 'report', scamTrades],
        ['K4', 'parties', "Lures: the most common form's share (and the approaches to the human an hour)", '%', r => ((r.lures?.lures.length ?? 0) >= JUDGE_MIN ? max(40) : null), 'proposed', lureForms]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of track P's block ----
// ---- the Duel Arena and the player-mod bot (realism phase 5b, track A: port/BotArena, port/BotDuel, port/BotModBot; spec
// the research) ----
// The runner keeps `record.arena` on a members world with the arena's library (else every A metric is n/a): { samples,
// inArena, online, max (the bots in the complex every 5 ticks: A1), humanTicks (the human's ticks in the challenge area:
// A6's time), duels: BotArena.duelLog [{ id, a, b, human, stake, rules, start, end, winner, outcome, forfeit, spectators,
// tomatoes, big }], challenges: BotArena.challengeLog [{ t, bot, human, answer, from }], cap }; and `record.modBot` with
// the mod's library: { samples, online (samples with a mod online), crowned: [{ t, name, rights, mod }] (every crowned
// line: Q3), humanSpam (the --mod probe's lines), log: BotModBot.modLog [{ t, mod, what, who, human, spamAt }], spam:
// BotModBot.spamLog [{ t, who, human, what, x, z, level }], mods }. Under ARENA_FEW duels a share is shown, not judged.
export const ARENA_FEW = 3;
/** A6 is judged on 10 minutes or more of the human in the challenge area */
export const ARENA_HUMAN_MIN = 1000;
/** Q2: a mod's line answers spam said within this many ticks before it and this many tiles from it */
export const MOD_SPAM_TICKS = 100;
export const MOD_SPAM_TILES = 25;

const arenaHours = r => Math.max(1, r.meta.ticks - (r.meta.warmup ?? 0)) / TICKS_PER_HOUR;
/** the duels that came to a fight in the run (after the warm-up) */
function duelsFought(r) {
    return (r.arena?.duels ?? []).filter(d => d.start >= 0 && d.start >= (r.meta.warmup ?? 0));
}

/** A1: bots in the Duel Arena per 100 online (members, the time average) */
export function arenaPopulation(r) {
    const a = r.arena;
    if (!a || !r.meta.members || !a.samples) return { value: null };
    // (the visits: levelling sessions with time at a DuelArena task; H19's stands in those sessions, the arena's own left
    // out: a check that a visit leaves no idle stand behind it)
    const visited = new Set((r.variety ?? []).filter(v => (v.kinds?.[DUEL_ARENA_KIND] ?? 0) > 0).map(v => v.s));
    const h19 = (r.idleStands ?? []).filter(st => LEVELLING.has(st.planner) && st.len >= 200 && st.len <= 1000 && st.kind !== HANGOUT_KIND && st.kind !== DUEL_ARENA_KIND);
    const after = h19.filter(st => visited.has(st.s)).length;
    // (the planner's asks: visits offered, or why not; port/BotArena.visitStats, an older library has none)
    const asks = a.asks ? `; the planner asked ${a.asks.asked} times, ${a.asks.offered} visits (not: ${Object.entries(a.asks.why).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})` : '';
    return { value: round(a.online ? (100 * a.inArena) / a.online : 0, 1), detail: `${round(a.inArena / a.samples, 1)} bots in the complex on average, ${round(a.online / a.samples)} online; at most ${a.max} at once (room for ${a.cap}); ${visited.size} levelling sessions with a visit, H19's stands in them ${after} of ${h19.length}${asks}` };
}

/** A2: duels that came to a fight, an hour of play (members; judged at 100 bots) */
export function duelsPerHour(r) {
    if (!r.arena || !r.meta.members) return { value: null };
    const d = duelsFought(r);
    const human = d.filter(x => x.human).length;
    const big = d.filter(x => x.big).length;
    const done = d.filter(x => x.winner).length;
    return { value: round(d.length / arenaHours(r), 1), detail: `${d.length} duels fought in ${round(arenaHours(r))} h (${done} with a winner${human ? `, ${human} with the human` : ''}${big ? `, ${big} big stakes` : ''})` };
}

/** A3: duels with a stake (%); A3b: their median stake */
export function stakedShare(r) {
    if (!r.arena || !r.meta.members) return { value: null };
    const d = duelsFought(r);
    const staked = d.filter(x => x.stake > 0);
    const detail = `${staked.length} of ${d.length} duels staked${staked.length ? ` (${staked.map(x => x.stake).sort((a, b) => a - b).slice(0, 8).join(', ')}${staked.length > 8 ? ' ...' : ''})` : ''}`;
    if (d.length < ARENA_FEW) return { value: null, detail: `${detail}: fewer than ${ARENA_FEW}, not judged` };
    return { value: pct(staked.length, d.length), detail };
}
export function medianStake(r) {
    if (!r.arena || !r.meta.members) return { value: null };
    const staked = duelsFought(r).filter(x => x.stake > 0).map(x => x.stake);
    if (staked.length < ARENA_FEW) return { value: null, detail: `${staked.length} staked duels: fewer than ${ARENA_FEW}, not judged` };
    return { value: quantile(staked, 0.5), shown: `${round(quantile(staked, 0.5) / 1000, 1)}k`, detail: `median of ${staked.length} stakes; ${round(quantile(staked, 0.1) / 1000, 1)}k-${round(quantile(staked, 0.9) / 1000, 1)}k (p10-p90)` };
}

/** A4: watchers within 10 tiles of a duel (the most during its fight, outside the arenas), the median */
export function duelSpectators(r) {
    if (!r.arena || !r.meta.members) return { value: null };
    const d = duelsFought(r);
    const detail = `${d.length} duels: ${d.map(x => x.spectators).sort((a, b) => a - b).join(', ') || 'none'}`;
    if (d.length < ARENA_FEW) return { value: null, detail: `${detail}: fewer than ${ARENA_FEW}, not judged` };
    return { value: quantile(d.map(x => x.spectators), 0.5), detail };
}

/** A5: rotten tomatoes thrown at a duel, the mean */
export function duelTomatoes(r) {
    if (!r.arena || !r.meta.members) return { value: null };
    const d = duelsFought(r);
    const total = d.reduce((n, x) => n + (x.tomatoes ?? 0), 0);
    const detail = `${total} tomatoes at ${d.length} duels (${d.filter(x => x.tomatoes > 0).length} with some)`;
    if (d.length < ARENA_FEW) return { value: null, detail: `${detail}: fewer than ${ARENA_FEW}, not judged` };
    return { value: round(total / d.length, 2), detail };
}

/** A6: the bots' challenges to the human per 10 minutes of the human in the challenge area (--arena) */
export function humanChallenges(r) {
    const a = r.arena;
    if (!a || !r.meta.members) return { value: null };
    // (a challenge 274 never sent, a fence between them, is none the human got)
    const mine = a.challenges.filter(c => (c.from === 'bot' || c.from === 'call') && c.answer !== 'unreached');
    const answers = countBy(mine.map(c => ({ a: c.answer || 'waiting' })), 'a');
    // (why the stakers near them did not: a staker and the human a count, from port/BotArena.challengeStats; older: none)
    const why = a.why ? Object.entries(a.why.why).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(', ') : '';
    const unreached = a.challenges.filter(c => c.answer === 'unreached').length;
    const detail = `${mine.length} challenges in ${round(a.humanTicks / 100, 1)} min in the challenge area${mine.length ? ` (${answers})` : ''}; the human's own ${a.challenges.filter(c => c.from === 'human').length}${unreached ? `; ${unreached} never reached them` : ''}${why ? `; stakers passed them over: ${why}` : ''}`;
    if (a.humanTicks < ARENA_HUMAN_MIN) return { value: null, detail: `${detail}: under ${ARENA_HUMAN_MIN / 100} min there (--arena), not judged` };
    return { value: round((mine.length * 1000) / a.humanTicks, 2), detail };
}

/** Q1: the player-mod bot's duty lines (kind mod) the human heard, an hour of a mod online */
export function modLinesHeard(r) {
    const m = r.modBot;
    if (!m) return { value: null };
    const online = (m.online * (r.meta.sampleEvery ?? 5)) / TICKS_PER_HOUR;
    const lines = r.lines.filter(l => l.kind === 'mod');
    const heard = lines.filter(l => l.humanDist <= VIEW);
    if (online <= 0) return { value: null, detail: `no mod online (${m.mods.join(', ') || 'none picked'})` };
    return { value: round(heard.length / online, 2), detail: `${heard.length} of ${lines.length} duty lines heard, a mod online ${round(online, 1)} h (${m.mods.join(', ')})${heard.length ? `, e.g. "${heard[0].shown}"` : ''}` };
}

/** Q2: the mod's duty lines that answer spam said within 60 s before them and 25 tiles from them */
export function modAnswersSpam(r) {
    const m = r.modBot;
    if (!m) return { value: null };
    const lines = r.lines.filter(l => l.kind === 'mod');
    const real = lines.filter(l => m.spam.some(s => s.level === l.level && l.t - s.t >= 0 && l.t - s.t <= MOD_SPAM_TICKS && Math.max(Math.abs(s.x - l.x), Math.abs(s.z - l.z)) <= MOD_SPAM_TILES));
    // (what came of the spam: told, or why no mod did; an older library logs no 'heard')
    const untold = m.spam.filter(s => s.heard && s.heard !== 'told');
    const heard = m.spam.some(s => s.heard) ? `; told ${m.spam.filter(s => s.heard === 'told').length}, not: ${countBy(untold, 'heard') || 'none'}` : '';
    const detail = `${real.length} of ${lines.length} duty lines after spam (${m.spam.length} spam heard: ${countBy(m.spam, 'what') || 'none'}; the human's ${m.spam.filter(s => s.human).length}${heard})`;
    if (lines.length === 0) return { value: null, detail };
    return { value: pct(real.length, lines.length), detail };
}

/** Q3: crowned lines from bots that are no mod (the silver crown is the mod's alone) */
export function crownedNonMods(r) {
    const m = r.modBot;
    if (!m) return { value: null };
    const wrong = m.crowned.filter(c => !c.mod || c.rights !== 1);
    return { value: wrong.length, detail: `${wrong.length} of ${m.crowned.length} crowned lines from a bot that is no mod${wrong.length ? `: ${wrong.slice(0, 3).map(c => `${c.name} ${c.rights}`).join('; ')}` : ''}` };
}

GROUPS.arena = 'The Duel Arena and the player-mod bot (realism phase 5b)';
METRICS.push(
    ...[
        ['A1', 'arena', 'Bots in the Duel Arena per 100 online (members)', '', () => between(3, 8), 'proposed', arenaPopulation],
        ['A2', 'arena', 'Duels fought an hour of play (members, judged at 100 bots)', '', r => (r.meta.bots <= 150 ? between(4, 20) : null), 'proposed', duelsPerHour],
        ['A3', 'arena', 'Duels with a stake', '%', () => between(60, 85), 'proposed', stakedShare],
        ['A3b', 'arena', 'Median stake', 'gp', () => between(2000, 50000), 'proposed', medianStake],
        ['A4', 'arena', 'Watchers within 10 tiles of a duel (median)', '', () => between(1, 5), 'proposed', duelSpectators],
        ['A5', 'arena', 'Rotten tomatoes thrown at a duel (mean)', '', () => between(0.2, 1.5), 'proposed', duelTomatoes],
        ['A6', 'arena', 'Challenges to the human per 10 min in the challenge area (--arena)', '', () => between(1, 3), 'proposed', humanChallenges],
        ['Q1', 'arena', 'Player-mod duty lines the human heard, an hour of a mod online', '', () => null, 'report', modLinesHeard],
        ['Q2', 'arena', 'Mod duty lines that follow spam within 60 s and 25 tiles', '%', () => min(90), 'proposed', modAnswersSpam],
        ['Q3', 'arena', 'Crowned lines from bots that are no mod', '', () => max(0), 'decided', crownedNonMods]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of track A's (phase 5b) block ----

// ---- (realism phase 7, Track E: the language model) MD1-MD6, from record.model (humanlike --model=stub… or
// --model=http://…: port/BotModel's stats and its log of every reply's story). A run without --model has no record.model
// and none of these: they are computed apart (computeModelMetrics) and stay out of the fingerprint, so a run with no
// model has phase 7's "before" fingerprints. ----
GROUPS.model = 'The language model (realism phase 7)';

/** every answer to the human's lines: the probes (all kinds: public, PM, the follow-ups) and the talk lines; who answered, when */
function everyAnswer(r) {
    const out = [];
    for (const p of r.probes) {
        const pm = p.kind === 'pm' || p.kind === 'pm-followup';
        const a = pm ? r.pms.find(m => m.from === p.bot && m.t > p.t && m.t <= p.t + 40) : r.lines.find(l => l.name === p.bot && l.t > p.t && l.t <= p.t + 30 && REPLY_KINDS.has(l.kind));
        if (a) out.push({ t: p.t, at: a.t, who: pm ? a.from : a.name, pm, latency: a.t - p.t });
    }
    for (const h of r.humanLines) {
        if (afterProbe(r, h.t)) continue;
        const a = r.lines.find(l => l.t > h.t && l.t <= h.t + 30 && REPLY_KINDS.has(l.kind) && l.humanDist <= VIEW + 1);
        if (a) out.push({ t: h.t, at: a.t, who: a.name, pm: false, latency: a.t - h.t });
    }
    return out;
}

/** the answers in the model's words (a log entry said by that bot at that tick, or a tick or two before the chat showed it) and the rules' */
export function modelAnswers(r) {
    const said = (r.model?.log ?? []).filter(e => e.outcome === 'used' && typeof e.saidAt === 'number');
    const model = [];
    const rules = [];
    for (const a of everyAnswer(r)) (said.some(e => e.bot === a.who && a.at >= e.saidAt && a.at - e.saidAt <= 2) ? model : rules).push(a);
    return { model, rules };
}

/** MD1: the replies the model was to write (in its scope, decided) that were said in its words */
export function modelUsedShare(r) {
    const s = r.model?.stats;
    if (!s || !s.eligible) return { value: null };
    return { value: pct(s.used, s.eligible), detail: `${s.used} of ${s.eligible} eligible replies in the model's words (${s.requests} requests; ${s.candidates?.used ?? 0} of them to lines the rules left unanswered)` };
}

const FALLBACKS = ['deadline', 'timeout', 'error', 'busy', 'guard', 'channel', 'superseded', 'unavailable'];
/** MD2: the fallbacks by reason (the rules' line, or nothing, instead) */
export function modelFallbacks(r) {
    const s = r.model?.stats;
    if (!s || !s.eligible) return { value: null };
    const n = Object.values(s.fallbacks ?? {}).reduce((a, b) => a + b, 0);
    const by = FALLBACKS.map(k => `${k} ${s.fallbacks?.[k] ?? 0}`).join(', ');
    const errors = Object.entries(s.errors ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
    return { value: n, shown: `${n} (${pct(n, s.eligible)} %)`, detail: `${by}${errors ? `; native's errors: ${errors}` : ''}; ${s.late ?? 0} answers came too late` };
}

/** the stub's planted bad lines, and those the guard refused */
function plantedLines(r) {
    const planted = (r.model?.log ?? []).filter(e => e.planted);
    return { planted, caught: planted.filter(e => e.outcome === 'guard') };
}

/** MD3: the guard's refusals by reason; with the stub, its planted bad lines all caught */
export function modelGuardRefusals(r) {
    const s = r.model?.stats;
    if (!s || !s.requests) return { value: null };
    const n = Object.values(s.guard ?? {}).reduce((a, b) => a + b, 0);
    const by = Object.entries(s.guard ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    const { planted, caught } = plantedLines(r);
    const unplanted = (r.model?.log ?? []).filter(e => e.outcome === 'guard' && !e.planted);
    const missed = planted.filter(e => e.outcome !== 'guard');
    const stubText = planted.length ? `; the stub planted ${planted.length} bad lines, ${caught.length} caught (${caught.filter(e => e.reason === e.planted).length} for the planted reason)${missed.length ? `, missed: ${missed.slice(0, 3).map(e => `${e.planted} "${e.raw}" ${e.outcome}`).join('; ')}` : ''}` : '';
    const unplannedText = unplanted.length ? `; refused of the model's own: ${unplanted.length}, e.g. ${unplanted.slice(0, 3).map(e => `"${e.raw}" (${e.reason})`).join('; ')}` : '';
    return { value: n, shown: `${n} (${pct(n, s.requests)} %)`, ok: planted.length ? missed.length === 0 : undefined, detail: `${by}${stubText}${unplannedText}` };
}

/** MD4: the delay from the human's line to the reply, the model's against the rules' (the rules' band 2-26 ticks) */
export function modelDelay(r) {
    if (!r.model) return { value: null };
    const { model, rules } = modelAnswers(r);
    if (!model.length) return { value: null, detail: `no model reply matched (${rules.length} rules' replies)` };
    const q = (xs, p) => quantile(xs.map(a => a.latency), p);
    const [m10, m50, m90] = [0.1, 0.5, 0.9].map(p => q(model, p));
    const rulesText = rules.length ? `the rules' ${[0.1, 0.5, 0.9].map(p => q(rules, p)).join('/')} (${rules.length})` : "no rules' replies";
    const out = model.filter(a => a.latency < 2 || a.latency > (a.pm ? 40 : 26));
    return { value: m50, shown: `${m10}-${m90} ticks`, ok: m10 >= 2 && m90 <= 26, detail: `model replies p10/p50/p90 ${m10}/${m50}/${m90} ticks (${model.length}: ${model.filter(a => a.pm).length} PMs); ${rulesText}; outside 2-26 (PMs 40): ${out.length}` };
}

/** MD5: model requests an hour of play (the cost of the online mode) */
export function modelRequestsPerHour(r) {
    const s = r.model?.stats;
    if (!s) return { value: null };
    const hours = r.meta.ticks / TICKS_PER_HOUR;
    return { value: round(s.requests / hours), detail: `${s.requests} requests in ${round(hours, 2)} h of play; latency p50/p90 ${quantile(s.latency ?? [], 0.5) ?? '-'}/${quantile(s.latency ?? [], 0.9) ?? '-'} ticks` };
}

/** MD6: lines the rules left unanswered (a named line, a PM, a conversation's line, a reply-window answer, a question to nobody) that got a model reply */
export function modelCandidates(r) {
    const c = r.model?.stats?.candidates;
    if (!c) return { value: null };
    const by = Object.entries(c.byVia ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    return { value: c.used, detail: `${c.used} said in the model's words of ${c.eligible} taken to it (${c.requests} requests; by the way they came: ${by})` };
}

export const MODEL_METRICS = [
    ['MD1', 'model', "Replies to the human in the model's words, of its eligible replies", '%', () => min(90), 'proposed', modelUsedShare],
    ['MD2', 'model', 'Fallbacks (deadline, timeout, error, busy, guard, no channel, superseded)', '', () => null, 'report', modelFallbacks],
    ['MD3', 'model', "Guard refusals (the stub: its planted bad lines all caught)", '', r => (plantedLines(r).planted.length ? { min: 0 } : null), 'proposed', modelGuardRefusals],
    ['MD4', 'model', "Reply delay, the human's line to a model reply (the rules' band 2-26)", 'ticks', () => between(2, 26), 'proposed', modelDelay],
    ['MD5', 'model', 'Model requests an hour of play (the cost of online)', '', () => null, 'report', modelRequestsPerHour],
    ['MD6', 'model', 'Lines the rules left unanswered that got a model reply', '', () => null, 'report', modelCandidates]
].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }));

/** MD1-MD6 of a record with a model (none without one: they are not in the fingerprint) */
export function computeModelMetrics(record) {
    if (!record.model) return [];
    return MODEL_METRICS.map(m => {
        const res = m.fn(record) ?? { value: null };
        const band = m.basis === 'report' ? null : m.band(record);
        const ok = res.value === null || res.value === undefined ? null : band ? (res.ok ?? inBand(res.value, band)) : null;
        return { id: m.id, group: m.group, title: m.title, unit: m.unit, basis: m.basis, band, value: res.value ?? null, shown: res.shown ?? null, ok, detail: res.detail ?? '', data: res.data };
    });
}
// ---- end of Track E's (phase 7) block ----

// ---- (variety round 1: each track's metrics in a block of its own, read from record.tracks.<track>, n/a when it
// is missing) ----
// ---- (variety round 1, Track F: fixes and movement) ----
// record.tracks.fixes (test/humanlike.mjs's Track F block): the fill's rescue jumps (TP4f), the gatherers' walks about
// with no target (AM6), the futile bank loops (AM7), the failure messages (FM1); and from the record the runner keeps
// anyway: the parties' asked guests who came (DP2b), the trains' length (G4b). n/a when record.tracks.fixes is missing
// (an older library, an A/B run) or the run had none of it.

const fixesOf = r => r.tracks?.fixes ?? null;
/** the gatherer task kinds of AM6 (BotTaskBase gatherStats) */
export const GATHER_KINDS = ['Mine', 'Woodcut', 'Fletching', 'Fish'];

/**
 * TP4f: the unseen rescue jumps from the fill's first login through its window (5 minutes), per 100 bots (the
 * investigation's count: 30-68 at 100 bots, 191 at 500; target 5 or less). Detail: by cause, refused in sight, TP4 after
 * the window (per 100 bot-hours), the world tick's p95 in the fill's boost and after.
 */
export function fillJumps(r) {
    const f = fixesOf(r)?.fill;
    if (!f || f.jumps === null || f.start < 0) return { value: null };
    const bots = r.meta.bots || 1;
    const value = round((100 * f.jumps) / bots, 1);
    const causes = Object.entries(f.causes ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const afterHours = Math.max(0, r.botTicks - f.botTicks) / TICKS_PER_HOUR;
    const after = afterHours > 0 ? round((100 * (f.allJumps - f.jumps)) / afterHours, 1) : null;
    const afterCauses = Object.entries(f.allCauses ?? {}).map(([k, n]) => [k, n - (f.causes?.[k] ?? 0)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return {
        value,
        shown: `${value} (${f.jumps} jumps)`,
        detail: `${f.jumps} rescue jumps in the first ${f.window} ticks from the fill's first login (t${f.start}), ${f.refused} refused in sight${causes.length ? `; ${causes.map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}; after it ${after ?? '-'} per 100 bot-hours (${f.allJumps - f.jumps} jumps${afterCauses.length ? `: ${afterCauses.map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}); world tick p95 ${f.boostP95 ?? '-'} ms in the fill's boost, ${f.afterP95 ?? '-'} ms after`
    };
}

/** AM6: the gatherers' ticks walking about with no target (a random tile: the old "nothing free" branch, a reposition), of their ticks (BotTaskBase gatherStats); band 5 % at most */
export function gatherWander(r) {
    const g = fixesOf(r)?.gather;
    if (!g) return { value: null };
    let ticks = 0;
    let wander = 0;
    const by = [];
    for (const k of GATHER_KINDS) {
        const t = g.ticks?.[k] ?? 0;
        const w = g.wander?.[k] ?? 0;
        ticks += t;
        wander += w;
        if (t) by.push(`${k} ${pct(w, t)} % (waiting ${pct(g.wait?.[k] ?? 0, t)} %)`);
    }
    if (!ticks) return { value: null };
    const value = pct(wander, ticks);
    return { value, detail: `${wander} of ${ticks} gatherer ticks walking about with no target; ${by.join(', ')}; ${g.waits} waits at a taken rock or tree, ${g.gaveUp} given up (the task ended), ${g.said} with a word` };
}

/** AM7: futile bank loops: three arrivals in a row at a bank state with the same pack and no XP between (the runner's eyes), per run; band 0 */
export function futileLoops(r) {
    const b = fixesOf(r)?.bank;
    if (!b) return { value: null };
    const guard = b.guard ? `; the library's guard ended ${b.guard.ended} tasks (${Object.entries(b.guard.byTask ?? {}).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})` : '';
    return { value: b.loops.length, detail: `${b.loops.length} loops (${b.futile} futile arrivals of ${b.visits} at a bank state)${b.loops.length ? `: ${b.loops.slice(0, 3).map(l => `t${l.t} ${l.name} (${l.task}/${l.state}) at ${l.at.join(',')}`).join('; ')}` : ''}${guard}` };
}

/** DP2b: the asked guests of the parties done who came (reached the venue); band 90 % or more, judged from JUDGE_MIN asked */
export function guestsCame(r) {
    const list = (r.parties ?? []).filter(p => p.outcome === 'done');
    if (!r.parties || !list.length) return { value: null };
    const asked = list.reduce((n, p) => n + p.asked, 0);
    const came = list.reduce((n, p) => n + p.came, 0);
    if (!asked) return { value: null };
    const value = pct(came, asked);
    const extra = list.map(p => `${p.venue}: asked ${p.asked}, came ${p.came}${p.retries !== undefined ? `, retried ${p.retries}, lost ${p.lost}, replaced ${p.replaced}, walk-ins ${p.walkIns} (${p.walkInsCame} came), peak ${p.peak}` : ''}`);
    return { value, shown: `${value} % (${came} of ${asked})`, detail: extra.join('; ') };
}

/** G4b: the newbie follow trains' members (every one that joined), the median; band 2 or more, judged from 3 trains */
export function trainLength(r) {
    const sp = r.setPieces;
    if (!sp || sp.noTrains) return { value: null };
    const done = (sp.trains ?? []).filter(t => t.end >= 0 && t.members.length > 0);
    if (!done.length) return { value: null };
    const lengths = done.map(t => t.members.length).sort((a, b) => a - b);
    const value = lengths[Math.floor(lengths.length / 2)];
    return { value, shown: `${value} (${countText(done.length, 'train')})`, detail: `members ${lengths.join(', ')}` };
}

/** FM1 (report): the failure messages bots got (can't reach, can't light a fire here, too full, stunned), an hour of the world; the detail by task and message */
export function failureMessages(r) {
    const m = fixesOf(r)?.messages;
    if (!m) return { value: null };
    const hours = r.meta.ticks / TICKS_PER_HOUR;
    const list = Object.entries(m).sort((a, b) => b[1].n - a[1].n);
    const total = list.reduce((n, [, o]) => n + o.n, 0);
    const top = list.slice(0, 5).map(([k, o]) => {
        const at = Object.entries(o.at).sort((a, b) => b[1] - a[1])[0];
        return `${k} ${round(o.n / hours)}/h${at ? ` (most at ${at[0]} x${at[1]})` : ''}`;
    });
    return { value: round(total / hours), detail: `${total} in ${round(hours)} h; ${top.join('; ') || 'none'}` };
}

if (!GROUPS.fixes) GROUPS.fixes = 'Fixes and movement (variety round 1)';
METRICS.push(
    ...[
        ['TP4f', 'fixes', 'Rescue jumps in the 5 minutes from a fill, per 100 bots', '', () => max(5), 'proposed', fillJumps],
        ['AM6', 'fixes', 'Gatherers walking about with no target (share of their ticks)', '%', () => max(5), 'proposed', gatherWander],
        ['AM7', 'fixes', 'Futile bank loops (3 visits in a row, nothing moved, no XP)', '', () => max(0), 'proposed', futileLoops],
        ['DP2b', 'fixes', "Asked party guests who came", '%', r => judged(r, (r.parties ?? []).filter(p => p.outcome === 'done').reduce((n, p) => n + p.asked, 0), min(90)), 'proposed', guestsCame],
        ['G4b', 'fixes', 'Newbie follow trains: members (median)', '', r => ((r.setPieces?.trains ?? []).filter(t => t.end >= 0 && t.members.length > 0).length >= 3 ? min(2) : null), 'proposed', trainLength],
        ['FM1', 'fixes', 'Failure messages bots get (can\'t reach, no fire here, too full, stunned), an hour', '', () => null, 'report', failureMessages]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of Track F's (variety) block ----
// ---- (variety round 1, Track D: what and where) ----
// What the bots do and where (the plan's new measures; warn-only): the 2004
// mix of levelling time (AM1, AM1b), crowding on a spot (AM2, AM2b), the 2004 places with someone in them (AM3, AM3b),
// bots named for an activity doing it (AM4), a relog carrying on (AM5), plans that start far from their spot (AM8,
// AM8f), essence miners (AM9). From record.tracks.d (the runner's Track D block); n/a without it.

/** a task kind's activity group (AM1, AM5): the rest (errands, the bank, hang-outs, set pieces, the arena) is 'other' */
export const ACTIVITY_GROUP = {
    Combat: 'combat', RangedMagic: 'combat', Woodcut: 'woodcutting', Fish: 'fishing', Mine: 'mining', Fletching: 'fletching', BowStringing: 'fletching',
    Thieve: 'thieving', Cook: 'cooking', Smith: 'smithing', Crafting: 'crafting', 'Pick Flax': 'crafting', Agility: 'agility', Runecrafting: 'runecrafting',
    Essence: 'runecrafting', Firemaking: 'firemaking', Herblore: 'herblore'
};
/** the default 2004 mix (the plan's "Defaults"): each group's band, % of levelling time */
export const MIX_BANDS = {
    combat: { min: 30, max: 40 }, woodcutting: { min: 7, max: 13 }, fishing: { min: 6, max: 12 }, mining: { min: 5, max: 11 }, fletching: { max: 8 }, thieving: { max: 6 },
    cooking: { min: 2, max: 7 }, smithing: { min: 2, max: 7 }, crafting: { min: 2, max: 7 }, agility: { min: 1, max: 5 }, runecrafting: { min: 3, max: 7 }, firemaking: { min: 1, max: 5 }
};
/** the groups only a members world has (a free world's are judged by their max only) */
const MEMBERS_GROUPS = new Set(['fletching', 'thieving', 'agility', 'herblore']);
/**
 * a theme's skill (port/BotFavourites) and the task kinds that are it (AM4): its own, and its own supply where the skill
 * works what another gathers (a smith mining its ore, a cook fishing its fish, a firemaker or a fletcher chopping its logs)
 */
export const THEME_KINDS = {
    WOODCUTTING: ['Woodcut'], FISHING: ['Fish'], MINING: ['Mine'], SMITHING: ['Smith', 'Mine'], COOKING: ['Cook', 'Fish'], FLETCHING: ['Fletching', 'BowStringing', 'Woodcut'], THIEVING: ['Thieve'],
    CRAFTING: ['Crafting', 'Pick Flax'], FIREMAKING: ['Firemaking', 'Woodcut'], AGILITY: ['Agility'], RUNECRAFT: ['Runecrafting', 'Essence'], RANGED: ['RangedMagic'], MAGIC: ['RangedMagic']
};
const MEMBERS_THEMES = new Set(['FLETCHING', 'THIEVING', 'AGILITY', 'HERBLORE']);
/** the combat styles' themes (mage, range names): their gear and the style's bias are Track W's and the integrator's, reported apart */
const STYLE_THEMES = new Set(['RANGED', 'MAGIC']);

/**
 * The 2004 places (AM3): boxes [key, x0, z0, x1, z1, flags] (inclusive; the first that holds a tile is its place), from
 * the investigation's prototype (do-where/tools/analyze.py AREAS) with the round's dungeons apart; 'm' members-only,
 * 'f' a far town or a members place round 2 brings bots to (reported, not judged).
 */
export const VARIETY_PLACES = [
    ['dng_edgeville_hill_giants', 3090, 9820, 3130, 9861], ['dng_edgeville_north', 3072, 9862, 3149, 9990], ['dng_varrock_sewers', 3150, 9850, 3300, 9930],
    ['dng_taverley', 2810, 9670, 2980, 9860, 'm'], ['dng_ice_asgarnia', 2980, 9530, 3080, 9600], ['dng_mining_guild', 3016, 9728, 3060, 9757],
    ['dng_dwarven_mine', 2985, 9758, 3075, 9860], ['dng_karamja_volcano', 2816, 9536, 2880, 9664], ['essence_mine', 2870, 4790, 2950, 4870],
    ['runecrafting_altars', 2100, 4780, 2869, 4870], ['dng_zanaris', 2370, 4420, 2500, 4480, 'mf'],
    ['wild_1_5', 2944, 3520, 3392, 3559], ['wild_6_10', 2944, 3560, 3392, 3599], ['wild_11_20', 2944, 3600, 3392, 3679], ['wild_21_30', 2944, 3680, 3392, 3759], ['wild_31_plus', 2944, 3760, 3392, 3999],
    ['lumbridge_castle_courtyard', 3200, 3200, 3236, 3236], ['lumbridge_church_graveyard', 3237, 3195, 3260, 3220], ['lumbridge_east_goblins', 3237, 3221, 3270, 3255],
    ['lumbridge_east_cows_chickens', 3225, 3256, 3275, 3305], ['lumbridge_north_road_general', 3195, 3237, 3236, 3262], ['lumbridge_west_sheep_chickens', 3170, 3237, 3194, 3300],
    ['lumbridge_fred_farm_cows_north', 3150, 3300, 3215, 3345], ['lumbridge_swamp', 3140, 3140, 3260, 3199], ['lumbridge_forest_west', 3130, 3200, 3199, 3236],
    ['draynor_village', 3070, 3220, 3130, 3290], ['draynor_forest_manor', 3070, 3291, 3149, 3390], ['port_sarim', 3005, 3170, 3069, 3270], ['rimmington_mine', 2940, 3180, 3004, 3260],
    ['falador_south_farms', 2930, 3261, 3069, 3311], ['falador_park', 2980, 3360, 3020, 3392], ['falador_east_bank_area', 3000, 3340, 3069, 3359], ['falador_town', 2935, 3312, 3069, 3400],
    ['ice_mountain_dwarven', 2980, 3401, 3049, 3519], ['barbarian_village', 3050, 3400, 3120, 3450], ['edgeville', 3060, 3451, 3130, 3519], ['varrock_west_bank_area', 3170, 3425, 3199, 3460],
    ['varrock_west_trees', 3120, 3392, 3169, 3470], ['lumbridge_north_mill_farms', 3150, 3264, 3224, 3340], ['lumbridge_hamlet_forest', 3120, 3237, 3169, 3263],
    ['falador_taverley_road', 2880, 3320, 2934, 3399], ['varrock_west_mine_road', 3150, 3340, 3199, 3424], ['varrock_square_centre', 3200, 3400, 3239, 3445],
    ['varrock_palace_north', 3195, 3446, 3240, 3519], ['varrock_east', 3240, 3380, 3300, 3519], ['varrock_east_mine_south', 3240, 3320, 3320, 3379],
    ['champions_guild_dark_wizards', 3200, 3320, 3239, 3399], ['al_kharid_mine', 3280, 3260, 3320, 3319], ['al_kharid_town', 3260, 3140, 3330, 3259], ['duel_arena', 3331, 3200, 3400, 3290, 'm'],
    ['desert_south', 3200, 2700, 3500, 3139, 'm'], ['karamja_musa_point', 2880, 3140, 2970, 3200], ['entrana', 2800, 3320, 2880, 3400, 'mf'],
    ['taverley', 2870, 3400, 2945, 3470, 'm'], ['burthorpe', 2870, 3471, 2945, 3600, 'mf'], ['catherby', 2780, 3400, 2869, 3460, 'm'], ['white_wolf_mountain', 2820, 3461, 2869, 3560, 'm'],
    ['seers_flax_field', 2730, 3430, 2779, 3460, 'm'], ['seers_village', 2680, 3461, 2779, 3520, 'm'], ['camelot_castle', 2740, 3470, 2780, 3520, 'm'], ['seers_south_magics', 2680, 3380, 2729, 3460, 'm'],
    ['barbarian_outpost_agility', 2510, 3530, 2570, 3590, 'm'], ['fishing_guild_hemenster', 2570, 3380, 2640, 3440, 'm'], ['moss_giants_west', 2540, 3380, 2569, 3420, 'm'],
    ['ardougne_east_market', 2620, 3260, 2700, 3340, 'm'], ['ardougne_west', 2500, 3260, 2619, 3340, 'm'], ['ardougne_north_farms', 2550, 3341, 2700, 3379, 'm'],
    ['ardougne_south_khazard', 2500, 3140, 2700, 3259, 'mf'], ['yanille', 2530, 3070, 2630, 3110, 'mf'], ['gnome_stronghold', 2380, 3380, 2510, 3520, 'm'],
    ['brimhaven_karamja_west', 2740, 3140, 2830, 3240, 'mf'], ['karamja_south_shilo', 2740, 2850, 2960, 3139, 'mf'], ['canifis_morytania', 3400, 3200, 3800, 3600, 'mf'],
    ['rellekka_fremennik', 2600, 3600, 2800, 3800, 'mf']
].map(([key, x0, z0, x1, z1, flags = '']) => ({ key, x0, z0, x1, z1, members: flags.includes('m'), far: flags.includes('f') }));

/** The 2004 place a tile is in (level 0, a dungeon's below; a members place on a members world only), or null. */
export function varietyPlaceAt(x, z, level, members = true) {
    if (level !== 0 && z < 6400 && !(x >= 2380 && x <= 2510 && z >= 3380 && z <= 3520)) return null; // (the Gnome Stronghold's banks are upstairs)
    for (const p of VARIETY_PLACES) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) return members || !p.members ? p.key : null;
    return null;
}
/** the places a world judges (AM3): not a far one, a members one on a members world only */
export function judgedPlaces(members) {
    return VARIETY_PLACES.filter(p => !p.far && (members || !p.members));
}
/** AM3's band: this share of the judged places with someone 25 % of the time (about 45 of a members world's 63) */
export const PLACES_COVERED_SHARE = 0.7;
export const PLACE_SEEN = 25;

/** AM1: combat's share of levelling time (the 2004 mix's headline: 30-40 %), the other groups in the detail */
export function activityMix(r) {
    const d = r.tracks?.d;
    if (!d?.levellingSamples) return { value: null };
    const share = g => pct(d.groups[g] ?? 0, d.levellingSamples);
    const rows = Object.entries(MIX_BANDS).map(([g, b]) => `${g} ${share(g)}${inBand(share(g), b) ? '' : ' ✗'}`);
    const other = Object.entries(d.kinds).filter(([k]) => !ACTIVITY_GROUP[k]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ${pct(n, d.levellingSamples)}`);
    // (by planner: each one's top kinds)
    const planners = Object.entries(d.byPlanner ?? {}).sort().map(([pl, kinds]) => {
        const n = Object.values(kinds).reduce((a, b) => a + b, 0);
        return `${pl} ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, c]) => `${k} ${pct(c, n)}`).join(' ')}`;
    });
    return { value: share('combat'), detail: `of ${d.levellingSamples} levelling bot-samples: ${rows.join(', ')}; other ${share('other')} (${other.join(', ')})${d.drops ? `; power-dropped loads ${d.drops.loads} (${d.drops.items} items)` : ''}${planners.length ? `; by planner: ${planners.join('; ')}` : ''}`, data: { groups: d.groups } };
}

/** AM1b: the 2004 mix's groups outside their bands (a free world's members groups by their max only) */
export function mixOutOfBand(r) {
    const d = r.tracks?.d;
    if (!d?.levellingSamples) return { value: null };
    const out = [];
    for (const [g, b] of Object.entries(MIX_BANDS)) {
        const v = pct(d.groups[g] ?? 0, d.levellingSamples);
        const band = !r.meta.members && MEMBERS_GROUPS.has(g) ? { max: b.max ?? 100 } : b;
        if (!inBand(v, band)) out.push(`${g} ${v} (${bandText(band, '%')})`);
    }
    return { value: out.length, detail: out.length ? `outside: ${out.join(', ')}` : 'every group within its band' };
}

/** AM2: the share of bots at a spot that work it with 4+ others at the same moment (mean over samples) */
export function spotCrowding(r) {
    const c = r.tracks?.d?.crowd;
    if (!c?.stepBots) return { value: null };
    const spots = Object.entries(c.spots).map(([key, s]) => ({ key, avg: s.bots / c.samples, max: s.max }));
    spots.sort((a, b) => b.avg - a.avg);
    const lumbyMen = Object.entries(c.spots).find(([k]) => k.startsWith('pocket:man@3223,3238'));
    return {
        value: pct(c.inCrowd, c.stepBots),
        detail: `${c.inCrowd} of ${c.stepBots} bot-samples at a spot with 4+ others; busiest (average / most): ${spots.slice(0, 6).map(s => `${s.key} ${round(s.avg, 2)}/${s.max}`).join(', ')}; Lumbridge's men ${lumbyMen ? round(lumbyMen[1].bots / c.samples, 2) : 0} thieves on average; ${spots.length} spots used`
    };
}

/** AM2b: the worst spot's occupants (on average while it has some) against its capacity (port/BotSpots; 20+ samples) */
export function spotOverload(r) {
    const c = r.tracks?.d?.crowd;
    if (!c?.stepBots) return { value: null };
    const rows = Object.entries(c.spots)
        .filter(([, s]) => s.cap && s.samples >= 20)
        .map(([key, s]) => ({ key, ratio: s.bots / s.samples / s.cap, avg: s.bots / s.samples, cap: s.cap }))
        .sort((a, b) => b.ratio - a.ratio);
    if (!rows.length) return { value: null, detail: 'no capacities (an older library)' };
    return { value: round(rows[0].ratio, 2), detail: `occupants while used ÷ capacity: ${rows.slice(0, 5).map(x => `${x.key} ${round(x.avg, 1)}/${x.cap}`).join(', ')}` };
}

/** AM3: the judged 2004 places with someone in them PLACE_SEEN % of the samples or more */
export function placesCovered(r) {
    const pl = r.tracks?.d?.places;
    if (!pl?.samples) return { value: null };
    const judged = judgedPlaces(r.meta.members);
    const covered = judged.filter(p => pct(pl.seen[p.key] ?? 0, pl.samples) >= PLACE_SEEN);
    const far = VARIETY_PLACES.filter(p => p.far && (r.meta.members || !p.members)).map(p => `${p.key} ${pct(pl.seen[p.key] ?? 0, pl.samples)}`);
    const thin = judged.filter(p => !covered.includes(p)).map(p => `${p.key} ${pct(pl.seen[p.key] ?? 0, pl.samples)}`);
    return { value: covered.length, detail: `${covered.length} of ${judged.length} places with someone ${PLACE_SEEN} %+ of the time; the rest (% of samples) ${thin.join(', ') || '-'}; far places (round 2) ${far.join(', ') || '-'}` };
}

/** AM3b: the judged places nobody was ever seen in */
export function placesNeverVisited(r) {
    const pl = r.tracks?.d?.places;
    if (!pl?.samples) return { value: null };
    const never = judgedPlaces(r.meta.members).filter(p => !pl.seen[p.key]);
    return { value: never.length, detail: never.length ? never.map(p => p.key).join(', ') : 'every place had someone' };
}

/** AM4: bots named for an activity (port/BotFavourites themes): the median share of their levelling time on it */
export function themedOnTheme(r) {
    const th = r.tracks?.d?.themes;
    if (!th) return { value: null };
    const all = Object.entries(th).filter(([, t]) => t.n >= 30 && (r.meta.members || !MEMBERS_THEMES.has(t.skill)));
    const list = all.filter(([, t]) => !STYLE_THEMES.has(t.skill));
    if (!list.length) return { value: null, detail: 'no themed bot online long enough' };
    const shares = list.map(([, t]) => (100 * t.on) / t.n);
    const none = shares.filter(x => x === 0).length;
    const ex = list.sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([name, t]) => `${name} ${t.word} ${round((100 * t.on) / t.n, 0)} %`);
    const styles = all.filter(([, t]) => STYLE_THEMES.has(t.skill)).map(([, t]) => (100 * t.on) / t.n);
    return { value: round(median(shares), 1), detail: `${list.length} levelling bots named for a skill (30+ samples): median ${round(median(shares), 1)} %, none at all ${none}; e.g. ${ex.join(', ')}; named for a combat style (range, mage: their gear is Track W's) ${styles.length}, median ${round(median(styles), 1) ?? '-'} %` };
}

/** AM5: a bot's next session starting the activity (group) its last one ended with (sessions with an activity each) */
export function relogCarryOn(r) {
    const ss = r.tracks?.d?.sessions;
    if (!ss) return { value: null };
    const byName = new Map();
    for (const s of ss) {
        if (!byName.has(s.name)) byName.set(s.name, []);
        byName.get(s.name).push(s);
    }
    let pairs = 0;
    let same = 0;
    const changes = {};
    for (const list of byName.values()) {
        list.sort((a, b) => a.firstTick - b.firstTick);
        for (let i = 1; i < list.length; i++) {
            pairs++;
            if (list[i].first === list[i - 1].last) same++;
            else changes[`${list[i - 1].last}>${list[i].first}`] = (changes[`${list[i - 1].last}>${list[i].first}`] ?? 0) + 1;
        }
    }
    if (pairs < 5) return { value: null, detail: `${pairs} relogs with an activity both sides (too few)` };
    const top = Object.entries(changes).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`);
    return { value: pct(same, pairs), detail: `${same} of ${pairs} relogs started the activity the last session ended with${top.length ? `; the others (left > started) ${top.join(', ')}` : ''}` };
}

/** AM8: levelling plans whose spot was 300+ tiles from where the bot took them (by kind in the detail) */
export const FAR_START = 300;
export function farStarts(r) {
    const st = r.tracks?.d?.starts;
    if (!st?.length) return { value: null };
    const by = {};
    for (const s of st) {
        const b = by[s.kind] ?? (by[s.kind] = [0, 0]);
        b[0]++;
        if (s.dist >= FAR_START) b[1]++;
    }
    const far = st.filter(s => s.dist >= FAR_START).length;
    return { value: pct(far, st.length), detail: `${far} of ${st.length} plans started ${FAR_START}+ tiles from their spot; by kind ${Object.entries(by).sort((a, b) => b[1][0] - a[1][0]).map(([k, [n, f]]) => `${k} ${pct(f, n)} % of ${n}`).join(', ')}` };
}
/** AM8f: firemaking's (its lanes near the bank its logs come from) */
export function fireFarStarts(r) {
    const st = r.tracks?.d?.starts?.filter(s => s.kind === 'Firemaking');
    if (!st?.length) return { value: null };
    const far = st.filter(s => s.dist >= FAR_START).length;
    return { value: pct(far, st.length), detail: `${far} of ${st.length} firemaking plans started ${FAR_START}+ tiles from their lane` };
}

/** AM9: essence miners (EssenceTask) per 100 online */
export function essenceMiners(r) {
    const d = r.tracks?.d;
    if (!d?.samples || !d.online) return { value: null };
    return { value: round((100 * d.essence) / d.online, 2), detail: `${round(d.essence / d.samples, 2)} essence miners on average, ${round(d.online / d.samples, 1)} online` };
}

/** AM10 (report): the unseen jumps (the runner's 'jump' class) by task and the place they left from: where walks fail */
export function jumpsByPlace(r) {
    const j = r.tracks?.d?.jumps;
    if (!j) return { value: null };
    const list = Object.entries(j).sort((a, b) => b[1] - a[1]);
    const n = list.reduce((a, [, c]) => a + c, 0);
    return { value: n, detail: list.length ? list.slice(0, 10).map(([k, c]) => `${k} ${c}`).join(', ') : 'none' };
}

GROUPS.activities = 'What they do and where';
METRICS.push(
    ...[
        ['AM1', 'activities', 'Combat share of levelling time (the 2004 mix: each group in the detail)', '%', () => between(30, 40), 'decided', activityMix],
        ['AM1b', 'activities', 'Activity groups outside their 2004 bands', '', () => max(2), 'proposed', mixOutOfBand],
        ['AM2', 'activities', 'Bots at a spot with 4+ others (share of bots at a spot)', '%', r => max(r.meta.bots > 150 ? 30 : 10), 'proposed', spotCrowding],
        ['AM2b', 'activities', 'Occupants ÷ capacity at the worst spot (while used)', '×', () => max(1.5), 'proposed', spotOverload],
        ['AM3', 'activities', `2004 places with someone ${PLACE_SEEN} %+ of the time`, '', r => min(Math.round(PLACES_COVERED_SHARE * judgedPlaces(r.meta.members).length)), 'proposed', placesCovered],
        ['AM3b', 'activities', 'Places never visited (far towns apart)', '', () => max(3), 'proposed', placesNeverVisited],
        ['AM4', 'activities', 'Bots named for an activity: median share of their time on it (or its supply)', '%', () => min(40), 'proposed', themedOnTheme],
        ['AM5', 'activities', 'Relogs that start the activity they left', '%', () => between(40, 70), 'proposed', relogCarryOn],
        ['AM8', 'activities', `Plans that start ${FAR_START}+ tiles from their spot`, '%', () => max(10), 'proposed', farStarts],
        ['AM8f', 'activities', `Firemaking plans that start ${FAR_START}+ tiles from their lane`, '%', () => max(5), 'proposed', fireFarStarts],
        ['AM9', 'activities', 'Essence miners per 100 online', '', () => min(1.5), 'proposed', essenceMiners],
        ['AM10', 'activities', 'Unseen jumps by task and place (where walks fail)', '', () => null, 'report', jumpsByPlace]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of Track D's (variety) block ----
// ---- (variety round 1, Track S: what they say) ----
// From the run's lines (record.lines) and record.tracks.say (test/humanlike.mjs varietySCollect: the chatter's counts,
// port/BotChatter talkStats; each line's meaning key, port/BotLines meaningKey; the death lines' and upstream's keys).
// n/a when record.tracks.say is missing (an older library, an A/B run). W1-W12 (no clash with the earlier ids; W7, W8,
// W10 are round 2's), E3-E4 (the sellers'). Bands warn only (the plan: new measures warn first).
GROUPS.say = 'What they say (variety round 1, track S)';

/** a confused reply: "?", "huh", "wat" (port/BotChat CONFUSED, CONFUSED_RUDE) */
const CONFUSED_REPLY = /^(\?+|huh\??|what\??|wat\??|wut)$/i;
/** a greeting as bots say them (yo, heya, heyy, o hey ...), a name after it or not */
const GREETING_LIKE = /^(he+y+|hi+|hello+|yo+|sup|wassup|heya|hiya|ello|o hey|hey all|hi all)\b/i;
/** the record's tracks.say, or null */
const sayTrack = r => r.tracks?.say ?? null;
/** a line's meaning key (the runner's, from the library; else the normalised text) */
const keyOf = (r, i) => sayTrack(r)?.keys?.[i] ?? normalized(r.lines[i].text);
/** the chatter: what a bot said of its own accord (not trade, a set piece, a reply, PK talk, a social bot's approach) */
const chatterLine = l => kindGroup(l.kind) === 'chatter' || l.kind === 'levelup';

/** W1: a bot's second death line within 10 minutes of its first, with no death between (one death, one line) */
export function secondDeathLines(r) {
    const t = sayTrack(r);
    if (!t?.deathKeys) return { value: null };
    const deathKeys = new Set(t.deathKeys);
    const deaths = new Map();
    for (const d of r.deaths) (deaths.get(d.name) ?? deaths.set(d.name, []).get(d.name)).push(d.t);
    const last = new Map();
    let lines = 0;
    const second = [];
    r.lines.forEach((l, i) => {
        if (!chatterLine(l) || !deathKeys.has(keyOf(r, i))) return;
        lines++;
        const prev = last.get(l.name);
        if (prev && l.t - prev.t <= 1000 && !(deaths.get(l.name) ?? []).some(d => d > prev.t && d <= l.t)) second.push(`${prev.shown} → ${l.shown} (${l.t - prev.t} ticks)`);
        last.set(l.name, l);
    });
    return { value: second.length, detail: `${second.length} of ${lines} death lines were a bot's second for one death within 10 min${second.length ? `: ${second.slice(0, 3).join('; ')}` : ''}` };
}

/** W2: confused replies ("?", "huh") to a bot's greeting (the greeting it answers: the addressee's line in the 60 ticks before) */
export function confusedGreetingReplies(r) {
    if (!sayTrack(r)) return { value: null };
    const lastBy = new Map();
    let confused = 0;
    const toGreeting = [];
    for (const l of r.lines) {
        if (l.kind === 'botreply' && CONFUSED_REPLY.test(l.text.trim())) {
            confused++;
            const before = l.toName ? lastBy.get(l.toName) : null;
            if (before && l.t - before.t <= 60 && GREETING_LIKE.test(before.text.trim())) toGreeting.push(`${before.shown} → ${l.shown}`);
        }
        lastBy.set(l.name, l);
    }
    return { value: toGreeting.length, detail: `${toGreeting.length} confused replies to a bot's greeting (${confused} confused bot replies in all)${toGreeting.length ? `: ${toGreeting.slice(0, 3).join('; ')}` : ''}` };
}

/** W3: the responses said, and what they followed (port/BotSpoke's classes): the share that fit, none after a response */
export function responseFit(r) {
    const t = sayTrack(r);
    if (!t?.talk) return { value: null };
    const resp = t.talk.responses ?? [];
    if (!resp.length) return { value: null, detail: 'no responses said' };
    const GENERIC = new Set(['statement', 'meme', 'complaint', 'brag', 'mishap', 'laugh']);
    const fit = resp.filter(x => x.cls !== 'response' && (x.after ? x.after.includes(x.cls ?? 'statement') : GENERIC.has(x.cls ?? 'statement')));
    const afterResponse = resp.filter(x => x.cls === 'response').length;
    const byCls = {};
    for (const x of resp) byCls[x.cls ?? '-'] = (byCls[x.cls ?? '-'] ?? 0) + 1;
    const hours = (r.meta.ticks ?? 0) / TICKS_PER_HOUR;
    return {
        value: pct(fit.length, resp.length),
        detail: `${resp.length} responses (${hours ? round(resp.length / hours) : '-'} an hour world-wide), ${afterResponse} after a response; they followed ${Object.entries(byCls).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}; e.g. ${resp.slice(0, 6).map(x => `${x.cls}: "${x.text}"`).join('; ')}`
    };
}

/**
 * W4: repeats a human heard within an hour, by meaning (the registry's key): a share of the non-trade lines it heard,
 * its own answers apart (a bot asked the same thing twice answers alike: the probe's)
 */
export function fuzzyRepeatsHeard(r) {
    if (!sayTrack(r)) return { value: null };
    const heardAt = new Map();
    let heard = 0;
    const repeats = [];
    r.lines.forEach((l, i) => {
        if (l.humanDist > VIEW || isAside(l) || REPLY_KINDS.has(l.kind)) return;
        const key = keyOf(r, i);
        if (REFLEX_LINES.has(normalized(l.text)) || REFLEX_LINES.has(key)) return;
        heard++;
        const at = heardAt.get(key);
        if (at !== undefined && l.t - at <= TICKS_PER_HOUR) repeats.push(l.shown);
        heardAt.set(key, l.t);
    });
    if (!heard) return { value: null };
    return { value: pct(repeats.length, heard), detail: `${repeats.length} of ${heard} non-trade lines the human heard repeat one heard within the hour (by meaning)${repeats.length ? `: ${[...new Set(repeats)].slice(0, 4).join(' | ')}` : ''}` };
}

/** W5: lines said with nobody within 15 tiles (no player near, the human farther): idle, level-up and all chatter */
export function loneTalk(r) {
    if (!sayTrack(r)) return { value: null };
    const lone = l => l.near === 0 && l.humanDist > VIEW;
    const idle = r.lines.filter(l => l.kind === 'idle');
    const levelup = r.lines.filter(l => l.kind === 'levelup');
    const chatter = r.lines.filter(chatterLine);
    if (!chatter.length) return { value: null };
    const dropped = sayTrack(r).talk?.loneDropped ?? null;
    return {
        value: pct(chatter.filter(lone).length, chatter.length),
        detail: `alone: idle ${pct(idle.filter(lone).length, idle.length)} % of ${idle.length}, level-up ${pct(levelup.filter(lone).length, levelup.length)} % of ${levelup.length}, all chatter ${chatter.filter(lone).length} of ${chatter.length}${dropped !== null ? `; idle lines held for company and dropped: ${dropped}` : ''}`
    };
}

/** W6: idle and event lines about the bot's moment (its task, target, place or destination: port/BotLines isSpecificLine) */
export function specificShare(r) {
    const t = sayTrack(r)?.talk;
    if (!t) return { value: null };
    const said = t.said.idle + t.said.event;
    if (!said) return { value: null };
    return { value: pct(t.specific.idle + t.specific.event, said), detail: `idle ${t.specific.idle} of ${t.said.idle}, event ${t.specific.event} of ${t.said.event}; lines with slots filled from the bot's state ${t.slots}` };
}

/** W9: the most bots that said one non-reflex idle line (an odd line said by many strangers reads as a script) */
export function speakersPerLine(r) {
    if (!sayTrack(r)) return { value: null };
    const by = new Map();
    r.lines.forEach((l, i) => {
        if (l.kind !== 'idle') return;
        const key = keyOf(r, i);
        if (REFLEX_LINES.has(normalized(l.text)) || REFLEX_LINES.has(key) || key.length < 2) return;
        const e = by.get(key) ?? by.set(key, { names: new Set(), shown: l.shown }).get(key);
        e.names.add(l.name);
    });
    if (!by.size) return { value: null };
    const top = [...by.values()].sort((a, b) => b.names.size - a.names.size);
    const many = top.filter(e => e.names.size >= 3).length;
    return { value: top[0].names.size, detail: `${by.size} idle lines; ${many} said by 3+ bots; most: ${top.slice(0, 5).map(e => `"${e.shown}" ×${e.names.size}`).join(', ')}` };
}

/** W11: per bot, the gap between the shorthand share of its upstream lines and of its 2004 lines (points; bots with 3+ of each) */
export function registerGap(r) {
    const t = sayTrack(r);
    if (!t?.upstreamKeys) return { value: null };
    const upstream = new Set(t.upstreamKeys);
    const per = new Map();
    r.lines.forEach((l, i) => {
        if (l.kind !== 'idle') return;
        const e = per.get(l.name) ?? per.set(l.name, { up: 0, upShort: 0, nw: 0, nwShort: 0 }).get(l.name);
        const short = SLANG2004.test(l.text);
        if (upstream.has(keyOf(r, i))) {
            e.up++;
            if (short) e.upShort++;
        } else {
            e.nw++;
            if (short) e.nwShort++;
        }
    });
    const gaps = [];
    let up = 0, upShort = 0, nw = 0, nwShort = 0;
    for (const e of per.values()) {
        up += e.up;
        upShort += e.upShort;
        nw += e.nw;
        nwShort += e.nwShort;
        if (e.up >= 3 && e.nw >= 3) gaps.push(Math.abs((100 * e.upShort) / e.up - (100 * e.nwShort) / e.nw));
    }
    if (!gaps.length) return { value: null };
    return { value: round(mean(gaps)), detail: `${gaps.length} bots with 3+ of each: shorthand in upstream's lines ${pct(upShort, up)} %, in the 2004 lines ${pct(nwShort, nw)} % (all bots); the research's target: within 10 points` };
}

/** W12: non-trade lines in a colour or with an effect (274's set, 2026-10-18: adverts only, so about none) */
export function chatEffects(r) {
    if (!sayTrack(r)) return { value: null };
    const lines = r.lines.filter(l => !isAside(l));
    if (!lines.length) return { value: null };
    const styled = lines.filter(l => l.colour || l.effect);
    const kinds = {};
    for (const l of styled) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
    return { value: pct(styled.length, lines.length), detail: `${styled.length} of ${lines.length} non-trade lines: ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}` };
}

/** a seller's advert: a vendor's (isAdvert) or a bankstander's, at its stall */
const isSellerAdvert = l => isAdvert(l) || (l.task === 'Bankstand' && l.state === 'idle' && isTrade(l));

/**
 * E3: per seller (a session with 6+ adverts), the coefficient of variation of the gaps between its adverts: the median.
 * (2026-10-18) Hand-typed sellers only: an auto typer keeps time by design (its CV in the detail).
 */
export function advertCadence(r) {
    if (!sayTrack(r)) return { value: null };
    const by = new Map();
    for (const l of r.lines) if (isSellerAdvert(l)) (by.get(`${l.s}`) ?? by.set(`${l.s}`, { task: l.task, ts: [], typer: false }).get(`${l.s}`)).ts.push(l.t);
    for (const l of r.lines) if (l.typer && by.has(`${l.s}`)) by.get(`${l.s}`).typer = true;
    const cvs = { Vendor: [], Bankstand: [], typer: [] };
    for (const { task, ts, typer } of by.values()) {
        if (ts.length < 6) continue;
        const gaps = ts.slice(1).map((t, i) => t - ts[i]);
        const c = cv(gaps);
        if (c !== null) cvs[typer ? 'typer' : task]?.push(c);
    }
    const all = [...cvs.Vendor, ...cvs.Bankstand];
    if (!all.length) return { value: null };
    return { value: round(median(all), 2), detail: `sellers with 6+ adverts: vendors ${cvs.Vendor.length} (median CV ${round(median(cvs.Vendor), 2) ?? '-'}), bankstanders ${cvs.Bankstand.length} (median CV ${round(median(cvs.Bankstand), 2) ?? '-'})${cvs.typer.length ? `; auto typers ${cvs.typer.length} (median CV ${round(median(cvs.typer), 2)}, idle adverts only)` : ''}` };
}

/** E4: distinct adverts per vendor-hour: per vendor session advertising an hour or more, distinct lines ÷ hours; the median */
export function advertVariety(r) {
    if (!sayTrack(r)) return { value: null };
    const by = new Map();
    // (2026-10-18: hand-typed vendors: an auto typer says its one line)
    for (const l of r.lines) if (isAdvert(l) && !l.typer) (by.get(l.s) ?? by.set(l.s, []).get(l.s)).push(l);
    const rates = [];
    for (const ads of by.values()) {
        const hours = (ads[ads.length - 1].t - ads[0].t) / TICKS_PER_HOUR;
        if (hours < 1) continue;
        rates.push(new Set(ads.map(l => normalized(l.shown))).size / hours);
    }
    if (!rates.length) return { value: null, detail: 'no vendor advertised for an hour' };
    return { value: round(median(rates)), detail: `${rates.length} vendor sessions advertising 1 h+: distinct adverts an hour p10/p50/p90 ${round(quantile(rates, 0.1))}/${round(median(rates))}/${round(quantile(rates, 0.9))}` };
}

METRICS.push(
    ...[
        ['W1', 'say', 'Second death lines: a bot’s second line for one death within 10 min', '', () => max(0), 'proposed', secondDeathLines],
        ['W2', 'say', 'Confused replies ("?", "huh") to a bot’s greeting', '', () => max(0), 'proposed', confusedGreetingReplies],
        ['W3', 'say', 'Responses that fit the line they follow (none after a response)', '%', () => null, 'report', responseFit],
        ['W4', 'say', 'Repeats the human heard within 1 h, by meaning', '%', () => max(3), 'proposed', fuzzyRepeatsHeard],
        ['W5', 'say', 'Chatter said with nobody within 15 tiles', '%', r => (r.meta.bots <= 150 ? max(12) : null), 'proposed', loneTalk],
        ['W6', 'say', 'Idle and event lines about the bot’s task, target, place or destination', '%', () => min(40), 'proposed', specificShare],
        ['W9', 'say', 'The most bots that said one non-reflex idle line', '', () => max(3), 'proposed', speakersPerLine],
        ['W11', 'say', 'Register gap: a bot’s upstream vs 2004 lines’ shorthand share (points)', '', () => null, 'report', registerGap],
        ['W12', 'say', 'Non-trade lines in a colour or with an effect', '%', () => max(1), 'decided', chatEffects],
        ['E3', 'say', 'Sellers’ advert gaps: their coefficient of variation (median seller)', '', () => min(0.6), 'proposed', advertCadence],
        ['E4', 'say', 'Distinct adverts per vendor-hour (median vendor)', '', () => min(4), 'proposed', advertVariety]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of Track S's (variety) block ----
// ---- (variety round 1, Track W: what they wear) ----
// L2-L8 from the looks census (record.tracks.wear: humanlike's every --wear-every ticks, each bot's 14 worn slots, task,
// fight mode, tile, class; the wear track's ). n/a without it.
GROUPS.wear = 'What they wear (variety round 1)';
/** the slots the 274 model shows: head, cape, neck, weapon, body, shield, legs, hands, feet */
export const VISIBLE_SLOTS = [0, 1, 2, 3, 4, 5, 7, 9, 10];
const PK_PLANNERS = new Set(['extras_pker', 'extras_edgeville_pker']);
const METAL_RE = /^(bronze|iron|steel|black|mithril|adamant|adamnt|rune|dragon)_/;
const MELEE_RE = /scimitar|sword|mace|battleaxe|warhammer|dagger|spear|halberd|scythe/;
/** a melee weapon's kind from its debugname ("rune_2h_sword" → 2h_sword, "dragon_dagger_p" → dagger_p) */
export function weaponKindName(debugname) {
    return debugname.replace(METAL_RE, '');
}
function wearOf(r) {
    const w = r.tracks?.wear;
    return w && Array.isArray(w.samples) && w.samples.length ? w : null;
}
const dnOf = w => id => (id === -1 || id === undefined ? '' : (w.names[id] ?? String(id)));
const isMetalBody = name => /^(bronze|iron|steel|black|mithril|adamant|rune|dragon)_(platebody|chainbody)$/.test(name);
/** the samples at a ranged fight and a magic fight: a RangedMagic task by its mode, else by the weapon in hand */
function fightSamples(w) {
    const dn = dnOf(w);
    const rm = w.samples.filter(x => x.k === 'RangedMagic');
    const ranged = rm.filter(x => (x.m ? x.m === 'ranged' : /bow$/.test(dn(x.w[3]))));
    const magic = rm.filter(x => (x.m ? x.m === 'magic' : /staff/.test(dn(x.w[3]))));
    return { ranged, magic };
}

/** L2: distinct outfits (the items of the 9 visible slots) per 100 bots seen, each bot's last sample */
export function distinctOutfits(r) {
    const w = wearOf(r);
    if (!w) return { value: null };
    const last = new Map();
    for (const x of w.samples) last.set(x.n, x);
    const outfits = new Set([...last.values()].map(x => VISIBLE_SLOTS.map(sl => x.w[sl]).join(',')));
    return { value: round((100 * outfits.size) / last.size), detail: `${outfits.size} outfits among ${last.size} bots seen (each bot's last look)` };
}

/**
 * L2b (report): pairs of bots within view of each other (15 tiles, the same floor) in an identical outfit (the 9 visible
 * slots), an hour, counted as a look every 5 minutes (the wear track's census: 49 over its 2-hour run, 23 of them
 * newbies' bronze swords)
 */
export function identicalPairs(r) {
    const w = wearOf(r);
    if (!w) return { value: null };
    const dn = dnOf(w);
    const byT = new Map();
    for (const x of w.samples) {
        const list = byT.get(x.t) ?? [];
        list.push(x);
        byT.set(x.t, list);
    }
    let pairs = 0;
    const kinds = new Map();
    for (const list of byT.values()) {
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i];
                const b = list[j];
                if (a.l !== b.l || Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) > VIEW) continue;
                const oa = VISIBLE_SLOTS.map(sl => a.w[sl]).join(',');
                if (oa !== VISIBLE_SLOTS.map(sl => b.w[sl]).join(',')) continue;
                pairs++;
                const key = VISIBLE_SLOTS.map(sl => dn(a.w[sl])).filter(Boolean).join(' ') || '(nothing)';
                kinds.set(key, (kinds.get(key) ?? 0) + 1);
            }
        }
    }
    const hours = Math.max(1, r.meta.ticks - (r.meta.warmup ?? 0)) / TICKS_PER_HOUR;
    const scaled = (pairs * (w.every / 500)) / hours;
    const top = [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n}× ${k}`).join('; ');
    return { value: round(scaled), detail: `${pairs} pairs in ${byT.size} looks (every ${w.every} ticks)${top ? `: ${top}` : ''}` };
}

/** L3: of the non-PK bots' melee weapons in hand (bot-samples), the scimitars */
export function scimitarShare(r) {
    const w = wearOf(r);
    if (!w) return { value: null };
    const dn = dnOf(w);
    const melee = w.samples.filter(x => !PK_PLANNERS.has(x.p) && MELEE_RE.test(dn(x.w[3])));
    if (!melee.length) return { value: null };
    const kinds = new Map();
    for (const x of melee) {
        const k = weaponKindName(dn(x.w[3]));
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    const scim = kinds.get('scimitar') ?? 0;
    return { value: pct(scim, melee.length), detail: `${scim} of ${melee.length} samples; ${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`, data: { kinds: kinds.size } };
}
/** L3b: kinds of melee weapon held by non-PK bots (a scythe a kind) */
export function weaponKindsSeen(r) {
    const res = scimitarShare(r);
    return res.value === null ? { value: null } : { value: res.data.kinds, detail: res.detail };
}

/** L4: bot-samples at a ranged fight without a metal body */
export function rangersDressed(r) {
    const w = wearOf(r);
    if (!w) return { value: null };
    const dn = dnOf(w);
    const { ranged } = fightSamples(w);
    if (!ranged.length) return { value: null };
    const bare = ranged.filter(x => !isMetalBody(dn(x.w[4])));
    const leather = ranged.filter(x => /leather|studded|dragonhide|coif|cowl|chaps|vambraces/.test([0, 4, 7, 9].map(sl => dn(x.w[sl])).join(' ')));
    return { value: pct(bare.length, ranged.length), detail: `${bare.length} of ${ranged.length} samples without a metal body; ${pct(leather.length, ranged.length)} % in a ranger's piece (coif, cowl, leather, studded, d'hide)` };
}
/** L4b: bot-samples at a magic fight in a wizard hat or a robe */
export function magesDressed(r) {
    const w = wearOf(r);
    if (!w) return { value: null };
    const dn = dnOf(w);
    const { magic } = fightSamples(w);
    if (!magic.length) return { value: null };
    const robed = magic.filter(x => /wizhat/.test(dn(x.w[0])) || /robe|gown|splitbark/.test(dn(x.w[4])));
    const metal = magic.filter(x => [0, 4, 5, 7].some(sl => METAL_RE.test(dn(x.w[sl])) && /helm|body|shield|legs|skirt/.test(dn(x.w[sl]))));
    return { value: pct(robed.length, magic.length), detail: `${robed.length} of ${magic.length} samples in a wizard hat or robe; ${pct(metal.length, magic.length)} % in metal` };
}

/** woodcutters' and miners' samples (levelling bots, no newbies) */
function gatherSamples(w) {
    return w.samples.filter(x => LEVELLING.has(x.p) && !x.nb && (x.k === 'Woodcut' || x.k === 'Mine'));
}
/** L5: woodcutters and miners with the task's own tool in hand (an axe at the trees, a pickaxe at the rocks) */
export function toolsInHand(r) {
    const w = wearOf(r);
    if (!w) return { value: null };
    const dn = dnOf(w);
    const g = gatherSamples(w);
    if (!g.length) return { value: null };
    const own = g.filter(x => (x.k === 'Woodcut' ? /_axe$/.test(dn(x.w[3])) && !/battleaxe/.test(dn(x.w[3])) : /pickaxe$/.test(dn(x.w[3]))));
    const notStarter = own.filter(x => !/^bronze_/.test(dn(x.w[3])) && dn(x.w[3]) !== 'iron_axe');
    return { value: pct(own.length, g.length), detail: `${own.length} of ${g.length} samples (${pct(notStarter.length, g.length)} % not a starter bronze tool or iron axe)` };
}
/** L5b: a scimitar in hand at the trees and rocks */
export function scimitarAtGathering(r) {
    const w = wearOf(r);
    if (!w) return { value: null };
    const dn = dnOf(w);
    const g = gatherSamples(w);
    if (!g.length) return { value: null };
    const n = g.filter(x => /scimitar/.test(dn(x.w[3]))).length;
    return { value: pct(n, g.length), detail: `${n} of ${g.length} samples` };
}
/** L5c: of the chef's-hat sightings (bot-samples; chefs' names left out), those at cooking */
export function chefsHatsAtCooking(r) {
    const w = wearOf(r);
    if (!w) return { value: null };
    const dn = dnOf(w);
    // (a chef's name wears its hat anywhere: its class's look, L7)
    const all = w.samples.filter(x => dn(x.w[0]) === 'chefs_hat');
    const hats = all.filter(x => x.cls !== 'chef');
    if (!hats.length) return { value: null };
    const cooking = hats.filter(x => x.k === 'Cook').length;
    return { value: pct(cooking, hats.length), detail: `${cooking} of ${hats.length} sightings at cooking (${all.length - hats.length} more on chefs' names, left out)` };
}

/** L7: bot-samples of the bots whose name promises a class (a mage, ranger, miner, chef, smith, monk, pirate, knight), no newbies (PKers only with a mage's or archer's name: a PK build's look), in that class's look */
export function classLooks(r) {
    const w = wearOf(r);
    if (!w) return { value: null };
    // (a newbie in the design screen's clothes has no look of its own yet)
    const named = w.samples.filter(x => x.cls && !x.nb && x.ic !== null && x.ic !== undefined && (!PK_PLANNERS.has(x.p) || x.cls === 'mage' || x.cls === 'ranger'));
    if (!named.length) return { value: null };
    const by = new Map();
    for (const x of named) {
        const e = by.get(x.cls) ?? [0, 0];
        e[0] += x.ic ? 1 : 0;
        e[1]++;
        by.set(x.cls, e);
    }
    const yes = named.filter(x => x.ic).length;
    return { value: pct(yes, named.length), detail: `${yes} of ${named.length} samples of ${new Set(named.map(x => x.n)).size} bots: ${[...by].map(([c, [a, b]]) => `${c} ${a}/${b}`).join(', ')}` };
}

/** L8: a metal body at Agility and Firemaking (bot-samples) */
export function plateAtAgility(r) {
    const w = wearOf(r);
    if (!w) return { value: null };
    const dn = dnOf(w);
    const at = w.samples.filter(x => x.k === 'Agility' || x.k === 'Firemaking');
    if (!at.length) return { value: null };
    const plated = at.filter(x => isMetalBody(dn(x.w[4])));
    const of = k => {
        const list = at.filter(x => x.k === k);
        return list.length ? `${k} ${pct(list.filter(x => isMetalBody(dn(x.w[4]))).length, list.length)} % of ${list.length}` : `${k} n/a`;
    };
    return { value: pct(plated.length, at.length), detail: `${plated.length} of ${at.length} samples (${of('Agility')}, ${of('Firemaking')})` };
}

METRICS.push(
    ...[
        ['L2', 'wear', 'Distinct outfits per 100 bots seen (the 9 visible slots, each bot’s last look)', '', () => min(65), 'proposed', distinctOutfits],
        ['L2b', 'wear', 'Pairs in view in an identical outfit, an hour (a look every 5 min)', '', () => null, 'report', identicalPairs],
        ['L3', 'wear', 'Non-PK melee weapons in hand that are scimitars', '%', () => between(45, 70), 'proposed', scimitarShare],
        ['L3b', 'wear', 'Kinds of melee weapon non-PK bots hold', '', () => min(5), 'proposed', weaponKindsSeen],
        ['L4', 'wear', 'Bots at a ranged fight without a metal body', '%', () => min(70), 'proposed', rangersDressed],
        ['L4b', 'wear', 'Bots at a magic fight in a wizard hat or robe', '%', () => min(50), 'proposed', magesDressed],
        ['L5', 'wear', 'Woodcutters and miners with their axe or pickaxe in hand', '%', () => between(30, 60), 'proposed', toolsInHand],
        ['L5b', 'wear', 'A scimitar in hand at the trees and rocks', '%', () => max(35), 'proposed', scimitarAtGathering],
        ['L5c', 'wear', 'Chef’s hats seen at cooking (of the chef’s-hat sightings; chefs’ names out)', '%', () => min(50), 'proposed', chefsHatsAtCooking],
        ['L7', 'wear', 'Bots whose name promises a class in that class’s look', '%', () => min(70), 'proposed', classLooks],
        ['L8', 'wear', 'A metal body at Agility and Firemaking', '%', () => max(10), 'proposed', plateAtAgility]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of Track W's (variety) block ----

// ---- (variety round 2: each track's metrics in a block of its own, read from record.tracks.<key>, n/a when it is
// missing) ----
// ---- (variety round 2, Track D2: new activities) ----
// The round's new activities (P13-P17, the plan's round 2; warn-only): the
// economy chains' share of combat 3-20 levelling time (AM11), cooking, smithing and crafting fed by them (AM1c), the
// Lumbridge fields, mill and swamp occupied (AF1), the quest look-alikes (QA1, QA1b), the prayer and magic runs (MR1),
// herblore (HB1), the Wilderness trips (WT1), the rides to the far north-west (TR1), the errands that failed (ER1). From
// record.tracks.activities2 (the runner's Track D2 block); n/a without it.

/** (Track D2) the round's task kinds in the 2004 mix's groups (AM1, AM1b, AM5, AM8: round 1's table, extended here) */
// (a bone run's time is its fights at the giants: combat, as a trip's; a hides errand's is its fight at the cows, about 9
// tenths of it in the staged runs (2,400 of 2,600 ticks; the tanning and the leather a few minutes): combat)
Object.assign(ACTIVITY_GROUP, { Hides: 'combat', Pottery: 'crafting', Feathers: 'combat', Flour: 'cooking', FireCook: 'cooking', Bronze: 'smithing', Superheat: 'smithing', BoneRun: 'combat', Enchant: 'magic', Telegrab: 'magic', WildTrip: 'combat', WildMine: 'mining' });
/** the economy chains' kinds (AM11) */
export const D2_CHAIN_KINDS = ['Hides', 'Feathers', 'Pottery', 'Flour', 'Picking', 'FireCook', 'Bronze'];
/** the prayer and magic runs' kinds (MR1) */
export const D2_RUN_KINDS = ['BoneRun', 'Superheat', 'Enchant', 'Telegrab'];
const d2Hours = d => (d.samples * d.sample) / 6000;

/** AM11: the economy chains' share of combat 3-20 levelling bots' time (newcomers apart) */
export function chainShare(r) {
    const d = r.tracks?.activities2;
    if (!d?.low) return { value: null };
    const by = D2_CHAIN_KINDS.map(k => `${k} ${pct(d.lowKinds[k] ?? 0, d.low)}`);
    const top = Object.entries(d.lowKinds).filter(([k]) => !D2_CHAIN_KINDS.includes(k)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ${pct(n, d.low)}`);
    return { value: pct(d.lowChain, d.low), detail: `${d.lowChain} of ${d.low} combat 3-20 levelling bot-samples in a chain: ${by.join(', ')}; the rest's top ${top.join(', ')}` };
}

/** AM1c: cooking, smithing and crafting (the chains' supply) outside 2-7 % of levelling time (round 1's AM1 groups) */
export function craftsFed(r) {
    const d = r.tracks?.d;
    if (!d?.levellingSamples) return { value: null };
    const rows = ['cooking', 'smithing', 'crafting'].map(g => [g, pct(d.groups[g] ?? 0, d.levellingSamples)]);
    const out = rows.filter(([, v]) => !inBand(v, { min: 2, max: 7 }));
    return { value: out.length, detail: `${rows.map(([g, v]) => `${g} ${v} %${inBand(v, { min: 2, max: 7 }) ? '' : ' ✗'}`).join(', ')}` };
}

/** AF1: the Lumbridge fields, the mill and the swamp with someone 10 %+ of the samples */
export function fieldsOccupied(r) {
    const d = r.tracks?.activities2;
    if (!d?.samples) return { value: null };
    const rows = Object.entries(d.fields).map(([k, f]) => ({ k, seen: pct(f.seen, d.samples), avg: round(f.bots / d.samples, 2) }));
    return { value: rows.filter(x => x.seen >= 10).length, detail: rows.map(x => `${x.k} ${x.seen} % (${x.avg} on average)`).join(', ') };
}

/** QA1: quest look-alikes started an hour per 100 online */
export function questsPerHour(r) {
    const d = r.tracks?.activities2;
    if (!d?.samples || !d.online) return { value: null };
    const per100 = d.questStarts / d2Hours(d) / (d.online / d.samples / 100);
    const e = d.lib?.errands;
    const quests = e ? Object.keys(e.started).filter(k => k.startsWith('Quest:')) : [];
    const finished = quests.reduce((a, k) => a + (e.finished[k] ?? 0), 0);
    const started = quests.reduce((a, k) => a + (e.started[k] ?? 0), 0);
    const talks = d.lib?.talks;
    return {
        value: round(per100, 2),
        detail: `${d.questStarts} started in ${round(d2Hours(d), 2)} h (${Object.entries(d.questStartsBy).map(([k, n]) => `${k} ${n}`).join(', ') || '-'}); finished ${finished} of ${started}${talks ? `; talks held ${talks.talked}, missed ${talks.missed}` : ''}${d.lib?.lines ? `; their lines ${d.lib.lines.quest} (all errands' ${d.lib.lines.said}, ${d.lib.lines.alone} not said alone)` : ''}`
    };
}

/** QA1b: the quest look-alikes' share of newcomers' time */
export function newcomerQuestShare(r) {
    const d = r.tracks?.activities2;
    if (!d?.newbie) return { value: null };
    const top = Object.entries(d.newbieKinds).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${pct(n, d.newbie)}`);
    return { value: pct(d.newbieKinds.Quest ?? 0, d.newbie), detail: `${d.newbie} newcomer bot-samples: ${top.join(', ')}` };
}

/** MR1 (report): the prayer and magic runs' bot-hours, by kind */
export function magicRunHours(r) {
    const d = r.tracks?.activities2;
    if (!d?.samples) return { value: null };
    const h = k => round(((d.kinds[k] ?? 0) * d.sample) / 6000, 2);
    const total = D2_RUN_KINDS.reduce((a, k) => a + (d.kinds[k] ?? 0), 0);
    // (who could start each: its runes, items and levels, of the levelling bots looked at every 10 minutes)
    const runKey = { BoneRun: 'boneRun', Superheat: 'superheat', Enchant: 'enchant', Telegrab: 'telegrab' };
    const open = d.magicLooks ? `; could start one (of ${d.magicLooks} levelling bot-looks): ${D2_RUN_KINDS.map(k => `${k} ${pct(d.magicOpen?.[runKey[k]] ?? 0, d.magicLooks)} %`).join(', ')}` : '';
    return { value: round((total * d.sample) / 6000, 2), detail: D2_RUN_KINDS.map(k => `${k} ${h(k)} h`).join(', ') + open };
}

/** HB1: herblore's share of members' levelling time */
export function herbloreShare(r) {
    const d = r.tracks?.activities2;
    if (!d?.levelling || !r.meta.members) return { value: null };
    return { value: pct(d.kinds.Herblore ?? 0, d.levelling), detail: `${d.kinds.Herblore ?? 0} of ${d.levelling} levelling bot-samples` };
}

/** WT1: levelling bots in the Wilderness per 100 online (the trips, and any other task there) */
export function wildernessLevellers(r) {
    const d = r.tracks?.activities2;
    if (!d?.samples || !d.online) return { value: null };
    const trips = d.lib?.wild?.trips;
    return {
        value: round((100 * d.wild) / d.online, 2),
        detail: `${round(d.wild / d.samples, 2)} on average (${round(d.wildTrip / d.samples, 2)} on a trip; by task ${Object.entries(d.wildBy).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ${pct(n, d.wild)} %`).join(', ') || '-'}); trips offered ${trips ? Object.entries(trips).map(([k, n]) => `${k} ${n}`).join(', ') || 'none' : 'n/a'}${d.lib?.wild ? `, shields from the Duke ${d.lib.wild.shields}` : ''}`
    };
}

/** TR1 (report): agility plans 300+ tiles from their course: the median ticks to it, and how many rode a spirit tree or a glider */
export function agilityTravel(r) {
    const d = r.tracks?.activities2;
    if (!d?.agility) return { value: null };
    const far = d.agility.filter(a => a.dist >= 300);
    const t = d.lib?.travel;
    const routes = t ? Object.entries(t.taken).map(([k, n]) => `${k} ${n} (done ${t.done[k] ?? 0}, failed ${t.failed[k] ?? 0})`).join(', ') : 'n/a';
    if (!far.length) return { value: null, detail: `no far agility plan reached its course; rides ${routes}` };
    return { value: median(far.map(a => a.ticks)), detail: `${far.length} far agility plans reached the course (p90 ${quantile(far.map(a => a.ticks), 0.9)} ticks), ${far.filter(a => a.rode).length} by a ride; all rides: ${routes}; near ones (under 300 tiles) ${d.agility.length - far.length}` };
}

/** ER1: errands that failed (a step that could not happen: the planner picks again) */
export function errandsFailed(r) {
    const e = r.tracks?.activities2?.lib?.errands;
    if (!e) return { value: null };
    const started = Object.values(e.started).reduce((a, b) => a + b, 0);
    const failed = Object.values(e.failed).reduce((a, b) => a + b, 0);
    if (!started) return { value: null, detail: 'no errand ran' };
    const top = Object.entries(e.failedAt).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`);
    return { value: pct(failed, started), detail: `${failed} of ${started} errands failed${top.length ? `: ${top.join(', ')}` : ''}; started ${Object.entries(e.started).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ')}` };
}

GROUPS.activities2 = 'New activities (variety round 2)';
METRICS.push(
    ...[
        ['AM11', 'activities2', 'Economy chains: share of combat 3-20 levelling time', '%', () => between(15, 25), 'decided', chainShare],
        ['AM1c', 'activities2', 'Cooking, smithing and crafting outside 2-7 % of levelling time', '', () => max(0), 'decided', craftsFed],
        ['AF1', 'activities2', 'Lumbridge fields, mill, chicken farm and swamp with someone 10 %+ of the time (of 7)', '', () => min(4), 'proposed', fieldsOccupied],
        ['QA1', 'activities2', 'Quest look-alikes started an hour per 100 online', '', () => null, 'report', questsPerHour],
        ['QA1b', 'activities2', "Quest look-alikes' share of newcomers' time", '%', () => between(10, 20), 'decided', newcomerQuestShare],
        ['MR1', 'activities2', 'Prayer and magic runs: bot-hours (by kind in the detail)', 'h', () => null, 'report', magicRunHours],
        ['HB1', 'activities2', "Herblore's share of members' levelling time", '%', () => between(1, 4), 'proposed', herbloreShare],
        ['WT1', 'activities2', 'Levelling bots in the Wilderness per 100 online', '', () => between(1, 2), 'decided', wildernessLevellers],
        ['TR1', 'activities2', 'Far agility plans: median ticks to the course (spirit trees and gliders)', '', () => null, 'report', agilityTravel],
        ['ER1', 'activities2', 'Errands that failed (a step that could not happen)', '%', () => max(15), 'proposed', errandsFailed]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of Track D2's (variety) block ----
// ---- (variety round 2, Track M: members places and minigames) ----
// The members places and minigames (round 2, Track M;
// far places scale with N, about 3 at a time in far towns and minigames at 100 online, a real presence at
// 250 and 500): FT1 the bots in far towns and minigames per 100 online, MG1 the minigames' share of members levelling
// time, MG2 each minigame's visits and groups an hour, CB1 Catherby's bots fishing, SF1 Seers' flax and wheel, FT2 the
// outings by town and the hotspots H1 found empty, by what is done there. From record.tracks.members (the runner's Track M
// block); n/a without it.

/** FT1's band: about 3 per 100 at 100 online (1.5-5), 15+ of 500 (3 per 100 or more) from 400; between, report (a free world: n/a, farTownBots: it has no far members towns) */
export function farTownBand(bots) {
    if (bots <= 150) return { min: 1.5, max: 5 };
    if (bots >= 400) return { min: 3 };
    return null;
}
/** MG1's band: the plan's 2-5 % of members levelling time */
export const MINIGAME_SHARE = { min: 2, max: 5 };
/** CB1's band: Catherby's bots fishing at least half the time (15 % before round 1: the research) */
export const CATHERBY_FISHING_MIN = 50;

const trackM = r => r.tracks?.members ?? null;

/** FT1: bots in the far towns (VARIETY_PLACES' 'f' places) or on a minigame, per 100 online (by place and kind in the detail) */
export function farTownBots(r) {
    const m = trackM(r);
    if (!m?.samples || !m.online) return { value: null };
    // (variety round 2, the fixes: B7) n/a on a free world, as MG1 and CB1: every far town and minigame it counts is
    // members-only (it was a report row of 0 there)
    if (!r.meta.members) return { value: null, detail: 'a free world: every far town and minigame counted is members-only' };
    const per = (100 * m.farBots) / m.online;
    const places = Object.entries(m.far).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${round(n / m.samples, 2)}`);
    const kinds = Object.entries(m.farKinds).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${round(n / m.samples, 2)}`);
    return { value: round(per, 2), detail: `${round(m.farBots / m.samples, 2)} bots on average (${round(m.online / m.samples, 1)} online): ${places.join(', ') || 'none'}; doing ${kinds.join(', ') || '-'}` };
}

/** MG1: the minigames' share of members levelling time (port/BotOutings MINIGAME_KINDS) */
export function minigameShare(r) {
    const m = trackM(r);
    if (!m?.levellingSamples || !r.meta.members) return { value: null };
    const kinds = Object.entries(m.minigame).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${round(n / m.samples, 2)}`);
    return { value: pct(m.minigameLevelling, m.levellingSamples), detail: `${m.minigameLevelling} of ${m.levellingSamples} levelling bot-samples on a minigame; bots on each on average: ${kinds.join(', ') || 'none'}` };
}

/** MG2 (report): each minigame's visits, groups (a trawler crew, a round of the Guild's competition) and rewards an hour */
export function minigameVisits(r) {
    const s = trackM(r)?.stats;
    if (!s) return { value: null };
    const hours = (r.meta.ticks - (r.meta.warmup ?? 0)) / TICKS_PER_HOUR;
    let visits = 0;
    const rows = Object.entries(s).map(([k, v]) => {
        visits += v.visits ?? 0;
        const extra = Object.entries(v)
            .filter(([f]) => f !== 'visits')
            .map(([f, n]) => `${f} ${round(n / hours, 1)}`)
            .join(' ');
        return `${k}: visits ${round((v.visits ?? 0) / hours, 1)}${extra ? ` ${extra}` : ''}`;
    });
    return { value: round(visits / hours, 1), detail: `an hour: ${rows.join('; ') || 'none'}` };
}

/** CB1: the bots in Catherby (its VARIETY_PLACES box) that are fishing (Catherby's lobsters, the members icon of 2004) */
export function catherbyFishing(r) {
    const m = trackM(r);
    const c = m?.places?.catherby;
    if (!c?.n || !r.meta.members) return { value: null };
    const kinds = Object.entries(c.kinds).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${pct(n, c.n)}`);
    return { value: pct(c.kinds.Fish ?? 0, c.n), detail: `${round(c.n / m.samples, 2)} bots in Catherby on average: ${kinds.join(', ')} %` };
}

/** SF1 (report): Seers' flax field and spinning wheel (upstairs) on average, and what the bots there do */
export function seersFlax(r) {
    const m = trackM(r);
    if (!m?.samples || !r.meta.members) return { value: null };
    const f = m.places.seers_flax;
    const w = m.places.seers_wheel;
    const kinds = pl => Object.entries(pl.kinds).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${pct(n, pl.n)}`).join(', ') || '-';
    return { value: round((f.n + w.n) / m.samples, 2), detail: `flax field ${round(f.n / m.samples, 2)} (${kinds(f)} %), the wheel upstairs ${round(w.n / m.samples, 2)} (${kinds(w)} %)` };
}

/** FT2 (report): the outings by town (bots on one on average, and how many began), and the empty hotspots by what is done there */
export function outingsByTown(r) {
    const m = trackM(r);
    if (!m?.samples) return { value: null };
    const on = Object.entries(m.outing).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${round(n / m.samples, 2)}`);
    const began = {};
    const outcomes = {};
    const minutes = [];
    for (const e of m.log ?? []) {
        began[e.key] = (began[e.key] ?? 0) + 1;
        if (e.end >= 0) {
            outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
            minutes.push((e.end - e.start) / TICKS_PER_MINUTE);
        }
    }
    const total = Object.values(m.outing).reduce((a, b) => a + b, 0);
    const spot = key => {
        const pl = m.places[key];
        return `${key} ${round(pl.n / m.samples, 2)} (${Object.entries(pl.kinds).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${pct(n, pl.n)}`).join(', ') || '-'})`;
    };
    const ended = Object.entries(outcomes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
    // (whom the hooks took: what the bot was doing before, by kind; the signatures apart)
    const took = hook => {
        const from = {};
        for (const [k, n] of Object.entries(m.picks?.[hook] ?? {})) {
            const kind = k.split('<')[1] ?? '?';
            from[kind] = (from[kind] ?? 0) + n;
        }
        return Object.entries(from).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ${n}`).join(', ') || '-';
    };
    const byKey = hook => Object.entries(m.picks?.[hook] ?? {}).reduce((acc, [k, n]) => ((acc[k.split('<')[0]] = (acc[k.split('<')[0]] ?? 0) + n), acc), {});
    const sigs = byKey('signature');
    const fishers = Object.entries(byKey('fisher')).map(([k, n]) => `${k} ${n}`).join(', ') || '-';
    return {
        value: round(total / m.samples, 2),
        detail: `on an outing on average: ${on.join(', ') || 'none'}; begun ${Object.entries(began).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; ended ${ended || '-'}, minutes p50 ${round(median(minutes), 1) ?? '-'}; taken from ${took('members')}; signatures ${Object.entries(sigs).map(([k, n]) => `${k} ${n}`).join(', ') || '-'} (from ${took('signature')}); fishers done elsewhere: ${fishers}; ${spot('ardougne_market')}, ${spot('falador_west_bank')}${m.idle ? `; H19's idle stands by kind: ${Object.entries(m.idle).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}` : ''}${m.idleAt ? ` (where, past 2 min: ${Object.entries(m.idleAt).filter(([k]) => !k.startsWith('Hangout@') && !k.startsWith('DuelArena@')).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})` : ''}`
    };
}

GROUPS.members = 'Members places and minigames (variety round 2)';
METRICS.push(
    ...[
        ['FT1', 'members', 'Bots in far towns and minigames per 100 online (scaled with N)', '', r => (r.meta.members ? farTownBand(r.meta.bots) : null), 'proposed', farTownBots],
        ['MG1', 'members', 'Minigames’ share of members levelling time', '%', r => (r.meta.members ? MINIGAME_SHARE : null), 'proposed', minigameShare],
        ['MG2', 'members', 'Minigame visits an hour (groups, rounds and rewards in the detail)', '', () => null, 'report', minigameVisits],
        ['CB1', 'members', 'Catherby’s bots fishing', '%', r => (r.meta.members ? { min: CATHERBY_FISHING_MIN } : null), 'proposed', catherbyFishing],
        ['SF1', 'members', 'Seers’ flax field and wheel: bots on average', '', () => null, 'report', seersFlax],
        ['FT2', 'members', 'Bots on a far-town outing on average (by town in the detail)', '', () => null, 'report', outingsByTown]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of Track M's (variety) block ----
// ---- (variety round 2, Track S2: conversation) ----
// From the run's lines (record.lines) and record.tracks.talk2 (test/humanlike.mjs varietyS2Collect: the deaths with
// another player within 10 tiles, as the runner saw them; the reactions the library said and what about (port/BotWitness
// witnessLog); the thread engine's counts (port/BotThreads threadStats); the clique mates' time together and their lines
// to each other). n/a when record.tracks.talk2 is missing (an older library, an A/B run). Bands warn only (the plan: new
// measures warn first). W7, W8, W10 are the plan's; W7b, W7c, W13-W15 this track's own.
GROUPS.talk2 = 'Conversation (variety round 2, track S2)';

/** the record's tracks.talk2, or null */
const talk2Track = r => r.tracks?.talk2 ?? null;
/** a hello as bots say them, a name after it or not (W13 leaves a clique's hellos out: the runner) */
export const HELLO_LINE = /^(he+y+|hi+|hello+|yo+|sup|wassup|heya|hiya|ello|o hey|hey all|hi all)\b/i;
/** words that carry no content alone: an ack, a laugh, a gz, a hello ("k ty", "oh ok thanks", "gz m8", "sup") */
const ACK_WORDS = new Set(['ty', 'thx', 'thanks', 'thank', 'you', 'k', 'kk', 'ok', 'okay', 'oh', 'ah', 'np', 'gz', 'gratz', 'grats', 'gj', 'congrats', 'lol', 'lmao', 'haha', 'rofl', 'ya', 'yep', 'yea', 'yeah', 'nice', 'cool', 'same', 'hi', 'hey', 'heya', 'heyy', 'yo', 'sup', 'hiya', 'hello', 'ello', 'm8', 'man', 'mate', 'there', 'all', 'o', 'wassup']);
/** a line of acks only: no turn of a conversation (W7 counts content turns) */
export function isAckLine(text) {
    const w = normalized(text).split(' ').filter(Boolean);
    return w.length === 0 || w.every(x => ACK_WORDS.has(x));
}
/** a counter-question at a line's end ("41 u?", "cutting willows, wbu", "what about you?") */
export const COUNTER_QUESTION = /(?:^|[\s,])(?:u|you)\s*\?+\s*$|\b(?:wbu|hbu)\b\s*\??\s*$|\bwhat about (?:u|you)\b|\band (?:u|you)\s*\??\s*$/i;

/**
 * Bot-to-bot exchanges (the investigation's say/threads.py): the lines a bot said to a bot (set pieces and trade apart),
 * by pair, a line within 150 ticks of the pair's last; its opener the addressee's last line in the 60 ticks before (any
 * non-trade line). Each: its lines in order.
 */
export function botExchanges(r) {
    const lines = r.lines;
    const open = new Map();
    const all = [];
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.to !== 'bot' || !l.toName || isAside(l)) continue;
        const key = l.name < l.toName ? `${l.name}|${l.toName}` : `${l.toName}|${l.name}`;
        const ex = open.get(key);
        if (ex && l.t - ex[ex.length - 1].t <= 150) {
            ex.push(l);
            continue;
        }
        let opener = null;
        for (let j = i - 1; j >= 0 && l.t - lines[j].t <= 60; j--) {
            if (lines[j].name === l.toName && !isAside(lines[j])) {
                opener = lines[j];
                break;
            }
        }
        const fresh = opener ? [opener, l] : [l];
        all.push(fresh);
        open.set(key, fresh);
    }
    return all;
}

/** W7: bot-to-bot exchanges of 3+ content turns (acks, laughs, gz and hellos apart): their share of all exchanges */
export function threadShare(r) {
    if (!talk2Track(r)) return { value: null };
    const ex = botExchanges(r);
    if (!ex.length) return { value: null };
    const content = e => e.filter(l => !isAckLine(l.text)).length;
    const long = ex.filter(e => content(e) >= 3);
    const hist = {};
    for (const e of ex) hist[Math.min(6, e.length)] = (hist[Math.min(6, e.length)] ?? 0) + 1;
    const heard = ex.filter(e => e.some(l => l.humanDist <= VIEW));
    return {
        value: pct(long.length, ex.length),
        detail: `${long.length} of ${ex.length} exchanges with 3+ content turns (3+ turns of any kind ${pct(ex.filter(e => e.length >= 3).length, ex.length)} %; turns: ${Object.entries(hist).map(([k, n]) => `${k}${k === '6' ? '+' : ''}:${n}`).join(' ')}); ${heard.length} heard by the human (${heard.filter(e => content(e) >= 3).length} of 3+); e.g. ${long.slice(0, 2).map(e => e.map(l => l.shown).join(' / ')).join(' | ') || '-'}`
    };
}

/** W7b: counter-questions a bot asked a bot ("41 u?", "wbu") that got a content line back from it within 60 s */
export function counterAnswered(r) {
    if (!talk2Track(r)) return { value: null };
    const asked = [];
    r.lines.forEach((l, i) => {
        if (l.to !== 'bot' || !l.toName || isAside(l) || !COUNTER_QUESTION.test(l.text.trim()) || l.t > r.meta.ticks - 100) return;
        let answered = false;
        for (let j = i + 1; j < r.lines.length && r.lines[j].t - l.t <= 100; j++) {
            const o = r.lines[j];
            if (o.name === l.toName && o.toName === l.name && !isAckLine(o.text)) {
                answered = true;
                break;
            }
        }
        asked.push({ l, answered });
    });
    if (!asked.length) return { value: null, detail: 'no counter-question between bots' };
    const missed = asked.filter(a => !a.answered);
    return { value: pct(asked.length - missed.length, asked.length), detail: `${asked.length - missed.length} of ${asked.length} answered${missed.length ? `; unanswered e.g. ${missed.slice(0, 3).map(a => `"${a.l.shown}"`).join(', ')}` : ''}` };
}

/** W7c: a pair of bots that opened a topic it had talked about in that session (asked again, not followed up) */
export function topicRepeats(r) {
    const th = talk2Track(r)?.threads;
    if (!th) return { value: null };
    const top = Object.entries(th.byTopic ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const src = Object.entries(th.bySource ?? {}).map(([k, n]) => `${k} ${n}`).join(', ');
    const fails = Object.entries(th.fails ?? {}).map(([k, n]) => `${k} ${n}`).join(', ');
    return { value: th.repeats ?? 0, detail: `${th.started ?? 0} threads (${src || 'none started by a bot'}${fails ? `; not started: ${fails}` : ''}; ${th.followUps ?? 0} followed a topic up, ${th.changed ?? 0} changed topic, depth p50/max ${th.depthMedian ?? '-'}/${th.depthMax ?? '-'}; counter-questions ${th.countersAnswered ?? 0} of ${th.counters ?? 0} answered); topics ${top.map(([k, n]) => `${k} ${n}`).join(', ')}` };
}

/**
 * W8: the top voice: per place (the runner's 34 hubs) and hour of the run, the non-trade lines said there (within 15
 * tiles; answers to the human apart: its own conversation); in a place-hour of 30 lines or more from 5 speakers or more (a hub's talk: two bots alone at a spot, or a
 * quiet place's one conversation, talk as they like; port/BotVoice's rule), the share of the one bot that said most: the
 * worst
 */
export function topVoice(r) {
    if (!talk2Track(r)) return { value: null };
    const by = new Map();
    for (const l of r.lines) {
        // (an answer to the human is its own conversation's: a bot it talks with is no voice dominating the place)
        if (isAside(l) || REPLY_KINDS.has(l.kind) || !l.hubs?.length) continue;
        const hour = Math.floor(l.t / TICKS_PER_HOUR);
        for (const h of l.hubs) {
            const k = `${h}|${hour}`;
            const e = by.get(k) ?? by.set(k, { hub: h, hour, n: 0, who: new Map() }).get(k);
            e.n++;
            e.who.set(l.name, (e.who.get(l.name) ?? { n: 0, planner: l.planner })).get(l.name);
            e.who.get(l.name).n++;
        }
    }
    const busy = [...by.values()].filter(e => e.n >= 30 && e.who.size >= 5).map(e => {
        const [name, top] = [...e.who].sort((a, b) => b[1].n - a[1].n)[0];
        return { ...e, name, planner: top.planner, share: (100 * top.n) / e.n };
    });
    if (!busy.length) return { value: null, detail: 'no place-hour with 30+ non-trade lines from 5+ speakers' };
    busy.sort((a, b) => b.share - a.share);
    const w = busy[0];
    const shares = busy.map(e => e.share);
    return {
        value: round(quantile(shares, 0.9)),
        detail: `${busy.length} place-hours with 30+ lines from 5+ speakers: top voice p50/p90 ${round(median(shares))}/${round(quantile(shares, 0.9))} %, over 20 % in ${busy.filter(e => e.share > 20).length}; worst ${w.name} (${w.planner}) at ${w.hub} hour ${w.hour}: ${round(w.share)} % of ${w.n}${talk2Track(r).voiceHeld != null ? `; optional lines the cap held ${talk2Track(r).voiceHeld}` : ''}`
    };
}

/**
 * W10: deaths with another player within 10 tiles that a bot near reacted to ("rip", "lol he got pked") within 100 ticks
 * (a loss at the Duel Arena apart: no death)
 */
export function witnessReactions(r) {
    const t = talk2Track(r);
    if (!t?.deaths) return { value: null };
    const seen = t.deaths.filter(d => d.company > 0 && !d.arena && d.t <= r.meta.ticks - 100);
    if (!seen.length) return { value: null, detail: 'no death with another player near' };
    const log = t.witness ?? [];
    // (the library sees the fall to 0 Hitpoints; 274's "Oh dear you are dead!" comes a few ticks later, after the animation)
    const reacted = seen.filter(d => log.some(w => w.about === d.name && (w.event === 'witness-death' || w.event === 'witness-pk') && w.t >= d.t - 20 && w.t - d.t <= 100));
    const kinds = {};
    for (const w of log) kinds[w.event] = (kinds[w.event] ?? 0) + 1;
    const ws = t.witnessStats;
    return { value: pct(reacted.length, seen.length), detail: `${reacted.length} of ${seen.length} deaths with company got a reaction${ws ? ` (the library: ${ws.deaths} deaths seen, ${ws.seen} with a bot free near, ${ws.said} said)` : ''}; the reactions said: ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}` };
}

/**
 * W13: the lines a clique mate said to a mate within 6 tiles of it (their hellos and goodbyes apart), an hour of a
 * clique's mates together (two or more within 6 tiles)
 */
export function cliqueBanter(r) {
    const m = talk2Track(r)?.mates;
    if (!m) return { value: null };
    const hours = m.together / TICKS_PER_HOUR;
    if (hours < 0.25) return { value: null, detail: `mates together only ${round(hours, 2)} h` };
    return { value: round(m.lines / hours), detail: `${m.lines} lines between clique mates together in ${round(hours)} clique-hours (banter ${m.banter ?? 0}, thread turns ${m.threads ?? 0}; hellos and goodbyes apart: ${m.greets ?? 0})` };
}

/** W14: gear comments between bots and show-off lines after a purchase, an hour of the run (report) */
export function gearTalk(r) {
    const t = talk2Track(r);
    if (!t?.witness) return { value: null };
    const hours = r.meta.ticks / TICKS_PER_HOUR;
    const gear = t.witness.filter(w => w.event === 'witness-gear' || w.event === 'witness-rare');
    const show = t.witness.filter(w => w.event === 'show-off');
    return { value: round((gear.length + show.length) / hours), detail: `${gear.length} comments on another's gear (${gear.filter(w => w.event === 'witness-rare').length} on a rare), ${show.length} show-off lines, in ${round(hours)} h` };
}

/** W15: reactions to the human's own doings (its death, an emote, the Wilderness, a kill): the most within any minute */
export function humanReactions(r) {
    const t = talk2Track(r);
    if (!t?.witness) return { value: null };
    const own = t.witness.filter(w => w.event.startsWith('react-')).map(w => w.t).sort((a, b) => a - b);
    let most = 0;
    for (let i = 0, j = 0; i < own.length; i++) {
        while (own[i] - own[j] >= TICKS_PER_MINUTE) j++;
        most = Math.max(most, i - j + 1);
    }
    const kinds = {};
    for (const w of t.witness) if (w.event.startsWith('react-')) kinds[w.event] = (kinds[w.event] ?? 0) + 1;
    return { value: most, detail: `${own.length} reactions to the human (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}); the most within a minute ${most}` };
}

METRICS.push(
    ...[
        ['W7', 'talk2', 'Bot-to-bot exchanges of 3+ content turns (acks, gz, hellos apart)', '%', () => between(20, 40), 'proposed', threadShare],
        ['W7b', 'talk2', 'Counter-questions between bots ("41 u?") answered', '%', () => min(70), 'proposed', counterAnswered],
        ['W7c', 'talk2', 'A pair of bots asking a topic again in a session', '', () => max(0), 'proposed', topicRepeats],
        ['W8', 'talk2', 'Top voice: one bot’s share of a place’s non-trade lines in an hour (p90 of place-hours: 30+ lines, 5+ speakers)', '%', () => max(25), 'proposed', topVoice],
        ['W10', 'talk2', 'Deaths with a player within 10 tiles that a bot near reacted to', '%', () => between(20, 50), 'proposed', witnessReactions],
        ['W13', 'talk2', 'Lines between clique mates an hour together', '', () => between(2, 6), 'proposed', cliqueBanter],
        ['W14', 'talk2', 'Gear comments between bots and show-off lines, an hour (report)', '', () => null, 'report', gearTalk],
        ['W15', 'talk2', 'Reactions to the human’s doings within one minute (most)', '', () => max(1), 'proposed', humanReactions]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of Track S2's (variety) block ----
// ---- (variety round 2, Track W2: fashion) ----
// L6, L6b, L9, L10, L11, L12 from the fashion census (record.tracks.fashion: humanlike's every --fashion-every ticks, each
// bot's 14 worn slots, bank value, task and tile; the items' debugnames, members flags and status families; the names'
// planners, tiers and hair; the show-off visits' counts). n/a without it.
GROUPS.fashion = 'Fashion (variety round 2)';
const PK_PLANNERS2 = new Set(['extras_pker', 'extras_edgeville_pker']);
/** the trade hubs and the park (the wear track's L6: where 2004's rich showed off) */
export const SHOW_HUBS = ['varrock_west_bank', 'varrock_west_road', 'varrock_square', 'falador_park', 'falador_west_bank', 'falador_east_bank', 'edgeville_bank'];
function fashionOf(r) {
    const f = r.tracks?.fashion;
    return f && Array.isArray(f.samples) && f.samples.length ? f : null;
}
const itemOf = (f, id) => (id === -1 || id === undefined ? null : (f.items[id] ?? null));
/** the hub a sample is at (within the client's view of a SHOW_HUBS place), or null */
function showHubAt(x) {
    if (x.l !== 0) return null;
    for (const key of SHOW_HUBS) {
        const h = HUBS.find(hh => hh.key === key);
        if (h && Math.max(Math.abs(h.x - x.x), Math.abs(h.z - x.z)) <= VIEW) return key;
    }
    return null;
}
const RARE_RE = /_partyhat$|^santa_hat$|halloween|^bunny_ears$|^scythe$/;
const DRAGON_RE = /^dragon_(med_helm|sq_shield|longsword|battleaxe|mace|dagger|dagger_p|spear|spear_p)$/;

/** L6: of the rich bots seen (bank value at RICH_WEALTH or more in a look; no PKer, no vendor), those seen in a status piece (a trim, god or gilded piece) */
export function richInStatus(r) {
    const f = fashionOf(r);
    if (!f || !f.rich) return { value: null };
    const by = new Map();
    for (const x of f.samples) {
        const who = f.names[x.i];
        if (!who || PK_PLANNERS2.has(who.p) || who.p === 'extras_vendor') continue;
        const e = by.get(x.i) ?? { rich: false, status: false, owns: false, n: 0, p: who.p };
        e.n++;
        if ((x.v ?? 0) >= f.rich) e.rich = true;
        if (x.w.some(id => itemOf(f, id)?.s)) e.status = true;
        if ((x.o ?? 0) > 0) e.owns = true;
        by.set(x.i, e);
    }
    const rich = [...by.values()].filter(e => e.rich && e.n >= 2);
    if (!rich.length) return { value: null };
    const yes = rich.filter(e => e.status).length;
    const owners = rich.filter(e => e.owns).length;
    const byPlanner = {};
    for (const e of rich) {
        const o = (byPlanner[e.p] ??= [0, 0]);
        o[1]++;
        if (e.status) o[0]++;
    }
    // the hubs: of the rich bots' looks there, in a status piece
    const atHub = f.samples.filter(x => (x.v ?? 0) >= f.rich && showHubAt(x) && !PK_PLANNERS2.has(f.names[x.i]?.p) && f.names[x.i]?.p !== 'extras_vendor');
    const hubStatus = atHub.filter(x => x.w.some(id => itemOf(f, id)?.s)).length;
    // the social and vendor bots of the experienced and veteran tiers (worn only: no bank)
    const cosmetic = new Map();
    for (const x of f.samples) {
        const who = f.names[x.i];
        if (!who || (who.p !== 'extras_social' && who.p !== 'extras_vendor') || (who.tier !== 'experienced' && who.tier !== 'veteran')) continue;
        cosmetic.set(x.i, (cosmetic.get(x.i) ?? false) || x.w.some(id => itemOf(f, id)?.s));
    }
    const so = f.showOff;
    const visits = so ? `; show-off visits ${so.visits} (dressed ${so.dressed}), purchases tried ${so.tried}, bought ${so.bought} for ${so.coins} gp${so.bought ? ` (${Object.entries(so.items ?? {}).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}` : '';
    const vendors = f.vendorLooks ? `; vendors selling a status piece ${pct(f.statusVendors, f.vendorLooks)} % of vendor looks` : '';
    return {
        value: pct(yes, rich.length),
        detail: `${yes} of ${rich.length} rich bots (bank value ${f.rich}+; ${owners} own one; ${Object.entries(byPlanner).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(', ')}); at the hubs and the park ${pct(hubStatus, atHub.length)} % of ${atHub.length} rich looks; experienced and veteran social and vendor bots ${[...cosmetic.values()].filter(Boolean).length} of ${cosmetic.size}${visits}${vendors}`
    };
}

/** L6b (report): status pieces, rares and dragon items seen at the trade hubs and the park, an hour (a bot's piece once a look) */
export function statusSeenAtHubs(r) {
    const f = fashionOf(r);
    if (!f) return { value: null };
    const hours = Math.max(1, r.meta.ticks - (r.meta.warmup ?? 0)) / TICKS_PER_HOUR;
    const kinds = { status: 0, rare: 0, dragon: 0 };
    const items = {};
    for (const x of f.samples) {
        if (!showHubAt(x) || PK_PLANNERS2.has(f.names[x.i]?.p)) continue;
        for (const id of x.w) {
            const it = itemOf(f, id);
            if (!it) continue;
            const kind = it.s ? 'status' : RARE_RE.test(it.n) ? 'rare' : DRAGON_RE.test(it.n) ? 'dragon' : null;
            if (!kind) continue;
            kinds[kind]++;
            items[it.n] = (items[it.n] ?? 0) + 1;
        }
    }
    // (a look every `every` ticks: a sighting a look stands for every/500 of the census's 5-minute looks)
    const scale = f.every / 500;
    const total = kinds.status + kinds.rare + kinds.dragon;
    const top = Object.entries(items).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ');
    return { value: round((total * scale) / hours), detail: `${total} pieces in looks at ${SHOW_HUBS.length} places (status ${kinds.status}, rares ${kinds.rare}, dragon ${kinds.dragon})${top ? `: ${top}` : ''}` };
}

/** the family of a members-only wearable (L9's detail) */
function membersFamily(n) {
    if (/dragonhide|dragon_vambraces/.test(n)) return "d'hide";
    if (/glory/.test(n)) return 'glory';
    if (/viking/.test(n)) return 'Fremennik';
    if (/snelm/.test(n)) return 'snelm';
    if (/book_complete/.test(n)) return 'god book';
    if (/berret|cavalier|headband|piratehat|robinhood|boots_ranger|boots_wizard|highwayman/.test(n)) return 'clue hat';
    if (/battlestaff|mystic/.test(n)) return 'battlestaff';
    if (/wolfen|gnome_/.test(n)) return 'robes';
    if (/_cape$/.test(n)) return 'cape';
    if (/^dragon_/.test(n)) return 'dragon';
    if (/goldplate/.test(n)) return 'gilded';
    return 'other';
}

/** L9 (report; members world): members-only wearables seen an hour, worn by the bots online that are no PKers (a bot's piece once a look) */
export function membersWearSeen(r) {
    const f = fashionOf(r);
    if (!f || !r.meta.members) return { value: null };
    const hours = Math.max(1, r.meta.ticks - (r.meta.warmup ?? 0)) / TICKS_PER_HOUR;
    let pieces = 0;
    const fam = {};
    const bots = new Set();
    let looks = 0;
    let withAny = 0;
    for (const x of f.samples) {
        if (PK_PLANNERS2.has(f.names[x.i]?.p)) continue;
        looks++;
        let any = false;
        for (const id of x.w) {
            const it = itemOf(f, id);
            if (!it?.m) continue;
            any = true;
            pieces++;
            const k = membersFamily(it.n);
            fam[k] = (fam[k] ?? 0) + 1;
            bots.add(x.i);
        }
        if (any) withAny++;
    }
    const scale = f.every / 500;
    return { value: round((pieces * scale) / hours), detail: `${pieces} pieces in ${looks} looks (${pct(withAny, looks)} % of looks with one; ${bots.size} bots): ${Object.entries(fam).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}` };
}

/** L10: of the PKers seen, the share with an outfit of their own (the 9 visible slots, each PKer's last look) */
export function pkOutfitsDistinct(r) {
    const f = fashionOf(r);
    if (!f) return { value: null };
    const last = new Map();
    for (const x of f.samples) if (PK_PLANNERS2.has(f.names[x.i]?.p)) last.set(x.i, x);
    if (last.size < 3) return { value: null };
    const outfits = new Map();
    for (const x of last.values()) {
        const key = [0, 1, 2, 3, 4, 5, 7, 9, 10].map(sl => x.w[sl]).join(',');
        outfits.set(key, (outfits.get(key) ?? 0) + 1);
    }
    const shared = [...outfits.values()].filter(n => n > 1).reduce((a, n) => a + n, 0);
    return { value: pct(outfits.size, last.size), detail: `${outfits.size} outfits among ${last.size} PKers seen (${shared} in an outfit another PKer wears)` };
}

/** L11 (report): bots seen in the round's novelty and members show pieces (each bot once) */
export function noveltySeen(r) {
    const f = fashionOf(r);
    if (!f) return { value: null };
    const KINDS = [
        ['mime', /^macro_mime_/],
        ['holy symbol', /^blessedstar$/],
        ['accuracy', /^amulet_of_accuracy$/],
        ['gem amulet', /^strung_(gold|sapphire|emerald|ruby|diamond)_amulet$/],
        ['yellow cape', /^yellow_cape$/],
        ['clue hat', /^(berret_|cavalier_|headband_|piratehat$|robinhoodhat$)/],
        ['snelm', /^snelm_/],
        ['Fremennik helm', /^viking_helmet_/],
        ['Fremennik clothes', /^viking_(top|cloak)_|^vikingboots$/],
        ['god book', /book_complete$/],
        ['robes', /^wolfen|^gnome_(robe|hat)/],
        ['battlestaff', /battlestaff$/],
        ['status', null]
    ];
    const seen = Object.fromEntries(KINDS.map(([k]) => [k, new Set()]));
    for (const x of f.samples) {
        if (PK_PLANNERS2.has(f.names[x.i]?.p)) continue;
        for (const id of x.w) {
            const it = itemOf(f, id);
            if (!it) continue;
            for (const [k, re] of KINDS) if (re ? re.test(it.n) : it.s) seen[k].add(x.i);
        }
    }
    const total = new Set(Object.values(seen).flatMap(s => [...s])).size;
    return { value: total, detail: KINDS.map(([k]) => `${k} ${seen[k].size}`).join(', ') };
}

/** L12 (report): of the women seen, the share in the design screen's bald head (new bodies: fewer bald women) */
export function baldWomen(r) {
    const f = fashionOf(r);
    if (!f || f.baldKit === null || f.baldKit === undefined) return { value: null };
    const women = f.names.filter(n => n.g === 1 && !PK_PLANNERS2.has(n.p));
    if (!women.length) return { value: null };
    const bald = women.filter(n => n.hair === f.baldKit).length;
    return { value: pct(bald, women.length), detail: `${bald} of ${women.length} women seen` };
}

METRICS.push(
    ...[
        ['L6', 'fashion', 'Rich bots seen in a status piece (trims, god or gilded armour)', '%', () => between(12, 30), 'decided', richInStatus],
        ['L6b', 'fashion', 'Status pieces, rares and dragon seen at the trade hubs and the park, an hour', '', () => null, 'report', statusSeenAtHubs],
        ['L9', 'fashion', 'Members-only wearables seen an hour (members world; no PKers)', '', () => null, 'report', membersWearSeen],
        ['L10', 'fashion', 'PKers seen in an outfit of their own (9 visible slots)', '%', () => min(70), 'proposed', pkOutfitsDistinct],
        ['L11', 'fashion', 'Bots seen in the novelty and members show pieces', '', () => null, 'report', noveltySeen],
        ['L12', 'fashion', 'Women seen in the bald design-screen head', '%', () => null, 'report', baldWomen]
    ].map(([id, group, title, unit, band, basis, fn]) => ({ id, group, title, unit, band, basis, fn }))
);
// ---- end of Track W2's (variety) block ----
