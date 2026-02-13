/**
 * KML exporter
 */
export async function exportKML(dataset, options = {}, task) {
    const features = dataset.geojson?.features || [];
    task?.updateProgress(30, 'Generating KML...');

    const placemarks = features.map((f, i) => {
        const name = f.properties?.name || f.properties?.Name || f.properties?.NAME || `Feature ${i + 1}`;
        const desc = buildDescription(f.properties);
        const geomKml = geometryToKML(f.geometry);
        if (!geomKml) return '';
        return `    <Placemark>
      <name>${escapeXml(String(name))}</name>
      <description><![CDATA[${desc}]]></description>
      ${geomKml}
    </Placemark>`;
    }).filter(Boolean).join('\n');

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(dataset.name || 'Export')}</name>
${placemarks}
  </Document>
</kml>`;

    task?.updateProgress(90, 'Done');
    return { text: kml, mimeType: 'application/vnd.google-earth.kml+xml' };
}

function buildDescription(props) {
    if (!props) return '';
    const rows = Object.entries(props)
        .filter(([k, v]) => v != null && v !== '')
        .map(([k, v]) => `<tr><td><b>${escapeXml(k)}</b></td><td>${escapeXml(String(v))}</td></tr>`)
        .join('');
    return `<table>${rows}</table>`;
}

function geometryToKML(geom) {
    if (!geom) return '';
    switch (geom.type) {
        case 'Point':
            return `<Point><coordinates>${geom.coordinates[0]},${geom.coordinates[1]},${geom.coordinates[2] || 0}</coordinates></Point>`;
        case 'MultiPoint':
            return `<MultiGeometry>${geom.coordinates.map(c =>
                `<Point><coordinates>${c[0]},${c[1]},${c[2] || 0}</coordinates></Point>`
            ).join('')}</MultiGeometry>`;
        case 'LineString':
            return `<LineString><coordinates>${geom.coordinates.map(c => `${c[0]},${c[1]},${c[2] || 0}`).join(' ')}</coordinates></LineString>`;
        case 'MultiLineString':
            return `<MultiGeometry>${geom.coordinates.map(line =>
                `<LineString><coordinates>${line.map(c => `${c[0]},${c[1]},${c[2] || 0}`).join(' ')}</coordinates></LineString>`
            ).join('')}</MultiGeometry>`;
        case 'Polygon':
            return `<Polygon>${geom.coordinates.map((ring, i) =>
                `<${i === 0 ? 'outerBoundaryIs' : 'innerBoundaryIs'}><LinearRing><coordinates>${ring.map(c => `${c[0]},${c[1]},${c[2] || 0}`).join(' ')}</coordinates></LinearRing></${i === 0 ? 'outerBoundaryIs' : 'innerBoundaryIs'}>`
            ).join('')}</Polygon>`;
        case 'MultiPolygon':
            return `<MultiGeometry>${geom.coordinates.map(poly =>
                `<Polygon>${poly.map((ring, i) =>
                    `<${i === 0 ? 'outerBoundaryIs' : 'innerBoundaryIs'}><LinearRing><coordinates>${ring.map(c => `${c[0]},${c[1]},${c[2] || 0}`).join(' ')}</coordinates></LinearRing></${i === 0 ? 'outerBoundaryIs' : 'innerBoundaryIs'}>`
                ).join('')}</Polygon>`
            ).join('')}</MultiGeometry>`;
        default:
            return '';
    }
}

function escapeXml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export { geometryToKML, buildDescription, escapeXml };
