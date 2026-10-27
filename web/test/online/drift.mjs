// The content-drift server for the online tests: a second copy of the test engine (APFS clones) whose game
// data has moved on from the app's bundle in some OnDemand files: the first 3 animations (the client loads every
// animation with the title), every player-kit model (model_index flag 2: a new character's own body) and the land of
// map square 48_48 (where a new character starts, on Tutorial Island). Each keeps its bytes but gets the next version
// number: its 2-byte trailer in the cache and its entry in the versionlist (the versionlist archive repacked by the
// engine's own Jagfile, so the server's /crc and versionlist change as a real repack's would). The app's bundled copies
// then fail LocalOnDemand's check against the server's versionlist, and the client must fetch them from the server
// (docs/ONLINE.md).
//
//   const drift = prepareDrift({ dir, from, nodeBin });  // → { engine: <dir>/engine, anims: [file], models: [file], map: file }
//
// Made once (the copy keeps .lc-drift.json); the repack runs as a small script with the copy's own tsx.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = `// written by web/test/online/drift.mjs: one model and one map file of this copy get the next version
import FileStream from '#/io/FileStream.js';
import Jagfile from '#/io/Jagfile.js';
import Packet from '#/io/Packet.js';

const cache = new FileStream('data/pack');
const raw = cache.read(0, 5);
if (!raw) throw new Error('no versionlist');
const jag = new Jagfile(new Packet(raw));
const bytes = name => {
    const p = jag.read(name);
    if (!p) throw new Error('versionlist: no ' + name);
    return new Uint8Array(p.data);
};
const modelVersion = bytes('model_version');
const modelUse = bytes('model_index');
const animVersion = bytes('anim_version');
const mapVersion = bytes('map_version');
const mapIndex = bytes('map_index');
const g2 = (b, o) => (b[o] << 8) | b[o + 1];

const anims = [];
for (let i = 0; i < animVersion.length / 2 && anims.length < 3; i++) {
    if (g2(animVersion, i * 2) !== 0) {
        anims.push(i);
    }
}
const models = [];
for (let i = 0; i < modelVersion.length / 2; i++) {
    if (g2(modelVersion, i * 2) !== 0 && (modelUse[i] & 2) !== 0) {
        models.push(i);
    }
}
let map = -1;
for (let i = 0; i < mapIndex.length / 7; i++) {
    if (g2(mapIndex, i * 7) === (48 << 8) + 48) {
        map = g2(mapIndex, i * 7 + 2);
    }
}
if (anims.length < 3 || models.length === 0 || map < 0) throw new Error('nothing to change');

const bump = (versions, archive, file) => {
    const data = cache.read(archive + 1, file);
    if (!data) throw new Error('no file ' + archive + '/' + file);
    const next = g2(versions, file * 2) + 1;
    versions[file * 2] = next >> 8;
    versions[file * 2 + 1] = next & 255;
    const out = new Uint8Array(data);
    out[out.length - 2] = next >> 8;
    out[out.length - 1] = next & 255;
    cache.write(archive + 1, file, out);
    return next;
};
anims.forEach(file => bump(animVersion, 1, file));
models.forEach(file => bump(modelVersion, 0, file));
bump(mapVersion, 3, map);
const packet = data => {
    const p = new Packet(new Uint8Array(data));
    p.pos = data.length;
    return p;
};
jag.write('model_version', packet(modelVersion));
jag.write('anim_version', packet(animVersion));
jag.write('map_version', packet(mapVersion));
jag.save('data/pack/.lc-versionlist.tmp');
cache.write(0, 5, new Uint8Array(Packet.load('data/pack/.lc-versionlist.tmp').data));
cache.close();
console.log(JSON.stringify({ anims, models, map }));
`;

export function prepareDrift({ dir, from, nodeBin = null }) {
    const engine = path.join(dir, 'engine');
    const marker = path.join(engine, '.lc-drift.json');
    if (fs.existsSync(marker)) {
        return { engine, ...JSON.parse(fs.readFileSync(marker, 'utf8')) };
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['engine', 'content']) {
        const copied = spawnSync('cp', ['-cR', path.join(from, name), path.join(dir, name)], { stdio: 'inherit' });
        if (copied.status !== 0) {
            throw new Error(`could not copy ${name} into ${dir}`);
        }
    }
    fs.rmSync(path.join(engine, 'data', 'players'), { recursive: true, force: true });
    fs.writeFileSync(path.join(engine, 'lc-drift.ts'), SCRIPT);
    const env = nodeBin ? { ...process.env, PATH: `${nodeBin}${path.delimiter}${process.env.PATH}` } : process.env;
    const run = spawnSync(path.join(engine, 'node_modules', '.bin', 'tsx'), ['lc-drift.ts'], { cwd: engine, env, encoding: 'utf8' });
    fs.rmSync(path.join(engine, 'lc-drift.ts'), { force: true });
    fs.rmSync(path.join(engine, 'data', 'pack', '.lc-versionlist.tmp'), { force: true });
    const line = run.stdout.trim().split('\n').pop() ?? '';
    if (run.status !== 0 || !line.startsWith('{')) {
        throw new Error(`the drift repack failed: ${run.stderr || run.stdout}`);
    }
    fs.writeFileSync(marker, line);
    return { engine, ...JSON.parse(line) };
}
