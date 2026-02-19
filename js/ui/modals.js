/**
 * Modal + Bottom Sheet helpers
 */

export function showModal(title, contentHtml, options = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const isMobile = window.innerWidth < 768;

        // On mobile: use standard modal (CSS styles it to 96vw centered with big close btn)
        // No more bottom sheet — map stays visible behind semi-transparent overlay
        const width = isMobile ? '96vw' : (options.width || '600px');
        overlay.innerHTML = `
            <div class="modal" style="width:${width}">
                <div class="modal-header">
                    <span>${title}</span>
                    <button class="btn-icon close-modal" aria-label="Close">✕</button>
                </div>
                <div class="modal-body">${contentHtml}</div>
                ${options.footer ? `<div class="modal-footer">${options.footer}</div>` : ''}
            </div>`;

        document.body.appendChild(overlay);

        const close = (result) => {
            overlay.remove();
            resolve(result);
        };

        overlay.querySelector('.close-modal').onclick = () => close(null);

        // Track where mousedown started so text-selection drags that end
        // outside the modal don't accidentally close it
        let mouseDownTarget = null;
        overlay.addEventListener('mousedown', (e) => { mouseDownTarget = e.target; });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && mouseDownTarget === overlay) close(null);
        });

        // Make close and overlay accessible to content scripts
        overlay._close = close;
        overlay._resolve = resolve;

        if (options.onMount) options.onMount(overlay, close);
    });
}

/**
 * Simple confirm dialog
 */
export function confirm(title, message) {
    return showModal(title, `<p>${message}</p>`, {
        footer: `<button class="btn btn-secondary cancel-btn">Cancel</button>
                 <button class="btn btn-primary confirm-btn">Confirm</button>`,
        onMount: (overlay, close) => {
            overlay.querySelector('.cancel-btn').onclick = () => close(false);
            overlay.querySelector('.confirm-btn').onclick = () => close(true);
        }
    });
}

/**
 * Show progress modal for long operations
 */
export function showProgressModal(title) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal" style="width:400px">
            <div class="modal-header">
                <span>${title}</span>
            </div>
            <div class="modal-body" style="text-align:center; padding:24px;">
                <div class="spinner" style="margin:0 auto 12px;"></div>
                <div class="progress-step" style="margin-bottom:12px; color:var(--text-muted);">Starting...</div>
                <div class="progress-bar-container">
                    <div class="progress-bar-fill" style="width:0%"></div>
                    <div class="progress-bar-text">0%</div>
                </div>
                <button class="btn btn-secondary btn-sm cancel-task-btn" style="margin-top:12px;">Cancel</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    return {
        update(percent, step) {
            const bar = overlay.querySelector('.progress-bar-fill');
            const text = overlay.querySelector('.progress-bar-text');
            const stepEl = overlay.querySelector('.progress-step');
            if (bar) bar.style.width = percent + '%';
            if (text) text.textContent = Math.round(percent) + '%';
            if (stepEl && step) stepEl.textContent = step;
        },
        onCancel(fn) {
            const btn = overlay.querySelector('.cancel-task-btn');
            if (btn) btn.onclick = fn;
        },
        close() {
            overlay.remove();
        },
        element: overlay
    };
}

export default { showModal, confirm, showProgressModal };
