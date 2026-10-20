// The bot fields on Player (docs/BOTS.md §4.2), declared without touching Player.ts and assigned only on bots.
import '#/engine/entity/Player.js';

declare module '#/engine/entity/Player.js' {
    export default interface Player {
        is_bot?: boolean;
        botPlanner?: string;
        botTradeTargetPid?: number;
        botTradeTargetStage?: number;
    }
}
