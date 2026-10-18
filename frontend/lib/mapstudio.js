// Map Studio — shared vocabulary + helpers for the crowdsourced-mapping
// feature. Kept mode-agnostic: the same functions drive mock mode
// (localStorage) and postgres mode (API routes), because both speak the
// fluent client in lib/supabase.js.
//
// The lifecycle this file encodes:
//
//   trail_sessions:  active ──submit──► submitted ──admin──► approved | rejected
//   its landmarks/   draft  ──────────────────────────admin──► published | rejected
//   walkways:
//
import { getSupabase, inMockMode } from '@/lib/supabase'

export const SESSION_STATUS = {
  active: { label: 'Mapping now', tone: 'live' },
  submitted: { label: 'Awaiting review', tone: 'pending' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
}

export const ITEM_STATUS = {
  draft: { label: 'Draft', tone: 'live' },
  published: { label: 'Live on map', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
}

// What a contributor can say a stretch of ground IS. Colors drive both the
// studio preview and the admin review map, so a reviewer can tell a "road"
// from a "stairs" at a glance without opening every row.
export const WALKWAY_KINDS = [
  { value: 'walkway', label: 'Walkway', color: '#16a34a' },
  { value: 'road', label: 'Road / driveable', color: '#2563eb' },
  { value: 'stairs', label: 'Stairs', color: '#ea580c' },
  { value: 'entrance', label: 'Entrance / gate', color: '#9333ea' },
  { value: 'crossing', label: 'Crossing', color: '#0d9488' },
  { value: 'other', label: 'Something else', color: '#64748b' },
]

export const walkwayKind = (value) =>
  WALKWAY_KINDS.find((k) => k.value === value) || WALKWAY_KINDS[WALKWAY_KINDS.length - 1]

// Landmark types offered in the studio (beyond "just a spot").
export const LANDMARK_TYPES = [
  { value: 'landmark', label: 'Landmark / spot' },
  { value: 'gate', label: 'Gate / entrance' },
  { value: 'section', label: 'Market section' },
  { value: 'toilets', label: 'Toilets' },
  { value: 'atm', label: 'ATM / bank' },
  { value: 'food', label: 'Food court / chop bar' },
  { value: 'transport', label: 'Trotro / taxi rank' },
  { value: 'water', label: 'Water point' },
  { value: 'other', label: 'Other' },
]

export const landmarkType = (value) =>
  LANDMARK_TYPES.find((t) => t.value === value) || LANDMARK_TYPES[0]

// Geometry helpers ──────────────────────────────────────────────
// A walkway's geometry is stored as [[lat, lng], …]. These keep the shape
// consistent no matter which side of the wire produced it (mock rows carry
// plain arrays; postgres jsonb comes back as a JSON string).
export function parseGeometry(geom) {
  let g = geom
  if (typeof g === 'string') {
    try { g = JSON.parse(g) } catch { return [] }
  }
  if (!Array.isArray(g)) return []
  return g
    .filter((pt) => Array.isArray(pt) && Number.isFinite(Number(pt[0])) && Number.isFinite(Number(pt[1])))
    .map((pt) => [Number(pt[0]), Number(pt[1])])
}

// LiveMap renders paths as [{lat, lng}, …]; geometry is [[lat, lng], …].
export function geometryToPath(geom) {
  return parseGeometry(geom).map(([lat, lng]) => ({ lat, lng }))
}

export function pathToGeometry(path) {
  return (Array.isArray(path) ? path : [])
    .filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)))
    .map((p) => [Number(p.lat), Number(p.lng)])
}

// Rough length in metres, via the same Haversine the walking graph uses.
export function geometryLengthM(geom) {
  const pts = parseGeometry(geom)
  if (pts.length < 2) return 0
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    total += haversineM(pts[i - 1], pts[i])
  }
  return total
}

function haversineM([lat1, lng1], [lat2, lng2]) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Session actions ───────────────────────────────────────────────
// Both actions return { ok, error } so pages can surface failures without
// try/catch noise. The approve/reject cascade (publishing a session's
// drafts) is done by the server in postgres mode; in mock mode there is no
// server, so the client performs the identical cascade here.
export async function startSession(title) {
  const sb = getSupabase()
  if (!sb) return { ok: false, error: 'Data client unavailable.' }
  // user_id/status/started_at are set here too: postgres mode overwrites
  // them server-side (authzInsert forces the values), but mock mode has no
  // server, so the client must send the full row or the admin queue never
  // sees the session (status would be undefined).
  const me = await currentProfileId()
  const { data, error } = await sb
    .from('trail_sessions')
    .insert({
      title: String(title || '').trim() || 'Mapping session',
      user_id: me,
      status: 'active',
      started_at: new Date().toISOString(),
    })
    .select()
    .single()
  if (error) return { ok: false, error: error.message || 'Could not start the session.' }
  return { ok: true, session: data }
}

// Best-effort profile id for mock-mode rows (postgres mode sets it
// server-side from the session cookie, so a null here is harmless there).
async function currentProfileId() {
  try {
    const sb = getSupabase()
    const { data } = await sb.auth.getSession()
    return data?.session?.user?.id || null
  } catch {
    return null
  }
}

export async function submitSession(sessionId) {
  const sb = getSupabase()
  if (!sb) return { ok: false, error: 'Data client unavailable.' }
  const { error } = await sb
    .from('trail_sessions')
    .update({ status: 'submitted', ended_at: new Date().toISOString() })
    .eq('id', sessionId)
  if (error) return { ok: false, error: error.message || 'Could not submit the session.' }
  return { ok: true }
}

export async function reviewSession(sessionId, verdict) {
  // verdict: 'approved' | 'rejected' — admin only (enforced server-side).
  const sb = getSupabase()
  if (!sb) return { ok: false, error: 'Data client unavailable.' }
  const { error } = await sb.from('trail_sessions').update({ status: verdict }).eq('id', sessionId)
  if (error) return { ok: false, error: error.message || 'Could not save the verdict.' }

  if (inMockMode()) {
    // Mirror the server-side cascade for the local mock backend.
    const next = verdict === 'approved' ? 'published' : 'rejected'
    for (const table of ['landmarks', 'walkways']) {
      const { data } = await sb.from(table).select('*').eq('session_id', sessionId)
      for (const row of data || []) {
        if (row.status === 'draft') {
          await sb.from(table).update({ status: next }).eq('id', row.id)
        }
      }
    }
  }
  return { ok: true }
}

// Studio mock-mode helper: in mock mode there is no server to grant admin,
// so a developer toggles the flag on their own profile row directly. This
// is impossible in postgres mode (is_admin is not in the profiles
// UPDATE_COLUMNS allowlist) — hence the inMockMode() guard at the call site.
export async function grantMockAdmin(profileId) {
  if (!inMockMode() || !profileId) return { ok: false, error: 'Mock mode only.' }
  const sb = getSupabase()
  const { error } = await sb.from('profiles').update({ is_admin: true }).eq('id', profileId)
  if (error) return { ok: false, error: error.message || 'Could not update profile.' }
  return { ok: true }
}

// ── Mock-mode demo session ─────────────────────────────────────
// Creates a signed-in "Demo Mapper" straight in localStorage so the Studio
// can be inspected without walking through signup. MOCK ONLY: in postgres
// mode the session cookie is minted server-side from bcrypt credentials,
// so there is no client path around auth — this function refuses to run.
const DEMO_ID = 'demo-mapper-local'
const DEMO_EMAIL = 'demo.mapper@kejetia.local'

export function seedDemoMapper() {
  if (!inMockMode() || typeof window === 'undefined') return null
  const NS = 'kejetia_v2_'
  const read = (k, fb) => {
    try { const v = localStorage.getItem(NS + k); return v ? JSON.parse(v) : fb } catch { return fb }
  }
  const write = (k, v) => {
    try { localStorage.setItem(NS + k, JSON.stringify(v)) } catch { /* private mode */ }
  }

  const user = {
    id: DEMO_ID,
    email: DEMO_EMAIL,
    password: 'local-demo-only',
    full_name: 'Demo Mapper',
    phone: '',
    role: 'buyer',
  }
  const users = read('mock_users', [])
  if (!users.some((u) => u.id === DEMO_ID)) {
    users.push(user)
    write('mock_users', users)
  }
  write('mock_current_user', user)

  const profiles = read('profiles', [])
  if (!profiles.some((p) => p.id === DEMO_ID)) {
    profiles.push({
      id: DEMO_ID,
      full_name: 'Demo Mapper',
      phone: '',
      role: 'buyer',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    write('profiles', profiles)
  }
  return DEMO_ID
}

// True when the demo seed is already signed in (used for the sign-out path).
export const DEMO_MAPPER_EMAIL = DEMO_EMAIL
