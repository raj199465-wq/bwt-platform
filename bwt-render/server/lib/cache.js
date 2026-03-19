/**
 * Simple in-memory cache for Netlify function instances
 * TTL-based, keyed by search parameters
 * Note: cache is per-function-instance (not shared across instances)
 * For production shared cache, replace with Upstash Redis
 */

const store = new Map();

const DEFAULT_TTL = 10 * 60 * 1000; // 10 minutes for flight offers
const AIRPORT_TTL = 60 * 60 * 1000; // 1 hour for airport autocomplete

function makeKey(params) {
  return JSON.stringify(params, Object.keys(params).sort());
}

function get(params) {
  const key = makeKey(params);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    store.delete(key);
    return null;
  }
  return entry.data;
}

function set(params, data, ttl = DEFAULT_TTL) {
  const key = makeKey(params);
  store.set(key, { data, expiry: Date.now() + ttl });

  // Prune old entries if store gets large
  if (store.size > 500) {
    const now = Date.now();
    for (const [k, v] of store) {
      if (now > v.expiry) store.delete(k);
    }
  }
}

function invalidate(params) {
  store.delete(makeKey(params));
}

function stats() {
  const now = Date.now();
  let active = 0, expired = 0;
  for (const [, v] of store) {
    now > v.expiry ? expired++ : active++;
  }
  return { total: store.size, active, expired };
}

module.exports = { get, set, invalidate, stats, DEFAULT_TTL, AIRPORT_TTL };
