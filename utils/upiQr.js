'use strict';

const QRCode = require('qrcode');
const config = require('./config');

// A UPI QR for your own UPI ID with the agreed amount already filled in, made fresh for
// each buyer. Any UPI app (GPay, PhonePe, Paytm…) opens it straight to "pay ₹X to you".
// Free and instant; the payment is then checked from the buyer's screenshot as before.

/** The upi://pay link the QR encodes. `note` shows up in the payment's remarks. */
function upiLink(amountRupees, note = '') {
    const params = new URLSearchParams({
        pa: config.UPI_ID,
        pn: config.PAYEE_NAME || 'Seller',
        am: Number(amountRupees).toFixed(2),
        cu: 'INR',
    });
    if (note) params.set('tn', String(note).slice(0, 50));
    // Plain "@" and "%20" like the QRs UPI apps print themselves; some apps don't decode "%40" or "+".
    return `upi://pay?${params.toString().replace(/\+/g, '%20').replace(/%40/g, '@')}`;
}

/** PNG of a QR for any upi://pay link as { mimetype, data (base64) }. */
async function qrForLink(link) {
    const png = await QRCode.toBuffer(link, { type: 'png', width: 600, margin: 3, errorCorrectionLevel: 'M' });
    return { mimetype: 'image/png', data: png.toString('base64') };
}

/** PNG of that QR as { mimetype, data (base64) }, or null if UPI_ID isn't set. */
async function makeQr(amountRupees, note = '') {
    if (!config.UPI_ID) return null;
    return qrForLink(upiLink(amountRupees, note));
}

module.exports = { upiLink, makeQr, qrForLink };
