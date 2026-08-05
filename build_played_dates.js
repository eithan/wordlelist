#!/usr/bin/env node
/*
 * build_played_dates.js
 * ---------------------
 * Reads answers.txt (canonical answer history) and writes played-dates.json,
 * a compact map of WORD -> [ [puzzleNum, "M/D/YY"], ... ] used by the
 * lazy-loaded tooltip on index.html. Entries are ordered most-recent-first so
 * the tooltip reads "Played 8/4/26 (#1872) and 8/31/25 (#1534)".
 *
 * This file only reshapes local data — it never hits the network. The daily
 * cron (update_wordle.js) appends one line to answers.txt then calls this to
 * regenerate the JSON.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_DIR = __dirname;
const SRC  = path.join(REPO_DIR, 'answers.txt');
const DEST = path.join(REPO_DIR, 'played-dates.json');

/* MM/DD/YY -> { key: 20YYMMDD number for sorting, disp: "M/D/YY" } */
function parseDate(mmddyy) {
    const m = mmddyy.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
    if (!m) return null;
    const mm = parseInt(m[1], 10);
    const dd = parseInt(m[2], 10);
    const yy = parseInt(m[3], 10);
    return { key: (2000 + yy) * 10000 + mm * 100 + dd, disp: mm + '/' + dd + '/' + m[3] };
}

function build() {
    const lines = fs.readFileSync(SRC, 'utf-8').split('\n');
    const map = {};   // WORD -> array of { key, disp }

    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split(/\s+/);
        if (parts.length < 3) continue;

        const word = parts[0].toUpperCase();
        if (!/^[A-Z]{5}$/.test(word)) continue;

        const num = parseInt(parts[1].replace(/[^\d]/g, ''), 10);   // strip a/b suffix
        if (isNaN(num)) continue;

        const date = parseDate(parts[2].replace(/[^\d/]/g, ''));
        if (!date) continue;

        if (!map[word]) map[word] = [];
        // guard against duplicate lines for the same word+date
        if (!map[word].some(d => d.key === date.key)) map[word].push({ num: num, key: date.key, disp: date.disp });
    }

    const out = {};
    Object.keys(map).sort().forEach(word => {
        out[word] = map[word]
            .sort((a, b) => b.key - a.key)   // most-recent-first
            .map(d => [d.num, d.disp]);
    });

    // compact JSON (no spaces) to keep the lazy-loaded payload small
    fs.writeFileSync(DEST, JSON.stringify(out));
    return { words: Object.keys(out).length, bytes: fs.statSync(DEST).size };
}

if (require.main === module) {
    const r = build();
    console.log(`Wrote played-dates.json: ${r.words} words, ${r.bytes} bytes`);
}

module.exports = { build };
