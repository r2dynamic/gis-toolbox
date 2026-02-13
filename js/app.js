/**
 * GIS Toolbox — Main Application Entry Point
 * Wires all modules together, builds UI, handles events
 */
import logger from './core/logger.js';
import bus from './core/event-bus.js';
import { handleError } from './core/error-handler.js';
import {
    getState, getLayers, getActiveLayer, addLayer, removeLayer,
    setActiveLayer, toggleLayerVisibility, setUIState, toggleAGOLCompat
} from './core/state.js';
import { mergeDatasets, getSelectedFields, tableToSpatial } from './core/data-model.js';
import { importFile, importFiles } from './import/importer.js';
import { getAvailableFormats, exportDataset } from './export/exporter.js';
import mapManager from './map/map-manager.js';
import { showToast, showErrorToast } from './ui/toast.js';
import { showModal, confirm, showProgressModal } from './ui/modals.js';
import * as transforms from './dataprep/transforms.js';
import { applyTemplate, previewTemplate, getTemplateFields } from './dataprep/template-builder.js';
import { saveSnapshot, undo as undoHistory, redo as redoHistory, getHistoryState } from './dataprep/transform-history.js';
import { photoMapper } from './photo/photo-mapper.js';
import { arcgisImporter } from './arcgis/rest-importer.js';
import { checkAGOLCompatibility, applyAGOLFixes } from './agol/compatibility.js';
import * as gisTools from './tools/gis-tools.js';
import * as coordUtils from './tools/coordinates.js';

// ============================
// Initialize app
// ============================
document.addEventListener('DOMContentLoaded', () => {
    logger.info('App', 'Initializing GIS Toolbox');
    initMap();
    setupEventListeners();
    setupDragDrop();
    checkMobile();
    window.addEventListener('resize', checkMobile);
    logger.info('App', 'App ready');
});

function initMap() {
    try {
        mapManager.init('map-container');
    } catch (e) {
        logger.error('App', 'Map init failed', { error: e.message });
        showToast('Map failed to initialize. Some features may be limited.', 'warning');
    }
}

function checkMobile() {
    const isMobile = window.innerWidth < 768;
    const state = getState();
    if (isMobile !== state.ui.isMobile) {
        setUIState('isMobile', isMobile);
        document.body.classList.toggle('is-mobile', isMobile);
    }
}

// ============================
// Drag & Drop file import
// ============================
function setupDragDrop() {
    const mapEl = document.getElementById('map-container');
    if (!mapEl) return;

    ['dragenter', 'dragover'].forEach(evt => {
        mapEl.addEventListener(evt, e => {
            e.preventDefault();
            e.stopPropagation();
            mapEl.classList.add('dragover');
        });
    });
    ['dragleave', 'drop'].forEach(evt => {
        mapEl.addEventListener(evt, e => {
            e.preventDefault();
            e.stopPropagation();
            mapEl.classList.remove('dragover');
        });
    });
    mapEl.addEventListener('drop', async (e) => {
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) await handleFileImport(files);
    });
}

// ============================
// File import handler
// ============================
async function handleFileImport(files) {
    const progress = showProgressModal('Importing Files');
    let currentTask = null;

    bus.on('task:progress', (data) => {
        progress.update(data.percent, data.step);
    });

    progress.onCancel(() => {
        if (currentTask) currentTask.cancel?.();
        progress.close();
        showToast('Import cancelled', 'warning');
    });

    try {
        const { datasets, errors } = await importFiles(files);
        progress.close();

        for (const ds of datasets) {
            addLayer(ds);
            mapManager.addLayer(ds, getLayers().indexOf(ds));
        }

        if (datasets.length > 0) {
            showToast(`Imported ${datasets.length} layer(s)`, 'success');
            refreshUI();
        }
        if (errors.length > 0) {
            for (const err of errors) {
                const classified = handleError(err.error, 'Import', err.file);
                showErrorToast(classified);
            }
        }
    } catch (e) {
        progress.close();
        const classified = handleError(e, 'Import', 'File import');
        showErrorToast(classified);
    }
}

// ============================
// Setup all event listeners
// ============================
function setupEventListeners() {
    // Import button
    document.getElementById('btn-import')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.geojson,.json,.csv,.tsv,.txt,.xlsx,.xls,.kml,.kmz,.zip,.xml';
        input.onchange = () => {
            if (input.files.length > 0) handleFileImport(Array.from(input.files));
        };
        input.click();
    });

    // Mobile import
    document.getElementById('btn-import-mobile')?.addEventListener('click', () => {
        document.getElementById('btn-import')?.click();
    });

    // Photo Mapper
    document.getElementById('btn-photo-mapper')?.addEventListener('click', openPhotoMapper);
    document.getElementById('btn-photo-mapper-mobile')?.addEventListener('click', openPhotoMapper);

    // ArcGIS REST Import
    document.getElementById('btn-arcgis')?.addEventListener('click', openArcGISImporter);
    document.getElementById('btn-arcgis-mobile')?.addEventListener('click', openArcGISImporter);

    // Coordinates
    document.getElementById('btn-coordinates')?.addEventListener('click', openCoordinatesModal);

    // Logs
    document.getElementById('btn-logs')?.addEventListener('click', toggleLogs);

    // Export
    document.getElementById('btn-export')?.addEventListener('click', openExportModal);

    // Merge layers
    document.getElementById('btn-merge')?.addEventListener('click', handleMergeLayers);

    // Undo / Redo
    document.getElementById('btn-undo')?.addEventListener('click', handleUndo);
    document.getElementById('btn-redo')?.addEventListener('click', handleRedo);

    // Mobile nav tabs
    document.querySelectorAll('.mobile-nav-item').forEach(el => {
        el.addEventListener('click', () => {
            const tab = el.dataset.tab;
            setUIState('activeTab', tab);
            document.querySelectorAll('.mobile-nav-item').forEach(n => n.classList.remove('active'));
            el.classList.add('active');
            showMobileContent(tab);
        });
    });

    // Panel collapse
    document.getElementById('toggle-left-panel')?.addEventListener('click', () => {
        document.querySelector('.panel-left')?.classList.toggle('collapsed');
    });
    document.getElementById('toggle-right-panel')?.addEventListener('click', () => {
        document.querySelector('.panel-right')?.classList.toggle('collapsed');
    });

    // Listen for layer changes to update UI
    bus.on('layers:changed', refreshUI);
    bus.on('layer:active', refreshUI);
    bus.on('task:error', (data) => {
        showErrorToast(data.error);
    });

    // Basemap selector
    document.getElementById('basemap-select')?.addEventListener('change', (e) => {
        mapManager.setBasemap(e.target.value);
    });

    // AGOL compat toggle
    document.getElementById('agol-toggle')?.addEventListener('change', () => {
        toggleAGOLCompat();
        refreshUI();
    });
}

// ============================
// UI Refresh — rebuilds panels
// ============================
function refreshUI() {
    renderLayerList();
    renderFieldList();
    renderOutputPanel();
    renderMobileContent();
    updateToolbarState();
}

function updateToolbarState() {
    const layers = getLayers();
    const hasLayers = layers.length > 0;
    document.getElementById('btn-export')?.classList.toggle('hidden', !hasLayers);
    document.getElementById('btn-merge')?.classList.toggle('hidden', layers.length < 2);

    const hs = getHistoryState();
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.disabled = !hs.canUndo;
    if (redoBtn) redoBtn.disabled = !hs.canRedo;
}

// ============================
// Layer List (left panel)
// ============================
function renderLayerList() {
    const container = document.getElementById('layer-list');
    if (!container) return;
    const layers = getLayers();
    const active = getActiveLayer();

    if (layers.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M12 16v-4m0-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
                <p>No layers loaded. Import a file or use a tool to get started.</p>
            </div>`;
        return;
    }

    container.innerHTML = layers.map(layer => {
        const isActive = layer.id === active?.id;
        const icon = layer.type === 'spatial' ? '🗺️' : '📊';
        const count = layer.type === 'spatial'
            ? `${layer.geojson?.features?.length || 0} features`
            : `${layer.rows?.length || 0} rows`;
        const geomBadge = layer.schema?.geometryType
            ? `<span class="badge badge-info">${layer.schema.geometryType}</span>` : '';

        return `
            <div class="layer-item ${isActive ? 'active' : ''}" data-id="${layer.id}">
                <span class="layer-icon">${icon}</span>
                <div class="layer-info" onclick="window.app.setActiveLayer('${layer.id}')">
                    <div class="layer-name">${layer.name}</div>
                    <div class="layer-meta">${count} · ${layer.schema?.fields?.length || 0} fields ${geomBadge}</div>
                </div>
                <div class="layer-actions">
                    <button class="btn-icon" title="Toggle visibility" onclick="window.app.toggleVisibility('${layer.id}')">
                        ${layer.visible ? '👁️' : '👁️‍🗨️'}
                    </button>
                    <button class="btn-icon" title="Zoom to layer" onclick="window.app.zoomToLayer('${layer.id}')">🔍</button>
                    <button class="btn-icon" title="Remove" onclick="window.app.removeLayer('${layer.id}')">🗑️</button>
                </div>
            </div>`;
    }).join('');
}

// ============================
// Field List (left panel)
// ============================
function renderFieldList() {
    const container = document.getElementById('field-list');
    if (!container) return;
    const layer = getActiveLayer();

    if (!layer) {
        container.innerHTML = '<div class="text-muted text-sm p-8">Select a layer to view fields</div>';
        return;
    }

    const fields = layer.schema?.fields || [];
    const searchHtml = `<div class="input-with-btn" style="margin-bottom:8px;">
        <input type="search" id="field-search" placeholder="Search fields..." oninput="window.app.filterFields(this.value)">
        <button class="btn btn-sm btn-secondary" onclick="window.app.selectAllFields(true)">All</button>
        <button class="btn btn-sm btn-secondary" onclick="window.app.selectAllFields(false)">None</button>
    </div>`;

    const fieldRows = fields.map(f => `
        <div class="field-item" data-field="${f.name}">
            <input type="checkbox" ${f.selected ? 'checked' : ''} onchange="window.app.toggleField('${f.name}', this.checked)">
            <span class="field-name">${f.outputName || f.name}</span>
            <span class="field-type">${f.type}</span>
            <span class="field-stats text-xs">${f.uniqueCount ?? ''}u · ${f.nullCount ?? ''}n</span>
        </div>
    `).join('');

    container.innerHTML = searchHtml + `<div class="field-list-items">${fieldRows}</div>`;
}

// ============================
// Output Panel (right panel)
// ============================
function renderOutputPanel() {
    const container = document.getElementById('output-panel-content');
    if (!container) return;
    const layer = getActiveLayer();

    if (!layer) {
        container.innerHTML = '<div class="empty-state"><p>No layer selected</p></div>';
        return;
    }

    const selected = getSelectedFields(layer.schema);
    const formatsList = getAvailableFormats(layer);

    // AGOL compat check
    const agolMode = getState().agolCompatMode;
    let agolHtml = '';
    if (agolMode) {
        const check = checkAGOLCompatibility(layer);
        agolHtml = `<div class="panel-section">
            <div class="panel-section-header">AGOL Readiness</div>
            <div class="panel-section-body">
                ${check.issues.length === 0
                ? '<div class="success-box">✅ All checks passed</div>'
                : check.issues.map(i => `<div class="warning-box text-xs mb-8">${i.type}: ${i.field || ''} ${i.message || i.fixed ? '→ ' + i.fixed : ''}</div>`).join('')
            }
                ${check.issues.length > 0 ? '<button class="btn btn-sm btn-primary w-full mt-8" onclick="window.app.fixAGOL()">Fix All</button>' : ''}
            </div>
        </div>`;
    }

    container.innerHTML = `
        <div class="panel-section">
            <div class="panel-section-header">Output Schema (${selected.length} fields)</div>
            <div class="panel-section-body">
                ${selected.map(f => `<div class="field-item">
                    <span class="field-name">${f.outputName}</span>
                    <span class="field-type">${f.type}</span>
                </div>`).join('')}
                ${selected.length === 0 ? '<div class="text-muted text-sm">No fields selected</div>' : ''}
            </div>
        </div>

        <div class="panel-section">
            <div class="panel-section-header">Export</div>
            <div class="panel-section-body">
                <label class="toggle mb-8">
                    <input type="checkbox" id="agol-toggle" ${agolMode ? 'checked' : ''}>
                    <span class="toggle-track"></span>
                    <span>AGOL Compatible</span>
                </label>
                <div style="display:flex; flex-wrap:wrap; gap:6px;">
                    ${formatsList.map(fmt =>
                        `<button class="btn btn-sm btn-primary" onclick="window.app.doExport('${fmt.key}')">${fmt.label}</button>`
                    ).join('')}
                </div>
            </div>
        </div>

        ${agolHtml}

        <div class="panel-section">
            <div class="panel-section-header">Data Preview</div>
            <div class="panel-section-body">
                <button class="btn btn-sm btn-secondary w-full" onclick="window.app.showDataTable()">Show Data Table</button>
            </div>
        </div>`;

    // Re-bind AGOL toggle
    document.getElementById('agol-toggle')?.addEventListener('change', () => {
        toggleAGOLCompat();
        renderOutputPanel();
    });
}

// ============================
// Data Prep Panel (left panel section)
// ============================
function renderDataPrepTools() {
    return `
        <div class="panel-section">
            <div class="panel-section-header" onclick="toggleSection(this)">
                Data Prep <span class="arrow">▼</span>
            </div>
            <div class="panel-section-body">
                <div style="display:flex; flex-wrap:wrap; gap:4px;">
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openSplitColumn()">Split Column</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openCombineColumns()">Combine</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openTemplateBuilder()">Template</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openReplaceClean()">Replace/Clean</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openTypeConvert()">Type Convert</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openFilterBuilder()">Filter</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openDeduplicate()">Dedup</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openJoinTool()">Join</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openValidation()">Validate</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.addUID()">Add UID</button>
                </div>
            </div>
        </div>

        <div class="panel-section">
            <div class="panel-section-header" onclick="toggleSection(this)">
                GIS Tools <span class="arrow">▼</span>
            </div>
            <div class="panel-section-body">
                <div style="display:flex; flex-wrap:wrap; gap:4px;">
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openBuffer()">Buffer</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openSimplify()">Simplify</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openClip()">Clip to Extent</button>
                </div>
            </div>
        </div>`;
}

// ============================
// Mobile content switching
// ============================
function showMobileContent(tab) {
    document.querySelectorAll('.mobile-content').forEach(el => el.classList.add('hidden'));
    const panel = document.getElementById(`mobile-${tab}`);
    if (panel) {
        panel.classList.remove('hidden');
        if (tab === 'data') renderMobileDataPanel();
        if (tab === 'prep') renderMobilePrepPanel();
        if (tab === 'tools') renderMobileToolsPanel();
        if (tab === 'export') renderMobileExportPanel();
    }
}

function renderMobileContent() {
    const tab = getState().ui.activeTab;
    if (getState().ui.isMobile) showMobileContent(tab);
}

function renderMobileDataPanel() {
    const el = document.getElementById('mobile-data');
    if (!el) return;
    const layers = getLayers();
    const layer = getActiveLayer();

    let html = `<h3 style="margin-bottom:8px;">Layers</h3>`;
    if (layers.length === 0) {
        html += `<div class="empty-state"><p>No layers.</p>
            <button class="btn btn-primary" id="btn-import-mobile">Import Files</button></div>`;
    } else {
        html += layers.map(l => `
            <div class="layer-item ${l.id === layer?.id ? 'active' : ''}" onclick="window.app.setActiveLayer('${l.id}')">
                <span>${l.type === 'spatial' ? '🗺️' : '📊'}</span>
                <div class="layer-info">
                    <div class="layer-name">${l.name}</div>
                    <div class="layer-meta">${l.schema?.featureCount || 0} items · ${l.schema?.fields?.length || 0} fields</div>
                </div>
            </div>
        `).join('');
    }

    if (layer) {
        html += `<h3 style="margin:12px 0 8px;">Fields</h3>`;
        html += (layer.schema?.fields || []).map(f => `
            <div class="field-item">
                <input type="checkbox" ${f.selected ? 'checked' : ''} onchange="window.app.toggleField('${f.name}', this.checked)">
                <span class="field-name">${f.name}</span>
                <span class="field-type">${f.type}</span>
            </div>
        `).join('');
    }

    el.innerHTML = html;
    el.querySelector('#btn-import-mobile')?.addEventListener('click', () => {
        document.getElementById('btn-import')?.click();
    });
}

function renderMobilePrepPanel() {
    const el = document.getElementById('mobile-prep');
    if (!el) return;
    const layer = getActiveLayer();
    if (!layer) {
        el.innerHTML = '<div class="empty-state"><p>Import data first</p></div>';
        return;
    }
    el.innerHTML = `
        <h3 style="margin-bottom:8px;">Data Prep Tools</h3>
        <div style="display:flex; flex-wrap:wrap; gap:6px;">
            <button class="btn btn-secondary" onclick="window.app.openSplitColumn()">Split Column</button>
            <button class="btn btn-secondary" onclick="window.app.openCombineColumns()">Combine</button>
            <button class="btn btn-secondary" onclick="window.app.openTemplateBuilder()">Template Builder</button>
            <button class="btn btn-secondary" onclick="window.app.openReplaceClean()">Replace/Clean</button>
            <button class="btn btn-secondary" onclick="window.app.openTypeConvert()">Type Convert</button>
            <button class="btn btn-secondary" onclick="window.app.openFilterBuilder()">Filter</button>
            <button class="btn btn-secondary" onclick="window.app.openDeduplicate()">Deduplicate</button>
            <button class="btn btn-secondary" onclick="window.app.openJoinTool()">Join</button>
            <button class="btn btn-secondary" onclick="window.app.openValidation()">Validate</button>
            <button class="btn btn-secondary" onclick="window.app.addUID()">Add UID</button>
        </div>`;
}

function renderMobileToolsPanel() {
    const el = document.getElementById('mobile-tools');
    if (!el) return;
    el.innerHTML = `
        <h3 style="margin-bottom:8px;">GIS Tools</h3>
        <div style="display:flex; flex-wrap:wrap; gap:6px;">
            <button class="btn btn-secondary" onclick="window.app.openBuffer()">Buffer</button>
            <button class="btn btn-secondary" onclick="window.app.openSimplify()">Simplify</button>
            <button class="btn btn-secondary" onclick="window.app.openClip()">Clip to Extent</button>
            <button class="btn btn-secondary" onclick="window.app.openPhotoMapper()">Photo Mapper</button>
            <button class="btn btn-secondary" onclick="window.app.openArcGISImporter()">ArcGIS REST Import</button>
            <button class="btn btn-secondary" onclick="window.app.openCoordinatesModal()">Coordinates</button>
        </div>`;
}

function renderMobileExportPanel() {
    const el = document.getElementById('mobile-export');
    if (!el) return;
    const layer = getActiveLayer();
    if (!layer) {
        el.innerHTML = '<div class="empty-state"><p>Import data first</p></div>';
        return;
    }
    const formats = getAvailableFormats(layer);
    el.innerHTML = `
        <h3 style="margin-bottom:8px;">Export</h3>
        <label class="toggle mb-8">
            <input type="checkbox" id="agol-toggle-mobile" ${getState().agolCompatMode ? 'checked' : ''}>
            <span class="toggle-track"></span>
            <span>AGOL Compatible</span>
        </label>
        <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:12px;">
            ${formats.map(f =>
                `<button class="btn btn-primary" onclick="window.app.doExport('${f.key}')">${f.label}</button>`
            ).join('')}
        </div>`;
    el.querySelector('#agol-toggle-mobile')?.addEventListener('change', () => {
        toggleAGOLCompat();
    });
}

// ============================
// Logs panel
// ============================
function toggleLogs() {
    const logsPanel = document.getElementById('logs-panel');
    if (!logsPanel) return;
    logsPanel.classList.toggle('hidden');
    if (!logsPanel.classList.contains('hidden')) renderLogs();
}

function renderLogs(filter = {}) {
    const body = document.getElementById('logs-body');
    if (!body) return;
    const entries = logger.getEntries(filter);
    body.innerHTML = entries.slice(-200).map(e =>
        `<div class="log-entry">
            <span class="ts">${e.ts.slice(11, 23)}</span>
            <span class="lvl-${e.level}">[${e.level}]</span>
            <span>[${e.module}]</span>
            ${e.action} ${e.context && Object.keys(e.context).length ? JSON.stringify(e.context) : ''}
            ${e.duration != null ? `<span class="text-muted">(${e.duration}ms)</span>` : ''}
        </div>`
    ).join('');
    body.scrollTop = body.scrollHeight;
}

// ============================
// Data Prep tool modals
// ============================

function getFeatures() {
    const layer = getActiveLayer();
    if (!layer) return [];
    if (layer.type === 'spatial') return layer.geojson?.features || [];
    return (layer.rows || []).map(r => ({ type: 'Feature', geometry: null, properties: r }));
}

function getFieldNames() {
    const layer = getActiveLayer();
    return (layer?.schema?.fields || []).map(f => f.name);
}

function applyTransform(name, newFeatures) {
    const layer = getActiveLayer();
    if (!layer) return;
    // Save snapshot before transform
    if (layer.type === 'spatial') {
        saveSnapshot(layer.id, name, layer.geojson);
        layer.geojson = { type: 'FeatureCollection', features: newFeatures };
        import('./core/data-model.js').then(dm => {
            layer.schema = dm.analyzeSchema(layer.geojson);
            bus.emit('layer:updated', layer);
            bus.emit('layers:changed', getLayers());
            mapManager.addLayer(layer, getLayers().indexOf(layer));
            refreshUI();
        });
    }
    showToast(`Applied: ${name}`, 'success');
}

// Split Column
async function openSplitColumn() {
    const fields = getFieldNames();
    if (fields.length === 0) return showToast('No fields available', 'warning');

    const html = `
        <div class="form-group"><label>Field to split</label>
            <select id="sc-field">${fields.map(f => `<option>${f}</option>`).join('')}</select></div>
        <div class="form-group"><label>Delimiter</label>
            <select id="sc-delim"><option value=",">Comma</option><option value=" ">Space</option><option value="	">Tab</option><option value=";">Semicolon</option><option value="custom">Custom</option></select></div>
        <div class="form-group hidden" id="sc-custom-wrap"><label>Custom delimiter</label>
            <input type="text" id="sc-custom"></div>
        <div class="form-group"><label>Max parts (0=all)</label>
            <input type="number" id="sc-max" value="0" min="0"></div>
        <label class="checkbox-row"><input type="checkbox" id="sc-trim" checked> Trim whitespace</label>`;

    showModal('Split Column', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Apply</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('#sc-delim').onchange = (e) => {
                overlay.querySelector('#sc-custom-wrap').classList.toggle('hidden', e.target.value !== 'custom');
            };
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                let delim = overlay.querySelector('#sc-delim').value;
                if (delim === 'custom') delim = overlay.querySelector('#sc-custom').value || ',';
                const field = overlay.querySelector('#sc-field').value;
                const result = transforms.splitColumn(getFeatures(), field, {
                    delimiter: delim,
                    trim: overlay.querySelector('#sc-trim').checked,
                    maxParts: parseInt(overlay.querySelector('#sc-max').value) || 0
                });
                applyTransform(`Split: ${field}`, result);
                close();
            };
        }
    });
}

// Combine Columns
async function openCombineColumns() {
    const fields = getFieldNames();
    if (fields.length < 2) return showToast('Need at least 2 fields', 'warning');

    const html = `
        <div class="form-group"><label>Select fields to combine</label>
            <div style="max-height:200px;overflow-y:auto;">
                ${fields.map(f => `<label class="checkbox-row"><input type="checkbox" value="${f}"> ${f}</label>`).join('')}
            </div></div>
        <div class="form-group"><label>Delimiter</label>
            <input type="text" id="cc-delim" value=" "></div>
        <div class="form-group"><label>Output field name</label>
            <input type="text" id="cc-output" value="combined"></div>
        <label class="checkbox-row"><input type="checkbox" id="cc-skip" checked> Skip empty values</label>`;

    showModal('Combine Columns', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Apply</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const selected = Array.from(overlay.querySelectorAll('input[type=checkbox]:checked')).map(el => el.value).filter(Boolean);
                if (selected.length === 0) return showToast('Select at least one field', 'warning');
                const result = transforms.combineColumns(getFeatures(), selected, {
                    delimiter: overlay.querySelector('#cc-delim').value,
                    outputField: overlay.querySelector('#cc-output').value || 'combined',
                    skipBlanks: overlay.querySelector('#cc-skip').checked
                });
                applyTransform('Combine columns', result);
                close();
            };
        }
    });
}

// Template Builder
async function openTemplateBuilder() {
    const fields = getFieldNames();
    if (fields.length === 0) return showToast('No fields available', 'warning');
    const features = getFeatures();

    const html = `
        <div class="form-group"><label>Output field name</label>
            <input type="text" id="tb-output" value="template_result"></div>
        <div class="form-group"><label>Template (use {FieldName} for placeholders)</label>
            <textarea id="tb-template" rows="3" placeholder="e.g. {Name} - {City}, {State}"></textarea></div>
        <div class="form-group"><label>Insert field</label>
            <div class="input-with-btn">
                <select id="tb-field-select">${fields.map(f => `<option value="${f}">${f}</option>`).join('')}</select>
                <button class="btn btn-sm btn-secondary" id="tb-insert">Insert</button>
            </div></div>
        <label class="checkbox-row"><input type="checkbox" id="tb-trim" checked> Trim whitespace</label>
        <label class="checkbox-row"><input type="checkbox" id="tb-collapse" checked> Collapse spaces</label>
        <label class="checkbox-row"><input type="checkbox" id="tb-wrappers" checked> Remove empty wrappers ()/[]/{}</label>
        <label class="checkbox-row"><input type="checkbox" id="tb-dangling" checked> Remove dangling separators</label>
        <label class="checkbox-row"><input type="checkbox" id="tb-collsep" checked> Collapse repeated separators</label>
        <div class="divider"></div>
        <div><strong>Live Preview:</strong></div>
        <div id="tb-preview" class="text-sm text-mono" style="background:var(--bg); padding:8px; border-radius:4px; max-height:120px; overflow-y:auto; margin-top:6px;"></div>`;

    showModal('Template Builder', html, {
        width: '650px',
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Apply</button>',
        onMount: (overlay, close) => {
            const textarea = overlay.querySelector('#tb-template');
            const previewEl = overlay.querySelector('#tb-preview');

            const updatePreview = () => {
                const tmpl = textarea.value;
                if (!tmpl) { previewEl.textContent = '(enter a template above)'; return; }
                const opts = {
                    trimWhitespace: overlay.querySelector('#tb-trim').checked,
                    collapseSpaces: overlay.querySelector('#tb-collapse').checked,
                    removeEmptyWrappers: overlay.querySelector('#tb-wrappers').checked,
                    removeDanglingSeparators: overlay.querySelector('#tb-dangling').checked,
                    collapseSeparators: overlay.querySelector('#tb-collsep').checked
                };
                const results = previewTemplate(features, tmpl, opts);
                previewEl.innerHTML = results.map((r, i) => `<div>${i + 1}: ${r || '<em>empty</em>'}</div>`).join('');
            };

            textarea.addEventListener('input', updatePreview);
            overlay.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', updatePreview));

            overlay.querySelector('#tb-insert').onclick = () => {
                const field = overlay.querySelector('#tb-field-select').value;
                const pos = textarea.selectionStart;
                const before = textarea.value.slice(0, pos);
                const after = textarea.value.slice(pos);
                textarea.value = before + `{${field}}` + after;
                textarea.focus();
                updatePreview();
            };

            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const template = textarea.value;
                if (!template) return showToast('Enter a template', 'warning');
                const outputField = overlay.querySelector('#tb-output').value || 'template_result';
                const opts = {
                    trimWhitespace: overlay.querySelector('#tb-trim').checked,
                    collapseSpaces: overlay.querySelector('#tb-collapse').checked,
                    removeEmptyWrappers: overlay.querySelector('#tb-wrappers').checked,
                    removeDanglingSeparators: overlay.querySelector('#tb-dangling').checked,
                    collapseSeparators: overlay.querySelector('#tb-collsep').checked
                };
                const result = applyTemplate(features, template, outputField, opts);
                applyTransform(`Template: ${outputField}`, result);
                close();
            };

            updatePreview();
        }
    });
}

// Replace/Clean
async function openReplaceClean() {
    const fields = getFieldNames();
    if (fields.length === 0) return showToast('No fields available', 'warning');

    const html = `
        <div class="form-group"><label>Field</label>
            <select id="rc-field">${fields.map(f => `<option>${f}</option>`).join('')}</select></div>
        <div class="form-group"><label>Find</label>
            <input type="text" id="rc-find"></div>
        <div class="form-group"><label>Replace with</label>
            <input type="text" id="rc-replace"></div>
        <label class="checkbox-row"><input type="checkbox" id="rc-trim"> Trim whitespace</label>
        <label class="checkbox-row"><input type="checkbox" id="rc-collapse"> Collapse multiple spaces</label>
        <div class="form-group"><label>Case transform</label>
            <select id="rc-case"><option value="">None</option><option value="upper">UPPER</option><option value="lower">lower</option><option value="title">Title Case</option></select></div>`;

    showModal('Replace / Clean Text', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Apply</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const result = transforms.replaceText(getFeatures(), overlay.querySelector('#rc-field').value, {
                    find: overlay.querySelector('#rc-find').value,
                    replace: overlay.querySelector('#rc-replace').value,
                    trimWhitespace: overlay.querySelector('#rc-trim').checked,
                    collapseSpaces: overlay.querySelector('#rc-collapse').checked,
                    caseTransform: overlay.querySelector('#rc-case').value || null
                });
                applyTransform('Replace/Clean', result);
                close();
            };
        }
    });
}

// Type Convert
async function openTypeConvert() {
    const fields = getFieldNames();
    const html = `
        <div class="form-group"><label>Field</label>
            <select id="tc-field">${fields.map(f => `<option>${f}</option>`).join('')}</select></div>
        <div class="form-group"><label>Convert to</label>
            <select id="tc-type"><option value="number">Number</option><option value="string">String</option><option value="boolean">Boolean</option><option value="date">Date (ISO)</option></select></div>`;

    showModal('Type Convert', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Apply</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const { features: result, failures } = transforms.typeConvert(
                    getFeatures(),
                    overlay.querySelector('#tc-field').value,
                    overlay.querySelector('#tc-type').value
                );
                applyTransform('Type Convert', result);
                if (failures > 0) showToast(`${failures} values could not be converted`, 'warning');
                close();
            };
        }
    });
}

// Filter Builder
async function openFilterBuilder() {
    const fields = getFieldNames();
    const operators = transforms.FILTER_OPERATORS;

    const html = `
        <div id="filter-rules"></div>
        <button class="btn btn-sm btn-secondary mt-8" id="fb-add-rule">+ Add Rule</button>
        <div class="form-group mt-8"><label>Logic</label>
            <select id="fb-logic"><option value="AND">AND (all match)</option><option value="OR">OR (any match)</option></select></div>`;

    showModal('Filter Builder', html, {
        width: '650px',
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Apply Filter</button>',
        onMount: (overlay, close) => {
            const rulesContainer = overlay.querySelector('#filter-rules');
            let ruleCount = 0;

            const addRule = () => {
                ruleCount++;
                const ruleHtml = `<div class="flex gap-4 items-center mb-8" data-rule="${ruleCount}">
                    <select class="rule-field" style="flex:1">${fields.map(f => `<option>${f}</option>`).join('')}</select>
                    <select class="rule-op" style="flex:1">${operators.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}</select>
                    <input type="text" class="rule-val" placeholder="value" style="flex:1">
                    <button class="btn-icon" onclick="this.parentElement.remove()">✕</button>
                </div>`;
                rulesContainer.insertAdjacentHTML('beforeend', ruleHtml);
            };

            addRule();
            overlay.querySelector('#fb-add-rule').onclick = addRule;
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const rules = Array.from(rulesContainer.querySelectorAll('[data-rule]')).map(el => ({
                    field: el.querySelector('.rule-field').value,
                    operator: el.querySelector('.rule-op').value,
                    value: el.querySelector('.rule-val').value
                }));
                const logic = overlay.querySelector('#fb-logic').value;
                const result = transforms.applyFilters(getFeatures(), rules, logic);
                applyTransform(`Filter (${result.length} results)`, result);
                close();
            };
        }
    });
}

// Deduplicate
async function openDeduplicate() {
    const fields = getFieldNames();
    const html = `
        <div class="form-group"><label>Key fields for dedup</label>
            <div style="max-height:150px;overflow-y:auto;">
                ${fields.map(f => `<label class="checkbox-row"><input type="checkbox" value="${f}"> ${f}</label>`).join('')}
            </div></div>
        <div class="form-group"><label>Keep strategy</label>
            <select id="dd-keep"><option value="first">Keep first</option><option value="last">Keep last</option></select></div>`;

    showModal('Deduplicate', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Apply</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const keyFields = Array.from(overlay.querySelectorAll('input[type=checkbox]:checked')).map(el => el.value);
                if (keyFields.length === 0) return showToast('Select at least one key field', 'warning');
                const { features: result, removed } = transforms.deduplicate(
                    getFeatures(), keyFields, overlay.querySelector('#dd-keep').value
                );
                applyTransform(`Deduplicate (${removed} removed)`, result);
                close();
            };
        }
    });
}

// Join Tool
async function openJoinTool() {
    const fields = getFieldNames();
    const html = `
        <div class="info-box mb-8">Upload a CSV or Excel file to join with the active layer.</div>
        <div class="form-group"><label>Join file</label>
            <input type="file" id="join-file" accept=".csv,.xlsx,.xls,.json"></div>
        <div class="form-group"><label>Active layer key field</label>
            <select id="join-left-key">${fields.map(f => `<option>${f}</option>`).join('')}</select></div>
        <div class="form-group"><label>Join file key field</label>
            <select id="join-right-key" disabled><option>Load file first</option></select></div>
        <div class="form-group"><label>Fields to bring over</label>
            <div id="join-fields-list" style="max-height:150px;overflow-y:auto;">Load file first</div></div>`;

    showModal('Join Tool', html, {
        width: '600px',
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn" disabled>Join</button>',
        onMount: (overlay, close) => {
            let joinRows = [];

            overlay.querySelector('#join-file').onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                try {
                    const { importFile } = await import('./import/importer.js');
                    const ds = await importFile(file);
                    joinRows = ds.type === 'spatial'
                        ? ds.geojson.features.map(f => f.properties)
                        : ds.rows || [];

                    const joinFields = joinRows.length > 0 ? Object.keys(joinRows[0]) : [];
                    overlay.querySelector('#join-right-key').innerHTML = joinFields.map(f => `<option>${f}</option>`).join('');
                    overlay.querySelector('#join-right-key').disabled = false;
                    overlay.querySelector('#join-fields-list').innerHTML = joinFields.map(f =>
                        `<label class="checkbox-row"><input type="checkbox" value="${f}" checked> ${f}</label>`
                    ).join('');
                    overlay.querySelector('.apply-btn').disabled = false;
                    showToast(`Loaded ${joinRows.length} rows from ${file.name}`, 'success');
                } catch (err) {
                    showToast('Failed to load join file: ' + err.message, 'error');
                }
            };

            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const leftKey = overlay.querySelector('#join-left-key').value;
                const rightKey = overlay.querySelector('#join-right-key').value;
                const fieldsToJoin = Array.from(overlay.querySelectorAll('#join-fields-list input:checked')).map(el => el.value);
                const { features: result, matched, unmatched } = transforms.joinData(getFeatures(), joinRows, leftKey, rightKey, fieldsToJoin);
                applyTransform(`Join (${matched} matched, ${unmatched} unmatched)`, result);
                close();
            };
        }
    });
}

// Validation
async function openValidation() {
    const fields = getFieldNames();
    const html = `
        <div id="val-rules"></div>
        <button class="btn btn-sm btn-secondary mt-8" id="val-add">+ Add Rule</button>`;

    showModal('Validation Rules', html, {
        width: '600px',
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Run Validation</button>',
        onMount: (overlay, close) => {
            const container = overlay.querySelector('#val-rules');
            let count = 0;

            const addRule = () => {
                count++;
                container.insertAdjacentHTML('beforeend', `
                    <div class="flex gap-4 items-center mb-8" data-rule="${count}">
                        <select class="val-field" style="flex:1">${fields.map(f => `<option>${f}</option>`).join('')}</select>
                        <select class="val-type" style="flex:1">
                            <option value="required">Required</option>
                            <option value="numeric_range">Numeric Range</option>
                            <option value="allowed_values">Allowed Values</option>
                        </select>
                        <input type="text" class="val-extra" placeholder="min,max or val1,val2" style="flex:1">
                        <button class="btn-icon" onclick="this.parentElement.remove()">✕</button>
                    </div>`);
            };

            addRule();
            overlay.querySelector('#val-add').onclick = addRule;
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const rules = Array.from(container.querySelectorAll('[data-rule]')).map(el => {
                    const rule = {
                        field: el.querySelector('.val-field').value,
                        type: el.querySelector('.val-type').value
                    };
                    const extra = el.querySelector('.val-extra').value;
                    if (rule.type === 'numeric_range' && extra) {
                        const parts = extra.split(',');
                        rule.min = parseFloat(parts[0]) || null;
                        rule.max = parseFloat(parts[1]) || null;
                    }
                    if (rule.type === 'allowed_values' && extra) {
                        rule.values = extra.split(',').map(s => s.trim());
                    }
                    return rule;
                });
                const errors = transforms.validate(getFeatures(), rules);
                showToast(`Validation complete: ${errors.length} errors found`, errors.length > 0 ? 'warning' : 'success');
                if (errors.length > 0) {
                    const detail = errors.slice(0, 20).map(e => `Row ${e.featureIndex}: ${e.message}`).join('\n');
                    showToast(`First errors:\n${detail}`, 'warning', { duration: 10000 });
                }
                close();
            };
        }
    });
}

// Add UID
function addUID() {
    const layer = getActiveLayer();
    if (!layer) return showToast('No active layer', 'warning');
    const result = transforms.addUniqueId(getFeatures(), 'uid', 'uuid');
    applyTransform('Add UID', result);
}

// ============================
// GIS Tool modals
// ============================
async function openBuffer() {
    const layer = getActiveLayer();
    if (!layer || layer.type !== 'spatial') return showToast('Need a spatial layer', 'warning');
    if (typeof turf === 'undefined') return showToast('Turf.js not loaded yet', 'warning');

    const html = `
        <div class="form-group"><label>Buffer distance</label>
            <input type="number" id="buf-dist" value="1" min="0.001" step="0.1"></div>
        <div class="form-group"><label>Units</label>
            <select id="buf-units"><option value="kilometers">Kilometers</option><option value="miles">Miles</option><option value="meters">Meters</option></select></div>
        ${layer.geojson.features.length > 5000 ? '<div class="warning-box">Large dataset — this may be slow.</div>' : ''}`;

    showModal('Buffer', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Buffer</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const dist = parseFloat(overlay.querySelector('#buf-dist').value);
                const units = overlay.querySelector('#buf-units').value;
                close();
                try {
                    const result = await gisTools.bufferFeatures(layer, dist, units);
                    addLayer(result);
                    mapManager.addLayer(result, getLayers().indexOf(result));
                    showToast('Buffer complete', 'success');
                    refreshUI();
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'Buffer'));
                }
            };
        }
    });
}

async function openSimplify() {
    const layer = getActiveLayer();
    if (!layer || layer.type !== 'spatial') return showToast('Need a spatial layer', 'warning');

    const html = `
        <div class="form-group"><label>Tolerance (degrees, e.g., 0.001)</label>
            <input type="number" id="simp-tol" value="0.001" min="0.00001" step="0.0001"></div>`;

    showModal('Simplify Geometries', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Simplify</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const tol = parseFloat(overlay.querySelector('#simp-tol').value);
                close();
                try {
                    const { dataset, stats } = await gisTools.simplifyFeatures(layer, tol);
                    addLayer(dataset);
                    mapManager.addLayer(dataset, getLayers().indexOf(dataset));
                    showToast(`Simplified: ${stats.verticesBefore} → ${stats.verticesAfter} vertices`, 'success');
                    refreshUI();
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'Simplify'));
                }
            };
        }
    });
}

async function openClip() {
    const layer = getActiveLayer();
    if (!layer || layer.type !== 'spatial') return showToast('Need a spatial layer', 'warning');

    showModal('Clip to Current Map Extent', '<p>This will clip features to the current visible map area.</p>', {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Clip</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                close();
                const bounds = mapManager.getBounds();
                if (!bounds) return showToast('Map bounds not available', 'warning');
                const bbox = turf.bboxPolygon([
                    bounds.getWest(), bounds.getSouth(),
                    bounds.getEast(), bounds.getNorth()
                ]);
                try {
                    const result = await gisTools.clipFeatures(layer, bbox.geometry);
                    addLayer(result);
                    mapManager.addLayer(result, getLayers().indexOf(result));
                    showToast(`Clipped: ${result.geojson.features.length} features`, 'success');
                    refreshUI();
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'Clip'));
                }
            };
        }
    });
}

// ============================
// Photo Mapper modal
// ============================
async function openPhotoMapper() {
    const html = `
        <div class="drop-zone" id="photo-drop" style="margin-bottom:16px;">
            <div style="font-size:24px; margin-bottom:8px;">📷</div>
            <p>Drop photos here or click to select</p>
            <input type="file" id="photo-input" multiple accept="image/*" style="display:none">
            <button class="btn btn-primary mt-8" id="photo-btn">Select Photos</button>
        </div>
        <div id="photo-results" class="hidden">
            <div id="photo-stats" class="flex gap-8 mb-8"></div>
            <div id="photo-grid" class="photo-grid"></div>
            <div class="divider"></div>
            <h4>Export Options</h4>
            <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px;">
                <button class="btn btn-primary" id="photo-export-geojson">GeoJSON</button>
                <button class="btn btn-primary" id="photo-export-csv">CSV</button>
                <button class="btn btn-primary" id="photo-export-kml">KML</button>
                <button class="btn btn-primary" id="photo-export-kmz">KMZ (with images)</button>
            </div>
            <div class="form-group mt-8">
                <label class="checkbox-row"><input type="checkbox" id="photo-thumbs" checked> Embed thumbnails (smaller file)</label>
                <label class="checkbox-row"><input type="checkbox" id="photo-originals"> Embed original photos (larger file)</label>
            </div>
        </div>`;

    showModal('Photo Mapper', html, {
        width: '700px',
        onMount: (overlay, close) => {
            const fileInput = overlay.querySelector('#photo-input');
            const dropZone = overlay.querySelector('#photo-drop');

            overlay.querySelector('#photo-btn').onclick = () => fileInput.click();
            dropZone.onclick = () => fileInput.click();

            dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
            dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
            dropZone.addEventListener('drop', e => {
                e.preventDefault();
                dropZone.classList.remove('dragover');
                processPhotoFiles(Array.from(e.dataTransfer.files), overlay);
            });

            fileInput.onchange = () => processPhotoFiles(Array.from(fileInput.files), overlay);

            // Export buttons
            overlay.querySelector('#photo-export-geojson')?.addEventListener('click', async () => {
                const ds = photoMapper.getDataset();
                if (ds) { await exportDataset(ds, 'geojson'); }
            });
            overlay.querySelector('#photo-export-csv')?.addEventListener('click', async () => {
                const ds = photoMapper.getDataset();
                if (ds) { await exportDataset(ds, 'csv'); }
            });
            overlay.querySelector('#photo-export-kml')?.addEventListener('click', async () => {
                const ds = photoMapper.getDataset();
                if (ds) { await exportDataset(ds, 'kml'); }
            });
            overlay.querySelector('#photo-export-kmz')?.addEventListener('click', async () => {
                const ds = photoMapper.getDataset();
                if (!ds) return;
                const useOriginals = overlay.querySelector('#photo-originals').checked;
                await exportDataset(ds, 'kmz', {
                    photos: photoMapper.getPhotosForExport(),
                    embedThumbnails: !useOriginals,
                    skipFieldSelection: true
                });
            });
        }
    });
}

async function processPhotoFiles(files, modalOverlay) {
    const imageFiles = files.filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|tiff?)$/i.test(f.name));
    if (imageFiles.length === 0) {
        showToast('No image files found', 'warning');
        return;
    }

    const progress = showProgressModal('Processing Photos');
    const taskRunner = { throwIfCancelled() {}, updateProgress(p, s) { progress.update(p, s); } };

    try {
        const result = await photoMapper._process(imageFiles, taskRunner);
        progress.close();

        // Show results
        const resultsEl = modalOverlay.querySelector('#photo-results');
        const statsEl = modalOverlay.querySelector('#photo-stats');
        const gridEl = modalOverlay.querySelector('#photo-grid');

        if (resultsEl) resultsEl.classList.remove('hidden');

        statsEl.innerHTML = `
            <span class="badge badge-success">✅ ${result.withGPS} with GPS</span>
            <span class="badge badge-warning">⚠️ ${result.withoutGPS} without GPS</span>
            <span class="badge badge-info">${result.photos.length} total</span>`;

        gridEl.innerHTML = result.photos.map(p => `
            <div class="photo-card ${p.hasGPS ? '' : 'no-gps'}" style="position:relative">
                ${p.thumbnailUrl ? `<img src="${p.thumbnailUrl}" alt="${p.filename}">` : '<div style="height:100px;background:#eee;"></div>'}
                <div class="photo-info">${p.filename}</div>
                ${!p.hasGPS ? '<div style="position:absolute;top:4px;right:4px;background:#d97706;color:white;font-size:9px;padding:1px 4px;border-radius:3px;">No GPS</div>' : ''}
            </div>
        `).join('');

        // Add photos as a layer on the map
        if (result.dataset) {
            addLayer(result.dataset);
            mapManager.addLayer(result.dataset, getLayers().indexOf(result.dataset));
            refreshUI();
        }

        if (result.withoutGPS > 0) {
            showToast(`${result.withoutGPS} photo(s) have no GPS data. They won't appear on the map.`, 'warning');
        }

    } catch (e) {
        progress.close();
        showErrorToast(handleError(e, 'PhotoMapper', 'Process photos'));
    }
}

// ============================
// ArcGIS REST Importer modal
// ============================
async function openArcGISImporter() {
    const html = `
        <div class="wizard-steps" id="arcgis-steps">
            <div class="wizard-step active" data-step="1"><span class="wizard-step-num">1</span><span class="step-text">URL</span></div>
            <div class="wizard-step-line"></div>
            <div class="wizard-step" data-step="2"><span class="wizard-step-num">2</span><span class="step-text">Query</span></div>
            <div class="wizard-step-line"></div>
            <div class="wizard-step" data-step="3"><span class="wizard-step-num">3</span><span class="step-text">Download</span></div>
        </div>

        <div id="arcgis-step1">
            <div class="form-group">
                <label>ArcGIS FeatureServer Layer URL</label>
                <input type="url" id="arcgis-url" placeholder="https://services.arcgis.com/.../FeatureServer/0">
            </div>
            <div class="info-box text-xs mb-8">
                Paste a public ArcGIS REST FeatureServer layer URL. Only publicly accessible layers are supported (no login required).
            </div>
            <button class="btn btn-primary" id="arcgis-validate">Validate & Fetch Metadata</button>
            <div id="arcgis-meta" class="hidden mt-8"></div>
        </div>

        <div id="arcgis-step2" class="hidden">
            <h4>Query Builder</h4>
            <div class="form-group"><label>Where clause</label>
                <input type="text" id="arcgis-where" value="1=1" placeholder="1=1"></div>
            <div class="form-group"><label>Fields to include</label>
                <div id="arcgis-fields" style="max-height:200px; overflow-y:auto;"></div></div>
            <label class="checkbox-row"><input type="checkbox" id="arcgis-geom" checked> Include geometry</label>
            <button class="btn btn-primary mt-8" id="arcgis-download">Download Features</button>
        </div>

        <div id="arcgis-step3" class="hidden">
            <div style="text-align:center;">
                <div class="spinner" style="margin:0 auto 12px;"></div>
                <div id="arcgis-progress-text">Starting download...</div>
                <div class="progress-bar-container mt-8">
                    <div class="progress-bar-fill" id="arcgis-progress-bar" style="width:0%"></div>
                    <div class="progress-bar-text" id="arcgis-progress-pct">0%</div>
                </div>
                <button class="btn btn-secondary btn-sm mt-8" id="arcgis-cancel">Cancel</button>
            </div>
        </div>`;

    showModal('ArcGIS REST Import', html, {
        width: '650px',
        onMount: (overlay, close) => {
            let meta = null;

            overlay.querySelector('#arcgis-validate').onclick = async () => {
                const url = overlay.querySelector('#arcgis-url').value.trim();
                if (!url) return showToast('Enter a URL', 'warning');

                overlay.querySelector('#arcgis-validate').disabled = true;
                overlay.querySelector('#arcgis-validate').textContent = 'Validating...';

                try {
                    meta = await arcgisImporter.fetchMetadata(url);

                    // Show metadata
                    overlay.querySelector('#arcgis-meta').classList.remove('hidden');
                    overlay.querySelector('#arcgis-meta').innerHTML = `
                        <div class="success-box">
                            <strong>✅ ${meta.name}</strong><br>
                            Type: ${meta.geometryType || 'Table'} · Fields: ${meta.fields.length} ·
                            Max/page: ${meta.maxRecordCount}
                            ${meta.totalCount != null ? ` · Total: ${meta.totalCount.toLocaleString()}` : ''}
                        </div>`;

                    // Populate query builder
                    overlay.querySelector('#arcgis-step1').classList.add('hidden');
                    overlay.querySelector('#arcgis-step2').classList.remove('hidden');
                    overlay.querySelectorAll('.wizard-step')[0].classList.remove('active');
                    overlay.querySelectorAll('.wizard-step')[0].classList.add('done');
                    overlay.querySelectorAll('.wizard-step')[1].classList.add('active');

                    overlay.querySelector('#arcgis-fields').innerHTML = meta.fields.map(f =>
                        `<label class="checkbox-row"><input type="checkbox" value="${f.name}" checked> ${f.alias || f.name} <span class="text-xs text-muted">(${f.type})</span></label>`
                    ).join('');

                } catch (e) {
                    const classified = handleError(e, 'ArcGIS', 'Validate URL');
                    overlay.querySelector('#arcgis-meta').classList.remove('hidden');
                    overlay.querySelector('#arcgis-meta').innerHTML = `
                        <div class="error-box">
                            <div class="error-title">${classified.title}</div>
                            <div>${classified.message}</div>
                            <div class="error-guidance">${classified.guidance}</div>
                            ${classified.technical ? `<div class="error-details-toggle" onclick="this.nextElementSibling.classList.toggle('hidden')">Show details</div>
                            <div class="error-technical hidden">${classified.technical}</div>` : ''}
                        </div>`;
                } finally {
                    overlay.querySelector('#arcgis-validate').disabled = false;
                    overlay.querySelector('#arcgis-validate').textContent = 'Validate & Fetch Metadata';
                }
            };

            overlay.querySelector('#arcgis-download').onclick = async () => {
                const selectedFields = Array.from(overlay.querySelectorAll('#arcgis-fields input:checked')).map(el => el.value);
                const where = overlay.querySelector('#arcgis-where').value || '1=1';
                const returnGeometry = overlay.querySelector('#arcgis-geom').checked;

                // Switch to download step
                overlay.querySelector('#arcgis-step2').classList.add('hidden');
                overlay.querySelector('#arcgis-step3').classList.remove('hidden');
                overlay.querySelectorAll('.wizard-step')[1].classList.remove('active');
                overlay.querySelectorAll('.wizard-step')[1].classList.add('done');
                overlay.querySelectorAll('.wizard-step')[2].classList.add('active');

                const progressText = overlay.querySelector('#arcgis-progress-text');
                const progressBar = overlay.querySelector('#arcgis-progress-bar');
                const progressPct = overlay.querySelector('#arcgis-progress-pct');

                const taskHandler = {
                    throwIfCancelled() { if (this._cancelled) { const e = new Error('Cancelled'); e.cancelled = true; throw e; } },
                    updateProgress(p, s) {
                        if (progressBar) progressBar.style.width = p + '%';
                        if (progressPct) progressPct.textContent = Math.round(p) + '%';
                        if (progressText) progressText.textContent = s || '';
                    },
                    _cancelled: false
                };

                overlay.querySelector('#arcgis-cancel').onclick = () => {
                    taskHandler._cancelled = true;
                    arcgisImporter.cancel();
                    showToast('Download cancelled', 'warning');
                    close();
                };

                try {
                    const dataset = await arcgisImporter.downloadFeatures({
                        outFields: selectedFields.length > 0 ? selectedFields : '*',
                        where,
                        returnGeometry
                    }, taskHandler);

                    if (dataset) {
                        addLayer(dataset);
                        mapManager.addLayer(dataset, getLayers().indexOf(dataset));
                        const count = dataset.type === 'spatial' ? dataset.geojson.features.length : dataset.rows.length;
                        showToast(`Imported ${count.toLocaleString()} features from ArcGIS`, 'success');
                        refreshUI();
                    }
                    close();
                } catch (e) {
                    if (e.cancelled) return;
                    const classified = handleError(e, 'ArcGIS', 'Download');
                    showErrorToast(classified);
                    close();
                }
            };
        }
    });
}

// ============================
// Coordinates modal
// ============================
async function openCoordinatesModal() {
    const html = `
        <div class="tabs mb-8">
            <div class="tab active" data-ctab="convert">Convert</div>
            <div class="tab" data-ctab="batch">Batch</div>
        </div>

        <div id="coord-convert">
            <div class="form-group"><label>From format</label>
                <select id="coord-from"><option value="dd">Decimal Degrees</option><option value="dms">DMS</option></select></div>
            <div class="form-group"><label>Input</label>
                <input type="text" id="coord-input" placeholder="40.446195, -79.948862"></div>
            <button class="btn btn-primary btn-sm" id="coord-go">Convert</button>
            <div id="coord-result" class="mt-8 text-mono" style="background:var(--bg);padding:8px;border-radius:4px;"></div>
            <button class="btn btn-sm btn-ghost mt-8 hidden" id="coord-copy">📋 Copy</button>
        </div>

        <div id="coord-batch" class="hidden">
            <div class="form-group"><label>Conversion</label>
                <select id="batch-mode"><option value="dd-dms">DD → DMS</option><option value="dms-dd">DMS → DD</option></select></div>
            <div class="form-group"><label>Paste coordinates (one per line)</label>
                <textarea id="batch-input" rows="6" placeholder="40.446195, -79.948862"></textarea></div>
            <button class="btn btn-primary btn-sm" id="batch-go">Convert All</button>
            <div class="form-group mt-8"><label>Results</label>
                <textarea id="batch-output" rows="6" readonly></textarea></div>
            <button class="btn btn-sm btn-ghost" id="batch-copy">📋 Copy All</button>
        </div>`;

    showModal('Coordinates', html, {
        onMount: (overlay) => {
            // Tab switching
            overlay.querySelectorAll('.tab').forEach(tab => {
                tab.onclick = () => {
                    overlay.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    overlay.querySelector('#coord-convert').classList.toggle('hidden', tab.dataset.ctab !== 'convert');
                    overlay.querySelector('#coord-batch').classList.toggle('hidden', tab.dataset.ctab !== 'batch');
                };
            });

            // Convert
            overlay.querySelector('#coord-go').onclick = () => {
                const from = overlay.querySelector('#coord-from').value;
                const input = overlay.querySelector('#coord-input').value.trim();
                const resultEl = overlay.querySelector('#coord-result');
                const copyBtn = overlay.querySelector('#coord-copy');

                try {
                    if (from === 'dd') {
                        const parts = input.split(',').map(s => parseFloat(s.trim()));
                        if (parts.length < 2 || parts.some(isNaN)) throw new Error('Invalid DD input');
                        const dmsLat = coordUtils.ddToDms(parts[0], false);
                        const dmsLon = coordUtils.ddToDms(parts[1], true);
                        resultEl.textContent = `${dmsLat}, ${dmsLon}`;
                    } else {
                        const parts = input.split(',');
                        const lat = coordUtils.dmsToDd(parts[0]?.trim());
                        const lon = coordUtils.dmsToDd(parts[1]?.trim());
                        if (lat == null || lon == null) throw new Error('Invalid DMS input');
                        resultEl.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                    }
                    copyBtn.classList.remove('hidden');
                } catch (e) {
                    resultEl.textContent = 'Error: ' + e.message;
                }
            };

            overlay.querySelector('#coord-copy').onclick = () => {
                navigator.clipboard?.writeText(overlay.querySelector('#coord-result').textContent);
                showToast('Copied!', 'success', { duration: 1500 });
            };

            // Batch
            overlay.querySelector('#batch-go').onclick = () => {
                const mode = overlay.querySelector('#batch-mode').value;
                const text = overlay.querySelector('#batch-input').value;
                const [from, to] = mode.split('-');
                const results = coordUtils.batchConvert(text, from, to);
                overlay.querySelector('#batch-output').value = results.map(r => r.output || r.error).join('\n');
            };

            overlay.querySelector('#batch-copy').onclick = () => {
                const text = overlay.querySelector('#batch-output').value;
                navigator.clipboard?.writeText(text);
                showToast('Copied!', 'success', { duration: 1500 });
            };
        }
    });
}

// ============================
// Export handler
// ============================
async function doExport(format) {
    const layer = getActiveLayer();
    if (!layer) return showToast('No active layer', 'warning');

    const state = getState();
    let ds = layer;

    if (state.agolCompatMode) {
        const { nameMapping } = checkAGOLCompatibility(layer);
        ds = applyAGOLFixes(layer, nameMapping);
    }

    try {
        await exportDataset(ds, format);
    } catch (e) {
        showErrorToast(handleError(e, 'Export', format));
    }
}

// ============================
// Other handlers
// ============================
async function handleMergeLayers() {
    const layers = getLayers();
    if (layers.length < 2) return showToast('Need at least 2 layers to merge', 'warning');
    const ok = await confirm('Merge Layers', `Merge all ${layers.length} layers into one? A source_file field will be added.`);
    if (!ok) return;
    const merged = mergeDatasets(layers);
    addLayer(merged);
    mapManager.addLayer(merged, getLayers().indexOf(merged));
    showToast(`Merged ${layers.length} layers → ${merged.geojson.features.length} features`, 'success');
    refreshUI();
}

function handleUndo() {
    const entry = undoHistory();
    if (entry) {
        const layer = getLayers().find(l => l.id === entry.layerId);
        if (layer && layer.type === 'spatial') {
            layer.geojson = JSON.parse(JSON.stringify(entry.snapshot));
            import('./core/data-model.js').then(dm => {
                layer.schema = dm.analyzeSchema(layer.geojson);
                mapManager.addLayer(layer, getLayers().indexOf(layer));
                refreshUI();
                showToast('Undo', 'info', { duration: 1500 });
            });
        }
    }
}

function handleRedo() {
    const entry = redoHistory();
    if (entry) {
        const layer = getLayers().find(l => l.id === entry.layerId);
        if (layer && layer.type === 'spatial') {
            layer.geojson = JSON.parse(JSON.stringify(entry.snapshot));
            import('./core/data-model.js').then(dm => {
                layer.schema = dm.analyzeSchema(layer.geojson);
                mapManager.addLayer(layer, getLayers().indexOf(layer));
                refreshUI();
                showToast('Redo', 'info', { duration: 1500 });
            });
        }
    }
}

function showDataTable() {
    const layer = getActiveLayer();
    if (!layer) return;

    const features = layer.type === 'spatial' ? layer.geojson.features : [];
    const rows = features.length > 0
        ? features.slice(0, 200).map(f => f.properties)
        : (layer.rows || []).slice(0, 200);

    if (rows.length === 0) return showToast('No data to show', 'warning');

    const fields = Object.keys(rows[0] || {});
    const headerHtml = fields.map(f => `<th>${f}</th>`).join('');
    const bodyHtml = rows.map(r =>
        `<tr>${fields.map(f => `<td>${r[f] ?? ''}</td>`).join('')}</tr>`
    ).join('');

    const html = `
        <div class="text-xs text-muted mb-8">Showing first ${rows.length} of ${layer.schema?.featureCount || rows.length} rows</div>
        <div class="data-table-wrap" style="max-height:400px;">
            <table class="data-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>
        </div>`;

    showModal(`Data: ${layer.name}`, html, { width: '90vw' });
}

// ============================
// Field management
// ============================
function toggleField(fieldName, selected) {
    const layer = getActiveLayer();
    if (!layer) return;
    const field = layer.schema?.fields?.find(f => f.name === fieldName);
    if (field) {
        field.selected = selected;
        renderOutputPanel();
    }
}

function selectAllFields(selected) {
    const layer = getActiveLayer();
    if (!layer) return;
    for (const f of (layer.schema?.fields || [])) f.selected = selected;
    renderFieldList();
    renderOutputPanel();
}

function filterFields(query) {
    const items = document.querySelectorAll('.field-list-items .field-item');
    const q = query.toLowerCase();
    items.forEach(el => {
        const name = el.dataset.field?.toLowerCase() || '';
        el.style.display = name.includes(q) ? '' : 'none';
    });
}

function fixAGOL() {
    const layer = getActiveLayer();
    if (!layer) return;
    const { nameMapping } = checkAGOLCompatibility(layer);
    const fixed = applyAGOLFixes(layer, nameMapping);
    Object.assign(layer, fixed);
    import('./core/data-model.js').then(dm => {
        layer.schema = dm.analyzeSchema(layer.geojson);
        refreshUI();
        showToast('AGOL fixes applied', 'success');
    });
}

// ============================
// Section toggle
// ============================
window.toggleSection = function(header) {
    header.classList.toggle('collapsed');
    const body = header.nextElementSibling;
    if (body) body.classList.toggle('hidden');
};

// ============================
// Global app API (for onclick handlers in HTML)
// ============================
window.app = {
    setActiveLayer: (id) => { setActiveLayer(id); refreshUI(); },
    toggleVisibility: (id) => { toggleLayerVisibility(id); mapManager.toggleLayer(id, getLayers().find(l => l.id === id)?.visible); renderLayerList(); },
    zoomToLayer: (id) => {
        const layer = mapManager.dataLayers.get(id);
        if (layer) {
            try { mapManager.getMap().fitBounds(layer.getBounds(), { padding: [30, 30] }); } catch(_) {}
        }
    },
    removeLayer: async (id) => {
        const ok = await confirm('Remove Layer', 'Remove this layer?');
        if (ok) { removeLayer(id); mapManager.removeLayer(id); refreshUI(); }
    },
    toggleField, selectAllFields, filterFields,
    doExport,
    fixAGOL,
    showDataTable,
    openSplitColumn,
    openCombineColumns,
    openTemplateBuilder,
    openReplaceClean,
    openTypeConvert,
    openFilterBuilder,
    openDeduplicate,
    openJoinTool,
    openValidation,
    addUID,
    openBuffer,
    openSimplify,
    openClip,
    openPhotoMapper: openPhotoMapper,
    openArcGISImporter: openArcGISImporter,
    openCoordinatesModal: openCoordinatesModal
};

// Subscribe to logs for panel updates
logger.subscribe(() => {
    if (!document.getElementById('logs-panel')?.classList.contains('hidden')) {
        renderLogs();
    }
});

// Setup logs toolbar
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('logs-search');
    const levelSelect = document.getElementById('logs-level');
    if (searchInput) {
        searchInput.oninput = () => renderLogs({ search: searchInput.value, level: levelSelect?.value });
    }
    if (levelSelect) {
        levelSelect.onchange = () => renderLogs({ search: searchInput?.value, level: levelSelect.value });
    }
    document.getElementById('logs-copy')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(logger.toText());
        showToast('Logs copied', 'success', { duration: 1500 });
    });
    document.getElementById('logs-download')?.addEventListener('click', () => {
        const blob = new Blob([logger.toJSON()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `gis-toolbox-logs-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });
    document.getElementById('logs-clear')?.addEventListener('click', () => {
        logger.clear();
        renderLogs();
    });

    // Render initial data prep tools in left panel
    const dataPrepContainer = document.getElementById('dataprep-tools');
    if (dataPrepContainer) {
        dataPrepContainer.innerHTML = renderDataPrepTools();
    }
});
