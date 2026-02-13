/**
 * AGOL Compatibility mode
 * Sanitizes field names, types, geometry for ArcGIS Online upload
 */
import logger from '../core/logger.js';

const MAX_FIELD_LENGTH = 64;
const RESERVED_NAMES = new Set([
    'OBJECTID', 'FID', 'SHAPE', 'SHAPE_LENGTH', 'SHAPE_AREA',
    'GLOBALID', 'GDB_GEOMATTR_DATA'
]);

/**
 * Run AGOL compatibility checks and return issues + fixes
 */
export function checkAGOLCompatibility(dataset) {
    const issues = [];
    const fixes = [];
    const schema = dataset.schema;

    // 1. Field name checks
    const nameMapping = {};
    const usedNames = new Set();

    for (const field of schema.fields) {
        const original = field.outputName || field.name;
        let sanitized = sanitizeFieldName(original);

        // Check length
        if (sanitized.length > MAX_FIELD_LENGTH) {
            sanitized = sanitized.slice(0, MAX_FIELD_LENGTH);
            issues.push({ type: 'field_truncated', field: original, fixed: sanitized });
        }

        // Check reserved
        if (RESERVED_NAMES.has(sanitized.toUpperCase())) {
            sanitized = sanitized + '_1';
            issues.push({ type: 'reserved_name', field: original, fixed: sanitized });
        }

        // Deduplicate
        let finalName = sanitized;
        let counter = 1;
        while (usedNames.has(finalName.toUpperCase())) {
            finalName = `${sanitized.slice(0, MAX_FIELD_LENGTH - 3)}_${counter}`;
            counter++;
        }
        if (finalName !== sanitized) {
            issues.push({ type: 'duplicate_name', field: original, fixed: finalName });
        }

        usedNames.add(finalName.toUpperCase());
        if (finalName !== original) {
            nameMapping[original] = finalName;
        }
    }

    // 2. Check for nested objects/arrays in properties
    if (dataset.type === 'spatial') {
        const sample = (dataset.geojson?.features || []).slice(0, 100);
        for (const f of sample) {
            for (const [k, v] of Object.entries(f.properties || {})) {
                if (v != null && typeof v === 'object') {
                    if (!issues.some(i => i.type === 'nested_object' && i.field === k)) {
                        issues.push({ type: 'nested_object', field: k, message: 'Contains nested object/array — will be stringified' });
                        fixes.push({ type: 'stringify', field: k });
                    }
                }
            }
        }
    }

    // 3. Check for null geometries
    if (dataset.type === 'spatial') {
        const nullGeomCount = (dataset.geojson?.features || []).filter(f => !f.geometry).length;
        if (nullGeomCount > 0) {
            issues.push({ type: 'null_geometry', count: nullGeomCount, message: `${nullGeomCount} features have no geometry` });
            fixes.push({ type: 'remove_null_geometry' });
        }
    }

    // 4. Check for invalid coordinates
    if (dataset.type === 'spatial') {
        let invalidCoordCount = 0;
        for (const f of (dataset.geojson?.features || []).slice(0, 1000)) {
            if (f.geometry?.type === 'Point') {
                const [lon, lat] = f.geometry.coordinates || [];
                if (isNaN(lon) || isNaN(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                    invalidCoordCount++;
                }
            }
        }
        if (invalidCoordCount > 0) {
            issues.push({ type: 'invalid_coords', count: invalidCoordCount });
        }
    }

    logger.info('AGOL', 'Compatibility check', { issues: issues.length, nameChanges: Object.keys(nameMapping).length });

    return { issues, fixes, nameMapping };
}

/**
 * Apply AGOL fixes to dataset
 */
export function applyAGOLFixes(dataset, nameMapping = {}) {
    logger.info('AGOL', 'Applying fixes', { mappings: Object.keys(nameMapping).length });

    if (dataset.type === 'spatial') {
        const features = dataset.geojson.features.map(f => {
            const props = {};
            for (const [k, v] of Object.entries(f.properties || {})) {
                const newName = nameMapping[k] || sanitizeFieldName(k);
                let newVal = v;

                // Stringify nested objects
                if (v != null && typeof v === 'object') {
                    newVal = JSON.stringify(v);
                }

                // Normalize booleans
                if (typeof v === 'boolean') {
                    newVal = v ? 1 : 0;
                }

                props[newName] = newVal;
            }
            return { ...f, properties: props };
        }).filter(f => f.geometry != null); // Remove null geometries

        return {
            ...dataset,
            geojson: { type: 'FeatureCollection', features }
        };
    }

    return dataset;
}

function sanitizeFieldName(name) {
    let sanitized = name
        .replace(/[^a-zA-Z0-9_]/g, '_')  // Replace non-alphanumeric
        .replace(/^[^a-zA-Z]/, 'F$&')     // Ensure starts with letter
        .replace(/_+/g, '_')               // Collapse underscores
        .replace(/_$/, '');                 // Remove trailing underscore

    if (!sanitized) sanitized = 'Field';
    return sanitized;
}

export default { checkAGOLCompatibility, applyAGOLFixes };
