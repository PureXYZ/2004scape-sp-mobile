// port: the places of 2004 by name, for what a bot says about where it is (Phase 3: livelier chat,
// answers from the bot's own state: "Fishing lobbies on Karamja", "In Varrock atm"). A place is a point and a reach: a
// bot within the reach is "in Varrock", within twice the reach "near Varrock"; where two reaches overlap, the one the
// bot is deepest in (its distance over the reach) names it. The Wilderness and the dungeons have their own words.
import { wildernessLevelAt } from '#/engine/bot/port/BotContent.js';

interface Place {
    name: string;
    x: number;
    z: number;
    /** its reach, in tiles (Chebyshev) */
    r: number;
    /** 'in' unless said otherwise ("on Karamja", "at the Fishing Guild") */
    prep?: 'in' | 'on' | 'at';
}

const PLACES: readonly Place[] = [
    // free
    { name: 'Lumbridge', x: 3222, z: 3218, r: 30 },
    { name: 'Lumbridge Swamp', x: 3200, z: 3170, r: 20 },
    { name: 'Draynor', x: 3093, z: 3250, r: 30 },
    { name: 'Draynor Manor', x: 3109, z: 3350, r: 15, prep: 'at' },
    { name: 'Varrock', x: 3213, z: 3428, r: 45 },
    { name: 'Barbarian Village', x: 3082, z: 3420, r: 18 },
    { name: 'Edgeville', x: 3093, z: 3493, r: 22 },
    { name: 'the Monastery', x: 3052, z: 3490, r: 12, prep: 'at' },
    { name: 'Ice Mountain', x: 3007, z: 3478, r: 15, prep: 'on' },
    { name: 'Goblin Village', x: 2956, z: 3505, r: 15 },
    { name: 'Falador', x: 2985, z: 3365, r: 50 },
    { name: 'Port Sarim', x: 3030, z: 3220, r: 22 },
    { name: 'Rimmington', x: 2957, z: 3215, r: 22 },
    { name: 'the Crafting Guild', x: 2933, z: 3285, r: 12, prep: 'at' },
    { name: 'Al Kharid', x: 3293, z: 3190, r: 35 },
    { name: 'the Al Kharid mine', x: 3299, z: 3300, r: 15, prep: 'at' },
    { name: "the Champions' Guild", x: 3191, z: 3362, r: 8, prep: 'at' },
    { name: 'Karamja', x: 2900, z: 3160, r: 60, prep: 'on' },
    // members
    { name: 'Brimhaven', x: 2772, z: 3200, r: 30 },
    { name: 'Shilo Village', x: 2850, z: 2960, r: 25 },
    { name: 'Entrana', x: 2834, z: 3335, r: 30, prep: 'on' },
    { name: 'Taverley', x: 2900, z: 3440, r: 22 },
    { name: 'Burthorpe', x: 2900, z: 3550, r: 20 },
    { name: 'White Wolf Mountain', x: 2848, z: 3480, r: 18, prep: 'on' },
    { name: 'Catherby', x: 2809, z: 3436, r: 25 },
    { name: 'Camelot', x: 2757, z: 3500, r: 15 },
    // ("Seers' Village" the word filter masks: it reads across the apostrophe; players said "Seers")
    { name: 'Seers', x: 2720, z: 3480, r: 25 },
    { name: 'the Fishing Guild', x: 2603, z: 3415, r: 12, prep: 'at' },
    { name: 'Ardougne', x: 2662, z: 3305, r: 45 },
    { name: 'Witchaven', x: 2720, z: 3285, r: 15 },
    { name: 'Port Khazard', x: 2660, z: 3160, r: 18 },
    { name: 'Yanille', x: 2560, z: 3090, r: 25 },
    { name: 'Tree Gnome Village', x: 2525, z: 3170, r: 25 },
    { name: 'the Gnome Stronghold', x: 2460, z: 3430, r: 60, prep: 'at' },
    { name: 'the Barbarian Outpost', x: 2540, z: 3570, r: 20, prep: 'at' }
];

/** the Dwarven Mine, under Falador and Ice Mountain */
function inDwarvenMine(x: number, z: number): boolean {
    return x >= 2990 && x < 3070 && z >= 9750 && z < 9860;
}

/**
 * Where (x, z) is, as a player says it: "in Varrock", "near Draynor", "on Karamja", "at the Fishing Guild", "in the
 * wild", "in the Dwarven Mine", "in a dungeon"; null out in the open, far from any place. Upstairs counts as the
 * ground below it.
 */
export function placePhrase(x: number, z: number): string | null {
    if (z >= 6400) return inDwarvenMine(x, z) ? 'in the Dwarven Mine' : 'in a dungeon';
    if (wildernessLevelAt(x, z) > 0) return 'in the wild';
    let inside: Place | null = null;
    let insideDepth = Infinity;
    let near: Place | null = null;
    let nearDepth = Infinity;
    for (const p of PLACES) {
        const depth = Math.max(Math.abs(x - p.x), Math.abs(z - p.z)) / p.r;
        if (depth <= 1 && depth < insideDepth) {
            inside = p;
            insideDepth = depth;
        } else if (depth <= 2 && depth < nearDepth) {
            near = p;
            nearDepth = depth;
        }
    }
    if (inside) return `${inside.prep ?? 'in'} ${inside.name}`;
    return near ? `near ${near.name}` : null;
}

/** Every phrase placePhrase can give (for the word filter's test). */
export function allPlacePhrases(): string[] {
    return [...PLACES.flatMap(p => [`${p.prep ?? 'in'} ${p.name}`, `near ${p.name}`]), 'in the wild', 'in the Dwarven Mine', 'in a dungeon'];
}
