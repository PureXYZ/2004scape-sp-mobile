// port: dice that come out the same every time for the same bot (a pure function of its name and what is rolled), for
// what must not change between its sessions: a new bot's age (port/BotAge), a PKer's build (PKerTask,
// EdgevillePKerTask) and the gear tables those builds come from. Math.random stays for everything else.
import { normalizeBotName } from '#/engine/bot/port/BotRoster.js';

/** FNV-1a (32 bit) of a string. */
export function hashString(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** A seed from a bot's name (normalised as the engine stores it) and what it is for. */
export function nameSeed(name: string, purpose: string): number {
    return hashString(`${normalizeBotName(name)}#${purpose}`);
}

/** mulberry32: a small, fast generator of numbers in [0, 1) from a 32-bit seed. */
export function seededRandom(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** An index in [0, count) for this bot and purpose: the same at every login. */
export function nameIndex(name: string, purpose: string, count: number): number {
    return count <= 0 ? 0 : nameSeed(name, purpose) % count;
}
