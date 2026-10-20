// port (the realism work, phase 4: looks; "2004 bodies", "patchwork gear" and "rares and veterans",
// the research): what a bot looks like, as a pure function of its name (port/BotSeed, never
// Math.random), so the same name gives the same body, taste in gear and rare: a bot that leaves before its first save
// comes back the same.
//   gender   matched to the name where it is clearly a man's or a woman's: a word ("Lady Luck", "Mr Bargain"), a first
//            name ("Sarah Jane", "Kevin1991", "Wizard Tim"), a woman's middle name ("Holly Mae", "Lobster Lou"); else
//            a man, but FALLBACK_FEMALE of the time. The names already hold the period's share of women (10-15 % of the
//            first 200-1,000 names, the pools of 100-500 online), so about 12-16 % of the bots are women (Jagex's polls:
//            90 % of players men in 2008, 84 % in 2014; 2004 younger and more male). The default was 88/12 by the name's
//            dice for every name not in a list: on top of these names that made about 21 % women
//   body     every kit and colour from the name, over 274's whole palette (12 hair, 16 torso, 16 legs, 6 boot and 8 skin
//            colours: the server's own check of a design, Player.DESIGN_BODY_COLORS, the client's ClientPlayer.recol1d);
//            a newcomer in the design screen's clothes, its head its own (BotAppearance)
//   taste    the pieces it likes (a full or medium helm or none, a platebody or a chainbody, platelegs or a plateskirt, a
//            kiteshield, a square shield or none), whether it wears a matching set, the accessories it wears
//   rares    about 1 bot in 60 online, only experienced and veteran ones, most of them vendors and social regulars at the
//            hubs: a partyhat 1 in 4, else a santa hat or a Halloween mask
//   holiday  about 1 veteran in 4: the 2003 bunny ears or scythe (untradeable in 274: never sold, never dropped)
//   top      about 1 veteran in 4 that is no skiller (about 1 bot in 100): combat 100-120 (port/BotAge)
// Only new bots get these (BotAppearance.randomize and port/BotAge run for a bot with no save): a saved bot keeps its
// body and kit (no re-styling). What any bot buys and wears from now on follows the taste.
import ObjType from '#/cache/config/ObjType.js';
import InvType from '#/cache/config/InvType.js';
import type Player from '#/engine/entity/Player.js';
import { Items } from '#/engine/bot/BotKnowledge.js';
import { nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
import type { PlannerKey } from '#/engine/bot/port/BotRoster.js';
import type { AgeTier } from '#/engine/bot/port/BotAge.js';
import { nameClassOf, outfitItemIds } from '#/engine/bot/port/BotOutfits.js';
// (the variety work, round 2, track W2: the status pieces are armour of their metal)
import { fashionItemIds, STATUS_RANK, statusPieces, type StatusFamily } from '#/engine/bot/port/BotFashion.js';

// ── gender ────────────────────────────────────────────────────────────────────

/** a man's name not in a list is a woman's this often (see the header) */
export const FALLBACK_FEMALE = 0.03;

/** words that make a name a woman's wherever they stand */
const FEMALE_WORDS: ReadonlySet<string> = new Set(['girl', 'gal', 'lass', 'lady', 'princess', 'queen', 'miss', 'mrs', 'witch', 'sorceress', 'fairy', 'kitty']);
/** words that make a name a man's wherever they stand */
const MALE_WORDS: ReadonlySet<string> = new Set(['boy', 'man', 'lad', 'dude', 'guy', 'king', 'lord', 'sir', 'mr', 'bloke', 'geezer', 'grandad']);
/** women's middle names, after a first word ("Holly Mae", "Sarah Jane", "Market Mary") */
const FEMALE_SECOND: ReadonlySet<string> = new Set(['jane', 'rose', 'mae', 'may', 'marie', 'ann', 'anne', 'belle', 'fay', 'mary', 'sally', 'sue', 'jo', 'lou', 'lu', 'rae', 'leigh']);
/** women's first names (only the clearly female: Sam, Charlie, Jamie, Alex, Riley, Taylor, Ashley, Frankie are left to the dice) */
const FEMALE_NAMES: ReadonlySet<string> = new Set(
    (
        'sarah sara emma lucy becky becca bex sophie gemma laura kat kate katie kirsty lisa lindsey kelsey abbie abi nikki ' +
        'bethan bethany jess jessica leanne ellie hannah niamh rosie chloe sian tegan chelsea kayla sinead orla bianca ' +
        'shelby jen jenna jenny lily lacey brittany georgia amber imogen vicky gina cerys megan freya kelly tessa toni ' +
        'siobhan courtney kayleigh zoe molly naomi jade lauren ffion stacey natalie kara leah tahlia ashleigh hollie demi ' +
        'caitlin rach rachel amy tiffany bree eilidh haley hayley samantha charlotte maddie stephy steph amelia rhian ' +
        'madison morven kylie brianna aisling daisy jodie lottie danielle harriet robyn holly keeley kaitlyn kerry nadia ' +
        'ciara bryony bonnie tilly eleanor tia darcy aoife sadie shazza shannon tara tasha libby carly sasha fleur zara ' +
        'paige hazel maisie brooke yasmin mia josie poppy alice chantelle erin saskia olivia rhiannon nicola evie jasmine ' +
        'alana bronwyn renee mollie kerri hermione kristy taylah kristen haylee keira lexie tamara elise chrissy ella ' +
        'fliss aimee callie jemma alyssa roisin shona wendy victoria mckenzie natasha alicia kaylee francesca destiny lizzie ' +
        'kimberley millie sammie debbie lydia amanda isla emily melanie alexis shanice iona kendra kirsten rebecca ashlee ' +
        'tayla grace mikayla carla milly neha skye tracy tania kim fern misty'
    ).split(' ')
);
/** men's first names */
const MALE_NAMES: ReadonlySet<string> = new Set(
    (
        'kevin kev matty danny stevo tim jonno pete rory davo eddie dan ricky larry will chaz gary tom tommy ted max jimmy ' +
        'steve benny owen chris josh mike paulie gaz macca robbo jacko liam ryan craig dean joey aaron connor harry nathan ' +
        'mitch marcus ethan reece alfie fraser hamish dale finn jacob jayden luke declan lewis aidan joel benji austin ' +
        'damien harvey gareth lee brandon euan niall cameron corey kai jesse trevor shane colby devin jamesy stu mark jordo ' +
        'hayden conor shano gibbo garrett archie zach matt nick brendan wesley craigy jonny dafydd bradley zack sid kenzo ' +
        'deano felix owain ronan ross dylan padraig bazza ravi travis jay stew lachlan duncan karl imran grant fitzy tyler ' +
        'bobby simon zane caleb henrik cole tyrone magnus jamal jason reggie murph arran derek ivan andre isaac ed harrison ' +
        'col kian kurt bram kirk blake mason george lars jonty luis ruben omar lukas spencer kenny jared dmitri dewi davey ' +
        'kofi scotty wade wilf elijah darren ellis jesper dougie kieran marky ray leon troy rocco tristan logan arjun oscar ' +
        'seb ronnie robbie adam monty glen jonah theo pedro jens ciaran jonesy malcolm drew marco jarrod raj gavin bertie ' +
        'timo jeroen kasper nico viktor jasper jude sully erik thor toby elliot hamza tez stefan russ jimbo angus tariq bryn ' +
        'yusuf jon sven sanjay ruairi curtis damon dane clint earl keith danno cooper tate brayden trey dwayne gav weston ' +
        'nicko simmo ben shaun darragh nate gethin darryl scott cian cormac rossco damo lachie garth toddy chad joshua stuey ' +
        'greg nathaniel jeffo sebastian aled fergus justin eric wills colton chazza freddie dominic patrick brady steven ' +
        'lochie luca joe rhodri zachary phil tadhg neilo kane brett trent jake kyle mikey jack dom ollie callum rob brodie ' +
        'wayne dustin rhys jye chase mitchy hendo jono daniel cody vic cal rupert bryce tony paddy godfrey vex merlin gandalf daz'
    ).split(' ')
);

export type GenderSource = 'female word' | 'male word' | 'female name' | 'male name' | 'dice';

/** The words of a name, lower case ("Kevin1991" → kevin; "Holly Mae" → holly, mae). */
function wordsOf(name: string): string[] {
    return name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

/** Why a name is a man's or a woman's (the first rule that applies), or 'dice'. */
export function genderSourceOf(name: string): GenderSource {
    const words = wordsOf(name);
    if (words.some(w => FEMALE_WORDS.has(w))) return 'female word';
    if (words.some(w => MALE_WORDS.has(w))) return 'male word';
    if (words.length && FEMALE_NAMES.has(words[0])) return 'female name';
    if (words.length && MALE_NAMES.has(words[0])) return 'male name';
    const later = words.slice(1);
    if (later.some(w => FEMALE_NAMES.has(w) || FEMALE_SECOND.has(w))) return 'female name';
    if (later.some(w => MALE_NAMES.has(w))) return 'male name';
    return 'dice';
}

/** 0 male, 1 female: from the name where it tells, else FALLBACK_FEMALE by its dice (the same every time). */
export function genderOf(name: string): 0 | 1 {
    const source = genderSourceOf(name);
    if (source === 'female word' || source === 'female name') return 1;
    if (source === 'male word' || source === 'male name') return 0;
    return seededRandom(nameSeed(name, 'gender'))() < FALLBACK_FEMALE ? 1 : 0;
}

/** The dice of a bot's body (kits and colours) and its starter weapon. */
export function bodyDice(name: string): () => number {
    return seededRandom(nameSeed(name, 'body'));
}

// ── armour: the pieces by kind and metal ──────────────────────────────────────

export type ArmourSlot = 'helm' | 'body' | 'legs' | 'shield';
export type PieceKind = 'full' | 'med' | 'plate' | 'chain' | 'platelegs' | 'skirt' | 'kite' | 'sq' | 'wooden';

/** the metals, worst to best (the index is a piece's tier); the wooden shield is tier -1 */
export const METALS = ['bronze', 'iron', 'steel', 'black', 'mithril', 'adamant', 'rune', 'dragon'] as const;
/** the Defence level each metal's armour needs (274's wear scripts) */
export const METAL_DEFENCE: readonly number[] = [1, 1, 5, 10, 20, 30, 40, 60];
/** the worn slot (274's wearpos) of each armour slot */
export const SLOT_WEARPOS: Readonly<Record<ArmourSlot, number>> = { helm: 0, body: 4, legs: 7, shield: 5 };

export interface ArmourPiece {
    id: number;
    slot: ArmourSlot;
    kind: PieceKind;
    /**
     * METALS index; -1 for the wooden shield. port (the variety work, round 2, track W2: status gear) a status piece's is
     * its metal's and a little more (port/BotFashion STATUS_RANK: rune (g) 6.4, a god platebody 6.5, gilded 6.7): a bot
     * wears it over the plain piece of its metal, under the next metal's, and buys no plain piece of its metal over it
     */
    tier: number;
    /** (round 2, W2) a Treasure Trail trim, god or gilded piece: its family; undefined for a plain one */
    status?: StatusFamily;
}

let PIECES: ArmourPiece[] | null = null;
let PIECE_BY_ID: Map<number, ArmourPiece> | null = null;

/** Every armour piece a bot may own, by kind and metal (Items; built once, on first use). */
export function armourPieces(): readonly ArmourPiece[] {
    if (PIECES) return PIECES;
    const I = Items;
    const ladders: [ArmourSlot, PieceKind, (number | null)[]][] = [
        ['helm', 'full', [I.BRONZE_FULL_HELM, I.IRON_FULL_HELM, I.STEEL_FULL_HELM, I.BLACK_FULL_HELM, I.MITHRIL_FULL_HELM, I.ADAMANT_FULL_HELM, I.RUNE_FULL_HELM, null]],
        ['helm', 'med', [I.BRONZE_MED_HELM, I.IRON_MED_HELM, I.STEEL_MED_HELM, I.BLACK_MED_HELM, I.MITHRIL_MED_HELM, I.ADAMANT_MED_HELM, I.RUNE_MED_HELM, I.DRAGON_MED_HELM]],
        ['body', 'plate', [I.BRONZE_PLATEBODY, I.IRON_PLATEBODY, I.STEEL_PLATEBODY, I.BLACK_PLATEBODY, I.MITHRIL_PLATEBODY, I.ADAMANT_PLATEBODY, I.RUNE_PLATEBODY, null]],
        ['body', 'chain', [I.BRONZE_CHAINBODY, I.IRON_CHAINBODY, I.STEEL_CHAINBODY, I.BLACK_CHAINBODY, I.MITHRIL_CHAINBODY, I.ADAMANT_CHAINBODY, I.RUNE_CHAINBODY, null]],
        ['legs', 'platelegs', [I.BRONZE_PLATELEGS, I.IRON_PLATELEGS, I.STEEL_PLATELEGS, I.BLACK_PLATELEGS, I.MITHRIL_PLATELEGS, I.ADAMANT_PLATELEGS, I.RUNE_PLATELEGS, null]],
        ['legs', 'skirt', [I.BRONZE_PLATESKIRT, I.IRON_PLATESKIRT, I.STEEL_PLATESKIRT, I.BLACK_PLATESKIRT, I.MITHRIL_PLATESKIRT, I.ADAMANT_PLATESKIRT, I.RUNE_PLATESKIRT, null]],
        ['shield', 'kite', [I.BRONZE_KITESHIELD, I.IRON_KITESHIELD, I.STEEL_KITESHIELD, I.BLACK_KITESHIELD, I.MITHRIL_KITESHIELD, I.ADAMANT_KITESHIELD, I.RUNE_KITESHIELD, null]],
        ['shield', 'sq', [I.BRONZE_SQ_SHIELD, I.IRON_SQ_SHIELD, I.STEEL_SQ_SHIELD, I.BLACK_SQ_SHIELD, I.MITHRIL_SQ_SHIELD, I.ADAMANT_SQ_SHIELD, I.RUNE_SQ_SHIELD, I.DRAGON_SQ_SHIELD]]
    ];
    const out: ArmourPiece[] = [];
    for (const [slot, kind, ids] of ladders) ids.forEach((id, tier) => id !== null && out.push({ id, slot, kind, tier }));
    out.push({ id: I.WOODEN_SHIELD, slot: 'shield', kind: 'wooden', tier: -1 });
    // port (the variety work, round 2, track W2: WEAR-4) the status pieces after the plain ones (pieceOf finds the plain)
    for (const p of statusPieces()) out.push({ id: p.id, slot: p.slot, kind: p.kind, tier: p.metal + STATUS_RANK[p.family], status: p.family });
    PIECES = out;
    PIECE_BY_ID = new Map(out.map(p => [p.id, p]));
    return out;
}

/** The armour piece an item is, or undefined (anything else: leather, robes, a hat). */
export function armourPieceOf(id: number): ArmourPiece | undefined {
    if (!PIECE_BY_ID) armourPieces();
    return PIECE_BY_ID!.get(id);
}

let dragonShieldId = -2;
/**
 * (the variety work, round 2, the fixes) the anti-dragon shield: a green dragon trip's (port/BotWildTrips), no armour
 * shield goes on over it (BotAction._equipLoot, port/BotGear bankedArmourToWear: it is no armour piece, so any was better)
 */
export function isDragonShield(id: number): boolean {
    if (dragonShieldId === -2) dragonShieldId = ObjType.getId('antidragonbreathshield');
    return id !== -1 && id === dragonShieldId;
}

/** The plain piece of this kind and metal, or undefined (there is no dragon full helm in 2004). */
export function pieceOf(kind: PieceKind, tier: number): ArmourPiece | undefined {
    return armourPieces().find(p => p.kind === kind && p.tier === tier && !p.status);
}

/** The best metal (METALS index) this Defence level may wear; 0 at least. */
export function metalForDefence(defence: number): number {
    let best = 0;
    for (let t = 0; t < METAL_DEFENCE.length; t++) if (defence >= METAL_DEFENCE[t]) best = t;
    return best;
}

/** May a bot with this Defence wear the piece? (274's wear scripts: the metal's level; a status piece's its metal's) */
export function canWearPiece(piece: ArmourPiece, defence: number): boolean {
    return piece.tier < 0 || defence >= METAL_DEFENCE[Math.floor(piece.tier)];
}

// ── the wardrobe: accessories, rares, holiday items ───────────────────────────

/** The wardrobe's items by name (274's debugnames, resolved once on first use; test/content-names checks each name). */
export interface WardrobeItems {
    capes: number[];
    redCape: number;
    amuletStrength: number;
    amuletPower: number;
    amuletGlory: number;
    gloves: number;
    boots: number;
    wizardHat: number;
    blackWizardHat: number;
    chefsHat: number;
    brownApron: number;
    whiteApron: number;
    legendsCape: number;
    partyhats: number[];
    santaHat: number;
    masks: number[];
    bunnyEars: number;
    scythe: number;
}

let WARDROBE: WardrobeItems | null = null;
let SIGNATURE: Set<number> | null = null;
let WARDROBE_IDS: Set<number> | null = null;

export function wardrobeItems(): WardrobeItems {
    if (WARDROBE) return WARDROBE;
    WARDROBE = {
        // red (Thessalia sells it), then the colours a 2004 player dyed theirs (274's dye_cape) or found
        capes: [ObjType.getId('red_cape'), Items.BLACK_CAPE, Items.BLUE_CAPE, Items.YELLOW_CAPE, Items.GREEN_CAPE, Items.PURPLE_CAPE, Items.ORANGE_CAPE],
        redCape: ObjType.getId('red_cape'),
        amuletStrength: ObjType.getId('amulet_of_strength'),
        amuletPower: ObjType.getId('amulet_of_power'),
        amuletGlory: ObjType.getId('amulet_of_glory'),
        gloves: Items.LEATHER_GLOVES,
        boots: Items.LEATHER_BOOTS,
        wizardHat: Items.BLUEWIZHAT,
        blackWizardHat: Items.BLACK_WIZARD_HAT,
        chefsHat: ObjType.getId('chefs_hat'),
        brownApron: ObjType.getId('brown_apron'),
        whiteApron: ObjType.getId('white_apron'),
        legendsCape: Items.CAPE_OF_LEGENDS,
        partyhats: [Items.RED_PARTYHAT, Items.YELLOW_PARTYHAT, Items.BLUE_PARTYHAT, Items.GREEN_PARTYHAT, Items.PURPLE_PARTYHAT, Items.WHITE_PARTYHAT],
        santaHat: Items.SANTA_HAT,
        masks: [Items.GREEN_HALLOWEEN_MASK, Items.BLUE_HALLOWEEN_MASK, Items.RED_HALLOWEEN_MASK],
        bunnyEars: Items.BUNNY_EARS,
        scythe: ObjType.getId('scythe')
    };
    return WARDROBE;
}

/** The rares (partyhats, the santa hat, the Halloween masks). */
export function rareItems(): number[] {
    const w = wardrobeItems();
    return [...w.partyhats, w.santaHat, ...w.masks];
}

/** The 2003 holiday items: untradeable in 274 (never sold, never dropped, never in a trade). */
export function holidayItems(): number[] {
    const w = wardrobeItems();
    return [w.bunnyEars, w.scythe];
}

/**
 * A "signature hat": a rare or the bunny ears, which its owner keeps on whatever it does (no helm goes over it: CombatTask,
 * BotAction._equipLoot, port/BotGear). The scythe is no hat: a fight takes the bot's weapon, a skill gives it back.
 */
export function isSignatureHat(id: number): boolean {
    if (!SIGNATURE) SIGNATURE = new Set([...rareItems(), wardrobeItems().bunnyEars]);
    return SIGNATURE.has(id);
}

/** Does the bot wear its signature hat (a rare, the bunny ears)? */
export function wearsSignatureHat(player: Player): boolean {
    const hat = player.getInventory(InvType.WORN)?.get(SLOT_WEARPOS.helm);
    return !!hat && isSignatureHat(hat.id);
}

/**
 * A wardrobe item: an accessory, a hat or an apron, a rare or a holiday item; port (the variety work, round 1, track W) and
 * a ranger's or mage's piece, the skirts, the monk's robe, the pirate's hat (port/BotOutfits); (round 2, track W2) the
 * members fashion and the novelty pieces (port/BotFashion; the status pieces are armour). Never sold to a shop as
 * junk, never alched, never put on by a metal in its name (BotAction._equipLoot: "Black robe" read as black metal).
 */
export function isWardrobeItem(id: number): boolean {
    if (!WARDROBE_IDS) {
        const w = wardrobeItems();
        // (the variety work, round 2, track W2) and late 2004's members fashion and the novelty pieces (port/BotFashion)
        WARDROBE_IDS = new Set([...w.capes, w.amuletStrength, w.amuletPower, w.amuletGlory, w.gloves, w.boots, w.wizardHat, w.blackWizardHat, w.chefsHat, w.brownApron, w.whiteApron, w.legendsCape, ...rareItems(), ...holidayItems(), ...outfitItemIds(), ...fashionItemIds()]);
    }
    return WARDROBE_IDS.has(id);
}

// ── taste ─────────────────────────────────────────────────────────────────────

export interface GearTaste {
    /** wears a matching set of one metal (a new world's aged kits): about 3 in 10 */
    set: boolean;
    helm: 'full' | 'med' | 'none';
    body: 'plate' | 'chain';
    legs: 'platelegs' | 'skirt';
    shield: 'kite' | 'sq' | 'none';
    /** the accessories it wears when it has them, and buys (port/BotGear) */
    cape: boolean;
    /** its cape's colour (an index into wardrobeItems().capes; what it buys is red: Thessalia's) */
    capeColour: number;
    /**
     * (the realism work, phase 5b) a cape of its own liking, which it buys (port/BotGear): `cape` but for a clan's
     * member, whose new kit wears its clan's cape whatever it likes (`cape` and `capeColour` are the clan's)
     */
    ownCape: boolean;
    gloves: boolean;
    boots: boolean;
    /** a skiller's hat and apron (what it wears at a skill) */
    hat: 'wizard' | 'chef' | 'none';
    /** its wizard hat is the black one (Betty has both) */
    blackHat: boolean;
    apron: boolean;
    /** its apron is the white one (Thessalia has both) */
    whiteApron: boolean;
}

/** a test's tastes by name (test/lib/coverage: a case that needs a bot to want a certain piece) */
const tasteForTest = new Map<string, Partial<GearTaste>>();
export function setTasteForTest(name: string, taste: Partial<GearTaste> | null): void {
    if (taste) tasteForTest.set(name, taste);
    else tasteForTest.delete(name);
}

/**
 * port (the realism work, phase 5b, Track D: clan capes): a levelling clique's cape colour by a member's name (an index
 * into wardrobeItems().capes), null for a bot in none. port/BotCliques gives it at its load (this module is loaded early,
 * before the cliques' graph).
 */
let cliqueColourSource: ((name: string) => number | null) | null = null;
export function setCliqueColourSource(source: ((name: string) => number | null) | null): void {
    cliqueColourSource = source;
}

/** (the variety work, round 2, track W2: WEAR-10) the clique colour of a levelling clique's member (an index into wardrobeItems().capes), or null */
export function clanColourOf(name: string): number | null {
    return cliqueColourSource?.(name) ?? null;
}

/**
 * The pieces a bot likes (the same every time for the same name). port (the realism work, phase 5b: "clan
 * walks in matching capes", new bots their clique's colour): a member of a levelling clique wears its clan's cape, the
 * clique's colour (port/BotCliques cliqueColourOf), in its kit when it is made (port/BotAge: new bots only; saved bots
 * keep their looks); what it buys of its own accord is still its own liking (`ownCape`).
 */
export function gearTaste(name: string): GearTaste {
    let taste = tasteOf(name);
    // port (the variety work, round 1, track W: WEAR-6, looks that match the name): a knight's name ("Sir Loin", "Holy
    // Paladin") likes a full helm and a kiteshield, and half of the rest wear a matching set (its own seed)
    if (nameClassOf(name) === 'knight') taste = { ...taste, helm: 'full', shield: 'kite', set: taste.set || seededRandom(nameSeed(name, 'knight-set'))() < 0.5 };
    const clan = cliqueColourSource?.(name) ?? null;
    if (clan !== null) taste = { ...taste, cape: true, capeColour: clan };
    const forTest = tasteForTest.get(name);
    return forTest ? { ...taste, ...forTest } : taste;
}

function tasteOf(name: string): GearTaste {
    const r = seededRandom(nameSeed(name, 'taste'));
    const female = genderOf(name) === 1;
    const helmRoll = r();
    const shieldRoll = r();
    const hatRoll = r();
    const set = r() < 0.3;
    const helm = helmRoll < 0.5 ? 'full' : helmRoll < 0.85 ? 'med' : 'none';
    const body = r() < 0.6 ? 'plate' : 'chain';
    // (a plateskirt: half the women; 274's Ranael sells them in Al Kharid)
    const legs = female && r() < 0.5 ? 'skirt' : 'platelegs';
    const shield = shieldRoll < 0.45 ? 'kite' : shieldRoll < 0.85 ? 'sq' : 'none';
    const cape = r() < 0.5;
    return {
        set,
        helm,
        body,
        legs,
        shield,
        cape,
        capeColour: Math.floor(r() * 7),
        ownCape: cape,
        gloves: r() < 0.15,
        boots: r() < 0.25,
        hat: hatRoll < 0.35 ? 'wizard' : hatRoll < 0.55 ? 'chef' : 'none',
        apron: r() < 0.35,
        blackHat: r() < 0.3,
        whiteApron: r() < 0.4
    };
}

/**
 * Does the bot, created now, wear a skiller's look (no plate: a hat, an apron, a cape)? Most skillers, some balanced and
 * random bots (port/BotAge: a new world's kits). Its plate is in its bank; at a skill any bot takes it off (port/BotGear).
 */
export function skillerLook(name: string, planner: PlannerKey): boolean {
    const roll = seededRandom(nameSeed(name, 'skiller-look'))();
    if (planner === 'skiller') return roll < 0.85;
    if (planner === 'balanced' || planner === 'random') return roll < 0.3;
    return false;
}

// ── rares, holiday items, the top veterans ────────────────────────────────────

const PKER_PLANNERS: ReadonlySet<PlannerKey> = new Set<PlannerKey>(['extras_pker', 'extras_edgeville_pker']);
const RICH: ReadonlySet<AgeTier> = new Set<AgeTier>(['experienced', 'veteran']);

/**
 * Of the rich bots (experienced and veteran: a quarter of the aged planners' names, port/BotAge), the share in a rare,
 * by kind: the vendors and the social regulars stand at the hubs (half the vendors at Varrock West), where 2004's rich
 * players showed theirs off; a few levelling bots keep theirs on wherever they train. With the role mix online (7.5 %
 * vendors, 7.5 % social, 70 % levelling bots) about 1 bot in 60 online wears one (the default: "one or two rich bots at
 * Varrock or Falador" at 100 online); PKers are never aged and wear none.
 */
export const RARE_SHARE_OF_RICH: Readonly<Record<'vendor' | 'social' | 'levelling', number>> = { vendor: 0.35, social: 0.3, levelling: 0.025 };
/** About 1 veteran in 4 wears the 2003 bunny ears or scythe ("to show how long you have been playing", Tip.it 2004). */
export const HOLIDAY_SHARE = 0.25;
/**
 * About 1 veteran in 4 that is no skiller is at the top: combat 100-120 (veterans are 7 % of the aged planners' names,
 * those of the fighters, balanced, random, social and vendor bots 5 in 8 of all names: about 1 bot in 100; Zezima-era
 * high levels were rare).
 */
export const TOP_SHARE = 0.23;
export const TOP_COMBAT: readonly [number, number] = [100, 120];

/** The rare a bot of this name, tier and planner owns and wears, or null: a partyhat 1 in 4, else a santa hat or a mask. */
export function rareOf(name: string, tier: AgeTier, planner: PlannerKey): number | null {
    if (!RICH.has(tier) || PKER_PLANNERS.has(planner)) return null;
    const r = seededRandom(nameSeed(name, 'rare'));
    const share = planner === 'extras_vendor' ? RARE_SHARE_OF_RICH.vendor : planner === 'extras_social' ? RARE_SHARE_OF_RICH.social : RARE_SHARE_OF_RICH.levelling;
    if (r() >= share) return null;
    const w = wardrobeItems();
    const kind = r();
    if (kind < 0.25) return w.partyhats[Math.floor(r() * w.partyhats.length)];
    if (kind < 0.625) return w.santaHat;
    return w.masks[Math.floor(r() * w.masks.length)];
}

/**
 * The 2003 holiday item a veteran keeps, or null: about 1 in 4 (HOLIDAY_SHARE); a skiller's is the scythe half the time
 * (it wields it at a skill), everyone else's the bunny ears.
 */
export function holidayOf(name: string, tier: AgeTier, skiller: boolean): number | null {
    if (tier !== 'veteran') return null;
    const r = seededRandom(nameSeed(name, 'holiday'));
    if (r() >= HOLIDAY_SHARE) return null;
    const w = wardrobeItems();
    return skiller && r() < 0.5 ? w.scythe : w.bunnyEars;
}

/** A veteran at the top (combat 100-120): about 1 in 4 of them, never a skiller (its XP is in its skills). */
export function isTopVeteran(name: string, tier: AgeTier, planner: PlannerKey): boolean {
    if (tier !== 'veteran' || planner === 'skiller' || PKER_PLANNERS.has(planner)) return false;
    return seededRandom(nameSeed(name, 'top'))() < TOP_SHARE;
}
