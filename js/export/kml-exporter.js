/**
 * KML exporter — with optional styling and folder grouping
 */
export async function exportKML(dataset, options = {}, task) {
    const features = dataset.geojson?.features || [];
    task?.updateProgress(30, 'Generating KML...');

    const style = options.style || null; // { strokeColor, fillColor, strokeWidth, strokeOpacity, fillOpacity, point?, line?, polygon? }
    const sourceGroups = _groupBySource(features);
    const hasSourceFolders = sourceGroups && Object.keys(sourceGroups).length > 1;
    const useGeomFolders = !hasSourceFolders && options.folders !== false && _hasMultipleGeomTypes(features);

    // Build style elements
    let styleBlock = '';
    if (style) {
        styleBlock = _buildKmlStyles(style, useGeomFolders);
    }

    let placemarkXml;
    if (hasSourceFolders) {
        // Folder per source layer
        const folderParts = [];
        const styleUrl = style ? '#style_default' : '';
        if (style && !useGeomFolders) {
            styleBlock = _kmlStyleEl('style_default', style, true);
        }
        for (const [srcName, feats] of Object.entries(sourceGroups)) {
            const marks = feats.map((f, i) => _buildPlacemark(f, i, styleUrl)).filter(Boolean).join('\n');
            folderParts.push(`    <Folder>\n      <name>${escapeXml(srcName)}</name>\n${marks}\n    </Folder>`);
        }
        placemarkXml = folderParts.join('\n');
    } else if (useGeomFolders) {
        // Folder per geometry type
        const groups = _groupByGeomType(features);
        const folderParts = [];
        for (const [gtype, feats] of Object.entries(groups)) {
            if (feats.length === 0) continue;
            const label = { point: 'Points', line: 'Lines', polygon: 'Polygons' }[gtype] || gtype;
            const styleUrl = style ? `#style_${gtype}` : '';
            const marks = feats.map((f, i) => _buildPlacemark(f, i, styleUrl)).filter(Boolean).join('\n');
            folderParts.push(`    <Folder>\n      <name>${escapeXml(label)}</name>\n${marks}\n    </Folder>`);
        }
        placemarkXml = folderParts.join('\n');
    } else {
        const styleUrl = style ? '#style_default' : '';
        if (style && !useGeomFolders) {
            styleBlock = _kmlStyleEl('style_default', style, true);
        }
        placemarkXml = features.map((f, i) => _buildPlacemark(f, i, styleUrl)).filter(Boolean).join('\n');
    }

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(dataset.name || 'Export')}</name>
${styleBlock}${placemarkXml}
  </Document>
</kml>`;

    task?.updateProgress(90, 'Done');
    return { text: kml, mimeType: 'application/vnd.google-earth.kml+xml' };
}

function _buildPlacemark(f, idx, styleUrl) {
    const name = f.properties?.name || f.properties?.Name || f.properties?.NAME || `Feature ${idx + 1}`;
    const desc = buildDescription(f.properties);
    const geomKml = geometryToKML(f.geometry);
    if (!geomKml) return '';
    const styleRef = styleUrl ? `\n      <styleUrl>${styleUrl}</styleUrl>` : '';
    return `    <Placemark>
      <name>${escapeXml(String(name))}</name>
      <description><![CDATA[${desc}]]></description>${styleRef}
      ${geomKml}
    </Placemark>`;
}

function _hasMultipleGeomTypes(features) {
    const cats = new Set();
    for (const f of features) {
        const t = f.geometry?.type;
        if (!t) continue;
        if (t === 'Point' || t === 'MultiPoint') cats.add('point');
        else if (t === 'LineString' || t === 'MultiLineString') cats.add('line');
        else if (t === 'Polygon' || t === 'MultiPolygon') cats.add('polygon');
        if (cats.size > 1) return true;
    }
    return false;
}

function _groupByGeomType(features) {
    const groups = { point: [], line: [], polygon: [] };
    for (const f of features) {
        const t = f.geometry?.type;
        if (!t) continue;
        if (t === 'Point' || t === 'MultiPoint') groups.point.push(f);
        else if (t === 'LineString' || t === 'MultiLineString') groups.line.push(f);
        else groups.polygon.push(f);
    }
    return groups;
}

/**
 * Group features by source_file property (set by merge).
 * Returns null if no source_file is present.
 */
function _groupBySource(features) {
    const groups = {};
    let hasSource = false;
    for (const f of features) {
        const src = f.properties?.source_file;
        if (!src) continue;
        hasSource = true;
        if (!groups[src]) groups[src] = [];
        groups[src].push(f);
    }
    return hasSource ? groups : null;
}

/**
 * Convert app style to KML <Style> elements.
 * KML colors are AABBGGRR format (alpha, blue, green, red).
 */
function _buildKmlStyles(style, useFolders) {
    if (useFolders) {
        // Per-type styles
        const ps = { ...style, ...(style.point || {}) };
        const ls = { ...style, ...(style.line || {}) };
        const gs = { ...style, ...(style.polygon || {}) };
        return [
            _kmlStyleEl('style_point', ps, true),
            _kmlStyleEl('style_line', ls, false),
            _kmlStyleEl('style_polygon', gs, false)
        ].join('\n');
    }
    return _kmlStyleEl('style_default', style, true);
}

function _kmlStyleEl(id, s, includeIcon) {
    const sc = _hexToKmlColor(s.strokeColor || '#2563eb', s.strokeOpacity ?? 0.8);
    const fc = _hexToKmlColor(s.fillColor || s.strokeColor || '#2563eb', s.fillOpacity ?? 0.3);
    const sw = s.strokeWidth ?? 2;

    let xml = `    <Style id="${id}">\n`;
    xml += `      <LineStyle><color>${sc}</color><width>${sw}</width></LineStyle>\n`;
    xml += `      <PolyStyle><color>${fc}</color></PolyStyle>\n`;
    if (includeIcon) {
        const ic = _hexToKmlColor(s.fillColor || s.strokeColor || '#2563eb', Math.min(1, (s.fillOpacity ?? 0.3) + 0.3));
        const scale = ((s.pointSize || 6) / 6).toFixed(1);
        xml += `      <IconStyle><color>${ic}</color><scale>${scale}</scale></IconStyle>\n`;
    }
    xml += `    </Style>\n`;
    return xml;
}

/**
 * Convert hex color (#RRGGBB) + opacity (0-1) to KML AABBGGRR format
 */
function _hexToKmlColor(hex, opacity) {
    const h = hex.replace('#', '');
    const r = h.substring(0, 2);
    const g = h.substring(2, 4);
    const b = h.substring(4, 6);
    const a = Math.round((opacity ?? 1) * 255).toString(16).padStart(2, '0');
    return `${a}${b}${g}${r}`.toLowerCase();
}

function buildDescription(props) {
    if (!props) return '';
    let imgHtml = '';
    if (props._thumbnailDataUrl) {
        imgHtml = `<img src="${props._thumbnailDataUrl}" style="max-width:400px;max-height:400px;" /><br/>`;
    }
    const rows = Object.entries(props)
        .filter(([k, v]) => v != null && v !== '' && !k.startsWith('_'))
        .map(([k, v]) => {
            // Handle attachment objects
            if (v && typeof v === 'object' && v._att) {
                const isImage = v.type?.startsWith('image/');
                if (isImage && v.dataUrl) {
                    return `<tr><td><b>${escapeXml(k)}</b></td><td><img src="${v.dataUrl}" style="max-width:300px;max-height:200px;" /><br/>${escapeXml(v.name || 'attachment')}</td></tr>`;
                }
                return `<tr><td><b>${escapeXml(k)}</b></td><td>📎 ${escapeXml(v.name || 'attachment')}</td></tr>`;
            }
            return `<tr><td><b>${escapeXml(k)}</b></td><td>${escapeXml(String(v))}</td></tr>`;
        })
        .join('');
    return `${imgHtml}<table>${rows}</table>`;
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

/**
 * Multi-layer KML export — each layer becomes its own <Folder> with its own <Style>.
 * @param {Array<{dataset, style}>} layers - array of { dataset, style } objects
 */
export async function exportMultiLayerKML(layers, options = {}, task) {
    task?.updateProgress(20, 'Generating multi-layer KML...');

    const docName = options.filename || 'Multi-Layer Export';
    let styleBlock = '';
    const folderParts = [];

    layers.forEach(({ dataset, style }, idx) => {
        const features = dataset.geojson?.features || [];
        const styleId = `style_layer_${idx}`;

        // Build style for this layer
        if (style) {
            styleBlock += _kmlStyleEl(styleId, style, true);
        }

        const styleUrl = style ? `#${styleId}` : '';
        const marks = features.map((f, i) => _buildPlacemark(f, i, styleUrl)).filter(Boolean).join('\n');
        folderParts.push(`    <Folder>\n      <name>${escapeXml(dataset.name || 'Layer ' + (idx + 1))}</name>\n${marks}\n    </Folder>`);
    });

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(docName)}</name>
${styleBlock}${folderParts.join('\n')}
  </Document>
</kml>`;

    task?.updateProgress(90, 'Done');
    return { text: kml, mimeType: 'application/vnd.google-earth.kml+xml' };
}

export { geometryToKML, buildDescription, escapeXml };
