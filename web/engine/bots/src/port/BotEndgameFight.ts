/**
 * port (bots ideas, round 1, Track A: the period endgame) what every endgame fight shares (port/BotEndgame's solo spots,
 * port/BotEndgameTeams' KBD and KQ, port/BotWildTrips' endgame spots): the food gate's food, the protection prayers
 * pressed on the prayer tab, the trip's death check, the end of its fight, its lines (data/lines2004-endgame.json, event
 * 'endgame') through the talk budget, and the drop moment (A9: its own kill's notable drop said, the gz of the bots near,
 * the pack's gains noted for its sale stints, port/BotDropSale). A leaf of the endgame modules: it imports none of them
 * but the core and the sale's registry.
 */
import type Player from '#/engine/entity/Player.js';
import type Obj from '#/engine/entity/Obj.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import { countItem, interactIfButtonByName, isInventoryFull, teleportStats } from '#/engine/bot/BotAction.js';
import { act, obj, owned, type Step } from '#/engine/bot/tasks/ErrandTask.js';
import { freshPieceText, sayPieceText } from '#/engine/bot/port/BotPieceLines.js';
import { countAsOwnLine } from '#/engine/bot/port/BotChatter.js';
import { voiceFree } from '#/engine/bot/port/BotVoice.js';
import { sayTyped } from '#/engine/bot/port/BotChat.js';
import { noteSaid } from '#/engine/bot/port/BotLines.js';
import { worldPlayers } from '#/engine/bot/port/BotPlayers.js';
import { emitEndgameEvent } from '#/engine/bot/port/BotEndgameCore.js';
import { noteDropGain } from '#/engine/bot/port/BotDropSale.js';

const LUMBRIDGE_SPAWN = [3222, 3218, 0] as const;

/** food that heals 12 or more (274's eat amounts), best first: the trips' food */
export const ENDGAME_FOOD = ['shark', 'swordfish', 'bass', 'lobster'] as const;
/** a trip starts only with this many owned (carried or banked) */
export const FOOD_GATE = 12;
/** and carries this many (as many as it owns up to the draw) */
export const FOOD_CARRY: readonly [number, number] = [15, 20];
export function foodIds(): number[] {
    return ENDGAME_FOOD.map(obj).filter(id => id >= 0);
}
/** the good food (heals 12+) the bot owns */
export function goodFoodOwned(p: Player): number {
    let n = 0;
    for (const id of foodIds()) n += owned(p, id);
    return n;
}
export function goodFoodCarried(p: Player): number {
    let n = 0;
    for (const id of foodIds()) n += countItem(p, id);
    return n;
}
/** the bank's withdraw list for `carry` pieces of good food, best first */
export function foodWithdraw(carry: number): (p: Player) => [number, number][] {
    return p => {
        const out: [number, number][] = [];
        let left = carry;
        for (const id of foodIds()) {
            if (left <= 0) break;
            const have = Math.min(left, owned(p, id));
            if (have > 0) out.push([id, have]);
            left -= have;
        }
        return out;
    };
}

// ── prayer (Protect from Melee or Magic, the prayer tab's buttons: 274 checks the level and drains the points) ─────────

const PROTECT = {
    melee: { button: 'prayer:prayer_protectfrommelee', varp: 'prayer14', level: 43 },
    magic: { button: 'prayer:prayer_protectfrommagic', varp: 'prayer12', level: 37 }
} as const;
export type Protect = keyof typeof PROTECT;
function prayerOn(p: Player, key: Protect): boolean {
    const varp = VarPlayerType.getByName(PROTECT[key].varp);
    return varp !== null && varp !== undefined && p.getVar(varp.id) === 1;
}
/** the protection on (`on`) or off, one button a tick; true when it pressed one */
export function protectPrayer(p: Player, key: Protect, on: boolean): boolean {
    if (on && (p.levels[PlayerStat.PRAYER] <= 0 || p.baseLevels[PlayerStat.PRAYER] < PROTECT[key].level)) return false;
    if (prayerOn(p, key) === on) return false;
    return interactIfButtonByName(p, PROTECT[key].button);
}
/** both protections off (the trip's end), one a tick */
export function protectionsOff(p: Player): boolean {
    return protectPrayer(p, 'melee', false) || protectPrayer(p, 'magic', false);
}
/** does the bot fight an NPC now, or was it in a fight a moment ago (274's logout hold after combat)? */
function inNpcFight(p: Player): boolean {
    const t = p.target as unknown as { nid?: number } | null;
    return (t !== null && typeof t?.nid === 'number') || World.currentTick < p.preventLogoutUntil;
}

// ── lines (data/lines2004-endgame.json, event 'endgame'; the talk budget: the speaker's due line) ────────────────────

/** another player this near, on its floor */
const COMPANY_TILES = 15;
function companyNear(bot: Player): boolean {
    for (const p of worldPlayers()) {
        if (p !== bot && p.level === bot.level && Math.abs(p.x - bot.x) <= COMPANY_TILES && Math.abs(p.z - bot.z) <= COMPANY_TILES) return true;
    }
    return false;
}

/** the endgame's lines said (the report, the tests): by kind */
export const endgameLineStats = { said: 0, byKind: {} as Record<string, number> };

/**
 * A line of the endgame's `kind` now (`chance`), near others: 'event' and 'botreply' lines in the place of the speaker's
 * next line of its own (BotChatter.countAsOwnLine: H7 holds), and held by its voice's share of a busy place; 'setpiece'
 * lines (team calls) out of H7, against the speaker's budget (port/BotPieceLines). True when said.
 */
export function sayEndgame(bot: Player, kind: string, chance: number, lineKind: 'event' | 'botreply' | 'setpiece' = 'event', company = true, moment = false): boolean {
    if (bot.slot === -1 || Math.random() >= chance) return false;
    if (company && !companyNear(bot)) return false;
    // (a drop's moment and its gz are said whatever the place's talk: rare, and the moment's own; still in the speaker's due line)
    if (lineKind !== 'setpiece' && !moment && !voiceFree(bot)) return false;
    const text = freshPieceText(bot, 'endgame', kind);
    if (!text) return false;
    if (lineKind === 'setpiece') sayPieceText(bot, text, 'setpiece');
    else {
        sayTyped(bot, text, { to: null, kind: lineKind });
        noteSaid(bot, text);
        countAsOwnLine(bot);
    }
    endgameLineStats.said++;
    endgameLineStats.byKind[kind] = (endgameLineStats.byKind[kind] ?? 0) + 1;
    return true;
}
export function sayStep(kind: string, chance: number): Step {
    return act(`say ${kind}`, p => {
        sayEndgame(p, kind, chance);
        return 'done';
    });
}

// ── drops (A9's moment) ──────────────────────────────────────────────────────────────────────────────────────────────

/** a drop worth the moment: a rune or dragon piece (wearable), a half key, or 10k+ */
export function isNotableDrop(id: number): boolean {
    const t = ObjType.get(id);
    const name = (t.name ?? '').toLowerCase();
    const debug = t.debugname ?? '';
    if (t.wearpos !== -1 && (name.startsWith('rune ') || name.startsWith('dragon '))) return true;
    if (/halfkey|half_key|toothhalf|loophalf/.test(debug)) return true;
    return t.cost >= 10000;
}
/** an endgame loot a bot sells in its stints (A9): the notable drops, dragon bones and dragonhides */
export function isSaleLoot(id: number): boolean {
    const t = ObjType.get(id);
    const name = (t.name ?? '').toLowerCase();
    return isNotableDrop(id) || name === 'dragon bones' || name.includes('dragonhide');
}
/** the drop line's kind for this item */
export function dropKind(id: number): string {
    const t = ObjType.get(id);
    const name = (t.name ?? '').toLowerCase();
    if (name.startsWith('dragon ')) return name.includes('chainbody') ? 'eg-drop-dchain' : name.includes('med helm') ? 'eg-drop-dmed' : 'eg-drop-dragon';
    if (name.startsWith('rune ')) {
        if (name.includes('chainbody')) return 'eg-drop-rune-chain';
        if (name.includes('med helm')) return 'eg-drop-rune-med';
        if (name.includes('full helm')) return 'eg-drop-rune-full';
        return 'eg-drop-rune';
    }
    if (/half/.test(t.debugname ?? '')) return 'eg-drop-halfkey';
    return 'eg-drop-big';
}

/** what the drop moments did (the report: EG5; the tests) */
export const dropStats = { drops: {} as Record<string, number>, lines: 0, gz: 0, near: 0 };
/** the drop moments, newest last (the report's EG5: whether a gz followed) */
export const dropLog: { name: string; item: string; tick: number; x: number; z: number; said: boolean; gz: number; near: number }[] = [];

/** the gz to a drop: each bot within 15 tiles 0.5, at most 3 (typed a moment later) */
export const GZ_CHANCE = 0.5;
export const GZ_MAX = 3;

/** the drop moment: its line (0.7 for rune and the rest, 1.0 for dragon), the gz from bots near, the rare-drop event */
export function dropMoment(bot: Player, id: number): void {
    const t = ObjType.get(id);
    const kind = dropKind(id);
    const dragon = kind.startsWith('eg-drop-d');
    dropStats.drops[t.debugname ?? String(id)] = (dropStats.drops[t.debugname ?? String(id)] ?? 0) + 1;
    const said = sayEndgame(bot, kind, dragon ? 1 : 0.7, 'event', false, true);
    if (said) dropStats.lines++;
    let gz = 0;
    let near = 0;
    if (said) {
        for (const other of worldPlayers()) {
            if (other === bot || other.is_bot !== true || other.level !== bot.level || Math.max(Math.abs(other.x - bot.x), Math.abs(other.z - bot.z)) > COMPANY_TILES) continue;
            near++;
            if (gz >= GZ_MAX || Math.random() >= GZ_CHANCE) continue;
            if (sayEndgame(other, 'eg-gz', 1, 'botreply', false, true)) gz++;
        }
    }
    dropStats.gz += gz;
    dropStats.near += near;
    dropLog.push({ name: bot.username, item: t.debugname ?? String(id), tick: World.currentTick, x: bot.x, z: bot.z, said, gz, near });
    if (dropLog.length > 2000) dropLog.splice(0, dropLog.length - 2000);
    if (dragon || (t.cost ?? 0) >= 10000 || kind !== 'eg-drop-rune') emitEndgameEvent(bot, 'rareDrop', { item: t.debugname, id });
}

/**
 * The fight's watcher (every tick of the fight): its protection prayer while it fights (`protect`), the drops of its own
 * kills seen on the ground (each once: the moment, a kill's event), the pack's gains of sale loot noted (port/BotDropSale).
 */
export function fightWatcher(protect: Protect | null, spot: string): { watch: (p: Player) => void; end: (p: Player) => void } {
    const seen = new WeakSet<Obj>();
    let idle = 0;
    let tick = 0;
    const packBefore = new Map<number, number>();
    let noted = false;
    const notePack = (p: Player, into: Map<number, number>): void => {
        into.clear();
        const inv = p.getInventory(InvType.INV);
        for (let s = 0; inv && s < inv.capacity; s++) {
            const it = inv.get(s);
            if (it && isSaleLoot(it.id)) into.set(it.id, (into.get(it.id) ?? 0) + it.count);
        }
    };
    return {
        watch(p) {
            if (!noted) {
                noted = true;
                notePack(p, packBefore);
            }
            tick++;
            if (protect) {
                const fighting = inNpcFight(p);
                idle = fighting ? 0 : idle + 1;
                if (fighting) protectPrayer(p, protect, true);
                else if (idle > 12) protectPrayer(p, protect, false);
            }
            if (tick % 4 !== 0) return;
            for (let zx = (p.x - 6) & ~7; zx <= p.x + 6; zx += 8) {
                for (let zz = (p.z - 6) & ~7; zz <= p.z + 6; zz += 8) {
                    const zone = World.gameMap.getZone(zx, zz, p.level);
                    if (!zone) continue;
                    for (const o of zone.getAllObjsSafe()) {
                        if (seen.has(o) || o.receiver64 !== p.hash64) continue;
                        seen.add(o);
                        if (ObjType.get(o.type).name?.toLowerCase().includes('bones') || ObjType.get(o.type).debugname === 'ashes') emitEndgameEvent(p, 'bossKill', { spot, x: o.x, z: o.z });
                        if (isNotableDrop(o.type)) dropMoment(p, o.type);
                    }
                }
            }
        },
        end(p) {
            if (!noted) return;
            const after = new Map<number, number>();
            notePack(p, after);
            for (const [id, n] of after) {
                const gain = n - (packBefore.get(id) ?? 0);
                if (gain > 0) noteDropGain(p, id, gain);
            }
        }
    };
}

/**
 * the trip's death check (port/BotWildTrips'): its Hitpoints at 0, or at Lumbridge's spawn come there from far since its
 * last look (274's respawn). (Round 1 fixes, A1: looked at from the trip's first step, every tick (`whileAlive`): a walk
 * to the Duke of Lumbridge for the shield passes the spawn, which "back at the spawn after being away" took for a death,
 * and a look only in the fight never saw a death on the way, whose bot walked the trip's route back north)
 * (The KQ fixes, KQ-1: a jump its own teleport spell made since that look is no death (castSince): Lumbridge Teleport
 * lands a tile from the spawn, and a KQ member that cast it on its way to the church's altar or Al Kharid was logged
 * dead, its errand over, its team a member short. The KBD's and the solo trips' alike)
 */
export function deathCheck(): { died(p: Player): boolean } {
    let died = false;
    let lastX = -1;
    let lastZ = -1;
    let lastTick = -1;
    return {
        died(p) {
            const atSpawn = p.level === 0 && Math.max(Math.abs(p.x - LUMBRIDGE_SPAWN[0]), Math.abs(p.z - LUMBRIDGE_SPAWN[1])) <= 12;
            const jumped = lastX >= 0 && Math.max(Math.abs(p.x - lastX), Math.abs(p.z - lastZ)) > RESPAWN_JUMP;
            if (!died && (p.levels[PlayerStat.HITPOINTS] <= 0 || (atSpawn && jumped && !castSince(p, lastTick)))) died = true;
            lastX = p.x;
            lastZ = p.z;
            lastTick = World.currentTick;
            return died;
        }
    };
}
/** a move this far between two looks is no walk (274's respawn: a death far off) */
const RESPAWN_JUMP = 20;

/**
 * (the KQ fixes, KQ-1) the bot's own teleport spell since `tick`: a 'spell' mark of its (BotAction.noteMove, at the cast's
 * check: port/BotTeleport's, port/BotPkFight's), at that tick or after. Its cast holds the bot (BotPlayer's cast hold:
 * no look meanwhile), so the mark always falls between the look before the jump and the one after. The marks run oldest
 * first: read from the newest back, only for a jump to the spawn
 */
function castSince(p: Player, tick: number): boolean {
    const name = p.username.toLowerCase();
    const marks = teleportStats.marks;
    for (let i = marks.length - 1; i >= 0 && marks[i].tick >= tick; i--) if (marks[i].cls === 'spell' && marks[i].name === name) return true;
    return false;
}

/**
 * (round 1 fixes, A1) the steps, each passed over once the bot died on the trip (`died`, asked at every tick of each: its
 * respawn seen however far off it died): a dead bosser never walks the trip's route back north from Lumbridge, its
 * errand runs on to its end (its bookkeeping steps, left out of here)
 */
export function whileAlive(died: (p: Player) => boolean, ...steps: Step[]): Step[] {
    return steps.map(step => ({
        label: step.label,
        dialog: step.dialog,
        tick(p, t) {
            if (!died(p)) return step.tick(p, t);
            if (p.hasWaypoints()) p.clearWaypoints();
            return 'done';
        }
    }));
}

/** the end of a trip's fight: food down to 2 with its Hitpoints under half, its pack full, its prayer out (`prayer`) */
export function fightOver(p: Player, prayer: boolean): boolean {
    const hp = p.levels[PlayerStat.HITPOINTS] / Math.max(1, p.baseLevels[PlayerStat.HITPOINTS]);
    if (goodFoodCarried(p) <= 2 && hp < 0.5) return true;
    if (isInventoryFull(p)) return true;
    return prayer && p.levels[PlayerStat.PRAYER] <= 0;
}

