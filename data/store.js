// Postgres-backed data store (via Neon's serverless driver — the storage
// backing Vercel's own Postgres marketplace integration). Replaces the old
// file-based data/db.json store, because a serverless deployment (Vercel)
// has no persistent local disk and no shared in-memory state between
// invocations — everything durable has to live in a real database instead.
//
// Requires DATABASE_URL (or POSTGRES_URL / POSTGRES_URL_NON_POOLING) to be
// set — e.g. by adding the Neon integration from the Vercel Marketplace in
// the project dashboard, or by pointing at any Postgres-compatible Neon
// endpoint for local dev.

const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { DEFAULT_QUESTIONS, RATING_SCALE } = require("./questions");

const SECTIONS = ["Primary", "Pre-Primary", "Secondary"];
const MIN_QUESTIONS = 30;

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
if (!CONNECTION_STRING) {
  throw new Error(
    "DATABASE_URL is not set. This app stores all data in Postgres — add the " +
    "Neon integration from the Vercel Marketplace (or set DATABASE_URL to any " +
    "Neon/Postgres connection string) before starting the server."
  );
}
// fullResults keeps the { rows: [...] } shape used throughout this file,
// matching the node-postgres-style result object.
const sql = neon(CONNECTION_STRING, { fullResults: true });

function hashSecret(secret, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(secret), useSalt, 64).toString("hex");
  return { hash, salt: useSalt };
}

function verifySecret(secret, hash, salt) {
  if (!hash || !salt) return false;
  const check = crypto.scryptSync(String(secret), salt, 64).toString("hex");
  const a = Buffer.from(check, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Schema setup + default seed data. Runs once per warm serverless instance
// (guarded by initPromise) and is safe to run redundantly across instances
// since every statement is idempotent (IF NOT EXISTS / conditional seed).
// ---------------------------------------------------------------------------
let initPromise = null;
function init() {
  if (!initPromise) initPromise = migrate();
  return initPromise;
}

async function migrate() {
  await sql`CREATE TABLE IF NOT EXISTS config (
    id serial PRIMARY KEY,
    school_name text NOT NULL,
    principal_password_hash text NOT NULL,
    principal_password_salt text NOT NULL,
    admin_password_hash text NOT NULL,
    admin_password_salt text NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS questions (
    id integer PRIMARY KEY,
    category text NOT NULL,
    text text NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS teachers (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    department text NOT NULL DEFAULT '',
    section text NOT NULL DEFAULT '',
    email text NOT NULL DEFAULT '',
    year_of_joining integer,
    password_hash text,
    password_salt text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS self_ratings (
    teacher_id uuid PRIMARY KEY REFERENCES teachers(id) ON DELETE CASCADE,
    ratings jsonb NOT NULL,
    comments text NOT NULL DEFAULT '',
    submitted_at timestamptz NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS principal_ratings (
    teacher_id uuid PRIMARY KEY REFERENCES teachers(id) ON DELETE CASCADE,
    ratings jsonb NOT NULL,
    comments text NOT NULL DEFAULT '',
    submitted_at timestamptz NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS password_resets (
    teacher_id uuid PRIMARY KEY REFERENCES teachers(id) ON DELETE CASCADE,
    otp_hash text NOT NULL,
    otp_salt text NOT NULL,
    expires timestamptz NOT NULL
  )`;

  const { rows: configRows } = await sql`SELECT id FROM config LIMIT 1`;
  if (configRows.length === 0) {
    const principal = hashSecret("principal123");
    const admin = hashSecret("admin123");
    await sql`
      INSERT INTO config (school_name, principal_password_hash, principal_password_salt, admin_password_hash, admin_password_salt)
      VALUES ('Delhi Public School, Vadodara', ${principal.hash}, ${principal.salt}, ${admin.hash}, ${admin.salt})
    `;
  }

  const { rows: qRows } = await sql`SELECT count(*)::int AS c FROM questions`;
  if (qRows[0].c === 0) {
    for (const q of DEFAULT_QUESTIONS) {
      await sql`INSERT INTO questions (id, category, text) VALUES (${q.id}, ${q.category}, ${q.text})`;
    }
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
async function getConfig() {
  const { rows } = await sql`
    SELECT school_name, principal_password_hash, principal_password_salt, admin_password_hash, admin_password_salt
    FROM config LIMIT 1
  `;
  const c = rows[0];
  return {
    schoolName: c.school_name,
    principalPasswordHash: c.principal_password_hash,
    principalPasswordSalt: c.principal_password_salt,
    adminPasswordHash: c.admin_password_hash,
    adminPasswordSalt: c.admin_password_salt
  };
}

async function setPrincipalPassword(hash, salt) {
  await sql`UPDATE config SET principal_password_hash = ${hash}, principal_password_salt = ${salt}`;
}

async function setAdminPassword(hash, salt) {
  await sql`UPDATE config SET admin_password_hash = ${hash}, admin_password_salt = ${salt}`;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------
function rowToQuestion(r) {
  return { id: r.id, category: r.category, text: r.text };
}

async function listQuestions() {
  const { rows } = await sql`SELECT id, category, text FROM questions ORDER BY id`;
  return rows.map(rowToQuestion);
}

async function addQuestion(category, text) {
  const { rows: idRows } = await sql`SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM questions`;
  const id = idRows[0].next_id;
  await sql`INSERT INTO questions (id, category, text) VALUES (${id}, ${category}, ${text})`;
  return { id, category, text };
}

async function updateQuestion(id, { category, text }) {
  if (category !== undefined) await sql`UPDATE questions SET category = ${category} WHERE id = ${id}`;
  if (text !== undefined) await sql`UPDATE questions SET text = ${text} WHERE id = ${id}`;
  const { rows } = await sql`SELECT id, category, text FROM questions WHERE id = ${id}`;
  return rows[0] ? rowToQuestion(rows[0]) : null;
}

async function deleteQuestion(id) {
  await sql`DELETE FROM questions WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Teachers
// ---------------------------------------------------------------------------
function rowToTeacher(r) {
  return {
    id: r.id,
    name: r.name,
    department: r.department || "",
    section: r.section || "",
    email: r.email || "",
    yearOfJoining: r.year_of_joining,
    passwordHash: r.password_hash,
    passwordSalt: r.password_salt,
    createdAt: r.created_at
  };
}

async function listTeachers() {
  const { rows } = await sql`SELECT * FROM teachers ORDER BY name`;
  return rows.map(rowToTeacher);
}

async function getTeacherById(id) {
  const { rows } = await sql`SELECT * FROM teachers WHERE id = ${id}`;
  return rows[0] ? rowToTeacher(rows[0]) : null;
}

async function getTeacherByName(name) {
  const { rows } = await sql`SELECT * FROM teachers WHERE lower(trim(name)) = lower(trim(${name}))`;
  return rows[0] ? rowToTeacher(rows[0]) : null;
}

async function getTeacherByEmail(email) {
  const { rows } = await sql`
    SELECT * FROM teachers WHERE email <> '' AND lower(trim(email)) = lower(trim(${email}))
  `;
  return rows[0] ? rowToTeacher(rows[0]) : null;
}

async function createTeacher(t) {
  const { rows } = await sql`
    INSERT INTO teachers (id, name, department, section, email, year_of_joining, password_hash, password_salt)
    VALUES (${t.id}, ${t.name}, ${t.department || ""}, ${t.section || ""}, ${t.email || ""}, ${t.yearOfJoining ?? null}, ${t.passwordHash ?? null}, ${t.passwordSalt ?? null})
    RETURNING *
  `;
  return rowToTeacher(rows[0]);
}

// `fields` may include any of: name, department, section, email,
// yearOfJoining, passwordHash, passwordSalt. Missing keys are left as-is.
async function updateTeacher(id, fields) {
  const existing = await getTeacherById(id);
  if (!existing) return null;
  const merged = { ...existing, ...fields };
  const { rows } = await sql`
    UPDATE teachers SET
      name = ${merged.name},
      department = ${merged.department},
      section = ${merged.section},
      email = ${merged.email},
      year_of_joining = ${merged.yearOfJoining ?? null},
      password_hash = ${merged.passwordHash ?? null},
      password_salt = ${merged.passwordSalt ?? null}
    WHERE id = ${id}
    RETURNING *
  `;
  return rowToTeacher(rows[0]);
}

async function deleteTeacher(id) {
  await sql`DELETE FROM teachers WHERE id = ${id}`; // ratings/resets cascade
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------
// jsonb columns should come back already parsed into objects, but this
// guards against a driver/version that instead returns the raw JSON text.
function parseRatings(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function getSelfRating(teacherId) {
  const { rows } = await sql`SELECT ratings, comments, submitted_at FROM self_ratings WHERE teacher_id = ${teacherId}`;
  if (!rows[0]) return null;
  return { ratings: parseRatings(rows[0].ratings), comments: rows[0].comments || "", submittedAt: rows[0].submitted_at };
}

async function setSelfRating(teacherId, ratings, comments) {
  const submittedAt = new Date().toISOString();
  await sql`
    INSERT INTO self_ratings (teacher_id, ratings, comments, submitted_at)
    VALUES (${teacherId}, ${JSON.stringify(ratings)}::jsonb, ${comments || ""}, ${submittedAt})
    ON CONFLICT (teacher_id) DO UPDATE SET ratings = EXCLUDED.ratings, comments = EXCLUDED.comments, submitted_at = EXCLUDED.submitted_at
  `;
  return submittedAt;
}

async function getPrincipalRating(teacherId) {
  const { rows } = await sql`SELECT ratings, comments, submitted_at FROM principal_ratings WHERE teacher_id = ${teacherId}`;
  if (!rows[0]) return null;
  return { ratings: parseRatings(rows[0].ratings), comments: rows[0].comments || "", submittedAt: rows[0].submitted_at };
}

async function setPrincipalRating(teacherId, ratings, comments) {
  const submittedAt = new Date().toISOString();
  await sql`
    INSERT INTO principal_ratings (teacher_id, ratings, comments, submitted_at)
    VALUES (${teacherId}, ${JSON.stringify(ratings)}::jsonb, ${comments || ""}, ${submittedAt})
    ON CONFLICT (teacher_id) DO UPDATE SET ratings = EXCLUDED.ratings, comments = EXCLUDED.comments, submitted_at = EXCLUDED.submitted_at
  `;
  return submittedAt;
}

// ---------------------------------------------------------------------------
// Password reset OTPs
// ---------------------------------------------------------------------------
async function getPasswordReset(teacherId) {
  const { rows } = await sql`SELECT otp_hash, otp_salt, expires FROM password_resets WHERE teacher_id = ${teacherId}`;
  if (!rows[0]) return null;
  return { hash: rows[0].otp_hash, salt: rows[0].otp_salt, expires: new Date(rows[0].expires).getTime() };
}

async function setPasswordReset(teacherId, hash, salt, expiresAtMs) {
  await sql`
    INSERT INTO password_resets (teacher_id, otp_hash, otp_salt, expires)
    VALUES (${teacherId}, ${hash}, ${salt}, to_timestamp(${expiresAtMs}::double precision / 1000))
    ON CONFLICT (teacher_id) DO UPDATE SET otp_hash = EXCLUDED.otp_hash, otp_salt = EXCLUDED.otp_salt, expires = EXCLUDED.expires
  `;
}

async function deletePasswordReset(teacherId) {
  await sql`DELETE FROM password_resets WHERE teacher_id = ${teacherId}`;
}

module.exports = {
  init,
  hashSecret, verifySecret,
  SECTIONS, MIN_QUESTIONS, RATING_SCALE,
  getConfig, setPrincipalPassword, setAdminPassword,
  listQuestions, addQuestion, updateQuestion, deleteQuestion,
  listTeachers, getTeacherById, getTeacherByName, getTeacherByEmail, createTeacher, updateTeacher, deleteTeacher,
  getSelfRating, setSelfRating, getPrincipalRating, setPrincipalRating,
  getPasswordReset, setPasswordReset, deletePasswordReset
};
