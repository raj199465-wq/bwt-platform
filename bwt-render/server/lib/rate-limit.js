/**
 * Simple rate limiter — sliding window, in-memory
 * For production, replace backing store with Upstash Redis
 */

const windows = new Map();

/**
 * @param {string} key       - e.g. IP address or user ID
 * @param {number} limit     - max requests
 * @param {number} windowMs  - window size in milliseconds
 * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
 */
function check(key, limit = 20, windowMs = 60_000) {
  const now = Date.now();
  const windowStart = now - windowMs;

  if (!windows.has(key)) windows.set(key, []);
  const timestamps = windows.get(key);

  // Remove timestamps outside window
  while (timestamps.length && timestamps[0] < windowStart) timestamps.shift();

  const remaining = Math.max(0, limit - timestamps.length);
  const allowed   = timestamps.length < limit;

  if (allowed) timestamps.push(now);

  const resetAt = timestamps.length ? timestamps[0] + windowMs : now + windowMs;

  // Prune old keys
  if (windows.size > 10_000) {
    for (const [k, ts] of windows) {
      if (!ts.length || ts[ts.length - 1] < windowStart) windows.delete(k);
    }
  }

  return { allowed, remaining: allowed ? remaining - 1 : 0, resetAt };
}

/**
 * Extract best available IP from Netlify event headers
 */
function getIP(event) {
  return (
    event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
    event.headers?.['x-nf-client-connection-ip'] ||
    event.headers?.['client-ip'] ||
    'unknown'
  );
}

module.exports = { check, getIP };
