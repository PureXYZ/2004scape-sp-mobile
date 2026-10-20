/**
 * RunecraftingTask.ts
 *
 * Mines rune essence at the essence mine, then crafts runes at the best
 * available altar based on the bot's Runecrafting level and owned talismans.
 *
 * Unlock condition:
 *   Any runecrafting talisman in bank or inventory  +  any pickaxe.
 *   (Air talisman is the entry-level drop from various combat NPCs.)
 *
 * Progression (highest qualifying altar wins):
 *   Law 54 → Nature 44 → Chaos 35 → Cosmic 27 → Body 20 → Fire 14
 *   → Earth 9 → Water 5 → Mind 2 → Air 1
 *
 * Cycle per run:
 *   check_altar → bank_walk → bank_deposit
 *   → to_mine (walk to Aubury in Varrock, his Teleport) → mine (fill inventory with essence)
 *   → mine_exit (the mine's portal back to Aubury) → to_ruins (walk to the altar's ruins, the talisman on them)
 *   → craft (the altar binds the runes and gives the XP) → altar_exit (its portal) → to_mine again
 *   (the bank only when a better altar needs another talisman)
 *
 * port: as a player does it (walking, the real gates and boats). Upstream jumped into the mine and
 * onto the altar from wherever the bot was (21 jumps in a 2,500-tick coverage run), and mined and crafted "manually"
 * (essence, runes and XP added by itself) whenever 274's scripts had not answered in time. Here only the game's
 * scripts do it; a mine or an altar that does not answer ends the task. Law (Entrana) and Chaos (the Wilderness maze)
 * are not taken: no walk reaches them. port: Cosmic is, on a members world: its ruins are in Zanaris, reached through
 * the Lumbridge swamp shed's door with the bot's dramen staff worn (to_zanaris), and left by the ladder by the arrival.
 */

import {
    BotTask,
    Loc,
    Player,
    InvType,
    interactLoc,
    interactLocOp,
    interactNpcOp,
    interactUseLocOp,
    findLocByPrefix,
    findLocByName,
    findNpcByName,
    walkTo,
    teleportNear,
    openNearbyGate,
    hasItem,
    countItem,
    isInventoryFull,
    isNear,
    getBaseLevel,
    PlayerStat,
    Items,
    Locations,
    randInt,
    bankInvId,
    INTERACT_TIMEOUT,
    StuckDetector,
    ProgressWatchdog,
    advanceBankWalk,
    withdrawFare,
    humanDelay,
} from '#/engine/bot/tasks/BotTaskBase.js';
import { bankStop } from '#/engine/bot/port/BotHabits.js';
import { botContinuePage, interactHeldOp } from '#/engine/bot/BotAction.js';
import { botConsole as console } from '#/engine/bot/port/BotLog.js';
import { moveItems, bankedId } from '#/engine/bot/port/BotInventoryCompat.js';
import { isAllowedCoord, isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
import { isZanaris } from '#/engine/bot/BotKnowledge.js';
import { keepQuestItems, owns } from '#/engine/bot/tasks/UtilTasks.js';
import ObjType from '#/cache/config/ObjType.js';
import type { SkillStep } from '#/engine/bot/BotKnowledge.js';
// (the variety work, round 1, Track D: ISS-12) Aubury's teleport, the portals and the ruins move the bot by the game's own
// scripts: marked for the humanlike runner (BotAction.noteMove 'event'), so they are not counted as rescue jumps
import { noteMove } from '#/engine/bot/BotAction.js';

// ── Altar definitions — highest level first for progression lookup ─────────────

interface AltarDef {
    name: string;
    talismanId: number;
    runeId: number;
    levelReq: number;
    /** Herblore-style XP storage: actual XP × 10 (e.g. 50 = 5.0 XP). */
    xpPerEssence: number;
    /** inside: where the ruins put the bot, by the altar and its exit portal */
    location: [number, number, number];
    /** port: the mysterious ruins outside (274's <name>temple_ruined, a 3×3 loc), its loc and the exit portal's */
    ruins: [number, number];
    ruinsLoc: string;
    portalLoc: string;
    /** port: false where no walk reaches the ruins (Entrana's boat takes no armour or weapons, the maze) */
    walkable: boolean;
    /** port: the ruins are in Zanaris: this staff, worn, opens the way (274's zanarisdoor: a dramen staff) */
    staff?: number;
}

const ALTARS: readonly AltarDef[] = [
    { name: 'Law',    talismanId: Items.LAW_TALISMAN,    runeId: Items.LAW_RUNE,    levelReq: 54, xpPerEssence: 95,  location: [...Locations.LAW_ALTAR]    as [number, number, number], ruins: [2857, 3380], ruinsLoc: 'lawtemple_ruined', portalLoc: 'lawtemple_exit_portal', walkable: false },
    { name: 'Nature', talismanId: Items.NATURE_TALISMAN, runeId: Items.NATURE_RUNE, levelReq: 44, xpPerEssence: 90,  location: [...Locations.NATURE_ALTAR]  as [number, number, number], ruins: [2868, 3018], ruinsLoc: 'naturetemple_ruined', portalLoc: 'naturetemple_exit_portal', walkable: true },
    { name: 'Chaos',  talismanId: Items.CHAOS_TALISMAN,  runeId: Items.CHAOS_RUNE,  levelReq: 35, xpPerEssence: 85,  location: [...Locations.CHAOS_ALTAR]   as [number, number, number], ruins: [3059, 3590], ruinsLoc: 'chaostemple_ruined', portalLoc: 'chaostemple_exit_portal', walkable: false },
    { name: 'Cosmic', talismanId: Items.COSMIC_TALISMAN, runeId: Items.COSMIC_RUNE, levelReq: 27, xpPerEssence: 80,  location: [...Locations.COSMIC_ALTAR]  as [number, number, number], ruins: [3175, 9496], ruinsLoc: 'cosmictemple_ruined', portalLoc: 'cosmictemple_exit_portal', walkable: true, staff: Items.DRAMEN_STAFF },
    { name: 'Body',   talismanId: Items.BODY_TALISMAN,   runeId: Items.BODY_RUNE,   levelReq: 20, xpPerEssence: 75,  location: [...Locations.BODY_ALTAR]    as [number, number, number], ruins: [3052, 3444], ruinsLoc: 'bodytemple_ruined', portalLoc: 'bodytemple_exit_portal', walkable: true },
    { name: 'Fire',   talismanId: Items.FIRE_TALISMAN,   runeId: Items.FIRE_RUNE,   levelReq: 14, xpPerEssence: 70,  location: [...Locations.FIRE_ALTAR]    as [number, number, number], ruins: [3312, 3254], ruinsLoc: 'firetemple_ruined', portalLoc: 'firetemple_exit_portal', walkable: true },
    { name: 'Earth',  talismanId: Items.EARTH_TALISMAN,  runeId: Items.EARTH_RUNE,  levelReq:  9, xpPerEssence: 65,  location: [...Locations.EARTH_ALTAR]   as [number, number, number], ruins: [3305, 3473], ruinsLoc: 'earthtemple_ruined', portalLoc: 'earthtemple_exit_portal', walkable: true },
    { name: 'Water',  talismanId: Items.WATER_TALISMAN,  runeId: Items.WATER_RUNE,  levelReq:  5, xpPerEssence: 60,  location: [...Locations.WATER_ALTAR]   as [number, number, number], ruins: [3184, 3164], ruinsLoc: 'watertemple_ruined', portalLoc: 'watertemple_exit_portal', walkable: true },
    { name: 'Mind',   talismanId: Items.MIND_TALISMAN,   runeId: Items.MIND_RUNE,   levelReq:  2, xpPerEssence: 55,  location: [...Locations.MIND_ALTAR]    as [number, number, number], ruins: [2981, 3513], ruinsLoc: 'mindtemple_ruined', portalLoc: 'mindtemple_exit_portal', walkable: true },
    { name: 'Air',    talismanId: Items.AIR_TALISMAN,    runeId: Items.AIR_RUNE,    levelReq:  1, xpPerEssence: 50,  location: [...Locations.AIR_ALTAR]     as [number, number, number], ruins: [2984, 3291], ruinsLoc: 'airtemple_ruined', portalLoc: 'airtemple_exit_portal', walkable: true },
] as const;

// ── Pickaxe priority list (best first) ────────────────────────────────────────

const PICKAXE_IDS: readonly number[] = [
    Items.RUNE_PICKAXE,
    Items.ADAMANT_PICKAXE,
    Items.MITHRIL_PICKAXE,
    Items.STEEL_PICKAXE,
    Items.IRON_PICKAXE,
    Items.BRONZE_PICKAXE,
];

// ── Rune multiplier (more runes per essence at higher levels) ─────────────────
// Breakpoints: each entry is the level at which output increases by 1 extra rune.

const RUNE_BREAKPOINTS: Partial<Record<number, readonly number[]>> = {
    [Items.AIR_RUNE]:    [11, 22, 33, 44, 55, 66, 77, 88, 99],
    [Items.MIND_RUNE]:   [14, 28, 42, 56, 70, 84, 98],
    [Items.WATER_RUNE]:  [19, 38, 57, 76, 95],
    [Items.EARTH_RUNE]:  [26, 52, 78],
    [Items.FIRE_RUNE]:   [35, 70],
    [Items.BODY_RUNE]:   [46, 92],
    [Items.COSMIC_RUNE]: [59],
    [Items.CHAOS_RUNE]:  [74],
    [Items.NATURE_RUNE]: [91],
    // Law runes — breakpoint is level 108, never reached in RS2
};

function runeMultiplier(runeId: number, level: number): number {
    const bps = RUNE_BREAKPOINTS[runeId] ?? [];
    return 1 + bps.filter(bp => level >= bp).length;
}

// ── Task ──────────────────────────────────────────────────────────────────────

type RCState =
    | 'check_altar'
    | 'bank_walk'
    | 'bank_deposit'
    | 'to_mine'         // port: walk to Aubury, his Teleport (op4)
    | 'mine_approach'   // find a rock (mirrors MiningTask 'approach')
    | 'mine_scan'       // send interactLoc once (mirrors MiningTask 'scan')
    | 'mine_interact'   // wait for essence gain, no re-clicks (mirrors MiningTask 'interact')
    | 'mine_exit'       // port: the mine's portal back to Aubury
    | 'to_zanaris'      // port: the Cosmic ruins' way: the dramen staff worn, the shed's door from outside
    | 'to_ruins'        // port: walk to the altar's ruins, the talisman used on them
    | 'craft'
    | 'altar_exit';     // port: the altar's portal back out

/** port: Aubury, in his rune shop in south-east Varrock */
const AUBURY: [number, number] = [3253, 3402];
/** port: the essence mine (instanced: 274's essence_mine_teleports lands the bot somewhere in it) */
function inEssenceMine(player: Player): boolean {
    return player.level === 0 && player.x >= 2870 && player.x <= 2950 && player.z >= 4790 && player.z <= 4870;
}
/** port: inside an altar's temple (they all lie in the instanced strip at z 4800-4870) */
function inTemple(player: Player, altar: AltarDef): boolean {
    return player.z > 4700 && Math.max(Math.abs(player.x - altar.location[0]), Math.abs(player.z - altar.location[1])) <= 40;
}

/**
 * (the variety work, round 1, Track D: DO-4) the essence run's spot, for what reads a task's step (the occupancy, the
 * humanlike report): the essence mine, its rocks mined with any pickaxe (no level), Mining XP
 */
export const ESSENCE_STEP: SkillStep = { minLevel: 1, maxLevel: 99, action: 'essence', location: [...Locations.ESSENCE_MINE] as [number, number, number], toolItemIds: [], xpPerAction: 50, ticksPerAction: 4, successRate: 1.0, itemGained: Items.RUNE_ESSENCE };

export class RunecraftingTask extends BotTask {

    private state: RCState = 'check_altar';
    /**
     * (the variety work, round 1, Track D: DO-4) 'essence': the run without an altar, as 2004's essence miners made it
     * (EssenceTask): Aubury's teleport, a pack of essence, the portal, the Varrock East bank, and again. 'runes': the
     * whole run, to an altar of a talisman the bot owns.
     */
    protected readonly mode: 'runes' | 'essence';

    private currentAltar: AltarDef | null = null;
    /** port: ticks since the altar was clicked */
    private craftWait = 0;
    private pickaxeId: number = Items.BRONZE_PICKAXE;

    // ── Mining tracking (mirrors MiningTask field layout) ────────────────────
    private currentRock: Loc | null = null;
    private lastEssenceCount = 0;
    /** Ticks spent in mine_interact waiting for essence — resets on each gain. */
    private interactTicks = 0;
    /** Ticks in mine_approach without finding a rock. */
    private scanFailTicks = 0;
    /** Ticks spent trying to walk adjacent to the rock. */
    private approachTicks = 0;
    /** How many INTERACT_TIMEOUTs have fired without any essence — after 2 the task ends (port: no manual mining). */
    private mineTimeouts = 0;

    // ── Craft tracking ────────────────────────────────────────────────────────
    /** Whether the craft interactLoc has been sent for this altar visit. */
    private craftInteracted = false;
    /** port: clicks on Aubury, a portal, the ruins or the altar that have not moved the bot on yet */
    private tries = 0;
    /** port: the trip failed (the mine or the altar did not answer): out of the instance, then the task ends */
    private failed = false;

    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog(300);

    private lastLogKey = '';
    private lastLogTime = 0;
    /**
     * (the variety work, round 1, Track D: ISS-12) where the bot was last tick: the world, the essence mine, a temple or
     * Zanaris; a change is one of the game's own moves (Aubury's teleport, a portal, the ruins, the shed's door), marked
     * the tick it is seen (a click's mark came too early when the bot first walked to the portal or to Aubury)
     */
    private realm: string | null = null;

    constructor(mode: 'runes' | 'essence' = 'runes') {
        super(mode === 'essence' ? 'Essence' : 'Runecrafting');
        this.mode = mode;
        // port: a rescue lands where the bot is headed now (outside: Aubury or the ruins; inside: the mine or the altar)
        this.watchdog.follow(() => this._destination());
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    shouldRun(player: Player): boolean {
        // Need any pickaxe AND at least one altar we can use
        if (!this._hasPickaxe(player)) return false;
        // (Track D: an essence run needs no altar)
        if (this.mode === 'essence') return true;
        return this._pickBestAltar(player) !== null;
    }

    /** (the variety work, round 1, Track D) an essence run's spot (ESSENCE_STEP); a rune run's none (its altar varies) */
    override activityStep(): SkillStep | null {
        return this.mode === 'essence' ? ESSENCE_STEP : null;
    }

    isComplete(_player: Player): boolean {
        return false; // infinite loop — planner interrupts via shouldRun
    }

    tick(player: Player): void {
        if (this.interrupted) return;

        // (Track D, ISS-12: the game's move into or out of the mine, a temple or Zanaris, marked for the humanlike runner)
        const realm = inEssenceMine(player) ? 'mine' : (ALTARS.find(a => inTemple(player, a))?.name ?? (player.level === 0 && isZanaris(player.x, player.z) ? 'zanaris' : 'world'));
        if (this.realm !== null && realm !== this.realm) noteMove(player, 'event');
        this.realm = realm;

        const banking = this.state === 'bank_walk' || this.state === 'bank_deposit';
        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this._log(player, 'watchdog reset → check_altar', 'watchdog');
            this.state = 'check_altar';
            return;
        }

        // port: a trip that starts (or restarts) inside the mine or a temple leaves it first: no bank walk from an
        // instance (a bot that logged out there, a watchdog's reset)
        if (this.state === 'check_altar' || this.state === 'bank_walk') {
            if (inEssenceMine(player)) {
                this.tries = 0;
                this.state = 'mine_exit';
                return;
            }
            const temple = ALTARS.find(a => inTemple(player, a));
            if (temple) {
                this.currentAltar = temple;
                this.tries = 0;
                this.state = 'altar_exit';
                return;
            }
            // port: and out of Zanaris by its ladder (walkTo climbs it) before a bank walk: the nearest bank is measured
            // on the surface
            if (this.state === 'bank_walk' && player.level === 0 && isZanaris(player.x, player.z)) {
                if (!player.delayed) walkTo(player, Locations.ZANARIS_SHED[0], Locations.ZANARIS_SHED[1]);
                return;
            }
        }

        if (this.cooldown > 0) { this.cooldown--; return; }

        // ── CHECK ALTAR ───────────────────────────────────────────────────────
        if (this.state === 'check_altar') {
            // (Track D: an essence run: to the bank, then Aubury)
            if (this.mode === 'essence') {
                this.currentAltar = null;
                this.pickaxeId = this._bestPickaxe(player);
                this.state = 'bank_walk';
                return;
            }
            const altar = this._pickBestAltar(player);
            if (!altar) {
                this._log(player, 'no altar available → interrupt', 'no_altar');
                this.interrupt();
                return;
            }
            if (altar !== this.currentAltar) {
                this._log(player, `selected ${altar.name} altar (RC level ${getBaseLevel(player, PlayerStat.RUNECRAFT)})`, 'altar_sel');
            }
            this.currentAltar = altar;
            this.pickaxeId    = this._bestPickaxe(player);
            this.state        = 'bank_walk';
            return;
        }

        // ── BANK WALK ─────────────────────────────────────────────────────────
        if (this.state === 'bank_walk') {
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            this.cooldown = result === 'ready' ? bankStop(player) : 0; // port (the realism work): a person's stop (port/BotHabits)
            this.state    = 'bank_deposit';
            return;
        }

        // ── BANK DEPOSIT + SETUP ──────────────────────────────────────────────
        if (this.state === 'bank_deposit') {
            this._bankDeposit(player);
            // port: the Cosmic ruins' dramen staff on, here at the bank: what it replaced in the hand goes in too
            const staff = this.currentAltar?.staff;
            if (staff && this._wearStaff(player, staff)) this._bankDeposit(player);
            // port: the boat's fare to the ruins and back (Nature: Karamja)
            if (this.currentAltar) withdrawFare(player, this.currentAltar.ruins[0], this.currentAltar.ruins[1]);
            this.lastEssenceCount = 0;
            this.currentRock      = null;
            this.tries            = 0;
            this.state            = 'to_mine';
            this.cooldown         = 2;
            return;
        }

        // ── TO THE MINE: Aubury's Teleport ────────────────────────────────────
        // port: walked to Aubury's rune shop and his Teleport (op4: 274's teleport_to_essence_mine, Rune Mysteries
        // done, as every bot has); upstream jumped into the mine from wherever it was
        if (this.state === 'to_mine') {
            if (inEssenceMine(player)) {
                this.currentRock      = null;
                this.lastEssenceCount = countItem(player, Items.RUNE_ESSENCE);
                this.interactTicks    = 0;
                this.scanFailTicks    = 0;
                this.approachTicks    = 0;
                this.mineTimeouts     = 0;
                this.tries            = 0;
                this.state            = 'mine_approach';
                this.watchdog.notifyActivity();
                this._log(player, 'in the essence mine (Aubury)', 'mine_in');
                return;
            }
            // (his spell: p_delay 4, then the jump; a gate's or a boat's dialogue on the way is walkTo's)
            if (player.delayed) return;
            const [ax, az] = AUBURY;
            const aubury = isNear(player, ax, az, 8) ? findNpcByName(player.x, player.z, player.level, 'aubury', 10) : null;
            if (!aubury) {
                this._walk(player, ax, az);
                return;
            }
            if (++this.tries > 4) {
                this._log(player, 'Aubury does not teleport → end', 'aubury_fail');
                this.interrupt();
                return;
            }
            interactNpcOp(player, aubury, 4);
            noteMove(player, 'event'); // (Track D, ISS-12: his teleport lands it in the mine a few ticks on)
            this.cooldown = 8;
            return;
        }

        // ── MINE: APPROACH — find a rock ──────────────────────────────────────
        if (this.state === 'mine_approach') {
            if (!inEssenceMine(player)) { this.state = 'to_mine'; return; }
            if (isInventoryFull(player)) {
                this._log(player, `inv full → portal`, 'mine_done');
                this.tries = 0;
                this.state = 'mine_exit';
                return;
            }

            const rock = this._findEssenceRock(player);

            if (!rock) {
                // port: the mine's four rocks are about 20 tiles from its middle; walk there and look again
                const [mx, mz] = Locations.ESSENCE_MINE;
                if (!isNear(player, mx, mz, 3)) walkTo(player, mx, mz);
                if (++this.scanFailTicks >= 10) {
                    this._log(player, 'no essence rock → portal, end', 'no_rock');
                    this.failed = true;
                    this.tries  = 0;
                    this.state  = 'mine_exit';
                }
                this.cooldown = 2;
                return;
            }
            this.scanFailTicks = 0;
            this.currentRock   = rock;

            // port: clicked from where the bot stands: the click's route takes it to the rock's side (BotAction's
            // _routeToLoc). Upstream teleported onto the rock's corner tile, diagonal to the 5×5 rock, where the mine
            // never fired, and mined "manually" (essence and Mining XP added)
            this.approachTicks = 0;
            this.state         = 'mine_scan';
            return;
        }

        // ── MINE: SCAN — send interactLoc exactly once ────────────────────────
        // Mirrors MiningTask 'scan' state.  ONE click, then immediately wait.
        if (this.state === 'mine_scan') {
            if (isInventoryFull(player)) {
                this._log(player, `inv full → portal`, 'mine_done');
                this.tries = 0;
                this.state = 'mine_exit';
                return;
            }
            if (!this.currentRock) {
                this.state = 'mine_approach';
                return;
            }

            interactLoc(player, this.currentRock);
            this.lastEssenceCount = countItem(player, Items.RUNE_ESSENCE);
            this.interactTicks    = 0;
            this.state            = 'mine_interact';
            this._log(player, `clicked rock at (${this.currentRock.x},${this.currentRock.z})`, 'mine_click');
            return;
        }

        // ── MINE: INTERACT — wait for essence, never re-click ─────────────────
        // Mirrors MiningTask 'interact' state.  Just watches for essence arriving.
        // If INTERACT_TIMEOUT ticks pass without gain, go back to approach.
        // port: after 2 timeouts in a row the mine does not answer: out by the portal and the task ends (upstream
        // went on "manually", adding essence and Mining XP itself)
        if (this.state === 'mine_interact') {
            if (isInventoryFull(player)) {
                this._log(player, `inv full → portal`, 'mine_done');
                this.tries = 0;
                this.state = 'mine_exit';
                // port (the realism work): a person's moment before the portal (it was clicked in the tick the pack
                // filled: the humanlike report's H17, 22 % of runecrafters' re-targets within a tick)
                this.cooldown = humanDelay(player, 'retarget');
                return;
            }

            this.interactTicks++;
            const essNow = countItem(player, Items.RUNE_ESSENCE);

            if (essNow > this.lastEssenceCount) {
                const gained = essNow - this.lastEssenceCount;
                // port: 274's mining script gives the Mining XP (upstream added it again)
                this.lastEssenceCount = essNow;
                this.interactTicks    = 0;
                this.mineTimeouts     = 0;
                this.watchdog.notifyActivity();
                this._log(player, `mined ${gained} essence (server) → ${essNow} total`, 'mine_srv');
                // Stay in interact — server will keep delivering until rock depletes
                return;
            }

            if (this.interactTicks >= INTERACT_TIMEOUT) {
                this.mineTimeouts++;
                this.interactTicks = 0;
                this.currentRock   = null;
                this._log(player, `interact timeout (${this.mineTimeouts})`, 'mine_timeout');

                if (this.mineTimeouts >= 2) {
                    this._log(player, 'the mine does not answer → portal, end', 'mine_fail');
                    this.failed = true;
                    this.tries  = 0;
                    this.state  = 'mine_exit';
                } else {
                    this.state = 'mine_approach';
                    this.cooldown = humanDelay(player, 'retarget');
                }
            }
            return;
        }

        // ── MINE EXIT: the portal back to Aubury ──────────────────────────────
        if (this.state === 'mine_exit') {
            if (!inEssenceMine(player)) {
                this.watchdog.notifyActivity();
                if (this.failed) { this.interrupt(); return; }
                this.craftInteracted = false;
                this.tries = 0;
                // (no essence: a trip that restarted in the mine)
                // (Track D: an essence run banks its pack at the bank by Aubury, Varrock East, and goes back)
                this.state = countItem(player, Items.RUNE_ESSENCE) > 0 ? (this.mode === 'essence' ? 'bank_walk' : 'to_ruins') : 'check_altar';
                return;
            }
            // (the mine's "too full" box is still open: clicked away, as a player does)
            if (botContinuePage(player) || player.delayed) return;
            const portal = findLocByName(player.x, player.z, player.level, 'blankrunestone_exit_portal', 40);
            if (!portal || ++this.tries > 4) {
                this._log(player, 'no way out of the mine → rescue', 'mine_stuck');
                const [ax, az] = AUBURY;
                teleportNear(player, ax, az); // port: out of sight only; else it tries again
                this.tries = 0;
                return;
            }
            interactLocOp(player, portal, 1);
            noteMove(player, 'event'); // (Track D, ISS-12: the portal puts it by Aubury)
            this.cooldown = 6;
            return;
        }

        // ── TO ZANARIS: the shed's door, the dramen staff worn ────────────────
        // port: as a player who has done Lost City goes: 274's zanarisdoor, opened from outside the Lumbridge swamp shed
        // by a player who wears a dramen staff, takes them to Zanaris (from inside, or without the staff, it is a door)
        if (this.state === 'to_zanaris') {
            const staff = this.currentAltar?.staff;
            if (!staff) { this.state = 'check_altar'; return; }
            if (player.level === 0 && isZanaris(player.x, player.z)) {
                this.watchdog.notifyActivity();
                this.tries = 0;
                this.state = 'to_ruins';
                return;
            }
            if (player.delayed) return; // (the shimmer: p_delay 1, then the jump)
            if (!this._wearing(player, staff)) {
                if (this._wearStaff(player, staff)) return;
                this._log(player, 'no dramen staff to wear → bank', 'staff_bank');
                this.state = 'bank_walk';
                return;
            }
            const [sx, sz] = Locations.ZANARIS_SHED;
            const door = isNear(player, sx, sz, 6) ? findLocByName(player.x, player.z, player.level, 'zanarisdoor', 8) : null;
            if (!door) {
                this._walk(player, sx, sz);
                return;
            }
            if (++this.tries > 4) {
                this._log(player, 'the shed door does not open Zanaris → end', 'zanaris_fail');
                this.interrupt();
                return;
            }
            interactLocOp(player, door, 1);
            noteMove(player, 'event'); // (Track D, ISS-12: the shed's door takes it to Zanaris)
            this.cooldown = 6;
            return;
        }

        // ── TO THE RUINS: the talisman on the mysterious ruins ────────────────
        // port: walked there, and the talisman used on the ruins (274's teleport_to_ruins); upstream jumped onto the
        // altar from the mine
        if (this.state === 'to_ruins') {
            const altar = this.currentAltar;
            if (!altar) { this.state = 'check_altar'; return; }
            if (inTemple(player, altar)) {
                this.watchdog.notifyActivity();
                this.craftInteracted = false;
                this.craftWait = 0;
                this.tries = 0;
                this.state = 'craft';
                return;
            }
            // port: the Cosmic ruins are in Zanaris: through the shed's door first
            if (altar.staff && !(player.level === 0 && isZanaris(player.x, player.z))) {
                this.tries = 0;
                this.state = 'to_zanaris';
                return;
            }
            if (player.delayed) return; // (the ruins' pull: p_delay 1, then the jump)
            const [rx, rz] = altar.ruins;
            const ruins = isNear(player, rx + 1, rz + 1, 8) ? findLocByName(player.x, player.z, player.level, altar.ruinsLoc, 10) : null;
            if (!ruins) {
                this._walk(player, rx + 1, rz + 1);
                return;
            }
            const slot = this._slotOf(player, altar.talismanId);
            if (slot === -1 || ++this.tries > 4) {
                this._log(player, `cannot enter the ${altar.name} ruins → bank`, 'ruins_fail');
                this.state = 'bank_walk';
                return;
            }
            interactUseLocOp(player, ruins, altar.talismanId, slot);
            noteMove(player, 'event'); // (Track D, ISS-12: the ruins pull it into the temple)
            this.cooldown = 6;
            return;
        }

        // ── CRAFT RUNES ───────────────────────────────────────────────────────
        if (this.state === 'craft') {
            if (!this.currentAltar) { this.state = 'check_altar'; return; }

            if (!this.craftInteracted) {
                // port: the altar is "<name>_altar" in 274 (air_altar); upstream looked for one named "altar", found
                // none, and converted the essence itself. Clicked (Craft-rune), 274 binds the runes and gives the XP
                // port: within 24: the Cosmic temple puts the bot on one of four ledges 20 tiles from its altar
                const altarLoc: Loc | null = findLocByName(player.x, player.z, player.level, `${this.currentAltar.name.toLowerCase()}_altar`, 24);
                if (!altarLoc || ++this.tries > 3) {
                    this._log(player, 'the altar does not answer → portal, end', 'altar_fail');
                    this.failed = true;
                    this.tries = 0;
                    this.state = 'altar_exit';
                    return;
                }
                interactLoc(player, altarLoc);
                this.craftInteracted = true;
                this.craftWait = 0;
                this.cooldown = 2;
                return;
            }

            // port: only the game binds the runes (upstream converted the essence itself after any delay)
            if (countItem(player, Items.RUNE_ESSENCE) > 0) {
                // (port: not while it walks there: the Cosmic altar is 20 tiles away)
                if (!player.hasWaypoints() && ++this.craftWait >= 12) this.craftInteracted = false; // clicked again
                return;
            }
            this._log(player, `crafted ${this.currentAltar.name} runes`, 'crafted');
            this.watchdog.notifyActivity();
            this.craftInteracted = false;
            this.tries = 0;
            this.state = 'altar_exit';
            this.cooldown = 2;
            return;
        }

        // ── ALTAR EXIT: the temple's portal, then the next run ─────────────────
        if (this.state === 'altar_exit') {
            const altar = this.currentAltar;
            if (!altar) { this.state = 'check_altar'; return; }
            if (!inTemple(player, altar)) {
                this.watchdog.notifyActivity();
                if (this.failed) { this.interrupt(); return; }
                // Re-evaluate the altar for level-ups: a better one needs its talisman (the bank); else straight back
                // to Aubury, the runes stack in one slot
                const nextAltar = this._pickBestAltar(player);
                this.tries = 0;
                if (nextAltar && nextAltar !== altar) {
                    this._log(player, `altar upgrade: ${altar.name} → ${nextAltar.name} — banking`, 'altar_up');
                    this.currentAltar = nextAltar;
                    this.pickaxeId    = this._bestPickaxe(player);
                    this.state        = 'bank_walk';
                } else {
                    this.state = 'to_mine';
                }
                return;
            }
            if (botContinuePage(player) || player.delayed) return;
            const portal = findLocByName(player.x, player.z, player.level, altar.portalLoc, 30);
            if (!portal || ++this.tries > 4) {
                this._log(player, 'no way out of the temple → rescue', 'temple_stuck');
                teleportNear(player, altar.ruins[0] + 1, altar.ruins[1] + 1); // port: out of sight only; else it tries again
                this.tries = 0;
                return;
            }
            interactLocOp(player, portal, 1);
            noteMove(player, 'event'); // (Track D, ISS-12: the temple's portal puts it by the ruins)
            this.cooldown = 4;
            return;
        }
    }

    override reset(): void {
        super.reset();
        this.state            = 'check_altar';
        this.currentAltar     = null;
        this.currentRock      = null;
        this.lastEssenceCount = 0;
        this.interactTicks    = 0;
        this.scanFailTicks    = 0;
        this.approachTicks    = 0;
        this.mineTimeouts     = 0;
        this.craftInteracted  = false;
        this.tries            = 0;
        this.failed           = false;
        this.realm            = null;
        this.stuck.reset();
        this.watchdog.reset();
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /** port: where the trip is headed now, for the watchdog's rescue (outside: Aubury or the ruins; inside: the mine or the altar) */
    private _destination(): [number, number, number] | undefined {
        switch (this.state) {
            case 'to_mine':
            case 'mine_exit':
                return [AUBURY[0], AUBURY[1], 0];
            case 'mine_approach':
            case 'mine_scan':
            case 'mine_interact':
                return [...Locations.ESSENCE_MINE] as [number, number, number];
            case 'to_zanaris':
                return [...Locations.ZANARIS_SHED] as [number, number, number];
            case 'to_ruins':
                return this.currentAltar ? [this.currentAltar.ruins[0] + 1, this.currentAltar.ruins[1] + 1, 0] : undefined;
            case 'craft':
            case 'altar_exit':
                return this.currentAltar?.location;
            default:
                return undefined;
        }
    }

    /** port: a walk with the stuck detector (as the gathering tasks walk): a gate opened, a step aside, an unseen rescue */
    private _walk(player: Player, x: number, z: number): void {
        if (!this.stuck.check(player, x, z)) {
            walkTo(player, x, z);
            return;
        }
        if (this.stuck.desperatelyStuck) {
            teleportNear(player, x, z);
            this.stuck.reset();
            return;
        }
        if (openNearbyGate(player, 5)) return;
        walkTo(player, player.x + randInt(-8, 8), player.z + randInt(-8, 8));
    }

    /** port: the pack slot holding `itemId`, or -1 */
    private _slotOf(player: Player, itemId: number): number {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return -1;
        for (let slot = 0; slot < inv.capacity; slot++) if (inv.get(slot)?.id === itemId) return slot;
        return -1;
    }

    /** port: is the bot wearing `itemId`? */
    private _wearing(player: Player, itemId: number): boolean {
        const worn = player.getInventory(InvType.WORN);
        if (!worn) return false;
        for (let slot = 0; slot < worn.capacity; slot++) if (worn.get(slot)?.id === itemId) return true;
        return false;
    }

    /** port: the staff worn, wielded from the pack (274's own Wield); true once it is on */
    private _wearStaff(player: Player, staff: number): boolean {
        if (this._wearing(player, staff)) return true;
        const inv = player.getInventory(InvType.INV);
        const slot = this._slotOf(player, staff);
        if (!inv || slot === -1) return false;
        interactHeldOp(player, inv, staff, slot, 2);
        return this._wearing(player, staff);
    }

    private _log(player: Player | null, msg: string, key?: string): void {
        const now    = Date.now();
        const logKey = key ?? msg;
        if (this.lastLogKey === logKey && now - this.lastLogTime < 750) return;
        this.lastLogKey  = logKey;
        this.lastLogTime = now;
        const prefix = player ? `[P:${player.x},${player.z}]` : '[BOT]';
        console.log(`${prefix} [RunecraftingTask] ${msg}`);
    }

    /**
     * Selects the highest-tier altar the bot qualifies for:
     *   1. RC level meets the altar's minimum requirement.
     *   2. The matching talisman exists in inventory OR bank.
     */
    private _pickBestAltar(player: Player): AltarDef | null {
        const level  = getBaseLevel(player, PlayerStat.RUNECRAFT);
        const bid    = bankInvId();
        const bank   = bid !== -1 ? player.getInventory(bid) : null;

        for (const altar of ALTARS) {
            if (level < altar.levelReq || !altar.walkable) continue;
            // port: on a free world, the free altars only (upstream sent a bot with a nature talisman to Karamja)
            if (!isMembersWorld() && (ObjType.get(altar.talismanId).members || !isAllowedCoord(altar.location[0], altar.location[1]))) continue;

            let talisman = hasItem(player, altar.talismanId);
            for (let i = 0; !talisman && bank && i < bank.capacity; i++) talisman = bank.get(i)?.id === altar.talismanId;
            if (!talisman) continue;
            // port: the Cosmic ruins only with the dramen staff (worn, carried or banked): one that has none finds it in
            // its bank now (UtilTasks.keepQuestItems: Lost City is done)
            if (altar.staff) {
                keepQuestItems(player);
                if (!owns(player, altar.staff)) continue;
            }
            return altar;
        }
        return null;
    }

    private _hasPickaxe(player: Player): boolean {
        for (const id of PICKAXE_IDS) {
            if (hasItem(player, id)) return true;
        }
        const bid = bankInvId();
        if (bid !== -1) {
            const bank = player.getInventory(bid);
            if (bank) {
                for (const id of PICKAXE_IDS) {
                    for (let i = 0; i < bank.capacity; i++) {
                        if (bank.get(i)?.id === id) return true;
                    }
                }
            }
        }
        return false;
    }

    private _bestPickaxe(player: Player): number {
        for (const id of PICKAXE_IDS) {
            if (hasItem(player, id)) return id;
        }
        const bid = bankInvId();
        if (bid !== -1) {
            const bank = player.getInventory(bid);
            if (bank) {
                for (const id of PICKAXE_IDS) {
                    for (let i = 0; i < bank.capacity; i++) {
                        if (bank.get(i)?.id === id) return id;
                    }
                }
            }
        }
        return Items.BRONZE_PICKAXE;
    }

    /**
     * Deposits everything except the current talisman and best pickaxe,
     * then withdraws those two items from the bank if not already in inventory.
     * port: and the altar's staff (Cosmic: the dramen staff), unless it is worn.
     */
    private _bankDeposit(player: Player): void {
        const bid = bankInvId();
        if (bid === -1) return;

        const inv  = player.getInventory(InvType.INV);
        const bank = player.getInventory(bid);
        if (!inv || !bank) return;

        const talismanId = this.currentAltar?.talismanId ?? -1;
        const staff      = this.currentAltar?.staff;
        const keep       = new Set<number>();
        if (talismanId !== -1) keep.add(talismanId);
        keep.add(this.pickaxeId);
        if (staff) keep.add(staff);

        // ── Deposit everything not in keep set ────────────────────────────────
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item || keep.has(item.id)) continue;
            const moved = inv.remove(item.id, item.count);
            if (moved > 0) bank.add(bankedId(item.id), moved);
        }

        // ── Withdraw talisman if not in inventory ─────────────────────────────
        if (talismanId !== -1 && !hasItem(player, talismanId)) {
            for (let i = 0; i < bank.capacity; i++) {
                const it = bank.get(i);
                if (it?.id === talismanId) {
                    moveItems(bank, inv, talismanId, 1);
                    this._log(null, `withdrew ${this.currentAltar?.name} talisman from bank`, 'talis_out');
                    break;
                }
            }
        }

        // ── port: the altar's staff, if not worn or carried ───────────────────
        if (staff && !this._wearing(player, staff) && !hasItem(player, staff) && moveItems(bank, inv, staff, 1) > 0) {
            this._log(null, `withdrew the staff (${staff}) from bank`, 'staff_out');
        }

        // ── Withdraw pickaxe if not in inventory ──────────────────────────────
        if (!hasItem(player, this.pickaxeId)) {
            outer: for (const id of PICKAXE_IDS) {
                for (let i = 0; i < bank.capacity; i++) {
                    const it = bank.get(i);
                    if (it?.id === id) {
                        moveItems(bank, inv, id, 1);
                        this.pickaxeId = id;
                        this._log(null, `withdrew pickaxe (${id}) from bank`, 'pick_out');
                        break outer;
                    }
                }
            }
        }

        this._log(null, `bank deposit done — keeping talisman ${talismanId} + pickaxe ${this.pickaxeId}`, 'deposit_done');
    }

    /**
     * Finds the nearest Rune Essence rock.
     * Tries display name first, then internal name variants (mirrors _findRock in MiningTask).
     */
    private _findEssenceRock(player: Player): Loc | null {
        return (
 // port: 30 tiles: the mine's four rocks are about 20 from its middle, where Aubury's teleport often lands
            findLocByName(player.x, player.z, player.level, 'blankrunestone', 30) ??
            findLocByPrefix(player.x, player.z, player.level, 'blankrunestone', 30, 'portal') // port: not blankrunestone_exit_portal (274)

        );
    }
}
