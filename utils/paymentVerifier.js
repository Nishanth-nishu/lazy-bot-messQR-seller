'use strict';

const fs = require('fs');
const path = require('path');
const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;
const config = require('./config');
const ocrReader = require('./ocrReader');

const CLAUDE_RETRY_AFTER_MS = 30 * 60 * 1000;
let claudeSkipUntil = 0;

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const LEDGER_HEADER = 'utr,phone,name,amount,verified_at,method\n';

let anthropicClient = null;
function getClient() {
    if (!anthropicClient) anthropicClient = new Anthropic();
    return anthropicClient;
}

// ─── What Claude must extract from the screenshot ───────────
// Claude only reads the screenshot; every pass/fail decision is made in code below.
const EXTRACTION_SCHEMA = {
    type: 'object',
    properties: {
        is_payment_screenshot: { type: 'boolean' },
        app: { type: 'string' },
        status: { type: 'string', enum: ['success', 'pending', 'failed', 'unknown'] },
        amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        payee_upi: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        payee_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        transaction_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        payment_datetime: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        signs_of_editing: { type: 'string' },
    },
    required: [
        'is_payment_screenshot', 'app', 'status', 'amount', 'payee_upi',
        'payee_name', 'transaction_id', 'payment_datetime', 'signs_of_editing',
    ],
    additionalProperties: false,
};

function nowIstString(date = new Date()) {
    return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function buildPrompt() {
    return [
        'This image was sent by a buyer as proof of a UPI payment (GPay, PhonePe, Paytm, BHIM, a bank app, etc.).',
        'Read it and fill the fields exactly as they appear. Do not guess: use null when a field is not visible.',
        '',
        '- is_payment_screenshot: true only if this is a payment receipt/confirmation screen.',
        '- app: the payment app name, or "unknown".',
        '- status: "success" only if the screen clearly shows the payment completed/successful/transferred/paid.',
        '- amount: the rupee amount paid, as a number.',
        '- payee_upi: the UPI ID the money was sent TO (not the sender).',
        '- payee_name: the name of the person the money was sent TO.',
        '- transaction_id: the UPI transaction ID / UTR / UPI Ref No. (prefer the 12-digit UTR when shown).',
        `- payment_datetime: when the payment was made, as "YYYY-MM-DD HH:mm" in IST. It is now ${nowIstString()} IST; if only a time is shown, assume today.`,
        '- signs_of_editing: describe anything that suggests the image was edited or faked (mismatched fonts, misaligned text, inconsistent values), or "none".',
    ].join('\n');
}

/**
 * Ask Claude to read a payment screenshot. Returns the extracted fields, or throws.
 */
async function extractPaymentDetails(base64Data, mimeType) {
    const response = await getClient().beta.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
            effort: 'medium',
            format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
        },
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
                    { type: 'text', text: buildPrompt() },
                ],
            },
        ],
    });

    if (response.stop_reason === 'refusal') {
        throw new Error('Claude declined to read the screenshot');
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('Claude returned no text');
    return JSON.parse(textBlock.text);
}

// ─── Used UTR ledger (stops the same screenshot being reused) ──

function ensureLedgerFile(filePath = config.USED_UTR_CSV_PATH) {
    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, LEDGER_HEADER, 'utf8');
    }
}

function normalizeUtr(value) {
    return String(value || '').replace(/[^0-9a-z]/gi, '').toUpperCase();
}

function isUtrUsed(utr, filePath = config.USED_UTR_CSV_PATH) {
    const target = normalizeUtr(utr);
    if (!target || !fs.existsSync(filePath)) return false;
    return fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .slice(1)
        .some((line) => normalizeUtr(line.split(',')[0]) === target);
}

function recordUtr({ utr, phone, name, amount, method }, filePath = config.USED_UTR_CSV_PATH) {
    const cleanUtr = normalizeUtr(utr);
    if (!cleanUtr) return;
    ensureLedgerFile(filePath);
    const safe = (v) => String(v ?? '').replace(/[,\r\n]/g, ' ');
    const row = [cleanUtr, safe(phone), safe(name), safe(amount), nowIstString(), safe(method)].join(',');
    fs.appendFileSync(filePath, row + '\n', 'utf8');
}

// ─── Checks ─────────────────────────────────────────────────

function normalizeName(value) {
    return String(value || '').toLowerCase().replace(/[^a-z]/g, '');
}

function payeeMatches(details) {
    const expectedUpi = (config.UPI_ID || '').trim().toLowerCase();
    const seenUpi = (details.payee_upi || '').trim().toLowerCase();
    if (expectedUpi && seenUpi && seenUpi === expectedUpi) return true;

    const expectedName = normalizeName(config.PAYEE_NAME);
    const seenName = normalizeName(details.payee_name);
    if (expectedName && seenName && (seenName.includes(expectedName) || expectedName.includes(seenName))) return true;

    return false;
}

function parseIstDateTime(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!match) return null;
    const [, y, mo, d, h, mi] = match;
    const parsed = new Date(`${y}-${mo}-${d}T${h}:${mi}:00+05:30`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeExpected(expected) {
    if (typeof expected === 'number') return { amount: expected, exact: false, notBefore: null, notAfter: null };
    return { exact: true, notBefore: null, notAfter: null, ...expected };
}

function timeLabel(date) {
    return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
}

/**
 * Decide whether the extracted details prove the payment.
 * `expected` is either an amount (paid at least this, within PAYMENT_MAX_AGE_MINUTES), or
 * { amount, notBefore, notAfter } — paid exactly `amount` between the deal time and the window end.
 * Returns { verified, reasons[] }.
 */
function evaluate(details, expected) {
    const reasons = [];
    const { amount: expectedAmount, exact, notBefore, notAfter } = normalizeExpected(expected);

    if (!details.is_payment_screenshot) {
        return { verified: false, reasons: ['not a payment screenshot'] };
    }
    // OCR sometimes misses the "Completed" word (icons, dark mode). Pending/failed are still
    // caught explicitly; "unknown" from OCR is allowed when every other check below passes.
    const statusOk = details.status === 'success' || (details.reader === 'ocr' && details.status === 'unknown');
    if (!statusOk) reasons.push(`payment status is "${details.status}"`);

    if (!Number.isFinite(details.amount)) reasons.push('amount not readable');
    else if (exact ? details.amount !== expectedAmount : details.amount < expectedAmount) {
        reasons.push(`paid ₹${details.amount}, the agreed price is ₹${expectedAmount}`);
    }

    if (!payeeMatches(details)) {
        reasons.push(`paid to ${details.payee_upi || details.payee_name || 'unknown payee'}, not to seller`);
    }

    if (!details.transaction_id) reasons.push('transaction ID / UTR not visible');
    else if (isUtrUsed(details.transaction_id)) reasons.push('this transaction ID was already used');

    const paidAt = parseIstDateTime(details.payment_datetime);
    if (!paidAt) {
        reasons.push('payment time not readable');
    } else if (notBefore || notAfter) {
        // Screenshots show minutes only, so compare whole minutes with a minute of slack.
        const MINUTE = 60 * 1000;
        const start = notBefore ? Math.floor(notBefore.getTime() / MINUTE) * MINUTE - MINUTE : -Infinity;
        const end = notAfter ? notAfter.getTime() + MINUTE : Infinity;
        if (paidAt.getTime() < start) reasons.push(`paid at ${timeLabel(paidAt)}, before we agreed the price (${timeLabel(notBefore)})`);
        else if (paidAt.getTime() > end) reasons.push(`paid at ${timeLabel(paidAt)}, after the payment window closed (${timeLabel(notAfter)})`);
    } else {
        const ageMinutes = (Date.now() - paidAt.getTime()) / 60000;
        // Allow a few minutes of clock skew into the future.
        if (ageMinutes > config.PAYMENT_MAX_AGE_MINUTES) reasons.push(`payment is ${Math.round(ageMinutes)} min old`);
        else if (ageMinutes < -5) reasons.push('payment time is in the future');
    }

    const editing = (details.signs_of_editing || '').trim();
    if (editing && editing.toLowerCase() !== 'none') reasons.push(`possible editing: ${editing}`);

    return { verified: reasons.length === 0, reasons };
}

/**
 * Full pipeline for one WhatsApp media message.
 * Returns { verified, reasons[], details|null, error|null }.
 */
async function verifyScreenshot(media, expected) {
    const expectedAmount = normalizeExpected(expected).amount;
    const mimeType = (media?.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!media?.data || !SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
        return { verified: false, reasons: ['not an image'], details: null, error: null };
    }

    let details = null;
    let reader = null;
    const errors = [];

    // SCREENSHOT_READER: "auto" (Claude if it works, else free OCR), "claude", or "ocr".
    const mode = (config.SCREENSHOT_READER || 'auto').toLowerCase();
    const claudeAllowed = mode !== 'ocr' && process.env.ANTHROPIC_API_KEY && Date.now() >= claudeSkipUntil;
    if (claudeAllowed) {
        try {
            details = await extractPaymentDetails(media.data, mimeType);
            reader = 'claude';
        } catch (err) {
            errors.push(`Claude: ${err.message}`);
            claudeSkipUntil = Date.now() + CLAUDE_RETRY_AFTER_MS; // e.g. no credits — don't retry on every screenshot
            console.warn(`⚠️  [Verifier] Claude unavailable, using free OCR for the next ${CLAUDE_RETRY_AFTER_MS / 60000} min: ${err.message}`);
        }
    }
    if (!details && mode !== 'claude') {
        try {
            ({ details } = await ocrReader.extractPaymentDetails(Buffer.from(media.data, 'base64'), {
                amount: expectedAmount,
                upiId: config.UPI_ID,
                payeeName: config.PAYEE_NAME,
            }));
            reader = 'ocr';
        } catch (err) {
            errors.push(`OCR: ${err.message}`);
        }
    }
    if (!details) {
        console.error('❌ [Verifier] Could not read screenshot:', errors.join(' | '));
        return { verified: false, reasons: ['automatic check unavailable'], details: null, error: errors.join(' | ') };
    }
    details.reader = reader;

    const { verified, reasons } = evaluate(details, expected);
    console.log(`🔍 [Verifier] ${verified ? 'VERIFIED' : 'NOT verified'}: ${JSON.stringify(details)}${reasons.length ? ` — ${reasons.join('; ')}` : ''}`);
    return { verified, reasons, details, error: null };
}

module.exports = {
    verifyScreenshot,
    evaluate,
    recordUtr,
    isUtrUsed,
    ensureLedgerFile,
    SUPPORTED_IMAGE_TYPES,
};
