// Online mode, native side (ARCHITECTURE.md §3.1 routes, §7.3-7.5 messages): the phases test.js runs when drive.mjs
// --online starts it at 'online'. They play against drive.mjs's stand-in server (online-stub.mjs: a few cases of each
// route and a WebSocket that echoes and obeys commands), an address where nothing listens, and, when the run has one,
// a local Engine-TS (ENGINE_URL), never an outside server. online.json in the test bundle says where they are.
//
// Phases (each server switch is a `server use` and a native reload): online (the page offline: probes, the Add server
// box, accounts and the Keychain, the Remember box) → online-stub (the proxy routes, the socket bridge) → online-crash
// (WebContent killed while a socket is open) → online-reload (a reload closes the page's sockets) → online-down →
// online-slow → online-engine (with ENGINE_URL) → online-offline (back offline, server delete) → done.
//
// The Android app runs the same phases (android/test/drive.mjs --online; android/test/PARITY.md): its User-Agent names
// Android, a PUT's bytes travel in X-LC-Body (test.js writeInit), and the driver reaches the stub and the engine through
// `adb reverse` (the address where nothing listens is the emulator's own, so it refuses as the Mac's does).
const STUB_N = '9'.repeat(40) + '1234567';  // online-stub.mjs STUB_KEY
// A password the tests store and fill; drive.mjs fails the run if it shows up in the console log (nor may the bytes of the
// 5,000-byte message, which carry PAYLOAD_MARK).
const PASSWORD = 'Pw4OnlineT3st';
const PAYLOAD_MARK = 'LCPAYLOADMARK';
const CAPTION = (mode) => `2004Scape · November 2004 · ${mode}`;

export async function runOnline(phase, t) {
    const { check, info, marker, debug, native, sleep, until, finish, writeInit } = t;
    const ANDROID = window.LostCityNative?.platform === 'android';
    // a PUT as native takes it (Android: X-LC-Body, test.js writeInit; iOS: the body)
    const putInit = async (body) => ({ method: 'PUT', ...(await writeInit(body)) });
    const cfg = await fetch('online.json').then((r) => r.json());
    const SERVERS = [
        { id: 's-stub', name: 'Stub', url: cfg.stub, nodeId: 7, members: false, rsa: null, added: 1 },
        { id: 's-down', name: 'Down', url: cfg.down, nodeId: 10, members: true, rsa: null, added: 2 },
        { id: 's-slow', name: 'Slow', url: `${cfg.stub}/slow`, nodeId: 10, members: true, rsa: null, added: 3 },
        ...(cfg.engine ? [{ id: 's-engine', name: 'Engine', url: cfg.engine, nodeId: 10, members: true, rsa: null, added: 4 }] : []),
    ];

    // ---- what native calls on the page
    const socketCalls = [];
    const socketEvents = [];
    const saved = [];
    // a map of server ids as JSON with the ids sorted (native's dictionary has no order)
    const byServer = (map) => JSON.stringify(map && Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))));
    const logins = [];
    const answers = [];
    const remembers = [];
    window.LostCityHost.socket = { events(list) { socketCalls.push(list.length); socketEvents.push(...list); } };
    window.LostCityHost.accounts = { saved(map) { saved.push(map); }, login(name, password) { logins.push([name, password]); } };
    window.LostCityHost.servers = { answer(value) { answers.push(value); } };
    window.LostCityHost.keyboard.remember = (on) => { remembers.push(on); };

    const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
    const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    const ascii = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));
    const eventsOf = (id) => socketEvents.filter((e) => e.id === id);
    const waitFor = (id, event, ms = 12000) => until(() => eventsOf(id).some((e) => e.event === event), ms);
    const open = (id, purpose = 'game') => native({ type: 'socket', action: 'open', id, purpose });
    const send = (id, bytes) => native({ type: 'socket', action: 'send', id, data: b64(bytes) });
    const command = (id, text) => send(id, Uint8Array.from([0xff, ...ascii(text)]));
    const close = (id) => native({ type: 'socket', action: 'close', id });
    let nextId = 100;
    // the stub's own record, over a socket of its own (a page cannot fetch the stub: the proxy is the only way in)
    async function stubLog() {
        const id = nextId++;
        open(id, 'test');
        if (!await waitFor(id, 'open')) return null;
        command(id, 'log');
        await until(() => eventsOf(id).some((e) => e.event === 'message'), 5000);
        const message = eventsOf(id).find((e) => e.event === 'message');
        close(id);
        return message ? JSON.parse(new TextDecoder().decode(unb64(message.data))) : null;
    }
    const fetchText = async (path, init) => {
        const r = await fetch(path, init);
        return { status: r.status, body: new Uint8Array(await r.arrayBuffer()), type: r.headers.get('content-type') ?? '', cc: r.headers.get('cache-control') };
    };
    const text = (bytes) => new TextDecoder().decode(bytes);
    const probe = async (url) => {
        const started = performance.now();
        const r = await fetch(`server-probe?url=${encodeURIComponent(url)}`);
        return { status: r.status, ms: performance.now() - started, json: r.status === 200 ? await r.json() : null };
    };
    const use = (id, next) => {
        localStorage.lcPhase = next;
        native({ type: 'server', action: 'use', id });
    };
    async function state() { return await debug('online-state'); }

    info(`online phase ${phase}: stub ${cfg.stub}, down ${cfg.down}, engine ${cfg.engine ?? 'none'}`);

    if (phase === 'online') {
        // ---- offline page: document-start state, the bridge without a server, probes, the box, accounts, Remember
        // (Keychain items outlive the app on the simulator: what an earlier run left is deleted first, before any check)
        for (const server of SERVERS) native({ type: 'server', action: 'delete', id: server.id });
        await sleep(800);
        saved.length = 0;
        check('online: LostCityNative.savedPasswords is {} with nothing stored', JSON.stringify(window.LostCityNative?.savedPasswords) === '{}', JSON.stringify(window.LostCityNative?.savedPasswords));
        let s = await state();
        check('online: offline page: no server, the cover says offline', s?.server === null && s.caption === CAPTION('offline'), JSON.stringify(s));
        check(`online: User-Agent names the app and ${ANDROID ? 'Android' : 'iOS'}`, (ANDROID ? /^2004Scape\/\S+ \(Android \d+(\.\d+)*\)$/ : /^2004Scape\/\S+ \(iOS \d+\.\d+(\.\d+)?\)$/).test(s?.userAgent ?? ''), s?.userAgent);

        open(1);
        await waitFor(1, 'close', 3000);
        check('socket: open offline → error "no server", then close 1006', JSON.stringify(eventsOf(1).map((e) => [e.event, e.reason, e.code ?? null])) === '[["error","no server",null],["close","no server",1006]]', JSON.stringify(eventsOf(1)));

        // probes (every mode)
        let r = await fetch('server-probe');
        check('probe: no url → 400', r.status === 400, String(r.status));
        let p = await probe(` ${cfg.stub.replace('http://', '')}/ `);
        check('probe: the stub: ok, normalized url, world 7 free from rs2.cgi, its key from client.js (single quotes), no notes',
            p.json?.ok === true && p.json.crc === true && p.json.url === cfg.stub && p.json.nodeId === 7 && p.json.members === false &&
            p.json.rsa?.n === STUB_N && p.json.rsa?.e === '65537' && p.json.notes.length === 0 && !('error' in p.json), JSON.stringify(p.json));
        p = await probe(`ws://${cfg.stub.replace('http://', '')}/norsa`);
        check('probe: no rs2.cgi or client.js: ok with world 10, members, the built-in key, and both notes',
            p.json?.ok === true && p.json.url === `${cfg.stub}/norsa` && p.json.nodeId === 10 && p.json.members === true && p.json.rsa === null &&
            JSON.stringify(p.json.notes) === JSON.stringify(['No world settings found: world 10, members.', 'No login key found: the built-in key.']), JSON.stringify(p.json));
        for (const [prefix, error] of [['short', 'not a 2004scape server'], ['badtrailer', 'not a 2004scape server'], ['http500', 'http 500'], ['nothing-here', 'not a 2004scape server']]) {
            p = await probe(`${cfg.stub}/${prefix}`);
            check(`probe: /${prefix}/crc → not ok, "${error}"`, p.json?.ok === false && p.json.crc === false && p.json.error === error && p.json.notes.length === 0, JSON.stringify(p.json));
        }
        p = await probe(cfg.down);
        check('probe: nothing listening → "unreachable", quickly', p.json?.ok === false && p.json.error === 'unreachable' && p.ms < 5000, `${JSON.stringify(p.json)} ${Math.round(p.ms)} ms`);
        p = await probe(`${cfg.stub}/slow`);
        check('probe: a server that answers after 12 s → "timed out" after 10 s', p.json?.error === 'timed out' && p.ms > 9500 && p.ms < 12500, `${JSON.stringify(p.json)} ${Math.round(p.ms)} ms`);
        const port = cfg.down.split(':').at(-1);
        const vectors = [
            [`ws://127.0.0.1:${port}/`, `http://127.0.0.1:${port}`], [`wss://127.0.0.1:443/Game/`, 'https://127.0.0.1/Game'],
            [`http://[::1]:${port}`, `http://[::1]:${port}`], [`http://127.0.0.1:${port}/rs2.cgi?x=1#y`, `http://127.0.0.1:${port}/rs2.cgi`],
            [`HTTP://127.0.0.1:80`, 'http://127.0.0.1'], [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
            ['ftp://h', null], ['http://u:p@h', null], ['http://h:0', null], ['http://h:70000', null], ['', null], ['http://', null],
        ];
        const wrong = [];
        for (const [typed, url] of vectors) {
            p = await probe(typed);
            if (p.json?.url !== url || (url === null && p.json?.error !== 'invalid address')) wrong.push(`${typed} → ${JSON.stringify(p.json)}`);
        }
        check('probe: URL normalization (contract vectors on loopback; the invalid ones say "invalid address")', wrong.length === 0, wrong.join(' | '));
        // every shared vector (web/test/online/serverurl-vectors.json, as the page's and the JVM tests run them) through
        // native's own rules, with no network (the debug hook)
        const shared = cfg.normalize ?? [];
        const normalized = await debug('url-normalize', { inputs: shared.map(([typed]) => typed) });
        const off = Array.isArray(normalized)
            ? shared.map(([typed, url], i) => [typed, url, normalized[i]]).filter(([, url, got]) => got !== url).map(([typed, url, got]) => `${JSON.stringify(typed)} → ${JSON.stringify(got)}, not ${JSON.stringify(url)}`)
            : [JSON.stringify(normalized)];
        check(`URL normalization: native's rules give every shared vector's answer (${shared.length} of serverurl-vectors.json)`, shared.length >= 30 && off.length === 0, off.join(' | '));
        if (cfg.engine) {
            p = await probe(cfg.engine);
            check(`probe: the local Engine-TS: ok, world ${cfg.engineNodeId} ${cfg.engineMembers ? 'members' : 'free'}, the repo key from its minified client.js`,
                p.json?.ok === true && p.json.nodeId === cfg.engineNodeId && p.json.members === cfg.engineMembers &&
                p.json.rsa?.n?.startsWith('71629005') && p.json.rsa?.e?.startsWith('58778699') && p.json.notes.length === 0, JSON.stringify(p.json));
        } else {
            info('probe: no ENGINE_URL, the local Engine-TS probe is skipped');
        }

        // the Add / Edit server box
        native({ type: 'server', action: 'ask', title: 'Add server', address: '', name: '' });
        await sleep(1200);
        marker('SHOT server-alert');
        await sleep(1500);
        let box = await debug('server-alert', { address: '  127.0.0.1:47631 ', name: ' Stub ', button: 'ok' });
        await until(() => answers.length === 1, 3000);
        check('server box: ask opens "Add server" with Address and Name (placeholders), empty',
            box?.shown === true && box.title === 'Add server' && box.address === '' && box.name === '' &&
            JSON.stringify(box.placeholders) === JSON.stringify(['192.168.1.20 or my-mac.local:8888', 'Optional']), JSON.stringify(box));
        check('server box: OK answers servers.answer({address, name}) trimmed', answers[0]?.address === '127.0.0.1:47631' && answers[0]?.name === 'Stub' && Object.keys(answers[0]).length === 2, JSON.stringify(answers));
        native({ type: 'server', action: 'ask', title: 'Edit server', address: 'my-mac.local:8888', name: 'Mac' });
        await sleep(1200);
        box = await debug('server-alert', { button: 'cancel' });
        await until(() => answers.length === 2, 3000);
        check('server box: prefilled for Edit; Cancel answers null', box?.title === 'Edit server' && box.address === 'my-mac.local:8888' && box.name === 'Mac' && answers[1] === null, JSON.stringify({ box, answers }));
        let kb = await debug('keyboard-state');
        check('server box: the keyboard bridge is first responder again', kb?.isFirstResponder === true, JSON.stringify({ isFirstResponder: kb?.isFirstResponder }));
        check('server box: no box → shown false', (await debug('server-alert'))?.shown === false);

        // accounts and the Keychain
        native({ type: 'settings', values: { servers: SERVERS } });
        await sleep(300);
        native({ type: 'account', action: 'save-password', server: 's-nope', name: 'Tester', password: PASSWORD });
        native({ type: 'account', action: 'save-password', server: 's-stub', name: 'Tester', password: 'x'.repeat(21) });
        native({ type: 'account', action: 'save-password', server: 's-stub', name: 'Thirteen_char', password: PASSWORD });
        await sleep(800);
        check('accounts: save-password refused for an unknown server, a 21-character password, a 13-character name (no saved call)', saved.length === 0, JSON.stringify(saved));
        native({ type: 'account', action: 'save-password', server: 's-stub', name: 'Tester', password: PASSWORD });
        await until(() => saved.length === 1, 3000);
        check('accounts: save-password → accounts.saved({s-stub: [tester]}) (lower-case, names only)', JSON.stringify(saved[0]) === '{"s-stub":["tester"]}', JSON.stringify(saved));
        native({ type: 'account', action: 'login', server: 's-stub', name: 'TESTER' });
        await until(() => logins.length === 1, 3000);
        check('accounts: login → accounts.login(name as sent, the stored password)', logins[0]?.[0] === 'TESTER' && logins[0]?.[1] === PASSWORD, `${logins[0]?.[0]} ${logins[0]?.[1] === PASSWORD ? 'the password' : 'not the password'}`);
        native({ type: 'account', action: 'login', server: 's-stub', name: 'Nobody' });
        await until(() => logins.length === 2, 3000);
        check('accounts: login without a stored password → accounts.login(name, null)', logins[1]?.[0] === 'Nobody' && logins[1]?.[1] === null, JSON.stringify(logins[1]));
        native({ type: 'account', action: 'forget-password', server: 's-stub', name: 'tester' });
        await until(() => saved.length === 2, 3000);
        native({ type: 'account', action: 'login', server: 's-stub', name: 'Tester' });
        await until(() => logins.length === 3, 3000);
        check('accounts: forget-password → accounts.saved({}), and login then answers null', JSON.stringify(saved[1]) === '{}' && logins[2]?.[1] === null, JSON.stringify({ saved: saved[1], login: logins[2] }));
        native({ type: 'account', action: 'save-password', server: 's-stub', name: 'Tester', password: PASSWORD });
        native({ type: 'account', action: 'save-password', server: 's-down', name: 'Other', password: PASSWORD });
        await until(() => saved.length === 4, 3000);
        check('accounts: two servers', byServer(saved[3]) === '{"s-down":["other"],"s-stub":["tester"]}', JSON.stringify(saved[3]));
        if (!ANDROID) {
            // Keychain items outlive the app: at launch the passwords of servers the settings do not have (after a reinstall,
            // the settings are gone) are forgotten, and only those (the same sweep, run by the debug hook)
            native({ type: 'settings', values: { servers: SERVERS.filter((server) => server.id !== 's-down') } });
            await sleep(300);
            const purged = await debug('purge-passwords');
            native({ type: 'account', action: 'login', server: 's-stub', name: 'Tester' });
            await until(() => logins.length === 4, 3000);
            native({ type: 'settings', values: { servers: SERVERS } });
            await sleep(300);
            native({ type: 'account', action: 'login', server: 's-down', name: 'Other' });
            await until(() => logins.length === 5, 3000);
            check('accounts (iOS): the launch\'s sweep forgets the passwords of a server not in the settings, and only those', purged === 1 && logins[3]?.[1] === PASSWORD && logins[4]?.[1] === null, JSON.stringify({ purged, kept: logins[3]?.[1] === PASSWORD, gone: logins[4]?.[1] === null }));
            native({ type: 'account', action: 'save-password', server: 's-down', name: 'Other', password: PASSWORD });
            await until(() => saved.length === 5, 3000);
        }

        // the Remember box
        native({ type: 'keyboard', action: 'show', kind: 'login-pass', prompt: 'Password', text: '', secure: true, numeric: false, charset: 'game', maxLength: 20, remember: false });
        await sleep(1500);
        kb = await debug('keyboard-state');
        const layout = kb?.rememberLayout;
        const right = (rect) => rect[0] + rect[2];
        check('remember: show login-pass with remember:false → the box, not ticked, left of Log in, clear of the input line',
            kb?.remember === false && layout && right(layout.remember) <= layout.submit[0] && right(layout.field) <= layout.remember[0] && layout.remember[2] > 0,
            JSON.stringify({ remember: kb?.remember, layout }));
        marker('SHOT keyboard-remember-off');
        await sleep(800);
        const tapped = await debug('remember-tap');
        await until(() => remembers.length === 1, 2000);
        kb = await debug('keyboard-state');
        check('remember: a tap ticks it and calls keyboard.remember(true)', tapped === true && remembers[0] === true && kb?.remember === true, JSON.stringify({ tapped, remembers, remember: kb?.remember }));
        marker('SHOT keyboard-remember-on');
        await sleep(800);
        native({ type: 'keyboard', action: 'update', text: 'abc' });
        await sleep(300);
        check('remember: an update without remember leaves it', (await debug('keyboard-state'))?.remember === true);
        native({ type: 'keyboard', action: 'update', remember: false });
        await sleep(300);
        check('remember: the page\'s next remember wins', (await debug('keyboard-state'))?.remember === false);
        native({ type: 'keyboard', action: 'show', kind: 'login-user', prompt: 'Username', text: '', secure: false, numeric: false, remember: true });
        await sleep(600);
        kb = await debug('keyboard-state');
        check('remember: no box for the username (login-user)', kb?.remember === null && (await debug('remember-tap')) === null, JSON.stringify(kb?.remember));
        native({ type: 'keyboard', action: 'show', kind: 'login-pass', prompt: 'Password', text: '', secure: true, numeric: false });
        await sleep(600);
        check('remember: no box for a password without remember (offline)', (await debug('keyboard-state'))?.remember === null);
        native({ type: 'keyboard', action: 'hide' });
        await sleep(600);

        // server use: an unknown id is ignored; a known one stores the choice and reloads
        window.__lcSamePage = true;
        native({ type: 'server', action: 'use', id: 's-nope' });
        await sleep(1500);
        check('server use: an id not in settings.servers is ignored (no reload)', window.__lcSamePage === true && (await debug('settings'))?.server === undefined);
        use('s-stub', 'online-stub');
        await sleep(8000);
        check('server use: reloads the page', false, 'still here 8 s later');
        return;
    }

    if (phase === 'online-stub') {
        check('online: savedPasswords at document start after a reload', byServer(window.LostCityNative?.savedPasswords) === '{"s-down":["other"],"s-stub":["tester"]}', JSON.stringify(window.LostCityNative?.savedPasswords));
        check('server use: settings.server stored', window.LostCityNative?.settings?.server === 's-stub');
        const s = await state();
        check('online: this page plays on the stub; the cover said online', s?.server === 's-stub' && s.url === cfg.stub && s.caption === CAPTION('online'), JSON.stringify(s));
        const crcs = cfg.stubCrcs;

        // ---- the proxy
        let r = await fetchText('crc');
        const table = r.body;
        check('proxy: /crc → the server\'s 40 bytes, no-store', r.status === 200 && table.length === 40 && r.cc === 'no-store' && r.type.startsWith('application/octet-stream'), JSON.stringify({ status: r.status, length: table.length, cc: r.cc }));
        r = await fetchText('crc?x=12345');
        check('proxy: /crc with a suffix → the same', r.status === 200 && r.body.length === 40);
        let log = await stubLog();
        const archiveGets = (name) => (log?.requests ?? []).filter((q) => q.path.startsWith(`/${name}`)).length;
        const bundleTitle = await fetchText('title410306098');
        check('proxy: the bundle\'s archive (same name, same CRC) is served without asking the server', bundleTitle.status === 200 && bundleTitle.body.length > 0 && archiveGets('title') === 0, `${bundleTitle.status} ${archiveGets('title')}`);
        r = await fetchText(`config${crcs.config}`);
        log = await stubLog();
        check('proxy: an archive the bundle does not have → fetched from the server, checked', r.status === 200 && text(r.body).startsWith('config archive served by the online stub') && archiveGets('config') === 1, `${r.status} ${archiveGets('config')}`);
        r = await fetchText(`config${crcs.config}`);
        log = await stubLog();
        check('proxy: … and cached: the second time the server is not asked', r.status === 200 && text(r.body).startsWith('config archive') && archiveGets('config') === 1, `${r.status} ${archiveGets('config')}`);
        check('proxy: the server got the app\'s User-Agent, no Origin, no cookies', log?.requests.every((q) => q.ua?.startsWith('2004Scape/') && q.origin === null && q.cookie === null), JSON.stringify(log?.requests.slice(0, 3)));
        const cached = await debug('online-cache');
        check('proxy: the cache holds it under s-stub/', Array.isArray(cached) && cached.includes(`s-stub/config${crcs.config}`), JSON.stringify(cached));
        await debug('online-cache', { op: 'corrupt', path: `s-stub/config${crcs.config}` });
        r = await fetchText(`config${crcs.config}`);
        log = await stubLog();
        check('proxy: a cached copy that fails its CRC is fetched again', r.status === 200 && text(r.body).startsWith('config archive') && archiveGets('config') === 2, `${r.status} ${archiveGets('config')}`);
        r = await fetchText(`media${crcs.media}`);
        check('proxy: bytes that do not have the CRC of their name → 502 "checksum mismatch" (not cached)', r.status === 502 && text(r.body) === 'checksum mismatch', `${r.status} ${text(r.body)}`);
        r = await fetchText(`textures${crcs.textures}`);
        check('proxy: an archive the server does not have (404) → 502 "not a 2004scape server"', r.status === 502 && text(r.body) === 'not a 2004scape server', `${r.status} ${text(r.body)}`);
        r = await fetchText(`wordenc${crcs.wordenc}`);
        check('proxy: a server error → 502 "http 500"', r.status === 502 && text(r.body) === 'http 500', `${r.status} ${text(r.body)}`);
        const t0 = performance.now();
        r = await fetchText(`sounds${crcs.sounds}`);
        check('proxy: a slow archive (2 s) waits and arrives', r.status === 200 && text(r.body) === 'sounds archive served after a delay' && performance.now() - t0 > 1800, `${r.status} ${Math.round(performance.now() - t0)} ms`);
        check('proxy: a file that is no archive stays a bundle file', (await fetch('t/a.txt')).status === 200 && (await fetch('nothing-here')).status === 404);

        // OnDemand cache
        r = await fetchText('ondemand/1/5');
        check('ondemand: GET of a file not cached → 404', r.status === 404, String(r.status));
        const od = Uint8Array.from({ length: 777 }, (_, i) => (i * 7) & 255);
        r = await fetchText('ondemand/1/5', await putInit(od));
        const back = await fetchText('ondemand/1/5');
        check('ondemand: PUT → 204, GET → the same bytes', r.status === 204 && back.status === 200 && back.body.length === 777 && back.body.every((b, i) => b === od[i]), `${r.status} ${back.status} ${back.body.length}`);
        const bad = [];
        for (const path of ['ondemand/4/1', 'ondemand/1/01', 'ondemand/1/65536', 'ondemand/1/-1', 'ondemand/1/a', 'ondemand/1', 'ondemand/1/2/3', 'ondemand/01/2']) {
            const status = (await fetch(path)).status;
            if (status !== 400) bad.push(`${path} ${status}`);
        }
        check('ondemand: archive 0-3 and file 0-65535 in plain decimal only, else 400', bad.length === 0, bad.join(', '));
        check('ondemand: PUT with no body → 400', (await fetch('ondemand/2/9', await putInit(new Uint8Array(0)))).status === 400);
        // (Android: the count in X-LC-Length says too large before anything is decoded, as for the saves)
        const over = 4 * 1024 * 1024 + 1;
        const tooLarge = ANDROID ? { method: 'PUT', headers: { 'X-LC-Body': 'AA', 'X-LC-Length': String(over) } } : { method: 'PUT', body: new Uint8Array(over) };
        check('ondemand: PUT over 4 MiB → 413', (await fetch('ondemand/2/9', tooLarge)).status === 413);
        check('ondemand: file 0 and 65535 are fine', (await fetch('ondemand/0/0', await putInit(Uint8Array.of(1)))).status === 204 && (await fetch('ondemand/3/65535', await putInit(Uint8Array.of(2)))).status === 204);
        check('ondemand: DELETE → 405', (await fetch('ondemand/1/5', { method: 'DELETE' })).status === 405);

        // ---- the socket bridge
        open(10);
        const queued = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)];
        for (const bytes of queued) send(10, bytes);  // before the open event: queued, in order
        await waitFor(10, 'open');
        await until(() => eventsOf(10).filter((e) => e.event === 'message').length >= 2, 5000);
        let messages = eventsOf(10).filter((e) => e.event === 'message').map((e) => [...unb64(e.data)].join(','));
        check('socket: open → open; sends made before it are queued and go in order', eventsOf(10)[0]?.event === 'open' && JSON.stringify(messages) === '["1,2,3","4,5"]', JSON.stringify(eventsOf(10)));
        // a 5,000-byte message (the client's largest is under 4,900)
        const big = new Uint8Array(5000);
        big.set(ascii(PAYLOAD_MARK));
        for (let i = PAYLOAD_MARK.length; i < big.length; i++) big[i] = (i * 13 + 7) & 255;
        send(10, big);
        await until(() => eventsOf(10).filter((e) => e.event === 'message').length >= 3, 5000);
        const echoed = unb64(eventsOf(10).filter((e) => e.event === 'message')[2]?.data ?? '');
        check('socket: a 5,000-byte binary message round trip, byte for byte', echoed.length === 5000 && echoed.every((b, i) => b === big[i]), `length ${echoed.length}`);
        // order: 60 messages sent at once come back in order
        const before = eventsOf(10).length;
        for (let i = 0; i < 60; i++) send(10, Uint8Array.of(0xa0, i));
        await until(() => eventsOf(10).length >= before + 60, 8000);
        const order = eventsOf(10).slice(before).map((e) => unb64(e.data)[1]);
        check('socket: 60 sends in a row arrive and come back in order', order.length === 60 && order.every((v, i) => v === i), order.join(','));
        // batching: a burst of 50 in one TCP write arrives in a few page calls
        const callsBefore = socketCalls.length;
        const eventsBefore = eventsOf(10).length;
        command(10, 'burst 50');
        await until(() => eventsOf(10).length >= eventsBefore + 50, 8000);
        const burst = eventsOf(10).slice(eventsBefore).map((e) => unb64(e.data));
        const calls = socketCalls.length - callsBefore;
        check('socket: 50 messages received together come in a few socket.events calls (batched per turn), in order',
            burst.length === 50 && burst.every((m, i) => m[0] === 0xb0 && ((m[1] << 8) | m[2]) === i) && calls < 25, `${burst.length} messages in ${calls} calls`);
        info(`socket: batching: 50 messages in ${calls} socket.events calls`);
        // the upgrade request as the server saw it
        const hBefore = eventsOf(10).length;
        command(10, 'headers');
        await until(() => eventsOf(10).length > hBefore, 5000);
        const headers = JSON.parse(text(unb64(eventsOf(10).at(-1).data)));
        check('socket: the upgrade asked for "binary", sent the app\'s User-Agent, and no Origin and no cookie',
            headers['sec-websocket-protocol'] === 'binary' && headers['user-agent']?.startsWith('2004Scape/') && !('origin' in headers) && !('cookie' in headers), JSON.stringify(headers));
        // the page's close: no more events for it, the server sees 1000
        close(10);
        close(10);  // (idempotent)
        send(10, Uint8Array.of(9));  // (a send after close: ignored)
        await sleep(1000);
        check('socket: after the page\'s close no event comes for it', !eventsOf(10).slice(hBefore + 1).some((e) => e.event !== 'message'), JSON.stringify(eventsOf(10).slice(hBefore + 1)));
        log = await stubLog();
        const closed = log?.connections.filter((c) => c.open && c.headers['user-agent']?.startsWith('2004Scape/')).find((c) => c.received >= 60);
        check('socket: the server saw the page\'s close as 1000', closed?.closeCode === 1000 && closed.ended === true, JSON.stringify(closed));
        // unknown ids: ignored
        send(4242, Uint8Array.of(1));
        close(4242);
        await sleep(300);
        check('socket: send/close for an unknown id are ignored', eventsOf(4242).length === 0);
        // the server's close: code and reason; messages before it all arrive first
        open(11);
        await waitFor(11, 'open');
        open(11);  // (an id in use: ignored)
        command(11, 'then-close');
        await waitFor(11, 'close');
        let ev = eventsOf(11).map((e) => (e.event === 'message' ? `m${unb64(e.data)[0]}` : `${e.event}${e.code ?? ''}${e.reason ? ' ' + e.reason : ''}`));
        check('socket: 3 messages then the server\'s close 4000 "bye": all 3 first, then close 4000 bye', JSON.stringify(ev) === '["open","m1","m2","m3","close4000 bye"]', JSON.stringify(ev));
        open(12);
        await waitFor(12, 'open');
        command(12, 'close 1000 done');
        await waitFor(12, 'close');
        ev = eventsOf(12).map((e) => `${e.event}${e.code ?? ''}${e.reason ? ' ' + e.reason : ''}`);
        check('socket: the server\'s close 1000 "done"', JSON.stringify(ev) === '["open","close1000 done"]', JSON.stringify(ev));
        // a text frame: error, close 1006
        open(13);
        await waitFor(13, 'open');
        command(13, 'text');
        await waitFor(13, 'close');
        ev = eventsOf(13).map((e) => `${e.event}${e.code ?? ''}${e.reason ? ' ' + e.reason : ''}`);
        check('socket: a text frame → error "text frame", close 1006', JSON.stringify(ev) === '["open","error text frame","close1006 text frame"]', JSON.stringify(ev));
        // a dropped connection
        open(14);
        await waitFor(14, 'open');
        command(14, 'drop');
        await waitFor(14, 'close');
        ev = eventsOf(14).map((e) => `${e.event}${e.code ?? ''}${e.reason ? ' ' + e.reason : ''}`);
        check('socket: the connection dropped without a close → error "network", close 1006', JSON.stringify(ev) === '["open","error network","close1006 network"]', JSON.stringify(ev));
        // a refused upgrade
        open(15);
        await waitFor(15, 'open');
        command(15, 'refuse-next');
        await waitFor(15, 'message', 3000);
        open(16);
        await waitFor(16, 'close');
        ev = eventsOf(16).map((e) => `${e.event}${e.code ?? ''}${e.reason ? ' ' + e.reason : ''}`);
        check('socket: a refused upgrade (403) → error "http 403", close 1006', JSON.stringify(ev) === '["error http 403","close1006 http 403"]', JSON.stringify(ev));
        close(15);
        check('online-state: no sockets left open', (await state())?.sockets === 0, JSON.stringify(await state()));

        // WebContent killed with a socket open (continues in online-crash)
        open(20, 'keep');
        await waitFor(20, 'open');
        log = await stubLog();
        localStorage.lcKeepConnection = String(log.connections.length - 1);  // (the stub's numbering; the log's own socket is the last)
        localStorage.lcPhase = 'online-crash';
        await sleep(500);
        marker('ACTION kill-webcontent');
        await sleep(30000);
        check('online-crash: WebContent was killed', false, 'still alive 30 s after the request');
        return;
    }

    if (phase === 'online-crash') {
        const notice = await debug('last-notice');
        check('online-crash: the restart notice says to log in again', typeof notice === 'string' && notice.endsWith(' You will need to log in again.'), JSON.stringify(notice));
        check('online-crash: still online after the restart', (await state())?.server === 's-stub');
        await sleep(500);
        let log = await stubLog();
        const keep = log?.connections.find((c) => c.id === Number(localStorage.lcKeepConnection));
        check('online-crash: the dead page\'s socket was closed by native (1001)', keep?.closeCode === 1001 && keep.ended === true, JSON.stringify(keep));
        open(30, 'keep');
        await waitFor(30, 'open');
        log = await stubLog();
        localStorage.lcKeepConnection = String(log.connections.length - 1);
        localStorage.lcPhase = 'online-reload';
        location.reload();
        return;
    }

    if (phase === 'online-reload') {
        await sleep(500);
        const log = await stubLog();
        const keep = log?.connections.find((c) => c.id === Number(localStorage.lcKeepConnection));
        check('online-reload: the page\'s own reload closed its sockets (1001)', keep?.closeCode === 1001 && keep.ended === true, JSON.stringify(keep));
        use('s-down', 'online-down');
        await sleep(8000);
        check('server use s-down: reloads the page', false, 'still here 8 s later');
        return;
    }

    if (phase === 'online-down') {
        const s = await state();
        check('online-down: plays on the server that is down; the cover said online', s?.server === 's-down' && s.caption === CAPTION('online'), JSON.stringify(s));
        let r = await fetchText('crc');
        check('online-down: /crc → 502 "unreachable"', r.status === 502 && text(r.body) === 'unreachable', `${r.status} ${text(r.body)}`);
        r = await fetchText('config123');
        check('online-down: an archive not in the bundle → 502 "unreachable"', r.status === 502 && text(r.body) === 'unreachable', `${r.status} ${text(r.body)}`);
        check('online-down: the bundle\'s archives still come from the bundle', (await fetch('title410306098')).status === 200);
        open(40);
        await waitFor(40, 'close', 12000);
        const ev = eventsOf(40).map((e) => `${e.event}${e.code ?? ''}${e.reason ? ' ' + e.reason : ''}`);
        check('online-down: a socket → error "refused", close 1006', JSON.stringify(ev) === '["error refused","close1006 refused"]', JSON.stringify(ev));
        use('s-slow', 'online-slow');
        await sleep(8000);
        check('server use s-slow: reloads the page', false, 'still here 8 s later');
        return;
    }

    if (phase === 'online-slow') {
        const t0 = performance.now();
        const r = await fetchText('crc');
        const ms = performance.now() - t0;
        check('online-slow: /crc of a server that answers after 12 s → 502 "timed out" after 10 s', r.status === 502 && text(r.body) === 'timed out' && ms > 9500 && ms < 12500, `${r.status} ${text(r.body)} ${Math.round(ms)} ms`);
        if (cfg.engine) use('s-engine', 'online-engine');
        else use('offline', 'online-offline');
        await sleep(8000);
        check('server use: reloads the page', false, 'still here 8 s later');
        return;
    }

    if (phase === 'online-engine') {
        check('online-engine: plays on the local Engine-TS', (await state())?.server === 's-engine');
        let r = await fetchText('crc');
        const view = new DataView(r.body.buffer);
        const crcs = r.body.length === 40 ? Array.from({ length: 9 }, (_, i) => view.getInt32(i * 4)) : [];
        check('online-engine: /crc → its 40-byte table', r.status === 200 && r.body.length === 40, String(r.status));
        r = await fetchText(`config${crcs[2]}`);
        check('online-engine: its config archive (not in the test bundle) through the proxy', r.status === 200 && r.body.length > 1000, `${r.status} ${r.body.length}`);
        // a real server's socket through the bridge: OnDemand's opcode 15 → the server's 8 bytes. (Requests past that need
        // the engine's worker threads, which do not start under tsx on this Mac's Node 24.3.)
        open(50, 'ondemand');
        await waitFor(50, 'open');
        send(50, Uint8Array.of(15));
        await until(() => eventsOf(50).some((e) => e.event === 'message'), 5000);
        const hello = eventsOf(50).find((e) => e.event === 'message');
        check('online-engine: a socket to Engine-TS: OnDemand opcode 15 → its 8 bytes', hello && unb64(hello.data).length === 8, JSON.stringify(eventsOf(50)));
        close(50);
        use('offline', 'online-offline');
        await sleep(8000);
        check('server use offline: reloads the page', false, 'still here 8 s later');
        return;
    }

    if (phase === 'online-offline') {
        const s = await state();
        check('online-offline: back offline, the cover said offline', s?.server === null && s.caption === CAPTION('offline') && window.LostCityNative?.settings?.server === 'offline', JSON.stringify(s));
        const bundled = await fetch('crc').then((r) => r.arrayBuffer());
        check('online-offline: /crc is the bundle\'s file again', bundled.byteLength === 40);
        check('online-offline: /ondemand is a bundle path again (GET 404, PUT 405)', (await fetch('ondemand/1/5')).status === 404 && (await fetch('ondemand/1/5', { method: 'PUT', body: Uint8Array.of(1) })).status === 405);
        const p = await probe(cfg.stub);
        check('online-offline: the probe works offline too', p.json?.ok === true);
        let files = await debug('online-cache');
        check('online-offline: s-stub has cached files before the delete', Array.isArray(files) && files.some((f) => f.startsWith('s-stub/')) && files.includes('s-stub/od/1/5'), JSON.stringify(files));
        native({ type: 'server', action: 'delete', id: 's-stub' });
        await until(() => saved.length >= 1, 3000);
        await sleep(500);
        files = await debug('online-cache');
        check('server delete: the cache folder and the stored passwords go', JSON.stringify(saved[0]) === '{"s-down":["other"]}' && Array.isArray(files) && !files.some((f) => f.startsWith('s-stub/')), JSON.stringify({ saved, files }));
        native({ type: 'server', action: 'delete', id: 's-down' });
        native({ type: 'settings', values: { servers: null, server: null } });
        await sleep(500);
        localStorage.lcPhase = 'done';
        finish();
    }
}
