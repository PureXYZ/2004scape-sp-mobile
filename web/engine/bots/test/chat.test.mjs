#!/usr/bin/env node
// What the bots hear, in the real 274 world (test/lib/simworld.ts, 16 bots, a human in Lumbridge), through
// port/BotChat as the runtime's hooks call it:
//   market    only a clear request is one: "buying"/"selling"/"wtb"/"wts" and an item, or "buy"/"sell" and nothing but
//             an item's name ("I need help", "buy me a drink" are chat); the item is a real object's whole name, 2004's
//             slang spelled out ("lobs", "anyone selling lobs"), the vendors' own nicknames ("buying glory", "wtb str pots":
//             the realism work, phase 4, at their street prices); a vendor that has it answers in character (the realism
//             work: its private message with its price and where it is, or its line when it is near the human), never
//             a game message nor a hint arrow; a line naming a bot still reaches the bots' chat; on a free world no
//             vendor offers a members item;
//   talk      once addressed, a bot answers that player for 30 s only what it understands (no "Can you say that
//             another way?"), and not a line that names another bot;
//   come here a bot that is not a PKer does not come into the Wilderness (a private "Not going in there!") and stops
//             following a player who walks in; a PKer comes;
//   own state "what are you doing", "whats ur cb" and "where r u" get the bot's own answer (its task's activity and
//             place, its combat level, where it stands); emotes come with the lines (a dance when asked, a laugh at a
//             joke, a wave with a goodbye or a greeting, a cheer at its 99), none while it is busy, and a fire it
//             lit (a script the engine leaves behind) does not keep it busy once it is out;
//   realism   (phase 2, the conversation) a reply takes the bot's typing time: not before it could have typed it (its
//             persona's speed), within 26 ticks, the conversation's 30 s from when it is said; the human's name in about
//             one reply in five; a named line nothing understands gets "?" or "wat" now and then, else nothing; the new
//             intents answered from the bot's state (asl, prices, directions, quests, "u there?", follow me: a short
//             real Follow); a question said to nobody gets at most 2 bots' answers (one, and now and then a second);
//             bots answer bots (a question, gz to a level-up and the leveller's ty) in chains of at most 3 lines, with
//             cooldowns; exchanges between two bots near the human; reactions to the human (a wave back, gz to its
//             level-up, "u following me?"), each rate-limited.
// Windows are typing-aware (the realism work): a reply comes after the bot read the line (a tick), thought and typed it
// (port/BotTiming.typingTicks: at most 20 ticks), so a check waits until the bots it expects have answered, at most
// TYPED ticks, and a check that nothing answers waits all of TYPED (the replies used to come 2-4 ticks after any line,
// and the windows were 8 ticks).
//
//   node web/engine/bots/test/chat.test.mjs [--seed=N] [--debug]
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import fs from 'fs';

const chatResponses = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/chat_responses.json'), 'utf8'));

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const DEBUG = args.debug === 'true';
{
    let s = Number(args.seed ?? 3) >>> 0 || 1;
    Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const errors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const real = console[level].bind(console);
    console[level] = (...a) => {
        const text = a.map(String).join(' ');
        if (level === 'error' && !text.includes('ExperimentalWarning')) errors.push(text);
        if (DEBUG) real(...a);
    };
}
const out = s => process.stdout.write(`${s}\n`);

const engineDir = prepareEngineClone('chat-p2p', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/chatworld.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotChat, Player, wildernessLevelAt, ObjType, MessagePrivate, InvType, fromBase37, BOT_CHAT_LINES } = lib;

// (no short breaks, lingers or looks here (port/BotHabits; habits.test has them): a bot frozen for a check while on a
// break would answer nobody)
lib.setHabitRatesForTest({ breaks: 0, lingers: 0, watch: 0 });
const sim = await lib.Sim.create({ bots: 16, members: true, debug: DEBUG });
sim.addHuman(3222, 3218, 0);
const human = sim.human;
// (no random event on the human either: one took it across the map in the middle of a check; the waits are typing-aware
// now, so the test runs long enough for 274's 5-minute rolls)
{
    const clientsIn = World.processClientsIn;
    World.processClientsIn = function () {
        clientsIn.call(this);
        human.afkEventReady = false;
    };
}
// (and none on the bots: a frozen bot near the human let a genie pass, and 274's fail teleport took it away mid-check)
lib.setEventRatesForTest?.({ odds: 0 });

/** the longest a reply takes: the bot reads the line (1-2 ticks), thinks and types it (port/BotTiming: at most 20), and a few ticks to spare */
const TYPED = 26;
/** a private message's answer: the bot notices it first (port/BotTiming 'notice': at most 8) */
const TYPED_PM = TYPED + 9;

// ---- what is said and what the human is sent ----
const says = [];
// (bots speak as typed lines, port/BotSay; its listeners hear each line as it is shown, its kind and whom it answers)
lib.sayListeners.push((player, text, kind, to) => says.push({ t: World.currentTick, who: player.username, text, kind: kind ?? null, to: to?.username ?? null }));
// each line as a typed one: the CHAT mask (0x40) with its packed text, never the SAY mask (0x08) that ignore cannot hide
let typed = 0;
const untyped = [];
lib.sayListeners.push((player, text) => {
    if ((player.masks & 0x40) !== 0 && player.chatMessage instanceof Uint8Array && player.chatMessage.length > 0 && (player.masks & 0x08) === 0) typed++;
    else untyped.push(`${player.username}: ${text}`);
});
const told = []; // game messages
const pms = []; // private messages to the human
const hints = [];
const messageGame = human.messageGame.bind(human);
human.messageGame = text => {
    told.push(text);
    return messageGame(text);
};
const write = human.write.bind(human);
human.write = message => {
    if (message instanceof MessagePrivate) pms.push({ t: World.currentTick, from: fromBase37(message.from), text: message.msg });
    return write(message);
};
const hintTile = human.hintTile.bind(human);
human.hintTile = (offset, x, z, height) => {
    hints.push([x, z]);
    return hintTile(offset, x, z, height);
};

const failures = [];
let checks = 0;
const check = (what, ok, detail = '') => {
    checks++;
    if (!ok) failures.push(`${what}${detail ? `: ${detail}` : ''}`);
    if (DEBUG) out(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};
const tick = (n = 1) => {
    for (let i = 0; i < n; i++) sim.tick();
};
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const bots = () => sim.bots();
const byPlanner = planner => bots().filter(p => p.botPlanner === planner);
/**
 * The bot's AI stops (it stays in the world) and it drops its route and what it was doing (a tree it chopped goes on
 * giving logs and levels without its AI). A chat page it left open (the level-up box of a level it just gained) is
 * clicked away, as its tasks would (BotAction.botContinuePage): a frozen bot in a script does no emote (port/BotEmote),
 * and whether a level-up came just then is the world's dice.
 */
function freeze(bot) {
    sim.botPlayer(bot).tick = () => {};
    bot.clearWaypoints();
    bot.clearPendingAction();
    bot.clearInteraction();
    const page = bot.activeScript;
    if (page && page.execution === lib.ScriptState.PAUSEBUTTON) bot.executeScript(page, true, true);
}
function walkableNear(x, z, level, ok = () => true) {
    for (let r = 0; r <= 4; r++) {
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) === r && sim.isWalkable(x + dx, z + dz, level) && ok(x + dx, z + dz)) return [x + dx, z + dz];
            }
        }
    }
    throw new Error(`no walkable tile near ${x},${z}`);
}
/** every reply to the human seen in the checks: its bot, length and ticks after the human's line (the typing bounds) */
const replies = [];
/**
 * A human's public line, as the hook passes it on (sentence case; the filter leaves these alone); then the ticks until
 * every bot of `until` answered (a 'reply' line; at most `wait`), or all of `wait`.
 */
function chat(line, { wait = TYPED, until = null, pm = null } = {}) {
    const s0 = says.length;
    const t0 = told.length;
    const p0 = pms.length;
    const h0 = hints.length;
    const start = World.currentTick;
    BotChat.onPublicMessage(human, line);
    for (let i = 0; i < wait; i++) {
        tick();
        const said = says.slice(s0);
        if (until && until.every(b => said.some(s => s.who === b.username && s.kind === 'reply'))) break;
        if (pm && pms.slice(p0).some(p => p.from === pm.username)) break;
    }
    const said = says.slice(s0).filter(s => s.who !== human.username);
    // (the first reply of each bot the check waits for: another bot's line may answer an earlier one)
    for (const b of until ?? []) {
        const s = said.find(x => x.who === b.username && x.kind === 'reply' && x.to === human.username);
        if (s) replies.push({ who: s.who, len: s.text.length, ticks: s.t - start, text: s.text });
    }
    return {
        said,
        told: told.slice(t0),
        pms: pms.slice(p0),
        hints: hints.slice(h0)
    };
}
const show = r => JSON.stringify({ said: r.said.map(s => `${s.who}: ${s.text}`), told: r.told, pms: r.pms.map(p => `${p.from}: ${p.text}`) });
const FILLERS = new Set(
    [
        "I don't quite understand, could you rephrase?",
        'Hmm? What do you mean?',
        'Not sure I follow :)',
        "You've lost me a bit there",
        "Eh? Didn't catch that",
        'Can you say that another way?',
        'You chatting or asking something? :D',
        'You just said that lol',
        'Haha yeah I heard you',
        'Alright I get it lol'
    ].map(s => s.toLowerCase())
);
const isFiller = text => [...FILLERS].some(f => text.toLowerCase().includes(f.replace(/ :\)$| :d$/, '')));
const withDice = (value, fn) => {
    const roll = lib.chatDice.roll;
    lib.chatDice.roll = () => value;
    try {
        return fn();
    } finally {
        lib.chatDice.roll = roll;
    }
};

// ---- the world: bots in, then a while doing their tasks ----
while (bots().length < 16 && World.currentTick < 40) tick();
tick(40);
check('16 bots in the world', bots().length === 16, `${bots().length}`);
// (the bots' talk of their own, exchanges between two bots near the human and reactions to it, waits for the realism
// checks below: a line of theirs is no answer to a check's line)
const tickTalk = BotChat.tickTalk;
BotChat.tickTalk = () => {};

// ======== market (the realism work: in character, no game message, no hint arrow) ========
{
    // (16 bots: one or two vendors, the role mix's 7.5 %)
    const vendors = byPlanner('extras_vendor');
    check('a vendor bot', vendors.length >= 1, `${vendors.length}`);
    const [vendor, other] = vendors;
    for (const v of vendors) {
        freeze(v);
        v.getInventory(InvType.INV)?.removeAll();
        v.botVendorStockItemId = -1;
        v.botVendorStockName = '';
        v.botVendorPmCooldowns = {};
    }
    const lobster = ObjType.getId('lobster');
    vendor.botVendorStockItemId = lobster;
    vendor.botVendorStockName = ObjType.get(lobster).name;
    vendor.botVendorStockNoted = true;
    void other;
    const home = [vendor.x, vendor.z];
    check('market: the lobster vendor is out of earshot of the human (it answers by private message)', cheb(vendor, human) > 15, `${cheb(vendor, human)} tiles`);

    // ordinary chat is not a market request: no vendor answers (by private message or out loud), no game message
    const [told0, pms0, hints0] = [told.length, pms.length, hints.length];
    for (const line of ['I need help', 'Where can i sell these', 'Lf someone to quest with', 'Do you need a hand', 'I need it', 'Buy me a drink', 'Sell me a lobster', 'Selling my soul', 'Buying gf', 'Wts stuff cheap', 'Buying a', 'Sell', 'I am buying lobsters']) {
        BotChat.onPublicMessage(human, line);
        tick(2);
    }
    let r = chat('ok', { wait: TYPED_PM });
    const vendorPms = pms.slice(pms0).filter(p => vendors.some(v => v.username === p.from));
    check('market: ordinary chat is not a request (no vendor answer, no game message, no arrow)', vendorPms.length === 0 && told.length === told0 && hints.length === hints0, `${JSON.stringify(vendorPms)} ${JSON.stringify(told.slice(told0))}`);

    // a request for an item a vendor has: its private message in character (its price, where it stands), a few
    // seconds later; no game message, no hint arrow
    r = chat('Buying lobsters', { wait: TYPED_PM, pm: vendor });
    check('market: "Buying lobsters" gets the lobster vendor\'s private message (in character: its price and its bank)', r.pms.length === 1 && r.pms[0].from === vendor.username && /\blobsters\b/.test(r.pms[0].text) && /\d/.test(r.pms[0].text) && /bank|\bin |near /.test(r.pms[0].text), show(r));
    check('market: no game message and no hint arrow (upstream\'s "Marketplace: ... location marked." and its arrow)', r.told.length === 0 && r.hints.length === 0, show(r));
    r = chat('Wtb 100 noted lobster pls', { wait: TYPED_PM });
    check('market: asked again within 30 s: nothing more (no second message, no game message, no arrow)', r.pms.length === 0 && r.told.length === 0 && r.hints.length === 0, show(r));
    r = chat('Selling lobsters 150 ea', { wait: TYPED_PM, pm: vendor });
    check('market: "Selling lobsters 150 ea" gets the vendor who buys noted lobsters (it says it buys them)', r.pms.length === 1 && r.pms[0].from === vendor.username && /\bbuy/.test(r.pms[0].text), show(r));
    tick(60); // (its cooldowns are over)
    r = chat('anyone selling lobs', { wait: TYPED_PM, pm: vendor });
    check('market: "anyone selling lobs" (2004 slang) reaches the lobster vendor', r.pms.length === 1 && r.pms[0].from === vendor.username && /\blobs\b/.test(r.pms[0].text), show(r));
    // (the realism work, phase 4) the words the vendors' adverts use: "buying glory", "wtb str pots" (VendorTask's
    // nicknames), at the vendor's street price (an amulet of glory about 100k, strength potions about 1.5k)
    for (const [debugname, line, word, low, high] of [['amulet_of_glory', 'buying glory', 'glory', 88000, 112000], ['strength4', 'wtb str pots', 'str pots', 1300, 1700]]) {
        tick(60);
        const id = ObjType.getId(debugname);
        vendor.botVendorStockItemId = ObjType.get(id).certlink;
        vendor.botVendorStockName = ObjType.get(id).name;
        vendor.botVendorStockNoted = true;
        vendor.botVendorPmCooldowns = {};
        r = chat(line, { wait: TYPED_PM, pm: vendor });
        const quoted = (r.pms[0]?.text ?? '').match(/(\d+(?:\.\d+)?)(k|m)?/);
        const amount = quoted ? Number(quoted[1]) * (quoted[2] === 'k' ? 1000 : quoted[2] === 'm' ? 1e6 : 1) : 0;
        check(`market: "${line}" (a vendor's nickname) reaches the vendor of ${ObjType.get(id).name}, at about its street price (${amount})`, r.pms.length === 1 && r.pms[0].from === vendor.username && r.pms[0].text.includes(word) && amount >= low && amount <= high, show(r));
    }
    // (the review of phase 4) a rare named without its colour ("anyone selling phat") reaches the vendor of any partyhat;
    // its answer has no "ea" (a rare is one)
    tick(60);
    const blue = ObjType.getId('blue_partyhat');
    vendor.botVendorStockItemId = blue;
    vendor.botVendorStockName = ObjType.get(blue).name;
    vendor.botVendorStockNoted = false;
    vendor.botVendorPmCooldowns = {};
    r = chat('anyone selling phat', { wait: TYPED_PM, pm: vendor });
    check('market: "anyone selling phat" (no colour) reaches the vendor of a blue partyhat, its price without "ea"', r.pms.length === 1 && r.pms[0].from === vendor.username && /\bphat\b/.test(r.pms[0].text) && /\d+(\.\d)?m\b/.test(r.pms[0].text) && !/\b(ea|each|some)\b/.test(r.pms[0].text), show(r));
    tick(60);
    vendor.botVendorStockItemId = lobster;
    vendor.botVendorStockName = ObjType.get(lobster).name;
    vendor.botVendorStockNoted = true;
    vendor.botVendorPmCooldowns = {};

    // a real item no vendor has: no game message, no arrow, no vendor; now and then a bot near says nobody sells it
    for (const line of ['Buy coal', 'Buying yew logs and maple logs', 'Wts 2 rune scimitars 30k']) {
        r = chat(line, { wait: TYPED_PM });
        const fromVendors = r.pms.filter(p => vendors.some(v => v.username === p.from));
        check(`market: "${line}": no vendor has it: no game message, arrow or vendor message`, r.told.length === 0 && r.hints.length === 0 && fromVendors.length === 0 && r.said.filter(s => s.kind === 'reply').every(s => BOT_CHAT_LINES.nobodySells.some(n => s.text.startsWith(n))), show(r));
    }

    // a vendor near the human answers out loud
    vendor.teleJump(...walkableNear(human.x + 3, human.z, human.level), human.level);
    tick(60);
    r = chat('buying lobsters', { wait: TYPED, until: [vendor] });
    check('market: a vendor near the human answers out loud, not by private message', r.said.some(s => s.who === vendor.username && s.kind === 'reply' && /\d/.test(s.text)) && r.pms.length === 0, show(r));
    vendor.teleJump(home[0], home[1], 0);
    tick(60);

    // a market line that names a bot: the bot answers too
    const skiller = byPlanner('skiller')[0];
    freeze(skiller);
    skiller.teleJump(...walkableNear(human.x + 1, human.z, human.level), human.level);
    tick(2);
    r = chat(`${skiller.displayName} do you need anything`, { until: [skiller] });
    check(`market: "${skiller.displayName} do you need anything": no vendor message (the bot may answer)`, r.told.length === 0 && r.pms.length === 0, show(r));
    tick(60); // its conversation ends
    r = chat(`Buying coal ${skiller.displayName}`, { until: [skiller] });
    check(`market: "Buying coal ${skiller.displayName}": no game message, and the bot answers`, r.told.length === 0 && r.said.some(s => s.who === skiller.username), show(r));
    tick(60);
}

// ======== talk ========
{
    const a = byPlanner('fighter')[0];
    const b = byPlanner('balanced')[0];
    for (const bot of [a, b]) freeze(bot);
    const [ax, az] = walkableNear(human.x + 1, human.z + 1, human.level);
    a.teleJump(ax, az, human.level);
    const [bx, bz] = walkableNear(human.x - 1, human.z - 1, human.level);
    b.teleJump(bx, bz, human.level);
    tick(2);
    const said = r => ({ a: r.said.filter(s => s.who === a.username).map(s => s.text), b: r.said.filter(s => s.who === b.username).map(s => s.text) });
    const fillers = [];
    // (a frozen bot's script may still move it: a crossing or a ladder it was on, seed 59; back beside the human)
    const keepNear = () => {
        if (cheb(a, human) > 3) a.teleJump(ax, az, human.level);
        if (cheb(b, human) > 3) b.teleJump(bx, bz, human.level);
    };
    const talk = (line, opts) => {
        keepNear();
        const r = said(chat(line, opts));
        for (const text of [...r.a, ...r.b]) if (isFiller(text)) fillers.push(`${line} -> ${text}`);
        return r;
    };
    // (the dice say no to a "?" for a line nothing understands, here: see "realism" below)
    let r = withDice(1, () => talk(`Hi ${a.displayName}`));
    check(`talk: "Hi ${a.displayName}": it answers, the other bot does not`, r.a.length === 1 && r.b.length === 0, JSON.stringify(r));
    r = withDice(1, () => talk(`Hi ${b.displayName}`));
    check(`talk: "Hi ${b.displayName}": it answers; ${a.displayName}, still in its conversation, leaves the line to it`, r.b.length === 1 && r.a.length === 0, JSON.stringify(r));
    // three lines no intent understands, one after another: neither bot answers (all of TYPED for any late answer)
    const s0 = says.length;
    for (const line of ['What a nice day', 'Brb going to the bank', 'Ok i am back']) {
        BotChat.onPublicMessage(human, line);
        tick(2);
    }
    tick(TYPED);
    const late = says.slice(s0).filter(s => s.who === a.username || s.who === b.username);
    check('talk: "What a nice day", "Brb going to the bank", "Ok i am back" (no intent): neither bot answers', late.length === 0, JSON.stringify(late));
    // both greeted again (a new conversation each), then a line for both
    withDice(1, () => talk(`Hi ${a.displayName}`, { until: [a] }));
    withDice(1, () => talk(`Hi ${b.displayName}`, { until: [b] }));
    r = talk('How are you', { until: [a, b] });
    check('talk: "How are you" within 30 s: both bots in the conversation answer', r.a.length === 1 && r.b.length === 1, JSON.stringify(r));
    r = talk(`${a.displayName} what are you doing`, { until: [a] });
    check(`talk: "${a.displayName} what are you doing": only it answers`, r.a.length === 1 && r.b.length === 0, JSON.stringify(r));
    // whole words and 2004 shorthand ("hi" is in "this" and "fishing": upstream answered such a line with a greeting
    // alone), the bot's name taken out first
    r = talk(`${a.displayName} whats ur fishing lvl`, { until: [a] });
    check(`talk: "${a.displayName} whats ur fishing lvl": the answer has its Fishing level`, r.a.length === 1 && new RegExp(`\\b${a.baseLevels[10]}\\b`).test(r.a[0]), JSON.stringify(r));
    const greetings = new Set([...(chatResponses.greetingReplies ?? []), ...(chatResponses.greetingBack ?? [])].map(g => (typeof g === 'string' ? g : g.text).replace('{name}', human.displayName).toLowerCase()));
    r = talk(`${a.displayName} r u a bot`, { until: [a] });
    check(`talk: "${a.displayName} r u a bot": an answer, not a greeting alone`, r.a.length === 1 && !greetings.has(r.a[0].toLowerCase()), JSON.stringify(r));
    check('talk: no filler reply ("Can you say that another way?")', fillers.length === 0, fillers.join('; '));
    tick(60);
    r = talk('How are you');
    check('talk: 30 s later the conversation is over', r.a.length === 0 && r.b.length === 0, JSON.stringify(r));
}

// ======== chat: names typed other ways, first names, the reply window, gz, hi, private messages ========
{
    // every bot quiet for this part (none says a line of its own that a check would take for an answer), and back after
    const ticks = new Map(bots().map(p => [p, sim.botPlayer(p).tick]));
    for (const p of bots()) sim.botPlayer(p).tick = () => {};
    const used = new Set([byPlanner('random')[0], byPlanner('extras_pker')[0], byPlanner('skiller')[1], byPlanner('skiller')[0]]);
    const others = bots().filter(p => !used.has(p) && p.botPlanner !== 'extras_vendor' && p.botPlanner !== 'extras_pker' && p.botPlanner !== 'extras_edgeville_pker');
    const near = (bot, dx) => {
        bot.clearWaypoints();
        bot.clearPendingAction();
        bot.teleJump(...walkableNear(human.x + dx, human.z + 1, human.level), human.level);
    };
    const saidBy = (r, bot) => r.said.filter(s => s.who === bot.username && s.kind === 'reply').map(s => s.text);
    tick(60);

    // the name without its spaces
    const spaced = others.find(p => p.displayName.includes(' '));
    if (spaced) {
        near(spaced, 2);
        tick(2);
        const typed = spaced.displayName.replace(/ /g, '').toLowerCase();
        const r = chat(`hey ${typed}`, { until: [spaced] });
        check(`names: "hey ${typed}" reaches ${spaced.displayName}`, saidBy(r, spaced).length === 1, show(r));
        tick(60);
    }
    // a first name nobody else in earshot has; and a first word of an item name is no first name
    const named = others.find(p => lib.firstNameOf(p) !== null && p !== spaced);
    if (named) {
        near(named, -2);
        tick(2);
        const first = lib.firstNameOf(named);
        const r = chat(`hey ${first}`, { until: [named] });
        check(`names: "hey ${first}" reaches ${named.displayName}`, saidBy(r, named).length === 1, show(r));
        tick(60);
    }
    const itemNamed = bots().find(p => /^(iron|rune|lobster|yew|black|dragon|steel) /i.test(p.displayName));
    if (itemNamed) check(`names: "${itemNamed.displayName.split(' ')[0]}" (an item's first word) is not ${itemNamed.displayName}'s first name`, lib.firstNameOf(itemNamed) === null);

    // the reply window: after a bot spoke to the human first, the human's greeting reaches it without its name; a line
    // it does not understand does not; a line it said to nobody opens no window
    const w = others.find(p => p !== spaced && p !== named) ?? others[0];
    near(w, 1);
    tick(2);
    sim.botPlayer(w)._say('how long u been playing?', 'idle', human);
    let r = withDice(1, () => chat('hey', { until: [w] }));
    check(`reply window: "hey" just after ${w.displayName} spoke to the human gets its answer`, saidBy(r, w).length === 1, show(r));
    tick(60);
    sim.botPlayer(w)._say('how long u been playing?', 'idle', human);
    r = withDice(1, () => chat('brb going to the bank'));
    check('reply window: a line it does not understand gets nothing', r.said.length === 0, show(r));
    tick(60);
    sim.botPlayer(w)._say('good xp here', 'idle');
    r = withDice(1, () => chat('hey'));
    check('reply window: a line said to nobody opens none', r.said.length === 0, show(r));
    tick(60);
    // "gz" after a level-up line: "ty"
    sim.botPlayer(w)._say('level up! - fishing 20', 'levelup');
    r = withDice(0, () => chat('gz', { until: [w] }));
    check(`gz: "gz" after ${w.displayName}'s level-up line gets a thanks`, saidBy(r, w).length === 1 && BOT_CHAT_LINES.tyAnswers.includes(saidBy(r, w)[0]), show(r));
    tick(60);
    // a question that starts with "nice", in a conversation, just after its level-up line, is a question (the
    // research's probe: "nice, what lvl are you" got "ty!")
    withDice(1, () => chat(`hey ${w.displayName}`, { until: [w] }));
    sim.botPlayer(w)._say('level up! - fishing 21', 'levelup');
    r = withDice(1, () => chat('nice, what lvl are you', { until: [w] }));
    check(`gz: "nice, what lvl are you" just after its level-up line gets its combat level, not a thanks`, saidBy(r, w).length === 1 && new RegExp(`\\b${w.combatLevel}\\b`).test(saidBy(r, w)[0]) && !BOT_CHAT_LINES.tyAnswers.includes(saidBy(r, w)[0]), show(r));
    tick(60);
    // "hi" for nobody: now and then one bot says hi back, and not again for 2 minutes (a bot in earshot that has not
    // just talked with the human: those above keep out of a new chat for a while)
    const bystander = others.find(p => p !== w && p !== spaced && p !== named);
    if (bystander) {
        near(bystander, -1);
        tick(2);
    }
    r = withDice(0, () => chat('hi'));
    check('hi: "hi" meant for nobody gets one bot\'s hi back (now and then)', r.said.length === 1 && BOT_CHAT_LINES.hiAnswers.some(h => r.said[0].text.toLowerCase().startsWith(h)), show(r));
    r = withDice(0, () => chat('hi'));
    check('hi: not again straight away', r.said.length === 0, show(r));
    tick(60);

    // private messages: answered a few seconds later (the bot notices, then types), not consumed (the game sends them
    // on as before)
    const pmBot = w;
    let p0 = pms.length;
    const sent = World.currentTick;
    const consumed = BotChat.onPrivateMessage(human, pmBot.username, 'hi how are you');
    tick(TYPED_PM);
    let answer = pms.slice(p0);
    check(`private: "hi how are you" to ${pmBot.displayName} gets an answer in a private message`, !consumed && answer.length >= 1 && answer.every(p => p.from === pmBot.username), JSON.stringify(answer));
    check('private: typed: not in the same few ticks (it notices, then types)', answer.length >= 1 && answer[0].t - sent >= 3, JSON.stringify(answer.map(p => p.t - sent)));
    p0 = pms.length;
    BotChat.onPrivateMessage(human, pmBot.username, 'what are you doing');
    tick(TYPED_PM);
    answer = pms.slice(p0);
    check('private: the conversation goes on ("what are you doing")', answer.length >= 1, JSON.stringify(answer));
    // a friend bot now and then messages first; not to a human whose private chat is off
    p0 = pms.length;
    lib.sendFriendOpener(human, pmBot);
    answer = pms.slice(p0);
    // (revised in the variety work, round 1, S9: the opener is about what the friend is doing, or a level it just got, else
    // one of the openers)
    const opener = text => BOT_CHAT_LINES.friendOpeners.includes(text) || [...BOT_CHAT_LINES.friendDoing, ...BOT_CHAT_LINES.friendLevel].some(t => new RegExp(`^${t.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(doing|n|skill)\}/g, '.+')}$`).test(text));
    check('private: a friend bot\'s opener arrives (about what it is doing, now and then)', answer.length === 1 && answer[0].from === pmBot.username && opener(answer[0].text), JSON.stringify(answer));
    human.privateChat = 2; // off
    check('private: no opener to a human whose private chat is off', lib.pickOpener(() => true) === null);
    human.privateChat = 0;
    tick(60);
    for (const [p, t] of ticks) sim.botPlayer(p).tick = t;
}

// ======== the realism work, phase 2: the conversation ========
BotChat.tickTalk = tickTalk;
{
    // every bot quiet again (no line of its own), around the human
    const ticks = new Map(bots().map(p => [p, sim.botPlayer(p).tick]));
    for (const p of bots()) freeze(p);
    const pool = bots().filter(p => !['extras_vendor', 'extras_pker', 'extras_edgeville_pker'].includes(p.botPlanner));
    const place = (bot, dx, dz) => bot.teleJump(...walkableNear(human.x + dx, human.z + dz, human.level), human.level);
    // (out of earshot and out of a practice's 30 tiles: west of the castle)
    const far = bot => bot.teleJump(...walkableNear(3140 + (bots().indexOf(bot) % 8) * 3, 3240 - Math.floor(bots().indexOf(bot) / 8) * 4, 0), 0);
    for (const p of bots()) far(p);
    tick(70);

    // ---- typing: every reply above came no sooner than its bot could type it, and within TYPED ----
    {
        const tooFast = replies.filter(rep => {
            const persona = lib.personaOf(rep.who);
            return rep.ticks < 3 || (rep.len < 40 && rep.len / (rep.ticks * 0.6) > persona.typingCps * 1.25);
        });
        const tooSlow = replies.filter(rep => rep.ticks > TYPED);
        check('realism: replies take the bot\'s typing time (at least 3 ticks, no faster than its persona types)', replies.length >= 10 && tooFast.length === 0, `${replies.length} replies; too fast: ${JSON.stringify(tooFast.slice(0, 3))}`);
        check(`realism: replies come within ${TYPED} ticks`, tooSlow.length === 0, JSON.stringify(tooSlow.slice(0, 3)));
        const speeds = replies.map(rep => rep.len / (rep.ticks * 0.6)).sort((x, y) => x - y);
        check('realism: the median reply is typed at at most 6 characters a second (2004: about 3-6)', speeds[Math.floor(speeds.length / 2)] <= 6, `median ${speeds[Math.floor(speeds.length / 2)]?.toFixed(1)}`);
    }

    // ---- the human's name in about one reply in five (composeReply, by persona) ----
    {
        let named = 0;
        let total = 0;
        for (const bot of bots()) {
            for (let i = 0; i < 40; i++) {
                for (const intent of [{ id: 'greeting', text: 'hey' }, { id: 'thanks', text: 'No worries {name}' }, { id: 'skill', text: '45 u?' }]) {
                    const text = lib.composeReply({ bot, to: human, heard: 'x', channel: 'public', via: 'named', greeted: intent.id === 'greeting', intent });
                    total++;
                    if (text && text.toLowerCase().includes(human.displayName.toLowerCase())) named++;
                }
            }
        }
        const share = named / total;
        check('realism: composeReply names the human in about one reply in five (at most 25 %, some)', share > 0.03 && share <= 0.25, `${(100 * share).toFixed(1)} % of ${total}`);
        const thanks = lib.composeReply({ bot: bots()[0], to: human, heard: 'x', channel: 'public', via: 'named', greeted: false, intent: { id: 'thanks', text: 'Thanks, {name}' } });
        check('realism: a reply without the name reads whole ("Thanks, {name}" → "Thanks")', thanks === 'Thanks' || thanks === `Thanks, ${human.displayName}` || /^Thanks( |$)/.test(thanks), thanks);
    }

    // ---- a named line nothing understands: "?" or "wat" now and then, else nothing ----
    {
        const c = pool[0];
        place(c, 1, 0);
        tick(2);
        let r = withDice(0, () => chat(`${c.displayName} blorp the flarg`, { until: [c] }));
        const said = r.said.filter(s => s.who === c.username && s.kind === 'reply').map(s => s.text);
        check('realism: a named line nothing understands gets "?", "huh" or "wat" (the dice say yes)', said.length === 1 && BOT_CHAT_LINES.confused.includes(said[0]), show(r));
        tick(60);
        r = withDice(1, () => chat(`${c.displayName} blorp the flarg`));
        check('realism: ... and nothing when the dice say no', r.said.filter(s => s.who === c.username && s.kind === 'reply').length === 0, show(r));
        tick(60);
        // the new intents, answered from its state
        const ask = (line, test, what) => {
            const res = withDice(1, () => chat(`${c.displayName} ${line}`, { until: [c] }));
            const text = res.said.find(s => s.who === c.username && s.kind === 'reply')?.text ?? '';
            check(`realism: "${line}" gets ${what}`, test(text), `${JSON.stringify(text)} (${c.displayName} at ${c.x},${c.z},${c.level} human ${human.x},${human.z},${human.level} slot ${c.slot}; said ${JSON.stringify(res.said.map(s => `${s.who} ${s.kind}: ${s.text}`))})`);
            tick(55);
        };
        const DIRS = /\b(north|south|east|west)\b|right there|ur in it|ur here|this is|toll/;
        ask('asl', t => /^\d+ [mf] /.test(t) || ['no', 'why', 'lol no', 'not telling', 'y'].includes(t), 'its age, body and home ("14 m usa")');
        ask('how much is a rune scim', t => /\d/.test(t), 'a price (port/BotPrices)');
        ask('where is the bank', t => /bank|north|south|east|west|right there/.test(t), 'the way to the nearest bank');
        ask('how do i get to varrock', t => DIRS.test(t), 'the way to Varrock');
        ask('what quest should i do', t => /assistant|shearer|ghost|mysteries|romeo|imp|potion|doric|goblin|ernest|pirate|prince|sword|vampire|arrav|demon|fortress|slayer|ritual|waterfall|gnome|arena|lost city|heroes|fremennik|horror|legends/.test(t), 'a quest for the human\'s level');
        ask('u there?', t => [...lib.ANSWER_LINES.presence, ...lib.ANSWER_LINES.presenceDoing.map(p => p.split('{doing}')[0])].some(p => t.startsWith(p)), 'a "ya im here" (now and then with what it does)');
        ask('where can i mine iron', t => /\b(in|near|at|on)\b|north|south|east|west/.test(t), 'a mine near it');
        ask('how long have u played', t => lib.ANSWER_LINES.playtime.some(p => t.startsWith(p)), 'its time played');
        far(c);
    }

    // ---- follow me: a sociable bot that is free (a social bot, or one standing about) follows a little way (a real
    // Follow); others say so ----
    {
        const sociable = p => lib.personaOf(p.username, p.botPlanner).sociability >= 0.5 && lib.personaOf(p.username, p.botPlanner).friendliness >= 0;
        const social = pool.find(p => p.botPlanner === 'extras_social' && sociable(p)) ?? pool.find(sociable);
        if (social) {
            const bp = sim.botPlayer(social);
            bp.tick = ticks.get(social); // (its AI: the follow is a sub-task)
            // (standing about: no task, not in a social bot's tour or its reward trade with the human; no plan of its own
            // meanwhile: since phase 5b a free bot's next pick may be a Duel Arena visit, which a follow does not end)
            bp.currentTask = null;
            bp.planner.pickTask = () => null;
            social.botTradeTargetPid = -1;
            place(social, 2, 0);
            tick(2);
            const r = withDice(1, () => chat(`${social.displayName} follow me`, { until: [social] }));
            const said = r.said.find(s => s.who === social.username && s.kind === 'reply')?.text ?? '';
            let following = false;
            for (let i = 0; i < 10 && !following; i++) {
                tick();
                following = social.target === human && [lib.ServerTriggerType.APPLAYER3, lib.ServerTriggerType.OPPLAYER3].includes(social.targetOp);
            }
            check(`realism: "${social.displayName} follow me": it says so and follows (the game's Follow)`, lib.ANSWER_LINES.followYes.some(f => said === f || said.startsWith(`${f} `)) && following, `said ${JSON.stringify(said)}, target ${social.target?.username ?? null} op ${social.targetOp}, sub-task ${sim.botPlayer(social).subTask?.name ?? null}, trade ${social.botTradeTargetPid}, at ${social.x},${social.z} (human ${human.x},${human.z})`);
            freeze(social);
            far(social);
            tick(60);
        } else {
            out('note: no sociable bot among the 16: the follow check is skipped');
        }
    }

    // ---- a question said to nobody: at most 2 bots answer (one, and now and then a second) ----
    {
        const crowd = pool.slice(1, 6);
        crowd.forEach((bot, i) => place(bot, -2 + i, 2));
        tick(60);
        const s0 = says.length;
        withDice(0, () => {
            BotChat.onPublicMessage(human, 'where is the bank');
            tick(TYPED * 2);
        });
        const answers = says.slice(s0).filter(s => s.kind === 'reply' && s.to === human.username);
        const responders = new Set(answers.map(s => s.who));
        check('realism: "where is the bank" said to nobody: one bot answers, and a second at most (floor control)', responders.size >= 1 && responders.size <= 2 && answers.length <= 2, JSON.stringify(answers.map(s => `${s.who}: ${s.text}`)));
        check('realism: ... the first answer is the way to a bank', answers.length > 0 && /bank|north|south|east|west|right there/.test(answers[0].text), JSON.stringify(answers[0]?.text));
        tick(60);
        const s1 = says.length;
        withDice(1, () => {
            BotChat.onPublicMessage(human, 'how do i get to varrock');
            tick(TYPED);
        });
        check('realism: ... and none when the dice say no', says.slice(s1).filter(s => s.kind === 'reply').length === 0, JSON.stringify(says.slice(s1)));
        tick(60);

        // ---- bots answer bots: a question answered by one bot, the asker's "ty", then nothing: at most 3 lines ----
        const [asker] = crowd;
        const s2 = says.length;
        withDice(0, () => {
            lib.botSay(asker, 'where can i mine iron?', undefined, 'idle');
            BotChat.onBotLine(asker, 'where can i mine iron?', 'idle');
            // (a second question at once, in the same area: its cooldown)
            lib.botSay(asker, 'where can i mine coal?', undefined, 'idle');
            BotChat.onBotLine(asker, 'where can i mine coal?', 'idle');
            tick(80);
        });
        const chain = says.slice(s2).filter(s => s.kind === 'botreply');
        check('realism: a bot\'s question to anyone: another bot answers it (to the asker), the asker now and then thanks; at most 3 lines', chain.length >= 1 && chain.length <= 3 && chain[0].to === asker.username && chain[0].who !== asker.username, JSON.stringify(chain.map(s => `${s.who} -> ${s.to}: ${s.text}`)));
        check('realism: ... and a second question at once in that area gets nothing (a cooldown per area): one answer only', chain.filter(s => s.to === asker.username).length === 1, JSON.stringify(chain.map(s => `${s.who} -> ${s.to}: ${s.text}`)));
        tick(200);
        // a level-up line: 0-2 bots say gz to it, and the leveller now and then thanks one: at most 3 lines
        // (revised in the variety work, round 2, Track S2: now and then the first gz's sayer asks on, "how long did that
        // take", and the leveller answers: at most 5 lines, the 2 more the question and its answer, port/BotThreads
        // levelUpMore; the dice at 0 say yes to it)
        const s4 = says.length;
        withDice(0, () => {
            lib.botSay(asker, '40 wc!!', undefined, 'levelup');
            BotChat.onBotLine(asker, '40 wc!!', 'levelup');
            tick(60);
        });
        const gz = says.slice(s4).filter(s => s.kind === 'botreply');
        const gzLines = gz.filter(s => s.to === asker.username && BOT_CHAT_LINES.botGz.includes(s.text));
        check('realism: a level-up line near other bots gets 1-2 gz (the dice say yes), the leveller\'s ty, now and then a question on and its answer: at most 5 lines', gzLines.length >= 1 && gzLines.length <= 2 && gz.length <= 5, JSON.stringify(gz.map(s => `${s.who} -> ${s.to}: ${s.text}`)));
        for (const bot of crowd) far(bot);
        tick(60);
    }

    // ---- reactions to the human: a wave back, gz to its level-up, "u following me?" (each rate-limited; a bot reacts
    // at most every 10 minutes, so each check has bots of its own, 4-5 tiles off: not standing next to the human) ----
    if (pool.length < 11) out(`note: only ${pool.length} bots for the reaction checks: skipped`);
    else {
        const [b1, b2, b3, b4, b5] = pool.slice(6, 11);
        place(b1, 4, 0);
        place(b2, -4, 0);
        tick(60);
        const anims = [];
        const play = Player.prototype.playAnimation;
        Player.prototype.playAnimation = function (anim, delay) {
            if (this.is_bot) anims.push(`${this.username}:${lib.SeqType.get(anim)?.debugname ?? anim}`);
            return play.call(this, anim, delay);
        };
        try {
            const wave = lib.SeqType.getId('emote_wave');
            withDice(0, () => {
                human.playAnimation(wave, 0);
                tick(12);
                human.playAnimation(wave, 0);
                tick(12);
            });
            const waves = anims.filter(a => a.endsWith('emote_wave'));
            check('realism: the human waves (twice in 12 ticks): one bot waves back, once', waves.length === 1, JSON.stringify(anims));
        } finally {
            Player.prototype.playAnimation = play;
        }
        for (const bot of [b1, b2]) far(bot);
        place(b3, 5, 1);
        place(b4, -5, 1);
        tick(60);
        // its level-up (fireworks): 0-2 bots near say gz, once in a while however fast it levels
        const s0 = says.length;
        withDice(0, () => {
            human.baseLevels[8] += 1;
            tick(15);
            human.baseLevels[8] += 1;
            tick(TYPED);
        });
        const gz = says.slice(s0).filter(s => s.kind === 'reaction' && s.to === human.username);
        check('realism: the human levels up (twice in 15 ticks): 1-2 bots near say gz, once (rate-limited)', gz.length >= 1 && gz.length <= 2, JSON.stringify(gz.map(s => `${s.who}: ${s.text}`)));
        human.baseLevels[8] -= 2;
        for (const bot of [b3, b4]) far(bot);
        place(b5, 5, 0);
        tick(60);
        // it follows a bot for 20 s: "u following me?"
        const s1 = says.length;
        withDice(0, () => {
            human.setInteraction(lib.Interaction.ENGINE, b5, lib.ServerTriggerType.APPLAYER3);
            tick(35 + 9 + TYPED); // (20 s, then it notices and types)
        });
        human.clearInteraction();
        const asked = says.slice(s1).filter(s => s.who === b5.username && s.kind === 'reaction');
        check(`realism: the human follows ${b5.displayName} for 20 s: it asks why (once)`, asked.length === 1 && lib.REACTION_LINES.followed.some(f => asked[0].text === f || asked[0].text.startsWith(`${f} `)), JSON.stringify(asked));
        far(b5);
        tick(60);
    }

    // ---- exchanges between two bots near the human (port/BotStage): one at a time, 2-4 lines, each to the other ----
    {
        const pair = pool.filter(p => lib.personaOf(p.username, p.botPlanner).sociability >= 0.35).slice(0, 2);
        if (pair.length === 2) {
            // (in a square of its own, Varrock's: an exchange near the castle earlier keeps that area quiet a few minutes)
            const back = [human.x, human.z];
            sim.teleportHuman(3212, 3428, 0);
            place(pair[0], 3, 3);
            place(pair[1], 4, 3);
            tick(2);
            const s0 = says.length;
            withDice(0, () => tick(250));
            // (revised in the variety work, round 2, Track S2: other bots near may have a topic thread of their own meanwhile,
            // kind practice too, port/BotThreads: the staged pair's lines are the check)
            const names = new Set(pair.map(p => p.username));
            const lines = says.slice(s0).filter(s => s.kind === 'practice' && names.has(s.who));
            const byWho = new Set(lines.map(s => s.who));
            check('realism: two sociable bots near the human have a short exchange (2-4 lines, each to the other), one in a few minutes', lines.length >= 2 && lines.length <= 4 && byWho.size === 2 && lines.every(s => s.to !== null && s.to !== s.who && byWho.has(s.to)), JSON.stringify(lines.map(s => `${s.who} -> ${s.to}: ${s.text}`)));
            for (const bot of pair) far(bot);
            sim.teleportHuman(back[0], back[1], 0);
        } else {
            out('note: no two sociable bots for the practice check');
        }
        tick(60);
    }

    for (const [p, t] of ticks) sim.botPlayer(p).tick = t;
    tick(20);
}
BotChat.tickTalk = () => {};

// ======== come here ========
const nonPker = byPlanner('random')[0];
const pker = byPlanner('extras_pker')[0];
const EDGEVILLE = [3094, 3500];
{
    // the human in the Wilderness (level 2), a bot south of the ditch
    const bot = byPlanner('skiller')[1] ?? nonPker;
    const [bx, bz] = walkableNear(...EDGEVILLE, 0, (x, z) => wildernessLevelAt(x, z) === 0);
    bot.teleJump(bx, bz, 0);
    sim.teleportHuman(...walkableNear(3094, 3528, 0, (x, z) => wildernessLevelAt(x, z) >= 2), 0);
    tick(3);
    const p0 = pms.length;
    const consumed = BotChat.onPrivateMessage(human, bot.username, 'come here');
    let entered = null;
    for (let i = 0; i < 30; i++) {
        tick();
        if (wildernessLevelAt(bot.x, bot.z) > 0 && !entered) entered = `${bot.x},${bot.z}`;
    }
    const answer = pms.slice(p0);
    check(`come here: a ${bot.botPlanner} bot called into the Wilderness does not go (the message is consumed)`, consumed && entered === null, `consumed=${consumed}, in the Wilderness at ${entered}, now ${bot.x},${bot.z}`);
    check('come here: it says no in a private message', answer.length === 1 && answer[0].from === bot.username && BOT_CHAT_LINES.wildernessRefusals.includes(answer[0].text), JSON.stringify(answer));
}
{
    // a PKer comes (moved to Edgeville, far from its hunting zone, a deep-Wilderness one may be casting a teleport back
    // there when it is called: it comes instead)
    const [bx, bz] = walkableNear(...EDGEVILLE, 0, (x, z) => wildernessLevelAt(x, z) === 0);
    pker.teleJump(bx, bz, 0);
    tick(1);
    const consumed = BotChat.onPrivateMessage(human, pker.username, 'come here');
    let best = cheb(pker, human);
    for (let i = 0; i < 40 && best > 1; i++) {
        tick();
        best = Math.min(best, cheb(pker, human));
    }
    check('come here: a PKer called into the Wilderness comes', consumed && best <= 1, `consumed=${consumed}, closest ${best} (${pker.x},${pker.z}; human ${human.x},${human.z})`);

    // but not in the middle of a fight with a player: it answers that it is busy and fights on (upstream's "come here"
    // stopped a PKer mid-fight: a player who knew it killed it in a third of the time)
    human.setInteraction(lib.Interaction.ENGINE, pker, lib.ServerTriggerType.APPLAYER2);
    const p0 = pms.length;
    const consumed2 = BotChat.onPrivateMessage(human, pker.username, 'come here');
    tick(2);
    const answer = pms.slice(p0);
    check('come here: a PKer in a fight with a player answers that it is busy', consumed2 && answer.length === 1 && BOT_CHAT_LINES.fightingRefusals.includes(answer[0].text), JSON.stringify(answer));
    human.clearInteraction();
}
{
    // a bot called to the ditch's south side stops when the player walks into the Wilderness
    const bot = nonPker;
    const [hx, hz] = walkableNear(3094, 3512, 0, (x, z) => wildernessLevelAt(x, z) === 0);
    sim.teleportHuman(hx, hz, 0);
    const [bx, bz] = walkableNear(...EDGEVILLE, 0, (x, z) => wildernessLevelAt(x, z) === 0);
    bot.teleJump(bx, bz, 0);
    tick(3);
    const consumed = BotChat.onPrivateMessage(human, bot.username, 'come here');
    let best = cheb(bot, human);
    for (let i = 0; i < 30 && best > 1; i++) {
        tick();
        best = Math.min(best, cheb(bot, human));
    }
    check(`come here: a ${bot.botPlanner} bot called to Edgeville comes`, consumed && best <= 1, `consumed=${consumed}, closest ${best}`);
    const s0 = says.length;
    sim.teleportHuman(...walkableNear(hx, 3525, 0, (x, z) => wildernessLevelAt(x, z) >= 1), 0);
    let entered = null;
    for (let i = 0; i < 30; i++) {
        tick();
        if (wildernessLevelAt(bot.x, bot.z) > 0 && !entered) entered = `${bot.x},${bot.z}`;
    }
    const refusals = says.slice(s0).filter(s => s.who === bot.username && BOT_CHAT_LINES.wildernessRefusals.includes(s.text));
    check('come here: when the player walks into the Wilderness the bot stays out and says so', entered === null && refusals.length === 1, `in the Wilderness at ${entered}; said ${JSON.stringify(says.slice(s0).filter(s => s.who === bot.username).map(s => s.text))}`);
}

// ======== own state: answers from what the bot is and does, and emotes (port/BotActivity, port/BotPlaces, port/BotEmote) ========
{
    for (const [x, z, want] of [[3222, 3218, 'in Lumbridge'], [3212, 3428, 'in Varrock'], [3092, 3245, 'in Draynor'], [2920, 3170, 'on Karamja'], [3093, 3560, 'in the wild'], [3020, 9800, 'in the Dwarven Mine'], [2809, 3436, 'in Catherby'], [2200, 3000, null]]) {
        check(`own state: ${x},${z} is ${want === null ? 'no place' : `"${want}"`}`, lib.placePhrase(x, z) === want, String(lib.placePhrase(x, z)));
    }
    // (realism phase 5a, track F: a rude talker's answer to these may be a rude one, "y do u care", by design: a polite
    // talker's answers from its state are checked here, the rude ones in test/texture.test.mjs)
    const c = byPlanner('skiller').filter(p => lib.personaOf(p.username, p.botPlanner).friendliness >= -0.1).at(-1);
    freeze(c);
    sim.teleportHuman(3222, 3218, 0); // (back from the Wilderness, to Lumbridge)
    tick(2);
    c.teleJump(...walkableNear(human.x - 2, human.z, human.level), human.level);
    tick(2);
    // a woodcutter at the willows east of Draynor (its task, as the planner gives one)
    const willows = lib.SkillProgression.WOODCUTTING.find(s => s.itemGained === ObjType.getId('willow_logs') && s.location[0] === 3086 && s.location[1] === 3234);
    sim.botPlayer(c).currentTask = new lib.WoodcuttingTask(willows);
    const saidByC = r => r.said.filter(s => s.who === c.username).map(s => s.text);
    let r = chat(`${c.displayName} what are you doing`, { until: [c] });
    check(`own state: "what are you doing": what it does and where ("Cutting willows in Draynor")`, saidByC(r).length === 1 && saidByC(r)[0].includes('Cutting willows in Draynor'), show(r));
    r = chat(`${c.displayName} whats ur cb`, { until: [c] });
    check(`own state: "whats ur cb": its combat level (${c.combatLevel})`, saidByC(r).length === 1 && new RegExp(`\\b${c.combatLevel}\\b`).test(saidByC(r)[0]) && !/combat gets boring/i.test(saidByC(r)[0]), show(r));
    r = chat(`${c.displayName} where r u`, { until: [c] });
    check('own state: "where r u": where it is ("In Lumbridge")', saidByC(r).length === 1 && saidByC(r)[0].includes('In Lumbridge'), show(r));
    // emotes, the dice saying yes: the emote buttons of its controls tab, as a player presses them (frozen again: a
    // level-up box or a fight the game gave it since is cleared, as its tasks would)
    freeze(c);
    const anims = [];
    const play = c.playAnimation;
    c.playAnimation = function (anim, delay) {
        anims.push(lib.SeqType.get(anim)?.debugname ?? String(anim));
        return play.call(this, anim, delay);
    };
    const roll = lib.chatDice.roll;
    lib.chatDice.roll = () => 0;
    try {
        r = chat(`${c.displayName} can you dance`, { until: [c] });
        check('own state: "can you dance": an answer and a dance', saidByC(r).length === 1 && BOT_CHAT_LINES.dance.some(d => saidByC(r)[0].includes(d)) && anims.includes('emote_dance'), `${show(r)} ${JSON.stringify(anims)}`);
        anims.length = 0;
        r = chat('haha', { until: [c] });
        check('own state: a joke ("haha") gets a laugh', saidByC(r).length === 1 && anims.includes('emote_laugh'), `${show(r)} ${JSON.stringify(anims)}`);
        anims.length = 0;
        r = chat('bye', { until: [c] });
        check('own state: a goodbye gets a wave', saidByC(r).length === 1 && anims.includes('emote_wave'), `${show(r)} ${JSON.stringify(anims)}`);
        tick(60);
        anims.length = 0;
        r = chat(`hey ${c.displayName}`, { until: [c] });
        check('own state: a greeting gets a wave', saidByC(r).length === 1 && anims.includes('emote_wave'), `${show(r)} ${JSON.stringify(anims)}`);
        // not while it is busy (a script's delay, a trade, at a tree or a monster)
        anims.length = 0;
        c.delayed = true;
        c.delayedUntil = World.currentTick + 30;
        r = chat('bye', { until: [c] });
        check('own state: no emote while it is busy (here: a delay)', saidByC(r).length === 1 && anims.length === 0, `${show(r)} ${JSON.stringify(anims)}`);
        c.delayed = false;
        // its own milestone gets a cheer (99: always), a few ticks after the level-up (its AI on again for those)
        anims.length = 0;
        const bp = sim.botPlayer(c);
        delete bp.tick;
        bp.onLevelUp(lib.PlayerStat.WOODCUTTING, 99);
        tick(8);
        freeze(c);
        check('own state: 99 Woodcutting: a cheer', anims.includes('emote_cheer'), JSON.stringify(anims));
        // a fire it lit does not keep it busy once it is out: firemaking's script ends in the world queue (the ashes,
        // 100-200 ticks on), where the engine leaves it in activeScript for good (port: BotAction.botScript)
        const inv = c.getInventory(InvType.INV);
        const [tinderbox, logs] = [ObjType.getId('tinderbox'), ObjType.getId('logs')];
        inv.removeAll();
        inv.add(tinderbox, 1);
        inv.add(logs, 1);
        lib.interactHeldOpU(c, inv, logs, inv.getItemIndex(logs), tinderbox, inv.getItemIndex(tinderbox));
        for (let t = 0; t < 800 && c.activeScript?.execution !== lib.ScriptState.FINISHED; t++) tick();
        const left = c.activeScript ? `${c.activeScript.script?.name ?? '?'}/${c.activeScript.execution}` : 'none';
        anims.length = 0;
        tick(60); // (the goodbye above ended its conversation: it listens again 30 s on)
        r = chat(`hey ${c.displayName}`, { until: [c] });
        check('own state: a fire it lit and that burnt out does not keep it busy (the engine leaves its script: a wave)', c.activeScript?.execution === lib.ScriptState.FINISHED && lib.botScript(c) === null && anims.includes('emote_wave'), `script ${left} ${show(r)} ${JSON.stringify(anims)}`);
    } finally {
        lib.chatDice.roll = roll;
        c.playAnimation = play;
    }
}

// ======== market on a free world (last: the switch prunes the bots' skill steps for good) ========
{
    lib.applyWorldRules(false);
    const [vendor] = byPlanner('extras_vendor');
    const bow = ObjType.getId('magic_shortbow');
    vendor.botVendorStockItemId = bow;
    vendor.botVendorStockName = ObjType.get(bow).name;
    vendor.botVendorStockNoted = true;
    vendor.botVendorPmCooldowns = {};
    const r = chat('Buying magic shortbows', { wait: TYPED_PM });
    check('market on a free world: a vendor never offers a members item (and no marketplace game message)', r.pms.filter(p => p.from === vendor.username).length === 0 && !r.told.some(t => /vendor|marketplace/i.test(t)), show(r));
}

check('bots speak as typed lines (the CHAT mask, which ignore hides), never the SAY mask', typed > 0 && untyped.length === 0, `${typed} typed; ${untyped.slice(0, 3).join(' | ')}`);
// a bot's line is at most 80 characters, as a client's (port/BotSay says a longer one in parts)
const long = says.filter(s => s.text.length > 80);
check('no bot line over 80 characters', long.length === 0, long.slice(0, 3).map(s => s.text).join(' | ') + '\n');
check('no errors logged', errors.length === 0, errors.slice(0, 3).join(' | ') + '\n');
out(`chat: ${checks} checks in the 274 world with 16 bots (market requests, conversations, "come here" and the Wilderness, the realism work's conversation), ${World.currentTick} ticks, ${replies.length} replies timed`);
if (failures.length) {
    for (const f of failures) out(`FAIL ${f}`);
    out(`${failures.length} failure(s)`);
    process.exit(1);
}
out('ok');
