import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import {
  hashPassword,
  createSession,
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
  const meta = body?.options?.data || {}
  const role = meta.role === 'seller' ? 'seller' : 'buyer'
  const full_name = String(meta.full_name || '').slice(0, 200)
  const phone = String(meta.phone || '').slice(0, 60)

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json(
      { data: { user: null, session: null }, error: { message: 'Enter a valid email address.' } },
      { status: 400 }
    )
  }
  if (password.length < 6) {
    return NextResponse.json(
      { data: { user: null, session: null }, error: { message: 'Password must be at least 6 characters.' } },
      { status: 400 }
    )
  }

  const existing = await query('SELECT id FROM users WHERE LOWER(email) = $1', [email])
  if (existing.rows.length) {
    return NextResponse.json(
      {
        data: { user: null, session: null },
        error: { message: 'An account with this email already exists. Try logging in.' },
      },
      { status: 409 }
    )
  }

  const inserted = await query(
    `WITH new_user AS (
       INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email
     ),
     new_profile AS (
       INSERT INTO profiles (id, full_name, phone, role)
       SELECT id, $3, $4, $5 FROM new_user
       RETURNING id, full_name, phone, role
     )
     SELECT u.id, u.email, p.full_name, p.phone, p.role
       FROM new_user u JOIN new_profile p ON p.id = u.id`,
    [email, await hashPassword(password), full_name, phone, role]
  )

  const user = inserted.rows[0]
  const session = await createSession(user.id)

  const safeUser = {
    id: user.id,
    email: user.email,
    app_metadata: { provider: 'postgres' },
    user_metadata: { full_name: user.full_name, phone: user.phone, role: user.role },
  }

  const response = NextResponse.json(
    { data: { user: safeUser, session: { user: safeUser } }, error: null },
    { status: 201 }
  )
  response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions())
  return response
}