// Stub speech (docs/BOTS.md §4.2): the stub's bots speak with Player.say. The real library's port/BotSay speaks as a
// typed line (the CHAT mask) and tells these listeners each line; the glue hands them to the tests (botsTest).
import type Player from '#/engine/entity/Player.js';

export const sayListeners: ((player: Player, line: string) => void)[] = [];
