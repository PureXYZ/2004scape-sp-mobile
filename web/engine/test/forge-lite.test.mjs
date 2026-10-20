#!/usr/bin/env node
// src/shims/forge-lite.ts (native BigInt) against node-forge 1.4.0, the module it replaces in the bundle:
//   - privateKeyFromPem(data/config/private.pem): every key field identical
//   - Packet.rsadec's CRT decryption and Packet.rsaenc's encryption, replicated with both BigInteger
//     implementations, byte-identical for 3000 random inputs (incl. high-bit inputs: jsbn two's complement)
//   - an end-to-end check through the bundled Packet.rsadec with a block encrypted like the web client does
//
//   node web/engine/test/forge-lite.test.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { importBundled } from './lib/bundle.mjs';
import { SERVER, makeFixture } from './lib/fixture.mjs';

const ENGINE = path.join(SERVER, 'engine');
const forge = createRequire(path.join(ENGINE, 'package.json'))('node-forge');
const { lite, Packet } = await importBundled('forge-test', `export { default as lite } from './shims/forge-lite.js';\nexport { default as Packet } from '#/io/Packet.js';`);

const pem = fs.readFileSync(path.join(ENGINE, 'data/config/private.pem'), 'ascii');
const kF = forge.pki.privateKeyFromPem(pem);
const kL = lite.pki.privateKeyFromPem(pem);
let failures = 0;
for (const f of ['n', 'e', 'd', 'p', 'q', 'dP', 'dQ', 'qInv']) {
    if (kF[f].toString(16) !== kL[f].toString(16)) {
        console.log(`FAIL key field ${f}`);
        failures++;
    }
}

function dec(BI, k, enc) {
    const c = new BI(Array.from(enc));
    const mP = c.modPow(k.dP, k.p);
    const mQ = c.modPow(k.dQ, k.q);
    const h = k.qInv.multiply(mP.subtract(mQ)).mod(k.p);
    return Uint8Array.from(mQ.add(h.multiply(k.q)).toByteArray());
}
const enc = (BI, k, raw) => Uint8Array.from(new BI(Array.from(raw)).modPow(k.e, k.n).toByteArray());
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

let n = 0;
for (let i = 0; i < 3000; i++) {
    const raw = crypto.randomBytes(1 + (i % 63));
    if (i % 3 === 0) raw[0] = 10; // real login blocks start with 10
    if (i % 7 === 0) raw[0] |= 0x80; // negative in jsbn's two's complement reading
    const eF = enc(forge.jsbn.BigInteger, kF, raw);
    const eL = enc(lite.jsbn.BigInteger, kL, raw);
    if (!eq(eF, eL)) {
        failures++;
        console.log(`FAIL encrypt #${i}`);
        continue;
    }
    if (!eq(dec(forge.jsbn.BigInteger, kF, eF), dec(lite.jsbn.BigInteger, kL, eF))) {
        failures++;
        console.log(`FAIL decrypt #${i}`);
    }
    n++;
}

// end to end: client-style rsaenc (webclient JsUtil) -> bundled Packet.rsadec with the forge-lite key
const { rsa } = makeFixture();
const plain = Buffer.concat([Buffer.from([10]), crypto.randomBytes(20), Buffer.from('enginetest\npassword\n', 'latin1')]);
let x = 0n;
for (const b of plain) x = (x << 8n) | BigInt(b);
let y = 1n;
for (let b = x % BigInt(rsa.n), e = BigInt(rsa.e); e > 0n; e >>= 1n, b = (b * b) % BigInt(rsa.n)) if (e & 1n) y = (y * b) % BigInt(rsa.n);
const block = [];
while (y > 0n) {
    block.unshift(Number(y & 0xffn));
    y >>= 8n;
}
if (block[0] & 0x80) block.unshift(0);
const pkt = new Packet(Uint8Array.from([block.length, ...block]));
pkt.rsadec(kL);
const out = pkt.data.subarray(0, plain.length);
if (!eq(out, plain)) {
    failures++;
    console.log('FAIL Packet.rsadec with forge-lite');
}

console.log(failures ? `forge-lite: FAIL (${failures})` : `forge-lite: PASS - key fields identical, ${n}/3000 random encrypt+CRT-decrypt round trips byte-identical to node-forge, Packet.rsadec decodes a client block`);
process.exit(failures ? 1 : 0);
