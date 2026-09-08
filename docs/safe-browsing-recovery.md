# "Dangerous site" warning — what it is and how to clear it

Chrome / Edge / Firefox showed a red **"Dangerous site"** / **"Deceptive site
ahead"** page for the production URL:

    https://teacher-appraisal-system-vaish-5764.vercel.app

That warning comes from **Google Safe Browsing**, not from Vercel and not from
the app itself.

## Why it was flagged

The public URL looks like a phishing page to an automated classifier:

- it has **login forms that collect passwords** (teacher / principal / admin);
- it is **branded with a real organisation** ("Delhi Public School, Vadodara"
  plus the school crest);
- it is served from a **generic shared host** (`*.vercel.app`) rather than the
  school's own domain;
- `*.vercel.app` has been heavily abused for credential-phishing campaigns
  through 2025–2026, so Google flags subdomains on it aggressively.

A school-branded login on `vercel.app` is, to a crawler, indistinguishable from
a page impersonating that school to steal staff logins.

## The real fix: use a custom domain

Safe Browsing reputation is largely per-host, and `vercel.app` is a poisoned
well — flags there recur. Move the site to a domain the school controls:

1. Ideally a subdomain of the school's real domain, e.g.
   `appraisal.<school-domain>`.
2. Vercel → project **teacher-appraisal-system** → **Settings → Domains** → add
   the domain, then create the CNAME / A record it shows you at the registrar.
3. Once it resolves, make it the **Production** domain.

A custom domain both clears the shared-reputation problem and stops the page
looking like impersonation.

## Getting the existing flag removed (Google Search Console)

Do this regardless of the domain move — it delists the current URL.

1. Go to <https://search.google.com/search-console> and **add a property** for
   the site (URL-prefix property for the full `https://…vercel.app` URL, or the
   custom domain once it's live).
2. **Verify ownership.** For a `vercel.app` URL the only methods that work are
   *HTML file upload* or *HTML meta tag* (you don't control `vercel.app` DNS):
   - **HTML tag:** copy the `<meta name="google-site-verification" …>` tag
     Search Console gives you into the `<head>` of `public/index.html`, then
     redeploy (`npx vercel deploy --prod`).
   - **HTML file:** save the `googlexxxx.html` file Search Console gives you
     into `public/`, then redeploy. It will be served at the site root.
3. After verification: **Security & Manual Actions → Security Issues**. If a
   "Deceptive pages" / "Social engineering" issue is listed, fix the flagged
   URLs (the domain move handles this) and click **Request Review**. Explain
   that this is a private internal HR tool for one school, not a public site.
4. Turnaround is usually 1–3 days. The warning clears automatically once Google
   re-crawls and the review passes.

## Alternative: don't host it publicly at all

The app's own footer says *"Runs locally on the school network — no internet
connection required."* It was built for a LAN. If teachers don't need
off-site access, running it on a machine on the school network (`node
server.js` behind the school's own network, pointed at the Neon database or a
local Postgres) sidesteps Safe Browsing entirely and keeps sensitive appraisal
data off the public internet.

## Hardening already applied in the repo

- `public/robots.txt` — disallows all crawlers.
- `vercel.json` — sends `X-Robots-Tag: noindex`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, a `Referrer-Policy`, and a
  `Permissions-Policy` on every response.

These reduce the phishing signal but do **not** by themselves clear an existing
flag — the Search Console review is what does that.
