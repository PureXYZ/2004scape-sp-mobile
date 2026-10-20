// The situation selectors' shared parts (the realism work, phase 7, Track L): select.mjs (the first 3,300) and
// select-r2.mjs (the retrain's 1,150, after the first blind test). The rules-only intents, seeded dice, 2004 player
// names for the sim's "Sim Human" and the renaming. Pure: each selector passes its own dice and the word filter.

/** intents the model never writes (Track E's wantsModel lists the binding set from the code) */
export const RULES_ONLY = new Set(['market', 'market_none', 'trade', 'not_for_sale', 'pk', 'fight', 'attacked', 'follow', 'followed', 'team', 'rude', 'goodbye']);
/** the second bot's rude lines (port/BotChat SECOND_RUDE): rude lines stay the rules' */
export const SECOND_RUDE = new Set(['lol nub', 'nub', 'lol no', 'figure it out lol', 'use ur map']);

export function mulberry(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** an in-place Fisher-Yates shuffle on the given dice */
export function shuffler(dice) {
    return list => {
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(dice() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    };
}

// ── 2004 player names for the human (274: a-z, 0-9 and spaces, at most 12; shown in title case) ──────────────────────
const FIRST = ['mike', 'josh', 'chris', 'matt', 'dan', 'tom', 'alex', 'ryan', 'kyle', 'nick', 'jake', 'sam', 'ben', 'adam', 'luke', 'zach', 'tyler', 'cody', 'brandon', 'justin', 'steve', 'dave', 'jon', 'rob', 'james', 'sean', 'kev', 'ash', 'emily', 'sarah', 'jess', 'katie', 'andy', 'joe', 'bob', 'tim', 'eric', 'kevin', 'jason', 'scott', 'mark', 'paul', 'pete', 'greg', 'jeff', 'craig', 'lee', 'dean', 'gaz', 'jamie', 'callum', 'connor', 'liam', 'shane', 'dylan', 'ethan', 'brad', 'derek', 'travis', 'colin', 'stu', 'olly', 'harry', 'jack', 'will', 'max', 'leo', 'nate', 'ian', 'rory', 'erik', 'lars', 'sven', 'jens', 'tobi', 'nico', 'marco', 'ricky', 'danny', 'tommy', 'billy', 'johnny', 'bobby', 'jimmy'];
const WORD = ['dragon', 'pure', 'pker', 'mage', 'ranger', 'warrior', 'knight', 'rune', 'zammy', 'sara', 'guthix', 'fire', 'ice', 'dark', 'shadow', 'blade', 'lord', 'king', 'iron', 'steel', 'mith', 'addy', 'wolf', 'fish', 'lobster', 'skill', 'archer', 'hero', 'storm', 'thunder', 'demon', 'angel', 'ninja', 'pirate', 'viking', 'chaos', 'blood', 'flame', 'frost', 'magic', 'yew', 'willow', 'oak', 'axe', 'scim', 'hammer', 'arrow', 'bow', 'monk', 'druid', 'wizard', 'goblin', 'troll', 'giant', 'phat', 'santa', 'cow', 'chicken', 'tiger', 'eagle', 'hawk', 'snake', 'cobra', 'rogue', 'outlaw', 'master', 'killa', 'slasher', 'basher', 'smasher', 'hunter2'];
const TAIL = ['', '', '1', '2', '3', '7', '9', '12', '13', '69', '88', '89', '90', '91', '92', '93', '94', '99', '123', '666', '777', '1990', '1991', '1992', '1993', 'x', 'xx', 'z'];
export function titleCase(name) {
    return name.replace(/(^|\s)([a-z])/g, (m, sp, ch) => sp + ch.toUpperCase());
}
/** a 2004 player name generator on the given dice; `guard` is guard-lib (its word filter: a name it would star is never used) */
export function playerNamer(dice, guard) {
    return function playerName() {
        for (;;) {
            const r = dice();
            let name;
            if (r < 0.3) name = FIRST[Math.floor(dice() * FIRST.length)] + TAIL[Math.floor(dice() * TAIL.length)];
            else if (r < 0.55) name = `${WORD[Math.floor(dice() * WORD.length)]} ${WORD[Math.floor(dice() * WORD.length)]}${dice() < 0.4 ? TAIL[Math.floor(dice() * TAIL.length)] : ''}`;
            else if (r < 0.75) name = `${WORD[Math.floor(dice() * WORD.length)]}${dice() < 0.5 ? ' ' : ''}${FIRST[Math.floor(dice() * FIRST.length)]}`;
            else if (r < 0.88) name = `${['lil', 'big', 'mr', 'sir', 'king', 'xx', 'the', 'pure', 'dark'][Math.floor(dice() * 9)]} ${FIRST[Math.floor(dice() * FIRST.length)]}${dice() < 0.5 ? TAIL[Math.floor(dice() * TAIL.length)] : ''}`;
            else name = `${FIRST[Math.floor(dice() * FIRST.length)]} ${['the', 'da', 'of'][Math.floor(dice() * 3)]} ${WORD[Math.floor(dice() * WORD.length)]}`;
            name = name.replace(/hunter2/, 'hunt3r').replace(/\s+/g, ' ').trim();
            if (name.length >= 3 && name.length <= 12 && guard.filter(`hi ${name} lol`) === `hi ${name} lol`) return titleCase(name);
        }
    };
}
/** the names a situation already has (the bot, the chat's speakers, friends near) */
export function namesIn(s) {
    return new Set([s.bot.name, ...s.history.map(h => h.name), ...s.facts.friendsNear].map(n => n.toLowerCase()));
}
export const SIM = /sim human/gi;
export function renamed(text, name) {
    return text.replace(SIM, m => (m === m.toLowerCase() ? name.toLowerCase() : m === m.toUpperCase() ? name.toUpperCase() : name));
}
/** the situation with the sim's human renamed, everywhere a string carries it */
export function rename(value, name) {
    if (typeof value === 'string') return renamed(value, name);
    if (Array.isArray(value)) return value.map(v => rename(v, name));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v, name)]));
    return value;
}
