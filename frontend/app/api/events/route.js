// Realtime polling endpoint (replaces Supabase Realtime).
//
// The client polls every ~2s sending: { channels: [{table, event, filter}], since }
// The server returns rows that changed after `since` for each channel
// registration. `messages` is append-only so it has no updated_at column —
// it is detected purely by created_at.
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { readTokenFromHeaders, getUserFromToken } from '@/lib/auth-server'

export const runtime = 'nodejs'

const POLL_TABLES = new Set([
  'stores', 'products', 'landmarks', 'reviews',
  'conversations', 'messages', 'user_locations', 'location_trails',
])

// Participant-only tables: polled rows must belong to the signed-in user.
const PRIVATE_TABLES = new Set(['conversations', 'messages'])

// Only these tables carry updated_at; the rest are INSERT-only change sources.
const HAS_UPDATED_AT = new Set(['stores', 'products', 'conversations', 'user_locations'])

function parseFilter(filter) {
  if (!filter) return null
  const m = String(filter).match(/([A-Za-z_][A-Za-z0-9_]*)=eq\.(.+)/)
  if (!m) return null
  try {
    return { column: m[1], value: decodeURIComponent(m[2].trim()) }
  } catch {
    return { column: m[1], value: m[2].trim() }
  }
}

export async function POST(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const channels = Array.isArray(body?.channels) ? body.channels : []
  const since = body?.since ? new Date(body.since) : new Date(0)
  const now = new Date().toISOString()

  // Only authenticated users may poll private tables.
  const token = readTokenFromHeaders(request.headers)
  let user = null
  const needsAuth = channels.some((c) => PRIVATE_TABLES.has(c?.table))
  if (needsAuth) {
    user = await getUserFromToken(token)
    if (!user) {
      return NextResponse.json({ events: [], now }, { status: 200 })
    }
  }

  const events = []
  for (const ch of channels) {
    const table = ch?.table
    const wantEvent = ch?.event || '*'
    if (!table || !POLL_TABLES.has(table)) continue

    const hasUpdatedAt = HAS_UPDATED_AT.has(table)
    const changedSince = hasUpdatedAt
      ? '(created_at > $1 OR updated_at > $1)'
      : 'created_at > $1'
    const params = [since.toISOString()]

    let filterSql = ''
    const f = parseFilter(ch?.filter)
    if (f) {
      params.push(f.value)
      filterSql = ` AND ${f.column} = $${params.length}`
    }

    // Private tables: only return rows the signed-in user may see.
    if (table === 'conversations') {
      if (!user) continue
      params.push(user.id)
      filterSql += ` AND (buyer_id = $${params.length} OR store_id IN (SELECT id FROM stores WHERE owner_id = $${params.length}))`
    } else if (table === 'messages') {
      if (!user) continue
      params.push(user.id)
      filterSql += ` AND conversation_id IN (SELECT id FROM conversations WHERE buyer_id = $${params.length} OR store_id IN (SELECT id FROM stores WHERE owner_id = $${params.length}))`
    }

    const sql = `SELECT * FROM ${table} WHERE ${changedSince}${filterSql} LIMIT 200`
    let rows = []
    try {
      const result = await query(sql, params)
      rows = result.rows
    } catch (err) {
      console.error(`[events] poll ${table} failed:`, err.message)
      continue
    }

    for (const row of rows) {
      const isNew = !hasUpdatedAt || new Date(row.created_at) > since
      const ev = isNew ? 'INSERT' : 'UPDATE'
      if (wantEvent !== '*' && wantEvent !== ev) continue
      events.push({ table, schema: 'public', event: ev, filter: ch.filter, new: row })
    }
  }

  return NextResponse.json({ events, now }, { status: 200 })
}