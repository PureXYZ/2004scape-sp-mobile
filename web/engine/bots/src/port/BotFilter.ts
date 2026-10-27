// The game's word filter (WordEnc.filter) for every bot line, remembered. Bots repeat themselves (a vendor's advert
// every few ticks) and the filter is the costliest part of a bot's turn, so the filtered text of recent distinct lines
// is kept, the oldest going first. port: 4,096 (256 thrashed with 100 bots and more: the filter was 7 to 17 % of the
// bots' time, and a 4,096-line cache cut a sim's run by 63 %).
// port (perf, 2026-10-23): one memo for all the bots' filtering, not only BotSay's. The style check (BotStyle.sayable),
// the vendors' adverts, the threads, the cliques, the chat's checks and the model's guard each filtered the text again
// (a line is checked, then said): 35 % of the filter's calls at 500 bots were a text it had filtered before.
// WordEnc.filter is a function of the text alone: its tables are read once when the world starts and only read after.
import WordEnc from '#/cache/wordenc/WordEnc.js';

const MAX_REMEMBERED = 4096;
const filtered = new Map<string, string>();

/** WordEnc.filter(text), remembered (the last MAX_REMEMBERED distinct texts) */
export function botFilter(text: string): string {
    let line = filtered.get(text);
    if (line === undefined) {
        line = WordEnc.filter(text);
        if (filtered.size >= MAX_REMEMBERED) filtered.delete(filtered.keys().next().value!);
        filtered.set(text, line);
    }
    return line;
}
