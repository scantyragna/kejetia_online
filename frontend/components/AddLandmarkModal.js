'use client'

import { useRef, useState } from 'react'
import LiveMap from '@/components/maps/LiveMap'
import { getSupabase } from '@/lib/supabase'
import { uploadLandmarkPhoto, readMockImages } from '@/lib/media'
import { KUMASI_CENTER } from '@/lib/map-geo'
import { Icon } from '@/components/icons'

/**
 * Capture a store-front / landmark photo pin.
 * Photo → name → optional link to a store on the platform →
 * drop the pin on the mini map (tap) or use the device location.
 * On save the landmark is published to the public map layer.
 */
export default function AddLandmarkModal({ stores = [], user, onClose, onSaved }) {
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [storeId, setStoreId] = useState('')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [pos, setPos] = useState(null)
  const [locating, setLocating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const fileRef = useRef(null)

  const onFile = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    const urls = await readMockImages([f])
    setPreview(urls[0] || null)
  }

  const useMyLocation = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('Location is not supported by this browser.')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false)
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude })
      },
      () => {
        setLocating(false)
        setError('Could not read your location — tap the map to drop the pin instead.')
      },
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  const save = async () => {
    if (!file) { setError('Add a photo of the store front or landmark.'); return }
    if (!name.trim()) { setError('Give the landmark a name.'); return }
    if (!pos) { setError('Drop the pin on the map first.'); return }

    setSaving(true)
    setError(null)
    try {
      const photoUrl = await uploadLandmarkPhoto(file, user?.id || 'landmark')
      const sb = getSupabase()
      const { error: insertError } = await sb.from('landmarks').insert({
        name: name.trim(),
        notes: notes.trim(),
        category: 'landmark',
        latitude: pos.lat,
        longitude: pos.lng,
        photo_url: photoUrl,
        store_id: storeId || null,
        created_by: user?.id || null,
      })
      if (insertError) {
        setError(insertError.message || 'Could not save the landmark.')
        setSaving(false)
        return
      }
      onSaved()
    } catch (err) {
      setError(err?.message || 'Could not save the landmark.')
      setSaving(false)
    }
  }

  const input = (label, value, onChange, placeholder, extra = {}) => (
    <label style={styles.field}>
      <span style={styles.label}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ ...styles.input, ...extra }}
      />
    </label>
  )

  return (
    <div style={styles.backdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={styles.card} role="dialog" aria-modal="true" aria-label="Add a landmark">
        <div style={styles.head}>
          <div>
            <h3 style={styles.title}>Add a landmark</h3>
            <p style={styles.subtitle}>Photograph a store front or spot — it goes straight to the map.</p>
          </div>
          <button onClick={onClose} style={styles.close} aria-label="Close">
            <Icon name="x-close" size={18} />
          </button>
        </div>

        {/* Photo */}
        <div style={styles.photoRow}>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={styles.photoBox}
            aria-label="Choose or take a photo"
          >
            {preview ? (
              <img src={preview} alt="Landmark preview" style={styles.photoPreview} />
            ) : (
              <span style={styles.photoHint}>
                <Icon name="camera" size={30} color="var(--accent)" />
                <span>Photo of the store front or landmark</span>
              </span>
            )}
            {preview && (
              <span style={styles.photoOverlay}>
                <Icon name="camera" size={15} /> Change
              </span>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onFile}
            style={{ display: 'none' }}
          />
        </div>

        {input('Name', name, setName, 'e.g. Ama’s Fashion Store front, Gate 5, …')}
        {input('Notes (optional)', notes, setNotes, 'Anything helpful — colours, landmarks nearby, directions…')}

        {/* Related store */}
        <label style={styles.field}>
          <span style={styles.label}>Relates to a store on the platform?</span>
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)} style={styles.input}>
            <option value="">— Just a landmark / spot —</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>

        {/* Pin picker */}
        <div style={styles.field}>
          <div style={styles.pinRow}>
            <span style={styles.label}>Drop the pin where it is</span>
            <button type="button" onClick={useMyLocation} style={styles.locateBtn} disabled={locating}>
              <Icon name="map-pin" size={13} /> {locating ? 'Locating…' : 'Use my location'}
            </button>
          </div>
          <div style={styles.miniMap}>
            <LiveMap
              stores={[]}
              height="100%"
              center={{ lat: KUMASI_CENTER.lat, lng: KUMASI_CENTER.lng }}
              zoom={15}
              showUserLocation={false}
              showLandmarks={false}
              onLocationPick={(p) => setPos(p)}
            />
            <span style={styles.miniMapHint}>Tap the map to drop the pin</span>
            {pos && (
              <span style={styles.pinBadge}>
                Pin: {pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}
              </span>
            )}
          </div>
        </div>

        {error && <p style={styles.error}>{error}</p>}

        <div style={styles.foot}>
          <button type="button" onClick={onClose} style={styles.cancel}>Cancel</button>
          <button type="button" onClick={save} style={styles.save} disabled={saving}>
            {saving ? 'Publishing…' : 'Publish to map'}
          </button>
        </div>
      </div>
    </div>
  )
}

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 3000,
    background: 'rgba(10, 15, 28, 0.62)',
    backdropFilter: 'blur(3px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
    overflowY: 'auto',
  },
  card: {
    width: 'min(520px, 100%)',
    maxHeight: '92vh',
    overflowY: 'auto',
    background: '#fff',
    borderRadius: 20,
    padding: 24,
    boxShadow: '0 24px 70px rgba(0,0,0,0.35)',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { margin: 0, fontSize: 20, fontWeight: 800, color: 'var(--navy)' },
  subtitle: { margin: '3px 0 0', fontSize: 13, color: 'var(--muted)' },
  close: {
    border: 'none',
    background: 'var(--bg-soft, #f1f5f9)',
    borderRadius: '50%',
    width: 34,
    height: 34,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    color: 'var(--muted)',
    flexShrink: 0,
  },
  photoRow: { display: 'flex', justifyContent: 'center' },
  photoBox: {
    width: '100%',
    maxWidth: 300,
    aspectRatio: '4 / 3',
    borderRadius: 14,
    border: '2px dashed #cbd5e1',
    background: '#f8fafc',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    position: 'relative',
    overflow: 'hidden',
    padding: 0,
  },
  photoHint: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    color: 'var(--muted)',
    fontSize: 12.5,
    fontWeight: 600,
    padding: 18,
    textAlign: 'center',
  },
  photoPreview: { width: '100%', height: '100%', objectFit: 'cover' },
  photoOverlay: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    background: 'rgba(15, 23, 42, 0.78)',
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
    padding: '6px 12px',
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 12.5, fontWeight: 700, color: 'var(--navy)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  input: {
    border: '1px solid #cbd5e1',
    borderRadius: 11,
    padding: '11px 13px',
    fontSize: 14.5,
    fontFamily: 'inherit',
    background: '#fff',
    color: 'var(--ink)',
    width: '100%',
    boxSizing: 'border-box',
  },
  pinRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 },
  locateBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: '1px solid var(--accent)',
    background: 'rgba(255, 193, 7, 0.12)',
    color: '#b45309',
    fontWeight: 700,
    fontSize: 12.5,
    padding: '7px 13px',
    borderRadius: 999,
    cursor: 'pointer',
  },
  miniMap: { position: 'relative', height: 250, borderRadius: 14, overflow: 'hidden', border: '1px solid #e2e8f0' },
  miniMapHint: {
    position: 'absolute',
    top: 10,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(15, 23, 42, 0.82)',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 14px',
    borderRadius: 999,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    zIndex: 1200,
  },
  pinBadge: {
    position: 'absolute',
    bottom: 10,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(13, 124, 62, 0.95)',
    color: '#fff',
    fontSize: 11.5,
    fontWeight: 700,
    padding: '5px 12px',
    borderRadius: 999,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    zIndex: 1200,
    fontFamily: 'ui-monospace, monospace',
  },
  error: { margin: 0, fontSize: 13, color: '#dc2626', fontWeight: 600, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '9px 12px' },
  foot: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  cancel: {
    border: '1px solid #cbd5e1',
    background: '#fff',
    color: 'var(--muted)',
    fontWeight: 700,
    fontSize: 14,
    padding: '10px 20px',
    borderRadius: 11,
    cursor: 'pointer',
  },
  save: {
    border: 'none',
    background: 'var(--accent)',
    color: 'var(--navy)',
    fontWeight: 800,
    fontSize: 14,
    padding: '10px 22px',
    borderRadius: 11,
    cursor: 'pointer',
  },
}
