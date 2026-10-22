// Kejetia Online — data client.
//
// Two modes, same fluent surface (`from().select().eq()...`, `auth.*`,
// `channel().on('postgres_changes'...).subscribe()`, `storage.from()`):
//
//   • Mock mode (default):  browser-only data in localStorage, BroadcastChannel
//     realtime. Set NEXT_PUBLIC_DB_MODE=postgres (+ DATABASE_URL on the server)
//     to leave it. Everything still works offline — great for local dev.
//
//   • Postgres mode:  every call is proxied to our own Next.js API routes
//     (/api/query, /api/auth/*, /api/events, /api/media/*) which execute the
//     SQL against Render Postgres and enforce authorization server-side.
//
// The app never talks to Supabase anymore.

const STORAGE_NS = 'kejetia_v2_'

// ───────────────────────────────────────────────────────────────────────────
// Mock realtime layer (browser-only, BroadcastChannel + storage events)
// ───────────────────────────────────────────────────────────────────────────
const MOCK_REALTIME_CHANNEL = 'kejetia-mock-realtime'
const RECENT_WINDOW_MS = 1500

const realtimeHandlers = new Map()
const realtimeRegistrations = new Map()
const recentDeliveries = new Map()
const knownIds = new Map()

function matchesMockFilter(row, filter) {
  if (!filter) return true
  const match = String(filter).match(/([A-Za-z_][A-Za-z0-9_]*)=eq\.(.+)/)
  if (!match) return true
  const want = decodeURIComponent(match[2].trim())
  return String(row?.[match[1]]) === want
}

function mockRealTime() {
  const add = (channel, table, event, handler, filter) => {
    const list = realtimeHandlers.get(table) || []
    list.push({ event: event || '*', handler })
    realtimeHandlers.set(table, list)

    const regs = realtimeRegistrations.get(channel) || []
    regs.push({ table, event: event || '*', handler, filter })
    realtimeRegistrations.set(channel, regs)
  }

  const removeChannel = (channel) => {
    if (!channel) return
    for (const reg of realtimeRegistrations.get(channel) || []) {
      const list = (realtimeHandlers.get(reg.table) || []).filter((h) => h !== reg)
      if (list.length) realtimeHandlers.set(reg.table, list)
      else realtimeHandlers.delete(reg.table)
    }
    realtimeRegistrations.delete(channel)
  }

  const deliver = (event, table, row) => {
    if (!row || row.id == null) return
    const key = `${table}:${event}:${row.id}`
    const now = Date.now()
    const last = recentDeliveries.get(key)
    if (last && now - last < RECENT_WINDOW_MS) return
    recentDeliveries.set(key, now)
    if (recentDeliveries.size > 500) {
      for (const [k, ts] of recentDeliveries) {
        if (now - ts > RECENT_WINDOW_MS) recentDeliveries.delete(k)
      }
    }

    for (const reg of realtimeHandlers.get(table) || []) {
      if (reg.event !== event && reg.event !== '*') continue
      try {
        reg.handler({ table, schema: 'public', event, new: row })
      } catch (err) {
        console.warn('Realtime handler threw:', err)
      }
    }
  }

  return { add, removeChannel, deliver }
}

const realtime = mockRealTime()

function publishChange(event, table, row) {
  if (typeof window === 'undefined') return
  try {
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel(MOCK_REALTIME_CHANNEL)
      bc.postMessage({ kind: 'change', event, table, row })
      bc.close()
    }
  } catch (err) {
    console.warn('Mock realtime broadcast failed:', err)
  }
  realtime.deliver(event, table, row)
}

function syncFromStorage(table) {
  const raw = safeReadJson(`${STORAGE_NS}${table}`, [])
  const rows = Array.isArray(raw) ? raw : []
  const seen = knownIds.get(table) || new Set()
  let changed = false
  for (const row of rows) {
    if (row && row.id && !seen.has(row.id)) {
      seen.add(row.id)
      changed = true
      realtime.deliver('INSERT', table, row)
    }
  }
  if (changed) knownIds.set(table, seen)
}

function wireMockRealtime() {
  if (typeof window === 'undefined') return

  try {
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel(MOCK_REALTIME_CHANNEL)
      bc.onmessage = (event) => {
        const msg = event?.data
        if (msg && typeof msg === 'object' && msg.kind === 'change') {
          realtime.deliver(msg.event, msg.table, msg.row)
        }
      }
    }
  } catch (err) {
    console.warn('Could not open mock realtime channel:', err)
  }

  try {
    window.addEventListener('storage', (event) => {
      if (!event.key || !event.key.startsWith(STORAGE_NS)) return
      const table = event.key.slice(STORAGE_NS.length)
      if (table) syncFromStorage(table)
    })
  } catch (err) {
    console.warn('Could not wire mock realtime storage listener:', err)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Postgres realtime (HTTP polling of /api/events — replaces Supabase Realtime)
// ───────────────────────────────────────────────────────────────────────────
const remotePollers = new Map() // channel -> interval id

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    if (typeof FileReader === 'undefined') return resolve(null)
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

function startRemotePoller(channel, intervalMs = 2000) {
  if (remotePollers.has(channel)) return
  let since = new Date().toISOString()

  const tick = async () => {
    const regs = realtimeRegistrations.get(channel) || []
    if (!regs.length) {
      stopRemotePoller(channel)
      return
    }
    const channels = regs.map((r) => ({ table: r.table, event: r.event, filter: r.filter }))
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels, since }),
      })
      const body = await res.json()
      if (body?.events) {
        for (const ev of body.events) {
          realtime.deliver(ev.event, ev.table, ev.new)
        }
      }
      if (body?.now) since = body.now
    } catch (err) {
      // transient network error — try again next tick
    }
  }

  const id = setInterval(tick, intervalMs)
  remotePollers.set(channel, id)
}

function stopRemotePoller(channel) {
  const id = remotePollers.get(channel)
  if (id) clearInterval(id)
  remotePollers.delete(channel)
}

// ───────────────────────────────────────────────────────────────────────────
// Mock mode storage + safe JSON helpers
// ───────────────────────────────────────────────────────────────────────────
function getLocalStorage() {
  if (typeof window === 'undefined') return null
  return window.localStorage
}

function safeReadJson(key, fallback = []) {
  if (typeof window === 'undefined') return fallback
  try {
    const value = window.localStorage.getItem(key)
    if (value == null || value === '') return fallback
    const parsed = JSON.parse(value)
    return parsed
  } catch (error) {
    console.warn(`Unable to read local storage key ${key}:`, error)
    return fallback
  }
}

function safeWriteJson(key, value) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn(`Unable to write local storage key ${key}:`, error)
  }
}

function cloneTable(tableName) {
  const data = safeReadJson(`${STORAGE_NS}${tableName}`, [])
  return Array.isArray(data) ? data : []
}

function saveTable(tableName, rows) {
  safeWriteJson(`${STORAGE_NS}${tableName}`, rows)
}

function toSafePublicUser(user) {
  if (!user) return null
  return {
    id: user.id,
    email: user.email,
    app_metadata: { provider: 'mock' },
    user_metadata: {
      full_name: user.full_name,
      phone: user.phone,
      role: user.role,
    },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Mock mode: fluent query builder over localStorage
// ───────────────────────────────────────────────────────────────────────────
// Embed support for specs like '*, stores(name, phone), buyer:profiles!buyer_id(full_name)'.
// Columns aren't projected in mock mode (rows are already local, and a full
// row is a superset of any column list) — only the joined row is resolved,
// so dev-mode UIs that render `conv.stores?.name` work like they do in real mode.
function parseMockEmbeds(spec) {
  if (!spec || typeof spec !== 'string' || spec === '*') return []
  const embeds = []
  const re = /(?:([A-Za-z_][A-Za-z0-9_]*):)?([A-Za-z_][A-Za-z0-9_]*)!?([A-Za-z_][A-Za-z0-9_]*)?\(([^()]*)\)/g
  let m
  while ((m = re.exec(spec))) {
    const table = m[2]
    const alias = m[1] || table
    const fkColumn = m[3] || (table.endsWith('s') ? `${table.slice(0, -1)}_id` : `${table}_id`)
    embeds.push({ alias, table, fkColumn })
  }
  return embeds
}

function createMockQuery(tableName, initialRows = []) {
  let rows = Array.isArray(initialRows) ? [...initialRows] : []
  let filterFns = []
  let orderBy = null
  let limitCount = null
  let pendingOp = null // { type: 'update'|'delete', payload? }
  let selectSpec = '*'

  const applyPendingOp = () => {
    if (!pendingOp) return
    if (pendingOp.type === 'delete') {
      const removed = rows.filter((row) => filterFns.some((fn) => fn(row)))
      rows = rows.filter((row) => !filterFns.some((fn) => fn(row)))
      saveTable(tableName, rows)
      for (const row of removed) publishChange('DELETE', tableName, row)
    } else {
      const changed = []
      rows = rows.map((row) => {
        if (filterFns.some((fn) => fn(row))) {
          const updated = { ...row, ...pendingOp.payload, updated_at: new Date().toISOString() }
          changed.push(updated)
          return updated
        }
        return row
      })
      saveTable(tableName, rows)
      for (const row of changed) publishChange('UPDATE', tableName, row)
    }
    pendingOp = null
  }

  const run = () => {
    applyPendingOp()
    let result = [...rows]
    for (const fn of filterFns) result = result.filter(fn)
    if (orderBy) {
      const { field, ascending } = orderBy
      result = [...result].sort((a, b) => {
        const aValue = a[field]
        const bValue = b[field]
        if (aValue == null && bValue == null) return 0
        if (aValue == null) return 1
        if (bValue == null) return -1
        if (aValue < bValue) return ascending ? -1 : 1
        if (aValue > bValue) return ascending ? 1 : -1
        return 0
      })
    }
    if (limitCount != null) result = result.slice(0, limitCount)

    const embeds = parseMockEmbeds(selectSpec)
    if (embeds.length) {
      const cache = new Map()
      result = result.map((row) => {
        const out = { ...row }
        for (const em of embeds) {
          if (!cache.has(em.table)) cache.set(em.table, cloneTable(em.table))
          const fk = row?.[em.fkColumn]
          out[em.alias] = fk == null ? null : cache.get(em.table).find((r) => r?.id === fk) || null
        }
        return out
      })
    }
    return { data: result }
  }

  const query = {
    select(spec) { if (typeof spec === 'string') selectSpec = spec; return query },
    eq(field, value) { filterFns.push((row) => row[field] === value); return query },
    in(field, values) {
      const list = Array.isArray(values) ? values : [values]
      filterFns.push((row) => list.includes(row[field]))
      return query
    },
    order(field, options = {}) {
      orderBy = { field, ascending: options.ascending !== false }
      return query
    },
    limit(count) { limitCount = Number(count); return query },
    single: async () => ({ data: run().data[0] || null }),
    maybeSingle: async () => ({ data: run().data[0] || null }),
    insert(payload) {
      const nextRows = [...rows]
      const newRow = {
        id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...payload,
      }
      nextRows.push(newRow)
      saveTable(tableName, nextRows)
      publishChange('INSERT', tableName, newRow)
      return createMockQuery(tableName, nextRows).select().eq('id', newRow.id)
    },
    update(payload) { pendingOp = { type: 'update', payload }; return query },
    delete() { pendingOp = { type: 'delete' }; return query },
    then(resolve, reject) { Promise.resolve(run()).then(resolve, reject) },
    // Make the builder a full thenable — callers (and our own hooks) chain
    // `.catch()` directly on it, which would otherwise throw
    // "…catch is not a function" because only `then` was implemented.
    // Run lazily inside the chain so a synchronous throw becomes a rejection.
    catch(reject) { return Promise.resolve().then(run).catch(reject) },
  }

  return query
}

// ───────────────────────────────────────────────────────────────────────────
// Postgres mode: fluent query builder → POST /api/query
// ───────────────────────────────────────────────────────────────────────────
function createRemoteQuery(tableName) {
  const ops = []

  const exec = async () => {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ table: tableName, ops }),
    })
    let body
    try {
      body = await res.json()
    } catch {
      body = { data: null, error: { message: 'Could not read server response.' } }
    }
    return body
  }

  const query = {
    select(spec) {
      // Record the spec so the server can project columns and resolve
      // embedded resources (e.g. '*, stores(name, phone)').
      ops.push({ op: 'select', args: [spec] })
      return query
    },
    eq(field, value) { ops.push({ op: 'eq', args: [field, value] }); return query },
    in(field, values) { ops.push({ op: 'in', args: [field, values] }); return query },
    order(field, options = {}) { ops.push({ op: 'order', args: [field, options] }); return query },
    limit(count) { ops.push({ op: 'limit', args: [count] }); return query },
    single() { ops.push({ op: 'single' }); return exec() },
    maybeSingle() { ops.push({ op: 'maybeSingle' }); return exec() },
    insert(payload) { ops.push({ op: 'insert', args: [payload] }); return query },
    upsert(payload, options = {}) { ops.push({ op: 'upsert', args: [payload, options] }); return query },
    update(payload) { ops.push({ op: 'update', args: [payload] }); return query },
    delete() { ops.push({ op: 'delete', args: [] }); return query },
    then(resolve, reject) { exec().then(resolve, reject) },
    // Same as the mock builder: callers chain `.catch()` straight onto the
    // builder, so it must exist or the call site throws a TypeError.
    catch(reject) { return exec().catch(reject) },
  }

  return query
}

// ───────────────────────────────────────────────────────────────────────────
// Mode detection
// ───────────────────────────────────────────────────────────────────────────
export function inMockMode() {
  const mode = process.env.NEXT_PUBLIC_DB_MODE
  return !mode || mode !== 'postgres'
}

// ───────────────────────────────────────────────────────────────────────────
// Mock client (auth + storage + channels)
// ───────────────────────────────────────────────────────────────────────────
function readMockUsers() {
  return safeReadJson(`${STORAGE_NS}mock_users`, [])
}

function writeMockUsers(users) {
  safeWriteJson(`${STORAGE_NS}mock_users`, users)
}

function readCurrentUser() {
  return safeReadJson(`${STORAGE_NS}mock_current_user`, null)
}

function writeCurrentUser(user) {
  safeWriteJson(`${STORAGE_NS}mock_current_user`, user)
}

function clearCurrentUser() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(`${STORAGE_NS}mock_current_user`)
}

function createMockClient() {
  const authListeners = new Set()

  const emitAuth = (event, sessionUser) => {
    authListeners.forEach((callback) => {
      try {
        if (event === 'SIGNED_IN') callback(event, { user: toSafePublicUser(sessionUser) })
        else callback(event, null)
      } catch (err) {
        console.warn('Mock auth listener threw:', err)
      }
    })
  }

  const notifySignedIn = (user) => emitAuth('SIGNED_IN', user)
  const notifySignedOut = () => emitAuth('SIGNED_OUT', null)

  return {
    auth: {
      async signUp({ email, password, options = {} }) {
        const users = readMockUsers()
        const existingUser = users.find((u) => u.email.toLowerCase() === String(email).toLowerCase())
        if (existingUser) {
          return { data: { user: toSafePublicUser(existingUser), session: { user: toSafePublicUser(existingUser) } }, error: null }
        }
        const newUser = {
          id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          email: String(email).toLowerCase(),
          password: String(password),
          full_name: options?.data?.full_name || '',
          phone: options?.data?.phone || '',
          role: options?.data?.role || 'buyer',
        }
        users.push(newUser)
        writeMockUsers(users)
        writeCurrentUser(newUser)
        const profiles = cloneTable('profiles')
        if (!profiles.some((p) => p.id === newUser.id)) {
          profiles.push({
            id: newUser.id,
            full_name: newUser.full_name,
            phone: newUser.phone,
            role: newUser.role,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          saveTable('profiles', profiles)
        }
        queueMicrotask(() => notifySignedIn(newUser))
        return { data: { user: toSafePublicUser(newUser), session: { user: toSafePublicUser(newUser) } }, error: null }
      },

      async signInWithPassword({ email, password }) {
        const users = readMockUsers()
        const match = users.find(
          (u) => u.email.toLowerCase() === String(email).toLowerCase() && u.password === String(password)
        )
        if (!match) {
          return { data: { user: null, session: null }, error: { message: 'Invalid email or password' } }
        }
        writeCurrentUser(match)
        queueMicrotask(() => notifySignedIn(match))
        return { data: { user: toSafePublicUser(match), session: { user: toSafePublicUser(match) } }, error: null }
      },

      async getSession() {
        const user = readCurrentUser()
        return { data: { session: user ? { user: toSafePublicUser(user) } : null } }
      },

      onAuthStateChange(callback) {
        const user = readCurrentUser()
        if (user) queueMicrotask(() => callback('SIGNED_IN', { user: toSafePublicUser(user) }))
        else queueMicrotask(() => callback('SIGNED_OUT', null))
        authListeners.add(callback)
        return { data: { subscription: { unsubscribe: () => authListeners.delete(callback) } } }
      },

      async signOut() {
        clearCurrentUser()
        queueMicrotask(() => notifySignedOut())
        return { error: null }
      },
    },

    from(table) {
      const rows = cloneTable(table)
      knownIds.set(table, new Set(rows.map((r) => r && r.id).filter(Boolean)))
      return createMockQuery(table, rows)
    },

    channel() {
      const channel = {
        on(event, config, callback) {
          if (event === 'postgres_changes' && config?.table) {
            realtime.add(channel, config.table, config.event, (payload) => {
              if (matchesMockFilter(payload.new || {}, config.filter)) callback(payload)
            }, config.filter)
          }
          return channel
        },
        subscribe() { return channel },
        unsubscribe() { realtime.removeChannel(channel); return channel },
      }
      return channel
    },

    removeChannel(channel) {
      realtime.removeChannel(channel)
    },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Postgres client (auth via API + storage via API + polling realtime)
// ───────────────────────────────────────────────────────────────────────────
function createRemoteClient() {
  const authListeners = new Set()
  let initialEmitted = false

  const emitAuth = (event, sessionUser) => {
    authListeners.forEach((callback) => {
      try {
        if (event === 'SIGNED_IN') callback(event, { user: sessionUser })
        else callback(event, null)
      } catch (err) {
        console.warn('Postgres auth listener threw:', err)
      }
    })
  }

  const post = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    })
    const json = await res.json().catch(() => ({ error: { message: 'Server error.' } }))
    return json
  }

  const authApi = {
    async signUp(payload) {
      const result = await post('/api/auth/signup', payload)
      const user = result?.data?.session?.user
      if (user) emitAuth('SIGNED_IN', user)
      return result
    },
    async signInWithPassword(payload) {
      const result = await post('/api/auth/signin', payload)
      const user = result?.data?.session?.user
      if (user) emitAuth('SIGNED_IN', user)
      return result
    },
    async getSession() {
      const res = await fetch('/api/auth/session', { credentials: 'same-origin' })
      const body = await res.json().catch(() => ({ data: { session: null } }))
      return body
    },
    onAuthStateChange(callback) {
      if (!initialEmitted) {
        initialEmitted = true
        this.getSession().then(({ data }) => {
          const session = data?.session
          if (session?.user) callback('SIGNED_IN', { user: session.user })
          else callback('SIGNED_OUT', null)
        }).catch(() => callback('SIGNED_OUT', null))
      }
      authListeners.add(callback)
      return { data: { subscription: { unsubscribe: () => authListeners.delete(callback) } } }
    },
    async signOut() {
      await post('/api/auth/signout', {})
      emitAuth('SIGNED_OUT', null)
      return { error: null }
    },
  }

  return {
    auth: authApi,

    from(table) {
      return createRemoteQuery(table)
    },

    channel() {
      const channel = {
        on(event, config, callback) {
          if (event === 'postgres_changes' && config?.table) {
            realtime.add(channel, config.table, config.event, (payload) => {
              if (matchesMockFilter(payload.new || {}, config.filter)) callback(payload)
            }, config.filter)
          }
          return channel
        },
        subscribe() {
          startRemotePoller(channel)
          return channel
        },
        unsubscribe() {
          stopRemotePoller(channel)
          realtime.removeChannel(channel)
          return channel
        },
      }
      return channel
    },

    removeChannel(channel) {
      stopRemotePoller(channel)
      realtime.removeChannel(channel)
    },

    storage: {
      from(bucket) {
        return {
          async upload(key, blob, { contentType = 'image/jpeg' } = {}) {
            const data = await blobToDataUrl(blob)
            if (!data) return { error: { message: 'Could not read image.' } }
            const result = await post('/api/media/upload', { bucket, key, contentType, data })
            return result
          },
          getPublicUrl(key) {
            const slug = String(key).split('/').map(encodeURIComponent).join('/')
            return { data: { publicUrl: `/api/media/${encodeURIComponent(bucket)}/${slug}` } }
          },
        }
      },
    },
  }
}

// ───────────────────────────────────────────────────────────────────────────
let client = null

export function getSupabase() {
  if (client) return client

  if (inMockMode()) {
    if (typeof window !== 'undefined') {
      console.warn('Database not configured — using local mock mode for development')
    }
    wireMockRealtime()
    client = createMockClient()
    return client
  }

  client = createRemoteClient()
  return client
}