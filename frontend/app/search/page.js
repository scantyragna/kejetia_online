'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { getSupabase } from '@/lib/supabase'
import { directionsUrl } from '@/lib/directions'
import { useAuth } from '@/context/auth-context'
import { useLiveLocations } from '@/hooks/useLiveLocations'
import Header from '@/components/Header'
import LiveMap from '@/components/maps/LiveMap'
import AddLandmarkModal from '@/components/AddLandmarkModal'
import ProductImage from '@/components/ProductImage'
import { MARKET_CATEGORIES } from '@/lib/categories'
import { PRODUCT_SORTS, sortProducts, stockLabel, isOutOfStock, discountPct } from '@/lib/products'
import { Icon, iconNameFor } from '@/components/icons'

const CATEGORY_FILTERS = ['All', ...MARKET_CATEGORIES.map((c) => c.label)]

export default function SearchPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}>Loading…</div>}>
      <SearchContent />
    </Suspense>
  )
}

function SearchContent() {
  const searchParams = useSearchParams()
  const { user, profile, signOut } = useAuth()
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [allStores, setAllStores] = useState([])
  const [allProducts, setAllProducts] = useState([])
  const [stores, setStores] = useState([])
  const [products, setProducts] = useState([])
  const [selectedStore, setSelectedStore] = useState(null)
  const [allLandmarks, setAllLandmarks] = useState([])
  const [landmarkMode, setLandmarkMode] = useState(false)
  const [showCapture, setShowCapture] = useState(false)
  const [view, setView] = useState('grid')
  const [loading, setLoading] = useState(false)
  const [catFilter, setCatFilter] = useState('')
  const [sort, setSort] = useState('featured')

  // Bare map: live dots + shared breadcrumb trails — active in map view.
  const { locations: liveLocations, trails: liveTrails } = useLiveLocations({ enabled: view === 'map' })

  const applyFilter = useCallback((term, storeRows, productRows, cat) => {
    const q = (term || '').trim().toLowerCase()
    let filteredStores = storeRows || []
    let filteredProducts = productRows || []
    if (q === 'deals') {
      // “deals” is a magic query — show only items currently discounted.
      filteredProducts = filteredProducts.filter((p) => discountPct(p) !== null)
      const dealStoreIds = new Set(filteredProducts.map((p) => p.store_id))
      filteredStores = filteredStores.filter((s) => dealStoreIds.has(s.id))
    } else if (q) {
      filteredStores = filteredStores.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          String(s.description || '').toLowerCase().includes(q) ||
          String(s.category || '').toLowerCase().includes(q) ||
          String(s.address || '').toLowerCase().includes(q)
      )
      const storeById = Object.fromEntries((storeRows || []).map((s) => [s.id, s]))
      filteredProducts = filteredProducts.filter((p) => {
        const inStore = filteredStores.some((s) => s.id === p.store_id)
        const storeName = (storeById[p.store_id]?.name || '').toLowerCase()
        return (
          inStore ||
          storeName.includes(q) ||
          p.name.toLowerCase().includes(q) ||
          String(p.description || '').toLowerCase().includes(q) ||
          String(p.category || '').toLowerCase().includes(q)
        )
      })
    }
    if (cat) {
      filteredStores = filteredStores.filter((s) => s.category === cat)
      filteredProducts = filteredProducts.filter((p) => p.category === cat)
    }
    setStores(filteredStores)
    setProducts(filteredProducts)
  }, [])

  // Full marketplace fetch — shared by the initial load and the live
  // subscription below (so stores/products/landmarks added by any user
  // appear without a manual refresh).
  const fetchAll = useCallback(async () => {
    const sb = getSupabase()
    if (!sb) return
    const [{ data: storeRows }, { data: productRows }, { data: landmarkRows }] = await Promise.all([
      sb.from('stores').select('*').eq('is_active', true).order('created_at', { ascending: false }),
      sb.from('products').select('*').eq('is_available', true),
      sb.from('landmarks').select('*').order('created_at', { ascending: false }),
    ])
    setAllStores(storeRows || [])
    setAllProducts(productRows || [])
    setLandmarksWithStores(storeRows || [], landmarkRows || [])
  }, [])

  useEffect(() => {
    const q = searchParams.get('q') || ''
    setQuery(q)
    setLoading(true)
    ;(async () => {
      await fetchAll()
      setLoading(false)
    })()
  }, [searchParams, fetchAll])

  // Live sync — marketplace tables pushed by other users (real mode: Supabase
  // Realtime; local mode: the mock cross-tab broadcast) refresh the page live.
  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    const channel = sb
      .channel('search-marketplace-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stores' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'landmarks' }, fetchAll)
      .subscribe()
    return () => {
      const s2 = getSupabase()
      if (s2) s2.removeChannel(channel)
    }
  }, [fetchAll])

  const setLandmarksWithStores = (storeRows, landmarkRows) => {
    const storeById = Object.fromEntries((storeRows || []).map((s) => [s.id, s]))
    setAllLandmarks(
      (landmarkRows || []).map((lm) => ({
        ...lm,
        store_name: lm.store_id ? storeById[lm.store_id]?.name || '' : '',
      }))
    )
  }

  // Re-fetch landmarks after a new one is published.
  const refreshLandmarks = async () => {
    const sb = getSupabase()
    if (!sb) return
    const { data: rows } = await sb.from('landmarks').select('*').order('created_at', { ascending: false })
    setLandmarksWithStores(allStores, rows || [])
    setShowCapture(false)
  }

  // Re-apply text + category filters whenever the query, chips or raw data change.
  useEffect(() => {
    applyFilter(query, allStores, allProducts, catFilter)
  }, [query, catFilter, allStores, allProducts, applyFilter])

  const navigate = (q) => {
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search')
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    navigate(query)
  }

  const getDirections = (store) => {
    // Navigate inside the platform — road + market walking route on /directions.
    router.push(directionsUrl({ name: store.name, lat: store.latitude, lng: store.longitude }))
  }

  const dealsMode = query.trim().toLowerCase() === 'deals'

  const heading = dealsMode ? 'Today’s Deals' : (query.trim() ? `Results for “${query}”` : 'Stores')

  const sub = dealsMode
    ? products.length
      ? `${products.length} discounted item${products.length === 1 ? '' : 's'} across ${stores.length} store${stores.length === 1 ? '' : 's'} right now`
      : 'No items are discounted at the moment — check back soon.'
    : query.trim()
      ? `${stores.length} store${stores.length === 1 ? '' : 's'} & ${products.length} product${products.length === 1 ? '' : 's'} found`
      : `${stores.length} stores in Kumasi`

  return (
    <div style={styles.page}>
      <Header user={user} profile={profile} onSignOut={signOut} />

      <div style={styles.top}>
        <div className="container" style={styles.topInner}>
          <div style={styles.breadcrumb}>Home › Stores</div>
          <div style={styles.headRow} className="ko-search-head">
            <div>
              <h1 style={styles.h1}>{heading}</h1>
              <p style={styles.sub}>{sub}</p>
            </div>
            <div style={styles.headControls} className="ko-search-controls">
              <select value={sort} onChange={(e) => setSort(e.target.value)} style={styles.sortSelect} aria-label="Sort results">
                {PRODUCT_SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <div style={styles.viewSwitch}>
                <button
                  style={{ ...styles.viewBtn, ...(view === 'grid' ? styles.viewBtnActive : {}) }}
                  onClick={() => setView('grid')}
                >
                  Grid
                </button>
                <button
                  style={{ ...styles.viewBtn, ...(view === 'map' ? styles.viewBtnActive : {}) }}
                  onClick={() => setView('map')}
                >
                  Map
                </button>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} style={styles.searchForm} className="ko-search-form">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={styles.searchIcon}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search product, shops, etc."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={styles.searchInput}
            />
            <button type="submit" className="ko-btn ko-btn-accent" style={styles.searchBtn}>Search</button>
          </form>

          <div style={styles.chips}>
            {CATEGORY_FILTERS.map((cat) => {
              const active = cat === 'All' ? !catFilter : catFilter === cat
              return (
                <button
                  key={cat}
                  style={{ ...styles.chip, ...(active ? styles.chipActive : {}) }}
                  onClick={() => setCatFilter(cat === 'All' ? '' : cat)}
                >
                  {cat}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="container" style={styles.content}>
        {loading && <p style={styles.status}>Searching…</p>}

        {!loading && view === 'grid' && stores.length === 0 && products.length === 0 && (
          <div style={styles.statusBox}>
            <Icon name="search" size={42} color="var(--muted-light)" />
            <p style={styles.statusText}>
              {dealsMode
                ? 'No items are discounted right now — sellers may add deals from their dashboard any time.'
                : `No results found for “${query || 'this filter'}”. Try another keyword.`}
            </p>
          </div>
        )}

        {/* GRID VIEW */}
        {view === 'grid' && !loading && (
          <>
            {stores.length > 0 && (
              <section style={styles.section}>
                <div style={styles.grid} className="ko-grid-2col">
                  {stores.map((store) => (
                    <a key={store.id} href={`/store/${store.id}`} style={styles.card}>
                      <div style={styles.cardCover}>
                        <span style={styles.cardIcon}>
                          <Icon name={iconNameFor(store)} size={46} />
                        </span>
                        <span style={styles.cardAvatar}>{store.name.charAt(0)}</span>
                      </div>
                      <div style={styles.cardBody}>
                        <h3 style={styles.cardName}>{store.name}</h3>
                        <div style={styles.cardMeta}>
                          {store.rating ? (
                            <span style={styles.cardRating}>
                              <Icon name="star" size={13} color="#f59e0b" /> {Number(store.rating).toFixed(1)}
                              {store.review_count ? <span style={styles.cardCount}> ({store.review_count})</span> : null}
                            </span>
                          ) : (
                            <span style={styles.cardVerified}>
                              <Icon name="check" size={12} color="#059669" /> Verified
                            </span>
                          )}
                          {store.category && <span style={styles.cardCat}>{store.category}</span>}
                        </div>
                        <div style={styles.cardLoc}>
                          <Icon name="map-pin" size={12} color="var(--muted)" /> {String(store.address || 'Kejetia Market, Kumasi').split(',')[0]}
                        </div>
                      </div>
                      <div style={styles.cardFoot}>
                        <span>View Store</span>
                        <Icon name="arrow-right" size={14} />
                      </div>
                    </a>
                  ))}
                </div>
              </section>
            )}

            {products.length > 0 && (
              <section style={styles.section}>
                <h2 style={styles.sectionTitle}>Products ({products.length})</h2>
                <div style={styles.productGrid} className="ko-grid-products">
                  {sortProducts(products, sort).map((product) => {
                    const store = allStores.find((s) => s.id === product.store_id)
                    const price = Number(product.price)
                    const oldPrice = Number(product.old_price)
                    const pct = oldPrice > price && price > 0 ? Math.round(((oldPrice - price) / oldPrice) * 100) : null
                    const stockText = stockLabel(product)
                    const out = isOutOfStock(product)
                    return (
                      <div key={product.id} className="ko-pimg-zoom" style={{ ...styles.productCard, ...(out ? styles.productCardOut : {}) }}>
                        <a href={`/store/${product.store_id}`} style={styles.productVisual}>
                          <ProductImage row={product} alt={product.name} />
                          {pct ? <span style={styles.productBadge}>-{pct}%</span> : null}
                          {stockText && (
                            <span
                              style={{ ...styles.stockBadge, ...(out ? styles.stockBadgeOut : {}), ...(stockText.startsWith('Only') ? styles.stockBadgeLow : {}) }}
                            >
                              {stockText}
                            </span>
                          )}
                        </a>
                        <div style={styles.productBody}>
                          <div style={styles.productStore}>{store?.name || 'Kejetia Market'}</div>
                          <h4 style={styles.productName}>{product.name}</h4>
                          <div style={styles.priceRow}>
                            <span style={styles.price}>GH₵ {price.toLocaleString()}</span>
                            {pct ? <span style={styles.priceOld}>GH₵ {oldPrice.toLocaleString()}</span> : null}
                          </div>
                        </div>
                        <a href={`/store/${product.store_id}`} style={styles.productBtn}>View Store</a>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}
          </>
        )}

        {/* MAP VIEW */}
        {view === 'map' && !loading && (
          <div className="ko-map-layout">
            <div className="ko-map-list" style={styles.mapList}>
              <div style={styles.mapListHead}>
                <div style={styles.mapListToggle} role="tablist" aria-label="Browse map items">
                  <button
                    role="tab"
                    aria-selected={!landmarkMode}
                    onClick={() => setLandmarkMode(false)}
                    style={{ ...styles.mapListTab, ...(!landmarkMode ? styles.mapListTabActive : {}) }}
                  >
                    Stores <span style={styles.mapListCount}>{stores.length}</span>
                  </button>
                  <button
                    role="tab"
                    aria-selected={landmarkMode}
                    onClick={() => setLandmarkMode(true)}
                    style={{ ...styles.mapListTab, ...(landmarkMode ? styles.mapListTabActive : {}) }}
                  >
                    Landmarks <span style={styles.mapListCount}>{allLandmarks.length}</span>
                  </button>
                </div>
              </div>

              {!landmarkMode ? (
                <>
                  {stores.length === 0 && (
                    <p style={styles.mapListEmpty}>
                      No stores on the map yet — sellers appear here when they join. Tap{' '}
                      <strong>Landmarks</strong> to see photo pins of store fronts & spots.
                    </p>
                  )}
                  {stores.map((store) => (
                    <div
                      key={store.id}
                      style={{ ...styles.mapStore, ...(selectedStore?.id === store.id ? styles.mapStoreActive : {}) }}
                      onClick={() => setSelectedStore(store)}
                    >
                      <span style={styles.mapStoreAvatar}>{store.name.charAt(0)}</span>
                      <div style={styles.mapStoreInfo}>
                        <strong style={styles.mapStoreName}>{store.name}</strong>
                        <span style={styles.mapStoreLoc}>{String(store.address || '').split(',')[0]}</span>
                        {store.rating ? (
                          <span style={styles.mapStoreRating}>
                            <Icon name="star" size={12} color="#f59e0b" /> {Number(store.rating).toFixed(1)} ({store.review_count})
                          </span>
                        ) : null}
                      </div>
                      <a href={`/store/${store.id}`} style={styles.mapStoreLink}>
                        View <Icon name="arrow-right" size={12} />
                      </a>
                    </div>
                  ))}
                </>
              ) : (
                <>
                  {allLandmarks.length === 0 ? (
                    <p style={styles.mapListEmpty}>
                      No landmarks yet — tap{' '}<strong>＋ Add landmark</strong> on the map to pin & photo a store front or spot.
                    </p>
                  ) : (
                    allLandmarks.map((lm) => (
                      <div key={lm.id} style={styles.lmCard}>
                        {lm.photo_url ? (
                          <img src={lm.photo_url} alt={lm.name} style={styles.lmCardImg} />
                        ) : (
                          <div style={styles.lmCardImgEmpty}>🏪</div>
                        )}
                        <div style={styles.lmCardBody}>
                          <strong style={styles.lmCardName}>{lm.name}</strong>
                          {lm.notes && <span style={styles.lmCardNotes}>{lm.notes}</span>}
                          {lm.store_id && lm.store_name ? (
                            <a href={`/store/${lm.store_id}`} style={styles.lmCardStore}>
                              🏪 {lm.store_name} <Icon name="arrow-right" size={11} />
                            </a>
                          ) : (
                            <span style={styles.lmCardTag}>Landmark</span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
            <div className="ko-map-wrap" style={styles.mapWrap}>
              <LiveMap
                stores={stores}
                landmarks={allLandmarks}
                userLocations={liveLocations}
                trails={liveTrails}
                onStoreClick={setSelectedStore}
                height="100%"
                selectedStoreId={selectedStore?.id}
                autoLocate
              />
              {selectedStore && !landmarkMode && (
                <div style={styles.mapPopup}>
                  <strong style={styles.mapPopupName}>{selectedStore.name}</strong>
                  <p style={styles.mapPopupAddr}>{selectedStore.address}</p>
                  <div style={styles.mapPopupActions}>
                    <button style={styles.mapDirBtn} onClick={() => getDirections(selectedStore)}>
                      <Icon name="map" size={14} /> Directions
                    </button>
                    <a href={`/store/${selectedStore.id}`} style={styles.mapViewBtn}>View Store</a>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => (user ? setShowCapture(true) : router.push('/auth/login'))}
                style={styles.lmFab}
                className="ko-lm-fab"
                title="Pin & photo a store front or landmark"
              >
                <Icon name="camera" size={17} color="currentColor" />
                Add landmark
              </button>
            </div>
          </div>
        )}

        {showCapture && (
          <AddLandmarkModal
            stores={allStores}
            user={user}
            onClose={() => setShowCapture(false)}
            onSaved={refreshLandmarks}
          />
        )}
      </div>
    </div>
  )
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--bg)' },

  top: { background: '#fff', borderBottom: '1px solid var(--border)', padding: '28px 0 22px' },
  topInner: {},
  breadcrumb: { fontSize: 13, fontWeight: 600, color: 'var(--muted)', marginBottom: 10 },
  headRow: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 18 },
  h1: { fontSize: 30, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.5px' },
  sub: { fontSize: 14.5, color: 'var(--muted)', marginTop: 4 },
  headControls: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  sortSelect: {
    padding: '9px 14px', border: '1px solid var(--border)', borderRadius: 999,
    fontSize: 13, fontWeight: 700, color: 'var(--ink)', background: '#fff', cursor: 'pointer',
    fontFamily: 'inherit', outline: 'none',
  },
  viewSwitch: { display: 'flex', gap: 4, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 999, padding: 4 },
  viewBtn: {
    border: 'none', background: 'transparent', borderRadius: 999,
    padding: '8px 20px', fontSize: 13.5, fontWeight: 700, color: 'var(--muted)', cursor: 'pointer',
    fontFamily: 'inherit', transition: 'all 0.2s ease',
  },
  viewBtnActive: { background: 'var(--navy)', color: '#fff' },

  searchForm: {
    display: 'flex', alignItems: 'center', gap: 12,
    border: '2px solid var(--border)', borderRadius: 14, padding: '5px 6px 5px 18px',
    maxWidth: 680, background: '#fff',
  },
  searchIcon: { color: 'var(--muted)', flexShrink: 0 },
  searchInput: {
    flex: 1, border: 'none', outline: 'none', padding: '12px 0', fontSize: 15.5,
    background: 'transparent', color: 'var(--ink)', minWidth: 0, fontFamily: 'inherit',
  },
  searchBtn: { padding: '12px 28px', fontSize: 15, borderRadius: 10, flexShrink: 0 },

  chips: { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 },
  chip: {
    background: 'var(--bg)', color: 'var(--ink)', border: '1px solid var(--border)',
    padding: '7px 16px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'inherit', transition: 'all 0.2s ease',
  },
  chipActive: { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--navy)', fontWeight: 800 },

  content: { padding: '30px 0 70px' },
  status: { textAlign: 'center', padding: 60, fontSize: 16, color: 'var(--muted)' },
  statusBox: { textAlign: 'center', padding: '70px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 },

  statusText: { fontSize: 16, color: 'var(--muted)' },

  section: { marginBottom: 44 },
  sectionTitle: { fontSize: 21, fontWeight: 800, color: 'var(--ink)', marginBottom: 18 },

  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(255px, 1fr))', gap: 22 },
  card: {
    background: '#fff', border: '1px solid var(--border)', borderRadius: 18, overflow: 'hidden',
    textDecoration: 'none', transition: 'all 0.25s ease', boxShadow: '0 2px 8px rgba(15,23,42,0.04)',
  },
  cardCover: {
    position: 'relative', height: 92, background: 'linear-gradient(120deg, #0f172a 0%, #334155 100%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  cardIcon: { color: 'rgba(255,255,255,0.55)', display: 'inline-flex' },
  cardAvatar: {
    position: 'absolute', bottom: -22, left: 18, width: 48, height: 48, borderRadius: '50%',
    background: 'linear-gradient(135deg, var(--accent), #fbbf24)', color: 'var(--navy)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 800,
    border: '3px solid #fff', boxShadow: '0 4px 12px rgba(15,23,42,0.2)',
  },
  cardBody: { padding: '30px 18px 12px' },
  cardName: { fontSize: 16, fontWeight: 800, color: 'var(--ink)', marginBottom: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  cardMeta: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 },
  cardRating: { fontSize: 13, fontWeight: 700, color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 4 },
  cardCount: { fontWeight: 500, color: 'var(--muted)' },
  cardVerified: { fontSize: 12, fontWeight: 700, color: '#059669', display: 'inline-flex', alignItems: 'center', gap: 4 },
  cardCat: { fontSize: 11.5, fontWeight: 700, color: 'var(--accent-700)', background: 'var(--accent-tint)', padding: '2px 10px', borderRadius: 999 },
  cardLoc: {
    fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  cardFoot: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '11px 18px', borderTop: '1px solid var(--border)', background: 'var(--bg)',
    color: 'var(--accent-700)', fontSize: 13.5, fontWeight: 800,
  },


  productGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 },
  productCard: {
    background: '#fff', border: '1px solid #f1f5f9', borderRadius: 8, overflow: 'hidden',
    display: 'flex', flexDirection: 'column', transition: 'box-shadow 0.2s ease',
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  productVisual: {
    position: 'relative', background: '#fff',
    display: 'block', textDecoration: 'none',
  },
  productBadge: {
    position: 'absolute', top: 8, right: 8, background: '#fef3e2', color: '#f68b1e',
    fontSize: 12, fontWeight: 800, padding: '3px 8px', borderRadius: 4, zIndex: 2,
  },
  stockBadge: {
    position: 'absolute', bottom: 8, left: 8, background: 'rgba(15,23,42,0.82)', color: '#fff',
    border: 'none', fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4, zIndex: 2,
  },
  stockBadgeLow: { background: 'rgba(180,83,9,0.92)' },
  stockBadgeOut: { background: 'rgba(185,28,28,0.92)' },
  productCardOut: { opacity: 0.62, filter: 'saturate(0.55)' },
  productBody: { padding: '10px 12px', flex: 1 },
  productStore: { fontSize: 11, fontWeight: 400, color: '#75757a', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  productName: { fontSize: 13.5, fontWeight: 400, color: '#282828', marginBottom: 8, minHeight: 38, lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
  priceRow: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  price: { fontSize: 16, fontWeight: 700, color: '#282828' },
  priceOld: { fontSize: 12, color: '#75757a', textDecoration: 'line-through' },
  productBtn: {
    display: 'block', textAlign: 'center', margin: '0 16px 15px', padding: '9px 0',
    background: 'var(--navy)', color: '#fff', fontSize: 13, fontWeight: 800, borderRadius: 10, textDecoration: 'none',
  },

  mapLayout: {},
  mapList: { width: 340, overflowY: 'auto', flexShrink: 0, paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 10 },
  mapListHead: { position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 5, paddingBottom: 2 },
  mapListToggle: {
    display: 'flex', gap: 4, background: 'var(--bg-soft, #f1f5f9)',
    border: '1px solid var(--border, #e2e8f0)', borderRadius: 999, padding: 3, marginBottom: 10,
  },
  mapListTab: {
    flex: 1, border: 'none', background: 'transparent', borderRadius: 999,
    padding: '7px 10px', fontSize: 12.5, fontWeight: 700, color: 'var(--muted)',
    cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap',
  },
  mapListTabActive: { background: 'var(--navy)', color: '#fff' },
  mapListCount: {
    fontSize: 11, fontWeight: 800, background: 'rgba(148, 163, 184, 0.25)',
    color: 'inherit', borderRadius: 999, padding: '1px 7px',
  },
  mapListEmpty: { fontSize: 13.5, lineHeight: 1.55, color: 'var(--muted)', background: 'var(--bg-soft, #f8fafc)', border: '1px dashed var(--border, #e2e8f0)', borderRadius: 12, padding: '14px 16px' },
  lmCard: {
    display: 'flex', gap: 11, alignItems: 'flex-start', background: '#fff',
    border: '1px solid var(--border, #e2e8f0)', borderRadius: 14, padding: 10,
    cursor: 'default',
  },
  lmCardImg: { width: 56, height: 56, borderRadius: 12, objectFit: 'cover', flexShrink: 0 },
  lmCardImgEmpty: {
    width: 56, height: 56, borderRadius: 12, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'linear-gradient(135deg,#fff7e0,#fbbf24)', fontSize: 24,
  },
  lmCardBody: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  lmCardName: { fontSize: 14, fontWeight: 800, color: 'var(--ink)', lineHeight: 1.3 },
  lmCardNotes: { fontSize: 12, color: 'var(--muted)', lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
  lmCardStore: {
    fontSize: 12, fontWeight: 700, color: '#0d7c3e', textDecoration: 'none',
    display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 2, alignSelf: 'flex-start',
  },
  lmCardTag: {
    fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
    color: '#0369a1', background: 'rgba(2, 132, 199, 0.1)', borderRadius: 999, padding: '2px 9px', alignSelf: 'flex-start',
  },
  lmFab: {
    position: 'absolute', bottom: 16, left: 16, zIndex: 1200,
    display: 'inline-flex', alignItems: 'center', gap: 8,
    background: 'var(--navy)', color: '#fff', fontWeight: 800, fontSize: 13.5,
    padding: '11px 18px', borderRadius: 999, border: 'none', cursor: 'pointer',
    boxShadow: '0 6px 22px rgba(15, 23, 42, 0.4)', transition: 'transform 0.15s ease, background 0.2s ease',
  },
  mapStore: {
    display: 'flex', gap: 12, alignItems: 'center', padding: 12, background: '#fff',
    border: '1px solid var(--border)', borderRadius: 14, marginBottom: 8, cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  mapStoreActive: { borderColor: 'var(--accent)', boxShadow: '0 0 0 2px var(--accent-tint)' },
  mapStoreAvatar: {
    width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
    background: 'var(--navy)', color: 'var(--accent)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, fontWeight: 800,
  },
  mapStoreInfo: { flex: 1, minWidth: 0 },
  mapStoreName: { display: 'block', fontSize: 14.5, fontWeight: 800, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  mapStoreLoc: { display: 'block', fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  mapStoreRating: { fontSize: 12, fontWeight: 700, color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 4 },
  mapStoreLink: {
    color: 'var(--accent-700)', fontWeight: 800, fontSize: 13, textDecoration: 'none',
    whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4,
  },
  mapWrap: { flex: 1, borderRadius: 18, overflow: 'hidden', position: 'relative', minHeight: 460, border: '1px solid var(--border)' },

  mapPopup: {
    position: 'absolute', bottom: 18, left: '50%', transform: 'translateX(-50%)', width: 'min(360px, calc(100% - 24px))',
    background: '#fff', borderRadius: 16, padding: '15px 18px', boxShadow: '0 10px 34px rgba(15,23,42,0.25)',
  },
  mapPopupName: { fontSize: 16, fontWeight: 800, color: 'var(--ink)' },
  mapPopupAddr: { fontSize: 13, color: 'var(--muted)', margin: '2px 0 10px' },
  mapPopupActions: { display: 'flex', gap: 8 },
  mapDirBtn: {
    background: 'var(--accent)', color: 'var(--navy)', border: 'none', padding: '9px 16px', borderRadius: 999,
    fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
    display: 'inline-flex', alignItems: 'center', gap: 7,
  },
  mapViewBtn: { background: 'var(--navy)', color: '#fff', padding: '9px 16px', borderRadius: 999, fontSize: 13, fontWeight: 700, textDecoration: 'none', fontFamily: 'inherit' },

}
