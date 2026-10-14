/*
 * indexnow.js
 * -----------
 * Tells IndexNow (Bing, plus Yandex, Seznam, Naver and others that share
 * submissions) which pages changed, so they recrawl them now instead of
 * whenever they next get round to it. Google doesn't use IndexNow.
 *
 * The key is public by design: IndexNow checks ownership by fetching
 * https://wordlelist.com/<KEY>.txt and comparing its contents, so that file
 * has to stay at the site root.
 *
 * Best-effort, like the Discord notify: failures are logged and swallowed so
 * they never block a deploy. Call it only after the pages are live, or the
 * engines may recrawl the old version.
 */
'use strict';
const fs = require('fs');
const https = require('https');
const path = require('path');

const HOST = 'wordlelist.com';
const KEY = 'acc502f509699474b465aa544e3afed2';

/* repo paths → page URLs: index.html → /, hint/index.html → /hint/; others dropped */
function pageUrls(files) {
    return [...new Set(files.map(f => f.trim()).filter(f => /(^|\/)index\.html$/.test(f))
        .map(f => `https://${HOST}/${f.replace(/index\.html$/, '')}`))];
}

const MEANING = {
    200: 'accepted', 202: 'accepted (key check pending)', 400: 'bad request', 403: 'key not valid',
    422: "URLs don't match the host or key", 429: 'too many requests'
};

function submit(urls, log = console.log) {
    if (!urls.length) { log('IndexNow: no changed pages to submit'); return Promise.resolve(); }
    if (!fs.existsSync(path.join(__dirname, `${KEY}.txt`))) {
        log(`⚠️  IndexNow: key file ${KEY}.txt missing — skipping`);
        return Promise.resolve();
    }
    const body = JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls });
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.indexnow.org', path: '/indexnow', method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            const ok = res.statusCode === 200 || res.statusCode === 202;
            log(`${ok ? '' : '⚠️  '}IndexNow: ${urls.length} URL${urls.length === 1 ? '' : 's'} → HTTP ${res.statusCode} ${MEANING[res.statusCode] || ''} (${urls.join(' ')})`);
            res.resume();
            res.on('end', resolve);
        });
        req.on('error', (e) => { log(`⚠️  IndexNow failed: ${e.message}`); resolve(); });
        req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
        req.write(body);
        req.end();
    });
}

/* Resolves once `url` serves HTML containing `marker` (polls with a cache-buster). */
function waitForLive(url, marker, { timeoutMs = 600000, intervalMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const fetchText = u => new Promise((resolve) => {
        https.get(u, { headers: { 'User-Agent': 'wordlelist-deploy-bot/1.0 (+https://wordlelist.com)' } }, (res) => {
            let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(d));
        }).on('error', () => resolve(''));
    });
    return (async function poll() {
        while (Date.now() < deadline) {
            if ((await fetchText(`${url}?_=${Date.now()}`)).includes(marker)) return true;
            await new Promise(r => setTimeout(r, intervalMs));
        }
        return false;
    })();
}

module.exports = { submit, pageUrls, waitForLive, KEY };
