function safeCall(printer, fnName, ...args) {
    if (!printer || typeof printer[fnName] !== 'function') return;
    try { return printer[fnName](...args); } catch (e) { console.warn('Printer method failed', fnName, e && e.message); }
}

/**
 * Print a receipt.
 * @param {object} printer - thermal printer instance
 * @param {object} order   - order data
 * @param {object} [settings={}] - business settings from business_settings table
 */
async function printReceipt(printer, order, settings = {}) {
    if (!printer) throw new Error('Printer instance required');

    const businessName    = settings.business_name    || 'BIZNEX BOS';
    const businessAddress = settings.business_address || '';
    const currencySymbol  = settings.currency_symbol  || '\u20b9';
    const receiptFooter   = settings.receipt_footer   || 'Thank you! Visit again';

    safeCall(printer, 'alignCenter');
    safeCall(printer, 'setTextDoubleHeight');
    safeCall(printer, 'println', businessName);
    safeCall(printer, 'setTextNormal');
    if (businessAddress) safeCall(printer, 'println', businessAddress);
    safeCall(printer, 'drawLine');

    safeCall(printer, 'alignLeft');
    safeCall(printer, 'println', `Order ID : ${order.id}`);
    safeCall(printer, 'println', `Date     : ${new Date(order.created_at).toLocaleString()}`);
    safeCall(printer, 'println', `Payment  : ${order.payment_mode}`);
    safeCall(printer, 'drawLine');

    (order.items || []).forEach(item => {
        const name = (item.name || '').toString().slice(0, 24);
        const qty = item.quantity || 0;
        const line = item.line_total ?? (item.price * qty) ?? 0;
        safeCall(printer, 'println', `${name} x${qty}  ${currencySymbol}${line}`);
    });

    safeCall(printer, 'drawLine');
    safeCall(printer, 'println', `TOTAL : ${currencySymbol}${order.total}`);
    safeCall(printer, 'newLine');
    safeCall(printer, 'println', receiptFooter);
    safeCall(printer, 'cut');

    if (typeof printer.execute === 'function') {
        return printer.execute();
    }

    // Some versions expose `print` or `raw` — try execute-like fallback
    if (typeof printer.print === 'function') return printer.print();
    throw new Error('Printer does not support execute/print');
}

module.exports = { printReceipt };
