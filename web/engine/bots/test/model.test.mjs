#!/usr/bin/env node
// The language model's seam (the realism work, phase 7), in the real 274
// world with a few bots and a human. The foundation's checks:
//   situation  a reply's situation is the bot's real state: its levels and total, its combat, its HP, where it stands
//              and what it does, what it wears and carries; the human's line, its channel and the rules' answer; the
//              lines said near it lately (the human's being answered left out), a private thread for a PM
//   prompts    the on-device prompt carries the facts and the chat, short enough for the phone (under 2,000
//              characters with a full history); Claude's starts with the same guide every time (cached)
//   capture    the listeners see a reply the rules composed and a line they left unanswered; taking situations draws no
//              dice
//   guard      one line of the chat's characters within 80; a name in front and quotes go; a long line is cut at a
//              word or refused; assistant talk, 2004's missing things, a bot owning up and a line the filter would
//              change are refused
//   rules      with no model (every sim) nothing is asked: the channel stays silent
// Track E's (spec §3, §5 items 1-8):
//   guard+     (a) promises the rules did not make; (b) facts: levels next to a skill's name, "im in <place>", prices;
//              (c) the human's line echoed back, the bot's own line again; (d) the human's name at the persona's rate;
//              (e) other players' names; (f) "brb", "gtg", "afk": each refused (or, for (d), dropped) with its reason,
//              and the lines a person would say with them pass
//   scope      which replies a model writes, by the way the line came and the rules' intent; the rules-only intents
//              are intents the code makes; nothing without a model
//   replies    with the stub (port/BotModel setModelForTest): a named line's reply in the model's words, never before the
//              persona could have typed it from the decision nor after the deadline; the fallbacks (the deadline: the
//              rules' line at once; an error and a guarded line: the rules' line at its own time); a newer line
//              supersedes (the rules' line, or nothing once the conversation moved on); a PM's reply by PM; the
//              conversation's state as the rules' (its 30 s from the reply; "follow me" stays the rules', with its
//              Follow); the lines the rules left unanswered (a named line, a conversation's, a reply-window answer, a
//              question to nobody) answered by the model; at most 3 in flight ('busy'); no channel: the rules' line
//   no model   with the rules again, a while of chat asks nothing
//
//   node --expose-gc web/engine/bots/test/model.test.mjs
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, importTs } from './lib/paths.mjs';
import { prepareEngineClone, simWorldConfig, stubWorkerThreads } from './lib/clone.mjs';

const out = (s = '') => process.stdout.write(s + '\n');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
for (const level of ['log', 'info', 'debug', 'warn']) console[level] = () => {};
{
    let s = 7;
    Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const engineDir = prepareEngineClone('model', simWorldConfig({ members: true }));
process.chdir(engineDir);
await stubWorkerThreads();
const lib = await importTs(path.join(BOTS_DIR, 'test/lib/model.ts'), path.join(engineDir, 'tsconfig.json'));
const { World, BotManager, BotChat, BotModelNs, BotModelPromptNs, BotModelGuardNs, BotModelHistoryNs } = lib;
lib.setEventRatesForTest?.({ odds: 0 });
// (no short breaks, lingers or looks: a frozen bot on a break would answer nobody; port/BotHabits)
lib.setHabitRatesForTest?.({ breaks: 0, lingers: 0, watch: 0 });
const sim = await lib.Sim.create({ bots: 6, members: true, debug: false });
sim.addHuman(3212, 3428, 0);
const human = sim.human;
const run = (ticks, until) => {
    for (let i = 0; i < ticks; i++) {
        sim.tick();
        if (until && until()) return i + 1;
    }
    return -1;
};
run(300, () => sim.bots().length >= 6);
run(30);
const bots = sim.bots();
if (bots.length < 2) {
    out(`FAIL only ${bots.length} bots came into the world`);
    process.exit(1);
}
const requests = [];
BotModelNs.setModelChannel(msg => requests.push(msg));

// ---- situation ----
const bot = bots[0];
sim.teleportHuman(bot.x + 1, bot.z, bot.level);
bots[1].teleJump(bot.x + 2, bot.z + 1, bot.level);
run(2);
lib.botSay(bots[1], 'anyone selling lobs');
run(2);
BotModelHistoryNs.notePublicLine(human, 'hey whats ur cb');
const req = { bot, to: human, heard: 'hey whats ur cb', channel: 'public', via: 'named', greeted: true, intent: { id: 'combat', text: 'im {combat} {name}'.replace('{combat}', String(bot.combatLevel)) } };
const s = BotModelPromptNs.situationOf(req);
const total = bot.baseLevels.reduce((sum, l, i) => (i === 18 || i === 19 ? sum : sum + l), 0);
check('the situation: the bot\'s levels, total and combat as the game has them', s.facts.levels.wc === bot.baseLevels[8] && s.facts.levels.att === bot.baseLevels[0] && s.facts.total === total && s.facts.combat === bot.combatLevel, { wc: s.facts.levels.wc, total: s.facts.total, combat: s.facts.combat });
check('the situation: HP now and at full', s.facts.hp[0] === bot.levels[3] && s.facts.hp[1] === bot.baseLevels[3], s.facts.hp);
check('the situation: the human\'s line, channel and way, the rules\' answer without its {name} slot', s.heard.text === 'hey whats ur cb' && s.heard.channel === 'public' && s.heard.via === 'named' && s.hint?.intent === 'combat' && !s.hint.text.includes('{name}') && s.hint.text.includes(String(bot.combatLevel)), s.heard);
check('the situation: lines said near it lately (another bot\'s), the line being answered left out', s.history.some(l => l.who === 'other' && l.text.includes('lobs')) && !s.history.some(l => l.who === 'them' && l.text === 'hey whats ur cb'), s.history);
check('the situation: the human\'s name, combat and distance', s.human.name.length > 0 && s.human.combat === human.combatLevel && s.human.distance === Math.max(Math.abs(bot.x - human.x), Math.abs(bot.z - human.z)), s.human);
check('the situation is plain data (JSON round trip)', JSON.stringify(JSON.parse(JSON.stringify(s))) === JSON.stringify(s));
// a private thread
BotModelHistoryNs.notePrivateLine(bot, human, 'u there?', false);
BotModelHistoryNs.notePrivateLine(bot, human, 'ya', true);
const sp = BotModelPromptNs.situationOf({ ...req, heard: 'what u doing', channel: 'private', via: 'private', greeted: false, intent: null });
check('a private message\'s situation: the thread with that human, marked private; no rules\' answer', sp.history.length >= 2 && sp.history.every(l => l.pm) && sp.history.at(-1).who === 'you' && sp.hint === null, sp.history);
check('(Track E) the situation keeps the bot\'s own lines of the last 10 minutes for the guard (its PM "ya" among them), not in the prompts', Array.isArray(sp.said) && sp.said.includes('ya') && !BotModelPromptNs.renderLocal(sp).system.includes('said'), sp.said);

// ---- prompts ----
const local = BotModelPromptNs.renderLocal(s);
const online = BotModelPromptNs.renderOnline(s);
check('the on-device prompt: the facts and the chat, the human\'s line last but for the answer idea', local.system.includes(`combat ${bot.combatLevel}`) && local.user.split('\n').at(-2).endsWith('hey whats ur cb') && local.user.includes('(answer idea:'), local);
const full = BotModelPromptNs.situationOf(req);
full.history = Array.from({ length: 8 }, (_, i) => ({ who: 'other', name: `Someone${i}`, text: 'x'.repeat(60), ago: i }));
const fullLocal = BotModelPromptNs.renderLocal(full);
check('the on-device prompt stays short with a full history (under 2,000 characters)', fullLocal.system.length + fullLocal.user.length < 2000, fullLocal.system.length + fullLocal.user.length);
check('Claude\'s prompt: the same guide for every bot (cached), the bot\'s facts after it', online.system === BotModelPromptNs.renderOnline(BotModelPromptNs.situationOf({ ...req, bot: bots[1] })).system && online.context.includes(`combat ${bot.combatLevel}`) && online.system.length > 2000, online.system.length);

// ---- capture ----
{
    const seen = [];
    BotModelNs.composedListeners.push((r, text, kind) => seen.push({ via: r.via, text, kind }));
    let draws = 0;
    const real = Math.random;
    Math.random = () => (draws++, real());
    const before = draws;
    BotModelPromptNs.situationOf(req);
    check('taking a situation draws no dice', draws === before, draws - before);
    Math.random = real;
    lib.composeReply({ ...req });
    check('the listeners see a reply the rules composed', seen.some(x => x.kind === 'composed' && x.via === 'named'), seen);
    BotModelNs.composedListeners.length = 0;
}

// ---- guard (the foundation's) ----
const g = (raw, sit = s, opts) => BotModelGuardNs.guardReply(raw, sit, opts);
check('guard: a plain line passes as it is', g(`lol ya ${s.facts.levels.wc} wc`).ok && g(`lol ya ${s.facts.levels.wc} wc`).text === `lol ya ${s.facts.levels.wc} wc`, g(`lol ya ${s.facts.levels.wc} wc`));
check('guard: the first line only, a name in front and quotes go', g(`${s.bot.name}: "nm u?"\nsecond line`).text === 'nm u?', g(`${s.bot.name}: "nm u?"\nsecond line`));
check('guard: typographic quotes and dashes become the chat\'s', g('it’s ok — ty').text === "it's ok - ty", g('it’s ok — ty'));
check('guard: a long line is cut at a word, or refused', g('a '.repeat(30) + 'b'.repeat(30)).ok === false || g('a '.repeat(30) + 'b'.repeat(30)).text.length <= 80, g('a '.repeat(30) + 'b'.repeat(30)));
check('guard: a line in emoji or another script is refused', g('ok 😀😀😀😀😀').ok === false && g('ok 😀😀😀😀😀').reason === 'charset', g('ok 😀😀😀😀😀'));
check("guard: assistant talk refused (\"I'd be happy to help\")", g("I'd be happy to help!").reason === 'assistant');
check('guard: what did not exist in 2004 refused (the GE, osrs, discord)', g('just buy it on the grand exchange').reason === 'anachronism' && g('add me on discord').reason === 'anachronism');
check('guard: a bot owning up refused', g('im a bot lol').reason === 'confession');
check('guard: nothing is no line', g(null).ok === false && g('   ').ok === false);
// (the integration: Track L's evaluation notes) the 2004 quests' names, owning up without "i'm", modern slang
check('guard: a 2004 quest named "slayer" is no anachronism (demon, dragon, vampire slayer); Slayer the skill still is', BotModelGuardNs.guardReply('demon slayer is easy', null).ok && BotModelGuardNs.guardReply('dragon slayer took me ages', null).ok && BotModelGuardNs.guardReply('whats ur slayer lvl', null).reason === 'anachronism', [BotModelGuardNs.guardReply('demon slayer is easy', null), BotModelGuardNs.guardReply('whats ur slayer lvl', null)]);
check('guard: "yeah, just a bot" is owning up; "ur just a bot" (of someone else) is banter', BotModelGuardNs.guardReply('lol yeah just a bot', null).reason === 'confession' && BotModelGuardNs.guardReply('ur just a bot lol', null).ok, [BotModelGuardNs.guardReply('lol yeah just a bot', null), BotModelGuardNs.guardReply('ur just a bot lol', null)]);
check('guard: slang from long after 2004 refused (rizz, no cap, ngl)', ['no cap', 'thats rizz', 'ngl its good', 'bruh'].every(t => BotModelGuardNs.guardReply(t, null).reason === 'anachronism'), ['no cap', 'thats rizz', 'ngl its good', 'bruh'].map(t => BotModelGuardNs.guardReply(t, null)));
// (the review of the merge) a yes to "r u a bot", a yes to a beg, the promise check's plans and exclamations, names that are phrases
{
    const asked = { ...s, heard: { ...s.heard, text: 'r u a bot' }, hint: { intent: 'bot', text: 'no lol' } };
    const begged = { ...s, heard: { ...s.heard, text: 'can i have ur rune axe' }, hint: { intent: 'beg', text: 'no get ur own' } };
    const G = (t, sit) => BotModelGuardNs.guardReply(t, sit);
    check('guard: a bare yes to "r u a bot" owns up (refused); "no lol im fishing" passes', ['ya lol', 'yes why', 'yep'].every(t => G(t, asked).reason === 'confession') && G('no lol im fishing', asked).ok, ['ya lol', 'yes why', 'yep', 'no lol im fishing'].map(t => G(t, asked)));
    check('guard: "ok sure" to a beg the rules turned down promises (refused); "lol no" passes', ['ok sure', 'ya np', 'sure here'].every(t => G(t, begged).reason === 'promise') && G('lol no get ur own', begged).ok, ['ok sure', 'ya np', 'sure here', 'lol no get ur own'].map(t => G(t, begged)));
    check("guard: plans and exclamations are no promises (\"i want to train fletch after\", \"lets go!\", \"i could buy one later\"); invitations and offers are", ['cutting maples, i want to train fletch after', 'lets go!', 'i could buy one later'].every(t => G(t, null).ok) && ['wanna trade?', 'lol wanna duel', 'lets go pk', 'u wanna team?', 'ill give u some', 'i can show u'].every(t => G(t, s).reason === 'promise'), ['cutting maples, i want to train fletch after', 'lets go!', 'i could buy one later', 'wanna trade?', 'lol wanna duel', 'lets go pk', 'u wanna team?', 'ill give u some', 'i can show u'].map(t => [t, G(t, s).reason ?? 'ok']));
    const named = (t, names) => BotModelGuardNs.guardReply(t, s, { names });
    check('guard: a bot\'s name that is a phrase is no name ("cheers mate" with Cheers Mate online); a distinctive one is ("ask stevo2004")', named('cheers mate', ['Cheers Mate', 'Just Chillin']).ok && named('no im just chillin', ['Just Chillin']).ok && named('ask stevo2004 he sells them', ['Stevo2004']).reason === 'name', [named('cheers mate', ['Cheers Mate']), named('ask stevo2004 he sells them', ['Stevo2004'])]);
    const spots = { ...s, heard: { ...s.heard, text: 'where do u fish sharks' }, hint: { intent: 'spots', text: 'at the fishing guild i think' }, facts: { ...s.facts, place: 'in Varrock', activity: null }, history: [] };
    check('guard: an answer about where things are names only places the situation has ("near lumby" added to the guild: refused)', G('fishing guild i think, near lumby', spots).reason === 'place' && G('fishing guild i think', spots).ok, [G('fishing guild i think, near lumby', spots), G('fishing guild i think', spots)]);
    const respawn = { ...spots, heard: { ...spots.heard, text: 'where do i respawn' }, hint: { intent: 'where', text: "Depends what you're looking for." } };
    const way = { ...spots, heard: { ...spots.heard, text: 'how do i get to varrock' }, hint: { intent: 'directions', text: 'north east' } };
    check('guard: a player\'s own knowledge where the rules name no place passes ("where do i respawn" -> "lumbridge"); the way somewhere adds no place ("through fally": refused)', G('lumbridge nub', respawn).ok && G('north east, the road winds through fally', way).reason === 'place' && G('north east, follow the road', way).ok, [G('lumbridge nub', respawn), G('north east, the road winds through fally', way), G('north east, follow the road', way)]);
}
check('guard (Track E): a model\'s markup refused ("im at **al kharid**", "*winks*"); a correction\'s "*there" passes', g('im at **al kharid** lol').reason === 'markup' && g('ya *winks*').reason === 'markup' && g('*there', null).ok, [g('im at **al kharid** lol').reason, g('ya *winks*').reason, g('*there', null).reason]);

// ---- guard (Track E: §3 a-f), on a situation of known facts ----
{
    const S = JSON.parse(JSON.stringify(s));
    S.bot.name = 'Kevin1991';
    S.human.name = 'Sim Human';
    S.facts.levels = { att: 40, str: 42, def: 35, hp: 41, range: 30, pray: 31, mage: 33, cook: 50, wc: 61, fletch: 20, fish: 55, fm: 45, craft: 10, smith: 15, mine: 30, herb: 1, agil: 1, thief: 1, rc: 5 };
    S.facts.combat = 45;
    S.facts.total = 606;
    S.facts.place = 'in Varrock';
    S.facts.activity = 'cutting willows in draynor';
    S.facts.wilderness = 0;
    S.facts.carrying = ['26 willow logs', 'coins 12k'];
    S.facts.friendsNear = ['Matty B'];
    S.history = [{ who: 'other', name: 'Lumby Larry', text: 'anyone selling lobs', ago: 20 }];
    S.heard = { text: 'Kevin1991 whats up', channel: 'public', via: 'named', greeted: false };
    S.hint = null;
    S.said = ['selling willow logs cheap', 'lol'];
    const with_ = over => Object.assign(JSON.parse(JSON.stringify(S)), over);
    const ok = (raw, sit = S, opts) => g(raw, sit, opts).ok;
    const why = (raw, sit = S, opts) => g(raw, sit, opts).reason;
    // (a)
    check('guard (a): promises the rules did not make refused ("ill give u 1k", "meet me at edge", "omw", "wanna team?")', ['sure ill give u 1k', 'meet me at edge', 'omw', 'wanna team?', 'k ill follow u', 'add me'].every(l => why(l) === 'promise'), ['sure ill give u 1k', 'meet me at edge', 'omw', 'wanna team?', 'k ill follow u', 'add me'].map(l => `${l}: ${why(l)}`));
    check('guard (a): one the rules\' answer made passes ("ok meet me at edge bank" for its hint)', ok('ok meet me at edge bank lol', with_({ hint: { intent: 'pk', text: 'ok meet me at edge bank' } })) && ok('i can try help, whats up'), why('ok meet me at edge bank lol', with_({ hint: { intent: 'pk', text: 'ok meet me at edge bank' } })));
    // (b) levels
    const lv = ['61 wc', 'im 45 cb', 'cb 45', 'total 606', 'my wc is 61', 'lvl 45', 'u need 40 att for rune', 'ur 35 cb?', 'going for 70 wc', '3 more lvls till 70', 'like 60 wc', '2 lvls to go', 'only 30 mining lol'];
    check('guard (b): its own levels next to a skill\'s name pass, as do someone else\'s, a requirement, a goal, "like 60"', lv.every(l => ok(l)), lv.filter(l => !ok(l)).map(l => `${l}: ${why(l)}`));
    const lvBad = ['62 wc', 'im 50 cb', 'cb 52', 'my wc is 70', 'lvl 47', '99 wc lol', 'like 50 wc', '700 total'];
    check('guard (b): a level that is not its own refused ("62 wc" at 61, "im 50 cb" at 45)', lvBad.every(l => why(l) === 'level'), lvBad.map(l => `${l}: ${why(l)}`));
    const cbHint = with_({ hint: { intent: 'combat', text: '45 cb' }, heard: { ...S.heard, text: 'whats ur cb' } });
    check('guard (b): a direct answer about levels keeps the hint\'s number ("ya 45 u?" passes, "im 52 lol" refused)', ok('ya 45 u?', cbHint) && why('im 52 lol', cbHint) === 'level', why('im 52 lol', cbHint));
    // (b) places
    check('guard (b): "im in <place>" where it is passes (its place, its activity\'s)', ok('im in varrock atm') && ok('im at draynor cutting') && ok('im near varrock'), [why('im in varrock atm'), why('im at draynor cutting')]);
    check('guard (b): "im in <place>" where it is not refused', why('im in lumby') === 'place' && why('im at fally east bank') === 'place' && why('im in varrock', with_({ facts: { ...S.facts, place: null, activity: null } })) === 'place', [why('im in lumby'), why('im at fally east bank')]);
    const whereHint = with_({ hint: { intent: 'whereami', text: 'In Varrock atm' }, heard: { ...S.heard, text: 'where r u' } });
    check('guard (b): with a "where r u" answer every place named is its own', ok('varrock lol', whereHint) && why('fally lol', whereHint) === 'place', why('fally lol', whereHint));
    // (b) prices
    const priceHint = with_({ hint: { intent: 'price', text: 'like 160' }, heard: { ...S.heard, text: 'how much r lobs' } });
    check('guard (b): a price is the hint\'s ("160 ea" passes, "200 ea" refused; "1.2k" is 1200)', ok('160 ea', priceHint) && why('200 ea', priceHint) === 'price' && ok('like 1.2k', with_({ hint: { intent: 'price', text: 'like 1200' } })), [why('160 ea', priceHint), why('200 ea', priceHint)]);
    check('guard (b): an amount of its own coins or the human\'s passes, an invented price refused', ok('only got 12k lol') && ok('lol no 5k is a lot', with_({ heard: { ...S.heard, text: 'can i have 5k' } })) && why('they r like 50k ea') === 'price', [why('only got 12k lol'), why('they r like 50k ea')]);
    // (c)
    const echoed = with_({ heard: { ...S.heard, text: 'Kevin1991 whats ur combat level' } });
    check('guard (c): the human\'s line echoed back refused (its name left out, punctuation aside)', why('whats ur combat level', echoed) === 'echo' && why('whats ur combat level?', echoed) === 'echo', why('whats ur combat level', echoed));
    check('guard (c): its own line of the last 10 minutes again refused; "lol" twice is a person', why('selling willow logs cheap') === 'repeat' && ok('lol') && ok('lol', with_({ heard: { ...S.heard, text: 'lol' } })), why('selling willow logs cheap'));
    // (d)
    check('guard (d): the persona\'s roll against the echo drops the human\'s name ("hey Sim Human whats up" → "hey whats up")', g('hey Sim Human whats up', S, { keepName: false }).text === 'hey whats up' && g('Sim Human, u there?', S, { keepName: false }).text === 'u there?' && g('hey Sim Human', S, { keepName: true }).text === 'hey Sim Human', [g('hey Sim Human whats up', S, { keepName: false }).text, g('Sim Human, u there?', S, { keepName: false }).text]);
    // (e)
    const names = ['Sim Human', 'Kevin1991', 'Lumby Larry', 'Matty B', 'Iron Fist', 'Stevo2004'];
    // (the review of the merge: only names with a digit count; "Iron Fist", "Cheers Mate" are words a line may use)
    check('guard (e): another player\'s name it cannot know refused (one with a digit); the human\'s, its own, a friend\'s near it, one in its history or the human\'s line pass, and a name that is a phrase is no name', why('ask stevo2004 lol', S, { names }) === 'name' && ok('ask iron fist lol', S, { names }) && ok('lumby larry is a nub', S, { names }) && ok('matty b is here', S, { names }) && ok('hey sim human', S, { names }) && ok('stevo2004? nah', with_({ heard: { ...S.heard, text: 'do u know stevo2004' } }), { names }), [why('ask stevo2004 lol', S, { names }), why('ask iron fist lol', S, { names }), why('lumby larry is a nub', S, { names })]);
    // (f)
    check('guard (f): "brb", "gtg", "afk" refused (effect lines in the rules); a goodbye as the hint\'s ("k cya") passes', ['brb', 'gtg sry', 'afk lol', 'gotta go', 'be right back'].every(l => why(l) === 'effect') && ok('k cya', with_({ hint: { intent: 'brb', text: 'k cya' } })), ['brb', 'gtg sry', 'afk lol'].map(l => why(l)));
    check('guard: what a person says passes ("r u afk?", "take it easy", "15 m usa" for its asl, a name with digits by a level\'s number)', ok('r u afk?') && ok('were u afk lol') && ok('take it easy') && ok('15 m usa', with_({ hint: { intent: 'asl', text: '15 m usa' } })) && ok('im 15 m usa') && ok('ya 45 andy99', with_({ human: { ...S.human, name: 'Andy99' }, hint: { intent: 'combat', text: '45 cb' } })), [why('r u afk?'), why('take it easy'), why('im 15 m usa'), why('ya 45 andy99', with_({ human: { ...S.human, name: 'Andy99' }, hint: { intent: 'combat', text: '45 cb' } }))]);
    check('guard: every reason it gives is one of GUARD_REASONS', ['promise', 'level', 'place', 'price', 'echo', 'repeat', 'name', 'effect'].every(r => BotModelGuardNs.GUARD_REASONS.includes(r)));
}

// ---- rules (no model) ----
check('with the rules alone (no mode from the page) the model is not available', BotModelNs.modelMode() === 'rules' && BotModelNs.modelAvailable() === false);
BotChat.onPublicMessage(human, `${bot.displayName} hows it going`);
run(30);
check('with the rules alone nothing is asked', requests.length === 0, requests.length);
BotModelNs.setModelMode({ mode: 'local', local: true, online: false });
check('the page\'s word: on-device chosen and there: available', BotModelNs.modelAvailable() === true);
BotModelNs.setModelMode({ mode: 'online', local: true, online: false });
check('Claude chosen without a key, the on-device model there to fall back to: available', BotModelNs.modelAvailable() === true);
BotModelNs.setModelMode({ mode: 'online', local: false, online: false });
check('Claude chosen without a key and no on-device model: not available', BotModelNs.modelAvailable() === false);
BotModelNs.resetModelForTest();

// ---- scope (Track E item 1) ----
{
    const b = bots[0];
    const sc = (via, intent, rude = false, who = b) => BotModelNs.inModelScope({ bot: who, via, intent }, rude);
    check('scope: the vias named, window, conversation, crowd, second and private; not the marketplace nor a reaction of its own', ['named', 'window', 'conversation', 'crowd', 'second', 'private'].every(v => sc(v, { id: 'greeting' })) && !sc('market', { id: 'market' }) && !sc('reaction', { id: 'wave' }));
    check('scope: trades, PK, fights, follow (and any reply with a Follow), team up, the rude lines stay the rules\'', ['trade', 'pk', 'fight', 'follow', 'team', 'rude', 'market_none', 'not_for_sale', 'dance'].every(id => !sc('named', { id })) && !sc('named', { id: 'presence', follow: true }) && !sc('named', { id: 'how' }, true));
    check('scope: answers from the bot\'s state and talk are the model\'s (combat, where, price, asl, how, a joke, nothing understood)', ['combat', 'whereami', 'price', 'asl', 'how', 'joke', 'greeting', 'goodbye', 'newbie', 'beg'].every(id => sc('named', { id })) && sc('conversation', null));
    const mod = { ...b, staffModLevel: 1 };
    check('scope: the player-mod bot\'s replies stay the rules\' (its proper sentences)', !BotModelNs.inModelScope({ bot: mod, via: 'named', intent: { id: 'mod_you' } }));
    check('scope: nothing without a model (wantsModel)', !BotModelNs.wantsModel({ bot: b, via: 'named', intent: { id: 'how' } }));
    // (the rules-only intents are intents the code makes: port/BotAnswers, port/BotChat, data/chat_responses.json)
    const code = ['src/port/BotAnswers.ts', 'src/port/BotChat.ts'].map(f => fs.readFileSync(path.join(BOTS_DIR, f), 'utf8')).join('\n');
    const json = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'data/chat_responses.json'), 'utf8'));
    const made = id => code.includes(`text('${id}'`) || code.includes(`id: '${id}'`) || code.includes(`id = '${id}'`) || json.intents.some(i => i.id === id);
    const unknown = [...BotModelNs.RULES_ONLY_INTENTS.keys()].filter(id => !made(id));
    check('scope: every rules-only intent is one the code makes', unknown.length === 0, unknown);
}

// ---- replies with the stub (Track E items 2, 3, 5, 7, 8) ----
const says = [];
lib.sayListeners.push((player, text, kind, to) => says.push({ t: World.currentTick, who: player.username, text, kind: kind ?? null, to: to?.username ?? null }));
const pms = [];
{
    const write = human.write.bind(human);
    human.write = m => {
        if (m instanceof lib.MessagePrivate) pms.push({ t: World.currentTick, from: lib.fromBase37(m.from), text: m.msg });
        return write(m);
    };
}
// (the bots' own talk to the human, a reaction or an exchange, waits: a line of theirs is no answer to a check's line)
BotChat.tickTalk = () => {};
function freeze(b) {
    sim.botPlayer(b).tick = () => {};
    b.clearWaypoints();
    b.clearPendingAction();
    b.clearInteraction();
    const page = b.activeScript;
    if (page && page.execution === lib.ScriptState.PAUSEBUTTON) b.executeScript(page, true, true);
}
const live = bots.filter(b => b.slot !== -1 && BotManager.botFor(b));
for (const b of live) freeze(b);
/** a frozen bot next to the human, the others away from them both (out of earshot: no crowd) */
function stage(b) {
    for (const [i, o] of live.entries()) if (o !== b) o.teleJump(3150 + i * 3, 3480, 0);
    b.teleJump(3212, 3428, 0);
    sim.teleportHuman(3213, 3428, 0);
    run(3);
}
const withDice = (value, fn) => {
    const roll = lib.chatDice.roll;
    lib.chatDice.roll = () => value;
    try {
        return fn();
    } finally {
        lib.chatDice.roll = roll;
    }
};
/** the bot's persona could not have typed `text` sooner (port/BotTiming.typingTicks: no thinking, its quickest typing) */
const quickest = (b, text) => Math.max(2, Math.min(20, Math.round(((text.length / lib.botPersona(b).typingCps) * 1000 * 0.85) / 600)));
const log = () => BotModelNs.modelStats.log;
const lastEntry = b => [...log()].reverse().find(e => e.bot === b.username);
const repliesOf = (b, from) => says.filter(x => x.who === b.username && x.t >= from && x.kind === 'reply');
/** a line to the bot (public, by name), then ticks until the bot's model reply settles and is said (or `wait`) */
function ask(b, text, wait = 40) {
    const from = World.currentTick;
    BotChat.onPublicMessage(human, text);
    run(wait, () => {
        const e = lastEntry(b);
        return e && e.t >= from && e.outcome !== 'pending' && (e.outcome !== 'used' || e.saidAt !== undefined) && repliesOf(b, from).length > 0;
    });
    run(2);
    return { from, entry: lastEntry(b), said: repliesOf(b, from) };
}

if (live.length >= 4) {
    const L = 3;
    BotModelNs.setModelForTest('stub', { latencyTicks: L, plantRate: 0 });
    const b = live[0];
    stage(b);

    // a named line the rules understand: the model words it, timed from the decision
    let r = ask(b, `${b.displayName} whats ur cb`);
    check('replies: a named line\'s reply in the model\'s words (the stub\'s, through the guard), said once', r.entry?.outcome === 'used' && r.said.length === 1 && r.entry.said !== undefined && r.said[0].text.toLowerCase().includes(String(b.combatLevel)), { entry: r.entry, said: r.said });
    check('replies: never before the persona could have typed it from the decision, nor before the answer came + 1', r.entry && r.entry.saidAt >= r.entry.t + quickest(b, r.entry.said) && r.entry.saidAt >= r.entry.t + L + 1, r.entry && { t: r.entry.t, saidAt: r.entry.saidAt, quickest: quickest(b, r.entry.said) });
    check('replies: never after the deadline (20 ticks after the decision)', r.entry && r.entry.saidAt <= r.entry.t + BotModelNs.MODEL_DEADLINE_TICKS, r.entry && { t: r.entry.t, saidAt: r.entry.saidAt });
    check('replies: the request carried both prompts and the situation\'s facts', BotModelNs.modelStats.requests >= 1 && r.entry.heard.includes('whats ur cb'));
    check('replies: the conversation\'s 30 s run from when the model\'s reply was said (as the rules\')', BotChat.inConversation(b));

    // a line of the conversation nothing understands: the model answers it now and then (here: the die says so)
    run(5);
    const c0 = BotModelNs.modelStats.candidates.used;
    r = withDice(0, () => ask(b, 'did u ever see a purple cow on ice mountain'));
    check('candidates: a conversation\'s line nothing understood gets a model reply (with a model, at its chance)', r.entry?.candidate === true && r.entry.via === 'conversation' && r.entry.outcome === 'used' && BotModelNs.modelStats.candidates.used === c0 + 1, r.entry);
    // ("follow me" is the rules': no request, and its Follow)
    run(5);
    const e0 = log().length;
    const fr = ask(b, 'follow me', 30);
    check('scope in the world: "follow me" stays the rules\' (no request for it)', log().length === e0 && !log().slice(e0).some(e => e.heard === 'follow me'), log().slice(e0));
    void fr;
    // (the conversation ends: a goodbye)
    ask(b, 'bye', 30);
    run(60);

    // a named line nothing understands: the persona's chance, then the model's reply
    stage(b);
    r = withDice(0, () => ask(b, `${b.displayName} blorf quux zibble`));
    check('candidates: a named line nothing understood gets a model reply at the persona\'s chance', r.entry?.candidate === true && r.entry.via === 'named' && r.entry.outcome === 'used', r.entry);
    ask(b, 'bye', 30);
    run(60);

    // the deadline: no answer, the rules' line at once
    BotModelNs.setModelChannel(() => {});
    stage(b);
    r = ask(b, `${b.displayName} whats ur total`, 45);
    check('fallback: no answer by the deadline: the rules\' line, at once at the deadline', r.entry?.outcome === 'deadline' && r.said.length === 1 && r.entry.ruleText !== null && r.said[0].t >= r.entry.t + BotModelNs.MODEL_DEADLINE_TICKS && r.said[0].t <= r.entry.t + BotModelNs.MODEL_DEADLINE_TICKS + 1, { entry: r.entry, said: r.said });

    // an error: the rules' line at its own time
    BotModelNs.setModelChannel(msg => BotModelNs.onModelReply({ type: 'bots-lm-reply', id: msg.id, text: null, source: null, error: 'failed: test', ms: 5 }));
    run(5);
    r = ask(b, `${b.displayName} whats ur cb`);
    check('fallback: an error answer: the rules\' line, typed from the decision (not before it could be)', r.entry?.outcome === 'error' && r.entry.reason === 'failed: test' && r.said.length === 1 && r.said[0].t >= r.entry.t + 2, { entry: r.entry, said: r.said });

    // native's own timeout (9 s, before the engine's deadline): the rules' line typed from the decision, not at once (the
    // review of the merge: it was said at once, before the persona could have typed it)
    BotModelNs.setModelChannel(msg => BotModelNs.onModelReply({ type: 'bots-lm-reply', id: msg.id, text: null, source: null, error: 'timeout', ms: 9000 }));
    run(5);
    r = ask(b, `${b.displayName} whats ur cb`);
    check("fallback: native's own 'timeout': the rules' line, typed from the decision (not before it could be)", r.entry?.outcome === 'timeout' && r.said.length === 1 && r.entry.ruleText !== null && r.said[0].t >= r.entry.t + quickest(b, r.entry.ruleText), { entry: r.entry, said: r.said, quickest: r.entry && quickest(b, r.entry.ruleText ?? '') });

    // native has no backend: 'unavailable', the rules' line
    BotModelNs.setModelChannel(msg => BotModelNs.onModelReply({ type: 'bots-lm-reply', id: msg.id, text: null, source: null, error: 'unavailable', ms: 1 }));
    run(5);
    r = ask(b, `${b.displayName} whats ur cb`);
    check("fallback: native's 'unavailable' (no backend): the rules' line, counted as unavailable", r.entry?.outcome === 'unavailable' && r.said.length === 1, { entry: r.entry, said: r.said });

    // the guard: a confession falls back
    BotModelNs.setModelChannel(msg => BotModelNs.onModelReply({ type: 'bots-lm-reply', id: msg.id, text: 'lol im a bot', source: 'local', ms: 5 }));
    run(5);
    r = ask(b, `${b.displayName} whats ur total`);
    check('fallback: a line the guard refuses: the rules\' line instead (the refusal\'s reason noted)', r.entry?.outcome === 'guard' && r.entry.reason === 'confession' && r.said.length === 1 && !/\bbot\b/i.test(r.said[0].text) && BotModelNs.modelStats.guard.confession >= 1, { entry: r.entry, said: r.said });

    // supersede: a newer line while the first waits; then a goodbye drops the waiting one
    BotModelNs.setModelChannel(() => {});
    run(5);
    const from = World.currentTick;
    BotChat.onPublicMessage(human, `${b.displayName} whats ur cb`);
    run(4);
    const first = lastEntry(b);
    BotChat.onPublicMessage(human, 'whats ur total');
    run(4);
    const second = lastEntry(b);
    run(10);
    check('supersede: a newer line in the conversation: the waiting reply falls back to its rules\' line', first && first.outcome === 'superseded' && second && second !== first && says.some(x => x.who === b.username && x.t >= from && x.text.toLowerCase() === (first.ruleText ?? '#').toLowerCase()), { first, second, said: repliesOf(b, from) });
    BotChat.onPublicMessage(human, 'bye');
    run(4);
    const third = lastEntry(b);
    run(30);
    check('supersede: a goodbye moves the conversation on: the waiting reply is dropped (its rules\' line never said)', second.outcome === 'superseded' && third !== second && !says.some(x => x.who === b.username && x.t >= from && x.text.toLowerCase() === (second.ruleText ?? '#').toLowerCase()), { second, third, said: repliesOf(b, from) });
    run(60);

    // a private message: the reply by private message, in the model's words
    BotModelNs.setModelForTest('stub', { latencyTicks: L, plantRate: 0 });
    const pmBot = live[1];
    const p0 = pms.length;
    const pmFrom = World.currentTick;
    BotChat.onPrivateMessage(human, pmBot.username, 'wyd');
    run(45, () => pms.length > p0);
    const pmEntry = lastEntry(pmBot);
    check('PMs: a private message\'s reply comes by private message, in the model\'s words, never out loud', pmEntry?.via === 'private' && pmEntry.outcome === 'used' && pms.slice(p0).some(m => m.from === pmBot.username) && !says.some(x => x.who === pmBot.username && x.t >= pmFrom && x.kind === 'reply'), { pmEntry, pms: pms.slice(p0) });

    // a reply-window answer nothing understands
    stage(b);
    lib.noteSpoke(b, 'social', World.currentTick, human);
    r = withDice(0, () => ask(b, 'blorf?'));
    check('candidates: a reply-window answer nothing understood gets a model reply (with a model, at its chance)', r.entry?.candidate === true && r.entry.via === 'window' && r.entry.outcome === 'used', r.entry);
    ask(b, 'bye', 30);
    run(60);

    // a question to nobody nothing understands: the crowd's chance, one responder
    for (const [i, o] of live.entries()) o.teleJump(3210 + (i % 3) * 2, 3426 + Math.floor(i / 3) * 3, 0);
    sim.teleportHuman(3212, 3429, 0);
    run(3);
    const q0 = log().length;
    withDice(0, () => {
        BotChat.onPublicMessage(human, 'does anyone know a good song');
        run(40);
    });
    const crowdEntries = log().slice(q0).filter(e => e.via === 'crowd');
    check('candidates: a question to nobody nothing understood: one bot\'s model reply', crowdEntries.length === 1 && crowdEntries[0].candidate && crowdEntries[0].outcome === 'used', log().slice(q0));
    run(60);

    // at most 3 in flight in the world: the 4th falls back at once ('busy')
    BotModelNs.setModelChannel(() => {});
    const b0 = log().length;
    for (const [i, o] of live.slice(0, 4).entries()) BotChat.onPrivateMessage(human, o.username, i % 2 ? 'whats ur cb' : 'how r u');
    run(2);
    const burst = log().slice(b0);
    check('the world\'s cap: at most 3 requests in flight; the 4th falls back at once ("busy")', burst.length === 4 && burst.filter(e => e.outcome === 'busy').length === 1 && BotModelNs.modelRequestsInFlight() === 3, burst.map(e => `${e.bot} ${e.outcome}`));
    run(60);

    // no channel: the rules' line at once
    BotModelNs.setModelChannel(null);
    stage(b);
    r = ask(b, `${b.displayName} whats ur cb`, 35);
    check('glue: a request with no channel falls back at once: the rules\' line at its own time', r.entry?.outcome === 'channel' && r.said.length === 1, { entry: r.entry, said: r.said });
    ask(b, 'bye', 30);
    run(60);

    // every model reply said: never before its typing, never after its deadline
    const used = log().filter(e => e.outcome === 'used' && e.saidAt !== undefined);
    const early = used.filter(e => e.saidAt < e.t + Math.min(quickest(World.getPlayerByUsername(e.bot) ?? b, e.said), 3));
    const late = used.filter(e => e.saidAt > e.t + BotModelNs.MODEL_DEADLINE_TICKS + (e.via === 'private' ? 9 : 0));
    check(`replies: all ${used.length} model replies said after their typing and by their deadline`, used.length >= 5 && early.length === 0 && late.length === 0, { early, late });

    // the stub's planted bad lines: all caught by the guard
    BotModelNs.setModelForTest('stub', { latencyTicks: 2, plantRate: 1 });
    stage(b);
    const pl0 = log().length;
    for (const line of ['whats ur cb', 'how r u', 'whats ur total', 'where r u', 'wyd', 'how long u played', 'whats up', 'u there?']) {
        BotChat.onPrivateMessage(human, b.username, line);
        run(25);
    }
    const planted = log().slice(pl0).filter(e => e.planted);
    check('the stub: its planted bad lines are all refused by the guard', planted.length >= 6 && planted.every(e => e.outcome === 'guard'), planted.map(e => `${e.planted}→${e.outcome}/${e.reason}: ${e.raw}`));
    run(60);
}

// ---- no model again: a sim asks nothing ----
BotModelNs.resetModelForTest();
{
    const stage2 = live[0];
    stage(stage2);
    for (const line of [`${stage2.displayName} hi`, 'whats ur cb', 'blorf', 'how do i get to varrock', 'bye']) {
        BotChat.onPublicMessage(human, line);
        run(25);
    }
    BotChat.onPrivateMessage(human, stage2.username, 'hey');
    run(40);
    check('no model: a while of chat asks nothing (no request, no eligible reply)', BotModelNs.modelStats.eligible === 0 && BotModelNs.modelStats.requests === 0, BotModelNs.modelStats);
    // (the app's own rules mode: the page's channel attached, the mode 'rules', both backends there: still nothing asked;
    // the review of the merge)
    const sent = [];
    BotModelNs.setModelChannel(msg => sent.push(msg));
    BotModelNs.setModelMode({ mode: 'rules', local: true, online: true });
    for (const line of [`${stage2.displayName} hey`, 'whats ur total', 'zorp', 'bye']) {
        BotChat.onPublicMessage(human, line);
        run(25);
    }
    BotChat.onPrivateMessage(human, stage2.username, 'u there');
    run(40);
    check('rules mode with a channel and both backends there (the app\'s own state): nothing asked', sent.length === 0 && BotModelNs.modelStats.eligible === 0, { sent: sent.length, eligible: BotModelNs.modelStats.eligible });
    BotModelNs.resetModelForTest();
}

const failed = checks.filter(c => !c.ok);
for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`);
out(`${failed.length ? 'FAIL' : '0 FAIL'}; model: ${checks.length - failed.length} of ${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
