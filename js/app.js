// Player-facing app: sign in, pick a match, predict the next fixed window,
// watch the leaderboard update in realtime.
import { isAdmin, loginWithGoogle, logout, watchAuth } from "./auth.js";
import {
  submitPredictionForFixedWindow,
  watchMatch,
  watchMatches,
  watchStandings,
  watchUserPredictions,
  watchWindows,
} from "./service.js";
import {
  PERIODS,
  STAT_FIELDS,
  STAT_LABELS,
  getNextFixedPredictionWindow,
  getWindowStatus,
} from "./windows.js";

const el = (id) => document.getElementById(id);

const state = {
  user: null,
  matchId: null,
  match: null,
  windows: [],
  myPredictions: {}, // windowOrder -> prediction
  unsub: { match: null, windows: null, standings: null, preds: null },
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
el("login-btn").addEventListener("click", async () => {
  try {
    await loginWithGoogle();
  } catch (e) {
    toast(friendlyError(e));
  }
});
el("logout-btn").addEventListener("click", () => logout());

watchAuth((user) => {
  state.user = user;
  if (user) {
    el("login-view").classList.add("hidden");
    el("app-view").classList.remove("hidden");
    el("logout-btn").classList.remove("hidden");
    const chip = el("user-chip");
    chip.textContent = (user.displayName || user.email) + (isAdmin(user) ? " (admin)" : "");
    chip.classList.remove("hidden");
    initMatches();
  } else {
    teardown();
    el("login-view").classList.remove("hidden");
    el("app-view").classList.add("hidden");
    el("logout-btn").classList.add("hidden");
    el("user-chip").classList.add("hidden");
  }
});

// ---------------------------------------------------------------------------
// Match selection
// ---------------------------------------------------------------------------
function initMatches() {
  const select = el("match-select");
  watchMatches((matches) => {
    if (!matches.length) {
      el("no-matches").classList.remove("hidden");
      select.innerHTML = "";
      return;
    }
    el("no-matches").classList.add("hidden");
    const current = state.matchId;
    select.innerHTML = matches
      .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`)
      .join("");
    const preferred = new URLSearchParams(location.search).get("match");
    const next =
      (current && matches.some((m) => m.id === current) && current) ||
      (preferred && matches.some((m) => m.id === preferred) && preferred) ||
      matches[0].id;
    select.value = next;
    if (next !== state.matchId) selectMatch(next);
  });

  select.addEventListener("change", (e) => selectMatch(e.target.value));
}

function selectMatch(matchId) {
  state.matchId = matchId;
  state.myPredictions = {};
  Object.values(state.unsub).forEach((fn) => fn && fn());

  state.unsub.match = watchMatch(matchId, (match) => {
    state.match = match;
    renderClock();
    renderWindows();
    renderPredictArea();
  });
  state.unsub.windows = watchWindows(matchId, (windows) => {
    state.windows = windows;
    renderWindows();
    renderPredictArea();
  });
  state.unsub.standings = watchStandings(matchId, renderLeaderboard);
  state.unsub.preds = watchUserPredictions(matchId, state.user.uid, (preds) => {
    state.myPredictions = {};
    preds.forEach((p) => (state.myPredictions[p.windowOrder] = p));
    renderWindows();
    renderPredictArea();
  });
}

function teardown() {
  Object.values(state.unsub).forEach((fn) => fn && fn());
  state.unsub = { match: null, windows: null, standings: null, preds: null };
  state.matchId = null;
  state.match = null;
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
  if (!state.match) return;
  const m = state.match;
  const minute =
    m.period === PERIODS.FIRST_HALF || m.period === PERIODS.SECOND_HALF
      ? `${m.matchMinute}'`
      : "";
  el("match-clock").textContent = `${PERIOD_LABEL[m.period] || m.period} ${minute}`.trim();
}

function renderWindows() {
  const list = el("window-list");
  if (!state.match || !state.windows.length) {
    list.innerHTML = "";
    return;
  }
  const next = getNextFixedPredictionWindow(state.match.matchMinute, state.match.period);
  list.innerHTML = state.windows
    .map((w) => {
      const status = getWindowStatus(w, state.match);
      const predictable = next && next.order === w.order;
      const mine = state.myPredictions[w.order];
      return `
        <li class="window-row ${predictable ? "predictable" : ""}">
          <div class="window-main">
            <span class="window-label">${escapeHtml(w.label)}</span>
            <span class="badge badge-${status}">${status}</span>
          </div>
          <div class="window-meta">
            <span>${w.predictionsCount || 0} preds</span>
            ${mine ? `<span class="mine">you: ${mine.scored ? mine.points + " pts" : "submitted"}</span>` : ""}
            ${predictable ? `<span class="open-tag">open</span>` : ""}
          </div>
        </li>`;
    })
    .join("");
}

function renderPredictArea() {
  const area = el("predict-area");
  if (!state.match) {
    area.innerHTML = "";
    return;
  }
  const next = getNextFixedPredictionWindow(state.match.matchMinute, state.match.period);
  if (!next) {
    area.innerHTML = `<p class="muted">No window is open for predictions right now.</p>`;
    return;
  }
  const existing = state.myPredictions[next.order];
  const fields = STAT_FIELDS.map((f) => {
    const val = existing ? existing.payload?.[f] ?? 0 : 0;
    return `
      <label class="field">
        <span>${STAT_LABELS[f]}</span>
        <input type="number" min="0" step="1" name="${f}" value="${val}" />
      </label>`;
  }).join("");

  area.innerHTML = `
    <p class="predict-target">
      Next open window: <strong>${escapeHtml(next.label)}</strong>
      ${existing ? `<span class="muted">— you can update until it starts</span>` : ""}
    </p>
    <form id="predict-form" class="predict-form">
      ${fields}
      <button type="submit" class="btn btn-primary">
        ${existing ? "Update prediction" : "Submit prediction"}
      </button>
    </form>`;

  el("predict-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      await submitPredictionForFixedWindow(state.user, state.matchId, next.order, data);
      toast(`Prediction saved for ${next.label}.`);
    } catch (err) {
      toast(friendlyError(err));
    }
  });
}

function renderLeaderboard(standings) {
  const list = el("leaderboard");
  if (!standings.length) {
    list.innerHTML = `<li class="muted">No points yet — be the first to predict.</li>`;
    return;
  }
  list.innerHTML = standings
    .map((s, i) => {
      const me = state.user && s.userId === state.user.uid ? "me" : "";
      return `
        <li class="${me}">
          <span class="rank">${i + 1}</span>
          <span class="name">${escapeHtml(s.displayName || "Player")}</span>
          <span class="pts">${s.totalPoints || 0}</span>
        </li>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

function friendlyError(e) {
  if (e && e.code === "auth/popup-closed-by-user") return "Sign-in cancelled.";
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
