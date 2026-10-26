'use strict';

/**
 * Group reactions — resilient to WhatsApp Web UI/internal changes.
 *
 * Why this file exists (verified against WhatsApp Web on 2026-08-08):
 *
 *  1. `client.getChats()` is unusable. It serialises EVERY chat through
 *     `getChatModel`, which touches IndexedDB for group metadata and blows up
 *     with "Failed to execute 'get' on 'IDBObjectStore': No key or key range
 *     specified". When that rejection happens inside the page, `pupPage.evaluate`
 *     hands back `undefined` and the library then does `chats.map(...)` —
 *     which is the "Cannot read properties of undefined (reading 'map')" error.
 *     We only ever need {id, name}, so we read the Chat collection directly.
 *
 *  2. Message IDs cannot be rebuilt by hand. WhatsApp minifies `_serialized`
 *     (it showed up as `$1`), and an own group message's real key carries a
 *     trailing `@lid` participant:
 *         true_<group>@g.us_<hex>_<participant>@lid
 *     Rebuilding it as `true_<group>_<hex>` makes `Msg.get()` miss, so
 *     `client.sendReaction(id, ...)` silently no-ops. We therefore never round
 *     trip through an ID string: we match the live model by its raw `id.id`
 *     hex (stable, un-minified) and hand the model object straight to
 *     `sendReactionToMsg`.
 *
 *  3. Removal must be the empty string. `null`/`undefined` throw
 *     ("Cannot read properties of null (reading 'replace')").
 *
 * Everything below degrades instead of throwing: each module name, collection
 * accessor and field read has fallbacks, and the page toolkit reinstalls itself
 * if WhatsApp reloads the page underneath us.
 */

const REACTION_EMOJI = '✅';
const TOOLKIT_KEY = '__messBotReactions';

// ─── Node-side state ────────────────────────────────────────
let client = null;
let targetGroups = [];              // [{ id, name }]
const trackedMessages = new Map();  // rawId -> { chatId, at }
const reactedMessages = new Map();  // rawId -> { chatId }

function setClient(c) { client = c; }

// ═══════════════════════════════════════════════════════════════
//  PAGE TOOLKIT  (stringified and injected — keep it self-contained)
// ═══════════════════════════════════════════════════════════════

function buildToolkit() {
    const T = {};

    // Try a list of module names, first one that resolves wins.
    T.req = function (names) {
        for (let i = 0; i < names.length; i++) {
            try {
                const m = window.require(names[i]);
                if (m) return m;
            } catch (e) { /* try the next name */ }
        }
        return null;
    };

    T.coll = function () { return T.req(['WAWebCollections']); };

    // A Wid ("...@g.us") as a string, whatever WhatsApp minified this build.
    T.widStr = function (wid) {
        if (!wid) return null;
        if (typeof wid === 'string') return wid;
        try { if (typeof wid._serialized === 'string') return wid._serialized; } catch (e) { }
        try {
            const s = wid.toString();
            if (typeof s === 'string' && s.indexOf('@') !== -1) return s;
        } catch (e) { }
        try {
            const keys = Object.keys(wid);
            for (let i = 0; i < keys.length; i++) {
                const v = wid[keys[i]];
                if (typeof v === 'string' && v.indexOf('@') !== -1) return v;
            }
        } catch (e) { }
        return null;
    };

    // Full serialized message key, e.g. true_<chat>@g.us_<hex>_<participant>@lid
    T.msgKey = function (msg) {
        if (!msg || !msg.id) return null;
        const id = msg.id;
        try { if (typeof id._serialized === 'string') return id._serialized; } catch (e) { }
        try {
            const s = id.toString();
            if (typeof s === 'string' && (s.indexOf('true_') === 0 || s.indexOf('false_') === 0)) return s;
        } catch (e) { }
        try {
            const keys = Object.keys(id);
            for (let i = 0; i < keys.length; i++) {
                const v = id[keys[i]];
                if (typeof v === 'string' && (v.indexOf('true_') === 0 || v.indexOf('false_') === 0)) return v;
            }
        } catch (e) { }
        try {
            const remote = T.widStr(id.remote);
            if (remote && id.id) {
                const participant = T.widStr(id.participant);
                return (id.fromMe ? 'true' : 'false') + '_' + remote + '_' + id.id +
                    (participant ? '_' + participant : '');
            }
        } catch (e) { }
        return null;
    };

    // Raw hex id — the one field that survives every rename we have seen.
    T.rawId = function (msg) {
        try { return (msg && msg.id && typeof msg.id.id === 'string') ? msg.id.id : null; } catch (e) { return null; }
    };

    T.models = function (holder) {
        if (!holder) return [];
        try { if (typeof holder.getModelsArray === 'function') { const a = holder.getModelsArray(); if (Array.isArray(a)) return a; } } catch (e) { }
        try { if (Array.isArray(holder.models)) return holder.models; } catch (e) { }
        try { if (Array.isArray(holder._models)) return holder._models; } catch (e) { }
        return [];
    };

    T.allChats = function () {
        const C = T.coll();
        if (!C) return [];
        const holders = [C.Chat, C.ChatCollection, C.WAWebChatCollection];
        for (let i = 0; i < holders.length; i++) {
            const a = T.models(holders[i]);
            if (a.length) return a;
        }
        return [];
    };

    T.chatName = function (chat) {
        const direct = [chat.formattedTitle, chat.name, chat.subject];
        for (let i = 0; i < direct.length; i++) {
            if (typeof direct[i] === 'string' && direct[i].trim()) return direct[i].trim();
        }
        try {
            if (chat.groupMetadata && typeof chat.groupMetadata.subject === 'string' && chat.groupMetadata.subject.trim()) {
                return chat.groupMetadata.subject.trim();
            }
        } catch (e) { }
        try {
            const G = T.req(['WAWebChatGetters']);
            if (G && typeof G.getFormattedTitle === 'function') {
                const s = G.getFormattedTitle(chat);
                if (typeof s === 'string' && s.trim()) return s.trim();
            }
        } catch (e) { }
        try {
            if (chat.contact && typeof chat.contact.name === 'string' && chat.contact.name.trim()) return chat.contact.name.trim();
        } catch (e) { }
        return null;
    };

    T.listGroups = function () {
        const chats = T.allChats();
        const out = [];
        for (let i = 0; i < chats.length; i++) {
            const id = T.widStr(chats[i].id);
            if (!id || id.indexOf('@g.us') === -1) continue;
            out.push({ id: id, name: T.chatName(chats[i]) });
        }
        return out;
    };

    T.getChat = function (chatId) {
        const C = T.coll();
        if (C && C.Chat) {
            try {
                const F = T.req(['WAWebWidFactory']);
                if (F && typeof F.createWid === 'function') {
                    const c = C.Chat.get(F.createWid(chatId));
                    if (c) return c;
                }
            } catch (e) { }
            try { const c = C.Chat.get(chatId); if (c) return c; } catch (e) { }
        }
        const chats = T.allChats();
        for (let i = 0; i < chats.length; i++) {
            if (T.widStr(chats[i].id) === chatId) return chats[i];
        }
        return null;
    };

    T.chatMsgs = function (chat) {
        try { return T.models(chat.msgs); } catch (e) { return []; }
    };

    // Pull older messages in so a freshly-booted page can still find our ads.
    T.loadMore = async function (chat, rounds) {
        const L = T.req(['WAWebChatLoadMessages']);
        if (!L || typeof L.loadEarlierMsgs !== 'function') return;
        for (let i = 0; i < rounds; i++) {
            try {
                const r = await L.loadEarlierMsgs({ chat: chat });
                if (!r || !r.length) break;
            } catch (e) { break; }
        }
    };

    T.ownMessages = async function (chatId, opts) {
        const chat = T.getChat(chatId);
        if (!chat) return { error: 'chat-not-found', messages: [] };

        let msgs = T.chatMsgs(chat).filter(function (m) { return m && m.id && m.id.fromMe && !m.isNotification; });
        if (opts && opts.loadRounds && msgs.length < (opts.minimum || 0)) {
            await T.loadMore(chat, opts.loadRounds);
            msgs = T.chatMsgs(chat).filter(function (m) { return m && m.id && m.id.fromMe && !m.isNotification; });
        }
        if (opts && opts.sinceTs) {
            msgs = msgs.filter(function (m) { return !m.t || m.t >= opts.sinceTs; });
        }
        return {
            error: null,
            messages: msgs.map(function (m) {
                return {
                    rawId: T.rawId(m),
                    key: T.msgKey(m),
                    body: (m.body || m.caption || '').slice(0, 60),
                    hasReaction: !!m.hasReaction,
                    t: m.t || null,
                };
            }),
        };
    };

    // Hand the live model straight to WhatsApp's action — no ID round trip.
    T.dispatch = async function (msg, emoji) {
        const A = T.req(['WAWebSendReactionMsgAction']);
        if (A && typeof A.sendReactionToMsg === 'function') {
            await A.sendReactionToMsg(msg, emoji);
            return 'WAWebSendReactionMsgAction.sendReactionToMsg';
        }
        // If WhatsApp renames the module, look for any sendReaction-ish export.
        const alts = ['WAWebMsgReactionsBridge', 'WAWebReactionsCollection', 'WAWebSendReactionsMsgAction', 'WAWebApiReaction'];
        for (let i = 0; i < alts.length; i++) {
            const m = T.req([alts[i]]);
            if (!m) continue;
            const keys = Object.keys(m);
            for (let j = 0; j < keys.length; j++) {
                if (/sendreaction/i.test(keys[j]) && typeof m[keys[j]] === 'function') {
                    await m[keys[j]](msg, emoji);
                    return alts[i] + '.' + keys[j];
                }
            }
        }
        if (window.Store && typeof window.Store.sendReaction === 'function') {
            await window.Store.sendReaction(msg, emoji);
            return 'Store.sendReaction';
        }
        throw new Error('no reaction API available in this WhatsApp build');
    };

    /**
     * Apply `emoji` ('' removes) to own messages in `chatId`.
     * `rawIds` narrows to specific messages; null means "every own message"
     * (optionally only those that currently carry a reaction).
     */
    T.apply = async function (chatId, rawIds, emoji, opts) {
        const options = opts || {};
        const chat = T.getChat(chatId);
        if (!chat) return { chatId: chatId, error: 'chat-not-found', matched: 0, ok: 0, failed: 0, api: null, errors: [], done: [] };

        let msgs = T.chatMsgs(chat).filter(function (m) { return m && m.id && m.id.fromMe && !m.isNotification; });

        const wanted = rawIds && rawIds.length ? rawIds : null;
        const found = function () {
            let list = msgs;
            if (wanted) {
                list = list.filter(function (m) { return wanted.indexOf(T.rawId(m)) !== -1; });
            } else {
                if (options.sinceTs) list = list.filter(function (m) { return !m.t || m.t >= options.sinceTs; });
                if (options.onlyReacted) list = list.filter(function (m) { return !!m.hasReaction; });
                if (options.excludeRawIds && options.excludeRawIds.length) {
                    list = list.filter(function (m) { return options.excludeRawIds.indexOf(T.rawId(m)) === -1; });
                }
                if (options.limit) list = list.slice(-options.limit);
            }
            return list;
        };

        let targets = found();
        // Not in the loaded window yet? Pull history and look again.
        if (targets.length < (wanted ? wanted.length : 1) && options.loadRounds) {
            await T.loadMore(chat, options.loadRounds);
            msgs = T.chatMsgs(chat).filter(function (m) { return m && m.id && m.id.fromMe && !m.isNotification; });
            targets = found();
        }

        const result = { chatId: chatId, error: null, matched: targets.length, ok: 0, failed: 0, api: null, errors: [], done: [] };

        for (let i = 0; i < targets.length; i++) {
            const m = targets[i];
            try {
                const api = await T.dispatch(m, emoji);
                result.api = api;
                result.ok++;
                result.done.push({ rawId: T.rawId(m), key: T.msgKey(m), hadReaction: !!m.hasReaction });
            } catch (e) {
                result.failed++;
                if (result.errors.length < 3) result.errors.push(String(e && e.message ? e.message : e));
            }
        }

        // Give WhatsApp a moment, then read back what the model says.
        if (result.ok) {
            await new Promise(function (r) { setTimeout(r, 600); });
            for (let i = 0; i < result.done.length; i++) {
                const d = result.done[i];
                for (let j = 0; j < targets.length; j++) {
                    if (T.rawId(targets[j]) === d.rawId) { d.nowHasReaction = !!targets[j].hasReaction; break; }
                }
            }
        }
        return result;
    };

    return T;
}

// ═══════════════════════════════════════════════════════════════
//  NODE-SIDE BRIDGE
// ═══════════════════════════════════════════════════════════════

const TOOLKIT_SOURCE = `window.${TOOLKIT_KEY} = (${buildToolkit.toString()})();`;

/**
 * Install (or reinstall) the page toolkit. Passing a *string* to evaluate goes
 * through CDP Runtime.evaluate, which is not subject to the page's CSP.
 */
async function ensureToolkit() {
    if (!client || !client.pupPage) throw new Error('client not ready');

    const present = await client.pupPage
        .evaluate((key) => typeof window[key] === 'object' && window[key] !== null, TOOLKIT_KEY)
        .catch(() => false);

    if (!present) await client.pupPage.evaluate(TOOLKIT_SOURCE);
}

async function callToolkit(method, args) {
    await ensureToolkit();
    return client.pupPage.evaluate(
        async (key, fn, params) => {
            const T = window[key];
            if (!T || typeof T[fn] !== 'function') return { error: 'toolkit-missing:' + fn };
            return await T[fn].apply(T, params);
        },
        TOOLKIT_KEY,
        method,
        args,
    );
}

// ─── Group resolution ───────────────────────────────────────

/**
 * Resolve the configured group names to chat IDs without ever calling
 * `client.getChats()`. Returns { groups, available }.
 */
async function resolveTargetGroups(names) {
    const wanted = (names && names.length ? names : config().GROUP_NAMES || [])
        .map((n) => String(n).trim())
        .filter(Boolean);

    let available = [];
    try {
        available = (await callToolkit('listGroups', [])) || [];
    } catch (err) {
        console.error('❌ [Reactions] Could not read the group list:', err.message);
        return { groups: [], available: [] };
    }

    // A group matches if its name contains any configured name (case and extra spaces ignored),
    // so "Mess Buy Sell" picks up "Mess Buy Sell @ IIITH", "Mess Buy Sell - 2 @ IIITH", etc.
    const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
    const wantedNormalized = wanted.map(normalize);
    const groups = available.filter(
        (g) => g.name && wantedNormalized.some((w) => normalize(g.name).includes(w)),
    );

    targetGroups = groups;
    return { groups, available };
}

function getTargetGroups() { return targetGroups; }
function setTargetGroups(groups) { targetGroups = groups || []; }

// Lazily re-resolve if the cache is empty (e.g. after a reconnect).
async function requireTargetGroups() {
    if (targetGroups.length) return targetGroups;
    const { groups } = await resolveTargetGroups();
    return groups;
}

// ─── Message tracking ───────────────────────────────────────

/**
 * Remember a message we posted to a target group. This is the primary source of
 * truth for reactions — far more reliable than re-reading history later.
 */
function trackSentMessage(msg, chatId) {
    const rawId = msg && msg.id && typeof msg.id.id === 'string' ? msg.id.id : null;
    if (!rawId) return null;

    const chat = chatId || (msg.id && typeof msg.id.remote === 'string' ? msg.id.remote : null) || msg.to || msg.from;
    trackedMessages.set(rawId, { chatId: chat, at: Date.now() });
    return rawId;
}

function forgetTrackedMessages() {
    trackedMessages.clear();
    reactedMessages.clear();
}

function groupTrackedByChat() {
    const byChat = new Map();
    for (const [rawId, meta] of trackedMessages.entries()) {
        if (!meta.chatId) continue;
        if (!byChat.has(meta.chatId)) byChat.set(meta.chatId, []);
        byChat.get(meta.chatId).push(rawId);
    }
    return byChat;
}

// ─── Public operations ──────────────────────────────────────

/**
 * React ✅ to the messages we posted in the target groups.
 * Falls back to recent own group messages when nothing was tracked
 * (for example when the bot was restarted mid-sale).
 */
async function reactToGroupMessages(emoji = REACTION_EMOJI) {
    const groups = await requireTargetGroups();
    if (!groups.length) {
        console.warn('⚠️  [Reactions] No target groups resolved — nothing to react to.');
        return { ok: 0, matched: 0, failed: 0 };
    }

    const tracked = groupTrackedByChat();
    const sinceTs = Math.floor((Date.now() - 12 * 60 * 60 * 1000) / 1000);
    const totals = { ok: 0, matched: 0, failed: 0 };

    for (const group of groups) {
        const rawIds = tracked.get(group.id) || null;
        // Only mark the sell posts the bot itself sent — never fall back to "your recent
        // messages", which would tick things you posted by hand (lunch sales, exchanges…).
        if (!rawIds || !rawIds.length) {
            console.log(`ℹ️  [Reactions] "${group.name}": no bot sell posts tracked today — leaving your messages alone.`);
            continue;
        }
        try {
            const res = await callToolkit('apply', [
                group.id,
                rawIds,
                emoji,
                { sinceTs, limit: 20, loadRounds: 3 },
            ]);

            if (!res || res.error) {
                console.error(`❌ [Reactions] "${group.name}": ${res ? res.error : 'no response'}`);
                continue;
            }

            totals.ok += res.ok;
            totals.matched += res.matched;
            totals.failed += res.failed;

            for (const d of res.done || []) reactedMessages.set(d.rawId, { chatId: group.id });

            if (res.failed) {
                console.error(`❌ [Reactions] "${group.name}": ${res.failed} failed — ${res.errors.join('; ')}`);
            }
            if (!res.matched) {
                console.warn(`⚠️  [Reactions] "${group.name}": no own messages found to react to.`);
            }
        } catch (err) {
            console.error(`❌ [Reactions] "${group.name}" react failed:`, err.message);
        }
    }

    if (totals.ok) {
        console.log(`✅ [Reactions] Marked ${totals.ok}/${totals.matched} message(s) with ${emoji} across ${groups.length} group(s).`);
    } else {
        console.warn(`⚠️  [Reactions] Could not mark any message with ${emoji}.`);
    }
    return totals;
}

/**
 * Remove reactions from our target-group messages — both the ones this bot
 * added and any added by hand from the phone.
 * WhatsApp requires the empty string here; null/undefined throw inside the page.
 */
async function clearGroupReactions() {
    const groups = await requireTargetGroups();
    if (!groups.length) {
        console.warn('⚠️  [Reactions] No target groups resolved — nothing to clear.');
        return { ok: 0, matched: 0, failed: 0 };
    }

    const tracked = groupTrackedByChat();
    const totals = { ok: 0, matched: 0, failed: 0 };

    for (const group of groups) {
        // Union of what we sent and what we reacted to, so a restart or a manual
        // tap on the phone still gets cleaned up.
        const rawIds = new Set([...(tracked.get(group.id) || [])]);
        for (const [rawId, meta] of reactedMessages.entries()) {
            if (meta.chatId === group.id) rawIds.add(rawId);
        }

        // Only undo the bot's own posts/reactions — never touch ✅s you put on your own messages.
        const passes = [];
        if (rawIds.size) passes.push({ ids: [...rawIds], opts: { loadRounds: 3 } });

        for (const pass of passes) {
            try {
                const res = await callToolkit('apply', [group.id, pass.ids, '', pass.opts]);
                if (!res || res.error) {
                    if (res && res.error) console.error(`❌ [Reactions] "${group.name}": ${res.error}`);
                    continue;
                }
                totals.ok += res.ok;
                totals.matched += res.matched;
                totals.failed += res.failed;
                if (res.failed) {
                    console.error(`❌ [Reactions] "${group.name}": ${res.failed} removal(s) failed — ${res.errors.join('; ')}`);
                }
            } catch (err) {
                console.error(`❌ [Reactions] "${group.name}" clear failed:`, err.message);
            }
        }
    }

    reactedMessages.clear();

    if (totals.ok) {
        console.log(`🧹 [Reactions] Sent reaction-removal for ${totals.ok} message(s) across ${groups.length} group(s).`);
    } else {
        console.warn('⚠️  [Reactions] Found no reacted messages to clear.');
    }
    return totals;
}

/** React to a single message we just posted (live path). */
async function reactToSingleMessage(msg, chatId, emoji = REACTION_EMOJI) {
    const rawId = trackSentMessage(msg, chatId);
    if (!rawId) return false;

    const chat = trackedMessages.get(rawId).chatId;
    if (!chat) return false;

    try {
        const res = await callToolkit('apply', [chat, [rawId], emoji, { loadRounds: 1 }]);
        if (res && res.ok) {
            reactedMessages.set(rawId, { chatId: chat });
            return true;
        }
        if (res && res.error) console.error(`❌ [Reactions] single react: ${res.error}`);
        else if (res && res.errors && res.errors.length) console.error(`❌ [Reactions] single react: ${res.errors.join('; ')}`);
        return false;
    } catch (err) {
        console.error('❌ [Reactions] single react failed:', err.message);
        return false;
    }
}

/** Read back own messages in a group — used by diagnostics. */
async function inspectGroup(chatId, opts = {}) {
    return callToolkit('ownMessages', [chatId, Object.assign({ loadRounds: 3, minimum: 5 }, opts)]);
}

// Deferred require so config's file reads happen at call time, not load time.
function config() { return require('./config'); }

module.exports = {
    REACTION_EMOJI,
    setClient,
    resolveTargetGroups,
    getTargetGroups,
    setTargetGroups,
    trackSentMessage,
    forgetTrackedMessages,
    reactToGroupMessages,
    clearGroupReactions,
    reactToSingleMessage,
    inspectGroup,
};
