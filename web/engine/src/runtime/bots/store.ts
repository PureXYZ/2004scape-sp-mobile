// The bot store (docs/BOTS.md §4.5): every bot's save in ONE file per profile, Documents/bots/<profile>/bots.sav, through
// the same native routes as the player saves (GET/PUT ../save/<relpath>, synchronous XHR, ArrayBuffer body; native
// writes atomically and keeps bots.sav.bak). Big endian:
//   "LCBOTS01"                       8 bytes magic
//   u16 count
//   count × { u8 nameLength, name (ASCII: the normalised username, a-z 0-9 _), u32 saveLength, save (a player .sav) }
// One record is not a bot: "_meta" (no username starts with '_') holds the store's own state as JSON, so a build from
// before it carries it over like any record it does not spawn:
//   { "v": 1, "ageing": true (its pool bots without a record get an age; every store has it from the build with 250/500
//     bots on, an older store as soon as that build reads it), "quit": [names of bots that quit for good],
//     "friends": { "<human>": { "friends": [names], "ignores": [names] } } (friends.ts: offline there is no friend server),
//     "world": the living world when the store was last written (BotManager.exportWorld: who was online, the rest of
//     their sessions, who is away until when, the newcomers due, the pool's size before a top-up), so the next launch
//     continues it }
// Read once when the bots start: 404 = no bots saved yet; corrupt = try bots.sav.bak; a read that fails (twice) or both
// corrupt = bots are off for the session (nothing may overwrite real progress). Written whole, after the human saves,
// at every save occasion (lifecycle pause/save, the engine's autosave, a human's logout, exit) and for the bots' own
// logouts at most once every 30 s of world time (routing.ts flushBots); records of bots that did not spawn are carried
// over unchanged.
// A failed write is logged, kept in memory and retried (15 s, next occasion, lifecycle resume); it is never a failed
// player save, but lifecycle-done says so apart (bots: {ok:false, error}: page.ts), so that a restart can wait for it.
import { saves } from '../saves.js';
import { xhrSync } from '../xhr.js';

const MAGIC = 'LCBOTS01';
/** The record that holds the store's own state (not a bot: usernames never start with '_'). */
export const META_RECORD = '_meta';
/** A "_meta" that cannot be read is kept, unchanged, under this name (and a fresh one is started). */
const META_DAMAGED = '_meta_bad';

export interface FriendLists {
    friends: string[];
    ignores: string[];
}

export interface StoreMeta {
    v: 1;
    /** the store was new when the bots made it: its pool bots get an age (port/BotAge) */
    ageing?: boolean;
    /** bots that quit for good: their names are never used again */
    quit: string[];
    /** each human character's friend and ignore lists (normalised names) */
    friends: Record<string, FriendLists>;
    /** the living world as it was (BotManager.exportWorld; BotManager.start checks it) */
    world?: unknown;
}

function emptyMeta(): StoreMeta {
    // (no prototype: a character may be called "constructor")
    return { v: 1, quit: [], friends: Object.create(null) as Record<string, FriendLists> };
}

const NAME = /^[a-z0-9_]{1,12}$/;

/** A "_meta" record as the store keeps it; throws if it is not one. */
export function parseMeta(data: Uint8Array): StoreMeta {
    const raw = JSON.parse(new TextDecoder().decode(data)) as Partial<StoreMeta> & { v?: unknown };
    if (!raw || typeof raw !== 'object' || raw.v !== 1) throw new Error('not a version 1 _meta');
    const names = (list: unknown) => (Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string' && NAME.test(n)) : []);
    const meta: StoreMeta = { ...emptyMeta(), quit: names(raw.quit) };
    if (raw.ageing === true) meta.ageing = true;
    if (raw.world && typeof raw.world === 'object') meta.world = raw.world;
    if (raw.friends && typeof raw.friends === 'object') {
        for (const [human, lists] of Object.entries(raw.friends)) {
            if (!NAME.test(human) || !lists || typeof lists !== 'object') continue;
            meta.friends[human] = { friends: names((lists as FriendLists).friends), ignores: names((lists as FriendLists).ignores) };
        }
    }
    return meta;
}

function encodeMeta(meta: StoreMeta): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(meta));
}

const RETRY_MS = 15000;
const MAX_SAVE = 1 << 20; // a player save is ~1 KB; anything near this is not one

function workerBase(): string {
    const loc = (globalThis as unknown as { location?: { href?: string } }).location;
    return loc?.href ?? import.meta.url;
}

/** Parses a store; throws on anything that is not exactly a well-formed one (the caller falls back to the .bak). */
export function parseBotStore(data: Uint8Array): Map<string, Uint8Array> {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < 10 || String.fromCharCode(...data.subarray(0, 8)) !== MAGIC) throw new Error('not a bot store (magic)');
    const count = view.getUint16(8);
    const records = new Map<string, Uint8Array>();
    let p = 10;
    for (let i = 0; i < count; i++) {
        if (p + 1 > data.length) throw new Error(`truncated at record ${i}`);
        const nameLength = data[p++];
        if (nameLength < 1 || nameLength > 12 || p + nameLength + 4 > data.length) throw new Error(`record ${i}: bad name length ${nameLength}`);
        const name = String.fromCharCode(...data.subarray(p, p + nameLength));
        p += nameLength;
        if (!NAME.test(name)) throw new Error(`record ${i}: bad name`);
        if (records.has(name)) throw new Error(`record ${i}: ${name} twice`);
        const saveLength = view.getUint32(p);
        p += 4;
        if (saveLength > MAX_SAVE || p + saveLength > data.length) throw new Error(`record ${i} (${name}): bad save length ${saveLength}`);
        records.set(name, data.slice(p, p + saveLength));
        p += saveLength;
    }
    if (p !== data.length) throw new Error(`${data.length - p} bytes after the last record`);
    return records;
}

export function encodeBotStore(records: Map<string, Uint8Array>): Uint8Array {
    let size = 10;
    for (const [name, save] of records) size += 1 + name.length + 4 + save.length;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) out[i] = MAGIC.charCodeAt(i);
    view.setUint16(8, records.size);
    let p = 10;
    for (const [name, save] of records) {
        out[p++] = name.length;
        for (let i = 0; i < name.length; i++) out[p++] = name.charCodeAt(i);
        view.setUint32(p, save.length);
        p += 4;
        out.set(save, p);
        p += save.length;
    }
    return out;
}

/** A failed load says why: bots.sav could not be read (an I/O error), or it and its .bak are not a bot store. */
export type StoreLoad = { ok: true; source: 'none' | 'file' | 'bak'; count: number } | { ok: false; kind: 'unreadable' | 'corrupt'; error: string };

export class BotStore {
    /** the bots' saves (and a damaged "_meta", kept as it was) */
    readonly records = new Map<string, Uint8Array>();
    /** the "_meta" record, read and written apart from the bots */
    meta: StoreMeta = emptyMeta();
    /** loaded successfully: only then may it ever be written */
    loaded = false;
    source: 'none' | 'file' | 'bak' | null = null;
    dirty = false;
    writes = 0;
    failures = 0;
    lastBytes = 0;
    /** why the last write failed (null once one succeeded): lifecycle-done's bots.error (page.ts) */
    lastError: string | null = null;
    private failing = false;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

    relPath(file = 'bots.sav'): string {
        return `bots/${saves.profile()}/${file}`;
    }

    private url(rel: string): string {
        return new URL(`../save/${rel}`, workerBase()).href;
    }

    load(): StoreLoad {
        if (this.loaded) return { ok: true, source: this.source ?? 'none', count: [...this.botNames()].length };
        let main = xhrSync('GET', this.url(this.relPath()));
        if (main.status !== 200 && main.status !== 404) main = xhrSync('GET', this.url(this.relPath())); // once more
        if (main.status === 404) return this.use(new Map(), 'none');
        if (main.status !== 200 || !main.data) {
            // Not read (an I/O error), which says nothing about the file: never fall back to the older .bak here, its
            // first write would rotate the newer bots.sav away (the human logins' rule too: a failed read refuses)
            return { ok: false, kind: 'unreadable', error: `${this.relPath()} cannot be read (HTTP ${main.status}${main.error ? ` ${main.error}` : ''})` };
        }
        let mainProblem: string;
        try {
            return this.use(parseBotStore(main.data), 'file');
        } catch (e) {
            mainProblem = `is corrupt (${e instanceof Error ? e.message : e})`;
        }
        const bak = xhrSync('GET', this.url(this.relPath('bots.sav.bak')));
        let bakProblem: string;
        if (bak.status === 200 && bak.data) {
            try {
                const records = parseBotStore(bak.data);
                console.warn(`[bots] ${this.relPath()} ${mainProblem}: using bots.sav.bak (${records.size - (records.has(META_RECORD) ? 1 : 0)} bots)`);
                return this.use(records, 'bak');
            } catch (e) {
                bakProblem = `is corrupt (${e instanceof Error ? e.message : e})`;
            }
        } else {
            bakProblem = bak.status === 404 ? 'does not exist' : `cannot be read (HTTP ${bak.status})`;
        }
        return { ok: false, kind: 'corrupt', error: `${this.relPath()} ${mainProblem} and bots.sav.bak ${bakProblem}` };
    }

    private use(records: Map<string, Uint8Array>, source: 'none' | 'file' | 'bak'): StoreLoad {
        const meta = records.get(META_RECORD);
        records.delete(META_RECORD);
        for (const [name, save] of records) this.records.set(name, save);
        if (source === 'none') {
            // a new store: the bots that make it get an age (BOTS.md §4.4); a store from before this has no "_meta"
            this.meta = { ...emptyMeta(), ageing: true };
            this.dirty = true;
        } else if (meta) {
            try {
                this.meta = parseMeta(meta);
            } catch (e) {
                console.error(`[bots] ${this.relPath()}: its ${META_RECORD} cannot be read (${e instanceof Error ? e.message : e}); kept as ${META_DAMAGED}, starting a new one`);
                this.records.set(META_DAMAGED, meta);
                this.meta = emptyMeta();
            }
        }
        if (this.meta.ageing !== true) {
            // an older store (no "_meta", or one from when only a new store aged its bots): its saved bots keep what they
            // have, the pool bots it has no record of yet get an age too (raising an old world's count should not bring
            // hundreds of level-3s to Lumbridge; BOTS.md §4.4); written with the next save, so it stays that way
            this.meta.ageing = true;
            this.dirty = true;
        }
        this.loaded = true;
        this.source = source;
        return { ok: true, source, count: [...this.botNames()].length };
    }

    /** The bots with a record (not "_meta" or a damaged one). */
    *botNames(): IterableIterator<string> {
        for (const name of this.records.keys()) if (!name.startsWith('_')) yield name;
    }

    isQuit(name: string): boolean {
        return this.meta.quit.includes(name);
    }

    /** A bot quit for good: its record goes, its name stays used. */
    quit(name: string): void {
        this.records.delete(name);
        if (!this.meta.quit.includes(name)) this.meta.quit.push(name);
        this.dirty = true;
    }

    /** The store's own state changed (friends.ts): written at the next save occasion. */
    touch(): void {
        this.dirty = true;
    }

    get(name: string): Uint8Array | undefined {
        return this.records.get(name);
    }

    /** Records a bot's newest save (in memory; written by flush). */
    put(name: string, save: Uint8Array): void {
        // exact-length copy: `save` is a view into a reused 30 kB Packet
        this.records.set(name, save.slice());
        this.dirty = true;
    }

    /** Writes the whole store if anything changed. Never throws; false = kept in memory, retried. */
    flush(reason: string): boolean {
        if (!this.loaded || !this.dirty) return true;
        let bytes: Uint8Array;
        try {
            bytes = encodeBotStore(new Map([...this.records, [META_RECORD, encodeMeta(this.meta)]]));
        } catch (e) {
            console.error('[bots] encoding the bot store failed', e);
            this.lastError = `encoding failed (${e instanceof Error ? e.message : e})`;
            return false;
        }
        const rel = this.relPath();
        const r = xhrSync('PUT', this.url(rel), bytes.buffer as ArrayBuffer);
        if (r.status >= 200 && r.status < 300) {
            this.dirty = false;
            this.writes++;
            this.lastBytes = bytes.length;
            this.lastError = null;
            console.info(`[bots] ${rel}: ${[...this.botNames()].length} bots, ${bytes.length} bytes (${reason}${this.failing ? ', after earlier failures' : ''})`);
            this.failing = false;
            return true;
        }
        this.failures++;
        const detail = `HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`;
        this.lastError = detail;
        if (!this.failing) console.error(`[bots] FAILED to write ${rel} (${reason}): ${detail} - keeping the bots' saves in memory, retrying every ${RETRY_MS / 1000} s`);
        else console.warn(`[bots] still cannot write ${rel} (${reason}): ${detail}`);
        this.failing = true;
        if (this.retryTimer === null) {
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                this.flush('retry');
            }, RETRY_MS);
        }
        return false;
    }
}

export const botStore = new BotStore();
