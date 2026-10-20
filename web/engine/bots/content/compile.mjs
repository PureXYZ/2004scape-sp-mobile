#!/usr/bin/env node
// Bots content-script overlay (docs/BOTS.md §2): Progressive's bot hunks of trade.rs2, death.rs2 and engine.rs2
// (*.patch here, made against Server/content at the commit in BASE) compiled with Server/engine's own script
// compiler, diffed against the vanilla packed scripts. Only the scripts that differ ship, in scripts.bin; the bots
// glue (web/engine/src/runtime/bots/overlay.ts) puts them in place of their vanilla entries after every
// ScriptProvider.load.
//
//   node web/engine/bots/content/compile.mjs [--force] [--engine-dir <dir>] [--content-dir <dir>] [--verbose] [--allow-base-mismatch]
//   import { compileBotScripts } from './web/engine/bots/content/compile.mjs';
//
// Nothing is written under Server/: the content is cloned to build/tmp/bots/run-<pid>/content and patched there,
// and the compiler runs in place under Server/engine's tsx with its cwd in build/tmp/bots/run-<pid>/work (its
// output, data/pack/server/script.{dat,idx}, lands there). Cached in build/tmp/bots by
// sha256(vanilla script.dat + .idx, patches + BASE, this compiler, the opcode file, the runescript version), so a
// cached build (also with --skip-pack) only hashes the inputs. Invariant: only scripts from patched files differ
// from vanilla, otherwise the vanilla pack is stale against Server/content (or built by another compiler) and the
// compile fails.
//
// scripts.bin (big endian):
//   "LCBOTSC1"                                   8 bytes magic (bots script overlay, format 1)
//   sha256(vanilla script.dat)                   32 bytes   the pack this overlay was diffed against
//   sha256(vanilla script.idx)                   32 bytes
//   u32 entries                                  script slots in that pack (its first 4 bytes)
//   u8 commandCount, commandCount × { u8 nameLength, name (ASCII, e.g. p_isbot), u16 opcode }
//   u16 scriptCount, scriptCount × {
//       u32 id, u16 nameLength, name (ISO-8859-1, e.g. [proc,player_death_lose_items]),
//       s32 vanillaCrc (Packet.getcrc of the vanilla script's bytes it replaces),
//       u32 length, bytes (the compiled script, its embedded source path set to the vanilla one's) }
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONTENT_DIR, ENGINE_DIR } from '../../../../scripts/lib/upstream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IOS = path.resolve(HERE, '../../../..');
export const COMMANDS_FILE = path.resolve(HERE, '../src/port/BotScriptCommands.ts');
export const TMP = path.join(IOS, 'build/tmp/bots');
export const SCRIPTS_BIN_MAGIC = 'LCBOTSC1';
const FORMAT_KEY = 'lostcity-ios bots script overlay v1';

const sha256 = (...parts) => {
    const h = crypto.createHash('sha256');
    for (const p of parts) h.update(p);
    return h.digest();
};

export function listPatches() {
    return fs
        .readdirSync(HERE)
        .filter(f => f.endsWith('.patch'))
        .sort()
        .map(f => path.join(HERE, f));
}

/** Content files a patch touches, relative to the content root (scripts/...). */
export function patchedFiles(patchFile) {
    const out = new Set();
    for (const m of fs.readFileSync(patchFile, 'utf8').matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) out.add(m[2]);
    return [...out];
}

export function readBase() {
    const f = path.join(HERE, 'BASE');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\s+/)[0] : null;
}

/** P_ISBOT / P_BOT_INTERACT_TRADE from BotScriptCommands.ts (a module with no imports: plain constants). */
export function readCommandNumbers(file = COMMANDS_FILE) {
    const src = fs.readFileSync(file, 'utf8');
    const out = {};
    for (const m of src.matchAll(/^export const (P_[A-Z_]+) = (\d+);/gm)) out[m[1]] = Number(m[2]);
    if (!Number.isInteger(out.P_ISBOT) || !Number.isInteger(out.P_BOT_INTERACT_TRADE)) {
        throw new Error(`${path.relative(IOS, file)} must export P_ISBOT and P_BOT_INTERACT_TRADE as integer constants`);
    }
    return out;
}

function runescriptVersion(engineDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(engineDir, 'node_modules/@lostcityrs/runescript/package.json'), 'utf8')).version ?? 'unknown';
    } catch {
        return 'missing';
    }
}

function vanillaPack(engineDir) {
    const dat = path.join(engineDir, 'data/pack/server/script.dat');
    const idx = path.join(engineDir, 'data/pack/server/script.idx');
    for (const f of [dat, idx]) {
        if (!fs.existsSync(f)) throw new Error(`${f} is missing: the engine data is not packed (run \`npm run build\` in ${engineDir})`);
    }
    return { dat: fs.readFileSync(dat), idx: fs.readFileSync(idx) };
}

function cacheKey(engineDir, vanilla) {
    const parts = [FORMAT_KEY, vanilla.dat, vanilla.idx];
    for (const p of listPatches()) parts.push(path.basename(p), fs.readFileSync(p));
    parts.push('BASE', readBase() ?? '');
    for (const f of [fileURLToPath(import.meta.url), path.join(HERE, 'compile.mts'), COMMANDS_FILE]) parts.push(path.basename(f), fs.readFileSync(f));
    parts.push('runescript', runescriptVersion(engineDir));
    return sha256(...parts).toString('hex');
}

// ---- script packs ---------------------------------------------------------------------------------------------

/** script.dat/.idx -> Map(id -> Buffer), as ScriptProvider.parse reads them. */
export function readScriptPack(dat, idx) {
    const entries = dat.readInt32BE(0);
    if (idx.readInt32BE(0) !== entries) throw new Error('script.dat and script.idx disagree on the number of scripts');
    const version = dat.readInt32BE(4);
    const scripts = new Map();
    let dp = 8;
    for (let id = 0, ip = 4; id < entries; id++, ip += 4) {
        const size = idx.readInt32BE(ip);
        if (size === 0) continue;
        scripts.set(id, dat.subarray(dp, dp + size));
        dp += size;
    }
    if (dp !== dat.length) throw new Error(`script.dat: ${dat.length - dp} trailing bytes`);
    return { entries, version, scripts };
}

// header: name\0 sourcePath\0 rest (ScriptFile.decode)
export function splitHeader(blob) {
    const n0 = blob.indexOf(0);
    const p0 = blob.indexOf(0, n0 + 1);
    if (n0 < 0 || p0 < 0) throw new Error('bad script header');
    return { name: blob.subarray(0, n0).toString('latin1'), source: blob.subarray(n0 + 1, p0).toString('latin1'), rest: blob.subarray(p0 + 1), restPos: p0 + 1 };
}

/**
 * The pack with every script's embedded source path made relative: '<contentDir>/scripts/x.rs2' becomes
 * 'content/scripts/x.rs2' (the compiler writes absolute paths, the builder's; only the basename is used at run time,
 * ScriptFile.fileName). contentDir may be a list of roots; each also counts by its real path. Any other absolute path
 * throws. Returns { dat, idx, blobs: Map(id -> Buffer) }.
 */
export function relativiseScriptPack(dat, idx, contentDir) {
    const roots = [...new Set([contentDir].flat().flatMap(d => [d, fs.realpathSync(d)]))];
    const { entries, version, scripts } = readScriptPack(dat, idx);
    const blobs = new Map();
    for (const [id, blob] of scripts) {
        const h = splitHeader(blob);
        const root = roots.find(r => h.source.startsWith(r + '/'));
        let source = h.source;
        if (root) source = 'content/' + h.source.slice(root.length + 1);
        else if (path.isAbsolute(h.source)) throw new Error(`script ${id} (${h.name}): source path ${h.source} is outside the content folder (${roots.join(', ')})`);
        blobs.set(id, Buffer.concat([Buffer.from(h.name + '\0' + source + '\0', 'latin1'), h.rest]));
    }
    const int32 = v => {
        const b = Buffer.alloc(4);
        b.writeInt32BE(v);
        return b;
    };
    const ids = [...Array(entries).keys()];
    return {
        dat: Buffer.concat([int32(entries), int32(version), ...ids.filter(id => blobs.has(id)).map(id => blobs.get(id))]),
        idx: Buffer.concat([int32(entries), ...ids.map(id => int32(blobs.get(id)?.length ?? 0))]),
        blobs
    };
}

/** [opcode, operand] list of a compiled script, with ScriptFile.decode's operand rules (opcode numbers from the engine). */
export function scriptOpcodes(blob, ops) {
    const length = blob.length;
    const trailerPos = length - blob.readUInt16BE(length - 2) - 12 - 2;
    let p = splitHeader(blob).restPos + 4; // after the lookup key
    p += 1 + blob[p]; // parameter types
    p += 2 + blob.readUInt16BE(p) * 8; // line number table (pc, line)
    const small = new Set([ops.RETURN, ops.POP_INT_DISCARD, ops.POP_STRING_DISCARD, ops.GOSUB, ops.JUMP]);
    const out = [];
    while (p < trailerPos) {
        const op = blob.readUInt16BE(p);
        p += 2;
        if (op === ops.PUSH_CONSTANT_STRING) {
            const z = blob.indexOf(0, p);
            out.push([op, blob.subarray(p, z).toString('latin1')]);
            p = z + 1;
        } else if (op <= 100 && !small.has(op)) {
            out.push([op, blob.readInt32BE(p)]);
            p += 4;
        } else {
            out.push([op, blob[p]]);
            p += 1;
        }
    }
    return out;
}

export function encodeScriptsBin({ datSha256, idxSha256, entries, commands, scripts }) {
    const parts = [Buffer.from(SCRIPTS_BIN_MAGIC, 'latin1'), datSha256, idxSha256];
    const u8 = v => Buffer.from([v]);
    const u16 = v => {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(v);
        return b;
    };
    const u32 = v => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(v >>> 0);
        return b;
    };
    parts.push(u32(entries), u8(commands.length));
    for (const { name, opcode } of commands) parts.push(u8(name.length), Buffer.from(name, 'latin1'), u16(opcode));
    parts.push(u16(scripts.length));
    for (const s of scripts) {
        const name = Buffer.from(s.name, 'latin1');
        parts.push(u32(s.id), u16(name.length), name, u32(s.vanillaCrc), u32(s.bytes.length), s.bytes);
    }
    return Buffer.concat(parts);
}

export function decodeScriptsBin(buf) {
    buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.subarray(0, 8).toString('latin1') !== SCRIPTS_BIN_MAGIC) throw new Error('not a bots script overlay (magic)');
    let p = 8;
    const datSha256 = buf.subarray(p, (p += 32)).toString('hex');
    const idxSha256 = buf.subarray(p, (p += 32)).toString('hex');
    const entries = buf.readUInt32BE(p);
    p += 4;
    const commands = [];
    for (let n = buf[p++]; n > 0; n--) {
        const len = buf[p++];
        const name = buf.subarray(p, (p += len)).toString('latin1');
        commands.push({ name, opcode: buf.readUInt16BE(p) });
        p += 2;
    }
    const scripts = [];
    const scriptCount = buf.readUInt16BE(p);
    p += 2;
    for (let n = scriptCount; n > 0; n--) {
        const id = buf.readUInt32BE(p);
        const nameLen = buf.readUInt16BE(p + 4);
        p += 6;
        const name = buf.subarray(p, (p += nameLen)).toString('latin1');
        const vanillaCrc = buf.readInt32BE(p);
        const len = buf.readUInt32BE(p + 4);
        p += 8;
        scripts.push({ id, name, vanillaCrc, bytes: buf.subarray(p, (p += len)) });
    }
    if (p !== buf.length) throw new Error(`scripts.bin: ${buf.length - p} trailing bytes`);
    return { datSha256, idxSha256, entries, commands, scripts };
}

// ---- the compile ----------------------------------------------------------------------------------------------

// `git apply` outside any repository: GIT_CEILING_DIRECTORIES keeps git from finding an enclosing work tree (inside
// one it would take the patch paths relative to that repository and silently skip the rest)
function gitApply(dir, patch, check) {
    const r = spawnSync('git', ['apply', ...(check ? ['--check'] : []), '--whitespace=nowarn', patch], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) }
    });
    if (r.error) throw new Error(`cannot run git (needed to apply ${path.basename(patch)}): ${r.error.message}`);
    return r;
}

function contentCommit(contentDir) {
    const r = spawnSync('git', ['-C', contentDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
}

const clone = (src, dst) => fs.cpSync(src, dst, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });

function compile({ engineDir, contentDir, vanilla, log, verbose }) {
    const tsx = path.join(engineDir, 'node_modules/tsx/dist/cli.mjs');
    if (!fs.existsSync(tsx)) throw new Error(`${tsx} is missing (run \`npm install\` in ${engineDir})`);
    for (const d of ['scripts', 'pack']) {
        if (!fs.existsSync(path.join(contentDir, d))) throw new Error(`${path.join(contentDir, d)} is missing`);
    }
    if (!fs.existsSync(path.join(contentDir, 'pack/script.pack'))) {
        throw new Error(`${contentDir}/pack/script.pack is missing: the content has never been packed (run \`npm run build\` in ${engineDir})`);
    }

    const run = path.join(TMP, `run-${process.pid}`);
    fs.rmSync(run, { recursive: true, force: true });
    const content = path.join(run, 'content');
    const work = path.join(run, 'work');
    try {
        const t0 = Date.now();
        // ../content: scripts + the *.pack id maps (incl. the packer's generated ones), then the patches
        clone(path.join(contentDir, 'scripts'), path.join(content, 'scripts'));
        clone(path.join(contentDir, 'pack'), path.join(content, 'pack'));
        const base = readBase();
        const head = contentCommit(contentDir);
        for (const patch of listPatches()) {
            const check = gitApply(content, patch, true);
            if (check.status !== 0) {
                const drift = base && head && base !== head ? `\nThe patches were made against Server/content ${base}; it is now ${head}.` : '';
                throw new Error(
                    `bots content patch ${path.basename(patch)} no longer applies to Server/content:\n${(check.stderr || check.stdout).trim()}${drift}\n` +
                        'Re-make it from Progressive\'s bot hunks against the current content (web/engine/README.md, "Bots"), and update BASE.'
                );
            }
            const r = gitApply(content, patch, false);
            if (r.status !== 0) throw new Error(`git apply ${path.basename(patch)} failed after a successful --check:\n${r.stderr}`);
        }
        // work: the compile context (config packs); script.dat/.idx are the compiler's output, so not cloned
        const packServer = path.join(engineDir, 'data/pack/server');
        fs.mkdirSync(path.join(work, 'data/pack/server'), { recursive: true });
        for (const f of fs.readdirSync(packServer)) {
            if (!f.startsWith('script.')) clone(path.join(packServer, f), path.join(work, 'data/pack/server', f));
        }
        if (fs.existsSync(path.join(engineDir, 'data/pack/client'))) clone(path.join(engineDir, 'data/pack/client'), path.join(work, 'data/pack/client'));
        const prepMs = Date.now() - t0;

        const t1 = Date.now();
        const r = spawnSync(process.execPath, [tsx, '--tsconfig', path.join(engineDir, 'tsconfig.json'), path.join(HERE, 'compile.mts')], {
            cwd: work,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, LC_ENGINE_DIR: engineDir, LC_BOT_COMMANDS: COMMANDS_FILE }
        });
        const out = (r.stdout ?? '') + (r.stderr ?? '');
        const line = out.split('\n').find(l => l.startsWith('RESULT '));
        if (r.status !== 0 || !line) throw new Error(`the bots script compile failed (exit ${r.status}${r.signal ? `, ${r.signal}` : ''}):\n${out.trim().split('\n').slice(-30).join('\n')}`);
        if (verbose) log(out.trim());
        const compiled = JSON.parse(line.slice(7));

        const overlay = {
            dat: fs.readFileSync(path.join(work, 'data/pack/server/script.dat')),
            idx: fs.readFileSync(path.join(work, 'data/pack/server/script.idx'))
        };
        const diff = diffPacks({ vanilla, overlay, contentRoots: [content, fs.realpathSync(content)], compiled });
        return { ...diff, compiled, prepMs, compileMs: Date.now() - t1 };
    } finally {
        fs.rmSync(run, { recursive: true, force: true });
    }
}

function diffPacks({ vanilla, overlay, contentRoots, compiled }) {
    const V = readScriptPack(vanilla.dat, vanilla.idx);
    const O = readScriptPack(overlay.dat, overlay.idx);
    if (V.version !== O.version) throw new Error(`compiler version ${O.version} differs from the vanilla pack's ${V.version}: the vanilla pack is stale (run the engine packer)`);
    const patched = new Set(listPatches().flatMap(patchedFiles));
    const relOf = source => {
        for (const root of contentRoots) if (source.startsWith(root + '/')) return source.slice(root.length + 1);
        return null;
    };
    const changed = [];
    const outside = [];
    for (let id = 0; id < Math.max(V.entries, O.entries); id++) {
        const v = V.scripts.get(id);
        const o = O.scripts.get(id);
        if (!v || !o) {
            if (v || o) outside.push(`${id}: only in the ${v ? 'vanilla' : 'overlay'} pack (${splitHeader(v ?? o).name})`);
            continue;
        }
        const vh = splitHeader(v);
        const oh = splitHeader(o);
        const rel = relOf(oh.source);
        // the overlay compiled from build/tmp/...; ship it with the vanilla script's source path (only the basename
        // is used at run time, ScriptFile.fileName) so it is exactly what a vanilla-located compile would produce
        const bytes = Buffer.concat([Buffer.from(oh.name + '\0' + vh.source + '\0', 'latin1'), oh.rest]);
        if (bytes.equals(v)) continue;
        if (vh.name !== oh.name || !rel || !vh.source.endsWith('/' + rel)) {
            outside.push(`${id}: ${vh.name} (${vh.source}) vs ${oh.name} (${oh.source})`);
        } else if (!patched.has(rel)) {
            outside.push(`${id}: ${oh.name} (${rel})`);
        } else {
            changed.push({ id, name: oh.name, file: rel, bytes, vanillaCrc: zlib.crc32(v) | 0 });
        }
    }
    if (V.entries !== O.entries) outside.push(`script count ${O.entries} vs vanilla ${V.entries}`);
    if (outside.length) {
        throw new Error(
            `the bots script overlay differs from the vanilla script.dat outside the patched files (${outside.length}):\n  ${outside.slice(0, 12).join('\n  ')}\n` +
                'The engine pack (Server/engine/data/pack/server/script.dat) is stale against Server/content or was built by another compiler: ' +
                'run scripts/build-web.mjs without --skip-pack (or `npm run build` in Server/engine).'
        );
    }
    // every bot command is really used, and the death proc opens with p_isbot
    const uses = Object.fromEntries(Object.keys(compiled.commands).map(n => [n, 0]));
    for (const s of changed) {
        const ops = scriptOpcodes(s.bytes, compiled.opcodes);
        for (const [n, opcode] of Object.entries(compiled.commands)) uses[n] += ops.filter(([op]) => op === opcode).length;
        s.firstOpcode = ops[0]?.[0];
    }
    const death = changed.find(s => s.name === '[proc,player_death_lose_items]');
    if (!death || death.firstOpcode !== compiled.commands.p_isbot || Object.values(uses).some(n => n === 0)) {
        throw new Error(`the compiled overlay does not use the bot commands as expected: ${JSON.stringify({ uses, deathFirstOpcode: death?.firstOpcode })}`);
    }
    return { entries: V.entries, changed, uses };
}

/**
 * Compiles the overlay (or reuses the cached one). Returns { file, key, reused, ms, scripts: [{id, name, file, bytes}],
 * bytes, uses, base, patches, vanilla: {datSha256, idxSha256} }.
 *
 * The content checkout must be at BASE's commit: otherwise it throws an error with code 'LC_BASE_MISMATCH' (before
 * the cache is looked at), which build-web.mjs treats as fatal rather than building without the bots.
 * allowBaseMismatch tries the patches anyway (build-web.mjs --allow-upstream-mismatch).
 */
export async function compileBotScripts({ engineDir, contentDir, force = false, log = console.log, verbose = false, allowBaseMismatch = false } = {}) {
    const t0 = Date.now();
    engineDir = path.resolve(engineDir ?? ENGINE_DIR);
    contentDir = path.resolve(contentDir ?? CONTENT_DIR);
    const base = readBase();
    const head = contentCommit(contentDir);
    if (base && head && base !== head && !allowBaseMismatch) {
        const e = new Error(
            `the bots' content patches (web/engine/bots/content) were made against content ${base} (BASE, as upstream.json pins it), ` +
                `but ${contentDir} is at ${head}. Check out the pinned commit (node scripts/fetch-upstream.mjs), or re-make the patches ` +
                'against this content and update BASE and upstream.json (web/engine/README.md, "Bots").'
        );
        e.code = 'LC_BASE_MISMATCH';
        throw e;
    }
    const vanilla = vanillaPack(engineDir);
    const key = cacheKey(engineDir, vanilla);
    const file = path.join(TMP, 'scripts.bin');
    const metaFile = path.join(TMP, 'scripts.json');
    if (!force && fs.existsSync(file) && fs.existsSync(metaFile)) {
        try {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
            if (meta.key === key && sha256(fs.readFileSync(file)).toString('hex') === meta.sha256) {
                return { ...meta, file, reused: true, ms: Date.now() - t0 };
            }
        } catch {
            // unreadable cache: compile again
        }
    }

    log(`[bots] compiling the content-script overlay (${listPatches().length} patches) with the engine's compiler…`);
    const r = compile({ engineDir, contentDir, vanilla, log, verbose });
    const commandNumbers = readCommandNumbers();
    const commands = [
        { name: 'p_isbot', opcode: commandNumbers.P_ISBOT },
        { name: 'p_bot_interact_trade', opcode: commandNumbers.P_BOT_INTERACT_TRADE }
    ];
    for (const c of commands) {
        if (r.compiled.commands[c.name] !== c.opcode) throw new Error(`compile.mts registered ${c.name} as ${r.compiled.commands[c.name]}, expected ${c.opcode}`);
    }
    const bin = encodeScriptsBin({ datSha256: sha256(vanilla.dat), idxSha256: sha256(vanilla.idx), entries: r.entries, commands, scripts: r.changed });
    const meta = {
        key,
        sha256: sha256(bin).toString('hex'),
        bytes: bin.length,
        base: readBase(),
        patches: listPatches().map(p => path.basename(p)),
        vanilla: { datSha256: sha256(vanilla.dat).toString('hex'), idxSha256: sha256(vanilla.idx).toString('hex'), entries: r.entries },
        commands,
        uses: r.uses,
        scripts: r.changed.map(s => ({ id: s.id, name: s.name, file: s.file, bytes: s.bytes.length })),
        compiledAt: new Date().toISOString(),
        timings: { prepMs: r.prepMs, compileMs: r.compileMs, compilerMs: r.compiled.ms }
    };
    fs.mkdirSync(TMP, { recursive: true });
    for (const [f, data] of [
        [file, bin],
        [metaFile, JSON.stringify(meta, null, 2) + '\n']
    ]) {
        fs.writeFileSync(`${f}.${process.pid}.tmp`, data);
        fs.renameSync(`${f}.${process.pid}.tmp`, f);
    }
    return { ...meta, file, reused: false, ms: Date.now() - t0 };
}

// ---- CLI ------------------------------------------------------------------------------------------------------

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const args = process.argv.slice(2);
    const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    try {
        const r = await compileBotScripts({ engineDir: opt('--engine-dir'), contentDir: opt('--content-dir'), force: args.includes('--force'), verbose: args.includes('--verbose'), allowBaseMismatch: args.includes('--allow-base-mismatch') });
        console.log(
            `bots script overlay: ${r.scripts.length} scripts, ${r.bytes} bytes, ${r.reused ? 'cached' : `compiled (${r.timings.compileMs} ms)`}, ${r.ms} ms; ` +
                `key ${r.key.slice(0, 12)}, vanilla script.dat ${r.vanilla.datSha256.slice(0, 12)}`
        );
        if (args.includes('--verbose')) for (const s of r.scripts) console.log(`  ${String(s.id).padStart(5)} ${s.name} (${s.file}) ${s.bytes} B`);
    } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        process.exit(1);
    }
}
