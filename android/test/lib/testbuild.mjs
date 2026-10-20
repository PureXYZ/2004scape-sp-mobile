// Test builds of the Android app (android/test/app-test.mjs, drive.mjs, all.mjs): Gradle, the APK's entries, and a test
// variant of the web bundle built into an APK without leaving it where a normal build or another test picks it up.
//
// The app's assets are android/build/web/Game (Gradle's buildWeb writes it; -PnoBuildWeb takes it as it is) and the
// debug APK is app/build/outputs/apk/debug/app-debug.apk, which smoke/keyboard/shell/lm --no-build install. A test
// variant (the self-playing autotest bundle, the native-layer test page) goes through both. So buildTestApk() moves the
// normal bundle and copies the normal APK aside first, builds the test APK, copies it to the test's own folder, and puts
// the normal bundle and APK back before the test even runs: the window in which either path holds a test variant is the
// Gradle build itself. A build stopped half-way (Ctrl-C) is put right by the next call (recoverStash).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ADB } from './adb.mjs';

export const ANDROID = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const REPO = path.dirname(ANDROID);
export const WEB_GAME = path.join(ANDROID, 'build', 'web', 'Game');
export const DEBUG_APK = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const STASH = path.join(ANDROID, 'build', 'test-stash');
const STASH_GAME = path.join(STASH, 'Game');
const STASH_APK = path.join(STASH, 'app-debug.apk');

/** The toolchain the task's Mac uses, unless the caller's environment names its own. */
export const GRADLE_ENV = {
    ...process.env,
    JAVA_HOME: process.env.JAVA_HOME ?? '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    ANDROID_HOME: process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`
};

/** ./gradlew in android/, quiet, its output on this terminal; throws when the build fails. */
export function gradle(...args) {
    console.log(`gradle ${args.join(' ')}…`);
    execFileSync(path.join(ANDROID, 'gradlew'), [...args, '--console=plain', '-q'], { cwd: ANDROID, stdio: 'inherit', env: GRADLE_ENV });
}

/** The APK's entry names. */
export function apkEntries(apk) {
    return execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8', maxBuffer: 16 << 20 }).split('\n').filter(Boolean);
}

/** One entry's bytes, or null if the APK has no such entry. */
export function apkFile(apk, entry) {
    try {
        return execFileSync('unzip', ['-p', apk, entry], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return null;
    }
}

// What marks a test variant: the autotest run (build-web.mjs --autotest), the native-layer test page (drive.mjs), or
// lctest.json, which every test bundle built here carries.
const TEST_MARKS = ['autotest.js', 'test.js', 'lctest.json'];

/** True if the bundle folder is a test variant (or not a bundle at all). */
export function isTestBundle(dir = WEB_GAME) {
    return TEST_MARKS.some(name => fs.existsSync(path.join(dir, name)));
}

/** True if the APK's web bundle is a test variant. */
export function isTestApk(apk) {
    const entries = new Set(apkEntries(apk));
    return TEST_MARKS.some(name => entries.has(`assets/Game/${name}`));
}

/** The normal debug APK, if app/build/outputs has one (not a test variant), else null. */
export function normalApk() {
    return fs.existsSync(DEBUG_APK) && !isTestApk(DEBUG_APK) ? DEBUG_APK : null;
}

/** Puts back what an interrupted buildTestApk() moved aside. */
export function recoverStash() {
    if (fs.existsSync(STASH_GAME)) {
        console.log('(an earlier test build stopped half-way: putting the normal web bundle back)');
        fs.rmSync(WEB_GAME, { recursive: true, force: true });
        fs.renameSync(STASH_GAME, WEB_GAME);
    }
    if (fs.existsSync(STASH_APK)) {
        console.log('(an earlier test build stopped half-way: putting the normal debug APK back)');
        fs.copyFileSync(STASH_APK, DEBUG_APK);
        fs.rmSync(STASH_APK);
    }
}

/**
 * Builds a debug APK whose assets/Game is a test variant and copies it to `out`.
 *
 * `makeBundle(game, normal)` writes the test bundle into `game` (android/build/web/Game, empty or absent when it is
 * called); `normal` is the normal bundle's folder while it is set aside (null if there was none), e.g. for its ui/
 * fonts. `gradleArgs` go to :app:assembleDebug -PnoBuildWeb. Afterwards the normal bundle and APK are back where they
 * were; with no normal bundle before, android/build/web/Game is removed (an APK build without -PnoBuildWeb makes it
 * again; deploy.sh NO_BUILD_WEB=1 builds it when missing), and with no normal APK app-debug.apk is removed, so nothing
 * installs the test variant by mistake. Returns the normal APK path (or null).
 */
export function buildTestApk({ out, makeBundle, gradleArgs = [] }) {
    recoverStash();
    fs.mkdirSync(STASH, { recursive: true });
    const hadBundle = fs.existsSync(path.join(WEB_GAME, 'index.html')) && !isTestBundle(WEB_GAME);
    const hadApk = normalApk() !== null;
    if (hadBundle) {
        fs.renameSync(WEB_GAME, STASH_GAME);
    } else {
        fs.rmSync(WEB_GAME, { recursive: true, force: true });
    }
    if (hadApk) fs.copyFileSync(DEBUG_APK, STASH_APK);
    try {
        makeBundle(WEB_GAME, hadBundle ? STASH_GAME : null);
        fs.writeFileSync(path.join(WEB_GAME, 'lctest.json'), `${JSON.stringify({ test: path.basename(out), builtAt: new Date().toISOString() })}\n`);
        gradle(':app:assembleDebug', '-PnoBuildWeb', ...gradleArgs);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(DEBUG_APK, out);
    } finally {
        fs.rmSync(WEB_GAME, { recursive: true, force: true });
        if (hadBundle) fs.renameSync(STASH_GAME, WEB_GAME);
        if (hadApk) {
            fs.copyFileSync(STASH_APK, DEBUG_APK);
            fs.rmSync(STASH_APK);
        } else {
            fs.rmSync(DEBUG_APK, { force: true });
        }
    }
    return hadApk ? DEBUG_APK : null;
}

/** The first phone on USB in the `device` state (adb devices), or null. */
export function firstUsbDevice() {
    const list = execFileSync(ADB, ['devices'], { encoding: 'utf8' });
    for (const line of list.split('\n').slice(1)) {
        const [serial, state] = line.trim().split(/\s+/);
        if (serial && state === 'device' && !serial.startsWith('emulator-')) return serial;
    }
    return null;
}
