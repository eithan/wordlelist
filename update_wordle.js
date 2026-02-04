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
 *   4. Fetch new Wordle answer from NYT JS bundle  →  current.txt
 *   5. Write meta.json with wordle_date  (= today's date in UTC+14)
 *   6. git commit + push
 *
 * Word source: NYT embeds the full answer sequence in the Wordle game's
 * JavaScript bundle.  We download that bundle, find the answer array
 * (anchored on "cigar" = puzzle #0), and index by puzzle number.
 *
 * Puzzle number = days since 2021-06-19 (the epoch).
 * wordle_date   = the UTC+14 date at job-run time (always the next puzzle day).
 *
 * If the fetch fails for any reason, everything EXCEPT current.txt is
 * still pushed — the site keeps working with the previous word.
 */

'use strict';

const { execSync } = require('child_process');
const fs           = require('fs');
const https        = require('https');
const http         = require('http');
const path         = require('path');
const os           = require('os');

/* ── config ── */
const REPO_DIR   = '/tmp/wordlelist';
const LOG_FILE   = '/tmp/wordlelist_update.log';
const EPOCH      = new Date('2021-06-19T00:00:00Z'); // puzzle #0 = cigar

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

/* ── HTTP fetch (follows redirects, timeout 15 s) ── */
function httpsGet(url, depth = 0) {
    if (depth > 5) return Promise.reject(new Error('Too many redirects'));
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
            headers: {
                'User-Agent'     : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept'         : 'text/html,application/javascript,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
                return httpsGet(res.headers.location, depth + 1).then(resolve).catch(reject);
            // Accept both 200 and 404 — NYT sometimes returns 404 with full content
            if (res.statusCode >= 500)
                return reject(new Error(`HTTP ${res.statusCode}`));
            let data = '';
            res.on('data',  c => data += c);
            res.on('end',   () => resolve(data));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

/* ── NYT bundle: download wordle page, grab JS links, search for answer array ── */
async function fetchNewWord(puzzleNum) {
    log(`Fetching NYT Wordle page to find JS bundle …`);

    // 1. Get the Wordle HTML page
    const pageHtml = await httpsGet('https://www.nytimes.com/games/wordle/index.html');

    // 2. Extract JS file URLs (games-assets)
    const jsUrls = [];
    const re = /src="(\/games-assets\/[^"]+\.js)"/g;
    let m;
    while ((m = re.exec(pageHtml)) !== null) {
        jsUrls.push('https://www.nytimes.com' + m[1]);
    }
    log(`Found ${jsUrls.length} JS files`);

    // 3. Download each JS file and search for the answer array
    for (const jsUrl of jsUrls) {
        try {
            const jsText = await httpsGet(jsUrl);
            // Answer array contains "cigar" (puzzle #0 anchor) among many 5-letter words
            const arrayMatch = jsText.match(/\[(?:"[a-z]{5}",)*?"cigar"(?:,"[a-z]{5}")+\]/);
            if (!arrayMatch) continue;

            const arr       = JSON.parse(arrayMatch[0]);
            const cigarIdx  = arr.indexOf('cigar');
            const answers   = arr.slice(cigarIdx);   // answers[0] = cigar = puzzle #0
            log(`Found answer array: ${answers.length} answers (cigar at raw index ${cigarIdx})`);

            if (puzzleNum >= answers.length) {
                log(`ERROR: puzzle #${puzzleNum} exceeds known answers (${answers.length})`);
                return null;
            }

            const word = answers[puzzleNum].toUpperCase();
            log(`Puzzle #${puzzleNum} = ${word}`);
            return word;

        } catch (e) {
            // This JS file didn't have the array — keep looking
            continue;
        }
    }

    log('ERROR: answer array not found in any JS bundle');
    return null;
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

    /* 5. wordle_date = today in UTC+14 (the new puzzle's date) */
    const utcPlus14   = new Date(Date.now() + 14 * 60 * 60 * 1000);
    const wordleDate  = utcPlus14.toISOString().split('T')[0];
    log(`wordle_date = ${wordleDate}`);

    /* 6. compute puzzle number = days since epoch */
    const daysSinceEpoch = Math.round((utcPlus14 - EPOCH) / (24 * 60 * 60 * 1000));
    log(`Puzzle number = ${daysSinceEpoch}`);

    /* 7. fetch new word from NYT bundle */
    const newWord = await fetchNewWord(daysSinceEpoch);
    if (newWord) {
        fs.writeFileSync(`${REPO_DIR}/current.txt`, newWord);
    } else {
        log('⚠️  Word fetch FAILED — current.txt unchanged. Site will use previous word.');
    }

    /* 8. meta.json */
    const meta = { wordle_date: wordleDate, ran_at: new Date().toISOString() };
    fs.writeFileSync(`${REPO_DIR}/meta.json`, JSON.stringify(meta, null, 2) + '\n');

    /* 9. commit + push */
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
