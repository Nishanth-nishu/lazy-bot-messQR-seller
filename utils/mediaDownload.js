'use strict';

const crypto = require('crypto');

// Fallback for msg.downloadMedia(), which can fail inside WhatsApp Web with a
// minified error. WhatsApp media is an AES-256-CBC encrypted file on its CDN; the
// message itself carries the key, so we can fetch and decrypt it directly.

const MEDIA_INFO = {
    image: 'WhatsApp Image Keys',
    sticker: 'WhatsApp Image Keys',
    video: 'WhatsApp Video Keys',
    gif: 'WhatsApp Video Keys',
    ptt: 'WhatsApp Audio Keys',
    audio: 'WhatsApp Audio Keys',
    document: 'WhatsApp Document Keys',
};

const DOWNLOAD_TIMEOUT_MS = 20000;

function mediaUrl(data) {
    if (typeof data.deprecatedMms3Url === 'string' && data.deprecatedMms3Url.startsWith('https://')) {
        return data.deprecatedMms3Url;
    }
    if (typeof data.directPath === 'string' && data.directPath.startsWith('/')) {
        return `https://mmg.whatsapp.net${data.directPath}`;
    }
    return null;
}

/**
 * Download and decrypt a message's media from msg._data.
 * Returns { mimetype, data (base64), filename } or null.
 */
async function downloadDecrypted(msg) {
    const data = msg?._data || {};
    const info = MEDIA_INFO[data.type || msg?.type];
    const url = mediaUrl(data);
    if (!info || !url || !data.mediaKey) return null;

    const mediaKey = Buffer.from(data.mediaKey, 'base64');
    const expanded = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), info, 112));
    const iv = expanded.subarray(0, 16);
    const cipherKey = expanded.subarray(16, 48);
    const macKey = expanded.subarray(48, 80);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let encrypted;
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`media download HTTP ${res.status}`);
        encrypted = Buffer.from(await res.arrayBuffer());
    } finally {
        clearTimeout(timer);
    }

    const fileData = encrypted.subarray(0, encrypted.length - 10);
    const mac = encrypted.subarray(encrypted.length - 10);
    const expectedMac = crypto.createHmac('sha256', macKey).update(iv).update(fileData).digest().subarray(0, 10);
    if (!crypto.timingSafeEqual(mac, expectedMac)) throw new Error('media MAC mismatch');

    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    const plain = Buffer.concat([decipher.update(fileData), decipher.final()]);

    return {
        mimetype: data.mimetype || 'image/jpeg',
        data: plain.toString('base64'),
        filename: data.filename || null,
    };
}

module.exports = { downloadDecrypted };
