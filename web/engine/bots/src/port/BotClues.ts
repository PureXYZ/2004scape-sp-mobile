// port (the variety work, round 2, Track M: members places and minigames; "a Treasure Trail" extra): what a bot
// knows of 274's easy clue scrolls (game_trail), as a 2004 player knew them from a guide.
//   - A clue's step is the game's own data: its trail_coord param is where to dig (a map, the giant mushrooms) or, with
//     trail_loc, the crate, drawer, chest or boxes to search there; a clue with neither names someone to talk to (its
//     trail_desc), and the NPC whose script takes it is listed here (TALK_CLUES, from the scripts that call
//     ~progress_clue_easy: Hans, Zeke, the tanner, the bartenders of the Blue Moon and the Rusty Anchor, the squire, Ned,
//     Doric, Gaius, Arhein, Sir Kay, a Port Sarim sailor, Louisa the cook, a Duel Arena spectator).
//   - A step the bots cannot do yet is 'skip' (upstairs, underground: their task gives the clue up, as 2004's players
//     dropped a clue they could not do).
//   - Clues drop from 274's own drop tables (goblins, men, barbarians, rock crabs ...: trail_easycluedrop, members worlds
//     only), and fighters pick them up with their loot (CombatTask), as players did.
import type Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import ParamType from '#/cache/config/ParamType.js';
import { ParamHelper } from '#/cache/config/ParamHelper.js';

export type ClueStep =
    | { kind: 'dig'; at: [number, number, number] }
    | { kind: 'search'; at: [number, number, number] }
    | { kind: 'talk'; npcs: readonly string[]; at: [number, number, number] }
    | { kind: 'skip'; why: string };

/** the easy clues that name someone to talk to: the NPC (its debugnames) whose script takes the clue, and where it stands */
const TALK_CLUES: Readonly<Record<string, { npcs: readonly string[]; at: [number, number, number] }>> = {
    trail_clue_easy_simple005: { npcs: ['hans'], at: [3207, 3233, 0] },
    trail_clue_easy_simple007: { npcs: ['zeke'], at: [3288, 3190, 0] },
    trail_clue_easy_simple008: { npcs: ['tanner'], at: [3276, 3193, 0] },
    trail_clue_easy_simple010: { npcs: ['bluemoon_bartender'], at: [3226, 3399, 0] },
    trail_clue_easy_simple017: { npcs: ['squire'], at: [2977, 3342, 0] },
    trail_clue_easy_simple020: { npcs: ['rustyanchor_bartender'], at: [3045, 3257, 0] },
    trail_clue_easy_simple021: { npcs: ['ned'], at: [3100, 3258, 0] },
    trail_clue_easy_simple022: { npcs: ['doric'], at: [2952, 3451, 0] },
    trail_clue_easy_simple023: { npcs: ['gaius'], at: [2885, 3449, 0] },
    trail_clue_easy_simple025: { npcs: ['arhein'], at: [2803, 3430, 0] },
    trail_clue_easy_simple026: { npcs: ['sir_kay'], at: [2761, 3497, 0] },
    trail_clue_easy_vague012: { npcs: ['captain_tobias', 'seaman_lorris', 'seaman_thresnor'], at: [3028, 3216, 0] },
    trail_clue_easy_vague028: { npcs: ['louisa_the_cook'], at: [2734, 3581, 0] },
    trail_clue_easy_vague029: { npcs: ['duel_crowdmale1', 'duel_crowdfemale1', 'duel_crowdmale2', 'duel_crowdmale3'], at: [3329, 3234, 0] }
};

let params: { coord: number; loc: number } | null = null;
function paramIds(): { coord: number; loc: number } {
    return (params ??= { coord: ParamType.getId('trail_coord'), loc: ParamType.getId('trail_loc') });
}

/** an easy clue scroll (not its casket, not a medium or hard one) */
export function isEasyClue(id: number): boolean {
    const name = ObjType.get(id)?.debugname ?? '';
    return name.startsWith('trail_clue_easy_') && !name.endsWith('_casket');
}

/** any clue scroll (easy, medium, hard) */
export function isClue(id: number): boolean {
    const name = ObjType.get(id)?.debugname ?? '';
    return name.startsWith('trail_clue_') && !name.endsWith('_casket');
}

/** an easy clue's casket (from a dig: opened, the next clue or the reward) */
export function isEasyCasket(id: number): boolean {
    const name = ObjType.get(id)?.debugname ?? '';
    return (name.startsWith('trail_clue_easy_') && name.endsWith('_casket')) || name === 'trail_casket_easy';
}

/** The step of an easy clue, from the game's data (and the talk table); 'skip' for one the bots cannot do yet. */
export function clueStep(id: number): ClueStep {
    const type = ObjType.get(id);
    if (!type || !isEasyClue(id)) return { kind: 'skip', why: 'not an easy clue' };
    const talk = TALK_CLUES[type.debugname ?? ''];
    if (talk) return { kind: 'talk', npcs: talk.npcs, at: talk.at };
    const { coord, loc } = paramIds();
    const packed = coord === -1 ? -1 : ParamHelper.getIntParam(coord, type, -1);
    if (packed === -1) return { kind: 'skip', why: 'unknown' };
    const level = (packed >> 28) & 0x3;
    const x = (packed >> 14) & 0x3fff;
    const z = packed & 0x3fff;
    if (level !== 0) return { kind: 'skip', why: 'upstairs' };
    if (z >= 6400) return { kind: 'skip', why: 'underground' };
    const search = loc !== -1 && ParamHelper.getIntParam(loc, type, 0) === 1;
    return search ? { kind: 'search', at: [x, z, 0] } : { kind: 'dig', at: [x, z, 0] };
}

/** the easy clue or casket the bot carries (pack): its id and slot, or null (a medium or hard one is kept, untouched) */
export function carriedTrailItem(player: Player): { id: number; slot: number; casket: boolean } | null {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return null;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const it = inv.get(slot);
        if (!it) continue;
        if (isEasyCasket(it.id)) return { id: it.id, slot, casket: true };
        if (isEasyClue(it.id)) return { id: it.id, slot, casket: false };
    }
    return null;
}

/** an easy clue (or casket) in the bot's bank: its id, or -1 */
export function bankedEasyClue(player: Player, bankId: number): number {
    const bank = bankId === -1 ? null : player.getInventory(bankId);
    if (!bank) return -1;
    for (let slot = 0; slot < bank.capacity; slot++) {
        const it = bank.get(slot);
        if (it && (isEasyClue(it.id) || isEasyCasket(it.id))) return it.id;
    }
    return -1;
}

/** the spades lying about the map (274's spawns: Falador's garden, Draynor Manor's, East Ardougne), for a dig without one */
export const SPADE_SPAWNS: readonly [number, number, number][] = [
    [2981, 3369, 0],
    [3120, 3359, 0],
    [2574, 3331, 0]
];
