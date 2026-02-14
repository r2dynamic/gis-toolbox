/**
 * Map manager — Leaflet integration
 * Keyless basemaps, layer rendering, popups, clustering
 */
import logger from '../core/logger.js';
import bus from '../core/event-bus.js';

const BASEMAPS = {
    osm: {
        name: 'Street Map',
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    },
    light: {
        name: 'Light / Gray',
        url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 20
    },
    dark: {
        name: 'Dark',
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 20
    },
    voyager: {
        name: 'Voyager',
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 20
    },
    topo: {
        name: 'Topographic',
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OSM</a> &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
        maxZoom: 17
    },
    satellite: {
        name: 'Satellite',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: '&copy; Esri, Maxar, Earthstar Geographics',
        maxZoom: 19
    },
    hybrid: {
        name: 'Hybrid',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: '&copy; Esri, Maxar, Earthstar Geographics &copy; <a href="https://openstreetmap.org/copyright">OSM</a>',
        maxZoom: 19,
        overlay: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png'
    },
    none: {
        name: 'No Basemap',
        url: null,
        attribution: '',
        maxZoom: 19
    }
};

const LAYER_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#be185d', '#65a30d'];

class MapManager {
    constructor() {
        this.map = null;
        this.basemapLayer = null;
        this.dataLayers = new Map(); // layerId -> L.geoJSON
        this.clusterGroups = new Map();
        this.currentBasemap = 'osm';
        this.drawLayer = null;
        this.highlightLayer = null; // currently highlighted feature layer
        this._originalStyles = new Map(); // layer -> original style for unhighlight
    }

    init(containerId) {
        if (typeof L === 'undefined') {
            logger.error('Map', 'Leaflet not loaded');
            return;
        }

        this.map = L.map(containerId, {
            center: [39.32, -111.09],
            zoom: 7,
            zoomControl: true,
            attributionControl: true
        });

        this.setBasemap('osm');

        // Error handling for tiles
        this.map.on('tileerror', (e) => {
            logger.warn('Map', 'Tile load error', { url: e.tile?.src });
        });

        // Clear highlight when clicking empty map
        this.map.on('click', () => this.clearHighlight());

        logger.info('Map', 'Map initialized');
        bus.emit('map:ready', this.map);
        return this.map;
    }

    setBasemap(key) {
        const bm = BASEMAPS[key];
        if (!bm) {
            logger.warn('Map', 'Unknown basemap key', { key });
            return;
        }

        // Remove existing layers
        if (this.basemapLayer) {
            this.map.removeLayer(this.basemapLayer);
            this.basemapLayer = null;
        }
        if (this._labelLayer) {
            this.map.removeLayer(this._labelLayer);
            this._labelLayer = null;
        }

        if (bm.url) {
            try {
                this.basemapLayer = L.tileLayer(bm.url, {
                    attribution: bm.attribution,
                    maxZoom: bm.maxZoom || 19,
                    errorTileUrl: ''
                }).addTo(this.map);

                // Hybrid overlay (labels on top of satellite)
                if (bm.overlay) {
                    this._labelLayer = L.tileLayer(bm.overlay, {
                        maxZoom: 20,
                        pane: 'overlayPane'
                    }).addTo(this.map);
                }
            } catch (e) {
                logger.warn('Map', 'Basemap load error', { basemap: key, error: e.message });
            }
        }

        this.currentBasemap = key;
        bus.emit('map:basemap', key);
    }

    getBasemaps() { return BASEMAPS; }

    addLayer(dataset, colorIndex = 0) {
        if (!this.map || !dataset.geojson) return;

        // Remove existing layer for this dataset
        this.removeLayer(dataset.id);

        const color = LAYER_COLORS[colorIndex % LAYER_COLORS.length];
        const features = dataset.geojson.features.filter(f => f.geometry);

        if (features.length === 0) {
            logger.info('Map', 'No geometries to display', { layer: dataset.name });
            return;
        }

        const geojsonLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
            style: (feature) => ({
                color,
                weight: 2,
                opacity: 0.8,
                fillColor: color,
                fillOpacity: 0.3
            }),
            pointToLayer: (feature, latlng) => {
                return L.circleMarker(latlng, {
                    radius: 6,
                    fillColor: color,
                    color: '#fff',
                    weight: 2,
                    opacity: 1,
                    fillOpacity: 0.8
                });
            },
            onEachFeature: (feature, layer) => {
                layer.on('click', (e) => {
                    L.DomEvent.stopPropagation(e);
                    this.highlightFeature(layer, color);
                    this.showPopup(feature, layer);
                });
            }
        });

        // Large dataset warning / clustering
        if (features.length > 10000) {
            logger.warn('Map', 'Large dataset — rendering may be slow', { count: features.length });
        }

        geojsonLayer.addTo(this.map);
        this.dataLayers.set(dataset.id, geojsonLayer);

        // Fit bounds
        try {
            const bounds = geojsonLayer.getBounds();
            if (bounds.isValid()) {
                this.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
            }
        } catch (e) {
            logger.warn('Map', 'Could not fit bounds', { error: e.message });
        }

        logger.info('Map', 'Layer added', { name: dataset.name, features: features.length });
        bus.emit('map:layerAdded', { id: dataset.id, name: dataset.name });
    }

    removeLayer(id) {
        if (this.dataLayers.has(id)) {
            this.map.removeLayer(this.dataLayers.get(id));
            this.dataLayers.delete(id);
        }
    }

    toggleLayer(id, visible) {
        const layer = this.dataLayers.get(id);
        if (!layer) return;
        if (visible) {
            if (!this.map.hasLayer(layer)) this.map.addLayer(layer);
        } else {
            this.map.removeLayer(layer);
        }
    }

    showPopup(feature, layer) {
        const props = feature.properties || {};
        let imgHtml = '';

        // Show photo thumbnail if available (prefer blob URL for speed, fallback to data URL)
        const imgSrc = props._thumbnailUrl || props._thumbnailDataUrl;
        if (imgSrc) {
            imgHtml = `<div style="margin-bottom:6px;text-align:center;">
                <img src="${imgSrc}" style="max-width:280px;max-height:200px;border-radius:4px;" />
            </div>`;
        }

        const rows = Object.entries(props)
            .filter(([k, v]) => v != null && !k.startsWith('_'))
            .map(([k, v]) => {
                let val = v;
                if (typeof v === 'object') val = JSON.stringify(v);
                if (typeof val === 'string' && val.length > 100) val = val.slice(0, 100) + '…';
                return `<tr><th>${k}</th><td>${val}</td></tr>`;
            }).join('');
        const tableHtml = rows ? `<table>${rows}</table>` : '<em>No attributes</em>';
        const html = imgHtml + tableHtml;

        const popup = layer.bindPopup(html, { maxWidth: 350, maxHeight: 400 }).openPopup();

        // Clear highlight when popup is closed
        layer.on('popupclose', () => this.clearHighlight(), { once: true });
    }

    /**
     * Highlight a clicked feature with a bright style
     */
    highlightFeature(layer, originalColor) {
        // Clear previous highlight
        this.clearHighlight();

        // Store reference
        this.highlightLayer = layer;

        // Apply highlight style
        if (layer instanceof L.CircleMarker) {
            // Point feature
            this._originalStyles.set(layer, {
                radius: layer.getRadius(),
                fillColor: layer.options.fillColor,
                color: layer.options.color,
                weight: layer.options.weight,
                fillOpacity: layer.options.fillOpacity
            });
            layer.setStyle({
                radius: 10,
                fillColor: '#fbbf24',
                color: '#ffffff',
                weight: 3,
                fillOpacity: 1
            });
            layer.bringToFront();
        } else if (layer.setStyle) {
            // Line or polygon
            this._originalStyles.set(layer, {
                color: layer.options.color,
                weight: layer.options.weight,
                opacity: layer.options.opacity,
                fillColor: layer.options.fillColor,
                fillOpacity: layer.options.fillOpacity
            });
            layer.setStyle({
                color: '#fbbf24',
                weight: 4,
                opacity: 1,
                fillColor: '#fbbf24',
                fillOpacity: 0.35
            });
            layer.bringToFront();
        }
    }

    /**
     * Clear the current feature highlight, restoring original style
     */
    clearHighlight() {
        if (!this.highlightLayer) return;

        const orig = this._originalStyles.get(this.highlightLayer);
        if (orig && this.highlightLayer.setStyle) {
            this.highlightLayer.setStyle(orig);
            if (orig.radius && this.highlightLayer instanceof L.CircleMarker) {
                this.highlightLayer.setRadius(orig.radius);
            }
        }
        this._originalStyles.delete(this.highlightLayer);
        this.highlightLayer = null;
    }

    fitToAll() {
        const allBounds = [];
        for (const layer of this.dataLayers.values()) {
            try {
                const b = layer.getBounds();
                if (b.isValid()) allBounds.push(b);
            } catch (_) { }
        }
        if (allBounds.length > 0) {
            let merged = allBounds[0];
            for (let i = 1; i < allBounds.length; i++) merged.extend(allBounds[i]);
            this.map.fitBounds(merged, { padding: [30, 30], maxZoom: 16 });
        }
    }

    getBounds() {
        return this.map?.getBounds();
    }

    getMap() { return this.map; }

    // ==========================================
    // Interactive Drawing / Selection System
    // ==========================================

    /**
     * Enter "click one point" mode.
     * Shows a crosshair cursor and returns a promise resolving to [lng, lat]
     * on click, or null if cancelled (Escape).
     */
    startPointPick(prompt = 'Click the map to place a point') {
        return new Promise((resolve) => {
            this._cancelInteraction(); // clear any previous mode

            const container = this.map.getContainer();
            container.style.cursor = 'crosshair';

            // Show instruction banner
            const banner = this._showInteractionBanner(prompt, () => {
                cleanup(); resolve(null);
            });

            // Temp marker
            let marker = null;

            const onClick = (e) => {
                cleanup();
                resolve([e.latlng.lng, e.latlng.lat]);
            };

            const onKeyDown = (e) => {
                if (e.key === 'Escape') { cleanup(); resolve(null); }
            };

            const cleanup = () => {
                container.style.cursor = '';
                this.map.off('click', onClick);
                document.removeEventListener('keydown', onKeyDown);
                if (marker) this.map.removeLayer(marker);
                if (banner) banner.remove();
                this._interactionCleanup = null;
            };

            this._interactionCleanup = cleanup;
            this.map.on('click', onClick);
            document.addEventListener('keydown', onKeyDown);
        });
    }

    /**
     * Enter "click two points" mode.
     * Returns a promise resolving to [[lng1, lat1], [lng2, lat2]] or null if cancelled.
     */
    startTwoPointPick(prompt1 = 'Click the first point', prompt2 = 'Click the second point') {
        return new Promise((resolve) => {
            this._cancelInteraction();

            const container = this.map.getContainer();
            container.style.cursor = 'crosshair';

            const markers = [];
            let firstPoint = null;

            const banner = this._showInteractionBanner(prompt1, () => {
                cleanup(); resolve(null);
            });

            const onKeyDown = (e) => {
                if (e.key === 'Escape') { cleanup(); resolve(null); }
            };

            const onClick = (e) => {
                const coord = [e.latlng.lng, e.latlng.lat];

                // Place a visible marker
                const m = L.circleMarker(e.latlng, {
                    radius: 7, fillColor: '#d4a24e', color: '#fff',
                    weight: 2, fillOpacity: 1
                }).addTo(this.map);
                markers.push(m);

                if (!firstPoint) {
                    firstPoint = coord;
                    banner.querySelector('.interaction-text').textContent = prompt2;
                } else {
                    cleanup();
                    resolve([firstPoint, coord]);
                }
            };

            const cleanup = () => {
                container.style.cursor = '';
                this.map.off('click', onClick);
                document.removeEventListener('keydown', onKeyDown);
                markers.forEach(m => this.map.removeLayer(m));
                if (banner) banner.remove();
                this._interactionCleanup = null;
            };

            this._interactionCleanup = cleanup;
            this.map.on('click', onClick);
            document.addEventListener('keydown', onKeyDown);
        });
    }

    /**
     * Enter "draw rectangle" mode.
     * User clicks and drags to draw a bounding box.
     * Returns [west, south, east, north] or null if cancelled.
     */
    startRectangleDraw(prompt = 'Click and drag to draw a rectangle') {
        return new Promise((resolve) => {
            this._cancelInteraction();

            const container = this.map.getContainer();
            container.style.cursor = 'crosshair';

            const banner = this._showInteractionBanner(prompt, () => {
                cleanup(); resolve(null);
            });

            let startLatLng = null;
            let rect = null;

            const onMouseDown = (e) => {
                startLatLng = e.latlng;
                this.map.dragging.disable();
            };

            const onMouseMove = (e) => {
                if (!startLatLng) return;
                const bounds = L.latLngBounds(startLatLng, e.latlng);
                if (rect) {
                    rect.setBounds(bounds);
                } else {
                    rect = L.rectangle(bounds, {
                        color: '#d4a24e', weight: 2, fillOpacity: 0.15,
                        dashArray: '6,4'
                    }).addTo(this.map);
                }
            };

            const onMouseUp = (e) => {
                if (!startLatLng) return;
                this.map.dragging.enable();
                const bounds = L.latLngBounds(startLatLng, e.latlng);
                cleanup();
                resolve([
                    bounds.getWest(), bounds.getSouth(),
                    bounds.getEast(), bounds.getNorth()
                ]);
            };

            const onKeyDown = (e) => {
                if (e.key === 'Escape') {
                    this.map.dragging.enable();
                    cleanup();
                    resolve(null);
                }
            };

            const cleanup = () => {
                container.style.cursor = '';
                this.map.off('mousedown', onMouseDown);
                this.map.off('mousemove', onMouseMove);
                this.map.off('mouseup', onMouseUp);
                document.removeEventListener('keydown', onKeyDown);
                if (rect) {
                    // Flash the rectangle briefly then remove
                    setTimeout(() => { if (rect) this.map.removeLayer(rect); }, 800);
                }
                if (banner) banner.remove();
                this._interactionCleanup = null;
            };

            this._interactionCleanup = cleanup;
            this.map.on('mousedown', onMouseDown);
            this.map.on('mousemove', onMouseMove);
            this.map.on('mouseup', onMouseUp);
            document.addEventListener('keydown', onKeyDown);
        });
    }

    /**
     * Show a temporary result on the map (marker, line, polygon)
     * Auto-removes after duration ms. Returns the layer for manual removal.
     */
    showTempFeature(geojson, duration = 10000) {
        const layer = L.geoJSON(geojson, {
            style: { color: '#d4a24e', weight: 3, fillOpacity: 0.25, fillColor: '#d4a24e' },
            pointToLayer: (f, latlng) => L.circleMarker(latlng, {
                radius: 8, fillColor: '#d4a24e', color: '#fff', weight: 2, fillOpacity: 0.9
            })
        }).addTo(this.map);
        if (duration > 0) {
            setTimeout(() => { try { this.map.removeLayer(layer); } catch (_) {} }, duration);
        }
        return layer;
    }

    /** Internal: cancel any ongoing interaction */
    _cancelInteraction() {
        if (this._interactionCleanup) {
            this._interactionCleanup();
            this._interactionCleanup = null;
        }
    }

    /** Internal: show banner at top of map */
    _showInteractionBanner(text, onCancel) {
        const banner = document.createElement('div');
        banner.className = 'map-interaction-banner';
        banner.innerHTML = `
            <span class="interaction-text">${text}</span>
            <button class="interaction-cancel">✕ Cancel</button>
            <span style="font-size:11px;opacity:0.6;margin-left:8px;">(Esc to cancel)</span>
        `;
        banner.querySelector('.interaction-cancel').onclick = onCancel;
        this.map.getContainer().appendChild(banner);
        return banner;
    }

    destroy() {
        this._cancelInteraction();
        if (this.map) {
            this.map.remove();
            this.map = null;
        }
        this.dataLayers.clear();
    }
}

export const mapManager = new MapManager();
export default mapManager;
