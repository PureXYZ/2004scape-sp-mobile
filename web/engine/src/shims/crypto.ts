// `crypto` subset. randomUUID is built on getRandomValues because crypto.randomUUID is
// [SecureContext]-only in browsers (prior art e4587938/b8ede747 fell back to uuid '0', which breaks
// World.loginRequests / OnDemand client maps keyed by ClientSocket.uuid - ClientSocket.ts:9).
const wc = globalThis.crypto;

export function getRandomValues<T extends ArrayBufferView>(a: T): T {
    return wc.getRandomValues(a as unknown as Uint8Array) as unknown as T;
}

export function randomBytes(n: number): Uint8Array {
    return getRandomValues(new Uint8Array(n));
}

export function randomUUID(): string {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function randomInt(min: number, max?: number): number {
    if (max === undefined) {
        max = min;
        min = 0;
    }
    return min + Math.floor((getRandomValues(new Uint32Array(1))[0] / 0x100000000) * (max - min));
}

export const webcrypto = wc;
export function createHash(): never {
    throw new Error('crypto.createHash is not available in the browser engine runtime');
}

export default { getRandomValues, randomBytes, randomUUID, randomInt, webcrypto, createHash };
