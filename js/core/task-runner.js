/**
 * Task Runner — unified abstraction for long-running tasks
 * Provides: progress reporting, cancellation, logging, error classification
 */
import logger from './logger.js';
import { handleError, ErrorCategory } from './error-handler.js';
import bus from './event-bus.js';

let taskCounter = 0;

export class TaskRunner {
    constructor(name, module) {
        this.id = ++taskCounter;
        this.name = name;
        this.module = module;
        this.abortController = new AbortController();
        this.progress = { percent: 0, step: '', total: 0, current: 0 };
        this.state = 'idle'; // idle, running, completed, failed, cancelled
        this._onProgress = null;
    }

    get signal() { return this.abortController.signal; }
    get cancelled() { return this.abortController.signal.aborted; }

    cancel() {
        this.abortController.abort();
        this.state = 'cancelled';
        logger.info(this.module, `${this.name} cancelled`);
        bus.emit('task:cancelled', { id: this.id, name: this.name });
    }

    updateProgress(percent, step = '', current = 0, total = 0) {
        this.progress = { percent: Math.min(100, Math.max(0, percent)), step, current, total };
        bus.emit('task:progress', { id: this.id, name: this.name, ...this.progress });
        if (this._onProgress) this._onProgress(this.progress);
    }

    onProgress(fn) { this._onProgress = fn; }

    throwIfCancelled() {
        if (this.cancelled) {
            const err = new Error('Operation cancelled');
            err.cancelled = true;
            throw err;
        }
    }

    async run(fn) {
        this.state = 'running';
        const timer = logger.timed(this.module, this.name);
        bus.emit('task:start', { id: this.id, name: this.name });

        try {
            this.updateProgress(0, 'Starting...');
            const result = await fn(this);
            this.state = 'completed';
            this.updateProgress(100, 'Done');
            timer.end({ status: 'completed' });
            bus.emit('task:complete', { id: this.id, name: this.name });
            return result;
        } catch (error) {
            if (this.cancelled || error?.cancelled || error?.name === 'AbortError') {
                this.state = 'cancelled';
                timer.end({ status: 'cancelled' });
                bus.emit('task:cancelled', { id: this.id, name: this.name });
                return null;
            }
            this.state = 'failed';
            const classified = handleError(error, this.module, this.name);
            bus.emit('task:error', { id: this.id, name: this.name, error: classified });
            throw error;
        } finally {
            bus.emit('task:end', { id: this.id, name: this.name, state: this.state });
        }
    }
}

/**
 * Yield to the UI thread periodically during heavy loops
 */
export function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Process items in chunks, yielding UI between chunks
 */
export async function processInChunks(items, chunkSize, processFn, task = null) {
    const results = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        if (task) {
            task.throwIfCancelled();
            task.updateProgress(Math.round((i / items.length) * 100), `Processing ${i}/${items.length}`, i, items.length);
        }
        const chunk = items.slice(i, i + chunkSize);
        for (const item of chunk) {
            results.push(processFn(item, i));
        }
        await yieldToUI();
    }
    return results;
}

export default TaskRunner;
