## Icon Generation Instructions

You need three icon files before building the installer:

| File        | Format | Size        | Used For              |
|-------------|--------|-------------|----------------------|
| `icon.ico`  | ICO    | 256×256 min | Windows installer    |
| `icon.png`  | PNG    | 512×512     | Linux / Raspberry Pi |
| `icon.icns` | ICNS   | 512×512     | macOS (optional)     |

### Quick way (recommended)

1. Create a 1024×1024 PNG of your logo
2. Go to https://www.icoconverter.com/ → convert to `.ico` (select all sizes)
3. Go to https://cloudconvert.com/png-to-icns → convert to `.icns`
4. Place all three files in this `build-assets/` folder

### Programmatic (Node.js)

Install: `npm install --save-dev electron-icon-builder`

Then run:
```
npx electron-icon-builder --input=build-assets/logo_1024.png --output=build-assets
```
This generates `icon.ico`, `icon.png`, and `icon.icns` automatically.

### Without icons

The build will FAIL without icon files.
To build without custom icons (for testing), either:
 - Add any valid .ico and .png files
 - OR remove the icon lines from package.json temporarily
