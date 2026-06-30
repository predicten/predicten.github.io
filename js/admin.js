// Admin console: manage the match clock, view the fixed window list, enter
// actual stats for completed windows, and settle / recalculate scoring.
import { isAdmin, loginWithGoogle, logout, watchAuth } from "./auth.js";
import {
  createMatch,
  deleteMatch,
  getWindowPredictions,
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
  matches: [],
  windows: [],
  unsub: { match: null, windows: null },
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
initAutoHideHeader();

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

function initAutoHideHeader() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  let lastScrollY = window.scrollY;
  let ticking = false;

  window.addEventListener("scroll", () => {
    if (ticking) return;
    window.requestAnimationFrame(() => {
      const current = window.scrollY;
      const delta = current - lastScrollY;
      const shouldHide = current > 48 && delta > 8;
      const shouldShow = current < 12;

      if (shouldHide) {
        topbar.classList.add("topbar-hidden");
        document.body.classList.add("header-hidden");
      } else if (shouldShow) {
        topbar.classList.remove("topbar-hidden");
        document.body.classList.remove("header-hidden");
      }

      lastScrollY = Math.max(0, current);
      ticking = false;
    });
    ticking = true;
  }, { passive: true });
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------
function initMatches() {
  const select = el("match-select");
  watchMatches((matches) => {
    state.matches = matches;
    select.innerHTML = matches
      .map((m) => `<option value="${m.id}">${esc(m.name)}</option>`)
      .join("");
    if (!matches.length) {
      state.matchId = null;
      state.matches = [];
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

  el("new-match-btn").addEventListener("click", openNewMatchModal);

  el("delete-match-btn").addEventListener("click", openRemoveMatchesModal);

  el("clock-back").addEventListener("click", () => stepClock(-1));
  el("clock-advance").addEventListener("click", () => stepClock(1));
}

function openNewMatchModal() {
  el("modal-title").textContent = "New match";
  el("modal-body").innerHTML = `
    <form id="new-match-form" class="new-match-form">
      <label class="field">
        <span>Home team</span>
        <input name="homeTeam" type="text" placeholder="Home FC" required />
      </label>
      <label class="field">
        <span>Away team</span>
        <input name="awayTeam" type="text" placeholder="Away FC" required />
      </label>
      <label class="field">
        <span>Match name</span>
        <input name="name" type="text" placeholder="Optional, defaults to Home vs Away" />
      </label>
      <label class="field">
        <span>Match date</span>
        <input name="matchDate" type="date" />
      </label>
      <label class="field">
        <span>Kickoff time</span>
        <input name="kickoffLocal" type="time" />
      </label>
      <label class="field">
        <span>Stage</span>
        <input name="stage" type="text" placeholder="Group stage, Round of 16, Final..." />
      </label>
      <label class="field">
        <span>Group</span>
        <input name="group" type="text" placeholder="Group A" />
      </label>
      <label class="field">
        <span>Venue</span>
        <input name="venue" type="text" placeholder="Stadium name" />
      </label>
      <label class="field">
        <span>City</span>
        <input name="city" type="text" placeholder="City" />
      </label>
      <div class="modal-actions">
        <button type="submit" class="btn btn-primary">Create match</button>
      </div>
    </form>`;
  openModal();

  el("new-match-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(e.target).entries());
    for (const key of Object.keys(payload)) payload[key] = String(payload[key]).trim();
    try {
      const id = await createMatch(payload, state.user);
      state.matchId = id;
      closeModal();
      toast("Match created with 10 fixed windows.");
    } catch (e2) {
      toast(err(e2));
    }
  });
}

async function removeSelectedMatch() {
  if (!state.matchId || !state.match) {
    toast("Select a match to remove.");
    return;
  }

  const ok = confirm(
    `Remove "${state.match.name}"?\n\nThis deletes the match, fixed windows, predictions, and leaderboard data for that match.`
  );
  if (!ok) return;

  try {
    await deleteMatch(state.matchId, state.user);
    state.matchId = null;
    state.match = null;
    state.windows = [];
    el("windows-tbody").innerHTML = "";
    toast("Match removed.");
  } catch (e) {
    toast(err(e));
  }
}

function openRemoveMatchesModal() {
  if (!state.matches.length) {
    toast("No matches to remove.");
    return;
  }

  el("modal-title").textContent = "Remove matches";
  el("modal-body").innerHTML = `
    <p class="muted">Select one or more matches to remove. This deletes fixed windows, predictions, and leaderboard data for each selected match.</p>
    <form id="remove-matches-form" class="remove-matches-form">
      <div class="remove-match-list">
        ${state.matches.map((match) => `
          <label class="remove-match-row">
            <input type="checkbox" name="matchId" value="${esc(match.id)}" ${match.id === state.matchId ? "checked" : ""} />
            <span>
              <strong>${esc(match.name || `${match.homeTeam || "Home"} vs ${match.awayTeam || "Away"}`)}</strong>
              <small>${esc([match.matchDate, match.kickoffLocal, match.stage].filter(Boolean).join(" · "))}</small>
            </span>
          </label>
        `).join("")}
      </div>
      <div class="modal-actions">
        <button type="submit" class="btn btn-danger">Remove selected</button>
      </div>
    </form>`;
  openModal();

  el("remove-matches-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const selected = Array.from(e.target.querySelectorAll('input[name="matchId"]:checked')).map((input) => input.value);
    if (!selected.length) {
      toast("Select at least one match.");
      return;
    }
    const ok = confirm(`Remove ${selected.length} match${selected.length === 1 ? "" : "es"}?\n\nThis cannot be undone.`);
    if (!ok) return;

    try {
      for (const matchId of selected) {
        await deleteMatch(matchId, state.user);
      }
      if (selected.includes(state.matchId)) {
        state.matchId = null;
        state.match = null;
        state.windows = [];
        el("windows-tbody").innerHTML = "";
      }
      closeModal();
      toast(`Removed ${selected.length} match${selected.length === 1 ? "" : "es"}.`);
    } catch (e2) {
      toast(err(e2));
    }
  });
}

function selectMatch(matchId) {
  state.matchId = matchId;
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
  const index = clockStateIndexForMatch(state.match);
  renderClockChips(index);
  el("match-clock").textContent = `${state.match.period} ${state.match.matchMinute ?? 0}'`;
}

function renderClockChips(activeIndex) {
  const container = el("clock-chips");
  if (!container) return;
  container.innerHTML = CLOCK_STATES.map(
    (clock, i) =>
      `<button type="button" class="clock-chip${i === activeIndex ? " active" : ""}" data-index="${i}" aria-pressed="${i === activeIndex}">${esc(clock.label)}</button>`
  ).join("");

  container.querySelectorAll(".clock-chip").forEach((btn) => {
    btn.addEventListener("click", () => saveClockIndex(Number(btn.dataset.index)));
  });

  el("clock-back").disabled = activeIndex <= 0;
  el("clock-advance").disabled = activeIndex >= CLOCK_STATES.length - 1;
}

function stepClock(delta) {
  if (!state.match) {
    toast("Select a match first.");
    return;
  }
  const current = clockStateIndexForMatch(state.match);
  const next = Math.min(CLOCK_STATES.length - 1, Math.max(0, current + delta));
  if (next === current) return;
  saveClockIndex(next);
}

async function saveClockIndex(index) {
  if (!state.matchId) {
    toast("Select a match first.");
    return;
  }
  const clock = CLOCK_STATES[index] || CLOCK_STATES[0];
  renderClockChips(index);
  try {
    await updateMatchClock(state.matchId, {
      period: clock.period,
      matchMinute: clock.matchMinute,
    });
    toast(`Clock set to ${clock.label}.`);
  } catch (e) {
    toast(err(e));
  }
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
  const fields = STAT_FIELDS.map((f) => {
    const val = clampStat(existing[f]);
    return `
      <div class="stepper-row">
        <span class="stepper-label">${STAT_LABELS[f]}</span>
        <div class="stepper">
          <button type="button" class="stepper-btn" data-step="-1" data-field="${f}" aria-label="Decrease ${STAT_LABELS[f]}">−</button>
          <output class="stepper-value" data-stat-value="${f}">${val}</output>
          <button type="button" class="stepper-btn" data-step="1" data-field="${f}" aria-label="Increase ${STAT_LABELS[f]}">+</button>
        </div>
        <input type="hidden" name="${f}" value="${val}" />
      </div>`;
  }).join("");

  el("modal-title").textContent = `${isRecalc ? "Recalculate" : "Enter stats"} — ${window.label}`;
  el("modal-body").innerHTML = `
    ${override && !isRecalc ? `<p class="warn">Override: this window is not completed yet.</p>` : ""}
    <div class="espn-fetch">
      <input type="text" id="espn-url" class="espn-input" placeholder="ESPN game URL or ID" value="${esc(state.match?.espnGameId || lastEspnGameId || "")}" />
      <button type="button" id="espn-fetch-btn" class="btn btn-ghost">Fetch from ESPN</button>
    </div>
    <p class="muted espn-note">Auto-fills this window from ESPN match commentary. Review the numbers, then confirm by saving. Goals, cards and corners are reliable; fouls and shots on goal are approximate.</p>
    <form id="stats-form" class="stats-form">
      <div class="stat-steppers">${fields}</div>
      <div class="modal-actions">
        <button type="submit" class="btn btn-primary">
          ${isRecalc ? "Save & recalculate" : "Save stats & score window"}
        </button>
      </div>
    </form>`;
  openModal();

  const statsForm = el("stats-form");
  const setStat = (field, value) => {
    const input = statsForm.querySelector(`input[name="${field}"]`);
    const output = statsForm.querySelector(`[data-stat-value="${field}"]`);
    const next = clampStat(value);
    if (input) input.value = next;
    if (output) output.textContent = next;
  };

  statsForm.querySelectorAll(".stepper-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const field = btn.dataset.field;
      const step = Number(btn.dataset.step);
      const input = statsForm.querySelector(`input[name="${field}"]`);
      if (!input) return;
      setStat(field, Number(input.value) + step);
    });
  });

  el("espn-fetch-btn").addEventListener("click", async () => {
    const gameId = parseEspnGameId(el("espn-url").value);
    if (!gameId) {
      toast("Enter a valid ESPN game URL or ID.");
      return;
    }
    lastEspnGameId = gameId;
    const btn = el("espn-fetch-btn");
    btn.disabled = true;
    btn.textContent = "Fetching…";
    try {
      const stats = await fetchEspnWindowStats(gameId, window.order);
      STAT_FIELDS.forEach((f) => setStat(f, stats[f]));
      toast(`Filled ${window.label} from ESPN — review, then save to settle.`);
    } catch (e) {
      toast(err(e));
    } finally {
      btn.disabled = false;
      btn.textContent = "Fetch from ESPN";
    }
  });

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

function clampStat(v) {
  return Math.min(10, Math.max(0, Math.round(Number(v) || 0)));
}

// ---------------------------------------------------------------------------
// ESPN auto-fill: scrape a match's summary feed and bucket timestamped events
// into the fixed 10-minute window being settled. Pre-fills for admin review.
// ---------------------------------------------------------------------------
let lastEspnGameId = "";

function parseEspnGameId(input) {
  if (!input) return null;
  const byPath = String(input).match(/gameId\/(\d+)/i);
  if (byPath) return byPath[1];
  const anyNum = String(input).match(/(\d{4,})/);
  return anyNum ? anyNum[1] : null;
}

// Map an ESPN clock string ("7'", "45'+2'", "90'+3'") to a fixed window order.
function espnMinuteToWindowOrder(displayValue) {
  if (!displayValue) return null;
  const s = String(displayValue).trim();
  const base = parseInt(s, 10);
  if (!Number.isFinite(base)) return null;
  const stoppage = s.includes("+");
  if (stoppage) {
    if (base >= 90) return 9; // second-half stoppage -> 85:00–FT
    if (base >= 45) return 4; // first-half stoppage -> 40:00–HT
    return null;
  }
  if (base <= 10) return 0;
  if (base <= 20) return 1;
  if (base <= 30) return 2;
  if (base <= 40) return 3;
  if (base <= 45) return 4;
  if (base <= 55) return 5;
  if (base <= 65) return 6;
  if (base <= 75) return 7;
  if (base <= 85) return 8;
  return 9;
}

async function fetchEspnWindowStats(gameId, order) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${gameId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN responded ${res.status}.`);
  const data = await res.json();

  const stats = { goals: 0, shotsOnGoal: 0, corners: 0, fouls: 0, cards: 0 };

  // Goals + cards come from keyEvents (reliable minute + type).
  (data.keyEvents || []).forEach((e) => {
    if (espnMinuteToWindowOrder(e.clock?.displayValue) !== order) return;
    const type = (e.type?.text || "").toLowerCase();
    if (e.scoringPlay) {
      stats.goals += 1;
      stats.shotsOnGoal += 1; // a goal is a shot on target
    }
    if (type.includes("yellow card") || type.includes("red card")) stats.cards += 1;
  });

  // Corners, fouls, shots on target parsed from timestamped commentary.
  (data.commentary || []).forEach((c) => {
    if (espnMinuteToWindowOrder(c.time?.displayValue) !== order) return;
    const tx = (c.text || "").toLowerCase();
    if (/\bcorner\b/.test(tx)) stats.corners += 1;
    if (/\bfoul by\b/.test(tx)) stats.fouls += 1;
    if (tx.includes("attempt saved")) stats.shotsOnGoal += 1;
  });

  return stats;
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
