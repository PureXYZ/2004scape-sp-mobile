// The soaks of app-test --soak (docs/BUILDING.md §4 "A/B on the phone"): web/test/perf/<name>.json, read and checked
// here for both drivers (web/test/app-test.mjs, android/test/app-test.mjs), what they launch the app with, and the
// page's soak lines (web/test/autotest.js "soak") written as the run's files.
//
//   node web/test/perf/soak.mjs            # the soaks there are, with what each measures
//
// A soak: {name?, description, bots, startup?: {launches, trace?, traceSec?}, phases: [...]}; a phase: {name, sec,
// where?: 'title' | 'ingame', settleSec?, tele?, waitFill?, vars?, webkitLowMemory? (org.WebKit.lowMemory before the
// window), pageGcEverySec? (the app's page collections every n s, 0 = none), audioOff?, walk?, walkEveryMs?,
// lm?: {everySec, think}, settings?: {botChat?, botThink?, botAmbient?} (bots ideas, round 4: Settings › Bot chat for
// the phase and on, as the player sets it; set back at the soak's end), background?, traces?: [{set, at, sec}]}
// (autotest.js's soak section says what each does). A soak may carry `notes` (its runs and pass bars, as text).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOAK_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SOAK_DIR, '..', '..', '..');
const TRACE_SETS = ['am', 'tp', 'gpu', 'disk', 'full', 'tpo'];
const PHASE_KEYS = new Set(['name', 'description', 'sec', 'where', 'settleSec', 'tele', 'waitFill', 'vars', 'webkitLowMemory', 'pageGcEverySec', 'audioOff', 'walk', 'walkEveryMs', 'lm', 'settings', 'background', 'traces']);
/** (bots ideas, round 4: I model) a phase's `settings`: Settings › Bot chat's rows, and the values each offers */
export const SOAK_SETTINGS = Object.freeze({ botChat: ['rules', 'local', 'online'], botThink: [false, true], botAmbient: ['rules', 'model'] });

/** A soak by name (web/test/perf/<name>.json) or path, checked; `bots` (app-test --bots) takes the soak's place. */
export function loadSoak(nameOrPath, { bots } = {}) {
    if (!nameOrPath || nameOrPath.startsWith('--')) {
        throw new Error(`--soak takes a soak's name (${listSoaks().map(s => s.name).join(', ')}) or a file`);
    }
    const file = fs.existsSync(nameOrPath) ? path.resolve(nameOrPath) : path.join(SOAK_DIR, `${nameOrPath.replace(/\.json$/, '')}.json`);
    if (!fs.existsSync(file)) {
        throw new Error(`no soak ${nameOrPath} (web/test/perf/: ${listSoaks().map(s => s.name).join(', ')})`);
    }
    const soak = JSON.parse(fs.readFileSync(file, 'utf8'));
    soak.name ??= path.basename(file, '.json');
    if (bots !== undefined && bots !== null) {
        soak.bots = bots;
    }
    const problems = checkSoak(soak);
    if (problems.length) {
        throw new Error(`${path.relative(process.cwd(), file)}: ${problems.join('; ')}`);
    }
    return soak;
}

function checkSoak(soak) {
    const problems = [];
    if (!(Number.isInteger(soak.bots) && soak.bots >= 0 && soak.bots <= 1000)) {
        problems.push('bots: a count of bots, 0 to 1000 (the soak says how many: A/B runs need the same)');
    }
    const launches = soak.startup?.launches ?? 0;
    if (!(Number.isInteger(launches) && launches >= 0 && launches <= 50)) {
        problems.push('startup.launches: 0 to 50');
    }
    if (soak.startup?.trace && !TRACE_SETS.includes(soak.startup.trace)) {
        problems.push(`startup.trace: one of ${TRACE_SETS.join(', ')}`);
    }
    const phases = soak.phases ?? [];
    if (!Array.isArray(phases) || (!phases.length && !launches)) {
        problems.push('phases: a list (or none, for a start-up series)');
        return problems;
    }
    const names = new Set();
    let ingame = false;
    for (const [i, p] of phases.entries()) {
        const at = `phases[${i}]${p?.name ? ` (${p.name})` : ''}`;
        if (!/^[a-z0-9][a-z0-9-]*$/.test(p?.name ?? '') || names.has(p.name)) {
            problems.push(`${at}: a name of its own (a-z, 0-9, -)`);
        }
        names.add(p?.name);
        const unknown = Object.keys(p ?? {}).filter(k => !PHASE_KEYS.has(k));
        if (unknown.length) {
            problems.push(`${at}: unknown ${unknown.join(', ')}`);
        }
        if (!(p.sec > 0)) {
            problems.push(`${at}: sec, the window's (or the background's) seconds`);
        }
        if (p.where !== undefined && !['title', 'ingame'].includes(p.where)) {
            problems.push(`${at}: where is 'title' or 'ingame'`);
        }
        if (p.where === 'title' && ingame) {
            problems.push(`${at}: a title phase after a phase in the world (the run cannot go back to the title)`);
        }
        if (p.where === 'title' && (p.tele || p.walk || p.vars || p.waitFill || p.lm || p.background)) {
            problems.push(`${at}: at the title there is no world to teleport, walk, set options in, fill or chat in`);
        }
        ingame ||= p.where !== 'title';
        if (p.tele !== undefined && !/^\d+,\d+,\d+,\d+,\d+$/.test(String(p.tele))) {
            problems.push(`${at}: tele is "level,mx,mz,lx,lz" as ::tele takes it`);
        }
        if (p.vars !== undefined && !(p.vars && typeof p.vars === 'object' && Object.entries(p.vars).every(([k, v]) => /^[a-z0-9_]+$/.test(k) && Number.isInteger(v)))) {
            problems.push(`${at}: vars is {varp: integer}`);
        }
        // (bots ideas, round 4: I model)
        if (p.settings !== undefined && !(p.settings && typeof p.settings === 'object' && Object.keys(p.settings).length > 0 && Object.entries(p.settings).every(([k, v]) => SOAK_SETTINGS[k]?.includes(v)))) {
            problems.push(`${at}: settings is {${Object.entries(SOAK_SETTINGS).map(([k, v]) => `${k}: ${v.join('|')}`).join(', ')}} (one or more)`);
        }
        if (p.where === 'title' && p.settings) {
            problems.push(`${at}: Bot chat's settings are set in the world (a phase after the login)`);
        }
        for (const t of p.traces ?? []) {
            if (!TRACE_SETS.includes(t?.set) || !(t.sec > 0) || !(t.at >= 0)) {
                problems.push(`${at}: a trace is {set: ${TRACE_SETS.join('|')}, at: seconds into the window, sec}`);
            }
        }
    }
    return problems;
}

/** The soaks in web/test/perf/: {name, description, bots, phases}. */
export function listSoaks() {
    return fs
        .readdirSync(SOAK_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .map(f => {
            const soak = JSON.parse(fs.readFileSync(path.join(SOAK_DIR, f), 'utf8'));
            return { name: soak.name ?? path.basename(f, '.json'), description: soak.description ?? '', bots: soak.bots, phases: (soak.phases ?? []).map(p => p.name), launches: soak.startup?.launches ?? 0 };
        });
}

/**
 * What the drivers launch the app with (iOS -LostCityTest, Android lostcity.test): base64 of {soak, launch, clean, run,
 * before}: the soak, which launch this is, the clean ones so far, the run's stamp, the settings to set back at the end.
 */
export function launchTestArg(test) {
    return Buffer.from(JSON.stringify(test)).toString('base64');
}

/** The chat model's bench prompts (web/test/lm/bench-prompts.json), for a soak's lm phase: in a soak build's autotest.json. */
export function lmPrompts(repo = REPO) {
    return JSON.parse(fs.readFileSync(path.join(repo, 'web', 'test', 'lm', 'bench-prompts.json'), 'utf8')).prompts.map(p => p.local);
}

/** Why a test build cannot run this soak (--no-build): its Game folder's index.html and autotest.json (text or null). */
export function soakBuildProblem({ index, autotest }, soak, profile) {
    if (!String(index ?? '').includes(`window.__lcTestProfile = ${JSON.stringify(profile)};`)) {
        return `it was not built for the save profile ${profile}`;
    }
    let config = null;
    try {
        config = JSON.parse(autotest ?? 'null');
    } catch {
        config = null;
    }
    if ((soak.phases ?? []).some(p => p.lm) && !config?.lmPrompts?.length) {
        return 'it has no prompts for the chat model (lmPrompts)';
    }
    return null;
}

/**
 * Android's soak windows (android/test/app-test.mjs): each thread's /proc stat line of these processes, prefixed with
 * its pid, then the whole system's cpu line, before and after a window (summary.mjs takes the CPU from them). One shell
 * line, for `adb shell` as ONE argument: adb joins its arguments with spaces and the device's sh parses the result, so
 * `adb shell sh -c <script>` ran `sh -c for` (a syntax error: CPU 0 in every summary). `proc`: another root, for tests.
 */
export function procStatScript(pids, proc = '/proc') {
    return `for p in ${pids.join(' ')}; do for t in ${proc}/$p/task/*; do echo "$p $(cat $t/stat 2>/dev/null)"; done; done; head -1 ${proc}/stat`;
}

/** Minutes a soak may take on top of a run's own (the drivers' timeout). */
export function soakTimeoutMin(soak) {
    const phases = (soak.phases ?? []).reduce((sum, p) => sum + p.sec + (p.settleSec ?? 3) + 20 + (p.waitFill ?? 0) + (p.background ? 90 : 0) + (p.lm ? 180 : 0), 0);
    return Math.ceil(phases / 60 + (soak.startup?.launches ?? 0) * 1.5 + 5);
}

/**
 * The page's soak lines as the run's files: soak-startup → startup.jsonl, soak-summary → soak.jsonl, soak-raw →
 * soak-raw.jsonl, one JSON value a line; a value sent in parts (`<kind>-part <id> <i>/<n> <text>`) once all have come.
 * Only this run's (the `run` the driver launched the app with: a phone's app log keeps earlier runs' lines too).
 * `live`: each value written as it comes; else kept until write(). `cleanLaunches`: a start-up series' clean launches.
 */
export class SoakLines {
    constructor(out, { run, live = true }) {
        this.out = out;
        this.run = run;
        this.live = live;
        this.parts = new Map();
        this.values = [];
        this.cleanLaunches = 0;
    }

    line(line) {
        let m = /LCTEST INFO (soak-startup|soak-summary|soak-raw)-part (\S+) (\d+)\/(\d+) (.*)$/.exec(line);
        if (m) {
            const [, kind, id, i, n, text] = m;
            const parts = this.parts.get(id) ?? [];
            parts[Number(i) - 1] = text;
            this.parts.set(id, parts);
            if (parts.filter(p => p !== undefined).length === Number(n)) {
                this.parts.delete(id);
                this.value(kind, parts.join(''));
            }
            return;
        }
        m = /LCTEST INFO (soak-startup|soak-summary|soak-raw) (\{.*\})\s*$/.exec(line);
        if (m) {
            this.value(m[1], m[2]);
        }
    }

    value(kind, text) {
        let value;
        try {
            value = JSON.parse(text);
        } catch (error) {
            fs.appendFileSync(path.join(this.out, 'soak-unreadable.txt'), `${kind}: ${error.message}\n${text.slice(0, 2000)}\n`);
            return;
        }
        if (this.run && value.run !== this.run) {
            return; // (an earlier run's line)
        }
        this.values.push([kind, value]);
        if (kind === 'soak-startup' && value.clean) {
            this.cleanLaunches++;
        }
        if (this.live) {
            fs.appendFileSync(path.join(this.out, SoakLines.FILES[kind]), `${JSON.stringify(value)}\n`);
        }
    }

    /** The files again from every value kept (in place of what was written before). */
    write() {
        for (const [kind, file] of Object.entries(SoakLines.FILES)) {
            const lines = this.values.filter(([k]) => k === kind).map(([, v]) => JSON.stringify(v));
            fs.rmSync(path.join(this.out, file), { force: true });
            if (lines.length) {
                fs.writeFileSync(path.join(this.out, file), `${lines.join('\n')}\n`);
            }
        }
    }

    static FILES = { 'soak-startup': 'startup.jsonl', 'soak-summary': 'soak.jsonl', 'soak-raw': 'soak-raw.jsonl' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    for (const s of listSoaks()) {
        console.log(`${s.name.padEnd(18)} ${String(s.bots).padStart(4)} bots  ${s.launches ? `${s.launches} launches; ` : ''}${s.phases.join(', ') || '(start-up only)'}\n${' '.repeat(29)}${s.description}`);
    }
}
