'use client'

// Map Studio — the contributor tab.
//
// Flow: name the outing → Start Trail (GPS begins, the admin dashboard sees
// your dot move live) → drop photo landmarks where you stand → label
// stretches of ground as you walk them (walkway/road/stairs/…) → Submit.
// Everything you add is a DRAFT; an admin confirms it before it reaches the
// public map. Store owners use the same tab to photograph their own shop.
//
// Runs in both modes: mock (localStorage, no server) and postgres.

import { useEffect, useMemo, useRef, useState } from 'react'
import Header from '@/components/Header'
import Footer from '@/components/Footer'
import LiveMap from '@/components/maps/LiveMap'
import { Icon } from '@/components/icons'
import { useAuth } from '@/context/auth-context'
import { useTrailSession } from '@/hooks/useTrailSession'
import { inMockMode } from '@/lib/supabase'
import {
  WALKWAY_KINDS,
  LANDMARK_TYPES,
  ITEM_STATUS,
  SESSION_STATUS,
  geometryToPath,
  geometryLengthM,
  grantMockAdmin,
  seedDemoMapper,
} from '@/lib/mapstudio'

const DEMO_SEED_FLAG = 'kj_studio_demo_seeded'

const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '')

export default function StudioPage() {
  const { user, profile, loading, signOut } = useAuth()
  const trail = useTrailSession()

  const [title, setTitle] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  // Landmark composer state
  const [showLandmark, setShowLandmark] = useState(false)
  const [lmName, setLmName] = useState('')
  const [lmNotes, setLmNotes] = useState('')
  const [lmType, setLmType] = useState('landmark')
  const [lmFiles, setLmFiles] = useState([])
  const [lmPreviews, setLmPreviews] = useState([])

  // Walkway composer state
  const [showWalkway, setShowWalkway] = useState(false)
  const [wkKind, setWkKind] = useState('walkway')
  const [wkName, setWkName] = useState('')
  const segmentStartRef = useRef(0)

  const isAdmin = Boolean(profile?.is_admin)
  const active = trail.status === 'active' || trail.status === 'locating'

  // Mock-mode preview: if nobody is signed in, seed a local "Demo Mapper"
  // session and reload once so the Studio renders straight away — no signup
  // detour. Postgres mode is untouched (seedDemoMapper refuses to run there),
  // and the once-flag stops a reload loop if the seed ever fails.
  useEffect(() => {
    if (loading || user || !inMockMode()) return
    if (sessionStorage.getItem(DEMO_SEED_FLAG)) return
    if (!seedDemoMapper()) return
    sessionStorage.setItem(DEMO_SEED_FLAG, '1')
    window.location.reload()
  }, [loading, user])

  // Path for the live preview of what's been walked this session.
  const livePath = useMemo(
    () => trail.path.map((p) => ({ lat: p.lat, lng: p.lng })),
    [trail.path]
  )

  const trailLengthM = useMemo(() => {
    let total = 0
    for (let i = 1; i < trail.path.length; i++) {
      const a = trail.path[i - 1]
      const b = trail.path[i]
      const R = 6371000
      const toRad = (d) => (d * Math.PI) / 180
      const dLat = toRad(b.lat - a.lat)
      const dLng = toRad(b.lng - a.lng)
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
      total += 2 * R * Math.asin(Math.sqrt(h))
    }
    return total
  }, [trail.path])

  const onFiles = (e) => {
    const list = Array.from(e.target.files || []).slice(0, 3)
    setLmFiles(list)
    Promise.all(
      list.map(
        (f) =>
          new Promise((resolve) => {
            const r = new FileReader()
            r.onload = () => resolve(r.result)
            r.onerror = () => resolve(null)
            r.readAsDataURL(f)
          })
      )
    ).then((urls) => setLmPreviews(urls.filter(Boolean)))
  }

  const saveLandmark = async () => {
    const created = await trail.addLandmark({
      name: lmName,
      notes: lmNotes,
      category: lmType,
      files: lmFiles,
    })
    if (created) {
      setShowLandmark(false)
      setLmName(''); setLmNotes(''); setLmType('landmark')
      setLmFiles([]); setLmPreviews([])
    }
  }

  const startSegment = () => {
    segmentStartRef.current = trail.path.length
    setShowWalkway(true)
  }

  const saveSegment = async () => {
    const saved = await trail.addWalkway({
      kind: wkKind,
      name: wkName,
      startIndex: segmentStartRef.current,
    })
    if (saved) {
      setShowWalkway(false)
      setWkName(''); setWkKind('walkway')
    }
  }

  const submit = async () => {
    if (!window.confirm('Submit this session for review? You can no longer edit it once submitted.')) return
    await trail.submit()
  }

  const mapCenter = trail.position
    ? { lat: trail.position.lat, lng: trail.position.lng }
    : null

  // Everything the map should draw: the walked path (as a live trail), the
  // session's own draft landmarks + walkways (visible to their author), and
  // the contributor's own dot.
  const walkwayLines = useMemo(() => {
    const saved = trail.walkways.map((w) => ({ ...w, geometry: geometryToPath(w.geometry) }))
    return saved
  }, [trail.walkways])

  const ownDot = trail.position
    ? [
        {
          id: 'me',
          user_id: user?.id || 'me',
          lat: trail.position.lat,
          lng: trail.position.lng,
          name: profile?.full_name || 'You',
          accuracy: trail.position.accuracy,
        },
      ]
    : []

  if (loading) {
    return (
      <>
        <Header user={user} profile={profile} onSignOut={signOut} />
        <main style={styles.page}><p style={styles.muted}>Loading…</p></main>
        <Footer />
      </>
    )
  }

  if (!user) {
    return (
      <>
        <Header user={user} profile={profile} onSignOut={signOut} />
        <main style={styles.page}>
          <div style={styles.card}>
            <Icon name="map-pin" size={30} color="var(--accent)" />
            <h1 style={styles.title}>Map Studio</h1>
            <p style={styles.muted}>
              Walk the market, add landmarks and paths, and grow the Kejetia map for everyone.
              Sign in to start mapping.
            </p>
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <a href="/auth/login" style={styles.btnPrimary}>Sign in</a>
              <a href="/auth/signup" style={styles.btnGhost}>Create account</a>
            </div>
          </div>
        </main>
        <Footer />
      </>
    )
  }

  return (
    <>
      <Header user={user} profile={profile} onSignOut={signOut} />
      <main style={styles.page}>
        {/* ── Session bar ── */}
        {!active && trail.status !== 'submitted' && (
          <div style={styles.card}>
            <h1 style={styles.title}>Start a mapping trail</h1>
            <p style={styles.muted}>
              Give this outing a name — e.g. <em>Town Square walk</em>. Once you start, your live
              position is shared with the map admin so they can watch the mapping happen, and
              everything you add becomes a draft until they confirm it.
            </p>
            <label style={styles.field}>
              <span style={styles.label}>Trail name</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Town Square walk"
                style={styles.input}
              />
            </label>
            <button
              onClick={() => trail.start(title)}
              disabled={trail.busy}
              style={styles.btnPrimary}
            >
              {trail.busy ? 'Starting…' : 'Start Trail'}
            </button>
          </div>
        )}

        {/* ── Active session ── */}
        {active && (
          <div style={styles.studioGrid}>
            <div style={styles.mapWrap}>
              <LiveMap
                stores={[]}
                landmarks={trail.landmarks}
                walkways={walkwayLines}
                userLocations={ownDot}
                trails={[{ user_id: user.id, path: livePath }]}
                center={mapCenter}
                zoom={mapCenter ? 17 : undefined}
                showUserLocation={false}
                showLandmarks
              />
              <div style={styles.hud}>
                <span style={styles.hudChip}>
                  <span style={styles.liveDot} /> {SESSION_STATUS.active.label}
                </span>
                <span style={styles.hudChip}>{trail.path.length} GPS points</span>
                <span style={styles.hudChip}>{fmtM(trailLengthM)} walked</span>
              </div>
            </div>

            <div style={styles.panel}>
              <h2 style={styles.panelTitle}>{trail.session?.title || 'Session'}</h2>

              {trail.error && (
                <p style={styles.error} onClick={trail.clearError}>{trail.error}</p>
              )}
              {trail.position && trail.position.accuracy > 100 && (
                <p style={styles.warn}>
                  GPS is rough (±{Math.round(trail.position.accuracy)} m). Your dot is hidden from
                  others until it improves — landmarks you drop will still use this position.
                </p>
              )}

              {/* Actions */}
              {!showLandmark && !showWalkway && (
                <div style={{ display: 'grid', gap: 10 }}>
                  <button onClick={() => setShowLandmark(true)} style={styles.actionBtn}>
                    <Icon name="camera" size={18} color="var(--accent)" />
                    Add landmark here
                  </button>
                  <button onClick={startSegment} style={styles.actionBtn}>
                    <Icon name="map-pin" size={18} color="var(--accent)" />
                    Label the path I walk
                  </button>
                  <button onClick={submit} disabled={trail.busy} style={styles.btnPrimary}>
                    {trail.busy ? 'Submitting…' : 'Submit for review'}
                  </button>
                  <button onClick={trail.pause} style={styles.btnGhost}>
                    Pause (keep working later)
                  </button>
                </div>
              )}

              {/* Landmark composer */}
              {showLandmark && (
                <div style={styles.composer}>
                  <h3 style={styles.composerTitle}>Add landmark</h3>
                  <p style={styles.hint}>Pinned at your current position.</p>
                  <input
                    value={lmName}
                    onChange={(e) => setLmName(e.target.value)}
                    placeholder="Name — e.g. Town Square"
                    style={styles.input}
                  />
                  <textarea
                    value={lmNotes}
                    onChange={(e) => setLmNotes(e.target.value)}
                    placeholder="Notes (optional) — colours, what's nearby…"
                    rows={2}
                    style={{ ...styles.input, resize: 'vertical' }}
                  />
                  <select value={lmType} onChange={(e) => setLmType(e.target.value)} style={styles.input}>
                    {LANDMARK_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <input type="file" accept="image/*" capture="environment" multiple onChange={onFiles} style={styles.file} />
                  {lmPreviews.length > 0 && (
                    <div style={styles.previewRow}>
                      {lmPreviews.map((src, i) => (
                        <img key={i} src={src} alt="" style={styles.preview} />
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={saveLandmark} disabled={trail.busy} style={styles.btnPrimary}>
                      {trail.busy ? 'Saving…' : 'Save landmark'}
                    </button>
                    <button onClick={() => setShowLandmark(false)} style={styles.btnGhost}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Walkway composer */}
              {showWalkway && (
                <div style={styles.composer}>
                  <h3 style={styles.composerTitle}>Label this stretch</h3>
                  <p style={styles.hint}>
                    {trail.path.length - segmentStartRef.current} points recorded since you tapped
                    “Label the path”. Save it as what it is.
                  </p>
                  <select value={wkKind} onChange={(e) => setWkKind(e.target.value)} style={styles.input}>
                    {WALKWAY_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>{k.label}</option>
                    ))}
                  </select>
                  <input
                    value={wkName}
                    onChange={(e) => setWkName(e.target.value)}
                    placeholder="Name (optional) — e.g. Main aisle"
                    style={styles.input}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={saveSegment} disabled={trail.busy} style={styles.btnPrimary}>
                      {trail.busy ? 'Saving…' : 'Save path'}
                    </button>
                    <button onClick={() => setShowWalkway(false)} style={styles.btnGhost}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Contributions so far */}
              <div style={styles.contrib}>
                <h3 style={styles.composerTitle}>
                  This session ({trail.landmarks.length + trail.walkways.length})
                </h3>
                {trail.landmarks.length + trail.walkways.length === 0 && (
                  <p style={styles.hint}>Nothing yet — add your first landmark.</p>
                )}
                {trail.landmarks.map((l) => (
                  <div key={l.id} style={styles.contribRow}>
                    {l.photo_url ? <img src={l.photo_url} alt="" style={styles.contribThumb} /> : <span style={styles.contribThumb}><Icon name="map-pin" size={16} color="var(--accent)" /></span>}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={styles.contribName}>{l.name}</div>
                      <div style={styles.contribMeta}>Landmark · {ITEM_STATUS[l.status]?.label || l.status}</div>
                    </div>
                  </div>
                ))}
                {trail.walkways.map((w) => (
                  <div key={w.id} style={styles.contribRow}>
                    <span style={styles.contribThumb}><Icon name="map-pin" size={16} color="var(--accent)" /></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={styles.contribName}>{w.name || w.kind}</div>
                      <div style={styles.contribMeta}>
                        {WALKWAY_KINDS.find((k) => k.value === w.kind)?.label || w.kind} ·{' '}
                        {fmtM(geometryLengthM(w.geometry))} · {ITEM_STATUS[w.status]?.label || w.status}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Submitted confirmation ── */}
        {trail.status === 'submitted' && (
          <div style={styles.card}>
            <Icon name="map-pin" size={28} color="var(--accent)" />
            <h1 style={styles.title}>Submitted for review</h1>
            <p style={styles.muted}>
              Thanks! An admin will confirm your contributions, after which they appear on the
              public map for everyone.
            </p>
            <button onClick={() => window.location.reload()} style={styles.btnPrimary}>
              Start another trail
            </button>
          </div>
        )}

        {/* ── Mock-mode dev affordance ── */}
        {inMockMode() && !isAdmin && (
          <div style={styles.devNote}>
            <strong>Mock mode:</strong> no server exists to grant admin rights, so you can
            toggle them on your own profile to test the review dashboard.
            <button
              onClick={async () => {
                await grantMockAdmin(user.id)
                window.location.reload()
              }}
              style={{ ...styles.btnGhost, marginLeft: 10, padding: '5px 12px', fontSize: 12 }}
            >
              Make me admin
            </button>
          </div>
        )}
        {isAdmin && (
          <p style={styles.adminLink}>
            You are an admin — <a href="/admin/map" style={{ color: 'var(--accent)' }}>open the Map Admin dashboard</a>.
          </p>
        )}
      </main>
      <Footer />
    </>
  )
}

const styles = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg, #f8fafc)',
    padding: '24px 16px 60px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
  },
  card: {
    width: 'min(560px, 100%)',
    background: '#fff',
    borderRadius: 18,
    padding: 26,
    boxShadow: '0 10px 34px rgba(15, 23, 42, 0.08)',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    alignItems: 'flex-start',
  },
  title: { margin: 0, fontSize: 24, fontWeight: 800, color: 'var(--navy)' },
  muted: { margin: 0, fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 },
  field: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%' },
  label: { fontSize: 12, fontWeight: 700, color: 'var(--navy)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  input: {
    border: '1px solid #cbd5e1',
    borderRadius: 10,
    padding: '11px 13px',
    fontSize: 14.5,
    fontFamily: 'inherit',
    background: '#fff',
    color: 'var(--ink)',
    width: '100%',
    boxSizing: 'border-box',
  },
  file: { fontSize: 13, color: 'var(--muted)' },
  btnPrimary: {
    border: 'none',
    background: 'var(--accent, #f59e0b)',
    color: 'var(--navy, #0f172a)',
    fontWeight: 800,
    fontSize: 14.5,
    padding: '12px 22px',
    borderRadius: 11,
    cursor: 'pointer',
    textAlign: 'center',
  },
  btnGhost: {
    border: '1px solid #cbd5e1',
    background: '#fff',
    color: 'var(--muted)',
    fontWeight: 700,
    fontSize: 14,
    padding: '11px 20px',
    borderRadius: 11,
    cursor: 'pointer',
    textAlign: 'center',
  },
  studioGrid: {
    width: 'min(1100px, 100%)',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.6fr) minmax(300px, 1fr)',
    gap: 16,
    alignItems: 'start',
  },
  mapWrap: {
    position: 'relative',
    height: '70vh',
    minHeight: 420,
    borderRadius: 16,
    overflow: 'hidden',
    border: '1px solid #e2e8f0',
    background: '#e2e8f0',
  },
  hud: {
    position: 'absolute',
    top: 10,
    left: 10,
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    zIndex: 1200,
    pointerEvents: 'none',
  },
  hudChip: {
    background: 'rgba(15, 23, 42, 0.85)',
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
    padding: '6px 12px',
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#22c55e',
    animation: 'pulse-core 1.6s ease-in-out infinite',
  },
  panel: {
    background: '#fff',
    borderRadius: 16,
    padding: 18,
    boxShadow: '0 10px 34px rgba(15, 23, 42, 0.08)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  panelTitle: { margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--navy)' },
  actionBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    border: '1px solid #e2e8f0',
    background: '#f8fafc',
    color: 'var(--navy)',
    fontWeight: 700,
    fontSize: 14.5,
    padding: '13px 15px',
    borderRadius: 12,
    cursor: 'pointer',
    textAlign: 'left',
  },
  composer: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    border: '1px solid #e2e8f0',
    borderRadius: 12,
    padding: 14,
    background: '#f8fafc',
  },
  composerTitle: { margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--navy)' },
  hint: { margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 },
  previewRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  preview: { width: 72, height: 72, objectFit: 'cover', borderRadius: 10, border: '1px solid #e2e8f0' },
  contrib: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 },
  contribRow: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    padding: '8px 10px',
    border: '1px solid #f1f5f9',
    borderRadius: 10,
    background: '#fff',
  },
  contribThumb: {
    width: 40,
    height: 40,
    borderRadius: 8,
    objectFit: 'cover',
    background: '#f1f5f9',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  contribName: { fontSize: 13.5, fontWeight: 700, color: 'var(--navy)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  contribMeta: { fontSize: 11.5, color: 'var(--muted)' },
  error: {
    margin: 0,
    fontSize: 13,
    color: '#dc2626',
    fontWeight: 600,
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: 10,
    padding: '9px 12px',
    cursor: 'pointer',
  },
  warn: {
    margin: 0,
    fontSize: 12.5,
    color: '#92400e',
    fontWeight: 600,
    background: '#fffbeb',
    border: '1px solid #fde68a',
    borderRadius: 10,
    padding: '9px 12px',
  },
  devNote: {
    width: 'min(1100px, 100%)',
    fontSize: 13,
    color: 'var(--muted)',
    background: '#fffbeb',
    border: '1px solid #fde68a',
    borderRadius: 12,
    padding: '12px 16px',
  },
  adminLink: { margin: 0, fontSize: 13.5, color: 'var(--muted)' },
}
