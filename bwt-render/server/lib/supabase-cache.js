/**
 * lib/supabase-cache.js
 *
 * Persistent fare cache backed by Supabase.
 * Falls back gracefully to in-memory cache if Supabase is unavailable.
 *
 * Env vars required:
 *   SUPABASE_URL          — e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  — service_role key (not anon key)
 */

const memCache = require('./cache'); // in-memory fallback

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY &&
  SUPABASE_URL.startsWith('https://') && SUPABASE_URL.includes('.supabase.co'));

if (!SUPABASE_ENABLED) {
  console.log('[supabase-cache] Supabase not configured — using in-memory cache only');
}

const FRESH_TTL_H  = 6;     // hours before refreshing from live API
const STALE_MAX_H  = 48;    // max age we'll serve with stale label

// ── Supabase REST helper ──────────────────────────────────────────────────────
async function sb(method, path, body) {
  if (!SUPABASE_ENABLED) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'apikey':         SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer':         method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('[supabase-cache] HTTP', res.status, txt.slice(0, 200));
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('[supabase-cache] fetch error:', e.message);
    return null;
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Round a date string down to the Monday of its week (ISO week). */
function toWeekStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z'); // noon UTC to avoid DST issues
  const day = d.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
  const diff = day === 0 ? -6 : 1 - day;     // days to subtract to get to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);        // YYYY-MM-DD
}

/** ISO string for N hours from now */
function hoursFromNow(h) {
  return new Date(Date.now() + h * 3600 * 1000).toISOString();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up cached fares.
 *
 * Returns:
 *   { offers, status, ageHours, cachedAt }  — if found
 *   null                                    — if not found at all
 *
 * status values:
 *   'fresh'  — within TTL, serve directly
 *   'stale'  — past TTL but within STALE_MAX_H, serve with stale label + trigger refresh
 *   'dead'   — too old to serve
 */
async function getCached({ origin, destination, cabin = 'BUSINESS', departureDate }) {
  const weekStart = toWeekStart(departureDate);
  const orig = origin.toUpperCase();
  const dest = destination.toUpperCase();

  // Check in-memory first (avoids a Supabase round-trip on hot routes)
  const memKey = { fn: 'fare_cache', orig, dest, cabin, weekStart };
  const memHit = memCache.get(memKey);
  if (memHit) {
    return { offers: memHit.offers, status: 'fresh', ageHours: 0, cachedAt: new Date().toISOString(), fromMemory: true };
  }

  // Query Supabase — skip if not configured
  if (!SUPABASE_ENABLED) return null;
  const rows = await sb('GET',
    `/fare_cache?origin=eq.${orig}&destination=eq.${dest}&cabin=eq.${cabin}&week_start=eq.${weekStart}&select=offers,fetched_at,expires_at,is_stale,offer_count&order=fetched_at.desc&limit=1`
  );

  if (!rows?.length) return null;

  const row     = rows[0];
  const ageMs   = Date.now() - new Date(row.fetched_at).getTime();
  const ageH    = ageMs / 3600000;
  const isFresh = new Date(row.expires_at) > new Date();
  const isDead  = ageH > STALE_MAX_H;

  if (isDead) return null;

  const status = isFresh ? 'fresh' : 'stale';

  // Warm the in-memory cache so next request doesn't hit Supabase
  if (status === 'fresh') {
    memCache.set(memKey, { offers: row.offers }, 60 * 60 * 1000); // 1hr in-memory
  }

  // Async increment hit counter (fire-and-forget)
  sb('PATCH',
    `/fare_cache?origin=eq.${orig}&destination=eq.${dest}&cabin=eq.${cabin}&week_start=eq.${weekStart}`,
    { hit_count: row.hit_count + 1, last_hit_at: new Date().toISOString() }
  ).catch(() => {});

  return {
    offers:   row.offers,
    status,
    ageHours: Math.round(ageH * 10) / 10,
    cachedAt: row.fetched_at,
  };
}

/**
 * Save fares to Supabase (upsert by route+cabin+week).
 * Also writes to in-memory cache for fast subsequent hits.
 */
async function setCached({ origin, destination, cabin = 'BUSINESS', departureDate, offers, source = 'serpapi' }) {
  const weekStart = toWeekStart(departureDate);
  const orig = origin.toUpperCase();
  const dest = destination.toUpperCase();

  const row = {
    origin:      orig,
    destination: dest,
    cabin,
    week_start:  weekStart,
    offers:      offers,
    source,
    fetched_at:  new Date().toISOString(),
    expires_at:  hoursFromNow(FRESH_TTL_H),
    is_stale:    false,
    hit_count:   0,
  };

  // Write to Supabase
  const result = await sb('POST', '/fare_cache', row);
  if (!result) {
    console.warn('[supabase-cache] Supabase write failed, fares not persisted');
  }

  // Always write to in-memory so this instance benefits immediately
  const memKey = { fn: 'fare_cache', orig, dest, cabin, weekStart };
  memCache.set(memKey, { offers }, 60 * 60 * 1000);

  return !!result;
}

/**
 * Log a cache access event for analytics.
 */
async function logAccess({ origin, destination, cabin, servedFrom, cacheAgeH, offerCount, ipHash }) {
  await sb('POST', '/fare_cache_log', {
    origin:       origin.toUpperCase(),
    destination:  destination.toUpperCase(),
    cabin,
    served_from:  servedFrom,
    cache_age_h:  cacheAgeH ?? null,
    offer_count:  offerCount ?? 0,
    ip_hash:      ipHash || null,
  }).catch(() => {}); // never throw — logging is best-effort
}

/**
 * Get all routes configured for nightly warm-up.
 */
async function getWarmRoutes() {
  const rows = await sb('GET', '/warm_routes?active=eq.true&order=priority.asc');
  return rows || [];
}

/**
 * Get cache status for the agent dashboard.
 */
async function getCacheStatus() {
  const rows = await sb('GET', '/fare_cache?select=origin,destination,cabin,week_start,offer_count,fetched_at,expires_at,hit_count,source&order=fetched_at.desc&limit=100');
  return (rows || []).map(r => ({
    route:      `${r.origin}→${r.destination}`,
    origin:     r.origin,
    destination:r.destination,
    cabin:      r.cabin,
    weekStart:  r.week_start,
    offerCount: r.offer_count,
    fetchedAt:  r.fetched_at,
    expiresAt:  r.expires_at,
    ageHours:   Math.round((Date.now() - new Date(r.fetched_at).getTime()) / 360000) / 10,
    isFresh:    new Date(r.expires_at) > new Date(),
    hits:       r.hit_count,
    source:     r.source,
  }));
}

module.exports = {
  getCached,
  setCached,
  logAccess,
  getWarmRoutes,
  getCacheStatus,
  toWeekStart,
  FRESH_TTL_H,
  STALE_MAX_H,
};
