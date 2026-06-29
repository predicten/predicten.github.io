// Player-facing app: sign in, pick a match, update predictions for unsettled windows,
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
initAutoHideHeader();
initMobilePanelTabs();

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

function initMobilePanelTabs() {
  const grid = document.querySelector(".grid");
  const tabs = Array.from(document.querySelectorAll(".mobile-panel-tab"));
  const panels = Array.from(document.querySelectorAll(".grid > .panel"));
  if (!grid || !tabs.length || !panels.length) return;

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      scrollToPanel(Number(tab.dataset.panelIndex));
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
      const shouldShow = current < 12 || delta < -8;

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

function scrollToPanel(index) {
  const grid = document.querySelector(".grid");
  const panel = document.querySelector(`.grid > .panel[data-panel-index="${index}"]`);
  if (!grid || !panel) return;
  grid.scrollTo({ left: panel.offsetLeft - grid.offsetLeft, behavior: "smooth" });
  setActivePanelTab(index);
}

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
  list.innerHTML = state.windows
    .map((w) => {
      const status = getWindowStatus(w, state.match);
      const editable = status !== "settled";
      const mine = state.myPredictions[w.order];
      return `
        <li class="window-row ${editable ? "predictable" : ""}" data-window-order="${w.order}" role="button" tabindex="0" title="Open prediction card">
          <div class="window-main">
            <span class="window-label">${escapeHtml(w.label)}</span>
            <span class="badge badge-${status}">${status}</span>
          </div>
          <div class="window-meta">
            <span>${w.predictionsCount || 0} preds</span>
            ${mine ? `<span class="mine">you: ${mine.scored ? mine.points + " pts" : "submitted"}</span>` : ""}
            ${editable ? `<span class="open-tag">editable</span>` : ""}
          </div>
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
      Settle your predictions. Slide each stat from 1–10 and submit or update any unsettled window.
    </p>
    <div class="prediction-stack">
      ${state.windows.map(renderPredictionForm).join("")}
    </div>`;

  area.querySelectorAll(".predict-form").forEach((form) => {
    if (form.dataset.settled === "true") return;

    form.querySelectorAll(".prediction-slider").forEach((slider) => {
      slider.addEventListener("input", () => {
        const output = form.querySelector(`[data-slider-value="${slider.name}"]`);
        if (output) output.textContent = slider.value;
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
  const settled = status === "settled";
  const existing = state.myPredictions[window.order];
  const fields = STAT_FIELDS.map((f) => {
    const val = Math.min(10, Math.max(1, Number(existing ? existing.payload?.[f] ?? 1 : 1)));
    return `
      <label class="field prediction-slider-field">
        <span class="prediction-slider-head">
          <span>${STAT_LABELS[f]}</span>
          <output data-slider-value="${f}">${val}</output>
        </span>
        <input class="prediction-slider" type="range" min="1" max="10" step="1" name="${f}" value="${val}" ${settled ? "disabled" : ""} />
        <span class="slider-scale"><span>1</span><span>10</span></span>
      </label>`;
  }).join("");

  return `
    <form class="predict-form prediction-card ${settled ? "settled" : ""}" data-window-order="${window.order}" data-settled="${settled}">
      <div class="prediction-card-head">
        <strong>${escapeHtml(window.label)}</strong>
        <span class="badge badge-${status}">${status}</span>
        ${existing ? `<span class="muted">${settled && existing.scored ? `${existing.points || 0} pts` : "submitted"}</span>` : ""}
      </div>
      ${fields}
      <button type="submit" class="btn btn-primary" ${settled ? "disabled" : ""}>
        ${existing ? "Update prediction" : "Submit prediction"}
      </button>
    </form>`;
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
