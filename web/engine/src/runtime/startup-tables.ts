// Midi.load() and AnimFrame.load() from the build's start-up tables (web/engine/startup-tables.mjs) instead of the
// cache. World.start gunzipped all 345 MIDI files (archive 3) to measure each song's length and all 336 animation files
// (archive 2, through SeqType.load) to read each frame's delay: 36 % of World.start in JavaScriptCore, and the frames'
// transform arrays (~12 MB) stayed in memory. The table holds what the same loaders compute from this cache:
//   Midi.lengths, and what Midi.load printed;
//   per frame id AnimFrame.instances[id].delay, .base, .length, and AnimFrame.order.
// The frames' groups/x/y/z arrays and AnimBase are not kept: the server never reads them (SeqType.ts:108 reads
// .delay; Midi is read through getLength/getTickLength). A loader runs the original instead - the same values and
// warnings - when the table is missing or unreadable, or the cache is not the one it was made from (the number of
// files in the archive and the CRC of its index file). The table is dropped once both loaders have used it.
import fs from 'fs';

import AnimFrame from '#/cache/graphics/AnimFrame.js';
import Midi from '#/cache/midi/Midi.js';
import OnDemand from '#/engine/OnDemand.js';
import Packet from '#/io/Packet.js';
import { printDebug, printError, printInfo, printWarning } from '#/util/Logger.js';

const TABLES = 'data/derived/startup-tables.json'; // build.mjs stages it (relative to the vfs cwd /engine)
const VERSION = 1;

type Printed = Array<[string, string]>;
interface Tables {
    version: number;
    cache: Record<string, { count: number; crc: number }>;
    midi: { lengths: number[]; printed: Printed };
    anim: { ids: number[]; delays: number[]; bases: number[]; lengths: number[]; order: number[]; printed: Printed };
}

let tables: Tables | null | undefined; // undefined: not read yet; null: none (or used up)
const used = new Set<string>();

function read(): Tables | null {
    if (tables !== undefined) return tables;
    tables = null;
    if (!fs.existsSync(TABLES)) return null;
    try {
        const t = JSON.parse(fs.readFileSync(TABLES, 'utf8') as string) as Tables;
        if (t?.version === VERSION && t.cache && t.midi && t.anim) tables = t;
        else console.warn(`[engine] ${TABLES} is not a version ${VERSION} table: the loaders read the cache`);
    } catch (e) {
        console.warn(`[engine] ${TABLES} is unreadable: the loaders read the cache`, e);
    }
    return tables;
}

/** The table was made from this cache's archive (its file count and the CRC of its index file). */
function fits(t: Tables, archive: number): boolean {
    const guard = t.cache[archive];
    const count = OnDemand.cache.count(archive);
    if (!guard || !count || guard.count !== count) return false;
    const idx = fs.readFileSync(`data/pack/main_file_cache.idx${archive}`) as Uint8Array;
    return Packet.getcrc(idx, 0, idx.length) === guard.crc;
}

/** A loader has run (from the table or not): once both have, the table is let go (::reload calls neither again). */
function done(part: string) {
    used.add(part);
    if (used.has('midi') && used.has('anim')) tables = null;
}

const LOGGER: Record<string, (message: string) => void> = { printWarning, printInfo, printDebug, printError };

/** What the loader printed for this cache, again (none for the 274 cache; Midi.load warns of a song it cannot read). */
function reprint(printed: Printed) {
    for (const [fn, message] of printed) (LOGGER[fn] ?? printWarning)(message);
}

/** Patches Midi.load and AnimFrame.load (once, before World.start). */
export function installStartupTables(): void {
    const midiLoad = Midi.load;
    Midi.load = function (this: typeof Midi) {
        try {
            const t = read();
            if (!t || !fits(t, 3) || t.midi.lengths.length !== OnDemand.cache.count(3)) return midiLoad.call(this);
            Midi.lengths = t.midi.lengths.slice();
            reprint(t.midi.printed);
        } finally {
            done('midi');
        }
    };

    const animLoad = AnimFrame.load;
    AnimFrame.load = function (this: typeof AnimFrame) {
        try {
            const t = read();
            if (!t || !fits(t, 2)) return animLoad.call(this);
            loadFrames(t.anim);
        } finally {
            done('anim');
        }
    };
}

/** AnimFrame.instances and AnimFrame.order as AnimFrame.load leaves them, from the table. */
function loadFrames(a: Tables['anim']): void {
    const none = new Int32Array(0); // groups/x/y/z: never read on the server
    for (let k = 0; k < a.ids.length; k++) {
        const frame = Object.create(AnimFrame.prototype) as AnimFrame;
        frame.delay = a.delays[k];
        frame.base = a.bases[k];
        frame.length = a.lengths[k];
        frame.groups = none;
        frame.x = none;
        frame.y = none;
        frame.z = none;
        AnimFrame.instances[a.ids[k]] = frame;
    }
    for (let k = 0; k < a.order.length; k++) AnimFrame.order.push(a.order[k]);
    reprint(a.printed);
}
