const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const PDFDocument = require("pdfkit");

const store = require("./data/store");
const mailer = require("./lib/mailer");

const db = store.load();
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LOGO_PATH = path.join(__dirname, "public", "images", "dpsv-logo.png");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Tiny in-memory session store + manual cookie handling (avoids pulling in
// extra auth/session packages for what is a small internal LAN tool).
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> { role, teacherId?, expires }

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

function createSession(data) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { ...data, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies.session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`
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

// Admin manages teachers/questions; the principal only grades and views
// results, so most read/export endpoints are open to either.
function requirePrincipalOrAdmin(req, res, next) {
  const session = getSession(req);
  if (!session || (session.role !== "principal" && session.role !== "admin")) {
    return res.status(401).json({ error: "Principal or admin login required." });
  }
  req.session = session;
  next();
}

function requireTeacher(req, res, next) {
  const session = getSession(req);
  if (!session || session.role !== "teacher") {
    return res.status(401).json({ error: "Teacher login required." });
  }
  if (!db.teachers.some(t => t.id === session.teacherId)) {
    sessions.delete(session.token);
    clearSessionCookie(res);
    return res.status(401).json({ error: "This teacher account no longer exists. Please log in again." });
  }
  req.session = session;
  next();
}

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

function teacherWithStatus(t) {
  return {
    ...publicTeacher(t),
    selfDone: !!db.selfRatings[t.id],
    principalDone: !!db.principalRatings[t.id],
    selfSubmittedAt: db.selfRatings[t.id] ? db.selfRatings[t.id].submittedAt : null,
    principalSubmittedAt: db.principalRatings[t.id] ? db.principalRatings[t.id].submittedAt : null
  };
}

function findTeacherByName(name) {
  const normalized = name.trim().toLowerCase();
  return db.teachers.find(t => t.name.trim().toLowerCase() === normalized);
}

function findTeacherByEmail(email) {
  const normalized = email.trim().toLowerCase();
  return db.teachers.find(t => (t.email || "").trim().toLowerCase() === normalized);
}

function sortedQuestions() {
  return db.questions.slice().sort((a, b) => a.id - b.id);
}

function categoriesOf(questions) {
  return [...new Set(questions.map(q => q.category))];
}

function average(arr) {
  if (!arr || !arr.length) return null;
  const sum = arr.reduce((a, b) => a + b, 0);
  return Math.round((sum / arr.length) * 100) / 100;
}

function validateRatings(ratings) {
  if (!ratings || typeof ratings !== "object" || Array.isArray(ratings)) return false;
  return db.questions.every(q => {
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

function buildComparison(teacher) {
  const self = db.selfRatings[teacher.id] || null;
  const principal = db.principalRatings[teacher.id] || null;
  const questions = sortedQuestions();
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
app.get("/api/questions", (req, res) => {
  const questions = sortedQuestions();
  res.json({ questions, categories: categoriesOf(questions), scale: store.RATING_SCALE, minQuestions: store.MIN_QUESTIONS });
});

app.get("/api/session", (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ role: null });
  if (session.role === "principal") return res.json({ role: "principal" });
  if (session.role === "admin") return res.json({ role: "admin" });
  const teacher = db.teachers.find(t => t.id === session.teacherId);
  if (!teacher) return res.json({ role: null });
  res.json({ role: "teacher", teacher: publicTeacher(teacher) });
});

app.post("/api/logout", (req, res) => {
  const session = getSession(req);
  if (session) sessions.delete(session.token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Principal auth — principal only grades teachers and views results; she
// cannot add/remove teachers or edit questions (that's the admin's job).
// ---------------------------------------------------------------------------
app.post("/api/principal/login", (req, res) => {
  const { password } = req.body || {};
  if (!password || !store.verifySecret(password, db.config.principalPasswordHash, db.config.principalPasswordSalt)) {
    return res.status(401).json({ error: "Incorrect principal password." });
  }
  const token = createSession({ role: "principal" });
  setSessionCookie(res, token);
  res.json({ ok: true });
});

app.post("/api/principal/change-password", requirePrincipal, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!store.verifySecret(currentPassword, db.config.principalPasswordHash, db.config.principalPasswordSalt)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters." });
  }
  const { hash, salt } = store.hashSecret(newPassword);
  db.config.principalPasswordHash = hash;
  db.config.principalPasswordSalt = salt;
  store.save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin auth — the admin manages the teacher roster and the question bank;
// this is a separate role from the principal (who only grades teachers).
// ---------------------------------------------------------------------------
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!password || !store.verifySecret(password, db.config.adminPasswordHash, db.config.adminPasswordSalt)) {
    return res.status(401).json({ error: "Incorrect admin password." });
  }
  const token = createSession({ role: "admin" });
  setSessionCookie(res, token);
  res.json({ ok: true });
});

app.post("/api/admin/change-password", requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!store.verifySecret(currentPassword, db.config.adminPasswordHash, db.config.adminPasswordSalt)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters." });
  }
  const { hash, salt } = store.hashSecret(newPassword);
  db.config.adminPasswordHash = hash;
  db.config.adminPasswordSalt = salt;
  store.save();
  res.json({ ok: true });
});

// The admin can reset the principal's password directly (no current
// password needed) in case the principal gets locked out.
app.post("/api/admin/principal-password", requireAdmin, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters." });
  }
  const { hash, salt } = store.hashSecret(newPassword);
  db.config.principalPasswordHash = hash;
  db.config.principalPasswordSalt = salt;
  store.save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Question bank (admin only editable; min 30 enforced)
// ---------------------------------------------------------------------------
app.post("/api/admin/questions", requireAdmin, (req, res) => {
  const { category, text } = req.body || {};
  if (!category || !category.trim()) return res.status(400).json({ error: "Category is required." });
  if (!text || !text.trim()) return res.status(400).json({ error: "Question text is required." });
  const question = { id: db.nextQuestionId++, category: category.trim(), text: text.trim() };
  db.questions.push(question);
  store.save();
  res.json({ question, questions: sortedQuestions() });
});

app.put("/api/admin/questions/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const question = db.questions.find(q => q.id === id);
  if (!question) return res.status(404).json({ error: "Question not found." });
  const { category, text } = req.body || {};
  if (category !== undefined) {
    if (!category.trim()) return res.status(400).json({ error: "Category cannot be empty." });
    question.category = category.trim();
  }
  if (text !== undefined) {
    if (!text.trim()) return res.status(400).json({ error: "Question text cannot be empty." });
    question.text = text.trim();
  }
  store.save();
  res.json({ question, questions: sortedQuestions() });
});

app.delete("/api/admin/questions/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (db.questions.length <= store.MIN_QUESTIONS) {
    return res.status(400).json({ error: `At least ${store.MIN_QUESTIONS} questions are required — add a replacement before deleting this one.` });
  }
  const idx = db.questions.findIndex(q => q.id === id);
  if (idx === -1) return res.status(404).json({ error: "Question not found." });
  db.questions.splice(idx, 1);
  store.save();
  res.json({ questions: sortedQuestions() });
});

// ---------------------------------------------------------------------------
// Teacher roster — read-only list for principal/admin (principal needs it to
// pick who to grade; admin needs it to manage the roster). Add/edit/remove
// and password resets are admin-only.
// ---------------------------------------------------------------------------
app.get("/api/teachers/list", requirePrincipalOrAdmin, (req, res) => {
  const teachers = db.teachers.slice().sort((a, b) => a.name.localeCompare(b.name));
  res.json({ teachers: teachers.map(teacherWithStatus) });
});

app.post("/api/admin/teachers", requireAdmin, (req, res) => {
  const { name, department, section, email, yearOfJoining } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Teacher name is required." });
  if (findTeacherByName(name)) return res.status(400).json({ error: "A teacher with that name already exists." });
  if (section && !store.SECTIONS.includes(section)) return res.status(400).json({ error: "Invalid section." });
  const teacher = {
    id: crypto.randomUUID(),
    name: name.trim(),
    department: (department || "").trim(),
    section: section || "",
    email: (email || "").trim(),
    yearOfJoining: yearOfJoining ? Number(yearOfJoining) : null,
    passwordHash: null,
    passwordSalt: null,
    createdAt: new Date().toISOString()
  };
  db.teachers.push(teacher);
  store.save();
  res.json({ teacher: teacherWithStatus(teacher) });
});

app.put("/api/admin/teachers/:id", requireAdmin, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.id);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const { name, department, section, email, yearOfJoining } = req.body || {};
  if (name && name.trim()) teacher.name = name.trim();
  if (department !== undefined) teacher.department = department.trim();
  if (section !== undefined) {
    if (section && !store.SECTIONS.includes(section)) return res.status(400).json({ error: "Invalid section." });
    teacher.section = section;
  }
  if (email !== undefined) teacher.email = email.trim();
  if (yearOfJoining !== undefined) teacher.yearOfJoining = yearOfJoining ? Number(yearOfJoining) : null;
  store.save();
  res.json({ teacher: teacherWithStatus(teacher) });
});

app.delete("/api/admin/teachers/:id", requireAdmin, (req, res) => {
  const idx = db.teachers.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Teacher not found." });
  const [removed] = db.teachers.splice(idx, 1);
  delete db.selfRatings[removed.id];
  delete db.principalRatings[removed.id];
  delete db.passwordResets[removed.id];
  store.save();
  res.json({ ok: true });
});

// Lets the admin set a teacher's password directly (e.g. she's locked out
// and doesn't have an email on file for OTP reset). Also "registers" a
// pre-added teacher who hasn't set her own password yet.
app.post("/api/admin/teachers/:id/set-password", requireAdmin, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.id);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters." });
  }
  const { hash, salt } = store.hashSecret(newPassword);
  teacher.passwordHash = hash;
  teacher.passwordSalt = salt;
  delete db.passwordResets[teacher.id];
  store.save();
  res.json({ teacher: teacherWithStatus(teacher) });
});

// ---------------------------------------------------------------------------
// Teacher auth — registration, login, OTP-based password reset.
// ---------------------------------------------------------------------------
app.post("/api/teacher/register", (req, res) => {
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

  let teacher = findTeacherByName(name);
  if (teacher && teacher.passwordHash) {
    return res.status(400).json({ error: "A teacher with that name is already registered. Please log in instead." });
  }

  const { hash, salt } = store.hashSecret(password);
  if (teacher) {
    // Claims a record the principal pre-added (or a legacy record from
    // before password login existed) without losing its appraisal history.
    teacher.department = (department || "").trim();
    teacher.section = section;
    teacher.email = (email || "").trim();
    teacher.yearOfJoining = yoj;
    teacher.passwordHash = hash;
    teacher.passwordSalt = salt;
  } else {
    teacher = {
      id: crypto.randomUUID(),
      name: name.trim(),
      department: (department || "").trim(),
      section,
      email: (email || "").trim(),
      yearOfJoining: yoj,
      passwordHash: hash,
      passwordSalt: salt,
      createdAt: new Date().toISOString()
    };
    db.teachers.push(teacher);
  }
  store.save();

  const token = createSession({ role: "teacher", teacherId: teacher.id });
  setSessionCookie(res, token);
  res.json({ ok: true, teacher: publicTeacher(teacher) });
});

app.post("/api/teacher/login", (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: "Enter your name and password." });
  const teacher = findTeacherByName(name);
  if (!teacher || !teacher.passwordHash || !store.verifySecret(password, teacher.passwordHash, teacher.passwordSalt)) {
    return res.status(401).json({ error: "Incorrect name or password." });
  }
  const token = createSession({ role: "teacher", teacherId: teacher.id });
  setSessionCookie(res, token);
  res.json({ ok: true, teacher: publicTeacher(teacher) });
});

app.post("/api/teacher/forgot-password", async (req, res) => {
  const { email } = req.body || {};
  if (!email || !email.trim()) return res.status(400).json({ error: "Enter your email." });
  const teacher = findTeacherByEmail(email);
  if (teacher && teacher.passwordHash) {
    const otp = genOtp();
    const { hash, salt } = store.hashSecret(otp);
    db.passwordResets[teacher.id] = { hash, salt, expires: Date.now() + OTP_TTL_MS };
    store.save();
    try {
      await mailer.sendOtpEmail(teacher.email, otp, teacher.name);
    } catch (e) {
      console.warn("Failed to send OTP email:", e.message);
    }
  }
  // Same response whether or not the email matched, so this can't be used to
  // discover which emails are registered.
  res.json({ ok: true, message: "If that email is registered, a reset code has been sent (or logged on the server)." });
});

app.post("/api/teacher/reset-password", (req, res) => {
  const { email, otp, newPassword } = req.body || {};
  if (!email || !otp || !newPassword) return res.status(400).json({ error: "All fields are required." });
  if (String(newPassword).length < 4) return res.status(400).json({ error: "New password must be at least 4 characters." });
  const teacher = findTeacherByEmail(email);
  const reset = teacher && db.passwordResets[teacher.id];
  if (!teacher || !reset || reset.expires < Date.now() || !store.verifySecret(otp, reset.hash, reset.salt)) {
    return res.status(400).json({ error: "That code is invalid or has expired. Request a new one." });
  }
  const { hash, salt } = store.hashSecret(newPassword);
  teacher.passwordHash = hash;
  teacher.passwordSalt = salt;
  delete db.passwordResets[teacher.id];
  store.save();
  res.json({ ok: true });
});

app.get("/api/teacher/me", requireTeacher, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.session.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const self = db.selfRatings[teacher.id] || null;
  res.json({
    teacher: publicTeacher(teacher),
    selfRating: self ? { ratings: self.ratings, comments: self.comments || "", submittedAt: self.submittedAt } : null,
    principalDone: !!db.principalRatings[teacher.id]
  });
});

app.post("/api/teacher/self-rating", requireTeacher, (req, res) => {
  const { ratings, comments } = req.body || {};
  if (!validateRatings(ratings)) {
    return res.status(400).json({ error: `Please answer every question (1 to 5) before saving.` });
  }
  db.selfRatings[req.session.teacherId] = {
    ratings,
    comments: (comments || "").trim(),
    submittedAt: new Date().toISOString()
  };
  store.save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Principal rating of a teacher
// ---------------------------------------------------------------------------
app.get("/api/principal/rating/:teacherId", requirePrincipal, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const principal = db.principalRatings[teacher.id] || null;
  const self = db.selfRatings[teacher.id] || null;
  res.json({
    teacher: publicTeacher(teacher),
    principalRating: principal
      ? { ratings: principal.ratings, comments: principal.comments || "", submittedAt: principal.submittedAt }
      : null,
    selfSubmitted: !!self,
    selfRating: self ? { ratings: self.ratings, comments: self.comments || "" } : null
  });
});

app.post("/api/principal/rating/:teacherId", requirePrincipal, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const { ratings, comments } = req.body || {};
  if (!validateRatings(ratings)) {
    return res.status(400).json({ error: `Please answer every question (1 to 5) before saving.` });
  }
  db.principalRatings[teacher.id] = {
    ratings,
    comments: (comments || "").trim(),
    submittedAt: new Date().toISOString()
  };
  store.save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Comparison (principal, or the teacher viewing their own)
// ---------------------------------------------------------------------------
app.get("/api/comparison/:teacherId", requirePrincipalOrAdminOrOwnTeacher("teacherId"), (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  res.json(buildComparison(teacher));
});

// ---------------------------------------------------------------------------
// PDF appraisal form (principal, or the teacher viewing their own)
// ---------------------------------------------------------------------------
app.get("/api/export/pdf/:teacherId", requirePrincipalOrAdminOrOwnTeacher("teacherId"), (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const cmp = buildComparison(teacher);
  if (!cmp.self || !cmp.principal) {
    return res.status(400).json({ error: "Both the self-appraisal and the principal's rating must be submitted before the form can be downloaded." });
  }

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

  doc.font("Helvetica-Bold").fontSize(18).text(db.config.schoolName, { align: "center" });
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
});

// ---------------------------------------------------------------------------
// Exports (principal only)
// ---------------------------------------------------------------------------
app.get("/api/export/csv/:teacherId", requirePrincipalOrAdmin, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const cmp = buildComparison(teacher);

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
});

app.get("/api/export/csv", requirePrincipalOrAdmin, (req, res) => {
  const rows = [["Teacher", "Department", "Section", "#", "Category", "Question", "Self Rating", "Self Label", "Principal Rating", "Principal Label", "Gap (Principal - Self)"]];
  db.teachers.forEach(teacher => {
    const cmp = buildComparison(teacher);
    cmp.rows.forEach(r => {
      rows.push([teacher.name, teacher.department || "", teacher.section || "", r.id, r.category, r.text, r.self ?? "", ratingLabel(r.self), r.principal ?? "", ratingLabel(r.principal), r.gap ?? ""]);
    });
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="all_teachers_appraisal_detail.csv"');
  res.send("﻿" + toCsv(rows));
});

app.get("/api/export/summary.csv", requirePrincipalOrAdmin, (req, res) => {
  const rows = [["Teacher", "Department", "Section", "Self Average", "Principal Average", "Overall Grade", "Gap (Principal - Self)", "Self Submitted", "Principal Submitted"]];
  db.teachers.forEach(teacher => {
    const cmp = buildComparison(teacher);
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
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="all_teachers_appraisal_summary.csv"');
  res.send("﻿" + toCsv(rows));
});

app.get("/api/export/xlsx", requirePrincipalOrAdmin, (req, res) => {
  const wb = XLSX.utils.book_new();

  // Summary sheet
  const summaryRows = [["Teacher", "Department", "Section", "Self Average", "Principal Average", "Overall Grade", "Gap (Principal - Self)", "Self Submitted", "Principal Submitted"]];
  db.teachers.forEach(teacher => {
    const cmp = buildComparison(teacher);
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
  });
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!cols"] = [{ wch: 24 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 20 }, { wch: 22 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

  // One detail sheet per teacher
  const usedNames = new Set(["summary"]);
  db.teachers.forEach(teacher => {
    const cmp = buildComparison(teacher);
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
  });

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="teacher_appraisal_comparison.xlsx"');
  res.send(buffer);
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Teacher Appraisal System running at http://localhost:${PORT}`);
  console.log(`Default principal password: principal123 (change it from the Principal dashboard)`);
});
