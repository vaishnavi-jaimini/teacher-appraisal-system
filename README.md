# Teachers Appraisal Form — DPS Vadodara

A small local web app for running a teacher appraisal cycle:

There are three separate logins — **teacher**, **principal**, and **admin**
— each with its own password, and none can act as another:

1. Each **teacher** registers her own account (name, department, section,
   year of joining, optional email, password) and then **grades herself**
   against the school's appraisal questions (1–5 scale, minimum 30
   questions).
2. The **principal** logs in separately and rates every teacher on the exact
   same questions — independently, without seeing the teacher's self-scores.
   The principal only grades and views results; she cannot add/remove
   teachers or edit questions.
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

It runs as one small server on a single computer (e.g. the office PC), and
everyone else — teachers and the principal — connects to it from their own
computer's browser over the school Wi-Fi/network. No internet connection or
cloud account is required for day-to-day use (see the note on email/OTP
below).

## 1. First-time setup

Requires [Node.js](https://nodejs.org) (v18+) installed on the computer that
will host the app.

```
cd "E:\Teachers software"
npm install
```

## 2. Start the server

```
npm start
```

You'll see:

```
Teacher Appraisal System running at http://localhost:3000
Default principal password: principal123 (change it from the Principal dashboard)
```

The default **admin** password is `admin123` (change it from the Admin
dashboard — link is at the bottom of the home page).

Leave this window open — the server needs to keep running while people are
using the app. To stop it, press `Ctrl+C` in that window.

## 3. Access it

- **On the hosting computer:** open `http://localhost:3000`
- **From another computer on the same network** (teachers, principal):
  1. On the hosting computer, find its local IP address — open Command
     Prompt and run `ipconfig`, then look for "IPv4 Address" (e.g.
     `192.168.1.42`).
  2. On the other computer's browser, go to `http://192.168.1.42:3000`.
  3. The first time, Windows may ask to allow Node.js through the firewall
     for **private networks** — allow it, or nobody else on the network will
     be able to connect.

## 4. Using it

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
  the principal dashboard. Self-scores are hidden until the principal
  submits her own rating, so the two stay independent.
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

## 5. Appraisal questions (admin-editable)

The admin dashboard has a **question manager**: add, edit, or delete
questions and their category directly from the browser — no code changes
needed. The app enforces a minimum of 30 questions at all times, so a
question can't be deleted while exactly 30 remain (add a replacement
first). `data/questions.js` is only the *seed* list used to populate
`data/db.json` the first time the app runs; editing that file afterward has
no effect on an existing database.

## 6. Password reset email (OTP) — SMTP is optional

Password reset uses a one-time code sent to the teacher's registered email.
To send real emails, set these environment variables before `npm start`
(e.g. a Gmail account with an
[app password](https://myaccount.google.com/apppasswords)):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your-school-account@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=your-school-account@gmail.com
```

If these aren't set, the app stays fully usable offline: the reset code is
printed to the server's console window instead of emailed, and the
principal (who's running the server) can relay it to the teacher directly.

## 7. Where the data lives

Everything (teachers, self-ratings, principal ratings, questions, principal
and admin passwords) is stored in `data/db.json`, created automatically on
first run.

- **Back it up** periodically (just copy the file) — there's no separate
  database to manage.
- To wipe all data and start over, close the server and delete
  `data/db.json`; a fresh one (with the default principal/admin passwords
  and default question bank) is created next time you run `npm start`.

## Notes on security & scope

This is built for **internal, trusted use on a school's own network** — not
for exposing to the public internet:

- Teacher, principal, and admin accounts each use a password
  (scrypt-hashed, salted), and each role's login only ever checks that
  role's credentials — there's no way to cross into another role. The
  principal and admin roles are deliberately separate: the principal grades
  teachers but can't add/remove them or edit questions; the admin manages
  the roster and questions but doesn't grade anyone.
- `npm install` will report one known **high-severity advisory in the
  `xlsx` package** (SheetJS) — it concerns *parsing* untrusted spreadsheet
  files. This app only *writes* Excel files from data already inside your
  own database; it never opens/parses `.xlsx` files uploaded by anyone, so
  that advisory doesn't apply to how the app is used here.
