# Team Availability

When2Meet replacement — pulls real-time free/busy from Google, Microsoft, and ICS calendars. Multi-tenant via `?team=<uuid>` / slug URLs. Only busy/free per 30-min block stored — no event details.

## Stack
- **Frontend:** Single `index.html`, vanilla HTML/CSS/JS, no build step — Netlify (guiocal.com), auto-deploys from main
- **Backend:** `backend/server.js`, Node/Express — Railway, handles OAuth + ICS fetch + calendar refresh
- **DB:** Supabase (REST API, no SDK) — availability + OAuth tokens

## Flow
1. First visit → enter team name → `POST /api/teams` → redirected to `guiocal.com/{slug}`
2. Teammate visits slug → enters name → connects Google/Microsoft (OAuth via backend) or pastes ICS URL
3. Backend saves refresh token + 4 weeks of busy slots → redirects back to frontend
4. Dashboard Refresh → `POST /api/refresh` → backend re-fetches all users' calendars (sequential `for` loop — not `Promise.all`, avoids OOM)

## Hosting
- **Frontend:** https://guiocal.com (Netlify, `_redirects` routes all paths to `index.html`)
- **Backend:** https://team-availability-production.up.railway.app
- **Repo:** https://github.com/lortero7/team-availability (branch: main)

## Supabase — https://nmonucpefqvbuycpqtim.supabase.co
- **Anon key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tb251Y3BlZnF2YnV5Y3BxdGltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MTIxMTEsImV4cCI6MjA5MTM4ODExMX0.Dqe_jurWQCSMC77Y-GHjcy7XSo0yAWJ6TSi5srHzmVo`
- **Service key:** Railway env var only, never in frontend

### `teams`
```sql
id uuid primary key; name text not null; slug text unique not null; created_at timestamptz
```

### `availability` — PK: (team_id, name)
```sql
team_id uuid; name text
cells text          -- manually marked slots: { "si_di": true }
google_busy text    -- { "0": {"si_di": true}, "1": {...}, ... } keyed by week offset
microsoft_busy text -- same structure
ics_busy text       -- same structure
cal_provider text   -- "google"|"microsoft"|"ics"|""
cal_accounts text   -- { google: [email,...], microsoft: [...], ics: <count> }
updated_at timestamptz
```

### `tokens` — PK: (team_id, name, provider)
```sql
provider text       -- "google"|"microsoft"|"ics"
refresh_token text  -- OAuth: [{email, refresh_token},...]; ICS: [url,...]
updated_at timestamptz
```
RLS: `availability` + `teams` public read/write; `tokens` service-role only.

## OAuth (server-side — frontend never sees tokens)
- **Google** — Client ID: `539439225161-cur6ual31uooo1015kr6r7ihml4mfbtr.apps.googleusercontent.com`
  Scope: `calendar.freebusy openid email` | Redirect: `.../auth/google/callback` | Published (any Google account)
- **Microsoft** — Client ID: `a5d16489-7bfa-4b23-9d42-245bfcfc8d94`
  Scope: `Calendars.Read User.Read offline_access` | Tenant: common | Redirect: `.../auth/microsoft/callback`

## ICS support
Users paste a public ICS/webcal URL (workaround for orgs blocking OAuth, e.g. UW). Backend parses VEVENT + VFREEBUSY, expands RRULE (WEEKLY/DAILY), maps Windows tz names, defaults floating-time to Eastern. Multiple URLs per user stored as JSON array.

## Slot coordinate system
Mon–Fri, 8am–9pm Eastern. 26 slots/day × 5 days = 130 cells/person.
- `si` 0–25 (0=8:00am, 25=8:30pm) | `di` 0–4 (0=Mon) | key: `"si_di"` e.g. `"0_0"` = Mon 8am
- Week offset: 0=current, 1=next; busy columns: `{"0":{...},"1":{...},...}`

## Backend endpoints
- `POST /api/teams` — `{name}` → `{id, name, slug}`
- `GET /auth/google?name=X&team_id=Y` + `GET /auth/google/callback`
- `GET /auth/microsoft?name=X&team_id=Y` + `GET /auth/microsoft/callback`
- `POST /api/connect-ics` — `{name, icsUrl, teamId}`
- `POST /api/refresh` — `{teamId}`
- `GET /health`

## Railway env vars
| Var | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | see OAuth above |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console |
| `MS_CLIENT_ID` | see OAuth above |
| `MS_CLIENT_SECRET` | Azure Portal |
| `SUPABASE_URL` | https://nmonucpefqvbuycpqtim.supabase.co |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → service_role |
| `BACKEND_URL` | https://team-availability-production.up.railway.app |
| `FRONTEND_URL` | `https://guiocal.com` |

## Dashboard UI
Pills per person: blue=Google, cyan=Microsoft, orange=ICS, purple=multi-provider, grey=manual. Heatmap, 4-week selector, min-available filter, hover tooltip.

## Deploy
```bash
git push origin main  # Netlify auto-deploys in ~30s; Railway auto-deploys backend/
```
