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

    const baseName = file.name.replace(/\.zip$/i, '');

    // shpjs can return a single FeatureCollection or array of them
    if (Array.isArray(geojson)) {
        // Multiple layers in one zip — return ALL as separate datasets
        const datasets = geojson.filter(fc => fc && fc.type === 'FeatureCollection' && fc.features?.length > 0)
            .map((fc, i) => {
                fc.features = fc.features.map(f => ({
                    type: 'Feature',
                    geometry: f.geometry || null,
                    properties: f.properties || {}
                }));
                const layerName = fc.fileName
                    ? fc.fileName.replace(/\.\w+$/, '')
                    : (geojson.length > 1 ? `${baseName}_${i + 1}` : baseName);
                return createSpatialDataset(layerName, fc, { file: file.name, format: 'shapefile' });
            });
        if (datasets.length === 0) {
            throw new AppError('Shapefile ZIP contained no valid layers', ErrorCategory.PARSE_FAILED);
        }
        return datasets; // array of datasets
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
        baseName,
        geojson,
        { file: file.name, format: 'shapefile' }
    );
}
