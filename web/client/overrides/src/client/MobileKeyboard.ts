// LostCity iOS port: whole-module override of src/client/MobileKeyboard.ts.
//
// Same default-export surface as upstream (show/hide/draw/isDisplayed/isWithinCanvasKeyboard/captureMouseDown/
// captureMouseUp/notifyTouchMove), but:
//  - with the iOS host page (globalThis.lcHost.keyboard), show()/hide()/isDisplayed() delegate to it. The host asks
//    Swift to raise its own keyboard, which works outside a user gesture too (WKWebView ignores input.focus() from
//    timers/packet handlers, e.g. the server-initiated amount dialog), and it decides the context (chat, login
//    user/pass, amount, social, report) by inspecting the client (ARCHITECTURE.md §6/§7);
//  - without a host (desktop testing), a hidden <input type=text> is focused and its keys are re-dispatched to the
//    canvas. Upstream's <input type=password> brought up iOS's password AutoFill bar.
//  - the on-canvas QWERTY (used upstream only in fullscreen) is gone: isWithinCanvasKeyboard() is always false.
// Which game situations call show()/hide() is decided by Client (patch "keyboard-follows-input").
import { canvas } from '#/graphics/Canvas.js';

import { lcKeyboard } from '#/client/LcHost.js';

// Keys the canvas must see as named keys even though they are not printable (GameShell maps them via KeyCodes).
const NAMED_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Control', 'Shift']);

// Desktop-testing fallback: a 1x1 transparent text field that forwards its keys to the canvas.
class DomKeyboard {
    private input: HTMLInputElement | null = null;

    private element(): HTMLInputElement {
        if (this.input) {
            return this.input;
        }

        const input = document.createElement('input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('aria-hidden', 'true');
        // 16px font: iOS Safari zooms the page into smaller focused fields
        input.setAttribute('style', 'position: fixed; top: 0px; left: 0px; width: 1px; height: 1px; opacity: 0; font-size: 16px; border: 0; padding: 0;');

        const forward = (type: 'keydown' | 'keyup') => (ev: KeyboardEvent): void => {
            if (ev.key.length !== 1 && !NAMED_KEYS.has(ev.key)) {
                return; // 'Unidentified', 'Process' (IME), ...
            }
            // GameShell drops untrusted key events with an empty `code`, so always set it (upstream does the same)
            canvas.dispatchEvent(new KeyboardEvent(type, { key: ev.key, code: ev.key, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey }));
            if (ev.key === 'Tab' || ev.key === 'Enter') {
                ev.preventDefault();
            }
        };
        input.addEventListener('keydown', forward('keydown'));
        input.addEventListener('keyup', forward('keyup'));
        input.addEventListener('input', () => {
            input.value = ''; // the characters already went to the canvas
        });

        document.body.appendChild(input);
        this.input = input;
        return input;
    }

    show(clientX?: number, clientY?: number): void {
        const input = this.element();
        if (typeof clientX === 'number' && typeof clientY === 'number') {
            input.style.left = `${clientX}px`;
            input.style.top = `${clientY}px`;
        }
        input.focus({ preventScroll: true });
    }

    hide(): void {
        if (this.input && document.activeElement === this.input) {
            this.input.blur();
            canvas.focus({ preventScroll: true });
        }
    }

    isDisplayed(): boolean {
        return this.input !== null && document.activeElement === this.input;
    }
}

class MobileKeyboard {
    private readonly dom = new DomKeyboard();

    public show(originX?: number, originY?: number, clientX?: number, clientY?: number) {
        const host = lcKeyboard();
        if (host) {
            try {
                host.show();
            } catch (e) {
                console.error(e);
            }
            return;
        }

        this.dom.show(clientX ?? originX, clientY ?? originY);
    }

    public hide() {
        const host = lcKeyboard();
        if (host) {
            try {
                host.hide();
            } catch (e) {
                console.error(e);
            }
            return;
        }

        this.dom.hide();
    }

    public draw() {
        // nothing: no on-canvas keyboard
    }

    public isDisplayed(): boolean {
        const host = lcKeyboard();
        if (host) {
            try {
                return host.isShown() === true;
            } catch (e) {
                console.error(e);
                return false;
            }
        }

        return this.dom.isDisplayed();
    }

    public isWithinCanvasKeyboard(_x: number, _y: number): boolean {
        return false;
    }

    public captureMouseUp(_x: number, _y: number): boolean {
        return false;
    }

    public captureMouseDown(_x: number, _y: number): boolean {
        return false;
    }

    public notifyTouchMove(_x: number, _y: number): void {}
}

export default new MobileKeyboard();
