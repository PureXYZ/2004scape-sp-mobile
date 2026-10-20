// The headless world of test/lib/simworld.ts with what test/chat.test.mjs needs on top: the object names, the server
// messages the human is sent, the chat module's line lists, the free-world switch, what makes the human attack a bot, and
// what a bot's own-state answers and emotes are made of (places, activities, animations), and what lights a fire (the
// script the engine leaves behind). The realism work: the personas and typing times replies take, composeReply, the
// answers' lines, the bots' follow, the reactions' lines.
export * from './simworld.js';
import ObjType from '#/cache/config/ObjType.js';
import Player from '#/engine/entity/Player.js';
import MessagePrivate from '#/network/game/server/model/MessagePrivate.js';
import { fromBase37 } from '#/util/JString.js';
import { BOT_CHAT_LINES, chatDice, composeReply, firstNameOf, pickOpener, sendFriendOpener } from '#/engine/bot/port/BotChat.js';
import { personaOf } from '#/engine/bot/port/BotPersona.js';
import { ANSWER_LINES } from '#/engine/bot/port/BotAnswers.js';
import { REACTION_LINES } from '#/engine/bot/port/BotReactions.js';
import { noteSpoke } from '#/engine/bot/port/BotSpoke.js';
import { botSay } from '#/engine/bot/port/BotSay.js';
import { applyWorldRules } from '#/engine/bot/port/BotWorldRules.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';

import SeqType from '#/cache/config/SeqType.js';
import { placePhrase } from '#/engine/bot/port/BotPlaces.js';
import { activityLine } from '#/engine/bot/port/BotActivity.js';
import { WoodcuttingTask } from '#/engine/bot/tasks/WoodcuttingTask.js';
import { SkillProgression } from '#/engine/bot/BotKnowledge.js';
import { botScript, interactHeldOpU } from '#/engine/bot/BotAction.js';
import ScriptState from '#/engine/script/ScriptState.js';
import { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';

export { ObjType, Player, MessagePrivate, fromBase37, BOT_CHAT_LINES, chatDice, composeReply, firstNameOf, pickOpener, sendFriendOpener, noteSpoke, applyWorldRules, Interaction, ServerTriggerType, SeqType, placePhrase, activityLine, WoodcuttingTask, SkillProgression, botScript, interactHeldOpU, ScriptState, personaOf, ANSWER_LINES, REACTION_LINES, botSay, setHabitRatesForTest };
// (realism phase 5b: no random event on the test's bots: a genie let pass sent a frozen bot off by the game's fail teleport)
export { setEventRatesForTest } from '#/engine/bot/port/BotRandomEvents.js';
