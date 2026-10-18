// useTrailSession — the contributor side of the Map Studio.
//
// While a session is ACTIVE this hook:
//   • watches GPS (high accuracy) and keeps the live path in memory so the
//     studio map can draw the walk as it happens;
//   • publishes the contributor's DOT to `user_locations` (~heartbeat, or
//     immediately after walking DOT_MOVE_M) — this is what makes the admin
//     dashboard show them moving in real time;
//   • appends BREADCRUMBS to `location_trails` while actually walking, so
//     the admin sees the traced route, not just a jumping dot;
//   • exposes addLandmark() / addWalkway() which attach contributions to
//     the session (status 'draft' — the server forces this).
//
// Accuracy discipline matches the rest of the app: fixes rougher than
// ACCURACY_GATE_M are never published (a dot in the wrong neighbourhood is
// worse than no dot). The in-memory path still records them so a walk under
// a tin roof isn't lost, but they don't reach other users.
//
// On submit the session moves to 'submitted' and tracking stops; the admin
// dashboard is then the only reader of the trail.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getSupabase } from '@/lib/supabase'
import { useAuth } from '@/context/auth-context'
import { metersBetween } from '@/lib/kejetia-graph'
import { describeGeoError, GEO_MESSAGES } from '@/lib/geolocation'
import { uploadSinglePhoto } from '@/lib/media'
import { startSession, submitSession, pathToGeometry } from '@/lib/mapstudio'

const DOT_HEARTBEAT_MS = 20 * 1000 // admin dashboard refresh cadence while mapping
const DOT_MOVE_M = 15 // …or publish the moment they walk this far
const DOT_MIN_GAP_MS = 5 * 1000 // never flood the dot writes while moving
const CRUMB_MIN_MOVE_M = 8 // ignore GPS jitter below this
const CRUMB_MIN_GAP_MS = 5 * 1000
const ACCURACY_GATE_M = 100 // same gate the live map uses (see useLiveLocations)
const MAX_SESSION_POINTS = 5000 // hard cap on the in-memory path

async function publishDot(sb, userId, lat, lng, accuracy) {
  const row = { user_id: userId, latitude: lat, longitude: lng, accuracy }
  if (typeof sb.upsert === 'function') {
    const res = await sb.from('user_locations').upsert(row, { onConflict: 'user_id' })
    if (res?.error) throw res.error
    return
  }
  // Mock client has no upsert — update the existing row or insert one.
  const { data: mine } = await sb.from('user_locations').select('id').eq('user_id', userId).limit(1)
  if (mine?.length) {
    const res = await sb.from('user_locations').update(row).eq('id', mine[0].id)
    if (res?.error) throw res.error
  } else {
    const res = await sb.from('user_locations').insert(row)
    if (res?.error) throw res.error
  }
}

export function useTrailSession() {
  const { user } = useAuth()
  const [session, setSession] = useState(null)
  const [path, setPath] = useState([]) // [{lat, lng, t, accuracy}]
  const [position, setPosition] = useState(null) // {lat, lng, accuracy}
  const [status, setStatus] = useState('idle') // idle | locating | active | submitting | submitted
  const [error, setError] = useState(null)
  const [landmarks, setLandmarks] = useState([])
  const [walkways, setWalkways] = useState([])
  const [busy, setBusy] = useState(false)

  const userRef = useRef(user)
  userRef.current = user
  const sessionRef = useRef(session)
  sessionRef.current = session
  const watcherRef = useRef(null)
  const pathRef = useRef([])
  const lastDotRef = useRef({ at: 0, lat: null, lng: null })
  const lastCrumbRef = useRef({ at: 0, lat: null, lng: null })
  const mountedRef = useRef(true)

  const reportError = useCallback((message) => {
    if (mountedRef.current) setError(message)
  }, [])

  // ── Load this session's contributions (drafts are visible to their
  // author, so the studio can show them pending). ──
  const refreshContributions = useCallback(async () => {
    const sb = getSupabase()
    const s = sessionRef.current
    if (!sb || !s?.id) return
    const [{ data: lm }, { data: ww }] = await Promise.all([
      sb.from('landmarks').select('*').eq('session_id', s.id).catch(() => ({ data: [] })),
      sb.from('walkways').select('*').eq('session_id', s.id).catch(() => ({ data: [] })),
    ])
    if (!mountedRef.current) return
    setLandmarks(lm || [])
    setWalkways(ww || [])
  }, [])

  // ── GPS watcher: one fix → path + dot + crumb ──
  const onFix = useCallback((pos) => {
    const lat = pos.coords.latitude
    const lng = pos.coords.longitude
    const rawAcc = Number(pos.coords.accuracy)
    const accuracy = Number.isFinite(rawAcc) && rawAcc > 0 ? rawAcc : 50
    if (!mountedRef.current) return
    setPosition({ lat, lng, accuracy })

    const now = Date.now()
    const path = pathRef.current
    const last = path[path.length - 1]
    // Always grow the in-memory path (the studio draws it live), with a
    // light jitter gate so standing still doesn't pile up a thousand points.
    const moved = last ? metersBetween(last.lat, last.lng, lat, lng) : Infinity
    if (moved > 1 || !last) {
      if (path.length < MAX_SESSION_POINTS) {
        pathRef.current = [...path, { lat, lng, t: now, accuracy }]
        setPath(pathRef.current)
      }
    }

    // Below the gate: keep it local, never publish a wrong-neighbourhood dot.
    if (accuracy > ACCURACY_GATE_M) return

    const sb = getSupabase()
    const u = userRef.current
    if (!sb || !u?.id || !sessionRef.current) return

    // DOT — heartbeat or meaningful movement.
    const dotLast = lastDotRef.current
    const dotMoved = dotLast.lat != null ? metersBetween(dotLast.lat, dotLast.lng, lat, lng) : Infinity
    const dotDue = now - dotLast.at >= DOT_HEARTBEAT_MS
    const dotWalked = dotMoved >= DOT_MOVE_M && now - dotLast.at >= DOT_MIN_GAP_MS
    if (dotDue || dotWalked) {
      lastDotRef.current = { at: now, lat, lng }
      publishDot(sb, u.id, lat, lng, accuracy).catch((err) =>
        console.warn('Could not publish mapping dot:', err?.message || err)
      )
    }

    // CRUMB — only while actually walking.
    const crumbLast = lastCrumbRef.current
    const crumbMoved = crumbLast.lat != null ? metersBetween(crumbLast.lat, crumbLast.lng, lat, lng) : Infinity
    if (crumbMoved >= CRUMB_MIN_MOVE_M && now - crumbLast.at >= CRUMB_MIN_GAP_MS) {
      lastCrumbRef.current = { at: now, lat, lng }
      sb.from('location_trails')
        .insert({ latitude: lat, longitude: lng, accuracy })
        .then(({ error: e }) => { if (e) console.warn('Could not publish trail crumb:', e.message) })
        .catch(() => {})
    }
  }, [])

  const onGeoError = useCallback((err) => {
    const code = Number(err?.code)
    if (code === 1) {
      stopWatcher()
      reportError(describeGeoError(err))
      if (mountedRef.current) setStatus(sessionRef.current ? 'active' : 'idle')
      return
    }
    // Transient (cold GPS start / poor sky view) — keep watching, but say why.
    reportError(describeGeoError(err))
  }, [reportError]) // eslint-disable-line react-hooks/exhaustive-deps

  function stopWatcher() {
    if (watcherRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watcherRef.current)
      watcherRef.current = null
    }
    lastDotRef.current = { at: 0, lat: null, lng: null }
    lastCrumbRef.current = { at: 0, lat: null, lng: null }
  }

  const start = useCallback(async (title) => {
    const u = userRef.current
    if (!u?.id) { reportError('Sign in to start mapping.'); return null }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reportError(GEO_MESSAGES.unavailable)
      return null
    }
    setBusy(true)
    setError(null)
    setStatus('locating')
    try {
      const { ok, session: s, error: startErr } = await startSession(title)
      if (!ok) { reportError(startErr); setStatus('idle'); return null }
      if (!mountedRef.current) return null
      setSession(s)
      sessionRef.current = s
      setPath([]); pathRef.current = []
      setLandmarks([]); setWalkways([])

      watcherRef.current = navigator.geolocation.watchPosition(
        onFix,
        onGeoError,
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      )
      setStatus('active')
      return s
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [onFix, onGeoError, reportError])

  // ── Add a photo landmark pinned at the current position ──
  const addLandmark = useCallback(async ({ name, notes = '', category = 'landmark', files = [] }) => {
    const sb = getSupabase()
    const s = sessionRef.current
    const u = userRef.current
    const pos = position
    if (!sb || !s) { reportError('Start a session first.'); return null }
    if (!pos) { reportError('Waiting for a GPS fix — try again in a few seconds.'); return null }
    if (!String(name || '').trim()) { reportError('Give the landmark a name.'); return null }

    setBusy(true)
    setError(null)
    try {
      // Up to 3 photos; first doubles as the map-pin thumbnail.
      const urls = []
      for (const file of Array.from(files || []).slice(0, 3)) {
        const url = await uploadSinglePhoto(file, 'landmark-photos', `${s.id}`)
        if (url) urls.push(url)
      }
      const { data, error: e } = await sb
        .from('landmarks')
        .insert({
          name: String(name).trim(),
          notes: String(notes || '').trim(),
          category,
          latitude: pos.lat,
          longitude: pos.lng,
          photo_url: urls[0] || null,
          images: urls,
          session_id: s.id,
          // Draft in BOTH modes: postgres mode overwrites this server-side
          // anyway (authzInsert forces it), but mock mode has no server, so
          // the client must set it or the row lands with status undefined
          // and never shows up in the review queue.
          status: 'draft',
          created_by: u?.id || null,
        })
        .select()
        .single()
      if (e) { reportError(e.message || 'Could not save the landmark.'); return null }
      if (mountedRef.current) setLandmarks((prev) => [...prev, data])
      return data
    } catch (err) {
      reportError(err?.message || 'Could not save the landmark.')
      return null
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [position, reportError])

  // ── Save the path walked since `startIndex` as a labelled walkway ──
  const addWalkway = useCallback(async ({ kind = 'walkway', name = '', startIndex = 0 }) => {
    const sb = getSupabase()
    const s = sessionRef.current
    if (!sb || !s) { reportError('Start a session first.'); return null }
    const slice = pathRef.current.slice(Math.max(0, Number(startIndex) || 0))
    if (slice.length < 2) {
      reportError('Walk at least a few steps before saving a path segment.')
      return null
    }
    setBusy(true)
    setError(null)
    try {
      const { data, error: e } = await sb
        .from('walkways')
        .insert({
          session_id: s.id,
          kind,
          name: String(name || '').trim(),
          geometry: pathToGeometry(slice),
          // Same reasoning as addLandmark: mock mode has no server to force
          // this, so the client sets the draft state explicitly.
          status: 'draft',
          created_by: userRef.current?.id || null,
        })
        .select()
        .single()
      if (e) { reportError(e.message || 'Could not save the path.'); return null }
      if (mountedRef.current) setWalkways((prev) => [...prev, data])
      return data
    } catch (err) {
      reportError(err?.message || 'Could not save the path.')
      return null
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [reportError])

  // ── Hand the session to the admin queue and stop tracking ──
  const submit = useCallback(async () => {
    const s = sessionRef.current
    if (!s) return false
    setBusy(true)
    setStatus('submitting')
    try {
      const { ok, error: e } = await submitSession(s.id)
      if (!ok) { reportError(e); setStatus('active'); return false }
      stopWatcher()
      if (mountedRef.current) {
        setSession({ ...s, status: 'submitted' })
        setStatus('submitted')
      }
      return true
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [reportError])

  // Abandon an active session without submitting (keeps it 'active' so the
  // contributor can resume later from the sessions list).
  const pause = useCallback(() => {
    stopWatcher()
    if (mountedRef.current) setStatus('idle')
  }, [])

  // Resume an existing 'active' session (page reload, coming back later).
  const resume = useCallback(async (s) => {
    if (!s?.id || typeof navigator === 'undefined' || !navigator.geolocation) return
    sessionRef.current = s
    if (mountedRef.current) {
      setSession(s)
      setPath([]); pathRef.current = []
      setStatus('active')
    }
    await refreshContributions()
    watcherRef.current = navigator.geolocation.watchPosition(
      onFix,
      onGeoError,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    )
  }, [onFix, onGeoError, refreshContributions])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopWatcher()
    }
  }, [])

  return {
    session,
    path,
    position,
    status,
    error,
    busy,
    landmarks,
    walkways,
    start,
    pause,
    resume,
    submit,
    addLandmark,
    addWalkway,
    refreshContributions,
    clearError: () => setError(null),
  }
}
