// Casting view: a read-only, TV-friendly board showing a match's windows and
// leaderboard. Meant to be put fullscreen on a shared screen for viewers. Admins
// switch here from the settling console and back via the "Settling" link.
import {
  describeAuthError,
  isAdmin,
  isKnownAdmin,
  loginWithGoogle,
  logout,
  renderSignInEnvHint,
  watchAdmins,
  watchAuth,
} from "./auth.js";
import {
  watchMatch,
  watchPredictions,
  watchStandings,
  watchWindows,
} from "./service.js";
import {
  PERIODS,
  getCheckpointIndex,
  getScheme,
  getSchemeCheckpoints,
  getWindowStatus,
} from "./windows.js";

const el = (id) => document.getElementById(id);

const state = {
  user: null,
  matchId: new URLSearchParams(location.search).get("match"),
  match: null,
  windows: [],
  predictions: [],
  standings: [],
  adminsLoaded: false,
  matchSubbed: false,
  unsub: { match: null, windows: null, standings: null, preds: null, admins: null },
};

// ---------------------------------------------------------------------------
// Auth gate (admins only, mirrors the admin console)
// ---------------------------------------------------------------------------
el("login-btn").addEventListener("click", () => loginWithGoogle().catch((e) => toast(describeAuthError(e))));
el("logout-btn").addEventListener("click", () => logout());
el("denied-logout").addEventListener("click", () => logout());
el("fullscreen-btn").addEventListener("click", toggleFullscreen);
renderSignInEnvHint();

watchAuth((user) => {
  state.user = user;
  hide("login-view");
  hide("denied-view");
  hide("cast-view");
  hide("logout-btn");
  hide("user-chip");
  hide("settle-link");
  hide("fullscreen-btn");

  if (state.unsub.admins) {
    state.unsub.admins();
    state.unsub.admins = null;
  }
  state.adminsLoaded = false;

  if (!user) {
    show("login-view");
    return;
  }
  el("user-chip").textContent = user.displayName || user.email;
  show("user-chip");
  show("logout-btn");

  state.unsub.admins = watchAdmins(() => {
    state.adminsLoaded = true;
    applyGate();
  });
  applyGate();
});

function applyGate() {
  const user = state.user;
  if (!user) return;
  // Wait for the dynamic admin list unless the role is known from code alone.
  if (!isKnownAdmin(user) && !state.adminsLoaded) return;

  if (!isAdmin(user)) {
    hide("cast-view");
    show("denied-view");
    return;
  }
  hide("denied-view");
  show("cast-view");
  show("settle-link");
  show("fullscreen-btn");
  el("settle-link").href = state.matchId
    ? `admin.html?match=${encodeURIComponent(state.matchId)}`
    : "admin.html";
  enterCast();
}

function enterCast() {
  if (state.matchSubbed) return;
  if (!state.matchId) {
    show("no-match");
    return;
  }
  state.matchSubbed = true;
  hide("no-match");
  subscribe(state.matchId);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
function subscribe(matchId) {
  state.unsub.match = watchMatch(matchId, (match) => {
    if (!match) {
      show("no-match");
      toast("This match is no longer available.");
      return;
    }
    hide("no-match");
    state.match = match;
    renderClock();
    renderWindows();
  });
  state.unsub.windows = watchWindows(matchId, (windows) => {
    state.windows = windows;
    renderWindows();
  });
  state.unsub.standings = watchStandings(matchId, (standings) => {
    state.standings = standings;
    renderLeaderboard();
  });
  state.unsub.preds = watchPredictions(matchId, (preds) => {
    state.predictions = preds;
    renderWindows();
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const PERIOD_LABEL = {
  [PERIODS.PRE]: "Pre-match",
  [PERIODS.FIRST_HALF]: "1st half",
  [PERIODS.HALFTIME]: "Half-time",
  [PERIODS.SECOND_HALF]: "2nd half",
  [PERIODS.FULLTIME]: "Full-time",
};

function renderClock() {
  const m = state.match;
  if (!m) return;
  el("match-name").textContent = m.name || "";
  if (getScheme(m).id === "hydration") {
    const cp = getSchemeCheckpoints(m)[getCheckpointIndex(m)];
    el("match-clock").textContent = cp ? cp.label : (PERIOD_LABEL[m.period] || m.period);
    return;
  }
  const minute =
    m.period === PERIODS.FIRST_HALF || m.period === PERIODS.SECOND_HALF
      ? `${m.matchMinute}'`
      : "";
  el("match-clock").textContent = `${PERIOD_LABEL[m.period] || m.period} ${minute}`.trim();
}

function renderWindows() {
  const list = el("window-list");
  if (!list) return;
  if (!state.match || !state.windows.length) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = state.windows
    .map((w) => {
      const status = getWindowStatus(w, state.match);
      const leader = status === "settled" ? getWindowLeader(w.order) : null;
      const predictors = getPredictorNames(w.order);
      const predictorPills = predictors.length
        ? `<div class="predictor-pills">${predictors
            .map((name) => `<span class="predictor-pill">${escapeHtml(name)}</span>`)
            .join("")}</div>`
        : "";
      return `
        <li class="window-row status-${status}" data-window-order="${w.order}">
          <div class="window-card-content">
            <div class="window-main">
              <span class="window-label">${escapeHtml(w.label)}</span>
              <span class="badge badge-${status}">${status}</span>
            </div>
            <div class="window-meta">
              <span class="meta-pill">${w.predictionsCount || 0} predictions</span>
            </div>
            ${predictorPills}
            ${leader ? `<div class="window-leader"><span>Window Leader</span><strong>${escapeHtml(leader.displayName)}</strong><em>${leader.points} pts</em></div>` : ""}
          </div>
        </li>`;
    })
    .join("");
}

function getPredictorNames(windowOrder) {
  const seen = new Set();
  const names = [];
  state.predictions
    .filter((p) => p.windowOrder === windowOrder)
    .forEach((p) => {
      if (seen.has(p.userId)) return;
      seen.add(p.userId);
      names.push(p.displayName || "Player");
    });
  return names;
}

function getWindowLeader(windowOrder) {
  const scored = state.predictions
    .filter((p) => p.windowOrder === windowOrder && p.scored)
    .sort((a, b) => (b.points || 0) - (a.points || 0));
  const leader = scored[0];
  return leader ? { ...leader, displayName: leader.displayName || "Player" } : null;
}

function renderLeaderboard() {
  const list = el("leaderboard");
  if (!list) return;
  if (!state.standings.length) {
    list.innerHTML = `<li class="leaderboard-empty muted">No points yet.</li>`;
    return;
  }
  list.innerHTML = state.standings
    .map(
      (s, i) => `
        <li>
          <span class="rank">${i + 1}</span>
          <span class="name">${escapeHtml(s.displayName || "Player")}</span>
          <span class="pts">${s.totalPoints || 0}</span>
        </li>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Fullscreen + utils
// ---------------------------------------------------------------------------
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
}

function show(id) {
  el(id).classList.remove("hidden");
}
function hide(id) {
  el(id).classList.add("hidden");
}

let toastTimer;
function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

function err(e) {
  return (e && e.message) || "Something went wrong.";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}
