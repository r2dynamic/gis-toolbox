/**
 * Generic JSON importer — detects GeoJSON vs plain table
 */
import { createSpatialDataset, createTableDataset } from '../core/data-model.js';
import { AppError, ErrorCategory } from '../core/error-handler.js';
import { importGeoJSON } from './geojson-importer.js';

export async function importJSON(file, task) {
    task.updateProgress(20, 'Parsing JSON...');
    const text = await file.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new AppError('Invalid JSON', ErrorCategory.PARSE_FAILED, { file: file.name });
    }

    task.updateProgress(50, 'Detecting format...');

    // Check if it's GeoJSON
    if (data.type === 'FeatureCollection' || data.type === 'Feature' ||
        (data.type && data.coordinates)) {
        return importGeoJSON(file, task);
    }

    // Check for ArcGIS REST-style response
    if (data.features && Array.isArray(data.features) && data.features[0]?.attributes) {
        const features = data.features.map(f => ({
            type: 'Feature',
            geometry: convertEsriGeometry(f.geometry),
            properties: f.attributes || {}
        }));
        const fc = { type: 'FeatureCollection', features };
        return createSpatialDataset(
            file.name.replace(/\.json$/i, ''),
            fc,
            { file: file.name, format: 'json-esri' }
        );
    }

    // Array of objects → table
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
        task.updateProgress(70, 'Creating table dataset...');
        return createTableDataset(
            file.name.replace(/\.json$/i, ''),
            data,
            null,
            { file: file.name, format: 'json-table' }
        );
    }

    // Object with a data/records/results array
    for (const key of ['data', 'records', 'results', 'rows', 'items']) {
        if (Array.isArray(data[key]) && data[key].length > 0 && typeof data[key][0] === 'object') {
            return createTableDataset(
                file.name.replace(/\.json$/i, ''),
                data[key],
                null,
                { file: file.name, format: 'json-table' }
            );
        }
    }

    throw new AppError(
        'Could not detect a table or GeoJSON structure in this JSON file',
        ErrorCategory.PARSE_FAILED,
        { file: file.name }
    );
}

function convertEsriGeometry(geom) {
    if (!geom) return null;
    if (geom.x != null && geom.y != null) {
        return { type: 'Point', coordinates: [geom.x, geom.y] };
    }
    if (geom.rings) {
        return {
            type: geom.rings.length === 1 ? 'Polygon' : 'MultiPolygon',
            coordinates: geom.rings.length === 1 ? geom.rings : geom.rings.map(r => [r])
        };
    }
    if (geom.paths) {
        return {
            type: geom.paths.length === 1 ? 'LineString' : 'MultiLineString',
            coordinates: geom.paths.length === 1 ? geom.paths[0] : geom.paths
        };
    }
    if (geom.points) {
        return { type: 'MultiPoint', coordinates: geom.points };
    }
    return null;
}
