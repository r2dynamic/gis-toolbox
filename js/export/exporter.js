/**
 * Export registry — dispatches to format-specific exporters
 */
import logger from '../core/logger.js';
import { getSelectedFields, applyFieldSelection } from '../core/data-model.js';
import { TaskRunner } from '../core/task-runner.js';
import { exportGeoJSON } from './geojson-exporter.js';
import { exportCSV } from './csv-exporter.js';
import { exportExcel } from './excel-exporter.js';
import { exportKML } from './kml-exporter.js';
import { exportKMZ } from './kmz-exporter.js';
import { exportJSON } from './json-exporter.js';

const EXPORTERS = {
    geojson: { fn: exportGeoJSON, label: 'GeoJSON', ext: '.geojson', spatial: true },
    json: { fn: exportJSON, label: 'JSON', ext: '.json', spatial: false },
    csv: { fn: exportCSV, label: 'CSV', ext: '.csv', spatial: false },
    xlsx: { fn: exportExcel, label: 'Excel (.xlsx)', ext: '.xlsx', spatial: false },
    kml: { fn: exportKML, label: 'KML', ext: '.kml', spatial: true },
    kmz: { fn: exportKMZ, label: 'KMZ', ext: '.kmz', spatial: true }
};

/**
 * Get available export formats for a dataset
 */
export function getAvailableFormats(dataset) {
    const isSpatial = dataset.type === 'spatial' && dataset.schema?.geometryType;
    const formats = [];

    for (const [key, exp] of Object.entries(EXPORTERS)) {
        if (exp.spatial && !isSpatial) continue; // Skip spatial-only for tables
        formats.push({ key, label: exp.label, ext: exp.ext });
    }

    // CSV, JSON, Excel always available
    return formats;
}

/**
 * Export a dataset to a specific format
 */
export async function exportDataset(dataset, format, options = {}) {
    const exp = EXPORTERS[format];
    if (!exp) throw new Error(`Unknown export format: ${format}`);

    const task = new TaskRunner(`Export ${format.toUpperCase()}`, 'Exporter');
    return task.run(async (t) => {
        t.updateProgress(10, 'Preparing data...');

        // Apply field selection if not photo export
        let exportData = dataset;
        if (!options.skipFieldSelection) {
            exportData = applyFieldSelectionToDataset(dataset);
        }

        t.updateProgress(30, `Generating ${format}...`);
        const result = await exp.fn(exportData, options, t);

        logger.info('Exporter', 'Export complete', {
            format,
            name: dataset.name,
            size: result.blob?.size || result.text?.length
        });

        // Trigger download
        const filename = (options.filename || dataset.name || 'export') + exp.ext;
        downloadBlob(result.blob || new Blob([result.text], { type: result.mimeType || 'application/octet-stream' }), filename);

        return { filename, size: result.blob?.size || result.text?.length };
    });
}

function applyFieldSelectionToDataset(dataset) {
    if (dataset.type === 'spatial') {
        const fc = {
            type: 'FeatureCollection',
            features: applyFieldSelection(dataset.geojson.features, dataset.schema)
        };
        return { ...dataset, geojson: fc };
    }
    // Table
    const selected = getSelectedFields(dataset.schema);
    const fieldNames = selected.map(f => f.name);
    const outputNames = selected.map(f => f.outputName);
    const rows = dataset.rows.map(r => {
        const row = {};
        fieldNames.forEach((f, i) => { row[outputNames[i]] = r[f] ?? null; });
        return row;
    });
    return { ...dataset, rows };
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

export default { getAvailableFormats, exportDataset, downloadBlob };
