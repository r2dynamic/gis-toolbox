/**
 * Simple event bus for decoupled inter-module communication
 */
class EventBus {
    constructor() {
        this.handlers = {};
    }

    on(event, fn) {
        (this.handlers[event] ??= []).push(fn);
        return () => this.off(event, fn);
    }

    off(event, fn) {
        const h = this.handlers[event];
        if (h) this.handlers[event] = h.filter(f => f !== fn);
    }

    emit(event, data) {
        for (const fn of (this.handlers[event] ?? [])) {
            try { fn(data); } catch (e) { console.error(`EventBus error in ${event}:`, e); }
        }
    }

    once(event, fn) {
        const wrapper = (data) => { this.off(event, wrapper); fn(data); };
        this.on(event, wrapper);
    }
}

export const bus = new EventBus();
export default bus;
