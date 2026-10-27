// The engine's collection loops without generators (installed by runtime/tick.ts; no engine imports here, so
// test/iterators.test.mjs can install them on upstream's own classes and run both).
//
// Upstream walks World.npcs (EntityList), World.playerLoop (HashTable), the npc/player queues and a zone's lists
// (LinkList, DoublyLinkList) and a zone's contents (Zone.getAll*/get*) with generator methods. With one player that is,
// every tick, 29 292 NpcList yields over 65 532 slots and 7 332 LinkList generators (7 326 on empty queues). Resuming a
// generator, and the typed-array iterator inside EntityList's, are slow paths in both JITs: ~30 % of a JavaScriptCore
// tick (profiled 2026-10-23). These iterator objects take exactly the generators' steps, at the same moments:
//   - nothing is read before the first next() (a generator's body starts there);
//   - EntityList: ids[i] and this[index] are read only when next() runs, so an npc added or removed during the loop
//     is seen as the generator sees it. The walk ends after the highest id set() ever filled: every slot above it
//     holds -1, which the generator skips (World.npcs: 7 322 npcs in 16 383 slots). The mark is read on every next(),
//     so an npc set above it during the loop is still reached; reset() lowers it, remove() never does;
//   - LinkList/DoublyLinkList: head()/tail() on the first next(); before every later step the cursor saved after the
//     previous one is put back (`const save = this.cursor; yield link; this.cursor = save`), so a nested walk of the
//     same list does not disturb the outer one; return() ends the walk without restoring it, as a generator closed
//     at its yield;
//   - HashTable: per bucket from the sentinel; the next node is read before the current one is handed out;
//   - Zone: the list's iterator is made on the first next(), the filter (isValid(), packZoneCoord) runs when the
//     generator would run it, and return() - or an exception from the filter - closes the list's iterator, as the
//     generator's for-of does.
// They inherit %IteratorPrototype%: for-of, spread, Array.from and the iterator helpers work as on a generator.

type Result<T> = IteratorResult<T, undefined>;

const IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) as object;

// ---- EntityList ------------------------------------------------------------------------------------------------

/** The highest id set() filled since the last reset() (undefined: never set since install; the walk then scans all). */
const TOP = Symbol('EntityList.top');

type Entities<T> = { ids: Int32Array; [TOP]?: number; [index: number]: T | undefined };

export class EntityListIterator<T> {
    private ids: Int32Array | null = null;
    private i = 0;
    private done = false;

    constructor(private readonly list: Entities<T>) {}

    next(): Result<T> {
        if (this.done) return { value: undefined, done: true };
        const list = this.list;
        const ids = this.ids ?? (this.ids = list.ids); // `for (const index of this.ids)`: read on the first next()
        const top = list[TOP];
        const end = top === undefined || top >= ids.length ? ids.length : top + 1;
        while (this.i < end) {
            const index = ids[this.i++];
            if (index === -1) continue;
            const entity = list[index];
            if (typeof entity === 'undefined') continue;
            return { value: entity, done: false };
        }
        this.done = true;
        this.ids = null;
        return { value: undefined, done: true };
    }

    return(value?: unknown): IteratorResult<T> {
        this.done = true;
        this.ids = null;
        return { value: value as T, done: true };
    }
}

// ---- LinkList, DoublyLinkList --------------------------------------------------------------------------------

type Cursor = { cursor: unknown; head(): unknown; tail(): unknown; next(): unknown; prev(): unknown };

const NOT_STARTED = 0;
const SUSPENDED = 1;
const DONE = 2;

export class LinkListIterator<T> {
    private state = NOT_STARTED;
    private save: unknown = null;

    constructor(
        private readonly list: Cursor,
        private readonly reverse: boolean
    ) {}

    next(): Result<T> {
        const list = this.list;
        let link: unknown;
        if (this.state === SUSPENDED) {
            list.cursor = this.save;
            link = this.reverse ? list.prev() : list.next();
        } else if (this.state === NOT_STARTED) {
            link = this.reverse ? list.tail() : list.head();
        } else {
            return { value: undefined, done: true };
        }
        if (link === null) {
            this.state = DONE;
            this.save = null;
            return { value: undefined, done: true };
        }
        this.save = list.cursor;
        this.state = SUSPENDED;
        return { value: link as T, done: false };
    }

    return(value?: unknown): IteratorResult<T> {
        this.state = DONE;
        this.save = null;
        return { value: value as T, done: true };
    }
}

// ---- HashTable -----------------------------------------------------------------------------------------------

type HashNode = { next: HashNode | null };
type Buckets = { bucketCount: number; buckets: unknown[] };

export class HashTableIterator<T> {
    private bucket = -1; // -1: not started
    private sentinel: HashNode | null = null;
    private node: HashNode | null = null;

    constructor(private readonly table: Buckets) {}

    next(): Result<T> {
        const table = this.table;
        let node = this.node;
        if (this.bucket === -1) {
            this.bucket = 0;
            if (table.bucketCount > 0) {
                this.sentinel = table.buckets[0] as HashNode;
                node = this.sentinel.next;
            }
        }
        while (this.bucket < table.bucketCount) {
            if (node !== null && node !== this.sentinel) {
                this.node = node.next; // read before the node is handed out: removing it during the loop is safe
                return { value: node as unknown as T, done: false };
            }
            if (++this.bucket < table.bucketCount) {
                this.sentinel = table.buckets[this.bucket] as HashNode;
                node = this.sentinel.next;
            }
        }
        this.node = null;
        this.sentinel = null;
        return { value: undefined, done: true };
    }

    return(value?: unknown): IteratorResult<T> {
        this.bucket = this.table.bucketCount;
        this.node = null;
        this.sentinel = null;
        return { value: value as T, done: true };
    }
}

// ---- Zone ----------------------------------------------------------------------------------------------------

/** Zone's generators are all `for (const x of this.<list>.all(reverse?)) if (filter(x)) yield x;` */
type Filter = ((entity: never, coord: number) => boolean) | null;
type Walkable<T> = { all(reverse?: boolean): Iterator<T> };

export class FilteredIterator<T> {
    private inner: Iterator<T> | null = null;
    private done = false;

    constructor(
        private readonly list: Walkable<T>,
        private readonly reverse: boolean | undefined, // undefined: all() without an argument (get*(coord))
        private readonly filter: Filter,
        private readonly coord: number
    ) {}

    next(): Result<T> {
        if (this.done) return { value: undefined, done: true };
        const inner = this.inner ?? (this.inner = this.reverse === undefined ? this.list.all() : this.list.all(this.reverse));
        const filter = this.filter;
        let filtering = false;
        try {
            for (;;) {
                const r = inner.next();
                if (r.done) {
                    this.done = true;
                    this.inner = null;
                    return { value: undefined, done: true };
                }
                const x = r.value;
                if (filter === null) return { value: x, done: false };
                filtering = true;
                if (filter(x as never, this.coord)) return { value: x, done: false };
                filtering = false;
            }
        } catch (e) {
            // an exception ends the generator; one from its loop body (the filter) also closes the list's iterator,
            // as for-of does (an error from that return() is dropped: the first exception wins)
            this.done = true;
            this.inner = null;
            if (filtering) {
                try {
                    inner.return?.();
                } catch {
                    // dropped
                }
            }
            throw e;
        }
    }

    return(value?: unknown): IteratorResult<T> {
        if (!this.done) {
            this.done = true;
            const inner = this.inner;
            this.inner = null;
            inner?.return?.(); // closed while suspended inside its for-of: the generator closes the list's iterator
        }
        return { value: value as T, done: true };
    }
}

for (const C of [EntityListIterator, LinkListIterator, HashTableIterator, FilteredIterator]) Object.setPrototypeOf(C.prototype, IteratorPrototype);

type Valid = { isValid(): boolean; x: number; z: number };
type PackZoneCoord = (x: number, z: number) => number;

// ---- install -------------------------------------------------------------------------------------------------

export interface IteratorTargets {
    /** EntityList.prototype (the abstract base of NpcList) */
    entityList: { set(id: number, entity: unknown): void; reset(): void };
    linkList: { prototype: object };
    doublyLinkList: { prototype: object };
    hashTable: { prototype: object };
    zone: { prototype: object };
    /** CoordGrid (read on every call, like Zone's generators do) */
    coordGrid: { packZoneCoord: PackZoneCoord };
}

/** Replaces the generator methods of the targets' prototypes (once, before any of them is walked). */
export function installPlainIterators(t: IteratorTargets): void {
    const entityList = t.entityList as unknown as Record<PropertyKey, unknown> & IteratorTargets['entityList'];
    entityList[Symbol.iterator] = function (this: Entities<unknown>) {
        return new EntityListIterator(this);
    };
    const set = entityList.set;
    entityList.set = function (this: Entities<unknown>, id: number, entity: unknown) {
        const r = set.call(this, id, entity); // throws for an invalid or occupied id: nothing noted then
        noteTop(this, id);
        return r;
    };
    const reset = entityList.reset;
    entityList.reset = function (this: Entities<unknown>) {
        const r = reset.call(this);
        if (this[TOP] !== undefined) this[TOP] = -1;
        return r;
    };

    const linkAll = function (this: Cursor, reverse = false) {
        return new LinkListIterator(this, !!reverse);
    };
    (t.linkList.prototype as Record<string, unknown>).all = linkAll;
    (t.doublyLinkList.prototype as Record<string, unknown>).all = linkAll;
    (t.hashTable.prototype as Record<string, unknown>).all = function (this: Buckets) {
        return new HashTableIterator(this);
    };

    const coordGrid = t.coordGrid;
    const valid: Filter = ((e: Valid) => e.isValid()) as Filter;
    const validAt: Filter = ((e: Valid, coord: number) => e.isValid() && coordGrid.packZoneCoord(e.x, e.z) === coord) as Filter;
    const at: Filter = ((e: Valid, coord: number) => coordGrid.packZoneCoord(e.x, e.z) === coord) as Filter;
    type Lists = Record<'players' | 'npcs' | 'objs' | 'locs', Walkable<unknown>>;
    // the lists are readonly fields set in Zone's constructor: reading one here or on the first next() is the same
    const all = (list: keyof Lists, filter: Filter) =>
        function (this: Lists, reverse = false) {
            return new FilteredIterator(this[list], reverse, filter, 0);
        };
    const atCoord = (list: keyof Lists, filter: Filter) =>
        function (this: Lists, coord: number) {
            return new FilteredIterator(this[list], undefined, filter, coord);
        };
    Object.assign(t.zone.prototype, {
        getAllPlayersSafe: all('players', valid),
        getAllNpcsSafe: all('npcs', valid),
        getAllObjsSafe: all('objs', valid),
        getObjsSafe: atCoord('objs', validAt),
        getObjsUnsafe: atCoord('objs', at),
        getAllObjsUnsafe: all('objs', null),
        getAllLocsSafe: all('locs', valid),
        getLocsSafe: atCoord('locs', validAt),
        getLocsUnsafe: atCoord('locs', at),
        getAllLocsUnsafe: all('locs', null),
        getAllNpcsUnsafe: all('npcs', null),
        getAllPlayersUnsafe: all('players', null)
    });
}

function noteTop(list: Entities<unknown>, id: number) {
    const top = list[TOP];
    if (top === undefined) {
        // not enumerable: Object.keys/for-in/JSON see the list as before
        Object.defineProperty(list, TOP, { value: id, writable: true, enumerable: false, configurable: true });
    } else if (id > top) {
        list[TOP] = id;
    }
}
