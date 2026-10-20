// test/talk.test.mjs's world (the variety work, round 1, Track S: what they say): test/lib/simworld.ts with the chatter,
// the lines, the slots, the conversation's bot-to-bot side, the practices' turns and the sellers' pace, through one module
// graph.
export * from './simworld.js';
export * as Lines from '#/engine/bot/port/BotLines.js';
export * as Slots from '#/engine/bot/port/BotSlots.js';
export { sayable, styleLine } from '#/engine/bot/port/BotStyle.js';
export { personaOf } from '#/engine/bot/port/BotPersona.js';
export { noteDeathForTest, sayDueForTest, dueNowForTest, quietForTest, tickChatter, talkStats, chatterStateOf, clanNameOf, LONE_RATE, COMPANY_RATE } from '#/engine/bot/port/BotChatter.js';
export { chatDice, isGreetingLine, isQuestionText, friendOpener, BOT_CHAT_LINES } from '#/engine/bot/port/BotChat.js';
export { setCliqueBehaviourForTest } from '#/engine/bot/port/BotCliques.js';
export { turnLines, PRACTICES } from '#/engine/bot/port/BotStage.js';
export { advertGapOf, autoTyperGapOf, buyerNear, VENDOR_PATTER } from '#/engine/bot/tasks/VendorTask.js';
export { setHabitRatesForTest } from '#/engine/bot/port/BotHabits.js';
export { setHangoutRateForTest } from '#/engine/bot/port/BotHangout.js';
export { lastHeard } from '#/engine/bot/port/BotSpoke.js';
export { default as WordEnc } from '#/cache/wordenc/WordEnc.js';
