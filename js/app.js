// Player-facing app: sign in, pick a match, update predictions for unsettled windows,
// watch the leaderboard update in realtime.
import {
  describeAuthError,
  isAdmin,
  loginWithGoogle,
  logout,
  renderSignInEnvHint,
  watchAdmins,
  watchAuth,
} from "./auth.js";
import {
  submitPredictionForFixedWindow,
  watchMatch,
  watchPredictions,
  watchStandings,
  watchUserPredictions,
  watchWindows,
} from "./service.js";
import {
  PERIODS,
  SCORING,
  STAT_FIELDS,
  STAT_LABELS,
  getCheckpointIndex,
  getNextPredictionWindow,
  getScheme,
  getSchemeCheckpoints,
  getWindowStatus,
} from "./windows.js";

const el = (id) => document.getElementById(id);

const state = {
  user: null,
  matchId: null,
  match: null,
  windows: [],
  predictions: [],
  myPredictions: {}, // windowOrder -> prediction
  unsub: { match: null, windows: null, standings: null, preds: null, allPreds: null },
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
el("share-btn").addEventListener("click", shareGame);
renderSignInEnvHint();
initAutoHideHeader();
initMobilePanelTabs();

let adminUnsub = null;

watchAuth((user) => {
  state.user = user;
  if (user) {
    el("login-view").classList.add("hidden");
    el("app-view").classList.remove("hidden");
    el("logout-btn").classList.remove("hidden");
    refreshAdminUI();
    // Watch the admin list so subgroup admins (stored in Firestore, not code)
    // are also recognized once it loads.
    if (adminUnsub) adminUnsub();
    adminUnsub = watchAdmins(refreshAdminUI);
    initMatch();
  } else {
    if (adminUnsub) {
      adminUnsub();
      adminUnsub = null;
    }
    teardown();
    el("login-view").classList.remove("hidden");
    el("app-view").classList.add("hidden");
    el("logout-btn").classList.add("hidden");
    el("user-chip").classList.add("hidden");
    el("admin-link").classList.add("hidden");
    el("share-btn").classList.add("hidden");
  }
});

// Reflect the signed-in user's admin status in the top bar: label the chip and
// only reveal the Admin link for actual admins.
function refreshAdminUI() {
  const user = state.user;
  if (!user) return;
  const admin = isAdmin(user);
  const chip = el("user-chip");
  chip.textContent = (user.displayName || user.email) + (admin ? " (admin)" : "");
  chip.classList.remove("hidden");
  el("admin-link").classList.toggle("hidden", !admin);
}

// ---------------------------------------------------------------------------
// Shareable game link
// ---------------------------------------------------------------------------
function gameUrl(matchId = state.matchId) {
  const u = new URL(location.href);
  u.hash = "";
  if (matchId) u.searchParams.set("match", matchId);
  return u.toString();
}

async function shareGame() {
  if (!state.matchId) {
    toast("Pick a match to share.");
    return;
  }
  const url = gameUrl();
  const name = state.match?.name || "this match";
  const shareData = {
    title: "PredicTen",
    text: `Join my PredicTen group and predict ${name}!`,
    url,
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return; // user dismissed the share sheet
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Game link copied — share it with your group.");
  } catch {
    toast(`Share this link: ${url}`);
  }
}

function initMobilePanelTabs() {
  const grid = document.querySelector(".grid");
  const tabs = Array.from(document.querySelectorAll(".mobile-panel-tab"));
  const panels = Array.from(document.querySelectorAll(".grid > .panel"));
  if (!grid || !tabs.length || !panels.length) return;

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      scrollToPanel(Number(tab.dataset.panelIndex), { resetVertical: true });
    });
  });

  grid.addEventListener("scroll", () => {
    if (!window.matchMedia("(max-width: 980px)").matches) return;
    const index = Math.round(grid.scrollLeft / Math.max(1, grid.clientWidth));
    setActivePanelTab(Math.min(tabs.length - 1, Math.max(0, index)));
  }, { passive: true });
}

function setActivePanelTab(index) {
  document.querySelectorAll(".mobile-panel-tab").forEach((tab) => {
    tab.classList.toggle("active", Number(tab.dataset.panelIndex) === index);
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

function scrollToPanel(index, { resetVertical = false } = {}) {
  const grid = document.querySelector(".grid");
  const panel = document.querySelector(`.grid > .panel[data-panel-index="${index}"]`);
  if (!grid || !panel) return;
  grid.scrollTo({ left: panel.offsetLeft - grid.offsetLeft, behavior: "auto" });
  setActivePanelTab(index);

  if (resetVertical && window.matchMedia("(max-width: 980px)").matches) {
    hideTopbar();
    window.requestAnimationFrame(() => scrollToGridTop());
  }
}

function hideTopbar() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  topbar.classList.add("topbar-hidden");
  document.body.classList.add("header-hidden");
}

function scrollToGridTop() {
  const grid = document.querySelector(".grid");
  const tabs = document.querySelector(".mobile-panel-tabs");
  if (!grid) return;
  const tabsHeight = tabs ? tabs.offsetHeight : 0;
  const gridTop = grid.getBoundingClientRect().top + window.scrollY;
  const targetTop = Math.max(0, gridTop - tabsHeight - 8);
  window.scrollTo({ top: targetTop, behavior: "auto" });
}

// ---------------------------------------------------------------------------
// Single match (joined via shared link — players can't switch games)
// ---------------------------------------------------------------------------
function initMatch() {
  const matchId = new URLSearchParams(location.search).get("match");
  if (!matchId) {
    showNoMatch();
    return;
  }
  el("no-match").classList.add("hidden");
  document.querySelector(".grid").classList.remove("hidden");
  selectMatch(matchId);
}

function showNoMatch() {
  teardown();
  el("no-match").classList.remove("hidden");
  document.querySelector(".grid").classList.add("hidden");
  el("share-btn").classList.add("hidden");
  el("match-name").textContent = "";
  el("match-clock").textContent = "";
}

function selectMatch(matchId) {
  state.matchId = matchId;
  state.myPredictions = {};
  history.replaceState(null, "", gameUrl(matchId));
  el("share-btn").classList.remove("hidden");
  Object.values(state.unsub).forEach((fn) => fn && fn());

  state.unsub.match = watchMatch(matchId, (match) => {
    if (!match) {
      showNoMatch();
      toast("This game link is no longer available.");
      return;
    }
    document.querySelector(".grid").classList.remove("hidden");
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
  state.unsub.allPreds = watchPredictions(matchId, (preds) => {
    state.predictions = preds;
    renderWindows();
  });
  state.unsub.preds = watchUserPredictions(matchId, state.user.uid, (preds) => {
    state.myPredictions = {};
    preds.forEach((p) => (state.myPredictions[p.windowOrder] = p));
    renderWindows();
    renderPredictArea();
  });
}

function teardown() {
  Object.values(state.unsub).forEach((fn) => fn && fn());
  state.unsub = { match: null, windows: null, standings: null, preds: null, allPreds: null };
  state.matchId = null;
  state.match = null;
  state.predictions = [];
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
  el("match-name").textContent = m.name || "";
  // Hydration matches progress by phase, not the clock, so show the phase label.
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
  if (!state.match || !state.windows.length) {
    list.innerHTML = "";
    return;
  }
  const nextOrder = nextPredictableOrder();
  list.innerHTML = state.windows
    .map((w) => {
      const status = getWindowStatus(w, state.match);
      const open = status === "upcoming";
      const isNext = open && w.order === nextOrder;
      const mine = state.myPredictions[w.order];
      const leader = status === "settled" ? getWindowLeader(w.order) : null;
      const predictors = getPredictorNames(w.order);
      const predictorPills = predictors.length
        ? `<div class="predictor-pills">${predictors
            .map((p) => `<span class="predictor-pill ${p.isMe ? "me" : ""}">${escapeHtml(p.name)}</span>`)
            .join("")}</div>`
        : "";
      return `
        <li class="window-row status-${status} ${open ? "predictable" : ""} ${isNext ? "next-up" : ""}" data-window-order="${w.order}" role="button" tabindex="0" title="Open prediction card">
          <div class="window-card-content">
            <div class="window-main">
              <span>
                <span class="window-label">${escapeHtml(w.label)}</span>
              </span>
              <span class="badge badge-${status}">${status}</span>
            </div>
            <div class="window-meta">
              ${isNext ? `<span class="meta-pill next-pill">Predict now</span>` : ""}
              <span class="meta-pill">${predictors.length} predictions</span>
              ${mine ? `<span class="meta-pill mine">${mine.scored ? `You earned ${mine.points} pts` : "Your pick is in"}</span>` : ""}
              ${open ? `<span class="open-tag" title="Editable" aria-label="Editable">✎</span>` : ""}
            </div>
            ${predictorPills}
            ${leader ? `<div class="window-leader"><span>Window Leader</span><strong>${escapeHtml(leader.displayName)}</strong><em>${leader.points} pts</em></div>` : ""}
          </div>
          <span class="window-chevron" aria-hidden="true">›</span>
        </li>`;
    })
    .join("");

  list.querySelectorAll(".window-row").forEach((row) => {
    const open = () => openPredictionCard(Number(row.dataset.windowOrder));
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });
}

function nextPredictableOrder() {
  if (!state.match) return null;
  const next = getNextPredictionWindow(state.match);
  return next ? next.order : null;
}

function getPredictorNames(windowOrder) {
  const seen = new Set();
  const names = [];
  state.predictions
    .filter((p) => p.windowOrder === windowOrder)
    .forEach((p) => {
      if (seen.has(p.userId)) return;
      seen.add(p.userId);
      names.push({
        name: p.displayName || "Player",
        isMe: state.user && p.userId === state.user.uid,
      });
    });
  // Put the current player first for quick scanning.
  names.sort((a, b) => (b.isMe ? 1 : 0) - (a.isMe ? 1 : 0));
  return names;
}

function getWindowLeader(windowOrder) {
  const scored = state.predictions
    .filter((p) => p.windowOrder === windowOrder && p.scored)
    .sort((a, b) => (b.points || 0) - (a.points || 0));
  const leader = scored[0];
  return leader ? { ...leader, displayName: leader.displayName || "Player" } : null;
}

function openPredictionCard(order) {
  scrollToPanel(0);
  const card = document.querySelector(`.prediction-card[data-window-order="${order}"]`);
  if (!card) return;
  setTimeout(() => {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("focus-flash");
    setTimeout(() => card.classList.remove("focus-flash"), 1400);
  }, 250);
}

function renderPredictArea() {
  const area = el("predict-area");
  if (!state.match) {
    area.innerHTML = "";
    return;
  }
  if (!state.windows.length) {
    area.innerHTML = `<p class="muted">Loading fixed windows…</p>`;
    return;
  }
  area.innerHTML = `
    <p class="predict-target">
      Predict upcoming windows — each closes the moment it kicks off. The highlighted window is next up.
    </p>
    <div class="prediction-stack">
      ${state.windows.map(renderPredictionForm).join("")}
    </div>`;

  area.querySelectorAll(".predict-form").forEach((form) => {
    form.querySelectorAll(".stepper-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const field = btn.dataset.field;
        const step = Number(btn.dataset.step);
        const input = form.querySelector(`input[name="${field}"]`);
        const output = form.querySelector(`[data-stat-value="${field}"]`);
        if (!input) return;
        const next = clampStat(Number(input.value) + step);
        input.value = next;
        if (output) output.textContent = next;
      });
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const order = Number(form.dataset.windowOrder);
      const window = state.windows.find((w) => w.order === order);
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        await submitPredictionForFixedWindow(state.user, state.matchId, order, data);
        toast(`Prediction saved for ${window.label}.`);
      } catch (err) {
        toast(friendlyError(err));
      }
    });
  });
}

function renderPredictionForm(window) {
  const status = getWindowStatus(window, state.match);
  const existing = state.myPredictions[window.order];

  if (status === "settled") {
    return renderSettledCard(window, existing);
  }

  // Once a window goes live (active) or has ended (completed), predictions close.
  if (status !== "upcoming") {
    return renderLockedCard(window, existing, status);
  }

  const isNext = window.order === nextPredictableOrder();
  const fields = STAT_FIELDS.map((f) => {
    const val = clampStat(existing ? existing.payload?.[f] : 0);
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

  return `
    <form class="predict-form prediction-card ${isNext ? "next-up" : ""}" data-window-order="${window.order}">
      <div class="prediction-card-head">
        <strong>${escapeHtml(window.label)}</strong>
        <span class="badge badge-${status}">${status}</span>
        ${isNext ? `<span class="next-flag">Closing next — predict now</span>` : ""}
        ${existing ? `<span class="muted">submitted</span>` : ""}
      </div>
      <div class="stat-steppers">${fields}</div>
      <button type="submit" class="btn btn-primary">
        ${existing ? "Update prediction" : "Submit prediction"}
      </button>
    </form>`;
}

function renderLockedCard(window, existing, status) {
  const note = status === "active"
    ? "In play — predictions closed."
    : "Window ended — awaiting results.";
  const head = `
    <div class="prediction-card-head">
      <strong>${escapeHtml(window.label)}</strong>
      <span class="badge badge-${status}">${status}</span>
    </div>`;
  const body = existing
    ? `<div class="stat-summary">${STAT_FIELDS.map((f) => `
        <span class="summary-chip"><b>${STAT_LABELS[f]}</b><em>${existing.payload?.[f] ?? "–"}</em></span>`).join("")}</div>`
    : `<p class="muted no-pick">No prediction made for this window.</p>`;
  return `
    <div class="prediction-card locked" data-window-order="${window.order}">
      ${head}
      <p class="muted lock-note">${note}</p>
      ${body}
    </div>`;
}

function renderSettledCard(window, existing) {
  const head = `
    <div class="prediction-card-head">
      <strong>${escapeHtml(window.label)}</strong>
      <span class="badge badge-settled">settled</span>
      ${existing && existing.scored ? `<span class="prediction-points">${existing.points || 0} pts</span>` : ""}
    </div>`;

  const actual = window.actualStats || {};

  if (!existing) {
    const actualChips = STAT_FIELDS.map((f) => `
      <span class="summary-chip">
        <b>${STAT_LABELS[f]}</b>
        <span class="chip-vals"><em class="real">${actual[f] ?? "–"}</em></span>
      </span>`).join("");
    return `
      <div class="prediction-card settled" data-window-order="${window.order}">
        ${head}
        <p class="muted no-pick">You didn't predict this window — here's the actual result.</p>
        <div class="stat-summary">${actualChips}</div>
      </div>`;
  }

  const chips = STAT_FIELDS.map((f) => {
    const mine = existing.payload?.[f] ?? "–";
    const real = actual[f] ?? "–";
    const pts = existing.breakdown?.[f];
    let tone = "";
    if (existing.scored && pts != null) {
      tone = pts <= 0 ? "miss" : pts >= SCORING[f].exact ? "exact" : "close";
    }
    // On an exact hit your pick == actual, so collapse to one number + a check.
    const vals = tone === "exact"
      ? `<em class="real">${real}</em><span class="hit-check" aria-label="exact">✓</span>`
      : `<em class="mine" title="Your pick">${mine}</em><span class="vs">→</span><em class="real" title="Actual">${real}</em>`;
    return `
      <span class="summary-chip ${tone}">
        <b>${STAT_LABELS[f]}</b>
        <span class="chip-vals">${vals}</span>
      </span>`;
  }).join("");

  return `
    <div class="prediction-card settled" data-window-order="${window.order}">
      ${head}
      <div class="stat-summary">${chips}</div>
    </div>`;
}

function clampStat(v) {
  return Math.min(10, Math.max(0, Math.round(Number(v) || 0)));
}

function renderLeaderboard(standings) {
  const list = el("leaderboard");
  if (!standings.length) {
    list.innerHTML = `<li class="leaderboard-empty muted">No points yet — be the first to predict.</li>`;
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
  return describeAuthError(e);
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
