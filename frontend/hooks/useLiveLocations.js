// Live location tracker for the Kejetia map — rebuilt for the user-drawn map.
//
// Bare-map model: no static pins ship with the app. Shoppers ARE the survey
// team — their dots + breadcrumb trails sketch walkways, and photo landmarks
// pin store fronts for everyone else.
//
//   READ  – `user_locations` (current dots, 10-min freshness) + recent
//           `location_trails` (breadcrumbs, 24h window) are fetched, then
//           re-fetched on any Realtime change plus a periodic safety refetch.
//           Dots whose stored `accuracy` is worse than ACCURACY_GATE_M are
//           filtered out here — a bad fix must not reach the map at all.
//   WRITE – signed-in users upsert `user_locations` on a ~60s heartbeat (or
//           as soon as they walk DOT_MOVE_M) AND append a `location_trails`
//           crumb when they actually move (>15 m and >15 s since the last
//           crumb). Anonymous visitors never publish — read-only. Only fixes
//           within ACCURACY_GATE_M are published, always with their accuracy.
//   SHARE – sharing starts from an explicit user gesture (`requestShare()`,
//           wired to the map's "Find my location" control) or as soon as
//           permission is already granted. `shareStatus`/`shareError` report
//           honestly why a dot is not appearing (denied, no GPS, too rough).
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
import { describeGeoError, GEO_MESSAGES } from '@/lib/geolocation'

const STALE_MS = 10 * 60 * 1000 // drop dots older than this from the view
const PUBLISH_INTERVAL_MS = 60 * 1000 // heartbeat — one write per minute max
const DOT_MOVE_M = 25 // walk this far → publish immediately, don't wait for the heartbeat
const DOT_MIN_GAP_MS = 10 * 1000 // …but never write more often than this while moving
const SAFETY_REFRESH_MS = 60 * 1000 // periodic full refresh even without events
const TRAIL_WINDOW_MS = 24 * 60 * 60 * 1000 // crumbs stay on the map for a day
const TRAIL_PUBLISH_MS = 15 * 1000 // fastest crumb rate while walking
const TRAIL_MIN_MOVE_M = 15 // ignore GPS jitter below this
// Fixes rougher than this are never published — and never rendered either
// (the read path filters on the same number). This map's whole area, Kejetia
// Market, is ~1.5 km across, so the old ±2000 m gate put dots in the wrong
// neighbourhood entirely: better no dot than a wrong one. 100 m keeps every
// real phone GPS fix (typically 5–30 m outdoors, 15–50 m under a market
// canopy) and rejects the IP/Wi-Fi fallbacks that were causing the bad pins
// (typically 500 m – 5 km).
const ACCURACY_GATE_M = 100

// Best-effort timestamp for a row (mock rows carry updated_at; real rows do
// too after the migration). Returns 0 when unknown → treat as "keep forever".
function rowTime(row) {
  const t = new Date(row?.updated_at || row?.created_at || NaN).getTime()
  return Number.isFinite(t) ? t : 0
}

async function publishPosition(sb, userId, lat, lng, accuracy) {
  // accuracy travels with the dot so every reader can judge how good the fix
  // was — a dot without it is indistinguishable from an exact one.
  const acc = Number.isFinite(Number(accuracy)) && Number(accuracy) > 0 ? Number(accuracy) : null
  const row = { user_id: userId, latitude: lat, longitude: lng, accuracy: acc }
  if (typeof sb.upsert === 'function') {
    // Real supabase-js: upsert keyed on user_id → one "last known location".
    const res = await sb.from('user_locations').upsert(row, { onConflict: 'user_id' })
    if (res?.error) throw res.error
    return
  }
  // Mock client (no upsert): update the user's existing row or insert one.
  const { data: mine } = await sb.from('user_locations').select('id').eq('user_id', userId).limit(1)
  if (mine?.length) {
    const res = await sb.from('user_locations').update(row).eq('id', mine[0].id)
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
 * @returns {{
 *   locations: Array,
 *   trails: Array<{user_id,path,points}>,
 *   sharing: boolean,
 *   shareStatus: 'off'|'locating'|'sharing'|'inaccurate'|'denied'|'unavailable',
 *   shareError: string|null,
 *   requestShare: () => void,
 *   stopShare: () => void,
 * }}
 */
export function useLiveLocations({ enabled = true, share = true } = {}) {
  const { user } = useAuth()
  const [locations, setLocations] = useState([])
  const [trails, setTrails] = useState([])
  const [sharing, setSharing] = useState(false)
  // Honest reporting for "why isn't my dot on the map?" — without this the
  // only symptom was a map mysteriously missing dots.
  const [shareStatus, setShareStatus] = useState('off')
  const [shareError, setShareError] = useState(null)

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
        const rawAcc = r.accuracy
        const accuracy =
          rawAcc == null || rawAcc === '' || !Number.isFinite(Number(rawAcc))
            ? null
            : Number(rawAcc)
        return {
          id: r.id,
          user_id: r.user_id,
          lat: Number(r.latitude),
          lng: Number(r.longitude),
          name: p.full_name || '',
          city: p.city || '',
          accuracy,
        }
      })
      // Never render a fix that is too rough to be honest — the same gate the
      // write path uses. Rows predating the accuracy column carry null and
      // stay visible (there is nothing better to judge them by).
      .filter((d) => d.accuracy == null || d.accuracy <= ACCURACY_GATE_M)
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

  const publish = useCallback(async (lat, lng, accuracy) => {
    const sb = getSupabase()
    const u = userRef.current
    if (!sb || !u?.id) return
    try {
      await publishPosition(sb, u.id, lat, lng, accuracy)
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

  const reportShare = useCallback((status, message = null) => {
    if (!mountedRef.current) return
    setShareStatus(status)
    setShareError(message)
  }, [])

  // One GPS fix → breadcrumb + dot. Shared by the watcher and the
  // tab-became-visible refresh so both paths behave identically.
  const applyFix = useCallback((pos) => {
    const rawAcc = Number(pos.coords.accuracy)
    const accuracy = Number.isFinite(rawAcc) && rawAcc > 0 ? rawAcc : 50
    // Too rough to share: say why instead of silently publishing nothing.
    if (accuracy > ACCURACY_GATE_M) {
      reportShare(
        'inaccurate',
        `Your location is only accurate to about ±${Math.round(accuracy)} m, so it is not shown on the shared map. ` +
          'Turn on GPS (and be outdoors) for a precise fix — or drag the blue dot to your real spot.'
      )
      return
    }
    reportShare('sharing')
    const lat = pos.coords.latitude
    const lng = pos.coords.longitude
    // Breadcrumb first (movement-gated), then the dot.
    publishTrail(lat, lng, accuracy)

    const now = Date.now()
    const last = lastPublishRef.current
    const moved =
      last.lat != null && last.lng != null
        ? metersBetween(last.lat, last.lng, lat, lng)
        : Infinity
    const due = now - last.at >= PUBLISH_INTERVAL_MS
    // Walking refreshes the dot right away rather than waiting out the
    // heartbeat — a market shopper's position should follow them, not lag 60s.
    const walked = moved >= DOT_MOVE_M && now - last.at >= DOT_MIN_GAP_MS
    if (!due && !walked) return
    lastPublishRef.current = { at: now, lat, lng }
    publish(lat, lng, accuracy)
  }, [publish, publishTrail, reportShare])

  const stopWatching = useCallback(() => {
    if (watcherRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watcherRef.current)
      watcherRef.current = null
    }
    lastPublishRef.current = { at: 0 }
    lastTrailRef.current = { at: 0, lat: null, lng: null }
    if (mountedRef.current) setSharing(false)
    reportShare('off')
  }, [reportShare])

  const startWatching = useCallback(() => {
    const u = userRef.current
    if (!u?.id) return
    if (typeof navigator === 'undefined' || !navigator.geolocation) return
    if (watcherRef.current != null) return
    reportShare('locating')
    watcherRef.current = navigator.geolocation.watchPosition(
      applyFix,
      (err) => {
        const code = Number(err?.code)
        if (code === 1) {
          // Permission revoked — stop the watcher (the freshness window
          // retires this dot). Report it instead of failing silently.
          stopWatching()
          reportShare('denied', describeGeoError(err))
          return
        }
        // Unavailable / timeout are often transient (cold GPS start, poor
        // sky view). Keep watching — it retries — but surface the reason.
        reportShare('unavailable', describeGeoError(err))
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
    )
    if (mountedRef.current) setSharing(true)
  }, [applyFix, reportShare, stopWatching])

  // Explicit user gesture (wired to the map's "Find my location" control):
  // this is what fires the browser permission prompt, so sharing is always
  // something the user asked for, never something the page sprung on them.
  const requestShare = useCallback(() => {
    const u = userRef.current
    if (!u?.id) return
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reportShare('unavailable', GEO_MESSAGES.unavailable)
      return
    }
    reportShare('locating')
    startWatching()
  }, [reportShare, startWatching])

  const stopShare = useCallback(() => {
    stopWatching()
  }, [stopWatching])

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

  // Write path: start publishing as soon as permission is ALREADY granted,
  // or when the user explicitly asks via requestShare() (the map's "Find my
  // location" control). We never fire a permission prompt from here — on
  // browsers without the Permissions API there is no way to check first, so
  // those wait for the gesture too rather than prompting on page load (where
  // an unrequested prompt is often auto-denied and then remembered).
  useEffect(() => {
    if (!enabled || !share) {
      stopWatching()
      return undefined
    }
    const u = userRef.current
    if (!u?.id) return undefined
    if (typeof navigator === 'undefined' || !navigator.geolocation) return undefined

    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
      return undefined // wait for requestShare()
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
          else {
            stopWatching()
            // The user just toggled location off — say so rather than
            // silently dropping their dot. (Not reported on first mount:
            // a previously-denied visitor is not being scolded for it.)
            if (st.state === 'denied') reportShare('denied', GEO_MESSAGES.denied)
          }
        }
        if (st.state === 'granted') startWatching()
        st.addEventListener?.('change', handler)
      })
      .catch(() => {
        // Can't tell — wait for the user's gesture instead of prompting.
      })

    // Mobile browsers throttle timers and watchPosition in a backgrounded
    // tab, so the 60s heartbeat can lapse and the 10-minute freshness window
    // would retire the dot while the user was reading something else. Re-fix
    // the moment the tab comes back, and let that fix publish immediately.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (watcherRef.current == null) return
      lastPublishRef.current = { at: 0, lat: null, lng: null }
      try {
        navigator.geolocation.getCurrentPosition(applyFix, () => {}, {
          enableHighAccuracy: true,
          maximumAge: 5000,
          timeout: 10000,
        })
      } catch {
        /* the watcher's next fix covers it */
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      if (status && handler) status.removeEventListener?.('change', handler)
      document.removeEventListener('visibilitychange', onVisibility)
      stopWatching()
    }
  }, [enabled, share, user?.id, applyFix, startWatching, stopWatching, reportShare])

  return { locations, trails, sharing, shareStatus, shareError, requestShare, stopShare }
}