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
import { gunzipSync } from 'fflate';

import type { Client } from '#/client/Client.js';

import LinkList2 from '#/datastruct/LinkList2.js';
import LinkList from '#/datastruct/LinkList.js';

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
    private validate(data: Uint8Array, archive: number, file: number): boolean {
        if (data.length < 2) {
            return false;
        }

        const trailer = data.length - 2;
        const version = (data[trailer] << 8) | data[trailer + 1];
        return version === this.versions[archive][file] && Packet.getcrc(data, 0, trailer) === this.crcs[archive][file];
    }

    stop() {
        this.running = false;
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
