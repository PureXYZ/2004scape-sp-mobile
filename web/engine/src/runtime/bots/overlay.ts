// The bots' content-script overlay (docs/BOTS.md §2): after every ScriptProvider.load (World.start and the ::reload
// cheat), the scripts in /engine/data/bot/scripts.bin (bots/content/compile.mjs has the format) take the place of their
// vanilla entries. Only if ALL of them still match the loaded pack - each id has the same name and the same vanilla bytes
// (CRC) the overlay was diffed against - is anything replaced; otherwise the vanilla scripts stay and the caller
// switches the bots off. The result is what ScriptProvider.parse would have built from a pack with these scripts in it.
import ScriptFile from '#/engine/script/ScriptFile.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import Packet from '#/io/Packet.js';

import { vfs } from '../../shims/vfs.js';

export const OVERLAY_PATH = '/engine/data/bot/scripts.bin';
const MAGIC = 'LCBOTSC1';

interface Overlay {
    entries: number;
    commands: Map<string, number>;
    scripts: { id: number; name: string; vanillaCrc: number; bytes: Uint8Array }[];
}

// ScriptProvider's tables (private in TypeScript only)
type Internals = { scripts: ScriptFile[]; scriptLookup: Map<number, ScriptFile>; scriptNames: Map<string, number> };
const provider = ScriptProvider as unknown as Internals;

export const overlayStats = { applied: 0, scripts: 0, lastError: null as string | null };

/** Install-time check of what this module relies on in ScriptProvider. */
export function overlayTargetsMissing(): string[] {
    const missing: string[] = [];
    if (typeof ScriptProvider.load !== 'function') missing.push('ScriptProvider.load');
    if (!Array.isArray(provider.scripts)) missing.push('ScriptProvider.scripts');
    if (!(provider.scriptLookup instanceof Map)) missing.push('ScriptProvider.scriptLookup');
    if (!(provider.scriptNames instanceof Map)) missing.push('ScriptProvider.scriptNames');
    return missing;
}

function parse(data: Uint8Array): Overlay {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const latin1 = (start: number, end: number) => String.fromCharCode(...data.subarray(start, end));
    if (latin1(0, 8) !== MAGIC) throw new Error('not a bots script overlay (magic)');
    let p = 8 + 64; // sha256 of the vanilla script.dat and .idx: checked at build time
    const entries = view.getUint32(p);
    p += 4;
    const commands = new Map<string, number>();
    for (let n = data[p++]; n > 0; n--) {
        const length = data[p++];
        commands.set(latin1(p, p + length), view.getUint16(p + length));
        p += length + 2;
    }
    const scripts: Overlay['scripts'] = [];
    const scriptCount = view.getUint16(p);
    p += 2;
    for (let n = scriptCount; n > 0; n--) {
        const id = view.getUint32(p);
        const nameLength = view.getUint16(p + 4);
        p += 6;
        const name = latin1(p, p + nameLength);
        p += nameLength;
        const vanillaCrc = view.getInt32(p);
        const length = view.getUint32(p + 4);
        p += 8;
        scripts.push({ id, name, vanillaCrc, bytes: data.slice(p, p + length) });
        p += length;
    }
    if (p !== data.length) throw new Error('scripts.bin has trailing bytes');
    return { entries, commands, scripts };
}

let overlay: Overlay | null = null;

/** The overlay as shipped (read from the vfs once, before the start-up data is released; kept for ::reload). */
export function loadOverlay(): Overlay {
    return (overlay ??= parse(vfs.read(OVERLAY_PATH)));
}

/** Puts the overlay in place over the scripts just loaded from `dir`; returns why it could not, or null. */
export function applyOverlay(dir: string, commands: Record<string, number>): string | null {
    let o: Overlay;
    try {
        o = loadOverlay();
    } catch (e) {
        return `${OVERLAY_PATH} is unreadable (${e instanceof Error ? e.message : e})`;
    }
    for (const [name, opcode] of Object.entries(commands)) {
        if (o.commands.get(name) !== opcode) return `scripts.bin was compiled with ${name} = ${o.commands.get(name)}, the engine-bots bundle has ${opcode}`;
    }

    // the vanilla pack these scripts were diffed against: same size, and per id the same name and bytes
    const dat = vfs.read(`${dir}/server/script.dat`);
    const idx = vfs.read(`${dir}/server/script.idx`);
    const datView = new DataView(dat.buffer, dat.byteOffset, dat.byteLength);
    const idxView = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    const entries = datView.getInt32(0);
    if (entries !== o.entries) return `scripts.bin was made for a pack of ${o.entries} scripts; this one has ${entries}`;
    const wanted = new Map(o.scripts.map(s => [s.id, s]));
    const mismatches: string[] = [];
    for (let id = 0, ip = 4, dp = 8; id < entries && wanted.size; id++, ip += 4) {
        const size = idxView.getInt32(ip);
        const s = wanted.get(id);
        if (s) {
            wanted.delete(id);
            const loaded = ScriptProvider.get(id);
            if (loaded?.name !== s.name) mismatches.push(`${id} is ${loaded?.name ?? 'missing'}, not ${s.name}`);
            // (a view from 0: Packet.getcrc's third argument is the end index, not a length)
            else if (size === 0 || Packet.getcrc(dat.subarray(dp, dp + size), 0, size) !== s.vanillaCrc) mismatches.push(`${s.name} (${id}) changed`);
        }
        dp += size;
    }
    for (const s of wanted.values()) mismatches.push(`${s.name} (${s.id}) is not in the pack`);
    if (mismatches.length) return `scripts.bin does not match the packed scripts: ${mismatches.slice(0, 5).join('; ')}${mismatches.length > 5 ? ` (+${mismatches.length - 5})` : ''}`;

    // decode everything first: a bad blob leaves the vanilla scripts untouched
    const decoded: ScriptFile[] = [];
    for (const s of o.scripts) {
        let script: ScriptFile;
        try {
            script = ScriptFile.decode(s.id, new Packet(s.bytes));
        } catch (e) {
            return `scripts.bin: ${s.name} does not decode (${e instanceof Error ? e.message : e})`;
        }
        if (script.name !== s.name) return `scripts.bin: script ${s.id} decodes as ${script.name}, not ${s.name}`;
        decoded.push(script);
    }
    for (const script of decoded) {
        const old = provider.scripts[script.id];
        // as ScriptProvider.parse: the lookup key maps to the script that has it (the patches keep every trigger)
        if (provider.scriptLookup.get(old.info.lookupKey) === old) provider.scriptLookup.delete(old.info.lookupKey);
        provider.scripts[script.id] = script;
        if (script.info.lookupKey !== 0xffffffff && !provider.scriptLookup.has(script.info.lookupKey)) provider.scriptLookup.set(script.info.lookupKey, script);
        provider.scriptNames.set(script.name, script.id);
    }
    overlayStats.applied++;
    overlayStats.scripts = decoded.length;
    return null;
}
