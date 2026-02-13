/**
 * Toast notification system
 */

const TOAST_DURATION = 5000;

export function showToast(message, type = 'info', options = {}) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' };
    let html = `<span>${icons[type] || ''}</span><div class="toast-content">
        <div>${message}</div>`;

    if (options.details) {
        html += `<div class="toast-details" onclick="this.nextElementSibling.classList.toggle('hidden')">Show details</div>
        <div class="toast-details-body hidden">${options.details}</div>`;
    }
    html += `</div><span class="toast-close" onclick="this.parentElement.remove()">✕</span>`;
    toast.innerHTML = html;

    container.appendChild(toast);
    const duration = options.duration || TOAST_DURATION;
    if (duration > 0) {
        setTimeout(() => toast.remove(), duration);
    }
    return toast;
}

/**
 * Show a user-friendly error with guidance
 */
export function showErrorToast(errorInfo) {
    const msg = `<strong>${errorInfo.title || 'Error'}</strong><br>${errorInfo.message}`;
    const details = [errorInfo.guidance, errorInfo.technical].filter(Boolean).join('<br><br>');
    return showToast(msg, 'error', { details, duration: 8000 });
}

export default { showToast, showErrorToast };
