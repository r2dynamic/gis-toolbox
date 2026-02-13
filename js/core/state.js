/**
 * Application state management
 * Reactive state with change notifications
 */
import bus from './event-bus.js';

const state = {
    layers: [],           // Array of canonical datasets
    activeLayerId: null,
    transformHistory: [],  // Array of { id, layerId, name, timestamp, snapshot }
    historyIndex: -1,
    filters: [],
    agolCompatMode: false,
    ui: {
        isMobile: window.innerWidth < 768,
        activeTab: 'data',     // mobile tabs: data | prep | tools | export
        leftPanelOpen: true,
        rightPanelOpen: true,
        logsOpen: false,
        photoMapperOpen: false,
        arcgisImporterOpen: false,
        coordinatesOpen: false
    }
};

export function getState() { return state; }

export function getLayers() { return state.layers; }

export function getActiveLayer() {
    return state.layers.find(l => l.id === state.activeLayerId) || state.layers[0] || null;
}

export function addLayer(dataset) {
    state.layers.push(dataset);
    if (!state.activeLayerId) state.activeLayerId = dataset.id;
    bus.emit('layers:changed', state.layers);
    bus.emit('layer:added', dataset);
}

export function removeLayer(id) {
    state.layers = state.layers.filter(l => l.id !== id);
    if (state.activeLayerId === id) {
        state.activeLayerId = state.layers[0]?.id || null;
    }
    bus.emit('layers:changed', state.layers);
    bus.emit('layer:removed', { id });
}

export function setActiveLayer(id) {
    state.activeLayerId = id;
    bus.emit('layer:active', getActiveLayer());
}

export function updateLayer(id, updates) {
    const layer = state.layers.find(l => l.id === id);
    if (layer) {
        Object.assign(layer, updates);
        if (updates.geojson) {
            import('./data-model.js').then(dm => {
                layer.schema = dm.analyzeSchema(layer.geojson);
                bus.emit('layer:updated', layer);
                bus.emit('layers:changed', state.layers);
            });
            return;
        }
        bus.emit('layer:updated', layer);
        bus.emit('layers:changed', state.layers);
    }
}

export function updateLayerData(id, geojson) {
    const layer = state.layers.find(l => l.id === id);
    if (!layer) return;
    layer.geojson = geojson;
    // Dynamically import to avoid circular dep
    import('./data-model.js').then(dm => {
        layer.schema = dm.analyzeSchema(geojson);
        bus.emit('layer:updated', layer);
        bus.emit('layers:changed', state.layers);
    });
}

export function toggleLayerVisibility(id) {
    const layer = state.layers.find(l => l.id === id);
    if (layer) {
        layer.visible = !layer.visible;
        bus.emit('layer:visibility', layer);
    }
}

// Transform history
export function pushTransform(layerId, name, snapshotGeojson) {
    // Truncate any redo history
    state.transformHistory = state.transformHistory.slice(0, state.historyIndex + 1);
    state.transformHistory.push({
        id: Date.now(),
        layerId,
        name,
        timestamp: new Date().toISOString(),
        snapshot: JSON.parse(JSON.stringify(snapshotGeojson))
    });
    state.historyIndex = state.transformHistory.length - 1;
    bus.emit('history:changed', { history: state.transformHistory, index: state.historyIndex });
}

export function undo() {
    if (state.historyIndex <= 0) return false;
    state.historyIndex--;
    const entry = state.transformHistory[state.historyIndex];
    const layer = state.layers.find(l => l.id === entry.layerId);
    if (layer && layer.type === 'spatial') {
        layer.geojson = JSON.parse(JSON.stringify(entry.snapshot));
        import('./data-model.js').then(dm => {
            layer.schema = dm.analyzeSchema(layer.geojson);
            bus.emit('layer:updated', layer);
            bus.emit('layers:changed', state.layers);
        });
    }
    bus.emit('history:changed', { history: state.transformHistory, index: state.historyIndex });
    return true;
}

export function redo() {
    if (state.historyIndex >= state.transformHistory.length - 1) return false;
    state.historyIndex++;
    const entry = state.transformHistory[state.historyIndex];
    const layer = state.layers.find(l => l.id === entry.layerId);
    if (layer && layer.type === 'spatial') {
        layer.geojson = JSON.parse(JSON.stringify(entry.snapshot));
        import('./data-model.js').then(dm => {
            layer.schema = dm.analyzeSchema(layer.geojson);
            bus.emit('layer:updated', layer);
            bus.emit('layers:changed', state.layers);
        });
    }
    bus.emit('history:changed', { history: state.transformHistory, index: state.historyIndex });
    return true;
}

// UI state
export function setUIState(key, value) {
    state.ui[key] = value;
    bus.emit('ui:changed', { key, value });
}

export function toggleAGOLCompat() {
    state.agolCompatMode = !state.agolCompatMode;
    bus.emit('agol:toggled', state.agolCompatMode);
}

// Detect mobile
function checkMobile() {
    const wasMobile = state.ui.isMobile;
    state.ui.isMobile = window.innerWidth < 768;
    if (wasMobile !== state.ui.isMobile) {
        bus.emit('ui:responsive', state.ui.isMobile);
    }
}
window.addEventListener('resize', checkMobile);

export default {
    getState, getLayers, getActiveLayer, addLayer, removeLayer, setActiveLayer,
    updateLayer, updateLayerData, toggleLayerVisibility,
    pushTransform, undo, redo,
    setUIState, toggleAGOLCompat
};
