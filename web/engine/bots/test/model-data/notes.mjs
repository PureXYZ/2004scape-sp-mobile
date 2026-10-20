#!/usr/bin/env node
// The short reasoning note the "note" variant of the 2004 chat model writes before its reply (the realism work, phase 7,
// : "test it alongside"): what the line asks, which of the bot's facts the reply uses, and its tone,
// e.g. "asks: my inventory. uses: carrying 3 rune full helm. tone: blunt." The model learns to write it, then the reply
// (in Qwen's think block, which native and eval.mjs strip): the note is where it picks the fact, the step the blind test
// found it got wrong ("only 96" for a total, "rune full helm" for "3 rune fulls").
//
// The notes are derived from the written replies, not written by anyone: the topic from the rules' intent or the
// human's line, the facts the reply states (its numbers against the bot's levels, total, combat, HP, counts and coins;
// its words against what it wears and carries, where it is and what it does; the rules' answer when it keeps it), the
// tone from the persona. A reply that uses no fact says "uses: nothing".
//
//   node web/engine/bots/test/model-data/notes.mjs --data=<phase7-data dir> [--out=<data>/notes.jsonl] [--sample=N]
//   (reads situations.jsonl and replies/batch-*.jsonl; writes {id, note} for every situation with a reply)
import fs from 'fs';
import path from 'path';

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => ((m => (m ? [m[1], m[2] ?? 'true'] : [a, 'true']))(a.match(/^--([^=]+)(?:=(.*))?$/)))));
// (the phase 7 training data is not published with the repo: --data or PHASE7_DATA names a copy of it)
const DATA_ARG = args.data ?? process.env.PHASE7_DATA;
if (!DATA_ARG) {
    console.error('notes: --data=<phase7-data> (or PHASE7_DATA) is required: the training data is not published with the repo');
    process.exit(2);
}
const DATA = path.resolve(DATA_ARG);
const OUT = path.resolve(args.out ?? path.join(DATA, 'notes.jsonl'));

const readJsonl = file => fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

/** the topic of a rules' intent, as the bot would think of the question */
const INTENT_TOPIC = {
    greeting: 'a greeting', goodbye: 'a goodbye', bye: 'a goodbye', how: 'how im doing', whatsup: 'what im up to', about: 'what im up to',
    combat: 'my combat', total: 'my total', skill: 'one of my levels', doing: 'what im doing', whereami: 'where i am', where: 'where something is',
    spots: 'where to train or get something', directions: 'the way somewhere', bank: 'the nearest bank', town: 'the way to a town', price: 'a price',
    money: 'making money', quest: 'a quest to do', quest_done: 'a quest i did', newbie: 'a newbie question', help: 'help', asl: 'asl', age: 'my age',
    from: 'where im from', gender: 'if im a boy or girl', playtime: 'how long i play', play_time: 'how long i play', presence: 'if im here',
    bot: 'if im a bot', gear: 'my gear', insult: 'an insult', noob: 'an insult', joke: 'a joke', thanks: 'thanks', gratsorwelcome: 'a gz',
    bored: 'being bored', goals: 'my goals', advice: 'advice', beg: 'a beg', begging: 'a beg', mood: 'my mood', bad_mood: 'my mood',
    chilling: 'what im up to', who: 'who i am', area: 'this place', area2: 'this place', repeat: 'repeating', brb: 'a brb', attacked: 'a fight',
    mod_how: 'player mods', mod_you: 'if im a mod', mod_any: 'player mods', oziach: 'a quest', guards: 'the guards', knife: 'a knife', second: 'what someone said'
};

/** the topic of a line no intent caught (the long tail), from its words */
const LINE_TOPICS = [
    [/\b(inv|inventory|invy|carrying|carry|in ur bag|in ur pack|how many|u got any|got any)\b/, 'my inventory'],
    [/\b(armou?r|gear|weapon|wep|wearing|wear|helm|plate|scim|sword|cape|staff|bow)\b/, 'my gear'],
    [/\b(lvl|level|levels|cb|combat|total|99|stats|highest|best skill)\b/, 'my levels'],
    [/\b(wyd|doing|up to|training|train)\b/, 'what im doing'],
    [/\b(where|wheres|were r)\b/, 'where something is'],
    [/\b(bot|macro|macroing|auto|autoing)\b/, 'if im a bot'],
    [/\b(fav|favourite|favorite|best|like|think of|opinion)\b/, 'what i like'],
    [/\b(how old|age|asl|from)\b/, 'about me'],
    [/\b(noob|nub|newb|idiot|stupid|suck|loser|ugly|stfu|shut up)\b/, 'an insult'],
    [/\b(hi|hey|hello|sup|yo|hiya)\b/, 'a greeting'],
    [/\b(bye|cya|gtg|night|gn|later)\b/, 'a goodbye'],
    [/\b(lol|lmao|haha|rofl|xd)\b/, 'a joke']
];

function topicOf(s) {
    if (s.hint && INTENT_TOPIC[s.hint.intent]) return INTENT_TOPIC[s.hint.intent];
    const line = s.heard.text.toLowerCase();
    for (const [rx, topic] of LINE_TOPICS) if (rx.test(line)) return topic;
    return /\?\s*$/.test(line) ? 'a question' : 'chat';
}

function toneOf(s) {
    const v = s.bot.voice;
    const tone = v.rude ? 'rude' : v.friendliness < 0.15 ? 'blunt' : v.friendliness > 0.6 ? 'friendly' : 'chill';
    return s.bot.newbie ? `${tone}, new player` : tone;
}

const SKILL_WORDS = {
    att: ['att', 'attack', 'atk'], str: ['str', 'strength'], def: ['def', 'defence', 'defense'], hp: ['hp', 'hitpoints'], range: ['range', 'ranged', 'ranging'],
    pray: ['pray', 'prayer'], mage: ['mage', 'magic'], cook: ['cook', 'cooking'], wc: ['wc', 'woodcutting', 'woodcut'], fletch: ['fletch', 'fletching'],
    fish: ['fish', 'fishing'], fm: ['fm', 'firemaking'], craft: ['craft', 'crafting'], smith: ['smith', 'smithing'], mine: ['mine', 'mining'],
    herb: ['herb', 'herblore'], agil: ['agil', 'agility'], thief: ['thief', 'thieving'], rc: ['rc', 'runecraft', 'runecrafting']
};

const words = t => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
/** "15k" -> 15000, "1.2m" -> 1200000 */
function amounts(text) {
    const out = [];
    for (const m of text.toLowerCase().matchAll(/(?<![a-z0-9.])(\d+(?:\.\d+)?)(k|m)?(?![a-z0-9])/g)) out.push(Number(m[1]) * (m[2] === 'k' ? 1000 : m[2] === 'm' ? 1e6 : 1));
    return out;
}
/** what an item is called short ("rune full helm" -> rune, full, helm; "willow logs" -> willow, log) */
function itemKeys(name) {
    const ignore = new Set(['of', 'the', 'a', 'an', 'and', 'coins']);
    return words(name).filter(w => !ignore.has(w)).map(w => w.replace(/s$/, ''));
}
const ABBREV = { scimitar: ['scim', 'scimmy'], lobster: ['lob', 'lobs'], platebody: ['plate', 'pl8', 'body'], platelegs: ['legs', 'pl8legs'], swordfish: ['swordie', 'swordy'], dragon: ['d', 'drag'], adamant: ['addy', 'adam'], mithril: ['mith'], amulet: ['ammy'], shortbow: ['sb', 'bow'], longbow: ['lb', 'bow'] };

function usesItem(replyWords, name) {
    const keys = itemKeys(name);
    if (!keys.length) return false;
    const have = new Set(replyWords.map(w => w.replace(/s$/, '')));
    // the item's distinctive word (its last: "helm", "logs", "scimitar") or its material and type both
    const hits = keys.filter(k => have.has(k) || (ABBREV[k] ?? []).some(a => have.has(a)));
    return hits.length >= Math.min(2, keys.length) || (keys.length >= 2 && hits.includes(keys[0]) && keys.length <= 3 && hits.length >= 1 && keys[0].length > 3);
}

function usesOf(s, reply) {
    const out = [];
    const r = reply.toLowerCase();
    const rw = words(r);
    const f = s.facts;
    const nums = amounts(r);
    const said = new Set();
    // levels: a number next to a skill's word, else a number only one level has (the human's line naming the skill helps)
    const heard = words(s.heard.text);
    for (const n of nums) {
        if (said.has(n)) continue;
        let named = null;
        for (const [skill, ws] of Object.entries(SKILL_WORDS)) {
            if (f.levels[skill] === n && (ws.some(w => rw.includes(w)) || ws.some(w => heard.includes(w)))) named = skill;
        }
        if (named) {
            out.push(`${named} ${n}`);
            said.add(n);
            continue;
        }
        if (n === f.total && (rw.includes('total') || heard.includes('total') || n > 99)) out.push(`total ${n}`), said.add(n);
        else if (n === f.combat && ['cb', 'combat', 'level', 'lvl'].some(w => rw.includes(w) || heard.includes(w))) out.push(`combat ${n}`), said.add(n);
        else if ((n === f.hp[0] || n === f.hp[1]) && (rw.includes('hp') || heard.includes('hp'))) out.push(`hp ${n}`), said.add(n);
        else {
            const best = Object.entries(f.levels).filter(([, l]) => l === n);
            if (best.length === 1 && n > 1) out.push(`${best[0][0]} ${n}`), said.add(n);
        }
    }
    // what it carries and wears
    for (const c of f.carrying) {
        if (c.startsWith('coins ')) {
            const coin = amounts(c.slice(6))[0];
            if (coin && nums.some(n => Math.abs(n - coin) <= Math.max(1, coin * 0.05))) out.push(`carrying ${c}`);
            continue;
        }
        const m = c.match(/^(\d+) (.*)$/);
        const name = m ? m[2] : c;
        if (usesItem(rw, name) || (m && nums.includes(Number(m[1])) && usesItem(rw, name.split(' ').slice(-1)[0]))) out.push(`carrying ${c}`);
    }
    for (const w of f.worn) if (usesItem(rw, w)) out.push(`wearing ${w}`);
    // where it is and what it does
    const act = (f.activity ?? '').toLowerCase();
    if (act) {
        const verb = act.split(' ')[0];
        const actWords = words(act).filter(w => w.length > 3 && !['near', 'with', 'from'].includes(w));
        if (rw.includes(verb) || actWords.filter(w => rw.includes(w) || rw.includes(w.replace(/s$/, ''))).length >= 1) out.push(`doing: ${act}`);
    }
    if (f.place && !out.some(u => u.startsWith('doing'))) {
        const placeWords = words(f.place).filter(w => !['in', 'at', 'on', 'near', 'the'].includes(w));
        if (placeWords.length && placeWords.every(w => rw.includes(w) || rw.includes(w.slice(0, 4)))) out.push(`where i am: ${f.place.toLowerCase()}`);
    }
    if (f.wilderness > 0 && /\b(wild|wildy|wilderness)\b/.test(r) && !out.some(u => u.includes('wild'))) out.push(`wilderness level ${f.wilderness}`);
    for (const e of f.events) {
        const ew = words(e.split(',')[0]).filter(w => w.length > 3);
        if (ew.length && ew.filter(w => rw.includes(w)).length >= Math.min(2, ew.length)) out.push(`lately: ${e.split(',')[0]}`);
    }
    // the world, when the reply says which ("ya members", "im f2p")
    if (/\b(members|mems|p2p)\b/.test(r) && s.world.members) out.push('world: members');
    else if (/\b(f2p|free)\b/.test(r) && !s.world.members) out.push('world: free');
    // the rules' answer, when the reply keeps its facts (a number or most of its words)
    if (s.hint && !out.length) {
        const hw = words(s.hint.text).filter(w => w.length > 2);
        const hn = amounts(s.hint.text);
        const keeps = (hn.length && hn.every(n => nums.includes(n))) || (hw.length && hw.filter(w => rw.includes(w)).length >= Math.ceil(hw.length / 2));
        if (keeps) out.push(`the answer idea: ${s.hint.text.toLowerCase()}`);
    }
    return [...new Set(out)].slice(0, 3);
}

export function noteOf(s, reply) {
    const uses = usesOf(s, reply);
    const note = `asks: ${topicOf(s)}. uses: ${uses.length ? uses.join(', ') : 'nothing'}. tone: ${toneOf(s)}.`;
    return note.length <= 160 ? note : `${note.slice(0, 157)}...`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const situations = new Map(readJsonl(path.join(DATA, 'situations.jsonl')).map(r => [r.id, r]));
    const out = [];
    const stats = { notes: 0, nothing: 0, uses: {} };
    for (const f of fs.readdirSync(path.join(DATA, 'replies')).filter(f => /^batch-\d\d\.jsonl$/.test(f)).sort()) {
        for (const row of readJsonl(path.join(DATA, 'replies', f))) {
            const sit = situations.get(row.id);
            if (!sit) continue;
            const note = noteOf(sit.situation, row.reply);
            out.push({ id: row.id, note });
            stats.notes++;
            if (note.includes('uses: nothing')) stats.nothing++;
            for (const m of note.matchAll(/(carrying|wearing|doing|where i am|total|combat|the answer idea|lately|wilderness)/g)) stats.uses[m[1]] = (stats.uses[m[1]] ?? 0) + 1;
            if (args.sample && out.length <= Number(args.sample)) console.log(`${sit.situation.heard.text}  =>  ${row.reply}\n    ${note}`);
        }
    }
    fs.writeFileSync(OUT, out.map(o => JSON.stringify(o)).join('\n') + '\n');
    console.log(`notes: ${stats.notes} (uses nothing: ${stats.nothing}); uses by kind ${JSON.stringify(stats.uses)} -> ${OUT}`);
}
