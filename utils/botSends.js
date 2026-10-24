'use strict';

// Remembers which chats the bot itself just messaged, so an outgoing message we did
// NOT send can be recognised as the owner typing from their phone.

const RECENT_MS = 60 * 1000;
const lastSent = new Map(); // chatId -> timestamp

function record(chatId) {
    if (chatId) lastSent.set(String(chatId), Date.now());
}

function wasRecentlySentByBot(chatId) {
    const at = lastSent.get(String(chatId));
    return Boolean(at && Date.now() - at < RECENT_MS);
}

/** Wrap client.sendMessage (chat.sendMessage goes through it too). */
function trackClient(client) {
    const original = client.sendMessage.bind(client);
    client.sendMessage = (chatId, ...rest) => {
        record(chatId);
        return original(chatId, ...rest);
    };
}

module.exports = { record, wasRecentlySentByBot, trackClient };
