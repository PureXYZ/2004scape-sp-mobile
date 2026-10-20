// A scratch engine to run the bots in (build/tmp/bots/<name>/engine): an APFS clone of Server/engine's src,
// package.json and tsconfig.json, its node_modules and the read-only inputs (data/pack, data/raw, ../content)
// symlinked, its own data/config (world.json written per run) and data/players, and src/engine/bot linked to this
// library. Nothing is ever written under Server/.
import fs from 'fs';
import path from 'path';
import { BOTS_SRC, CONTENT_DIR, ENGINE_DIR, TMP_DIR } from './paths.mjs';

function link(target, at) {
    fs.rmSync(at, { recursive: true, force: true });
    fs.symlinkSync(target, at);
}

/**
 * Creates the clone (per process, so runs can go side by side; removed again when the process exits) and returns
 * its engine directory.
 */
export function prepareEngineClone(name, worldConfig) {
    const root = path.join(TMP_DIR, `${name}-${process.pid}`);
    process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
    const engine = path.join(root, 'engine');
    fs.mkdirSync(engine, { recursive: true });

    fs.rmSync(path.join(engine, 'src'), { recursive: true, force: true });
    fs.cpSync(path.join(ENGINE_DIR, 'src'), path.join(engine, 'src'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    for (const file of ['package.json', 'tsconfig.json']) {
        fs.copyFileSync(path.join(ENGINE_DIR, file), path.join(engine, file), fs.constants.COPYFILE_FICLONE);
    }
    link(path.join(ENGINE_DIR, 'node_modules'), path.join(engine, 'node_modules'));
    link(BOTS_SRC, path.join(engine, 'src/engine/bot'));

    fs.mkdirSync(path.join(engine, 'data/config'), { recursive: true });
    link(path.join(ENGINE_DIR, 'data/pack'), path.join(engine, 'data/pack'));
    link(path.join(ENGINE_DIR, 'data/raw'), path.join(engine, 'data/raw'));
    fs.copyFileSync(path.join(ENGINE_DIR, 'data/config/private.pem'), path.join(engine, 'data/config/private.pem'));
    fs.writeFileSync(path.join(engine, 'data/config/world.json'), JSON.stringify(worldConfig, null, 4));
    fs.rmSync(path.join(engine, 'data/players'), { recursive: true, force: true });
    fs.mkdirSync(path.join(engine, 'data/players'), { recursive: true });

    link(CONTENT_DIR, path.join(root, 'content'));
    return engine;
}

/** world.json as the iOS build writes it (web/engine/build.mjs WORLD_CONFIG), with the world's membership and XP rate. */
export function simWorldConfig({ members = true, profile = 'sim', xpRate = 1 } = {}) {
    return {
        node: { id: 10, members, production: false, debug: true, debugProfile: false, xpRate, profile, clientRoutefinder: true },
        login: { enabled: false },
        friend: { enabled: false },
        logger: { enabled: false },
        build: { liveReload: false, verbose: true, srcDir: '../content' }
    };
}

/** The engine's helper threads (login/friend/logger) are not needed; replace Worker before World.ts evaluates. */
export async function stubWorkerThreads() {
    const { createRequire, syncBuiltinESMExports } = await import('module');
    const { EventEmitter } = await import('events');
    const require = createRequire(import.meta.url);
    const workerThreads = require('worker_threads');
    class StubWorker extends EventEmitter {
        postMessage() {}
        terminate() {
            return Promise.resolve(0);
        }
        ref() {}
        unref() {}
    }
    workerThreads.Worker = StubWorker;
    syncBuiltinESMExports();
}

/**
 * For a test that needs the engine: prepares the clone `name`, makes it the working directory (the engine reads
 * data/ relative to it), stubs the helper threads and imports `file` (TypeScript) with the clone's '#/' paths.
 */
export async function importInEngine(file, name, worldConfig = simWorldConfig()) {
    const engine = prepareEngineClone(name, worldConfig);
    process.chdir(engine);
    await stubWorkerThreads();
    const { importTs } = await import('./paths.mjs');
    return importTs(file, path.join(engine, 'tsconfig.json'));
}
