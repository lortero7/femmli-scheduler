const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');
const app = express();

app.use(cors({ origin: new URL(process.env.FRONTEND_URL || 'https://lortero7.github.io/team-availability').origin }));
app.use(express.json());

const {
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
  MS_CLIENT_ID, MS_CLIENT_SECRET,
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  BACKEND_URL,
  FRONTEND_URL = 'https://lortero7.github.io/team-availability',
  ADMIN_KEY,
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

// OAuth state encoding — carries both name and teamId through the OAuth round-trip
function encodeState(name, teamId) {
  return JSON.stringify({ name, teamId });
}

function decodeState(raw) {
  try {
    const obj = JSON.parse(raw || '{}');
    return { name: obj.name || '', teamId: obj.teamId || '' };
  } catch {
    return { name: raw || '', teamId: '' };
  }
}

async function saveToken(teamId, name, provider, refreshToken) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/tokens?on_conflict=team_id,name,provider`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ team_id: teamId, name, provider, refresh_token: refreshToken, updated_at: new Date().toISOString() })
  });
  if (!r.ok) console.error('saveToken failed:', await r.text());
}

async function getAllTokens(teamId) {
  const filter = teamId ? `team_id=eq.${encodeURIComponent(teamId)}&` : '';
  return sbFetch(`tokens?${filter}select=team_id,name,provider,refresh_token`);
}

async function getTokensForUser(teamId, name, provider) {
  try {
    const rows = await sbFetch(`tokens?team_id=eq.${encodeURIComponent(teamId)}&name=eq.${encodeURIComponent(name)}&provider=eq.${provider}&select=refresh_token`);
    if (!rows.length) return [];
    try {
      const arr = JSON.parse(rows[0].refresh_token);
      return Array.isArray(arr) ? arr : [{ email: null, refresh_token: rows[0].refresh_token }];
    } catch { return [{ email: null, refresh_token: rows[0].refresh_token }]; }
  } catch { return []; }
}

async function updateCalAccounts(teamId, name, provider, value) {
  let accounts = {};
  try {
    const rows = await sbFetch(`availability?team_id=eq.${encodeURIComponent(teamId)}&name=eq.${encodeURIComponent(name)}&select=cal_accounts`);
    if (rows.length && rows[0].cal_accounts) accounts = JSON.parse(rows[0].cal_accounts);
  } catch {}
  accounts[provider] = value;
  await fetch(`${SUPABASE_URL}/rest/v1/availability?on_conflict=team_id,name`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ team_id: teamId, name, cal_accounts: JSON.stringify(accounts), updated_at: new Date().toISOString() })
  }).catch(e => console.error('updateCalAccounts failed:', e.message));
}

async function saveAvailability(teamId, name, provider, busyWeeks) {
  const col = provider === 'google' ? 'google_busy' : provider === 'microsoft' ? 'microsoft_busy' : 'ics_busy';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/availability?on_conflict=team_id,name`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({
      team_id: teamId,
      name,
      cal_provider: provider,
      [col]: JSON.stringify(busyWeeks),
      updated_at: new Date().toISOString()
    })
  });
  if (!r.ok) throw new Error('saveAvailability failed: ' + await r.text());
}

// ── ICS parser ───────────────────────────────────────────────
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
  const tz = tzid || 'America/New_York';
  try { return new Date(ref.getTime() + tzOffsetMinutes(ref, tz) * 60000); } catch (e) {}
  return ref;
}

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
  let inEvent = false, inFreebusy = false, dtstart = null, dtend = null, rrule = null, isAllDay = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { inEvent = true; dtstart = dtend = rrule = null; isAllDay = false; continue; }
    if (line === 'END:VEVENT') {
      if (dtstart && dtend && !isAllDay && (dtend.getTime() - dtstart.getTime()) < 24 * 3600 * 1000) {
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
      if (key === 'DTSTART') { isAllDay = /VALUE=DATE(?!-TIME)/i.test(prop); dtstart = parseIcsDate(prop, val); }
      else if (key === 'DTEND') dtend = parseIcsDate(prop, val);
      else if (key === 'RRULE') rrule = val;
      else if (key === 'DURATION' && dtstart) {
        const ms = parseDuration(val);
        if (ms) dtend = new Date(dtstart.getTime() + ms);
      }
    } else if (inFreebusy && key === 'FREEBUSY') {
      if (/FBTYPE=FREE/i.test(prop)) continue;
      for (const fbv of val.split(',')) {
        const slash = fbv.indexOf('/');
        if (slash < 0) continue;
        const start = parseIcsDate('', fbv.substring(0, slash));
        const endPart = fbv.substring(slash + 1);
        const end = /^P/.test(endPart) && start
          ? new Date(start.getTime() + parseDuration(endPart))
          : parseIcsDate('', endPart);
        if (start && end && (end.getTime() - start.getTime()) < 24 * 3600 * 1000) periods.push({ start: start.toISOString(), end: end.toISOString() });
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

function getEasternOffset(date) {
  const noonUTC = new Date(date);
  noonUTC.setUTCHours(12, 0, 0, 0);
  const h = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false
  }).format(noonUTC));
  return h - 12;
}

function easternOffsetStr(offset) {
  return offset === -4 ? '-04:00' : '-05:00';
}

function getWeekDates(offset = 0) {
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
  const allPeriods = data.calendars?.primary?.busy || [];
  const timedPeriods = allPeriods.filter(p => new Date(p.end) - new Date(p.start) < 24 * 3600 * 1000);
  return busyPeriodsToSlots(timedPeriods, dates);
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
    if (['busy', 'tentative', 'oof'].includes(item.status) && item.start?.dateTime && item.end?.dateTime && !item.isAllDay)
      periods.push({ start: item.start.dateTime + 'Z', end: item.end.dateTime + 'Z' });
  }));
  return busyPeriodsToSlots(periods, dates);
}

async function refreshUser(teamId, name, provider, accounts) {
  const busyWeeks = {};
  if (provider === 'ics') {
    let urls; try { urls = JSON.parse(accounts); if (!Array.isArray(urls)) throw 0; } catch { urls = [accounts]; }
    for (let i = 0; i < 4; i++) {
      const merged = {};
      for (const u of urls) { try { Object.assign(merged, await fetchIcsBusy(u, i)); } catch (e) { console.error('ICS refresh failed:', u, e.message); } }
      busyWeeks[i] = merged;
    }
  } else {
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
  await saveAvailability(teamId, name, provider, busyWeeks);
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

// ── Slug helpers ─────────────────────────────────────────────
function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
}

async function generateUniqueSlug(name) {
  const base = toSlug(name);
  const rows = await sbFetch(`teams?slug=eq.${encodeURIComponent(base)}&select=id`);
  if (!rows.length) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    const r = await sbFetch(`teams?slug=eq.${encodeURIComponent(candidate)}&select=id`);
    if (!r.length) return candidate;
  }
  return `${base}-${Date.now()}`;
}

async function getTeamSlug(teamId) {
  try {
    const rows = await sbFetch(`teams?id=eq.${encodeURIComponent(teamId)}&select=slug`);
    return rows.length && rows[0].slug ? rows[0].slug : teamId;
  } catch { return teamId; }
}

// ── Teams ────────────────────────────────────────────────────
app.post('/api/teams', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Missing team name' });
  const id = randomUUID();
  const slug = await generateUniqueSlug(name.trim());
  const r = await fetch(`${SUPABASE_URL}/rest/v1/teams`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'return=representation' },
    body: JSON.stringify({ id, name: name.trim(), slug, created_at: new Date().toISOString() })
  });
  if (!r.ok) return res.status(500).json({ error: 'Failed to create team: ' + await r.text() });
  res.json({ id, name: name.trim(), slug });
});

// ── Google OAuth ─────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const { name, team_id: teamId } = req.query;
  if (!name || !teamId) return res.status(400).send('Missing name or team_id');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.freebusy openid email',
    access_type: 'offline',
    prompt: 'consent',
    state: encodeState(name, teamId)
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state: stateRaw, error } = req.query;
  const { name, teamId } = decodeState(stateRaw);
  const slug = await getTeamSlug(teamId);
  const redirectBase = `${FRONTEND_URL}/${encodeURIComponent(slug)}`;
  if (error) return res.redirect(`${redirectBase}?auth_error=${encodeURIComponent(error)}&name=${encodeURIComponent(name)}`);
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT, grant_type: 'authorization_code' })
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) throw new Error('No refresh token returned — ensure prompt=consent');
    let newEmail = null;
    if (tokens.id_token) {
      try { newEmail = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()).email; } catch {}
    }
    const existing = await getTokensForUser(teamId, name, 'google');
    const idx = newEmail ? existing.findIndex(t => t.email === newEmail) : -1;
    if (idx >= 0) existing[idx].refresh_token = tokens.refresh_token;
    else existing.push({ email: newEmail, refresh_token: tokens.refresh_token });
    await saveToken(teamId, name, 'google', JSON.stringify(existing));
    await updateCalAccounts(teamId, name, 'google', existing.map(t => t.email).filter(Boolean));
    await refreshUser(teamId, name, 'google', existing);
    res.redirect(`${redirectBase}?connected=google&name=${encodeURIComponent(name)}`);
  } catch (e) {
    console.error('Google callback error:', e);
    res.redirect(`${redirectBase}&auth_error=${encodeURIComponent(e.message)}&name=${encodeURIComponent(name)}`);
  }
});

// ── Microsoft OAuth ──────────────────────────────────────────
app.get('/auth/microsoft', (req, res) => {
  const { name, team_id: teamId } = req.query;
  if (!name || !teamId) return res.status(400).send('Missing name or team_id');
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    redirect_uri: MS_REDIRECT,
    response_type: 'code',
    scope: 'https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/User.Read offline_access',
    state: encodeState(name, teamId)
  });
  res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`);
});

app.get('/auth/microsoft/callback', async (req, res) => {
  const { code, state: stateRaw, error } = req.query;
  const { name, teamId } = decodeState(stateRaw);
  const slug = await getTeamSlug(teamId);
  const redirectBase = `${FRONTEND_URL}/${encodeURIComponent(slug)}`;
  if (error) return res.redirect(`${redirectBase}?auth_error=${encodeURIComponent(error)}&name=${encodeURIComponent(name)}`);
  try {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, redirect_uri: MS_REDIRECT, grant_type: 'authorization_code', scope: 'https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/User.Read offline_access' })
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) throw new Error('No refresh token returned');
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    const me = meRes.ok ? await meRes.json() : {};
    const newEmail = me.mail || me.userPrincipalName || null;
    const existing = await getTokensForUser(teamId, name, 'microsoft');
    const idx = newEmail ? existing.findIndex(t => t.email === newEmail) : -1;
    if (idx >= 0) existing[idx].refresh_token = tokens.refresh_token;
    else existing.push({ email: newEmail, refresh_token: tokens.refresh_token });
    await saveToken(teamId, name, 'microsoft', JSON.stringify(existing));
    await updateCalAccounts(teamId, name, 'microsoft', existing.map(t => t.email).filter(Boolean));
    await refreshUser(teamId, name, 'microsoft', existing);
    res.redirect(`${redirectBase}?connected=microsoft&name=${encodeURIComponent(name)}`);
  } catch (e) {
    console.error('Microsoft callback error:', e);
    res.redirect(`${redirectBase}&auth_error=${encodeURIComponent(e.message)}&name=${encodeURIComponent(name)}`);
  }
});

// ── Refresh all calendars ────────────────────────────────────
app.post('/api/refresh', async (req, res) => {
  const { teamId } = req.body || {};
  try {
    const tokenRows = await getAllTokens(teamId);
    const results = [];
    for (const row of tokenRows) {
      try {
        let tokenSource;
        if (row.provider === 'ics') {
          tokenSource = row.refresh_token;
        } else {
          try {
            const arr = JSON.parse(row.refresh_token);
            tokenSource = Array.isArray(arr) ? arr : [{ email: null, refresh_token: row.refresh_token }];
          } catch { tokenSource = [{ email: null, refresh_token: row.refresh_token }]; }
        }
        await refreshUser(row.team_id, row.name, row.provider, tokenSource);
        results.push({ name: row.name, ok: true });
      } catch (e) {
        console.error(`Refresh failed for ${row.name}:`, e.message);
        results.push({ name: row.name, ok: false, error: e.message });
      }
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/connect-ics', async (req, res) => {
  const { name, icsUrl, teamId } = req.body;
  if (!name || !icsUrl || !teamId) return res.status(400).json({ error: 'Missing name, icsUrl, or teamId' });
  try {
    const url = icsUrl.trim().replace(/^webcal:\/\//i, 'https://');
    let urls = [url];
    try {
      const existing = await sbFetch(`tokens?team_id=eq.${encodeURIComponent(teamId)}&name=eq.${encodeURIComponent(name)}&provider=eq.ics&select=refresh_token`);
      if (existing.length > 0) {
        let prev; try { prev = JSON.parse(existing[0].refresh_token); if (!Array.isArray(prev)) prev = [existing[0].refresh_token]; } catch { prev = [existing[0].refresh_token]; }
        if (!prev.includes(url)) prev.push(url);
        urls = prev;
      }
    } catch (e) {}
    const busyWeeks = {};
    for (let i = 0; i < 4; i++) {
      const merged = {};
      for (const u of urls) { try { Object.assign(merged, await fetchIcsBusy(u, i)); } catch (e) { console.error('ICS fetch failed:', u, e.message); } }
      busyWeeks[i] = merged;
    }
    await saveToken(teamId, name, 'ics', JSON.stringify(urls));
    await saveAvailability(teamId, name, 'ics', busyWeeks);
    await updateCalAccounts(teamId, name, 'ics', urls.length);
    res.json({ ok: true, count: urls.length });
  } catch (e) {
    console.error('ICS connect error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin ────────────────────────────────────────────────────
function requireAdmin(req, res) {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/admin/teams', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [teams, avail] = await Promise.all([
      sbFetch('teams?select=id,name,slug,created_at&order=created_at.desc'),
      sbFetch('availability?select=team_id,name,updated_at')
    ]);
    const byTeam = {};
    avail.forEach(a => {
      if (!byTeam[a.team_id]) byTeam[a.team_id] = { count: 0, lastActive: null };
      byTeam[a.team_id].count++;
      if (!byTeam[a.team_id].lastActive || a.updated_at > byTeam[a.team_id].lastActive)
        byTeam[a.team_id].lastActive = a.updated_at;
    });
    res.json(teams.map(t => ({
      id: t.id, name: t.name, slug: t.slug, createdAt: t.created_at,
      memberCount: byTeam[t.id]?.count || 0,
      lastActive: byTeam[t.id]?.lastActive || null
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/teams/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { id } = req.params;
  try {
    for (const path of [
      `tokens?team_id=eq.${encodeURIComponent(id)}`,
      `availability?team_id=eq.${encodeURIComponent(id)}`,
      `teams?id=eq.${encodeURIComponent(id)}`
    ]) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'DELETE', headers: sbHeaders });
      if (!r.ok) throw new Error(`Delete ${path}: ${await r.text()}`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
