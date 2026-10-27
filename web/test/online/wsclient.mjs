// A WebSocket client the way the apps' socket bridge opens one (docs/ARCHITECTURE.md §7.2; iOS URLSessionWebSocketTask,
// Android OkHttp), for the desktop double of native (native-double.mjs): subprotocol `binary`, no Origin, no cookies, the
// app's kind of User-Agent, 10 s to open, binary messages only. What goes wrong comes back in native's words: `refused`,
// `timed out`, `not found` (no such host), `dns`, `tls`, `http <status>` (the upgrade got another answer), `network`
// (anything else, a drop while open too) and `text frame` (a text message: the socket is closed with 1003).
//
//   const socket = openWebSocket('ws://127.0.0.1:47620/', { onOpen, onMessage(bytes), onError(words), onClose(code, reason) });
//   socket.send(bytes); socket.close(); socket.drop();
//
// RFC 6455 by hand (Node has no WebSocket client that takes headers and reports the upgrade's status): masked frames
// out, unmasked frames in, fragments joined, pings answered. After onError comes onClose(1006, the same words); a close
// frame from the server is onClose(its code, its reason) alone. Nothing is reported after the caller's own close().
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// What a failed connection is called, from Node's error codes.
export function errorWords(err) {
    const code = String(err?.code ?? '');
    if (code === 'ECONNREFUSED') {
        return 'refused';
    }
    if (code === 'ENOTFOUND') {
        return 'not found';
    }
    if (code === 'EAI_AGAIN' || code === 'EAI_FAIL' || code === 'EAI_NODATA') {
        return 'dns';
    }
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
        return 'timed out';
    }
    if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED)/.test(code)) {
        return 'tls';
    }
    return 'network';
}

export function openWebSocket(url, { userAgent = '2004Scape/desktop (test double)', timeoutMs = 10000, onOpen = () => {}, onMessage = () => {}, onError = () => {}, onClose = () => {} } = {}) {
    const target = new URL(url);
    const secure = target.protocol === 'wss:';
    const key = crypto.randomBytes(16).toString('base64');
    let socket = null;
    let state = 'connecting'; // 'open', 'closing' (our close frame sent), 'done'
    let reported = false; // onClose (and maybe onError) said
    let buffer = Buffer.alloc(0);
    let fragments = null; // { opcode, parts }

    const finish = (code, reason, error = null) => {
        if (reported) {
            return;
        }
        reported = true;
        state = 'done';
        clearTimeout(timer);
        if (error) {
            onError(error);
        }
        onClose(code, reason);
    };
    const fail = words => finish(1006, words, words);

    const request = (secure ? https : http).request({
        host: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname || '/'}${target.search}`,
        method: 'GET',
        headers: {
            Host: target.host,
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': key,
            'Sec-WebSocket-Protocol': 'binary',
            'User-Agent': userAgent
        },
        agent: false
    });
    const timer = setTimeout(() => {
        request.destroy();
        socket?.destroy();
        fail('timed out');
    }, timeoutMs);

    request.on('response', response => {
        response.resume();
        fail(`http ${response.statusCode}`);
    });
    request.on('error', err => fail(errorWords(err)));
    request.on('upgrade', (response, upgraded, head) => {
        const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (response.headers['sec-websocket-accept'] !== accept) {
            upgraded.destroy();
            fail('network');
            return;
        }
        clearTimeout(timer);
        socket = upgraded;
        socket.setNoDelay(true);
        state = 'open';
        socket.on('data', chunk => {
            buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
            parse();
        });
        socket.on('error', () => {});
        socket.on('close', () => {
            if (state === 'closing') {
                finish(1000, ''); // (our own close: reported to nobody, see close())
            } else {
                fail('network'); // ended without a close frame
            }
        });
        onOpen();
        if (head?.length) {
            buffer = Buffer.from(head);
            parse();
        }
    });
    request.end();

    function frame(opcode, payload) {
        const mask = crypto.randomBytes(4);
        const length = payload.length;
        const header = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length]) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
        if (length >= 126 && length < 65536) {
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(length, 2);
        } else if (length >= 65536) {
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(length), 2);
        }
        const body = Buffer.alloc(length);
        for (let i = 0; i < length; i++) {
            body[i] = payload[i] ^ mask[i & 3];
        }
        return Buffer.concat([header, mask, body]);
    }

    function parse() {
        while (buffer.length >= 2 && state !== 'done') {
            const fin = (buffer[0] & 0x80) !== 0;
            const opcode = buffer[0] & 0x0f;
            const masked = (buffer[1] & 0x80) !== 0;
            let length = buffer[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (buffer.length < 4) {
                    return;
                }
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buffer.length < 10) {
                    return;
                }
                length = Number(buffer.readBigUInt64BE(2));
                offset = 10;
            }
            const start = offset + (masked ? 4 : 0);
            if (buffer.length < start + length) {
                return;
            }
            const payload = Buffer.from(buffer.subarray(start, start + length));
            if (masked) {
                for (let i = 0; i < length; i++) {
                    payload[i] ^= buffer[offset + (i & 3)];
                }
            }
            buffer = buffer.subarray(start + length);
            onFrame(fin, opcode, payload);
        }
    }

    function onFrame(fin, opcode, payload) {
        if (opcode === 0x8) {
            const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
            const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
            if (state === 'open') {
                socket.write(frame(0x8, payload.subarray(0, 2)));
            }
            socket.end();
            finish(code, reason);
        } else if (opcode === 0x9) {
            socket.write(frame(0xa, payload));
        } else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
            if (opcode !== 0x0) {
                fragments = { opcode, parts: [] };
            }
            if (!fragments) {
                return; // (a continuation without a start)
            }
            fragments.parts.push(payload);
            if (fin) {
                const message = { opcode: fragments.opcode, data: Buffer.concat(fragments.parts) };
                fragments = null;
                if (message.opcode === 0x1) {
                    const code = Buffer.alloc(2);
                    code.writeUInt16BE(1003);
                    socket.write(frame(0x8, code));
                    socket.end();
                    fail('text frame');
                } else if (state === 'open') {
                    onMessage(new Uint8Array(message.data));
                }
            }
        }
    }

    return {
        get open() {
            return state === 'open';
        },
        send(bytes) {
            if (state === 'open') {
                socket.write(frame(0x2, Buffer.from(bytes)));
            }
        },
        // The caller's own close (1000): nothing is reported after it.
        close() {
            reported = true;
            clearTimeout(timer);
            if (state === 'open') {
                state = 'closing';
                const code = Buffer.alloc(2);
                code.writeUInt16BE(1000);
                socket.write(frame(0x8, code));
                socket.end();
                setTimeout(() => socket.destroy(), 2000).unref();
            } else {
                request.destroy();
                state = 'done';
            }
        },
        // The connection lost under it (a test's "server-side" drop): the TCP socket destroyed, reported as `network`.
        drop() {
            if (state === 'open') {
                socket.destroy();
            }
        }
    };
}
