/**
 * Excel (.xlsx) importer using SheetJS
 */
import { createTableDataset, createSpatialDataset } from '../core/data-model.js';
import { AppError, ErrorCategory } from '../core/error-handler.js';

export async function importExcel(file, task) {
    task.updateProgress(20, 'Loading SheetJS...');

    if (typeof XLSX === 'undefined') {
        throw new AppError('SheetJS library not loaded', ErrorCategory.PARSE_FAILED);
    }

    task.updateProgress(30, 'Reading Excel file...');
    const buffer = await file.arrayBuffer();

    task.updateProgress(50, 'Parsing workbook...');
    let workbook;
    try {
        workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
    } catch (e) {
        throw new AppError('Failed to parse Excel file: ' + e.message, ErrorCategory.PARSE_FAILED);
    }

    const sheetNames = workbook.SheetNames;
    if (sheetNames.length === 0) {
        throw new AppError('Excel file contains no sheets', ErrorCategory.PARSE_FAILED);
    }

    // Use first sheet by default (multi-sheet selection can be added in UI)
    const sheetName = sheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    task.updateProgress(70, `Parsing sheet: ${sheetName}...`);
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

    if (rows.length === 0) {
        throw new AppError('Excel sheet is empty', ErrorCategory.PARSE_FAILED);
    }

    const fields = Object.keys(rows[0]);
    const name = file.name.replace(/\.(xlsx|xls)$/i, '') + (sheetNames.length > 1 ? `_${sheetName}` : '');

    // Detect coordinate columns (same logic as CSV)
    const coordInfo = detectCoordinateColumns(fields, rows);

    if (coordInfo) {
        const features = rows.map(row => {
            const lat = parseFloat(row[coordInfo.latField]);
            const lon = parseFloat(row[coordInfo.lonField]);
            const geom = (!isNaN(lat) && !isNaN(lon))
                ? { type: 'Point', coordinates: [lon, lat] }
                : null;
            return { type: 'Feature', geometry: geom, properties: { ...row } };
        });
        const fc = { type: 'FeatureCollection', features };
        const ds = createSpatialDataset(name, fc, {
            file: file.name, format: 'xlsx', sheet: sheetName,
            sheets: sheetNames, coordDetected: coordInfo
        });
        ds._coordInfo = coordInfo;
        ds._sheets = sheetNames;
        ds._workbook = workbook;
        return ds;
    }

    const ds = createTableDataset(name, rows, fields, {
        file: file.name, format: 'xlsx', sheet: sheetName, sheets: sheetNames
    });
    ds._sheets = sheetNames;
    ds._workbook = workbook;
    return ds;
}

function detectCoordinateColumns(fields, rows) {
    const lower = fields.map(f => f.toLowerCase());
    const latPatterns = ['lat', 'latitude', 'y'];
    const lonPatterns = ['lon', 'lng', 'long', 'longitude', 'x'];

    let latField = null, lonField = null;
    for (const p of latPatterns) {
        const idx = lower.findIndex(f => f === p);
        if (idx >= 0) { latField = fields[idx]; break; }
    }
    for (const p of lonPatterns) {
        const idx = lower.findIndex(f => f === p);
        if (idx >= 0) { lonField = fields[idx]; break; }
    }

    if (latField && lonField) {
        const sample = rows.slice(0, 20);
        const validCount = sample.filter(r =>
            !isNaN(parseFloat(r[latField])) && !isNaN(parseFloat(r[lonField]))
        ).length;
        if (validCount >= sample.length * 0.5) return { latField, lonField };
    }
    return null;
}
