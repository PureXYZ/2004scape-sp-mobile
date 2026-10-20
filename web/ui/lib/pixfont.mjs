// Glyph metrics of a rev-274 bitmap font as the client sees them, computed from the content sheet.
//
//   readPixFont(image, { cellWidth, cellHeight, quill, label }) -> { height, glyphs }
//     image:  decoded sheet { width, height, data (RGBA) }. Server/content/fonts/*_full.png is 16x16 cells of 20x20
//             ("20x20" in fonts/meta/*.opt); cell index = character code. Ink is #FFFFFF and empty is #FF00FF.
//     height: the client's PixFont.height, i.e. the baseline row (ascent).
//     glyphs: 256 entries of { offX, offY, w, h, adv, mask }. mask is a w*h Uint8Array of 0/1, row by row. A glyph's
//             top-left is drawn at (x + offX, baseline - height + offY), then x advances by adv.
//
// This replays two steps:
//   1. The engine packer (Engine-TS tools/pack/PixPack.ts getPixelBounds/writeImage) crops each cell to the bounding
//      box of its non-#FF00FF pixels; an empty cell keeps its full size. Only RGB counts, and alpha is ignored.
//   2. The client's PixFont.depack (Client-TS src/graphics/PixFont.ts), which throws the crop's x offset away:
//      offX = 1 and adv = w + 2. With t = floor(h / 7), if column 0 has <= t ink pixels in rows t..h-1, then offX = 0
//      and adv -= 1. If the last column has <= t, adv -= 1 again. height = the largest h among codes < 128. The space
//      advance is the advance of 'i', or of 'I' for the quill font (q8).
// The client sums palette indices in that column test, so the sheet must have exactly one ink colour (index 1).
// Anything else is an error rather than a silently different font.

const MAGENTA = 0xff00ff;

export function readPixFont(image, { cellWidth = 20, cellHeight = 20, quill = false, label = 'font' } = {}) {
    const { width, height, data } = image;
    const cols = width / cellWidth;
    const rows = height / cellHeight;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols * rows !== 256) {
        throw new Error(`${label}: a ${width}x${height} sheet of ${cellWidth}x${cellHeight} cells does not hold 256 glyphs`);
    }
    const rgb = (x, y) => {
        const i = (y * width + x) * 4;
        return (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    };
    let ink = null;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const c = rgb(x, y);
            if (c !== MAGENTA && ink === null) {
                ink = c;
            } else if (c !== MAGENTA && c !== ink) {
                throw new Error(
                    `${label}: more than one ink colour (#${ink.toString(16).padStart(6, '0')} and #${c.toString(16).padStart(6, '0')} at ${x},${y}); ` +
                        'the client metrics depend on palette indices, expected one ink colour on #FF00FF'
                );
            }
        }
    }

    const glyphs = [];
    for (let code = 0; code < 256; code++) {
        const cx = (code % cols) * cellWidth;
        const cy = Math.floor(code / cols) * cellHeight;
        let left = cellWidth;
        let top = cellHeight;
        let right = -1;
        let bottom = -1;
        for (let y = 0; y < cellHeight; y++) {
            for (let x = 0; x < cellWidth; x++) {
                if (rgb(cx + x, cy + y) !== MAGENTA) {
                    left = Math.min(left, x);
                    top = Math.min(top, y);
                    right = Math.max(right, x);
                    bottom = Math.max(bottom, y);
                }
            }
        }
        if (right === -1) {
            left = 0;
            top = 0;
            right = cellWidth - 1;
            bottom = cellHeight - 1;
        }
        const w = right - left + 1;
        const h = bottom - top + 1;
        const mask = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                mask[y * w + x] = rgb(cx + left + x, cy + top + y) === MAGENTA ? 0 : 1;
            }
        }

        let offX = 1;
        let adv = w + 2;
        const t = Math.floor(h / 7);
        let leftInk = 0;
        let rightInk = 0;
        for (let y = t; y < h; y++) {
            leftInk += mask[y * w];
            rightInk += mask[y * w + w - 1];
        }
        if (leftInk <= t) {
            adv--;
            offX = 0;
        }
        if (rightInk <= t) {
            adv--;
        }
        glyphs.push({ offX, offY: top, w, h, adv, mask });
    }

    let fontHeight = 0;
    for (let code = 0; code < 128; code++) {
        fontHeight = Math.max(fontHeight, glyphs[code].h);
    }
    glyphs[32].adv = quill ? glyphs[73].adv : glyphs[105].adv;
    return { height: fontHeight, glyphs };
}
