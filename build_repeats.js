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

const DAY_MS = 86400000;

/* ── parse answers.txt → [{ word, num, suffix, date }] oldest-first ── */
function readHistory() {
    const entries = [];
    for (const raw of fs.readFileSync(SRC, 'utf-8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 3) continue;

        const word = parts[0].toUpperCase();
        if (!/^[A-Z]{5}$/.test(word)) continue;

        const num = parseInt(parts[1].replace(/[^\d]/g, ''), 10);
        if (isNaN(num)) continue;

        const m = parts[2].replace(/[^\d/]/g, '').match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
        if (!m) continue;
        const date = new Date(Date.UTC(2000 + parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10)));

        entries.push({ word, num, suffix: parts[1].replace(/\d/g, ''), date });
    }
    // a/b suffixes are the days NYT swapped the answer mid-day; keep them in order
    return entries.sort((a, b) => a.num - b.num || a.suffix.localeCompare(b.suffix));
}

/* ── formatting ── */
const n = x => x.toLocaleString('en-US');
const fmt = (d, opts) => d.toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, opts));
const longDate  = d => fmt(d, { month: 'long', day: 'numeric', year: 'numeric' });
const shortDate = d => fmt(d, { month: 'short', day: 'numeric', year: 'numeric' });
const monthName = d => fmt(d, { month: 'long', year: 'numeric' });
const years = days => (days / 365.25).toFixed(1);
const words = list => list.length < 2 ? list.join('')
    : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];

/* "1 in 9" — puzzles per repeat, rounded */
const oneIn = (puzzles, repeats) => '1 in ' + Math.round(puzzles / repeats);

function analyse(history) {
    const seen = {};       // WORD -> earlier entries
    const repeats = [];
    for (const e of history) {
        if (seen[e.word]) {
            const earlier = seen[e.word];
            const last = earlier[earlier.length - 1];
            repeats.push(Object.assign({}, e, {
                first: earlier[0],
                times: earlier.length + 1,
                gapDays: Math.round((e.date - last.date) / DAY_MS)
            }));
        }
        (seen[e.word] = seen[e.word] || []).push(e);
    }
    return { repeats, latest: history[history.length - 1] };
}

/* ── the FAQ, shared by the visible <details> and the JSON-LD ── */
function faq(s) {
    const q = [];
    if (!s.first) {
        q.push(['Does Wordle repeat answers?',
            `Not so far. In ${n(s.total)} puzzles, no Wordle answer has been used twice.`]);
        return q;
    }
    q.push(['Does Wordle repeat answers?',
        `Yes, since ${longDate(s.first.date)}. For its first ${n(s.beforeCount)} puzzles Wordle never reused an answer. ` +
        `Since then the New York Times has reused ${n(s.count)} past answers.`]);
    q.push(['How often does Wordle repeat words?',
        `About ${s.ratio} puzzles since repeats began: ${n(s.count)} of the ${n(s.since)} puzzles from ` +
        `${longDate(s.first.date)} to ${longDate(s.latest.date)} reused a past answer.`]);
    q.push(["Has today's Wordle been used before?",
        "The banner at the top of wordlelist.com/repeats/ tells you without revealing the word. It checks today's answer " +
        'against every past Wordle answer and switches to the new puzzle at midnight in your timezone.']);
    q.push(['Has a Wordle word ever been used three times?',
        s.maxTimes > 2
            ? `Yes. The most any word has appeared is ${s.maxTimes} times.`
            : 'Not yet. Every repeat so far has been the second time that word was the answer.']);
    q.push(['Which Wordle answers have been repeated?',
        `${n(s.count)} so far, newest first: ${words(s.newestFirst.map(r => r.word))}.`]);
    return q;
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

function renderBody(s, questions) {
    const I = '        ';   // body indent inside .container
    const out = [];

    if (!s.first) {
        out.push(`${I}<section>`, `${I}    <h2>No Repeats Yet</h2>`,
            `${I}    <p>In ${n(s.total)} puzzles, no Wordle answer has been used twice.</p>`, `${I}</section>`);
    } else {
        const firstIsZero = s.first.first.num === 0;
        out.push(
            `${I}<div class="stat-grid">`,
            `${I}    <div class="stat-card"><b>${n(s.count)}</b><span>answers reused since ${shortDate(s.first.date)}</span></div>`,
            `${I}    <div class="stat-card yellow"><b>${s.ratio}</b><span>puzzles has been a repeat since then</span></div>`,
            `${I}    <div class="stat-card"><b>0</b><span>repeats in the first ${n(s.beforeCount)} puzzles</span></div>`,
            `${I}    <div class="stat-card yellow"><b>${n(s.byYear[0][1])} of ${n(s.count)}</b><span>repeats were first played in ${s.byYear[0][0]}</span></div>`,
            `${I}</div>`,
            '',
            `${I}<section>`,
            `${I}    <h2>When Wordle Started Repeating</h2>`,
            `${I}    <p>For its first <strong>${n(s.beforeCount)} puzzles</strong>, from ${longDate(s.start.date)} to ${longDate(new Date(s.first.date - DAY_MS))}, ` +
                `Wordle never used the same answer twice. That changed on <strong>${longDate(s.first.date)}</strong>, when Wordle #${n(s.first.num)} ` +
                `brought back <span class="word-inline">${s.first.word}</span>` +
                (firstIsZero ? `: the very first Wordle answer, from ${longDate(s.first.first.date)}.` : `, first played on ${longDate(s.first.first.date)}.`) + `</p>`,
            `${I}    <p>Since then, <strong>${n(s.count)} of ${n(s.since)} puzzles (${s.pct}%)</strong> have reused a past answer, about ${s.ratio}. ` +
                (s.maxTimes > 2 ? `The most any word has appeared is ${s.maxTimes} times.` : 'No word has been the answer three times yet.') + `</p>`,
            `${I}</section>`,
            '',
            `${I}<section>`,
            `${I}    <h2>Repeats Month by Month</h2>`,
            `${I}    <div class="table-wrap">`,
            `${I}        <table>`,
            `${I}            <thead>`,
            `${I}                <tr><th>Month</th><th>Puzzles</th><th>Repeats</th><th>Share</th></tr>`,
            `${I}            </thead>`,
            `${I}            <tbody>`,
            ...s.months.map(m =>
            `${I}                <tr><td>${m.label}${m.partial ? ' <span class="muted">(so far)</span>' : ''}</td><td class="num">${m.puzzles}</td>` +
                `<td class="num">${m.repeats ? '<strong>' + m.repeats + '</strong>' : '0'}</td><td class="num">${Math.round(100 * m.repeats / m.puzzles)}%</td></tr>`),
            `${I}            </tbody>`,
            `${I}        </table>`,
            `${I}    </div>`,
            `${I}</section>`,
            '',
            `${I}<section>`,
            `${I}    <h2>Which Old Answers Come Back?</h2>`,
            `${I}    <p>Wordle is mostly recycling its oldest answers. <strong>${n(s.byYear[0][1])} of the ${n(s.count)} repeats</strong> were first played in ${s.byYear[0][0]}` +
                (s.byYear[0][0] === 2021 ? ', the game\'s first year' : '') + `. By the year each word was first the answer:</p>`,
            `${I}    <div class="letter-strip">`,
            ...s.byYear.map(([y, c]) =>
            `${I}        <div class="letter-chip"><b>${y}</b><span>${c} ${c === 1 ? 'repeat' : 'repeats'}</span></div>`),
            `${I}    </div>`,
            `${I}    <p>On average a repeated word comes back after <strong>${years(s.avgGap)} years</strong>. The quickest comeback took ${years(s.shortest.gapDays)} years ` +
                `(<span class="word-inline">${s.shortest.word}</span>, #${n(s.shortest.first.num)} → #${n(s.shortest.num)}); the longest took ${years(s.longest.gapDays)} years ` +
                `(<span class="word-inline">${s.longest.word}</span>, #${n(s.longest.first.num)} → #${n(s.longest.num)}).</p>`,
            `${I}</section>`,
            '',
            `${I}<section>`,
            `${I}    <h2>Every Repeated Wordle Answer</h2>`,
            `${I}    <div class="table-wrap">`,
            `${I}        <table>`,
            `${I}            <thead>`,
            `${I}                <tr><th>Word</th><th>Repeated</th><th>First played</th><th>Gap</th></tr>`,
            `${I}            </thead>`,
            `${I}            <tbody>`,
            ...s.newestFirst.map(r =>
            `${I}                <tr><td class="word-cell">${r.word}</td>` +
                `<td>${shortDate(r.date)}<span class="sub">#${n(r.num)}</span></td>` +
                `<td>${shortDate(r.first.date)}<span class="sub">#${n(r.first.num)}</span></td>` +
                `<td class="num">${years(r.gapDays)} yrs</td></tr>`),
            `${I}            </tbody>`,
            `${I}        </table>`,
            `${I}    </div>`,
            `${I}    <p class="table-note">Updated daily through Wordle #${n(s.latest.num)} (${longDate(s.latest.date)}). Today's answer is added once its puzzle has ended in every timezone.</p>`,
            `${I}</section>`
        );
    }

    out.push(
        '',
        `${I}<section>`,
        `${I}    <h2>Check Any Word</h2>`,
        `${I}    <p>Wondering about a particular word? Search the <a href="/">complete list of past Wordle answers</a>. Hover over or tap any word there to see every date it was played. ` +
            `Still stuck on today's puzzle? Try the <a href="/hint/">spoiler-free hints</a> or the <a href="/solver/">Wordle helper</a>.</p>`,
        `${I}</section>`,
        '',
        `${I}<section class="seo-content">`,
        `${I}    <h2>Frequently Asked Questions</h2>`,
        ...questions.flatMap(([qq, a]) => [
        `${I}    <details>`,
        `${I}        <summary>${qq}</summary>`,
        `${I}        <p>${a.replace('wordlelist.com/repeats/', 'this page')}</p>`,
        `${I}    </details>`]),
        `${I}</section>`
    );
    return '\n' + out.join('\n') + '\n        ';
}

function stats(history) {
    const { repeats, latest } = analyse(history);
    const s = { total: new Set(history.map(e => e.num)).size, start: history[0], latest, count: repeats.length };
    if (!repeats.length) return s;

    s.first = repeats[0];
    s.beforeCount = new Set(history.filter(e => e.num < s.first.num).map(e => e.num)).size;
    s.since = new Set(history.filter(e => e.num >= s.first.num).map(e => e.num)).size;
    s.pct = (100 * s.count / s.since).toFixed(1);
    s.ratio = oneIn(s.since, s.count);
    s.maxTimes = Math.max(...repeats.map(r => r.times));
    s.newestFirst = repeats.slice().reverse();
    s.avgGap = repeats.reduce((t, r) => t + r.gapDays, 0) / repeats.length;
    s.shortest = repeats.reduce((a, b) => b.gapDays < a.gapDays ? b : a);
    s.longest  = repeats.reduce((a, b) => b.gapDays > a.gapDays ? b : a);

    const years = {};
    repeats.forEach(r => { const y = r.first.date.getUTCFullYear(); years[y] = (years[y] || 0) + 1; });
    s.byYear = Object.entries(years).map(([y, c]) => [+y, c]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);

    // months from the first repeat through the latest history entry
    const months = [];
    const key = d => d.getUTCFullYear() * 12 + d.getUTCMonth();
    for (let k = key(s.first.date); k <= key(latest.date); k++) {
        const inMonth = e => key(e.date) === k;
        const d = new Date(Date.UTC(Math.floor(k / 12), k % 12, 1));
        const last = new Date(Date.UTC(Math.floor(k / 12), k % 12 + 1, 0));
        months.push({
            label: fmt(d, { month: 'short', year: 'numeric' }),
            puzzles: new Set(history.filter(inMonth).map(e => e.num)).size,
            repeats: repeats.filter(inMonth).length,
            partial: latest.date < last
        });
    }
    s.months = months.reverse();   // newest first, like the repeat list
    return s;
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
