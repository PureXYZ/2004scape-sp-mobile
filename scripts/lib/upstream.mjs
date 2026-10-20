// Where the revision-274 upstream sources are (Engine-TS, Content, Client-TS) and which commits this repo is built
// against (upstream.json). Every script and test finds them here, so they all agree:
//
//   1. LC_UPSTREAM_DIR (LC_SERVER_DIR is the older name of it): a folder holding engine/, content/ and webclient/
//   2. <repo>/upstream, when it exists: `node scripts/fetch-upstream.mjs` clones the pinned commits there (git-ignored)
//   3. ../Server beside the repo: a Lost City Server checkout, whose start.js clones the three into it
//
// The sources are read-only inputs: nothing here writes to them, except the engine's own packer (`npm run build` in
// engine/, run by scripts/build-web.mjs), which writes engine/data/pack.
//
// The committed tsconfig.json files (web/engine, web/engine/bots, web/engine/test/fixtures/stub-bots) cannot read an
// environment variable, so their paths name the sibling ../Server (case 3, and what an editor sees). Tools that
// type-check or load TypeScript through them use derivedTsconfig(), which writes a copy whose paths point at the
// folder resolved here.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const UPSTREAM_JSON = path.join(REPO_DIR, 'upstream.json');
/** The three checkouts, by their folder names (and upstream.json's keys). */
export const NAMES = ['engine', 'content', 'webclient'];

/** upstream.json: { revision, engine|content|webclient: { repository, branch, commit } }. */
export function readPins(file = UPSTREAM_JSON) {
    const pins = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const name of NAMES) {
        const p = pins[name];
        if (!p || typeof p.repository !== 'string' || typeof p.branch !== 'string' || !/^[0-9a-f]{40}$/.test(p.commit ?? '')) {
            throw new Error(`${file}: ${name} needs a repository, a branch and a full 40-character commit`);
        }
    }
    return pins;
}

/** The upstream folder and how it was chosen ('LC_UPSTREAM_DIR', 'LC_SERVER_DIR', 'upstream' or 'sibling'). */
export function resolveUpstream(env = process.env, repoDir = REPO_DIR) {
    if (env.LC_UPSTREAM_DIR) {
        return { dir: path.resolve(env.LC_UPSTREAM_DIR), via: 'LC_UPSTREAM_DIR' };
    }
    if (env.LC_SERVER_DIR) {
        return { dir: path.resolve(env.LC_SERVER_DIR), via: 'LC_SERVER_DIR' };
    }
    const own = path.join(repoDir, 'upstream');
    if (fs.existsSync(own)) {
        return { dir: own, via: 'upstream' };
    }
    return { dir: path.resolve(repoDir, '..', 'Server'), via: 'sibling' };
}

const resolved = resolveUpstream();
export const UPSTREAM_DIR = resolved.dir;
export const UPSTREAM_VIA = resolved.via;
export const ENGINE_DIR = path.join(UPSTREAM_DIR, 'engine');
export const CONTENT_DIR = path.join(UPSTREAM_DIR, 'content');
export const WEBCLIENT_DIR = path.join(UPSTREAM_DIR, 'webclient');

/** A one-line description of where the sources come from, for logs and errors. */
export function describeUpstream() {
    const why = {
        LC_UPSTREAM_DIR: 'LC_UPSTREAM_DIR',
        LC_SERVER_DIR: 'LC_SERVER_DIR',
        upstream: 'the repo\'s upstream/ (scripts/fetch-upstream.mjs)',
        sibling: 'the sibling ../Server checkout'
    }[UPSTREAM_VIA];
    return `${UPSTREAM_DIR} (${why})`;
}

function git(dir, args) {
    try {
        return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
}

/** The full commit a checkout is at, or null (missing, or not a git checkout). */
export function gitHead(dir) {
    return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * Each checkout against upstream.json: [{ name, dir, expected, head, exists, ok }]. ok is true when it is at the
 * pinned commit; a folder that is not a git checkout (e.g. unpacked from an archive) has head null and is not ok.
 */
export function checkUpstream({ dir = UPSTREAM_DIR, pins = readPins() } = {}) {
    return NAMES.map(name => {
        const d = path.join(dir, name);
        const exists = fs.existsSync(d);
        const head = exists ? gitHead(d) : null;
        return { name, dir: d, expected: pins[name].commit, head, exists, ok: head === pins[name].commit };
    });
}

// ---- tsconfig ---------------------------------------------------------------------------------------------------

// tsconfig.json is JSON with comments (whole-line // comments here) and trailing commas
function readJsonc(file) {
    const text = fs
        .readFileSync(file, 'utf8')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
}

// compilerOptions.paths and typeRoots through the extends chain, every entry made absolute (paths from baseUrl as the
// config that set it resolves it, typeRoots from the config that names them)
function effectiveOptions(file) {
    const config = readJsonc(file);
    const dir = path.dirname(file);
    const base = config.extends ? effectiveOptions(path.resolve(dir, config.extends)) : { baseUrl: null, paths: null, typeRoots: null };
    const own = config.compilerOptions ?? {};
    const baseUrl = own.baseUrl !== undefined ? path.resolve(dir, own.baseUrl) : base.baseUrl;
    const paths = own.paths
        ? Object.fromEntries(Object.entries(own.paths).map(([k, v]) => [k, v.map(p => path.resolve(baseUrl ?? dir, p))]))
        : base.paths;
    const typeRoots = own.typeRoots ? own.typeRoots.map(p => path.resolve(dir, p)) : base.typeRoots;
    return { baseUrl, paths, typeRoots };
}

/**
 * A copy of a committed tsconfig.json whose paths into the sibling ../Server point at UPSTREAM_DIR instead (it extends
 * the committed file, so include, strictness and the rest stay as they are). Written under build/tmp/tsconfig; returns
 * its path, for `tsc -p` or tsx's tsconfig option.
 */
export function derivedTsconfig(file, upstreamDir = UPSTREAM_DIR) {
    file = path.resolve(file);
    const sibling = path.resolve(REPO_DIR, '..', 'Server');
    const move = p => (p === sibling || p.startsWith(sibling + path.sep) ? path.join(upstreamDir, path.relative(sibling, p)) : p);
    const { paths, typeRoots } = effectiveOptions(file);
    const compilerOptions = {};
    if (paths) compilerOptions.paths = Object.fromEntries(Object.entries(paths).map(([k, v]) => [k, v.map(move)]));
    if (typeRoots) compilerOptions.typeRoots = typeRoots.map(move);
    const out = path.join(REPO_DIR, 'build', 'tmp', 'tsconfig');
    fs.mkdirSync(out, { recursive: true });
    const name = `${path.basename(path.dirname(file))}-${crypto.createHash('sha256').update(`${file}\0${upstreamDir}`).digest('hex').slice(0, 12)}.json`;
    const derived = path.join(out, name);
    const text = `${JSON.stringify({ extends: file, compilerOptions }, null, 4)}\n`;
    if (!fs.existsSync(derived) || fs.readFileSync(derived, 'utf8') !== text) {
        fs.writeFileSync(`${derived}.${process.pid}.tmp`, text);
        fs.renameSync(`${derived}.${process.pid}.tmp`, derived);
    }
    return derived;
}
