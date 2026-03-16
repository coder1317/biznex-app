/**
 * client/sync-indicator.js
 *
 * Shows a small cloud backup status badge in the bottom-right of the screen.
 * Plugs into window.SYNC (injected by preload.js).
 * Safe no-op when SYNC is not available (browser mode, no Electron).
 */
(function () {
    'use strict';
    if (!window.SYNC) return;

    // ── Create indicator element ───────────────────────────────────────────────
    const el = document.createElement('div');
    el.id    = 'sync-indicator';
    el.title = 'Cloud backup status';
    el.style.cssText = [
        'position:fixed', 'bottom:12px', 'right:16px', 'z-index:9000',
        'display:flex', 'align-items:center', 'gap:6px',
        'background:rgba(15,23,42,0.85)', 'border:1px solid #334155',
        'border-radius:20px', 'padding:5px 12px',
        'font-size:11px', 'color:#94a3b8', 'cursor:pointer',
        'backdrop-filter:blur(4px)',
        'transition:opacity 0.3s',
    ].join(';');
    document.body.appendChild(el);

    function render(state) {
        const { syncing, success, error, lastSyncAt } = state || {};
        let icon, text, color;

        if (syncing) {
            icon = '🔄'; text = 'Backing up…'; color = '#93c5fd';
        } else if (error) {
            icon = '⚠️'; text = 'Backup failed'; color = '#fca5a5';
        } else if (success && lastSyncAt) {
            const ago  = timeSince(new Date(lastSyncAt));
            icon = '☁️'; text = `Backed up ${ago}`; color = '#86efac';
        } else {
            icon = '☁️'; text = 'No backup yet'; color = '#94a3b8';
        }

        el.innerHTML = `<span>${icon}</span><span style="color:${color}">${text}</span>`;
        el.title     = error ? `Last error: ${error}` : (lastSyncAt ? `Last backup: ${lastSyncAt}` : 'Cloud backup');
    }

    // ── Manual backup on click ─────────────────────────────────────────────────
    el.addEventListener('click', async () => {
        render({ syncing: true });
        await window.SYNC.backupNow();
    });

    // ── Subscribe to live status events ───────────────────────────────────────
    window.SYNC.on('sync:status', (data) => render(data));

    // ── Load initial status ───────────────────────────────────────────────────
    window.SYNC.getStatus().then(status => {
        if (status && status.lastSyncAt) render(status);
    });

    // ── Helpers ───────────────────────────────────────────────────────────────
    function timeSince(date) {
        const secs = Math.floor((Date.now() - date.getTime()) / 1000);
        if (secs < 60)     return 'just now';
        if (secs < 3600)   return `${Math.floor(secs / 60)}m ago`;
        if (secs < 86400)  return `${Math.floor(secs / 3600)}h ago`;
        return `${Math.floor(secs / 86400)}d ago`;
    }
})();
