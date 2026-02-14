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
function boot() {
    logger.info('App', 'Initializing GIS Toolbox');
    initMap();
    setupEventListeners();
    setupDragDrop();
    checkMobile();
    window.addEventListener('resize', checkMobile);
    // Ensure Leaflet recalculates size after layout settles
    setTimeout(() => { mapManager.map?.invalidateSize(); }, 100);
    logger.info('App', 'App ready');

    // Show tool guide splash on every app open
    setTimeout(() => showToolInfo(), 300);
}
// Handle both: module loaded before or after DOMContentLoaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

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
// Drag & Drop file import (global — works anywhere in the app)
// ============================
function setupDragDrop() {
    let dragCounter = 0;

    // Create full-screen drop overlay
    const overlay = document.createElement('div');
    overlay.id = 'global-drop-overlay';
    overlay.innerHTML = '<div class="drop-overlay-content">📂<br>Drop files to import</div>';
    document.body.appendChild(overlay);

    // Prevent default browser behavior for all drag events on the document
    document.addEventListener('dragover', e => { e.preventDefault(); });
    document.addEventListener('dragenter', e => {
        e.preventDefault();
        dragCounter++;
        overlay.classList.add('visible');
    });
    document.addEventListener('dragleave', e => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            overlay.classList.remove('visible');
        }
    });
    document.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragCounter = 0;
        overlay.classList.remove('visible');

        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length === 0) return;

        // Separate image files from data files
        const imageFiles = files.filter(f =>
            f.type.startsWith('image/') ||
            /\.(jpe?g|png|heic|heif|tiff?|webp)$/i.test(f.name)
        );
        const dataFiles = files.filter(f => !imageFiles.includes(f));

        // Import data files (GIS formats)
        if (dataFiles.length > 0) {
            await handleFileImport(dataFiles);
        }
        // Import image files (photo mapper)
        if (imageFiles.length > 0) {
            const result = await photoMapper.processPhotos(imageFiles);
            if (result?.dataset) {
                addLayer(result.dataset);
                mapManager.addLayer(result.dataset, getLayers().indexOf(result.dataset));
                refreshUI();
                showToast(`Mapped ${result.withGPS} photo(s) with GPS`, 'success');
            }
            if (result?.withoutGPS > 0) {
                showToast(`${result.withoutGPS} photo(s) have no GPS data`, 'warning');
            }
        }
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
    // Import button — use a persistent hidden input (iOS-safe)
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.multiple = true;
    importInput.accept = '.geojson,.json,.csv,.tsv,.txt,.xlsx,.xls,.kml,.kmz,.zip,.xml';
    importInput.style.cssText = 'opacity:0;position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;';
    document.body.appendChild(importInput);
    importInput.addEventListener('change', () => {
        if (importInput.files.length > 0) {
            const files = Array.from(importInput.files);
            handleFileImport(files);
        }
    });
    document.getElementById('btn-import')?.addEventListener('click', () => {
        importInput.value = ''; // reset so re-selecting same files triggers change
        importInput.click();
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

    // Info / Tool Guide
    document.getElementById('btn-info')?.addEventListener('click', showToolInfo);

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
        const panel = document.querySelector('.panel-left');
        panel?.classList.toggle('collapsed');
        const isCollapsed = panel?.classList.contains('collapsed');
        document.getElementById('expand-left-panel')?.classList.toggle('hidden', !isCollapsed);
        document.getElementById('toggle-left-panel').textContent = isCollapsed ? '▶' : '◀';
        setTimeout(() => { mapManager.map?.invalidateSize(); }, 250);
    });
    document.getElementById('expand-left-panel')?.addEventListener('click', () => {
        document.querySelector('.panel-left')?.classList.remove('collapsed');
        document.getElementById('expand-left-panel')?.classList.add('hidden');
        document.getElementById('toggle-left-panel').textContent = '◀';
        setTimeout(() => { mapManager.map?.invalidateSize(); }, 250);
    });
    document.getElementById('toggle-right-panel')?.addEventListener('click', () => {
        const panel = document.querySelector('.panel-right');
        panel?.classList.toggle('collapsed');
        const isCollapsed = panel?.classList.contains('collapsed');
        document.getElementById('expand-right-panel')?.classList.toggle('hidden', !isCollapsed);
        document.getElementById('toggle-right-panel').textContent = isCollapsed ? '◀' : '▶';
        setTimeout(() => { mapManager.map?.invalidateSize(); }, 250);
    });
    document.getElementById('expand-right-panel')?.addEventListener('click', () => {
        document.querySelector('.panel-right')?.classList.remove('collapsed');
        document.getElementById('expand-right-panel')?.classList.add('hidden');
        document.getElementById('toggle-right-panel').textContent = '▶';
        setTimeout(() => { mapManager.map?.invalidateSize(); }, 250);
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
                    <div class="layer-name" ondblclick="event.stopPropagation(); window.app.renameLayer('${layer.id}', this)">${layer.name}</div>
                    <div class="layer-meta">${count} · ${layer.schema?.fields?.length || 0} fields ${geomBadge}</div>
                </div>
                <div class="layer-actions">
                    <button class="btn-icon" title="Rename" onclick="window.app.renameLayer('${layer.id}')">✏️</button>
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
        <button class="btn btn-sm btn-primary" onclick="window.app.addField()" title="Add new field">+ Field</button>
    </div>`;

    const fieldRows = fields.map(f => `
        <div class="field-item" data-field="${f.name}">
            <input type="checkbox" ${f.selected ? 'checked' : ''} onchange="window.app.toggleField('${f.name}', this.checked)">
            <span class="field-name" ondblclick="window.app.renameField('${f.name}', this)" title="Double-click to rename">${f.outputName || f.name}</span>
            <span class="field-type">${f.type}</span>
            <button class="btn-icon" style="font-size:10px;padding:2px;" title="Rename field" onclick="window.app.renameField('${f.name}')">✏️</button>
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
    if (tab === 'map') {
        // All panels hidden — map is visible underneath
        // Recalculate map size in case container was obscured
        setTimeout(() => { mapManager.map?.invalidateSize(); }, 50);
        return;
    }
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

    let html = `<h3>Layers</h3>`;
    if (layers.length === 0) {
        html += `<div class="empty-state"><p>No layers loaded</p>
            <button class="btn btn-primary btn-sm" id="btn-import-mobile">📂 Import Files</button></div>`;
    } else {
        html += `<div style="display:flex;flex-direction:column;gap:2px;">`;
        html += layers.map(l => `
            <div class="layer-item ${l.id === layer?.id ? 'active' : ''}" onclick="window.app.setActiveLayer('${l.id}')">
                <span style="font-size:14px">${l.type === 'spatial' ? '🗺️' : '📊'}</span>
                <div class="layer-info">
                    <div class="layer-name">${l.name}</div>
                    <div class="layer-meta">${l.schema?.featureCount || 0} items · ${l.schema?.fields?.length || 0} fields</div>
                </div>
            </div>
        `).join('');
        html += `</div>`;
    }

    if (layer) {
        html += `<h3 style="margin-top:10px;">Fields</h3>`;
        html += `<div style="display:flex;flex-direction:column;gap:1px;">`;
        html += (layer.schema?.fields || []).map(f => `
            <div class="field-item">
                <input type="checkbox" ${f.selected ? 'checked' : ''} onchange="window.app.toggleField('${f.name}', this.checked)">
                <span class="field-name">${f.name}</span>
                <span class="field-type">${f.type}</span>
            </div>
        `).join('');
        html += `</div>`;
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
        <h3>Data Prep</h3>
        <div style="display:flex;flex-wrap:wrap;gap:4px;">
            <button class="btn btn-secondary btn-sm" onclick="window.app.openSplitColumn()">Split Column</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openCombineColumns()">Combine</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openTemplateBuilder()">Template</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openReplaceClean()">Replace/Clean</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openTypeConvert()">Type Convert</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openFilterBuilder()">Filter</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openDeduplicate()">Dedup</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openJoinTool()">Join</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openValidation()">Validate</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.addUID()">Add UID</button>
        </div>`;
}

function renderMobileToolsPanel() {
    const el = document.getElementById('mobile-tools');
    if (!el) return;
    const basemapOptions = [
        { value: 'osm', label: 'Street Map' },
        { value: 'light', label: 'Light / Gray' },
        { value: 'dark', label: 'Dark' },
        { value: 'voyager', label: 'Voyager' },
        { value: 'topo', label: 'Topographic' },
        { value: 'satellite', label: 'Satellite' },
        { value: 'hybrid', label: 'Hybrid' },
        { value: 'none', label: 'No Basemap' }
    ];
    const currentBasemap = document.getElementById('basemap-select')?.value || 'osm';
    const layers = getLayers();
    el.innerHTML = `
        <h3>GIS Tools</h3>
        <div style="display:flex;flex-wrap:wrap;gap:4px;">
            ${layers.length >= 2 ? '<button class="btn btn-primary btn-sm" onclick="window.app.mergeLayers()">🔗 Merge Layers</button>' : ''}
            <button class="btn btn-secondary btn-sm" onclick="window.app.openBuffer()">Buffer</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openSimplify()">Simplify</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openClip()">Clip to Extent</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openPhotoMapper()">📷 Photo Map</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openArcGISImporter()">🌐 ArcGIS REST</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openCoordinatesModal()">📍 Coordinates</button>
        </div>
        <h3 style="margin-top:10px;">Basemap</h3>
        <select id="basemap-select-mobile" style="width:100%;">
            ${basemapOptions.map(o => `<option value="${o.value}" ${o.value === currentBasemap ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>`;
    el.querySelector('#basemap-select-mobile')?.addEventListener('change', (e) => {
        mapManager.setBasemap(e.target.value);
        const desktopSelect = document.getElementById('basemap-select');
        if (desktopSelect) desktopSelect.value = e.target.value;
    });
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
        <h3>Export</h3>
        <label class="toggle mb-8">
            <input type="checkbox" id="agol-toggle-mobile" ${getState().agolCompatMode ? 'checked' : ''}>
            <span class="toggle-track"></span>
            <span>AGOL Compatible</span>
        </label>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;">
            ${formats.map(f =>
                `<button class="btn btn-primary btn-sm" onclick="window.app.doExport('${f.key}')">${f.label}</button>`
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
            <p>Drop photos here or tap to select</p>
            <input type="file" id="photo-input" multiple accept="image/*,.jpg,.jpeg,.png,.heic,.heif,.tiff,.tif"
                   style="opacity:0;position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;">
            <button class="btn btn-primary mt-8" id="photo-btn">Select Photos</button>
        </div>
        <div class="info-box text-xs mb-8" style="color:var(--text-muted);">
            📍 Photos must contain embedded GPS/geolocation metadata (EXIF) to be placed on the map. Most smartphone cameras save location automatically when location services are enabled. Photos without GPS data will still be listed but won't appear on the map.
        </div>
        <div id="photo-results" class="hidden">
            <div id="photo-stats" class="flex gap-8 mb-8"></div>
            <div id="photo-grid" class="photo-grid"></div>
            <div class="form-group mt-8">
                <label class="checkbox-row"><input type="radio" name="photo-size" value="thumbnail" checked> Thumbnails (smaller, faster)</label>
                <label class="checkbox-row"><input type="radio" name="photo-size" value="full"> Full-size originals (larger file)</label>
            </div>
            <div style="text-align:right; margin-top:12px;">
                <button class="btn btn-primary" id="photo-ok-btn">OK — Add to Map</button>
            </div>
        </div>`;

    showModal('Photo Mapper', html, {
        width: '700px',
        onMount: (overlay, close) => {
            const fileInput = overlay.querySelector('#photo-input');
            const dropZone = overlay.querySelector('#photo-drop');

            // Prevent double-click: button is inside drop zone, so stop propagation
            overlay.querySelector('#photo-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                fileInput.value = '';
                fileInput.click();
            });
            dropZone.addEventListener('click', (e) => {
                if (e.target === dropZone || e.target.tagName === 'P' || e.target.tagName === 'DIV') {
                    fileInput.value = '';
                    fileInput.click();
                }
            });

            dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
            dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
            dropZone.addEventListener('drop', e => {
                e.preventDefault();
                dropZone.classList.remove('dragover');
                processPhotoFiles(Array.from(e.dataTransfer.files), overlay);
            });

            fileInput.addEventListener('change', () => {
                if (fileInput.files.length > 0) {
                    const files = Array.from(fileInput.files);
                    processPhotoFiles(files, overlay);
                }
            });

            // OK button — store size preference and close
            overlay.querySelector('#photo-ok-btn')?.addEventListener('click', () => {
                const useFullSize = overlay.querySelector('input[name="photo-size"][value="full"]')?.checked;
                // Store the preference so exports can use it
                photoMapper._useFullSize = !!useFullSize;
                close();
                showToast('Photos added to map. Use Export to save in any format.', 'success');
            });
        }
    });
}

async function processPhotoFiles(files, modalOverlay) {
    // Broad filter — iOS may report no type for some images
    const imageFiles = files.filter(f =>
        f.type.startsWith('image/') ||
        /\.(jpe?g|png|heic|heif|tiff?|webp|bmp|gif)$/i.test(f.name) ||
        (!f.type && f.size > 0) // iOS sometimes gives no MIME type — let it through
    );
    if (imageFiles.length === 0) {
        showToast('No image files found', 'warning');
        return;
    }

    logger.info('PhotoMapper', 'processPhotoFiles called', {
        count: imageFiles.length,
        names: imageFiles.map(f => f.name).join(', '),
        types: imageFiles.map(f => f.type || 'none').join(', ')
    });

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
        <div class="tabs mb-8" id="arcgis-tabs">
            <div class="tab" data-atab="catalog">Catalog</div>
            <div class="tab active" data-atab="direct">Direct URL</div>
            <div class="tab" data-atab="browse">Browse & Add</div>
        </div>

        <!-- ======== CATALOG TAB ======== -->
        <div id="arcgis-tab-catalog" class="hidden">
            <div class="info-box text-xs mb-8">
                Saved service endpoints. Scan new services in the <strong>Browse & Add</strong> tab to add them here.
            </div>
            <div class="input-with-btn" style="margin-bottom:8px;">
                <input type="search" id="catalog-search" placeholder="Search catalog...">
                <span id="catalog-count" class="text-xs text-muted" style="white-space:nowrap;"></span>
            </div>
            <div id="catalog-list" style="max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:6px;"></div>
            <div id="catalog-empty" class="hidden" style="text-align:center;padding:24px 0;">
                <div class="text-muted">No saved endpoints yet.</div>
                <div class="text-xs text-muted mt-8">Use the <strong>Browse & Add</strong> tab to scan a REST services directory and save it.</div>
            </div>
        </div>

        <!-- ======== DIRECT URL TAB ======== -->
        <div id="arcgis-tab-direct">
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
        </div>
        </div>

        <!-- ======== BROWSE SERVICES TAB ======== -->
        <div id="arcgis-tab-browse" class="hidden">
            <div class="form-group">
                <label>ArcGIS REST Services Directory</label>
                <select id="browse-preset" style="margin-bottom:6px;">
                    <option value="">— Choose a preset or enter custom URL —</option>
                    <option value="https://central.udot.utah.gov/server/rest/services">UDOT Central Server</option>
                    <option value="https://services.arcgis.com/pA2nEVnB6tquxgOW/arcgis/rest/services">UDOT ArcGIS Online</option>
                    <option value="custom">Custom URL...</option>
                </select>
                <input type="url" id="browse-url" placeholder="https://services.arcgis.com/orgId/arcgis/rest/services/" class="hidden">
            </div>
            <div class="info-box text-xs mb-8">
                Select a preset endpoint or enter a custom REST services directory URL. The tool will scan all folders and list every available Feature/Map Server layer.
            </div>

            <div style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;background:var(--bg-surface);">
                <div style="font-weight:600;font-size:12px;color:var(--text-muted);margin-bottom:6px;">Keyword Filter (applied after scan)</div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                    <input type="text" id="browse-keyword" placeholder="e.g. traffic, roads, bridges..." style="flex:1;min-width:140px;">
                    <select id="browse-match-mode" style="width:auto;">
                        <option value="contains">Contains</option>
                        <option value="exact">Exact Match</option>
                        <option value="starts">Starts With</option>
                        <option value="ends">Ends With</option>
                        <option value="not">Does NOT Contain</option>
                    </select>
                </div>
            </div>

            <button class="btn btn-primary" id="browse-scan">Scan Services</button>
            <div id="browse-status" class="text-xs text-muted mt-8" style="min-height:18px;"></div>
            <button class="btn btn-secondary btn-sm hidden mt-8" id="browse-save-catalog">💾 Save to Catalog</button>

            <div id="browse-results" class="hidden mt-8">
                <div class="input-with-btn" style="margin-bottom:8px;">
                    <input type="search" id="browse-search" placeholder="Quick filter results...">
                    <span id="browse-count" class="text-xs text-muted" style="white-space:nowrap;"></span>
                </div>
                <div id="browse-list" style="max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:2px;"></div>
            </div>
        </div>`;

    showModal('ArcGIS REST Import', html, {
        width: '750px',
        onMount: (overlay, close) => {
            let meta = null;

            // ---- Catalog persistence ----
            const CATALOG_KEY = 'gis-toolbox-arcgis-catalog';

            function loadCatalog() {
                try { return JSON.parse(localStorage.getItem(CATALOG_KEY)) || []; }
                catch (_) { return []; }
            }

            function saveCatalog(catalog) {
                localStorage.setItem(CATALOG_KEY, JSON.stringify(catalog));
            }

            const geomIcon = (gt) => {
                if (!gt || gt === 'Table') return '📊';
                if (gt === 'Point' || gt === 'MultiPoint') return '📍';
                if (gt === 'LineString' || gt === 'MultiLineString' || gt.includes('line') || gt.includes('Line')) return '📏';
                if (gt === 'Polygon' || gt === 'MultiPolygon' || gt.includes('olygon')) return '🔷';
                return '📎';
            };

            // Format metadata subtitle for a layer
            const metaLine = (l) => {
                const parts = [l.serviceName, l.serviceType, l.geometryType || 'Table'];
                if (l.author) parts.push(`👤 ${l.author}`);
                if (l.copyright) parts.push(`© ${l.copyright}`);
                if (l.lastEditDate) {
                    const d = new Date(l.lastEditDate);
                    if (!isNaN(d)) parts.push(`✏️ ${d.toLocaleDateString()}`);
                }
                return parts.join(' · ');
            };

            const metaTooltip = (l) => {
                const lines = [l.url];
                if (l.description) lines.push(l.description.replace(/<[^>]*>/g, '').substring(0, 200));
                if (l.author) lines.push('Author: ' + l.author);
                if (l.copyright) lines.push('Copyright: ' + l.copyright);
                if (l.lastEditDate) {
                    const d = new Date(l.lastEditDate);
                    if (!isNaN(d)) lines.push('Last edited: ' + d.toLocaleDateString());
                }
                if (l.capabilities) lines.push('Capabilities: ' + l.capabilities);
                if (l.serverVersion) lines.push('Server: v' + l.serverVersion);
                return lines.join('\n');
            };

            // ---- Tab switching ----
            overlay.querySelectorAll('#arcgis-tabs .tab').forEach(tab => {
                tab.onclick = () => {
                    overlay.querySelectorAll('#arcgis-tabs .tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    const which = tab.dataset.atab;
                    overlay.querySelector('#arcgis-tab-catalog').classList.toggle('hidden', which !== 'catalog');
                    overlay.querySelector('#arcgis-tab-direct').classList.toggle('hidden', which !== 'direct');
                    overlay.querySelector('#arcgis-tab-browse').classList.toggle('hidden', which !== 'browse');
                    if (which === 'catalog') renderCatalog();
                };
            });

            // ---- Catalog Tab ----
            function renderCatalog(filter = '') {
                const catalog = loadCatalog();
                const q = filter.toLowerCase();
                const emptyEl = overlay.querySelector('#catalog-empty');
                const listEl = overlay.querySelector('#catalog-list');
                const countEl = overlay.querySelector('#catalog-count');

                if (catalog.length === 0) {
                    emptyEl.classList.remove('hidden');
                    listEl.innerHTML = '';
                    countEl.textContent = '';
                    return;
                }
                emptyEl.classList.add('hidden');

                // Filter across sources and their layers
                let totalLayers = 0;
                const filteredCatalog = catalog.map(src => {
                    const filteredLayers = q ? src.layers.filter(l =>
                        l.name.toLowerCase().includes(q) ||
                        l.serviceName.toLowerCase().includes(q) ||
                        src.label.toLowerCase().includes(q)
                    ) : src.layers;
                    totalLayers += filteredLayers.length;
                    return { ...src, filteredLayers };
                }).filter(src => q ? src.filteredLayers.length > 0 : true);

                countEl.textContent = `${totalLayers} layer(s) in ${filteredCatalog.length} source(s)`;

                listEl.innerHTML = filteredCatalog.map((src, si) => `
                    <div class="catalog-source" style="border:1px solid var(--border);border-radius:6px;overflow:hidden;">
                        <div class="catalog-source-header" data-src="${si}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-surface);cursor:pointer;user-select:none;">
                            <span class="catalog-arrow" style="font-size:10px;transition:transform .2s;">▶</span>
                            <div style="flex:1;min-width:0;">
                                <div style="font-weight:600;font-size:13px;color:var(--gold-light);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${src.url}">${src.label}</div>
                                <div style="font-size:11px;color:var(--text-muted);">${src.filteredLayers.length} layers · Scanned ${new Date(src.scannedAt).toLocaleDateString()}</div>
                            </div>
                            <button class="btn btn-sm btn-ghost catalog-rescan-btn" data-url="${src.url}" title="Rescan" style="font-size:14px;">🔄</button>
                            <button class="btn btn-sm btn-ghost catalog-remove-btn" data-url="${src.url}" title="Remove" style="font-size:14px;">🗑️</button>
                        </div>
                        <div class="catalog-source-layers hidden" data-src-layers="${si}" style="display:flex;flex-direction:column;gap:2px;padding:4px 6px;max-height:50vh;overflow-y:auto;">
                            ${src.filteredLayers.map(l => `
                                <div style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--bg);" title="${metaTooltip(l).replace(/"/g, '&quot;')}">
                                    <span style="font-size:14px;">${geomIcon(l.geometryType)}</span>
                                    <div style="flex:1;min-width:0;">
                                        <div style="font-weight:600;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${l.name}</div>
                                        <div style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${metaLine(l)}</div>
                                    </div>
                                    <button class="btn btn-sm btn-primary catalog-import-btn" data-url="${l.url}" style="flex-shrink:0;font-size:11px;padding:2px 8px;">Import</button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `).join('');

                // Toggle source expand/collapse
                listEl.querySelectorAll('.catalog-source-header').forEach(header => {
                    header.onclick = (e) => {
                        if (e.target.closest('.catalog-rescan-btn') || e.target.closest('.catalog-remove-btn')) return;
                        const idx = header.dataset.src;
                        const layersEl = listEl.querySelector(`[data-src-layers="${idx}"]`);
                        const arrow = header.querySelector('.catalog-arrow');
                        const isOpen = !layersEl.classList.contains('hidden');
                        layersEl.classList.toggle('hidden');
                        arrow.style.transform = isOpen ? '' : 'rotate(90deg)';
                    };
                });

                // Remove buttons
                listEl.querySelectorAll('.catalog-remove-btn').forEach(btn => {
                    btn.onclick = (e) => {
                        e.stopPropagation();
                        const catalog = loadCatalog();
                        const updated = catalog.filter(s => s.url !== btn.dataset.url);
                        saveCatalog(updated);
                        renderCatalog(overlay.querySelector('#catalog-search')?.value || '');
                        showToast('Removed from catalog', 'info', { duration: 1500 });
                    };
                });

                // Rescan buttons
                listEl.querySelectorAll('.catalog-rescan-btn').forEach(btn => {
                    btn.onclick = async (e) => {
                        e.stopPropagation();
                        btn.disabled = true;
                        btn.textContent = '⏳';
                        try {
                            const layers = await arcgisImporter.browseServices(btn.dataset.url);
                            const catalog = loadCatalog();
                            const entry = catalog.find(s => s.url === btn.dataset.url);
                            if (entry) {
                                entry.layers = layers;
                                entry.scannedAt = new Date().toISOString();
                                saveCatalog(catalog);
                            }
                            showToast(`Rescanned: ${layers.length} layers found`, 'success', { duration: 2000 });
                            renderCatalog(overlay.querySelector('#catalog-search')?.value || '');
                        } catch (err) {
                            showToast('Rescan failed: ' + err.message, 'error');
                            btn.textContent = '🔄';
                            btn.disabled = false;
                        }
                    };
                });

                // Import buttons
                wireImportButtons(listEl.querySelectorAll('.catalog-import-btn'));
            }

            function wireImportButtons(buttons) {
                buttons.forEach(btn => {
                    btn.onclick = async (e) => {
                        e.stopPropagation();
                        const layerUrl = btn.dataset.url;
                        btn.disabled = true;
                        btn.textContent = 'Loading...';
                        try {
                            const layerMeta = await arcgisImporter.fetchMetadata(layerUrl);
                            const dataset = await arcgisImporter.downloadFeatures({
                                outFields: '*', where: '1=1', returnGeometry: true
                            }, {
                                throwIfCancelled() {},
                                updateProgress(p, s) { btn.textContent = s || `${Math.round(p)}%`; },
                                _cancelled: false
                            });
                            if (dataset) {
                                addLayer(dataset);
                                mapManager.addLayer(dataset, getLayers().indexOf(dataset));
                                const count = dataset.type === 'spatial' ? dataset.geojson.features.length : dataset.rows.length;
                                showToast(`Imported ${count.toLocaleString()} features: ${layerMeta.name}`, 'success');
                                refreshUI();
                            }
                            btn.textContent = '✅ Done';
                            btn.classList.remove('btn-primary');
                            btn.classList.add('btn-secondary');
                        } catch (err) {
                            btn.textContent = '❌ Error';
                            showErrorToast(handleError(err, 'ArcGIS', 'Import'));
                        }
                    };
                });
            }

            // Catalog search
            overlay.querySelector('#catalog-search')?.addEventListener('input', (e) => {
                renderCatalog(e.target.value);
            });

            // Show catalog on open if it has entries
            const existingCatalog = loadCatalog();
            if (existingCatalog.length > 0) {
                // Auto-switch to catalog tab
                overlay.querySelectorAll('#arcgis-tabs .tab').forEach(t => t.classList.remove('active'));
                overlay.querySelector('[data-atab="catalog"]').classList.add('active');
                overlay.querySelector('#arcgis-tab-direct').classList.add('hidden');
                overlay.querySelector('#arcgis-tab-catalog').classList.remove('hidden');
                renderCatalog();
            }

            // ---- Browse Services ----
            let browseResults = [];

            // Preset dropdown wiring
            const presetSelect = overlay.querySelector('#browse-preset');
            const browseUrlInput = overlay.querySelector('#browse-url');
            presetSelect.addEventListener('change', () => {
                const val = presetSelect.value;
                if (val === 'custom') {
                    browseUrlInput.classList.remove('hidden');
                    browseUrlInput.value = '';
                    browseUrlInput.focus();
                } else {
                    browseUrlInput.classList.add('hidden');
                    browseUrlInput.value = val; // sync hidden input with preset value
                }
            });

            // Keyword filter re-renders on input
            overlay.querySelector('#browse-keyword')?.addEventListener('input', () => {
                if (browseResults.length > 0) {
                    renderBrowseList(overlay, browseResults, overlay.querySelector('#browse-search')?.value || '');
                }
            });
            overlay.querySelector('#browse-match-mode')?.addEventListener('change', () => {
                if (browseResults.length > 0) {
                    renderBrowseList(overlay, browseResults, overlay.querySelector('#browse-search')?.value || '');
                }
            });

            overlay.querySelector('#browse-scan').onclick = async () => {
                // Resolve URL from preset or custom input
                let url;
                if (presetSelect.value === 'custom' || presetSelect.value === '') {
                    url = browseUrlInput.value.trim();
                } else {
                    url = presetSelect.value;
                }
                if (!url) return showToast('Select a preset or enter a services directory URL', 'warning');

                const scanBtn = overlay.querySelector('#browse-scan');
                const statusEl = overlay.querySelector('#browse-status');
                scanBtn.disabled = true;
                scanBtn.textContent = 'Scanning...';
                statusEl.textContent = 'Connecting...';
                overlay.querySelector('#browse-results').classList.add('hidden');
                browseResults = [];

                try {
                    browseResults = await arcgisImporter.browseServices(url, (msg) => {
                        statusEl.textContent = msg;
                    });

                    if (browseResults.length === 0) {
                        statusEl.textContent = 'No Feature Server/Map Server layers found at this URL.';
                    } else {
                        statusEl.textContent = `Found ${browseResults.length} layer(s)`;
                        overlay.querySelector('#browse-results').classList.remove('hidden');
                        renderBrowseList(overlay, browseResults, '');
                    }
                } catch (e) {
                    const classified = handleError(e, 'ArcGIS', 'Browse Services');
                    statusEl.innerHTML = `<span style="color:var(--error);">${classified.message}</span>`;
                } finally {
                    scanBtn.disabled = false;
                    scanBtn.textContent = 'Scan Services';
                }
            };

            // Search/filter browse results
            overlay.querySelector('#browse-search')?.addEventListener('input', (e) => {
                renderBrowseList(overlay, browseResults, e.target.value);
            });

            function renderBrowseList(overlay, items, filter) {
                const q = filter.toLowerCase();

                // Keyword + match mode filtering
                const keyword = (overlay.querySelector('#browse-keyword')?.value || '').trim().toLowerCase();
                const matchMode = overlay.querySelector('#browse-match-mode')?.value || 'contains';

                let keywordFiltered = items;
                if (keyword) {
                    keywordFiltered = items.filter(l => {
                        const haystack = (l.name + ' ' + l.serviceName).toLowerCase();
                        switch (matchMode) {
                            case 'exact':   return l.name.toLowerCase() === keyword || l.serviceName.toLowerCase() === keyword;
                            case 'starts':  return l.name.toLowerCase().startsWith(keyword) || l.serviceName.toLowerCase().startsWith(keyword);
                            case 'ends':    return l.name.toLowerCase().endsWith(keyword) || l.serviceName.toLowerCase().endsWith(keyword);
                            case 'not':     return !haystack.includes(keyword);
                            case 'contains':
                            default:        return haystack.includes(keyword);
                        }
                    });
                }

                // Quick filter on top of keyword results
                const filtered = q ? keywordFiltered.filter(l =>
                    l.name.toLowerCase().includes(q) ||
                    l.serviceName.toLowerCase().includes(q) ||
                    (l.geometryType || '').toLowerCase().includes(q)
                ) : keywordFiltered;

                overlay.querySelector('#browse-count').textContent = `${filtered.length} of ${items.length}`;
                const listEl = overlay.querySelector('#browse-list');

                listEl.innerHTML = filtered.map((l, i) => `
                    <div class="browse-layer-item" data-idx="${i}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;cursor:pointer;border:1px solid var(--border);background:var(--bg-surface);" title="${metaTooltip(l).replace(/"/g, '&quot;')}">
                        <span style="font-size:16px;">${geomIcon(l.geometryType)}</span>
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:600;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${l.name}</div>
                            <div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${metaLine(l)}</div>
                            ${l.description ? `<div style="font-size:10px;color:var(--text-muted);opacity:0.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px;" title="${l.description.replace(/<[^>]*>/g, '').replace(/"/g, '&quot;')}">${l.description.replace(/<[^>]*>/g, '').substring(0, 120)}</div>` : ''}
                        </div>
                        <button class="btn btn-sm btn-primary browse-import-btn" data-url="${l.url}" style="flex-shrink:0;">Import</button>
                    </div>
                `).join('');

                wireImportButtons(listEl.querySelectorAll('.browse-import-btn'));

                // Show Save to Catalog button when results exist
                const saveBtn = overlay.querySelector('#browse-save-catalog');
                if (items.length > 0) saveBtn.classList.remove('hidden');
            }

            // Save to Catalog
            overlay.querySelector('#browse-save-catalog').onclick = () => {
                if (browseResults.length === 0) return;
                const url = overlay.querySelector('#browse-url').value.trim();
                const catalog = loadCatalog();

                // Derive a label from the URL
                let label;
                try {
                    const u = new URL(url);
                    label = u.hostname;
                    // If it's services.arcgis.com, include the org segment
                    if (u.hostname === 'services.arcgis.com') {
                        const parts = u.pathname.split('/').filter(Boolean);
                        label = `ArcGIS Online (${parts[0] || 'org'})`;
                    }
                } catch (_) { label = url; }

                // Upsert: replace if same URL exists
                const existing = catalog.findIndex(s => s.url === url);
                const entry = {
                    url,
                    label,
                    layers: browseResults,
                    scannedAt: new Date().toISOString()
                };

                if (existing >= 0) {
                    catalog[existing] = entry;
                } else {
                    catalog.push(entry);
                }

                saveCatalog(catalog);
                showToast(`Saved ${browseResults.length} layers to catalog`, 'success');

                // Switch to catalog tab
                overlay.querySelectorAll('#arcgis-tabs .tab').forEach(t => t.classList.remove('active'));
                overlay.querySelector('[data-atab="catalog"]').classList.add('active');
                overlay.querySelector('#arcgis-tab-browse').classList.add('hidden');
                overlay.querySelector('#arcgis-tab-catalog').classList.remove('hidden');
                renderCatalog();
            };

            // ---- Direct URL (existing logic) ----

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
// Rename Layer
// ============================
function renameLayer(layerId, el) {
    const layer = getLayers().find(l => l.id === layerId);
    if (!layer) return;

    // If inline element passed, do inline editing
    if (el && el.nodeType) {
        startInlineEdit(el, layer.name, (newName) => {
            newName = newName.trim();
            if (newName && newName !== layer.name) {
                layer.name = newName;
                renderLayerList();
                renderOutputPanel();
                showToast(`Layer renamed to "${newName}"`, 'success', { duration: 2000 });
            }
        });
        return;
    }

    // Fallback: prompt
    const newName = prompt('Rename layer:', layer.name);
    if (newName && newName.trim() && newName.trim() !== layer.name) {
        layer.name = newName.trim();
        renderLayerList();
        renderOutputPanel();
        showToast(`Layer renamed to "${layer.name}"`, 'success', { duration: 2000 });
    }
}

// ============================
// Rename Field
// ============================
function renameField(fieldName, el) {
    const layer = getActiveLayer();
    if (!layer) return;
    const field = layer.schema?.fields?.find(f => f.name === fieldName);
    if (!field) return;

    const currentName = field.outputName || field.name;

    if (el && el.nodeType) {
        startInlineEdit(el, currentName, (newName) => {
            newName = newName.trim();
            if (newName && newName !== currentName) {
                field.outputName = newName;
                renderFieldList();
                renderOutputPanel();
                showToast(`Field renamed to "${newName}"`, 'success', { duration: 2000 });
            }
        });
        return;
    }

    const newName = prompt('Rename field output name:', currentName);
    if (newName && newName.trim() && newName.trim() !== currentName) {
        field.outputName = newName.trim();
        renderFieldList();
        renderOutputPanel();
        showToast(`Field renamed to "${field.outputName}"`, 'success', { duration: 2000 });
    }
}

// ============================
// Add New Field
// ============================
function addField() {
    const layer = getActiveLayer();
    if (!layer) return showToast('No layer selected', 'warning');

    const existingNames = new Set((layer.schema?.fields || []).map(f => f.name));

    const html = `
        <div class="form-group"><label>Field Name</label>
            <input type="text" id="af-name" placeholder="new_field" autofocus></div>
        <div class="form-group"><label>Field Type</label>
            <select id="af-type">
                <option value="string" selected>Text (string)</option>
                <option value="number">Number</option>
                <option value="boolean">Boolean</option>
                <option value="date">Date</option>
            </select></div>
        <div class="form-group"><label>Default Value <span class="text-muted text-xs">(optional)</span></label>
            <input type="text" id="af-default" placeholder="Leave blank for empty"></div>
        <div id="af-error" class="text-xs" style="color:var(--error);min-height:18px;"></div>`;

    showModal('Add New Field', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Add Field</button>',
        onMount: (overlay, close) => {
            const nameInput = overlay.querySelector('#af-name');
            const typeSelect = overlay.querySelector('#af-type');
            const defaultInput = overlay.querySelector('#af-default');
            const errorEl = overlay.querySelector('#af-error');

            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const name = nameInput.value.trim();
                if (!name) { errorEl.textContent = 'Field name is required'; nameInput.focus(); return; }
                if (existingNames.has(name)) { errorEl.textContent = `Field "${name}" already exists`; nameInput.focus(); return; }
                if (/[.\[\]]/.test(name)) { errorEl.textContent = 'Field name cannot contain . [ or ]'; nameInput.focus(); return; }

                const type = typeSelect.value;
                const rawDefault = defaultInput.value;

                // Coerce default value to selected type
                let defaultValue = rawDefault === '' ? null : rawDefault;
                if (defaultValue !== null) {
                    if (type === 'number') {
                        defaultValue = Number(rawDefault);
                        if (isNaN(defaultValue)) { errorEl.textContent = 'Default value is not a valid number'; defaultInput.focus(); return; }
                    } else if (type === 'boolean') {
                        defaultValue = ['true', '1', 'yes'].includes(rawDefault.toLowerCase());
                    }
                }

                // Add field to schema
                const maxOrder = (layer.schema?.fields || []).reduce((m, f) => Math.max(m, f.order || 0), -1);
                const newField = {
                    name,
                    type,
                    nullCount: defaultValue === null ? (layer.schema?.featureCount || 0) : 0,
                    uniqueCount: defaultValue === null ? 0 : 1,
                    sampleValues: defaultValue !== null ? [defaultValue] : [],
                    min: type === 'number' && defaultValue !== null ? defaultValue : null,
                    max: type === 'number' && defaultValue !== null ? defaultValue : null,
                    selected: true,
                    outputName: name,
                    order: maxOrder + 1
                };
                if (!layer.schema) layer.schema = { fields: [], geometryType: null, featureCount: 0, crs: 'EPSG:4326' };
                layer.schema.fields.push(newField);

                // Populate data in every feature / row
                if (layer.type === 'spatial' && layer.geojson?.features) {
                    for (const feat of layer.geojson.features) {
                        if (!feat.properties) feat.properties = {};
                        feat.properties[name] = defaultValue;
                    }
                } else if (layer.rows) {
                    for (const row of layer.rows) {
                        row[name] = defaultValue;
                    }
                }

                renderFieldList();
                renderOutputPanel();
                showToast(`Field "${name}" added`, 'success', { duration: 2000 });
                close();
            };

            // Enter key to submit
            const handleEnter = (e) => { if (e.key === 'Enter') overlay.querySelector('.apply-btn').click(); };
            nameInput.addEventListener('keydown', handleEnter);
            defaultInput.addEventListener('keydown', handleEnter);
        }
    });
}

/**
 * Inline editing helper — replaces element text with an input
 */
function startInlineEdit(el, currentValue, onSave) {
    if (el.querySelector('input')) return; // already editing

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentValue;
    input.className = 'inline-rename-input';
    input.style.cssText = 'width:100%;padding:1px 4px;font-size:inherit;font-weight:inherit;border:1px solid var(--primary);border-radius:3px;background:var(--bg-surface);color:var(--text);outline:none;';

    const originalText = el.textContent;
    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();

    const finish = () => {
        const val = input.value;
        el.textContent = val || originalText;
        onSave(val);
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(); }
        if (e.key === 'Escape') { el.textContent = originalText; }
    });
    input.addEventListener('blur', finish, { once: true });
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
// Tool Info / Help Guide
// ============================
function showToolInfo() {
    const sections = [
        {
            title: 'Import & Sources',
            tools: [
                ['📂 Import', 'Drag-and-drop or browse to load GeoJSON, CSV, Excel, KML, KMZ, Shapefile (ZIP), or JSON files.'],
                ['📷 Photos', 'Import geotagged photos. Extracts GPS coordinates and EXIF data, maps them as points.'],
                ['🌐 ArcGIS REST', 'Import features directly from an ArcGIS REST service URL (Feature/Map Server).'],
                ['📍 Coordinates', 'Convert coordinates between formats — Decimal Degrees, DMS, UTM, and MGRS.']
            ]
        },
        {
            title: 'Layers & Fields',
            tools: [
                ['Layers Panel', 'View, select, toggle visibility, zoom to, rename, or remove imported layers.'],
                ['Fields Panel', 'View, search, select/deselect, rename, or add new fields on the active layer.'],
                ['Merge Layers', 'Combine all loaded layers into a single layer with a source_file field.'],
                ['Data Table', 'View the raw attribute table for the active layer.']
            ]
        },
        {
            title: 'Data Prep',
            tools: [
                ['Split Column', 'Split a field into multiple new fields by a delimiter (comma, space, etc.).'],
                ['Combine', 'Merge two or more fields into a single field with a separator.'],
                ['Template', 'Build a new field from a text template using values from existing fields.'],
                ['Replace/Clean', 'Find and replace text, trim whitespace, or clean values in a field.'],
                ['Type Convert', 'Change a field\'s data type (text → number, number → text, etc.).'],
                ['Filter', 'Keep or remove rows based on conditions (equals, contains, greater than, etc.).'],
                ['Dedup', 'Remove duplicate rows based on one or more key fields.'],
                ['Join', 'Join two layers together on a matching key field.'],
                ['Validate', 'Run validation rules on fields (required, min/max, regex pattern, etc.).'],
                ['Add UID', 'Add a unique sequential ID field to every row.']
            ]
        },
        {
            title: 'GIS Tools',
            tools: [
                ['Buffer', 'Create buffer polygons around point/line/polygon features at a set distance.'],
                ['Simplify', 'Reduce vertex count on geometries to shrink file size while preserving shape.'],
                ['Clip to Extent', 'Clip features to the current visible map area.']
            ]
        },
        {
            title: 'Export',
            tools: [
                ['GeoJSON', 'Export spatial data as a .geojson file.'],
                ['CSV', 'Export attributes as a comma-separated .csv file.'],
                ['Excel', 'Export attributes as an .xlsx spreadsheet.'],
                ['KML', 'Export spatial data as a .kml file (Google Earth).'],
                ['KMZ', 'Export as .kmz (compressed KML), can include embedded photos.'],
                ['JSON', 'Export raw data as a .json file.'],
                ['Shapefile', 'Export spatial data as a zipped Shapefile (.shp).']
            ]
        },
        {
            title: 'ArcGIS REST Import',
            tools: [
                ['Overview', 'Pull features directly from any public or accessible ArcGIS REST endpoint into the toolbox — no download or login required.'],
                ['Direct URL', 'Paste a Feature Server or Map Server layer URL (e.g. .../FeatureServer/0). The tool auto-detects the service, queries all features, and imports them as a spatial layer with full attributes.'],
                ['Browse & Add', 'Select a preset endpoint (UDOT Central, UDOT ArcGIS Online) or enter a custom REST services directory URL. The tool scans all folders and lists every available layer for one-click import.'],
                ['Keyword Filter', 'After scanning, filter layers by keyword with match modes: Contains, Exact Match, Starts With, Ends With, or Does NOT Contain. A secondary quick-filter further narrows results.'],
                ['Catalog', 'Save scanned endpoints to a persistent catalog (stored locally). View, search, rescan, or remove saved sources anytime — the catalog auto-opens when entries exist.'],
                ['Layer Metadata', 'Each layer displays service author, copyright/owner, last edit date, description, capabilities, and server version. Hover any layer for the full detail tooltip.'],
                ['Supported', 'Works with Feature Servers, Map Servers, and individual layer endpoints. Handles paginated services that return features in batches automatically.']
            ]
        },
        {
            title: 'Other',
            tools: [
                ['AGOL Compatibility', 'Check and auto-fix field names/types for ArcGIS Online compatibility.']
            ]
        }
    ];

    const html = sections.map(s => `
        <div style="margin-bottom:16px;">
            <div style="font-weight:700;font-size:14px;color:var(--gold-light);margin-bottom:6px;border-bottom:1px solid var(--border);padding-bottom:4px;">${s.title}</div>
            <div style="display:flex;flex-direction:column;gap:4px;">
                ${s.tools.map(([name, desc]) => `
                    <div style="display:flex;gap:8px;align-items:baseline;">
                        <span style="font-weight:600;white-space:nowrap;min-width:110px;color:var(--text);">${name}</span>
                        <span style="color:var(--text-muted);font-size:13px;">${desc}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');

    showModal('GIS Toolbox — Tool Guide', `<div style="max-height:70vh;overflow-y:auto;">${html}</div>`, { width: '560px' });
}

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
    renameLayer, renameField,
    addField,
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
    openCoordinatesModal: openCoordinatesModal,
    mergeLayers: handleMergeLayers,
    showToolInfo
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
