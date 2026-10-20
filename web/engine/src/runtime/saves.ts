// Player saves in native storage (ARCHITECTURE.md §5): GET/PUT lostcity://game/save/players/<profile>/<name>.sav
// with synchronous XHR, relative to the worker script URL. The native side writes atomically and keeps a .bak.
//
// Failure policy - never lose the newest save silently:
//  - every save is first recorded in `pending` (in memory) and only dropped from there once the PUT succeeded;
//  - a failed PUT is logged as an error and retried (timer, every lifecycle save/pause, next write, exit);
//  - a login prefers the pending copy over storage, so a player logging back in after a failed write gets the
//    newest state, not the stale file;
//  - a failed GET (anything but 200/404) refuses the login instead of creating a fresh character that would
//    overwrite the real save on logout.
import Environment from '#/util/Environment.js';

import { xhrSync } from './xhr.js';

const RETRY_MS = 15000;

export type LoadResult = { status: 'ok'; data: Uint8Array; source: 'storage' | 'memory' } | { status: 'missing' } | { status: 'error'; error: string };

function workerBase(): string {
    const loc = (globalThis as unknown as { location?: { href?: string } }).location;
    return loc?.href ?? import.meta.url;
}

// toSafeName() already restricts names to [a-z0-9_]; this only guards the URL path against anything unexpected
function safeSegment(s: string, fallback: string): string {
    return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : fallback;
}

class SaveStore {
    readonly pending = new Map<string, Uint8Array>();
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private failureLogged = new Set<string>();
    writes = 0;
    failures = 0;

    private profileWarned = false;

    profile(): string {
        const p = safeSegment(Environment.node.profile, 'main');
        if (p !== Environment.node.profile && !this.profileWarned) {
            this.profileWarned = true;
            console.warn(`[save] node.profile '${Environment.node.profile}' is not a plain folder name; saving under players/main`);
        }
        return p;
    }

    relPath(username: string): string {
        return `players/${this.profile()}/${safeSegment(username, '_invalid_')}.sav`;
    }

    url(username: string): string {
        return new URL(`../save/${this.relPath(username)}`, workerBase()).href;
    }

    load(username: string): LoadResult {
        const mem = this.pending.get(username);
        if (mem) {
            console.warn(`[save] ${this.relPath(username)}: using the newer in-memory save (the last write to storage failed)`);
            return { status: 'ok', data: mem.slice(), source: 'memory' };
        }
        const r = xhrSync('GET', this.url(username));
        if (r.status === 200 && r.data) return { status: 'ok', data: r.data, source: 'storage' };
        if (r.status === 404) return { status: 'missing' };
        return { status: 'error', error: `GET ${this.relPath(username)} -> ${r.status}${r.error ? ` (${r.error})` : ''}` };
    }

    /** Write a save now. Returns true once storage has it; false = kept in memory and retried later. */
    write(username: string, save: Uint8Array, reason: string): boolean {
        // exact-length copy: `save` is a view into a 30 kB Packet, and the PUT body must be exactly the save
        const copy = save.slice();
        this.pending.set(username, copy);
        return this.flush(username, copy, reason);
    }

    private flush(username: string, copy: Uint8Array, reason: string): boolean {
        const rel = this.relPath(username);
        const r = xhrSync('PUT', this.url(username), copy.buffer as ArrayBuffer);
        if (r.status >= 200 && r.status < 300) {
            if (this.pending.get(username) === copy) this.pending.delete(username);
            this.writes++;
            if (this.failureLogged.delete(username)) console.info(`[save] ${rel}: written after earlier failures (${reason})`);
            else console.info(`[save] ${rel}: ${copy.length} bytes (${reason})`);
            return true;
        }
        this.failures++;
        const detail = `HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`;
        if (!this.failureLogged.has(username)) {
            this.failureLogged.add(username);
            console.error(`[save] FAILED to write ${rel} (${reason}): ${detail} - keeping it in memory, retrying every ${RETRY_MS / 1000} s`);
        } else {
            console.warn(`[save] still cannot write ${rel} (${reason}): ${detail}`);
        }
        this.scheduleRetry();
        return false;
    }

    /**
     * Delete a character's save (Settings › Saved data; the caller checked it is not in the world). Native keeps it as
     * <name>.sav.bak. A copy still waiting to be written is dropped too, so that no retry writes the character back.
     * Returns null once the save is gone (also: there was none), else why not.
     */
    delete(username: string): string | null {
        const rel = this.relPath(username);
        const r = xhrSync('DELETE', this.url(username));
        if ((r.status < 200 || r.status >= 300) && r.status !== 404) {
            const detail = `DELETE ${rel} -> HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`;
            console.error(`[save] ${detail}`);
            return detail;
        }
        this.pending.delete(username);
        this.failureLogged.delete(username);
        console.info(`[save] ${rel}: deleted${r.status === 404 ? ' (there was none)' : ', kept as .bak'}`);
        return null;
    }

    /** Retry every save that has not reached storage yet. Returns the names that still failed. */
    retryPending(reason = 'retry'): string[] {
        const failed: string[] = [];
        for (const [username, copy] of [...this.pending]) {
            if (!this.flush(username, copy, reason)) failed.push(username);
        }
        return failed;
    }

    private scheduleRetry() {
        if (this.retryTimer !== null) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.pending.size) this.retryPending();
        }, RETRY_MS);
    }
}

export const saves = new SaveStore();
