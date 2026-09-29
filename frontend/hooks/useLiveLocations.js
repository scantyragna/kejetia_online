// Live location tracker for the Kejetia map — rebuilt for the user-drawn map.
//
// Bare-map model: no static pins ship with the app. Shoppers ARE the survey
// team — their dots + breadcrumb trails sketch walkways, and photo landmarks
// pin store fronts for everyone else.
//
//   READ  – `user_locations` (current dots, 10-min freshness) + recent
//           `location_trails` (breadcrumbs, 24h window) are fetched, then
//           re-fetched on any Realtime change plus a periodic safety refetch.
//   WRITE – signed-in + geolocation-granted users upsert `user_locations` on
//           a ~60s heartbeat AND append a `location_trails` crumb when they
//           actually move (>15 m and >15 s since the last crumb). Anonymous
//           visitors never publish — read-only.
//   EXPIRE– dots retire after 10 min of silence; crumbs retire after 24 h.
//
// Mode differences:
//   * Real mode: Postgres triggers keep `updated_at` fresh; trails are plain
//     inserts into `location_trails` (indexed by user + time).
//   * Mock mode: same tables in localStorage + BroadcastChannel — two tabs
//     see each other's dots and trails like Realtime.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getSupabase } from '@/lib/supabase'
import { useAuth } from '@/context/auth-context'
import { metersBetween } from '@/lib/kejetia-graph'

const STALE_MS = 10 * 60 * 1000 // drop dots older than this from the view
const PUBLISH_INTERVAL_MS = 60 * 1000 // heartbeat — one write per minute max
const SAFETY_REFRESH_MS = 60 * 1000 // periodic full refresh even without events
const TRAIL_WINDOW_MS = 24 * 60 * 60 * 1000 // crumbs stay on the map for a day
const TRAIL_PUBLISH_MS = 15 * 1000 // fastest crumb rate while walking
const TRAIL_MIN_MOVE_M = 15 // ignore GPS jitter below this
// Fixes rougher than this are not published: putting an IP-based fallback
// location (GPS off) on the shared map would scatter wrong dots everywhere.
const ACCURACY_GATE_M = 2000

// Best-effort timestamp for a row (mock rows carry updated_at; real rows do
// too after the migration). Returns 0 when unknown → treat as "keep forever".
function rowTime(row) {
  const t = new Date(row?.updated_at || row?.created_at || NaN).getTime()
  return Number.isFinite(t) ? t : 0
}

async function publishPosition(sb, userId, lat, lng) {
  const row = { user_id: userId, latitude: lat, longitude: lng }
  if (typeof sb.upsert === 'function') {
    // Real supabase-js: upsert keyed on user_id → one "last known location".
    const res = await sb.from('user_locations').upsert(row, { onConflict: 'user_id' })
    if (res?.error) throw res.error
    return
  }
  // Mock client (no upsert): update the user's existing row or insert one.
  const { data: mine } = await sb.from('user_locations').select('id').eq('user_id', userId).limit(1)
  if (mine?.length) {
    const res = await sb.from('user_locations').update({ latitude: lat, longitude: lng }).eq('id', mine[0].id)
    if (res?.error) throw res.error
  } else {
    const res = await sb.from('user_locations').insert(row)
    if (res?.error) throw res.error
  }
}

/**
 * Track everyone's dots + breadcrumb trails for the live bare map.
 *
 * @param {{ enabled?: boolean, share?: boolean }} options
 *   enabled – false keeps the map read-only and stops all fetching/subscribing
 *             (use it when the map UI is hidden, e.g. another tab is active).
 *   share   – false stops this browser from publishing the signed-in user's
 *             position (still reads everyone else's dots + trails).
 * @returns {{ locations: Array, trails: Array<{user_id,path,points}>, sharing: boolean }}
 */
export function useLiveLocations({ enabled = true, share = true } = {}) {
  const { user } = useAuth()
  const [locations, setLocations] = useState([])
  const [trails, setTrails] = useState([])
  const [sharing, setSharing] = useState(false)

  const userRef = useRef(user)
  userRef.current = user
  const mountedRef = useRef(true)
  const watcherRef = useRef(null)
  const lastPublishRef = useRef({ at: 0 })
  const lastTrailRef = useRef({ at: 0, lat: null, lng: null })
  const refreshTimerRef = useRef(null)

  // Fetch dots + profiles + recent crumbs. Trails arrive newest-first;
  // group by user and sort each path oldest→newest for polyline drawing.
  // Each fetch is isolated: a missing location_trails table (old DB before
  // migrate) must not kill the dots.
  const refresh = useCallback(async () => {
    const sb = getSupabase()
    if (!sb) return
    const [{ data: locs }, { data: profRows }, { data: crumbRows }] = await Promise.all([
      sb.from('user_locations').select('*').order('updated_at', { ascending: false }).catch(() => ({ data: [] })),
      sb.from('profiles').select('*').catch(() => ({ data: [] })),
      sb.from('location_trails').select('*').order('created_at', { ascending: false }).limit(1000).catch(() => ({ data: [] })),
    ])
    const profiles = {}
    ;(profRows || []).forEach((p) => {
      profiles[p.id] = p
    })
    const cutoff = Date.now() - STALE_MS
    const merged = (locs || [])
      .filter((r) => r && Number.isFinite(Number(r.latitude)) && Number.isFinite(Number(r.longitude)))
      .filter((r) => rowTime(r) === 0 || rowTime(r) >= cutoff)
      .map((r) => {
        const p = profiles[r.user_id] || {}
        return {
          id: r.id,
          user_id: r.user_id,
          lat: Number(r.latitude),
          lng: Number(r.longitude),
          name: p.full_name || '',
          city: p.city || '',
        }
      })
    if (mountedRef.current) setLocations(merged)

    const trailCutoff = Date.now() - TRAIL_WINDOW_MS
    const byUser = new Map()
    for (const r of crumbRows || []) {
      const lat = Number(r.latitude)
      const lng = Number(r.longitude)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
      const t = new Date(r.created_at || 0).getTime()
      if (!Number.isFinite(t) || t < trailCutoff) continue
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, [])
      const list = byUser.get(r.user_id)
      if (list.length < 200) list.push({ lat, lng, t })
    }
    const grouped = []
    for (const [user_id, pts] of byUser) {
      pts.sort((a, b) => a.t - b.t)
      if (pts.length < 2) continue // a single fix is just the dot
      grouped.push({ user_id, points: pts, path: pts.map((p) => [p.lat, p.lng]) })
    }
    if (mountedRef.current) setTrails(grouped)
  }, [])

  const publish = useCallback(async (lat, lng) => {
    const sb = getSupabase()
    const u = userRef.current
    if (!sb || !u?.id) return
    try {
      await publishPosition(sb, u.id, lat, lng)
    } catch (err) {
      console.warn('Could not publish location:', err?.message || err)
    }
  }, [])

  const publishTrail = useCallback(async (lat, lng, accuracy) => {
    const sb = getSupabase()
    const u = userRef.current
    if (!sb || !u?.id) return
    const now = Date.now()
    const last = lastTrailRef.current
    // Rate-limit + distance-gate: walking drops a crumb, standing still doesn't.
    if (now - last.at < TRAIL_PUBLISH_MS) return
    if (last.lat != null && last.lng != null) {
      try {
        if (metersBetween(last.lat, last.lng, lat, lng) < TRAIL_MIN_MOVE_M) return
      } catch { /* fall through and publish */ }
    }
    lastTrailRef.current = { at: now, lat, lng }
    try {
      const { error } = await sb.from('location_trails').insert({
        latitude: lat,
        longitude: lng,
        accuracy: Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
      })
      if (error) throw error
    } catch (err) {
      console.warn('Could not publish trail crumb:', err?.message || err)
    }
  }, [])

  const stopWatching = useCallback(() => {
    if (watcherRef.current != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watcherRef.current)
      watcherRef.current = null
    }
    lastPublishRef.current = { at: 0 }
    lastTrailRef.current = { at: 0, lat: null, lng: null }
    if (mountedRef.current) setSharing(false)
  }, [])

  const startWatching = useCallback(() => {
    const u = userRef.current
    if (!u?.id) return
    if (typeof navigator === 'undefined' || !navigator.geolocation) return
    if (watcherRef.current != null) return
    watcherRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        // Skip rough fixes (IP fallback / GPS off) — they would paint the
        // user's dot somewhere wrong on the shared market map.
        const acc = Number(pos.coords.accuracy)
        if (Number.isFinite(acc) && acc > ACCURACY_GATE_M) return
        const now = Date.now()
        const lat = pos.coords.latitude
        const lng = pos.coords.longitude
        // Breadcrumb first (movement-gated), then the 60s dot heartbeat.
        publishTrail(lat, lng, acc)
        if (now - lastPublishRef.current.at < PUBLISH_INTERVAL_MS) return
        lastPublishRef.current = { at: now }
        publish(lat, lng)
      },
      () => {
        // Permission revoked / unavailable — stop publishing quietly; the
        // freshness window retires this user's dot.
        if (mountedRef.current) setSharing(false)
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
    )
    if (mountedRef.current) setSharing(true)
  }, [publish])

  // Read path: dots + trails, live.
  useEffect(() => {
    if (!enabled) return undefined
    if (typeof window === 'undefined') return undefined
    mountedRef.current = true
    const sb = getSupabase()
    if (!sb) return undefined

    refresh()
    const channel = sb
      .channel('live-locations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_locations' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'location_trails' }, refresh)
      .subscribe()
    refreshTimerRef.current = setInterval(refresh, SAFETY_REFRESH_MS)
    return () => {
      mountedRef.current = false
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
      const s2 = getSupabase()
      if (s2) s2.removeChannel(channel)
      stopWatching()
    }
  }, [enabled, refresh, stopWatching])

  // Write path: only publish once the user has granted geolocation (e.g. via
  // the map's "Find my location" control or an earlier visit). We never fire
  // a fresh permission prompt ourselves.
  useEffect(() => {
    if (!enabled || !share) {
      stopWatching()
      return undefined
    }
    const u = userRef.current
    if (!u?.id) return undefined
    if (typeof navigator === 'undefined' || !navigator.geolocation) return undefined

    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
      startWatching()
      return undefined
    }
    let status = null
    let handler = null
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((st) => {
        if (!mountedRef.current) return
        status = st
        handler = () => {
          if (!mountedRef.current) return
          if (st.state === 'granted') startWatching()
          else stopWatching()
        }
        if (st.state === 'granted') startWatching()
        st.addEventListener?.('change', handler)
      })
      .catch(() => {
        if (mountedRef.current) startWatching()
      })
    return () => {
      if (status && handler) status.removeEventListener?.('change', handler)
      stopWatching()
    }
  }, [enabled, share, user?.id, startWatching, stopWatching])

  return { locations, trails, sharing }
}