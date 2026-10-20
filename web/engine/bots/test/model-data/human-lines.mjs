#!/usr/bin/env node
// The human's lines for the language model's training situations (the realism work, phase 7, Track L's first step:
// the research), by list and category. humanlike's --probe-lines reads the flat
// lists this writes to test/data/model-human-lines.json:
//   public     said next to a bot, {name} its name (one {name} a line: humanlike fills the first)
//   pm         private messages to a bot
//   followups  the human's next line to the same bot, public or private (no name: the conversation goes on)
//   talk       lines to nobody (the crowd and the reply window)
// Categories (the spec's): state (questions about the bot's state), small (small talk), odd (odd and long-tail
// questions: the model's real job, the rules understand few of them), insult (insults and banter), bot ("r u a bot"),
// help (where, how, quests, money), gear (gear and activity comments), slang (slang and typos as 2004 typed), members
// (members and F2P topics). Every line is one a 2004 player could have typed: no Grand Exchange, Slayer, osrs, phones,
// Discord, nothing after late 2004 (the period's own news is fine: Halo 2, WoW's launch, Castle Wars "next month",
// the Fremennik Trials). Only the chat's characters (lower case, digits, space and !?.,:;()-&*'@#+=£$%"[]).
//
//   node web/engine/bots/test/model-data/human-lines.mjs [--check]   writes test/data/model-human-lines.json (--check: only checks and counts)
//   node web/engine/bots/test/model-data/human-lines.mjs --focus=FILE   writes the round-2 sampler's weighted pool to FILE instead (POOL_R2 below)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const POOL_FILE = path.resolve(here, '../data/model-human-lines.json');

export const POOL = {
    public: {
        state: [
            'hi {name}', '{name} wyd', '{name} whats ur cb', '{name} where r u', '{name} how long have u played', '{name} what lvl is ur wc', '{name} whats ur total',
            'hey {name} hows it going', '{name} u there?', '{name} what lvl r u', '{name} whats ur combat', '{name} wat cb r u', '{name} what r u doing', '{name} what u doing',
            '{name} wuu2', '{name} whats ur str', '{name} whats ur att lvl', '{name} what def r u', '{name} whats ur mining lvl', '{name} whats ur fishing lvl', '{name} what fm lvl r u',
            '{name} whats ur cooking lvl', '{name} whats ur hp lvl', '{name} what range lvl', '{name} whats ur mage lvl', '{name} what prayer r u', '{name} whats ur smithing',
            '{name} what crafting lvl r u', '{name} whats ur rc lvl', '{name} whats ur thieving', '{name} agility lvl?', '{name} herblore lvl?', '{name} whats ur fletching lvl',
            '{name} whats ur highest skill', '{name} whats ur lowest skill', '{name} how much hp u got left', '{name} u hurt?', '{name} where are we', '{name} what is this place',
            '{name} how long u been on today', '{name} u been here long?', '{name} how much money u got', '{name} r u rich', '{name} how many logs u got', '{name} whatcha training',
            '{name} what skill u training', '{name} what u training', '{name} what u working on', '{name} what u going for', '{name} whats ur goal', '{name} u going for 99?',
            '{name} how close to lvl r u', '{name} how old r u', '{name} where u from', '{name} asl', '{name} r u a guy or a girl', '{name} how old is ur account',
            '{name} when did u start playing', '{name} did u just level?', '{name} did u die?', '{name} u ok?', '{name} r u ok', '{name} whats in ur inv', '{name} what u got in ur pack',
            '{name} r u members', '{name} what quests have u done', '{name} have u done dragon slayer', '{name} do u have rune', '{name} what armour is that', '{name} what weapon u using',
            '{name} u skilling or fighting', '{name} u busy?', '{name} r u afk', '{name} hello?', '{name} u alive?', '{name} what cb is that', 'yo {name} what lvl', '{name} whats ur best skill',
            '{name} u near lvl?', '{name} what xp u on'
        ],
        small: [
            'hey {name}', 'sup {name}', 'yo {name}', 'hiya {name}', 'hello {name}', '{name} hi', '{name} hey', 'heya {name}', '{name} sup', 'hi {name} :)', '{name} how r u', '{name} hows ur day',
            '{name} having fun?', '{name} im bored', '{name} this is boring lol', '{name} lol', '{name} haha', '{name} lmao', '{name} nice', '{name} cool', '{name} gz', '{name} gz on lvl',
            '{name} ty', '{name} thx', '{name} cya', '{name} bye', '{name} night', '{name} gl', '{name} gl with that', '{name} same lol', '{name} me too', '{name} wanna be friends',
            '{name} can i add u', '{name} ur funny', '{name} u seem cool', '{name} hows school', '{name} got school tmrw?', '{name} whats up', '{name} wassup', '{name} hows ur luck today',
            '{name} long time no see', '{name} remember me?', '{name} i think i know u', '{name} wb', '{name} u came back', '{name} ur everywhere lol', '{name} nice name', '{name} cool name',
            '{name} what does ur name mean', '{name} i like ur name', '{name} hows the xp', '{name} nice day for it', '{name} its so quiet today', '{name} lots of ppl here', '{name} so laggy today',
            '{name} lag?', '{name} is it lagging for u', '{name} how was ur weekend', 'morning {name}', 'evening {name}', '{name} still here lol', '{name} u always here?', '{name} we meet again',
            '{name} heh', '{name} :)', '{name} :P', '{name} xD', '{name} rofl'
        ],
        odd: [
            '{name} whats ur fav color', '{name} do u like pizza', '{name} is zezima real', '{name} have u seen zezima', '{name} whats the meaning of life', '{name} can u swim', '{name} what music u like',
            '{name} do u like linkin park', '{name} green day or eminem', '{name} u play halo 2?', '{name} getting wow?', '{name} wow comes out soon right', '{name} u play any other games',
            '{name} have u played half life 2', '{name} gta san andreas or this', '{name} do u have a dog', '{name} got any pets', '{name} whats ur real name', '{name} whats for dinner',
            '{name} what did u eat today', '{name} whats 2+2', '{name} whats 9 times 7', '{name} can u count to 10', '{name} say something funny', '{name} tell me a joke', '{name} do u believe in ghosts',
            '{name} whats in the varrock vault', '{name} can u get in the bank vault', '{name} is there a christmas drop this year', '{name} castle wars comes out next month right',
            '{name} do u think theyll add a new skill', '{name} whats ur fav monster', '{name} whats ur fav food in rs', '{name} whats ur fav skill', '{name} whats the worst skill', '{name} whats ur fav place',
            '{name} which god u like saradomin or zamorak', '{name} zammy or sara', '{name} guthix?', '{name} do u like the wildy', '{name} ever been to the kq', '{name} how strong is the kbd',
            '{name} have u killed a dragon', '{name} whats the rarest item', '{name} is white phat the rarest', '{name} how much is a phat', '{name} would u buy a phat', '{name} what would u do with 10m',
            '{name} if u had 1m what would u buy', '{name} whats the best armour', '{name} whats better rune or dragon', '{name} whats the best weapon', '{name} is a d long good', '{name} can u fly in this game',
            '{name} can u get married in rs', '{name} will u marry me lol', '{name} r u single lol', '{name} do u have a gf', '{name} do u have a bf', '{name} whats the time where u are',
            '{name} is it night there', '{name} do u go to school', '{name} what grade r u in', '{name} what do u do irl', '{name} do u have a job', '{name} how tall r u', '{name} do u like football',
            '{name} who won the world series', '{name} red sox fan?', '{name} who u voting for lol', '{name} seen the incredibles', '{name} do u read harry potter', '{name} whats ur fav movie',
            '{name} what tv u watch', '{name} do u like simpsons', '{name} whats ur fav band', '{name} do u like pokemon', '{name} firered or leafgreen', '{name} u have an xbox', '{name} ps2 or xbox',
            '{name} do u use dial up', '{name} is ur comp fast', '{name} whats ur msn', '{name} do u have aim', '{name} do u go on tip.it', '{name} do u use runehq', '{name} whats ur fav quest',
            '{name} did u do fremennik trials', '{name} is horror from the deep hard', '{name} have u done regicide', '{name} whats past the gate in al kharid', '{name} have u been to karamja',
            '{name} is the wizards tower haunted', '{name} why is draynor manor so creepy', '{name} whats under lumbridge', '{name} why do cows moo', '{name} do chickens fly', '{name} can u eat a cabbage',
            '{name} is hans old', '{name} hans has been walking forever lol', '{name} do npcs sleep', '{name} who is the king of varrock', '{name} whats ur fav emote', '{name} can u dance',
            '{name} do the cheer emote', '{name} whats ur fav npc', '{name} who would win a goblin or a cow', '{name} whats the hardest monster', '{name} what happens if u die', '{name} whats the highest lvl in the game',
            '{name} how many people play this', '{name} how many worlds r there', '{name} whats the best world', '{name} who made this game', '{name} do jagex read chat', '{name} is there a mod here',
            '{name} if u could add anything to rs what would it be', '{name} do u dream about rs lol', '{name} whats the longest u played in a day', '{name} do ur parents let u play', '{name} is ur mom ok with this',
            '{name} do u think the sea has an end', '{name} does karamja have volcanoes', '{name} how do u spell lumbridge', '{name} what does gz mean', '{name} what does pk mean', '{name} what does f2p mean'
        ],
        insult: [
            '{name} ur bad', '{name} nub', '{name} newb', '{name} lol ur poor', '{name} ur gear is bad', '{name} ur armour sucks', '{name} stfu', '{name} shut up', '{name} ur so slow', '{name} ur ugly lol',
            '{name} lol nice lvl', '{name} lol low lvl', '{name} ur cb is so low', '{name} i could own u', '{name} i bet u cant beat me', '{name} fight me', '{name} ur scared', '{name} lol nub',
            '{name} get a life', '{name} go away', '{name} ur annoying', '{name} stop following me', '{name} u stole my rock', '{name} ks', '{name} kill stealer', '{name} that was my tree', '{name} rock stealer',
            '{name} ur a scammer', '{name} u look like a newb', '{name} why r u so bad', '{name} ur clothes r gay lol', '{name} idiot', '{name} ur dumb', '{name} lol pwned', '{name} owned', '{name} haha ur poor',
            '{name} is that all u got', '{name} my little brother is higher than u', '{name} u type weird', '{name} ur name is dumb', '{name} who asked', '{name} nobody cares', '{name} cry more', '{name} lol nerd',
            '{name} ur still here? lol'
        ],
        bot: [
            '{name} r u a bot', '{name} ru a bot', '{name} are you a bot', '{name} bot?', '{name} u a bot?', '{name} ur a bot lol', '{name} r u autoing', '{name} r u macroing', '{name} ur an autoer',
            '{name} macroer', '{name} r u real', '{name} say something if ur real', '{name} prove ur not a bot', '{name} type banana if ur not a bot', '{name} r u a human', '{name} r u even a person',
            '{name} u talk like a bot', '{name} why do u always do the same thing', '{name} i think ur a bot', '{name} reported for macroing', '{name} ima report u', '{name} r u a robot', '{name} beep boop',
            '{name} bots everywhere lol', '{name} r u a real person', '{name} ur too fast to be real', '{name} u never stop lol', '{name} r u cheating', '{name} do u use a autoclicker', '{name} r u at ur comp',
            '{name} anyone home?', '{name} r u asleep', '{name} hello?? bot?', '{name} answer if ur real', '{name} lol are u autoing'
        ],
        help: [
            '{name} where can i mine iron', '{name} where do i get a pickaxe', '{name} how do i get to fally', '{name} how do i get to varrock', '{name} how do i make money', '{name} how do i get rich',
            '{name} where are the cows', '{name} where is the bank', '{name} wheres the nearest bank', '{name} how do i get to draynor', '{name} how do i get to al kharid', '{name} how do i get to karamja',
            '{name} where can i fish lobsters', '{name} where do u get lobs', '{name} where can i cut willows', '{name} where are yews', '{name} how do i cook', '{name} where is a range', '{name} how do i make a fire',
            '{name} how do i smith', '{name} where is the furnace', '{name} where do i get an axe', '{name} where can i buy a sword', '{name} where do i train att', '{name} whats a good place to train',
            '{name} how do i get 99', '{name} hows the best way to train wc', '{name} best fishing xp?', '{name} best way to train mining', '{name} how do i get to the wildy', '{name} is the wildy dangerous',
            '{name} how do i do cooks assistant', '{name} where do i get an egg', '{name} how do i start dragon slayer', '{name} who gives the quest for vampire slayer', '{name} how do i do the restless ghost',
            '{name} what quest should i do', '{name} what quests give good xp', '{name} where do i get a hammer', '{name} where can i sell stuff', '{name} where is the general store', '{name} how do i get feathers',
            '{name} where can i get bait', '{name} how do i make a bow', '{name} how do i get rune ess', '{name} how do i runecraft', '{name} where is the air altar', '{name} where is aubury',
            '{name} how much is a rune scim', '{name} how much is a rune 2h', '{name} how much r lobs', '{name} price of coal?', '{name} how much r yews worth', '{name} whats iron ore worth', '{name} pc on addy plate?',
            '{name} how do i get a cape', '{name} where can i buy a cape', '{name} how do i turn on run', '{name} how do i add friends', '{name} how do i get out of here', '{name} im lost', '{name} help',
            '{name} can u help me', '{name} what should i train', '{name} should i train str or att', '{name} what lvl for rune', '{name} what lvl can i wear addy', '{name} what def for rune armour',
            '{name} how do u get prayer up', '{name} where can i get big bones', '{name} where do i kill hill giants', '{name} where can i kill moss giants', '{name} whats a good money maker', '{name} where is oziach'
        ],
        gear: [
            '{name} nice gear', '{name} nice armour', '{name} nice scim', '{name} nice axe', '{name} nice pick', '{name} nice hat', '{name} nice cape', '{name} nice boots', '{name} nice sword',
            '{name} where did u get that', '{name} how much was ur armour', '{name} can i have ur armour', '{name} nice drop', '{name} nice logs', '{name} how many fish u got', '{name} lots of ore lol',
            '{name} is this a good spot', '{name} is this spot good xp', '{name} good spot?', '{name} how is the xp here', '{name} how many have u cut', '{name} u been cutting long', '{name} u fishing?',
            '{name} u mining?', '{name} nice fire', '{name} burnt it lol', '{name} u burnt that lol', '{name} nice kill', '{name} that was fast', '{name} u kill that fast', '{name} need food?',
            '{name} want a lob', '{name} ur almost dead lol', '{name} eat!', '{name} u should eat', '{name} run!', '{name} watch out', '{name} that giant is hitting u', '{name} ur hp is low',
            '{name} i like ur outfit', '{name} ur colours r cool', '{name} matching lol', '{name} full rune? nice', '{name} why do u wear that', '{name} y no helm', '{name} that shield is ugly lol',
            '{name} cool weapon', '{name} is that a rune axe', '{name} is that addy?', '{name} is that rune?', '{name} what kind of logs r those'
        ],
        slang: [
            '{name} wat r u doin', '{name} wuts ur cb', '{name} were is draynor', '{name} u gud?', '{name} lolz', '{name} wut', '{name} wat', '{name} huh', '{name} k', '{name} kk', '{name} ok', '{name} ya',
            '{name} nm u', '{name} nm', '{name} omg', '{name} omfg', '{name} wtf', '{name} y', '{name} y not', '{name} plz', '{name} plzz', '{name} thnx', '{name} gratz', '{name} grats m8', '{name} sup m8',
            '{name} wanna c something', '{name} brb', '{name} bbl', '{name} jk', '{name} idk', '{name} nvm', '{name} wats up wit u', '{name} wat lvl ur wc', '{name} ur pro'
        ],
        members: [
            '{name} r u p2p', '{name} is members worth it', '{name} wat is it like in p2p', '{name} can f2p go to catherby', '{name} how much is members', '{name} should i get members', '{name} members or f2p',
            '{name} whats the best members skill', '{name} is agility good', '{name} what is herblore', '{name} how do u do thieving', '{name} is seers good for yews', '{name} where do u fish sharks',
            '{name} have u been to the duel arena', '{name} wanna stake', '{name} whats in members land', '{name} is f2p better', '{name} my mom wont pay for members', '{name} how long u been members',
            '{name} whats the gnome stronghold like', '{name} is ardougne big', '{name} what can u do in camelot', '{name} is the party room fun', '{name} how do i get a dragon long', '{name} r u f2p',
            '{name} how do u pay for members', '{name} can i have members lol', '{name} members r lucky', '{name} is fishing guild members', '{name} whats canifis'
        ]
    },
    pm: {
        state: [
            'hey', 'wyd', 'where r u', 'whats ur cb', 'what lvl r u', 'u there?', 'hi how are you', 'what r u doing', 'where u at', 'whats ur total', 'what u training', 'what u up to', 'how long u been on',
            'whats ur wc', 'whats ur mining lvl', 'what fishing lvl r u', 'whats ur str', 'what att r u', 'whats ur def', 'hp lvl?', 'mage lvl?', 'range lvl?', 'cooking lvl?', 'whats ur highest',
            'where u training', 'u skilling?', 'u fighting?', 'u still on?', 'u busy?', 'how much money u got', 'what world r u on lol', 'how old r u', 'where u from', 'asl', 'u members?',
            'what quests u done', 'what armour u wearing', 'what weapon u got', 'did u level', 'u die?', 'u ok', 'u alive', 'what u going for', 'whats ur goal', 'how close to 99 r u',
            'how long u been playing', 'when did u start', 'hows the xp', 'u afk?', 'hello?'
        ],
        small: [
            'hi', 'hello', 'sup', 'yo', 'hiya', 'heya', 'lol', 'haha', 'how r u', 'hows it going', 'whats up', 'nm u', 'im bored', 'so bored lol', 'remember me?', 'its me lol', 'hey its me from before',
            'saw u earlier', 'u were at the bank right', 'ur cool', 'wanna be friends', 'added u', 'ty for adding', 'hows ur day', 'having fun?', 'cya', 'bye', 'gtg soon', 'brb', 'back', 'night',
            'gn', 'gl', 'gz', 'grats on the lvl', 'ty', 'thx', 'np', 'lol same', 'same here', 'me too', 'got school tmrw', 'my mom says get off soon', 'just got home', 'just ate dinner',
            'im eating lol', 'hows school', 'what u doing this weekend', 'u on later?', 'u on tmrw?', 'long day', 'ugh homework', 'it snowed here lol', 'its raining here', 'i like ur name',
            'xD', ':)', ':P', 'rofl', 'lmao'
        ],
        odd: [
            'whats ur fav color', 'do u like pizza', 'is zezima real', 'whats the meaning of life', 'can u swim irl', 'what music u like', 'do u like linkin park', 'u play halo 2?', 'getting wow when it comes out?',
            'u play any other games', 'half life 2 is sick', 'do u have pets', 'whats ur real name', 'whats for dinner', 'whats 2+2', 'tell me a joke', 'do u believe in ghosts', 'whats in the varrock vault',
            'will there be a christmas drop', 'castle wars soon right', 'think theyll add a new skill?', 'whats ur fav monster', 'whats ur fav skill', 'zammy or sara', 'ever been to the kq',
            'have u killed a dragon', 'whats the rarest item', 'how much is a phat', 'what would u do with 10m', 'whats better rune or dragon', 'do u have a gf', 'r u single lol', 'what time is it there',
            'what grade r u in', 'do u have a job', 'red sox fan?', 'seen the incredibles', 'whats ur fav movie', 'do u like simpsons', 'firered or leafgreen', 'xbox or ps2', 'do u have dial up',
            'whats ur msn', 'do u have aim', 'u go on runehq?', 'whats ur fav quest', 'did u do fremennik trials', 'whats under lumbridge castle', 'do npcs sleep', 'who would win a goblin or a cow',
            'whats the highest lvl', 'how many worlds r there', 'do jagex read pms', 'if u could add anything to rs what would it be', 'do u dream about rs', 'longest u played in a day?',
            'do ur parents mind u playing', 'what do u want for christmas', 'whats ur fav food irl', 'how tall r u', 'do u have brothers', 'what country r u in', 'do u speak english good', 'whats the weather like',
            'is it cold there', 'did u see the news', 'do u like school', 'whats ur fav subject', 'can u keep a secret', 'guess what', 'i got a new comp', 'my comp keeps freezing', 'my internet is so slow',
            'how do u type so fast', 'what keyboard u have lol', 'do u like cats or dogs', 'whats ur birthday', 'how many friends u got on here', 'who is ur best friend on rs', 'have u ever been scammed',
            'ever got pked?', 'what was ur best drop', 'have u met a mod', 'have u met jagex', 'is it true u can get free members', 'is doubling money real'
        ],
        insult: [
            'ur bad', 'nub', 'lol ur poor', 'stfu', 'shut up', 'go away', 'ur annoying', 'stop pming me', 'who r u', 'why u ignoring me', 'answer me', 'rude', 'u suck', 'ur so slow', 'ur gear is trash',
            'lol nub', 'i could own u', 'fight me', 'ur scared', 'u stole my rock', 'u ksed me', 'ur a scammer', 'idiot', 'loser', 'lol nerd', 'get a life', 'cry more', 'whatever', 'u wish', 'ur weird'
        ],
        bot: [
            'r u a bot', 'ru a bot', 'are you a bot', 'bot?', 'ur a bot lol', 'r u autoing', 'r u macroing', 'r u real', 'say something if ur real', 'prove ur not a bot', 'r u human', 'r u a real person',
            'u talk like a bot', 'i think ur a bot', 'reported lol', 'type banana', 'r u at ur comp', 'why do u reply so fast', 'r u cheating', 'r u an autoer', 'why do u never stop', 'beep boop lol',
            'r u a robot', 'r u even there'
        ],
        help: [
            'how much is a rune scim', 'can u help me', 'where can i mine iron', 'how do i get to fally', 'how do i make money', 'where do i get a pickaxe', 'where are the cows', 'wheres the bank',
            'how do i get to varrock', 'where can i fish lobs', 'where are yews', 'how do i do cooks assistant', 'what quest should i do', 'how do i start dragon slayer', 'how do i smith', 'where is a furnace',
            'how do i cook', 'how do i make a fire', 'where do i train', 'whats a good place to train', 'how do i get rich', 'where can i sell stuff', 'whats coal worth', 'how much r lobs', 'how much is iron ore',
            'pc on rune med?', 'how do i get feathers', 'how do i runecraft', 'where is aubury', 'how do i turn on run', 'im lost', 'help plz', 'what should i train', 'str or att first?', 'what lvl for rune',
            'how do u train prayer', 'where can i kill moss giants', 'whats a good money maker', 'how do i get to karamja', 'how do i get to al kharid'
        ],
        gear: [
            'nice gear', 'where did u get ur armour', 'how much was ur scim', 'can i have ur armour', 'nice drop earlier', 'how many logs u got', 'how many fish u got', 'is that a good spot', 'how is the xp there',
            'u cutting?', 'u fishing?', 'u mining?', 'u still at the same spot?', 'nice cape', 'cool outfit', 'is that rune', 'what pick u got', 'what axe u using', 'need food?', 'u low hp?', 'u eat?', 'run lol'
        ],
        slang: [
            'wat r u doin', 'wuts ur cb', 'were r u', 'u gud?', 'lolz', 'wut', 'wat', 'huh', 'k', 'kk', 'ok', 'ya', 'nm', 'omg', 'wtf', 'y', 'plz', 'thnx', 'gratz', 'sup m8', 'bbl', 'jk', 'idk', 'nvm',
            'wats up wit u'
        ],
        members: [
            'r u p2p', 'is members worth it', 'wat is it like in p2p', 'how much is members', 'should i get members', 'members or f2p', 'whats the best members skill', 'is agility good', 'what is herblore',
            'have u been to the duel arena', 'wanna stake', 'my mom wont pay for members', 'how long u been members', 'is the party room fun', 'r u f2p', 'can i have members lol', 'whats seers like', 'where do u fish sharks'
        ]
    },
    followups: {
        state: [
            'what lvl?', 'what cb?', 'whats ur total?', 'how many logs?', 'how much xp?', 'what armour?', 'what weapon?', 'how long u been here?', 'how much money?', 'what skill?', 'how close?', 'where?',
            'where is that', 'u?', 'and u?', 'what about u', 'how old?', 'where u from?', 'how long did that take', 'how long u played today', 'what u training next', 'whats ur goal', 'u going for 99?',
            'whats ur hp', 'u members?', 'how much hp u got', 'u ok?', 'u almost dead?', 'did u level?', 'how many kills', 'which tree', 'which rock', 'what fish', 'what quest', 'how far is it',
            'what world', 'u still there?', 'u busy?', 'still training?', 'how many u got now'
        ],
        small: [
            'lol', 'cool', 'nice', 'same', 'k', 'ok', 'kk', 'ok ty', 'ty', 'thx', 'lol ok', 'wow', 'really?', 'rly?', 'oh', 'ah', 'i see', 'nice one', 'cool cool', 'lol same', 'me too', 'haha', 'lmao', 'rofl',
            'xD', ':)', ':P', 'yea', 'ya', 'yep', 'nope', 'no', 'yes', 'sure', 'maybe', 'i guess', 'fair enough', 'thats cool', 'thats sick', 'awesome', 'sweet', 'gl', 'gl with that', 'gz', 'grats', 'np',
            'u play much?', 'im bored', 'what u doing after', 'u on tmrw?', 'cya', 'bye', 'gtg', 'brb', 'back', 'anyway', 'so', 'hmm', 'ok then', 'alright', 'lol true', 'true', 'good point', 'nvm',
            'never mind', 'forget it', 'wait what', 'huh', 'wat', '?', '??', 'what?', 'y?', 'y tho', 'why', 'how come', 'is it good xp', 'is it fun', 'is it hard', 'worth it?', 'thats a lot',
            'thats not much', 'lol nice', 'jealous', 'lucky', 'lol unlucky', 'ouch', 'rip lol', 'oh well'
        ],
        odd: [
            'whats ur fav skill', 'how old r u', 'where u from', 'whats ur fav color', 'do u like pizza', 'do u have pets', 'what music u like', 'u play halo 2', 'getting wow?', 'is zezima real', 'whats ur real name',
            'do u have a gf', 'r u a girl', 'r u a guy', 'what grade r u in', 'do u like school', 'whats for dinner', 'whats the time there', 'is it night there', 'tell me a joke', 'say something funny',
            'whats 2+2', 'do u believe in ghosts', 'whats ur fav monster', 'zammy or sara', 'have u killed a dragon', 'whats the rarest item', 'would u buy a phat', 'what would u do with 1m', 'whats better rune or dragon',
            'red sox fan?', 'seen the incredibles?', 'whats ur fav movie', 'whats ur fav band', 'xbox or ps2', 'pokemon?', 'do u use runehq', 'whats ur fav quest', 'have u done dragon slayer', 'do npcs sleep',
            'who would win a goblin or a cow', 'can u dance', 'do the dance emote', 'what would u add to rs', 'do u dream about rs', 'do ur parents let u play', 'whats ur msn', 'how tall r u',
            'do u like cats or dogs', 'whats ur birthday', 'have u been scammed', 'ever been pked', 'whats ur best drop', 'met a mod?', 'whats past the gate', 'whats under lumbridge', 'why do cows moo',
            'do chickens fly', 'is hans old', 'can u keep a secret', 'guess what', 'wanna know something', 'do u like snow', 'whats ur fav food', 'whats ur fav place in rs', 'christmas drop this year?',
            'castle wars next month?', 'new skill coming?'
        ],
        insult: [
            'ur bad', 'nub', 'lol nub', 'lol ur poor', 'stfu', 'shut up', 'whatever', 'who asked', 'nobody cares', 'u wish', 'ur weird', 'ur annoying', 'go away', 'lol loser', 'cry more', 'ur so slow',
            'lol low lvl', 'my brother is higher', 'i could own u', 'fight me then', 'ur scared', 'liar', 'u lie', 'no way', 'prove it', 'ur gear sucks', 'lol pwned', 'owned', 'rude', 'jeez', 'calm down',
            'chill', 'relax lol', 'ok mr pro', 'sure u are', 'lol ok nerd', 'idiot', 'ur dumb', 'lol fail', 'get a life', 'u stole my rock', 'ks', 'that was mine', 'u type weird', 'u always say that'
        ],
        bot: [
            'r u a bot', 'ru a bot', 'bot?', 'ur a bot', 'r u real', 'say something real', 'type banana', 'r u autoing', 'r u macroing', 'u sound like a bot', 'ur too fast', 'u always reply the same',
            'r u human', 'lol bot', 'i think ur a bot', 'reported', 'r u at ur comp', 'why so fast', 'say ur name backwards', 'whats my name', 'what did i just say', 'r u even reading this', 'beep boop',
            'r u a robot', 'answer properly', 'u didnt answer', 'thats not what i asked', 'r u a real person', 'u never stop playing'
        ],
        help: [
            'how do i get there', 'which way', 'north?', 'is it far', 'how far', 'can u show me', 'where exactly', 'what do i need', 'what lvl do i need', 'is it members', 'is it safe',
            'how much does it cost', 'how much is it worth', 'whats a good price', 'where do i sell it', 'how do i start', 'who do i talk to', 'what next', 'then what', 'how long does it take',
            'is it good money', 'whats better', 'should i do it', 'what should i train', 'str or att?', 'where do i get one', 'can i buy it', 'where is the shop', 'whats the fastest way',
            'can u help me', 'help plz', 'i dont get it', 'i cant find it', 'im lost', 'i died lol', 'how do i get back', 'where do i respawn', 'how do i bank'
        ],
        gear: [
            'nice gear', 'nice armour', 'where did u get it', 'how much was it', 'can i have it', 'is it good', 'is that rune', 'is that addy', 'cool cape', 'nice hat', 'how many u got', 'u cutting?',
            'u fishing?', 'u mining?', 'eat!', 'ur low', 'need food?', 'run', 'watch out', 'nice kill', 'nice drop', 'lucky drop', 'what did it drop', 'u burnt it lol', 'nice fire', 'lol u missed',
            'that was fast', 'how many have u cut', 'whats in ur inv'
        ],
        slang: [
            'lolz', 'wut', 'y not', 'nm', 'omg', 'omfg', 'wtf', 'jk', 'idk', 'plz', 'thnx', 'kewl', 'sweet as', 'gratz', 'u 2', 'ur pro', 'lol jk', 'w8', 'w8 4 me', 'c ya',
            'ttyl', 'g2g', 'bbl', 'wb', 'tru'
        ],
        members: [
            'r u members?', 'is it members?', 'is members worth it', 'how much is members', 'should i get members', 'what can u do in p2p', 'is agility good', 'whats herblore', 'f2p sucks lol', 'members r lucky',
            'my mom wont pay', 'can f2p go there', 'is seers good', 'have u been to the duel arena', 'wanna stake', 'how long u been members'
        ]
    },
    talk: {
        state: [
            'whats ur cb', 'what lvl is everyone', 'whats everyones total', 'who here has 99', 'anyone here members', 'anyone high lvl here', 'whos the highest lvl here', 'anyone 70 wc', 'anyone got 40 att',
            'what lvl r u guys', 'anyone training str', 'whats everyone doing', 'wyd all', 'anyone fishing', 'anyone mining', 'anyone cutting', 'where is everyone', 'anyone on', 'is anyone here',
            'how long u guys been playing'
        ],
        small: [
            'hi', 'hey all', 'wyd', 'lol', 'gz', 'nice', 'hello', 'sup', 'ty', 'cya', 'hi all', 'hey guys', 'yo', 'sup all', 'hiya', 'morning all', 'evening all', 'whats up', 'im bored', 'so bored lol',
            'this is boring', 'anyone wanna be friends', 'add me', 'anyone wanna talk', 'hows everyone', 'lag', 'so laggy', 'lag?', 'is it lagging', 'haha', 'lmao', 'rofl', 'omg', 'wow', ':)',
            'xD', 'brb', 'back', 'gtg', 'night all', 'gn all', 'bye all', 'gl all', 'gz all', 'lol nice', 'woot', 'yay', 'finally', 'ugh', 'damn', 'oops', 'lol oops'
        ],
        odd: [
            'is zezima real', 'whats the meaning of life', 'anyone play halo 2', 'who is getting wow', 'anyone like linkin park', 'green day rocks', 'red sox won!', 'anyone seen the incredibles', 'anyone from canada',
            'anyone from uk', 'anyone from usa', 'anyone from australia', 'whats the rarest item', 'how much is a phat', 'is there a christmas drop this year', 'castle wars next month right',
            'think theyll add a new skill?', 'zammy or sara', 'whats ur fav skill', 'whats ur fav monster', 'what would u do with 10m', 'whats better rune or dragon', 'can u get in the varrock vault',
            'whats under lumbridge castle', 'do npcs sleep', 'who would win a goblin or a cow', 'anyone wanna dance', 'lets all dance', 'anyone got pokemon leafgreen', 'xbox or ps2', 'half life 2 is out',
            'anyone use dial up', 'anyone have aim', 'who wants to hear a joke', 'whats 2+2', 'do chickens fly', 'why do cows moo', 'is hans immortal', 'hans has been walking for years lol', 'is there a mod here',
            'do jagex read this', 'how many people play this', 'what was ur best drop', 'anyone ever been scammed', 'anyone ever get pked', 'whats ur fav quest', 'fremennik trials is so hard',
            'horror from the deep is hard', 'did anyone do regicide', 'whats past the al kharid gate', 'whats the hardest monster', 'can u fly in this game', 'can u get married in rs', 'who wants to marry me lol',
            'anyone single lol', 'anyone got school tmrw', 'my mom says i gotta get off', 'it snowed here', 'anyone else bored', 'whats the time there', 'its 3am here lol', 'whats everyones fav color'
        ],
        insult: [
            'noobs everywhere', 'nubs', 'lol newbs', 'everyone here is poor', 'ur all bad', 'stop spamming', 'shut up', 'stfu', 'who keeps stealing my rocks', 'ks!', 'stop ksing', 'rock stealer', 'that was my tree',
            'stop following me', 'go away', 'scammer!', 'dont trade him hes a scammer', 'lol nerds', 'get a life', 'idiots'
        ],
        bot: [
            'r u a bot', 'r u bots', 'anyone real here', 'is anyone here real', 'so many bots', 'bots everywhere lol', 'r u guys macroing', 'autoers', 'reported all u macroers', 'everyone here is a bot lol',
            'say something if ur real', 'type banana if ur human', 'r u all bots', 'macroers everywhere', 'any humans here'
        ],
        help: [
            'how do i get to varrock', 'where is the bank', 'whats the best way to make money', 'how do i get to fally', 'where can i mine iron', 'where do i get a pickaxe', 'where are the cows', 'how do i make money',
            'where can i fish lobs', 'where are yews', 'how do i cook', 'where is a range', 'how do i make a fire', 'how do i smith', 'where is the furnace', 'where can i buy an axe', 'how do i get to al kharid',
            'how do i get to karamja', 'how do i get to draynor', 'how do i do cooks assistant', 'where do i get an egg', 'how do i start dragon slayer', 'where is oziach', 'what quest should i do',
            'where can i sell stuff', 'where is the general store', 'how do i get feathers', 'how do i runecraft', 'where is aubury', 'how do i turn on run', 'how do i add friends', 'im lost', 'help',
            'can someone help me', 'what should i train', 'str or att first?', 'what lvl for rune', 'how do u train prayer', 'where can i kill moss giants', 'whats a good money maker', 'how much is a rune scim',
            'pc on addy plate?', 'how much r lobs worth', 'whats coal worth', 'where do i train', 'whats a good place to train', 'how do i get out of lumbridge', 'were r the cows', 'wat do i do now',
            'how do i wear this', 'is this game free', 'should i get members'
        ],
        gear: [
            'nice gear', 'nice armour', 'who has rune', 'anyone have a spare pick', 'anyone got a spare axe', 'anyone have food', 'anyone got bait', 'anyone got feathers', 'is this a good spot', 'good xp here?',
            'this spot is full', 'trees r all taken', 'rocks r all gone', 'lol so many people here', 'nice drop', 'lucky', 'omg rune drop', 'i got a rune med!', 'my axe head flew off', 'anyone seen my axe head',
            'burnt another one', 'lol i burnt it', 'timber!', 'lol tree spirit', 'omg an ent', 'whirlpool!', 'river troll lol', 'rock golem lol', 'omg gas', 'i died lol'
        ],
        slang: [
            'wat r u guys doin', 'wuts up', 'were is the bank', 'lolz', 'wut', 'wat', 'huh', 'k', 'kk', 'omfg', 'wtf', 'plz help', 'thnx', 'gratz', 'sup m8s', 'bbl', 'jk', 'idk', 'nvm', 'w8'
        ],
        members: [
            'anyone members', 'is members worth it', 'how much is members', 'members or f2p', 'whats the best members skill', 'is agility good', 'what is herblore', 'f2p is better lol',
            'members r lucky', 'my mom wont pay for members', 'anyone stake?', 'whats seers like', 'where do u fish sharks', 'is the party room fun', 'anyone been to the duel arena'
        ]
    }
};

/**
 * The retrain's lines (phase 7, round 2: after the first blind test): aimed at the model's weak spots, questions
 * its own facts answer (inv: what it carries and how many; worn: its gear; levels: a skill by name, its best, its total,
 * "anyone 70 wc"; doing: what it is doing and its plans), opinions and favourites it can answer in character (opinion),
 * yes/no questions about itself (yesno), follow-ups that build on its last reply (build) and the odd long tail (tail).
 * Merged into the lists by category; --focus writes the round-2 sampler's pool, weighted toward them.
 */
export const POOL_R2 = {
    public: {
        inv: [
            '{name} wat u carrying', '{name} whats in ur pack', '{name} what u got on u', '{name} how many u got', '{name} how much ore u got', '{name} how many fish u caught',
            '{name} got any food', '{name} u got food on u', '{name} how much gp u carrying', '{name} what runes u got', '{name} got a pick on u', '{name} got an axe?', '{name} what logs u got',
            '{name} u carrying anything good', '{name} is ur inv full', '{name} how many coins u got', '{name} show me ur inv lol', '{name} how many shrimps u got', '{name} u got any lobs'
        ],
        worn: [
            '{name} what r u wearing', '{name} is that a rune scim', '{name} whats that helm', '{name} is that full rune', '{name} is that black armour', '{name} what kind of shield is that',
            '{name} what scim is that', '{name} is that mith', '{name} nice legs lol', '{name} what boots r those', '{name} whats ur weapon', '{name} where did u get ur cape', '{name} is that a d med',
            '{name} what amulet is that', '{name} nice platebody', '{name} why no armour', '{name} is that a bow?'
        ],
        levels: [
            '{name} whats ur highest lvl', '{name} what skill is ur highest', '{name} whats ur total lvl', '{name} how high is ur total', '{name} what lvl is ur best skill', '{name} whats ur woodcutting',
            '{name} whats ur str lvl', '{name} hows ur fishing', '{name} what mining r u', '{name} u got 40 att?', '{name} is ur def higher than ur att', '{name} whats ur range lvl', '{name} what lvl magic r u',
            '{name} wats ur prayer', '{name} r u higher than me', '{name} whats ur worst skill', '{name} any 99s?', '{name} what cooking r u', '{name} what lvl is ur fm', '{name} whats ur hp at'
        ],
        doing: [
            '{name} what r u up to', '{name} what u gonna do next', '{name} what r u saving for', '{name} what r u training today', '{name} u gonna stay here long', '{name} whats ur plan',
            '{name} y r u here', '{name} what r u waiting for', '{name} u cutting or what', '{name} whats this place good for', '{name} what u gonna train next', '{name} what quest u doing'
        ],
        opinion: [
            '{name} whats ur fav weapon', '{name} whats the best skill', '{name} whats ur fav armour', '{name} do u like fishing', '{name} is mining boring', '{name} whats the most boring skill',
            '{name} whats ur fav city', '{name} fally or varrock', '{name} do u like pking', '{name} scim or long', '{name} whats better mage or range', '{name} do u like this game'
        ],
        yesno: [
            '{name} u members?', '{name} r u from uk', '{name} u from usa?', '{name} r u a girl', '{name} r u a kid', '{name} r u new', '{name} u ever been pked', '{name} have u got a cape',
            '{name} u got rune?', '{name} u been to karamja?', '{name} have u done any quests', '{name} r u rich lol', '{name} u in school', '{name} u on a lot?', '{name} r u famous lol'
        ],
        tail: [
            '{name} whats ur fav song', '{name} do u like snow', '{name} what did u get for ur bday', '{name} whats the best day of the week', '{name} do u like cheese', '{name} what time do u go to bed',
            '{name} ever been to america', '{name} do u like rain', '{name} cats or dogs', '{name} what kind of comp u got', '{name} whats ur fav cereal', '{name} do u play football',
            '{name} whats the capital of france', '{name} did u watch the simpsons last night', '{name} what would u name a dog', '{name} if u were a monster what would u be'
        ]
    },
    pm: {
        inv: [
            'whats in ur inv', 'what u carrying', 'whats in ur pack', 'u got any food', 'how much ore u got', 'what runes u got', 'how much gp u got on u', 'is ur pack full', 'what u got on u',
            'u carrying much?', 'how many coins u got', 'what logs u got', 'how many u got'
        ],
        worn: ['what r u wearing', 'is that a rune scim', 'what helm u got', 'what scim u using', 'u got full rune?', 'what shield u got', 'u wearing a cape?', 'what amulet u got', 'what boots u got', 'nice armour btw'],
        levels: [
            'whats ur highest lvl', 'whats ur best skill', 'what skill is ur highest', 'whats ur total lvl', 'whats ur lowest', 'what lvl is ur best', 'any 99s?', 'whats ur wc lvl', 'what str r u',
            'whats ur prayer', 'u got 40 def?', 'what cooking lvl r u', 'whats ur thieving'
        ],
        doing: ['what u doing rn', 'whats ur plan', 'what u gonna do next', 'what r u saving for', 'what u training today', 'u gonna be there long', 'what quest u doing', 'whats next for u', 'where u going after'],
        opinion: ['whats ur fav weapon', 'whats the best skill', 'whats the most boring skill', 'fally or varrock', 'do u like pking', 'scim or long', 'mage or range', 'do u like fishing', 'is mining boring', 'whats ur fav city'],
        yesno: ['r u from uk', 'u from usa?', 'r u new', 'r u a kid', 'r u a girl', 'u ever been pked', 'u got rune?', 'u been to karamja?', 'done any quests?', 'u in school', 'u on a lot?', 'r u rich', 'u got a cape?'],
        tail: [
            'whats ur fav song', 'do u like snow', 'what did u get for ur bday', 'do u like cheese', 'what time do u go to bed', 'cats or dogs', 'what kind of comp u got', 'whats ur fav cereal',
            'do u play football', 'whats the capital of france', 'what would u name a dog', 'if u were a monster what would u be', 'did u see the simpsons', 'whats ur fav holiday', 'whats the best pizza'
        ]
    },
    followups: {
        build: [
            'how many?', 'which one', 'since when', 'is that good?', 'is that high?', 'what lvl is that', 'whats that', 'what else u got', 'anything else?', 'what about ur str', 'and ur def?',
            'whats ur att then', 'what about ur wc', 'and ur total?', 'how much did it cost', 'y that skill', 'why there', 'whats it like', 'u like it?', 'so whats ur best', 'ok but whats ur cb',
            'lol so what u doing', 'wait what r u doing', 'u didnt say ur lvl', 'thats it?', 'only that?', 'thats low lol', 'thats high', 'nice what next', 'cool what r u saving for',
            'what r u gonna do with them', 'how many more', 'how long till lvl', 'so u members?', 'so where r u from', 'and how old r u', 'whats ur fav then', 'which is better', 'u sure?',
            'no way thats true', 'what do u mean', 'what does that mean', 'u serious?', 'lol really', 'night', 'nite', 'what ore?', 'what logs?', 'which skill?', 'where at?', 'what for?',
            'so u rich?', 'thats a lot of logs', 'what r u gonna make', 'can u even wear that', 'whats ur cb again', 'and ur highest?', 'u got any 99s', 'what lvl u need for that', 'is that ur main',
            'how old is ur acc', 'did u buy it', 'what did it cost u', 'and ur mining?', 'what u got in ur inv then'
        ]
    },
    talk: {
        inv: ['anyone got a spare tinderbox', 'anyone have a knife', 'anyone got runes', 'whats everyone carrying lol', 'anyone got logs', 'anyone have bones', 'anyone got a hammer', 'who has food'],
        worn: ['who here has full rune', 'anyone got a d med', 'whos got the best armour here', 'anyone wearing rune', 'nice capes everyone lol', 'who has a rune scim', 'anyone got a cape'],
        levels: [
            'whats everyones highest skill', 'anyone 60 wc', 'anyone here 50 att', 'anyone got 40 str', 'whats ur best skill guys', 'whats everyones cb', 'anyone over 1000 total', 'anyone got 99 anything',
            'who has the highest total here', 'anyone 70 fishing', 'anyone have 43 pray', 'whos the lowest lvl here lol', 'anyone got 31 att', 'what lvl r u all at mining'
        ],
        doing: ['what is everyone training', 'what u all doing here', 'what r u guys saving for', 'anyone doing quests', 'who else is cutting', 'what r u all fishing'],
        opinion: ['whats the best skill', 'whats the most boring skill', 'fally or varrock', 'scim or long', 'mage or range whats better', 'whats the best f2p money', 'whats ur fav city', 'pking is fun right'],
        yesno: ['anyone from sweden', 'anyone here new', 'anyone a kid lol', 'anyone in school', 'anyone p2p here', 'anyone f2p', 'anyone done dragon slayer', 'anyone been to karamja'],
        tail: [
            'whats everyones fav song', 'anyone like snow', 'anyone watch the simpsons', 'whats the capital of france lol', 'cats or dogs', 'anyone got a dog', 'whats for dinner guys', 'anyone like cheese',
            'whos up late', 'anyone play football'
        ]
    }
};

const CHARSET = /^[a-z0-9 !?.,:;()\-&*'@#+=£$%"[\]]*$/;
/** (the quests' names are 2001's: Dragon Slayer, Vampire Slayer, Demon Slayer) */
const QUEST_SLAYER = /\b(dragon|vampire|demon) slayer\b/gi;
/** what the pool must never carry (the human's lines are 2004-plausible too) */
const ANACHRONISM = /\b(grand exchange|ge|slayer|construction|hunter|summoning|dungeoneering|osrs|old ?school|rs3|wiki|discord|twitch|youtube|reddit|tiktok|iphone|android|smartphone|chatgpt|gpt|chatbot|emoji|twitter)\b/i;

/** The flat lists humanlike reads, and the problems found (empty: none). */
export function buildPool() {
    const problems = [];
    const out = {};
    const counts = {};
    for (const [list, base] of Object.entries(POOL)) {
        const cats = { ...base, ...(POOL_R2[list] ?? {}) };
        const seen = new Set();
        out[list] = [];
        counts[list] = {};
        for (const [cat, lines] of Object.entries(cats)) {
            counts[list][cat] = 0;
            for (const line of lines) {
                if (seen.has(line)) {
                    problems.push(`${list}/${cat}: "${line}" twice`);
                    continue;
                }
                seen.add(line);
                if (!CHARSET.test(line.replace('{name}', 'x').toLowerCase())) problems.push(`${list}/${cat}: "${line}" has a character the chat drops`);
                if (ANACHRONISM.test(line.replace(QUEST_SLAYER, 'quest'))) problems.push(`${list}/${cat}: "${line}" names something 2004 lacked`);
                if (line.length > 70) problems.push(`${list}/${cat}: "${line}" is long`);
                const names = (line.match(/\{name\}/g) ?? []).length;
                if (list === 'public' && names !== 1) problems.push(`public/${cat}: "${line}" needs exactly one {name}`);
                if (list !== 'public' && names !== 0) problems.push(`${list}/${cat}: "${line}" has a {name}`);
                out[list].push(line);
                counts[list][cat]++;
            }
        }
    }
    return { lists: out, counts, problems };
}

/** the round-2 categories' weight in the focus pool (humanlike picks a list's lines evenly: a line twice is drawn twice as often) */
const FOCUS_WEIGHT = { state: 2, gear: 2, odd: 1, small: 1 };
/**
 * The round-2 sampler's pool (--focus=FILE): every list, weighted toward the weak spots: the round-2 categories 3 times,
 * state and gear twice, odd and small talk once, the rest (insults, "r u a bot", help, slang, members) every other line.
 */
export function focusPool() {
    const lists = {};
    for (const [list, base] of Object.entries(POOL)) {
        lists[list] = [];
        for (const [cat, lines] of Object.entries(base)) {
            const w = FOCUS_WEIGHT[cat] ?? 0;
            if (w) for (let i = 0; i < w; i++) lists[list].push(...lines);
            else lists[list].push(...lines.filter((_, i) => i % 2 === 0));
        }
        for (const lines of Object.values(POOL_R2[list] ?? {})) for (let i = 0; i < 3; i++) lists[list].push(...lines);
    }
    return lists;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { lists, counts, problems } = buildPool();
    for (const p of problems) console.log(`problem: ${p}`);
    let total = 0;
    for (const [list, cats] of Object.entries(counts)) {
        const n = Object.values(cats).reduce((a, b) => a + b, 0);
        total += n;
        console.log(`${list.padEnd(10)} ${String(n).padStart(4)}  ${Object.entries(cats).map(([c, k]) => `${c} ${k}`).join(', ')}`);
    }
    console.log(`total      ${String(total).padStart(4)}`);
    const need = { public: 500, pm: 250, followups: 250, talk: 200 };
    for (const [list, min] of Object.entries(need)) if (lists[list].length < min) problems.push(`${list}: ${lists[list].length} lines, the spec asks for ${min}`);
    if (problems.length) {
        console.log(`${problems.length} problem(s)`);
        process.exit(1);
    }
    const focus = process.argv.find(a => a.startsWith('--focus='));
    if (focus) {
        const file = path.resolve(focus.slice('--focus='.length));
        const lists = focusPool();
        const about = 'The round-2 sampler\'s pool (phase 7 retrain): test/model-data/human-lines.mjs --focus, every line of model-human-lines.json weighted toward the weak spots (a line may repeat: humanlike draws evenly).';
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ _about: about, ...lists }, null, 1) + '\n');
        console.log(`wrote the focus pool ${file} (${Object.entries(lists).map(([k, v]) => `${k} ${v.length}`).join(', ')})`);
    } else if (!process.argv.includes('--check')) {
        const about = 'The human\'s lines for humanlike\'s --probe-lines (realism phase 7: the language model\'s training situations). public: said next to a bot, {name} its name; pm: private messages to a bot; followups: the human\'s next line to the same bot (no name: the conversation goes on); talk: lines to nobody. Written by test/model-data/human-lines.mjs (by category there: state, small talk, odd and long-tail, insults, "r u a bot", help, gear and activity, slang, members); edit that file, not this one.';
        const json = `{\n  "_about": ${JSON.stringify(about)},\n  "_counts": ${JSON.stringify(counts)},\n${['public', 'pm', 'followups', 'talk'].map(k => `  "${k}": [\n${lists[k].map(l => `    ${JSON.stringify(l)}`).join(',\n')}\n  ]`).join(',\n')}\n}\n`;
        fs.writeFileSync(POOL_FILE, json);
        console.log(`wrote ${path.relative(process.cwd(), POOL_FILE)}`);
    }
}
