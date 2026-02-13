/**
 * Transform history + undo/redo
 */
import bus from '../core/event-bus.js';
import logger from '../core/logger.js';

const history = [];
let currentIndex = -1;

export function saveSnapshot(layerId, name, geojsonOrRows) {
    // Truncate forward history
    history.splice(currentIndex + 1);
    history.push({
        id: Date.now(),
        layerId,
        name,
        timestamp: new Date().toISOString(),
        snapshot: JSON.parse(JSON.stringify(geojsonOrRows))
    });
    currentIndex = history.length - 1;
    logger.info('TransformHistory', `Snapshot: ${name}`, { index: currentIndex, total: history.length });
    bus.emit('history:changed', getHistoryState());
}

export function undo() {
    if (currentIndex <= 0) return null;
    currentIndex--;
    const entry = history[currentIndex];
    logger.info('TransformHistory', 'Undo', { to: entry.name, index: currentIndex });
    bus.emit('history:changed', getHistoryState());
    return entry;
}

export function redo() {
    if (currentIndex >= history.length - 1) return null;
    currentIndex++;
    const entry = history[currentIndex];
    logger.info('TransformHistory', 'Redo', { to: entry.name, index: currentIndex });
    bus.emit('history:changed', getHistoryState());
    return entry;
}

export function getHistoryState() {
    return {
        entries: history.map((h, i) => ({ id: h.id, name: h.name, timestamp: h.timestamp, isCurrent: i === currentIndex })),
        canUndo: currentIndex > 0,
        canRedo: currentIndex < history.length - 1,
        currentIndex,
        total: history.length
    };
}

export function getSnapshot(index) {
    return history[index]?.snapshot || null;
}

export function clearHistory() {
    history.length = 0;
    currentIndex = -1;
    bus.emit('history:changed', getHistoryState());
}

export default { saveSnapshot, undo, redo, getHistoryState, getSnapshot, clearHistory };
