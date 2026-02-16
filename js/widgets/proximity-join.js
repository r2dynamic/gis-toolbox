/**
 * Proximity Join Widget
 * Nearest Feature Attribute Transfer — find the closest feature in a target
 * layer for each source feature and copy attribute values across.
 *
 * Supports:
 *  - Point/Line/Polygon source → Point/Line/Polygon target
 *  - Configurable max search radius with units (ft/m/mi/km)
 *  - Optional metadata fields (distance, matched ID, layer name)
 *  - Selection-only mode (use currently selected features)
 *  - Preview panel + summary statistics
 *  - Bbox pre-filtering & chunked processing for large datasets
 */
import { WidgetBase } from './widget-base.js';
import logger from '../core/logger.js';

/* ── Unit conversion helpers ── */
const UNIT_LABELS = [
    { value: 'meters',     label: 'Meters',    abbr: 'm'  },
    { value: 'feet',       label: 'Feet',       abbr: 'ft' },
    { value: 'kilometers', label: 'Kilometers', abbr: 'km' },
    { value: 'miles',      label: 'Miles',      abbr: 'mi' },
];

/** Convert meters to the requested unit */
function metersTo(m, unit) {
    switch (unit) {
        case 'feet':       return m * 3.28084;
        case 'kilometers': return m / 1000;
        case 'miles':      return m * 0.000621371;
        default:           return m; // meters
    }
}

function unitAbbr(unit) {
    return UNIT_LABELS.find(u => u.value === unit)?.abbr ?? unit;
}

/* ── Representative point helpers ── */

/** Return a representative [lng, lat] for any geometry depending on method. */
function representativePoint(feature, method = 'centroid') {
    try {
        if (!feature?.geometry) return null;
        const g = feature.geometry;
        if (g.type === 'Point') return g.coordinates;
        if (method === 'centroid') {
            const c = turf.centroid(feature);
            return c.geometry.coordinates;
        }
        // center-of-mass
        const c = turf.centerOfMass(feature);
        return c.geometry.coordinates;
    } catch { return null; }
}

/* ── Distance computation ── */

/**
 * Compute distance in meters between a source feature and a target feature.
 * Returns { distance (m), nearestCoord [lng,lat] or null }.
 */
function computeDistance(srcFeature, tgtFeature, srcRepMethod) {
    try {
        const sg = srcFeature.geometry;
        const tg = tgtFeature.geometry;
        if (!sg || !tg) return { distance: Infinity, nearestCoord: null };

        // Source representative point
        let srcPt;
        if (sg.type === 'Point') {
            srcPt = turf.point(sg.coordinates);
        } else {
            const c = representativePoint(srcFeature, srcRepMethod);
            if (!c) return { distance: Infinity, nearestCoord: null };
            srcPt = turf.point(c);
        }

        // Target handling
        if (tg.type === 'Point') {
            const d = turf.distance(srcPt, tgtFeature, { units: 'meters' });
            return { distance: d, nearestCoord: tg.coordinates };
        }

        if (tg.type === 'LineString' || tg.type === 'MultiLineString') {
            const snapped = turf.nearestPointOnLine(tgtFeature, srcPt, { units: 'meters' });
            return {
                distance: snapped.properties.dist,              // meters by default
                nearestCoord: snapped.geometry.coordinates
            };
        }

        if (tg.type === 'Polygon' || tg.type === 'MultiPolygon') {
            // If point inside polygon → distance 0
            if (turf.booleanPointInPolygon(srcPt, tgtFeature)) {
                return { distance: 0, nearestCoord: srcPt.geometry.coordinates };
            }
            // Distance to polygon boundary — approximate via exterior ring sampling
            try {
                const line = turf.polygonToLine(tgtFeature);
                const snapped = turf.nearestPointOnLine(line, srcPt, { units: 'meters' });
                return {
                    distance: snapped.properties.dist,
                    nearestCoord: snapped.geometry.coordinates
                };
            } catch {
                // Fallback: centroid distance
                const c = turf.centroid(tgtFeature);
                const d = turf.distance(srcPt, c, { units: 'meters' });
                return { distance: d, nearestCoord: c.geometry.coordinates };
            }
        }

        // Geometry collection or other — centroid fallback
        const c = turf.centroid(tgtFeature);
        const d = turf.distance(srcPt, c, { units: 'meters' });
        return { distance: d, nearestCoord: c.geometry.coordinates };
    } catch {
        return { distance: Infinity, nearestCoord: null };
    }
}

/* ================================================================
   Widget
   ================================================================ */

const LARGE_DATASET_WARN = 5000;
const CHUNK_SIZE = 200;  // process N source features per animation frame

export class ProximityJoinWidget extends WidgetBase {
    constructor() {
        super('proximity-join', 'Proximity Join', '↔️', { width: '440px', subtitle: 'Add new field and extract data from nearest feature' });

        // State
        this._sourceLayerId = null;
        this._targetLayerId = null;
        this._selectionOnly = false;
        this._repMethod = 'center-of-mass';
        this._units = 'feet';
        this._maxRadius = '';                 // empty = unlimited
        this._writeDistance = true;
        this._writeMatchId = false;
        this._matchIdField = '';              // target field to use as ID
        this._writeMatchLayer = false;
        this._fieldMappings = [];             // [{ targetField, newFieldName }]
        this._results = null;                 // after run
        this._running = false;
        this._preview = null;

        // Injected deps
        this.getLayers = null;
        this.getLayerById = null;
        this.mapManager = null;
        this.analyzeSchema = null;
        this.refreshUI = null;
        this.showToast = null;
    }

    /* ======== Lifecycle ======== */

    onOpen() {
        this._resetState();
        this._refreshBody();
        this._bindEvents();
    }

    onClose() {
        this._resetState();
    }

    _resetState() {
        this._sourceLayerId = null;
        this._targetLayerId = null;
        this._selectionOnly = false;
        this._repMethod = 'center-of-mass';
        this._units = 'feet';
        this._maxRadius = '';
        this._writeDistance = true;
        this._writeMatchId = false;
        this._matchIdField = '';
        this._writeMatchLayer = false;
        this._fieldMappings = [];
        this._results = null;
        this._running = false;
        this._preview = null;
    }

    /* ================================================================
       RENDER
       ================================================================ */

    renderBody() {
        if (this._running)  return this._renderRunning();
        if (this._results)  return this._renderResults();
        if (this._preview)  return this._renderPreview();
        return this._renderConfig();
    }

    /* ---------- Main config ---------- */
    _renderConfig() {
        const layers = (this.getLayers?.() || []).filter(l => l.type === 'spatial');

        const srcOpts = layers.map(l =>
            `<option value="${l.id}" ${l.id === this._sourceLayerId ? 'selected' : ''}>${l.name} (${l.geojson?.features?.length || 0})</option>`
        ).join('');

        const tgtOpts = layers.map(l =>
            `<option value="${l.id}" ${l.id === this._targetLayerId ? 'selected' : ''}>${l.name} (${l.geojson?.features?.length || 0})</option>`
        ).join('');

        const srcLayer = this._getLayer(this._sourceLayerId);
        const tgtLayer = this._getLayer(this._targetLayerId);

        // Selection count
        const selCount = srcLayer ? (this.mapManager?.getSelectionCount?.(this._sourceLayerId) || 0) : 0;

        // Target fields
        const tgtFields = this._getFields(tgtLayer);
        const srcFields = this._getFields(srcLayer);

        // Field mapping rows
        const mappingRows = this._fieldMappings.length > 0
            ? this._fieldMappings.map((m, i) => this._renderMappingRow(m, i, tgtFields, srcFields)).join('')
            : '<div style="color:var(--text-muted);font-size:11px;font-style:italic;padding:6px 0;">No field mappings added yet. Click "+ Add Field" below.</div>';

        // Geometry info
        const srcGeom = this._dominantGeometry(srcLayer);
        const tgtGeom = this._dominantGeometry(tgtLayer);
        const needsRep = srcGeom && srcGeom !== 'Point';

        // Large dataset warning
        const srcCount = srcLayer?.geojson?.features?.length || 0;
        const tgtCount = tgtLayer?.geojson?.features?.length || 0;
        const isLarge = (srcCount * tgtCount) > (LARGE_DATASET_WARN * LARGE_DATASET_WARN);
        const largeWarn = isLarge
            ? `<div style="padding:6px 10px;border-radius:var(--radius-sm);background:rgba(255,204,0,0.12);color:#ffcc00;font-size:11px;margin-bottom:8px;">⚠ Large dataset detected (${srcCount.toLocaleString()} × ${tgtCount.toLocaleString()}). Processing may take a while.</div>`
            : '';

        const unitOpts = UNIT_LABELS.map(u =>
            `<option value="${u.value}" ${u.value === this._units ? 'selected' : ''}>${u.label} (${u.abbr})</option>`
        ).join('');

        return `
        <div style="padding:2px 0;">

            ${largeWarn}

            <!-- Source Layer -->
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--primary);color:#000;font-size:10px;font-weight:700;">1</span>
                <span style="font-size:12px;font-weight:600;color:var(--text);">Source Layer</span>
                <span style="font-size:10px;color:var(--text-muted);margin-left:auto;">Will add new field to extract data drom Target Layer</span>
            </div>
            <select id="pj-source" style="width:100%;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-surface);color:var(--text);font-size:12px;margin-bottom:4px;">
                <option value="">— select source layer —</option>
                ${srcOpts}
            </select>

            ${srcLayer ? `
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-muted);margin-bottom:8px;cursor:pointer;">
                    <input type="checkbox" id="pj-sel-only" ${this._selectionOnly ? 'checked' : ''} ${selCount === 0 ? 'disabled' : ''}>
                    Run on selected features only ${selCount > 0 ? `(${selCount} selected)` : '(none selected)'}
                </label>
            ` : ''}

            <!-- Target Layer -->
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;margin-top:4px;">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--primary);color:#000;font-size:10px;font-weight:700;">2</span>
                <span style="font-size:12px;font-weight:600;color:var(--text);">Target Layer</span>
                <span style="font-size:10px;color:var(--text-muted);margin-left:auto;">Contains the field to extract</span>
            </div>
            <select id="pj-target" style="width:100%;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-surface);color:var(--text);font-size:12px;margin-bottom:8px;">
                <option value="">— select target layer —</option>
                ${tgtOpts}
            </select>

            <!-- Field Mappings -->
            ${tgtLayer ? `
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--primary);color:#000;font-size:10px;font-weight:700;">3</span>
                <span style="font-size:12px;font-weight:600;color:var(--text);">Select Field to Extract</span>
            </div>
            <div style="background:var(--bg-surface);border-radius:var(--radius-sm);padding:8px;margin-bottom:8px;">
                <div style="font-size:10px;color:var(--text-muted);margin-bottom:6px;">Copy these target fields → new source fields</div>
                <div id="pj-mappings">
                    ${mappingRows}
                </div>
                <button id="pj-add-mapping" class="btn btn-sm btn-secondary" style="width:100%;margin-top:4px;font-size:11px;">+ Add Field</button>
            </div>
            ` : ''}

            <!-- Settings -->
            ${srcLayer && tgtLayer ? `
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--primary);color:#000;font-size:10px;font-weight:700;">4</span>
                <span style="font-size:12px;font-weight:600;color:var(--text);">Settings</span>
            </div>
            <div style="background:var(--bg-surface);border-radius:var(--radius-sm);padding:8px;margin-bottom:8px;">
                <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
                    <label style="font-size:11px;color:var(--text-muted);min-width:55px;">Units</label>
                    <select id="pj-units" style="flex:1;padding:5px 7px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11px;">
                        ${unitOpts}
                    </select>
                </div>

                <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
                    <label style="font-size:11px;color:var(--text-muted);min-width:55px;">Max Radius</label>
                    <input type="number" id="pj-max-radius" value="${this._escHtml(this._maxRadius)}" placeholder="unlimited" min="0" step="any"
                        style="flex:1;padding:5px 7px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11px;">
                    <span style="font-size:10px;color:var(--text-muted);">${unitAbbr(this._units)}</span>
                </div>

                <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;margin-top:6px;">Optional metadata fields to add:</div>
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text);cursor:pointer;margin-bottom:3px;">
                    <input type="checkbox" id="pj-write-dist" ${this._writeDistance ? 'checked' : ''}> nearest_distance (${unitAbbr(this._units)})
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text);cursor:pointer;margin-bottom:3px;">
                    <input type="checkbox" id="pj-write-id" ${this._writeMatchId ? 'checked' : ''}> matched_target_id
                    ${this._writeMatchId ? `<select id="pj-id-field" style="padding:3px 5px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:10px;max-width:120px;">
                        <option value="">— id field —</option>
                        ${tgtFields.map(f => `<option value="${f}" ${f === this._matchIdField ? 'selected' : ''}>${f}</option>`).join('')}
                    </select>` : ''}
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text);cursor:pointer;">
                    <input type="checkbox" id="pj-write-layer" ${this._writeMatchLayer ? 'checked' : ''}> matched_target_layer
                </label>
            </div>
            ` : ''}

            <!-- Action buttons -->
            <div style="display:flex;gap:6px;">
                ${srcLayer && tgtLayer && this._fieldMappings.length > 0 ? `
                    <button id="pj-preview" class="btn btn-sm btn-secondary" style="flex:1;">Preview</button>
                    <button id="pj-run" class="btn btn-sm btn-primary" style="flex:2;">▶ Run Proximity Join</button>
                ` : `
                    <button class="btn btn-sm btn-secondary" disabled style="flex:1;opacity:0.5;">Select layers & add field mappings to begin</button>
                `}
            </div>
        </div>`;
    }

    /* ---------- Mapping row ---------- */
    _renderMappingRow(m, idx, tgtFields, srcFields) {
        const tgtFieldOpts = tgtFields.map(f => `<option value="${f}" ${f === m.targetField ? 'selected' : ''}>${f}</option>`).join('');
        return `
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px;" data-mapping-idx="${idx}">
            <select class="pj-map-tgt" data-idx="${idx}" style="flex:1;padding:4px 6px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11px;">
                <option value="">— target field —</option>
                ${tgtFieldOpts}
            </select>
            <span style="color:var(--text-muted);font-size:11px;">→</span>
            <input type="text" class="pj-map-name" data-idx="${idx}" value="${this._escHtml(m.newFieldName)}" placeholder="new field name"
                style="flex:1;padding:4px 6px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:11px;">
            <button class="pj-map-del btn btn-sm btn-secondary" data-idx="${idx}" style="padding:2px 6px;font-size:11px;" title="Remove">✕</button>
        </div>`;
    }

    /* ---------- Running (spinner) ---------- */
    _renderRunning() {
        return `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;gap:12px;">
            <div style="width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:widget-spin 0.8s linear infinite;"></div>
            <div id="pj-status" style="font-size:12px;color:var(--text-muted);text-align:center;">Initializing…</div>
        </div>
        <style>@keyframes widget-spin { to { transform: rotate(360deg); } }</style>`;
    }

    /* ---------- Preview ---------- */
    _renderPreview() {
        const p = this._preview;
        if (!p?.rows?.length) return '<div style="color:var(--text-muted);font-size:12px;padding:20px;">No preview data.</div>';

        const cols = p.columns;
        const thStyle = 'padding:4px 6px;font-size:10px;font-weight:600;color:var(--text-muted);border-bottom:1px solid var(--border);text-align:left;white-space:nowrap;';
        const tdStyle = 'padding:4px 6px;font-size:11px;color:var(--text);border-bottom:1px solid var(--border);white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;';

        const header = cols.map(c => `<th style="${thStyle}">${this._escHtml(c)}</th>`).join('');
        const rows = p.rows.map(r => {
            const cells = cols.map(c => {
                let v = r[c];
                if (v === null || v === undefined) v = '—';
                else if (typeof v === 'number') v = v < 100 ? v.toFixed(2) : Math.round(v).toLocaleString();
                return `<td style="${tdStyle}">${this._escHtml(String(v))}</td>`;
            }).join('');
            return `<tr>${cells}</tr>`;
        }).join('');

        return `
        <div style="padding:2px 0;">
            <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px;">Preview (first ${p.rows.length} matches)</div>
            <div style="overflow-x:auto;max-height:280px;margin-bottom:10px;border:1px solid var(--border);border-radius:var(--radius-sm);">
                <table style="width:100%;border-collapse:collapse;">
                    <thead><tr>${header}</tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div style="display:flex;gap:6px;">
                <button id="pj-back-preview" class="btn btn-sm btn-secondary" style="flex:1;">← Back</button>
                <button id="pj-run-from-preview" class="btn btn-sm btn-primary" style="flex:2;">▶ Run Proximity Join</button>
            </div>
        </div>`;
    }

    /* ---------- Results ---------- */
    _renderResults() {
        const r = this._results;
        if (!r) return '';

        const pct = r.total > 0 ? ((r.matched / r.total) * 100).toFixed(1) : '0';
        const u = unitAbbr(this._units);

        // SVG donut
        const matchPct = r.total > 0 ? (r.matched / r.total) : 0;
        const circum = 2 * Math.PI * 40;
        const dashMatch = matchPct * circum;
        const dashUnmatch = (1 - matchPct) * circum;

        return `
        <div style="padding:2px 0;">
            <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:10px;">Results</div>

            <!-- Donut + numbers -->
            <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;">
                <svg width="90" height="90" viewBox="0 0 100 100" style="flex-shrink:0;">
                    <circle cx="50" cy="50" r="40" fill="none" stroke="var(--border)" stroke-width="10"/>
                    <circle cx="50" cy="50" r="40" fill="none" stroke="var(--success)" stroke-width="10"
                        stroke-dasharray="${dashMatch} ${dashUnmatch}" stroke-dashoffset="${circum * 0.25}"
                        stroke-linecap="round" style="transition:stroke-dasharray 0.5s;"/>
                    <text x="50" y="50" text-anchor="middle" dy="0.35em" fill="var(--text)" font-size="16" font-weight="700">${pct}%</text>
                </svg>
                <div style="font-size:12px;color:var(--text);line-height:1.6;">
                    <div><strong>${r.total.toLocaleString()}</strong> features processed</div>
                    <div style="color:var(--success);"><strong>${r.matched.toLocaleString()}</strong> matched</div>
                    <div style="color:${r.unmatched > 0 ? '#ff6b6b' : 'var(--text-muted)'};"><strong>${r.unmatched.toLocaleString()}</strong> unmatched</div>
                </div>
            </div>

            <!-- Distance stats -->
            ${r.matched > 0 ? `
            <div style="background:var(--bg-surface);border-radius:var(--radius-sm);padding:8px;margin-bottom:10px;">
                <div style="font-size:10px;font-weight:600;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">Distance Statistics (${u})</div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:12px;">
                    <div style="text-align:center;">
                        <div style="color:var(--text-muted);font-size:10px;">Min</div>
                        <div style="color:var(--text);font-weight:600;">${this._fmt(r.minDist)}</div>
                    </div>
                    <div style="text-align:center;">
                        <div style="color:var(--text-muted);font-size:10px;">Avg</div>
                        <div style="color:var(--text);font-weight:600;">${this._fmt(r.avgDist)}</div>
                    </div>
                    <div style="text-align:center;">
                        <div style="color:var(--text-muted);font-size:10px;">Max</div>
                        <div style="color:var(--text);font-weight:600;">${this._fmt(r.maxDist)}</div>
                    </div>
                </div>
            </div>
            ` : ''}

            <!-- Warnings -->
            ${r.warnings?.length ? `
            <div style="background:rgba(255,204,0,0.08);border-radius:var(--radius-sm);padding:8px;margin-bottom:10px;">
                <div style="font-size:10px;font-weight:600;color:#ffcc00;margin-bottom:4px;">Warnings</div>
                ${r.warnings.map(w => `<div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">• ${this._escHtml(w)}</div>`).join('')}
            </div>
            ` : ''}

            <div style="display:flex;gap:6px;">
                <button id="pj-done" class="btn btn-sm btn-primary" style="flex:1;">Done</button>
            </div>
        </div>`;
    }

    /* ================================================================
       EVENTS
       ================================================================ */

    _bindEvents() {
        const body = this.body;
        if (!body) return;

        body.onclick = (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const id = btn.id;

            if (id === 'pj-add-mapping')       this._addMapping();
            else if (id === 'pj-preview')      this._runPreview();
            else if (id === 'pj-run')          this._runJoin();
            else if (id === 'pj-run-from-preview') this._runJoin();
            else if (id === 'pj-back-preview') { this._preview = null; this._refreshBody(); this._bindEvents(); }
            else if (id === 'pj-done')         { this._results = null; this._resetState(); this._refreshBody(); this._bindEvents(); }

            // Mapping delete
            if (btn.classList.contains('pj-map-del')) {
                const idx = parseInt(btn.dataset.idx);
                this._fieldMappings.splice(idx, 1);
                this._refreshBody();
                this._bindEvents();
            }
        };

        body.onchange = (e) => {
            const t = e.target;
            if (t.id === 'pj-source') {
                this._sourceLayerId = t.value || null;
                this._fieldMappings = [];
                this._refreshBody(); this._bindEvents();
            }
            else if (t.id === 'pj-target') {
                this._targetLayerId = t.value || null;
                this._fieldMappings = [];
                this._refreshBody(); this._bindEvents();
            }
            else if (t.id === 'pj-sel-only')    this._selectionOnly = t.checked;
            else if (t.id === 'pj-units')       { this._units = t.value; this._refreshBody(); this._bindEvents(); }
            else if (t.id === 'pj-max-radius')  this._maxRadius = t.value;
            else if (t.id === 'pj-write-dist')  { this._writeDistance = t.checked; }
            else if (t.id === 'pj-write-id')    { this._writeMatchId = t.checked; this._refreshBody(); this._bindEvents(); }
            else if (t.id === 'pj-id-field')    this._matchIdField = t.value;
            else if (t.id === 'pj-write-layer') this._writeMatchLayer = t.checked;
            else if (t.name === 'pj-rep')       this._repMethod = t.value;

            // Mapping selects
            if (t.classList.contains('pj-map-tgt')) {
                const idx = parseInt(t.dataset.idx);
                this._fieldMappings[idx].targetField = t.value;
                // Auto-populate new field name if empty
                if (!this._fieldMappings[idx].newFieldName && t.value) {
                    this._fieldMappings[idx].newFieldName = `nearest_${t.value}`;
                    const nameInput = body.querySelector(`.pj-map-name[data-idx="${idx}"]`);
                    if (nameInput) nameInput.value = this._fieldMappings[idx].newFieldName;
                }
            }
        };

        body.oninput = (e) => {
            if (e.target.id === 'pj-max-radius') this._maxRadius = e.target.value;
            if (e.target.classList.contains('pj-map-name')) {
                const idx = parseInt(e.target.dataset.idx);
                this._fieldMappings[idx].newFieldName = e.target.value;
            }
        };
    }

    _addMapping() {
        this._fieldMappings.push({ targetField: '', newFieldName: '' });
        this._refreshBody();
        this._bindEvents();
    }

    /* ================================================================
       VALIDATION
       ================================================================ */

    _validate() {
        const errors = [];

        const srcLayer = this._getLayer(this._sourceLayerId);
        const tgtLayer = this._getLayer(this._targetLayerId);

        if (!srcLayer) errors.push('No source layer selected.');
        if (!tgtLayer) errors.push('No target layer selected.');
        if (this._sourceLayerId === this._targetLayerId) errors.push('Source and target must be different layers.');

        if (srcLayer?.geojson?.features?.length === 0) errors.push('Source layer has no features.');
        if (tgtLayer?.geojson?.features?.length === 0) errors.push('Target layer has no features.');

        // Validate field mappings
        const validMappings = this._fieldMappings.filter(m => m.targetField && m.newFieldName);
        if (validMappings.length === 0) errors.push('Add at least one field mapping (target field → new field name).');

        // Check duplicate new field names
        const names = validMappings.map(m => m.newFieldName);
        const dupes = names.filter((n, i) => names.indexOf(n) !== i);
        if (dupes.length > 0) errors.push(`Duplicate new field names: ${[...new Set(dupes)].join(', ')}`);

        if (this._maxRadius && (isNaN(this._maxRadius) || Number(this._maxRadius) <= 0)) {
            errors.push('Max radius must be a positive number or empty for unlimited.');
        }

        return errors;
    }

    /* ================================================================
       PREVIEW
       ================================================================ */

    async _runPreview() {
        const errors = this._validate();
        if (errors.length) {
            this.showToast?.(errors[0], 'warning');
            return;
        }

        logger.info('ProximityJoin', 'Generating preview…');
        const srcLayer = this._getLayer(this._sourceLayerId);
        const tgtLayer = this._getLayer(this._targetLayerId);
        const srcFeatures = this._getSourceFeatures(srcLayer);
        const tgtFeatures = tgtLayer.geojson.features;
        const validMappings = this._fieldMappings.filter(m => m.targetField && m.newFieldName);
        const maxRadiusM = this._maxRadiusMeters();

        // Run on first 10
        const sample = srcFeatures.slice(0, 10);
        const columns = ['#', ...validMappings.map(m => m.newFieldName)];
        if (this._writeDistance) columns.push('nearest_distance');

        const rows = [];
        for (let i = 0; i < sample.length; i++) {
            const sf = sample[i];
            const match = this._findNearest(sf, tgtFeatures, maxRadiusM);
            const row = { '#': i + 1 };
            for (const m of validMappings) {
                row[m.newFieldName] = match ? (match.feature.properties?.[m.targetField] ?? null) : null;
            }
            if (this._writeDistance) {
                row['nearest_distance'] = match ? parseFloat(metersTo(match.distance, this._units).toFixed(2)) : null;
            }
            rows.push(row);
        }

        this._preview = { columns, rows };
        this._refreshBody();
        this._bindEvents();
    }

    /* ================================================================
       MAIN JOIN — chunked async
       ================================================================ */

    async _runJoin() {
        const errors = this._validate();
        if (errors.length) {
            this.showToast?.(errors[0], 'warning');
            return;
        }

        const srcLayer = this._getLayer(this._sourceLayerId);
        const tgtLayer = this._getLayer(this._targetLayerId);
        const allSrcFeatures = srcLayer.geojson.features;
        const srcFeatures = this._getSourceFeatures(srcLayer);
        const tgtFeatures = tgtLayer.geojson.features;
        const validMappings = this._fieldMappings.filter(m => m.targetField && m.newFieldName);
        const maxRadiusM = this._maxRadiusMeters();

        // Build a set of actual indices we're processing (for selection-only mode)
        let featureIndices;
        if (this._selectionOnly) {
            const selIndices = this.mapManager?.getSelectedIndices?.(this._sourceLayerId) || [];
            featureIndices = selIndices;
        } else {
            featureIndices = allSrcFeatures.map((_, i) => i);
        }

        const total = featureIndices.length;
        logger.info('ProximityJoin', `Starting join: ${total} source × ${tgtFeatures.length} target features`);

        this._running = true;
        this._preview = null;
        this._refreshBody();

        // Allow the spinner to paint before heavy processing
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // Build target bbox index for pre-filtering
        const tgtIndex = this._buildBboxIndex(tgtFeatures);

        // Stats
        let matched = 0, unmatched = 0;
        let distances = [];
        const warnings = [];
        let invalidGeom = 0;

        const statusEl = () => this.body?.querySelector('#pj-status');

        // Chunked processing
        let processed = 0;

        const processChunk = () => {
            return new Promise((resolve) => {
                const processNext = () => {
                    const chunkEnd = Math.min(processed + CHUNK_SIZE, total);

                    for (; processed < chunkEnd; processed++) {
                        const srcIdx = featureIndices[processed];
                        const sf = allSrcFeatures[srcIdx];
                        if (!sf?.geometry) { invalidGeom++; unmatched++; continue; }

                        // Bbox pre-filter: only consider targets whose bbox is within
                        // reasonable range of source feature bbox
                        let candidates = tgtFeatures;
                        if (maxRadiusM > 0 && maxRadiusM < Infinity) {
                            candidates = this._bboxPreFilter(sf, tgtIndex, tgtFeatures, maxRadiusM);
                        }

                        const match = this._findNearest(sf, candidates, maxRadiusM);

                        if (!sf.properties) sf.properties = {};

                        if (match) {
                            matched++;
                            const distInUnits = metersTo(match.distance, this._units);
                            distances.push(distInUnits);

                            // Copy mapped fields
                            for (const m of validMappings) {
                                sf.properties[m.newFieldName] = match.feature.properties?.[m.targetField] ?? null;
                            }

                            // Metadata
                            if (this._writeDistance) {
                                sf.properties['nearest_distance'] = parseFloat(distInUnits.toFixed(4));
                            }
                            if (this._writeMatchId && this._matchIdField) {
                                sf.properties['matched_target_id'] = match.feature.properties?.[this._matchIdField] ?? null;
                            }
                            if (this._writeMatchLayer) {
                                sf.properties['matched_target_layer'] = tgtLayer.name;
                            }
                        } else {
                            unmatched++;
                            // Write nulls for mapped fields
                            for (const m of validMappings) {
                                sf.properties[m.newFieldName] = null;
                            }
                            if (this._writeDistance) sf.properties['nearest_distance'] = null;
                            if (this._writeMatchId && this._matchIdField) sf.properties['matched_target_id'] = null;
                            if (this._writeMatchLayer) sf.properties['matched_target_layer'] = null;
                        }
                    }

                    // Update status
                    const pct = ((processed / total) * 100).toFixed(0);
                    const el = statusEl();
                    if (el) el.textContent = `Processing… ${processed.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
                    logger.info('ProximityJoin', `Processed ${processed}/${total}`);

                    if (processed >= total) {
                        resolve();
                    } else {
                        requestAnimationFrame(processNext);
                    }
                };
                requestAnimationFrame(processNext);
            });
        };

        await processChunk();

        // Warnings
        if (invalidGeom > 0) warnings.push(`${invalidGeom} feature(s) had invalid/missing geometry.`);
        if (unmatched > 0 && maxRadiusM < Infinity) {
            warnings.push(`${unmatched} feature(s) had no target within the max search radius.`);
        }

        // Stats
        const minDist = distances.length > 0 ? Math.min(...distances) : 0;
        const maxDist = distances.length > 0 ? Math.max(...distances) : 0;
        const avgDist = distances.length > 0 ? distances.reduce((a, b) => a + b, 0) / distances.length : 0;

        this._results = { total, matched, unmatched, minDist, maxDist, avgDist, warnings };
        this._running = false;

        logger.info('ProximityJoin', `Complete: ${matched} matched, ${unmatched} unmatched, avg dist ${this._fmt(avgDist)} ${unitAbbr(this._units)}`);
        this.showToast?.(`Proximity join complete — ${matched} matched, ${unmatched} unmatched`, matched === total ? 'success' : 'info');

        // Re-analyze the source layer schema so new fields appear in exports
        if (this.analyzeSchema && srcLayer) {
            srcLayer.schema = this.analyzeSchema(srcLayer.geojson);
            logger.info('ProximityJoin', `Updated schema for "${srcLayer.name}" — ${srcLayer.schema.fields.length} fields`);
        }

        this.refreshUI?.();

        this._refreshBody();
        this._bindEvents();
    }

    /* ================================================================
       SPATIAL ENGINE
       ================================================================ */

    /**
     * Find nearest target feature to a source feature.
     * Returns { feature, distance (m), coord } or null.
     */
    _findNearest(srcFeature, targets, maxRadiusM) {
        let best = null;
        let bestDist = Infinity;

        for (let i = 0; i < targets.length; i++) {
            const tf = targets[i];
            if (!tf?.geometry) continue;
            const result = computeDistance(srcFeature, tf, this._repMethod);
            if (result.distance < bestDist) {
                bestDist = result.distance;
                best = { feature: tf, distance: result.distance, coord: result.nearestCoord, index: i };
            }
        }

        if (!best) return null;
        if (maxRadiusM > 0 && maxRadiusM < Infinity && best.distance > maxRadiusM) return null;
        return best;
    }

    /**
     * Build a simple bbox index for target features.
     * Returns array of { minX, minY, maxX, maxY, idx }.
     */
    _buildBboxIndex(features) {
        return features.map((f, i) => {
            try {
                const bbox = turf.bbox(f);
                return { minX: bbox[0], minY: bbox[1], maxX: bbox[2], maxY: bbox[3], idx: i };
            } catch {
                return null;
            }
        }).filter(Boolean);
    }

    /**
     * Pre-filter target features by bbox proximity to the source feature.
     * Uses a buffer around the source bbox in degrees (rough approximation).
     */
    _bboxPreFilter(srcFeature, tgtIndex, tgtFeatures, maxRadiusM) {
        try {
            const srcBbox = turf.bbox(srcFeature);
            // Approximate buffer in degrees (~111km per degree)
            const bufDeg = (maxRadiusM / 111000) * 1.5; // 1.5× safety factor
            const sMinX = srcBbox[0] - bufDeg;
            const sMinY = srcBbox[1] - bufDeg;
            const sMaxX = srcBbox[2] + bufDeg;
            const sMaxY = srcBbox[3] + bufDeg;

            const candidates = [];
            for (const entry of tgtIndex) {
                if (entry.maxX < sMinX || entry.minX > sMaxX || entry.maxY < sMinY || entry.minY > sMaxY) continue;
                candidates.push(tgtFeatures[entry.idx]);
            }
            return candidates.length > 0 ? candidates : tgtFeatures; // fallback to all if filter too aggressive
        } catch {
            return tgtFeatures;
        }
    }

    /* ================================================================
       HELPERS
       ================================================================ */

    _getLayer(id) {
        if (!id) return null;
        return this.getLayerById?.(id) || null;
    }

    _getFields(layer) {
        if (!layer?.geojson?.features) return [];
        const fieldSet = new Set();
        const features = layer.geojson.features;
        const sample = features.slice(0, Math.min(200, features.length));
        for (const f of sample) {
            if (f?.properties) Object.keys(f.properties).forEach(k => fieldSet.add(k));
        }
        return [...fieldSet].sort();
    }

    _dominantGeometry(layer) {
        if (!layer?.geojson?.features?.length) return null;
        const counts = {};
        for (const f of layer.geojson.features) {
            const t = f?.geometry?.type;
            if (t) {
                const base = t.replace('Multi', '');
                counts[base] = (counts[base] || 0) + 1;
            }
        }
        let best = null, bestN = 0;
        for (const [k, v] of Object.entries(counts)) {
            if (v > bestN) { best = k; bestN = v; }
        }
        return best;
    }

    _getSourceFeatures(srcLayer) {
        if (!srcLayer?.geojson?.features) return [];
        if (this._selectionOnly) {
            const indices = this.mapManager?.getSelectedIndices?.(this._sourceLayerId) || [];
            if (indices.length > 0) {
                return indices.map(i => srcLayer.geojson.features[i]).filter(Boolean);
            }
        }
        return srcLayer.geojson.features;
    }

    _maxRadiusMeters() {
        if (!this._maxRadius || this._maxRadius === '') return Infinity;
        const val = parseFloat(this._maxRadius);
        if (isNaN(val) || val <= 0) return Infinity;
        // Convert from user units to meters
        switch (this._units) {
            case 'feet':       return val / 3.28084;
            case 'kilometers': return val * 1000;
            case 'miles':      return val / 0.000621371;
            default:           return val; // meters
        }
    }

    _fmt(n) {
        if (n === null || n === undefined || isNaN(n)) return '—';
        if (Math.abs(n) < 0.01) return n.toExponential(2);
        if (Math.abs(n) < 100) return n.toFixed(2);
        return Math.round(n).toLocaleString();
    }

    _escHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

export default ProximityJoinWidget;
