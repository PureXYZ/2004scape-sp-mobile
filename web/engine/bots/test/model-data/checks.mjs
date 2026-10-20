// Track L's checks of one reply against its situation (the realism work, phase 7: the guard's rules and the writers' brief): what
// the writers' checker (check-replies.mjs) fails a training reply for, and what the evaluation (eval.mjs) counts against
// a model's line, beyond the foundation's guard (port/BotModelGuard guardReply: one line of the chat's characters,
// within 80, the word filter, assistant talk, 2004's missing things, a bot owning up):
//   effect     brb, gtg, afk, bbl, logging off: each is an action in the rules (an AFK, a logout) that would not follow
//   promise    an offer or agreement to trade, follow, meet, give, lend, come, teach, show ("ill give u", "follow me",
//              "meet me at", "omw", "here u go"): a model line never commits a bot to anything
//   level      a number next to a skill, "lvl", "cb", "combat" or "total" that is not the bot's level ("60 wc" with wc 58);
//              a goal ("going for 60 wc", "almost 60") must be above it
//   number     any other number the situation does not have (its facts, the hint, the chat), except 99 and round goals:
//              no invented times, counts, prices or ages
//   repeat     the bot's own earlier line again, or the human's line echoed back (lines of 3+ words)
//   placeholder a "{name}" left in
// and two observations that are not failures: the human's name said (`named`: a batch keeps it to 1 reply in 8), and a
// number of the hint's that the reply drops (`hintDropped`).
export const MAX = 80;
export const CHARSET = /^[a-z0-9 !?.,:;()\-&*'@#+=£$%"[\]]$/;
export const EFFECT = /\b(brb|gtg|g2g|afk|bbl|bbs|be right back|got ?ta go|gotta go|have to go|logging( off| out)?|log(ging)? off|signing off)\b/i;
export const PROMISE = [
    /\b(i'?ll|ill|i will|i can|i could|lemme|let me|ima|imma|i'?m gonna|im gonna|gonna) +(give|gve|trade|show|teach|meet|come|follow|bring|lend|drop|sell|buy|take|help|walk|go|tele|guide|get u|get you|pay|send)\b/i,
    /\b(follow me|meet me|meet u|meet you|trade me|come with me|come here|come to me|lets go|let'?s go|let us go|wanna go to|want to go to|wanna come|on my way|omw|here u go|here you go|u can have|you can have|have mine|take mine|ill be there|i'?ll be there|be right there|wait for me|w8 for me|ok deal|sure ill|sure i'?ll)\b/i
];
const SKILL_WORDS = {
    att: ['att', 'attack', 'atk'], str: ['str', 'strength'], def: ['def', 'defence', 'defense'], hp: ['hp', 'hitpoints', 'hits'], range: ['range', 'ranged', 'ranging'], pray: ['pray', 'prayer'],
    mage: ['mage', 'magic'], cook: ['cook', 'cooking'], wc: ['wc', 'woodcutting', 'woodcut', 'woodcuting'], fletch: ['fletch', 'fletching'], fish: ['fish', 'fishing'], fm: ['fm', 'firemaking', 'fming'],
    craft: ['craft', 'crafting'], smith: ['smith', 'smithing'], mine: ['mine', 'mining'], herb: ['herb', 'herblore'], agil: ['agil', 'agility'], thief: ['thief', 'thieving', 'thieve'], rc: ['rc', 'runecraft', 'runecrafting'],
    combat: ['cb', 'combat'], total: ['total', 'overall', 'tl']
};
const WORD_TO_SKILL = new Map(Object.entries(SKILL_WORDS).flatMap(([skill, words]) => words.map(w => [w, skill])));
const SKILL_RX = [...WORD_TO_SKILL.keys()].sort((a, b) => b.length - a.length).join('|');
const GOAL = /\b(for|to|til|till|until|get|getting|hit|hitting|reach|almost|nearly|want|wanna|going|need|aiming|after|b4|before|next)\s*$/i;

/** every number-like token the situation states (the bot's facts and age, the human's combat, the chat's lines, the hint, the rules' line; not the prompt's own numbers: seconds ago, the voice, the distance) */
export function numbersOf(s, ruleText) {
    const parts = [JSON.stringify(s.facts), String(s.bot.age), String(s.human.combat), s.human.worn.join(' '), s.heard.text, s.hint?.text ?? '', ruleText ?? '', ...s.history.map(h => h.text)];
    const raw = new Set(parts.join(' ').toLowerCase().match(/\d+(?:\.\d+)?[km]?/g) ?? []);
    return { raw, plain: new Set([...raw].map(n => n.replace(/[km]$/, ''))) };
}

function levelOf(s, skill) {
    if (skill === 'combat') return [s.facts.combat];
    if (skill === 'total') return [s.facts.total];
    if (skill === 'hp') return [s.facts.levels.hp, s.facts.hp[0]];
    return [s.facts.levels[skill]];
}

/** "60 wc", "wc 60", "wc lvl 60", "lvl 60 wc", "cb 54", "54 cb", "total is 600": each number said with a skill */
export function levelClaims(text) {
    const t = text.toLowerCase();
    const claims = [];
    const rxs = [
        new RegExp(`\\b(\\d+)\\s*(?:lvl\\s+|level\\s+)?(${SKILL_RX})\\b`, 'g'),
        new RegExp(`\\b(${SKILL_RX})\\s*(?:lvl|level|is|r|=|:|of)?\\s*(?:lvl|level|is)?\\s*(\\d+)\\b(?!\\s*(?:k|m|gp|ea|min|mins|hours?|xp|exp|logs|ore|fish|coins|kills|more))`, 'g'),
        /\b(?:lvl|level)\s*(\d+)\b(?!\s*(?:k|m|gp))/g
    ];
    for (const [i, rx] of rxs.entries()) {
        for (const m of t.matchAll(rx)) {
            const number = Number(i === 1 ? m[2] : m[1]);
            const skill = i === 0 ? WORD_TO_SKILL.get(m[2]) : i === 1 ? WORD_TO_SKILL.get(m[1]) : null;
            const before = t.slice(0, m.index);
            claims.push({ number, skill, goal: GOAL.test(before), at: m.index, raw: m[0] });
        }
    }
    return claims;
}

const norm = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Track L's checks of `reply` (the line as the bot would say it) for the situation `s` (with the rules' line
 * `ruleText`): {failures: [{reason, detail}], named, hintDropped: [numbers]}.
 */
export function checkReply(s, ruleText, reply) {
    const failures = [];
    const fail = (reason, detail) => failures.push({ reason, detail });
    if (reply.includes('{name}')) fail('placeholder', 'a {name} left in: write the name or leave it out');
    if (EFFECT.test(reply)) fail('effect', `"${reply.match(EFFECT)[0]}" is an action line in the rules (AFK, logout)`);
    for (const rx of PROMISE) {
        const m = reply.match(rx);
        if (m) {
            fail('promise', `"${m[0]}": no offers or agreements (trade, follow, meet, give, come, teach)`);
            break;
        }
    }
    // facts: levels, then any other number
    const claimed = new Set();
    for (const c of levelClaims(reply)) {
        claimed.add(c.at);
        const levels = c.skill ? levelOf(s, c.skill) : [s.facts.combat, ...Object.values(s.facts.levels)];
        if (c.number === 99 && c.goal) continue;
        if (c.goal) {
            if (c.skill && !levels.some(l => c.number >= l)) fail('level', `"${c.raw}" as a goal is not above the bot's ${c.skill} (${levels[0]})`);
            continue;
        }
        if (!levels.includes(c.number)) fail('level', `"${c.raw}": the bot's ${c.skill ?? 'levels'} ${c.skill ? `is ${levels[0]}` : 'have no such number'}`);
    }
    const known = numbersOf(s, ruleText);
    for (const m of reply.toLowerCase().matchAll(/\b\d+(?:\.\d+)?[km]?\b/g)) {
        const tok = m[0];
        if (known.raw.has(tok) || (!/[km]$/.test(tok) && known.plain.has(tok))) continue;
        if (tok === '99') continue;
        const before = reply.toLowerCase().slice(0, m.index);
        if (GOAL.test(before) && (Number(tok) % 5 === 0 || /[km]$/.test(tok))) continue;
        if (claimed.has(m.index)) continue;
        fail('number', `"${tok}" is not in the situation (no invented levels, times, counts, prices or ages)`);
    }
    // repeats
    const r = norm(reply);
    if (r.split(' ').length >= 3) {
        if (norm(s.heard.text) === r) fail('repeat', "the human's line echoed back");
        else if (s.history.some(h => h.who === 'you' && norm(h.text) === r)) fail('repeat', 'the bot said this line already');
    }
    // the human's name
    const human = s.human.name.toLowerCase();
    const named = new RegExp(`(^|[^a-z0-9])${human.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(reply.toLowerCase());
    const hintNumbers = (s.hint?.text.toLowerCase().match(/\b\d+(?:\.\d+)?[km]?\b/g) ?? []).filter(n => n !== '1');
    const hintDropped = hintNumbers.filter(n => !reply.toLowerCase().includes(n));
    return { failures, named, hintDropped, norm: r };
}
