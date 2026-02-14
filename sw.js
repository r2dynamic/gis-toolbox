// ============================================
// GIS Toolbox — Service Worker
// Bump CACHE_VERSION to push updates
// ============================================
const CACHE_VERSION = '1.8.0';
const CACHE_NAME = `gis-toolbox-v${CACHE_VERSION}`;

const APP_FILES = [
    './',
    './index.html',
    './manifest.json',
    './icon.svg',
    './icon-maskable.svg',
    './css/main.css',
    './css/mobile.css',
    './js/app.js',
    './js/agol/compatibility.js',
    './js/arcgis/rest-importer.js',
    './js/core/data-model.js',
    './js/core/error-handler.js',
    './js/core/event-bus.js',
    './js/core/logger.js',
    './js/core/state.js',
    './js/core/task-runner.js',
    './js/dataprep/template-builder.js',
    './js/dataprep/transform-history.js',
    './js/dataprep/transforms.js',
    './js/export/csv-exporter.js',
    './js/export/excel-exporter.js',
    './js/export/exporter.js',
    './js/export/geojson-exporter.js',
    './js/export/json-exporter.js',
    './js/export/kml-exporter.js',
    './js/export/kmz-exporter.js',
    './js/export/shapefile-exporter.js',
    './js/import/csv-importer.js',
    './js/import/excel-importer.js',
    './js/import/geojson-importer.js',
    './js/import/importer.js',
    './js/import/json-importer.js',
    './js/import/kml-importer.js',
    './js/import/kmz-importer.js',
    './js/import/shapefile-importer.js',
    './js/map/map-manager.js',
    './js/photo/photo-mapper.js',
    './js/tools/coordinates.js',
    './js/tools/gis-tools.js',
    './js/ui/modals.js',
    './js/ui/toast.js',
    './header_background.jpeg',
    './Side_Background.jpeg'
];

// CDN libraries — cached separately, rarely change
const CDN_FILES = [
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/papaparse@5.4.1/papaparse.min.js',
    'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
    'https://unpkg.com/@mapbox/togeojson@0.16.2/togeojson.js',
    'https://unpkg.com/@turf/turf@7.1.0/turf.min.js',
    'https://unpkg.com/shpjs@4.0.4/dist/shp.js',
    'https://unpkg.com/exifr@7.1.3/dist/full.umd.js'
];

// Install: cache all app + CDN files
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll([...APP_FILES, ...CDN_FILES]);
        }).then(() => {
            // Activate immediately instead of waiting
            return self.skipWaiting();
        })
    );
});

// Activate: delete old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys
                    .filter((key) => key.startsWith('gis-toolbox-v') && key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            );
        }).then(() => {
            // Take control of all open tabs immediately
            return self.clients.claim();
        })
    );
});

// Fetch: serve from cache, fall back to network
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((cached) => {
            return cached || fetch(event.request);
        })
    );
});
