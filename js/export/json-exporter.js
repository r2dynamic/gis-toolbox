/**
 * JSON exporter (table records or passthrough GeoJSON)
 */
export async function exportJSON(dataset, options = {}, task) {
    let data;
    if (options.recordsOnly || dataset.type === 'table') {
        data = getRows(dataset);
    } else {
        data = dataset.geojson;
    }
    const text = JSON.stringify(data, null, options.minify ? 0 : 2);
    task?.updateProgress(90, 'Done');
    return { text, mimeType: 'application/json' };
}

function getRows(dataset) {
    if (dataset.rows) return dataset.rows;
    if (dataset.geojson?.features) {
        return dataset.geojson.features.map(f => ({ ...f.properties }));
    }
    return [];
}
