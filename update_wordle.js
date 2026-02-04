#!/usr/bin/env node
/**
 * Daily Wordle Word List Updater
 * ─────────────────────────────
 * Schedule: 10:00 UTC daily  (= midnight in UTC+14, first tz to see new Wordle)
 *
 * What it does each run:
 *   1. git pull
 *   2. Add prior.txt word → words.txt  (alphabetical insert, no dupes)
 *   3. Rotate: current.txt  →  prior.txt
 *   4. Fetch new Wordle answer  →  current.txt   (best-effort scrape)
 *   5. Write meta.json with wordle_date  (= today's date in UTC+14)
 *   6. git commit + push
 *
 * If the word fetch fails, everything EXCEPT current.txt is still pushed.
 * The site will keep working with the previous current word until the next run.
 */

'use strict';

const { execSync } = require('child_process');
const fs            = require('fs');
const https         = require('https');
const http          = require('http');

/* ── config ── */
const REPO_DIR = '/tmp/wordlelist';
const LOG_FILE = '/tmp/wordlelist_update.log';

/* ── helpers ── */
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function run(cmd) {
    return execSync(cmd, { cwd: REPO_DIR, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/* ── git ── */
function gitSetup() {
    if (!fs.existsSync(REPO_DIR)) {
        execSync(`gh repo clone eithan/wordlelist ${REPO_DIR}`, { encoding: 'utf-8' });
    } else {
        run('git pull --rebase origin main');
    }
    const token = execSync('gh auth token', { encoding: 'utf-8' }).trim();
    run(`git remote set-url origin https://x-access-token:${token}@github.com/eithan/wordlelist.git`);
    run('git config user.email "jarvis@openclaw.ai"');
    run('git config user.name  "Jarvis"');
}

/* ── words.txt ── */
function addWordToList(word) {
    const p     = `${REPO_DIR}/words.txt`;
    const words = fs.readFileSync(p, 'utf-8').trim().split('\n').map(w => w.trim());
    word = word.trim().toUpperCase();
    if (words.includes(word)) { log(`"${word}" already in words.txt`); return; }
    words.push(word);
    words.sort();
    fs.writeFileSync(p, words.join('\n') + '\n');
    log(`Added "${word}" to words.txt  (${words.length} words)`);
}

/* ── HTTP fetch (follows redirects, timeout 10 s) ── */
function httpsGet(url, depth = 0) {
    if (depth > 5) return Promise.reject(new Error('Too many redirects'));
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept'    : 'text/html,application/xhtml+xml;q=0.9',
            }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
                return httpsGet(res.headers.location, depth + 1).then(resolve).catch(reject);
            if (res.statusCode !== 200)
                return reject(new Error(`HTTP ${res.statusCode}`));
            let data = '';
            res.on('data',  c => data += c);
            res.on('end',   () => resolve(data));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

/* ── scrape sources (try in order) ── */
function extractWord(html) {
    // 1. og:description  →  first 5-letter uppercase word
    const og = html.match(/og:description[^>]*content="([^"]{0,400})"/i);
    if (og) {
        const m = og[1].match(/\b([A-Z]{5})\b/);
        if (m) return m[1];
    }
    // 2. "answer is XXXXX" / "solution is XXXXX"
    const ans = html.match(/(?:answer|solution)\s+(?:is|was)\s*[:\-–—\s"']*\b([A-Za-z]{5})\b/i);
    if (ans) return ans[1].toUpperCase();
    // 3. "the word is XXXXX"
    const w = html.match(/the\s+word\s+is\s*[:\-–—\s"']*\b([A-Za-z]{5})\b/i);
    if (w) return w[1].toUpperCase();
    return null;
}

const SOURCES = [
    'https://www.tomsguide.com/news/wordle-answer-today',
    'https://www.thesun.co.uk/online-games/wordle-answer-today/',
    'https://www.express.co.uk/life-style/games/1830093/Wordle-answer-today',
];

async function fetchNewWord() {
    for (const url of SOURCES) {
        try {
            log(`Trying ${url} …`);
            const html = await httpsGet(url);
            const word = extractWord(html);
            if (word) { log(`Got word: ${word}`); return word; }
            log('  → parsed but no word found');
        } catch (e) {
            log(`  → ${e.message}`);
        }
    }
    return null; // all failed
}

/* ── main ── */
async function main() {
    log('=== Wordle updater START ===');

    /* 1. pull */
    log('git setup …');
    gitSetup();

    /* 2. read state */
    const priorWord   = fs.readFileSync(`${REPO_DIR}/prior.txt`,   'utf-8').trim().toUpperCase();
    const currentWord = fs.readFileSync(`${REPO_DIR}/current.txt`, 'utf-8').trim().toUpperCase();
    log(`State  →  prior: ${priorWord}  |  current: ${currentWord}`);

    /* 3. inject prior → words.txt */
    addWordToList(priorWord);

    /* 4. rotate current → prior */
    fs.writeFileSync(`${REPO_DIR}/prior.txt`, currentWord);
    log(`Rotated prior.txt = ${currentWord}`);

    /* 5. wordle_date = today in UTC+14 */
    const utcPlus14   = new Date(Date.now() + 14 * 60 * 60 * 1000);
    const wordleDate  = utcPlus14.toISOString().split('T')[0];        // YYYY-MM-DD
    log(`wordle_date = ${wordleDate}`);

    /* 6. fetch new word → current.txt */
    const newWord = await fetchNewWord();
    if (newWord) {
        fs.writeFileSync(`${REPO_DIR}/current.txt`, newWord);
    } else {
        log('⚠️  Word fetch FAILED — current.txt unchanged. Site will use previous word.');
    }

    /* 7. meta.json */
    const meta = { wordle_date: wordleDate, ran_at: new Date().toISOString() };
    fs.writeFileSync(`${REPO_DIR}/meta.json`, JSON.stringify(meta, null, 2) + '\n');

    /* 8. commit + push */
    run('git add words.txt prior.txt current.txt meta.json');
    try {
        run(`git commit -m "Daily update: ${wordleDate}${newWord ? ' — ' + newWord : ' (word fetch failed)'}"` );
    } catch (_) {
        log('Nothing to commit');
    }
    run('git push origin main');
    log('Pushed ✓');

    log('=== Wordle updater DONE ===\n');
}

main().catch(e => { log(`FATAL: ${e.message}\n${e.stack}`); process.exit(1); });
