require("dotenv").config(); // no-op in production (e.g. Vercel), where env vars are injected directly

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const PDFDocument = require("pdfkit");

const store = require("./data/store");
const mailer = require("./lib/mailer");

if (!process.env.SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET is not set. Sessions are signed, stateless cookies (no " +
    "server-side session store, so this works across serverless instances) " +
    "— set SESSION_SECRET to a long random string before starting the server."
  );
}
const SESSION_SECRET = process.env.SESSION_SECRET;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LOGO_PATH = path.join(__dirname, "public", "images", "dpsv-logo.png");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Runs once per warm serverless instance (memoized inside store.init()).
app.use(ah(async (req, res, next) => {
  await store.init();
  next();
}));

// ---------------------------------------------------------------------------
// Stateless, signed-cookie sessions. There's no server-side session store —
// the cookie itself carries { role, teacherId?, exp }, HMAC-signed with
// SESSION_SECRET — so auth works the same whether one request or two
// requests in the same "session" land on completely different serverless
// instances (which share no memory).
// ---------------------------------------------------------------------------
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach(pair => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function getSession(req) {
  const token = parseCookies(req).session;
  return verifySessionToken(token);
}

function setSessionCookie(req, res, payload) {
  const token = signSession({ ...payload, exp: Date.now() + SESSION_TTL_MS });
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader(
    "Set-Cookie",
    `session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax${secure ? "; Secure" : ""}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
}

function requirePrincipal(req, res, next) {
  const session = getSession(req);
  if (!session || session.role !== "principal") {
    return res.status(401).json({ error: "Principal login required." });
  }
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session || session.role !== "admin") {
    return res.status(401).json({ error: "Admin login required." });
  }
  req.session = session;
  next();
}

function requirePrincipalOrAdmin(req, res, next) {
  const session = getSession(req);
  if (!session || (session.role !== "principal" && session.role !== "admin")) {
    return res.status(401).json({ error: "Principal or admin login required." });
  }
  req.session = session;
  next();
}

const requireTeacher = ah(async (req, res, next) => {
  const session = getSession(req);
  if (!session || session.role !== "teacher") {
    return res.status(401).json({ error: "Teacher login required." });
  }
  const teacher = await store.getTeacherById(session.teacherId);
  if (!teacher) {
    clearSessionCookie(res);
    return res.status(401).json({ error: "This teacher account no longer exists. Please log in again." });
  }
  req.session = session;
  next();
});

// The principal, the admin, or the teacher viewing their own record.
function requirePrincipalOrAdminOrOwnTeacher(paramName) {
  return (req, res, next) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: "Login required." });
    const teacherId = req.params[paramName];
    if (session.role === "principal" || session.role === "admin") {
      req.session = session;
      return next();
    }
    if (session.role === "teacher" && session.teacherId === teacherId) {
      req.session = session;
      return next();
    }
    return res.status(403).json({ error: "Not authorized to view this record." });
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function publicTeacher(t) {
  return {
    id: t.id,
    name: t.name,
    department: t.department || "",
    section: t.section || "",
    email: t.email || "",
    yearOfJoining: t.yearOfJoining || null,
    registered: !!t.passwordHash
  };
}

async function teacherWithStatus(t) {
  const [self, principal] = await Promise.all([store.getSelfRating(t.id), store.getPrincipalRating(t.id)]);
  return {
    ...publicTeacher(t),
    selfDone: !!self,
    principalDone: !!principal,
    selfSubmittedAt: self ? self.submittedAt : null,
    principalSubmittedAt: principal ? principal.submittedAt : null
  };
}

function average(arr) {
  if (!arr || !arr.length) return null;
  const sum = arr.reduce((a, b) => a + b, 0);
  return Math.round((sum / arr.length) * 100) / 100;
}

function validateRatings(ratings, questions) {
  if (!ratings || typeof ratings !== "object" || Array.isArray(ratings)) return false;
  return questions.every(q => {
    const v = ratings[q.id];
    return Number.isInteger(v) && v >= 1 && v <= 5;
  });
}

// Bands are applied to the principal's average score, since the principal's
// assessment is the one that determines the teacher's official grade.
function gradeLabel(avg) {
  if (avg == null) return null;
  if (avg >= 4.5) return "Outstanding";
  if (avg >= 4.0) return "Excellent";
  if (avg >= 3.5) return "Very Good";
  if (avg >= 3.0) return "Good";
  return "Fair";
}

function genOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function categoriesOf(questions) {
  return [...new Set(questions.map(q => q.category))];
}

async function buildComparison(teacher) {
  const [self, principal, questions] = await Promise.all([
    store.getSelfRating(teacher.id),
    store.getPrincipalRating(teacher.id),
    store.listQuestions()
  ]);
  const categories = categoriesOf(questions);

  const rows = questions.map(q => {
    const selfScore = self ? self.ratings[q.id] : null;
    const principalScore = principal ? principal.ratings[q.id] : null;
    return {
      id: q.id,
      category: q.category,
      text: q.text,
      self: selfScore != null ? selfScore : null,
      principal: principalScore != null ? principalScore : null,
      gap: selfScore != null && principalScore != null ? principalScore - selfScore : null
    };
  });

  const categoryAverages = categories.map(cat => {
    const catRows = rows.filter(r => r.category === cat);
    return {
      category: cat,
      self: average(catRows.map(r => r.self).filter(v => v != null)),
      principal: average(catRows.map(r => r.principal).filter(v => v != null))
    };
  });

  const overallSelf = self ? average(rows.map(r => r.self).filter(v => v != null)) : null;
  const overallPrincipal = principal ? average(rows.map(r => r.principal).filter(v => v != null)) : null;

  return {
    teacher: publicTeacher(teacher),
    self: self && { comments: self.comments || "", submittedAt: self.submittedAt },
    principal: principal && { comments: principal.comments || "", submittedAt: principal.submittedAt },
    rows,
    categoryAverages,
    overall: {
      self: overallSelf,
      principal: overallPrincipal,
      gradeLabel: gradeLabel(overallPrincipal)
    }
  };
}

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(rows) {
  return rows.map(row => row.map(csvEscape).join(",")).join("\r\n");
}

function ratingLabel(v) {
  if (v == null) return "";
  const found = store.RATING_SCALE.find(r => r.value === v);
  return found ? found.label : String(v);
}

function safeSheetName(name, used) {
  let base = name.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 28) || "Teacher";
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${n})`.slice(0, 31);
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// ---------------------------------------------------------------------------
// Public / shared routes
// ---------------------------------------------------------------------------
app.get("/api/questions", ah(async (req, res) => {
  const questions = await store.listQuestions();
  res.json({ questions, categories: categoriesOf(questions), scale: store.RATING_SCALE, minQuestions: store.MIN_QUESTIONS });
}));

app.get("/api/session", ah(async (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ role: null });
  if (session.role === "principal") return res.json({ role: "principal" });
  if (session.role === "admin") return res.json({ role: "admin" });
  const teacher = await store.getTeacherById(session.teacherId);
  if (!teacher) return res.json({ role: null });
  res.json({ role: "teacher", teacher: publicTeacher(teacher) });
}));

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Principal auth — principal only grades teachers and views results; she
// cannot add/remove teachers or edit questions (that's the admin's job).
// ---------------------------------------------------------------------------
app.post("/api/principal/login", ah(async (req, res) => {
  const { password } = req.body || {};
  const config = await store.getConfig();
  if (!password || !store.verifySecret(password, config.principalPasswordHash, config.principalPasswordSalt)) {
    return res.status(401).json({ error: "Incorrect principal password." });
  }
  setSessionCookie(req, res, { role: "principal" });
  res.json({ ok: true });
}));

app.post("/api/principal/change-password", requirePrincipal, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const config = await store.getConfig();
  if (!store.verifySecret(currentPassword, config.principalPasswordHash, config.principalPasswordSalt)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters." });
  }
  const { hash, salt } = store.hashSecret(newPassword);
  await store.setPrincipalPassword(hash, salt);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Admin auth — the admin manages the teacher roster and the question bank;
// this is a separate role from the principal (who only grades teachers).
// ---------------------------------------------------------------------------
app.post("/api/admin/login", ah(async (req, res) => {
  const { password } = req.body || {};
  const config = await store.getConfig();
  if (!password || !store.verifySecret(password, config.adminPasswordHash, config.adminPasswordSalt)) {
    return res.status(401).json({ error: "Incorrect admin password." });
  }
  setSessionCookie(req, res, { role: "admin" });
  res.json({ ok: true });
}));

app.post("/api/admin/change-password", requireAdmin, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const config = await store.getConfig();
  if (!store.verifySecret(currentPassword, config.adminPasswordHash, config.adminPasswordSalt)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters." });
  }
  const { hash, salt } = store.hashSecret(newPassword);
  await store.setAdminPassword(hash, salt);
  res.json({ ok: true });
}));

// The admin can reset the principal's password directly (no current
// password needed) in case the principal gets locked out.
app.post("/api/admin/principal-password", requireAdmin, ah(async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters." });
  }
  const { hash, salt } = store.hashSecret(newPassword);
  await store.setPrincipalPassword(hash, salt);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Question bank (admin only editable; min 30 enforced)
// ---------------------------------------------------------------------------
app.post("/api/admin/questions", requireAdmin, ah(async (req, res) => {
  const { category, text } = req.body || {};
  if (!category || !category.trim()) return res.status(400).json({ error: "Category is required." });
  if (!text || !text.trim()) return res.status(400).json({ error: "Question text is required." });
  const question = await store.addQuestion(category.trim(), text.trim());
  res.json({ question, questions: await store.listQuestions() });
}));

app.put("/api/admin/questions/:id", requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const { category, text } = req.body || {};
  if (category !== undefined && !category.trim()) return res.status(400).json({ error: "Category cannot be empty." });
  if (text !== undefined && !text.trim()) return res.status(400).json({ error: "Question text cannot be empty." });
  const question = await store.updateQuestion(id, {
    category: category !== undefined ? category.trim() : undefined,
    text: text !== undefined ? text.trim() : undefined
  });
  if (!question) return res.status(404).json({ error: "Question not found." });
  res.json({ question, questions: await store.listQuestions() });
}));

app.delete("/api/admin/questions/:id", requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const questions = await store.listQuestions();
  if (questions.length <= store.MIN_QUESTIONS) {
    return res.status(400).json({ error: `At least ${store.MIN_QUESTIONS} questions are required — add a replacement before deleting this one.` });
  }
  if (!questions.some(q => q.id === id)) return res.status(404).json({ error: "Question not found." });
  await store.deleteQuestion(id);
  res.json({ questions: await store.listQuestions() });
}));

// ---------------------------------------------------------------------------
// Teacher roster — read-only list for principal/admin (principal needs it to
// pick who to grade; admin needs it to manage the roster). Add/edit/remove
// and password resets are admin-only.
// ---------------------------------------------------------------------------
app.get("/api/teachers/list", requirePrincipalOrAdmin, ah(async (req, res) => {
  const teachers = await store.listTeachers();
  res.json({ teachers: await Promise.all(teachers.map(teacherWithStatus)) });
}));

app.post("/api/admin/teachers", requireAdmin, ah(async (req, res) => {
  const { name, department, section, email, yearOfJoining } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Teacher name is required." });
  if (await store.getTeacherByName(name)) return res.status(400).json({ error: "A teacher with that name already exists." });
  if (section && !store.SECTIONS.includes(section)) return res.status(400).json({ error: "Invalid section." });
  const teacher = await store.createTeacher({
    id: crypto.randomUUID(),
    name: name.trim(),
    department: (department || "").trim(),
    section: section || "",
    email: (email || "").trim(),
    yearOfJoining: yearOfJoining ? Number(yearOfJoining) : null,
    passwordHash: null,
    passwordSalt: null
  });
  res.json({ teacher: await teacherWithStatus(teacher) });
}));

app.put("/api/admin/teachers/:id", requireAdmin, ah(async (req, res) => {
  const existing = await store.getTeacherById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Teacher not found." });
  const { name, department, section, email, yearOfJoining } = req.body || {};
  if (section !== undefined && section && !store.SECTIONS.includes(section)) {
    return res.status(400).json({ error: "Invalid section." });
  }
  const fields = {};
  if (name && name.trim()) fields.name = name.trim();
  if (department !== undefined) fields.department = department.trim();
  if (section !== undefined) fields.section = section;
  if (email !== undefined) fields.email = email.trim();
  if (yearOfJoining !== undefined) fields.yearOfJoining = yearOfJoining ? Number(yearOfJoining) : null;
  const teacher = await store.updateTeacher(req.params.id, fields);
  res.json({ teacher: await teacherWithStatus(teacher) });
}));

app.delete("/api/admin/teachers/:id", requireAdmin, ah(async (req, res) => {
  const existing = await store.getTeacherById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Teacher not found." });
  await store.deleteTeacher(req.params.id);
  res.json({ ok: true });
}));

// Lets the admin set a teacher's password directly (e.g. she's locked out
// and doesn't have an email on file for OTP reset). Also "registers" a
// pre-added teacher who hasn't set her own password yet.
app.post("/api/admin/teachers/:id/set-password", requireAdmin, ah(async (req, res) => {
  const existing = await store.getTeacherById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Teacher not found." });
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters." });
  }
  const { hash, salt } = store.hashSecret(newPassword);
  const teacher = await store.updateTeacher(req.params.id, { passwordHash: hash, passwordSalt: salt });
  await store.deletePasswordReset(req.params.id);
  res.json({ teacher: await teacherWithStatus(teacher) });
}));

// ---------------------------------------------------------------------------
// Teacher auth — registration, login, OTP-based password reset.
// ---------------------------------------------------------------------------
app.post("/api/teacher/register", ah(async (req, res) => {
  const { name, password, department, section, email, yearOfJoining } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Enter your name." });
  if (!password || String(password).length < 4) return res.status(400).json({ error: "Password must be at least 4 characters." });
  if (!store.SECTIONS.includes(section)) return res.status(400).json({ error: "Choose a valid section." });
  const currentYear = new Date().getFullYear();
  const yoj = Number(yearOfJoining);
  if (!Number.isInteger(yoj) || yoj < 1960 || yoj > currentYear + 1) {
    return res.status(400).json({ error: "Enter a valid year of joining." });
  }
  if (email && email.trim() && !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: "Enter a valid email address, or leave it blank." });
  }

  let teacher = await store.getTeacherByName(name);
  if (teacher && teacher.passwordHash) {
    return res.status(400).json({ error: "A teacher with that name is already registered. Please log in instead." });
  }

  const { hash, salt } = store.hashSecret(password);
  if (teacher) {
    // Claims a record the admin pre-added (or a legacy record from before
    // password login existed) without losing its appraisal history.
    teacher = await store.updateTeacher(teacher.id, {
      department: (department || "").trim(),
      section,
      email: (email || "").trim(),
      yearOfJoining: yoj,
      passwordHash: hash,
      passwordSalt: salt
    });
  } else {
    teacher = await store.createTeacher({
      id: crypto.randomUUID(),
      name: name.trim(),
      department: (department || "").trim(),
      section,
      email: (email || "").trim(),
      yearOfJoining: yoj,
      passwordHash: hash,
      passwordSalt: salt
    });
  }

  setSessionCookie(req, res, { role: "teacher", teacherId: teacher.id });
  res.json({ ok: true, teacher: publicTeacher(teacher) });
}));

app.post("/api/teacher/login", ah(async (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: "Enter your name and password." });
  const teacher = await store.getTeacherByName(name);
  if (!teacher || !teacher.passwordHash || !store.verifySecret(password, teacher.passwordHash, teacher.passwordSalt)) {
    return res.status(401).json({ error: "Incorrect name or password." });
  }
  setSessionCookie(req, res, { role: "teacher", teacherId: teacher.id });
  res.json({ ok: true, teacher: publicTeacher(teacher) });
}));

app.post("/api/teacher/forgot-password", ah(async (req, res) => {
  const { email } = req.body || {};
  if (!email || !email.trim()) return res.status(400).json({ error: "Enter your email." });
  const teacher = await store.getTeacherByEmail(email);
  if (teacher && teacher.passwordHash) {
    const otp = genOtp();
    const { hash, salt } = store.hashSecret(otp);
    await store.setPasswordReset(teacher.id, hash, salt, Date.now() + OTP_TTL_MS);
    try {
      await mailer.sendOtpEmail(teacher.email, otp, teacher.name);
    } catch (e) {
      console.warn("Failed to send OTP email:", e.message);
    }
  }
  // Same response whether or not the email matched, so this can't be used to
  // discover which emails are registered.
  res.json({ ok: true, message: "If that email is registered, a reset code has been sent (or logged on the server)." });
}));

app.post("/api/teacher/reset-password", ah(async (req, res) => {
  const { email, otp, newPassword } = req.body || {};
  if (!email || !otp || !newPassword) return res.status(400).json({ error: "All fields are required." });
  if (String(newPassword).length < 4) return res.status(400).json({ error: "New password must be at least 4 characters." });
  const teacher = await store.getTeacherByEmail(email);
  const reset = teacher && await store.getPasswordReset(teacher.id);
  if (!teacher || !reset || reset.expires < Date.now() || !store.verifySecret(otp, reset.hash, reset.salt)) {
    return res.status(400).json({ error: "That code is invalid or has expired. Request a new one." });
  }
  const { hash, salt } = store.hashSecret(newPassword);
  await store.updateTeacher(teacher.id, { passwordHash: hash, passwordSalt: salt });
  await store.deletePasswordReset(teacher.id);
  res.json({ ok: true });
}));

app.get("/api/teacher/me", requireTeacher, ah(async (req, res) => {
  const teacher = await store.getTeacherById(req.session.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const self = await store.getSelfRating(teacher.id);
  const principal = await store.getPrincipalRating(teacher.id);
  res.json({
    teacher: publicTeacher(teacher),
    selfRating: self ? { ratings: self.ratings, comments: self.comments || "", submittedAt: self.submittedAt } : null,
    principalDone: !!principal
  });
}));

app.post("/api/teacher/self-rating", requireTeacher, ah(async (req, res) => {
  const { ratings, comments } = req.body || {};
  const questions = await store.listQuestions();
  if (!validateRatings(ratings, questions)) {
    return res.status(400).json({ error: "Please answer every question (1 to 5) before saving." });
  }
  await store.setSelfRating(req.session.teacherId, ratings, (comments || "").trim());
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Principal rating of a teacher
// ---------------------------------------------------------------------------
app.get("/api/principal/rating/:teacherId", requirePrincipal, ah(async (req, res) => {
  const teacher = await store.getTeacherById(req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const principal = await store.getPrincipalRating(teacher.id);
  const self = await store.getSelfRating(teacher.id);
  res.json({
    teacher: publicTeacher(teacher),
    principalRating: principal
      ? { ratings: principal.ratings, comments: principal.comments || "", submittedAt: principal.submittedAt }
      : null,
    selfSubmitted: !!self,
    selfRating: self ? { ratings: self.ratings, comments: self.comments || "" } : null
  });
}));

app.post("/api/principal/rating/:teacherId", requirePrincipal, ah(async (req, res) => {
  const teacher = await store.getTeacherById(req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const { ratings, comments } = req.body || {};
  const questions = await store.listQuestions();
  if (!validateRatings(ratings, questions)) {
    return res.status(400).json({ error: "Please answer every question (1 to 5) before saving." });
  }
  await store.setPrincipalRating(teacher.id, ratings, (comments || "").trim());
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Comparison (principal, admin, or the teacher viewing their own)
// ---------------------------------------------------------------------------
app.get("/api/comparison/:teacherId", requirePrincipalOrAdminOrOwnTeacher("teacherId"), ah(async (req, res) => {
  const teacher = await store.getTeacherById(req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  res.json(await buildComparison(teacher));
}));

// ---------------------------------------------------------------------------
// PDF appraisal form (principal, admin, or the teacher viewing their own)
// ---------------------------------------------------------------------------
app.get("/api/export/pdf/:teacherId", requirePrincipalOrAdminOrOwnTeacher("teacherId"), ah(async (req, res) => {
  const teacher = await store.getTeacherById(req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const cmp = await buildComparison(teacher);
  if (!cmp.self || !cmp.principal) {
    return res.status(400).json({ error: "Both the self-appraisal and the principal's rating must be submitted before the form can be downloaded." });
  }
  const config = await store.getConfig();

  const filename = `${teacher.name.replace(/[^a-z0-9]+/gi, "_")}_appraisal_form.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: "A4", margin: 56 });
  doc.pipe(res);

  if (fs.existsSync(LOGO_PATH)) {
    try {
      const logoWidth = 64;
      doc.image(LOGO_PATH, doc.page.width / 2 - logoWidth / 2, doc.y, { width: logoWidth });
      doc.y += logoWidth + 12;
    } catch (e) { /* skip logo if unreadable */ }
  }

  doc.font("Helvetica-Bold").fontSize(18).text(config.schoolName, { align: "center" });
  doc.font("Helvetica-Bold").fontSize(14).text("Teacher Appraisal Form", { align: "center" });
  doc.moveDown(1.2);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#c3c2b7").stroke();
  doc.moveDown(1);

  function row(label, value) {
    doc.font("Helvetica-Bold").fontSize(11).text(label, { continued: true });
    doc.font("Helvetica").fontSize(11).text("  " + (value || "—"));
    doc.moveDown(0.4);
  }

  row("Name:", teacher.name);
  row("Department:", teacher.department);
  row("Section:", teacher.section);
  row("Year of Joining:", teacher.yearOfJoining ? String(teacher.yearOfJoining) : "");
  doc.moveDown(0.6);

  row("Self-Rating Average (out of 5):", cmp.overall.self != null ? cmp.overall.self.toFixed(2) : "");
  row("Principal Rating Average (out of 5):", cmp.overall.principal != null ? cmp.overall.principal.toFixed(2) : "");
  doc.moveDown(0.2);

  doc.font("Helvetica-Bold").fontSize(13).fillColor("#075133").text("Overall Grade: " + (cmp.overall.gradeLabel || "—"));
  doc.fillColor("#000000");
  doc.moveDown(0.8);

  doc.font("Helvetica-Bold").fontSize(11).text("Principal's Remark:");
  doc.font("Helvetica").fontSize(11).text(cmp.principal.comments || "No remark given.", { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  doc.moveDown(1.5);

  doc.font("Helvetica").fontSize(9).fillColor("#898781")
    .text(`Self-appraisal submitted: ${cmp.self.submittedAt ? new Date(cmp.self.submittedAt).toLocaleDateString() : "—"}`)
    .text(`Principal rating submitted: ${cmp.principal.submittedAt ? new Date(cmp.principal.submittedAt).toLocaleDateString() : "—"}`)
    .text(`Generated: ${new Date().toLocaleDateString()}`);

  doc.end();
}));

// ---------------------------------------------------------------------------
// Exports (principal or admin)
// ---------------------------------------------------------------------------
app.get("/api/export/csv/:teacherId", requirePrincipalOrAdmin, ah(async (req, res) => {
  const teacher = await store.getTeacherById(req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const cmp = await buildComparison(teacher);

  const rows = [
    ["Teacher", teacher.name],
    ["Department", teacher.department || ""],
    ["Section", teacher.section || ""],
    ["Self-Rating Submitted", cmp.self ? cmp.self.submittedAt : "Not submitted"],
    ["Principal Rating Submitted", cmp.principal ? cmp.principal.submittedAt : "Not submitted"],
    ["Overall Grade", cmp.overall.gradeLabel || ""],
    [],
    ["#", "Category", "Question", "Self Rating", "Self Label", "Principal Rating", "Principal Label", "Gap (Principal - Self)"]
  ];
  cmp.rows.forEach(r => {
    rows.push([r.id, r.category, r.text, r.self ?? "", ratingLabel(r.self), r.principal ?? "", ratingLabel(r.principal), r.gap ?? ""]);
  });
  rows.push([]);
  rows.push(["Overall Average", "", "", cmp.overall.self ?? "", "", cmp.overall.principal ?? "", "", ""]);

  const filename = `${teacher.name.replace(/[^a-z0-9]+/gi, "_")}_appraisal.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("﻿" + toCsv(rows)); // BOM so Excel opens UTF-8 correctly
}));

app.get("/api/export/csv", requirePrincipalOrAdmin, ah(async (req, res) => {
  const rows = [["Teacher", "Department", "Section", "#", "Category", "Question", "Self Rating", "Self Label", "Principal Rating", "Principal Label", "Gap (Principal - Self)"]];
  for (const teacher of await store.listTeachers()) {
    const cmp = await buildComparison(teacher);
    cmp.rows.forEach(r => {
      rows.push([teacher.name, teacher.department || "", teacher.section || "", r.id, r.category, r.text, r.self ?? "", ratingLabel(r.self), r.principal ?? "", ratingLabel(r.principal), r.gap ?? ""]);
    });
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="all_teachers_appraisal_detail.csv"');
  res.send("﻿" + toCsv(rows));
}));

app.get("/api/export/summary.csv", requirePrincipalOrAdmin, ah(async (req, res) => {
  const rows = [["Teacher", "Department", "Section", "Self Average", "Principal Average", "Overall Grade", "Gap (Principal - Self)", "Self Submitted", "Principal Submitted"]];
  for (const teacher of await store.listTeachers()) {
    const cmp = await buildComparison(teacher);
    const gap = cmp.overall.self != null && cmp.overall.principal != null ? Math.round((cmp.overall.principal - cmp.overall.self) * 100) / 100 : "";
    rows.push([
      teacher.name,
      teacher.department || "",
      teacher.section || "",
      cmp.overall.self ?? "",
      cmp.overall.principal ?? "",
      cmp.overall.gradeLabel || "",
      gap,
      cmp.self ? cmp.self.submittedAt : "Not submitted",
      cmp.principal ? cmp.principal.submittedAt : "Not submitted"
    ]);
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="all_teachers_appraisal_summary.csv"');
  res.send("﻿" + toCsv(rows));
}));

app.get("/api/export/xlsx", requirePrincipalOrAdmin, ah(async (req, res) => {
  const wb = XLSX.utils.book_new();
  const teachers = await store.listTeachers();

  // Summary sheet
  const summaryRows = [["Teacher", "Department", "Section", "Self Average", "Principal Average", "Overall Grade", "Gap (Principal - Self)", "Self Submitted", "Principal Submitted"]];
  const comparisons = [];
  for (const teacher of teachers) {
    const cmp = await buildComparison(teacher);
    comparisons.push({ teacher, cmp });
    const gap = cmp.overall.self != null && cmp.overall.principal != null ? Math.round((cmp.overall.principal - cmp.overall.self) * 100) / 100 : "";
    summaryRows.push([
      teacher.name,
      teacher.department || "",
      teacher.section || "",
      cmp.overall.self ?? "",
      cmp.overall.principal ?? "",
      cmp.overall.gradeLabel || "",
      gap,
      cmp.self ? cmp.self.submittedAt : "Not submitted",
      cmp.principal ? cmp.principal.submittedAt : "Not submitted"
    ]);
  }
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!cols"] = [{ wch: 24 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 20 }, { wch: 22 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

  // One detail sheet per teacher
  const usedNames = new Set(["summary"]);
  for (const { teacher, cmp } of comparisons) {
    const rows = [
      ["Teacher", teacher.name],
      ["Department", teacher.department || ""],
      ["Section", teacher.section || ""],
      ["Self-Rating Submitted", cmp.self ? cmp.self.submittedAt : "Not submitted"],
      ["Principal Rating Submitted", cmp.principal ? cmp.principal.submittedAt : "Not submitted"],
      ["Overall Grade", cmp.overall.gradeLabel || ""],
      [],
      ["#", "Category", "Question", "Self Rating", "Self Label", "Principal Rating", "Principal Label", "Gap (Principal - Self)"]
    ];
    cmp.rows.forEach(r => {
      rows.push([r.id, r.category, r.text, r.self ?? "", ratingLabel(r.self), r.principal ?? "", ratingLabel(r.principal), r.gap ?? ""]);
    });
    rows.push([]);
    rows.push(["Overall Average", "", "", cmp.overall.self ?? "", "", cmp.overall.principal ?? "", "", ""]);
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [{ wch: 4 }, { wch: 28 }, { wch: 55 }, { wch: 12 }, { wch: 16 }, { wch: 15 }, { wch: 16 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, sheet, safeSheetName(teacher.name, usedNames));
  }

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="teacher_appraisal_comparison.xlsx"');
  res.send(buffer);
}));

// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error." });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Teacher Appraisal System running at http://localhost:${PORT}`);
  });
}

module.exports = app;
