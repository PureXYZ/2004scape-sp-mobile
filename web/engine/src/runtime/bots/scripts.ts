// The bots' two script commands (docs/BOTS.md §4.2), used only by the content overlay (bots/content/*.patch). They get
// explicit numbers past the engine's last block (bots/src/port/BotScriptCommands.ts; the overlay compiler used the same
// file) and are registered in ScriptRunner.HANDLERS at run time, only in engine-bots.js and only when bots are on;
// never by editing ScriptOpcode.ts (that re-numbers every later opcode). The `.` variants are the same opcode with
// int operand 1: state.activePlayer is then the secondary player (ScriptState.ts), as upstream's checkedHandler.
import { BotTrade } from '#/engine/bot/port/BotTrade.js';
import type Player from '#/engine/entity/Player.js';
import { ScriptOpcodeNameMap } from '#/engine/script/ScriptOpcode.js';
import ScriptRunner from '#/engine/script/ScriptRunner.js';
import type ScriptState from '#/engine/script/ScriptState.js';
import World from '#/engine/World.js';

import { P_BOT_INTERACT_TRADE, P_ISBOT } from '../../../bots/src/port/BotScriptCommands.js';

import { botError } from './state.js';

export const BOT_COMMANDS = { p_isbot: P_ISBOT, p_bot_interact_trade: P_BOT_INTERACT_TRADE } as const;

// the Player fields these commands use (bots/src/port/PlayerBotFields.ts; assigned only on bots)
type BotFields = { is_bot?: boolean; botTradeTargetPid?: number; botTradeTargetStage?: number };

/** Registers the handlers; returns why it could not (an engine that took the numbers), or null. */
export function installScriptCommands(): string | null {
    const handlers = ScriptRunner.HANDLERS as Record<number, ((state: ScriptState) => void) | undefined>;
    for (const [name, opcode] of Object.entries(BOT_COMMANDS)) {
        if (handlers[opcode] !== undefined || ScriptOpcodeNameMap.has(opcode)) {
            return `script opcode ${opcode} (${name}) is already the engine's ${ScriptOpcodeNameMap.get(opcode) ?? 'handler'}`;
        }
    }

    // p_isbot()(int): 1 if the active player is a bot (Progressive PlayerOps.ts:93-95)
    handlers[P_ISBOT] = state => {
        state.pushInt((state.activePlayer as Player & BotFields).is_bot === true ? 1 : 0);
    };

    // p_bot_interact_trade(player_uid $puid, int $stage) on a bot. Stage 0: the human $puid asks this bot to trade
    // ([opplayer4,_]): the bot library decides (BotTrade.onTradeRequest: a bot whose task trades and is free takes it,
    // the first request wins; any other declines and keeps no trade target). Stage -1 (null, -1): a trade window of
    // the bot's closed ([if_close,trademain]): its trade target is cleared, always. Upstream (PlayerOps.ts:83-91)
    // wrote the target only while it was -1, so the reset never did anything and every bot that was asked kept the
    // target for good.
    handlers[P_BOT_INTERACT_TRADE] = state => {
        const bot = state.activePlayer as Player & BotFields;
        const stage = state.popInt();
        const targetPid = state.popInt();
        if (bot.is_bot !== true) return;
        if (stage < 0) {
            bot.botTradeTargetPid = -1;
            bot.botTradeTargetStage = -1;
            return;
        }
        if (stage !== 0) return;
        const human = World.getPlayerByUid(targetPid);
        if (!human) return;
        try {
            BotTrade.onTradeRequest(human, bot);
        } catch (e) {
            // never out of the human's [opplayer4,_]: a script error aborts it with a message (and logs out in production)
            botError('trade', `a trade request to ${bot.username} failed`, e);
        }
    };

    // readable script errors ("p_isbot ..." instead of "10100 ...")
    ScriptOpcodeNameMap.set(P_ISBOT, 'P_ISBOT');
    ScriptOpcodeNameMap.set(P_BOT_INTERACT_TRADE, 'P_BOT_INTERACT_TRADE');
    return null;
}
