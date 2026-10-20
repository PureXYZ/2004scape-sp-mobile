// port (the realism work, phase 5b: set pieces): the set pieces' modules, imported for their register() calls
// (port/BotSetPieces). BotManager imports this module once, after its own imports, so every piece is known before the
// first tick. Each track adds its modules' imports in its own block:
//
//   import '#/engine/bot/port/BotClanWalk.js';
//
// (Track D: the director and groups: clan walks, PK team raids)
import '#/engine/bot/port/BotClanWalk.js';
import '#/engine/bot/port/BotPkTeam.js';

// (Track P: parties, scams and lures: the F2P drop party and the Seers' Party Room, the scam spree (and the ambient scam
// callers' clock), the fake Wilderness drop party in the social bots' module)
import '#/engine/bot/port/BotParty.js';
import '#/engine/bot/port/BotScams.js';
import '#/engine/bot/tasks/SocialTask.js';

// (Track A: the Duel Arena and the mod bot: the arena's visits through the planner's hook and the director's big stake,
// duel_stake; the player-mod bot's listeners attach at its first pick)
import '#/engine/bot/port/BotArena.js';
import '#/engine/bot/port/BotModBot.js';

// (the variety work, round 2, Track M: members places and minigames: the far towns' outings and the minigames through the
// planner's hook, after the arena's)
import '#/engine/bot/port/BotMinigames.js';
// (Track W2 after Track M: a bot on an outing keeps it, and no show-off visit asks for it)
// (the variety work, round 2, Track W2: fashion: a rich bot's show-off visits to the trade hubs, through the planner's hook)
import '#/engine/bot/port/BotShowOff.js';

export {};
