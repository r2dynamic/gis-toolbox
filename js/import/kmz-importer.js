/**
 * KMZ importer — unzip and extract KML
 */
import { importKML } from './kml-importer.js';
import { AppError, ErrorCategory } from '../core/error-handler.js';

export async function importKMZ(file, task) {
    task.updateProgress(10, 'Loading JSZip...');

    if (typeof JSZip === 'undefined') {
        throw new AppError('JSZip library not loaded', ErrorCategory.PARSE_FAILED);
    }

    task.updateProgress(20, 'Extracting KMZ...');
    const buffer = await file.arrayBuffer();
    let zip;
    try {
        zip = await JSZip.loadAsync(buffer);
    } catch (e) {
        throw new AppError('Failed to unzip KMZ: ' + e.message, ErrorCategory.PARSE_FAILED);
    }

    // Find KML file inside KMZ
    let kmlContent = null;
    const kmlFiles = [];
    zip.forEach((path, entry) => {
        if (path.toLowerCase().endsWith('.kml') && !entry.dir) {
            kmlFiles.push(entry);
        }
    });

    if (kmlFiles.length === 0) {
        throw new AppError('KMZ contains no KML file', ErrorCategory.PARSE_FAILED);
    }

    task.updateProgress(50, 'Reading KML from KMZ...');
    // Use doc.kml if exists, otherwise first KML
    const mainKml = kmlFiles.find(f => f.name.toLowerCase() === 'doc.kml') || kmlFiles[0];
    kmlContent = await mainKml.async('string');

    task.updateProgress(70, 'Parsing KML...');
    const dataset = await importKML(kmlContent, task);
    dataset.name = file.name.replace(/\.kmz$/i, '');
    dataset.source.file = file.name;
    dataset.source.format = 'kmz';

    return dataset;
}
