// Admin console: manage the match clock, view the fixed window list, enter
// actual stats for completed windows, and settle / recalculate scoring.
import {
  addAdmin,
  isAdmin,
  isKnownAdmin,
  isSuperAdmin,
  loginWithGoogle,
  logout,
  removeAdmin,
  watchAdmins,
  watchAuth,
} from "./auth.js";
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
  WINDOW_COUNT,
  getWindowStatus,
} from "./windows.js";

const el = (id) => document.getElementById(id);

const state = {
  user: null,
  matchId: null,
  match: null,
  matches: [],
  windows: [],
  admins: [],
  adminsLoaded: false,
  initialized: false,
  unsub: { match: null, windows: null, admins: null },
};

const CLOCK_STATES = [
  { label: "Pre-match", period: PERIODS.PRE, matchMinute: 0 },
  { label: "0:00", period: PERIODS.FIRST_HALF, matchMinute: 0 },
  { label: "15:00", period: PERIODS.FIRST_HALF, matchMinute: 15 },
  { label: "30:00", period: PERIODS.FIRST_HALF, matchMinute: 30 },
  { label: "HT", period: PERIODS.HALFTIME, matchMinute: 45 },
  { label: "45:00", period: PERIODS.SECOND_HALF, matchMinute: 45 },
  { label: "60:00", period: PERIODS.SECOND_HALF, matchMinute: 60 },
  { label: "75:00", period: PERIODS.SECOND_HALF, matchMinute: 75 },
  { label: "FT", period: PERIODS.FULLTIME, matchMinute: 90 },
];

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
el("login-btn").addEventListener("click", () => loginWithGoogle().catch((e) => toast(err(e))));
el("logout-btn").addEventListener("click", () => logout());
el("denied-logout").addEventListener("click", () => logout());
el("add-admin-form").addEventListener("submit", onAddAdmin);
initAutoHideHeader();

watchAuth((user) => {
  state.user = user;
  hide("login-view");
  hide("denied-view");
  hide("admin-view");
  hide("manage-admins");
  hide("logout-btn");
  hide("user-chip");

  if (state.unsub.admins) {
    state.unsub.admins();
    state.unsub.admins = null;
  }
  state.adminsLoaded = false;

  if (!user) {
    show("login-view");
    return;
  }
  el("user-chip").textContent =
    (user.displayName || user.email) + (isSuperAdmin(user) ? " (super admin)" : "");
  show("user-chip");
  show("logout-btn");

  // Track the dynamic admin list: needed both to evaluate non-code admins and
  // to populate the manage-admins panel for the super admin.
  state.unsub.admins = watchAdmins((list) => {
    state.admins = list;
    state.adminsLoaded = true;
    renderAdmins();
    applyGate();
  });

  applyGate();
});

// Decide which view to show. Code-known admins (super + bootstrap) can enter
// immediately; everyone else waits until the admin list has loaded so we don't
// flash "not authorized" at a legitimate subgroup admin.
function applyGate() {
  const user = state.user;
  if (!user) return;
  if (!isKnownAdmin(user) && !state.adminsLoaded) return;

  if (!isAdmin(user)) {
    hide("admin-view");
    hide("manage-admins");
    show("denied-view");
    return;
  }
  hide("denied-view");
  show("admin-view");
  if (isSuperAdmin(user)) {
    show("manage-admins");
    show("overview-link");
  } else {
    hide("manage-admins");
    hide("overview-link");
  }
  enterAdmin();
}

function enterAdmin() {
  if (state.initialized) return;
  state.initialized = true;
  initMatches();
}

// ---------------------------------------------------------------------------
// Subgroup admins (super admin only)
// ---------------------------------------------------------------------------
async function onAddAdmin(e) {
  e.preventDefault();
  const input = el("admin-email");
  const email = (input.value || "").trim().toLowerCase();
  if (!email) return;
  if (isSuperAdmin({ email })) {
    toast("That account is already a super admin.");
    return;
  }
  try {
    await addAdmin(email, state.user);
    input.value = "";
    toast(`${email} can now create matches and invite players.`);
  } catch (e2) {
    toast(err(e2));
  }
}

function renderAdmins() {
  const list = el("admin-list");
  if (!list) return;
  if (!state.admins.length) {
    list.innerHTML = `<li class="admin-empty muted">No subgroup admins yet.</li>`;
    return;
  }
  list.innerHTML = state.admins
    .slice()
    .sort((a, b) => (a.email || a.id || "").localeCompare(b.email || b.id || ""))
    .map((a) => {
      const email = a.email || a.id;
      return `
        <li class="admin-row">
          <span class="admin-email">${esc(email)}</span>
          <button class="btn btn-ghost remove-admin" data-email="${esc(email)}">Remove</button>
        </li>`;
    })
    .join("");

  list.querySelectorAll(".remove-admin").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const email = btn.dataset.email;
      try {
        await removeAdmin(email);
        toast(`Removed ${email}.`);
      } catch (e2) {
        toast(err(e2));
      }
    });
  });
}

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
  watchMatches((allMatches) => {
    // Super admin manages every match; subgroup admins only see their own.
    const matches = isSuperAdmin(state.user)
      ? allMatches
      : allMatches.filter((m) => m.createdBy === state.user.uid);
    state.matches = matches;
    select.innerHTML = matches
      .map((m) => `<option value="${m.id}">${esc(m.name)}</option>`)
      .join("");
    if (!matches.length) {
      state.matchId = null;
      state.matches = [];
      el("windows-tbody").innerHTML = "";
      updateMatchShare();
      return;
    }
    const preferred = new URLSearchParams(location.search).get("match");
    const next =
      (state.matchId && matches.some((m) => m.id === state.matchId) && state.matchId) ||
      (preferred && matches.some((m) => m.id === preferred) && preferred) ||
      matches[0].id;
    select.value = next;
    if (next !== state.matchId) selectMatch(next);
    updateMatchShare();
  });

  select.addEventListener("change", (e) => selectMatch(e.target.value));

  el("new-match-btn").addEventListener("click", openNewMatchModal);

  el("delete-match-btn").addEventListener("click", openRemoveMatchesModal);

  el("copy-link-btn").addEventListener("click", copyPlayerLink);

  el("clock-back").addEventListener("click", () => stepClock(-1));
  el("clock-advance").addEventListener("click", () => stepClock(1));
}

function playerGameUrl(matchId) {
  const u = new URL("index.html", location.href);
  u.searchParams.set("match", matchId);
  return u.toString();
}

function updateMatchShare() {
  const share = el("match-share");
  if (!state.matchId) {
    share.classList.add("hidden");
    return;
  }
  el("match-share-url").value = playerGameUrl(state.matchId);
  share.classList.remove("hidden");
}

async function copyPlayerLink() {
  if (!state.matchId) return;
  const url = playerGameUrl(state.matchId);
  try {
    await navigator.clipboard.writeText(url);
    toast("Player link copied — share it with the group.");
  } catch {
    el("match-share-url").select();
    toast(`Share this link: ${url}`);
  }
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
      toast(`Match created with ${WINDOW_COUNT} fixed windows.`);
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
  updateMatchShare();
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
  if (match.period === PERIODS.HALFTIME) return 4;
  if (match.period === PERIODS.FULLTIME) return 8;

  const minute = Number(match.matchMinute) || 0;
  if (match.period === PERIODS.FIRST_HALF) {
    if (minute < 15) return 1;
    if (minute < 30) return 2;
    return 3;
  }

  if (match.period === PERIODS.SECOND_HALF) {
    if (minute < 60) return 5;
    if (minute < 75) return 6;
    return 7;
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
  // upcoming / active — locked by default for the MVP, with an explicit settle.
  return `<button class="btn btn-small btn-ghost" data-action="override" data-order="${w.order}" title="Settle: enter stats and score early">Settle</button>`;
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
    <p class="muted espn-note">Pulls the cumulative ESPN match totals and subtracts what's already been settled in earlier windows, so this window gets the difference. Fetch progressively as the match plays. Review the numbers, then confirm by saving.</p>
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
      const totals = await fetchEspnMatchTotals(gameId);
      const prior = sumPreviousWindowStats(window.order);
      STAT_FIELDS.forEach((f) => setStat(f, (totals[f] || 0) - (prior[f] || 0)));
      toast(`Filled ${window.label} from ESPN (match total − earlier windows). Review, then save.`);
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
// into the fixed 15-minute window being settled. Pre-fills for admin review.
// ---------------------------------------------------------------------------
let lastEspnGameId = "";

function parseEspnGameId(input) {
  if (!input) return null;
  const byPath = String(input).match(/gameId\/(\d+)/i);
  if (byPath) return byPath[1];
  const anyNum = String(input).match(/(\d{4,})/);
  return anyNum ? anyNum[1] : null;
}

// Cumulative match totals (both teams combined) from ESPN's boxscore + scoreline.
async function fetchEspnMatchTotals(gameId) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${gameId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN responded ${res.status}.`);
  const data = await res.json();

  const totals = { goals: 0, shotsOnGoal: 0, corners: 0, fouls: 0, cards: 0 };
  const statMap = {
    foulsCommitted: "fouls",
    wonCorners: "corners",
    shotsOnTarget: "shotsOnGoal",
    yellowCards: "cards",
    redCards: "cards",
  };
  (data.boxscore?.teams || []).forEach((team) => {
    (team.statistics || []).forEach((s) => {
      const key = statMap[s.name];
      if (key) totals[key] += Number(s.displayValue) || 0;
    });
  });
  // Goals come from the scoreline.
  const comp = data.header?.competitions?.[0];
  (comp?.competitors || []).forEach((c) => {
    totals.goals += Number(c.score) || 0;
  });
  return totals;
}

// Sum the actual stats already settled in windows before `currentOrder`.
function sumPreviousWindowStats(currentOrder) {
  const sum = { goals: 0, shotsOnGoal: 0, corners: 0, fouls: 0, cards: 0 };
  state.windows.forEach((w) => {
    if (w.order >= currentOrder || !w.actualStats) return;
    STAT_FIELDS.forEach((f) => {
      sum[f] += Number(w.actualStats[f]) || 0;
    });
  });
  return sum;
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
