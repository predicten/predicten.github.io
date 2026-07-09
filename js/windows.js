// Pure fixed-window logic. No Firebase here so it can be unit-tested in isolation.
//
// The game uses FIXED match-time windows that are identical for every player.
// It does NOT use rolling windows based on when a user joins.

// Match periods.
export const PERIODS = {
  PRE: "PRE", // kickoff has not happened yet
  FIRST_HALF: "FIRST_HALF",
  HALFTIME: "HALFTIME",
  SECOND_HALF: "SECOND_HALF",
  FULLTIME: "FULLTIME",
};

// The fixed window schedule. `order` is the stable id used everywhere
// (Firestore doc id, prediction key, etc). startMin/endMin are nominal
// match minutes; the two "open ended" windows (30–HT and 75–FT) absorb
// stoppage time and are closed by a period transition (HALFTIME / FULLTIME)
// rather than a minute.
export const FIXED_WINDOW_SCHEDULE = [
  { order: 0, key: "0-15", label: "0:00–15:00", period: PERIODS.FIRST_HALF, startMin: 0, endMin: 15 },
  { order: 1, key: "15-30", label: "15:00–30:00", period: PERIODS.FIRST_HALF, startMin: 15, endMin: 30 },
  { order: 2, key: "30-HT", label: "30:00–HT", period: PERIODS.FIRST_HALF, startMin: 30, endMin: 45 },
  { order: 3, key: "45-60", label: "45:00–60:00", period: PERIODS.SECOND_HALF, startMin: 45, endMin: 60 },
  { order: 4, key: "60-75", label: "60:00–75:00", period: PERIODS.SECOND_HALF, startMin: 60, endMin: 75 },
  { order: 5, key: "75-FT", label: "75:00–FT", period: PERIODS.SECOND_HALF, startMin: 75, endMin: 90 },
];

export const WINDOW_COUNT = FIXED_WINDOW_SCHEDULE.length;

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

const FIRST_HALF_THRESHOLDS = [15, 30];
const SECOND_HALF_THRESHOLDS = [60, 75];

// Number of first-half windows (orders 0..2). Second-half windows start after these.
const FIRST_HALF_WINDOW_COUNT = FIXED_WINDOW_SCHEDULE.filter(
  (w) => w.period === PERIODS.FIRST_HALF
).length;

function countAtOrPast(thresholds, minute) {
  return thresholds.filter((t) => minute >= t).length;
}

// Number of windows that have fully ended (and are therefore "completed" or later).
// The last window of each half (30–HT and 75–FT) only completes on the
// HALFTIME / FULLTIME transition, never on a raw minute, so stoppage time
// stays inside them.
export function getCompletedCount(period, matchMinute = 0) {
  switch (period) {
    case PERIODS.PRE:
      return 0;
    case PERIODS.FIRST_HALF:
      // windows 0..1 close at 15/30; window 2 stays active through stoppage.
      return countAtOrPast(FIRST_HALF_THRESHOLDS, matchMinute); // 0..2
    case PERIODS.HALFTIME:
      return FIRST_HALF_WINDOW_COUNT; // all first-half windows complete
    case PERIODS.SECOND_HALF:
      // windows 3..4 close at 60/75; window 5 stays active through stoppage.
      return FIRST_HALF_WINDOW_COUNT + countAtOrPast(SECOND_HALF_THRESHOLDS, matchMinute);
    case PERIODS.FULLTIME:
      return WINDOW_COUNT; // everything has ended
    default:
      return 0;
  }
}

// Index of the window the match minute is currently inside, or -1 if none
// (PRE / HALFTIME / FULLTIME have no active window).
export function getActiveIndex(period, matchMinute = 0) {
  if (period === PERIODS.FIRST_HALF || period === PERIODS.SECOND_HALF) {
    const completed = getCompletedCount(period, matchMinute);
    return completed < WINDOW_COUNT ? completed : -1;
  }
  return -1;
}

// The window the match is currently inside, or null.
export function getCurrentFixedWindow(matchMinute, period) {
  const idx = getActiveIndex(period, matchMinute);
  return idx >= 0 ? FIXED_WINDOW_SCHEDULE[idx] : null;
}

// Index of the next window that has NOT started yet and is open for predictions.
function getNextPredictableIndex(period, matchMinute = 0) {
  let idx;
  switch (period) {
    case PERIODS.PRE:
      idx = 0;
      break;
    case PERIODS.FIRST_HALF:
      idx = getActiveIndex(period, matchMinute) + 1; // predict the one after the active window
      break;
    case PERIODS.HALFTIME:
      idx = FIRST_HALF_WINDOW_COUNT; // first second-half window (45:00–60:00)
      break;
    case PERIODS.SECOND_HALF:
      idx = getActiveIndex(period, matchMinute) + 1;
      break;
    case PERIODS.FULLTIME:
    default:
      idx = -1;
  }
  if (idx < 0 || idx >= WINDOW_COUNT) return -1;
  return idx;
}

// The only window a user is allowed to predict right now, or null.
export function getNextFixedPredictionWindow(matchMinute, period) {
  const idx = getNextPredictableIndex(period, matchMinute);
  return idx >= 0 ? FIXED_WINDOW_SCHEDULE[idx] : null;
}

// Status of a given window: "upcoming" | "active" | "completed" | "settled".
// `window` needs at least { order, settled }. `match` needs { period, matchMinute }.
export function getWindowStatus(window, match) {
  if (window && window.settled) return "settled";
  const period = match?.period ?? PERIODS.PRE;
  const minute = match?.matchMinute ?? 0;
  const completed = getCompletedCount(period, minute);
  const active = getActiveIndex(period, minute);
  if (window.order < completed) return "completed";
  if (window.order === active) return "active";
  return "upcoming";
}

// True if `window` is the single window currently open for predictions.
export function isWindowPredictable(window, match) {
  const next = getNextFixedPredictionWindow(match?.matchMinute ?? 0, match?.period ?? PERIODS.PRE);
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
