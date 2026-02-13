/**
 * CSV importer using PapaParse
 * Delimiter detection, headers, type inference, coordinate detection
 */
import { createTableDataset, createSpatialDataset } from '../core/data-model.js';
import { AppError, ErrorCategory } from '../core/error-handler.js';

export async function importCSV(file, task) {
    task.updateProgress(20, 'Loading PapaParse...');

    // PapaParse loaded via CDN in index.html
    if (typeof Papa === 'undefined') {
        throw new AppError('PapaParse library not loaded', ErrorCategory.PARSE_FAILED);
    }

    task.updateProgress(30, 'Parsing CSV...');
    const text = await file.text();

    return new Promise((resolve, reject) => {
        Papa.parse(text, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: 'greedy',
            transformHeader: h => h.trim(),
            complete(results) {
                task.updateProgress(70, 'Building dataset...');

                if (results.errors?.length > 0) {
                    const criticalErrors = results.errors.filter(e => e.type === 'FieldMismatch');
                    if (criticalErrors.length > results.data.length * 0.5) {
                        reject(new AppError('Too many CSV parsing errors', ErrorCategory.PARSE_FAILED, {
                            errors: results.errors.slice(0, 10)
                        }));
                        return;
                    }
                }

                const rows = results.data.filter(r => Object.values(r).some(v => v != null && v !== ''));
                if (rows.length === 0) {
                    reject(new AppError('CSV file is empty or has no data rows', ErrorCategory.PARSE_FAILED));
                    return;
                }

                const fields = results.meta.fields || Object.keys(rows[0]);
                const name = file.name.replace(/\.(csv|tsv|txt)$/i, '');

                // Detect coordinate columns
                const coordInfo = detectCoordinateColumns(fields, rows);

                if (coordInfo) {
                    // Auto-create spatial dataset from coordinates
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
                        file: file.name, format: 'csv',
                        coordDetected: coordInfo,
                        parseErrors: results.errors?.length || 0
                    });
                    ds._coordInfo = coordInfo;
                    task.updateProgress(100, 'Done');
                    resolve(ds);
                } else {
                    const ds = createTableDataset(name, rows, fields, {
                        file: file.name, format: 'csv',
                        parseErrors: results.errors?.length || 0
                    });
                    task.updateProgress(100, 'Done');
                    resolve(ds);
                }
            },
            error(err) {
                reject(new AppError('CSV parsing failed: ' + err.message, ErrorCategory.PARSE_FAILED));
            }
        });
    });
}

function detectCoordinateColumns(fields, rows) {
    const lower = fields.map(f => f.toLowerCase());
    const latPatterns = ['lat', 'latitude', 'y', 'lat_dd', 'latitude_dd'];
    const lonPatterns = ['lon', 'lng', 'long', 'longitude', 'x', 'lon_dd', 'longitude_dd'];

    let latField = null, lonField = null;
    for (const p of latPatterns) {
        const idx = lower.findIndex(f => f === p || f === p.replace('_', ''));
        if (idx >= 0) { latField = fields[idx]; break; }
    }
    for (const p of lonPatterns) {
        const idx = lower.findIndex(f => f === p || f === p.replace('_', ''));
        if (idx >= 0) { lonField = fields[idx]; break; }
    }

    if (latField && lonField) {
        // Verify at least some rows have numeric values
        const sample = rows.slice(0, 20);
        const validCount = sample.filter(r => {
            const lat = parseFloat(r[latField]);
            const lon = parseFloat(r[lonField]);
            return !isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
        }).length;
        if (validCount >= sample.length * 0.5) {
            return { latField, lonField };
        }
    }
    return null;
}
