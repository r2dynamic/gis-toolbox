# GIS Toolbox

A frontend-only GIS + Data Prep web app. No backend, no build step, no Node.js required.

## Deploy to GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Under **Source**, select **Deploy from a branch**
4. Choose the **main** branch and **/ (root)** folder
5. Click **Save**

Your app will be live at `https://<username>.github.io/GIS-toolbox/` within a few minutes.

## Local Development

No build tools needed. Just open `index.html` in a browser, or use any static file server:

```
# Python
python -m http.server 8000

# Or just double-click index.html
```

> **Note:** Some features (file imports via drag & drop) work best when served over HTTP rather than `file://`.

## Features

- **Import**: GeoJSON, JSON, CSV/TSV, Excel (.xlsx/.xls), KML, KMZ, Shapefile (.zip)
- **Export**: GeoJSON, JSON, CSV, Excel, KML, KMZ (with embedded photos)
- **Map**: Leaflet with 4 keyless basemaps + no-basemap option
- **Data Prep**: Split, combine, replace/clean, type convert, filter, deduplicate, join, validate, add UID
- **Template Builder**: Combine fields with `{FieldName}` placeholders and smart cleanup
- **Photo Mapper**: EXIF GPS extraction, thumbnail generation, KMZ photo export
- **ArcGIS REST**: Public FeatureServer layer import with pagination
- **GIS Tools**: Buffer, simplify, clip (via Turf.js)
- **AGOL Compatibility**: Field name sanitization for ArcGIS Online
- **Coordinates**: DD ↔ DMS conversion, batch mode
- **Responsive**: Desktop 3-panel layout + mobile bottom-nav with tabs

## Tech Stack

- Vanilla JavaScript (ES modules, no framework)
- Vanilla CSS (no preprocessor)
- All libraries loaded from CDN (Leaflet, PapaParse, SheetJS, JSZip, toGeoJSON, Turf.js, shpjs, exifr)
- Zero dependencies to install
