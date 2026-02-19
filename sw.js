// ============================================
// GIS Toolbox — Service Worker
// Bump CACHE_VERSION to push updates
// ============================================
const CACHE_VERSION = '1.19.17';
const CACHE_NAME = `gis-toolbox-v${CACHE_VERSION}`;

const APP_FILES = [
    './',
    './index.html',
    './manifest.json',

    // Styles
    './css/main.css',
    './css/mobile.css',

    // Icons
    './icons/favicon.png',
    './icons/PWAicon.png',
    './icons/TitleIcon.png',
    './icons/MobileAddButton.png',
    './icons/MobileMenuButton.png',

    // App entry
    './js/app.js',

    // Core
    './js/core/data-model.js',
    './js/core/error-handler.js',
    './js/core/event-bus.js',
    './js/core/logger.js',
    './js/core/session-store.js',
    './js/core/state.js',
    './js/core/task-runner.js',

    // Map
    './js/map/map-manager.js',
    './js/map/draw-manager.js',

    // UI
    './js/ui/modals.js',
    './js/ui/toast.js',

    // Import
    './js/import/importer.js',
    './js/import/csv-importer.js',
    './js/import/excel-importer.js',
    './js/import/geojson-importer.js',
    './js/import/json-importer.js',
    './js/import/kml-importer.js',
    './js/import/kmz-importer.js',
    './js/import/shapefile-importer.js',

    // Export
    './js/export/exporter.js',
    './js/export/csv-exporter.js',
    './js/export/excel-exporter.js',
    './js/export/geojson-exporter.js',
    './js/export/json-exporter.js',
    './js/export/kml-exporter.js',
    './js/export/kmz-exporter.js',
    './js/export/shapefile-exporter.js',

    // Data prep
    './js/dataprep/template-builder.js',
    './js/dataprep/transform-history.js',
    './js/dataprep/transforms.js',

    // Tools
    './js/tools/gis-tools.js',

    // Widgets
    './js/widgets/widget-base.js',
    './js/widgets/bulk-update.js',
    './js/widgets/proximity-join.js',
    './js/widgets/spatial-analyzer.js',

    // ArcGIS
    './js/arcgis/endpoints.js',
    './js/arcgis/rest-importer.js',

    // AGOL
    './js/agol/compatibility.js',

    // Photo
    './js/photo/photo-mapper.js'
];

// CDN libraries — versioned, rarely change
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
            return self.clients.claim();
        })
    );
});

// Fetch strategy:
//   CDN (versioned, immutable) → cache-first
//   App files → network-first (so code updates are immediate)
//   Everything else → network only
self.addEventListener('fetch', (event) => {
    const url = event.request.url;

    // CDN libraries — cache-first (they're versioned and never change)
    if (url.startsWith('https://unpkg.com/') || url.startsWith('https://cdn.sheetjs.com/')) {
        event.respondWith(
            caches.match(event.request).then((cached) => cached || fetch(event.request))
        );
        return;
    }

    // App files — network-first (always get latest, fall back to cache offline)
    if (url.startsWith(self.location.origin)) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    // Update the cache with the fresh copy
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // External requests (API calls, tiles, etc.) — network only, no caching
    event.respondWith(fetch(event.request));
});
