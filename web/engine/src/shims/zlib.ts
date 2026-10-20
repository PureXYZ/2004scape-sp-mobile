// `zlib` subset via fflate (already an engine dependency). Runtime use:
//   io/FileStream.ts:148 zlib.gunzipSync - cache reads with decompress=true:
//       SeqType.load -> AnimFrame.load (archive 2, all anims) and Midi.load (archive 3) at World.start
//   io/Packet.ts:197 zlib.gzipSync - Packet.saveGz, packer only
import { gunzipSync as fGunzip, gzipSync as fGzip, inflateSync as fInflate, deflateSync as fDeflate, zlibSync, unzlibSync, decompressSync } from 'fflate';
import { Buffer } from './buffer.js';

type Opts = { level?: number };
const wrap = (u: Uint8Array) => new Buffer(u.buffer as ArrayBuffer, u.byteOffset, u.byteLength);
const lvl = (o?: Opts) => ({ level: (o?.level ?? 6) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 });

export const gunzipSync = (d: Uint8Array) => wrap(fGunzip(d));
export const gzipSync = (d: Uint8Array, o?: Opts) => wrap(fGzip(d, lvl(o)));
export const inflateSync = (d: Uint8Array) => wrap(unzlibSync(d));
export const deflateSync = (d: Uint8Array, o?: Opts) => wrap(zlibSync(d, lvl(o)));
export const inflateRawSync = (d: Uint8Array) => wrap(fInflate(d));
export const deflateRawSync = (d: Uint8Array, o?: Opts) => wrap(fDeflate(d, lvl(o)));
export const unzipSync = (d: Uint8Array) => wrap(decompressSync(d));
export const constants = {};

export default { gunzipSync, gzipSync, inflateSync, deflateSync, inflateRawSync, deflateRawSync, unzipSync, constants };
