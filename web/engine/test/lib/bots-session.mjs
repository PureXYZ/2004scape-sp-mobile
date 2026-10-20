// The bots scenarios (docs/BOTS.md §7, runtime) over the real page<->worker protocol, shared by the vm harness
// (test/bots.test.mjs) and the JavaScriptCore one (test/jsc-harness.mjs --bots-boot=...). Pure JavaScript. One call is
// one boot of the worker; test/bots.test.mjs runs them in this order on ONE Documents folder:
//   main     fresh Documents: bundle and files, overlay, hooks, nothing before a human, staggered spawning, keep-alive
//            past 100 ticks, no random events, chat, the language model's messages (the realism work, phase 7: the
//            page's mode; with the real library a named line's request to the page and its answer as the bot's line;
//            the entry never hears them), "come here", friends, trade and death through the overlay, saves
//            only under bots/ (lifecycle save, autosave, logout, exit), a failed bots.sav write (lifecycle-done.bots,
//            written on resume), a human taking a bot's name (and the timeout, counted in ticks: not while paused),
//            pause/resume, an engine error in a bot's turn every tick (repeated lines limited), exit
//   restore  the same Documents: the bots come back from bots.sav; the names humans took are skipped (backfilled); the
//            human's friend list comes back from bots.sav's _meta; a character deleted (Settings › Saved data) takes
//            its friend lists out of _meta
//   (the launcher then adds friend lists of a character with no save to _meta: one deleted while the bots were off)
//   living   short sessions (the real library) or the stub's logOff/comeBack: a friend bot logs out and back in and
//            the human sees both; it comes back from its record; the bots' own logouts write bots.sav at most once
//            every storeWrites.everyTicks ticks (the human's logout at once); the friend list at the next login; the
//            lists of a character with no save dropped at load; with the real
//            library the empty world (every bot out) and newcomers and quits written to bots.sav
//   unreadable  reading bots.sav fails (I/O error, not a missing or corrupt file): bots off for the session, and neither
//            bots.sav nor its older .bak is used or written; the page hears why ({type:'bots'})
//   bak      bots.sav corrupt (the launcher wrote garbage): the bots come back from bots.sav.bak
//   corrupt  both corrupt: bots off for the session, the world plays on, nothing overwrites bots.sav; the page hears why
//   off      bots.count 0: engine.js, the 37 vanilla files, nothing under bots/, and the vanilla 64-check session
// and, on their own build (test/bots.test.mjs): broken (the library throws while it loads) and nobundle (bots asked of a
// build without them): engine.js, and the page hears why.
//
// The harness adds to lib/session.mjs's env: bots (the engine module's __bots, or null), staticGets() (paths
// relative to the Game dir), storage.indexGets, botCount, profile, spawnPerTick, stub (the stub library: checks of
// its scripted behaviour too).
import { equalBytes, name37Bytes, parseSave, toUserhash, wordPack } from './protocol.mjs';
import { Bot, Page, createRunner, runSession, waitFor } from './session.mjs';

const HUMAN = 'botstest1';
// the vanilla engine's own-property wrappers on World (runtime/ticker.ts, entry.ts); the bots add the rest
const GLUE_WRAPPED = ['start', 'processClientsIn', 'processPlayers', 'sendPrivateMessage', 'onLoginMessage'];

export async function runBotsBoot(env, mode) {
    if (mode === 'off') return bootOff(env);
    if (mode === 'broken' || mode === 'nobundle') return bootWithoutBots(env, mode);
    const T = createRunner(env);
    const page = new Page(env, T);
    const ctx = { env, T, page, S: env.storage, N: env.botCount, slow: env.slow || 1, profile: env.profile, stub: !!env.stub, says: [], lastSave: new Map(), spawnedAt: new Map() };
    ctx.botsSav = `bots/${ctx.profile}/bots.sav`;
    try {
        await BOOTS[mode](ctx);
    } catch (e) {
        T.fail('scenario aborted', e && e.stack ? e.stack : String(e));
    }
    const result = T.result(page);
    result.mode = mode;
    return result;
}

// ---- helpers --------------------------------------------------------------------------------------------------

/**
 * bots.sav (LCBOTS01, docs/BOTS.md §4.5) -> Map(name -> save bytes) of the bots; the "_meta" record (the store's own
 * state, JSON) is not a bot: it is the map's `meta` (null if there is none). Throws if malformed.
 */
export function parseBotStore(u8) {
    const all = parseRecords(u8);
    const meta = all.get('_meta');
    all.delete('_meta');
    all.meta = meta ? JSON.parse(new TextDecoder().decode(meta)) : null;
    return all;
}

function parseRecords(u8) {
    const magic = String.fromCharCode(...u8.subarray(0, 8));
    if (magic !== 'LCBOTS01') throw new Error(`bad magic ${magic}`);
    const count = (u8[8] << 8) | u8[9];
    const out = new Map();
    let p = 10;
    for (let i = 0; i < count; i++) {
        const n = u8[p++];
        const name = String.fromCharCode(...u8.subarray(p, p + n));
        p += n;
        const len = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
        p += 4;
        out.set(name, u8.slice(p, p + len));
        p += len;
    }
    if (p !== u8.length) throw new Error('trailing bytes');
    return out;
}

function encodeRecords(records) {
    const parts = [new TextEncoder().encode('LCBOTS01'), new Uint8Array([records.size >> 8, records.size & 255])];
    for (const [name, data] of records) {
        const n = data.length;
        parts.push(new Uint8Array([name.length]), new TextEncoder().encode(name), new Uint8Array([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]), data);
    }
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let p = 0;
    for (const part of parts) {
        out.set(part, p);
        p += part.length;
    }
    return out;
}

/** bots.sav with friend lists in its _meta for `human` (bots.test.mjs: a character deleted while the bots were off). */
export function withFriendLists(u8, human, lists) {
    const records = parseRecords(u8);
    const meta = JSON.parse(new TextDecoder().decode(records.get('_meta')));
    meta.friends[human] = lists;
    records.set('_meta', new TextEncoder().encode(JSON.stringify(meta)));
    return encodeRecords(records);
}

/** The character with no save whose lists the launcher puts in bots.sav before the living boot. */
export const DELETED_HUMAN = 'botsghost1';

const activeBots = B => [...B.BotManager.activeBots()];
const distance = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
/** Where fresh bots join: the bot library's LUMBRIDGE_SPAWN (bots/src/BotKnowledge.ts), on the road west of the castle. */
const SPAWN = [3180, 3240, 0];
/** The active bot nearest to `p` (another floor counts as far away). */
const nearestBot = (B, p) => activeBots(B).reduce((best, b) => (best === null || (b.level === p.level ? distance(b, p) : 1e9) < (best.level === p.level ? distance(best, p) : 1e9) ? b : best), null);
const playerRel = (ctx, name) => `players/${ctx.profile}/${name}.sav`;

async function waitTicks(ctx, H, n) {
    const target = H.World.currentTick + n;
    await waitFor(ctx.env, () => H.World.currentTick >= target, (3000 + n * Math.max(400, 2 * H.World.tickRate)) * ctx.slow, `${n} ticks`);
}

// chat and social packets the way the client sends them (one per tick: the engine's socialProtect)
const publicChat = (bot, text) => bot.send('MESSAGE_PUBLIC', [0, 0, ...wordPack(text)]);
const privateMessage = (bot, to, text) => bot.send('MESSAGE_PRIVATE', [...name37Bytes(to), ...wordPack(text)]);
const friendAdd = (bot, name) => bot.send('FRIENDLIST_ADD', name37Bytes(name));
const opPlayer = (bot, op, slot) => bot.send(`OPPLAYER${op}`, [slot >> 8, slot & 0xff]);

function watchFriends(bot) {
    bot.friends = [];
    const onPacket = bot.onPacket.bind(bot);
    bot.onPacket = (name, p) => {
        if (name === 'UPDATE_FRIENDLIST') {
            let v = 0n;
            for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(p[i]);
            bot.friends.push({ name37: v, node: p[8] });
        }
        onPacket(name, p);
    };
}

async function login(ctx, name, { tele = true } = {}) {
    const bot = new Bot(ctx.env, ctx.page, name);
    watchFriends(bot);
    const response = await bot.login();
    if (response === 2) {
        bot.startKeepalive(500);
        if (tele) {
            bot.cheat('tele 0,50,50,22,18'); // Lumbridge (3222, 3218), where the bots start
            await bot.ticks(2);
        }
    }
    return { bot, response };
}

async function logout(ctx, bot) {
    bot.ifButton(ctx.env.fixture.logoutComponent);
    await waitFor(ctx.env, () => bot.conn.closedByServer, 15000 * ctx.slow, 'logout');
    bot.stopKeepalive();
}

/** init -> booted (engine-bots.js) -> instrumentation -> start -> ready. */
async function bootWithBots(ctx) {
    const { env, T, page } = ctx;
    T.phase(`boot with ${ctx.N} bots`);
    page.post({ type: 'init', config: env.config });
    await waitFor(env, () => page.booted || page.exits.length, 120000 * ctx.slow, 'booted');
    const b = page.booted;
    if (!T.check('booted engine-bots.js with the bots', b?.bundle === 'engine-bots.js' && b.bots === ctx.N && env.bots !== null, b && { bundle: b.bundle, bots: b.bots, files: b.files })) throw new Error('no bots bundle');
    const H = env.hooks;
    const B = env.bots;
    // every say() and save() (to compare PUT bodies with exactly what the engine produced), and where bots join
    const say = H.Player.prototype.say;
    H.Player.prototype.say = function (text) {
        ctx.says.push({ who: this.username, text, tick: H.World.currentTick });
        return say.call(this, text);
    };
    // the real library's bots speak as typed lines (the CHAT mask, port/BotSay), the stub's with say()
    B.sayListeners.push((player, text) => ctx.says.push({ who: player.username, text, tick: H.World.currentTick }));
    const save = H.Player.prototype.save;
    H.Player.prototype.save = function () {
        const r = save.call(this);
        ctx.lastSave.set(this.username, r.slice());
        return r;
    };
    // the new characters the glue reported (a login with no save)
    ctx.newCharacters = 0;
    const newCharacter = B.BotManager.newCharacter;
    B.BotManager.newCharacter = function () {
        ctx.newCharacters++;
        return newCharacter.call(this);
    };
    H.World.newPlayers.add = function (p) {
        // (attackNow: the current level, as a save holds it: a PKer saved with a potion's boost logs in boosted)
        if (p.is_bot === true) ctx.spawnedAt.set(p.username, { x: p.x, z: p.z, level: p.level, attack: p.baseLevels[0], attackNow: p.levels[0], tick: H.World.currentTick });
        else if (ctx.humanArrived === undefined) ctx.humanArrived = H.World.currentTick; // joins in this tick's processLogins
        return Set.prototype.add.call(this, p);
    };
    page.post({ type: 'start' });
    await waitFor(env, () => page.ready || page.exits.length, 300000 * ctx.slow, 'ready');
    if (!T.check('ready', !!page.ready, page.exits)) throw new Error('not started');
    H.World.tickRate = 100; // ticks at 100 ms: the scenarios count ticks, not seconds
    return { H, B, W: H.World };
}

// ---- boot 1: everything, on fresh Documents ------------------------------------------------------------------

async function bootMain(ctx) {
    const { env, T, page, S, N, profile, botsSav } = ctx;
    const { H, B, W } = await bootWithBots(ctx);
    const own = m => Object.prototype.hasOwnProperty.call(W, m);

    T.phase('files, overlay, hooks');
    const gets = env.staticGets();
    T.check('vfs-manifest-bots.json and vfs/bots/scripts.bin preloaded with the 37 vanilla files', gets.includes('engine/vfs-manifest-bots.json') && gets.includes('engine/vfs/bots/scripts.bin') && page.booted.files === 38, { files: page.booted.files });
    T.check('bots.sav read once (none yet: 404); /save-index read once', S.gets.filter(g => g.rel === botsSav).map(g => g.status).join() === '404' && S.indexGets === 1, { gets: S.gets.filter(g => g.rel.startsWith('bots/')), indexGets: S.indexGets });
    const SP = B.ScriptProvider;
    const death = SP.getByName('[proc,player_death_lose_items]');
    T.check('overlay: [proc,player_death_lose_items] opens with p_isbot (10100, operand 0)', death?.opcodes[0] === 10100 && death.intOperands[0] === 0, death && { first: death.opcodes[0], operand: death.intOperands[0] });
    const op4 = SP.getByName('[opplayer4,_]');
    const has = (s, op, operand) => !!s && s.opcodes.some((o, i) => o === op && s.intOperands[i] === operand);
    T.check('overlay: [opplayer4,_] uses .p_isbot and .p_bot_interact_trade (operand 1)', has(op4, 10100, 1) && has(op4, 10101, 1));
    T.check('overlay applied once, every script of scripts.bin', B.overlayStats.applied === 1 && B.overlayStats.scripts >= 4 && !B.overlayStats.lastError, B.overlayStats);
    T.check('script handlers 10100 and 10101 registered', typeof B.ScriptRunner.HANDLERS[10100] === 'function' && typeof B.ScriptRunner.HANDLERS[10101] === 'function');
    T.check('World hooks installed (own-property wrappers)', GLUE_WRAPPED.every(own) && own('cycle'), GLUE_WRAPPED.filter(m => !own(m)));
    T.check('saves.write and saves.retryPending routed', Object.prototype.hasOwnProperty.call(H.saves, 'write') && Object.prototype.hasOwnProperty.call(H.saves, 'retryPending'));
    T.check("the friend thread's postMessage wrapped (the friend lists, bots logging in and out)", Object.prototype.hasOwnProperty.call(W.friendThread, 'postMessage'));
    T.check('the bots started (no error)', B.bots.phase === 'started' && B.bots.disabledReason === null, { phase: B.bots.phase, reason: B.bots.disabledReason });

    T.phase('nothing joins before a human is in the world');
    await waitTicks(ctx, H, 15);
    T.check('no bot after 15 ticks with nobody online', B.BotManager.stats().spawned === 0 && ctx.spawnedAt.size === 0, B.BotManager.stats());

    T.phase('a human logs in: the bots join, staggered');
    const { bot: human, response } = await login(ctx, HUMAN);
    T.check('login 2', response === 2, response);
    T.check('a new character (no save): the library hears it once', ctx.newCharacters === 1, ctx.newCharacters);
    const hp = W.getPlayerByUsername(HUMAN);
    await waitFor(env, () => B.BotManager.stats().spawned >= N, (20000 + N * 500) * ctx.slow, `${N} bots`);
    const spawns = B.botTickStats.spawns;
    const perTick = env.spawnPerTick ?? 5;
    T.metric('spawns', spawns);
    T.check(`all ${N} bots in the world`, activeBots(B).length === N && activeBots(B).every(p => [...W.playerLoop.all()].includes(p)), B.BotManager.stats());
    T.check(`staggered: at most ${perTick} a tick`, spawns.every(([, n]) => n <= perTick) && spawns.length >= Math.ceil(N / perTick), spawns);
    T.check('only after the human is in the world, never on tick 0', spawns.length > 0 && spawns[0][0] > 0 && spawns[0][0] > ctx.humanArrived, { first: spawns[0], humanArrived: ctx.humanArrived });
    T.check('bots are client-less Players with is_bot', activeBots(B).every(p => !(p instanceof H.NetworkPlayer) && p.is_bot === true));

    T.phase('keep-alive past the 100-tick no-response timeout');
    await waitTicks(ctx, H, 120);
    T.check(`all ${N} bots still in the world 120 ticks later`, activeBots(B).length === N, B.BotManager.stats());
    T.check('self-check passed: the hooks ran, the keep-alive holds', B.check.hooks && B.check.keepAlive, B.check);

    T.phase('no random events for bots');
    for (const p of activeBots(B)) p.afkEventReady = true;
    hp.afkEventReady = true;
    await waitTicks(ctx, H, 1);
    T.check('the random-event flag is cleared for every bot, not for the human', activeBots(B).every(p => p.afkEventReady === false) && hp.afkEventReady === true);
    hp.afkEventReady = false;

    const [b0, b1, b2, b3, b4, b5, b6, b7] = activeBots(B);

    T.phase('public chat reaches the bots');
    const heard = B.bots.counters.publicChats;
    publicChat(human, `hello ${b0.displayName} how are you`);
    await waitFor(env, () => B.bots.counters.publicChats > heard, 5000 * ctx.slow, 'the chat hook');
    T.check('BotChat.onPublicMessage got the line', B.bots.counters.publicChats === heard + 1);
    if (ctx.stub) {
        await waitFor(env, () => ctx.says.some(s => s.who === b0.username), 5000 * ctx.slow, 'the reply');
        T.check(`the addressed bot answers by name ("hi ${hp.displayName}")`, ctx.says.some(s => s.who === b0.username && s.text === `hi ${hp.displayName}`), ctx.says.slice(-3));
        const n = ctx.says.length;
        await waitTicks(ctx, H, 1);
        publicChat(human, 'hello everyone');
        await waitTicks(ctx, H, 4);
        T.check('a line that names no bot gets no answer', ctx.says.length === n, ctx.says.slice(n));
    }

    // (the realism work, phase 7: the language model's messages, runtime/bots/page.ts and port/BotModel)
    T.phase("the language model: the page's mode, a request, its answer");
    {
        const requests = [];
        env.onMessage(m => {
            if (m.type === 'bots-lm') requests.push(m);
        });
        const logs0 = page.logs.length;
        page.post({ type: 'bots-lm-mode', mode: 'local', local: true, online: false });
        if (ctx.stub) {
            page.post({ type: 'bots-lm-reply', id: 1, text: 'hi', source: 'local', ms: 1 });
            await waitTicks(ctx, H, 2);
        } else {
            // a bot by the human answers "whats ur cb" by name: in the model's scope, the engine asks the page for the
            // words (a bot away on a break, or a rude one's rude line, asks nothing: the next is tried)
            const words = ['nah', 'not', 'telling', 'lol'];
            let asked = null;
            let request = null;
            for (const b of activeBots(B).filter(p => !(p.staffModLevel > 0)).slice(0, 5)) {
                b.teleJump(hp.x + 1, hp.z, hp.level);
                await waitTicks(ctx, H, 1);
                const n0 = requests.length;
                publicChat(human, `${b.displayName} whats ur cb`);
                await waitFor(env, () => requests.length > n0, 6000 * ctx.slow, 'a model request').catch(() => {});
                if (requests.length > n0) {
                    asked = b;
                    request = requests[requests.length - 1];
                    break;
                }
                await waitTicks(ctx, H, 30);
            }
            T.check('a named line in the model\'s scope: the engine asks the page ({type:\'bots-lm\'}: both prompts, 80 characters, native\'s 9 s)', !!request && request.mode === 'local' && /whats ur cb/i.test(request.local?.user ?? '') && typeof request.local?.system === 'string' && typeof request.online?.system === 'string' && typeof request.online?.context === 'string' && request.maxChars === 80 && request.timeoutMs === 9000, request && { id: request.id, mode: request.mode, maxChars: request.maxChars, timeoutMs: request.timeoutMs });
            if (request) {
                const said0 = ctx.says.length;
                page.post({ type: 'bots-lm-reply', id: request.id, text: 'nah not telling lol', source: 'local', ms: 5 });
                const said = () => ctx.says.slice(said0).filter(x => x.who === asked.username && words.filter(w => x.text.toLowerCase().includes(w)).length >= 2);
                await waitFor(env, () => said().length > 0, 15000 * ctx.slow, "the model's line").catch(() => {});
                T.check("its answer, through the guard and the bot's style, is the bot's line", said().length > 0, ctx.says.slice(said0).filter(x => x.who === asked.username));
            }
        }
        T.check("the model's messages are the bots' own: the entry never hears them (no 'unknown message type')", page.logsMatching(/unknown message type 'bots-lm/, logs0).length === 0, page.logsMatching(/unknown message type/, logs0).map(l => l.text));
        // (the rules alone again for the rest of the session)
        page.post({ type: 'bots-lm-mode', mode: 'rules', local: true, online: false });
        await waitTicks(ctx, H, 1);
    }

    T.phase('a private "come here"');
    // The stub's bots stand where they joined. Real ones go about their tasks (a new bot world's aged bots all over
    // the map), and "come here" reaches a bot only within 50 tiles on the player's floor (BotChat): the nearest one,
    // put back on the road where new bots start (the library's LUMBRIDGE_SPAWN, 42 tiles from the player) if it is
    // farther, its task stopped first (in a fight a bot's next teleport jumps at once, back to where it was)
    const comer = ctx.stub ? b1 : nearestBot(B, hp);
    const wandered = !ctx.stub && (comer.level !== hp.level || distance(comer, hp) > 45);
    if (wandered) {
        B.BotManager.botFor(comer)?.windDown();
        comer.teleJump(...SPAWN);
    }
    const consumed = B.bots.counters.privateConsumed;
    await waitTicks(ctx, H, 1);
    privateMessage(human, comer.username, 'come here');
    await waitFor(env, () => B.bots.counters.privateConsumed > consumed, 5000 * ctx.slow, 'the PM hook');
    T.check('BotChat.onPrivateMessage took it (not passed to the friend server)', B.bots.counters.privateConsumed === consumed + 1, { bot: comer.username, from: [comer.x, comer.z], wandered });
    await waitFor(env, () => distance(comer, hp) <= 2, 30000 * ctx.slow, 'the bot coming over').catch(() => {});
    T.check('the bot came over', distance(comer, hp) <= 2, { bot: [comer.x, comer.z], human: [hp.x, hp.z] });

    T.phase('a bot in the friend list shows online');
    await waitTicks(ctx, H, 1);
    friendAdd(human, b2.username);
    await waitFor(env, () => human.friends.some(f => f.name37 === toUserhash(b2.username)), 5000 * ctx.slow, 'UPDATE_FRIENDLIST').catch(() => {});
    T.check('UPDATE_FRIENDLIST with the world (node 10)', human.friends.some(f => f.name37 === toUserhash(b2.username) && f.node === 10), human.friends.map(f => ({ ...f, name37: String(f.name37) })));

    T.phase('a trade request runs the overlay\'s [opplayer4,_]');
    const tradeHandler = B.ScriptRunner.HANDLERS[10101];
    const tradeCalls = [];
    B.ScriptRunner.HANDLERS[10101] = state => {
        // the command's arguments (player_uid, stage) as the overlay pushed them, before the handler pops them
        const call = { bot: state.activePlayer.username, uid: state.intStack[state.isp - 2], stage: state.intStack[state.isp - 1] };
        tradeHandler(state);
        tradeCalls.push({ ...call, target: state.activePlayer.botTradeTargetPid });
    };
    // (real bots: the one that came over, called again so it waits by the player: it stays 50 ticks, then goes back
    // to its task, which may be far away)
    const trader = ctx.stub ? b3 : comer;
    if (!ctx.stub) {
        await waitTicks(ctx, H, 1);
        privateMessage(human, trader.username, 'come here');
        await waitFor(env, () => distance(trader, hp) <= 1, 30000 * ctx.slow, 'the trader coming over').catch(() => {});
    }
    const said0 = ctx.says.length;
    await waitTicks(ctx, H, 1);
    opPlayer(human, 4, trader.slot);
    await waitFor(env, () => tradeCalls.length > 0, 30000 * ctx.slow, 'p_bot_interact_trade').catch(() => {});
    await waitTicks(ctx, H, 1);
    B.ScriptRunner.HANDLERS[10101] = tradeHandler;
    T.check('.p_bot_interact_trade(uid, 0) on the bot: the human asks it to trade', tradeCalls.some(c => c.bot === trader.username && c.uid === hp.uid && c.stage === 0), tradeCalls);
    // the overlay says nothing itself: the library answers (BotTrade.onTradeRequest), once
    const answer = ctx.says.slice(said0).filter(s => s.who === trader.username).map(s => s.text);
    const took = trader.botTradeTargetPid === hp.uid;
    if (ctx.stub) {
        T.check(`the (stub) library takes it: its trade target is the human, "One moment please, ${hp.displayName}" said once`, took && answer.length === 1 && answer[0] === `One moment please, ${hp.displayName}`, { answer, target: trader.botTradeTargetPid });
    } else {
        // a bot whose task trades (vendor, bankstand) takes it; any other declines in a word and keeps no target
        const task = B.BotManager.botFor(trader)?.currentTask;
        // (a real bot may say an idle line in the same ticks)
        T.check('the library answers: "One moment please" and the human as its trade target, or a refusal and none', answer.length >= 1 && answer.includes(`One moment please, ${hp.displayName}`) === took && (took || trader.botTradeTargetPid === -1), { answer, target: trader.botTradeTargetPid, task: task?.name, trades: typeof task?.tradeRefusal === 'function' });
    }
    // stage -1 (a trade window of the bot closed, [if_close,trademain]): its trade target is cleared, whatever it was
    trader.botTradeTargetPid = hp.uid;
    trader.botTradeTargetStage = 2;
    const resetArgs = [-1, -1];
    tradeHandler({ activePlayer: trader, popInt: () => resetArgs.pop() });
    T.check('p_bot_interact_trade(null, -1) clears the bot\'s trade target (upstream kept a target that was set)', trader.botTradeTargetPid === -1 && trader.botTradeTargetStage === -1, { target: trader.botTradeTargetPid, stage: trader.botTradeTargetStage });

    T.phase('::reload puts the overlay back');
    human.cheat('reload');
    await human.message(/^Loaded \d+ scripts\.$/, 60000 * ctx.slow);
    const reloaded = SP.getByName('[proc,player_death_lose_items]');
    T.check('after ::reload the overlay is applied again', B.overlayStats.applied === 2 && reloaded !== death && reloaded?.opcodes[0] === 10100 && B.bots.phase === 'started', { applied: B.overlayStats.applied });

    T.phase('death: a bot keeps its items (overlay)');
    const inv = b4.getInventory(B.InvType.INV);
    if (inv.freeSlotCount > 0) inv.add(995, 1000); // coins (a real bot's inventory may be full already)
    const items = () => JSON.stringify(inv.items.map(i => (i ? [i.id, i.count] : null)));
    const before = items();
    const state = B.ScriptRunner.init(reloaded, b4);
    B.ScriptRunner.execute(state);
    T.check('[proc,player_death_lose_items] returns at p_isbot: the inventory is unchanged', inv.items.some(i => i) && items() === before && state.execution === 1, { before, after: items(), execution: state.execution });

    // something to recognise the restored bots by in the next boots (stats survive whatever the bots do)
    for (const p of activeBots(B)) {
        p.stats[0] = Math.max(p.stats[0], 1013330); // attack 50 (xp in tenths)
        p.baseLevels[0] = Math.max(p.baseLevels[0], 50);
        p.levels[0] = Math.max(p.levels[0], 50);
    }

    T.phase("lifecycle 'save': the human under players/, the bots in one bots.sav after it");
    let mark = S.puts.length;
    const ls = await page.sendLifecycle('save', 20000 * ctx.slow);
    let rels = S.puts.slice(mark).map(p => p.rel);
    T.check('ok', ls.ok === true, ls.error);
    T.check('lifecycle-done says the bots were saved too: bots {ok: true}', ls.bots?.ok === true && !('error' in ls.bots), ls.bots);
    T.check('PUTs: the human, then bots.sav - nothing else', rels.join() === [playerRel(ctx, HUMAN), botsSav].join(), rels);
    let store = parseBotStore(S.read(botsSav));
    T.check(`bots.sav holds the ${N} bots, each record exactly its save()`, store.size === N && activeBots(B).every(p => equalBytes(store.get(p.username), ctx.lastSave.get(p.username)) && parseSave(store.get(p.username)).crcOk), { records: store.size });
    T.check("and a _meta: a new store (its bots get an age), the human's friend list", store.meta?.v === 1 && store.meta.ageing === true && store.meta.friends?.[HUMAN]?.friends?.join() === b2.username && store.meta.quit?.length === 0, store.meta);
    // (the real library: BotManager.exportWorld; the stub keeps no world)
    if (!ctx.stub) T.check('and the living world: every bot online, with the rest of its session (_meta.world)', store.meta?.world?.v === 1 && activeBots(B).every(p => store.meta.world.online[p.username] > 0), store.meta?.world);

    T.phase('the 15-minute autosave');
    mark = S.puts.length;
    W.savePlayers();
    await waitFor(env, () => S.puts.length >= mark + 2, 5000 * ctx.slow, 'autosave PUTs').catch(() => {});
    await env.sleep(50);
    rels = S.puts.slice(mark).map(p => p.rel);
    T.check('autosave: the human, then one bots.sav', rels.join() === [playerRel(ctx, HUMAN), botsSav].join(), rels);

    T.phase('a failed bots.sav write: logged, kept, said apart (lifecycle-done.bots), written on resume - never a failed save');
    S.failPut = rel => rel.startsWith('bots/');
    const failedSave = await page.sendLifecycle('save', 20000 * ctx.slow);
    T.check("lifecycle 'save' ok: the human's save was written", failedSave.ok === true && S.puts.slice(-1)[0]?.rel === playerRel(ctx, HUMAN), failedSave);
    T.check("lifecycle-done says the bots were not: bots {ok: false, error: 'HTTP 500'}", failedSave.bots?.ok === false && /HTTP 500/.test(failedSave.bots.error ?? ''), failedSave.bots);
    T.check('the failed bots.sav write is logged as an error', page.logsMatching(/\[bots\] FAILED to write bots\//).length === 1);
    // still failing when the app goes to the background; storage works again when it comes back: the resume writes it
    const failedPause = await page.sendLifecycle('pause', 20000 * ctx.slow);
    S.failPut = false;
    mark = S.puts.length;
    const resumed = await page.sendLifecycle('resume', 20000 * ctx.slow);
    rels = S.puts.slice(mark).map(p => p.rel);
    T.check('pause: ok, bots not saved; resume: bots.sav written (once), bots {ok: true}', failedPause.ok === true && failedPause.bots?.ok === false && resumed.ok === true && resumed.bots?.ok === true && rels.join() === botsSav && page.logsMatching(/after earlier failures/).length === 1, { pause: failedPause, resume: resumed, rels });
    const resumedStore = parseBotStore(S.read(botsSav));
    T.check("what the resume wrote is every bot's newest save (the pause's)", activeBots(B).every(p => equalBytes(resumedStore.get(p.username), ctx.lastSave.get(p.username))), { records: resumedStore.size });
    mark = S.puts.length;
    const nextSave = await page.sendLifecycle('save', 20000 * ctx.slow);
    T.check('the next save: the human, then bots.sav, bots {ok: true}', nextSave.ok === true && nextSave.bots?.ok === true && S.puts.slice(mark).map(p => p.rel).join() === [playerRel(ctx, HUMAN), botsSav].join(), nextSave);

    T.phase("a human logs in with a bot's name: the bot leaves, the name is theirs");
    const victim = b5.username;
    b5.preventLogoutUntil = W.currentTick + 100000; // as if it were fighting: it leaves anyway
    mark = S.puts.length;
    const { bot: intruder, response: r2 } = await login(ctx, victim, { tele: false });
    T.check('login 2 (a fresh character)', r2 === 2 && B.collisions.yielded === 1, { response: r2, collisions: { yielded: B.collisions.yielded, refused: B.collisions.refused } });
    T.check('a new character: the library hears it', ctx.newCharacters === 2, ctx.newCharacters);
    const now = W.getPlayerByUsername(victim);
    T.check('the bot left; the player with the name is the human', !!now && now instanceof H.NetworkPlayer && !activeBots(B).includes(b5));
    const putsNow = S.puts.slice(mark);
    const final = putsNow.filter(p => p.rel === botsSav).map(p => parseBotStore(p.bytes).get(victim));
    const botFinal = ctx.lastSave.get(victim); // the bot's save() at its logout (the human has not saved yet)
    T.check('its final save went to bots.sav (exactly its last save()), nothing to players/', final.length >= 1 && equalBytes(final[final.length - 1], botFinal) && !putsNow.some(p => p.rel === playerRel(ctx, victim)), { botsSavPuts: final.length, rels: putsNow.map(p => p.rel) });
    T.check('the name is released (BotManager.ownsName false)', !B.BotManager.ownsName(victim));
    mark = S.puts.length;
    await logout(ctx, intruder);
    await waitFor(env, () => S.puts.slice(mark).some(p => p.rel === playerRel(ctx, victim)), 10000 * ctx.slow, 'the human save').catch(() => {});
    T.check("the human's save goes to players/ now; the bot's record stays", S.puts.slice(mark).some(p => p.rel === playerRel(ctx, victim)) && equalBytes(parseBotStore(S.read(botsSav)).get(victim), botFinal));

    T.phase('a bot that cannot leave: the login is refused like an online account');
    const stuck = b6.username;
    // (not through preventLogoutUntil: a retiring bot drops the combat logout lock; processLogouts never removes a
    // player that cannot be accessed, e.g. one in the middle of a delayed action)
    b6.canAccess = () => false;
    const heldFrom = W.currentTick;
    const { response: r3 } = await login(ctx, stuck, { tele: false });
    const heldTicks = W.currentTick - heldFrom;
    T.check(`refused with 5 after the hold (${B.collisions.holdTicks} ticks)`, r3 === 5 && B.collisions.refused === 1 && heldTicks >= B.collisions.holdTicks && heldTicks <= B.collisions.holdTicks + 5, { response: r3, refused: B.collisions.refused, heldTicks });
    T.check('the bot is still in the world', W.getPlayerByUsername(stuck) === b6);
    delete b6.canAccess;
    await waitFor(env, () => !W.getPlayerByUsername(stuck), 10000 * ctx.slow, 'the stuck bot leaving').catch(() => {});
    await env.sleep(50);
    // (nobody waits for its name any more: its record goes to bots.sav with the write that is due, docs/BOTS.md §4.5)
    await waitTicks(ctx, H, B.storeWrites.everyTicks + 2);
    T.check('once it can, it leaves; save in bots.sav (the write due at most N ticks later), name released', !W.getPlayerByUsername(stuck) && !B.BotManager.ownsName(stuck) && equalBytes(parseBotStore(S.read(botsSav)).get(stuck), ctx.lastSave.get(stuck)));

    T.phase('pause / resume with bots online, while a login waits for a bot to leave');
    // the login waits while the bot cannot leave yet; the app goes to the background for longer than the hold
    const waiting = b7.username;
    b7.canAccess = () => false;
    const heldLogin = login(ctx, waiting, { tele: false });
    await waitFor(env, () => B.collisions.held.has(waiting), 10000 * ctx.slow, 'the login held');
    const online = activeBots(B).length;
    mark = S.puts.length;
    const lp = await page.sendLifecycle('pause', 20000 * ctx.slow);
    rels = S.puts.slice(mark).map(p => p.rel);
    T.check("pause ok: the human, then bots.sav", lp.ok === true && rels.join() === [playerRel(ctx, HUMAN), botsSav].join(), { ok: lp.ok, rels });
    human.stopKeepalive();
    const tickAtPause = W.currentTick;
    if (env.clock) env.clock.advance(60000);
    await env.sleep(B.collisions.holdTicks * W.tickRate + 1500); // longer than the hold, in real time
    T.check('no ticks while paused', W.currentTick === tickAtPause);
    T.check('the waiting login is not refused while the world is paused (the hold counts ticks)', B.collisions.held.has(waiting) && B.collisions.refused === 1, { held: [...B.collisions.held.keys()], refused: B.collisions.refused });
    const lr = await page.sendLifecycle('resume', 20000 * ctx.slow);
    human.startKeepalive(500);
    delete b7.canAccess;
    const { bot: lateComer, response: r4 } = await heldLogin;
    T.check('after the resume the bot leaves and the login is answered: 2', r4 === 2 && B.collisions.yielded === 2 && B.collisions.refused === 1 && W.getPlayerByUsername(waiting) instanceof H.NetworkPlayer, { response: r4, yielded: B.collisions.yielded });
    await waitTicks(ctx, H, 5);
    // (the waiting bot left; with the real library others from the pool may have taken the places of the bots that left
    // for humans since: up to N)
    T.check('resumed: the bots are still online and kept alive', lr.ok === true && activeBots(B).length >= online - 1 && activeBots(B).length <= N && activeBots(B).every(p => W.currentTick - p.lastResponse <= 2), { online, now: activeBots(B).length });
    await logout(ctx, lateComer);

    T.phase("an engine error in a bot's turn every tick: each line shown 3 times a window, then one summary");
    // World.processPlayers logs a player's error (console.error(err)) and logs a human out; a bot stays, so it would be
    // logged every tick. Another line meanwhile, seen for the first time, is shown at once.
    const windowTicks = B.logLimits.windowTicks;
    // (errors of the engine's realm, as the engine's own are: boot.js formats an Error by its stack)
    const EngineError = W.constructor.constructor('return Error')();
    const failing = activeBots(B)[0];
    const other = activeBots(B)[1];
    const message = `injected engine error in ${failing.username}'s turn (test)`;
    const once = `another injected error, once (test)`;
    const logsFrom = page.logs.length;
    const counted = { ...B.bots.counters };
    const summaries0 = B.logLimits.summaries;
    const firstTick = W.currentTick;
    failing.processQueues = () => {
        throw new EngineError(message);
    };
    await waitTicks(ctx, H, windowTicks + 3);
    other.processQueues = function () {
        delete this.processQueues;
        throw new EngineError(once);
    };
    await waitTicks(ctx, H, windowTicks + 3);
    delete failing.processQueues;
    const lastTick = W.currentTick;
    await waitTicks(ctx, H, windowTicks + 2); // the last window ends: its summary
    const lines = page.logs.slice(logsFrom);
    const shown = lines.filter(l => l.level === 'error' && l.text.includes(message) && !/not shown/.test(l.text));
    const summaries = lines.filter(l => /^\[engine\] \d+ repeated error lines were not shown in ticks \d+-\d+/.test(l.text));
    const notShownSum = summaries.reduce((n, l) => n + Number(/^\[engine\] (\d+) /.exec(l.text)[1]), 0);
    const windows = Math.floor((lastTick - 1) / windowTicks) - Math.floor(firstTick / windowTicks) + 1;
    const errors = B.bots.counters.engineErrors - counted.engineErrors;
    const notShown = B.bots.counters.linesNotShown - counted.linesNotShown;
    const detail = { ticks: lastTick - firstTick, windows, errors, shown: shown.length, notShown, summaries: summaries.map(l => l.text.slice(0, 200)) };
    T.check(`the error line shown at most 3 times in each of the ${windows} windows (and at least 3)`, shown.length >= 3 && shown.length <= 3 * windows && errors >= 2 * windowTicks, detail);
    // (the first and the last window may have 3 lines or fewer: nothing held back, no summary)
    T.check('one summary line per window that held lines back, naming the line; every line counted', summaries.length >= windows - 2 && summaries.length <= windows && summaries.every(l => l.text.includes(message)) && notShown === notShownSum && errors === shown.length + notShown + 1 && B.logLimits.summaries - summaries0 === summaries.length, detail);
    T.check('a line seen for the first time is shown at once', lines.some(l => l.level === 'error' && l.text.includes(once)));

    const expected = /\[bots\] FAILED to write bots\/|injected engine error|another injected error|repeated error lines were not shown/;
    const errorsBeforeExit = page.logs.filter(l => l.level === 'error' && !expected.test(l.text)).map(l => l.text.split('\n')[0]);
    T.check('no other errors logged so far', errorsBeforeExit.length === 0, errorsBeforeExit.slice(0, 5));
    T.check("no 'bots' message to the page: the bots ran all along", page.botsMessages.length === 0, page.botsMessages);

    T.phase('exit (a crash in a tick): the human and ONE bots.sav with every bot');
    mark = S.puts.length;
    W.processNpcEventQueue = () => {
        throw new Error('injected tick failure (test)');
    };
    await waitFor(env, () => page.exits.length > 0, 10000 * ctx.slow, 'exit');
    await env.sleep(300);
    human.stopKeepalive();
    const exitPuts = S.puts.slice(mark);
    const exitStore = exitPuts.filter(p => p.rel === botsSav);
    T.check('exactly one exit', page.exits.length === 1 && page.exits[0].code === 1, page.exits);
    // (every bot online, and the ones that left: those whose names humans took and, with the real library, the pool's
    // bots that took their places)
    const exitRecords = exitStore.length === 1 ? parseBotStore(exitStore[0].bytes) : new Map();
    T.check("the human's save and one bots.sav with all the bots", exitPuts.some(p => p.rel === playerRel(ctx, HUMAN)) && exitStore.length === 1 && exitRecords.size >= N && activeBots(B).every(p => exitRecords.has(p.username)), { rels: exitPuts.map(p => p.rel), records: exitRecords.size });
    const humanPuts = S.puts.filter(p => p.rel.startsWith('players/')).map(p => p.rel);
    T.check('no bot save ever under players/ (only the three humans)', humanPuts.every(r => r === playerRel(ctx, HUMAN) || r === playerRel(ctx, victim) || r === playerRel(ctx, waiting)), [...new Set(humanPuts)]);
    T.metric('botTicks', B.botTickSummary());
    T.metric('collisions', { yielded: B.collisions.yielded, refused: B.collisions.refused });
}

// ---- boot 2: the same Documents, the bots come back -----------------------------------------------------------

async function bootRestore(ctx) {
    const { env, T, S, N, botsSav } = ctx;
    const saved = parseBotStore(S.read(botsSav));
    const { H, B, W } = await bootWithBots(ctx);

    T.phase('bots.sav is read once');
    T.check('GET bots.sav 200, every record loaded', S.gets.filter(g => g.rel === botsSav).map(g => g.status).join() === '200' && B.botStore.source === 'file' && B.botStore.records.size === saved.size, { records: B.botStore.records.size, saved: saved.size });
    // the names humans took in boot 1 (the name collision, and the login that waited through a pause) have a save in
    // players/ now
    const taken = [...saved.keys()].filter(n => S.read(`players/${ctx.profile}/${n}.sav`));
    T.check('the names humans took are reserved now (from /save-index)', taken.length === 2 && taken.every(n => B.humanNames.has(n)), taken);

    T.phase('a human logs in: the saved bots come back');
    const { bot: human, response } = await login(ctx, HUMAN);
    T.check('login 2', response === 2);
    T.check('not a new character (it has a save)', ctx.newCharacters === 0, ctx.newCharacters);
    const friendNames = saved.meta?.friends?.[HUMAN]?.friends ?? [];
    // (sent once the bots are in: friends.ts holds it back while they join, so it comes without a line for each)
    await waitFor(env, () => friendNames.every(n => human.friends.some(f => f.name37 === toUserhash(n))), 40 * 1000 * ctx.slow, 'the friend list').catch(() => {});
    T.check("the human's friend list comes back from _meta once the bots are in", friendNames.length === 1 && friendNames.every(n => human.friends.some(f => f.name37 === toUserhash(n))), { saved: friendNames, got: human.friends.map(f => String(f.name37)) });
    await waitFor(env, () => B.BotManager.stats().spawned >= N, (20000 + N * 500) * ctx.slow, `${N} bots`).catch(() => {});
    const bots = activeBots(B);
    const restored = bots.filter(p => saved.has(p.username));
    T.check(`${taken.join(' and ')} are skipped, other names take their slots`, taken.every(n => B.BotManager.stats().skipped.includes(n) && !W.getPlayerByUsername(n)?.is_bot) && bots.length === N, { skipped: B.BotManager.stats().skipped, bots: bots.length });
    // Each as saved: Attack 50 from boot 1 for the bots that were in the world then, a level of their own for the pool's
    // bots that took the places of those whose names humans took. The stub brings back the same N; the real library
    // the N that were online when boot 1 ended (continue after a restart: _meta.world), its pool's replacements included.
    const attackAsSaved = p => ctx.spawnedAt.get(p.username)?.attackNow === parseSave(saved.get(p.username)).stats[0].level;
    const enough = restored.length >= N - taken.length;
    if (!ctx.stub) {
        const wasOnline = Object.keys(saved.meta?.world?.online ?? {});
        // (the places of the bots whose names humans took are filled by the pool's bots: in _meta.world if they were in
        // the world by the last write)
        T.check(`the bots online when boot 1 ended are the ones back (${wasOnline.length} in _meta.world)`, wasOnline.length >= N - taken.length && wasOnline.every(n => bots.some(p => p.username === n)), { wasOnline, bots: bots.map(p => p.username) });
    }
    T.check('the bots are back from bots.sav (attack 50 from boot 1)', enough && restored.every(attackAsSaved) && restored.some(p => ctx.spawnedAt.get(p.username)?.attack >= 50), restored.map(p => [p.username, ctx.spawnedAt.get(p.username)?.attack]));
    T.check('where they were saved', restored.every(p => {
        const s = parseSave(saved.get(p.username));
        const at = ctx.spawnedAt.get(p.username);
        return at && at.x === s.x && at.z === s.z;
    }));
    if (ctx.stub) T.check('the backfill name comes from the end of the list', bots.some(p => p.username === 'stub_bot120'), bots.map(p => p.username));
    const mark = S.puts.length;
    const ls = await ctx.page.sendLifecycle('save', 20000 * ctx.slow);
    T.check('a save writes bots.sav again (the old one becomes the .bak), bots {ok: true}', ls.ok && ls.bots?.ok === true && S.puts.slice(mark).some(p => p.rel === botsSav));
    T.check("no 'bots' message to the page", ctx.page.botsMessages.length === 0, ctx.page.botsMessages);

    T.phase('Settings › Saved data: a deleted character takes its friend lists with it');
    const gone = 'botstest9';
    const { bot: other, response: r9 } = await login(ctx, gone);
    T.check('login 2', r9 === 2);
    friendAdd(other, bots[0].username);
    await waitTicks(ctx, H, 2);
    await logout(ctx, other);
    T.check('its friend list is in _meta', B.botStore.meta.friends[gone]?.friends?.join() === bots[0].username, B.botStore.meta.friends[gone]);
    const markDelete = S.puts.length;
    const deleted = await ctx.page.sendDelete(gone, 10000 * ctx.slow);
    T.check('deleted (ok), the save kept as .bak', deleted.ok === true && !S.read(playerRel(ctx, gone)) && !!S.read(`${playerRel(ctx, gone)}.bak`), deleted);
    const after = parseBotStore(S.read(botsSav));
    T.check('its lists left _meta and bots.sav at once; the others stay', !(gone in B.botStore.meta.friends) && S.puts.slice(markDelete).some(p => p.rel === botsSav) && !after.meta.friends[gone] && !!after.meta.friends[HUMAN], Object.keys(after.meta.friends));
}

// ---- boot 2b: the living world - bots log out and back in; the human sees it; the friend list stays -----------------

async function bootLiving(ctx) {
    const { env, T, S, N, botsSav } = ctx;
    const { H, B, W } = await bootWithBots(ctx);
    const userhash = new Map();
    const nameOf = h => userhash.get(h);

    T.phase('the friend lists of a character with no save are dropped at load (deleted while the bots were off)');
    T.check(`${DELETED_HUMAN}'s lists dropped, the others kept`, !(DELETED_HUMAN in B.botStore.meta.friends) && !!B.botStore.meta.friends[HUMAN] && ctx.page.logsMatching(/dropped the friend lists of 1 deleted character/).length === 1, Object.keys(B.botStore.meta.friends));

    T.phase('a human logs in and adds bots to its friend list');
    let { bot: human, response } = await login(ctx, HUMAN);
    T.check('login 2', response === 2);
    await waitFor(env, () => activeBots(B).length >= N, (20000 + N * 500) * ctx.slow, `${N} bots`).catch(() => {});
    // the levelling bots, whose sessions end where they are (PKers and social bots go to the Wilderness, Edgeville ...)
    const friends = activeBots(B).slice(0, Math.min(6, N));
    for (const p of friends) {
        userhash.set(toUserhash(p.username), p.username);
        // the engine takes one social packet per player a tick (socialProtect) and drops the next: when the ticks run
        // late two adds can reach one tick, so each waits until it is in the list, and goes again if it was dropped
        const listed = () => !!B.botStore.meta.friends[HUMAN]?.friends.includes(p.username);
        for (let attempt = 0; attempt < 3 && !listed(); attempt++) {
            friendAdd(human, p.username);
            const until = W.currentTick + 3;
            await waitFor(env, () => listed() || W.currentTick >= until, 10000 * ctx.slow, 'the friend add').catch(() => {});
        }
    }
    await waitTicks(ctx, H, 2);
    T.check('each shows online (node 10)', friends.every(p => human.friends.some(f => f.name37 === toUserhash(p.username) && f.node === 10)), human.friends.length);

    T.phase('a friend logs out: the human sees it; it comes back from its save, and the human sees that too');
    let mark = human.friends.length;
    if (ctx.stub) B.BotManager.logOff(friends[0].username);
    const out = () => human.friends.slice(mark).find(f => userhash.has(f.name37) && f.node === 0);
    await waitFor(env, () => !!out(), (ctx.stub ? 10000 : 60000) * ctx.slow, 'a friend logging out').catch(() => {});
    const left = out() && nameOf(out().name37);
    T.check('UPDATE_FRIENDLIST node 0 ("has logged out")', !!left, human.friends.slice(mark).map(f => [nameOf(f.name37) ?? String(f.name37), f.node]));
    if (left) {
        await waitTicks(ctx, H, 2);
        const record = B.botStore.get(left);
        T.check('its record in the store is its last save()', !!record && equalBytes(record, ctx.lastSave.get(left)) && !W.getPlayerByUsername(left), { left });
        const recordAtLogout = record && record.slice();
        mark = human.friends.length;
        ctx.spawnedAt.delete(left);
        if (ctx.stub) B.BotManager.comeBack(left);
        const back = () => human.friends.slice(mark).find(f => f.name37 === toUserhash(left) && f.node === 10);
        await waitFor(env, () => !!back(), (ctx.stub ? 10000 : 90000) * ctx.slow, `${left} coming back`).catch(() => {});
        T.check('it comes back: node 10 again ("has logged in")', !!back(), human.friends.slice(mark).map(f => [nameOf(f.name37) ?? String(f.name37), f.node]));
        const at = ctx.spawnedAt.get(left);
        const s = recordAtLogout && parseSave(recordAtLogout);
        T.check('where it logged out, from its record (no new character)', !!at && !!s && at.x === s.x && at.z === s.z && at.level === s.level, { at, saved: s && [s.x, s.z, s.level] });
    }

    // docs/BOTS.md §4.5: a bot's own logout updates its record in memory; the store is written for those at most once
    // every storeWrites.everyTicks world ticks, the first at once, the rest with the first tick that is due. The stub's
    // bots are sent out a few ticks apart (logOff); the real library's short sessions (LIVING) log bots out by themselves.
    T.phase("the bots' own logouts: bots.sav written at most once every N ticks; the newest records arrive with the write that is due");
    {
        const every = B.storeWrites.everyTicks;
        const putTicks = [];
        S.failPut = rel => {
            if (rel === botsSav) putTicks.push(W.currentTick);
            return false;
        };
        const coalesced0 = B.storeWrites.coalesced;
        const held0 = B.storeWrites.held;
        const sent = [];
        if (ctx.stub) {
            await ctx.page.sendLifecycle('save', 20000 * ctx.slow); // (a write now: the next ones are held)
            putTicks.length = 0;
            for (const p of activeBots(B).filter(p => !friends.includes(p)).slice(0, 3)) {
                if (B.BotManager.logOff(p.username)) sent.push(p.username);
                await waitTicks(ctx, H, 3);
            }
        }
        await waitTicks(ctx, H, every * 2 + 5);
        S.failPut = false;
        const gaps = putTicks.slice(1).map((t, i) => t - putTicks[i]);
        const detail = { every, putTicks, held: B.storeWrites.held - held0, coalesced: B.storeWrites.coalesced - coalesced0, sent };
        T.check(`no two bots.sav writes for the bots' logouts less than ${every} ticks apart; some logouts waited and were written together`, putTicks.length >= 1 && gaps.every(g => g >= every) && B.storeWrites.held > held0 && B.storeWrites.coalesced > coalesced0, detail);
        if (ctx.stub) {
            const file = parseBotStore(S.read(botsSav));
            T.check('the stub: the 3 logouts held (a save had just written the store), then ONE write with the last save() of each', sent.length === 3 && putTicks.length === 1 && sent.every(n => equalBytes(file.get(n), ctx.lastSave.get(n))), { ...detail, inFile: sent.map(n => equalBytes(file.get(n), ctx.lastSave.get(n))) });
            for (const n of sent) B.BotManager.comeBack(n);
            await waitTicks(ctx, H, 3);
        }
    }

    T.phase('the human logs out and in again: the friend list is sent at login');
    {
        // the human's logout is a save occasion: the store is written right after the human's save, also when the last
        // write was a moment ago (an unsaved change of the store's own: what a friend-list change leaves)
        await ctx.page.sendLifecycle('save', 20000 * ctx.slow);
        B.botStore.touch();
        const markLogout = S.puts.length;
        await logout(ctx, human);
        await waitFor(env, () => S.puts.slice(markLogout).some(p => p.rel === botsSav), 5000 * ctx.slow, 'bots.sav after the logout').catch(() => {});
        const rels = S.puts.slice(markLogout).map(p => p.rel);
        const humanAt = rels.indexOf(playerRel(ctx, HUMAN));
        T.check("the human's logout writes bots.sav right after the human's save (a save occasion, not held)", humanAt >= 0 && rels.indexOf(botsSav) > humanAt, rels);
    }
    if (!ctx.stub) {
        // nobody in the world: every bot logs out (the title screen), its save in the store
        await waitFor(env, () => ![...W.playerLoop.all()].some(p => p.is_bot === true), 20000 * ctx.slow, 'the bots leaving the empty world').catch(() => {});
        T.check('the empty world: every bot logged out', ![...W.playerLoop.all()].some(p => p.is_bot === true) && B.BotManager.stats().active === 0, B.BotManager.stats());
    }
    ({ bot: human, response } = await login(ctx, HUMAN));
    T.check('login 2', response === 2);
    await waitFor(env, () => friends.every(p => human.friends.some(f => f.name37 === toUserhash(p.username))), 40 * 1000 * ctx.slow, 'the friend list').catch(() => {});
    T.check('every friend is in the list sent once the world filled', friends.every(p => human.friends.some(f => f.name37 === toUserhash(p.username))), human.friends.map(f => [nameOf(f.name37) ?? String(f.name37), f.node]));
    // one entry each, with where it is now: not offline first and then "has logged in" for each bot that joined
    T.check('each friend once, in its state now (no line for each bot joining the world)', friends.every(p => human.friends.filter(f => f.name37 === toUserhash(p.username)).length === 1 && human.friends.find(f => f.name37 === toUserhash(p.username)).node === (W.getPlayerByUsername(p.username) ? 10 : 0)), human.friends.map(f => [nameOf(f.name37) ?? String(f.name37), f.node]));
    if (!ctx.stub) {
        await waitFor(env, () => activeBots(B).length >= N - 1, (20000 + N * 500) * ctx.slow, 'the world filling again').catch(() => {});
        T.check('the world fills again', activeBots(B).length >= N - 1, B.BotManager.stats());

        T.phase('newcomers join and old accounts quit; the store keeps the quit names');
        await waitFor(env, () => B.BotManager.stats().quits >= 1, 120000 * ctx.slow, 'a quit').catch(() => {});
        const st = B.BotManager.stats();
        T.check('newcomers joined (the timer), and one old account quit', st.newcomers >= 1 && st.quits >= 1, st);
        const ls = await ctx.page.sendLifecycle('save', 20000 * ctx.slow);
        const store = parseBotStore(S.read(botsSav));
        const quit = store.meta?.quit ?? [];
        T.check('bots.sav: the quit names in _meta, their records gone; no friend quit', ls.ok && quit.length === st.quits && quit.every(n => !store.has(n)) && friends.every(p => !quit.includes(p.username)), { quit, records: store.size });
    }

    T.phase("a human logs in with the name of a bot that is away: at once, a new character; the bot never comes back");
    // a bot out of the world between sessions, its record in the store (not a friend: their lists are checked above)
    let away = null;
    const isAway = n => !W.getPlayerByUsername(n) && !W.logoutRequests.has(n) && B.BotManager.ownsName(n) && !!B.botStore.get(n);
    if (ctx.stub) {
        const p = activeBots(B).find(p => !friends.includes(p));
        if (p && B.BotManager.logOff(p.username)) away = p.username;
        await waitFor(env, () => !!away && isAway(away), 10000 * ctx.slow, 'a bot logging out').catch(() => {});
    } else {
        // the real library's sessions end on their own (40-80 ticks here); a bot is away 20-60 ticks
        const online = new Set(activeBots(B).filter(p => !friends.includes(p)).map(p => p.username));
        await waitFor(env, () => (away = [...online].find(isAway) ?? null) !== null, 60000 * ctx.slow, 'a bot logging out').catch(() => {});
    }
    T.check('a bot is away: out of the world, its record in the store', !!away && isAway(away), { away });
    if (away) {
        const record = B.botStore.get(away).slice();
        const yielded = B.collisions.yielded;
        let mark = S.puts.length;
        const { bot: taker, response: r } = await login(ctx, away, { tele: false });
        T.check('login 2, answered at once (no bot to wait for)', r === 2 && B.collisions.yielded === yielded && !B.collisions.held.has(away), { response: r, yielded: B.collisions.yielded - yielded });
        T.check("the player with the name is the human; the name is the human's now (reserved, not the bots')", W.getPlayerByUsername(away) instanceof H.NetworkPlayer && B.humanNames.has(away) && !B.BotManager.ownsName(away));
        await logout(ctx, taker);
        await waitFor(env, () => S.puts.slice(mark).some(p => p.rel === playerRel(ctx, away)), 10000 * ctx.slow, 'the human save').catch(() => {});
        T.check("the human's save goes to players/; the bot's record is not the human's", S.puts.slice(mark).some(p => p.rel === playerRel(ctx, away)) && S.puts.slice(mark).every(p => p.rel !== botsSav || !parseBotStore(p.bytes).has(away) || equalBytes(parseBotStore(p.bytes).get(away), record)));
        // longer than the bot's time away
        await waitTicks(ctx, H, 80);
        T.check('the bot never comes back, also with the human gone', !W.getPlayerByUsername(away) && !B.BotManager.ownsName(away) && (!ctx.stub || B.BotManager.comeBack(away) === false), { inWorld: !!W.getPlayerByUsername(away) });
    }

    const errors = ctx.page.logs.filter(l => l.level === 'error').map(l => l.text.split('\n')[0]);
    T.check('no errors logged', errors.length === 0, errors.slice(0, 5));

    T.phase('the bots turned off mid-session (disableBots): every bot leaves with its last save in bots.sav; the human plays on');
    const leaving = activeBots(B).map(p => p.username);
    const told = ctx.page.botsMessages.length;
    B.disableBots('the test turns them off', 'failed');
    await waitFor(env, () => ![...W.playerLoop.all()].some(p => p.is_bot === true), 20000 * ctx.slow, 'the bots leaving').catch(() => {});
    await waitTicks(ctx, H, 2);
    T.check('every bot left the world', leaving.length > 0 && ![...W.playerLoop.all()].some(p => p.is_bot === true), { leaving: leaving.length, still: [...W.playerLoop.all()].filter(p => p.is_bot === true).map(p => p.username) });
    // (they leave like any bot: their records in memory at once, in bots.sav with the write that is due)
    await waitTicks(ctx, H, B.storeWrites.everyTicks + 2);
    const after = parseBotStore(S.read(botsSav));
    T.check("bots.sav (the write due at most N ticks later): each one's record is its last save()", leaving.every(n => equalBytes(after.get(n), ctx.lastSave.get(n))) && !B.botStore.dirty, leaving.filter(n => !equalBytes(after.get(n), ctx.lastSave.get(n))));
    const heard = ctx.page.botsMessages.slice(told);
    T.check("the page hears it once: {type:'bots', active:false, reason:'failed'}", heard.length === 1 && heard[0].active === false && heard[0].reason === 'failed', heard);
    await waitTicks(ctx, H, 30);
    T.check('the human plays on; no bot comes back', W.getPlayerByUsername(HUMAN) instanceof H.NetworkPlayer && !human.conn.closedByServer && ![...W.playerLoop.all()].some(p => p.is_bot === true) && B.bots.phase === 'disabled');
    const offErrors = ctx.page.logs.filter(l => l.level === 'error').map(l => l.text.split('\n')[0]).slice(errors.length);
    T.check('the one error logged is the notice', offErrors.length === 1 && /bots are off for this session: the test turns them off/.test(offErrors[0]), offErrors);
}

// ---- boot 3: bots.sav cannot be read -> bots off for the session; nothing under bots/ is used or written ---------

async function bootUnreadable(ctx) {
    const { T, page, S, botsSav } = ctx;
    const before = S.read(botsSav);
    const bakBefore = S.read(`${botsSav}.bak`);
    S.failGet = rel => rel.startsWith('bots/');
    const { H, B, W } = await bootWithBots(ctx);
    S.failGet = false;
    T.phase('bots.sav cannot be read: bots off, the older .bak is not used');
    const gets = S.gets.filter(g => g.rel.startsWith('bots/'));
    T.check('bots.sav read twice (both 500), never the .bak; bots off with an error logged; the world started', B.bots.phase === 'disabled' && gets.length === 2 && gets.every(g => g.rel === botsSav && g.status === 500) && page.logsMatching(/bots are off for this session: .*cannot be read/).length === 1 && !!page.ready, { phase: B.bots.phase, gets });
    const told = page.botsMessages;
    T.check("the page hears it once: {type:'bots', active:false, reason:'store-unreadable'}", told.length === 1 && told[0].active === false && told[0].reason === 'store-unreadable' && /cannot be read/.test(told[0].detail) && told[0].afterBooted, told);
    const { response } = await login(ctx, HUMAN);
    T.check('a human logs in and plays', response === 2);
    await waitTicks(ctx, H, 10);
    T.check('no bot joins', [...W.playerLoop.all()].every(p => p instanceof H.NetworkPlayer) && ctx.spawnedAt.size === 0);
    const mark = S.puts.length;
    const ls = await page.sendLifecycle('save', 20000 * ctx.slow);
    T.check('saves work; bots.sav and bots.sav.bak are untouched', ls.ok && S.puts.slice(mark).every(p => !p.rel.startsWith('bots/')) && equalBytes(S.read(botsSav), before) && equalBytes(S.read(`${botsSav}.bak`), bakBefore), S.puts.slice(mark).map(p => p.rel));
    T.check('lifecycle-done has no bots part (no bot store this session)', !('bots' in ls), ls);
}

// ---- boot 4: bots.sav corrupt -> bots.sav.bak ----------------------------------------------------------------

async function bootBak(ctx) {
    const { env, T, page, S, N, botsSav } = ctx;
    const bak = parseBotStore(S.read(`${botsSav}.bak`));
    const { B } = await bootWithBots(ctx);
    T.phase('bots.sav is corrupt: bots.sav.bak');
    T.check('the bots start from bots.sav.bak (warning logged)', B.bots.phase === 'started' && B.botStore.source === 'bak' && B.botStore.records.size === bak.size && page.logsMatching(/using bots\.sav\.bak/).length === 1, { source: B.botStore.source, phase: B.bots.phase });
    const { response } = await login(ctx, HUMAN);
    T.check('login 2', response === 2);
    await waitFor(env, () => B.BotManager.stats().spawned >= N, (20000 + N * 500) * ctx.slow, `${N} bots`).catch(() => {});
    const back = activeBots(B).filter(p => bak.has(p.username));
    const taken = [...bak.keys()].filter(n => S.read(`players/${ctx.profile}/${n}.sav`)); // (humans have those names)
    // (each as its .bak record has it: where it was and its Attack level - 50 from boot 1 for most of them)
    const asSaved = p => {
        const at = ctx.spawnedAt.get(p.username);
        const s = parseSave(bak.get(p.username));
        return !!at && at.x === s.x && at.z === s.z && at.attackNow === s.stats[0].level;
    };
    T.check('the bots are back from the .bak', back.length >= N - taken.length && back.every(asSaved) && back.some(p => ctx.spawnedAt.get(p.username).attack >= 50), { back: back.length, taken, differ: back.filter(p => !asSaved(p)).map(p => p.username) });
    const mark = S.puts.length;
    await page.sendLifecycle('save', 20000 * ctx.slow);
    const written = S.puts.slice(mark).find(p => p.rel === botsSav);
    let good = false;
    let missing = [];
    let quit = [];
    try {
        const records = parseBotStore(written.bytes);
        // (but a bot that quit meanwhile: the living world runs on its short test timings, and a newcomer over the
        // pool's size makes an old account quit; its name is in _meta.quit. On a slow machine one did, now and then)
        quit = records.meta?.quit ?? [];
        missing = [...bak.keys()].filter(n => !records.has(n) && !quit.includes(n));
        good = missing.length === 0; // and the backfilled bot, new in this boot
    } catch {
        // not a store
    }
    T.check('the next save writes a good bots.sav with every record of the .bak (but those of bots that quit)', good, { written: !!written, missing, quit });
    T.check("no 'bots' message to the page", page.botsMessages.length === 0, page.botsMessages);
}

// ---- boot 5: both corrupt -> bots off for the session ----------------------------------------------------------

async function bootCorrupt(ctx) {
    const { env, T, page, S, botsSav } = ctx;
    const before = S.read(botsSav);
    const { H, B, W } = await bootWithBots(ctx);
    T.phase('bots.sav and bots.sav.bak corrupt: bots off for the session');
    T.check('bots off, with an error logged; the world started', B.bots.phase === 'disabled' && page.logsMatching(/bots are off for this session/).length === 1 && !!page.ready, { phase: B.bots.phase, reason: B.bots.disabledReason });
    const told = page.botsMessages;
    T.check("the page hears it once: {type:'bots', active:false, reason:'store-corrupt'}", told.length === 1 && told[0].active === false && told[0].reason === 'store-corrupt' && /corrupt/.test(told[0].detail) && told[0].afterBooted, told);
    const { bot: human, response } = await login(ctx, HUMAN);
    T.check('a human logs in and plays', response === 2);
    human.cheat('getcoord');
    T.check('::getcoord answers', (await human.message(/^\d+,\d+,\d+,\d+,\d+$/)) === '0,50,50,22,18');
    await waitTicks(ctx, H, 10);
    T.check('no bot joins', [...W.playerLoop.all()].every(p => p instanceof H.NetworkPlayer) && ctx.spawnedAt.size === 0);
    const mark = S.puts.length;
    const ls = await page.sendLifecycle('save', 20000 * ctx.slow);
    T.check("saves work; nothing under bots/ is written (bots.sav untouched)", ls.ok && S.puts.slice(mark).every(p => !p.rel.startsWith('bots/')) && equalBytes(S.read(botsSav), before), S.puts.slice(mark).map(p => p.rel));
}

// ---- boot 6: bots.count 0 = the vanilla engine ------------------------------------------------------------------

async function bootOff(env) {
    let booted = null;
    let filesAtBoot = null;
    const botsMessages = [];
    env.onMessage(m => {
        if (m.type === 'booted') {
            booted = m;
            filesAtBoot = env.staticGets().slice();
        } else if (m.type === 'bots') {
            botsMessages.push(m);
        }
    });
    const session = await runSession(env);
    const T = createRunner(env);
    T.phase('bots off: exactly the vanilla engine');
    T.check('booted engine.js, bots 0, the 37 vanilla files', booted?.bundle === 'engine.js' && booted.bots === 0 && booted.files === 37 && env.bots === null, booted && { bundle: booted.bundle, bots: booted.bots, files: booted.files });
    const manifest = filesAtBoot ? filesAtBoot.filter(f => f !== 'engine/vfs-manifest.json' && f !== 'engine/bzip2.wasm') : [];
    T.check('fetched before booted: vfs-manifest.json, the 37 files (+ bzip2.wasm), nothing of the bots', !!filesAtBoot && filesAtBoot.includes('engine/vfs-manifest.json') && manifest.length === 37 && !filesAtBoot.some(f => /bots/.test(f)), filesAtBoot && filesAtBoot.filter(f => !f.startsWith('engine/vfs/') && !f.startsWith('cache/')));
    T.check('the vanilla script.dat, no overlay', !!filesAtBoot && filesAtBoot.includes('engine/vfs/data/pack/server/script.dat') && !env.staticGets().some(f => /scripts\.bin|vfs-manifest-bots|engine-bots/.test(f)));
    T.check('no request under bots/ and no /save-index', !env.storage.gets.some(g => g.rel.startsWith('bots/')) && !env.storage.puts.some(p => p.rel.startsWith('bots/')) && env.storage.indexGets === 0);
    const H = env.hooks;
    T.check('no bot hook in the worker: World wrapped only where the vanilla engine wraps it', !!H && !GLUE_WRAPPED.some(m => Object.prototype.hasOwnProperty.call(H.World, m)) && Object.prototype.hasOwnProperty.call(H.World, 'cycle'));
    T.check("no 'bots' message (none were asked for)", botsMessages.length === 0, botsMessages);
    const extra = T.result({ logs: [] });
    return {
        ...session,
        mode: 'off',
        ok: session.ok && extra.ok,
        passed: session.passed + extra.passed,
        failed: session.failed + extra.failed,
        checks: [...session.checks, ...extra.checks],
        vanillaSession: { passed: session.passed, failed: session.failed }
    };
}

// ---- bots asked for, but they cannot be loaded: engine.js, the world starts, and the page hears why ------------------
//   broken    a bots bundle whose library throws while it loads (bots.test.mjs builds one)
//   nobundle  a build without the bots (bots.test.mjs's vanilla build)

async function bootWithoutBots(env, mode) {
    const T = createRunner(env);
    const page = new Page(env, T);
    const expect = mode === 'broken' ? { reason: 'load-failed', log: /engine-bots\.js failed to load; starting without bots/, detail: /engine-bots\.js: .*failed to load \(test\)/ } : { reason: 'no-bundle', log: /bots were asked for, but this build has none/, detail: /vfs-manifest-bots\.json: HTTP 404/ };
    try {
        T.phase(mode === 'broken' ? 'the bot library throws while it loads' : 'bots asked of a build without them');
        page.post({ type: 'init', config: env.config });
        await waitFor(env, () => page.booted || page.exits.length, 120000 * (env.slow || 1), 'booted');
        T.check('booted engine.js without bots, with the reason logged', page.booted?.bundle === 'engine.js' && page.booted.bots === 0 && env.bots === null && page.logsMatching(expect.log).length === 1, page.booted && { bundle: page.booted.bundle, bots: page.booted.bots, exits: page.exits });
        await waitFor(env, () => page.botsMessages.length > 0, 5000 * (env.slow || 1), "the 'bots' message").catch(() => {});
        const told = page.botsMessages;
        T.check(`then the page hears it once: {type:'bots', active:false, reason:'${expect.reason}'}`, told.length === 1 && told[0].active === false && told[0].reason === expect.reason && expect.detail.test(told[0].detail) && told[0].afterBooted, told);
        if (mode === 'nobundle') T.check('nothing of the bots fetched but the manifest that is not there', !env.staticGets().some(f => /bots/.test(f) && f !== 'engine/vfs-manifest-bots.json'), env.staticGets().filter(f => /bots/.test(f)));
        page.post({ type: 'start' });
        await waitFor(env, () => page.ready || page.exits.length, 300000 * (env.slow || 1), 'ready');
        T.check('the world starts', !!page.ready && page.exits.length === 0, page.exits);
        const { response } = await login({ env, page, slow: env.slow || 1 }, HUMAN, { tele: false });
        T.check('a human logs in', response === 2, response);
    } catch (e) {
        T.fail('scenario aborted', e && e.stack ? e.stack : String(e));
    }
    return { ...T.result(page), mode };
}

const BOOTS = { main: bootMain, restore: bootRestore, living: bootLiving, unreadable: bootUnreadable, bak: bootBak, corrupt: bootCorrupt };
export const BOOT_ORDER = ['main', 'restore', 'living', 'unreadable', 'bak', 'corrupt', 'off'];

// ---- measurement (test/measure.mjs --bots): one boot with N bots (0 = engine.js) ------------------------------------

/** The bots' path searches per tick over the same window: average, most, the budget and the ticks that used it all. */
function searchStats(B, from, to) {
    const ring = B.botTickStats.searches;
    if (!ring) return null;
    const d = [];
    for (let i = Math.max(from, to - ring.length); i < to; i++) d.push(ring[i % ring.length]);
    const budget = B.botTickStats.searchBudget;
    return { avg: d.length ? +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(1) : 0, max: d.length ? Math.max(...d) : 0, budget, fullTicks: d.filter(n => budget > 0 && n >= budget).length };
}

function windowStats(ring, from, to) {
    const d = [];
    for (let i = Math.max(from, to - ring.length); i < to; i++) d.push(ring[i % ring.length]);
    d.sort((a, b) => a - b);
    const pick = q => (d.length ? +d[Math.min(d.length - 1, Math.floor(q * d.length))].toFixed(2) : 0);
    return { ticks: d.length, avgMs: d.length ? +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2) : 0, p50Ms: pick(0.5), p95Ms: pick(0.95), maxMs: d.length ? +d[d.length - 1].toFixed(2) : 0 };
}

/**
 * Boot with env.config's bots, start, log a human in at Lumbridge (the bots join), wait for the spawn ramp, then measure
 * `ticks` ticks at `rate` ms: tick times (all, and BotManager.tick's share), the bots' path searches per tick, heap after start and after the run
 * (env.heap(): MB after a full GC), and a lifecycle save. Returns one JSON-able row.
 */
export async function runBotsMeasure(env, { ticks = 100, rate = 300 } = {}) {
    const T = createRunner({ ...env, log: () => {} });
    const page = new Page({ ...env, verbose: false, log: () => {} }, T);
    const ctx = { env, T, page, S: env.storage, slow: env.slow || 1 };
    const N = env.config?.bots?.count ?? 0;
    page.post({ type: 'init', config: env.config });
    await waitFor(env, () => page.booted || page.exits.length, 120000 * ctx.slow, 'booted');
    page.post({ type: 'start' });
    await waitFor(env, () => page.ready || page.exits.length, 300000 * ctx.slow, 'ready');
    if (!page.ready) throw new Error(`no ready: ${JSON.stringify(page.exits)}`);
    const H = env.hooks;
    const B = env.bots;
    const heapAfterStart = env.heap();
    H.World.tickRate = rate;
    const { response } = await login(ctx, HUMAN);
    if (response !== 2) throw new Error(`login ${response}`);
    const ramp0 = H.ticker.tickStats.ticks;
    if (N > 0) {
        await waitFor(env, () => B.BotManager.stats().spawned + B.BotManager.stats().skipped.length >= N, (30000 + N * 2 * rate) * ctx.slow, `${N} bots`);
        await waitTicks(ctx, H, 10); // the first path searches of the last ones
    }
    const t0 = H.ticker.tickStats.ticks;
    const b0 = B ? B.botTickStats.ticks : 0;
    // (the bots' store writes during the run, and the bot logouts that asked for them: docs/BOTS.md §4.5's write rate)
    const puts0 = env.storage.puts.length;
    const logoffs0 = B ? B.BotManager.stats().logoffs : 0;
    await waitFor(env, () => H.ticker.tickStats.ticks >= t0 + ticks, (ticks * rate * 3 + 30000) * ctx.slow, `${ticks} ticks`);
    const t1 = H.ticker.tickStats.ticks;
    const b1 = B ? B.botTickStats.ticks : 0;
    const heapAfterRun = env.heap();
    const mark = env.storage.puts.length;
    const storePuts = env.storage.puts.slice(puts0, mark).filter(p => p.rel.startsWith('bots/'));
    // a world minute is 100 ticks at the world's 600 ms (the run's own tick rate is faster)
    const store = { writes: storePuts.length, logoffs: B ? B.BotManager.stats().logoffs - logoffs0 : 0, ticks: t1 - t0, perWorldMinute: +((storePuts.length * 100) / Math.max(1, t1 - t0)).toFixed(2), bytes: storePuts.reduce((n, p) => n + p.bytes.length, 0) };
    const save = await page.sendLifecycle('save', 60000 * ctx.slow);
    const puts = env.storage.puts.slice(mark);
    return {
        bots: N,
        bundle: page.booted.bundle,
        bootedMs: { preload: Math.round(page.booted.preloadMs), eval: Math.round(page.booted.evalMs) },
        startMs: Math.round(page.ready.ms),
        heapMB: { afterStart: heapAfterStart, afterRun: heapAfterRun },
        spawned: B ? B.BotManager.stats().spawned : 0,
        rampTicks: t0 - ramp0,
        ramp: windowStats(H.ticker.tickStats.durations, ramp0, t0),
        tick: windowStats(H.ticker.tickStats.durations, t0, t1),
        botTick: B ? windowStats(B.botTickStats.durations, b0, b1) : null,
        pathSearches: B ? searchStats(B, b0, b1) : null,
        rateMs: rate,
        save: { ok: save.ok, ms: Math.round(save.ms), puts: puts.length, bytes: puts.reduce((n, p) => n + p.bytes.length, 0) },
        store,
        errors: page.logs.filter(l => l.level === 'error').length,
        firstErrors: page.logs.filter(l => l.level === 'error').slice(0, 3).map(l => l.text.split('\n')[0].slice(0, 200))
    };
}
