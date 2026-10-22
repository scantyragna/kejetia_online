import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import {
  verifyPassword,
  createSession,
  readTokenFromHeaders,
  sha256,
  sessionCookieOptions,
  SESSION_COOKIE,
} from '@/lib/auth-server'

export const runtime = 'nodejs'

export async function POST(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: { message: 'Invalid request body.' } }, { status: 400 })
  }

  const email = String(body?.email || '').trim().toLowerCase()
  const password = String(body?.password || '')

  if (!email || !password) {
    return NextResponse.json(
      { data: { user: null, session: null }, error: { message: 'Email and password are required.' } },
      { status: 400 }
    )
  }

  const { rows } = await query(
    'SELECT id, email, password_hash FROM users WHERE LOWER(email) = $1',
    [email]
  )
  const match = rows[0]
  if (!match || !(await verifyPassword(password, match.password_hash))) {
    return NextResponse.json(
      { data: { user: null, session: null }, error: { message: 'Invalid email or password.' } },
      { status: 401 }
    )
  }

  const profile = await query(
    'SELECT full_name, phone, role FROM profiles WHERE id = $1',
    [match.id]
  )
  const p = profile.rows[0] || { full_name: '', phone: '', role: 'buyer' }

  const session = await createSession(match.id)
  const safeUser = {
    id: match.id,
    email: match.email,
    app_metadata: { provider: 'postgres' },
    user_metadata: { full_name: p.full_name, phone: p.phone, role: p.role },
  }

  const response = NextResponse.json(
    { data: { user: safeUser, session: { user: safeUser } }, error: null },
    { status: 200 }
  )
  response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions())
  return response
}

// A signed-in user hitting GET here is redirected by middleware; for safety
// also allow sign-in to refresh an existing session.
export async function GET(request) {
  const token = readTokenFromHeaders(request.headers)
  if (token) {
    const { rows } = await query(
      `SELECT u.id, u.email, p.full_name, p.phone, p.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN profiles p ON p.id = u.id
        WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [sha256(token)]
    )
    if (rows[0]) {
      const r = rows[0]
      const safeUser = {
        id: r.id,
        email: r.email,
        app_metadata: { provider: 'postgres' },
        user_metadata: { full_name: r.full_name, phone: r.phone, role: r.role },
      }
      return NextResponse.json({ data: { user: safeUser, session: { user: safeUser } }, error: null })
    }
  }
  return NextResponse.json({ data: { user: null, session: null }, error: null })
}