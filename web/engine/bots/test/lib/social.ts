// test/social.test.mjs's world (the realism work, phase 3, track C: social life): test/lib/simworld.ts with the social
// regulars and lures (tasks/SocialTask), the friend cliques (port/BotCliques), a clique's travel (port/BotFollow) and the
// PK tasks beside it, loaded through one module graph (the same BotManager, the same cliques).
export * from './simworld.js';
export { SocialTask, HUBS, hubCap, hubUsual, hubOrder, SOCIAL_LINES, setSocialRatesForTest, forgetCrowdsForTest } from '#/engine/bot/tasks/SocialTask.js';
export * as Cliques from '#/engine/bot/port/BotCliques.js';
export { CliqueFollowTask } from '#/engine/bot/port/BotFollow.js';
export { PKerTask } from '#/engine/bot/tasks/PKerTask.js';
export { EdgevillePKerTask } from '#/engine/bot/tasks/EdgevillePKerTask.js';
export { WoodcuttingTask } from '#/engine/bot/tasks/WoodcuttingTask.js';
export { SkillProgression } from '#/engine/bot/BotKnowledge.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { ageTierFor } from '#/engine/bot/port/BotAge.js';
export { wildernessLevelAt as wildLevel } from '#/engine/bot/port/BotContent.js';
export { firstNameOf } from '#/engine/bot/port/BotChat.js';
export { default as ServerTriggerType } from '#/engine/script/ServerTriggerType.js';
export { default as WordEnc } from '#/cache/wordenc/WordEnc.js';
export { bankInvId } from '#/engine/bot/tasks/BotTaskBase.js';
export { isAway } from '#/engine/bot/port/BotHabits.js';
