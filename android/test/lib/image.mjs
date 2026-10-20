// Screen pixels for the Android tests (android/test/shell.mjs): the raw framebuffer from `adb exec-out screencap`
// (no PNG decoder needed), a PNG writer for evidence, and pixel comparisons of a region.
//
//   import { screencap, writePng, compare } from './lib/image.mjs';
//   const a = screencap(d);                     // { width, height, data: RGBA Buffer }
//   const diff = compare(a, b, { x, y, w, h }); // { pixels, differing, maxDelta, bbox }
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ADB } from './adb.mjs';

/** The screen as RGBA (screencap's raw format: width, height, format, [colour space], then the pixels). */
export function screencap(device) {
    const raw = execFileSync(ADB, ['-s', device.serial, 'exec-out', 'screencap'], { maxBuffer: 128 << 20 });
    const width = raw.readUInt32LE(0);
    const height = raw.readUInt32LE(4);
    const header = raw.length - width * height * 4;
    if (header !== 12 && header !== 16) throw new Error(`unexpected screencap size ${raw.length} for ${width}x${height}`);
    return { width, height, data: raw.subarray(header), at: Date.now() };
}

/** The pixel at (x, y) as [r, g, b, a]. */
export function pixel(image, x, y) {
    const i = (y * image.width + x) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

/** Compares a region of two screens: how many pixels differ (any channel), the largest channel difference, where. */
export function compare(a, b, region = { x: 0, y: 0, w: a.width, h: a.height }) {
    let differing = 0;
    let maxDelta = 0;
    let bbox = null;
    for (let y = region.y; y < region.y + region.h; y++) {
        for (let x = region.x; x < region.x + region.w; x++) {
            const i = (y * a.width + x) * 4;
            const delta = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
            if (delta > 0) {
                differing++;
                maxDelta = Math.max(maxDelta, delta);
                bbox = bbox ? { x0: Math.min(bbox.x0, x), y0: Math.min(bbox.y0, y), x1: Math.max(bbox.x1, x), y1: Math.max(bbox.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
            }
        }
    }
    return { pixels: region.w * region.h, differing, maxDelta, bbox };
}

/** A picture of the differences in a region: black where equal, the larger delta in red where not (evidence). */
export function diffImage(a, b, region) {
    const out = { width: region.w, height: region.h, data: Buffer.alloc(region.w * region.h * 4) };
    for (let y = 0; y < region.h; y++) {
        for (let x = 0; x < region.w; x++) {
            const i = ((region.y + y) * a.width + region.x + x) * 4;
            const o = (y * region.w + x) * 4;
            const delta = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
            out.data[o] = delta ? Math.max(96, delta) : 0;
            out.data[o + 1] = delta ? 0 : a.data[i + 1] >> 2;
            out.data[o + 2] = delta ? 0 : a.data[i + 2] >> 2;
            out.data[o + 3] = 255;
        }
    }
    return out;
}

/** A region of a screen as its own image. */
export function crop(image, region) {
    const out = { width: region.w, height: region.h, data: Buffer.alloc(region.w * region.h * 4) };
    for (let y = 0; y < region.h; y++) image.data.copy(out.data, y * region.w * 4, ((region.y + y) * image.width + region.x) * 4, ((region.y + y) * image.width + region.x + region.w) * 4);
    return out;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** Writes an RGBA image as a PNG file. */
export function writePng(file, image) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(image.width, 0);
    header.writeUInt32BE(image.height, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // RGBA
    const rows = Buffer.alloc((image.width * 4 + 1) * image.height);
    for (let y = 0; y < image.height; y++) {
        rows[y * (image.width * 4 + 1)] = 0; // no filter
        image.data.copy(rows, y * (image.width * 4 + 1) + 1, y * image.width * 4, (y + 1) * image.width * 4);
    }
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
    return file;
}
