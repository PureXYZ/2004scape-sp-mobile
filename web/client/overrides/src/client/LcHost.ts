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

// Online (docs/ONLINE.md): the game server the page plays on; null offline.
export interface LcHostServer {
    id?: string;
    url?: string;
    nodeId?: number;
    members?: boolean;
    rsa?: { n: string; e: string } | null; // its login key, decimal; null: the build-time key
}

export interface LcHost {
    keyboard?: LcHostKeyboard;
    haptic?(style: HapticStyle): void;
    takeSecondaryClick?(): boolean;
    settings?: LcHostSettings;
    onClientEvent?(name: string, detail?: unknown): void;
    platform?: string;
    server?: LcHostServer | null;
    openSocket?(purpose: string): WebSocket | null;
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

// Which app the page runs in, as the host learns it from the app (window.LostCityNative.platform): 'ios', 'android', or
// 'web' without an app (desktop tests) or without a host.
export function lcPlatform(): string {
    try {
        const platform = lcHost()?.platform;
        return typeof platform === 'string' ? platform : 'web';
    } catch {
        return 'web';
    }
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

// Online: the game server the page plays on (LocalOnDemand fetches from it what the bundled cache does not hold);
// null offline, and without a host.
export function lcServer(): LcHostServer | null {
    try {
        const server = lcHost()?.server;
        return server && typeof server === 'object' ? server : null;
    } catch {
        return null;
    }
}

// Online: the server's login key as BigInts (patch 30), from lcHost.server.rsa; null offline and for a server with
// no key of its own, when the client uses the build-time key.
export function lcLoginKey(): { n: bigint; e: bigint } | null {
    try {
        const rsa = lcServer()?.rsa;
        if (rsa && typeof rsa.n === 'string' && typeof rsa.e === 'string' && /^\d+$/.test(rsa.n) && /^\d+$/.test(rsa.e)) {
            return { n: BigInt(rsa.n), e: BigInt(rsa.e) };
        }
    } catch (e) {
        console.error(e);
    }
    return null;
}

// Online: a socket to the game server through the host (its socket bridge, for LocalOnDemand's remote files); null
// offline. It opens like a WebSocket: 'open', then 'message's, or 'error' and 'close'.
export function lcOpenSocket(purpose: string): WebSocket | null {
    try {
        return lcHost()?.openSocket?.(purpose) ?? null;
    } catch (e) {
        console.error(e);
        return null;
    }
}
