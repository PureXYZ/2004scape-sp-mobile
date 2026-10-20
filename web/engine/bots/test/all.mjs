#!/usr/bin/env node
// Every check of the bot library, one process each (each test that needs the engine makes its own scratch clone under
// build/tmp/bots and removes it again):
//   tsc -p web/engine/bots, worker safety, names and the pool, inventory vs 254, pathing, the walking graph, content
//   names, a short world simulation (10 bots, 600 ticks), determinism (two seeded runs end the same), a crowd of 100
//   bots around the player, chat, what bots say unprompted (lines.test), PKers, PK tactics (pkfight.test), trade, the economy (economy.test: street
//   prices, rares, stock by trade bank, adverts; realism phase 4), ageing, personas and human timing,
//   habits (breaks, leaving, timing in a 40-bot world), social life (regulars, lures, friend cliques in a 60-bot world),
//   the humanlike report's measures (synthetic records), own tiles and hang-outs (tiles.test, hangout.test: realism
//   phase 3), the living world (churn.mjs: 10 online, 3000 ticks) and arrivals and sessions (arrivals.test.mjs: near you
//   first, the session draw, newbies by levels, the newcomer clock, a restart) and looks (looks.test.mjs: realism phase 4,
//   2004 bodies, patchwork gear, rares and veterans, no plate at a skill). --full adds the task coverage runs on
//   a members and a free world, the long simulations (25 bots × 3000 ticks on both, 100 bots × 1000 ticks), an aged
//   world of 50 bots × 3000 ticks on both, the living world at 25 (both world types), 50, 100, 500 and 1000 online, near you
//   first at 500 online (its burst), the newcomer clock at 1x and 10x XP, a crowd
//   of 250 (the most the engine lists around a player) and the humanlike report on an aged living world (100 online ×
//   6000 ticks, members: warn only, it fails only on a crash or an error).
//
//   node web/engine/bots/test/all.mjs [--full]
import { spawnSync } from 'child_process';
import path from 'path';
import { BOTS_DIR, BOTS_TSCONFIG, ENGINE_DIR } from './lib/paths.mjs';

const FULL = process.argv.includes('--full');
const test = file => path.join(BOTS_DIR, 'test', file);
const sim = (...args) => ['--expose-gc', test('sim.mjs'), ...args];
const churn = (...args) => ['--expose-gc', test('churn.mjs'), ...args];
const STEPS = [
    ['tsc', [path.join(ENGINE_DIR, 'node_modules/typescript/bin/tsc'), '-p', BOTS_TSCONFIG]],
    ['worker safety', [test('worker-safety.test.mjs')]],
    ['names and roster', [test('names.test.mjs')]],
    ['inventory vs 254', [test('inventory.test.mjs')]],
    ['pathing', [test('pathing.test.mjs')]],
    ['walking graph (the data on the map, routes, walks past walls and fences)', ['--expose-gc', test('walkgraph.test.mjs')]],
    ['content names', [test('content-names.test.mjs')]],
    ['knowledge vs the map (every step has something to do in reach)', [test('knowledge.test.mjs')]],
    ['world sim 10 × 600', sim('--bots=10', '--ticks=600')],
    ['the same seed gives the same world (two runs)', [test('determinism.test.mjs')]],
    ['crowd of 100', sim('--scenario=crowd', '--bots=100', '--ticks=120')],
    ['chat lines through the word filter', [test('chat-filter.test.mjs')]],
    ['lines: tags, gating, the repetition registry, the style layer, level-up forms, PK subsets', [test('lines.test.mjs')]],
    ['chat: market, conversations, come here', [test('chat.test.mjs')]],
    ['PKers and gates (free world gear, target claims, NPC claims, gate predicate)', [test('pk.test.mjs')]],
    ['PK tactics (kits, the KO switch on the fast tick, potions, eating, getting out, Edgeville fights)', ['--expose-gc', test('pkfight.test.mjs')]],
    ['trade', [test('trade.test.mjs')]],
    ['economy (street prices, rares singly from real levels, stock by trade bank, adverts and nicknames, a vendor\'s look; realism phase 4)', ['--expose-gc', test('economy.test.mjs')]],
    ['ageing (same name same age, tier shares, levels, free worlds, start tiles, InitTask after it)', [test('age.test.mjs')]],
    ['personas and human timing (same name same persona, shares, charset, typing and reaction times)', [test('persona.test.mjs')]],
    ['habits (breaks, lingers, a look, re-target pauses, bank stops, leaving like a player, PKers lurking)', ['--expose-gc', test('habits.test.mjs')]],
    ['social life (regulars at their hubs, a lure end to end, friend cliques: log in, train, travel, greet, leave, PK together)', ['--expose-gc', test('social.test.mjs')]],
    ['humanlike report: its measures on synthetic records', [test('humanlike-metrics.test.mjs')]],
    ['own tiles, hang-out spots, the path searches\' level of detail (realism phase 3)', [test('tiles.test.mjs')]],
    ['hang-outs (the park, the square, the banks: a tile each, not away, never two in a row) in a 40-bot world', ['--expose-gc', test('hangout.test.mjs')]],
    ['living world 10 online × 3000', churn('--bots=10', '--ticks=3000')],
    ['arrivals and sessions (near you first, heavy-tailed sessions, newbies by levels, the newcomer clock, a restart)', ['--expose-gc', test('arrivals.test.mjs')]],
    ['looks (2004 bodies, patchwork gear, rares and veterans; no plate at a skill; a newcomer in the design screen\'s clothes: realism phase 4)', ['--expose-gc', test('looks.test.mjs')]],
    ['teleport spells, alching, wrong turns (realism phase 5a, track M)', ['--expose-gc', test('teleport.test.mjs')]],
    ['texture: the danger map, misclicks, forgotten food, the danger check, kill- and rock-stealing, rude replies (realism phase 5a, track F)', ['--expose-gc', test('texture.test.mjs')]],
    ['random events near the human (realism phase 5a, track E)', ['--expose-gc', test('randomevents.test.mjs')]],
    ['set pieces: the registry, roles, the twelve emotes, the crown, the human\'s lines, an item used on a player (realism phase 5b)', ['--expose-gc', test('setpieces.test.mjs')]],
    ['the director: about one event an hour, where the bots are (realism phase 5b, track D)', ['--expose-gc', test('director.test.mjs')]],
    ['clan walks, PK team raids, newbie trains (realism phase 5b, track D)', ['--expose-gc', test('groups.test.mjs')]],
    ['drop parties and the Seers\' Party Room (realism phase 5b, track P)', ['--expose-gc', test('party.test.mjs')]],
    ['scam callers and lures (realism phase 5b, track P)', ['--expose-gc', test('scams.test.mjs')]],
    ['the Duel Arena and the player-mod bot (realism phase 5b, track A)', ['--expose-gc', test('duel.test.mjs')]],
    ['the language model\'s seam: situations, prompts, the guard (realism phase 7)', ['--expose-gc', test('model.test.mjs')]],
    ['fixes and movement (the stuck check and the path budget at a fill, futile bank loops, waiting at a taken rock or tree, dungeon legs, the watchdog near the spot, parties, trains, stakes, alching at banks; variety round 1, track F)', ['--expose-gc', test('fixes.test.mjs')]],
    ['what and where (spot capacity and occupancy, the 2004 mix, favourites from the name, carrying on after a relog, the new spots and activities; variety round 1, track D)', ['--expose-gc', test('activities.test.mjs')]],
    ['what they say (one death line, greetings, responses, the meaning key, talk with company, repertoires, register, slots, topic families, chat effects, vendors\' cadence; variety round 1, track S)', ['--expose-gc', test('talk.test.mjs')]],
    ['what they wear (combat styles and their ladders, weapon taste, skill clothes and tools in hand, plate off for agility and firemaking, class names, loot that is no upgrade; variety round 1, track W)', ['--expose-gc', test('outfits.test.mjs')]],
    ['new activities (the low-level economy chains, herblore, prayer and magic trips, Wilderness trips, travel by spirit tree and glider, quest look-alikes; variety round 2, track D2)', ['--expose-gc', test('errands.test.mjs')]],
    ['members places and minigames (the far budget scaled with N, far-town outings, Yanille\'s watchmen upstairs, the Shilo cart, the Ranging Guild, the Fishing Trawler\'s crews, the Brimhaven Agility Arena, a Treasure Trail from a real clue; variety round 2, track M)', ['--expose-gc', test('minigames.test.mjs')]],
    ['conversation (topic threads with pair memory, the social approach v2 and one voice\'s share, witnesses and reactions, clique banter, gear comments; variety round 2, track S2)', ['--expose-gc', test('threads.test.mjs')]],
    ['fashion (status gear, members fashion of late 2004, PK outfit variety, novelty pieces, clique colours; variety round 2, track W2)', ['--expose-gc', test('fashion.test.mjs')]],
    ...(FULL
        ? [
              ['coverage, members world', sim('--scenario=coverage', '--ticks=2500')],
              ['coverage, free world', sim('--scenario=coverage', '--ticks=2500', '--members=false')],
              ['world sim 25 × 3000', sim('--bots=25', '--ticks=3000')],
              ['world sim 25 × 3000, free world', sim('--bots=25', '--ticks=3000', '--members=false')],
              ['world sim 100 × 1000', sim('--bots=100', '--ticks=1000')],
              ['aged world 50 × 3000', sim('--scenario=aged', '--bots=50', '--ticks=3000')],
              ['aged world 50 × 3000, free world', sim('--scenario=aged', '--bots=50', '--ticks=3000', '--members=false')],
              ['living world 25 online × 6000', churn('--bots=25', '--ticks=6000')],
              ['living world 25 online × 5000, free world', churn('--bots=25', '--ticks=5000', '--members=false', '--seed=3')],
              ['living world 50 online × 4000, a store saved under the first role mix', churn('--bots=50', '--ticks=4000', '--seed=2', '--old-mix')],
              ['living world 100 online × 3000', churn('--bots=100', '--ticks=3000', '--seed=4')],
              ['crowd of 250', sim('--scenario=crowd', '--bots=250', '--ticks=120')],
              ['living world 500 online × 2000', churn('--bots=500', '--ticks=2000', '--seed=5')],
              ['living world 1000 online × 1500', churn('--bots=1000', '--ticks=1500', '--seed=6')],
              ['near you first at 500 online (the burst)', ['--expose-gc', test('arrivals.test.mjs'), '--burst=500']],
              ['arrivals: the newcomer clock at 1x and 10x XP', ['--expose-gc', test('arrivals.test.mjs'), '--cadence']],
              ['humanlike report, aged living world 100 × 6000 (warn-only)', ['--expose-gc', test('humanlike.mjs'), '--bots=100', '--ticks=6000', '--members=true']]
          ]
        : [])
];

let failed = 0;
for (const [name, args] of STEPS) {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const seconds = ((performance.now() - t0) / 1000).toFixed(1);
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter(l => l && !l.includes('ExperimentalWarning') && !l.includes('--trace-warnings'));
    if (r.status === 0) {
        const summary = output.filter(l => !/^\s*(ok|FAIL)\b/.test(l) && !/\b(INFO|DEBUG)\b/.test(l))[0] ?? '';
        console.log(`ok    ${name} (${seconds} s)${summary ? `  ${summary}` : ''}`);
    } else {
        failed++;
        console.log(`FAIL  ${name} (${seconds} s, exit ${r.status})`);
        for (const l of output.filter(l => /FAIL|Error|error/.test(l)).slice(0, 15)) console.log(`        ${l}`);
    }
}
console.log(failed ? `${failed} of ${STEPS.length} failed` : `all ${STEPS.length} passed`);
process.exit(failed ? 1 : 0);
