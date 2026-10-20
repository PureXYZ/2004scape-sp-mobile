// port: smarter PKers (Phase 3): what 2004's PKers did that upstream's did not, for both PK tasks
// (tasks/PKerTask, tasks/EdgevillePKerTask):
//   - prayers, pressed on the prayer tab as a player does (274's [if_button,prayer:prayer_*]: the game checks the level
//     and the points, and drains them): Protect Item, and the protection against the target's style (its weapon: a bow
//     or a crossbow, a staff, else melee), at the start of a fight and when the target switches; off again after it;
//     no protection prayer at Edgeville (Melee, Missiles or Magic; Protect Item kept):
//     2004's edge PKers held praying "no honour", and called out a target who prayed ("no honour", "turn ur pray off");
//   - (round 2, 2026-10-19: "offensive prayers") the melee boosts, the best Strength and Attack prayers its
//     level has (Ultimate Strength 31, Incredible Reflexes 34; Superhuman 13, Improved 16; Burst 4, Clarity 7), when the
//     fight wants them (port/BotPkFight offence: all fight long, or for the KO), at Edgeville too (honour is protection
//     only); 274 has none for Ranged or Magic;
//   - "sit" or "gf" to the player it killed;
//   - (play-testing: the ditch "a little too quiet", "like trash talk") an Edgeville fight's banter (pkBanter): a
//     taunt now and then, a word after a big hit either way, when the target eats, at its last Hitpoints or its own, and
//     the target's answer to a taunt ("talk after", "u wish").
// (PK tactics) the bow for a target that kept off went: a melee PKer has no bow, a ranger
// fights with it all along; when to get out, eating, potions and the KO are port/BotPkFight's.
import ObjType from '#/cache/config/ObjType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import InvType from '#/cache/config/InvType.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import { interactIfButtonByName, interactPlayerOp } from '#/engine/bot/BotAction.js';
import { botSay } from '#/engine/bot/port/BotSay.js';
import { pkLine, type PkLineKind } from '#/engine/bot/port/BotLines.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import World from '#/engine/World.js';


/** port: a PK line, when one of its own is fresh (port/BotLines pkLine); else nothing */
function sayPk(player: Player, line: string | null): void {
    if (line !== null) botSay(player, line, undefined, 'pk');
}

type Style = 'melee' | 'missiles' | 'magic';

/** the prayers a PKer uses: its button, the varp that shows it on, the Prayer level it needs (274's prayers.dbrow) */
const PRAYERS = {
    protectItem: { button: 'prayer:prayer_protectitems', varp: 'prayer8', level: 25 },
    magic: { button: 'prayer:prayer_protectfrommagic', varp: 'prayer12', level: 37 },
    missiles: { button: 'prayer:prayer_protectfrommissiles', varp: 'prayer13', level: 40 },
    melee: { button: 'prayer:prayer_protectfrommelee', varp: 'prayer14', level: 43 },
    burst: { button: 'prayer:prayer_strengthburst', varp: 'prayer1', level: 4 },
    clarity: { button: 'prayer:prayer_clarity', varp: 'prayer2', level: 7 },
    superhuman: { button: 'prayer:prayer_superhumanstrength', varp: 'prayer4', level: 13 },
    improved: { button: 'prayer:prayer_improvedreflexes', varp: 'prayer5', level: 16 },
    ultimate: { button: 'prayer:prayer_ultimatestrength', varp: 'prayer10', level: 31 },
    incredible: { button: 'prayer:prayer_incrediblereflexes', varp: 'prayer11', level: 34 }
} as const;
/** (round 2) the melee boosts by kind, best first (274: one turned on turns the others of its kind off) */
const BOOSTS: readonly (readonly BoostKey[])[] = [
    ['ultimate', 'superhuman', 'burst'],
    ['incredible', 'improved', 'clarity']
];
type PrayerKey = keyof typeof PRAYERS;
type BoostKey = 'burst' | 'clarity' | 'superhuman' | 'improved' | 'ultimate' | 'incredible';

function prayerOn(player: Player, key: PrayerKey): boolean {
    const varp = VarPlayerType.getByName(PRAYERS[key].varp);
    return varp !== null && varp !== undefined && player.getVar(varp.id) === 1;
}

/** the target's style, from what it wields (a bow, a crossbow: missiles; a staff: magic; else melee) */
export function pkStyleOf(target: Player): Style {
    const weapon = target.getInventory(InvType.WORN)?.get(3);
    const name = weapon ? (ObjType.get(weapon.id).name ?? '').toLowerCase() : '';
    if (/\bbow\b|shortbow|longbow|crossbow|dart|knife|javelin|thrownaxe/.test(name)) return 'missiles';
    if (/staff|wand/.test(name)) return 'magic';
    return 'melee';
}

/** how a PKer fights */
export interface PkCode {
    /** an Edgeville PKer's honour: no protection prayer, Melee, Missiles or Magic (2004's edge held praying "no honour") */
    honour?: boolean;
    /** (2026-10-19) the fight's banter (pkBanter): an Edgeville PKer's */
    banter?: boolean;
    /** (round 2) its melee boost prayers on this tick (port/BotPkFight offence); else off */
    offence?: boolean;
}

/**
 * The prayers for this fight, one button a tick: Protect Item, then the protection against the target's style (the
 * other two off; with honour, none of the three). True when it pressed one: 274's prayer script clears the pending
 * action, so the attack is clicked again. Nothing without the Prayer level or the points (the game says no; the bot does
 * not try).
 */
export function pkPrayers(player: Player, target: Player, code: PkCode = {}): boolean {
    if (player.levels[PlayerStat.PRAYER] <= 0) return false;
    const level = player.baseLevels[PlayerStat.PRAYER];
    if (level >= PRAYERS.protectItem.level && !prayerOn(player, 'protectItem')) return press(player, 'protectItem');
    const style = pkStyleOf(target);
    const want = code.honour ? null : style;
    for (const key of ['magic', 'missiles', 'melee'] as const) {
        if (key !== want && prayerOn(player, key)) return press(player, key);
    }
    if (want !== null && level >= PRAYERS[want].level && !prayerOn(player, want)) return press(player, want);
    // (round 2) the melee boosts: the best of each kind its level has when the fight wants them, else off
    for (const kind of BOOSTS) {
        const best = code.offence ? kind.find(key => level >= PRAYERS[key].level) : undefined;
        if (best !== undefined) {
            if (!prayerOn(player, best)) return press(player, best);
            continue;
        }
        for (const key of kind) if (prayerOn(player, key)) return press(player, key);
    }
    return false;
}

/** Every prayer of the fight off, one a tick (after it: they drain the points). True while it pressed one. */
export function pkPrayersOff(player: Player): boolean {
    for (const key of ['magic', 'missiles', 'melee', 'protectItem', ...BOOSTS.flat()] as const) {
        if (prayerOn(player, key)) return press(player, key);
    }
    return false;
}

function press(player: Player, key: PrayerKey): boolean {
    return interactIfButtonByName(player, PRAYERS[key].button);
}

/** what a PKer says to the player it killed */
/** (no "gf noob": the game's filter masks "noob"; upstream's fight taunts keep theirs, as 2004 did) */
export const KILL_LINES: readonly string[] = ['sit', 'gf', 'ez', 'sit kid', 'cya in lumby', 'gf gear'];
/** what it says running out of the Wilderness, beaten (now and then) */
export const ESCAPE_LINES: readonly string[] = ['brb', 'gtg', 'out of food', 'lag'];
/** (2026-10-18) an Edgeville PKer calls out a target with a protection prayer on this often, once a fight (its lines: lines2004.json pk.honour) */
export const HONOUR_CALL = 0.7;

/** what an engage remembers between ticks for its tactics */
export interface PkTactics {
    /** the player it said its kill line to */
    killLineFor: Player | null;
    /** (2026-10-18) the target it saw with a protection prayer on this fight, and whether its call-out is still to say (decided then) */
    honour: { target: Player; due: boolean } | null;
    /** (2026-10-19) the banter's view of the fight: the Hitpoints at the last tick (its own, the target's), the once-a-fight lines said */
    banter: { target: Player | null; own: number; theirs: number; low: boolean; lag: boolean };
}

export function newPkTactics(): PkTactics {
    return { killLineFor: null, honour: null, banter: { target: null, own: -1, theirs: -1, low: false, lag: false } };
}

/** a line as it gets out of the Wilderness (now and then) */
export function pkSayEscape(player: Player): void {
    if (Math.random() < 0.5) sayPk(player, pkLine(player, 'escape', ESCAPE_LINES));
}

/** (PK tactics, 2026-10-19) a line at a target that ran or teleported off, now and then */
export const RAN_CALL = 0.4;
export function pkSayRan(player: Player): void {
    if (Math.random() < RAN_CALL) sayPk(player, pkLine(player, 'ran', []));
}

/** (round 2) a line at a PJer (attacked again just after its own fight: port/BotPkPj), now and then */
export const PJED_CALL = 0.4;
/** a fight ended this recently (ticks) makes the next attacker a PJer */
export const PJED_WITHIN = 30;
export function pkSayPjed(player: Player): void {
    if (Math.random() < PJED_CALL) sayPk(player, pkLine(player, 'pjed', []));
}

/**
 * A tick of an engage's tactics, after the task's own checks (the target still there, in range, not a stalemate):
 * 'killed' (the target's Hitpoints are gone: a kill line, once; the fight is over), else null (fight on: the prayers).
 */
export function pkEngageTactics(player: Player, target: Player, tactics: PkTactics, code: PkCode = {}): 'killed' | null {
    if ((target.levels[PlayerStat.HITPOINTS] ?? 1) <= 0) {
        if (tactics.killLineFor !== target) {
            tactics.killLineFor = target;
            // port (the realism work, phase 2): its own few lines of this pool and the 2004 ones (port/BotLines pkLine)
            if (Math.random() < 0.7) sayPk(player, pkLine(player, 'kill', KILL_LINES));
        }
        return 'killed';
    }
    // (2026-10-18) with honour, a target with a protection prayer on (Melee, Missiles or Magic) is called out, once a
    // fight, now and then (as soon as a PK line may come: pkLine keeps them a few seconds apart)
    if (code.honour && (prayerOn(target, 'melee') || prayerOn(target, 'missiles') || prayerOn(target, 'magic'))) {
        if (tactics.honour?.target !== target) tactics.honour = { target, due: Math.random() < HONOUR_CALL };
        if (tactics.honour.due) {
            const line = pkLine(player, 'honour', []);
            if (line !== null) {
                sayPk(player, line);
                tactics.honour.due = false;
            }
        }
    }
    if (code.banter) pkBanter(player, target, tactics.banter);
    // (a prayer pressed clears the attack: it is clicked again)
    if (pkPrayers(player, target, code)) interactPlayerOp(player, target.slot, 2);
    return null;
}

// ── the fight's banter (play-testing: "a little too quiet", "like trash talk") ──────────────────────────────

/** a taunt's chance a tick of a fight (a talkative PKer's: about one in 25 s; pkLine keeps its lines 12 ticks apart) */
export const BANTER_TAUNT = 1 / 40;
/** a hit this big (Hitpoints in one tick, or a fifth of the base) is worth a word, either way */
const BIG_HIT = 12;
/** each moment's chance (times the PKer's talkiness) */
export const BANTER_CHANCE: Readonly<Record<'hit' | 'lucky' | 'ate' | 'low' | 'lag' | 'back', number>> = { hit: 0.35, lucky: 0.3, ate: 0.12, low: 0.5, lag: 0.3, back: 0.45 };
/** an answer to a taunt comes this many ticks after it (reading it, typing) */
const BACK_DELAY: [number, number] = [3, 7];
/** the answer each PKer owes (to whom, from when) */
const owed = new WeakMap<Player, { to: Player; at: number }>();

/** how much a PKer talks in a fight (0.3-1.7, from its name: some never stop, some hardly say a word) */
function talkiness(player: Player): number {
    return 0.3 + 1.4 * seededRandom(nameSeed(player.username, 'pk-banter'))();
}

/**
 * A tick of an Edgeville fight's banter: an answer it owes to the target's taunt, a word at a moment of the fight (a big
 * hit either way, the target eating, the target's last Hitpoints or its own, each of the last two once a fight), or a
 * taunt now and then. A taunt or a hit's word to a bot that fights back may get its answer ('back').
 */
export function pkBanter(player: Player, target: Player, b: PkTactics['banter'], random: () => number = Math.random): void {
    const now = World.currentTick;
    const own = player.levels[PlayerStat.HITPOINTS] ?? 0;
    const theirs = target.levels[PlayerStat.HITPOINTS] ?? 0;
    if (b.target !== target) {
        b.target = target;
        b.low = false;
        b.lag = false;
    } else {
        const talk = talkiness(player);
        const big = (base: number): number => Math.min(BIG_HIT, Math.ceil(base / 5));
        let owes = owed.get(player);
        // (one for another fight, or one it never got the chance to say, is forgotten)
        if (owes && (owes.to !== target || now - owes.at > 20)) {
            owed.delete(player);
            owes = undefined;
        }
        let said: PkLineKind | null = null;
        if (owes && now >= owes.at) {
            owed.delete(player);
            if (say(player, 'back')) said = 'back';
        } else if (!b.low && theirs > 0 && theirs <= target.baseLevels[PlayerStat.HITPOINTS] / 4) {
            b.low = true;
            if (random() < BANTER_CHANCE.low * talk && say(player, 'low')) said = 'low';
        } else if (!b.lag && own > 0 && own <= player.baseLevels[PlayerStat.HITPOINTS] / 4) {
            b.lag = true;
            if (random() < BANTER_CHANCE.lag * talk && say(player, 'lag')) said = 'lag';
        } else if (b.theirs - theirs >= big(target.baseLevels[PlayerStat.HITPOINTS])) {
            if (random() < BANTER_CHANCE.hit * talk && say(player, 'hit')) said = 'hit';
        } else if (b.own - own >= big(player.baseLevels[PlayerStat.HITPOINTS])) {
            if (random() < BANTER_CHANCE.lucky * talk && say(player, 'lucky')) said = 'lucky';
        } else if (theirs > b.theirs && b.theirs > 0) {
            if (random() < BANTER_CHANCE.ate * talk && say(player, 'ate')) said = 'ate';
        } else if (random() < BANTER_TAUNT * talk && say(player, 'taunt')) {
            said = 'taunt';
        }
        // (a bot fighting back may answer it, a moment later, if it has not one to say already)
        if ((said === 'taunt' || said === 'hit' || said === 'low' || said === 'ate') && target.is_bot && !owed.has(target) && random() < BANTER_CHANCE.back * talkiness(target)) {
            owed.set(target, { to: player, at: now + BACK_DELAY[0] + Math.floor(random() * (BACK_DELAY[1] - BACK_DELAY[0] + 1)) });
        }
    }
    b.own = own;
    b.theirs = theirs;
}

function say(player: Player, kind: PkLineKind): boolean {
    const line = pkLine(player, kind, []);
    sayPk(player, line);
    return line !== null;
}
