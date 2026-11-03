// port (bots ideas, round 3, theme G: period content): theme G's modules, imported for their registrations
// (port/BotPeriod registerPeriodEntry, the members catalogue's entries, the pet habit's), and the period hooks
// registered once, in their place among the planner's (port/BotSetPieceIndex imports this module right after
// port/BotMinigames, and BotManager imports that after its own imports):
//   - the buzz's planner hook and its keep hook (port/BotPeriodPlan periodTaskFor, keptPeriodTask), after the far towns'
//     and minigames' and Kandarin's signatures (port/BotMinigames), before the show-off visits (port/BotShowOff);
//   - the rescue jumps' listener (BotAction teleportListeners → port/BotPeriod notePeriodJump: PC10).
// Registered here, not at port/BotPeriod's load: that module is a leaf any module may import early (for periodOn), and
// an early registration would have put the hook before the arena's, or reached BotSetPieces before it loaded.
// Each builder imports its modules in its own block below (their imports are evaluated before the registrations).
import { registerKeepHook, registerPlannerHook } from '#/engine/bot/port/BotSetPieces.js';
import { teleportListeners } from '#/engine/bot/BotAction.js';
import { notePeriodJump } from '#/engine/bot/port/BotPeriod.js';
import { keptPeriodTask, periodTaskFor } from '#/engine/bot/port/BotPeriodPlan.js';
// ---- (bots ideas, round 3: G period) the G builder's modules: kittens (port/BotPets), the Games Room's Runelink
// (port/BotRunelink), Gnomeball, their talk ----
import type Player from '#/engine/entity/Player.js';
import { periodHabits } from '#/engine/bot/port/BotPeriod.js';
import { tickPets } from '#/engine/bot/port/BotPets.js';
import { minimapExempt } from '#/engine/bot/port/BotMinimap.js';
import { noHoldWhile } from '#/engine/bot/port/BotTalkMoves.js';
import { inGamesRoomBox } from '#/engine/bot/port/BotExits.js';
import { onPitch } from '#/engine/bot/tasks/GnomeballTask.js';
import { PeriodPlaces } from '#/engine/bot/BotKnowledge.js';
import { periodTalk } from '#/engine/bot/port/BotPeriod.js';
import { periodAnswer, periodIdleLine, petOutForTalk } from '#/engine/bot/port/BotPeriodTalk.js';
// (the pet habit from the bot's tick: a cat person's strokes, feeds, pages and trips; false at once while theme G is off)
periodHabits.push(tickPets);
// (the talk the early modules ask through the leaf: port/BotAnswers' questions, port/BotThreads' topic pet)
periodTalk.answer = periodAnswer;
periodTalk.hasPetOut = petOutForTalk;
// (bots ideas, round 3 tune: the period's idle talk in the chatter's due idle line's place)
periodTalk.idleLine = periodIdleLine;
// (theme H: no minimap hop or pause, and no talk hold or walk-up, where a scripted step of theme G's would break: the
// Games Room (its stairs, a board under way), the Gnomeball pitch (a game: the ball, the tacklers), Gertrude's door and
// dialogue. Cheap: the bot's tile only)
const [gx, gz] = PeriodPlaces.GERTRUDE;
const periodScripted = (p: Player): boolean => inGamesRoomBox(p.x, p.z) || onPitch(p) || (p.level === 0 && Math.max(Math.abs(p.x - gx), Math.abs(p.z - gz)) <= 3);
minimapExempt.push(periodScripted);
noHoldWhile.push(periodScripted);
// ---- end of G period's block ----
// ---- (bots ideas, round 3: G buzz) the H builder's theme G modules: the Rellekka buzz (the visit, the crabs, the
// lighthouse: their registry entries), chompies ----
import '#/engine/bot/tasks/BuzzTask.js';
// ---- end of G buzz's block ----

registerPlannerHook((player, previous) => periodTaskFor(player, previous));
registerKeepHook(player => keptPeriodTask(player));
teleportListeners.push(notePeriodJump);

export {};
