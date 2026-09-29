'use client'

// Seller dashboard — simple modern store manager (mobile-first).
//
//   • Profile card: avatar upload (avatars bucket → profiles.avatar_url)
//   • Store card: store-front photo (store-images bucket → stores.image_url),
//     name/category/contact/hours, tap-the-map pin, always saves is_active=true
//     so new visitors actually see the store (homepage filters is_active).
//   • Products: Jumia-minted white tiles (ProductImage, contain-fit) — photos
//     can never overflow their box. Add form + live list with stock editors.
//   • Visibility banner: mock mode = "only you see this"; postgres = "live".

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabase, inMockMode } from '@/lib/supabase'
import { useAuth } from '@/context/auth-context'
import Header from '@/components/Header'
import LiveMap from '@/components/maps/LiveMap'
import ProductImage from '@/components/ProductImage'
import { MARKET_CATEGORIES, PRODUCT_ART } from '@/lib/categories'
import { KEJETIA_CENTER } from '@/lib/map-geo'
import { stockCount, stockLabel, discountPct } from '@/lib/products'
import { Icon, iconNameFor } from '@/components/icons'
import { uploadProductImages, readMockImages, uploadAvatar, uploadStorePhoto } from '@/lib/media'

const emptyProduct = (storeCategory) => ({
  name: '',
  category: storeCategory || MARKET_CATEGORIES[0].label,
  price: '',
  old_price: '',
  stock: '',
  description: '',
  icon: 'shopping-bag',
  images: [],
  files: [],
})

export default function SellerDashboard() {
  const { user, profile, loading, signOut } = useAuth()
  const router = useRouter()
  const fileRef = useRef(null)
  const avatarRef = useRef(null)
  const storePhotoRef = useRef(null)

  const [store, setStore] = useState(null)
  const [products, setProducts] = useState([])
  const [busy, setBusy] = useState(true)

  const [tab, setTab] = useState('products') // products | store | profile
  const [storeForm, setStoreForm] = useState(null)
  const [storePhotoFile, setStorePhotoFile] = useState(null)
  const [storePhotoPreview, setStorePhotoPreview] = useState(null)
  const [savingStore, setSavingStore] = useState(false)

  const [profileForm, setProfileForm] = useState({ full_name: '', phone: '' })
  const [avatarPreview, setAvatarPreview] = useState(null)
  const [avatarFile, setAvatarFile] = useState(null)
  const [savingProfile, setSavingProfile] = useState(false)

  const [productOpen, setProductOpen] = useState(false)
  const [draft, setDraft] = useState(emptyProduct(''))
  const [savingProduct, setSavingProduct] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (loading) return
    if (!user) { router.replace('/auth/login'); return }
    if (profile?.role !== 'seller') { router.replace('/'); return }

    const load = async () => {
      const sb = getSupabase()
      if (!sb) { setBusy(false); return }
      const { data: storeData } = await sb
        .from('stores')
        .select('*')
        .eq('owner_id', user.id)
        .maybeSingle()

      if (!storeData) { router.replace('/onboarding'); return }

      setStore(storeData)
      setStoreForm({ ...defaultsFrom(storeData), ...storeData })
      setStorePhotoPreview(storeData.image_url || null)
      setProfileForm({
        full_name: profile?.full_name || '',
        phone: profile?.phone || '',
      })
      setAvatarPreview(profile?.avatar_url || null)

      const { data: productRows } = await sb
        .from('products')
        .select('*')
        .eq('store_id', storeData.id)
        .order('created_at', { ascending: false })
      setProducts(productRows || [])
      setBusy(false)
    }
    load()
  }, [user, profile, loading, router])

  // Keep profile form in sync once auth resolves late.
  useEffect(() => {
    if (profile) {
      setProfileForm((p) => ({
        full_name: p.full_name || profile.full_name || '',
        phone: p.phone || profile.phone || '',
      }))
      if (profile.avatar_url) setAvatarPreview((v) => v || profile.avatar_url)
    }
  }, [profile])

  const onPhotos = async (fileList) => {
    const files = Array.from(fileList || []).slice(0, 3)
    const previews = await readMockImages(files)
    setDraft((d) => ({
      ...d,
      files: [...(d.files || []), ...files].slice(0, 3),
      images: [...d.images, ...previews].slice(0, 3),
    }))
    if (fileRef.current) fileRef.current.value = ''
  }

  const onAvatar = async (fileList) => {
    const f = fileList?.[0]
    if (!f) return
    setAvatarFile(f)
    const urls = await readMockImages([f])
    setAvatarPreview(urls[0] || null)
  }

  const onStorePhoto = async (fileList) => {
    const f = fileList?.[0]
    if (!f) return
    setStorePhotoFile(f)
    const urls = await readMockImages([f])
    setStorePhotoPreview(urls[0] || null)
  }

  // ── Store save (always public) ──
  const handleSaveStore = async (e) => {
    e?.preventDefault()
    if (!storeForm?.name.trim()) return setError('Store name is required.')
    if (!storeForm?.category) return setError('Choose your store category.')
    setSavingStore(true)
    setError('')
    try {
      const sb = getSupabase()
      let imageUrl = storeForm.image_url || null
      if (storePhotoFile) {
        const uploaded = await uploadStorePhoto(storePhotoFile, store.id)
        if (uploaded) imageUrl = uploaded
      }
      const payload = {
        name: storeForm.name.trim(),
        phone: String(storeForm.phone || '').trim(),
        whatsapp: String(storeForm.whatsapp || '').trim() || String(storeForm.phone || '').trim(),
        address: String(storeForm.address || '').trim(),
        description: String(storeForm.description || '').trim(),
        operating_hours: String(storeForm.operating_hours || '').trim(),
        latitude: Number(storeForm.latitude),
        longitude: Number(storeForm.longitude),
        category: storeForm.category,
        icon: MARKET_CATEGORIES.find((c) => c.label === storeForm.category)?.icon || 'storefront',
        image_url: imageUrl,
        is_active: true,
      }
      const { error: err } = await sb.from('stores').update(payload).eq('id', store.id)
      if (err) throw err
      setStore((prev) => ({ ...prev, ...payload }))
      setStoreForm((prev) => ({ ...prev, ...payload }))
      setStorePhotoFile(null)
      setError('')
    } catch (err) {
      setError(err.message || 'Could not save store.')
    } finally {
      setSavingStore(false)
    }
  }

  // ── Profile save (avatar) ──
  const handleSaveProfile = async (e) => {
    e?.preventDefault()
    setSavingProfile(true)
    setError('')
    try {
      const sb = getSupabase()
      let avatarUrl = profile?.avatar_url || null
      if (avatarFile) {
        const uploaded = await uploadAvatar(avatarFile, user.id)
        if (uploaded) avatarUrl = uploaded
      }
      const payload = {
        full_name: String(profileForm.full_name || '').trim(),
        phone: String(profileForm.phone || '').trim(),
        avatar_url: avatarUrl,
      }
      const { error: err } = await sb.from('profiles').update(payload).eq('id', user.id)
      if (err) throw err
      setAvatarFile(null)
      setAvatarPreview(avatarUrl)
    } catch (err) {
      setError(err.message || 'Could not save profile.')
    } finally {
      setSavingProfile(false)
    }
  }

  // ── Products ──
  const handleAddProduct = async (e) => {
    e.preventDefault()
    const price = Number(draft.price)
    const stock = draft.stock === '' || draft.stock == null ? null : Number(draft.stock)
    if (!draft.name.trim()) return setError('Give the item a name.')
    if (!price || price <= 0) return setError('Enter a valid price in GHS.')
    if (stock !== null && (!Number.isFinite(stock) || stock < 0)) return setError('Stock must be 0 or more (blank = plenty).')
    setSavingProduct(true)
    setError('')
    const sb = getSupabase()
    let images = []
    if (inMockMode()) {
      images = draft.images.length ? draft.images : []
      if (draft.files && draft.files.length) {
        const urls = await uploadProductImages(draft.files, store.id)
        if (urls.length) images = urls
      }
    } else if (draft.files && draft.files.length) {
      images = await uploadProductImages(draft.files, store.id)
    }
    const { data: row, error: err } = await sb.from('products').insert({
      store_id: store.id,
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
    setSavingProduct(false)
    if (err) return setError(err.message)
    setProducts((prev) => [(row?.[0] || { ...draft, images }), ...prev].map((p, i) => ({ ...p, id: p.id || `local-${Date.now()}-${i}` })))
    setDraft(emptyProduct(draft.category))
    setProductOpen(false)
  }

  const updateStock = async (p, stock) => {
    const sb = getSupabase()
    const { error: err } = await sb.from('products').update({ stock }).eq('id', p.id)
    if (err) return setError(err.message)
    setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, stock } : x)))
  }

  const updateWasPrice = async (p, oldPrice) => {
    const sb = getSupabase()
    const { error: err } = await sb.from('products').update({ old_price: oldPrice }).eq('id', p.id)
    if (err) return setError(err.message)
    setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, old_price: oldPrice } : x)))
  }

  const toggleProduct = async (p) => {
    const sb = getSupabase()
    const { error: err } = await sb.from('products').update({ is_available: !p.is_available }).eq('id', p.id)
    if (err) return setError(err.message)
    setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, is_available: !x.is_available } : x)))
  }

  const deleteProduct = async (p) => {
    if (!window.confirm(`Remove “${p.name}” from your store?`)) return
    const sb = getSupabase()
    const { error: err } = await sb.from('products').delete().eq('id', p.id)
    if (err) return setError(err.message)
    setProducts((prev) => prev.filter((x) => x.id !== p.id))
  }

  if (loading || busy) {
    return <div style={styles.loading}><img src="/logo.svg" alt="Loading..." style={{ height: 32 }} /></div>
  }

  const firstName = (profile?.full_name || user?.email || 'Seller').split('@')[0].split(' ')[0]
  const liveCount = products.filter((p) => p.is_available !== false).length
  const outCount = products.filter((p) => stockCount(p) === 0).length
  const mock = inMockMode()

  return (
    <div style={styles.page}>
      <Header user={user} profile={profile} onSignOut={signOut} />

      <div className="container ko-dash-content" style={styles.content}>
        {/* Hero */}
        <div style={styles.hero} className="ko-dash-top">
          <button type="button" onClick={() => avatarRef.current?.click()} style={styles.avatarBtn} title="Upload profile photo">
            {avatarPreview ? (
              <img src={avatarPreview} alt="Profile" style={styles.avatarImg} />
            ) : (
              <span style={styles.avatarFallback}>{(profileForm.full_name || firstName || 'S').charAt(0).toUpperCase()}</span>
            )}
            <span style={styles.avatarBadge}><Icon name="camera" size={12} /></span>
          </button>
          <input ref={avatarRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => onAvatar(e.target.files)} />
          <div style={styles.heroText}>
            <p style={styles.eyebrow}>Seller dashboard</p>
            <h1 style={styles.title}>Hi, {firstName}</h1>
            <p style={styles.subtitle}>{store.name} · {liveCount} live · {outCount} out of stock</p>
          </div>
          <div style={styles.heroActions} className="ko-dash-actions">
            <a className="ko-btn ko-btn-dark" style={styles.viewBtn} href={`/store/${store.id}`}>View store</a>
            <button className="ko-btn ko-btn-accent" style={styles.addBtn} onClick={() => { setTab('products'); setProductOpen(true); setError('') }}>＋ Add item</button>
          </div>
        </div>

        {/* Visibility: why new visitors do / don't see the store */}
        {mock ? (
          <div style={styles.warnBar}>
            <Icon name="alert" size={15} color="#b45309" />
            <span><strong>Preview only.</strong> This device is in offline demo mode — new visitors can’t see this store yet. Deploy with <code>postgres</code> mode to go live.</span>
          </div>
        ) : (
          <div style={styles.liveBar}>
            <Icon name="check" size={15} color="#059669" />
            <span><strong>Live storefront.</strong> New visitors see this store at <a href={`/store/${store.id}`} style={styles.liveLink}>your public page</a>.</span>
          </div>
        )}

        {error && (
          <div style={styles.errorBar} onClick={() => setError('')}>
            <Icon name="alert" size={15} color="#b91c1c" />
            <span>{error}</span>
          </div>
        )}

        {/* Tabs */}
        <div style={styles.tabs} className="ko-dash-tabs" role="tablist" aria-label="Dashboard sections">
          {[['products', `Items (${products.length})`], ['store', 'Store'], ['profile', 'Profile']].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setError('') }}
              style={{ ...styles.tab, ...(tab === id ? styles.tabActive : {}) }}>{label}</button>
          ))}
        </div>

        {tab === 'products' && (
          <section style={styles.card}>
            <div style={styles.cardHead}>
              <h2 style={styles.cardTitle}>Items</h2>
              <button className="ko-btn ko-btn-dark" style={styles.smallBtn} onClick={() => setProductOpen((v) => !v)}>
                {productOpen ? 'Close' : '＋ Add item'}
              </button>
            </div>

            {productOpen && (
              <form onSubmit={handleAddProduct} style={styles.productForm}>
                <div className="ko-media-row" style={styles.mediaRow}>
                  <button type="button" style={styles.photoBox} onClick={() => fileRef.current?.click()}>
                    {draft.images.length ? (
                      <>
                        <div style={styles.photoThumbs}>
                          {draft.images.map((img, i) => (
                            <span key={i} style={styles.mintThumb} onClick={(e) => { e.stopPropagation(); setDraft((d) => ({ ...d, images: d.images.filter((_, j) => j !== i), files: (d.files || []).filter((_, j) => j !== i) })) }}>
                              <ProductImage src={img} alt={`photo ${i + 1}`} />
                            </span>
                          ))}
                        </div>
                        <span style={styles.photoAddSmall}>Tap a photo to remove · up to 3</span>
                      </>
                    ) : (
                      <span style={styles.photoPrompt}>
                        <span style={styles.cameraIcon}><Icon name="camera" size={24} color="var(--accent-700)" /></span>
                        <strong style={styles.photoTitle}>Add photos</strong>
                        <span style={styles.photoSub}>up to 3 · auto-minted white</span>
                      </span>
                    )}
                  </button>
                  <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => onPhotos(e.target.files)} />
                  <div style={styles.artBox}>
                    <span style={styles.artLabel}>Or pick art</span>
                    <div style={styles.artGrid}>
                      {PRODUCT_ART.slice(0, 8).map((art) => (
                        <button key={art.label} type="button" title={art.label}
                          style={{ ...styles.artTile, ...(draft.icon === art.icon ? styles.artTileActive : {}) }}
                          onClick={() => setDraft((d) => ({ ...d, icon: art.icon }))}>
                          <Icon name={art.icon} size={18} color={draft.icon === art.icon ? 'var(--accent-700)' : 'var(--muted)'} />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div style={styles.formGrid} className="ko-form-2col">
                  <div style={styles.field}>
                    <label style={styles.label}>Item name *</label>
                    <input style={styles.input} value={draft.name} placeholder="e.g. Nokia 105 — brand new"
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Category</label>
                    <select style={styles.input} value={draft.category}
                      onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                      {MARKET_CATEGORIES.map((c) => <option key={c.label} value={c.label}>{c.label}</option>)}
                    </select>
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Price (GH₵) *</label>
                    <input style={styles.input} type="number" min="0" step="1" value={draft.price}
                      onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Was (optional)</label>
                    <input style={styles.input} type="number" min="0" step="1" value={draft.old_price}
                      onChange={(e) => setDraft({ ...draft, old_price: e.target.value })} />
                  </div>
                  <div style={styles.field}>
                    <label style={styles.label}>Stock (qty)</label>
                    <input style={styles.input} type="number" min="0" step="1" value={draft.stock} placeholder="blank = plenty"
                      onChange={(e) => setDraft({ ...draft, stock: e.target.value })} />
                  </div>
                </div>

                <div style={styles.field}>
                  <label style={styles.label}>Description</label>
                  <textarea style={{ ...styles.input, minHeight: 70, resize: 'vertical' }} value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </div>

                <button type="submit" className="ko-btn ko-btn-accent" style={styles.saveBtn} disabled={savingProduct}>
                  {savingProduct ? 'Adding…' : 'Add item'}
                </button>
              </form>
            )}

            {products.length === 0 && !productOpen ? (
              <div style={styles.emptyBox}>
                <Icon name="box" size={36} color="var(--muted-light)" />
                <p style={styles.emptyText}>No items yet. Add your first item — photo + price — and it appears on your public page instantly.</p>
                <button className="ko-btn ko-btn-accent" style={styles.emptyBtn} onClick={() => setProductOpen(true)}>Add your first item</button>
              </div>
            ) : (
              <div style={styles.itemGrid}>
                {products.map((p) => {
                  const price = Number(p.price)
                  const out = stockCount(p) === 0
                  return (
                    <div key={p.id} className="ko-pimg-zoom" style={{ ...styles.itemCard, ...(p.is_available === false ? styles.itemHidden : {}) }}>
                      <div style={styles.itemMint}>
                        <ProductImage row={p} alt={p.name} />
                        {discountPct(p) ? <span style={styles.dealBadge}>-{discountPct(p)}%</span> : null}
                        {stockLabel(p) ? <span style={{ ...styles.stockChip, ...(out ? styles.stockChipOut : {}) }}>{stockLabel(p)}</span> : null}
                      </div>
                      <div style={styles.itemBody}>
                        <strong style={styles.itemName}>{p.name}</strong>
                        <span style={styles.itemMeta}>GH₵ {price.toLocaleString()} · {p.category || 'General'}</span>
                        <div style={styles.itemEditors}>
                          <WasPriceEditor value={p.old_price} onSave={(v) => updateWasPrice(p, v)} />
                          <StockEditor value={p.stock} onSave={(v) => updateStock(p, v)} />
                        </div>
                        <div style={styles.itemActions}>
                          <button style={{ ...styles.toggleBtn, ...(p.is_available === false ? styles.toggleOff : {}) }} onClick={() => toggleProduct(p)}>
                            {p.is_available === false ? 'Show' : 'Live'}
                          </button>
                          <button style={styles.deleteBtn} onClick={() => deleteProduct(p)} title="Delete item">
                            <Icon name="trash" size={15} color="#b91c1c" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )}

        {tab === 'store' && (
          <section style={styles.card}>
            <div style={styles.cardHead}>
              <h2 style={styles.cardTitle}>Store</h2>
              <a className="ko-btn ko-btn-dark" style={styles.smallBtn} href={`/store/${store.id}`}>Public page</a>
            </div>
            <form onSubmit={handleSaveStore}>
              <button type="button" onClick={() => storePhotoRef.current?.click()} style={styles.storePhotoBtn} title="Upload store-front photo">
                {storePhotoPreview ? (
                  <img src={storePhotoPreview} alt="Store" style={styles.storePhotoImg} />
                ) : (
                  <span style={styles.storePhotoHint}>
                    <Icon name="camera" size={26} color="var(--accent-700)" />
                    <strong>Add store-front photo</strong>
                    <span>white-minted, shown on your public page</span>
                  </span>
                )}
                <span style={styles.photoChange}>Change photo</span>
              </button>
              <input ref={storePhotoRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => onStorePhoto(e.target.files)} />

              <div style={styles.formGrid} className="ko-form-2col">
                <div style={styles.field}>
                  <label style={styles.label}>Store name *</label>
                  <input style={styles.input} value={storeForm?.name || ''} onChange={(e) => setStoreForm({ ...storeForm, name: e.target.value })} />
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Phone *</label>
                  <input style={styles.input} value={storeForm?.phone || ''} onChange={(e) => setStoreForm({ ...storeForm, phone: e.target.value })} />
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>WhatsApp</label>
                  <input style={styles.input} value={storeForm?.whatsapp || ''} onChange={(e) => setStoreForm({ ...storeForm, whatsapp: e.target.value })} />
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Address</label>
                  <input style={styles.input} value={storeForm?.address || ''} onChange={(e) => setStoreForm({ ...storeForm, address: e.target.value })} />
                </div>
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Category</label>
                <div style={styles.catGrid} className="ko-ob-catgrid">
                  {MARKET_CATEGORIES.map((cat) => (
                    <button key={cat.label} type="button"
                      style={{ ...styles.catChip, ...(storeForm?.category === cat.label ? styles.catChipActive : {}) }}
                      onClick={() => setStoreForm({ ...storeForm, category: cat.label })}>
                      <Icon name={cat.icon} size={16} color="var(--accent-700)" /> {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={styles.field}>
                <label style={styles.label}>About</label>
                <textarea style={{ ...styles.input, minHeight: 84, resize: 'vertical' }} value={storeForm?.description || ''}
                  onChange={(e) => setStoreForm({ ...storeForm, description: e.target.value })} />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Opening hours</label>
                <input style={styles.input} value={storeForm?.operating_hours || ''}
                  onChange={(e) => setStoreForm({ ...storeForm, operating_hours: e.target.value })} />
              </div>

              <div style={styles.mapWrap}>
                <LiveMap
                  height={260}
                  center={{ lat: Number(storeForm?.latitude || KEJETIA_CENTER.lat), lng: Number(storeForm?.longitude || KEJETIA_CENTER.lng) }}
                  zoom={16}
                  showUserLocation
                  onLocationPick={({ lat, lng }) => setStoreForm({ ...storeForm, latitude: lat, longitude: lng })}
                  selectedPin={storeForm?.latitude != null ? { lat: Number(storeForm.latitude), lng: Number(storeForm.longitude) } : null}
                />
                <p style={styles.mapHint}><Icon name="map-pin" size={13} color="var(--muted)" /> Tap the map to move your store pin.</p>
              </div>

              <button type="submit" className="ko-btn ko-btn-accent" style={styles.saveBtn} disabled={savingStore}>
                {savingStore ? 'Saving…' : 'Save store'}
              </button>
            </form>
          </section>
        )}

        {tab === 'profile' && (
          <section style={styles.card}>
            <div style={styles.cardHead}>
              <h2 style={styles.cardTitle}>Profile</h2>
            </div>
            <form onSubmit={handleSaveProfile}>
              <div style={styles.profileRow}>
                <button type="button" onClick={() => avatarRef.current?.click()} style={styles.avatarBtn} title="Upload profile photo">
                  {avatarPreview ? (
                    <img src={avatarPreview} alt="Profile" style={styles.avatarImg} />
                  ) : (
                    <span style={styles.avatarFallback}>{(profileForm.full_name || firstName || 'S').charAt(0).toUpperCase()}</span>
                  )}
                  <span style={styles.avatarBadge}><Icon name="camera" size={12} /></span>
                </button>
                <div style={styles.profileHint}>
                  <strong>Profile photo</strong>
                  <span>Tap to upload · square white-minted</span>
                </div>
              </div>
              <div style={styles.formGrid} className="ko-form-2col">
                <div style={styles.field}>
                  <label style={styles.label}>Full name</label>
                  <input style={styles.input} value={profileForm.full_name} onChange={(e) => setProfileForm({ ...profileForm, full_name: e.target.value })} />
                </div>
                <div style={styles.field}>
                  <label style={styles.label}>Phone</label>
                  <input style={styles.input} value={profileForm.phone} onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })} />
                </div>
              </div>
              <button type="submit" className="ko-btn ko-btn-accent" style={styles.saveBtn} disabled={savingProfile}>
                {savingProfile ? 'Saving…' : 'Save profile'}
              </button>
            </form>
          </section>
        )}
      </div>
    </div>
  )
}

function StockEditor({ value, onSave }) {
  const [val, setVal] = useState(value ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setVal(value ?? '') }, [value])
  const commit = async () => {
    const next = val === '' ? null : Number(val)
    if (next === value) return
    setBusy(true)
    await onSave(next)
    setBusy(false)
  }
  return (
    <input type="number" min="0" step="1" value={val} disabled={busy} title="Stock — blank = plenty"
      aria-label="Stock quantity" style={styles.stockEditor}
      onChange={(e) => setVal(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
  )
}

function WasPriceEditor({ value, onSave }) {
  const [val, setVal] = useState(value ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setVal(value ?? '') }, [value])
  const commit = async () => {
    const raw = val === '' || val == null ? null : Number(val)
    const next = raw !== null && Number.isFinite(raw) && raw > 0 ? raw : null
    const current = value === '' || value == null ? null : Number(value)
    if (next === current) return
    setBusy(true)
    await onSave(next)
    setBusy(false)
  }
  return (
    <input type="number" min="0" step="1" value={val} disabled={busy} placeholder="Was"
      title="Was price — higher than price shows a sale badge" aria-label="Was price" style={styles.wasEditor}
      onChange={(e) => setVal(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
  )
}

function defaultsFrom(storeData) {
  return {
    name: storeData?.name || '',
    category: storeData?.category || '',
    phone: storeData?.phone || '',
    whatsapp: storeData?.whatsapp || '',
    address: storeData?.address || 'Kejetia Market, Kumasi',
    description: storeData?.description || '',
    operating_hours: storeData?.operating_hours || '',
    latitude: storeData?.latitude || KEJETIA_CENTER.lat,
    longitude: storeData?.longitude || KEJETIA_CENTER.lng,
    image_url: storeData?.image_url || null,
  }
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--bg)' },
  loading: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' },
  content: { padding: '24px 16px 72px', maxWidth: 1080 },
  hero: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 14 },
  avatarBtn: {
    position: 'relative', width: 64, height: 64, borderRadius: '50%', border: '2px solid #fff',
    background: 'var(--navy)', cursor: 'pointer', overflow: 'visible', padding: 0, flexShrink: 0,
    boxShadow: '0 4px 14px rgba(15,23,42,0.2)',
  },
  avatarImg: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%', display: 'block', background: '#fff' },
  avatarFallback: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', borderRadius: '50%', color: '#fff', fontSize: 24, fontWeight: 800 },
  avatarBadge: {
    position: 'absolute', right: -2, bottom: -2, width: 22, height: 22, borderRadius: '50%',
    background: 'var(--accent)', color: 'var(--navy)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: '2px solid #fff',
  },
  heroText: { flex: '1 1 200px', minWidth: 0 },
  eyebrow: { fontSize: 11, fontWeight: 800, color: 'var(--accent-600)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 },
  title: { fontSize: 24, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.4px', margin: 0 },
  subtitle: { fontSize: 13.5, color: 'var(--muted)', margin: '4px 0 0' },
  heroActions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  viewBtn: { padding: '10px 18px', fontSize: 13.5, borderRadius: 999 },
  addBtn: { padding: '10px 18px', fontSize: 13.5, borderRadius: 999 },
  warnBar: { background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: 12, padding: '12px 14px', fontSize: 13.5, marginBottom: 14, display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.5 },
  liveBar: { background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0', borderRadius: 12, padding: '12px 14px', fontSize: 13.5, marginBottom: 14, display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.5 },
  liveLink: { color: '#059669', fontWeight: 800 },
  errorBar: { background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 12, padding: '12px 14px', fontSize: 13.5, marginBottom: 14, cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'flex-start' },
  tabs: { display: 'flex', gap: 6, background: '#fff', border: '1px solid var(--border)', borderRadius: 999, padding: 4, marginBottom: 16, overflowX: 'auto' },
  tab: { flex: 1, border: 'none', background: 'transparent', borderRadius: 999, padding: '10px 12px', fontSize: 13.5, fontWeight: 700, color: 'var(--muted)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', minWidth: 0 },
  tabActive: { background: 'var(--navy)', color: '#fff' },
  card: { background: '#fff', border: '1px solid var(--border)', borderRadius: 16, padding: 16, boxShadow: '0 2px 10px rgba(15,23,42,0.04)' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' },
  cardTitle: { fontSize: 17, fontWeight: 800, color: 'var(--ink)', margin: 0 },
  smallBtn: { padding: '8px 16px', fontSize: 13, borderRadius: 999 },
  productForm: { border: '1px dashed var(--muted-light)', borderRadius: 14, padding: 14, marginBottom: 16, background: 'var(--bg)' },
  mediaRow: { display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' },
  photoBox: { flex: '1 1 200px', minHeight: 120, borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit', background: '#fff', border: '1.5px dashed var(--muted-light)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 10 },
  photoPrompt: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center' },
  cameraIcon: { width: 48, height: 48, borderRadius: 12, background: 'var(--accent-tint)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  photoTitle: { fontSize: 13, fontWeight: 800, color: 'var(--ink)' },
  photoSub: { fontSize: 11.5, color: 'var(--muted)' },
  photoThumbs: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  mintThumb: { width: 84, height: 84, borderRadius: 10, overflow: 'hidden', background: '#fff', border: '1px solid var(--border)', cursor: 'pointer', display: 'block' },
  photoAddSmall: { fontSize: 12, fontWeight: 700, color: 'var(--accent-700)', marginTop: 6 },
  artBox: { flex: '1 1 160px', borderRadius: 12, background: '#fff', border: '1.5px solid var(--border)', padding: 10 },
  artLabel: { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 },
  artGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 },
  artTile: { aspectRatio: '1', border: '1px solid var(--border)', borderRadius: 9, background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  artTileActive: { borderColor: 'var(--accent)', background: 'var(--accent-tint)' },
  formGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  field: { marginBottom: 12 },
  label: { display: 'block', fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 },
  input: { width: '100%', padding: '11px 13px', border: '1.5px solid var(--border)', borderRadius: 10, fontSize: 16, background: '#fff', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', color: 'var(--ink)' },
  catGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 },
  catChip: { display: 'flex', alignItems: 'center', gap: 7, padding: '9px 12px', background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 10, fontSize: 13, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  catChipActive: { background: 'var(--accent-tint)', borderColor: 'var(--accent)', color: 'var(--accent-700)' },
  mapWrap: { borderRadius: 14, overflow: 'hidden', border: '1px solid var(--border)', margin: '6px 0 12px' },
  mapHint: { fontSize: 12.5, color: 'var(--muted)', marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6 },
  saveBtn: { padding: '12px 26px', fontSize: 14.5, borderRadius: 999, width: '100%' },
  emptyBox: { textAlign: 'center', padding: '30px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 },
  emptyText: { fontSize: 13.5, color: 'var(--muted)', maxWidth: 320, lineHeight: 1.6 },
  emptyBtn: { padding: '10px 22px', fontSize: 13.5, borderRadius: 999 },
  itemGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 },
  itemCard: { background: '#fff', border: '1px solid #f1f5f9', borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' },
  itemHidden: { opacity: 0.55 },
  itemMint: { position: 'relative', background: '#fff' },
  dealBadge: { position: 'absolute', top: 8, right: 8, background: '#fef3e2', color: '#f68b1e', fontSize: 12, fontWeight: 800, padding: '3px 8px', borderRadius: 4, zIndex: 2 },
  stockChip: { position: 'absolute', bottom: 8, left: 8, background: 'rgba(15,23,42,0.82)', color: '#fff', fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4, zIndex: 2 },
  stockChipOut: { background: 'rgba(185,28,28,0.92)' },
  itemBody: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4, flex: 1 },
  itemName: { display: 'block', fontSize: 13.5, color: '#282828', fontWeight: 400, lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', minHeight: 38 },
  itemMeta: { fontSize: 12, color: '#75757a' },
  itemEditors: { display: 'flex', gap: 6 },
  itemActions: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 },
  stockEditor: { flex: 1, minWidth: 0, padding: '8px 10px', border: '1.5px solid var(--border)', borderRadius: 9, fontSize: 16, fontWeight: 700, background: '#fff', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', color: 'var(--ink)', textAlign: 'center' },
  wasEditor: { flex: 1, minWidth: 0, padding: '8px 10px', border: '1.5px solid var(--border)', borderRadius: 9, fontSize: 16, fontWeight: 700, background: '#fff', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', color: 'var(--ink)', textAlign: 'center' },
  toggleBtn: { flex: 1, background: '#ecfdf5', color: '#059669', border: '1px solid #a7f3d0', fontSize: 12, fontWeight: 800, padding: '8px 10px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit' },
  toggleOff: { background: 'var(--bg)', color: 'var(--muted)', borderColor: 'var(--border)' },
  deleteBtn: { background: 'none', border: 'none', cursor: 'pointer', padding: 8, display: 'inline-flex' },
  storePhotoBtn: { position: 'relative', width: '100%', borderRadius: 14, overflow: 'hidden', border: '1.5px dashed var(--muted-light)', background: '#f8fafc', cursor: 'pointer', padding: 0, marginBottom: 14, minHeight: 160, display: 'block' },
  storePhotoImg: { width: '100%', height: 200, objectFit: 'contain', background: '#fff', display: 'block' },
  storePhotoHint: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: 28, color: 'var(--muted)', fontSize: 13 },
  photoChange: { position: 'absolute', right: 10, bottom: 10, background: 'rgba(15,23,42,0.82)', color: '#fff', fontSize: 12, fontWeight: 700, padding: '6px 12px', borderRadius: 999 },
  profileRow: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14, flexWrap: 'wrap' },
  profileHint: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13, color: 'var(--muted)' },
}
