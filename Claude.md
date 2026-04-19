# Femmli Scheduler — Project Context

## What this is
A team availability scheduling app built for Femmli, a women's health research group at UW. It replaces the weekly When2Meet ritual by pulling real-time free/busy data directly from team members' Google and Microsoft calendars. No event details are ever accessed or stored — only busy/free status per 30-minute block.

## How it works
- Single static HTML file (`index.html`) hosted on GitHub Pages
- Supabase as the shared database backend (REST API, no SDK)
- Google Calendar API + Microsoft Graph API for OAuth-based free/busy fetching
- No build step, no bundler, no framework — vanilla HTML/CSS/JS only

## Hosting
- **Frontend:** https://lortero7.github.io/femmli-scheduler/
- **GitHub repo:** https://github.com/lortero7/femmli-scheduler
- **Branch:** main, served from root `/`

## Backend — Supabase
- **Project URL:** https://nmonucpefqvbuycpqtim.supabase.co
- **Anon key:** eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tb251Y3BlZnF2YnV5Y3BxdGltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MTIxMTEsImV4cCI6MjA5MTM4ODExMX0.Dqe_jurWQCSMC77Y-GHjcy7XSo0yAWJ6TSi5srHzmVo
- **Table:** `availability`
- **Schema:**
  ```sql
  name text primary key
  cells text          -- JSON: manually marked available slots { "si_di": true }
  google_busy text    -- JSON: busy slots from Google Calendar { "si_di": true }
  microsoft_busy text -- JSON: busy slots from Microsoft Calendar { "si_di": true }
  cal_provider text   -- "google" | "microsoft" | ""
  updated_at timestamptz
  ```
- Row-level security enabled with public read/write/update/delete policies

## OAuth
- **Google Client ID:** 935491588637-vle8b236a1ll25fngo8ldihvs8qmcs7i.apps.googleusercontent.com
  - Scope: `https://www.googleapis.com/auth/calendar.freebusy`
  - Flow: implicit (token in URL hash after redirect)
  - Authorized origin: https://lortero7.github.io
  - Redirect URI: https://lortero7.github.io/femmli-scheduler
  - App is in **testing mode** — team members must be added as test users in Google Cloud Console → Google Auth Platform → Audience → Test users

- **Microsoft Client ID:** a5d16489-7bfa-4b23-9d42-245bfcfc8d94
  - Scope: `https://graph.microsoft.com/Calendars.Read`
  - Flow: implicit (token in URL hash after redirect)
  - Tenant: common (any Entra ID + personal Microsoft accounts)
  - Redirect URI: https://lortero7.github.io/femmli-scheduler

## Slot coordinate system
- Time runs Mon–Fri, 8am–6pm Pacific
- 20 slots per day (30-min blocks), 5 days = 100 cells per person
- Slot index `si` runs 0–19 (0 = 8:00am, 1 = 8:30am, ... 19 = 5:30pm)
- Day index `di` runs 0–4 (0 = Mon, 4 = Fri)
- Cell key format: `"si_di"` e.g. `"0_0"` = Monday 8:00am
- Week offset 0 = current week, 1 = next week, etc.

## App structure (index.html)
Two screens toggled by bottom nav:

**Submit screen (`s-submit`)**
- User enters name → clicks Continue
- Connects Google or Microsoft calendar via OAuth redirect
- On return: fetches free/busy for the selected week, marks busy slots as hatched/unclickable
- Manual grid available for people without Google/Microsoft
- Save writes to Supabase via upsert on `name`

**Dashboard screen (`s-dash`)**
- Fetches all rows from Supabase on load
- People shown as toggleable pills (colored dot = calendar source)
- Heatmap shows combined availability for selected people
- Week selector (this week, next week, +2, +3)
- Min available filter (1+, 2+, 3+, 4+, 5+)
- Hover tooltip shows count and names of who's free

## Availability logic
- Calendar-connected user: available = not in their cal_busy slots
- Manual user: available = explicitly marked in their cells object
- Merged busy = union of google_busy + microsoft_busy

## Key functions
- `connectGoogle()` / `connectMicrosoft()` — redirect to OAuth
- `handleOAuthRedirect()` — parses token from URL hash on return
- `fetchGoogleBusy(weekOffset)` — calls Google freeBusy API
- `fetchMicrosoftBusy(weekOffset)` — calls Microsoft getSchedule API
- `busyPeriodsToSlots(periods, dates)` — converts ISO time ranges to slot keys
- `isAvailable(person, key)` — unified availability check
- `drawHeat()` — renders dashboard heatmap
- `sbUpsert(name, cells, gBusy, msBusy, provider)` — saves to Supabase
- `getWeekDates(offset)` — returns Mon–Fri Date objects for a given week

## Deployment
```bash
# Make changes to index.html, then:
git add index.html
git commit -m "your message"
git push origin main
# GitHub Actions auto-deploys to GitHub Pages (~30 seconds)
```

## Known issues / next steps
- Google OAuth app is in testing mode — team members need to be added manually as test users in Google Cloud Console before they can connect
- Microsoft OAuth not yet tested end-to-end (Azure tenant setup was done via IV-Safe org account)
- No token refresh — OAuth tokens expire (Google: 1hr, Microsoft: 1hr). Users need to reconnect periodically. Consider adding a token expiry check and prompting re-auth.
- Future: add Outlook support confirmation once Microsoft OAuth is verified working
- Future: consider moving to a backend (Railway) for token storage and refresh if the re-auth friction becomes annoying
