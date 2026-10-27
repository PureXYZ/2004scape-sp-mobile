// Runtime patches for the engine's resident memory (imported by the entry before World.start; each imports only the
// engine class it patches, so the tests can install it on upstream's own and compare). Each keeps every value the
// engine reads the same.
//
// installSharedZeroZones: CollisionEngine keeps one Uint32Array(64) per 8x8 zone and level in a Map. GameMap.init
// allocates every zone of every mapsquare on all four levels (123 676) before it adds any flag, and 89 527 of them
// (72 %: open ground, and the upper levels where there is no floor) never get one. They share one all-zero array
// until something writes a non-zero value into them (copy on write): -26.5 MB of JavaScriptCore heap for the whole
// session. The Map keeps the same keys, added at the same moments, and every key the same 64 values, so get(),
// isFlagged(), isZoneAllocated(), zoneCount() (upstream's, unchanged) and everything built on them - the path
// finders, line of sight, the bots' route search, which reads `zones` itself - see the same numbers. Only set, add
// and remove write a zone (the change* methods all go through them); a write that leaves the tile 0 (remove, or add
// or set of 0) leaves the zone as it is either way. allocateIfAbsentByIndex, which nothing calls any more, still
// returns an array of the zone's own. test/collision.test.mjs runs seeded programs on upstream's engine and on the
// patched one and compares every read and every zone.
//
// installTypedScriptArrays: ScriptFile.decode builds each of the 10 938 scripts' opcodes and int operands, and its
// line table (info.pcs, info.lines), as plain arrays: 8 bytes an element in JavaScriptCore, with holes at the string
// instructions. They become typed arrays of the same values once decoded - opcodes Uint16Array (g2), int operands
// and the line table Int32Array (g1/g4s) -, -6 MB of JavaScriptCore heap. Their readers only index them and take
// .length (ScriptRunner, ScriptState.intOperand, ScriptFile.lineNumber; an index outside reads undefined either way).
// A string instruction's hole in the int operands reads 0 instead of undefined, and nothing reads it: the
// PUSH_CONSTANT_STRING handler reads its string operand, and the runner's error message takes 0 as `secondary` for
// every opcode up to POP_ARRAY_INT. decode is wrapped, so the bots' overlaid scripts (decoded by their glue) are typed
// too and opcodes[pc] stays monomorphic; a script whose values would not fit keeps its arrays.
import CollisionEngine from '#/engine/routefinder/CollisionEngine.js';
import ScriptFile from '#/engine/script/ScriptFile.js';

type Zones = { zones: Map<number, Uint32Array> };

const TILES = 64; // CollisionEngine.ZONE_TILE_COUNT

const tileIndex = (x: number, z: number): number => (x & 0x7) | ((z & 0x7) << 3);

/** Installs the shared all-zero zone on `Engine` (upstream's CollisionEngine unless a test passes its own copy). */
export function installSharedZeroZones(Engine: typeof CollisionEngine = CollisionEngine): Uint32Array {
    const ZERO = new Uint32Array(TILES); // never written
    const zoneIndex = Engine.zoneIndex;
    const proto = Engine.prototype as unknown as Record<string, unknown>;

    /** The zone's own array: made on its first non-zero write (for a zone that is absent or still the shared one). */
    const own = (engine: Zones, index: number): Uint32Array => {
        const zone = engine.zones.get(index);
        if (zone !== undefined && zone !== ZERO) return zone;
        const created = new Uint32Array(TILES);
        engine.zones.set(index, created); // (an existing key keeps its place in the Map)
        return created;
    };

    proto.allocateIfAbsentByIndex = function (this: Zones, index: number): Uint32Array {
        return own(this, index);
    };
    proto.allocateIfAbsent = function (this: Zones, x: number, z: number, y: number): void {
        const index = zoneIndex(x, z, y);
        if (!this.zones.has(index)) this.zones.set(index, ZERO);
    };
    proto.set = function (this: Zones, x: number, z: number, y: number, mask: number): void {
        const index = zoneIndex(x, z, y);
        const value = mask >>> 0;
        let zone = this.zones.get(index);
        if (zone === undefined || zone === ZERO) {
            if (value === 0) {
                if (zone === undefined) this.zones.set(index, ZERO);
                return;
            }
            zone = own(this, index);
        }
        zone[tileIndex(x, z)] = value;
    };
    proto.add = function (this: Zones, x: number, z: number, y: number, mask: number): void {
        const index = zoneIndex(x, z, y);
        let zone = this.zones.get(index);
        if (zone === undefined || zone === ZERO) {
            if (mask >>> 0 === 0) {
                // (0 | mask) >>> 0
                if (zone === undefined) this.zones.set(index, ZERO);
                return;
            }
            zone = own(this, index);
        }
        const tile = tileIndex(x, z);
        zone[tile] = (zone[tile] | mask) >>> 0;
    };
    proto.remove = function (this: Zones, x: number, z: number, y: number, mask: number): void {
        const index = zoneIndex(x, z, y);
        const zone = this.zones.get(index);
        if (zone === undefined || zone === ZERO) {
            // (0 & ~mask) >>> 0 is 0
            if (zone === undefined) this.zones.set(index, ZERO);
            return;
        }
        const tile = tileIndex(x, z);
        zone[tile] = (zone[tile] & ~mask) >>> 0;
    };
    return ZERO;
}

type Script = { opcodes: ArrayLike<number>; intOperands: ArrayLike<number | undefined>; info: { pcs: ArrayLike<number>; lines: ArrayLike<number> } };

/** Every element is a uint16. */
function uint16s(a: ArrayLike<number>): boolean {
    for (let i = 0; i < a.length; i++) if (a[i] !== (a[i] & 0xffff)) return false;
    return true;
}

/** Every element is an int32 (or a hole, where `holes`). */
function int32s(a: ArrayLike<number | undefined>, holes: boolean): boolean {
    for (let i = 0; i < a.length; i++) {
        const v = a[i];
        if (v !== (v! | 0) && !(holes && v === undefined)) return false;
    }
    return true;
}

/** Wraps `File.decode` (upstream's ScriptFile unless a test passes its own copy). */
export function installTypedScriptArrays(File: typeof ScriptFile = ScriptFile): void {
    const S = File as unknown as { decode: (id: number, stream: unknown) => Script };
    const decode = S.decode;
    S.decode = function (id: number, stream: unknown): Script {
        const script = decode.call(this, id, stream);
        if (Array.isArray(script.opcodes) && uint16s(script.opcodes)) script.opcodes = new Uint16Array(script.opcodes);
        // (a hole converts to 0: ToInt32(undefined))
        if (Array.isArray(script.intOperands) && int32s(script.intOperands, true)) script.intOperands = new Int32Array(script.intOperands as number[]);
        const info = script.info;
        if (Array.isArray(info.pcs) && Array.isArray(info.lines) && int32s(info.pcs, false) && int32s(info.lines, false)) {
            info.pcs = new Int32Array(info.pcs);
            info.lines = new Int32Array(info.lines);
        }
        return script;
    };
}
