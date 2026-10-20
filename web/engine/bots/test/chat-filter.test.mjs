#!/usr/bin/env node
// What the bots say and the names they answer to, through the game's word filter (WordEnc with the real 274 data,
// loaded as World.start loads it). Bots speak with the SAY mask, which the client shows unfiltered, so every line goes
// through WordEnc.filter (port/BotSay), as a human's chat does: swearing shows as "****", as it did in 2004.
//   phrases  the idle lines of data/bot_phrases.json (upstream's, swearing, people and all, and the port's) are whole:
//            where a player's name was cut out there is a {name} gap, which BotPlayer fills in (no line starts with a
//            space or a comma, none has a gap of two spaces); no chat-effect prefix (the SAY mask would show it as
//            text); no line twice. Every level-up line a bot may say (port/BotLines: the 2004 forms, upstream's phrases
//            folded in) passes the filter, for every stat, and every one of upstream's phrases is in some;
//   2004     every new line (data/lines2004.json, port/BotLines) and every PK line passes it untouched (their styled
//            variants: test/lines.test.mjs);
//   replies  the replies in data/chat_responses.json may be masked in part (upstream's, as said); every other line
//            port/BotChat says (BOT_CHAT_LINES) passes the filter, and the addressed bot's greeting is joined to an
//            answer only where the whole line stays clean (joinGreeting);
//   names    every name in data/names.json passes it, and a human's line naming the bot still names it after the
//            client and server are done with it (packed, unpacked in sentence case, filtered): else that bot could
//            never be talked to;
//   talk     the realism work's lines (phase 2, the conversation), each template with its slots filled from every value
//            they take (or a sample): the answers from a bot's state (port/BotAnswers: directions to every town and bank
//            in every compass word, prices in every form, asl in every region, quests, money tips, newbie help), the
//            greetings back, "?"/"wat", the crowd's second reactions and rude answers, the vendor's in-character
//            answers, the bots' lines to each other (gz, ty, "idk"), every practice (data/practices.json) and every
//            reaction to a human (port/BotReactions);
//   adverts  (the realism work, phase 4) a vendor's adverts: every stock item's every nickname in each advert form of its
//            kind, at prices in each form, keeps 3+ forms the filter leaves whole; trade talk's lines with their prices;
//   charset  every line above, a vendor's adverts for every stock item, and every string the bots' code says
//            (botSay, BotPlayer._say, BotChat's private messages and typed lines, followed through the file's consts, fields and
//            object properties) travel whole in the chat codec (274's WordPack: lower-case letters, digits, the space
//            and !?.,:;()-&*\'@#+=£$%"[]; a "/", "^", "_", "<" or ">" arrives as a space, so "^_^" showed as nothing).
// The filter reads across words ("Hey Casey, Gl!" looks like a web address), so port/BotChat adds a greeting, a
// "lol" or a "Haha" to a reply only where the whole line stays clean; this checks the parts it builds from.
//
//   node web/engine/bots/test/chat-filter.test.mjs
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, typescript } from './lib/paths.mjs';
import { importInEngine } from './lib/clone.mjs';
import { reachableBotModules } from './lib/graph.mjs';

const phrases = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/bot_phrases.json'), 'utf8'));
const responses = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/chat_responses.json'), 'utf8'));
const names = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/names.json'), 'utf8')).names;
const lib = await importInEngine(path.join(BOTS_DIR, 'test/lib/chatfilter.ts'), 'unit-chat-filter');
lib.loadWordEnc();

const failures = [];
const notes = [];
let checked = 0;
const check = (what, ok, detail = '') => {
    checked++;
    if (!ok) failures.push(`${what}${detail ? `: ${detail}` : ''}`);
};
/** Every line the bots can say (line → what it is), for the chat codec's charset (below). */
const sayable = new Map();
const canSay = (what, line) => {
    if (!sayable.has(line)) sayable.set(line, what);
};
/** The line passes the filter unchanged. */
const clean = (what, line) => {
    canSay(what, line);
    const filtered = lib.filter(line);
    check(`${what} ${JSON.stringify(line)} passes the word filter`, filtered === line, JSON.stringify(filtered));
};

// the data is loaded: the filter masks what it should
check('the word filter is loaded (it masks a swear word)', lib.filter('what the fuck') === 'what the ****', lib.filter('what the fuck'));

// ---- phrases ----
const EFFECT = /\b(?:red|green|cyan|purple|white|yellow|flash[1-3]|glow[1-3]|wave2?|scroll|slide|shake):/i;
check('at least 600 idle phrases', phrases.idle.length >= 600, `${phrases.idle.length}`);
const seen = new Set();
let masked = 0;
let named = 0;
for (const line of phrases.idle) {
    check(`idle phrase ${JSON.stringify(line)}: whole (a cut-out name is a {name} gap)`, line.trim() === line && !line.startsWith(',') && !/\S {2,}\S/.test(line) && !/(^|\s),\s*[?!.]/.test(line));
    check(`idle phrase ${JSON.stringify(line)}: no chat effect`, !EFFECT.test(line));
    check(`idle phrase ${JSON.stringify(line)}: not twice`, !seen.has(line.toLowerCase()));
    seen.add(line.toLowerCase());
    const said = lib.fillName(line, 'Lumby Larry');
    canSay('idle phrase', said);
    check(`idle phrase ${JSON.stringify(line)}: no gap left once a name is in`, !/[{}]/.test(said), said);
    if (line.includes('{name}')) named++;
    if (lib.filter(said) !== said) masked++;
}
notes.push(`${named} idle lines name a player near the bot; the filter masks part of ${masked} (as it would a human's)`);
check('level-up phrases', phrases.levelup.length >= 5, `${phrases.levelup.length}`);
// port (the realism work, phase 2): upstream's "<phrase> - <stat> <level>" was every level-up line's shape (the
// humanlike report's H10: 100 %); the 2004 forms fold the phrases in ("finally! 40 wc"), and a form the filter would
// mask ("level up! 40 wc": "pw" read across the words) is never said
{
    let masked = 0;
    let candidates = 0;
    const said = new Set();
    for (const level of [2, 15, 40, 43, 99]) {
        const lines = lib.levelUpLines(level);
        candidates += lines.candidates.length;
        masked += lines.candidates.length - lines.said.length;
        for (const line of lines.said) {
            said.add(line);
            canSay('level-up line', line);
            const filtered = lib.filter(line);
            check(`level-up line ${JSON.stringify(line)} passes the word filter`, filtered === line, JSON.stringify(filtered));
        }
    }
    for (const phrase of phrases.levelup) check(`level-up phrase ${JSON.stringify(phrase)} is folded into the forms, word for word`, lib.UPSTREAM_LEVELUP.includes(phrase) && [...said].some(l => l.includes(phrase)));
    notes.push(`${said.size} distinct level-up lines; the filter masks ${masked} of ${candidates} form-skill-level candidates, which are never said`);
}

// ---- the 2004 lines and the PK lines (port/BotLines) ----
// (revised in the variety work, round 1, Track S: a line with slots ({place} {target} {n} ...: port/BotSlots) is checked
// with each slot filled from each of its values in turn, the others at their first: as said, never as written)
const varietyJson = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/lines2004-variety.json'), 'utf8'));
const slotValues = { ...lib.Slots.slotSamples(), clan: varietyJson.clans };
let slotLines = 0;
for (const line of lib.NEW_LINES) {
    const slots = lib.Slots.slotsIn(line.text);
    if (!slots.length) {
        clean(`2004 line (${line.tag.c})`, line.text);
        continue;
    }
    const first = Object.fromEntries(slots.map(k => [k, slotValues[k][0]]));
    const filledLines = new Set([lib.Slots.fillSlots(line.text, first)]);
    for (const k of slots) for (const v of slotValues[k]) filledLines.add(lib.Slots.fillSlots(line.text, { ...first, [k]: v }));
    for (const said of filledLines) {
        clean(`2004 line with slots (${line.tag.c})`, said);
        slotLines++;
    }
}
notes.push(`${slotLines} slot lines (templates filled) checked`);
for (const [kind, lines] of Object.entries(lib.PK_LINES)) for (const line of lines) clean(`PK line (${kind})`, line);
// (revised in the realism work's phase 5a: the 400-600 is lines2004.json's own library; phase 5a's files of lines,
// data/lines2004-texture.json and data/lines2004-events.json, come on top of it, and NEW_LINES holds them all)
// (revised in phase 5b, Track D: every data/lines2004-*.json file's groups, phase 5a's and 5b's (groups, parties, arena),
// so a track's own file counts without a new edit here)
{
    const count = file => JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data', file), 'utf8')).groups.reduce((n, g) => n + g.lines.length, 0);
    const base = count('lines2004.json');
    const phase5 = fs
        .readdirSync(path.join(BOTS_DIR, 'data'))
        .filter(f => /^lines2004-.+\.json$/.test(f))
        .reduce((n, f) => n + count(f), 0);
    check("400-600 new 2004 lines in lines2004.json, phase 5's files' on top, all in the pool", base >= 400 && base <= 600 && lib.NEW_LINES.length === base + phase5, `${base} + ${phase5} = ${lib.NEW_LINES.length}`);
}
// ---- (realism phase 5b, Track A: the Duel Arena and the player-mod bot) its lines (data/lines2004-arena.json, in NEW_LINES
// above: every one clean as written), said at their moment only; the mod's answers are BotAnswers' (ANSWER_LINES below) ----
{
    const arena = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/lines2004-arena.json'), 'utf8'));
    let n = 0;
    for (const g of arena.groups) {
        check(`Track A's group ${JSON.stringify(g.tag)}: an event of its own (never an idle pick)`, g.tag.c === 'event' && ['duel', 'mod'].includes(g.tag.event) && g.tag.kinds?.length === 1);
        for (const line of g.lines) {
            clean(`Track A's own line (${g.tag.event} ${g.tag.kinds})`, line);
            n++;
        }
    }
    // (the screens' "max" lines: one for each cap a bot may offer the human, port/BotArena.humanCap's sums)
    const duel = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/duel.json'), 'utf8'));
    const maxLines = arena.groups.filter(g => g.tag.event === 'duel' && g.tag.kinds?.includes('screen-max')).flatMap(g => g.lines);
    check("Track A's \"max\" lines name each cap a bot offers the human", duel.human.caps.every(c => maxLines.some(l => new RegExp(`\\b${c / 1000}k\\b`).test(l))), maxLines);
    check("Track A's lines: some", n > 100, `${n}`);
}
// ---- end of Track A's (phase 5b) block ----

// ---- (realism phase 5a, Track M: movement and magic) the lines said only at their moment (data/lines2004-texture.json
// "magic": port/BotTeleport's last law, said through port/BotAlch.sayMagicLine; Track M's groups are in NEW_LINES above) ----
{
    const texture = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/lines2004-texture.json'), 'utf8'));
    let n = 0;
    for (const [pool, lines] of Object.entries(texture.magic ?? {})) {
        for (const line of lines) {
            clean(`Track M's own line (${pool})`, line);
            n++;
        }
    }
    check("Track M's lines said at their moment: some", n > 0, `${n}`);
}
// ---- end of Track M's (phase 5a) block ----

// ---- (the variety work, round 1, Track S) catchphrases, clan names, a seller's talk and breaks ----
{
    let n = 0;
    for (const [pool, lines] of Object.entries(varietyJson.catchphrases)) for (const line of lines) (clean(`catchphrase (${pool})`, line), n++);
    for (const clan of varietyJson.clans) (clean('clan name', clan), n++);
    check('Track S: catchphrases for every persona pool, clan names', ['any', 'kid', 'teen', 'adult', 'meme', 'rude', 'friendly'].every(k => varietyJson.catchphrases[k]?.length) && varietyJson.clans.length >= 10);
    // (a seller's talk with every stock item's every nickname at a few prices, and each count form)
    const sellerSlots = { n: [...new Set(lib.vendorStock().flatMap(item => [...(item.nicks ?? []), lib.vendorItemName(item).toLowerCase()]))], p: ['25', '150', '1.5k', '12.5k', '95k', '1.2m'], c: ['20', '300', '3k'] };
    for (const [pool, templates] of Object.entries(lib.VENDOR_PATTER)) {
        for (const template of templates) {
            for (const nick of sellerSlots.n) {
                for (const p of sellerSlots.p.slice(0, template.includes('{p}') ? 6 : 1)) {
                    for (const c of sellerSlots.c.slice(0, template.includes('{c}') ? 3 : 1)) {
                        const line = template.replace('{n}', nick).replace('{p}', p).replace('{c}', c);
                        // (VendorTask says one the filter changes never: another, or its advert)
                        canSay(`seller's talk (${pool})`, line);
                        n++;
                    }
                }
            }
        }
    }
    for (const line of [...lib.VENDOR_BREAK.brb, ...lib.VENDOR_BREAK.back]) (clean("seller's break", line), n++);
    notes.push(`Track S: ${n} catchphrases, clan names and seller's lines checked`);
}

// ---- replies ----
const HUMAN = 'Casey';
const botNames = lib.BOT_NAMES.map(n => lib.toDisplayName(n));
const text = r => (typeof r === 'string' ? r : r.text);
/** As formatReply fills the reply in ({myname} once per bot name). */
function filled(reply, myNames = botNames) {
    const base = text(reply)
        .replaceAll('{name}', HUMAN)
        .replaceAll('{total}', '1234')
        .replace(/\{(?!myname\})[a-z0-9]+\}/g, '99');
    return base.includes('{myname}') ? myNames.map(n => base.replaceAll('{myname}', n)) : [base];
}
const answers = [...responses.greetings.replies, ...responses.help.replies, ...responses.intents.flatMap(i => i.replies)];
const greetings = responses.greetingReplies;
const L = lib.BOT_CHAT_LINES;
const allReplies = [...answers, ...greetings, ...responses.fallback, ...L.goodbye];
let repliesMasked = 0;
for (const reply of allReplies) {
    for (const line of filled(reply)) {
        canSay('reply', line);
        if (lib.filter(line) !== line) repliesMasked++;
    }
}
notes.push(`the filter masks part of ${repliesMasked} filled-in replies (upstream's, as said)`);
for (const line of [...L.ending, ...L.wildernessRefusals, ...L.tradingRefusals, ...L.fightingRefusals, ...L.laughPrefixes, ...L.yesPrefixes, ...L.noPrefixes, ...L.friendOpeners, ...L.hiAnswers, ...L.tyAnswers]) clean('BotChat line', line);
// (the variety work, round 1, Track S: a newbie's welcome and its thanks; a friend's first message, about what it does or a
// level it got: BotChat says one only where the filter leaves it whole, else an opener above)
for (const line of [...L.newbieWelcome, ...L.newbieWelcomeTy]) clean('BotChat line (welcome)', line);
check('Track S: a friend\'s first message has its forms', L.friendDoing.length >= 5 && L.friendLevel.length >= 3);
for (const template of L.friendLevel) for (const skill of ['wc', 'att', 'fishing', 'mining', 'prayer', 'mage', 'range']) canSay('friend (level)', template.replace('{n}', '40').replace('{skill}', skill));
for (const template of L.friendDoing) canSay('friend (doing)', template.replace('{doing}', 'cutting willows in draynor'));
// (the realism work: no " :)", " :D" or " lol" added to one reply in five any more; composeReply adds the persona's own
// smiley or laugh now and then, where the whole line stays clean: test/persona.test.mjs checks their charset)
check('BotChat has refusals for "come here" into the Wilderness', L.wildernessRefusals.length > 0);
// the addressed bot's greeting with each answer: the whole line when it is clean, else the answer alone (with a
// sample of the bot names: each name alone is checked above)
let joinedWhole = 0;
let joinedTotal = 0;
const someNames = botNames.filter((_, i) => i % 10 === 0);
for (const greeting of greetings.flatMap(g => filled(g))) {
    for (const answer of answers.flatMap(a => filled(a, someNames))) {
        const line = lib.joinGreeting(greeting, answer);
        check(`greeting and answer ${JSON.stringify(line)}: joined only when the whole line passes the filter`, line === answer || lib.filter(line) === line, JSON.stringify(lib.filter(line)));
        joinedTotal++;
        if (line !== answer) joinedWhole++;
    }
}

// ---- a newbie newcomer's lines (port/BotNewbie): its questions, its begs with a sample of names, its thanks ----
for (const line of [...lib.NEWBIE_QUESTIONS, ...L.newbieThanks]) clean('newbie line', line);
for (const beg of lib.NEWBIE_BEGS) {
    check(`newbie beg ${JSON.stringify(beg)}: has a name gap`, beg.includes('{name}'));
    for (const name of botNames.filter((_, i) => i % 50 === 0)) clean('newbie beg', lib.fillName(beg, name));
}

// ---- a PKer's lines to the player it killed and on its way out (port/BotPkTactics) ----
for (const line of [...lib.KILL_LINES, ...lib.ESCAPE_LINES]) clean('PKer line', line);

// ---- answers from a bot's own state (port/BotActivity, port/BotPlaces) ----
// (a "where are you" template that would trip the filter falls back to the bare place, a "what are you doing" suffix
// to the bare line: the bare ones must pass)
const capital = t => t[0].toUpperCase() + t.slice(1);
const places = lib.allPlacePhrases();
for (const place of places) clean('place', capital(place));
let whereMasked = 0;
for (const template of L.where) {
    for (const place of places) {
        const line = template.replace('{place}', capital(place));
        canSay('"where are you" reply', line);
        if (lib.filter(line) !== line) whereMasked++;
    }
}
for (const suffix of L.doingSuffixes) canSay('"doing" suffix', suffix);
notes.push(`"where are you": ${whereMasked} of ${L.where.length * places.length} place lines fall back to the bare place`);
for (const line of [...L.nowhere, ...L.dance, ...L.combatLevel.flatMap(t => filled(t))]) clean('BotChat line', line);
for (const suffix of L.doingSuffixes) check(`"doing" suffix ${JSON.stringify(suffix)}: nothing to mask on its own`, suffix === '' || lib.filter(`ok${suffix}`) === `ok${suffix}`);
// every step a task of each kind can work at, with its place, as the bot says it
const KINDS = { Woodcut: 'WOODCUTTING', Fish: 'FISHING', Mine: 'MINING', Cook: 'COOKING', Combat: 'ATTACK', Thieve: 'THIEVING', Smith: 'SMITHING', Crafting: 'CRAFTING', Agility: 'AGILITY', Firemaking: 'FIREMAKING', Fletching: 'FLETCHING', Runecrafting: 'RUNECRAFT', Herblore: 'HERBLORE' };
let activities = 0;
for (const [kind, skill] of [...Object.entries(KINDS), ['RangedMagic', 'RANGED'], ['RangedMagic', 'MAGIC']]) {
    for (const step of lib.SkillProgression[skill] ?? []) {
        const what = lib.activityFor(kind, step);
        if (!what) continue;
        const where = lib.placePhrase(step.location[0], step.location[1]);
        clean('activity', where ? `${what} ${where}` : what);
        activities++;
    }
}
check('activity lines: one for every step of every kind', activities > 200, `${activities}`);

// ---- the realism work (phase 2, the conversation): every new pool, its slots filled ----
{
    /** each template with each slot filled from each of its values in turn (the other slots at their first value) */
    const fills = (template, slots) => {
        const keys = [...template.matchAll(/\{([a-z_]+)\}/g)].map(m => m[1]).filter((k, i, all) => all.indexOf(k) === i);
        const first = Object.fromEntries(keys.map(k => [k, (slots[k] ?? [`{${k}}`])[0]]));
        const out = new Set([keys.reduce((t, k) => t.replaceAll(`{${k}}`, first[k]), template)]);
        for (const k of keys) for (const v of slots[k] ?? []) out.add(keys.reduce((t, kk) => t.replaceAll(`{${kk}}`, kk === k ? v : first[kk]), template));
        return [...out];
    };
    const W = lib.ANSWER_WORDS;
    const prices = [3, 25, 450, 1500, 12500, 27500, 250000, 1200000, 100000000].map(lib.formatGp);
    const slots = {
        // (a human's name: composeReply says a line with it only where the whole line stays clean, else without it)
        name: ['Casey', 'sim human'],
        age: ['10', '13', '16', '21', '34'], g: ['m', 'f'], region: W.regions, combat: ['3', '45', '99'], n: ['1', '45', '99'],
        price: prices, dir: ['north', 'north east', 'east', 'south east', 'south', 'south west', 'west', 'north west'],
        bank: W.banks, town: W.towns, mid: W.towns, place: lib.allPlacePhrases().map(p => p.toLowerCase()), quest: W.quests, tip: W.money,
        item: ['lobsters', 'lobs', 'rune scimitar', 'coal', 'yew logs', 'nature runes', 'ess', 'rune scim', 'iron ore', 'swordies'],
        where: ['varrock west bank', 'varrock east bank', 'fally west bank', 'fally east bank', 'draynor bank', 'edge bank', 'al kharid bank', 'catherby bank', 'seers bank', 'ardy south bank', 'ardy north bank', 'in varrock', 'near draynor'],
        // (what a bot does, as "u there?" gets it: every step's activity, lower case)
        doing: [...new Set(Object.entries(KINDS).flatMap(([kind, skill]) => (lib.SkillProgression[skill] ?? []).map(step => lib.activityFor(kind, step)).filter(Boolean).map(a => a.toLowerCase().replace(/ lol$/, ''))))]
    };
    let talkLines = 0;
    const cleanAll = (what, templates) => {
        for (const template of templates) {
            for (const line of fills(template, slots)) {
                clean(what, line);
                talkLines++;
            }
        }
    };
    // (slots that meet: "14 f uk" reads as a swear word to the filter; port/BotChat draws such a line again, so every
    // body and home needs a clean way to say its asl)
    const regionWords = { usa: ['usa', 'us', 'america'], uk: ['uk', 'england', 'britain'] };
    for (const g of ['m', 'f']) {
        for (const region of W.regions) {
            const ways = lib.ANSWER_LINES.asl.map(t => t.replace('{age}', '14').replace('{g}', g).replace('{region}', region));
            const sameHome = Object.values(regionWords).find(words => words.includes(region)) ?? [region];
            const all = lib.ANSWER_LINES.asl.flatMap(t => sameHome.map(r => t.replace('{age}', '14').replace('{g}', g).replace('{region}', r)));
            check(`asl: a ${g} from ${region} has a way to say it the filter leaves whole`, all.some(l => lib.filter(l) === l), ways.map(l => lib.filter(l)).join(' | '));
        }
    }
    for (const [pool, lines] of Object.entries(lib.ANSWER_LINES)) {
        if (pool === 'asl') continue;
        cleanAll(`answer (${pool})`, lines);
    }
    // (asl's templates with each slot in turn: the filter's verdict on the combinations is the check above)
    for (const template of lib.ANSWER_LINES.asl) for (const line of fills(template, { ...slots, g: ['m'] })) canSay('answer (asl)', line);
    for (const [pool, lines] of Object.entries({ quests: W.quests, money: W.money, towns: W.towns, banks: W.banks, newbie: W.newbie, regions: W.regions })) cleanAll(`answer word (${pool})`, lines);
    cleanAll('greeting back', (responses.greetingBack ?? []).map(text));
    check('chat_responses.json has the greetings back ("hey", "sup")', (responses.greetingBack ?? []).length >= 5);
    for (const pool of ['confused', 'secondAgree', 'secondLaugh', 'secondRude', 'crowdRude', 'nobodySells', 'vendorPm', 'vendorNear', 'botGz', 'botAck', 'botYes', 'botNo', 'botHello']) {
        check(`BotChat has the realism work's ${pool} lines`, Array.isArray(L[pool]) && L[pool].length > 0);
        cleanAll(`BotChat ${pool}`, L[pool] ?? []);
    }
    check('a bot\'s gz to a bot is one the humanlike report counts (C8: gz, gratz, gj ...)', L.botGz.every(l => /\b(gz|gratz|grats|congrats|congratz|congratulations|gj|nice one|well done)\b/i.test(l)));
    for (const [pool, lines] of Object.entries(lib.REACTION_LINES)) cleanAll(`reaction (${pool})`, lines);
    cleanAll('reaction (gear)', lib.GEAR_LINES);
    // the practices: each turn's lines, the slots from the bots (levels, skills, items and their prices, asl, a newbie's
    // question; the veteran's answer is an answer above)
    const P = lib.PRACTICES;
    const practiceSlots = {
        ...slots,
        skill: P.skills, a: ['1', '45', '99'], b: ['1', '45', '99'], next: ['10', '60', '99'], item: [...P.items.free, ...P.items.members],
        question: P.newbieQuestions, answer: ['north'], a_age: ['13', '25'], b_age: ['13', '25'], a_g: ['m', 'f'], b_g: ['m', 'f'], a_region: W.regions, b_region: W.regions
    };
    let practiceLines = 0;
    for (const practice of P.practices) {
        for (const turn of practice.turns) {
            for (const pool of ['lines', 'lower', 'higher', 'same', 'yes', 'no', 'other']) {
                for (const template of turn[pool] ?? []) {
                    for (const line of fills(template, practiceSlots)) {
                        clean(`practice ${practice.id}`, line);
                        practiceLines++;
                        check(`practice ${practice.id}: ${JSON.stringify(template)} has no slot left`, !/[{}]/.test(line), line);
                    }
                }
            }
        }
    }
    check('practices: a level compare, a price check, a newbie and a veteran, a PK invite, asl, banter', ['level', 'price', 'newbie', 'pk', 'asl', 'from'].every(id => P.practices.some(p => p.id === id)) && P.practices.length >= 10, P.practices.map(p => p.id).join(' '));
    notes.push(`the realism work's talk: ${talkLines} answer, reply and reaction lines (templates filled) and ${practiceLines} practice lines checked`);
}

// ---- phase 3, track C (social life): the regulars', the lures' and the cliques' lines ----
{
    const S = lib.SOCIAL_LINES;
    const C = lib.CLIQUE_LINES;
    // upstream's social lines (its approach, small talk, lure lead, betrayal and goodbyes: kept with their words) and the
    // new ones without a slot
    for (const pool of ['betray', 'dare', 'greet', 'chat', 'wait', 'farewell', 'regularGreet']) {
        check(`SocialTask has its ${pool} lines`, S[pool].length > 0);
        for (const line of S[pool]) clean(`social (${pool})`, line);
    }
    for (const [form, { pitch, lead }] of Object.entries(S.lureForms)) {
        check(`lure form ${form}: a pitch and lead lines`, pitch.length > 0 && lead.length > 0);
        for (const line of [...pitch, ...lead]) clean(`lure (${form})`, line);
    }
    check('lures: the 2004 forms (free armour, a drop party, a guard, a safe spot) and upstream\'s', ['armour', 'party', 'guard', 'spot', 'upstream'].every(f => S.lureForms[f]));
    for (const pool of ['greetPlain', 'greetBackPlain', 'byePlain', 'byeBackPlain', 'meToo', 'lead', 'follow']) {
        check(`BotCliques has its ${pool} lines`, C[pool].length > 0);
        for (const line of C[pool]) clean(`clique (${pool})`, line);
    }
    // a goodbye to a friend is a departure line the humanlike report counts (H16, H20b): gtg, cya, bye, gn
    const departure = /\b(gtg|g2g|gotta go|cya|bye|gn|good ?night)\b/i;
    check('a goodbye to a friend, and "me too", is a departure line (gtg, cya, bye, gn)', [...C.bye, ...C.byePlain, ...C.meToo].every(l => departure.test(l)), [...C.bye, ...C.byePlain, ...C.meToo].filter(l => !departure.test(l)).join(' | '));
    // with a name in: every clique member's nick (what friends call it) and a passer-by's in each template; a line the
    // filter would change is never said (BotCliques.named, SocialTask._greeting fall back to a plain one): counted
    const nicks = new Set();
    for (const c of lib.allCliques()) for (const n of c.names) {
        const nick = lib.nickOf({ displayName: lib.toDisplayName(n) });
        if (nick) nicks.add(nick);
    }
    const passers = [...botNames.filter((_, i) => i % 25 === 0).map(n => lib.nickOf({ displayName: n })).filter(Boolean), 'Casey', 'Sim Human'];
    let filled = 0;
    let fallBack = 0;
    for (const [pools, slot, values] of [[[C.greet, C.greetBack, C.bye, C.byeBack], '{nick}', [...nicks]], [[S.regularGreetNamed], '{name}', passers]]) {
        for (const pool of pools) {
            for (const template of pool) {
                check(`${JSON.stringify(template)} has its ${slot}`, template.includes(slot) || pool === C.greetBack || pool === C.byeBack);
                for (const value of values) {
                    const line = template.replaceAll(slot, value);
                    filled++;
                    if (lib.filter(line) !== line) fallBack++;
                    else canSay(`named line (${slot})`, line);
                }
            }
        }
    }
    check('names friends call each other: most clique members have one', nicks.size >= 100, `${nicks.size}`);
    notes.push(`the social work's named lines: ${filled} filled in (${nicks.size} friends' names), ${fallBack} the filter would change (said plain instead)`);
}

// ---- (realism phase 5a, track F: fights, skills and manners) a rude talker's replies (port/BotRude via BotChat's
// BOT_CHAT_LINES): each pool whole, and the add-on after the answers it follows (BotAnswers' and the replies above: said
// only where the filter leaves the whole line, else the plain answer); the arguments' and events' lines are 2004 lines
// (data/lines2004-texture.json: NEW_LINES above) ----
{
    const pools = ['rudeDirections', 'rudeBeg', 'rudeNo', 'rudeGear', 'rudePersonal', 'rudeMood', 'rudePrice', 'rudeAddon'];
    for (const pool of pools) {
        check(`BotChat has the rude talker's ${pool} lines`, Array.isArray(L[pool]) && L[pool].length > 0);
        for (const line of L[pool] ?? []) clean(`rude reply (${pool})`, line);
    }
    let joined = 0;
    let whole = 0;
    for (const answer of ['north', 'go north to varrock', 'its right there', 'like 300 ea', '14 m uk', 'mining in varrock']) {
        for (const add of L.rudeAddon ?? []) {
            const line = `${answer} ${add}`;
            joined++;
            if (lib.filter(line) === line) {
                whole++;
                canSay('rude reply (add-on)', line);
            }
        }
    }
    check('a rude add-on after an answer is mostly whole under the filter (else the plain answer is said)', whole >= joined * 0.8, `${whole} of ${joined}`);
}
// ---- end of track F's block ----

// ---- (realism phase 5b, Track D: the director and groups) the set pieces' lines are data/lines2004-groups.json's groups
// (NEW_LINES above: a clan walk's, a PK team's, a newbie train's moments, the bots' words of them, the rumours); a train's
// ask now and then names the one asked ("Kevin can i follow u?", port/BotTrains: said only where the filter leaves the
// whole line, else plain): with a name in, each passes the codec ----
{
    const groups = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/lines2004-groups.json'), 'utf8')).groups;
    const moments = ['clan-call', 'clan-go', 'clan-wait', 'clan-next', 'clan-member', 'clan-end', ...['red', 'black', 'blue', 'yellow', 'green', 'purple', 'orange'].map(c => `clan-join-${c}`), 'clan-cape', 'clan-cape-on', 'clan-cape-on-red', 'clan-seen', 'pk-team-call', 'pk-team-answer', 'pk-team-go', 'pk-team-pile', 'pk-team-retreat', 'pk-team-after', 'pk-team-seen', 'train-ask', 'train-yes', 'train-no', 'train-sad', 'train-join', 'train-bye', 'train-seen'];
    const missing = moments.filter(m => !groups.some(g => g.tag.event === m && g.lines.length > 0));
    check("Track D's set pieces: every moment has its lines", missing.length === 0, missing.join(', '));
    check("Track D's rumours: a clan walk's and a PK team's", ['clan_walk', 'pk_raid'].every(k => groups.some(g => g.tag.c === 'rumour' && g.tag.pieces?.includes(k))));
    const asks = groups.filter(g => g.tag.event === 'train-ask').flatMap(g => g.lines);
    const askees = [...botNames.filter((_, i) => i % 25 === 0), 'Casey', 'Sim Human'];
    let named = 0;
    let plain = 0;
    for (const ask of asks) {
        for (const name of askees) {
            const line = `${name} ${ask}`;
            if (lib.filter(line) === line) {
                named++;
                canSay("a train's ask, named", line);
            } else plain++;
        }
    }
    notes.push(`Track D: a train's ask with the asked one's name: ${named} whole, ${plain} the filter would change (said plain instead)`);
}
// ---- end of Track D's (phase 5b) block ----

// ---- (realism phase 5b, track P: parties, scams and lures) the set pieces' own lines are 2004 lines (data/lines2004-
// parties.json: NEW_LINES above, each group by its event and kind); here the lure's new forms and its arrival at a waiting
// PK team (data/social.json: the social block's loop above has the forms' pitches and leads), and the scam callers' use
// of upstream's own lines, word for word ----
{
    const S = lib.SOCIAL_LINES;
    for (const line of S.ambush ?? []) clean('lure (ambush)', line);
    check('lures: the six new forms (a vendor, free lobs, a clan, a phat, a helper, a rare spawn) and the ambush\'s arrival lines', ['vendor', 'lobs', 'clan', 'phat', 'help', 'rare'].every(f => S.lureForms[f]?.pitch.length && S.lureForms[f]?.lead.length) && (S.ambush ?? []).length >= 3);
    const upstream = new Set(phrases.idle);
    const theirs = [...lib.UPSTREAM_SCAM_LINES.double, ...lib.UPSTREAM_SCAM_LINES.trim];
    check("the scam callers' upstream lines are upstream's idle lines word for word", theirs.length >= 3 && theirs.every(l => upstream.has(l)), theirs.filter(l => !upstream.has(l)).join(' | '));
    const kinds = new Set(lib.NEW_LINES.filter(l => ['party', 'party-rumour', 'scam', 'fakedp'].includes(l.tag.event)).map(l => `${l.tag.event}/${(l.tag.kinds ?? []).join(',')}`));
    check("the set pieces' pools: every party, scam and fake drop party kind the pieces say has lines", ['party/call-now', 'party/call-end', 'party/guest-wait', 'party/guest-got', 'party/guest-nothing', 'scam/call-double', 'scam/call-trim', 'scam/warn', 'scam/answer', 'scam/refuse', 'scam/mod-answer', 'fakedp/call', 'fakedp/warn', 'party-rumour/falador_park'].every(k => kinds.has(k)), [...kinds].join(' '));
}
// ---- end of track P's block ----

// ---- (the variety work, round 2, Track S2: conversation) the threads' pools (data/threads.json), the cliques' banter and
// in-jokes, the social regulars' approach v2 (data/social.json), BotChat's word after an answer; each template with each
// slot filled from each of its values (the others at their first). The witnesses', reactions' and show-off groups and the
// responses by class are 2004 groups (data/lines2004-variety.json: NEW_LINES above). ----
{
    const fills = (template, slots) => {
        const keys = [...template.matchAll(/\{([a-z_]+)\}/g)].map(m => m[1]).filter((k, i, all) => all.indexOf(k) === i);
        const first = Object.fromEntries(keys.map(k => [k, (slots[k] ?? [`{${k}}`])[0]]));
        const out = new Set([keys.reduce((t, k) => t.replaceAll(`{${k}}`, first[k]), template)]);
        for (const k of keys) for (const v of slots[k] ?? []) out.add(keys.reduce((t, kk) => t.replaceAll(`{${kk}}`, kk === k ? v : first[kk]), template));
        return [...out];
    };
    const T = lib.THREAD_LINES;
    const S = lib.Slots.slotSamples();
    const doing = [...new Set(Object.values(lib.SkillProgression).flat().flatMap(step => ['Woodcut', 'Mine', 'Fish', 'Combat', 'Cook', 'Smith', 'Thieve', 'Crafting', 'Firemaking', 'Fletching', 'Agility'].map(kind => lib.activityFor(kind, step))).filter(Boolean).map(a => a.toLowerCase().replace(/ lol$/, '')))];
    const levels = ['1', '3', '13', '29', '41', '58', '71', '99', '126', '684', '1423'];
    const slots = {
        skill: [...new Set([...T.skills, ...S.skill])], v: [...levels, ...doing, ...S.want.map(w => `a ${w}`), ...S.next.slice(0, 6).map(n => `${n} wc`), ...T.skills, ...S.item, '2.5k', '45k', '1.2m'],
        was: levels, next: S.next, unlock: S.unlock, place: S.place, k: ['2k', '45k', '120k', '1.2m'], age: ['11', '14', '17', '24', '35'], g: ['m', 'f'],
        region: ['usa', 'us', 'uk', 'england', 'canada', 'aus', 'australia', 'netherlands', 'sweden', 'ireland', 'new zealand', 'germany', 'norway'], clan: varietyJson.clans, x: ['41', 'cutting willows', 'ya', 'nah f2p', '14 m uk']
    };
    let threadLines = 0;
    let filtered = 0;
    for (const key of ['counter', 'segue', 'closers', 'counterAsk']) for (const t of T[key]) for (const line of fills(t.trim() || 'x', slots)) (canSay(`thread (${key})`, line), threadLines++);
    for (const t of [...T.closers, ...T.counterAsk]) clean('thread (closer)', t);
    check('threads: about 30 topics, each with its opener', Object.keys(T.topics).length >= 28 && Object.values(T.topics).every(t => Array.isArray(t.ask) && t.ask.length >= 2), Object.keys(T.topics).join(' '));
    for (const [id, topic] of Object.entries(T.topics)) {
        for (const [key, pool] of Object.entries(topic)) {
            const templates = key === 'more' ? pool.flatMap(([q, answers]) => [q, ...answers]) : pool;
            for (const template of templates) {
                // (a filled line the filter changes is never said: port/BotThreads draws again; the words are checked as
                // written with every slot's first value, and every value through the codec)
                const lines = fills(template, slots);
                clean(`thread ${id} (${key})`, lines[0]);
                for (const line of lines.slice(1)) {
                    canSay(`thread ${id} (${key})`, line);
                    if (lib.filter(line) !== line) filtered++;
                    threadLines++;
                }
                check(`thread ${id} (${key}): ${JSON.stringify(template)} has no unknown slot`, !/[{}]/.test(lines[0]), lines[0]);
            }
        }
    }
    notes.push(`Track S2: ${threadLines} thread lines (templates filled), ${filtered} of them the filter would change (never said)`);
    // (the cliques' banter, the mates' answers and the in-jokes, a {nick} each clique member's; the approach's openers)
    const C = lib.CLIQUE_LINES;
    const nicks = new Set();
    for (const c of lib.allCliques()) for (const n of c.names) {
        const nick = lib.nickOf({ displayName: lib.toDisplayName(n) });
        if (nick) nicks.add(nick);
    }
    check('Track S2: the cliques have banter, answers and 15+ in-jokes', C.banter?.length >= 15 && C.banterPlain?.length >= 10 && C.banterBack?.length >= 5 && C.inJokes?.length >= 15);
    for (const pool of ['banterPlain', 'banterBackPlain']) for (const line of C[pool] ?? []) clean(`clique (${pool})`, line);
    let nickLines = 0;
    let nickFallBack = 0;
    for (const pool of ['banter', 'banterBack', 'inJokes']) {
        for (const template of C[pool] ?? []) {
            if (!template.includes('{nick}')) {
                clean(`clique (${pool})`, template);
                continue;
            }
            for (const nick of nicks) {
                const line = template.replaceAll('{nick}', nick);
                nickLines++;
                if (lib.filter(line) !== line) nickFallBack++;
                else canSay(`clique (${pool}, named)`, line);
            }
            clean(`clique (${pool}) as written`, template.replaceAll('{nick}', 'kev'));
        }
    }
    notes.push(`Track S2: ${nickLines} banter lines with a mate's nick, ${nickFallBack} the filter would change (said plain instead)`);
    const A = lib.SOCIAL_LINES.approach ?? {};
    check('Track S2: the approach\'s openers by what the human is (gear, cape, hat, high, low, fight, skills, idle, place, after)', ['gear', 'cape', 'hat', 'high', 'low', 'fight', 'Woodcut', 'Mine', 'Fish', 'idle', 'place', 'after'].every(k => A[k]?.length >= 2), Object.keys(A).join(' '));
    // (the fixes, B5 and B6: the members and novelty pieces' names; a level 3 to 5's own level in "lvl {n} lol hi")
    const approachSlots = { item: ['phat', 'santa', 'rune (t)', 'zammy plate', 'dragon med', 'full rune', 'bunny ears', 'glory', 'berserker helm', 'snelm', 'air battlestaff', 'holy symbol', 'mime outfit'], n: ['3', '4', '5', '72', '99', '126'], target: S.target, place: S.place };
    for (const [pool, templates] of Object.entries(A)) for (const t of templates) for (const line of fills(t, approachSlots)) clean(`approach (${pool})`, line);
    check('BotChat has its word after an answer back, and its questions back', (lib.BOT_CHAT_LINES.backWords ?? []).length >= 3 && (lib.BOT_CHAT_LINES.askBack ?? []).length >= 3);
    for (const line of lib.BOT_CHAT_LINES.backWords ?? []) clean('BotChat backWords', line);
    // (a question back joined to an answer: said only where the filter leaves the whole line alone)
    for (const form of lib.BOT_CHAT_LINES.askBack ?? []) for (const answer of ['41', 'cutting willows', '14 m uk', 'like a year']) canSay('BotChat askBack', `${answer}${form}`);
    // (the fixes, B1: a question back as a line of its own, after an answer of upstream's that keeps its words)
    check('BotChat has its question back as a line of its own (the fixes, B1)', (lib.BOT_CHAT_LINES.askBackAlone ?? []).length >= 3);
    for (const line of lib.BOT_CHAT_LINES.askBackAlone ?? []) clean('BotChat askBackAlone', line);
}
// ---- end of Track S2's block ----

// ---- names ----
for (const name of names) {
    clean('bot name', name);
    for (const typed of [`hi ${name.toLowerCase()}`, `hey ${name.toLowerCase()} how are you`, `${name.toLowerCase()} what are you doing`]) {
        const heard = lib.heardLine(typed);
        check(`"${typed}" still names ${name} when a bot hears it`, lib.isAddressingBot(heard, { displayName: name }), JSON.stringify(heard));
    }
}

// ---- the chat codec (WordPack): every line above, and every string the bots' code says, travels whole ----
// (a vendor's adverts: every stock item's nicknames in each advert form of its kind, at prices in each of their forms;
// the realism work, phase 4: every form a vendor may use is checked against the filter and the codec)
{
    const thin = [];
    let adverts = 0;
    for (const item of lib.vendorStock()) {
        const name = lib.vendorItemName(item);
        const kind = lib.advertKindOf(item);
        for (const nick of item.nicks ?? [name.toLowerCase()]) {
            const at = [[12500, 9000], [450, 315], [3, 2], [1500, 1050], [12500000, 0]];
            for (const [price, buyBack] of at) {
                const lines = lib.vendorAdverts({ nick, price, buyBack, kind, noted: true, count: 500, short: price === 1500 });
                if (lines.length < 3) thin.push(`${nick} at ${price}: ${lines.length} forms left whole`);
                for (const line of lines) {
                    clean('vendor advert', line);
                    adverts++;
                }
            }
        }
    }
    check(`vendor adverts: every stock item's every nickname keeps 3+ forms the filter leaves whole (${adverts} lines)`, thin.length === 0, thin.slice(0, 5).join(' | '));
    // trade talk (a price check, a lowball, a fair offer, a seller asking more), its prices in each form
    const prices = [3, 25, 450, 1500, 12500, 27500, 250000, 1200000, 12500000].map(lib.formatGp);
    for (const [pool, lines] of Object.entries(lib.TRADE_TALK)) {
        for (const template of lines) for (const p of prices) clean(`trade talk (${pool})`, template.replace('{p}', p));
    }
}
const code = await codeChatStrings();
for (const { site, text: piece } of code.pieces) canSay(`code string (${site})`, piece.replace(/\{[a-z0-9]+\}/gi, ''));
notes.push(`${code.pieces.length} strings the bots' code says, from ${code.sites} chat calls (${code.unresolved} of their parts built at run time: names, items, prices, the data's lines)`);
let codecChecked = 0;
for (const [line, what] of sayable) {
    codecChecked++;
    const lost = lib.lostInWordPack(line);
    check(`${what} ${JSON.stringify(line)}: travels whole in the chat codec (WordPack)`, lost.length === 0, `${lost.map(c => JSON.stringify(c)).join(' ')} would arrive as a space`);
}
check('chat codec: the lines checked include the code\'s', code.pieces.length > 100, `${code.pieces.length}`);
notes.push(`${codecChecked} distinct lines and strings checked against the chat codec's charset`);

/**
 * The strings the bots' code says: every literal and template text a chat call's line is made of (botSay's line,
 * BotPlayer._say's, BotChat's privateMessage's), followed through the same file's consts, class fields (`this.x = …`)
 * and object properties (a social bot's `approachPhrases: [...]`). Names, item names and prices are filled in at run
 * time, and the data's lines (BotChat's replies) are checked above: those parts are only counted.
 */
async function codeChatStrings() {
    const ts = await typescript();
    // (and the realism work's typed lines: BotChat.sayTyped)
    const SINKS = { botSay: 1, _say: 0, privateMessage: 2, sayTyped: 1 };
    const pieces = [];
    let sites = 0;
    let unresolved = 0;
    for (const [file, { sf }] of await reachableBotModules()) {
        const holds = new Map(); // a name → the expressions it is given in this file
        const give = (name, expr) => {
            if (!holds.has(name)) holds.set(name, []);
            holds.get(name).push(expr);
        };
        (function index(n) {
            if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) give(n.name.text, n.initializer);
            else if (ts.isPropertyDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) give(n.name.text, n.initializer);
            else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) give(n.name.text, n.initializer);
            else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) give(n.left.name.text, n.right);
            ts.forEachChild(n, index);
        })(sf);
        const collect = (node, site, seen) => {
            if (!node) return;
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return void pieces.push({ site, text: node.text });
            if (ts.isTemplateExpression(node)) {
                pieces.push({ site, text: node.head.text });
                for (const span of node.templateSpans) {
                    collect(span.expression, site, seen);
                    pieces.push({ site, text: span.literal.text });
                }
                return;
            }
            if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSpreadElement(node)) return collect(node.expression, site, seen);
            if (ts.isConditionalExpression(node)) return void (collect(node.whenTrue, site, seen), collect(node.whenFalse, site, seen));
            if (ts.isBinaryExpression(node)) return void (collect(node.left, site, seen), collect(node.right, site, seen));
            if (ts.isArrayLiteralExpression(node)) return void node.elements.forEach(e => collect(e, site, seen));
            if (ts.isElementAccessExpression(node)) return collect(node.expression, site, seen);
            // a pick from a list (pick(LINES), LINES.concat(MORE)): the list's strings
            if (ts.isCallExpression(node)) {
                if (ts.isPropertyAccessExpression(node.expression)) collect(node.expression.expression, site, seen);
                return void node.arguments.forEach(a => (ts.isIdentifier(a) || ts.isArrayLiteralExpression(a) || ts.isPropertyAccessExpression(a) || ts.isCallExpression(a)) && collect(a, site, seen));
            }
            const name = ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : null;
            const given = name !== null && !seen.has(name) ? holds.get(name) : undefined;
            if (!given) return void unresolved++;
            seen.add(name);
            for (const expr of given) collect(expr, site, seen);
        };
        (function visit(n) {
            if (ts.isCallExpression(n)) {
                const e = n.expression;
                const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
                if (Object.hasOwn(SINKS, name) && n.arguments.length > SINKS[name]) {
                    sites++;
                    collect(n.arguments[SINKS[name]], `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`, new Set());
                }
            }
            ts.forEachChild(n, visit);
        })(sf);
    }
    return { pieces, sites, unresolved };
}

console.log(
    `chat filter: ${phrases.idle.length} idle and ${phrases.levelup.length} level-up phrases, ${lib.NEW_LINES.length} 2004 lines, ${allReplies.length} replies (${joinedWhole} of ${joinedTotal} greeting-and-answer pairs said whole), ${names.length} names; ${checked} checks against the 274 word filter and chat codec`
);
for (const note of notes) console.log(`note: ${note}`);
if (failures.length) {
    for (const f of failures.slice(0, 50)) console.log(`FAIL ${f}`);
    console.log(`${failures.length} failure(s)`);
    process.exit(1);
}
console.log('ok');
