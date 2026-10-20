#!/usr/bin/env node
// Patch workflow for the client patches (web/client/patches/*.patch, unified diffs against the upstream webclient,
// Client-TS at the commit upstream.json pins; scripts/lib/upstream.mjs finds the checkout).
//
//   node web/client/patches.mjs edit [--onto-current] [--force] [--webclient <dir>]
//       Creates build/tmp/client/patch-work, a git repository holding the upstream tree the patches were made
//       against (patches/BASE, extracted with `git archive` from the webclient repo) as the commit tagged
//       `upstream`, plus one commit per patch on top (message = the patch header). Edit, commit/amend there.
//       --onto-current additionally rebases those commits onto the CURRENT webclient working tree with a real
//       3-way `git rebase`, so upstream changes surface as ordinary merge conflicts.
//   node web/client/patches.mjs export
//       Rewrites patches/*.patch from the commits after `upstream` (header = commit message, body = git diff)
//       and records the upstream commit in patches/BASE (which must stay upstream.json's webclient commit:
//       web/test/upstream.test.mjs checks it).
//   node web/client/patches.mjs check [--webclient <dir>]
//       Applies every patch to a fresh copy of the webclient, exactly like build.mjs (no build).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    DEFAULT_WEBCLIENT_DIR,
    PATCHES_DIR,
    TMP_DIR,
    applyPatches,
    copyUpstreamTree,
    listPatches,
    readBaseCommit,
    removeTmpDir,
    webclientCommit
} from './lib/tree.mjs';
import { readPins } from '../../scripts/lib/upstream.mjs';

const WORK = path.join(TMP_DIR, 'patch-work');
const IDENT = { GIT_AUTHOR_NAME: 'ios-port', GIT_AUTHOR_EMAIL: 'ios-port@localhost', GIT_COMMITTER_NAME: 'ios-port', GIT_COMMITTER_EMAIL: 'ios-port@localhost' };

function run(cwd, args, { input, allowFail = false } = {}) {
    const r = spawnSync('git', args, {
        cwd,
        input,
        encoding: input instanceof Buffer ? undefined : 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, ...IDENT, GIT_CEILING_DIRECTORIES: path.dirname(cwd) }
    });
    if (r.status !== 0 && !allowFail) {
        throw new Error(`git ${args.join(' ')} failed:\n${r.stderr?.toString() ?? ''}`);
    }
    return r;
}

function args(argv) {
    const o = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--webclient') {
            o.webclient = path.resolve(argv[++i]);
        } else if (a.startsWith('--')) {
            o[a.slice(2)] = true;
        } else {
            o._.push(a);
        }
    }
    return o;
}

// Replace the work tree's tracked upstream files with `dir`'s (src/, tsconfig.json, package.json) and commit.
function commitTree(fromDir, message) {
    for (const e of ['src', 'tsconfig.json', 'package.json']) {
        fs.rmSync(path.join(WORK, e), { recursive: true, force: true });
        fs.cpSync(path.join(fromDir, e), path.join(WORK, e), { recursive: true });
    }
    run(WORK, ['add', '-A']);
    run(WORK, ['commit', '-q', '--allow-empty', '-m', message]);
}

// Upstream tree at `commit`, extracted read-only from the webclient repository with `git archive`.
function extractCommit(webclient, commit, dest) {
    removeTmpDir(dest);
    fs.mkdirSync(dest, { recursive: true });
    const tar = spawnSync('git', ['-C', webclient, 'archive', '--format=tar', commit, 'src', 'tsconfig.json', 'package.json'], { maxBuffer: 256 * 1024 * 1024 });
    if (tar.status !== 0) {
        throw new Error(`git archive ${commit} failed: ${tar.stderr}`);
    }
    const x = spawnSync('tar', ['-x', '-C', dest], { input: tar.stdout });
    if (x.status !== 0) {
        throw new Error(`tar -x failed: ${x.stderr}`);
    }
}

function edit(o) {
    const webclient = o.webclient ?? DEFAULT_WEBCLIENT_DIR;
    if (fs.existsSync(WORK) && !o.force) {
        throw new Error(`${WORK} exists (it may hold unexported work). Run export first, or pass --force to recreate it.`);
    }
    removeTmpDir(WORK);
    fs.mkdirSync(WORK, { recursive: true });
    run(WORK, ['init', '-q', '-b', 'main']);
    run(WORK, ['config', 'core.autocrlf', 'false']);
    // repo-local identity, so commits made by hand in the work tree don't pick up the global git identity
    run(WORK, ['config', 'user.name', IDENT.GIT_AUTHOR_NAME]);
    run(WORK, ['config', 'user.email', IDENT.GIT_AUTHOR_EMAIL]);

    const head = webclientCommit(webclient);
    const base = readBaseCommit() ?? head;
    const baseTree = path.join(TMP_DIR, 'patch-base');
    if (base && head) {
        extractCommit(webclient, base, baseTree);
    } else {
        copyUpstreamTree(webclient, baseTree); // no git metadata: the working tree is the base
    }
    commitTree(baseTree, `upstream ${base ?? '(working tree)'}`);
    run(WORK, ['tag', '-f', 'upstream']);

    for (const patch of listPatches()) {
        applyPatches(WORK, [patch]);
        const text = fs.readFileSync(patch, 'utf8');
        const header = text.slice(0, text.indexOf('\ndiff --git ')).trim() || path.basename(patch, '.patch');
        run(WORK, ['add', '-A']);
        run(WORK, ['commit', '-q', '-F', '-'], { input: header + '\n' });
    }
    console.log(`patch-work: ${listPatches().length} patch commit(s) on upstream ${base}`);

    if (o['onto-current']) {
        const current = path.join(TMP_DIR, 'patch-current');
        copyUpstreamTree(webclient, current);
        run(WORK, ['checkout', '-q', '-b', 'upstream-new', 'upstream']);
        commitTree(current, `upstream ${head ?? '(working tree)'}`);
        run(WORK, ['tag', '-f', 'upstream-new']);
        run(WORK, ['checkout', '-q', 'main']);
        const r = run(WORK, ['rebase', '--onto', 'upstream-new', 'upstream', 'main'], { allowFail: true });
        if (r.status !== 0) {
            console.log(r.stdout, r.stderr);
            console.log(`\nRebase stopped on a conflict. In ${WORK}: resolve, \`git add\`, \`git rebase --continue\`;` +
                ' then `git tag -f upstream upstream-new` and run `node web/client/patches.mjs export`.');
            process.exitCode = 1;
            return;
        }
        run(WORK, ['tag', '-f', 'upstream', 'upstream-new']);
        console.log(`rebased onto the current webclient (${head ?? 'working tree'}); review, then export`);
    }
    console.log(`edit the files in ${WORK} (one commit per patch), then: node web/client/patches.mjs export`);
}

// "ios: touch gestures (long-press ...)" -> "touch-gestures-long-press" (word boundary, <= 40 chars)
function slug(subject) {
    const words = subject.replace(/^ios:\s*/i, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let out = '';
    for (const w of words) {
        if (out && out.length + 1 + w.length > 40) {
            break;
        }
        out = out ? `${out}-${w}` : w;
    }
    return out.slice(0, 40) || 'patch';
}

function exportPatches() {
    if (!fs.existsSync(path.join(WORK, '.git'))) {
        throw new Error(`no ${WORK}; run \`node web/client/patches.mjs edit\` first`);
    }
    const dirty = run(WORK, ['status', '--porcelain']).stdout.trim();
    if (dirty) {
        throw new Error(`uncommitted changes in ${WORK}:\n${dirty}\nCommit (or amend) them first.`);
    }
    const commits = run(WORK, ['rev-list', '--reverse', 'upstream..HEAD']).stdout.trim().split('\n').filter(Boolean);
    const upstreamMsg = run(WORK, ['log', '-1', '--format=%s', 'upstream']).stdout.trim();
    for (const f of fs.readdirSync(PATCHES_DIR).filter(f => f.endsWith('.patch'))) {
        fs.rmSync(path.join(PATCHES_DIR, f));
    }
    commits.forEach((c, i) => {
        const msg = run(WORK, ['log', '-1', '--format=%B', c]).stdout.trim();
        const diff = run(WORK, ['diff', '--no-color', '--no-ext-diff', '--no-renames', `${c}^`, c]).stdout;
        const name = `${String(i + 1).padStart(4, '0')}-${slug(msg.split('\n')[0])}.patch`;
        fs.writeFileSync(path.join(PATCHES_DIR, name), `${msg}\n\n${diff}`);
        console.log('wrote', name);
    });
    const base = upstreamMsg.replace(/^upstream\s+/, '');
    fs.writeFileSync(path.join(PATCHES_DIR, 'BASE'), `${base}\n`);
    console.log(`patches/BASE = ${base}`);
    if (base !== readPins().webclient.commit) {
        console.log(`note: upstream.json pins webclient ${readPins().webclient.commit}: set it to ${base} too (the build checks the checkout against upstream.json)`);
    }
}

function check(o) {
    const webclient = o.webclient ?? DEFAULT_WEBCLIENT_DIR;
    const dir = path.join(TMP_DIR, 'patch-check');
    copyUpstreamTree(webclient, dir);
    applyPatches(dir, listPatches(), { baseCommit: readBaseCommit(), webclientCommit: webclientCommit(webclient) });
    console.log(`ok: ${listPatches().length} patch(es) apply cleanly to ${webclient}`);
}

const o = args(process.argv.slice(2));
try {
    const cmd = o._[0];
    if (cmd === 'edit') {
        edit(o);
    } else if (cmd === 'export') {
        exportPatches();
    } else if (cmd === 'check') {
        check(o);
    } else {
        console.log('usage: node web/client/patches.mjs edit [--onto-current] [--force] | export | check');
        process.exitCode = 2;
    }
} catch (e) {
    console.error(String(e.message ?? e));
    process.exitCode = 1;
}
