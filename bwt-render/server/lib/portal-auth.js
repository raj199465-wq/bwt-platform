/**
 * portal-auth.js
 * Server-side auth for BWT Corporate Portal using Supabase
 */

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);

if (!ENABLED) console.log('[portal-auth] Supabase not configured — portal auth unavailable');

// ── HTTP helper ──────────────────────────────────────────────────────────────
async function sb(method, table, body, params) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  if (params) Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  const r = await fetch(url.toString(), {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: text ? JSON.parse(text) : null }; }
  catch(e) { return { ok: r.ok, status: r.status, data: text }; }
}

// ── Password hashing ─────────────────────────────────────────────────────────
function hashPw(pw) {
  return crypto.createHash('sha256').update(pw + 'bwt_salt_2026').digest('hex');
}

// ── Users ────────────────────────────────────────────────────────────────────
async function createUser({ email, password, firstName, lastName, phone, companyId, role }) {
  const res = await sb('POST', 'users', {
    email: email.toLowerCase(),
    password_hash: hashPw(password),
    first_name: firstName,
    last_name: lastName,
    phone: phone || '',
    company_id: companyId,
    role: role || 'admin',
  });
  return res;
}

async function getUser(email) {
  const res = await sb('GET', 'users', null, { email: `eq.${email.toLowerCase()}`, limit: 1 });
  return res.ok && res.data?.length ? res.data[0] : null;
}

async function verifyPassword(email, password) {
  const user = await getUser(email);
  if (!user) return null;
  if (user.password_hash !== hashPw(password)) return null;
  return user;
}

// ── Companies ────────────────────────────────────────────────────────────────
async function createCompany({ id, name, industry, teamSize }) {
  const res = await sb('POST', 'companies', {
    id,
    name,
    industry: industry || '',
    team_size: teamSize || '',
    status: 'pending',
  });
  return res;
}

async function getCompany(id) {
  const res = await sb('GET', 'companies', null, { id: `eq.${id}`, limit: 1 });
  return res.ok && res.data?.length ? res.data[0] : null;
}

async function getCompanyByUser(email) {
  const user = await getUser(email);
  if (!user?.company_id) return null;
  return getCompany(user.company_id);
}

async function updateCompanyStatus(companyId, status) {
  const res = await sb('PATCH', `companies?id=eq.${companyId}`, { status });
  return res;
}

// ── Sessions ─────────────────────────────────────────────────────────────────
async function createSession(email) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  await sb('POST', 'sessions', { token, email: email.toLowerCase(), expires_at: expires });
  return token;
}

async function getSession(token) {
  const res = await sb('GET', 'sessions', null, { token: `eq.${token}`, limit: 1 });
  if (!res.ok || !res.data?.length) return null;
  const sess = res.data[0];
  if (new Date(sess.expires_at) < new Date()) {
    await deleteSession(token);
    return null;
  }
  return sess;
}

async function deleteSession(token) {
  await sb('DELETE', `sessions?token=eq.${token}`, null);
}

module.exports = {
  ENABLED,
  createUser, getUser, verifyPassword,
  createCompany, getCompany, getCompanyByUser, updateCompanyStatus,
  createSession, getSession, deleteSession,
  hashPw,
};
