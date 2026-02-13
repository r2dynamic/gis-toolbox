/**
 * Canonical data model + schema metadata
 * All importers normalize into these forms
 */

/**
 * @typedef {Object} FieldMeta
 * @property {string} name
 * @property {string} type - 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'null'
 * @property {number} nullCount
 * @property {number} uniqueCount
 * @property {any[]} sampleValues
 * @property {number|null} min
 * @property {number|null} max
 * @property {boolean} selected - for export field selection
 * @property {string} outputName - for rename
 * @property {number} order
 */

/**
 * @typedef {Object} LayerSchema
 * @property {FieldMeta[]} fields
 * @property {string|null} geometryType - 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon' | 'GeometryCollection' | null
 * @property {number} featureCount
 * @property {string} crs - default 'EPSG:4326'
 */

/**
 * Create a canonical spatial dataset
 */
export function createSpatialDataset(name, geojson, source = {}) {
    const schema = analyzeSchema(geojson);
    return {
        id: generateId(),
        name,
        type: 'spatial',
        geojson, // FeatureCollection
        schema,
        source: { file: source.file || name, format: source.format || 'unknown', ...source },
        visible: true,
        active: true,
        created: new Date().toISOString()
    };
}

/**
 * Create a canonical table dataset (no geometry)
 */
export function createTableDataset(name, rows, fieldNames = null, source = {}) {
    const fields = fieldNames || (rows.length > 0 ? Object.keys(rows[0]) : []);
    const schema = analyzeTableSchema(rows, fields);
    return {
        id: generateId(),
        name,
        type: 'table',
        rows,
        schema,
        source: { file: source.file || name, format: source.format || 'unknown', ...source },
        visible: true,
        active: true,
        created: new Date().toISOString()
    };
}

/**
 * Convert a table dataset with lat/lon to a spatial dataset
 */
export function tableToSpatial(dataset, latField, lonField) {
    const features = dataset.rows.map(row => {
        const lat = parseFloat(row[latField]);
        const lon = parseFloat(row[lonField]);
        const props = { ...row };
        if (isNaN(lat) || isNaN(lon)) {
            return { type: 'Feature', geometry: null, properties: props };
        }
        return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: props
        };
    });
    const geojson = { type: 'FeatureCollection', features };
    return createSpatialDataset(dataset.name, geojson, dataset.source);
}

/**
 * Convert spatial dataset to table (drop geometry)
 */
export function spatialToTable(dataset) {
    const rows = dataset.geojson.features.map(f => ({ ...f.properties }));
    return createTableDataset(dataset.name, rows, null, dataset.source);
}

/**
 * Analyze GeoJSON FeatureCollection to produce schema
 */
export function analyzeSchema(geojson) {
    const features = geojson?.features || [];
    const fieldMap = new Map();
    const geomTypes = new Set();

    for (const f of features) {
        if (f.geometry?.type) geomTypes.add(f.geometry.type);
        const props = f.properties || {};
        for (const [key, val] of Object.entries(props)) {
            if (!fieldMap.has(key)) {
                fieldMap.set(key, { values: [], nulls: 0 });
            }
            const fm = fieldMap.get(key);
            if (val == null || val === '') {
                fm.nulls++;
            } else {
                fm.values.push(val);
            }
        }
    }

    const fields = [];
    let order = 0;
    for (const [name, data] of fieldMap) {
        const uniques = new Set(data.values.map(v => String(v)));
        const type = inferType(data.values);
        const numVals = type === 'number' ? data.values.map(Number).filter(n => !isNaN(n)) : [];
        fields.push({
            name,
            type,
            nullCount: data.nulls,
            uniqueCount: uniques.size,
            sampleValues: data.values.slice(0, 5),
            min: numVals.length ? Math.min(...numVals) : null,
            max: numVals.length ? Math.max(...numVals) : null,
            selected: true,
            outputName: name,
            order: order++
        });
    }

    const geometryType = geomTypes.size === 1 ? [...geomTypes][0] :
        geomTypes.size > 1 ? 'Mixed' : null;

    return {
        fields,
        geometryType,
        featureCount: features.length,
        crs: 'EPSG:4326'
    };
}

/**
 * Analyze table rows to produce schema
 */
export function analyzeTableSchema(rows, fieldNames) {
    const fields = fieldNames.map((name, order) => {
        const values = rows.map(r => r[name]).filter(v => v != null && v !== '');
        const nullCount = rows.length - values.length;
        const uniques = new Set(values.map(String));
        const type = inferType(values);
        const numVals = type === 'number' ? values.map(Number).filter(n => !isNaN(n)) : [];
        return {
            name,
            type,
            nullCount,
            uniqueCount: uniques.size,
            sampleValues: values.slice(0, 5),
            min: numVals.length ? Math.min(...numVals) : null,
            max: numVals.length ? Math.max(...numVals) : null,
            selected: true,
            outputName: name,
            order
        };
    });
    return { fields, geometryType: null, featureCount: rows.length, crs: null };
}

function inferType(values) {
    if (values.length === 0) return 'string';
    let numCount = 0, boolCount = 0, dateCount = 0;
    const sample = values.slice(0, 100);
    for (const v of sample) {
        if (typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)))) numCount++;
        if (typeof v === 'boolean' || v === 'true' || v === 'false') boolCount++;
        if (v instanceof Date || (typeof v === 'string' && !isNaN(Date.parse(v)) && v.length > 6)) dateCount++;
    }
    const threshold = sample.length * 0.7;
    if (numCount >= threshold) return 'number';
    if (boolCount >= threshold) return 'boolean';
    // Date detection can be noisy, require higher threshold
    if (dateCount >= sample.length * 0.9 && numCount < threshold) return 'date';
    return 'string';
}

function generateId() {
    return 'ds_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
}

/**
 * Get selected fields from schema
 */
export function getSelectedFields(schema) {
    return schema.fields.filter(f => f.selected).sort((a, b) => a.order - b.order);
}

/**
 * Apply field selection to features (returns new features with only selected fields, optionally renamed)
 */
export function applyFieldSelection(features, schema) {
    const selected = getSelectedFields(schema);
    return features.map(f => {
        const newProps = {};
        for (const field of selected) {
            newProps[field.outputName] = f.properties?.[field.name] ?? null;
        }
        return { ...f, properties: newProps };
    });
}

/**
 * Merge multiple spatial datasets into one
 */
export function mergeDatasets(datasets, addSourceField = true) {
    const allFeatures = [];
    for (const ds of datasets) {
        if (ds.type === 'spatial') {
            for (const f of ds.geojson.features) {
                const props = { ...f.properties };
                if (addSourceField) props.source_file = ds.source?.file || ds.name;
                allFeatures.push({ ...f, properties: props });
            }
        } else if (ds.type === 'table') {
            for (const row of ds.rows) {
                const props = { ...row };
                if (addSourceField) props.source_file = ds.source?.file || ds.name;
                allFeatures.push({ type: 'Feature', geometry: null, properties: props });
            }
        }
    }
    const geojson = { type: 'FeatureCollection', features: allFeatures };
    const name = 'Merged_' + datasets.map(d => d.name).join('_').slice(0, 50);
    return createSpatialDataset(name, geojson, { format: 'merge' });
}

export default {
    createSpatialDataset, createTableDataset, tableToSpatial, spatialToTable,
    analyzeSchema, analyzeTableSchema, getSelectedFields, applyFieldSelection, mergeDatasets
};
