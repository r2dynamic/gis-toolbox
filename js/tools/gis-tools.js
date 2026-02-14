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

// ============================
// Measurement Tools
// ============================

/**
 * Get a point at a specified distance along a line
 */
export function pointAlong(lineFeature, distance, units = 'kilometers') {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.along(lineFeature, distance, { units });
}

/**
 * Calculate bearing between two points (in degrees, -180 to 180)
 */
export function bearing(point1, point2) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.bearing(point1, point2);
}

/**
 * Calculate destination point given start, distance, and bearing
 */
export function destination(origin, distance, bearingAngle, units = 'kilometers') {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.destination(origin, distance, bearingAngle, { units });
}

/**
 * Calculate distance between two points
 */
export function distance(point1, point2, units = 'kilometers') {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.distance(point1, point2, { units });
}

/**
 * Calculate shortest distance from a point to a line
 */
export function pointToLineDistance(point, line, units = 'kilometers') {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.pointToLineDistance(point, line, { units });
}

// ============================
// Transformation Tools
// ============================

/**
 * Clip features to a bounding box
 */
export async function bboxClipFeatures(dataset, bbox) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    const task = new TaskRunner('BBox Clip', 'GISTools');
    return task.run(async (t) => {
        const features = dataset.geojson.features;
        const clipped = [];
        for (let i = 0; i < features.length; i++) {
            t.throwIfCancelled();
            if (i % 100 === 0) {
                t.updateProgress(Math.round((i / features.length) * 90), `Clipping ${i}/${features.length}`);
                await new Promise(r => setTimeout(r, 0));
            }
            if (!features[i].geometry) continue;
            try {
                const c = turf.bboxClip(features[i], bbox);
                if (c && c.geometry && c.geometry.coordinates && c.geometry.coordinates.length > 0) {
                    c.properties = { ...features[i].properties };
                    clipped.push(c);
                }
            } catch (e) {
                logger.warn('GISTools', 'bboxClip failed for feature', { index: i, error: e.message });
            }
        }
        const fc = { type: 'FeatureCollection', features: clipped };
        return createSpatialDataset(`${dataset.name}_bboxclip`, fc, { format: 'derived' });
    });
}

/**
 * Smooth lines into bezier splines
 */
export async function bezierSplineFeatures(dataset, resolution = 10000, sharpness = 0.85) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    const task = new TaskRunner('Bezier Spline', 'GISTools');
    return task.run(async (t) => {
        const features = dataset.geojson.features;
        const smoothed = [];
        for (let i = 0; i < features.length; i++) {
            t.throwIfCancelled();
            if (i % 50 === 0) {
                t.updateProgress(Math.round((i / features.length) * 90), `Smoothing ${i}/${features.length}`);
                await new Promise(r => setTimeout(r, 0));
            }
            const f = features[i];
            if (!f.geometry) continue;
            if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
                try {
                    const lines = f.geometry.type === 'MultiLineString'
                        ? f.geometry.coordinates.map(c => turf.lineString(c))
                        : [f];
                    for (const line of lines) {
                        const spline = turf.bezierSpline(line, { resolution, sharpness });
                        if (spline) {
                            spline.properties = { ...f.properties };
                            smoothed.push(spline);
                        }
                    }
                } catch (e) {
                    logger.warn('GISTools', 'bezierSpline failed', { index: i, error: e.message });
                    smoothed.push(f); // keep original
                }
            } else {
                smoothed.push(f); // non-line features pass through
            }
        }
        const fc = { type: 'FeatureCollection', features: smoothed };
        return createSpatialDataset(`${dataset.name}_spline`, fc, { format: 'derived' });
    });
}

/**
 * Smooth polygon edges
 */
export async function polygonSmoothFeatures(dataset, iterations = 1) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    const task = new TaskRunner('Polygon Smooth', 'GISTools');
    return task.run(async (t) => {
        t.updateProgress(30, 'Smoothing polygons...');
        const smoothed = turf.polygonSmooth(dataset.geojson, { iterations });
        return createSpatialDataset(`${dataset.name}_smooth`, smoothed, { format: 'derived' });
    });
}

/**
 * Offset a line by a specified distance (creates a parallel line)
 */
export async function lineOffsetFeatures(dataset, offsetDistance, units = 'kilometers') {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    const task = new TaskRunner('Line Offset', 'GISTools');
    return task.run(async (t) => {
        const features = dataset.geojson.features;
        const results = [];
        for (let i = 0; i < features.length; i++) {
            t.throwIfCancelled();
            if (i % 100 === 0) {
                t.updateProgress(Math.round((i / features.length) * 90), `Offsetting ${i}/${features.length}`);
                await new Promise(r => setTimeout(r, 0));
            }
            const f = features[i];
            if (!f.geometry) continue;
            if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
                try {
                    const offset = turf.lineOffset(f, offsetDistance, { units });
                    if (offset) {
                        offset.properties = { ...f.properties };
                        results.push(offset);
                    }
                } catch (e) {
                    logger.warn('GISTools', 'lineOffset failed', { index: i, error: e.message });
                    results.push(f);
                }
            } else {
                results.push(f);
            }
        }
        const fc = { type: 'FeatureCollection', features: results };
        return createSpatialDataset(`${dataset.name}_offset`, fc, { format: 'derived' });
    });
}

/**
 * Slice a line at start/stop distances along it
 */
export function lineSliceAlong(lineFeature, startDist, stopDist, units = 'kilometers') {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.lineSliceAlong(lineFeature, startDist, stopDist, { units });
}

/**
 * Slice a line between two points (nearest vertices)
 */
export function lineSlice(startPoint, stopPoint, lineFeature) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.lineSlice(startPoint, stopPoint, lineFeature);
}

/**
 * Create a sector (pie slice) polygon from center, radius, and two bearings
 */
export function createSector(center, radius, bearing1, bearing2, units = 'kilometers', steps = 64) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.sector(center, radius, bearing1, bearing2, { units, steps });
}

// ============================
// Analysis / Classification
// ============================

/**
 * Find intersection points where two line layers cross
 */
export function lineIntersect(line1, line2) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.lineIntersect(line1, line2);
}

/**
 * Find self-intersections (kinks) in a polygon or line dataset
 */
export async function findKinks(dataset) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    const task = new TaskRunner('Find Kinks', 'GISTools');
    return task.run(async (t) => {
        const features = dataset.geojson.features;
        const allKinks = [];
        for (let i = 0; i < features.length; i++) {
            t.throwIfCancelled();
            if (i % 100 === 0) {
                t.updateProgress(Math.round((i / features.length) * 90), `Checking ${i}/${features.length}`);
                await new Promise(r => setTimeout(r, 0));
            }
            const f = features[i];
            if (!f.geometry) continue;
            try {
                const kinks = turf.kinks(f);
                if (kinks && kinks.features && kinks.features.length > 0) {
                    kinks.features.forEach(k => {
                        k.properties = {
                            sourceIndex: i,
                            sourceName: f.properties?.name || f.properties?.NAME || `Feature ${i}`,
                            ...k.properties
                        };
                        allKinks.push(k);
                    });
                }
            } catch (e) {
                logger.warn('GISTools', 'kinks check failed', { index: i, error: e.message });
            }
        }
        const fc = { type: 'FeatureCollection', features: allKinks };
        logger.info('GISTools', `Found ${allKinks.length} self-intersections`);
        return createSpatialDataset(`${dataset.name}_kinks`, fc, { format: 'derived' });
    });
}

/**
 * Combine: merge features into multi-geometry types
 */
export function combineFeatures(dataset) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    const combined = turf.combine(dataset.geojson);
    return createSpatialDataset(`${dataset.name}_combined`, combined, { format: 'derived' });
}

/**
 * Union: merge multiple polygons into one polygon
 */
export async function unionFeatures(dataset) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    const task = new TaskRunner('Union', 'GISTools');
    return task.run(async (t) => {
        const polygons = dataset.geojson.features.filter(f =>
            f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
        );
        if (polygons.length === 0) throw new Error('No polygon features to union');
        if (polygons.length === 1) {
            return createSpatialDataset(`${dataset.name}_union`, {
                type: 'FeatureCollection', features: [polygons[0]]
            }, { format: 'derived' });
        }

        t.updateProgress(10, `Merging ${polygons.length} polygons...`);
        let result = polygons[0];
        for (let i = 1; i < polygons.length; i++) {
            t.throwIfCancelled();
            if (i % 20 === 0) {
                t.updateProgress(Math.round((i / polygons.length) * 90), `Merging ${i}/${polygons.length}`);
                await new Promise(r => setTimeout(r, 0));
            }
            try {
                const merged = turf.union(turf.featureCollection([result, polygons[i]]));
                if (merged) result = merged;
            } catch (e) {
                logger.warn('GISTools', `Union skipped feature ${i}`, { error: e.message });
            }
        }

        const fc = { type: 'FeatureCollection', features: [result] };
        return createSpatialDataset(`${dataset.name}_union`, fc, { format: 'derived' });
    });
}

/**
 * Find the nearest point in a point dataset to a reference point
 */
export function nearestPoint(targetPoint, pointsDataset) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.nearestPoint(targetPoint, pointsDataset.geojson);
}

/**
 * Find the nearest point on a line to a given point
 */
export function nearestPointOnLine(lineFeature, point, units = 'kilometers') {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.nearestPointOnLine(lineFeature, point, { units });
}

/**
 * Find the nearest point feature to a line
 */
export function nearestPointToLine(pointsFC, lineFeature, units = 'kilometers') {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    return turf.nearestPointToLine(pointsFC, lineFeature, { units });
}

/**
 * Nearest neighbor analysis on a point dataset
 * Returns statistical measures of point distribution
 */
export function nearestNeighborAnalysis(dataset) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    const pointFeatures = dataset.geojson.features.filter(f =>
        f.geometry && f.geometry.type === 'Point'
    );
    if (pointFeatures.length < 3) throw new Error('Need at least 3 point features for nearest neighbor analysis');
    const fc = { type: 'FeatureCollection', features: pointFeatures };
    return turf.nearestNeighborAnalysis(fc);
}

/**
 * Find all points within polygon(s)
 */
export function pointsWithinPolygon(pointsDataset, polygonsDataset) {
    if (typeof turf === 'undefined') throw new Error('Turf.js not loaded');
    const points = pointsDataset.geojson;
    const polygons = polygonsDataset.geojson;
    const result = turf.pointsWithinPolygon(points, polygons);
    return createSpatialDataset(
        `${pointsDataset.name}_within_${polygonsDataset.name}`,
        result,
        { format: 'derived' }
    );
}

export default {
    bufferFeatures, simplifyFeatures, clipFeatures, dissolveFeatures,
    pointAlong, bearing, destination, distance, pointToLineDistance,
    bboxClipFeatures, bezierSplineFeatures, polygonSmoothFeatures,
    lineOffsetFeatures, lineSliceAlong, lineSlice, createSector,
    lineIntersect, findKinks, combineFeatures, unionFeatures,
    nearestPoint, nearestPointOnLine, nearestPointToLine,
    nearestNeighborAnalysis, pointsWithinPolygon
};
