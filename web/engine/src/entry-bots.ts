// Engine worker entry WITH the bots, bundled by build.mjs into engine/engine-bots.js (docs/BOTS.md §2). boot.js imports
// it instead of engine.js when init.config.bots.count > 0: the same entry (page protocol, saves, ticker) and engine,
// plus the bot library ('#/engine/bot/*', web/engine/bots/src) and the glue in runtime/bots, which hooks into the
// engine at run time. Order matters: the entry - and with it the World - is evaluated first, then the glue.
//
// attach() is the entry's, plus what the page hears of the bots (runtime/bots/page.ts, docs/BOTS.md §4.1): a message
// when they are switched off for the session, whether they were saved in lifecycle-done, and their store written on
// resume; the language model's requests and answers (the realism work, phase 7), which the entry never sees. It takes
// the place of the entry's own attach in this bundle's exports (a local export wins over export *).
import { attach as attachEntry } from './entry.js';
import { attachPage, onEngineMessage, onPageMessage } from './runtime/bots/page.js';
import type { Post } from './runtime/host.js';

export * from './entry.js';
export { botsTest as __bots } from './runtime/bots/index.js';

export function attach(host: { post: Post }): ReturnType<typeof attachEntry> {
    const handle = attachEntry({ post: (msg, transfer) => host.post(onEngineMessage(msg), transfer) });
    attachPage(host.post);
    return msg => {
        // (the bots' own messages, the language model's of phase 7, are not the entry's)
        if (!onPageMessage(msg)) handle(msg);
    };
}
