'use strict';
process.env.TZ = 'Asia/Kolkata';

const originalEmitWarning = process.emitWarning;
process.emitWarning = function patchedEmitWarning(warning, ...args) {
    const warningCode =
        (warning && typeof warning === 'object' && warning.code) ||
        (typeof args[1] === 'string' ? args[1] : null);

    if (warningCode === 'DEP0040') return;
    return originalEmitWarning.call(this, warning, ...args);
};

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('./utils/config');
const { applyOverrides } = require('./utils/config');
const { showMenu, defaultOptions } = require('./utils/menu');
const { startScheduler, stopScheduler } = require('./utils/priceScheduler');
const {
    handleMessage, handleOwnGroupMessage, handleAdminCommand, noteOwnMessage, handleReaction,
    isSold, handleUnsoldStop, resetForNewDay, setClient,
} = require('./utils/messageHandler');
const botSends = require('./utils/botSends');
const paymentVerifier = require('./utils/paymentVerifier');
const diningPortal = require('./utils/diningPortal');
const { loadBlocklist, getBlockedNumbers } = require('./utils/blocklist');
const loyalty = require('./utils/loyalty');
const groupReactions = require('./utils/groupReactions');
const {
    getSessionDir,
    prepareSession,
    setupGracefulShutdown,
    removeSessionLocks,
} = require('./utils/processManager');

const sessionDir = getSessionDir('./.wwebjs_auth');

// ─── Runtime state set by CLI menu ──────────────────────────
let runOpts = {};

// ─── Create Client ──────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-default-apps',
            '--disable-translate',
            '--disable-sync',
        ],
    },
    // Don't cache WhatsApp Web version — always fetch the latest to avoid
    // stale-cache errors when WhatsApp updates its internal module structure.
    webVersionCache: {
        type: 'none',
    },
});

// Note every chat the bot sends to, so messages you type yourself can be told apart.
botSends.trackClient(client);

let targetChats = [];

// ─── QR Event ───────────────────────────────────────────────
client.on('qr', (qr) => {
    console.log('\n📱 Scan this QR code to log in:\n');
    qrcode.generate(qr, { small: true });
});

// ─── Authentication Events ──────────────────────────────────
client.on('authenticated', () => {
    console.log('🔐 [Auth] Authenticated successfully.');
});

client.on('auth_failure', (msg) => {
    console.error('🔐 [Auth] Authentication failure:', msg);
});

// ─── Ready Event ────────────────────────────────────────────
client.on('ready', async () => {
    try {
        console.log('✅ WhatsApp client is ready!');
        console.log(`👤 Logged in as: ${client.info.pushname} (${client.info.wid.user})\n`);

        const expectedNumber = loyalty.normalizePhoneNumber(config.BOT_NUMBER);
        const loggedInNumber = loyalty.normalizePhoneNumber(client.info.wid.user);
        if (expectedNumber && loggedInNumber && expectedNumber !== loggedInNumber) {
            console.warn(`⚠️  BOT_NUMBER in Setting.txt is ${expectedNumber}, but WhatsApp is logged in as ${loggedInNumber}.`);
            console.warn('   Delete the .wwebjs_auth folder and scan the QR with the right phone if this is wrong.\n');
        }

        setClient(client);

        const blocked = getBlockedNumbers();
        if (blocked.length > 0) {
            console.log(`⛔ Ignoring messages from: ${blocked.join(', ')}\n`);
        }

        // ── Monkey-patch WWebJS methods to fix broken IDB calls ──────
        // The library's getChatModel, getContact, and getContactModel crash with
        // "No key or key range specified" (minified as 'r') when IDB is queried
        // (groupMetadata, BusinessProfile, Blocklist). We wrap them in try/catch.
        await client.pupPage.evaluate(() => {
            // 1. Patch getChatModel
            const origGetChatModel = window.WWebJS.getChatModel;
            window.WWebJS.getChatModel = async (chat, opts = {}) => {
                if (!chat) return null;
                const { isChannel = false } = opts;

                const model = chat.serialize();
                model.isGroup = false;
                model.isMuted = chat.mute?.expiration !== 0;

                if (isChannel) {
                    try {
                        model.isChannel = window
                            .require('WAWebChatGetters')
                            .getIsNewsletter(chat);
                    } catch (_) { /* skip */ }
                } else {
                    model.formattedTitle = chat.formattedTitle;
                }

                if (chat.groupMetadata) {
                    model.isGroup = true;
                    try {
                        const chatWid = window
                            .require('WAWebWidFactory')
                            .createWid(chat.id._serialized);
                        const groupMetadata =
                            window.require('WAWebCollections').GroupMetadata ||
                            window.require('WAWebCollections').WAWebGroupMetadataCollection;
                        await groupMetadata.update(chatWid);
                    } catch (_) {
                        // skip IDB
                    }

                    try {
                        const { toPn } = window.require('WAWebLidMigrationUtils');
                        const serializedMetadata = chat.groupMetadata.serialize();
                        for (const p of serializedMetadata.participants || []) {
                            p.id = toPn(p.id) ?? p.id;
                        }
                        model.groupMetadata = serializedMetadata;
                    } catch (_) {
                        model.groupMetadata = chat.groupMetadata.serialize
                            ? chat.groupMetadata.serialize()
                            : {};
                    }
                    model.isReadOnly = chat.groupMetadata.announce;
                }

                if (chat.newsletterMetadata) {
                    try {
                        const newsletterMetadata =
                            window.require('WAWebCollections')
                                .NewsletterMetadataCollection ||
                            window.require('WAWebCollections')
                                .WAWebNewsletterMetadataCollection;
                        await newsletterMetadata.update(chat.id);
                        model.channelMetadata = chat.newsletterMetadata.serialize();
                        model.channelMetadata.createdAtTs =
                            chat.newsletterMetadata.creationTime;
                    } catch (_) { }
                }

                model.lastMessage = null;
                if (model.msgs && model.msgs.length) {
                    try {
                        const lastMessage = chat.lastReceivedKey
                            ? window
                                .require('WAWebCollections')
                                .Msg.get(chat.lastReceivedKey._serialized) ||
                            (
                                await window
                                    .require('WAWebCollections')
                                    .Msg.getMessagesById([
                                        chat.lastReceivedKey._serialized,
                                    ])
                            )?.messages?.[0]
                            : null;
                        if (lastMessage) {
                            model.lastMessage =
                                window.WWebJS.getMessageModel(lastMessage);
                        }
                    } catch (_) { }
                }

                return model;
            };

            // 2. Patch getContactModel
            const origGetContactModel = window.WWebJS.getContactModel;
            window.WWebJS.getContactModel = (contact) => {
                if (!contact || !contact.id) return null;

                let res;
                try {
                    res = contact.serialize ? contact.serialize() : { id: contact.id };
                } catch (_) {
                    res = { id: contact.id };
                }

                try {
                    const wid = window
                        .require('WAWebWidFactory')
                        .createWidFromWidLike(contact.id);

                    if (wid && wid.isLid()) {
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
                        if (phoneWid) {
                            const pnSerialized = phoneWid._serialized || (phoneWid.user ? `${phoneWid.user}@c.us` : String(phoneWid));
                            res.phoneNumber = pnSerialized;
                            res.pnId = phoneWid;
                            res.number = phoneWid.user || String(phoneWid);
                            res.userid = phoneWid.user || String(phoneWid);
                        }
                    }

                    res.isBusiness = contact.isBusiness === undefined ? false : contact.isBusiness;

                    if (contact.businessProfile) {
                        try {
                            res.businessProfile = contact.businessProfile.serialize();
                        } catch (e) { }
                    }

                    res.isBlocked = contact.isContactBlocked;
                    if (!res.isBlocked) {
                        try {
                            const alt = window
                                .require('WAWebApiContact')
                                .getAlternateUserWid(wid);
                            if (alt) {
                                res.isBlocked = !!window
                                    .require('WAWebCollections')
                                    .Blocklist.get(alt);
                            }
                        } catch (e) {
                            // skip Blocklist.get IDB errors
                        }
                    }

                    const ContactMethods = window.require('WAWebContactGetters');
                    try { res.isMe = ContactMethods.getIsMe(contact); } catch (e) { }
                    try { res.isUser = ContactMethods.getIsUser(contact); } catch (e) { }
                    try { res.isGroup = ContactMethods.getIsGroup(contact); } catch (e) { }
                    try { res.isWAContact = ContactMethods.getIsWAContact(contact); } catch (e) { }
                    try {
                        const uid = ContactMethods.getUserid(contact);
                        // If not resolved to phoneWid, only set userid if not an LID
                        if (!res.userid) {
                            res.userid = uid;
                        }
                    } catch (e) { }
                    try { res.verifiedName = ContactMethods.getVerifiedName(contact); } catch (e) { }
                    try { res.verifiedLevel = ContactMethods.getVerifiedLevel(contact); } catch (e) { }
                    try { res.statusMute = ContactMethods.getStatusMute(contact); } catch (e) { }
                    try { res.name = ContactMethods.getName(contact); } catch (e) { }
                    try { res.shortName = ContactMethods.getShortName(contact); } catch (e) { }
                    try { res.pushname = ContactMethods.getPushname(contact); } catch (e) { }

                    try {
                        const { getIsMyContact } = window.require('WAWebFrontendContactGetters');
                        res.isMyContact = getIsMyContact(contact);
                    } catch (e) { }
                    try { res.isEnterprise = ContactMethods.getIsEnterprise(contact); } catch (e) { }
                } catch (_) {
                    // Return basic model if getters fail
                }

                return res;
            };

            // 3. Patch getContact
            const origGetContact = window.WWebJS.getContact;
            window.WWebJS.getContact = async (contactId) => {
                try {
                    const contactWid = window
                        .require('WAWebWidFactory')
                        .createWid(contactId);
                    const contact = await window
                        .require('WAWebCollections')
                        .Contact.find(contactWid);

                    let phoneWid = null;
                    if (contactWid && typeof contactWid.isLid === 'function' && contactWid.isLid()) {
                        try {
                            phoneWid = window.require('WAWebApiContact').getPhoneNumber(contactWid);
                        } catch (_) { }
                        if (!phoneWid) {
                            try {
                                const { toPn } = window.require('WAWebLidMigrationUtils');
                                phoneWid = toPn(contactWid);
                            } catch (_) { }
                        }
                        if (!phoneWid) {
                            try {
                                phoneWid = window.require('WAWebApiContact').getAlternateUserWid(contactWid);
                            } catch (_) { }
                        }
                        if (!phoneWid && window.WWebJS?.enforceLidAndPnRetrieval) {
                            try {
                                const retrieved = await window.WWebJS.enforceLidAndPnRetrieval(contactWid._serialized || contactId);
                                if (retrieved?.phone) phoneWid = retrieved.phone;
                            } catch (_) { }
                        }
                    }

                    if (!contact || !contact.id) {
                        const resolvedNumber = phoneWid?.user || (contactWid?.isLid?.() ? '' : (contactWid?.user || String(contactId).replace(/\D/g, '')));
                        return {
                            id: contactWid ? (contactWid._serialized || contactWid) : contactId,
                            number: resolvedNumber,
                            phoneNumber: phoneWid?._serialized || null,
                            name: contactWid?.user || contactId,
                            pushname: contactWid?.user || '',
                            isBusiness: false,
                            isEnterprise: false,
                            isGroup: false,
                            isUser: true,
                            isWAContact: true,
                            isMyContact: false,
                            isBlocked: false,
                        };
                    }

                    if (contact.isBusiness || contact.isEnterprise) {
                        try {
                            const bizProfile = await window
                                .require('WAWebCollections')
                                .BusinessProfile.find(contactWid);
                            bizProfile.profileOptions && (contact.businessProfile = bizProfile);
                        } catch (e) {
                            // skip BusinessProfile.find IDB errors
                        }
                    }
                    const model = window.WWebJS.getContactModel(contact);
                    if (phoneWid && model) {
                        model.phoneNumber = phoneWid._serialized || (phoneWid.user ? `${phoneWid.user}@c.us` : String(phoneWid));
                        model.number = phoneWid.user || model.number;
                        model.userid = phoneWid.user || model.userid;
                    }
                    return model;
                } catch (e) {
                    return {
                        id: contactId,
                        number: '',
                        name: contactId,
                        pushname: '',
                        isUser: true,
                    };
                }
            };

            // 4. Patch getMessageModel (shields against memoization getter crashes during message send)
            const origGetMessageModel = window.WWebJS.getMessageModel;
            window.WWebJS.getMessageModel = (message) => {
                if (!message) return null;
                try {
                    return origGetMessageModel(message);
                } catch (err) {
                    try {
                        return {
                            id: message.id ? (message.id._serialized || message.id) : null,
                            body: message.body || '',
                            type: message.type || 'chat',
                            t: message.t || Math.floor(Date.now() / 1000),
                            from: message.from ? (message.from._serialized || message.from) : null,
                            to: message.to ? (message.to._serialized || message.to) : null,
                            ack: message.ack || 0,
                        };
                    } catch (_) {
                        return null;
                    }
                }
            };

            // 5. Shield WhatsApp Web Getters against memoization crashes when entities are undefined or missing .id
            const getterModules = [
                'WAWebContactGetters',
                'WAWebFrontendContactGetters',
                'WAWebChatGetters',
                'WAWebMsgGetters',
            ];
            for (const modName of getterModules) {
                try {
                    const mod = window.require(modName);
                    if (mod && typeof mod === 'object') {
                        for (const [key, origFn] of Object.entries(mod)) {
                            if (typeof origFn === 'function') {
                                const k = key.toLowerCase();
                                mod[key] = function safeGetter(target, ...args) {
                                    if (!target || target.id === undefined) {
                                        if (k.startsWith('getis') || k.startsWith('is')) return false;
                                        if (k.includes('name') || k.includes('title') || k.includes('text') || k.includes('id')) return '';
                                        if (k.includes('level') || k.includes('time') || k.includes('ts') || k.includes('count')) return 0;
                                        return null;
                                    }
                                    try {
                                        return origFn.call(this, target, ...args);
                                    } catch (err) {
                                        if (err && typeof err.message === 'string' && err.message.includes('Data passed to getter must include an id property')) {
                                            if (k.startsWith('getis') || k.startsWith('is')) return false;
                                            if (k.includes('name') || k.includes('title') || k.includes('text') || k.includes('id')) return '';
                                            if (k.includes('level') || k.includes('time') || k.includes('ts') || k.includes('count')) return 0;
                                            return null;
                                        }
                                        throw err;
                                    }
                                };
                            }
                        }
                    }
                } catch (_) {}
            }

            // 6. Shield Contact store so un-cached contacts never return undefined to internal WA callers
            try {
                const ContactCollection = window.require('WAWebCollections')?.Contact;
                if (ContactCollection && typeof ContactCollection.get === 'function') {
                    const origContactGet = ContactCollection.get;
                    ContactCollection.get = function (wid, ...args) {
                        const contact = origContactGet.call(this, wid, ...args);
                        if (contact) return contact;
                        if (wid) {
                            return {
                                id: wid,
                                isUser: true,
                                isWAContact: true,
                                isGroup: false,
                                isEnterprise: false,
                                name: (wid && wid.user) ? wid.user : String(wid),
                                pushname: (wid && wid.user) ? wid.user : '',
                                serialize: () => ({ id: wid }),
                            };
                        }
                        return contact;
                    };
                }
            } catch (_) {}

            // 7. Patch window.WWebJS.sendMessage to sanitize media payload and resolve sender WID cleanly
            const origSendMessage = window.WWebJS.sendMessage;
            window.WWebJS.sendMessage = async function (chat, content, options = {}) {
                if (options && options.media) {
                    try {
                        const ChatGetters = window.require('WAWebChatGetters') || {};
                        const isChannel = ChatGetters.getIsNewsletter ? ChatGetters.getIsNewsletter(chat) : false;
                        const isStatus = ChatGetters.getIsBroadcast ? ChatGetters.getIsBroadcast(chat) : false;

                        let mediaOptions = options.sendMediaAsSticker && !isChannel && !isStatus
                            ? await window.WWebJS.processStickerData(options.media)
                            : await window.WWebJS.processMediaData(options.media, {
                                forceSticker: options.sendMediaAsSticker,
                                forceGif: options.sendVideoAsGif,
                                forceVoice: options.sendAudioAsVoice,
                                forceDocument: options.sendMediaAsDocument,
                                forceMediaHd: options.sendMediaAsHd,
                                sendToChannel: isChannel,
                                sendToStatus: isStatus,
                            });

                        // Extract clean JSON payload from mediaOptions to avoid spreading Backbone/Ampersand models
                        // whose unmemoized getters crash with "Data passed to getter must include an id property"
                        const cleanMedia = (mediaOptions && typeof mediaOptions.toJSON === 'function')
                            ? mediaOptions.toJSON()
                            : (mediaOptions ? { ...mediaOptions } : {});

                        cleanMedia.caption = options.caption;
                        cleanMedia.isViewOnce = options.isViewOnce;
                        content = options.sendMediaAsSticker ? undefined : cleanMedia.preview;

                        delete options.media;
                        delete options.sendMediaAsSticker;

                        // Resolve sender Wid robustly
                        let lidUser = null;
                        let meUser = null;
                        try {
                            const UserPrefs = window.require('WAWebUserPrefsMeUser');
                            lidUser = UserPrefs?.getMaybeMeLidUser ? UserPrefs.getMaybeMeLidUser() : null;
                            meUser = UserPrefs?.getMaybeMePnUser ? UserPrefs.getMaybeMePnUser() : null;
                        } catch (_) {}

                        if (!meUser) {
                            try {
                                meUser = window.require('WAWebConnModel')?.Conn?.wid || null;
                            } catch (_) {}
                        }

                        let from;
                        if (chat.id && typeof chat.id.isLid === 'function' && chat.id.isLid()) {
                            from = lidUser || meUser;
                        } else if (chat.id && typeof chat.id.isGroup === 'function' && chat.id.isGroup()) {
                            from = (chat.groupMetadata && chat.groupMetadata.isLidAddressingMode)
                                ? (lidUser || meUser)
                                : (meUser || lidUser);
                        } else {
                            from = meUser || lidUser;
                        }

                        if (!from) {
                            try {
                                from = window.require('WAWebConnModel')?.Conn?.wid;
                            } catch (_) {}
                        }

                        let participant;
                        if (chat.id && (chat.id.isGroup?.() || (typeof chat.id.isStatus === 'function' && chat.id.isStatus()))) {
                            try {
                                participant = window.require('WAWebWidFactory').asUserWidOrThrow(from);
                            } catch (_) {}
                        }

                        const newId = await window.require('WAWebMsgKey').newId();
                        const newMsgKey = new (window.require('WAWebMsgKey'))({
                            from: from,
                            to: chat.id,
                            id: newId,
                            participant: participant,
                            selfDir: 'out',
                        });

                        const extraOptions = options.extraOptions || {};
                        delete options.extraOptions;

                        let ephemeralFields = {};
                        try {
                            ephemeralFields = window.require('WAWebGetEphemeralFieldsMsgActionsUtils').getEphemeralFields(chat) || {};
                        } catch (_) {}

                        // Build message safely using clean plain data
                        const message = {
                            ...options,
                            id: newMsgKey,
                            ack: 0,
                            body: content,
                            from: from,
                            to: chat.id,
                            local: true,
                            self: 'out',
                            t: parseInt(new Date().getTime() / 1000),
                            isNewMsg: true,
                            type: options.sendMediaAsDocument ? 'document' : (cleanMedia.type || 'image'),
                            ...ephemeralFields,
                            ...cleanMedia,
                            ...extraOptions,
                        };

                        const [msgPromise, sendMsgResultPromise] = window
                            .require('WAWebSendMsgChatAction')
                            .addAndSendMsgToChat(chat, message);
                        await msgPromise;

                        if (options.waitUntilMsgSent && sendMsgResultPromise) {
                            await sendMsgResultPromise;
                        }

                        const resultMsg = window.require('WAWebCollections')?.Msg?.get(newMsgKey._serialized);
                        return resultMsg || { id: newMsgKey, body: content, type: message.type };
                    } catch (mediaSendErr) {
                        console.error('[WWebJS] Patched sendMessage error with media:', mediaSendErr);
                        // Fall back to original sendMessage if custom send hits any exception
                        return origSendMessage.call(this, chat, content, options);
                    }
                }

                // Non-media messages: delegate to original sendMessage
                return origSendMessage.call(this, chat, content, options);
            };
        });

        // Resolve groups straight from the in-page chat collection. client.getChats()
        // serialises every chat through getChatModel, which hits IndexedDB and
        // intermittently returns undefined ("Cannot read properties of undefined
        // (reading 'map')") — we only need each group's id and name.
        const configuredGroups = config.GROUP_NAMES || [];
        const { groups, available } = await groupReactions.resolveTargetGroups(configuredGroups);
        targetChats = groups;

        if (targetChats.length === 0) {
            console.error(`❌ No target groups found from your configuration: ${configuredGroups.join(', ')}`);
            console.error(`   Available groups you are in:`);
            available.forEach((c) => console.log(`   • ${c.name || '(unnamed)'}`));
            console.error('\nPlease update GROUP_NAME in Setting.txt and restart.');
            return;
        }

        console.log(`🎯 Target groups found (${targetChats.length}):`);
        targetChats.forEach((c) => console.log(`   • "${c.name}" (${c.id})`));
        console.log('');

        const startSelling = () => startScheduler(
            async (text) => {
                // Never advertise a meal unless today's QR came from the portal.
                if (diningPortal.isConfigured() && !diningPortal.isQrFreshToday()) {
                    const ok = await diningPortal.refreshQr('before post');
                    if (!ok) {
                        console.error('⏭️  [Main] Skipping this post — could not get today\'s meal QR from the portal.');
                        return;
                    }
                }
                for (const chat of targetChats) {
                    try {
                        const sent = await client.sendMessage(chat.id, text);
                        // Remember exactly what we posted so reactions never have to
                        // rediscover it by re-reading history later.
                        groupReactions.trackSentMessage(sent, chat.id);
                    } catch (err) {
                        console.error(`❌ [Main] Failed to send scheduled message to ${chat.name}:`, err.message);
                    }
                }
            },
            async () => {
                console.log('🛑 [Main] Auto-stop triggered — time limit reached without sale.');
                handleUnsoldStop();
            },
            isSold,
            {
                meal: runOpts._meal,
                mess: runOpts._mess,
                numMessages: runOpts._numMessages,
            },
        );

        startSelling();
        if (config.AUTO_DAILY) scheduleDailyRearm(startSelling);
    } catch (err) {
        console.error('❌ [Main] Error in ready handler:', err.message);
        console.error('❌ [Main] Full error:', err);
        console.error('❌ [Main] Stack:', err.stack);
    }
});

// ─── Daily meal QR refresh (QR changes every 24h) ───────────
let dailyQrTimer = null;

function scheduleDailyQrRefresh() {
    if (dailyQrTimer) clearTimeout(dailyQrTimer);
    if (!diningPortal.isConfigured()) return;

    const [h, m] = (config.QR_REFRESH_TIME || '07:00').split(':').map(Number);
    const next = new Date();
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);

    dailyQrTimer = setTimeout(async () => {
        await diningPortal.refreshQr('morning');
        scheduleDailyQrRefresh();
    }, next.getTime() - Date.now());

    console.log(`🍽️  [Main] Next meal QR refresh: ${next.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
}

// ─── Daily re-arm (AUTO_DAILY) ──────────────────────────────
// Shortly after midnight IST, clear yesterday's sale and schedule today's posts.
let dailyRearmTimer = null;

function scheduleDailyRearm(startSelling) {
    if (dailyRearmTimer) clearTimeout(dailyRearmTimer);

    const next = new Date();
    next.setHours(0, 5, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);

    dailyRearmTimer = setTimeout(() => {
        try {
            stopScheduler();
            resetForNewDay();
            startSelling();
        } catch (err) {
            console.error('❌ [Main] Daily re-arm failed:', err.message);
        }
        scheduleDailyRearm(startSelling);
    }, next.getTime() - Date.now());

    console.log(`🌙 [Main] Next daily reset: ${next.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST\n`);
}

// ─── Message Event ──────────────────────────────────────────
client.on('message_create', async (msg) => {
    try {

        if (msg.fromMe) {
            // APPROVE / REJECT typed in "Message yourself" when the admin is this account
            if (await handleAdminCommand(msg)) return;
            await noteOwnMessage(msg); // you typed in a DM yourself → bot keeps out of that chat
            await handleOwnGroupMessage(msg);
            return;
        }

        // Extra safety: ignore status updates and group messages at main level too
        if (msg.from.endsWith('@broadcast') || msg.from.endsWith('@g.us')) return;

        await handleMessage(msg, client);
    } catch (err) {
        console.error('❌ [Main] Error handling message:', err.message);
    }
});

// A 👍 on the bot's message from the current buyer counts as "yes, I'm paying".
client.on('message_reaction', (reaction) => handleReaction(reaction));

client.on('message_edit', async (msg, newBody, prevBody) => {
    try {
        const normalizedNewBody = typeof newBody === 'string' ? newBody.trim() : '';
        const normalizedPrevBody = typeof prevBody === 'string' ? prevBody.trim() : '';
        const normalizedCurrentBody = typeof msg.body === 'string' ? msg.body.trim() : '';

        if (!normalizedNewBody || (normalizedNewBody === normalizedPrevBody && normalizedNewBody === normalizedCurrentBody)) {
            return;
        }

        msg.body = newBody; // Ensure body is updated



        if (msg.fromMe) {
            await handleOwnGroupMessage(msg);
            return;
        }

        if (msg.from && (msg.from.endsWith('@broadcast') || msg.from.endsWith('@g.us'))) return;

        await handleMessage(msg, client);
    } catch (err) {
        console.error('❌ [Main] Error handling edited message:', err.message);
    }
});

// ─── Disconnection & Reconnect ──────────────────────────────
client.on('disconnected', (reason) => {
    if (shutdownHandler.isShuttingDown()) return;
    console.warn('⚠️  [Main] Client disconnected:', reason);
    stopScheduler();
    console.log('🔄 [Main] Attempting to reconnect in 5s…');
    setTimeout(async () => {
        if (shutdownHandler.isShuttingDown()) return;
        try {
            prepareSession(sessionDir);
            await client.initialize();
        } catch (err) {
            console.error('❌ [Main] Reconnect failed:', err.message);
        }
    }, 5000);
});

// ─── Global Error Handlers ──────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('💥 [Uncaught Exception]', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 [Unhandled Rejection]', reason);
});

// ─── Graceful Shutdown ──────────────────────────────────────
const shutdownHandler = setupGracefulShutdown({
    client,
    sessionDir,
    onShutdown: async () => {
        if (dailyRearmTimer) clearTimeout(dailyRearmTimer);
        if (dailyQrTimer) clearTimeout(dailyQrTimer);
        stopScheduler();
    },
});

process.on('exit', () => {
    removeSessionLocks(sessionDir);
});

// ─── Start ──────────────────────────────────────────────────
(async () => {
    // Proactively clean up any orphaned browser processes or stale locks from previous runs
    const cleaned = prepareSession(sessionDir);
    if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} orphaned browser process(es) from previous run.`);
    }

    // Runs before the menu so utils/blocklist.csv and utils/purchases.csv are created (if missing)
    // and ready to edit well before the bot connects.
    loadBlocklist();
    loyalty.ensureLoyaltyFile(config.LOYALTY_CSV_PATH);
    paymentVerifier.ensureLedgerFile(config.USED_UTR_CSV_PATH);

    const reader = (config.SCREENSHOT_READER || 'auto').toLowerCase();
    console.log(`🔍 Payment screenshots are read by: ${reader === 'ocr' ? 'free on-PC OCR' : reader === 'claude' ? 'Claude' : 'Claude, falling back to free OCR'}`);
    if (reader === 'claude' && !process.env.ANTHROPIC_API_KEY) {
        console.warn('⚠️  SCREENSHOT_READER=claude but ANTHROPIC_API_KEY is not set (add it to .env). Screenshots will wait for the admin.');
    }
    if (!config.ADMIN_NUMBER) {
        console.warn('⚠️  ADMIN_NUMBER is not set in Setting.txt. Screenshots that fail the automatic check cannot be sent for approval.');
    }

    runOpts = config.AUTO_DAILY ? defaultOptions() : await showMenu();

    if (diningPortal.isConfigured()) {
        await diningPortal.refreshQr('startup');
        scheduleDailyQrRefresh();
    } else {
        console.warn('⚠️  DINING_API_KEY is not set (add it to .env). The meal QR will not be fetched from the portal — utils/qr.png is used as is.');
    }

    // Apply CLI overrides to global config
    applyOverrides({
        ENABLE_NEGOTIATION: runOpts.ENABLE_NEGOTIATION,
        DEFAULT_PRICE: runOpts.DEFAULT_PRICE,
    });

    console.log('🔌 Connecting to WhatsApp…\n');
    try {
        await client.initialize();
    } catch (err) {
        if (err.message && err.message.includes('The browser is already running')) {
            console.warn('⚠️  Detected locked browser session. Cleaning up and retrying…');
            prepareSession(sessionDir);
            try {
                await client.initialize();
            } catch (retryErr) {
                console.error('❌ Failed to connect to WhatsApp after auto-cleanup:', retryErr.message);
                process.exit(1);
            }
        } else {
            console.error('❌ Failed to connect to WhatsApp:', err.message || err);
            process.exit(1);
        }
    }
})();
