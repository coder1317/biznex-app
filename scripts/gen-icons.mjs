/**
 * scripts/gen-icons.js
 * Generates build-assets/icon.ico (multi-size: 16,32,48,256) and
 * build-assets/icon.png (512x512) from build-assets/biznex-logo.png
 */
const Jimp  = require('jimp');
const toIco = require('to-ico');
const fs    = require('fs');

const src = 'build-assets/biznex-logo.png';

function getBuffer(img) {
    return new Promise((resolve, reject) => {
        img.getBuffer(Jimp.MIME_PNG, (err, buf) => err ? reject(err) : resolve(buf));
    });
}

async function main() {
    console.log('Reading', src, '...');
    const sizes = [16, 32, 48, 256];

    const pngBuffers = await Promise.all(sizes.map(async (s) => {
        const img = await Jimp.read(src);
        img.resize(s, s);
        return getBuffer(img);
    }));

    const ico = await toIco(pngBuffers);
    fs.writeFileSync('build-assets/icon.ico', ico);
    console.log(`icon.ico written  (${ico.length} bytes, sizes: ${sizes.join(',')}px)`);

    // 512x512 PNG for Linux / macOS builds
    const big = await Jimp.read(src);
    big.resize(512, 512);
    await new Promise((resolve, reject) =>
        big.write('build-assets/icon.png', (err) => err ? reject(err) : resolve()));
    console.log('icon.png written  (512x512)');

    console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
