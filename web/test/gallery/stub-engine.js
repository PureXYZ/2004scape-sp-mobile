// Gallery stand-in for engine/boot.js: a world that is ready at once and never talks (the stub client never connects).
self.onmessage = event => {
    const msg = event.data;
    if (msg?.type === 'init') {
        self.postMessage({ type: 'booted', preloadMs: 0, evalMs: 0, files: 0, bytes: 0 });
    } else if (msg?.type === 'start') {
        self.postMessage({ type: 'ready', ms: 0 });
    } else if (msg?.type === 'lifecycle') {
        self.postMessage({ type: 'lifecycle-done', reqId: msg.reqId, ok: true });
    }
};
