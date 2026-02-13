/**
 * Import registry — detects format and dispatches to the right importer
 */
import logger from '../core/logger.js';
import { TaskRunner } from '../core/task-runner.js';
import { AppError, ErrorCategory } from '../core/error-handler.js';
import { importGeoJSON } from './geojson-importer.js';
import { importCSV } from './csv-importer.js';
import { importExcel } from './excel-importer.js';
import { importKML } from './kml-importer.js';
import { importKMZ } from './kmz-importer.js';
import { importShapefile } from './shapefile-importer.js';
import { importJSON } from './json-importer.js';

const FORMAT_MAP = {
    'geojson': importGeoJSON,
    'json': importJSON,
    'csv': importCSV,
    'tsv': importCSV,
    'txt': importCSV,
    'xlsx': importExcel,
    'xls': importExcel,
    'kml': importKML,
    'kmz': importKMZ,
    'zip': importShapefile, // Assume zipped shapefile
    'xml': importKML // try KML parser first
};

export function detectFormat(file) {
    const name = file.name.toLowerCase();
    const ext = name.split('.').pop();
    if (ext === 'geojson') return 'geojson';
    if (ext === 'json') return 'json'; // will auto-detect geojson vs table
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
    if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
    if (ext === 'kml') return 'kml';
    if (ext === 'kmz') return 'kmz';
    if (ext === 'zip') return 'zip';
    if (ext === 'xml') return 'xml';
    return null;
}

export async function importFile(file) {
    const format = detectFormat(file);
    if (!format) {
        throw new AppError(
            `Unsupported file format: ${file.name}`,
            ErrorCategory.UNSUPPORTED_FORMAT,
            { fileName: file.name }
        );
    }

    const importer = FORMAT_MAP[format];
    if (!importer) {
        throw new AppError(
            `No importer for format: ${format}`,
            ErrorCategory.UNSUPPORTED_FORMAT
        );
    }

    const task = new TaskRunner(`Import ${file.name}`, 'Importer');
    return task.run(async (t) => {
        t.updateProgress(10, `Reading ${file.name}...`);
        logger.info('Importer', 'Starting import', { file: file.name, format, size: file.size });

        const result = await importer(file, t);

        logger.info('Importer', 'Import complete', {
            file: file.name,
            format,
            type: result.type,
            features: result.type === 'spatial' ? result.geojson?.features?.length : result.rows?.length,
            fields: result.schema?.fields?.length
        });

        return result;
    });
}

export async function importFiles(files) {
    const results = [];
    const errors = [];
    for (const file of files) {
        try {
            const ds = await importFile(file);
            if (ds) results.push(ds);
        } catch (e) {
            errors.push({ file: file.name, error: e });
            logger.error('Importer', 'File import failed', { file: file.name, error: e.message });
        }
    }
    return { datasets: results, errors };
}

export default { importFile, importFiles, detectFormat };
