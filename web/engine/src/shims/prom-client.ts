// No-op prom-client. server/Metrics.ts constructs metrics at import time; World.ts only calls
// .set/.observe/.inc when Environment.node.production (World.ts:477-493), except
// trackSessionEventsPublished.inc() which is unconditional (World.ts:2272).
class Metric {
    constructor(_cfg?: unknown) {}
    inc() {}
    dec() {}
    set() {}
    observe() {}
    reset() {}
    labels() {
        return this;
    }
    startTimer() {
        return () => 0;
    }
    get() {
        return Promise.resolve({ values: [] });
    }
}
export class Counter extends Metric {}
export class Gauge extends Metric {}
export class Histogram extends Metric {}
export class Summary extends Metric {}
export class Registry {
    contentType = 'text/plain';
    setDefaultLabels() {}
    metrics() {
        return Promise.resolve('');
    }
    registerMetric() {}
    clear() {}
}
export const register = new Registry();
export function collectDefaultMetrics() {}
export default { Counter, Gauge, Histogram, Summary, Registry, register, collectDefaultMetrics };
