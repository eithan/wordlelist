#!/usr/bin/env node
/*  build_solver_words.js — regenerate solver-words.txt
 *
 *  The solver used to suggest whichever possible word was most common in
 *  English. That put JESUS, PENIS and WIVES above MESSY and RINSE: common
 *  words, but NYT never uses plurals or crude words as answers.
 *
 *  So we sort by ANSWER LIKELIHOOD instead of raw popularity. The likelihood
 *  is learned from our own answer history (words.txt) by logistic regression
 *  over four signals:
 *
 *      ln(popularity rank)  common words are far likelier to be answers
 *      plural-looking S     ends in S but not SS/US: ~0% become answers
 *      ends in ED           past tense, nearly as rare as plurals
 *      ends in A, I or O    names, places, brands and slang (MARIA, INDIA,
 *                           HONDA, GONNA): answers at well under half the rate their
 *                           popularity predicts. Ordinary words with these
 *                           endings (PIANO, COBRA, MOCHA) slip a little but
 *                           stay well inside the visible list.
 *
 *  There is deliberately no proper-noun signal. The only one available was the
 *  system dictionary's capitalization, which demoted BIBLE and GREEK ("Bible",
 *  "Greek") while leaving BILLY and MOLLY alone (it also lists "billy" the
 *  club) — measuring old dictionary conventions, not what NYT would pick.
 *  The ending rule above catches most of the same names from the data instead.
 *  Names that really shouldn't surface go in BLOCK below.
 *
 *  Inputs
 *      solver-words-freq.txt   the word list in POPULARITY order — the source
 *                              of truth for the rank signal. Never overwritten,
 *                              so rebuilds stay idempotent.
 *      words.txt               past answers = the training labels.
 *
 *  Output
 *      solver-words.txt        same words, sorted most-likely-answer first,
 *                              behind a "# prior b0 b1" header giving the
 *                              curve that turns a word's POSITION IN THIS FILE
 *                              back into a probability. The solver reads that
 *                              header, so the two never drift apart.
 *
 *  Run it after appending answers if you want the ordering to reflect them,
 *  then bump the ?v= on the solver's fetch so caches pick the new order up.
 *      node build_solver_words.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'solver-words-freq.txt');
const OUT = path.join(ROOT, 'solver-words.txt');

/* Brands, crude words and names NYT wouldn't use as answers, which popularity
   alone would rank high. NYT would
   never use these, so they're demoted hard rather than removed — a word the
   board still allows should never vanish from the possible list. */
const BLOCK = ['JESUS', 'JESSE', 'VENUS', 'PEPSI', 'PENIS', 'PUSSY', 'XEROX', 'HITLER', 'NAZIS', 'SLUTS', 'WHORE', 'DILDO', 'TAMPON']
    .filter(w => w.length === 5);

function readWords(file) {
    return fs.readFileSync(file, 'utf8').split('\n')
        .map(l => l.trim().toUpperCase())
        .filter(l => l.length === 5 && /^[A-Z]{5}$/.test(l));
}

if (!fs.existsSync(SRC)) {
    console.error(`missing ${path.basename(SRC)} — the popularity-ordered source list.\n` +
                  `If this is the first run, seed it from the current list:\n` +
                  `    cp solver-words.txt solver-words-freq.txt`);
    process.exit(1);
}

const words = readWords(SRC);
const rank = new Map(words.map((w, i) => [w, i]));
const answers = new Set(readWords(path.join(ROOT, 'words.txt')));

/* plural-looking = ends in S, but not SS or US. Among the 4,000 most common
   words, -SS endings became answers 64% of the time (CLASS, GUESS) and -US 25%
   (FOCUS, BONUS) — while every other -S ending did so for 1 word in 270.
   -IS and -OS stay flagged on purpose: the few real answers there (BASIS,
   OASIS, CHAOS, ETHOS) are already played, and exempting them mostly promoted
   names (LEWIS, PARIS) and plurals (TACOS, PESOS). */
const endsS = w => /S$/.test(w) && !/(SS|US)$/.test(w);
const endsED = w => w.endsWith('ED');
/* Among the 2,000 most common words, 70% have been answers — but only 42% of
   those ending in A, 49% in O; further down the list -I words almost never
   are (2%). One flag for all three: the split-out coefficients agree in sign
   and the pooled one holds up better out of sample. */
const endsAIO = w => /[AIO]$/.test(w);

const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/* ── logistic regression ──
 *  Batch gradient descent, with the predictors standardized first. That
 *  matters more than it looks: ln(rank) spans 0–9.5 while the form flags are
 *  0/1, and on the raw scale the step size that keeps the big column stable is
 *  far too small for the small ones — the flags stay stuck near their starting
 *  value and the run stops well short of the fit. Coefficients are mapped back to the raw scale on the way out, so
 *  callers never see the scaling.
 *
 *  Stops when the log-likelihood stops improving, so the loop length isn't a
 *  hidden tuning knob. */
function fit(rows, labels, dim, maxIter = 60000, lr = 1, tol = 1e-9) {
    const n = rows.length;
    const mu = new Array(dim).fill(0), sd = new Array(dim).fill(1);
    for (let j = 1; j < dim; j++) {
        let m = 0;
        for (const x of rows) m += x[j];
        m /= n;
        let v = 0;
        for (const x of rows) v += (x[j] - m) * (x[j] - m);
        mu[j] = m;
        sd[j] = Math.sqrt(v / n) || 1;
    }
    const X = rows.map(x => x.map((v, j) => (j ? (v - mu[j]) / sd[j] : 1)));

    const logLik = b => {
        let s = 0;
        for (let i = 0; i < n; i++) {
            let z = 0;
            for (let j = 0; j < dim; j++) z += b[j] * X[i][j];
            const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(z)));
            s += labels[i] * Math.log(p) + (1 - labels[i]) * Math.log(1 - p);
        }
        return s / n;
    };

    const b = new Array(dim).fill(0);
    let prev = -Infinity;
    for (let it = 0; it < maxIter; it++) {
        const g = new Array(dim).fill(0);
        for (let i = 0; i < n; i++) {
            const x = X[i];
            let z = 0;
            for (let j = 0; j < dim; j++) z += b[j] * x[j];
            const e = sigmoid(z) - labels[i];
            for (let j = 0; j < dim; j++) g[j] += e * x[j];
        }
        for (let j = 0; j < dim; j++) b[j] -= lr * g[j] / n;
        if ((it & 255) === 255) {
            const cur = logLik(b);
            if (cur - prev < tol) break;
            prev = cur;
        }
    }

    const out = [b[0], ...new Array(dim - 1).fill(0)];
    for (let j = 1; j < dim; j++) {
        out[j] = b[j] / sd[j];
        out[0] -= b[j] * mu[j] / sd[j];
    }
    return out;
}

const feats = w => [1, Math.log(rank.get(w) + 1), endsS(w) ? 1 : 0, endsED(w) ? 1 : 0, endsAIO(w) ? 1 : 0];
const labels = words.map(w => (answers.has(w) ? 1 : 0));
const beta = fit(words.map(feats), labels, feats('').length);

const blocked = new Set(BLOCK);
const priorOf = w => {
    const x = feats(w);
    let z = 0;
    for (let j = 0; j < beta.length; j++) z += beta[j] * x[j];
    return sigmoid(z) * (blocked.has(w) ? 0.01 : 1);
};

const prior = new Map(words.map(w => [w, priorOf(w)]));
const sorted = words.slice().sort((a, b) =>
    (prior.get(b) - prior.get(a)) || (rank.get(a) - rank.get(b)));

/* ── position → probability ──
 *  The solver only knows a word's line number, so refit the same curve on the
 *  NEW ordering: two numbers it can apply to any position. Because the list is
 *  now sorted by prior, position is monotone in prior and two parameters are
 *  enough to recover it. */
const pos = new Map(sorted.map((w, i) => [w, i]));
const posRows = sorted.map(w => [1, Math.log(pos.get(w) + 1)]);
const posLabels = sorted.map(w => (answers.has(w) ? 1 : 0));
const pb = fit(posRows, posLabels, 2);

let maxErr = 0;
for (const w of sorted) {
    const approx = sigmoid(pb[0] + pb[1] * Math.log(pos.get(w) + 1));
    maxErr = Math.max(maxErr, Math.abs(approx - prior.get(w)));
}

const header = `# prior ${pb[0].toFixed(6)} ${pb[1].toFixed(6)}`;
fs.writeFileSync(OUT, header + '\n' + sorted.join('\n') + '\n');

const fmt = n => n.toFixed(3);
console.log(`fitted P(answer) = sigmoid(${fmt(beta[0])} ${beta[1] < 0 ? '-' : '+'} ` +
            `${fmt(Math.abs(beta[1]))}*ln(rank) ${fmt(beta[2])}*endsS ` +
            `${fmt(beta[3])}*endsED ${fmt(beta[4])}*endsAIO)`);
console.log(`position curve: sigmoid(${fmt(pb[0])} ${fmt(pb[1])}*ln(pos)), ` +
            `max error vs true prior ${maxErr.toFixed(4)}`);
console.log(`wrote ${sorted.length} words to ${path.basename(OUT)}`);
console.log(`top 15: ${sorted.slice(0, 15).join(' ')}`);
