'use strict';

const config = require('./config');

let timers = [];
let currentPrice = null;
let stopped = false;

// Store arguments for restart
let storedSendMessageFn = null;
let storedOnStopFn = null;
let storedIsSoldFn = null;
let storedOpts = null;

let testingStartDate = null;

// The sale window: opens when the first post goes out (or the bot starts mid-window)
// and closes at the meal's stop time. Buyers are only engaged while it is open.
let windowOpenedAt = null;
let windowStopAt = null;

/** True while a listing is up in the groups and not yet sold or stopped. */
function isListingLive() {
    return Boolean(!stopped && windowOpenedAt && windowStopAt && Date.now() < windowStopAt.getTime());
}

/** True between today's first post and the stop time, even after a sale. */
function isWithinSaleWindow() {
    return Boolean(windowOpenedAt && windowStopAt && Date.now() < windowStopAt.getTime());
}

/**
 * Parse PRICE_SCHEDULE ("07:30=25, 09:00=20, 09:15=15") into steps sorted by time.
 */
function parsePriceSchedule() {
    return String(config.PRICE_SCHEDULE || '')
        .split(',')
        .map((part) => /^\s*(\d{1,2}):(\d{2})\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(part))
        .filter(Boolean)
        .map(([, h, m, price]) => ({ hour: Number(h), minute: Number(m), price: Number(price) }))
        .sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));
}

/** Price of the last schedule step at or before `when`, or null if none applies yet. */
function priceFromSchedule(steps, when) {
    const minutes = when.getHours() * 60 + when.getMinutes();
    let price = null;
    for (const step of steps) {
        if (step.hour * 60 + step.minute <= minutes) price = step.price;
    }
    return price;
}

/**
 * Compute equally-spaced send times between meal start and end.
 * @param {string} meal — 'breakfast', 'lunch', or 'dinner'
 * @param {number} numMessages — how many messages to schedule
 * @returns {{ times: Date[], stopTime: Date }}
 */
function computeSchedule(meal, numMessages) {
    const timing = config.MEAL_TIMINGS[meal];
    if (!timing) throw new Error(`Unknown meal type: ${meal}`);
    const safeNumMessages = Number.isFinite(numMessages) ? Math.max(1, Math.floor(numMessages)) : 1;

    const today = new Date();

    const startDate = new Date(today);
    const endDate = new Date(today);

    if (config.TESTING) {
        // In testing mode, start 60 seconds from now so the first message isn't skipped.
        // We preserve this start time globally so that if the scheduler restarts (e.g. buyer says "testing"),
        // the testing timeline isn't completely reset, allowing it to accurately resume the current price.
        if (!testingStartDate) {
            testingStartDate = new Date(today.getTime() + 60 * 1000);
        }
        console.log('🧪 [Scheduler] TESTING mode is ON — bypassing meal timing.');
        startDate.setTime(testingStartDate.getTime());
        // One post every 2 minutes, so there's time to pay and send a screenshot.
        endDate.setTime(testingStartDate.getTime() + safeNumMessages * 2 * 60 * 1000);
    } else {
        const [startH, startM] = timing.start.split(':').map(Number);
        const [endH, endM] = timing.end.split(':').map(Number);

        startDate.setHours(startH, startM, 0, 0);
        endDate.setHours(endH, endM, 0, 0);

        // If the meal window already ended today, schedule for tomorrow
        if (endDate.getTime() < Date.now()) {
            startDate.setDate(startDate.getDate() + 1);
            endDate.setDate(endDate.getDate() + 1);
        }
    }
    const totalMs = endDate.getTime() - startDate.getTime();
    const times = [];

    // Fixed gap (e.g. every 30 min from 07:30 until 09:30), outside testing mode.
    // Each PRICE_SCHEDULE change inside the window also gets its own post.
    const fixedIntervalMs = config.POST_INTERVAL_MINUTES > 0 ? config.POST_INTERVAL_MINUTES * 60 * 1000 : 0;
    if (!config.TESTING && fixedIntervalMs > 0) {
        const slots = new Set();
        for (let t = startDate.getTime(); t < endDate.getTime(); t += fixedIntervalMs) slots.add(t);
        for (const step of parsePriceSchedule()) {
            const at = new Date(startDate);
            at.setHours(step.hour, step.minute, 0, 0);
            if (at >= startDate && at < endDate) slots.add(at.getTime());
        }
        for (const t of [...slots].sort((a, b) => a - b)) times.push(new Date(t));
        return { times, stopTime: endDate };
    }

    const intervalMs = safeNumMessages > 1 ? totalMs / safeNumMessages : totalMs;
    for (let i = 0; i < safeNumMessages; i++) {
        times.push(new Date(startDate.getTime() + i * intervalMs));
    }

    return { times, stopTime: endDate };
}

/**
 * Start the dynamic scheduler.
 * @param {Function} sendMessageFn — async (text) => {}
 * @param {Function} onStopFn — called when auto-stop fires
 * @param {Function} isSoldFn — () => boolean
 * @param {object}   opts — { meal, mess, numMessages }
 */
function startScheduler(sendMessageFn, onStopFn, isSoldFn, opts) {
    stopped = false;
    currentPrice = Number.isFinite(config.DEFAULT_PRICE) && config.DEFAULT_PRICE > 0 ? config.DEFAULT_PRICE : 1;

    const meal = config.MEAL_TIMINGS[opts?.meal] ? opts.meal : config.DEFAULT_MEAL;
    const mess = typeof opts?.mess === 'string' && opts.mess.trim() ? opts.mess.trim() : config.DEFAULT_MESS;
    const numMessages = Number.isFinite(opts?.numMessages)
        ? Math.max(1, Math.floor(opts.numMessages))
        : Math.max(1, Math.floor(config.DEFAULT_NUM_MESSAGES));
    const normalizedOpts = { meal, mess, numMessages };

    // Save for a potential restart
    storedSendMessageFn = sendMessageFn;
    storedOnStopFn = onStopFn;
    storedIsSoldFn = isSoldFn;
    storedOpts = normalizedOpts;

    const { times, stopTime } = computeSchedule(meal, numMessages);
    const now = Date.now();
    windowOpenedAt = null;
    windowStopAt = stopTime;

    console.log(`💰 [Scheduler] Starting price: ₹${currentPrice}`);
    console.log(`📅 [Scheduler] Meal: ${meal} | Mess: ${mess} | Messages: ${times.length}`);
    console.log(`📅 [Scheduler] Schedule:`);

    let priceForStep = currentPrice;
    const priceDrop = Number.isFinite(config.PRICE_DROP) && config.PRICE_DROP > 0 ? config.PRICE_DROP : 0;

    // PRICE_SCHEDULE (e.g. "07:30=25, 09:00=20, 09:15=15") sets the price by time of day.
    // Without it, every post drops by PRICE_DROP.
    const priceSchedule = config.TESTING ? [] : parsePriceSchedule();

    for (let i = 0; i < times.length; i++) {
        const sendTime = times[i];
        const delayMs = sendTime.getTime() - now;
        const scheduled = priceFromSchedule(priceSchedule, sendTime);
        if (scheduled !== null) priceForStep = scheduled;
        const price = priceForStep;

        const timeStr = sendTime.toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
        });
        console.log(`   ⏰ ${timeStr} — ₹${price}`);

        if (delayMs > 0) {
            const timer = setTimeout(async () => {
                try {
                    if (stopped || isSoldFn()) {
                        console.log(`⏭️  [Scheduler] Skipping ₹${price} — already ${isSoldFn() ? 'sold' : 'stopped'}`);
                        return;
                    }
                    currentPrice = price;
                    if (!windowOpenedAt) windowOpenedAt = new Date();
                    const text = config.sellMessage(mess, meal, price);
                    console.log(`📤 [Scheduler] Sending: "${text}"`);
                    await sendMessageFn(text);
                } catch (err) {
                    console.error('❌ [Scheduler] Error sending price message:', err.message);
                }
            }, delayMs);

            timers.push(timer);
        } else {
            // Time already passed — skip this slot
            console.log(`   ⏭️  (skipped — time already passed)`);
            // Update the current price so that buyers messaging *now* get the correct active price
            currentPrice = price;
            // Started mid-window: earlier posts are already in the groups, so the listing is live.
            if (!windowOpenedAt && now < stopTime.getTime()) windowOpenedAt = sendTime;
        }

        if (!priceSchedule.length) priceForStep = Math.max(priceForStep - priceDrop, 0);
    }

    // Auto-stop timer
    const stopDelay = stopTime.getTime() - now;
    if (stopDelay > 0) {
        const stopTimer = setTimeout(async () => {
            try {
                if (stopped || isSoldFn()) return;
                console.log('🛑 [Scheduler] Stop time reached — shutting down.');
                stopScheduler();
                if (onStopFn) await onStopFn();
            } catch (err) {
                console.error('❌ [Scheduler] Error in stop handler:', err.message);
            }
        }, stopDelay);
        timers.push(stopTimer);

        const stopStr = stopTime.toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
        });
        console.log(`   🛑 Auto-stop at ${stopStr}`);
    }

    console.log('📅 [Scheduler] All timers registered.\n');
}

function stopScheduler() {
    stopped = true;
    for (const t of timers) {
        clearTimeout(t);
    }
    timers = [];
    console.log('🛑 [Scheduler] All timers stopped.');
}

function getCurrentPrice() { return currentPrice; }
function setCurrentPrice(price) { currentPrice = price; }
function getCurrentMeal() { return storedOpts ? storedOpts.meal : config.DEFAULT_MEAL; }

function restartScheduler() {
    console.log('🔄 [Scheduler] Restarting scheduler after un-sale...');
    stopScheduler();
    if (storedSendMessageFn && storedOpts) {
        startScheduler(storedSendMessageFn, storedOnStopFn, storedIsSoldFn, storedOpts);
    }
}

module.exports = {
    startScheduler, stopScheduler, getCurrentPrice, setCurrentPrice, getCurrentMeal, restartScheduler,
    isListingLive, isWithinSaleWindow,
};
