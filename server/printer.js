const os = require('os');

let ThermalPrinter, PrinterTypes;
try {
    const lib = require('node-thermal-printer');
    ThermalPrinter = lib.ThermalPrinter;
    PrinterTypes   = lib.PrinterTypes;
} catch (e) {
    console.warn('node-thermal-printer failed to load. Printing disabled:', e.message);
}

/**
 * Resolve the printer interface string.
 * Priority: settings.printer_interface > PRINTER_INTERFACE env var > OS platform default
 */
function getInterface(settings = {}) {
    if (settings && settings.printer_interface) return settings.printer_interface;
    if (process.env.PRINTER_INTERFACE) return process.env.PRINTER_INTERFACE;
    if (os.platform() === 'win32') return 'printer:POS-58';
    return '/dev/usb/lp0';
}

function ensurePrinterAvailable() {
    if (!ThermalPrinter) throw new Error('node-thermal-printer library not available');
    if (!PrinterTypes) throw new Error('Printer types not available');
}

/**
 * Get a configured printer instance.
 * @param {object} [settings={}] - business settings (may include printer_interface)
 */
function getPrinter(settings = {}) {
    ensurePrinterAvailable();

    return new ThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: getInterface(settings),
        options: { timeout: 5000 },
        width: 48,
        characterSet: 'PC852_LATIN2',
        removeSpecialCharacters: false,
        lineCharacter: '-',
    });
}

module.exports = { getPrinter };
