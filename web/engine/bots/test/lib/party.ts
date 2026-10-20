// test/party.test.mjs's and test/scams.test.mjs's world (the realism work, phase 5b, Track P: parties, scams and lures):
// test/lib/simworld.ts with the trade helpers (a human's trade request through the engine's own handler), the set pieces'
// registry, the party, scam and lure modules, and a stand-in for Track D's director (its SetPieceContext: a census of bots,
// freeBots, sessionLeft, the dice), so the pieces are planned, started and ticked as the director would.
export * from './trade.js';
import World from '#/engine/World.js';
import type Player from '#/engine/entity/Player.js';
import { BotManager } from '#/engine/bot/BotManager.js';
import * as SetPieces from '#/engine/bot/port/BotSetPieces.js';
import type { SetPieceContext, SetPieceDef, SetPiecePlan, SetPieceRun } from '#/engine/bot/port/BotSetPieces.js';
import { isNewbie } from '#/engine/bot/port/BotNewbie.js';
import { stallOf } from '#/engine/bot/port/BotTradeSpots.js';
export * as SetPieces from '#/engine/bot/port/BotSetPieces.js';
export * as Party from '#/engine/bot/port/BotParty.js';
export * as Scams from '#/engine/bot/port/BotScams.js';
export * as PieceLines from '#/engine/bot/port/BotPieceLines.js';
export * as Habits from '#/engine/bot/port/BotHabits.js';
export { PartyHostTask } from '#/engine/bot/tasks/PartyHostTask.js';
export { PartyGuestTask } from '#/engine/bot/tasks/PartyGuestTask.js';
// (variety round 2, Track D2: the parties' scenes staged with the round's errands off; loaded on demand, so an older
// library (an A/B run, LC_BOTS_SRC) loads and goes on without)
export async function setD2Offers(on: boolean): Promise<boolean> {
    const d2 = await import('#/engine/bot/port/BotD2Picks.js').catch(() => null);
    d2?.setD2OffersForTest(on);
    return d2 !== null;
}
export { approachLog, lureLog, raidAtTheEdge, pkersAtTheEdge, planFakeDp, startFakeDp, FakeDpRun, SocialTask, HUBS, SOCIAL_LINES, setSocialRatesForTest } from '#/engine/bot/tasks/SocialTask.js';
export { default as LocType } from '#/cache/config/LocType.js';
export { default as NpcType } from '#/cache/config/NpcType.js';
export { default as Obj } from '#/engine/entity/Obj.js';
export { findLocByName, findLocByPrefix, findNpcByName, interactObjOp, interactPlayerOp, walkTo } from '#/engine/bot/BotAction.js';
export { bankInvId } from '#/engine/bot/tasks/BotTaskBase.js';
export { standTileOf } from '#/engine/bot/port/BotTiles.js';
export { botPersona } from '#/engine/bot/port/BotTiming.js';
export { NEW_LINES, EVENT_WINDOW, resetLineRegistry } from '#/engine/bot/port/BotLines.js';
export { botSay } from '#/engine/bot/port/BotSay.js';
export { cliqueOf, setCliqueBehaviourForTest } from '#/engine/bot/port/BotCliques.js';
export { isMembersWorld } from '#/engine/bot/port/BotWorldRules.js';
export { itemValue } from '#/engine/bot/port/BotPrices.js';
// (a set piece's part keeps random events off a bot: port/BotRandomEvents' eligibility)
export { eligible as randomEventEligible } from '#/engine/bot/port/BotRandomEvents.js';

/** a bot free for a set piece (as the director's freeBots: online, no sub-task, no part in a piece, not a newbie or a vendor at its stall) */
function free(p: Player): boolean {
    const ai = BotManager.botFor(p);
    if (!ai || p.slot === -1 || !BotManager.isActiveBot(p.username) || ai.hasSubTask() || SetPieces.eventRoleOf(p) !== null) return false;
    if (isNewbie(p) || stallOf(p) !== null) return false;
    return p.botTradeTargetPid === -1 && p.botComeHereReturnX === -1;
}

/** The stand-in director's context: bots only, never the human; `dice` the bots' Math.random unless given. */
export function standInContext(members: boolean, dice: () => number = Math.random): SetPieceContext {
    const bots = [...BotManager.activeBots()];
    const census = new Map<string, readonly Player[]>([['all', bots]]);
    return {
        now: World.currentTick,
        play: BotManager.stats().playTicks,
        members,
        online: bots.length,
        census,
        freeBots(x, z, level, radius, ok, max) {
            const out = bots.filter(p => p.level === level && Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) <= radius && free(p) && (!ok || ok(p)));
            out.sort((a, b) => Math.max(Math.abs(a.x - x), Math.abs(a.z - z)) - Math.max(Math.abs(b.x - x), Math.abs(b.z - z)));
            return max === undefined ? out : out.slice(0, max);
        },
        sessionLeft: p => BotManager.sessionLeftOf(p.username),
        dice
    };
}

/** The stand-in director: start a planned piece now (runStarted, the log entry); null when it did not start. */
export function startPiece(def: SetPieceDef, plan: SetPiecePlan, ctx: SetPieceContext): SetPieceRun | null {
    const run = def.start(plan, ctx);
    if (!run) return null;
    SetPieces.runStarted(run);
    SetPieces.logSetPiece({ id: run.id, kind: run.kind, venue: run.venue.key, x: run.venue.x, z: run.venue.z, level: run.venue.level, start: World.currentTick, end: -1, outcome: 'running', roles: run.roles.size });
    return run;
}

/** The stand-in director's tick for a run (every 5 ticks): its course, and its end once it is done. */
export function tickPiece(run: SetPieceRun): boolean {
    if (World.currentTick % 5 === 0) run.tick(World.currentTick);
    if (run.phase !== 'done') return true;
    SetPieces.runEnded(run);
    const entry = SetPieces.setPieceLog.find(e => e.id === run.id);
    if (entry && entry.end < 0) {
        entry.end = World.currentTick;
        entry.outcome = 'done';
    }
    return false;
}

/** A registered piece by kind. */
export function pieceDef(kind: string): SetPieceDef | undefined {
    return SetPieces.registeredSetPieces().find(d => d.kind === kind);
}

/** The objects on the ground within r of (x, z) (every one, private or not): debugname, count, receiver's username. */
export function objsNear(x: number, z: number, level: number, r: number): { obj: import('#/engine/entity/Obj.js').default; type: number }[] {
    const out: { obj: import('#/engine/entity/Obj.js').default; type: number }[] = [];
    for (let zx = (x - r) >> 3; zx <= (x + r) >> 3; zx++) {
        for (let zz = (z - r) >> 3; zz <= (z + r) >> 3; zz++) {
            for (const obj of World.gameMap.getZone(zx << 3, zz << 3, level).getAllObjsSafe()) {
                if (Math.max(Math.abs(obj.x - x), Math.abs(obj.z - z)) <= r) out.push({ obj, type: obj.type });
            }
        }
    }
    return out;
}

/** The shared Party Room chest's filled slots. */
export function chestItems(): { id: number; count: number }[] {
    const inv = World.getInventory(InvTypeId('partyroom_dropinv'));
    const out: { id: number; count: number }[] = [];
    for (let s = 0; inv && s < inv.capacity; s++) {
        const it = inv.get(s);
        if (it) out.push({ id: it.id, count: it.count });
    }
    return out;
}

import InvTypeConfig from '#/cache/config/InvType.js';
function InvTypeId(name: string): number {
    return InvTypeConfig.getId(name);
}
