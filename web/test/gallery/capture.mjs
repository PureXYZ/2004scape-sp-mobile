#!/usr/bin/env node
// Captures the gallery's fixtures from the real game: logs a new character in (headless Chrome, the mobile layout),
// skips the tutorial, fills the inventory and dumps what the client draws into its surfaces — the world, the
// minimap, every side panel tab, the bank, the chatbox in its states — plus hudState() and chat lines. gallery.mjs
// then renders the HUD around these pixels with a stub client, in every state and at every phone size, in seconds.
//
//   node web/test/gallery/capture.mjs [--port 47560] [--game <dir>]      (build first: node scripts/build-web.mjs)
//   → build/tmp/gallery/fixtures/*.png + fixtures.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '../serve.mjs';
import { launch, sleep } from './cdp.mjs';

const IOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const argv = process.argv.slice(2);
const GAME = argv.includes('--game') ? path.resolve(argv[argv.indexOf('--game') + 1]) : path.join(IOS, 'build', 'Game');
const portIndex = argv.indexOf('--port');
const PORT = portIndex >= 0 ? Number(argv[portIndex + 1]) : 47560;
const OUT = path.join(IOS, 'build', 'tmp', 'gallery');
const FIXTURES = path.join(OUT, 'fixtures');
const USER = `gal${Date.now() % 100000}`;
const VIEW = { width: 932, height: 430 }; // the largest phone: the world capture is scaled down for the others

fs.rmSync(FIXTURES, { recursive: true, force: true });
fs.mkdirSync(FIXTURES, { recursive: true });
const server = await serve({ port: PORT, root: GAME, saves: path.join(OUT, 'capture-saves'), log: false });
// (Jmod On: the tutorial is skipped and the items given with :: commands, which a normal player's are not since Jmod
// became a setting, Off by default; no bots, which would walk into the shots)
const page = await launch({
    port: PORT + 1,
    profileDir: path.join(OUT, 'capture-profile'),
    view: VIEW,
    scale: 1,
    initScripts: ['window.__lcSafeAreaOverride = { top: 0, right: 0, bottom: 0, left: 0 };', `try { localStorage.setItem('lostcity.settings', JSON.stringify({ jmod: true, bots: 0, seenHowToPlay: true })); } catch {}`]
});
const C = 'window.__client';
const fixtures = { user: USER, view: VIEW, states: {} };

async function dump(name, selector) {
    const data = await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).toDataURL('image/png')`);
    fs.writeFileSync(path.join(FIXTURES, `${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
    console.log(`  ${name}.png`);
}

async function typeChat(text) {
    await page.evaluate(`window.LostCityHost.keyboard.insertText(${JSON.stringify(`${text}\n`)})`);
    await sleep(700);
}

async function login(newUser) {
    const rect = await page.rect('#canvas');
    const game = (gx, gy) => ({ x: rect.x + (gx * rect.w) / 765, y: rect.y + (gy * rect.h) / 503 });
    let p = game(newUser ? 302 : 462, 291);
    await page.tap(p.x, p.y);
    await sleep(400);
    p = game(360, 258);
    await page.tap(p.x, p.y);
    await sleep(300);
    await page.evaluate(`window.LostCityHost.keyboard.insertText(${JSON.stringify(USER)})`);
    await page.evaluate('window.LostCityHost.keyboard.submit()');
    await sleep(300);
    await page.evaluate(`window.LostCityHost.keyboard.insertText('hunter2')`);
    await page.evaluate('window.LostCityHost.keyboard.submit()');
    return page.waitFor(`${C}?.ingame === true && !!${C}?.localPlayer && ${C}.sceneState === 2`, 30000);
}

async function dismissTutorialMessage() {
    for (let i = 0; i < 3 && (await page.evaluate(`!!${C}.tutComMessage`)); i++) {
        await page.evaluate(`${C}.tapAt(${C}.viewportX + 400, ${C}.viewportY + 60, 1)`);
        await sleep(400);
    }
}

async function tab(index) {
    const centre = { 0: [556, 187], 1: [584, 186], 2: [612, 186], 3: [647, 185], 4: [681, 186], 5: [709, 186], 6: [739, 187], 8: [587, 484], 9: [614, 484], 10: [649, 484], 11: [684, 484], 12: [711, 484], 13: [741, 484] }[index];
    await page.evaluate(`${C}.tapAt(${centre[0]}, ${centre[1]}, 1)`);
    await sleep(500);
}

let exitCode = 1;
try {
    await page.navigate(server.url);
    const title = await page.waitFor(`${C}?.lastProgressPercent === 100 && !!${C}?.titleFlames && window.LostCityHost?.engineState === 'ready'`, 90000);
    if (!title.ok) {
        throw new Error('title screen not reached');
    }
    await sleep(800);
    await dump('title', '#canvas');

    if (!(await login(true)).ok) {
        throw new Error('login failed');
    }
    await sleep(2500);
    // the character designer: Accept (classic 260, 286 within the modal)
    const modal = await page.evaluate(`[${C}.modalX, ${C}.modalY]`);
    await page.evaluate(`${C}.tapAt(${C}.viewportX + ${modal[0] + 256}, ${C}.viewportY + ${modal[1] + 282}, 1)`);
    await sleep(1200);
    await dump('chat-tutorial', '#surface-chat');
    fixtures.states.tutorial = await page.evaluate(`${C}.hudState()`);

    await dismissTutorialMessage();
    await typeChat('::setvar tutorial 1000');
    await dismissTutorialMessage();
    await tab(10);
    await page.evaluate(`${C}.tapAt(553 + 94, 205 + 170, 1)`); // "Click here to logout"
    await page.waitFor(`${C}.ingame === false && !${C}.reconnecting`, 10000);
    await sleep(1500);
    let again = { ok: false };
    for (let i = 0; i < 6 && !again.ok; i++) {
        if (i > 0) {
            await sleep(2000);
            await page.evaluate(`${C}.loginscreen = 0`);
            await sleep(300);
        }
        again = await login(false);
    }
    if (!again.ok) {
        throw new Error('relogin failed');
    }
    await sleep(2000);

    await typeChat('::tele 0,50,50,22,18'); // Lumbridge
    await page.waitFor(`${C}.sceneState === 2`, 15000);
    await sleep(2500);
    for (const item of ['bronze_axe', 'tinderbox', 'net', 'bronze_pickaxe', 'bronze_dagger', 'wooden_shield', 'shrimp 3', 'bread 2', 'logs 4', 'airrune 30', 'mindrune 30', 'coins 125']) {
        await typeChat(`::give ${item}`);
    }
    for (const line of ['Hello Lumbridge!', 'Anyone selling shrimp?']) {
        await typeChat(line);
    }
    await sleep(1500);
    await page.evaluate(`(() => { const c = ${C}; c.orbitCameraYaw = 1800; c.orbitCameraPitch = 300; })()`);
    await sleep(1500);

    await dump('world', '#surface-game');
    await dump('map', '#surface-map');
    await dump('chat-history', '#surface-chat');
    fixtures.states.world = await page.evaluate(`${C}.hudState()`);
    fixtures.chatLines = await page.evaluate(`${C}.hudChatLines(5)`);

    for (const index of [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]) {
        await tab(index);
        await dump(`side-${index}`, '#surface-side');
    }
    await tab(3);

    // an NPC dialogue page and an amount prompt in the chatbox (opened client-side, like hud.mjs)
    await page.evaluate(`(() => { const c = ${C}; c.chatModalId = 4882; c.redrawChat = true; })()`);
    await sleep(600);
    await dump('chat-dialogue', '#surface-chat');
    await page.evaluate(`(() => { const c = ${C}; c.chatModalId = -1; c.dialogInputOpen = true; c.dialogInput = '25'; c.redrawChat = true; })()`);
    await sleep(600);
    await dump('chat-amount', '#surface-chat');
    await page.evaluate(`(() => { const c = ${C}; c.dialogInputOpen = false; c.dialogInput = ''; c.redrawChat = true; })()`);
    await sleep(400);

    await typeChat('::~bank');
    await page.waitFor(`${C}.mainModalId !== -1 && ${C}.sideModalId !== -1`, 8000);
    await sleep(1200);
    await dump('world-bank', '#surface-game');
    await dump('side-bank', '#surface-side');
    fixtures.states.bank = await page.evaluate(`${C}.hudState()`);
    fixtures.bankModal = await page.evaluate(`[${C}.modalX, ${C}.modalY, ${C}.viewportWidth, ${C}.viewportHeight]`);

    fs.writeFileSync(path.join(FIXTURES, 'fixtures.json'), JSON.stringify(fixtures, null, 2));
    console.log(`fixtures in ${path.relative(process.cwd(), FIXTURES)}`);
    exitCode = 0;
} catch (err) {
    console.error(err);
    await page.screenshot(path.join(OUT, 'capture-error.png')).catch(() => {});
} finally {
    fs.writeFileSync(path.join(OUT, 'capture-console.log'), page.consoleLines.join('\n'));
    await page.close();
    await server.close();
    process.exit(exitCode);
}
