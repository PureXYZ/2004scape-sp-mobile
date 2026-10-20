#!/usr/bin/env node
// Where the bots' chat model sits in an APK (docs/ANDROID.md §4): reads every stored entry's local
// header and prints the GGUF's data offset and its remainder mod 32. llama.cpp maps the model straight from the APK only
// when that remainder is 0 (the CPU buffers' alignment); otherwise it reads it into memory (about 200 MB more). The build
// guarantees it (android/build-logic's lostcity.model: zipalign -P 16 32, then apksigner --alignment-preserved); this is
// the independent check, also for an APK built some other way.
//
//   node android/test/native/check-apk-alignment.mjs <apk> [--strict]
//   exit 0: the model is stored and 32-byte aligned (or, without --strict, there is no model); 1: it is not; 2: usage
import fs from 'node:fs';

const [apk, ...flags] = process.argv.slice(2);
if (!apk) {
    console.error('usage: check-apk-alignment.mjs <apk> [--strict]');
    process.exit(2);
}
const strict = flags.includes('--strict');
const fd = fs.openSync(apk, 'r');
const size = fs.fstatSync(fd).size;
const read = (offset, length) => {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    return buffer;
};

// the end of central directory record: in the last 64 KB + 22 bytes
const tailLength = Math.min(size, 65557);
const tail = read(size - tailLength, tailLength);
let eocd = -1;
for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
    }
}
if (eocd < 0) {
    console.error(`${apk}: not a zip`);
    process.exit(1);
}
const entries = tail.readUInt16LE(eocd + 10);
const cd = read(tail.readUInt32LE(eocd + 16), tail.readUInt32LE(eocd + 12));
let at = 0;
let stored = 0;
const misaligned = [];
const models = [];
for (let n = 0; n < entries; n++) {
    const method = cd.readUInt16LE(at + 10);
    const nameLength = cd.readUInt16LE(at + 28);
    const extraLength = cd.readUInt16LE(at + 30);
    const commentLength = cd.readUInt16LE(at + 32);
    const header = cd.readUInt32LE(at + 42);
    const name = cd.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    const isModel = name.startsWith('assets/Model/') && name.endsWith('.gguf');
    if (method !== 0) {
        if (isModel) models.push({ name, compressed: true });
        continue;
    }
    stored++;
    const local = read(header, 30);
    const data = header + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const alignment = name.endsWith('.so') ? 16384 : 32;
    if (data % alignment !== 0) misaligned.push(`${name} @${data} (mod ${alignment} = ${data % alignment})`);
    if (isModel) models.push({ name, data });
}
fs.closeSync(fd);

console.log(`${apk}: ${entries} entries, ${stored} stored, ${misaligned.length} off a 32-byte (16 KB for .so) boundary`);
for (const model of models) {
    console.log(model.compressed ? `  ${model.name}: COMPRESSED (not usable: openFd refuses it)` : `  ${model.name}: data at ${model.data}, mod 32 = ${model.data % 32} (${model.data % 32 === 0 ? 'mmap from the APK' : 'read into memory'})`);
}
if (misaligned.length) console.log(`  first off: ${misaligned.slice(0, 5).join(', ')}`);
const model = models[0];
const ok = model ? !model.compressed && model.data % 32 === 0 : !strict;
if (!model) console.log('  no model in this APK');
process.exit(ok ? 0 : 1);
