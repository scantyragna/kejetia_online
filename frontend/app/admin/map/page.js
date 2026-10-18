'use client'

// Map Admin — the review + live-monitoring dashboard.
//
// Three jobs on one screen:
//   1. LIVE  — every contributor's current dot + walked trail, refreshed by
//              the same 2-second realtime poll the rest of the app uses. This
//              is the "watch everybody map the market right now" view.
//   2. QUEUE — submitted trail sessions, newest first. Approving publishes
//              the session's draft landmarks + walkways to the public map
//              (server-side cascade); rejecting withdraws them.
//   3. REPORTS — community flags on published features, so wrong pins get
//              cleaned up without you walking there.
//
// Gated on profiles.is_admin, which no signup path can grant. In mock mode
// the studio page offers a dev toggle (there's no server to grant it).

import { useEffect, useMemo, useState } from 'react'
import Header from '@/components/Header'
import Footer from '@/components/Footer'
import LiveMap from '@/components/maps/LiveMap'
import { Icon } from '@/components/icons'
import { useAuth } from '@/context/auth-context'
import { useLiveLocations } from '@/hooks/useLiveLocations'
import { getSupabase } from '@/lib/supabase'
import {
  WALKWAY_KINDS,
  geometryToPath,
  geometryLengthM,
  reviewSession,
} from '@/lib/mapstudio'

const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)
const fmtAgo = (t) => {
  if (!t) return ''
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000)
  if (s < 60) return `${Math.round(s)}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export default function AdminMapPage() {
  const { user, profile, loading, signOut } = useAuth()
  // Read-only live feed: everyone's dots + trails. share=false so the admin's
  // own position isn't published back into the same map they're watching.
  const live = useLiveLocations({ enabled: true, share: false })

  const [sessions, setSessions] = useState([])
  const [pendingLandmarks, setPendingLandmarks] = useState([])
  const [pendingWalkways, setPendingWalkways] = useState([])
  const [reports, setReports] = useState([])
  const [reportFeatures, setReportFeatures] = useState({}) // `${table}:${id}` → name
  const [names, setNames] = useState({}) // profile id → display name
  const [selected, setSelected] = useState(null) // session id being reviewed
  const [busyId, setBusyId] = useState(null)
  const [notice, setNotice] = useState(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const isAdmin = Boolean(profile?.is_admin)

  const refresh = async () => {
    const sb = getSupabase()
    if (!sb) return
    const [{ data: ss }, { data: lm }, { data: ww }, { data: profs }, { data: reps }] = await Promise.all([
      sb.from('trail_sessions').select('*').order('created_at', { ascending: false }).limit(50).catch(() => ({ data: [] })),
      sb.from('landmarks').select('*').eq('status', 'draft').limit(200).catch(() => ({ data: [] })),
      sb.from('walkways').select('*').eq('status', 'draft').limit(200).catch(() => ({ data: [] })),
      sb.from('profiles').select('*').catch(() => ({ data: [] })),
      sb.from('map_reports').select('*').eq('status', 'open').limit(100).catch(() => ({ data: [] })),
    ])
    setSessions(ss || [])
    setPendingLandmarks(lm || [])
    setPendingWalkways(ww || [])
    setReports(reps || [])
    const map = {}
    ;(profs || []).forEach((p) => { map[p.id] = p.full_name || p.city || 'Contributor' })
    setNames(map)

    // Resolve the name of each reported feature so the row is readable.
    const ids = { landmarks: new Set(), walkways: new Set(), stores: new Set() }
    ;(reps || []).forEach((r) => { ids[r.feature_table]?.add(r.feature_id) })
    const featureMap = {}
    for (const [table, set] of Object.entries(ids)) {
      if (!set.size) continue
      const { data } = await sb.from(table).select('id, name').in('id', [...set]).catch(() => ({ data: [] }))
      ;(data || []).forEach((f) => { featureMap[`${table}:${f.id}`] = f.name || '(unnamed)' })
    }
    setReportFeatures(featureMap)
  }

  useEffect(() => {
    if (!isAdmin) return
    refresh()
    // Live: any change to a session or a contribution re-pulls the queue.
    const sb = getSupabase()
    if (!sb) return undefined
    const channel = sb
      .channel('admin-map')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trail_sessions' }, () => setRefreshNonce((n) => n + 1))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'landmarks' }, () => setRefreshNonce((n) => n + 1))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'walkways' }, () => setRefreshNonce((n) => n + 1))
      .subscribe()
    const t = setInterval(() => setRefreshNonce((n) => n + 1), 15000) // safety net
    return () => {
      sb.removeChannel(channel)
      clearInterval(t)
    }
  }, [isAdmin])

  useEffect(() => {
    if (isAdmin) refresh()
  }, [refreshNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // Work the report queue: 'dismiss' keeps the feature, 'remove' withdraws
  // it from the public map (status → rejected) and closes the report.
  const resolveReport = async (report, action) => {
    const sb = getSupabase()
    if (!sb) return
    setBusyId(report.id)
    try {
      if (action === 'remove') {
        const { error } = await sb
          .from(report.feature_table)
          .update({ status: 'rejected' })
          .eq('id', report.feature_id)
        if (error) { setNotice({ tone: 'bad', text: error.message }); return }
      }
      const { error } = await sb
        .from('map_reports')
        .update({ status: action === 'remove' ? 'resolved' : 'dismissed' })
        .eq('id', report.id)
      if (error) { setNotice({ tone: 'bad', text: error.message }); return }
      setNotice({
        tone: 'ok',
        text: action === 'remove' ? 'Feature removed from the public map.' : 'Report dismissed — feature stays up.',
      })
      setRefreshNonce((n) => n + 1)
    } finally {
      setBusyId(null)
    }
  }

  const verdict = async (sessionId, next) => {    setBusyId(sessionId)
    const { ok, error } = await reviewSession(sessionId, next)
    setBusyId(null)
    if (!ok) {
      setNotice({ tone: 'bad', text: error })
      return
    }
    setNotice({
      tone: next === 'approved' ? 'ok' : 'bad',
      text: next === 'approved' ? 'Approved — contributions are now live on the public map.' : 'Session rejected.',
    })
    setSelected(null)
    setRefreshNonce((n) => n + 1)
  }

  const submitted = sessions.filter((s) => s.status === 'submitted')
  const inProgress = sessions.filter((s) => s.status === 'active')

  // What to draw on the review map: published ground truth + every pending
  // draft (dashed) so the reviewer sees exactly what they're judging.
  const reviewWalkways = useMemo(() => {
    const all = [...pendingWalkways]
    return all.map((w) => ({ ...w, geometry: geometryToPath(w.geometry) }))
  }, [pendingWalkways])

  // Landmarks: pending drafts only (published ones already render from the
  // public feed; showing both would double-draw).
  const reviewLandmarks = useMemo(() => [...pendingLandmarks], [pendingLandmarks])

  // Live dots, enriched with the contributor's name.
  const dots = useMemo(
    () => live.locations.map((l) => ({ ...l, name: names[l.user_id] || l.name || 'Contributor' })),
    [live.locations, names]
  )

  if (loading) {
    return (
      <>
        <Header user={user} profile={profile} onSignOut={signOut} />
        <main style={styles.page}><p style={styles.muted}>Loading…</p></main>
        <Footer />
      </>
    )
  }

  if (!user || !isAdmin) {
    return (
      <>
        <Header user={user} profile={profile} onSignOut={signOut} />
        <main style={styles.page}>
          <div style={styles.card}>
            <Icon name="map-pin" size={28} color="var(--accent)" />
            <h1 style={styles.title}>Admins only</h1>
            <p style={styles.muted}>
              The Map Admin dashboard requires the admin flag on your profile.
              {user ? '' : ' Sign in first.'}
            </p>
            <a href={user ? '/' : '/auth/login'} style={styles.btnPrimary}>
              {user ? 'Back to map' : 'Sign in'}
            </a>
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
        <div style={styles.headRow}>
          <div>
            <h1 style={styles.title}>Map Admin</h1>
            <p style={styles.muted}>
              {dots.length} live · {submitted.length} awaiting review · {inProgress.length} mapping now
            </p>
          </div>
        </div>

        {notice && (
          <p style={{ ...styles.notice, color: notice.tone === 'ok' ? '#065f46' : '#991b1b' }}>
            {notice.text}
          </p>
        )}

        <div style={styles.grid}>
          {/* ── Live map ── */}
          <div style={styles.mapWrap}>
            <LiveMap
              stores={[]}
              landmarks={reviewLandmarks}
              walkways={reviewWalkways}
              userLocations={dots}
              trails={live.trails}
              showUserLocation={false}
              showLandmarks
            />
            <div style={styles.hud}>
              <span style={styles.hudChip}>
                <span style={styles.liveDot} /> {dots.length} live now
              </span>
              <span style={styles.hudChip}>dashed = pending review</span>
            </div>
          </div>

          {/* ── Side panel ── */}
          <div style={styles.panel}>
            {/* Live contributors */}
            <section>
              <h2 style={styles.sectionTitle}>Live now</h2>
              {dots.length === 0 && <p style={styles.hint}>Nobody is sharing a location right now.</p>}
              {dots.map((d) => (
                <div key={d.id || d.user_id} style={styles.row}>
                  <span style={styles.liveDot} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.rowName}>{d.name}</div>
                    <div style={styles.rowMeta}>
                      {fmtAgo(live.locations.find((x) => x.user_id === d.user_id)?.updated_at)}
                      {d.accuracy != null ? ` · ±${Math.round(d.accuracy)} m` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </section>

            {/* Review queue */}
            <section>
              <h2 style={styles.sectionTitle}>Awaiting review ({submitted.length})</h2>
              {submitted.length === 0 && <p style={styles.hint}>Queue is clear. 🎉</p>}
              {submitted.map((s) => {
                const lmCount = pendingLandmarks.filter((l) => l.session_id === s.id).length
                const wwCount = pendingWalkways.filter((w) => w.session_id === s.id).length
                const isOpen = selected === s.id
                return (
                  <div key={s.id} style={styles.session}>
                    <div style={styles.sessionHead}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={styles.rowName}>{s.title || 'Untitled session'}</div>
                        <div style={styles.rowMeta}>
                          {names[s.user_id] || 'Contributor'} · {fmtAgo(s.created_at)} ·{' '}
                          {lmCount} landmark{lmCount === 1 ? '' : 's'}, {wwCount} path{wwCount === 1 ? '' : 's'}
                        </div>
                      </div>
                      <button
                        onClick={() => setSelected(isOpen ? null : s.id)}
                        style={styles.linkBtn}
                      >
                        {isOpen ? 'Hide' : 'Review'}
                      </button>
                    </div>

                    {isOpen && (
                      <div style={styles.sessionBody}>
                        <p style={styles.hint}>
                          Dashed lines and pins on the map are this session's pending contributions.
                        </p>
                        {lmCount + wwCount === 0 && (
                          <p style={styles.warn}>This session has no contributions to publish.</p>
                        )}
                        {pendingLandmarks.filter((l) => l.session_id === s.id).map((l) => (
                          <div key={l.id} style={styles.itemRow}>
                            {l.photo_url ? (
                              <img src={l.photo_url} alt="" style={styles.itemThumb} />
                            ) : (
                              <span style={styles.itemThumb}><Icon name="map-pin" size={15} color="var(--accent)" /></span>
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={styles.rowName}>{l.name}</div>
                              <div style={styles.rowMeta}>Landmark{l.notes ? ` · ${l.notes}` : ''}</div>
                            </div>
                          </div>
                        ))}
                        {pendingWalkways.filter((w) => w.session_id === s.id).map((w) => (
                          <div key={w.id} style={styles.itemRow}>
                            <span
                              style={{
                                ...styles.kindDot,
                                background: WALKWAY_KINDS.find((k) => k.value === w.kind)?.color || '#64748b',
                              }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={styles.rowName}>{w.name || w.kind}</div>
                              <div style={styles.rowMeta}>
                                {WALKWAY_KINDS.find((k) => k.value === w.kind)?.label || w.kind} ·{' '}
                                {fmtM(geometryLengthM(w.geometry))}
                              </div>
                            </div>
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                          <button
                            onClick={() => verdict(s.id, 'approved')}
                            disabled={busyId === s.id}
                            style={styles.approve}
                          >
                            {busyId === s.id ? 'Saving…' : 'Approve & publish'}
                          </button>
                          <button
                            onClick={() => verdict(s.id, 'rejected')}
                            disabled={busyId === s.id}
                            style={styles.reject}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </section>

            {/* Mapping now */}
            <section>
              <h2 style={styles.sectionTitle}>Mapping now ({inProgress.length})</h2>
              {inProgress.length === 0 && <p style={styles.hint}>No active sessions.</p>}
              {inProgress.map((s) => (
                <div key={s.id} style={styles.row}>
                  <span style={styles.liveDot} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.rowName}>{s.title || 'Untitled session'}</div>
                    <div style={styles.rowMeta}>
                      {names[s.user_id] || 'Contributor'} · started {fmtAgo(s.started_at)}
                    </div>
                  </div>
                </div>
              ))}
            </section>

            {/* Open reports from the public */}
            <section>
              <h2 style={styles.sectionTitle}>Open reports ({reports.length})</h2>
              {reports.length === 0 && <p style={styles.hint}>Nothing flagged. </p>}
              {reports.map((r) => (
                <div key={r.id} style={styles.session}>
                  <div style={styles.rowName}>
                    {reportFeatures[`${r.feature_table}:${r.feature_id}`] || '(unknown feature)'}
                  </div>
                  <div style={styles.rowMeta}>
                    {r.feature_table.replace(/s$/, '')} · “{r.reason}”
                    {r.detail ? ` · ${r.detail}` : ''} · {fmtAgo(r.created_at)}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button
                      onClick={() => resolveReport(r, 'remove')}
                      disabled={busyId === r.id}
                      style={{ ...styles.reject, padding: '7px 12px', fontSize: 12.5 }}
                    >
                      Remove feature
                    </button>
                    <button
                      onClick={() => resolveReport(r, 'dismiss')}
                      disabled={busyId === r.id}
                      style={{ ...styles.linkBtn, fontSize: 12.5 }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </section>
          </div>
        </div>
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
  headRow: { width: 'min(1200px, 100%)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' },
  title: { margin: 0, fontSize: 24, fontWeight: 800, color: 'var(--navy)' },
  muted: { margin: '4px 0 0', fontSize: 14, color: 'var(--muted)' },
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
  notice: {
    width: 'min(1200px, 100%)',
    margin: 0,
    fontSize: 13.5,
    fontWeight: 600,
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    borderRadius: 10,
    padding: '10px 14px',
  },
  grid: {
    width: 'min(1200px, 100%)',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.7fr) minmax(320px, 1fr)',
    gap: 16,
    alignItems: 'start',
  },
  mapWrap: {
    position: 'relative',
    height: '78vh',
    minHeight: 460,
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
    flexShrink: 0,
    animation: 'pulse-core 1.6s ease-in-out infinite',
  },
  panel: {
    background: '#fff',
    borderRadius: 16,
    padding: 18,
    boxShadow: '0 10px 34px rgba(15, 23, 42, 0.08)',
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
    maxHeight: '78vh',
    overflowY: 'auto',
  },
  sectionTitle: {
    margin: '0 0 8px',
    fontSize: 13,
    fontWeight: 800,
    color: 'var(--navy)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  hint: { margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 },
  warn: { margin: '6px 0 0', fontSize: 12.5, color: '#92400e', fontWeight: 600 },
  row: { display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0' },
  rowName: { fontSize: 13.5, fontWeight: 700, color: 'var(--navy)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowMeta: { fontSize: 11.5, color: 'var(--muted)' },
  session: { border: '1px solid #e2e8f0', borderRadius: 12, padding: 12, marginBottom: 8, background: '#fff' },
  sessionHead: { display: 'flex', gap: 10, alignItems: 'center' },
  sessionBody: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 },
  itemRow: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    padding: '7px 9px',
    border: '1px solid #f1f5f9',
    borderRadius: 10,
    background: '#f8fafc',
  },
  itemThumb: {
    width: 38,
    height: 38,
    borderRadius: 8,
    objectFit: 'cover',
    background: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    border: '1px solid #e2e8f0',
  },
  kindDot: { width: 14, height: 14, borderRadius: '50%', flexShrink: 0 },
  linkBtn: {
    border: 'none',
    background: 'transparent',
    color: 'var(--accent, #b45309)',
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
    padding: '4px 6px',
    flexShrink: 0,
  },
  approve: {
    border: 'none',
    background: '#16a34a',
    color: '#fff',
    fontWeight: 800,
    fontSize: 13.5,
    padding: '10px 16px',
    borderRadius: 10,
    cursor: 'pointer',
    flex: 1,
  },
  reject: {
    border: '1px solid #fca5a5',
    background: '#fff',
    color: '#dc2626',
    fontWeight: 700,
    fontSize: 13.5,
    padding: '10px 16px',
    borderRadius: 10,
    cursor: 'pointer',
  },
  btnPrimary: {
    border: 'none',
    background: 'var(--accent, #f59e0b)',
    color: 'var(--navy, #0f172a)',
    fontWeight: 800,
    fontSize: 14.5,
    padding: '12px 22px',
    borderRadius: 11,
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-block',
  },
}
