// LostCity iOS host page: the options menu ("Choose Option") for fingers.
//
// The 2004 menu has 15 px rows, and on a phone a long-press opened it under the finger. With setHostMenus(true) (client
// patch 0012) the client leaves the open menu to the host: this file shows it as a large menu in the same look (the
// menu's brown, its black title bar, the bold font and colour tags) beside the finger, never under it, with the top
// option level with the finger:
//   - press-drag-release: the menu opens while the long-press is held; sliding onto an option highlights it and lifting
//     there picks it. Lifting without having slid onto one leaves it open;
//   - tap: a tap on an option picks it, a tap beside the menu closes it (like a click beside the 2004 menu).
// Picks and closes go back to the client by the menu's serial (hudMenuSelect / hudMenuClose), so a late tap can never
// pick from a menu that has meanwhile changed. Used in both layouts. Loaded after host.js, which calls
// window.__lcMenu.init(api) at boot and forwards the client's 'menu-open' / 'menu-close' events.
//
// Also the action label (client patch 0020's 'action-label' event): what a tap just did ("Take Shrimps") as one row in
// the menu's look beside where it was done (the red cross, or the item tapped), fading out over a second.
(() => {
    'use strict';

    // the PixFont colour tags (Colour.ts)
    const TAG_COLOURS = {
        red: '#ff0000', gre: '#00ff00', blu: '#0000ff', yel: '#ffff00', cya: '#00ffff', mag: '#ff00ff', whi: '#ffffff', bla: '#000000',
        lre: '#ff9040', dre: '#800000', dbl: '#000080', or1: '#ffb000', or2: '#ff7000', or3: '#ff3000', gr1: '#c0ff00', gr2: '#80ff00', gr3: '#40ff00'
    };

    const ROW_H = 40; // CSS px per option: a finger-sized row around the game's 15 px line
    const ROW_H_MIN = 34; // rows shrink to this for a long menu before it scrolls
    const TITLE_H = 21;
    const GAP = 24; // between the finger and the menu's near edge
    const EDGE = 6; // to the edges of the safe area
    const SLIDE = 8; // px a held finger must move before lifting it can pick
    const LABEL_MS = 1000; // the action label's fade (host.css action-label-fade)

    let api = null;
    let layer = null;
    let box = null;
    let list = null;
    let labelLayer = null;
    let labelBox = null;

    const state = {
        serial: 0, // the menu shown, 0 = none
        drag: null, // { pointerId, x0, y0, moved } the finger that opened the menu with a long-press, still down
        active: -1, // highlighted option
        tapRow: -1, // option a tap went down on
        downOnLayer: new Set() // pointers that went down beside the menu
    };
    const pointers = new Map(); // touch/pen/mouse pointers down anywhere: id -> {x, y, type}
    let lastDown = null; // { x, y, time } of the newest pointerdown

    function init(hostApi) {
        api = hostApi;
        layer = document.getElementById('menu-layer');
        box = document.getElementById('menu');
        list = document.getElementById('menu-options');
        labelLayer = document.getElementById('label-layer');
        labelBox = document.getElementById('action-label');
        labelBox?.addEventListener('animationend', hideLabel);

        // Where fingers are, from any element (the menu opens beside the one that long-pressed). Capture phase on the
        // window, so nothing in the page can hide them; the events themselves are left alone.
        window.addEventListener('pointerdown', event => {
            if (event.isPrimary) {
                // the first finger (or the mouse) down: no other pointer of its kind is, so one still recorded lost its
                // pointerup or pointercancel (the menu must not open beside it, nor take it for the held finger)
                for (const [id, pointer] of pointers) {
                    if (pointer.type === event.pointerType) {
                        pointers.delete(id);
                    }
                }
                if (state.drag && !pointers.has(state.drag.pointerId)) {
                    state.drag = null;
                    setActive(-1);
                }
            }
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
            lastDown = { x: event.clientX, y: event.clientY, time: performance.now() };
        }, true);
        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('pointercancel', event => {
            pointers.delete(event.pointerId);
            state.downOnLayer.delete(event.pointerId);
            if (state.drag?.pointerId === event.pointerId) {
                state.drag = null;
                setActive(-1);
            }
        }, true);

        layer.addEventListener('pointerdown', event => {
            if (event.target === layer) {
                state.downOnLayer.add(event.pointerId);
            }
        });
        list.addEventListener('pointerdown', event => {
            const row = event.target.closest?.('.menu-option');
            state.tapRow = row ? Number(row.dataset.index) : -1;
            setActive(state.tapRow);
        });
        for (const node of [layer, box]) {
            node.addEventListener('contextmenu', event => event.preventDefault());
            // no synthesized click / mouse events after a touch: they would land on whatever is under the menu
            node.addEventListener('touchend', event => event.preventDefault(), { passive: false });
        }
        return menu;
    }

    // ---------------------------------------------------------------------------------------------------- show / hide

    function show(detail) {
        const serial = Number(detail?.serial) || 0;
        const options = Array.isArray(detail?.options) ? detail.options : [];
        if (!serial || options.length === 0) {
            return;
        }
        state.serial = serial;
        state.active = -1;
        state.tapRow = -1;
        state.downOnLayer.clear();
        hideLabel();

        list.textContent = '';
        options.forEach((option, index) => {
            const row = document.createElement('div');
            row.className = 'menu-option';
            row.dataset.index = String(index);
            row.setAttribute('role', 'menuitem');
            appendTagged(row, String(option));
            list.append(row);
        });

        // The finger that long-pressed, still down (the client names it; -1: none, e.g. the menu button's tap; a client
        // that does not say: the newest finger down), or else where the last one went down.
        const named = Number.isInteger(detail.pointerId) ? detail.pointerId : [...pointers.keys()].at(-1) ?? -1;
        const heldId = named >= 0 && pointers.has(named) ? named : null;
        const anchor = heldId !== null ? pointers.get(heldId) : lastDown ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        state.drag = heldId !== null ? { pointerId: heldId, x0: anchor.x, y0: anchor.y, moved: false } : null;

        layer.hidden = false;
        place(anchor, options.length);
        box.classList.remove('opening');
        void box.offsetWidth; // restart the opening animation
        box.classList.add('opening');
        api.haptic('medium'); // the menu is there (also confirms a long-press)
    }

    function hide() {
        if (!state.serial) {
            return;
        }
        state.serial = 0;
        state.drag = null;
        state.active = -1;
        state.downOnLayer.clear();
        layer.hidden = true;
        // The rows stay in the page (hidden) until the next menu replaces them. A tap picks in its pointerup, and its
        // touchend comes after that: a row taken out of the page would get that touchend alone, past the handler that
        // cancels it, and iOS would then click whatever is under the finger: the world, which walked there and so
        // cancelled the option just picked.
    }

    // The layer's own px (it is zoomed with the HUD on a large screen): its size and the safe area's bounds in it.
    function frame() {
        const z = api.zoom?.() || 1;
        const vw = window.innerWidth / z;
        const vh = window.innerHeight / z;
        const safe = api.safeArea();
        return { z, vw, minX: safe.left / z + EDGE, maxX: vw - safe.right / z - EDGE, minY: safe.top / z + EDGE, maxY: vh - safe.bottom / z - EDGE };
    }

    // The left edge for a box `width` wide beside a point at x, GAP from it on the side with more room (the left on the
    // screen's right half, where it fits), kept within the frame.
    function besideX(x, width, f) {
        const right = x + GAP + width <= f.maxX;
        const left = x - GAP - width >= f.minX;
        const at = x > f.vw / 2 ? (left ? x - GAP - width : x + GAP) : right ? x + GAP : x - GAP - width;
        return Math.min(Math.max(at, f.minX), f.maxX - width);
    }

    // Beside the finger on the side with more room, the top option level with it; kept inside the safe area. Rows
    // shrink for a long menu, which scrolls if it still does not fit.
    function place(finger, count) {
        const f = frame();
        const anchor = { x: finger.x / f.z, y: finger.y / f.z };

        const rowH = Math.max(ROW_H_MIN, Math.min(ROW_H, Math.floor((f.maxY - f.minY - TITLE_H - 4) / count)));
        box.style.setProperty('--row', `${rowH}px`);
        box.style.left = '0px';
        box.style.top = '0px';
        box.style.maxHeight = `${f.maxY - f.minY}px`;
        const width = Math.ceil(box.offsetWidth);
        const height = Math.ceil(box.offsetHeight);

        const x = besideX(anchor.x, width, f);
        let y = anchor.y - TITLE_H - rowH / 2;
        y = Math.min(Math.max(y, f.minY), f.maxY - height);
        box.style.left = `${Math.round(x)}px`;
        box.style.top = `${Math.round(y)}px`;
        box.style.transformOrigin = `${anchor.x < x ? 0 : width}px ${Math.round(anchor.y - y)}px`;
    }

    // ---------------------------------------------------------------------------------------------------- action label

    // { text, x, y } from the client (page px): the row beside that point like the menu, level with it, fading out.
    // It never takes a touch (the layer has no pointer events) and the next one replaces it; none while a menu is open.
    function label(detail) {
        const text = String(detail?.text ?? '');
        const px = Number(detail?.x);
        const py = Number(detail?.y);
        if (!labelBox || state.serial || !text || !Number.isFinite(px) || !Number.isFinite(py)) {
            return;
        }
        labelBox.textContent = '';
        appendTagged(labelBox, text);
        labelLayer.hidden = false;

        const f = frame();
        const anchor = { x: px / f.z, y: py / f.z };
        labelBox.style.left = '0px';
        labelBox.style.top = '0px';
        const width = Math.ceil(labelBox.offsetWidth);
        const height = Math.ceil(labelBox.offsetHeight);
        const x = besideX(anchor.x, width, f);
        const y = Math.min(Math.max(anchor.y - height / 2, f.minY), f.maxY - height);
        labelBox.style.left = `${Math.round(x)}px`;
        labelBox.style.top = `${Math.round(y)}px`;
        labelBox.style.transformOrigin = `${anchor.x < x ? 0 : width}px 50%`;
        labelBox.style.animationDuration = `${LABEL_MS}ms`;
        labelBox.classList.remove('fading');
        void labelBox.offsetWidth; // restart the fade
        labelBox.classList.add('fading');
    }

    function hideLabel() {
        if (labelLayer && !labelLayer.hidden) {
            labelLayer.hidden = true;
            labelBox.classList.remove('fading');
        }
    }

    // "Attack @yel@Goblin @gre@(level-2)": the untagged start takes the row's colour (white, yellow when highlighted)
    function appendTagged(row, text) {
        const parts = text.split(/@([a-z0-9]{3})@/);
        let colour = null;
        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 1) {
                if (parts[i] in TAG_COLOURS) {
                    colour = TAG_COLOURS[parts[i]];
                }
                continue;
            }
            if (!parts[i]) {
                continue;
            }
            const span = document.createElement('span');
            span.textContent = parts[i].replace(/\x80/g, '€');
            if (colour) {
                span.style.color = colour;
            } else {
                span.className = 'base';
            }
            row.append(span);
        }
    }

    // ---------------------------------------------------------------------------------------------------- picking

    function setActive(index) {
        if (index === state.active) {
            return;
        }
        state.active = index;
        for (const row of list.children) {
            row.classList.toggle('active', Number(row.dataset.index) === index);
        }
    }

    function optionAt(x, y) {
        const node = document.elementFromPoint(x, y);
        const row = node?.closest?.('#menu .menu-option');
        return row ? Number(row.dataset.index) : -1;
    }

    function onPointerMove(event) {
        if (pointers.has(event.pointerId)) {
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
        }
        const drag = state.drag;
        if (!state.serial || !drag || drag.pointerId !== event.pointerId) {
            return;
        }
        if (!drag.moved && Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) >= SLIDE) {
            drag.moved = true;
        }
        if (drag.moved) {
            const index = optionAt(event.clientX, event.clientY);
            if (index !== state.active && index !== -1) {
                api.haptic('selection');
            }
            setActive(index);
        }
    }

    function onPointerUp(event) {
        pointers.delete(event.pointerId);
        if (!state.serial) {
            state.downOnLayer.delete(event.pointerId);
            return;
        }
        const drag = state.drag;
        if (drag?.pointerId === event.pointerId) {
            // the long-press finger lifted: pick what it slid onto, else leave the menu open for a tap
            state.drag = null;
            const index = drag.moved ? optionAt(event.clientX, event.clientY) : -1;
            if (index !== -1) {
                pick(index);
            } else {
                setActive(-1);
            }
            return;
        }
        if (state.downOnLayer.delete(event.pointerId)) {
            if (event.target === layer || optionAt(event.clientX, event.clientY) === -1) {
                close();
            }
            return;
        }
        if (state.tapRow !== -1) {
            const index = optionAt(event.clientX, event.clientY);
            state.tapRow = -1;
            if (index !== -1 && index === state.active) {
                pick(index);
            } else {
                setActive(-1);
            }
        }
    }

    function pick(index) {
        const serial = state.serial;
        api.haptic('light');
        hide();
        api.client()?.hudMenuSelect?.(serial, index);
    }

    function close() {
        const serial = state.serial;
        if (!serial) {
            return;
        }
        hide();
        api.client()?.hudMenuClose?.(serial);
    }

    const menu = {
        show,
        hide,
        close,
        label,
        hideLabel,
        get open() {
            return state.serial !== 0;
        }
    };

    window.__lcMenu = { init };
})();
