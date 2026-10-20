#!/usr/bin/env node
// Trading with the bots (port/BotTrade.ts, port/BotTradeScreen.ts): the real rev-274 world headless with the bot
// library, the compiled content overlay (bots/content, put in place by the runtime's own overlay.ts) and the runtime's
// two script commands. The human acts through the engine's own packet handlers, as slowly as a phone player taps: 10
// ticks (6 s) between steps. Checks:
//   - a trade request to a bot whose task does not trade: it declines in a word and keeps no trade target; it still
//     answers its whole name, "come here" still works, a second request declines again; a PKer declines too
//   - a vendor sale to a slow human completes, exactly: the bot's offer with the change, the human's coins, both
//     screens; an overpayment of one item's price or more is refused, with a message, until the human takes it back
//   - the vendor buys its noted stock at its price; a trade the human closes clears the bot's trade target; a human
//     who leaves the window open is told the bot declined, after SCREEN_TICKS
//   - a bankstand bot refuses while it has no stock; after banking (its bank window closed again) it offers only its
//     stock, never coins, tools, food or gear; 'all' is priced from what is in its offer, never at 0; "noted logs" is
//     not a "no"; a slow purchase completes; sold out, it refuses and banks again
//   - a social bot trades no more (the realism work, phase 3: no tour, no coin tips): it declines a request in a word
//   - BotManager's safety net drops a trade target that never moved on
//   - where vendors sell (port/BotTradeSpots): about half at Varrock West, its crowd a tile each, none on a stall or
//     beside one; a vendor given a crowd tile walks onto it and keeps to it while it sells
//   - free world (a child process: --members=false): a vendor never stocks a members item, and one made to sell one
//     never takes the coins
//   - (the realism work, phase 4: economy) vendor prices and adverts in each vendor's own forms pass the filter; in a
//     trade "how much?" gets the vendor's price, a lowball a "lol no" and its price a "k" (the trade unchanged); a rare
//     is one item, the item itself, at its 2004 price, and once sold the vendor stocks something else
//
//   node --expose-gc web/engine/bots/test/trade.test.mjs [--members=false] [--seed=N] [--debug]
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BOTS_DIR, CONTENT_DIR, ENGINE_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';
import { compileBotScripts } from '../content/compile.mjs';

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
    })
);
const MEMBERS = (args.members ?? 'true') !== 'false';
const DEBUG = args.debug === 'true';
const SLOW = 10; // ticks between the human's steps
const out = (s = '') => process.stdout.write(s + '\n');
const t0 = performance.now();

// ---- a deterministic Math.random ----
{
    let s = Number(args.seed ?? 7) >>> 0 || 1;
    Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- console: keep the errors, print only ours ----
const consoleErrors = [];
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const real = console[level].bind(console);
    console[level] = (...a) => {
        const text = a.map(x => (x instanceof Error ? (x.stack ?? String(x)) : String(x))).join(' ');
        if (level === 'error' && !text.includes('ExperimentalWarning')) consoleErrors.push(text);
        if (DEBUG) real(...a);
    };
}

const checks = [];
function check(name, ok, detail) {
    checks.push({ name: `${MEMBERS ? '' : 'free world: '}${name}`, ok: !!ok, detail: ok ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail) });
    return !!ok;
}

// ---- the world, the overlay, the commands ----
const overlay = await compileBotScripts({ engineDir: ENGINE_DIR, contentDir: CONTENT_DIR, log: () => {} });
const scriptsBin = new Uint8Array(fs.readFileSync(overlay.file));
const scriptDat = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.dat')));
const scriptIdx = new Uint8Array(fs.readFileSync(path.join(ENGINE_DIR, 'data/pack/server/script.idx')));
const engineDir = prepareEngineClone(`trade-${MEMBERS ? 'p2p' : 'f2p'}`, simWorldConfig({ members: MEMBERS }));
process.chdir(engineDir);
await stubWorkerThreads();
const T = await importTs(path.join(BOTS_DIR, 'test/lib/trade.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotChat, InvType, Items, TradeStatus } = T;
const sim = await T.Sim.create({ bots: 16, members: MEMBERS, debug: DEBUG, humanName: 'casey' });
const applied = T.installBotsContent(scriptsBin, scriptDat, scriptIdx);
check(`the runtime's overlay.ts put every script of scripts.bin in place (${overlay.scripts.length})`, applied === overlay.scripts.length && applied > 0, { applied });
sim.addHuman(3222, 3218, 0);
const human = sim.human;
// a sturdy human: the trade checks follow bots wherever they are (a level-3 human next to a bot at Draynor's dark
// wizards was killed mid-test)
for (let stat = 0; stat < human.baseLevels.length; stat++) if (stat !== 18 && stat !== 19) human.setLevel(stat, 99);
// the human stands about for minutes: no random event (a Mysterious box closes the trade window)
const processClientsIn = World.processClientsIn;
World.processClientsIn = function () {
    processClientsIn.call(this);
    human.afkEventReady = false;
};
const TRADEMAIN = T.Component.getId('trademain');
const TRADECONFIRM = T.Component.getId('tradeconfirm');
const COINS = Items.COINS;

// what everybody says, what the human is told
const says = [];
// (bots speak as typed lines, port/BotSay; its listeners hear each line as it is shown)
// (a line to another bot, a friend's "heya" back, is that bot's business: not a word to the human in a trade check)
T.sayListeners.push((player, text, _kind, to) => says.push({ t: World.currentTick, who: player.username, text, toBot: to?.is_bot === true }));
const told = [];
const messageGame = human.messageGame.bind(human);
human.messageGame = text => {
    told.push({ t: World.currentTick, text });
    return messageGame(text);
};
// every trade request that reaches the library
const requests = [];
const onTradeRequest = T.BotTrade.onTradeRequest;
T.BotTrade.onTradeRequest = function (h, bot) {
    requests.push({ t: World.currentTick, human: h.username, bot: bot.username });
    return onTradeRequest.call(this, h, bot);
};

const tick = (n = 1) => {
    for (let i = 0; i < n; i++) sim.tick();
};
const waitUntil = (fn, max) => {
    for (let i = 0; i < max && !fn(); i++) tick(1);
    return !!fn();
};
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const taskOf = p => sim.botPlayer(p)?.currentTask ?? null;
const saidBy = (bot, from) => says.slice(from).filter(s => s.who === bot.username && !s.toBot).map(s => s.text);
const toldSince = from => told.slice(from).map(m => m.text);
const coins = p => T.invTotal(p, 'inv', COINS);
const giveHuman = (id, n) => human.getInventory(InvType.INV).add(id, n);
const clearHumanPack = () => {
    const inv = human.getInventory(InvType.INV);
    for (let s = 0; s < inv.capacity; s++) inv.delete(s);
};
const status = p => T.tradeStatus(p);
// the realism work (phase 2): a bot reads a settled trade screen 1-4 s before it accepts (port/BotTradeScreen,
// BotTiming 'trade': at most 12 ticks), where it accepted in the same tick before; the human, as slow as before, also
// waits for its accept ("Other player has accepted") before the next tap. The outcomes are checked as before.
const READ_TICKS = 12;
const accepted = (bot, st = TradeStatus.PENDING_ACCEPT) => waitUntil(() => status(bot) === st, READ_TICKS);
const offer = p => Object.fromEntries(T.tradeOffer(p));
const sameOffer = (p, want) => T.sameItems(T.tradeOffer(p), new Map(Object.entries(want).map(([id, n]) => [Number(id), n])));

function freeAdjacent(p) {
    // (one step from the bot: a walkable tile across a wall or a bank counter is no place to trade from)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (sim.isWalkable(p.x + dx, p.z + dz, p.level) && sim.walkDistance(p, p.x + dx, p.z + dz) === 1) return [p.x + dx, p.z + dz];
    return null;
}
/** The bot stops where it is: no route, no interaction, no teleport it had cast. */
function stop(bot) {
    sim.botPlayer(bot).pendingTeleport = null;
    bot.clearWaypoints();
    bot.clearInteraction();
}
/** The bot is put at (x, z) on the ground floor and stays there for now. */
function place(bot, x, z) {
    stop(bot);
    bot.teleJump(x, z, 0);
    tick(1);
    stop(bot);
}
/**
 * The bot does `task` from now on (as the coverage scenario: the planner's rescans give the same task back). It lets go
 * of what it was doing first (BotPlayer.windDown: its sub-task dropped, its task before interrupted, as a switch ends
 * it). (The variety work, round 2, the fixes: a sub-task runs ahead of the task, and a fighter's errand fight
 * (ErrandTask's 'Combat:errand', its errand never interrupted) went on under the bankstand: it held the bankstander
 * from its bank for 500 ticks at one seed, and at another banked the coins the staging gave it, as a fighter's bank
 * stop does: 200 kept.)
 */
function force(bot, task) {
    const bp = sim.botPlayer(bot);
    bp.windDown();
    task.reset();
    bp.planner.pickTask = () => task;
    bp.currentTask = task;
}
/** The human steps next to the bot (and the bot into the human's player list). */
function besideBot(bot) {
    const at = freeAdjacent(bot);
    if (!at) return false;
    sim.teleportHuman(at[0], at[1], bot.level);
    tick(2);
    return true;
}
/**
 * The human asks `bot` to trade: what the bot said and the human was told by the tick after the request reached the
 * bot. `still`: the bot's AI is paused meanwhile (one about its task walks off: the human would chase it), and a
 * dialogue it has open is closed ("<bot> is busy at the moment." is the stock script's answer to that).
 */
function requestTrade(bot, { still = false } = {}) {
    const bp = sim.botPlayer(bot);
    if (still) {
        bp.tick = () => {};
        stop(bot);
        if (bot.busy()) bot.closeModal();
    }
    besideBot(bot);
    const s0 = says.length;
    const m0 = told.length;
    const r0 = requests.length;
    const ok = T.opPlayer(human, bot, 4);
    const reachedNow = () => requests.slice(r0).some(r => r.bot === bot.username) || toldSince(m0).some(t => t.endsWith('is busy at the moment.'));
    waitUntil(reachedNow, 6);
    tick(1);
    // a request that did not get there must not get there later, in the middle of the next check
    if (!reachedNow()) human.clearInteraction();
    if (still) delete bp.tick;
    return { ok, said: saidBy(bot, s0), told: toldSince(m0), reached: requests.slice(r0).some(r => r.bot === bot.username) };
}
/**
 * The human says `text` near the bot (the public chat hook's call) and waits; the bot's lines. 26 ticks: a reply's latest
 * since the realism work's typed replies (a tick to read the line, at most 20 to think and type it, a few to spare: as
 * test/sim.mjs's REPLY_TICKS); the 10 of before were a short reply's, and a longer one drawn ("Yeah what's up? haha")
 * came after them (realism phase 3: the world's dice drew it)
 */
function chatTo(bot, text, ticks = 26) {
    besideBot(bot);
    const s0 = says.length;
    BotChat.onPublicMessage(human, text);
    for (let i = 0; i < ticks; i++) {
        if (cheb(human, bot) > 2) besideBot(bot);
        tick(1);
    }
    return saidBy(bot, s0);
}

/**
 * The strings the trade code (port/BotTrade, port/BotTradeScreen, the vendor, bankstand and social tasks) can say: its
 * string and template literals outside imports and logging, a template's ${…} filled with a name or a number.
 */
async function tradeLines() {
    const { typescript } = await import('./lib/paths.mjs');
    const ts = await typescript();
    const out = [];
    for (const file of ['port/BotTrade.ts', 'port/BotTradeScreen.ts', 'tasks/VendorTask.ts', 'tasks/BankstandTask.ts', 'tasks/SocialTask.ts']) {
        const sf = ts.createSourceFile(file, fs.readFileSync(path.join(BOTS_DIR, 'src', file), 'utf8'), ts.ScriptTarget.ES2022, true);
        const logging = n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'console';
        (function visit(n) {
            if (ts.isImportDeclaration(n) || logging(n)) return;
            if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
                // (not a content name: 'trademain:accept', 'bank_main:com_93' …)
                if (/[a-z]/i.test(n.text) && !/^[a-z0-9_]+(:[a-z0-9_]+)?$/.test(n.text)) out.push([file, n.text]);
            } else if (ts.isTemplateExpression(n)) {
                let text = n.head.text;
                for (const span of n.templateSpans) text += (/name/i.test(span.expression.getText(sf)) ? 'Casey' : '12') + span.literal.text;
                out.push([file, text]);
                for (const span of n.templateSpans) visit(span.expression); // (templates inside a template)
                return;
            }
            ts.forEachChild(n, visit);
        })(sf);
    }
    return out;
}

tick(Number(args.warm ?? 120));
out(`trade: ${sim.bots().length} bots, ${MEMBERS ? 'members' : 'free'} world, overlay ${overlay.scripts.length} scripts`);

// ---- 00. where vendors sell (port/BotTradeSpots): about half at Varrock West, its crowd a tile each -----
{
    // 60 stand-in vendors (a big world's worth): every one gets a place; about half or more at Varrock West; its crowd
    // a tile each, none on a stall or beside one, every tile reachable from the bank's spot, in the hall and out front
    const vwb = T.TRADE_BANKS.find(b => b.key === 'varrock_west');
    const fakes = Array.from({ length: 60 }, (_, i) => ({ username: `stand_in_${i}`, slot: 2000 + i }));
    const places = fakes.map(f => T.claimVendorStall(f));
    const atHub = places.filter(p => p && p.bank.key === 'varrock_west');
    const stallTiles = new Set(vwb.stalls.map(([x, z]) => `${x},${z}`));
    const crowd = atHub.filter(p => p.crowd).map(p => p.tile);
    // (a stall's vendor or bank-stander steps a tile about it: no crowd tile beside one)
    const besideStall = crowd.filter(([x, z]) => vwb.stalls.some(([sx, sz]) => Math.max(Math.abs(x - sx), Math.abs(z - sz)) <= 1));
    const stallsRight = atHub.every(p => p.crowd === true || stallTiles.has(`${p.tile[0]},${p.tile[1]}`));
    const distinct = new Set(atHub.map(p => `${p.tile[0]},${p.tile[1]}`)).size === atHub.length;
    const unreachable = crowd.filter(([x, z]) => {
        const route = T.routefinder.findPath(0, vwb.center[0], vwb.center[1], x, z, 1, 1, 1, 0, -1, false, 0, 25, 0);
        const last = route.length ? route[route.length - 1] : -1;
        return !(x === vwb.center[0] && z === vwb.center[1]) && (last === -1 || ((last >> 14) & 0x3fff) !== x || (last & 0x3fff) !== z);
    });
    const inside = crowd.filter(([, z]) => z >= 3434).length;
    const front = crowd.filter(([, z]) => z <= 3432).length;
    check(`vendor places: 60 stand-ins all placed, ${atHub.length} at Varrock West (about half or more), its crowd a tile each, none on a stall or beside one, all reachable, in the hall (${inside}) and out front (${front})`, places.every(Boolean) && atHub.length >= 30 && distinct && stallsRight && besideStall.length === 0 && unreachable.length === 0 && inside > 0 && front > 0, { banks: [...new Set(places.map(p => p?.bank.key))].join(','), besideStall: besideStall.slice(0, 3), unreachable: unreachable.slice(0, 3) });
    for (const f of fakes) T.releaseStall(f);
    // homes: Varrock West as often as all the other banks together; adverts 25-50 a minute there, 12-20 elsewhere
    // (2026-10-18: auto typers, more often; was 20-30 and 10-15)
    const homes = T.BOT_NAMES.filter((_, i) => i % 3 === 0).map(n => T.vendorHome(n)).filter(([x, z]) => x === vwb.center[0] && z === vwb.center[1]).length / Math.ceil(T.BOT_NAMES.length / 3);
    check(`vendor homes: Varrock West about half (${(homes * 100).toFixed(0)} %); adverts at most ${T.advertsPerMinute(vwb)} a minute there, ${T.advertsPerMinute(T.TRADE_BANKS.find(b => b.key === 'falador_east'))} elsewhere`, homes > 0.4 && homes < 0.6 && T.advertsPerMinute(vwb) >= 25 && T.advertsPerMinute(vwb) <= 50 && T.advertsPerMinute(T.TRADE_BANKS.find(b => b.key === 'falador_east')) <= 20);
}

// ---- 0. vendor prices and adverts (port/BotPrices, VendorTask.vendorAdverts) -----------------------------------------
{
    // every stock item at three vendors' prices: never below high alch, buy-backs at most the item's value, and every
    // advert passes the word filter whole (upstream's "12x" and "@" made it star the item: "Swordfi*********p ea")
    const masked = [];
    const unsafe = [];
    for (const item of T.vendorStock()) {
        for (const vendorName of ['market_mary', 'ore_trader', 'mr_bargain']) {
            const category = T.categoryOf(item.itemId, item.rare, item.market);
            const price = T.sellPrice(item.itemId, vendorName, category, item.priceEach);
            const obj = T.ObjType.get(item.itemId);
            // (a rare is sold as itself since phase 4: never noted)
            const noted = !item.rare && obj.certtemplate === -1 && obj.certlink >= 0;
            const buy = noted ? T.buyPrice(item.itemId, price, category) : 0;
            const value = T.itemValue(item.itemId);
            if (price <= Math.floor(value * 0.6)) unsafe.push(`${item.name} sold at ${price} (high alch ${Math.floor(value * 0.6)})`);
            if (buy > value) unsafe.push(`${item.name} bought at ${buy} (worth ${value})`);
            const name = item.alias ?? obj.name ?? item.name;
            // (phase 4: a vendor's own forms and nickname; the realism work's adverts, test/economy.test.mjs has the rest)
            const kind = item.rare ? 'rare' : obj.wearpos !== -1 ? 'gear' : 'bulk';
            const lines = T.vendorAdverts({ nick: (item.nicks ?? [name.toLowerCase()])[0], price, buyBack: buy, kind, noted, count: item.rare ? 1 : 500, seed: T.nameSeed(vendorName, 'advert-forms') });
            if (lines.length < 2) masked.push(`${name} at ${price}: only ${lines.length} adverts left whole`);
            for (const line of lines) if (T.WordEnc.filter(line) !== line) masked.push(`${line} -> ${T.WordEnc.filter(line)}`);
        }
    }
    check(`vendor prices: never below high alch, never buying back above the item's value (${T.vendorStock().length} items)`, unsafe.length === 0, unsafe.slice(0, 5).join('; '));
    check('vendor adverts: every stock item at three vendors\' prices, in each vendor\'s own forms, passes the word filter whole (2+ lines each)', masked.length === 0, masked.slice(0, 5).join(' | '));
}

if (MEMBERS) {
    // ---- 1. a bot whose task does not trade ----------------------------------------------------------------------
    const NON_TRADING = ['skiller', 'fighter', 'balanced', 'random'];
    // "come here" below needs a tile 6-8 away by a short walk (from where the bot is by then: it may have walked indoors)
    const farTile = p => {
        for (let r = 8; r >= 6; r--) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                    const [x, z] = [p.x + dx, p.z + dz];
                    const d = sim.isWalkable(x, z, p.level) ? sim.walkDistance(p, x, z) : -1;
                    if (d > 0 && d <= 12) return [x, z];
                }
            }
        }
        return undefined;
    };
    const worker = sim.bots().find(p => NON_TRADING.includes(p.botPlanner) && p.level === 0 && freeAdjacent(p) && !T.isTradingTask(taskOf(p)) && farTile(p));
    if (check('a bot whose task does not trade', worker, sim.bots().map(p => `${p.username}:${taskOf(p)?.name}`))) {
        const task = taskOf(worker)?.name;
        // (greeted at its keyboard: not on a short break, as a player away says nothing (the realism work's habits,
        // port/BotHabits.isAway), and not in a script with a window open, a boat's crossing; which bot is picked is the
        // world's dice: phase 3's login order picked one boarding the Karamja boat, and the greeting was lost)
        const atKeyboard = () => !T.isAway(worker) && !worker.delayed && worker.modalMain === -1;
        waitUntil(atKeyboard, 200);
        const before = chatTo(worker, `Hi ${worker.displayName}`);
        tick(60); // past the 30 s conversation
        const r = requestTrade(worker, { still: true });
        check(`${task}: the request reaches the library (the overlay's [opplayer4,_])`, r.ok && r.reached, r);
        check(`${task}: it declines in a word, not "One moment please"`, r.said.length === 1 && !r.said[0].startsWith('One moment please'), r.said);
        check(`${task}: the decline is shown as written (word filter)`, r.said.length === 1 && T.WordEnc.filter(r.said[0]) === r.said[0], r.said);
        check(`${task}: no trade target, no trade window`, worker.botTradeTargetPid === -1 && human.modalMain === -1 && worker.modalMain === -1, { pid: worker.botTradeTargetPid, human: human.modalMain });
        check(`${task}: the human is told "Sending trade offer..." (the stock script)`, r.told.includes('Sending trade offer...'), r.told);
        tick(150);
        check(`${task}: still no trade target 150 ticks later`, worker.botTradeTargetPid === -1, worker.botTradeTargetPid);
        waitUntil(atKeyboard, 200);
        const after = chatTo(worker, `Hi ${worker.displayName}`);
        check(`${task}: it still answers its whole name`, before.length > 0 && after.length > 0, { before, after });

        // "come here", from a tile about 8 away by a short walk (out of a room it walked into first: the castle kitchen's
        // door shut, no such tile); not while a monster has it in a fight (its self-defence comes first, and whether one
        // attacked just then is the world's dice)
        waitUntil(() => World.currentTick >= worker.preventLogoutUntil, 100);
        if (!farTile(worker)) place(worker, 3222, 3218);
        const far = farTile(worker);
        if (check('a free tile about 8 away for "come here"', far, [worker.x, worker.z])) {
            sim.teleportHuman(far[0], far[1], worker.level);
            tick(2);
            const consumed = BotChat.onPrivateMessage(human, worker.username, 'come here');
            let closest = cheb(worker, human);
            waitUntil(() => (closest = Math.min(closest, cheb(worker, human))) <= 1, 40);
            check(`${task}: "come here" still brings it over (not refused for a trade it is not in)`, consumed && closest <= 2, { consumed, closest, now: cheb(worker, human), sub: sim.botPlayer(worker).subTask?.name });
        }
        const again = requestTrade(worker, { still: true });
        check(`${task}: a second request declines again`, again.said.length === 1 && !again.said[0].startsWith('One moment please') && worker.botTradeTargetPid === -1, again);
    }

    // a PKer declines too (brought to the human: it would go back to its hunt)
    const pker = sim.bots().find(p => p.botPlanner === 'extras_pker' || p.botPlanner === 'extras_edgeville_pker');
    if (check('a PKer bot', pker)) {
        sim.teleportHuman(3222, 3218, 0);
        sim.botPlayer(pker).tick = () => {};
        place(pker, 3223, 3218);
        const r = requestTrade(pker, { still: true });
        check('a PKer declines, no trade target', r.reached && r.said.length === 1 && !r.said[0].startsWith('One moment please') && pker.botTradeTargetPid === -1, { ...r, task: taskOf(pker)?.name });
    }

    // ---- 2. a vendor, and a slow human -------------------------------------------------------------------------
    // (a vendor with 3 or more to sell: since phase 4 a rare is one item, its own check below)
    let vendor = null;
    waitUntil(() => (vendor = sim.bots().find(p => p.botPlanner === 'extras_vendor' && taskOf(p)?.state === 'idle' && taskOf(p).itemCount >= 3 && !taskOf(p).stock?.rare && freeAdjacent(p))), 600);
    if (check('an idle vendor', vendor)) {
        const task = taskOf(vendor);
        // (its price from the item's value: port/BotPrices)
        const price = task.price;
        const item = vendor.botVendorStockItemId;
        const label = `vendor (${task.stockName} at ${price})`;
        // 3 items' worth and some change (less than another item)
        const change = Math.floor(price / 2);
        clearHumanPack();
        giveHuman(COINS, price * 3 + change);
        let s0 = says.length;
        const r = requestTrade(vendor);
        check(`${label}: takes the request: "One moment please, Casey", trade target = the human`, r.said.includes('One moment please, Casey') && (vendor.botTradeTargetPid === human.uid || vendor.modalMain === TRADEMAIN), r.said);
        const opened = waitUntil(() => human.modalMain === TRADEMAIN, 10);
        check(`${label}: the trade window opens for both`, opened && vendor.modalMain === TRADEMAIN, { human: human.modalMain, vendor: vendor.modalMain });
        tick(SLOW);
        check(`${label}: it greets and waits (no offer, no accept)`, saidBy(vendor, s0).some(l => l.startsWith('Hi Casey! Selling')) && T.tradeOffer(vendor).size === 0 && status(vendor) !== TradeStatus.PENDING_ACCEPT, { said: saidBy(vendor, s0), offer: offer(vendor) });
        s0 = says.length;
        check(`${label}: the human offers all their coins`, T.invButton(human, 'tradeside:inv', 'inv', COINS, 4), T.invItems(human, 'inv'));
        // (when its offer became the deal's, and when it accepted)
        let dealAt = -1;
        let acceptedAt = -1;
        for (let i = 0; i < SLOW + READ_TICKS && (i < SLOW || acceptedAt < 0); i++) {
            tick(1);
            if (dealAt < 0 && T.invTotal(vendor, 'tradeoffer', item) === 3) dealAt = World.currentTick;
            if (acceptedAt < 0 && status(vendor) === TradeStatus.PENDING_ACCEPT) acceptedAt = World.currentTick;
        }
        check(`${label}: it reads the deal a moment before it accepts (not in the tick it is put up)`, dealAt >= 0 && acceptedAt > dealAt, { dealAt, acceptedAt });
        check(`${label}: 3 for 3 × the price, the change back in its offer, and accepted`, T.invTotal(vendor, 'tradeoffer', item) === 3 && T.invTotal(vendor, 'tradeoffer', COINS) === change && T.tradeOffer(vendor).size === (change > 0 ? 2 : 1) && status(vendor) === TradeStatus.PENDING_ACCEPT, { offer: offer(vendor), status: status(vendor), said: saidBy(vendor, s0) });
        T.ifButton(human, 'trademain:accept');
        tick(1);
        check(`${label}: the confirm screen opens for both`, human.modalMain === TRADECONFIRM && vendor.modalMain === TRADECONFIRM, { human: human.modalMain, vendor: vendor.modalMain });
        tick(SLOW);
        accepted(vendor, TradeStatus.PENDING_CONFIRM);
        check(`${label}: it accepts the confirm screen once it is open, and waits`, status(vendor) === TradeStatus.PENDING_CONFIRM && human.modalMain === TRADECONFIRM, { status: status(vendor), human: human.modalMain });
        T.ifButton(human, 'tradeconfirm:accept');
        tick(2);
        check(`${label}: the trade went through: 3 items for exactly their price`, T.invTotal(human, 'inv', item) === 3 && coins(human) === change && human.modalMain === -1, T.invItems(human, 'inv'));
        check(`${label}: thanks, and no trade target`, saidBy(vendor, s0).some(l => l === 'Pleasure doing business!' || l === 'Ty!') && vendor.botTradeTargetPid === -1, saidBy(vendor, s0));

        // an overpayment of one item's price or more (only the bot's 2 items for 4 × the price)
        waitUntil(() => taskOf(vendor)?.state === 'idle', 60);
        task.stockMax = 2;
        task.itemCount = 2;
        vendor.getInventory(InvType.INV).remove(item, T.invTotal(vendor, 'inv', item) - 2);
        clearHumanPack();
        giveHuman(COINS, price * 4);
        s0 = says.length;
        requestTrade(vendor);
        waitUntil(() => human.modalMain === TRADEMAIN, 10);
        T.invButton(human, 'tradeside:inv', 'inv', COINS, 4);
        tick(SLOW);
        T.ifButton(human, 'trademain:accept');
        tick(SLOW);
        const refusal = saidBy(vendor, s0).find(l => l.startsWith("That's too much!"));
        check(`${label}: 4 × the price for its 2 items: refused, with a message`, refusal === `That's too much! 2x ${task._stockOfferName(task.stock)} is ${price * 2}gp, take back ${price * 2}gp.` && status(vendor) !== TradeStatus.PENDING_ACCEPT && human.modalMain === TRADEMAIN, { said: saidBy(vendor, s0), status: status(vendor), human: human.modalMain });
        T.invButton(human, 'trademain:inv', 'tradeoffer', COINS, 5, price * 2);
        tick(SLOW);
        accepted(vendor);
        check(`${label}: the human takes 2 × the price back (Remove-X): 2 items, accepted`, T.invTotal(human, 'tradeoffer', COINS) === price * 2 && T.invTotal(vendor, 'tradeoffer', item) === 2 && status(vendor) === TradeStatus.PENDING_ACCEPT, { human: offer(human), vendor: offer(vendor) });
        T.ifButton(human, 'trademain:accept');
        tick(SLOW);
        accepted(vendor, TradeStatus.PENDING_CONFIRM);
        T.ifButton(human, 'tradeconfirm:accept');
        tick(2);
        check(`${label}: and it went through: 2 items, 2 × the price kept`, T.invTotal(human, 'inv', item) === 2 && coins(human) === price * 2, T.invItems(human, 'inv'));

        // the human sells its noted stock to it
        if (vendor.botVendorStockNoted && task.buyBack > 0) {
            waitUntil(() => taskOf(vendor)?.state === 'idle', 60);
            const buyPrice = task.buyBack;
            clearHumanPack();
            giveHuman(item, 5);
            requestTrade(vendor);
            waitUntil(() => human.modalMain === TRADEMAIN, 10);
            T.invButton(human, 'tradeside:inv', 'inv', item, 4);
            tick(SLOW);
            accepted(vendor);
            check(`${label}: buys 5 noted for exactly 5 × ${buyPrice}gp`, T.invTotal(vendor, 'tradeoffer', COINS) === 5 * buyPrice && T.tradeOffer(vendor).size === 1 && status(vendor) === TradeStatus.PENDING_ACCEPT, offer(vendor));
            T.ifButton(human, 'trademain:accept');
            tick(SLOW);
            accepted(vendor, TradeStatus.PENDING_CONFIRM);
            T.ifButton(human, 'tradeconfirm:accept');
            tick(2);
            check(`${label}: the human got exactly that`, coins(human) === 5 * buyPrice && T.invTotal(human, 'inv', item) === 0, T.invItems(human, 'inv'));
        }

        // the human closes the trade: the bot's target is cleared at once ([if_close,trademain] -> stage -1)
        waitUntil(() => taskOf(vendor)?.state === 'idle', 60);
        requestTrade(vendor);
        waitUntil(() => human.modalMain === TRADEMAIN, 10);
        T.closeModal(human);
        tick(1);
        check(`${label}: the human closes the window: the bot's trade target is cleared`, vendor.botTradeTargetPid === -1 && vendor.modalMain === -1, { pid: vendor.botTradeTargetPid, modal: vendor.modalMain });

        // the human taps "Trade with" again with the window open (the op closes it): the new request is not lost
        waitUntil(() => taskOf(vendor)?.state === 'idle', 60);
        requestTrade(vendor);
        waitUntil(() => human.modalMain === TRADEMAIN, 10);
        T.opPlayer(human, vendor, 4);
        tick(2);
        const reopened = waitUntil(() => human.modalMain === TRADEMAIN && vendor.modalMain === TRADEMAIN, 15);
        check(`${label}: asked again at once: a new trade window opens`, reopened, { human: human.modalMain, vendor: vendor.modalMain, pid: vendor.botTradeTargetPid });
        T.closeModal(human);
        tick(2);

        // the human leaves the window open: after SCREEN_TICKS the bot closes it, with a line
        waitUntil(() => taskOf(vendor)?.state === 'idle', 60);
        s0 = says.length;
        const m0 = told.length;
        requestTrade(vendor);
        waitUntil(() => human.modalMain === TRADEMAIN, 10);
        const closed = waitUntil(() => human.modalMain === -1, 130);
        check(`${label}: a window left open is closed after ~60 s: "Other player declined trade."`, closed && toldSince(m0).includes('Other player declined trade.') && saidBy(vendor, s0).some(l => l.startsWith('Too slow')), { said: saidBy(vendor, s0), told: toldSince(m0) });
        check(`${label}: and it went back to its stall`, waitUntil(() => taskOf(vendor)?.state === 'idle', 60) && vendor.botTradeTargetPid === -1, taskOf(vendor)?.state);

        // ---- 2b. (the realism work, phase 4) trade talk: in a trade, "how much?" gets its price, a lowball a "lol no",
        // its price a "k"; typed (a moment later), trade lines; the trade itself is unchanged
        waitUntil(() => taskOf(vendor)?.state === 'idle', 60);
        requestTrade(vendor);
        waitUntil(() => human.modalMain === TRADEMAIN, 10);
        tick(SLOW);
        // (2026-10-18: an auto typer's advert, typed on through the trade, is no answer)
        const answers = from => saidBy(vendor, from).filter(l => l !== task.typerLine);
        const talk = (text, want) => {
            const from = says.length;
            BotChat.onPublicMessage(human, text);
            waitUntil(() => answers(from).length > 0, 40);
            const line = answers(from)[0] ?? '';
            return { line, ok: want.some(t => line.toLowerCase() === t.replace('{p}', T.formatGp(price)).toLowerCase()) };
        };
        const asked = talk('how much?', [...T.TRADE_TALK.price, ...T.TRADE_TALK.priceOne]);
        check(`${label}: in a trade, "how much?" gets its price: "${asked.line}"`, asked.ok, asked.line);
        const low = Math.max(1, Math.floor(price / 4));
        const lowball = talk(`${low} ea?`, [...T.TRADE_TALK.lowball, ...T.TRADE_TALK.lowballOne]);
        check(`${label}: "${low} ea?" (a quarter of its ask) gets a "lol no": "${lowball.line}"`, lowball.ok, lowball.line);
        const fair = talk(`${T.formatGp(price)} ea`, [...T.TRADE_TALK.deal]);
        check(`${label}: its own price gets a "k": "${fair.line}"`, fair.ok, fair.line);
        check(`${label}: the window stays open through the talk (each line gives the human their time again)`, human.modalMain === TRADEMAIN && vendor.botTradeTargetPid === human.uid, { human: human.modalMain });
        T.closeModal(human);
        tick(2);

        // ---- 2c. (the realism work, phase 4) a rare: one, the item itself (never noted), at its 2004 price; sold, it
        // is gone and the vendor stocks something else
        waitUntil(() => taskOf(vendor)?.state === 'idle', 60);
        const rare = T.vendorStock().find(i => i.itemId === Items.BLUE_PARTYHAT);
        const pack = vendor.getInventory(InvType.INV);
        for (let s = 0; s < pack.capacity; s++) if (pack.get(s) && pack.get(s).id !== COINS) pack.delete(s);
        task._stock(vendor, rare);
        task.state = 'idle';
        const rarePrice = task.price;
        check(`a rare: one blue partyhat, unnoted, at about 12.5m (${rarePrice}), no buy-back, adverts without "noted" ("${task.adverts[0]}")`, task.itemCount === 1 && T.invTotal(vendor, 'inv', Items.BLUE_PARTYHAT) === 1 && !vendor.botVendorStockNoted && task.buyBack === 0 && rarePrice >= 11_000_000 && rarePrice <= 14_000_000 && task.adverts.length >= 2 && task.adverts.every(a => !/\bnoted\b/.test(a)), { count: task.itemCount, noted: vendor.botVendorStockNoted, buy: task.buyBack, adverts: task.adverts });
        clearHumanPack();
        giveHuman(COINS, rarePrice);
        s0 = says.length;
        requestTrade(vendor);
        waitUntil(() => human.modalMain === TRADEMAIN, 10);
        tick(SLOW);
        check(`a rare: the greeting names the one it has: "${saidBy(vendor, s0).find(l => l.startsWith('Hi Casey!')) ?? ''}"`, saidBy(vendor, s0).some(l => l.startsWith('Hi Casey! Selling my Blue partyhat for')));
        T.invButton(human, 'tradeside:inv', 'inv', COINS, 4);
        tick(SLOW);
        accepted(vendor);
        T.ifButton(human, 'trademain:accept');
        tick(SLOW);
        accepted(vendor, TradeStatus.PENDING_CONFIRM);
        T.ifButton(human, 'tradeconfirm:accept');
        tick(2);
        check('a rare: the human got the partyhat itself for exactly its price', T.invTotal(human, 'inv', Items.BLUE_PARTYHAT) === 1 && coins(human) === 0, T.invItems(human, 'inv'));
        check('a rare: sold, it is gone (no partyhat in its pack, nothing left to sell)', T.invTotal(vendor, 'inv', Items.BLUE_PARTYHAT) === 0 && task.itemCount === 0, { pack: T.invItems(vendor, 'inv'), count: task.itemCount });
        check('a rare: and the vendor stocks something else, not a rare', waitUntil(() => task.stock && task.itemCount > 0 && (task.state === 'walk' || task.state === 'idle'), 60) && !task.stock.rare && task.stock.itemId !== Items.BLUE_PARTYHAT, { state: task.state, stock: task.stock?.name });
    }

    // ---- 3. bankstand ------------------------------------------------------------------------------------------------
    const seller = sim.bots().find(p => p.botPlanner === 'fighter' && p !== worker && p.level === 0);
    if (check('a fighter for the bankstand', seller)) {
        const bp = sim.botPlayer(seller);
        // (a script it began as a fighter ends first: a bury reads its pack's slot a tick after the click, and the slot
        // emptied below gave 274's bury_bone.rs2 an "oc_param ... -1" error; the realism work's phase 4 moved the dice)
        force(seller, new T.BankstandTask());
        tick(2);
        // what a fighter carries (sharks, its gear, its coins and tools) and a bank with things to sell
        const pack = seller.getInventory(InvType.INV);
        for (let s = 0; s < pack.capacity; s++) pack.delete(s);
        pack.add(Items.SHARK, 8);
        pack.add(Items.IRON_SCIMITAR, 1);
        pack.add(Items.BRONZE_AXE, 1);
        pack.add(COINS, 5000);
        const bank = seller.getInventory(InvType.getId('bank'));
        // (its bank holds the test's stock only: a fighter that staked at the Duel Arena banked its pack, phase 5b)
        for (let s = 0; s < bank.capacity; s++) bank.delete(s);
        bank.add(Items.YEW_LOGS, 300);
        bank.add(Items.COAL, 200);
        place(seller, 3185, 3436);
        const task = new T.BankstandTask();
        force(seller, task);
        const r = requestTrade(seller, { still: true });
        check('bankstand, not banked yet: refuses (no "One moment please"), no trade target, no window', r.said.length === 1 && !r.said[0].startsWith('One moment please') && seller.botTradeTargetPid === -1 && human.modalMain === -1, r);
        const banked = waitUntil(() => task.hasBanked && task.state === 'idle', 500);
        const stock = Object.fromEntries([...task.stock].map(([id, e]) => [T.ObjType.get(id).debugname, e.count]));
        check('bankstand: banks, with its bank window closed again', banked && seller.modalMain === -1, { state: task.state, modal: seller.modalMain });
        check('bankstand: its stock is the sellable items only (no coins, tools, food or gear)', JSON.stringify(stock) === JSON.stringify({ cert_yew_logs: 300, cert_coal: 200 }), stock);
        check('bankstand: it kept its coins for change', coins(seller) === 5000, T.invItems(seller, 'inv'));
        const coalId = Items.COAL + 1;
        const yewId = Items.YEW_LOGS + 1;
        const coalPrice = task.stock.get(coalId)?.price ?? 0;
        const yewPrice = task.stock.get(yewId)?.price ?? 0;

        const sellerCoins = coins(seller);
        clearHumanPack();
        giveHuman(COINS, 50 * coalPrice + 7);
        let s0 = says.length;
        requestTrade(seller);
        const opened = waitUntil(() => human.modalMain === TRADEMAIN, 10);
        tick(SLOW);
        check('bankstand: the window opens; it puts up only its stock', opened && JSON.stringify(offer(seller)) === JSON.stringify({ [yewId]: 300, [coalId]: 200 }), offer(seller));
        BotChat.onPublicMessage(human, 'All');
        tick(SLOW);
        const allLine = saidBy(seller, s0).find(l => l.startsWith('Everything will cost'));
        const allTotal = 300 * yewPrice + 200 * coalPrice;
        check(`bankstand: 'all' is priced from what is in its offer (${allTotal}gp, never 0)`, allTotal > 0 && allLine === `Everything will cost ${allTotal}gp. Put up your coins.`, saidBy(seller, s0));
        BotChat.onPublicMessage(human, 'Do you sell noted logs');
        tick(SLOW);
        check('bankstand: "noted logs" is not a "no": the trade stays open', human.modalMain === TRADEMAIN && seller.modalMain === TRADEMAIN, saidBy(seller, s0));
        s0 = says.length;
        BotChat.onPublicMessage(human, 'Coal');
        tick(SLOW);
        check('bankstand: "Coal": its price, and its offer shows all its coal (only)', saidBy(seller, s0).includes(`Coal costs ${coalPrice}gp each, ${200 * coalPrice}gp for all 200. Put up your coins.`) && JSON.stringify(offer(seller)) === JSON.stringify({ [coalId]: 200 }), { said: saidBy(seller, s0), offer: offer(seller) });
        T.invButton(human, 'tradeside:inv', 'inv', COINS, 4);
        tick(SLOW);
        accepted(seller);
        check('bankstand: the human puts up 50 × the price and 7: 50 coal and 7 coins change, the rest taken back, accepted', sameOffer(seller, { [coalId]: 50, [COINS]: 7 }) && status(seller) === TradeStatus.PENDING_ACCEPT, { offer: offer(seller), status: status(seller), said: saidBy(seller, s0) });
        T.ifButton(human, 'trademain:accept');
        tick(SLOW);
        accepted(seller, TradeStatus.PENDING_CONFIRM);
        T.ifButton(human, 'tradeconfirm:accept');
        tick(2);
        check('bankstand: the trade went through: 50 coal for exactly their price', T.invTotal(human, 'inv', coalId) === 50 && coins(human) === 7 && coins(seller) === sellerCoins + 50 * coalPrice, { human: T.invItems(human, 'inv'), seller: T.invItems(seller, 'inv') });
        check('bankstand: still selling the rest, not off to the bank', task.stock.get(coalId)?.count === 150 && task.hasBanked && seller.botTradeTargetPid === -1, { stock: [...task.stock], state: task.state });

        // everything else: sold out
        const rest = 300 * yewPrice + 150 * coalPrice;
        clearHumanPack();
        giveHuman(COINS, rest);
        waitUntil(() => task.state !== 'trade' && seller.botTradeTargetPid === -1, 20);
        s0 = says.length;
        requestTrade(seller);
        waitUntil(() => human.modalMain === TRADEMAIN, 10);
        tick(SLOW);
        BotChat.onPublicMessage(human, 'all');
        tick(SLOW);
        T.invButton(human, 'tradeside:inv', 'inv', COINS, 4);
        tick(SLOW);
        accepted(seller);
        check(`bankstand: 'all' for exactly ${rest}gp: accepted`, status(seller) === TradeStatus.PENDING_ACCEPT && JSON.stringify(offer(seller)) === JSON.stringify({ [yewId]: 300, [coalId]: 150 }), { offer: offer(seller), status: status(seller), said: saidBy(seller, s0) });
        T.ifButton(human, 'trademain:accept');
        tick(SLOW);
        accepted(seller, TradeStatus.PENDING_CONFIRM);
        T.ifButton(human, 'tradeconfirm:accept');
        tick(2);
        check('bankstand: everything sold', T.invTotal(human, 'inv', yewId) === 300 && T.invTotal(human, 'inv', coalId) === 150 && coins(human) === 0, T.invItems(human, 'inv'));
        const soldOut = requestTrade(seller, { still: true });
        check('bankstand: sold out, it refuses (never "Everything will cost 0gp")', soldOut.said.length === 1 && !soldOut.said[0].startsWith('One moment please') && seller.botTradeTargetPid === -1 && !says.some(s => s.who === seller.username && /cost 0gp/.test(s.text)), soldOut.said);
        check('bankstand: and goes to bank again', !task.hasBanked && (task.state === 'bank_walk' || task.state === 'bank'), task.state);
    }

    // ---- 4. a social bot: no tips any more ---------------------------------------------------------------------------
    // (the realism work, phase 3: "social bots as regulars" drops the scripted tour and its 100k coin
    // tips, so the reward trade this section collected is gone: a social bot trades no more, and declines as any bot
    // whose task does not trade)
    const social = sim.bots().find(p => p.botPlanner === 'extras_social' && p.level === 0 && freeAdjacent(p));
    if (check('a social bot', social)) {
        clearHumanPack();
        const r = requestTrade(social, { still: true });
        check('social: no tips any more: it declines a trade request in a word, no trade target, no window', r.ok && r.reached && r.said.length === 1 && !r.said[0].startsWith('One moment please') && social.botTradeTargetPid === -1 && human.modalMain === -1, { said: r.said, pid: social.botTradeTargetPid });
        tick(30);
        check('social: and puts no coins in a trade (its old reward)', T.tradeOffer(social).size === 0 && coins(human) === 0, { offer: offer(social), human: T.invItems(human, 'inv') });
    }

    // ---- 5. the safety net -----------------------------------------------------------------------------------------
    const idle = sim.bots().find(p => NON_TRADING.includes(p.botPlanner) && p !== seller && !T.isTradingTask(taskOf(p)));
    if (check('a bot for the safety net', idle)) {
        idle.botTradeTargetPid = human.uid;
        idle.botTradeTargetStage = 0;
        tick(80);
        const held = idle.botTradeTargetPid === human.uid;
        tick(50);
        check('a trade target that never moves on is dropped after ~120 ticks (not before 80)', held && idle.botTradeTargetPid === -1, idle.botTradeTargetPid);
    }

    // ---- 6. a vendor in Varrock West's crowd (port/BotTradeSpots): onto its own tile, and it keeps to it -----------
    let crowdVendor = null;
    waitUntil(() => (crowdVendor = sim.bots().find(p => p.botPlanner === 'extras_vendor' && taskOf(p)?.state === 'idle')), 600);
    if (check('a vendor for the crowd', crowdVendor)) {
        // every stall of every bank taken by stand-ins (each at its bank), its own too: the vendor's place is a crowd tile
        T.releaseStall(crowdVendor);
        const fakes = [];
        for (const bank of T.TRADE_BANKS) {
            for (let i = 0; i < bank.stalls.length; i++) {
                const f = { username: `stand_in_${bank.key}_${i}`, slot: 3000 + fakes.length, x: bank.center[0], z: bank.center[1], level: 0 };
                T.claimNearestStall(f);
                fakes.push(f);
            }
        }
        const vwb = T.TRADE_BANKS.find(b => b.key === 'varrock_west');
        place(crowdVendor, vwb.center[0] - 2, vwb.center[1] - 9); // (by the bank's south door)
        const task = taskOf(crowdVendor);
        Object.assign(task, { assignedSpot: null, stall: null, state: 'walk', cooldown: 0 });
        let spot = null;
        let reached = -1;
        for (let t = 0; t < 200 && reached === -1; t++) {
            tick(1);
            spot ??= T.stallOf(crowdVendor);
            if (spot && task.state === 'idle' && crowdVendor.x === spot.tile[0] && crowdVendor.z === spot.tile[1]) reached = t;
        }
        // then 300 ticks of selling: on its tile all along (before, a vendor stepped about it onto its neighbours')
        let off = 0;
        for (let t = 0; t < 300 && reached !== -1; t++) {
            tick(1);
            if (crowdVendor.x !== spot.tile[0] || crowdVendor.z !== spot.tile[1]) off++;
        }
        check(`a vendor in Varrock West's crowd: onto its own tile${spot ? ` (${spot.tile.join(',')})` : ''}, and on it through 300 ticks of selling`, spot?.crowd === true && spot.bank.key === 'varrock_west' && reached !== -1 && off === 0, { place: spot?.tile, crowd: spot?.crowd, reached, off, at: [crowdVendor.x, crowdVendor.z], state: task.state, task: taskOf(crowdVendor)?.name });
        for (const f of fakes) T.releaseStall(f);
    }
} else {
    // ---- free world: vendors ---------------------------------------------------------------------------------------
    let vendor = null;
    waitUntil(() => (vendor = sim.bots().find(p => p.botPlanner === 'extras_vendor' && taskOf(p)?.state === 'idle' && freeAdjacent(p))), 600);
    if (check('an idle vendor', vendor)) {
        const task = taskOf(vendor);
        const picked = new Map();
        for (let i = 0; i < 400; i++) {
            task.handleInit(vendor);
            picked.set(vendor.botVendorStockItemId, task.stock.name);
        }
        const members = [...picked].filter(([id]) => T.isMembersObj(id)).map(([, name]) => name);
        check(`a vendor never stocks a members item (${picked.size} items in 400 restocks)`, members.length === 0 && picked.size > 10, members);
        // made to sell one anyway (upstream picked them): it never takes the coins
        const bow = Items.MAGIC_SHORTBOW;
        const note = T.ObjType.get(bow).certlink;
        const pack = vendor.getInventory(InvType.INV);
        for (let s = 0; s < pack.capacity; s++) if (pack.get(s) && pack.get(s).id !== COINS) pack.delete(s);
        pack.add(note, 6000);
        Object.assign(task, { stock: { itemId: bow, name: 'Magic shortbow', priceEach: 30000 }, stockName: 'Magic shortbow', price: 30000, buyBack: 1600, itemCount: 6000, stockMax: 6000, state: 'idle' });
        clearHumanPack();
        giveHuman(COINS, 60000);
        requestTrade(vendor);
        waitUntil(() => human.modalMain === TRADEMAIN, 10);
        T.invButton(human, 'tradeside:inv', 'inv', COINS, 4);
        tick(SLOW);
        T.ifButton(human, 'trademain:accept');
        tick(SLOW);
        check('a members item it cannot put up: never accepted, never the confirm screen', status(vendor) !== TradeStatus.PENDING_ACCEPT && human.modalMain === TRADEMAIN && T.tradeOffer(vendor).size === 0, { status: status(vendor), human: human.modalMain, offer: offer(vendor) });
        T.closeModal(human);
        tick(2);
        check('the human keeps the coins', coins(human) === 60000 && T.invTotal(human, 'inv', note) === 0, T.invItems(human, 'inv'));
    }
}

// every line the trade code can say passes the server's word filter unchanged (bots speak through it: port/BotSay)
if (MEMBERS) {
    const masked = [];
    let lines = 0;
    for (const [file, text] of await tradeLines()) {
        lines++;
        // (the filter also trims and collapses spaces: a template piece keeps its edges)
        const filtered = T.WordEnc.filter(text);
        if (filtered.replace(/\s+/g, ' ') !== text.trim().replace(/\s+/g, ' ')) masked.push(`${file}: "${text}" -> "${filtered}"`);
    }
    check(`the trade code's ${lines} lines pass the word filter unchanged`, lines > 50 && masked.length === 0, masked.slice(0, 5));
}
check('no bot errors', sim.bots().length > 0 && T.BotManager.stats().errors === 0, T.BotManager.stats().errors);
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).map(e => e.split('\n')[0]));

// the free world runs in its own process (the world's membership is fixed at start)
if (MEMBERS && args.child !== 'false') {
    const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--members=false', ...(args.seed ? [`--seed=${args.seed}`] : [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const lines = `${r.stdout ?? ''}`.split('\n').filter(l => /^(ok|FAIL) /.test(l));
    for (const l of lines) checks.push({ name: l.replace(/^(ok|FAIL)\s+/, '').replace(/ — .*$/, ''), ok: l.startsWith('ok'), detail: l.includes(' — ') ? l.slice(l.indexOf(' — ') + 3) : '' });
    if (r.status !== 0 && !lines.some(l => l.startsWith('FAIL'))) checks.push({ name: 'free world: the child process', ok: false, detail: `exit ${r.status}: ${(r.stderr ?? '').split('\n').slice(-5).join(' | ')}` });
}

out(`  ${checks.filter(c => c.ok).length}/${checks.length} checks passed, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
process.exit(checks.every(c => c.ok) ? 0 : 1);
