// Gallery stand-in for client/client.js: a Client with the HUD API of patch 0011+ that draws captured pixels
// (build/tmp/gallery/fixtures, from capture.mjs) into the surfaces instead of running the game. The gallery drives it
// through window.__stub (state patches) and through real touches on the HUD.
const TAB_CENTRE = { 0: [556, 187], 1: [584, 186], 2: [612, 186], 3: [647, 185], 4: [681, 186], 5: [709, 186], 6: [739, 187], 8: [587, 484], 9: [614, 484], 10: [649, 484], 11: [684, 484], 12: [711, 484], 13: [741, 484] };
const CHAT_MODE_CENTRE = [[56, 483], [185, 483], [323, 483], [462, 483]];

const images = {};
function image(name) {
    if (!images[name]) {
        const img = new Image();
        img.src = `/fixtures/${name}.png`;
        images[name] = img;
    }
    return images[name];
}

const fixtures = await (await fetch('/fixtures/fixtures.json')).json();

export class Client {
    constructor() {
        const base = fixtures.states.world;
        this.ingame = true;
        this.reconnecting = false;
        this.loginscreen = 0;
        this.loginSelect = 0;
        this.loginUser = '';
        this.loginPass = '';
        this.titleFlames = true;
        this.lastProgressPercent = 100;
        this.keyHeld = new Array(128).fill(0);
        this.timeoutTimer = 0;
        this.idleTimer = 0;
        this.noTimeoutTimer = 0;
        this.tfps = 50;
        this.mainModalId = -1;
        this.sideModalId = -1;
        this.reportAbuseComId = -1;
        this.socialInputOpen = false;
        this.dialogInputOpen = false;
        this.chatModalId = -1;
        this.chatInput = '';
        this.errorLoading = false;
        this.errorHost = false;
        this.errorStarted = false;
        this.surfaceLayout = null;
        this.insets = null;
        this.calls = []; // tapAt / hudSetRun / menu calls, for the gallery's checks
        this.state = {
            ...base,
            tabs: base.tabs.slice(),
            chatModes: base.chatModes.slice(),
            world: 'world',
            chat: 'chat-history',
            side: null, // fixture override for the side panel (e.g. 'side-bank')
            hp: 10,
            hpMax: 10,
            prayer: 1,
            prayerMax: 1,
            cameraYaw: 0,
            menu: null // { area, options[] } while a menu is open
        };
        this.chatLines = fixtures.chatLines;
        window.__stub = this;
        for (const name of ['world', 'world-bank', 'map', 'chat-history', 'chat-tutorial', 'chat-dialogue', 'chat-amount', 'side-bank', ...Object.keys(TAB_CENTRE).map(i => `side-${i}`)]) {
            image(name).addEventListener('load', () => this.draw());
        }
        queueMicrotask(() => globalThis.lcHost?.onClientEvent?.('ingame', true));
    }

    // ---- the gallery's controls
    set(patch) {
        if ('title' in patch) {
            // the title screen's welcome box (or the login form): the classic canvas shows the captured title
            this.ingame = !patch.title;
            this.loginscreen = patch.loginscreen ?? 0;
            const img = image('title');
            const draw = () => document.getElementById('canvas').getContext('2d').drawImage(img, 0, 0, 765, 503);
            img.complete ? draw() : img.addEventListener('load', draw, { once: true });
            globalThis.lcHost?.onClientEvent?.('ingame', this.ingame);
        }
        Object.assign(this.state, patch);
        if ('mainModal' in patch) {
            this.mainModalId = patch.mainModal ? 1 : -1;
        }
        if ('sideModal' in patch) {
            this.sideModalId = patch.sideModal ? 2 : -1;
        }
        if ('chatModal' in patch) {
            this.chatModalId = patch.chatModal ? 1 : -1;
        }
        if ('chatInput' in patch) {
            this.dialogInputOpen = !!patch.chatInput;
        }
        this.draw();
    }

    // a menu as a long-press at (x, y) CSS px opens it: the finger is put down there first (menu.js anchors on it)
    async openMenu(area, options, at = null) {
        this.menuSerial = (this.menuSerial ?? 0) + 1;
        this.state.menu = { serial: this.menuSerial, area, options };
        this.state.menuOpen = true;
        this.state.menuArea = area;
        globalThis.lcHost?.onClientEvent?.('menu-open', { serial: this.menuSerial, area, x: 0, y: 0, width: 0, height: 0, options });
    }

    hudMenu() {
        return this.state.menu;
    }

    // ---- surfaces
    draw() {
        const layout = this.surfaceLayout;
        if (!layout) {
            return;
        }
        const s = this.state;
        const paint = (canvas, name, cover) => {
            const img = image(name);
            if (!img.complete || !img.naturalWidth) {
                return;
            }
            const ctx = canvas.getContext('2d');
            if (cover) {
                const k = Math.max(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
                const w = img.naturalWidth * k;
                const h = img.naturalHeight * k;
                ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
            } else {
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            }
        };
        paint(layout.game, s.mainModal && s.sideModal ? 'world-bank' : s.world, true);
        paint(layout.map, 'map', false);
        paint(layout.side, s.side ?? (s.sideModal ? 'side-bank' : `side-${s.activeTab}`), false);
        paint(layout.chat, s.chatInput ? 'chat-amount' : s.tutorialMessage || s.chatModal ? 'chat-dialogue' : s.tutorialChat ? 'chat-tutorial' : s.chat, false);
    }

    setSurfaceLayout(layout) {
        this.surfaceLayout = layout;
        if (layout) {
            const size = (el, w, h) => {
                el.width = w;
                el.height = h;
            };
            size(layout.game, Math.max(512, layout.width | 0), Math.max(334, layout.height | 0));
            size(layout.map, 172, 156);
            size(layout.side, 190, 261);
            size(layout.chat, 479, 96);
            this.viewportWidth = layout.game.width;
            this.viewportHeight = layout.game.height;
        }
        this.setViewportInsets(layout?.insets ?? null);
        this.draw();
    }

    setViewportInsets(insets) {
        this.insets = insets;
    }

    hudState() {
        const s = this.state;
        return {
            ingame: this.ingame,
            activeTab: s.activeTab,
            tabs: s.tabs.slice(),
            flashingTab: s.flashingTab,
            sideModal: !!s.sideModal,
            mainModal: !!s.mainModal,
            chatModal: !!s.chatModal || !!s.tutorialMessage, // (a tutorial game message counts, as in the client)
            tutorialChat: !!s.tutorialChat,
            tutorialMessage: !!s.tutorialMessage,
            chatInput: !!s.chatInput,
            chatTyping: !!s.chatTyping,
            chatModes: s.chatModes.slice(),
            runEnergy: s.runEnergy,
            running: !!s.running,
            runExists: s.runExists !== false,
            runAvailable: s.runExists !== false && !s.mainModal && !s.sideModal && !s.chatModal,
            reconnecting: false,
            menuOpen: !!s.menuOpen,
            menuArea: s.menuArea ?? 0,
            hp: s.hp,
            hpMax: s.hpMax,
            prayer: s.prayer,
            prayerMax: s.prayerMax,
            cameraYaw: s.cameraYaw,
            cameraZoom: s.cameraZoom ?? 1,
            tapToDrop: !!s.tapToDrop
        };
    }

    // the world map's player: Lumbridge castle's courtyard, where the captured world is
    hudPlayerTile() {
        return this.ingame ? { x: 3222, z: 3218 } : null;
    }

    hudDialog() {
        const options = this.state.dialogOptions;
        if (!this.state.chatModal || this.state.tutorialMessage) {
            return null;
        }
        return { options: (options ?? []).map((text, i) => ({ text, x: 17 + 100, y: 357 + 20 + i * 16, w: 280, h: 16 })) };
    }

    hudChatLines(max) {
        return this.chatLines.slice(0, max);
    }

    tapAt(x, y, button = 1) {
        this.calls.push(['tapAt', x, y, button]);
        for (const [tab, [cx, cy]] of Object.entries(TAB_CENTRE)) {
            if (cx === x && cy === y) {
                this.state.activeTab = Number(tab);
                this.draw();
                return;
            }
        }
        CHAT_MODE_CENTRE.forEach(([cx, cy], mode) => {
            if (cx === x && cy === y && mode < 3) {
                this.state.chatModes[mode] = (this.state.chatModes[mode] + 1) % (mode === 0 ? 4 : 3);
            }
        });
    }

    hudSetRun(run) {
        this.calls.push(['hudSetRun', run]);
        this.state.running = run;
        return true;
    }

    hudMenuSelect(serial, index) {
        this.calls.push(['hudMenuSelect', serial, index]);
        this.hudMenuClose(serial);
    }

    hudMenuClose(serial) {
        if (serial !== this.state.menu?.serial) {
            return;
        }
        if (this.state.menuOpen) {
            this.state.menuOpen = false;
            this.state.menu = null;
            globalThis.lcHost?.onClientEvent?.('menu-close');
        }
    }

    setHostMenus(on) {
        this.hostMenus = on;
    }

    setCameraZoom(zoom) {
        this.calls.push(['setCameraZoom', zoom]);
        this.state.cameraZoom = Math.min(1.4, Math.max(0.6, zoom)); // the client's CAMERA_ZOOM_MIN/MAX
        return this.state.cameraZoom;
    }

    setTapToDrop(on) {
        this.calls.push(['setTapToDrop', on]);
        this.state.tapToDrop = on === true;
        return this.state.tapToDrop;
    }

    hudFaceNorth() {
        this.calls.push(['hudFaceNorth']);
        this.state.cameraYaw = 0;
    }

    cancelPointer() {}

    cancelPointerOn() {}

    setTargetedFramerate(fps) {
        this.tfps = fps;
    }
}
