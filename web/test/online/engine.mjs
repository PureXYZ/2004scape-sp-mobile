// A local Engine-TS 274 for the online tests (docs/ONLINE.md §Tests; never an official server): a copy of the upstream
// engine and content checkouts (APFS clones, `cp -cR`, made once by `prepareEngine`), started as its own `tsx src/app.ts`
// with the variant's data/config/world.json (the engine reads its settings from that file, merged over its defaults;
// not from the environment) and stopped again, its whole process group.
//
//   const engine = await startEngine({ dir, variant: 'stock', ports });  // → { url, variant, stop(), log }
//
// Variants: stock (Engine-TS's defaults: debug on, so a character is staff and the tests can use ::setvar,
// as a server run with `npm start` is); login (a login server with passwords: accounts registered at the first login, bcrypt
// checked after; its sqlite database made from the engine's own migrations); production (staff 0, login rate limits);
// key (a private key of its own: a client with the built-in key gets 6); full (maxConnected -1: 7); origin
// (web.allowedOrigin set: the app sends no Origin, so the upgrade is refused). The content-drift copy is drift.mjs's.
// The tests keep to their own ports (the web track's: 47620 web, 47621 management, 47622 node; with the login server
// 47623 login, 47624 friend, 47628 logger).
//
// Node: the engine's worker threads (its login and OnDemand threads) need a current Node 24, as upstream's Docker image
// runs (node:lts): 24.3 refuses the engine's "#/..." imports there, and logins are never answered. `nodeBin` (a folder
// with a newer `node`) is put first on the engine's PATH; tsx runs with the first node it finds.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const PORTS = { web: 47620, management: 47621, node: 47622, login: 47623, friend: 47624, logger: 47628 };

export const VARIANTS = {
    stock: () => ({}),
    login: ports => ({
        easyStartup: true,
        website: { registration: false },
        login: { enabled: true, port: ports.login },
        friend: { enabled: true, port: ports.friend },
        logger: { enabled: true, port: ports.logger }
    }),
    production: () => ({ node: { production: true } }),
    key: () => ({}),
    full: () => ({ node: { maxConnected: -1 } }), // (its check is players > maxConnected: 0 would still let one in)
    origin: () => ({ web: { allowedOrigin: 'https://example.invalid' } })
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The copy the tests run (once): <dir>/engine and <dir>/content, APFS clones of the upstream checkouts.
export function prepareEngine(dir, upstream) {
    for (const name of ['engine', 'content']) {
        if (!fs.existsSync(path.join(dir, name))) {
            fs.mkdirSync(dir, { recursive: true });
            const copied = spawnSync('cp', ['-cR', path.join(upstream, name), path.join(dir, name)], { stdio: 'inherit' });
            if (copied.status !== 0) {
                throw new Error(`could not copy ${name} into ${dir}`);
            }
        }
    }
    return path.join(dir, 'engine');
}

// The key variant's private key (a 1024-bit pair made here, kept beside the copy) and the stock one, swapped in place.
export function useKey(engineDir, own) {
    const pem = path.join(engineDir, 'data', 'config', 'private.pem');
    const stock = `${pem}.stock`;
    if (!fs.existsSync(stock)) {
        fs.copyFileSync(pem, stock);
    }
    if (!own) {
        fs.copyFileSync(stock, pem);
        return null;
    }
    const mine = `${pem}.test`;
    if (!fs.existsSync(mine)) {
        const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 65537 });
        fs.writeFileSync(mine, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    }
    fs.copyFileSync(mine, pem);
    const jwk = crypto.createPrivateKey(fs.readFileSync(mine)).export({ format: 'jwk' });
    const toDecimal = b64 => BigInt(`0x${Buffer.from(b64, 'base64url').toString('hex')}`).toString(10);
    return { n: toDecimal(jwk.n), e: toDecimal(jwk.e) };
}

// The login server's sqlite database (db.sqlite in the engine folder), made from the engine's migrations, empty.
function makeDatabase(engineDir) {
    const file = path.join(engineDir, 'db.sqlite');
    fs.rmSync(file, { force: true });
    const db = new DatabaseSync(file);
    const migrations = path.join(engineDir, 'prisma', 'singleworld', 'migrations');
    for (const name of fs.readdirSync(migrations).filter(n => fs.statSync(path.join(migrations, n)).isDirectory()).sort()) {
        db.exec(fs.readFileSync(path.join(migrations, name, 'migration.sql'), 'utf8'));
    }
    db.close();
}

async function portOpen(port) {
    return new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

export async function startEngine({ dir, variant = 'stock', ports = PORTS, nodeBin = null, log = null, timeoutMs = 180000 }) {
    if (!VARIANTS[variant]) {
        throw new Error(`no engine variant ${variant}`);
    }
    for (const port of [ports.web, ports.management, ports.node]) {
        if (await portOpen(port)) {
            throw new Error(`port ${port} is taken: an engine still running?`);
        }
    }
    const config = {
        web: { port: ports.web, managementPort: ports.management },
        node: { port: ports.node },
        build: { liveReload: false },
        ...VARIANTS[variant](ports)
    };
    config.web = { port: ports.web, managementPort: ports.management, ...config.web };
    config.node = { port: ports.node, ...config.node };
    fs.writeFileSync(path.join(dir, 'data', 'config', 'world.json'), `${JSON.stringify(config, null, 4)}\n`);
    const key = useKey(dir, variant === 'key');
    if (variant === 'login') {
        makeDatabase(dir);
    }
    fs.rmSync(path.join(dir, 'data', 'players'), { recursive: true, force: true }); // (every run starts with no saves)

    const lines = [];
    const env = nodeBin ? { ...process.env, PATH: `${nodeBin}${path.delimiter}${process.env.PATH}` } : process.env;
    const child = spawn(path.join(dir, 'node_modules', '.bin', 'tsx'), ['src/app.ts'], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = chunk => {
        for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
            lines.push(line);
            log?.(line);
        }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let exited = null;
    child.on('exit', code => {
        exited = code;
    });

    const stop = async () => {
        if (exited !== null) {
            return;
        }
        try {
            process.kill(-child.pid, 'SIGTERM');
        } catch {
            return;
        }
        for (let i = 0; i < 40 && exited === null; i++) {
            await sleep(250);
        }
        try {
            process.kill(-child.pid, 'SIGKILL');
        } catch {
            // gone
        }
        for (let i = 0; i < 20 && (await portOpen(ports.web)); i++) {
            await sleep(250);
        }
    };

    const started = Date.now();
    while (!(await portOpen(ports.web))) {
        if (exited !== null || Date.now() - started > timeoutMs) {
            await stop();
            throw new Error(`the ${variant} engine did not start (${exited !== null ? `exit ${exited}` : 'timed out'}): ${lines.slice(-8).join(' | ')}`);
        }
        await sleep(500);
    }
    return { url: `http://127.0.0.1:${ports.web}`, variant, key, stop, lines, started: Date.now() - started };
}
