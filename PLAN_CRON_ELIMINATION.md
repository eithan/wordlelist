# Plan: Eliminating the Daily Cronjob via Prefetching

**Status:** Planning only — nothing implemented.
**Goal:** Remove the hard requirement that `update_wordle.js` runs at exactly 10:00 UTC every day on a personal machine, while preserving (and ideally improving) the per-timezone puzzle-rollover behavior.

**Motivating evidence:** `meta.json` shows the last successful run was **2026-06-19** — the cron has been down for ~2.5 weeks and the site has been serving a stale word/banner ever since. The current architecture has zero tolerance for a missed run; this plan's core aim is to buy *days* of failure tolerance instead of *zero*.

---

## 1. Current architecture (what we're replacing)

- Four single-word/state files: `current.txt` (today, UTC+14 frame), `prior.txt` (yesterday), `safe.txt` (two days ago), `meta.json` (`wordle_date` = the UTC+14 date when `current.txt` became active).
- Client-side timezone gate: `localDate >= wordle_date` → new puzzle (answer = current), else old puzzle (answer = prior). `safe.txt` and `prior.txt` are merged into the display list as appropriate.
- The single `wordle_date` value is an **approximation** of per-timezone rollover that only works if the job runs precisely at UTC+14 midnight (10:00 UTC). Miss the run → every timezone is wrong for the day.

## 2. Key unknown: how far ahead does the NYT API serve?

`https://www.nytimes.com/svc/wordle/v2/{YYYY-MM-DD}.json` — the response includes `print_date`, which makes clamping detectable: if you request `2026-08-01` and get back `print_date: 2026-07-07`, the API clamped you.

Evidence is conflicting:

- The header comment in `update_wordle.js` says *"Future dates return tomorrow's word"* — i.e. horizon ≈ **+1 day** (first-hand observation, date unknown).
- A third-party harvest ([sbplat/wordle](https://github.com/sbplat/wordle)) obtained answers through 2026-05-14 at some point, implying a much longer horizon existed at some time; the same repo notes the endpoint behavior has since changed.
- The 2022 "PWNED" incident showed NYT once served arbitrary future dates, then tightened it.

**Conclusion:** the horizon is a moving target set by NYT and must be (a) measured empirically and (b) monitored continuously. The design below works for any horizon ≥ 1 day and degrades gracefully if NYT tightens it.

### Phase 0 — Probe (do this first, it's an hour of work)

Write a small `probe_horizon.js`:

1. Request today, +1, +2, +3, +7, +14, +30, +60.
2. For each response, compare requested date vs returned `print_date`. The largest offset where they match = current horizon **H**.
3. Run it a few days in a row to confirm H is stable.
4. Keep the probe as part of the recurring job forever (log H each run) so we notice if NYT tightens it before it bites us.

Everything below is parameterized on H.

## 3. Target architecture: `schedule.json` + client-side rollover

### 3.1 Replace the four state files with one schedule file

```json
{
  "version": 3,
  "generated_at": "2026-07-06T12:00:00Z",
  "words_txt_through": "2026-07-01",
  "days": [
    { "date": "2026-07-02", "word": "EMOJI", "num": 1839 },
    { "date": "2026-07-03", "word": "DRAKE", "num": 1840 },
    { "date": "2026-07-07", "word": "…",     "num": 1844 }
  ]
}
```

- `days` covers from the day after `words.txt`'s last folded word through `today+H` (as fetched).
- `num` = `days_since_launch` from the API — free to store now, needed later for the SEO pages in the strategy doc.
- Optional: lightly obfuscate `word` values (e.g. ROT13/base64) so casual view-source doesn't spoil future puzzles. This is courtesy, not security — the NYT API is public anyway, and today's `current.txt` already exposes the answer in plaintext. Decide at implementation time; skip if it complicates anything.

### 3.2 New client logic — simpler AND more correct than today

The insight: **once the client has a date→word map, the timezone problem disappears.** NYT's puzzle rolls at each user's local midnight; with a schedule the client can implement that exactly instead of approximating it with one global `wordle_date`:

- `answer = schedule[localDate]` — the user's own local date picks their puzzle. No UTC+14 math in the client at all.
- Display list = `words.txt` ∪ every schedule entry with `date < localDate`. This replaces the entire `safe`/`prior`/`current` three-file rotation and its injection rules.
- `playedBefore = answer ∈ (words.txt ∪ earlier schedule entries)`; filter the answer out of the display list if it has never been played — identical to today's behavior.
- Entries with `date > localDate` are never rendered anywhere.
- The stale-tab freshness check simplifies: reload when `localDate` differs from the date stored in `sessionStorage` (no `meta.json` fetch needed); keep a `version` bump check for when `words.txt`/schedule shape changes.

Every user in every timezone rolls over at their own midnight with **zero server-side action** — this is the piece that makes the daily deadline unnecessary.

Note: this also resolves the current drift between `index.html` and the stale `wordlist/index.html` copy (which disagree on the old-puzzle `playedBefore` logic — see §6).

### 3.3 The job doesn't disappear — it becomes lax and relocatable

`update_wordle.js` is still needed to: fold now-past schedule entries into `words.txt`, extend the schedule to `today+H`, re-inject the static SEO word list, update `sitemap.xml`, commit/push.

But its constraints change completely:

| | Today | After |
|---|---|---|
| Must run | Exactly 10:00 UTC daily | Any time, at least once every **H−1** days |
| Missed-run impact | Site wrong for everyone within hours | Nothing, until runway is exhausted days later |
| Where | Personal machine w/ gh auth | Anywhere (see 3.4) |

Each run should also **re-fetch every future date it already has** and overwrite on mismatch — NYT editors have swapped upcoming words before publication in the past (e.g. removing sensitive words). Cheap insurance: H requests per run.

### 3.4 Where the job runs: GitHub Actions (recommended)

Even if Phase 0 finds H = 1 (no meaningful prefetch), moving the job to a **GitHub Actions scheduled workflow** alone eliminates the personal-machine cron:

- Free for public repos; commits via the built-in `GITHUB_TOKEN` (drop the `gh` CLI / SSH-key dependency entirely).
- GitHub emails on workflow failure — monitoring for free.
- Keep `workflow_dispatch:` for manual runs.

Caveats to design around: scheduled runs can be delayed 15–60 min (harmless once the client handles rollover); GitHub disables schedules after 60 days without repo activity (moot — the job itself commits); avoid exact-hour cron minutes (`17 10 * * *` beats `0 10 * * *` for queue delays).

Recommended cadence: **keep it daily even though correctness only needs every H−1 days.** Daily runs are free, keep the SEO static list and sitemap `lastmod` fresh (the strategy doc depends on daily-fresh pages), catch word swaps within 24h, and re-probe H daily. The point of this plan is not to run the job less — it's that **a missed run no longer matters.** Runway = H days instead of 0.

### 3.5 Failure modes & graceful degradation

- **Job fails / NYT blocks / horizon shrinks:** site stays fully correct until the schedule runs out. Add a runway assertion to the job: if `max(schedule date) < today+2`, exit nonzero → GitHub failure email.
- **Client past end of schedule** (job dead for >H days): render the word list without the banner (`banner` stays `visibility:hidden` — layout already reserves space), count from `words.txt` + schedule. Degraded but never wrong — strictly better than today's failure mode (wrong banner + wrong list).
- **User clock badly wrong / before schedule start:** same fallback path.
- **Caching:** client already fetches data with `cache: no-store`; GH Pages ~10-min edge cache is within tolerance since rollover is client-computed.

## 4. Migration sequence

1. **Phase 0:** probe H (§2). Decision gate: if H = 1, do Phases 1 & 4 only (GH Actions daily, keep current file format, runway stays ~1 day but the *machine* dependency dies). If H ≥ 3, do everything.
2. **Phase 1:** port the job to GitHub Actions as-is (no format changes). Immediate win; fixes the current outage class. Retire the personal crontab entry.
3. **Phase 2:** job additionally emits `schedule.json` alongside the legacy four files (dual-write; old clients/caches keep working).
4. **Phase 3:** ship new client logic reading `schedule.json` with fallback to legacy files. Also update the stale `wordlist/` copy or (better) resolve it per §6.
5. **Phase 4:** after a week of clean runs, stop writing `current/prior/safe/meta`, delete legacy client path, update README.
6. **Ongoing:** watch the logged horizon H; if NYT tightens it below 3, nothing breaks — the design just converges back to "daily job with 1-day runway," which GH Actions handles fine.

## 5. Explicitly rejected alternatives

- **Fetch NYT API directly from the browser:** CORS-blocked, spoils answers in network tab pre-rollover, and puts NYT rate limits in the user path. No.
- **Prefetch an entire year+ into the repo:** even if H were huge, long prefetch maximizes exposure to editorial word swaps and makes the repo a spoiler archive. Cap stored runway at min(H, ~14 days).
- **Serverless function computing the word on demand:** adds runtime infrastructure to a proudly static site; contradicts the zero-dependency ethos.

## 6. Related housekeeping surfaced during this review (fold into Phase 3)

- `wordlist/index.html` is a stale near-duplicate (last updated 03/07/2026) with *divergent* puzzle logic and no canonical pointing home — duplicate-content liability and a correctness trap. Either delete it with a redirect or make the job update it too.
- Homepage meta description contains typos: **"unpkayed befote"** → "unplayed before". (One-line fix, real SEO string shown to searchers.)
- README's scheduling section will need a rewrite once Phase 1 lands.
