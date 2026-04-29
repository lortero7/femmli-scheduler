const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: new URL(process.env.FRONTEND_URL || 'https://lortero7.github.io/team-availability').origin }));
app.use(express.json());

const {
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
  MS_CLIENT_ID, MS_CLIENT_SECRET,
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  BACKEND_URL,
  FRONTEND_URL = 'https://lortero7.github.io/team-availability',
  PORT = 3000
} = process.env;

const GOOGLE_REDIRECT = `${BACKEND_URL}/auth/google/callback`;
const MS_REDIRECT = `${BACKEND_URL}/auth/microsoft/callback`;

// ── Supabase (service role — bypasses RLS) ───────────────────
const sbHeaders = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY
};

async function sbFetch(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders, ...opts });
  if (!r.ok) throw new Error(`Supabase ${path}: ${await r.text()}`);
  return r.json();
}

async function saveToken(name, provider, refreshToken) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/tokens?on_conflict=name,provider`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ name, provider, refresh_token: refreshToken, updated_at: new Date().toISOString() })
  });
  if (!r.ok) console.error('saveToken failed:', await r.text());
}

async function getAllTokens() {
  return sbFetch('tokens?select=name,provider,refresh_token');
}

// Returns [{email, refresh_token}] for a user+provider, or [] if none stored
async function getTokensForUser(name, provider) {
  try {
    const rows = await sbFetch(`tokens?name=eq.${encodeURIComponent(name)}&provider=eq.${provider}&select=refresh_token`);
    if (!rows.length) return [];
    try {
      const arr = JSON.parse(rows[0].refresh_token);
      return Array.isArray(arr) ? arr : [{ email: null, refresh_token: rows[0].refresh_token }];
    } catch { return [{ email: null, refresh_token: rows[0].refresh_token }]; }
  } catch { return []; }
}

// Stores connected account emails/count in availability.cal_accounts for frontend display
async function updateCalAccounts(name, provider, value) {
  let accounts = {};
  try {
    const rows = await sbFetch(`availability?name=eq.${encodeURIComponent(name)}&select=cal_accounts`);
    if (rows.length && rows[0].cal_accounts) accounts = JSON.parse(rows[0].cal_accounts);
  } catch {}
  accounts[provider] = value;
  await fetch(`${SUPABASE_URL}/rest/v1/availability?on_conflict=name`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ name, cal_accounts: JSON.stringify(accounts), updated_at: new Date().toISOString() })
  }).catch(e => console.error('updateCalAccounts failed:', e.message));
}

async function saveAvailability(name, provider, busyWeeks) {
  const col = provider === 'google' ? 'google_busy' : provider === 'microsoft' ? 'microsoft_busy' : 'ics_busy';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/availability?on_conflict=name`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({
      name,
      cal_provider: provider,
      [col]: JSON.stringify(busyWeeks),
      updated_at: new Date().toISOString()
    })
  });
  if (!r.ok) throw new Error('saveAvailability failed: ' + await r.text());
}

// ── ICS parser ───────────────────────────────────────────────
// Map Windows timezone names (used by Outlook) to IANA names
const WIN_TZ = {
  'Eastern Standard Time': 'America/New_York',
  'Eastern Summer Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaska Standard Time': 'America/Anchorage',
  'Hawaii-Aleutian Standard Time': 'Pacific/Honolulu',
  'Greenwich Standard Time': 'Europe/London',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'India Standard Time': 'Asia/Kolkata',
  'AUS Eastern Standard Time': 'Australia/Sydney',
};

function tzOffsetMinutes(date, tzid) {
  const utcMs = date.getTime();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  }).formatToParts(date).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  const localMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
    parts.hour === '24' ? 0 : +parts.hour, +parts.minute, +parts.second);
  return Math.round((utcMs - localMs) / 60000);
}

function parseIcsDate(prop, val) {
  if (/VALUE=DATE/i.test(prop)) {
    const m = val.match(/(\d{4})(\d{2})(\d{2})/);
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  }
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, yr, mo, dy, hr, min, sec, z] = m;
  if (z === 'Z') return new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +min, +sec));
  const rawTzid = (prop.match(/TZID=([^;:]+)/i) || [])[1];
  const tzid = rawTzid ? (WIN_TZ[rawTzid] || rawTzid) : null;
  const ref = new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +min, +sec));
  const tz = tzid || 'America/New_York'; // floating times: assume Eastern
  try { return new Date(ref.getTime() + tzOffsetMinutes(ref, tz) * 60000); } catch (e) {}
  return ref;
}

// Expand RRULE for WEEKLY and DAILY recurrences over a 6-week window
function expandRRule(rrule, dtstart, dtend) {
  const freq = ((rrule.match(/FREQ=([^;]+)/i)||[])[1]||'').toUpperCase();
  if (freq !== 'WEEKLY' && freq !== 'DAILY') return null;

  const interval = parseInt((rrule.match(/INTERVAL=(\d+)/i)||[])[1]||'1');
  const bydayRaw = (rrule.match(/BYDAY=([^;]+)/i)||[])[1];
  const untilRaw = (rrule.match(/UNTIL=(\d{8})/i)||[])[1];
  const countRaw = (rrule.match(/COUNT=(\d+)/i)||[])[1];

  const DAY = {SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6};
  const byday = bydayRaw
    ? bydayRaw.split(',').map(s=>{const m=s.match(/[A-Z]{2}$/);return m?DAY[m[0]]:-1;}).filter(d=>d>=0)
    : [];

  const win6w = new Date(Date.now() + 6 * 7 * 86400000);
  const until = untilRaw
    ? new Date(`${untilRaw.slice(0,4)}-${untilRaw.slice(4,6)}-${untilRaw.slice(6,8)}T23:59:59Z`)
    : win6w;
  const cutoff = until < win6w ? until : win6w;
  const maxCount = countRaw ? parseInt(countRaw) : Infinity;
  const duration = dtend.getTime() - dtstart.getTime();
  const periods = [];
  let n = 0;

  if (freq === 'DAILY') {
    for (let t = new Date(dtstart); t <= cutoff && n < maxCount; t = new Date(t.getTime() + interval * 86400000), n++)
      periods.push({ start: t.toISOString(), end: new Date(t.getTime() + duration).toISOString() });
  } else {
    const startDow = dtstart.getUTCDay();
    const mondayOfStart = new Date(dtstart.getTime() - (startDow === 0 ? 6 : startDow - 1) * 86400000);
    mondayOfStart.setUTCHours(0, 0, 0, 0);
    const targetDays = byday.length ? byday : [startDow];

    for (let wk = new Date(mondayOfStart); wk <= cutoff && n < maxCount; wk = new Date(wk.getTime() + interval * 7 * 86400000)) {
      for (const dow of [...targetDays].sort((a,b)=>a-b)) {
        const dFromMon = dow === 0 ? 6 : dow - 1;
        const dayDate = new Date(wk.getTime() + dFromMon * 86400000);
        const occ = new Date(Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth(), dayDate.getUTCDate(),
          dtstart.getUTCHours(), dtstart.getUTCMinutes(), dtstart.getUTCSeconds()));
        if (occ < dtstart || occ > cutoff) continue;
        periods.push({ start: occ.toISOString(), end: new Date(occ.getTime() + duration).toISOString() });
        if (++n >= maxCount) break;
      }
    }
  }
  return periods.length > 1 ? periods : null;
}

function parseDuration(s) {
  const dm = s.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  return dm ? ((+(dm[1]||0))*86400 + (+(dm[2]||0))*3600 + (+(dm[3]||0))*60 + (+(dm[4]||0))) * 1000 : 0;
}

function parseIcs(text) {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const periods = [];
  let inEvent = false, inFreebusy = false, dtstart = null, dtend = null, rrule = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { inEvent = true; dtstart = dtend = rrule = null; continue; }
    if (line === 'END:VEVENT') {
      if (dtstart && dtend) {
        const recur = rrule ? expandRRule(rrule, dtstart, dtend) : null;
        if (recur) periods.push(...recur);
        else periods.push({ start: dtstart.toISOString(), end: dtend.toISOString() });
      }
      inEvent = false; continue;
    }
    if (line === 'BEGIN:VFREEBUSY') { inFreebusy = true; continue; }
    if (line === 'END:VFREEBUSY') { inFreebusy = false; continue; }
    if (!inEvent && !inFreebusy) continue;
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const prop = line.substring(0, ci), val = line.substring(ci + 1);
    const key = prop.split(';')[0].toUpperCase();
    if (inEvent) {
      if (key === 'DTSTART') dtstart = parseIcsDate(prop, val);
      else if (key === 'DTEND') dtend = parseIcsDate(prop, val);
      else if (key === 'RRULE') rrule = val;
      else if (key === 'DURATION' && dtstart) {
        const ms = parseDuration(val);
        if (ms) dtend = new Date(dtstart.getTime() + ms);
      }
    } else if (inFreebusy && key === 'FREEBUSY') {
      // Skip explicitly free periods; FREEBUSY with no FBTYPE or FBTYPE=BUSY/TENTATIVE/OOF counts as busy
      if (/FBTYPE=FREE/i.test(prop)) continue;
      for (const fbv of val.split(',')) {
        const slash = fbv.indexOf('/');
        if (slash < 0) continue;
        const start = parseIcsDate('', fbv.substring(0, slash));
        const endPart = fbv.substring(slash + 1);
        const end = /^P/.test(endPart) && start
          ? new Date(start.getTime() + parseDuration(endPart))
          : parseIcsDate('', endPart);
        if (start && end) periods.push({ start: start.toISOString(), end: end.toISOString() });
      }
    }
  }
  return periods;
}

async function fetchIcsBusy(icsUrl, weekOffset) {
  const r = await fetch(icsUrl.replace(/^webcal:\/\//i, 'https://'));
  if (!r.ok) throw new Error('ICS fetch: ' + r.status);
  const periods = parseIcs(await r.text());
  return busyPeriodsToSlots(periods, getWeekDates(weekOffset));
}

// ── Calendar helpers ─────────────────────────────────────────
const SLOTS = [];
for (let h = 8; h < 21; h++) { SLOTS.push({ h, m: 0 }); SLOTS.push({ h, m: 30 }); }

// Railway runs UTC — use Intl to get real Eastern offset (-4 EDT / -5 EST)
function getEasternOffset(date) {
  const noonUTC = new Date(date);
  noonUTC.setUTCHours(12, 0, 0, 0);
  const h = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false
  }).format(noonUTC));
  return h - 12; // -4 for EDT, -5 for EST
}

function easternOffsetStr(offset) {
  return offset === -4 ? '-04:00' : '-05:00';
}

function getWeekDates(offset = 0) {
  // Get today's date in Eastern time (avoids server UTC being a different calendar day)
  const pacificDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [y, m, d] = pacificDateStr.split('-').map(Number);
  const today = new Date(Date.UTC(y, m - 1, d));
  const dow = today.getUTCDay();
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - (dow === 0 ? 6 : dow - 1) + offset * 7);
  return [0, 1, 2, 3, 4].map(i => { const day = new Date(monday); day.setUTCDate(monday.getUTCDate() + i); return day; });
}

function busyPeriodsToSlots(periods, dates) {
  const busy = {};
  periods.forEach(p => {
    const start = new Date(p.start);
    const end = new Date(p.end);
    dates.forEach((date, di) => {
      const dateStr = date.toISOString().split('T')[0];
      const offStr = easternOffsetStr(getEasternOffset(date));
      SLOTS.forEach((slot, si) => {
        const slotStart = new Date(`${dateStr}T${String(slot.h).padStart(2,'0')}:${String(slot.m).padStart(2,'0')}:00${offStr}`);
        const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);
        if (slotStart < end && slotEnd > start) busy[`${si}_${di}`] = true;
      });
    });
  });
  return busy;
}

async function fetchGoogleBusy(accessToken, weekOffset) {
  const dates = getWeekDates(weekOffset);
  const mondayStr = dates[0].toISOString().split('T')[0];
  const fridayStr = dates[4].toISOString().split('T')[0];
  const timeMin = new Date(`${mondayStr}T08:00:00${easternOffsetStr(getEasternOffset(dates[0]))}`);
  const timeMax = new Date(`${fridayStr}T21:00:00${easternOffsetStr(getEasternOffset(dates[4]))}`);
  const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: 'primary' }] })
  });
  if (!r.ok) throw new Error('Google freeBusy: ' + r.status + ' ' + await r.text());
  const data = await r.json();
  return busyPeriodsToSlots(data.calendars?.primary?.busy || [], dates);
}

async function fetchMicrosoftBusy(accessToken, weekOffset, email) {
  const dates = getWeekDates(weekOffset);
  const mondayStr = dates[0].toISOString().split('T')[0];
  const fridayStr = dates[4].toISOString().split('T')[0];
  const timeMin = new Date(`${mondayStr}T08:00:00${easternOffsetStr(getEasternOffset(dates[0]))}`);
  const timeMax = new Date(`${fridayStr}T21:00:00${easternOffsetStr(getEasternOffset(dates[4]))}`);
  const r = await fetch('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schedules: [email],
      startTime: { dateTime: timeMin.toISOString().slice(0, 19), timeZone: 'UTC' },
      endTime: { dateTime: timeMax.toISOString().slice(0, 19), timeZone: 'UTC' },
      availabilityViewInterval: 30
    })
  });
  if (!r.ok) throw new Error('Microsoft getSchedule: ' + r.status + ' ' + await r.text());
  const data = await r.json();
  const periods = [];
  (data.value || []).forEach(s => (s.scheduleItems || []).forEach(item => {
    if (['busy', 'tentative', 'oof'].includes(item.status) && item.start?.dateTime && item.end?.dateTime)
      periods.push({ start: item.start.dateTime + 'Z', end: item.end.dateTime + 'Z' });
  }));
  return busyPeriodsToSlots(periods, dates);
}

// Fetch all 4 weeks for a user and save to Supabase
// accounts: for ics = URL string or JSON array of URLs
//           for google/microsoft = [{email, refresh_token}]
async function refreshUser(name, provider, accounts) {
  const busyWeeks = {};
  if (provider === 'ics') {
    let urls; try { urls = JSON.parse(accounts); if (!Array.isArray(urls)) throw 0; } catch { urls = [accounts]; }
    for (let i = 0; i < 4; i++) {
      const merged = {};
      for (const u of urls) { try { Object.assign(merged, await fetchIcsBusy(u, i)); } catch (e) { console.error('ICS refresh failed:', u, e.message); } }
      busyWeeks[i] = merged;
    }
  } else {
    // Get a fresh access token for each account upfront, resolve MS email
    const live = (await Promise.all(accounts.map(async acct => {
      try {
        const at = provider === 'google' ? await getNewGoogleToken(acct.refresh_token) : await getNewMicrosoftToken(acct.refresh_token);
        let email = acct.email;
        if (provider === 'microsoft') {
          const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { Authorization: 'Bearer ' + at } });
          if (!r.ok) throw new Error('Microsoft /me: ' + r.status);
          const me = await r.json();
          email = me.mail || me.userPrincipalName;
          if (!email) throw new Error('Could not determine Microsoft account email');
        }
        return { at, email };
      } catch (e) { console.error(`Token refresh failed for ${acct.email || 'unknown'}:`, e.message); return null; }
    }))).filter(Boolean);
    for (let i = 0; i < 4; i++) {
      const merged = {};
      for (const { at, email } of live) {
        try {
          Object.assign(merged, provider === 'google'
            ? await fetchGoogleBusy(at, i)
            : await fetchMicrosoftBusy(at, i, email));
        } catch (e) { console.error(`Busy fetch failed for ${email}:`, e.message); }
      }
      busyWeeks[i] = merged;
    }
  }
  await saveAvailability(name, provider, busyWeeks);
}

// ── Token refresh ────────────────────────────────────────────
async function getNewGoogleToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' })
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(data.error_description || 'Google token refresh failed');
  return data.access_token;
}

async function getNewMicrosoftToken(refreshToken) {
  const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token', scope: 'https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/User.Read offline_access' })
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(data.error_description || 'Microsoft token refresh failed');
  return data.access_token;
}

// ── Google OAuth ─────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).send('Missing name');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.freebusy openid email',
    access_type: 'offline',
    prompt: 'consent',
    state: name
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state: name, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}?auth_error=${encodeURIComponent(error)}&name=${encodeURIComponent(name || '')}`);
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT, grant_type: 'authorization_code' })
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) throw new Error('No refresh token returned — ensure prompt=consent');
    // Extract email from ID token (included because we requested openid+email scope)
    let newEmail = null;
    if (tokens.id_token) {
      try { newEmail = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()).email; } catch {}
    }
    // Merge into existing account array for this user
    const existing = await getTokensForUser(name, 'google');
    const idx = newEmail ? existing.findIndex(t => t.email === newEmail) : -1;
    if (idx >= 0) existing[idx].refresh_token = tokens.refresh_token;
    else existing.push({ email: newEmail, refresh_token: tokens.refresh_token });
    await saveToken(name, 'google', JSON.stringify(existing));
    await updateCalAccounts(name, 'google', existing.map(t => t.email).filter(Boolean));
    await refreshUser(name, 'google', existing);
    res.redirect(`${FRONTEND_URL}?connected=google&name=${encodeURIComponent(name)}`);
  } catch (e) {
    console.error('Google callback error:', e);
    res.redirect(`${FRONTEND_URL}?auth_error=${encodeURIComponent(e.message)}&name=${encodeURIComponent(name)}`);
  }
});

// ── Microsoft OAuth ──────────────────────────────────────────
app.get('/auth/microsoft', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).send('Missing name');
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    redirect_uri: MS_REDIRECT,
    response_type: 'code',
    scope: 'https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/User.Read offline_access',
    state: name
  });
  res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`);
});

app.get('/auth/microsoft/callback', async (req, res) => {
  const { code, state: name, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}?auth_error=${encodeURIComponent(error)}&name=${encodeURIComponent(name || '')}`);
  try {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, redirect_uri: MS_REDIRECT, grant_type: 'authorization_code', scope: 'https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/User.Read offline_access' })
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) throw new Error('No refresh token returned');
    // Get email for this account
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    const me = meRes.ok ? await meRes.json() : {};
    const newEmail = me.mail || me.userPrincipalName || null;
    // Merge into existing account array for this user
    const existing = await getTokensForUser(name, 'microsoft');
    const idx = newEmail ? existing.findIndex(t => t.email === newEmail) : -1;
    if (idx >= 0) existing[idx].refresh_token = tokens.refresh_token;
    else existing.push({ email: newEmail, refresh_token: tokens.refresh_token });
    await saveToken(name, 'microsoft', JSON.stringify(existing));
    await updateCalAccounts(name, 'microsoft', existing.map(t => t.email).filter(Boolean));
    await refreshUser(name, 'microsoft', existing);
    res.redirect(`${FRONTEND_URL}?connected=microsoft&name=${encodeURIComponent(name)}`);
  } catch (e) {
    console.error('Microsoft callback error:', e);
    res.redirect(`${FRONTEND_URL}?auth_error=${encodeURIComponent(e.message)}&name=${encodeURIComponent(name)}`);
  }
});

// ── Refresh all calendars ────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
  try {
    const tokenRows = await getAllTokens();
    const results = await Promise.all(tokenRows.map(async row => {
      try {
        let tokenSource;
        if (row.provider === 'ics') {
          tokenSource = row.refresh_token;
        } else {
          // Try to parse as [{email, refresh_token}] array; fall back to plain token for legacy rows
          try {
            const arr = JSON.parse(row.refresh_token);
            tokenSource = Array.isArray(arr) ? arr : [{ email: null, refresh_token: row.refresh_token }];
          } catch { tokenSource = [{ email: null, refresh_token: row.refresh_token }]; }
        }
        await refreshUser(row.name, row.provider, tokenSource);
        return { name: row.name, ok: true };
      } catch (e) {
        console.error(`Refresh failed for ${row.name}:`, e.message);
        return { name: row.name, ok: false, error: e.message };
      }
    }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/connect-ics', async (req, res) => {
  const { name, icsUrl } = req.body;
  if (!name || !icsUrl) return res.status(400).json({ error: 'Missing name or icsUrl' });
  try {
    const url = icsUrl.trim().replace(/^webcal:\/\//i, 'https://');
    // Merge with any existing ICS URLs for this user
    let urls = [url];
    try {
      const existing = await sbFetch(`tokens?name=eq.${encodeURIComponent(name)}&provider=eq.ics&select=refresh_token`);
      if (existing.length > 0) {
        let prev; try { prev = JSON.parse(existing[0].refresh_token); if (!Array.isArray(prev)) prev = [existing[0].refresh_token]; } catch { prev = [existing[0].refresh_token]; }
        if (!prev.includes(url)) prev.push(url);
        urls = prev;
      }
    } catch (e) {}
    // Fetch and merge busy slots from all URLs
    const busyWeeks = {};
    for (let i = 0; i < 4; i++) {
      const merged = {};
      for (const u of urls) { try { Object.assign(merged, await fetchIcsBusy(u, i)); } catch (e) { console.error('ICS fetch failed:', u, e.message); } }
      busyWeeks[i] = merged;
    }
    await saveToken(name, 'ics', JSON.stringify(urls));
    await saveAvailability(name, 'ics', busyWeeks);
    await updateCalAccounts(name, 'ics', urls.length);
    res.json({ ok: true, count: urls.length });
  } catch (e) {
    console.error('ICS connect error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Femmli backend listening on port ${PORT}`));
