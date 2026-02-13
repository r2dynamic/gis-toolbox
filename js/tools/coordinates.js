/**
 * Coordinates utility
 * DMS ↔ DD conversion, coordinate splitting/combining, batch processing
 */
import logger from '../core/logger.js';

/**
 * Decimal Degrees to DMS string
 */
export function ddToDms(dd, isLon = false) {
    const abs = Math.abs(dd);
    const d = Math.floor(abs);
    const minfloat = (abs - d) * 60;
    const m = Math.floor(minfloat);
    const s = ((minfloat - m) * 60).toFixed(2);
    const dir = isLon ? (dd >= 0 ? 'E' : 'W') : (dd >= 0 ? 'N' : 'S');
    return `${d}° ${m}' ${s}" ${dir}`;
}

/**
 * DMS string to Decimal Degrees
 */
export function dmsToDd(dmsStr) {
    const cleaned = dmsStr.trim().toUpperCase();
    // Try pattern: 40° 26' 46.56" N or 40 26 46.56 N
    const regex = /(-?\d+)[°\s]+(\d+)['\s]+(\d+\.?\d*)["\s]*([NSEW])?/;
    const match = cleaned.match(regex);
    if (match) {
        let dd = parseFloat(match[1]) + parseFloat(match[2]) / 60 + parseFloat(match[3]) / 3600;
        if (match[4] === 'S' || match[4] === 'W') dd = -dd;
        if (parseFloat(match[1]) < 0) dd = -Math.abs(dd);
        return dd;
    }
    // Try plain number
    const num = parseFloat(cleaned);
    if (!isNaN(num)) return num;
    return null;
}

/**
 * Split a combined coordinate string into lat and lon
 */
export function splitCoordString(str, delimiter = ',', lonLatOrder = false) {
    const parts = str.split(delimiter).map(s => s.trim());
    if (parts.length < 2) return null;
    const a = parseFloat(parts[0]);
    const b = parseFloat(parts[1]);
    if (isNaN(a) || isNaN(b)) return null;
    return lonLatOrder ? { lat: b, lon: a } : { lat: a, lon: b };
}

/**
 * Combine lat and lon into a string
 */
export function combineCoords(lat, lon, delimiter = ', ', lonLatOrder = false) {
    return lonLatOrder ? `${lon}${delimiter}${lat}` : `${lat}${delimiter}${lon}`;
}

/**
 * Batch convert lines of coordinates
 */
export function batchConvert(text, fromFormat, toFormat, options = {}) {
    const lines = text.split('\n').filter(l => l.trim());
    const results = [];

    for (const line of lines) {
        try {
            let result;
            if (fromFormat === 'dd' && toFormat === 'dms') {
                const coord = splitCoordString(line, options.delimiter || ',', options.lonLatOrder);
                if (coord) {
                    result = `${ddToDms(coord.lat, false)}, ${ddToDms(coord.lon, true)}`;
                }
            } else if (fromFormat === 'dms' && toFormat === 'dd') {
                const parts = line.split(/,\s*/);
                if (parts.length >= 2) {
                    const lat = dmsToDd(parts[0]);
                    const lon = dmsToDd(parts[1]);
                    if (lat != null && lon != null) {
                        result = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                    }
                }
            } else if (fromFormat === 'combined' && toFormat === 'split') {
                const coord = splitCoordString(line, options.delimiter || ',', options.lonLatOrder);
                if (coord) {
                    result = { lat: coord.lat, lon: coord.lon };
                }
            }
            results.push({ input: line, output: result, error: result ? null : 'Parse failed' });
        } catch (e) {
            results.push({ input: line, output: null, error: e.message });
        }
    }

    logger.info('Coordinates', 'Batch convert', { from: fromFormat, to: toFormat, lines: lines.length, success: results.filter(r => r.output).length });
    return results;
}

/**
 * Detect if a column looks like coordinates
 */
export function detectCoordColumn(values) {
    const sample = values.slice(0, 50).filter(v => v != null && v !== '');
    if (sample.length === 0) return null;

    // Check for combined "lat,lon" format
    const combinedCount = sample.filter(v => {
        const parts = String(v).split(',');
        return parts.length === 2 && parts.every(p => !isNaN(parseFloat(p.trim())));
    }).length;
    if (combinedCount > sample.length * 0.7) return 'combined';

    // Check for DMS
    const dmsCount = sample.filter(v => /[°'"NSEW]/.test(String(v))).length;
    if (dmsCount > sample.length * 0.5) return 'dms';

    // Check for decimal degrees
    const ddCount = sample.filter(v => {
        const n = parseFloat(v);
        return !isNaN(n) && Math.abs(n) <= 180;
    }).length;
    if (ddCount > sample.length * 0.8) return 'dd';

    return null;
}

export default { ddToDms, dmsToDd, splitCoordString, combineCoords, batchConvert, detectCoordColumn };
