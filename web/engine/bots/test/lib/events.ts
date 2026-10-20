// test/randomevents.test.mjs's world (the realism work, phase 5a, Track E: random events on bots near the human):
// test/lib/simworld.ts with the random events (port/BotRandomEvents, port/RandomEventTask) and what the checks read
// besides (the game's variables and configs, the bot actions a check drives a frozen bot with), through one module graph.
export * from './simworld.js';
export {
    armForTest,
    rollForTest,
    pendingForTest,
    failRecoveryForTest,
    rollStats,
    eligible,
    eventKindOfNpc,
    eventStateOf,
    failExitFor,
    failTeleportSpots,
    FAIL_TELEPORT_EXITS,
    holdsLogout,
    inMazeZone,
    inMimeZone,
    isArmed,
    isEventHazard,
    npcInt,
    randomEventListeners,
    resetRandomEventsForTest,
    setEventRatesForTest,
    zonesAfk,
    ROLL_TICKS,
    EVENT_GAP_TICKS,
    BOT_GAP_TICKS,
    ARM_DISTANCE,
    DISARM_DISTANCE
} from '#/engine/bot/port/BotRandomEvents.js';
export { lampSkill, responseDue } from '#/engine/bot/port/RandomEventTask.js';
export { default as VarPlayerType } from '#/cache/config/VarPlayerType.js';
export { default as VarNpcType } from '#/cache/config/VarNpcType.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { default as EnumType } from '#/cache/config/EnumType.js';
export { default as Component } from '#/cache/config/Component.js';
export { CoordGrid } from '#/engine/CoordGrid.js';
export { chatterStateOf } from '#/engine/bot/port/BotChatter.js';
export { NEW_LINES, pickLine, contextOf, kindFits } from '#/engine/bot/port/BotLines.js';
export { addItem, botScript, countItem, freeSlots, interactLocOp, interactNpcOp, findAggressorNpc } from '#/engine/bot/BotAction.js';
export { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { setHangoutRateForTest } from '#/engine/bot/port/BotHangout.js';
// (phase 5b: the director off and a bot's part in a set piece, for the staging: a clan walk took a picked bot)
export { resetDirectorForTest, setDirectorForTest } from '#/engine/bot/port/BotDirector.js';
export { eventRoleOf } from '#/engine/bot/port/BotSetPieces.js';
export { IdleTask } from '#/engine/bot/tasks/UtilTasks.js';

import type Player from '#/engine/entity/Player.js';
import type Npc from '#/engine/entity/Npc.js';
import type Loc from '#/engine/entity/Loc.js';
import ScriptProvider from '#/engine/script/ScriptProvider.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';

/**
 * (tests only) runs one of 274's own procs on a bot, as the script that called it would (the macro events' spawns:
 * `macro_event_general_spawn(kind)`, `macro_event_lost_axe_spawn`, the gas rock's with its rock, the big fish's with its
 * spot ...): a check gets the event it asks for, through the real scripts, instead of waiting for the draw
 */
export function runProcForTest(player: Player, name: string, args: (number | string)[] = [], target: Npc | Loc | null = null): boolean {
    const script = ScriptProvider.getByName(`[proc,${name}]`);
    if (!script) return false;
    player.executeScript(ScriptRunner.init(script, player, target, args), true);
    return true;
}
