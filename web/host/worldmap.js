// LostCity iOS host page: the World map window.
//
// The globe on the minimap's ring (hud.js) opens it: a stone-framed sheet like Settings, over the world (the game runs
// on behind it). The map is the 2004 map applet with touch controls (client/mapview.js, client patch 0018) in an
// iframe of its own, mapview.html: made at the first opening (it takes a moment to draw the world once) and kept, its
// loop asleep while the window is closed. The header has the Key (a list of the map's icons; a tap flashes them all,
// gliding to the nearest when none is in view), the applet's Overview, the Surface / Underground maps, a button that
// centres the map on the player, and Close. The player's tile goes to the map while the window is open. On a memory
// warning a closed map gives up its iframe.
// Loaded after host.js, which calls window.__lcWorldMap.init(api) at boot.
(() => {
    'use strict';

    const PLAYER_POLL_MS = 300;

    let api = null;
    const el = {};

    const state = {
        open: false,
        frame: null, // the map's iframe, made at the first opening
        ready: false, // the map has loaded
        loading: false,
        area: -1, // 0 surface, 1 underground, 2 other places
        keys: [], // [{ index, name }] of the map shown
        keysArea: -1,
        selectedKey: -1,
        showKey: false,
        showOverview: false,
        tile: null, // the player's last tile sent to the map
        poll: 0
    };

    function init(hostApi) {
        api = hostApi;
        for (const id of ['worldmap', 'worldmap-body', 'worldmap-key', 'worldmap-overview', 'worldmap-area', 'worldmap-me', 'worldmap-close', 'worldmap-keys']) {
            el[id] = document.getElementById(id);
        }
        el.areas = [...el['worldmap-area'].querySelectorAll('button[data-area]')];

        el['worldmap-close'].addEventListener('click', close);
        api.bindTapButton(el['worldmap-key'], () => {
            state.showKey = !state.showKey;
            api.haptic('selection');
            refresh();
        });
        api.bindTapButton(el['worldmap-overview'], () => {
            state.showOverview = !state.showOverview;
            api.haptic('selection');
            post({ lcMap: 'overview', on: state.showOverview });
            refresh();
        });
        for (const button of el.areas) {
            api.bindTapButton(button, () => {
                const area = Number(button.dataset.area);
                if (area !== state.area) {
                    api.haptic('selection');
                    state.selectedKey = -1;
                    post({ lcMap: 'area', area });
                }
            });
        }
        api.bindTapButton(el['worldmap-me'], () => {
            api.haptic('selection');
            post({ lcMap: 'centre' });
        });

        // a tap beside the sheet closes it
        const overlay = el.worldmap;
        let backdropPressed = false;
        overlay.addEventListener('pointerdown', event => {
            backdropPressed = event.target === overlay;
        });
        overlay.addEventListener('click', event => {
            if (event.target === overlay && backdropPressed) {
                close();
            }
            backdropPressed = false;
        });

        window.addEventListener('message', onMessage);
        return worldMap;
    }

    function playerTile() {
        const tile = api.client()?.hudPlayerTile?.();
        return tile && Number.isFinite(tile.x) && Number.isFinite(tile.z) ? { x: tile.x, z: tile.z } : null;
    }

    function open() {
        if (state.open) {
            return;
        }
        state.open = true;
        el.worldmap.hidden = false;
        const tile = playerTile();
        state.tile = tile;
        if (!state.frame) {
            const frame = document.createElement('iframe');
            frame.id = 'worldmap-frame';
            frame.title = 'World map';
            frame.tabIndex = -1;
            frame.src = tile ? `mapview.html?x=${tile.x}&z=${tile.z}` : 'mapview.html';
            el['worldmap-body'].prepend(frame);
            state.frame = frame;
        } else {
            post({ lcMap: 'show', player: tile });
        }
        clearInterval(state.poll);
        state.poll = setInterval(pollPlayer, PLAYER_POLL_MS);
        refresh();
    }

    function close() {
        if (!state.open) {
            return;
        }
        state.open = false;
        el.worldmap.hidden = true;
        clearInterval(state.poll);
        state.poll = 0;
        post({ lcMap: 'pause' });
    }

    // iOS is short of memory: a closed map gives up its iframe (made again at the next opening)
    function release() {
        if (state.open || !state.frame) {
            return;
        }
        state.frame.remove();
        state.frame = null;
        state.ready = false;
        state.loading = false;
        state.area = -1;
        state.keys = [];
        state.selectedKey = -1;
        buildKeys();
        refresh();
    }

    function pollPlayer() {
        const tile = playerTile();
        if (tile && (tile.x !== state.tile?.x || tile.z !== state.tile?.z)) {
            state.tile = tile;
            post({ lcMap: 'player', x: tile.x, z: tile.z });
        }
    }

    function post(message) {
        state.frame?.contentWindow?.postMessage(message, '*');
    }

    function onMessage(event) {
        if (!state.frame || event.source !== state.frame.contentWindow) {
            return;
        }
        const data = event.data;
        if (data?.lcMap === 'state') {
            const wasReady = state.ready;
            state.ready = data.ready === true;
            state.loading = data.loading === true;
            state.area = typeof data.area === 'number' ? data.area : -1;
            if (state.ready && !wasReady && state.showOverview) {
                post({ lcMap: 'overview', on: true });
            }
            refresh();
        } else if (data?.lcMap === 'keys' && Array.isArray(data.keys)) {
            state.keys = data.keys.filter(k => Number.isInteger(k?.index) && typeof k.name === 'string');
            state.keysArea = data.area;
            if (!state.keys.some(k => k.index === state.selectedKey)) {
                state.selectedKey = -1;
            }
            buildKeys();
            refresh();
        }
    }

    // the Key: one row per kind of icon on the map shown, its icon and name
    function buildKeys() {
        const list = el['worldmap-keys'];
        list.textContent = '';
        for (const key of state.keys) {
            const row = document.createElement('button');
            row.className = 'worldmap-key-row';
            row.dataset.key = String(key.index);
            const icon = document.createElement('span');
            icon.className = 'worldmap-key-icon';
            icon.style.backgroundImage = `url(ui/sprites/mapfunction-${key.index}.png)`;
            const name = document.createElement('span');
            name.className = 'worldmap-key-name';
            name.textContent = key.name;
            row.append(icon, name);
            row.addEventListener('click', () => {
                state.selectedKey = key.index;
                api.haptic('selection');
                post({ lcMap: 'key', index: key.index });
                refresh();
            });
            list.append(row);
        }
    }

    function refresh() {
        setOn(el['worldmap-key'], state.showKey);
        setOn(el['worldmap-overview'], state.showOverview);
        for (const button of el.areas) {
            setOn(button, Number(button.dataset.area) === state.area);
        }
        el['worldmap-keys'].hidden = !state.showKey;
        for (const row of el['worldmap-keys'].children) {
            setOn(row, Number(row.dataset.key) === state.selectedKey);
        }
        el.worldmap.classList.toggle('loading', !state.ready || state.loading);
    }

    function setOn(node, on) {
        if (node.classList.contains('on') !== on) {
            node.classList.toggle('on', on);
        }
        if (node.hasAttribute('aria-pressed') && node.getAttribute('aria-pressed') !== String(on)) {
            node.setAttribute('aria-pressed', String(on));
        }
    }

    const worldMap = {
        open,
        close,
        release,
        get isOpen() {
            return state.open;
        }
    };

    window.__lcWorldMap = { init };
})();
