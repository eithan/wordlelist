#!/usr/bin/env node
/**
 * Daily Wordle Word List Updater
 * ─────────────────────────────
 * Schedule: 10:00 UTC daily  (= midnight in UTC+14, first tz to see new Wordle)
 *
 * What it does each run:
 *   1. git pull
 *   2. Add safe.txt word → words.txt  (if exists; it's 2 days old, safe for all TZs)
 *   3. Rotate: prior.txt  →  safe.txt
 *   4. Rotate: current.txt  →  prior.txt
 *   5. Fetch new answer from NYT API  →  current.txt
 *   6. Write meta.json with wordle_date  (= today's date in UTC+14)
 *   7. git commit + push
 *
 * Timing note:
 *   Words are delayed by 1 extra day before adding to words.txt to ensure
 *   they're fully in the past for ALL timezones (not just UTC+14).
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
const REPO_DIR  = '/home/eithan/wordlelist';
const REPO_SLUG = 'eithan/wordlelist';
const LOG_FILE  = '/tmp/wordlelist_update.log';

/* ── helpers ── */
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function run(cmd) {
    return execSync(cmd, { cwd: REPO_DIR, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── deploy notification ──
 *  GitHub's push webhook already posts commits to Discord, but Discord's
 *  /github compat endpoint silently drops deployment_status / page_build
 *  events — so the deploy result never shows up there. After pushing we poll
 *  the Pages build to a terminal state (matched to the commit we just pushed)
 *  and post a native Discord message ourselves.
 *
 *  Everything here is best-effort: any failure is logged and swallowed so a
 *  hiccup in notification never blocks or fails the daily update.
 */
function notifyDiscord(payload) {
    let url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) { log('⚠️  DISCORD_WEBHOOK_URL not set — skipping deploy notify'); return Promise.resolve(); }
    url = url.replace(/\/github\/?$/, '');   // native Discord endpoint, not the GH-compat one

    return new Promise((resolve) => {
        try {
            const u    = new URL(url);
            const body = JSON.stringify(payload);
            const req  = https.request({
                hostname: u.hostname,
                path:     u.pathname + u.search,
                method:   'POST',
                headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, (res) => {
                if (res.statusCode >= 300) log(`⚠️  Discord notify HTTP ${res.statusCode}`);
                res.resume();
                res.on('end', resolve);
            });
            req.on('error', (e) => { log(`⚠️  Discord notify failed: ${e.message}`); resolve(); });
            req.write(body);
            req.end();
        } catch (e) { log(`⚠️  Discord notify error: ${e.message}`); resolve(); }
    });
}

/* Poll the Pages build until it reaches a terminal state for the pushed commit.
 * Returns the build object, or {status:'timeout'|'unknown'} if it can't resolve. */
async function waitForPagesDeploy(sha, { timeoutMs = 180000, intervalMs = 10000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let build;
        try {
            build = JSON.parse(run(`gh api repos/${REPO_SLUG}/pages/builds/latest`));
        } catch (e) {
            log(`⚠️  pages build poll failed: ${e.message}`);
            return { status: 'unknown' };
        }
        const terminal = build.status === 'built' || build.status === 'errored';
        if (terminal && build.commit === sha) return build;   // our commit's build finished
        await sleep(intervalMs);
    }
    return { status: 'timeout' };
}

/* ── git ── */
function gitSetup() {
    if (!fs.existsSync(REPO_DIR)) {
        execSync(`git clone git@github.com:eithan/wordlelist.git ${REPO_DIR}`, { encoding: 'utf-8' });
    } else {
        run('git pull --rebase origin main');
    }
    run('git remote set-url origin git@github.com:eithan/wordlelist.git');
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

/* ── answer history (drives the played-date tooltip) ──
 *  Record the word rotating into safe.txt this run at the top of answers.txt
 *  (the file is ordered newest-first), then rebuild played-dates.json. The
 *  puzzle number and date come from the current newest entry (max number + 1,
 *  its date + 1 day), so the history advances one entry per run in lockstep
 *  with the rotation — no network call, and it stays exactly one day behind the
 *  live puzzle, so today's answer never reaches the public JSON.
 */
function appendHistory(word) {
    const histPath = `${REPO_DIR}/answers.txt`;
    if (!fs.existsSync(histPath)) { log('⚠️  answers.txt missing — skipping history append'); return; }

    word = word.trim().toUpperCase();
    const raw   = fs.readFileSync(histPath, 'utf-8');
    const lines = raw.split('\n');

    // Locate the newest entry (highest puzzle number) and the first data-line
    // index, independent of file ordering.
    let maxNum = -1, maxDate = null, maxWord = null, firstDataIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t || t.startsWith('#')) continue;
        if (firstDataIdx === -1) firstDataIdx = i;
        const p = t.split(/\s+/);
        const n = parseInt((p[1] || '').replace(/[^\d]/g, ''), 10);
        const m = (p[2] || '').replace(/[^\d/]/g, '').match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
        if (isNaN(n) || !m) continue;
        if (n > maxNum) { maxNum = n; maxDate = m; maxWord = p[0].toUpperCase(); }
    }
    if (maxNum === -1) { log('⚠️  answers.txt has no parseable data lines — skipping history append'); return; }

    if (maxWord === word) { log(`History already at "${word}" (#${maxNum}) — skipping append`); return; }

    // next date = newest date + 1 day (UTC arithmetic avoids DST edge cases)
    const d = new Date(Date.UTC(2000 + parseInt(maxDate[3], 10), parseInt(maxDate[1], 10) - 1, parseInt(maxDate[2], 10)));
    d.setUTCDate(d.getUTCDate() + 1);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');

    const newLine = `${word} ${maxNum + 1} ${mm}/${dd}/${yy}`;
    lines.splice(firstDataIdx, 0, newLine);   // insert at top of data (newest-first)
    fs.writeFileSync(histPath, lines.join('\n'));
    log(`Recorded in answers.txt: ${newLine}`);

    try {
        // required lazily so a missing build script degrades to a logged
        // warning instead of killing the whole daily update at load time
        const { build: buildPlayedDates } = require('./build_played_dates.js');
        const r = buildPlayedDates();
        log(`Rebuilt played-dates.json: ${r.words} words, ${r.bytes} bytes`);
    } catch (e) {
        log(`⚠️  played-dates.json rebuild failed: ${e.message}`);
    }
}

/* ── fresh (never-played) openers ──
 *  The best opening words that have never themselves been a Wordle answer, so
 *  they keep a shot at the one-guess win on a day whose answer has never been
 *  played. MASTER_OPENERS is ranked best-first by coverage against the real-
 *  answer archive (same basis as the /best-starting-words/ page); the live
 *  list is the top five not yet in words.txt. Several near the top are valid
 *  guesses that have never been answers (ROATE, ORATE, SOARE, TARES, SANER,
 *  NARES, SERAI) and so can never drop off — there are always at least five.
 *
 *  Per the daily contract we recompute ONLY when a word on the current list
 *  has just become a past answer; otherwise the saved list carries forward
 *  untouched.
 */
const MASTER_OPENERS = [
    'ROATE', 'ORATE', 'SOARE', 'RAISE', 'ARISE', 'IRATE', 'AROSE', 'STARE',
    'SNARE', 'TRACE', 'CRATE', 'SLATE', 'CRANE', 'STALE', 'TARES', 'RATES',
    'TEARS', 'LATER', 'ALTER', 'ALERT', 'SANER', 'NARES', 'LEARN', 'LASER',
    'REACT', 'CATER', 'ROAST', 'SAINT', 'STAIN', 'SLANT', 'LEAST', 'STEAL',
    'PARSE', 'SPARE', 'SERAI'
];

function computeFreshOpeners(existing) {
    const played = new Set(
        fs.readFileSync(`${REPO_DIR}/words.txt`, 'utf-8').trim().split('\n')
          .map(w => w.trim().toUpperCase())
    );
    const stale = !Array.isArray(existing) || existing.length < 5 ||
                  existing.some(w => played.has(String(w).toUpperCase()));
    if (!stale) {
        log(`Fresh openers unchanged: ${existing.join(', ')}`);
        return existing;
    }
    const fresh = MASTER_OPENERS.filter(w => !played.has(w)).slice(0, 5);
    log(`Fresh openers recomputed → ${fresh.join(', ')}`);
    return fresh;
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

/* ── inject static word list into index.html (for SEO) ── */
function injectWordList() {
    const indexPath = `${REPO_DIR}/index.html`;
    const wordsPath = `${REPO_DIR}/words.txt`;
    const safePath  = `${REPO_DIR}/safe.txt`;

    // Build the word set: words.txt + safe.txt (both always safe to show publicly)
    const baseWords = fs.readFileSync(wordsPath, 'utf-8').trim().split('\n')
        .map(w => w.trim().toUpperCase())
        .filter(w => w.length === 5);

    if (fs.existsSync(safePath)) {
        const safeWord = fs.readFileSync(safePath, 'utf-8').trim().toUpperCase();
        if (safeWord.length === 5 && !baseWords.includes(safeWord)) {
            baseWords.push(safeWord);
            baseWords.sort();
        }
    }

    // Simple space-separated word paragraph — crawlable, honest, compact (~10KB)
    const block = `<p class="static-wordlist">${baseWords.join(' ')}</p>`;

    // Last updated date in MM/DD/YYYY format (UTC)
    const now   = new Date();
    const mm    = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd    = String(now.getUTCDate()).padStart(2, '0');
    const yyyy  = now.getUTCFullYear();
    const dateStr = `${mm}/${dd}/${yyyy}`;

    let html = fs.readFileSync(indexPath, 'utf-8');

    // ── inject word list ──
    const startMarker = '<!-- WORDS:START -->';
    const endMarker   = '<!-- WORDS:END -->';
    const startIdx = html.indexOf(startMarker);
    const endIdx   = html.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) {
        log('⚠️  Word list markers not found in index.html — skipping injection');
        return;
    }

    html =
        html.slice(0, startIdx + startMarker.length) +
        '\n        ' + block + '\n        ' +
        html.slice(endIdx);

    // ── refresh word counts in meta description + FAQ (visible & JSON-LD) ──
    const rounded = (Math.floor(baseWords.length / 10) * 10).toLocaleString('en-US');
    html = html.replace(/[\d,]+\+ words/g, `${rounded}+ words`);
    html = html.replace(/over [\d,]+ past Wordle answers/g, `over ${rounded} past Wordle answers`);

    // ── inject last updated date ──
    const dateStart = '<!-- DATE:START -->';
    const dateEnd   = '<!-- DATE:END -->';
    const dateStartIdx = html.indexOf(dateStart);
    const dateEndIdx   = html.indexOf(dateEnd);

    if (dateStartIdx !== -1 && dateEndIdx !== -1) {
        html =
            html.slice(0, dateStartIdx + dateStart.length) +
            dateStr +
            html.slice(dateEndIdx);
    } else {
        log('⚠️  Date markers not found in index.html — skipping date injection');
    }

    fs.writeFileSync(indexPath, html);
    log(`Injected ${baseWords.length} words + last updated ${dateStr} into index.html`);
}

/* ── update sitemap.xml with today's lastmod ── */
function updateSitemap() {
    const today = new Date().toISOString().split('T')[0];
    const sitemap =
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://wordlelist.com/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://wordlelist.com/hint/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://wordlelist.com/best-starting-words/</loc>
    <lastmod>2026-07-06</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://wordlelist.com/stats/</loc>
    <lastmod>2026-07-06</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>https://wordlelist.com/how-to-win/</loc>
    <lastmod>2026-07-06</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>https://wordlelist.com/wordle-alternatives/</loc>
    <lastmod>2026-07-06</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>https://wordlelist.com/solver/</loc>
    <lastmod>2026-07-06</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
</urlset>
`;
    fs.writeFileSync(`${REPO_DIR}/sitemap.xml`, sitemap);
    log(`Updated sitemap.xml with lastmod ${today}`);
}

/* ── main ── */
async function main() {
    log('=== Wordle updater START ===');

    /* 1. pull */
    log('git setup …');
    gitSetup();

    /* idempotency check — skip if already ran for today's UTC+14 date */
    const metaPath = `${REPO_DIR}/meta.json`;
    if (fs.existsSync(metaPath)) {
        const savedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const utcPlus14Now = new Date(Date.now() + 14 * 60 * 60 * 1000).toISOString().split('T')[0];
        if (savedMeta.wordle_date === utcPlus14Now) {
            log(`Already ran for ${utcPlus14Now} — skipping.`);
            log('=== Wordle updater DONE (no-op) ===\n');
            return;
        }
    }

    /* 2. read state */
    const safePath    = `${REPO_DIR}/safe.txt`;
    const priorWord   = fs.readFileSync(`${REPO_DIR}/prior.txt`,   'utf-8').trim().toUpperCase();
    const currentWord = fs.readFileSync(`${REPO_DIR}/current.txt`, 'utf-8').trim().toUpperCase();
    const safeWord    = fs.existsSync(safePath) ? fs.readFileSync(safePath, 'utf-8').trim().toUpperCase() : null;
    log(`State  →  safe: ${safeWord || '(none)'}  |  prior: ${priorWord}  |  current: ${currentWord}`);

    /* 3. add safe word to words.txt (it's 2 days old, safe for all timezones) */
    if (safeWord) {
        addWordToList(safeWord);
    }

    /* 4. rotate prior → safe */
    fs.writeFileSync(safePath, priorWord);
    log(`Rotated safe.txt = ${priorWord}`);

    /* 5. rotate current → prior */
    fs.writeFileSync(`${REPO_DIR}/prior.txt`, currentWord);
    log(`Rotated prior.txt = ${currentWord}`);

    /* 5b. record the now-safe word in the answer history + rebuild tooltip data */
    appendHistory(priorWord);

    /* 6. wordle_date = today in UTC+14 (the new puzzle's date) */
    const utcPlus14   = new Date(Date.now() + 14 * 60 * 60 * 1000);
    const wordleDate  = utcPlus14.toISOString().split('T')[0];   // YYYY-MM-DD
    log(`wordle_date = ${wordleDate}`);

    /* 7. fetch new word from NYT API */
    let newWord = null;
    try {
        const puzzle = await fetchWordleAPI(wordleDate);
        newWord = puzzle.solution.toUpperCase();
        log(`NYT API → solution: ${newWord}  (days_since_launch: ${puzzle.days_since_launch})`);
        fs.writeFileSync(`${REPO_DIR}/current.txt`, newWord);
    } catch (e) {
        log(`⚠️  NYT API failed: ${e.message} — current.txt unchanged.`);
    }

    /* 8. meta.json — carry the fresh-openers list forward, recomputing it only
       when a word on it has just become a past answer (computeFreshOpeners). */
    let prevMeta = null;
    try { prevMeta = JSON.parse(fs.readFileSync(`${REPO_DIR}/meta.json`, 'utf-8')); } catch (_) {}
    const meta = {
        wordle_date: wordleDate,
        ran_at: new Date().toISOString(),
        fresh_openers: computeFreshOpeners(prevMeta && prevMeta.fresh_openers)
    };
    fs.writeFileSync(`${REPO_DIR}/meta.json`, JSON.stringify(meta, null, 2) + '\n');

    /* 9. inject static word list + update sitemap */
    injectWordList();
    updateSitemap();

    /* 10. commit + push */
    run('git add words.txt safe.txt prior.txt current.txt meta.json index.html sitemap.xml answers.txt played-dates.json');
    try {
        run(`git commit -m "Daily update: ${wordleDate}${newWord ? ' — ' + ' (REDACTED newWord)' : ' (word fetch failed)'}"` );
    } catch (_) {
        log('Nothing to commit');
    }
    run('git push origin main');
    log('Pushed ✓');

    /* 11. wait for GitHub Pages to redeploy, then message Discord natively.
     *  Rendered as a green/red embed under the name "GitHub API" — deliberately
     *  distinct from the "GitHub" push messages, since this one is posted by us. */
    const sha   = run('git rev-parse HEAD');
    const build = await waitForPagesDeploy(sha);
    const ok    = build.status === 'built';
    const state = ok ? 'succeeded'
                : build.status === 'errored' ? 'failed'
                : `unresolved (${build.status})`;
    const detail = build.error && build.error.message ? `\n${build.error.message}` : '';
    const color  = ok ? 0x2ea043 : build.status === 'errored' ? 0xd1242f : 0xbf8700;   // green / red / amber
    log(`Deploy status: ${build.status}`);
    await notifyDiscord({
        username:   'GitHub API',
        avatar_url: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
        embeds: [{
            title:       `Pages deploy ${state}`,
            description: `[\`${sha.slice(0, 7)}\`](https://github.com/${REPO_SLUG}/commit/${sha}) · ${wordleDate}${detail}`,
            url:         `https://github.com/${REPO_SLUG}/deployments`,
            color
        }]
    });

    log('=== Wordle updater DONE ===\n');
}

main().catch(e => { log(`FATAL: ${e.message}\n${e.stack}`); process.exit(1); });
