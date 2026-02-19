/**
 * GIS Toolbox — Main Application Entry Point
 * Wires all modules together, builds UI, handles events
 */
import logger from './core/logger.js';
import bus from './core/event-bus.js';
import { handleError } from './core/error-handler.js';
import {
    getState, getLayers, getActiveLayer, addLayer, removeLayer,
    setActiveLayer, toggleLayerVisibility, reorderLayer, setUIState, toggleAGOLCompat
} from './core/state.js';
import { mergeDatasets, getSelectedFields, tableToSpatial, createSpatialDataset, analyzeSchema, analyzeTableSchema, splitByGeometryType } from './core/data-model.js';
import { importFile, importFiles } from './import/importer.js';
import { getAvailableFormats, exportDataset, exportMultiLayerKMZFile, setExportMapManager } from './export/exporter.js';
import mapManager from './map/map-manager.js';
import { showToast, showErrorToast } from './ui/toast.js';
import { showModal, confirm, showProgressModal } from './ui/modals.js';
import * as transforms from './dataprep/transforms.js';
import { applyTemplate, previewTemplate, getTemplateFields } from './dataprep/template-builder.js';
import { saveSnapshot, undo as undoHistory, redo as redoHistory, getHistoryState } from './dataprep/transform-history.js';
import { photoMapper } from './photo/photo-mapper.js';
import { arcgisImporter } from './arcgis/rest-importer.js';
import ARCGIS_ENDPOINTS from './arcgis/endpoints.js';
import { checkAGOLCompatibility, applyAGOLFixes } from './agol/compatibility.js';
import * as gisTools from './tools/gis-tools.js';

import drawManager from './map/draw-manager.js';
import sessionStore from './core/session-store.js';
import { SpatialAnalyzerWidget } from './widgets/spatial-analyzer.js';
import { BulkUpdateWidget } from './widgets/bulk-update.js';
import { ProximityJoinWidget } from './widgets/proximity-join.js';

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

    // Popup navigation for multi-feature cycling
    window._mapPopupNav = (dir) => {
        if (!mapManager._popupHits) return;
        const len = mapManager._popupHits.length;
        mapManager._popupIndex = (mapManager._popupIndex + dir + len) % len;
        mapManager._renderCyclePopup();
    };

    // Edit feature from popup
    window._mapPopupEdit = () => {
        const hits = mapManager._popupHits;
        const idx = mapManager._popupIndex;
        if (!hits || !hits[idx]) return;
        const hit = hits[idx];
        mapManager.map.closePopup();
        openFeatureEditor(hit.layerId, hit.featureIndex);
    };

    logger.info('App', 'App ready');

    // Auto-save status indicator
    sessionStore.onSaveStatus((status) => {
        const el = document.getElementById('save-indicator');
        if (!el) return;
        if (status === 'saving') {
            el.textContent = 'Saving…';
            el.classList.add('visible');
        } else if (status === 'saved') {
            el.textContent = 'Session saved';
            el.classList.add('visible');
            setTimeout(() => el.classList.remove('visible'), 1500);
        } else if (status === 'error') {
            el.textContent = 'Save failed';
            el.classList.add('visible');
            setTimeout(() => el.classList.remove('visible'), 2500);
        }
    });

    // Check for a saved session and offer to restore
    restoreSessionIfAvailable();

    // Show tool guide splash on every app open
    setTimeout(() => showToolInfo(), 300);
}
// Handle both: module loaded before or after DOMContentLoaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

// ============================
// Session Restore
// ============================
async function restoreSessionIfAvailable() {
    try {
        const info = await sessionStore.hasSession();
        if (!info) return;

        const ago = _timeAgo(info.timestamp);
        const ok = await confirm(
            'Restore Previous Session?',
            `You have ${info.layerCount} layer${info.layerCount > 1 ? 's' : ''} saved from ${ago}. Would you like to restore them?`
        );

        if (ok) {
            const session = await sessionStore.loadSession();
            if (!session) { showToast('Could not read saved session.', 'warning'); return; }

            let restored = 0;
            for (const saved of session.layers) {
                try {
                    if (saved.type === 'spatial' && saved.geojson) {
                        const schema = analyzeSchema(saved.geojson);
                        const dataset = {
                            id: saved.id,
                            name: saved.name,
                            type: 'spatial',
                            geojson: saved.geojson,
                            schema,
                            source: saved.source || { file: saved.name, format: 'session' },
                            visible: saved.visible !== false,
                            active: false,
                            created: saved.created || new Date().toISOString()
                        };
                        addLayer(dataset);
                        mapManager.addLayer(dataset, getLayers().indexOf(dataset), { fit: false });
                        restored++;
                    } else if (saved.type === 'table' && saved.rows) {
                        const fields = saved.rows.length > 0 ? Object.keys(saved.rows[0]) : [];
                        const schema = analyzeTableSchema(saved.rows, fields);
                        addLayer({
                            id: saved.id,
                            name: saved.name,
                            type: 'table',
                            rows: saved.rows,
                            schema,
                            source: saved.source || { file: saved.name, format: 'session' },
                            visible: saved.visible !== false,
                            active: false,
                            created: saved.created || new Date().toISOString()
                        });
                        restored++;
                    }
                } catch (err) {
                    logger.warn('Session', `Failed to restore layer "${saved.name}"`, { error: err.message });
                }
            }

            // Set active layer from saved meta
            if (session.meta?.activeLayerId) {
                setActiveLayer(session.meta.activeLayerId);
            }

            // Fit map to all restored spatial layers
            if (restored > 0) {
                mapManager.fitToAll();
            }

            showToast(`Restored ${restored} layer${restored !== 1 ? 's' : ''} from previous session`, 'success');
            logger.info('Session', `Restored ${restored} layers`);
        } else {
            await sessionStore.clearSession();
            logger.info('Session', 'User discarded saved session');
        }
    } catch (err) {
        logger.error('Session', 'Restore failed', { error: err.message });
    }
}

function _timeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} minute${mins > 1 ? 's' : ''} ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
}

function initMap() {
    try {
        mapManager.init('map-container');
        setExportMapManager(mapManager); // Wire map styles into KML/KMZ export
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
                mapManager.addLayer(result.dataset, getLayers().indexOf(result.dataset), { fit: true });
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
async function handleFileImport(files, fenceBbox = null) {
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

        // Auto-split mixed-geometry datasets into separate layers
        const expanded = [];
        for (const ds of datasets) {
            if (ds.type === 'spatial' && ds.schema?.geometryType === 'Mixed') {
                expanded.push(...splitByGeometryType(ds));
            } else {
                expanded.push(ds);
            }
        }

        let totalFiltered = 0;
        for (const ds of expanded) {
            if (fenceBbox) {
                const before = ds.type === 'spatial' ? ds.geojson?.features?.length : 0;
                filterDatasetByFence(ds, fenceBbox);
                const after = ds.type === 'spatial' ? ds.geojson?.features?.length : 0;
                totalFiltered += (before - after);
            }
            // Apply KML-extracted style before first render
            if (ds._kmlStyle && !mapManager.getLayerStyle(ds.id)) {
                mapManager.setLayerStyle(ds.id, { ...ds._kmlStyle });
            }
            addLayer(ds);
            mapManager.addLayer(ds, getLayers().indexOf(ds), { fit: true });
        }

        if (expanded.length > 0) {
            const fenceNote = fenceBbox && totalFiltered > 0 ? ` (${totalFiltered} features outside fence excluded)` : '';
            showToast(`Imported ${expanded.length} layer(s)${fenceNote}`, 'success');
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
            handleFileImport(files, _fenceBbox);
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

    // Import Fence
    document.getElementById('btn-fence')?.addEventListener('click', startImportFence);

    // ArcGIS REST Import
    document.getElementById('btn-arcgis')?.addEventListener('click', openArcGISImporter);
    document.getElementById('btn-arcgis-mobile')?.addEventListener('click', openArcGISImporter);

    // Draw Layer
    document.getElementById('btn-draw-layer')?.addEventListener('click', createDrawLayer);

    // Handle drawn features
    bus.on('draw:featureCreated', ({ layerId, feature }) => {
        const layer = getLayers().find(l => l.id === layerId);
        if (!layer || layer.type !== 'spatial') return;
        saveSnapshot(layer.id, 'Draw feature', layer.geojson);
        layer.geojson.features.push(feature);
        import('./core/data-model.js').then(dm => {
            layer.schema = dm.analyzeSchema(layer.geojson);
            bus.emit('layer:updated', layer);
            bus.emit('layers:changed', getLayers());
            mapManager.addLayer(layer, getLayers().indexOf(layer));
            refreshUI();
        });
        showToast(`Added ${feature.geometry.type} to ${layer.name}`, 'success');
    });

    // Logs
    document.getElementById('btn-logs')?.addEventListener('click', toggleLogs);

    // Info / Tool Guide
    document.getElementById('btn-info')?.addEventListener('click', showToolInfo);

    // Merge layers
    document.getElementById('btn-merge')?.addEventListener('click', handleMergeLayers);

    // Mobile dropdown menu
    const mobileMenuBtn = document.getElementById('btn-mobile-menu');
    const mobileDropdown = document.getElementById('mobile-dropdown-menu');
    if (mobileMenuBtn && mobileDropdown) {
        const closeMobileMenu = () => {
            mobileDropdown.classList.add('hidden');
            const backdrop = document.getElementById('mobile-menu-backdrop');
            if (backdrop) backdrop.remove();
        };
        mobileMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = !mobileDropdown.classList.contains('hidden');
            if (isOpen) { closeMobileMenu(); return; }
            mobileDropdown.classList.remove('hidden');
            // Add backdrop to catch taps outside
            let backdrop = document.getElementById('mobile-menu-backdrop');
            if (!backdrop) {
                backdrop = document.createElement('div');
                backdrop.id = 'mobile-menu-backdrop';
                backdrop.className = 'mobile-dropdown-backdrop';
                document.body.appendChild(backdrop);
            }
            backdrop.addEventListener('click', closeMobileMenu, { once: true });
        });
        mobileDropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.mobile-menu-item');
            if (!item) return;
            const action = item.dataset.action;
            closeMobileMenu();
            switch (action) {
                case 'import': document.getElementById('btn-import')?.click(); break;
                case 'photos': openPhotoMapper(); break;
                case 'arcgis': openArcGISImporter(); break;

                case 'draw': createDrawLayer(); break;
                case 'logs': toggleLogs(); break;
                case 'info': showToolInfo(); break;
            }
        });
    }

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

    // ============================
    // NEW MOBILE FLYOUT MENUS
    // ============================
    setupMobileFlyoutMenus();

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
    bus.on('layers:changed', () => sessionStore.scheduleSave(getLayers()));
    bus.on('layer:active', () => { refreshUI(); updateSelectionUI(); });
    bus.on('task:error', (data) => {
        showErrorToast(data.error);
    });

    // Listen for selection changes
    bus.on('selection:changed', () => updateSelectionUI());
    bus.on('selection:modeChanged', () => updateSelectionUI());

    // Right-click context menu
    bus.on('map:contextmenu', showMapContextMenu);

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
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:48px;height:48px;margin:0 auto 12px;opacity:0.5;">
                    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                    <path d="M2 17l10 5 10-5"/>
                    <path d="M2 12l10 5 10-5"/>
                </svg>
                <p>No layers loaded. Import or drag and drop a file to start.</p>
            </div>`;
        return;
    }

    container.innerHTML = layers.map((layer, idx) => {
        const isActive = layer.id === active?.id;
        const icon = layer.type === 'spatial' ? '🗺️' : '📊';
        const count = layer.type === 'spatial'
            ? `${layer.geojson?.features?.length || 0} features`
            : `${layer.rows?.length || 0} rows`;
        const geomBadge = layer.schema?.geometryType
            ? `<span class="badge badge-info">${layer.schema.geometryType}</span>` : '';
        const filterBadge = layer._activeFilter
            ? `<span class="layer-filter-badge" title="Filter active – click to edit" onclick="event.stopPropagation(); window.app.openFilterBuilder('${layer.id}')">FILTERED</span>`
            : '';

        return `
            <div class="layer-item ${isActive ? 'active' : ''}" data-id="${layer.id}" onclick="window.app.setActiveLayer('${layer.id}')">
                <span class="layer-icon">${icon}</span>
                <div class="layer-name-row">
                    <div class="layer-name" ondblclick="event.stopPropagation(); window.app.renameLayer('${layer.id}', this)">${layer.name}</div>
                    ${filterBadge}
                    <div class="layer-order-btns">
                        <button title="Move up" ${idx === 0 ? 'disabled' : ''} onclick="event.stopPropagation(); window.app.moveLayerUp('${layer.id}')">▲</button>
                        <button title="Move down" ${idx === layers.length - 1 ? 'disabled' : ''} onclick="event.stopPropagation(); window.app.moveLayerDown('${layer.id}')">▼</button>
                    </div>
                </div>
                <div class="layer-bottom-row">
                    <div class="layer-meta">${count} · ${layer.schema?.fields?.length || 0} fields ${geomBadge}</div>
                    <div class="layer-actions">
                        <button class="btn-icon" title="Rename" onclick="event.stopPropagation(); window.app.renameLayer('${layer.id}')">✏️</button>
                        <button class="btn-icon" title="Toggle visibility" onclick="event.stopPropagation(); window.app.toggleVisibility('${layer.id}')">
                            ${layer.visible ? '👁️' : '👁️‍🗨️'}
                        </button>
                        </button>
                        <button class="btn-icon" title="Zoom to layer" onclick="event.stopPropagation(); window.app.zoomToLayer('${layer.id}')">🔍</button>
                        <button class="btn-icon" title="Remove" onclick="event.stopPropagation(); window.app.removeLayer('${layer.id}')">🗑️</button>
                    </div>
                </div>
            </div>`;
    }).join('');
}

function moveLayerUp(id) {
    reorderLayer(id, 'up');
    mapManager.syncLayerOrder(getLayers().map(l => l.id));
    renderLayerList();
}

function moveLayerDown(id) {
    reorderLayer(id, 'down');
    mapManager.syncLayerOrder(getLayers().map(l => l.id));
    renderLayerList();
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
        </div>

        ${layer.type === 'spatial' ? buildStylePanel(layer) : ''}`;

    // Re-bind AGOL toggle
    document.getElementById('agol-toggle')?.addEventListener('change', () => {
        toggleAGOLCompat();
        renderOutputPanel();
    });

    // Bind style panel controls
    if (layer.type === 'spatial') {
        bindStylePanel(layer);
    }
}

// ============================
// Layer Styling Panel
// ============================

function _detectGeomTypes(layer) {
    const types = new Set();
    for (const f of (layer.geojson?.features || [])) {
        if (f.geometry?.type) {
            const t = f.geometry.type;
            if (t === 'Point' || t === 'MultiPoint') types.add('point');
            else if (t === 'LineString' || t === 'MultiLineString') types.add('line');
            else if (t === 'Polygon' || t === 'MultiPolygon') types.add('polygon');
        }
    }
    return types;
}

function buildStylePanel(layer) {
    const sty = mapManager.getLayerStyle(layer.id) || {
        strokeColor: '#2563eb', fillColor: '#2563eb',
        strokeWidth: 2, strokeOpacity: 0.8, fillOpacity: 0.3,
        pointSize: 6, pointSymbol: 'circle'
    };
    const geomTypes = _detectGeomTypes(layer);
    const isMixed = geomTypes.size > 1;
    const hasPoints = geomTypes.has('point');
    const hasFills = geomTypes.has('polygon') || geomTypes.has('point');
    const hasLines = geomTypes.has('line') || geomTypes.has('polygon');

    const symbolOptions = ['circle', 'square', 'triangle', 'diamond', 'star', 'pin'];
    const symbolLabels = { circle: '●', square: '■', triangle: '▲', diamond: '◆', star: '★', pin: '📍' };

    // Helper to build a style section (for single-type or per-type)
    function buildSection(prefix, s, opts) {
        const { showStroke = true, showFill = true, showWidth = true, showStrokeOp = true, showFillOp = true, showPoint = false } = opts;
        let html = '';
        if (showStroke) {
            html += `<div class="style-row"><label>Stroke Color</label><input type="color" id="${prefix}-stroke-color" value="${s.strokeColor}" class="style-color-input"></div>`;
        }
        if (showFill) {
            html += `<div class="style-row"><label>Fill Color</label><input type="color" id="${prefix}-fill-color" value="${s.fillColor || s.strokeColor}" class="style-color-input"></div>`;
        }
        if (showWidth) {
            html += `<div class="style-row"><label>Stroke Width</label><input type="range" id="${prefix}-stroke-width" min="0.5" max="8" step="0.5" value="${s.strokeWidth ?? 2}" class="style-range"><span class="style-value" id="${prefix}-stroke-width-val">${s.strokeWidth ?? 2}</span></div>`;
        }
        if (showStrokeOp) {
            html += `<div class="style-row"><label>Stroke Opacity</label><input type="range" id="${prefix}-stroke-opacity" min="0" max="1" step="0.05" value="${s.strokeOpacity ?? 0.8}" class="style-range"><span class="style-value" id="${prefix}-stroke-opacity-val">${Math.round((s.strokeOpacity ?? 0.8) * 100)}%</span></div>`;
        }
        if (showFillOp) {
            html += `<div class="style-row"><label>Fill Opacity</label><input type="range" id="${prefix}-fill-opacity" min="0" max="1" step="0.05" value="${s.fillOpacity ?? 0.3}" class="style-range"><span class="style-value" id="${prefix}-fill-opacity-val">${Math.round((s.fillOpacity ?? 0.3) * 100)}%</span></div>`;
        }
        if (showPoint) {
            html += `<div class="style-row"><label>Point Size</label><input type="range" id="${prefix}-point-size" min="3" max="20" step="1" value="${s.pointSize ?? 6}" class="style-range"><span class="style-value" id="${prefix}-point-size-val">${s.pointSize ?? 6}</span></div>`;
            html += `<div class="style-row style-row-symbols"><label>Symbol</label><div class="style-symbols" id="${prefix}-point-symbol">${symbolOptions.map(sym =>
                `<button class="style-symbol-btn ${(s.pointSymbol || 'circle') === sym ? 'active' : ''}" data-symbol="${sym}" title="${sym}">${symbolLabels[sym]}</button>`
            ).join('')}</div></div>`;
        }
        return html;
    }

    let body;
    if (isMixed) {
        // Per-geometry-type sections
        const ps = { ...sty, ...(sty.point || {}) };
        const ls = { ...sty, ...(sty.line || {}) };
        const gs = { ...sty, ...(sty.polygon || {}) };

        body = '';
        if (hasPoints) {
            body += `<div class="style-type-section"><h4 class="style-type-header">⬤ Points</h4>${buildSection('sty-pt', ps, { showFill: true, showWidth: true, showStrokeOp: true, showFillOp: true, showPoint: true })}</div>`;
        }
        if (hasLines) {
            body += `<div class="style-type-section"><h4 class="style-type-header">━ Lines</h4>${buildSection('sty-ln', ls, { showFill: false, showWidth: true, showStrokeOp: true, showFillOp: false, showPoint: false })}</div>`;
        }
        if (geomTypes.has('polygon')) {
            body += `<div class="style-type-section"><h4 class="style-type-header">⬠ Polygons</h4>${buildSection('sty-pg', gs, { showFill: true, showWidth: true, showStrokeOp: true, showFillOp: true, showPoint: false })}</div>`;
        }
    } else {
        // Single geometry type — flat panel (original layout)
        body = buildSection('sty', sty, {
            showStroke: true,
            showFill: hasFills,
            showWidth: hasLines || hasFills,
            showStrokeOp: true,
            showFillOp: hasFills,
            showPoint: hasPoints
        });
    }

    return `
        <div class="panel-section style-panel">
            <div class="panel-section-header" onclick="toggleSection(this)">
                Layer Style <span class="arrow">▼</span>
            </div>
            <div class="panel-section-body">
                ${body}
                <button class="btn btn-sm btn-primary w-full mt-8" id="sty-apply">Apply Style</button>
            </div>
        </div>`;
}

function bindStylePanel(layer, root = document) {
    const $ = (sel) => root.querySelector(sel);
    const $$ = (sel) => root.querySelectorAll(sel);
    const byId = (id) => root.getElementById ? root.getElementById(id) : root.querySelector(`#${id}`);

    const applyBtn = byId('sty-apply');
    if (!applyBtn) return;

    const geomTypes = _detectGeomTypes(layer);
    const isMixed = geomTypes.size > 1;

    // Wire live value previews for all range sliders in the style panel
    const wireRange = (inputId, valId, fmt) => {
        const input = byId(inputId);
        const valEl = byId(valId);
        if (input && valEl) {
            input.addEventListener('input', () => { valEl.textContent = fmt(input.value); });
        }
    };

    const pctFmt = v => Math.round(v * 100) + '%';
    const idFmt = v => v;

    if (isMixed) {
        // Per-type range sliders
        for (const prefix of ['sty-pt', 'sty-ln', 'sty-pg']) {
            wireRange(`${prefix}-stroke-width`, `${prefix}-stroke-width-val`, idFmt);
            wireRange(`${prefix}-stroke-opacity`, `${prefix}-stroke-opacity-val`, pctFmt);
            wireRange(`${prefix}-fill-opacity`, `${prefix}-fill-opacity-val`, pctFmt);
            wireRange(`${prefix}-point-size`, `${prefix}-point-size-val`, idFmt);

            // Symbol button selection
            $$(`#${prefix}-point-symbol .style-symbol-btn`).forEach(btn => {
                btn.addEventListener('click', () => {
                    $$(`#${prefix}-point-symbol .style-symbol-btn`).forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                });
            });
        }
    } else {
        wireRange('sty-stroke-width', 'sty-stroke-width-val', idFmt);
        wireRange('sty-stroke-opacity', 'sty-stroke-opacity-val', pctFmt);
        wireRange('sty-fill-opacity', 'sty-fill-opacity-val', pctFmt);
        wireRange('sty-point-size', 'sty-point-size-val', idFmt);

        // Symbol button selection
        $$('#sty-point-symbol .style-symbol-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                $$('#sty-point-symbol .style-symbol-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });
    }

    // Helper to read style values from a prefix group
    const readSection = (prefix) => {
        const v = (id, def) => byId(`${prefix}-${id}`)?.value ?? def;
        return {
            strokeColor: v('stroke-color', '#2563eb'),
            fillColor: v('fill-color', null) || v('stroke-color', '#2563eb'),
            strokeWidth: parseFloat(v('stroke-width', 2)),
            strokeOpacity: parseFloat(v('stroke-opacity', 0.8)),
            fillOpacity: parseFloat(v('fill-opacity', 0.3)),
            pointSize: parseInt(v('point-size', 6)),
            pointSymbol: $(`#${prefix}-point-symbol .style-symbol-btn.active`)?.dataset.symbol || 'circle'
        };
    };

    // Apply
    applyBtn.addEventListener('click', () => {
        let style;
        if (isMixed) {
            // Start with current base, add per-type overrides
            const cur = mapManager.getLayerStyle(layer.id) || {};
            style = { ...cur };
            if (geomTypes.has('point')) style.point = readSection('sty-pt');
            if (geomTypes.has('line')) style.line = readSection('sty-ln');
            if (geomTypes.has('polygon')) style.polygon = readSection('sty-pg');
        } else {
            style = readSection('sty');
        }
        mapManager.restyleLayer(layer.id, layer, style);
        showToast('Style applied', 'success');
    });
}

// ============================
// Layer Data Tools Panel (left panel section)
// ============================
function renderDataPrepTools() {
    const layer = getActiveLayer();
    const hasFilter = !!layer?._activeFilter;
    return `
        <div class="panel-section">
            <div class="panel-section-header" onclick="toggleSection(this)">
                Layer Data Tools <span class="arrow">▼</span>
            </div>
            <div class="panel-section-body">
                <div style="display:flex; flex-wrap:wrap; gap:4px;">
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openSplitColumn()">Split Column</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openCombineColumns()">Combine</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openTemplateBuilder()">Template</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openReplaceClean()">Replace/Clean</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openTypeConvert()">Type Convert</button>
                    <button class="btn btn-sm ${hasFilter ? 'btn-primary' : 'btn-secondary'}" onclick="window.app.openFilterBuilder()">${hasFilter ? '⚙ Filter ✓' : 'Filter'}</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openDeduplicate()">Dedup</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openJoinTool()">Join</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.openValidation()">Validate</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.app.addUID()">Add UID</button>
                </div>
            </div>
        </div>

        <div class="panel-section">
            <div class="panel-section-header" onclick="toggleSection(this)">
                GIS Widgets <span class="arrow">▼</span>
            </div>
            <div class="panel-section-body">
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Pre-built workflows for common GIS tasks.</div>
                <div style="display:flex; flex-wrap:wrap; gap:4px;">
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openSpatialAnalyzer()">🔎 Find Features in Area</button><span class="geo-tip">Search for features from one layer that fall inside a drawn area or polygon layer.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openBulkUpdate()">✏️ Bulk Update</button><span class="geo-tip">Select multiple features and update their attribute fields in bulk.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openProximityJoin()">↔️ Proximity Join</button><span class="geo-tip">Copy attributes from the nearest feature in a target layer to each source feature.</span></span>
                </div>
            </div>
        </div>

        <div class="panel-section">
            <div class="panel-section-header" onclick="toggleSection(this)">
                GIS Tools <span class="arrow">▼</span>
            </div>
            <div class="panel-section-body">

                <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                    <button id="btn-selection-toggle" class="btn-selection-toggle" onclick="window.app.toggleSelectionMode()" title="Toggle feature selection mode — click features to select them">✦ Select</button>
                    <span style="font-size:10px;color:var(--text-muted);">Click features to select, or Shift+click to multi-select</span>
                </div>
                <div id="selection-bar" class="selection-bar hidden"></div>

                <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">Measurement</div>
                <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;">
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openDistanceTool()">📏 Distance</button><span class="geo-tip">Measure the straight-line distance between any two points you click on the map.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openBearingTool()">🧭 Bearing</button><span class="geo-tip">Find the compass direction (in degrees) from one point to another on the map.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openDestinationTool()">📌 Destination</button><span class="geo-tip">Given a start point, distance, and compass direction, find where you'd end up.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openAlongTool()">📍 Along</button><span class="geo-tip">Find a point at a specific distance along a line — like finding the 5-mile mark on a road.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openPointToLineDistanceTool()">↔ Pt→Line</button><span class="geo-tip">Measure how far a point is from the nearest spot on a line (shortest perpendicular distance).</span></span>
                </div>

                <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">Transformation</div>
                <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;">
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openBuffer()">⭕ Buffer</button><span class="geo-tip">Draw a zone around features at a set distance — like showing "everything within 1 mile of a road."</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openBboxClip()">✂️ BBox Clip</button><span class="geo-tip">Draw a rectangle on the map and cut away everything outside it.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openClip()">🔲 Clip Extent</button><span class="geo-tip">Cut features to the current visible map area.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openSimplify()">〰️ Simplify</button><span class="geo-tip">Reduce detail in shapes by removing extra points — makes files smaller and rendering faster.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openBezierSpline()">🌊 Spline</button><span class="geo-tip">Smooth jagged lines into gentle, flowing curves (bezier splines).</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openPolygonSmooth()">🔵 Smooth</button><span class="geo-tip">Round off rough polygon edges by averaging corner positions — makes shapes look more natural.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openLineOffset()">↔ Offset</button><span class="geo-tip">Create a parallel copy of a line shifted left or right by a set distance.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openSector()">🥧 Sector</button><span class="geo-tip">Create a pie-slice shaped area from a center point — useful for coverage areas or viewsheds.</span></span>
                </div>

                <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">Line Operations</div>
                <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;">
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openLineSliceAlong()">✂ Slice Along</button><span class="geo-tip">Cut out a section of a line using start and end distances — like "give me the road from mile 2 to mile 5."</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openLineSlice()">✂ Slice Pts</button><span class="geo-tip">Click two points on the map to cut out the section of line between them.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openLineIntersect()">✖ Intersect</button><span class="geo-tip">Find all points where two sets of lines cross each other.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openKinks()">⚠ Kinks</button><span class="geo-tip">Find self-intersections — spots where a line or polygon edge crosses over itself (geometry errors).</span></span>
                </div>

                <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">Combine & Analyze</div>
                <div style="display:flex; flex-wrap:wrap; gap:4px;">
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openCombine()">🔗 Combine</button><span class="geo-tip">Merge all features of the same type into one multi-feature (multiple Points → one MultiPoint).</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openUnion()">🔶 Union</button><span class="geo-tip">Merge all polygons into a single shape. Overlapping areas are dissolved together.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openDissolve()">🫧 Dissolve</button><span class="geo-tip">Merge polygons that share the same attribute value into single shapes — like combining all counties in the same state.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openPointsWithinPolygon()">📍🔷 Pts in Poly</button><span class="geo-tip">Find which points fall inside which polygons — like counting how many stores are in each district.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openNearestPoint()">🎯 Nearest Pt</button><span class="geo-tip">Click the map to find the closest feature in a point layer to that location.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openNearestPointOnLine()">📍→ Snap</button><span class="geo-tip">Click near a line to find the closest point directly on that line (snaps to it).</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openNearestPointToLine()">📍↔ Pt to Ln</button><span class="geo-tip">Find which point feature in a layer is closest to a given line.</span></span>
                    <span class="geo-tool-btn"><button class="btn btn-sm btn-secondary" onclick="window.app.openNearestNeighborAnalysis()">📊 NN Analysis</button><span class="geo-tip">Statistically test whether points are clustered together, spread apart, or randomly distributed.</span></span>
                </div>
            </div>
        </div>`;
}

// ============================
// Mobile Flyout Menus (new mobile UI)
// ============================
function setupMobileFlyoutMenus() {
    const fabNav = document.getElementById('mobile-fab-nav');
    const fabAdd = document.getElementById('mobile-fab-add');
    const flyoutNav = document.getElementById('mobile-flyout-nav');
    const flyoutAdd = document.getElementById('mobile-flyout-add');

    if (!fabNav || !fabAdd || !flyoutNav || !flyoutAdd) return;

    function closeFlyouts() {
        flyoutNav.classList.remove('open');
        flyoutAdd.classList.remove('open');
        fabNav.classList.remove('open');
        fabAdd.classList.remove('open');
        document.querySelector('.mobile-flyout-backdrop')?.remove();
    }

    function openFlyout(fab, flyout) {
        const wasOpen = flyout.classList.contains('open');
        closeFlyouts();
        if (wasOpen) return;

        flyout.classList.add('open');
        fab.classList.add('open');

        const backdrop = document.createElement('div');
        backdrop.className = 'mobile-flyout-backdrop';
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', closeFlyouts, { once: true });
    }

    fabNav.addEventListener('click', (e) => {
        e.stopPropagation();
        openFlyout(fabNav, flyoutNav);
    });

    fabAdd.addEventListener('click', (e) => {
        e.stopPropagation();
        openFlyout(fabAdd, flyoutAdd);
    });

    // Nav menu (gear — upper right) actions
    flyoutNav.addEventListener('click', (e) => {
        const item = e.target.closest('.mobile-flyout-item');
        if (!item) return;
        const action = item.dataset.action;
        closeFlyouts();
        switch (action) {
            case 'export': mobileShowExportModal(); break;
            case 'widgets': mobileShowWidgetsModal(); break;
            case 'tools': mobileShowToolsModal(); break;
            case 'layers': mobileShowLayersModal(); break;
            case 'fields': mobileShowFieldsModal(); break;
            case 'styling': mobileShowStylingModal(); break;
            case 'datatools': mobileShowDataToolsModal(); break;
            case 'basemap': mobileShowBasemapModal(); break;
            case 'guide': showToolInfo(); break;
        }
    });

    // Add menu (plus — lower right) actions
    flyoutAdd.addEventListener('click', (e) => {
        const item = e.target.closest('.mobile-flyout-item');
        if (!item) return;
        const action = item.dataset.action;
        closeFlyouts();
        switch (action) {
            case 'import': document.getElementById('btn-import')?.click(); break;
            case 'arcgis': openArcGISImporter(); break;
            case 'photos': openPhotoMapper(); break;
            case 'draw': createDrawLayer(); break;
            case 'fence': startImportFence(); break;
            case 'location': mobileAddCurrentLocation(); break;
        }
    });
}

// ============================
// Mobile Modal Helpers
// ============================
function mobileShowExportModal() {
    const layer = getActiveLayer();
    if (!layer) {
        showToast('Import data first to export', 'warning');
        return;
    }
    const formats = getAvailableFormats(layer);
    const agolMode = getState().agolCompatMode;
    const html = `
        <label class="toggle mb-8">
            <input type="checkbox" id="agol-toggle-mob" ${agolMode ? 'checked' : ''}>
            <span class="toggle-track"></span>
            <span>AGOL Compatible</span>
        </label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">
            ${formats.map(f =>
                `<button class="btn btn-primary btn-sm" style="flex:1 1 calc(50% - 4px);min-height:44px;" data-export="${f.key}">${f.label}</button>`
            ).join('')}
        </div>`;
    showModal('Export — ' + layer.name, html, {
        onMount: (overlay, close) => {
            overlay.querySelector('#agol-toggle-mob')?.addEventListener('change', () => {
                toggleAGOLCompat();
            });
            overlay.querySelectorAll('[data-export]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const fmt = btn.dataset.export;
                    close(null);
                    window.app.doExport(fmt);
                });
            });
        }
    });
}

function mobileShowWidgetsModal() {
    const items = [
        { label: '📊 Spatial Analyzer', action: 'openSpatialAnalyzer' },
        { label: '✏️ Bulk Update', action: 'openBulkUpdate' },
        { label: '📍 Proximity Join', action: 'openProximityJoin' },
    ];
    const html = `<div style="display:flex;flex-direction:column;gap:8px;">
        ${items.map(i => `<button class="btn btn-secondary" style="min-height:48px;justify-content:flex-start;gap:12px;" data-action="${i.action}">${i.label}</button>`).join('')}
    </div>`;
    showModal('GIS Widgets', html, {
        onMount: (overlay, close) => {
            overlay.querySelectorAll('[data-action]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const fn = btn.dataset.action;
                    close(null);
                    if (window.app[fn]) window.app[fn]();
                });
            });
        }
    });
}

function mobileShowToolsModal() {
    const layers = getLayers();
    const isSelMode = mapManager.isSelectionMode();
    const selCount = mapManager.getSelectedIndices?.(getActiveLayer()?.id)?.length || 0;
    const items = [
        ...(layers.length >= 2 ? [{ label: '🔗 Merge Layers', action: 'mergeLayers', full: true }] : []),
        { label: '📏 Distance', action: 'openDistanceTool' },
        { label: '🧭 Bearing', action: 'openBearingTool' },
        { label: '⭕ Buffer', action: 'openBuffer' },
        { label: '✂️ BBox Clip', action: 'openBboxClip' },
        { label: '🔲 Clip', action: 'openClip' },
        { label: '〰️ Simplify', action: 'openSimplify' },
        { label: '🌊 Spline', action: 'openBezierSpline' },
        { label: '🔵 Smooth', action: 'openPolygonSmooth' },
        { label: '🔶 Union', action: 'openUnion' },
        { label: '🫧 Dissolve', action: 'openDissolve' },
        { label: '🔗 Combine', action: 'openCombine' },
        { label: '⚠ Kinks', action: 'openKinks' },
        { label: '📊 NN Analysis', action: 'openNearestNeighborAnalysis' },
    ];
    const html = `
    <div style="margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <button class="btn btn-sm ${isSelMode ? 'btn-primary' : 'btn-secondary'}" data-action="toggleSelectionMode" style="min-height:38px;">✦ ${isSelMode ? 'Selection ON' : 'Select Features'}</button>
            ${selCount > 0 ? `<button class="btn btn-sm btn-secondary" data-action="clearSelection" style="min-height:38px;">Clear (${selCount})</button>` : ''}
        </div>
        <span style="font-size:10px;color:var(--text-muted);">Tap features on the map to select them for tools below</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${items.map(i => `<button class="btn ${i.full ? 'btn-primary' : 'btn-secondary'} btn-sm" style="flex:1 1 ${i.full ? '100%' : 'calc(50% - 3px)'};min-height:44px;" data-action="${i.action}">${i.label}</button>`).join('')}
    </div>`;
    showModal('GIS Tools', html, {
        onMount: (overlay, close) => {
            overlay.querySelectorAll('[data-action]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const fn = btn.dataset.action;
                    close(null);
                    if (window.app[fn]) window.app[fn]();
                });
            });
        }
    });
}

function mobileShowLayersModal() {
    const layers = getLayers();
    const active = getActiveLayer();
    if (layers.length === 0) {
        showToast('No layers loaded yet', 'info');
        return;
    }

    function buildLayerListHtml() {
        const currentLayers = getLayers();
        const currentActive = getActiveLayer();
        let h = `<div style="display:flex;flex-direction:column;gap:4px;">`;
        h += currentLayers.map((l, idx) => {
            const isActive = l.id === currentActive?.id;
            const icon = l.type === 'spatial' ? '🗺️' : '📊';
            const count = l.type === 'spatial'
                ? `${l.geojson?.features?.length || 0} features`
                : `${l.rows?.length || 0} rows`;
            return `
            <div class="layer-item ${isActive ? 'active' : ''}" style="border-radius:var(--radius-sm);border:1px solid var(--border);margin-bottom:2px;" data-layer-id="${l.id}" data-layer-action="select">
                <span class="layer-icon">${icon}</span>
                <div class="layer-name-row">
                    <div class="layer-name">${l.name}</div>
                    <div class="layer-order-btns">
                        <button title="Up" ${idx === 0 ? 'disabled' : ''} data-layer-id="${l.id}" data-layer-action="up">▲</button>
                        <button title="Down" ${idx === currentLayers.length - 1 ? 'disabled' : ''} data-layer-id="${l.id}" data-layer-action="down">▼</button>
                    </div>
                </div>
                <div class="layer-bottom-row">
                    <div class="layer-meta">${count} · ${l.schema?.fields?.length || 0} fields</div>
                    <div class="layer-actions">
                        <button class="btn-icon" title="Rename" data-layer-id="${l.id}" data-layer-action="rename">✏️</button>
                        <button class="btn-icon" title="Toggle" data-layer-id="${l.id}" data-layer-action="toggle">
                            ${l.visible !== false ? '👁️' : '👁️‍🗨️'}
                        </button>
                        <button class="btn-icon" title="Zoom" data-layer-id="${l.id}" data-layer-action="zoom">🔍</button>
                        <button class="btn-icon" title="Remove" data-layer-id="${l.id}" data-layer-action="remove">🗑️</button>
                    </div>
                </div>
            </div>`;
        }).join('');
        h += `</div>`;
        return h;
    }

    showModal('Layers', buildLayerListHtml(), {
        onMount: (overlay, close) => {
            const refreshModal = () => {
                const body = overlay.querySelector('.modal-body');
                if (body) body.innerHTML = buildLayerListHtml();
            };

            overlay.addEventListener('click', (e) => {
                const target = e.target.closest('[data-layer-action]');
                if (!target) return;
                e.stopPropagation();
                const id = target.dataset.layerId;
                const action = target.dataset.layerAction;

                switch (action) {
                    case 'select':
                        setActiveLayer(id);
                        refreshUI();
                        refreshModal();
                        break;
                    case 'up':
                        moveLayerUp(id);
                        refreshModal();
                        break;
                    case 'down':
                        moveLayerDown(id);
                        refreshModal();
                        break;
                    case 'rename': {
                        const layer = getLayers().find(l => l.id === id);
                        if (layer) {
                            const newName = prompt('Rename layer:', layer.name);
                            if (newName && newName.trim() && newName.trim() !== layer.name) {
                                layer.name = newName.trim();
                                renderLayerList();
                                renderOutputPanel();
                                showToast(`Renamed to "${layer.name}"`, 'success', { duration: 2000 });
                                refreshModal();
                            }
                        }
                        break;
                    }
                    case 'toggle':
                        toggleLayerVisibility(id);
                        mapManager.toggleLayer(id, getLayers().find(l => l.id === id)?.visible);
                        renderLayerList();
                        refreshModal();
                        break;
                    case 'zoom': {
                        const mapLayer = mapManager.dataLayers.get(id);
                        if (mapLayer) {
                            try { mapManager.getMap().fitBounds(mapLayer.getBounds(), { padding: [30, 30] }); } catch(_) {}
                        }
                        close(null);
                        break;
                    }
                    case 'remove':
                        confirm('Remove Layer', 'Remove this layer?').then(ok => {
                            if (ok) {
                                removeLayer(id);
                                mapManager.removeLayer(id);
                                refreshUI();
                                if (getLayers().length === 0) {
                                    close(null);
                                    showToast('Layer removed', 'success');
                                } else {
                                    refreshModal();
                                    showToast('Layer removed', 'success');
                                }
                            }
                        });
                        break;
                }
            });
        }
    });
}

function mobileShowFieldsModal() {
    const layer = getActiveLayer();
    if (!layer) {
        showToast('Select a layer first', 'warning');
        return;
    }

    const fields = layer.schema?.fields || [];
    const fieldRows = fields.map(f => `
        <div class="field-item" data-field="${f.name}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border);">
            <input type="checkbox" class="mob-field-chk" data-name="${f.name}" ${f.selected ? 'checked' : ''}>
            <span class="field-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.outputName || f.name}</span>
            <span class="field-type" style="font-size:10px;color:var(--text-muted);">${f.type}</span>
        </div>
    `).join('');

    const html = `
        <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
            <button class="btn btn-sm btn-secondary" id="mob-fields-all">Select All</button>
            <button class="btn btn-sm btn-secondary" id="mob-fields-none">Select None</button>
            <button class="btn btn-sm btn-primary" id="mob-fields-add">+ Add Field</button>
        </div>
        <div style="max-height:55vh;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm);">
            ${fieldRows || '<div style="padding:12px;color:var(--text-muted);font-size:13px;">No fields in this layer.</div>'}
        </div>
    `;

    showModal('Fields — ' + layer.name, html, {
        width: '400px',
        onMount: (overlay, close) => {
            // Checkbox toggles
            overlay.querySelectorAll('.mob-field-chk').forEach(chk => {
                chk.addEventListener('change', () => {
                    toggleField(chk.dataset.name, chk.checked);
                });
            });
            // Select All / None
            overlay.querySelector('#mob-fields-all')?.addEventListener('click', () => {
                selectAllFields(true);
                overlay.querySelectorAll('.mob-field-chk').forEach(c => c.checked = true);
            });
            overlay.querySelector('#mob-fields-none')?.addEventListener('click', () => {
                selectAllFields(false);
                overlay.querySelectorAll('.mob-field-chk').forEach(c => c.checked = false);
            });
            // Add Field — close modal and open addField dialog
            overlay.querySelector('#mob-fields-add')?.addEventListener('click', () => {
                close();
                addField();
            });
        }
    });
}

function mobileShowStylingModal() {
    const layer = getActiveLayer();
    if (!layer) {
        showToast('Select a layer first', 'warning');
        return;
    }
    if (layer.type !== 'spatial') {
        showToast('Layer styling is only for spatial layers', 'info');
        return;
    }
    const styleHtml = buildStylePanel(layer);
    showModal('Layer Styling — ' + layer.name, styleHtml, {
        onMount: (overlay) => {
            bindStylePanel(layer, overlay);
        }
    });
}

function mobileShowDataToolsModal() {
    const layer = getActiveLayer();
    if (!layer) {
        showToast('Import data first', 'warning');
        return;
    }
    const items = [
        { label: 'Split Column', action: 'openSplitColumn' },
        { label: 'Combine', action: 'openCombineColumns' },
        { label: 'Template', action: 'openTemplateBuilder' },
        { label: 'Replace/Clean', action: 'openReplaceClean' },
        { label: 'Type Convert', action: 'openTypeConvert' },
        { label: 'Filter', action: 'openFilterBuilder' },
        { label: 'Dedup', action: 'openDeduplicate' },
        { label: 'Join', action: 'openJoinTool' },
        { label: 'Validate', action: 'openValidation' },
        { label: 'Add UID', action: 'addUID' },
    ];
    const html = `<div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${items.map(i => `<button class="btn btn-secondary" style="flex:1 1 calc(50% - 4px);min-height:48px;" data-action="${i.action}">${i.label}</button>`).join('')}
    </div>`;
    showModal('Data Tools — ' + layer.name, html, {
        onMount: (overlay, close) => {
            overlay.querySelectorAll('[data-action]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const fn = btn.dataset.action;
                    close(null);
                    if (window.app[fn]) window.app[fn]();
                });
            });
        }
    });
}

function mobileShowBasemapModal() {
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
    const currentBasemap = document.getElementById('basemap-select')?.value || 'voyager';
    const html = `
        <div style="display:flex;flex-direction:column;gap:6px;">
            ${basemapOptions.map(o => `
                <button class="btn ${o.value === currentBasemap ? 'btn-primary' : 'btn-secondary'}"
                    style="min-height:48px;justify-content:flex-start;gap:12px;"
                    data-basemap="${o.value}">
                    🌍 ${o.label}
                </button>
            `).join('')}
        </div>`;
    showModal('Basemap', html, {
        onMount: (overlay, close) => {
            overlay.querySelectorAll('[data-basemap]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const val = btn.dataset.basemap;
                    mapManager.setBasemap(val);
                    const desktopSelect = document.getElementById('basemap-select');
                    if (desktopSelect) desktopSelect.value = val;
                    close(null);
                    showToast(`Basemap: ${btn.textContent.trim()}`, 'success', { duration: 1500 });
                });
            });
        }
    });
}

// ============================
// Coordinate Search — add point from search marker
// ============================
function _coordSearchAddNew() {
    const info = mapManager.getSearchLatLng();
    if (!info) return showToast('No search marker active', 'warning');

    const feature = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [info.lng, info.lat] },
        properties: {
            name: 'Search Point',
            latitude: info.lat.toFixed(6),
            longitude: info.lng.toFixed(6),
            source: info.inputText || ''
        }
    };

    const ds = createSpatialDataset('Search Point', { type: 'FeatureCollection', features: [feature] });
    addLayer(ds);
    setActiveLayer(ds.id);
    mapManager.addLayer(ds, getLayers().indexOf(ds), { fit: false });
    refreshUI();
    mapManager._clearSearchMarker();
    showToast('Created new layer with search point', 'success');
}

function _coordSearchAddToExisting() {
    const info = mapManager.getSearchLatLng();
    if (!info) return showToast('No search marker active', 'warning');

    const layers = getLayers().filter(l => l.type === 'spatial');
    if (layers.length === 0) {
        // No layers — fall back to creating new
        _coordSearchAddNew();
        return;
    }

    // Show a picker if multiple layers, or use the single / active one
    const active = getActiveLayer();
    if (layers.length === 1) {
        _addSearchPointToLayer(layers[0], info);
        return;
    }

    // Build a picker modal
    const listHtml = layers.map(l => {
        const isActive = active && l.id === active.id;
        const count = l.geojson?.features?.length || 0;
        return `<button class="coord-layer-pick-btn" data-id="${l.id}" style="
            display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:1px solid var(--border);
            border-radius:6px;background:${isActive ? 'rgba(37,99,235,0.12)' : 'var(--bg-surface)'};cursor:pointer;
            color:var(--text);font-size:13px;text-align:left;
        ">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${l.name}</span>
            <span style="font-size:10px;color:var(--text-muted);">${count} features</span>
            ${isActive ? '<span style="font-size:9px;color:var(--primary);">active</span>' : ''}
        </button>`;
    }).join('');

    const html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
        Select a layer to add the search point to:
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;max-height:300px;overflow-y:auto;">${listHtml}</div>`;

    showModal('Add to Layer', html, {
        width: '360px',
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelectorAll('.coord-layer-pick-btn').forEach(btn => {
                btn.onclick = () => {
                    const layer = getLayers().find(l => l.id === btn.dataset.id);
                    if (layer) _addSearchPointToLayer(layer, info);
                    close();
                };
            });
        }
    });
}

function _addSearchPointToLayer(layer, info) {
    const feature = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [info.lng, info.lat] },
        properties: {
            name: `Search Point ${(layer.geojson?.features?.length || 0) + 1}`,
            latitude: info.lat.toFixed(6),
            longitude: info.lng.toFixed(6),
            source: info.inputText || ''
        }
    };

    saveSnapshot(layer.id, 'Add search point', layer.geojson);
    layer.geojson.features.push(feature);

    import('./core/data-model.js').then(dm => {
        layer.schema = dm.analyzeSchema(layer.geojson);
        bus.emit('layer:updated', layer);
        bus.emit('layers:changed', getLayers());
        mapManager.addLayer(layer, getLayers().indexOf(layer));
        refreshUI();
    });

    mapManager._clearSearchMarker();
    showToast(`Point added to "${layer.name}"`, 'success');
}

function _coordSearchClear() {
    mapManager._clearSearchMarker();
}

// ============================
// Mobile: Current Location
// ============================
let _mobileLocationLayerId = null;

function mobileAddCurrentLocation() {
    if (!navigator.geolocation) {
        showToast('Geolocation not supported on this device', 'error');
        return;
    }

    showToast('Getting location…', 'info', { duration: 3000 });

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            const accuracy = position.coords.accuracy;

            // Check if we have an existing location layer
            let layer = _mobileLocationLayerId ? getLayers().find(l => l.id === _mobileLocationLayerId) : null;

            if (!layer) {
                // Look for any existing draw layer
                const drawLayers = getLayers().filter(l => l._isDrawLayer);
                if (drawLayers.length > 0) {
                    // Use the first existing draw layer
                    layer = drawLayers[0];
                    _mobileLocationLayerId = layer.id;
                } else {
                    // Create a new draw layer
                    const newLayer = createSpatialDataset('My Locations', {
                        type: 'FeatureCollection',
                        features: []
                    });
                    newLayer._isDrawLayer = true;
                    addLayer(newLayer);
                    setActiveLayer(newLayer.id);
                    _mobileLocationLayerId = newLayer.id;
                    layer = newLayer;
                    mapManager.addLayer(newLayer, 0);
                }
            }

            // Add point feature
            const timestamp = new Date().toISOString();
            const feature = {
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [lng, lat]
                },
                properties: {
                    name: `Location ${(layer.geojson?.features?.length || 0) + 1}`,
                    timestamp: timestamp,
                    accuracy_m: Math.round(accuracy),
                    latitude: lat.toFixed(6),
                    longitude: lng.toFixed(6)
                }
            };

            saveSnapshot(layer.id, 'Add current location', layer.geojson);
            layer.geojson.features.push(feature);

            import('./core/data-model.js').then(dm => {
                layer.schema = dm.analyzeSchema(layer.geojson);
                bus.emit('layer:updated', layer);
                bus.emit('layers:changed', getLayers());
                mapManager.addLayer(layer, getLayers().indexOf(layer));
                refreshUI();
            });

            // Pan map to location
            mapManager.map?.setView([lat, lng], Math.max(mapManager.map.getZoom(), 15));
            showToast(`📍 Location added (±${Math.round(accuracy)}m)`, 'success');
        },
        (error) => {
            let msg = 'Could not get location';
            if (error.code === 1) msg = 'Location permission denied';
            else if (error.code === 2) msg = 'Location unavailable';
            else if (error.code === 3) msg = 'Location request timed out';
            showToast(msg, 'error');
        },
        {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        }
    );
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
        html += layers.map((l, idx) => {
            const isActive = l.id === layer?.id;
            const icon = l.type === 'spatial' ? '🗺️' : '📊';
            const count = l.type === 'spatial'
                ? `${l.geojson?.features?.length || 0} features`
                : `${l.rows?.length || 0} rows`;
            const geomBadge = l.schema?.geometryType
                ? `<span class="badge badge-info">${l.schema.geometryType}</span>` : '';
            const filterBadge = l._activeFilter
                ? `<span class="layer-filter-badge" title="Filter active" onclick="event.stopPropagation(); window.app.openFilterBuilder('${l.id}')">FILTERED</span>`
                : '';
            return `
                <div class="layer-item ${isActive ? 'active' : ''}" data-id="${l.id}" onclick="window.app.setActiveLayer('${l.id}')">
                    <span class="layer-icon">${icon}</span>
                    <div class="layer-name-row">
                        <div class="layer-name">${l.name}</div>
                        ${filterBadge}
                        <div class="layer-order-btns">
                            <button title="Move up" ${idx === 0 ? 'disabled' : ''} onclick="event.stopPropagation(); window.app.moveLayerUp('${l.id}')">▲</button>
                            <button title="Move down" ${idx === layers.length - 1 ? 'disabled' : ''} onclick="event.stopPropagation(); window.app.moveLayerDown('${l.id}')">▼</button>
                        </div>
                    </div>
                    <div class="layer-bottom-row">
                        <div class="layer-meta">${count} · ${l.schema?.fields?.length || 0} fields ${geomBadge}</div>
                        <div class="layer-actions">
                            <button class="btn-icon" title="Rename" onclick="event.stopPropagation(); window.app.renameLayer('${l.id}')">✏️</button>
                            <button class="btn-icon" title="Toggle visibility" onclick="event.stopPropagation(); window.app.toggleVisibility('${l.id}')">
                                ${l.visible !== false ? '👁️' : '👁️‍🗨️'}
                            </button>
                            <button class="btn-icon" title="Zoom to layer" onclick="event.stopPropagation(); window.app.zoomToLayer('${l.id}')">🔍</button>
                            <button class="btn-icon" title="Remove" onclick="event.stopPropagation(); window.app.removeLayer('${l.id}')">🗑️</button>
                        </div>
                    </div>
                </div>`;
        }).join('');
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
        <h3>Layer Data Tools</h3>
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
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <button class="btn-selection-toggle" onclick="window.app.toggleSelectionMode()">✦ Select</button>
            <button class="btn btn-sm btn-secondary" onclick="window.app.clearSelection()">Clear</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;">
            ${layers.length >= 2 ? '<button class="btn btn-primary btn-sm" onclick="window.app.mergeLayers()">🔗 Merge Layers</button>' : ''}
            <button class="btn btn-secondary btn-sm" onclick="window.app.openDistanceTool()">📏 Distance</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openBearingTool()">🧭 Bearing</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openBuffer()">⭕ Buffer</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openBboxClip()">✂️ BBox Clip</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openClip()">🔲 Clip Extent</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openSimplify()">〰️ Simplify</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openBezierSpline()">🌊 Spline</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openPolygonSmooth()">🔵 Smooth</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openUnion()">🔶 Union</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openDissolve()">🫧 Dissolve</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openCombine()">🔗 Combine</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openKinks()">⚠ Kinks</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openNearestNeighborAnalysis()">📊 NN Analysis</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openPhotoMapper()">📷 Photo Map</button>
            <button class="btn btn-secondary btn-sm" onclick="window.app.openArcGISImporter()">🌐 ArcGIS REST</button>
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
    } else if (layer.type === 'table') {
        saveSnapshot(layer.id, name, layer.rows);
        layer.rows = newFeatures.map(f => f.properties ? { ...f.properties } : f);
        import('./core/data-model.js').then(dm => {
            layer.schema = dm.analyzeTableSchema(layer.rows, Object.keys(layer.rows[0] || {}));
            bus.emit('layer:updated', layer);
            bus.emit('layers:changed', getLayers());
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
            <div id="cc-fields-list" style="max-height:200px;overflow-y:auto;">
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
                const selected = Array.from(overlay.querySelectorAll('#cc-fields-list input[type=checkbox]:checked')).map(el => el.value).filter(Boolean);
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
async function openFilterBuilder(targetLayerId) {
    // If called with a specific layer, switch to it first
    if (targetLayerId) {
        setActiveLayer(targetLayerId);
        refreshUI();
    }
    const layer = getActiveLayer();
    if (!layer) return showToast('No active layer', 'warning');
    const fields = getFieldNames();
    const operators = transforms.FILTER_OPERATORS;
    const existing = layer._activeFilter || null;

    const removeBtn = existing
        ? '<button class="btn btn-danger" id="fb-remove-filter" style="margin-right:auto;">Remove Filter</button>'
        : '';

    const html = `
        <div id="filter-rules"></div>
        <button class="btn btn-sm btn-secondary mt-8" id="fb-add-rule">+ Add Rule</button>
        <div class="form-group mt-8"><label>Logic</label>
            <select id="fb-logic"><option value="AND" ${existing?.logic === 'AND' ? 'selected' : ''}>AND (all match)</option><option value="OR" ${existing?.logic === 'OR' ? 'selected' : ''}>OR (any match)</option></select></div>`;

    showModal(existing ? 'Edit Filter' : 'Filter Builder', html, {
        width: '650px',
        footer: `${removeBtn}<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Apply Filter</button>`,
        onMount: (overlay, close) => {
            const rulesContainer = overlay.querySelector('#filter-rules');
            let ruleCount = 0;

            const addRule = (preset) => {
                ruleCount++;
                const ruleHtml = `<div class="flex gap-4 items-center mb-8" data-rule="${ruleCount}">
                    <select class="rule-field" style="flex:1">${fields.map(f => `<option ${preset?.field === f ? 'selected' : ''}>${f}</option>`).join('')}</select>
                    <select class="rule-op" style="flex:1">${operators.map(o => `<option value="${o.value}" ${preset?.operator === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
                    <input type="text" class="rule-val" placeholder="value" style="flex:1" value="${preset?.value ?? ''}">
                    <button class="btn-icon" onclick="this.parentElement.remove()">✕</button>
                </div>`;
                rulesContainer.insertAdjacentHTML('beforeend', ruleHtml);
            };

            // Pre-populate existing rules or add one blank rule
            if (existing && existing.rules.length > 0) {
                existing.rules.forEach(r => addRule(r));
            } else {
                addRule();
            }

            overlay.querySelector('#fb-add-rule').onclick = () => addRule();
            overlay.querySelector('.cancel-btn').onclick = () => close();

            // Remove filter button
            const removeFilterBtn = overlay.querySelector('#fb-remove-filter');
            if (removeFilterBtn) {
                removeFilterBtn.onclick = () => {
                    if (layer._preFilterSnapshot) {
                        saveSnapshot(layer.id, 'Remove Filter', layer.geojson);
                        layer.geojson = JSON.parse(JSON.stringify(layer._preFilterSnapshot));
                        delete layer._activeFilter;
                        delete layer._preFilterSnapshot;
                        import('./core/data-model.js').then(dm => {
                            layer.schema = dm.analyzeSchema(layer.geojson);
                            bus.emit('layer:updated', layer);
                            bus.emit('layers:changed', getLayers());
                            mapManager.addLayer(layer, getLayers().indexOf(layer));
                            refreshUI();
                        });
                        showToast('Filter removed', 'success');
                    } else {
                        showToast('No snapshot — use Undo to revert', 'info');
                    }
                    close();
                };
            }

            overlay.querySelector('.apply-btn').onclick = () => {
                const rules = Array.from(rulesContainer.querySelectorAll('[data-rule]')).map(el => ({
                    field: el.querySelector('.rule-field').value,
                    operator: el.querySelector('.rule-op').value,
                    value: el.querySelector('.rule-val').value
                }));
                const logic = overlay.querySelector('#fb-logic').value;

                // If re-filtering, restore pre-filter data first so filter stacks don't compound
                const sourceFeatures = layer._preFilterSnapshot
                    ? JSON.parse(JSON.stringify(layer._preFilterSnapshot)).features
                    : getFeatures();

                // Store pre-filter snapshot only on first filter
                if (!layer._preFilterSnapshot) {
                    layer._preFilterSnapshot = JSON.parse(JSON.stringify(layer.geojson));
                }

                const result = transforms.applyFilters(sourceFeatures, rules, logic);
                layer._activeFilter = { rules, logic };
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

    const work = getWorkingFeatures(layer);
    const selNote = work.isSelection ? `<div class="info-box text-xs">Operating on <strong>${work.count}</strong> selected features (of ${work.totalCount}).</div>` : '';
    const html = `
        <div class="form-group"><label>Buffer distance</label>
            <input type="number" id="buf-dist" value="100" min="0.001" step="1"></div>
        <div class="form-group"><label>Units</label>
            <select id="buf-units"><option value="feet" selected>Feet</option><option value="meters">Meters</option><option value="miles">Miles</option><option value="kilometers">Kilometers</option></select></div>
        ${work.count > 5000 ? '<div class="warning-box">Large dataset — this may be slow.</div>' : ''}
        ${selNote}`;

    showModal('Buffer', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Buffer</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const dist = parseFloat(overlay.querySelector('#buf-dist').value);
                const units = overlay.querySelector('#buf-units').value;
                close();
                try {
                    const result = await gisTools.bufferFeatures(getWorkingDataset(layer), dist, units);
                    addLayer(result);
                    mapManager.addLayer(result, getLayers().indexOf(result), { fit: true });
                    showToast(`Buffer complete — new layer "${result.name}" created`, 'success');
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

    const work = getWorkingFeatures(layer);
    const selNote = work.isSelection ? `<div class="info-box text-xs">Operating on <strong>${work.count}</strong> selected features.</div>` : '';
    const html = `
        <div class="form-group"><label>Tolerance (degrees, e.g., 0.001)</label>
            <input type="number" id="simp-tol" value="0.001" min="0.00001" step="0.0001"></div>
        ${selNote}`;

    showModal('Simplify Geometries', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Simplify</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const tol = parseFloat(overlay.querySelector('#simp-tol').value);
                close();
                try {
                    const { dataset, stats } = await gisTools.simplifyFeatures(getWorkingDataset(layer), tol);
                    addLayer(dataset);
                    mapManager.addLayer(dataset, getLayers().indexOf(dataset), { fit: true });
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

    const work = getWorkingFeatures(layer);
    const selNote = work.isSelection ? `<p class="info-box text-xs">Operating on <strong>${work.count}</strong> selected features.</p>` : '';
    showModal('Clip to Current Map Extent', `<p>This will clip features to the current visible map area.</p>${selNote}`, {
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
                    const result = await gisTools.clipFeatures(getWorkingDataset(layer), bbox.geometry);
                    addLayer(result);
                    mapManager.addLayer(result, getLayers().indexOf(result), { fit: true });
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
// New Turf.js Geoprocessing Tools
// ============================

// Helper: require spatial layer
function requireSpatialLayer(geomTypes = null) {
    const layer = getActiveLayer();
    if (!layer || layer.type !== 'spatial') { showToast('Need a spatial layer', 'warning'); return null; }
    if (typeof turf === 'undefined') { showToast('Turf.js not loaded yet', 'warning'); return null; }
    if (geomTypes) {
        const types = Array.isArray(geomTypes) ? geomTypes : [geomTypes];
        const has = layer.geojson.features.some(f => f.geometry && types.includes(f.geometry.type));
        if (!has) { showToast(`Need ${types.join(' or ')} features`, 'warning'); return null; }
    }
    return layer;
}

/**
 * Get the features to operate on for the active layer.
 * If features are selected → returns only selected features as a FeatureCollection.
 * If nothing selected → returns all features (the full geojson).
 * Also returns metadata about whether this is a selection or full dataset.
 */
function getWorkingFeatures(layer) {
    if (!layer || layer.type !== 'spatial') return null;
    const selected = mapManager.getSelectedFeatures(layer.id, layer.geojson);
    if (selected && selected.features.length > 0) {
        return {
            geojson: selected,
            isSelection: true,
            count: selected.features.length,
            totalCount: layer.geojson.features.length
        };
    }
    return {
        geojson: layer.geojson,
        isSelection: false,
        count: layer.geojson.features.length,
        totalCount: layer.geojson.features.length
    };
}

/**
 * Build a temporary dataset-like object from the working features for tools.
 * Tools that take a `dataset` (with .geojson, .name, etc.) can use this.
 */
function getWorkingDataset(layer) {
    const work = getWorkingFeatures(layer);
    if (!work) return null;
    return {
        ...layer,
        geojson: work.geojson,
        _isSelection: work.isSelection,
        _selectionCount: work.count
    };
}

// Selection mode toggle
function toggleSelectionMode() {
    if (mapManager.isSelectionMode()) {
        mapManager.exitSelectionMode();
    } else {
        mapManager.enterSelectionMode();
    }
    updateSelectionUI();
}

function clearSelection() {
    mapManager.clearSelection();
    updateSelectionUI();
}

function selectAllFeatures() {
    const layer = getActiveLayer();
    if (!layer || layer.type !== 'spatial') return;
    mapManager.selectAll(layer.id, layer.geojson);
    updateSelectionUI();
}

function invertSelection() {
    const layer = getActiveLayer();
    if (!layer || layer.type !== 'spatial') return;
    mapManager.invertSelection(layer.id, layer.geojson);
    updateSelectionUI();
}

async function deleteSelectedFeatures() {
    const layer = getActiveLayer();
    if (!layer || layer.type !== 'spatial') return;
    const indices = mapManager.getSelectedIndices(layer.id);
    if (indices.length === 0) return showToast('No features selected', 'warning');
    const ok = await confirm('Delete Features', `Delete ${indices.length} selected feature(s)? This can be undone.`);
    if (!ok) return;

    const selectedSet = new Set(indices);
    const remaining = layer.geojson.features.filter((_, i) => !selectedSet.has(i));
    saveSnapshot(layer.id, `Delete ${indices.length} feature(s)`, layer.geojson);
    layer.geojson = { type: 'FeatureCollection', features: remaining };

    import('./core/data-model.js').then(dm => {
        layer.schema = dm.analyzeSchema(layer.geojson);
        bus.emit('layer:updated', layer);
        bus.emit('layers:changed', getLayers());
        mapManager.clearSelection(layer.id);
        mapManager.addLayer(layer, getLayers().indexOf(layer));
        refreshUI();
    });
    showToast(`Deleted ${indices.length} feature(s)`, 'success');
}

/** Update the selection bar UI */
function updateSelectionUI() {
    const bar = document.getElementById('selection-bar');
    const toggleBtn = document.getElementById('btn-selection-toggle');
    if (!bar) return;

    const layer = getActiveLayer();
    const count = layer ? mapManager.getSelectionCount(layer.id) : 0;
    const total = layer?.geojson?.features?.length || 0;
    const isMode = mapManager.isSelectionMode();

    // Update toggle button state
    if (toggleBtn) {
        toggleBtn.classList.toggle('active', isMode);
        toggleBtn.textContent = isMode ? '✦ Select ON' : '✦ Select';
    }

    if (count > 0) {
        bar.classList.remove('hidden');
        bar.innerHTML = `
            <span class="sel-count">${count}</span> of ${total} features selected
            <button class="sel-btn" onclick="window.app.selectAllFeatures()">All</button>
            <button class="sel-btn" onclick="window.app.invertSelection()">Invert</button>
            <button class="sel-btn" onclick="window.app.deleteSelectedFeatures()" title="Delete selected features" style="color:var(--error);">🗑 Delete</button>
            <button class="sel-btn sel-clear" onclick="window.app.clearSelection()">✕ Clear</button>
        `;
    } else {
        bar.classList.add('hidden');
        bar.innerHTML = '';
    }
}

// Helper: layer dropdown options
function layerOptions(filterType = null) {
    return getLayers()
        .filter(l => l.type === 'spatial' && (!filterType || l.geojson.features.some(f => f.geometry && (Array.isArray(filterType) ? filterType.includes(f.geometry.type) : f.geometry.type === filterType))))
        .map(l => `<option value="${l.id}">${l.name} (${l.geojson.features.length})</option>`)
        .join('');
}

function addResultLayer(dataset) {
    addLayer(dataset);
    mapManager.addLayer(dataset, getLayers().indexOf(dataset), { fit: true });
    refreshUI();
}

// Helper: convert kilometers to the user-selected unit
function convertKm(km, toUnit) {
    switch (toUnit) {
        case 'feet':  return km * 3280.84;
        case 'meters': return km * 1000;
        case 'miles':  return km * 0.621371;
        default:       return km;
    }
}

// Standard unit select options HTML (feet default)
const UNIT_OPTIONS_HTML = '<option value="feet" selected>Feet</option><option value="meters">Meters</option><option value="miles">Miles</option><option value="kilometers">Kilometers</option>';

// --- Distance ---
async function openDistanceTool() {
    if (typeof turf === 'undefined') return showToast('Turf.js not loaded yet', 'warning');
    const html = `
        <p>Click two points on the map to measure the straight-line distance between them.</p>
        <div class="form-group"><label>Units</label>
            <select id="dist-units"><option value="feet" selected>Feet</option><option value="meters">Meters</option><option value="miles">Miles</option><option value="kilometers">Kilometers</option></select>
        </div>`;
    showModal('Measure Distance', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Pick Points on Map</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const units = overlay.querySelector('#dist-units').value;
                close();
                const pts = await mapManager.startTwoPointPick('Click the first point', 'Click the second point');
                if (!pts) return;
                const d = gisTools.distance(turf.point(pts[0]), turf.point(pts[1]), units);
                const line = turf.lineString([pts[0], pts[1]]);
                const tempLayer = mapManager.showTempFeature(line, 15000);
                showToast(`Distance: ${d.toFixed(4)} ${units}`, 'success', { duration: 10000 });
            };
        }
    });
}

// --- Bearing ---
async function openBearingTool() {
    if (typeof turf === 'undefined') return showToast('Turf.js not loaded yet', 'warning');
    const html = `<p>Click two points on the map. The bearing (compass direction) from the first point to the second will be calculated.</p>`;
    showModal('Measure Bearing', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Pick Points on Map</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                close();
                const pts = await mapManager.startTwoPointPick('Click the origin point', 'Click the target point');
                if (!pts) return;
                const b = gisTools.bearing(turf.point(pts[0]), turf.point(pts[1]));
                const line = turf.lineString([pts[0], pts[1]]);
                mapManager.showTempFeature(line, 15000);
                const cardinal = bearingToCardinal(b);
                showToast(`Bearing: ${b.toFixed(2)}° (${cardinal})`, 'success', { duration: 10000 });
            };
        }
    });
}

function bearingToCardinal(b) {
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    const norm = ((b % 360) + 360) % 360;
    return dirs[Math.round(norm / 22.5) % 16];
}

// --- Destination ---
async function openDestinationTool() {
    if (typeof turf === 'undefined') return showToast('Turf.js not loaded yet', 'warning');
    const html = `
        <p>Click a starting point, then enter a distance and bearing to find the destination point.</p>
        <div class="form-group"><label>Distance</label>
            <input type="number" id="dest-dist" value="100" min="0.001" step="1"></div>
        <div class="form-group"><label>Bearing (degrees, 0=North, 90=East)</label>
            <input type="number" id="dest-bearing" value="0" min="-180" max="360" step="1"></div>
        <div class="form-group"><label>Units</label>
            <select id="dest-units"><option value="feet" selected>Feet</option><option value="meters">Meters</option><option value="miles">Miles</option><option value="kilometers">Kilometers</option></select></div>`;
    showModal('Find Destination Point', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Pick Origin on Map</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const dist = parseFloat(overlay.querySelector('#dest-dist').value);
                const brng = parseFloat(overlay.querySelector('#dest-bearing').value);
                const units = overlay.querySelector('#dest-units').value;
                close();
                const origin = await mapManager.startPointPick('Click the starting point');
                if (!origin) return;
                const dest = gisTools.destination(turf.point(origin), dist, brng, units);
                const line = turf.lineString([origin, dest.geometry.coordinates]);
                mapManager.showTempFeature({type:'FeatureCollection',features:[dest, line]}, 15000);
                showToast(`Destination: [${dest.geometry.coordinates[1].toFixed(6)}, ${dest.geometry.coordinates[0].toFixed(6)}]`, 'success', { duration: 10000 });
            };
        }
    });
}

// --- Along ---
async function openAlongTool() {
    const layer = requireSpatialLayer(['LineString', 'MultiLineString']);
    if (!layer) return;

    const work = getWorkingFeatures(layer);
    const selNote = work.isSelection ? `<div class="info-box text-xs">Using first line from <strong>${work.count}</strong> selected features.</div>` : '';
    const html = `
        <p>Get a point at a specified distance along a line feature.</p>
        <div class="form-group"><label>Distance along line</label>
            <input type="number" id="along-dist" value="100" min="0" step="1"></div>
        <div class="form-group"><label>Units</label>
            <select id="along-units"><option value="feet" selected>Feet</option><option value="meters">Meters</option><option value="miles">Miles</option><option value="kilometers">Kilometers</option></select></div>
        ${selNote}
        <div class="info-box text-xs">Uses the first LineString feature${work.isSelection ? ' in the selection' : ' in the active layer'}.</div>`;
    showModal('Point Along Line', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Find Point</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const dist = parseFloat(overlay.querySelector('#along-dist').value);
                const units = overlay.querySelector('#along-units').value;
                close();
                const line = work.geojson.features.find(f => f.geometry?.type === 'LineString');
                if (!line) return showToast('No LineString found in layer', 'warning');
                try {
                    const pt = gisTools.pointAlong(line, dist, units);
                    mapManager.showTempFeature(pt, 15000);
                    showToast(`Point at ${dist} ${units}: [${pt.geometry.coordinates[1].toFixed(6)}, ${pt.geometry.coordinates[0].toFixed(6)}]`, 'success', { duration: 8000 });
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'Along'));
                }
            };
        }
    });
}

// --- Point to Line Distance ---
async function openPointToLineDistanceTool() {
    if (typeof turf === 'undefined') return showToast('Turf.js not loaded yet', 'warning');
    const lineLayers = layerOptions(['LineString', 'MultiLineString']);
    if (!lineLayers) return showToast('Need a line layer loaded', 'warning');

    const html = `
        <p>Click a point on the map, then measure the shortest distance to a line layer.</p>
        <div class="form-group"><label>Line layer</label>
            <select id="ptl-layer">${lineLayers}</select></div>
        <div class="form-group"><label>Units</label>
            <select id="ptl-units"><option value="feet" selected>Feet</option><option value="meters">Meters</option><option value="miles">Miles</option><option value="kilometers">Kilometers</option></select></div>`;
    showModal('Point to Line Distance', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Pick Point on Map</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const layerId = overlay.querySelector('#ptl-layer').value;
                const units = overlay.querySelector('#ptl-units').value;
                const lineLayer = getLayers().find(l => l.id === layerId);
                close();
                if (!lineLayer) return showToast('Line layer not found', 'warning');
                const pt = await mapManager.startPointPick('Click a point to measure from');
                if (!pt) return;
                const line = lineLayer.geojson.features.find(f => f.geometry?.type === 'LineString');
                if (!line) return showToast('No LineString found', 'warning');
                try {
                    const d = gisTools.pointToLineDistance(turf.point(pt), line, units);
                    const snap = gisTools.nearestPointOnLine(line, turf.point(pt), units);
                    const connector = turf.lineString([pt, snap.geometry.coordinates]);
                    mapManager.showTempFeature({type:'FeatureCollection',features:[turf.point(pt), snap, connector]}, 15000);
                    showToast(`Distance to line: ${d.toFixed(4)} ${units}`, 'success', { duration: 10000 });
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'PointToLineDistance'));
                }
            };
        }
    });
}

// --- BBox Clip (draw rectangle) ---
async function openBboxClip() {
    const layer = requireSpatialLayer();
    if (!layer) return;

    const work = getWorkingFeatures(layer);
    const selNote = work.isSelection ? `<p class="info-box text-xs">Operating on <strong>${work.count}</strong> selected features.</p>` : '';
    showModal('BBox Clip', `<p>Draw a rectangle on the map to clip features to that area.</p>${selNote}`, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Draw Rectangle on Map</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                close();
                const bbox = await mapManager.startRectangleDraw('Click and drag to draw a clip rectangle');
                if (!bbox) return;
                try {
                    const result = await gisTools.bboxClipFeatures(getWorkingDataset(layer), bbox);
                    addResultLayer(result);
                    showToast(`Clipped: ${result.geojson.features.length} features`, 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'BBoxClip'));
                }
            };
        }
    });
}

// --- Bezier Spline ---
async function openBezierSpline() {
    const layer = requireSpatialLayer(['LineString', 'MultiLineString']);
    if (!layer) return;

    const work = getWorkingFeatures(layer);
    const selNote = work.isSelection ? `<div class="info-box text-xs">Operating on <strong>${work.count}</strong> selected features.</div>` : '';
    const html = `
        <p>Smooth line features into curved bezier splines.</p>
        <div class="form-group"><label>Resolution (higher = smoother, default 10000)</label>
            <input type="number" id="spline-res" value="10000" min="100" step="500"></div>
        <div class="form-group"><label>Sharpness (0-1, higher = sharper curves)</label>
            <input type="number" id="spline-sharp" value="0.85" min="0" max="1" step="0.05"></div>
        ${selNote}`;
    showModal('Bezier Spline', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Apply</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const res = parseInt(overlay.querySelector('#spline-res').value);
                const sharp = parseFloat(overlay.querySelector('#spline-sharp').value);
                close();
                try {
                    const result = await gisTools.bezierSplineFeatures(getWorkingDataset(layer), res, sharp);
                    addResultLayer(result);
                    showToast('Bezier spline applied', 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'BezierSpline'));
                }
            };
        }
    });
}

// --- Polygon Smooth ---
async function openPolygonSmooth() {
    const layer = requireSpatialLayer(['Polygon', 'MultiPolygon']);
    if (!layer) return;

    const work = getWorkingFeatures(layer);
    const selNote = work.isSelection ? `<div class="info-box text-xs">Operating on <strong>${work.count}</strong> selected features.</div>` : '';
    const html = `
        <p>Smooth jagged polygon edges by averaging corner positions.</p>
        <div class="form-group"><label>Iterations (higher = smoother, default 1)</label>
            <input type="number" id="smooth-iter" value="1" min="1" max="10" step="1"></div>
        ${selNote}`;
    showModal('Polygon Smooth', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Smooth</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const iter = parseInt(overlay.querySelector('#smooth-iter').value);
                close();
                try {
                    const result = await gisTools.polygonSmoothFeatures(getWorkingDataset(layer), iter);
                    addResultLayer(result);
                    showToast('Polygons smoothed', 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'PolygonSmooth'));
                }
            };
        }
    });
}

// --- Line Offset ---
async function openLineOffset() {
    const layer = requireSpatialLayer(['LineString', 'MultiLineString']);
    if (!layer) return;

    const work = getWorkingFeatures(layer);
    const selNote = work.isSelection ? `<div class="info-box text-xs">Operating on <strong>${work.count}</strong> selected features.</div>` : '';
    const html = `
        <p>Create a parallel copy of line features, offset by the specified distance. Positive = right side, negative = left side.</p>
        <div class="form-group"><label>Offset distance</label>
            <input type="number" id="offset-dist" value="10" step="1"></div>
        <div class="form-group"><label>Units</label>
            <select id="offset-units"><option value="feet" selected>Feet</option><option value="meters">Meters</option><option value="miles">Miles</option><option value="kilometers">Kilometers</option></select></div>
        ${selNote}`;
    showModal('Line Offset', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Offset</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const dist = parseFloat(overlay.querySelector('#offset-dist').value);
                const units = overlay.querySelector('#offset-units').value;
                close();
                try {
                    const result = await gisTools.lineOffsetFeatures(getWorkingDataset(layer), dist, units);
                    addResultLayer(result);
                    showToast(`Line offset by ${dist} ${units}`, 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'LineOffset'));
                }
            };
        }
    });
}

// --- Line Slice Along ---
async function openLineSliceAlong() {
    const layer = requireSpatialLayer(['LineString', 'MultiLineString']);
    if (!layer) return;

    const html = `
        <p>Extract a section of a line between two distances measured from the start.</p>
        <div class="form-group"><label>Start distance</label>
            <input type="number" id="slice-start" value="0" min="0" step="1"></div>
        <div class="form-group"><label>Stop distance</label>
            <input type="number" id="slice-stop" value="100" min="0" step="1"></div>
        <div class="form-group"><label>Units</label>
            <select id="slice-units"><option value="feet" selected>Feet</option><option value="meters">Meters</option><option value="miles">Miles</option><option value="kilometers">Kilometers</option></select></div>`;
    showModal('Line Slice Along', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Slice</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const start = parseFloat(overlay.querySelector('#slice-start').value);
                const stop = parseFloat(overlay.querySelector('#slice-stop').value);
                const units = overlay.querySelector('#slice-units').value;
                close();
                const work = getWorkingFeatures(layer);
                const line = work.geojson.features.find(f => f.geometry?.type === 'LineString');
                if (!line) return showToast('No LineString found', 'warning');
                try {
                    const sliced = gisTools.lineSliceAlong(line, start, stop, units);
                    sliced.properties = { ...line.properties, _sliceStart: start, _sliceStop: stop };
                    const fc = { type: 'FeatureCollection', features: [sliced] };
                    const result = createSpatialDataset(`${layer.name}_slice`, fc, { format: 'derived' });
                    addResultLayer(result);
                    showToast(`Sliced line: ${start}-${stop} ${units}`, 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'LineSliceAlong'));
                }
            };
        }
    });
}

// --- Line Slice (between two map-clicked points) ---
async function openLineSlice() {
    const layer = requireSpatialLayer(['LineString', 'MultiLineString']);
    if (!layer) return;

    showModal('Line Slice Between Points', '<p>Click two points on the map. The section of the line between those points (snapped to nearest vertices) will be extracted.</p>', {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Pick Points on Map</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                close();
                const pts = await mapManager.startTwoPointPick('Click the start point along the line', 'Click the end point along the line');
                if (!pts) return;
                const work = getWorkingFeatures(layer);
                const line = work.geojson.features.find(f => f.geometry?.type === 'LineString');
                if (!line) return showToast('No LineString found', 'warning');
                try {
                    const sliced = gisTools.lineSlice(turf.point(pts[0]), turf.point(pts[1]), line);
                    sliced.properties = { ...line.properties };
                    const fc = { type: 'FeatureCollection', features: [sliced] };
                    const result = createSpatialDataset(`${layer.name}_sliced`, fc, { format: 'derived' });
                    addResultLayer(result);
                    showToast('Line sliced between points', 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'LineSlice'));
                }
            };
        }
    });
}

// --- Line Intersect ---
async function openLineIntersect() {
    if (typeof turf === 'undefined') return showToast('Turf.js not loaded yet', 'warning');
    const lineLayers = layerOptions(['LineString', 'MultiLineString']);
    if (!lineLayers) return showToast('Need line layers loaded', 'warning');

    const html = `
        <p>Find all points where two line layers cross each other.</p>
        <div class="form-group"><label>Line layer 1</label>
            <select id="lint-layer1">${lineLayers}</select></div>
        <div class="form-group"><label>Line layer 2</label>
            <select id="lint-layer2">${lineLayers}</select></div>`;
    showModal('Line Intersect', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Find Intersections</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const l1 = getLayers().find(l => l.id === overlay.querySelector('#lint-layer1').value);
                const l2 = getLayers().find(l => l.id === overlay.querySelector('#lint-layer2').value);
                close();
                if (!l1 || !l2) return showToast('Select two layers', 'warning');
                try {
                    const allPts = [];
                    const lines1 = l1.geojson.features.filter(f => f.geometry?.type === 'LineString');
                    const lines2 = l2.geojson.features.filter(f => f.geometry?.type === 'LineString');
                    for (const a of lines1) {
                        for (const b of lines2) {
                            const pts = gisTools.lineIntersect(a, b);
                            if (pts?.features) allPts.push(...pts.features);
                        }
                    }
                    const fc = { type: 'FeatureCollection', features: allPts };
                    const result = createSpatialDataset(`intersections_${l1.name}_${l2.name}`, fc, { format: 'derived' });
                    addResultLayer(result);
                    showToast(`Found ${allPts.length} intersection point(s)`, 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'LineIntersect'));
                }
            };
        }
    });
}

// --- Kinks (self-intersections) ---
async function openKinks() {
    const layer = requireSpatialLayer();
    if (!layer) return;

    const work = getWorkingFeatures(layer);
    const selNote = work.isSelection ? `<p class="info-box text-xs">Checking <strong>${work.count}</strong> selected features.</p>` : '';
    showModal('Find Kinks (Self-Intersections)', `<p>Find all points where lines or polygon edges cross over themselves. Useful for detecting geometry errors.</p>${selNote}`, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Find Kinks</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                close();
                try {
                    const result = await gisTools.findKinks(getWorkingDataset(layer));
                    addResultLayer(result);
                    showToast(`Found ${result.geojson.features.length} kink(s)`, result.geojson.features.length > 0 ? 'warning' : 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'Kinks'));
                }
            };
        }
    });
}

// --- Combine ---
async function openCombine() {
    const layer = requireSpatialLayer();
    if (!layer) return;

    const work = getWorkingFeatures(layer);
    const selNote = work.isSelection ? `<p class="info-box text-xs">Combining <strong>${work.count}</strong> selected features.</p>` : '';
    showModal('Combine Features', `<p>Merge all features of the same geometry type into a single Multi-geometry feature (e.g., multiple Points → one MultiPoint).</p>${selNote}`, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Combine</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                close();
                try {
                    const result = gisTools.combineFeatures(getWorkingDataset(layer));
                    addResultLayer(result);
                    showToast(`Combined into ${result.geojson.features.length} multi-feature(s)`, 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'Combine'));
                }
            };
        }
    });
}

// --- Union ---
async function openUnion() {
    const layer = requireSpatialLayer(['Polygon', 'MultiPolygon']);
    if (!layer) return;

    const work = getWorkingFeatures(layer);
    const polyCount = work.geojson.features.filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')).length;
    const selNote = work.isSelection ? `<p class="info-box text-xs">Unioning <strong>${polyCount}</strong> selected polygons.</p>` : '';
    showModal('Union Polygons', `<p>Merge all ${polyCount} polygon features into a single unified polygon. Overlapping areas are dissolved.</p>
        ${polyCount > 500 ? '<div class="warning-box">Large dataset — this may be slow.</div>' : ''}
        ${selNote}`, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Union</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                close();
                try {
                    const result = await gisTools.unionFeatures(getWorkingDataset(layer));
                    addResultLayer(result);
                    showToast('Union complete', 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'Union'));
                }
            };
        }
    });
}

// --- Dissolve ---
async function openDissolve() {
    const layer = requireSpatialLayer(['Polygon', 'MultiPolygon']);
    if (!layer) return;

    const work = getWorkingFeatures(layer);
    const selNote = work.isSelection ? `<div class="info-box text-xs">Dissolving <strong>${work.count}</strong> selected features.</div>` : '';
    const fields = (layer.schema?.fields || []).map(f => `<option value="${f.name}">${f.name}</option>`).join('');
    const html = `
        <p>Merge polygons that share the same value in a selected field into single polygons.</p>
        <div class="form-group"><label>Dissolve field</label>
            <select id="diss-field">${fields}</select></div>
        ${selNote}`;
    showModal('Dissolve', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Dissolve</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const field = overlay.querySelector('#diss-field').value;
                close();
                try {
                    const result = await gisTools.dissolveFeatures(getWorkingDataset(layer), field);
                    addResultLayer(result);
                    showToast(`Dissolved by ${field}`, 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'Dissolve'));
                }
            };
        }
    });
}

// --- Sector ---
async function openSector() {
    if (typeof turf === 'undefined') return showToast('Turf.js not loaded yet', 'warning');
    const html = `
        <p>Create a pie-slice shaped polygon from a center point, radius, and two compass bearings.</p>
        <div class="form-group"><label>Radius</label>
            <input type="number" id="sector-radius" value="100" min="0.001" step="1"></div>
        <div class="form-group"><label>Start bearing (degrees, 0=North)</label>
            <input type="number" id="sector-b1" value="0" min="-180" max="360" step="1"></div>
        <div class="form-group"><label>End bearing (degrees)</label>
            <input type="number" id="sector-b2" value="90" min="-180" max="360" step="1"></div>
        <div class="form-group"><label>Units</label>
            <select id="sector-units"><option value="feet" selected>Feet</option><option value="meters">Meters</option><option value="miles">Miles</option><option value="kilometers">Kilometers</option></select></div>`;
    showModal('Create Sector', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Pick Center on Map</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const radius = parseFloat(overlay.querySelector('#sector-radius').value);
                const b1 = parseFloat(overlay.querySelector('#sector-b1').value);
                const b2 = parseFloat(overlay.querySelector('#sector-b2').value);
                const units = overlay.querySelector('#sector-units').value;
                close();
                const center = await mapManager.startPointPick('Click the center point for the sector');
                if (!center) return;
                try {
                    const sector = gisTools.createSector(turf.point(center), radius, b1, b2, units);
                    sector.properties = { radius, bearing1: b1, bearing2: b2, units };
                    const fc = { type: 'FeatureCollection', features: [sector] };
                    const result = createSpatialDataset(`sector_${b1}-${b2}`, fc, { format: 'derived' });
                    addResultLayer(result);
                    showToast('Sector created', 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'Sector'));
                }
            };
        }
    });
}

// --- Nearest Point ---
async function openNearestPoint() {
    if (typeof turf === 'undefined') return showToast('Turf.js not loaded yet', 'warning');
    const ptLayers = layerOptions(['Point']);
    if (!ptLayers) return showToast('Need a point layer loaded', 'warning');

    const html = `
        <p>Click a location on the map to find the closest feature in a point layer.</p>
        <div class="form-group"><label>Point layer to search</label>
            <select id="np-layer">${ptLayers}</select></div>
        <div class="form-group"><label>Units</label>
            <select id="np-units">${UNIT_OPTIONS_HTML}</select></div>`;
    showModal('Nearest Point', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Pick Location on Map</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const layerId = overlay.querySelector('#np-layer').value;
                const units = overlay.querySelector('#np-units').value;
                const ptLayer = getLayers().find(l => l.id === layerId);
                close();
                if (!ptLayer) return;
                const target = await mapManager.startPointPick('Click the map to find the nearest point');
                if (!target) return;
                try {
                    const nearest = gisTools.nearestPoint(turf.point(target), ptLayer);
                    const line = turf.lineString([target, nearest.geometry.coordinates]);
                    mapManager.showTempFeature({type:'FeatureCollection',features:[nearest, line]}, 15000);
                    const distKm = nearest.properties.distanceToPoint;
                    const dist = convertKm(distKm, units);
                    const name = nearest.properties.name || nearest.properties.NAME || `Feature ${nearest.properties.featureIndex}`;
                    showToast(`Nearest: "${name}" (${dist?.toFixed(2) || '?'} ${units} away)`, 'success', { duration: 10000 });
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'NearestPoint'));
                }
            };
        }
    });
}

// --- Nearest Point on Line ---
async function openNearestPointOnLine() {
    if (typeof turf === 'undefined') return showToast('Turf.js not loaded yet', 'warning');
    const lineLayers = layerOptions(['LineString', 'MultiLineString']);
    if (!lineLayers) return showToast('Need a line layer loaded', 'warning');

    const html = `
        <p>Click a point on the map to find the closest spot on a line (snaps to the line).</p>
        <div class="form-group"><label>Line layer</label>
            <select id="npol-layer">${lineLayers}</select></div>
        <div class="form-group"><label>Units</label>
            <select id="npol-units">${UNIT_OPTIONS_HTML}</select></div>`;
    showModal('Nearest Point on Line', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Pick Point on Map</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = async () => {
                const layerId = overlay.querySelector('#npol-layer').value;
                const units = overlay.querySelector('#npol-units').value;
                const lineLayer = getLayers().find(l => l.id === layerId);
                close();
                if (!lineLayer) return;
                const pt = await mapManager.startPointPick('Click the map to snap to the nearest line');
                if (!pt) return;
                const line = lineLayer.geojson.features.find(f => f.geometry?.type === 'LineString');
                if (!line) return showToast('No LineString found', 'warning');
                try {
                    const snap = gisTools.nearestPointOnLine(line, turf.point(pt));
                    const connector = turf.lineString([pt, snap.geometry.coordinates]);
                    mapManager.showTempFeature({type:'FeatureCollection',features:[snap, connector]}, 15000);
                    const distKm = snap.properties.dist;
                    const dist = convertKm(distKm, units);
                    showToast(`Snapped to line at ${dist?.toFixed(2) || '?'} ${units}`, 'success', { duration: 10000 });
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'NearestPointOnLine'));
                }
            };
        }
    });
}

// --- Nearest Point to Line ---
async function openNearestPointToLine() {
    if (typeof turf === 'undefined') return showToast('Turf.js not loaded yet', 'warning');
    const ptLayers = layerOptions(['Point']);
    const lineLayers = layerOptions(['LineString', 'MultiLineString']);
    if (!ptLayers || !lineLayers) return showToast('Need a point layer and a line layer', 'warning');

    const html = `
        <p>Find which point in a point layer is closest to a specific line feature.</p>
        <div class="form-group"><label>Point layer</label>
            <select id="nptl-pts">${ptLayers}</select></div>
        <div class="form-group"><label>Line layer</label>
            <select id="nptl-line">${lineLayers}</select></div>
        <div class="form-group"><label>Units</label>
            <select id="nptl-units">${UNIT_OPTIONS_HTML}</select></div>`;
    showModal('Nearest Point to Line', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Find</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const ptsLayer = getLayers().find(l => l.id === overlay.querySelector('#nptl-pts').value);
                const lineLayer = getLayers().find(l => l.id === overlay.querySelector('#nptl-line').value);
                const units = overlay.querySelector('#nptl-units').value;
                close();
                if (!ptsLayer || !lineLayer) return;
                const line = lineLayer.geojson.features.find(f => f.geometry?.type === 'LineString');
                if (!line) return showToast('No LineString found', 'warning');
                try {
                    const nearest = gisTools.nearestPointToLine(ptsLayer.geojson, line);
                    mapManager.showTempFeature(nearest, 15000);
                    const name = nearest.properties?.name || nearest.properties?.NAME || 'Unnamed';
                    const distKm = nearest.properties?.dist;
                    const dist = convertKm(distKm, units);
                    showToast(`Nearest to line: "${name}" (${dist?.toFixed(2) || '?'} ${units})`, 'success', { duration: 10000 });
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'NearestPointToLine'));
                }
            };
        }
    });
}

// --- Nearest Neighbor Analysis ---
async function openNearestNeighborAnalysis() {
    const layer = requireSpatialLayer(['Point']);
    if (!layer) return;

    showModal('Nearest Neighbor Analysis', '<p>Analyze the spatial distribution of points. Returns statistical metrics that indicate whether points are clustered, random, or dispersed.</p>', {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Run Analysis</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                close();
                try {
                    const result = gisTools.nearestNeighborAnalysis(layer);
                    const p = result.properties || result;
                    const pattern = p.zscore < -1.65 ? 'Clustered' : (p.zscore > 1.65 ? 'Dispersed' : 'Random');
                    const html = `
                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <div style="text-align:center;font-size:20px;font-weight:700;color:var(--gold-light);margin-bottom:4px;">${pattern}</div>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                                <div style="padding:8px;background:var(--bg-surface);border-radius:4px;border:1px solid var(--border);">
                                    <div style="font-size:11px;color:var(--text-muted);">Observed Mean Distance</div>
                                    <div style="font-size:16px;font-weight:600;color:var(--text);">${p.observedMeanDistance?.toFixed(6) || 'N/A'}</div>
                                </div>
                                <div style="padding:8px;background:var(--bg-surface);border-radius:4px;border:1px solid var(--border);">
                                    <div style="font-size:11px;color:var(--text-muted);">Expected Mean Distance</div>
                                    <div style="font-size:16px;font-weight:600;color:var(--text);">${p.expectedMeanDistance?.toFixed(6) || 'N/A'}</div>
                                </div>
                                <div style="padding:8px;background:var(--bg-surface);border-radius:4px;border:1px solid var(--border);">
                                    <div style="font-size:11px;color:var(--text-muted);">Nearest Neighbor Ratio</div>
                                    <div style="font-size:16px;font-weight:600;color:var(--text);">${p.nearestNeighborIndex?.toFixed(4) || 'N/A'}</div>
                                </div>
                                <div style="padding:8px;background:var(--bg-surface);border-radius:4px;border:1px solid var(--border);">
                                    <div style="font-size:11px;color:var(--text-muted);">Z-Score</div>
                                    <div style="font-size:16px;font-weight:600;color:var(--text);">${p.zscore?.toFixed(4) || 'N/A'}</div>
                                </div>
                            </div>
                            <div class="info-box text-xs" style="margin-top:4px;">
                                <strong>Interpretation:</strong> Z-score &lt; -1.65 → Clustered. Z-score &gt; 1.65 → Dispersed. Between → Random.
                                A ratio &lt; 1 suggests clustering, &gt; 1 suggests dispersion.
                            </div>
                            <div style="font-size:11px;color:var(--text-muted);">
                                Features analyzed: ${p.numberOfPoints || layer.geojson.features.filter(f => f.geometry?.type === 'Point').length}
                            </div>
                        </div>`;
                    showModal('Nearest Neighbor Analysis — Results', html, { width: '450px' });
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'NearestNeighborAnalysis'));
                }
            };
        }
    });
}

// --- Points Within Polygon ---
async function openPointsWithinPolygon() {
    if (typeof turf === 'undefined') return showToast('Turf.js not loaded yet', 'warning');
    const ptLayers = layerOptions(['Point']);
    const polyLayers = layerOptions(['Polygon', 'MultiPolygon']);
    if (!ptLayers || !polyLayers) return showToast('Need both a point layer and a polygon layer', 'warning');

    const html = `
        <p>Find all points from one layer that fall inside polygons from another layer.</p>
        <div class="form-group"><label>Point layer</label>
            <select id="pwp-pts">${ptLayers}</select></div>
        <div class="form-group"><label>Polygon layer</label>
            <select id="pwp-polys">${polyLayers}</select></div>`;
    showModal('Points Within Polygon', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Find Points</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                const ptsLayer = getLayers().find(l => l.id === overlay.querySelector('#pwp-pts').value);
                const polyLayer = getLayers().find(l => l.id === overlay.querySelector('#pwp-polys').value);
                close();
                if (!ptsLayer || !polyLayer) return;
                try {
                    const result = gisTools.pointsWithinPolygon(ptsLayer, polyLayer);
                    addResultLayer(result);
                    const total = ptsLayer.geojson.features.length;
                    const inside = result.geojson.features.length;
                    showToast(`${inside} of ${total} points are within the polygon(s)`, 'success');
                } catch (e) {
                    showErrorToast(handleError(e, 'GISTools', 'PointsWithinPolygon'));
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
            mapManager.addLayer(result.dataset, getLayers().indexOf(result.dataset), { fit: true });
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
// GIS Widgets
// ============================
let _spatialAnalyzerWidget = null;

function openSpatialAnalyzer() {
    if (!_spatialAnalyzerWidget) {
        _spatialAnalyzerWidget = new SpatialAnalyzerWidget();
    }
    // Inject dependencies
    _spatialAnalyzerWidget.getLayers = getLayers;
    _spatialAnalyzerWidget.getLayerById = (id) => getLayers().find(l => l.id === id);
    _spatialAnalyzerWidget.mapManager = mapManager;
    _spatialAnalyzerWidget.addLayer = addLayer;
    _spatialAnalyzerWidget.createSpatialDataset = createSpatialDataset;
    _spatialAnalyzerWidget.refreshUI = refreshUI;
    _spatialAnalyzerWidget.showToast = showToast;
    _spatialAnalyzerWidget.toggle();
}

let _bulkUpdateWidget = null;

function openBulkUpdate() {
    if (!_bulkUpdateWidget) {
        _bulkUpdateWidget = new BulkUpdateWidget();
    }
    _bulkUpdateWidget.getLayers = getLayers;
    _bulkUpdateWidget.getLayerById = (id) => getLayers().find(l => l.id === id);
    _bulkUpdateWidget.mapManager = mapManager;
    _bulkUpdateWidget.refreshUI = refreshUI;
    _bulkUpdateWidget.showToast = showToast;
    _bulkUpdateWidget.toggle();
}

let _proximityJoinWidget = null;

function openProximityJoin() {
    if (!_proximityJoinWidget) {
        _proximityJoinWidget = new ProximityJoinWidget();
    }
    _proximityJoinWidget.getLayers = getLayers;
    _proximityJoinWidget.getLayerById = (id) => getLayers().find(l => l.id === id);
    _proximityJoinWidget.mapManager = mapManager;
    _proximityJoinWidget.analyzeSchema = analyzeSchema;
    _proximityJoinWidget.refreshUI = refreshUI;
    _proximityJoinWidget.showToast = showToast;
    _proximityJoinWidget.toggle();
}

// ============================
// Import Fence
// ============================
let _fenceBbox = null; // [west, south, east, north] when fence is active

async function startImportFence() {
    // If fence already active, show options modal
    if (mapManager.hasImportFence) {
        const html = `
            <div class="info-box text-xs mb-8">
                ⛶ An import fence is currently active on the map. All imports (files and ArcGIS) are filtered to this area.
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;">
                <button class="btn btn-primary" id="fence-opt-new" style="padding:10px 16px;">
                    ⛶ Place New Fence
                    <div style="font-size:11px;opacity:0.7;margin-top:2px;">Remove current fence and draw a new one</div>
                </button>
                <button class="btn btn-secondary" id="fence-opt-clear" style="padding:10px 16px;">
                    🗑️ Remove Fence
                    <div style="font-size:11px;opacity:0.7;margin-top:2px;">Clear fence from map — imports will no longer be filtered</div>
                </button>
            </div>`;

        showModal('Import Fence', html, {
            width: '400px',
            onMount: (overlay, close) => {
                overlay.querySelector('#fence-opt-new').addEventListener('click', async () => {
                    close();
                    await drawNewFence();
                });
                overlay.querySelector('#fence-opt-clear').addEventListener('click', () => {
                    mapManager.clearImportFence();
                    _fenceBbox = null;
                    updateFenceButton();
                    close();
                    showToast('Import fence removed', 'info');
                });
            }
        });
        return;
    }

    // No fence yet — draw one
    await drawNewFence();
}

async function drawNewFence() {
    const bbox = await mapManager.startImportFenceDraw();
    if (!bbox) {
        showToast('Fence cancelled', 'info');
        return;
    }
    _fenceBbox = bbox;
    updateFenceButton();
    showToast('Import fence placed — all imports will be filtered to this area', 'success');
}

function updateFenceButton() {
    const btn = document.getElementById('btn-fence');
    if (!btn) return;
    if (mapManager.hasImportFence) {
        btn.classList.remove('btn-secondary');
        btn.classList.add('btn-primary');
        btn.innerHTML = '<span class="btn-icon-text">⛶</span><span>Import Fence ✓</span>';
    } else {
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
        btn.innerHTML = '<span class="btn-icon-text">⛶</span><span>Import Fence</span>';
    }
}

/** Filter a spatial dataset's features to only those intersecting a bbox */
function filterDatasetByFence(dataset, bbox) {
    if (!bbox || dataset.type !== 'spatial' || !dataset.geojson?.features?.length) return dataset;

    const [west, south, east, north] = bbox;
    const fencePoly = turf.bboxPolygon([west, south, east, north]);

    const before = dataset.geojson.features.length;
    dataset.geojson.features = dataset.geojson.features.filter(f => {
        try {
            return turf.booleanIntersects(f, fencePoly);
        } catch (_) {
            return true; // keep features that fail the check
        }
    });
    const after = dataset.geojson.features.length;

    if (before !== after) {
        logger.info('ImportFence', `Filtered ${before} → ${after} features (${before - after} outside fence)`);
        // Re-analyze schema since feature count changed
        dataset.schema = analyzeSchema(dataset.geojson);
    }

    return dataset;
}

// ============================
// ArcGIS REST Importer modal
// ============================
async function openArcGISImporter() {
    const spatialFilter = mapManager.getImportFenceEsriEnvelope();
    const fenceBadge = spatialFilter ? '<div class="success-box text-xs mb-8" style="padding:6px 10px;">⛶ <strong>Import Fence active</strong> — only features inside the fence will be downloaded from the server.</div>' : '';

    const html = `
        ${fenceBadge}
        <div class="info-box text-xs mb-8">
            Select a layer from the list below or enter a custom ArcGIS REST URL. Only publicly accessible layers are supported (no login required).
        </div>

        <!-- Preset layer list -->
        <div style="max-height:45vh;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-bottom:12px;" id="arcgis-preset-list">
            ${ARCGIS_ENDPOINTS.map((l, i) => `
                <div class="arcgis-preset-item" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);">
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:600;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${l.name}</div>
                        <div style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${l.url}">${l.url}</div>
                    </div>
                    <button class="btn btn-sm btn-primary arcgis-import-btn" data-url="${l.url}" data-name="${l.name}" style="flex-shrink:0;">Import</button>
                </div>
            `).join('')}
        </div>

        <!-- Custom URL -->
        <div style="border-top:1px solid var(--border);padding-top:12px;">
            <div class="form-group" style="margin-bottom:8px;">
                <label style="font-weight:600;font-size:13px;">Custom URL</label>
                <input type="url" id="arcgis-custom-url" placeholder="https://services.arcgis.com/.../FeatureServer/0">
            </div>
            <button class="btn btn-primary" id="arcgis-custom-import">Import from URL</button>
        </div>

        <!-- Download progress (hidden by default) -->
        <div id="arcgis-progress" class="hidden mt-8">
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
        width: '600px',
        onMount: (overlay, close) => {

            // Shared import function
            async function importLayer(url, name, statusEl) {
                const progressEl = overlay.querySelector('#arcgis-progress');
                const progressText = overlay.querySelector('#arcgis-progress-text');
                const progressBar = overlay.querySelector('#arcgis-progress-bar');
                const progressPct = overlay.querySelector('#arcgis-progress-pct');

                // Show progress
                progressEl.classList.remove('hidden');
                progressBar.style.width = '0%';
                progressPct.textContent = '0%';
                progressText.textContent = `Connecting to ${name || 'layer'}...`;

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
                    progressEl.classList.add('hidden');
                };

                try {
                    await arcgisImporter.fetchMetadata(url);
                    const queryOpts = {
                        outFields: '*', where: '1=1', returnGeometry: true
                    };
                    if (spatialFilter) queryOpts.spatialFilter = spatialFilter;
                    const dataset = await arcgisImporter.downloadFeatures(queryOpts, taskHandler);

                    if (dataset) {
                        addLayer(dataset);
                        mapManager.addLayer(dataset, getLayers().indexOf(dataset), { fit: true });
                        const count = dataset.type === 'spatial' ? dataset.geojson.features.length : dataset.rows.length;
                        showToast(`Imported ${count.toLocaleString()} features: ${dataset.name}`, 'success');
                        refreshUI();
                    }
                    if (statusEl) {
                        statusEl.textContent = '✅ Done';
                        statusEl.classList.remove('btn-primary');
                        statusEl.classList.add('btn-secondary');
                        statusEl.disabled = true;
                    }
                    progressEl.classList.add('hidden');
                } catch (e) {
                    progressEl.classList.add('hidden');
                    if (e.cancelled) return;
                    const classified = handleError(e, 'ArcGIS', 'Import');
                    showErrorToast(classified);
                    if (statusEl) {
                        statusEl.textContent = 'Import';
                        statusEl.disabled = false;
                    }
                }
            }

            // Wire preset Import buttons
            overlay.querySelectorAll('.arcgis-import-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    btn.disabled = true;
                    btn.textContent = 'Loading...';
                    importLayer(btn.dataset.url, btn.dataset.name, btn);
                });
            });

            // Wire custom URL import
            overlay.querySelector('#arcgis-custom-import').addEventListener('click', () => {
                const url = overlay.querySelector('#arcgis-custom-url').value.trim();
                if (!url) return showToast('Enter a URL', 'warning');
                const customBtn = overlay.querySelector('#arcgis-custom-import');
                customBtn.disabled = true;
                customBtn.textContent = 'Loading...';
                importLayer(url, 'Custom Layer', customBtn).finally(() => {
                    customBtn.disabled = false;
                    customBtn.textContent = 'Import from URL';
                });
            });
        }
    });
}

// ============================
// Export handler
// ============================
async function doExport(format) {
    const layer = getActiveLayer();
    if (!layer) return showToast('No active layer', 'warning');

    // KML/KMZ with 2+ layers: offer multi-layer export
    const allLayers = getLayers().filter(l => l.type === 'spatial');
    if ((format === 'kmz' || format === 'kml') && allLayers.length >= 2) {
        const choice = await _showKmzExportPicker(allLayers, layer, format);
        if (choice === null) return; // cancelled
        if (choice === 'active') {
            // fall through to single-layer export below
        } else if (Array.isArray(choice)) {
            // Multi-layer export
            try {
                const layerData = choice.map(ds => ({
                    dataset: ds,
                    style: mapManager.getLayerStyle(ds.id) || {}
                }));
                const fname = choice.length === allLayers.length ? 'All_Layers' : choice.map(l => l.name).join('_').slice(0, 60);
                await exportMultiLayerKMZFile(layerData, { filename: fname });
                showToast(`Exported ${choice.length} layers as KMZ`, 'success');
            } catch (e) {
                showErrorToast(handleError(e, 'Export', 'multi-kmz'));
            }
            return;
        }
    }

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

/**
 * Show KMZ/KML export picker: active layer only, or select multiple layers for folders.
 * Returns 'active', array of selected datasets, or null (cancelled).
 */
async function _showKmzExportPicker(allLayers, activeLayer, format) {
    const fmtLabel = format.toUpperCase();
    const checkboxes = allLayers.map((l, i) => {
        const featCount = l.geojson?.features?.length || 0;
        const safeName = l.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const isActive = l.id === activeLayer.id;
        return `<label class="merge-layer-item">
            <input type="checkbox" value="${i}" checked>
            <span>${safeName}${isActive ? ' <small style="color:var(--primary)">(active)</small>' : ''}</span>
            <span class="merge-feat-count">${featCount}</span>
        </label>`;
    }).join('');

    const html = `
        <p style="margin-bottom:12px;">Export <strong>${activeLayer.name}</strong> only, or select layers to combine into a single ${fmtLabel} with a folder per layer.</p>
        <div class="merge-layer-list" id="kmz-layer-list">${checkboxes}</div>`;

    return showModal(`Export ${fmtLabel}`, html, {
        footer: `<button class="btn btn-secondary cancel-btn">Cancel</button>
                 <button class="btn btn-secondary active-only-btn">Active Layer Only</button>
                 <button class="btn btn-primary multi-btn">Export Selected as Folders</button>`,
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close(null);
            overlay.querySelector('.active-only-btn').onclick = () => close('active');
            overlay.querySelector('.multi-btn').onclick = () => {
                const checked = [...overlay.querySelectorAll('#kmz-layer-list input:checked')]
                    .map(cb => allLayers[parseInt(cb.value)]);
                if (checked.length === 0) { showToast('Select at least 1 layer', 'warning'); return; }
                close(checked);
            };
        }
    });
}

// ============================
// Other handlers
// ============================

// ——— Draw Layer ———
function createDrawLayer() {
    const activeLayer = getActiveLayer();
    const hasActiveSpatial = activeLayer && activeLayer.type === 'spatial';

    const items = [
        { icon: '🆕', label: 'New draw layer', desc: 'Create an empty layer and start drawing', action: 'new' },
    ];
    if (hasActiveSpatial) {
        items.push({ icon: '📝', label: `Draw on "${activeLayer.name}"`, desc: 'Add features to the active layer', action: 'active' });
    }

    // If no active spatial layer, just create a new one directly
    if (!hasActiveSpatial) {
        _doCreateDrawLayer();
        return;
    }

    const html = items.map(item =>
        `<button class="draw-option-btn" data-action="${item.action}">
            <span style="font-size:18px;">${item.icon}</span>
            <div><strong>${item.label}</strong><div style="font-size:11px;color:var(--text-muted);">${item.desc}</div></div>
        </button>`
    ).join('');

    showModal('Draw Features', `<div class="draw-options">${html}</div>`, {
        width: '380px',
        onMount: (overlay, close) => {
            overlay.querySelectorAll('.draw-option-btn').forEach(btn => {
                btn.onclick = () => {
                    close();
                    if (btn.dataset.action === 'new') {
                        _doCreateDrawLayer();
                    } else {
                        openDrawTools(activeLayer.id);
                    }
                };
            });
        }
    });
}

function _doCreateDrawLayer() {
    const geojson = { type: 'FeatureCollection', features: [] };
    const dataset = createSpatialDataset('Draw Layer', geojson, { format: 'draw' });
    dataset._isDrawLayer = true;
    addLayer(dataset);
    setActiveLayer(dataset.id);
    mapManager.addLayer(dataset, getLayers().indexOf(dataset), { fit: false });
    refreshUI();
    drawManager.showToolbar(dataset.id, dataset.name);
    showToast('Draw layer created — use the toolbar to draw features', 'success');
}

function openDrawTools(layerId) {
    const layer = getLayers().find(l => l.id === layerId);
    if (!layer || layer.type !== 'spatial') return showToast('Need a spatial layer', 'warning');
    setActiveLayer(layerId);
    refreshUI();
    drawManager.showToolbar(layerId, layer.name);
}

async function handleMergeLayers() {
    const layers = getLayers();
    if (layers.length < 2) return showToast('Need at least 2 layers to merge', 'warning');

    const checkboxes = layers.map((l, i) => {
        const featCount = l.type === 'spatial' ? (l.geojson?.features?.length || 0) : (l.rows?.length || 0);
        const safeName = l.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `<label class="merge-layer-item">
            <input type="checkbox" value="${i}" checked>
            <span>${safeName}</span>
            <span class="merge-feat-count">${featCount} features</span>
        </label>`;
    }).join('');

    const html = `<p style="margin-bottom:8px;">Select layers to merge. A <code>source_file</code> field will be added.</p>
        <div class="merge-layer-list">${checkboxes}</div>`;

    const result = await showModal('Merge Layers', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button> <button class="btn btn-primary confirm-btn">Merge Selected</button>',
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close(null);
            overlay.querySelector('.confirm-btn').onclick = () => {
                const checked = [...overlay.querySelectorAll('.merge-layer-list input:checked')]
                    .map(cb => parseInt(cb.value));
                close(checked);
            };
        }
    });

    if (!result || result.length < 2) {
        if (result && result.length === 1) showToast('Select at least 2 layers to merge', 'warning');
        return;
    }

    const selected = result.map(i => layers[i]);
    const merged = mergeDatasets(selected);
    addLayer(merged);
    mapManager.addLayer(merged, getLayers().indexOf(merged), { fit: true });
    showToast(`Merged ${selected.length} layers → ${merged.geojson.features.length} features`, 'success');
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
        } else if (layer && layer.type === 'table') {
            layer.rows = JSON.parse(JSON.stringify(entry.snapshot));
            import('./core/data-model.js').then(dm => {
                layer.schema = dm.analyzeTableSchema(layer.rows, Object.keys(layer.rows[0] || {}));
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
        } else if (layer && layer.type === 'table') {
            layer.rows = JSON.parse(JSON.stringify(entry.snapshot));
            import('./core/data-model.js').then(dm => {
                layer.schema = dm.analyzeTableSchema(layer.rows, Object.keys(layer.rows[0] || {}));
                refreshUI();
                showToast('Redo', 'info', { duration: 1500 });
            });
        }
    }
}

// ============================
// Feature Editor — edit a single feature's attributes from popup
// ============================
function openFeatureEditor(layerId, featureIndex) {
    const layers = getLayers();
    const layer = layers.find(l => l.id === layerId);
    if (!layer || layer.type !== 'spatial') return showToast('Layer not found', 'warning');

    const feature = layer.geojson.features[featureIndex];
    if (!feature) return showToast('Feature not found', 'warning');

    const props = feature.properties || {};
    const fields = Object.keys(props).filter(k => !k.startsWith('_'));
    const schemaFields = layer.schema?.fields || [];
    const getFieldType = (name) => schemaFields.find(f => f.name === name)?.type || 'string';

    const _formatFileSize = (bytes) => {
        if (!bytes) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    };

    const rowsHtml = fields.map(f => {
        const fieldType = getFieldType(f);
        let val = props[f];
        const isAtt = fieldType === 'attachment' || (val && typeof val === 'object' && val._att);

        if (isAtt) {
            const att = (val && val._att) ? val : null;
            const isImage = att?.type?.startsWith('image/');
            const previewHtml = att ? `
                <div class="att-preview-row" data-field="${f}" style="display:flex;align-items:center;gap:8px;padding:4px 0;">
                    ${isImage && att.dataUrl ? `<img src="${att.dataUrl}" style="max-width:60px;max-height:60px;border-radius:4px;border:1px solid var(--border);">` : '<span style="font-size:20px;">📎</span>'}
                    <span style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${att.name}">${att.name}</span>
                    <span style="font-size:10px;color:var(--text-muted);">${_formatFileSize(att.size)}</span>
                    <button class="att-remove-btn btn btn-sm" data-field="${f}" style="font-size:10px;padding:2px 6px;color:var(--error);" title="Remove">✕</button>
                </div>` : '';
            return `<div class="form-group" style="margin-bottom:6px;">
                <label style="font-size:11px;color:var(--text-muted);">${f} <span style="opacity:0.6;font-size:9px;">(photo)</span></label>
                ${previewHtml}
                <label style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:var(--bg-surface);border:1px dashed var(--border);border-radius:6px;cursor:pointer;font-size:12px;color:var(--text-muted);margin-top:2px;">
                    📷 ${att ? 'Replace Photo' : 'Choose Photo'}
                    <input type="file" class="feat-edit-file" data-field="${f}" accept="image/*" style="display:none;">
                </label>
                <span class="att-size-note" style="font-size:10px;color:var(--text-muted);margin-left:6px;">Max 10 MB · KML/KMZ only</span>
            </div>`;
        }

        if (val != null && typeof val === 'object') val = JSON.stringify(val);
        return `<div class="form-group" style="margin-bottom:6px;">
            <label style="font-size:11px;color:var(--text-muted);">${f}</label>
            <input type="text" class="feat-edit-input" data-field="${f}" value="${val != null ? String(val).replace(/"/g, '&quot;') : ''}" style="width:100%;font-size:13px;">
        </div>`;
    }).join('');

    const geomType = feature.geometry?.type || 'Unknown';
    const header = `<div class="text-xs text-muted mb-8" style="border-bottom:1px solid var(--border);padding-bottom:4px;margin-bottom:8px;">
        <strong>${layer.name}</strong> · Feature #${featureIndex + 1} · ${geomType}
    </div>`;

    const html = header + `<div style="max-height:400px;overflow-y:auto;">${rowsHtml}</div>`;

    showModal('Edit Feature', html, {
        width: '420px',
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Save</button>',
        onMount: (overlay, close) => {
            // Focus first input
            setTimeout(() => overlay.querySelector('.feat-edit-input')?.focus(), 50);

            // Track attachment changes during editing
            const attachmentUpdates = new Map();

            // Handle file inputs for photo attachment fields
            overlay.querySelectorAll('.feat-edit-file').forEach(input => {
                input.addEventListener('change', (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    if (!file.type.startsWith('image/')) {
                        showToast('Only image files are supported', 'warning');
                        input.value = '';
                        return;
                    }
                    if (file.size > 10 * 1024 * 1024) {
                        showToast('Photo too large — max 10 MB', 'warning');
                        input.value = '';
                        return;
                    }
                    const reader = new FileReader();
                    reader.onload = () => {
                        const field = input.dataset.field;
                        const attObj = { _att: true, name: file.name, dataUrl: reader.result, type: file.type, size: file.size };
                        attachmentUpdates.set(field, attObj);
                        // Update preview in-place
                        const isImage = file.type.startsWith('image/');
                        let previewRow = overlay.querySelector(`.att-preview-row[data-field="${field}"]`);
                        const formGroup = input.closest('.form-group');
                        if (!previewRow) {
                            previewRow = document.createElement('div');
                            previewRow.className = 'att-preview-row';
                            previewRow.dataset.field = field;
                            previewRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;';
                            formGroup.insertBefore(previewRow, formGroup.querySelector('label:last-of-type'));
                        }
                        const fmtSize = file.size < 1024 ? file.size + ' B' : file.size < 1048576 ? (file.size / 1024).toFixed(1) + ' KB' : (file.size / 1048576).toFixed(1) + ' MB';
                        previewRow.innerHTML = `
                            ${isImage ? `<img src="${reader.result}" style="max-width:60px;max-height:60px;border-radius:4px;border:1px solid var(--border);">` : '<span style="font-size:20px;">📎</span>'}
                            <span style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${file.name}">${file.name}</span>
                            <span style="font-size:10px;color:var(--text-muted);">${fmtSize}</span>
                            <button class="att-remove-btn btn btn-sm" data-field="${field}" style="font-size:10px;padding:2px 6px;color:var(--error);" title="Remove">✕</button>`;
                        // Bind remove on the new button
                        previewRow.querySelector('.att-remove-btn').addEventListener('click', (ev) => {
                            ev.preventDefault();
                            attachmentUpdates.set(field, null);
                            previewRow.remove();
                        });
                    };
                    reader.readAsDataURL(file);
                });
            });

            // Handle remove buttons (for existing attachments)
            overlay.querySelectorAll('.att-remove-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const field = btn.dataset.field;
                    attachmentUpdates.set(field, null);
                    const previewRow = overlay.querySelector(`.att-preview-row[data-field="${field}"]`);
                    if (previewRow) previewRow.remove();
                });
            });

            overlay.querySelector('.cancel-btn').onclick = () => close();
            overlay.querySelector('.apply-btn').onclick = () => {
                // Save snapshot before editing
                saveSnapshot(layer.id, 'Edit Feature', layer.geojson);

                // Read all text inputs and update properties
                overlay.querySelectorAll('.feat-edit-input').forEach(input => {
                    const field = input.dataset.field;
                    const newVal = input.value;
                    const oldVal = props[field];

                    // Coerce to original type
                    if (oldVal === null || oldVal === undefined) {
                        props[field] = newVal === '' ? null : newVal;
                    } else if (typeof oldVal === 'number') {
                        props[field] = newVal === '' ? null : (isNaN(Number(newVal)) ? newVal : Number(newVal));
                    } else if (typeof oldVal === 'boolean') {
                        props[field] = newVal === 'true' || newVal === '1';
                    } else {
                        props[field] = newVal;
                    }
                });

                // Apply attachment updates
                for (const [field, data] of attachmentUpdates) {
                    props[field] = data; // null removes, object sets
                }

                // Refresh map and UI
                import('./core/data-model.js').then(dm => {
                    layer.schema = dm.analyzeSchema(layer.geojson);
                    bus.emit('layer:updated', layer);
                    bus.emit('layers:changed', getLayers());
                    mapManager.addLayer(layer, getLayers().indexOf(layer));
                    refreshUI();
                });
                showToast('Feature updated', 'success');
                close();
            };
        }
    });
}

function showDataTable() {
    const layer = getActiveLayer();
    if (!layer) return;

    const isSpatial = layer.type === 'spatial';
    const features = isSpatial ? layer.geojson.features : [];
    const totalCount = isSpatial ? features.length : (layer.rows || []).length;
    const displayRows = isSpatial
        ? features.slice(0, 500)
        : (layer.rows || []).slice(0, 500);

    if (displayRows.length === 0) return showToast('No data to show', 'warning');

    const firstProps = isSpatial ? (displayRows[0]?.properties || {}) : (displayRows[0] || {});
    const fields = Object.keys(firstProps).filter(k => !k.startsWith('_'));
    const headerHtml = `<th style="width:30px;">#</th>` + fields.map(f => `<th>${f}</th>`).join('');
    const bodyHtml = displayRows.map((item, i) => {
        const props = isSpatial ? (item.properties || {}) : item;
        const cells = fields.map(f => {
            let val = props[f];
            // Attachment cells: show filename, non-editable
            if (val && typeof val === 'object' && val._att) {
                const icon = val.type?.startsWith('image/') ? '🖼️' : '📎';
                return `<td data-row="${i}" data-field="${f}" class="att-cell" style="cursor:default;color:var(--text-muted);font-style:italic;" title="${val.name || 'attachment'}">${icon} ${val.name || 'attachment'}</td>`;
            }
            if (val != null && typeof val === 'object') val = JSON.stringify(val);
            return `<td contenteditable="true" data-row="${i}" data-field="${f}">${val ?? ''}</td>`;
        }).join('');
        return `<tr><td style="color:var(--text-muted);font-size:10px;text-align:center;">${i + 1}</td>${cells}</tr>`;
    }).join('');

    const html = `
        <div class="text-xs text-muted mb-8">
            Showing ${displayRows.length} of ${totalCount} rows · <strong>Click a cell to edit</strong>.
            Changes are saved when you click away.
        </div>
        <div class="data-table-wrap" style="max-height:450px;">
            <table class="data-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>
        </div>`;

    showModal(`Data: ${layer.name}`, html, {
        width: '90vw',
        onMount: (overlay) => {
            let dirty = false;
            overlay.querySelectorAll('td[contenteditable]').forEach(td => {
                td.addEventListener('focus', () => {
                    td.style.outline = '2px solid var(--primary)';
                    td.style.background = 'var(--bg-surface)';
                });
                td.addEventListener('blur', () => {
                    td.style.outline = '';
                    td.style.background = '';
                    const row = parseInt(td.dataset.row);
                    const field = td.dataset.field;
                    const newVal = td.textContent;
                    const target = isSpatial ? features[row]?.properties : (layer.rows || [])[row];
                    if (!target) return;
                    const oldVal = target[field];
                    const coerced = (oldVal === null || oldVal === undefined) ? newVal
                        : typeof oldVal === 'number' ? (isNaN(Number(newVal)) ? newVal : Number(newVal))
                        : typeof oldVal === 'boolean' ? (newVal === 'true')
                        : newVal;
                    if (String(oldVal) !== String(coerced)) {
                        if (!dirty) {
                            // Save snapshot on first edit
                            if (isSpatial) saveSnapshot(layer.id, 'Edit field data', layer.geojson);
                            dirty = true;
                        }
                        target[field] = coerced;
                    }
                });
                td.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
                    if (e.key === 'Escape') { td.blur(); }
                    if (e.key === 'Tab') {
                        e.preventDefault();
                        const next = e.shiftKey ? td.previousElementSibling : td.nextElementSibling;
                        if (next?.contentEditable === 'true') next.focus();
                    }
                });
            });
            // When modal closes, refresh if dirty
            const obs = new MutationObserver(() => {
                if (!document.body.contains(overlay)) {
                    obs.disconnect();
                    if (dirty && isSpatial) {
                        import('./core/data-model.js').then(dm => {
                            layer.schema = dm.analyzeSchema(layer.geojson);
                            bus.emit('layer:updated', layer);
                            bus.emit('layers:changed', getLayers());
                            mapManager.addLayer(layer, getLayers().indexOf(layer));
                            refreshUI();
                        });
                        showToast('Data edits saved', 'success');
                    }
                }
            });
            obs.observe(overlay.parentElement || document.body, { childList: true, subtree: true });
        }
    });
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
                <option value="attachment">Attach Photo (KML/KMZ export only)</option>
            </select></div>
        <div class="form-group" id="af-default-group"><label>Default Value <span class="text-muted text-xs">(optional)</span></label>
            <input type="text" id="af-default" placeholder="Leave blank for empty"></div>
        <div id="af-error" class="text-xs" style="color:var(--error);min-height:18px;"></div>`;

    showModal('Add New Field', html, {
        footer: '<button class="btn btn-secondary cancel-btn">Cancel</button><button class="btn btn-primary apply-btn">Add Field</button>',
        onMount: (overlay, close) => {
            const nameInput = overlay.querySelector('#af-name');
            const typeSelect = overlay.querySelector('#af-type');
            const defaultInput = overlay.querySelector('#af-default');
            const defaultGroup = overlay.querySelector('#af-default-group');
            const errorEl = overlay.querySelector('#af-error');

            // Hide default value for attachment type
            typeSelect.addEventListener('change', () => {
                defaultGroup.style.display = typeSelect.value === 'attachment' ? 'none' : '';
                if (typeSelect.value === 'attachment') defaultInput.value = '';
            });

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
                if (type === 'attachment') {
                    defaultValue = null; // Attachments have no default
                } else if (defaultValue !== null) {
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
            title: 'How To',
            tools: [
                ['1️⃣ Import', '➕ Add most Geospatial files types 📂'],
                ['2️⃣ Interact', '🛠️ View, edit, or manipulate ✏️'],
                ['3️⃣ Export', '💾 Same file type or convert 📩']
                
            ]
        },
        {
            title: 'About',
            tools: [
                ['GIS Toolbox', 'A modern web app for working with geospatial data.'],
                ['How it Works', 'Client-side, no backend server processing. All work is done in the browser, no need to download/ install any software.'],
                ['Tools', 'Most tools use Turf.js, a modular geospatial engine written in JavaScript'],
                ['Limitations', 'Large datasets may cause browser performance issues. Try using the "Import Fence" tool to load a smaller area.']
                
            ]
        },
        {
            title: 'Import & Sources',
            tools: [
                ['📂 Import', 'Drag-and-drop or browse to load GeoJSON, CSV, Excel, KML, KMZ, Shapefile (ZIP), or JSON files.'],
                ['📷 Photos', 'Import geotagged photos. Extracts GPS coordinates and EXIF data, maps them as points.'],
                ['🌐 ArcGIS REST', 'Import features directly from an ArcGIS REST service URL (Feature/Map Server).']
            ]
        },
        {
            title: 'Layers & Fields',
            tools: [
                ['Layers Panel', 'View, select, toggle visibility, zoom to, rename, or remove imported layers.'],
                ['Fields Panel', 'View, search, select/deselect, rename, or add new fields on the active layer.'],
                ['Field Types', 'Text, Number, Boolean, Date, and Attach Photo. Photo fields let you attach images to individual features with inline previews. Photos are embedded when exported as KML/KMZ only.'],
                ['Feature Selection', 'Click the ✦ Select button to enter selection mode. Click features to select them (cyan highlight). Shift+click to add/remove. Ctrl+drag to box-select. Tools operate on selected features when a selection exists, or all features when nothing is selected.'],
                ['Merge Layers', 'Select which layers to combine into a single layer. A source_file field is added so you can tell which features came from which original layer. Useful for exporting multiple layers into one KMZ with folders.'],
                ['Data Table', 'View the raw attribute table for the active layer.']
            ]
        },
        {
            title: 'Layer Data Tools',
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
            title: 'GIS Widgets',
            tools: [
                ['Overview', 'Pre-built workflows that combine multiple steps into a simple, guided interface for common GIS tasks.'],
                ['Import Fence', 'Draw a rectangle on the map to set a spatial filter. All subsequent imports (file or ArcGIS REST) only load features inside the fence. ArcGIS REST queries are filtered server-side so only matching features are downloaded, preventing large dataset browser issues.']
            ]
        },
        {
            title: 'GIS Tools — Measurement',
            tools: [
                ['Distance', 'Measure the straight-line distance between two points you click on the map.'],
                ['Bearing', 'Find the compass direction (in degrees) from one point to another.'],
                ['Destination', 'Given a start point, distance, and compass direction, find where you would end up.'],
                ['Along', 'Find a point at a specific distance along a line feature.'],
                ['Pt→Line Distance', 'Measure the shortest perpendicular distance from a point to a line.']
            ]
        },
        {
            title: 'GIS Tools — Transformation',
            tools: [
                ['Buffer', 'Draw a zone around features at a set distance.'],
                ['BBox Clip', 'Draw a rectangle on the map and clip all features to that area.'],
                ['Clip to Extent', 'Clip features to the current visible map area.'],
                ['Simplify', 'Reduce vertex count on geometries to shrink file size.'],
                ['Bezier Spline', 'Smooth jagged lines into gentle flowing curves.'],
                ['Polygon Smooth', 'Round off rough polygon edges.'],
                ['Line Offset', 'Create a parallel copy of a line shifted left or right.'],
                ['Sector', 'Create a pie-slice shaped area from a center point, radius, and compass bearings.']
            ]
        },
        {
            title: 'GIS Tools — Lines & Analysis',
            tools: [
                ['Line Slice Along', 'Extract a section of a line between two distances.'],
                ['Line Slice (Points)', 'Click two points on the map to cut out the section of line between them.'],
                ['Line Intersect', 'Find all points where two sets of lines cross each other.'],
                ['Kinks', 'Find self-intersections where a line or polygon edge crosses itself.'],
                ['Combine', 'Merge all features of the same type into one multi-feature.'],
                ['Union', 'Merge all polygons into a single unified shape.'],
                ['Dissolve', 'Merge polygons that share the same attribute value.'],
                ['Points in Polygon', 'Find which points fall inside which polygons.'],
                ['Nearest Point', 'Click the map to find the closest feature in a point layer.'],
                ['Nearest Pt on Line', 'Click near a line to snap to the closest point on it.'],
                ['Nearest Pt to Line', 'Find which point in a layer is closest to a line.'],
                ['NN Analysis', 'Statistically test whether points are clustered, dispersed, or random.']
            ]
        },
        {
            title: 'Export',
            tools: [
                ['GeoJSON', 'Export spatial data as a .geojson file.'],
                ['CSV', 'Export attributes as a comma-separated .csv file.'],
                ['Excel', 'Export attributes as an .xlsx spreadsheet.'],
                ['KML', 'Export spatial data as a .kml file (Google Earth). Layer styles are preserved.'],
                ['KMZ', 'Export as .kmz (compressed KML) with styles. When 2+ layers exist, choose to export just the active layer or select multiple layers — each becomes its own folder in the KMZ with its own styling. Can also include embedded photos.'],
                ['JSON', 'Export raw data as a .json file.'],
                ['Shapefile', 'Export spatial data as a zipped Shapefile (.shp).']
            ]
        },
        {
            title: 'ArcGIS REST Import',
            tools: [
                ['Overview', 'Import features directly from public ArcGIS REST endpoints — no download or login required. All processing is done in the browser.'],
                ['Preset Layers', 'Choose from a curated list of UDOT and Utah layers including Routes ALRS, Reference Posts, Mile Points, Region Boundaries, Bridge Locations, Lanes, County Boundaries, and Municipal Boundaries.'],
                ['Custom URL', 'Enter any public ArcGIS REST FeatureServer or MapServer layer URL to import features directly.'],
                ['Supported', 'Works with Feature Servers, Map Servers, and individual layer endpoints. Handles paginated services that return features in batches automatically.']
            ]
        },
        {
            title: 'Workflows',
            tools: [
                ['Multi-Layer KMZ', 'Import your layers, style each one independently, then Export → KMZ. A picker lets you select which layers to include — each becomes its own folder in the KMZ with its own styling. No merge needed.'],
                ['Merge → Export', 'Use Merge Layers to combine selected layers into one. The merged layer gets a source_file field tracking each feature\'s origin. When exported as KML/KMZ, features are auto-grouped into folders by source layer name.'],
                ['Mixed Geometry', 'When you import a file with mixed geometry types (points + lines + polygons), they are automatically split into separate layers so you can style each type independently.']
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
        <div style="margin-bottom:30px;">
            <div style="font-weight:700;font-size:18px;color:var(--gold-light);margin-bottom:6px;border-bottom:2px solid var(--border);padding-bottom:4px;">${s.title}</div>
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

    const isMobile = window.innerWidth < 768;
    const mobileBanner = `<div class="splash-mobile-notice">📱 Mobile site still under development — for a better experience use a larger screen</div>`;
    const splashWidth = isMobile ? '99vw' : '560px';
    const titleFontSize = isMobile ? 'clamp(18px, 5.5vw, 32px)' : '32px';
    const titleIconSize = isMobile ? '28' : '36';
    const byFontSize = isMobile ? 'clamp(7px, 2vw, 9px)' : '9px';
    showModal(`<div style="display:inline-flex;align-items:baseline;gap:6px;flex-wrap:nowrap;max-width:100%;"><img src="icons/TitleIcon.png" alt="" width="${titleIconSize}" height="${titleIconSize}" style="border-radius:4px;flex-shrink:0;align-self:center;"><span style="font-size:${titleFontSize};font-weight:700;line-height:1;white-space:nowrap;">GIS-Toolbox<span style="font-size:0.65em;font-weight:400;opacity:0.7;">.com</span></span><span style="font-size:${byFontSize};font-weight:400;opacity:0.7;white-space:nowrap;">by Ryan Romney</span></div>`, `${mobileBanner}<div style="overflow-y:auto;flex:1;">${html}</div>`, {
        width: splashWidth,
        onMount: (overlay) => {
            if (isMobile) {
                overlay.classList.add('splash-overlay');
                const modal = overlay.querySelector('.modal');
                if (modal) modal.classList.add('splash-modal');
            }
        }
    });
}

// ============================
// Right-click context menu
// ============================
let _ctxDismissAC = null; // AbortController for context menu dismiss listeners

function dismissContextMenu() {
    document.querySelector('.map-context-menu')?.remove();
    if (_ctxDismissAC) { _ctxDismissAC.abort(); _ctxDismissAC = null; }
}

function showMapContextMenu({ latlng, originalEvent, layerId, featureIndex, feature }) {
    dismissContextMenu();
    const menu = document.createElement('div');
    menu.className = 'map-context-menu';

    const layers = getLayers();
    const layer = layerId ? layers.find(l => l.id === layerId) : null;
    const layerIdx = layer ? layers.indexOf(layer) : -1;

    // Header
    if (layer) {
        menu.innerHTML += `<div class="ctx-header">Layer: ${layer.name}</div>`;
    }

    const items = [];

    // Feature-specific items
    if (feature && layer) {
        items.push({ icon: '📋', label: 'View attributes', action: () => {
            const nearby = mapManager._findFeaturesNearClick(latlng, layerId, featureIndex);
            if (nearby.length > 0) mapManager._showMultiPopup(nearby, latlng);
            else mapManager.showPopup(feature, null, latlng);
        }});
        items.push({ icon: '✏️', label: 'Edit feature', action: () => {
            openFeatureEditor(layerId, featureIndex);
        }});
    }

    // Coordinates
    items.push({ icon: '📍', label: `Copy coordinates`, action: () => {
        const text = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
        navigator.clipboard.writeText(text).then(() => showToast(`Copied: ${text}`, 'success'))
            .catch(() => showToast(text, 'info'));
    }});

    if (layer) {
        items.push({ sep: true });

        // Layer reordering
        if (layerIdx > 0) {
            items.push({ icon: '⬆', label: 'Move layer up', action: () => { moveLayerUp(layerId); }});
        }
        if (layerIdx >= 0 && layerIdx < layers.length - 1) {
            items.push({ icon: '⬇', label: 'Move layer down', action: () => { moveLayerDown(layerId); }});
        }
        if (layers.length > 1 && layerIdx !== 0) {
            items.push({ icon: '⏫', label: 'Bring to front', action: () => {
                while (layers.indexOf(layers.find(l => l.id === layerId)) > 0) {
                    reorderLayer(layerId, 'up');
                }
                mapManager.syncLayerOrder(getLayers().map(l => l.id));
                renderLayerList();
            }});
        }
        if (layers.length > 1 && layerIdx !== layers.length - 1) {
            items.push({ icon: '⏬', label: 'Send to back', action: () => {
                while (layers.indexOf(layers.find(l => l.id === layerId)) < layers.length - 1) {
                    reorderLayer(layerId, 'down');
                }
                mapManager.syncLayerOrder(getLayers().map(l => l.id));
                renderLayerList();
            }});
        }

        items.push({ sep: true });

        // Hide / show
        items.push({ icon: layer.visible !== false ? '👁️‍🗨️' : '👁️', label: layer.visible !== false ? 'Hide layer' : 'Show layer', action: () => {
            toggleLayerVisibility(layerId);
            mapManager.toggleLayer(layerId, layers.find(l => l.id === layerId)?.visible);
            renderLayerList();
        }});

        // Zoom to
        items.push({ icon: '🔍', label: 'Zoom to layer', action: () => {
            const ll = mapManager.dataLayers.get(layerId);
            if (ll) { try { mapManager.getMap().fitBounds(ll.getBounds(), { padding: [30, 30] }); } catch(_) {} }
        }});

        // Set active
        items.push({ icon: '✦', label: 'Set as active layer', action: () => { setActiveLayer(layerId); refreshUI(); }});
    }

    // Build items
    items.forEach(item => {
        if (item.sep) {
            menu.innerHTML += '<div class="ctx-sep"></div>';
            return;
        }
        const el = document.createElement('div');
        el.className = 'ctx-item';
        el.innerHTML = `<span class="ctx-icon">${item.icon}</span>${item.label}`;
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            dismissContextMenu();
            item.action();
        });
        menu.appendChild(el);
    });

    // Position menu at mouse location, clamped to viewport
    let x = originalEvent.clientX;
    let y = originalEvent.clientY;
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Dismiss listeners — deferred so the originating event doesn't immediately dismiss
    _ctxDismissAC = new AbortController();
    const sig = _ctxDismissAC.signal;
    requestAnimationFrame(() => {
        if (sig.aborted) return;
        // Click anywhere outside the menu dismisses it
        document.addEventListener('pointerdown', (e) => {
            if (!e.target.closest('.map-context-menu')) dismissContextMenu();
        }, { signal: sig });
        // Another right-click outside the menu dismisses it (new one will replace)
        document.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('.map-context-menu')) dismissContextMenu();
        }, { signal: sig });
        // Escape key dismisses
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') dismissContextMenu();
        }, { signal: sig });
        // Scroll / map interaction dismisses
        document.addEventListener('wheel', () => dismissContextMenu(), { signal: sig, passive: true });
    });
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
    moveLayerUp,
    moveLayerDown,
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
    openDistanceTool,
    openBearingTool,
    openDestinationTool,
    openAlongTool,
    openPointToLineDistanceTool,
    openBboxClip,
    openBezierSpline,
    openPolygonSmooth,
    openLineOffset,
    openLineSliceAlong,
    openLineSlice,
    openLineIntersect,
    openKinks,
    openCombine,
    openUnion,
    openDissolve,
    openSector,
    openNearestPoint,
    openNearestPointOnLine,
    openNearestPointToLine,
    openNearestNeighborAnalysis,
    openPointsWithinPolygon,
    openPhotoMapper: openPhotoMapper,
    openArcGISImporter: openArcGISImporter,
    startImportFence,
    openSpatialAnalyzer,
    openBulkUpdate,
    openProximityJoin,
    mergeLayers: handleMergeLayers,
    showToolInfo,
    // Selection
    toggleSelectionMode,
    clearSelection,
    selectAllFeatures,
    invertSelection,
    deleteSelectedFeatures,
    openFeatureEditor,
    openDrawTools,
    createDrawLayer,
    _coordSearchAddNew,
    _coordSearchAddToExisting,
    _coordSearchClear
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

    // ========================
    // Floating tooltip portal
    // ========================
    (function initTooltipPortal() {
        const portal = document.createElement('div');
        portal.className = 'geo-tip-portal';
        const arrow = document.createElement('div');
        arrow.className = 'tip-arrow';
        portal.appendChild(arrow);
        document.body.appendChild(portal);
        let hideTimeout = null;
        let activeBtn = null;

        function show(btn) {
            const tip = btn.querySelector('.geo-tip');
            if (!tip) return;
            clearTimeout(hideTimeout);
            activeBtn = btn;

            // Set text (keep arrow element)
            // Clear text nodes only, preserve arrow child
            Array.from(portal.childNodes).forEach(n => {
                if (n !== arrow) portal.removeChild(n);
            });
            portal.insertBefore(document.createTextNode(tip.textContent), arrow);

            // Make visible but off-screen for measurement
            portal.style.left = '-9999px';
            portal.style.top = '0px';
            portal.classList.add('visible');

            const rect = btn.getBoundingClientRect();
            const pw = 240;
            const ph = portal.offsetHeight;
            const btnCenterX = rect.left + rect.width / 2;

            // Horizontal: try to center on button, clamp to viewport
            let left = btnCenterX - pw / 2;
            if (left < 8) left = 8;
            if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;

            // Arrow: point at button center relative to tooltip left
            let arrowLeft = btnCenterX - left;
            arrowLeft = Math.max(12, Math.min(pw - 12, arrowLeft));
            arrow.style.left = arrowLeft + 'px';

            portal.style.left = left + 'px';
            portal.style.width = pw + 'px';

            // Vertical: prefer above, fall back to below
            let top = rect.top - ph - 10;
            if (top < 4) {
                top = rect.bottom + 10;
                portal.classList.add('below');
            } else {
                portal.classList.remove('below');
            }
            portal.style.top = top + 'px';
        }

        function hide() {
            hideTimeout = setTimeout(() => {
                portal.classList.remove('visible');
                activeBtn = null;
            }, 100);
        }

        document.addEventListener('pointerenter', (e) => {
            const btn = e.target.closest('.geo-tool-btn');
            if (btn) show(btn);
        }, true);
        document.addEventListener('pointerleave', (e) => {
            const btn = e.target.closest('.geo-tool-btn');
            if (btn && btn === activeBtn) hide();
        }, true);
    })();
});
