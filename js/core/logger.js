/**
 * Structured logging subsystem
 * Levels: DEBUG, INFO, WARN, ERROR
 * Provides filterable log panel, copy/download, error bundles
 */

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LOG_LIMIT = 5000;

class Logger {
    constructor() {
        this.entries = [];
        this.listeners = new Set();
        this.minLevel = LOG_LEVELS.DEBUG;
        this.lastErrorBundle = null;
    }

    _emit(level, module, action, context = {}, duration = null) {
        const entry = {
            ts: new Date().toISOString(),
            level,
            module,
            action,
            context: typeof context === 'string' ? { message: context } : context,
            duration
        };
        this.entries.push(entry);
        if (this.entries.length > LOG_LIMIT) this.entries.shift();

        if (level === 'ERROR') {
            this.lastErrorBundle = { ...entry, stack: new Error().stack };
        }

        const numLevel = LOG_LEVELS[level] ?? 1;
        if (numLevel >= this.minLevel) {
            const style = level === 'ERROR' ? 'color:red' : level === 'WARN' ? 'color:orange' : level === 'DEBUG' ? 'color:gray' : 'color:blue';
            console.log(`%c[${level}] [${module}] ${action}`, style, context, duration != null ? `(${duration}ms)` : '');
        }

        for (const fn of this.listeners) {
            try { fn(entry); } catch (_) { /* ignore */ }
        }
    }

    debug(module, action, ctx) { this._emit('DEBUG', module, action, ctx); }
    info(module, action, ctx) { this._emit('INFO', module, action, ctx); }
    warn(module, action, ctx) { this._emit('WARN', module, action, ctx); }
    error(module, action, ctx, duration) { this._emit('ERROR', module, action, ctx, duration); }

    timed(module, action) {
        const start = performance.now();
        return {
            end: (ctx = {}) => {
                const dur = Math.round(performance.now() - start);
                this._emit('INFO', module, action, ctx, dur);
                return dur;
            },
            fail: (ctx = {}) => {
                const dur = Math.round(performance.now() - start);
                this._emit('ERROR', module, action, ctx, dur);
                return dur;
            }
        };
    }

    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    getEntries(filter = {}) {
        let result = this.entries;
        if (filter.level) result = result.filter(e => LOG_LEVELS[e.level] >= LOG_LEVELS[filter.level]);
        if (filter.module) result = result.filter(e => e.module.toLowerCase().includes(filter.module.toLowerCase()));
        if (filter.search) {
            const s = filter.search.toLowerCase();
            result = result.filter(e =>
                e.action.toLowerCase().includes(s) ||
                JSON.stringify(e.context).toLowerCase().includes(s)
            );
        }
        return result;
    }

    toText(filter) {
        return this.getEntries(filter).map(e =>
            `[${e.ts}] [${e.level}] [${e.module}] ${e.action} ${JSON.stringify(e.context)}${e.duration != null ? ` (${e.duration}ms)` : ''}`
        ).join('\n');
    }

    toJSON(filter) {
        return JSON.stringify(this.getEntries(filter), null, 2);
    }

    getErrorBundle() { return this.lastErrorBundle; }
    clear() { this.entries = []; this.lastErrorBundle = null; }
}

export const logger = new Logger();
export default logger;
