/**
 * GeoJSON importer
 */
import { createSpatialDataset } from '../core/data-model.js';
import { AppError, ErrorCategory } from '../core/error-handler.js';

export async function importGeoJSON(file, task) {
    task.updateProgress(20, 'Parsing GeoJSON...');
    const text = await file.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new AppError('Invalid JSON in GeoJSON file', ErrorCategory.PARSE_FAILED, { file: file.name });
    }

    task.updateProgress(60, 'Normalizing...');

    // Handle different GeoJSON structures
    let fc;
    if (data.type === 'FeatureCollection') {
        fc = data;
    } else if (data.type === 'Feature') {
        fc = { type: 'FeatureCollection', features: [data] };
    } else if (data.type && data.coordinates) {
        // Bare geometry
        fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: data, properties: {} }] };
    } else {
        throw new AppError('Not a recognized GeoJSON structure', ErrorCategory.PARSE_FAILED, { file: file.name });
    }

    // Ensure all features have properties
    fc.features = fc.features.map((f, i) => ({
        type: 'Feature',
        geometry: f.geometry || null,
        properties: f.properties || {},
        ...((f.id != null) ? { id: f.id } : {})
    }));

    task.updateProgress(90, 'Building dataset...');
    return createSpatialDataset(
        file.name.replace(/\.(geo)?json$/i, ''),
        fc,
        { file: file.name, format: 'geojson' }
    );
}
