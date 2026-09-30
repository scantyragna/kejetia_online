// Generic Postgres query proxy.
//
// The browser client (lib/supabase.js in "postgres" mode) sends a fluent
// operation list:  { table, ops: [{op, args}] }.
// This route turns it into parameterized SQL, applies server-side
// authorization (the replacement for Supabase RLS), and returns
// { data, error } in the same shape the app already consumes.
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { readTokenFromHeaders, getUserFromToken } from '@/lib/auth-server'

export const runtime = 'nodejs'

// ── Table allowlist ────────────────────────────────────────────
const READ_TABLES = new Set([
  'profiles', 'stores', 'products', 'reviews', 'landmarks',
  'conversations', 'messages', 'user_locations', 'location_trails',
])
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

// Columns a client may write for each table.
const INSERT_COLUMNS = {
  stores: ['name', 'description', 'phone', 'whatsapp', 'address', 'category', 'icon', 'image_url', 'operating_hours', 'latitude', 'longitude', 'is_active'],
  products: ['store_id', 'name', 'description', 'price', 'old_price', 'stock', 'category', 'icon', 'images', 'is_available'],
  reviews: ['store_id', 'rating', 'comment', 'author_name', 'author_id'],
  conversations: ['store_id'],
  messages: ['conversation_id', 'content'],
  landmarks: ['name', 'notes', 'category', 'latitude', 'longitude', 'photo_url', 'store_id', 'created_by'],
  user_locations: ['latitude', 'longitude', 'accuracy'],
  location_trails: ['latitude', 'longitude', 'accuracy'],
}
const UPDATE_COLUMNS = {
  stores: ['name', 'description', 'phone', 'whatsapp', 'address', 'category', 'icon', 'image_url', 'operating_hours', 'latitude', 'longitude', 'is_active', 'rating', 'review_count'],
  products: ['name', 'description', 'price', 'old_price', 'stock', 'category', 'icon', 'images', 'is_available'],
  profiles: ['full_name', 'phone', 'role', 'city', 'avatar_url'],
  user_locations: ['latitude', 'longitude', 'accuracy'],
}

function fail(message, status = 403) {
  return NextResponse.json({ data: null, error: { message } }, { status })
}

function ok(data) {
  return NextResponse.json({ data, error: null }, { status: 200 })
}

function assertIdent(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new Error(`Invalid column name: ${name}`)
}

// Split on top-level commas (not inside parentheses).
function splitTopLevel(str) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of String(str)) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

// Parse select specs such as:
//   '*'  'id'  '*, stores(name, phone), buyer:profiles!buyer_id(full_name)'
function parseSelectSpec(spec) {
  if (!spec || spec === '*') return { main: ['*'], embeds: [] }
  if (IDENT.test(spec)) return { main: [spec], embeds: [] }

  const main = ['*']
  const embeds = []
  for (const part of splitTopLevel(spec)) {
    if (part === '*') continue
    const m = part.match(/^(?:([A-Za-z_][A-Za-z0-9_]*):)?([A-Za-z_][A-Za-z0-9_]*)!?([A-Za-z_][A-Za-z0-9_]*)?\(([^()]*)\)$/)
    if (!m) continue
    const alias = m[1] || m[2]
    const table = m[2]
    const fkColumn = m[3] || null
    const cols = splitTopLevel(m[4]).filter((c) => IDENT.test(c))
    embeds.push({ alias, table, fkColumn, cols })
  }
  return { main, embeds }
}

// Best-effort FK column for an embedded resource (PostgREST-style).
function fkColumnFor(embedTable, parentTable, fkColumn) {
  if (fkColumn) return fkColumn
  if (embedTable.endsWith('s')) return `${embedTable.slice(0, -1)}_id`
  return `${embedTable}_id`
}

async function buildSelectSQL(table, ops, user) {
  const spec = (ops.find((o) => o.op === 'select') || {}).args?.[0]
  const { main, embeds } = parseSelectSpec(spec)

  const params = []
  const where = []

  for (const o of ops) {
    if (o.op === 'eq') {
      assertIdent(o.args[0])
      params.push(o.args[1])
      where.push(`${o.args[0]} = $${params.length}`)
    } else if (o.op === 'in') {
      assertIdent(o.args[0])
      const arr = Array.isArray(o.args[1]) ? o.args[1] : [o.args[1]]
      if (!arr.length) { where.push('1 = 0'); continue }
      params.push(arr)
      where.push(`${o.args[0]} = ANY($${params.length})`)
    }
  }

  // Server-side authorization for reads is permissive (public marketplace),
  // but conversation/message reads are restricted to participants.
  if (table === 'conversations') {
    if (!user) {
      where.push('1 = 0')
    } else {
      params.push(user.id, user.id)
      where.push(`(buyer_id = $${params.length - 1} OR store_id IN (SELECT id FROM stores WHERE owner_id = $${params.length}))`)
    }
  } else if (table === 'messages') {
    if (!user) {
      where.push('1 = 0') // not signed in → no messages
    } else {
      params.push(user.id, user.id)
      where.push(`conversation_id IN (SELECT id FROM conversations WHERE buyer_id = $${params.length - 1} OR store_id IN (SELECT id FROM stores WHERE owner_id = $${params.length}))`)
    }
  } else if (table === 'profiles') {
    // Mirrors the Supabase RLS policy `profiles_select_auth` this app used
    // before the migration: profiles carry phone numbers, so anonymous
    // visitors get nothing. Signed-in users still read all profiles (chat
    // needs the buyer's name; the live map labels dots with them).
    if (!user) where.push('1 = 0')
  }

  // ORDER BY
  let orderSql = ''
  const order = ops.find((o) => o.op === 'order')
  if (order) {
    assertIdent(order.args[0])
    const dir = order.args[1]?.ascending === false ? 'DESC' : 'ASC'
    orderSql = ` ORDER BY "${order.args[0]}" ${dir}`
  }

  let limitSql = ''
  const limit = ops.find((o) => o.op === 'limit')
  if (limit) limitSql = ` LIMIT ${Math.max(0, Number(limit.args[0]) || 0)}`

  // Build SELECT list + joins
  const cols = []
  const joins = []
  for (const em of embeds) {
    const emTable = em.table
    if (emTable !== 'stores' && emTable !== 'profiles') continue // only known FK tables supported
    const fk = fkColumnFor(emTable, table, em.fkColumn)
    assertIdent(em.alias)
    assertIdent(fk)
    joins.push(`LEFT JOIN ${emTable} ${em.alias} ON ${table}.${fk} = ${em.alias}.id`)
    for (const c of em.cols) {
      assertIdent(c)
      cols.push(`${em.alias}.${c} AS "${em.alias}.${c}"`)
    }
  }
  const selectList = main.includes('*') && !cols.length
    ? `${table}.*`
    : [`${table}.*`].concat(cols).join(', ')

  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  // Note the space before the joins — `FROM ${table}` and `LEFT JOIN …` must be
  // separated (`FROM conversationsLEFT JOIN` would be a syntax error).
  const joinSql = joins.length ? ` ${joins.join(' ')}` : ''
  const sql = `SELECT ${selectList} FROM ${table}${joinSql}${whereSql}${orderSql}${limitSql}`
  return { sql, params }
}

function reshapeRows(rows, embeds) {
  if (!embeds.length) return rows
  return rows.map((row) => {
    const out = {}
    const seen = new Set()
    for (const [k, v] of Object.entries(row)) {
      const i = k.indexOf('.')
      if (i > 0 && embeds.some((e) => e.alias === k.slice(0, i))) {
        const [alias, col] = [k.slice(0, i), k.slice(i + 1)]
        if (!out[alias]) out[alias] = {}
        out[alias][col] = v
        seen.add(alias)
      } else {
        out[k] = v
      }
    }
    for (const em of embeds) if (!seen.has(em.alias)) out[em.alias] = null
    return out
  })
}

// ── Authorization for writes ───────────────────────────────────
function pluckPayload(op, cols) {
  const src = op.args[0] && typeof op.args[0] === 'object' ? op.args[0] : {}
  const out = {}
  for (const c of Object.keys(src)) {
    if (cols.includes(c)) out[c] = src[c]
  }
  return out
}

// JSONB columns must be sent to Postgres as JSON text. node-postgres
// serializes a JS array as a Postgres ARRAY literal (`{a,b}`), which a
// jsonb column rejects (`column "images" is of type jsonb but expression
// is of type text[]`). That error was masked as generic "Query failed."
// and broke every product insert (images is always present, even as []).
const JSONB_COLUMNS = new Set(['images'])

function toDbValue(col, val) {
  if (JSONB_COLUMNS.has(col)) {
    if (val == null) return JSON.stringify([])
    if (typeof val === 'string') {
      // Already JSON? Keep it; otherwise wrap a single URL.
      const t = val.trim()
      if (t === '' || t === 'null') return JSON.stringify([])
      if (t.startsWith('[') || t.startsWith('{')) return t
      return JSON.stringify([val])
    }
    try {
      return JSON.stringify(val ?? [])
    } catch {
      return JSON.stringify([])
    }
  }
  // Empty-string numbers from form inputs must become NULL, otherwise
  // Postgres throws `invalid input syntax for type numeric`.
  if ((col === 'price' || col === 'old_price' || col === 'stock') && val === '') return null
  return val
}

function normalizeForDb(payload) {
  const out = { ...payload }
  for (const col of Object.keys(out)) {
    if (JSONB_COLUMNS.has(col) || col === 'price' || col === 'old_price' || col === 'stock') {
      out[col] = toDbValue(col, out[col])
    }
  }
  return out
}

async function authzInsert(table, payload, user) {
  if (!INSERT_COLUMNS[table]) throw new Error(`Insert into ${table} is not allowed.`)

  if (table === 'stores') {
    if (!user) throw new Error('You must be signed in to create a store.')
    return { ...pluckPayload({ args: [payload] }, INSERT_COLUMNS.stores), owner_id: user.id }
  }
  if (table === 'products') {
    if (!user) throw new Error('You must be signed in to add products.')
    if (!payload.store_id) throw new Error('A store is required.')
    const { rows } = await query('SELECT 1 FROM stores WHERE id = $1 AND owner_id = $2', [payload.store_id, user.id])
    if (!rows.length) throw new Error('Store not found or not yours.')
    return pluckPayload({ args: [payload] }, INSERT_COLUMNS.products)
  }
  if (table === 'reviews') {
    const p = pluckPayload({ args: [payload] }, INSERT_COLUMNS.reviews)
    if (p.author_id && (!user || p.author_id !== user.id)) throw new Error('Review author mismatch.')
    return p
  }
  if (table === 'conversations') {
    if (!user) throw new Error('You must be signed in to start a conversation.')
    return { store_id: payload.store_id, buyer_id: user.id }
  }
  if (table === 'messages') {
    if (!user) throw new Error('You must be signed in to send a message.')
    const { rows } = await query(
      'SELECT 1 FROM conversations WHERE id = $1 AND (buyer_id = $2 OR store_id IN (SELECT id FROM stores WHERE owner_id = $2))',
      [payload.conversation_id, user.id]
    )
    if (!rows.length) throw new Error('Conversation not found or not yours.')
    return { ...pluckPayload({ args: [payload] }, INSERT_COLUMNS.messages), sender_id: user.id }
  }
  if (table === 'landmarks') {
    const p = pluckPayload({ args: [payload] }, INSERT_COLUMNS.landmarks)
    if (p.created_by && (!user || p.created_by !== user.id)) throw new Error('Landmark author mismatch.')
    return p
  }
  if (table === 'user_locations') {
    if (!user) throw new Error('You must be signed in to share your location.')
    return { ...pluckPayload({ args: [payload] }, INSERT_COLUMNS.user_locations), user_id: user.id }
  }
  if (table === 'location_trails') {
    if (!user) throw new Error('You must be signed in to share your location.')
    return { ...pluckPayload({ args: [payload] }, INSERT_COLUMNS.location_trails), user_id: user.id }
  }
  throw new Error(`Insert into ${table} is not allowed.`)
}

// NOTE: must stay synchronous. Its return value is interpolated straight into
// the WHERE clause, so an `async` signature would splice "[object Promise]"
// into the SQL and every UPDATE/DELETE would fail with a syntax error.
function ownerConstraint(table, user, params, where) {
  // Returns an extra WHERE clause + declares ownership for update/delete.
  if (table === 'stores') {
    if (!user) throw new Error('You must be signed in.')
    params.push(user.id)
    return `owner_id = $${params.length}`
  }
  if (table === 'products') {
    if (!user) throw new Error('You must be signed in.')
    params.push(user.id)
    return `store_id IN (SELECT id FROM stores WHERE owner_id = $${params.length})`
  }
  if (table === 'reviews') {
    if (!user) throw new Error('You must be signed in to delete a review.')
    params.push(user.id)
    return `author_id = $${params.length}`
  }
  if (table === 'user_locations') {
    if (!user) throw new Error('You must be signed in.')
    params.push(user.id)
    return `user_id = $${params.length}`
  }
  if (table === 'profiles') {
    if (!user) throw new Error('You must be signed in.')
    params.push(user.id)
    return `id = $${params.length}`
  }
  throw new Error(`Update/delete on ${table} is not allowed.`)
}

// ── Main handler ───────────────────────────────────────────────
export async function POST(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return fail('Invalid request body.', 400)
  }

  const table = body?.table
  const ops = Array.isArray(body?.ops) ? body.ops : []
  if (!table || !READ_TABLES.has(table)) {
    return fail('Unknown table.', 404)
  }

  const token = readTokenFromHeaders(request.headers)
  let user = null
  try {
    user = await getUserFromToken(token)
  } catch (err) {
    console.error('[query] session check failed:', err.message)
  }

  try {
    const insert = ops.find((o) => o.op === 'insert')
    const update = ops.find((o) => o.op === 'update')
    const del = ops.find((o) => o.op === 'delete')
    const upsert = ops.find((o) => o.op === 'upsert')

    if (insert) {
      const raw = await authzInsert(table, insert.args[0], user)
      const payload = normalizeForDb(raw)
      const cols = Object.keys(payload)
      if (!cols.length) return fail('Nothing to insert.')
      const values = cols.map((c) => payload[c])
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`
      const { rows } = await query(sql, values)

      const terminal = ops.find((o) => o.op === 'single' || o.op === 'maybeSingle')
      if (terminal) return ok(rows[0] || null)
      return ok(rows)
    }

    if (upsert) {
      if (!user) return fail('You must be signed in.', 401)
      const conflictCol = upsert.args[1]?.onConflict || 'id'
      assertIdent(conflictCol)
      const raw = await authzInsert(table, upsert.args[0], user)
      const payload = normalizeForDb(raw)
      const cols = Object.keys(payload)
      const values = cols.map((c) => payload[c])
      const setSql = cols.map((c, i) => `${c} = $${i + 1}`).join(', ')
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
        ON CONFLICT (${conflictCol}) DO UPDATE SET ${setSql} RETURNING *`
      const { rows } = await query(sql, values)
      return ok(rows[0] || rows)
    }

    if (update) {
      const rawPayload = pluckPayload(update, UPDATE_COLUMNS[table] || [])
      const payload = normalizeForDb(rawPayload)
      const cols = Object.keys(payload).filter((c) => c !== 'id' && c !== 'created_at' && c !== 'rating' && c !== 'review_count' && c !== 'owner_id' && c !== 'store_id')
      if (!cols.length) return ok(null)

      const params = cols.map((c) => payload[c])
      const constraints = [ownerConstraint(table, user, params)]
      for (const o of ops) {
        if (o.op === 'eq') {
          assertIdent(o.args[0])
          params.push(o.args[1])
          constraints.push(`${o.args[0]} = $${params.length}`)
        } else if (o.op === 'in') {
          assertIdent(o.args[0])
          const arr = Array.isArray(o.args[1]) ? o.args[1] : [o.args[1]]
          params.push(arr)
          constraints.push(`${o.args[0]} = ANY($${params.length})`)
        }
      }
      const setSql = cols.map((c, i) => `${c} = $${i + 1}`).join(', ')
      const sql = `UPDATE ${table} SET ${setSql} WHERE ${constraints.join(' AND ')}`
      await query(sql, params)
      return ok(null)
    }

    if (del) {
      const params = []
      const constraints = [ownerConstraint(table, user, params)]
      for (const o of ops) {
        if (o.op === 'eq') {
          assertIdent(o.args[0])
          params.push(o.args[1])
          constraints.push(`${o.args[0]} = $${params.length}`)
        } else if (o.op === 'in') {
          assertIdent(o.args[0])
          const arr = Array.isArray(o.args[1]) ? o.args[1] : [o.args[1]]
          params.push(arr)
          constraints.push(`${o.args[0]} = ANY($${params.length})`)
        }
      }
      const sql = `DELETE FROM ${table} WHERE ${constraints.join(' AND ')}`
      await query(sql, params)
      return ok(null)
    }

    // Plain SELECT
    const { sql, params } = await buildSelectSQL(table, ops, user)
    const { rows } = await query(sql, params)
    const embeds = parseSelectSpec((ops.find((o) => o.op === 'select') || {}).args?.[0]).embeds
    const data = reshapeRows(rows, embeds)

    const terminal = ops.find((o) => o.op === 'single' || o.op === 'maybeSingle')
    if (terminal) return ok(data[0] || null)
    return ok(data)
  } catch (err) {
    // Log the real SQL error server-side, but don't leak internals.
    // Known constraint violations get a human message so "Add item"
    // doesn't die with a bare "Query failed."
    console.error(`[query] ${table} failed:`, err.message)
    const msg = String(err.message || '')
    if (/invalid input syntax for (type )?(numeric|integer)/i.test(msg)) {
      return fail('Price / stock must be numbers (blank stock = plenty).', 400)
    }
    if (/violates (check|not-null|foreign key|unique)/i.test(msg)) {
      return fail('That product data was rejected by the database. Check price, stock and store.', 400)
    }
    if (/query|column|syntax/i.test(msg)) {
      return fail('Query failed. Please retry — if it persists, check your product photo, price and stock.', 400)
    }
    return fail(msg || 'Request failed.', 403)
  }
}