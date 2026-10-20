// Script commands the bots' content overlay (web/engine/bots/content) uses. Upstream appended them to the engine's
// ScriptOpcode enum; here they get explicit numbers past the engine's last block (CONSOLE = 10000 … TIMESPENT), so no
// stock opcode moves. The overlay compiler registers these numbers at compile time and the bots glue registers the
// handlers in ScriptRunner.HANDLERS at run time; both assert the numbers are free. This module has no imports, so
// build tools can load it directly.
export const P_ISBOT = 10100;
export const P_BOT_INTERACT_TRADE = 10101;
