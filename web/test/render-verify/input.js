// render-verify: touches as synthetic pointer events (pointerType 'touch'), for the WebKit host, which has no CDP
// input. The client's and the HUD's handlers take them as they take a finger's: pointerdown on the element under the
// point, moves and the release on that element (what pointer capture gives a real finger), a click after a tap.
// window.__rvInput.down(x, y, id) / move(x, y, id) / up(x, y, id) / tap(x, y, holdMs) (CSS px of the page)
(() => {
    if (window.__rvInput) return;
    const targets = new Map(); // pointerId -> { el, x0, y0, moved }
    let primary = null;
    const ev = (type, el, x, y, id, buttons) =>
        el.dispatchEvent(
            new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === primary, clientX: x, clientY: y, screenX: x, screenY: y, button: type === 'pointermove' ? -1 : 0, buttons, width: 20, height: 20, pressure: buttons ? 0.5 : 0, bubbles: true, cancelable: true, composed: true })
        );
    const I = (window.__rvInput = {
        down(x, y, id = 1) {
            const el = document.elementFromPoint(x, y) ?? document.body;
            if (primary === null) primary = id;
            targets.set(id, { el, x0: x, y0: y, moved: false });
            ev('pointerover', el, x, y, id, 0);
            ev('pointerenter', el, x, y, id, 0);
            ev('pointerdown', el, x, y, id, 1);
            return el.id || el.tagName;
        },
        move(x, y, id = 1) {
            const t = targets.get(id);
            if (!t) return false;
            if (Math.hypot(x - t.x0, y - t.y0) > 8) t.moved = true;
            ev('pointermove', t.el, x, y, id, 1);
            return true;
        },
        up(x, y, id = 1) {
            const t = targets.get(id);
            if (!t) return false;
            targets.delete(id);
            ev('pointerup', t.el, x, y, id, 0);
            ev('pointerout', t.el, x, y, id, 0);
            ev('pointerleave', t.el, x, y, id, 0);
            if (id === primary) primary = null;
            if (!t.moved) {
                const under = document.elementFromPoint(x, y);
                const el = under && (t.el.contains(under) || under.contains(t.el)) ? (t.el.contains(under) ? under : t.el) : t.el;
                el.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, detail: 1 }));
            }
            return true;
        },
        async tap(x, y, holdMs = 60, id = 1) {
            I.down(x, y, id);
            await new Promise(r => setTimeout(r, holdMs));
            I.up(x, y, id);
        }
    });
})();
