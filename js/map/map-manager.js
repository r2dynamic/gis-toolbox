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
                layer.on('click', () => this.showPopup(feature, layer));
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

        // Show photo thumbnail if available
        if (props._thumbnailUrl) {
            imgHtml = `<div style="margin-bottom:6px;text-align:center;">
                <img src="${props._thumbnailUrl}" style="max-width:280px;max-height:200px;border-radius:4px;" />
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
        layer.bindPopup(html, { maxWidth: 350, maxHeight: 400 }).openPopup();
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

    destroy() {
        if (this.map) {
            this.map.remove();
            this.map = null;
        }
        this.dataLayers.clear();
    }
}

export const mapManager = new MapManager();
export default mapManager;
