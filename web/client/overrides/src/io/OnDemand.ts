// LostCity iOS port: whole-module override of src/io/OnDemand.ts ("LocalOnDemand").
//
// Same public surface as upstream, but there is no OnDemand worker, no second WebSocket and no IndexedDB.
// Every file comes synchronously from the bundled cache the engine also uses (Game/cache/main_file_cache.*),
// which the host page loads into `globalThis.__LC_CACHE__ = { dat, idx: [idx0..idx4] }` before the client starts
// (docs/ARCHITECTURE.md §6).
//  - Upstream fetched each model/anim/midi/map over a second socket and cached it in IndexedDB; for data that is
//    already on the device that only costs time (in WKWebView the IndexedDB path made startup ~10x slower).
//  - request() reads the raw file (gzip data + 2-byte version trailer, i.e. exactly what the engine's OnDemand
//    protocol would send), checks it against the versionlist like OnDemandWorker.validate(), and queues it as
//    completed. The unchanged loop() then strips the trailer and gunzips it, as for files from the worker.
//  - prefetch*/clearPrefetches are no-ops (upstream also skips them without a database); run() only ticks `cycle`.
//  - Online (docs/ONLINE.md) the versionlist is the game server's, and a file the bundled cache does not hold in the
//    server's version is fetched instead of being missing: from the app's cache of what earlier sessions downloaded,
//    else from the server itself (RemoteFiles below). Offline there is no remote path at all.
import { gunzipSync } from 'fflate';

import type { Client } from '#/client/Client.js';
import { lcOpenSocket, lcPlatform, lcServer } from '#/client/LcHost.js';

import LinkList2 from '#/datastruct/LinkList2.js';
import LinkList from '#/datastruct/LinkList.js';

import ClientStream from '#/io/ClientStream.js';
import type JagFile from '#/io/JagFile.js';
import OnDemandProvider from '#/io/OnDemandProvider.js';
import OnDemandRequest from '#/io/OnDemandRequest.js';
import Packet from '#/io/Packet.js';

export interface LocalCache {
    dat: Uint8Array;
    idx: Uint8Array[]; // idx0 (jag archives, unused here), idx1 models, idx2 anims, idx3 midi, idx4 maps
}

export default class OnDemand extends OnDemandProvider {
    versions: number[][] = [];
    crcs: number[][] = [];
    modelUse: number[] = [];
    mapIndex: number[] = [];
    mapLand: number[] = [];
    mapLoc: number[] = [];
    mapFree: number[] = [];
    animFrameIndex: number[] = [];
    midiJingle: number[] = [];
    running: boolean = true;
    app: Client;
    requests: LinkList2<OnDemandRequest> = new LinkList2();
    completed: LinkList<OnDemandRequest> = new LinkList();
    message: string = '';
    cycle: number = 0;
    failCount: number = 0;
    worker: Worker | null = null; // kept for surface compatibility: always null
    private readonly cache: LocalCache;
    private readonly remote: RemoteFiles | null; // online only

    constructor(versionlist: JagFile, app: Client) {
        super();

        const version: string[] = ['model_version', 'anim_version', 'midi_version', 'map_version'];
        for (let i = 0; i < 4; i++) {
            const data = versionlist.read(version[i]);
            if (!data) {
                throw new Error();
            }

            const count = data.length / 2;
            const buf = new Packet(data);

            this.versions[i] = new Array(count);

            for (let j = 0; j < count; j++) {
                this.versions[i][j] = buf.g2();
            }
        }

        const crc: string[] = ['model_crc', 'anim_crc', 'midi_crc', 'map_crc'];
        for (let i = 0; i < 4; i++) {
            const data = versionlist.read(crc[i]);
            if (!data) {
                throw new Error();
            }

            const count = data.length / 4;
            const buf = new Packet(data);

            this.crcs[i] = new Array(count);

            for (let j = 0; j < count; j++) {
                this.crcs[i][j] = buf.g4();
            }
        }

        let data = versionlist.read('model_index');
        if (data) {
            const count = this.versions[0].length;
            this.modelUse = new Array(count);

            for (let i = 0; i < count; i++) {
                if (i < data.length) {
                    this.modelUse[i] = data[i];
                } else {
                    this.modelUse[i] = 0;
                }
            }
        }

        data = versionlist.read('map_index');
        if (data) {
            const count = data.length / 7;
            const buf = new Packet(data);

            this.mapIndex = new Array(count);
            this.mapLand = new Array(count);
            this.mapLoc = new Array(count);
            this.mapFree = new Array(count);

            for (let i = 0; i < count; i++) {
                this.mapIndex[i] = buf.g2();
                this.mapLand[i] = buf.g2();
                this.mapLoc[i] = buf.g2();
                this.mapFree[i] = buf.g1();
            }
        }

        data = versionlist.read('anim_index');
        if (data) {
            const count = data.length / 2;
            const buf = new Packet(data);

            this.animFrameIndex = new Array(count);
            for (let i = 0; i < count; i++) {
                this.animFrameIndex[i] = buf.g2();
            }
        }

        data = versionlist.read('midi_index');
        if (data) {
            const count = data.length;
            const buf = new Packet(data);

            this.midiJingle = new Array(count);
            for (let i = 0; i < count; i++) {
                this.midiJingle[i] = buf.g1();
            }
        }

        this.app = app;
        this.running = true;
        // Fails loudly (the client shows "loaderror - ...") instead of hanging on "Loading animations".
        this.cache = OnDemand.getCache();
        this.remote = lcServer() ? new RemoteFiles(this) : null;
    }

    static getCache(): LocalCache {
        const cache = (globalThis as { __LC_CACHE__?: LocalCache }).__LC_CACHE__;
        if (!cache || !(cache.dat instanceof Uint8Array) || !Array.isArray(cache.idx) || cache.idx.length < 5 || !cache.idx.every(i => i instanceof Uint8Array)) {
            throw new Error('globalThis.__LC_CACHE__ = { dat, idx[5] } is not set (host must load cache/main_file_cache.* first)');
        }
        return cache;
    }

    // Port of the engine's FileStream.read(archive, file) without decompression
    // (Server/engine/src/io/FileStream.ts:73-150): 6-byte idx entries (size g3, sector g3), 520-byte sectors with an
    // 8-byte header (file g2, part g2, next sector g3, archive+1 g1) and 512 data bytes; the chain is validated.
    static readFile(cache: LocalCache, archive: number, file: number): Uint8Array | null {
        const idx = cache.idx[archive];
        const dat = cache.dat;
        if (!idx || file < 0 || file >= ((idx.length / 6) | 0)) {
            return null;
        }

        const p = file * 6;
        const size = (idx[p] << 16) | (idx[p + 1] << 8) | idx[p + 2];
        let sector = (idx[p + 3] << 16) | (idx[p + 4] << 8) | idx[p + 5];
        const sectors = (dat.length / 520) | 0;
        if (size > 2000000 || sector <= 0 || sector > sectors) {
            return null;
        }

        const out = new Uint8Array(size);
        let pos = 0;
        for (let part = 0; pos < size; part++) {
            if (sector === 0) {
                break;
            }

            const s = sector * 520;
            const available = Math.min(512, size - pos);
            if (s + 8 + available > dat.length) {
                return null;
            }

            const sectorFile = (dat[s] << 8) | dat[s + 1];
            const sectorPart = (dat[s + 2] << 8) | dat[s + 3];
            const nextSector = (dat[s + 4] << 16) | (dat[s + 5] << 8) | dat[s + 6];
            const sectorIndex = dat[s + 7];
            if (file !== sectorFile || part !== sectorPart || archive !== sectorIndex - 1 || nextSector > sectors) {
                return null;
            }

            out.set(dat.subarray(s + 8, s + 8 + available), pos);
            pos += available;
            sector = nextSector;
        }

        return pos === size ? out : null;
    }

    // Same check as OnDemandWorker.validate(): 2-byte version trailer and CRC32 of the rest match the versionlist.
    // A bad file is delivered as null (a missing file) rather than letting gunzip throw inside the game loop.
    validate(data: Uint8Array, archive: number, file: number): boolean {
        if (data.length < 2) {
            return false;
        }

        const trailer = data.length - 2;
        const version = (data[trailer] << 8) | data[trailer + 1];
        return version === this.versions[archive][file] && Packet.getcrc(data, 0, trailer) === this.crcs[archive][file];
    }

    stop() {
        this.running = false;
        this.remote?.stop();
    }

    getFileCount(archive: number) {
        return this.versions[archive].length;
    }

    getAnimFrameCount() {
        return this.animFrameIndex.length;
    }

    getMapFile(x: number, z: number, type: number) {
        const map = (x << 8) + z;

        for (let i = 0; i < this.mapIndex.length; i++) {
            if (this.mapIndex[i] === map) {
                if (type === 0) {
                    return this.mapLand[i];
                } else {
                    return this.mapLoc[i];
                }
            }
        }

        return -1;
    }

    async prefetchMaps(_members: boolean) {}

    hasMapLocFile(file: number) {
        for (let i = 0; i < this.mapIndex.length; i++) {
            if (this.mapLoc[i] === file) {
                return true;
            }
        }

        return false;
    }

    getModelUse(id: number) {
        return this.modelUse[id] & 0xFF;
    }

    isMidiJingle(id: number) {
        return this.midiJingle[id] === 1;
    }

    requestModel(id: number) {
        this.request(0, id);
    }

    request(archive: number, file: number) {
        if (archive < 0 || archive >= this.versions.length || file < 0 || file >= this.versions[archive].length || this.versions[archive][file] === 0) {
            return;
        }

        for (let req = this.requests.head(); req !== null; req = this.requests.next()) {
            if (req.archive === archive && req.file === file) {
                return;
            }
        }

        const req = new OnDemandRequest();
        req.archive = archive;
        req.file = file;
        req.urgent = true;

        let data = OnDemand.readFile(this.cache, archive + 1, file);
        if (this.remote) {
            // online: the bundled file when it is the server's version, else one downloaded already, else from the
            // app's cache or the server (pending meanwhile: remaining() counts it, so loading waits for it as upstream)
            data = data && this.validate(data, archive, file) ? data : this.remote.kept(archive, file);
            this.requests.push(req);
            if (data) {
                req.data = data;
                this.completed.push(req);
            } else {
                this.remote.get(archive, file);
            }
            return;
        }
        if (data && !this.validate(data, archive, file)) {
            console.error(`OnDemand: cache file ${archive}/${file} does not match the versionlist`);
            data = null;
        } else if (!data) {
            console.error(`OnDemand: cache file ${archive}/${file} is missing`);
        }
        req.data = data;

        // Pending until loop() hands it out (remaining() counts it), exactly like a worker reply that already arrived.
        this.requests.push(req);
        this.completed.push(req);
    }

    // A remote file arrived (RemoteFiles), or null: missing. Its request completes as if the worker had answered.
    receive(archive: number, file: number, data: Uint8Array | null) {
        for (let req = this.requests.head(); req !== null; req = this.requests.next()) {
            if (req.archive === archive && req.file === file && req.data === null && !this.isCompleted(req)) {
                req.data = data;
                this.completed.push(req);
                return;
            }
        }
    }

    private isCompleted(req: OnDemandRequest): boolean {
        for (let done = this.completed.head(); done !== null; done = this.completed.next()) {
            if (done === req) {
                return true;
            }
        }
        return false;
    }

    remaining() {
        return this.requests.size();
    }

    loop(): OnDemandRequest | null {
        const req = this.completed.popFront();
        if (req === null) {
            return null;
        }

        req.unlink2();

        if (req.data === null) {
            return req;
        }

        req.data = gunzipSync(req.data.subarray(0, req.data.length - 2));
        return req;
    }

    async prefetchPriority(_archive: number, _file: number, _priority: number) {}

    clearPrefetches() {}

    prefetch(_archive: number, _file: number) {}

    async run() {
        if (!this.running) {
            return;
        }

        this.cycle++;
    }
}

type RemoteRequest = { archive: number; file: number; data: Uint8Array | null; cycle: number };

// Online only: the files LocalOnDemand cannot give from the bundled cache, as upstream's OnDemandWorker fetches them, on
// the main thread (the build forbids a Worker) and without IndexedDB (patch 1's rule stays: the app's own cache stands
// in for it):
//  - first the app's cache of the server's files (GET ondemand/<archive>/<file>: what an earlier session downloaded),
//    checked against the versionlist;
//  - else the server, over an OnDemand socket of the host's (lcOpenSocket('ondemand'): native's socket bridge) with
//    upstream's protocol: opened when needed (at most once in 4 s), opcode 15 and 8 bytes back; requests of 4 bytes
//    [archive, file >> 8, file, 2], at most 10 in flight, each sent again after 50 quiet cycles; answers in 6-byte
//    headers [archive, file u16, size u16, part] and parts of up to 500 bytes; in game a keep-alive [0, 0, 0, 10] every
//    500 cycles; the socket dropped after 750 cycles with requests waiting and nothing arriving (and opened again);
//  - a file that arrives is checked against the versionlist, kept in memory (a later request of it, after a low-detail
//    unload, completes at once) and written to the app's cache (PUT ondemand/<archive>/<file>); one that fails the
//    check is delivered as missing.
// A cycle is 20 ms, as the worker's: a timer of its own, while there is work (or, in game, a socket to keep alive).
class RemoteFiles {
    private readonly owner: OnDemand;
    private readonly files: Map<string, Uint8Array> = new Map(); // downloaded and checked: 'archive.file' -> data
    private readonly asked: Set<string> = new Set(); // asked of the app's cache or queued, not answered yet
    private readonly lookups: RemoteRequest[] = []; // waiting for the app's cache (at most 8 at a time)
    private looking: number = 0;
    private readonly queue: RemoteRequest[] = []; // for the server
    private readonly pending: RemoteRequest[] = []; // sent to the server
    private stream: ClientStream | null = null;
    private opening: boolean = false;
    private socketOpenTime: number = -4000;
    private current: RemoteRequest | null = null;
    private partOffset: number = 0;
    private partAvailable: number = 0;
    private packetCycle: number = 0;
    private noTimeoutCycle: number = 0;
    private readonly buf: Uint8Array = new Uint8Array(500);
    private timer: ReturnType<typeof setTimeout> | null = null;
    private busy: boolean = false;
    private stopped: boolean = false;

    constructor(owner: OnDemand) {
        this.owner = owner;
    }

    kept(archive: number, file: number): Uint8Array | null {
        return this.files.get(`${archive}.${file}`) ?? null;
    }

    get(archive: number, file: number): void {
        const key = `${archive}.${file}`;
        if (this.asked.has(key) || this.stopped) {
            return;
        }
        this.asked.add(key);
        this.lookups.push({ archive, file, data: null, cycle: 0 });
        this.lookup();
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.drop();
    }

    // the app's cache first, a few at a time
    private lookup(): void {
        while (this.looking < 8 && this.lookups.length > 0) {
            const req = this.lookups.shift()!;
            this.looking++;
            fetch(`ondemand/${req.archive}/${req.file}`)
                .then(async response => (response.ok ? new Uint8Array(await response.arrayBuffer()) : null))
                .catch(() => null)
                .then(data => {
                    this.looking--;
                    if (data && this.owner.validate(data, req.archive, req.file)) {
                        this.done(req, data, false);
                    } else {
                        this.queue.push(req);
                        this.schedule();
                    }
                    this.lookup();
                });
        }
    }

    private done(req: RemoteRequest, data: Uint8Array | null, store: boolean): void {
        const key = `${req.archive}.${req.file}`;
        this.asked.delete(key);
        if (data) {
            this.files.set(key, data);
            if (store) {
                this.store(req.archive, req.file, data);
            }
        }
        if (!this.stopped) {
            this.owner.receive(req.archive, req.file, data);
        }
    }

    // into the app's cache for the next session: the body as iOS takes it, or (Android: a request handler never sees a
    // body) base64url in X-LC-Body with its length in X-LC-Length, as the engine's saves go
    private store(archive: number, file: number, data: Uint8Array): void {
        const url = `ondemand/${archive}/${file}`;
        const android = lcPlatform() === 'android';
        let init: RequestInit;
        if (android) {
            let text = '';
            for (let i = 0; i < data.length; i += 0x8000) {
                text += String.fromCharCode(...data.subarray(i, i + 0x8000));
            }
            init = { method: 'PUT', headers: { 'X-LC-Body': btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'X-LC-Length': String(data.length) } };
        } else {
            init = { method: 'PUT', body: data.slice() };
        }
        fetch(url, init).catch(() => {});
    }

    // (nothing to fetch: the timer stops, and only in game keeps the socket alive, as upstream's worker does; on the title
    // an open socket waits for the next request, and one the server closed meanwhile is opened again for it)
    private schedule(): void {
        const idle = this.queue.length === 0 && this.pending.length === 0;
        if (this.timer || this.stopped || (idle && (!this.stream || !this.owner.app.ingame))) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.busy) {
                this.schedule();
                return;
            }
            this.busy = true;
            this.cycle()
                .catch(e => console.error(e))
                .finally(() => {
                    this.busy = false;
                    this.schedule();
                });
        }, 20);
    }

    private async cycle(): Promise<void> {
        while (this.pending.length < 10 && this.queue.length > 0) {
            const req = this.queue.shift()!;
            this.pending.push(req);
            await this.send(req);
        }

        for (let i = 0; i < 100 && this.stream; i++) {
            if (!(await this.read())) {
                break;
            }
        }

        for (const req of this.pending) {
            if (++req.cycle > 50) {
                req.cycle = 0;
                await this.send(req);
            }
        }

        if (this.pending.length > 0) {
            if (++this.packetCycle > 750) {
                this.drop();
            }
        } else {
            this.packetCycle = 0;
        }

        if (this.owner.app.ingame && this.stream && ++this.noTimeoutCycle > 500) {
            this.noTimeoutCycle = 0;
            this.buf.set([0, 0, 0, 10]);
            try {
                this.stream.write(this.buf, 4);
            } catch {
                this.drop();
            }
        }
    }

    private async send(req: RemoteRequest): Promise<void> {
        try {
            if (!this.stream) {
                if (this.opening || performance.now() - this.socketOpenTime < 4000) {
                    return;
                }
                this.socketOpenTime = performance.now();
                this.opening = true;
                const socket = lcOpenSocket('ondemand');
                if (!socket) {
                    throw new Error('no socket');
                }
                const stream = new ClientStream(
                    await new Promise<WebSocket>((resolve, reject) => {
                        socket.addEventListener('open', () => resolve(socket));
                        socket.addEventListener('error', () => reject(socket));
                    })
                );
                this.buf[0] = 15;
                stream.write(this.buf, 1);
                for (let i = 0; i < 8; i++) {
                    await stream.read();
                }
                this.opening = false;
                if (this.stopped) {
                    stream.close();
                    return;
                }
                this.stream = stream;
                this.packetCycle = 0;
            }

            this.buf[0] = req.archive;
            this.buf[1] = req.file >> 8;
            this.buf[2] = req.file;
            this.buf[3] = 2; // urgent: every request here is one the game waits for
            this.stream.write(this.buf, 4);
            this.noTimeoutCycle = 0;
        } catch {
            this.opening = false;
            this.drop();
        }
    }

    // One header or one part, if it has arrived: true when something was read.
    private async read(): Promise<boolean> {
        const stream = this.stream;
        if (!stream) {
            return false;
        }

        try {
            const available = stream.available;
            if (this.partAvailable === 0 && available >= 6) {
                await stream.readBytes(this.buf, 0, 6);
                const archive = this.buf[0];
                const file = (this.buf[1] << 8) | this.buf[2];
                const size = (this.buf[3] << 8) | this.buf[4];
                const part = this.buf[5];

                this.current = null;
                let matched = false;
                for (const req of this.pending) {
                    if (req.archive === archive && req.file === file) {
                        this.current = req;
                        matched = true;
                    }
                    if (matched) {
                        req.cycle = 0;
                    }
                }

                if (this.current) {
                    this.packetCycle = 0;
                    if (size === 0) {
                        this.finish(this.current, null);
                        this.current = null;
                    } else {
                        if (this.current.data === null && part === 0) {
                            this.current.data = new Uint8Array(size);
                        }
                        if (this.current.data === null) {
                            throw new Error('missing start of file');
                        }
                    }
                }

                this.partOffset = part * 500;
                this.partAvailable = Math.max(0, Math.min(500, size - part * 500));
                return true;
            }

            if (this.partAvailable > 0 && available >= this.partAvailable) {
                let dst = this.buf;
                let off = 0;
                if (this.current?.data) {
                    dst = this.current.data;
                    off = this.partOffset;
                }
                await stream.readBytes(dst, off, this.partAvailable);
                if (this.current?.data && this.partAvailable + this.partOffset >= dst.length) {
                    this.finish(this.current, this.current.data);
                    this.current = null;
                }
                this.partAvailable = 0;
                return true;
            }
        } catch {
            this.drop();
        }
        return false;
    }

    private finish(req: RemoteRequest, data: Uint8Array | null): void {
        const index = this.pending.indexOf(req);
        if (index !== -1) {
            this.pending.splice(index, 1);
        }
        if (data && !this.owner.validate(data, req.archive, req.file)) {
            console.error(`OnDemand: the server's ${req.archive}/${req.file} does not match its versionlist`);
            data = null;
        }
        this.done(req, data, data !== null);
    }

    private drop(): void {
        this.stream?.close();
        this.stream = null;
        this.partAvailable = 0;
        this.current = null;
    }
}
