# Plan: SEO Growth & Google-Ads Monetization

**Status:** Planning only — nothing implemented.
**Constraints:** (1) Monetization via **Google AdSense only** — no affiliates, sponsorships, or premium tiers (this supersedes the monetization half of `STRATEGY_TODO.md`). (2) The homepage experience is sacred: no ads on it, no added weight, no UX changes. All growth happens on **new pages** that link back to it.
**Dependency:** several top ideas get dramatically easier once `PLAN_CRON_ELIMINATION.md` lands (a date→word→puzzle-number schedule + a reliable daily job that can generate pages).

---

## 1. Framing

The site currently targets one keyword cluster ("past wordle answers" / "wordle word list") with one page. The Wordle search ecosystem is far larger, and almost all of it is *daily-refreshing* intent — which is exactly what AdSense rewards (returning daily visitors × fresh crawlable pages). The strategy is a **hub-and-spoke**: the clean homepage remains the brand/utility hub; spoke pages capture adjacent intent and carry the ads.

Two AdSense realities shape the ranking below:

- **Approval:** AdSense rejects thin sites. A homepage that is mostly a word list + a handful of content pages is borderline; the content pages below are what get the account approved at all.
- **RPM & Lighthouse:** ad scripts will wreck a 100 Lighthouse score *on the pages where they load*. Isolating ads to spoke pages preserves the homepage's perfect score and its rankings.

## 2. Stack ranking

Scored on: **SEO/traffic potential**, **AdSense revenue potential**, **effort**, and **risk to the core ethos**. Ordered by expected impact.

| # | Idea | Traffic | Ads $ | Effort | Source |
|---|------|---------|-------|--------|--------|
| 1 | Daily hint page (spoiler-gradient) | ★★★★★ | ★★★★★ | M | New |
| 2 | Dated answer-archive pages | ★★★★★ | ★★★★ | M | New |
| 3 | Best starting words (evergreen) | ★★★★ | ★★★ | S | TODO P3 |
| 4 | Programmatic word-finder pages | ★★★★★ | ★★★★ | L | New |
| 5 | Stats & trivia page(s) | ★★★ | ★★ | S | New |
| 6 | Strategy guide / how-to hub | ★★★ | ★★★ | S | TODO P3 |
| 7 | Standalone /solver page | ★★ | ★★ | M | TODO P1, moved off homepage |
| 8 | Wordle alternatives roundup | ★★ | ★★★ | S | TODO P3 |
| 9 | Streak tracker & shareable boards | ★ | — | M | TODO P2, deprioritized |
| 0 | Technical SEO hygiene | (multiplier) | — | XS | New — do first |

### #0 — Technical SEO hygiene (do before anything else; hours, not days)

- Fix homepage meta description typos: **"unpkayed befote"** → "unplayed before". This string renders in Google results today.
- Resolve `wordlist/index.html`: stale near-duplicate of the homepage with divergent logic and no canonical → delete/redirect, or canonical → `/`. Duplicate content dilutes the only page that currently ranks.
- Register/verify Google Search Console (if not already) — everything below needs its data to steer.
- Expand `sitemap.xml` as spoke pages ship; keep homepage `priority 1.0`.
- Add `og-image.png` (referenced in meta tags — verify it actually exists in the repo; it isn't there now).

### #1 — Daily hint page: `/hint/` (today's Wordle hint, no spoiler by default)

- **Query cluster:** "wordle hint today", "wordle clues today", "today's wordle hint #1844" — among the highest-volume daily searches in the niche, and *higher intent for a page visit* than the answer query (answer-seekers get satisfied by Google snippets; hint-seekers must click through and read).
- **Fits the ethos:** progressive disclosure — page shows letter count facts, "has it been played before?" (our unique data!), first letter behind a tap-to-reveal, then vowels, then the full answer at the bottom behind a final reveal. The site's spoiler-free brand becomes the *differentiator* against the answer-dump competitors.
- **Mechanics:** generated daily by the update job from `schedule.json` (word + puzzle number). Static HTML, one URL that always shows today (`/hint/`) plus dated permalinks (see #2). The client-side rollover logic from the cron-elimination plan applies here too: the page can carry ±1 day of hint data and select by the visitor's local date, so it's never wrong for any timezone.
- **Ads:** natural long-scroll page (hint → hint → reveal) with legitimate content between ad slots. This page will be the site's top earner.
- **Engagement loop:** every hint step links back to the homepage list ("check if it's been played before — spoiler-free").

### #2 — Dated answer-archive pages: `/answers/2026/07/06/` (+ monthly indexes)

- **Query cluster:** "wordle answer July 6", "wordle 1844 answer", "wordle answer yesterday" + an ever-growing long tail of past dates. Each day mints a new page; the archive compounds forever.
- **Mechanics:** the daily job pre-generates the page from the schedule (this is why storing `days_since_launch`/puzzle number in `schedule.json` matters). Monthly index pages (`/answers/2026/07/`) collect internal links and rank for "wordle answers July 2026". Backfill: the full history since June 2021 can be generated from `words.txt` + archived date mappings in one batch — ~1,850 pages of instant, legitimate archive content.
- **Ethos guard:** these pages are explicitly opt-in spoiler territory, clearly labeled; the homepage links to the archive only in the footer. Today's answer page can itself gate the reveal like #1.
- **Ads:** solid inventory across a huge page count; individually low traffic per old page, but the long tail sums.
- **Note:** dated pages published *before* the puzzle date must not exist (spoiler + NYT-relations risk). The job publishes each page only when its date arrives in the earliest timezone.

### #3 — Best starting words: `/best-starting-words/`

- **Query cluster:** "best wordle starting word", "best wordle opener" — large, evergreen, and we can genuinely add value: compute letter/position frequencies **against the actual historical answer list we maintain** rather than generic dictionaries. "SLATE eliminates X% of all 1,850 real answers" is content competitors don't have.
- **Effort:** small — one excellent static page, refreshed occasionally by the job (the stats shift as answers accumulate: "updated daily" claim stays true site-wide).
- **Ads:** good dwell time, evergreen impressions; also the page most likely to earn organic backlinks (bloggers cite starting-word stats), which lifts the whole domain.

### #4 — Programmatic word-finder pages: `/words/starting-with-s/`, `/words/containing-a-t/`, `/words/ending-in-ly/`

- **Query cluster:** "5 letter words starting with S", "5 letter words with A and E" — the biggest raw search volume in this entire plan (it's what wordfinder-style sites live on). Perfect data fit: we already have the canonical answer list, and can present both "past Wordle answers matching X" (unique) and "valid 5-letter words matching X" (commodity but high-volume).
- **Risk / why it's #4 despite #1-sized volume:** thin-content and doorway-page penalties are real. Must be done as a *curated* set (26 starting letters + 26 ending + top letter-pair combos ≈ 100–300 pages, each with real stats: how many were answers, most recent, frequency notes) rather than exploding every combination. Ship after #1–#3 establish domain quality.
- **Ads:** high inventory; these visitors are mid-game and bounce fast, so RPM is lower than #1 — volume compensates.

### #5 — Stats & trivia: `/stats/`

- Most-used letters by position, repeated answers (ties into the FAQ that already ranks), hardest words by average-guess data (public datasets), longest streaks of no-repeat, etc. Auto-refreshed from `words.txt` by the job.
- Moderate search volume ("wordle statistics", "most common wordle letters") but strong **linkability** — this is the page journalists and Reddit cite. Its job is authority, not revenue.

### #6 — Strategy guide hub: `/how-to-win/`

- From TODO P3. Evergreen "how to get better at wordle", "wordle tips" cluster. Write once, 2–3 long-form pieces, internally linked to #3 and #7. Decent AdSense fit (long read time). Lower priority than the data-driven pages because it's commodity content where we have no structural advantage.

### #7 — Solver as a standalone page: `/solver/`

- TODO's P1 put a solver **on the homepage** — rejected here per the prime constraint (homepage stays untouched). As `/solver/`: enter greens/yellows/grays, filter against real answer history + valid guesses.
- SEO value is modest ("wordle solver" is competitive), but engagement value is high: longest sessions on the site, natural daily-return habit, and every session ends near an ad-bearing page. Build after the content spokes exist to feed it traffic.

### #8 — Alternatives roundup: `/wordle-alternatives/`

- From TODO P3. "games like wordle" has steady volume; easy listicle; fine AdSense page. Pure commodity content — do it in an afternoon someday, don't prioritize it.

### #9 — Streak tracker & shareable boards (deprioritized)

- TODO P2. Real retention value but zero SEO, zero ad surface, meaningful implementation cost, and the shareable-board idea duplicates NYT's own share feature. Revisit only if retention becomes the binding constraint; a localStorage streak widget could live on `/solver/` later without touching the homepage.

## 3. Homepage protection rules (non-negotiables)

1. **No AdSense script on `/`.** Ads load only on spoke pages. The homepage keeps its 100 Lighthouse score, zero trackers beyond the existing Cloudflare beacon, and its spoiler-free promise.
2. Homepage gains at most a slim footer nav ("Hints · Archive · Starting Words · Solver · Stats") — text links, no layout shift, no new JS.
3. Spoiler-bearing pages never leak into homepage UI beyond clearly-labeled links; the banner/list logic is untouched.
4. Every spoke page uses the same visual system (Wordle palette, dark, fast, static) — per TODO's maintenance note.
5. Keep spoke pages static-generated by the daily job; no client-side frameworks anywhere.

## 4. Sequencing & measurement

1. **Now:** #0 hygiene + land `PLAN_CRON_ELIMINATION.md` Phase 1 (reliable daily job is a prerequisite for every daily page).
2. **Month 1:** #1 hint page + #3 starting words. Apply to AdSense once both are live (approval needs the content).
3. **Month 2:** #2 archive (backfill history + daily generation), footer nav on homepage.
4. **Month 3+:** #4 word-finder set (measured rollout, watch Search Console for quality signals), then #5/#6/#7 opportunistically.
5. **Measure:** Search Console clicks by page cluster; Cloudflare analytics for return-visit share; AdSense RPM per template. Kill or merge any template that hasn't earned impressions in 90 days.

## 5. Risks

- **Google algorithm risk:** the entire niche periodically gets hit by helpful-content updates (many wordle-answer sites lost rankings in past sweeps). Mitigation: unique data (played-before status, real-answer stats), spoiler-gradient UX, curated rather than exploded programmatic pages.
- **NYT posture:** publishing daily answers *after* the puzzle is live is what the whole ecosystem does; publishing *ahead* is not — the archive/hint job must respect the earliest-timezone gate (§2 of the cron plan handles this naturally).
- **AdSense on a fast site:** measure post-ad Lighthouse on spoke pages; lazy-load ad units below the first viewport to keep LCP/CLS acceptable there too.
