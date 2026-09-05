# Teachers Appraisal Form — DPS Vadodara

A small web app for running a teacher appraisal cycle:

There are three separate logins — **teacher**, **principal**, and **admin**
— each with its own password, and none can act as another:

1. Each **teacher** registers her own account (name, department, section,
   year of joining, optional email, password) and then **grades herself**
   against the school's appraisal questions (1–5 scale, minimum 30
   questions).
2. The **principal** logs in separately and rates every teacher on the exact
   same questions, seeing the teacher's own self-score next to each question
   as she does. The principal only grades and views results; she cannot
   add/remove teachers or edit questions.
3. The **admin** manages the teacher roster (add/remove, reset a teacher's
   password) and the appraisal question bank. The admin doesn't grade
   anyone, but can view/export results like the principal can.
4. Once both a teacher's self-grading and the principal's rating are
   submitted, the principal, the admin, and the teacher herself can each
   view a read-only result: name, department, section, self average,
   principal average, and an overall grade (Outstanding / Excellent / Very
   Good / Good / Fair) based on the principal's rating. A button reveals the
   full question-by-question comparison, and results can be downloaded as an
   official appraisal form **PDF**, or exported as **CSV** / a full **Excel
   workbook**.

All data (teachers, ratings, questions, passwords) lives in a real Postgres
database (via [Neon](https://neon.tech)), not a local file — that's what
lets this run on **Vercel** (or any other host) instead of only ever
working on one particular computer. It does mean an internet connection is
required, unlike the very first version of this app.

## Running it

There are two ways to run this: deployed on Vercel (recommended — that's
what it's built for), or on your own machine for local development.

### Deploying to Vercel

1. **Get a Postgres database.** In your Vercel project dashboard, go to
   **Storage → Create Database → Neon** (or add "Neon" from the Vercel
   Marketplace). This automatically sets a `DATABASE_URL` environment
   variable on your project — no separate account needed.
2. **Set `SESSION_SECRET`.** In Project Settings → Environment Variables,
   add `SESSION_SECRET` with a long random value, e.g. generate one with:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   This signs login session cookies. Without it the app refuses to start.
3. *(Optional)* **Set SMTP variables** if you want real password-reset
   emails — see [Password reset email](#password-reset-email-otp---smtp-is-optional)
   below. Without them, reset codes are written to the Vercel function logs
   instead of emailed.
4. **Deploy.** Push this repo to GitHub and import it in Vercel ("Add New…
   → Project"), or run `vercel` from the project folder if you have the
   Vercel CLI installed and are logged in. Vercel detects `api/index.js`
   automatically.
5. **If you have existing data** in `data/db.json` from an older,
   local-only version of this app, migrate it into the new database once,
   from your own machine, *before* pointing the live site at it:
   ```
   $env:DATABASE_URL = "<the same connection string Vercel is using>"
   node scripts/migrate-json-to-postgres.js
   ```
   This preserves every teacher account, password, and submitted rating
   exactly as it was.

### Running locally for development

Requires [Node.js](https://nodejs.org) (v18+) and a Postgres connection
string (a free [Neon](https://neon.tech) project works well, or reuse the
one from your Vercel project via `vercel env pull .env`).

```
cd "E:\Teachers software"
npm install
cp .env.example .env
```

Fill in `.env` with your `DATABASE_URL` and a `SESSION_SECRET` (see
`.env.example` for how to generate one), then:

```
npm start
```

You'll see `Teacher Appraisal System running at http://localhost:3000`.
The first request against a fresh database creates all tables and seeds:
default principal password `principal123`, default admin password
`admin123`, and the default 30-question bank.

- **From another computer on the same network:** find this computer's local
  IP (`ipconfig` → "IPv4 Address"), then browse to
  `http://<that-ip>:3000` from the other device. Windows may ask to allow
  Node.js through the firewall for private networks the first time.

## Using it

- **Admin:** from the link at the bottom of the home page, log in with the
  default password `admin123` (change it right away from the dashboard's
  "Admin account" section). From here you can add/remove teachers, reset a
  teacher's password directly, manage the appraisal questions, and reset
  the principal's password if she's locked out.
- **Principal:** log in with the default password `principal123` (change it
  right away from the dashboard's "Principal account" section). The
  principal dashboard is grading-focused: a read-only teacher list, "Rate
  teacher," "Compare," and exports — no teacher/question management.
- **Teacher — first time:** from the home page, choose "I'm a Teacher" →
  "Register for an account." She provides her name, department, section
  (Primary / Pre-Primary / Secondary), year of joining, an optional email
  (needed only for password reset), and a password. This creates her
  account and takes her to her dashboard.
- **Teacher — after that:** logs in with her name and password, then clicks
  **Grade Yourself** to answer every appraisal question and submit.
- **Forgot password:** "Reset it" on the teacher login page sends a one-time
  code to her registered email (see the SMTP note below). She enters the
  code plus a new password. Alternatively, the admin can set her password
  directly from the Admin dashboard, no email required.
- The admin can also pre-add a teacher (name/department/section); she then
  "claims" that record by registering with the same name, which sets her
  password without losing any history.
- **Principal rates each teacher** from "Rate teacher" next to their name on
  the principal dashboard — her self-score for each question shows up next
  to it once she's submitted her self-appraisal.
- Once **both** are submitted for a teacher, a "Compare" (or "View result")
  link appears — for the principal, the admin, and the teacher herself. That
  page shows the read-only result (name, department, section, self/
  principal averages, overall grade), a button to reveal the full
  question-by-question breakdown, and a PDF download of the official
  appraisal form.
- From the principal or admin dashboard, results can be downloaded as:
  - **Excel (.xlsx)** — one workbook with a Summary sheet (every teacher's
    averages, grade, and gap) plus one detail sheet per teacher.
  - **CSV — full detail** — every teacher, every question, self vs.
    principal score, in one file.
  - **CSV — summary** — one row per teacher with overall averages and grade.
  - From an individual teacher's result page, a single-teacher CSV and a
    PDF appraisal form are also available.

## Appraisal questions (admin-editable)

The admin dashboard has a **question manager**: add, edit, or delete
questions and their category directly from the browser — no code changes
needed. The app enforces a minimum of 30 questions at all times, so a
question can't be deleted while exactly 30 remain (add a replacement
first). `data/questions.js` is only the *seed* list used to populate a
brand-new, empty database; editing that file has no effect on a database
that's already been seeded.

## Password reset email (OTP) — SMTP is optional

Password reset uses a one-time code sent to the teacher's registered email.
To send real emails, set these environment variables (in Vercel's Project
Settings, or in your local `.env`) — e.g. a Gmail account with an
[app password](https://myaccount.google.com/apppasswords):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your-school-account@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=your-school-account@gmail.com
```

If these aren't set, the reset code is printed to the server's console (or
the Vercel function logs) instead of emailed, and the admin can relay it to
the teacher directly — or just set her password from the Admin dashboard
instead.

## Where the data lives

Everything (teachers, self-ratings, principal ratings, questions, principal
and admin passwords) is stored in your Postgres/Neon database. The schema
is created automatically the first time the app runs against a fresh
database — there's no separate migration step to run.

- **Back it up** using your database provider's own backup/export tools
  (Neon supports point-in-time restore on its free tier).
- To wipe all data and start over, drop all the tables (`config`,
  `questions`, `teachers`, `self_ratings`, `principal_ratings`,
  `password_resets`) — the app recreates and reseeds them on the next
  request.

## Notes on security & scope

- Teacher, principal, and admin accounts each use a password
  (scrypt-hashed, salted), and each role's login only ever checks that
  role's credentials — there's no way to cross into another role. The
  principal and admin roles are deliberately separate: the principal grades
  teachers but can't add/remove them or edit questions; the admin manages
  the roster and questions but doesn't grade anyone.
- Login sessions are stateless, HMAC-signed cookies (no server-side session
  store) so they work correctly across Vercel's independent serverless
  instances. Keep `SESSION_SECRET` private — anyone with it could forge a
  session cookie.
- `npm install` will report one known **high-severity advisory in the
  `xlsx` package** (SheetJS) — it concerns *parsing* untrusted spreadsheet
  files. This app only *writes* Excel files from data already inside your
  own database; it never opens/parses `.xlsx` files uploaded by anyone, so
  that advisory doesn't apply to how the app is used here.
