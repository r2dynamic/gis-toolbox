/**
 * KML importer using toGeoJSON library
 * Preserves KML inline styles (stroke, fill, icon) as dataset._kmlStyle
 */
import { createSpatialDataset } from '../core/data-model.js';
import { AppError, ErrorCategory } from '../core/error-handler.js';

export async function importKML(file, task) {
    task.updateProgress(20, 'Reading KML...');

    let text;
    if (typeof file === 'string') {
        text = file; // Already text (from KMZ extraction)
    } else {
        text = await file.text();
    }

    task.updateProgress(50, 'Parsing KML to GeoJSON...');

    const parser = new DOMParser();
    const kmlDoc = parser.parseFromString(text, 'text/xml');

    const parseError = kmlDoc.querySelector('parsererror');
    if (parseError) {
        throw new AppError('Invalid KML/XML', ErrorCategory.PARSE_FAILED, {
            detail: parseError.textContent?.slice(0, 200)
        });
    }

    // Use toGeoJSON library (loaded via CDN)
    if (typeof toGeoJSON === 'undefined') {
        throw new AppError('toGeoJSON library not loaded', ErrorCategory.PARSE_FAILED);
    }

    let geojson;
    try {
        geojson = toGeoJSON.kml(kmlDoc);
    } catch (e) {
        throw new AppError('Failed to convert KML to GeoJSON: ' + e.message, ErrorCategory.PARSE_FAILED);
    }

    if (!geojson.features || geojson.features.length === 0) {
        throw new AppError('KML file contains no features', ErrorCategory.PARSE_FAILED);
    }

    task.updateProgress(80, 'Extracting styles...');

    // Extract KML styles — toGeoJSON puts them in feature properties
    const kmlStyle = _extractKmlStyle(geojson.features);

    task.updateProgress(90, 'Building dataset...');
    const name = typeof file === 'string' ? 'KML_Layer' : file.name.replace(/\.(kml|xml)$/i, '');
    const dataset = createSpatialDataset(name, geojson, {
        file: typeof file === 'string' ? 'extracted.kml' : file.name,
        format: 'kml'
    });

    // Attach extracted style so the app can apply it on addLayer
    if (kmlStyle) dataset._kmlStyle = kmlStyle;

    return dataset;
}

/**
 * Extract a unified style object from KML feature properties.
 * toGeoJSON puts KML style info into feature props: stroke, stroke-width,
 * stroke-opacity, fill, fill-opacity.
 */
function _extractKmlStyle(features) {
    let strokeColor = null, fillColor = null;
    let strokeWidth = null, strokeOpacity = null, fillOpacity = null;

    // Sample from first features that have style properties
    for (const f of features) {
        const p = f.properties || {};
        if (!strokeColor && p.stroke) strokeColor = p.stroke;
        if (!fillColor && p.fill) fillColor = p.fill;
        if (strokeWidth == null && p['stroke-width'] != null) strokeWidth = parseFloat(p['stroke-width']);
        if (strokeOpacity == null && p['stroke-opacity'] != null) strokeOpacity = parseFloat(p['stroke-opacity']);
        if (fillOpacity == null && p['fill-opacity'] != null) fillOpacity = parseFloat(p['fill-opacity']);
        // Once we have all properties, stop scanning
        if (strokeColor && fillColor && strokeWidth != null && strokeOpacity != null && fillOpacity != null) break;
    }

    // Only return if we found any style info
    if (!strokeColor && !fillColor && strokeWidth == null) return null;

    const style = {};
    if (strokeColor) style.strokeColor = strokeColor;
    if (fillColor) style.fillColor = fillColor;
    else if (strokeColor) style.fillColor = strokeColor;
    if (strokeWidth != null && !isNaN(strokeWidth)) style.strokeWidth = strokeWidth;
    if (strokeOpacity != null && !isNaN(strokeOpacity)) style.strokeOpacity = strokeOpacity;
    if (fillOpacity != null && !isNaN(fillOpacity)) style.fillOpacity = fillOpacity;

    return style;
}
