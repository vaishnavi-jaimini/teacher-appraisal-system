// One-time migration: copies the existing data/db.json (the old file-based
// store) into Postgres. Run this once, locally, with DATABASE_URL pointed
// at your new database, before switching the deployed app over. It
// preserves teacher accounts, passwords, questions, and every submitted
// rating exactly as they are (same ids, same timestamps) — nothing is
// regenerated. Password-reset OTPs are intentionally not migrated; they're
// short-lived and any in progress will have expired anyway.
//
// Usage (PowerShell):
//   $env:DATABASE_URL = "postgres://...neon connection string..."
//   node scripts/migrate-json-to-postgres.js

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless");

const DB_JSON_PATH = path.join(__dirname, "..", "data", "db.json");
const SECTIONS = ["Primary", "Pre-Primary", "Secondary"];

function normalizeRatings(ratings) {
  if (Array.isArray(ratings)) {
    const out = {};
    ratings.forEach((v, i) => { if (v != null) out[i + 1] = v; });
    return out;
  }
  return ratings;
}

async function main() {
  if (!fs.existsSync(DB_JSON_PATH)) {
    console.log("No data/db.json found — nothing to migrate.");
    return;
  }
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
  if (!connectionString) {
    console.error("Set DATABASE_URL to your Postgres connection string first.");
    process.exit(1);
  }

  // Creates tables (idempotent) and seeds defaults before we overwrite them.
  const store = require("../data/store");
  await store.init();

  const sql = neon(connectionString, { fullResults: true });
  const raw = JSON.parse(fs.readFileSync(DB_JSON_PATH, "utf8"));

  if (raw.config) {
    await sql`
      UPDATE config SET
        school_name = ${raw.config.schoolName || "Delhi Public School, Vadodara"},
        principal_password_hash = ${raw.config.principalPasswordHash},
        principal_password_salt = ${raw.config.principalPasswordSalt},
        admin_password_hash = ${raw.config.adminPasswordHash || null},
        admin_password_salt = ${raw.config.adminPasswordSalt || null}
    `;
    console.log("Migrated config.");
  }

  if (Array.isArray(raw.questions) && raw.questions.length) {
    await sql`DELETE FROM questions`;
    for (const q of raw.questions) {
      await sql`INSERT INTO questions (id, category, text) VALUES (${q.id}, ${q.category}, ${q.text})`;
    }
    console.log(`Migrated ${raw.questions.length} questions.`);
  }

  for (const t of raw.teachers || []) {
    const department = t.department || t.subject || "";
    const section = SECTIONS.includes(t.section) ? t.section : "";
    await sql`
      INSERT INTO teachers (id, name, department, section, email, year_of_joining, password_hash, password_salt, created_at)
      VALUES (${t.id}, ${t.name}, ${department}, ${section}, ${t.email || ""}, ${t.yearOfJoining || null}, ${t.passwordHash || null}, ${t.passwordSalt || null}, ${t.createdAt || new Date().toISOString()})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, department = EXCLUDED.department, section = EXCLUDED.section,
        email = EXCLUDED.email, year_of_joining = EXCLUDED.year_of_joining,
        password_hash = EXCLUDED.password_hash, password_salt = EXCLUDED.password_salt
    `;
  }
  console.log(`Migrated ${(raw.teachers || []).length} teachers.`);

  for (const [teacherId, r] of Object.entries(raw.selfRatings || {})) {
    await sql`
      INSERT INTO self_ratings (teacher_id, ratings, comments, submitted_at)
      VALUES (${teacherId}, ${JSON.stringify(normalizeRatings(r.ratings))}::jsonb, ${r.comments || ""}, ${r.submittedAt})
      ON CONFLICT (teacher_id) DO UPDATE SET ratings = EXCLUDED.ratings, comments = EXCLUDED.comments, submitted_at = EXCLUDED.submitted_at
    `;
  }
  console.log(`Migrated ${Object.keys(raw.selfRatings || {}).length} self-ratings.`);

  for (const [teacherId, r] of Object.entries(raw.principalRatings || {})) {
    await sql`
      INSERT INTO principal_ratings (teacher_id, ratings, comments, submitted_at)
      VALUES (${teacherId}, ${JSON.stringify(normalizeRatings(r.ratings))}::jsonb, ${r.comments || ""}, ${r.submittedAt})
      ON CONFLICT (teacher_id) DO UPDATE SET ratings = EXCLUDED.ratings, comments = EXCLUDED.comments, submitted_at = EXCLUDED.submitted_at
    `;
  }
  console.log(`Migrated ${Object.keys(raw.principalRatings || {}).length} principal ratings.`);

  console.log("Done. Verify with the app, then you can archive/delete data/db.json.");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
