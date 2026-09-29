'use client'

import { useCallback, useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { getSupabase } from '@/lib/supabase'
import { useAuth } from '@/context/auth-context'
import { useLiveLocations } from '@/hooks/useLiveLocations'
import Header from '@/components/Header'
import LiveMap from '@/components/maps/LiveMap'
import ProductImage from '@/components/ProductImage'
import { MARKET_CATEGORIES } from '@/lib/categories'
import { PRODUCT_SORTS, sortProducts, stockLabel, isOutOfStock, discountPct } from '@/lib/products'
import { fetchStoreReviews, addStoreReview, timeAgo } from '@/lib/reviews'
import { directionsUrl } from '@/lib/directions'
import { Icon, iconNameFor } from '@/components/icons'

const TABS = [
  { id: 'items', label: 'All Items' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'about', label: 'About Us' },
  { id: 'map', label: 'Map / Location' },
]

const toIntl = (p) => String(p || '').replace(/^0/, '233').replace(/\D/g, '')

export default function StorePage() {
  const { id } = useParams()
  const { user, profile, loading: authLoading, signOut } = useAuth()
  const [store, setStore] = useState(null)
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('items')
  const [catFilter, setCatFilter] = useState('All')
  const [sort, setSort] = useState('featured')
  const [reviews, setReviews] = useState([])
  const [reviewRating, setReviewRating] = useState(0)
  const [reviewName, setReviewName] = useState('')
  const [reviewComment, setReviewComment] = useState('')
  const [submittingReview, setSubmittingReview] = useState(false)
  const [reviewMsg, setReviewMsg] = useState(null) // { ok: boolean, text: string }

  // Bare map: live dots + shared trails — only while the map tab is open.
  const { locations: liveLocations, trails: liveTrails } = useLiveLocations({ enabled: tab === 'map' })

  const isOwner = Boolean(user && store && store.owner_id && store.owner_id === user.id)

  const fetchAll = useCallback(async () => {
    const supabase = getSupabase()
    if (!supabase) return
    const { data: storeData } = await supabase
      .from('stores')
      .select('*')
      .eq('id', id)
      .single()
    setStore(storeData)

    if (storeData) {
      const sb = getSupabase()
      if (!sb) return
      const [{ data: productData }, reviewData] = await Promise.all([
        sb.from('products').select('*').eq('store_id', storeData.id).eq('is_available', true),
        fetchStoreReviews(storeData.id),
      ])
      setProducts(productData || [])
      setReviews(reviewData || [])
    }

    setLoading(false)
  }, [id])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  // Live sync — product/stock edits and new reviews (which move the store's
  // rating aggregate) show up without a refresh while the page is open.
  useEffect(() => {
    const supabase = getSupabase()
    if (!supabase) return
    const channel = supabase
      .channel(`store-live-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stores', filter: `id=eq.${id}` }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products', filter: `store_id=eq.${id}` }, fetchAll)
      .subscribe()
    return () => {
      const sb = getSupabase()
      if (sb) sb.removeChannel(channel)
    }
  }, [id, fetchAll])

  const submitReview = async (e) => {
    e.preventDefault()
    const name = (reviewName || '').trim()
    const comment = (reviewComment || '').trim()
    if (!store || isOwner) return
    if (!reviewRating) return setReviewMsg({ ok: false, text: 'Tap a star to rate this store.' })
    if (name.length < 2) return setReviewMsg({ ok: false, text: 'Enter your name so buyers know who reviewed.' })
    if (!comment) return setReviewMsg({ ok: false, text: 'Tell buyers about your experience.' })

    setSubmittingReview(true)
    setReviewMsg(null)
    const { error } = await addStoreReview({
      store_id: store.id,
      rating: reviewRating,
      comment,
      author_name: name,
      author_id: user?.id || null,
    })
    setSubmittingReview(false)
    if (error) return setReviewMsg({ ok: false, text: error.message || 'Could not save your review.' })

    setReviewMsg({ ok: true, text: 'Thanks! Your review is live.' })
    setReviewRating(0)
    setReviewComment('')
    // Re-fetch so the new review and the store rating aggregate appear.
    const supabase = getSupabase()
    if (!supabase) return
    const { data: storeData } = await supabase.from('stores').select('*').eq('id', store.id).single()
    if (storeData) setStore(storeData)
    setReviews((await fetchStoreReviews(store.id)) || [])
  }

  const shareOnWhatsApp = () => {
    if (!store) return
    // Share the store inside the platform (open directions in-app) — no
    // third-party map links.
    const appUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/store/${store.id}`
    const text = `Check out ${store.name} on KejetiaOnline!\n${store.address}\nPhone: ${store.phone}\n${appUrl}`
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank')
  }

  if (loading || authLoading) {
    return <div style={styles.loading}><img src="/logo.svg" alt="Loading..." style={{ height: 32 }} /></div>
  }

  if (!store) {
    return (
      <div style={styles.page}>
        <Header user={user} profile={profile} onSignOut={signOut} />
        <div style={styles.notFound}>
          <div style={styles.notFoundIcon}>
            <Icon name="storefront" size={64} color="var(--muted-light)" />
          </div>
          <p style={styles.notFoundText}>Store not found or no longer available.</p>
          <a className="ko-btn ko-btn-accent" href="/search" style={styles.notFoundBtn}>Browse Stores</a>
        </div>
      </div>
    )
  }

  const waLink = store.whatsapp || store.phone
  const telLink = store.phone
  const rating = Number(store.rating)

  const categoryOf = (p) => p.category || store.category || 'General'
  const categoryOrder = MARKET_CATEGORIES.map((c) => c.label)
  const catList = [...new Set(products.map(categoryOf))].sort(
    (a, b) => (categoryOrder.indexOf(a) - categoryOrder.indexOf(b)) || a.localeCompare(b)
  )

  const renderItem = (product) => {
    const price = Number(product.price)
    const oldPrice = Number(product.old_price)
    const pct = discountPct(product)
    const out = isOutOfStock(product)
    const stockText = stockLabel(product)
    const dealNote = pct ? ` (was GH₵ ${oldPrice.toLocaleString()} — ${pct}% off)` : ''
    const stockAsk = !stockText
      ? 'Is it available?'
      : stockText === 'Out of stock'
        ? 'Let me know when it is back in stock.'
        : stockText === 'In stock'
          ? 'Is it still available?'
          : 'You only have a few left, right?'
    const enquiryText = `Hi! I'm interested in “${product.name}” (GH₵ ${price.toLocaleString()}${dealNote}) from ${store.name} on KejetiaOnline. ${stockAsk}`
    return (
      <div key={product.id} className="ko-pimg-zoom" style={{ ...styles.productCard, ...(out ? styles.productCardOut : {}) }}>
        <div style={styles.productVisual}>
          <ProductImage row={product} alt={product.name} />
          {pct ? <span style={styles.dealBadge}>-{pct}%</span> : null}
          {stockText && (
            <span
              style={{ ...styles.stockBadge, ...(out ? styles.stockBadgeOut : {}), ...(stockText.startsWith('Only') ? styles.stockBadgeLow : {}) }}
            >
              {stockText}
            </span>
          )}
        </div>
        <div style={styles.productBody}>
          <div style={styles.productCat}>{categoryOf(product)}</div>
          <h4 style={styles.productName}>{product.name}</h4>
          {product.description && <p style={styles.productDesc}>{product.description}</p>}
          <div style={styles.priceRow}>
            <span style={styles.price}>GH₵ {price.toLocaleString()}</span>
            {pct ? <span style={styles.priceOld}>GH₵ {oldPrice.toLocaleString()}</span> : null}
          </div>
        </div>
        {waLink && (
          out ? (
            <span style={styles.productActionOff}>Out of stock</span>
          ) : (
            <a
              style={styles.productAction}
              href={`https://wa.me/${toIntl(waLink)}?text=${encodeURIComponent(enquiryText)}`}
              target="_blank"
              rel="noreferrer"
            >
              Enquire
            </a>
          )
        )}
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <Header user={user} profile={profile} onSignOut={signOut} />

      {/* Cover */}
      <div style={styles.cover} className="ko-store-cover">
        <span style={styles.coverWatermark}>
          <Icon name={iconNameFor(store, 'storefront')} size={178} />
        </span>
        <div className="container" style={styles.coverInner}>
          <span style={styles.coverCrumb}>
            <a href="/" style={styles.crumbLink}>Home</a> ›{' '}
            <a href="/search" style={styles.crumbLink}>Stores</a> ›{' '}
            <span style={styles.crumbCurrent}>{store.name}</span>
          </span>
        </div>
      </div>

      <div className="container" style={styles.main}>
        {/* Vendor info card */}
        <div style={styles.infoCard}>
          <div style={styles.infoLeft}>
            <div style={styles.avatar}>{store.name.charAt(0)}</div>
            <div style={styles.infoText}>
              <div style={styles.nameRow}>
                <h1 style={styles.name}>{store.name}</h1>
                {rating ? (
                  <span style={styles.verified} title="Verified merchant">
                    <Icon name="check" size={11} color="#059669" /> Verified
                  </span>
                ) : null}
              </div>
              <div style={styles.metaRow}>
                {store.category && <span style={styles.catChip}>{store.category}</span>}
                {rating ? (
                  <span style={styles.rating}>
                    <Icon name="star" size={14} color="#f59e0b" /> {rating.toFixed(1)}
                    {store.review_count ? <span style={styles.ratingCount}>({store.review_count})</span> : null}
                  </span>
                ) : null}
              </div>
              <div style={styles.location}>
                <Icon name="map-pin" size={13} color="var(--muted)" /> {store.address || 'Kejetia Market, Kumasi'}
              </div>
            </div>
          </div>

          <div style={styles.actions}>
            {telLink && (
              <a className="ko-btn ko-btn-accent" href={`tel:+${toIntl(telLink)}`} style={styles.actionBtn}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/></svg>
                Call
              </a>
            )}
            {waLink && (
              <a
                className="ko-btn ko-btn-whatsapp"
                style={styles.actionBtn}
                href={`https://wa.me/${toIntl(waLink)}?text=${encodeURIComponent(`Hello ${store.name}, I found you on KejetiaOnline.`)}`}
                target="_blank"
                rel="noreferrer"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.68-1.62-.93-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.5 0 1.47 1.07 2.9 1.22 3.1.15.2 2.1 3.2 5.1 4.49.71.3 1.27.49 1.7.63.72.23 1.37.2 1.88.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35z"/><path d="M12.05 2a9.9 9.9 0 0 0-8.42 15.1L2 22l5-1.3A9.9 9.9 0 1 0 12.05 2zm0 18.2a8.3 8.3 0 0 1-4.23-1.16l-.3-.18-3.06.8.82-2.99-.2-.32a8.3 8.3 0 1 1 6.97 3.85z"/></svg>
                WhatsApp
              </a>
            )}
            <button style={styles.shareBtn} onClick={shareOnWhatsApp} aria-label="Share store">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>
            </button>
            {user && store.owner_id !== user.id && (
              <a className="ko-btn ko-btn-dark" href={`/chat/${store.id}`} style={styles.chatBtn}>
                <Icon name="chat" size={15} /> Chat with Seller
              </a>
            )}
            <a
              className="ko-btn ko-btn-dark"
              href={directionsUrl({ name: store.name, lat: store.latitude, lng: store.longitude })}
              style={{ ...styles.chatBtn, background: 'var(--accent-700)' }}
            >
              <Icon name="map" size={15} /> Directions
            </a>
          </div>
        </div>

        {/* Tabs */}
        <div style={styles.tabs} className="ko-store-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className="ko-store-tab"
              style={{ ...styles.tab, ...(tab === t.id ? styles.tabActive : {}) }}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Items */}
        {tab === 'items' && (
          <div style={styles.panel}>
            <div style={styles.panelHead}>
              <h2 style={styles.panelTitle}>All Items ({products.length})</h2>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                style={styles.sortSelect}
                aria-label="Sort items"
              >
                {PRODUCT_SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            {products.length === 0 ? (
              <div style={styles.emptyBox}>
                <p style={styles.emptyText}>No items listed yet — contact the seller on WhatsApp or chat for current stock.</p>
                {waLink && (
                  <a className="ko-btn ko-btn-whatsapp" style={styles.emptyWa} href={`https://wa.me/${toIntl(waLink)}`} target="_blank" rel="noreferrer">
                    Message on WhatsApp
                  </a>
                )}
              </div>
            ) : (
              <>
                {catList.length > 1 && (
                  <div style={styles.catFilter}>
                    {['All', ...catList].map((cat) => (
                      <button
                        key={cat}
                        style={{ ...styles.catBtn, ...(catFilter === cat ? styles.catBtnActive : {}) }}
                        onClick={() => setCatFilter(cat)}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                )}

                {catFilter === 'All'
                  ? catList.map((cat) => {
                      const items = sortProducts(products.filter((p) => categoryOf(p) === cat), sort)
                      return (
                        <section key={cat} style={styles.catSection}>
                          <div style={styles.catRow}>
                            <h3 style={styles.catTitle}>{cat}</h3>
                            <span style={styles.catCount}>{items.length}</span>
                          </div>
                          <div style={styles.productGrid}>{items.map(renderItem)}</div>
                        </section>
                      )
                    })
                  : (
                    <div style={styles.productGrid}>
                      {sortProducts(products.filter((p) => categoryOf(p) === catFilter), sort).map(renderItem)}
                    </div>
                  )}
              </>
            )}
          </div>
        )}

        {/* Reviews */}
        {tab === 'reviews' && (
          <div style={styles.panel}>
            <div style={styles.revSummary}>
              <div style={styles.revScore}>
                <span style={styles.revScoreNum}>{rating ? rating.toFixed(1) : '—'}</span>
                <span style={styles.revStarsBig}>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Icon key={i} name="star" size={16} color={rating >= i - 0.25 ? '#f59e0b' : '#e2e8f0'} />
                  ))}
                </span>
                <span style={styles.revCount}>
                  {store.review_count || 0} review{store.review_count === 1 ? '' : 's'}
                </span>
              </div>
              <div style={styles.revTrust}>
                <Icon name="check" size={17} color="#059669" />
                <div>
                  <strong style={styles.revTrustTitle}>Real customer reviews</strong>
                  <span style={styles.revTrustSub}>Ratings come from buyers who shopped or messaged this store on KejetiaOnline.</span>
                </div>
              </div>
            </div>

            {isOwner ? (
              <div style={styles.ownerNote}>
                You can&apos;t review your own store — but your customers can. Share your store page to start collecting reviews.
              </div>
            ) : (
              <div style={styles.revFormCard}>
                <h3 style={styles.revFormTitle}>{user ? 'How was your experience?' : 'Visited or messaged this store?'}</h3>
                <p style={styles.revFormHint}>A short review helps other buyers find trustworthy merchants.</p>
                {reviewMsg && (
                  <div style={{ ...styles.revMsg, ...(reviewMsg.ok ? styles.revMsgOk : styles.revMsgErr) }}>
                    {reviewMsg.text}
                  </div>
                )}
                <form onSubmit={submitReview}>
                  <div style={styles.revStarsPicker} role="radiogroup" aria-label="Your rating">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <button
                        type="button"
                        key={i}
                        aria-label={`${i} star${i > 1 ? 's' : ''}`}
                        style={styles.starBtn}
                        onClick={() => setReviewRating(i)}
                      >
                        <Icon name="star" size={27} color={i <= reviewRating ? '#f59e0b' : '#e2e8f0'} />
                      </button>
                    ))}
                    <span style={styles.revRatingLabel}>
                      {reviewRating ? ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'][reviewRating] : 'Tap a star'}
                    </span>
                  </div>
                  <div style={styles.revFormRow}>
                    <input
                      style={{ ...styles.input, flex: 1 }}
                      placeholder="Your name"
                      value={reviewName}
                      maxLength={60}
                      onChange={(e) => setReviewName(e.target.value)}
                    />
                  </div>
                  <textarea
                    style={styles.revTextarea}
                    placeholder="What did you buy or ask about? Was the price fair? How was the seller?"
                    value={reviewComment}
                    maxLength={500}
                    onChange={(e) => setReviewComment(e.target.value)}
                  />
                  <button type="submit" className="ko-btn ko-btn-accent" style={styles.revSubmit} disabled={submittingReview}>
                    {submittingReview ? 'Posting…' : 'Post review'}
                  </button>
                </form>
              </div>
            )}

            {reviews.length ? (
              <div style={styles.revList}>
                {reviews.map((r) => (
                  <div key={r.id} style={styles.revItem}>
                    <span style={styles.revAvatar}>{(r.author_name || '?').charAt(0).toUpperCase()}</span>
                    <div style={styles.revBody}>
                      <div style={styles.revHead}>
                        <strong style={styles.revAuthor}>{r.author_name}</strong>
                        <span style={styles.revDate}>{timeAgo(r.created_at)}</span>
                      </div>
                      <span style={styles.revStarsSmall}>
                        {[1, 2, 3, 4, 5].map((i) => (
                          <Icon key={i} name="star" size={13} color={Number(r.rating) >= i ? '#f59e0b' : '#e2e8f0'} />
                        ))}
                      </span>
                      {r.comment
                        ? <p style={styles.revComment}>{r.comment}</p>
                        : <p style={styles.revNoComment}>Left a {r.rating}-star rating.</p>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={styles.emptyBox}>
                <p style={styles.emptyText}>No reviews yet — be the first to rate {store.name}.</p>
              </div>
            )}
          </div>
        )}

        {/* About */}
        {tab === 'about' && (
          <div style={styles.panel}>
            <h2 style={styles.panelTitle}>About {store.name}</h2>
            {store.description && <p style={styles.aboutText}>{store.description}</p>}
            <div style={styles.contactGrid}>
              {store.phone && (
                <div style={styles.contactItem}><span style={styles.contactIcon}><Icon name="phone" size={19} /></span><div><div style={styles.contactLabel}>Phone</div><a href={`tel:+${toIntl(store.phone)}`} style={styles.contactValue}>{store.phone}</a></div></div>
              )}
              {(store.whatsapp || store.phone) && (
                <div style={styles.contactItem}><span style={styles.contactIcon}><Icon name="whatsapp" size={19} /></span><div><div style={styles.contactLabel}>WhatsApp</div><span style={styles.contactValue}>{store.whatsapp || store.phone}</span></div></div>
              )}
              {store.address && (
                <div style={styles.contactItem}><span style={styles.contactIcon}><Icon name="map-pin" size={19} /></span><div><div style={styles.contactLabel}>Location</div><span style={styles.contactValue}>{store.address}</span></div></div>
              )}
              {store.operating_hours && (
                <div style={styles.contactItem}><span style={styles.contactIcon}><Icon name="clock" size={19} /></span><div><div style={styles.contactLabel}>Opening hours</div><span style={styles.contactValue}>{store.operating_hours}</span></div></div>
              )}
            </div>
          </div>
        )}

        {/* Map */}
        {tab === 'map' && (
          <div style={styles.panel}>
            <h2 style={styles.panelTitle}>Location</h2>
            <div style={styles.mapContainer}>
              <LiveMap
                stores={[store]}
                userLocations={liveLocations}
                trails={liveTrails}
                height={360}
                center={{ lat: store.latitude, lng: store.longitude }}
                zoom={16}
                selectedStoreId={store.id}
                showLandmarks={false}
                showUserLocation
              />
            </div>
            <p style={styles.mapHint}>
              <Icon name="map-pin" size={13} color="var(--muted)" /> {store.address || 'Kejetia Market, Kumasi'}
            </p>
            <a
              href={directionsUrl({ name: store.name, lat: store.latitude, lng: store.longitude })}
              style={styles.mapDirLink}
            >
              <Icon name="map" size={14} /> Get directions to this store →
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--bg)' },
  loading: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' },

  notFound: {
    textAlign: 'center',
    padding: '90px 24px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
  },
  notFoundIcon: { color: 'var(--muted-light)', display: 'inline-flex' },
  notFoundText: { fontSize: 16, color: 'var(--muted)' },
  notFoundBtn: { padding: '12px 28px', borderRadius: 999, fontSize: 15 },

  cover: {
    position: 'relative',
    background: 'linear-gradient(120deg, #0f172a 0%, #1e293b 55%, #431407 130%)',
    height: 216,
    overflow: 'hidden',
  },
  coverInner: { position: 'relative', height: '100%', display: 'flex', alignItems: 'flex-end', paddingBottom: 22 },
  coverWatermark: {
    position: 'absolute',
    right: 64,
    top: 4,
    color: 'rgba(255,255,255,0.14)',
    userSelect: 'none',
    display: 'inline-flex',
    pointerEvents: 'none',
  },
  coverCrumb: { fontSize: 13.5, fontWeight: 600, color: 'rgba(226,232,240,0.65)' },
  crumbLink: { color: 'rgba(226,232,240,0.65)', textDecoration: 'none' },
  crumbCurrent: { color: 'var(--accent)' },

  main: { marginTop: -58, paddingBottom: 72, position: 'relative', zIndex: 1 },
  infoCard: {
    background: '#fff',
    border: '1px solid var(--border)',
    borderRadius: 20,
    padding: '22px 26px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 24,
    flexWrap: 'wrap',
    boxShadow: '0 18px 44px rgba(15,23,42,0.12)',
  },
  infoLeft: { display: 'flex', alignItems: 'center', gap: 18, minWidth: 0 },
  avatar: {
    width: 84,
    height: 84,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, var(--accent) 0%, #fbbf24 100%)',
    color: 'var(--navy)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 36,
    fontWeight: 800,
    border: '4px solid #fff',
    boxShadow: '0 6px 18px rgba(245,158,11,0.4)',
    flexShrink: 0,
  },
  infoText: { minWidth: 0 },
  nameRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  name: { fontSize: 26, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-0.4px' },
  verified: {
    background: '#ecfdf5',
    color: '#059669',
    border: '1px solid #a7f3d0',
    fontSize: 11.5,
    fontWeight: 800,
    padding: '3px 10px',
    borderRadius: 999,
    whiteSpace: 'nowrap',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
  },
  metaRow: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' },
  catChip: {
    background: 'var(--accent-tint)',
    color: 'var(--accent-700)',
    fontSize: 12,
    fontWeight: 700,
    padding: '3px 11px',
    borderRadius: 999,
  },
  rating: { fontSize: 14, fontWeight: 800, color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 4 },
  ratingCount: { fontWeight: 500, color: 'var(--muted)' },
  location: {
    fontSize: 13.5, color: 'var(--muted)', marginTop: 6,
    display: 'inline-flex', alignItems: 'center', gap: 6,
  },

  actions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  actionBtn: { padding: '12px 20px', fontSize: 14.5, borderRadius: 999 },
  shareBtn: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    border: '1px solid var(--border)',
    background: '#fff',
    color: 'var(--navy)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s ease',
  },
  chatBtn: {
    padding: '12px 20px', fontSize: 14.5, borderRadius: 999,
    display: 'inline-flex', alignItems: 'center', gap: 8,
  },

  tabs: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    margin: '34px 0 26px',
    borderBottom: '2px solid var(--border)',
  },
  tab: {
    background: 'none',
    border: 'none',
    padding: '12px 18px',
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--muted)',
    cursor: 'pointer',
    borderBottom: '3px solid transparent',
    marginBottom: -2,
    transition: 'all 0.2s ease',
    fontFamily: 'inherit',
  },
  tabActive: { color: 'var(--accent-700)', borderBottomColor: 'var(--accent)' },

  panel: {},
  panelHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 },
  panelTitle: { fontSize: 21, fontWeight: 800, color: 'var(--ink)', margin: 0 },
  sortSelect: {
    padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 999,
    fontSize: 13, fontWeight: 700, color: 'var(--ink)', background: '#fff', cursor: 'pointer',
    fontFamily: 'inherit', outline: 'none',
  },

  catFilter: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 },
  catBtn: {
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 999,
    padding: '8px 18px', fontSize: 13.5, fontWeight: 700, color: 'var(--ink)',
    cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s ease',
  },
  catBtnActive: { background: 'var(--navy)', borderColor: 'var(--navy)', color: '#fff' },
  catSection: { marginBottom: 34 },
  catRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 },
  catTitle: { fontSize: 19, fontWeight: 800, color: 'var(--ink)', margin: 0 },
  catCount: { fontSize: 12, fontWeight: 800, color: 'var(--accent-700)', background: 'var(--accent-tint)', borderRadius: 999, padding: '2px 10px' },
  emptyBox: {
    background: '#fff',
    border: '1px dashed var(--border)',
    borderRadius: 16,
    padding: '42px 24px',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 14,
  },
  emptyText: { fontSize: 15, color: 'var(--muted)', maxWidth: 380 },
  emptyWa: { padding: '11px 22px', fontSize: 14, borderRadius: 999 },

  productGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 },
  productCard: {
    background: '#fff',
    border: '1px solid #f1f5f9',
    borderRadius: 8,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    transition: 'box-shadow 0.2s ease',
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  productVisual: {
    position: 'relative',
    background: '#fff',
  },
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
  productCardOut: { opacity: 0.62, filter: 'saturate(0.55)' },
  productActionOff: {
    display: 'block',
    textAlign: 'center',
    margin: '0 16px 16px',
    padding: '10px 0',
    background: 'var(--bg)',
    color: 'var(--muted)',
    border: '1px solid var(--border)',
    fontSize: 13.5,
    fontWeight: 800,
    borderRadius: 10,
  },
  productBody: { padding: '14px 16px', flex: 1 },
  productCat: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--accent-600)',
    marginBottom: 3,
  },
  productName: { fontSize: 13.5, fontWeight: 400, color: '#282828', marginBottom: 4, lineHeight: 1.4, minHeight: 38, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
  productDesc: {
    fontSize: 12,
    color: '#75757a',
    lineHeight: 1.5,
    marginBottom: 10,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },
  priceRow: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  price: { fontSize: 16, fontWeight: 700, color: '#282828' },
  priceOld: { fontSize: 12, color: '#75757a', textDecoration: 'line-through' },
  productAction: {
    display: 'block',
    textAlign: 'center',
    margin: '0 16px 16px',
    padding: '10px 0',
    background: 'var(--accent)',
    color: 'var(--navy)',
    fontSize: 13.5,
    fontWeight: 800,
    borderRadius: 10,
    textDecoration: 'none',
    transition: 'background 0.2s ease',
  },

  aboutText: { fontSize: 15.5, color: 'var(--ink)', lineHeight: 1.8, marginBottom: 26, maxWidth: 720 },
  contactGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: 16,
  },
  contactItem: {
    background: '#fff',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: '16px 18px',
    display: 'flex',
    gap: 14,
    alignItems: 'flex-start',
  },
  contactIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    background: 'var(--accent-tint)',
    color: 'var(--accent-700)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  contactLabel: { fontSize: 11.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)', marginBottom: 2 },
  contactValue: { fontSize: 14.5, fontWeight: 700, color: 'var(--ink)', textDecoration: 'none' },

  mapContainer: { borderRadius: 16, overflow: 'hidden', border: '1px solid var(--border)' },
  mapHint: {
    fontSize: 13.5, color: 'var(--muted)', marginTop: 12,
    display: 'inline-flex', alignItems: 'center', gap: 6,
  },
  mapDirLink: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    marginTop: 10, fontSize: 13.5, fontWeight: 700,
    color: 'var(--accent-700)', textDecoration: 'none',
  },

  /* Reviews */
  revSummary: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 22,
    flexWrap: 'wrap', background: '#fff', border: '1px solid var(--border)',
    borderRadius: 16, padding: '20px 24px', marginBottom: 18,
  },
  revScore: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  revScoreNum: { fontSize: 42, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-1px', lineHeight: 1 },
  revStarsBig: { display: 'inline-flex', gap: 2 },
  revCount: { fontSize: 13.5, fontWeight: 700, color: 'var(--muted)' },
  revTrust: { display: 'flex', alignItems: 'flex-start', gap: 10, maxWidth: 300, color: '#059669' },
  revTrustTitle: { display: 'block', fontSize: 13.5, color: 'var(--ink)', marginBottom: 2 },
  revTrustSub: { display: 'block', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 },
  ownerNote: {
    background: 'var(--bg)', border: '1px dashed var(--muted-light)', color: 'var(--muted)',
    borderRadius: 14, padding: '16px 20px', fontSize: 14, marginBottom: 18,
  },
  revFormCard: {
    background: '#fff', border: '1px solid var(--border)', borderRadius: 16,
    padding: '20px 22px', marginBottom: 22,
  },
  revFormTitle: { fontSize: 17, fontWeight: 800, color: 'var(--ink)', margin: 0 },
  revFormHint: { fontSize: 13, color: 'var(--muted)', margin: '4px 0 14px' },
  revMsg: { fontSize: 13.5, fontWeight: 700, borderRadius: 10, padding: '10px 14px', marginBottom: 14 },
  revMsgOk: { background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0' },
  revMsgErr: { background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' },
  revStarsPicker: { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12 },
  starBtn: {
    background: 'none', border: 'none', padding: 2, cursor: 'pointer',
    display: 'inline-flex', lineHeight: 0, transition: 'transform 0.15s ease',
  },
  revRatingLabel: { fontSize: 13, fontWeight: 700, color: 'var(--muted)', marginLeft: 6 },
  revFormRow: { display: 'flex', gap: 10, marginBottom: 10 },
  input: {
    padding: '11px 14px', border: '1.5px solid var(--border)', borderRadius: 10,
    fontSize: 14.5, background: '#fff', outline: 'none', boxSizing: 'border-box',
    fontFamily: 'inherit', color: 'var(--ink)', width: '100%',
  },
  revTextarea: {
    width: '100%', padding: '11px 14px', border: '1.5px solid var(--border)', borderRadius: 10,
    fontSize: 14.5, background: '#fff', outline: 'none', boxSizing: 'border-box',
    fontFamily: 'inherit', color: 'var(--ink)', minHeight: 78, resize: 'vertical', marginBottom: 12,
  },
  revSubmit: { padding: '11px 26px', fontSize: 14.5, borderRadius: 999 },
  revList: { display: 'flex', flexDirection: 'column', gap: 12 },
  revItem: {
    display: 'flex', gap: 14, background: '#fff', border: '1px solid var(--border)',
    borderRadius: 14, padding: '16px 18px',
  },
  revAvatar: {
    width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
    background: 'linear-gradient(135deg, var(--accent) 0%, #fbbf24 100%)',
    color: 'var(--navy)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 17, fontWeight: 800,
  },
  revBody: { flex: 1, minWidth: 0 },
  revHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 4 },
  revAuthor: { fontSize: 14.5, color: 'var(--ink)' },
  revDate: { fontSize: 12, color: 'var(--muted-light)', fontWeight: 600 },
  revStarsSmall: { display: 'inline-flex', gap: 1, marginBottom: 6 },
  revComment: { fontSize: 14, color: 'var(--ink)', lineHeight: 1.6, margin: 0 },
  revNoComment: { fontSize: 13.5, color: 'var(--muted)', margin: 0, fontStyle: 'italic' },

}
