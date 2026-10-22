// Server-only auth helpers: passwords, opaque session tokens and the
// httpOnly cookie. Used by /api/auth/* and /api/query authorization.
import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { query } from '@/lib/db'

export const SESSION_COOKIE = 'kj_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

// Async bcrypt: the sync variants block the event loop for ~100 ms per call,
// and every other request on this server shares that loop.
export async function hashPassword(password) {
  return bcrypt.hash(String(password || ''), 10)
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(String(password || ''), hash)
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function newToken() {
  return randomBytes(32).toString('hex')
}

export async function createSession(userId) {
  const token = newToken()
  const expires = new Date(Date.now() + SESSION_TTL_MS)
  await query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [sha256(token), userId, expires]
  )
  return { token, expires }
}

// Returns the signed-in user row (or null) for a request's session token.
// `is_admin` comes from the profile row — the query/events routes use it to
// grant review-queue powers (approve/reject map contributions).
export async function getUserFromToken(token) {
  if (!token) return null
  const tokenHash = sha256(token)
  const { rows } = await query(
    `SELECT u.id, u.email, COALESCE(p.is_admin, false) AS is_admin
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN profiles p ON p.id = u.id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash]
  )
  if (!rows[0]) return null

  // Touch last_seen — at most once per 10 minutes per session. Every open
  // tab polls /api/events every ~2 s; an unconditional UPDATE here turned
  // each of those polls into a database write, which on a free-tier
  // Postgres is pure waste. The conditional WHERE makes the no-op path a
  // single indexed read.
  await query(
    "UPDATE sessions SET last_seen = NOW() WHERE token_hash = $1 AND last_seen < NOW() - INTERVAL '10 minutes'",
    [tokenHash]
  ).catch(() => {})

  // Opportunistic housekeeping (~1 in 500 authenticated requests): expired
  // sessions would otherwise accumulate forever.
  if (Math.random() < 0.002) {
    await query('DELETE FROM sessions WHERE expires_at < NOW()').catch(() => {})
  }

  return rows[0]
}

export function readTokenFromHeaders(headers) {
  const cookie = headers.get('cookie') || ''
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (name === SESSION_COOKIE) return decodeURIComponent(value)
  }
  return null
}

export function sessionCookieOptions() {
  const secure = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  }
}