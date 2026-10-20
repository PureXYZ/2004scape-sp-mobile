#!/usr/bin/env node
// data/names.json and the roster (port/BotRoster, BOTS.md §4.6):
//   names   at least 150; letters, digits and single spaces, at most 12 characters (a base37 name); shown in game
//           exactly as written (the engine's toDisplayName and the webclient's toScreenName); unique as the engine
//           stores them; no NPC's name (a player saying "bob" means the NPC); nothing offensive or impersonating
//           staff, no buying/selling prefix (and nothing the game's word filter changes: test/chat-filter.test.mjs);
//   pool    names[i] has PLANNERS[i % 8]; the pool for N online (25/50/100/250/500/750/1000) is every saved bot plus the first
//           unused names up to 2N, with every planner; a name a human has or one that quit is never in it; newcomers
//           take the next unused names with a levelling planner, nothing is used twice; at 500 online (a pool of 1,000)
//           there are names for 100+ hours of newcomers, at 1,000 online (a pool of 2,000) a name per bot online.
//
//   lock    append only: the names in test/ref/names.lock are still the first ones, in order (a bot is its name: its save
//           and its planner, names[i % 8], go with it). After appending: --update-lock
//
//   node web/engine/bots/test/names.test.mjs [--update-lock]
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, WEBCLIENT_DIR, importTs } from './lib/paths.mjs';
import { importInEngine } from './lib/clone.mjs';

const raw = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/names.json'), 'utf8')).names;
const { default: ClientJString } = await importTs(path.join(WEBCLIENT_DIR, 'src/datastruct/JString.ts'));
const lib = await importInEngine(path.join(BOTS_DIR, 'test/lib/names.ts'), 'unit-names');
const npcs = lib.npcNames('data/pack');

const failures = [];
const check = (what, ok, detail = '') => {
    if (!ok) failures.push(`${what}${detail ? `: ${detail}` : ''}`);
};

// ---- names ----
const BANNED = ['88', '14', '420', '69', '1337', 'jagex', 'mod', 'admin', 'staff', 'zezima', 'durial', 'buy', 'sell', 'nazi', 'hitler', 'sex', 'fuck', 'shit'];
check('at least 150 names', raw.length >= 150, `${raw.length}`);
const seen = new Map();
for (const name of raw) {
    const where = `'${name}'`;
    check(`${where}: letters, digits and single spaces`, typeof name === 'string' && /^[A-Za-z0-9]+( [A-Za-z0-9]+)*$/.test(name));
    check(`${where}: at most 12 characters`, name.length <= 12, `${name.length}`);
    check(`${where}: the engine shows it as written`, lib.toDisplayName(name) === name, lib.toDisplayName(name));
    const screen = ClientJString.toScreenName(ClientJString.toRawUsername(ClientJString.toUserhash(name)));
    check(`${where}: the webclient shows it as written`, screen === name, screen);
    const stored = lib.normalizeBotName(name);
    check(`${where}: unique`, !seen.has(stored), `same as '${seen.get(stored)}'`);
    seen.set(stored, name);
    check(`${where}: not an NPC's name`, !npcs.has(name.toLowerCase()));
    const flat = name.toLowerCase().replaceAll(' ', '');
    const banned = BANNED.filter(b => flat.includes(b));
    check(`${where}: nothing banned`, banned.length === 0, banned.join(', '));
}
check('BOT_NAMES is names.json as the engine stores the names', lib.BOT_NAMES.length === raw.length && raw.every((n, i) => lib.BOT_NAMES[i] === lib.normalizeBotName(n)));

// ---- append only ----
const LOCK = path.join(BOTS_DIR, 'test/ref/names.lock');
const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
const sha = names => crypto.createHash('sha256').update(names.join('\n')).digest('hex');
const kept = raw.length >= lock.count && sha(raw.slice(0, lock.count)) === lock.sha256;
check(`append only: the ${lock.count} names of test/ref/names.lock are the first, in order`, kept, `${raw.length} names now; a name was changed, removed or moved (names are only ever added at the end)`);
if (kept && process.argv.includes('--update-lock') && raw.length > lock.count) {
    fs.writeFileSync(LOCK, JSON.stringify({ ...lock, count: raw.length, sha256: sha(raw) }, null, 4) + '\n');
    console.log(`names.lock: ${lock.count} -> ${raw.length} names`);
}

// ---- the pool (port/BotRoster: about 2N known bots for N online, newcomers after them) ----
const P = lib.PLANNERS;
const N = lib.BOT_NAMES.length;
const none = () => false;
const all = () => true;
check('at most 1000 online', lib.ROSTER_SLOTS === 1000);
check('names[i] has PLANNERS[i % 8]', lib.BOT_NAMES.every((n, i) => lib.plannerOf(n) === P[i % P.length]));
check('plannerOf a name that is not a bot\'s is null', lib.plannerOf('Not A Bot Zz') === null);
check('levelling planners', P.filter(p => lib.isLevelling(p)).join(',') === 'skiller,fighter,balanced,random');
for (const n of [10, 25, 50, 100, 250, 500, 750, 1000]) {
    check(`a pool for ${n} online is ${Math.min(2 * n, N)}`, lib.poolSize(n) === Math.min(2 * n, N), `${lib.poolSize(n)}`);
    const { entries, reserved } = lib.initialPool(n, [], all, none);
    const planners = new Set(entries.map(e => e.planner));
    const groups = p => entries.filter(e => e.planner === p).length;
    // the role mix: the extras (vendors, social bots, both kinds of PKers) take twice their share of the
    // places (7.5 % each: 15 % of N, 7.5 % of the pool each), the rest of the pool is levelling bots, in list order
    const roles = P.filter(p => !lib.isLevelling(p));
    check(`a new pool for ${n}: ${lib.poolSize(n)} names in list order, the extras at twice their share`, entries.length === lib.poolSize(n) && entries.every((e, i) => i === 0 || entries[i - 1].slot < e.slot) && roles.every(p => groups(p) === Math.ceil(2 * lib.onlineShare(n, p))) && reserved.length === 0, P.map(p => `${p} ${groups(p)}`).join(', '));
    check(`a pool for ${n} has every planner`, P.every(p => planners.has(p)), [...planners].join(', '));
    // online: 70 % to the levelling planners (17.5 % each), 30 % to the extras (7.5 % each), at every size
    const shares = P.map(p => lib.onlineShare(n, p));
    check(`${n} online: the planners' shares add up to ${n}, 17.5 % each levelling planner and 7.5 % each extra`, Math.abs(shares.reduce((a, b) => a + b, 0) - n) < 1e-9 && P.every((p, i) => Math.abs(shares[i] - n * (lib.isLevelling(p) ? lib.LEVELLING_SHARE : 1 - lib.LEVELLING_SHARE) / 4) < 1e-9), shares.map(x => x.toFixed(1)).join(', '));
}
check('more than 1000 online is 1000', lib.poolSize(2000) === lib.poolSize(1000) && lib.poolSize(1000) === 2000, `${lib.poolSize(2000)}`);
check('0 online is no pool', lib.poolSize(0) === 0 && lib.initialPool(0, [], all, none).entries.length === 0);

// a store saved by the fixed roster of 25 (names[0..24]) and a bot backfilled from the end of the list
{
    const saved = [...lib.BOT_NAMES.slice(0, 25), lib.BOT_NAMES[N - 1], 'gone_name'];
    const { entries } = lib.initialPool(25, saved, all, none);
    const names = entries.map(e => e.name);
    check('the saved bots are all in the pool', saved.slice(0, 26).every(n => names.includes(n)));
    // (in list order, an extra group past twice its share skipped: the saved ones count; 4 each at 25 online)
    const atCap = p => !lib.isLevelling(p) && entries.filter(e => e.planner === p).length >= Math.ceil(2 * lib.onlineShare(25, p));
    const lastFresh = Math.max(...entries.filter(e => !saved.includes(e.name)).map(e => e.slot));
    const skipped = lib.BOT_NAMES.slice(0, lastFresh).filter(n => !names.includes(n));
    check('the pool is filled up with the first unused names (an extra past twice its share skipped)', entries.length === 50 && skipped.every(n => atCap(lib.plannerOf(n))), `${entries.length} names; skipped ${skipped.length}: ${skipped.slice(0, 4).join(', ')}`);
    check('a saved name that is not a bot name is left out', !names.includes('gone_name'));
    check('a backfilled bot keeps its name and gets its own planner', entries.find(e => e.name === lib.BOT_NAMES[N - 1])?.planner === P[(N - 1) % P.length]);
    check('the pool is in list order', entries.every((e, i) => i === 0 || entries[i - 1].slot < e.slot));
    const big = lib.initialPool(10, lib.BOT_NAMES.slice(0, 50), all, none);
    check('a pool keeps every saved bot even when N went down', big.entries.length === 50);
}
// a store saved under the first mix (an eighth each: the first 100 names at 50 online): the levelling groups are short
// of 70 % of the places, so each takes fresh names of its own up to one short of its place in the pool (17.5 % of it,
// rounded down: 17); the extras keep theirs (they are the first to quit: BotManager._quitOne)
{
    const saved = lib.BOT_NAMES.slice(0, 100);
    const { entries, topUp } = lib.initialPool(50, saved, all, none);
    const names = new Set(entries.map(e => e.name));
    const count = p => entries.filter(e => e.planner === p).length;
    const fresh = entries.filter(e => !saved.includes(e.name));
    check('an old-mix store: every saved bot stays', saved.every(n => names.has(n)));
    check(`an old-mix store: the top-up is counted (${topUp}: what BotManager sheds)`, topUp === entries.length - saved.length && topUp > 0, `${topUp} of ${entries.length}`);
    check(
        'an old-mix store: each levelling group is topped up to one short of its place (16), with its own fresh names; the extras as saved',
        P.every(p => (lib.isLevelling(p) ? count(p) === Math.floor(lib.poolShare(50, p)) - 1 : count(p) === saved.filter(n => lib.plannerOf(n) === p).length)) && fresh.every(e => lib.isLevelling(e.planner) && e.slot >= 100),
        `${P.map(p => `${p} ${count(p)}`).join(', ')}; ${fresh.length} fresh`
    );
    check('an old-mix store: the extras are past their cap (8): they quit first', P.filter(p => !lib.isLevelling(p)).every(p => count(p) > lib.groupCap(50, p)), P.map(p => `${p} ${count(p)}/${lib.groupCap(50, p)}`).join(', '));
}
// no top-up in a new pool: a group's place rounded down is never more than it gets (every N up to 1000)
{
    const over = [];
    for (let n = 1; n <= 1000; n++) {
        const { entries, topUp } = lib.initialPool(n, [], all, none);
        if (entries.length !== lib.poolSize(n) || topUp !== 0) over.push(`${n}: ${entries.length} (${topUp} topped up)`);
    }
    check('a new pool is poolSize(N) for every N up to 1000 (no top-up past it)', over.length === 0, over.slice(0, 6).join(', '));
}
// a human has names[3] and names[30]; names[5] quit
{
    const human = new Set([lib.BOT_NAMES[3], lib.BOT_NAMES[30]]);
    const quit = new Set([lib.BOT_NAMES[5]]);
    const { entries, reserved } = lib.initialPool(25, [lib.BOT_NAMES[3], lib.BOT_NAMES[5]], n => !human.has(n), n => quit.has(n));
    const names = entries.map(e => e.name);
    check('a name a human has is not in the pool', !names.includes(lib.BOT_NAMES[3]) && !names.includes(lib.BOT_NAMES[30]));
    check('the names a human has are reported', reserved.length === 2 && reserved.every(n => human.has(n)), reserved.join(', '));
    check('a bot that quit never comes back, saved or not', !names.includes(lib.BOT_NAMES[5]) && !reserved.includes(lib.BOT_NAMES[5]));
    check('the pool is still full', entries.length === 50 && new Set(names).size === 50);
    check('with every name a human\'s there is no pool', lib.initialPool(100, [], none, none).entries.length === 0);
}
// newcomers: the first unused name with a levelling planner, never twice
{
    const used = new Set(lib.initialPool(25, [], all, none).entries.map(e => e.name));
    const source = new lib.NameSource(n => used.has(n));
    const before = source.remaining();
    const taken = [];
    for (let i = 0; i < 12; i++) taken.push(source.take());
    check('newcomers come after the pool, in list order', taken.every((e, i) => e && e.slot >= 50 && (i === 0 || taken[i - 1].slot < e.slot)), taken.map(e => e?.slot).join(','));
    check('newcomers are levelling bots', taken.every(e => e && lib.isLevelling(e.planner) && e.planner === P[e.slot % P.length] && e.newcomer === true));
    check('newcomers skip used names', taken.every(e => !used.has(e.name)));
    check('remaining() counts down', source.remaining() === before - 12, `${before} → ${source.remaining()}`);
    check('no names left: null', new lib.NameSource(all).take() === null && new lib.NameSource(all).remaining() === 0);
    // newcomers come about twice an hour of play: at 100 online (a pool of 200) at least 100 hours' worth
    const pool100 = new Set(lib.initialPool(100, [], all, none).entries.map(e => e.name));
    const left100 = new lib.NameSource(n => pool100.has(n)).remaining();
    check(`names for 100+ hours of newcomers at 100 online (${left100}; ${before} at 25)`, left100 >= 200, `${left100}`);
    const pool500 = new Set(lib.initialPool(500, [], all, none).entries.map(e => e.name));
    const left500 = new lib.NameSource(n => pool500.has(n)).remaining();
    check(`names for 100+ hours of newcomers at 500 online (${left500})`, pool500.size === 1000 && left500 >= 200, `${pool500.size} in the pool, ${left500} left`);
    // 1,000 online (a pool of 2,000): the newcomer clock scales with N (5-10 level-3s about Lumbridge per 100 online),
    // so a name left per bot online (500 online had 700 before the names for 750 and 1000)
    const pool1000 = new Set(lib.initialPool(1000, [], all, none).entries.map(e => e.name));
    const left1000 = new lib.NameSource(n => pool1000.has(n)).remaining();
    check(`names for newcomers at 1000 online (${left1000}), a name per bot online`, pool1000.size === 2000 && left1000 >= 1000, `${pool1000.size} in the pool, ${left1000} left (${left500} at 500)`);
}

console.log(`names: ${raw.length} names, checked against the engine's and the webclient's name functions and ${npcs.size} NPC names; pools for 10/25/50/100/250/500/750/1000 online, saved bots, reserved and quit names, newcomers`);
if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`${failures.length} failure(s)`);
    process.exit(1);
}
console.log('ok');
