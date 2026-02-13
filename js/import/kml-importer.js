/**
 * KML importer using toGeoJSON library
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

    task.updateProgress(90, 'Building dataset...');
    const name = typeof file === 'string' ? 'KML_Layer' : file.name.replace(/\.(kml|xml)$/i, '');
    return createSpatialDataset(name, geojson, {
        file: typeof file === 'string' ? 'extracted.kml' : file.name,
        format: 'kml'
    });
}
