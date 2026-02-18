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

// Point symbol shapes — SVG icon factories
const POINT_SYMBOLS = {
    circle: null, // default circleMarker
    square: (color, fillColor, size, opacity) => L.divIcon({
        className: 'point-symbol',
        html: `<svg width="${size*2}" height="${size*2}" viewBox="0 0 ${size*2} ${size*2}"><rect x="1" y="1" width="${size*2-2}" height="${size*2-2}" fill="${fillColor}" fill-opacity="${opacity}" stroke="${color}" stroke-width="2" rx="2"/></svg>`,
        iconSize: [size*2, size*2],
        iconAnchor: [size, size]
    }),
    triangle: (color, fillColor, size, opacity) => L.divIcon({
        className: 'point-symbol',
        html: `<svg width="${size*2}" height="${size*2}" viewBox="0 0 ${size*2} ${size*2}"><polygon points="${size},1 ${size*2-1},${size*2-1} 1,${size*2-1}" fill="${fillColor}" fill-opacity="${opacity}" stroke="${color}" stroke-width="2"/></svg>`,
        iconSize: [size*2, size*2],
        iconAnchor: [size, size]
    }),
    diamond: (color, fillColor, size, opacity) => L.divIcon({
        className: 'point-symbol',
        html: `<svg width="${size*2}" height="${size*2}" viewBox="0 0 ${size*2} ${size*2}"><polygon points="${size},1 ${size*2-1},${size} ${size},${size*2-1} 1,${size}" fill="${fillColor}" fill-opacity="${opacity}" stroke="${color}" stroke-width="2"/></svg>`,
        iconSize: [size*2, size*2],
        iconAnchor: [size, size]
    }),
    star: (color, fillColor, size, opacity) => {
        const cx = size, cy = size, r = size - 1, ri = r * 0.4;
        let pts = '';
        for (let i = 0; i < 5; i++) {
            const aOuter = (Math.PI / 2) + (2 * Math.PI * i / 5);
            const aInner = aOuter + Math.PI / 5;
            pts += `${cx + r * Math.cos(aOuter)},${cy - r * Math.sin(aOuter)} `;
            pts += `${cx + ri * Math.cos(aInner)},${cy - ri * Math.sin(aInner)} `;
        }
        return L.divIcon({
            className: 'point-symbol',
            html: `<svg width="${size*2}" height="${size*2}" viewBox="0 0 ${size*2} ${size*2}"><polygon points="${pts.trim()}" fill="${fillColor}" fill-opacity="${opacity}" stroke="${color}" stroke-width="1.5"/></svg>`,
            iconSize: [size*2, size*2],
            iconAnchor: [size, size]
        });
    },
    pin: (color, fillColor, size, opacity) => L.divIcon({
        className: 'point-symbol',
        html: `<svg width="${size*2}" height="${size*2+8}" viewBox="0 0 ${size*2} ${size*2+8}"><path d="M${size} ${size*2+6} C${size} ${size*2+6} ${size*2-1} ${size+2} ${size*2-1} ${size} A${size-1} ${size-1} 0 1 0 1 ${size} C1 ${size+2} ${size} ${size*2+6} ${size} ${size*2+6}Z" fill="${fillColor}" fill-opacity="${opacity}" stroke="${color}" stroke-width="1.5"/><circle cx="${size}" cy="${size}" r="${size*0.35}" fill="${color}" opacity="0.6"/></svg>`,
        iconSize: [size*2, size*2+8],
        iconAnchor: [size, size*2+8]
    })
};

class MapManager {
    constructor() {
        this.map = null;
        this.basemapLayer = null;
        this.dataLayers = new Map(); // layerId -> L.geoJSON
        this._layerNames = new Map(); // layerId -> display name
        this._layerStyles = new Map(); // layerId -> { strokeColor, fillColor, strokeWidth, strokeOpacity, fillOpacity, pointSize, pointSymbol }
        this.clusterGroups = new Map();
        this.currentBasemap = 'voyager';
        this.drawLayer = null;
        this.highlightLayer = null; // currently highlighted feature layer
        this._originalStyles = new Map(); // layer -> original style for unhighlight

        // ── Import fence state ──
        this._importFence = null;       // { bounds: L.latLngBounds, layer: L.rectangle }

        // ── Feature selection state ──
        this._selections = new Map();       // layerId -> Set<featureIndex>
        this._selectionLayers = new Map();   // layerId -> L.layerGroup of selection highlights
        this._selectionMode = false;        // true when selection tool is active
        this._featureIndexMap = new Map();   // leafletLayer._leaflet_id -> { layerId, featureIndex }
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

        this.setBasemap('voyager');

        // Error handling for tiles
        this.map.on('tileerror', (e) => {
            logger.warn('Map', 'Tile load error', { url: e.tile?.src });
        });

        // Clear highlight when clicking empty map (but don't clear selection, and skip during drawing)
        this.map.on('click', (e) => {
            if (e.originalEvent?._drawHandled) return;
            if (!this._selectionMode) {
                this.clearHighlight();
            }
        });

        // Right-click on empty map area
        this.map.on('contextmenu', (e) => {
            e.originalEvent.preventDefault();
            e.originalEvent.stopPropagation();
            bus.emit('map:contextmenu', {
                latlng: e.latlng,
                originalEvent: e.originalEvent,
                layerId: null,
                featureIndex: null,
                feature: null
            });
        });

        logger.info('Map', 'Map initialized');
        bus.emit('map:ready', this.map);

        // Add coordinate search control
        this._initCoordSearch();

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

    /** Get stored style for a layer (or default) */
    getLayerStyle(layerId) {
        return this._layerStyles.get(layerId) || null;
    }

    /** Store style for a layer */
    setLayerStyle(layerId, style) {
        this._layerStyles.set(layerId, style);
    }

    addLayer(dataset, colorIndex = 0, { fit = false } = {}) {
        if (!this.map || !dataset.geojson) return;

        // Remove existing layer for this dataset
        this.removeLayer(dataset.id);

        const defaultColor = LAYER_COLORS[colorIndex % LAYER_COLORS.length];

        // Use stored custom style, or create defaults
        const stored = this._layerStyles.get(dataset.id);
        const sty = {
            strokeColor: stored?.strokeColor || defaultColor,
            fillColor:   stored?.fillColor   || defaultColor,
            strokeWidth: stored?.strokeWidth  ?? 2,
            strokeOpacity: stored?.strokeOpacity ?? 0.8,
            fillOpacity: stored?.fillOpacity ?? 0.3,
            pointSize:   stored?.pointSize   ?? 6,
            pointSymbol: stored?.pointSymbol  || 'circle'
        };

        // Store resolved style if not already saved
        if (!stored) this._layerStyles.set(dataset.id, { ...sty });

        const features = dataset.geojson.features.filter(f => f.geometry);

        if (features.length === 0) {
            logger.info('Map', 'No geometries to display', { layer: dataset.name });
            return;
        }

        const geojsonLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
            style: (feature) => {
                const gt = feature.geometry?.type;
                let s = sty;
                if (gt === 'Point' || gt === 'MultiPoint') s = { ...sty, ...(sty.point || {}) };
                else if (gt === 'LineString' || gt === 'MultiLineString') s = { ...sty, ...(sty.line || {}) };
                else if (gt === 'Polygon' || gt === 'MultiPolygon') s = { ...sty, ...(sty.polygon || {}) };
                return {
                    color: s.strokeColor,
                    weight: s.strokeWidth,
                    opacity: s.strokeOpacity,
                    fillColor: s.fillColor,
                    fillOpacity: s.fillOpacity
                };
            },
            pointToLayer: (feature, latlng) => {
                const ps = { ...sty, ...(sty.point || {}) };
                const sym = ps.pointSymbol || 'circle';
                const fo = Math.min(1, ps.fillOpacity + 0.3);
                if (sym === 'circle') {
                    return L.circleMarker(latlng, {
                        radius: ps.pointSize,
                        fillColor: ps.fillColor,
                        color: ps.strokeColor,
                        weight: ps.strokeWidth,
                        opacity: ps.strokeOpacity,
                        fillOpacity: fo
                    });
                }
                const factory = POINT_SYMBOLS[sym];
                if (factory) {
                    return L.marker(latlng, { icon: factory(ps.strokeColor, ps.fillColor, ps.pointSize, fo) });
                }
                // Fallback to circle
                return L.circleMarker(latlng, {
                    radius: ps.pointSize,
                    fillColor: ps.fillColor,
                    color: ps.strokeColor,
                    weight: ps.strokeWidth,
                    opacity: ps.strokeOpacity,
                    fillOpacity: fo
                });
            },
            onEachFeature: (feature, layer) => {
                // Store the index into the ORIGINAL dataset.geojson.features array
                // (not the filtered array) so editors and popups reference the right feature
                const featureIndex = dataset.geojson.features.indexOf(feature);
                layer._featureIndex = featureIndex;
                layer._datasetId = dataset.id;

                layer.on('click', (e) => {
                    // Skip feature clicks while drawing
                    if (e.originalEvent?._drawHandled) return;
                    L.DomEvent.stopPropagation(e);
                    if (this._selectionMode) {
                        // Selection mode: click toggles selection, shift adds
                        this._handleSelectionClick(dataset.id, featureIndex, e.originalEvent?.shiftKey, sty.strokeColor);
                    } else {
                        const clickLatLng = e.latlng;
                        const nearby = this._findFeaturesNearClick(clickLatLng, dataset.id, featureIndex);
                        if (nearby.length > 1) {
                            // Multiple stacked features — show cycling popup
                            this.highlightFeature(layer, sty.strokeColor);
                            this._showMultiPopup(nearby, clickLatLng);
                        } else {
                            // Single feature — show simple popup (no cycling UI)
                            this.highlightFeature(layer, sty.strokeColor);
                            this._popupHits = nearby;
                            this._popupIndex = 0;
                            this._popupLatLng = clickLatLng;
                            this._renderCyclePopup();
                        }
                    }
                });

                layer.on('contextmenu', (e) => {
                    L.DomEvent.stopPropagation(e);
                    L.DomEvent.preventDefault(e);
                    e.originalEvent.preventDefault();
                    e.originalEvent.stopPropagation();
                    const latlng = e.latlng;
                    bus.emit('map:contextmenu', {
                        latlng,
                        originalEvent: e.originalEvent,
                        layerId: dataset.id,
                        featureIndex,
                        feature
                    });
                });
            }
        });

        // Large dataset warning / clustering
        if (features.length > 10000) {
            logger.warn('Map', 'Large dataset — rendering may be slow', { count: features.length });
        }

        geojsonLayer.addTo(this.map);
        this.dataLayers.set(dataset.id, geojsonLayer);
        this._layerNames.set(dataset.id, dataset.name);

        // Fit bounds only on initial import
        if (fit) {
            try {
                const bounds = geojsonLayer.getBounds();
                if (bounds.isValid()) {
                    this.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
                }
            } catch (e) {
                logger.warn('Map', 'Could not fit bounds', { error: e.message });
            }
        }

        logger.info('Map', 'Layer added', { name: dataset.name, features: features.length });
        bus.emit('map:layerAdded', { id: dataset.id, name: dataset.name });
    }

    removeLayer(id) {
        if (this.dataLayers.has(id)) {
            this.map.removeLayer(this.dataLayers.get(id));
            this.dataLayers.delete(id);
        }
        this._layerNames.delete(id);
        // Also clear any selection for this layer
        this.clearSelection(id);
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

    /**
     * Apply new style to an existing layer and re-render it.
     * @param {string} layerId
     * @param {object} dataset - the full dataset from state
     * @param {object} style - { strokeColor, fillColor, strokeWidth, strokeOpacity, fillOpacity, pointSize, pointSymbol }
     */
    restyleLayer(layerId, dataset, style) {
        this._layerStyles.set(layerId, { ...style });
        // Re-add the layer with the new style — addLayer reads from _layerStyles
        const idx = this._getLayerZIndex(layerId);
        this.addLayer(dataset, idx, { fit: false });
    }

    /** Get approximate z-index from dataLayers insertion order */
    _getLayerZIndex(layerId) {
        let i = 0;
        for (const id of this.dataLayers.keys()) {
            if (id === layerId) return i;
            i++;
        }
        return 0;
    }

    /** Get available point symbol names */
    static get pointSymbols() {
        return Object.keys(POINT_SYMBOLS);
    }

    /**
     * Re-stack Leaflet layers to match the state layers array order.
     * Layers later in the array are drawn on top.
     */
    syncLayerOrder(orderedIds) {
        for (const id of orderedIds) {
            const layer = this.dataLayers.get(id);
            if (layer && this.map.hasLayer(layer)) {
                layer.bringToFront();
            }
        }
    }

    /** Build the HTML content for a single feature popup */
    _buildPopupHtml(feature) {
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
                // Render attached photos inline
                if (v && typeof v === 'object' && v._att && v.dataUrl) {
                    return `<tr><th>${k}</th><td style="padding:4px 0;">
                        <img src="${v.dataUrl}" style="max-width:240px;max-height:180px;border-radius:4px;display:block;margin-bottom:2px;" />
                        <span style="font-size:10px;color:#888;">${v.name || 'photo'}</span>
                    </td></tr>`;
                }
                let val = v;
                if (typeof v === 'object') val = JSON.stringify(v);
                if (typeof val === 'string' && val.length > 100) val = val.slice(0, 100) + '…';
                return `<tr><th>${k}</th><td>${val}</td></tr>`;
            }).join('');
        const tableHtml = rows ? `<table>${rows}</table>` : '<em>No attributes</em>';
        return imgHtml + tableHtml;
    }

    showPopup(feature, layer, latlng) {
        const html = this._buildPopupHtml(feature);
        // Open popup at click location (or fallback to layer center)
        const pos = latlng || (layer.getLatLng ? layer.getLatLng() : layer.getBounds?.()?.getCenter());
        L.popup({ maxWidth: 350, maxHeight: 400 })
            .setLatLng(pos)
            .setContent(html)
            .openOn(this.map);
        // Clear highlight when popup is closed
        this.map.once('popupclose', () => this.clearHighlight());
    }

    /**
     * Find all features that truly overlap the click point across all visible layers.
     * Uses proper geometric containment (turf.js for polygons, actual line proximity,
     * tight pixel tolerance for points). This mimics ArcGIS-style hit detection:
     * only features that are genuinely stacked/overlapping are returned.
     *
     * @param {L.LatLng} latlng - The click location
     * @param {string} [clickedLayerId] - The layer whose feature was actually clicked (gets priority)
     * @param {number} [clickedFeatureIndex] - The feature index that was actually clicked
     * @returns {Array} Hits ordered: clicked feature first, then top-to-bottom
     */
    _findFeaturesNearClick(latlng, clickedLayerId, clickedFeatureIndex) {
        const clickPt = this.map.latLngToContainerPoint(latlng);
        const clickGeoJSON = turf.point([latlng.lng, latlng.lat]);
        const results = [];
        const pointTolerance = 4; // px beyond the marker radius

        for (const [layerId, geojsonLayer] of this.dataLayers) {
            if (!this.map.hasLayer(geojsonLayer)) continue; // skip hidden

            const color = typeof geojsonLayer.options?.style === 'function'
                ? '#2563eb'
                : (geojsonLayer.options?.style?.color || '#2563eb');

            geojsonLayer.eachLayer((sub) => {
                if (sub._featureIndex === undefined) return;
                const geom = sub.feature?.geometry;
                if (!geom) return;

                let hit = false;
                const gType = geom.type;

                if (sub.getLatLng) {
                    // Point / CircleMarker — tight pixel-distance check
                    const pt = this.map.latLngToContainerPoint(sub.getLatLng());
                    const radius = sub.getRadius?.() || 6;
                    hit = clickPt.distanceTo(pt) <= radius + pointTolerance;
                } else if (gType === 'Polygon' || gType === 'MultiPolygon') {
                    // Use turf for true point-in-polygon test
                    try { hit = turf.booleanPointInPolygon(clickGeoJSON, geom); } catch (_) { hit = false; }
                } else if (gType === 'LineString' || gType === 'MultiLineString') {
                    // Check pixel distance to the actual line path
                    try {
                        const nearest = turf.nearestPointOnLine(sub.feature, clickGeoJSON, { units: 'degrees' });
                        if (nearest) {
                            const nearestLatLng = L.latLng(nearest.geometry.coordinates[1], nearest.geometry.coordinates[0]);
                            const nearestPx = this.map.latLngToContainerPoint(nearestLatLng);
                            const lineWeight = sub.options?.weight || 2;
                            hit = clickPt.distanceTo(nearestPx) <= lineWeight + 6;
                        }
                    } catch (_) { hit = false; }
                }

                if (hit) {
                    const featureColor = typeof geojsonLayer.options?.style === 'function'
                        ? (geojsonLayer.options.style(sub.feature)?.color || '#2563eb')
                        : color;
                    results.push({
                        feature: sub.feature,
                        featureIndex: sub._featureIndex,
                        leafletLayer: sub,
                        layerId,
                        layerName: this._layerNames.get(layerId) || layerId,
                        layerColor: featureColor
                    });
                }
            });
        }

        // Ensure the actually-clicked feature is first in results
        if (clickedLayerId !== undefined && clickedFeatureIndex !== undefined) {
            const clickedIdx = results.findIndex(r => r.layerId === clickedLayerId && r.featureIndex === clickedFeatureIndex);
            if (clickedIdx > 0) {
                const [clicked] = results.splice(clickedIdx, 1);
                results.unshift(clicked);
            }
        }

        return results;
    }

    /**
     * Show a popup that can cycle through multiple features ("1 of N" arrows).
     */
    _showMultiPopup(hits, latlng) {
        if (hits.length === 0) return;
        this._popupHits = hits;
        this._popupIndex = 0;
        this._popupLatLng = latlng;
        this._renderCyclePopup();
    }

    _renderCyclePopup() {
        const hits = this._popupHits;
        const idx = this._popupIndex;
        if (!hits || !hits[idx]) return;

        const hit = hits[idx];
        const bodyHtml = this._buildPopupHtml(hit.feature);
        const layerName = hit.layerName || hit.layerId;
        const layerLabel = `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;border-bottom:1px solid var(--border);padding-bottom:3px;">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${hit.layerColor};margin-right:4px;"></span>
            <strong>${layerName}</strong>
        </div>`;

        let navHtml = '';
        if (hits.length > 1) {
            navHtml = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;font-size:11px;">
                <button onclick="window._mapPopupNav(-1)" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:3px;padding:1px 8px;cursor:pointer;font-size:13px;">&larr;</button>
                <span>${idx + 1} of ${hits.length}</span>
                <button onclick="window._mapPopupNav(1)" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:3px;padding:1px 8px;cursor:pointer;font-size:13px;">&rarr;</button>
            </div>`;
        }

        const editBtn = `<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:4px;text-align:right;">
            <button onclick="window._mapPopupEdit()" style="background:var(--primary);color:#fff;border:none;border-radius:4px;padding:3px 12px;cursor:pointer;font-size:12px;">✏️ Edit</button>
        </div>`;

        const html = layerLabel + navHtml + bodyHtml + editBtn;

        // Highlight the current feature
        this.highlightFeature(hit.leafletLayer, hit.layerColor);

        // Flag that the next popupclose is from cycling, not user dismissal
        this._cyclingPopup = true;
        const popup = L.popup({ maxWidth: 350, maxHeight: 400, closeOnClick: false })
            .setLatLng(this._popupLatLng)
            .setContent(html)
            .openOn(this.map);
        this._cyclingPopup = false;

        // Only clear hits when the user actually closes the popup (not during cycling)
        this.map.off('popupclose', this._onCyclePopupClose);
        this._onCyclePopupClose = () => {
            if (!this._cyclingPopup) {
                this.clearHighlight();
                this._popupHits = null;
            }
        };
        this.map.once('popupclose', this._onCyclePopupClose);
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
                // Do NOT remove rect here — the caller (spatial analyzer) will
                // display its own preview layer from the returned bbox.
                if (rect) { try { this.map.removeLayer(rect); } catch {} }
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

    // ============================
    // Import Fence
    // ============================

    /**
     * Draw a persistent import fence rectangle.
     * Returns [west, south, east, north] or null if cancelled.
     */
    startImportFenceDraw() {
        // Clear any existing fence first
        this.clearImportFence();

        return new Promise((resolve) => {
            this._cancelInteraction();

            const container = this.map.getContainer();
            container.style.cursor = 'crosshair';

            const banner = this._showInteractionBanner(
                'Click and drag to draw your import fence. Only features inside this area will be imported.',
                () => { cleanup(); resolve(null); }
            );

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
                        color: '#f59e0b', weight: 2, fillOpacity: 0.08,
                        dashArray: '8,5', className: 'import-fence-rect'
                    }).addTo(this.map);
                }
            };

            const onMouseUp = (e) => {
                if (!startLatLng) return;
                this.map.dragging.enable();
                const bounds = L.latLngBounds(startLatLng, e.latlng);

                // Store the persistent fence
                if (rect) {
                    rect.setStyle({ dashArray: '10,6', weight: 2.5 });
                    // Add a tooltip
                    rect.bindTooltip('Import Fence — only features in this area will be imported', {
                        permanent: false, direction: 'center', className: 'fence-tooltip'
                    });
                    this._importFence = { bounds, layer: rect };
                }

                cleanup(false); // don't remove rect
                resolve([
                    bounds.getWest(), bounds.getSouth(),
                    bounds.getEast(), bounds.getNorth()
                ]);
            };

            const onKeyDown = (e) => {
                if (e.key === 'Escape') {
                    this.map.dragging.enable();
                    if (rect) this.map.removeLayer(rect);
                    cleanup(true);
                    resolve(null);
                }
            };

            const cleanup = (removeRect = true) => {
                container.style.cursor = '';
                this.map.off('mousedown', onMouseDown);
                this.map.off('mousemove', onMouseMove);
                this.map.off('mouseup', onMouseUp);
                document.removeEventListener('keydown', onKeyDown);
                if (removeRect && rect) {
                    this.map.removeLayer(rect);
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

    /** Remove the import fence from the map */
    clearImportFence() {
        if (this._importFence) {
            if (this._importFence.layer) {
                this.map.removeLayer(this._importFence.layer);
            }
            this._importFence = null;
            bus.emit('importFence:cleared');
        }
    }

    /** Get the current fence bounds as [west, south, east, north] or null */
    getImportFenceBbox() {
        if (!this._importFence) return null;
        const b = this._importFence.bounds;
        return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    }

    /** Get the fence as an Esri envelope object for ArcGIS REST queries */
    getImportFenceEsriEnvelope() {
        if (!this._importFence) return null;
        const b = this._importFence.bounds;
        return {
            xmin: b.getWest(), ymin: b.getSouth(),
            xmax: b.getEast(), ymax: b.getNorth(),
            spatialReference: { wkid: 4326 }
        };
    }

    /** Check if an import fence is active */
    get hasImportFence() {
        return !!this._importFence;
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

    // ==========================================
    // Feature Selection System
    // ==========================================

    /** Selection highlight style */
    static get SELECTION_STYLE() {
        return {
            color: '#00e5ff',      // cyan
            weight: 3,
            opacity: 1,
            fillColor: '#00e5ff',
            fillOpacity: 0.35,
            dashArray: null
        };
    }
    static get SELECTION_POINT_STYLE() {
        return {
            radius: 8,
            fillColor: '#00e5ff',
            color: '#ffffff',
            weight: 3,
            fillOpacity: 1
        };
    }

    /**
     * Enable selection mode — clicking features selects them.
     * The mode stays active until `exitSelectionMode()` is called.
     */
    enterSelectionMode() {
        this._selectionMode = true;
        this.map.getContainer().style.cursor = 'pointer';
        const banner = this._showInteractionBanner(
            'Selection mode — click features or draw a box to miltiselect (Shift+click then drag).',
            () => this.exitSelectionMode()
        );
        this._selectionBanner = banner;

        // Allow rectangle-select: Shift+drag
        this._rectSelectHandler = this._setupRectangleSelect();

        bus.emit('selection:modeChanged', true);
        logger.info('Map', 'Selection mode enabled');
    }

    /** Exit selection mode (keeps current selection) */
    exitSelectionMode() {
        this._selectionMode = false;
        this.map.getContainer().style.cursor = '';
        if (this._selectionBanner) {
            this._selectionBanner.remove();
            this._selectionBanner = null;
        }
        if (this._rectSelectCleanup) {
            this._rectSelectCleanup();
            this._rectSelectCleanup = null;
        }
        bus.emit('selection:modeChanged', false);
        logger.info('Map', 'Selection mode disabled');
    }

    /** Is selection mode currently active? */
    isSelectionMode() { return this._selectionMode; }

    /**
     * Handle a feature click during selection mode.
     * Without shift: replace selection with this feature.
     * With shift: toggle this feature in/out of selection.
     */
    _handleSelectionClick(layerId, featureIndex, shiftKey, layerColor) {
        if (!this._selections.has(layerId)) {
            this._selections.set(layerId, new Set());
        }
        const sel = this._selections.get(layerId);

        if (shiftKey) {
            // Toggle individual feature
            if (sel.has(featureIndex)) {
                sel.delete(featureIndex);
            } else {
                sel.add(featureIndex);
            }
        } else {
            // Replace entire selection with just this feature
            // Clear selections on ALL layers first
            for (const lid of this._selections.keys()) {
                this._selections.set(lid, new Set());
                this._renderSelectionHighlights(lid);
            }
            this._selections.set(layerId, new Set([featureIndex]));
        }

        this._renderSelectionHighlights(layerId);
        bus.emit('selection:changed', {
            layerId,
            count: this.getSelectionCount(layerId),
            totalCount: this.getTotalSelectionCount()
        });
    }

    /**
     * Select features by rectangle (box select).
     * All features whose bounds intersect the rectangle are selected.
     */
    _setupRectangleSelect() {
        let startLatLng = null;
        let rect = null;
        let dragging = false;

        const onMouseDown = (e) => {
            if (!e.originalEvent.shiftKey && !e.originalEvent.ctrlKey) return; // Only shift/ctrl+drag
            startLatLng = e.latlng;
            dragging = true;
            this.map.dragging.disable();
        };

        const onMouseMove = (e) => {
            if (!dragging || !startLatLng) return;
            const bounds = L.latLngBounds(startLatLng, e.latlng);
            if (rect) {
                rect.setBounds(bounds);
            } else {
                rect = L.rectangle(bounds, {
                    color: '#00e5ff', weight: 2, fillOpacity: 0.1,
                    dashArray: '6,4'
                }).addTo(this.map);
            }
        };

        const onMouseUp = (e) => {
            if (!dragging || !startLatLng) return;
            this.map.dragging.enable();
            dragging = false;
            const bounds = L.latLngBounds(startLatLng, e.latlng);
            startLatLng = null;

            // Only act on meaningful rectangles (not accidental clicks)
            const size = this.map.latLngToContainerPoint(bounds.getNorthEast())
                .distanceTo(this.map.latLngToContainerPoint(bounds.getSouthWest()));
            if (size < 10) {
                if (rect) { this.map.removeLayer(rect); rect = null; }
                return;
            }

            // Find features within bounds
            const addToExisting = e.originalEvent?.shiftKey;
            this._selectFeaturesInBounds(bounds, addToExisting);

            // Remove rectangle after brief flash
            if (rect) {
                setTimeout(() => { try { this.map.removeLayer(rect); } catch (_) {} rect = null; }, 400);
            }
        };

        this.map.on('mousedown', onMouseDown);
        this.map.on('mousemove', onMouseMove);
        this.map.on('mouseup', onMouseUp);

        this._rectSelectCleanup = () => {
            this.map.off('mousedown', onMouseDown);
            this.map.off('mousemove', onMouseMove);
            this.map.off('mouseup', onMouseUp);
            if (rect) { try { this.map.removeLayer(rect); } catch (_) {} }
            this.map.dragging.enable();
        };
    }

    /**
     * Select all features from all visible layers that fall within the given bounds.
     */
    _selectFeaturesInBounds(bounds, addToExisting) {
        if (!addToExisting) {
            // Clear all existing selections
            for (const lid of this._selections.keys()) {
                this._selections.set(lid, new Set());
            }
        }

        for (const [layerId, leafletLayer] of this.dataLayers) {
            if (!this.map.hasLayer(leafletLayer)) continue; // skip hidden layers

            if (!this._selections.has(layerId)) {
                this._selections.set(layerId, new Set());
            }
            const sel = this._selections.get(layerId);

            leafletLayer.eachLayer((sub) => {
                const idx = sub._featureIndex;
                if (idx === undefined) return;
                // Check if feature intersects bounds
                let inside = false;
                if (sub.getLatLng) {
                    // Point feature
                    inside = bounds.contains(sub.getLatLng());
                } else if (sub.getBounds) {
                    inside = bounds.intersects(sub.getBounds());
                }
                if (inside) sel.add(idx);
            });

            this._renderSelectionHighlights(layerId);
        }

        const total = this.getTotalSelectionCount();
        bus.emit('selection:changed', { totalCount: total });
        if (total > 0) {
            logger.info('Map', `Box selected ${total} feature(s)`);
        }
    }

    /**
     * Render cyan highlight overlays for all selected features in a layer.
     */
    _renderSelectionHighlights(layerId) {
        // Remove previous highlight group
        if (this._selectionLayers.has(layerId)) {
            try { this.map.removeLayer(this._selectionLayers.get(layerId)); } catch (_) {}
            this._selectionLayers.delete(layerId);
        }

        const sel = this._selections.get(layerId);
        if (!sel || sel.size === 0) return;

        const leafletLayer = this.dataLayers.get(layerId);
        if (!leafletLayer) return;

        const group = L.layerGroup();
        leafletLayer.eachLayer((sub) => {
            if (sel.has(sub._featureIndex)) {
                // Create a highlight copy
                const feature = sub.feature;
                if (!feature?.geometry) return;
                const highlight = L.geoJSON(feature, {
                    style: () => MapManager.SELECTION_STYLE,
                    pointToLayer: (f, latlng) => L.circleMarker(latlng, MapManager.SELECTION_POINT_STYLE),
                    interactive: false
                });
                group.addLayer(highlight);
            }
        });

        group.addTo(this.map);
        this._selectionLayers.set(layerId, group);
    }

    /**
     * Get the selected feature indices for a specific layer.
     * Returns an array of indices (may be empty).
     */
    getSelectedIndices(layerId) {
        const sel = this._selections.get(layerId);
        return sel ? [...sel] : [];
    }

    /**
     * Get selected features as a GeoJSON FeatureCollection for a layer.
     * If nothing is selected, returns null (tools should use all features).
     */
    getSelectedFeatures(layerId, geojson) {
        const indices = this.getSelectedIndices(layerId);
        if (indices.length === 0) return null;
        const features = geojson.features.filter((_, i) => indices.includes(i));
        return { type: 'FeatureCollection', features };
    }

    /** Number of selected features in a specific layer */
    getSelectionCount(layerId) {
        return this._selections.get(layerId)?.size || 0;
    }

    /** Total selected features across all layers */
    getTotalSelectionCount() {
        let total = 0;
        for (const sel of this._selections.values()) total += sel.size;
        return total;
    }

    /**
     * Clear selection for a specific layer, or all layers if no id given.
     */
    clearSelection(layerId = null) {
        if (layerId) {
            this._selections.delete(layerId);
            if (this._selectionLayers.has(layerId)) {
                try { this.map.removeLayer(this._selectionLayers.get(layerId)); } catch (_) {}
                this._selectionLayers.delete(layerId);
            }
        } else {
            for (const [lid, group] of this._selectionLayers) {
                try { this.map.removeLayer(group); } catch (_) {}
            }
            this._selections.clear();
            this._selectionLayers.clear();
        }
        bus.emit('selection:changed', { layerId, totalCount: this.getTotalSelectionCount() });
    }

    /**
     * Select specific feature indices programmatically.
     */
    selectFeatures(layerId, indices) {
        this._selections.set(layerId, new Set(indices));
        this._renderSelectionHighlights(layerId);
        bus.emit('selection:changed', {
            layerId,
            count: indices.length,
            totalCount: this.getTotalSelectionCount()
        });
    }

    /**
     * Select all features in a layer.
     */
    selectAll(layerId, geojson) {
        const indices = geojson.features.map((_, i) => i);
        this.selectFeatures(layerId, indices);
    }

    /**
     * Invert selection for a layer.
     */
    invertSelection(layerId, geojson) {
        const current = this._selections.get(layerId) || new Set();
        const inverted = geojson.features.map((_, i) => i).filter(i => !current.has(i));
        this.selectFeatures(layerId, inverted);
    }

    destroy() {
        this._cancelInteraction();
        this.clearSelection();
        if (this._selectionMode) this.exitSelectionMode();
        if (this.map) {
            this.map.remove();
            this.map = null;
        }
        this.dataLayers.clear();
    }

    // ============================
    // Coordinate Search Control
    // ============================
    _initCoordSearch() {
        this._searchMarker = null;
        this._searchLatLng = null;

        const SearchControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: () => {
                const container = L.DomUtil.create('div', 'leaflet-bar coord-search-control');
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.disableScrollPropagation(container);

                // Toggle button
                const btn = L.DomUtil.create('a', 'coord-search-toggle', container);
                btn.href = '#';
                btn.title = 'Search Coordinates';
                btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

                // Expandable input area
                const panel = L.DomUtil.create('div', 'coord-search-panel', container);
                panel.style.display = 'none';

                const input = L.DomUtil.create('input', 'coord-search-input', panel);
                input.type = 'text';
                input.placeholder = 'Enter coordinates…';
                input.autocomplete = 'off';

                const goBtn = L.DomUtil.create('button', 'coord-search-go', panel);
                goBtn.innerHTML = '→';
                goBtn.title = 'Search';

                const clearBtn = L.DomUtil.create('button', 'coord-search-clear', panel);
                clearBtn.innerHTML = '✕';
                clearBtn.title = 'Clear & close';
                clearBtn.style.display = 'none';

                btn.onclick = (e) => {
                    e.preventDefault();
                    const open = panel.style.display !== 'none';
                    panel.style.display = open ? 'none' : 'flex';
                    if (!open) setTimeout(() => input.focus(), 50);
                };

                const doSearch = () => {
                    const val = input.value.trim();
                    if (!val) return;
                    const result = this._parseCoordinates(val);
                    if (result) {
                        this._placeSearchMarker(result.lat, result.lng, val, result.format);
                        clearBtn.style.display = '';
                        input.blur();
                    } else {
                        input.style.outline = '2px solid #e74c3c';
                        setTimeout(() => input.style.outline = '', 1200);
                    }
                };

                goBtn.onclick = doSearch;
                input.onkeydown = (e) => {
                    if (e.key === 'Enter') doSearch();
                    if (e.key === 'Escape') {
                        panel.style.display = 'none';
                    }
                };

                clearBtn.onclick = () => {
                    this._clearSearchMarker();
                    input.value = '';
                    clearBtn.style.display = 'none';
                    panel.style.display = 'none';
                };

                return container;
            }
        });

        new SearchControl().addTo(this.map);
    }

    /**
     * Parse coordinates in many common formats.
     * Returns { lat, lng, format } or null.
     */
    _parseCoordinates(input) {
        const s = input.trim();

        // 1) Decimal Degrees: "40.446195, -79.948862" or "40.446195 -79.948862"
        const ddMatch = s.match(/^([+-]?\d+\.?\d*)[,\s]+([+-]?\d+\.?\d*)$/);
        if (ddMatch) {
            const a = parseFloat(ddMatch[1]), b = parseFloat(ddMatch[2]);
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b, format: 'DD' };
            if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lng: a, format: 'DD' };
        }

        // 2) DMS: 40°26'46.3"N 79°56'55.5"W  or  40° 26' 46.3" N, 79° 56' 55.5" W
        const dmsRegex = /(\d+)[°]\s*(\d+)[′']\s*(\d+\.?\d*)[″"]\s*([NSEW])/gi;
        const dmsMatches = [...s.matchAll(dmsRegex)];
        if (dmsMatches.length >= 2) {
            const parse = (m) => {
                let dd = parseInt(m[1]) + parseInt(m[2]) / 60 + parseFloat(m[3]) / 3600;
                if (m[4].toUpperCase() === 'S' || m[4].toUpperCase() === 'W') dd = -dd;
                return dd;
            };
            const v1 = parse(dmsMatches[0]), v2 = parse(dmsMatches[1]);
            const d1 = dmsMatches[0][4].toUpperCase(), d2 = dmsMatches[1][4].toUpperCase();
            const lat = (d1 === 'N' || d1 === 'S') ? v1 : v2;
            const lng = (d1 === 'E' || d1 === 'W') ? v1 : v2;
            if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, format: 'DMS' };
        }

        // 3) DMS without symbols: "40 26 46.3 N 79 56 55.5 W"
        const dmsPlain = /(-?\d+)\s+(\d+)\s+(\d+\.?\d*)\s*([NSEW])[,\s]+(-?\d+)\s+(\d+)\s+(\d+\.?\d*)\s*([NSEW])/i;
        const dpMatch = s.match(dmsPlain);
        if (dpMatch) {
            let lat = parseInt(dpMatch[1]) + parseInt(dpMatch[2]) / 60 + parseFloat(dpMatch[3]) / 3600;
            if (dpMatch[4].toUpperCase() === 'S') lat = -lat;
            let lng = parseInt(dpMatch[5]) + parseInt(dpMatch[6]) / 60 + parseFloat(dpMatch[7]) / 3600;
            if (dpMatch[8].toUpperCase() === 'W') lng = -lng;
            if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, format: 'DMS' };
        }

        // 4) Degrees + Decimal Minutes: 40°26.772'N 79°56.925'W
        const ddmRegex = /(\d+)[°]\s*(\d+\.?\d*)[′']\s*([NSEW])/gi;
        const ddmMatches = [...s.matchAll(ddmRegex)];
        if (ddmMatches.length >= 2) {
            const parse = (m) => {
                let dd = parseInt(m[1]) + parseFloat(m[2]) / 60;
                if (m[3].toUpperCase() === 'S' || m[3].toUpperCase() === 'W') dd = -dd;
                return dd;
            };
            const v1 = parse(ddmMatches[0]), v2 = parse(ddmMatches[1]);
            const d1 = ddmMatches[0][3].toUpperCase(), d2 = ddmMatches[1][3].toUpperCase();
            const lat = (d1 === 'N' || d1 === 'S') ? v1 : v2;
            const lng = (d1 === 'E' || d1 === 'W') ? v1 : v2;
            if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, format: 'DDM' };
        }

        // 5) Google Maps URL: @40.446195,-79.948862,15z
        const gUrlMatch = s.match(/@([+-]?\d+\.?\d*),([+-]?\d+\.?\d*)/);
        if (gUrlMatch) {
            const lat = parseFloat(gUrlMatch[1]), lng = parseFloat(gUrlMatch[2]);
            if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, format: 'URL' };
        }

        return null;
    }

    _placeSearchMarker(lat, lng, inputText, format) {
        this._clearSearchMarker();
        this._searchLatLng = { lat, lng, inputText, format };

        const icon = L.divIcon({
            className: 'coord-search-marker',
            html: `<div class="coord-pin"><svg viewBox="0 0 24 36" width="28" height="42"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24C24 5.4 18.6 0 12 0z" fill="#e74c3c" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="11" r="4.5" fill="#fff"/></svg></div>`,
            iconSize: [28, 42],
            iconAnchor: [14, 42],
            popupAnchor: [0, -42]
        });

        this._searchMarker = L.marker([lat, lng], { icon }).addTo(this.map);

        const popupHtml = this._buildSearchPopup(lat, lng, format);
        this._searchMarker.bindPopup(popupHtml, { maxWidth: 280, className: 'coord-search-popup' }).openPopup();

        this.map.setView([lat, lng], Math.max(this.map.getZoom(), 14));
    }

    _buildSearchPopup(lat, lng, format) {
        return `
            <div class="coord-popup-content">
                <div style="font-weight:600;margin-bottom:4px;">📍 ${format} Coordinate</div>
                <div style="font-size:12px;color:#666;margin-bottom:8px;font-family:monospace;">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <button class="coord-popup-btn coord-add-new" onclick="window.app._coordSearchAddNew()">
                        ＋ Add as New Layer
                    </button>
                    <button class="coord-popup-btn coord-add-existing" onclick="window.app._coordSearchAddToExisting()">
                        ↳ Add to Existing Layer
                    </button>
                    <button class="coord-popup-btn coord-dismiss" onclick="window.app._coordSearchClear()">
                        ✕ Dismiss
                    </button>
                </div>
            </div>`;
    }

    _clearSearchMarker() {
        if (this._searchMarker) {
            this.map.removeLayer(this._searchMarker);
            this._searchMarker = null;
        }
        this._searchLatLng = null;
    }

    getSearchLatLng() {
        return this._searchLatLng;
    }
}

export const mapManager = new MapManager();
export default mapManager;
