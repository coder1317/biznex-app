#!/usr/bin/env node
/**
 * scripts/package-rpi.mjs — Bundle Biznex BOS for Raspberry Pi deployment
 *
 * Creates  biznex-bos-rpi-v{version}.tar.gz  in the project's parent directory.
 * The archive contains all production files; node_modules are intentionally
 * excluded — the Pi installer rebuilds them natively on the device itself.
 *
 * Usage (from the app directory):
 *   node scripts/package-rpi.mjs
 *   npm run package:rpi
 *
 * ── Deployment ──────────────────────────────────────────────────────────────
 *  On Windows, copy via USB or SCP:
 *    scp ..\biznex-bos-rpi-v1.0.0.tar.gz pi@<PI_IP>:~
 *
 *  On the Raspberry Pi:
 *    mkdir biznex-bos
 *    tar xf biznex-bos-rpi-v1.0.0.tar.gz -C biznex-bos
 *    cd biznex-bos
 *    chmod +x rpi/install.sh && ./rpi/install.sh
 */

import { execSync }                              from 'child_process';
import { readFileSync, existsSync, statSync }    from 'fs';
import { resolve, basename, dirname }            from 'path';
import { fileURLToPath }                         from 'url';

const ROOT    = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg     = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const outName = `biznex-bos-rpi-v${version}.tar.gz`;
const outPath = resolve(ROOT, '..', outName);

// Files/dirs to strip from the archive (not needed on a headless Pi)
const EXCLUDES = [
    './node_modules',
    './.git',
    './.gitignore',
    './.env',
    './.env.local',
    './biznex-dist',
    './electron-shell',          // Electron UI layer — not used on Pi (Chromium kiosk instead)
    './server/biznex.db',
    './server/biznex.db-wal',
    './server/biznex.db-shm',
    './server/proto-license.db',
    './server/proto-license.db-wal',
    './server/proto-license.db-shm',
    './server/backups',
    './server/logs',
    './logs',
    './*.test.js',
    './server/*.test.js',
    './__tests__',
].map(e => `--exclude="${e}"`).join(' ');

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║   Biznex BOS — Raspberry Pi Packager    ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`  Version : ${version}`);
console.log(`  Output  : ${outPath}`);
console.log('');
console.log('Building archive (this takes a few seconds)...');

try {
    execSync(`tar ${EXCLUDES} -czf "${outPath}" .`, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: true,
    });

    // Report file size
    const bytes = statSync(outPath).size;
    const mb    = (bytes / 1024 / 1024).toFixed(1);

    console.log('');
    console.log(`✅  Package created: ${outName}  (${mb} MB)`);
    console.log('');
    console.log('── Deploy to Raspberry Pi ──────────────────────');
    console.log('');
    console.log('  Option A — USB drive:');
    console.log(`    1. Copy ${outName} to a USB drive`);
    console.log('    2. Plug into Pi and mount it');
    console.log(`    3. cp /media/pi/<USB>/${outName} ~`);
    console.log('');
    console.log('  Option B — SCP over Wi-Fi / LAN:');
    console.log(`    scp ..\\${outName} pi@<PI_IP>:~`);
    console.log('');
    console.log('  Then on the Pi:');
    console.log(`    mkdir -p ~/biznex-bos`);
    console.log(`    tar xf ~/${outName} -C ~/biznex-bos`);
    console.log('    cd ~/biznex-bos');
    console.log('    chmod +x rpi/install.sh && ./rpi/install.sh');
    console.log('');
    console.log('  ── (optional) set up kiosk autostart ──');
    console.log('    chmod +x rpi/autostart-kiosk.sh && ./rpi/autostart-kiosk.sh');
    console.log('────────────────────────────────────────────────');
    console.log('');

} catch (err) {
    console.error('');
    console.error('❌  Packaging failed:', err.message);
    console.error('');
    console.error('Tip: Ensure tar is available. On Windows it ships with Git for Windows or run');
    console.error('     this from Git Bash / WSL.');
    process.exit(1);
}
