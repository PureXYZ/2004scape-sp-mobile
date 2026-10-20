#!/usr/bin/env node
// The humanlike report (BOTS.md §7, "Humanlike report"): how realistic the bots look and sound to a human player. The
// real rev-274 world, headless (a scratch clone, as test/sim.mjs), run the way the app runs it:
//   - a new bot store with ages (ageNewBots, as runtime/bots/index.ts passes for every store): mixed levels;
//   - the living world's real sessions (port/BotSessions DEFAULT_TIMING: 5 min-6 h online, heavy-tailed since the realism
//     work's phase 3, 10 min-1.5 h away, newcomers by the level-3s about Lumbridge, quits; a login's bots near the human
//     first), a login thread that acknowledges logouts and keeps the saves (bots come back), the replies
//     arriving on a microtask after each tick as in the worker. (isFriendOfHuman is left out: the human has no
//     friends here, and with it BotChat.tickOpeners only draws dice. So the same seed gives the research observer's
//     world: the research.)
//   - the bots' content overlay, as the app puts it in place (test/lib/botscontent.ts: a bot keeps its items when it dies,
//     a bot answers a trade request; --overlay=false runs the vanilla scripts, as the research observer did);
//   - one human: on a tour of the 2004 hubs (default: 15 stops, 600 ticks = 6 min each, the research observer's), or
//     standing at one (--tour=still --at=HUB), with levels in the 30s so monsters mostly leave it alone.
// It records what a human sees and hears (lib/humanlike-metrics.mjs has the measures, their bands and the sources):
// 34 vantage points with the client's 15-tile view every 5 ticks (who is there, stacked, social bots), every public
// line (speaker, task and state, place, the line's kind, the text as the 274 client shows it), the PMs and game
// messages the human gets, logins and logouts, deaths, jumps, every bot's stands, walks and targets (reaction gaps,
// cadence, bank stops, idle stands), XP, and the bots' looks every 100 ticks (since the realism work's phase 4 also the
// rares and holiday items in view at the vantage points and of the human: L1; and each vendor's stocking: its item and
// ask, for E1 against data/street_prices.json). Then it prints each metric with its value, its target band and ✓/✗.
//
//   node --expose-gc web/engine/bots/test/humanlike.mjs [--bots=100] [--ticks=6000] [--seed=1] [--members=true|false]
//        [--xprate=1] [--tour[=TICKS] | --tour=still [--at=HUB]] [--probe=N] [--talk=N] [--newchar] [--warmup=100]
//        [--json=FILE] [--lines=FILE] [--logouts=FILE] [--hubs] [--strict] [--max-errors=N] [--overlay=false] [--no-details]
//
//   --probe=N   every N ticks the human steps next to a bot, addresses it by name with a typical 2004 line and PMs another
//               bot (the tour stops: it goes where the bots are); H13-H15 (answers) need it, or --talk
//   --talk=N    every N ticks a public line to nobody ("hi", "how do i get to varrock", "buying iron ore"...): T1, M1
//   --newchar   a new character at tick 20 (BotManager.newCharacter: its newcomers come to the courtyard)
//   --warmup=N  the vantage points start after N ticks (the world fills at 5 bots a tick)
//   --json=FILE the report (metrics, details, every place's numbers, examples); --lines=FILE every line as JSON lines;
//   --logouts=FILE every logout as JSON lines (its task, tile, a goodbye before it, at a bank)
//   --hubs      print every place's numbers too (bots in view, empty, social bots, lines a minute)
//   --strict    exit 1 if a metric is out of its band (default: warn only)
//   --max-errors=N  exit 1 above N errors (default 0, as the world sims): an engine script error counts once (not its
//               6-8 lines), a bot error once (port/BotLog counts it)
//   --cliques=off   (phase 3, track C) the friend cliques exist but do nothing together (port/BotCliques'
//               setCliqueBehaviourForTest): G1's chance level
//   --rune-seed=false  (phase 5a, Track M) new bots get no runes (port/BotAge.magicKit): a world as saved bots have it
//               (no top-up), for TP1-TP3 and AL1 there
//   --work[=N]  (realism phase 5a, track F) the probe human works: it fights cows in Lumbridge's east field, then mines at
//               Varrock East's mine, N ticks each (default 1000: 10 minutes), in turns (the tour stops): R1h (kill-steals
//               on the human) and the miners' courtesy (R2's detail)
//   --director-first=N  (realism phase 5b, Track D) the director's first event N play ticks in (the game's: 20-50 minutes);
//               --director-kind=K[,K] its kind (clan_walk, pk_raid, drop_party ...: when one can run); --director-gap=N
//               every gap N play ticks (the game's: log-normal round 55 minutes): a 2-hour run sees 1-2 events otherwise
//   --party[=drop_party|party_room|both]  (realism phase 5b, track P) a party forced near the touring human's route (a
//               stand-in for Track D's director, for these pieces only): a drop party at Lumbridge's courtyard from tick
//               300 (the tour's 2nd stop, 600-1200; a retry every 100 ticks for 10 minutes; the human goes to it once
//               the host drops, wherever the tour was, and scrambles for the piles as a person does), the Party Room
//               from tick 7450 (members: the human stands in the room during the Seers stop); DP2-DP5 and the human's
//               share (DP3b's detail). Forced parties are left out of DP1
//   --scam      (realism phase 5b, track P) a scam stint forced at Varrock West from tick 5420 (the tour's 10th stop,
//               Varrock West's bank): K1, K2
//   --arena[=N[@T]]  (realism phase 5b, track A) the touring human stands in the Duel Arena's challenge area for N ticks
//               (default 1200: 12 minutes) from tick T (default half the run), a members world: A6 (the bots' challenges
//               to it; it answers none: a refusal by silence)
//   --mod[=N]   (realism phase 5b, track A) every N ticks (default 2000) the human steps near the player-mod bot when it is
//               online on the overworld and spams (one line 3 times in 30 s): Q1, Q2 (the mod's duty)
//   --probe-lines=FILE  (realism phase 7, the language model) the probe's and the talk's lines from FILE ({public:
//               ["{name} ..."], pm: [...], followups: [...], talk: [...]}: test/data/model-human-lines.json) instead of
//               the short lists below, and follow-ups: after a public probe the human goes on, 6 times in 10, with a line
//               to the same bot 8-20 ticks later (no name: the conversation), after a PM 1 time in 2 with another PM
//               10-25 ticks later; all on the human's dice (a run without the flag is unchanged)
//   --model-capture=FILE  (phase 7) every reply to the human the rules composed and every line of the human's they left
//               unanswered that a model could answer, as JSON lines {t, kind, ruleText, situation} (port/BotModelPrompt's
//               situationOf, at the moment the bot decides): the training data's situations. No dice: the run is the same
//   --model=stub[:L[:F]]  (phase 7, Track E) a model words the replies in its scope (port/BotModel): the library's
//               deterministic stub (replies from the situation, each answer L ticks after its request, default 2; a share
//               F of the requests fail, default 0: half answer nothing, half an error; 4 % are planted bad lines the
//               guard must catch). MD1-MD6 (lib/humanlike-metrics.mjs MODEL_METRICS) are printed apart: they are not in
//               the fingerprint. A run with a model is another world than one without (its replies' dice and times):
//               compare such runs by their metrics
//   --model=http://127.0.0.1:PORT  (phase 7) the words from a llama-server on the Mac (its /completion; an OpenAI-style
//               /v1/completions where that is missing): the on-device prompt (renderLocal) in Qwen's chat template with
//               the empty think block, §3's sampling (temperature 0.8, top-p 0.9, top-k 40, repetition penalty 1.1 over
//               64 tokens, 40 tokens at most, a grammar of one chat line of at most 120 characters). The run waits for
//               each answer (the tick loop pauses), so the model's lines are in the record and the guard is measured.
//               Desktop only. --model-log=FILE: every reply's story (the line heard, the model's words, the guard's
//               verdict, what was said) as JSON lines

// Line kinds: an explicit kind from the library wins (port/BotSay's listeners get `(player, line, kind, to)`: botSay's
// kind and addressee; `{ kind, to }` as the third argument is read too), then BotPlayer._say's (idle, newbie,
// levelup), BotChat's reply counter (a public answer to the human), then the text and the speaker's task
// (lib/humanlike-metrics.mjs lineKind).
//
// Deterministic: the same arguments give the same metrics (the fingerprint line). The human's choices (probes, talk)
// use dice of their own, but the bots' answers to them draw from the bots' dice: a --probe or --talk run is another
// world than one without them (other bots log in), so compare such runs by their metrics only. Exit code 0 even with
// ✗ (warn only), 1 on a crash (its last error lines are printed), on more errors than --max-errors, or with --strict
// and a ✗. Nothing is written outside build/tmp/bots and the files asked for.
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, CONTENT_DIR, ENGINE_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import * as M from './lib/humanlike-metrics.mjs';
import { compileBotScripts } from '../content/compile.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const N = Number(args.bots ?? 100);
const TICKS = Number(args.ticks ?? 6000);
const SEED = Number(args.seed ?? 1);
const MEMBERS = (args.members ?? 'true') !== 'false';
const XPRATE = Number(args.xprate ?? 1);
const PROBE = Number(args.probe ?? 0);
const TALK = Number(args.talk ?? 0);
// (realism phase 5a, track F: the probe human's work, ticks a turn: cows, then rocks)
const WORK = args.work === undefined ? 0 : args.work === 'true' ? 1000 : Number(args.work);
// (realism phase 5b, track A: the human in the Duel Arena's challenge area, N ticks from tick T; near the mod, every N ticks)
const ARENA_STOP = args.arena === undefined ? null : (() => {
    const [n, at] = String(args.arena === 'true' ? '' : args.arena).split('@');
    return { ticks: n ? Number(n) : 1200, at: at ? Number(at) : Math.floor(Number(args.ticks ?? 6000) / 2) };
})();
const MOD_PROBE = args.mod === undefined ? 0 : args.mod === 'true' ? 2000 : Number(args.mod);
// (realism phase 7: the language model's training situations)
const PROBE_LINES = args['probe-lines'] && args['probe-lines'] !== 'true' ? JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args['probe-lines']), 'utf8')) : null;
const MODEL_CAPTURE = args['model-capture'] && args['model-capture'] !== 'true' ? args['model-capture'] : null;
// (realism phase 7, Track E: a model writes the replies in its scope; every reply's story to a file)
const MODEL = args.model && args.model !== 'true' ? String(args.model) : null;
const MODEL_LOG = args['model-log'] && args['model-log'] !== 'true' ? args['model-log'] : null;
if (MODEL && !/^stub(:[\d.]+){0,2}$/.test(MODEL) && !/^https?:\/\/[^\s]+$/.test(MODEL)) {
    console.error(`humanlike: --model takes stub[:latencyTicks[:failRate]] or http://host:port (got ${MODEL})`);
    process.exit(2);
}
// ---- (variety round 1: each track's options in a block of its own) ----
// ---- Track F (fixes and movement) options ----
// --fill-window=N  (variety round 1, track F) TP4f's window: the rescue jumps in the first N ticks from the fill's first
//             login (default 500: 5 minutes); TP4f's detail gives TP4 after it
const FILL_WINDOW = Number(args['fill-window'] ?? 500);
// ---- end of Track F's options ----
// ---- Track D (what and where) options ----
// ---- end of Track D's options ----
// ---- Track S (what they say) options ----
// ---- end of Track S's options ----
// ---- Track W (what they wear) options ----
// --wear-every=N: the looks census's cadence (ticks; default 200): every bot's worn items, task, fight mode and tile
const WEAR_EVERY = Math.max(50, Number(args['wear-every'] ?? 200));
// --wear-census=FILE: the census's samples as JSON lines (each worn slot by its debugname), for a closer look
const WEAR_CENSUS = args['wear-census'] && args['wear-census'] !== 'true' ? args['wear-census'] : null;
// ---- end of Track W's options ----
// ---- (variety round 2: each track's options in a block of its own) ----
// ---- Track D2 (new activities) options ----
// ---- end of Track D2's options ----
// ---- Track M (members places and minigames) options ----
// ---- end of Track M's options ----
// ---- Track S2 (conversation) options ----
// ---- end of Track S2's options ----
// ---- Track W2 (fashion) options ----
// --fashion-every=N: the fashion census's period (default 500 ticks: 5 minutes): each bot's worn slots, wealth, task, tile
const FASHION_EVERY = Math.max(100, Number(args['fashion-every'] ?? 500));
// --fashion-census=FILE: the census as JSON (record.tracks.fashion), for a closer look
const FASHION_CENSUS = args['fashion-census'] && args['fashion-census'] !== 'true' ? args['fashion-census'] : null;
// ---- end of Track W2's options ----
const WARMUP = Number(args.warmup ?? 100);
const MAX_ERRORS = Number(args['max-errors'] ?? 0);
const OVERLAY = args.overlay !== 'false';
const SAMPLE = 5;
const STILL = args.tour === 'still';
const STOP_TICKS = STILL ? 0 : args.tour && args.tour !== 'true' ? Number(args.tour) : 600;
const MODE = PROBE > 0 ? 'probe' : WORK > 0 ? 'work' : STILL ? 'still' : 'tour';
const STRICT = args.strict === 'true';
const DETAILS = args['no-details'] !== 'true';
const START_CWD = process.cwd();
for (const [name, v, lo] of [['bots', N, 1], ['ticks', TICKS, 1], ['seed', SEED, 0], ['xprate', XPRATE, 1], ['probe', PROBE, 0], ['talk', TALK, 0], ['warmup', WARMUP, 0], ['max-errors', MAX_ERRORS, 0], ['tour', STOP_TICKS, STILL ? 0 : 1], ['work', WORK, 0]]) {
    if (!Number.isInteger(v) || v < lo) {
        console.error(`humanlike: --${name} takes a whole number of at least ${lo} (got ${args[name]})`);
        process.exit(2);
    }
}

// ---- dice: the bots' (Math.random, seeded as test/sim.mjs) and the human's own (probes, talk) ----
function mulberry(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
Math.random = mulberry(SEED);
const humanDice = mulberry(Math.imul(SEED + 1, 0x9e3779b1));
const pick = list => list[Math.floor(humanDice() * list.length)];

// ---- console: count errors and warnings, print only ours ----
// An error counts once. An engine script error prints a header, "script error: ...", its file and a backtrace (6-8
// lines): its "script error:" line counts. A bot error goes through port/BotLog's botConsole, which counts it
// (botErrorCount) on its way here: its line is kept, not counted again.
const out = (s = '') => process.stdout.write(s + '\n');
const logStats = { errors: [], engine: 0, warnings: 0 };
let World = null;
let inBotLog = 0;
const errorHead = text => text.trim() !== '' && !/^\s/.test(text) && !/^(file: |stack backtrace:)/.test(text) && !/(Player|NPC) script error - /.test(text);
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    console[level] = (...a) => {
        if (level === 'warn') logStats.warnings++;
        if (level !== 'error') return;
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (text.includes('ExperimentalWarning')) return;
        logStats.errors.push(`t${World?.currentTick ?? -1}: ${text.slice(0, 400)}`);
        if (!inBotLog && errorHead(text)) logStats.engine++;
    };
}
// a crash (World.cycle's catch prints the cause and exits) or a failed run: its last error lines, which the console
// above keeps quiet (prefixed, so that all.mjs shows them)
process.on('exit', code => {
    if (code === 0 || code === 2 || !logStats.errors.length) return;
    const lines = logStats.errors.slice(-8).flatMap(e => e.split('\n').slice(0, 6));
    process.stderr.write(lines.map(l => `humanlike: error: ${l}\n`).join(''));
});

// ---- the world ----
// (the overlay compiled against the vanilla pack, before the clone: compile.mjs caches it in build/tmp/bots)
const content = OVERLAY
    ? {
          bin: new Uint8Array(fs.readFileSync((await compileBotScripts({ engineDir: ENGINE_DIR, contentDir: CONTENT_DIR, log: () => {} })).file)),
          dat: new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.dat'))),
          idx: new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.idx')))
      }
    : null;
const engineDir = prepareEngineClone(`humanlike-${MEMBERS ? 'p2p' : 'f2p'}`, simWorldConfig({ members: MEMBERS, xpRate: XPRATE }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/humanworld.ts'), path.join(engineDir, 'tsconfig.json'));
World = lib.World;
const { BotManager, BotChat, wildernessLevelAt } = lib;
{
    const error = lib.botConsole.error;
    lib.botConsole.error = (...a) => {
        inBotLog++;
        try {
            error(...a);
        } finally {
            inBotLog--;
        }
    };
}

// ---- phase 3, track C (social life): the cliques' switch (the stand-ins for the other tracks' hooks went with the merge) ----
if (args.cliques === 'off') lib.BotCliques.setCliqueBehaviourForTest?.(false);
// ---- (realism phase 5a, Track M) --rune-seed=false: the new bots get no runes (port/BotAge.magicKit), a world as the saved
// bots have it (no top-up), for TP1-TP3 there ----
if (args['rune-seed'] === 'false') lib.Age.setRuneSeedForTest?.(false);
// (and the trips' decisions logged, for TP1's detail: which bots made the qualifying trips)
lib.Teleport?.keepTripLogForTest?.(true);
const HUBS = M.hubsFor(MEMBERS);
const hubByKey = new Map(HUBS.map(h => [h.key, h]));
const STOPS = M.tourStops(MEMBERS);
const AT = args.at ?? 'varrock_west_road';
if (STILL && !hubByKey.has(AT)) {
    process.stderr.write(`humanlike: --at takes a place: ${HUBS.map(h => h.key).join(', ')}\n`);
    process.exit(2);
}

// the bot store: saves by name, the names that quit (as runtime/bots/store.ts keeps them)
const saves = new Map();
const quit = new Set();
const sim = await lib.Sim.create({
    bots: N,
    members: MEMBERS,
    debug: false,
    ageNewBots: true,
    saves,
    ackLogouts: true,
    extra: { timing: {}, savedNames: () => [...saves.keys()], isQuit: n => quit.has(n), onQuit: n => (saves.delete(n), quit.add(n)) }
});
const overlayScripts = content ? lib.installBotsContent(content.bin, content.dat, content.idx) : 0;
const firstStop = hubByKey.get(STILL ? AT : STOPS[0]);
sim.addHuman(firstStop.x, firstStop.z, 0);
const human = sim.human;

// ---- the record (lib/humanlike-metrics.mjs reads it) ----
// (realism phase 7, --model-capture: the training data's situations, as the bots decide to reply; no dice)
const modelCaptured = [];
if (MODEL_CAPTURE) {
    if (!lib.BotModelNs?.composedListeners || !lib.BotModelPromptNs?.situationOf) {
        console.error('humanlike: --model-capture needs the phase 7 library (port/BotModel, port/BotModelPrompt)');
        process.exit(2);
    }
    lib.BotModelNs.composedListeners.push((req, ruleText, kind) => {
        if (req.to !== human || req.via === 'market' || req.via === 'reaction') return;
        modelCaptured.push({ t: lib.World.currentTick, kind, ruleText, situation: lib.BotModelPromptNs.situationOf(req) });
    });
}
// ---- (realism phase 7, Track E) --model: a model words the replies in its scope (port/BotModel): the library's stub, or a
// llama-server the run waits for (askHttp, after each tick); MD1-MD6 from its stats and log at the end ----
const modelHttp = { url: null, queue: [], ms: [], failed: 0, promptTokens: 0, predictedTokens: 0, waitMs: 0 };
let modelInfo = null;
if (MODEL) {
    const ns = lib.BotModelNs;
    if (typeof ns?.setModelForTest !== 'function') {
        console.error('humanlike: --model needs the phase 7 library (port/BotModel setModelForTest)');
        process.exit(2);
    }
    if (MODEL.startsWith('stub')) {
        const [, l, f] = MODEL.split(':');
        const latencyTicks = l ? Number(l) : 2;
        const failRate = f ? Number(f) : 0;
        if (!Number.isInteger(latencyTicks) || latencyTicks < 1 || !(failRate >= 0 && failRate <= 1)) {
            console.error(`humanlike: --model=stub:L:F takes whole ticks L >= 1 and a share F of 0-1 (got ${MODEL})`);
            process.exit(2);
        }
        ns.setModelForTest('stub', { latencyTicks, failRate });
        modelInfo = { kind: 'stub', latencyTicks, failRate };
    } else {
        modelHttp.url = MODEL.replace(/\/+$/, '');
        ns.setModelMode({ mode: 'local', local: true, online: false });
        ns.setModelChannel(msg => modelHttp.queue.push(msg));
        modelInfo = { kind: 'http', url: modelHttp.url };
    }
}
/** one line of the chat's characters, at most 120 (the guard cuts to 80): §3's grammar for the on-device model */
const MODEL_GRAMMAR = `root ::= [a-zA-Z0-9 !?.,:;()&*'@#+=$%"\\[\\]-]{1,120}`;
/** the llama-server's words for a request (the on-device prompt as native sends it), as the page would answer */
async function askHttp(msg) {
    const prompt = `<|im_start|>system\n${msg.local.system}<|im_end|>\n<|im_start|>user\n${msg.local.user}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
    const seed = (SEED * 100003 + msg.id) >>> 0;
    const t0 = performance.now();
    // (one retry when the connection itself fails: llama-server now and then drops a kept-alive one)
    const post = (route, body) => {
        const once = () => fetch(`${modelHttp.url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        return once().catch(err => (err?.name === 'TimeoutError' ? Promise.reject(err) : once()));
    };
    try {
        let res = await post('/completion', { prompt, n_predict: 40, temperature: 0.8, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, repeat_last_n: 64, stop: ['\n', '<|im_end|>'], grammar: MODEL_GRAMMAR, seed, cache_prompt: true });
        let text;
        if (res.status === 404) {
            res = await post('/v1/completions', { prompt, max_tokens: 40, temperature: 0.8, top_p: 0.9, stop: ['\n', '<|im_end|>'], seed });
            const j = await res.json();
            text = j?.choices?.[0]?.text ?? null;
        } else {
            const j = await res.json();
            if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(j).slice(0, 120)}`);
            text = typeof j?.content === 'string' ? j.content : null;
            modelHttp.promptTokens += j?.tokens_evaluated ?? 0;
            modelHttp.predictedTokens += j?.tokens_predicted ?? 0;
        }
        const ms = performance.now() - t0;
        modelHttp.ms.push(ms);
        return { type: 'bots-lm-reply', id: msg.id, text, source: text === null ? null : 'local', ms: Math.round(ms), ...(text === null ? { error: 'failed: no text' } : {}) };
    } catch (err) {
        modelHttp.failed++;
        return { type: 'bots-lm-reply', id: msg.id, text: null, source: null, error: `failed: ${String(err?.message ?? err).slice(0, 80)}`, ms: Math.round(performance.now() - t0) };
    }
}
const record = M.emptyRecord({ bots: N, ticks: TICKS, members: MEMBERS, xpRate: XPRATE, seed: SEED, humanName: human.displayName || 'sim human', mode: MODE, stopTicks: STOP_TICKS, at: STILL ? AT : null, probe: PROBE, talk: TALK, newchar: args.newchar === 'true', warmup: WARMUP, sampleEvery: SAMPLE, fillTick: -1, overlayScripts });
for (const h of HUBS) record.hubs[h.key] = { samples: 0, bots: 0, empty: 0, max: 0, social: 0, crowdBots: 0, crowdSocial: 0 };

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const humanDist = (x, z, level) => (human.slot !== -1 && human.level === level ? Math.max(Math.abs(human.x - x), Math.abs(human.z - z)) : 999);
const targetKind = t => (!t ? null : t.username !== undefined ? 'player' : t.nid !== undefined ? 'npc' : 'loc');
const kindCache = new Map();
function taskKind(name) {
    if (!name) return 'none';
    let k = kindCache.get(name);
    if (k === undefined) kindCache.set(name, (k = name.split(':')[0]));
    return k;
}
function hubsNear(x, z, level) {
    const list = [];
    for (const h of HUBS) if (h.level === level && Math.abs(h.x - x) <= M.VIEW && Math.abs(h.z - z) <= M.VIEW) list.push(h.key);
    return list;
}
const BANKS = Object.entries(lib.Locations)
    .filter(([k, v]) => k.endsWith('_BANK') && Array.isArray(v))
    .map(([, v]) => v);
const atBank = (x, z, level) => BANKS.some(([bx, bz, bl]) => bl === level && Math.abs(bx - x) <= 8 && Math.abs(bz - z) <= 8);
const push = (o, k, v, cap = 50000) => {
    const list = o[k] ?? (o[k] = []);
    if (list.length < cap) list.push(v);
};

// ---- per bot login (a bot that comes back is a new Player, a new session) ----
const recs = new Map();
let nextSession = 1;
let active = [];
function recOf(p, tick) {
    let r = recs.get(p);
    if (!r) {
        const session = { s: nextSession++, name: p.username, planner: p.botPlanner, first: tick, last: tick, ended: false };
        // (arrivals, the realism work's phase 3: where it came into the world, for H5's pop-ins)
        loginPlace.set(session, [p.x, p.z, p.level]);
        record.sessions.push(session);
        // (bot: its AI, the same for the whole login; mo: its planner's motion counters; kinds: a levelling bot's ticks
        // per task kind, added up when the kind changes)
        const mo = record.motion[p.botPlanner] ?? (record.motion[p.botPlanner] = [0, 0, 0, 0]);
        r = { s: session.s, session, bot: BotManager.botFor(p), mo, name: p.username, display: p.displayName, planner: p.botPlanner, x: p.x, z: p.z, level: p.level, m: 0, idle: false, seen: tick, still: -1, stillKey: null, idleStart: -1, kind: 'none', kindSince: tick, state: null, t: null, tk: null, lostAt: -1, lostKey: null, lastAcq: -1, lastIv: -1, lastXp: -1e9, lastDeath: -1e9, lastDeparture: -1, lastAttacker: null, hp: p.levels[3], kinds: M.LEVELLING.has(p.botPlanner) ? new Map() : null, ticks: 0, idleKind: null, hangStart: -1, hangSpot: null };
        recs.set(p, r);
    }
    return r;
}
function closeIdle(r, tick) {
    if (r.idleStart >= 0 && tick - r.idleStart >= 50) record.idleStands.push({ s: r.s, planner: r.planner, start: r.idleStart, len: tick - r.idleStart, kind: r.idleKind });
    r.idleStart = -1;
}
// ---- crowds (realism phase 3, track B): a levelling bot's hang-out (port/BotHangout), from its task's start to its end ----
function closeHangout(r, tick) {
    if (r.hangStart >= 0) record.hangouts.push({ s: r.s, start: r.hangStart, len: tick - r.hangStart, spot: r.hangSpot });
    r.hangStart = -1;
}
function addKindTime(r, tick) {
    if (r.kinds && tick > r.kindSince) r.kinds.set(r.kind, (r.kinds.get(r.kind) ?? 0) + tick - r.kindSince);
    r.kindSince = tick;
}
function endSession(r, tick, ended) {
    closeIdle(r, tick);
    closeHangout(r, tick);
    addKindTime(r, tick);
    r.session.ended = ended;
    if (r.kinds && r.ticks > 0) record.variety.push({ s: r.s, ticks: r.ticks, kinds: Object.fromEntries(r.kinds) });
}

// ---- what bots say: the line, its kind (see the header), where ----
let sayTag = null; // BotPlayer._say's kind and addressee while it speaks
// a long tagged line's later parts (port/BotSay splitLine, said 2 ticks apart), in order: a line takes the tag only if it
// is the next part as the filter shows it (lower case, a starred word)
const continuation = new WeakMap();
const isPart = (said, shown) => {
    const a = said.trim().toLowerCase();
    const b = shown.trim().toLowerCase();
    return a.length === b.length && [...a].every((ch, i) => ch === b[i] || b[i] === '*');
};
{
    const say = lib.BotPlayer.prototype._say;
    lib.BotPlayer.prototype._say = function (message, kind, to) {
        const prev = sayTag;
        sayTag = { kind, to: to ?? null };
        const parts = lib.splitLine(String(message));
        if (parts.length > 1) continuation.set(this.player, { kind, to: to ?? null, rest: parts.slice(1) });
        try {
            return say.call(this, message, kind, to);
        } finally {
            sayTag = prev;
        }
    };
}
let pending = null; // a line that may be a public answer to the human: BotChat counts it right after it is said
function finalize(line, r) {
    if (r && (M.kindGroup(line.kind) === 'chatter' || line.kind === 'goodbye') && !line.toName && M.isDeparture(line.text)) r.lastDeparture = line.t;
}
function resolvePending() {
    if (!pending) return;
    const p = pending;
    pending = null;
    if (BotChat.repliesBy(p.player) > p.before) p.line.kind = 'reply';
    finalize(p.line, p.r);
}
let listenerMs = 0;
lib.sayListeners.push((player, text, meta, addressee) => {
    const t0 = performance.now();
    resolvePending();
    const tick = World.currentTick;
    // (a bot that already left, saying the rest of a long line, has no session any more)
    const playing = BotManager.botFor(player);
    const r = recs.get(player) ?? (playing ? recOf(player, tick) : null);
    const task = playing?.currentTask ?? null;
    const kind = taskKind(task?.name);
    const explicit = typeof meta === 'string' ? meta : typeof meta?.kind === 'string' ? meta.kind : null;
    let tag = sayTag;
    if (!explicit && !tag) {
        const c = continuation.get(player);
        if (c?.rest.length && isPart(c.rest[0], text)) {
            c.rest.shift();
            tag = c;
        }
    }
    const to = addressee ?? meta?.to ?? tag?.to ?? null;
    const { x, z, level } = player;
    let near = 0;
    for (const p of active) if (p !== player && p.level === level && Math.abs(p.x - x) <= M.VIEW && Math.abs(p.z - z) <= M.VIEW) near++;
    const line = {
        t: tick, s: r?.s ?? -1, name: player.username, display: player.displayName, planner: player.botPlanner, task: kind, state: task?.state ?? null,
        kind: M.lineKind({ explicit, tag: tag?.kind ?? null, text, task: kind, planner: player.botPlanner }), explicit: !!explicit,
        to: to ? (to.is_bot ? 'bot' : 'human') : null, toName: to?.username ?? null, text, shown: M.displayed(text),
        colour: player.chatColour ?? 0, effect: player.chatEffect ?? 0, cb: player.combatLevel, x, z, level, moving: (r?.m ?? 0) > 0,
        // (2026-10-18: a vendor's auto typer, tasks/VendorTask: E2-E4 judge the hand-typed adverts)
        typer: kind === 'Vendor' && task?.typerGap != null,
        target: targetKind(player.target), wild: wildernessLevelAt(x, z), hubs: hubsNear(x, z, level), humanDist: humanDist(x, z, level), near
    };
    record.lines.push(line);
    if (!explicit && !tag && line.kind !== 'goodbye') pending = { line, r, player, before: BotChat.repliesBy(player) };
    else finalize(line, r);
    listenerMs += performance.now() - t0;
});

// what the human gets: private messages (bots' answers), game messages (upstream's marketplace notices)
{
    const write = human.write.bind(human);
    human.write = function (msg) {
        if (msg instanceof lib.MessagePrivate) {
            let n = msg.from;
            let from = '';
            const chars = '_abcdefghijklmnopqrstuvwxyz0123456789';
            while (n > 0n) {
                from = chars[Number(n % 37n)] + from;
                n /= 37n;
            }
            record.pms.push({ t: World.currentTick, from, text: msg.msg });
        }
        return write(msg);
    };
    const mes = human.messageGame.bind(human);
    human.messageGame = function (text) {
        record.humanMes.push({ t: World.currentTick, text: String(text) });
        return mes(text);
    };
}
// deaths (274's death script says it where the bot fell) and XP (where the engine grants it)
{
    const proto = lib.Player.prototype;
    const mes = proto.messageGame;
    proto.messageGame = function (text) {
        if (this.is_bot && text === 'Oh dear you are dead!') {
            const r = recs.get(this);
            if (r) r.lastDeath = World.currentTick;
            const by = attackerOf(this) ?? r?.lastAttacker ?? '?';
            record.deaths.push({ t: World.currentTick, s: r?.s ?? -1, name: this.username, planner: this.botPlanner, task: taskKind(BotManager.botFor(this)?.currentTask?.name), by, x: this.x, z: this.z });
        }
        return mes.call(this, text);
    };
    const addXp = proto.addXp;
    proto.addXp = function (stat, xp, allowMulti) {
        const before = this.stats[stat];
        const res = addXp.call(this, stat, xp, allowMulti);
        if (this.is_bot && this.stats[stat] > before) {
            const r = recs.get(this);
            if (r) r.lastXp = World.currentTick;
        }
        return res;
    };
}

/**
 * Who is attacking a bot (an NPC or a player within 10 tiles targeting it, nearest first), or null. By the time 274 says
 * the bot died its killer has let go, so perTick notes it when a bot that is not out to fight loses Hitpoints with a
 * third or less left. (The zones are read, never made: GameMap.getZone would add the empty ones, and the world must run
 * as it would without the report.)
 */
function attackerOf(p) {
    const zones = World.gameMap?.zonemap?.zones;
    if (!(zones instanceof Map)) return null;
    let by = null;
    let best = Infinity;
    for (let zx = (p.x - 10) >> 3; zx <= (p.x + 10) >> 3; zx++) {
        for (let zz = (p.z - 10) >> 3; zz <= (p.z + 10) >> 3; zz++) {
            const zone = zones.get(lib.ZoneMap.zoneIndex(zx << 3, zz << 3, p.level));
            if (!zone) continue;
            for (const list of [zone.getAllNpcsUnsafe(), zone.getAllPlayersUnsafe()]) {
                for (const e of list) {
                    if (e.target !== p || e.level !== p.level) continue;
                    const d = cheb(e, p);
                    if (d <= 10 && d < best) [best, by] = [d, e.username ?? lib.NpcType.get(e.type)?.debugname ?? '?'];
                }
            }
        }
    }
    return by;
}

// ---- random events (realism phase 5a, track E): RE1-RE7 from port/BotRandomEvents' listeners (an older library has none:
// the RE metrics are n/a). Every note is kept; a tool head or a rod on the ground is looked at 99 ticks after it fell (one
// before 274 reveals it to everyone: RE7); after a move the event made (the fail teleport, out of the maze or the mime)
// the bot's first XP, or its logout (RE5) ----
const reListeners = lib.RandomEvents?.randomEventListeners;
const reDrops = [];
const reMoves = [];
if (Array.isArray(reListeners)) {
    record.randomEvents = { notes: [], drops: [], moves: [] };
    const dist = d => (d === undefined || d === null ? null : Number.isFinite(d) ? d : 999);
    reListeners.push(n => {
        const re = record.randomEvents;
        re.notes.push({ t: n.tick, name: n.name, type: n.type, kind: n.kind ?? null, humanDist: dist(n.humanDist), move: n.move ?? null, ticks: n.ticks ?? null, fallback: n.fallback ?? null, stat: n.stat ?? null, xp: n.xp ?? null, reason: n.reason ?? null, to: n.to ?? null });
        if (n.type === 'dropped' && n.obj) {
            const d = { t: n.tick, name: n.name, left: null };
            re.drops.push(d);
            reDrops.push({ obj: n.obj, d });
        }
        if (n.type === 'move' && (n.move === 'fail' || n.move === 'maze-out' || n.move === 'mime-out')) {
            const m = { t: n.tick, name: n.name, planner: n.bot?.botPlanner ?? null, move: n.move, xpAt: -1, gone: -1 };
            re.moves.push(m);
            reMoves.push(m);
        }
    });
    const addXp = lib.Player.prototype.addXp;
    lib.Player.prototype.addXp = function (stat, xp, allowMulti) {
        const before = this.stats[stat];
        const res = addXp.call(this, stat, xp, allowMulti);
        if (this.is_bot && this.stats[stat] > before && reMoves.length) {
            for (const m of reMoves) if (m.name === this.username && m.xpAt < 0 && m.gone < 0 && World.currentTick > m.t) m.xpAt = World.currentTick;
        }
        return res;
    };
    const simTick = sim.tick.bind(sim);
    sim.tick = () => {
        const sample = simTick();
        const tick = World.currentTick - 1;
        for (let i = reDrops.length - 1; i >= 0; i--) {
            const { obj, d } = reDrops[i];
            if (tick - d.t < 99) continue;
            d.left = obj.isActive === true;
            reDrops.splice(i, 1);
        }
        for (let i = reMoves.length - 1; i >= 0; i--) {
            const m = reMoves[i];
            if (m.xpAt >= 0 || tick - m.t > 1000) reMoves.splice(i, 1);
            else if (!BotManager.isActiveBot(m.name)) {
                m.gone = tick;
                reMoves.splice(i, 1);
            }
        }
        return sample;
    };
}
// ---- end of track E's (phase 5a) block ----

// ---- (realism phase 5b, Track D: the director and groups) V1-V4, G2-G5: port/BotDirector's log and port/BotTrains' at the
// end; every 5 ticks (after the world's tick) the running set pieces the human sees at their peak (V2), a clan walk's
// walkers' capes at its peak (G3), lines of 3+ following one another near the human (G2), 2+ bots attacking one player in
// the Wilderness for 3 samples in a row (G5; shorter ones apart). --director-first/-kind/-gap force the schedule (a 2-hour
// run sees 1-2 events). An older library has no such modules: n/a ----
const spMods = typeof lib.setPieceModules === 'function' ? await lib.setPieceModules() : null;
const spOn = !!(spMods?.director && spMods.setPieces);
if (spOn) {
    record.setPieces = { events: [], seen: [], groups: [], capes: [], piles: [], brief: [], trains: [] };
    const num = name => (args[name] === undefined ? null : Number(args[name]));
    const first = num('director-first');
    const gap = num('director-gap');
    const kinds = args['director-kind'] ? String(args['director-kind']).split(',') : null;
    for (const [name, v] of [['director-first', first], ['director-gap', gap]]) {
        if (v !== null && !(Number.isInteger(v) && v >= 0)) {
            console.error(`humanlike: --${name} takes a whole number of play ticks (got ${args[name]})`);
            process.exit(2);
        }
    }
    if (first !== null || gap !== null || kinds) spMods.director.setDirectorForTest?.({ first, firstKinds: kinds, gap });
}
const spSeen = new Map();
const spGroups = new Map();
const spCapes = new Set();
const spPiles = new Map();
/** a pile (2+ bots attacking one player) counts once it lasts this many samples in a row; the runs of piles under way */
const PILE_SAMPLES = 3;
const spPileRuns = new Map();
// (274's ServerTriggerType: APPLAYER3 89, OPPLAYER3 96, the Follow option; as the runner reads APPLAYER2/OPPLAYER2, 88/95)
const FOLLOW_OPS = new Set([89, 96]);
function setPieceSample(tick) {
    const sp = record.setPieces;
    const bots = sim.bots();
    for (const run of spMods.setPieces.runningSetPieces()) {
        if (run.phase !== 'peak') continue;
        const near = [...run.roles.keys()].some(p => p.slot !== -1 && p.level === human.level && cheb(p, human) <= M.VIEW);
        if (near && tick - (spSeen.get(run.id) ?? -1e9) >= 100) {
            spSeen.set(run.id, tick);
            sp.seen.push({ id: run.id, t: tick });
        }
        if (run.kind === 'clan_walk' && typeof run.capeId === 'number') {
            for (const p of run.roles.keys()) {
                const key = `${run.id}|${p.username}`;
                if (spCapes.has(key) || p.slot === -1) continue;
                spCapes.add(key);
                sp.capes.push({ id: run.id, name: p.username, match: p.getInventory(lib.InvType.WORN)?.get(1)?.id === run.capeId });
            }
        }
    }
    // (lines of 3+: who follows whom, the game's Follow; one of the line within 15 tiles of the human)
    const parent = new Map();
    for (const b of bots) if (b.target && b.target.username !== undefined && FOLLOW_OPS.has(b.targetOp)) parent.set(b, b.target);
    if (parent.size >= 2) {
        const rootOf = p => {
            let q = p;
            for (let i = 0; i < 10 && parent.has(q); i++) q = parent.get(q);
            return q;
        };
        const lines = new Map();
        for (const b of parent.keys()) {
            const root = rootOf(b);
            const list = lines.get(root) ?? lines.set(root, [root]).get(root);
            list.push(b);
        }
        for (const [root, list] of lines) {
            if (list.length < 3 || !list.some(p => p.level === human.level && cheb(p, human) <= M.VIEW)) continue;
            const key = root.username;
            if (tick - (spGroups.get(key) ?? -1e9) >= 1000) sp.groups.push({ t: tick, size: list.length, names: list.map(p => p.username) });
            spGroups.set(key, tick);
        }
    }
    // (2+ bots attacking one player in the Wilderness: a pile once it lasts PILE_SAMPLES samples in a row (15 ticks: longer
    // than a click or two the game refuses, "Someone else is already fighting your opponent."), an episode a target per 100
    // ticks; the shorter ones counted apart)
    const on = new Map();
    for (const b of bots) {
        const t = sim.attackTarget(b);
        if (t && wildernessLevelAt(t.x, t.z) > 0) on.set(t, [...(on.get(t) ?? []), b]);
    }
    for (const [t, run] of spPileRuns) {
        if ((on.get(t)?.length ?? 0) >= 2) continue;
        if (run.n < PILE_SAMPLES) sp.brief.push({ t: run.t, multi: run.multi });
        spPileRuns.delete(t);
    }
    for (const [t, by] of on) {
        if (by.length < 2) continue;
        const multi = spMods.content?.isMultiCombat?.(t.x, t.z, t.level) ?? false;
        const run = spPileRuns.get(t) ?? spPileRuns.set(t, { n: 0, t: tick, multi, by: by.map(b => `${b.username} ${taskKind(BotManager.botFor(b)?.currentTask?.name)}${spMods.setPieces.eventRoleOf(b) ? ' (raid)' : ''}`), at: [t.x, t.z] }).get(t);
        run.n++;
        if (run.n === PILE_SAMPLES && tick - (spPiles.get(t) ?? -1e9) >= 100) {
            sp.piles.push({ t: run.t, human: t === human, n: by.length, multi: run.multi, at: run.at, target: t.username, by: run.by });
            spPiles.set(t, tick);
        }
    }
}
if (spOn) {
    const simTickD = sim.tick.bind(sim);
    sim.tick = () => {
        const sample = simTickD();
        const tick = World.currentTick - 1;
        if (tick % SAMPLE === 0 && tick >= WARMUP) setPieceSample(tick);
        return sample;
    };
}
// ---- end of Track D's (phase 5b) sampling block ----

// ---- every tick: every bot ----
const objNames = new Map();
function objName(id) {
    let n = objNames.get(id);
    if (n === undefined) objNames.set(id, (n = lib.ObjType.get(id)?.debugname ?? String(id)));
    return n;
}
let loginTick = -1;
const POPIN_AT = [2, 5, 10, 20, 30, 50, 100];
// ---- arrivals (the realism work, phase 3, track A): H5's pop-ins, the bots in view at t100 that logged in within 15 tiles
// of the human after t5 (the rest of the t100 crowd was in the world by then and walked in) ----
const loginPlace = new WeakMap();
function poppedIn(tick) {
    let n = 0;
    for (const p of active) {
        if (p.level !== human.level || cheb(p, human) > M.VIEW) continue;
        const r = recs.get(p);
        const at = r && loginPlace.get(r.session);
        if (r && at && r.session.first > loginTick + 5 && at[2] === human.level && Math.max(Math.abs(at[0] - human.x), Math.abs(at[1] - human.z)) <= M.VIEW) n++;
    }
    return n;
}
function nearHuman() {
    let n = 0;
    for (const p of active) if (p.level === human.level && cheb(p, human) <= M.VIEW) n++;
    return n;
}
/**
 * Is `t` attacking `p` (an NPC in its attack mode against it, ai_opplayer2/ai_applayer2, NpcMode 8 and 13; a player with
 * the attack op on it, APPLAYER2/OPPLAYER2, 88 and 95)? Not an NPC that only faces it in a dialogue (Karim, a banker).
 */
const attacksBot = (t, p) => t.target === p && (t.username !== undefined ? t.targetOp === 88 || t.targetOp === 95 : t.targetOp === 8 || t.targetOp === 13);
/** standing about: no target, no script running or waiting, no XP in the last 10 ticks (a smith at its anvil, a fletcher
 * or a thief has no target but earns XP) */
const isIdle = (p, r, tick) => !p.target && !p.activeScript && !p.delayed && tick - r.lastXp > 10;
function perTick(tick) {
    resolvePending();
    active = sim.bots();
    record.botTicks += active.length;
    if (record.meta.fillTick < 0 && active.length >= N) record.meta.fillTick = tick;
    let seen = 0;
    for (const p of active) {
        const r = recOf(p, tick);
        seen++;
        r.seen = tick;
        r.session.last = tick;
        r.ticks++;
        // (crowds, realism phase 3: a hang-out begun at a bank stop is the bot's sub-task: it counts as the bot's doing)
        const task = lib.hangoutOf(p) ?? setPieceTaskOf(p) ?? (r.bot ?? (r.bot = BotManager.botFor(p)))?.currentTask ?? null;
        const kind = taskKind(task?.name);
        const state = task?.state ?? null;
        // (who hits a bot that is not out to fight, once it is down to a third of its Hitpoints: on the ticks it loses some)
        const hp = p.levels[3];
        if (hp < r.hp && hp * 3 <= p.baseLevels[3] && !M.FIGHT_KINDS.has(kind)) r.lastAttacker = attackerOf(p) ?? r.lastAttacker;
        r.hp = hp;
        // motion: 0 still, 1 walk, 2 run, 3 a jump (stairs, a boat, a death's respawn, an obstacle, a teleport)
        const d = p.level !== r.level ? 99 : Math.max(Math.abs(p.x - r.x), Math.abs(p.z - r.z));
        const m = d === 0 ? 0 : d <= 2 ? d : 3;
        r.mo[m]++;
        if (m === 3) {
            const jdx = Math.abs(p.x - r.x);
            const jdz = Math.abs(p.z - r.z);
            // (an agility obstacle moves the player a few tiles at the end of its animation: the Gnome course's pipe
            // squeeze, 3 tiles at a time; not a teleport)
            const cls = p.level !== r.level && jdx <= 3 && jdz <= 3 ? 'stairs' : jdz > 5000 ? 'dungeon' : (p.level === 1 || r.level === 1) && jdx + jdz > 20 ? 'boat' : kind === 'Agility' && p.level === r.level && jdx + jdz <= 15 ? 'obstacle' : 'jump';
            record.jumps.push({ t: tick, name: r.name, task: kind, cls, from: [r.x, r.z, r.level], to: [p.x, p.z, p.level], humanDist: Math.min(humanDist(r.x, r.z, r.level), humanDist(p.x, p.z, p.level)), afterDeath: tick - r.lastDeath <= 30 });
        }
        // stands: at a bank (H18b), idle (no target: H19, C4)
        if (m === 0) {
            if (r.still < 0) {
                r.still = tick;
                r.stillKey = null;
            }
            if (r.stillKey === null && state && M.BANK_STATES.has(state)) r.stillKey = `${kind}/${state}`;
        } else if (r.still >= 0) {
            if (r.stillKey) push(record.bankStops, r.stillKey, tick - r.still, 20000);
            r.still = -1;
        }
        r.idle = m === 0 && isIdle(p, r, tick);
        if (r.idle) {
            if (r.idleStart < 0) {
                r.idleStart = tick;
                r.idleKind = kind;
            }
        } else if (r.idleStart >= 0) closeIdle(r, tick);
        // targets: lost to the next one (H17), the intervals between new ones (H18). A new target that is attacking the
        // bot already is the game's auto-retaliate (an NPC that hits a bot whose attack eating stopped, or that came for
        // it), not the bot's click: counted apart (the realism work, phase 2: its re-targets wait a person's moment, and
        // the game's own retaliation was most of the instant ones left)
        const t = p.target;
        if (r.t && !t) {
            r.lostAt = tick;
            r.lostKey = `${kind}/${r.tk}`;
        }
        if (t && t !== r.t && attacksBot(t, p)) {
            record.retaliations[kind] = (record.retaliations[kind] ?? 0) + 1;
            r.lostAt = -1;
            // (and the next click starts a new run of intervals: one across the fight is not the bot's cadence)
            r.lastAcq = -1;
            r.lastIv = -1;
        } else if (t && t !== r.t) {
            if (r.lostAt >= 0) {
                push(record.gaps, r.lostKey, tick - r.lostAt);
                r.lostAt = -1;
            }
            if (r.lastAcq >= 0) {
                const iv = tick - r.lastAcq;
                if (iv <= 100) {
                    if (r.lastIv >= 0) {
                        const c = record.cadence[kind] ?? (record.cadence[kind] = { pairs: 0, identical: 0 });
                        c.pairs++;
                        if (iv === r.lastIv) c.identical++;
                    }
                    r.lastIv = iv;
                } else r.lastIv = -1;
            }
            r.lastAcq = tick;
        }
        if (r.lostAt >= 0 && tick - r.lostAt > 60) {
            push(record.gaps, r.lostKey, 61);
            r.lostAt = -1;
        }
        r.t = t;
        r.tk = targetKind(t);
        // levelling bots: XP lately (C14), what they do (variety)
        if (r.kinds) {
            record.levellingTicks++;
            record.xp.levelling++;
            if (tick - r.lastXp <= 25) record.xp.active++;
        }
        if (kind !== r.kind) {
            addKindTime(r, tick);
            // (crowds, realism phase 3: a levelling bot's hang-out begins or ends)
            if (r.kinds && r.kind === M.HANGOUT_KIND) closeHangout(r, tick);
            if (r.kinds && kind === M.HANGOUT_KIND) {
                r.hangStart = tick;
                r.hangSpot = task?.spot?.key ?? null;
            }
            r.kind = kind;
        }
        r.state = state;
        r.x = p.x;
        r.z = p.z;
        r.level = p.level;
        r.m = m;
    }
    // logouts: in the AI's list last tick, not now (a session that ended, a retirement)
    if (recs.size > seen) for (const [p, r] of recs) {
        if (r.seen === tick) continue;
        record.logouts.push({ t: tick, s: r.s, name: r.name, planner: r.planner, x: r.x, z: r.z, level: r.level, moving: r.m > 0, task: r.kind, target: r.tk, lastDeparture: r.lastDeparture, atBank: atBank(r.x, r.z, r.level) });
        r.session.last = tick - 1;
        endSession(r, tick, true);
        recs.delete(p);
    }
    // pop-in: the bots in the human's view after it entered the world
    if (loginTick < 0 && human.slot !== -1) loginTick = tick;
    if (loginTick >= 0 && POPIN_AT.includes(tick - loginTick)) record.popin.at[tick - loginTick] = nearHuman();
    if (loginTick >= 0 && tick - loginTick === 100) record.popin.popped = poppedIn(tick);
}

// ---- (realism phase 4, track A: looks) L1: rares and holiday items in view at the hubs, and of the touring human ----
// (by 274's debugnames, so a run against an older library works: it shows none)
const showOffKind = new Map();
for (const n of M.RARE_NAMES) showOffKind.set(lib.ObjType.getId(n), 'rare');
for (const n of M.HOLIDAY_NAMES) showOffKind.set(lib.ObjType.getId(n), 'holiday');
showOffKind.delete(-1);
const showOffLast = new Map(); // `${where}|${name}|${id}` -> the tick it was last seen there
/** the rare or holiday item a bot wears (on its head or in its hands), or -1 */
function showOffItem(p) {
    const worn = p.getInventory(lib.InvType.WORN);
    for (const slot of [0, 3]) {
        const it = worn?.get(slot);
        if (it && showOffKind.has(it.id)) return it.id;
    }
    return -1;
}
/** a sighting at `where` (a hub, or the human), unless the same bot and item were seen there in the last 10 minutes */
function noteShowOff(list, where, p, id, tick) {
    const key = `${where}|${p.username}|${id}`;
    const last = showOffLast.get(key);
    showOffLast.set(key, tick);
    if (last !== undefined && tick - last < M.SHOW_OFF_AGAIN) return;
    list.push({ t: tick, hub: where, name: p.username, planner: p.botPlanner, item: objName(id), kind: showOffKind.get(id) });
}
// ---- end of track A's (phase 4) block ----

// ---- every 5 ticks: the vantage points, stacks, the human's view ----
// (the bots on level 0 by 32-tile cell; each place looks only in the cells its 15-tile view overlaps)
const cellOf = (x, z) => ((x >> 5) << 12) | (z >> 5);
const hubCells = HUBS.map(h => {
    const cells = new Set();
    for (const dx of [-M.VIEW, M.VIEW]) for (const dz of [-M.VIEW, M.VIEW]) cells.add(cellOf(h.x + dx, h.z + dz));
    return [...cells];
});
const grid = new Map();
const tiles = new Map();
const tileKey = p => (p.level << 28) | (p.x << 14) | p.z;
function perSample(stop) {
    tiles.clear();
    for (const p of active) if (recs.get(p)?.m === 0) tiles.set(tileKey(p), (tiles.get(tileKey(p)) ?? 0) + 1);
    const st = record.stacks;
    for (const p of active) {
        st.botSamples++;
        const r = recs.get(p);
        if (r?.idle && tiles.get(tileKey(p)) >= 2) {
            st.idleStacked++;
            const k = `${r.kind}/${r.state ?? '-'}`;
            st.byState[k] = (st.byState[k] ?? 0) + 1;
        }
    }
    for (const list of grid.values()) list.length = 0;
    for (const p of active) {
        if (p.level !== 0) continue;
        const c = cellOf(p.x, p.z);
        let list = grid.get(c);
        if (!list) grid.set(c, (list = []));
        list.push(p);
    }
    const tickNow = World.currentTick;
    HUBS.forEach((h, i) => {
        const a = record.hubs[h.key];
        let n = 0;
        let social = 0;
        let showOff = false; // (phase 4, track A: L1)
        for (const c of hubCells[i]) {
            for (const p of grid.get(c) ?? []) {
                if (Math.abs(p.x - h.x) > M.VIEW || Math.abs(p.z - h.z) > M.VIEW) continue;
                n++;
                if (p.botPlanner === 'extras_social') social++;
                const id = showOffItem(p);
                if (id !== -1) {
                    showOff = true;
                    noteShowOff(record.showOff.sightings, h.key, p, id, tickNow);
                }
            }
        }
        record.showOff.hubSamples++;
        if (showOff) record.showOff.hubSamplesWith++;
        a.samples++;
        a.bots += n;
        a.social += social;
        // (H3 judges a hub's crowds: the samples with M.MOB_MIN bots or more in view)
        if (n >= M.MOB_MIN) {
            a.crowdBots += n;
            a.crowdSocial += social;
        }
        if (n === 0) a.empty++;
        if (n > a.max) a.max = n;
    });
    if (human.slot !== -1) {
        // (phase 4, track A: L1) what the touring human sees of the rares and holiday items
        for (const p of active) {
            if (p.level !== human.level || cheb(p, human) > M.VIEW) continue;
            const id = showOffItem(p);
            if (id !== -1) noteShowOff(record.showOff.human, 'human', p, id, tickNow);
        }
        const near = nearHuman();
        const v = record.view;
        v.samples++;
        v.sum += near;
        if (near === 0) v.empty++;
        const b = v.byStop[stop] ?? (v.byStop[stop] = { samples: 0, sum: 0, empty: 0 });
        b.samples++;
        b.sum += near;
        if (near === 0) b.empty++;
    }
    // ---- crowds (realism phase 3, track B): the levelling bots' fighting time and where (C15) ----
    const fights = record.fights;
    for (const p of active) {
        const r = recs.get(p);
        if (!r?.kinds) continue;
        fights.levelling++;
        const byPlanner = fights.byPlanner[r.planner] ?? (fights.byPlanner[r.planner] = [0, 0]);
        byPlanner[1]++;
        if (!M.FIGHTING_KINDS.has(r.kind)) continue;
        fights.samples++;
        byPlanner[0]++;
        const spot = M.crowdSpotAt(p.x, p.z, p.level, MEMBERS);
        if (spot) {
            fights.atCrowd++;
            fights.bySpot[spot] = (fights.bySpot[spot] ?? 0) + 1;
        } else {
            const cell = `${((p.x >> 6) << 6) + 32},${((p.z >> 6) << 6) + 32}`;
            fights.elsewhere[cell] = (fights.elsewhere[cell] ?? 0) + 1;
        }
    }
    const lumby = record.lumbridge;
    lumby.samples++;
    lumby.online += active.length;
    for (const p of active) if (p.combatLevel <= 5 && M.inLumbridge(p.x, p.z, p.level)) lumby.low++;
    // ---- arrivals and sessions (the realism work, phase 3, track A: P1's make-up, the newbies online) ----
    for (const p of active) {
        const newbie = lib.isNewbie(p);
        if (newbie) lumby.newbies = (lumby.newbies ?? 0) + 1;
        if (p.combatLevel > 5 || !M.inLumbridge(p.x, p.z, p.level)) continue;
        if (p.botPlanner === 'extras_social') lumby.lowSocial = (lumby.lowSocial ?? 0) + 1;
        else if (newbie) lumby.lowNewbie = (lumby.lowNewbie ?? 0) + 1;
    }
    groupSample();
    alchSample(tickNow);
    arenaSample(tickNow); // (realism phase 5b, track A)
}

// ---- (realism phase 5a, Track M: movement and magic) AL1: alchers the human sees at a trade bank (a bot alching: its task
// 'Magic', tasks/AlchTask, read by name so an older library shows none), a bot again after 10 minutes ----
const ALCH_TASK_KIND = 'Magic';
const alchSeenLast = new Map();
function alchSample(tick) {
    if (human.slot === -1) return;
    for (const p of active) {
        if (p.level !== human.level || cheb(p, human) > M.VIEW) continue;
        const task = recs.get(p)?.bot?.currentTask ?? null;
        if (taskKind(task?.name) !== ALCH_TASK_KIND) continue;
        const bank = lib.TRADE_BANKS.find(b => b.center[2] === p.level && Math.max(Math.abs(b.center[0] - p.x), Math.abs(b.center[1] - p.z)) <= 10);
        if (!bank) continue;
        const key = `${p.username}|${bank.key}`;
        const last = alchSeenLast.get(key);
        alchSeenLast.set(key, tick);
        if (last !== undefined && tick - last < M.SHOW_OFF_AGAIN) continue;
        record.alchSightings.push({ t: tick, name: p.username, bank: bank.key, state: task?.state ?? null });
    }
}
// ---- end of Track M's (phase 5a) sampling block ----

// ---- phase 3, track C (social life): G1, levelling bots within 3 tiles of a clique-mate for 30 s or more ----
// Every sample: each levelling bot online, its clique (port/BotCliques.cliqueOf), whether a clique-mate is online, and
// whether one is within G1_NEAR tiles on its floor; a run of samples near one counts once it lasts G1_RUN samples (30 s).
const G1_NEAR = 3;
const G1_RUN = 10;
const groupRuns = new Map(); // session id -> samples in a row near a clique-mate
let groupSeen = new Set();
const groupLogins = new Set(); // sessions of clique members counted as a login (log in together: a mate online then?)
function closeGroupRun(s) {
    const run = groupRuns.get(s) ?? 0;
    if (run >= G1_RUN) record.groups.near30 += run;
    groupRuns.delete(s);
}
function groupSample() {
    const cliqueOf = lib.BotCliques.cliqueOf;
    if (!cliqueOf) return;
    const byName = new Map();
    for (const p of active) byName.set(p.username, p);
    const g = record.groups;
    const seen = new Set();
    // (a clique member's login after the world filled: was a clique-mate online when it came?)
    if (record.meta.fillTick >= 0) {
        for (const p of active) {
            const r = recs.get(p);
            if (!r || groupLogins.has(r.s) || r.session.first <= record.meta.fillTick) continue;
            const clique = cliqueOf(p.username);
            if (!clique || clique.length < 2) continue;
            groupLogins.add(r.s);
            g.logins++;
            if (clique.some(name => name !== p.username && byName.has(name))) g.loginsWithMate++;
        }
    }
    for (const p of active) {
        if (!M.LEVELLING.has(p.botPlanner)) continue;
        g.levelling++;
        const clique = cliqueOf(p.username);
        if (!clique || clique.length < 2) continue;
        g.clique++;
        const r = recs.get(p);
        if (!r) continue;
        seen.add(r.s);
        let online = false;
        let near = false;
        let inView = false;
        for (const name of clique) {
            if (name === p.username) continue;
            const mate = byName.get(name);
            if (!mate) continue;
            online = true;
            const d = mate.level === p.level ? Math.max(Math.abs(mate.x - p.x), Math.abs(mate.z - p.z)) : Infinity;
            if (d <= G1_NEAR) near = true;
            if (d <= M.VIEW) inView = true;
        }
        if (online) g.mateOnline++;
        if (inView) g.inView++;
        if (near) {
            g.nearAny++;
            groupRuns.set(r.s, (groupRuns.get(r.s) ?? 0) + 1);
        } else closeGroupRun(r.s);
    }
    for (const s of groupSeen) if (!seen.has(s)) closeGroupRun(s);
    groupSeen = seen;
}

// ---- every 100 ticks: looks (gender, combat, worn items by slot) ----
const looks = new Map();
function perPopulation() {
    for (const p of active) {
        const worn = p.getInventory(lib.InvType.WORN);
        const names = [];
        for (let i = 0; i < (worn?.capacity ?? 0); i++) {
            const it = worn.get(i);
            names.push(it ? objName(it.id) : null);
        }
        looks.set(p.username, { name: p.username, planner: p.botPlanner, gender: p.gender, cb: p.combatLevel, worn: names });
        if (p.botPlanner === 'extras_vendor') noteVendorStock(p);
    }
}

// ---- economy (realism phase 4, track B): each vendor's stocking (E1: its ask against the street table) ----
// The table is the worktree's data file, read here whatever library runs (LC_BOTS_SRC: an A/B against older code
// measures that code's asks against it). A stocking is a session's item at an ask, read from its Vendor task's fields
// (stock, price, itemCount: the same names before phase 4), once.
try {
    const table = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/street_prices.json'), 'utf8')).items ?? {};
    for (const [item, row] of Object.entries(table)) record.street[item] = row.price;
} catch {
    // (no table: E1 is n/a)
}
const stockSeen = new Set();
function noteVendorStock(p) {
    const task = BotManager.botFor(p)?.currentTask;
    if (taskKind(task?.name) !== 'Vendor' || !task.stock || !(task.price > 0)) return;
    const r = recs.get(p);
    const key = `${r?.s ?? p.username}:${task.stock.itemId}:${task.price}`;
    if (stockSeen.has(key)) return;
    stockSeen.add(key);
    const obj = lib.ObjType.get(task.stock.itemId);
    let total = 0;
    p.baseLevels.forEach((level, stat) => {
        if (stat !== 18 && stat !== 19) total += level;
    });
    const bank = lib.stallOf(p)?.bank.key ?? null;
    // (its bank's own trade, where it has one: phase 4's stock by trade bank; null with an older library or no such bank)
    const tradeWeight = lib.Vendors.bankTradeWeight;
    const bankTrade = typeof tradeWeight === 'function' && bank !== null && (lib.Vendors.BANK_TRADE_KEYS ?? []).includes(bank) ? tradeWeight(bank, task.stock.itemId) > 0 : null;
    record.vendorStocks.push({ t: World.currentTick, s: r?.s ?? -1, name: p.username, item: obj?.debugname ?? String(task.stock.itemId), itemName: task.stockName || obj?.name || '?', ask: task.price, value: obj?.cost ?? 0, rare: task.stock.rare === true, noted: p.botVendorStockNoted === true, count: task.itemCount ?? 0, cb: p.combatLevel, total, bank, bankTrade });
}

// ---- the human: levels, the tour, probes, talk ----
let PROBE_PUBLIC = ['hi {name}', '{name} wyd', '{name} whats ur cb', '{name} where r u', '{name} how long have u played', '{name} r u a bot', '{name} wanna trade', '{name} nice gear', '{name} gz', '{name} lol', '{name} can i have some gp', '{name} what lvl is ur wc', '{name} where can i mine iron', '{name} follow me', '{name} brb', '{name} whats ur total', 'hey {name} hows it going', '{name} u there?'];
let PROBE_PM = ['hey', 'wyd', 'where r u', 'whats ur cb', 'wanna team up', 'lol', 'how much is a rune scim', 'u there?', 'hi how are you', 'what lvl r u'];
const PROBED = new Set(['skiller', 'fighter', 'balanced', 'random', 'extras_social', 'extras_vendor']);
let TALK_LINES = ['hi', 'hey all', 'wyd', 'lol', 'gz', 'anyone selling lobsters', 'buying iron ore', 'whats ur cb', 'how do i get to varrock', 'r u a bot', 'nice', 'where is the bank', 'hello', 'sup', 'whats the best way to make money', 'brb', 'any1 wanna go wildy', 'selling logs', 'ty', 'cya'];
const MARKET = /^(anyone selling|buying|selling|wtb|wts)\b/i;
// (realism phase 7: --probe-lines: the probe's lines from a file, and follow-ups)
const FOLLOWUPS = PROBE_LINES?.followups ?? [];
if (PROBE_LINES) {
    if (PROBE_LINES.public?.length) PROBE_PUBLIC = PROBE_LINES.public;
    if (PROBE_LINES.pm?.length) PROBE_PM = PROBE_LINES.pm;
    if (PROBE_LINES.talk?.length) TALK_LINES = PROBE_LINES.talk;
}
const followups = [];
let stopIndex = 0;
let nextProbe = PROBE > 0 ? 300 : Infinity;
let pendingProbe = null;
let nextTalk = TALK > 0 ? 200 : Infinity;
function probeTick(tick) {
    if (pendingProbe && tick >= pendingProbe.at) {
        const pr = pendingProbe;
        pendingProbe = null;
        if (pr.bot.slot !== -1 && BotManager.botFor(pr.bot)) {
            const line = pr.template.replace('{name}', pr.bot.displayName);
            record.probes.push({ t: tick, kind: 'public', bot: pr.bot.username, line, dist: cheb(pr.bot, human), task: taskKind(BotManager.botFor(pr.bot)?.currentTask?.name) });
            BotChat.onPublicMessage(human, line);
            if (FOLLOWUPS.length && humanDice() < 0.6) followups.push({ at: tick + 8 + Math.floor(humanDice() * 13), bot: pr.bot, pm: false, text: pick(FOLLOWUPS) });
        }
        const others = sim.bots().filter(b => b !== pr.bot);
        if (others.length) {
            const b = pick(others);
            const text = pick(PROBE_PM);
            record.probes.push({ t: tick, kind: 'pm', bot: b.username, line: text, dist: cheb(b, human), task: taskKind(BotManager.botFor(b)?.currentTask?.name) });
            BotChat.onPrivateMessage(human, b.username, text);
            if (FOLLOWUPS.length && humanDice() < 0.5) followups.push({ at: tick + 10 + Math.floor(humanDice() * 16), bot: b, pm: true, text: pick(FOLLOWUPS) });
        }
    }
    // (phase 7, --probe-lines: the human goes on with the same bot)
    for (let i = followups.length - 1; i >= 0; i--) {
        const f = followups[i];
        if (tick < f.at) continue;
        followups.splice(i, 1);
        if (f.bot.slot === -1 || !BotManager.botFor(f.bot)) continue;
        record.probes.push({ t: tick, kind: f.pm ? 'pm-followup' : 'followup', bot: f.bot.username, line: f.text, dist: cheb(f.bot, human), task: taskKind(BotManager.botFor(f.bot)?.currentTask?.name) });
        if (f.pm) BotChat.onPrivateMessage(human, f.bot.username, f.text);
        else BotChat.onPublicMessage(human, f.text);
    }
    if (tick >= nextProbe) {
        nextProbe = tick + PROBE;
        const cands = sim.bots().filter(b => b.level === 0 && PROBED.has(b.botPlanner) && wildernessLevelAt(b.x, b.z) === 0);
        if (!cands.length) return;
        const bot = pick(cands);
        for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [3, 0], [0, 3]]) {
            if (sim.isWalkable(bot.x + dx, bot.z + dz, 0)) {
                sim.teleportHuman(bot.x + dx, bot.z + dz, 0);
                break;
            }
        }
        pendingProbe = { bot, at: tick + 3, template: pick(PROBE_PUBLIC) };
    }
}
function humanTick(tick) {
    // (combat levels in the 30s: most monsters leave it alone; kept alive)
    if (tick === 3) for (let s = 0; s < 7; s++) human.setLevel(s, s === 5 ? 20 : s === 4 || s === 6 ? 25 : 35);
    if (args.newchar === 'true' && tick === 20) BotManager.newCharacter();
    if (stagedTick(tick)) {
        // (realism phase 5b, track A: --arena, --mod: the human is at the arena or near the mod)
    } else if (PROBE > 0) probeTick(tick);
    else if (WORK > 0) workTick(tick);
    else if (!STILL && tick > 0 && tick % STOP_TICKS === 0) {
        stopIndex = (stopIndex + 1) % STOPS.length;
        const h = hubByKey.get(STOPS[stopIndex]);
        sim.teleportHuman(h.x, h.z, 0);
    }
    if (human.levels[3] < human.baseLevels[3] / 2) human.levels[3] = human.baseLevels[3];
    if (tick >= nextTalk) {
        nextTalk = tick + TALK;
        const line = pick(TALK_LINES);
        record.humanLines.push({ t: tick, line, x: human.x, z: human.z, market: MARKET.test(line) });
        BotChat.onPublicMessage(human, line);
    }
}

// ---- (realism phase 5a, track F: fights, skills and manners) ----
// The probe human (--work): it fights cows in Lumbridge's east field (single-way: a rude bot nearer to the cow it walks
// to may take it first, R1h), then mines at Varrock East's mine (the polite bots leave its rock while another is free, a
// rude one now and then takes it: the courtesy), WORK ticks each, in turns. It clicks as the bots do (BotAction: Attack on
// a cow out of combat a few tiles off, Mine on a rock), a moment after its last target is done (its own dice).
// White Wolf Mountain: each bot that walks onto it (D3's crossings: by a bot its wolves hunt, combat 76 or less); the
// deaths there are the record's (by where they fell).
const WORK_COWS = [3255, 3276];
const WORK_MINE = [3285, 3365];
const COW_NAMES = new Set(['cow', 'cow2', 'cow3', 'cow_beef']);
const work = WORK > 0 ? { phase: '', cowTicks: 0, mineTicks: 0, cowClicks: 0, rockClicks: 0, readyAt: 0 } : null;
function workTick(tick) {
    if (tick < 3 || human.slot === -1) return;
    const phase = Math.floor(tick / WORK) % 2 === 0 ? 'cows' : 'mine';
    if (phase !== work.phase) {
        work.phase = phase;
        const [x, z] = phase === 'cows' ? WORK_COWS : WORK_MINE;
        sim.teleportHuman(x, z, 0);
        if (phase === 'mine') {
            human.setLevel(lib.PlayerStat.MINING, 30);
            const pickaxe = lib.ObjType.getId('bronze_pickaxe');
            const inv = human.getInventory(lib.InvType.INV);
            if (inv && pickaxe !== -1 && !inv.hasAt(0, pickaxe)) {
                inv.removeAll();
                inv.add(pickaxe, 1);
            }
        }
        work.readyAt = tick + 2;
        return;
    }
    if (phase === 'cows') work.cowTicks++;
    else work.mineTicks++;
    if (human.target !== null || human.hasWaypoints() || tick < work.readyAt) return;
    work.readyAt = tick + 2 + Math.floor(humanDice() * 4);
    if (phase === 'cows') {
        // (a cow out of combat 3-8 tiles off, of the few nearest at random: the human walks to it)
        const cows = [];
        lib.findNpcFiltered(human.x, human.z, 0, n => {
            if (!COW_NAMES.has(lib.NpcType.get(n.type)?.debugname ?? '') || n.target !== null) return false;
            const d = cheb(n, human);
            if (d >= 3 && d <= 8) cows.push(n);
            return false;
        }, 10);
        if (cows.length === 0) return;
        lib.interactNpcOp(human, pick(cows), 2);
        work.cowClicks++;
    } else {
        const inv = human.getInventory(lib.InvType.INV);
        if (inv && inv.freeSlotCount <= 1) {
            // (its ores dropped from the pack: the harness's own housekeeping, out of sight of the measures)
            for (let slot = 1; slot < inv.capacity; slot++) inv.delete(slot);
        }
        const rocks = [];
        for (const prefix of ['copperrock', 'tinrock', 'ironrock']) {
            lib.findLocByPrefixWhere(human.x, human.z, 0, prefix, 8, loc => (rocks.push(loc), false));
        }
        if (rocks.length === 0) return;
        rocks.sort((a, b) => cheb(a, human) - cheb(b, human));
        lib.interactLoc(human, rocks[Math.floor(humanDice() * Math.min(3, rocks.length))]);
        work.rockClicks++;
    }
}
const wwmOn = new WeakMap();
const wwmLast = new Map();
const wwmCrossings = [];
/** White Wolf Mountain's top (the multi-combat mapsquare 0_44_54: the wolves pile on there; its foot is Catherby's beach) */
const onWwm = (x, z, level) => level === 0 && M.onWwmTop(x, z);
function textureTick(tick) {
    for (const p of active) {
        const on = onWwm(p.x, p.z, p.level);
        // (a walk onto it: one crossing, a bot again only after 5 minutes)
        if (on && !wwmOn.get(p) && tick - (wwmLast.get(p.username) ?? -1e9) >= 500) {
            wwmCrossings.push({ t: tick, name: p.username, cb: p.combatLevel, planner: p.botPlanner, task: taskKind(BotManager.botFor(p)?.currentTask?.name) });
            wwmLast.set(p.username, tick);
        }
        wwmOn.set(p, on);
    }
}
/** the library's logs (an older library has none: null) */
async function collectTexture() {
    const { fumble, rude } = typeof lib.textureModules === 'function' ? await lib.textureModules() : { fumble: null, rude: null };
    return {
        fumbles: fumble ? fumble.fumbleLog.map(f => ({ t: f.tick, name: f.name, kind: f.kind })) : null,
        food: fumble ? fumble.foodLog.map(f => ({ t: f.tick, name: f.name, took: f.took, carried: f.carried })) : null,
        danger: fumble?.dangerStats ? { ...fumble.dangerStats } : null,
        incidents: rude ? rude.incidents.map(i => ({ ...i })) : null,
        rudeReplies: rude ? rude.rudeReplies.map(r => ({ t: r.tick, name: r.name, text: r.text })) : null,
        courtesy: rude ? { ...rude.courtesy } : null,
        wwm: { crossings: wwmCrossings },
        work: work ? { cowTicks: work.cowTicks, mineTicks: work.mineTicks, cowClicks: work.cowClicks, rockClicks: work.rockClicks } : null,
        humanName: human.username
    };
}
// ---- end of track F's block ----

// ---- (realism phase 5b, track P: parties, scams and lures) ----
// The library's logs at the end (record.parties: port/BotParty partyLog; record.scams: port/BotScams scamLog; record.lures:
// tasks/SocialTask's approach and lure logs, the human's); --party and --scam force a piece near the touring human's route
// through a stand-in for Track D's director (port/BotSetPieces: plan, start, runStarted, a tick every 5, runEnded), and the
// human scrambles for a forced party's piles (record.partyHuman). An older library has no such modules: n/a.
const P = typeof lib.partyModules === 'function' ? await lib.partyModules() : null;
const PARTY_FORCE = !P || args.party === undefined ? [] : args.party === 'true' || args.party === 'both' ? ['drop_party', 'party_room'] : String(args.party).split(',');
const SCAM_FORCE = !!P && args.scam === 'true';
const partyForce = { runs: [], human: { takes: [], clicks: 0 } };
/**
 * forced parties' times and venues (the tour's stops: lumbridge_courtyard 600-1200, seers_bank 7800-8400 on members; a run
 * too short for the Seers stop has its Party Room from tick 400, unseen by the human: DP4 still counts it), tried every
 * 100 ticks for 10 minutes. A young world may have no host with coins or guests free there for a while: the party then
 * begins later and its piles may show after the tour moved on, so the human goes to the party it heard of (partyTick).
 */
const FORCED = [
    ...(PARTY_FORCE.includes('drop_party') ? [{ kind: 'drop_party', venue: 'lumbridge_courtyard', at: 300 }] : []),
    ...(PARTY_FORCE.includes('party_room') && MEMBERS ? [{ kind: 'party_room', venue: 'party_room', at: TICKS >= 8600 ? 7450 : 400 }] : [])
];
/**
 * a bot with a part in a set piece (port/BotSetPieces eventRoleOf): its sub-task (a party's guest or host, a scam caller),
 * so its time and its stands are the piece's (H19 leaves them out, as a hang-out's: DP and K measure them); else null
 */
function setPieceTaskOf(p) {
    if (!P || P.pieces.eventRoleOf(p) === null) return null;
    const sub = BotManager.botFor(p)?.subTask ?? null;
    return sub && M.SET_PIECE_TASK_KINDS.has(taskKind(sub.name)) ? sub : null;
}
function forceCtx() {
    const bots = [...BotManager.activeBots()];
    const free = p => {
        const ai = BotManager.botFor(p);
        return !!ai && p.slot !== -1 && !ai.hasSubTask() && P.pieces.eventRoleOf(p) === null && !lib.isNewbie(p) && lib.stallOf(p) === null && p.botTradeTargetPid === -1 && p.botComeHereReturnX === -1;
    };
    return {
        now: World.currentTick, play: BotManager.stats().playTicks, members: MEMBERS, online: bots.length, census: new Map([['all', bots]]),
        freeBots(x, z, level, radius, ok, max) {
            const out = bots.filter(p => p.level === level && Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) <= radius && free(p) && (!ok || ok(p)));
            out.sort((a, b) => Math.max(Math.abs(a.x - x), Math.abs(a.z - z)) - Math.max(Math.abs(b.x - x), Math.abs(b.z - z)));
            return max === undefined ? out : out.slice(0, max);
        },
        sessionLeft: p => BotManager.sessionLeftOf(p.username),
        dice: Math.random
    };
}
let humanNextGrab = -1;
let humanTarget = null;
/** when the human notices each pile (its reveal and 3-8 ticks: its own dice) */
const humanNotice = new WeakMap();
function partyTick(tick) {
    if (!P) return;
    // a forced piece starts (a retry every 100 ticks for 10 minutes when no host or guests can be had)
    for (const f of FORCED) {
        if (f.run || f.gaveUp || tick < f.at || (tick - f.at) % 100 !== 0) continue;
        if (tick - f.at > 1000) {
            f.gaveUp = true;
            continue;
        }
        const ctx = forceCtx();
        const plan = f.kind === 'drop_party' ? P.party.planDropParty(ctx, f.venue) : P.party.planPartyRoom(ctx);
        const def = f.kind === 'drop_party' ? P.party.DROP_PARTY : P.party.PARTY_ROOM;
        const run = plan ? def.start(plan, ctx) : null;
        if (!run) {
            // (why not, for the report: the guests to ask, the hosts near with 3k+ coins)
            const v = P.party.VENUES.find(x => x.key === f.venue);
            f.why = `t${tick}: ${plan ? 'no start' : 'no plan'} (guests ${ctx.freeBots(v.drop[0], v.drop[1], 0, (typeof P.party.PARTY.guestRadius === 'number' ? P.party.PARTY.guestRadius : P.party.PARTY.guestRadius[f.kind]), p => P.party.guestFree(p) && ctx.sessionLeft(p) >= P.party.PARTY.guestSessionLeft).length}, hosts ${ctx.freeBots(v.drop[0], v.drop[1], 0, P.party.PARTY.hostRadius[f.kind]).filter(p => P.party.coinsOwned(p) >= P.party.PARTY.hostCoins).length})`;
            continue;
        }
        f.run = run;
        run.record.forced = true;
        P.pieces.runStarted(run);
        partyForce.runs.push(run);
    }
    if (SCAM_FORCE && !partyForce.scam && tick >= 5420 && tick % 50 === 20) {
        // (a caller the library would take there: at the venue, with an audience; a look again every 50 ticks)
        const venue = P.scams.SCAM_VENUES.find(v => v.key === 'varrock_west');
        const audience = p => typeof P.scams.audienceOf !== 'function' || P.scams.audienceOf(p) >= P.scams.SCAMS.audience;
        const caller = [...BotManager.activeBots()].filter(p => P.scams.mayCall(p) && Math.max(Math.abs(p.x - venue.x), Math.abs(p.z - venue.z)) <= venue.radius + 3 && audience(p)).sort((a, b) => Math.max(Math.abs(a.x - venue.x), Math.abs(a.z - venue.z)) - Math.max(Math.abs(b.x - venue.x), Math.abs(b.z - venue.z)))[0];
        const rec = caller ? P.scams.startStintForTest(caller, 'varrock_west', 500) : null;
        if (rec) {
            rec.forced = true;
            partyForce.scam = rec;
        } else if (tick > 6200) partyForce.scam = { failed: true };
    }
    for (const f of FORCED) {
        const run = f.run;
        if (!run || f.ended) continue;
        if (tick % 5 === 0) run.tick(tick);
        if (run.phase === 'done') {
            P.pieces.runEnded(run);
            f.ended = true;
            // (the human came to the party: back to the tour's stop)
            if (f.humanCame !== undefined && MODE === 'tour' && human.slot !== -1) {
                const h = hubByKey.get(STOPS[stopIndex]);
                sim.teleportHuman(h.x, h.z, 0);
            }
            continue;
        }
        // the Party Room: the human stands in the room during its Seers stop
        if (run.kind === 'party_room' && MODE === 'tour' && STOPS[stopIndex] === 'seers_bank' && Math.max(Math.abs(human.x - 2737), Math.abs(human.z - 3466)) > 6) sim.teleportHuman(2738, 3466, 0);
        // a drop party: the human goes to the party it heard of once the host drops (its piles show 100 ticks on) and
        // stays till it is over, wherever the tour was (a party that began late: its piles after the human's stop)
        if (run.kind === 'drop_party' && MODE === 'tour' && run.drops.length > 0 && human.slot !== -1 && cheb(human, { x: run.venue.drop[0], z: run.venue.drop[1] }) > 8) {
            const [dx, dz] = run.venue.drop;
            const spot = [[run.venue.x, run.venue.z], [dx + 3, dz], [dx - 3, dz], [dx, dz + 3], [dx, dz - 3]].find(([x, z]) => sim.isWalkable(x, z, 0)) ?? [dx, dz];
            sim.teleportHuman(spot[0], spot[1], 0);
            f.humanCame = tick;
        }
        // the human scrambles for a drop party's piles as a person does (a pile within 8 tiles 3-8 ticks after it shows,
        // then one every 4-8 ticks)
        if (run.kind !== 'drop_party' || human.slot === -1) continue;
        if (humanTarget) {
            if (!humanTarget.obj.isActive) {
                const got = human.getInventory(lib.InvType.INV);
                let n = 0;
                for (let s = 0; got && s < got.capacity; s++) if (got.get(s)?.id === humanTarget.obj.type) n += got.get(s).count;
                if (n > humanTarget.before) partyForce.human.takes.push({ t: tick, item: humanTarget.note.item, afterReveal: tick - humanTarget.note.revealAt });
                humanTarget = null;
                humanNextGrab = tick + 4 + Math.floor(humanDice() * 5);
            } else if (tick - humanTarget.since > 12) humanTarget = null;
            continue;
        }
        if (tick < humanNextGrab || human.target !== null || human.hasWaypoints()) continue;
        let best = null;
        for (const d of run.drops) {
            if (!d.obj.isActive || d.obj.receiver64 !== -1n || d.note.revealAt < 0) continue;
            let at = humanNotice.get(d.obj);
            if (at === undefined) humanNotice.set(d.obj, (at = d.note.revealAt + 3 + Math.floor(humanDice() * 6)));
            if (tick < at || cheb(d.obj, human) > 8) continue;
            if (!best || cheb(d.obj, human) < cheb(best.obj, human)) best = d;
        }
        if (!best) continue;
        const inv = human.getInventory(lib.InvType.INV);
        let before = 0;
        for (let s = 0; inv && s < inv.capacity; s++) if (inv.get(s)?.id === best.obj.type) before += inv.get(s).count;
        humanTarget = { obj: best.obj, note: best.note, since: tick, before };
        lib.interactObjOp(human, best.obj, 3);
        partyForce.human.clicks++;
    }
}
/** the library's logs, as plain data (the record) */
function collectParties() {
    if (!P) return;
    record.parties = P.party.partyLog.map(r => ({ ...r, drops: r.drops.map(d => ({ ...d })), chest: r.chest ? { ...r.chest } : null, pops: { ...r.pops }, hostGot: [...(r.hostGot ?? [])] }));
    record.scams = P.scams.scamLog.map(r => ({ ...r }));
    const name = human.username;
    record.lures = { approaches: P.social.approachLog.filter(a => a.human === name).map(a => ({ ...a })), lures: P.social.lureLog.filter(l => l.human === name).map(l => ({ ...l })), all: P.social.lureLog.length };
    record.partyHuman = { forced: FORCED.map(f => ({ kind: f.kind, venue: f.venue, at: f.at, started: !!f.run, gaveUp: !!f.gaveUp, why: f.why ?? null, humanCame: f.humanCame ?? null })), scam: partyForce.scam ? { forced: true, failed: !!partyForce.scam.failed } : null, takes: partyForce.human.takes, clicks: partyForce.human.clicks };
}
// ---- end of track P's block ----
// ---- (realism phase 5b, track A: the Duel Arena and the player-mod bot) A1-A6, Q1-Q3 ----
// record.arena (a members world, a library with port/BotArena): every 5 ticks the bots in the complex and online, the
// human's ticks in the challenge area; at the end the arena's own logs (its duels, its challenges to the human).
// record.modBot (a library with port/BotModBot): every 5 ticks whether a mod is online, every crowned line (Q3), the
// human's spam (--mod); at the end the mod's duty log and the spam it heard of. An older library: n/a.
// (where the stakers stand: the walkway south of the hospital, between it and the northern arenas)
const ARENA_SPOT = [3360, 3262];
const arenaMods = typeof lib.arenaModules === 'function' ? await lib.arenaModules() : { arena: null, duel: null, mod: null };
const arenaLib = arenaMods.arena && arenaMods.duel && MEMBERS ? arenaMods.arena : null;
const duelLib = arenaMods.duel;
const modLib = arenaMods.mod;
if (arenaLib) record.arena = { samples: 0, inArena: 0, online: 0, max: 0, humanTicks: 0, duels: [], challenges: [], cap: 0 };
if (modLib) {
    record.modBot = { samples: 0, online: 0, crowned: [], humanSpam: [], log: [], spam: [], mods: [] };
    lib.sayListeners.push((player, text) => {
        if ((player.chatRights ?? 0) > 0) record.modBot.crowned.push({ t: World.currentTick, name: player.username, rights: player.chatRights, mod: modLib.isPlayerModName(player.username), text });
    });
}
function arenaSample() {
    if (arenaLib) {
        let n = 0;
        for (const p of active) if (duelLib.inDuelArena(p.x, p.z, p.level)) n++;
        const a = record.arena;
        a.samples++;
        a.inArena += n;
        a.online += active.length;
        if (n > a.max) a.max = n;
    }
    if (record.modBot) {
        record.modBot.samples++;
        if (active.some(p => p.staffModLevel === 1)) record.modBot.online++;
    }
}
let modSpamAt = -1;
let modSpamLeft = 0;
/** --arena and --mod: the human in the challenge area for its time, or near the mod and spamming (true: the tour waits) */
function stagedTick(tick) {
    if (human.slot === -1) return false;
    if (arenaLib && duelLib.inChallengeArea(human.x, human.z, human.level)) record.arena.humanTicks++;
    if (ARENA_STOP && MEMBERS && tick >= ARENA_STOP.at && tick < ARENA_STOP.at + ARENA_STOP.ticks) {
        if (tick === ARENA_STOP.at || !duelLib?.inChallengeArea(human.x, human.z, human.level)) sim.teleportHuman(ARENA_SPOT[0], ARENA_SPOT[1], 0);
        return true;
    }
    if (ARENA_STOP && MEMBERS && tick === ARENA_STOP.at + ARENA_STOP.ticks) {
        const h = hubByKey.get(STILL ? AT : STOPS[stopIndex]);
        sim.teleportHuman(h.x, h.z, 0);
    }
    if (MOD_PROBE > 0 && modLib) {
        if (modSpamLeft > 0) {
            if (tick >= modSpamAt) {
                modSpamLeft--;
                modSpamAt = tick + 12;
                const line = 'selling lobs 160 ea';
                record.modBot.humanSpam.push({ t: tick, x: human.x, z: human.z });
                BotChat.onPublicMessage(human, line);
            }
            return true;
        }
        if (tick > WARMUP && tick % MOD_PROBE === 0) {
            const mod = active.find(p => p.staffModLevel === 1 && p.level === 0 && p.z < 6400 && wildernessLevelAt(p.x, p.z) === 0);
            if (mod) {
                for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2]]) {
                    if (sim.isWalkable(mod.x + dx, mod.z + dz, 0)) {
                        sim.teleportHuman(mod.x + dx, mod.z + dz, 0);
                        break;
                    }
                }
                modSpamLeft = 3;
                modSpamAt = tick + 3;
                return true;
            }
        }
    }
    return false;
}
/** the arena's and the mod's logs, at the end (copies: the record goes to JSON) */
function collectArena() {
    if (arenaLib) {
        record.arena.duels = arenaLib.duelLog.map(d => ({ ...d }));
        record.arena.challenges = arenaLib.challengeLog.map(c => ({ ...c }));
        record.arena.why = arenaLib.challengeStats ? JSON.parse(JSON.stringify(arenaLib.challengeStats)) : null;
        record.arena.asks = arenaLib.visitStats ? JSON.parse(JSON.stringify(arenaLib.visitStats)) : null;
        record.arena.cap = arenaLib.arenaCap?.() ?? 0;
    }
    if (record.modBot) {
        record.modBot.log = modLib.modLog.map(m => ({ ...m }));
        record.modBot.spam = modLib.spamLog.map(m => ({ ...m }));
        record.modBot.mods = [...modLib.playerModNames()];
    }
}
// ---- end of track A's (phase 5b) block ----

// ---- (variety round 1) each track's sampling in a block of its own: its tick (after the world's
// tick and the runner's own sampling: `tick % SAMPLE === 0 && tick >= WARMUP` for the vantage points' cadence) and
// its collect (after the run, before the metrics). Each keeps its record under record.tracks.<track>; the metrics
// read that (n/a when it is missing: an older library, an A/B run). ----
record.tracks = {};
// ---- Track F (fixes and movement) ----
// record.tracks.fixes (the variety work, round 1, track F):
//   fill      TP4f: the library's rescue jumps (BotAction.teleportStats by cause, 'event' left out) from the fill's first
//             login through FILL_WINDOW ticks, its bot-ticks, the world tick p95 in the fill's boost (its last login + 200
//             ticks, port/BotPathing) and after
//   gather    AM6: the gatherers' ticks walking about with no target, waiting at a taken rock or tree, waits given up
//             (BotTaskBase gatherStats)
//   bank      AM7: every levelling bot's arrivals in a bank state (M.BANK_STATES) at a skill's task (not a bankstand, a
//             hang-out, an errand or a set piece: FX_NOT_SKILL), its pack and total XP at each: three in a row with the
//             same pack and no XP between are a futile loop (the runner's own eyes); the library's guard's firings
//             (bankLoopStats) beside
//   messages  FM1: the failure messages bots get (can't reach, can't light a fire here, too full, stunned) by task
//   counters  the library's: budget waits, door openings and waits the stuck checks left out, watchdogs ended near the spot,
//             dungeon walks room by room, reach checks, fire lane steps, alching at bank stops, logins that lingered
// AL1's sightings of an alcher on a bank stop's stint (its sub-task 'Magic': the runner's own sampling reads the task)
// go into record.alchSightings beside the runner's.
const FX = typeof lib.fixesModules === 'function' ? await lib.fixesModules() : null;
const fx = { fillStart: -1, windowEnd: -1, windowJumps: null, windowRefused: null, windowCauses: null, windowBotTicks: 0, bank: new Map(), loops: [], visits: 0, futile: 0, messages: {} };
{
    const FAIL_TEXT = /can't reach|cannot reach|You can't light a fire here|too full to hold|You're stunned/i;
    const proto = lib.Player.prototype;
    const mes = proto.messageGame;
    proto.messageGame = function (text) {
        if (this.is_bot && typeof text === 'string' && FAIL_TEXT.test(text)) {
            const ai = BotManager.botFor(this);
            const task = ai?.subTask ?? ai?.currentTask ?? null;
            const key = `${taskKind(task?.name)}/${task?.state ?? '-'}|${text.slice(0, 50)}`;
            const o = fx.messages[key] ?? (fx.messages[key] = { n: 0, at: {} });
            o.n++;
            const at = `${(this.x >> 3) << 3},${(this.z >> 3) << 3}`;
            o.at[at] = (o.at[at] ?? 0) + 1;
        }
        return mes.call(this, text);
    };
}
const fxRescues = () => {
    let jumps = 0;
    let refused = 0;
    const causes = {};
    for (const [cause, [j, f]] of lib.teleportStats?.byCause ?? new Map()) {
        if (String(cause).split('/')[1]?.startsWith('event')) continue;
        jumps += j;
        refused += f;
        if (j > 0) causes[cause] = j;
    }
    return { jumps, refused, causes };
};
const fxPack = p => {
    const inv = p.getInventory(lib.InvType.INV);
    let key = '';
    for (let s = 0; inv && s < inv.capacity; s++) {
        const it = inv.get(s);
        if (it) key += `${it.id}x${it.count},`;
    }
    return key;
};
const fxXp = p => {
    let xp = 0;
    for (let i = 0; i < p.stats.length; i++) xp += p.stats[i];
    return xp;
};
const fxAlchSeen = new Map();
/** AM7: the task kinds whose bank trips are no skill's (a bankstand, a hang-out, an errand, a set piece): left out */
const FX_NOT_SKILL = new Set(['Bankstand', 'Hangout', 'Social', 'Vendor', 'DuelArena', 'ShopTrip', 'Bank', 'Idle', 'PartyGuest', 'PartyHost', 'ScamCall', 'Rest', 'FoodTrip', 'LawTrip', 'Newbie', 'Init', 'ComeHere', 'Linger', 'Magic', 'none']);
function varietyFTick(tick) {
    if (fx.fillStart < 0 && active.length > 0) fx.fillStart = tick;
    if (fx.fillStart >= 0 && tick < fx.fillStart + FILL_WINDOW) fx.windowBotTicks += active.length;
    if (fx.fillStart >= 0 && fx.windowJumps === null && tick >= fx.fillStart + FILL_WINDOW - 1) {
        const r = fxRescues();
        fx.windowEnd = tick;
        fx.windowJumps = r.jumps;
        fx.windowRefused = r.refused;
        fx.windowCauses = r.causes;
    }
    // AM7: arrivals in a bank state, levelling bots
    for (const p of active) {
        const r = recs.get(p);
        if (!r || !r.kinds) continue;
        const inBank = r.state !== null && M.BANK_STATES.has(r.state) && !FX_NOT_SKILL.has(r.kind);
        let b = fx.bank.get(r);
        if (!b) fx.bank.set(r, (b = { in: false, pack: null, xp: -1, kind: null, streak: 0 }));
        if (inBank && !b.in) {
            fx.visits++;
            const pack = fxPack(p);
            const xp = fxXp(p);
            const same = b.pack !== null && b.kind === r.kind && b.pack === pack && b.xp === xp;
            if (same) {
                fx.futile++;
                b.streak++;
                if (b.streak === 2) fx.loops.push({ t: tick, name: r.name, task: r.kind, state: r.state, at: [p.x, p.z, p.level], humanDist: humanDist(p.x, p.z, p.level) });
            } else b.streak = 0;
            b.pack = pack;
            b.xp = xp;
            b.kind = r.kind;
        }
        b.in = inBank;
    }
    // AL1: an alcher on a bank stop's stint (its sub-task) in the human's view at a trade bank, a bot again after 10 minutes
    if (tick % SAMPLE === 0 && tick >= WARMUP && human.slot !== -1) {
        for (const p of active) {
            if (p.level !== human.level || cheb(p, human) > M.VIEW) continue;
            const sub = recs.get(p)?.bot?.subTask ?? null;
            if (sub?.name !== 'Magic') continue;
            const bank = lib.TRADE_BANKS.find(b => b.center[2] === p.level && Math.max(Math.abs(b.center[0] - p.x), Math.abs(b.center[1] - p.z)) <= 10);
            if (!bank) continue;
            const key = `${p.username}|${bank.key}`;
            const last = fxAlchSeen.get(key);
            fxAlchSeen.set(key, tick);
            if (last !== undefined && tick - last < M.SHOW_OFF_AGAIN) continue;
            record.alchSightings.push({ t: tick, name: p.username, bank: bank.key, state: sub.state ?? null, stop: true });
        }
    }
}
function varietyFCollect() {
    const all = fxRescues();
    if (fx.windowJumps === null) {
        fx.windowJumps = all.jumps;
        fx.windowRefused = all.refused;
        fx.windowCauses = all.causes;
        fx.windowEnd = World.currentTick;
    }
    // the world tick in the fill's boost (from the first login to the fill's end + 200 ticks) and after it
    const boostEnd = (record.meta.fillTick >= 0 ? record.meta.fillTick : fx.fillStart) + 200;
    const pick = (lo, hi) => sim.samples.filter(s => s.tick >= lo && s.tick < hi).map(s => s.cycleMs).sort((a, b) => a - b);
    const p95 = xs => (xs.length ? +xs[Math.min(xs.length - 1, Math.floor(0.95 * xs.length))].toFixed(3) : null);
    const g = FX?.base?.gatherStats ?? null;
    record.tracks.fixes = {
        fill: { start: fx.fillStart, window: FILL_WINDOW, windowEnd: fx.windowEnd, jumps: fx.windowJumps, refused: fx.windowRefused, causes: fx.windowCauses, botTicks: fx.windowBotTicks, allJumps: all.jumps, allRefused: all.refused, allCauses: all.causes, boostP95: p95(pick(fx.fillStart, boostEnd)), afterP95: p95(pick(boostEnd, Infinity)) },
        gather: g ? JSON.parse(JSON.stringify(g)) : null,
        bank: { visits: fx.visits, futile: fx.futile, loops: fx.loops, guard: FX?.base?.bankLoopStats ? JSON.parse(JSON.stringify(FX.base.bankLoopStats)) : null },
        messages: fx.messages,
        counters: FX?.base?.stuckWaitStats
            ? {
                  budgetWaits: FX.action?.budgetWaitStats?.waits ?? null,
                  stuckChecksHeld: FX.base.stuckWaitStats.stuckChecks,
                  watchdogChecksHeld: FX.base.stuckWaitStats.watchdogChecks,
                  watchdogEndedNear: FX.base.watchdogStats?.endedNear ?? null,
                  dungeon: FX.action?.dungeonWalkStats ? { ...FX.action.dungeonWalkStats } : null,
                  reach: FX.base.reachStats ? { ...FX.base.reachStats } : null,
                  fire: FX.fire?.fireStats ? { ...FX.fire.fireStats } : null,
                  alchStops: FX.alch?.alchStopStats ? { ...FX.alch.alchStopStats } : null,
                  lingers: FX.linger?.lingerStats?.lingers ?? null
              }
            : null
    };
}
// ---- end of Track F's block ----
// ---- Track D (what and where) ----
// The bots' doings and places (lib/humanlike-metrics.mjs's Track D block reads record.tracks.d: AM1-AM8): every
// D_SAMPLE ticks after the warm-up, each bot's task kind (levelling bots': the 2004 mix, AM1; their name's theme, AM4;
// a session's first and last activity, AM5), the spot its task works and how many work it (AM2, port/BotSpots' key and
// capacity), the 2004 places with someone in them (AM3, M.VARIETY_PLACES); every tick, each levelling bot's new task and
// how far its spot is from where it took it (AM8). The library's modules on demand: an older one (an A/B run) has
// none, and AM2's capacities and AM4 read n/a (its key falls back to the step's action and place).
const D_SAMPLE = 10;
const dMods = typeof lib.varietyDModules === 'function' ? await lib.varietyDModules() : { spots: null, favourites: null, knowledge: null, powerDrop: null };
const dRec = {
    sample: D_SAMPLE,
    samples: 0,
    levellingSamples: 0,
    groups: {},
    kinds: {},
    byPlanner: {},
    online: 0,
    essence: 0,
    crowd: { samples: 0, stepBots: 0, inCrowd: 0, spots: {} },
    places: { samples: 0, seen: {}, bots: {} },
    themes: {},
    sessions: [],
    starts: [],
    drops: null
};
record.tracks.d = dRec;
const dTask = new WeakMap(); // bot -> its task object last tick
const dSession = new Map(); // session id -> { name, first, firstTick, last, lastTick }
function dStepOf(task) {
    if (!task) return null;
    if (dMods.spots?.stepOfTask) return dMods.spots.stepOfTask(task);
    if (task.name === 'Fletching') return task.wcStep ?? null;
    try {
        return task.activityStep?.() ?? null;
    } catch {
        return null;
    }
}
function dSpotKey(step) {
    return dMods.spots?.spotKey ? dMods.spots.spotKey(step) : `${step.action}@${step.location.join(',')}`;
}
function dSurface(x, z) {
    if (dMods.knowledge?.stepSurface) return dMods.knowledge.stepSurface({ location: [x, z, 0] });
    if (z <= 6400) return [x, z];
    const route = dMods.knowledge?.dungeonRoute?.(x, z);
    return route ? [route.entrance[0], route.entrance[1]] : [x, z - 6400];
}
function varietyDTick(tick) {
    // (AM8) a levelling bot's new task: how far its spot is from where it took it
    for (const p of active) {
        if (!M.LEVELLING.has(p.botPlanner)) continue;
        const r = recs.get(p);
        const task = r?.bot?.currentTask ?? null;
        if (dTask.get(p) === task) continue;
        dTask.set(p, task);
        const kind = taskKind(task?.name);
        if (!task || !M.ACTIVITY_GROUP[kind] || kind === 'Fletching' || tick < WARMUP) continue;
        const step = dStepOf(task);
        if (!step) continue;
        const [sx, sz] = dSurface(step.location[0], step.location[1]);
        const [px, pz] = dSurface(p.x, p.z);
        dRec.starts.push({ kind, dist: Math.max(Math.abs(sx - px), Math.abs(sz - pz)) });
    }
    if (tick % D_SAMPLE !== 0 || tick < WARMUP) return;
    dRec.samples++;
    dRec.online += active.length;
    const spots = new Map(); // spot key -> [bots, a step]
    const places = new Map();
    for (const p of active) {
        const r = recs.get(p);
        if (!r) continue;
        const task = lib.hangoutOf(p) ?? setPieceTaskOf(p) ?? r.bot?.currentTask ?? null;
        const kind = taskKind(task?.name);
        if (kind === 'Essence') dRec.essence++;
        // (AM3) the 2004 place it is in
        const place = M.varietyPlaceAt(p.x, p.z, p.level, MEMBERS);
        if (place) places.set(place, (places.get(place) ?? 0) + 1);
        // (AM2) the spot its task works
        const step = dStepOf(r.bot?.currentTask ?? null);
        if (step) {
            const key = dSpotKey(step);
            const e = spots.get(key);
            if (e) e[0]++;
            else spots.set(key, [1, step]);
        }
        if (!M.LEVELLING.has(p.botPlanner)) continue;
        // (AM1) a levelling bot's time by kind and group
        dRec.levellingSamples++;
        dRec.kinds[kind] = (dRec.kinds[kind] ?? 0) + 1;
        const byPlanner = dRec.byPlanner[p.botPlanner] ?? (dRec.byPlanner[p.botPlanner] = {});
        byPlanner[kind] = (byPlanner[kind] ?? 0) + 1;
        const group = M.ACTIVITY_GROUP[kind] ?? 'other';
        dRec.groups[group] = (dRec.groups[group] ?? 0) + 1;
        // (AM4) a themed bot's time
        const theme = dMods.favourites?.themeOf?.(p.username) ?? null;
        if (theme) {
            const t = dRec.themes[p.username] ?? (dRec.themes[p.username] = { skill: theme.skills[0], word: theme.word, n: 0, on: 0 });
            t.n++;
            if ((M.THEME_KINDS[theme.skills[0]] ?? []).includes(kind)) t.on++;
        }
        // (AM5) its session's first and last activity
        if (M.ACTIVITY_GROUP[kind]) {
            let sess = dSession.get(r.s);
            if (!sess) dSession.set(r.s, (sess = { name: r.name, first: group, firstTick: tick, last: group, lastTick: tick }));
            sess.last = group;
            sess.lastTick = tick;
        }
    }
    // (AM2) the bots on a spot with 4+ others, and each spot's occupants against what it holds
    let stepBots = 0;
    let inCrowd = 0;
    for (const [key, [n, step]] of spots) {
        stepBots += n;
        if (n >= 5) inCrowd += n;
        const sp = dRec.crowd.spots[key] ?? (dRec.crowd.spots[key] = { samples: 0, bots: 0, max: 0, cap: dMods.spots?.spotCapacity ? dMods.spots.spotCapacity(step) : null });
        sp.samples++;
        sp.bots += n;
        sp.max = Math.max(sp.max, n);
    }
    dRec.crowd.samples++;
    dRec.crowd.stepBots += stepBots;
    dRec.crowd.inCrowd += inCrowd;
    dRec.places.samples++;
    for (const [place, n] of places) {
        dRec.places.seen[place] = (dRec.places.seen[place] ?? 0) + 1;
        dRec.places.bots[place] = (dRec.places.bots[place] ?? 0) + n;
    }
}
function varietyDCollect() {
    dRec.sessions = [...dSession.entries()].map(([s, v]) => ({ s, ...v }));
    // (AM10, report) the unseen jumps (the runner's 'jump' class: not stairs, a boat, an obstacle or a marked move) by
    // where they left from and the task: where a new spot's walks fail
    dRec.jumps = {};
    for (const j of record.jumps) {
        if (j.cls !== 'jump' || j.afterDeath) continue;
        const key = `${j.task}@${M.varietyPlaceAt(j.from[0], j.from[1], j.from[2], MEMBERS) ?? `${j.from[0] >> 6},${j.from[1] >> 6}`}`;
        dRec.jumps[key] = (dRec.jumps[key] ?? 0) + 1;
    }
    const drops = dMods.powerDrop?.dropStats;
    dRec.drops = drops ? { ...drops } : null;
}
// ---- end of Track D's block ----
// ---- Track S (what they say) ----
// record.tracks.say: the chatter's counts (port/BotChatter talkStats: lines about the bot's moment, W6; the responses and
// what they followed, W3; idle lines held for company and dropped, W5), each line's meaning key (port/BotLines meaningKey:
// the registry's, W1, W4, W9, W11), the keys of the death lines (W1) and of upstream's lines (W11). Nothing per tick.
function varietySTick(tick) {}
function varietySCollect() {
    const talkStats = lib.SayChatter?.talkStats;
    const meaningKey = lib.SayLines?.meaningKey;
    if (typeof talkStats !== 'function' || typeof meaningKey !== 'function') return;
    record.tracks.say = {
        talk: talkStats(),
        keys: record.lines.map(l => meaningKey(l.text)),
        deathKeys: [...new Set(lib.SayLines.ALL_LINES.filter(l => l.tag.c === 'death').map(l => meaningKey(l.text)))],
        upstreamKeys: [...new Set(lib.SayLines.UPSTREAM_LINES.map(l => meaningKey(l.text)))]
    };
}
// ---- end of Track S's block ----
// ---- Track W (what they wear) ----
// The looks census (the wear track's prototype): every WEAR_EVERY ticks after
// the warm-up, each bot online: its 14 worn slots (item ids; their debugnames once in `names`), its task's kind, a
// RangedMagic task's mode (ranged or magic), its tile, combat level, whether a newbie, and the class its name promises
// with whether it wears that class's look (port/BotOutfits; null with an older library). L2-L8 read it.
const wearOutfits = typeof lib.wearModules === 'function' ? (await lib.wearModules()).outfits : null;
const wearRecord = { every: WEAR_EVERY, names: {}, samples: [] };
function varietyWTick(tick) {
    if (tick % WEAR_EVERY !== 0 || tick < WARMUP) return;
    for (const p of active) {
        const worn = p.getInventory(lib.InvType.WORN);
        const ids = [];
        for (let i = 0; i < 14; i++) {
            const id = worn?.get(i)?.id ?? -1;
            ids.push(id);
            if (id !== -1 && wearRecord.names[id] === undefined) wearRecord.names[id] = objName(id);
        }
        const task = (recs.get(p)?.bot ?? BotManager.botFor(p))?.currentTask ?? null;
        const kind = taskKind(task?.name);
        const mode = kind === 'RangedMagic' && (task.mode === 'ranged' || task.mode === 'magic') ? task.mode : null;
        let cls = null;
        let inClass = null;
        if (wearOutfits) {
            cls = wearOutfits.nameClassOf(p.username);
            if (cls) inClass = wearOutfits.inClassLook(p.username, ids, MEMBERS);
        }
        let newbie = false;
        try {
            newbie = lib.isNewbie(p) === true;
        } catch {
            newbie = false;
        }
        wearRecord.samples.push({ t: tick, s: recs.get(p)?.s ?? -1, n: p.username, p: p.botPlanner, w: ids, k: kind, m: mode, x: p.x, z: p.z, l: p.level, cb: p.combatLevel, nb: newbie, cls, ic: inClass });
    }
}
function varietyWCollect() {
    record.tracks.wear = wearRecord;
    if (WEAR_CENSUS) fs.writeFileSync(path.resolve(START_CWD, WEAR_CENSUS), wearRecord.samples.map(x => JSON.stringify({ ...x, w: x.w.map(i => (i === -1 ? null : wearRecord.names[i])) })).join('\n') + '\n');
}
// ---- end of Track W's block ----
// ---- (variety round 2) each track's sampling in a block of its own, as round 1's: its record under record.tracks.<key>
// (activities2, members, talk2, fashion) ----
// ---- Track D2 (new activities) ----
// The round's activities (lib/humanlike-metrics.mjs's Track D2 block reads record.tracks.activities2: AM11, AM1c, AF1,
// QA1, QA1b, MR1, HB1, WT1, TR1): every D2_SAMPLE ticks after the warm-up, each bot's task kind (a hosted errand's is its
// host's: the current task's name), a combat 3-20 levelling bot's (AM11: the chains' share), a newcomer's (QA1b), a
// levelling bot in the Wilderness (WT1), the Lumbridge fields, mill and swamp occupied (AF1); every tick, a new quest
// look-alike (QA1) and an agility plan's walk to its course (TR1: the ticks from its start to the course, a ride or not).
// The library's counts at the end (the errands, the offers, the lines, the trips, the rides): n/a for an older library.
const D2_SAMPLE = 10;
const d2Mods = typeof lib.activities2Modules === 'function' ? await lib.activities2Modules() : { errand: null, picks: null, lines: null, wild: null, travel: null, magic: null };
/** (MR1's detail) every D2_MAGIC_LOOK ticks, the levelling bots that could start each prayer or magic run (its runes, items, levels) */
const D2_MAGIC_LOOK = 600;
/** the economy chains' task kinds (port/BotChains) */
const D2_CHAINS = new Set(['Hides', 'Feathers', 'Pottery', 'Flour', 'Picking', 'FireCook', 'Bronze']);
/** the Lumbridge fields, the mill and the swamp (AF1): boxes [key, x0, z0, x1, z1] */
const D2_FIELDS = [
    ['wheat', 3214, 3330, 3230, 3358], ['potatoes_west', 3140, 3262, 3160, 3292], ['potatoes_east', 3238, 3296, 3258, 3318],
    ['cabbages_draynor', 3040, 3280, 3070, 3300], ['mill', 3158, 3298, 3172, 3312], ['chicken_farm', 3224, 3292, 3238, 3304],
    ['lumbridge_swamp', 3140, 3140, 3260, 3199]
];
const d2Rec = {
    sample: D2_SAMPLE,
    samples: 0,
    online: 0,
    levelling: 0,
    low: 0,
    lowChain: 0,
    lowKinds: {},
    kinds: {},
    newbie: 0,
    newbieKinds: {},
    wild: 0,
    wildTrip: 0,
    wildBy: {},
    fields: Object.fromEntries(D2_FIELDS.map(f => [f[0], { bots: 0, seen: 0 }])),
    questStarts: 0,
    questStartsBy: {},
    agility: [],
    magicLooks: 0,
    magicOpen: {},
    lib: null
};
record.tracks.activities2 = d2Rec;
const d2Task = new WeakMap(); // bot -> its task object last tick
const d2Agility = new WeakMap(); // bot -> { task, start, dist, rode }
function d2Box(x, z) {
    for (const [key, x0, z0, x1, z1] of D2_FIELDS) if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return key;
    return null;
}
function varietyD2Tick(tick) {
    for (const p of active) {
        const r = recs.get(p);
        const task = r?.bot?.currentTask ?? null;
        if (d2Task.get(p) !== task) {
            d2Task.set(p, task);
            const kind = taskKind(task?.name);
            if (kind === 'Quest' && tick >= WARMUP) {
                d2Rec.questStarts++;
                const key = task.name.split(':')[1] ?? '?';
                d2Rec.questStartsBy[key] = (d2Rec.questStartsBy[key] ?? 0) + 1;
            }
            // (TR1) an agility plan: how far its course, and when the bot gets there
            if (kind === 'Agility' && M.LEVELLING.has(p.botPlanner)) {
                const step = dStepOf(task);
                if (step && step.location[2] === 0) d2Agility.set(p, { task, start: tick, dist: Math.max(Math.abs(step.location[0] - p.x), Math.abs(step.location[1] - p.z)), at: step.location, rode: false });
            }
        }
        const ag = d2Agility.get(p);
        if (ag) {
            if (ag.task !== task) d2Agility.delete(p);
            else {
                if (r?.bot?.subTask?.name === 'Travel') ag.rode = true;
                if (p.level === 0 && Math.max(Math.abs(p.x - ag.at[0]), Math.abs(p.z - ag.at[1])) <= 20) {
                    d2Rec.agility.push({ dist: ag.dist, ticks: tick - ag.start, rode: ag.rode });
                    d2Agility.delete(p);
                }
            }
        }
    }
    if (tick % D2_SAMPLE !== 0 || tick < WARMUP) return;
    d2Rec.samples++;
    d2Rec.online += active.length;
    const fieldsNow = new Set();
    for (const p of active) {
        const r = recs.get(p);
        if (!r) continue;
        const kind = taskKind(r.bot?.currentTask?.name);
        const box = p.level === 0 ? d2Box(p.x, p.z) : null;
        if (box) {
            d2Rec.fields[box].bots++;
            fieldsNow.add(box);
        }
        if (lib.isNewbie(p)) {
            d2Rec.newbie++;
            d2Rec.newbieKinds[kind] = (d2Rec.newbieKinds[kind] ?? 0) + 1;
        }
        if (!M.LEVELLING.has(p.botPlanner)) continue;
        d2Rec.levelling++;
        d2Rec.kinds[kind] = (d2Rec.kinds[kind] ?? 0) + 1;
        if (p.combatLevel >= 3 && p.combatLevel <= 20 && !lib.isNewbie(p)) {
            d2Rec.low++;
            if (D2_CHAINS.has(kind)) d2Rec.lowChain++;
            d2Rec.lowKinds[kind] = (d2Rec.lowKinds[kind] ?? 0) + 1;
        }
        if (p.level === 0 && wildernessLevelAt(p.x, p.z) > 0) {
            d2Rec.wild++;
            d2Rec.wildBy[kind] = (d2Rec.wildBy[kind] ?? 0) + 1;
            if (kind === 'WildTrip' || kind === 'WildMine') d2Rec.wildTrip++;
        }
    }
    for (const key of fieldsNow) d2Rec.fields[key].seen++;
    // (MR1) who could start each run now: its plan's own check, which reads the bot's pack and bank and moves nothing
    if (tick % D2_MAGIC_LOOK === 0 && d2Mods.magic?.MAGIC_RUNS) {
        for (const p of active) {
            if (!M.LEVELLING.has(p.botPlanner)) continue;
            d2Rec.magicLooks++;
            for (const [key, make] of Object.entries(d2Mods.magic.MAGIC_RUNS)) {
                const plan = make();
                if (plan.members && !MEMBERS) continue;
                if (!plan.ok || plan.ok(p)) d2Rec.magicOpen[key] = (d2Rec.magicOpen[key] ?? 0) + 1;
            }
        }
    }
}
function varietyD2Collect() {
    const copy = x => (x ? JSON.parse(JSON.stringify(x)) : null);
    d2Rec.lib = {
        errands: copy(d2Mods.errand?.errandStats),
        talks: copy(d2Mods.errand?.talkStats),
        picks: copy(d2Mods.picks?.d2PickStats),
        lines: copy(d2Mods.lines?.errandLineStats),
        wild: copy(d2Mods.wild?.wildStats),
        travel: copy(d2Mods.travel?.travelStats)
    };
}
// ---- end of Track D2's block ----
// ---- Track M (members places and minigames) ----
// record.tracks.members (lib/humanlike-metrics.mjs's Track M block: FT1, MG1, MG2, CB1, SF1, FT2): every M_SAMPLE ticks
// after the warm-up, the bots in the far towns (M.VARIETY_PLACES' 'f' places) and on a minigame (port/BotOutings'
// MINIGAME_KINDS: the Trawler at sea, the Agility Arena below Brimhaven count wherever they are), by place and kind; the
// levelling bots' minigame time (MG1); who is in Catherby and fishing there (CB1), at Seers' flax and wheel (SF1), in
// Ardougne's market and by Falador's west bank (H1's empty hotspots, by what they do); at the end the outings' and the
// minigames' logs (port/BotOutings outingLog, minigameStats). The module on demand: an older library has none, and the
// kinds fall back to the names the track gives its tasks.
const M_SAMPLE = 10;
const mMods = typeof lib.membersModules === 'function' ? await lib.membersModules() : { outings: null };
// (a staged world has the outings' hooks off: test/lib/simworld.ts; the report's world is the game's, with them)
mMods.outings?.setOutingRatesForTest?.(1);
const M_MINIGAMES = new Set(mMods.outings?.MINIGAME_KINDS ?? ['Trawler', 'AgilityArena', 'RangingGuild', 'TreasureTrail']);
const M_FAR = new Set(M.VARIETY_PLACES.filter(p => p.far).map(p => p.key));
const mRec = {
    sample: M_SAMPLE,
    samples: 0,
    online: 0,
    levellingSamples: 0,
    far: {},
    farBots: 0,
    farKinds: {},
    minigame: {},
    minigameLevelling: 0,
    outing: {},
    places: { catherby: { n: 0, kinds: {} }, seers_flax: { n: 0, kinds: {} }, seers_wheel: { n: 0, kinds: {} }, ardougne_market: { n: 0, kinds: {} }, falador_west_bank: { n: 0, kinds: {} } },
    log: null,
    stats: null,
    picks: null,
    idle: null,
    idleAt: {}
};
const mIdleSeen = new Set();
/** (diagnostics) a file to write the Track M record to, with each levelling bot's samples by kind and place */
const M_DUMP = process.env.M_DUMP ?? null;
if (M_DUMP) mRec.byBot = {};
record.tracks.members = mRec;
function mPlaceCount(key, kind) {
    const pl = mRec.places[key];
    pl.n++;
    pl.kinds[kind] = (pl.kinds[kind] ?? 0) + 1;
}
function varietyMTick(tick) {
    if (tick % M_SAMPLE !== 0 || tick < WARMUP) return;
    mRec.samples++;
    mRec.online += active.length;
    for (const p of active) {
        const r = recs.get(p);
        if (!r) continue;
        const task = r.bot?.currentTask ?? null;
        const kind = taskKind(task?.name);
        const levelling = M.LEVELLING.has(p.botPlanner);
        if (levelling) mRec.levellingSamples++;
        const place = M.varietyPlaceAt(p.x, p.z, p.level, MEMBERS);
        const mini = M_MINIGAMES.has(kind);
        // (FT1) in a far town, or on a minigame wherever it is (the trawler at sea, the arena underground)
        if ((place && M_FAR.has(place)) || mini) {
            mRec.farBots++;
            const key = place && M_FAR.has(place) ? place : `minigame:${kind}`;
            mRec.far[key] = (mRec.far[key] ?? 0) + 1;
            mRec.farKinds[kind] = (mRec.farKinds[kind] ?? 0) + 1;
        }
        if (mini) {
            mRec.minigame[kind] = (mRec.minigame[kind] ?? 0) + 1;
            if (levelling) mRec.minigameLevelling++;
        }
        const outing = mMods.outings?.outingOf?.(p) ?? null;
        if (outing) mRec.outing[outing] = (mRec.outing[outing] ?? 0) + 1;
        // (H19's idle stands past 2 min, where they are: once a stand, by kind and place, an outing's by its key)
        if (levelling && r.idleStart >= 0 && tick - r.idleStart >= 200 && !mIdleSeen.has(`${r.s}:${r.idleStart}`)) {
            mIdleSeen.add(`${r.s}:${r.idleStart}`);
            const where = `${r.idleKind}@${outing ?? place ?? `${p.x >> 6}_${p.z >> 6}`}`;
            mRec.idleAt[where] = (mRec.idleAt[where] ?? 0) + 1;
            // (M_DUMP: with the task's state and the tile)
            if (M_DUMP) (mRec.idleStates ??= []).push(`${r.idleKind}/${task?.state ?? r.state ?? '-'}@${p.x},${p.z},${p.level} t${tick}`);
        }
        // (CB1, SF1, H1's hotspots by what they do)
        if (p.level === 0 && place === 'catherby') mPlaceCount('catherby', kind);
        // (M_DUMP: each levelling bot's samples by kind and place, for an A/B of who went where)
        if (M_DUMP && levelling) {
            const b = (mRec.byBot[p.username] ??= {});
            const key = `${kind}@${place ?? '-'}`;
            b[key] = (b[key] ?? 0) + 1;
        }
        if (p.level === 0 && place === 'seers_flax_field') mPlaceCount('seers_flax', kind);
        if (p.level === 1 && Math.abs(p.x - 2711) <= 6 && Math.abs(p.z - 3471) <= 6) mPlaceCount('seers_wheel', kind);
        if (p.level === 0 && Math.abs(p.x - 2662) <= M.VIEW && Math.abs(p.z - 3305) <= M.VIEW) mPlaceCount('ardougne_market', kind);
        if (p.level === 0 && Math.abs(p.x - 2946) <= M.VIEW && Math.abs(p.z - 3368) <= M.VIEW) mPlaceCount('falador_west_bank', kind);
    }
}
function varietyMCollect() {
    const o = mMods.outings;
    if (o) {
        mRec.log = typeof o.outingLog === 'object' ? o.outingLog.slice(-2000) : null;
        mRec.stats = typeof o.minigameStats === 'function' ? o.minigameStats() : null;
        mRec.picks = typeof o.pickStats === 'function' ? o.pickStats() : null;
    }
    // (H19's idle stands of 2-10 min by task kind: whether the minigames' waits are among them)
    mRec.idle = {};
    for (const st of record.idleStands) if (M.LEVELLING.has(st.planner) && st.len >= 200 && st.len <= 1000) mRec.idle[st.kind] = (mRec.idle[st.kind] ?? 0) + 1;
    if (M_DUMP) fs.writeFileSync(path.resolve(START_CWD, M_DUMP), JSON.stringify(mRec));
}
// ---- end of Track M's block ----
// ---- Track S2 (conversation) ----
// record.tracks.talk2: the deaths as the runner saw them, each with the players within 10 tiles (W10's "with company"),
// the clique mates' time together (two or more of a clique within 6 tiles of each other, sampled every 50 ticks) and
// the lines one said to another within 6 tiles of it, their hellos and goodbyes apart (W13), the reactions the library said and what about (port/BotWitness witnessLog: W10, W14,
// W15), the thread engine's counts (port/BotThreads threadStats: W7c). An older library (an A/B run) has none of the
// modules: the log and the counts are then null and those measures n/a.
const talk2Mods = typeof lib.talk2Modules === 'function' ? await lib.talk2Modules() : { threads: null, witness: null, voice: null };
const talk2Rec = { deaths: [], deathsSeen: 0, together: 0, linesSeen: 0, mate: { lines: 0, greets: 0, banter: 0, threads: 0 } };
/**
 * a clique's rituals (port/BotCliques' greetings, goodbyes and travel words, a {nick} any name): W13 counts the talk
 * between mates, not these
 */
const cliqueRituals = (() => {
    const c = lib.BotCliques?.CLIQUE_LINES ?? {};
    const out = [];
    for (const pool of ['greet', 'greetPlain', 'greetBack', 'greetBackPlain', 'bye', 'byePlain', 'byeBack', 'byeBackPlain', 'meToo', 'lead', 'follow']) {
        for (const t of c[pool] ?? []) out.push(new RegExp(`^${M.normalized(t.replaceAll('{nick}', 'NICK')).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('nick', '[a-z0-9]+( [a-z0-9]+)?')}$`));
    }
    return out;
})();
function varietyS2Tick(tick) {
    // (a line one clique mate said to another within 6 tiles of it: W13's talk together; their hellos, goodbyes and travel
    // words apart)
    const same = lib.BotCliques?.sameClique;
    while (talk2Rec.linesSeen < record.lines.length) {
        const l = record.lines[talk2Rec.linesSeen++];
        if (typeof same !== 'function' || !l.toName || M.isAside(l) || !same(l.name, l.toName)) continue;
        const to = active.find(p => p.username === l.toName);
        if (!to || to.level !== l.level || Math.max(Math.abs(to.x - l.x), Math.abs(to.z - l.z)) > 6) continue;
        const said = M.normalized(l.text);
        if (M.HELLO_LINE.test(l.text.trim()) || M.isDeparture(l.text) || cliqueRituals.some(rx => rx.test(said))) {
            talk2Rec.mate.greets++;
            continue;
        }
        talk2Rec.mate.lines++;
        if (l.kind === 'practice') talk2Rec.mate.threads++;
        else if (l.kind === 'idle' || l.kind === 'event') talk2Rec.mate.banter++;
    }
    // (a death this tick: 274's death script says it where the bot fell; who stands within 10 tiles of it now)
    while (talk2Rec.deathsSeen < record.deaths.length) {
        const d = record.deaths[talk2Rec.deathsSeen++];
        let level = 0;
        let company = 0;
        for (const p of active) if (p.username === d.name) level = p.level;
        for (const p of [...active, human]) if (p.username !== d.name && p.level === level && Math.max(Math.abs(p.x - d.x), Math.abs(p.z - d.z)) <= 10) company++;
        // (a loss at the Duel Arena says "Oh dear you are dead!" too, and is no death: 274's duel heals both)
        const arena = d.x >= 3325 && d.x <= 3395 && d.z >= 3195 && d.z <= 3285;
        talk2Rec.deaths.push({ t: d.t, name: d.name, x: d.x, z: d.z, level, company, arena });
    }
    if (tick % 50 !== 0 || tick < WARMUP || typeof lib.BotCliques?.cliqueOf !== 'function') return;
    const byClique = new Map();
    for (const p of active) {
        if (!p.is_bot) continue;
        const clique = lib.BotCliques.cliqueOf(p.username);
        if (!clique) continue;
        const key = clique.join(',');
        (byClique.get(key) ?? byClique.set(key, []).get(key)).push(p);
    }
    for (const members of byClique.values()) {
        if (members.length < 2) continue;
        const together = members.some((a, i) => members.some((b, j) => j > i && a.level === b.level && Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) <= 6));
        if (together) talk2Rec.together += 50;
    }
}
function varietyS2Collect() {
    record.tracks.talk2 = {
        deaths: talk2Rec.deaths,
        mates: { together: talk2Rec.together, ...talk2Rec.mate },
        witness: talk2Mods.witness?.witnessLog ? talk2Mods.witness.witnessLog.map(w => ({ ...w })) : null,
        witnessStats: talk2Mods.witness?.witnessStats ? { ...talk2Mods.witness.witnessStats } : null,
        voiceHeld: typeof talk2Mods.voice?.voiceHeldCount === 'function' ? talk2Mods.voice.voiceHeldCount() : null,
        threads: typeof talk2Mods.threads?.threadStats === 'function' ? talk2Mods.threads.threadStats() : null
    };
}
// ---- end of Track S2's block ----
// ---- Track W2 (fashion) ----
// The fashion census (variety round 2, track W2: the research WEAR-4, -7, -8, -9; record.tracks.fashion):
// every FASHION_EVERY ticks after the warm-up, each bot online: its 14 worn slots (item ids; their debugnames, members flags
// and kinds once in `items`), its bank value (port/BotFashion wealthOf: rich from RICH_WEALTH), task, tile, tier by its
// name (port/BotAge ageTierFor), and a woman's hair kit (the bald one counted, new bodies); and the show-off visits'
// counts (port/BotShowOff showOffStats). L6, L6b, L9, L10, L11 read it; n/a with an older library.
const fashionLib = typeof lib.fashionModules === 'function' ? await lib.fashionModules() : null;
const fashionRecord = { every: FASHION_EVERY, rich: fashionLib?.fashion?.RICH_WEALTH ?? null, items: {}, names: [], samples: [], baldKit: fashionLib?.baldKit ?? null, showOff: null, vendorLooks: 0, statusVendors: 0 };
const fashionNameIdx = new Map();
function fashionItem(id) {
    if (id === -1 || fashionRecord.items[id]) return;
    const F = fashionLib?.fashion;
    const type = lib.ObjType.get(id);
    const status = F?.statusPieceOf?.(id);
    fashionRecord.items[id] = { n: type?.debugname ?? String(id), m: type?.members === true, s: status ? status.family : null };
}
// (the game's own moves at the guilds the round's shop trips walk into, which the runner's classes take for jumps: the
// Champions' Guild's door puts the player through by p_teleport, 3 tiles, and its stairs move it 4; the Heroes' Guild's
// spiral stairs 1. Each is a door or stairs, as a player's; AM10 counted them as unseen jumps, 15 at m500 s4)
const GUILD_MOVES = [
    [3183, 3344, 3200, 3367],
    [2885, 3500, 2910, 3520]
];
let guildJumpsSeen = 0;
function guildMoveClass(j) {
    const inBox = (x, z) => GUILD_MOVES.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
    if (!inBox(j.from[0], j.from[1]) || !inBox(j.to[0], j.to[1])) return null;
    if (Math.max(Math.abs(j.from[0] - j.to[0]), Math.abs(j.from[1] - j.to[1])) > 4) return null;
    return j.from[2] !== j.to[2] ? 'stairs' : 'door';
}
function varietyW2Tick(tick) {
    for (; guildJumpsSeen < record.jumps.length; guildJumpsSeen++) {
        const j = record.jumps[guildJumpsSeen];
        const cls = j.cls === 'jump' ? guildMoveClass(j) : null;
        if (cls) j.cls = cls;
    }
    if (!fashionLib?.fashion || tick % FASHION_EVERY !== 0 || tick < WARMUP) return;
    const F = fashionLib.fashion;
    // (the vendors online, and those whose stock is a status piece now: L6's detail)
    const statusIds = F.statusPieces().map(sp => sp.id);
    for (const p of active) {
        if (p.botPlanner !== 'extras_vendor' || !fashionLib.vendorAsk) continue;
        fashionRecord.vendorLooks++;
        if (statusIds.some(id => fashionLib.vendorAsk(p, id) !== null)) fashionRecord.statusVendors++;
    }
    for (const p of active) {
        const worn = p.getInventory(lib.InvType.WORN);
        const ids = [];
        for (let i = 0; i < 14; i++) {
            const id = worn?.get(i)?.id ?? -1;
            ids.push(id);
            fashionItem(id);
        }
        let ni = fashionNameIdx.get(p.username);
        if (ni === undefined) {
            fashionNameIdx.set(p.username, (ni = fashionRecord.names.length));
            fashionRecord.names.push({ n: p.username, p: p.botPlanner, tier: fashionLib.ageTierFor?.(p.username, p.botPlanner) ?? null, g: p.gender, hair: p.gender === 1 ? p.body[0] : null });
        }
        const task = (recs.get(p)?.bot ?? BotManager.botFor(p))?.currentTask ?? null;
        let wealth = null;
        try {
            wealth = F.wealthOf(p);
        } catch {
            wealth = null;
        }
        // (the status pieces it owns, worn, carried or banked: L6's owners)
        let owned = 0;
        for (const invId of [lib.InvType.WORN, lib.InvType.INV, lib.InvType.getId('bank')]) {
            const inv = invId === -1 ? null : p.getInventory(invId);
            for (let slot = 0; inv && slot < inv.capacity; slot++) if (inv.get(slot) && F.statusPieceOf(inv.get(slot).id)) owned++;
        }
        fashionRecord.samples.push({ t: tick, i: ni, k: taskKind(task?.name), x: p.x, z: p.z, l: p.level, w: ids, v: wealth, o: owned });
    }
}
function varietyW2Collect() {
    fashionRecord.showOff = fashionLib?.showOff?.showOffStats ? { ...fashionLib.showOff.showOffStats } : null;
    // (the shop trips' and show-offs' jumps, for a closer look with --fashion-census)
    fashionRecord.jumps = record.jumps.filter(j => /^(ShopTrip|ShowOff)/.test(j.task ?? '')).slice(0, 100);
    record.tracks.fashion = fashionRecord;
    if (FASHION_CENSUS) fs.writeFileSync(path.resolve(START_CWD, FASHION_CENSUS), JSON.stringify(fashionRecord));
}
// ---- end of Track W2's block ----
function varietyTick(tick) {
    varietyFTick(tick);
    varietyDTick(tick);
    varietySTick(tick);
    varietyWTick(tick);
    varietyD2Tick(tick);
    varietyMTick(tick);
    varietyS2Tick(tick);
    varietyW2Tick(tick);
}
function varietyCollect() {
    varietyFCollect();
    varietyDCollect();
    varietySCollect();
    varietyWCollect();
    varietyD2Collect();
    varietyMCollect();
    varietyS2Collect();
    varietyW2Collect();
}


// ---- run ----
const t0 = performance.now();
const harnessMs = [];
let lastProgress = t0;
while (World.currentTick < TICKS) {
    const tick = World.currentTick;
    humanTick(tick);
    sim.tick();
    await null; // the login thread's replies (logout acknowledgements) arrive on a microtask, as in the worker
    // (realism phase 7, --model=http: the tick loop waits for the model's answers; they are handled in the next tick, as the page's)
    if (modelHttp.queue.length) {
        const w0 = performance.now();
        while (modelHttp.queue.length) lib.BotModelNs.onModelReply(await askHttp(modelHttp.queue.shift()));
        modelHttp.waitMs += performance.now() - w0;
    }
    const b0 = performance.now();
    perTick(tick);
    textureTick(tick); // (realism phase 5a, track F)
    partyTick(tick); // (realism phase 5b, track P)
    varietyTick(tick); // (the variety work, rounds 1 and 2: every track's sampling)
    if (tick % SAMPLE === 0 && tick >= WARMUP) perSample(MODE === 'tour' ? STOPS[stopIndex] : MODE === 'still' ? AT : MODE);
    if (tick % 100 === 0) perPopulation();
    harnessMs.push(performance.now() - b0 + listenerMs);
    listenerMs = 0;
    if (process.stderr.isTTY && performance.now() - lastProgress > 30000) {
        lastProgress = performance.now();
        process.stderr.write(`  t${tick} ${((lastProgress - t0) / 1000).toFixed(0)} s, ${active.length} online\n`);
    }
}
const runSeconds = (performance.now() - t0) / 1000;
resolvePending();
for (const s of [...groupRuns.keys()]) closeGroupRun(s); // (phase 3, track C: G1's runs still going at the end)
for (const [, r] of recs) endSession(r, TICKS, false);
record.looks = [...looks.values()];

// (realism phase 5a, track E: the random events' rolls, for RE1's detail)
if (record.randomEvents && lib.RandomEvents?.rollStats) record.randomEvents.rolls = { ...lib.RandomEvents.rollStats, why: { ...lib.RandomEvents.rollStats.why } };

// (realism phase 5a: a jump near a move the library marked real, a teleport spell or a random event's move, is that, not
// a jump: BotAction.teleportStats.marks, noteMove; an older library has none, A/B runs included)
M.classifyMarkedJumps(record.jumps, lib.teleportStats?.marks ?? []);
// (realism phase 5a, track F: the library's misclicks, forgotten food, incidents and rude replies; the probe human's work)
record.texture = await collectTexture();
// (realism phase 5b, track P: the parties', scam callers' and lures' logs)
collectParties();
// (realism phase 5b, track A: the arena's duels and challenges, the mod's duty)
collectArena();
// (variety round 1: every track's records)
varietyCollect();

// ---- (realism phase 5a, Track M: movement and magic) the library's counters: teleport spells (TP1, TP2), the rescue jumps
// by cause (TP4), wrong turns (F2), alching and law runs (AL1's detail); null with an older library ----
{
    const spells = lib.Teleport?.teleportSpellStats;
    record.spells = spells && typeof spells.opportunities === 'number' ? JSON.parse(JSON.stringify(spells)) : null;
    // (the qualifying trips by bot: a few bots repeat one long trip, so TP1 leans on whether they save their laws)
    const NOT_QUALIFYING = new Set(['short', 'level', 'off the overworld', 'wilderness', 'no landing near', 'no runes', 'runes in the bank']);
    const byBot = new Map();
    for (const e of lib.Teleport?.tripLog ?? []) {
        if (NOT_QUALIFYING.has(e.reason)) continue;
        const b = byBot.get(e.name) ?? { name: e.name, trips: 0, cast: 0, saver: !lib.Teleport.isTeleporter(e.name) };
        b.trips++;
        if (e.verdict === 'cast') b.cast++;
        byBot.set(e.name, b);
    }
    if (record.spells) record.spells.byBot = [...byBot.values()].sort((a, b) => b.trips - a.trips);
    const turns = lib.BotActionNs?.wrongTurnStats;
    record.wrongTurns = turns ? { ...turns } : null;
    record.rescues = [...(lib.teleportStats?.byCause ?? new Map())].map(([cause, [jumps, refused]]) => ({ cause, jumps, refused }));
    const alch = lib.BotAlchNs?.alchStats;
    record.alch = alch ? { ...alch, items: { ...alch.items }, laws: lib.BotAlchNs.lawTripStats ? { ...lib.BotAlchNs.lawTripStats } : null } : null;
}
// ---- end of Track M's (phase 5a) counters block ----
// ---- (realism phase 5b, Track D) the director's events (their recruits and rumours) and the trains, for V1-V4 and G4 ----
if (spOn) {
    // (a library with the foundation's stubs, an A/B run's: no director's or trains' log, V1-V4 and G4 n/a)
    const log = spMods.director.directorLog;
    if (Array.isArray(log)) record.setPieces.events = log.map(e => ({ id: e.id, kind: e.kind, venue: e.venue, start: e.start, startPlay: e.startPlay, end: e.end, outcome: e.outcome, recruits: e.recruits.map(x => ({ name: x.name, role: x.role, left: x.left, back: x.back })), rumours: e.rumours.map(x => ({ t: x.t, name: x.name, nearHuman: x.nearHuman })) }));
    else record.setPieces.noDirector = true;
    if (Array.isArray(spMods.trains?.trainsLog)) record.setPieces.trains = spMods.trains.trainsLog.map(t => ({ start: t.start, end: t.end, members: [...t.members], human: t.human, reason: t.reason }));
    else record.setPieces.noTrains = true;
}
// ---- end of Track D's (phase 5b) logs block ----

// ---- (realism phase 7, Track E) the model's stats and every reply's story, for MD1-MD6 ----
if (MODEL) {
    const ms = lib.BotModelNs.modelStats;
    record.model = { ...modelInfo, stats: JSON.parse(JSON.stringify({ ...ms, log: undefined })), log: ms.log.map(e => ({ ...e })) };
    if (modelHttp.url) record.model.http = { answers: modelHttp.ms.length, failed: modelHttp.failed, msMean: Math.round(modelHttp.ms.reduce((a, b) => a + b, 0) / Math.max(1, modelHttp.ms.length)), msP90: Math.round(M.quantile(modelHttp.ms, 0.9) ?? 0), promptTokens: modelHttp.promptTokens, predictedTokens: modelHttp.predictedTokens, waitSeconds: Math.round(modelHttp.waitMs / 100) / 10 };
}

// ---- report ----
const stats = BotManager.stats();
const metrics = M.computeMetrics(record);
const fingerprint = M.fingerprint(metrics);
// (phase 7: MD1-MD6, only with --model; not in the fingerprint)
const modelMetrics = M.computeModelMetrics(record);
const modelFailed = modelMetrics.filter(m => m.ok === false);
const botHours = record.botTicks / M.TICKS_PER_HOUR;
const maxErrors = MAX_ERRORS;
const botErrors = lib.botErrorCount();
const errorCount = logStats.engine + botErrors;
const distinctErrors = new Map();
for (const e of logStats.errors) {
    const key = e.replace(/^t-?\d+: /, '').split('\n')[0].replace(/\d+/g, '#').slice(0, 160);
    distinctErrors.set(key, (distinctErrors.get(key) ?? 0) + 1);
}
const dist = xs => {
    const s = [...xs].sort((a, b) => a - b);
    const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
    return { avg: +(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)).toFixed(3), p95: +q(0.95).toFixed(3), max: +(s.at(-1) ?? 0).toFixed(3) };
};
const after = sim.samples.slice(Math.ceil(N / 5) + 5);
const timing = { seconds: +runSeconds.toFixed(1), harnessMsPerTick: dist(harnessMs.slice(Math.ceil(N / 5) + 5)), worldTickMs: dist(after.map(s => s.cycleMs)), botTickMs: dist(after.map(s => s.botMs)) };
const judged = metrics.filter(m => m.ok !== null);
const failed = judged.filter(m => !m.ok);
const modeText = MODE === 'probe' ? `a probe every ${PROBE} ticks` : MODE === 'work' ? `the human at work (cows, then rocks, ${WORK / 100} min each)` : MODE === 'still' ? `standing at ${AT}` : `a tour of ${STOPS.length} stops (${STOP_TICKS / 100} min each)`;

out(`humanlike: ${N} bots, ${TICKS} ticks, ${MEMBERS ? 'members' : 'free'} world, seed ${SEED}, XP ×${XPRATE}, ${modeText}${TALK ? `, a line every ${TALK} ticks` : ''}${record.meta.newchar ? ', a new character' : ''}${OVERLAY ? '' : ', vanilla scripts (no overlay)'}: ${judged.length - failed.length} of ${judged.length} in band; ${timing.seconds} s`);
out(`  world: ${botHours.toFixed(1)} bot-hours, ${stats.spawned} logins, ${stats.logoffs} log-offs, ${stats.returns} returns, ${stats.newcomers} newcomers, ${stats.quits} quits; ${record.deaths.length} deaths; ${record.lines.length} lines, ${record.pms.length} PMs to the human`);
out(`  errors: ${logStats.engine} engine, ${botErrors} bot (at most ${maxErrors}; ${logStats.errors.length} lines); warnings ${logStats.warnings}${distinctErrors.size ? `; ${[...distinctErrors].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${n}× ${k.slice(0, 110)}`).join(' | ')}` : ''}`);
out(`  harness: ${timing.harnessMsPerTick.avg} ms a tick (p95 ${timing.harnessMsPerTick.p95}, max ${timing.harnessMsPerTick.max}); world tick ${timing.worldTickMs.avg} ms (bots ${timing.botTickMs.avg} ms)`);
out(`  fingerprint ${fingerprint} (the same arguments give the same one)`);
out('');
for (const line of M.formatMetrics(metrics, { details: DETAILS })) out(line);
out('');
const hubs = M.hubTable(record);
if (args.hubs === 'true') {
    for (const line of M.formatHubTable(hubs)) out(line);
    out('');
}
out(failed.length ? `out of band (${failed.length}): ${failed.map(m => m.id).join(' ')}` : 'every judged metric in band');
// (realism phase 7, Track E: the language model's metrics and a sample of its lines, with --model)
if (record.model) {
    const m = record.model;
    out('');
    out(`  model: ${m.kind === 'stub' ? `the stub (answers ${m.latencyTicks} ticks after the request, ${Math.round(m.failRate * 100)} % failing)` : `${m.url}`}; ${m.stats.requests} requests, ${m.stats.used} said in its words${m.http ? `; ${m.http.answers} answers, ${m.http.msMean} ms each (p90 ${m.http.msP90}), ${m.http.failed} failed, ${m.http.predictedTokens} tokens out; the run waited ${m.http.waitSeconds} s` : ''}`);
    for (const line of M.formatMetrics(modelMetrics, { details: DETAILS })) out(line);
    out(modelFailed.length ? `model out of band (${modelFailed.length}): ${modelFailed.map(x => x.id).join(' ')}` : 'model: every judged metric in band');
    const said = m.log.filter(e => e.outcome === 'used').slice(0, 15);
    const refused = m.log.filter(e => e.outcome === 'guard').slice(0, 10);
    if (said.length) out(`  the model's lines (first ${said.length}):`);
    for (const e of said) out(`    t${e.t} ${e.bot} (${e.via}${e.intent ? ` ${e.intent}` : ', nothing understood'}): "${e.heard}" -> "${e.said ?? e.raw}"${e.ruleText ? ` (the rules: "${e.ruleText}")` : ''}`);
    if (refused.length) out(`  refused by the guard (first ${refused.length}):`);
    for (const e of refused) out(`    t${e.t} ${e.bot}: "${e.heard}" -> "${e.raw}" (${e.reason}${e.planted ? `, planted ${e.planted}` : ''})`);
}

if (args.json && args.json !== 'true') {
    const heard = record.lines.filter(l => l.humanDist <= M.VIEW && !M.isTrade(l)).slice(0, 300).map(l => `t${l.t} ${l.name} (${l.planner}, ${l.task}/${l.kind}): ${l.shown}`);
    const ans = M.answers(record);
    const report = {
        args: record.meta,
        timing,
        fingerprint,
        stats,
        errors: { engine: logStats.engine, bot: botErrors, lines: logStats.errors.length, max: maxErrors, warnings: logStats.warnings, distinct: [...distinctErrors].sort((a, b) => b[1] - a[1]).slice(0, 10) },
        metrics,
        hubs,
        examples: {
            heard,
            answers: [...ans.pub.map(a => ({ public: a.to, answer: a.shown, ticks: a.latency })), ...ans.pm.map(a => ({ pm: a.to, answer: a.shown, ticks: a.latency }))].slice(0, 120),
            unanswered: record.probes.filter(p => !ans.pub.some(a => a.to === p.line) && !ans.pm.some(a => a.to === p.line)).slice(0, 60).map(p => `${p.kind} ${p.bot} (${p.task}): ${p.line}`),
            topNonTrade: [...record.lines.filter(l => !M.isTrade(l)).reduce((m, l) => m.set(l.shown, (m.get(l.shown) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).slice(0, 25),
            deaths: record.deaths.map(d => `t${d.t} ${d.name} (${d.planner}, ${d.task}) by ${d.by} at ${d.x},${d.z}`)
        },
        // (realism phase 7, Track E: with --model, MD1-MD6, the stats and the first replies' stories)
        ...(record.model ? { model: { ...modelInfo, metrics: modelMetrics, stats: record.model.stats, http: record.model.http ?? null, log: record.model.log.slice(0, 400) } } : {})
    };
    fs.writeFileSync(path.resolve(START_CWD, args.json), JSON.stringify(report, null, 1));
}
if (MODEL_CAPTURE) fs.writeFileSync(path.resolve(START_CWD, MODEL_CAPTURE), modelCaptured.map(c => JSON.stringify({ seed: SEED, members: MEMBERS, xpRate: XPRATE, bots: N, ...c })).join('\n') + (modelCaptured.length ? '\n' : ''));
if (MODEL_LOG && record.model) fs.writeFileSync(path.resolve(START_CWD, MODEL_LOG), record.model.log.map(e => JSON.stringify(e)).join('\n') + (record.model.log.length ? '\n' : ''));
if (args.lines && args.lines !== 'true') fs.writeFileSync(path.resolve(START_CWD, args.lines), record.lines.map(l => JSON.stringify(l)).join('\n') + '\n');
// (the integration of phase 4: every logout as JSON lines, for H20 and H20b's story: where and in what task bots left)
if (args.logouts && args.logouts !== 'true') fs.writeFileSync(path.resolve(START_CWD, args.logouts), record.logouts.map(l => JSON.stringify(l)).join('\n') + '\n');

if (errorCount > maxErrors) {
    out(`FAIL errors: ${errorCount} (${logStats.engine} engine, ${botErrors} bot), more than ${maxErrors}: ${logStats.errors.slice(0, 2).map(e => e.split('\n')[0]).join(' | ')}`);
    process.exit(1);
}
if (STRICT && failed.length + modelFailed.length) {
    out(`FAIL --strict: ${failed.length + modelFailed.length} metrics out of band`);
    process.exit(1);
}
process.exit(0);
