'use strict';

const path = require('path');
const { createWorker } = require('tesseract.js');

// Free, offline fallback for reading UPI payment screenshots (GPay, PhonePe, Paytm,
// bank apps). Tesseract turns the image into text; the regexes below pull out the
// same fields Claude would. It cannot judge whether an image was edited.

const CACHE_DIR = path.resolve(__dirname, '..', '.tesseract-cache');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

let workerPromise = null;
function getWorker() {
    if (!workerPromise) {
        workerPromise = createWorker('eng', 1, { cachePath: CACHE_DIR }).catch((err) => {
            workerPromise = null;
            throw err;
        });
    }
    return workerPromise;
}

// Tesseract page segmentation modes: 3 = full page (default), 11 = sparse text.
// Sparse mode catches big isolated text like GPay's huge "₹25" that full-page mode can skip.
async function readText(imageBuffer, pageSegMode = '3') {
    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: pageSegMode });
    const { data } = await worker.recognize(imageBuffer);
    return data.text || '';
}

// ─── Field extraction ───────────────────────────────────────

function detectStatus(text) {
    if (/\b(failed|declined|unsuccessful|cancelled|reversed)\b/i.test(text)) return 'failed';
    if (/\b(pending|processing|in progress|awaiting)\b/i.test(text)) return 'pending';
    // Apps say "Completed", "Successful", "Transferred", "Paid", "Sent"… — also tolerate
    // common misspellings/OCR slips like "sucessful", "successfull", "transfered".
    if (/\b(su+c+e+s+(ful+(ly)?)?|complete[d]?|transfer+e?d|transfer\s+successful|paid|sent|debited|done)\b/i.test(text)) return 'success';
    return 'unknown';
}

function detectApp(text) {
    if (/google\s*pay|g\s*pay/i.test(text)) return 'Google Pay';
    if (/phone\s*pe/i.test(text)) return 'PhonePe';
    if (/paytm/i.test(text)) return 'Paytm';
    if (/bhim/i.test(text)) return 'BHIM';
    if (/navi|cred|super\.?money|amazon\s*pay|mobikwik/i.test(text)) return 'other UPI app';
    return 'unknown';
}

/** 12-digit UPI reference / UTR, preferring one next to a label. */
function detectUtr(text) {
    const labelled = text.match(/(?:utr|upi\s*(?:transaction|txn|ref(?:erence)?)?\s*(?:id|no\.?|number)?|ref(?:erence)?\s*(?:id|no\.?|number))\s*[:\-#]?\s*((?:\d[\s-]?){12})\b/i);
    if (labelled) {
        const digits = labelled[1].replace(/\D/g, '');
        if (digits.length === 12) return digits;
    }
    const bare = text.match(/(?<!\d)(\d{12})(?!\d)/);
    return bare ? bare[1] : null;
}

/** Strip dates, times, phone numbers and long IDs so they aren't mistaken for the amount. */
function withoutNoise(text) {
    return text
        .replace(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?/gi, ' ')
        .replace(/\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/g, ' ')
        .replace(new RegExp(`\\d{1,2}\\s*(?:${MONTHS.join('|')})[a-z]*\\.?,?\\s*\\d{0,4}`, 'gi'), ' ')
        .replace(new RegExp(`(?:${MONTHS.join('|')})[a-z]*\\.?\\s*\\d{1,2},?\\s*\\d{0,4}`, 'gi'), ' ')
        .replace(/\d{6,}/g, ' ');
}

/**
 * Amount paid. Tesseract often misreads "₹" as "%", "F", "z" or "2", so we look for
 * a currency-marked number first, then for the expected price as a standalone number.
 */
function detectAmount(text, expectedAmount) {
    const clean = withoutNoise(text);
    const marked = [...clean.matchAll(/(?:₹|rs\.?|inr|%|\bz|\bf)\s*(\d{1,5}(?:[.,]\d{1,2})?)\b/gi)]
        .map((m) => Number(m[1].replace(',', '.')))
        .filter((n) => Number.isFinite(n) && n > 0);
    if (marked.includes(expectedAmount)) return expectedAmount;

    const standalone = [...clean.matchAll(/(?<![\d.])(\d{1,5})(?:\.00)?(?![\d.])/g)].map((m) => Number(m[1]));
    if (standalone.includes(expectedAmount)) return expectedAmount;

    // "₹25" misread as "225" / "%25" etc. — accept a number ending in the expected price after a stray digit.
    const misread = standalone.find((n) => String(n).length === String(expectedAmount).length + 1
        && String(n).slice(1) === String(expectedAmount) && String(n)[0] === '2');
    if (misread) return expectedAmount;

    if (marked.length) return marked[0];

    // Payment apps show the amount big on a line of its own ("₹10" read as "10") — report
    // that, so the buyer hears "paid ₹10, expected ₹25" rather than "not readable".
    const ownLine = text.split('\n')
        .map((line) => /^\s*(?:₹|rs\.?|inr|%|z|f)?\s*(\d{1,5})(?:\.\d{2})?\s*$/i.exec(line))
        .find(Boolean);
    return ownLine ? Number(ownLine[1]) : null;
}

function to24h(hour, minute, meridiem) {
    let h = Number(hour);
    const m = String(meridiem || '').toLowerCase();
    if (m === 'pm' && h < 12) h += 12;
    if (m === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function istToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
}

/** Payment date/time as "YYYY-MM-DD HH:mm" (IST), or null. */
function detectDateTime(text) {
    const times = [...text.matchAll(/(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm)?/gi)]
        .filter((t) => Number(t[1]) <= 23 && Number(t[2]) <= 59);
    if (!times.length) return null;

    const monthRe = MONTHS.join('|');
    let y; let mo; let d;
    let m = text.match(new RegExp(`(\\d{1,2})\\s*(${monthRe})[a-z]*\\.?,?\\s*(\\d{4})?`, 'i'));
    if (m) { d = m[1]; mo = MONTHS.indexOf(m[2].toLowerCase()) + 1; y = m[3]; }
    if (!m) {
        m = text.match(new RegExp(`(${monthRe})[a-z]*\\.?\\s*(\\d{1,2}),?\\s*(\\d{4})?`, 'i'));
        if (m) { mo = MONTHS.indexOf(m[1].toLowerCase()) + 1; d = m[2]; y = m[3]; }
    }
    if (!m) {
        m = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
        if (m) { d = m[1]; mo = Number(m[2]); y = m[3].length === 2 ? `20${m[3]}` : m[3]; }
    }

    // The phone's status-bar clock is also a time; prefer the one printed next to the date.
    const pick = m
        ? times.reduce((best, t) => (Math.abs(t.index - m.index) < Math.abs(best.index - m.index) ? t : best))
        : times[times.length > 1 ? 1 : 0];
    const hhmm = to24h(pick[1], pick[2], pick[3]);

    if (!m) return `${istToday()} ${hhmm}`; // only a time is shown — assume today
    const year = y || istToday().slice(0, 4);
    return `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${hhmm}`;
}

function normalizeForMatch(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Read a screenshot and return fields in the same shape Claude returns.
 * `expected` = { amount, upiId, payeeName } helps resolve OCR ambiguity.
 */
async function extractPaymentDetails(imageBuffer, expected) {
    let text = await readText(imageBuffer);
    if (detectAmount(text, expected.amount) !== expected.amount) {
        text += `\n${await readText(imageBuffer, '11')}`;
    }
    const flat = normalizeForMatch(text);

    const upiSeen = expected.upiId && flat.includes(normalizeForMatch(expected.upiId));
    const nameSeen = expected.payeeName && flat.includes(normalizeForMatch(expected.payeeName));
    const status = detectStatus(text);
    const transactionId = detectUtr(text);
    const amount = detectAmount(text, expected.amount);

    return {
        details: {
            is_payment_screenshot: Boolean((status !== 'unknown' || transactionId) && (amount !== null || upiSeen || nameSeen)),
            app: detectApp(text),
            status,
            amount,
            payee_upi: upiSeen ? expected.upiId : null,
            payee_name: nameSeen ? expected.payeeName : null,
            transaction_id: transactionId,
            payment_datetime: detectDateTime(text),
            signs_of_editing: 'none', // OCR cannot judge this
        },
        text,
    };
}

async function shutdown() {
    if (!workerPromise) return;
    try { (await workerPromise).terminate(); } catch (_) { /* ignore */ }
    workerPromise = null;
}

module.exports = { extractPaymentDetails, shutdown, detectAmount, detectDateTime, detectUtr, detectStatus };
