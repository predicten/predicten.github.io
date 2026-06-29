// Admin console: manage the match clock, view the fixed window list, enter
// actual stats for completed windows, and settle / recalculate scoring.
import { isAdmin, loginWithGoogle, logout, watchAuth } from "./auth.js";
import {
  createMatch,
  getWindowPredictions,
  importFixtureMatches,
  recalculateFixedWindowScores,
  submitManualStatsForFixedWindow,
  updateMatchClock,
  watchMatch,
  watchMatches,
  watchWindows,
} from "./service.js";
import {
  PERIODS,
  STAT_FIELDS,
  STAT_LABELS,
  getWindowStatus,
} from "./windows.js";

const el = (id) => document.getElementById(id);

const state = {
  user: null,
  matchId: null,
  match: null,
  windows: [],
  unsub: { match: null, windows: null },
  clockDirty: false,
};

const CLOCK_STATES = [
  { label: "Pre-match", period: PERIODS.PRE, matchMinute: 0 },
  { label: "0:00", period: PERIODS.FIRST_HALF, matchMinute: 0 },
  { label: "10:00", period: PERIODS.FIRST_HALF, matchMinute: 10 },
  { label: "20:00", period: PERIODS.FIRST_HALF, matchMinute: 20 },
  { label: "30:00", period: PERIODS.FIRST_HALF, matchMinute: 30 },
  { label: "40:00", period: PERIODS.FIRST_HALF, matchMinute: 40 },
  { label: "HT", period: PERIODS.HALFTIME, matchMinute: 45 },
  { label: "45:00", period: PERIODS.SECOND_HALF, matchMinute: 45 },
  { label: "55:00", period: PERIODS.SECOND_HALF, matchMinute: 55 },
  { label: "65:00", period: PERIODS.SECOND_HALF, matchMinute: 65 },
  { label: "75:00", period: PERIODS.SECOND_HALF, matchMinute: 75 },
  { label: "85:00", period: PERIODS.SECOND_HALF, matchMinute: 85 },
  { label: "FT", period: PERIODS.FULLTIME, matchMinute: 90 },
];

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
el("login-btn").addEventListener("click", () => loginWithGoogle().catch((e) => toast(err(e))));
el("logout-btn").addEventListener("click", () => logout());
el("denied-logout").addEventListener("click", () => logout());

watchAuth((user) => {
  state.user = user;
  hide("login-view");
  hide("denied-view");
  hide("admin-view");
  hide("logout-btn");
  hide("user-chip");

  if (!user) {
    show("login-view");
    return;
  }
  el("user-chip").textContent = user.displayName || user.email;
  show("user-chip");
  show("logout-btn");

  if (!isAdmin(user)) {
    show("denied-view");
    return;
  }
  show("admin-view");
  initMatches();
});

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------
function initMatches() {
  const select = el("match-select");
  watchMatches((matches) => {
    select.innerHTML = matches
      .map((m) => `<option value="${m.id}">${esc(m.name)}</option>`)
      .join("");
    if (!matches.length) {
      state.matchId = null;
      el("windows-tbody").innerHTML = "";
      return;
    }
    const next =
      (state.matchId && matches.some((m) => m.id === state.matchId) && state.matchId) ||
      matches[0].id;
    select.value = next;
    if (next !== state.matchId) selectMatch(next);
  });

  select.addEventListener("change", (e) => selectMatch(e.target.value));

  el("new-match-btn").addEventListener("click", async () => {
    const home = prompt("Home team?", "Home FC");
    if (home === null) return;
    const away = prompt("Away team?", "Away FC");
    if (away === null) return;
    try {
      const id = await createMatch({ homeTeam: home, awayTeam: away }, state.user);
      state.matchId = id;
      toast("Match created with 10 fixed windows.");
    } catch (e) {
      toast(err(e));
    }
  });

  el("import-fifa-btn").addEventListener("click", importFifaFixtures);

  el("clock-save").addEventListener("click", saveClock);
  el("clock-slider").addEventListener("input", () => {
    state.clockDirty = true;
    renderClockSliderLabel(Number(el("clock-slider").value));
  });
}

async function importFifaFixtures() {
  try {
    const res = await fetch("data/fifa-2026-06-28-matches.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not load FIFA fixture data (${res.status}).`);
    const fixtures = await res.json();
    const ids = await importFixtureMatches(fixtures, state.user);
    toast(`Imported ${ids.length} FIFA fixtures.`);
  } catch (e) {
    toast(err(e));
  }
}

function selectMatch(matchId) {
  state.matchId = matchId;
  state.clockDirty = false;
  Object.values(state.unsub).forEach((fn) => fn && fn());

  state.unsub.match = watchMatch(matchId, (match) => {
    state.match = match;
    renderClock();
    renderWindows();
  });
  state.unsub.windows = watchWindows(matchId, (windows) => {
    state.windows = windows;
    renderWindows();
  });
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------
function renderClock() {
  if (!state.match) return;
  // Don't stomp on edits the admin is mid-way through making.
  if (!state.clockDirty) {
    const sliderIndex = clockStateIndexForMatch(state.match);
    el("clock-slider").value = sliderIndex;
    renderClockSliderLabel(sliderIndex);
  }
  el("match-clock").textContent = `${state.match.period} ${state.match.matchMinute ?? 0}'`;
}

async function saveClock() {
  try {
    const clock = CLOCK_STATES[Number(el("clock-slider").value)] || CLOCK_STATES[0];
    await updateMatchClock(state.matchId, {
      period: clock.period,
      matchMinute: clock.matchMinute,
    });
    state.clockDirty = false;
    toast("Clock updated.");
  } catch (e) {
    toast(err(e));
  }
}

function renderClockSliderLabel(index) {
  const clock = CLOCK_STATES[index] || CLOCK_STATES[0];
  el("clock-slider-label").textContent = clock.label;
}

function clockStateIndexForMatch(match) {
  if (!match) return 0;
  if (match.period === PERIODS.PRE) return 0;
  if (match.period === PERIODS.HALFTIME) return 6;
  if (match.period === PERIODS.FULLTIME) return 12;

  const minute = Number(match.matchMinute) || 0;
  if (match.period === PERIODS.FIRST_HALF) {
    if (minute < 10) return 1;
    if (minute < 20) return 2;
    if (minute < 30) return 3;
    if (minute < 40) return 4;
    return 5;
  }

  if (match.period === PERIODS.SECOND_HALF) {
    if (minute < 55) return 7;
    if (minute < 65) return 8;
    if (minute < 75) return 9;
    if (minute < 85) return 10;
    return 11;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Windows table
// ---------------------------------------------------------------------------
function renderWindows() {
  const tbody = el("windows-tbody");
  if (!state.match || !state.windows.length) {
    tbody.innerHTML = "";
    return;
  }
  tbody.innerHTML = state.windows
    .map((w) => {
      const status = getWindowStatus(w, state.match);
      return `
        <tr>
          <td class="w-label">${esc(w.label)}</td>
          <td><span class="badge badge-${status}">${status}</span></td>
          <td>${w.predictionsCount || 0}</td>
          <td>${w.statsEntered ? "yes" : "no"}</td>
          <td>${actionButtons(w, status)}</td>
        </tr>`;
    })
    .join("");

  tbody.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const order = Number(btn.dataset.order);
      const action = btn.dataset.action;
      const w = state.windows.find((x) => x.order === order);
      if (action === "enter") openStatsModal(w, false);
      else if (action === "override") openStatsModal(w, true);
      else if (action === "view") openResultsModal(w);
      else if (action === "recalc") openStatsModal(w, true, true);
    });
  });
}

function actionButtons(w, status) {
  if (status === "settled") {
    return `
      <button class="btn btn-small" data-action="view" data-order="${w.order}">View results</button>
      <button class="btn btn-small btn-ghost" data-action="recalc" data-order="${w.order}">Recalculate</button>`;
  }
  if (status === "completed") {
    return `<button class="btn btn-small btn-primary" data-action="enter" data-order="${w.order}">Enter stats</button>`;
  }
  // upcoming / active — locked by default for the MVP, with an explicit override.
  return `<button class="btn btn-small btn-ghost" data-action="override" data-order="${w.order}" title="Override: enter stats early">Override</button>`;
}

// ---------------------------------------------------------------------------
// Stat entry modal
// ---------------------------------------------------------------------------
function openStatsModal(window, override, isRecalc = false) {
  const existing = window.actualStats || {};
  const fields = STAT_FIELDS.map(
    (f) => `
      <label class="field">
        <span>${STAT_LABELS[f]}</span>
        <input type="number" min="0" step="1" name="${f}" value="${existing[f] ?? 0}" />
      </label>`
  ).join("");

  el("modal-title").textContent = `${isRecalc ? "Recalculate" : "Enter stats"} — ${window.label}`;
  el("modal-body").innerHTML = `
    ${override && !isRecalc ? `<p class="warn">Override: this window is not completed yet.</p>` : ""}
    <form id="stats-form" class="stats-form">
      ${fields}
      <div class="modal-actions">
        <button type="submit" class="btn btn-primary">
          ${isRecalc ? "Save & recalculate" : "Save stats & score window"}
        </button>
      </div>
    </form>`;
  openModal();

  el("stats-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (isRecalc) {
        // Stats may have been edited too — persist them, then recalc deltas.
        await submitManualStatsForFixedWindow(
          state.matchId,
          window.order,
          data,
          state.user,
          { override: true }
        );
        await recalculateFixedWindowScores(state.matchId, window.order);
        toast(`Recalculated ${window.label}.`);
      } else {
        await submitManualStatsForFixedWindow(
          state.matchId,
          window.order,
          data,
          state.user,
          { override }
        );
        toast(`Settled ${window.label}.`);
      }
      closeModal();
    } catch (e2) {
      toast(err(e2));
    }
  });
}

async function openResultsModal(window) {
  el("modal-title").textContent = `Results — ${window.label}`;
  el("modal-body").innerHTML = `<p class="muted">Loading…</p>`;
  openModal();
  try {
    const preds = await getWindowPredictions(state.matchId, window.order);
    const actual = window.actualStats || {};
    const statsRow = STAT_FIELDS.map((f) => `${STAT_LABELS[f]}: <strong>${actual[f] ?? 0}</strong>`).join(" · ");
    const rows = preds
      .sort((a, b) => (b.points || 0) - (a.points || 0))
      .map(
        (p) => `
        <tr>
          <td>${esc(p.displayName || "Player")}</td>
          ${STAT_FIELDS.map((f) => `<td>${p.payload?.[f] ?? "-"}</td>`).join("")}
          <td class="pts">${p.points ?? 0}</td>
        </tr>`
      )
      .join("");
    el("modal-body").innerHTML = `
      <p class="actual-line">Actual — ${statsRow}</p>
      <div class="table-wrap">
        <table class="windows-table">
          <thead>
            <tr><th>Player</th>${STAT_FIELDS.map((f) => `<th>${STAT_LABELS[f]}</th>`).join("")}<th>Pts</th></tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="${STAT_FIELDS.length + 2}" class="muted">No predictions.</td></tr>`}</tbody>
        </table>
      </div>`;
  } catch (e) {
    el("modal-body").innerHTML = `<p class="warn">${esc(err(e))}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Modal + utils
// ---------------------------------------------------------------------------
el("modal-close").addEventListener("click", closeModal);
el("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});
function openModal() {
  el("modal").classList.remove("hidden");
}
function closeModal() {
  el("modal").classList.add("hidden");
  el("modal-body").innerHTML = "";
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
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

function err(e) {
  return (e && e.message) || "Something went wrong.";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}
