/**
 * GIS tools using Turf.js (client-side geospatial ops)
 */
import logger from '../core/logger.js';
import { createSpatialDataset } from '../core/data-model.js';
import { TaskRunner } from '../core/task-runner.js';

const LARGE_DATASET_WARNING = 50000;

/**
 * Buffer features by distance
 */
export async function bufferFeatures(dataset, distance, units = 'kilometers') {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    if (dataset.geojson.features.length > LARGE_DATASET_WARNING) {
        logger.warn('GISTools', 'Large dataset — buffer may be slow', { count: dataset.geojson.features.length });
    }

    const task = new TaskRunner(`Buffer ${distance} ${units}`, 'GISTools');
    return task.run(async (t) => {
        const features = dataset.geojson.features;
        const buffered = [];
        for (let i = 0; i < features.length; i++) {
            t.throwIfCancelled();
            if (i % 100 === 0) {
                t.updateProgress(Math.round((i / features.length) * 90), `Buffering ${i}/${features.length}`);
                await new Promise(r => setTimeout(r, 0));
            }
            if (features[i].geometry) {
                try {
                    const b = turf.buffer(features[i], distance, { units });
                    if (b) {
                        b.properties = { ...features[i].properties };
                        buffered.push(b);
                    }
                } catch (e) {
                    logger.warn('GISTools', 'Buffer failed for feature', { index: i, error: e.message });
                }
            }
        }
        const fc = { type: 'FeatureCollection', features: buffered };
        return createSpatialDataset(`${dataset.name}_buffer_${distance}${units}`, fc, { format: 'derived' });
    });
}

/**
 * Simplify geometries
 */
export async function simplifyFeatures(dataset, tolerance = 0.001) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');

    const task = new TaskRunner('Simplify', 'GISTools');
    return task.run(async (t) => {
        t.updateProgress(30, 'Simplifying geometries...');

        const verticesBefore = countVertices(dataset.geojson);
        const simplified = turf.simplify(dataset.geojson, { tolerance, highQuality: true });
        const verticesAfter = countVertices(simplified);

        logger.info('GISTools', 'Simplify complete', { verticesBefore, verticesAfter, reduction: `${Math.round((1 - verticesAfter / verticesBefore) * 100)}%` });

        return {
            dataset: createSpatialDataset(`${dataset.name}_simplified`, simplified, { format: 'derived' }),
            stats: { verticesBefore, verticesAfter }
        };
    });
}

/**
 * Clip features to a bounding box or polygon
 */
export async function clipFeatures(dataset, clipGeometry) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');

    const task = new TaskRunner('Clip', 'GISTools');
    return task.run(async (t) => {
        const features = dataset.geojson.features;
        const clipped = [];

        for (let i = 0; i < features.length; i++) {
            t.throwIfCancelled();
            if (i % 100 === 0) {
                t.updateProgress(Math.round((i / features.length) * 90), `Clipping ${i}/${features.length}`);
                await new Promise(r => setTimeout(r, 0));
            }

            const f = features[i];
            if (!f.geometry) continue;

            try {
                if (f.geometry.type === 'Point') {
                    if (turf.booleanPointInPolygon(f, clipGeometry)) {
                        clipped.push(f);
                    }
                } else {
                    const intersection = turf.intersect(
                        turf.featureCollection([turf.feature(clipGeometry), f])
                    );
                    if (intersection) {
                        intersection.properties = { ...f.properties };
                        clipped.push(intersection);
                    }
                }
            } catch (e) {
                // For complex geometries or errors, include if centroid is inside
                try {
                    const centroid = turf.centroid(f);
                    if (turf.booleanPointInPolygon(centroid, clipGeometry)) {
                        clipped.push(f);
                    }
                } catch (_) { }
            }
        }

        const fc = { type: 'FeatureCollection', features: clipped };
        return createSpatialDataset(`${dataset.name}_clipped`, fc, { format: 'derived' });
    });
}

/**
 * Dissolve by field
 */
export async function dissolveFeatures(dataset, field) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');

    const task = new TaskRunner('Dissolve', 'GISTools');
    return task.run(async (t) => {
        t.updateProgress(30, 'Dissolving...');
        const dissolved = turf.dissolve(dataset.geojson, { propertyName: field });
        return createSpatialDataset(`${dataset.name}_dissolved`, dissolved, { format: 'derived' });
    });
}

function countVertices(geojson) {
    let count = 0;
    const countCoords = (coords) => {
        if (typeof coords[0] === 'number') return 1;
        return coords.reduce((sum, c) => sum + countCoords(c), 0);
    };
    for (const f of (geojson.features || [])) {
        if (f.geometry?.coordinates) {
            count += countCoords(f.geometry.coordinates);
        }
    }
    return count;
}

export default { bufferFeatures, simplifyFeatures, clipFeatures, dissolveFeatures };
