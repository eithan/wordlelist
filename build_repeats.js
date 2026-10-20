#!/usr/bin/env node
/*
 * build_repeats.js
 * ----------------
 * Reads answers.txt (canonical answer history) and rewrites the data-driven
 * parts of repeats/index.html: the meta descriptions and FAQ JSON-LD between
 * the REPEATS-HEAD markers, and the stats, tables and FAQ between the REPEATS
 * markers. Everything else on the page (styles, header, the client-side
 * "is today a repeat?" banner) is hand-written and left alone.
 *
 * A repeat is any history entry whose word already appeared at a lower puzzle
 * number. That's computed from the history itself rather than the trailing @
 * marker, which the daily job doesn't write. answers.txt trails the live
 * puzzle by a day, so nothing here can spoil today's answer.
 *
 * Local data only, never the network. The daily cron (update_wordle.js) calls
 * this right after appending to answers.txt.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_DIR = __dirname;
const SRC  = path.join(REPO_DIR, 'answers.txt');
const DEST = path.join(REPO_DIR, 'repeats', 'index.html');

// repeat logic + body rendering, shared with the page's client-side script
const { parseHistory, stats, faq, renderBody, n, monthName } = require('./repeats/repeats-core.js');

/* ── parse answers.txt → [{ word, num, suffix, date }] oldest-first ── */
function readHistory() {
    return parseHistory(fs.readFileSync(SRC, 'utf-8'));
}

function renderHead(s, questions) {
    const desc = s.first
        ? `Every Wordle answer the New York Times has reused: ${n(s.count)} repeats since ${monthName(s.first.date)}, ` +
          `about ${s.ratio} puzzles. Full list with dates, plus a spoiler-free check on whether today's word is a repeat.`
        : 'Every Wordle answer that has been used more than once, with dates, plus a spoiler-free check on whether today\'s word is a repeat.';
    const ld = {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: questions.map(([name, text]) => ({
            '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text }
        }))
    };
    const json = JSON.stringify(ld, null, 4).split('\n').map(l => '    ' + l).join('\n');
    return `
    <meta name="description" content="${desc}">
    <meta property="og:description" content="${desc}">
    <meta name="twitter:description" content="${desc}">
    <script type="application/ld+json">
${json}
    </script>
    `;
}

function splice(html, start, end, content) {
    const i = html.indexOf(start), j = html.indexOf(end);
    if (i === -1 || j === -1 || j < i) throw new Error(`markers ${start} … ${end} not found in repeats/index.html`);
    return html.slice(0, i + start.length) + content + html.slice(j);
}

function build() {
    const s = stats(readHistory());
    const questions = faq(s);
    let html = fs.readFileSync(DEST, 'utf-8');
    html = splice(html, '<!-- REPEATS-HEAD:START -->', '<!-- REPEATS-HEAD:END -->', renderHead(s, questions));
    html = splice(html, '<!-- REPEATS:START -->', '<!-- REPEATS:END -->', renderBody(s, questions));
    fs.writeFileSync(DEST, html);
    return { repeats: s.count, through: s.latest.num };
}

if (require.main === module) {
    const r = build();
    console.log(`Wrote repeats/index.html: ${r.repeats} repeats, history through #${r.through}`);
}

module.exports = { build, readHistory, stats };
