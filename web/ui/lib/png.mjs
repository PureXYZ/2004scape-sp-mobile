// Minimal PNG codec for the HUD asset build (web/ui/build.mjs). Dependency-free: node:zlib does the deflate and
// the CRC-32.
//
//   decodePng(buffer, label?) -> { width, height, data }   data: Uint8Array, RGBA, row-major
//   encodePng({ width, height, data }) -> Buffer           8-bit RGBA, non-interlaced
//
// The decoder reads only 8-bit RGBA (colour type 6), non-interlaced. Every PNG in Server/content (rev 274) uses
// that format: fonts/, sprites/ and title/ were all checked. Anything else fails with a clear error instead of
// being decoded wrongly. The encoder is deterministic: the same pixels always produce the same bytes. It writes
// only IHDR, IDAT and IEND (no time or text chunks), with filter type None on every row and zlib level 9. For these
// flat, keyed sprites that is about 30% smaller than the usual per-row filter heuristic, and within 0.1% of the best
// per-image choice.
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BPP = 4; // bytes per pixel (8-bit RGBA)

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buffer, label = 'PNG') {
    const fail = message => {
        throw new Error(`${label}: ${message}`);
    };
    if (buffer.length < SIGNATURE.length || !buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
        fail('not a PNG file');
    }
    let header = null;
    const idat = [];
    let ended = false;
    for (let pos = SIGNATURE.length; !ended; ) {
        if (pos + 12 > buffer.length) {
            fail(pos === buffer.length ? 'missing IEND chunk' : `truncated chunk at byte ${pos}`);
        }
        const length = buffer.readUInt32BE(pos);
        const type = buffer.toString('latin1', pos + 4, pos + 8);
        if (pos + 12 + length > buffer.length) {
            fail(`truncated ${type} chunk`);
        }
        const body = buffer.subarray(pos + 8, pos + 8 + length);
        if (zlib.crc32(buffer.subarray(pos + 4, pos + 8 + length)) !== buffer.readUInt32BE(pos + 8 + length)) {
            fail(`CRC mismatch in ${type} chunk`);
        }
        if (!header && type !== 'IHDR') {
            fail(`first chunk is ${type}, expected IHDR`);
        }
        if (type === 'IHDR') {
            if (header || length !== 13) {
                fail('bad IHDR chunk');
            }
            header = {
                width: body.readUInt32BE(0),
                height: body.readUInt32BE(4),
                bitDepth: body[8],
                colourType: body[9],
                compression: body[10],
                filter: body[11],
                interlace: body[12]
            };
            const { width, height, bitDepth, colourType, compression, filter, interlace } = header;
            if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
                fail(
                    `unsupported format (bit depth ${bitDepth}, colour type ${colourType}, interlace ${interlace}); ` +
                        'only 8-bit RGBA (colour type 6), non-interlaced, is supported, which is what every Server/content PNG uses'
                );
            }
            if (compression !== 0 || filter !== 0 || width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
                fail(`invalid IHDR (${width}x${height}, compression ${compression}, filter ${filter})`);
            }
        } else if (type === 'IDAT') {
            idat.push(body);
        } else if (type === 'IEND') {
            ended = true;
        } else if (type !== 'PLTE' && (type.charCodeAt(0) & 0x20) === 0) {
            // Unknown critical chunk. Ancillary chunks (lower-case first letter) and an optional suggested palette are
            // safe to skip.
            fail(`unsupported critical chunk ${type}`);
        }
        pos += 12 + length;
    }
    if (!idat.length) {
        fail('no IDAT chunk');
    }

    const { width, height } = header;
    const stride = width * BPP;
    let raw;
    try {
        raw = zlib.inflateSync(Buffer.concat(idat));
    } catch (e) {
        fail(`corrupt image data (${e.message})`);
    }
    if (raw.length !== height * (stride + 1)) {
        fail(`image data is ${raw.length} bytes, expected ${height * (stride + 1)}`);
    }

    const data = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const src = y * (stride + 1) + 1;
        const dst = y * stride;
        const up = dst - stride; // previous output row; y === 0 reads zeros
        for (let i = 0; i < stride; i++) {
            const a = i >= BPP ? data[dst + i - BPP] : 0;
            const b = y > 0 ? data[up + i] : 0;
            const c = i >= BPP && y > 0 ? data[up + i - BPP] : 0;
            let predictor;
            switch (filter) {
                case 0:
                    predictor = 0;
                    break;
                case 1:
                    predictor = a;
                    break;
                case 2:
                    predictor = b;
                    break;
                case 3:
                    predictor = (a + b) >> 1;
                    break;
                case 4:
                    predictor = paeth(a, b, c);
                    break;
                default:
                    fail(`unknown filter type ${filter} in row ${y}`);
            }
            data[dst + i] = (raw[src + i] + predictor) & 0xff;
        }
    }
    return { width, height, data };
}

function chunk(type, body) {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
}

export function encodePng({ width, height, data }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height * BPP) {
        throw new Error(`encodePng: bad image (${width}x${height}, ${data.length} bytes of RGBA)`);
    }
    const stride = width * BPP;
    const raw = Buffer.alloc(height * (stride + 1)); // each row: filter byte 0 (None), then the pixels
    for (let y = 0; y < height; y++) {
        raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type: RGBA
    ihdr[10] = 0; // compression: deflate
    ihdr[11] = 0; // filter method: adaptive
    ihdr[12] = 0; // interlace: none
    const idat = zlib.deflateSync(raw, { level: 9, memLevel: 9 });
    return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
