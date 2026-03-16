/**
 * client/update-banner.js
 *
 * Shows a non-intrusive banner at the top of the app when an update is
 * available or downloaded. Depends on window.UPDATER injected by preload.js.
 * Safe no-op when running outside Electron (UPDATER won't exist).
 */
(function () {
    'use strict';
    if (!window.UPDATER) return;   // Running in browser without Electron preload

    // ── Create banner element ─────────────────────────────────────────────────
    const banner = document.createElement('div');
    banner.id    = 'update-banner';
    banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
        'padding:10px 20px', 'display:none', 'align-items:center',
        'justify-content:space-between', 'font-size:13px', 'font-weight:500',
        'color:#fff', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
    ].join(';');
    document.body.appendChild(banner);

    function showBanner(message, bgColor, actions) {
        banner.innerHTML = `
            <span>${message}</span>
            <span style="display:flex;gap:10px;align-items:center;">
                ${actions.map(a =>
                    `<button onclick="${a.fn}()" style="
                        background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);
                        color:#fff;padding:4px 14px;border-radius:6px;cursor:pointer;font-size:12px;
                    ">${a.label}</button>`
                ).join('')}
                <button onclick="document.getElementById('update-banner').style.display='none'"
                    style="background:none;border:none;color:rgba(255,255,255,0.7);cursor:pointer;
                    font-size:18px;line-height:1;padding:0 4px;">&times;</button>
            </span>`;
        banner.style.background = bgColor;
        banner.style.display    = 'flex';
    }

    // Expose action fns globally so they survive innerHTML rendering
    window._updateInstallNow = () => window.UPDATER.installNow();
    window._updateCheckNow   = () => window.UPDATER.checkNow();
    window._dismissBanner    = () => { banner.style.display = 'none'; };

    // ── Event subscriptions ───────────────────────────────────────────────────
    window.UPDATER.on('update:available', (data) => {
        showBanner(
            `⬇️ Update available: v${data.version} — downloading in background…`,
            '#0369a1',
            []
        );
    });

    window.UPDATER.on('update:download-progress', (data) => {
        if (banner.style.display === 'none') return;
        const pct = data.percent || 0;
        banner.querySelector('span').textContent =
            `⬇️ Downloading update… ${pct}%`;
    });

    window.UPDATER.on('update:downloaded', (data) => {
        showBanner(
            `✅ Update v${data.version} is ready to install.`,
            '#065f46',
            [{ label: 'Restart & Install', fn: '_updateInstallNow' }]
        );
    });

    window.UPDATER.on('update:error', (data) => {
        console.warn('[update-banner] Update error:', data.message);
        // Don't show error banner to users — silently swallow
    });

    window.UPDATER.on('update:not-available', () => {
        // No banner needed — everything is up to date
    });

    window.UPDATER.on('update:checking', () => {
        // No banner — silent background check
    });

})();
