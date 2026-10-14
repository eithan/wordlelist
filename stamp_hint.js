#!/usr/bin/env node
/*
 * stamp_hint.js
 * -------------
 * Writes today's puzzle number and date into the static HTML of /hint/ — the
 * title, descriptions, social tags, JSON-LD and the subtitle — so search
 * engines see a page that changes daily. Visitors never depend on it: the
 * page's own script still picks their puzzle by their local date and
 * overwrites the subtitle.
 *
 * "Today" is the US Eastern date, the frame NYT and most searchers use. The
 * stamp holds only the number and date, nothing about the answer.
 *
 * Two callers:
 *   - cron at 00:05 Eastern (23:05 Central) runs this file directly, which
 *     pulls, stamps, and commits + pushes hint/index.html if it changed;
 *   - update_wordle.js calls stamp() as a catch-up in case that run missed.
 * Idempotent: if the page already shows today's puzzle, nothing changes.
 *
 *   node stamp_hint.js           pull, stamp, commit, push
 *   node stamp_hint.js --local   stamp the file only (no git)
 */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_DIR = __dirname;
const DEST = path.join(REPO_DIR, 'hint', 'index.html');
const LAUNCH = Date.UTC(2021, 5, 19);   // Wordle #0

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

/* US Eastern calendar date as YYYY-MM-DD */
function easternDate(now) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);
}

function render(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d));
    const num = Math.round((day - LAUNCH) / 86400000);
    const fmt = opts => day.toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, opts));
    const full = fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });   // matches the page script
    const short = fmt({ weekday: 'short', month: 'short', day: 'numeric' });

    const title = `Wordle Hint Today #${num} (${short}) – Spoiler-Free Clues`;
    const desc = `Spoiler-free hints for Wordle #${num} (${full}). Reveal clues one at a time — vowels, first letter, last letter — and only see the answer if you choose to.`;
    const ld = {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: `Wordle Hint Today #${num} (${full})`,
        url: 'https://wordlelist.com/hint/',
        description: `Spoiler-free hints for Wordle #${num}, revealed one clue at a time.`,
        dateModified: dateStr,
        isPartOf: { '@type': 'WebSite', name: 'Past Wordle Answers', url: 'https://wordlelist.com/' }
    };
    const json = JSON.stringify(ld, null, 4).split('\n').map(l => '    ' + l).join('\n');

    return {
        num,
        head: `
    <title>${title}</title>
    <meta name="description" content="${desc}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${desc}">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${desc}">
    <script type="application/ld+json">
${json}
    </script>
    `,
        subtitle: `Wordle <span>#${num.toLocaleString('en-US')}</span> · ${full}`
    };
}

function splice(html, start, end, content) {
    const i = html.indexOf(start), j = html.indexOf(end);
    if (i === -1 || j === -1 || j < i) throw new Error(`markers ${start} … ${end} not found in hint/index.html`);
    return html.slice(0, i + start.length) + content + html.slice(j);
}

/* Returns { changed, num, date }. */
function stamp(now = new Date()) {
    const date = easternDate(now);
    const r = render(date);
    const before = fs.readFileSync(DEST, 'utf-8');
    let html = splice(before, '<!-- HINT-STAMP:START -->', '<!-- HINT-STAMP:END -->', r.head);
    html = splice(html, '<!-- HINT-DATE:START -->', '<!-- HINT-DATE:END -->', r.subtitle);
    if (html === before) return { changed: false, num: r.num, date };
    fs.writeFileSync(DEST, html);
    return { changed: true, num: r.num, date };
}

if (require.main === module) {
    const local = process.argv.includes('--local');
    const run = cmd => execSync(cmd, { cwd: REPO_DIR, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    try {
        if (!local) run('git pull --rebase origin main');
        const r = stamp();
        if (!r.changed) { log(`Hint already stamped #${r.num} (${r.date}) — nothing to do`); process.exit(0); }
        log(`Stamped hint page: Wordle #${r.num} (${r.date})`);
        if (!local) {
            run('git add hint/index.html');
            run(`git commit -m "Hint stamp: Wordle #${r.num} (${r.date})"`);
            run('git push origin main');
            log('Pushed ✓');
        }
    } catch (e) {
        log(`FATAL: ${e.message}`);
        process.exit(1);
    }
}

module.exports = { stamp };
