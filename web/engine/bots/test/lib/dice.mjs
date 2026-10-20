// Dice of a staged scenario's own, for the tests that stage one scenario after another in one world (party, scams,
// random events, the Duel Arena, social life, groups).
//
// (the variety work, round 1, its second fixer) Each such test seeds Math.random once, and the world's bots draw from
// it every tick: a behaviour change anywhere (an extra draw in a planner, a bot that walks a tick longer) moved every
// later scenario's draws, and checks that held at a seed failed after round 1's merge for no change of their own (a
// Party Room host that a fight left hurt, a scam caller walked off, a held random event's winner). `scene(name)` at a
// scenario's start re-seeds Math.random from the test's seed and the scenario's name, so its draws are its own: the
// same seed gives the same run (deterministic), and what came before moves only the world's state, not its dice.
// Tests only: the game never re-seeds.

/** a small fast PRNG (mulberry32), as the tests' own */
export function mulberry(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** the seed of a scenario: the test's seed and the scenario's name (FNV-1a) */
export function sceneSeed(seed, name) {
    let h = 0x811c9dc5 ^ (seed >>> 0);
    for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
    return h >>> 0;
}

/** Math.random from here on: the scenario's own dice */
export function scene(seed, name) {
    Math.random = mulberry(sceneSeed(seed, name));
}
