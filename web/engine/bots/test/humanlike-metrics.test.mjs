#!/usr/bin/env node
// The humanlike report's measures (test/lib/humanlike-metrics.mjs) on synthetic records: the text helpers (the 274
// client's display, line kinds, goodbye and "brb" lines, level-up shapes, greeting-only answers, context fit), the
// statistics, and every metric with a hand-computed value, its band and ✓/✗. No engine: about a second.
//
//   node web/engine/bots/test/humanlike-metrics.test.mjs
import * as M from './lib/humanlike-metrics.mjs';

const failures = [];
let checks = 0;
function eq(what, got, want) {
    checks++;
    const same = typeof want === 'number' && typeof got === 'number' ? Math.abs(got - want) < 1e-9 : JSON.stringify(got) === JSON.stringify(want);
    if (!same) failures.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
const metric = (rec, id) => M.computeMetrics(rec).find(m => m.id === id);

/** a line as the runner records it (only what a test sets differs) */
function line(o = {}) {
    const text = o.text ?? 'hi';
    return { t: 0, s: 1, name: 'a', display: 'A', planner: 'skiller', task: 'Woodcut', state: null, kind: 'idle', explicit: false, to: null, toName: null, text, shown: M.displayed(text), colour: 0, effect: 0, cb: 30, x: 3200, z: 3200, level: 0, moving: false, target: null, wild: 0, hubs: [], humanDist: 999, near: 0, ...o, ...(o.text ? { shown: M.displayed(o.text) } : {}) };
}
const record = (meta = {}, more = {}) => Object.assign(M.emptyRecord({ bots: 100, ticks: 6000, members: false, ...meta }), more);

// ---- text ----
eq('displayed: sentence case after . and ! only', M.displayed('hello world. how ARE you? fine!'), 'Hello world. How are you? fine!');
eq('displayed: characters 274 cannot show become spaces', M.displayed('^_^ hi'), '    Hi');
eq('displayed: 80 characters', M.displayed('x'.repeat(100)).length, 80);
eq('words', M.words("Hey sim human, what's up?").length, 5);
eq('normalized', M.normalized('Gl ****!'), 'gl ****');
eq('lineKind: explicit first', M.lineKind({ explicit: 'gz', tag: 'idle' }), 'gz');
eq("lineKind: _say's tag", M.lineKind({ tag: 'levelup', task: 'Vendor' }), 'levelup');
eq('lineKind: the ending line', M.lineKind({ text: M.ENDING_LINE, reply: true }), 'goodbye');
eq('lineKind: a reply', M.lineKind({ reply: true, task: 'Vendor' }), 'reply');
eq('lineKind: vendor, bankstander', [M.lineKind({ task: 'Vendor' }), M.lineKind({ task: 'Bankstand' })], ['trade', 'trade']);
eq('lineKind: social, pk', [M.lineKind({ task: 'Social' }), M.lineKind({ task: 'PKer' }), M.lineKind({ task: 'EdgevillePKer' })], ['social', 'pk', 'pk']);
eq('lineKind: no task, by planner', [M.lineKind({ task: 'none', planner: 'extras_vendor' }), M.lineKind({ task: 'Idle', planner: 'extras_pker' })], ['trade', 'pk']);
eq('lineKind: anything else', M.lineKind({ task: 'Woodcut' }), 'other');
eq('kindGroup', ['advert', 'answer', 'levelup', 'newbie', 'botreply', 'other'].map(M.kindGroup), ['trade', 'reply', 'levelup', 'chatter', 'chatter', 'chatter']);
for (const t of ['Gtg srry', 'Gotta go srry.', 'Gn all', 'I am going to leave.', 'Logging out in Lumbridge Castle', M.ENDING_LINE, 'Guys, I need to log off, my plants are staging a revolt for not watering them', 'Time for a break', 'Cya all']) eq(`a goodbye: "${t}"`, M.isDeparture(t), true);
for (const t of ['Gtg in 30 minutes', 'I have gotta go in 20 minutes', 'Sorry, gotta go AFK. My dog just ate my gaming headset.', 'Dont forget to save game before logging out', 'Break a leg', 'I need to go to the wilderness', 'Thy cause was false, thy skills did lack; See you in Lumbridge when you get back.', 'nice']) eq(`not a goodbye: "${t}"`, M.isDeparture(t), false);
for (const t of ['brb', 'Afk 5 min', 'Gotta go get food', 'Low hp, brb']) eq(`a break: "${t}"`, M.BRB.test(t), true);
eq('not a break', [M.BRB.test('nice'), M.BRB.test('Gotta go srry.')], [false, false]);
eq('levelupShape: the upstream template', ['Finally! - firemaking 17', 'Been waiting for this - woodcutting 20', 'Gz me - hitpoints 15'].map(M.levelupShape), ['P - S N', 'P - S N', 'P - S N']);
eq('levelupShape: natural forms', ['40 wc!!', 'woot 40 str', 'finally 50 fishing'].map(M.levelupShape), ['N S', 'P N S', 'P N S']);
eq('greeting only', ['Yes sim human?', "Hey sim human, what's up?", "Hey mate, what's up?", 'What do you need, sim human?', 'Yoyo :D'].map(t => M.isGreetingOnly(t, 'sim human')), [true, true, true, true, true]);
eq('an answer', ["Hey sim human, what's up? 10", "i'm 256 total", 'cutting willows in draynor, you?'].map(t => M.isGreetingOnly(t, 'sim human')), [false, false, false]);
eq('a hello (H15 leaves out the answers to one)', ['hi', 'hey all', 'Hello!', 'hi bob', 'bob wyd', 'hi how are you', 'hey bob hows it going'].map(t => M.isHello(t, 'bob')), [true, true, true, true, false, false, false]);
eq('namesPlayer', [M.namesPlayer('Yes Sim human?', 'sim human'), M.namesPlayer('sim_human wyd', 'sim human'), M.namesPlayer('hey', 'sim human')], [true, true, false]);
eq('context: a woodcutter on willows', M.contextFit('willows r slow', 'Woodcut', 3086, 3234, 0), { skill: true, place: null });
eq('context: a miner in Varrock on Catherby lobsters', M.contextFit('Fishing lobsters at Catherby is life!', 'Mine', 3285, 3365, 0), { skill: false, place: false });
eq("context: a firemaker's logs; \"more\" is no ore", M.contextFit('need more logs', 'Firemaking', 3200, 3200, 0), { skill: true, place: null });
eq('context: in Lumbridge', M.contextFit('Lumby is so busy', 'Combat', 3222, 3218, 0), { skill: null, place: true });

// ---- statistics ----
eq('quantile', M.quantile([5, 1, 4, 2, 3], 0.5), 3);
eq('quantile of nothing', M.quantile([], 0.5), null);
eq('mean', M.mean([1, 2, 3]), 2);
eq('cv', [M.cv([10, 10, 10]), M.cv([1, 3])], [0, 0.5]);
eq('pct', [M.pct(1, 3), M.pct(0, 0)], [33.3, null]);
eq('H1 band by bots', [25, 100, 250, 500, 1000].map(M.hotspotEmptyMax), [40, 40, 23, 10, 10]);
eq('inBand', [M.inBand(5, { min: 4, max: 10 }), M.inBand(11, { max: 10 }), M.inBand(null, { max: 1 }), M.inBand(3, null)], [true, false, null, null]);

// ---- presence ----
{
    const r = record();
    r.hubs.lumbridge_courtyard = { samples: 100, bots: 500, empty: 10, max: 9, social: 200 };
    r.hubs.falador_park = { samples: 100, bots: 20, empty: 50, max: 2, social: 0 };
    r.hubs.varrock_square = { samples: 100, bots: 100, empty: 30, max: 3, social: 10 };
    r.stacks = { botSamples: 1000, idleStacked: 15, byState: { 'Social/scan': 10, 'Vendor/idle': 5 } };
    r.popin.at = { 2: 0, 5: 1, 100: 4 };
    r.lumbridge = { samples: 10, low: 70, online: 1000 };
    const h1 = metric(r, 'H1');
    eq('H1 worst hotspot empty', [h1.value, h1.shown, h1.ok], [50, '50 % falador_park', false]);
    eq('H2 busiest ÷ median', [metric(r, 'H2').value, metric(r, 'H2').ok], [5, false]);
    eq('H3 social share in view (hubs with 100+ bot-samples; an older record: all samples)', [metric(r, 'H3').value, metric(r, 'H3').shown], [40, '40 % lumbridge_courtyard']);
    {
        // since phase 3: a hub's crowds (3+ bots in view) judged; a lone regular in a quiet park (falador_park) is no mob
        const m = record();
        m.hubs.lumbridge_courtyard = { samples: 100, bots: 500, empty: 10, max: 9, social: 200, crowdBots: 450, crowdSocial: 90 };
        m.hubs.falador_park = { samples: 200, bots: 180, empty: 20, max: 4, social: 150, crowdBots: 120, crowdSocial: 30 };
        const h3 = metric(m, 'H3');
        eq('H3 with crowd counts: the worst hub when 3+ bots are in view, the all-samples worst in the detail', [h3.value, h3.shown, h3.ok, h3.detail.includes('falador_park 83.3')], [25, '25 % falador_park', true, true]);
    }
    eq('H4 idle stacking', [metric(r, 'H4').value, metric(r, 'H4').ok], [1.5, true]);
    eq('H5 pop-in', [metric(r, 'H5').value, metric(r, 'H5').ok], [25, false]);
    eq('P1 Lumbridge newbies per 100 online', [metric(r, 'P1').value, metric(r, 'P1').ok], [7, true]);
    r.lines = [line({ hubs: ['falador_park'] }), line({ hubs: ['falador_park'], kind: 'trade' })];
    const park = M.hubTable(r).find(h => h.key === 'falador_park');
    eq('hubTable: a place', park, { key: 'falador_park', hotspot: true, avg: 0.2, max: 2, emptyPct: 50, socialPct: 0, linesPerMin: 0.03, nonTradePerMin: 0.02 });
    eq('hubTable: only the places sampled', M.hubTable(r).map(h => h.key), ['lumbridge_courtyard', 'varrock_square', 'falador_park']);
    eq('formatHubTable', M.formatHubTable(M.hubTable(r)).length, 5);
}

// ---- chat ----
{
    const r = record({}, {
        sessions: [{ s: 1, name: 'a', planner: 'skiller', first: 0, last: 2999, ended: false }, { s: 2, name: 'v', planner: 'extras_vendor', first: 0, last: 2999, ended: false }],
        lines: [line({ t: 100 }), line({ t: 2500 }), line({ s: 2, name: 'v', kind: 'trade', t: 50 }), line({ s: 2, name: 'v', kind: 'trade', t: 1500 })],
        botTicks: 6000
    });
    eq('H6 quiet windows (vendors left out)', metric(r, 'H6').value, 33.3);
    eq('H7 non-trade lines per bot-hour', [metric(r, 'H7').value, metric(r, 'H7').ok], [2, false]);
}
{
    const r = record({}, {
        lines: [
            line({ text: 'willows r slow', task: 'Woodcut', x: 3086, z: 3234 }),
            line({ text: 'Fishing lobsters at Catherby is life!', task: 'Mine', x: 3285, z: 3365 }),
            line({ text: 'selling logs', kind: 'trade' }),
            line({ text: 'Finally! - woodcutting 20', kind: 'levelup' })
        ]
    });
    eq('H8 context fit (idle lines only)', metric(r, 'H8').value, 33.3);
}
{
    const r = record({}, { lines: [line({ text: 'How do i bank?', cb: 50 }), line({ text: 'Where can i mine iron?', cb: 20 }), line({ text: 'How do i get to varrock', cb: 3, kind: 'newbie' })] });
    eq('H8b newbie questions from combat 40+', metric(r, 'H8b').value, 33.3);
}
{
    const r = record({}, {
        lines: [
            line({ t: 100, name: 'a', display: 'Alice', text: 'Where can i mine iron?' }),
            line({ t: 120, name: 'b', display: 'Bob', text: 'varrock east mine', toName: 'a', x: 3205 }),
            line({ t: 200, name: 'c', display: 'Carl', text: 'Anyone wanna be friends?' }),
            line({ t: 205, name: 'd', display: 'Dan', text: 'nice', z: 3201 }),
            line({ t: 300, name: 'f', display: 'Al', text: 'Where is the bank?' }),
            line({ t: 305, name: 'g', display: 'Gus', text: 'Alright mate' }),
            line({ t: 400, name: 'h', display: 'Hal', text: 'Where can i fish?' }),
            line({ t: 420, name: 'i', display: 'Ivy', text: 'hal try draynor' })
        ]
    });
    const h9 = metric(r, 'H9');
    eq('H9 answered bot questions (by toName, or naming the asker as a whole word)', [h9.value, h9.ok], [50, true]);
    eq('H9 detail: adjacency', h9.detail.includes('after 25 % of chatter'), true);
}
{
    const r = record({}, { lines: ['Finally! - firemaking 17', 'About time! - mining 5', '40 wc!!', 'woot 40 str'].map(text => line({ text, kind: 'levelup' })) });
    eq('H10 the most common level-up shape', [metric(r, 'H10').value, metric(r, 'H10').ok], [50, false]);
}
{
    const r = record({}, {
        sessions: [{ s: 1, first: 0, last: 300, ended: true, planner: 'skiller' }, { s: 2, first: 0, last: 5999, ended: false, planner: 'skiller' }, { s: 5, first: 0, last: 210, ended: true, planner: 'skiller' }],
        lines: [
            line({ s: 1, t: 100, text: 'Gtg srry' }),
            line({ s: 2, t: 100, text: 'Gn all' }),
            line({ s: 3, t: 100, text: 'Bye sim human!', kind: 'reply' }),
            line({ s: 4, t: 100, text: 'Gtg in 30 minutes' }),
            line({ s: 5, t: 200, text: M.ENDING_LINE, kind: 'goodbye' }),
            line({ s: 6, t: 5800, text: 'Gn all' })
        ]
    });
    eq('H16 fake departures', metric(r, 'H16').value, 33.3);
}
{
    const r = record({}, {
        sessions: [{ s: 3, first: 0, last: 250, ended: true, planner: 'skiller' }],
        idleStands: [{ s: 1, planner: 'skiller', start: 150, len: 60 }],
        lines: [line({ s: 1, t: 100, text: 'brb' }), line({ s: 2, t: 100, text: 'Afk 5 min' }), line({ s: 3, t: 100, text: 'Brb phone' })]
    });
    eq('C4 fake breaks', metric(r, 'C4').value, 33.3);
}
{
    const r = record({}, { lines: [line({ text: 'Are you in the discord' }), line({ text: 'nice' }), line({ text: 'lol discord', kind: 'reply' }), line({ text: 'selling discord', kind: 'trade' })] });
    eq('H22 meta lines (report only)', [metric(r, 'H22').value, metric(r, 'H22').ok], [66.7, null]);
}
{
    const r = record({}, {
        lines: [
            ...[0, 10, 20, 30, 40].map(t => line({ s: 1, t })),
            ...[0, 1, 2, 100, 101].map(t => line({ s: 2, t })),
            ...[0, 5, 9].map(t => line({ s: 3, t }))
        ]
    });
    eq('C2 burstiness (median CV, 4+ lines)', metric(r, 'C2').value, 1.66);
}
{
    const r = record({}, { lines: [line({ text: 'a b c' }), line({ text: 'a b c d e' }), line({ text: 'one two three four five six seven', kind: 'trade' })] });
    eq('C3 words per line', [metric(r, 'C3').value, metric(r, 'C3').ok], [4, true]);
    eq('C3b short lines', metric(r, 'C3b').value, 50);
}
{
    const r = record({}, {
        lines: [
            line({ s: 1, name: 'a', t: 100, text: 'Free kills', x: 3090, z: 3530, kind: 'pk' }),
            line({ s: 2, name: 'b', t: 500, text: 'Free kills', x: 3092, z: 3532, kind: 'pk' }),
            line({ s: 1, name: 'a', t: 600, text: 'Free kills', x: 3090, z: 3530, kind: 'pk' }),
            line({ s: 3, name: 'c', t: 700, text: 'gz', x: 3090, z: 3530 }),
            line({ s: 4, name: 'd', t: 2000, text: 'Free kills', x: 3090, z: 3530, kind: 'pk' })
        ]
    });
    const c6 = metric(r, 'C6');
    eq('C6 cross-bot repeats per 10 min (worst map square)', [c6.value, c6.ok], [0.3, true]);
    eq('C6 detail: a bot repeating itself', c6.detail.endsWith('session: 1'), true);
}
{
    const r = record({}, {
        lines: [
            line({ name: 'a', t: 100, text: 'Finally! - mining 30', kind: 'levelup', near: 2 }),
            line({ name: 'b', t: 110, text: 'gz', x: 3201 }),
            line({ name: 'a', t: 300, text: 'Yes! - mining 31', kind: 'levelup', near: 0 }),
            line({ name: 'a', t: 500, text: 'Woot! - mining 32', kind: 'levelup', near: 1 }),
            line({ name: 'b', t: 510, text: 'nice', x: 3201 })
        ]
    });
    eq('C8 gz reactions', [metric(r, 'C8').value, metric(r, 'C8').ok], [50, true]);
}
{
    const r = record({}, { lines: [line({ t: 10 }), line({ t: 20, humanDist: 5, kind: 'trade' }), line({ t: 30, humanDist: 15 })] });
    eq('X1 lines a minute heard (report)', metric(r, 'X1').value, 0.03);
}

// ---- talking to the bots ----
{
    const r = record({ humanName: 'sim human' }, {
        probes: [{ t: 100, kind: 'public', bot: 'bob', line: 'bob wyd' }, { t: 100, kind: 'pm', bot: 'cat', line: 'hey' }, { t: 200, kind: 'public', bot: 'dan', line: 'dan nice gear' }],
        lines: [
            line({ name: 'bob', t: 101, text: 'Lowkey drunk af rn' }),
            line({ name: 'bob', t: 103, text: "Hey sim human, what's up?", kind: 'reply' }),
            line({ name: 'dan', t: 210, text: 'cutting willows in draynor, you?', kind: 'reply' })
        ],
        pms: [{ t: 106, from: 'cat', text: 'Hey mate, whats up?' }]
    });
    eq('H13 typing speed (median characters a second)', [metric(r, 'H13').value, metric(r, 'H13').ok], [13.9, false]);
    const h13b = metric(r, 'H13b');
    eq('H13b latency p10-p90', [h13b.value, h13b.shown, h13b.ok], [10, '3-10 ticks', true]);
    eq('H14 name echo', metric(r, 'H14').value, 33.3);
    eq('H15 greeting-only answers (to more than a hello: the PM "hey" is left out)', [metric(r, 'H15').value, metric(r, 'H15').ok], [50, false]);
    eq('T2 PMs answered (report)', metric(r, 'T2').value, 100);
}
{
    const r = record({}, {
        humanLines: [{ t: 100, line: 'how do i get to varrock' }, { t: 300, line: 'hi' }, { t: 500, line: 'lol' }, { t: 700, line: 'buying iron ore', market: true }],
        lines: [line({ name: 'x', t: 105, kind: 'reply', humanDist: 3 }), line({ name: 'y', t: 110, kind: 'reply', humanDist: 5 }), line({ name: 'z', t: 120, kind: 'reply', humanDist: 30 })],
        humanMes: [{ t: 700, text: 'No vendor is currently available for iron ore.' }, { t: 800, text: 'Welcome to RuneScape.' }]
    });
    eq('T1 answered lines to nobody (report)', metric(r, 'T1').value, 50);
    eq('T1b responders per answered line', [metric(r, 'T1b').value, metric(r, 'T1b').ok], [2, true]);
    eq('M1 marketplace messages', [metric(r, 'M1').value, metric(r, 'M1').ok], [1, false]);
}

// ---- timing and movement ----
{
    const r = record({}, {
        gaps: { 'Mine/loc': [...Array(10).fill(1), ...Array(10).fill(5)], 'Woodcut/loc': Array(20).fill(3), 'Cook/loc': Array(5).fill(1) },
        cadence: { Cook: { pairs: 100, identical: 22 }, Mine: { pairs: 40, identical: 40 } },
        bankStops: { 'Woodcut/bank_done': Array(20).fill(8), 'ShopTrip/withdraw': [...Array(20).fill(4), 20] },
        levellingTicks: 60000,
        idleStands: [{ s: 1, planner: 'skiller', start: 0, len: 300 }, { s: 2, planner: 'skiller', start: 0, len: 1200 }, { s: 3, planner: 'extras_vendor', start: 0, len: 500 }, { s: 4, planner: 'fighter', start: 0, len: 100 }],
        motion: { extras_pker: [30, 60, 10, 0], skiller: [50, 50, 0, 0] },
        xp: { levelling: 100, active: 70 },
        jumps: [{ cls: 'jump', afterDeath: false, humanDist: 10, t: 1, name: 'a', task: 'Mine', from: [1, 1, 0], to: [9, 9, 0] }, { cls: 'jump', afterDeath: true, humanDist: 5 }, { cls: 'stairs', afterDeath: false, humanDist: 1 }, { cls: 'jump', afterDeath: false, humanDist: 40 }, { cls: 'jump', afterDeath: false, humanDist: 16 }]
    });
    eq('H17 instant reactions (worst kind, 20+ gaps)', [metric(r, 'H17').value, metric(r, 'H17').shown], [50, '50 % Mine/loc']);
    eq('H18 identical intervals (worst kind, 50+ pairs)', metric(r, 'H18').value, 22);
    eq('H18b bank-stop CV (lowest)', [metric(r, 'H18b').value, metric(r, 'H18b').ok], [0, false]);
    eq('H19 idle stands per 100 levelling bot-hours', [metric(r, 'H19').value, metric(r, 'H19').ok], [10, true]);
    eq('C11 deep PKers still', [metric(r, 'C11').value, metric(r, 'C11').ok], [30, true]);
    eq('C14 time without XP', [metric(r, 'C14').value, metric(r, 'C14').ok], [30, true]);
    eq('H21 teleports seen', [metric(r, 'H21').value, metric(r, 'H21').ok], [1, false]);
}
// (realism phase 5a) a jump near a move the library marked real (a teleport spell, a random event's) is that class, not
// a jump: 12 ticks after the mark at most, 3 before; another bot's mark does not count
{
    const jumps = [
        { cls: 'jump', t: 100, name: 'Alice' },
        { cls: 'jump', t: 200, name: 'bob' },
        { cls: 'jump', t: 300, name: 'carol' },
        { cls: 'stairs', t: 400, name: 'dave' },
        { cls: 'jump', t: 500, name: 'erin' }
    ];
    M.classifyMarkedJumps(jumps, [
        { name: 'alice', cls: 'spell', tick: 97 },
        { name: 'bob', cls: 'event', tick: 202 },
        { name: 'dave', cls: 'spell', tick: 399 },
        { name: 'zed', cls: 'spell', tick: 499 },
        { name: 'carol', cls: 'spell', tick: 280 }
    ]);
    eq('marked moves: a spell 3 ticks before, an event 2 ticks late; too early, not a jump or another bot unchanged', jumps.map(j => j.cls), ['spell', 'event', 'jump', 'stairs', 'jump']);
    const r = record({}, { jumps: [{ cls: 'spell', afterDeath: false, humanDist: 3, t: 1, name: 'a' }, { cls: 'event', afterDeath: false, humanDist: 2, t: 2, name: 'b' }] });
    eq('H21 leaves spells and event moves out', metric(r, 'H21').value, 0);
}

// ---- crowds (realism phase 3, track B): C15 fighting at the 2004 crowd spots, C16 hang-outs, H19 without them ----
{
    eq('crowdSpotAt: the Lumbridge cows, the Edgeville dungeon hill giants', [M.crowdSpotAt(3252, 3284, 0), M.crowdSpotAt(3111, 9840, 0)], ['lumbridge_cows', 'hill_giants']);
    eq('crowdSpotAt: nowhere, upstairs, a members spot on a free world', [M.crowdSpotAt(3000, 3000, 0), M.crowdSpotAt(3252, 3284, 1), M.crowdSpotAt(2920, 9825, 0, false), M.crowdSpotAt(2920, 9825, 0, true)], [null, null, null, 'taverley_dungeon']);
    const r = record({}, {
        levellingTicks: 60000,
        fights: { levelling: 400, samples: 100, atCrowd: 60, bySpot: { lumbridge_cows: 40, barbarian_village: 20 }, elsewhere: { '3104,3232': 30, '2976,3360': 10 }, byPlanner: { fighter: [80, 100], skiller: [20, 300] } },
        hangouts: [{ s: 1, start: 0, len: 600, spot: 'falador_park' }, { s: 2, start: 0, len: 400, spot: 'falador_park' }, { s: 3, start: 0, len: 800, spot: 'varrock_square' }],
        idleStands: [{ s: 1, planner: 'skiller', start: 0, len: 300, kind: 'Woodcut' }, { s: 2, planner: 'fighter', start: 0, len: 500, kind: 'Hangout' }, { s: 3, planner: 'skiller', start: 0, len: 700, kind: 'Hangout' }]
    });
    const c15 = metric(r, 'C15');
    eq('C15 fighting at the 2004 crowd spots', [c15.value, c15.ok, c15.band], [60, true, { min: 50 }]);
    eq('C15 detail: the fighting share and its spots', [c15.detail.startsWith('fighting 25 % of levelling bot-time (fighter 80, skiller 6.7)'), c15.detail.includes('lumbridge_cows 40'), c15.detail.includes('elsewhere most near 3104,3232 30')], [true, true, true]);
    eq('C15 out of band below half', metric(record({}, { fights: { levelling: 10, samples: 10, atCrowd: 4, bySpot: {}, elsewhere: {}, byPlanner: {} } }), 'C15').ok, false);
    eq('C15 not measured without fights', metric(record(), 'C15').value, null);
    const c16 = metric(r, 'C16');
    eq('C16 hang-outs per 100 levelling bot-hours (report)', [c16.value, c16.ok, c16.detail.includes('falador_park 2, varrock_square 1')], [30, null, true]);
    const h19 = metric(r, 'H19');
    eq('H19 leaves out the stands at a hang-out', [h19.value, h19.detail.includes('2 at a hang-out left out (C16)')], [10, true]);
}

// ---- looks ----
{
    const worn = (o = {}) => Object.assign(Array(14).fill(null), o);
    const r = record({}, {
        looks: [
            { gender: 0, cb: 20, planner: 'fighter', worn: worn({ 0: 'rune_full_helm', 4: 'rune_platebody', 5: 'rune_kiteshield', 7: 'rune_platelegs' }) },
            { gender: 0, cb: 30, planner: 'skiller', worn: worn({ 0: 'iron_med_helm', 4: 'steel_platebody', 5: 'bronze_sq_shield', 7: 'iron_platelegs' }) },
            { gender: 0, cb: 70, planner: 'fighter', worn: worn({ 0: 'rune_full_helm', 4: 'rune_platebody', 5: 'rune_kiteshield', 7: 'rune_platelegs' }) },
            { gender: 1, cb: 15, planner: 'random', worn: worn() },
            { gender: 0, cb: 40, planner: 'skiller', worn: worn({ 1: 'red_cape' }) },
            { gender: 0, cb: 50, planner: 'extras_vendor', worn: worn({ 1: 'red_cape' }) }
        ]
    });
    eq('H11 female share', [metric(r, 'H11').value, metric(r, 'H11').ok], [16.7, true]);
    eq('H12 matching sets at combat 11-60 (5 bots, one in a rune set)', metric(r, 'H12').value, 20);
    eq('H12b accessories, levelling combat 30+', metric(r, 'H12b').value, 33.3);
}

// ---- (realism phase 4, track A: looks) L1, rares and holiday items seen at the hubs ----
{
    const r = record({ ticks: 12100, warmup: 100 });
    eq('L1: nothing measured without hub samples', metric(r, 'L1').value, null);
    r.showOff = {
        hubSamples: 1000,
        hubSamplesWith: 25,
        sightings: [
            { t: 500, hub: 'varrock_west_bank', name: 'a', planner: 'extras_vendor', item: 'blue_partyhat', kind: 'rare' },
            { t: 2000, hub: 'varrock_west_bank', name: 'a', planner: 'extras_vendor', item: 'blue_partyhat', kind: 'rare' },
            { t: 3000, hub: 'falador_park', name: 'b', planner: 'fighter', item: 'bunnyears', kind: 'holiday' }
        ],
        human: [{ t: 2000, hub: 'human', name: 'a', item: 'blue_partyhat', kind: 'rare' }]
    };
    const l1 = metric(r, 'L1');
    eq('L1: sightings an hour of play after the warm-up (3 in 2 h); report only', [l1.value, l1.ok, l1.basis, l1.band], [1.5, null, 'report', null]);
    eq('L1: the detail gives the rares and holiday items, the bots, the items, the hubs, the share of hub samples and the human\'s', [l1.detail.includes('2 of rares, 1 of holiday items) of 2 bots'), l1.detail.includes('blue_partyhat 2, bunnyears 1'), l1.detail.includes('varrock_west_bank 2'), l1.detail.includes('in 2.5 % of hub samples'), l1.detail.includes('the touring human saw 1 (1 bots)')], [true, true, true, true, true]);
    eq('L1: the debugnames it looks for (10 rares, the 2 holiday items) and a sighting again after 10 minutes', [M.RARE_NAMES.length, M.HOLIDAY_NAMES.length, M.SHOW_OFF_AGAIN], [10, 2, 1000]);
}
// ---- end of track A's (phase 4) block ----

// ---- arrivals and departures ----
{
    const r = record({}, {
        logouts: [
            { t: 500, moving: true, target: null, lastDeparture: -1, atBank: false },
            { t: 500, moving: false, target: 'npc', lastDeparture: 450, atBank: false },
            { t: 700, moving: false, target: null, lastDeparture: -1, atBank: true }
        ],
        sessions: [{ s: 1, first: 10, last: 1000, ended: true }, { s: 2, first: 100, last: 2099, ended: true }, { s: 3, first: 200, last: 300, ended: false }, { s: 4, first: 0, last: 50, ended: true }],
        deaths: [{ t: 1, name: 'a', task: 'Fish', by: 'young_dark_wizard' }, { t: 2, name: 'b', task: 'PKer', by: 'c' }]
    });
    eq('H20 logouts while walking', metric(r, 'H20').value, 33.3);
    eq('H20b after a goodbye or at a bank', [metric(r, 'H20b').value, metric(r, 'H20b').ok], [66.7, true]);
    eq('S1 short sessions, begun after the fill and ended (report)', metric(r, 'S1').value, 50);
    // (realism phase 5a, track F: D1 is banded now, per 100 levelling bot-hours; with no levelling time there is no rate)
    eq('D1 deaths outside a fight: no levelling time, no rate', metric(r, 'D1').value, null);
}

// ---- arrivals and sessions (the realism work, phase 3, track A: S2, P1's make-up) ----
{
    // four sessions begun after the fill (tick 0) and ended: 10, 20, 40 and 200 minutes; one begun before it, one not ended
    const ended = (s, first, minutes) => ({ s, first, last: first + minutes * 100 - 1, ended: true });
    const r = record({ fillTick: 5 }, { sessions: [ended(1, 10, 10), ended(2, 10, 20), ended(3, 10, 40), ended(4, 10, 200), ended(5, 0, 5), { s: 6, first: 10, last: 99, ended: false }] });
    const s2 = metric(r, 'S2');
    eq('S2 session lengths: the median of those begun after the fill and ended (report)', [s2.value, s2.ok, s2.shown], [40, null, '10/40/200 min']);
    eq('S2 detail: how many, the longest, the share over 2 h', s2.detail.includes('4 sessions') && s2.detail.includes('longest 200 min') && s2.detail.includes('over 2 h 25 %'), true);
    eq('S2 with no session begun and ended: n/a', metric(record(), 'S2').value, null);
    const p1 = record();
    p1.lumbridge = { samples: 10, low: 70, online: 1000, lowSocial: 10, lowNewbie: 20, newbies: 30 };
    eq('P1 make-up: social bots, newbies and others per 100 online, the newbies anywhere', [metric(p1, 'P1').value, metric(p1, 'P1').detail.includes('social bots 1, newbies 2, others 4; newbies online anywhere 3 per 100')], [7, true]);
    const pop = record();
    pop.popin = { at: { 5: 2, 100: 3 }, popped: 0 };
    eq('H5 detail: the t100 crowd that popped in (logged in near the human after t5) and the rest walked in', [metric(pop, 'H5').value, metric(pop, 'H5').detail.includes('of the 3 at t100, 0 logged in within 15 tiles after t5 (popped in), the rest walked in')], [66.7, true]);
    const old = record();
    old.lumbridge = { samples: 10, low: 70, online: 1000 };
    eq('P1 without the make-up (an older record): the value alone', [metric(old, 'P1').value, metric(old, 'P1').detail.includes('of them')], [7, false]);
}
// ---- end of track A's block ----
// ---- phase 3, track C (social life): G1, levelling bot-time near a clique-mate for 30 s+ ----
{
    const r = M.emptyRecord({ bots: 100, ticks: 6000 });
    eq('G1: nothing measured with no levelling samples', metric(r, 'G1').value, null);
    r.groups = { levelling: 1000, clique: 250, mateOnline: 150, nearAny: 90, inView: 120, near30: 60, logins: 20, loginsWithMate: 9 };
    const g1 = metric(r, 'G1');
    eq('G1: runs of 30 s+ near a mate, of all levelling bot-time; report only (no mark)', [g1.value, g1.ok, g1.basis, g1.band], [6, null, 'report', null]);
    eq('G1: the detail gives the cliques\' share, a mate online, near one at all, the logins with a mate online and the proposed band', [g1.detail.includes('clique members 25 %'), g1.detail.includes('a mate online 60 %'), g1.detail.includes('within 3 tiles of one 36 %, within 15 48 %'), g1.detail.includes('mate online 45 % of 20'), g1.detail.includes('5-20 %')], [true, true, true, true, true]);
}

// ---- economy (realism phase 4, track B: E1 the vendors' asks against the street table, E2 their adverts' repetition) ----
{
    const r = record();
    eq('E1, E2: nothing measured with no vendor', [metric(r, 'E1').value, metric(r, 'E2').value], [null, null]);
    r.street = { lobster: 150, naturerune: 300, blue_partyhat: 12500000 };
    const stock = o => ({ t: 0, s: 1, name: 'v', item: 'lobster', itemName: 'Lobster', ask: 150, value: 150, rare: false, noted: true, count: 500, cb: 50, total: 600, bank: 'varrock_west', ...o });
    // ask ÷ street: 160/150 1.07 in, 50/300 0.17 out, 310/300 1.03 in, 13m/12.5m 1.04 in (a rare from a level-3 vendor);
    // coal is not in the table: 3 of the 4 table stockings, 75 %
    r.vendorStocks = [
        stock({ ask: 160 }),
        stock({ s: 2, item: 'naturerune', itemName: 'Nature rune', ask: 50 }),
        stock({ s: 3, item: 'naturerune', itemName: 'Nature rune', ask: 310 }),
        stock({ s: 4, item: 'blue_partyhat', itemName: 'Blue partyhat', ask: 13000000, rare: true, noted: false, cb: 3, total: 40 }),
        // (two at Falador East, one from its trade of ores and bars)
        stock({ s: 5, item: 'coal', itemName: 'Coal', ask: 120, bank: 'falador_east', bankTrade: true }),
        stock({ s: 6, item: 'cake', itemName: 'Cake', ask: 120, bank: 'falador_east', bankTrade: false })
    ];
    const e1 = metric(r, 'E1');
    eq('E1: the share of the table stockings within 0.67-1.5× (coal: not in the table); its band', [e1.value, e1.ok, e1.band, e1.basis], [75, false, { min: 90 }, 'decided']);
    eq('E1: the median ratio shown; the stockings, the rares (who stocked them, noted or not) and the trade banks\' stock in the detail', [e1.shown, e1.detail.includes('4 of 6 vendor stockings'), e1.detail.includes('rares: 1 stocked (1 by a vendor under combat 40 and total 500, 0 noted; Blue partyhat 13m)'), e1.detail.includes('farthest Nature rune 50 (street 300, 0.17×)'), e1.detail.includes('at a bank with a trade of its own 1 of 2 stockings from it')], ['75 % (median 1.04×)', true, true, true, true]);
    const ad = (text, o = {}) => line({ text, task: 'Vendor', state: 'idle', kind: 'trade', planner: 'extras_vendor', ...o });
    r.lines = [
        ad('selling lobs 160 ea'),
        ad('selling lobs 160 ea', { s: 2, name: 'b' }),
        ad('Selling lobs 160 ea!', { s: 3, name: 'c', colour: 3, effect: 1 }),
        ad('wts nats 310 ea'),
        ad('lobs 160 ea, trade me'),
        // (trade talk in a trade, a vendor's answer or chatter at its stall, a bankstander's advert: not a vendor's advert)
        line({ text: 'Hi Casey! Selling Lobster for 160gp ea.', task: 'Vendor', state: 'trade', kind: 'trade', planner: 'extras_vendor' }),
        line({ text: 'Hi', task: 'Vendor', state: 'idle', kind: 'botreply', planner: 'extras_vendor' }),
        line({ text: 'selling lobs 160 ea', task: 'Vendor', state: 'idle', kind: 'idle', planner: 'extras_vendor' }),
        line({ text: 'Bank sale 12k', task: 'Bankstand', state: 'idle', kind: 'trade', planner: 'skiller' })
    ];
    const e2 = metric(r, 'E2');
    eq('E2: the most common advert (however punctuated) of the vendors\' adverts: 3 of 5', [e2.value, e2.ok, e2.band], [60, false, { max: 10 }]);
    eq('E2: the detail (distinct lines, another vendor\'s same advert nearby, colour and effect, the bankstanders\')', [e2.detail.includes('5 adverts, 3 distinct'), e2.detail.includes("another vendor's same advert in the map square within 10 min 2 (40 %)"), e2.detail.includes('in colour or with an effect 20 %'), e2.detail.includes("bankstanders' adverts 1, their top 100 %")], [true, true, true, true]);
    // (2026-10-18) an auto typer's adverts: its one line, apart (E2 judges the hand-typed ones)
    r.lines.push(...[0, 15, 30].map(t => ad('selling coal 150 ea', { s: 9, name: 'typer', t, typer: true })));
    const e2t = metric(r, 'E2');
    eq("E2: an auto typer's adverts are not judged, only counted in the detail", [e2t.value, e2t.detail.includes('5 adverts, 3 distinct'), e2t.detail.includes("auto typers' adverts 3 (1 sessions, 37.5 % of the vendors')")], [60, true, true]);
    eq('the economy group', metric(r, 'E1').group === 'economy' && M.GROUPS.economy === 'Prices and adverts', true);
}
// ---- end of track B's (economy) block ----

// ---- (realism phase 5a, Track M: movement and magic) TP1-TP4, F2, AL1 ----
{
    const r = record({ ticks: 12000 });
    eq('TP1-TP4, F2, AL1: nothing measured without the library\'s counters', ['TP1', 'TP2', 'TP3', 'TP4', 'F2', 'AL1'].map(id => metric(r, id).value), [null, null, null, null, null, null]);
    r.spells = { trips: 40, longTrips: 25, opportunities: 10, casts: 20, landed: 6, failed: 2, failReasons: { refused: 1, wield: 1 }, walked: { 'saves its laws': 3, 'walks this time': 1 }, bySpell: { varrock: 4, camelot: 2 }, crossings: { trips: 2, prepared: 1, careless: 1, fed: 1 }, recent: [] };
    const tp1 = metric(r, 'TP1');
    eq('TP1: spells landed of the qualifying trips by bots with the level and runes; its band 40-90 %', [tp1.value, tp1.ok, tp1.band, tp1.basis], [60, true, { min: 40, max: 90 }, 'decided']);
    eq('TP1: the detail gives why the rest walked, the spells and White Wolf Mountain on foot', [tp1.detail.includes('saves its laws 3'), tp1.detail.includes('varrock 4, camelot 2'), tp1.detail.includes('on foot 2 (from a bank and prepared 1, food packed 1, careless 1)')], [true, true, true]);
    r.spells.byBot = [{ name: 'a', trips: 5, cast: 0, saver: true }, { name: 'b', trips: 3, cast: 3, saver: false }];
    eq('TP1: and which bots made the trips (a saver repeating its trip)', metric(r, 'TP1').detail.includes('by 2 bots (most: a 5 saving its laws; b 3, 3 cast)'), true);
    delete r.spells.byBot;
    const tp2 = metric(r, 'TP2');
    eq('TP2: failures of the casts begun (the clicks and the steps before them: 20 + 1 wield); at most 5 %', [tp2.value, tp2.ok, tp2.band], [9.5, false, { max: 5 }]);
    r.spells.failed = 0;
    r.spells.failReasons = {};
    eq('TP2: none failed', [metric(r, 'TP2').value, metric(r, 'TP2').ok], [0, true]);
    r.jumps = [
        { cls: 'spell', afterDeath: false, humanDist: 3, t: 10, name: 'a', from: [1, 2, 0], to: [3, 4, 0] },
        { cls: 'spell', afterDeath: false, humanDist: 40, t: 20, name: 'b', from: [1, 2, 0], to: [3, 4, 0] },
        { cls: 'jump', afterDeath: false, humanDist: 2, t: 30, name: 'c', from: [1, 2, 0], to: [3, 4, 0] }
    ];
    const tp3 = metric(r, 'TP3');
    eq('TP3: spells the human saw an hour (1 in 2 hours), report only', [tp3.value, tp3.ok, tp3.basis, tp3.detail.startsWith('1 of 2 spells')], [0.5, null, 'report', true]);
    r.botTicks = 600000;
    r.rescues = [{ cause: 'Combat/watchdog', jumps: 3, refused: 1 }, { cause: 'Woodcut/gateway:Lumbridge', jumps: 1, refused: 0 }, { cause: 'Mine/event', jumps: 2, refused: 0 }, { cause: 'RangedMagic/task', jumps: 0, refused: 2 }];
    const tp4 = metric(r, 'TP4');
    eq('TP4: rescue jumps per 100 bot-hours (not a random event\'s), by reason, task 0', [tp4.value, tp4.basis, tp4.detail.includes('watchdog 3, gateway 1'), tp4.detail.includes('task 0'), tp4.detail.includes('3 refused')], [4, 'report', true, true, true]);
    r.wrongTurns = { walks: 200, turns: 12, back: 11 };
    const f2 = metric(r, 'F2');
    eq('F2: wrong turns per 100 walks of 80+ tiles; its band 2-10', [f2.value, f2.ok, f2.band, f2.detail.includes('11 back')], [6, true, { min: 2, max: 10 }, true]);
    r.alch = { stints: 3, casts: 40, refused: 1, coins: 30000, items: { yew_longbow: 30, steel_platebody: 10 }, laws: { trips: 1, done: 1, laws: 25, elementals: 2 } };
    r.alchSightings = [{ t: 100, name: 'a', bank: 'varrock_west', state: 'cast' }, { t: 2000, name: 'a', bank: 'varrock_west', state: 'cast' }, { t: 5000, name: 'b', bank: 'falador_east', state: 'stand' }];
    const al1 = metric(r, 'AL1');
    eq('AL1: alchers the human saw at the trade banks an hour (3 in 2 hours), report only; the world\'s alching in the detail', [al1.value, al1.basis, al1.group, al1.detail.includes('varrock_west 2, falador_east 1'), al1.detail.includes('40 alchs (1 refused), 30000 coins: yew_longbow 30'), al1.detail.includes('law runs 1 (1 done, 25 laws)')], [1.5, 'report', 'presence', true, true, true]);
}
// ---- end of Track M's (phase 5a) block ----
// ---- (realism phase 5a, track F: fights, skills and manners) F1, F3, D1-D4, R1-R4 ----
{
    const r = record({ sampleEvery: 5 });
    eq('track F: nothing measured without the library\'s logs (an older library)', ['F1', 'F3', 'R1', 'R1h', 'R2', 'R3', 'R4'].map(id => metric(r, id).value), [null, null, null, null, null, null, null]);
    r.levellingTicks = 120000; // 20 levelling bot-hours
    r.fights = { levelling: 4000, samples: 12000, atCrowd: 0, bySpot: {}, elsewhere: {}, byPlanner: {} }; // 12000 × 5 ticks: 10 fighting bot-hours
    r.variety = [{ s: 1, ticks: 60000, kinds: { Mine: 30000 } }, { s: 2, ticks: 60000, kinds: { Mine: 30000, Woodcut: 10000 } }]; // 10 mining bot-hours
    r.texture = {
        fumbles: [...Array(18)].map((_, i) => ({ t: i * 100, name: `b${i % 6}`, kind: i % 3 === 0 ? 'rock' : i % 3 === 1 ? 'npc' : 'tree' })),
        food: [{ t: 1, name: 'a', took: 'none', carried: 0 }, { t: 2, name: 'b', took: 'none', carried: 3 }, { t: 3, name: 'c', took: 'few', carried: 0 }, ...[...Array(17)].map((_, i) => ({ t: 10 + i, name: 'd', took: 'full', carried: 0 }))],
        incidents: [],
        rudeReplies: [],
        courtesy: { passedOver: 9, shared: 2, stolen: 1 },
        wwm: { crossings: [{ t: 1, name: 'a', cb: 30 }, { t: 2, name: 'b', cb: 90 }, { t: 3, name: 'c', cb: 50 }] },
        work: null,
        humanName: 'sim_human'
    };
    const f1 = metric(r, 'F1');
    eq('F1 misclicks per levelling bot-hour: 18 in 20 hours, in band; the kinds in the detail', [f1.value, f1.ok, f1.detail.includes('rock 6, npc 6, tree 6')], [0.9, true, true]);
    const f3 = metric(r, 'F3');
    eq('F3 bank stops that left with no food while some was banked: 1 of 20 (one that carried 3 does not count), too few to judge (a count under 5: report)', [f3.value, f3.ok, f3.band, f3.detail.includes('(by 1 bot); 1 with only 2-4')], [5, null, null, true]);
    const forgetful = { ...r, texture: { ...r.texture, food: [...Array(30)].map((_, i) => ({ t: i, name: `f${i % 3}`, took: i < 6 ? 'none' : 'full', carried: 0 })) } };
    eq('F3 judged from 5 forgotten trips up: 6 of 30 (20 %) out of the 3-12 % band, by 3 bots', [metric(forgetful, 'F3').value, metric(forgetful, 'F3').ok, metric(forgetful, 'F3').detail.includes('(by 3 bots)')], [20, false, true]);
    // deaths: levelling bots' outside a fight (2: a fisher, a woodcutter on the mountain), a fighter's in one, a PKer's (the PK rules)
    r.deaths = [
        { t: 100, name: 'a', planner: 'skiller', task: 'Fish', by: 'young_dark_wizard', x: 3086, z: 3234 },
        { t: 900, name: 'a', planner: 'skiller', task: 'Woodcut', by: 'whitewolf', x: 2850, z: 3485 },
        { t: 5000, name: 'b', planner: 'fighter', task: 'Combat', by: 'hill_giant', x: 3110, z: 9840 },
        { t: 200, name: 'p', planner: 'extras_pker', task: 'PKer', by: 'q', x: 3090, z: 3600 }
    ];
    const d1 = metric(r, 'D1');
    eq('D1 deaths outside a fight per 100 levelling bot-hours (2 in 20 h: 10), too few to judge (a count under 5: report)', [d1.value, d1.ok, d1.band, d1.shown], [10, null, null, '10 (2 deaths)']);
    eq('D2 deaths in a fight per 100 fighting bot-hours (1 in 10 h); the PKers\' apart', [metric(r, 'D2').value, metric(r, 'D2').detail.includes("PKers' deaths (the PK rules, not judged) 1")], [10, true]);
    eq('D3 White Wolf Mountain deaths per 100 crossings by bots it hunts (1 death, 2 crossings of combat 76 or less)', [metric(r, 'D3').value, metric(r, 'D3').band], [50, null]);
    eq('D4 repeat deaths: the same bot within 30 min (a: 100 then 900), of the levelling bots\' 3', [metric(r, 'D4').value, metric(r, 'D4').shown], [33.3, '33.3 % (1 of 3)']);
    const many = { ...r, deaths: [...Array(10)].map((_, i) => ({ t: i * 5000, name: `x${i}`, planner: 'balanced', task: 'Mine', by: 'scorpion', x: 3300, z: 3300 })) };
    eq('D1 judged from 5 deaths up: 10 in 20 h (50) out of the 0.2-2 band', [metric(many, 'D1').value, metric(many, 'D1').ok, metric(many, 'D1').band], [50, false, { min: 0.2, max: 2 }]);
    // incidents: 3 deliberate kill-steals (one on the human, one in multi-combat), 1 take nobody meant, 2 rock steals
    const inc = (o = {}) => ({ id: 1, kind: 'ks', tick: 1000, stealer: 's', victim: 'v', stealerHuman: false, victimHuman: false, deliberate: true, multi: false, how: 'single', x: 3255, z: 3276, noticed: 1002, victimLine: -1, stealerLine: -1, ...o });
    r.texture.incidents = [
        inc({ victimLine: 1010, stealerLine: 1030 }),
        inc({ victimHuman: true, victim: 'sim_human', noticed: -1 }),
        inc({ multi: true, how: 'multi', victimLine: 1100 }),
        inc({ deliberate: false, how: '', stealer: 'sim_human', stealerHuman: true, victimLine: 1012 }),
        inc({ kind: 'rock', how: 'none-free', noticed: 1300, victimLine: 1315 }),
        inc({ kind: 'rock', how: 'none-free', victimHuman: true, victim: 'sim_human', noticed: -1 }),
        // (a rock the victim mined out itself first: never noticed, not R4's)
        inc({ kind: 'rock', how: 'none-free', noticed: -1 })
    ];
    eq('R1 deliberate kill-steals per 100 fighting bot-hours: 3 in 10 h, too few to judge', [metric(r, 'R1').value, metric(r, 'R1').band, metric(r, 'R1').detail.includes('on the human 1, in multi-combat 1'), metric(r, 'R1').detail.includes('took first, as their victim bots saw it, 1')], [30, null, true, true]);
    eq('R1h: n/a without the probe human at work', metric(r, 'R1h').value, null);
    r.texture.work = { cowTicks: 3000, mineTicks: 3000, cowClicks: 40, rockClicks: 60 };
    eq('R1h kill-steals on the human per hour of its fighting (1 in 30 min)', [metric(r, 'R1h').value, metric(r, 'R1h').shown], [2, '2 (1 steal)']);
    const r2 = metric(r, 'R2');
    eq('R2 rock steals per 100 mining bot-hours (3 in 10 h); how, the courtesy and the human\'s work in the detail', [r2.value, r2.detail.includes("no free rock 3, a lazy one 0; the human's 1"), r2.detail.includes('passed over 9 picks (another free), shared 2 (none free), taken 1'), r2.detail.includes('the human mined 30 minutes')], [30, true, true, true]);
    const r4 = metric(r, 'R4');
    // noticed by a bot victim: ks 1, 3, 4 and rock 5 (the human's and the rock never noticed left out); lines within 15 s of
    // the notice: 1010, 1012, 1315 (1100 is 98 ticks late)
    eq('R4 steals and takes a bot victim noticed, with its line within 15 s of noticing (3 of 4), answers after one (1 of 3 with a bot stealer)', [r4.value, r4.shown, r4.band], [75, '75 % (33.3 %)', null]);
    // rude replies: 1 of 4 replies to the human (one public, one private), matched by the bot and the text
    r.lines = [
        line({ name: 'v', kind: 'reply', to: 'human', text: 'use ur map' }),
        line({ name: 'v', kind: 'reply', to: 'human', text: 'north' }),
        line({ name: 'w', kind: 'reply', to: 'bot', text: 'use ur map' }),
        line({ name: 'w', kind: 'idle', text: 'lol' })
    ];
    r.pms = [{ t: 1, from: 'v', text: 'ya im here' }, { t: 2, from: 'x', text: 'who asked' }];
    r.texture.rudeReplies = [{ t: 1, name: 'v', text: 'use ur map' }, { t: 2, name: 'x', text: 'who asked' }];
    eq('R3 rude replies among the replies to the human (2 of 4, public and private: 50 %): too few replies to judge (under R3_JUDGE_MIN)', [metric(r, 'R3').value, metric(r, 'R3').ok, metric(r, 'R3').band], [50, null, null]);
    const talkative = { ...r, pms: [...r.pms, ...[...Array(M.R3_JUDGE_MIN)].map((_, i) => ({ t: 10 + i, from: 'y', text: `answer ${i}` }))] };
    eq('R3 judged from R3_JUDGE_MIN replies up: 2 of 104 (1.9 %), under the 3-12 % band', [metric(talkative, 'R3').value, metric(talkative, 'R3').ok], [1.9, false]);
    eq('the groups: fallible bots, manners', [metric(r, 'F1').group, metric(r, 'R3').group, !!M.GROUPS.texture, !!M.GROUPS.rudeness], ['texture', 'rudeness', true, true]);
}
// ---- end of track F's block ----
// ---- random events (realism phase 5a, track E): RE1-RE7 from the library's notes ----
{
    // 2 hours; notes as the runner keeps them (port/BotRandomEvents' randomEventListeners)
    const n = (t, type, o = {}) => ({ t, name: o.name ?? 'a', type, kind: o.kind ?? null, humanDist: o.humanDist ?? null, move: o.move ?? null, ticks: o.ticks ?? null, fallback: o.fallback ?? null, stat: o.stat ?? null, xp: o.xp ?? null, reason: o.reason ?? null, to: o.to ?? null });
    const notes = [
        n(100, 'armed', { name: 'a', humanDist: 4 }),
        n(150, 'start', { name: 'a', kind: 'genie', humanDist: 5 }),
        n(170, 'answered', { name: 'a', kind: 'genie' }),
        n(171, 'lamp-got', { name: 'a' }),
        n(230, 'lamp-rubbed', { name: 'a', stat: 'agility', xp: 400 }),
        n(700, 'start', { name: 'b', kind: 'oldman', humanDist: 12 }),
        n(782, 'move', { name: 'b', move: 'fail', humanDist: 12, to: [3278, 3500, 1] }),
        n(800, 'recovered', { name: 'b', ticks: 18, fallback: false }),
        n(1300, 'start', { name: 'c', kind: 'dwarf', humanDist: 18 }),
        n(1900, 'start', { name: 'd', kind: 'box', humanDist: 9 }),
        n(2500, 'start', { name: 'e', kind: 'none', humanDist: 3 }),
        n(3000, 'start', { name: 'f', kind: 'triffid', humanDist: 2 }),
        n(3050, 'answered', { name: 'f', kind: 'triffid' }),
        n(3600, 'start', { name: 'g', kind: 'genie', humanDist: 7 }),
        n(3700, 'answered', { name: 'g', kind: 'genie' }),
        n(3701, 'lamp-got', { name: 'g' }),
        n(4400, 'lamp-rubbed', { name: 'g', stat: 'prayer', xp: 300 }),
        n(4200, 'start', { name: 'h', kind: 'lostaxe', humanDist: 25 }),
        n(4800, 'start', { name: 'i', kind: 'genie', humanDist: 6 }),
        n(4850, 'answered', { name: 'i', kind: 'genie' }),
        n(4851, 'lamp-got', { name: 'i' }),
        n(4900, 'lamp-rubbed', { name: 'i', stat: 'woodcutting', xp: 300 }),
        n(5400, 'start', { name: 'j', kind: 'oldman', humanDist: 1 }),
        n(5420, 'answered', { name: 'j', kind: 'oldman' })
    ];
    const r = record({ ticks: 12000, warmup: 0 }, { randomEvents: { notes, drops: [{ t: 4210, name: 'h', left: false }, { t: 5000, name: 'k', left: true }], moves: [{ t: 782, name: 'b', move: 'fail', xpAt: 1500, gone: -1 }, { t: 2000, name: 'd', move: 'maze-out', xpAt: -1, gone: 2100 }, { t: 3000, name: 'x', move: 'mime-out', xpAt: 4500, gone: -1 }, { t: 11500, name: 'y', move: 'fail', xpAt: -1, gone: -1 }] } });
    const re1 = metric(r, 'RE1');
    eq('RE1: events within 15 tiles an hour (7 in 2 h: not the one at 18, the far one, the empty flag)', [re1.value, re1.ok], [3.5, true]);
    eq('RE1: the detail (the kinds, the 16-20 band, the empty flags)', [re1.detail.includes('genie 3'), re1.detail.includes('1 at 16-20 tiles'), re1.detail.includes('1 flags spent with nothing spawned')], [true, true, true]);
    const re2 = metric(r, 'RE2');
    eq('RE2: fail teleports seen an hour (one at 12 tiles in 2 h), report only', [re2.value, re2.ok, re2.detail.includes('back on the ground 1')], [0.5, null, true]);
    const re3 = metric(r, 'RE3');
    eq('RE3: lamps rubbed within 5 min: 3 lamps are too few to judge', [re3.value, re3.detail.includes('2 of 3 lamps')], [null, true]);
    const re4 = metric(r, 'RE4');
    eq('RE4: events more than 20 tiles from every human (the lost axe at 25)', [re4.value, re4.ok], [1, false]);
    const re5 = metric(r, 'RE5');
    eq('RE5: back at XP within 10 min: 2 judged (one gone first, one too late in the run) is too few', [re5.value, re5.detail.includes('1 of 2 levelling bots')], [null, true]);
    const re6 = metric(r, 'RE6');
    eq('RE6: NPC events answered: 5 of 7 (the old man that teleported b, the dwarf not)', [re6.value, re6.ok], [71.4, true]);
    const re7 = metric(r, 'RE7');
    eq('RE7: tool heads or rods left until revealed: one', [re7.value, re7.ok], [1, false]);
    // enough lamps and moves to judge
    const many = record({ ticks: 12000, warmup: 0 }, {
        randomEvents: {
            notes: Array.from({ length: 6 }, (_, i) => [n(100 + i * 1000, 'lamp-got', { name: `l${i}` }), n(100 + i * 1000 + (i === 5 ? 600 : 100), 'lamp-rubbed', { name: `l${i}`, stat: 'mining' })]).flat(),
            drops: [],
            moves: [...Array.from({ length: 5 }, (_, i) => ({ t: 100 + i * 1000, name: `m${i}`, planner: 'skiller', move: 'fail', xpAt: i === 4 ? -1 : 300 + i * 1000, gone: -1 })), { t: 500, name: 'v', planner: 'extras_vendor', move: 'maze-out', xpAt: -1, gone: -1 }]
        }
    });
    eq('RE3: 5 of 6 lamps rubbed within 5 min', [metric(many, 'RE3').value, metric(many, 'RE3').ok], [83.3, true]);
    eq('RE5: 4 of 5 levelling bots\' moves followed by XP within 10 min (a vendor\'s left out)', [metric(many, 'RE5').value, metric(many, 'RE5').ok, metric(many, 'RE5').detail.includes('1 of other bots left out')], [80, false, true]);
    eq('no notes (an older library): every RE metric n/a', ['RE1', 'RE2', 'RE3', 'RE4', 'RE5', 'RE6', 'RE7'].map(id => metric(record(), id).value), [null, null, null, null, null, null, null]);
    eq('the random events group', metric(r, 'RE1').group === 'randomEvents' && !!M.GROUPS.randomEvents, true);
}
// ---- end of track E's (phase 5a) block ----

// ---- (realism phase 5b, the foundation) the set pieces' lines: out of H7, reported as X2 ----
{
    // 6000 ticks: an hour; four set pieces' lines and one idle line, one of them heard by the human
    const r = record({ ticks: 6000 });
    r.lines = [
        line({ name: 'a', kind: 'idle', text: 'hi' }),
        line({ name: 'b', kind: 'setpiece', text: 'stake 10k?' }),
        line({ name: 'c', kind: 'rumour', text: 'drop party at fally park!!', humanDist: 5 }),
        line({ name: 'd', kind: 'scam', text: 'doubling money' }),
        line({ name: 'e', kind: 'mod', text: 'please dont spam' })
    ];
    const x2 = metric(r, 'X2');
    eq("X2: the set pieces' lines an hour (4), by kind, 1 heard by the human; report only", [x2.value, x2.detail.includes('setpiece 1, rumour 1, scam 1, mod 1'), x2.detail.includes('1 heard'), x2.basis], [4, true, true, 'report']);
    eq("the set pieces' kinds: out of the chatter measures (isAside) as trade is, but not trade; their own group", [M.isAside({ kind: 'scam' }), M.isAside({ kind: 'idle' }), M.isTrade({ kind: 'mod' }), M.kindGroup('rumour')], [true, false, false, 'setpiece']);
}

// ---- (realism phase 5b, Track D: the director and groups) V1-V4, G2-G5 on a hand-made record.setPieces ----
{
    // two hours: two events (a clan walk and a PK raid), 6 recruits (one logged out mid-event, 4 back, 1 not), the human
    // saw one and heard of the other; 2 groups of 3+; 5 clan walkers, 4 in its colour; 3 trains; 3 piles, one on the human,
    // none in a single-combat zone
    const r = record({ ticks: 12000, members: true });
    const rec = (name, left, back) => ({ name, role: 'member', left, back });
    r.setPieces = {
        events: [
            { id: 1, kind: 'clan_walk', venue: 'falador_park', start: 3000, startPlay: 3000, end: 4500, outcome: 'done', recruits: [rec('a', null, true), rec('b', null, true), rec('c', 'logout', undefined), rec('d', null, false)], rumours: [{ t: 3200, name: 'x', nearHuman: false }] },
            { id: 2, kind: 'pk_raid', venue: 'varrock_wildy', start: 9000, startPlay: 9000, end: 11000, outcome: 'beaten', recruits: [rec('e', null, true), rec('f', null, true)], rumours: [{ t: 9100, name: 'y', nearHuman: true }] }
        ],
        seen: [{ id: 1, t: 3500 }, { id: 1, t: 3505 }],
        groups: [{ t: 3600, size: 4, names: ['a', 'b', 'd', 'c'] }, { t: 5000, size: 3, names: ['n1', 'n2', 'z'] }],
        capes: [{ id: 1, name: 'a', match: true }, { id: 1, name: 'b', match: true }, { id: 1, name: 'c', match: true }, { id: 1, name: 'd', match: false }, { id: 3, name: 'q', match: true }],
        piles: [{ t: 9500, human: true, n: 3, multi: true }, { t: 9700, human: false, n: 2, multi: true }, { t: 9900, human: false, n: 2, multi: true }],
        trains: [{ start: 100, end: 400, members: ['n1', 'n2'], human: false, reason: 'still' }, { start: 2000, end: 2300, members: ['n3'], human: true, reason: 'told off' }, { start: 7000, end: 7600, members: ['n4'], human: false, reason: 'time' }]
    };
    r.lines = [line({ name: 'y', kind: 'rumour', text: 'pk team at varrock wildy dont go', t: 9150, humanDist: 6 }), line({ name: 'x', kind: 'rumour', text: 'clan walk in lumby lol', t: 3250, humanDist: 40 })];
    const v1 = metric(r, 'V1');
    eq('V1: 2 events in 2 hours of play: 1 an hour, judged (0.5-1.5) on a 2-hour run', [v1.value, v1.ok, v1.band], [1, true, { min: 0.5, max: 1.5 }]);
    eq('V1: a 1-hour run is shown, not judged', metric(record({ ticks: 6000 }, { setPieces: r.setPieces }), 'V1').ok, null);
    eq('V2: events seen (a part within 15 tiles at the peak) or heard of (a rumour within 15), an hour: 2 in 2 h', metric(r, 'V2').value, 1);
    const v3 = metric(r, 'V3');
    eq('V3: 4 of 5 looked-at recruits back (one left mid-event): 80 %, under 90', [v3.value, v3.ok], [80, false]);
    const v4 = metric(r, 'V4');
    eq('V4: 1 of 6 recruits logged out mid-event: 16.7 %, over 10', [v4.value, v4.ok], [16.7, false]);
    eq('G2: 2 groups of 3+ in 2 h: 1 an hour (report)', [metric(r, 'G2').value, metric(r, 'G2').ok], [1, null]);
    const g3 = metric(r, 'G3');
    eq('G3: 4 of 5 walkers in their colour: 80 %, in band', [g3.value, g3.ok], [80, true]);
    eq('G3: under 5 walkers shown, not judged', metric(record({ ticks: 12000 }, { setPieces: { ...r.setPieces, capes: r.setPieces.capes.slice(0, 3) } }), 'G3').ok, null);
    eq('G4: 3 trains in 2 h: 1.5 an hour (report)', [metric(r, 'G4').value, metric(r, 'G4').detail.includes('1 behind the human')], [1.5, true]);
    const g5 = metric(r, 'G5');
    eq('G5: 3 piles, none in a single-combat zone: 0, ✓', [g5.value, g5.ok, g5.detail.includes('1 on the human')], [0, true, true]);
    const brief = record({ ticks: 12000 }, { setPieces: { ...r.setPieces, brief: [{ t: 100, multi: false }, { t: 200, multi: true }] } });
    eq('G5: the shorter ones (a click the game refused) are shown apart, not counted', [metric(brief, 'G5').value, metric(brief, 'G5').detail.includes('1 in single-combat, 1 in multi')], [0, true]);
    const single = record({ ticks: 12000 }, { setPieces: { ...r.setPieces, piles: [...r.setPieces.piles, { t: 11000, human: false, n: 2, multi: false }] } });
    eq('G5: a pile in a single-combat zone: ✗', [metric(single, 'G5').value, metric(single, 'G5').ok], [1, false]);
    eq("the foundation's stubs (no director's or trains' log): V1-V4 and G4 n/a, G5 measured", ['V1', 'V2', 'V3', 'V4', 'G4', 'G5'].map(id => metric(record({ ticks: 12000 }, { setPieces: { ...r.setPieces, noDirector: true, noTrains: true } }), id).value), [null, null, null, null, null, 0]);
    eq('an older library (no setPieces): every Track D metric n/a', ['V1', 'V2', 'V3', 'V4', 'G2', 'G3', 'G4', 'G5'].map(id => metric(record(), id).value), [null, null, null, null, null, null, null, null]);
}
// ---- end of Track D's (phase 5b) block ----
// ---- (realism phase 5b, track P: parties, scams and lures) DP1-DP5, K1-K4 ----
{
    // an hour (warmup 0): two director's parties and a forced one; a drop party's piles: 4 shown, one taken by a bot 5
    // ticks after showing, one 15, one by the human, one left; a Party Room with 50 pops and 2 of 10 chest slots left
    const pile = (t, by, after, name = null) => ({ item: 'feather', count: 10, t, revealAt: t + 100, goneAt: after === null ? -1 : t + 100 + after, by, name });
    const party = (o = {}) => ({ id: 1, kind: 'drop_party', venue: 'falador_park', host: 'h', start: 0, end: 900, outcome: 'done', budget: 5000, kitValue: 4800, kitDrops: 4, better: false, joke: false, asked: 9, came: 8, peak: 9, lines: 10, drops: [], chest: null, lever: false, knights: false, pops: { host: 0, guests: 0, items: 0 }, hostGot: [], stuckAfter: 0, ...o });
    const r = record({ ticks: 6000, warmup: 0 });
    r.parties = [
        party({ drops: [pile(100, 'bot', 5, 'g1'), pile(103, 'bot', 15, 'g2'), pile(106, 'other', 4), pile(109, 'despawned', 200)] }),
        party({ id: 2, kind: 'party_room', venue: 'party_room', peak: 5, drops: [], chest: { before: 1, after: 11, end: 3 }, lever: true, pops: { host: 10, guests: 40, items: 12 }, stuckAfter: 1 }),
        party({ id: 3, forced: true, peak: 13, outcome: 'done', drops: [] })
    ];
    r.partyHuman = { takes: [{ t: 210, item: 'feather', afterReveal: 4 }], clicks: 2 };
    const dp1 = metric(r, 'DP1');
    eq('DP1: the director\'s parties an hour (2: the forced one left out); 2 parties, under 5: not judged', [dp1.value, dp1.ok, dp1.detail.includes('1 forced')], [2, null, true]);
    const dp2 = metric(r, 'DP2');
    eq('DP2: the median peak of the parties done (5, 9, 13 -> 9), in 5-20 at 100 bots', [dp2.value, dp2.ok], [9, true]);
    eq('DP2: not judged at 500 bots (the guest cap is 25 there)', metric(record({ bots: 500 }, { parties: r.parties }), 'DP2').ok, null);
    const dp3 = metric(r, 'DP3');
    eq("DP3: a drop party's piles shown (4): under 10, out of its band", [dp3.value, dp3.ok], [4, false]);
    const dp3b = metric(r, 'DP3b');
    eq('DP3b: under 6 piles shown, not judged; 1 of 4 taken by a bot within 10 ticks (25 %), the human\'s take in the detail', [dp3b.value, dp3b.ok, dp3b.detail.includes('the scrambling human took 1')], [25, null, true]);
    const more = record({ ticks: 6000, warmup: 0 }, { parties: [party({ drops: [0, 1, 2, 3, 4, 5, 6, 7].map(i => pile(100 + 3 * i, 'bot', i < 5 ? 3 : 20, 'g')) })] });
    eq('DP3b: 5 of 8 piles within 10 ticks: 62.5 %, over 60', [metric(more, 'DP3b').value, metric(more, 'DP3b').ok], [62.5, false]);
    const dp4 = metric(r, 'DP4');
    eq('DP4: 50 pops (30-120), 2 of 10 chest slots left (20 %, at most 30): in band', [dp4.value, dp4.ok, dp4.shown], [50, true, '50 pops (20 % left)']);
    const dp5 = metric(r, 'DP5');
    eq('DP5: one bot stuck at the venue 10 minutes on: out of band', [dp5.value, dp5.ok], [1, false]);
    eq('DP: n/a with no logs (an older library)', ['DP1', 'DP2', 'DP3', 'DP3b', 'DP4', 'DP5', 'K1', 'K2', 'K3', 'K4'].map(id => metric(record(), id).value), [null, null, null, null, null, null, null, null, null, null]);

    // scams: 6 calls by the caller c (kind scam, to nobody), warnings to it after the first two (one too late, one too
    // far), the human hears 3 scam lines
    const k = record({ ticks: 6000, warmup: 0 });
    k.scams = [{ id: 1, kind: 'ambient', venue: 'varrock_west', caller: 'c', start: 0, end: 600, calls: 6, warnings: 3, answers: 1, mod: false, tradeRequests: 1, outcome: 'done' }];
    k.lines = [
        ...[0, 1, 2, 3, 4, 5].map(i => line({ t: 100 * i, name: 'c', kind: 'scam', text: 'doubling money', humanDist: i < 3 ? 5 : 40 })),
        line({ t: 30, name: 'w1', kind: 'setpiece', toName: 'c', text: 'its a scam' }),
        line({ t: 150, name: 'w2', kind: 'setpiece', toName: 'c', text: 'lol nice try' }),
        line({ t: 350, name: 'w3', kind: 'setpiece', toName: 'c', text: 'scammer lol', x: 3300 })
    ];
    const k1 = metric(k, 'K1');
    eq('K1: scam lines the human heard an hour (3), report', [k1.value, k1.basis], [3, 'report']);
    const k2 = metric(k, 'K2');
    eq("K2: calls followed by a warning to the caller within 100 ticks and 15 tiles: 2 of 6 (33.3 %), in band", [k2.value, k2.ok], [33.3, true]);
    eq('K3: trade requests to callers (1), report', [metric(k, 'K3').value, metric(k, 'K3').basis], [1, 'report']);

    // lures: 4 approaches, 6 lures of 4 forms (the most common 2 of 6), one to a waiting PK team
    const l = record({ ticks: 6000, warmup: 0, humanName: 'sim human' });
    l.lures = { approaches: [1, 2, 3, 4].map(t => ({ t, human: 'sim_human', bot: 'b' })), lures: ['armour', 'armour', 'phat', 'rare', 'clan', 'lobs'].map((form, i) => ({ t: i, form, ambush: i === 0, human: 'sim_human', bot: 'b' })), all: 6 };
    const k4 = metric(l, 'K4');
    eq('K4: the most common lure form 33.3 % of 6 lures (40 % at most), 4 approaches an hour', [k4.value, k4.ok, k4.shown], [33.3, true, '33.3 % (4 approaches/h)']);
    l.lures.lures = l.lures.lures.slice(0, 2);
    eq('K4: under 5 lures, not judged', metric(l, 'K4').ok, null);

    // H19: a stand in a set piece (a party's guest waiting, a scam caller) left out, as a hang-out's
    const h = record({ ticks: 6000 }, { levellingTicks: 6000 * 10 });
    h.idleStands = [
        { s: 1, planner: 'skiller', start: 0, len: 300, kind: 'Woodcut' },
        { s: 2, planner: 'skiller', start: 0, len: 300, kind: 'PartyGuest' },
        { s: 3, planner: 'skiller', start: 0, len: 300, kind: 'ScamCall' },
        { s: 4, planner: 'skiller', start: 0, len: 300, kind: 'Hangout' }
    ];
    const h19 = metric(h, 'H19');
    eq('H19: one stand of 4 counted (10 levelling bot-hours: 10 per 100), the set pieces\' and the hang-out\'s left out', [h19.value, h19.detail.includes('2 in a set piece left out'), h19.detail.includes('1 at a hang-out')], [10, true, true]);
}
// ---- end of track P's block ----
// ---- (realism phase 5b, track A: the Duel Arena and the player-mod bot) A1-A6, Q1-Q3, and H19 without the arena's stands ----
{
    const duel = (o = {}) => ({ id: 1, a: 'a', b: 'b', human: null, stake: 0, rules: 0, start: 500, end: 700, winner: 'a', outcome: 'done', forfeit: false, spectators: 0, tomatoes: 0, x: 3360, z: 3240, big: false, ...o });
    const arena = (o = {}) => ({ samples: 10, inArena: 50, online: 1000, max: 7, humanTicks: 0, duels: [], challenges: [], cap: 8, ...o });
    const r = record({ members: true, ticks: 6000 }, {
        arena: arena({
            duels: [duel({ stake: 1000, spectators: 0 }), duel({ stake: 5000, spectators: 1, tomatoes: 1 }), duel({ stake: 10000, spectators: 2 }), duel({ stake: 20000, spectators: 3, tomatoes: 2 }), duel({ spectators: 4 }), duel({ spectators: 5 }), duel({ start: -1, stake: 9000 })]
        })
    });
    eq('A1: bots in the arena per 100 online (50 in 1,000 bot-samples: 5), in band', [metric(r, 'A1').value, metric(r, 'A1').ok], [5, true]);
    eq('A2: duels fought an hour (6 of 7: one never came to a fight)', [metric(r, 'A2').value, metric(r, 'A2').ok], [6, true]);
    eq('A3: duels with a stake (4 of 6), in band', [metric(r, 'A3').value, metric(r, 'A3').ok], [66.7, true]);
    eq('A3b: the median stake', [metric(r, 'A3b').value, metric(r, 'A3b').ok], [M.quantile([1000, 5000, 10000, 20000], 0.5), true]);
    eq('A4: the median watchers', [metric(r, 'A4').value, metric(r, 'A4').ok], [M.quantile([0, 1, 2, 3, 4, 5], 0.5), true]);
    eq('A5: tomatoes a duel (3 at 6), in band', [metric(r, 'A5').value, metric(r, 'A5').ok], [0.5, true]);
    eq('A6: n/a under 10 minutes of the human in the challenge area', metric(r, 'A6').value, null);
    r.arena.humanTicks = 1200;
    r.arena.challenges = [{ t: 1, bot: 'a', human: 'h', answer: 'ignored', from: 'bot' }, { t: 2, bot: 'b', human: 'h', answer: 'refused', from: 'bot' }, { t: 3, bot: 'c', human: 'h', answer: 'declined:higher', from: 'human' }];
    eq("A6: the bots' challenges per 10 minutes there (2 in 12 min), in band; the human's own apart", [metric(r, 'A6').value, metric(r, 'A6').ok, metric(r, 'A6').detail.includes("the human's own 1")], [1.67, true, true]);
    const few = record({ members: true }, { arena: arena({ duels: [duel(), duel()] }) });
    eq('A3-A5: two duels are too few to judge', ['A3', 'A4', 'A5'].map(id => metric(few, id).value), [null, null, null]);
    const free = record({ members: false }, { arena: arena({ duels: [duel(), duel(), duel()] }) });
    eq('A1-A6: n/a on a free world', ['A1', 'A2', 'A3', 'A6'].map(id => metric(free, id).value), [null, null, null, null]);
    // Q1-Q3: a mod online the whole hour (1,200 samples of 5 ticks)
    const q = record({ ticks: 6000 }, { modBot: { samples: 1200, online: 1200, crowned: [{ t: 1, name: 'mod', rights: 1, mod: true }, { t: 2, name: 'x', rights: 1, mod: false }], humanSpam: [], log: [], spam: [{ t: 100, who: 'scammer', human: false, what: 'scam', x: 3200, z: 3200, level: 0 }], mods: ['mod'] } });
    q.lines = [line({ name: 'mod', kind: 'mod', t: 150, x: 3205, z: 3200, humanDist: 5 }), line({ name: 'mod', kind: 'mod', t: 2000, x: 3205, z: 3200, humanDist: 50 }), line({ name: 'b', kind: 'idle', humanDist: 1 })];
    eq('Q1: duty lines the human heard an hour of a mod online (1); report', [metric(q, 'Q1').value, metric(q, 'Q1').basis], [1, 'report']);
    eq('Q2: duty lines after spam within 60 s and 25 tiles (1 of 2), out of band', [metric(q, 'Q2').value, metric(q, 'Q2').ok], [50, false]);
    eq('Q3: a crowned line from a bot that is no mod: out of band', [metric(q, 'Q3').value, metric(q, 'Q3').ok], [1, false]);
    eq('Q1-Q3: n/a without the mod', ['Q1', 'Q2', 'Q3'].map(id => metric(record(), id).value), [null, null, null]);
    // H19: a stand at the Duel Arena is the arena's (A1), as one at a hang-out is C16's
    const h = record({}, { levellingTicks: 60000, idleStands: [{ s: 1, planner: 'skiller', start: 0, len: 300, kind: 'Woodcut' }, { s: 2, planner: 'fighter', start: 0, len: 400, kind: 'DuelArena' }] });
    eq('H19 leaves out the stands at the Duel Arena', [metric(h, 'H19').value, metric(h, 'H19').detail.includes('1 at the Duel Arena left out (A1)')], [10, true]);
    // D1, D2, D4: a duel lost is no death (274 keeps the loser's items): a visit's, or in an arena on a big stake's sub-task
    const dd = record({}, { levellingTicks: 60000, deaths: [
        { t: 100, s: 1, name: 'a', planner: 'fighter', task: 'DuelArena', by: 'b', x: 3341, z: 3251 },
        { t: 400, s: 1, name: 'a', planner: 'fighter', task: 'DuelArena', by: 'b', x: 3342, z: 3249 },
        { t: 900, s: 2, name: 'c', planner: 'fighter', task: 'Combat', by: 'd', x: 3370, z: 3230 },
        { t: 1000, s: 3, name: 'e', planner: 'skiller', task: 'Woodcut', by: 'young_dark_wizard', x: 3080, z: 3240 }
    ] });
    eq('D1 leaves out duels lost (one death at a skill, 10 an hour of 100)', [metric(dd, 'D1').value, metric(dd, 'D1').detail.includes('3 duels lost left out')], [10, true]);
    eq("D4 leaves them out too: no repeat (the duellist's two)", metric(dd, 'D4').value, 0);
}
// ---- end of track A's (phase 5b) block ----

// ---- (realism phase 7, Track E: the language model) MD1-MD6 from record.model; not in the fingerprint ----
{
    const mm = (rec, id) => M.computeModelMetrics(rec).find(m => m.id === id);
    const plain = record();
    eq('MD: none without a model (and the fingerprint is the same with them computed)', [M.computeModelMetrics(plain).length, M.fingerprint(M.computeMetrics(plain))], [0, M.fingerprint(M.computeMetrics(record()))]);
    const stats = { eligible: 20, requests: 18, used: 16, fallbacks: { busy: 2, guard: 2 }, errors: {}, guard: { assistant: 1, level: 1 }, late: 0, latency: [2, 2, 3], candidates: { eligible: 5, requests: 5, used: 4, byVia: { conversation: 3, crowd: 2 } } };
    const log = [
        { id: 1, t: 102, bot: 'a', via: 'named', intent: 'combat', candidate: false, heard: 'A whats ur cb', ruleText: '45', outcome: 'used', said: '45 lol', saidAt: 110 },
        { id: 2, t: 202, bot: 'a', via: 'private', intent: 'how', candidate: false, heard: 'how r u', ruleText: 'good u?', outcome: 'used', said: 'good', saidAt: 215 },
        { id: 3, t: 302, bot: 'b', via: 'named', intent: null, candidate: true, heard: 'B blorf', ruleText: null, outcome: 'guard', reason: 'assistant', planted: 'assistant', raw: 'Certainly!' },
        { id: 4, t: 402, bot: 'b', via: 'named', intent: null, candidate: true, heard: 'B quux', ruleText: null, outcome: 'used', planted: 'level', raw: 'im 99 cb', said: 'im 99 cb', saidAt: 410 }
    ];
    const rec = record({ ticks: 3000 }, {
        probes: [{ t: 100, kind: 'public', bot: 'a', line: 'A whats ur cb' }, { t: 200, kind: 'pm', bot: 'a', line: 'how r u' }, { t: 500, kind: 'public', bot: 'c', line: 'C hi' }],
        lines: [line({ t: 110, name: 'a', kind: 'reply', text: '45 lol', humanDist: 1 }), line({ t: 508, name: 'c', kind: 'reply', text: 'hey', humanDist: 1 })],
        pms: [{ t: 215, from: 'a', text: 'good' }],
        model: { kind: 'stub', latencyTicks: 2, failRate: 0, stats, log }
    });
    eq('MD1: the eligible replies in the model\'s words (16 of 20), ✓ from 90 % only', [mm(rec, 'MD1').value, mm(rec, 'MD1').ok], [80, false]);
    eq('MD2: the fallbacks by reason (4: busy 2, guard 2)', [mm(rec, 'MD2').value, mm(rec, 'MD2').detail.includes('busy 2') && mm(rec, 'MD2').detail.includes('guard 2')], [4, true]);
    eq('MD3: the guard\'s refusals; a planted line it let through is a ✗', [mm(rec, 'MD3').value, mm(rec, 'MD3').ok, mm(rec, 'MD3').detail.includes('planted 2 bad lines, 1 caught')], [2, false, true]);
    eq("MD4: the model's replies (10, 15 ticks) against the rules' (8)", [mm(rec, 'MD4').value, mm(rec, 'MD4').ok, mm(rec, 'MD4').detail.includes("the rules' 8/8/8 (1)")], [15, true, true]);
    eq('MD5: requests an hour of play (18 in half an hour)', mm(rec, 'MD5').value, 36);
    eq('MD6: lines the rules left unanswered said in its words', [mm(rec, 'MD6').value, mm(rec, 'MD6').detail.includes('conversation 3')], [4, true]);
    eq('MD: the model group prints apart', M.formatMetrics(M.computeModelMetrics(rec)).join('\n').includes('The language model'), true);
}

// ---- (variety round 1: each track's synthetic checks in a block of its own) ----
// ---- Track F (fixes and movement) ----
{
    // n/a without the track's record (an older library, an A/B run)
    const none = record();
    for (const id of ['TP4f', 'AM6', 'AM7', 'DP2b', 'G4b', 'FM1']) eq(`${id}: n/a without its record`, metric(none, id).value, null);
    // TP4f: the fill's window, per 100 bots; TP4 after it per 100 bot-hours in the detail
    const r = record({ bots: 200 }, { botTicks: 6000 * 50 });
    r.tracks = {
        fixes: {
            fill: { start: 1, window: 500, windowEnd: 500, jumps: 6, refused: 1, causes: { 'Combat/stuck': 4, 'Mine/watchdog': 2 }, botTicks: 6000 * 10, allJumps: 26, allRefused: 2, allCauses: { 'Combat/stuck': 14, 'Mine/watchdog': 12 }, boostP95: 40, afterP95: 30 },
            gather: { ticks: { Mine: 800, Woodcut: 200 }, wander: { Mine: 30, Woodcut: 10 }, wait: { Mine: 100 }, waits: 5, gaveUp: 2, said: 1 },
            bank: { visits: 50, futile: 4, loops: [{ t: 10, name: 'x', task: 'Thieve', state: 'bank_done', at: [2655, 3283, 0], humanDist: 99 }], guard: { ended: 1, byTask: { Thieve: 1 } } },
            messages: { 'Combat/interact|I can\'t reach that!': { n: 12, at: { '3296,3168': 8 } } }
        }
    };
    const tp = metric(r, 'TP4f');
    eq('TP4f: 6 jumps at 200 bots = 3 per 100 (in band: at most 5)', [tp.value, tp.ok], [3, true]);
    eq('TP4f: TP4 after the window in the detail: 20 jumps in 40 bot-hours = 50', tp.detail.includes('after it 50 per 100 bot-hours'), true);
    const am6 = metric(r, 'AM6');
    eq('AM6: 40 of 1000 gatherer ticks walking about = 4 % (in band)', [am6.value, am6.ok], [4, true]);
    const am7 = metric(r, 'AM7');
    eq('AM7: one loop is out of band (0)', [am7.value, am7.ok], [1, false]);
    const fm = metric(r, 'FM1');
    eq('FM1: 12 messages in an hour (report)', [fm.value, fm.ok], [12, null]);
    // DP2b: the asked guests of done parties who came; judged from 5 asked
    const p = record({}, { parties: [{ outcome: 'done', asked: 6, came: 6, retries: 2, lost: 0, replaced: 0, walkIns: 3, walkInsCame: 3, peak: 9, venue: 'falador_park', drops: [] }, { outcome: 'host left', asked: 4, came: 0, venue: 'x', drops: [] }] });
    const dp = metric(p, 'DP2b');
    eq('DP2b: 6 of 6 asked came (the aborted party left out), in band', [dp.value, dp.ok], [100, true]);
    p.parties[0].came = 4;
    eq('DP2b: 4 of 6 is out of band (90 % at least)', metric(p, 'DP2b').ok, false);
    // G4b: the trains' members, median; judged from 3 trains
    // (the set pieces' record, only its trains: G4b's own function and band, not the whole report)
    const g4b = M.METRICS.find(m => m.id === 'G4b');
    const g = record({}, { setPieces: { trains: [{ end: 10, members: ['a'] }, { end: 20, members: ['a', 'b'] }, { end: 30, members: ['a', 'b', 'c'] }] } });
    eq('G4b: members 1, 2, 3: median 2 (in band)', [g4b.fn(g).value, M.inBand(g4b.fn(g).value, g4b.band(g))], [2, true]);
    g.setPieces.trains = [{ end: 10, members: ['a'] }, { end: 20, members: ['a'] }];
    eq('G4b: two trains of one: not judged', g4b.band(g), null);
    eq('the fixes group prints apart', M.GROUPS.fixes, 'Fixes and movement (variety round 1)');
}
// ---- end of Track F's (variety) checks ----
// ---- Track D (what and where) ----
// ---- end of Track D's (variety) checks ----
// ---- Track S (what they say) ----
{
    // n/a without the track's record (an older library)
    const bare = record({}, { lines: [line()] });
    eq('W: n/a without record.tracks.say', ['W1', 'W2', 'W4', 'W5', 'W6', 'W9', 'W11', 'W12', 'E3', 'E4'].map(id => metric(bare, id).value), Array(10).fill(null));
    const say = (lines, extra = {}) => record({}, { lines, tracks: { say: { keys: lines.map(l => M.normalized(l.text)), deathKeys: ['i died lol', 'got pked'], upstreamKeys: ['darkness overpowering', 'where did you level range'], talk: { said: { idle: 8, event: 2 }, specific: { idle: 3, event: 1 }, slots: 2, loneDropped: 5, responses: [{ t: 1, name: 'a', text: 'lol', cls: 'statement', after: ['statement'] }, { t: 2, name: 'b', text: 'Me too', cls: 'question', after: ['statement'] }] }, ...extra } } });
    // W1: a second death line for one death; not for a second death between
    const w1 = say([line({ t: 10, kind: 'event', text: 'got pked' }), line({ t: 30, kind: 'event', text: 'i died lol' }), line({ t: 100, name: 'b', kind: 'event', text: 'i died lol' }), line({ t: 400, name: 'b', kind: 'event', text: 'got pked' })]);
    w1.deaths = [{ t: 200, name: 'b' }];
    eq('W1: a second death line for one death (not after a second death)', metric(w1, 'W1').value, 1);
    // W2: a confused reply to a greeting, not to another line
    const w2 = say([line({ t: 1, name: 'a', text: 'Heyy kev :)' }), line({ t: 9, name: 'b', kind: 'botreply', toName: 'a', to: 'bot', text: '??' }), line({ t: 100, name: 'a', text: 'whats up with that' }), line({ t: 110, name: 'b', kind: 'botreply', toName: 'a', to: 'bot', text: 'huh' })]);
    eq('W2: confused replies to a bot\'s greeting', metric(w2, 'W2').value, 1);
    eq('W3: the share of responses that fit what they followed', metric(w2, 'W3').value, 50);
    // W4: by meaning, heard within the hour
    const w4 = record({}, { lines: [line({ t: 0, humanDist: 3, text: 'I love wc' }), line({ t: 100, humanDist: 3, text: 'i love woodcutting', name: 'b' }), line({ t: 200, humanDist: 3, text: 'lol' }), line({ t: 7000, humanDist: 3, text: 'I love wc' }), line({ t: 7100, humanDist: 3, text: 'I love wc', kind: 'reply' })], tracks: { say: { keys: ['i love woodcutting', 'i love woodcutting', 'lol', 'i love woodcutting', 'i love woodcutting'] } } });
    eq('W4: a repeat by meaning within the hour (a reflex line and an answer to the human apart; one after the hour none)', metric(w4, 'W4').value, M.pct(1, 3));
    // W5: alone: nobody within 15 tiles, the human farther
    const w5 = say([line({ near: 0 }), line({ near: 2 }), line({ near: 0, humanDist: 5 }), line({ kind: 'levelup', near: 0 }), line({ kind: 'trade', near: 0 })]);
    eq('W5: chatter said with nobody near (trade apart)', metric(w5, 'W5').value, 50);
    eq('W5: banded at 100 bots (12 % at most)', metric(w5, 'W5').ok, false);
    eq('W6: the chatter\'s specific lines over its idle and event lines', metric(w5, 'W6').value, 40);
    // W9: distinct bots per idle line (reflex apart)
    const w9 = say(['a', 'b', 'c', 'd'].flatMap(n => [line({ name: n, text: 'Darkness overpowering.' }), line({ name: n, text: 'lol' })]).concat([line({ name: 'e', text: 'Darkness overpowering.', kind: 'event' })]));
    eq('W9: the most bots one idle line came from (lol and an event line apart)', metric(w9, 'W9').value, 4);
    eq('W9: over 3 is out of band', metric(w9, 'W9').ok, false);
    // W11: a bot's upstream lines vs its 2004 lines, shorthand share
    const w11 = say([...['Darkness overpowering.', 'Where did you level range ?', 'Darkness overpowering.'].map(text => line({ text })), ...['need a better pick lol', 'u there', 'cutting willows'].map(text => line({ text }))]);
    eq('W11: the register gap in points (upstream 0 %, 2004 67 %)', metric(w11, 'W11').value, 66.7);
    // W12: non-trade lines in colour or with an effect
    const w12 = say([line({ colour: 3 }), line({ effect: 1 }), line(), line(), line({ kind: 'trade', colour: 2 })]);
    eq('W12: non-trade lines with a colour or an effect', metric(w12, 'W12').value, 50);
    // E3, E4: a vendor's adverts (task Vendor, idle, trade), even gaps vs uneven
    const ads = (s, ts, texts) => ts.map((t, i) => line({ s, t, name: `v${s}`, task: 'Vendor', state: 'idle', kind: 'trade', text: texts[i % texts.length] }));
    const e = say([...ads(1, [0, 10, 20, 30, 40, 50, 60], ['selling lobs 150 ea']), ...ads(2, [0, 5, 40, 45, 100, 102, 200, 7000], ['a', 'b', 'c', 'd', 'e', 'f'])]);
    eq('E3: the median seller\'s gap CV (an even 0, an uneven one above)', metric(e, 'E3').value > 0.4, true);
    eq('E4: distinct adverts per vendor-hour (a session advertising 1 h+: 6 in 1.17 h)', metric(e, 'E4').value, 5.1);
    // (2026-10-18) an auto typer keeps time: apart from E3's and E4's sellers, its CV in E3's detail
    const typerAds = ads(3, [0, 15, 30, 45, 60, 75, 90, 7200], ['selling coal 150 ea']).map(l => ({ ...l, typer: true }));
    const et = say([...ads(1, [0, 10, 20, 30, 40, 50, 60], ['selling lobs 150 ea']), ...ads(2, [0, 5, 40, 45, 100, 102, 200, 7000], ['a', 'b', 'c', 'd', 'e', 'f']), ...typerAds]);
    eq("E3, E4: an auto typer's adverts left out (the same values), its CV in E3's detail", [metric(et, 'E3').value === metric(e, 'E3').value, metric(et, 'E4').value, metric(et, 'E3').detail.includes('auto typers 1')], [true, 5.1, true]);
}
// ---- end of Track S's (variety) checks ----
// ---- Track W (what they wear) ----
{
    // a census: names by id; samples at two looks (t 200, 400)
    const names = { 1: 'iron_scimitar', 2: 'mithril_longsword', 3: 'steel_platebody', 4: 'leather_armour', 5: 'bluewizhat', 6: 'wizards_robe', 7: 'shortbow', 8: 'staff_of_air', 9: 'steel_axe', 10: 'bronze_axe', 11: 'chefs_hat', 12: 'rune_scimitar', 13: 'iron_pickaxe' };
    const w = (slots = {}) => {
        const out = new Array(14).fill(-1);
        for (const [s, i] of Object.entries(slots)) out[s] = i;
        return out;
    };
    const sample = (o = {}) => ({ t: 200, s: 1, n: 'a', p: 'fighter', w: w(), k: 'Combat', m: null, x: 3200, z: 3200, l: 0, cb: 30, nb: false, cls: null, ic: null, ...o });
    const samples = [
        // melee: two scimitars, a longsword, a PKer's scimitar (left out)
        sample({ n: 'a', w: w({ 3: 1, 4: 3 }) }),
        sample({ n: 'b', w: w({ 3: 1, 4: 3 }), x: 3205 }),
        sample({ n: 'c', w: w({ 3: 2 }), x: 3300 }),
        sample({ n: 'pk', p: 'extras_pker', w: w({ 3: 12 }), x: 3100, z: 3600 }),
        // a ranged fight: one in plate, one in leather; a magic fight: one robed, one not
        sample({ n: 'r1', k: 'RangedMagic', m: 'ranged', w: w({ 3: 7, 4: 3 }), x: 3000 }),
        sample({ n: 'r2', k: 'RangedMagic', m: 'ranged', w: w({ 3: 7, 4: 4 }), x: 3010 }),
        sample({ n: 'm1', k: 'RangedMagic', m: 'magic', w: w({ 0: 5, 3: 8, 4: 6 }), x: 3020 }),
        sample({ n: 'm2', k: 'RangedMagic', w: w({ 3: 8 }), x: 3030 }),
        // gathering: an axe in hand, a scimitar, a pickaxe; a newbie left out
        sample({ n: 'g1', p: 'skiller', k: 'Woodcut', w: w({ 3: 9 }), x: 2900 }),
        sample({ n: 'g2', p: 'skiller', k: 'Woodcut', w: w({ 3: 1 }), x: 2910 }),
        sample({ n: 'g3', p: 'skiller', k: 'Mine', w: w({ 3: 13 }), x: 2920 }),
        sample({ n: 'g4', p: 'skiller', k: 'Mine', nb: true, w: w({ 3: 10 }), x: 2930 }),
        // chef's hats: one at the range, one at the trees (a sample of its own at t 400)
        sample({ n: 'c1', p: 'skiller', k: 'Cook', w: w({ 0: 11 }), x: 2800 }),
        sample({ t: 400, n: 'c1', p: 'skiller', k: 'Woodcut', w: w({ 0: 11, 3: 9 }), x: 2800 }),
        // agility and firemaking: one in plate of three
        sample({ t: 400, n: 'ag', p: 'balanced', k: 'Agility', w: w({ 4: 3 }), x: 2700 }),
        sample({ t: 400, n: 'fm', p: 'balanced', k: 'Firemaking', w: w({}), x: 2710 }),
        sample({ t: 400, n: 'fm2', p: 'balanced', k: 'Firemaking', w: w({ 4: 4 }), x: 2720 }),
        // class names: 2 of 3 in their look, a newbie left out
        sample({ t: 400, n: 'wizard_tim', cls: 'mage', ic: true, x: 2600 }),
        sample({ t: 400, n: 'elf_archer', cls: 'ranger', ic: false, x: 2610 }),
        sample({ t: 400, n: 'pickaxe_pat', cls: 'miner', ic: true, x: 2620 }),
        sample({ t: 400, n: 'rogue_monk', cls: 'monk', ic: false, nb: true, x: 2630 })
    ];
    const rec = record({ ticks: 6100, warmup: 100 }, { tracks: { wear: { every: 200, names, samples } } });
    eq('L2: distinct outfits per 100 bots (each bot\'s last look: 20 bots, a and b alike, five bare)', metric(rec, 'L2').value, 75);
    eq('L2b: identical pairs in view an hour (a and b at t 200, three bare pairs at t 400; scaled to a look every 5 min)', metric(rec, 'L2b').value, 1.6);
    eq('L3: non-PK melee weapons that are scimitars (iron 2, longsword 1, the woodcutter\'s scimitar 1)', metric(rec, 'L3').value, 75);
    eq('L3b: kinds', metric(rec, 'L3b').value, 2);
    eq('L4: a ranged fight without a metal body', metric(rec, 'L4').value, 50);
    eq('L4b: a magic fight in a wizard hat or robe (the second by its staff)', metric(rec, 'L4b').value, 50);
    eq('L5: the tool in hand at the trees and rocks (no newbies; the chef at the trees too)', metric(rec, 'L5').value, 75);
    eq('L5b: a scimitar there', metric(rec, 'L5b').value, 25);
    eq("L5c: chef's hats at cooking", metric(rec, 'L5c').value, 50);
    eq('L7: class-named in their look (no newbies)', metric(rec, 'L7').value, 66.7);
    eq('L8: a metal body at Agility and Firemaking', metric(rec, 'L8').value, 33.3);
    eq('L8 out of band, L4 out, L3 out (above 70)', [metric(rec, 'L8').ok, metric(rec, 'L4').ok, metric(rec, 'L3').ok], [false, false, false]);
    const none = M.computeMetrics(record()).filter(m => m.group === 'wear');
    eq('W: n/a without the census', none.every(m => m.value === null), true);
    eq('W: weaponKindName', ['rune_2h_sword', 'adamnt_warhammer', 'dragon_dagger_p'].map(M.weaponKindName), ['2h_sword', 'warhammer', 'dagger_p']);
}
// ---- end of Track W's (variety) checks ----
// ---- (variety round 2, Track D2: new activities) checks ----
{
    for (const id of ['AM11', 'AF1', 'QA1', 'QA1b', 'MR1', 'HB1', 'WT1', 'TR1', 'ER1']) eq(`${id}: n/a without its record`, metric(record(), id).value, null);
    // (the round's kinds in round 1's groups: the chains feed crafting and cooking)
    eq('Track D2: the round\'s kinds in the 2004 mix\'s groups', ['Hides', 'Pottery', 'Flour', 'FireCook', 'Superheat', 'Feathers', 'WildTrip', 'WildMine'].map(k => M.ACTIVITY_GROUP[k]), ['combat', 'crafting', 'cooking', 'cooking', 'smithing', 'combat', 'combat', 'mining']);
    const fields = { wheat: { bots: 30, seen: 20 }, potatoes_west: { bots: 5, seen: 5 }, potatoes_east: { bots: 0, seen: 0 }, cabbages_draynor: { bots: 40, seen: 30 }, mill: { bots: 15, seen: 12 }, chicken_farm: { bots: 100, seen: 80 }, lumbridge_swamp: { bots: 10, seen: 10 } };
    const r = record({ bots: 100, members: true });
    r.tracks = {
        // 100 samples a 10 ticks (1000 ticks: 1/6 h), 100 online on average
        activities2: {
            sample: 10, samples: 100, online: 10000, levelling: 7000, low: 1000, lowChain: 200, lowKinds: { Hides: 100, Feathers: 60, Picking: 40, Combat: 500, Woodcut: 300 },
            kinds: { Herblore: 140, BoneRun: 60, Superheat: 30, Telegrab: 0, Enchant: 0 }, newbie: 500, newbieKinds: { Newbie: 300, Quest: 75, Feathers: 125 }, wild: 150, wildTrip: 120, wildBy: { WildTrip: 120, Combat: 30 },
            fields, questStarts: 2, questStartsBy: { cook: 1, sheep: 1 }, agility: [{ dist: 700, ticks: 150, rode: true }, { dist: 650, ticks: 900, rode: false }, { dist: 100, ticks: 80, rode: false }],
            lib: { errands: { started: { 'Quest:cook': 1, 'Quest:sheep': 1, 'Hides:lumbridge': 8 }, finished: { 'Quest:cook': 1, 'Hides:lumbridge': 7 }, failed: { 'Quest:sheep': 1, 'Hides:lumbridge': 1 }, failedAt: { 'Quest:sheep|wool': 1, 'Hides:lumbridge|fight': 1 }, rounds: {} }, talks: { talked: 5, missed: 1 }, travel: { asked: 3, taken: { 'trees-varrock-stronghold': 1 }, done: { 'trees-varrock-stronghold': 1 }, failed: {}, ticks: [130] }, wild: { trips: { skeletons: 2 }, shields: 0 }, lines: { said: 9, alone: 4, none: 0, byKind: {}, quest: 3 } }
        },
        d: { levellingSamples: 1000, groups: { cooking: 30, smithing: 10, crafting: 50 }, kinds: { Cook: 30, Smith: 10, Crafting: 50 }, byPlanner: {} }
    };
    const am11 = metric(r, 'AM11');
    eq('AM11: 200 of 1000 combat 3-20 samples in a chain = 20 % (in band 15-25)', [am11.value, am11.ok], [20, true]);
    const am1c = metric(r, 'AM1c');
    eq('AM1c: smithing 1 % outside 2-7, cooking 3 and crafting 5 in (one out)', [am1c.value, am1c.ok, am1c.detail.includes('smithing 1 % ✗')], [1, false, true]);
    const af1 = metric(r, 'AF1');
    eq('AF1: wheat 20 %, cabbages 30, mill 12, chicken farm 80, swamp 10 (5 of 7 at 10 %+, in band)', [af1.value, af1.ok], [5, true]);
    const qa1 = metric(r, 'QA1');
    eq('QA1: 2 started in 1/6 h at 100 online = 12 an hour per 100 (report)', [qa1.value, qa1.ok, qa1.detail.includes('finished 1 of 2')], [12, null, true]);
    const qa1b = metric(r, 'QA1b');
    eq("QA1b: 75 of 500 newcomers' samples = 15 % (in band 10-20)", [qa1b.value, qa1b.ok], [15, true]);
    eq('MR1: 90 run samples a 10 ticks = 0.15 bot-hours (report)', metric(r, 'MR1').value, 0.15);
    const hb1 = metric(r, 'HB1');
    eq('HB1: 140 of 7000 = 2 % (in band 1-4)', [hb1.value, hb1.ok], [2, true]);
    const wt1 = metric(r, 'WT1');
    eq('WT1: 150 levelling bot-samples in the Wilderness of 10000 = 1.5 per 100 online (in band 1-2)', [wt1.value, wt1.ok], [1.5, true]);
    const tr1 = metric(r, 'TR1');
    eq('TR1: the far agility plans (150 and 900 ticks): median 900 of the quantile (report), one by a ride', [tr1.value, tr1.detail.includes('1 by a ride')], [900, true]);
    const er1 = metric(r, 'ER1');
    eq('ER1: 2 of 10 errands failed = 20 % (out of band: at most 15)', [er1.value, er1.ok], [20, false]);
    eq('the round 2 activities group prints apart', M.GROUPS.activities2, 'New activities (variety round 2)');
}
// ---- end of Track D2's (variety) checks ----
// ---- (variety round 2, Track M: members places and minigames) checks ----
// ---- end of Track M's (variety) checks ----
// ---- (variety round 2, Track S2: conversation) checks ----
{
    const bare = record({}, { lines: [line()] });
    eq('S2: n/a without record.tracks.talk2', ['W7', 'W7b', 'W7c', 'W8', 'W10', 'W13', 'W14', 'W15'].map(id => metric(bare, id).value), Array(8).fill(null));
    const t2 = (lines, talk2 = {}) => record({}, { lines, tracks: { talk2: { deaths: [], mates: null, witness: [], threads: null, ...talk2 } } });
    // W7: exchanges by pair; content turns (acks apart); an opener the addressee's line just before
    eq('S2: isAckLine', ['k ty', 'oh ok thanks', 'gz m8', 'Sup', 'lol same', '41 u?', 'ya its sick'].map(M.isAckLine), [true, true, true, true, true, false, false]);
    const ex = t2([
        line({ t: 0, name: 'a', text: 'wc lvl?' }), line({ t: 10, name: 'b', to: 'bot', toName: 'a', kind: 'practice', text: '41 u?' }), line({ t: 20, name: 'a', to: 'bot', toName: 'b', kind: 'practice', text: '38 lol' }),
        line({ t: 500, name: 'c', kind: 'levelup', text: '40 wc!!' }), line({ t: 505, name: 'd', to: 'bot', toName: 'c', kind: 'botreply', text: 'gz' }), line({ t: 510, name: 'c', to: 'bot', toName: 'd', kind: 'botreply', text: 'ty' }),
        line({ t: 900, name: 'e', to: 'bot', toName: 'f', kind: 'setpiece', text: 'stake?' })
    ]);
    eq('W7: a 3-turn level compare is one of two exchanges of 3+ content turns (gz/ty and a set piece apart)', metric(ex, 'W7').value, 50);
    eq('W7: out of band at 50 % (20-40)', metric(ex, 'W7').ok, false);
    eq('W7b: the counter-question answered', metric(ex, 'W7b').value, 100);
    eq('S2: botExchanges groups a pair\'s lines within 150 ticks', M.botExchanges(ex).map(e => e.length), [3, 3]);
    // W8: a place-hour of 30+ lines from 5+ speakers: the top voice's share
    const loud = t2(Array.from({ length: 40 }, (_, i) => line({ t: i * 10, name: i < 12 ? 'loud' : `p${i % 6}`, hubs: ['draynor_bank'] })));
    eq('W8: the top voice\'s share of a busy place-hour (12 of 40; one place-hour: its p90)', metric(loud, 'W8').value, 30);
    eq('W8: over 25 % is out of band', metric(loud, 'W8').ok, false);
    const quiet = t2(Array.from({ length: 40 }, (_, i) => line({ t: i * 10, name: i % 2 ? 'a' : 'b', hubs: ['draynor_bank'] })));
    eq('W8: two talkers alone are no busy place (n/a)', metric(quiet, 'W8').value, null);
    // W10: deaths with company, a witness line about the victim within 100 ticks (20 before: the library sees the fall)
    const deaths = t2([line()], {
        deaths: [{ t: 1000, name: 'v1', company: 2 }, { t: 2000, name: 'v2', company: 1 }, { t: 3000, name: 'v3', company: 0 }, { t: 4000, name: 'v4', company: 3, arena: true }],
        witness: [{ t: 995, name: 'w', event: 'witness-death', about: 'v1' }, { t: 2300, name: 'w', event: 'witness-pk', about: 'v2' }, { t: 3005, name: 'w', event: 'witness-death', about: 'v3' }]
    });
    eq('W10: deaths with company that got a word (alone and at the arena apart; one too late)', metric(deaths, 'W10').value, 50);
    // W13: mates' talk an hour together
    eq('W13: lines between mates an hour together', metric(t2([line()], { mates: { together: 12000, lines: 8, greets: 5, banter: 4, threads: 4 } }), 'W13').value, 4);
    eq('W13: n/a under a quarter hour together', metric(t2([line()], { mates: { together: 1000, lines: 8 } }), 'W13').value, null);
    // W14: gear comments and show-offs an hour; W15: the human's reactions within a minute
    const w = t2([line()], { witness: [{ t: 10, event: 'witness-rare' }, { t: 20, event: 'show-off' }, { t: 100, event: 'react-dance' }, { t: 150, event: 'react-wild' }, { t: 400, event: 'react-death' }] });
    eq('W14: gear comments and show-off lines an hour (2 in an hour)', metric(w, 'W14').value, 2);
    eq('W15: the most reactions to the human within a minute (2: out of band)', [metric(w, 'W15').value, metric(w, 'W15').ok], [2, false]);
    eq('W7c: the engine\'s count of topics asked again', metric(t2([line()], { threads: { started: 3, repeats: 0, byTopic: { level: 2 }, bySource: { chatter: 3 }, fails: {} } }), 'W7c').value, 0);
}
// ---- end of Track S2's (variety) checks ----
// ---- (variety round 2, the fixes: B) checks ----
{
    // B2: an errand's word on the way (kind 'errand') is routine talk: chatter, in H7, not a set piece's line (X2)
    const r = record({}, {
        sessions: [{ s: 1, name: 'a', planner: 'skiller', first: 0, last: 5999, ended: false }],
        lines: [line({ t: 100, kind: 'errand', text: 'where do i get an egg' }), line({ t: 2500, kind: 'setpiece', text: 'trawler time' })],
        botTicks: 6000
    });
    eq("B2: an errand's line is chatter, not aside", [M.kindGroup('errand'), M.isAside({ kind: 'errand' })], ['chatter', false]);
    eq("B2: H7 counts the errand's line (1 an hour), X2 only the set piece's (1)", [metric(r, 'H7').value, metric(r, 'X2').value], [1, 1]);
    // B7: FT1 n/a on a free world (every far town and minigame it counts is members-only), a value on a members world
    const members = { samples: 10, online: 1000, farBots: 30, far: { burthorpe: 20, 'minigame:Trawler': 10 }, farKinds: { Trawler: 10 }, places: Object.fromEntries(['ardougne_market', 'falador_west_bank', 'seers_flax', 'seers_wheel', 'catherby'].map(k => [k, { n: 0, kinds: {} }])), outing: {}, minigame: {} };
    const ft = m => metric(record({ members: m }, { tracks: { members } }), 'FT1');
    eq('B7: FT1 n/a on a free world, 3 per 100 online on a members world', [ft(false).value, ft(true).value], [null, 3]);
}
// ---- end of the fixes' (B) checks ----
// ---- (variety round 2, Track W2: fashion) checks ----
{
    // a fashion census: items (debugname, members, status family), names (planner, tier, gender, hair), looks every 500 ticks
    const items = {
        1: { n: 'rune_platebody_gold', m: false, s: 'gold' },
        2: { n: 'rune_platebody', m: false, s: null },
        3: { n: 'red_partyhat', m: false, s: null },
        4: { n: 'viking_helmet_crush', m: true, s: null },
        5: { n: 'dragon_med_helm', m: true, s: null },
        6: { n: 'amulet_of_glory', m: true, s: null },
        7: { n: 'blessedstar', m: false, s: null },
        8: { n: 'rune_scimitar', m: false, s: null },
        9: { n: 'leather_boots', m: false, s: null }
    };
    const names = [
        { n: 'rich1', p: 'fighter', tier: 'veteran', g: 0, hair: null },
        { n: 'rich2', p: 'balanced', tier: 'experienced', g: 1, hair: 45 },
        { n: 'poor', p: 'skiller', tier: 'novice', g: 1, hair: 50 },
        { n: 'vend', p: 'extras_vendor', tier: 'veteran', g: 0, hair: null },
        { n: 'pk1', p: 'extras_pker', tier: 'newcomer', g: 0, hair: null },
        { n: 'pk2', p: 'extras_pker', tier: 'newcomer', g: 0, hair: null },
        { n: 'pk3', p: 'extras_pker', tier: 'newcomer', g: 0, hair: null },
        { n: 'soc', p: 'extras_social', tier: 'experienced', g: 0, hair: null }
    ];
    const w = (slots = {}) => {
        const out = new Array(14).fill(-1);
        for (const [sl, i] of Object.entries(slots)) out[sl] = i;
        return out;
    };
    // Varrock West's bank is a show hub (3185, 3441); the far place is not
    const look = (t, i, v, slots, at = [3185, 3441]) => ({ t, i, k: 'Combat', x: at[0], z: at[1], l: 0, w: w(slots), v });
    const samples = [
        // rich1: rich, in (g) at the hub then plain away; rich2: rich, never in status; poor: not rich, in (g) (not counted)
        look(500, 0, 200000, { 4: 1, 0: 3 }),
        look(1000, 0, 200000, { 4: 2 }, [3000, 3000]),
        look(500, 1, 90000, { 4: 2, 0: 4, 2: 6 }),
        look(1000, 1, 90000, { 4: 2 }),
        look(500, 2, 1000, { 4: 1 }),
        look(1000, 2, 1000, { 4: 1 }),
        // the vendor (never rich, its purse is its stock's) and a social veteran in status
        look(500, 3, 500000000, { 4: 1 }),
        look(500, 7, 0, { 4: 1, 2: 7 }),
        // PKers: two alike, one its own
        look(500, 4, 0, { 3: 8, 0: 5 }, [3100, 3600]),
        look(500, 5, 0, { 3: 8, 0: 5 }, [3100, 3600]),
        look(500, 6, 0, { 3: 8, 10: 9 }, [3100, 3600])
    ];
    const fashion = { every: 500, rich: 75000, items, names, samples, baldKit: 45, showOff: { visits: 3, dressed: 2, tried: 1, bought: 1, coins: 300000, items: { rune_platebody_gold: 1 } } };
    const rec = record({ ticks: 6100, warmup: 100, members: true }, { tracks: { fashion } });
    eq('L6: rich bots seen in a status piece (rich1 yes, rich2 no; the poor bot, the vendor and the PKers out)', metric(rec, 'L6').value, 50);
    eq('L6b: status, rares and dragon at the hubs an hour (rich1\'s (g) and partyhat, poor\'s (g) twice, the vendor\'s and social\'s (g): 6 in one hour)', metric(rec, 'L6b').value, 6);
    eq("L9: members-only wearables an hour (rich2's helm and glory; PKers' d meds left out)", metric(rec, 'L9').value, 2);
    eq('L10: PKers in an outfit of their own (2 outfits of 3 PKers)', metric(rec, 'L10').value, 66.7);
    eq('L11: bots in the novelty and show pieces (status: rich1, poor, vend, soc; holy symbol: soc; Fremennik helm: rich2)', metric(rec, 'L11').value, 5);
    eq('L12: women in the bald head (rich2 of 2 women)', metric(rec, 'L12').value, 50);
    eq('L10 out of band (under 70), L6 in band (12-30)? 50 is out', [metric(rec, 'L10').ok, metric(rec, 'L6').ok], [false, false]);
    const free = record({ ticks: 6100, warmup: 100, members: false }, { tracks: { fashion } });
    eq('L9: n/a on a free world', metric(free, 'L9').value, null);
    const none = M.computeMetrics(record()).filter(m => m.group === 'fashion');
    eq('W2: n/a without the census', none.every(m => m.value === null), true);
}
// ---- end of Track W2's (variety) checks ----

// ---- the whole report ----
{
    const empty = M.computeMetrics(M.emptyRecord({ bots: 100, ticks: 6000 }));
    eq('an empty record: every metric there', empty.length, M.METRICS.length);
    eq('an empty record: nothing judged but the zero counts', empty.filter(m => m.ok !== null).map(m => m.id), ['H21']);
    eq('ids are unique', new Set(M.METRICS.map(m => m.id)).size, M.METRICS.length);
    eq('every metric has a group, a basis and a function', M.METRICS.every(m => M.GROUPS[m.group] && ['sourced', 'decided', 'proposed', 'report'].includes(m.basis) && typeof m.fn === 'function'), true);
    const r = record();
    r.hubs.falador_park = { samples: 10, bots: 1, empty: 9, max: 1, social: 0 };
    const a = M.computeMetrics(r);
    eq('the fingerprint repeats', M.fingerprint(a), M.fingerprint(M.computeMetrics(r)));
    r.hubs.falador_park.empty = 8;
    eq('and changes with a value', M.fingerprint(a) !== M.fingerprint(M.computeMetrics(r)), true);
    const text = M.formatMetrics(a).join('\n');
    eq('the printout marks ✗ and n/a', [text.includes('✗ H1'), text.includes('– H6'), text.includes('Where the crowd is')], [true, true, true]);
    eq('band texts', [M.bandText({ max: 40 }, '%'), M.bandText({ min: 4, max: 10 }, ''), M.bandText({ max: 0 }, ''), M.bandText({ min: 1.3 }, ''), M.bandText(null)], ['≤ 40 %', '4-10', '0', '≥ 1.3', 'report']);
}

console.log(`humanlike metrics: ${checks} checks on synthetic records, ${M.METRICS.length} metrics`);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(failures.length ? `${failures.length} failed` : 'ok   every metric gives the hand-computed value, band and mark');
process.exit(failures.length ? 1 : 0);
