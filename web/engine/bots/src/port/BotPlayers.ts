// port (perf, 2026-10-23): the world's players as an array for the rest of BotManager.tick. The bots scan every player
// many times a tick (who attacks this PKer, who stands on its tile, who hears a line, who saw a death, ...), each time
// through World.playerLoop.all(), a generator over the hash table's buckets: at 1000 bots these scans were 5.7 % of the
// world tick in JavaScriptCore (3.3 % in V8), and their number grows with the bots, so their cost with its square. No
// player joins or leaves World.playerLoop while BotManager.tick runs: World.processLogins adds them, World.removePlayer
// (from processLogouts, a shutdown or a failed cycle) is the only thing that unlinks one, and the bots only queue their
// logins in World.newPlayers. So the array taken when the tick starts is exactly the sequence every playerLoop.all() of
// the tick would give, in the same order. Outside the tick (the chat hooks, the glue) worldPlayers() is the generator.
// test/exact.test.mjs compares every use with a fresh pass of the generator.
import World from '#/engine/World.js';
import type Player from '#/engine/entity/Player.js';

let snapshot: Player[] | null = null;
let check: ((players: readonly Player[]) => void) | null = null;

/** BotManager.tick, first: the players in World.playerLoop's order */
export function beginPlayersTick(): void {
    const players: Player[] = [];
    for (const p of World.playerLoop.all()) players.push(p);
    snapshot = players;
}

/** BotManager.tick, last (also when it fails) */
export function endPlayersTick(): void {
    snapshot = null;
}

/** World.playerLoop.all(): the tick's array inside BotManager.tick, the generator outside it */
export function worldPlayers(): Iterable<Player> {
    if (snapshot === null) return World.playerLoop.all();
    if (check !== null) check(snapshot);
    return snapshot;
}

/** (tests) every use of the tick's array is handed to `check` first (to compare it with the generator); null: none */
export function setPlayersCheckForTest(fn: ((players: readonly Player[]) => void) | null): void {
    check = fn;
}
