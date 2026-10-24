'use strict';

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const config = require('./config');

// The dining portal (dining.iiit.ac.in) draws the meal QR in the browser from the
// `token` field of /api/auth/me. The token changes when the QR is reset, so we fetch
// it fresh and render the same QR ourselves.

const PORTAL_URL = 'https://dining.iiit.ac.in';
const REQUEST_TIMEOUT_MS = 15000;

// The portal doesn't document how API keys are sent, so try the common styles
// and remember whichever one the server accepts.
const AUTH_STYLES = [
    { name: 'Authorization: Bearer', headers: (key) => ({ Authorization: `Bearer ${key}` }) },
    { name: 'x-api-key', headers: (key) => ({ 'x-api-key': key }) },
    { name: 'Authorization', headers: (key) => ({ Authorization: key }) },
    { name: 'Authorization: Key', headers: (key) => ({ Authorization: `Key ${key}` }) },
];

let workingStyle = null;
let lastFetchedDay = null;   // 'YYYY-MM-DD' (IST) of the last successful QR fetch
let lastTokenTail = null;

function todayIst() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function getApiKey() {
    return (process.env.DINING_API_KEY || '').trim();
}

function isConfigured() {
    return Boolean(getApiKey());
}

async function portalGet(apiPath, style) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(`${PORTAL_URL}${apiPath}`, {
            headers: { accept: 'application/json', ...style.headers(getApiKey()) },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * GET a portal API path as the logged-in user. Returns parsed JSON or throws.
 */
async function apiGet(apiPath) {
    if (!isConfigured()) throw new Error('DINING_API_KEY is not set in .env');

    const styles = workingStyle ? [workingStyle] : AUTH_STYLES;
    const statuses = [];
    for (const style of styles) {
        const res = await portalGet(apiPath, style);
        if (res.ok) {
            if (workingStyle !== style) {
                workingStyle = style;
                console.log(`🔑 [Portal] API key accepted (${style.name}).`);
            }
            return res.json();
        }
        statuses.push(`${style.name} → ${res.status}`);
        if (res.status !== 401 && res.status !== 403) break; // not an auth problem
    }
    workingStyle = null;
    throw new Error(`portal rejected the request (${statuses.join(', ')})`);
}

/**
 * Fetch today's QR token and write the QR image to QR_IMAGE_PATH.
 * Returns true on success. Never logs the token itself.
 */
async function refreshQr(reason = 'scheduled') {
    if (!isConfigured()) {
        console.warn('⚠️  [Portal] DINING_API_KEY is not set — using the existing QR image as is.');
        return false;
    }
    try {
        const me = await apiGet('/api/auth/me');
        const user = me?.data ?? me;
        const token = user?.token;
        if (!token || typeof token !== 'string') throw new Error('no QR token in /api/auth/me response');

        const outPath = config.QR_IMAGE_PATH;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        const tmpPath = `${outPath}.tmp.png`;
        await QRCode.toFile(tmpPath, token, { type: 'png', width: 600, margin: 2, errorCorrectionLevel: 'H' });
        fs.renameSync(tmpPath, outPath);

        const tail = token.slice(-4);
        const changed = lastTokenTail !== null && lastTokenTail !== tail;
        lastTokenTail = tail;
        lastFetchedDay = todayIst();
        console.log(`🍽️  [Portal] Meal QR refreshed (${reason}) for ${user?.name || 'account'} — token …${tail}${changed ? ' (changed)' : ''}.`);
        return true;
    } catch (err) {
        console.error(`❌ [Portal] Could not refresh the meal QR (${reason}): ${err.message}`);
        return false;
    }
}

/** True if the QR was fetched successfully today (IST). */
function isQrFreshToday() {
    return lastFetchedDay === todayIst();
}

module.exports = { refreshQr, isQrFreshToday, isConfigured, apiGet };
