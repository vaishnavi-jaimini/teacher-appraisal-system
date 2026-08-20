const express = require("express");
const crypto = require("crypto");
const path = require("path");
const XLSX = require("xlsx");

const { QUESTIONS, CATEGORIES, RATING_SCALE } = require("./data/questions");
const store = require("./data/store");

const db = store.load();
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

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

// Either the principal, or the teacher viewing their own record.
function requirePrincipalOrOwnTeacher(paramName) {
  return (req, res, next) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: "Login required." });
    const teacherId = req.params[paramName];
    if (session.role === "principal") {
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
  return { id: t.id, name: t.name, subject: t.subject || "" };
}

function teacherWithStatus(t) {
  return {
    ...publicTeacher(t),
    selfDone: !!db.selfRatings[t.id],
    principalDone: !!db.principalRatings[t.id],
    selfSubmittedAt: db.selfRatings[t.id] ? db.selfRatings[t.id].submittedAt : null,
    principalSubmittedAt: db.principalRatings[t.id] ? db.principalRatings[t.id].submittedAt : null,
    pinIsTemporary: !!t.pinIsTemporary
  };
}

function average(arr) {
  if (!arr || !arr.length) return null;
  const sum = arr.reduce((a, b) => a + b, 0);
  return Math.round((sum / arr.length) * 100) / 100;
}

function validateRatings(ratings) {
  if (!Array.isArray(ratings) || ratings.length !== QUESTIONS.length) return false;
  return ratings.every(r => Number.isInteger(r) && r >= 1 && r <= 5);
}

function buildComparison(teacher) {
  const self = db.selfRatings[teacher.id] || null;
  const principal = db.principalRatings[teacher.id] || null;

  const rows = QUESTIONS.map((q, i) => {
    const selfScore = self ? self.ratings[i] : null;
    const principalScore = principal ? principal.ratings[i] : null;
    return {
      id: q.id,
      category: q.category,
      text: q.text,
      self: selfScore,
      principal: principalScore,
      gap: selfScore != null && principalScore != null ? principalScore - selfScore : null
    };
  });

  const categoryAverages = CATEGORIES.map(cat => {
    const catRows = rows.filter(r => r.category === cat);
    return {
      category: cat,
      self: average(catRows.map(r => r.self).filter(v => v != null)),
      principal: average(catRows.map(r => r.principal).filter(v => v != null))
    };
  });

  return {
    teacher: publicTeacher(teacher),
    self: self && { comments: self.comments || "", submittedAt: self.submittedAt },
    principal: principal && { comments: principal.comments || "", submittedAt: principal.submittedAt },
    rows,
    categoryAverages,
    overall: {
      self: self ? average(self.ratings) : null,
      principal: principal ? average(principal.ratings) : null
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
  const found = RATING_SCALE.find(r => r.value === v);
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
  res.json({ questions: QUESTIONS, categories: CATEGORIES, scale: RATING_SCALE });
});

app.get("/api/teachers/public", (req, res) => {
  res.json({ teachers: db.teachers.map(publicTeacher) });
});

app.get("/api/session", (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ role: null });
  if (session.role === "principal") return res.json({ role: "principal" });
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
// Principal auth
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
// Teacher management (principal only)
// ---------------------------------------------------------------------------
app.get("/api/principal/teachers", requirePrincipal, (req, res) => {
  res.json({ teachers: db.teachers.map(teacherWithStatus) });
});

function randomPin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

app.post("/api/principal/teachers", requirePrincipal, (req, res) => {
  const { name, subject } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Teacher name is required." });
  const pin = randomPin();
  const { hash, salt } = store.hashSecret(pin);
  const teacher = {
    id: crypto.randomUUID(),
    name: name.trim(),
    subject: (subject || "").trim(),
    pinHash: hash,
    pinSalt: salt,
    pinIsTemporary: true, // teacher must choose her own permanent PIN on first login
    createdAt: new Date().toISOString()
  };
  db.teachers.push(teacher);
  store.save();
  // The code is only ever returned once, at creation time, so the principal can hand it to the teacher.
  res.json({ teacher: teacherWithStatus(teacher), pin });
});

app.put("/api/principal/teachers/:id", requirePrincipal, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.id);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const { name, subject } = req.body || {};
  if (name && name.trim()) teacher.name = name.trim();
  if (subject !== undefined) teacher.subject = subject.trim();
  store.save();
  res.json({ teacher: teacherWithStatus(teacher) });
});

app.post("/api/principal/teachers/:id/reset-pin", requirePrincipal, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.id);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const pin = randomPin();
  const { hash, salt } = store.hashSecret(pin);
  teacher.pinHash = hash;
  teacher.pinSalt = salt;
  teacher.pinIsTemporary = true; // she'll be asked to choose a new permanent PIN on next login
  store.save();
  res.json({ ok: true, pin });
});

app.delete("/api/principal/teachers/:id", requirePrincipal, (req, res) => {
  const idx = db.teachers.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Teacher not found." });
  const [removed] = db.teachers.splice(idx, 1);
  delete db.selfRatings[removed.id];
  delete db.principalRatings[removed.id];
  store.save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Teacher auth
// ---------------------------------------------------------------------------
app.post("/api/teacher/login", (req, res) => {
  const { teacherId, pin } = req.body || {};
  const teacher = db.teachers.find(t => t.id === teacherId);
  if (!teacher || !pin || !store.verifySecret(pin, teacher.pinHash, teacher.pinSalt)) {
    return res.status(401).json({ error: "Incorrect teacher / PIN combination." });
  }
  const token = createSession({ role: "teacher", teacherId: teacher.id });
  setSessionCookie(res, token);
  res.json({ ok: true, teacher: publicTeacher(teacher), mustSetPin: !!teacher.pinIsTemporary });
});

app.get("/api/teacher/me", requireTeacher, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.session.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const self = db.selfRatings[teacher.id] || null;
  res.json({
    teacher: publicTeacher(teacher),
    mustSetPin: !!teacher.pinIsTemporary,
    selfRating: self ? { ratings: self.ratings, comments: self.comments || "", submittedAt: self.submittedAt } : null,
    principalDone: !!db.principalRatings[teacher.id]
  });
});

// A teacher chooses her own permanent PIN, either as mandatory first-time
// setup (replacing the principal's temporary code — no current PIN needed,
// since the session itself already proves she just authenticated with it)
// or as a voluntary later change (current PIN required).
app.post("/api/teacher/change-pin", requireTeacher, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.session.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const { currentPin, newPin } = req.body || {};

  if (!teacher.pinIsTemporary) {
    if (!currentPin || !store.verifySecret(currentPin, teacher.pinHash, teacher.pinSalt)) {
      return res.status(401).json({ error: "Current PIN is incorrect." });
    }
  }
  if (!newPin || !/^\d{4,6}$/.test(newPin)) {
    return res.status(400).json({ error: "New PIN must be 4-6 digits." });
  }

  const { hash, salt } = store.hashSecret(newPin);
  teacher.pinHash = hash;
  teacher.pinSalt = salt;
  teacher.pinIsTemporary = false;
  store.save();
  res.json({ ok: true });
});

app.post("/api/teacher/self-rating", requireTeacher, (req, res) => {
  const { ratings, comments } = req.body || {};
  if (!validateRatings(ratings)) {
    return res.status(400).json({ error: `Expected ${QUESTIONS.length} ratings, each an integer from 1 to 5.` });
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
  res.json({
    teacher: publicTeacher(teacher),
    principalRating: principal
      ? { ratings: principal.ratings, comments: principal.comments || "", submittedAt: principal.submittedAt }
      : null,
    selfSubmitted: !!db.selfRatings[teacher.id] // deliberately no scores here, to avoid biasing the principal's rating
  });
});

app.post("/api/principal/rating/:teacherId", requirePrincipal, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const { ratings, comments } = req.body || {};
  if (!validateRatings(ratings)) {
    return res.status(400).json({ error: `Expected ${QUESTIONS.length} ratings, each an integer from 1 to 5.` });
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
app.get("/api/comparison/:teacherId", requirePrincipalOrOwnTeacher("teacherId"), (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  res.json(buildComparison(teacher));
});

// ---------------------------------------------------------------------------
// Exports (principal only)
// ---------------------------------------------------------------------------
app.get("/api/export/csv/:teacherId", requirePrincipal, (req, res) => {
  const teacher = db.teachers.find(t => t.id === req.params.teacherId);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const cmp = buildComparison(teacher);

  const rows = [
    ["Teacher", teacher.name],
    ["Subject", teacher.subject || ""],
    ["Self-Rating Submitted", cmp.self ? cmp.self.submittedAt : "Not submitted"],
    ["Principal Rating Submitted", cmp.principal ? cmp.principal.submittedAt : "Not submitted"],
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

app.get("/api/export/csv", requirePrincipal, (req, res) => {
  const rows = [["Teacher", "Subject", "#", "Category", "Question", "Self Rating", "Self Label", "Principal Rating", "Principal Label", "Gap (Principal - Self)"]];
  db.teachers.forEach(teacher => {
    const cmp = buildComparison(teacher);
    cmp.rows.forEach(r => {
      rows.push([teacher.name, teacher.subject || "", r.id, r.category, r.text, r.self ?? "", ratingLabel(r.self), r.principal ?? "", ratingLabel(r.principal), r.gap ?? ""]);
    });
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="all_teachers_appraisal_detail.csv"');
  res.send("﻿" + toCsv(rows));
});

app.get("/api/export/summary.csv", requirePrincipal, (req, res) => {
  const rows = [["Teacher", "Subject", "Self Average", "Principal Average", "Gap (Principal - Self)", "Self Submitted", "Principal Submitted"]];
  db.teachers.forEach(teacher => {
    const cmp = buildComparison(teacher);
    const gap = cmp.overall.self != null && cmp.overall.principal != null ? Math.round((cmp.overall.principal - cmp.overall.self) * 100) / 100 : "";
    rows.push([
      teacher.name,
      teacher.subject || "",
      cmp.overall.self ?? "",
      cmp.overall.principal ?? "",
      gap,
      cmp.self ? cmp.self.submittedAt : "Not submitted",
      cmp.principal ? cmp.principal.submittedAt : "Not submitted"
    ]);
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="all_teachers_appraisal_summary.csv"');
  res.send("﻿" + toCsv(rows));
});

app.get("/api/export/xlsx", requirePrincipal, (req, res) => {
  const wb = XLSX.utils.book_new();

  // Summary sheet
  const summaryRows = [["Teacher", "Subject", "Self Average", "Principal Average", "Gap (Principal - Self)", "Self Submitted", "Principal Submitted"]];
  db.teachers.forEach(teacher => {
    const cmp = buildComparison(teacher);
    const gap = cmp.overall.self != null && cmp.overall.principal != null ? Math.round((cmp.overall.principal - cmp.overall.self) * 100) / 100 : "";
    summaryRows.push([
      teacher.name,
      teacher.subject || "",
      cmp.overall.self ?? "",
      cmp.overall.principal ?? "",
      gap,
      cmp.self ? cmp.self.submittedAt : "Not submitted",
      cmp.principal ? cmp.principal.submittedAt : "Not submitted"
    ]);
  });
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!cols"] = [{ wch: 24 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 20 }, { wch: 22 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

  // One detail sheet per teacher
  const usedNames = new Set(["summary"]);
  db.teachers.forEach(teacher => {
    const cmp = buildComparison(teacher);
    const rows = [
      ["Teacher", teacher.name],
      ["Subject", teacher.subject || ""],
      ["Self-Rating Submitted", cmp.self ? cmp.self.submittedAt : "Not submitted"],
      ["Principal Rating Submitted", cmp.principal ? cmp.principal.submittedAt : "Not submitted"],
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
