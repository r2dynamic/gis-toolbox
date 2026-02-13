/**
 * GeoJSON exporter
 */
export async function exportGeoJSON(dataset, options = {}, task) {
    const geojson = dataset.geojson || {
        type: 'FeatureCollection',
        features: (dataset.rows || []).map(r => ({
            type: 'Feature', geometry: null, properties: r
        }))
    };

    const text = JSON.stringify(geojson, null, options.minify ? 0 : 2);
    task?.updateProgress(90, 'Done');
    return { text, mimeType: 'application/geo+json' };
}
