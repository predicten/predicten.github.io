// Pure fixed-window logic. No Firebase here so it can be unit-tested in isolation.
//
// The game uses FIXED match windows that are identical for every player.
// It does NOT use rolling windows based on when a user joins.
//
// A match can use one of two WINDOW SCHEMES, chosen when the match is created:
//   - "fixed15":   six fixed 15-minute windows driven by the match minute.
//   - "hydration": four windows split by the two in-play hydration/drinks
//                  breaks. Because those breaks happen at referee-decided
//                  minutes (not fixed clock times), this scheme progresses by
//                  admin-triggered phase checkpoints rather than the minute.

// Match periods.
export const PERIODS = {
  PRE: "PRE", // kickoff has not happened yet
  FIRST_HALF: "FIRST_HALF",
  HALFTIME: "HALFTIME",
  SECOND_HALF: "SECOND_HALF",
  FULLTIME: "FULLTIME",
};

// The stat fields a window is predicted/scored on.
export const STAT_FIELDS = ["goals", "shotsOnGoal", "corners", "fouls", "cards"];

export const STAT_LABELS = {
  goals: "Goals",
  shotsOnGoal: "Shots on goal",
  corners: "Corners",
  fouls: "Fouls",
  cards: "Cards",
};

// Scoring config: exact hit vs within-one ("close") points per stat.
export const SCORING = {
  goals: { exact: 10, close: 4 },
  shotsOnGoal: { exact: 6, close: 2 },
  corners: { exact: 6, close: 2 },
  fouls: { exact: 4, close: 1 },
  cards: { exact: 5, close: 2 },
};

// ---------------------------------------------------------------------------
// Window schemes
// ---------------------------------------------------------------------------
// Each scheme defines:
//   windows:     the ordered window docs created for a match. `order` is the
//                stable id used everywhere (Firestore doc id, prediction key).
//   checkpoints: the admin match-clock steps. Each carries the number of
//                windows fully ended (`completed`) and the window currently in
//                play (`active`, -1 when between windows) at that checkpoint,
//                plus a nominal `matchMinute` for display / fixed-scheme
//                minute derivation.

// Fixed 15-minute scheme. The two "open ended" windows (30–HT and 75–FT)
// absorb stoppage time and are closed by a period transition rather than a
// minute.
const FIXED15_WINDOWS = [
  { order: 0, key: "0-15", label: "0:00–15:00", period: PERIODS.FIRST_HALF, startMin: 0, endMin: 15 },
  { order: 1, key: "15-30", label: "15:00–30:00", period: PERIODS.FIRST_HALF, startMin: 15, endMin: 30 },
  { order: 2, key: "30-HT", label: "30:00–HT", period: PERIODS.FIRST_HALF, startMin: 30, endMin: 45 },
  { order: 3, key: "45-60", label: "45:00–60:00", period: PERIODS.SECOND_HALF, startMin: 45, endMin: 60 },
  { order: 4, key: "60-75", label: "60:00–75:00", period: PERIODS.SECOND_HALF, startMin: 60, endMin: 75 },
  { order: 5, key: "75-FT", label: "75:00–FT", period: PERIODS.SECOND_HALF, startMin: 75, endMin: 90 },
];

const FIXED15_CHECKPOINTS = [
  { key: "pre", label: "Pre-match", period: PERIODS.PRE, matchMinute: 0, completed: 0, active: -1 },
  { key: "0", label: "0:00", period: PERIODS.FIRST_HALF, matchMinute: 0, completed: 0, active: 0 },
  { key: "15", label: "15:00", period: PERIODS.FIRST_HALF, matchMinute: 15, completed: 1, active: 1 },
  { key: "30", label: "30:00", period: PERIODS.FIRST_HALF, matchMinute: 30, completed: 2, active: 2 },
  { key: "ht", label: "HT", period: PERIODS.HALFTIME, matchMinute: 45, completed: 3, active: -1 },
  { key: "45", label: "45:00", period: PERIODS.SECOND_HALF, matchMinute: 45, completed: 3, active: 3 },
  { key: "60", label: "60:00", period: PERIODS.SECOND_HALF, matchMinute: 60, completed: 4, active: 4 },
  { key: "75", label: "75:00", period: PERIODS.SECOND_HALF, matchMinute: 75, completed: 5, active: 5 },
  { key: "ft", label: "FT", period: PERIODS.FULLTIME, matchMinute: 90, completed: 6, active: -1 },
];

// Hydration-break scheme: one window per playing segment between breaks.
const HYDRATION_WINDOWS = [
  { order: 0, key: "start-b1", label: "Start – 1st break", period: PERIODS.FIRST_HALF, startMin: 0, endMin: null },
  { order: 1, key: "b1-HT", label: "1st break – HT", period: PERIODS.FIRST_HALF, startMin: null, endMin: 45 },
  { order: 2, key: "HT-b2", label: "HT – 2nd break", period: PERIODS.SECOND_HALF, startMin: 45, endMin: null },
  { order: 3, key: "b2-FT", label: "2nd break – FT", period: PERIODS.SECOND_HALF, startMin: null, endMin: 90 },
];

const HYDRATION_CHECKPOINTS = [
  { key: "pre", label: "Pre-match", period: PERIODS.PRE, matchMinute: 0, completed: 0, active: -1 },
  { key: "ko", label: "Kickoff", period: PERIODS.FIRST_HALF, matchMinute: 0, completed: 0, active: 0 },
  { key: "break1", label: "1st break", period: PERIODS.FIRST_HALF, matchMinute: 30, completed: 1, active: 1 },
  { key: "ht", label: "HT", period: PERIODS.HALFTIME, matchMinute: 45, completed: 2, active: -1 },
  { key: "2h", label: "2nd half", period: PERIODS.SECOND_HALF, matchMinute: 45, completed: 2, active: 2 },
  { key: "break2", label: "2nd break", period: PERIODS.SECOND_HALF, matchMinute: 75, completed: 3, active: 3 },
  { key: "ft", label: "FT", period: PERIODS.FULLTIME, matchMinute: 90, completed: 4, active: -1 },
];

export const WINDOW_SCHEMES = {
  fixed15: {
    id: "fixed15",
    label: "Fixed 15-minute windows",
    shortLabel: "15 min",
    description: "Six 15-minute windows across the match.",
    windows: FIXED15_WINDOWS,
    checkpoints: FIXED15_CHECKPOINTS,
  },
  hydration: {
    id: "hydration",
    label: "Hydration-break windows",
    shortLabel: "Hydration Break",
    description: "Four windows split by the two in-play hydration breaks.",
    windows: HYDRATION_WINDOWS,
    checkpoints: HYDRATION_CHECKPOINTS,
  },
};

export const DEFAULT_WINDOW_SCHEME = "fixed15";

// Backward-compatible aliases for the original fixed scheme.
export const FIXED_WINDOW_SCHEDULE = FIXED15_WINDOWS;
export const WINDOW_COUNT = FIXED15_WINDOWS.length;

// Resolve the scheme for a match, defaulting to fixed15 for legacy matches
// created before schemes existed.
export function getScheme(match) {
  const id = match?.windowScheme;
  return WINDOW_SCHEMES[id] || WINDOW_SCHEMES[DEFAULT_WINDOW_SCHEME];
}

export function getSchemeWindows(match) {
  return getScheme(match).windows;
}

export function getWindowCount(match) {
  return getScheme(match).windows.length;
}

export function getSchemeCheckpoints(match) {
  return getScheme(match).checkpoints;
}

// ---------------------------------------------------------------------------
// Clock / phase resolution
// ---------------------------------------------------------------------------

// Derive the checkpoint index from a legacy (period + matchMinute) clock, used
// for matches that predate the stored `phaseIndex` and as a safety fallback.
function deriveCheckpointIndex(checkpoints, period, matchMinute) {
  const minute = Number(matchMinute) || 0;
  if (period === PERIODS.FIRST_HALF || period === PERIODS.SECOND_HALF) {
    let idx = -1;
    checkpoints.forEach((cp, i) => {
      if (cp.period === period && (Number(cp.matchMinute) || 0) <= minute) idx = i;
    });
    if (idx >= 0) return idx;
  }
  const exact = checkpoints.findIndex((cp) => cp.period === period);
  return exact >= 0 ? exact : 0;
}

// The admin match-clock checkpoint the match is currently at.
export function getCheckpointIndex(match) {
  const checkpoints = getSchemeCheckpoints(match);
  const phase = match?.phaseIndex;
  if (typeof phase === "number" && phase >= 0 && phase < checkpoints.length) {
    return phase;
  }
  return deriveCheckpointIndex(checkpoints, match?.period ?? PERIODS.PRE, match?.matchMinute ?? 0);
}

function currentCheckpoint(match) {
  return getSchemeCheckpoints(match)[getCheckpointIndex(match)];
}

// ---------------------------------------------------------------------------
// Window status derivation (scheme-agnostic — driven by the checkpoint)
// ---------------------------------------------------------------------------

// Number of windows that have fully ended (and are therefore "completed" or later).
export function getCompletedCount(match) {
  return currentCheckpoint(match).completed;
}

// Index of the window the match is currently inside, or -1 if none
// (PRE / HALFTIME / FULLTIME / between-window breaks have no active window).
export function getActiveIndex(match) {
  return currentCheckpoint(match).active;
}

// The window the match is currently inside, or null.
export function getCurrentWindow(match) {
  const idx = getActiveIndex(match);
  return idx >= 0 ? getSchemeWindows(match)[idx] : null;
}

// Index of the next window that has NOT started yet and is open for predictions.
function getNextPredictableIndex(match) {
  const active = getActiveIndex(match);
  const completed = getCompletedCount(match);
  // When a window is in play the next one opens; between windows (PRE, breaks,
  // HT) the next window to start is the first that has not yet completed.
  const idx = active >= 0 ? active + 1 : completed;
  if (idx < 0 || idx >= getWindowCount(match)) return -1;
  return idx;
}

// The only window a user is allowed to predict right now, or null.
export function getNextPredictionWindow(match) {
  const idx = getNextPredictableIndex(match);
  return idx >= 0 ? getSchemeWindows(match)[idx] : null;
}

// Status of a given window: "upcoming" | "active" | "completed" | "settled".
// `window` needs at least { order, settled }. `match` needs { windowScheme,
// phaseIndex } (or a legacy { period, matchMinute }).
export function getWindowStatus(window, match) {
  if (window && window.settled) return "settled";
  const completed = getCompletedCount(match);
  const active = getActiveIndex(match);
  if (window.order < completed) return "completed";
  if (window.order === active) return "active";
  return "upcoming";
}

// True if `window` is the single window currently open for predictions.
export function isWindowPredictable(window, match) {
  const next = getNextPredictionWindow(match);
  return !!next && next.order === window.order;
}

// Score one prediction payload against the actual stats. Pure + deterministic.
export function scorePrediction(payload = {}, actual = {}) {
  let total = 0;
  const breakdown = {};
  for (const field of STAT_FIELDS) {
    const predicted = Number(payload[field]);
    const real = Number(actual[field]);
    let pts = 0;
    if (Number.isFinite(predicted) && Number.isFinite(real)) {
      const diff = Math.abs(predicted - real);
      if (diff === 0) pts = SCORING[field].exact;
      else if (diff === 1) pts = SCORING[field].close;
    }
    breakdown[field] = pts;
    total += pts;
  }
  return { total, breakdown };
}
