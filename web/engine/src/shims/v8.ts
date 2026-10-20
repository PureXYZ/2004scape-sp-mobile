// node:v8 - only ClientCheatHandler.ts:545 (`::snapshot` dev cheat) uses writeHeapSnapshot.
export function writeHeapSnapshot(): string {
    return 'heap snapshots are not available in the browser engine runtime';
}
export function getHeapStatistics() {
    return {};
}
export default { writeHeapSnapshot, getHeapStatistics };
