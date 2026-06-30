// Super-admin overview: list every game (subgroup) with its subgroup admin and,
// on expand, the participants. A "Join as admin" button opens that game in the
// admin console.
import { isSuperAdmin, loginWithGoogle, logout, watchAuth } from "./auth.js";
import { getMatchParticipants, getUser, watchMatches } from "./service.js";

const el = (id) => document.getElementById(id);

const state = {
  user: null,
  matches: [],
  expanded: new Set(),
  participants: {}, // matchId -> [{displayName, predictions, points}]
  userCache: {}, // uid -> displayName/email
  unsub: { matches: null },
};

el("login-btn").addEventListener("click", () => loginWithGoogle().catch((e) => toast(err(e))));
el("logout-btn").addEventListener("click", () => logout());
el("denied-logout").addEventListener("click", () => logout());

watchAuth((user) => {
  state.user = user;
  hide("login-view");
  hide("denied-view");
  hide("overview-view");
  hide("logout-btn");
  hide("user-chip");

  if (state.unsub.matches) {
    state.unsub.matches();
    state.unsub.matches = null;
  }

  if (!user) {
    show("login-view");
    return;
  }
  el("user-chip").textContent = (user.displayName || user.email) + " (super admin)";
  show("user-chip");
  show("logout-btn");

  if (!isSuperAdmin(user)) {
    show("denied-view");
    return;
  }
  show("overview-view");
  state.unsub.matches = watchMatches((matches) => {
    state.matches = matches;
    renderSubgroups();
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderSubgroups() {
  const list = el("subgroup-list");
  if (!state.matches.length) {
    list.innerHTML = "";
    show("overview-empty");
    return;
  }
  hide("overview-empty");

  list.innerHTML = state.matches.map(renderRow).join("");

  list.querySelectorAll(".subgroup-card").forEach((card) => {
    const matchId = card.dataset.matchId;
    card.querySelector(".subgroup-summary").addEventListener("click", () => toggle(matchId));
    card.querySelector(".subgroup-summary").addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle(matchId);
      }
    });
    card.querySelector(".join-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      location.href = `admin.html?match=${encodeURIComponent(matchId)}`;
    });
  });

  resolveAdminNames();
}

function renderRow(m) {
  const open = state.expanded.has(m.id);
  const adminName = adminLabel(m);
  return `
    <li class="subgroup-card ${open ? "open" : ""}" data-match-id="${esc(m.id)}">
      <div class="subgroup-summary" role="button" tabindex="0" aria-expanded="${open}">
        <span class="subgroup-caret" aria-hidden="true">▸</span>
        <div class="subgroup-main">
          <span class="subgroup-game">${esc(m.name || "Untitled game")}</span>
          <span class="subgroup-admin" data-admin-for="${esc(m.id)}">
            <em>Subgroup admin</em> ${esc(adminName)}
          </span>
        </div>
        <button class="btn btn-primary join-btn" type="button">Join as admin</button>
      </div>
      <div class="subgroup-participants">${renderParticipants(m.id)}</div>
    </li>`;
}

function renderParticipants(matchId) {
  if (!state.expanded.has(matchId)) return "";
  const people = state.participants[matchId];
  if (people === undefined) {
    return `<p class="muted participants-note">Loading participants…</p>`;
  }
  if (!people.length) {
    return `<p class="muted participants-note">No participants yet.</p>`;
  }
  const rows = people
    .map(
      (p, i) => `
      <li>
        <span class="rank">${i + 1}</span>
        <span class="name">${esc(p.displayName)}</span>
        <span class="participant-meta">${p.predictions} pick${p.predictions === 1 ? "" : "s"}</span>
        <span class="pts">${p.points} pts</span>
      </li>`
    )
    .join("");
  return `<ol class="participant-list">${rows}</ol>`;
}

async function toggle(matchId) {
  if (state.expanded.has(matchId)) {
    state.expanded.delete(matchId);
    renderSubgroups();
    return;
  }
  state.expanded.add(matchId);
  renderSubgroups();
  if (state.participants[matchId] === undefined) {
    try {
      state.participants[matchId] = await getMatchParticipants(matchId);
    } catch (e) {
      state.participants[matchId] = [];
      toast(err(e));
    }
    if (state.expanded.has(matchId)) renderSubgroups();
  }
}

function adminLabel(m) {
  if (m.createdByName) return m.createdByName;
  if (m.createdByEmail) return m.createdByEmail;
  if (m.createdBy && state.userCache[m.createdBy]) return state.userCache[m.createdBy];
  return "Unknown";
}

// Older games only stored the creator uid — resolve names from /users lazily.
async function resolveAdminNames() {
  const missing = state.matches.filter(
    (m) => !m.createdByName && !m.createdByEmail && m.createdBy && !state.userCache[m.createdBy]
  );
  if (!missing.length) return;
  const uids = [...new Set(missing.map((m) => m.createdBy))];
  let changed = false;
  await Promise.all(
    uids.map(async (uid) => {
      const u = await getUser(uid);
      if (u) {
        state.userCache[uid] = u.displayName || u.email || "Unknown";
        changed = true;
      }
    })
  );
  if (changed) renderSubgroups();
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}
