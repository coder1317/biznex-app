Place your app icons in this folder:

  icon.ico   — Windows (256x256 ICO)
  icon.png   — Linux/RPi (512x512 PNG)
  icon.icns  — macOS (if building for Mac)

You can generate all sizes from a single PNG at:
  https://www.icoconverter.com/
  https://cloudconvert.com/png-to-ico

electron-builder will pick these up automatically during `npm run build:win` / `npm run build:linux`.
If no icons are provided, electron-builder will use its default Electron icon.
