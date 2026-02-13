/**
 * KMZ exporter — zip of KML + optionally images
 */
import { exportKML, geometryToKML, escapeXml } from './kml-exporter.js';

export async function exportKMZ(dataset, options = {}, task) {
    if (typeof JSZip === 'undefined') {
        throw new Error('JSZip library not loaded');
    }

    task?.updateProgress(20, 'Generating KML...');

    let kmlText;

    // Photo mode: embed images in KMZ
    if (options.photos && options.photos.length > 0) {
        const result = await buildPhotoKMZ(dataset, options, task);
        return result;
    }

    // Standard KMZ
    const kmlResult = await exportKML(dataset, options);
    kmlText = kmlResult.text;

    task?.updateProgress(60, 'Creating KMZ archive...');
    const zip = new JSZip();
    zip.file('doc.kml', kmlText);

    task?.updateProgress(80, 'Compressing...');
    const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });

    task?.updateProgress(100, 'Done');
    return { blob };
}

async function buildPhotoKMZ(dataset, options, task) {
    const zip = new JSZip();
    const imgFolder = zip.folder('images');
    const photos = options.photos || [];
    const features = dataset.geojson?.features || [];

    task?.updateProgress(30, 'Embedding images...');

    // Build placemarks with embedded image references
    const placemarks = [];
    for (let i = 0; i < features.length; i++) {
        const f = features[i];
        const photo = photos[i];
        if (!f.geometry) continue;

        task?.updateProgress(30 + Math.round((i / features.length) * 40), `Embedding image ${i + 1}/${features.length}`);

        const name = f.properties?.filename || f.properties?.name || `Photo ${i + 1}`;
        let imgRef = '';

        if (photo?.blob) {
            const ext = photo.filename?.split('.').pop()?.toLowerCase() || 'jpg';
            const imgName = `img_${i}.${ext}`;

            if (options.embedThumbnails !== false && photo.thumbnail) {
                imgFolder.file(imgName, photo.thumbnail);
            } else {
                imgFolder.file(imgName, photo.blob);
            }
            imgRef = `<img src="images/${imgName}" width="320" /><br/>`;
        }

        const desc = `${imgRef}${buildDescTable(f.properties)}`;
        const geomKml = geometryToKML(f.geometry);

        placemarks.push(`    <Placemark>
      <name>${escapeXml(String(name))}</name>
      <description><![CDATA[${desc}]]></description>
      ${geomKml}
    </Placemark>`);
    }

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(dataset.name || 'Photo Export')}</name>
${placemarks.join('\n')}
  </Document>
</kml>`;

    zip.file('doc.kml', kml);

    task?.updateProgress(85, 'Compressing KMZ...');
    const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });

    task?.updateProgress(100, 'Done');
    return { blob };
}

function buildDescTable(props) {
    if (!props) return '';
    return '<table>' + Object.entries(props)
        .filter(([k, v]) => v != null && v !== '' && k !== 'thumbnail')
        .map(([k, v]) => `<tr><td><b>${escapeXml(k)}</b></td><td>${escapeXml(String(v))}</td></tr>`)
        .join('') + '</table>';
}
