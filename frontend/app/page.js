'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getSupabase } from '@/lib/supabase'
import { useAuth } from '@/context/auth-context'
import Header from '@/components/Header'
import Hero from '@/components/Hero'
import Footer from '@/components/Footer'
import Reveal from '@/components/Reveal'
import ProductImage from '@/components/ProductImage'
import { MARKET_CATEGORIES } from '@/lib/categories'
import { stockLabel, isOutOfStock, discountPct } from '@/lib/products'
import { Icon, iconNameFor } from '@/components/icons'

const CATEGORIES = MARKET_CATEGORIES.map((c) => ({
  name: c.label,
  icon: c.icon,
  query: c.query,
}))

const COVERS = [
  ['#0f172a', '#334155'],
  ['#7c2d12', '#c2410c'],
  ['#1e3a8a', '#3b82f6'],
  ['#14532d', '#16a34a'],
]

export default function HomePage() {
  const { user, profile, loading, signOut } = useAuth()
  const router = useRouter()
  const [stores, setStores] = useState([])
  const [products, setProducts] = useState([])

  const fetchAll = useCallback(async () => {
    const supabase = getSupabase()
    if (!supabase) return
    const [{ data: storeRows }, { data: productRows }] = await Promise.all([
      supabase.from('stores').select('*').eq('is_active', true).order('created_at', { ascending: false }),
      supabase.from('products').select('*').eq('is_available', true),
    ])
    setStores(storeRows || [])
    setProducts(productRows || [])
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  // Live sync — stores and products created / edited by ANY user show up on
  // the homepage without a refresh. Works against Supabase Realtime in real
  // mode and the cross-tab mock broadcast in local mode.
  useEffect(() => {
    const supabase = getSupabase()
    if (!supabase) return
    const channel = supabase
      .channel('home-marketplace-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stores' }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, fetchAll)
      .subscribe()
    return () => {
      const sb = getSupabase()
      if (sb) sb.removeChannel(channel)
    }
  }, [fetchAll])

  if (loading) {
    return (
      <div style={styles.loading}>
        <img src="/logo.svg" alt="KejetiaOnline" style={{ height: 34 }} />
      </div>
    )
  }

  const featured = stores.slice(0, 8)
  const storeById = Object.fromEntries(stores.map((s) => [s.id, s]))
  // “Today's Deals” only shows items sellers have actually marked down.
  const deals = products.filter((p) => discountPct(p) !== null).slice(0, 8)

  return (
    <div style={styles.page}>
      <Header user={user} profile={profile} onSignOut={signOut} />

      <Hero />

      {/* ── Shop by Category ── */}
      <section style={styles.sectionWhite} className="ko-section ko-section-white">
        <div className="container">
          <Reveal>
          <div className="ko-section-head">
            <div>
              <div className="ko-eyebrow">Browse the market</div>
              <h2 className="ko-title">Shop by Category</h2>
            </div>
            <a className="ko-link-all" href="/search">View all categories ›</a>
          </div>
          <div style={styles.catGrid}>
            {CATEGORIES.map((cat) => (
              <a key={cat.name} href={`/search?q=${encodeURIComponent(cat.query)}`} style={styles.catCard}>
                <span style={styles.catIcon}>
                  <Icon name={cat.icon} size={25} color="var(--accent-700)" />
                </span>
                <span style={styles.catName}>{cat.name}</span>
              </a>
            ))}
          </div>
          </Reveal>
        </div>
      </section>

      {/* ── Featured Vendors ── */}
      {featured.length > 0 && (
        <section style={styles.sectionGray} className="ko-section ko-section-gray">
          <div className="container">
            <Reveal>
            <div className="ko-section-head">
              <div>
                <div className="ko-eyebrow">Trusted merchants</div>
                <h2 className="ko-title">Featured Vendors</h2>
              </div>
              <a className="ko-link-all" href="/search">View all vendors ›</a>
            </div>
            <div style={styles.vendorGrid}>
              {featured.map((store, i) => (
                <a key={store.id} href={`/store/${store.id}`} style={styles.vendorCard}>
                  <div style={{ ...styles.vendorCover, background: `linear-gradient(135deg, ${COVERS[i % COVERS.length][0]} 0%, ${COVERS[i % COVERS.length][1]} 100%)` }}>
                    <span style={styles.vendorCoverIcon}>
                      <Icon name={iconNameFor(store)} size={72} />
                    </span>
                    <span style={styles.vendorAvatar}>{store.name.charAt(0)}</span>
                  </div>
                  <div style={styles.vendorBody}>
                    <h3 style={styles.vendorName}>{store.name}</h3>
                    <div style={styles.vendorMeta}>
                      {store.rating ? (
                        <span style={styles.vendorRating}>
                          <Icon name="star" size={13} color="#f59e0b" /> {Number(store.rating).toFixed(1)}
                          {store.review_count ? <span style={styles.vendorCount}> ({store.review_count})</span> : null}
                        </span>
                      ) : (
                        <span style={styles.vendorVerified}>
                          <Icon name="check" size={12} color="#059669" /> Verified
                        </span>
                      )}
                      <span style={styles.vendorLoc}>
                        <Icon name="map-pin" size={12} color="var(--muted)" /> {String(store.address || 'Kejetia Market').split(',')[0]}
                      </span>
                    </div>
                  </div>
                  <div style={styles.vendorFoot}>
                    <span>View Store</span>
                    <Icon name="arrow-right" size={14} />
                  </div>
                </a>
              ))}
            </div>
            </Reveal>
          </div>
        </section>
      )}

      {/* ── Today's Deals ── */}
      {deals.length > 0 && (
        <section style={styles.sectionWhite} className="ko-section ko-section-white">
          <div className="container">
            <Reveal>
            <div className="ko-section-head">
              <div>
                <div className="ko-eyebrow">Limited time</div>
                <h2 className="ko-title">Today&apos;s Deals</h2>
              </div>
              <a className="ko-link-all" href="/search?q=deals">View all ›</a>
            </div>
            <div style={styles.dealGrid}>
              {deals.map((product) => {
                const store = storeById[product.store_id]
                const oldPrice = Number(product.old_price)
                const price = Number(product.price)
                const pct = oldPrice > price && price > 0 ? Math.round(((oldPrice - price) / oldPrice) * 100) : null
                const stockText = stockLabel(product)
                const out = isOutOfStock(product)
                return (
                  <div key={product.id} className="ko-pimg-zoom" style={{ ...styles.dealCard, ...(out ? styles.dealCardOut : {}) }}>
                    <div style={styles.dealVisual}>
                      <ProductImage row={product} alt={product.name} style={styles.dealMint} />
                      {pct ? <span style={styles.dealBadge}>-{pct}%</span> : null}
                      {stockText && (
                        <span
                          style={{ ...styles.stockBadge, ...(out ? styles.stockBadgeOut : {}), ...(stockText.startsWith('Only') ? styles.stockBadgeLow : {}) }}
                        >
                          {stockText}
                        </span>
                      )}
                    </div>
                    <div style={styles.dealBody}>
                      <div style={styles.dealStore}>{store?.name || 'Kejetia Market'}</div>
                      <h4 style={styles.dealName}>{product.name}</h4>
                      <div style={styles.dealPrices}>
                        <span style={styles.dealPrice}>GH₵ {price.toLocaleString()}</span>
                        {pct ? <span style={styles.dealOld}>GH₵ {oldPrice.toLocaleString()}</span> : null}
                      </div>
                    </div>
                    <div style={styles.dealFoot}>
                      <a className="ko-btn ko-btn-dark" href={`/store/${product.store_id}`} style={styles.dealBtn}>View Store</a>
                    </div>
                  </div>
                )
              })}
            </div>
            </Reveal>
          </div>
        </section>
      )}

      {/* ── Dealer banner ── */}
      <section style={styles.dealerSection}>
        <div className="ko-dealer">
          <div style={styles.dealerText} className="ko-dealer-text">
            <h2 style={styles.dealerTitle} className="ko-dealer-title">Are you a dealer?</h2>
            <p style={styles.dealerSub}>Grow your business, reach more customers around you.</p>
            <a
              className="ko-btn ko-btn-accent"
              href="/auth/signup?role=seller"
              style={styles.dealerBtn}
              onClick={(e) => {
                e.preventDefault()
                router.push('/auth/signup?role=seller')
              }}
            >
              Get Your Business
            </a>
          </div>
          <div style={styles.dealerArt} className="ko-dealer-art" aria-hidden>
            <span style={styles.dealerArtMain}>
              <Icon name="storefront" size={148} color="rgba(245,158,11,0.95)" />
            </span>
            <span style={styles.dealerArtBag}>
              <Icon name="shopping-bag" size={56} color="rgba(255,255,255,0.55)" />
            </span>
            <span style={styles.dealerArtPin}>
              <Icon name="map-pin" size={38} color="rgba(255,255,255,0.5)" />
            </span>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--bg)' },
  loading: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' },
  sectionWhite: { padding: '72px 0', background: '#fff' },
  sectionGray: { padding: '72px 0', background: 'var(--bg)' },

  /* Categories */
  catGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))',
    gap: 16,
  },
  catCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 10,
    padding: '22px 10px 18px',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 16,
    textDecoration: 'none',
    transition: 'all 0.25s ease',
  },
  catIcon: {
    width: 56,
    height: 56,
    borderRadius: '50%',
    background: '#fff',
    border: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 26,
    boxShadow: '0 4px 12px rgba(15,23,42,0.05)',
  },
  catName: {
    fontSize: 12.5,
    fontWeight: 700,
    color: 'var(--ink)',
    textAlign: 'center',
  },

  /* Vendors */
  vendorGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(255px, 1fr))',
    gap: 22,
  },
  vendorCard: {
    background: '#fff',
    border: '1px solid var(--border)',
    borderRadius: 18,
    overflow: 'hidden',
    textDecoration: 'none',
    transition: 'all 0.25s ease',
    boxShadow: '0 2px 10px rgba(15,23,42,0.04)',
    cursor: 'pointer',
  },
  vendorCover: {
    position: 'relative',
    height: 104,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  vendorCoverIcon: {
    color: 'rgba(255,255,255,0.5)',
    opacity: 0.85,
  },
  vendorAvatar: {
    position: 'absolute',
    bottom: -24,
    left: 18,
    width: 52,
    height: 52,
    borderRadius: '50%',
    background: '#fff',
    border: '3px solid #fff',
    boxShadow: '0 4px 12px rgba(15,23,42,0.18)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 21,
    fontWeight: 800,
    color: 'var(--navy)',
  },
  vendorBody: { padding: '34px 18px 12px' },
  vendorName: {
    fontSize: 16.5,
    fontWeight: 800,
    color: 'var(--ink)',
    marginBottom: 6,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  vendorMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
  },
  vendorRating: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--ink)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  vendorCount: { fontWeight: 500, color: 'var(--muted)' },
  vendorVerified: {
    fontSize: 12,
    fontWeight: 700,
    color: '#059669',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  vendorLoc: {
    fontSize: 12.5,
    color: 'var(--muted)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '100%',
  },
  vendorFoot: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 18px',
    borderTop: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--accent-700)',
    fontSize: 13.5,
    fontWeight: 800,
  },
  arrow: { fontSize: 17 },

  /* Deals */
  dealGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: 22,
  },
  dealCard: {
    background: '#fff',
    border: '1px solid #f1f5f9',
    borderRadius: 8,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    transition: 'box-shadow 0.2s ease',
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  dealVisual: {
    position: 'relative',
    background: '#fff',
  },
  dealMint: { borderRadius: 0 },
  dealBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    background: '#fef3e2',
    color: '#f68b1e',
    fontSize: 12,
    fontWeight: 800,
    padding: '3px 8px',
    borderRadius: 4,
    zIndex: 2,
  },
  stockBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    background: 'rgba(15,23,42,0.82)',
    color: '#fff',
    border: 'none',
    fontSize: 11,
    fontWeight: 700,
    padding: '3px 8px',
    borderRadius: 4,
    zIndex: 2,
  },
  stockBadgeLow: { background: 'rgba(180,83,9,0.92)' },
  stockBadgeOut: { background: 'rgba(185,28,28,0.92)' },
  dealCardOut: { opacity: 0.62, filter: 'saturate(0.55)' },
  dealBody: { padding: '10px 12px 4px', flex: 1 },
  dealStore: {
    fontSize: 11,
    fontWeight: 400,
    color: '#75757a',
    marginBottom: 4,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  dealName: {
    fontSize: 13.5,
    fontWeight: 400,
    color: '#282828',
    lineHeight: 1.4,
    marginBottom: 8,
    minHeight: 38,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },
  dealPrices: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  dealPrice: { fontSize: 16, fontWeight: 700, color: '#282828' },
  dealOld: { fontSize: 12, color: '#75757a', textDecoration: 'line-through' },
  dealFoot: { padding: '12px 16px 16px' },
  dealBtn: { width: '100%', padding: '10px 0', fontSize: 14, borderRadius: 10 },

  /* Dealer banner */
  dealerSection: {
    background: 'var(--navy)',
    backgroundImage: 'radial-gradient(700px 300px at 100% 0%, rgba(245,158,11,0.14) 0%, transparent 60%)',
  },
  dealerText: { maxWidth: 520 },
  dealerTitle: {
    fontSize: 38,
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '-0.6px',
    marginBottom: 10,
  },
  dealerSub: {
    fontSize: 17,
    color: 'rgba(226,232,240,0.8)',
    marginBottom: 28,
  },
  dealerBtn: { padding: '15px 34px', fontSize: 16, borderRadius: 999 },
  dealerArt: { position: 'relative', width: 300, height: 200, flexShrink: 0 },
  dealerArtMain: { position: 'absolute', right: 8, top: -6, display: 'inline-flex' },
  dealerArtBag: { position: 'absolute', right: 150, top: 88, display: 'inline-flex' },
  dealerArtPin: { position: 'absolute', right: 44, top: 126, display: 'inline-flex' },
}
