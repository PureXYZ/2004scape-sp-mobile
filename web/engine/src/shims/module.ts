// `module` stub (bzip2-wasm.js:27 / bzip2.mjs:60 import it only when `process` exists - never in a browser).
export function createRequire() {
    return (id: string) => {
        throw new Error(`require('${id}') is not available in the browser engine runtime`);
    };
}
export default { createRequire };
