// Shared helpers for the client build (build.mjs) and the patch workflow (patches.mjs):
// copying the upstream webclient tree, applying patches/*.patch with `git apply`, and locating overrides.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ENGINE_DIR, WEBCLIENT_DIR } from '../../../scripts/lib/upstream.mjs';

export const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // web/client
export const IOS_DIR = path.resolve(CLIENT_DIR, '../..'); // ios/
export const WEB_DIR = path.join(IOS_DIR, 'web');
export const PATCHES_DIR = path.join(CLIENT_DIR, 'patches');
export const OVERRIDES_DIR = path.join(CLIENT_DIR, 'overrides');
export const TMP_DIR = path.join(IOS_DIR, 'build', 'tmp', 'client');

// the upstream checkouts (scripts/lib/upstream.mjs: LC_UPSTREAM_DIR, <repo>/upstream or the sibling ../Server)
export const DEFAULT_WEBCLIENT_DIR = WEBCLIENT_DIR;
export const DEFAULT_ENGINE_DIR = ENGINE_DIR;

// The upstream files a build needs. Patches are unified diffs relative to the webclient root (a/src/..., -p1).
const TREE_ENTRIES = ['src', 'tsconfig.json', 'package.json'];

export function listPatches() {
    if (!fs.existsSync(PATCHES_DIR)) {
        return [];
    }
    return fs
        .readdirSync(PATCHES_DIR)
        .filter(f => f.endsWith('.patch'))
        .sort()
        .map(f => path.join(PATCHES_DIR, f));
}

// Files touched by a patch (paths relative to the webclient root), from its `diff --git a/x b/x` lines.
export function patchedFiles(patchFile) {
    const out = new Set();
    for (const m of fs.readFileSync(patchFile, 'utf8').matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
        out.add(m[2]);
    }
    return [...out];
}

// Whole-module overrides: overrides/<path> replaces <webclient>/<path> (or adds a new module there).
export function listOverrides() {
    const out = [];
    const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                walk(p);
            } else if (/\.(ts|js)$/.test(e.name)) {
                out.push(path.relative(OVERRIDES_DIR, p).split(path.sep).join('/'));
            }
        }
    };
    if (fs.existsSync(OVERRIDES_DIR)) {
        walk(OVERRIDES_DIR);
    }
    return out.sort();
}

// Removes a directory we created under build/tmp/client (refuses anything else, as a guard against bad paths).
export function removeTmpDir(dir) {
    const abs = path.resolve(dir);
    if (!abs.startsWith(TMP_DIR + path.sep)) {
        throw new Error(`refusing to delete ${abs}: not inside ${TMP_DIR}`);
    }
    fs.rmSync(abs, { recursive: true, force: true });
}

export function copyUpstreamTree(webclientDir, dest) {
    removeTmpDir(dest);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of TREE_ENTRIES) {
        const src = path.join(webclientDir, entry);
        if (!fs.existsSync(src)) {
            throw new Error(`webclient input is missing ${src}`);
        }
        fs.cpSync(src, path.join(dest, entry), { recursive: true });
    }
}

// `git apply` outside any repository. GIT_CEILING_DIRECTORIES stops git from discovering an enclosing work tree:
// inside one, git interprets patch paths relative to that repository's root and silently skips the rest.
function git(cwd, args, opts = {}) {
    return spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd), ...(opts.env ?? {}) },
        input: opts.input
    });
}

export function applyPatches(treeDir, patches, { baseCommit, webclientCommit } = {}) {
    for (const patch of patches) {
        const name = path.basename(patch);
        const check = git(treeDir, ['apply', '--check', '--whitespace=nowarn', patch]);
        if (check.error) {
            throw new Error(`cannot run git (needed to apply ${name}): ${check.error.message}`);
        }
        if (check.status !== 0) {
            const drift =
                baseCommit && webclientCommit && baseCommit !== webclientCommit
                    ? `\nThe patches were made against webclient ${baseCommit}; the input is now ${webclientCommit}.`
                    : '';
            throw new Error(
                `client patch ${name} no longer applies to the webclient source:\n${(check.stderr || check.stdout).trim()}${drift}\n` +
                    'Rebase the patches with `node web/client/patches.mjs edit --onto-current` (git 3-way rebase in ' +
                    'build/tmp/client/patch-work), resolve, then `node web/client/patches.mjs export` ' +
                    '(see web/client/README.md, "Updating the patches").'
            );
        }
        const apply = git(treeDir, ['apply', '--whitespace=nowarn', patch]);
        if (apply.status !== 0) {
            throw new Error(`git apply ${name} failed after a successful --check:\n${apply.stderr}`);
        }
    }
}

export function readBaseCommit() {
    const f = path.join(PATCHES_DIR, 'BASE');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\s+/)[0] : null;
}

export function webclientCommit(webclientDir) {
    try {
        return execFileSync('git', ['-C', webclientDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null; // not a git checkout (e.g. a source tarball): nothing to compare
    }
}

export { git };
