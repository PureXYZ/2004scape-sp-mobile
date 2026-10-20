// Minimal TrueType (glyf) font writer for the HUD's pixel fonts (web/ui/build.mjs). Dependency-free.
//
//   buildTtf(font) -> Buffer
//
// It writes only what browsers and FreeType need for straight-line outlines: head, hhea, maxp 1.0, OS/2 v4, hmtx,
// cmap (format 4, shared by the Unicode and Windows BMP encodings), loca (long), glyf, name and post v3 (no glyph
// names). Table checksums and head.checkSumAdjustment are computed. There is no hinting, kerning, or composite or
// quadratic outline, and every point is on-curve. Output is deterministic: the timestamps come from `font.date`.
//
// font = {
//   familyName, styleName = 'Regular', postScriptName, version = 1,   // version: head.fontRevision and name ID 5
//   unitsPerEm, ascender, descender (negative), lineGap = 0,           // hhea and OS/2 typo/win metrics
//   xHeight, capHeight, strikeoutSize, strikeoutPosition, underlinePosition, underlineThickness,
//   lowestRecPPEM, date: Date,
//   glyphs: [{ advance, contours: [[[x, y], ...], ...] }],             // glyph 0 is .notdef; integer font units
//   cmap: [[codePoint, glyphIndex], ...]                               // BMP code points only
// }
// Contours are closed polygons of on-curve points. Outer contours must run clockwise (y up), the TrueType
// convention. The caller is responsible for that.

const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME_OR_POSITIVE = 0x10;
const Y_SAME_OR_POSITIVE = 0x20;

class Writer {
    bytes = [];
    get length() {
        return this.bytes.length;
    }
    u8(v) {
        this.bytes.push(v & 0xff);
        return this;
    }
    u16(v) {
        return this.u8(v >> 8).u8(v);
    }
    i16(v) {
        if (!Number.isInteger(v) || v < -0x8000 || v > 0x7fff) {
            throw new Error(`ttf: int16 out of range: ${v}`);
        }
        return this.u16(v & 0xffff);
    }
    u32(v) {
        return this.u16(Math.floor(v / 0x10000) & 0xffff).u16(v & 0xffff);
    }
    tag(s) {
        for (let i = 0; i < 4; i++) {
            this.u8(s.charCodeAt(i));
        }
        return this;
    }
    data(buffer) {
        for (const b of buffer) {
            this.u8(b);
        }
        return this;
    }
    pad4() {
        while (this.bytes.length % 4) {
            this.u8(0);
        }
        return this;
    }
    buffer() {
        return Buffer.from(this.bytes);
    }
}

// Big-endian uint32 sum of the data zero-padded to a multiple of 4 bytes.
function checksum(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 4) {
        sum = (sum + (((buffer[i] << 24) | ((buffer[i + 1] ?? 0) << 16) | ((buffer[i + 2] ?? 0) << 8) | (buffer[i + 3] ?? 0)) >>> 0)) >>> 0;
    }
    return sum;
}

// LONGDATETIME: seconds since 1904-01-01T00:00:00Z.
function longDateTime(w, date) {
    const seconds = Math.floor(date.getTime() / 1000) + 2082844800;
    return w.u32(Math.floor(seconds / 0x100000000)).u32(seconds % 0x100000000);
}

function compileGlyph(contours) {
    const w = new Writer();
    if (!contours.length) {
        return { data: w.buffer(), points: 0, contours: 0 };
    }
    const points = contours.flat();
    for (const [x, y] of points) {
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
            throw new Error(`ttf: non-integer point ${x},${y}`);
        }
    }
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    const bbox = { xMin: Math.min(...xs), yMin: Math.min(...ys), xMax: Math.max(...xs), yMax: Math.max(...ys) };
    w.i16(contours.length).i16(bbox.xMin).i16(bbox.yMin).i16(bbox.xMax).i16(bbox.yMax);
    let end = -1;
    for (const contour of contours) {
        if (contour.length < 2) {
            throw new Error('ttf: a contour needs at least two points');
        }
        end += contour.length;
        w.u16(end);
    }
    w.u16(0); // instructionLength

    const flags = [];
    const xData = new Writer();
    const yData = new Writer();
    let px = 0;
    let py = 0;
    for (const [x, y] of points) {
        let flag = ON_CURVE;
        const dx = x - px;
        const dy = y - py;
        if (dx === 0) {
            flag |= X_SAME_OR_POSITIVE;
        } else if (Math.abs(dx) < 256) {
            flag |= X_SHORT | (dx > 0 ? X_SAME_OR_POSITIVE : 0);
            xData.u8(Math.abs(dx));
        } else {
            xData.i16(dx);
        }
        if (dy === 0) {
            flag |= Y_SAME_OR_POSITIVE;
        } else if (Math.abs(dy) < 256) {
            flag |= Y_SHORT | (dy > 0 ? Y_SAME_OR_POSITIVE : 0);
            yData.u8(Math.abs(dy));
        } else {
            yData.i16(dy);
        }
        flags.push(flag);
        px = x;
        py = y;
    }
    for (let i = 0; i < flags.length; ) {
        let repeat = 0;
        while (i + 1 + repeat < flags.length && flags[i + 1 + repeat] === flags[i] && repeat < 255) {
            repeat++;
        }
        if (repeat > 1) {
            w.u8(flags[i] | REPEAT).u8(repeat);
        } else {
            for (let k = 0; k <= repeat; k++) {
                w.u8(flags[i]);
            }
        }
        i += repeat + 1;
    }
    w.data(xData.bytes).data(yData.bytes).pad4();
    return { data: w.buffer(), points: points.length, contours: contours.length, bbox };
}

function nameTable({ familyName, styleName, postScriptName, version }) {
    const fullName = styleName === 'Regular' ? familyName : `${familyName} ${styleName}`;
    const versionString = `Version ${version.toFixed(3)}`;
    const strings = [
        [1, familyName],
        [2, styleName],
        [3, `${version.toFixed(3)};NONE;${postScriptName}`],
        [4, fullName],
        [5, versionString],
        [6, postScriptName]
    ];
    for (const [id, s] of strings) {
        if (!/^[\x20-\x7e]+$/.test(s)) {
            throw new Error(`ttf: name ${id} must be printable ASCII: ${JSON.stringify(s)}`);
        }
    }
    if (!/^[\x21-\x7e]+$/.test(postScriptName) || /[[\](){}<>/%]/.test(postScriptName) || postScriptName.length > 63) {
        throw new Error(`ttf: invalid PostScript name ${JSON.stringify(postScriptName)}`);
    }
    // Macintosh Roman (ASCII here) and Windows Unicode BMP (UTF-16BE, US English), sorted by platform, encoding,
    // language and name ID as the spec requires.
    const records = [];
    const storage = new Writer();
    for (const [platform, encoding, language, encode] of [
        [1, 0, 0, s => Buffer.from(s, 'latin1')],
        [3, 1, 0x0409, s => Buffer.from(s, 'utf16le').swap16()]
    ]) {
        for (const [id, s] of strings) {
            const bytes = encode(s);
            records.push([platform, encoding, language, id, bytes.length, storage.length]);
            storage.data(bytes);
        }
    }
    const w = new Writer().u16(0).u16(records.length).u16(6 + 12 * records.length);
    for (const record of records) {
        for (const v of record) {
            w.u16(v);
        }
    }
    return w.data(storage.bytes).buffer();
}

function cmapTable(cmap) {
    const pairs = [...cmap].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < pairs.length; i++) {
        const [cp, gid] = pairs[i];
        if (!Number.isInteger(cp) || cp < 0 || cp >= 0xffff || (i > 0 && pairs[i - 1][0] === cp)) {
            throw new Error(`ttf: bad or duplicate cmap code point ${cp}`);
        }
        if (!Number.isInteger(gid) || gid < 0) {
            throw new Error(`ttf: bad glyph index ${gid} for U+${cp.toString(16)}`);
        }
    }
    // One segment per run of consecutive code points that map to consecutive glyphs (idDelta, no glyphIdArray), then
    // the required final 0xFFFF segment.
    const segments = [];
    for (const [cp, gid] of pairs) {
        const last = segments[segments.length - 1];
        if (last && cp === last.end + 1 && gid - cp === last.delta) {
            last.end = cp;
        } else {
            segments.push({ start: cp, end: cp, delta: gid - cp });
        }
    }
    segments.push({ start: 0xffff, end: 0xffff, delta: 1 });
    const segCount = segments.length;
    const entrySelector = Math.floor(Math.log2(segCount));
    const searchRange = 2 * 2 ** entrySelector;
    const sub = new Writer().u16(4).u16(16 + 8 * segCount).u16(0); // format, length, language
    sub.u16(2 * segCount).u16(searchRange).u16(entrySelector).u16(2 * segCount - searchRange);
    segments.forEach(s => sub.u16(s.end));
    sub.u16(0); // reservedPad
    segments.forEach(s => sub.u16(s.start));
    segments.forEach(s => sub.u16(s.delta & 0xffff));
    segments.forEach(() => sub.u16(0)); // idRangeOffset
    // Encoding records: Unicode BMP (0,3) and Windows Unicode BMP (3,1) share the one subtable.
    const w = new Writer().u16(0).u16(2);
    w.u16(0).u16(3).u32(4 + 2 * 8);
    w.u16(3).u16(1).u32(4 + 2 * 8);
    return w.data(sub.bytes).buffer();
}

// OS/2 ulUnicodeRange bits for the blocks these fonts use: [bit, first, last].
const UNICODE_RANGES = [
    [0, 0x0000, 0x007f], // Basic Latin
    [1, 0x0080, 0x00ff], // Latin-1 Supplement
    [33, 0x20a0, 0x20cf] // Currency Symbols
];

export function buildTtf(font) {
    const {
        familyName,
        styleName = 'Regular',
        postScriptName,
        version = 1,
        unitsPerEm,
        ascender,
        descender,
        lineGap = 0,
        xHeight = 0,
        capHeight = 0,
        strikeoutSize = 0,
        strikeoutPosition = 0,
        underlinePosition = 0,
        underlineThickness = 0,
        lowestRecPPEM = 8,
        date,
        glyphs,
        cmap
    } = font;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new Error('ttf: font.date must be a valid Date (fixed, so the output is reproducible)');
    }
    if (!glyphs.length || glyphs.length > 0xffff) {
        throw new Error(`ttf: bad glyph count ${glyphs.length}`);
    }
    for (const [cp, gid] of cmap) {
        if (gid >= glyphs.length) {
            throw new Error(`ttf: U+${cp.toString(16)} maps to missing glyph ${gid}`);
        }
    }

    // glyf + loca
    const compiled = glyphs.map(g => compileGlyph(g.contours ?? []));
    const glyf = new Writer();
    const loca = new Writer();
    for (const g of compiled) {
        loca.u32(glyf.length);
        glyf.data(g.data);
    }
    loca.u32(glyf.length);

    // hmtx, and the hhea / head extremes over glyphs with contours
    const hmtx = new Writer();
    const box = { xMin: Infinity, yMin: Infinity, xMax: -Infinity, yMax: -Infinity };
    let minLsb = Infinity;
    let minRsb = Infinity;
    let maxExtent = -Infinity;
    glyphs.forEach((g, i) => {
        const { bbox } = compiled[i];
        const lsb = bbox ? bbox.xMin : 0;
        if (!Number.isInteger(g.advance) || g.advance < 0 || g.advance > 0xffff) {
            throw new Error(`ttf: bad advance ${g.advance} for glyph ${i}`);
        }
        hmtx.u16(g.advance).i16(lsb);
        if (bbox) {
            box.xMin = Math.min(box.xMin, bbox.xMin);
            box.yMin = Math.min(box.yMin, bbox.yMin);
            box.xMax = Math.max(box.xMax, bbox.xMax);
            box.yMax = Math.max(box.yMax, bbox.yMax);
            minLsb = Math.min(minLsb, lsb);
            minRsb = Math.min(minRsb, g.advance - bbox.xMax);
            maxExtent = Math.max(maxExtent, bbox.xMax);
        }
    });
    if (box.xMin === Infinity) {
        Object.assign(box, { xMin: 0, yMin: 0, xMax: 0, yMax: 0 });
        minLsb = minRsb = maxExtent = 0;
    }
    const advanceMax = Math.max(...glyphs.map(g => g.advance));

    const head = new Writer()
        .u16(1)
        .u16(0)
        .u32(Math.round(version * 0x10000)) // fontRevision (Fixed 16.16)
        .u32(0) // checkSumAdjustment, patched below
        .u32(0x5f0f3cf5)
        .u16(0x0003) // flags: baseline at y=0, left sidebearing at x=0 (lsb == xMin)
        .u16(unitsPerEm);
    longDateTime(head, date); // created
    longDateTime(head, date); // modified
    head.i16(box.xMin).i16(box.yMin).i16(box.xMax).i16(box.yMax);
    head.u16(0) // macStyle
        .u16(lowestRecPPEM)
        .i16(2) // fontDirectionHint (deprecated, fixed value)
        .i16(1) // indexToLocFormat: long
        .i16(0); // glyphDataFormat

    const hhea = new Writer().u16(1).u16(0).i16(ascender).i16(descender).i16(lineGap).u16(advanceMax);
    hhea.i16(minLsb).i16(minRsb).i16(maxExtent);
    hhea.i16(1).i16(0).i16(0); // caretSlopeRise, caretSlopeRun, caretOffset
    hhea.i16(0).i16(0).i16(0).i16(0); // reserved
    hhea.i16(0).u16(glyphs.length); // metricDataFormat, numberOfHMetrics

    const maxp = new Writer().u32(0x00010000).u16(glyphs.length);
    maxp.u16(Math.max(...compiled.map(g => g.points))).u16(Math.max(...compiled.map(g => g.contours)));
    maxp.u16(0).u16(0); // maxCompositePoints, maxCompositeContours
    maxp.u16(2); // maxZones
    for (let i = 0; i < 8; i++) {
        maxp.u16(0); // twilight points, storage, function defs, instruction defs, stack, instructions, components, depth
    }

    const codePoints = cmap.map(([cp]) => cp);
    const unicodeRanges = [0, 0, 0, 0];
    for (const [bit, from, to] of UNICODE_RANGES) {
        if (codePoints.some(cp => cp >= from && cp <= to)) {
            unicodeRanges[bit >> 5] = (unicodeRanges[bit >> 5] | (1 << (bit & 31))) >>> 0;
        }
    }
    const hasAscii = [...Array(0x7f - 0x20).keys()].every(i => codePoints.includes(0x20 + i));
    const widths = glyphs.map(g => g.advance).filter(a => a > 0);
    const em = v => Math.round(v * unitsPerEm);
    const os2 = new Writer()
        .u16(4) // version
        .i16(widths.length ? Math.round(widths.reduce((a, b) => a + b, 0) / widths.length) : 0) // xAvgCharWidth
        .u16(400) // usWeightClass
        .u16(5) // usWidthClass
        .u16(0) // fsType: installable
        .i16(em(0.65)) // ySubscriptXSize
        .i16(em(0.6)) // ySubscriptYSize
        .i16(0) // ySubscriptXOffset
        .i16(em(0.075)) // ySubscriptYOffset
        .i16(em(0.65)) // ySuperscriptXSize
        .i16(em(0.6)) // ySuperscriptYSize
        .i16(0) // ySuperscriptXOffset
        .i16(em(0.35)) // ySuperscriptYOffset
        .i16(strikeoutSize)
        .i16(strikeoutPosition)
        .i16(0) // sFamilyClass
        .data(new Uint8Array(10)) // panose: any
        .u32(unicodeRanges[0])
        .u32(unicodeRanges[1])
        .u32(unicodeRanges[2])
        .u32(unicodeRanges[3])
        .tag('NONE') // achVendID
        .u16(0x00c0) // fsSelection: REGULAR | USE_TYPO_METRICS
        .u16(Math.min(...codePoints)) // usFirstCharIndex
        .u16(Math.min(Math.max(...codePoints), 0xffff)) // usLastCharIndex
        .i16(ascender) // sTypoAscender
        .i16(descender) // sTypoDescender
        .i16(lineGap) // sTypoLineGap
        .u16(Math.max(ascender, box.yMax)) // usWinAscent
        .u16(Math.max(-descender, -box.yMin)) // usWinDescent
        .u32(hasAscii && codePoints.includes(0xde) ? 1 : 0) // ulCodePageRange1: bit 0 Latin 1 (as fontTools computes it)
        .u32(0) // ulCodePageRange2
        .i16(xHeight) // sxHeight
        .i16(capHeight) // sCapHeight
        .u16(0) // usDefaultChar
        .u16(0x20) // usBreakChar
        .u16(0); // usMaxContext

    const post = new Writer().u32(0x00030000).u32(0); // version 3.0, italicAngle
    post.i16(underlinePosition).i16(underlineThickness);
    post.u32(0).u32(0).u32(0).u32(0).u32(0); // isFixedPitch, min/maxMemType42, min/maxMemType1

    // File order as recommended for TrueType fonts; the table directory is sorted by tag.
    const tables = [
        ['head', head.buffer()],
        ['hhea', hhea.buffer()],
        ['maxp', maxp.buffer()],
        ['OS/2', os2.buffer()],
        ['hmtx', hmtx.buffer()],
        ['cmap', cmapTable(cmap)],
        ['loca', loca.buffer()],
        ['glyf', glyf.buffer()],
        ['name', nameTable({ familyName, styleName, postScriptName, version })],
        ['post', post.buffer()]
    ];
    const numTables = tables.length;
    const entrySelector = Math.floor(Math.log2(numTables));
    const searchRange = 16 * 2 ** entrySelector;
    let offset = 12 + 16 * numTables;
    const placed = tables.map(([tag, data]) => {
        const entry = { tag, data, offset, checksum: checksum(data) };
        offset += Math.ceil(data.length / 4) * 4;
        return entry;
    });

    const file = new Writer().u32(0x00010000).u16(numTables).u16(searchRange).u16(entrySelector).u16(numTables * 16 - searchRange);
    for (const t of [...placed].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))) {
        file.tag(t.tag).u32(t.checksum).u32(t.offset).u32(t.data.length);
    }
    for (const t of placed) {
        file.data(t.data).pad4();
    }
    const out = file.buffer();
    const headOffset = placed.find(t => t.tag === 'head').offset;
    out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, headOffset + 8);
    return out;
}
