# HUD assets: the game's fonts and sprites for HTML/CSS

`build.mjs` turns the rev-274 content's bitmap fonts and sprites into web assets for the HUD. The fonts become
TrueType files that render pixel-exact at whole multiples of the game pixel; the sprites become PNGs with real
transparency. The input is the upstream content checkout (`scripts/lib/upstream.mjs`), which is never modified, and the output is `<Game>/ui/`, served at
`lostcity://game/ui/…`. The build has no dependencies beyond Node built-ins, and the same input always gives
byte-identical files.

```
node scripts/build-web.mjs                     # the full build runs it (step "Building HUD fonts and sprites")
node web/ui/build.mjs --out build/Game         # just the ui/ folder (from the repo root); --content <dir> defaults to the
                                               # resolved upstream content (scripts/lib/upstream.mjs)
```

```js
import { buildUi } from './web/ui/build.mjs';
await buildUi({ out, contentDir }); // -> { fonts, fontBytes, sprites, spriteBytes, ms }
```

A run replaces `ui/fonts/`, `ui/sprites/` and `ui/textures/` and rewrites `ui/manifest.json`. Nothing else under `ui/`
is touched.

| Output | From | What |
|---|---|---|
| `ui/fonts/{p11,p12,b12,q8}.ttf` | `content/fonts/{p11,p12,b12,q8}_full.png` (+ `meta/*.opt`) | TrueType fonts, 193 glyphs each, 25-36 KB |
| `ui/sprites/<stem>.png` | every PNG in `content/sprites/` and `content/title/` | 589 RGBA PNGs, about 200 KB in all |
| `ui/textures/stone.png` | `content/textures/pebblefloor.png`, coloured from `backvmid1`, `backvmid2`, `backright2`, `backhmid1`, `backbase2` | 128×128 seamless rough stone for the HUD's own frames: each pixel takes the frame stones' colour of the same brightness rank |
| `ui/manifest.json` | | font metrics, every sprite's size and every texture's |

| File | What |
|---|---|
| `build.mjs` | Orchestration, the font recipe, sprite slicing, the manifest |
| `lib/pixfont.mjs` | The client's glyph metrics, replayed from a sheet: packer crop, then `PixFont.depack` |
| `lib/ttf.mjs` | Minimal TrueType writer: head, hhea, maxp 1.0, OS/2 v4, hmtx, cmap 4, loca, glyf, name, post 3, checksums |
| `lib/png.mjs` | Minimal PNG codec: decodes 8-bit RGBA, non-interlaced (all the content uses), encodes 8-bit RGBA |

## Fonts

| key | file | CSS family | ascent (`height`) | descent | 1x line box | space | x-height / cap height | ASCII advances |
|---|---|---|---|---|---|---|---|---|
| p11 | `ui/fonts/p11.ttf` | `'RS Plain 11'` | 10 | 2 | 12 | 3 | 6 / 9 | 3-11 |
| p12 | `ui/fonts/p12.ttf` | `'RS Plain 12'` | 12 | 4 | 16 | 3 | 6 / 10 | 3-13 |
| b12 | `ui/fonts/b12.ttf` | `'RS Bold 12'` | 12 | 4 | 16 | 4 | 6 / 10 | 4-14 |
| q8 | `ui/fonts/q8.ttf` | `'RS Quill 8'` | 15 | 5 | 20 | 7 | 7 / 12 | 3-16 |

All values are in game pixels. Every face has style Regular and weight 400. The PostScript names are
`RSPlain11-Regular`, `RSPlain12-Regular`, `RSBold12-Regular` and `RSQuill8-Regular`.

The client uses them as follows. p12 is the chat font and most interface text. p11 is for small labels and numbers.
b12 is for titles, the right-click menu and the login screen. q8 is the quill font of chatbox dialogues. The client
spaces lines as follows:
- Interface text: font height (10/12/12/15).
- Chat: 14.
- Right-click menu: 15.
- Split private messages: 13.

### Using them

```css
@font-face { font-family: 'RS Plain 12'; src: url(ui/fonts/p12.ttf) format('truetype'); }

.text {
    font: 16px/16px 'RS Plain 12';     /* 16 px = 1 game px per CSS px; line-height = ascent + descent */
    text-shadow: 1px 1px 0 #000;       /* the game's shadow at 1x */
    -webkit-font-smoothing: none;      /* desktop browsers; iOS draws these crisp without it */
    font-synthesis: none;              /* never fake bold/italic (b12 is a Regular face) */
    font-kerning: none;
}
```

**Size.** 1024 units per em and 64 units per game pixel, so `font-size: 16px` draws one game pixel per CSS pixel. At
s CSS px per game px, use `font-size: 16s px`, `line-height: (ascent + descent)·s px` and
`text-shadow: s px s px 0 #000`. Only whole multiples of 16 px are pixel-exact. Never set `font-weight: bold` or
`italic`: the browser would smear a synthetic bold.

**Vertical position.** With `line-height = ascent + descent`, the baseline is exactly `ascent` below the top of the line
box. To match the client's `drawString(s, x, y)`, where y is the baseline, put the line box top at `(y - ascent)·s`
and its left at `x·s`.

**Other line spacings.** CSS splits `line-height - (ascent + descent)` evenly above and below the text. Keep that
difference, multiplied by the device pixel ratio, even; otherwise the baseline lands on half a device pixel. On the
3x iPhone, every odd CSS difference is odd in device pixels. Some examples:
- p12 chat at 14: 14 − 16 = −2, fine.
- p12 at 18: fine.
- p11 at 11 or 13: −1 or +1, half a pixel.
- b12 menu rows at 15: −1, half a pixel.

For those, position each line yourself.

**Centring.** The client centres at `x - floor(width / 2)`, and CSS `text-align: center` rounds differently. Measure
the width with the font and position the text explicitly. Widths are whole game pixels at 16 px: the advances are
multiples of 64 units, and there is no kerning.

**Canvas.** `ctx.font = "${16 * d}px 'RS Plain 12'"`, `textBaseline = 'alphabetic'` and
`fillText(s, x * d, y * d)` match `drawString` at d device pixels per game pixel. Use integer coordinates, and give
the canvas a backing size of exactly its CSS size × devicePixelRatio, or WebKit resamples it. This is exact on iOS.
Chrome on macOS smooths canvas text (grey fringes), while its DOM text is exact.

**Colour tags.** The client parses `@red@`, `@yel@` and similar tags itself (see `PixFont.ts`); the fonts know nothing
about them. Split such strings into coloured spans.

### Character set

| Code points | Glyph |
|---|---|
| U+0021-U+007E, U+00A1-U+00FF | the sheet cell with the same code |
| U+20AC and U+0080 | cell 0x80, the euro sign. Client strings carry € as U+0080, because `Packet.gjstr` does `String.fromCharCode(byte)`. |
| U+0020, U+00A0 | blank, with the client's space advance (`spaceAdvance` in the manifest). The client never draws code 32. The dot that cell 0xA0 holds is a placeholder and is left out. |

Caveats:
- **U+0080.** Browsers and CoreText do not draw the C1 control U+0080 in laid-out text. Replace `\x80` with `€`
  (U+20AC) before display.
- **U+00AD.** The soft hyphen glyph is in the font (its own cell, which differs from '-'), but browsers hide soft
  hyphens. Text that contains byte 0xAD will not show it.
- **Missing characters.** Cells 0x00-0x1F, 0x7F and 0x81-0x9F hold only a placeholder dot and are not mapped.
  Unmapped characters fall back to the next font in the CSS stack. That includes everything above U+00FF except
  U+20AC: curly quotes, emoji and the rest. The client itself only handles 0-255.
- **Chat input.** Chat input is limited to codes 32-126, so typed text always fits.

### How the fonts are made

`lib/pixfont.mjs` replays two steps. First, the engine packer (`tools/pack/PixPack.ts`) crops each 20×20 cell to the
bounding box of its non-#FF00FF pixels. Then the client's `PixFont.depack` derives the metrics:
- The crop's x offset is discarded.
- `offX = 1` and `adv = w + 2`. With `t = floor(h/7)`, if the first column has at most `t` ink pixels in rows
  `t..h-1`, then `offX = 0` and `adv -= 1`. The same test on the last column takes one more off `adv`.
- `height` is the tallest glyph below code 128.
- The space advance is the advance of 'i', or of 'I' for q8.

So glyphs sit where the client draws them, not where they sit in their sheet cell, since the client recomputes the
left margin from the ink.

Each glyph is one rectangle contour per horizontal run of ink, drawn clockwise, at `X = (offX + x)·64` and
`Ytop = (height - offY - row)·64`. Its advance is `adv·64`, and its lsb is `offX·64`, which equals xMin.

The vertical metrics are the same in all three places:
- hhea ascender = OS/2 sTypoAscender = usWinAscent = `height·64`.
- The descenders are `-descent·64`, where descent is the deepest ink below the baseline.
- lineGap is 0.
- fsSelection has USE_TYPO_METRICS set.

There is no hinting, kerning, GSUB or GPOS. The cmap is format 4. The OS/2 strikeout is the client's `@str@` row:
`height - floor(0.7·height)` px above the baseline, 1 px thick. The client draws that line in #800000, not the text
colour, so draw it yourself if you need it.

## Sprites

The colour #FF00FF is the transparency key (`PixPack.ts`). It becomes fully transparent `rgba(0,0,0,0)`, and every
other pixel is opaque and keeps its colour.

| Source | Files |
|---|---|
| a single image (no `meta/<name>.opt`) | `ui/sprites/<name>.png` |
| a sheet (`meta/<name>.opt` = "WxH") | `ui/sprites/<name>-<i>.png`, one per grid cell in row-major order, `i` from 0. No whole-sheet file. |
| the tab stones the client mirrors at load | `redstone1h`, `redstone1v`, `redstone1hv`, `redstone2h`, `redstone2v`, `redstone2hv`, `redstone3v` (h = left-right, v = upside down) |

**Tiles keep the full cell size.** A tile is the whole grid cell even where its ink is smaller, and every cell is
written, including completely transparent ones such as `magicon2-5`…`49`. Drawing a tile at the client's plot
position is therefore pixel-identical to the client, which adds the crop offsets back when it draws. Ink boxes worth
knowing (x, y, w, h inside the cell):
- `combatboxes-0/1`: 2,2 68×32. `combatboxes-2/3`: 2,8 68×20.
- `steelborder2-0`: horizontal edge, 0,15 36×6. `steelborder2-1`: vertical edge, 15,0 6×36.
- `miscgraphics-2/3`: the vertical and horizontal 6-px bars. `miscgraphics-10/11`: checkbox, 0,0 14×15.
- `miscgraphics2-0/1`: 0,0 36×25.
- `mod_icons-0/1`: 0,1 13×11.
- `mapedge`: 8,7 15×16.

**Scaling.** Scale by whole factors with `image-rendering: pixelated`. A background scaled by s needs
`background-size: (w·s)px (h·s)px`.

**Manifest.** `ui/manifest.json` (paths relative to the Game root, i.e. the page):

```json
{
  "fonts": { "p12": { "family": "RS Plain 12", "file": "ui/fonts/p12.ttf", "height": 12, "descent": 4, "spaceAdvance": 3 }, … },
  "sprites": { "backbase1": [496, 50], …, "sideicons-0": [30, 30], …, "redstone2hv": [30, 37], … }
}
```

In `fonts`, `height` is the client's `PixFont.height`, which is both the ascent and the baseline row. In `sprites`,
each value is `[width, height]` and the file is `ui/sprites/<stem>.png`.

### The ones the HUD uses

| What | Files |
|---|---|
| Frame | `backtop1` 765×4, `backleft1` 4×334, `backleft2` 17×96, `backright1` 43×156, `backright2` 22×261, `backvmid1` 34×156, `backvmid2` 37×133, `backvmid3` 57×109, `backhmid1` 249×45 (top tab strip), `backhmid2` 553×19, `backbase1` 496×50 (chat-mode strip), `backbase2` 269×37 (bottom tab strip) |
| Panels | `invback` 190×261 (side panel), `chatback` 479×96, `mapback` 172×156 (minimap ring; its holes are transparent), `compass` 51×51, `mapedge` 31×31, `tradebacking` 88×60 (window fill) |
| Tab icons | `sideicons-0`…`12` (30×30): 0 combat, 1 skills, 2 quests, 3 inventory, 4 equipment, 5 prayer, 6 magic, 7 friends, 8 ignore, 9 logout, 10 options, 11 controls (run), 12 music |
| Active-tab stones | top row: combat `redstone1` (34×36), skills and quests `redstone2` (30×37), inventory `redstone3` (44×35), equipment and prayer `redstone2h`, magic `redstone1h`. Bottom row: (unused tab 7) `redstone1v`, friends and ignore `redstone2v`, logout `redstone3v`, options and controls `redstone2hv`, music `redstone1hv` |
| Buttons | `miscgraphics-0` grey / `-9` red (36×36, the Walk/Run buttons), `miscgraphics2-0/1` (36×25 ink), `miscgraphics3-0/1` 25×25, `combatboxes-0…3`, `titlebutton` 147×41 (login), `leftarrow` / `rightarrow` 45×36, `scrollbar-0` up / `-1` down 16×16 |
| Window chrome | `steelborder-0…3` corners TL, TR, BL, BR (25×30), `steelborder2-0/1` edges, `sworddecor-0…3` (57×13: 1 left half, 0 right half, 2-3 dark) |
| Icons | `mod_icons-0` silver / `-1` gold crown (13×13), `staticons-0…17` skills (25×25; order attack, strength, defence, ranged, prayer, magic, hitpoints, agility, herblore, thieving, crafting, fletching, mining, smithing, fishing, cooking, firemaking, woodcutting), `staticons2-0` runecraft, `headicons-0…8`, `cross-0…7` (walk / action click), `hitmarks-0…2`, `mapdots-0…3`, `mapmarker-0/1` |
| Title | `logo` 444×142, `titlebox` 360×200, `titlebutton` 147×41, `runes-0…15` (96×96 flame masks) |

Also included: `combaticons{,2,3}`, `gnomeball_buttons`, `magicon{,2}`, `magicoff{,2}`, `mapfunction`, `mapscene`,
`prayerglow`, `prayeron`, `prayeroff`, `wornicons`. The build fails if any sprite the HUD depends on disappears from
the content (`REQUIRED_SPRITES` in `build.mjs`).

## Verification (done when this was written)

- **FreeType (Pillow 11.3).** Every mapped character rasterised at 16, 32, 48 and 64 px, compared with an exact
  emulation of the client's `PixFont.drawString`: 0 wrong pixels and 0 grey pixels in all four fonts. String widths
  are identical too.
- **CoreText**, which WebKit uses to load fonts on Apple platforms. At 1x, 2x and 3x, all four fonts: 0 wrong, 0 grey.
  The names and metrics are as listed above.
- **Headless Chrome**, where fonts go through the OTS sanitizer. DOM text at 1x, 2x and 3x with the CSS above: 0 wrong,
  0 grey.
- **fontTools.** Every table checksum and `checkSumAdjustment` is correct, and every table decompiles and round-trips.
  The stored bbox, hhea, maxp and OS/2 fields equal fontTools' recalculation. The outlines and advances are identical
  to the prototype fonts that were checked on iOS Safari.
- **Sprites.** Every PNG equals a PIL conversion of its source (magenta made transparent, tile crop, flips), pixel for
  pixel.
