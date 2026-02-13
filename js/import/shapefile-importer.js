/**
 * Shapefile importer (zipped .shp+.dbf+.shx)
 * Uses shpjs library
 */
import { createSpatialDataset } from '../core/data-model.js';
import { AppError, ErrorCategory } from '../core/error-handler.js';

export async function importShapefile(file, task) {
    task.updateProgress(10, 'Loading shapefile library...');

    if (typeof shp === 'undefined') {
        throw new AppError('Shapefile (shpjs) library not loaded', ErrorCategory.PARSE_FAILED);
    }

    task.updateProgress(20, 'Reading ZIP...');
    const buffer = await file.arrayBuffer();

    task.updateProgress(40, 'Parsing shapefile...');
    let geojson;
    try {
        geojson = await shp(buffer);
    } catch (e) {
        throw new AppError('Failed to parse shapefile: ' + e.message, ErrorCategory.PARSE_FAILED, {
            hint: 'Ensure the ZIP contains .shp, .dbf, and .shx files'
        });
    }

    task.updateProgress(80, 'Normalizing...');

    // shpjs can return a single FeatureCollection or array of them
    if (Array.isArray(geojson)) {
        // Multiple layers in one zip — use first
        geojson = geojson[0];
    }

    if (!geojson || geojson.type !== 'FeatureCollection') {
        throw new AppError('Shapefile produced invalid GeoJSON', ErrorCategory.PARSE_FAILED);
    }

    // Ensure properties exist
    geojson.features = geojson.features.map(f => ({
        type: 'Feature',
        geometry: f.geometry || null,
        properties: f.properties || {}
    }));

    return createSpatialDataset(
        file.name.replace(/\.zip$/i, ''),
        geojson,
        { file: file.name, format: 'shapefile' }
    );
}
