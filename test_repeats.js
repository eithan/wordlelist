#!/usr/bin/env node
/*
 * test_repeats.js — checks the /repeats/ page against the homepage.
 *
 *   node test_repeats.js
 *
 * 1. Repeat logic (repeats/repeats-core.js) on made-up history: normalization,
 *    pending-entry numbering/dates, the appendHistory() duplicate guard.
 * 2. Timing: runs the real inline scripts of index.html and repeats/index.html
 *    in a stubbed browser, under several timezones and instants, and asserts
 *    the repeats page adds the pending puzzle exactly when the homepage starts
 *    listing it. Each timezone runs in a child process (TZ is per-process).
 * 3. Same, with the live repo data files (prints numbers only, never words).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { execFileSync } = require('child_process');
const R = require('./repeats/repeats-core.js');

const DIR = __dirname;

/* ── made-up fixture (not real answers) ── */
const FIX = {
    'answers.txt': [
        '# fixture', 'QXFIV 5 01/06/22', 'QXFFO 4 01/05/22', 'QXTHR 3 01/04/22',
        'QXTWO 2 01/03/22', 'QXONE 1 01/02/22', 'QXZER 0 01/01/22@', ''
    ].join('\n'),
    'words.txt': 'QXFFO\nQXONE\nQXTHR\nQXTWO\nQXZER\n',
    'safe.txt': 'QXFIV',
    'prior.txt': ' qxtwo \n',          // #6 repeats #2; lowercase/whitespace on purpose
    'current.txt': 'QXSEV',
    'meta.json': JSON.stringify({ wordle_date: '2022-01-08' })
};

/* ── stubbed browser: run a page's inline script, report what it did ── */
function runPage(file, data, nowMs) {
    const html = fs.readFileSync(path.join(DIR, file), 'utf-8');
    const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
    const els = {};
    const el = () => ({
        innerHTML: '', textContent: '', className: '', value: '', style: {}, hidden: false,
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {}, removeAttribute() {}, setAttribute() {}, appendChild() {}
    });
    const RealDate = Date;
    class FakeDate extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(nowMs); }
        static now() { return nowMs; }
    }
    const fetch = url => {
        const key = url.replace(/^\//, '').split('?')[0];
        if (!(key in data)) return Promise.reject(new Error('404 ' + key));
        const body = data[key];
        return Promise.resolve({ ok: true, text: () => Promise.resolve(body), json: () => Promise.resolve(JSON.parse(body)) });
    };
    const store = {};
    const sb = {
        Date: FakeDate, fetch, Promise, console, setTimeout, clearTimeout,
        sessionStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
        location: { reload() {} },
        matchMedia: () => ({ matches: true }), addEventListener() {},
        document: {
            getElementById: id => (els[id] = els[id] || el()),
            querySelector: () => el(), createElement: () => el(),
            body: { appendChild() {} }, addEventListener() {}
        }
    };
    sb.window = sb; sb.self = sb;
    const ctx = vm.createContext(sb);
    if (/repeats-core\.js/.test(html)) vm.runInContext(fs.readFileSync(path.join(DIR, 'repeats/repeats-core.js'), 'utf-8'), ctx);
    vm.runInContext(inline, ctx);
    return new Promise(res => setTimeout(() => res(els), 50));
}

/* homepage: has it switched this visitor to the new puzzle, i.e. started
 * listing prior.txt's word? A repeat word is already in the list, so swap in a
 * never-played sentinel for prior/current: then the gate shows up as the word
 * count going up by one. Only meta.json, the clock and TZ decide it. */
async function mainShowsPrior(data, nowMs) {
    const probe = Object.assign({}, data, { 'prior.txt': 'QXQXQ', 'current.txt': 'QXQXZ' });
    const els = await runPage('index.html', probe, nowMs);
    const base = new Set(data['words.txt'].split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length === 5));
    base.add(data['safe.txt'].trim().toUpperCase());
    const shown = +els.count.textContent;
    assert(shown === base.size || shown === base.size + 1, 'unexpected homepage count');
    return shown === base.size + 1;
}

/* repeats page: did it re-render, and with which numbers? */
async function repeatsResult(data, nowMs) {
    const els = await runPage('repeats/index.html', data, nowMs);
    const body = els['repeats-body'] ? els['repeats-body'].innerHTML : '';
    if (!body) return { pending: false };
    const through = +body.match(/through Wordle #([\d,]+)/)[1].replace(/,/g, '');
    const count = +body.match(/<b>([\d,]+)<\/b><span>answers reused/)[1].replace(/,/g, '');
    const newest = body.match(/<td class="word-cell">[A-Z]{5}<\/td><td>[^<]*<span class="sub">#([\d,]+)/);
    return { pending: true, through, count, newestRepeat: newest ? +newest[1].replace(/,/g, '') : null };
}

/* ── child mode: one timezone, several instants ── */
async function child() {
    const cases = JSON.parse(process.env.WL_CASES);
    const data = process.env.WL_DATA === 'live' ? liveData() : FIX;
    const out = [];
    for (const c of cases) {
        const now = Date.parse(c.utc);
        const main = await mainShowsPrior(data, now);
        const rep = await repeatsResult(data, now);
        out.push({ label: c.label, main, rep });
    }
    process.stdout.write(JSON.stringify(out));
}

function liveData() {
    const d = {};
    for (const f of ['answers.txt', 'words.txt', 'safe.txt', 'prior.txt', 'current.txt', 'meta.json'])
        d[f] = fs.readFileSync(path.join(DIR, f), 'utf-8');
    return d;
}

function inTZ(tz, cases, dataMode) {
    const r = execFileSync(process.execPath, [__filename, '--child'], {
        env: Object.assign({}, process.env, { TZ: tz, WL_CASES: JSON.stringify(cases), WL_DATA: dataMode || 'fixture' })
    });
    return JSON.parse(r.toString());
}

let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed++; }

async function main() {
    /* 1. repeat logic */
    const hist = R.parseHistory(FIX['answers.txt']);
    ok(R.withPending(hist, FIX['prior.txt'], '2022-01-08', '2022-01-07') === hist, 'not pending before wordle_date');
    const ext = R.withPending(hist, FIX['prior.txt'], '2022-01-08', '2022-01-08');
    ok(ext.length === hist.length + 1, 'pending added on wordle_date');
    const p = ext[ext.length - 1];
    ok(p.num === 6 && p.date.toISOString().slice(0, 10) === '2022-01-07', 'pending = newest + 1 (number and day)');
    const a = R.analyse(ext);
    ok(a.repeats.length === 1 && a.repeats[0].num === 6 && a.repeats[0].first.num === 2, 'normalized prior detected as repeat of #2');
    ok(R.stats(ext).latest.num === 6, 'through #6');
    ok(R.withPending(hist, 'QXFIV', '2022-01-08', '2022-01-09') === hist, 'duplicate guard (same as appendHistory)');
    ok(R.withPending(hist, 'QX1!', '2022-01-08', '2022-01-09') === hist, 'invalid prior ignored');
    ok(R.withPending(hist, FIX['prior.txt'], undefined, '2022-01-09') === hist, 'no meta → nothing pending');
    ok(R.analyse(R.withPending(hist, 'QXNEW', '2022-01-08', '2022-01-08')).repeats.length === 0, 'fresh word is not a repeat');

    /* server build and shared core agree on the live data (numbers only) */
    const { stats, readHistory } = require('./build_repeats.js');
    const live = stats(readHistory());
    const html = fs.readFileSync(path.join(DIR, 'repeats/index.html'), 'utf-8');
    ok(html.includes(`through Wordle #${R.n(live.latest.num)} `), 'static page matches answers.txt');

    /* 2. timing on the fixture. wordle_date 2022-01-08 is written by the
     *    2022-01-07 10:00 CT run (15:00 UTC); prior's puzzle ends at each
     *    visitor's local midnight into Jan 8. */
    const tzCases = {
        'Pacific/Honolulu': [   // UTC-10
            { label: 'HST 23:59 Jan 7', utc: '2022-01-08T09:59:00Z', expect: false },
            { label: 'HST 00:00 Jan 8', utc: '2022-01-08T10:00:00Z', expect: true }],
        'America/Chicago': [
            { label: 'CST 23:59 Jan 7', utc: '2022-01-08T05:59:00Z', expect: false },
            { label: 'CST 00:01 Jan 8', utc: '2022-01-08T06:01:00Z', expect: true }],
        'America/New_York': [
            { label: 'EST 23:59 Jan 7', utc: '2022-01-08T04:59:00Z', expect: false },
            { label: 'EST 00:00 Jan 8', utc: '2022-01-08T05:00:00Z', expect: true }],
        'Pacific/Kiritimati': [   // UTC+14
            { label: '+14 just after the run', utc: '2022-01-07T15:01:00Z', expect: true },
            { label: '+14 23:59 Jan 7', utc: '2022-01-07T09:59:00Z', expect: false }],
        'UTC': [
            { label: 'UTC 23:59 Jan 7', utc: '2022-01-07T23:59:00Z', expect: false },
            { label: 'UTC 00:00 Jan 8', utc: '2022-01-08T00:00:00Z', expect: true }]
    };
    for (const [tz, cases] of Object.entries(tzCases)) {
        const res = inTZ(tz, cases);
        res.forEach((r, i) => {
            const c = cases[i];
            ok(r.main === c.expect, `${tz} ${c.label}: homepage reveal = ${c.expect}`);
            ok(r.rep.pending === r.main, `${tz} ${c.label}: repeats page matches homepage`);
            if (r.rep.pending) ok(r.rep.through === 6 && r.rep.count === 1 && r.rep.newestRepeat === 6,
                `${tz} ${c.label}: counts/order (through #6, 1 repeat, newest #6)`);
            console.log(`  ${tz.padEnd(18)} ${c.label.padEnd(24)} homepage=${r.main} repeats=${r.rep.pending}` +
                (r.rep.pending ? ` through #${r.rep.through}, ${r.rep.count} repeats` : ''));
        });
    }

    /* 3. live repo data, right now, across timezones (numbers only) */
    const now = new Date().toISOString();
    console.log(`  live data @ ${now}, static: ${live.count} repeats through #${live.latest.num}`);
    for (const tz of ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
        const r = inTZ(tz, [{ label: 'now', utc: now }], 'live')[0];
        ok(r.rep.pending === r.main, `live ${tz}: repeats page matches homepage`);
        if (r.rep.pending) ok(r.rep.through === live.latest.num + 1 && r.rep.count >= live.count && r.rep.count <= live.count + 1,
            `live ${tz}: through #${live.latest.num + 1}, count static or static+1`);
        console.log(`  ${tz.padEnd(20)} homepage shows pending=${r.main} repeats page pending=${r.rep.pending}` +
            (r.rep.pending ? ` → through #${r.rep.through}` : ''));   // count not printed: it would tell whether that puzzle was a repeat
    }
    console.log(`\nAll ${passed} checks passed.`);
}

if (process.argv.includes('--child')) child().catch(e => { console.error(e); process.exit(1); });
else main().catch(e => { console.error(e.message); process.exit(1); });
