#!/usr/bin/env node
// Clones the revision-274 upstream sources this repo is built against into upstream/ (git-ignored), each at the
// commit upstream.json pins: upstream/engine (LostCityRS/Engine-TS), upstream/content (LostCityRS/Content) and
// upstream/webclient (LostCityRS/Client-TS). scripts/build-web.mjs and the tests then use them (scripts/lib/upstream.mjs:
// LC_UPSTREAM_DIR first, then upstream/, then a sibling ../Server checkout).
//
//   node scripts/fetch-upstream.mjs            # clone what is missing; a checkout already at its commit is left alone
//   node scripts/fetch-upstream.mjs --check    # only report: each checkout against upstream.json, and which folder
//                                              # the build uses (exit 1 when that one is not at the pinned commits)
//   node scripts/fetch-upstream.mjs --update   # also move a clean checkout that is at another commit to the pinned one
//   node scripts/fetch-upstream.mjs --dir <d>  # into (or check) <d>/{engine,content,webclient} instead of upstream/
//
// Each clone is shallow: just the pinned commit (fetched by its id), or, where the server does not allow that, the
// pinned branch, then that commit. It is checked out on a local branch named like upstream's (274). A checkout with
// local changes, or at another commit without --update, is never touched: the script says so and exits with 1. Needs
// git; nothing else (Node 24, macOS, Linux or Windows).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { NAMES, REPO_DIR, UPSTREAM_DIR, UPSTREAM_VIA, checkUpstream, describeUpstream, readPins } from './lib/upstream.mjs';

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const dirArg = flag('--dir') ? argv[argv.indexOf('--dir') + 1] : null;
if (flag('--dir') && !dirArg) {
    console.error('fetch-upstream: --dir needs a folder');
    process.exit(2);
}
const unknown = argv.filter((a, i) => a.startsWith('-') && !['--check', '--update', '--dir'].includes(a) && argv[i - 1] !== '--dir');
if (unknown.length) {
    console.error(`fetch-upstream: unknown option ${unknown.join(' ')} (--check, --update, --dir <folder>)`);
    process.exit(2);
}
const DIR = path.resolve(dirArg ?? path.join(REPO_DIR, 'upstream'));
const SHOWN = path.relative(process.cwd(), DIR).startsWith('..') ? DIR : path.relative(process.cwd(), DIR) || DIR;
const pins = readPins();

function git(cwd, args, { quiet = true } = {}) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] });
    if (r.error) {
        console.error(`fetch-upstream: cannot run git: ${r.error.message}`);
        process.exit(1);
    }
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

const short = sha => (sha ? sha.slice(0, 12) : 'none');
const isEmptyDir = d => fs.readdirSync(d).length === 0;
const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/**
 * What a checkout is: { state, head }, state 'missing', 'empty' (a folder with nothing in it), 'unborn' (a git
 * repository without a commit, e.g. left by a fetch that failed), 'not-git', 'ok', 'other' (another commit) or 'dirty'.
 */
function inspect(name) {
    const d = path.join(DIR, name);
    if (!fs.existsSync(d)) return { state: 'missing' };
    if (isEmptyDir(d)) return { state: 'empty' };
    const top = git(d, ['rev-parse', '--show-toplevel']);
    if (!top.ok || !samePath(top.out, fs.realpathSync(d))) return { state: 'not-git' };
    const head = git(d, ['rev-parse', '--verify', '-q', 'HEAD']).out || null;
    if (!head) return { state: 'unborn' };
    // (tracked files only: the engine's packer output and node_modules are ignored by upstream's own .gitignore)
    const dirty = git(d, ['status', '--porcelain', '--untracked-files=no']).out !== '';
    if (dirty) return { state: 'dirty', head };
    return { state: head === pins[name].commit ? 'ok' : 'other', head };
}

/**
 * Fetches the pinned commit into the git repository d (a new one: shallow; one with its history: not shallow, so it
 * keeps it) and checks it out on a branch named like upstream's.
 */
function fetchPinned(name, d, fresh) {
    const { repository, branch, commit } = pins[name];
    const origin = git(d, ['remote', 'get-url', 'origin']);
    if (!origin.ok) {
        git(d, ['remote', 'add', 'origin', repository]);
    }
    const shallow = fresh || git(d, ['rev-parse', '--is-shallow-repository']).out === 'true';
    let fetched = git(d, ['cat-file', '-e', `${commit}^{commit}`]).ok;
    if (!fetched) {
        console.log(`fetch-upstream: ${name}: fetching ${short(commit)} from ${repository}`);
        fetched = git(d, ['fetch', ...(shallow ? ['--depth=1'] : []), '--no-tags', 'origin', commit], { quiet: false }).ok;
    }
    if (!fetched) {
        // a server that does not serve a commit by its id: the branch, deep enough to hold the commit
        console.log(`fetch-upstream: ${name}: fetching branch ${branch} instead`);
        fetched = git(d, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { quiet: false }).ok;
        if (fetched && !git(d, ['cat-file', '-e', `${commit}^{commit}`]).ok) {
            console.error(`fetch-upstream: ${name}: ${commit} is not on ${repository} branch ${branch}`);
            return false;
        }
    }
    if (!fetched) {
        console.error(`fetch-upstream: ${name}: could not fetch ${commit} from ${repository}`);
        return false;
    }
    const checkout = git(d, ['checkout', '-q', '-B', branch, commit]);
    if (!checkout.ok) {
        console.error(`fetch-upstream: ${name}: git checkout ${commit} failed:\n${checkout.err}`);
        return false;
    }
    return git(d, ['rev-parse', 'HEAD']).out === commit;
}

function describe(name, info) {
    const want = short(pins[name].commit);
    switch (info.state) {
        case 'missing':
            return 'missing';
        case 'empty':
            return 'an empty folder';
        case 'unborn':
            return 'a git repository without a commit (a fetch that did not finish?)';
        case 'not-git':
            return 'not a git checkout';
        case 'ok':
            return `at ${want} (pinned)`;
        case 'other':
            return `at ${short(info.head)}, upstream.json pins ${want}`;
        case 'dirty':
            return `has local changes (at ${short(info.head)}; upstream.json pins ${want})`;
    }
    return info.state;
}

// ---- --check ------------------------------------------------------------------------------------------------------

if (flag('--check')) {
    let problems = 0;
    console.log(`${SHOWN}:`);
    for (const name of NAMES) {
        const info = inspect(name);
        if (info.state !== 'ok') problems++;
        console.log(`  ${name.padEnd(10)} ${describe(name, info)}`);
    }
    if (dirArg) {
        process.exit(problems ? 1 : 0);
    }
    // without --dir: also what the build resolves to (LC_UPSTREAM_DIR, upstream/ or the sibling ../Server)
    const used = checkUpstream();
    console.log(`the build uses ${describeUpstream()}${UPSTREAM_VIA === 'upstream' ? '' : ':'}`);
    if (UPSTREAM_VIA !== 'upstream') {
        for (const u of used) {
            console.log(`  ${u.name.padEnd(10)} ${!u.exists ? 'missing' : !u.head ? 'not a git checkout' : u.ok ? `at ${short(u.head)} (pinned)` : `at ${short(u.head)}, upstream.json pins ${short(u.expected)}`}`);
        }
    }
    const usable = used.every(u => u.ok);
    console.log(usable ? 'ok: the build has the pinned sources' : `not ok: run \`node scripts/fetch-upstream.mjs\`${UPSTREAM_VIA === 'upstream' ? ' (--update to move a checkout to its pinned commit)' : ''}`);
    process.exit(usable ? 0 : 1);
}

// ---- fetch --------------------------------------------------------------------------------------------------------

fs.mkdirSync(DIR, { recursive: true });
let failed = 0;
for (const name of NAMES) {
    const d = path.join(DIR, name);
    const info = inspect(name);
    if (info.state === 'ok') {
        console.log(`fetch-upstream: ${name}: already at ${short(pins[name].commit)}`);
        continue;
    }
    if (info.state === 'not-git') {
        console.error(`fetch-upstream: ${name}: ${d} is not a git checkout; move it away and run again`);
        failed++;
        continue;
    }
    if (info.state === 'dirty') {
        console.error(`fetch-upstream: ${name}: ${d} has local changes (at ${short(info.head)}); upstream.json pins ${pins[name].commit}. Commit or stash them (or remove the folder), then run again`);
        failed++;
        continue;
    }
    if (info.state === 'other' && !flag('--update')) {
        console.error(`fetch-upstream: ${name}: ${d} is at ${info.head}, upstream.json pins ${pins[name].commit}. Run with --update to check out the pinned commit (the checkout has no local changes)`);
        failed++;
        continue;
    }
    const fresh = info.state === 'missing' || info.state === 'empty' || info.state === 'unborn';
    if (fresh) {
        fs.mkdirSync(d, { recursive: true });
        if (info.state !== 'unborn' && !git(d, ['init', '-q']).ok) {
            console.error(`fetch-upstream: ${name}: git init ${d} failed`);
            failed++;
            continue;
        }
    }
    if (fetchPinned(name, d, fresh)) {
        console.log(`fetch-upstream: ${name}: ${d} at ${short(pins[name].commit)} (${pins[name].branch})`);
    } else {
        // (a new checkout that did not finish: removed, so the next run starts it over)
        if (fresh) fs.rmSync(d, { recursive: true, force: true });
        failed++;
    }
}
if (failed) {
    console.error(`fetch-upstream: ${failed} of ${NAMES.length} not at their pinned commit`);
    process.exit(1);
}
const other = UPSTREAM_VIA === 'LC_UPSTREAM_DIR' || UPSTREAM_VIA === 'LC_SERVER_DIR' ? UPSTREAM_DIR : null;
console.log(`fetch-upstream: ${SHOWN} has the pinned sources${other && path.resolve(other) !== DIR ? ` (the build uses ${other}, from ${UPSTREAM_VIA}: unset it to use these)` : ''}`);
