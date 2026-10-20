import IdkType from '#/cache/config/IdkType.js';
import InvType from '#/cache/config/InvType.js';
import { Items } from '#/engine/bot/BotKnowledge.js';
import Player from '#/engine/entity/Player.js';
import { check, IDKTypeValid, GenderValid } from '#/engine/script/ScriptValidators.js';
import { bodyDice, clanColourOf, genderOf } from '#/engine/bot/port/BotLooks.js';
import { nameIndex, nameSeed, seededRandom } from '#/engine/bot/port/BotSeed.js';
// (the variety work, round 2, track W2: a few newbies' amulet of accuracy)
import { newbieAccuracyOf, noveltyItems } from '#/engine/bot/port/BotFashion.js';

const MAN_HAIR_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const MAN_JAW_IDS = [10, 11, 12, 13, 14, 15, 16, 17];
const MAN_TORSO_IDS = [18, 19, 20, 21, 22, 23, 24, 25];
const MAN_ARMS_IDS = [26, 27, 28, 29, 30, 31];
const MAN_HANDS_IDS = [33, 34];
const MAN_LEGS_IDS = [36, 37, 38, 39, 40];
const MAN_FEET_IDS = [42, 43];
const WOMAN_HAIR_IDS = [45, 46, 47, 48, 49, 50, 51, 52, 53, 54];
const WOMAN_TORSO_IDS = [56, 57, 58, 59, 60];
const WOMAN_ARMS_IDS = [61, 62, 63, 64, 65];
const WOMAN_HANDS_IDS = [67, 68];
const WOMAN_FEET_IDS = [79, 80];
const WOMAN_LEGS_IDS = [70, 71, 72, 73, 74, 75, 76, 77];

const GENDERS = {
    MALE: 0,
    FEMALE: 1
};

const STARTER_WEAPONS = [Items.BRONZE_AXE, Items.BRONZE_PICKAXE, Items.BRONZE_SWORD, Items.BRONZE_SCIMITAR, Items.IRON_AXE, Items.IRON_SCIMITAR];

/** port (phase 4): a male newcomer keeps the design screen's head (bald, a goatee) this often; the rest chose theirs */
export const NEWCOMER_DEFAULT_HEAD = 1 / 3;

/**
 * port (the variety work, round 2, track W2: WEAR-9, "fewer bald women"; new bodies only): a woman whose name's dice gave
 * the design screen's bald head keeps it this often; the rest get another of the hair kits, from a seed of their own
 * ('woman-hair': no other draw of the body changes). 10-14 % of the women were bald (one hair kit in ten)
 */
export const WOMAN_BALD_KEPT = 0.25;

/**
 * port (round 2, W2: WEAR-10, the optional "matching clans"; new bodies only) of a levelling clique's members, this many
 * wear the clan's colour in their torso (6 in 10) or legs, from a seed of their own ('clan-clothes')
 */
export const CLAN_CLOTHES_SHARE = 0.3;
/** a clan colour (port/BotLooks wardrobeItems().capes: red, black, blue, yellow, green, purple, orange) as a torso colour (ClientPlayer's: legs one on) */
const CLAN_TORSO_COLOUR: readonly number[] = [6, 1, 7, 9, 8, 10, 11];

/**
 * port (the realism work, phase 4: "2004 bodies"): the colours a design may have, per colour slot (hair, torso, legs,
 * feet, skin): the server's own check of a design (Player.DESIGN_BODY_COLORS, IdkSaveDesignHandler), the client's
 * palette (ClientPlayer.recol1d): 12, 16, 16, 6 and 8. Upstream drew torso, legs and feet from 0-11 and skin from 0-5:
 * four torso and four leg colours and two skins never showed, and feet 6-11 (half of them) fell back to brown.
 */
export function paletteSizes(): number[] {
    return Player.DESIGN_BODY_COLORS.map(colours => colours.length);
}

/**
 * port (phase 4): the design screen's defaults for a gender (webclient Client.validateIdkDesign): the first kit of each
 * of the seven parts that is not disabled (a woman has no jaw: -1); every colour 0. What a newbie who clicked through
 * the design screen wore: a man bald with a goatee in khaki, a woman in the same plain clothes.
 */
export function designDefaults(gender: number): number[] {
    const out: number[] = [];
    for (let part = 0; part < 7; part++) {
        const type = part + (gender === GENDERS.FEMALE ? 7 : 0);
        let found = -1;
        for (let id = 0; id < IdkType.count; id++) {
            const idk = IdkType.get(id);
            if (idk && !idk.disable && idk.type === type) {
                found = id;
                break;
            }
        }
        out.push(found);
    }
    return out;
}

function pick<T>(arr: T[], rand: () => number): T {
    return arr[Math.floor(rand() * arr.length)];
}

function pickIdkit(ids: number[], type: number, rand: () => number): number {
    const valid = ids.filter(id => {
        const idk = IdkType.get(id);
        return idk && !idk.disable && idk.type === type;
    });

    if (valid.length === 0) {
        throw new Error(`No valid idkits for type ${type}`);
    }

    return pick(valid, rand);
}

function item(id: number, player:Player) {
    return { id, count: 1, owner: player?.username };
}

/** port (phase 4): a new bot's starter weapon, from its name (upstream's list; Math.random before) */
export function starterWeaponOf(name: string): number {
    return STARTER_WEAPONS[nameIndex(name, 'starter-weapon', STARTER_WEAPONS.length)];
}

export class BotAppearance {

     static set_gender(player:Player, gender1:number) {
        const gender = check(gender1, GenderValid);
        if(!player) return;
        for (let i = 0; i < 7; i++) {
            if (gender === 1) {
                player.body[i] = Player.MALE_FEMALE_MAP.get(player.body[i]) ?? -1;
            } else {
                if (i == 1) {
                    player.body[i] = 14;
                    continue;
                }
                player.body[i] = Player.FEMALE_MALE_MAP.get(player.body[i]) ?? -1;
            }
        }
        player.gender = gender;
    }

    static set_appearance(player:Player, idkit:number, color:number) {
        const idkType: IdkType = check(idkit, IDKTypeValid);
        let slot = idkType.type;
        if (player.gender === 1) {
            slot -= 7;
        }
        player.body[slot] = idkType.id;
        // 0 - hair/jaw
        // 1 - torso
        // 2 - legs
        // 3 - boots
        // 4 - skin
        let type = idkType.type;
        if (player.gender === 1) {
            type -= 7;
        }
        let colorSlot = -1;
        if (type === 0 || type === 1) {
            colorSlot = 0;
        } else if (type === 2 || type === 3) {
            colorSlot = 1;
        } else if (type === 4) {
            /* no-op (no hand recoloring) */
        } else if (type === 5) {
            colorSlot = 2;
        } else if (type === 6) {
            colorSlot = 3;
        }
        if (colorSlot !== -1) {
            player.colors[colorSlot] = color;
        }
    }

    /**
     * port (the realism work, phase 4: "2004 bodies"): the body from the bot's name (port/BotLooks): its gender (matched
     * to the name, else mostly male: upstream drew 51/49 at random), every kit and colour over the client's whole
     * palette; a newcomer (`newcomer`: a brand-new account off Tutorial Island) in the design screen's clothes, its head
     * its own (a man's the screen's a third of the time: NEWCOMER_DEFAULT_HEAD). The same name gives the same body (a
     * bot that leaves before its first save comes back the same).
     */
    static randomizeBody(player: Player, newcomer = false): void {
        const gender = genderOf(player.username);
        player.gender = gender;
        player.body.fill(-1);

        const rand = bodyDice(player.username);
        const [hairs, torsos, legs, feet, skins] = paletteSizes();

        if (newcomer) {
            const kits = designDefaults(gender);
            for (let part = 0; part < 7; part++) player.body[part] = kits[part];
            player.colors.fill(0);
            // port (the integration of phase 4): the clothes are the screen's, the head is the player's: its hair (a
            // man's beard), their colour and the skin from the name, but a man kept the screen's bald head and goatee
            // NEWCOMER_DEFAULT_HEAD of the time (a woman's default is bald too: who chose a woman chose her hair). All
            // newcomers in one head made the alts about Lumbridge (two in three newcomers) a row of clones
            if (gender === GENDERS.FEMALE || rand() >= NEWCOMER_DEFAULT_HEAD) {
                const hairColour = Math.floor(rand() * hairs);
                if (gender === GENDERS.MALE) {
                    BotAppearance.set_appearance(player, pickIdkit(MAN_HAIR_IDS, 0, rand), hairColour);
                    BotAppearance.set_appearance(player, pickIdkit(MAN_JAW_IDS, 1, rand), hairColour);
                } else {
                    BotAppearance.set_appearance(player, pickIdkit(WOMAN_HAIR_IDS.filter(id => id !== kits[0]), 7, rand), hairColour);
                }
                player.colors[4] = Math.floor(rand() * skins);
            }
            player.buildAppearance(InvType.WORN);
            return;
        }

        const hairColour = Math.floor(rand() * hairs);
        let torsoColour = Math.floor(rand() * torsos);
        let legColour = Math.floor(rand() * legs);
        const feetColour = Math.floor(rand() * feet);
        // port (the variety work, round 2, track W2: WEAR-10) a clique member in its clan's colour, 3 in 10
        const clan = clanColourOf(player.username);
        if (clan !== null) {
            const r = seededRandom(nameSeed(player.username, 'clan-clothes'));
            if (r() < CLAN_CLOTHES_SHARE) {
                const colour = CLAN_TORSO_COLOUR[clan % CLAN_TORSO_COLOUR.length];
                if (r() < 0.6) torsoColour = colour % torsos;
                else legColour = (colour + 1) % legs;
            }
        }

        if (gender === GENDERS.MALE) {
            BotAppearance.set_appearance(player, pickIdkit(MAN_HAIR_IDS, 0, rand), hairColour);
            BotAppearance.set_appearance(player, pickIdkit(MAN_JAW_IDS, 1, rand), hairColour);
            BotAppearance.set_appearance(player, pickIdkit(MAN_TORSO_IDS, 2, rand), torsoColour);
            BotAppearance.set_appearance(player, pickIdkit(MAN_ARMS_IDS, 3, rand), torsoColour);
            BotAppearance.set_appearance(player, pickIdkit(MAN_HANDS_IDS, 4, rand), torsoColour);
            BotAppearance.set_appearance(player, pickIdkit(MAN_LEGS_IDS, 5, rand), legColour);
            BotAppearance.set_appearance(player, pickIdkit(MAN_FEET_IDS, 6, rand), feetColour);
        } else {
            let hair = pickIdkit(WOMAN_HAIR_IDS, 7, rand);
            // port (round 2, W2: WEAR-9) fewer bald women: the design screen's bald head kept WOMAN_BALD_KEPT of the time
            const bald = designDefaults(GENDERS.FEMALE)[0];
            if (hair === bald) {
                const r = seededRandom(nameSeed(player.username, 'woman-hair'));
                if (r() >= WOMAN_BALD_KEPT) hair = pickIdkit(WOMAN_HAIR_IDS.filter(id => id !== bald), 7, r);
            }
            BotAppearance.set_appearance(player, hair, hairColour);
            player.body[1] = -1;
            rand(); // (the jaw's draw: a woman has none; the same number of draws either way)
            BotAppearance.set_appearance(player, pickIdkit(WOMAN_TORSO_IDS, 9, rand), torsoColour);
            BotAppearance.set_appearance(player, pickIdkit(WOMAN_ARMS_IDS, 10, rand), torsoColour);
            BotAppearance.set_appearance(player, pickIdkit(WOMAN_HANDS_IDS, 11, rand), torsoColour);
            BotAppearance.set_appearance(player, pickIdkit(WOMAN_LEGS_IDS, 12, rand), legColour);
            BotAppearance.set_appearance(player, pickIdkit(WOMAN_FEET_IDS, 13, rand), feetColour);
        }

        player.colors[4] = Math.floor(rand() * skins);
        player.buildAppearance(InvType.WORN);
    }

    /**
     * A bot with no save: its body and a starter weapon (port, phase 4: both from its name). port (phase 4): a newcomer
     * (`options.newcomer`) wears nothing: the tutorial's kit comes with its InitTask and it wields the bronze sword and
     * wooden shield first (tasks/NewbieTask), as the tutorial taught.
     */
    static randomize(player: Player, options: { newcomer?: boolean } = {}): void {

        const worn = player.getInventory(InvType.WORN);
        if (!worn) throw new Error('WORN inventory missing');
        const inv = player.getInventory(InvType.INV);
        if (!inv) throw new Error('Invalid inv');

        BotAppearance.randomizeBody(player, options.newcomer === true);

        if (options.newcomer !== true) worn.set(3, item(starterWeaponOf(player.username), player)); // weapon
        // port (the variety work, round 2, track W2: WEAR-9) a few newbies wear Imp Catcher's amulet of accuracy
        else if (newbieAccuracyOf(player.username) && noveltyItems().accuracy !== -1) worn.set(2, item(noveltyItems().accuracy, player));
        //^ I believe the login script already does this ^

        // Set movement animations so the run-toggle in walkTo works.
        // Without a valid runanim the engine hard-forces MoveSpeed.WALK
        // regardless of player.run, so bots can never run.
        player.readyanim  = 808; // human_ready
        player.walkanim   = 819; // human_walk_f
        player.walkanim_b = 820; // human_walk_b
        player.walkanim_l = 821; // human_walk_l
        player.walkanim_r = 822; // human_walk_r
        player.runanim    = 824; // human_running

        player.buildAppearance(InvType.WORN);
    }
}
