/* ============================================================
   PHASE 4 — DYNAMIC API BASE URL (Electron ↔ Raspberry Pi)
   APP_CONFIG is injected by electron-shell/preload.js via contextBridge.
   Falls back to localhost so the app also works outside Electron.
============================================================ */
const BASE_URL = (window.APP_CONFIG && window.APP_CONFIG.apiBaseUrl) || 'http://localhost:3000';

// Transparently rewrite any hardcoded http://localhost:3000 fetch() call
// so the same build works whether pointed at a local or network server.
const _origFetch = window.fetch.bind(window);
window.fetch = (url, opts) => {
    if (typeof url === 'string' && url.startsWith('http://localhost:3000')) {
        url = BASE_URL + url.slice('http://localhost:3000'.length); // safe length, not hardcoded
    }
    return _origFetch(url, opts);
};
console.log('🌐 API BASE_URL:', BASE_URL);

// Declare early so renderPage() can reference it regardless of call timing
const ACCESS_DENIED_HTML = `
    <section class="page">
        <div class="content" style="padding:3rem;text-align:center">
            <h2 style="font-size:2rem;margin-bottom:0.5rem">🚫 Access Denied</h2>
            <p style="color:var(--muted,#888)">You don't have permission to access this module.<br>Contact an administrator to request access.</p>
        </div>
    </section>`;

/* ============================================================
   CLOUD-SYNC STATUS
   Core POS data (products, orders, users) lives entirely in the
   local SQLite database — it works 100% offline.
   Analytics / reports (dashboard graphs, daily/monthly sales,
   inventory reports, low-stock alerts) are also computed locally.
   The banner below shows whether the device's WiFi / LAN adapter
   has actual internet — checked by pinging a known lightweight
   external endpoint so the result reflects real connectivity,
   not just whether a network interface exists.
============================================================ */
let internetOnline = navigator.onLine; // quick boot-time guess from OS

// Active internet probe via the device WiFi/LAN adapter.
// Uses Google's generate_204 endpoint — returns HTTP 204 instantly
// and is specifically designed for connectivity detection.
async function probeInternet() {
    try {
        const r = await _origFetch('https://clients3.google.com/generate_204', {
            method: 'HEAD',
            cache: 'no-store',
            signal: AbortSignal.timeout(4000)
        });
        return r.status === 204 || r.ok;
    } catch {
        return false;
    }
}

function getCloudSyncBanner() {
    if (internetOnline) {
        return `<div class="cloud-sync-banner online">
            <span>☁️ Internet connected — cloud sync available</span>
        </div>`;
    }
    return `<div class="cloud-sync-banner offline">
        <span>📡 No internet — showing local device data</span>
    </div>`;
}

// Browser events fire immediately when the WiFi adapter connects/disconnects.
// We re-probe to confirm before updating UI (avoids false positives).
window.addEventListener('online', async () => {
    const result = await probeInternet();
    if (internetOnline !== result) { internetOnline = result; try { render(); } catch(e){} }
});
window.addEventListener('offline', () => {
    if (internetOnline) { internetOnline = false; try { render(); } catch(e){} }
});

/* ============================================================
   PHASE 2 — REFRESH TOKEN SUPPORT
   Access tokens expire in 1h; a 7-day refresh token silently
   obtains a new one so users aren’t kicked out mid-shift.
============================================================ */
// Singleton promise — prevents concurrent 401s from firing multiple refresh requests.
let _refreshPromise = null;
async function refreshAccessToken() {
    if (_refreshPromise) return _refreshPromise; // serialise concurrent callers
    _refreshPromise = _doRefresh();
    _refreshPromise.finally(() => { _refreshPromise = null; });
    return _refreshPromise;
}
async function _doRefresh() {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) return false;
    try {
        const res = await _origFetch(`${BASE_URL}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken })
        });
        if (!res.ok) {
            // Clear both tokens so the user is sent to login, not an infinite retry loop
            localStorage.removeItem('refreshToken');
            localStorage.removeItem('authToken');
            return false;
        }
        const data = await res.json();
        localStorage.setItem('authToken', data.accessToken || data.token);
        if (data.refreshToken) localStorage.setItem('refreshToken', data.refreshToken);
        return true;
    } catch (e) {
        console.error('Token refresh failed:', e);
        return false;
    }
}
// Expose so prompt-modal.js can call it on 401
window.refreshAccessToken = refreshAccessToken;

/* ============================================================
   PHASE 5 — REAL-TIME SOCKET.IO
   Listens for server-pushed events so all connected clients
   (multiple cashiers / RPi tablets) see live inventory + order updates.
============================================================ */
function initSocket() {
    try {
        if (typeof io === 'undefined') { console.warn('socket.io not loaded, real-time disabled'); return; }
        const socket = io(BASE_URL, { transports: ['websocket', 'polling'], reconnection: true });
        window._socket = socket;
        socket.on('connect',    () => { console.log('🔌 socket.io connected'); updateStatusIndicator('online', 'Live'); });
        socket.on('disconnect', () => { console.log('🔌 socket.io disconnected'); updateStatusIndicator('offline', 'Disconnected'); });
        // Product changes — refresh product list for all clients
        socket.on('product:created', () => { loadProducts().then(() => render()); });
        socket.on('product:updated', () => { loadProducts().then(() => render()); });
        socket.on('product:deleted', () => { loadProducts().then(() => render()); });
        // Order placed — refresh orders / dashboard if those pages are open
        socket.on('order:created', (data) => {
            if (currentPage === 'orders')    loadOrders().then(() => render());
            if (currentPage === 'dashboard') loadDashboard().then(() => render());
        });
        // Low stock alert toast
        socket.on('stock:low', (data) => {
            showToast(`⚠️ Low stock: ${data.name} (${data.stock} left)`, 'warning', 6000);
        });
        console.log('🔌 socket.io initialised, connecting to', BASE_URL);
    } catch (e) {
        console.warn('socket.io init error:', e.message);
    }
}

const app = document.getElementById("app");

/* ======================
   UI STATE
====================== */
let currentPage = "dashboard";
let selectedProductId = null;
let currentUser = null;
let licenseInfo = null; // { plan, planLabel, licenseKey, activatedAt } or null (trial mode)
let trialInfo   = null; // { started, active, daysLeft, trialDays } — set when in trial mode

/* ======================
   PLAN-BASED FEATURE GATING
====================== */
// Maps each license plan to its feature flags and display metadata.
// Key format: BZNX-STR-... = starter, BZNX-BIZ-... = business, BZNX-ENT-... = enterprise
const PLAN_FEATURES = {
    starter: {
        multistore:        false,
        advancedAnalytics: false,
        maxLocations:      1,
        label:             'Starter',
        type:              'Single Store',
        icon:              '🏪',
        color:             '#818cf8',
        badge:             'STR',
    },
    business: {
        multistore:        true,
        advancedAnalytics: false,
        maxLocations:      10,
        label:             'Business',
        type:              'Multi-Store',
        icon:              '🏬',
        color:             '#38bdf8',
        badge:             'BIZ',
    },
    enterprise: {
        multistore:        true,
        advancedAnalytics: true,
        maxLocations:      null, // unlimited
        label:             'Enterprise',
        type:              'Unlimited Stores',
        icon:              '🏢',
        color:             '#34d399',
        badge:             'ENT',
    },
    trial: {
        multistore:        false,
        advancedAnalytics: false,
        maxLocations:      1,
        label:             'Trial',
        type:              'Trial Period',
        icon:              '⏱️',
        color:             '#f59e0b',
        badge:             'TRL',
    },
};

/** Returns the active plan key: license plan → trial → 'starter' fallback */
function getPlanKey() {
    if (licenseInfo && licenseInfo.plan) return licenseInfo.plan;
    if (trialInfo   && trialInfo.active)  return 'trial';
    return 'starter';
}

/** Returns the PLAN_FEATURES config object for the active plan */
function getPlanConfig() {
    return PLAN_FEATURES[getPlanKey()] || PLAN_FEATURES.starter;
}

/**
 * Returns true if the current license plan includes the given feature.
 * @param {string} feat  e.g. 'multistore', 'advancedAnalytics'
 */
function planHasFeature(feat) {
    return getPlanConfig()[feat] === true;
}

/* REAL DATA (START EMPTY) */
let products = [];
window.products = products;
let allProducts = [];
// cart is now managed by app/frontend/cart.js exposing global helpers
let paymentMethod = "cash";
let orders = [];
let dailySales = [];
let dashboard = {
    sales: {},
    stock: {},
    recentOrders: []
};
let salesRange = "today";
let salesSeries = [];
let lowStockItems = [];
let inventoryReport = {};
let inventoryList = [];
let suppliers = [];

// Loading flags for page-level data fetches
let loadingState = {
    products: false,
    reports: false,
    suppliers: false,
    orders: false,
    dashboard: false
};

let discounts = [];
let users = [];

// Cache timestamps to avoid unnecessary API calls
let cacheTimestamps = {
    products: 0,
    orders: 0,
    dashboard: 0,
    reports: 0,
    lowStock: 0,
    inventory: 0,
    suppliers: 0
};

const CACHE_DURATION = 30000; // 30 seconds

/* ======================
   STATUS MONITORING
====================== */
let connectionStatus = 'online';

function updateStatusIndicator(status, message) {
    connectionStatus = status;
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');

    if (dot && text) {
        dot.className = 'status-dot ' + status;
        text.textContent = message;
    }
}

async function checkConnectivity() {
    // ── 1. Local embedded server health ────────────────────────────
    let serverUp = false;
    try {
        const response = await _origFetch('http://localhost:3000/health', {
            method: 'GET',
            signal: AbortSignal.timeout(3000)
        });
        serverUp = response.ok;
    } catch { serverUp = false; }

    // ── 2. Real internet via device's network adapter ───────────────
    // Uses navigator.onLine as a fast pre-check (avoids network round-trip
    // when OS already knows the adapter is disconnected), then confirms
    // with a live probe so hotspot / captive-portal cases are caught too.
    const wasOnline = internetOnline;
    internetOnline = navigator.onLine ? await probeInternet() : false;

    // ── 3. Update status indicator ─────────────────────────────────
    // Show "Online" only when BOTH the local server is reachable AND the
    // device has real internet connectivity.
    if (serverUp && internetOnline) {
        if (connectionStatus !== 'online') {
            updateStatusIndicator('online', 'Online');
            showToast('Back online', 'success');
        } else {
            updateStatusIndicator('online', 'Online');
        }
    } else if (serverUp && !internetOnline) {
        // Server is up but no internet — POS still works fully
        if (connectionStatus !== 'local') {
            updateStatusIndicator('local', 'Local only');
            if (wasOnline) showToast('Internet disconnected — POS still working locally', 'warning');
        }
    } else {
        // Local server not reachable
        if (connectionStatus === 'online' || connectionStatus === 'local') {
            updateStatusIndicator('offline', 'Offline');
            showToast('Server not reachable — working offline', 'warning');
        } else {
            updateStatusIndicator('offline', 'Offline');
        }
    }
    connectionStatus = serverUp ? (internetOnline ? 'online' : 'local') : 'offline';

    if (wasOnline !== internetOnline) {
        console.log('📡 Internet status changed:', internetOnline ? 'ONLINE' : 'OFFLINE');
        try { render(); } catch(e) {}
    }
}

// Check local server + internet every 30 seconds
setInterval(checkConnectivity, 30000);

// Initial check shortly after load
setTimeout(checkConnectivity, 1500);

/* ======================
   ERROR HANDLING
====================== */
window.addEventListener('error', (event) => {
    console.error('Global error:', event.error);
    showToast('An unexpected error occurred', 'error');
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    showToast('A background operation failed', 'error');
});

/* ======================
   AUTHENTICATION
====================== */
async function checkAuth() {
    let token = localStorage.getItem('authToken');
    console.log('checkAuth: token=', !!token);
    // Phase 2: no access token — try silent refresh before showing login
    if (!token) {
        const refreshed = await refreshAccessToken();
        if (!refreshed) { showLogin(); return; }
        token = localStorage.getItem('authToken');
    }
    try {
        const response = await fetch('http://localhost:3000/api/auth/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
            const data = await response.json();
            // Normalize permissions array
            data.user.permissions = Array.isArray(data.user.permissions) ? data.user.permissions : (data.user.permissions ? JSON.parse(JSON.stringify(data.user.permissions || [])) : []);
            currentUser = data.user;
            console.log('checkAuth: authenticated user=', currentUser && currentUser.username);
            showApp();
        } else if (response.status === 401) {
            // Access token expired — attempt one silent refresh
            const refreshed = await refreshAccessToken();
            if (refreshed) { await checkAuth(); return; }
            localStorage.removeItem('authToken');
            showLogin();
        } else {
            console.warn('checkAuth: token invalid, removing');
            localStorage.removeItem('authToken');
            showLogin();
        }
    } catch (error) {
        // Network error (server still starting up or offline) — do NOT wipe the token.
        // The embedded server is on localhost so this is a transient issue; retry on next
        // page interaction rather than forcing re-login every time the network blips.
        console.warn('Auth check network error (server may be starting):', error.message);
        if (localStorage.getItem('authToken')) {
            // Keep existing token and stay on current page if we already logged in
            if (currentUser) return; // already authenticated in this session
        }
        showLogin();
    }
}

function showLogin() {
    document.getElementById('loginModal').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
}

function showApp() {
    document.getElementById('loginModal').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    if (window.LICENSE && window.LICENSE.getInfo) {
        window.LICENSE.getInfo().then(info => {
            licenseInfo = info;
            if (!info && window.LICENSE.getTrial) {
                window.LICENSE.getTrial().then(t => { trialInfo = t; go(currentPage); }).catch(() => { go(currentPage); });
            } else {
                go(currentPage); // load data for the initial page
            }
        }).catch(() => { go(currentPage); });
    } else {
        go(currentPage); // load data for the initial page
    }
}

async function login(username, password) {
    try {
        const response = await fetch('http://localhost:3000/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await response.json();
        if (response.ok) {
                // Ensure permissions normalized
                data.user.permissions = Array.isArray(data.user.permissions) ? data.user.permissions : (data.user.permissions ? JSON.parse(JSON.stringify(data.user.permissions || [])) : []);
                currentUser = data.user;
            localStorage.setItem('authToken', data.accessToken || data.token);
            if (data.refreshToken) localStorage.setItem('refreshToken', data.refreshToken); // Phase 2
            showApp();
            showToast(`Welcome, ${currentUser.username}!`, 'success');
        } else {
            document.getElementById('loginError').textContent = data.error;
            document.getElementById('loginError').style.display = 'block';
        }
    } catch (error) {
        console.error('Login failed:', error);
        showToast('Login failed', 'error');
    }
}

async function logout() {
    const token = localStorage.getItem('authToken');
    const refreshToken = localStorage.getItem('refreshToken');
    try {
        await fetch('http://localhost:3000/api/auth/logout', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken })
        });
    } catch (error) {
        console.error('Logout failed:', error);
    }
    localStorage.removeItem('authToken');
    localStorage.removeItem('refreshToken'); // Phase 2: clear refresh token
    currentUser = null;
    showLogin();
    showToast('Logged out', 'info');
}

// Helper for authenticated requests
function fetchWithAuth(url, options = {}) {
    // If an enhanced implementation is available (from prompt-modal.js), delegate to it
    if (window._enhancedFetchWithAuth && typeof window._enhancedFetchWithAuth === 'function') {
        return window._enhancedFetchWithAuth(url, options);
    }

    const token = localStorage.getItem('authToken');
    if (token) {
        options.headers = options.headers || {};
        options.headers['Authorization'] = `Bearer ${token}`;
    }
    return fetch(url, options);
}

// Initialize auth check on load
document.addEventListener('DOMContentLoaded', () => { checkAuth(); initSocket(); });

// Login form handler
document.getElementById('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    login(username, password);
});

/* ======================
   TOAST NOTIFICATIONS
====================== */
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: '✓',
        error: '✕',
        warning: '⚠',
        info: 'ℹ'
    };

    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <span class="toast-message">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;

    container.appendChild(toast);

    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);

    // Auto remove
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/* PAGE_LABELS declared here (before go()) to avoid temporal dead zone errors
   when renderTopbar() is called synchronously during first navigation. */
const PAGE_LABELS = {
    dashboard:  'Dashboard',
    pos:        'Point of Sale',
    products:   'Products',
    suppliers:  'Suppliers',
    orders:     'Orders',
    reports:    'Reports',
    discounts:  'Discounts',
    users:      'Users',
    multistore: 'Multi-Store Management',
    analytics:  'Analytics Pro',
};

/* ======================
    ROOT
====================== */
// Do NOT call go() here — auth check runs on DOMContentLoaded and
// calls showApp() → go(currentPage) only after the token is verified.
// Calling go() here fires data-loading API calls before auth completes,
// causing a storm of 401s and concurrent token-refresh races.

// Event delegation for Add-to-cart buttons (single listener)
document.addEventListener("click", (e) => {
    const btn = e.target?.closest?.('.add-to-cart');
    if (!btn) return;
    const productId = Number(btn.dataset.id);
    if (Number.isNaN(productId)) return;
    addToCart(productId);
});

function render() {
    app.innerHTML = `
        <div class="layout">
            ${renderSidebar()}
            <div class="content-area">
                ${renderTopbar()}
                <main class="main">
                    ${renderPage()}
                </main>
            </div>
        </div>
    `;

    setTimeout(() => { drawSalesChart(); }, 0);
    // If POS page is active, render dynamic POS DOM pieces (products grid + cart)
    if (currentPage === "pos") {
        setTimeout(() => { posRenderProducts(); renderCart(); }, 0);
    }
}

function renderTopbar() {
    const initials = currentUser ? currentUser.username.slice(0, 2).toUpperCase() : '?';
    return `
        <div class="topbar">
            <h1 class="topbar-title">${PAGE_LABELS[currentPage] || currentPage}</h1>
            <div class="topbar-right">
                <div class="topbar-user-pill">
                    <div class="topbar-avatar">${initials}</div>
                    <div>
                        <div class="topbar-user-name">${currentUser ? currentUser.username : ''}</div>
                        <div class="topbar-user-role">${currentUser ? currentUser.role : ''}</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/* ======================
   PERMISSIONS
====================== */
// Top-level hasPerm – used by renderSidebar, go(), renderPage() and any other guard
function hasPerm(p) {
    if (!currentUser) return false;
    if (currentUser.role === 'admin') return true;
    return Array.isArray(currentUser.permissions) && currentUser.permissions.includes(p);
}

/* ======================
   SIDEBAR
====================== */
function renderSidebar() {
    return `
        <aside class="sidebar">
            <div class="brand">
                <img src="logo.png" class="brand-logo-img" alt="Biznex">
                <div class="brand-text">
                    <span class="logo">BIZNEX</span>
                    <span class="subtitle">Business OS</span>
                </div>
            </div>

            <nav class="menu">
                ${hasPerm('dashboard') ? `<button type="button" class="menu-item ${currentPage==='dashboard'?'active':''}" onclick="go('dashboard')"><span>📊</span> Dashboard</button>` : ''}
                ${hasPerm('pos') ? `<button type="button" class="menu-item ${currentPage==='pos'?'active':''}" onclick="go('pos')"><span>🛒</span> POS</button>` : ''}
                ${hasPerm('products') ? `<button type="button" class="menu-item ${currentPage==='products'?'active':''}" onclick="go('products')"><span>📦</span> Products</button>` : ''}
                ${hasPerm('suppliers') ? `<button type="button" class="menu-item ${currentPage==='suppliers'?'active':''}" onclick="go('suppliers')"><span>🚚</span> Suppliers</button>` : ''}
                ${hasPerm('orders') ? `<button type="button" class="menu-item ${currentPage==='orders'?'active':''}" onclick="go('orders')"><span>📋</span> Orders</button>` : ''}
                ${hasPerm('reports') ? `<button type="button" class="menu-item ${currentPage==='reports'?'active':''}" onclick="go('reports')"><span>📈</span> Reports</button>` : ''}
                ${hasPerm('discounts') ? `<button type="button" class="menu-item ${currentPage==='discounts'?'active':''}" onclick="go('discounts')"><span>🏷️</span> Discounts</button>` : ''}
                ${hasPerm('users') ? `<button type="button" class="menu-item ${currentPage==='users'?'active':''}" onclick="go('users')"><span>👥</span> Users</button>` : ''}
                <div class="menu-divider"></div>
                ${planHasFeature('multistore')
                    ? `<button type="button" class="menu-item ${currentPage==='multistore'?'active':''}" onclick="go('multistore')"><span>🏬</span> Multi-Store</button>`
                    : `<button type="button" class="menu-item plan-locked" onclick="showUpgradePrompt('multistore')"><span>🏬</span> Multi-Store <span class="plan-lock-badge">BIZ+</span></button>`}
                ${planHasFeature('advancedAnalytics')
                    ? `<button type="button" class="menu-item ${currentPage==='analytics'?'active':''}" onclick="go('analytics')"><span>📊</span> Analytics Pro</button>`
                    : `<button type="button" class="menu-item plan-locked" onclick="showUpgradePrompt('analytics')"><span>📊</span> Analytics Pro <span class="plan-lock-badge">ENT</span></button>`}
            </nav>

            <div class="sidebar-footer">
                <div class="sidebar-user-avatar">${currentUser ? currentUser.username.slice(0,2).toUpperCase() : '?'}</div>
                <div class="sidebar-user-info">
                    <span class="username">${currentUser ? currentUser.username : 'User'}</span>
                    <span class="user-role">${currentUser ? currentUser.role : ''}</span>
                    ${(() => {
                        const pc = { starter: '#818cf8', business: '#38bdf8', enterprise: '#34d399' };
                        if (licenseInfo && licenseInfo.plan) {
                            const pn  = licenseInfo.plan;
                            const col = pc[pn] || '#818cf8';
                            const lbl = pn.charAt(0).toUpperCase() + pn.slice(1);
                            return `<span style="background:${col}20;color:${col};border:1px solid ${col}40;border-radius:4px;font-size:9px;font-weight:700;padding:2px 6px;letter-spacing:0.5px;text-transform:uppercase;margin-top:2px;display:inline-block;">${lbl}</span>`;
                        } else if (trialInfo && trialInfo.active) {
                            return `<span style="background:#f59e0b20;color:#f59e0b;border:1px solid #f59e0b40;border-radius:4px;font-size:9px;font-weight:700;padding:2px 6px;letter-spacing:0.5px;text-transform:uppercase;margin-top:2px;display:inline-block;">Trial &mdash; ${trialInfo.daysLeft}d left</span>`;
                        } else {
                            return `<span style="background:#f59e0b20;color:#f59e0b;border:1px solid #f59e0b40;border-radius:4px;font-size:9px;font-weight:700;padding:2px 6px;letter-spacing:0.5px;text-transform:uppercase;margin-top:2px;display:inline-block;">Trial</span>`;
                        }
                    })()}
                </div>
                <button onclick="openAppSettings()" class="sidebar-logout" title="Settings" style="margin-right:4px;">⚙</button>
                <button onclick="logout()" class="sidebar-logout" title="Logout">⏻</button>
            </div>
        </aside>
    `;
}

async function go(page) {
    try {
        const now = Date.now();

        // Permission guard – redirect users away from pages they lack access to
        // Admin role always has full access — skip the check entirely.
        // Plan-gated pages (multistore, analytics) use plan-level locking in renderPage, not role perms.
        const PLAN_GATED_PAGES = ['multistore', 'analytics'];
        if (currentUser && currentUser.role !== 'admin' && !hasPerm(page) && !PLAN_GATED_PAGES.includes(page)) {
            const all = ['dashboard', 'pos', 'products', 'suppliers', 'orders', 'reports', 'discounts', 'users'];
            const first = all.find(p => hasPerm(p));
            if (first) {
                return go(first);
            }
            showToast('You do not have access to any modules. Contact an administrator.', 'error');
            return;
        }

        currentPage = page;
        selectedProductId = null;

        // Render immediately for instant page switch
        render();

        // Load data in background if needed
        if ((page === "products" || page === "pos") && now - cacheTimestamps.products > CACHE_DURATION) {
            await loadProducts();
            if (page === "products") {
                if (now - cacheTimestamps.suppliers > CACHE_DURATION) {
                    await loadSuppliers();
                }
                if (now - cacheTimestamps.lowStock > CACHE_DURATION) {
                    await loadLowStock();
                }
            }
            render();
        }

        if (page === "orders" && now - cacheTimestamps.orders > CACHE_DURATION) {
            await loadOrders();
            render();
        }

        if (page === "users") {
            await loadUsers();
        }

        if (page === "discounts") {
            await loadDiscounts();
        }

        if (page === "reports" && now - cacheTimestamps.reports > CACHE_DURATION) {
            await loadReports();
            render();
        }

        if (page === "inventory" && now - cacheTimestamps.inventory > CACHE_DURATION) {
            await loadInventoryReport();
            render();
        }

        if (page === "suppliers") {
            if (now - cacheTimestamps.suppliers > CACHE_DURATION) {
                await loadSuppliers();
            }
            render();
        }

        if (page === "dashboard" && now - cacheTimestamps.dashboard > CACHE_DURATION) {
            await loadDashboard();
            render();
        }
    } catch (err) {
        console.error('Navigation failed for', page, err);
        showToast('Navigation failed: ' + (err && err.message ? err.message : 'unknown'), 'error');
    }
}

async function loadOrders() {
    console.log("🌐 Fetching orders from backend");
    const resp = await fetchWithAuth('http://localhost:3000/api/orders').catch(() => null);
    if (resp && resp.ok) {
        const data = await resp.json().catch(() => []);
        orders = Array.isArray(data) ? data : (data.data || []);
    }
    cacheTimestamps.orders = Date.now();
    console.log("✅ Orders loaded:", orders.length);
}

async function loadProducts() {
    console.log("🌐 Fetching products from backend");
    loadingState.products = true;
    try {
        const raw = await fetchWithAuth("http://localhost:3000/api/products")
            .then(r => r.json()).catch(() => []);
        const fetched = Array.isArray(raw) ? raw : (raw?.data || []);

        // Enrich products with supplier names
        if (!Array.isArray(suppliers) || suppliers.length === 0) {
            await loadSuppliers();
        }

        products = fetched.map(p => {
            const supplier = Array.isArray(suppliers) ? suppliers.find(s => Number(s.id) === Number(p.supplier_id)) : null;
            // fallback: try to find by name in case older records stored supplier differently
            const supplierName = supplier ? supplier.name : (p.supplier_name || null);
            return { ...p, supplier_name: supplierName };
        });

        // expose for legacy global cart module
        window.products = products;
        // allProducts contains only available products for POS filtering
        allProducts = products.filter(p => Number(p.available) === 1);
        cacheTimestamps.products = Date.now();
        console.log("✅ Products loaded:", products);
    } catch (err) {
        console.error('loadProducts failed', err);
        products = products || [];
    } finally {
        loadingState.products = false;
        try { render(); } catch (e) { /* swallow render errors */ }
    }
}

async function loadLowStock() {
    console.log("🌐 Loading low stock items");
    lowStockItems = await fetchWithAuth("http://localhost:3000/api/inventory/low-stock")
        .then(r => r.json()).catch(() => []);
    cacheTimestamps.lowStock = Date.now();
    console.log("⚠️ Low stock items:", lowStockItems);
}

async function loadInventoryReport() {
    console.log("🌐 Loading inventory report");
    inventoryReport = await fetchWithAuth(
        "http://localhost:3000/api/reports/inventory"
    ).then(r => r.json()).catch(() => ({}));

    inventoryList = await fetchWithAuth(
        "http://localhost:3000/api/reports/inventory/list"
    ).then(r => r.json()).catch(() => ([]));

    cacheTimestamps.inventory = Date.now();
    console.log("📊 Inventory report data:", inventoryReport, inventoryList);
}

async function loadSuppliers() {
    console.log("🚚 Loading suppliers");
    try {
        const response = await fetch("http://localhost:3000/api/suppliers", {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        if (response.ok) {
            suppliers = await response.json();
        } else {
            console.warn("Suppliers access denied:", response.status);
            suppliers = [];
        }
    } catch (err) {
        console.error("loadSuppliers failed:", err);
        suppliers = [];
    }
    cacheTimestamps.suppliers = Date.now();
    console.log("🚚 Suppliers loaded:", suppliers);
}

async function loadDiscounts() {
    console.log("🏷️ Loading discounts");
    try {
        const response = await fetchWithAuth('http://localhost:3000/api/discounts');
        if (response.ok) {
            discounts = await response.json();
        } else {
            console.warn("Discounts access denied:", response.status);
            discounts = [];
        }
    } catch (err) {
        console.error("loadDiscounts failed:", err);
        discounts = [];
    }
    console.log("🏷️ Discounts loaded:", discounts);
    // If the discounts page table is in the DOM, render into it
    const tbody = document.getElementById('discountsTableBody');
    if (tbody) {
        tbody.innerHTML = discounts.map(d => `
            <tr>
                <td>${d.id}</td>
                <td>${d.code}</td>
                <td>${d.type}</td>
                <td>${d.type === 'percentage' ? d.value + '%' : '₹' + d.value}</td>
                <td>${d.active ? 'Yes' : 'No'}</td>
                <td>
                    <button onclick="editDiscount(${d.id})" class="btn small">Edit</button>
                    <button onclick="deleteDiscount(${d.id})" class="btn small danger">Delete</button>
                </td>
            </tr>
        `).join('');
    }
}

async function loadDashboard() {
    console.log("🌐 Loading dashboard data");
    try {
        const [stock, recent] = await Promise.all([
            fetchWithAuth('http://localhost:3000/api/dashboard/stock').then(r => r.json()).catch(() => ({})),
            fetchWithAuth('http://localhost:3000/api/dashboard/recent-orders').then(r => r.json()).catch(() => ([]))
        ]);

        dashboard.stock = stock || {};
        dashboard.recentOrders = recent || [];

        // load sales series for selected range
        await loadSalesRange();

        cacheTimestamps.dashboard = Date.now();
        console.log("✅ Dashboard data loaded", dashboard, { salesSeries });
    } catch (err) {
        console.error('loadDashboard failed', err);
    }
}

async function loadSalesRange() {
    console.log("🌐 Loading sales range:", salesRange);

    salesSeries = await fetchWithAuth(
        `http://localhost:3000/api/dashboard/sales-range?range=${salesRange}`
    ).then(r => r.json()).catch(() => ([]));

    console.log("📈 Sales series:", salesSeries);
}

async function changeRange(range) {
    salesRange = range;
    await loadSalesRange();
    render();
}

async function loadReports() {
    console.log("🌐 Fetching reports");
    loadingState.reports = true;
    try {
        dailySales = await fetchWithAuth("http://localhost:3000/api/reports/daily-sales")
            .then(r => r.json()).catch(() => []);
        cacheTimestamps.reports = Date.now();
        console.log("📊 Reports loaded:", dailySales);

        // Ensure product & supplier data is available for inventory summary
        const now = Date.now();
        if (!products || products.length === 0 || now - cacheTimestamps.products > CACHE_DURATION) {
            await loadProducts();
        }
        if (!suppliers || suppliers.length === 0 || now - cacheTimestamps.suppliers > CACHE_DURATION) {
            await loadSuppliers();
        }

        // Load inventory summary and detailed list used by the reports page
        await loadInventoryReport();
    } catch (err) {
        console.error('loadReports failed', err);
        dailySales = dailySales || [];
    } finally {
        loadingState.reports = false;
        try { render(); } catch (e) { }
    }
}

/* ======================
   ROUTER
====================== */

function renderPage() {
    try {
        if (currentPage === "pos") {
            if (!hasPerm('pos')) return ACCESS_DENIED_HTML;
            return typeof renderPOS === 'function' ? renderPOS() : "";
        }
        if (currentPage === "products") {
            if (!hasPerm('products')) return ACCESS_DENIED_HTML;
            const html = typeof renderProducts === 'function' ? renderProducts() : "";
            if (typeof setupImageUpload === 'function') setTimeout(setupImageUpload, 0);
            return html;
        }
        if (currentPage === "suppliers") {
            if (!hasPerm('suppliers')) return ACCESS_DENIED_HTML;
            return typeof renderSuppliers === 'function' ? renderSuppliers() : "";
        }
        if (currentPage === "orders") {
            if (!hasPerm('orders')) return ACCESS_DENIED_HTML;
            return typeof renderOrders === 'function' ? renderOrders() : "";
        }
        if (currentPage === "reports") {
            if (!hasPerm('reports')) return ACCESS_DENIED_HTML;
            return typeof renderReports === 'function' ? renderReports() : "";
        }
        if (currentPage === "dashboard") {
            if (!hasPerm('dashboard')) return ACCESS_DENIED_HTML;
            return typeof renderDashboard === 'function' ? renderDashboard() : "";
        }
        if (currentPage === "discounts") {
            if (!hasPerm('discounts')) return ACCESS_DENIED_HTML;
            return typeof renderDiscounts === 'function' ? renderDiscounts() : "";
        }
        if (currentPage === "users") {
            if (!hasPerm('users')) return ACCESS_DENIED_HTML;
            return typeof renderUsers === 'function' ? renderUsers() : "";
        }
        if (currentPage === "multistore") {
            if (!planHasFeature('multistore')) return renderLockedPage('multistore');
            return typeof renderMultiStore === 'function' ? renderMultiStore() : "";
        }
        if (currentPage === "analytics") {
            if (!planHasFeature('advancedAnalytics')) return renderLockedPage('analytics');
            return typeof renderAdvancedAnalytics === 'function' ? renderAdvancedAnalytics() : "";
        }
        return "";
    } catch (err) {
        console.error('renderPage error for', currentPage, err);
        showToast('Failed to render page: ' + (err && err.message ? err.message : 'unknown'), 'error');
        return "";
    }
}

/* ======================
   POS TERMINAL (clean final)
====================== */
function renderPOS() {
    return `
<section id="pos-page" class="page active">

  <div class="pos-layout">

    <!-- Categories -->
    <aside class="pos-categories">
      <h3>Categories</h3>
      <button class="cat ${selectedCategory === 'All' ? 'active' : ''}" onclick="filterCategory('All')">All</button>
      ${getUniqueCategories().map(cat => `<button class="cat ${selectedCategory === cat ? 'active' : ''}" onclick="filterCategory('${cat.replace(/'/g, "\\'")}')">  ${cat}</button>`).join('')}
    </aside>

    <!-- Products -->
    <main class="pos-products">
      <div class="products-header">
        <h3>Products</h3>
        <div class="view-toggle">
          <button class="view-btn ${productViewMode === 'normal' ? 'active' : ''}" onclick="setProductView('normal')">Normal</button>
          <button class="view-btn ${productViewMode === 'compact' ? 'active' : ''}" onclick="setProductView('compact')">Compact</button>
        </div>
      </div>
      <div class="product-grid ${productViewMode}" id="productGrid">
        <!-- Product cards injected by JS -->
      </div>
    </main>

    <!-- Cart - Made Hero -->
    <aside class="pos-cart pos-cart-hero">
      <div class="cart-header">
        <h3>🛒 Cart</h3>
        <div class="cart-badge" id="cartBadge">0</div>
      </div>

      <div id="cartItems" class="cart-items">
        <p class="empty">No items yet</p>
      </div>

      <div class="cart-summary">
        <div class="row subtotal">
          <span>Subtotal</span>
          <strong id="subtotal" class="subtotal-amount">₹0</strong>
        </div>

        <div class="row discount">
          <input type="text" id="discountCode" placeholder="Discount Code" style="flex: 1; margin-right: 10px;">
          <button onclick="applyDiscount()" class="btn small">Apply</button>
        </div>

        <div class="row discount-amount" id="discountRow" style="display: none;">
          <span>Discount</span>
          <strong id="discountAmount">-₹0</strong>
        </div>

        <div class="row total">
          <span>Total</span>
          <strong id="total" class="total-amount">₹0</strong>
        </div>

        <div class="payment-methods">
          <button class="pay active">Cash</button>
          <button class="pay">UPI</button>
          <button class="pay">Card</button>
        </div>

        <button id="completeSale" class="complete-btn" disabled>
          COMPLETE SALE
        </button>
      </div>
    </aside>

  </div>
</section>
    `;
}

let selectedCategory = 'All';
let productViewMode = 'normal'; // 'normal' or 'compact'

function filterCategory(cat) {
    selectedCategory = cat;
    // Update active state on category buttons
    document.querySelectorAll('.pos-categories .cat').forEach(btn => {
        btn.classList.toggle('active', btn.innerText.trim() === cat);
    });
    posRenderProducts();
}

function posRenderProducts() {
    const grid = document.getElementById('productGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const visible = (selectedCategory === 'All')
        ? allProducts
        : allProducts.filter(p => (p.category || '') === selectedCategory);

    visible.forEach(p => {
                const div = document.createElement('div');
        // Add stock status classes
        let stockClass = '';
        if (p.stock === 0) {
            stockClass = 'out-of-stock';
        } else if (p.stock <= (p.threshold || 5)) {
            stockClass = 'low-stock';
        } else {
            stockClass = 'in-stock';
        }

        div.className = `product-card ${productViewMode} ${stockClass}` + (p.stock === 0 ? ' unavailable' : '');

        if (productViewMode === 'compact') {
            // Compact mode: smaller, faster tapping
            let clickTimer;
            const handleClick = () => {
                if (p.stock > 0) {
                    // Check if item is already in cart
                    const cartArray = (window.getCart && window.getCart()) || [];
                    const existingItem = cartArray.find(item => Number(item.product_id) === Number(p.id));

                    if (existingItem) {
                        // Increment quantity if already in cart
                        if (window.changeQty) {
                            window.changeQty(p.id, 1);
                            renderCart();
                            showToast(`${p.name} quantity increased`, 'success');
                        }
                    } else {
                        // Add new item to cart
                        addToCart(p.id);
                    }
                }
            };

            const handleRightClick = (e) => {
                e.preventDefault();
                if (p.stock > 0) {
                    // Check if item is in cart and remove it
                    const cartArray = (window.getCart && window.getCart()) || [];
                    const existingItem = cartArray.find(item => Number(item.product_id) === Number(p.id));

                    if (existingItem && window.removeFromCart) {
                        window.removeFromCart(p.id);
                        renderCart();
                        showToast(`${p.name} removed from cart`, 'warning');
                    }
                }
            };

            const handleLongPress = () => {
                // Long press also removes item
                const cartArray = (window.getCart && window.getCart()) || [];
                const existingItem = cartArray.find(item => Number(item.product_id) === Number(p.id));

                if (existingItem) {
                    if (window.removeFromCart) {
                        window.removeFromCart(p.id);
                        renderCart();
                        showToast(`${p.name} removed from cart`, 'warning');
                    }
                }
            };

            div.onclick = handleClick;
            div.oncontextmenu = handleRightClick;

            // Long press for touch devices
            div.onmousedown = () => {
                clickTimer = setTimeout(handleLongPress, 500);
            };
            div.onmouseup = () => {
                clearTimeout(clickTimer);
            };
            div.onmouseleave = () => {
                clearTimeout(clickTimer);
            };

            div.innerHTML = `
                <div class="compact-content">
                    <span class="compact-name">${p.name}</span>
                    <span class="compact-price">₹${p.price}</span>
                </div>
            `;
        } else {
            // Normal mode: detailed cards
            let clickTimer;
            const handleClick = () => {
                if (p.stock > 0) {
                    // Check if item is already in cart
                    const cartArray = (window.getCart && window.getCart()) || [];
                    const existingItem = cartArray.find(item => Number(item.product_id) === Number(p.id));

                    if (existingItem) {
                        // Increment quantity if already in cart
                        if (window.changeQty) {
                            window.changeQty(p.id, 1);
                            renderCart();
                            showToast(`${p.name} quantity increased`, 'success');
                        }
                    } else {
                        // Add new item to cart
                        addToCart(p.id);
                    }
                }
            };

            const handleRightClick = (e) => {
                e.preventDefault();
                if (p.stock > 0) {
                    // Check if item is in cart and remove it
                    const cartArray = (window.getCart && window.getCart()) || [];
                    const existingItem = cartArray.find(item => Number(item.product_id) === Number(p.id));

                    if (existingItem && window.removeFromCart) {
                        window.removeFromCart(p.id);
                        renderCart();
                        showToast(`${p.name} removed from cart`, 'warning');
                    }
                }
            };

            const handleLongPress = () => {
                // Long press also removes item
                const cartArray = (window.getCart && window.getCart()) || [];
                const existingItem = cartArray.find(item => Number(item.product_id) === Number(p.id));

                if (existingItem) {
                    if (window.removeFromCart) {
                        window.removeFromCart(p.id);
                        renderCart();
                        showToast(`${p.name} removed from cart`, 'warning');
                    }
                }
            };

            div.onclick = handleClick;
            div.oncontextmenu = handleRightClick;

            // Long press for touch devices
            div.onmousedown = () => {
                clickTimer = setTimeout(handleLongPress, 500);
            };
            div.onmouseup = () => {
                clearTimeout(clickTimer);
            };
            div.onmouseleave = () => {
                clearTimeout(clickTimer);
            };

            div.innerHTML = `
                <h4>${p.name}</h4>
                <div class="price">₹${p.price}</div>
                <div class="stock">Stock: ${p.stock}</div>
                <button class="add-btn" onclick="event.stopPropagation(); if(${p.stock}>0) addToCart(${p.id})" ${p.stock===0? 'disabled':''}>Add</button>
            `;
        }

        grid.appendChild(div);
    });

    // category buttons are wired inline via onclick in renderPOS()
    // update active state to match current selectedCategory
    document.querySelectorAll('.pos-categories .cat').forEach(btn => {
        btn.classList.toggle('active', btn.innerText.trim() === selectedCategory);
    });

    // wire payment buttons
    document.querySelectorAll('.pay').forEach(b => {
        b.onclick = () => {
            document.querySelectorAll('.pay').forEach(x=>x.classList.remove('active'));
            b.classList.add('active');
            paymentMethod = b.innerText.toLowerCase();
        };
    });

    const complete = document.getElementById('completeSale');
    if (complete) complete.onclick = () => placeOrder();
}

function addToCart(id) {
    // wrapper that calls the cart module directly to avoid recursion
    if (window.Cart && typeof window.Cart.addToCart === 'function') {
        window.Cart.addToCart(id);
    } else if (typeof window.addToCart === 'function' && window.addToCart !== addToCart) {
        // fallback (ensure we don't call ourselves)
        window.addToCart(id);
    }
    renderCart();
}

function renderCart() {
    const container = document.getElementById('cartItems');
    if (!container) return;
    container.innerHTML = '';
    const cartArray = (window.getCart && window.getCart()) || [];
    if (cartArray.length === 0) {
        container.innerHTML = '<p class="empty">No items yet</p>';
    }

    let total = 0;
    cartArray.forEach(item => {
        total += (item.line_total || (item.price * item.quantity || 0));

        const row = document.createElement('div');
        row.className = 'cart-item';
        row.innerHTML = `
          <span class="cart-item-name">${item.name}</span>
          <div class="qty">
            <button onclick="updateQty(${item.product_id}, -1)">-</button>
            <span>${item.quantity}</span>
            <button onclick="updateQty(${item.product_id}, 1)">+</button>
            <button class="remove-btn" onclick="removeFromCart(${item.product_id})" title="Remove">×</button>
          </div>
        `;
        container.appendChild(row);
    });

    const sub = document.getElementById('subtotal');
    if (sub) {
        const oldTotal = parseFloat(sub.innerText.replace('₹', '')) || 0;
        const newTotal = Number(total).toFixed(2);

        if (oldTotal !== parseFloat(newTotal)) {
            sub.classList.add('subtotal-changed');
            setTimeout(() => sub.classList.remove('subtotal-changed'), 300);
        }

        sub.innerText = `₹${newTotal}`;
    }

    // Handle discount
    const discount = window.getDiscount ? window.getDiscount() : { code: '', amount: 0 };
    const discountInput = document.getElementById('discountCode');
    if (discountInput && discount.code) {
        discountInput.value = discount.code;
    }

    const discountRow = document.getElementById('discountRow');
    const discountAmountEl = document.getElementById('discountAmount');
    if (discount.amount > 0) {
        discountRow.style.display = 'flex';
        discountAmountEl.innerText = `-₹${discount.amount.toFixed(2)}`;
    } else {
        discountRow.style.display = 'none';
    }

    const finalTotal = total - discount.amount;
    const totalEl = document.getElementById('total');
    if (totalEl) {
        totalEl.innerText = `₹${finalTotal.toFixed(2)}`;
    }

    // Update cart badge
    const badge = document.getElementById('cartBadge');
    if (badge) {
        const itemCount = cartArray.reduce((sum, item) => sum + item.quantity, 0);
        badge.innerText = itemCount;
        badge.style.display = itemCount > 0 ? 'block' : 'none';
    }

    // Update complete sale button state
    const completeBtn = document.getElementById('completeSale');
    if (completeBtn) {
        completeBtn.disabled = cartArray.length === 0;
        completeBtn.style.opacity = cartArray.length === 0 ? '0.5' : '1';
    }
}

async function applyDiscount() {
    const code = document.getElementById('discountCode').value.trim();
    if (!code) {
        showToast('Enter a discount code', 'warning');
        return;
    }

    try {
        const response = await fetchWithAuth('http://localhost:3000/api/discounts/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await response.json();
        if (response.ok) {
            const subtotal = window.getCartTotal ? window.getCartTotal() : 0;
            let discountAmount = 0;
            if (data.type === 'percentage') {
                discountAmount = subtotal * (data.value / 100);
            } else if (data.type === 'fixed') {
                discountAmount = data.value;
            }
            discountAmount = Math.min(discountAmount, subtotal);
            if (window.setDiscount) window.setDiscount(code, discountAmount);
            renderCart();
            showToast(`Discount applied: -₹${discountAmount.toFixed(2)}`, 'success');
        } else {
            showToast(data.error || 'Invalid discount code', 'error');
        }
    } catch (error) {
        console.error('Discount validation failed:', error);
        showToast('Failed to apply discount', 'error');
    }
}

function updateQty(id, change) {
    if (window.changeQty) window.changeQty(id, change);
    renderCart();
}

function setProductView(mode) {
    productViewMode = mode;
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.innerText.toLowerCase() === mode);
    });
    posRenderProducts();
}

// Hardened placeOrder: validate and log payload, handle response
async function placeOrder() {
    const cartItems = (window.getCart && window.getCart()) || [];

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
        showToast("Cart is empty", "warning");
        return;
    }

    const discount = window.getDiscount ? window.getDiscount() : { code: '', amount: 0 };

    const payload = {
        items: cartItems.map(i => ({
            product_id: Number(i.product_id),
            name: String(i.name),
            price: Number(i.price),
            quantity: Number(i.quantity),
            line_total: Number(i.line_total ?? (i.price * i.quantity))
        })),
        payment_mode: paymentMethod || 'cash',
        discount_code: discount.code || undefined
    };

    console.log("📤 Sending order payload:", payload);

    try {
        const res = await fetchWithAuth("http://localhost:3000/api/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (!res.ok) {
            console.error("❌ Order failed:", data);
            showToast(data.error || "Order failed", "error");
            return;
        }

        console.log("✅ Order placed:", data);
        showToast(`Order #${data.order_id} completed successfully!`, "success");

        if (window.clearCart) window.clearCart();
        await loadProducts();
        await loadOrders();
        render();
    } catch (error) {
        console.error("❌ Order error:", error);
        showToast("Network error - please try again", "error");
    }
}

/* ======================
   PRODUCTS TERMINAL
====================== */
function renderProducts() {
    if (loadingState.products && (!products || products.length === 0)) {
        return `
        <div class="header"><h2>Products</h2></div>
        <div class="panel">
            <p>Loading products, please wait...</p>
        </div>
        `;
    }

    // Ensure suppliers is an array
    if (!Array.isArray(suppliers)) suppliers = [];

    const selected = products.find(p => p.id === selectedProductId);

    return `
        <div class="header"><h2>Products</h2></div>

        <div class="panel add-product-card">
            <h3>${selected ? "Edit Product" : "Add Product"}</h3>
            <div class="form-section">
                <div class="form-grid">
                    <div class="form-group image-group">
                        <label>Product Image</label>
                        <div class="image-upload-container">
                            <div class="image-preview" id="imagePreview">
                                ${selected?.image ? `<img src="${selected.image}" alt="Product image">` : '<div class="no-image">📷</div>'}
                            </div>
                            <input type="file" id="productImage" accept="image/*" style="display: none;">
                            <button type="button" class="btn secondary" onclick="document.getElementById('productImage').click()">
                                ${selected?.image ? 'Change Image' : 'Upload Image'}
                            </button>
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="name">Product Name</label>
                        <input id="name" placeholder="Enter product name" value="${selected?.name || ""}">
                    </div>
                    <div class="form-group">
                        <label for="price">Price (₹)</label>
                        <input id="price" type="number" step="0.01" placeholder="0.00" value="${selected?.price || ""}">
                    </div>
                    <div class="form-group">
                        <label for="productCategory">Category</label>
                        <div class="category-input-group">
                            <select id="productCategory">
                                <option value="">Select Category</option>
                                ${getUniqueCategories().map(cat => `<option value="${cat}" ${selected?.category===cat?'selected':''}>${cat}</option>`).join('')}
                            </select>
                            <input type="text" id="newCategory" placeholder="Or add new category" style="display: none;">
                            <button type="button" class="btn small" onclick="toggleNewCategory()">+</button>
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="stock">Stock Quantity</label>
                        <input id="stock" type="number" placeholder="0" value="${selected?.stock || ""}">
                    </div>
                    <div class="form-group">
                        <label for="threshold">Low Stock Threshold</label>
                        <input id="threshold" type="number" placeholder="5" value="${selected?.threshold || 5}">
                    </div>
                    <div class="form-group">
                        <label for="supplier">Supplier</label>
                        <select id="supplier">
                            <option value="">Select Supplier</option>
                            ${suppliers.map(s => `<option value="${s.id}" ${selected?.supplier_id == s.id ? 'selected' : ''}>${s.name}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="form-actions">
                    <button class="btn primary" onclick="${selected ? "updateProduct()" : "addProduct()"}">
                        ${selected ? "Update Product" : "Add Product"}
                    </button>
                    ${selected ? `<button class="btn secondary" onclick="cancelEdit()">Cancel</button>` : ""}
                </div>
            </div>
        </div>

        <div class="panel">
            ${products.length === 0 ? `
                <div class="empty-state">
                    <div class="empty-icon">📦</div>
                    <h3>No products yet</h3>
                    <p>Start by adding your first product to begin selling</p>
                    <button class="btn primary" onclick="document.querySelector('.add-product-card .btn').click()">Add Your First Product</button>
                </div>
            ` : `
                <div class="products-controls">
                    <div class="search-group">
                        <input type="text" id="productSearch" placeholder="Search products..." oninput="filterProducts()">
                        <select id="categoryFilter" onchange="filterProducts()">
                            <option value="">All Categories</option>
                            ${getUniqueCategories().map(cat => `<option value="${cat}">${cat}</option>`).join('')}
                        </select>
                    </div>
                    <div class="bulk-actions">
                        <button class="btn secondary" onclick="exportProducts()">Export CSV</button>
                        <label class="btn secondary file-input">
                            Import CSV
                            <input type="file" accept=".csv" onchange="importProducts(this)" style="display: none;">
                        </label>
                    </div>
                </div>
                <table class="products-table">
                    <thead>
                        <tr><th>Image</th><th>Name</th><th>Price</th><th>Category</th><th>Stock</th><th>Supplier</th><th>Availability</th><th>Actions</th></tr>
                    </thead>
                    <tbody id="productsTableBody">
                        ${products.map(p => `
                                                        <tr data-product-id="${p.id}" data-category="${p.category || ''}" data-name="${p.name.toLowerCase()}">
                                                                <td class="product-image-cell">
                                                                    ${p.image ? `<img src="${p.image}" alt="${p.name}">` : '<div class="no-image-small">📷</div>'}
                                                                </td>
                                                                <td><strong>${p.name}</strong></td>
                                                                <td>₹${p.price}</td>
                                                                <td><span class="category-badge">${p.category || 'Uncategorized'}</span></td>
                                                                <td>${p.stock}</td>
                                                                <td>${p.supplier_name || '-'}</td>

                                                                <td>
                                                                    <label class="switch">
                                                                        <input type="checkbox" ${p.available === 1 ? "checked" : ""} ${p.stock <= 0 ? "disabled" : ""} onchange="toggleAvailability(${p.id}, this.checked)">
                                                                        <span class="slider"></span>
                                                                    </label>
                                                                </td>

                                                                <td class="actions">
                                                                        <button class="btn secondary" onclick="selectProduct(${p.id})">Edit</button>
                                                                        <button class="btn small" onclick="restockProduct(${p.id})" title="Restock">📦</button>
                                                                        <button class="btn danger" onclick="deleteProduct(${p.id})">Delete</button>
                                                                </td>
                                                        </tr>
                        `).join("")}
                    </tbody>
                </table>
            `}
        </div>

        <div class="panel">
            <h3>Low Stock Alerts</h3>

            ${lowStockItems.length === 0 ? `
                <p>No low stock items 🎉</p>
            ` : `
                <table>
                    <thead>
                        <tr>
                            <th>Product</th>
                            <th>Stock</th>
                            <th>Threshold</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${lowStockItems.map(p => `
                            <tr style="color:red">
                                <td>${p.name}</td>
                                <td>${p.stock}</td>
                                <td>${p.threshold}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            `}
        </div>
    `;
}

function renderDashboard() {
    const totalOrders  = salesSeries.reduce((t, d) => t + (d.orders  || 0), 0);
    const totalRevenue = salesSeries.reduce((t, d) => t + (d.revenue || 0), 0);
    const planCfg      = getPlanConfig();
    const planKey      = getPlanKey();

    // ── Plan banner ────────────────────────────────────────────────────────────
    const planBanner = `
        <div class="plan-banner plan-banner-${planKey}" style="
            background:${planCfg.color}18;
            border:1px solid ${planCfg.color}35;
            border-radius:10px; padding:10px 16px; margin-bottom:16px;
            display:flex; align-items:center; justify-content:space-between; gap:12px;">
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:22px;">${planCfg.icon}</span>
                <div>
                    <div style="font-size:13px;font-weight:700;color:${planCfg.color};">${planCfg.label} Plan</div>
                    <div style="font-size:11px;color:#64748b;">${planCfg.type}${licenseInfo && licenseInfo.maxDevices && licenseInfo.maxDevices !== 'Unlimited' ? ' &mdash; up to ' + licenseInfo.maxDevices + ' device' + (Number(licenseInfo.maxDevices) !== 1 ? 's' : '') : (licenseInfo && licenseInfo.maxDevices === 'Unlimited' ? ' &mdash; Unlimited devices' : '')}</div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
                ${trialInfo && trialInfo.active ? `<span style="font-size:11px;color:#f59e0b;background:#f59e0b18;border:1px solid #f59e0b35;border-radius:4px;padding:3px 10px;font-weight:700;">${trialInfo.daysLeft} day${trialInfo.daysLeft !== 1 ? 's' : ''} left</span>` : ''}
                ${planKey === 'starter' || planKey === 'trial' ? `<button onclick="showUpgradePrompt('general')" style="padding:4px 12px;background:${planCfg.color}22;color:${planCfg.color};border:1px solid ${planCfg.color}50;border-radius:5px;cursor:pointer;font-size:11px;font-weight:700;">Upgrade</button>` : ''}
            </div>
        </div>`;

    // ── Multi-Store section ────────────────────────────────────────────────────
    const multiStoreSection = planHasFeature('multistore') ? `
        <div class="panel" style="margin-top:16px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <h4 style="margin:0;font-size:14px;font-weight:700;color:#e2e8f0;">🏬 Multi-Store Overview</h4>
                <button onclick="go('multistore')" style="padding:4px 12px;background:#38bdf822;color:#38bdf8;border:1px solid #38bdf840;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;">Manage Stores →</button>
            </div>
            <p style="color:#64748b;font-size:12px;margin:0;">Connect and monitor all your store locations from one place. View sales, stock levels, and performance across branches.</p>
        </div>` : `
        <div class="locked-feature-card" style="background:rgba(99,102,241,0.05);border:1px dashed rgba(99,102,241,0.35);border-radius:10px;padding:18px;margin-top:16px;text-align:center;">
            <div style="font-size:26px;margin-bottom:6px;">🏬</div>
            <div style="font-size:13px;font-weight:700;color:#818cf8;margin-bottom:4px;">Multi-Store Management</div>
            <div style="font-size:12px;color:#64748b;margin-bottom:12px;">Manage multiple locations, compare branch performance, and centralize inventory control.</div>
            <button onclick="showUpgradePrompt('multistore')" style="padding:6px 18px;background:rgba(99,102,241,0.15);color:#818cf8;border:1px solid rgba(99,102,241,0.45);border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Unlock with Business Plan →</button>
        </div>`;

    // ── Advanced Analytics section ─────────────────────────────────────────────
    const analyticsSection = planHasFeature('advancedAnalytics') ? `
        <div class="panel" style="margin-top:16px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <h4 style="margin:0;font-size:14px;font-weight:700;color:#e2e8f0;">📊 Advanced Analytics</h4>
                <button onclick="go('analytics')" style="padding:4px 12px;background:#34d39922;color:#34d399;border:1px solid #34d39940;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;">Open Analytics →</button>
            </div>
            <p style="color:#64748b;font-size:12px;margin:0;">Deep-dive into cohort analysis, customer lifetime value, predictive stock forecasting, and enterprise-grade BI dashboards.</p>
        </div>` : `
        <div class="locked-feature-card" style="background:rgba(16,185,129,0.04);border:1px dashed rgba(16,185,129,0.3);border-radius:10px;padding:18px;margin-top:16px;text-align:center;">
            <div style="font-size:26px;margin-bottom:6px;">📊</div>
            <div style="font-size:13px;font-weight:700;color:#34d399;margin-bottom:4px;">Advanced Analytics</div>
            <div style="font-size:12px;color:#64748b;margin-bottom:12px;">Cohort analysis, customer LTV, predictive stock forecasts, and multi-dimensional BI reports for enterprise teams.</div>
            <button onclick="showUpgradePrompt('analytics')" style="padding:6px 18px;background:rgba(16,185,129,0.12);color:#34d399;border:1px solid rgba(16,185,129,0.4);border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Unlock with Enterprise Plan →</button>
        </div>`;

    return `
        ${getCloudSyncBanner()}
        ${planBanner}
        <div class="panel" style="margin-bottom:16px;">
            <strong style="font-size:13px;color:#64748b;letter-spacing:0.3px;">DATE RANGE</strong>
            <button class="btn secondary" onclick="changeRange('today')" style="${salesRange==='today'?'background:var(--primary);color:#fff;':''}">Today</button>
            <button class="btn secondary" onclick="changeRange('7d')"   style="${salesRange==='7d'  ?'background:var(--primary);color:#fff;':''}">7 Days</button>
            <button class="btn secondary" onclick="changeRange('30d')"  style="${salesRange==='30d' ?'background:var(--primary);color:#fff;':''}">30 Days</button>
        </div>

        <div class="kpi-grid">
            <div class="kpi blue">
                <div class="kpi-number">${totalOrders}</div>
                <div class="kpi-label">Total Orders</div>
                <div class="kpi-helper">Last 7 days</div>
            </div>
            <div class="kpi green">
                <div class="kpi-number">₹${totalRevenue}</div>
                <div class="kpi-label">Total Revenue</div>
                <div class="kpi-helper">Last 7 days</div>
            </div>
            <div class="kpi orange">
                <div class="kpi-number">${dashboard.stock.low_stock || 0}</div>
                <div class="kpi-label">Low Stock Items</div>
                <div class="kpi-helper">Need attention</div>
            </div>
        </div>

        <div class="sales-trend-card">
            <h4>Sales Trend</h4>
            <div class="trend-chart-container">
                <canvas id="salesChart" height="60"></canvas>
            </div>
            <div class="trend-stats">
                <div class="trend-stat">
                    <span class="stat-label">Today</span>
                    <span class="stat-value">₹${salesSeries.length > 0 ? salesSeries[salesSeries.length - 1]?.revenue || 0 : 0}</span>
                </div>
                <div class="trend-stat">
                    <span class="stat-label">Avg/Day</span>
                    <span class="stat-value">₹${salesSeries.length > 0 ? Math.round(totalRevenue / salesSeries.length) : 0}</span>
                </div>
            </div>
        </div>

        ${multiStoreSection}
        ${analyticsSection}
    `;
}

/* ======================
   MULTI-STORE PAGE  (Business / Enterprise)
====================== */
function renderMultiStore() {
    const planCfg = getPlanConfig();
    return `
        <section class="page">
            <div class="content" style="padding:1.5rem;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
                    <div>
                        <h2 style="font-size:20px;font-weight:700;color:#e2e8f0;margin-bottom:4px;">🏬 Multi-Store Management</h2>
                        <p style="font-size:12px;color:#64748b;">Licensed for up to ${planCfg.maxLocations ? planCfg.maxLocations + ' location' + (planCfg.maxLocations !== 1 ? 's' : '') : 'unlimited locations'} on the <span style="color:${planCfg.color};font-weight:700;">${planCfg.label}</span> plan.</p>
                    </div>
                    <span style="background:${planCfg.color}20;color:${planCfg.color};border:1px solid ${planCfg.color}40;border-radius:6px;font-size:11px;font-weight:700;padding:4px 12px;text-transform:uppercase;letter-spacing:0.5px;">${planCfg.badge || planCfg.label}</span>
                </div>

                <!-- Placeholder: connect this to a multi-store API when available -->
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-bottom:24px;">
                    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:18px;">
                        <div style="font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:4px;">Main Branch</div>
                        <div style="font-size:20px;font-weight:800;color:#e2e8f0;margin-bottom:2px;">This Device</div>
                        <div style="font-size:11px;color:#64748b;">Active &mdash; local data</div>
                    </div>
                    <div style="background:#0f172a;border:1px dashed #334155;border-radius:10px;padding:18px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;cursor:pointer;" onclick="showToast('Connect a remote branch via the server settings.','info')">
                        <div style="font-size:24px;color:#334155;">＋</div>
                        <div style="font-size:12px;color:#475569;font-weight:600;">Add Branch Location</div>
                    </div>
                </div>

                <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:16px;">
                    <p style="font-size:12px;color:#64748b;line-height:1.6;">
                        To connect additional branch terminals, install Biznex BOS on each device and point them to the same database server.<br>
                        Each activated device uses one of your <strong style="color:#94a3b8;">${planCfg.maxLocations ? planCfg.maxLocations : 'unlimited'}</strong> licensed device seats.
                    </p>
                </div>
            </div>
        </section>`;
}

/* ======================
   ADVANCED ANALYTICS PAGE  (Enterprise)
====================== */
function renderAdvancedAnalytics() {
    const planCfg = getPlanConfig();
    return `
        <section class="page">
            <div class="content" style="padding:1.5rem;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
                    <div>
                        <h2 style="font-size:20px;font-weight:700;color:#e2e8f0;margin-bottom:4px;">📊 Analytics Pro</h2>
                        <p style="font-size:12px;color:#64748b;">Deep-dive intelligence for your <span style="color:${planCfg.color};font-weight:700;">${planCfg.label}</span> account.</p>
                    </div>
                    <span style="background:${planCfg.color}20;color:${planCfg.color};border:1px solid ${planCfg.color}40;border-radius:6px;font-size:11px;font-weight:700;padding:4px 12px;text-transform:uppercase;letter-spacing:0.5px;">ENTERPRISE</span>
                </div>

                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-bottom:20px;">
                    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;">
                        <div style="font-size:20px;margin-bottom:6px;">📈</div>
                        <div style="font-size:13px;font-weight:700;color:#e2e8f0;margin-bottom:3px;">Cohort Analysis</div>
                        <div style="font-size:11px;color:#64748b;">Understand how customer groups behave over time.</div>
                    </div>
                    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;">
                        <div style="font-size:20px;margin-bottom:6px;">💰</div>
                        <div style="font-size:13px;font-weight:700;color:#e2e8f0;margin-bottom:3px;">Customer LTV</div>
                        <div style="font-size:11px;color:#64748b;">Lifetime value predictions per customer segment.</div>
                    </div>
                    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;">
                        <div style="font-size:20px;margin-bottom:6px;">🔮</div>
                        <div style="font-size:13px;font-weight:700;color:#e2e8f0;margin-bottom:3px;">Stock Forecast</div>
                        <div style="font-size:11px;color:#64748b;">Predictive reorder points using sales velocity.</div>
                    </div>
                    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;">
                        <div style="font-size:20px;margin-bottom:6px;">🌐</div>
                        <div style="font-size:13px;font-weight:700;color:#e2e8f0;margin-bottom:3px;">Cross-Store BI</div>
                        <div style="font-size:11px;color:#64748b;">Aggregate metrics across all branch locations.</div>
                    </div>
                </div>

                <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:16px;">
                    <p style="font-size:12px;color:#64748b;line-height:1.6;">Advanced analytics dashboards are being rolled out progressively. Current data is reflected in the standard <strong style="color:#94a3b8;">Reports</strong> module. Check back for live enterprise BI features in upcoming updates.</p>
                </div>
            </div>
        </section>`;
}

/* ======================
   LOCKED PAGE  (shown when plan doesn't include a feature)
====================== */
function renderLockedPage(feature) {
    const meta = {
        multistore: { icon: '🏬', title: 'Multi-Store Management',  required: 'Business', color: '#38bdf8', upgrade: 'multistore' },
        analytics:  { icon: '📊', title: 'Analytics Pro',           required: 'Enterprise', color: '#34d399', upgrade: 'analytics' },
    };
    const m = meta[feature] || { icon: '🔒', title: 'Feature Locked', required: 'higher', color: '#818cf8', upgrade: 'general' };
    return `
        <section class="page">
            <div class="content" style="padding:3rem;text-align:center;">
                <div style="font-size:48px;margin-bottom:16px;">${m.icon}</div>
                <h2 style="font-size:22px;font-weight:700;color:#e2e8f0;margin-bottom:8px;">${m.title}</h2>
                <p style="color:#64748b;font-size:13px;margin-bottom:20px;max-width:380px;margin-left:auto;margin-right:auto;">
                    This feature requires the <strong style="color:${m.color};">${m.required}</strong> plan.<br>
                    Your current plan is <strong style="color:${getPlanConfig().color};">${getPlanConfig().label}</strong>.
                </p>
                <button onclick="showUpgradePrompt('${m.upgrade}')" style="padding:10px 24px;background:${m.color}22;color:${m.color};border:1px solid ${m.color}50;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;">Upgrade Plan →</button>
            </div>
        </section>`;
}

/* ======================
   UPGRADE PROMPT  (toast + redirect info)
====================== */
function showUpgradePrompt(feature) {
    const labels = {
        multistore: 'Business plan (BZNX-BIZ-...)',
        analytics:  'Enterprise plan (BZNX-ENT-...)',
        general:    'a higher plan',
    };
    const label = labels[feature] || labels.general;
    // Show a persistent action toast that also opens the portal
    const toastId = 'upgrade-toast-' + Date.now();
    const container = document.getElementById('toast-container') || document.body;
    const div = document.createElement('div');
    div.id = toastId;
    div.className = 'toast info';
    div.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-width:340px;';
    div.innerHTML = `
        <span>This feature requires ${label}.</span>
        <button onclick="openPortalForUpgrade();document.getElementById('${toastId}')?.remove()"
            style="align-self:flex-start;padding:5px 14px;background:#818cf8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">
            Manage Plan on Portal →
        </button>`;
    container.appendChild(div);
    setTimeout(() => div.remove(), 9000);
}

function openPortalForUpgrade() {
    if (window.APP_ACTIONS?.openPortal) {
        window.APP_ACTIONS.openPortal();
    } else {
        window.open('http://localhost:5000', '_blank');
    }
}

async function openAppSettings() {
    const startupEnabled = await window.APP_SETTINGS?.getStartup().catch(() => false);
    const overlay = document.createElement('div');
    overlay.id = 'appSettingsModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
        <div style="background:#1e1e2e;border:1px solid #313147;border-radius:12px;padding:28px 32px;min-width:320px;max-width:400px;color:#e2e8f0;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
                <h3 style="margin:0;font-size:16px;font-weight:700;">App Settings</h3>
                <button onclick="document.getElementById('appSettingsModal').remove()"
                    style="background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;line-height:1;">✕</button>
            </div>
            <label style="display:flex;align-items:center;gap:12px;cursor:pointer;padding:12px 0;border-top:1px solid #313147;">
                <input type="checkbox" id="startupToggle" ${startupEnabled ? 'checked' : ''}
                    onchange="setStartupEnabled(this.checked)"
                    style="width:18px;height:18px;cursor:pointer;accent-color:#818cf8;">
                <div>
                    <div style="font-size:14px;font-weight:600;">Launch on system startup</div>
                    <div style="font-size:12px;color:#94a3b8;margin-top:2px;">Open Biznex BOS automatically when you log in.</div>
                </div>
            </label>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

async function setStartupEnabled(enable) {
    try {
        await window.APP_SETTINGS?.setStartup(enable);
        showToast('Startup preference saved.', 'success', 2500);
    } catch (err) {
        showToast('Could not update startup setting.', 'error', 3000);
    }
}

// Removed legacy duplicate addProduct (kept later version with category)

function selectProduct(id) {
    selectedProductId = id;
    render();
}

async function updateProduct() {
    const p = products.find(x => x.id === selectedProductId);
    if (!p) return;

    let category = document.getElementById("productCategory").value;

    // Check if using new category
    const newCategoryInput = document.getElementById("newCategory");
    if (newCategoryInput.style.display !== 'none' && newCategoryInput.value.trim()) {
        category = newCategoryInput.value.trim();
    }

    const payload = {
        name: document.getElementById("name").value.trim(),
        price: Number(document.getElementById("price").value),
        stock: Number(document.getElementById("stock").value),
        threshold: Number(document.getElementById("threshold").value),
        category: category,
        supplier_id: document.getElementById("supplier").value ? parseInt(document.getElementById("supplier").value) : null,
        image: window.currentProductImage || p.image
    };

    const res = await fetchWithAuth(`http://localhost:3000/api/products/${selectedProductId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    }).catch(e => ({ ok: false, json: async () => ({ error: e.message }) }));

    const data = await res.json();
    if (!res.ok) {
        console.error("Update failed:", data);
        alert(data.error || "Update failed");
        return;
    }

    selectedProductId = null;
    window.currentProductImage = null;
    await loadProducts();
    await loadLowStock();
    render();
}

function cancelEdit() {
    selectedProductId = null;
    render();
}

// Helper function to get unique categories from products
function getUniqueCategories() {
    const categories = [...new Set(products.map(p => p.category).filter(c => c && c !== 'Uncategorized'))];
    categories.sort();
    return categories;
}

// Toggle new category input
function toggleNewCategory() {
    const select = document.getElementById('productCategory');
    const input = document.getElementById('newCategory');
    const button = event.target;

    if (input.style.display === 'none') {
        input.style.display = 'block';
        select.style.display = 'none';
        button.textContent = '✓';
        input.focus();
    } else {
        const newCat = input.value.trim();
        if (newCat) {
            select.innerHTML += `<option value="${newCat}" selected>${newCat}</option>`;
            select.value = newCat;
        }
        input.style.display = 'none';
        select.style.display = 'block';
        button.textContent = '+';
        input.value = '';
    }
}

// Handle image upload
function handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showToast('Please select an image file', 'error');
        return;
    }

    if (file.size > 2 * 1024 * 1024) { // 2MB limit
        showToast('Image size should be less than 2MB', 'error');
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        const imageData = e.target.result;
        document.getElementById('imagePreview').innerHTML = `<img src="${imageData}" alt="Product image">`;
        // Store the image data for saving
        window.currentProductImage = imageData;
    };
    reader.readAsDataURL(file);
}

// Setup image upload handler
function setupImageUpload() {
    const imageInput = document.getElementById('productImage');
    if (imageInput) {
        imageInput.addEventListener('change', handleImageUpload);
    }
}

// Filter products based on search and category
function filterProducts() {
    const searchTerm = document.getElementById('productSearch').value.toLowerCase();
    const categoryFilter = document.getElementById('categoryFilter').value;
    const tableBody = document.getElementById('productsTableBody');

    if (!tableBody) return;

    const rows = tableBody.querySelectorAll('tr');

    rows.forEach(row => {
        const productName = row.dataset.name || '';
        const productCategory = row.dataset.category || '';
        const matchesSearch = productName.includes(searchTerm);
        const matchesCategory = !categoryFilter || productCategory === categoryFilter;

        row.style.display = matchesSearch && matchesCategory ? '' : 'none';
    });
}

// Export products to CSV
function exportProducts() {
    const headers = ['Name', 'Price', 'Category', 'Stock', 'Threshold', 'Available'];
    const csvContent = [
        headers.join(','),
        ...products.map(p => [
            `"${p.name}"`,
            p.price,
            `"${p.category || ''}"`,
            p.stock,
            p.threshold || 5,
            p.available ? 'Yes' : 'No'
        ].join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `products_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);

    showToast('Products exported successfully', 'success');
}

// Import products from CSV
async function importProducts(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        const csv = e.target.result;
        const lines = csv.split('\n').filter(line => line.trim());

        if (lines.length < 2) {
            showToast('CSV file appears to be empty', 'error');
            return;
        }

        const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
        const expectedHeaders = ['Name', 'Price', 'Category', 'Stock', 'Threshold', 'Available'];

        // Check if headers match (case insensitive)
        const headersMatch = expectedHeaders.every(expected =>
            headers.some(header => header.toLowerCase() === expected.toLowerCase())
        );

        if (!headersMatch) {
            showToast('Invalid CSV format. Expected columns: Name, Price, Category, Stock, Threshold, Available', 'error');
            return;
        }

        let successCount = 0;
        let errorCount = 0;

        for (let i = 1; i < lines.length; i++) {
            try {
                const values = lines[i].split(',').map(v => v.replace(/"/g, '').trim());
                const product = {
                    name: values[0],
                    price: parseFloat(values[1]),
                    category: values[2] || 'Uncategorized',
                    stock: parseInt(values[3]) || 0,
                    threshold: parseInt(values[4]) || 5,
                    available: values[5].toLowerCase() === 'yes' ? 1 : 0
                };

                if (!product.name || isNaN(product.price)) {
                    errorCount++;
                    continue;
                }

                const res = await fetchWithAuth("http://localhost:3000/api/products", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(product)
                });

                if (res.ok) {
                    successCount++;
                } else {
                    errorCount++;
                }
            } catch (error) {
                errorCount++;
            }
        }

        if (successCount > 0) {
            await loadProducts();
            await loadLowStock();
            render();
            showToast(`Imported ${successCount} products successfully${errorCount > 0 ? `, ${errorCount} failed` : ''}`, 'success');
        } else {
            showToast('Failed to import any products', 'error');
        }
    };

    reader.readAsText(file);
    input.value = ''; // Reset file input
}

async function addProduct() {
    const name = document.getElementById("name").value.trim();
    const price = Number(document.getElementById("price").value);
    const stock = Number(document.getElementById("stock").value);
    const threshold = Number(document.getElementById("threshold").value);
    let category = document.getElementById("productCategory").value;

    // Check if using new category
    const newCategoryInput = document.getElementById("newCategory");
    if (newCategoryInput.style.display !== 'none' && newCategoryInput.value.trim()) {
        category = newCategoryInput.value.trim();
    }

    if (!name || isNaN(price) || isNaN(stock) || !category) {
        showToast("Name, price, stock, and category are required", "error");
        return;
    }

    if (price <= 0) {
        showToast("Price must be greater than 0", "error");
        return;
    }

    if (stock < 0) {
        showToast("Stock cannot be negative", "error");
        return;
    }

    try {
        const supplierId = document.getElementById("supplier").value;
        const productData = {
            name,
            price,
            stock,
            threshold,
            category,
            supplier_id: supplierId ? parseInt(supplierId) : null,
            image: window.currentProductImage || null
        };

        const res = await fetchWithAuth("http://localhost:3000/api/products", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(productData)
        });

        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || 'Failed to add product', "error");
            return;
        }

        showToast(`Product "${name}" added successfully`, "success");

        // Clear form
        document.getElementById("name").value = "";
        document.getElementById("price").value = "";
        document.getElementById("stock").value = "";
        document.getElementById("threshold").value = "5";
        document.getElementById("productCategory").value = "";
        document.getElementById("newCategory").value = "";
        document.getElementById("newCategory").style.display = "none";
        document.getElementById("productCategory").style.display = "block";
        document.getElementById("imagePreview").innerHTML = '<div class="no-image">📷</div>';
        event.target.previousElementSibling.textContent = '+';
        window.currentProductImage = null;

        await loadProducts();
        await loadLowStock();
        render();
    } catch (error) {
        showToast("Network error - please try again", "error");
    }
}

async function toggleAvailability(productId, isChecked) {
    const available = isChecked ? 1 : 0;

    console.log(`🔁 UI toggle → Product ${productId}: ${available}`);

    await fetchWithAuth(
        `http://localhost:3000/api/products/${productId}/availability`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ available })
        }
    ).catch(e => console.error('Toggle failed', e));

    // Reload products so POS + inventory stay in sync
    await loadProducts();
    render();
}

async function deleteProduct(id) {
    if (!confirm("Delete product?")) return;

    const res = await fetchWithAuth(`http://localhost:3000/api/products/${id}`, { method: "DELETE" })
        .catch(e => ({ ok: false, json: async () => ({ error: e.message }) }));

    const data = await res.json();
    if (!res.ok) {
        console.error("Delete failed:", data);
        alert(data.error || "Delete failed");
        return;
    }

    await loadProducts();
    await loadLowStock();
    render();
}

function restockProduct(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    const quantity = prompt(`Restock ${product.name} - Enter quantity to add:`, '10');
    if (!quantity || isNaN(quantity) || quantity <= 0) return;

    const supplierId = product.supplier_id || prompt('Select supplier ID (optional):');

    fetch(`http://localhost:3000/api/products/${productId}/restock`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('authToken')}`
        },
        body: JSON.stringify({ 
            quantity: parseInt(quantity),
            supplier_id: supplierId ? parseInt(supplierId) : null
        })
    })
    .then(r => r.json())
    .then(result => {
        if (result.error) {
            showToast(result.error, 'error');
        } else {
            showToast('Product restocked successfully', 'success');
            loadProducts();
            loadLowStock();
            render();
        }
    })
    .catch(error => {
        console.error('Restock error:', error);
        showToast('Failed to restock product', 'error');
    });
}

/* ======================
   ORDERS TERMINAL
====================== */
function renderOrders() {
    return `
        <div class="header">
            <h2>Orders</h2>
        </div>

        <div class="panel orders-panel">
            ${orders.length === 0 ? `
                <div class="empty-state">
                    <div class="empty-icon">📋</div>
                    <h3>No orders yet</h3>
                    <p>Orders will appear here once customers start purchasing</p>
                    <button class="btn primary" onclick="go('pos')">Go to POS</button>
                </div>
            ` : `
                <table class="orders-table">
                    <thead>
                        <tr>
                            <th>Order ID</th>
                            <th>Items</th>
                            <th>Total</th>
                            <th>Date & Time</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${orders.map(o => {
                            const date = new Date(o.created_at);
                            const timeAgo = getTimeAgo(date);
                            return `
                            <tr class="order-row" onclick="openOrderDetails(${o.id})" style="cursor: pointer;">
                                <td><strong>#${o.id}</strong></td>
                                <td class="order-items">${o.items || "-"}</td>
                                <td><strong>₹${o.total}</strong></td>
                                <td>
                                    <div class="order-date">${date.toLocaleDateString()}</div>
                                    <div class="order-time">${timeAgo}</div>
                                    <div class="order-full-time" title="${date.toLocaleString()}">${date.toLocaleTimeString()}</div>
                                </td>
                                <td class="order-actions">
                                    <button class="btn secondary" onclick="event.stopPropagation(); openOrderDetails(${o.id})">View Details</button>
                                    <button class="btn primary" onclick="event.stopPropagation(); printBill(${o.id})">View Bill</button>
                                </td>
                            </tr>
                            `;
                        }).join("")}
                    </tbody>
                </table>
            `}
        </div>
    `;
}

/* ======================
   REPORTS TERMINAL
====================== */
function renderReports() {
    const now = new Date();
    const reportDate = now.toLocaleDateString();
    const reportTime = now.toLocaleTimeString();
    if (loadingState.reports && (!dailySales || dailySales.length === 0)) {
        return `
        ${getCloudSyncBanner()}
        <div class="header">
            <h2>Reports</h2>
            <div class="report-timestamp">Loading…</div>
        </div>
        <div class="panel">
            <p>Loading reports, please wait...</p>
        </div>
        `;
    }

    // Ensure suppliers is an array
    if (!Array.isArray(suppliers)) suppliers = [];

    return `
        ${getCloudSyncBanner()}
        <div class="header">
            <h2>Reports</h2>
            <div class="report-timestamp">Generated on ${reportDate} at ${reportTime}</div>
        </div>

        <div class="reports-section">
            <h3>Sales Reports</h3>
            ${dailySales.length === 0 ? `
                <p>No sales data available</p>
            ` : `
                <div class="report-summary">
                    <div class="summary-card">
                        <div class="summary-value">${dailySales.reduce((sum, r) => sum + r.orders, 0)}</div>
                        <div class="summary-label">Total Orders</div>
                    </div>
                    <div class="summary-card">
                        <div class="summary-value">₹${dailySales.reduce((sum, r) => sum + r.revenue, 0)}</div>
                        <div class="summary-label">Total Revenue</div>
                    </div>
                </div>

                <div class="report-details">
                    <table class="reports-table">
                        <thead>
                            <tr><th>Date</th><th>Orders</th><th>Revenue</th></tr>
                        </thead>
                        <tbody>
                            ${dailySales.map(r => `
                                <tr>
                                    <td>${r.day}</td>
                                    <td>${r.orders}</td>
                                    <td>₹${r.revenue}</td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
                </div>
            `}
        </div>

        <!-- Inventory Reports -->
        <div class="reports-section">
            <h3>Inventory Reports</h3>

            <div class="report-summary">
                <div class="summary-card">
                    <div class="summary-value">${inventoryReport.total_products || 0}</div>
                    <div class="summary-label">Total Products</div>
                </div>
                <div class="summary-card success">
                    <div class="summary-value">${inventoryReport.available_products || 0}</div>
                    <div class="summary-label">Available</div>
                </div>
                <div class="summary-card danger">
                    <div class="summary-value">${inventoryReport.unavailable_products || 0}</div>
                    <div class="summary-label">Unavailable</div>
                </div>
                <div class="summary-card warning">
                    <div class="summary-value">${inventoryReport.low_stock_products || 0}</div>
                    <div class="summary-label">Low Stock</div>
                </div>
            </div>

            <div class="report-details">
                <h4>Inventory Status</h4>
                <table class="reports-table">
                    <thead>
                        <tr>
                            <th>Product</th>
                            <th>Stock</th>
                            <th>Threshold</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${inventoryList.map(p => `
                            <tr class="${(Number(p.stock) <= Number(p.threshold)) ? 'low-stock' : ''}">
                                <td>${p.name || '-'}</td>
                                <td>${Number(p.stock) || 0}</td>
                                <td>${Number(p.threshold) || 0}</td>
                                <td>
                                    <span class="status-badge ${Number(p.available) === 1 ? 'available' : 'unavailable'}">
                                        ${p.status ? p.status : (Number(p.available) === 1 ? 'Available' : 'Unavailable')}
                                    </span>
                                </td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>

            <div class="report-details">
                <h4>Supplier Inventory Summary</h4>
                <table class="reports-table">
                    <thead>
                        <tr>
                            <th>Supplier</th>
                            <th>Contact</th>
                            <th>Products</th>
                            <th>Total Stock</th>
                            <th>Low Stock Items</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${suppliers.map(s => {
                            const supplierProducts = products.filter(p => p.supplier_id === s.id);
                            const totalStock = supplierProducts.reduce((sum, p) => sum + p.stock, 0);
                            const lowStockCount = supplierProducts.filter(p => p.stock <= p.threshold).length;
                            return `
                                <tr>
                                    <td>${s.name}</td>
                                    <td>${s.contact_person || '-'}<br><small>${s.email || ''}</small></td>
                                    <td>${supplierProducts.length}</td>
                                    <td>${totalStock}</td>
                                    <td class="${lowStockCount > 0 ? 'low-stock' : ''}">${lowStockCount}</td>
                                </tr>
                            `;
                        }).join("")}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function drawSalesChart() {
    const ctx = document.getElementById("salesChart");
    if (!ctx) return;

    const labels = salesSeries.map(d => d.day);
    const revenue = salesSeries.map(d => d.revenue || 0);

    // Clear previous canvas content by replacing it
    const parent = ctx.parentElement;
    const newCanvas = document.createElement('canvas');
    newCanvas.id = 'salesChart';
    newCanvas.height = 120;
    parent.replaceChild(newCanvas, ctx);

    const chartCtx = document.getElementById("salesChart");
    if (!chartCtx) return;

    new Chart(chartCtx, {
        type: "line",
        data: {
            labels,
            datasets: [{
                data: revenue,
                borderColor: "#2563eb",
                backgroundColor: "rgba(37, 99, 235, 0.1)",
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBackgroundColor: "#2563eb",
                pointBorderColor: "#fff",
                pointBorderWidth: 2,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false,
                },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    callbacks: {
                        title: function(context) {
                            return `Date: ${context[0].label}`;
                        },
                        label: function(context) {
                            return `Revenue: ₹${context.parsed.y}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    display: true,
                    grid: {
                        color: 'rgba(0, 0, 0, 0.05)',
                        drawBorder: false,
                    },
                    ticks: {
                        color: '#6b7280',
                        font: {
                            size: 11,
                        },
                        maxTicksLimit: 7,
                    },
                },
                y: {
                    display: true,
                    grid: {
                        color: 'rgba(0, 0, 0, 0.05)',
                        drawBorder: false,
                    },
                    ticks: {
                        color: '#6b7280',
                        font: {
                            size: 11,
                        },
                        callback: function(value) {
                            return '₹' + value;
                        }
                    },
                    beginAtZero: true,
                }
            },
            elements: {
                point: {
                    hoverRadius: 8,
                }
            },
            interaction: {
                intersect: false,
                mode: 'index',
            },
        }
    });
}

/* ======================
   USERS MANAGEMENT
====================== */
function renderUsers() {
    return `
        <section class="page">
            <header class="page-header">
                <h1>👥 User Management</h1>
                <button onclick="showAddUserModal()" class="btn primary">Add User</button>
            </header>

            <div class="content">
                <div class="table-container">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Username</th>
                                <th>Role</th>
                                <th>Permissions</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody id="usersTableBody">
                            <!-- Users will be loaded here -->
                        </tbody>
                    </table>
                </div>
            </div>
        </section>
    `;
}

async function loadUsers() {
    try {
        const response = await fetchWithAuth('http://localhost:3000/api/users');
        if (!response.ok) throw new Error('Failed to fetch users');
        const usersData = await response.json();
        console.log('Loaded users from API:', usersData);
        users = usersData || [];
        const tbody = document.getElementById('usersTableBody');
        tbody.innerHTML = users
            .filter(user => !currentUser || user.id !== currentUser.id)
            .map(user => `
            <tr>
                <td>${user.id}</td>
                <td>${user.username}</td>
                <td>${user.role}</td>
                <td>${(user.permissions || []).join(', ') || '-'}</td>
                <td>
                    <button onclick="editUser(${user.id})" class="btn small">Edit</button>
                    <button onclick="deleteUser(${user.id})" class="btn small danger">Delete</button>
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Failed to load users:', error);
        showToast('Failed to load users', 'error');
    }
}

function showAddUserModal() {
    showFormModal({
        title: 'Add User',
        submitText: 'Create',
        fields: [
            { name: 'username', label: 'Username', placeholder: 'username' },
            { name: 'password', label: 'Password', type: 'password', placeholder: 'password' },
            { name: 'role', label: 'Role', type: 'select', value: 'cashier', options: [
                { value: 'cashier', label: 'Cashier' },
                { value: 'admin', label: 'Admin' }
            ] },
            { name: 'permissions', label: 'Module access', type: 'checkbox-group', options: [
                { value: 'dashboard', label: 'Dashboard' },
                { value: 'pos', label: 'POS' },
                { value: 'products', label: 'Products' },
                { value: 'suppliers', label: 'Suppliers' },
                { value: 'orders', label: 'Orders' },
                { value: 'reports', label: 'Reports' },
                { value: 'discounts', label: 'Discounts' },
                { value: 'users', label: 'Users' }
            ] }
        ]
    }).then(values => {
        if (!values) return;
        // normalize permissions to array
        if (!values.permissions) values.permissions = [];
        fetchWithAuth('http://localhost:3000/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values)
        }).then(r => r.json()).then(result => {
            if (result.error) showToast(result.error, 'error');
            else { showToast('User added', 'success'); loadUsers(); render(); }
        }).catch(err => { console.error('Add user failed', err); showToast('Add user failed', 'error'); });
    });
}

function editUser(id) {
    const user = (users || []).find(u => u.id === id);
    if (!user) return;
    showFormModal({
        title: 'Edit User',
        submitText: 'Save',
        fields: [
            { name: 'username', label: 'Username', value: user.username },
            { name: 'password', label: 'New password (leave blank to keep)', type: 'password', value: '' },
            { name: 'role', label: 'Role', type: 'select', value: user.role || 'cashier', options: [
                { value: 'cashier', label: 'Cashier' },
                { value: 'admin', label: 'Admin' }
            ] },
            { name: 'permissions', label: 'Module access', type: 'checkbox-group', value: user.permissions || [], options: [
                { value: 'dashboard', label: 'Dashboard' },
                { value: 'pos', label: 'POS' },
                { value: 'products', label: 'Products' },
                { value: 'suppliers', label: 'Suppliers' },
                { value: 'orders', label: 'Orders' },
                { value: 'reports', label: 'Reports' },
                { value: 'discounts', label: 'Discounts' },
                { value: 'users', label: 'Users' }
            ] }
        ]
    }).then(values => {
        if (!values) return;
        const body = { username: values.username, role: values.role };
        if (values.password) body.password = values.password;
        if (values.permissions) body.permissions = values.permissions;
        fetchWithAuth(`http://localhost:3000/api/users/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(r => r.json()).then(async result => {
            if (result.error) showToast(result.error, 'error');
            else {
                showToast('User updated', 'success');
                // If the admin just edited their own account, refresh currentUser so
                // any permission/role changes take effect immediately without re-login.
                if (currentUser && currentUser.id === id) {
                    await checkAuth();
                }
                loadUsers();
                render();
            }
        }).catch(err => { console.error('Update user failed', err); showToast('Update failed', 'error'); });
    });
}

function deleteUser(id) {
    if (!confirm('Are you sure you want to delete this user?')) return;
    fetchWithAuth(`http://localhost:3000/api/users/${id}`, { method: 'DELETE' })
    .then(r => r.json()).then(result => {
        if (result.error) showToast(result.error, 'error');
        else { showToast('User deleted', 'success'); loadUsers(); render(); }
    }).catch(err => { console.error('Delete user failed', err); showToast('Delete failed', 'error'); });
}

/* ======================
   SUPPLIERS MANAGEMENT
====================== */
function renderSuppliers() {
    // Ensure suppliers is an array
    if (!Array.isArray(suppliers)) suppliers = [];

    return `
        <section class="page">
            <header class="page-header">
                <h1>🚚 Supplier Management</h1>
                <button onclick="showAddSupplierModal()" class="btn primary">Add Supplier</button>
            </header>

            <div class="content">
                <div class="table-container">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Name</th>
                                <th>Contact Person</th>
                                <th>Email</th>
                                <th>Phone</th>
                                <th>Address</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${suppliers.map(supplier => `
                                <tr>
                                    <td>${supplier.id}</td>
                                    <td>${supplier.name}</td>
                                    <td>${supplier.contact_person || '-'}</td>
                                    <td>${supplier.email || '-'}</td>
                                    <td>${supplier.phone || '-'}</td>
                                    <td>${supplier.address || '-'}</td>
                                    <td>
                                        <button onclick="editSupplier(${supplier.id})" class="btn small">Edit</button>
                                        <button onclick="deleteSupplier(${supplier.id})" class="btn small danger">Delete</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </section>
    `;
}

function showAddSupplierModal() {
    showFormModal({
        title: 'Add Supplier',
        submitText: 'Create',
        fields: [
            { name: 'name', label: 'Supplier Name' },
            { name: 'contact_person', label: 'Contact Person (optional)' },
            { name: 'email', label: 'Email (optional)' },
            { name: 'phone', label: 'Phone (optional)' },
            { name: 'address', label: 'Address (optional)' }
        ]
    }).then(values => {
        if (!values) return;
        fetchWithAuth('http://localhost:3000/api/suppliers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values)
        }).then(r => r.json()).then(result => {
            if (result.error) showToast(result.error, 'error');
            else { showToast('Supplier added successfully', 'success'); loadSuppliers(); render(); }
        }).catch(error => { console.error('Add supplier error:', error); showToast('Failed to add supplier', 'error'); });
    });
}

function editSupplier(id) {
    const supplier = suppliers.find(s => s.id === id);
    if (!supplier) return;

    showFormModal({
        title: 'Edit Supplier',
        submitText: 'Save',
        fields: [
            { name: 'name', label: 'Supplier Name', value: supplier.name },
            { name: 'contact_person', label: 'Contact Person', value: supplier.contact_person || '' },
            { name: 'email', label: 'Email', value: supplier.email || '' },
            { name: 'phone', label: 'Phone', value: supplier.phone || '' },
            { name: 'address', label: 'Address', value: supplier.address || '' }
        ]
    }).then(values => {
        if (!values) return;
        fetchWithAuth(`http://localhost:3000/api/suppliers/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values)
        }).then(r => r.json()).then(result => {
            if (result.error) showToast(result.error, 'error');
            else { showToast('Supplier updated successfully', 'success'); loadSuppliers(); render(); }
        }).catch(error => { console.error('Update supplier error:', error); showToast('Failed to update supplier', 'error'); });
    });
}

function deleteSupplier(id) {
    const supplier = suppliers.find(s => s.id === id);
    if (!supplier) return;

    if (!confirm(`Are you sure you want to delete supplier "${supplier.name}"?`)) return;

    fetch(`http://localhost:3000/api/suppliers/${id}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('authToken')}`
        }
    })
    .then(r => r.json())
    .then(result => {
        if (result.error) {
            showToast(result.error, 'error');
        } else {
            showToast('Supplier deleted successfully', 'success');
            loadSuppliers();
            render();
        }
    })
    .catch(error => {
        console.error('Delete supplier error:', error);
        showToast('Failed to delete supplier', 'error');
    });
}

/* ======================
   DISCOUNTS MANAGEMENT
====================== */
function renderDiscounts() {
    return `
        <section class="page">
            <header class="page-header">
                <h1>🏷️ Discount Management</h1>
                <button onclick="showAddDiscountModal()" class="btn primary">Add Discount</button>
            </header>

            <div class="content">
                <div class="table-container">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Code</th>
                                <th>Type</th>
                                <th>Value</th>
                                <th>Active</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody id="discountsTableBody">
                            <!-- Discounts will be loaded here -->
                        </tbody>
                    </table>
                </div>
            </div>
        </section>
    `;
}

function showAddDiscountModal() {
    const code = prompt('Discount code (e.g. SAVE10):');
    if (!code) return;
    const type = prompt('Type (percentage|fixed):', 'percentage');
    if (!type) return;
    const rawValue = prompt('Value (number):', '10');
    const value = Number(rawValue || 0);

    fetchWithAuth('http://localhost:3000/api/discounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, type, value })
    }).then(r => r.json()).then(result => {
        if (result.error) showToast(result.error, 'error');
        else { showToast('Discount added', 'success'); loadDiscounts(); render(); }
    }).catch(err => { console.error('Add discount error', err); showToast('Failed to add discount', 'error'); });
}

function editDiscount(id) {
    // Fetch current discount
    fetchWithAuth(`http://localhost:3000/api/discounts`, { method: 'GET' })
    .then(r => r.json()).then(list => {
        const d = (list || []).find(x => x.id === id);
        if (!d) return showToast('Discount not found', 'error');
        const code = prompt('Code:', d.code) || d.code;
        const type = prompt('Type (percentage|fixed):', d.type) || d.type;
        const value = Number(prompt('Value:', String(d.value)) || d.value);
        const active = confirm('Mark as active?') ? 1 : 0;

        fetchWithAuth(`http://localhost:3000/api/discounts/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, type, value, active })
        }).then(r => r.json()).then(res => {
            if (res.error) showToast(res.error, 'error');
            else { showToast('Discount updated', 'success'); loadDiscounts(); render(); }
        }).catch(err => { console.error('Update discount', err); showToast('Update failed', 'error'); });
    }).catch(err => { console.error('Fetch discounts', err); showToast('Failed to fetch discount', 'error'); });
}

function deleteDiscount(id) {
    if (!confirm('Are you sure you want to delete this discount?')) return;
    fetchWithAuth(`http://localhost:3000/api/discounts/${id}`, { method: 'DELETE' })
    .then(r => r.json()).then(result => {
        if (result.error) showToast(result.error, 'error');
        else { showToast('Discount deleted', 'success'); loadDiscounts(); render(); }
    }).catch(err => { console.error('Delete discount failed', err); showToast('Delete failed', 'error'); });
}

/* ======================
   ORDER DETAILS MODAL
====================== */
async function openOrderDetails(orderId) {
    console.log("🔍 Opening order:", orderId);

    const data = await fetch(
        `http://localhost:3000/api/orders/${orderId}`
    ).then(r => r.json());

    document.getElementById("orderTitle").textContent =
        `Order #${data.order.id} • ${new Date(data.order.created_at).toLocaleString()}`;

    document.getElementById("orderItems").innerHTML =
        data.items.map(i => `
            <tr>
              <td>${i.name}</td>
              <td>${i.quantity}</td>
              <td>₹${i.price}</td>
              <td>₹${i.line_total}</td>
            </tr>
        `).join("");

    document.getElementById("orderTotal").textContent =
        `Total: ₹${data.order.total}`;

    document.getElementById("orderModal").classList.remove("hidden");
}

function closeOrderModal() {
    document.getElementById("orderModal").classList.add("hidden");
}

async function printBill(orderId) {
    console.log("🧾 Printing bill for order:", orderId);

    try {
        const data = await fetch(
            `http://localhost:3000/api/orders/${orderId}`
        ).then(r => r.json());

        // Create a new window for the bill
        const billWindow = window.open('', '_blank', 'width=400,height=600');
        const date = new Date(data.order.created_at);

        billWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Bill - Order #${data.order.id}</title>
                <style>
                    body { font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; }
                    .bill-header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 20px; }
                    .bill-header h1 { margin: 0; font-size: 24px; }
                    .bill-header p { margin: 5px 0; color: #666; }
                    .bill-details { margin-bottom: 20px; }
                    .bill-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
                    .bill-table th, .bill-table td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
                    .bill-table th { background: #f5f5f5; font-weight: bold; }
                    .bill-total { text-align: right; font-size: 18px; font-weight: bold; margin-top: 20px; }
                    .bill-footer { text-align: center; margin-top: 30px; color: #666; font-size: 12px; }
                    @media print { body { padding: 0; } }
                </style>
            </head>
            <body>
                <div class="bill-header">
                    <h1>BIZNEX</h1>
                    <p>Business Operating System</p>
                    <p>Order #${data.order.id}</p>
                </div>

                <div class="bill-details">
                    <p><strong>Date:</strong> ${date.toLocaleDateString()}</p>
                    <p><strong>Time:</strong> ${date.toLocaleTimeString()}</p>
                </div>

                <table class="bill-table">
                    <thead>
                        <tr>
                            <th>Item</th>
                            <th>Qty</th>
                            <th>Price</th>
                            <th>Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${data.items.map(item => `
                            <tr>
                                <td>${item.name}</td>
                                <td>${item.quantity}</td>
                                <td>₹${item.price}</td>
                                <td>₹${item.line_total}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>

                <div class="bill-total">
                    Total: ₹${data.order.total}
                </div>

                <div class="bill-footer">
                    <p>Thank you for your business!</p>
                    <p>Generated on ${new Date().toLocaleString()}</p>
                </div>
            </body>
            </html>
        `);

        billWindow.document.close();

        // Auto-print after a short delay
        setTimeout(() => {
            billWindow.print();
        }, 500);

    } catch (error) {
        console.error("❌ Error printing bill:", error);
        alert("Error generating bill. Please try again.");
    }
}

function getTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} mins ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
}

async function openOrderDetails(orderId) {
    try {
        const res = await fetch(`http://localhost:3000/api/orders/${orderId}`);
        const data = await res.json();

        if (!res.ok) {
            showToast('Failed to load order details', 'error');
            return;
        }

        const { order, items } = data;
        const date = new Date(order.created_at);

        const modal = document.getElementById('orderModal');
        const title = document.getElementById('orderTitle');
        const itemsContainer = document.getElementById('orderItems');
        const total = document.getElementById('orderTotal');

        title.innerHTML = `Order #${order.id} - ${date.toLocaleString()}`;
        total.innerHTML = `<strong>Total: ₹${order.total}</strong><br>Payment: ${order.payment_mode || 'cash'}`;

        itemsContainer.innerHTML = items.map(item => `
            <tr>
                <td>${item.name}</td>
                <td>${item.quantity}</td>
                <td>₹${item.price}</td>
                <td>₹${item.line_total}</td>
            </tr>
        `).join('');

        modal.classList.remove('hidden');
    } catch (error) {
        showToast('Network error loading order details', 'error');
    }
}

function closeOrderModal() {
    document.getElementById('orderModal').classList.add('hidden');
}
