#!/usr/bin/env node
// HUD assets: the game's own bitmap fonts as TrueType fonts and its sprites as transparent PNGs, for the HTML/CSS
// HUD. Reads Server/content (never modified) and writes <out>/ui/. See README.md in this folder for how to use them.
//
//   node web/ui/build.mjs --out <GameDir> [--content <dir>]
//   import { buildUi } from './web/ui/build.mjs'; await buildUi({ out, contentDir });
//
// Writes:
//   <out>/ui/fonts/{p11,p12,b12,q8}.ttf   'RS Plain 11', 'RS Plain 12', 'RS Bold 12', 'RS Quill 8' (fonts/*_full.png)
//   <out>/ui/sprites/<stem>.png           every PNG in content/sprites and content/title, with #FF00FF made transparent.
//                                         A sheet (meta/<name>.opt "WxH") is written as one <name>-<i>.png per tile
//                                         (row-major, every cell, full cell size). The flipped tab stones the client
//                                         makes are also written: redstone1{h,v,hv}, redstone2{h,v,hv}, redstone3v.
//   <out>/ui/textures/stone.png           the HUD's own stone (tab column, minimap ring): the cobbles of the world
//                                         texture textures/pebblefloor.png in the colours of the 2004 frame's stones
//   <out>/ui/manifest.json                { fonts: { <key>: { family, file, height, descent, spaceAdvance } },
//                                           sprites: { <stem>: [width, height] }, textures: { <name>: [w, h] } }
// No dependencies beyond Node built-ins. The output is byte-identical for the same input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng } from './lib/png.mjs';
import { readPixFont } from './lib/pixfont.mjs';
import { buildTtf } from './lib/ttf.mjs';
import { CONTENT_DIR } from '../../scripts/lib/upstream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IOS = path.resolve(HERE, '../..');
export const DEFAULT_CONTENT_DIR = CONTENT_DIR;

// ---- fonts ------------------------------------------------------------------------------------------------------

const UNITS_PER_EM = 1024;
const UNIT = 64; // font units per game pixel, so CSS font-size 16px draws one game pixel per CSS pixel
const FONT_DATE = new Date('2004-01-01T00:00:00Z'); // fixed head.created/modified, for reproducible files

export const FONTS = [
    { key: 'p11', sheet: 'p11_full', family: 'RS Plain 11', postScriptName: 'RSPlain11-Regular', quill: false },
    { key: 'p12', sheet: 'p12_full', family: 'RS Plain 12', postScriptName: 'RSPlain12-Regular', quill: false },
    { key: 'b12', sheet: 'b12_full', family: 'RS Bold 12', postScriptName: 'RSBold12-Regular', quill: false },
    { key: 'q8', sheet: 'q8_full', family: 'RS Quill 8', postScriptName: 'RSQuill8-Regular', quill: true }
];

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Sheet cells in the font, in glyph order after .notdef. Cell = Latin-1 code; cell 0x80 is the euro sign (its CP1252
// slot). Cells 0x00-0x1F, 0x7F and 0x81-0x9F only hold a placeholder dot and are left out. Space and no-break space
// have no outline: the client never draws code 32 and gives it the advance of 'i' ('I' for q8), and the dot in cell
// 0xA0 is a placeholder too.
const CODES = [...range(0x20, 0x7e), 0x80, ...range(0xa0, 0xff)];
const BLANK = new Set([0x20, 0xa0]);

// Character map: every code maps to its own cell (U+0080 too, since client strings carry the euro as U+0080 through
// Packet.gjstr's String.fromCharCode), and U+20AC also maps to cell 0x80.
const EXTRA_CODE_POINTS = [[0x20ac, 0x80]];

function readGrid(dir, name, width, height) {
    // Same parsing and checks as the engine packer (Engine-TS tools/pack/PixPack.ts convertImage).
    const opt = path.join(dir, 'meta', `${name}.opt`);
    if (!fs.existsSync(opt)) {
        return null;
    }
    const [tileWidth, tileHeight] = fs.readFileSync(opt, 'ascii').split(/\r?\n/, 1)[0].trim().split('x').map(Number);
    if (!Number.isInteger(tileWidth) || !Number.isInteger(tileHeight) || tileWidth < 1 || tileHeight < 1 || width % tileWidth || height % tileHeight) {
        throw new Error(`${path.relative(process.cwd(), opt)}: tile size does not divide the ${width}x${height} image`);
    }
    return { tileWidth, tileHeight };
}

function buildFont(contentDir, { sheet, family, postScriptName, quill }) {
    const dir = path.join(contentDir, 'fonts');
    const file = path.join(dir, `${sheet}.png`);
    const image = decodePng(fs.readFileSync(file), `fonts/${sheet}.png`);
    const grid = readGrid(dir, sheet, image.width, image.height) ?? { tileWidth: 20, tileHeight: 20 };
    const font = readPixFont(image, { cellWidth: grid.tileWidth, cellHeight: grid.tileHeight, quill, label: `fonts/${sheet}.png` });
    const { height, glyphs } = font;
    const space = glyphs[32].adv;

    const outline = code => {
        // One clockwise rectangle per horizontal run of ink. Mask row r spans game rows offY+r .. offY+r+1 below the
        // line top, which is `height` rows above the baseline (y = 0, y up).
        const { offX, offY, w, h, mask } = glyphs[code];
        const contours = [];
        for (let r = 0; r < h; r++) {
            const top = (height - offY - r) * UNIT;
            for (let x = 0; x < w; ) {
                if (!mask[r * w + x]) {
                    x++;
                    continue;
                }
                const x0 = x;
                while (x < w && mask[r * w + x]) {
                    x++;
                }
                const left = (offX + x0) * UNIT;
                const right = (offX + x) * UNIT;
                contours.push([
                    [left, top - UNIT],
                    [left, top],
                    [right, top],
                    [right, top - UNIT]
                ]);
            }
        }
        return contours;
    };

    const ttfGlyphs = [{ advance: glyphs[0].adv * UNIT, contours: [] }]; // .notdef: blank, placeholder advance
    const glyphIndex = new Map();
    for (const code of CODES) {
        glyphIndex.set(code, ttfGlyphs.length);
        ttfGlyphs.push(BLANK.has(code) ? { advance: space * UNIT, contours: [] } : { advance: glyphs[code].adv * UNIT, contours: outline(code) });
    }
    const cmap = [...CODES.map(code => [code, glyphIndex.get(code)]), ...EXTRA_CODE_POINTS.map(([cp, code]) => [cp, glyphIndex.get(code)])];

    // The deepest ink of any drawn glyph sets the descent (ascent is `height`: no glyph starts above the cell top).
    const drawn = CODES.filter(code => !BLANK.has(code));
    const descent = Math.max(0, ...drawn.map(code => glyphs[code].offY + glyphs[code].h - height));
    const strikeRow = height - Math.floor(height * 0.7); // @str@ line, rows above the baseline (PixFont.ts drawStringTag)

    const ttf = buildTtf({
        familyName: family,
        styleName: 'Regular',
        postScriptName,
        version: 1,
        unitsPerEm: UNITS_PER_EM,
        ascender: height * UNIT,
        descender: -descent * UNIT,
        lineGap: 0,
        xHeight: (height - glyphs[0x78].offY) * UNIT,
        capHeight: (height - glyphs[0x48].offY) * UNIT,
        strikeoutSize: UNIT,
        strikeoutPosition: strikeRow * UNIT,
        underlinePosition: -UNIT,
        underlineThickness: UNIT,
        lowestRecPPEM: UNITS_PER_EM / UNIT,
        date: FONT_DATE,
        glyphs: ttfGlyphs,
        cmap
    });
    return { ttf, height, descent, space };
}

// ---- sprites ----------------------------------------------------------------------------------------------------

const SPRITE_DIRS = ['sprites', 'title'];

// The client flips these at load (Client-TS Client.ts: redstone1h = hflip, redstone1v = vflip, redstone1hv = both,
// ...; there is no redstone3h or redstone3hv). The stones are uncropped, so mirroring the whole PNG equals mirroring
// the client's sprite.
const FLIPS = { redstone1: ['h', 'v', 'hv'], redstone2: ['h', 'v', 'hv'], redstone3: ['v'] };

// What the HUD uses. The build fails if the content stops providing any of these.
const REQUIRED_SPRITES = [
    ...range(0, 12).map(i => `sideicons-${i}`),
    ...['redstone1', 'redstone2', 'redstone3', 'redstone1h', 'redstone1v', 'redstone1hv', 'redstone2h', 'redstone2v', 'redstone2hv', 'redstone3v'],
    ...['invback', 'chatback', 'mapback', 'compass', 'mapedge', 'tradebacking', 'leftarrow', 'rightarrow', 'logo', 'titlebox', 'titlebutton'],
    ...['backbase1', 'backbase2', 'backhmid1', 'backhmid2', 'backleft1', 'backleft2', 'backright1', 'backright2', 'backtop1'],
    ...['backvmid1', 'backvmid2', 'backvmid3'],
    ...['steelborder-3', 'steelborder2-1', 'sworddecor-3', 'miscgraphics-11', 'miscgraphics2-1', 'miscgraphics3-1', 'combatboxes-3'],
    ...['scrollbar-1', 'mod_icons-1', 'headicons-8', 'staticons-17', 'cross-7']
];

// #FF00FF is the transparency key (PixPack.ts); it becomes fully transparent black. All other pixels are opaque in
// the content and are copied as they are.
function keyMagenta({ width, height, data }) {
    const out = new Uint8Array(data);
    for (let i = 0; i < out.length; i += 4) {
        if (out[i] === 0xff && out[i + 1] === 0x00 && out[i + 2] === 0xff) {
            out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
        }
    }
    return { width, height, data: out };
}

function crop(image, x0, y0, width, height) {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const from = ((y0 + y) * image.width + x0) * 4;
        data.set(image.data.subarray(from, from + width * 4), y * width * 4);
    }
    return { width, height, data };
}

function flip(image, horizontal, vertical) {
    const { width, height } = image;
    const data = new Uint8Array(image.data.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const from = ((vertical ? height - 1 - y : y) * width + (horizontal ? width - 1 - x : x)) * 4;
            data.set(image.data.subarray(from, from + 4), (y * width + x) * 4);
        }
    }
    return { width, height, data };
}

// ---- textures ---------------------------------------------------------------------------------------------------

// The stone of the HUD's own frames, which have no 2004 sprite of their size: a seamless world texture recoloured with
// the stones of the frame the client draws around its panels (backvmid1...), so it reads as the same rough stone. Each
// pixel takes the frame colour of the same brightness rank: the texture's shapes in exactly the frame's palette.
const TEXTURES = [{ name: 'stone', from: 'pebblefloor', palette: ['backvmid1', 'backvmid2', 'backright2', 'backhmid1', 'backbase2'] }];

const luma = (data, i) => data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;

function recolour(image, paletteImages) {
    const colours = [];
    for (const { data } of paletteImages) {
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] !== 0) {
                colours.push({ l: luma(data, i), r: data[i], g: data[i + 1], b: data[i + 2] });
            }
        }
    }
    colours.sort((a, b) => a.l - b.l || a.r - b.r || a.g - b.g || a.b - b.b);
    const count = image.width * image.height;
    const order = Array.from({ length: count }, (_, p) => p).sort((a, b) => luma(image.data, a * 4) - luma(image.data, b * 4) || a - b);
    const data = new Uint8Array(count * 4);
    order.forEach((p, rank) => {
        const c = colours[Math.floor((rank * (colours.length - 1)) / Math.max(1, count - 1))];
        data.set([c.r, c.g, c.b, 255], p * 4);
    });
    return { width: image.width, height: image.height, data };
}

// ---- build ------------------------------------------------------------------------------------------------------

export async function buildUi({ out, contentDir = DEFAULT_CONTENT_DIR, log = console.log } = {}) {
    if (!out) {
        throw new Error('buildUi: out (the Game directory) is required');
    }
    const started = Date.now();
    out = path.resolve(out);
    contentDir = path.resolve(contentDir);
    const ui = path.join(out, 'ui');
    const fontsOut = path.join(ui, 'fonts');
    const spritesOut = path.join(ui, 'sprites');
    const texturesOut = path.join(ui, 'textures');
    // Only the generated folders are replaced, so a standalone run never leaves stale files behind and whatever else
    // the host page keeps under ui/ survives.
    fs.rmSync(fontsOut, { recursive: true, force: true });
    fs.rmSync(spritesOut, { recursive: true, force: true });
    fs.rmSync(texturesOut, { recursive: true, force: true });
    fs.mkdirSync(fontsOut, { recursive: true });
    fs.mkdirSync(spritesOut, { recursive: true });
    fs.mkdirSync(texturesOut, { recursive: true });

    const manifest = { fonts: {}, sprites: {}, textures: {} };
    let fontBytes = 0;
    for (const def of FONTS) {
        const font = buildFont(contentDir, def);
        fs.writeFileSync(path.join(fontsOut, `${def.key}.ttf`), font.ttf);
        fontBytes += font.ttf.length;
        manifest.fonts[def.key] = { family: def.family, file: `ui/fonts/${def.key}.ttf`, height: font.height, descent: font.descent, spaceAdvance: font.space };
    }

    let spriteBytes = 0;
    const writeSprite = (stem, image) => {
        if (stem in manifest.sprites) {
            throw new Error(`sprite name collision: ${stem}`);
        }
        const png = encodePng(image);
        fs.writeFileSync(path.join(spritesOut, `${stem}.png`), png);
        spriteBytes += png.length;
        manifest.sprites[stem] = [image.width, image.height];
    };
    for (const sub of SPRITE_DIRS) {
        const dir = path.join(contentDir, sub);
        const names = fs
            .readdirSync(dir)
            .filter(f => f.endsWith('.png'))
            .map(f => f.slice(0, -4))
            .sort();
        for (const name of names) {
            const image = keyMagenta(decodePng(fs.readFileSync(path.join(dir, `${name}.png`)), `${sub}/${name}.png`));
            const grid = readGrid(dir, name, image.width, image.height);
            if (grid && FLIPS[name]) {
                throw new Error(`${sub}/${name}.png: expected a single sprite (the client mirrors it whole), found a sheet`);
            }
            if (grid) {
                const { tileWidth, tileHeight } = grid;
                const cols = image.width / tileWidth;
                const count = cols * (image.height / tileHeight);
                for (let i = 0; i < count; i++) {
                    writeSprite(`${name}-${i}`, crop(image, (i % cols) * tileWidth, Math.floor(i / cols) * tileHeight, tileWidth, tileHeight));
                }
            } else {
                writeSprite(name, image);
            }
            for (const variant of FLIPS[name] ?? []) {
                writeSprite(`${name}${variant}`, flip(image, variant.includes('h'), variant.includes('v')));
            }
        }
    }
    const missing = REQUIRED_SPRITES.filter(stem => !(stem in manifest.sprites));
    if (missing.length) {
        throw new Error(`content is missing sprites the HUD needs: ${missing.join(', ')}`);
    }

    for (const { name, from, palette } of TEXTURES) {
        const source = decodePng(fs.readFileSync(path.join(contentDir, 'textures', `${from}.png`)), `textures/${from}.png`);
        const frame = palette.map(stem => keyMagenta(decodePng(fs.readFileSync(path.join(contentDir, 'sprites', `${stem}.png`)), `sprites/${stem}.png`)));
        const image = recolour(source, frame);
        const png = encodePng(image);
        fs.writeFileSync(path.join(texturesOut, `${name}.png`), png);
        spriteBytes += png.length;
        manifest.textures[name] = [image.width, image.height];
    }

    // One sprite per line: [w, h] pairs stay on the line of their name.
    const json = JSON.stringify(manifest, null, 2).replace(/\[\s+(\d+),\s+(\d+)\s+\]/g, '[$1, $2]');
    fs.writeFileSync(path.join(ui, 'manifest.json'), `${json}\n`);

    const spriteCount = Object.keys(manifest.sprites).length;
    const summary = { fonts: FONTS.length, fontBytes, sprites: spriteCount, spriteBytes, ms: Date.now() - started };
    const shown = path.relative(IOS, ui).startsWith('..') ? ui : path.relative(IOS, ui);
    log(
        `ui: ${summary.fonts} fonts (${(fontBytes / 1024).toFixed(0)} KB), ${spriteCount} sprites (${(spriteBytes / 1024).toFixed(0)} KB) ` +
            `-> ${shown} in ${summary.ms} ms`
    );
    return summary;
}

// ---- CLI --------------------------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const usage = 'usage: node web/ui/build.mjs --out <GameDir> [--content <dir>]';
    const argv = process.argv.slice(2);
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out' && argv[i + 1]) {
            opts.out = argv[++i];
        } else if (argv[i] === '--content' && argv[i + 1]) {
            opts.contentDir = argv[++i];
        } else {
            console.error(`unknown argument ${argv[i]}\n${usage}`);
            process.exit(2);
        }
    }
    if (!opts.out) {
        console.error(usage);
        process.exit(2);
    }
    try {
        await buildUi(opts);
    } catch (e) {
        console.error(`ui build failed: ${e.message ?? e}`);
        process.exit(1);
    }
}
