// LostCity iOS port: typed, failure-proof access to the host page's `globalThis.lcHost`
// (contract: docs/ARCHITECTURE.md §6). New module (no upstream counterpart), imported by the iOS
// overrides and patches. Every member is optional: without a host the client behaves like upstream.
//
// Host calls are wrapped so that a bug in host.js can never throw into the game loop or an input handler.

export type HapticStyle = 'light' | 'medium' | 'heavy' | 'selection';

export interface LcHostSettings {
    stayLoggedIn?: boolean;
    longPressMs?: number;
    cameraSensitivity?: number;
}

export interface LcHostKeyboard {
    show(): void;
    hide(): void;
    isShown(): boolean;
}

export interface LcHost {
    keyboard?: LcHostKeyboard;
    haptic?(style: HapticStyle): void;
    takeSecondaryClick?(): boolean;
    settings?: LcHostSettings;
    onClientEvent?(name: string, detail?: unknown): void;
}

export function lcHost(): LcHost | null {
    const host = (globalThis as { lcHost?: LcHost }).lcHost;
    return host && typeof host === 'object' ? host : null;
}

// Settings are read live (the host may change them at runtime); a missing or mistyped value yields `fallback`.
export function lcSetting<K extends keyof LcHostSettings>(key: K, fallback: NonNullable<LcHostSettings[K]>): NonNullable<LcHostSettings[K]> {
    try {
        const value = lcHost()?.settings?.[key];
        if (typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value))) {
            return value as NonNullable<LcHostSettings[K]>;
        }
    } catch (e) {
        console.error(e);
    }
    return fallback;
}

export function lcHaptic(style: HapticStyle): void {
    try {
        lcHost()?.haptic?.(style);
    } catch (e) {
        console.error(e);
    }
}

// True (once) if the player armed the host's "right-click" mode: the next tap clicks with button 2.
export function lcTakeSecondaryClick(): boolean {
    try {
        return lcHost()?.takeSecondaryClick?.() === true;
    } catch (e) {
        console.error(e);
        return false;
    }
}

export function lcEvent(name: string, detail?: unknown): void {
    try {
        lcHost()?.onClientEvent?.(name, detail);
    } catch (e) {
        console.error(e);
    }
}

// The host's keyboard bridge, or null (then MobileKeyboard falls back to a hidden DOM input).
export function lcKeyboard(): LcHostKeyboard | null {
    try {
        const kb = lcHost()?.keyboard;
        return kb && typeof kb.show === 'function' && typeof kb.hide === 'function' ? kb : null;
    } catch {
        return null;
    }
}
