// port: how a bot types (the realism work, phase 2): its persona's style (port/BotPersona) on the new 2004 lines
// (port/BotLines), never on upstream's, whose words stay ("upstream first, gated"). 274's chat is
// lower-cased and sentence-cased by the client, so a style is word choice, spelling, punctuation and smileys, never
// capitals:
//   - abbreviations: you → u, your → ur, are → r, please → plz, thanks → ty, level → lvl, woodcutting → wc ... (the
//     persona's rate); kids now and then "wat", "da";
//   - dropped apostrophes (most players: "dont", "im"), letter repeats ("sooo"), "!!" and "??" (its emphasis), a full
//     stop now and then;
//   - a laugh or a smiley of its own at the end, now and then;
//   - typos at its rate (a keyboard neighbour, a doubled or a dropped letter, two letters swapped), now and then
//     followed by a "*word" correction line.
// A styled line the 274 word filter would change (the filter reads across words) or with a character the chat codec
// drops falls back to the line as written.
import WordEnc from '#/cache/wordenc/WordEnc.js';
import type { Persona } from '#/engine/bot/port/BotPersona.js';

export interface Styled {
    /** the line to say */
    line: string;
    /** a "*word" line to say a moment later (a typo it corrected), or null */
    correction: string | null;
}

/** the characters 274's chat codec carries (WordPack): anything else arrives as a space */
const CHARSET = /^[a-z0-9 !?.,:;()\-&*'@#+=£$%"[\]]*$/;

/** a word or phrase and what a 2004 player typed instead (each replaced at the persona's rate) */
const ABBREVIATIONS: readonly [RegExp, readonly string[]][] = [
    [/\byou are\b/g, ['ur', 'u r']],
    [/\byou're\b|\byoure\b/g, ['ur']],
    [/\byour\b/g, ['ur']],
    [/\byou\b/g, ['u']],
    [/\bare\b/g, ['r']],
    [/\bplease\b/g, ['plz', 'pls']],
    [/\bthank you\b|\bthanks\b/g, ['ty', 'thx']],
    [/\blevels\b/g, ['lvls']],
    [/\blevel\b/g, ['lvl']],
    [/\bwoodcutting\b/g, ['wc']],
    [/\bfiremaking\b/g, ['fm']],
    [/\brunecrafting\b/g, ['rc']],
    [/\bcombat\b/g, ['cb']],
    [/\bexperience\b/g, ['xp', 'exp']],
    [/\bbecause\b/g, ['cuz', 'coz']],
    [/\bpeople\b/g, ['ppl']],
    [/\banyone\b/g, ['any1']],
    [/\bsomeone\b/g, ['some1']],
    [/\bokay\b/g, ['ok', 'k']],
    [/\bsee you\b/g, ['cya']],
    [/\bi don'?t know\b/g, ['idk']],
    [/\bnever ?mind\b/g, ['nvm']],
    [/\bwant to\b/g, ['wanna']],
    [/\bmate\b/g, ['m8']],
    [/\bgreat\b/g, ['gr8']],
    [/\blater\b/g, ['l8r']],
    [/\btomorrow\b/g, ['tmrw', '2moro']],
    [/\btonight\b/g, ['2nite']],
    [/\bbefore\b/g, ['b4']],
    [/\bwhy\b/g, ['y']],
    [/\bdoes\b/g, ['dose']]
];
/** what only kids type, at half their rate */
const KID_SPELLINGS: readonly [RegExp, readonly string[]][] = [
    [/\bwhat\b/g, ['wat', 'wut']],
    [/\bthe\b/g, ['da']],
    [/\bwith\b/g, ['wid']],
    [/\benough\b/g, ['enuff']]
];
/** words a player stretched ("sooo", "lolll") */
const STRETCH: Readonly<Record<string, readonly string[]>> = { so: ['soo', 'sooo'], no: ['noo', 'nooo'], lol: ['lolol', 'loll'], yes: ['yess', 'yesss'], omg: ['omgg'], plz: ['plzz'] };

/** the QWERTY keys next to each letter (a typo hits one of them) */
const NEIGHBOURS: Readonly<Record<string, string>> = {
    q: 'wa', w: 'qes', e: 'wrd', r: 'etf', t: 'ryg', y: 'tuh', u: 'yij', i: 'uok', o: 'ipl', p: 'ol',
    a: 'qsz', s: 'awdx', d: 'sefc', f: 'drgv', g: 'fthb', h: 'gyjn', j: 'hukm', k: 'jil', l: 'kop',
    z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk'
};

const LAUGH_WORD = /\b(lol|lmao|haha|rofl|xd|hehe)\b/;

/** the 274 filter leaves the line alone and the chat codec carries every character */
export function sayable(line: string): boolean {
    return CHARSET.test(line.toLowerCase()) && WordEnc.filter(line) === line;
}

/**
 * `text` as this persona types it (a new 2004 line, never upstream's): `random` is Math.random in the world (seeded in
 * the sims). Falls back to `text` itself when the styled line would not survive the filter or the codec.
 */
export function styleLine(text: string, persona: Persona, random: () => number = Math.random): Styled {
    const style = persona.style;
    const youth = persona.ageBand === 'adult' ? 0 : persona.ageBand === 'teen' ? 0.5 : 1;
    let line = text.toLowerCase();

    // abbreviations, at the persona's rate (each place on its own)
    for (const [rx, subs] of ABBREVIATIONS) line = line.replace(rx, m => (random() < style.abbreviate ? subs[Math.floor(random() * subs.length)] : m));
    if (persona.ageBand === 'kid') for (const [rx, subs] of KID_SPELLINGS) line = line.replace(rx, m => (random() < style.abbreviate * 0.5 ? subs[Math.floor(random() * subs.length)] : m));

    // apostrophes: most players left them out (an adult who rarely abbreviates keeps them)
    if (!(persona.ageBand === 'adult' && style.abbreviate < 0.35)) line = line.replace(/'/g, '');

    // a word stretched now and then (the young more)
    if (random() < 0.08 + 0.1 * youth) {
        line = line.replace(/\b(so|no|lol|yes|omg|plz)\b/, w => {
            const subs = STRETCH[w];
            return subs ? subs[Math.floor(random() * subs.length)] : w;
        });
    }

    // the end: emphasis, a full stop, a laugh or a smiley of its own
    const end = line.slice(-1);
    if (end === '!' && random() < style.exclaim) line += random() < 0.5 ? '!' : '!!';
    else if (end === '?' && random() < style.exclaim * 0.6) line += '?';
    else if (!/[!?.)]$/.test(line) && random() < style.endStop) line += '.';
    else if (!/[!?]$/.test(line) && random() < style.exclaim * 0.3) line += '!';
    // (one laugh or smiley at most: none after a line that has one)
    const decorated = LAUGH_WORD.test(line) || /[:;=]-?[()dp]$/i.test(line);
    if (!decorated && style.laughs.length && random() < 0.08) line = `${line.replace(/[.]$/, '')} ${style.laughs[Math.floor(random() * style.laughs.length)]}`;
    else if (!decorated && style.smileys.length && random() < 0.07) line = `${line.replace(/[.!]$/, '')} ${style.smileys[Math.floor(random() * style.smileys.length)]}`;

    // a typo: its rate per letter; the word it hit may be corrected on the next line ("*word")
    let correction: string | null = null;
    const typed = withTypo(line, style.typoRate, random);
    if (typed.word !== null) {
        line = typed.line;
        if (random() < style.correctRate) correction = `*${typed.word}`;
    }

    if (!sayable(line)) return { line: text, correction: null };
    if (correction !== null && !sayable(correction)) correction = null;
    return { line, correction };
}

/** one typo at most (the first letter the dice hit, in a word of 3+ letters), and the word as it should have been */
function withTypo(line: string, rate: number, random: () => number): { line: string; word: string | null } {
    if (rate <= 0) return { line, word: null };
    const words = line.split(' ');
    for (let w = 0; w < words.length; w++) {
        const word = words[w];
        if (!/^[a-z]{3,}$/.test(word)) continue;
        for (let i = 0; i < word.length; i++) {
            if (random() >= rate) continue;
            const kind = random();
            let typo: string;
            if (kind < 0.45) {
                const near = NEIGHBOURS[word[i]] ?? '';
                if (!near) continue;
                typo = word.slice(0, i) + near[Math.floor(random() * near.length)] + word.slice(i + 1);
            } else if (kind < 0.65) {
                typo = word.slice(0, i + 1) + word[i] + word.slice(i + 1);
            } else if (kind < 0.85) {
                typo = word.slice(0, i) + word.slice(i + 1);
            } else {
                if (i + 1 >= word.length) continue;
                typo = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
            }
            if (typo === word) continue;
            words[w] = typo;
            return { line: words.join(' '), word };
        }
    }
    return { line, word: null };
}
