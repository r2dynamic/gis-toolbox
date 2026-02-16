/**
 * Widget Base — Draggable floating panel framework
 * All widgets extend this. Handles drag, positioning, open/close lifecycle.
 */
import logger from '../core/logger.js';

let _activeWidgets = new Map(); // id → WidgetBase

export class WidgetBase {
    /**
     * @param {string} id        Unique widget ID
     * @param {string} title     Title shown in the header
     * @param {string} icon      Emoji or text icon
     * @param {object} opts      { width, minWidth, maxWidth }
     */
    constructor(id, title, icon = '⚙️', opts = {}) {
        this.id = id;
        this.title = title;
        this.icon = icon;
        this.opts = { width: '380px', ...opts };

        this._el = null;
        this._dragState = null;
        this._position = null; // { left, top } once moved
    }

    /* ---------- Public API ---------- */

    /** Open the widget (or bring to front if already open) */
    open() {
        if (this._el) {
            this._bringToFront();
            return;
        }
        this._render();
        this._anchorBottomRight();
        this._bindDrag();
        this.onOpen();
        _activeWidgets.set(this.id, this);
        logger.info('Widget', `Opened: ${this.title}`);
    }

    /** Close and remove from DOM */
    close() {
        if (!this._el) return;
        this.onClose();
        this._el.remove();
        this._el = null;
        this._position = null;
        _activeWidgets.delete(this.id);
        logger.info('Widget', `Closed: ${this.title}`);
    }

    /** Toggle open/close */
    toggle() {
        this._el ? this.close() : this.open();
    }

    /** Is the widget currently open? */
    get isOpen() { return !!this._el; }

    /** Direct reference to widget body element */
    get body() { return this._el?.querySelector('.gis-widget-body'); }

    /** Direct reference to footer element */
    get footer() { return this._el?.querySelector('.gis-widget-footer'); }

    /* ---------- Lifecycle hooks (override in subclass) ---------- */

    /** Called after DOM is attached. Build your UI here. */
    onOpen() {}

    /** Called before DOM is removed. Clean up here. */
    onClose() {}

    /** Return HTML string for the body content */
    renderBody() { return ''; }

    /** Return HTML string for footer buttons (empty = no footer) */
    renderFooter() { return ''; }

    /* ---------- Protected helpers ---------- */

    /** Re-render just the body */
    _refreshBody(html) {
        const body = this.body;
        if (body) body.innerHTML = html ?? this.renderBody();
    }

    /** Re-render footer */
    _refreshFooter(html) {
        const foot = this.footer;
        if (foot) foot.innerHTML = html ?? this.renderFooter();
    }

    /* ---------- Internals ---------- */

    _render() {
        const el = document.createElement('div');
        el.className = 'gis-widget';
        el.id = `widget-${this.id}`;
        el.style.width = this.opts.width;

        const footerHtml = this.renderFooter();
        el.innerHTML = `
            <div class="gis-widget-header">
                <span class="widget-icon">${this.icon}</span>
                <span class="widget-title">${this.title}${this.opts.subtitle ? `<span class="widget-subtitle">${this.opts.subtitle}</span>` : ''}</span>
                <button class="widget-close" title="Close">&times;</button>
            </div>
            <div class="gis-widget-body">${this.renderBody()}</div>
            ${footerHtml ? `<div class="gis-widget-footer">${footerHtml}</div>` : ''}
        `;

        el.querySelector('.widget-close').addEventListener('click', () => this.close());
        document.body.appendChild(el);
        this._el = el;
    }

    _anchorBottomRight() {
        if (!this._el) return;
        const margin = 16;
        this._el.style.right = margin + 'px';
        this._el.style.bottom = margin + 'px';
        this._el.style.left = 'auto';
        this._el.style.top = 'auto';
    }

    _bringToFront() {
        if (!this._el) return;
        // Re-append to move to top of stacking
        document.body.appendChild(this._el);
    }

    _bindDrag() {
        const header = this._el.querySelector('.gis-widget-header');
        header.addEventListener('mousedown', (e) => this._onDragStart(e));
        header.addEventListener('touchstart', (e) => this._onDragStart(e), { passive: false });
    }

    _onDragStart(e) {
        // Don't drag if clicking close button
        if (e.target.closest('.widget-close')) return;
        e.preventDefault();

        const rect = this._el.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        this._dragState = {
            startX: clientX,
            startY: clientY,
            origLeft: rect.left,
            origTop: rect.top
        };

        this._el.classList.add('dragging');

        // Convert from right/bottom anchoring to left/top
        this._el.style.left = rect.left + 'px';
        this._el.style.top = rect.top + 'px';
        this._el.style.right = 'auto';
        this._el.style.bottom = 'auto';

        const onMove = (ev) => {
            const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
            const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
            let newLeft = this._dragState.origLeft + (cx - this._dragState.startX);
            let newTop = this._dragState.origTop + (cy - this._dragState.startY);

            // Clamp to viewport
            const w = this._el.offsetWidth;
            const h = this._el.offsetHeight;
            newLeft = Math.max(0, Math.min(window.innerWidth - w, newLeft));
            newTop = Math.max(0, Math.min(window.innerHeight - 40, newTop));

            this._el.style.left = newLeft + 'px';
            this._el.style.top = newTop + 'px';
        };

        const onEnd = () => {
            this._el.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            this._position = {
                left: parseInt(this._el.style.left),
                top: parseInt(this._el.style.top)
            };
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    }
}

/** Get a currently open widget by ID */
export function getWidget(id) {
    return _activeWidgets.get(id) || null;
}

/** Close all open widgets */
export function closeAllWidgets() {
    for (const w of _activeWidgets.values()) w.close();
}

export default WidgetBase;
