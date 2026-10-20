// port: a bot's emotes (Phase 3: livelier chat): it presses the emote buttons of 274's controls tab,
// as a player does, and the game plays the animation (player_controls.rs2: [if_button,controls:com_N] @controls_emote).
// A wave with a greeting or a goodbye, a laugh at a joke, a dance when asked, a cheer at its own level-up. Since the
// realism work's phase 5b, all twelve of the tab's standard emotes (the set pieces: cheering and clapping at a duel,
// dancing at a party, a bow from the host, a beckon to come).
// By design ("emotes should be rare and special") the everyday ones (a
// regular's wave, a hang-out's fidget, a "dance!" line, a level's cheer) go through everydayEmote: one a bot in an hour
// at most, and each of them rare. The set pieces (a party, a duel) and the answers to the human (a wave back, a dance
// when asked) press the button straight away.
import World from '#/engine/World.js';
import Loc from '#/engine/entity/Loc.js';
import type Player from '#/engine/entity/Player.js';
import { botScript, interactIfButtonByName } from '#/engine/bot/BotAction.js';
import { noteSpectacle } from '#/engine/bot/port/BotHabits.js';

// (274's controls interface, com_13-com_24 in its order: player_controls.rs2:53-64)
const BUTTONS = {
    cry: 'controls:com_13',
    think: 'controls:com_14',
    wave: 'controls:com_15',
    bow: 'controls:com_16',
    angry: 'controls:com_17',
    dance: 'controls:com_18',
    beckon: 'controls:com_19',
    yes: 'controls:com_20',
    no: 'controls:com_21',
    laugh: 'controls:com_22',
    cheer: 'controls:com_23',
    clap: 'controls:com_24'
} as const;

export type Emote = keyof typeof BUTTONS;

/** every emote the bots use, in the tab's order (the tests) */
export const EMOTES: readonly Emote[] = Object.keys(BUTTONS) as Emote[];

/** an everyday emote this many ticks after the bot's last emote at the earliest (an hour) */
export const EVERYDAY_REST_TICKS = 6000;

/** each bot's last emote (the tick) */
const lastEmote = new WeakMap<Player, number>();

/**
 * The bot does the emote, unless it is busy: in a script or a trade, or at something (a tree, a monster, a player:
 * the emote's script stops what a player is doing, and the bot would stand idle until its task noticed). `atWork`: a
 * tree or a rock does not stop it (a cheer at a milestone level, which comes mid-chop). Never with a screen open (phase
 * 5b: a stake's window, a bank, a shop: a player's emote tab is behind it). False when it does none.
 */
export function botEmote(bot: Player, emote: Emote, atWork = false): boolean {
    if (bot.delayed || botScript(bot) !== null || bot.botTradeTargetPid !== -1) return false;
    if (bot.modalMain !== -1 || bot.modalSide !== -1) return false;
    if (bot.target !== null && !(atWork && bot.target instanceof Loc)) return false;
    if (!interactIfButtonByName(bot, BUTTONS[emote])) return false;
    lastEmote.set(bot, World.currentTick);
    // port (the realism work): a cheer or a dance draws a look from the bots around (port/BotHabits)
    if (emote === 'cheer' || emote === 'dance') noteSpectacle(bot, emote);
    return true;
}

/**
 * An everyday emote (no set piece, no answer to the human): botEmote, but only when the bot's last emote is an hour
 * back (EVERYDAY_REST_TICKS). False when it does none.
 */
export function everydayEmote(bot: Player, emote: Emote, atWork = false): boolean {
    const last = lastEmote.get(bot);
    if (last !== undefined && World.currentTick - last < EVERYDAY_REST_TICKS) return false;
    return botEmote(bot, emote, atWork);
}
