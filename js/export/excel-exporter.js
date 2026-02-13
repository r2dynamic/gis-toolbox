/**
 * Excel exporter using SheetJS
 */
export async function exportExcel(dataset, options = {}, task) {
    if (typeof XLSX === 'undefined') {
        throw new Error('SheetJS library not loaded');
    }

    task?.updateProgress(30, 'Building spreadsheet...');
    const rows = getRows(dataset);
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, options.sheetName || 'Data');

    task?.updateProgress(70, 'Generating file...');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    task?.updateProgress(90, 'Done');
    return { blob };
}

function getRows(dataset) {
    if (dataset.rows) return dataset.rows;
    if (dataset.geojson?.features) {
        return dataset.geojson.features.map(f => {
            const row = { ...f.properties };
            if (f.geometry?.type === 'Point') {
                row.longitude = f.geometry.coordinates[0];
                row.latitude = f.geometry.coordinates[1];
            }
            return row;
        });
    }
    return [];
}
