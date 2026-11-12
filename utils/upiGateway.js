'use strict';

const config = require('./config');

// Self-hosted UPI Gateway (https://github.com/mynkdev-21/upi-gateway), run next to the bot.
// For each buyer the bot creates a gateway order for the agreed price and sends the QR of
// the order's UPI link. It then asks the gateway every GATEWAY_POLL_SECONDS whether the
// order is paid:
//   - "Paytm for Business" account in the gateway → the gateway checks Paytm itself and the
//     order turns "paid" on its own; the meal QR goes out with no screenshot.
//   - "Any UPI ID (manual)" account → the gateway can't see payments; the order only turns
//     "paid" when you confirm it in the gateway dashboard. The buyer's screenshot is still
//     checked by the bot as usual, so either one completes the sale.
// Keys live in .env: UPI_GATEWAY_API_KEY and UPI_GATEWAY_API_SECRET (dashboard → API keys).

const REQUEST_TIMEOUT_MS = 10000;

function getKeys() {
    return {
        key: (process.env.UPI_GATEWAY_API_KEY || '').trim(),
        secret: (process.env.UPI_GATEWAY_API_SECRET || '').trim(),
    };
}

/** True when PAYMENT_GATEWAY=upi_gateway and both keys are in .env. */
function isEnabled() {
    const { key, secret } = getKeys();
    return config.PAYMENT_GATEWAY === 'upi_gateway' && Boolean(key && secret);
}

/** Sandbox keys start with test_key_; their orders are never real payments. */
function isTestMode() {
    return getKeys().key.startsWith('test_key_');
}

function baseUrl() {
    return String(config.UPI_GATEWAY_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
}

async function request(method, apiPath, body) {
    const { key, secret } = getKeys();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${baseUrl()}/api/v1${apiPath}`, {
            method,
            headers: {
                'X-Api-Key': key,
                'X-Api-Secret': secret,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const firstError = data?.errors && Object.values(data.errors)[0];
            throw new Error(`UPI Gateway ${res.status}: ${(Array.isArray(firstError) ? firstError[0] : null) || data?.message || res.statusText}`);
        }
        return data?.data || {};
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`UPI Gateway did not answer in ${REQUEST_TIMEOUT_MS / 1000}s (is it running at ${baseUrl()}?)`);
        if (err.cause?.code === 'ECONNREFUSED') throw new Error(`UPI Gateway is not running at ${baseUrl()}`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function toOrder(data) {
    return {
        id: data.order_id,
        clientOrderId: data.client_order_id,
        amount: Number(data.amount),
        status: data.status,          // pending | paid | review | expired | failed
        utr: data.utr || null,
        upiIntent: data.upi_intent || null,
        paymentUrl: data.payment_url || null,
        test: Boolean(data.test),
    };
}

/** New order for exactly `amountRupees`; the returned upiIntent is what the QR encodes. */
async function createOrder({ amountRupees, buyerName, buyerPhone }) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const body = {
        amount: Number(Number(amountRupees).toFixed(2)),
        client_order_id: `MEAL-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
    };
    if (buyerName) body.customer_name = String(buyerName).slice(0, 100);
    const mobile = String(buyerPhone || '').replace(/\D/g, '').slice(-10);
    if (mobile.length === 10) body.customer_mobile = mobile;
    return toOrder(await request('POST', '/orders', body));
}

/** Latest state of an order; the gateway re-checks its payment provider on each call. */
async function getOrder(orderId) {
    return toOrder(await request('GET', `/orders/${encodeURIComponent(orderId)}`));
}

/** True if anything answers at the gateway's address. */
async function isUp() {
    try {
        await fetch(`${baseUrl()}/up`, { signal: AbortSignal.timeout(3000) });
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Start the gateway (start-gateway.cmd: MariaDB + the gateway) in the background if it isn't
 * running, and wait up to ~40 s for it. Returns true once it answers.
 */
async function ensureRunning() {
    if (await isUp()) return true;
    const path = require('path');
    const fs = require('fs');
    const script = path.resolve(__dirname, '..', 'start-gateway.cmd');
    if (process.platform !== 'win32' || !fs.existsSync(script)) return false;
    const { spawn } = require('child_process');
    const child = spawn('cmd.exe', ['/c', script], { cwd: path.dirname(script), detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await isUp()) return true;
    }
    return false;
}

module.exports = { isEnabled, isTestMode, createOrder, getOrder, baseUrl, isUp, ensureRunning };
