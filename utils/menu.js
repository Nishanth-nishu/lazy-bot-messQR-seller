'use strict';

const readline = require('readline');
const config = require('./config');

function createInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
}

function ask(rl, question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
    });
}

function parseIntegerOrDefault(input, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (input === '') return fallback;

    const parsed = Number.parseInt(input, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function safeRepeat(count) {
    return ' '.repeat(Math.max(0, count));
}

function formatIndexedOptions(options) {
    return options.map((label, index) => `[${index}] ${label}`).join(' / ');
}

function parseIndexedChoice(input, options, defaultIndex) {
    if (!Array.isArray(options) || options.length === 0) return null;
    if (input === '') return options[defaultIndex] ?? options[0];

    const index = Number.parseInt(input, 10);
    if (!Number.isFinite(index) || index < 0 || index >= options.length) {
        return options[defaultIndex] ?? options[0];
    }

    return options[index];
}

/**
 * Detect the meal type based on current time.
 */
function detectMeal() {
    const nowInIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const nowMins = nowInIst.getHours() * 60 + nowInIst.getMinutes();

    for (const [meal, { start, end }] of Object.entries(config.MEAL_TIMINGS)) {
        const [eH, eM] = end.split(':').map(Number);
        // Pick the first meal whose end time hasn't passed yet
        if (nowMins < eH * 60 + eM) return meal;
    }
    return config.DEFAULT_MEAL;
}

async function showMenu() {
    const rl = createInterface();

    console.log(`
══════════════════════════════════════
      🍽️  Mess QR Selling Bot         
══════════════════════════════════════
`);

    console.log('📝 Settings (press Enter to use default)\n');

    // 1. Starting price
    const priceInput = await ask(rl, `  Starting price? (default: ${config.DEFAULT_PRICE}): `);
    const price = parseIntegerOrDefault(priceInput, config.DEFAULT_PRICE, { min: 1, max: 500 });

    // 2. Negotiation
    const negoInput = await ask(rl, `  Enable negotiation? [0=No / 1=Yes] (default: 0): `);
    const enableNegotiation = negoInput === '1';

    // 3. Meal type
    const detectedMeal = detectMeal();
    const mealOptions = ['breakfast', 'lunch', 'dinner'];
    const detectedMealIndex = Math.max(0, mealOptions.indexOf(detectedMeal));
    const mealInput = await ask(
        rl,
        `  Meal type? ${formatIndexedOptions(mealOptions)} (default: ${detectedMealIndex}): `
    );
    const meal = parseIndexedChoice(mealInput, mealOptions, detectedMealIndex);

    // 4. Mess name
    const messOptions = config.MESS_NAMES;
    const defaultMessIndex = Math.max(0, messOptions.findIndex((name) => name === config.DEFAULT_MESS));
    const messInput = await ask(
        rl,
        `  Mess name? ${formatIndexedOptions(messOptions)} (default: ${defaultMessIndex}): `
    );
    const mess = parseIndexedChoice(messInput, messOptions, defaultMessIndex);

    // 5. Number of messages
    const numInput = await ask(rl, `  Number of messages to send? (default: ${config.DEFAULT_NUM_MESSAGES}): `);
    const numMessages = parseIntegerOrDefault(numInput, config.DEFAULT_NUM_MESSAGES, { min: 1, max: 24 });

    rl.close();

    console.clear();
    
    console.log(`
══════════════════════════════════════
      🍽️  Mess QR Selling Bot         
══════════════════════════════════════

──────────────────────────────────────
  ✅ Settings applied          
──────────────────────────────────────
  Negotiation : ${enableNegotiation ? 'Yes' : 'No'}${safeRepeat(21 - (enableNegotiation ? 3 : 2))}
  Price       : ₹${price}${safeRepeat(20 - String(price).length)}
  Meal        : ${meal.charAt(0).toUpperCase() + meal.slice(1)}${safeRepeat(22 - meal.length)}
  Mess        : ${mess}${safeRepeat(22 - mess.length)}
  Messages    : ${numMessages}${safeRepeat(22 - String(numMessages).length)}
──────────────────────────────────────
`);

    return {
        mode: 'SELLING',
        ENABLE_NEGOTIATION: enableNegotiation,
        DEFAULT_PRICE: price,
        _meal: meal,
        _mess: mess,
        _numMessages: numMessages,
    };
}

/**
 * Settings for unattended daily runs (AUTO_DAILY=true): no questions, just Setting.txt defaults.
 */
function defaultOptions() {
    console.log(`🤖 AUTO_DAILY is on — selling ${config.DEFAULT_MESS} ${config.DEFAULT_MEAL} at ₹${config.DEFAULT_PRICE} every day (no setup questions).\n`);
    return {
        mode: 'SELLING',
        ENABLE_NEGOTIATION: config.ENABLE_NEGOTIATION,
        DEFAULT_PRICE: config.DEFAULT_PRICE,
        _meal: config.DEFAULT_MEAL,
        _mess: config.DEFAULT_MESS,
        _numMessages: config.DEFAULT_NUM_MESSAGES,
    };
}

module.exports = { showMenu, defaultOptions };
