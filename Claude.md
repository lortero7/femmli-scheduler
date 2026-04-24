# Team Availability

Team scheduling app that replaces When2Meet by pulling real-time free/busy data from Google and Microsoft calendars. Originally built for the femmli team but not femmli-specific. No event details accessed or stored — only busy/free per 30-minute block.

## How it works
- Single static HTML file (`index.html`) hosted on GitHub Pages
- Node/Express backend (`backend/server.js`) handles OAuth and calendar fetching — deployed to Railway
- Supabase stores availability data and OAuth refresh tokens (REST API, no SDK)
- No build step, no bundler, no framework — vanilla HTML/CSS/JS only

## Flow
1. Teammate enters name → clicks "Connect Google/Microsoft Calendar"
2. Frontend redirects to backend `/auth/google` or `/auth/microsoft`
3. Backend performs server-side OAuth (authorization code flow), gets a **refresh token**, saves it to Supabase `tokens` table permanently
4. Backend immediately fetches 4 weeks of busy slots and saves to `availability` table
5. Backend redirects back to frontend with `?connected=google&name=X`
6. From then on, anyone clicking **Refresh** on the dashboard triggers `POST /api/refresh` — backend uses saved refresh tokens to re-fetch all users' current calendars and update Supabase

## Hosting
- **Frontend:** https://lortero7.github.io/team-availability/
- **GitHub repo:** https://github.com/lortero7/team-availability
- **Branch:** main, served from root `/`
- **Backend:** https://team-availability-production.up.railway.app

## Supabase
- **Project URL:** https://nmonucpefqvbuycpqtim.supabase.co
- **Anon key:** eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tb251Y3BlZnF2YnV5Y3BxdGltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MTIxMTEsImV4cCI6MjA5MTM4ODExMX0.Dqe_jurWQCSMC77Y-GHjcy7XSo0yAWJ6TSi5srHzmVo
- **Service role key:** used by the backend only (never exposed in frontend) — set as Railway env var `SUPABASE_SERVICE_KEY`

### Table: `availability`
```sql
name text primary key
cells text          -- JSON: manually marked slots { "si_di": true }
google_busy text    -- JSON: { "0": {"si_di": true}, "1": {...}, ... } keyed by week offset
microsoft_busy text -- JSON: same structure as google_busy
cal_provider text   -- "google" | "microsoft" | ""
updated_at timestamptz
```

### Table: `tokens`
```sql
name text primary key
provider text           -- "google" | "microsoft"
refresh_token text      -- stored permanently, used for server-side calendar refresh
updated_at timestamptz
```
Create with:
```sql
create table tokens (
  name text primary key,
  provider text not null,
  refresh_token text not null,
  updated_at timestamptz default now()
);
alter table tokens enable row level security;
create policy "service role full access" on tokens using (true) with check (true);
```
Row-level security on both tables — `availability` has public read/write; `tokens` is service-role only.

## OAuth
Both providers use **authorization code flow** (server-side) — the frontend never sees access or refresh tokens.

- **Google Client ID:** 935491588637-vle8b236a1ll25fngo8ldihvs8qmcs7i.apps.googleusercontent.com
  - Scope: `https://www.googleapis.com/auth/calendar.freebusy`
  - Redirect URI: `https://YOUR-RAILWAY-URL/auth/google/callback`
  - App is in **testing mode** — add team members as test users in Google Cloud Console → Google Auth Platform → Audience → Test users
  - Client secret: stored as Railway env var `GOOGLE_CLIENT_SECRET`

- **Microsoft Client ID:** a5d16489-7bfa-4b23-9d42-245bfcfc8d94
  - Scope: `https://graph.microsoft.com/Calendars.Read offline_access`
  - Tenant: common (any Entra ID + personal Microsoft accounts)
  - Redirect URI: `https://YOUR-RAILWAY-URL/auth/microsoft/callback`
  - Client secret: stored as Railway env var `MS_CLIENT_SECRET`

## Backend — `backend/server.js`
Express app. Deploy to Railway, root directory = `backend/`.

### Required env vars (Railway)
| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | see above |
| `GOOGLE_CLIENT_SECRET` | from Google Cloud Console |
| `MS_CLIENT_ID` | see above |
| `MS_CLIENT_SECRET` | from Azure Portal |
| `SUPABASE_URL` | https://nmonucpefqvbuycpqtim.supabase.co |
| `SUPABASE_SERVICE_KEY` | from Supabase → Project Settings → API → service_role |
| `BACKEND_URL` | your Railway public URL |
| `FRONTEND_URL` | https://lortero7.github.io/team-availability |

### Endpoints
- `GET /auth/google?name=X` — starts Google OAuth, state=name
- `GET /auth/google/callback` — exchanges code, saves refresh token, fetches busy slots, redirects to frontend
- `GET /auth/microsoft?name=X` — starts Microsoft OAuth
- `GET /auth/microsoft/callback` — same as Google callback
- `POST /api/refresh` — refreshes all users' calendars using stored refresh tokens; called by the dashboard Refresh button
- `GET /health` — returns `{ok:true}`

## Slot coordinate system
- Time runs Mon–Fri, 8am–6pm Pacific
- 20 slots per day (30-min blocks), 5 days = 100 cells per person
- Slot index `si` runs 0–19 (0 = 8:00am, 1 = 8:30am, ... 19 = 5:30pm)
- Day index `di` runs 0–4 (0 = Mon, 4 = Fri)
- Cell key format: `"si_di"` e.g. `"0_0"` = Monday 8:00am
- Week offset 0 = current week, 1 = next week, etc.
- `google_busy` / `microsoft_busy` in Supabase are keyed by week offset: `{"0":{...},"1":{...},...}`

## App structure (index.html)
Two screens toggled by bottom nav. `BACKEND_URL` constant must be set to the Railway URL.

**Submit screen (`s-submit`)**
- User enters name → clicks Continue → loads their existing Supabase data
- Clicks "Connect Google/Microsoft Calendar" → redirected to backend → OAuth → redirected back
- On return (query params `?connected=google&name=X`): shows connected state, busy slots already populated by backend
- Manual grid available for people without Google/Microsoft
- Save button writes manual cell selections to Supabase

**Dashboard screen (`s-dash`)**
- Loads all rows from Supabase on open
- People shown as toggleable pills (colored dot = provider: blue=Google, cyan=Microsoft, grey=manual)
- Heatmap shows combined availability for selected people
- Week selector (this week, next week, +2, +3)
- Min available filter (1+, 2+, 3+, 4+, 5+)
- Hover tooltip shows count and names of who's free
- Refresh button calls `POST /api/refresh` on the backend, then reloads Supabase data

## Key functions (index.html)
- `connectGoogle()` / `connectMicrosoft()` — redirect to backend OAuth endpoints
- `handleConnectReturn()` — parses `?connected` / `?auth_error` query params on return
- `loadDash(refreshCals)` — loads Supabase data; if `refreshCals=true` also calls backend `/api/refresh`
- `getMergedBusy(person, weekOffset)` — unions google_busy + microsoft_busy for a given week
- `isAvailable(person, key, weekOffset)` — returns true if person is free at that slot
- `drawHeat()` — renders dashboard heatmap
- `sbSaveCells(name, cells)` — saves manual cell selections to Supabase
- `getWeekDates(offset)` — returns Mon–Fri Date objects for a given week

## Deployment

### Frontend (GitHub Pages — automatic)
```bash
git add index.html
git commit -m "your message"
git push origin main
# GitHub Pages auto-deploys (~30 seconds)
```

### Backend (Railway)
1. Railway → New Project → Deploy from GitHub → select repo, set root to `backend/`
2. Set all env vars listed above
3. Add Railway URL as redirect URI in Google Cloud Console and Azure Portal
4. Set `BACKEND_URL` constant in `index.html` to the Railway URL, push

## Known issues / next steps
- Google OAuth app is in testing mode — team members must be added as test users before they can connect
- Microsoft OAuth not yet tested end-to-end
- Backend not yet deployed to Railway — `BACKEND_URL` in `index.html` is still a placeholder
- Once deployed: manual users (no calendar) continue to work; only calendar-connected users benefit from server-side refresh
