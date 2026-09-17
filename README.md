# Wordle Word List

**[wordlelist.com](https://wordlelist.com)** — A complete, searchable list of every previously played NYT Wordle answer. Updated daily.

Browse all 1,690+ past Wordle words, search for specific words, and see whether today's answer has ever been used before — all without spoilers. Zero dependencies, dark mode, mobile-friendly.

## How it works

- **`words.txt`** — master list of all past answers (sorted, one per line, uppercase).
- **`current.txt`** — today's Wordle answer.
- **`prior.txt`** — yesterday's answer (not yet in `words.txt`; injected client-side for users on the new puzzle).
- **`meta.json`** — `{ wordle_date, ran_at }` — written each day by the update job. The site uses `wordle_date` to decide which puzzle a visitor is on based on their local timezone.

The site fetches all four files at load time. If a visitor's local date is on or after `wordle_date` they see the new puzzle (answer = `current.txt`); otherwise they're still on yesterday's (answer = `prior.txt`). A banner tells them whether today's word has been played before — if so the word list is flat; if not, it glows.

## Daily update job

`update_wordle.js` keeps everything in sync. Each run it:

1. Adds the old `prior.txt` word into `words.txt` (alphabetical insert, no dupes).
2. Rotates `current.txt` → `prior.txt`.
3. Fetches the new answer from the NYT API → `current.txt`.
4. Writes `meta.json` with the new `wordle_date`.
5. Commits and pushes to `main` (GitHub Pages auto-deploys).
6. Polls the Pages build to completion and posts the deploy result (✅/❌) to Discord.

### Deploy notifications

GitHub's repo webhook already posts each commit to Discord, but Discord's `/github` compat endpoint silently drops `deployment_status` / `page_build` events, so the deploy result never appears. After pushing, the script polls `gh api repos/eithan/wordlelist/pages/builds/latest` until the build for the just-pushed commit reaches a terminal state, then posts a native Discord message with the outcome.

Set the target webhook via env var (either the base URL or the GitHub-compat `…/github` form — the trailing `/github` is stripped automatically):

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
```

If `DISCORD_WEBHOOK_URL` is unset the step is skipped. The whole notification is best-effort — any failure (missing `gh`, poll timeout, Discord down) is logged and swallowed, so it never blocks the daily update.

### Scheduling

The job runs daily at **10:00 CST** — the host's local time (cron interprets its schedule in the machine's timezone, so `0 10` fires at 10:00 local, not UTC). This lands the new puzzle word well before the NYT reset, and comfortably ahead of the day rolling over across the timezones where the site's traffic actually is.

```
0 10 * * * DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token> /usr/bin/node /path/to/update_wordle.js >> /tmp/wordlelist_update.log 2>&1
```

Add it with `crontab -e`.

### Prerequisites

- [Node.js](https://nodejs.org) 20 or 24 (LTS)
- **SSH access to GitHub** — the script pulls and pushes over SSH (`git@github.com:eithan/wordlelist.git`), so the host needs a key authorized on the repo. For cron, use a passphrase-less key and make sure `github.com` is in `~/.ssh/known_hosts` (non-interactive SSH can't answer a host-key prompt).
- [GitHub CLI](https://cli.github.com) (`gh`) authenticated — used for the post-deploy Pages build poll (`gh api …`), not for git auth.

### Logs

The script appends to `/tmp/wordlelist_update.log`. If the NYT API call fails for any reason, `current.txt` is left unchanged and the site keeps working with the previous word — nothing breaks.

## Solver word list

The helper at `/solver/` ranks its suggestions by **answer likelihood**, not raw English word frequency. Frequency alone put JESUS, PENIS and WIVES above MESSY and RINSE — common words, but NYT doesn't use plurals or crude words as answers.

- **`solver-words-freq.txt`** — every allowed guess, in popularity order. The source of truth for the frequency signal; never overwritten.
- **`solver-words.txt`** — generated. Same words sorted most-likely-answer first, behind a `# prior b0 b1` header holding the curve that converts a word's position back into a probability. The solver reads that header, so ordering and curve can't drift apart.
- **`build_solver_words.js`** — regenerates the above. It learns the likelihood from `words.txt` (every past answer) by logistic regression over four signals: popularity rank, plural-looking S ending (not -SS/-US), ends in ED, and ends in A, I or O. Plural-looking words almost never become answers (1 in 270 among the most common words), and words ending in A/I/O — mostly names, places, brands and slang like MARIA, INDIA, HONDA, GONNA — do so at less than half the rate their popularity predicts, so the data does most of the work. A short `BLOCK` list in the script demotes (never removes) crude words and brands.

```
node build_solver_words.js
```

Re-run it after answers accumulate if you want the ordering to reflect them, then bump the `?v=` on the solver's `solver-words.txt` fetch so returning visitors pick up the new order.

At pick time the solver scores each candidate by how evenly its feedback would split the words still possible (where letter placement and letter frequency come in), plus the chance of being done within two guesses — the word is the answer, or its feedback leaves a group whose likeliest word is — plus a bonus for being a plausible answer right now. Backtested over the 900 most recent answers in three windows of 300, with the curve fitted only on answers older than each window: **3.42 guesses average vs 3.51** for popularity-first, with plurals in the suggestion strip falling from 3% to under 1%.

## Features

- 🔍 **Search** — Instantly filter through all past answers
- ✨ **Spoiler-free banner** — Tells you if today's word has been used before, without revealing it
- 🌍 **Timezone-aware** — Shows the right puzzle based on your local time
- 📱 **Mobile-friendly** — Clean dark-mode design, works on any device
- ⚡ **Fast** — Static site, no frameworks, no tracking, no cookies

## Links 

- **Live site:** [wordlelist.com](https://wordlelist.com)
- **Sitemap:** [wordlelist.com/sitemap.xml](https://wordlelist.com/sitemap.xml)
