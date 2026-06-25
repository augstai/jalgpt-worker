# jalgpt browser worker

A tiny Node + Playwright service that does the things Vercel can't: scrape
JS-rendered sites and fill contact forms with a real browser.

- `POST /scrape { urls }` → `{ text }` — used automatically by enrichment for
  JS-heavy sites (the app already routes to it via `SCRAPER_WORKER_URL`).
- `POST /fill { url, mapping, values, submitSelector }` → `{ ok, status }` — for
  form-fill (wired in a follow-up app change).
- `GET /health` → `{ ok }`.

## Deploy to Render (free) — ~5 minutes

1. Commit this `worker/` folder and push to your Git repo.
2. Render → **New → Blueprint** → connect the repo. It reads `worker/render.yaml`
   and creates a free Docker web service. (Or **New → Web Service → Docker**,
   set **Root Directory = `worker`**, **Plan = Free**.)
3. After it builds, copy:
   - the service **URL** (e.g. `https://jalgpt-worker-xxxx.onrender.com`)
   - the generated **`WORKER_TOKEN`** (Render → service → Environment).
4. In **Vercel → jalgpt → Settings → Environment Variables (Production)** add:
   - `SCRAPER_WORKER_URL` = `https://jalgpt-worker-xxxx.onrender.com/scrape`
   - `SCRAPER_WORKER_TOKEN` = `<the WORKER_TOKEN>`
   then redeploy. Enrichment now auto-routes JS-site scrapes through the worker.
5. Test: `curl https://jalgpt-worker-xxxx.onrender.com/health` → `{"ok":true}`.

## Free-tier caveats (honest)
- **512MB RAM** — Chromium is heavy. The launch flags keep it lean and it
  processes one page at a time, but if it OOMs under load, bump to Render
  Starter ($7) or move to a bigger box.
- **Spins down after ~15 min idle** → first request cold-starts (~50s). The app
  times out gracefully and falls back to plain fetch, so nothing breaks — but to
  keep it warm, add a cron (e.g. cron-job.org) hitting `/health` every 10 min.
- Keep the `Dockerfile` image tag and `package.json` playwright version in sync.
