// Firestore data layer. Implements the core game functions on top of the
// pure logic in windows.js.
//
// Data model:
//   matches/{matchId}                         -> match + live clock (period, matchMinute)
//   matches/{matchId}/windows/{order}         -> one doc per fixed window (order "0".."9")
//   matches/{matchId}/predictions/{uid_order} -> one prediction per user per window
//   matches/{matchId}/standings/{uid}         -> running total points per player
//   users/{uid}                               -> profile
import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import {
  FIXED_WINDOW_SCHEDULE,
  PERIODS,
  STAT_FIELDS,
  getWindowStatus,
  scorePrediction,
} from "./windows.js";

const matchRef = (matchId) => doc(db, "matches", matchId);
const windowsCol = (matchId) => collection(db, "matches", matchId, "windows");
const windowRef = (matchId, order) => doc(db, "matches", matchId, "windows", String(order));
const predictionsCol = (matchId) => collection(db, "matches", matchId, "predictions");
const predictionRef = (matchId, uid, order) =>
  doc(db, "matches", matchId, "predictions", `${uid}_${order}`);
const standingsCol = (matchId) => collection(db, "matches", matchId, "standings");
const standingRef = (matchId, uid) => doc(db, "matches", matchId, "standings", uid);

function cleanStats(payload = {}) {
  const out = {};
  for (const field of STAT_FIELDS) {
    const n = Number(payload[field]);
    out[field] = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Match + window setup
// ---------------------------------------------------------------------------

export async function createMatch({
  name,
  homeTeam,
  awayTeam,
  homeCode,
  awayCode,
  matchDate,
  kickoffLocal,
  stage,
  group,
  venue,
  city,
}, adminUser) {
  const ref = doc(collection(db, "matches"));
  await setDoc(ref, {
    name: name || `${homeTeam} vs ${awayTeam}`,
    homeTeam: homeTeam || "Home",
    awayTeam: awayTeam || "Away",
    homeCode: homeCode || null,
    awayCode: awayCode || null,
    matchDate: matchDate || null,
    kickoffLocal: kickoffLocal || null,
    stage: stage || null,
    group: group || null,
    venue: venue || null,
    city: city || null,
    period: PERIODS.PRE,
    matchMinute: 0,
    createdAt: serverTimestamp(),
    createdBy: adminUser ? adminUser.uid : null,
    createdByName: adminUser ? (adminUser.displayName || adminUser.email || null) : null,
    createdByEmail: adminUser ? (adminUser.email || "").toLowerCase() : null,
  });
  await createFixedPredictionWindowsForMatch(ref.id);
  return ref.id;
}

// Delete a match and the app-owned subcollections below it.
export async function deleteMatch(matchId, adminUser) {
  if (!adminUser) throw new Error("Admin sign-in is required to remove matches.");
  const batch = writeBatch(db);
  const [windowsSnap, predictionsSnap, standingsSnap] = await Promise.all([
    getDocs(windowsCol(matchId)),
    getDocs(predictionsCol(matchId)),
    getDocs(standingsCol(matchId)),
  ]);

  windowsSnap.forEach((d) => batch.delete(d.ref));
  predictionsSnap.forEach((d) => batch.delete(d.ref));
  standingsSnap.forEach((d) => batch.delete(d.ref));
  batch.delete(matchRef(matchId));

  await batch.commit();
}

// Create the 10 fixed match windows for a match. Identical for every player.
export async function createFixedPredictionWindowsForMatch(matchId) {
  const batch = writeBatch(db);
  for (const w of FIXED_WINDOW_SCHEDULE) {
    batch.set(
      windowRef(matchId, w.order),
      {
        order: w.order,
        key: w.key,
        label: w.label,
        period: w.period,
        startMin: w.startMin,
        endMin: w.endMin,
        predictionsCount: 0,
        statsEntered: false,
        actualStats: null,
        settled: false,
        settledAt: null,
      },
      { merge: true }
    );
  }
  await batch.commit();
  return FIXED_WINDOW_SCHEDULE.length;
}

// Admin clock control (no live feed in the MVP — admin advances the match).
export function updateMatchClock(matchId, { period, matchMinute }) {
  const patch = { updatedAt: serverTimestamp() };
  if (period !== undefined) patch.period = period;
  if (matchMinute !== undefined) patch.matchMinute = Math.max(0, Math.round(Number(matchMinute) || 0));
  return updateDoc(matchRef(matchId), patch);
}

// ---------------------------------------------------------------------------
// Predictions
// ---------------------------------------------------------------------------

// Submit or update a prediction for any fixed window that has not been settled.
export async function submitPredictionForFixedWindow(user, matchId, windowId, predictionPayload) {
  if (!user) throw new Error("You must be signed in to predict.");
  const match = await getMatch(matchId);
  if (!match) throw new Error("Match not found.");
  const order = Number(windowId);
  const windowSnap = await getDoc(windowRef(matchId, order));
  if (!windowSnap.exists()) throw new Error("Window not found.");

  const window = windowSnap.data();
  if (getWindowStatus(window, match) === "settled") {
    throw new Error(`Predictions are locked because ${window.label} is settled.`);
  }

  const ref = predictionRef(matchId, user.uid, order);
  const existing = await getDoc(ref);
  const payload = cleanStats(predictionPayload);

  await setDoc(
    ref,
    {
      userId: user.uid,
      displayName: user.displayName || user.email || "Player",
      windowOrder: order,
      windowLabel: window.label,
      payload,
      points: existing.exists() ? existing.data().points ?? 0 : 0,
      scored: existing.exists() ? existing.data().scored ?? false : false,
      updatedAt: serverTimestamp(),
      createdAt: existing.exists() ? existing.data().createdAt ?? serverTimestamp() : serverTimestamp(),
    },
    { merge: true }
  );

  if (!existing.exists()) {
    await updateDoc(windowRef(matchId, order), { predictionsCount: increment(1) });
  }
  return ref.id;
}

// ---------------------------------------------------------------------------
// Admin stat entry + scoring
// ---------------------------------------------------------------------------

// Admin enters the actual stats for a completed fixed window, then scoring runs.
export async function submitManualStatsForFixedWindow(
  matchId,
  windowId,
  statsPayload,
  adminUser,
  { override = false } = {}
) {
  const match = await getMatch(matchId);
  if (!match) throw new Error("Match not found.");
  const windowSnap = await getDoc(windowRef(matchId, windowId));
  if (!windowSnap.exists()) throw new Error("Window not found.");
  const window = windowSnap.data();

  const status = getWindowStatus(window, match);
  if (status !== "completed" && status !== "settled" && !override) {
    throw new Error(
      `Stats can only be entered for completed windows. "${window.label}" is ${status}.`
    );
  }

  await updateDoc(windowRef(matchId, windowId), {
    actualStats: cleanStats(statsPayload),
    statsEntered: true,
    statsEnteredBy: adminUser ? adminUser.uid : null,
    statsEnteredAt: serverTimestamp(),
  });

  return scoreFixedWindow(matchId, windowId);
}

// Score every prediction for a fixed window and mark it settled.
export async function scoreFixedWindow(matchId, windowId) {
  await applyScores(matchId, windowId);
  await updateDoc(windowRef(matchId, windowId), {
    settled: true,
    settledAt: serverTimestamp(),
  });
}

// Re-run scoring for an already-settled window (e.g. admin corrected stats).
// Stays settled; standings are adjusted by the delta so totals never drift.
export async function recalculateFixedWindowScores(matchId, windowId) {
  const windowSnap = await getDoc(windowRef(matchId, windowId));
  if (!windowSnap.exists()) throw new Error("Window not found.");
  if (!windowSnap.data().statsEntered) {
    throw new Error("Cannot recalculate before stats have been entered.");
  }
  await applyScores(matchId, windowId);
  await updateDoc(windowRef(matchId, windowId), { recalculatedAt: serverTimestamp() });
}

// Shared scoring core. Computes each prediction's points, writes the delta from
// its previously stored points, and adjusts the player's running total so this
// is safe to run repeatedly (initial scoring and recalculation).
async function applyScores(matchId, windowId) {
  const windowSnap = await getDoc(windowRef(matchId, windowId));
  if (!windowSnap.exists()) throw new Error("Window not found.");
  const window = windowSnap.data();
  const actual = window.actualStats;
  if (!actual) throw new Error("No actual stats to score against.");

  const predsSnap = await getDocs(
    query(predictionsCol(matchId), where("windowOrder", "==", Number(windowId)))
  );

  const batch = writeBatch(db);
  predsSnap.forEach((predDoc) => {
    const pred = predDoc.data();
    const { total, breakdown } = scorePrediction(pred.payload, actual);
    const previous = pred.points ?? 0;
    const delta = total - previous;

    batch.update(predDoc.ref, {
      points: total,
      breakdown,
      scored: true,
      scoredAt: serverTimestamp(),
    });

    batch.set(
      standingRef(matchId, pred.userId),
      {
        userId: pred.userId,
        displayName: pred.displayName || "Player",
        totalPoints: increment(delta),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });

  await batch.commit();
  return predsSnap.size;
}

// ---------------------------------------------------------------------------
// Reads + realtime subscriptions
// ---------------------------------------------------------------------------

export async function getMatch(matchId) {
  const snap = await getDoc(matchRef(matchId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getUser(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Unique participants of a game, derived from their predictions. Returns each
// player with how many windows they predicted and their points so far.
export async function getMatchParticipants(matchId) {
  const snap = await getDocs(predictionsCol(matchId));
  const byUser = new Map();
  snap.forEach((d) => {
    const p = d.data();
    const cur = byUser.get(p.userId) || {
      userId: p.userId,
      displayName: p.displayName || "Player",
      predictions: 0,
      points: 0,
    };
    cur.predictions += 1;
    cur.points += p.points || 0;
    if (p.displayName) cur.displayName = p.displayName;
    byUser.set(p.userId, cur);
  });
  return Array.from(byUser.values()).sort((a, b) => b.points - a.points);
}

export function watchMatches(callback) {
  return onSnapshot(query(collection(db, "matches"), orderBy("createdAt", "desc")), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function watchMatch(matchId, callback) {
  return onSnapshot(matchRef(matchId), (snap) => {
    callback(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

export function watchWindows(matchId, callback) {
  return onSnapshot(query(windowsCol(matchId), orderBy("order")), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function watchStandings(matchId, callback) {
  return onSnapshot(query(standingsCol(matchId), orderBy("totalPoints", "desc")), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function watchUserPredictions(matchId, uid, callback) {
  return onSnapshot(
    query(predictionsCol(matchId), where("userId", "==", uid)),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export function watchPredictions(matchId, callback) {
  return onSnapshot(predictionsCol(matchId), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function getWindowPredictions(matchId, windowId) {
  const snap = await getDocs(
    query(predictionsCol(matchId), where("windowOrder", "==", Number(windowId)))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
