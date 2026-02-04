# Wordle Word List

A static, zero-dependency site that displays every previously played NYT Wordle answer. Hosted at [wordlelist.com](https://wordlelist.com) via GitHub Pages.

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

### Scheduling

The job must run at **10:00 UTC** every day. That is midnight in UTC+14 (Line Islands / Kiritimati) — the earliest timezone on Earth. Running at this time ensures the new puzzle word is available the moment any user on the planet sees a new day.

```
0 10 * * * /usr/bin/node /path/to/update_wordle.js >> /tmp/wordlelist_update.log 2>&1
```

Add it with `crontab -e`.

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [GitHub CLI](https://cli.github.com) (`gh`) authenticated with a token that has write access to this repo. The script uses `gh auth token` to set up the push URL automatically.

### Logs

The script appends to `/tmp/wordlelist_update.log`. If the NYT API call fails for any reason, `current.txt` is left unchanged and the site keeps working with the previous word — nothing breaks.
