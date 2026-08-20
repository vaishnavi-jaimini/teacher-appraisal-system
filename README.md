# Teacher Appraisal System

A small local web app for running a teacher appraisal cycle:

1. Each **teacher** logs in and rates themselves on 30 standard appraisal
   questions (1–5 scale).
2. The **principal** logs in and rates every teacher on the exact same 30
   questions — independently, without seeing the teacher's self-scores.
3. Once both are submitted, the principal (and the teacher, for their own
   record) can view a side-by-side comparison, and the principal can
   download the results as **CSV** or a full **Excel workbook**.

It runs as one small server on a single computer (e.g. the office PC), and
everyone else — teachers and the principal — connects to it from their own
computer's browser over the school Wi-Fi/network. No internet connection or
cloud account is required.

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

- **Principal:** log in with the default password `principal123` (change it
  right away from the dashboard's "Principal account" section). Add each
  teacher by name — the app generates a random 4-digit PIN for them; write
  it down and hand it to the teacher (it's only shown once, but can be reset
  any time from the dashboard).
- **Teacher:** goes to the site, chooses "I'm a Teacher," picks their name,
  enters the PIN given by the principal, and answers the 30 questions. They
  can revisit and update their answers any time before comparison.
- **Principal rates each teacher** the same way, from "Rate teacher" next to
  their name on the dashboard.
- Once **both** are submitted for a teacher, a "Compare" link appears. That
  page shows a self-vs-principal chart, the full 30-question breakdown, and
  a gap (principal − self) for each question.
- From the dashboard, the principal can download:
  - **Excel (.xlsx)** — one workbook with a Summary sheet (every teacher's
    averages and gap) plus one detail sheet per teacher.
  - **CSV — full detail** — every teacher, every question, self vs.
    principal score, in one file.
  - **CSV — summary** — one row per teacher with overall averages and gap.
  - From an individual teacher's comparison page, a single-teacher CSV is
    also available.

## 5. The 30 questions

Grouped into 8 categories: Lesson Planning & Preparation, Subject Knowledge
& Instructional Delivery, Classroom Management, Student Engagement &
Support, Assessment & Feedback, Communication & Collaboration, Professional
Growth & Conduct, and Use of Technology & Innovation. See
`data/questions.js` to edit question wording — **use exactly 30 entries**,
since ratings are stored as a fixed-length array matched by question index.
If you change the number of questions, existing saved ratings for that
count will no longer align, so do this before the appraisal cycle starts.

## 6. Where the data lives

Everything (teachers, PINs, self-ratings, principal ratings, principal
password) is stored in `data/db.json`, created automatically on first run.

- **Back it up** periodically (just copy the file) — there's no separate
  database to manage.
- To wipe all data and start over, close the server and delete
  `data/db.json`; a fresh one (with the default principal password) is
  created next time you run `npm start`.

## Notes on security & scope

This is built for **internal, trusted use on a school's own network** — not
for exposing to the public internet:

- Teacher accounts use a simple 4-digit PIN, and the principal account uses
  a single shared password. That's adequate for a small internal tool, not
  for anything internet-facing.
- `npm install` will report one known **high-severity advisory in the
  `xlsx` package** (SheetJS) — it concerns *parsing* untrusted spreadsheet
  files. This app only *writes* Excel files from data already inside your
  own database; it never opens/parses `.xlsx` files uploaded by anyone, so
  that advisory doesn't apply to how the app is used here.
