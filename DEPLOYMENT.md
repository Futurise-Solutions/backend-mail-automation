# Deployment Guide — Futurise Cold Email Automation

Free-tier architecture. The 3 AM send runs as a **GitHub Actions worker**, so the
backend does **not** need to be awake at 3 AM (or cost anything to stay awake).

```
 ┌─────────────┐         ┌──────────────────────┐        ┌────────────────────┐
 │  Netlify    │  HTTPS  │  Backend API         │        │  MongoDB Atlas     │
 │  (frontend) │────────▶│  Render/Koyeb (free, │───────▶│  (free M0)         │
 │  free       │         │  may sleep)          │        │                    │
 └─────────────┘         └──────────────────────┘        └─────────▲──────────┘
                                                                    │ same DB
                          ┌──────────────────────┐                 │ (reads Settings,
   03:00 IST daily  ─────▶│  GitHub Actions       │─────────────────┘  writes leads)
   (cron, UTC)            │  runScheduledSend.js  │──▶ Gemini/Groq + SMTP/Resend
                          └──────────────────────┘
```

The runner connects to the **same** MongoDB and reads the **same** Settings document
the dashboard writes — so API keys, daily limit, batch sizes, and signature configured
in the UI are automatically used by the scheduled job.

---

## Part 1 — MongoDB Atlas (free)

1. Create a free **M0** cluster at <https://cloud.mongodb.com>.
2. **Database Access** → add a user (username + strong password).
3. **Network Access** → add IP `0.0.0.0/0` (Allow from anywhere).
   Required because both Render and GitHub Actions runners use dynamic IPs.
4. **Connect → Drivers** → copy the SRV URI, e.g.
   `mongodb+srv://USER:PASS@cluster0.xxxx.mongodb.net/mail-automation?retryWrites=true&w=majority`
   (add the `/mail-automation` db name before the `?`). This is your `MONGODB_URI`.

---

## Part 2 — Backend API (Render free tier)

The API only needs to be up while you use the dashboard, so a sleeping free tier is fine.

1. Push `backend-mail-automation/` to its own GitHub repo.
2. Render → **New → Web Service** → connect the repo.
   - **Build command:** `npm ci`
   - **Start command:** `npm start`
   - **Instance type:** Free
3. Add environment variables (Render → Environment):

   | Key | Value |
   |---|---|
   | `MONGODB_URI` | your Atlas SRV URI |
   | `JWT_SECRET` | a long random string |
   | `JWT_EXPIRES_IN` | `7d` |
   | `ADMIN_EMAIL` / `ADMIN_PASSWORD` | your admin login (seeded on first boot) |
   | `GEMINI_API_KEY` / `GROQ_API_KEY` | AI keys (or set them later in Settings UI) |
   | `NODE_ENV` | `production` |
   | `ENABLE_INPROCESS_CRON` | `false` ← leave OFF; GitHub Actions is the scheduler |

4. Deploy. Note the URL, e.g. `https://futurise-backend.onrender.com`.

> **Free-tier note:** Render free services sleep after ~15 min idle and cold-start in
> ~30–60s. That is fine for the dashboard. It is NOT reliable for a 3 AM cron — which is
> exactly why the send job runs in GitHub Actions instead.

**Alternatives:** Koyeb (free web service), Fly.io (free allowance, set
`min_machines_running = 1`), or Railway (~$5/mo, always-on). If you pick an **always-on**
host, you can skip Part 4 and instead set `ENABLE_INPROCESS_CRON=true` to use the built-in
`node-cron` (fix the timezone — `node-cron` uses the server's local time, usually UTC).

---

## Part 3 — Frontend (Netlify)

1. Push `frontend-mail-automation/` to its own GitHub repo.
2. Netlify → **Add new site → Import** → connect the repo.
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
3. **Environment variables:** add `VITE_API_URL = https://futurise-backend.onrender.com/api`
   (your Render URL + `/api`). The frontend now reads this — see `src/services/api.js`
   and `src/components/BatchSendModal.jsx`.
4. **SPA routing fix:** create `frontend-mail-automation/public/_redirects` containing:
   ```
   /*    /index.html   200
   ```
   Without this, refreshing `/leads` etc. returns 404.

---

## Part 4 — Scheduled sends via GitHub Actions ⭐

The workflow is at `.github/workflows/scheduled-send.yml`. It runs
`node scripts/runScheduledSend.js <level>` on a schedule.

### 4a. Add repository secrets
In the **backend** GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Required? | Notes |
|---|---|---|
| `MONGODB_URI` | ✅ Yes | same Atlas URI as the backend |
| `GEMINI_API_KEY` | ⚠️ Optional | only if not saved in Settings UI |
| `GROQ_API_KEY` | ⚠️ Optional | only if not saved in Settings UI |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | ⚠️ Optional | only if using SMTP and not saved in Settings UI |
| `RESEND_API_KEY` `RESEND_FROM` | ⚠️ Optional | only if using Resend and not saved in Settings UI |

> The cleanest setup: configure AI keys + SMTP/Resend + daily limit + batch sizes once in
> the **Settings page**. They persist in MongoDB, and the runner reads them from there —
> so the only secret you strictly need is `MONGODB_URI`.

### 4b. Timezone — GitHub cron is ALWAYS UTC
Your local time is **IST (UTC+5:30)**. The workflow ships with:

| Local (IST) | UTC cron | Runs |
|---|---|---|
| 03:00 | `30 21 * * *` | `initial` cold-email batch |
| 00:30 | `0 19 * * *` | `inactive` sweep (10-day rule) |

To change the send time: pick your IST time, subtract 5h30m to get UTC, and edit the cron
in the YAML. (e.g. 09:00 IST → 03:30 UTC → `30 3 * * *`.) Follow-up crons are included but
commented out — uncomment and set times to auto-send them.

### 4c. Test it safely first (no emails sent)
GitHub repo → **Actions → Scheduled Email Sends → Run workflow** →
choose **level = initial** and **dry_run = true**. It connects, reports how many leads
*would* be processed, and sends nothing. Once that looks right, run again with
`dry_run = false`, or just wait for 3 AM.

### 4d. How level selection works
- **Scheduled runs:** the cron string is mapped to a level in the `Resolve` step.
- **Manual runs:** you pick the level (and dry-run) from the dropdown.

---

## Part 5 — In-process cron toggle

`server.js` only starts the built-in `node-cron` schedulers when
`ENABLE_INPROCESS_CRON=true`.

| Hosting choice | `ENABLE_INPROCESS_CRON` | Scheduler |
|---|---|---|
| Free/sleeping host (Render free, Netlify) | `false` (default) | GitHub Actions |
| Always-on host (Railway/Fly/Koyeb always-on) | `true` | built-in node-cron |

⚠️ **Never enable both at once** — you would send every email twice.

---

## Caveats & gotchas (read before going live)

- **Follow-up 1 catalogue PDF:** the PDF lives in `uploads/`, which is **gitignored**, so
  it is absent on a GitHub runner — follow-up 1 sends without the attachment (logged as a
  warning, does not fail). Options: (a) run follow-ups from the dashboard/always-on host,
  or (b) commit a `assets/catalogue.pdf` into the repo and point `cataloguePdfPath` at it.
- **GitHub Actions timing** can drift 5–15 min and is skipped/disabled after **60 days**
  with no commits to the default branch. Fine for cold email; push occasionally to keep it alive.
- **Daily limit** is enforced for `initial` sends (counts today's successful `EmailHistory`),
  but `followup` batches are **not** capped by the daily limit — size them via `batchSize`.
- **"Today" boundary** for the daily limit uses the runner's local midnight = **UTC** midnight.
  If you need it aligned to IST, that is a small code change (say the word).
- **Security (harden before public exposure):** CORS is currently `origin: '*'`
  (`server.js`), the admin user is seeded from env, and JWT lives in `localStorage`.
  A full analysis pass flagged these — review before this is internet-facing.

---

## Quick reference

```bash
# Manual/local run (needs env vars set, e.g. a local .env):
node scripts/runScheduledSend.js initial            # send initial batch
node scripts/runScheduledSend.js followup1          # send follow-up 1
node scripts/runScheduledSend.js inactive           # run the 10-day inactive sweep
node scripts/runScheduledSend.js initial --dry-run  # report eligible count, send nothing
node scripts/runScheduledSend.js initial --count=5  # override batch size
```
