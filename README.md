# Match Predictor — Fixed Window Game

A live football prediction game built with **vanilla JavaScript + HTML + CSS + Firebase**
(Firestore + Google Auth). Players sign in with Google, join a live match, and predict
what happens in any unsettled **fixed 15-minute match window**. An admin enters the actual
stats after each window completes; scoring and the leaderboard update in realtime.

> The game uses **fixed match-time windows that are identical for every player** — it does
> NOT use rolling windows based on when a user joins.

## Fixed window schedule

| # | Window | Notes |
|---|--------|-------|
| 0 | 0:00–15:00 | |
| 1 | 15:00–30:00 | |
| 2 | 30:00–HT | includes first-half stoppage time |
| 3 | 45:00–60:00 | |
| 4 | 60:00–75:00 | |
| 5 | 75:00–FT | includes second-half stoppage time |

**Prediction rule:** a user can submit or update a prediction for any fixed window that
has not been settled yet. Once the admin enters stats and scoring is calculated, that
window becomes `settled` and player predictions for it are locked.

**Window statuses:** `upcoming` → `active` → `completed` → `settled`.

## Project structure

```
index.html        Player app
admin.html        Admin console
css/styles.css    Styles
js/config.js      <-- Firebase config + ADMIN_EMAILS (fill this in)
js/firebase.js    Firebase init
js/auth.js        Google sign-in / admin check
js/windows.js     Pure fixed-window logic + scoring (no Firebase)
js/service.js     Firestore data layer + core game functions
js/app.js         Player UI
js/admin.js       Admin UI
firestore.rules   Security rules
```

## Core functions (in `js/windows.js` + `js/service.js`)

- `createFixedPredictionWindowsForMatch(matchId)`
- `getCurrentFixedWindow(matchMinute, period)`
- `getNextFixedPredictionWindow(matchMinute, period)`
- `getWindowStatus(window, match)`
- `submitPredictionForFixedWindow(user, matchId, windowId, predictionPayload)`
- `submitManualStatsForFixedWindow(matchId, windowId, statsPayload, adminUser)`
- `scoreFixedWindow(matchId, windowId)`
- `recalculateFixedWindowScores(matchId, windowId)`

## Setup

1. **Create a Firebase project** at https://console.firebase.google.com.
2. **Enable Authentication → Google** as a sign-in provider.
3. **Create a Firestore database** (start in test mode for local dev, then apply
   `firestore.rules` for production).
4. **Add a Web App** in Project settings and copy the config into `js/config.js`
   (`firebaseConfig`).
5. **Set admins:** add your Google email to `ADMIN_EMAILS` in `js/config.js`
   *and* to the `isAdmin()` list in `firestore.rules`.
6. **Authorized domains:** in Firebase Auth settings, make sure `localhost` (and
   your deploy domain) is in the authorized domains list.

## Run locally

The app uses ES modules, so serve it over HTTP (not `file://`):

```bash
# any static server works, e.g.
npx serve .
# or
python3 -m http.server 8000
```

Then open `http://localhost:8000/` (player) and `http://localhost:8000/admin.html` (admin).

## Using it

1. In the **admin console**, click **+ New match** (creates the 6 fixed windows).
2. Use the **Match clock** slider to move the match to the latest fixed checkpoint
   (no live feed in the MVP).
3. Players sign in on the **player page**, pick the match, and submit or update predictions
   for any unsettled window.
4. When a window is `completed`, the admin clicks **Enter stats**, fills in
   goals / shots on goal / corners / fouls / cards, and submits. The app saves the
   stats, scores every prediction for that exact window, updates totals, refreshes the
   leaderboard, and marks the window `settled`.
5. **Recalculate** re-scores a settled window if the admin corrects the stats
   (standings are adjusted by the delta, so totals never drift).

## Scoring

Per stat, an exact hit and a "within one" guess earn points (configurable in
`SCORING` in `js/windows.js`):

| Stat | Exact | Within 1 |
|------|------:|---------:|
| Goals | 10 | 4 |
| Shots on goal | 6 | 2 |
| Corners | 6 | 2 |
| Fouls | 4 | 1 |
| Cards | 5 | 2 |

## Acceptance criteria

- ✅ The app creates fixed match windows for every match.
- ✅ All players see the same fixed windows.
- ✅ A user can submit or update predictions for any unsettled fixed window.
- ✅ Admin can enter actual stats only after a fixed window is completed (override available).
- ✅ Admin-entered stats score all predictions for that exact fixed window.
- ✅ Leaderboard updates after each fixed window is settled.
# predicten
