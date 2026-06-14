this enitre repo is generated with ai

# Maps Site Checker

A small **local** web app for building a **Petzio** call list. Import a CSV of businesses (e.g. the one your Table Scraper extension exports from Google Maps), tell it which columns are which, and it visits each business's **website** and uses a **local AI model (Ollama)** to answer your questions — _is it a staffed boarding/daycare facility? solo sitter? already has webcams or a pet-parent update app?_ — then gives you a clean CSV you open in Google Sheets and know who to call.

Nothing leaves your machine except fetching the public business websites. The AI runs locally.

```
CSV  →  map columns  →  scan each website with local AI  →  export call list
```

## What you need (already installed on your Mac)

- **Bun** — runs the app (faster than npm/node)
- **Ollama** with the **qwen2.5:7b** model — the local AI

If you ever move to another machine: install Bun from bun.sh, install Ollama from ollama.com, then `ollama pull qwen2.5:7b`.

## First-time setup

```bash
cd ~/Workspace/maps-site-checker
bun install        # one time only — also downloads the headless browser
```

## Running it (every time)

1. Make sure Ollama is running (green **Ollama** badge in the app). If red, open the Ollama app or run `ollama serve`.
2. For best speed, let Ollama answer several at once — start it once with:
   ```bash
   OLLAMA_NUM_PARALLEL=4 ollama serve
   ```
   (Skip if you run the Ollama menu-bar app; it's just faster with this set.)
3. Start the app. **Use the fast production build**, not dev:
   ```bash
   cd ~/Workspace/maps-site-checker
   bun run build && bun run start      # fast — do this for real runs
   # bun run dev                        # only while editing the code
   ```
4. Open **http://localhost:3939**.
5. To stop it: press `Ctrl+C` in that terminal.

## How to use

**1. Import CSV** — drag your CSV in (or click). Works with any CSV; the cryptic headers from the extension (`hfpxzc_label`, `span_2`, …) are fine.

**2. Map your columns** — for each role, pick which column it is. The app pre-guesses from the data and shows a sample value under each so you can confirm:

- **Name**, **Phone** — for your call list
- **Website / site** — the business's real website (the `site` field your extension grabs). Leave as `none` if you don't have it.
- **Google Maps link** — the listing URL. **If you only have Maps links and no website**, map this column and the app will open each listing in a headless browser and read the website off it automatically (see "Resolving websites" below).
- **City or Address** — if you map a full address, the city is parsed out of it automatically.

You need **either** a Website column **or** a Google Maps link column (or both). With only Maps links, the app resolves the websites for you.

**3. What to check** — pick the local **model**, edit the **AI instruction** (overall context), and edit the **checks**. Each check is a `column_key` + a yes/no question + a **Want**:

- **Want = yes / no** — the answer that makes a _good lead_. It drives the **Lead** column and the green/red colours (e.g. `offers_boarding` wants **yes**, `has_webcams` wants **no**). For **want = no** checks (the "does it already have X" ones), if the site doesn't clearly show the feature the answer is forced to **no**, not "unclear" — a business advertises webcams / its owner app, so absence means they don't have it. This stops those checks from inflating "maybe".
- **Want = info only** — just record the answer, don't let it affect the Lead verdict (e.g. `is_vet`).

The defaults match the Petzio target — a staffed boarding/daycare facility that still fields "how's my dog?" requests by hand:

| key                  | question (short)                                                                     | want |
| -------------------- | ------------------------------------------------------------------------------------ | ---- |
| boarding_or_daycare  | runs an overnight boarding or daycare facility? (yes even if a vet that also boards) | yes  |
| is_solo_operator     | one person / in-home sitter, no front desk?                                          | no   |
| has_webcams          | already has live pet webcams (owners self-serve)?                                    | no   |
| has_owner_update_app | already uses a pet-parent app / report-card portal (Gingr, PetExec, …)?              | no   |
| is_vet               | primarily a vet clinic?                                                              | info |

Change or add your own; instruction + checks are remembered between runs. (If you previously ran the app, hit **↺ defaults** to load these.)

- **Skip duplicates** (on): drops repeated phone numbers or website domains.
- **Resolve from Maps link** (on): see below.

**4. Run & export** — press **Scan**. Each row runs live (progress bar + per-row status). The **Lead** column says **✓ call / maybe / skip** based on your Wants (a temporarily/permanently closed business is never a "call").

- **Re-run maybes** — if the model was unsure on some rows, a **↻ Re-run N maybes with [model]** button appears. Pick a bigger/more-accurate model (e.g. `qwen2.5:7b` or `qwen2.5:14b`) and it re-scans **only** the `maybe` rows — fast triage without paying the big model on the whole list.
- **⬇ Export CSV** / **⧉ Copy for Sheets** — columns: lead, call_status, name, phone, email, city, website, business_status, your checks, team_size, locations, business_type, confidence, ai_notes, my_notes, instagram, facebook, other_emails, status, maps_link.

In Sheets, filter `lead = yes` for your call list (or `maybe` to review the unsure ones).

**Working the list (built-in CRM).** Each row has a **Call** dropdown (new / called / interested / not interested / follow up) and a **My notes** field. These are **saved in your browser and keyed to the business** (by website domain, else phone) — so when you re-import the same CSV (or a fresh scrape of the same area) your statuses and notes come back. Phone is click-to-call, email is click-to-mail, site/maps are clickable.

**Extra fields it pulls automatically:**
- **Email + socials** — scraped from the site (mailto links, contact page, de-obfuscated `info [at] …`, Instagram/Facebook). Blank when a site only has a contact form. Turns the call list into a call-*and*-email list.
- **team_size / locations** — the AI's read on solo vs small-team vs large, and single vs multiple locations (Petzio fit signal).
- **Phone** from the Maps listing if your row was missing one (placeholders like `-` / `N/A` count as missing). US numbers are formatted `(xxx) xxx-xxxx`.
- **Open?** — temporarily / permanently closed, read from the Maps listing.

## Resolving websites from Google Maps links

Your earlier CSVs only have the Google Maps **link**, not the business website (the site isn't in the link — Maps loads it with JavaScript). So when a row has no website, the app opens that Maps listing in a **headless browser** (Playwright/Chromium, installed automatically) and reads the website button off the panel — exactly what your extension does on click.

- It's **on by default** (toggle in step 3). It runs for rows missing a website **or** missing a phone — and while it's there it also reads the phone and the open/closed state.
- It's slower than a plain fetch (~0.6–2s per listing) and runs the browser in the background; it auto-closes when idle.
- If Google shows a captcha because you've hit it a lot, those rows come back **google blocked** — wait a bit and re-run (done rows are kept).
- Going forward, if you pick the **site** field in the extension while scraping, the website is already in the CSV and this step is skipped.

The resolved site shows up in the **Site** column of the results so you can see what it found.

## Watching it work

- **Bottom-right box** (in the browser): plain-English live status — "🔎 Finding website — Sunny Paws", "🤖 Asking AI — Sunny Paws", plus `done/total · N leads · rate/min`. Click ✕ to hide.
- **Terminal** (where you ran `bun run start`): full per-business trace, color-coded —
  - `[scan]` business started / finished (+ total seconds)
  - `[site]` how many pages were read + the keyword signals found (e.g. `{webcam:8, boarding:41}`)
  - `[llm]` the exact ask (model, which checks, input size, hints) and the reply (seconds, tokens, **tok/s**, raw JSON)
  - `[resolve]` Maps-link → website/phone/closed
  - This is the place to watch tok/s and compare model speeds.

## How it reads each website

For every site it fetches the homepage and reads `sitemap.xml` **including nested/child sitemaps** (an index → all its child sitemaps) to get the full list of page URLs. Then **the AI chooses which pages to read** (🧠 toggle in step 3, on by default): it's handed the page-URL list + your questions and picks the ~8 most relevant — so a `/live-web-cams` page gets opened *because you asked about webcams*, not because it matched a hardcoded keyword. Regex only does the plumbing (parse the sitemap, rank a shortlist for huge sites, and act as the fallback if the AI call fails); the *relevance judgment* is the model's. The chosen pages are fetched in parallel, stripped to text, and handed to the model with the page-URL list and a quick keyword pre-scan (webcam/boarding/vet/team counts) as hints. Turn the toggle off for keyword-only selection (one fewer AI call, faster, less accurate). It strips all those pages to text, runs a keyword pre-scan for webcam/boarding/vet/team signals, and hands the lot to the model with those signals as hints. The model is told to read every page and only say `unclear` when the text truly doesn't say.

## Row statuses you'll see

| Status                 | Meaning                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| **done**               | Website scanned, AI verdict filled in                                                                    |
| **finding site…**      | Opening the Maps link in the headless browser to get the website                                         |
| **no website**         | The Maps listing has no website button (genuinely no site)                                               |
| **couldn't open maps** | The Maps link failed to load / timed out                                                                 |
| **google blocked**     | Google captcha from too many hits — wait and re-run                                                      |
| **maps link only**     | Row had only a Maps link and resolution was turned off                                                   |
| **site unreachable**   | The website blocked the request or timed out (big chains with bot protection do this) — check it by hand |
| **no text**            | Site is JavaScript-only with no readable text                                                            |
| **AI error**           | Ollama wasn't reachable or errored — check the Ollama badge                                              |

## Speed

- **Parallel** number (1–10, default 4) = how many businesses run at once. Higher is faster but heavier; 4–6 is a good range on this Mac.
- Run the **production build** (`bun run build && bun run start`), not `bun run dev` — noticeably faster.
- Start Ollama with `OLLAMA_NUM_PARALLEL=4` so it answers several scans at once instead of queuing them.
- The app sends `keep_alive: 30m` so the model stays loaded in RAM/VRAM for the whole run — no per-row reload. (First scan still pays a one-time load.)
- Resolving from Maps links is the slow part; once you scrape the **site** field in the extension, that step disappears.

## Saved progress (cache) — nothing is ever scanned twice

Every finished business is written to **`data/cache.jsonl`** (a plain append-only file) the moment it's done. It's keyed by website domain + a hash of your checks/model.

- **Crash or close the tab mid-run?** Just press **Scan** again. Already-done rows come back instantly (no fetch, no AI); only the un-scanned ones actually run. That's the resume — no special button.
- **Re-import the same area later?** Repeat businesses are instant cache hits; only genuinely new ones cost time. The `♻ N cached` pill shows how many were served from cache.
- Change a question / switch model → the hash changes → those re-scan (correct: the answer depends on the question).
- Maps→website/phone lookups are cached too (keyed by the Maps link), so the headless browser doesn't re-open listings it already read.
- **Ignore saved cache (re-scan fresh)** checkbox forces everything to run again. **Clear cache (N)** deletes the file. Your Call statuses / notes are separate (browser storage) and are NOT touched by clearing the cache.
- The file survives server restarts. It's gitignored. Delete `data/cache.jsonl` to reset by hand.

## Notes

- **Accuracy**: the AI only answers from the website's text and is told to say `unclear` rather than guess. Treat `unclear` as "look yourself". It's triage, not gospel — spot-check the **maybe** rows.
- **Be reasonable** with how many sites/listings you hit at once.

## Files

```
app/page.js              the whole UI (import, mapping, checks, run, results, export)
app/api/scan/route.js    server endpoint: fetch a website + run Ollama -> verdict
app/api/resolve/route.js server endpoint: Maps link -> website (headless browser)
app/api/models/route.js  server endpoint: list your installed Ollama models
lib/site.js          fetch a site, find relevant pages, strip HTML to text
lib/resolve.js       open a Maps listing in headless Chromium, read its website
lib/ollama.js        call the local model, force clean JSON, normalize the answer
```
