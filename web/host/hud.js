// LostCity iOS host page: the mobile HUD (layout "mobile", the default).
//
// In game the client draws the 3D world, the minimap, the side panel and the chatbox into four canvases of their own
// (patch 0011, Client.setSurfaceLayout). The world fills the screen; this file places the rest over it with the
// controls a phone needs, in the 2004 look (sprites and fonts from Server/content, built into ui/ by web/ui/build.mjs):
//   - top right: the minimap as a round map in a stone ring, its compass on the ring (a tap faces north), the World map
//     button opposite it on the lower right (worldmap.js) and its zoom slider along the ring's lower left (a knob in a groove: up towards
//     + zooms in), and beside it the hitpoints, prayer and run orbs (a tap on hitpoints or prayer opens that tab, on run
//     switches running);
//   - right: the 13 classic tabs and Settings as stone slabs in a framed stone column under the minimap; a tap slides
//     that tab's panel out beside the column, a tap on the open tab closes it. A side modal (bank, shop, trade...) opens the panel
//     by itself at the right edge, and the minimap, orbs and column give way to it;
//   - bottom left: the newest chat lines over the world above the tap-to-drop, keyboard and chat buttons; the full
//     chatbox (and the 2004 chat filter buttons under it) opens on a tap, and by itself for a dialogue, the tutorial's
//     instructions, an amount/name prompt or typed chat. Tap-to-drop is OSRS mobile's: while it is on (the button red),
//     the inventory panel's frame is red and a tap on an item there drops it; in the bank the inventory beside it is
//     framed red too, and a tap there deposits all of the item.
// The minimap is as large as the screen allows next to the panel; nothing overlaps or runs off the screen at any
// phone size. The HUD tells the client how much of the viewport it covers (setViewportInsets), so the client centres
// windows and keeps its own viewport texts in the rest. What the player opened gives way to what the game opens: the
// panel steps aside for a dialogue, a prompt or a window without a side panel, and comes back afterwards. A tab the
// user taps while such a window is open shows its panel over the window, which stays where it is.
//
// The title screen keeps the classic 765x503 canvas (host.js layout()), as does the "classic" layout setting.
// Loaded right after host.js, which calls window.__lcHud.init(api) at boot.
(() => {
    'use strict';

    // the client's areas (game px)
    const MAP = { w: 172, h: 156 };
    const MAP_PLAYER = { x: 98, y: 80 }; // the player in the minimap area: the round map is centred on it
    const MAP_CLIP_R = 64; // game px around the player that are all map (further out: the mapback's stone and dragons)
    const SIDE = { w: 190, h: 261 };
    // The side panel is shown at 5/6 of the client's size (2.5 device px per game px on a 3x iPhone): at 1:1 it reached
    // in towards the player at the centre of the screen. Its surface keeps the client's 190x261 pixels.
    const PANEL = { w: Math.round((SIDE.w * 5) / 6), h: Math.round((SIDE.h * 5) / 6) }; // 158x218
    const CHAT = { w: 479, h: 96 };

    // Where the client's own hit tests expect each tab and chat mode button (classic virtual coordinates, the centres
    // of their rects in Client.iconLoop / chatModeLoop). A HUD tap is sent there with tapAt(), so the client does exactly
    // what a click on the original button does (including the tutorial's TUT_CLICKSIDE and a spell's target mode).
    const TAB_CENTRE = { 0: [556, 187], 1: [584, 186], 2: [612, 186], 3: [647, 185], 4: [681, 186], 5: [709, 186], 6: [739, 187], 8: [587, 484], 9: [614, 484], 10: [649, 484], 11: [684, 484], 12: [711, 484], 13: [741, 484] };
    const TAB_ICON = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 8: 7, 9: 8, 10: 9, 11: 10, 12: 11, 13: 12 }; // sideicons tile
    const STATS_TAB = 1;
    const INVENTORY_TAB = 3;
    const PRAYER_TAB = 5;
    const CHAT_MODE_CENTRE = [[56, 483], [185, 483], [323, 483]]; // public, private, trade (not Report abuse: offline)
    const CHAT_MODE_VALUES = [
        ['On', 'Friends', 'Off', 'Hide'],
        ['On', 'Friends', 'Off'],
        ['On', 'Friends', 'Off']
    ];
    const CHAT_MODE_CLASS = ['on', 'friends', 'off', 'hide'];
    // the PixFont colour tags (Colour.ts)
    const TAG_COLOURS = {
        red: '#ff0000', gre: '#00ff00', blu: '#0000ff', yel: '#ffff00', cya: '#00ffff', mag: '#ff00ff', whi: '#ffffff', bla: '#000000',
        lre: '#ff9040', dre: '#800000', dbl: '#000080', or1: '#ffb000', or2: '#ff7000', or3: '#ff3000', gr1: '#c0ff00', gr2: '#80ff00', gr3: '#40ff00'
    };

    // Geometry in HUD px: CSS px, times uiScale on a large screen (#hud-ui is scaled up as a whole). The world is rendered at one game
    // pixel per CSS px (3 device px on an iPhone) up to MAX_RENDER_PIXELS, then scaled; the panel and the chatbox are
    // 1:1 like the 2004 client.
    const MAX_RENDER_PIXELS = 410000; // (the largest iPhone, 932x430, still renders 1:1)
    const BESIDE_PANEL_MIN = 300; // CSS px beside the side panel that a 512 px window is made to fit in (see renderSize)
    const EDGE = 4; // to the edges of the safe area
    const GAP = 4; // between HUD elements
    const FRAME = 3; // the stone frame around the panel and the chatbox
    const TAB_W = 34; // a tab stone (30 px) and its share of the gaps
    const TAB_ROWS = 7;
    const ROW_MIN = 32;
    const ROW_MAX = 44;
    const COL_PAD = 2; // inside the column's frame
    const COL_FRAME = 2; // the column's stone bevel
    const RING = 4; // the minimap's stone ring (thin, so the map gets the room)
    const MAP_R_MIN = 40;
    const MAP_R_MAX = 78;
    const COMPASS = 34;
    // The minimap's zoom slider: a groove along the ring from ZOOM_ARC.out (zoomed out, towards the bottom) to
    // ZOOM_ARC.in (zoomed in, by the left), in degrees clockwise from the right. Its outer end moves up the ring where
    // the knob would come near the tab column or the panel (never shorter than ZOOM_ARC_MIN).
    const ZOOM_ARC = { out: 120, in: 192 }; // (192: the knob's box clear of the compass's)
    const ZOOM_ARC_MIN = 45;
    const KNOB = 22;
    const MINIMAP_ZOOM = { min: 0.75, max: 2 }; // Client.ts MINIMAP_ZOOM_MIN..MAX (patch 0017); 1 = the 2004 zoom
    const ZOOM_RANGE = Math.log(MINIMAP_ZOOM.max / MINIMAP_ZOOM.min);
    const ZOOM_DETENT = 0.04; // of the groove around the 2004 zoom, which snaps to it
    const ORB_H = 30;
    const BAR_H = 38;
    const CHAT_LINES = 3;
    const LINE_H = 14;
    const LINES_FADE_MS = 12000; // the newest chat lines over the world fade out after this long without a new one
    const CAMERA_PAD = { w: 44 * 3 + 4, h: 40 * 3 + 4 };
    const DIALOG_ROW = 40; // a dialogue answer, for a finger (the 2004 lines are 16 px)
    const DIALOG_TITLE = 24;

    let api = null;
    const el = {};

    const state = {
        enabled: false, // the mobile layout is selected
        active: false, // ...and the client is in game: the HUD is on screen
        panelOpen: false, // the panel the player opened with a tab
        panelRestore: false, // ...stepped aside for a dialogue, prompt or window, and comes back after it
        chatOpen: false, // the chatbox the player opened
        typing: false, // the chatbox is above the native keyboard
        tutorialCollapsed: false, // the player put Tutorial Island's instructions away...
        tutorialKey: null, // ...for this step (a new step shows them again)
        shown: { panel: false, chat: false, map: false }, // what place() last showed
        view: null, // last { vw, vh, safe }
        uiScale: 1,
        geometryKey: '',
        surfaceKey: '',
        insetsKey: '',
        modesWidth: 0, // HUD px the chat bar has with its filters (0: they do not show), see fitChatModes
        hud: null, // last client hudState()
        dialog: null, // the open dialogue's answers (hudDialog().options), when it offers a choice
        dialogKey: '',
        linesKey: '',
        linesTimer: 0,
        orbsKey: '',
        zoomArc: null, // the zoom slider's groove as placed: { out, in, r } (degrees, HUD px)
        zoomDrag: null, // { id, offset }: the finger moving the knob
        zoomNotch: null, // where the knob last stopped with a click: 'min', 'max', 'detent'
        yaw: -1,
        tapDrop: false, // tap-to-drop is on (the chat bar's drop button, Client.setTapToDrop); off in a new session
        rafId: 0
    };

    function init(hostApi) {
        api = hostApi;
        for (const id of ['hud-dialog', 'hud-dialog-options', 'hud', 'hud-ui', 'surface-game', 'surface-map', 'surface-side', 'surface-chat', 'hud-map', 'hud-map-clip', 'btn-compass', 'btn-worldmap', 'hud-orbs', 'map-zoom', 'map-zoom-track', 'zoom-mark-in', 'zoom-mark-out', 'hud-tabs', 'hud-panel', 'btn-drop', 'hud-chat-box', 'hud-chat-bar', 'hud-chat-modes', 'hud-chat-lines', 'hud-camera', 'btn-chat-toggle', 'orb-hp', 'orb-prayer', 'hp-value', 'prayer-value', 'run-energy']) {
            el[id] = document.getElementById(id);
        }
        el.rose = el['btn-compass'].querySelector('.compass-rose');
        el.tabs = [...el['hud-tabs'].querySelectorAll('.tab[data-tab]')];
        el.chatModes = [...el['hud-chat-modes'].querySelectorAll('.chat-mode')];

        for (const tab of el.tabs) {
            const index = Number(tab.dataset.tab);
            tab.style.setProperty('--icon', `url(ui/sprites/sideicons-${TAB_ICON[index]}.png)`);
            api.bindTapButton(tab, () => onTab(index));
        }
        for (const button of el.chatModes) {
            const mode = Number(button.dataset.chatMode);
            api.bindTapButton(button, () => tapClient(...CHAT_MODE_CENTRE[mode]));
        }
        api.bindTapButton(el['btn-chat-toggle'], onChatToggle);
        api.bindTapButton(el['btn-compass'], () => api.client()?.hudFaceNorth?.());
        api.bindTapButton(el['btn-worldmap'], () => api.openWorldMap?.());
        api.bindTapButton(el['orb-hp'], () => onTab(STATS_TAB));
        api.bindTapButton(el['orb-prayer'], () => onTab(PRAYER_TAB));
        api.bindTapButton(el['btn-drop'], () => setTapDrop(!state.tapDrop));
        // a tap on the ring (not the map) must not reach the world under it
        el['hud-map'].addEventListener('pointerdown', event => event.preventDefault());
        initMinimapZoom();

        return hud;
    }

    // ---------------------------------------------------------------------------------------------------- actions

    function tapClient(x, y) {
        const c = api.client();
        if (typeof c?.tapAt === 'function') {
            c.tapAt(x, y, 1);
        }
    }

    // (Also while a window without a side panel is open: the panel then shows over the window, see place().)
    function onTab(index) {
        const s = state.hud;
        if (!s || !s.tabs[index] || s.sideModal) {
            return;
        }
        if (state.panelOpen && s.activeTab === index) {
            setPanelOpen(false);
            return;
        }
        tapClient(...TAB_CENTRE[index]);
        setPanelOpen(true);
    }

    function setPanelOpen(open) {
        state.panelRestore = false; // the player decided
        if (state.panelOpen === open) {
            return;
        }
        state.panelOpen = open;
        update();
    }

    // Tap-to-drop: the client drops an item a tap in the inventory acts on instead of doing its first op (in the bank it
    // deposits all of it; a long-press still gives the item's menu). The inventory panel's frame shows red while it is on
    // (update()).
    function setTapDrop(on) {
        state.tapDrop = on;
        api.client()?.setTapToDrop?.(on);
        setClass(el['btn-drop'], 'active', on);
        el['btn-drop'].setAttribute('aria-pressed', String(on));
        setClass(el['hud-panel'], 'drop-mode', on && state.hud !== null && isTapDropShown(state.hud));
    }

    function setChatOpen(open) {
        if (state.chatOpen === open) {
            return;
        }
        state.chatOpen = open;
        update();
    }

    // The chat button follows what is on screen. While the game holds the chatbox open (a dialogue, a prompt, typed
    // chat) it cannot be closed, and the button is dimmed. Tutorial Island's instructions can be put away; the button
    // then glows until they are shown again, which a new step does by itself.
    function onChatToggle() {
        const s = state.hud;
        if (!s || isChatForced(s)) {
            return;
        }
        if (isTutorialShown(s)) {
            state.tutorialCollapsed = true;
            state.chatOpen = false;
            update();
            return;
        }
        if (s.tutorialChat && state.tutorialCollapsed && !s.mainModal) {
            state.tutorialCollapsed = false;
            update();
            return;
        }
        setChatOpen(!isChatShown(s));
    }

    // Escape on a hardware keyboard: closes a chatbox or panel the player opened. True if it closed something.
    function escape() {
        const s = state.hud;
        if (!state.active || !s) {
            return false;
        }
        if (isTutorialShown(s)) {
            // as the chat button puts them away: a chatbox the player had opened goes too
            state.tutorialCollapsed = true;
            state.chatOpen = false;
        } else if (state.chatOpen && isChatShown(s) && !isChatForced(s)) {
            state.chatOpen = false;
        } else if (state.panelOpen && !s.sideModal) {
            state.panelOpen = false;
            state.panelRestore = false;
        } else {
            return false;
        }
        update();
        return true;
    }

    // The Run button: the real run mode (the Player controls tab's Walk / Run buttons) once that tab exists; before
    // that (Tutorial Island) host.js falls back to holding Ctrl, which makes every click run. True if handled here
    // (also while a window is open: the buttons' script would close it, so the button does nothing then).
    function toggleRun() {
        const c = api.client();
        const s = typeof c?.hudState === 'function' ? c.hudState() : null;
        if (!s?.ingame || !s.runExists) {
            return false;
        }
        if (s.runAvailable) {
            c.hudSetRun(!s.running);
        }
        return true;
    }

    // The minimap's zoom slider. The knob follows the finger round the ring (from where it was grabbed); a touch on the
    // groove moves it there. Logarithmic, so each part of the groove zooms by the same factor, with a detent at the 2004
    // zoom; a click of the haptics there and at either end.
    function initMinimapZoom() {
        const knob = el['map-zoom'];
        const hit = el['map-zoom-track'].querySelector('.groove-hit');
        knob.setAttribute('aria-valuemin', String(MINIMAP_ZOOM.min));
        knob.setAttribute('aria-valuemax', String(MINIMAP_ZOOM.max));
        for (const node of [knob, hit]) {
            node.addEventListener('pointerdown', event => {
                event.preventDefault();
                event.stopPropagation();
                if (state.zoomDrag || !state.zoomArc) {
                    return; // (one finger at a time)
                }
                const angle = pointerAngle(event);
                state.zoomDrag = { id: event.pointerId, offset: node === knob ? wrapAngle(angle - zoomAngle(api.settings.minimapZoom)) : 0 };
                state.zoomNotch = zoomNotch(zoomT(api.settings.minimapZoom)); // (no click for where the knob already is)
                node.setPointerCapture?.(event.pointerId);
                knob.classList.add('pressed');
                if (node === hit) {
                    dragZoom(angle);
                }
            });
            node.addEventListener('pointermove', event => {
                if (state.zoomDrag?.id === event.pointerId) {
                    dragZoom(pointerAngle(event) - state.zoomDrag.offset);
                }
            });
            const end = event => {
                if (state.zoomDrag?.id === event.pointerId) {
                    state.zoomDrag = null;
                    knob.classList.remove('pressed');
                }
            };
            node.addEventListener('pointerup', end);
            node.addEventListener('pointercancel', end);
            node.addEventListener('lostpointercapture', end);
            node.addEventListener('contextmenu', event => event.preventDefault());
        }
    }

    // degrees clockwise from the right, of a pointer around the minimap's centre (screen px: any UI zoom cancels out)
    function pointerAngle(event) {
        const r = el['hud-map'].getBoundingClientRect();
        return (Math.atan2(event.clientY - (r.top + r.height / 2), event.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
    }

    function wrapAngle(a) {
        return ((((a + 180) % 360) + 360) % 360) - 180;
    }

    // a zoom's place along the groove, 0 (zoomed out) to 1
    function zoomT(zoom) {
        return Math.min(1, Math.max(0, Math.log(zoom / MINIMAP_ZOOM.min) / ZOOM_RANGE));
    }

    function zoomNotch(t) {
        return t <= 0 ? 'min' : t >= 1 ? 'max' : t === zoomT(1) ? 'detent' : null;
    }

    function zoomAngle(zoom) {
        const arc = state.zoomArc;
        return arc.out + zoomT(zoom) * (arc.in - arc.out);
    }

    function dragZoom(angle) {
        const arc = state.zoomArc;
        // the nearer end for an angle outside the groove (round the far side of the ring too)
        const span = arc.in - arc.out;
        const along = wrapAngle(angle - arc.out - span / 2) + span / 2;
        let t = Math.min(1, Math.max(0, along / span));
        if (Math.abs(t - zoomT(1)) < ZOOM_DETENT) {
            t = zoomT(1);
        }
        const notch = zoomNotch(t);
        if (notch && notch !== state.zoomNotch) {
            api.haptic('selection');
        }
        state.zoomNotch = notch;
        const zoom = notch === 'detent' ? 1 : MINIMAP_ZOOM.min * Math.exp(t * ZOOM_RANGE);
        placeZoomKnob(api.setMinimapZoom(zoom));
    }

    function placeZoomKnob(zoom) {
        const arc = state.zoomArc;
        if (!arc) {
            return;
        }
        const a = (zoomAngle(zoom) * Math.PI) / 180;
        const r = el['hud-map'].offsetWidth / 2;
        el['map-zoom'].style.left = `${r + arc.r * Math.cos(a) - KNOB / 2}px`;
        el['map-zoom'].style.top = `${r + arc.r * Math.sin(a) - KNOB / 2}px`;
        el['map-zoom'].setAttribute('aria-valuenow', zoom.toFixed(2));
    }

    // The groove, its marks and the knob for the minimap's place (in the minimap's own px, its centre at r, r).
    function placeZoom(g) {
        const { r } = g.map;
        const arc = g.zoomArc;
        state.zoomArc = arc;
        const point = (a, radius) => [r + radius * Math.cos((a * Math.PI) / 180), r + radius * Math.sin((a * Math.PI) / 180)];
        const path = radius => {
            const [x0, y0] = point(arc.out, radius);
            const [x1, y1] = point(arc.in, radius);
            return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
        };
        const track = el['map-zoom-track'];
        track.setAttribute('width', String(r * 2));
        track.setAttribute('height', String(r * 2));
        track.querySelector('.groove').setAttribute('d', path(arc.r));
        track.querySelector('.groove-hit').setAttribute('d', path(arc.r));
        track.querySelector('.groove-light').setAttribute('d', path(arc.r + 1.5));
        for (const [mark, a] of [
            [el['zoom-mark-in'], arc.in],
            [el['zoom-mark-out'], arc.out]
        ]) {
            const [x, y] = point(a, r + 7);
            mark.style.left = `${Math.round(x)}px`;
            mark.style.top = `${Math.round(y)}px`;
        }
        placeZoomKnob(api.settings.minimapZoom);
    }

    // ---------------------------------------------------------------------------------------------------- layout

    // Called by host.js layout() for the mobile layout, on every resize, safe-area or phase change.
    function layout(view, inGame) {
        state.view = view;
        state.uiScale = view.zoom ?? 1; // (host.js: larger on an iPad)
        const show = state.enabled && inGame;
        if (show !== state.active) {
            state.active = show;
            el.hud.hidden = !show;
            if (show) {
                startLoop();
            } else {
                endSession();
            }
        }
        if (state.enabled) {
            applySurfaces(view);
        }
        if (show) {
            update();
        }
    }

    // Back on the title screen (or out of the mobile layout): the next session starts with the panel and chatbox closed.
    function endSession() {
        stopLoop();
        state.dialog = null;
        state.dialogKey = '';
        el['hud-dialog-options'].textContent = '';
        state.panelOpen = false;
        state.panelRestore = false;
        state.chatOpen = false;
        state.tutorialCollapsed = false;
        state.tutorialKey = null;
        state.shown = { panel: false, chat: false, map: false };
        state.hud = null;
        state.linesKey = '';
        state.orbsKey = '';
        state.zoomDrag = null;
        state.yaw = -1;
        setTapDrop(false);
        state.geometryKey = '';
        state.insetsKey = '';
    }

    // Render px per CSS px (scale), the render size, and the world surface's CSS box (cssWidth x cssHeight, from the top
    // left corner). Where a 512 px window (the bank, a shop) would not fit beside the side panel at the screen's edge (an
    // iPhone SE: 667 px), the world renders a little larger than the screen so that it does. Not without bound: beside
    // less than BESIDE_PANEL_MIN (no phone; a narrow desktop window) the window overlaps the panel rather than the world
    // growing without end. At a fractional device pixel ratio the crisp rule comes first (crispSize).
    function renderSize(view) {
        const besideCss = view.vw - view.safe.left - view.safe.right - (PANEL.w + FRAME * 2 + GAP) * (view.zoom ?? 1);
        const crisp = crispSize(view, besideCss);
        if (crisp) {
            return crisp;
        }
        const besidePanel = Math.max(BESIDE_PANEL_MIN, besideCss);
        const scale = Math.max(334 / view.vh, 512 / view.vw, 512 / besidePanel, Math.min(1, Math.sqrt(MAX_RENDER_PIXELS / (view.vw * view.vh))));
        return { scale, width: Math.round(view.vw * scale), height: Math.round(view.vh * scale), cssWidth: view.vw, cssHeight: view.vh };
    }

    // The crisp pixel snap's world (docs/ANDROID.md §1 "Pixels"; host.js snapZoom does the HUD's): at a fractional device
    // pixel ratio with World scaling on Pixel, the world renders at a whole number k of device px per game px, the
    // smallest k from round(dpr) up that gives at least the client's 512x334, at most MAX_RENDER_PIXELS, and still a
    // 512 px window beside the side panel (a larger k only makes that worse: then the rule above, soft). 914x411 CSS px
    // at 2.625 (a Pixel phone, 2400x1080): k = 3, 800x360 game px, each exactly 3x3 device px, as on a 3x iPhone. As the
    // HUD's, it never rounds the ratio down where the next whole number has no room (a larger Display size: 3.125 on a
    // 1080 px phone would stay at 3, the default's world): the rule above then, soft but growing with the Display size.
    // The render size is rounded up and the surface laid from the top left corner at W·k/dpr x H·k/dpr CSS px, so it
    // covers the viewport whatever whole number of CSS px the page is told (914 for 914.29); the sub-pixel rest is clipped
    // (#hud overflow). Never at a whole-number ratio (an iPhone, the desktop tests): null.
    function crispSize(view, besideCss) {
        const dpr = view.dpr;
        if (!(dpr > 0) || Number.isInteger(dpr) || api.settings.smoothScaling === true) {
            return null;
        }
        const up = x => Math.ceil(x - 1e-6); // (an exact 2400 / 3 stays 800)
        const fits = k => up((view.vw * dpr) / k) >= 512 && up((view.vh * dpr) / k) >= 334 && (besideCss * dpr) / k >= 512;
        const first = Math.max(1, Math.round(dpr));
        if (first < dpr && !fits(first + 1)) {
            return null;
        }
        for (let k = first; ; k++) {
            if (!fits(k)) {
                return null;
            }
            const width = up((view.vw * dpr) / k);
            const height = up((view.vh * dpr) / k);
            if (width * height <= MAX_RENDER_PIXELS) {
                return { scale: dpr / k, width, height, cssWidth: (width * k) / dpr, cssHeight: (height * k) / dpr, k };
            }
        }
    }

    // The client's surface layout is set as soon as the mobile layout is on (also on the title screen), so the first
    // in-game frame is already drawn into the surfaces.
    function applySurfaces(view) {
        const c = api.client();
        if (typeof c?.setSurfaceLayout !== 'function') {
            return;
        }
        const size = renderSize(view);
        const key = `${size.width}x${size.height}`;
        if (key === state.surfaceKey) {
            return;
        }
        state.surfaceKey = key;
        c.setSurfaceLayout({
            game: el['surface-game'],
            map: el['surface-map'],
            side: el['surface-side'],
            chat: el['surface-chat'],
            width: size.width,
            height: size.height,
            insets: null
        });
        // that reset the client's insets: the next place() must send them again
        state.geometryKey = '';
        state.insetsKey = '';
    }

    function setEnabled(enabled) {
        if (enabled === state.enabled) {
            return;
        }
        state.enabled = enabled;
        state.surfaceKey = '';
        if (!enabled) {
            api.client()?.setSurfaceLayout?.(null);
            if (state.active) {
                state.active = false;
                el.hud.hidden = true;
            }
            endSession();
        }
    }

    // What the game opened that the player's panel steps aside for: a dialogue or prompt in the chatbox, or a window
    // without a side panel of its own (smithing, a quest scroll, a skill guide...), which needs the room. Not Tutorial
    // Island's game messages ("You catch some shrimps."), which come with every action there: the chatbox shows them
    // beside the open panel.
    function panelYields(s) {
        return (s.chatModal && !s.tutorialMessage) || s.chatInput || (s.mainModal && !s.sideModal);
    }

    function isPanelShown(s) {
        return s.sideModal || state.panelOpen;
    }

    // the inventory tab's panel (not a bank's, shop's or trade's inventory: tap-to-drop leaves those alone)
    function isInventoryShown(s) {
        return state.panelOpen && !s.sideModal && s.activeTab === INVENTORY_TAB && s.tabs[INVENTORY_TAB] === true;
    }

    // a panel tap-to-drop acts in: the inventory tab's, or the bank's inventory (where a tap deposits all)
    function isTapDropShown(s) {
        return isInventoryShown(s) || (s.sideModal && s.tapDeposit === true);
    }

    // While the native keyboard types into the chatbox (chat, an amount or a name), the chatbox shows above it.
    function isTyping() {
        const k = api.keyboard();
        return k.overlap > 0 && (k.kind === 'chat' || k.kind === 'dialog' || k.kind === 'social');
    }

    // (A chat draft holds the chatbox open only while something is being typed: one left behind when the software
    // keyboard was put away does not, so the chatbox can be closed; the draft waits in it.)
    function isChatForced(s) {
        return s.chatModal || s.chatInput || (s.chatTyping && api.keyboard().typing) || isTyping() || (s.menuOpen && s.menuArea === 2);
    }

    function isTutorialShown(s) {
        return s.tutorialChat && !s.mainModal && !state.tutorialCollapsed && !isChatForced(s);
    }

    // The chatbox opens for a dialogue, an amount/name prompt and typed chat; for the tutorial's instructions too
    // (unless put away), and when the player opened it, except while a window (e.g. the character designer, the bank)
    // needs the bottom.
    function isChatShown(s) {
        return isChatForced(s) || isTutorialShown(s) || (state.chatOpen && !s.mainModal);
    }

    // Where everything goes, in HUD px, for a view (vw, vh, safe already divided by uiScale) and what is shown.
    function geometry(v, show) {
        const g = {};
        const left = v.safe.left + EDGE;
        const right = v.vw - v.safe.right - EDGE; // the right edge of the HUD's content (backgrounds may bleed past it)
        const top = v.safe.top + EDGE;
        const bottom = v.vh - v.safe.bottom - EDGE; // (Settings › Display › Bottom margin: 0 at Auto but on a curved edge)

        // the tab column at the right, a framed stone column like the panel
        const columnW = TAB_W * 2 + (COL_PAD + COL_FRAME) * 2;
        const columnLeft = right - columnW;

        // the side panel, left of the column (at the right edge while a side modal hides the column), its bottom by
        // the screen's
        const panelW = PANEL.w + FRAME * 2;
        const panelH = PANEL.h + FRAME * 2;
        // (at the edge it goes right up to the safe area, so a 512 px window still fits beside it on a 812 px screen)
        const panelRight = show.tabs ? columnLeft - GAP : v.vw - v.safe.right;
        g.panel = { x: panelRight - panelW, y: Math.max(top, bottom - panelH), w: panelW, h: panelH };

        // The minimap: the largest round map in the top right corner that stays clear of the panel (where it opens
        // beside the column) and leaves the column room for its rows.
        const panelBox = { x: columnLeft - GAP - panelW, y: Math.max(top, bottom - panelH), r: columnLeft - GAP };
        let r = MAP_R_MAX;
        for (; r > MAP_R_MIN; r--) {
            const cx = right - r;
            const cy = top + r;
            const columnTop = cy + r + GAP;
            const rows = Math.floor((bottom - columnTop - (COL_PAD + COL_FRAME) * 2) / TAB_ROWS);
            const nx = Math.min(Math.max(cx, panelBox.x), panelBox.r);
            const ny = Math.max(cy, panelBox.y);
            if (rows >= ROW_MIN && Math.hypot(cx - nx, cy - ny) >= r + GAP) {
                break;
            }
        }
        g.map = { cx: right - r, cy: top + r, r };
        const d = (r - RING / 2) * Math.SQRT1_2;
        g.compass = { x: Math.round(g.map.cx - d - COMPASS / 2), y: Math.round(Math.max(v.safe.top + 2, g.map.cy - d - COMPASS / 2)) };
        // the World map button opposite the compass, on the ring's lower right (on the top right it was too easy to hit
        // by mistake)
        g.worldmap = { x: Math.round(g.map.cx + d - KNOB / 2), y: Math.round(g.map.cy + d - KNOB / 2) };

        // the column under the minimap, as tall as its rows, its bottom level with the panel's
        const columnTop = Math.round(g.map.cy + r + GAP);
        g.row = Math.max(ROW_MIN - 4, Math.min(ROW_MAX, Math.floor((bottom - columnTop - (COL_PAD + COL_FRAME) * 2) / TAB_ROWS)));
        const columnH = g.row * TAB_ROWS + (COL_PAD + COL_FRAME) * 2;
        g.column = { x: columnLeft, y: bottom - columnH, w: columnW, h: columnH };

        // the zoom slider's groove on the ring, its knob clear of the column and of the panel where it opens beside it
        const groove = r - RING / 2;
        const knobClear = a => {
            const x = g.map.cx + groove * Math.cos((a * Math.PI) / 180);
            const y = g.map.cy + groove * Math.sin((a * Math.PI) / 180);
            const k = KNOB / 2 + GAP;
            const outside = (bx, by, br, bb) => x + k <= bx || x - k >= br || y + k <= by || y - k >= bb;
            return outside(g.column.x, g.column.y, g.column.x + g.column.w, g.column.y + g.column.h) && outside(panelBox.x, panelBox.y, panelBox.r, bottom);
        };
        let zoomOut = ZOOM_ARC.out;
        while (zoomOut < ZOOM_ARC.in - ZOOM_ARC_MIN && !knobClear(zoomOut)) {
            zoomOut++;
        }
        g.zoomArc = { out: zoomOut, in: ZOOM_ARC.in, r: groove };

        // the orbs in a row left of the compass, at the top
        g.orbs = { right: Math.min(g.compass.x, g.map.cx - r) - GAP, y: top };

        // the chat: its buttons in the bottom left corner, the chatbox above them
        g.bar = { x: left, y: bottom - BAR_H };
        g.chat = { x: left, y: g.bar.y - GAP - (CHAT.h + FRAME * 2), w: CHAT.w + FRAME * 2, h: CHAT.h + FRAME * 2 };
        // the left edge of what covers the right of the screen at the height of the chat
        g.coveredRight = show.panel ? g.panel.x : show.tabs ? columnLeft : right;
        g.left = left;
        g.right = right;
        return g;
    }

    // The view in HUD px (CSS px divided by the zoom k). At a fractional device pixel ratio the zoom is the crisp pixel
    // snap's (host.js snapZoom: a whole number of device px per HUD px, 3 on a 2.625 phone), and only a whole HUD px is
    // a whole number of device px: the screen's 914 CSS px are 799.75 HUD px there, which would put everything laid
    // from the right or bottom edge (the column, the panel, the chat bar) between device pixels, soft. So there the
    // HUD's area is the whole HUD px inside the screen (799x359) and the safe area whole HUD px around the notch (the
    // last fraction of a HUD px at the right and bottom edges is left to the world). At a whole-number ratio (an iPhone,
    // an iPad, the desktop tests) nothing is rounded: exactly as before.
    function hudView(view, k) {
        if (!(view.dpr > 0) || Number.isInteger(view.dpr)) {
            return { vw: view.vw / k, vh: view.vh / k, safe: { left: view.safe.left / k, right: view.safe.right / k, top: view.safe.top / k, bottom: view.safe.bottom / k } };
        }
        const down = x => Math.floor(x + 1e-6);
        const up = x => Math.ceil(x - 1e-6);
        return { vw: down(view.vw / k), vh: down(view.vh / k), safe: { left: up(view.safe.left / k), right: up(view.safe.right / k), top: up(view.safe.top / k), bottom: up(view.safe.bottom / k) }, snapped: true };
    }

    // Positions everything for the current view and HUD state; cheap when nothing changed.
    function place(s) {
        const view = state.view;
        if (!view) {
            return;
        }
        const k = state.uiScale;
        const v = hudView(view, k);
        const chatShown = isChatShown(s);
        const keyboard = api.keyboard();
        const typing = isTyping();
        const show = {
            panel: isPanelShown(s),
            tabs: !s.sideModal,
            map: !s.sideModal,
            orbs: !s.mainModal && !s.sideModal && !typing,
            chat: chatShown && !(state.dialog && !typing),
            dialog: chatShown && !!state.dialog && !typing,
            // the chat filters only beside a chatbox the player opened or is typing in, not under a dialogue, prompt
            // or the tutorial's instructions
            modes: chatShown && !typing && !s.chatModal && !s.chatInput && !isTutorialShown(s),
            bar: (chatShown || !s.mainModal) && !typing,
            lines: !chatShown && !s.mainModal,
            camera: api.settings.cameraButtons === true && !s.mainModal && !s.sideModal && !typing
        };
        const forced = isChatForced(s);
        // the panel the player opened over a window without a side panel (a tab tapped while the character designer or
        // smithing is open) covers part of the window instead of moving it
        const panelOver = show.panel && s.mainModal && !s.sideModal;
        const key = [view.vw, view.vh, view.safe.left, view.safe.right, view.safe.top, view.safe.bottom, ...Object.values(show), forced, panelOver, typing ? keyboard.overlap : 0, state.dialogKey].join();

        // the chat button follows what shows, also where the layout stays the same (the glow comes and goes by itself)
        const toggle = el['btn-chat-toggle'];
        setClass(toggle, 'open', show.chat);
        setClass(toggle, 'forced', forced);
        setClass(toggle, 'glow', s.tutorialChat && state.tutorialCollapsed && !s.mainModal);
        const toggleLabel = show.chat ? 'Hide the chat' : 'Show the chat';
        if (toggle.getAttribute('aria-label') !== toggleLabel) {
            toggle.setAttribute('aria-label', toggleLabel);
        }

        // a surface hidden under a resting finger keeps the touch (display:none keeps pointer capture): end it here; an
        // options menu for it closes too
        if (state.shown.panel && !show.panel) {
            api.client()?.cancelPointerOn?.(el['surface-side']);
            closeMenuOf(s, 1);
        }
        if (state.shown.chat && !show.chat) {
            api.client()?.cancelPointerOn?.(el['surface-chat']);
            if (!show.dialog) {
                closeMenuOf(s, 2);
            }
        }
        if (state.shown.map && !show.map) {
            api.client()?.cancelPointerOn?.(el['surface-map']);
        }
        state.shown = { panel: show.panel, chat: show.chat, map: show.map };

        if (key === state.geometryKey) {
            return;
        }
        state.geometryKey = key;

        const g = geometry(v, show);
        // a large screen's zoom: laid out in HUD px and scaled up as a whole (a transform: WebKit's CSS zoom would leave
        // the text of anything that sets its own font at 1x). The crisp pixel snap's zoom (a fractional device pixel
        // ratio, Android: v.snapped) is CSS zoom instead, so that Chromium lays the HUD out at its final scale, each HUD
        // px on its own 3x3 device px (host.css html.ui-snapped says why; never on an iPhone or iPad)
        const box = { width: `${v.vw}px`, height: `${v.vh}px` };
        Object.assign(el['hud-ui'].style, k === 1 ? { width: '', height: '', transform: '', zoom: '' } : v.snapped ? { ...box, transform: '', zoom: String(k) } : { ...box, transform: `scale(${k})`, zoom: '' });
        const world = renderSize(view);
        setBox(el['surface-game'], 0, 0, world.cssWidth, world.cssHeight);

        // minimap: the round map in its ring; the canvas is placed so that the player is at the centre
        const map = el['hud-map'];
        map.hidden = !show.map;
        el['btn-compass'].hidden = !show.map;
        el['btn-worldmap'].hidden = !show.map || !api.openWorldMap;
        if (show.map) {
            const r = g.map.r;
            setBox(map, g.map.cx - r, g.map.cy - r, r * 2, r * 2);
            const inner = r - RING;
            const scale = inner / MAP_CLIP_R;
            setBox(el['hud-map-clip'], RING, RING, inner * 2, inner * 2);
            setBox(el['surface-map'], inner - MAP_PLAYER.x * scale, inner - MAP_PLAYER.y * scale, MAP.w * scale, MAP.h * scale);
            setBox(el['btn-compass'], g.compass.x, g.compass.y, COMPASS, COMPASS);
            setBox(el['btn-worldmap'], g.worldmap.x, g.worldmap.y, KNOB, KNOB);
            placeZoom(g);
        }

        const orbs = el['hud-orbs'];
        orbs.hidden = !show.orbs;
        Object.assign(orbs.style, { right: `${v.vw - g.orbs.right}px`, top: `${g.orbs.y}px`, height: `${ORB_H}px` });

        const tabs = el['hud-tabs'];
        tabs.hidden = !show.tabs;
        setBox(tabs, g.column.x, g.column.y, g.column.w, g.column.h);
        tabs.style.setProperty('--row', `${g.row}px`);
        tabs.style.setProperty('--tab-w', `${TAB_W}px`);

        const panel = el['hud-panel'];
        panel.hidden = !show.panel;
        setBox(panel, g.panel.x, g.panel.y, g.panel.w, g.panel.h);

        // chat: the buttons, the filter buttons beside them while the chatbox is open, the newest lines above them
        const bar = el['hud-chat-bar'];
        bar.hidden = !show.bar;
        Object.assign(bar.style, { left: `${g.bar.x}px`, top: `${g.bar.y}px`, height: `${BAR_H}px` });
        state.modesWidth = show.modes ? Math.min(g.chat.w, g.coveredRight - GAP - g.bar.x) : 0;
        fitChatModes();
        // the chatbox scales down to fit beside an open panel rather than run under it (0.88 on a 13 mini)
        const chatBox = el['hud-chat-box'];
        chatBox.hidden = !show.chat;
        const chatScale = Math.min(1, (g.coveredRight - GAP - g.chat.x) / g.chat.w);
        setBox(chatBox, g.chat.x, g.chat.y, g.chat.w, g.chat.h); // (scaled about its bottom left corner)
        chatBox.style.scale = chatScale < 1 ? String(chatScale) : '';
        const lines = el['hud-chat-lines'];
        if (lines.hidden && show.lines) {
            state.linesKey = ''; // shown again (e.g. the chatbox closed): the newest lines come back for a while
        }
        lines.hidden = !show.lines;
        Object.assign(lines.style, { left: `${g.left}px`, top: '', bottom: `${v.vh - g.bar.y + 2}px`, maxWidth: `${Math.max(120, g.coveredRight - GAP - g.left)}px` });
        // a dialogue's answers in the chatbox's place, growing upwards
        const dialog = el['hud-dialog'];
        dialog.hidden = !show.dialog;
        let dialogTop = 0;
        if (show.dialog) {
            const height = Math.min(g.chat.y + g.chat.h - v.safe.top - EDGE, DIALOG_TITLE + state.dialog.length * DIALOG_ROW + FRAME * 2 + 4);
            dialogTop = g.chat.y + g.chat.h - height;
            setBox(dialog, g.chat.x, dialogTop, Math.min(g.chat.w, g.coveredRight - GAP - g.chat.x), height);
        }

        // typing: the chatbox above the keyboard, sliding up and back down with it. It scales down to fit beside what
        // shows at its height there: the tops of the panel and the tab column (the rest is under the keyboard), the
        // minimap and its compass; and on a short screen (an SE with Display Zoom) to fit above the keyboard at all.
        const slide = typing !== state.typing;
        state.typing = typing;
        const slideCurve = `${Math.round(keyboard.duration * 1000)}ms ${keyboard.curve}`;
        chatBox.style.transition = slide && keyboard.duration > 0 ? `top ${slideCurve}, scale ${slideCurve}` : '';
        let typingTop = 0;
        if (typing) {
            // (snapped: the keyboard's overlap in whole HUD px too, so the lifted chatbox stays on whole device px)
            const bottom = v.vh - (v.snapped ? Math.ceil(keyboard.overlap / k - 1e-6) : keyboard.overlap / k) - GAP;
            const top = Math.max(v.safe.top + EDGE, bottom - g.chat.h);
            let limit = g.right;
            if (show.panel && g.panel.y < bottom) {
                limit = Math.min(limit, g.panel.x);
            }
            if (show.tabs && g.column.y < bottom) {
                limit = Math.min(limit, g.column.x);
            }
            if (show.map) {
                if (g.compass.y < bottom && g.compass.y + COMPASS > top) {
                    limit = Math.min(limit, g.compass.x);
                }
                const dy = Math.max(0, top - g.map.cy, g.map.cy - bottom); // from the minimap's centre to the chatbox's rows
                if (dy < g.map.r) {
                    limit = Math.min(limit, g.map.cx - Math.sqrt(g.map.r * g.map.r - dy * dy));
                }
            }
            const typingScale = Math.min(1, (limit - GAP - g.chat.x) / g.chat.w, (bottom - top) / g.chat.h);
            chatBox.style.top = `${bottom - g.chat.h}px`; // (scaled about its bottom left corner)
            chatBox.style.scale = typingScale < 1 ? String(typingScale) : '';
            typingTop = bottom - g.chat.h * typingScale;
        }

        // optional camera buttons, left middle above the chat or a dialogue's answers; hidden while those leave them no
        // room above (a long list of answers)
        const camera = el['hud-camera'];
        const above = show.dialog ? dialogTop : show.chat ? g.chat.y : g.bar.y - (show.lines ? CHAT_LINES * LINE_H : 0);
        const padTop = Math.max(v.safe.top + EDGE, Math.round((above - CAMERA_PAD.h) / 2));
        camera.hidden = !show.camera || padTop + CAMERA_PAD.h + GAP > above;
        if (!camera.hidden) {
            setBox(camera, g.left, padTop, CAMERA_PAD.w, CAMERA_PAD.h);
        }

        // what the client may use for windows and its own texts (viewport px): the leftmost HUD edge on the right at the
        // height of the world (the orbs only cover the top while no window is open; a panel opened over a window is
        // left out, so the window stays where it is), the chat at the bottom
        const size = renderSize(view);
        const coverRight = Math.min(panelOver ? g.column.x : g.coveredRight, show.map ? g.map.cx - g.map.r : g.right) - GAP;
        const coverBottom = typing
            ? typingTop
            : show.dialog
              ? dialogTop
              : show.chat
                ? g.chat.y + g.chat.h * (1 - chatScale)
                : show.bar
                  ? g.bar.y - (show.lines ? CHAT_LINES * LINE_H + 4 : 0)
                  : v.vh - v.safe.bottom;
        const insets = {
            left: Math.round(view.safe.left * size.scale),
            top: 0,
            right: Math.round((view.vw - coverRight * k) * size.scale),
            bottom: Math.round((view.vh - coverBottom * k) * size.scale)
        };
        const insetsKey = JSON.stringify(insets);
        if (insetsKey !== state.insetsKey) {
            state.insetsKey = insetsKey;
            api.client()?.setViewportInsets?.(insets);
        }
    }

    // A dialogue that offers a choice (an NPC's question, the ::~help list): its answers as finger-sized rows in the
    // chatbox's place. A tap answers through tapAt at the answer's own rect, exactly like a click on that line.
    function updateDialog(c, s) {
        // (answer lines only: a choice of item pictures, "What would you like to make?", stays in the chatbox, where a
        // hold on a picture still gives its Make 5 / 10 / X)
        const dialog = s.chatModal && typeof c.hudDialog === 'function' ? c.hudDialog() : null;
        const lines = Array.isArray(dialog?.options) && dialog.options.length >= 2 && dialog.options.every(o => o.h <= 32);
        const options = lines ? dialog.options : null;
        const key = options ? options.map(o => `${o.text}|${o.x},${o.y},${o.w},${o.h}`).join('\n') : '';
        if (key === state.dialogKey) {
            return;
        }
        state.dialogKey = key;
        state.dialog = options;
        const list = el['hud-dialog-options'];
        list.textContent = '';
        for (const option of options ?? []) {
            const row = document.createElement('button');
            row.className = 'dialog-option';
            row.setAttribute('role', 'menuitem');
            appendTagged(row, String(option.text));
            api.bindTapButton(row, () => c.tapAt?.(Math.round(option.x + option.w / 2), Math.round(option.y + option.h / 2), 1));
            list.append(row);
        }
    }

    // "Yes @red@(this is dangerous)": colour tags as menu.js reads them; the untagged start takes the row's colour
    function appendTagged(row, text) {
        const parts = text.split(/@([a-z0-9]{3})@/);
        let colour = null;
        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 1) {
                colour = TAG_COLOURS[parts[i]] ?? colour;
                continue;
            }
            if (parts[i]) {
                const part = document.createElement('span');
                part.textContent = parts[i].replace(/\x80/g, '€');
                if (colour) {
                    part.style.color = colour;
                }
                row.append(part);
            }
        }
    }

    // The chat filters fill the bar beside its buttons with their 2004 labels ("Public chat") where those fit, else with
    // short ones ("Public"); where even those do not (the panel open on a narrow screen) the filters give way until
    // there is room again. A label is never cut off. Measured, since the font decides: when the bar's width or a value
    // changes.
    function fitChatModes() {
        const bar = el['hud-chat-bar'];
        const modes = el['hud-chat-modes'];
        const width = state.modesWidth;
        modes.hidden = width <= 0;
        bar.style.width = width > 0 ? `${width}px` : '';
        if (width <= 0) {
            return;
        }
        const fits = () => el.chatModes.every(button => [...button.children].every(part => part.offsetWidth <= button.clientWidth));
        for (const short of [false, true]) {
            modes.classList.toggle('short', short);
            if (fits()) {
                return;
            }
        }
        modes.hidden = true;
        bar.style.width = '';
    }

    function closeMenuOf(s, area) {
        const c = api.client();
        const menu = s.menuOpen && s.menuArea === area ? c?.hudMenu?.() : null;
        if (menu) {
            c.hudMenuClose(menu.serial);
        }
    }

    function setBox(node, left, top, width, height) {
        Object.assign(node.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    }

    // ---------------------------------------------------------------------------------------------------- state

    function startLoop() {
        if (!state.rafId) {
            state.rafId = requestAnimationFrame(loop);
        }
    }

    function stopLoop() {
        if (state.rafId) {
            cancelAnimationFrame(state.rafId);
            state.rafId = 0;
        }
    }

    function loop() {
        state.rafId = 0;
        if (!state.active) {
            return;
        }
        update();
        state.rafId = requestAnimationFrame(loop);
    }

    function update() {
        const c = api.client();
        if (!state.active || typeof c?.hudState !== 'function') {
            return;
        }
        const s = c.hudState();
        const prev = state.hud;
        state.hud = s;

        // a new tutorial step shows the instructions again
        const tutorialKey = s.tutorialChat ? (s.tutorialKey ?? '') : null;
        if (tutorialKey !== state.tutorialKey) {
            if (state.tutorialCollapsed && tutorialKey !== null && state.tutorialKey !== null) {
                api.haptic('light');
            }
            state.tutorialKey = tutorialKey;
            state.tutorialCollapsed = false;
        }

        // the player's panel steps aside while the game needs the room, and comes back afterwards
        const yields = panelYields(s);
        const yielded = prev ? panelYields(prev) : false;
        if (yields && !yielded && state.panelOpen && !s.sideModal) {
            state.panelOpen = false;
            state.panelRestore = true;
        } else if (!yields && yielded && state.panelRestore) {
            state.panelOpen = true;
            state.panelRestore = false;
        }

        updateDialog(c, s);
        place(s); // (cheap unless something it depends on changed)

        // tap-to-drop: the client follows the button (also a client made anew); the inventory panel's frame shows it
        if (typeof s.tapToDrop === 'boolean' && s.tapToDrop !== state.tapDrop) {
            c.setTapToDrop?.(state.tapDrop);
        }
        setClass(el['hud-panel'], 'drop-mode', state.tapDrop && isTapDropShown(s));

        const panelShown = isPanelShown(s);
        for (const tab of el.tabs) {
            const index = Number(tab.dataset.tab);
            const available = s.tabs[index] === true;
            setClass(tab, 'unavailable', !available);
            setClass(tab, 'selected', available && panelShown && !s.sideModal && s.activeTab === index);
            setClass(tab, 'flashing', available && s.flashingTab === index);
        }

        let valuesChanged = false;
        for (let i = 0; i < 3; i++) {
            const button = el.chatModes[i];
            const mode = s.chatModes[i] ?? 0;
            const value = button.querySelector('.chat-value');
            const text = CHAT_MODE_VALUES[i][mode] ?? '';
            if (value.textContent !== text) {
                value.textContent = text;
                value.className = `chat-value ${CHAT_MODE_CLASS[mode] ?? ''}`;
                valuesChanged = true;
            }
        }
        if (valuesChanged && state.modesWidth > 0) {
            fitChatModes(); // ("Friends" is wider than "On")
        }

        updateOrbs(s);
        if (s.cameraYaw !== state.yaw && typeof s.cameraYaw === 'number') {
            state.yaw = s.cameraYaw;
            el.rose.style.transform = `rotate(${(s.cameraYaw * 360) / 2048}deg)`;
        }
        updateChatLines(c);
    }

    // Hitpoints, prayer and run energy: the number in the colour of how much is left (as the game's later orbs did).
    function updateOrbs(s) {
        const runButton = document.getElementById('btn-run');
        const energy = s.runExists ? `${s.runEnergy}%` : '';
        const key = [s.hp, s.hpMax, s.prayer, s.prayerMax, energy, s.running, api.isRunHeld(), s.runExists && !s.runAvailable, s.tabs[STATS_TAB], s.tabs[PRAYER_TAB]].join();
        if (key === state.orbsKey) {
            return;
        }
        state.orbsKey = key;
        setOrb(el['hp-value'], s.hp, s.hpMax);
        setOrb(el['prayer-value'], s.prayer, s.prayerMax);
        el['orb-hp'].hidden = !(s.hpMax > 0);
        el['orb-prayer'].hidden = !(s.prayerMax > 0);
        setClass(el['orb-hp'], 'unavailable', !s.tabs[STATS_TAB]);
        setClass(el['orb-prayer'], 'unavailable', !s.tabs[PRAYER_TAB]);
        el['run-energy'].textContent = energy;
        el['run-energy'].className = `orb-value ${s.runExists ? level(s.runEnergy, 100) : ''}`;
        setClass(runButton, 'active', s.running || api.isRunHeld());
        setClass(runButton, 'disabled', s.runExists && !s.runAvailable);
    }

    function setOrb(node, value, max) {
        const text = max > 0 ? String(value) : '';
        if (node.textContent !== text) {
            node.textContent = text;
        }
        node.className = `orb-value ${level(value, max)}`;
    }

    function level(value, max) {
        const f = max > 0 ? value / max : 0;
        return f >= 0.75 ? 'high' : f >= 0.5 ? 'mid' : f >= 0.25 ? 'low' : 'critical';
    }

    function setClass(node, name, on) {
        if (node.classList.contains(name) !== on) {
            node.classList.toggle(name, on);
        }
    }

    // The collapsed chat: the newest lines the chatbox would show, as text over the world (2004 colours made readable
    // on the 3D scene, with the game's 1 px black shadow).
    function updateChatLines(c) {
        if (el['hud-chat-lines'].hidden || typeof c.hudChatLines !== 'function') {
            return;
        }
        const lines = c.hudChatLines(CHAT_LINES);
        const key = lines.map(line => `${line.kind}|${line.sender}|${line.text}`).join('\n');
        if (key === state.linesKey) {
            return;
        }
        state.linesKey = key;
        const box = el['hud-chat-lines'];
        box.textContent = '';
        box.classList.remove('faded');
        clearTimeout(state.linesTimer);
        state.linesTimer = setTimeout(() => box.classList.add('faded'), LINES_FADE_MS);
        for (const line of lines.slice().reverse()) {
            const row = document.createElement('div');
            row.className = `chat-line ${line.kind}`;
            if (line.mod) {
                const crown = document.createElement('span');
                crown.className = `crown crown-${line.mod}`;
                row.append(crown);
            }
            if (line.kind === 'private-from') {
                row.append(span('who', `From ${line.sender}: `), span('msg', line.text));
            } else if (line.kind === 'private-to') {
                row.append(span('who', `To ${line.sender}: `), span('msg', line.text));
            } else if (line.kind === 'public') {
                row.append(span('who', `${line.sender}: `), span('msg', line.text));
            } else if (line.kind === 'trade' || line.kind === 'duel') {
                row.append(span('msg', `${line.sender} ${line.text}`));
            } else {
                row.append(span('msg', line.text));
            }
            box.append(row);
        }
    }

    function span(className, text) {
        const node = document.createElement('span');
        node.className = className;
        node.textContent = text.replace(/\x80/g, '€'); // the game's euro byte; WebKit draws no U+0080
        return node;
    }

    const hud = {
        layout,
        setEnabled,
        toggleRun,
        escape,
        get active() {
            return state.active;
        }
    };

    window.__lcHud = { init };
})();
