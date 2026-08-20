// Very small file-backed JSON data store. No external database needed -
// everything lives in data/db.json so the whole app can run with a single
// `npm install` and no separate DB server to set up.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = path.join(__dirname, "db.json");

function hashSecret(secret, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(secret), useSalt, 64).toString("hex");
  return { hash, salt: useSalt };
}

function verifySecret(secret, hash, salt) {
  const check = crypto.scryptSync(String(secret), salt, 64).toString("hex");
  // timing-safe compare
  const a = Buffer.from(check, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function defaultDb() {
  const principal = hashSecret("principal123");
  return {
    config: {
      principalPasswordHash: principal.hash,
      principalPasswordSalt: principal.salt,
      schoolName: "My School"
    },
    teachers: [], // { id, name, subject, pinHash, pinSalt, createdAt }
    selfRatings: {}, // teacherId -> { ratings: [30 ints], comments, submittedAt }
    principalRatings: {} // teacherId -> { ratings: [30 ints], comments, submittedAt }
  };
}

let db = null;

function load() {
  if (db) return db;
  if (fs.existsSync(DB_PATH)) {
    db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
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

module.exports = { load, save, hashSecret, verifySecret, DB_PATH };
