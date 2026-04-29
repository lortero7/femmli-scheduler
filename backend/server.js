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
  if (!r.ok) console.error('saveAvailability failed:', await r.text());
}

// ── ICS parser ───────────────────────────────────────────────
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
  const tzid = (prop.match(/TZID=([^;:]+)/i) || [])[1];
  const ref = new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +min, +sec));
  if (tzid) { try { return new Date(ref.getTime() + tzOffsetMinutes(ref, tzid) * 60000); } catch (e) {} }
  return ref;
}

function parseIcs(text) {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const periods = [];
  let inEvent = false, dtstart = null, dtend = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { inEvent = true; dtstart = dtend = null; continue; }
    if (line === 'END:VEVENT') {
      if (dtstart && dtend) periods.push({ start: dtstart.toISOString(), end: dtend.toISOString() });
      inEvent = false; continue;
    }
    if (!inEvent) continue;
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const prop = line.substring(0, ci), val = line.substring(ci + 1);
    const key = prop.split(';')[0].toUpperCase();
    if (key === 'DTSTART') dtstart = parseIcsDate(prop, val);
    else if (key === 'DTEND') dtend = parseIcsDate(prop, val);
    else if (key === 'DURATION' && dtstart) {
      const dm = val.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
      if (dm) dtend = new Date(dtstart.getTime() +
        ((+(dm[1]||0))*86400 + (+(dm[2]||0))*3600 + (+(dm[3]||0))*60 + (+(dm[4]||0))) * 1000);
    }
  }
  return periods;
}

async function fetchIcsBusy(icsUrl, weekOffset) {
  const r = await fetch(icsUrl);
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
async function refreshUser(name, provider, accessToken) {
  const busyWeeks = {};
  if (provider === 'ics') {
    for (let i = 0; i < 4; i++) busyWeeks[i] = await fetchIcsBusy(accessToken, i);
  } else {
    let msEmail = null;
    if (provider === 'microsoft') {
      const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
        headers: { 'Authorization': 'Bearer ' + accessToken }
      });
      if (!r.ok) throw new Error('Microsoft /me: ' + r.status);
      const me = await r.json();
      msEmail = me.mail || me.userPrincipalName;
      if (!msEmail) throw new Error('Could not determine Microsoft account email');
    }
    for (let i = 0; i < 4; i++) {
      busyWeeks[i] = provider === 'google'
        ? await fetchGoogleBusy(accessToken, i)
        : await fetchMicrosoftBusy(accessToken, i, msEmail);
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
    scope: 'https://www.googleapis.com/auth/calendar.freebusy',
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
    await saveToken(name, 'google', tokens.refresh_token);
    await refreshUser(name, 'google', tokens.access_token);
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
    await saveToken(name, 'microsoft', tokens.refresh_token);
    await refreshUser(name, 'microsoft', tokens.access_token);
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
        const accessToken = row.provider === 'google'
          ? await getNewGoogleToken(row.refresh_token)
          : row.provider === 'microsoft'
          ? await getNewMicrosoftToken(row.refresh_token)
          : row.refresh_token; // ICS: stored value is the URL itself
        await refreshUser(row.name, row.provider, accessToken);
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
    const busyWeeks = {};
    for (let i = 0; i < 4; i++) busyWeeks[i] = await fetchIcsBusy(icsUrl, i);
    await saveToken(name, 'ics', icsUrl);
    await saveAvailability(name, 'ics', busyWeeks);
    res.json({ ok: true });
  } catch (e) {
    console.error('ICS connect error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Femmli backend listening on port ${PORT}`));
