// engine/engine.js's entry in a test build (scripts/build-web.mjs --autotest; build.mjs bundles it in place of
// src/entry.ts): the entry as it is, plus the measurements of autotest/perf.ts and their message, {type:'lctest-perf'}.
// It takes the place of the entry's attach in this bundle's exports (a local export wins over export *).
import { attach as attachEntry } from '../entry.js';
import type { Post } from '../runtime/host.js';

import { answerPerf, watchPost } from './perf.js';

export * from '../entry.js';

export function attach(host: { post: Post }): ReturnType<typeof attachEntry> {
    const post = watchPost(host.post);
    const handle = attachEntry({ post });
    return msg => {
        if (msg?.type === 'lctest-perf') answerPerf(post, msg);
        else handle(msg);
    };
}
