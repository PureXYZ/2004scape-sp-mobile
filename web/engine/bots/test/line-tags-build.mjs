#!/usr/bin/env node
// Builds data/line_tags.json: a tag for each of upstream's idle lines (data/bot_phrases.json "idle"), keyed by the exact
// text, that says where and when the line is true or fits ("upstream first, gated": the lines keep
// their words, each is said only where it fits; port/BotLines reads the tags). Run it again when the idle lines change:
//   node web/engine/bots/test/line-tags-build.mjs [--check] [--print[=CATEGORY]] [--unsure]
//     --check    builds the tags and compares them with the committed file (exit 1 if they differ)
//     --print    prints every line with its tag (one category with =CATEGORY)
//     --unsure   prints the lines the keyword rules were unsure about and the hand review did not settle
//
// How a line gets its tag:
//   1. keyword rules (below): the research's meta and modern list (the research,
//      the humanlike report's META) and a few more modern memes make a line 'meme'; departure, "brb", death, drop and
//      level words; the humanlike report's skill and place words (lib/humanlike-metrics.mjs SKILL_WORDS, PLACES: the
//      lines that name a skill or a place are said only where they fit, which is what its H8 judges); questions,
//      greetings, replies; quests, the Wilderness, trade;
//   2. the hand review (REVIEW below): every line the rules were unsure about, and every line whose rule tag was wrong,
//      has its tag written out by hand. The words of a line are never changed.
//
// The tag's fields (port/BotLines LineTag):
//   c        the category: when the line may be said (ambient, question, newbie-question, greeting, response, departure,
//            departure-soon, brb, back, death, close-call, drop-claim, level-claim, skill, place, pk, quest, name-claim,
//            trade, meme)
//   skills   the task kinds it names (Woodcut, Mine, Fish, Combat, Cook, Smith, Thieve, Agility, Firemaking, Fletching,
//            Crafting, Runecrafting, Herblore, Prayer, Ranged, Magic): said only at such a task
//   targets  what it works on (oak, iron, cow, moss giant...): the task's step must be at one of them
//   places   the places it names (port/BotLines PLACE_AREAS keys): said only in one of them; near 'region': within a walk
//            of one, not in it (a destination: "wanna race to varrock?")
//            (near 'away': anywhere but in it: "how do i get to varrock")
//   at       the kind of place it must be said at (bank, trade-bank, wild, town, hub, dungeon, lumbridge-spawn...)
//   cb, total  combat and total level bands [min, max]; members: a members world only
//   who      who says it (meme, rude, friendly, young, kid, adult, pker, pure, levelling, social, vendor, usa, uk...)
//   newbie   only a newbie newcomer; event + within: something that happened to it in the last `within` ticks
//   claim    what a {name} line claims about the player it names, checked on that player; level: what a level claim
//            needs (near: close to its next level in its task's skill; just: a level-up within a few minutes)
//   mins     a departure-soon line's minutes; topic: a question's topic (the conversation answers by it)
//   heard    a response's cue: any (another player's line near it in the last few seconds), levelup (a level-up line),
//            answer (a line after its own question)
//   after    (the variety work, round 1, SAY-6) a heard:any response's cue by the class of the line it follows
//            (port/BotSpoke HeardClass: statement, question, greeting, levelup, mishap, brag, complaint, meme, laugh, rude,
//            thanks, spam, social, newbie; never: a class no line has, the line kept and never said); a response never
//            answers another response
import fs from 'fs';
import path from 'path';
import { BOTS_DIR } from './lib/paths.mjs';
import * as M from './lib/humanlike-metrics.mjs';
import { REVIEW } from './ref/line-tags-review.mjs';

const OUT = path.join(BOTS_DIR, 'data/line_tags.json');
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const PRINT = args.find(a => a.startsWith('--print'));
const UNSURE = args.includes('--unsure');

const phrases = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/bot_phrases.json'), 'utf8'));
const idle = phrases.idle;

// ---- the rules ----

/** modern memes and meta talk the research's list misses (all after 2004, or about the bots and the server) */
const MORE_MODERN = /\breee+\b|insert spiderman|nothin personnel|number 15|muv luv|deez|yall got|\btendies\b|litty|alien warp|\bbloat|\bwe thrivin\b|\bdindin\b|\bbae\b|\btf\b|\bbro\b|\bbros\b|\bmf\b|\bdad jokes?\b|\bi am dad\b|i am bacon|stick ?bug|lootshare|bot updates|bot owner|botting|botscript|i am a player|i am real|real person|not a bot|are you a bot|is a bot|a bot lol|real player|\bbots\b|lost hq|server|forums?\b|the rules\b|updates?\b|private server|youtube|\bfacebook\b|\bxbox live\b|\bguthko\b|propane|marines|mastermind|exterminator|decisive action|darkness overpowering|thread of prophecy|gather your party|intoxicating innocence|crimes against gielinor|\bgoop\b|\bgloop\b|froggay|frog overlord|redrocket|twocan|red bracket|bracket|alexbinthere|\bcallum\b|\bwoah is\b|\bwoah in\b|barbass|\bryan\b|portuguese dude|scraggley|lady ting|we stan|vibe|\bmewing\b|\bsesh\b|\bfreak\b|\bhowbout\b|catch me outside|squeel of fortune|pipe tim|programming|thigh high|bathwater|used socks|\bbags\b|\bdongus\b|deathknight|\braid\b|wizard hat|\bmordor\b|trogdor|\bcopperboy\b|\b530\b|guthix bring|completionist|maxed|\bmax\b|\b99's\b|\bwiki\b|\brng\b|time-traveling|time traveler|admin|\bhdr\b|windows|brightness|stream the window|auto hide|options|runs perfectly|jumpy|laptops|dome fossil|cow level|venezuela|somalian|\bshlisshalpshlaap\b|buru nyaaaa|old random events|old pvp|global pvp|talent trees|world of warcraft|stormwind|goldshire/i;
const BOT_TALK = /\bbot(s|ting|ted)?\b|autoer|macroer/i;

const SWEAR = /\bfuck|\bshit|\bbitch|\bass\b|\bcunt|\bdick|\bdamn|\bcrap/i;

/** skill words beyond the report's: the ones it has (SKILL_WORDS) decide H8, these only add */
const MORE_SKILL = {
    Prayer: /\bprayer\b|\bbury\w*|\bbones\b/i,
    Magic: /\bmagic\b|\bmage\b|\bwind strike\b|\brunes\b|\balch\w*/i,
    Ranged: /\branged?\b|\barrows?\b|\bsafe ?spot\w*/i,
    Crafting: /\bcraft\w*|\bspin\w*|\bwool\b|\bleather\b|\bgold rings?\b|\bgems?\b|\bflax\b|\bsheep\b/i,
    Fish: /\bfish\w*|\blobsters?\b|\blobs\b|\bsharks?\b|\bshrimps?\b|\btrout\b|\bsalmon\b|\bswordfish\b|\bharpoon\b|\bcatherby\b/i,
    Thieve: /\bthiev\w*|\bpickpocket\w*|\bstalls?\b|\bstunned\b/i
};

const TARGET_WORDS = [
    ['oak', /\boaks?\b/i], ['willow', /\bwillows?\b/i], ['yew', /\byews?\b/i], ['maple', /\bmaples?\b/i],
    ['iron', /\biron\b/i], ['coal', /\bcoal\b/i], ['tin', /\btin\b/i], ['copper', /\bcopper\b/i], ['clay', /\bclay\b/i],
    ['rune-ore', /\brunite\b|\brune rocks?\b/i], ['ess', /\brune essence\b|\bpure essence\b|\bess\b/i],
    ['lobster', /\blobsters?\b|\blobs\b/i], ['shark', /\bsharks?\b/i],
    ['cow', /\bcows?\b/i], ['chicken', /\bchickens?\b/i], ['goblin', /\bgoblins?\b/i], ['moss giant', /\bmoss giants?\b/i],
    ['hill giant', /\bhill giants?\b/i], ['barbarian', /\bbarbarians?\b/i], ['al kharid warrior', /\bal kharid warriors?\b/i],
    ['white knight', /\bwhite knights?\b/i], ['dark wizard', /\bdark wizards?\b/i], ['lesser demon', /\blesser demons?\b/i],
    ['green dragon', /\bgreen dragons?\b/i], ['man', /\bpickpocketing men\b/i]
];

/** places the lines name: [key, regex] (port/BotLines PLACE_AREAS has where each is) */
const PLACE_WORDS = [
    ['lumbridge_castle', /\blumbridge castle\b/i], ['lumbridge_swamp', /\blumbridge swamp\b/i], ['lumbridge', /\blumbridge\b|\blumby\b|\blumbrich\b/i],
    ['varrock_square', /\bvarrock square\b/i], ['varrock_sewers', /\bvarrock sewers\b/i], ['varrock', /\bvarrock\b/i],
    ['falador_park', /\bfally park\b|\bfalador park\b/i], ['falador', /\bfalador\b|\bfally\b/i],
    ['draynor_manor', /\bdraynor manor\b|\bcount draynor\b/i], ['draynor', /\bdraynor\b/i],
    ['edgeville_dungeon', /\bedgeville dungeon\b/i], ['edgeville', /\bedgeville\b/i],
    ['al_kharid', /\bal ?kharid\b|\bthe desert\b/i], ['port_sarim', /\bport sarim\b/i], ['karamja', /\bkaramja\b|\bmusa point\b/i],
    ['catherby', /\bcatherby\b/i], ['seers', /\bseers\b/i], ['ardougne', /\bardougne\b|\bardy\b/i], ['yanille', /\byanille\b/i],
    ['camelot', /\bcamelot\b/i], ['taverley', /\btaverl[e]?y\b/i], ['barbarian_village', /\bbarbarian village\b|\bbarb village\b/i],
    ['rimmington', /\brimmington\b/i], ['goblin_village', /\bgoblin village\b/i], ['ice_dungeon', /\basgarnian ice dungeon\b/i],
    ['gnome_stronghold', /\bgnome stronghold\b/i], ['fishing_guild', /\bfishing guild\b/i], ['duel_arena', /\bduel arena\b/i],
    ['brimhaven', /\bbrimhaven\b/i]
];
const MEMBERS_PLACES = new Set(['catherby', 'seers', 'ardougne', 'yanille', 'camelot', 'taverley', 'gnome_stronghold', 'fishing_guild', 'duel_arena', 'brimhaven']);

const QUESTS = /\b(dragon slayer|cooks? assistant|cook's assistant|vampire slayer|imp catcher|romeo and juliet|goblin diplomacy|doric'?s quest|black knights'? fortress|pirate'?s treasure|ernest the chicken|restless ghost|rune mysteries|knight'?s sword|prince ali|merlin'?s crystal|heroes'? quest|family crest|waterfall quest|tree gnome village|grand tree|fremennik trials|horror from the deep|mort'?ton|underground pass|elemental workshop|legends'? quest|recipe for disaster|silverlight|map piece|elvarg|melzar|quest)\b/i;
const MEMBERS_QUESTS = /merlin|heroes|hero's|family crest|waterfall|tree gnome|grand tree|fremennik|horror from the deep|mort'?ton|underground pass|elemental|legends|duel arena|gnomeball|fishing trawler|brimhaven/i;
const PK_WORDS = /\bpk\w*|\bwildy\b|\bwilderness\b|\bskulled\b|\bpure\b|\blure\w*|\bsafe ?spot\w*|\bsit\b|\bowned\b|\bownage\b/i;
const TRADE_WORDS = /\bselling\b|\bbuying\b|\btrade me\b|\bbank sale\b|\bb sale\b|\bworth\b|\bprice\b|\bgp\b|\bcoins\b|\b\d+k\b|\b\d+m\b/i;
const GREETING = /^(hey|hi|hello|hellooo+|heyy+|yo|sup|wassup|wasss+u+p+|hiya|heya|good morning|greetings)\b/i;
const RESPONSES = new Set(['nice', 'gz', 'gg', 'ty', 'np', 'ok', 'kk', 'yes', 'no', 'nah', 'why?', 'why', '?', 'lol', 'lol omg', 'omg', 'rofl', 'haha', 'hehe', 'roflmao', 'same as you', 'me too', 'excuse me ?', 'what do you mean', 'lol shut up', 'how is that even possible', 'that is hilarious', 'i agree 100%', 'i could not agree more', 'thats not right', 'never mind', 'nonsense', 'get real', 'cry about it', 'come on', 'why would he say that', 'good idea', 'excellent', 'alright', 'yes mate', 'no problem', 'thanks so much.', 'thank you very much', 'thanks for your help', 'thank you. that helps a lot.', 'very good, thanks', 'i really appreciate you', 'sounds tricky.', 'i do not understand.', 'could you repeat that please ?', 'could you please talk slower ?', 'i cannot hear you.', 'what that do', 'wbu ?', 'same as always', 'only on tuesdays', 'is that enough ?', 'let me think about it', 'i do not like it', 'i do not like him', 'dont take it personally', 'that sounds great {name}.', 'how does that sound ?', 'what do you think ?', 'i am sorry.', 'sorry to bother you', 'ah i was about to type that', 'that is one i havent seen before', 'you will get it in due time', 'i swear if you need roll again']);

function ruleTag(text) {
    const t = text.toLowerCase();
    const why = [];
    let unsure = false;
    const tag = { c: 'ambient' };
    const set = (c, reason) => {
        tag.c = c;
        why.push(reason);
    };
    const named = text.includes('{name}');
    if (M.META.test(text) || MORE_MODERN.test(text)) set('meme', 'meta/modern');
    else if (BOT_TALK.test(text)) set('meme', 'bot talk');
    else if (/\bin \d+ minutes\b/i.test(text)) set('departure-soon', 'in N minutes');
    else if (!named && M.isDeparture(text)) set('departure', 'departure words');
    else if (!named && M.BRB.test(text)) set('brb', 'brb words');
    else if (/^back$/i.test(text.trim())) set('back', 'back');
    else if (/\bi died\b|\bpked\b|\blost all my stuff\b|\bjust died\b|\byou are dead\b/i.test(text)) set('death', 'death words');
    else if (/\bdrop\b/i.test(text) && /\b(got|my first|just got)\b/i.test(text)) set('drop-claim', 'drop words');
    else if (/\b99\b|\blevel \d+|\bmore level|\bleveling\b|\bone more level\b/i.test(text)) set('level-claim', 'level words');
    else if (M.NEWBIE_QUESTION.test(text.trim())) set('newbie-question', 'newbie question');
    else if (M.isQuestion(text)) set('question', 'question');
    else if (GREETING.test(text.replace('{name}', '').trim()) && words(text) <= 4) set('greeting', 'greeting');
    else if (RESPONSES.has(t.trim())) set('response', 'reply word');
    else if (QUESTS.test(text)) set('quest', 'quest');
    else if (PK_WORDS.test(text)) set('pk', 'pk words');
    else if (TRADE_WORDS.test(text)) set('trade', 'trade words');
    else {
        unsure = true;
        why.push('no rule');
    }
    // what it names
    const skills = Object.keys(M.SKILL_WORDS).filter(k => M.SKILL_WORDS[k].test(text));
    for (const [k, rx] of Object.entries(MORE_SKILL)) if (rx.test(text) && !skills.includes(k)) skills.push(k);
    if (skills.length) tag.skills = skills;
    const targets = TARGET_WORDS.filter(([, rx]) => rx.test(text)).map(([k]) => k);
    if (targets.length) tag.targets = targets;
    const places = [];
    for (const [k, rx] of PLACE_WORDS) {
        if (!rx.test(text)) continue;
        // the more specific first ("lumbridge castle" before "lumbridge")
        if (places.some(p => k.startsWith(p) || p.startsWith(k))) continue;
        places.push(k);
    }
    if (places.length) tag.places = places;
    if (tag.c === 'ambient' && skills.length) set('skill', 'skill words');
    else if (tag.c === 'ambient' && places.length) set('place', 'place words');
    if (places.some(p => MEMBERS_PLACES.has(p)) || (QUESTS.test(text) && MEMBERS_QUESTS.test(text))) tag.members = true;
    if (SWEAR.test(text) && tag.c !== 'meme') {
        tag.who = ['rude'];
        why.push('swearing: rude personas');
    }
    if (named && !['meme'].includes(tag.c)) unsure = true;
    return { tag, why, unsure };
}

function words(text) {
    return text.split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length;
}

// ---- the hand review ----
// Each entry: the exact line, then its tag in a short form (parsed by parseSpec):
//   CATEGORY [s:Kind,Kind] [t:target,target] [p:place,place] [p~:place] [at:type,type] [cb:MIN-MAX] [tot:MIN-MAX]
//   [m] [who:a,b] [nb] [ev:event] [within:TICKS] [claim:X] [level:X] [mins:N] [topic:X] [heard:X] [after:class,class]
// A line in this table gets exactly this tag (the rules' guess is dropped).
const CATS = { amb: 'ambient', q: 'question', nq: 'newbie-question', greet: 'greeting', resp: 'response', dep: 'departure', soon: 'departure-soon', brb: 'brb', back: 'back', death: 'death', close: 'close-call', drop: 'drop-claim', lvl: 'level-claim', skill: 'skill', place: 'place', pk: 'pk', quest: 'quest', claim: 'name-claim', trade: 'trade', meme: 'meme' };

function parseSpec(spec) {
    const [cat, ...rest] = spec.trim().split(/\s+/);
    const c = CATS[cat];
    if (!c) throw new Error(`unknown category "${cat}" in "${spec}"`);
    const tag = { c };
    const list = v => v.split(',').map(s => s.replaceAll('_', ' ').trim()).filter(Boolean);
    const band = v => {
        const [a, b] = v.split('-');
        return [a === '' ? 0 : Number(a), b === undefined || b === '' ? 9999 : Number(b)];
    };
    for (const tok of rest) {
        const i = tok.indexOf(':');
        const k = i === -1 ? tok : tok.slice(0, i);
        const v = i === -1 ? '' : tok.slice(i + 1);
        if (k === 's') tag.skills = v.split(',');
        else if (k === 't') tag.targets = list(v);
        else if (k === 'p') tag.places = v.split(',');
        else if (k === 'p~') {
            tag.places = v.split(',');
            tag.near = 'region';
        } else if (k === 'p!') {
            tag.places = v.split(',');
            tag.near = 'away';
        } else if (k === 'at') tag.at = v.split(',');
        else if (k === 'heard') tag.heard = v;
        else if (k === 'after') tag.after = v.split(',');
        else if (k === 'cb') tag.cb = band(v);
        else if (k === 'tot') tag.total = band(v);
        else if (k === 'm') tag.members = true;
        else if (k === 'who') tag.who = v.split(',');
        else if (k === 'nb') tag.newbie = true;
        else if (k === 'ev') tag.event = v;
        else if (k === 'within') tag.within = Number(v);
        else if (k === 'claim') tag.claim = v;
        else if (k === 'level') tag.level = v;
        else if (k === 'mins') tag.mins = Number(v);
        else if (k === 'topic') tag.topic = v;
        else throw new Error(`unknown field "${k}" in "${spec}"`);
    }
    return tag;
}

// ---- build ----
const review = new Map();
for (const [text, spec] of REVIEW) {
    if (review.has(text)) throw new Error(`reviewed twice: ${JSON.stringify(text)}`);
    review.set(text, spec);
}
const known = new Set(idle);
const stale = [...review.keys()].filter(t => !known.has(t));
if (stale.length) {
    console.error(`line-tags: ${stale.length} reviewed line(s) not among the idle lines: ${stale.slice(0, 5).map(s => JSON.stringify(s)).join(', ')}`);
    process.exit(1);
}

const tags = {};
const unsure = [];
const counts = {};
for (const text of idle) {
    const rule = ruleTag(text);
    let tag;
    if (review.has(text)) tag = parseSpec(review.get(text));
    else {
        tag = rule.tag;
        if (rule.unsure) unsure.push({ text, rule });
    }
    tags[text] = tag;
    counts[tag.c] = (counts[tag.c] ?? 0) + 1;
}

const out = {
    about:
        "A tag for each of upstream's idle lines (bot_phrases.json \"idle\", keyed by the exact text): where and when the line is true or fits (upstream first, gated; port/BotLines). Made by test/line-tags-build.mjs: keyword rules, then a hand review of every line the rules were unsure about (test/ref/line-tags-review.mjs). The words of the lines are never changed.",
    tags
};
const json = `{\n    "about": ${JSON.stringify(out.about)},\n    "tags": {\n${Object.entries(tags)
    .map(([k, v]) => `        ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n')}\n    }\n}\n`;

if (PRINT) {
    const only = PRINT.includes('=') ? PRINT.split('=')[1] : null;
    for (const [text, tag] of Object.entries(tags)) {
        if (only && tag.c !== only) continue;
        const { c, ...rest } = tag;
        console.log(`${c.padEnd(16)} ${JSON.stringify(text)} ${Object.keys(rest).length ? JSON.stringify(rest) : ''}${review.has(text) ? '' : '  (rules)'}`);
    }
}
if (UNSURE) for (const u of unsure) console.log(`unsure: ${JSON.stringify(u.text)} -> ${JSON.stringify(u.rule.tag)} (${u.rule.why.join(', ')})`);
console.log(`line-tags: ${idle.length} lines, ${review.size} reviewed by hand, ${unsure.length} unsure left; ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);

if (CHECK) {
    const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (now !== json) {
        console.error('line-tags: data/line_tags.json is out of date (run test/line-tags-build.mjs)');
        process.exit(1);
    }
    console.log('line-tags: data/line_tags.json is up to date');
} else if (!PRINT && !UNSURE) {
    fs.writeFileSync(OUT, json);
    console.log(`line-tags: wrote ${path.relative(process.cwd(), OUT)}`);
}
if (unsure.length && !PRINT && !UNSURE) {
    console.error(`line-tags: ${unsure.length} line(s) still unsure: review them (--unsure)`);
    process.exit(1);
}
