/**
 * Draw Manager — Create and edit features directly on the map
 * Supports drawing points, lines, and polygons into a target layer.
 * Uses native Leaflet events (no external draw library required).
 */
import bus from '../core/event-bus.js';
import logger from '../core/logger.js';
import mapManager from './map-manager.js';

const DRAW_STYLE = {
    color: '#f59e0b',
    weight: 3,
    opacity: 0.9,
    fillColor: '#f59e0b',
    fillOpacity: 0.3,
    dashArray: '6 4'
};

const VERTEX_STYLE = {
    radius: 5,
    fillColor: '#fff',
    color: '#f59e0b',
    weight: 2,
    opacity: 1,
    fillOpacity: 1
};

class DrawManager {
    constructor() {
        this._active = false;
        this._tool = null;          // 'point' | 'line' | 'polygon' | null
        this._targetLayerId = null;  // layer ID to add features to
        this._vertices = [];         // current drawing vertices [{lat, lng}]
        this._previewLayers = [];    // temp Leaflet layers for drawing preview
        this._previewLine = null;    // polyline preview during line/polygon draw
        this._cursorMarker = null;   // rubber-band cursor follow
        this._toolbar = null;        // DOM element for draw toolbar
        this._escHandler = null;
        this._clickHandler = null;
        this._moveHandler = null;
        this._dblClickHandler = null;
        this._clickTimeout = null;   // debounce clicks vs dblclick
        this._finishing = false;     // guard to prevent clicks during finish
    }

    /** Get the Leaflet map instance */
    get map() { return mapManager.map; }

    /** Is drawing currently active? */
    get isDrawing() { return this._active && this._tool !== null; }

    /** Get the active tool name */
    get activeTool() { return this._tool; }

    /** Get the target layer ID */
    get targetLayerId() { return this._targetLayerId; }

    // ============================
    // Toolbar UI
    // ============================

    /**
     * Show the floating draw toolbar on the map.
     * @param {string} layerId - The layer to draw into
     * @param {string} layerName - Display name of the target layer
     */
    showToolbar(layerId, layerName) {
        this.hideToolbar();
        this._targetLayerId = layerId;

        const toolbar = document.createElement('div');
        toolbar.className = 'draw-toolbar';
        toolbar.innerHTML = `
            <div class="draw-toolbar-header">
                <span class="draw-toolbar-title">✏️ Draw: <strong>${layerName}</strong></span>
                <button class="draw-toolbar-close" title="Close draw tools">✕</button>
            </div>
            <div class="draw-toolbar-tools">
                <button class="draw-tool-btn" data-tool="point" title="Draw point">
                    <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="currentColor"/></svg>
                    <span>Point</span>
                </button>
                <button class="draw-tool-btn" data-tool="line" title="Draw line">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 14L14 2" stroke="currentColor" stroke-width="2" fill="none"/></svg>
                    <span>Line</span>
                </button>
                <button class="draw-tool-btn" data-tool="polygon" title="Draw polygon">
                    <svg width="16" height="16" viewBox="0 0 16 16"><polygon points="8,1 15,12 1,12" stroke="currentColor" stroke-width="1.5" fill="currentColor" fill-opacity="0.3"/></svg>
                    <span>Polygon</span>
                </button>
            </div>
            <div class="draw-toolbar-hint"></div>
        `;

        // Wire buttons
        toolbar.querySelector('.draw-toolbar-close').onclick = () => this.hideToolbar();
        toolbar.querySelectorAll('.draw-tool-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const tool = btn.dataset.tool;
                if (this._tool === tool) {
                    this.cancelDraw();
                } else {
                    this.startTool(tool);
                }
            };
        });

        // Prevent all clicks/dblclicks on the toolbar from reaching the map
        toolbar.addEventListener('click', (e) => e.stopPropagation());
        toolbar.addEventListener('dblclick', (e) => e.stopPropagation());
        toolbar.addEventListener('mousedown', (e) => e.stopPropagation());

        this.map.getContainer().appendChild(toolbar);
        this._toolbar = toolbar;
        this._active = true;

        logger.info('Draw', `Draw toolbar opened for layer: ${layerName}`);
        bus.emit('draw:toolbarOpened', { layerId });
    }

    /** Hide the draw toolbar and cancel any active drawing */
    hideToolbar() {
        this.cancelDraw();
        if (this._toolbar) {
            this._toolbar.remove();
            this._toolbar = null;
        }
        this._active = false;
        this._targetLayerId = null;
        bus.emit('draw:toolbarClosed');
    }

    /** Update hint text in toolbar */
    _setHint(text) {
        if (!this._toolbar) return;
        const hint = this._toolbar.querySelector('.draw-toolbar-hint');
        if (hint) hint.textContent = text;
    }

    /** Update active button state */
    _updateToolButtons() {
        if (!this._toolbar) return;
        this._toolbar.querySelectorAll('.draw-tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === this._tool);
        });
    }

    // ============================
    // Drawing tools
    // ============================

    /**
     * Start a drawing tool.
     * @param {'point'|'line'|'polygon'} tool
     */
    startTool(tool) {
        this.cancelDraw();
        this._tool = tool;
        this._vertices = [];
        this._finishing = false;
        this._updateToolButtons();

        // Disable map click-to-popup and selection during drawing
        if (mapManager._selectionMode) mapManager.exitSelectionMode();

        // Change cursor
        this.map.getContainer().style.cursor = 'crosshair';

        // Set up event handlers
        this._clickHandler = (e) => this._onMapClick(e);
        this._moveHandler = (e) => this._onMapMove(e);
        this._dblClickHandler = (e) => this._onMapDblClick(e);
        this._escHandler = (e) => { if (e.key === 'Escape') this.cancelDraw(); };

        this.map.on('click', this._clickHandler);
        this.map.on('mousemove', this._moveHandler);
        document.addEventListener('keydown', this._escHandler);

        if (tool === 'line' || tool === 'polygon') {
            // Disable default double-click zoom during line/polygon draw
            this.map.doubleClickZoom.disable();
            this.map.on('dblclick', this._dblClickHandler);
            this._setHint(tool === 'line'
                ? 'Click to add vertices. Double-click or press Enter to finish.'
                : 'Click to add vertices. Double-click or press Enter to close polygon.');
        } else if (tool === 'point') {
            this._setHint('Click on the map to place a point.');
        }

        // Also finish line/polygon with Enter key
        const enterHandler = (e) => {
            if (e.key === 'Enter') {
                const minVerts = this._tool === 'polygon' ? 3 : 2;
                if (this._vertices.length >= minVerts) {
                    this._finishDraw();
                }
            }
        };
        this._enterHandler = enterHandler;
        document.addEventListener('keydown', enterHandler);

        logger.info('Draw', `Started tool: ${tool}`);
    }

    /** Cancel the current drawing (discard vertices) */
    cancelDraw() {
        this._clearPreview();
        this._vertices = [];
        this._tool = null;
        this._finishing = false;
        this._updateToolButtons();
        this._setHint('');

        // Clear pending click timeout
        if (this._clickTimeout) {
            clearTimeout(this._clickTimeout);
            this._clickTimeout = null;
        }

        // Restore cursor
        if (this.map) {
            this.map.getContainer().style.cursor = '';
            this.map.doubleClickZoom.enable();
        }

        // Remove event handlers
        if (this._clickHandler) { this.map?.off('click', this._clickHandler); this._clickHandler = null; }
        if (this._moveHandler) { this.map?.off('mousemove', this._moveHandler); this._moveHandler = null; }
        if (this._dblClickHandler) { this.map?.off('dblclick', this._dblClickHandler); this._dblClickHandler = null; }
        if (this._escHandler) { document.removeEventListener('keydown', this._escHandler); this._escHandler = null; }
        if (this._enterHandler) { document.removeEventListener('keydown', this._enterHandler); this._enterHandler = null; }
    }

    // ============================
    // Map event handlers
    // ============================

    _onMapClick(e) {
        // Stop the click from reaching other map handlers (popup, highlight, etc.)
        if (e.originalEvent) {
            e.originalEvent.stopPropagation();
            e.originalEvent._drawHandled = true;
        }

        if (this._finishing) return;

        const { lat, lng } = e.latlng;

        if (this._tool === 'point') {
            // Single click places a point immediately
            this._createFeature('Point', [[lng, lat]]);
            return;
        }

        // Line or Polygon: delay the click to distinguish from dblclick.
        // If a dblclick fires within 250ms, the pending click is cancelled.
        if (this._clickTimeout) clearTimeout(this._clickTimeout);
        this._clickTimeout = setTimeout(() => {
            this._clickTimeout = null;
            if (this._finishing) return;
            this._addVertex(lat, lng);
        }, 200);
    }

    /** Add a vertex and update preview (separated for clarity) */
    _addVertex(lat, lng) {
        this._vertices.push({ lat, lng });
        this._addVertexMarker(L.latLng(lat, lng));
        this._updatePreviewLine();

        const n = this._vertices.length;
        if (this._tool === 'line') {
            this._setHint(`${n} vertex${n > 1 ? 'es' : ''} placed. Double-click or Enter to finish.`);
        } else {
            this._setHint(`${n} vertex${n > 1 ? 'es' : ''} placed. ${n < 3 ? 'Need at least 3.' : 'Double-click or Enter to close polygon.'}`);
        }
    }

    _onMapMove(e) {
        if (this._tool === 'point' || this._vertices.length === 0) return;
        // Update rubber-band line from last vertex to cursor
        this._updateRubberBand(e.latlng);
    }

    _onMapDblClick(e) {
        // Stop dblclick from zooming and from propagating
        if (e.originalEvent) {
            e.originalEvent.preventDefault();
            e.originalEvent.stopPropagation();
            e.originalEvent._drawHandled = true;
        }

        // Cancel any pending single-click so it doesn't add an extra vertex
        if (this._clickTimeout) {
            clearTimeout(this._clickTimeout);
            this._clickTimeout = null;
        }

        // Need minimum vertices to finish
        const minVerts = this._tool === 'polygon' ? 3 : 2;
        if (this._vertices.length >= minVerts) {
            this._finishDraw();
        }
    }

    // ============================
    // Preview rendering
    // ============================

    _addVertexMarker(latlng) {
        const marker = L.circleMarker(latlng, VERTEX_STYLE).addTo(this.map);
        this._previewLayers.push(marker);
    }

    _updatePreviewLine() {
        if (this._previewLine) {
            this.map.removeLayer(this._previewLine);
            this._previewLine = null;
        }
        if (this._vertices.length < 2) return;

        const latlngs = this._vertices.map(v => [v.lat, v.lng]);
        if (this._tool === 'polygon' && this._vertices.length >= 3) {
            latlngs.push(latlngs[0]); // close the ring for preview
        }
        this._previewLine = L.polyline(latlngs, DRAW_STYLE).addTo(this.map);
    }

    _updateRubberBand(cursorLatLng) {
        // Remove old rubber band
        if (this._rubberBand) {
            this.map.removeLayer(this._rubberBand);
            this._rubberBand = null;
        }
        const lastVertex = this._vertices[this._vertices.length - 1];
        if (!lastVertex) return;

        const points = [[lastVertex.lat, lastVertex.lng], [cursorLatLng.lat, cursorLatLng.lng]];
        // For polygon, also draw line from cursor back to first vertex
        if (this._tool === 'polygon' && this._vertices.length >= 2) {
            points.push([this._vertices[0].lat, this._vertices[0].lng]);
        }
        this._rubberBand = L.polyline(points, {
            ...DRAW_STYLE,
            opacity: 0.5,
            dashArray: '4 6'
        }).addTo(this.map);
    }

    _clearPreview() {
        this._previewLayers.forEach(l => {
            try { this.map?.removeLayer(l); } catch (_) {}
        });
        this._previewLayers = [];
        if (this._previewLine) {
            try { this.map?.removeLayer(this._previewLine); } catch (_) {}
            this._previewLine = null;
        }
        if (this._rubberBand) {
            try { this.map?.removeLayer(this._rubberBand); } catch (_) {}
            this._rubberBand = null;
        }
    }

    // ============================
    // Feature creation
    // ============================

    _finishDraw() {
        this._finishing = true;
        if (this._tool === 'line' && this._vertices.length >= 2) {
            const coords = this._vertices.map(v => [v.lng, v.lat]);
            this._createFeature('LineString', coords);
        } else if (this._tool === 'polygon' && this._vertices.length >= 3) {
            const coords = this._vertices.map(v => [v.lng, v.lat]);
            coords.push(coords[0]); // close ring
            this._createFeature('Polygon', [coords]);
        }
        this._finishing = false;
    }

    /**
     * Create a GeoJSON feature and emit it.
     * @param {'Point'|'LineString'|'Polygon'} type
     * @param {Array} coordinates
     */
    _createFeature(type, coordinates) {
        const feature = {
            type: 'Feature',
            properties: {},
            geometry: {
                type,
                coordinates: type === 'Point' ? coordinates[0] : coordinates
            }
        };

        this._clearPreview();
        this._vertices = [];

        // Emit the new feature so app.js can add it to the layer
        bus.emit('draw:featureCreated', {
            layerId: this._targetLayerId,
            feature
        });

        logger.info('Draw', `Created ${type} feature`);

        // Stay in the same tool for continued drawing
        if (this._tool === 'point') {
            this._setHint('Point placed! Click again to add another.');
        } else {
            // Re-start line/polygon tool for another feature
            const currentTool = this._tool;
            this.cancelDraw();
            this.startTool(currentTool);
        }
    }
}

const drawManager = new DrawManager();
export default drawManager;
