/**
 * BIZNEX Cloud Sync Client
 * Handles syncing local sales data to the BIZNEX Portal
 * Uses the Portal's cloud sync APIs
 */

class CloudSyncClient {
  constructor(config = {}) {
    this.licenseKey = config.licenseKey || localStorage.getItem('licenseKey');
    this.storeId = config.storeId || localStorage.getItem('storeId');
    this.storeName = config.storeName || localStorage.getItem('storeName') || 'Local Store';
    this.portalUrl = config.portalUrl || 'http://localhost:5000';
    this.syncInterval = config.syncInterval || 30 * 60 * 1000; // 30 minutes
    this.isAutoSyncEnabled = config.autoSync !== false;
    this.pendingSales = [];
    this.lastSyncTime = null;
    this.isSyncing = false;

    this.initAutoSync();
  }

  /**
   * Validate license key with Portal
   */
  async validateLicense() {
    try {
      const response = await fetch(`${this.portalUrl}/api/cloud-sync/validate-license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: this.licenseKey })
      });

      if (!response.ok) {
        throw new Error(`License validation failed: ${response.status}`);
      }

      const data = await response.json();
      if (data.success) {
        console.log('✅ Cloud Sync: License validated', data.license);
        return data.license;
      }
      throw new Error(data.error || 'License validation failed');
    } catch (err) {
      console.error('❌ Cloud Sync: License validation error:', err);
      this.emit('error', err.message);
      return null;
    }
  }

  /**
   * Add a sale to pending sync queue
   */
  addSale(order) {
    if (!order || !order.id) {
      console.warn('❌ Cloud Sync: Invalid order format');
      return false;
    }

    this.pendingSales.push({
      id: order.id,
      total: order.total || 0,
      paymentMode: order.paymentMode || 'cash',
      items: order.items || [],
      createdAt: order.createdAt || new Date().toISOString()
    });

    console.log(`📦 Cloud Sync: Order queued for sync (${this.pendingSales.length} pending)`);
    this.updateSyncIndicator();
    return true;
  }

  /**
   * Upload pending sales to Portal
   */
  async uploadSales(sales = null) {
    if (this.isSyncing) {
      console.warn('⏳ Cloud Sync: Sync already in progress');
      return false;
    }

    const salesToSync = sales || this.pendingSales;
    if (salesToSync.length === 0) {
      console.log('✅ Cloud Sync: No pending sales to sync');
      return true;
    }

    this.isSyncing = true;
    this.emit('syncStart');

    try {
      const response = await fetch(`${this.portalUrl}/api/cloud-sync/upload-sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseKey: this.licenseKey,
          storeId: this.storeId,
          storeName: this.storeName,
          sales: salesToSync
        })
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
      }

      const result = await response.json();
      if (result.success) {
        this.lastSyncTime = new Date();
        
        // Only clear pending if these were the actual pending sales
        if (!sales) {
          this.pendingSales = [];
        }

        console.log(`✅ Cloud Sync: ${result.synced} orders uploaded successfully`);
        this.emit('syncSuccess', { synced: result.synced, timestamp: this.lastSyncTime });
        this.updateSyncIndicator();
        return true;
      }

      throw new Error(result.error || 'Upload failed');
    } catch (err) {
      console.error('❌ Cloud Sync: Upload error:', err);
      this.emit('syncError', err.message);
      return false;
    } finally {
      this.isSyncing = false;
      this.emit('syncEnd');
    }
  }

  /**
   * Manually trigger sync from UI
   */
  async manualSync() {
    if (!this.licenseKey) {
      console.error('❌ Cloud Sync: No license key configured');
      return false;
    }

    console.log('🔄 Cloud Sync: Manual sync triggered');
    return await this.uploadSales();
  }

  /**
   * Get sync status from Portal
   */
  async getSyncStatus() {
    try {
      if (!this.licenseKey) return null;

      const response = await fetch(
        `${this.portalUrl}/api/cloud-sync/status/${this.licenseKey}`
      );

      if (!response.ok) return null;

      const data = await response.json();
      if (data.success) {
        console.log('📊 Cloud Sync Status:', data.synced);
        this.emit('statusFetched', data.synced);
        return data.synced;
      }
      return null;
    } catch (err) {
      console.error('❌ Cloud Sync: Status fetch error:', err);
      return null;
    }
  }

  /**
   * Initialize automatic sync interval
   */
  initAutoSync() {
    if (!this.isAutoSyncEnabled) return;

    setInterval(async () => {
      if (this.pendingSales.length > 0 && !this.isSyncing) {
        console.log('⏲️  Cloud Sync: Auto-sync triggered');
        await this.uploadSales();
      }
    }, this.syncInterval);

    console.log(
      `✅ Cloud Sync: Auto-sync enabled (every ${this.syncInterval / 1000 / 60} minutes)`
    );
  }

  /**
   * Update UI sync indicator
   */
  updateSyncIndicator() {
    const indicator = document.querySelector('.sync-indicator');
    if (!indicator) return;

    if (this.isSyncing) {
      indicator.style.display = 'flex';
      indicator.innerHTML = '🔄 Syncing...';
    } else if (this.pendingSales.length > 0) {
      indicator.style.display = 'flex';
      indicator.innerHTML = `📦 ${this.pendingSales.length} pending`;
    } else {
      indicator.innerHTML = '✅ Synced';
      setTimeout(() => {
        indicator.style.display = 'none';
      }, 3000);
    }
  }

  /**
   * Event emitter
   */
  on(event, callback) {
    if (!this._listeners) this._listeners = {};
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  }

  emit(event, data) {
    if (!this._listeners || !this._listeners[event]) return;
    this._listeners[event].forEach(cb => cb(data));
  }

  /**
   * Get pending sales count
   */
  getPendingCount() {
    return this.pendingSales.length;
  }

  /**
   * Get last sync time
   */
  getLastSyncTime() {
    return this.lastSyncTime;
  }

  /**
   * Configure license key
   */
  setLicenseKey(key) {
    this.licenseKey = key;
    localStorage.setItem('licenseKey', key);
  }

  /**
   * Configure store info
   */
  setStoreInfo(storeId, storeName) {
    this.storeId = storeId;
    this.storeName = storeName;
    localStorage.setItem('storeId', storeId);
    localStorage.setItem('storeName', storeName);
  }

  /**
   * Disable auto-sync
   */
  disableAutoSync() {
    this.isAutoSyncEnabled = false;
  }

  /**
   * Enable auto-sync
   */
  enableAutoSync() {
    this.isAutoSyncEnabled = true;
    this.initAutoSync();
  }
}

// Initialize global instance if on POS page
if (typeof window !== 'undefined') {
  let cloudSync = null;
  window.initCloudSync = function(config) {
    cloudSync = new CloudSyncClient(config);
    return cloudSync;
  };
  window.getCloudSync = function() {
    return cloudSync;
  };
}
