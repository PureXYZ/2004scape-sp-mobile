// End-to-end engine session over the REAL page<->worker protocol (ARCHITECTURE.md §4), shared by every harness:
// test/vm.test.mjs (Node vm sandbox), test/jsc-harness.mjs (JavaScriptCore shell), test/chrome/page.js (Chrome).
// Pure JavaScript - no Node APIs - so it runs unchanged in all three.
//
// The harness provides `env`:
//   post(msg, transfer)   page -> engine          onMessage(fn)   engine -> page
//   sleep(ms), now()      timers / clock (ms)     log(line)       output
//   storage               fake native save storage: { puts: [{rel, bytes}], gets: [{rel, status}],
//                         read(rel) -> Uint8Array|null, failPut: bool | (rel) => bool, failGet: bool | (rel) => bool }
//   fixture               test/lib/fixture.mjs output (prot tables, logout component, RSA key, archive CRCs)
//   hooks                 engine module `__test` export, or null (Chrome: protocol-only checks)
//   clock                 { advance(ms) } shifting the engine's Date.now(), or null
//   slow                  time multiplier for slow runtimes (no-JIT JSC), default 1
//   config                world.json overrides for {type:'init'}
import { Isaac, Writer, equalBytes, hex, parseSave, rsaEncrypt, toUserhash } from './protocol.mjs';

export async function runSession(env) {
    const T = createRunner(env);
    const page = new Page(env, T);
    try {
        await scenario(env, T, page);
    } catch (e) {
        T.fail('session aborted', e && e.stack ? e.stack : String(e));
    }
    return T.result(page);
}

// ---- assertions / reporting -----------------------------------------------------------------------------

export function createRunner(env) {
    const checks = [];
    const metrics = {};
    const t0 = env.now();
    let phase = '';
    return {
        phase(name) {
            phase = name;
            env.log(`\n== ${name}  (+${((env.now() - t0) / 1000).toFixed(1)} s)`);
        },
        check(name, ok, detail) {
            const rec = { phase, name, ok: !!ok };
            if (detail !== undefined) rec.detail = detail;
            checks.push(rec);
            env.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
            return !!ok;
        },
        fail(name, detail) {
            this.check(name, false, detail);
        },
        metric(k, v) {
            metrics[k] = v;
            env.log(`  ·     ${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`);
        },
        result(page) {
            const failed = checks.filter(c => !c.ok);
            return {
                ok: failed.length === 0 && checks.length > 0,
                passed: checks.length - failed.length,
                failed: failed.length,
                checks,
                metrics,
                logs: { errors: page.logs.filter(l => l.level === 'error').map(l => l.text).slice(0, 50), total: page.logs.length },
                seconds: +((env.now() - t0) / 1000).toFixed(1)
            };
        }
    };
}

export async function waitFor(env, pred, ms, what) {
    const end = env.now() + ms;
    while (!pred()) {
        if (env.now() > end) throw new Error(`timeout after ${ms} ms waiting for ${what}`);
        await env.sleep(5);
    }
}

// ---- the fake page --------------------------------------------------------------------------------------

export class Page {
    constructor(env, T) {
        this.env = env;
        this.T = T;
        this.conns = new Map();
        this.nextId = 1;
        this.logs = [];
        this.progress = [];
        this.booted = null;
        this.ready = null;
        this.exits = [];
        this.botsMessages = []; // engine-bots.js / boot.js: {type:'bots', active:false, reason, detail} (+ afterBooted)
        this.lifecycle = new Map();
        this.nextReq = 1;
        this.messagesAfterExit = 0;
        env.onMessage(m => this.onMessage(m));
    }

    onMessage(m) {
        if (this.exits.length && m.type !== 'log') this.messagesAfterExit++;
        switch (m.type) {
            case 'data':
                this.conns.get(m.id)?.push(new Uint8Array(m.data));
                break;
            case 'close':
                this.conns.get(m.id)?.serverClosed();
                break;
            case 'log':
                this.logs.push(m);
                if (m.level === 'error' || m.level === 'warn' || this.env.verbose) this.env.log(`    [worker ${m.level}] ${m.text.split('\n')[0].slice(0, 220)}`);
                break;
            case 'progress':
                this.progress.push(m);
                break;
            case 'booted':
                this.booted = m;
                break;
            case 'ready':
                this.ready = m;
                break;
            case 'lifecycle-done':
            case 'delete-done':
                this.lifecycle.get(m.reqId)?.(m);
                break;
            case 'exit':
                this.exits.push(m);
                break;
            case 'bots':
                this.botsMessages.push({ ...m, afterBooted: !!this.booted });
                break;
        }
    }

    post(msg, transfer) {
        this.env.post(msg, transfer);
    }

    async sendLifecycle(event, ms) {
        const reqId = this.nextReq++;
        const done = new Promise(r => this.lifecycle.set(reqId, r));
        const t = this.env.now();
        this.post({ type: 'lifecycle', reqId, event });
        const res = await Promise.race([done, this.env.sleep(ms).then(() => null)]);
        if (!res) throw new Error(`no lifecycle-done for '${event}' within ${ms} ms`);
        res.ms = this.env.now() - t;
        return res;
    }

    /** Settings › Saved data deleting a character: {type:'delete', reqId, name} -> delete-done {ok, error?}. */
    async sendDelete(name, ms) {
        const reqId = this.nextReq++;
        const done = new Promise(r => this.lifecycle.set(reqId, r));
        this.post({ type: 'delete', reqId, name });
        const res = await Promise.race([done, this.env.sleep(ms).then(() => null)]);
        if (!res) throw new Error(`no delete-done for '${name}' within ${ms} ms`);
        return res;
    }

    connect() {
        const c = new Conn(this, this.nextId++);
        this.conns.set(c.id, c);
        this.post({ type: 'connect', id: c.id });
        return c;
    }

    logsMatching(re, since = 0) {
        return this.logs.slice(since).filter(l => re.test(l.text));
    }
}

class Conn {
    constructor(page, id) {
        this.page = page;
        this.id = id;
        this.chunks = [];
        this.len = 0;
        this.closedByServer = false;
        this.closedByUs = false;
        this.messages = 0;
        this.onData = null;
    }
    push(u8) {
        this.messages++;
        this.chunks.push(u8);
        this.len += u8.length;
        this.onData?.();
    }
    serverClosed() {
        this.closedByServer = true;
    }
    send(bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes.slice() : Uint8Array.from(bytes);
        this.page.post({ type: 'data', id: this.id, data: u8.buffer }, [u8.buffer]);
    }
    close() {
        this.closedByUs = true;
        this.page.post({ type: 'close', id: this.id });
    }
    take(n) {
        const out = new Uint8Array(n);
        let o = 0;
        while (o < n) {
            const c = this.chunks[0];
            const k = Math.min(c.length, n - o);
            out.set(c.subarray(0, k), o);
            o += k;
            if (k === c.length) this.chunks.shift();
            else this.chunks[0] = c.subarray(k);
        }
        this.len -= n;
        return out;
    }
    async read(n, ms = 15000) {
        await waitFor(this.page.env, () => this.len >= n || this.closedByServer, ms, `${n} bytes on connection ${this.id}`);
        if (this.len < n) throw new Error(`connection ${this.id} closed by the engine (wanted ${n} bytes, have ${this.len})`);
        return this.take(n);
    }
}

// ---- the bot (Client.ts:1719-1990 login, then a stream parser like Client.readPacket) -----------------------

export class Bot {
    constructor(env, page, username, password = 'password') {
        this.env = env;
        this.page = page;
        this.fixture = env.fixture;
        this.username = username;
        this.password = password;
        this.conn = null;
        this.packets = [];
        this.messages = [];
        this.stats = new Map();
        this.rebuild = null;
        this.loggedOut = false;
        this.desync = null;
        this.keepaliveTimer = null;
    }

    count(name) {
        return this.packets.filter(p => p.name === name).length;
    }

    async login({ reconnect = false } = {}) {
        const conn = this.page.connect();
        this.conn = conn;
        this.ingame = false;
        const loginServer = Number(toUserhash(this.username) >> 16n) & 0x1f;
        conn.send([14, loginServer]);
        await conn.read(8); // 8 x 0
        const first = (await conn.read(1))[0];
        if (first !== 0) return first;
        const s = await conn.read(8);
        const hi = ((s[0] << 24) | (s[1] << 16) | (s[2] << 8) | s[3]) | 0;
        const lo = ((s[4] << 24) | (s[5] << 16) | (s[6] << 8) | s[7]) | 0;
        const seed = [Math.floor(Math.random() * 99999999), Math.floor(Math.random() * 99999999), hi, lo];

        const rsaIn = new Writer().p1(10).p4(seed[0]).p4(seed[1]).p4(seed[2]).p4(seed[3]).p4(1337).pjstr(this.username).pjstr(this.password).bytes();
        const rsa = rsaEncrypt(rsaIn, BigInt(this.fixture.rsa.n), BigInt(this.fixture.rsa.e));
        const block = new Writer().p1(reconnect ? 18 : 16).p1(rsa.length + 1 + 36 + 1 + 2 + 1).p1(255).p2(274).p1(0);
        for (const crc of this.fixture.archiveCrcs) block.p4(crc);
        block.p1(rsa.length).pdata(rsa);
        this.out = new Isaac(seed);
        this.in = new Isaac(seed.map(x => x + 50));
        conn.send(block.bytes());

        const resp = (await conn.read(1, 30000 * (this.env.slow || 1)))[0];
        if (resp === 2) {
            const [staff, mouse] = await conn.read(2);
            this.staff = staff;
            this.mouse = mouse;
        }
        if (resp === 2 || resp === 15) {
            this.ingame = true;
            this.pendingOp = -1;
            conn.onData = () => this.parse();
            this.parse();
        }
        return resp;
    }

    parse() {
        const conn = this.conn;
        while (this.ingame && !this.desync) {
            if (this.pendingOp === -1) {
                if (conn.len < 1) return;
                this.pendingOp = (conn.take(1)[0] - this.in.nextInt()) & 0xff;
            }
            const op = this.pendingOp;
            const def = this.fixture.serverProt[op];
            if (!def) {
                this.desync = `unknown server opcode ${op}`;
                return;
            }
            let len = def.length;
            if (len === -1) {
                if (conn.len < 1) return;
                if (this.pendingLen === undefined) this.pendingLen = conn.take(1)[0];
                len = this.pendingLen;
            } else if (len === -2) {
                if (conn.len < 2) return;
                if (this.pendingLen === undefined) {
                    const b = conn.take(2);
                    this.pendingLen = (b[0] << 8) | b[1];
                }
                len = this.pendingLen;
            }
            if (conn.len < len) return;
            const payload = conn.take(len);
            this.pendingOp = -1;
            this.pendingLen = undefined;
            this.onPacket(def.name, payload);
        }
    }

    onPacket(name, p) {
        this.packets.push({ name, len: p.length, t: this.env.now() });
        if (name === 'MESSAGE_GAME') {
            let s = '';
            for (const b of p) {
                if (b === 10) break;
                s += String.fromCharCode(b);
            }
            this.messages.push(s);
        } else if (name === 'UPDATE_STAT') {
            this.stats.set(p[0], { xp: ((p[1] << 24) | (p[2] << 16) | (p[3] << 8) | p[4]) | 0, level: p[5] });
        } else if (name === 'REBUILD_NORMAL') {
            this.rebuild = { x: (p[0] << 8) | p[1], z: (p[2] << 8) | p[3] };
        } else if (name === 'LOGOUT') {
            this.loggedOut = true;
        }
    }

    send(protName, payload = []) {
        const prot = this.fixture.clientProt[protName];
        const bytes = [(prot.id + this.out.nextInt()) & 0xff];
        if (prot.length === -1) bytes.push(payload.length);
        else if (prot.length === -2) bytes.push(payload.length >> 8, payload.length & 0xff);
        bytes.push(...payload);
        this.conn.send(bytes);
    }

    cheat(text) {
        this.send('CLIENT_CHEAT', [...text].map(c => c.charCodeAt(0)).concat([10]));
    }

    ifButton(com) {
        this.send('IF_BUTTON', [com >> 8, com & 0xff]);
    }

    startKeepalive(ms = 1000) {
        this.stopKeepalive();
        const loop = async token => {
            while (this.keepaliveToken === token) {
                if (this.ingame && !this.conn.closedByServer && !this.conn.closedByUs) this.send('NO_TIMEOUT');
                await this.env.sleep(ms);
            }
        };
        this.keepaliveToken = {};
        loop(this.keepaliveToken);
    }

    stopKeepalive() {
        this.keepaliveToken = null;
    }

    /** Wait for n more server ticks, counted as PLAYER_INFO packets (one per tick for a connected player). */
    async ticks(n, ms) {
        const target = this.count('PLAYER_INFO') + n;
        await waitFor(this.env, () => this.count('PLAYER_INFO') >= target, ms ?? (2000 + n * 1500) * (this.env.slow || 1), `${n} ticks for ${this.username}`);
    }

    async message(re, ms) {
        const start = this.messages.length;
        await waitFor(this.env, () => this.messages.slice(start).some(m => re.test(m)), ms ?? 10000 * (this.env.slow || 1), `game message ${re}`);
        return this.messages.slice(start).find(m => re.test(m));
    }
}

// ---- scenario ---------------------------------------------------------------------------------------------

async function scenario(env, T, page) {
    const slow = env.slow || 1;
    const S = env.storage;
    const profile = (env.config && env.config.node && env.config.node.profile) || 'main';
    const savePath = name => `players/${profile}/${name}.sav`;
    const putsFor = name => S.puts.filter(p => p.rel === savePath(name));
    let H = null; // engine internals (null in Chrome: protocol-only checks); available once engine.js is loaded
    const lastSave = new Map();
    const player = name => (H ? H.World.getPlayerByUsername(name) : null);

    // -------------------------------------------------------------------------------------------- boot
    T.phase('boot: init -> booted');
    const tInit = env.now();
    page.post({ type: 'init', config: env.config || {} });
    // a page may send 'start' right away: boot.js must queue it until the engine is loaded
    if (env.earlyStart) page.post({ type: 'start' });
    await waitFor(env, () => page.booted || page.exits.length, 120000 * slow, 'booted');
    if (!T.check('booted', !!page.booted, page.booted ? { preloadMs: Math.round(page.booted.preloadMs), evalMs: Math.round(page.booted.evalMs), files: page.booted.files, bytes: page.booted.bytes } : page.exits)) return;
    T.metric('bootMs', Math.round(env.now() - tInit));
    H = env.hooks || null;
    if (H) {
        // record every save() result so a PUT can be compared with exactly what the engine produced
        const orig = H.Player.prototype.save;
        H.Player.prototype.save = function () {
            const r = orig.call(this);
            lastSave.set(this.username, r.slice());
            return r;
        };
    }
    T.metric('booted', { preloadMs: Math.round(page.booted.preloadMs), evalMs: Math.round(page.booted.evalMs), files: page.booted.files, MB: +(page.booted.bytes / 1048576).toFixed(2) });
    T.check('preload progress reported', page.progress.some(p => p.stage === 'preload' && p.fraction === 1) && page.progress.some(p => p.stage === 'import'));
    T.check('world.json override logged', page.logsMatching(/world\.json overrides/).length === 1);

    T.phase('start -> ready');
    const tStart = env.now();
    if (!env.earlyStart) page.post({ type: 'start' });
    await waitFor(env, () => page.ready || page.exits.length, 300000 * slow, 'ready');
    if (!T.check('ready', !!page.ready, page.ready ? { ms: Math.round(page.ready.ms) } : page.exits)) return;
    T.metric('startMs', Math.round(page.ready.ms));
    T.metric('startWallMs', Math.round(env.now() - tStart));
    const stages = page.progress.filter(p => p.stage === 'start').map(p => p.detail);
    T.check('start progress stages', ['Starting the world', 'Loading game configuration', 'Loading scripts', 'Loading the world map'].every(s => stages.includes(s)), stages);
    if (H) {
        const W = H.World;
        T.check('world populated', W.getTotalNpcs() > 7000 && W.gameMap.getTotalLocs() > 80000, { npcs: W.getTotalNpcs(), zones: W.gameMap.getTotalZones(), locs: W.gameMap.getTotalLocs() });
        const v = H.vfs.stats();
        T.check('start-up data released from the vfs', H.testOptions.release === false || v.residentBytes < 1024 * 1024, { residentFiles: v.resident, residentBytes: v.residentBytes });
        T.metric('bzip2AfterStart', H.bzip2.kind);
        T.check('Packet.gjstr is the flat-string version', H.testOptions.flatStrings === false || H.Packet.prototype.gjstr === H.gjstr.flat);
        T.check('no OnDemandThread messages, no DevThread', !page.logsMatching(/DevThread|ondemand/i).length);
    }

    // -------------------------------------------------------------------------------------------- login
    T.phase('login (new player), ticks');
    const name1 = 'enginetest1';
    const bot = new Bot(env, page, name1);
    const tLogin = env.now();
    const r1 = await bot.login();
    T.metric('loginMs', Math.round(env.now() - tLogin));
    T.check('login response 2', r1 === 2, { response: r1, staff: bot.staff, mouse: bot.mouse });
    T.check('staff level byte 2 (min(4, 2)), mouse tracking 1', bot.staff === 2 && bot.mouse === 1);
    T.check('new player: storage GET answered 404', S.gets.some(g => g.rel === savePath(name1) && g.status === 404));
    bot.startKeepalive(1000);
    await bot.ticks(4);
    T.check('packets flow every tick', bot.count('PLAYER_INFO') >= 4 && bot.count('NPC_INFO') >= 4, { packets: bot.packets.length, playerInfo: bot.count('PLAYER_INFO') });
    T.check('server stream parses (no desync)', !bot.desync, bot.desync);
    T.check('each tick arrives as ONE data message per connection', bot.conn.messages <= bot.count('PLAYER_INFO') + 2, { messages: bot.conn.messages, ticks: bot.count('PLAYER_INFO') });
    if (H) {
        const p = player(name1);
        T.check('player is ticked (in playerLoop, remoteAddress 127.0.0.1)', !!p && [...H.World.playerLoop.all()].includes(p) && p.client.remoteAddress === '127.0.0.1');
    }

    T.phase('cheats: move + change a stat');
    bot.cheat('tele 0,50,50,22,18'); // Lumbridge (3222, 3218)
    await bot.ticks(2);
    bot.cheat('getcoord');
    const coord = await bot.message(/^\d+,\d+,\d+,\d+,\d+$/);
    T.check('::tele moved the player', coord === '0,50,50,22,18', coord);
    bot.cheat('setstat attack 50');
    await waitFor(env, () => bot.stats.get(0)?.level === 50, 10000 * slow, 'UPDATE_STAT attack 50');
    T.check('::setstat attack 50 -> UPDATE_STAT', bot.stats.get(0)?.level === 50);

    T.phase("lifecycle 'save'");
    const putsBefore = putsFor(name1).length;
    const ls = await page.sendLifecycle('save', 20000 * slow);
    T.check('lifecycle-done ok', ls.ok === true, { ms: ls.ms, error: ls.error });
    const savePut = putsFor(name1)[putsBefore];
    T.check('save written to storage before lifecycle-done', !!savePut, { puts: putsFor(name1).length - putsBefore });
    if (savePut) {
        const sv = parseSave(savePut.bytes);
        T.check('saved bytes are a valid v7 save at the new position', sv.magic === 0x2004 && sv.version === 7 && sv.crcOk && sv.x === 3222 && sv.z === 3218 && sv.stats[0].level === 50, sv);
        if (H) T.check('PUT body == player.save()', equalBytes(savePut.bytes, lastSave.get(name1)), { put: hex(savePut.bytes), save: lastSave.get(name1) && hex(lastSave.get(name1)) });
    }

    // -------------------------------------------------------------------------------------------- logout
    T.phase('logout via the logout button');
    const logoutCom = env.fixture.logoutComponent;
    const putsBeforeLogout = putsFor(name1).length;
    bot.ifButton(logoutCom);
    await waitFor(env, () => bot.conn.closedByServer, 15000 * slow, 'engine closing the connection after logout');
    T.check('LOGOUT packet then close', bot.loggedOut && bot.conn.closedByServer);
    await waitFor(env, () => putsFor(name1).length > putsBeforeLogout, 10000 * slow, 'logout save');
    const logoutPut = putsFor(name1)[putsBeforeLogout];
    const ls1 = parseSave(logoutPut.bytes);
    T.check('logout save PUT (ArrayBuffer body, valid save)', ls1.magic === 0x2004 && ls1.crcOk && ls1.x === 3222 && ls1.z === 3218 && ls1.stats[0].level === 50, ls1);
    T.check('storage holds exactly the logout save', equalBytes(S.read(savePath(name1)), logoutPut.bytes));
    if (H) {
        T.check('PUT body == player.save() at logout', equalBytes(logoutPut.bytes, lastSave.get(name1)));
        await env.sleep(50);
        T.check('player removed, player_logout acknowledged (logoutRequests empty)', !player(name1) && H.World.logoutRequests.size === 0);
    }
    bot.stopKeepalive();

    // -------------------------------------------------------------------------------------------- re-login
    T.phase('re-login restores the save');
    const bot2 = new Bot(env, page, name1);
    const r2 = await bot2.login();
    T.check('re-login response 2', r2 === 2, r2);
    T.check('save read back from storage (GET 200)', S.gets.filter(g => g.rel === savePath(name1)).some(g => g.status === 200));
    bot2.startKeepalive(1000);
    await bot2.ticks(2);
    T.check('position restored (REBUILD_NORMAL zone 402,402)', bot2.rebuild && bot2.rebuild.x === 402 && bot2.rebuild.z === 402, bot2.rebuild);
    T.check('stats restored (attack 50)', bot2.stats.get(0)?.level === 50, bot2.stats.get(0));
    bot2.cheat('getcoord');
    T.check('::getcoord after re-login', (await bot2.message(/^\d+,\d+,\d+,\d+,\d+$/)) === '0,50,50,22,18');

    // -------------------------------------------------------------------------------------------- reconnect
    T.phase('reconnect (opcode 18) keeps packets flowing');
    // Client.lostCon(): log in again with opcode 18 on a NEW connection, then close the old one
    const connA = bot2.conn;
    const botB = new Bot(env, page, name1);
    const r3 = await botB.login({ reconnect: true });
    T.check('reconnect response 15', r3 === 15, r3);
    bot2.stopKeepalive();
    await waitFor(env, () => connA.closedByServer, 5000 * slow, 'engine closing the replaced connection');
    T.check('engine closed the old connection', connA.closedByServer);
    connA.close(); // what the client does after the reconnect succeeded
    botB.startKeepalive(1000);
    const piBefore = botB.count('PLAYER_INFO');
    await botB.ticks(3);
    T.check('packets keep flowing on the new connection (upstream bug 1: none)', botB.count('PLAYER_INFO') - piBefore >= 3 && !botB.desync, { playerInfo: botB.count('PLAYER_INFO') - piBefore, desync: botB.desync });
    if (H) {
        const p = player(name1);
        T.check('in-world player bound to the new socket', !!p && p.client === H.transport.sockets.get(botB.conn.id) && H.isClientConnected(p));
    }
    botB.cheat('getcoord');
    T.check('commands work after reconnect', (await botB.message(/^\d+,\d+,\d+,\d+,\d+$/)) === '0,50,50,22,18');

    // -------------------------------------------------------------------------------------------- pause/resume
    T.phase('pause -> 60 s freeze -> resume');
    const putsBeforePause = putsFor(name1).length;
    const lp = await page.sendLifecycle('pause', 20000 * slow);
    T.check("lifecycle 'pause' ok after the save was written", lp.ok === true && putsFor(name1).length > putsBeforePause, { ms: lp.ms, puts: putsFor(name1).length - putsBeforePause });
    botB.stopKeepalive(); // the client is frozen too
    const tickAtPause = H ? H.World.currentTick : 0;
    const piAtPause = botB.count('PLAYER_INFO');
    if (env.clock) env.clock.advance(60000);
    await env.sleep(1500);
    T.check('no ticks while paused', botB.count('PLAYER_INFO') === piAtPause && (!H || H.World.currentTick === tickAtPause), { playerInfo: botB.count('PLAYER_INFO') - piAtPause });
    const lr = await page.sendLifecycle('resume', 20000 * slow);
    T.check("lifecycle 'resume' ok", lr.ok === true);
    botB.startKeepalive(1000);
    const tickAtResume = H ? H.World.currentTick : 0;
    const piAtResume = botB.count('PLAYER_INFO');
    await env.sleep(1500);
    const burst = H ? H.World.currentTick - tickAtResume : botB.count('PLAYER_INFO') - piAtResume;
    T.metric('ticksIn1500msAfterResume', burst);
    // a slow runtime can only tick less often; a catch-up burst would be ~100 ticks
    T.check('no catch-up burst after resume (1..4 ticks in 1.5 s)', burst >= 1 && burst <= 4, burst);
    await botB.ticks(3);
    T.check('player not logged out by the freeze, packets flowing', !botB.loggedOut && !botB.conn.closedByServer && (!H || H.isClientConnected(player(name1))));

    if (env.clock && H) {
        T.phase('unannounced 60 s freeze (no pause message): drift clamp');
        const tick0 = H.World.currentTick;
        const clamps0 = H.ticker.tickStats.clamps;
        env.clock.advance(60000); // looks like the worker was frozen: the next timer fires 60 s "late"
        await env.sleep(1500);
        const n = H.World.currentTick - tick0;
        T.check('missed ticks dropped, not replayed (<= 4 ticks in 1.5 s)', n <= 4 && H.ticker.tickStats.clamps > clamps0, { ticks: n, clamps: H.ticker.tickStats.clamps - clamps0 });
        await botB.ticks(2);
        T.check('still connected', H.isClientConnected(player(name1)) && !botB.loggedOut);
    }

    // -------------------------------------------------------------------------------------------- ::reload
    if (H) {
        T.phase('::reload re-fetches released data on demand');
        const refetch0 = H.vfs.stats().refetches;
        botB.cheat('reload');
        const loaded = await botB.message(/^Loaded \d+ scripts\.$/, 60000 * slow);
        T.check('::reload works after the vfs was released', !!loaded, loaded);
        const v = H.vfs.stats();
        T.check('files fetched again via sync XHR, then released again', v.refetches > refetch0 && v.residentBytes < 1024 * 1024, { refetched: v.refetches - refetch0, residentBytes: v.residentBytes });
        await botB.ticks(2);
    }

    // -------------------------------------------------------------------------------------------- vanish
    T.phase('connection dropped without reconnect: idle logout after 50 ticks');
    botB.cheat('speed 20');
    await botB.message(/World speed was changed to 20ms/);
    botB.stopKeepalive();
    const putsBeforeDrop = putsFor(name1).length;
    const tickAtDrop = H ? H.World.currentTick : 0;
    botB.conn.close();
    if (H) {
        await env.sleep(20);
        const p = player(name1);
        T.check('player detached from the closed socket at once (upstream bug 2: kept a dead socket)', !!p && p.client instanceof H.NullClientSocket);
    }
    await waitFor(env, () => putsFor(name1).length > putsBeforeDrop, 30000 * slow, 'idle-logout save');
    if (H) {
        const ticks = H.World.currentTick - tickAtDrop;
        T.check('removed after ~50 ticks (TIMEOUT_NO_CONNECTION), not 100', ticks >= 49 && ticks <= 60, { ticks });
        H.World.tickRate = 600;
    }
    T.check('save written on idle logout', parseSave(putsFor(name1)[putsBeforeDrop].bytes).crcOk);

    // -------------------------------------------------------------------------------------------- write failure
    T.phase('storage write failure: kept in memory, re-login not blocked, retried');
    const name2 = 'enginetest2';
    const bot3 = new Bot(env, page, name2);
    T.check('login', (await bot3.login()) === 2);
    bot3.startKeepalive(500);
    bot3.cheat('speed 600');
    await bot3.ticks(2);
    bot3.cheat('tele 0,50,50,10,10'); // (3210, 3210)
    await bot3.ticks(2);
    S.failPut = true;
    const errorsBefore = page.logs.length;
    bot3.ifButton(logoutCom);
    await waitFor(env, () => bot3.conn.closedByServer, 15000 * slow, 'logout');
    await waitFor(env, () => page.logsMatching(/\[save\] FAILED to write/, errorsBefore).length > 0, 10000 * slow, 'save failure log');
    T.check('failed write reported as an error log', page.logsMatching(/\[save\] FAILED to write players\/.+enginetest2\.sav/, errorsBefore).length === 1);
    T.check('nothing reached storage', !S.read(savePath(name2)));
    bot3.stopKeepalive();
    const bot4 = new Bot(env, page, name2);
    const r4 = await bot4.login();
    T.check('re-login is not blocked by the failed write', r4 === 2, r4);
    bot4.startKeepalive(500);
    await bot4.ticks(2);
    T.check('re-login uses the newer in-memory save', bot4.rebuild && bot4.rebuild.x === 401 && bot4.rebuild.z === 401 && page.logsMatching(/using the newer in-memory save/).length >= 1, bot4.rebuild);
    const lf = await page.sendLifecycle('save', 20000 * slow);
    T.check("lifecycle 'save' reports the failure (ok:false)", lf.ok === false && /enginetest2/.test(lf.error || ''), lf.error);
    S.failPut = false;
    const lok = await page.sendLifecycle('save', 20000 * slow);
    T.check('after storage recovers: save ok, newest bytes stored', lok.ok === true && parseSave(S.read(savePath(name2))).x === 3210, { ok: lok.ok, saved: S.read(savePath(name2)) && parseSave(S.read(savePath(name2))).x });
    bot4.ifButton(logoutCom);
    await waitFor(env, () => bot4.conn.closedByServer, 15000 * slow, 'logout');
    bot4.stopKeepalive();

    // -------------------------------------------------------------------------------------------- Saved data
    T.phase('Settings › Saved data: deleting a character');
    const saved2 = S.read(savePath(name2));
    const bot7 = new Bot(env, page, name2);
    T.check('login', (await bot7.login()) === 2);
    bot7.startKeepalive(500);
    await bot7.ticks(2);
    const deletesBefore = S.deletes.length;
    const dw = await page.sendDelete(name2, 5000 * slow);
    T.check('one in the world is not deleted (error in-world, no DELETE)', dw.ok === false && dw.error === 'in-world' && S.deletes.length === deletesBefore && !!S.read(savePath(name2)), dw);
    bot7.ifButton(logoutCom);
    await waitFor(env, () => bot7.conn.closedByServer, 15000 * slow, 'logout');
    bot7.stopKeepalive();
    const kept = S.read(savePath(name2));
    const d1 = await page.sendDelete(name2, 5000 * slow);
    T.check('logged out: deleted (ok), the save kept as .bak', d1.ok === true && !S.read(savePath(name2)) && equalBytes(S.read(`${savePath(name2)}.bak`), kept) && !!saved2, d1);
    const d2 = await page.sendDelete('Enginetest2', 5000 * slow);
    T.check('a name with no save (any case): ok', d2.ok === true && S.deletes.slice(-1)[0]?.rel === savePath(name2) && S.deletes.slice(-1)[0]?.status === 404, d2);
    // a save the engine could not write (kept in memory, retried) must not bring the character back
    const name5 = 'enginetest5';
    const bot8 = new Bot(env, page, name5);
    T.check('login', (await bot8.login()) === 2);
    bot8.startKeepalive(500);
    await bot8.ticks(2);
    S.failPut = true;
    bot8.ifButton(logoutCom);
    await waitFor(env, () => bot8.conn.closedByServer, 15000 * slow, 'logout');
    bot8.stopKeepalive();
    await waitFor(env, () => !H || H.saves.pending.has(name5), 5000 * slow, 'the failed write');
    S.failPut = false;
    const d3 = await page.sendDelete(name5, 5000 * slow);
    const putsAfter = putsFor(name5).length;
    const lr2 = await page.sendLifecycle('save', 20000 * slow);
    T.check('a save still waiting to be written goes too: nothing written back', d3.ok === true && lr2.ok === true && putsFor(name5).length === putsAfter && !S.read(savePath(name5)) && (!H || !H.saves.pending.has(name5)), { d3, pending: H?.saves.pending.size });
    const getsBefore = S.gets.length;
    const bot9 = new Bot(env, page, name5);
    T.check('logging in with the name again makes a new character (GET 404)', (await bot9.login()) === 2 && S.gets.slice(getsBefore).some(g => g.rel === savePath(name5) && g.status === 404));
    bot9.startKeepalive(500);
    await bot9.ticks(2);
    bot9.ifButton(logoutCom);
    await waitFor(env, () => bot9.conn.closedByServer, 15000 * slow, 'logout');
    bot9.stopKeepalive();
    S.failDelete = true;
    const d4 = await page.sendDelete(name5, 5000 * slow);
    S.failDelete = false;
    T.check('a DELETE that fails is reported, the save stays', d4.ok === false && /HTTP 500/.test(d4.error ?? '') && !!S.read(savePath(name5)), d4);

    T.phase('storage read failure refuses the login (no fresh character over a real save)');
    S.failGet = true;
    const bot5 = new Bot(env, page, 'enginetest3');
    const r5 = await bot5.login();
    S.failGet = false;
    T.check('login answered 8 (login server offline)', r5 === 8, r5);
    await env.sleep(100);
    T.check('no save written for it', putsFor('enginetest3').length === 0);

    // -------------------------------------------------------------------------------------------- crash
    if (H) {
        T.phase('crash in a tick: saves attempted, exactly one exit');
        const name4 = 'enginetest4';
        const bot6 = new Bot(env, page, name4);
        T.check('login', (await bot6.login()) === 2);
        bot6.startKeepalive(500);
        await bot6.ticks(2);
        const putsBeforeCrash = putsFor(name4).length;
        H.World.processNpcEventQueue = () => {
            throw new Error('injected tick failure (test)');
        };
        await waitFor(env, () => page.exits.length > 0, 10000 * slow, 'exit message');
        await env.sleep(1500);
        bot6.stopKeepalive();
        T.check('exactly one {type:exit, code:1}', page.exits.length === 1 && page.exits[0].code === 1, page.exits);
        T.check("connected player's save written before exit", putsFor(name4).length > putsBeforeCrash && parseSave(putsFor(name4).slice(-1)[0].bytes).crcOk);
        T.check('connection closed, nothing but logs after exit', bot6.conn.closedByServer && page.messagesAfterExit === 0, { messagesAfterExit: page.messagesAfterExit });
        T.check('ticking stopped', H.ticker.tickerState() === 'stopped');
        const le = await page.sendLifecycle('save', 5000);
        T.check('lifecycle after exit answers ok:false', le.ok === false);
    }

    if (H) {
        T.metric('ticks', H.ticker.tickSummary());
        T.metric('saves', { writes: H.saves.writes, failures: H.saves.failures });
        // what the engine actually touched in the vfs: the build must stage exactly this
        T.metric('vfsAccessed', H.vfs.accessedPaths().filter(p => H.vfs.store.urls.has(p) || p === '/engine/data/config/world.json'));
    }
}

// ---- a normal player (Settings › World › Jmod Off sends init.config.staffModLevel = 0; vm --player) --------------
export async function runPlayerSession(env) {
    const T = createRunner(env);
    const page = new Page(env, T);
    try {
        await playerScenario(env, T, page);
    } catch (e) {
        T.fail('session aborted', e && e.stack ? e.stack : String(e));
    }
    return T.result(page);
}

async function playerScenario(env, T, page) {
    const slow = env.slow || 1;
    T.phase('boot + start with staffModLevel 0');
    page.post({ type: 'init', config: env.config || {} });
    await waitFor(env, () => page.booted || page.exits.length, 120000 * slow, 'booted');
    if (!T.check('booted', !!page.booted, page.exits)) return;
    page.post({ type: 'start' });
    await waitFor(env, () => page.ready || page.exits.length, 300000 * slow, 'ready');
    if (!T.check('ready', !!page.ready, page.exits)) return;
    T.check('the start-up line says staffModLevel=0', page.logsMatching(/production=false, staffModLevel=0,/).length === 1);
    const H = env.hooks || null;

    T.phase('login: a normal player');
    const name = 'playertest1';
    const bot = new Bot(env, page, name);
    const r = await bot.login();
    T.check('login response 2', r === 2, { response: r, staff: bot.staff });
    T.check('staff level byte 0 (no crown in chat, no moderator report options)', bot.staff === 0);
    if (H) T.check('player.staffModLevel 0', H.World.getPlayerByUsername(name)?.staffModLevel === 0);
    bot.startKeepalive(1000);
    await bot.ticks(2);
    const before = H ? { x: H.World.getPlayerByUsername(name).x, z: H.World.getPlayerByUsername(name).z } : null;

    T.phase(':: commands do nothing');
    bot.cheat('tele 0,50,50,22,18');
    bot.cheat('setstat attack 50');
    bot.cheat('getcoord');
    bot.cheat('~debugproc');
    await bot.ticks(4); // (client packets are handled at the start of a tick)
    T.check('::getcoord answered nothing', !bot.messages.some(m => /^\d+,\d+,\d+,\d+,\d+$/.test(m)), bot.messages);
    T.check('::setstat did not change attack', bot.stats.get(0)?.level !== 50, bot.stats.get(0));
    if (H) {
        const p = H.World.getPlayerByUsername(name);
        T.check('::tele did not move the player', p.x === before.x && p.z === before.z, { before, after: { x: p.x, z: p.z } });
    }
    T.check('server stream parses (no desync)', !bot.desync, bot.desync);
    T.check('no errors logged', page.logs.filter(l => l.level === 'error').length === 0, page.logs.filter(l => l.level === 'error').map(l => l.text));
    bot.stopKeepalive();
}

// ---- soak: one connected player, sped-up ticks; heap and tick-time samples (vm/jsc --soak=N) -------------------
export async function runSoak(env, ticks, sampleHeap) {
    const page = new Page(env, createRunner(env));
    page.post({ type: 'init', config: env.config || {} });
    await waitFor(env, () => page.booted, 120000 * (env.slow || 1), 'booted');
    page.post({ type: 'start' });
    await waitFor(env, () => page.ready, 300000 * (env.slow || 1), 'ready');
    const H = env.hooks;
    const bot = new Bot(env, page, 'soaktest');
    if ((await bot.login()) !== 2) throw new Error('soak login failed');
    bot.startKeepalive(50);
    bot.cheat('speed 20');
    await bot.message(/World speed was changed/);
    const samples = [];
    const t0 = H.World.currentTick;
    let next = t0;
    while (H.World.currentTick < t0 + ticks) {
        if (H.World.currentTick >= next) {
            next += Math.max(1, Math.floor(ticks / 5));
            samples.push({ tick: H.World.currentTick - t0, heapMB: sampleHeap(), packets: bot.packets.length, connected: H.isClientConnected(H.World.getPlayerByUsername('soaktest')) });
            bot.packets.length = 0; // the bot's own bookkeeping must not look like an engine leak
            env.log(`  soak ${JSON.stringify(samples[samples.length - 1])}`);
        }
        await env.sleep(20);
    }
    samples.push({ tick: H.World.currentTick - t0, heapMB: sampleHeap(), connected: H.isClientConnected(H.World.getPlayerByUsername('soaktest')) });
    bot.stopKeepalive();
    return { samples, ticks: H.ticker.tickSummary(), sockets: H.transport.connectionCount(), desync: bot.desync };
}
