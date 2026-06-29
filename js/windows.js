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
// match minutes; the two "open ended" windows absorb stoppage time and are
// closed by a period transition (HALFTIME / FULLTIME) rather than a minute.
export const FIXED_WINDOW_SCHEDULE = [
  { order: 0, key: "0-10", label: "0:00–10:00", period: PERIODS.FIRST_HALF, startMin: 0, endMin: 10 },
  { order: 1, key: "10-20", label: "10:00–20:00", period: PERIODS.FIRST_HALF, startMin: 10, endMin: 20 },
  { order: 2, key: "20-30", label: "20:00–30:00", period: PERIODS.FIRST_HALF, startMin: 20, endMin: 30 },
  { order: 3, key: "30-40", label: "30:00–40:00", period: PERIODS.FIRST_HALF, startMin: 30, endMin: 40 },
  { order: 4, key: "40-HT", label: "40:00–HT", period: PERIODS.FIRST_HALF, startMin: 40, endMin: 45 },
  { order: 5, key: "45-55", label: "45:00–55:00", period: PERIODS.SECOND_HALF, startMin: 45, endMin: 55 },
  { order: 6, key: "55-65", label: "55:00–65:00", period: PERIODS.SECOND_HALF, startMin: 55, endMin: 65 },
  { order: 7, key: "65-75", label: "65:00–75:00", period: PERIODS.SECOND_HALF, startMin: 65, endMin: 75 },
  { order: 8, key: "75-85", label: "75:00–85:00", period: PERIODS.SECOND_HALF, startMin: 75, endMin: 85 },
  { order: 9, key: "85-FT", label: "85:00–FT", period: PERIODS.SECOND_HALF, startMin: 85, endMin: 90 },
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

const FIRST_HALF_THRESHOLDS = [10, 20, 30, 40];
const SECOND_HALF_THRESHOLDS = [55, 65, 75, 85];

function countAtOrPast(thresholds, minute) {
  return thresholds.filter((t) => minute >= t).length;
}

// Number of windows that have fully ended (and are therefore "completed" or later).
// Windows 4 (40–HT) and 9 (85–FT) only complete on the HALFTIME / FULLTIME transition,
// never on a raw minute, so stoppage time stays inside them.
export function getCompletedCount(period, matchMinute = 0) {
  switch (period) {
    case PERIODS.PRE:
      return 0;
    case PERIODS.FIRST_HALF:
      // windows 0..3 close at 10/20/30/40; window 4 stays active through stoppage.
      return countAtOrPast(FIRST_HALF_THRESHOLDS, matchMinute); // 0..4
    case PERIODS.HALFTIME:
      return 5; // all first-half windows (0..4) complete
    case PERIODS.SECOND_HALF:
      // windows 5..8 close at 55/65/75/85; window 9 stays active through stoppage.
      return 5 + countAtOrPast(SECOND_HALF_THRESHOLDS, matchMinute); // 5..9
    case PERIODS.FULLTIME:
      return WINDOW_COUNT; // 10 — everything has ended
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
      idx = 5; // 45:00–55:00
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
