'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SETTINGS_FILE_PATH = path.resolve(PROJECT_ROOT, 'Setting.txt');
const ENV_FILE_PATH = path.resolve(PROJECT_ROOT, '.env');

// ─── Load .env (secrets such as ANTHROPIC_API_KEY) ──────────

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) continue;
        const key = trimmed.slice(0, separatorIndex).trim();
        const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '');
        if (key && process.env[key] === undefined) process.env[key] = value;
    }
}

loadEnvFile(ENV_FILE_PATH);

// ─── Parse Setting.txt ─────────────────────────────────────

function parseSettingsFile(filePath) {
    if (!fs.existsSync(filePath)) {
        // Fresh clone: Setting.txt is personal and git-ignored — start from the template.
        const example = path.resolve(PROJECT_ROOT, 'Setting.example.txt');
        if (!fs.existsSync(example)) throw new Error(`Missing Setting.txt at ${filePath}`);
        fs.copyFileSync(example, filePath);
        console.warn('⚠️  Created Setting.txt from Setting.example.txt — fill in your UPI ID, numbers and groups, then restart.');
    }

    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split(/\r?\n/);
    const parsed = {};

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) continue;

        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        parsed[key] = value;
    }

    return parsed;
}

// ─── Helpers ────────────────────────────────────────────────

function decodeText(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function getText(raw, key) {
    return decodeText(raw[key]);
}

function getNumber(raw, key) {
    const value = raw[key];
    if (value === undefined || value === '') return 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function getBoolean(raw, key) {
    const value = raw[key];
    if (value === undefined || value === '') return false;
    const normalized = value.trim().toLowerCase();
    return ['true', '1', 'yes', 'y', 'on'].includes(normalized);
}

function getList(raw, key) {
    const value = raw[key];
    if (value === undefined || value.trim() === '') return [];
    return value
        .split(',')
        .map((item) => decodeText(item).trim())
        .filter(Boolean);
}

function resolveProjectPath(rawValue) {
    const normalized = (rawValue || '').trim();
    if (!normalized) return '';
    if (path.isAbsolute(normalized)) return normalized;
    return path.resolve(PROJECT_ROOT, normalized);
}

function resolveQRImagePath(rawValue) {
    const normalized = (rawValue || '').trim();
    const defaultPath = path.resolve(PROJECT_ROOT, 'utils');
    const targetPath = normalized ? (path.isAbsolute(normalized) ? normalized : path.resolve(PROJECT_ROOT, normalized)) : defaultPath;

    const imgExts = ['.png', '.jpg', '.jpeg', '.webp'];

    if (fs.existsSync(targetPath)) {
        const stats = fs.statSync(targetPath);
        if (stats.isFile() && imgExts.includes(path.extname(targetPath).toLowerCase())) {
            return targetPath;
        }
        if (stats.isDirectory()) {
            const files = fs.readdirSync(targetPath);
            for (const file of files) {
                if (imgExts.includes(path.extname(file).toLowerCase())) {
                    return path.join(targetPath, file);
                }
            }
        }
    }

    // Fallback: search the 'utils' directory for ANY image
    if (fs.existsSync(defaultPath)) {
        const files = fs.readdirSync(defaultPath);
        for (const file of files) {
            if (imgExts.includes(path.extname(file).toLowerCase())) {
                return path.join(defaultPath, file);
            }
        }
    }

    return targetPath;
}

function applyTemplate(template, variables) {
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
        if (!Object.prototype.hasOwnProperty.call(variables, key)) return match;
        return String(variables[key]);
    });
}

// ─── Read Setting.txt & build config ────────────────────────

const raw = parseSettingsFile(SETTINGS_FILE_PATH);

const settings = {
    TESTING: getBoolean(raw, 'TESTING'),
    TESTING_GROUP_NAME: getList(raw, 'TESTING_GROUP_NAME'),

    GROUP_NAMES: (() => {
        const testing = getBoolean(raw, 'TESTING');
        if (testing) {
            return getList(raw, 'TESTING_GROUP_NAME');
        }
        return getList(raw, 'GROUP_NAME').length ? getList(raw, 'GROUP_NAME') : getList(raw, 'GROUP_NAMES');
    })(),

    UPI_ID: getText(raw, 'UPI_ID'),
    PAYEE_NAME: getText(raw, 'PAYEE_NAME'),
    BOT_NUMBER: getText(raw, 'BOT_NUMBER'),
    UPI_QR_IMAGE_PATH: resolveProjectPath(getText(raw, 'UPI_QR_IMAGE_PATH')),
    ADMIN_NUMBER: getText(raw, 'ADMIN_NUMBER'),
    QR_IMAGE_PATH: resolveQRImagePath(raw.QR_IMAGE_PATH),

    MEAL_TIMINGS: {
        breakfast: {
            start: getText(raw, 'MEAL_BREAKFAST_START'),
            end: getText(raw, 'MEAL_BREAKFAST_END'),
        },
        lunch: {
            start: getText(raw, 'MEAL_LUNCH_START'),
            end: getText(raw, 'MEAL_LUNCH_END'),
        },
        dinner: {
            start: getText(raw, 'MEAL_DINNER_START'),
            end: getText(raw, 'MEAL_DINNER_END'),
        },
    },

    MESS_NAMES: getList(raw, 'MESS_NAMES'),
    DEFAULT_MEAL: getText(raw, 'DEFAULT_MEAL'),
    DEFAULT_MESS: getText(raw, 'DEFAULT_MESS'),
    DEFAULT_NUM_MESSAGES: getNumber(raw, 'DEFAULT_NUM_MESSAGES'),
    POST_INTERVAL_MINUTES: getNumber(raw, 'POST_INTERVAL_MINUTES'),
    PRICE_SCHEDULE: getText(raw, 'PRICE_SCHEDULE'),
    AUTO_DAILY: getBoolean(raw, 'AUTO_DAILY'),
    QR_REFRESH_TIME: getText(raw, 'QR_REFRESH_TIME') || '07:00',

    DEFAULT_PRICE: getNumber(raw, 'DEFAULT_PRICE'),
    PRICE_DROP: getNumber(raw, 'PRICE_DROP'),

    ENABLE_NEGOTIATION: getBoolean(raw, 'ENABLE_NEGOTIATION'),
    NEGOTIATION_MARGIN: getNumber(raw, 'NEGOTIATION_MARGIN'),
    NEGOTIATION_SCHEDULE: getText(raw, 'NEGOTIATION_SCHEDULE'),
    PAYMENT_WINDOW_MINUTES: getNumber(raw, 'PAYMENT_WINDOW_MINUTES') || 10,
    SCREENSHOT_GRACE_MINUTES: getNumber(raw, 'SCREENSHOT_GRACE_MINUTES') || 5,

    BUYER_INACTIVITY_MS: getNumber(raw, 'BUYER_INACTIVITY_MS'),
    BUYER_TIMEOUT_WARNING_MS: getNumber(raw, 'BUYER_TIMEOUT_WARNING_MS'),

    BUYER_KEYWORDS: getList(raw, 'BUYER_KEYWORDS'),
    DONE_KEYWORDS: getList(raw, 'DONE_KEYWORDS'),

    LOYALTY_TARGET: getNumber(raw, 'LOYALTY_TARGET') || 170,
    LOYALTY_CSV_PATH: resolveProjectPath(getText(raw, 'LOYALTY_CSV_PATH')) || resolveProjectPath('utils/purchases.csv'),

    ANTHROPIC_MODEL: getText(raw, 'ANTHROPIC_MODEL') || 'claude-opus-5-5',
    SCREENSHOT_READER: getText(raw, 'SCREENSHOT_READER') || 'auto',
    PAYMENT_MAX_AGE_MINUTES: getNumber(raw, 'PAYMENT_MAX_AGE_MINUTES') || 30,
    MAX_VERIFY_ATTEMPTS: getNumber(raw, 'MAX_VERIFY_ATTEMPTS') || 3,
    MAX_BUYER_MESSAGE_LENGTH: getNumber(raw, 'MAX_BUYER_MESSAGE_LENGTH') || 80,
    MANUAL_PAUSE_MINUTES: getNumber(raw, 'MANUAL_PAUSE_MINUTES') || 180,
    USED_UTR_CSV_PATH: resolveProjectPath(getText(raw, 'USED_UTR_CSV_PATH')) || resolveProjectPath('utils/used_utrs.csv'),
};

// ─── Template message functions ─────────────────────────────

settings.sellMessage = (messName, mealType, price) =>
    applyTemplate(getText(raw, 'SELL_MESSAGE_TEMPLATE'), {
        messName,
        mealType,
        mealTypeCapitalized: mealType.charAt(0).toUpperCase() + mealType.slice(1),
        price,
    });

settings.paymentInstructionMessage = (price) =>
    applyTemplate(getText(raw, 'PAYMENT_INSTRUCTION_MESSAGE'), { price, minutes: settings.PAYMENT_WINDOW_MINUTES });
settings.confirmPromptMessage = (price) =>
    applyTemplate(getText(raw, 'CONFIRM_PROMPT_MESSAGE'), { price });
settings.confirmedMessage = (price, minutes) =>
    applyTemplate(getText(raw, 'CONFIRMED_MESSAGE'), { price, minutes });
settings.paymentWindowExpiredMessage = (minutes) =>
    applyTemplate(getText(raw, 'PAYMENT_WINDOW_EXPIRED_MESSAGE'), { minutes });
settings.priceLockedMessage = (price) =>
    applyTemplate(getText(raw, 'PRICE_LOCKED_MESSAGE'), { price });
settings.soldMessage = () => getText(raw, 'SOLD_MESSAGE');
settings.unrecognizedMessage = () => getText(raw, 'UNRECOGNIZED_MESSAGE');
settings.timeoutWarningMessage = () => getText(raw, 'TIMEOUT_WARNING_MESSAGE');
settings.timeoutFinalMessage = () => getText(raw, 'TIMEOUT_FINAL_MESSAGE');

settings.saleConfirmMessage = (buyerName, mealType, loyaltyStatus = '') =>
    applyTemplate(getText(raw, 'SALE_CONFIRM_MESSAGE'), { buyerName, mealType, loyaltyStatus });

settings.freeMealAssignMessage = (buyerName = '', mealType = '') =>
    applyTemplate(getText(raw, 'FREE_MEAL_ASSIGN_MESSAGE'), { buyerName, mealType });

settings.freeMealConfirmMessage = (buyerName, mealType) =>
    applyTemplate(getText(raw, 'FREE_MEAL_CONFIRM_MESSAGE'), { buyerName, mealType });

settings.loyaltyProgressMessage = (totalSpent, target, remaining) =>
    applyTemplate(getText(raw, 'LOYALTY_PROGRESS_TEMPLATE'), { totalSpent, target, remaining });

settings.loyaltyReachedMessage = (target) =>
    applyTemplate(getText(raw, 'LOYALTY_REACHED_TEMPLATE'), { target });

settings.testRevertedMessage = () => getText(raw, 'TEST_REVERTED_MESSAGE');

// ─── Payment screenshot verification messages ───────────────
settings.screenshotRequiredMessage = () => getText(raw, 'SCREENSHOT_REQUIRED_MESSAGE');
settings.screenshotCheckingMessage = () => getText(raw, 'SCREENSHOT_CHECKING_MESSAGE');
settings.screenshotStillCheckingMessage = () => getText(raw, 'SCREENSHOT_STILL_CHECKING_MESSAGE');
settings.screenshotVerifiedMessage = (amount) =>
    applyTemplate(getText(raw, 'SCREENSHOT_VERIFIED_MESSAGE'), { amount });
settings.screenshotReviewMessage = (reason) =>
    applyTemplate(getText(raw, 'SCREENSHOT_REVIEW_MESSAGE'), { reason });
settings.screenshotNotImageMessage = () => getText(raw, 'SCREENSHOT_NOT_IMAGE_MESSAGE');
settings.screenshotRetryMessage = (reason, attemptsLeft) =>
    applyTemplate(getText(raw, 'SCREENSHOT_RETRY_MESSAGE'), { reason, attemptsLeft });
settings.reviewPendingMessage = () => getText(raw, 'REVIEW_PENDING_MESSAGE');
settings.adminApprovedMessage = () => getText(raw, 'ADMIN_APPROVED_MESSAGE');
settings.adminRejectedMessage = () => getText(raw, 'ADMIN_REJECTED_MESSAGE');
settings.adminReviewCaption = (vars) => applyTemplate(getText(raw, 'ADMIN_REVIEW_CAPTION'), vars);

settings.negotiationAcceptedMessage = (price) =>
    applyTemplate(getText(raw, 'NEGOTIATION_ACCEPTED_MESSAGE'), { price });

settings.negotiationDisabledMessage = (price) =>
    applyTemplate(getText(raw, 'NEGOTIATION_DISABLED_MESSAGE') || 'Sorry, price is fixed at ₹{price} (negotiation is not possible).', { price });

settings.negotiationCounterOfferMessage = (price) =>
    applyTemplate(getText(raw, 'NEGOTIATION_COUNTER_OFFER_MESSAGE') || 'I can accept up to ₹{price} for this meal.', { price });

settings.payViaPhoneMessage = (price, upi = settings.UPI_ID) =>
    applyTemplate(getText(raw, 'PAY_VIA_PHONE_MESSAGE') || 'Pay ₹{price} to same no or {UPI}', {
        price,
        phone: '',
        UPI: (typeof upi === 'string' && upi.length > 0) ? upi : settings.UPI_ID,
        upi: (typeof upi === 'string' && upi.length > 0) ? upi : settings.UPI_ID,
    });

// ─── Runtime overrides (from CLI menu) ──────────────────────

function applyOverrides(overrides) {
    for (const [key, value] of Object.entries(overrides)) {
        if (key in settings && typeof settings[key] !== 'function') {
            settings[key] = value;
        }
    }
}

module.exports = settings;
module.exports.applyOverrides = applyOverrides;
module.exports.SETTINGS_FILE_PATH = SETTINGS_FILE_PATH;
