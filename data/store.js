// Very small file-backed JSON data store. No external database needed -
// everything lives in data/db.json so the whole app can run with a single
// `npm install` and no separate DB server to set up.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { DEFAULT_QUESTIONS, RATING_SCALE } = require("./questions");

const DB_PATH = path.join(__dirname, "db.json");

const SECTIONS = ["Primary", "Pre-Primary", "Secondary"];
const MIN_QUESTIONS = 30;

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

function defaultDb() {
  const principal = hashSecret("principal123");
  const admin = hashSecret("admin123");
  return {
    config: {
      principalPasswordHash: principal.hash,
      principalPasswordSalt: principal.salt,
      adminPasswordHash: admin.hash,
      adminPasswordSalt: admin.salt,
      schoolName: "Delhi Public School, Vadodara"
    },
    questions: DEFAULT_QUESTIONS.map(q => ({ ...q })),
    nextQuestionId: DEFAULT_QUESTIONS.length + 1,
    teachers: [], // { id, name, department, section, email, yearOfJoining, passwordHash, passwordSalt, createdAt }
    selfRatings: {}, // teacherId -> { ratings: { [questionId]: 1-5 }, comments, submittedAt }
    principalRatings: {}, // teacherId -> { ratings: { [questionId]: 1-5 }, comments, submittedAt }
    passwordResets: {} // teacherId -> { otpHash, otpSalt, expires }
  };
}

// Turns a legacy array-of-30-ints rating (matched by position) into the
// current { [questionId]: value } shape, using the seed question order.
function migrateRatingsShape(ratings) {
  if (!ratings) return ratings;
  if (Array.isArray(ratings)) {
    const out = {};
    ratings.forEach((v, i) => {
      const q = DEFAULT_QUESTIONS[i];
      if (q && v != null) out[q.id] = v;
    });
    return out;
  }
  return ratings;
}

// Brings an older db.json (name-only or PIN-based teacher identification,
// array-based ratings, no admin-editable question bank) up to the current
// shape without discarding any existing appraisal data.
function migrate(raw) {
  if (!raw.questions || !raw.questions.length) {
    raw.questions = DEFAULT_QUESTIONS.map(q => ({ ...q }));
  }
  if (!raw.nextQuestionId) {
    raw.nextQuestionId = Math.max(0, ...raw.questions.map(q => q.id)) + 1;
  }

  raw.teachers = (raw.teachers || []).map(t => ({
    id: t.id,
    name: t.name,
    department: t.department || t.subject || "",
    section: SECTIONS.includes(t.section) ? t.section : "",
    email: t.email || "",
    yearOfJoining: t.yearOfJoining || null,
    passwordHash: t.passwordHash || null,
    passwordSalt: t.passwordSalt || null,
    createdAt: t.createdAt || new Date().toISOString()
  }));

  raw.selfRatings = raw.selfRatings || {};
  raw.principalRatings = raw.principalRatings || {};
  Object.keys(raw.selfRatings).forEach(id => {
    raw.selfRatings[id].ratings = migrateRatingsShape(raw.selfRatings[id].ratings);
  });
  Object.keys(raw.principalRatings).forEach(id => {
    raw.principalRatings[id].ratings = migrateRatingsShape(raw.principalRatings[id].ratings);
  });

  raw.passwordResets = raw.passwordResets || {};
  raw.config = raw.config || {};
  if (!raw.config.schoolName || raw.config.schoolName === "My School") {
    raw.config.schoolName = "Delhi Public School, Vadodara";
  }
  if (!raw.config.adminPasswordHash) {
    const admin = hashSecret("admin123");
    raw.config.adminPasswordHash = admin.hash;
    raw.config.adminPasswordSalt = admin.salt;
  }

  return raw;
}

let db = null;

function load() {
  if (db) return db;
  if (fs.existsSync(DB_PATH)) {
    db = migrate(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
    save();
  } else {
    db = defaultDb();
    save();
    console.log("Created new data/db.json with default principal password: principal123");
  }
  return db;
}

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

module.exports = {
  load, save, hashSecret, verifySecret, DB_PATH,
  SECTIONS, MIN_QUESTIONS, RATING_SCALE
};
