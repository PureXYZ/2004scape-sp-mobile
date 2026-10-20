// test/texture.test.mjs's world (the realism work, phase 5a, Track F: fights, skills and manners): test/lib/simworld.ts
// with the danger map (port/BotDanger) and the personas' phase 5 traits (port/BotPersona) beside it, through one
// module graph; and Track F's: the misclicks, forgotten food and deaths (port/BotFumble), the rudeness (port/BotRude),
// the arguments (port/BotChatter), rude replies (port/BotChat.composeReply), the rest (tasks/RestTask), the danger check
// (port/BotDefence, the planner's step 1e and its White Wolf Mountain rule) and the tasks it stages.
export * from './simworld.js';
export { dangerAt, dangerOfNode, routeDanger, huntsMe, NO_DANGER, resetDangerMap } from '#/engine/bot/port/BotDanger.js';
export { personaOf, isRude } from '#/engine/bot/port/BotPersona.js';
export { nearestNode, route as graphRoute, nodePos } from '#/engine/bot/port/BotWalkGraph.js';
// (Track F)
export * as Fumble from '#/engine/bot/port/BotFumble.js';
export * as Rude from '#/engine/bot/port/BotRude.js';
export { argue, setArgueChanceForTest, chatterStateOf, onWhiteWolfMountain } from '#/engine/bot/port/BotChatter.js';
export { composeReply, BOT_CHAT_LINES } from '#/engine/bot/port/BotChat.js';
export { RestTask, EAT_TO, REST_TO, restBankFor } from '#/engine/bot/tasks/RestTask.js';
export { huntedAt, isFleeing, isHealing, DANGER_BELOW } from '#/engine/bot/port/BotDefence.js';
export { NewbieTask } from '#/engine/bot/tasks/NewbieTask.js';
export { crossesHunters, WWM_MIN_COMBAT } from '#/engine/bot/BotGoalPlanner.js';
export { MiningTask } from '#/engine/bot/tasks/MiningTask.js';
export { FiremakingTask } from '#/engine/bot/tasks/FiremakingTask.js';
export { WoodcuttingTask } from '#/engine/bot/tasks/WoodcuttingTask.js';
export { CombatTask } from '#/engine/bot/tasks/CombatTask.js';
export { SkillProgression, Items, Locations } from '#/engine/bot/BotKnowledge.js';
export { carriedFood, bankedFood, bankInvId, hpBelow, claimLoc, releaseLoc, isLocClaimed } from '#/engine/bot/tasks/BotTaskBase.js';
export { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { setHangoutRateForTest } from '#/engine/bot/port/BotHangout.js';
export { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
export { NEW_LINES } from '#/engine/bot/port/BotLines.js';
export { default as WordEnc } from '#/cache/wordenc/WordEnc.js';
export { default as ObjType } from '#/cache/config/ObjType.js';
export { default as ServerTriggerType } from '#/engine/script/ServerTriggerType.js';
export { interactLoc, findLocByPrefixWhere, findNpcFiltered } from '#/engine/bot/BotAction.js';
