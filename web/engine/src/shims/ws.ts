// `ws` stub. Reached via World.ts -> FriendServer.ts:1 and InternalClient.ts:1 (login/friend/logger
// server clients). Constructing a socket only happens when those servers are enabled.
export class WebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor() {
        throw new Error('ws is not available in the offline engine runtime (login/friend/logger servers must be disabled)');
    }
}
export class WebSocketServer {
    constructor() {
        throw new Error('ws server is not available in the offline engine runtime');
    }
}
export default WebSocket;
