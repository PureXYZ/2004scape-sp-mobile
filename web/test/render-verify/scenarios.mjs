// render-verify scenarios: each puts the client where the 3D area changes while the camera stays still (or makes the
// change itself), with the oracle checking every frame. Grouped in sessions (one boot and one character each):
//   world  no bots: Lumbridge and around, every kind of change one at a time
//   bots   500 bots: Varrock West's crowd, Edgeville's PK fights, a long idle
// A scenario is { name, what, run(ctx) }; ctx = { d (driver), g (game steps, lib.mjs), log, sleepScaled(ms), scale }.
// Durations are at --scale 1; the oracle checks every frame throughout, including the camera's moves between holds.
import { sleep } from './lib.mjs';

const C = 'window.__client';
const clean = s => String(s ?? '').replace(/@[a-z0-9]{3}@/g, '');

// ---------------------------------------------------------------------------------------------------- helpers

// A character off Tutorial Island with the levels and tools the scenarios use (jmod: the :: commands).
async function makeCharacter({ d, g, log }) {
    const name = `rv${Date.now() % 1000000}`;
    let t = Date.now();
    let r = await g.login(name);
    if (!r.ok) throw new Error(`login (new character) failed: ${JSON.stringify(r.why)}`);
    log(`  new character ${name}: ${Date.now() - t} ms`);
    // the character designer: its Accept (classic 260,286; hud.mjs), as a player taps it
    const designer = await d.waitFor(`${C}.mainModalId !== -1`, 8000);
    if (designer.ok) {
        await sleep(800);
        const modal = await d.eval(`[${C}.modalX, ${C}.modalY]`);
        const accept = await g.worldPoint(modal[0] + 256, modal[1] + 282);
        await d.tap(accept.x, accept.y);
        const closed = await d.waitFor(`${C}.mainModalId === -1`, 5000);
        log(`  designer accepted: ${closed.ok}`);
    }
    await sleep(800);
    await g.dismiss();
    await g.chat('::setvar tutorial 1000');
    await g.tele(0, 3222, 3218, 1000); // (off the island: a logout there keeps the player in the world for 90 s)
    const out = await g.logout();
    log(`  logout: ${JSON.stringify(out)}`);
    await sleep(1500);
    t = Date.now();
    r = await g.login(name);
    if (!r.ok) throw new Error(`login again failed: ${JSON.stringify(r.why)}`);
    log(`  logged in again: ${Date.now() - t} ms ${JSON.stringify(r.tries ?? [])}; tabs ${JSON.stringify(await d.eval(`${C}.sideIcon?.slice?.(0, 14)`))}`);
    await sleep(1500);
    for (const s of ['attack', 'strength', 'defence', 'hitpoints', 'ranged', 'magic', 'prayer', 'woodcutting', 'fishing', 'mining', 'firemaking', 'cooking']) await g.chat(`::setstat ${s} 99`, 120);
    for (const item of ['rune_axe', 'small_fishing_net', 'rune_pickaxe', 'tinderbox', 'logs', 'logs', 'logs', 'rune_scimitar', 'rune_full_helm', 'rune_platebody', 'shrimp', 'shrimp', 'shrimp', 'shrimp']) await g.chat(`::give ${item}`, 150);
    await sleep(800);
    const vp = await d.eval(`[${C}.viewportX, ${C}.viewportY, ${C}.viewportWidth, ${C}.viewportHeight, devicePixelRatio, document.body.className]`);
    log(`  character ready at ${JSON.stringify(await g.tile())}, viewport ${JSON.stringify(vp)}`);
    return name;
}

// The options at a viewport point, as the pointer hovering there gets them (the world's options come from 3D picking
// during a draw, so after two minimenus built since the pointer moved there; hud.mjs hover()). Top entry last.
const hover = (d, vx, vy) =>
    d.eval(`new Promise(resolve => { const c = ${C}, build = c.buildMinimenu; let builds = 0, timer = 0;
        const done = () => { clearTimeout(timer); delete c.buildMinimenu; resolve(c.menuOption.slice(0, c.menuNumEntries)); };
        c.buildMinimenu = function () { const r = build.apply(this, arguments); if (++builds === 2) done(); return r; };
        timer = setTimeout(done, 3000);
        c.mouseX = c.viewportX + ${vx}; c.mouseY = c.viewportY + ${vy}; })`);

// A viewport point whose top option matches `re` (a grid over the part of the world the HUD leaves free, nearest the
// centre first), or null.
async function findOption(ctx, re, step = 22) {
    const { d } = ctx;
    for (const [x, y] of await sceneryPoints(ctx)) {
        const top = clean((await hover(d, x, y)).at(-1));
        if (re.test(top)) return { vx: x, vy: y, option: top };
    }
    const box = await d.eval(`(() => { const c = ${C}; const fl = c.freeLeft ?? 0, ft = c.freeTop ?? 0, fr = c.freeRight ?? c.viewportWidth, fb = c.freeBottom ?? c.viewportHeight;
        return { w: c.viewportWidth, h: c.viewportHeight, l: Math.max(4, fl + 6), t: Math.max(4, ft + 6), r: Math.min(c.viewportWidth - 4, fr - 6), b: Math.min(c.viewportHeight - 4, fb - 6) }; })()`);
    const pts = [];
    for (let y = box.t; y < box.b; y += step) for (let x = box.l; x < box.r; x += step) pts.push([x, y]);
    const cx = box.w / 2, cy = box.h / 2;
    pts.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    for (const [x, y] of pts) {
        const top = clean((await hover(d, x, y)).at(-1));
        if (re.test(top)) return { vx: x, vy: y, option: top };
    }
    return null;
}

// Viewport points over the tiles near the player that hold scenery or objects (projected at a few heights), nearest
// the player first: where findOption looks before its grid (far fewer points to hover).
const sceneryPoints = (ctx, radius = 10) =>
    ctx.d.eval(`(() => { const c = ${C}, w = c.world, p = c.localPlayer, lv = c.minusedlevel, px = p.x >> 7, pz = p.z >> 7, out = [];
        const fl = (c.freeLeft ?? 0) + 6, ft = (c.freeTop ?? 0) + 6, fr = (c.freeRight ?? c.viewportWidth) - 6, fb = (c.freeBottom ?? c.viewportHeight) - 6;
        for (let x = px - ${radius}; x <= px + ${radius}; x++) for (let z = pz - ${radius}; z <= pz + ${radius}; z++) {
            const t = w?.squares?.[lv]?.[x]?.[z]; if (!t || !(t.spriteCount > 0 || t.wall || t.decor || t.groundObject)) continue;
            for (const h of [20, 60, 110]) { c.getOverlayPos(x * 128 + 64, z * 128 + 64, h); if (c.projectX > fl && c.projectX < fr && c.projectY > ft && c.projectY < fb) out.push([c.projectX, c.projectY, Math.hypot(x - px, z - pz)]); }
        }
        return out.sort((a, b) => a[2] - b[2]).slice(0, 150).map(q => [q[0], q[1]]); })()`);

async function tapWorld(ctx, vx, vy, holdMs = 60) {
    const p = await ctx.g.worldPoint(vx, vy);
    await ctx.d.tap(p.x, p.y, holdMs);
}

// Taps the first thing whose top option matches re; the option, or null when none is on screen.
async function act(ctx, re) {
    const hit = await findOption(ctx, re);
    if (!hit) {
        ctx.log(`    (nothing on screen offers ${re})`);
        return null;
    }
    await tapWorld(ctx, hit.vx, hit.vy);
    ctx.log(`    tapped "${hit.option}" at ${hit.vx},${hit.vy}`);
    return hit;
}

// Taps an NPC whose name matches nameRe where its top option matches optionRe (projected at a few heights of its
// model, hud.mjs findNpc), nearest first; the option or null.
async function actNpc(ctx, nameRe, optionRe) {
    const npcs = await ctx.d.eval(`(() => { const c = ${C}, p = c.localPlayer, out = []; for (let i = 0; i < c.npcCount; i++) { const n = c.npc[c.npcIds[i]]; if (n?.type?.name && ${nameRe}.test(n.type.name)) out.push({ id: c.npcIds[i], d: Math.hypot(n.x - p.x, n.z - p.z) }); } return out.sort((a, b) => a.d - b.d); })()`);
    for (const n of npcs) {
        for (const [f, ox, oy] of [[0.5, 0, 0], [0.25, 0, 0], [0.75, 0, 0], [0.1, 0, 0], [0.5, -8, 0], [0.5, 8, 0], [0.3, 0, 6], [0.6, 0, -6]]) {
            const at = await ctx.d.eval(`(() => { const c = ${C}, n = c.npc[${n.id}]; if (!n) return null; c.getOverlayPos(n.x, n.z, ((n.height || 60) * ${f}) | 0); return c.projectX >= 0 ? { vx: c.projectX + ${ox}, vy: c.projectY + ${oy} } : null; })()`);
            if (!at) continue;
            const pt = await ctx.g.worldPoint(at.vx, at.vy);
            const free = await ctx.d.eval(`(() => { const c = ${C}; return ${at.vx} > (c.freeLeft ?? 0) + 4 && ${at.vx} < (c.freeRight ?? c.viewportWidth) - 4 && ${at.vy} > (c.freeTop ?? 0) + 4 && ${at.vy} < (c.freeBottom ?? c.viewportHeight) - 4; })()`);
            if (!free) continue;
            const top = clean((await hover(ctx.d, at.vx, at.vy)).at(-1));
            if (!optionRe.test(top)) continue;
            await ctx.d.tap(pt.x, pt.y);
            ctx.log(`    tapped "${top}" at ${at.vx},${at.vy}`);
            return top;
        }
    }
    ctx.log(`    (no NPC ${nameRe} offering ${optionRe} on screen; ${npcs.length} by that name)`);
    return null;
}
// Taps the ground tile (dx, dz) from the player where its top option matches re; the option or null.
async function actTile(ctx, dx, dz, re) {
    for (const [ox, oy] of [[0, 0], [0, -6], [6, 0], [-6, 0], [0, 6], [0, -12]]) {
        const at = await ctx.g.tilePoint(dx, dz);
        if (!at) return null;
        const vx = at.x + ox, vy = at.y + oy;
        const top = clean((await hover(ctx.d, vx, vy)).at(-1));
        if (!re.test(top)) continue;
        await tapWorld(ctx, vx, vy);
        ctx.log(`    tapped "${top}" on tile ${dx},${dz}`);
        return top;
    }
    ctx.log(`    (tile ${dx},${dz} offers no ${re})`);
    return null;
}

// Waits while the camera is still (the oracle checks every frame meanwhile).
const hold = (ctx, ms) => ctx.sleepScaled(ms);
const sweep = (ctx, on) => ctx.d.eval(`window.__rv.sweep(${on})`);
// waits until the local player has stood still for `ms`
async function settle(ctx, ms = 1200, timeoutMs = 20000) {
    let last = JSON.stringify(await ctx.g.tile());
    let since = Date.now();
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        await sleep(200);
        const now = JSON.stringify(await ctx.g.tile());
        if (now !== last) {
            last = now;
            since = Date.now();
        } else if (Date.now() - since >= ms) return;
    }
}

// The inventory (tab 3) or worn equipment (tab 4) panel, and a slot whose top option matches re: { s, x, y } in
// virtual coordinates (for tapAt), or null (hud.mjs invOf/slotWith).
const invOf = tab => `(() => { const list = ${C}.chatInterface.constructor.list;
    const find = (com, x, y, scroll) => { for (let i = 0; i < (com?.children?.length ?? 0); i++) { const child = list[com.children[i]]; if (!child) continue;
        const cx = x + com.childX[i] + child.x, cy = y + com.childY[i] + child.y - scroll;
        if (child.type === 2) return { com: child, x: cx, y: cy };
        const found = child.type === 0 ? find(child, cx, cy, child.scrollPos) : null; if (found) return found; } return null; };
    return find(list[${C}.sideIcon[${tab}]], 553, 205, 0); })()`;
async function openTab(ctx, tab) {
    await ctx.g.tapElement(`#hud-tabs .tab[data-tab="${tab}"]`);
    await ctx.d.waitFor(`${C}.hudState().activeTab === ${tab} && !!document.getElementById('hud-panel')?.getClientRects().length`, 3000, 100);
    await sleep(600);
}
const slotWith = (ctx, tab, re) =>
    ctx.d.eval(`(() => { const c = ${C}, inv = ${invOf(tab)}; if (!inv) return null; const com = inv.com, re = ${re};
        for (let s = 0; s < com.linkObjType.length; s++) { if (com.linkObjType[s] <= 0) continue;
            const x = inv.x + (s % com.width) * (com.marginX + 32) + 16, y = inv.y + ((s / com.width) | 0) * (com.marginY + 32) + 16;
            c.mouseX = x; c.mouseY = y; c.buildMinimenu(); if (re.test(c.menuOption[c.menuNumEntries - 1].replace(/@[a-z0-9]{3}@/g, ''))) return { s, x, y, option: c.menuOption[c.menuNumEntries - 1] }; }
        return null; })()`);
async function tapSlot(ctx, tab, re) {
    const slot = await slotWith(ctx, tab, re);
    if (!slot) {
        ctx.log(`    (no slot in tab ${tab} offers ${re})`);
        return null;
    }
    await ctx.d.eval(`${C}.tapAt(${slot.x}, ${slot.y})`);
    await sleep(600);
    return slot;
}
async function closePanel(ctx) {
    const open = await ctx.d.eval(`!document.getElementById('hud-panel')?.hidden && !!document.getElementById('hud-panel')?.getClientRects().length`);
    if (open) {
        const tab = await ctx.d.eval(`${C}.hudState().activeTab`);
        await ctx.g.tapElement(`#hud-tabs .tab[data-tab="${tab}"]`).catch(() => {});
        await sleep(300);
    }
}
// turns the camera by dragging the world (CSS px; 4 yaw units a px)
async function turn(ctx, dx, dy = 0) {
    const p = await ctx.g.worldPoint(406, 190);
    await ctx.d.drag(p.x, p.y, p.x + dx, p.y + dy, 10, 25);
    await sleep(300);
}

// ---------------------------------------------------------------------------------------------------- places

const LUMBRIDGE = [3222, 3218]; // the castle courtyard: two fountains (texture 17), NPCs, doors east
const TREES = [3175, 3222]; // trees west of Lumbridge castle
const DRAYNOR_NET = [3088, 3229]; // Draynor's net fishing spots (3085,3230), (3086,3227)
const VARROCK_MINE = [3176, 3367]; // tin and clay south-west of Varrock
const COWS = [3258, 3270]; // the cow field east of Lumbridge's river
const WINDMILL = [3168, 3301]; // the mill north of Lumbridge (base 3166,3307)
const FIRES = [3149, 3203]; // fires burning west of Lumbridge (3146-3147, 3200-3201)
const VARROCK_WEST = [3185, 3436]; // the bots' hub: Varrock West bank
const EDGEVILLE_DITCH = [3093, 3517]; // south of the Wilderness ditch, looking at Edgeville's PK fights
const EDGEVILLE_WILD = [3093, 3528]; // level 2 Wilderness, among them

// ---------------------------------------------------------------------------------------------------- the world session

const world = [
    {
        name: 'title-to-world',
        what: 'from the title into the world (the setup logged in twice, both checked), a teleport, the camera settling',
        async run(ctx) {
            await ctx.g.tele(0, ...LUMBRIDGE, 300);
            await hold(ctx, 8000);
        }
    },
    {
        name: 'upstream-identity',
        what: "full frames from fixed cameras at four places (no dynamic sprites, animated locs at frame 0, the colour table without its jitter), hashed: compared across builds (summary.mjs --identity), the patch's full render (and World.incrBypass) against main's",
        async run(ctx) {
            const places = [[3105, 3352], [3219, 3172], [3020, 3210], [2724, 3486]]; // Draynor Manor, Lumbridge swamp, Port Sarim, Seers'
            const out = [];
            for (const [x, z] of places) {
                await ctx.g.tele(0, x, z, 2500);
                const views = [];
                for (const yaw of [0, 512, 1024, 1536]) for (const pitch of [160, 340]) views.push({ x, z, yaw, pitch, maxLevel: 3 });
                const plain = await ctx.d.eval(`window.__rv.fixedFrames(${JSON.stringify(views)}, false)`);
                const bypass = await ctx.d.eval(`('incrBypass' in window.__lc.World) ? window.__rv.fixedFrames(${JSON.stringify(views)}, true) : null`);
                for (let i = 0; i < plain.length; i++) out.push({ ...plain[i], bypassHash: bypass?.[i]?.hash ?? null, bypassStable: bypass?.[i]?.stable ?? null });
            }
            ctx.log(`    ${out.length} views, ${out.filter(v => v.stable).length} stable${out.some(v => v.bypassHash !== null) ? `, bypass = plain in ${out.filter(v => v.bypassHash === v.hash).length}` : ''}`);
            return out;
        }
    },
    {
        name: 'lumbridge-npcs',
        what: 'the castle courtyard without bots: NPCs walking in and out of view and behind walls, the fountains (texture 17), a pointer sweeping the world (picking)',
        async run(ctx) {
            await ctx.g.tele(0, ...LUMBRIDGE);
            await sweep(ctx, true);
            await hold(ctx, 45000);
            await sweep(ctx, false);
            await hold(ctx, 15000);
        }
    },
    {
        name: 'camera-views',
        what: 'the camera turned and tilted to eight views of the courtyard (castle flags, fountains, doors), held still in each',
        async run(ctx) {
            await ctx.g.tele(0, ...LUMBRIDGE);
            for (let i = 0; i < 8; i++) {
                await turn(ctx, 90, i % 3 === 0 ? -25 : i % 3 === 1 ? 30 : 0);
                await hold(ctx, 6000);
            }
            await ctx.d.eval(`${C}.hudFaceNorth?.()`);
            await hold(ctx, 3000);
        }
    },
    {
        name: 'camera-nudges',
        what: 'the camera moved by a hair and stopped again, over and over (1-3 px drags and zoom steps, 40-400 ms apart): the switches between full, settling and partial frames',
        async run(ctx) {
            const { d, g } = ctx;
            await g.tele(0, ...LUMBRIDGE);
            const p = await g.worldPoint(406, 200);
            for (let i = 0; i < 30; i++) {
                const dx = (i % 3) + 1, wait = [40, 90, 160, 400][i % 4];
                if (i % 2 === 0) {
                    // a drag just past the touch slop (the turn counts the whole way: about 60-70 yaw units)
                    await d.down(p.x, p.y);
                    await d.move(p.x + 15, p.y);
                    await d.move(p.x + 15 + dx, p.y);
                    await d.up(p.x + 15 + dx, p.y);
                } else {
                    // one yaw unit, the smallest turn there is
                    await d.eval(`(() => { const c = ${C}; c.orbitCameraYaw = (c.orbitCameraYaw + ${i % 4 === 1 ? 1 : 2047}) & 2047; return true; })()`);
                }
                await sleep(wait);
                if (i % 5 === 4) await d.eval(`${C}.setCameraZoom(${[0.98, 1.02, 1][i % 3]})`);
            }
            await hold(ctx, 5000);
        }
    },
    {
        name: 'waterfall',
        what: "Baxtorian Falls: about 2,700 triangles of the animated fountain/river texture (17) a frame, the river's animated locs; held, then turned",
        async run(ctx) {
            await ctx.g.tele(0, 2512, 3468);
            await hold(ctx, 20000);
            await turn(ctx, 180, 20);
            await hold(ctx, 10000);
        }
    },
    {
        name: 'animated-locs',
        what: "Barbarian Village: about 80 animated locs in view (fires, the river's locs), NPCs; held, then turned",
        async run(ctx) {
            await ctx.g.tele(0, 3082, 3420);
            await hold(ctx, 20000);
            await turn(ctx, 220, 0);
            await hold(ctx, 10000);
        }
    },
    {
        name: 'windmill',
        what: "the windmill north of Lumbridge: its sails (an animated loc) and the farm's animals",
        async run(ctx) {
            await ctx.g.tele(0, ...WINDMILL);
            await sweep(ctx, true);
            await hold(ctx, 20000);
            await sweep(ctx, false);
            await turn(ctx, 160, -30);
            await hold(ctx, 10000);
        }
    },
    {
        name: 'fires',
        what: 'fires burning west of Lumbridge (animated locs), then a fire of our own lit with a tinderbox (a loc added, then animated, then gone)',
        async run(ctx) {
            await ctx.g.tele(0, ...FIRES);
            await hold(ctx, 15000);
            await ctx.g.tele(0, LUMBRIDGE[0] + 2, LUMBRIDGE[1] + 20);
            await openTab(ctx, 3);
            await tapSlot(ctx, 3, /^Use Tinderbox/);
            await tapSlot(ctx, 3, /^Use Tinderbox with Logs/);
            await closePanel(ctx);
            await sleep(4000);
            await settle(ctx);
            await hold(ctx, 30000);
        }
    },
    {
        name: 'doors',
        what: "the courtyard's doors opened and closed (a wall loc deleted and added), the camera still in between",
        async run(ctx) {
            await ctx.g.tele(0, LUMBRIDGE[0] + 1, LUMBRIDGE[1]);
            for (let i = 0; i < 2; i++) {
                if (await act(ctx, /^Open Door/)) {
                    await settle(ctx);
                    await hold(ctx, 6000);
                }
                if (await act(ctx, /^Close Door/)) {
                    await settle(ctx);
                    await hold(ctx, 6000);
                }
            }
        }
    },
    {
        name: 'ground-items',
        what: 'items dropped (tap-to-drop) and taken again: ground objects appearing and disappearing (setObj, delObj), a stack changing',
        async run(ctx) {
            await ctx.g.tele(0, LUMBRIDGE[0], LUMBRIDGE[1] + 3);
            await ctx.g.tapElement('#btn-drop');
            await openTab(ctx, 3);
            for (let i = 0; i < 3; i++) {
                await tapSlot(ctx, 3, /Shrimps/);
                await hold(ctx, 3000);
            }
            await tapSlot(ctx, 3, /Logs/);
            await hold(ctx, 3000);
            await ctx.g.tapElement('#btn-drop');
            await closePanel(ctx);
            // NPCs walking over the items and the player standing on them: unchanged ground objects redrawn where
            // something moving overlaps them
            await ctx.g.chat('::npcadd chicken', 300);
            await ctx.g.chat('::npcadd man', 300);
            await hold(ctx, 15000);
            for (let i = 0; i < 4; i++) {
                if (!(await actTile(ctx, 0, 0, /^Take (Shrimps|Logs)/))) break;
                await settle(ctx);
                await hold(ctx, 3000);
            }
        }
    },
    {
        name: 'woodcutting',
        what: 'chopping a tree west of the castle: the axe animation, the tree turning to a stump (a loc change), its regrowth',
        async run(ctx) {
            await ctx.g.tele(0, ...TREES);
            await act(ctx, /^Chop down Tree/);
            await settle(ctx);
            await hold(ctx, 40000);
        }
    },
    {
        name: 'fishing',
        what: "net fishing at Draynor: the fishing spots (NPCs) and the net animation, the sea",
        async run(ctx) {
            await ctx.g.tele(0, ...DRAYNOR_NET);
            await actNpc(ctx, /^Fishing spot$/, /^Net Fishing spot/);
            await settle(ctx);
            await hold(ctx, 40000);
        }
    },
    {
        name: 'mining',
        what: 'mining the rocks south-west of Varrock: the pickaxe animation, a rock turning to an empty rock and back',
        async run(ctx) {
            await ctx.g.tele(0, ...VARROCK_MINE);
            await act(ctx, /^Mine Rocks/);
            await settle(ctx);
            await hold(ctx, 30000);
            await act(ctx, /^Mine Rocks/);
            await settle(ctx);
            await hold(ctx, 15000);
        }
    },
    {
        name: 'combat',
        what: 'fighting cows: attack and block animations, hitsplats and health bars (overlays), deaths, drops on the ground',
        async run(ctx) {
            await ctx.g.tele(0, ...COWS);
            for (let i = 0; i < 2; i++) {
                if (!(await actNpc(ctx, /^Cow$/, /^Attack Cow/))) break;
                await sleep(2000);
                await hold(ctx, 15000);
            }
            for (let i = 0; i < 2; i++) {
                if (!(await act(ctx, /^Take /))) break;
                await settle(ctx);
                await hold(ctx, 3000);
            }
        }
    },
    {
        name: 'self-anims',
        what: 'the player animating in place: a teleport animation and spot animation, a hitsplat, armour and a weapon put on and taken off (the model changes)',
        async run(ctx) {
            await ctx.g.tele(0, LUMBRIDGE[0] - 2, LUMBRIDGE[1]);
            await ctx.g.chat('::~anim human_castteleport');
            await ctx.g.chat('::~spotanim teleport_casting');
            await hold(ctx, 4000);
            await ctx.g.chat('::~hit 1');
            await hold(ctx, 4000);
            await openTab(ctx, 3);
            // (each a new appearance: the player's model changes in place; the axe and pickaxe swap the weapon back and forth)
            for (const re of [/^Wield Rune scimitar/, /^Wear Rune full helm/, /^Wear Rune platebody/, /^Wield Rune axe/, /^Wield Rune pickaxe/, /^Wield Rune scimitar/]) {
                await tapSlot(ctx, 3, re);
                await hold(ctx, 2500);
            }
            await closePanel(ctx);
            await hold(ctx, 2000);
        }
    },
    {
        name: 'roofs-levels',
        what: "roofs hidden and shown (inside the castle's north wing and out), the staircase up a level, the castle's top floor (its flags), and down",
        async run(ctx) {
            const { g } = ctx;
            await g.tele(0, 3207, 3229); // inside: the roof hidden
            await hold(ctx, 8000);
            await g.tele(0, 3213, 3235); // outside the wing: the roofs drawn
            await hold(ctx, 6000);
            await g.tele(0, 3206, 3229);
            if (await act(ctx, /^Climb-up Staircase/)) {
                await ctx.d.waitFor(`${C}.minusedlevel === 1 && ${C}.sceneState === 2`, 15000);
                await settle(ctx);
                await hold(ctx, 8000);
            }
            await g.tele(2, 3206, 3227); // the top floor: the castle's flags
            await hold(ctx, 8000);
            await g.tele(0, 3207, 3229);
            await hold(ctx, 4000);
        }
    },
    {
        name: 'blends',
        what: 'translucent things moving over and behind others: ghosts (alpha NPCs) wandering by the fountain, spot animations on the player beside it',
        async run(ctx) {
            const { g } = ctx;
            await g.tele(0, 3221, 3213);
            for (let i = 0; i < 3; i++) await g.chat('::npcadd ghost', 400);
            await hold(ctx, 20000);
            for (let i = 0; i < 3; i++) {
                await g.chat('::~spotanim teleport_casting', 300);
                await hold(ctx, 3000);
            }
            await hold(ctx, 10000);
        }
    },
    {
        name: 'chat-overhead',
        what: 'overhead chat above the player, NPCs added beside it (::npcadd) walking off',
        async run(ctx) {
            await ctx.g.tele(0, LUMBRIDGE[0] - 3, LUMBRIDGE[1] + 2);
            for (const line of ['hello there', 'wave1:testing the chat', 'red:shake:render verify', 'flash1:scroll:a long line of overhead chat to see it all', 'glow2:wave2:one more']) {
                await ctx.g.chat(line, 300);
                await hold(ctx, 3000);
            }
            for (const n of ['man', 'woman', 'chicken', 'goblin']) {
                await ctx.g.chat(`::npcadd ${n}`, 300);
                await hold(ctx, 3000);
            }
            await hold(ctx, 8000);
        }
    },
    {
        name: 'menus-labels',
        what: "long-press menus (the host's and the drawn 2004 one), a tap that walks (the cross, tap markers), the action label after Talk-to",
        async run(ctx) {
            const { d, g } = ctx;
            await g.tele(0, LUMBRIDGE[0], LUMBRIDGE[1] - 2);
            for (const large of [true, false]) {
                if (!large) await g.setting('largeMenus', 'false', 'controls');
                const p = await g.worldPoint(406, 150);
                await d.down(p.x, p.y);
                await sleep(900);
                await d.up(p.x, p.y);
                await hold(ctx, 3000);
                await d.eval(`(() => { const c = ${C}; if (c.isMenuOpen) { c.isMenuOpen = false; } document.querySelector('#menu .menu-option:last-child')?.click(); return true; })()`);
                await hold(ctx, 2000);
                if (!large) await g.setting('largeMenus', 'true', 'controls');
            }
            const walk = await findOption(ctx, /^Walk here/);
            if (walk) {
                await tapWorld(ctx, walk.vx, walk.vy);
                await settle(ctx);
                await hold(ctx, 3000);
            }
            await g.chat('::npcadd man', 1500);
            if (await actNpc(ctx, /^Man$/, /^(Talk-to|Attack) Man/)) {
                await sleep(3000);
                await hold(ctx, 4000);
                for (let i = 0; i < 3; i++) {
                    await d.eval(`(() => { const c = ${C}; c.hudCancelInput?.(); c.hudContinue?.(); return true; })()`);
                    await sleep(500);
                }
                await d.eval(`(() => { try { ${C}.closeModal(); } catch {} return true; })()`);
            }
            await hold(ctx, 3000);
        }
    },
    {
        name: 'hud-panels',
        what: 'every side tab panel, the chatbox, Settings and the World map opened over the world and closed, the camera still',
        async run(ctx) {
            const { g } = ctx;
            await g.tele(0, ...LUMBRIDGE);
            for (const tab of [0, 1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 13]) {
                await openTab(ctx, tab).catch(() => {});
                await hold(ctx, 1500);
            }
            await closePanel(ctx);
            await g.tapElement('#btn-chat-toggle').catch(() => {});
            await hold(ctx, 2000);
            await g.tapElement('#btn-chat-toggle').catch(() => {});
            await g.tapElement('#btn-settings');
            await hold(ctx, 2500);
            await g.tapElement('#settings-close');
            await g.tapElement('#btn-worldmap').catch(() => {});
            await hold(ctx, 4000);
            await g.tapElement('#worldmap-close').catch(() => {});
            await hold(ctx, 3000);
        }
    },
    {
        name: 'zoom',
        what: "the minimap's zoom slider dragged round the ring, a pinch on the world (the camera's distance), held at each zoom",
        async run(ctx) {
            const { d, g } = ctx;
            await g.tele(0, ...LUMBRIDGE);
            const ring = await g.rect('#hud-map');
            const knob = await g.rect('#map-zoom');
            if (ring?.visible && knob?.visible) {
                const groove = ring.w / 2 - 2;
                const at = a => [ring.cx + groove * Math.cos((a * Math.PI) / 180), ring.cy + groove * Math.sin((a * Math.PI) / 180)];
                await d.drag(knob.cx, knob.cy, ...at(200));
                await hold(ctx, 3000);
                const k1 = await g.rect('#map-zoom');
                await d.drag(k1.cx, k1.cy, knob.cx, knob.cy);
                await hold(ctx, 2000);
            }
            const c0 = await g.worldPoint(330, 170);
            await d.pinch(c0.x, c0.y, 60, 220);
            await hold(ctx, 6000);
            await d.pinch(c0.x, c0.y, 220, 40);
            await hold(ctx, 6000);
            for (const z of [1.37, 0.73, 1]) {
                await d.eval(`${C}.setCameraZoom(${z})`);
                await hold(ctx, 4000);
            }
        }
    },
    {
        name: 'classic-layout',
        what: 'Settings › Layout › Classic (the 512x334 viewport of 2004) and back, with the pointer sweeping it',
        async run(ctx) {
            const { g } = ctx;
            await g.tele(0, ...LUMBRIDGE);
            await g.setting('layout', 'classic', 'display');
            await sweep(ctx, true);
            await hold(ctx, 15000);
            await sweep(ctx, false);
            await g.setting('layout', 'mobile', 'display');
            await hold(ctx, 6000);
        }
    },
    {
        name: 'resize',
        what: "other screen sizes (an iPhone SE's 667x375, a Max's 932x430) and back: the viewport and its buffers resized",
        async run(ctx) {
            const { d, g } = ctx;
            await g.tele(0, ...LUMBRIDGE);
            for (const [w, h] of [[667, 375], [932, 430], [812, 375]]) {
                await d.resize(w, h);
                await hold(ctx, 6000);
            }
        }
    },
    {
        name: 'fps30',
        what: 'Settings › Frame rate 30: two client cycles a frame, so everything moves further between frames',
        async run(ctx) {
            const { g } = ctx;
            await g.tele(0, ...LUMBRIDGE);
            await g.setting('fps', '30', 'display');
            await sweep(ctx, true);
            await hold(ctx, 25000);
            await sweep(ctx, false);
            await g.setting('fps', '50', 'display');
            await hold(ctx, 3000);
        }
    },
    {
        name: 'brightness',
        what: "the Options tab's brightness (a new colour table, the textures' palettes) at each level",
        async run(ctx) {
            const { g } = ctx;
            await g.tele(0, ...LUMBRIDGE);
            for (const b of [1, 3, 4, 2]) {
                await g.chat(`::setvar option_brightness ${b}`, 300);
                await hold(ctx, 3000);
            }
        }
    },
    {
        name: 'pause-resume',
        what: "the app sent to the background and back (the host's lifecycle pause/resume: the client's timers frozen, the world paused), a visibilitychange (PixMap.invalidate)",
        async run(ctx) {
            const { g, d } = ctx;
            await g.tele(0, ...LUMBRIDGE);
            await hold(ctx, 3000);
            for (let i = 0; i < 2; i++) {
                await d.eval(`window.LostCityHost.lifecycle('pause').then(() => true)`);
                await sleep(3000);
                await d.eval(`window.LostCityHost.lifecycle('resume').then(() => true)`);
                await hold(ctx, 6000);
            }
            await d.eval(`(document.dispatchEvent(new Event('visibilitychange')), true)`);
            await hold(ctx, 5000);
        }
    },
    {
        name: 'relog',
        what: 'log out to the title and in again: the world rebuilt, the first frames after the login',
        async run(ctx) {
            const { g, d } = ctx;
            const name = await d.eval(`${C}.loginUser`);
            await g.logout();
            await sleep(3000);
            const r = await g.login(name);
            if (!r.ok) throw new Error(`login after logout failed: ${JSON.stringify(r.why)}`);
            await hold(ctx, 12000);
        }
    },
    {
        name: 'long-idle',
        what: 'twelve minutes untouched in the courtyard (NPCs, fountains, the camera never moved by hand)',
        async run(ctx) {
            await ctx.g.tele(0, ...LUMBRIDGE);
            await hold(ctx, 12 * 60000);
        }
    }
];

// ---------------------------------------------------------------------------------------------------- the bots session

const bots = [
    {
        name: 'bots-title-to-world',
        what: 'the login into a world with 500 bots, a teleport into the crowd',
        async run(ctx) {
            await ctx.g.tele(0, ...VARROCK_WEST, 300);
            await hold(ctx, 8000);
        }
    },
    {
        name: 'varrock-west-500',
        what: "Varrock West bank with 500 bots: the crowd walking in and out of view and behind the bank's walls, chat, trades, drops; a pointer sweeping it half the time",
        async run(ctx) {
            await ctx.g.tele(0, ...VARROCK_WEST);
            await sweep(ctx, true);
            await hold(ctx, 120000);
            await sweep(ctx, false);
            await turn(ctx, 200, -20);
            await hold(ctx, 120000);
        }
    },
    {
        name: 'edgeville-pk',
        what: "Edgeville's PK fights from south of the ditch: hitsplats, projectiles, spot animations, teleports, deaths and their drops",
        async run(ctx) {
            await ctx.g.tele(0, ...EDGEVILLE_DITCH);
            await ctx.d.eval(`${C}.hudFaceNorth?.()`);
            await sweep(ctx, true);
            await hold(ctx, 150000);
            await sweep(ctx, false);
            await hold(ctx, 90000);
        }
    },
    {
        name: 'edgeville-wild',
        what: 'in the Wilderness among the PKers (they may fight the player: hitsplats on it too)',
        async run(ctx) {
            await ctx.g.tele(0, ...EDGEVILLE_WILD);
            await hold(ctx, 120000);
            await ctx.g.tele(0, ...EDGEVILLE_DITCH, 1000); // (out again)
        }
    },
    {
        name: 'bots-relog',
        what: 'log out and in again with 500 bots',
        async run(ctx) {
            const { g, d } = ctx;
            const name = await d.eval(`${C}.loginUser`);
            await g.logout();
            await sleep(3000);
            const r = await g.login(name);
            if (!r.ok) throw new Error(`login after logout failed: ${JSON.stringify(r.why)}`);
            await g.tele(0, ...VARROCK_WEST);
            await hold(ctx, 15000);
        }
    },
    {
        name: 'bots-long-idle',
        what: 'twelve minutes untouched at Varrock West with 500 bots',
        async run(ctx) {
            await ctx.g.tele(0, ...VARROCK_WEST);
            await hold(ctx, 12 * 60000);
        }
    }
];

// Settings › World › Detail: Low (the client's lowMem: other ground, 64 px textures, fewer animated textures and locs),
// a restart setting: a session of its own with the world scenarios most likely to differ
const LOW_DETAIL = ['title-to-world', 'lumbridge-npcs', 'camera-views', 'camera-nudges', 'waterfall', 'animated-locs', 'fires', 'doors', 'woodcutting', 'combat', 'blends', 'menus-labels', 'zoom', 'classic-layout', 'relog'];

export const SESSIONS = {
    world: { bots: 0, settings: {}, setup: makeCharacter, scenarios: world },
    bots: { bots: 500, settings: {}, setup: makeCharacter, scenarios: bots },
    lowdetail: { bots: 0, settings: { lowMemory: true }, setup: makeCharacter, scenarios: world.filter(s => LOW_DETAIL.includes(s.name)) }
};

export const helpers = { makeCharacter, hover, findOption, tapWorld, act, actNpc, actTile, hold, sweep, settle, slotWith, tapSlot, openTab, closePanel, turn };
