// Pure-TypeScript bzip2 decompressor (decode only), used when WebAssembly is unavailable (iOS Lockdown Mode
// disables it) and after start-up, when the WASM instance is released to give its linear memory back.
//
// A straight port of libbzip2 1.0.8's decoder (decompress.c / bzlib.c): Huffman tables built like
// BZ2_hbCreateDecodeTables, MTF + RUNA/RUNB, the "fast" inverse BWT and the RLE1 output stage; block and stream
// CRCs are verified so a decoder bug can never silently corrupt data. Randomised blocks (bzip2 < 0.9.5) are
// rejected - nothing in the 274 data uses them. The engine's own pure-JS alternative (the web client's SheetJS
// decoder) mis-decodes the first byte of title.dat; this one is byte-exact with the WASM build (test/bzip2.test.mjs).
//
// Derived from bzip2/libbzip2 1.0.8, copyright (C) 1996-2019 Julian R Seward. All rights reserved. Altered source
// version: ported to TypeScript, decode only, randomised blocks rejected; it is not the original software. Distributed
// under the bzip2 licence (its full text: THIRD_PARTY_NOTICES.md, "bzip2 licence"):
//
//   Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
//   following conditions are met:
//   1. Redistributions of source code must retain the above copyright notice, this list of conditions and the
//      following disclaimer.
//   2. The origin of this software must not be misrepresented; you must not claim that you wrote the original
//      software. If you use this software in a product, an acknowledgment in the product documentation would be
//      appreciated but is not required.
//   3. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original
//      software.
//   4. The name of the author may not be used to endorse or promote products derived from this software without
//      specific prior written permission.
//
//   THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
//   TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL
//   THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
//   BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
//   INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
//   (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
//   POSSIBILITY OF SUCH DAMAGE.

const MAX_GROUPS = 6;
const MAX_ALPHA = 258;
const MAX_CODE_LEN = 23;
const MAX_SELECTORS = 18002;
const GROUP_SIZE = 50;

const CRC32 = new Int32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    CRC32[i] = c;
}

function fail(what: string): never {
    throw new Error(`bzip2: ${what}`);
}

// BZ2_hbCreateDecodeTables
function createDecodeTables(limit: Int32Array, base: Int32Array, perm: Int32Array, length: Uint8Array, minLen: number, maxLen: number, alphaSize: number) {
    let pp = 0;
    for (let i = minLen; i <= maxLen; i++) {
        for (let j = 0; j < alphaSize; j++) {
            if (length[j] === i) perm[pp++] = j;
        }
    }
    base.fill(0);
    for (let i = 0; i < alphaSize; i++) base[length[i] + 1]++;
    for (let i = 1; i < MAX_CODE_LEN; i++) base[i] += base[i - 1];
    limit.fill(0);
    let vec = 0;
    for (let i = minLen; i <= maxLen; i++) {
        vec += base[i + 1] - base[i];
        limit[i] = vec - 1;
        vec <<= 1;
    }
    for (let i = minLen + 1; i <= maxLen; i++) base[i] = ((limit[i - 1] + 1) << 1) - base[i];
}

/**
 * @param src        bzip2 data
 * @param headerless true when the "BZh<level>" stream header was stripped (how the jag archives store it); the
 *                   engine then decodes it as "BZh1" (bzip2-wasm.js prepends that), i.e. with 100k blocks - so do we
 * @param sizeHint   expected decompressed size (pre-sizes the output; a wrong hint only costs a reallocation)
 */
export function bunzip2(src: Uint8Array, headerless: boolean, sizeHint = 0): Uint8Array {
    const srcLen = src.length;
    let pos = 0;
    let bitBuf = 0;
    let bitCount = 0;

    // MSB-first bit reader, n <= 24
    const bits = (n: number): number => {
        while (bitCount < n) {
            if (pos >= srcLen) fail('unexpected end of data');
            bitBuf = (bitBuf << 8) | src[pos++];
            bitCount += 8;
        }
        bitCount -= n;
        const v = (bitBuf >>> bitCount) & ((1 << n) - 1);
        bitBuf &= (1 << bitCount) - 1;
        return v;
    };

    let maxBlock = 100000; // headerless = "BZh1", exactly like the engine (and libbzip2 enforces the block size)
    if (!headerless) {
        if (bits(8) !== 0x42 || bits(8) !== 0x5a || bits(8) !== 0x68) fail('bad stream header');
        const level = bits(8) - 0x30;
        if (level < 1 || level > 9) fail('bad block size');
        maxBlock = level * 100000;
    }

    let out = new Uint8Array(sizeHint > 0 ? sizeHint : Math.max(1024, srcLen * 4));
    let outLen = 0;
    const reserve = (n: number) => {
        if (outLen + n > out.length) {
            const grown = new Uint8Array(Math.max(out.length * 2, outLen + n));
            grown.set(out.subarray(0, outLen));
            out = grown;
        }
    };

    // RLE1 can expand a block by up to 5/4, so size the BWT buffer from the hint and grow on demand
    let tt: Int32Array = new Int32Array(Math.min(maxBlock, Math.max(4096, Math.ceil(sizeHint * 1.25) + 64)));
    const seqToUnseq = new Uint8Array(256);
    const selectorMtf = new Uint8Array(MAX_GROUPS);
    const selectors = new Uint8Array(MAX_SELECTORS);
    const lens: Uint8Array[] = [];
    const limits: Int32Array[] = [];
    const bases: Int32Array[] = [];
    const perms: Int32Array[] = [];
    for (let t = 0; t < MAX_GROUPS; t++) {
        lens.push(new Uint8Array(MAX_ALPHA));
        limits.push(new Int32Array(MAX_CODE_LEN));
        bases.push(new Int32Array(MAX_CODE_LEN));
        perms.push(new Int32Array(MAX_ALPHA));
    }
    const minLens = new Int32Array(MAX_GROUPS);
    const yy = new Uint8Array(256);
    const unzftab = new Int32Array(256);
    const cftab = new Int32Array(257);
    let combinedCRC = 0;

    for (;;) {
        const m1 = bits(24);
        const m2 = bits(24);
        if (m1 === 0x177245 && m2 === 0x385090) {
            const stored = ((bits(16) << 16) | bits(16)) | 0;
            if (stored !== combinedCRC) fail('stream CRC mismatch');
            break;
        }
        if (m1 !== 0x314159 || m2 !== 0x265359) fail('bad block header');

        const blockCRC = ((bits(16) << 16) | bits(16)) | 0;
        if (bits(1)) fail('randomised blocks are not supported');
        const origPtr = bits(24);

        // symbols in use
        const inUse16 = bits(16);
        let nInUse = 0;
        for (let i = 0; i < 16; i++) {
            if (inUse16 & (0x8000 >> i)) {
                const w = bits(16);
                for (let j = 0; j < 16; j++) {
                    if (w & (0x8000 >> j)) seqToUnseq[nInUse++] = i * 16 + j;
                }
            }
        }
        if (nInUse === 0) fail('no symbols in use');
        const alphaSize = nInUse + 2;

        // selectors (MTF-coded group numbers, one per 50 symbols)
        const nGroups = bits(3);
        if (nGroups < 2 || nGroups > MAX_GROUPS) fail('bad number of Huffman groups');
        const nSelectorsCoded = bits(15);
        if (nSelectorsCoded < 1) fail('bad number of selectors');
        for (let i = 0; i < nGroups; i++) selectorMtf[i] = i;
        for (let i = 0; i < nSelectorsCoded; i++) {
            let j = 0;
            while (bits(1)) {
                if (++j >= nGroups) fail('bad selector');
            }
            const v = selectorMtf[j];
            for (; j > 0; j--) selectorMtf[j] = selectorMtf[j - 1];
            selectorMtf[0] = v;
            if (i < MAX_SELECTORS) selectors[i] = v; // libbzip2 1.0.8 reads and drops any excess
        }
        const nSelectors = Math.min(nSelectorsCoded, MAX_SELECTORS);

        // code lengths (delta-coded) and decode tables
        for (let t = 0; t < nGroups; t++) {
            const len = lens[t];
            let curr = bits(5);
            for (let i = 0; i < alphaSize; i++) {
                for (;;) {
                    if (curr < 1 || curr > 20) fail('bad code length');
                    if (!bits(1)) break;
                    curr += bits(1) ? -1 : 1;
                }
                len[i] = curr;
            }
            let minLen = 32;
            let maxLen = 0;
            for (let i = 0; i < alphaSize; i++) {
                if (len[i] > maxLen) maxLen = len[i];
                if (len[i] < minLen) minLen = len[i];
            }
            createDecodeTables(limits[t], bases[t], perms[t], len, minLen, maxLen, alphaSize);
            minLens[t] = minLen;
        }

        // Huffman -> RUNA/RUNB runs + MTF -> tt[]
        const EOB = nInUse + 1;
        for (let i = 0; i < 256; i++) {
            yy[i] = i;
            unzftab[i] = 0;
        }
        let nblock = 0;
        let groupNo = -1;
        let groupPos = 0;
        let gLimit = limits[0];
        let gBase = bases[0];
        let gPerm = perms[0];
        let gMinLen = 0;
        let runLength = 0;
        let runWeight = 0; // 0 = no RUNA/RUNB run pending
        for (;;) {
            if (groupPos === 0) {
                if (++groupNo >= nSelectors) fail('ran out of selectors');
                groupPos = GROUP_SIZE;
                const g = selectors[groupNo];
                gLimit = limits[g];
                gBase = bases[g];
                gPerm = perms[g];
                gMinLen = minLens[g];
            }
            groupPos--;

            // decode one symbol (bit reads inlined: this loop dominates without a JIT)
            let zn = gMinLen;
            while (bitCount < zn) {
                if (pos >= srcLen) fail('unexpected end of data');
                bitBuf = (bitBuf << 8) | src[pos++];
                bitCount += 8;
            }
            bitCount -= zn;
            let zvec = (bitBuf >>> bitCount) & ((1 << zn) - 1);
            bitBuf &= (1 << bitCount) - 1;
            for (;;) {
                if (zn > 20) fail('bad Huffman code');
                if (zvec <= gLimit[zn]) break;
                zn++;
                if (bitCount === 0) {
                    if (pos >= srcLen) fail('unexpected end of data');
                    bitBuf = src[pos++];
                    bitCount = 8;
                }
                bitCount--;
                zvec = (zvec << 1) | ((bitBuf >>> bitCount) & 1);
                bitBuf &= (1 << bitCount) - 1;
            }
            const idx = zvec - gBase[zn];
            if (idx < 0 || idx >= MAX_ALPHA) fail('bad Huffman code');
            const sym = gPerm[idx];

            if (sym <= 1) {
                // RUNA (0) adds w, RUNB (1) adds 2w; w doubles per digit (bijective base 2)
                if (runWeight === 0) runWeight = 1;
                else if (runWeight >= 2 * 1024 * 1024) fail('run too long');
                runLength += runWeight << sym;
                runWeight <<= 1;
                continue;
            }
            if (runWeight !== 0) {
                const uc = seqToUnseq[yy[0]];
                if (nblock + runLength > maxBlock) fail('block too long');
                if (nblock + runLength > tt.length) tt = growTT(tt, nblock + runLength, maxBlock);
                unzftab[uc] += runLength;
                tt.fill(uc, nblock, nblock + runLength);
                nblock += runLength;
                runLength = 0;
                runWeight = 0;
            }
            if (sym === EOB) break;

            // MTF: move entry sym-1 to the front
            let nn = sym - 1;
            const v = yy[nn];
            for (; nn > 0; nn--) yy[nn] = yy[nn - 1];
            yy[0] = v;
            const uc = seqToUnseq[v];
            unzftab[uc]++;
            if (nblock >= maxBlock) fail('block too long');
            if (nblock >= tt.length) tt = growTT(tt, nblock + 1, maxBlock);
            tt[nblock++] = uc;
        }
        if (origPtr >= nblock) fail('bad BWT origin pointer');

        // inverse BWT: tt[i] = (next index << 8) | byte
        cftab[0] = 0;
        for (let i = 1; i <= 256; i++) cftab[i] = cftab[i - 1] + unzftab[i - 1];
        for (let i = 0; i < nblock; i++) {
            const uc = tt[i] & 0xff;
            tt[cftab[uc]] |= i << 8;
            cftab[uc]++;
        }

        // walk the BWT, undo RLE1 (4 equal bytes + a repeat count), CRC the output
        let crc = -1;
        let tPos = tt[origPtr] >>> 8;
        let last = -1;
        let run = 0;
        reserve(nblock);
        for (let n = 0; n < nblock; n++) {
            tPos = tt[tPos];
            const ch = tPos & 0xff;
            tPos >>>= 8;
            if (run === 4) {
                reserve(ch + nblock - n);
                for (let k = 0; k < ch; k++) {
                    out[outLen++] = last;
                    crc = (crc << 8) ^ CRC32[((crc >>> 24) ^ last) & 0xff];
                }
                run = 0;
                last = -1;
                continue;
            }
            if (ch === last) {
                run++;
            } else {
                run = 1;
                last = ch;
            }
            out[outLen++] = ch;
            crc = (crc << 8) ^ CRC32[((crc >>> 24) ^ ch) & 0xff];
        }
        crc = ~crc;
        if (crc !== blockCRC) fail('block CRC mismatch');
        combinedCRC = ((combinedCRC << 1) | (combinedCRC >>> 31)) ^ crc;
    }

    return outLen === out.length ? out : out.slice(0, outLen);
}

function growTT(tt: Int32Array, need: number, max: number): Int32Array {
    const grown = new Int32Array(Math.min(max, Math.max(need, tt.length * 2)));
    grown.set(tt);
    return grown;
}

/** Same contract as the engine's BZip2.decompress (bzip2-wasm.js), without mutating the input. */
export function decompress(compressed: Uint8Array, decompressedLength: number, prependHeader = false, containsDecompressedLength = false): Uint8Array {
    if (containsDecompressedLength) {
        // the 4-byte length stands where "BZh1" would be
        const len = ((compressed[0] << 24) | (compressed[1] << 16) | (compressed[2] << 8) | compressed[3]) >>> 0;
        return bunzip2(compressed.subarray(4), true, len);
    }
    return bunzip2(compressed, prependHeader, decompressedLength);
}
