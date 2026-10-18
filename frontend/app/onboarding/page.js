'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabase, inMockMode } from '@/lib/supabase'
import { useAuth } from '@/context/auth-context'
import Header from '@/components/Header'
import LiveMap from '@/components/maps/LiveMap'
import { MARKET_CATEGORIES, PRODUCT_ART } from '@/lib/categories'
import { KEJETIA_CENTER } from '@/lib/map-geo'
import { Icon, iconNameFor } from '@/components/icons'
import { uploadProductImages, readMockImages } from '@/lib/media'

const STEPS = [
  { id: 'welcome', num: '01', label: 'Welcome' },
  { id: 'store', num: '02', label: 'Store profile' },
  { id: 'location', num: '03', label: 'Market location' },
  { id: 'products', num: '04', label: 'First products' },
  { id: 'done', num: '05', label: 'You’re live' },
]

const PERKS = [
  { icon: 'storefront', title: 'Your own storefront', desc: 'A clean, organised shop page with categories — just like a mini Jumia.' },
  { icon: 'map', title: 'On the Kejetia map', desc: 'Buyers find you by location and get directions to your stall.' },
  { icon: 'camera', title: 'List products with photos', desc: 'Snap a photo of an item, add a price and it’s online in seconds.' },
  { icon: 'chat', title: 'Talk to customers', desc: 'Shoppers reach you instantly on WhatsApp and in-app chat.' },
]

export default function OnboardingPage() {
  const router = useRouter()
  const { user, profile, loading: authLoading } = useAuth()
  const [step, setStep] = useState('welcome')
  const [existingStore, setExistingStore] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [store, setStore] = useState({
    name: '',
    category: '',
    phone: '',
    whatsapp: '',
    address: 'Kejetia Market, Kumasi',
    description: '',
    operating_hours: 'Mon – Sat · 8:00 AM – 6:00 PM',
    latitude: KEJETIA_CENTER.lat,
    longitude: KEJETIA_CENTER.lng,
  })

  const [products, setProducts] = useState([])
  const fileRef = useRef(null)

  useEffect(() => {
    if (!authLoading && (!user || profile?.role !== 'seller')) {
      router.replace(!user ? '/auth/login' : '/')
    }
  }, [user, profile, authLoading, router])

  useEffect(() => {
    const fetchExisting = async () => {
      if (!user) return
      const sb = getSupabase()
      if (!sb) return
      const { data } = await sb
        .from('stores')
        .select('*')
        .eq('owner_id', user.id)
        .maybeSingle()
      if (data) {
        setExistingStore(data)
        setStore((prev) => ({ ...prev, ...data }))
        setStep('store')
      }
    }
    fetchExisting()
  }, [user])

  const firstName = (profile?.full_name || '').split(' ')[0] || 'there'

  const updateStore = (patch) => setStore((prev) => ({ ...prev, ...patch }))

  // ── Saves the store row (insert or update) and returns its id ──
  const saveStore = async (fields = store) => {
    const sb = getSupabase()
    if (!sb) return null
    const payload = {
      name: fields.name.trim(),
      category: fields.category,
      phone: String(fields.phone || '').trim(),
      whatsapp: String(fields.whatsapp || '').trim() || String(fields.phone || '').trim(),
      address: fields.address.trim(),
      description: String(fields.description || '').trim(),
      operating_hours: String(fields.operating_hours || '').trim(),
      latitude: Number(fields.latitude),
      longitude: Number(fields.longitude),
      icon: MARKET_CATEGORIES.find((c) => c.label === fields.category)?.icon || 'storefront',
      is_active: true,
    }
    if (existingStore?.id) {
      const { error: upErr } = await sb.from('stores').update(payload).eq('id', existingStore.id)
      if (upErr) throw new Error(upErr.message)
      return existingStore.id
    }
    const { data: row, error: inErr } = await sb.from('stores').insert({ ...payload, owner_id: user.id }).select()
    if (inErr) throw new Error(inErr.message)
    return row?.[0]?.id || null
  }

  const goProducts = async (e) => {
    e?.preventDefault()
    if (!store.name.trim()) return setError('Give your store a name to continue.')
    if (!store.category) return setError('Pick the category your store specialises in.')
    if (!store.phone.trim()) return setError('Add a phone number customers can call.')
    setError('')
    setSaving(true)
    try {
      const id = await saveStore()
      if (!id) throw new Error('Store could not be saved — please try again.')
      setExistingStore((prev) => (prev ? prev : { ...store, id }))
      setDraft((prev) => ({ ...prev, category: store.category || prev.category }))
      setStep('products')
    } catch (err) {
      setError(err.message || 'Something went wrong saving your store.')
    } finally {
      setSaving(false)
    }
  }

  // ── Photo handling (Jiji-style) ──
  const onDraftPhotos = async (fileList) => {
    const files = Array.from(fileList || []).slice(0, 3)
    const previews = await readMockImages(files)
    setDraft((prev) => ({
      ...prev,
      files: [...(prev.files || []), ...files].slice(0, 3),
      images: [...prev.images, ...previews].slice(0, 3),
    }))
    if (fileRef.current) fileRef.current.value = ''
  }

  // ── Product draft state ──
  const [draft, setDraft] = useState({
    name: '',
    category: store.category || MARKET_CATEGORIES[0].label,
    price: '',
    old_price: '',
    stock: '',
    description: '',
    icon: 'shopping-bag',
    images: [],
    files: [],
  })
  const [draftError, setDraftError] = useState('')

  const resetDraft = () => {
    setDraft({
      name: '',
      category: store.category || MARKET_CATEGORIES[0].label,
      price: '',
      old_price: '',
      stock: '',
      description: '',
      icon: 'shopping-bag',
      images: [],
      files: [],
    })
    setDraftError('')
  }

  const addProduct = async (e) => {
    e?.preventDefault()
    const price = Number(draft.price)
    const stock = draft.stock === '' || draft.stock == null ? null : Number(draft.stock)
    if (!draft.name.trim()) return setDraftError('Give the item a name.')
    if (!price || price <= 0) return setDraftError('Enter a valid price in GHS.')
    if (stock !== null && (!Number.isFinite(stock) || stock < 0)) return setDraftError('Stock must be 0 or more (blank = plenty).')
    setDraftError('')
    setSaving(true)
    const sb = getSupabase()
    try {
      // Real mode stores ONLY uploaded public URLs (never data-URL previews).
      let images = []
      if (inMockMode()) {
        images = draft.images.length ? draft.images : []
        if (draft.files && draft.files.length) {
          const urls = await uploadProductImages(draft.files, existingStore.id)
          if (urls.length) images = urls
        }
      } else if (draft.files && draft.files.length) {
        images = await uploadProductImages(draft.files, existingStore.id)
      }
      const { error: inErr } = await sb.from('products').insert({
        store_id: existingStore.id,
        name: draft.name.trim(),
        price,
        old_price: draft.old_price ? Number(draft.old_price) : null,
        stock,
        description: String(draft.description || '').trim() || null,
        category: draft.category,
        icon: draft.icon,
        images,
        is_available: true,
      }).select()
      if (inErr) throw new Error(inErr.message)
      setProducts((prev) => [
        {
          id: `local-${Date.now()}`,
          name: draft.name.trim(),
          price,
          old_price: draft.old_price ? Number(draft.old_price) : null,
          stock,
          category: draft.category,
          icon: draft.icon,
          images,
        },
        ...prev,
      ])
      resetDraft()
    } catch (err) {
      setDraftError(err.message || 'Could not add the product.')
    } finally {
      setSaving(false)
    }
  }

  const removeProduct = (id) => setProducts((prev) => prev.filter((p) => p.id !== id))

  const useMyLocation = () => {
    if (!navigator.geolocation) return setError('Geolocation is not supported by your browser.')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        updateStore({ latitude: pos.coords.latitude, longitude: pos.coords.longitude })
        setError('')
      },
      () => setError('Could not read your location. Tap the map to set your pin instead.'),
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  if (authLoading) {
    return <div style={styles.loading}><img src="/logo.svg" alt="Loading..." style={{ height: 32 }} /></div>
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step)
  const stepNum = (id) => STEPS.findIndex((s) => s.id === id)

  return (
    <div style={styles.page}>
      <Header user={user} profile={profile} />
      <div className="ko-ob-wrap">
        <div style={styles.rail} className="ko-ob-rail">
          <div style={styles.railBrand} className="ko-ob-rail-brand">
            <Icon name="storefront" size={16} color="var(--accent-600)" /> Seller onboarding
          </div>
          {STEPS.map((s, i) => {
            const state = i < stepIndex ? 'done' : s.id === step ? 'active' : 'todo'
            return (
              <div key={s.id} className="ko-ob-rail-step" style={{ ...styles.railStep, ...(state === 'active' ? styles.railStepActive : {}) }}>
                <span style={{ ...styles.railDot, ...(state === 'done' ? styles.railDotDone : {}), ...(state === 'active' ? styles.railDotActive : {}) }}>
                  {state === 'done' ? <Icon name="check" size={11} /> : s.num}
                </span>
                <span style={styles.railLabel}>{s.label}</span>
              </div>
            )
          })}
          <div style={styles.railCard} className="ko-ob-rail-card">
            <strong style={styles.railCardTitle}>Did you know?</strong>
            <p style={styles.railCardText}>Stores with a category and photos get up to 3× more visits on the market map.</p>
          </div>
        </div>

        <div style={styles.content} className="ko-ob-content">
          {error && step !== 'products' && (
            <div style={styles.errorBar} onClick={() => setError('')}>
              <Icon name="alert" size={15} color="#b91c1c" />
              <span>{error}</span>
            </div>
          )}

          {/* 01 — WELCOME */}
          {step === 'welcome' && (
            <div style={styles.stepWrap}>
              <div style={styles.welcomeTop}>
                <span style={styles.welcomeIcon}>
                  <Icon name="storefront" size={44} color="var(--accent-700)" />
                </span>
                <h1 style={styles.h1}>Welcome, {firstName}</h1>
                <p style={styles.sub}>Let&apos;s get your business online — you&apos;ll have a clean storefront like the big marketplaces, built around your stall in Kejetia.</p>
              </div>
              <div style={styles.perks}>
                {PERKS.map((perk) => (
                  <div key={perk.title} style={styles.perk}>
                    <span style={styles.perkIcon}>
                      <Icon name={perk.icon} size={21} color="var(--accent-700)" />
                    </span>
                    <div>
                      <strong style={styles.perkTitle}>{perk.title}</strong>
                      <p style={styles.perkDesc}>{perk.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div style={styles.stepActions}>
                <button className="ko-btn ko-btn-accent" style={styles.primaryBtn} onClick={() => setStep('store')}>
                  Start setup
                </button>
              </div>
            </div>
          )}

          {/* 02 — STORE PROFILE */}
          {step === 'store' && (
            <div style={styles.stepWrap}>
              <div style={styles.stepHead}>
                <span style={styles.eyebrow}>Step {stepNum('store') + 1} · {STEPS[stepNum('store')].label}</span>
                <h1 style={styles.h1}>Tell us about your store</h1>
                <p style={styles.sub}>This is the name shoppers will see on the map, in search and on your public page.</p>
              </div>

              {error && <div style={styles.errorBox}>{error}</div>}

              <div style={styles.field}>
                <label style={styles.label}>Store name *</label>
                <input style={styles.input} value={store.name} maxLength={60} placeholder="e.g. Kwame's Phone Palace"
                  onChange={(e) => updateStore({ name: e.target.value })} />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>What do you mainly sell? *</label>
                <div style={styles.catGrid} className="ko-ob-catgrid">
                  {MARKET_CATEGORIES.map((cat) => {
                    const active = store.category === cat.label
                    return (
                      <button key={cat.label} type="button"
                        style={{ ...styles.catChip, ...(active ? styles.catChipActive : {}) }}
                        onClick={() => updateStore({ category: cat.label })}>
                        <span style={styles.catIcon}>
                          <Icon name={cat.icon} size={19} color="var(--accent-700)" />
                        </span>
                        {cat.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div style={styles.twoCol} className="ko-form-2col">
                <div style={styles.field}>
                  <label style={styles.label}>Phone *</label>
                  <input style={styles.input} value={store.phone} placeholder="e.g. 020 123 4567"
                    onChange={(e) => updateStore({ phone: e.target.value })} />
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>WhatsApp</label>
                  <input style={styles.input} value={store.whatsapp} placeholder="Same as phone by default"
                    onChange={(e) => updateStore({ whatsapp: e.target.value })} />
                </div>
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Market address</label>
                <input style={styles.input} value={store.address}
                  onChange={(e) => updateStore({ address: e.target.value })} />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>About your store</label>
                <textarea style={{ ...styles.input, minHeight: 90, resize: 'vertical' }} value={store.description}
                  placeholder="A short pitch — what you sell, quality promise, why buyers should visit."
                  onChange={(e) => updateStore({ description: e.target.value })} />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Opening hours</label>
                <input style={styles.input} value={store.operating_hours}
                  onChange={(e) => updateStore({ operating_hours: e.target.value })} />
              </div>

              <div style={styles.stepActions}>
                <button className="ko-btn ko-btn-accent" style={styles.primaryBtn} onClick={() => setStep('location')}>
                  Continue · set location
                </button>
              </div>
            </div>
          )}

          {/* 03 — LOCATION */}
          {step === 'location' && (
            <div style={styles.stepWrap}>
              <div style={styles.stepHead}>
                <span style={styles.eyebrow}>Step {stepNum('location') + 1} · {STEPS[stepNum('location')].label}</span>
                <h1 style={styles.h1}>Pin your stall on the map</h1>
                <p style={styles.sub}>Buyers will see your exact spot in Kejetia and get directions to you. Tap the map (or the pin button) to place your store pin.</p>
              </div>

              {error && <div style={styles.errorBox}>{error}</div>}

              <div style={styles.mapCard}>
                <LiveMap
                  height={340}
                  center={{ lat: store.latitude, lng: store.longitude }}
                  zoom={17}
                  showLandmarks
                  showUserLocation
                  onLocationPick={({ lat, lng }) => {
                    updateStore({ latitude: lat, longitude: lng })
                    setError('')
                  }}
                  selectedPin={{ lat: store.latitude, lng: store.longitude }}
                />
              </div>                <div style={styles.pinRow}>
                  <div style={styles.pinReadout}>
                    <span style={styles.pinIcon}>
                      <Icon name="map-pin" size={16} color="var(--accent-700)" />
                    </span>
                  <span style={styles.pinText}>
                    {store.latitude.toFixed(5)}, {store.longitude.toFixed(5)}
                  </span>
                </div>
                <button style={styles.ghostBtn} onClick={useMyLocation}>Use my current location</button>
              </div>

              <div style={styles.stepActions}>
                <button style={styles.backBtn} onClick={() => setStep('store')}>← Back</button>
                <button className="ko-btn ko-btn-accent" style={styles.primaryBtn} disabled={saving} onClick={goProducts}>
                  {saving ? 'Saving store…' : 'Save store · add products'}
                </button>
              </div>
            </div>
          )}

          {/* 04 — PRODUCTS */}
          {step === 'products' && (
            <div style={styles.stepWrap}>
              <div style={styles.stepHead}>
                <span style={styles.eyebrow}>Step {stepNum('products') + 1} · {STEPS[stepNum('products')].label}</span>
                <h1 style={styles.h1}>Add your first products</h1>
                <p style={styles.sub}>Take a photo, choose what it looks like, set a price. This is how your catalogue grows — organised by category like a real storefront.</p>
              </div>

              <div style={styles.dashHint}>
                <Icon name="sparkles" size={19} color="#059669" />
                <span><strong>{store.name}</strong> is saved! Add a few best-sellers now — you can always manage more later from your dashboard.</span>
              </div>

              {products.length > 0 && (
                <div style={styles.addedList}>
                  {products.map((p) => (
                    <div key={p.id} style={styles.addedRow}>
                      <span style={styles.addedImg}>{p.images?.[0] ? <img src={p.images[0]} alt={p.name} style={styles.addedThumb} /> : <Icon name={iconNameFor(p)} size={22} color="#94a3b8" />}</span>
                      <div style={styles.addedInfo}>
                        <strong style={styles.addedName}>{p.name}</strong>
                        <span style={styles.addedCat}>{p.category}</span>
                      </div>
                      <span style={styles.addedPrice}>GH₵ {Number(p.price).toLocaleString()}</span>
                      <button style={styles.removeBtn} onClick={() => removeProduct(p.id)} aria-label={`Remove ${p.name}`}>
                        <Icon name="x-close" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={addProduct} style={styles.draftCard}>
                <h3 style={styles.draftTitle}>{draft.images.length || products.length ? 'Add another item' : 'Add your first item'}</h3>
                {draftError && <div style={styles.errorBox}>{draftError}</div>}

                <div style={styles.mediaRow}>
                  {/* Photo area */}
                  <button type="button" style={styles.photoBox} onClick={() => fileRef.current?.click()}>
                    {draft.images.length ? (
                      <>
                        <div style={styles.photoThumbs}>
                          {draft.images.map((img, i) => (
                            <img key={i} src={img} alt={`photo ${i + 1}`} style={styles.photoThumb} onClick={(e) => { e.stopPropagation(); setDraft((d) => ({ ...d, images: d.images.filter((_, j) => j !== i), files: (d.files || []).filter((_, j) => j !== i) })) }} />
                          ))}
                        </div>
                        <span style={styles.photoAddSmall}>＋ Add / edit photos</span>
                      </>
                    ) : (
                      <span style={styles.photoPrompt}>
                        <span style={styles.cameraIcon}>
                          <Icon name="camera" size={30} color="var(--accent-700)" />
                        </span>
                        <strong style={styles.photoTitle}>Take or upload photos</strong>
                        <span style={styles.photoSub}>up to 3 photos · JPG/PNG</span>
                      </span>
                    )}
                  </button>
                  <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => onDraftPhotos(e.target.files)} />
                  {/* Art picker */}
                  <div style={styles.artBox}>
                    <span style={styles.artLabel}>…or pick art for now</span>
                    <div style={styles.artGrid}>
                      {PRODUCT_ART.slice(0, 8).map((art) => (
                        <button key={art.label} type="button" title={art.label}
                          style={{ ...styles.artTile, ...(draft.icon === art.icon ? styles.artTileActive : {}) }}
                          onClick={() => setDraft((d) => ({ ...d, icon: art.icon }))}>
                          <Icon name={art.icon} size={22} color={draft.icon === art.icon ? 'var(--accent-700)' : 'var(--muted)'} />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div style={styles.twoCol} className="ko-form-2col">
                  <div style={styles.field}>
                    <label style={styles.label}>Item name *</label>
                    <input style={styles.input} value={draft.name} placeholder="e.g. iPhone 13 (128GB) — new"
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Category</label>
                    <select style={styles.input} value={draft.category}
                      onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}>
                      {MARKET_CATEGORIES.map((c) => <option key={c.label} value={c.label}>{c.label}</option>)}
                    </select>
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Price (GH₵) *</label>
                    <input style={styles.input} type="number" min="0" step="1" value={draft.price} placeholder="e.g. 1250"
                      onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))} />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Was (optional — shows a % off)</label>
                    <input style={styles.input} type="number" min="0" step="1" value={draft.old_price} placeholder="e.g. 1500"
                      onChange={(e) => setDraft((d) => ({ ...d, old_price: e.target.value }))} />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Stock (qty)</label>
                    <input style={styles.input} type="number" min="0" step="1" value={draft.stock} placeholder="blank = plenty"
                      onChange={(e) => setDraft((d) => ({ ...d, stock: e.target.value }))} />
                  </div>
                </div>

                <div style={styles.field}>
                  <label style={styles.label}>Description</label>
                  <textarea style={{ ...styles.input, minHeight: 80, resize: 'vertical' }} value={draft.description}
                    placeholder="Condition, size, what makes it special…"
                    onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
                </div>

                <button type="submit" className="ko-btn ko-btn-dark" style={styles.addBtn} disabled={saving}>
                  {saving ? 'Adding…' : '＋ Add item'}
                </button>
              </form>

              <div style={styles.stepActions}>
                <button style={styles.backBtn} onClick={() => setStep('location')}>← Back</button>
                <button className="ko-btn ko-btn-accent" style={styles.primaryBtn} onClick={() => setStep('done')}>
                  {products.length ? `Finish — ${products.length} item${products.length > 1 ? 's' : ''} listed` : 'Skip for now →'}
                </button>
              </div>
            </div>
          )}

          {/* 05 — DONE */}
          {step === 'done' && (
            <div style={{ ...styles.stepWrap, textAlign: 'center' }}>
              <span style={styles.doneIcon}>
                <Icon name="sparkles" size={46} color="var(--accent-600)" />
              </span>
              <h1 style={styles.h1}>Your store is live!</h1>
              <p style={styles.sub}><strong style={{ color: 'var(--ink)' }}>{store.name}</strong> is now on the Kejetia map and searchable in Kumasi.</p>

              <div style={styles.doneStats}>
                <div style={styles.doneStat}>
                  <span style={styles.doneStatNum}>{products.length}</span>
                  <span style={styles.doneStatLabel}>Products listed</span>
                </div>
                <div style={styles.doneStat}>
                  <span style={styles.doneStatIcon}>
                    <Icon name="check" size={20} color="#059669" />
                  </span>
                  <span style={styles.doneStatLabel}>Store page live</span>
                </div>
                <div style={styles.doneStat}>
                  <span style={styles.doneStatIcon}>
                    <Icon name="map-pin" size={20} color="var(--accent-700)" />
                  </span>
                  <span style={styles.doneStatLabel}>On the map</span>
                </div>
              </div>

              <div style={styles.doneActions}>
                {existingStore?.id && (
                  <a className="ko-btn ko-btn-dark" style={styles.doneBtn} href={`/store/${existingStore.id}`}>View my store page</a>
                )}
                <button className="ko-btn ko-btn-accent" style={styles.doneBtn} onClick={() => router.replace('/dashboard/seller')}>
                  Go to my dashboard
                </button>
              </div>
              <p style={styles.doneHint}>From the dashboard you can add more products, edit your store and share it on WhatsApp.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--bg)' },
  loading: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' },
  wrap: {
    display: 'grid',
    gridTemplateColumns: '240px minmax(0, 1fr)',
    gap: 28,
    padding: '32px 24px 72px',
    maxWidth: 1120,
    margin: '0 auto',
  },

  /* Rail */
  rail: { display: 'flex', flexDirection: 'column', gap: 4 },
  railBrand: {
    fontSize: 14, fontWeight: 800, color: 'var(--accent-700)', textTransform: 'uppercase',
    letterSpacing: '0.08em', marginBottom: 14, display: 'inline-flex', alignItems: 'center', gap: 8,
  },
  railStep: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 12, opacity: 0.55 },
  railStepActive: { background: '#fff', border: '1px solid var(--border)', opacity: 1, boxShadow: '0 2px 8px rgba(15,23,42,0.06)' },
  railDot: {
    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg)', border: '1.5px solid var(--border)',
    fontSize: 11, fontWeight: 800, color: 'var(--muted)',
  },
  railDotDone: { background: '#059669', borderColor: '#059669', color: '#fff' },
  railDotActive: { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--navy)' },
  railLabel: { fontSize: 14, fontWeight: 700, color: 'var(--ink)' },
  railCard: {
    marginTop: 26, background: 'linear-gradient(150deg, var(--accent) 0%, #fbbf24 100%)',
    borderRadius: 16, padding: 16, color: 'var(--navy)',
  },
  railCardTitle: { fontSize: 14, display: 'block', marginBottom: 6 },
  railCardText: { fontSize: 12.5, lineHeight: 1.55, opacity: 0.9 },

  /* Content card */
  content: { background: '#fff', border: '1px solid var(--border)', borderRadius: 24, boxShadow: '0 14px 44px rgba(15,23,42,0.07)' },
  stepWrap: { maxWidth: 720 },
  welcomeTop: { textAlign: 'center', marginBottom: 30 },
  welcomeIcon: {
    width: 84, height: 84, borderRadius: '50%', margin: '0 auto 16px',
    background: 'var(--accent-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  h1: { fontSize: 32, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.6px', margin: '0 0 10px' },
  sub: { fontSize: 15.5, color: 'var(--muted)', lineHeight: 1.7, margin: 0 },
  stepHead: { marginBottom: 26 },
  eyebrow: { fontSize: 12, fontWeight: 800, color: 'var(--accent-600)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 10 },

  perks: { display: 'grid', gap: 12, marginBottom: 34 },
  perk: { display: 'flex', gap: 14, alignItems: 'flex-start', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', textAlign: 'left' },
  perkIcon: {
    width: 44, height: 44, borderRadius: 13, flexShrink: 0,
    background: '#fff', border: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  perkTitle: { fontSize: 15, color: 'var(--ink)', display: 'block', marginBottom: 2 },
  perkDesc: { fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, margin: 0 },

  field: { marginBottom: 18 },
  label: { display: 'block', fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 7 },
  input: {
    width: '100%', padding: '12px 14px', border: '1.5px solid var(--border)', borderRadius: 12,
    fontSize: 15, background: '#fff', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
    color: 'var(--ink)', transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
  },
  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },

  catGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 },
  catChip: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px',
    background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 12,
    fontSize: 14, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit',
    transition: 'all 0.15s ease', textAlign: 'left',
  },
  catChipActive: { background: 'var(--accent-tint)', borderColor: 'var(--accent)', color: 'var(--accent-700)' },
  catIcon: { display: 'inline-flex', flexShrink: 0 },

  mapCard: { borderRadius: 18, overflow: 'hidden', border: '1px solid var(--border)', marginBottom: 14 },
  pinRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 6 },
  pinReadout: { display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--bg)', borderRadius: 999, padding: '8px 16px' },
  pinIcon: { display: 'inline-flex' },
  pinText: { fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', fontFamily: 'monospace' },
  ghostBtn: {
    background: 'none', border: '1.5px solid var(--border)', color: 'var(--ink)',
    padding: '9px 18px', borderRadius: 999, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  },

  stepActions: { display: 'flex', justifyContent: 'flex-end', gap: 12, alignItems: 'center', marginTop: 30, flexWrap: 'wrap' },
  primaryBtn: { padding: '14px 30px', fontSize: 15.5, borderRadius: 999 },
  backBtn: { background: 'none', border: 'none', color: 'var(--muted)', fontWeight: 700, fontSize: 14.5, cursor: 'pointer', fontFamily: 'inherit' },

  errorBar: {
    background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 12,
    padding: '12px 16px', fontSize: 14, marginBottom: 18, cursor: 'pointer',
    display: 'flex', alignItems: 'flex-start', gap: 9,
  },
  errorBox: { background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 12, padding: '10px 14px', fontSize: 13.5, marginBottom: 16 },

  dashHint: {
    background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0',
    borderRadius: 14, padding: '13px 18px', fontSize: 14.5, marginBottom: 22, lineHeight: 1.6,
    display: 'flex', alignItems: 'flex-start', gap: 10,
  },

  addedList: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 22 },
  addedRow: { display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, padding: 10 },
  addedImg: { width: 44, height: 44, borderRadius: 10, overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' },
  addedThumb: { width: '100%', height: '100%', objectFit: 'cover' },

  addedInfo: { flex: 1, minWidth: 0 },
  addedName: { display: 'block', fontSize: 14, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  addedCat: { fontSize: 12, color: 'var(--accent-700)', fontWeight: 700 },
  addedPrice: { fontSize: 14, fontWeight: 800, color: 'var(--ink)', whiteSpace: 'nowrap' },
  removeBtn: {
    background: 'none', border: 'none', color: 'var(--muted)', fontSize: 15, cursor: 'pointer',
    padding: '4px 8px', display: 'inline-flex', alignItems: 'center',
  },

  draftCard: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 18, padding: '22px 22px 24px' },
  draftTitle: { fontSize: 17, fontWeight: 800, color: 'var(--ink)', margin: '0 0 16px' },
  mediaRow: { display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' },
  photoBox: {
    flex: '1 1 240px', minHeight: 170, borderRadius: 14, cursor: 'pointer', fontFamily: 'inherit',
    background: '#fff', border: '1.5px dashed var(--muted-light)', color: 'var(--muted)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6,
    transition: 'border-color 0.2s ease', padding: 12,
  },
  photoPrompt: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' },
  cameraIcon: {
    width: 58, height: 58, borderRadius: 16, background: 'var(--accent-tint)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 2,
  },
  photoTitle: { fontSize: 14.5, fontWeight: 800, color: 'var(--ink)' },
  photoSub: { fontSize: 12.5, color: 'var(--muted)' },
  photoThumbs: { display: 'flex', gap: 8, marginBottom: 8 },
  photoThumb: { width: 64, height: 64, objectFit: 'cover', borderRadius: 10, cursor: 'pointer' },
  photoAddSmall: { fontSize: 13, fontWeight: 700, color: 'var(--accent-700)' },
  artBox: { flex: '1 1 200px', minHeight: 170, borderRadius: 14, background: '#fff', border: '1.5px solid var(--border)', padding: '12px 14px' },
  artLabel: { fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 8 },
  artGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 },
  artTile: {
    aspectRatio: '1', border: '1px solid var(--border)', borderRadius: 10, background: '#fff',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'all 0.15s ease',
  },
  artTileActive: { borderColor: 'var(--accent)', background: 'var(--accent-tint)', transform: 'scale(1.06)' },
  addBtn: { padding: '13px 26px', borderRadius: 999, fontSize: 15, marginTop: 4 },

  doneIcon: {
    width: 96, height: 96, borderRadius: '50%', margin: '0 auto 16px',
    background: 'var(--accent-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  doneStats: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, margin: '28px 0' },
  doneStat: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 16, padding: '18px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 },
  doneStatNum: { fontSize: 24, fontWeight: 800, color: 'var(--accent-700)' },
  doneStatIcon: { display: 'inline-flex', height: 26 },
  doneStatLabel: { fontSize: 12, color: 'var(--muted)', fontWeight: 600 },
  doneActions: { display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' },
  doneBtn: { padding: '14px 30px', fontSize: 15.5, borderRadius: 999 },
  doneHint: { fontSize: 13, color: 'var(--muted)', marginTop: 18 },
}
