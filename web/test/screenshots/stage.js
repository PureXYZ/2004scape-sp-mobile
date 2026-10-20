// Stages the README's screenshots in the real app: injected into a test copy of the web bundle by
// web/test/screenshots/run.mjs (never part of a normal build). It logs a new character in, skips the tutorial with
// developer commands, and asks the driver for screenshots at Lumbridge (the world), with the inventory open (a panel),
// at Varrock West bank, where the vendor bots gather (the bots), and beside a fight at the Edgeville ditch (pk).
// window.LCSHOTS_ONLY = 'pk' (run.mjs --only pk) takes only the last. Lines for the driver, through the native console
// bridge:
//   LCSHOTS INFO <text>
//   LCSHOTS SHOT <name>      the driver takes a screenshot (the page waits a moment for it)
//   LCSHOTS DONE ok|error    the driver stops the app
(() => {
    'use strict';

    const USER = 'Adventurer';
    const RESTART_KEY = 'lcshots.restarted';
    const native = (window.webkit?.messageHandlers ?? window.LostCityNativeBridge)?.native ?? null;
    const out = text => console.log(`LCSHOTS ${text}`);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const c = () => window.__client;
    // (the settings the shots need: Jmod for the :: commands, the default 500 bots, no help card over the world)
    const WANTED = { jmod: true, bots: 500, seenHowToPlay: true, layout: 'mobile' };

    async function waitFor(fn, timeoutMs, intervalMs = 200) {
        const started = performance.now();
        while (performance.now() - started < timeoutMs) {
            try {
                const value = fn();
                if (value) {
                    return true;
                }
            } catch {
                // the client is not there yet
            }
            await sleep(intervalMs);
        }
        return false;
    }

    async function shot(name) {
        out(`SHOT ${name}`);
        await sleep(2500);
    }

    function clickGame(x, y, button = 1) {
        const client = c();
        if (client.ingame && typeof client.tapAt === 'function') {
            client.tapAt(x, y, button);
            return;
        }
        client.nextMouseClickX = x;
        client.nextMouseClickY = y;
        client.nextMouseClickTime = performance.now();
        client.nextMouseClickButton = button;
    }

    function tapElement(element) {
        const rect = element.getBoundingClientRect();
        const init = { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true, button: 0, buttons: 1 };
        element.dispatchEvent(new PointerEvent('pointerdown', init));
        element.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    }

    async function typeChat(text) {
        window.LostCityHost.keyboard.insertText(`${text}\n`);
        await sleep(900);
    }

    async function dismissTutorialMessage() {
        for (let i = 0; i < 3 && c().tutComMessage; i++) {
            clickGame(c().viewportX + 400, c().viewportY + 60);
            await sleep(400);
        }
    }

    function playersInView() {
        const client = c();
        let n = 0;
        for (let i = 0; i < (client?.playerCount ?? 0); i++) {
            if (client.players?.[client.playerIds?.[i]]?.ready) {
                n++;
            }
        }
        return n;
    }

    async function login() {
        for (let attempt = 0; attempt < 6; attempt++) {
            if (attempt > 0) {
                await sleep(2000);
                c().loginscreen = 0;
                await sleep(300);
            }
            clickGame(462, 291); // "Existing User" (a new name makes a new character)
            await waitFor(() => c().loginscreen === 2, 5000);
            await sleep(800);
            window.LostCityHost.keyboard.insertText(USER);
            await sleep(300);
            window.LostCityHost.keyboard.submit();
            await sleep(1500);
            if (!c().ingame && c().loginSelect === 1) {
                window.LostCityHost.keyboard.submit(); // (the password field: offline any password does)
            }
            if (await waitFor(() => c().ingame === true && !!c().localPlayer && c().sceneState === 2, 30000)) {
                return true;
            }
            out(`INFO login attempt ${attempt + 1}: '${c().loginMes1} ${c().loginMes2}'`);
        }
        return false;
    }

    function playersFighting() {
        const client = c();
        const now = client.constructor.loopCycle;
        const fighting = [];
        for (let i = 0; i < (client?.playerCount ?? 0); i++) {
            const player = client.players?.[client.playerIds?.[i]];
            if (player?.ready && player.combatCycle > now) {
                fighting.push({ x: (player.x >> 7) + client.mapBuildBaseX, z: (player.z >> 7) + client.mapBuildBaseZ });
            }
        }
        return fighting;
    }

    async function teleTo(x, z) {
        await teleport(`::tele 0,${x >> 6},${z >> 6},${x & 63},${z & 63}`);
    }

    async function teleport(command) {
        await typeChat(command);
        await waitFor(() => c().sceneState === 2, 15000);
        await sleep(3000);
    }

    async function run() {
        const ready = await waitFor(() => c()?.lastProgressPercent === 100 && c()?.titleFlames && window.LostCityHost?.engineState === 'ready', 180000);
        if (!ready) {
            throw new Error('the title screen and the world did not come up');
        }
        // the settings first (they apply at boot): store them natively and restart once
        const settings = window.LostCityHost.settings;
        let restarted = false;
        try {
            restarted = sessionStorage.getItem(RESTART_KEY) !== null;
        } catch {
            // no sessionStorage: go on with what there is
            restarted = true;
        }
        const differs = Object.entries(WANTED).some(([key, value]) => key in settings && settings[key] !== value);
        if (differs && !restarted) {
            out(`INFO settings ${JSON.stringify(Object.fromEntries(Object.keys(WANTED).map(k => [k, settings[k]])))}: restarting with ${JSON.stringify(WANTED)}`);
            sessionStorage.setItem(RESTART_KEY, '1');
            const values = { ...settings, ...Object.fromEntries(Object.entries(WANTED).filter(([key]) => key in settings)) };
            if (native) {
                native.postMessage({ type: 'settings', values });
            }
            try {
                localStorage.setItem('lostcity.settings', JSON.stringify(values));
            } catch {
                // native keeps them
            }
            await sleep(1500);
            location.reload();
            return;
        }
        out(`INFO settings ${JSON.stringify(Object.fromEntries(Object.keys(WANTED).map(k => [k, settings[k]])))}, bot chat ${settings.botChat}`);
        await sleep(1500);

        if (!(await login())) {
            throw new Error('login failed');
        }
        await sleep(2500);
        // the character designer: Accept
        clickGame(c().viewportX + c().modalX + 256, c().viewportY + c().modalY + 282);
        await sleep(1500);
        await dismissTutorialMessage();
        await typeChat('::setvar tutorial 1000');
        await dismissTutorialMessage();
        // log out and in again, so the finished tutorial takes effect (every tab, the mainland)
        clickGame(649, 484); // the Logout tab
        await sleep(600);
        clickGame(553 + 94, 205 + 170); // "Click here to logout"
        await waitFor(() => c().ingame === false && !c().reconnecting, 10000);
        await sleep(2000);
        if (!(await login())) {
            throw new Error('the second login failed');
        }
        await sleep(2500);

        if (window.LCSHOTS_ONLY !== 'pk') {
            // Lumbridge, with a few things in the pack
            await teleport('::tele 0,50,50,22,18');
            for (const item of ['bronze_axe', 'tinderbox', 'net', 'bronze_pickaxe', 'bronze_dagger', 'wooden_shield', 'shrimp 3', 'bread 2', 'logs 4', 'airrune 30', 'mindrune 30', 'coins 125']) {
                await typeChat(`::give ${item}`);
            }
            await sleep(20000); // the bots around Lumbridge
            c().orbitCameraYaw = 1800;
            c().orbitCameraPitch = 320;
            await sleep(3000);
            out(`INFO lumbridge: ${playersInView()} players in view`);
            await shot('world-1');
            c().orbitCameraYaw = 400;
            await sleep(2500);
            await shot('world-2');

            // a panel: the inventory, then the stats
            for (const [tab, name] of [['3', 'panel-inventory'], ['1', 'panel-stats']]) {
                const button = document.querySelector(`#hud-tabs .tab[data-tab="${tab}"]`);
                if (button) {
                    tapElement(button);
                    await sleep(1500);
                    await shot(name);
                    tapElement(button);
                    await sleep(800);
                }
            }

            // Varrock West bank: the vendors and the crowd (a fresh world takes a couple of minutes to fill). Inside the
            // bank (no roof over it), looking north at the booths, then outside its door looking at the street.
            await teleport('::tele 0,49,53,49,45');
            for (let i = 1; i <= 8; i++) {
                await sleep(i === 1 ? 45000 : 20000);
                c().orbitCameraYaw = [0, 0, 256, 1792, 0, 512, 1536, 1024][i - 1];
                c().orbitCameraPitch = i % 2 ? 300 : 360;
                await sleep(1500);
                out(`INFO varrock west: ${playersInView()} players in view`);
                await shot(`bots-${i}`);
            }
            await teleport('::tele 0,49,53,49,39');
            for (let i = 9; i <= 11; i++) {
                c().orbitCameraYaw = [0, 1024, 512][i - 9];
                c().orbitCameraPitch = 380;
                await sleep(2000);
                out(`INFO varrock west outside: ${playersInView()} players in view`);
                await shot(`bots-${i}`);
            }
        }

        // Edgeville: the PKers north of the ditch. Wait at the ditch for a fight in view, step beside the busiest one
        // (south-west of it, so the camera's own character does not hide it) and shoot it from close in and fairly low,
        // then from its north-east side looking back at the ditch.
        await teleTo(3094, 3524);
        await sleep(30000);
        for (let n = 1, waits = 0; n <= 8 && waits < 5; ) {
            if (!(await waitFor(() => playersFighting().length >= 2, 120000, 1000))) {
                waits++;
                out('INFO edgeville: no fight in view for 2 min');
                await teleTo(3094, 3524);
                continue;
            }
            const fighting = playersFighting();
            const near = p => fighting.filter(q => Math.abs(q.x - p.x) <= 3 && Math.abs(q.z - p.z) <= 3);
            const busiest = near(fighting.reduce((best, p) => (near(p).length > near(best).length ? p : best)));
            const x = Math.round(busiest.reduce((sum, p) => sum + p.x, 0) / busiest.length);
            const z = Math.round(busiest.reduce((sum, p) => sum + p.z, 0) / busiest.length);
            for (const [dx, dz, yaw] of [[-2, -1, 0], [2, 1, 1024]]) {
                await teleTo(x + dx, z + dz);
                c().orbitCameraYaw = yaw;
                c().orbitCameraPitch = 270;
                c().setCameraZoom?.(0.8);
                await sleep(1500);
                out(`INFO edgeville fight at ${x},${z} (${busiest.length} there): ${playersFighting().length} fighting, ${playersInView()} players in view`);
                await shot(`pk-${n++}`);
            }
            await sleep(8000);
        }
        out('DONE ok');
    }

    function start() {
        run().catch(error => {
            out(`INFO error ${String(error?.stack ?? error)}`);
            out('DONE error');
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
