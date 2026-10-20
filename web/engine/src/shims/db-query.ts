// Replacement for engine/src/db/query.ts. The real module runs `new DatabaseSync('db.sqlite')`
// (node:sqlite) or a mysql2 pool AT IMPORT TIME (query.ts:12-28), and it is imported by
// World.ts:71 -> server/friend/FriendServer.ts:3 (+ FriendServerRepository.ts:1) just for the
// FriendsServerOpcodes const enum. The db is only *used* by FriendServer/LoggerServer/LoginServer,
// which never run inside the game world.
export const db = new Proxy(
    {},
    {
        get(_t, prop) {
            if (prop === 'then') return undefined;
            throw new Error(`database access (db.${String(prop)}) is not available in the offline engine runtime`);
        }
    }
) as never;

export function toDbDate(date: Date | string | number) {
    if (typeof date === 'string' || typeof date === 'number') {
        date = new Date(date);
    }
    return date.toISOString().slice(0, 19).replace('T', ' ');
}
