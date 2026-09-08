# Deploying to Render (free)

We moved off `*.vercel.app` because Google Safe Browsing flags school-branded
login pages on that shared host as phishing. Render's `*.onrender.com` host is
not targeted that way, so the site loads with no warning — and it stays free.

The app is a plain Express server (`node server.js`) that talks to the existing
Neon Postgres database over a connection string, so nothing about the data
changes — only where the web server runs.

## One-time setup

1. Sign in at <https://dashboard.render.com> (GitHub login is easiest — the repo
   is already at `github.com/vaishnavi-jaimini/teacher-appraisal-system`).
2. **New → Blueprint**, pick that repo. Render reads `render.yaml` and proposes
   a free web service.
3. When prompted for **`DATABASE_URL`**, paste the Neon *pooled* connection
   string (from `.env.local`, the `DATABASE_URL` line, or the Neon dashboard).
   `SESSION_SECRET` is generated automatically; leave it.
4. **Apply**. First build takes ~2–3 minutes.
5. The site is live at `https://teacher-appraisal-system.onrender.com` (Render
   appends a suffix if the name is taken — the exact URL is shown on the
   service page).

After this, every push to `main` redeploys automatically (`autoDeploy: true`).

## Free-tier tradeoff

A free Render service **sleeps after 15 minutes of inactivity**; the next visit
waits ~50 seconds while it wakes, then it's fast again. Fine for an appraisal
tool used in bursts. To remove the delay: upgrade that service to Render's
Starter plan (~$7/mo), or keep the free plan and ping the URL on a schedule
(e.g. an UptimeRobot monitor hitting `/` every 10 minutes).

Always-on free alternative: **Koyeb** (<https://www.koyeb.com>) — one free
service that doesn't sleep. Same idea: connect the repo, set `DATABASE_URL` and
`SESSION_SECRET`, run `node server.js`.

## Optional: password-reset emails

Without SMTP, reset codes (OTPs) are printed to the Render service logs — open
the service → **Logs**, read the code, relay it to the teacher. To send real
emails instead, add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (and
optionally `SMTP_FROM`) in the service's **Environment** tab.

## Decommissioning Vercel (optional)

Once Render is verified working, the Vercel project can be deleted or left
idle. If you keep it, disable it or the two deployments will diverge. The Neon
database is independent of both.
