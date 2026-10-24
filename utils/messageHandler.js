'use strict';

const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const config = require('./config');
const { isBuyerKeyword, isDoneKeyword, isSellMessageSubstring } = require('./keywordMatcher');
const { isBlockedWid, isBlockedContact } = require('./blocklist');
const { extractPrice } = require('./priceParser');
const {
    getCurrentPrice, stopScheduler, getCurrentMeal, restartScheduler, isListingLive, isWithinSaleWindow,
} = require('./priceScheduler');
const botSends = require('./botSends');
const groupReactions = require('./groupReactions');
const loyalty = require('./loyalty');
const paymentVerifier = require('./paymentVerifier');
const diningPortal = require('./diningPortal');
const mediaDownload = require('./mediaDownload');

// ─── State ──────────────────────────────────────────────────
let sold = false;
// { id, name, phone, isFreeMeal, chatId, chat, assignedAt, agreedPrice,
//   paymentState: 'awaiting' | 'verifying' | 'review' | 'verified', lastCheck }
let currentBuyer = null;
let queueTimer = null;         // Timer that triggers moving to next buyer
let queueWarningTimer = null;  // Timer that warns current buyer before timeout
let reactOwnGroupMessages = false;
let allowTestingRevert = true;
let buyerQueue = [];
let stats = {
    messagesReceived: 0,
    negotiations: 0,
    soldPrice: null,
    buyerName: null,
    buyerId: null,
    timeSold: null,
    isFreeMeal: false,
    loyaltyRecord: null,
};

function isSold() { return sold; }

/**
 * A buyer who has sent a screenshot (being checked, waiting for the seller,
 * or already verified) has paid — never time them out or hand the meal to someone else.
 */
function buyerIsLocked() {
    return Boolean(currentBuyer && currentBuyer.paymentState && currentBuyer.paymentState !== 'awaiting');
}

// ─── Chats the owner is handling personally ─────────────────
// When you type to someone from your phone (not the bot), the bot keeps out of
// that chat for MANUAL_PAUSE_MINUTES so it never "sells" to someone you're dealing with.
const manualChats = new Map(); // chatId -> pause-until timestamp

function isManualChat(chatId) {
    const until = manualChats.get(chatId);
    if (!until) return false;
    if (Date.now() < until) return true;
    manualChats.delete(chatId);
    return false;
}

/** Call for every outgoing (fromMe) message; marks DMs you typed yourself. */
async function noteOwnMessage(msg) {
    if (!msg?.fromMe) return;
    const chatId = (msg.id && typeof msg.id.remote === 'string' ? msg.id.remote : null) || msg.to;
    if (!chatId || chatId.endsWith('@g.us') || chatId.endsWith('@broadcast') || chatId.endsWith('@newsletter')) return;
    if (globalClient && chatId === globalClient.info?.wid?._serialized) return; // "Message yourself"
    if (botSends.wasRecentlySentByBot(chatId)) return; // the bot's own message

    const firstTime = !isManualChat(chatId);
    manualChats.set(chatId, Date.now() + config.MANUAL_PAUSE_MINUTES * 60 * 1000);
    if (firstTime) console.log(`🤫 [Handler] You're chatting with ${chatId} yourself — bot stays out of that chat for ${config.MANUAL_PAUSE_MINUTES} min.`);

    buyerQueue = buyerQueue.filter((b) => b.chatId !== chatId && b.id !== chatId);
    if (currentBuyer && (currentBuyer.chatId === chatId || currentBuyer.id === chatId)) {
        console.log(`🤫 [Handler] Handing ${currentBuyer.name} over to you.`);
        releaseBuyer();
        await tryNextBuyer();
    }
}

/**
 * Extract quoted message text safely from incoming message.
 */
async function getQuotedText(msg) {
    if (!msg) return '';

    // Check synchronous properties on msg._data.quotedMsg (fastest)
    if (msg._data?.quotedMsg) {
        const qm = msg._data.quotedMsg;
        const text = qm.body || qm.caption || qm.text || '';
        if (typeof text === 'string' && text.trim().length > 0) {
            return text.trim();
        }
    }

    // Check msg.quotedMsg
    if (msg.quotedMsg) {
        const text = msg.quotedMsg.body || msg.quotedMsg.caption || '';
        if (typeof text === 'string' && text.trim().length > 0) {
            return text.trim();
        }
    }

    // Fallback: asynchronous call to getQuotedMessage()
    if (msg.hasQuotedMsg && typeof msg.getQuotedMessage === 'function') {
        try {
            const quoted = await msg.getQuotedMessage();
            if (quoted) {
                const text = quoted.body || quoted._data?.caption || quoted._data?.body || '';
                if (typeof text === 'string' && text.trim().length > 0) {
                    return text.trim();
                }
            }
        } catch (_) {
            // ignore
        }
    }

    return '';
}

// ═══════════════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleMessage(msg, client) {
    try {
        const senderId = msg.from;
        if (msg._data && msg._data.subtype === 'bot_typing_placeholder') {
            return;
        }

        // ── Blocklist: bail out before reading, replying or queueing ──
        if (isBlockedWid(senderId)) {
            console.log(`⛔ [Blocklist] Ignored message from ${senderId}.`);
            return;
        }

        let body = msg.body;
        if (!body && msg._data) {
            body = msg._data.body || msg._data.caption || msg._data.text || '';
        }
        // For photos/documents the body can be a base64 thumbnail — only the caption is text.
        if (msg.hasMedia && msg.type !== 'chat') {
            body = msg._data?.caption || '';
        }
        body = (body || '').trim();

        let contact = null;
        try {
            contact = await msg.getContact();
        } catch (_) {
            // Silently fallback if WhatsApp Web contact store is incomplete
        }
        const senderName = contact?.pushname || contact?.name || senderId;

        // ── Seller/admin replying APPROVE or REJECT to a forwarded screenshot ──
        if (await handleAdminCommand(msg, contact)) return;

        // A chat addressed by "@lid" hides the phone number in msg.from, so
        // re-check now that the contact has resolved it.
        if (isBlockedContact(contact)) {
            console.log(`⛔ [Blocklist] Ignored message from ${senderName} (${senderId}).`);
            return;
        }



        // ── Filter: only respond to personal DMs ────────────────
        if (senderId.endsWith('@broadcast') || senderId.endsWith('@g.us')) {
            return; // ignore status updates and group messages
        }
        const chat = await msg.getChat();

        const me = client.info.wid._serialized;
        if (senderId === me) return;

        // ── You're chatting with this person yourself — stay out of it ──
        const chatId = chat?.id?._serialized || senderId;
        if (isManualChat(chatId)) return;

        const quotedText = await getQuotedText(msg);
        const sellReplyMatch = isSellMessageSubstring(quotedText)
            ? quotedText
            : (isSellMessageSubstring(body) ? body : null);

        // Only short, first-hand messages can start a purchase: forwarded posts, long
        // texts (job ads, promos) and replies to some other message are not buyers.
        const isForwardedMsg = Boolean(msg.isForwarded || msg._data?.isForwarded);
        const quotesOtherMessage = Boolean(quotedText) && !isSellMessageSubstring(quotedText);
        const tooLong = body.length > config.MAX_BUYER_MESSAGE_LENGTH;
        const looksLikeBuyerMessage = !isForwardedMsg && !quotesOtherMessage && !tooLong;
        const isCurrentBuyer = Boolean(currentBuyer && senderId === currentBuyer.id);

        stats.messagesReceived++;
        const quoteLog = quotedText ? ` (reply to: "${quotedText.replace(/\r?\n/g, ' ')}")` : '';
        console.log(`📩 [Handler] DM from ${senderName}: "${body.length > 120 ? `${body.slice(0, 120)}…` : body}"${quoteLog}`);

        // ── Already sold ────────────────────────────────────────
        if (sold) {
            // Un-sell if the ACTUAL buyer types "testing"
            if (allowTestingRevert && stats.buyerId === senderId && body.toLowerCase() === 'testing') {
                await revertSale(chat, senderName);
                return;
            }

            // Only answer "sold" to people plausibly asking about today's listing.
            if (!looksLikeBuyerMessage || !isWithinSaleWindow()) return;

            const buyerKwSold = isBuyerKeyword(body);
            if (buyerKwSold || sellReplyMatch) {
                await chat.sendMessage(config.soldMessage());
                const trigger = buyerKwSold
                    ? `keyword: "${buyerKwSold}"`
                    : `sell message reply ("${sellReplyMatch.slice(0, 40)}")`;
                console.log(`🚫 [Handler] Replied "Sorry Sold" to ${senderName}. Triggered by ${trigger}`);
            }
            return;
        }

        // ── The current (first-in-line) buyer ────────────────────
        if (isCurrentBuyer) {
            if (!currentBuyer.phone) {
                const capturedPhone = extractPhoneNumberFromText(body);
                if (capturedPhone) {
                    currentBuyer.phone = capturedPhone;
                    console.log(`📱 [Handler] Captured buyer phone ${capturedPhone} from message text.`);
                }
            }
            currentBuyer.lastActivityAt = Date.now();
            await handleCurrentBuyerMessage(msg, chat, senderName, body, sellReplyMatch);
            return;
        }

        // ── New buyers only while a listing is up, and only from buyer-like messages ──
        if (!isListingLive() || !looksLikeBuyerMessage) {
            if (isBuyerKeyword(body) || sellReplyMatch) {
                const why = !isListingLive() ? 'no listing is live right now'
                    : isForwardedMsg ? 'forwarded message'
                        : quotesOtherMessage ? 'reply to a different message'
                            : 'message too long';
                console.log(`🙈 [Handler] Ignored ${senderName}: ${why}.`);
            }
            return;
        }

        // ── Someone wants it: the first one gets it, everyone else waits in line ──
        const buyerKw = isBuyerKeyword(body);
        const offer = offerFrom(body);
        const asksForLess = NEGOTIATION_REQUEST_RE.test(body);
        if (buyerKw || sellReplyMatch || offer !== null || asksForLess) {
            const trigger = buyerKw ? `keyword: "${buyerKw}"` : sellReplyMatch ? 'reply to sell message' : 'price offer';
            console.log(`🎯 [Handler] Buyer intent from ${senderName} (${trigger})`);
            await handleBuyerIntent(chat, senderId, senderName, client, contact,
                offer !== null ? offer : (asksForLess ? null : undefined));
        }
    } catch (err) {
        console.error('❌ [Handler] Error processing message:', err.message);
    }
}

/** A price someone offers in a message ("20?", "₹15 ok"), ignoring times like 7:45. */
function offerFrom(text) {
    const cleaned = String(text || '')
        .replace(/Sell\s+[\w\s()]+@(₹\s*)?\d+/i, '')
        .replace(/\d{1,2}[:.]\d{2}\s*(am|pm)?/gi, '')
        .replace(/\d{6,}/g, '');
    return extractPrice(cleaned);
}

/** Everything the first-in-line buyer says goes through here. */
async function handleCurrentBuyerMessage(msg, chat, senderName, body, sellReplyMatch) {
    const buyer = currentBuyer;

    if (buyer.isFreeMeal) {
        if (isDoneKeyword(body) || isConfirmation(body) || isBuyerKeyword(body) || sellReplyMatch
            || /^(claim|free|qr|dedo|bhejo|send)$/i.test(body.trim())) {
            console.log(`🎁 [Loyalty] Free meal claim signal from ${senderName}: "${body}"`);
            await completeSale(chat, senderName);
        }
        return;
    }

    if (msg.hasMedia) {
        await handleScreenshot(msg, chat, senderName);
        return;
    }

    const state = buyer.paymentState;
    if (state === 'verified') {
        if (isDoneKeyword(body) || isConfirmation(body)) await completeSale(chat, senderName);
        else await chat.sendMessage(config.screenshotVerifiedMessage(buyer.agreedPrice));
        return;
    }
    if (state === 'verifying') {
        if (isDoneKeyword(body)) await chat.sendMessage(config.screenshotStillCheckingMessage());
        return;
    }
    if (state === 'review') {
        if (isDoneKeyword(body)) await chat.sendMessage(config.reviewPendingMessage());
        return;
    }

    const offer = offerFrom(body);
    const asksForLess = NEGOTIATION_REQUEST_RE.test(body);

    if (state === 'confirmed') {
        // Price is agreed and the meal is held — no more bargaining.
        if (offer !== null && offer !== buyer.agreedPrice) {
            await chat.sendMessage(config.priceLockedMessage(buyer.agreedPrice));
        } else if (asksForLess) {
            await chat.sendMessage(config.priceLockedMessage(buyer.agreedPrice));
        } else if (isDoneKeyword(body)) {
            await chat.sendMessage(config.screenshotRequiredMessage());
        }
        return;
    }

    // state === 'awaiting': price offered, buyer hasn't said yes yet
    if (offer !== null && offer !== buyer.agreedPrice) {
        await handleNegotiation(buyer, offer);
    } else if (asksForLess && !isConfirmation(body)) {
        await handleNegotiation(buyer, null);
    } else if (isConfirmation(body) || isDoneKeyword(body) || offer === buyer.agreedPrice) {
        await confirmPurchase(buyer, `said "${body.slice(0, 30)}"`);
    } else {
        await askToConfirm(buyer);
        console.log(`❓ [Handler] Reminded ${senderName} to confirm ₹${buyer.agreedPrice}.`);
    }
}

// ═══════════════════════════════════════════════════════════════
//  BUYER INTENT
// ═══════════════════════════════════════════════════════════════

/**
 * Someone wants the meal. The first one becomes the current buyer; everyone after
 * waits silently in line (with any offer they made remembered for their turn).
 * `offer`: a number they offered, null if they just asked for less, undefined otherwise.
 */
async function handleBuyerIntent(chat, senderId, senderName, client, contact = null, offer = undefined) {
    if (currentBuyer && currentBuyer.id === senderId) return;

    if (!currentBuyer) {
        await assignBuyer(chat, senderId, senderName, contact, offer);
        return;
    }

    const queued = buyerQueue.find((b) => b.id === senderId);
    if (queued) {
        if (offer !== undefined) queued.offer = offer;
    } else {
        buyerQueue.push({ id: senderId, name: senderName, chatId: chat.id._serialized, contact, offer });
        console.log(`🔢 [Handler] ${senderName} waiting in line (position ${buyerQueue.length}) behind ${currentBuyer.name}.`);
    }

    // The first buyer keeps priority while they're responsive or have committed to pay.
    if (buyerIsLocked()) return;
    const idleMs = Date.now() - (currentBuyer.lastActivityAt || currentBuyer.assignedAt);
    if (idleMs >= config.BUYER_INACTIVITY_MS) {
        console.log(`⏱️  [Handler] ${currentBuyer.name} went quiet for ${Math.round(idleMs / 1000)}s — offering to the next buyer.`);
        await moveNextBuyer();
    } else {
        scheduleNextBuyer(config.BUYER_INACTIVITY_MS - idleMs);
    }
}

// ═══════════════════════════════════════════════════════════════
//  BUYER PHONE RESOLUTION HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Extract a 10-digit Indian phone number from text if present.
 */
function extractPhoneNumberFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/(?:\+?91[\s-]?)?([6-9]\d{9})\b/);
    if (match && match[1]) {
        return loyalty.normalizePhoneNumber(match[1]);
    }
    return null;
}

/**
 * Asynchronously resolve a buyer's 10-digit Indian phone number.
 * First checks contact and chat, then queries WhatsApp Web via Puppeteer
 * if the sender is an LID.
 */
async function resolveBuyerPhoneAsync(contact, senderId, chat = null) {
    // 1. Direct loyalty check
    const directPhone = loyalty.resolveBuyerPhone(contact, senderId);
    if (directPhone) return directPhone;

    // 2. Chat ID check (if chat is @c.us)
    const chatPhone = loyalty.widToPhoneNumber(chat?.id);
    if (chatPhone) return chatPhone;

    // 3. If sender or contact is an LID, query WhatsApp Web via Puppeteer
    const isLid = (typeof senderId === 'string' && senderId.endsWith('@lid')) ||
                  (contact?.id && (contact.id.server === 'lid' || String(contact.id._serialized || contact.id).endsWith('@lid')));

    if (isLid && globalClient?.pupPage) {
        try {
            const targetId = String(contact?.id?._serialized || contact?.id || senderId);
            const resolvedUser = await globalClient.pupPage.evaluate(async (idStr) => {
                const widFactory = window.require('WAWebWidFactory');
                const wid = widFactory.createWid(idStr);
                let phoneWid = null;
                try {
                    phoneWid = window.require('WAWebApiContact').getPhoneNumber(wid);
                } catch (_) { }
                if (!phoneWid) {
                    try {
                        const { toPn } = window.require('WAWebLidMigrationUtils');
                        phoneWid = toPn(wid);
                    } catch (_) { }
                }
                if (!phoneWid) {
                    try {
                        phoneWid = window.require('WAWebApiContact').getAlternateUserWid(wid);
                    } catch (_) { }
                }
                if (!phoneWid && window.WWebJS?.enforceLidAndPnRetrieval) {
                    try {
                        const res = await window.WWebJS.enforceLidAndPnRetrieval(idStr);
                        if (res?.phone) phoneWid = res.phone;
                    } catch (_) { }
                }
                return phoneWid?.user || (phoneWid?._serialized ? phoneWid._serialized.split('@')[0] : null);
            }, targetId);

            if (resolvedUser) {
                const normalized = loyalty.normalizePhoneNumber(resolvedUser);
                if (normalized) return normalized;
            }
        } catch (err) {
            console.warn('⚠️  [Handler] Async phone resolution from LID failed:', err.message);
        }
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════
//  ASSIGN BUYER
// ═══════════════════════════════════════════════════════════════

async function assignBuyer(chat, senderId, senderName, contact = null, offer = undefined) {
    const buyerPhone = await resolveBuyerPhoneAsync(contact, senderId, chat);
    const freeEligible = buyerPhone
        ? loyalty.isFreeMealEligible(config.LOYALTY_CSV_PATH, buyerPhone, config.LOYALTY_TARGET)
        : false;
    const price = getCurrentPrice();
    const listPrice = Number.isFinite(price) && price > 0 ? price : config.DEFAULT_PRICE;

    currentBuyer = {
        id: senderId,
        name: senderName,
        phone: buyerPhone,
        isFreeMeal: freeEligible,
        chatId: chat.id._serialized,
        chat,
        assignedAt: Date.now(),
        lastActivityAt: Date.now(),
        listPrice,
        agreedPrice: listPrice,
        quotedAt: Date.now(),      // payment must happen after the final price is quoted…
        confirmedAt: null,         // …and within PAYMENT_WINDOW_MINUTES of the deal
        paymentState: 'awaiting',
        paymentTimer: null,
        lastCheck: null,
    };
    const finalPrice = listPrice;
    console.log(`🛒 [Handler] Buyer assigned: ${senderName} (phone: ${buyerPhone || 'unresolved'}, freeEligible: ${freeEligible}, price: ₹${finalPrice})`);

    try {
        if (freeEligible) {
            await sendTextWithFallbacks(chat, buyerPhone, senderId, config.freeMealAssignMessage(senderName, getCurrentMeal()));
            console.log('🎁 [Loyalty] Sent free meal claim prompt to buyer.');
        } else {
            await sendTextWithFallbacks(chat, buyerPhone, senderId, config.payViaPhoneMessage(finalPrice, config.UPI_ID));
            console.log('📤 [Handler] Payment details sent.');

            if (config.UPI_QR_IMAGE_PATH && fs.existsSync(config.UPI_QR_IMAGE_PATH)) {
                const upiSent = await sendMediaWithFallbacks(chat, buyerPhone, senderId, config.UPI_QR_IMAGE_PATH);
                console.log(upiSent ? '📤 [Handler] UPI payment QR sent.' : '⚠️  [Handler] UPI payment QR could not be sent.');
            }

            if (offer !== undefined) {
                await handleNegotiation(currentBuyer, offer); // they already asked for a lower price
            } else {
                await sendTextWithFallbacks(chat, buyerPhone, senderId, config.paymentInstructionMessage(finalPrice));
            }
            console.log('📤 [Handler] Payment instruction sent.');
        }
    } catch (err) {
        console.error('❌ [Handler] Error sending buyer messages:', err.message);
    }

    if (buyerQueue.length > 0) {
        scheduleNextBuyer(config.BUYER_INACTIVITY_MS);
    }
}

// ═══════════════════════════════════════════════════════════════
//  TIMERS & QUEUES
// ═══════════════════════════════════════════════════════════════

function scheduleNextBuyer(delayMs) {
    if (queueTimer) return; // Wait until current timer finishes

    const safeDelayMs = Math.max(0, Number(delayMs) || 0);
    console.log(`⏱️  [Timer] Checking queue in ${Math.round(safeDelayMs / 1000)}s...`);

    const warningDelayMs = safeDelayMs - config.BUYER_TIMEOUT_WARNING_MS;
    const warningBuyerId = currentBuyer?.id || null;
    if (warningDelayMs > 0 && currentBuyer?.chat && buyerQueue.length > 0) {
        queueWarningTimer = setTimeout(async () => {
            queueWarningTimer = null;
            if (sold || !currentBuyer || buyerIsLocked()) return;
            if (!warningBuyerId || currentBuyer.id !== warningBuyerId) return;
            if (buyerQueue.length === 0) return;
            if (isBlockedWid(currentBuyer.id)) return; // blocked mid-purchase

            try {
                await currentBuyer.chat.sendMessage(config.timeoutWarningMessage());
                console.log(`⏳ [Timer] Sent timeout warning to ${currentBuyer.name}.`);
            } catch (err) {
                console.error('❌ [Timer] Error sending timeout warning:', err.message);
            }
        }, warningDelayMs);
    }

    queueTimer = setTimeout(async () => {
        queueTimer = null;
        if (sold || !currentBuyer) return;

        console.log(`⏱️  [Timer] ${currentBuyer.name} ran out of time. Checking queue.`);
        await moveNextBuyer();
    }, safeDelayMs);
}

async function moveNextBuyer() {
    if (!currentBuyer) return;
    if (buyerIsLocked()) {
        console.log(`🔒 [Handler] ${currentBuyer.name} has sent a payment screenshot (${currentBuyer.paymentState}) — keeping them, not moving on.`);
        return;
    }

    if (isBlockedWid(currentBuyer.id)) {
        console.log(`⛔ [Blocklist] ${currentBuyer.name} was blocked mid-purchase — dropping silently.`);
    } else {
        try {
            await currentBuyer.chat.sendMessage(config.timeoutFinalMessage());
        } catch (err) {
            console.error('❌ [Timer] Error notifying leaving buyer:', err.message);
        }
    }

    releaseBuyer();
    await tryNextBuyer();
}

function clearAllTimers() {
    if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
    if (queueWarningTimer) { clearTimeout(queueWarningTimer); queueWarningTimer = null; }
}

async function reactToRecentOwnGroupMessages() {
    if (!globalClient || !reactOwnGroupMessages) return;

    try {
        await groupReactions.reactToGroupMessages();
    } catch (err) {
        console.error('❌ [Handler] Error while marking group messages as sold:', err.message);
    }
}

async function removeAllTrackedReactions() {
    if (!globalClient) return;

    try {
        await groupReactions.clearGroupReactions();
    } catch (err) {
        console.error('❌ [Handler] Error while removing group reactions:', err.message);
    }
}

function releaseBuyer() {
    clearAllTimers();
    if (currentBuyer?.paymentTimer) clearTimeout(currentBuyer.paymentTimer);
    currentBuyer = null;
    console.log('🔄 [Handler] Buyer reservation released.');
}

async function tryNextBuyer() {
    if (buyerQueue.length === 0) {
        console.log('📭 [Handler] No more buyers in queue.');
        return;
    }
    const next = buyerQueue.shift();

    if (isBlockedWid(next.id)) {
        console.log(`⛔ [Blocklist] Skipping queued buyer ${next.name} — number is blocked.`);
        await tryNextBuyer();
        return;
    }

    console.log(`➡️  [Handler] Trying next buyer: ${next.name}`);

    try {
        const chat = await globalClient.getChatById(next.chatId);
        await assignBuyer(chat, next.id, next.name, next.contact || null, next.offer);
    } catch (err) {
        console.error('❌ [Handler] Error assigning next buyer:', err.message);
        await tryNextBuyer();
    }
}

// ═══════════════════════════════════════════════════════════════
//  NEGOTIATION
// ═══════════════════════════════════════════════════════════════

// Only the current (first-in-line) buyer can negotiate, and only when they ask.
// How low the bot will go depends on the time — NEGOTIATION_SCHEDULE in Setting.txt,
// e.g. "07:30=none, 08:30=20, 09:00=15, 09:15=10" (none = price is fixed).

const NEGOTIATION_REQUEST_RE = /\b(less|lesser|reduce|discount|kam|kum|lower|cheaper|best price|last price|final price|negotiable|negotiate|bargain|can you do|can u do|any offer)\b/i;
const CONFIRM_WORDS_RE = /^(y|yes+|yeah|yea|yep|yup|ya+|haan|han|ha|ok+|okay|okk+|k|sure|confirm(ed)?|deal|done deal|go ahead|fine|paying|will pay|i will pay|i'?ll pay|i'?m paying|sending|sending now|paying now)\b/i;
const CONFIRM_EMOJI = ['👍', '👌', '✅', '🙏', '🤝', '💯', '✔', '☑'];

/** Lowest acceptable price right now, or null when the price is fixed. */
function negotiationFloor(listPrice, when = new Date()) {
    if (!config.ENABLE_NEGOTIATION) return null;
    if (config.TESTING) return Math.max(listPrice - config.NEGOTIATION_MARGIN, 0);

    const minutes = when.getHours() * 60 + when.getMinutes();
    let floor = null;
    for (const part of String(config.NEGOTIATION_SCHEDULE || '').split(',')) {
        const m = /^\s*(\d{1,2}):(\d{2})\s*=\s*(none|\d+)\s*$/i.exec(part);
        if (m && Number(m[1]) * 60 + Number(m[2]) <= minutes) floor = m[3].toLowerCase() === 'none' ? null : Number(m[3]);
    }
    return floor !== null && floor < listPrice ? floor : null;
}

function isConfirmation(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (CONFIRM_EMOJI.some((e) => t.startsWith(e))) return true;
    return CONFIRM_WORDS_RE.test(t) || /\bpaying\b/i.test(t);
}

function isPositiveReaction(emoji) {
    return CONFIRM_EMOJI.some((e) => String(emoji || '').startsWith(e)) || /^(❤|♥|😍|🔥|🫡)/u.test(String(emoji || ''));
}

/** Tell the current buyer the price on the table and ask them to confirm. */
async function askToConfirm(buyer, intro = null) {
    const text = [intro, config.confirmPromptMessage(buyer.agreedPrice)].filter(Boolean).join('\n');
    await sendTextWithFallbacks(buyer.chat, buyer.phone, buyer.id, text);
}

async function handleNegotiation(buyer, offeredPrice) {
    stats.negotiations++;
    const listPrice = buyer.listPrice;
    const floor = negotiationFloor(listPrice);

    if (floor === null) {
        console.log(`💬 [Handler] ${buyer.name} asked to negotiate — price is fixed right now (₹${listPrice}).`);
        buyer.agreedPrice = listPrice;
        buyer.quotedAt = Date.now();
        await askToConfirm(buyer, config.negotiationDisabledMessage(listPrice));
        return;
    }

    let price;
    let intro;
    if (offeredPrice === null) {
        price = floor; // "can you reduce?" — give the best price for this time
        intro = config.negotiationCounterOfferMessage(price);
    } else if (offeredPrice >= listPrice) {
        price = listPrice;
        intro = config.negotiationAcceptedMessage(price);
    } else if (offeredPrice >= floor) {
        price = offeredPrice;
        intro = config.negotiationAcceptedMessage(price);
    } else {
        price = floor;
        intro = config.negotiationCounterOfferMessage(price);
    }

    console.log(`💬 [Handler] Negotiation with ${buyer.name}: offered ${offeredPrice === null ? '(asked for less)' : `₹${offeredPrice}`} → ₹${price} (list ₹${listPrice}, floor ₹${floor}).`);
    buyer.agreedPrice = price;
    buyer.quotedAt = Date.now();
    buyer.paymentState = 'awaiting';
    buyer.confirmedAt = null;
    await askToConfirm(buyer, intro);
}

/** Buyer said yes / paying / 👍 — hold the meal for them and start the payment window. */
async function confirmPurchase(buyer, how) {
    if (!buyer || buyer.paymentState !== 'awaiting') return;
    buyer.paymentState = 'confirmed';
    buyer.confirmedAt = Date.now();
    clearAllTimers(); // nobody else gets the meal while they pay

    if (buyer.paymentTimer) clearTimeout(buyer.paymentTimer);
    const holdMs = (config.PAYMENT_WINDOW_MINUTES + config.SCREENSHOT_GRACE_MINUTES) * 60 * 1000;
    buyer.paymentTimer = setTimeout(() => expirePaymentWindow(buyer), holdMs);

    console.log(`🤝 [Handler] ${buyer.name} confirmed (${how}) at ₹${buyer.agreedPrice}. Holding the meal for ${config.PAYMENT_WINDOW_MINUTES} min (+${config.SCREENSHOT_GRACE_MINUTES} for the screenshot); ${buyerQueue.length} waiting.`);
    await sendTextWithFallbacks(buyer.chat, buyer.phone, buyer.id,
        config.confirmedMessage(buyer.agreedPrice, config.PAYMENT_WINDOW_MINUTES));
}

async function expirePaymentWindow(buyer) {
    if (sold || currentBuyer !== buyer) return;
    if (buyer.paymentState === 'verifying' || buyer.paymentState === 'review') {
        buyer.paymentTimer = setTimeout(() => expirePaymentWindow(buyer), 2 * 60 * 1000); // still being checked
        return;
    }
    if (buyer.paymentState !== 'confirmed') return; // verified (waiting for DONE) or already moved on

    console.log(`⌛ [Handler] ${buyer.name}'s payment window ran out — moving to the next buyer.`);
    await sendTextWithFallbacks(buyer.chat, buyer.phone, buyer.id, config.paymentWindowExpiredMessage(config.PAYMENT_WINDOW_MINUTES));
    releaseBuyer();
    await tryNextBuyer();
}

/** 👍 (or similar) on one of our messages counts as "yes, paying". */
async function handleReaction(reaction) {
    try {
        if (!currentBuyer || sold || currentBuyer.paymentState !== 'awaiting') return;
        if (reaction?.id?.fromMe) return;
        const chatId = reaction?.msgId?.remote?._serialized || reaction?.msgId?.remote || reaction?.id?.remote;
        const sameChat = chatId === currentBuyer.chatId || chatId === currentBuyer.id || reaction?.senderId === currentBuyer.id;
        if (!sameChat || !isPositiveReaction(reaction.reaction)) return;
        await confirmPurchase(currentBuyer, `reacted ${reaction.reaction}`);
    } catch (err) {
        console.error('❌ [Handler] Error handling reaction:', err.message);
    }
}

/** After a sale, let everyone still waiting know it's gone. */
async function notifyQueueSold() {
    const waiting = buyerQueue.splice(0);
    for (const b of waiting) {
        try {
            await globalClient.sendMessage(b.chatId, config.soldMessage());
        } catch (err) {
            console.warn(`⚠️  [Handler] Could not tell ${b.name} it's sold: ${err.message}`);
        }
    }
    if (waiting.length) console.log(`📣 [Handler] Told ${waiting.length} waiting buyer(s) it's sold.`);
}

// ═══════════════════════════════════════════════════════════════
//  RESILIENT DELIVERY HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve a canonical @c.us phone JID from phone number or senderId.
 */
function getStandardJid(phone, senderId) {
    if (senderId && typeof senderId === 'string' && senderId.endsWith('@c.us')) {
        return senderId;
    }
    if (phone) {
        const digits = String(phone).replace(/\D/g, '');
        if (digits.length === 10) {
            return `91${digits}@c.us`;
        }
        if (digits.length > 10) {
            return `${digits}@c.us`;
        }
    }
    return null;
}

/**
 * Deliver QR media with multi-layer fallbacks:
 * 1. Direct send via active chat (with patched browser memoizer & media sanitation)
 * 2. Fallback send as document via active chat
 * 3. Direct in-page Puppeteer evaluation fallback targeting active chat
 * 4. Fallback via standard phone JID (@c.us) ONLY for non-LID senders
 */
async function sendMediaWithFallbacks(chat, buyerPhone, senderId, mediaPath) {
    if (!fs.existsSync(mediaPath)) {
        console.warn('⚠️  [Handler] QR image not found at', mediaPath);
        return false;
    }

    let media;
    try {
        media = MessageMedia.fromFilePath(mediaPath);
    } catch (readErr) {
        console.error('❌ [Handler] Failed to read QR image file:', readErr.message);
        return false;
    }

    const chatId = chat?.id?._serialized || (typeof senderId === 'string' ? senderId : null);
    const isLid = typeof senderId === 'string' && senderId.endsWith('@lid');
    const standardJid = getStandardJid(buyerPhone, senderId);

    // Attempt 1: Direct send via the active chat
    if (chat && typeof chat.sendMessage === 'function') {
        try {
            await chat.sendMessage(media);
            console.log('📤 [Handler] QR image sent to buyer.');
            return true;
        } catch (err1) {
            console.warn(`⚠️  [Handler] Direct QR send to chat failed: ${err1.message}`);
        }
    }

    // Attempt 2: Fallback as document via active chat
    if (chat && typeof chat.sendMessage === 'function') {
        try {
            await chat.sendMessage(media, { sendMediaAsDocument: true });
            console.log('📤 [Handler] QR image sent as document fallback.');
            return true;
        } catch (err2) {
            console.warn(`⚠️  [Handler] Fallback QR send as document failed: ${err2.message}`);
        }
    }

    // Attempt 3: Direct browser evaluate fallback using active chat ID
    if (globalClient?.pupPage && chatId) {
        botSends.record(chatId); // bypasses client.sendMessage, so note it ourselves
        try {
            const directSent = await globalClient.pupPage.evaluate(async (targetChatId, mediaData) => {
                const targetChat = await window.WWebJS.getChat(targetChatId, { getAsModel: false });
                if (!targetChat) return false;
                const res = await window.WWebJS.sendMessage(targetChat, '', { media: mediaData });
                return Boolean(res);
            }, chatId, media);

            if (directSent) {
                console.log('📤 [Handler] QR image sent via browser evaluation fallback.');
                return true;
            }
        } catch (err3) {
            console.warn(`⚠️  [Handler] Direct browser evaluate QR send failed: ${err3.message}`);
        }
    }

    // Attempt 4: Fallback to standard JID ONLY if sender is NOT an @lid
    // (Sending to @c.us when the user only exists as an @lid triggers "No LID for user")
    if (!isLid && globalClient && standardJid && (!chat || chat.id?._serialized !== standardJid)) {
        try {
            await globalClient.sendMessage(standardJid, media);
            console.log(`📤 [Handler] QR image sent via fallback phone JID (${standardJid}).`);
            return true;
        } catch (err4) {
            console.warn(`⚠️  [Handler] Fallback QR send via phone JID failed: ${err4.message}`);
        }
    }

    console.error('❌ [Handler] All automated QR delivery attempts failed.');
    return false;
}

/**
 * Deliver text message with fallback to phone JID.
 */
async function sendTextWithFallbacks(chat, buyerPhone, senderId, textMessage) {
    if (chat && typeof chat.sendMessage === 'function') {
        try {
            await chat.sendMessage(textMessage);
            return true;
        } catch (err1) {
            console.warn(`⚠️  [Handler] Direct text send failed: ${err1.message}`);
        }
    }

    const isLid = typeof senderId === 'string' && senderId.endsWith('@lid');
    const standardJid = getStandardJid(buyerPhone, senderId);
    if (!isLid && globalClient && standardJid) {
        try {
            await globalClient.sendMessage(standardJid, textMessage);
            return true;
        } catch (err2) {
            console.error(`❌ [Handler] Fallback text send failed: ${err2.message}`);
        }
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════
//  PAYMENT VERIFICATION
// ═══════════════════════════════════════════════════════════════

/**
 * Buyer sent media: download it, have Claude read it, and either mark the
 * payment verified or hand it to the admin for a manual decision.
 */
async function handleScreenshot(msg, chat, buyerName) {
    const buyer = currentBuyer;

    if (buyer.paymentState === 'verifying') {
        await chat.sendMessage(config.screenshotStillCheckingMessage());
        return;
    }
    if (buyer.paymentState === 'verified') {
        await chat.sendMessage(config.screenshotVerifiedMessage(buyer.agreedPrice));
        return;
    }

    let media = null;
    try {
        media = await msg.downloadMedia();
    } catch (err) {
        console.warn(`⚠️  [Verifier] WhatsApp Web could not download media from ${buyerName}: ${err.message}`);
    }
    if (!media?.data) {
        try {
            media = await mediaDownload.downloadDecrypted(msg);
            if (media) console.log(`📥 [Verifier] Downloaded screenshot from ${buyerName} directly.`);
        } catch (err) {
            console.warn(`⚠️  [Verifier] Direct media download failed for ${buyerName}: ${err.message}`);
        }
    }
    const mimeType = (media?.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!media?.data || !paymentVerifier.SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
        await chat.sendMessage(config.screenshotNotImageMessage());
        return;
    }

    console.log(`📸 [Verifier] Screenshot received from ${buyerName}. Checking…`);
    buyer.paymentState = 'verifying';
    clearAllTimers();
    await sendTextWithFallbacks(chat, buyer.phone, buyer.id, config.screenshotCheckingMessage());

    // Paid exactly the agreed price, after the price was quoted and within the payment window.
    const dealAt = buyer.confirmedAt || buyer.quotedAt || buyer.assignedAt;
    const result = await paymentVerifier.verifyScreenshot(media, {
        amount: buyer.agreedPrice,
        notBefore: new Date(buyer.quotedAt || buyer.assignedAt),
        notAfter: new Date(dealAt + config.PAYMENT_WINDOW_MINUTES * 60 * 1000),
    });
    if (sold || currentBuyer !== buyer) return; // buyer changed while the screenshot was being read
    buyer.lastCheck = result;

    if (result.verified) {
        await markPaymentVerified(chat, buyerName, result.details.amount, 'screenshot', result.details.transaction_id);
        return;
    }

    // Claude couldn't run at all (no credits, network…) — only a human can decide.
    if (result.error) {
        buyer.paymentState = 'review';
        const forwarded = await forwardToAdmin(buyer, media, result);
        await sendTextWithFallbacks(chat, buyer.phone, buyer.id, config.screenshotReviewMessage(result.reasons.join('; ')));
        console.warn(`⚠️  [Verifier] Automatic check unavailable for ${buyerName}${forwarded ? ' — sent to admin' : ''}.`);
        return;
    }

    // The screenshot failed a check — no waiting on the seller: tell the buyer why and let them resend.
    buyer.paymentState = buyer.confirmedAt ? 'confirmed' : 'awaiting';
    buyer.failedChecks = (buyer.failedChecks || 0) + 1;
    forwardToAdmin(buyer, media, result).catch(() => {}); // FYI only; the admin can still APPROVE later

    if (buyer.failedChecks >= config.MAX_VERIFY_ATTEMPTS) {
        console.log(`🚫 [Verifier] ${buyerName} failed ${buyer.failedChecks} screenshot checks — moving to the next buyer.`);
        await sendTextWithFallbacks(chat, buyer.phone, buyer.id, config.adminRejectedMessage());
        releaseBuyer();
        await tryNextBuyer();
        return;
    }

    const reasons = result.details && !result.details.is_payment_screenshot
        ? 'that is not a payment screenshot'
        : result.reasons.join('; ');
    await sendTextWithFallbacks(chat, buyer.phone, buyer.id,
        config.screenshotRetryMessage(reasons, config.MAX_VERIFY_ATTEMPTS - buyer.failedChecks));
    console.log(`🔁 [Verifier] Asked ${buyerName} to resend (${buyer.failedChecks}/${config.MAX_VERIFY_ATTEMPTS}): ${reasons}`);
}

async function markPaymentVerified(chat, buyerName, amount, method, utr) {
    const buyer = currentBuyer;
    if (!buyer) return;
    buyer.paymentState = 'verified';
    clearAllTimers();

    try {
        paymentVerifier.recordUtr({ utr, phone: buyer.phone, name: buyerName, amount, method });
    } catch (err) {
        console.error('❌ [Verifier] Could not record transaction ID:', err.message);
    }

    const shownAmount = Number.isFinite(amount) ? amount : buyer.agreedPrice;
    const text = method === 'admin' ? config.adminApprovedMessage() : config.screenshotVerifiedMessage(shownAmount);
    await sendTextWithFallbacks(chat, buyer.phone, buyer.id, text);
    console.log(`✅ [Verifier] Payment from ${buyerName} verified (${method}). Waiting for DONE.`);
}

function getAdminJid() {
    const adminPhone = loyalty.normalizePhoneNumber(config.ADMIN_NUMBER);
    return adminPhone ? `91${adminPhone}@c.us` : null;
}

async function forwardToAdmin(buyer, media, result) {
    const adminJid = getAdminJid();
    if (!adminJid || !globalClient) return false;

    const d = result.details || {};
    const caption = config.adminReviewCaption({
        buyerName: buyer.name,
        buyerPhone: buyer.phone || 'unknown',
        expected: buyer.agreedPrice,
        amount: d.amount ?? '?',
        payee: d.payee_upi || d.payee_name || '?',
        utr: d.transaction_id || '?',
        time: d.payment_datetime || '?',
        reasons: result.reasons.join('; '),
    });

    try {
        await globalClient.sendMessage(adminJid, new MessageMedia(media.mimetype, media.data, media.filename), { caption });
        return true;
    } catch (err) {
        console.warn(`⚠️  [Verifier] Could not send screenshot to admin: ${err.message}`);
    }
    try {
        await globalClient.sendMessage(adminJid, `${caption}\n\n(Screenshot could not be attached — check ${buyer.name}'s chat.)`);
        return true;
    } catch (err) {
        console.error('❌ [Verifier] Could not reach admin:', err.message);
        return false;
    }
}

/**
 * Admin replies APPROVE or REJECT (exact word) to settle a screenshot under review.
 * Works from the admin's own number, or from this account's "Message yourself"
 * chat when ADMIN_NUMBER is the bot's own number. Returns true if handled.
 */
async function handleAdminCommand(msg, contact = null) {
    const body = (msg?.body || '').trim();
    const match = body.match(/^(approve|reject)$/i);
    if (!match || !globalClient) return false;

    const adminPhone = loyalty.normalizePhoneNumber(config.ADMIN_NUMBER);
    if (!adminPhone) return false;

    let replyTo;
    if (msg.fromMe) {
        const myPhone = loyalty.normalizePhoneNumber(globalClient.info?.wid?.user);
        const chatId = (msg.id && typeof msg.id.remote === 'string' ? msg.id.remote : null) || msg.to;
        const isSelfChat = chatId === globalClient.info?.wid?._serialized || loyalty.widToPhoneNumber(chatId) === myPhone;
        if (myPhone !== adminPhone || !isSelfChat) return false;
        replyTo = chatId;
    } else {
        const senderPhone = await resolveBuyerPhoneAsync(contact, msg.from, null);
        if (senderPhone !== adminPhone) return false;
        replyTo = msg.from;
    }

    const reply = async (text) => {
        try { await globalClient.sendMessage(replyTo, text); } catch (_) { /* best effort */ }
    };

    // 'review' = waiting on the admin; 'awaiting' with a failed check = bot asked for a resend, admin may overrule.
    const decidable = currentBuyer && (currentBuyer.paymentState === 'review'
        || (currentBuyer.paymentState === 'awaiting' && currentBuyer.lastCheck));
    if (!decidable) {
        await reply('No payment screenshot is waiting for approval.');
        return true;
    }

    const buyer = currentBuyer;
    if (match[1].toLowerCase() === 'approve') {
        const d = buyer.lastCheck?.details || {};
        await markPaymentVerified(buyer.chat, buyer.name, d.amount, 'admin', d.transaction_id);
        await reply(`✅ Approved ${buyer.name}. They'll get the QR after replying DONE.`);
        console.log(`👮 [Admin] Approved payment from ${buyer.name}.`);
    } else {
        await sendTextWithFallbacks(buyer.chat, buyer.phone, buyer.id, config.adminRejectedMessage());
        await reply(`❌ Rejected ${buyer.name}. Moving to the next buyer.`);
        console.log(`👮 [Admin] Rejected payment from ${buyer.name}.`);
        releaseBuyer();
        await tryNextBuyer();
    }
    return true;
}

// ═══════════════════════════════════════════════════════════════
//  SALE COMPLETION
// ═══════════════════════════════════════════════════════════════

async function completeSale(chat, buyerName) {
    sold = true;
    reactOwnGroupMessages = true;
    allowTestingRevert = true;
    const isFree = Boolean(currentBuyer && currentBuyer.isFreeMeal);
    const activePrice = getCurrentPrice();
    let buyerPhone = currentBuyer?.phone;
    if (!buyerPhone) {
        buyerPhone = await resolveBuyerPhoneAsync(null, stats.buyerId, chat);
    }
    const senderId = currentBuyer?.id || stats.buyerId;

    stats.isFreeMeal = isFree;
    stats.soldPrice = isFree ? 0 : (currentBuyer?.agreedPrice || activePrice);
    stats.buyerName = buyerName;
    stats.buyerId = senderId;
    stats.timeSold = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    clearAllTimers();
    stopScheduler();

    console.log(`\n🎉 [Handler] SOLD to ${buyerName}! (Free Meal: ${isFree})`);

    // ── 1. Record Loyalty First (Independently protected) ─────────────────
    let loyaltyStatus = '';
    try {
        if (buyerPhone) {
            if (isFree) {
                const claimResult = loyalty.claimFreeMeal(config.LOYALTY_CSV_PATH, buyerPhone, buyerName);
                stats.loyaltyRecord = {
                    phone: buyerPhone,
                    wasFreeMeal: true,
                    amount: 0,
                    previousTotal: claimResult ? claimResult.previousTotal : 0,
                };
                console.log(`🎁 [Loyalty] FREE meal delivered to ${buyerName} (${buyerPhone}). Total purchases reset to 0 in CSV.`);
            } else {
                const finalPrice = Number.isFinite(stats.soldPrice) && stats.soldPrice > 0 ? stats.soldPrice : config.DEFAULT_PRICE;
                const purchaseResult = loyalty.recordPurchase(
                    config.LOYALTY_CSV_PATH,
                    buyerPhone,
                    buyerName,
                    finalPrice,
                    config.LOYALTY_TARGET
                );
                if (purchaseResult) {
                    stats.loyaltyRecord = {
                        phone: buyerPhone,
                        wasFreeMeal: false,
                        amount: finalPrice,
                        previousTotal: purchaseResult.previousTotal,
                    };

                    loyaltyStatus = purchaseResult.isFreeNext
                        ? config.loyaltyReachedMessage(config.LOYALTY_TARGET)
                        : config.loyaltyProgressMessage(purchaseResult.newTotal, config.LOYALTY_TARGET, purchaseResult.remaining);

                    console.log(`💳 [Loyalty] Purchase recorded: ₹${finalPrice} for ${buyerName} (${buyerPhone}). New total: ₹${purchaseResult.newTotal}/${config.LOYALTY_TARGET}.`);
                }
            }
        } else {
            console.warn(`⚠️  [Loyalty] Buyer phone could not be resolved for ${buyerName} (${senderId}). Skipping CSV record to avoid storing non-phone identifier.`);
        }
    } catch (loyaltyErr) {
        console.error('❌ [Loyalty] Error updating purchase record:', loyaltyErr.message);
    }

    // ── 2. Deliver QR Media Resiliently ──────────────────────────────────
    let qrDelivered = false;
    try {
        // The portal QR can change; grab the current one right before handing it over.
        if (diningPortal.isConfigured()) await diningPortal.refreshQr('before delivery');
        qrDelivered = await sendMediaWithFallbacks(chat, buyerPhone, senderId, config.QR_IMAGE_PATH);
        if (currentBuyer?.paymentTimer) clearTimeout(currentBuyer.paymentTimer);
        await notifyQueueSold();
    } catch (qrErr) {
        console.error('❌ [Handler] Error in QR delivery pipeline:', qrErr.message);
    }

    // ── 3. Send Sale Confirmation Text Resiliently ───────────────────────
    try {
        let confirmText = isFree
            ? config.freeMealConfirmMessage(buyerName, getCurrentMeal())
            : config.saleConfirmMessage(buyerName, getCurrentMeal(), loyaltyStatus);

        if (!qrDelivered && fs.existsSync(config.QR_IMAGE_PATH)) {
            confirmText += '\n\n⚠️ (Note: QR image could not be sent automatically. Please message here if needed!)';
        }

        const sent = await sendTextWithFallbacks(chat, buyerPhone, senderId, confirmText);
        if (sent) {
            console.log(`📤 [Handler] Sale confirmation message sent to ${buyerName}.`);
        }
    } catch (msgErr) {
        console.error('❌ [Handler] Error sending sale confirmation message:', msgErr.message);
    }

    // ── 4. React to Group Messages & Print Report ────────────────────────
    try {
        await reactToRecentOwnGroupMessages();
    } catch (reactErr) {
        console.error('❌ [Reactions] Error marking group messages:', reactErr.message);
    }

    printReport();
}

async function revertSale(chat, buyerName) {
    sold = false;
    currentBuyer = null;
    reactOwnGroupMessages = false;
    allowTestingRevert = true;
    await removeAllTrackedReactions();

    if (stats.loyaltyRecord) {
        loyalty.revertBuyerAction(config.LOYALTY_CSV_PATH, stats.loyaltyRecord.phone, stats.loyaltyRecord);
        console.log(`🔄 [Loyalty] Reverted loyalty update for ${stats.loyaltyRecord.phone}.`);
        stats.loyaltyRecord = null;
    }

    stats.soldPrice = null;
    stats.buyerName = null;
    stats.buyerId = null;
    stats.timeSold = null;
    stats.isFreeMeal = false;

    console.log(`\n⏪ [Handler] UNSOLD — ${buyerName} was just testing.`);

    try {
        await chat.sendMessage(config.testRevertedMessage());
    } catch (err) {
        console.error('❌ [Handler] Error sending revert confirmation:', err.message);
    }

    restartScheduler();
}

function handleUnsoldStop() {
    if (currentBuyer) {
        // Someone is mid-purchase at the cut-off — stop posting, but let them finish paying.
        console.log(`⏳ [Handler] Window closed while ${currentBuyer.name} is mid-purchase (${currentBuyer.paymentState}) — letting them finish.`);
        buyerQueue = [];
        clearAllTimers();
        return;
    }
    sold = true;
    reactOwnGroupMessages = false;
    allowTestingRevert = false;
    clearAllTimers();
    printReport();
}

function printReport() {
    const date = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    const wasSold = stats.soldPrice !== null;
    const soldPriceDisplay = wasSold
        ? (stats.isFreeMeal ? '₹0 (Free Meal)' : '₹' + stats.soldPrice)
        : '—';

    console.log(`
═════════════════════════════════════════════
          SALE REPORT
═════════════════════════════════════════════
  Date:              ${date.padEnd(14)}
  Sold:              ${(wasSold ? 'Yes' : 'No').padEnd(14)}
  Sold Price:        ${soldPriceDisplay.padEnd(14)}
  Buyer Name:        ${(stats.buyerName || '—').padEnd(14)}
  Time Sold:         ${(stats.timeSold || '—').padEnd(14)}
  Messages Received: ${String(stats.messagesReceived).padEnd(14)}
  Negotiations:      ${String(stats.negotiations).padEnd(14)}
═════════════════════════════════════════════
`);
}

/**
 * Clear yesterday's sale so the bot can sell again (AUTO_DAILY).
 */
function resetForNewDay() {
    clearAllTimers();
    sold = false;
    currentBuyer = null;
    buyerQueue = [];
    reactOwnGroupMessages = false;
    allowTestingRevert = true;
    stats = {
        messagesReceived: 0,
        negotiations: 0,
        soldPrice: null,
        buyerName: null,
        buyerId: null,
        timeSold: null,
        isFreeMeal: false,
        loyaltyRecord: null,
    };
    groupReactions.forgetTrackedMessages();
    console.log('🌅 [Handler] New day — sale state reset.');
}

async function handleOwnGroupMessage(msg) {
    try {
        if (!msg.fromMe || !reactOwnGroupMessages) return;

        // Derive the chat from the message key instead of msg.getChat(): that
        // call goes through getChatModel, which hits IndexedDB and is the most
        // breakage-prone part of the library.
        const chatId = (msg.id && typeof msg.id.remote === 'string' ? msg.id.remote : null) || msg.to || msg.from;
        if (!chatId || !chatId.endsWith('@g.us')) return;

        const group = groupReactions.getTargetGroups().find((g) => g.id === chatId);
        if (!group) return;

        const reacted = await groupReactions.reactToSingleMessage(msg, chatId);
        if (reacted) {
            console.log(`✅ [Handler] Reacted to your group message in "${group.name}".`);
        }
    } catch (err) {
        console.error('❌ [Handler] Failed to react on own group message:', err.message);
    }
}

let globalClient = null;
function setClient(client) {
    globalClient = client;
    groupReactions.setClient(client);
}

module.exports = {
    handleMessage, handleOwnGroupMessage, handleAdminCommand, noteOwnMessage, handleReaction,
    isSold, handleUnsoldStop, resetForNewDay, setClient,
};
