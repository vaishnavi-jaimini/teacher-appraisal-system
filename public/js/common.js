// Shared helpers used across all pages.

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function showError(el, message) {
  el.textContent = message;
  el.classList.add("show");
}

function hideError(el) {
  el.classList.remove("show");
}

function ratingWord(v) {
  const words = { 1: "Needs Improvement", 2: "Below Average", 3: "Satisfactory", 4: "Good", 5: "Excellent" };
  return words[v] || "";
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Renders the shared top bar. `session` is the object returned by GET /api/session.
function renderTopbar(session) {
  const el = document.getElementById("topbar-who");
  if (!el) return;
  if (!session || !session.role) {
    el.innerHTML = `<a href="/index.html" class="back-link">Home</a>`;
    return;
  }
  if (session.role === "principal") {
    el.innerHTML = `<span>Signed in as <strong>Principal</strong></span><button class="btn secondary small" id="logout-btn">Log out</button>`;
  } else {
    el.innerHTML = `<span>Signed in as <strong>${escapeHtml(session.teacher.name)}</strong></span><button class="btn secondary small" id="logout-btn">Log out</button>`;
  }
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    window.location.href = "/index.html";
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function requireRole(role) {
  const session = await api("/api/session");
  if (!session.role || (role && session.role !== role)) {
    window.location.href = role === "principal" ? "/principal-login.html" : "/teacher-login.html";
    return null;
  }
  renderTopbar(session);
  return session;
}
