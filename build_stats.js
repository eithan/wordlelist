#!/usr/bin/env node
/*
 * build_stats.js
 * --------------
 * Recomputes every number on /stats/, /best-starting-words/ and /how-to-win/
 * from the current list of past answers (words.txt + safe.txt, the same list
 * the homepage shows) and writes them into the pages.
 *
 * Each computed value sits between inline markers, <!--v:key-->…<!--/v-->,
 * which can hold plain text or generated HTML (table rows, chips, a whole
 * JSON-LD <script>). Counts in each page's <head> descriptions are refreshed
 * by pattern, and each page's FAQ JSON-LD (between FAQ-LD markers) is rebuilt
 * from its visible FAQ so the two always match. The homepage's "E appears in
 * N%" line is refreshed by pattern too.
 *
 * Some sentences name a winner ("STARE lands the most greens…", "J is the
 * rarest letter"). Those are checked on every run, and anything that stops
 * being true is returned as a warning (the daily job logs it) so the copy can
 * be updated by hand.
 *
 * Local data only, never the network. The daily cron (update_wordle.js) calls
 * this after the homepage word list is injected.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_DIR = __dirname;
const PAGES = ['stats/index.html', 'best-starting-words/index.html', 'how-to-win/index.html'];

/* Starters are ranked from every past answer plus these well-known openers
   that have never been answers. This is the set the original rankings used. */
const OPENERS = ['ROATE', 'ORATE', 'SOARE', 'AROSE', 'TEARS', 'RATES', 'ADIEU', 'SANER', 'SALET'];
const PAIR = ['LATER', 'SONIC'];   // the two-word opening the copy recommends

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const VOWELS = 'AEIOU';

/* ── data ── */
function readAnswers() {
    const read = f => fs.existsSync(path.join(REPO_DIR, f))
        ? fs.readFileSync(path.join(REPO_DIR, f), 'utf-8').split('\n') : [];
    const words = read('words.txt').concat(read('safe.txt'))
        .map(w => w.trim().toUpperCase()).filter(w => /^[A-Z]{5}$/.test(w));
    return [...new Set(words)].sort();
}

/* ── formatting ── */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const word = n => NUMBER_WORDS[n] || n.toLocaleString('en-US');
const Word = n => { const w = word(n); return typeof w === 'string' ? w[0].toUpperCase() + w.slice(1) : w; };
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const and = list => list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
const inline = list => `<span class="word-inline">${list.join(', ')}</span>`;
/* "A, B and C" with every word styled, matching the hand-written copy */
const inlineAnd = list => list.length < 2 ? inline(list)
    : `${inline(list.slice(0, -1))} and ${inline(list.slice(-1))}`;

/* ── scoring ── */
const mask = w => { let m = 0; for (const c of w) m |= 1 << (c.charCodeAt(0) - 65); return m; };
const popcount = m => { let c = 0; while (m) { m &= m - 1; c++; } return c; };

function rankStarters(A) {
    const masks = A.map(mask);
    const n = A.length;
    const scored = [...new Set(A.concat(OPENERS))].map(w => {
        const m = mask(w);
        let hit = 0, greens = 0, two = 0;
        for (let i = 0; i < n; i++) {
            const h = popcount(m & masks[i]);
            hit += h;
            if (h >= 2) two++;
            for (let p = 0; p < 5; p++) if (A[i][p] === w[p]) greens++;
        }
        return { w, hit: hit / n, greens: greens / n, two: two / n };
    });
    // average letters hit, greens as the tiebreak
    scored.sort((a, b) => b.hit - a.hit || b.greens - a.greens);
    scored.forEach((s, i) => { s.rank = i + 1; });
    return scored;
}

/* coverage of a two-word opening: average letters hit, share hitting 1+ and 3+ */
function pairCoverage(A, a, b) {
    const m = mask(a) | mask(b);
    let hit = 0, one = 0, three = 0;
    for (const w of A) { const h = popcount(m & mask(w)); hit += h; if (h >= 1) one++; if (h >= 3) three++; }
    return { hit: hit / A.length, one: one / A.length, three: three / A.length };
}

/* best average coverage over every pair of candidates with ten distinct letters */
function bestPairHit(A, candidates) {
    const words = candidates.filter(w => new Set(w).size === 5);
    const masks = words.map(mask);
    const answerMasks = A.map(mask);
    const seen = new Set();
    let best = 0;
    for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j < words.length; j++) {
            if (masks[i] & masks[j]) continue;
            const m = masks[i] | masks[j];
            if (seen.has(m)) continue;   // same ten letters, same coverage
            seen.add(m);
            let hit = 0;
            for (const am of answerMasks) hit += popcount(m & am);
            if (hit > best) best = hit;
        }
    }
    return best / A.length;
}

function compute(A, repeats) {
    const n = A.length;
    const pct = (k, d = 0) => (100 * k / n).toFixed(d) + '%';
    const v = {};
    const warn = [];
    const check = (ok, msg) => { if (!ok) warn.push(msg); };

    v.count = n.toLocaleString('en-US');
    v.through = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    /* letters */
    const has = Object.fromEntries(LETTERS.map(c => [c, A.filter(a => a.includes(c)).length]));
    const byHas = LETTERS.slice().sort((a, b) => has[b] - has[a]);
    v.e_pct = pct(has.E); v.a_pct = pct(has.A); v.r_pct = pct(has.R);
    check(byHas.slice(0, 3).join('') === 'EAR', `most common letters are now ${byHas.slice(0, 3).join(', ')} (copy says E, A, R)`);

    const rare = byHas.slice(-5).reverse();   // rarest first
    v.rare_chips = rare.map((c, i) =>
        `\n                <div class="letter-chip yellow"><b>${c}</b><span>${has[c]} words · ${pct(has[c], 1)}</span></div>`).join('') + '\n            ';
    v.rare4 = and(rare.slice(0, 4).map(c => `${c} (${pct(has[c], 1)})`));
    v.j_n = String(has.J);
    check(rare[0] === 'J', `rarest letter is now ${rare[0]} (copy says J)`);
    check(!A.some(a => /Q(?!U)/.test(a)), 'an answer has a Q not followed by U (copy says the QU rule has never been broken)');
    v.jqzx_pct = pct(A.filter(a => /[JQZX]/.test(a)).length);

    v.top_letter_chips = byHas.slice(0, 10).map(c =>
        `\n        <div class="letter-chip"><b>${c}</b><span>${pct(has[c])}</span></div>`).join('') + '\n    ';

    /* positions */
    const cols = [0, 1, 2, 3, 4].map(p => {
        const cnt = {};
        A.forEach(a => { cnt[a[p]] = (cnt[a[p]] || 0) + 1; });
        return Object.entries(cnt).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    });
    const colRank = (p, c) => cols[p].findIndex(([l]) => l === c) + 1;
    const colPct = (p, c, d = 1) => pct((cols[p].find(([l]) => l === c) || [c, 0])[1], d);
    v.position_rows = cols.map((col, p) => `\n                <tr><td class="rank">${ord(p + 1)} letter</td>` +
        col.slice(0, 3).map(([c, k], i) => `<td class="num">${i === 0 ? `<strong>${c}</strong>` : c} ${pct(k)}</td>`).join('') + '</tr>').join('') + '\n            ';

    v.s_start = colPct(0, 'S'); v.c_start = colPct(0, 'C'); v.b_start = colPct(0, 'B');
    v.s_start0 = colPct(0, 'S', 0);
    check(cols[0].slice(0, 3).map(x => x[0]).join('') === 'SCB', `top first letters are now ${cols[0].slice(0, 3).map(x => x[0]).join(', ')} (copy says S, C, B)`);
    check(!cols[0].some(([c]) => c === 'X'), 'an answer now starts with X (copy says none has)');
    const zStart = A.filter(a => a[0] === 'Z');
    v.z_start_n = word(zStart.length);
    v.z_start_list = inline(zStart);
    v.e_end = colPct(4, 'E'); v.y_end = colPct(4, 'Y'); v.t_end = colPct(4, 'T'); v.r_end = colPct(4, 'R');
    v.y_end0 = colPct(4, 'Y', 0);
    v.e_end_one_in = '1 in ' + Math.round(n / (cols[4].find(([c]) => c === 'E') || [0, 1])[1]);
    check(cols[4].slice(0, 4).map(x => x[0]).join('') === 'EYTR', `top last letters are now ${cols[4].slice(0, 4).map(x => x[0]).join(', ')} (copy says E, Y, T, R)`);
    check(colRank(0, 'S') === 1 && colRank(2, 'A') === 1 && colRank(4, 'E') === 1, 'S-1, A-3 and E-5 are no longer all top slots (copy explains SOARE\'s greens that way)');
    v.s_end = colPct(4, 'S');

    /* SANER vs STARE, slot by slot, in the all-answers table */
    const slots = w => and(w.split('').map((c, p) => `${ord(colRank(p, c))}`));
    v.saner_slots = slots('SANER');
    v.stare_slots = slots('STARE');

    /* repeated letters */
    const rep = A.filter(a => new Set(a).size < 5);
    v.rep_n = rep.length.toLocaleString('en-US');
    v.rep_pct = pct(rep.length); v.rep_pct1 = pct(rep.length, 1);
    const adj = A.filter(a => /(.)\1/.test(a));
    v.adj_n = String(adj.length);
    const dbl = {};
    adj.forEach(a => new Set(a.match(/(.)\1/g)).forEach(d => { dbl[d] = (dbl[d] || 0) + 1; }));
    const doubles = Object.entries(dbl).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    v.double_chips = doubles.slice(0, 6).map(([d, k]) =>
        `\n                <div class="letter-chip"><b>${d}</b><span>${k} words</span></div>`).join('') + '\n            ';
    check(doubles.slice(0, 3).map(x => x[0]).join(' ') === 'LL OO EE', `most common doubles are now ${doubles.slice(0, 3).map(x => x[0]).join(', ')} (copy says LL, OO, EE)`);
    const triples = A.filter(a => LETTERS.some(c => a.split(c).length > 3));
    v.tri_n = String(triples.length);
    v.tri_list = inlineAnd(triples);

    /* vowels */
    const vowelCount = a => a.split('').filter(c => VOWELS.includes(c)).length;
    const byVowels = [0, 1, 2, 3, 4, 5].map(k => A.filter(a => vowelCount(a) === k));
    const top = byVowels.reduce((b, l, k) => l.length > byVowels[b].length ? k : b, 0);
    v.vowel_rows = byVowels.map((l, k) => ({ l, k })).filter(({ l, k }) => k < 5 || l.length).map(({ l, k }) => {
        const cell = s => k === top ? `<strong>${s}</strong>` : s;
        return `\n                        <tr><td class="num">${k} vowel${k === 1 ? '' : 's'}</td><td class="num">${cell(l.length.toLocaleString('en-US'))}</td><td class="num">${cell(pct(l.length, 1))}</td></tr>`;
    }).join('') + '\n                    ';
    check(top === 2, `the most common vowel count is now ${top} (copy says two)`);
    v.novowel_n = String(byVowels[0].length);
    v.novowel_word = word(byVowels[0].length);
    v.novowel_Word = Word(byVowels[0].length);
    v.novowel_list = inline(byVowels[0]);
    v.novowel_plain = and(byVowels[0]);
    v.four_word = word(byVowels[4].length);
    v.four_list = inline(byVowels[4]);

    /* word families */
    const fam = suf => A.filter(a => a.endsWith(suf));
    const atch = fam('ATCH');
    v.atch_word = word(atch.length);
    v.atch_list = and(atch);
    const others = ['IGHT', 'OUND', 'OWER'].map(s => [s, fam(s).length]);
    const biggest = Math.max(atch.length, ...others.map(o => o[1]));
    check(atch.length === biggest, `-ATCH is no longer the biggest word family (copy leads with it)`);
    // "Seven answers share the -ATCH pattern (…), seven share -OUND, and six each share -IGHT and -OWER"
    const groups = [];
    others.slice().sort((a, b) => b[1] - a[1]).forEach(([s, k]) => {
        const g = groups.find(g => g.k === k);
        if (g) g.s.push(s); else groups.push({ k, s: [s] });
    });
    v.families = `${Word(atch.length)} answers share the <strong>-ATCH</strong> pattern (<span class="word-inline">${atch.join(', ')}</span>), ` +
        and(groups.map(g => `${word(g.k)}${g.s.length > 1 ? ' each' : ''} share ${and(g.s.map(s => `<strong>-${s}</strong>`))}`));

    /* letter order */
    const sorted = a => a.split('').sort().join('');
    v.alpha_n = String(A.filter(a => a === sorted(a)).length);
    const reverse = A.filter(a => a === sorted(a).split('').reverse().join(''));
    v.reverse = reverse.length
        ? `And ${word(reverse.length)} run in <strong>reverse</strong> alphabetical order, like ${and(['WRONG', 'SPOON', 'TROLL'].filter(w => reverse.includes(w)).concat(reverse.filter(w => !['WRONG', 'SPOON', 'TROLL'].includes(w))).slice(0, 3).map(w => inline([w])))}.`
        : 'None has ever been in reverse alphabetical order… yet.';

    /* starters */
    const ranked = rankStarters(A);
    const s = w => ranked.find(r => r.w === w);
    const answers = new Set(A);
    const f2 = x => x.toFixed(2);
    v.top12_rows = ranked.slice(0, 12).map(r => `\n                <tr><td class="rank">${r.rank}</td><td class="word-cell">${r.w}` +
        `${answers.has(r.w) ? '' : ' <span class="dagger">†</span>'}</td><td class="num"><strong>${f2(r.hit)}</strong></td>` +
        `<td class="num">${f2(r.greens)}</td><td class="num">${Math.round(100 * r.two)}%</td></tr>`).join('') + '\n            ';
    v.top10_ld = `<script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": "Best Wordle Starting Words",
        "description": "Starting words ranked by average letters hit across all real Wordle answers.",
        "itemListElement": [
${ranked.slice(0, 10).map(r => `            { "@type": "ListItem", "position": ${r.rank}, "name": "${r.w}" }`).join(',\n')}
        ]
    }
    </script>`;
    for (const w of ['STARE', 'SLATE', 'CRANE', 'ADIEU', 'AUDIO', 'SOARE']) {
        const k = w.toLowerCase();
        v[`${k}_rank`] = '#' + s(w).rank;
        v[`${k}_hit`] = f2(s(w).hit);
        v[`${k}_greens`] = f2(s(w).greens);
    }
    const tierAnswers = ranked.slice(0, 12).filter(r => answers.has(r.w));
    const greenest = tierAnswers.reduce((a, b) => b.greens > a.greens ? b : a, tierAnswers[0]);
    check(greenest && greenest.w === 'STARE', `${greenest ? greenest.w : 'no word'} now lands more greens than STARE among top-12 starters that have been answers (copy picks STARE for that)`);
    check(['LATER', 'ALERT', 'IRATE'].every(w => s(w).rank < s('STARE').rank), 'LATER, ALERT and IRATE no longer all outrank STARE (how-to-win says they edge it)');
    check(s('ADIEU').rank > 100, 'ADIEU now ranks in the top 100 (copy calls it a myth)');

    const pair = pairCoverage(A, ...PAIR);
    v.pair_hit = f2(pair.hit);
    v.pair_one = (100 * pair.one).toFixed(1) + '%';
    v.pair_three = Math.round(100 * pair.three) + '%';
    const best = bestPairHit(A, ranked.map(r => r.w));
    check(best - pair.hit < 0.01, `a two-word opening now covers ${f2(best)} letters vs ${f2(pair.hit)} for ${PAIR.join(' → ')} (copy calls it the strongest)`);

    /* repeats, from the answer history */
    if (repeats && repeats.first) {
        v.rp_ratio = repeats.ratio;
        v.rp_since = repeats.first.date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    }
    return { v, warn };
}

/* ── page writing ── */
function fillValues(html, v, file) {
    return html.replace(/<!--v:([a-z0-9_]+)-->[\s\S]*?<!--\/v-->/gi, (m, k) => {
        if (!(k in v)) throw new Error(`${file}: no value for <!--v:${k}-->`);
        return `<!--v:${k}-->${v[k]}<!--/v-->`;
    });
}

const text = html => html
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ').trim();

/* FAQPage JSON-LD rebuilt from the visible FAQ */
function fillFaqLd(html, file) {
    const start = '<!-- FAQ-LD:START -->', end = '<!-- FAQ-LD:END -->';
    const i = html.indexOf(start), j = html.indexOf(end);
    if (i === -1 || j === -1) throw new Error(`${file}: FAQ-LD markers not found`);
    const section = html.slice(html.indexOf('<section class="seo-content">'));
    const items = [...section.matchAll(/<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>/g)]
        .map(([, q, a]) => ({ '@type': 'Question', name: text(q), acceptedAnswer: { '@type': 'Answer', text: text(a) } }));
    if (!items.length) throw new Error(`${file}: no visible FAQ found`);
    const json = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items }, null, 4)
        .split('\n').map(l => '    ' + l).join('\n');
    return html.slice(0, i + start.length) + `\n    <script type="application/ld+json">\n${json}\n    </script>\n    ` + html.slice(j);
}

/* "all 1,826 real" in <head> descriptions */
function fillHeadCounts(html, v) {
    const k = html.indexOf('</head>');
    return html.slice(0, k).replace(/all [\d,]+ real/g, `all ${v.count} real`) + html.slice(k);
}

function build() {
    const A = readAnswers();
    let repeats = null;
    try {
        const r = require('./build_repeats.js');
        repeats = r.stats(r.readHistory());
    } catch (_) { /* repeat figures are optional; pages using them will throw below */ }

    const { v, warn } = compute(A, repeats);
    const changed = [];
    for (const file of PAGES) {
        const p = path.join(REPO_DIR, file);
        const before = fs.readFileSync(p, 'utf-8');
        const html = fillFaqLd(fillHeadCounts(fillValues(before, v, file), v), file);
        if (html !== before) { fs.writeFileSync(p, html); changed.push(file); }
    }

    // homepage FAQ: "E, which appears in 47% of all …" (visible + JSON-LD)
    const home = path.join(REPO_DIR, 'index.html');
    const before = fs.readFileSync(home, 'utf-8');
    const html = before.replace(/E, which appears in \d+% of all/g, `E, which appears in ${v.e_pct} of all`);
    if (html !== before) { fs.writeFileSync(home, html); changed.push('index.html'); }

    return { answers: A.length, changed, warnings: warn };
}

if (require.main === module) {
    const r = build();
    console.log(`Stats pages computed from ${r.answers} answers; changed: ${r.changed.join(', ') || 'nothing'}`);
    r.warnings.forEach(w => console.log(`⚠️  ${w}`));
}

module.exports = { build };
