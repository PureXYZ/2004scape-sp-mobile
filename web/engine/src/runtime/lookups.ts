// Two lookups of the tick that V8 takes on a slow path (installed by runtime/tick.ts on HuntType and ScriptRunner; no
// engine imports here, so test/tick.test.mjs can install them on stand-ins and on the pinned sources' shapes).

/**
 * HuntType.get(-1) without the lookup. consumeHuntTarget (Npc.ts:963) asks for every npc every tick, also the 4 520
 * without a hunt mode (-1). configs[-1] is a read outside the array, which V8 answers with a generic lookup (3.2 % of a
 * tick). configs only ever holds indices 0..count-1 (HuntType.parse), so a negative id is undefined either way.
 * (ScriptValidators keeps the original get.)
 */
export function installHuntGet<T>(Hunt: { configs: T[]; get(id: number): T }): void {
    Hunt.get = function (id: number): T {
        return (id < 0 ? undefined : Hunt.configs[id]) as T;
    };
}

/**
 * ScriptRunner.HANDLERS as a packed array. An object spread from the 16 handler tables: 401 handlers at opcodes
 * 0..10 003, which V8 keeps in dictionary mode - a hash lookup for every script instruction (93 000 a tick with 500
 * bots). The same opcode -> handler entries in an array, undefined where there is none (as before; the bots glue adds
 * its two commands to it afterwards). Left as it is if a key is anything but an opcode.
 */
export function packHandlers(Runner: { HANDLERS: object }): void {
    const table = Runner.HANDLERS as Record<string, unknown>;
    const keys = Object.keys(table);
    const isOpcode = (key: string) => String(Number(key)) === key && Number.isInteger(Number(key)) && Number(key) >= 0 && Number(key) < 0x10000;
    if (keys.length && keys.every(isOpcode) && !Object.getOwnPropertySymbols(table).length) {
        const handlers: unknown[] = [];
        const last = Math.max(...keys.map(Number));
        for (let op = 0; op <= last; op++) handlers.push(Object.hasOwn(table, op) ? table[op] : undefined); // pushed: packed elements
        Runner.HANDLERS = handlers;
    }
}
