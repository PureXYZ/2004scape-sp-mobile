// Client connections over worker.postMessage (ARCHITECTURE.md §4), modelled on the WebSocket server in web.ts:87-136.
//
// Engine-side rules (engine-runtime report §4):
//  - remoteAddress must be an IP literal: World.processLogins only adds a player to playerLoop (the list that
//    gets ticked) for addresses containing '.' or ':' (World.ts:910-930).
//  - send() must copy: the engine hands out views of buffers it reuses (client.out, login replies). All sends to a
//    connection within one macrotask (= one tick) are coalesced into a single transferred ArrayBuffer.
//  - close()/terminate() set state = -1 at once; the "socket closed" handling runs later, like a ws 'close' event.
//  - when a connection closes, EVERY player whose client is that socket gets a NullClientSocket. Upstream nulls
//    only `socket.player`, which is wrong after a reconnect (opcode 18): the old socket's player is the in-world
//    player that has already moved to the new socket (bug 1: the reconnected session is cut off), and the new
//    socket's player is the temporary login player, so the in-world player would keep a dead socket until the
//    100-tick no-response timeout (bug 2). Checking `player.client === socket` fixes both without touching World.ts.
import World from '#/engine/World.js';
import OnDemand from '#/engine/OnDemand.js';
import { NetworkPlayer } from '#/engine/entity/NetworkPlayer.js';
import type Player from '#/engine/entity/Player.js';
import ClientSocket from '#/server/ClientSocket.js';
import NullClientSocket from '#/server/NullClientSocket.js';
import { LoggerEventType } from '#/server/logger/LoggerEventType.js';

import { send } from './host.js';

export class WorkerClientSocket extends ClientSocket {
    private queue: Uint8Array[] = [];
    private queued = 0;
    private flushScheduled = false;
    /** close/terminate was called or the page closed it: nothing more is sent */
    closed = false;
    /** the "socket closed" handling (detaching players) has run */
    closeHandled = false;

    constructor(readonly id: number) {
        super();
        this.remoteAddress = '127.0.0.1';
    }

    send(src: Uint8Array): void {
        if (this.closed || src.length === 0) return;
        this.queue.push(src.slice());
        this.queued += src.length;
        this.totalBytesWritten += src.length;
        if (!this.flushScheduled) {
            this.flushScheduled = true;
            queueMicrotask(this.flush);
        }
    }

    flush = (): void => {
        this.flushScheduled = false;
        if (this.queued === 0) return;
        if (this.closeHandled) {
            // the page already closed this connection: nobody will read it
            this.queue = [];
            this.queued = 0;
            return;
        }
        let data: Uint8Array;
        if (this.queue.length === 1) {
            data = this.queue[0];
        } else {
            data = new Uint8Array(this.queued);
            let o = 0;
            for (const part of this.queue) {
                data.set(part, o);
                o += part.length;
            }
        }
        this.queue = [];
        this.queued = 0;
        send({ type: 'data', id: this.id, data: data.buffer as ArrayBuffer }, [data.buffer as ArrayBuffer]);
    };

    /** Graceful close: queued bytes (e.g. the LOGOUT packet or a login error code) are delivered first. */
    close(): void {
        this.state = -1;
        if (this.closed) return;
        this.flush();
        this.closed = true;
        send({ type: 'close', id: this.id });
        scheduleClosed(this);
    }

    /** Hard close (ws.terminate()): whatever is still queued is dropped. */
    terminate(): void {
        this.state = -1;
        if (this.closed) return;
        this.queue = [];
        this.queued = 0;
        this.closed = true;
        send({ type: 'close', id: this.id });
        scheduleClosed(this);
    }
}

const sockets = new Map<number, WorkerClientSocket>();

function scheduleClosed(socket: WorkerClientSocket) {
    // asynchronous, like a ws server's 'close' event after socket.close()
    setTimeout(() => {
        try {
            onClosed(socket);
        } catch (e) {
            console.error('[transport] close handling failed', e);
        }
    }, 0);
}

function detach(player: Player, socket: WorkerClientSocket) {
    if (player instanceof NetworkPlayer && player.client === socket) {
        player.addSessionLog(LoggerEventType.ENGINE, 'Worker socket closed');
        player.client = new NullClientSocket();
    }
}

/** The connection is gone (either side closed it): mirror web.ts' socket.on('close'), for every player on it. */
export function onClosed(socket: WorkerClientSocket) {
    if (socket.closeHandled) return;
    socket.closeHandled = true;
    socket.closed = true;
    socket.state = -1;
    if (sockets.get(socket.id) === socket) sockets.delete(socket.id);

    OnDemand.onClientClosed(socket);
    // a login still waiting for the login thread would otherwise create a player bound to this dead socket
    if (World.loginRequests.get(socket.uuid) === socket) World.loginRequests.delete(socket.uuid);

    for (const player of World.playerLoop.all()) detach(player, socket);
    for (const player of World.newPlayers) detach(player, socket);
    if (socket.player) detach(socket.player, socket);
}

export function connect(id: number) {
    const old = sockets.get(id);
    if (old) {
        console.warn(`[transport] connection id ${id} reused before it was closed; closing the old one`);
        onClosed(old);
    }
    sockets.set(id, new WorkerClientSocket(id));
}

// mirrors web.ts:103-120 (socket.on('message'))
export function receive(id: number, data: ArrayBuffer | ArrayBufferView) {
    const client = sockets.get(id);
    if (!client) return; // already closed by the engine; the page has not seen our 'close' yet
    const bytes = data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    try {
        if (client.state === -1 || client.remaining <= 0) {
            client.terminate();
            return;
        }
        client.buffer(bytes as never);
        client.totalBytesRead += bytes.length;
        if (client.state === 0) {
            World.onClientData(client);
        } else if (client.state === 2) {
            OnDemand.onClientData(client);
        }
        // state 1: World.processClientsIn -> NetworkPlayer.decodeIn reads client.in on the next tick
    } catch (e) {
        console.error(`[transport] connection ${id}: ${e instanceof Error ? e.message : e}`);
        client.terminate();
    }
}

/** The page closed the connection (the client called WebSocket.close()). */
export function remoteClose(id: number) {
    const client = sockets.get(id);
    if (client) onClosed(client);
}

/** Close every connection (engine exit). */
export function closeAll() {
    for (const s of [...sockets.values()]) s.close();
}

export function connectionCount() {
    return sockets.size;
}

export { sockets };
