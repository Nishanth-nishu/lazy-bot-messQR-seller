'use strict';

const config = require('./config');

// Razorpay one-time payments for exactly the agreed price. We poll Razorpay for the
// result, so no public webhook URL is needed. Two kinds (RAZORPAY_MODE in Setting.txt):
//   link — Payment Link (https://razorpay.com/docs/api/payments/payment-links/); works on
//          every account, test mode included. UPI-only links (open the UPI app directly)
//          are live-mode only, so test mode gets a normal link.
//   qr   — single-use UPI QR (https://razorpay.com/docs/api/qr-codes/); needs "UPI QR codes"
//          enabled by Razorpay Support. Falls back to a link if the QR can't be made.

const API_URL = 'https://api.razorpay.com/v1';
const REQUEST_TIMEOUT_MS = 15000;
const MIN_QR_CLOSE_SECONDS = 150;        // QR close_by must be ≥ 2 min ahead
const MIN_LINK_EXPIRE_SECONDS = 16 * 60; // link expire_by must be ≥ 15 min ahead; the bot cancels it earlier

function getKeys() {
    return {
        id: (process.env.RAZORPAY_KEY_ID || '').trim(),
        secret: (process.env.RAZORPAY_KEY_SECRET || '').trim(),
    };
}

/** True when PAYMENT_GATEWAY=razorpay and both keys are in .env. */
function isEnabled() {
    const { id, secret } = getKeys();
    return String(config.PAYMENT_GATEWAY || '').toLowerCase() === 'razorpay' && Boolean(id && secret);
}

function isTestMode() {
    return getKeys().id.startsWith('rzp_test_');
}

async function request(method, apiPath, body) {
    const { id, secret } = getKeys();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${API_URL}${apiPath}`, {
            method,
            headers: {
                Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
                'Content-Type': 'application/json',
                accept: 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`Razorpay ${res.status}: ${data?.error?.description || res.statusText}`);
        return data;
    } finally {
        clearTimeout(timer);
    }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const paise = (rupees) => Math.round(rupees * 100);

async function createQr({ amountRupees, minutes, buyerName, buyerPhone }) {
    const qr = await request('POST', '/payments/qr_codes', {
        type: 'upi_qr',
        name: 'Mess meal QR',
        usage: 'single_use',
        fixed_amount: true,
        payment_amount: paise(amountRupees),
        description: `Mess meal for ${buyerName || 'buyer'}`.slice(0, 250),
        close_by: nowSeconds() + Math.max(MIN_QR_CLOSE_SECONDS, Math.round(minutes * 60)),
        notes: { buyer: String(buyerName).slice(0, 250), phone: String(buyerPhone || '').slice(0, 250) },
    });
    return { kind: 'qr', id: qr.id, url: qr.image_url, imageUrl: qr.image_url };
}

async function createLink({ amountRupees, minutes, buyerName, buyerPhone }) {
    const body = {
        amount: paise(amountRupees),
        currency: 'INR',
        accept_partial: false,
        description: `Mess meal for ${buyerName || 'buyer'}`.slice(0, 2048),
        expire_by: nowSeconds() + Math.max(MIN_LINK_EXPIRE_SECONDS, Math.round(minutes * 60)),
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { buyer: String(buyerName).slice(0, 250), phone: String(buyerPhone || '').slice(0, 250) },
    };
    let link;
    if (!isTestMode()) {
        try {
            link = await request('POST', '/payment_links', { ...body, upi_link: true });
        } catch (err) {
            console.warn(`⚠️  [Razorpay] UPI-only link not available (${err.message}) — using a normal payment link.`);
        }
    }
    if (!link) link = await request('POST', '/payment_links', body);
    return { kind: 'link', id: link.id, url: link.short_url, imageUrl: null };
}

/**
 * Make a one-time payment for exactly `amountRupees` that the buyer can use for `minutes`.
 * Returns a handle { kind: 'qr' | 'link', id, url, imageUrl }.
 */
async function createPayment(opts) {
    if (String(config.RAZORPAY_MODE || 'link').toLowerCase() === 'qr') {
        try {
            return await createQr(opts);
        } catch (err) {
            console.warn(`⚠️  [Razorpay] Could not make a UPI QR (${err.message}) — sending a payment link instead.`);
        }
    }
    return createLink(opts);
}

/** Bank reference (UTR/RRN) of a payment, if Razorpay has it. */
async function fetchRrn(paymentId) {
    try {
        const p = await request('GET', `/payments/${encodeURIComponent(paymentId)}`);
        return p.acquirer_data?.rrn || null;
    } catch (_) {
        return null;
    }
}

/**
 * The captured payment for this handle matching the amount, or null if none yet.
 * Returns { paymentId, amount (₹), vpa, rrn }.
 */
async function findPayment(handle, amountRupees) {
    const wanted = paise(amountRupees);
    if (handle.kind === 'qr') {
        const data = await request('GET', `/payments/qr_codes/${encodeURIComponent(handle.id)}/payments?count=10`);
        const paid = (data.items || []).find((p) => p.status === 'captured' && p.amount === wanted);
        if (!paid) return null;
        return { paymentId: paid.id, amount: paid.amount / 100, vpa: paid.vpa || null, rrn: paid.acquirer_data?.rrn || null };
    }

    const link = await request('GET', `/payment_links/${encodeURIComponent(handle.id)}`);
    if (link.status !== 'paid' || link.amount_paid !== wanted) return null;
    const paid = (link.payments || []).find((p) => p.status === 'captured' && p.amount === wanted) || (link.payments || [])[0] || {};
    const paymentId = paid.payment_id || paid.id || link.id;
    return { paymentId, amount: link.amount_paid / 100, vpa: null, rrn: paid.payment_id ? await fetchRrn(paid.payment_id) : null };
}

/** Stop a payment from being usable (buyer left / window over). Best effort. */
async function cancel(handle) {
    if (!handle?.id) return;
    const apiPath = handle.kind === 'qr'
        ? `/payments/qr_codes/${encodeURIComponent(handle.id)}/close`
        : `/payment_links/${encodeURIComponent(handle.id)}/cancel`;
    try {
        await request('POST', apiPath);
    } catch (err) {
        if (!/already|cannot be cancelled|400/i.test(err.message)) console.warn(`⚠️  [Razorpay] Could not cancel ${handle.id}: ${err.message}`);
    }
}

/** Download the QR image Razorpay hosts; returns { mimetype, data (base64) } or null. */
async function downloadQrImage(imageUrl) {
    if (!imageUrl) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(imageUrl, { redirect: 'follow', signal: controller.signal });
        const mimetype = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (!res.ok || !mimetype.startsWith('image/')) return null;
        return { mimetype, data: Buffer.from(await res.arrayBuffer()).toString('base64') };
    } catch (_) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { isEnabled, isTestMode, createPayment, findPayment, cancel, downloadQrImage };
