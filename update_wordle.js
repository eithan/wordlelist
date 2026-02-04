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
 *   4. Fetch new answer from NYT API  →  current.txt
 *   5. Write meta.json with wordle_date  (= today's date in UTC+14)
 *   6. git commit + push
 *
 * Word source:
 *   https://www.nytimes.com/svc/wordle/v2/{YYYY-MM-DD}.json
 *   Returns: { solution, print_date, days_since_launch, id, editor }
 *   No auth required.  Future dates return tomorrow's word, so we only
 *   ever request the date we need (wordle_date = UTC+14 today).
 *
 * If the fetch fails for any reason, everything EXCEPT current.txt is
 * still pushed — the site keeps working with the previous word.
 */

'use strict';

const { execSync } = require('child_process');
const fs           = require('fs');
const https        = require('https');

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

/* ── NYT API fetch ── */
function fetchWordleAPI(date) {
    // date = "YYYY-MM-DD"
    const url = `https://www.nytimes.com/svc/wordle/v2/${date}.json`;
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            }
        }, res => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
            let data = '';
            res.on('data',  c => data += c);
            res.on('end',   () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Bad JSON: ${e.message}`)); }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
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
    const wordleDate  = utcPlus14.toISOString().split('T')[0];   // YYYY-MM-DD
    log(`wordle_date = ${wordleDate}`);

    /* 6. fetch new word from NYT API */
    let newWord = null;
    try {
        const puzzle = await fetchWordleAPI(wordleDate);
        newWord = puzzle.solution.toUpperCase();
        log(`NYT API → solution: ${newWord}  (days_since_launch: ${puzzle.days_since_launch})`);
        fs.writeFileSync(`${REPO_DIR}/current.txt`, newWord);
    } catch (e) {
        log(`⚠️  NYT API failed: ${e.message} — current.txt unchanged.`);
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
