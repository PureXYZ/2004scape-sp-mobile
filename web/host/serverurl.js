// LostCity host page: a game server's address, as the player types it, made into the one form every part of the app
// stores and compares (docs/ONLINE.md). Native checks the stored address again by the same rules, and every side tests
// against the same vectors (web/test/online/serverurl-vectors.json).
//
//   normalize('My-Mac.local:8888')   -> 'http://my-mac.local:8888'
//   normalize('wss://Scape.Example.com/game/') -> 'https://scape.example.com/game'
//   socketUrl('https://scape.example.com/game') -> 'wss://scape.example.com/game'
//
// What it takes: `host`, `host:port`, `http://`, `https://`, `ws://` or `wss://` with an optional path. ws becomes
// http and wss https; no scheme is http. The host is lower-cased (a name of letters, digits, '-', '_' and dots, or an
// IPv6 address in brackets), a default port (80 for http, 443 for https) is dropped, the path keeps its segments but
// not a trailing '/', and a query or fragment is dropped. Anything else is not an address: credentials (user@), other
// schemes, a port that is empty or outside 1-65535, '.' or '..' segments, spaces. null then.
//
// A classic script (index.html loads it before host.js, which needs it before it chooses the page's WebSocket), and a
// side-effect module for Node (web/test/serve.mjs, the tests): either way it defines globalThis.lcServerUrl.
(() => {
    'use strict';

    const SCHEMES = { http: 'http', ws: 'http', https: 'https', wss: 'https' };
    const DEFAULT_PORT = { http: 80, https: 443 };

    function normalize(raw) {
        let rest = String(raw ?? '').trim();
        let scheme = 'http';
        const prefix = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(rest);
        if (prefix) {
            scheme = SCHEMES[prefix[1].toLowerCase()];
            if (!scheme) {
                return null;
            }
            rest = rest.slice(prefix[0].length);
        }
        const end = rest.search(/[/?#]/);
        const authority = end < 0 ? rest : rest.slice(0, end);
        let path = end < 0 ? '' : rest.slice(end);
        if (!authority || authority.includes('@')) {
            return null;
        }

        let host;
        let port = null;
        if (authority.startsWith('[')) {
            const close = authority.indexOf(']');
            const inner = close > 0 ? authority.slice(1, close) : '';
            if (!/^[0-9A-Fa-f:.]+$/.test(inner) || !inner.includes(':')) {
                return null;
            }
            host = `[${inner.toLowerCase()}]`;
            const after = authority.slice(close + 1);
            if (after) {
                if (!after.startsWith(':')) {
                    return null;
                }
                port = after.slice(1);
            }
        } else {
            const parts = authority.split(':');
            if (parts.length > 2) {
                return null; // (an IPv6 address needs its brackets)
            }
            host = parts[0].toLowerCase();
            port = parts.length === 2 ? parts[1] : null;
            const labels = host.endsWith('.') ? host.slice(0, -1).split('.') : host.split('.');
            if (host.length > 253 || !labels.every(label => /^[a-z0-9_-]{1,63}$/.test(label))) {
                return null;
            }
        }
        if (port !== null) {
            if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
                return null;
            }
            port = Number(port) === DEFAULT_PORT[scheme] ? null : String(Number(port));
        }

        path = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
        if (path && (!/^(\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)+$/.test(path) || path.split('/').some(segment => segment === '.' || segment === '..'))) {
            return null;
        }
        return `${scheme}://${host}${port ? `:${port}` : ''}${path}`;
    }

    // The game's WebSocket for a normalized base: the same host, port and path, ws or wss (Engine-TS: '/').
    function socketUrl(base) {
        const url = normalize(base);
        if (!url) {
            return null;
        }
        const socket = url.replace(/^http/, 'ws');
        return /^wss?:\/\/[^/]+$/.test(socket) ? `${socket}/` : socket;
    }

    // How the app shows an address: without 'http://' (the default), with 'https://' (so it is plain which is which).
    function address(base) {
        const url = normalize(base);
        return url ? url.replace(/^http:\/\//, '') : '';
    }

    // The host and port alone ('my-mac.local:8888', 'scape.example.com'), for About.
    function hostOf(base) {
        const url = normalize(base);
        return url ? url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
    }

    // A new server entry's id: 's-' and 8 base-36 characters, random (stable from then on).
    function newServerId() {
        const bytes = new Uint8Array(8);
        globalThis.crypto.getRandomValues(bytes);
        return `s-${[...bytes].map(b => (b % 36).toString(36)).join('')}`;
    }

    globalThis.lcServerUrl = Object.freeze({ normalize, socketUrl, address, hostOf, newServerId });
})();
