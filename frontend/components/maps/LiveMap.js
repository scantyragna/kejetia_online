'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import 'leaflet/dist/leaflet.css'
import {
  IMAGE_SRC,
  KEJETIA_CENTER,
  MAP_BOUNDS,
  LANDMARKS,
  GHANA_CENTER,
  GHANA_BOUNDS,
  GHANA_ZOOM_DEFAULT,
  KUMASI_CENTER,
  KUMASI_ZOOM_DEFAULT,
} from '@/lib/map-geo'
import { routeInMarket, metersBetween } from '@/lib/kejetia-graph'
import { isInMarket } from '@/lib/routing'
import { directionsUrl } from '@/lib/directions'
import { locateWithFallback, describeGeoError, GEO_MESSAGES } from '@/lib/geolocation'

// Geolocation fixes rougher than this are treated as "approximate" — we
// show the uncertainty instead of claiming exact distances/positions.
const LOW_ACCURACY_M = 2000

// Free tile layers that require no API key.
// Streets: OpenStreetMap standard tiles — CARTO's free tier now watermarks
// anonymous tiles with "API KEY REQUIRED".
const STREETS_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const SATELLITE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

const DEFAULT_BASE = 'streets'

// Zoom thresholds for smart visibility
const ZOOM_LANDMARKS = 12   // landmarks appear
const ZOOM_STORES = 13      // store pins appear
const ZOOM_KEJETIA_OVERLAY = 14  // Kejetia image overlay appears

// Simple grid-based clustering for user dots
function clusterPoints(points, zoom) {
  if (!points.length) return []
  // Grid size in degrees — smaller when zoomed in
  const gridSize = Math.max(0.05, 2.5 / Math.pow(2, zoom - 5))
  const grid = {}
  points.forEach((p) => {
    const key = `${Math.floor(p.lat / gridSize)}_${Math.floor(p.lng / gridSize)}`
    if (!grid[key]) grid[key] = { lats: [], lngs: [], items: [] }
    grid[key].lats.push(p.lat)
    grid[key].lngs.push(p.lng)
    grid[key].items.push(p)
  })
  return Object.values(grid).map((g) => {
    const count = g.items.length
    const avgLat = g.lats.reduce((a, b) => a + b, 0) / count
    const avgLng = g.lngs.reduce((a, b) => a + b, 0) / count
    return { lat: avgLat, lng: avgLng, count, items: g.items }
  })
}

// Inline SVG icons (Google Maps style, stroke-based).
const ICONS = {
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  locate: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="6"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>',
  fullscreen: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  compress: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
  market: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
}

// Google-style place card shown inside the Leaflet popup.
function placeCard(store) {
  return `
    <div class="lm-place-card">
      <div class="lm-place-name">${store.name}</div>
      <div class="lm-place-addr">${store.address || 'Kejetia Market, Kumasi'}</div>
      ${store.phone ? `<div class="lm-place-phone">${store.phone}</div>` : ''}
      <div class="lm-place-actions">
        <a class="lm-place-btn lm-place-btn-primary"
           href="${directionsUrl({ name: store.name, lat: store.latitude, lng: store.longitude })}">Directions</a>
        <a class="lm-place-btn" href="/store/${store.id}">View Store</a>
      </div>
    </div>
  `
}

function flyIconCss(anchorY) {
  return `
    position: absolute;
    left: 50%;
    top: ${anchorY};
    width: 0; height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 7px solid #fff;
    transform: translateX(-50%);
  `
}

// ─── Loading skeleton ───
function MapSkeleton() {
  return (
    <div className="lm-skeleton">
      <div className="lm-skeleton-pulse" />
      <div className="lm-skeleton-text">
        <span>Loading map…</span>
      </div>
    </div>
  )
}

// ─── Error fallback ───
function MapError({ message, onRetry }) {
  return (
    <div className="lm-error">
      <div className="lm-error-icon">🗺️</div>
      <div className="lm-error-text">Could not load the map</div>
      <div className="lm-error-detail">{message}</div>
      <button className="lm-error-retry" onClick={onRetry}>Try again</button>
    </div>
  )
}

// Rich popup for a user-added photo landmark.
function landmarkCard(l) {
  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  const photo = l.photo_url
    ? `<img src="${l.photo_url}" alt="${esc(l.name)}" style="width:100%;height:132px;object-fit:cover;border-radius:10px;display:block;background:#eef2f7" onerror="this.style.display='none'" />`
    : `<div style="height:132px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#fff7e0,#fbbf24);border-radius:10px;font-size:34px">🏪</div>`
  const storeLink = l.store_id
    ? `<a href="/store/${l.store_id}" style="display:inline-flex;align-items:center;gap:4px;font-size:13px;font-weight:700;color:#0d7c3e;text-decoration:none">${esc(l.store_name || 'View related store')} →</a>`
    : '<span style="font-size:11px;color:#9aa3b2">Landmark</span>'
  return `<div style="min-width:220px;max-width:270px">
    ${photo}
    <div style="margin-top:10px;font-weight:800;font-size:15px;color:#0f172a">${esc(l.name)}</div>
    ${l.notes ? `<p style="margin:5px 0 0;color:#5f6368;font-size:12.5px;line-height:1.5">${esc(l.notes)}</p>` : ''}
    <div style="display:flex;gap:10px;align-items:center;margin-top:12px">
      ${storeLink}
      <a href="${directionsUrl({ name: l.name, lat: l.latitude, lng: l.longitude })}" style="margin-left:auto;padding:6px 12px;background:#1a73e8;color:#fff;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none">Directions</a>
    </div>
  </div>`
}

export default function LiveMap({
  stores = [],
  landmarks = [],
  userLocations = [],
  trails = [],
  onStoreClick,
  onLocationPick,
  selectedStoreId,
  selectedPin,
  height = '100%',
  center,
  zoom,
  showUserLocation = true,
  autoLocate = false,
  showLandmarks = true,
  // Bare-map rebuild: static KML dots + Kejetia centre pin are OFF by
  // default. The map starts empty — shoppers draw it with dots, breadcrumb
  // trails and photo landmarks. Pass showStaticLandmarks to opt back in.
  showStaticLandmarks = false,
  showKejetiaCenter = false,
  showTrails = true,
  routes = null,
  navTrip = null,
  onNavEnd = null,
}) {
  const mapRef = useRef(null)
  const containerRef = useRef(null)
  const leafletRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const markersRef = useRef([])
  const markerByIdRef = useRef({})
  const landmarkPhotoByIdRef = useRef({})
  const landmarkMarkersRef = useRef([])
  const kejetiaMarkerRef = useRef(null)
  const userMarkerRef = useRef(null)
  const userAccuracyRef = useRef(null)
  // Once the user drags the "you are here" dot to correct a wrong fix, the
  // GPS watcher stops overriding it until "Find my location" is used again.
  const manualPositionRef = useRef(false)
  const selectedPinMarkerRef = useRef(null)
  const routeLayersRef = useRef([])
  const watcherRef = useRef(null)
  const baseLayersRef = useRef({})
  const noticeTimerRef = useRef(null)
  const loadedRef = useRef(false)
  const [activeBase, setActiveBase] = useState(DEFAULT_BASE)
  const [notice, setNotice] = useState(null)
  const [routeInfo, setRouteInfo] = useState(null)
  const [nav, setNav] = useState(null)
  const [mapLoading, setMapLoading] = useState(true)
  const [mapError, setMapError] = useState(null)
  const [mapReady, setMapReady] = useState(false)
  // Bumping this re-runs the one-time map initialisation (used by retry).
  const [initNonce, setInitNonce] = useState(0)
  // ── Remote user state ──
  const [userLocation, setUserLocation] = useState(null)
  const [distanceFromMarket, setDistanceFromMarket] = useState(null)
  const [remoteBannerDismissed, setRemoteBannerDismissed] = useState(false)
  const distanceLineRef = useRef(null)
  const remoteLabelRef = useRef(null)
  const [currentZoom, setCurrentZoom] = useState(KUMASI_ZOOM_DEFAULT)
  const userDotsRef = useRef([])
  const clusterLayersRef = useRef([])

  const onStoreClickRef = useRef(onStoreClick)
  const onLocationPickRef = useRef(onLocationPick)
  onStoreClickRef.current = onStoreClick
  onLocationPickRef.current = onLocationPick
  // Static-layer flags for the one-time init (bare map = both false).
  const staticFlagsRef = useRef({ showStaticLandmarks, showKejetiaCenter, showLandmarks })
  staticFlagsRef.current = { showStaticLandmarks, showKejetiaCenter, showLandmarks }
  const trailLayersRef = useRef([])

  // Whether we're at Kejetia zoom level
  const isKejetiaZoom = currentZoom >= ZOOM_KEJETIA_OVERLAY

  const showNotice = useCallback((msg) => {
    setNotice(msg)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), 3500)
  }, [])

  // ── Switch base layer via React state ──
  const switchBase = useCallback((key) => {
    const map = mapInstanceRef.current
    if (!map || !baseLayersRef.current[key]) return
    Object.entries(baseLayersRef.current).forEach(([k, layer]) => {
      if (k === key) {
        if (!map.hasLayer(layer)) layer.addTo(map)
      } else {
        if (map.hasLayer(layer)) map.removeLayer(layer)
      }
    })
    setActiveBase(key)
  }, [])

  // ── Initialize the map once ──
  useEffect(() => {
    let cancelled = false
    let map = null
    let onFullscreenChange = null

    const init = async () => {
      try {
        setMapLoading(true)
        setMapError(null)

        const L = await import('leaflet')
        if (cancelled || !containerRef.current) return
        leafletRef.current = L

        // ── Default: Kumasi city view ──
        const startCenter = center
          ? [center.lat, center.lng]
          : [KUMASI_CENTER.lat, KUMASI_CENTER.lng]
        const startZoom = zoom || KUMASI_ZOOM_DEFAULT

        map = L.map(mapRef.current, {
          center: startCenter,
          zoom: startZoom,
          minZoom: 6,
          maxZoom: 20,
          zoomControl: false,
          attributionControl: false,
          // Ghana bounds — keep users within the country
          maxBounds: [
            [GHANA_BOUNDS.south - 1, GHANA_BOUNDS.west - 1],
            [GHANA_BOUNDS.north + 1, GHANA_BOUNDS.east + 1],
          ],
          maxBoundsViscosity: 0.85,
          // Organic feel
          inertia: true,
          inertiaDeceleration: 3000,
          inertiaMaxSpeed: 1500,
          easeLinearity: 0.2,
          bounceAtZoomLimits: true,
          wheelPxPerZoomLevel: 50,
          zoomSnap: 0.25,
          zoomDelta: 1,
          zoomAnimation: true,
          markerZoomAnimation: true,
          fadeAnimation: true,
          tap: true,
          tapTolerance: 15,
          touchZoom: true,
        })
        mapInstanceRef.current = map

        // ── Base layers ──
        const imageOverlay = L.imageOverlay(IMAGE_SRC, [
          [MAP_BOUNDS.south, MAP_BOUNDS.west],
          [MAP_BOUNDS.north, MAP_BOUNDS.east],
        ], { opacity: 1 })

        const streets = L.tileLayer(STREETS_URL, {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        })

        const satellite = L.tileLayer(SATELLITE_URL, {
          maxZoom: 19,
          attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
        })

        baseLayersRef.current = { kejetia: imageOverlay, streets, satellite }
        const start = baseLayersRef.current[DEFAULT_BASE] || streets
        start.addTo(map)

        // ── Attribution + scale bar ──
        L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(map)
        L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 120 }).addTo(map)

        // ── Tile loading indicator (with failsafe — a blocked tile CDN
        // must never leave the skeleton up forever) ──
        let tilesLoading = 0
        let settled = false
        const settle = () => {
          if (settled || cancelled) return
          settled = true
          setMapLoading(false)
        }
        const loadingFallback = setTimeout(settle, 8000)
        map.on('tileloadstart', () => {
          if (settled) return // panning after first load never re-shows the skeleton
          tilesLoading++; setMapLoading(true)
        })
        // NOTE: 'tileload' is not a map-level event — listen on each layer.
        ;[streets, satellite].forEach((layer) => {
          layer.on('load', () => {
            tilesLoading = 0
            clearTimeout(loadingFallback)
            settle()
          })
          layer.on('tileerror', () => {
            tilesLoading = Math.max(0, tilesLoading - 1)
            if (tilesLoading === 0) settle()
          })
        })
        map.on('load', () => {
          clearTimeout(loadingFallback)
          settle()
        })

        // Place (or move) the "you are here" dot. When the browser reports an
        // accuracy radius we draw it as a circle too, so a rough fix is
        // visibly rough instead of looking like an exact pin. The dot is
        // draggable: if the browser's fix is wrong, drag it to your real spot.
        const placeUserMarker = (LL, lat, lng, accuracy, opts = {}) => {
          const acc =
            Number.isFinite(Number(accuracy)) && Number(accuracy) > 0
              ? Number(accuracy)
              : null
          const manual = Boolean(opts.manual)
          if (userMarkerRef.current) {
            userMarkerRef.current.setLatLng([lat, lng])
            userMarkerRef.current.setPopupContent(
              `<div style="padding:2px 6px">You are here${manual ? ' <b>· set manually</b>' : ''}${acc ? ` · ±${Math.round(acc)} m` : ''}${!manual ? '<br><small style="color:#5f6368">Drag the blue dot to correct it</small>' : ''}</div>`
            )
          } else {
            const icon = LL.divIcon({
              className: 'current-location-pin',
              html: '<div class="pin-core"></div><div class="pin-ring"></div>',
              iconSize: [28, 28],
              iconAnchor: [14, 14],
            })
            userMarkerRef.current = LL.marker([lat, lng], {
              icon,
              zIndexOffset: 900,
              draggable: true,
            })
              .addTo(map)
              .bindPopup(
                `<div style="padding:2px 6px">You are here${manual ? ' <b>· set manually</b>' : ''}${acc ? ` · ±${Math.round(acc)} m` : ''}${!manual ? '<br><small style="color:#5f6368">Drag the blue dot to correct it</small>' : ''}</div>`
              )
            // Drag-to-correct: the browser's geolocation can be wrong (IP
            // fallback / no GPS). Let the user pin their real position.
            userMarkerRef.current.on('dragend', () => {
              const p = userMarkerRef.current.getLatLng()
              manualPositionRef.current = true
              if (watcherRef.current != null && navigator.geolocation) {
                navigator.geolocation.clearWatch(watcherRef.current)
                watcherRef.current = null
              }
              placeUserMarker(LL, p.lat, p.lng, 15, { manual: true })
              const dist = metersBetween(p.lat, p.lng, KEJETIA_CENTER.lat, KEJETIA_CENTER.lng)
              setUserLocation({ lat: p.lat, lng: p.lng, accuracy: 15 })
              setDistanceFromMarket(dist)
              setRemoteBannerDismissed(false)
              if (distanceLineRef.current) { map.removeLayer(distanceLineRef.current); distanceLineRef.current = null }
              if (remoteLabelRef.current) { map.removeLayer(remoteLabelRef.current); remoteLabelRef.current = null }
              map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 16), {
                duration: 0.8,
                easeLinearity: 0.25,
              })
              showNotice('Location set manually — drag the blue dot anytime to correct it.')
            })
          }

          if (userAccuracyRef.current) {
            userAccuracyRef.current.setLatLng([lat, lng])
            if (acc) userAccuracyRef.current.setRadius(acc)
          } else if (acc) {
            userAccuracyRef.current = LL.circle([lat, lng], {
              radius: acc,
              color: '#1a73e8',
              weight: 1,
              opacity: 0.35,
              fillColor: '#1a73e8',
              fillOpacity: 0.08,
              interactive: false,
            }).addTo(map)
          }
        }

        // ── Zoom +/− (bottom right, Google style) ──
        const ZoomControl = L.Control.extend({
          options: { position: 'bottomright' },
          onAdd() {
            const box = L.DomUtil.create('div', 'lm-zoom-ctrl')
            const make = (html, label, fn) => {
              const btn = L.DomUtil.create('button', 'lm-zoom-btn', box)
              btn.innerHTML = html
              btn.title = label
              btn.setAttribute('aria-label', label)
              L.DomEvent.disableClickPropagation(btn)
              L.DomEvent.on(btn, 'click', fn)
            }
            make(ICONS.plus, 'Zoom in', () => map.zoomIn(1, { animate: true }))
            make(ICONS.minus, 'Zoom out', () => map.zoomOut(1, { animate: true }))
            return box
          },
        })
        new ZoomControl().addTo(map)

        // ── Fullscreen ──
        let cssFullscreen = false
        let fullscreenBtn = null
        const syncFullscreenBtn = () => {
          if (!fullscreenBtn) return
          const active = document.fullscreenElement || document.webkitFullscreenElement || cssFullscreen
          fullscreenBtn.innerHTML = active ? ICONS.compress : ICONS.fullscreen
          fullscreenBtn.title = active ? 'Exit fullscreen' : 'Fullscreen'
        }
        const enterCssFullscreen = () => {
          cssFullscreen = true
          containerRef.current?.classList.add('lm-map-fullscreen')
          syncFullscreenBtn()
          requestAnimationFrame(() => map.invalidateSize())
        }
        const exitCssFullscreen = () => {
          cssFullscreen = false
          containerRef.current?.classList.remove('lm-map-fullscreen')
          syncFullscreenBtn()
          requestAnimationFrame(() => map.invalidateSize())
        }
        const FullscreenControl = L.Control.extend({
          options: { position: 'bottomright' },
          onAdd() {
            fullscreenBtn = L.DomUtil.create('button', 'lm-round-btn lm-fullscreen-btn')
            const btn = fullscreenBtn
            btn.innerHTML = ICONS.fullscreen
            btn.title = 'Fullscreen'
            btn.setAttribute('aria-label', 'Fullscreen')
            L.DomEvent.disableClickPropagation(btn)
            L.DomEvent.on(btn, 'click', () => {
              const el = containerRef.current
              if (!el) return
              const isNativeFs = document.fullscreenElement || document.webkitFullscreenElement
              if (isNativeFs || cssFullscreen) {
                if (cssFullscreen) exitCssFullscreen()
                const exit = document.exitFullscreen || document.webkitExitFullscreen
                if (exit) exit.call(document)
                syncFullscreenBtn()
                return
              }
              const req = el.requestFullscreen || el.webkitRequestFullscreen
              if (!req) { enterCssFullscreen(); return }
              let p
              try { p = req.call(el) } catch { p = Promise.reject(new Error('blocked')) }
              if (p && typeof p.catch === 'function') p.catch(() => enterCssFullscreen())
              syncFullscreenBtn()
            })
            return btn
          },
        })
        new FullscreenControl().addTo(map)

        // ── Locate me ──
        let locating = false
        let locateTimer = null

        // One-shot locate: used by the locate button and auto-locate.
        const locateOnce = (btn) => {
          if (locating) return
          if (typeof navigator === 'undefined' || !navigator.geolocation) {
            showNotice(GEO_MESSAGES.unavailable)
            return
          }
          locating = true
          if (btn) btn.classList.add('locating')
          let settled = false
          locateTimer = setTimeout(() => {
            if (settled) return
            settled = true
            locateTimer = null
            locating = false
            if (btn) btn.classList.remove('locating')
            showNotice(GEO_MESSAGES.timeout)
          }, 18000)
          // Accurate fix first; if that fails (no GPS / OS location off), fall
          // back to a coarse Wi‑Fi/IP fix — labelled approximate by its
          // accuracy, never presented as exact.
          locateWithFallback().then(
            (loc) => {
              if (settled) return
              settled = true
              if (locateTimer) clearTimeout(locateTimer)
              locateTimer = null
              locating = false
              if (btn) btn.classList.remove('locating')
              // A real GPS fix replaces any manual correction; re-arm the
              // live watcher if the user had dragged the dot earlier.
              manualPositionRef.current = false
              if (watcherRef.current == null) startFollowWatch()
              const userLat = loc.lat
              const userLng = loc.lng
              placeUserMarker(L, userLat, userLng, loc.accuracy)
              if (loc.fallback) {
                showNotice('Could not get a precise fix — showing an approximate location. Turn on GPS (and be outdoors) for better accuracy.')
              }

              const dist = metersBetween(userLat, userLng, KEJETIA_CENTER.lat, KEJETIA_CENTER.lng)
              setUserLocation({ lat: userLat, lng: userLng, accuracy: loc.accuracy })
              // A rough fix (e.g. IP-based fallback with GPS off) must not be
              // presented as an exact position — show uncertainty instead of
              // claiming a distance or drawing a line to the market.
              const precise = loc.accuracy <= LOW_ACCURACY_M
              if (precise) {
                setDistanceFromMarket(dist)
                setRemoteBannerDismissed(false)
              } else {
                setDistanceFromMarket(null)
                setRemoteBannerDismissed(true)
                if (distanceLineRef.current) { map.removeLayer(distanceLineRef.current); distanceLineRef.current = null }
                if (remoteLabelRef.current) { map.removeLayer(remoteLabelRef.current); remoteLabelRef.current = null }
                showNotice(
                  `Location is only approximate (±${Math.round(loc.accuracy)} m). Turn on GPS (and be outdoors) for a precise fix.`
                )
              }

              if (!precise) {
                map.flyTo([userLat, userLng], Math.max(map.getZoom(), 12), {
                  duration: 0.8,
                  easeLinearity: 0.25,
                })
              } else if (dist > 50000) {
                // Remote user: show BOTH locations
                const userLatLng = L.latLng(userLat, userLng)
                const marketLatLng = L.latLng(KEJETIA_CENTER.lat, KEJETIA_CENTER.lng)
                const bounds = L.latLngBounds([userLatLng, marketLatLng]).pad(0.15)
                map.fitBounds(bounds, { duration: 1.2, easeLinearity: 0.25, maxZoom: 8 })

                if (distanceLineRef.current) map.removeLayer(distanceLineRef.current)
                distanceLineRef.current = L.polyline(
                  [[userLat, userLng], [KEJETIA_CENTER.lat, KEJETIA_CENTER.lng]],
                  { color: '#1a73e8', weight: 2, dashArray: '8, 8', opacity: 0.6 }
                ).addTo(map)

                if (remoteLabelRef.current) map.removeLayer(remoteLabelRef.current)
                const midLat = (userLat + KEJETIA_CENTER.lat) / 2
                const midLng = (userLng + KEJETIA_CENTER.lng) / 2
                const km = (dist / 1000).toFixed(0)
                remoteLabelRef.current = L.marker([midLat, midLng], {
                  icon: L.divIcon({
                    className: 'lm-distance-label',
                    html: `<div class="lm-distance-badge">${km} km</div>`,
                    iconSize: [80, 28],
                    iconAnchor: [40, 14],
                  }),
                  interactive: false,
                }).addTo(map)

                showNotice(`You are about ${km} km from Kejetia Market`)
              } else if (dist > 10000) {
                map.flyTo([userLat, userLng], Math.max(map.getZoom(), 12), {
                  duration: 0.8,
                  easeLinearity: 0.25,
                })
                const km = (dist / 1000).toFixed(1)
                showNotice(`You are ${km} km from Kejetia Market`)
              } else {
                map.flyTo([userLat, userLng], Math.max(map.getZoom(), 16), {
                  duration: 0.8,
                  easeLinearity: 0.25,
                })
                if (distanceLineRef.current) { map.removeLayer(distanceLineRef.current); distanceLineRef.current = null }
                if (remoteLabelRef.current) { map.removeLayer(remoteLabelRef.current); remoteLabelRef.current = null }
              }
            },
            (err) => {
              if (settled) return
              settled = true
              if (locateTimer) clearTimeout(locateTimer)
              locateTimer = null
              locating = false
              if (btn) btn.classList.remove('locating')
              showNotice(describeGeoError(err))
            }
          )
        }

        const LocateControl = L.Control.extend({
          options: { position: 'bottomright' },
          onAdd() {
            const btn = L.DomUtil.create('button', 'lm-round-btn lm-locate-btn')
            btn.innerHTML = ICONS.locate
            btn.title = 'Find my location'
            btn.setAttribute('aria-label', 'Find my location')
            L.DomEvent.disableClickPropagation(btn)
            L.DomEvent.on(btn, 'click', () => locateOnce(btn))
            return btn
          },
        })
        new LocateControl().addTo(map)

        // ── Auto-locate on mount (only when permission was already granted) ──
        if (autoLocate && typeof navigator !== 'undefined' && navigator.geolocation) {
          const tryAutoLocate = () => {
            if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return
            navigator.permissions.query({ name: 'geolocation' })
              .then((status) => { if (status.state === 'granted') locateOnce(null) })
              .catch(() => {})
          }
          tryAutoLocate()
        }

        // ── Layer pill (Map | Satellite | Kejetia), top right ──
        const LayerControl = L.Control.extend({
          options: { position: 'topright' },
          onAdd() {
            const container = L.DomUtil.create('div', 'lm-layer-pill')
            const makeBtn = (key, label) => {
              const btn = L.DomUtil.create('button', 'lm-layer-btn' + (key === DEFAULT_BASE ? ' active' : ''), container)
              btn.textContent = label
              btn.dataset.layer = key
              L.DomEvent.disableClickPropagation(btn)
              L.DomEvent.on(btn, 'click', () => switchBase(key))
              return btn
            }
            makeBtn('streets', 'Map')
            makeBtn('satellite', 'Satellite')
            makeBtn('kejetia', 'Kejetia')
            return container
          },
        })
        new LayerControl().addTo(map)

        // Tap to set a location (seller dashboard).
        map.on('click', (e) => {
          if (onLocationPickRef.current) {
            onLocationPickRef.current({ lat: e.latlng.lat, lng: e.latlng.lng })
          }
        })

        // Bare map: Kejetia centre pin only when explicitly enabled.
        const { showStaticLandmarks: wantStatic, showKejetiaCenter: wantCenter } = staticFlagsRef.current || {}
        if (wantCenter) {
          const kejetiaIcon = L.divIcon({
            className: 'kejetia-center-pin',
            html: `<div class="pin-body kejetia-pin-body">
              <span class="kejetia-icon-text">🏪</span>
            </div><div class="pin-tip"></div>`,
            iconSize: [36, 46],
            iconAnchor: [18, 46],
          })
          kejetiaMarkerRef.current = L.marker(
            [KEJETIA_CENTER.lat, KEJETIA_CENTER.lng],
            { icon: kejetiaIcon, zIndexOffset: 500 }
          )
            .addTo(map)
            .bindPopup('<div style="padding:4px 6px"><strong>Kejetia Market</strong><br>Kumasi, Ghana<br><small>Tap to explore stores inside</small></div>')
        }

        // Legacy KML landmark pins — OFF by default (bare map). Opt in with
        // showStaticLandmarks for debug/legacy views.
        if (wantStatic) {
          const landmarkIcon = L.divIcon({
            className: 'lm-landmark-pin',
            html: '<div class="lm-landmark-dot"></div>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          })
          LANDMARKS.forEach((l) => {
            const m = L.marker([l.lat, l.lng], { icon: landmarkIcon, title: l.name })
              .addTo(map)
              .bindTooltip(l.name, {
                direction: 'top',
                offset: [0, -10],
                opacity: 0.9,
                className: 'lm-landmark-tip',
              })
              .bindPopup(
                `<div style="min-width:200px;padding:4px 0">
                   <strong>${l.name}</strong>
                   <p style="margin:4px 0;color:#5f6368;font-size:12px">${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}</p>
                   <a href="${directionsUrl({ name: l.name, lat: l.lat, lng: l.lng })}" style="display:inline-block;margin-top:6px;padding:6px 14px;background:#1a73e8;color:#fff;border-radius:8px;font-size:12px;text-decoration:none">Directions</a>
                 </div>`
              )
            landmarkMarkersRef.current.push(m)
            // Start hidden — shown via zoom effect
            m.setOpacity(0)
          })
        }

        // ── Follow the user's GPS position ──
        // Re-runnable so "Find my location" can re-arm GPS after the user
        // dragged the dot to a manual position.
        const startFollowWatch = () => {
          if (
            !showUserLocation ||
            typeof navigator === 'undefined' ||
            !navigator.geolocation ||
            !navigator.geolocation.watchPosition
          ) return
          if (watcherRef.current != null) return
          watcherRef.current = navigator.geolocation.watchPosition(
            (pos) => {
              // A manually-set dot stays put until GPS is re-requested.
              if (manualPositionRef.current) return
              placeUserMarker(
                L,
                pos.coords.latitude,
                pos.coords.longitude,
                pos.coords.accuracy
              )
            },
            () => console.warn('Geolocation unavailable or permission denied.'),
            { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
          )
        }
        startFollowWatch()

        // Keep the map sized while toggling fullscreen.
        onFullscreenChange = () => {
          requestAnimationFrame(() => map.invalidateSize())
          syncFullscreenBtn()
        }
        document.addEventListener('fullscreenchange', onFullscreenChange)
        document.addEventListener('webkitfullscreenchange', onFullscreenChange)

        // ── Organic cursor states ──
        map.getContainer().addEventListener('mousedown', () => {
          map.getContainer().style.cursor = 'grabbing'
        })
        map.on('mouseup', () => {
          map.getContainer().style.cursor = 'grab'
        })

        // ── Track zoom for smart visibility ──
        map.on('zoomend', () => {
          setCurrentZoom(map.getZoom())
        })

        requestAnimationFrame(() => map.invalidateSize())
        loadedRef.current = true
        setMapReady(true)
        setMapLoading(false)
      } catch (err) {
        if (!cancelled) {
          setMapError(err.message || 'Failed to initialize map')
          setMapLoading(false)
        }
      }
    }

    init()

    return () => {
      cancelled = true
      if (watcherRef.current != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watcherRef.current)
      }
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
      if (onFullscreenChange) {
        document.removeEventListener('fullscreenchange', onFullscreenChange)
        document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
      }
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove()
        mapInstanceRef.current = null
      }
    }
  }, [initNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Retry handler ──
  const handleRetry = useCallback(() => {
    // The error state unmounts the Leaflet container; bumping the nonce makes
    // the init effect run again on a fresh container instead of leaving a
    // permanently blank map.
    setMapError(null)
    setMapLoading(true)
    loadedRef.current = false
    setMapReady(false)
    setInitNonce((n) => n + 1)
  }, [])

  // Keep the map sized to its container.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const invalidate = () => mapInstanceRef.current?.invalidateSize()
    const ro = new ResizeObserver(invalidate)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Reposition/focus when centre + zoom supplied.
  useEffect(() => {
    if (!center || !mapReady) return
    mapInstanceRef.current.flyTo([center.lat, center.lng], zoom || 16, {
      duration: 0.6,
      easeLinearity: 0.25,
    })
  }, [center?.lat, center?.lng, zoom, mapReady])

  // ── Sync React-driven layer pill with the map ──
  useEffect(() => {
    document.querySelectorAll('.lm-layer-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.layer === activeBase)
    })
  }, [activeBase])

  // ── Smart visibility: ONLY legacy KML dots hide by zoom. User photo
  // landmarks (the user-drawn map) stay at full opacity at every zoom so a
  // newly added store-front pin is never invisible.
  useEffect(() => {
    landmarkMarkersRef.current.forEach((m) => {
      m.setOpacity(currentZoom >= ZOOM_LANDMARKS ? 1 : 0)
    })
    Object.values(landmarkPhotoByIdRef.current).forEach((m) => {
      m.setOpacity(1)
    })
  }, [currentZoom])

  // ── Kejetia marker label: bigger at national zoom ──
  useEffect(() => {
    if (!kejetiaMarkerRef.current || !leafletRef.current) return
    const el = kejetiaMarkerRef.current.getElement()
    if (!el) return
    if (currentZoom < 10) {
      el.style.transform = 'scale(1.3)'
      el.style.filter = 'drop-shadow(0 2px 8px rgba(252, 209, 22, 0.6))'
    } else {
      el.style.transform = ''
      el.style.filter = ''
    }
  }, [currentZoom])

  // ── User location dots with clustering ──
  useEffect(() => {
    const map = mapInstanceRef.current
    const L = leafletRef.current
    if (!map || !L || !mapReady) return

    // Always clear first — even when empty, so expired dots disappear.
    clusterLayersRef.current.forEach((l) => map.removeLayer(l))
    clusterLayersRef.current = []
    userDotsRef.current.forEach((l) => map.removeLayer(l))
    userDotsRef.current = []
    if (!userLocations.length) return

    const clusters = clusterPoints(userLocations, currentZoom)

    clusters.forEach((cluster) => {
      if (cluster.count === 1) {
        // Single user — blue dot
        const user = cluster.items[0]
        const icon = L.divIcon({
          className: 'lm-user-dot',
          html: '<div class="lm-user-dot-core"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        })
        const m = L.marker([cluster.lat, cluster.lng], { icon, zIndexOffset: 100 })
          .addTo(map)
          .bindPopup(
            `<div style="padding:4px 8px;font-size:13px">
              <strong>${user.name || 'User'}</strong><br>
              <span style="color:#5f6368">${user.city || 'Ghana'}</span>
            </div>`
          )
        userDotsRef.current.push(m)
      } else {
        // Cluster — bigger circle with count
        const radius = Math.min(40, 18 + cluster.count * 2)
        const icon = L.divIcon({
          className: 'lm-user-cluster',
          html: `<div class="lm-cluster-circle" style="width:${radius}px;height:${radius}px">
            <span class="lm-cluster-count">${cluster.count}</span>
          </div>`,
          iconSize: [radius, radius],
          iconAnchor: [radius / 2, radius / 2],
        })
        const m = L.marker([cluster.lat, cluster.lng], { icon, zIndexOffset: 50 })
          .addTo(map)
          .bindPopup(
            `<div style="padding:4px 8px;font-size:13px">
              <strong>${cluster.count} users</strong> in this area<br>
              <span style="color:#5f6368">Zoom in to see individual locations</span>
            </div>`
          )
        clusterLayersRef.current.push(m)
      }
    })
  }, [userLocations, currentZoom, mapReady])

  // ── Breadcrumb trails: users draw the map by walking ──
  // One fading polyline per user from the last 24h of crumbs. Dots show
  // where people ARE; trails show where people WENT (walkways emerge).
  useEffect(() => {
    const map = mapInstanceRef.current
    const L = leafletRef.current
    if (!map || !L || !mapReady) return
    trailLayersRef.current.forEach((l) => map.removeLayer(l))
    trailLayersRef.current = []
    if (!showTrails || !Array.isArray(trails) || !trails.length) return
    trails.forEach((t) => {
      const path = Array.isArray(t.path) ? t.path.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])) : []
      if (path.length < 2) return
      // Halo + core so trails read on both streets and satellite.
      trailLayersRef.current.push(
        L.polyline(path, { color: '#fff', weight: 7, opacity: 0.85, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map)
      )
      trailLayersRef.current.push(
        L.polyline(path, { color: '#1a73e8', weight: 3.5, opacity: 0.75, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map)
      )
    })
  }, [trails, showTrails, mapReady])

  // Store pins from the database (diffed).
  useEffect(() => {
    const map = mapInstanceRef.current
    const L = leafletRef.current
    if (!map || !L || !mapReady) return

    const seen = new Set()
    stores.forEach((store) => {
      const lat = Number(store.latitude)
      const lng = Number(store.longitude)
      if (!lat || !lng) return
      seen.add(store.id)

      const existing = markerByIdRef.current[store.id]
      if (existing) {
        existing.setLatLng([lat, lng])
        return
      }

      const icon = L.divIcon({
        className: 'lm-store-pin',
        html: '<div class="pin-body"></div>',
        iconSize: [34, 44],
        iconAnchor: [17, 41],
        popupAnchor: [0, -36],
      })

      const marker = L.marker([lat, lng], { icon, title: store.name, zIndexOffset: 10 })
      if (onStoreClickRef.current) {
        marker.on('click', () => onStoreClickRef.current(store))
      } else {
        marker.bindPopup(placeCard(store), { closeButton: true, autoPanPadding: [40, 40] })
      }
      marker.addTo(map)
      markersRef.current.push(marker)
      markerByIdRef.current[store.id] = marker
    })

    Object.keys(markerByIdRef.current).forEach((id) => {
      if (seen.has(id)) return
      const m = markerByIdRef.current[id]
      map.removeLayer(m)
      delete markerByIdRef.current[id]
      markersRef.current = markersRef.current.filter((x) => x !== m)
    })
  }, [stores, mapReady])

  // ── User photo-landmark pins (store fronts, spots) ──
  useEffect(() => {
    const map = mapInstanceRef.current
    const L = leafletRef.current
    if (!map || !L || !mapReady) return

    const seen = new Set()
    ;(Array.isArray(landmarks) ? landmarks : []).forEach((l) => {
      const lat = Number(l.latitude)
      const lng = Number(l.longitude)
      if (!lat || !lng) return
      seen.add(l.id)

      const existing = landmarkPhotoByIdRef.current[l.id]
      if (existing) {
        existing.setLatLng([lat, lng])
        return
      }

      const bg = l.photo_url ? `url('${l.photo_url}')` : 'linear-gradient(135deg,#f59e0b,#ea580c)'
      const icon = L.divIcon({
        className: 'lm-photo-pin',
        html: `<div class="lm-photo-frame" style="background-image:${bg}"></div><div class="lm-photo-tip"></div>`,
        iconSize: [40, 45],
        iconAnchor: [20, 44],
        popupAnchor: [0, -40],
      })

      const marker = L.marker([lat, lng], { icon, title: l.name, zIndexOffset: 300 })
        .addTo(map)
        .bindTooltip(l.name, {
          direction: 'top',
          offset: [0, -14],
          opacity: 0.9,
          className: 'lm-landmark-tip',
        })
        .bindPopup(landmarkCard(l), { maxWidth: 300, autoPanPadding: [40, 40] })
      landmarkPhotoByIdRef.current[l.id] = marker
      marker.setOpacity(1)
    })

    Object.keys(landmarkPhotoByIdRef.current).forEach((id) => {
      if (seen.has(id)) return
      const m = landmarkPhotoByIdRef.current[id]
      map.removeLayer(m)
      delete landmarkPhotoByIdRef.current[id]
    })
  }, [landmarks, mapReady])

  // Highlight + open the selected store.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapReady) return

    Object.entries(markerByIdRef.current).forEach(([id, m]) => {
      m.getElement()?.classList.toggle('active', id === selectedStoreId)
    })

    const selected = markerByIdRef.current[selectedStoreId]
    if (selected) {
      selected.setZIndexOffset(1000)
      if (!onStoreClickRef.current) selected.openPopup()
    }
  }, [selectedStoreId, mapReady, stores])

  // Fly to the selected store.
  useEffect(() => {
    const map = mapInstanceRef.current
    const marker = markerByIdRef.current[selectedStoreId]
    if (!map || !selectedStoreId || !marker || !mapReady) return
    if (navTrip) return
    const pos = marker.getLatLng()
    map.flyTo([pos.lat, pos.lng], Math.max(map.getZoom(), 17), {
      duration: 0.8,
      easeLinearity: 0.25,
    })
  }, [selectedStoreId, mapReady, navTrip])

  // Live navigation.
  useEffect(() => {
    if (!navTrip) {
      setNav(null)
      return undefined
    }
    const map = mapInstanceRef.current
    if (!map) return undefined

    const pts = []
    ;(navTrip.legs || []).forEach((leg) => {
      ;(leg.path || []).forEach((p) => {
        const last = pts[pts.length - 1]
        if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p)
      })
    })
    const cum = [0]
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + metersBetween(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]))
    }
    const total = cum[cum.length - 1] || 1
    const stepCum = []
    let acc = 0
    ;(navTrip.steps || []).forEach((s) => {
      acc += s.meters || 0
      stepCum.push(acc)
    })
    const mPerMin = total / Math.max(1, navTrip.minutes * 60)

    const update = () => {
      const m = mapInstanceRef.current
      const um = userMarkerRef.current
      if (!m || !um) return
      const pos = um.getLatLng()
      let best = 0
      let bestD = Infinity
      for (let i = 0; i < pts.length; i++) {
        const d = metersBetween(pos.lat, pos.lng, pts[i][0], pts[i][1])
        if (d < bestD) { bestD = d; best = i }
      }
      const travelled = Math.min(total, cum[best] + bestD)
      const remaining = Math.max(0, total - travelled)
      let stepIdx = 0
      for (let i = 0; i < stepCum.length; i++) {
        if (travelled >= stepCum[i]) stepIdx = i
      }
      const arrived = remaining < 20
      setNav({
        instruction: navTrip.steps[Math.min(stepIdx, navTrip.steps.length - 1)]?.text || 'Continue',
        metersRemaining: Math.round(remaining),
        minutesRemaining: Math.max(1, Math.round(remaining / Math.max(1, mPerMin) / 60)),
        arrived,
      })
      const c = m.getCenter()
      if (!arrived && metersBetween(pos.lat, pos.lng, c.lat, c.lng) > 60) {
        m.setView([pos.lat, pos.lng], Math.max(m.getZoom(), 16), { animate: true })
      }
      const inside = isInMarket(pos.lat, pos.lng)
      if (inside && activeBase !== 'kejetia') switchBase('kejetia')
      if (!inside && activeBase === 'kejetia') switchBase('streets')
    }

    update()
    const iv = setInterval(update, 2500)
    return () => clearInterval(iv)
  }, [navTrip, activeBase, switchBase])

  // Route drawing.
  useEffect(() => {
    const map = mapInstanceRef.current
    const L = leafletRef.current
    if (!map || !L || !mapReady) return

    routeLayersRef.current.forEach((l) => map.removeLayer(l))
    routeLayersRef.current = []

    const drawLegs = (legs) => {
      ;(legs || []).forEach((leg) => {
        if (!leg.path || leg.path.length < 2) return
        const walk = leg.mode === 'walk'
        routeLayersRef.current.push(
          L.polyline(leg.path, { color: '#fff', weight: 9, opacity: 0.9, lineCap: 'round' }).addTo(map)
        )
        routeLayersRef.current.push(
          L.polyline(leg.path, {
            color: '#4285F4',
            weight: 4,
            opacity: 0.9,
            lineCap: 'round',
            dashArray: walk ? '6, 8' : null,
          }).addTo(map)
        )
      })
    }

    if (navTrip) {
      drawLegs(navTrip.legs)
      setRouteInfo(null)
    } else if (routes) {
      drawLegs(routes.legs)
      setRouteInfo(null)
    } else if (selectedStoreId) {
      const store = stores.find((s) => s.id === selectedStoreId)
      const lat = Number(store?.latitude)
      const lng = Number(store?.longitude)
      if (store && lat && lng) {
        const route = routeInMarket(KEJETIA_CENTER.lat, KEJETIA_CENTER.lng, lat, lng, store.name)
        if (route && route.path.length > 1) drawLegs([{ path: route.path, mode: 'walk' }])
        setRouteInfo({ ...route, name: store.name })
      } else {
        setRouteInfo(null)
      }
    } else {
      setRouteInfo(null)
    }
  }, [selectedStoreId, stores, routes, navTrip, mapReady])

  // Seller dashboard / general selected location pin.
  useEffect(() => {
    const map = mapInstanceRef.current
    const L = leafletRef.current
    if (!map || !L || !mapReady) return

    if (selectedPin) {
      const lat = Number(selectedPin.lat)
      const lng = Number(selectedPin.lng)
      if (selectedPinMarkerRef.current) {
        selectedPinMarkerRef.current.setLatLng([lat, lng])
      } else {
        const icon = L.divIcon({
          className: 'lm-selected-pin',
          html: `<div class="lm-selected-body"></div>${flyIconCss(-4)}`,
          iconSize: [30, 44],
          iconAnchor: [15, 44],
        })
        selectedPinMarkerRef.current = L.marker([lat, lng], { icon }).addTo(map).bindPopup('Store location')
      }
    } else if (selectedPinMarkerRef.current) {
      map.removeLayer(selectedPinMarkerRef.current)
      selectedPinMarkerRef.current = null
    }
  }, [selectedPin?.lat, selectedPin?.lng, mapReady])

  // ── Fly to Kejetia handler ──
  const flyToKejetia = useCallback(() => {
    const map = mapInstanceRef.current
    if (!map) return
    map.flyTo([KEJETIA_CENTER.lat, KEJETIA_CENTER.lng], 16, {
      duration: 1.5,
      easeLinearity: 0.25,
    })
  }, [])

  // Whether to show the "Fly to Kejetia" button (when zoomed out past the market)
  const showFlyToKejetia = currentZoom < ZOOM_KEJETIA_OVERLAY

  // User dot count summary
  const userCount = userLocations.length

  // ── Error state ──
  if (mapError) {
    return (
      <div
        ref={containerRef}
        className="lm-map-wrap"
        style={{ position: 'relative', width: '100%', height, borderRadius: 12, overflow: 'hidden', zIndex: 0 }}
      >
        <MapError message={mapError} onRetry={handleRetry} />
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="lm-map-wrap"
      style={{ position: 'relative', width: '100%', height, borderRadius: 12, overflow: 'hidden', zIndex: 0, cursor: 'grab' }}
    >
      <div ref={mapRef} style={{ width: '100%', height: '100%' }} />

      {/* Loading skeleton */}
      {mapLoading && <MapSkeleton />}

      {/* Fly to Kejetia button — visible when zoomed out */}
      {showFlyToKejetia && mapReady && (
        <button className="lm-fly-kejetia" onClick={flyToKejetia} title="Fly to Kejetia Market">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>Kejetia Market</span>
        </button>
      )}

      {/* User count pill — visible when zoomed out */}
      {userCount > 0 && currentZoom < 12 && mapReady && (
        <div className="lm-user-count-pill">
          <div className="lm-user-count-dot" />
          <span>{userCount} user{userCount !== 1 ? 's' : ''} on the map</span>
        </div>
      )}

      {/* Navigation banner */}
      {nav && (
        <div className="gm-nav">
          <div className="gm-nav-row">
            <span className="gm-nav-instr">
              {nav.arrived ? '🎉 You have arrived at your destination' : nav.instruction}
            </span>
            {onNavEnd && (
              <button className="gm-nav-end" onClick={() => onNavEnd?.()}>End</button>
            )}
          </div>
          {!nav.arrived && (
            <div className="gm-nav-meta">
              {nav.minutesRemaining} min · {nav.metersRemaining} m remaining
            </div>
          )}
        </div>
      )}

      {/* In-market directions card */}
      {routeInfo && selectedStoreId && (
        <div className="lm-dir-card">
          <button className="lm-dir-close" onClick={() => setRouteInfo(null)} aria-label="Close directions" title="Close directions">×</button>
          <div className="lm-dir-title">Walk to {routeInfo.name}</div>
          <div className="lm-dir-meta">🚶 {routeInfo.minutes} min · {routeInfo.meters} m</div>
          <ol className="lm-dir-steps">
            {routeInfo.steps.map((s, i) => (
              <li key={i}>{s.text}</li>
            ))}
          </ol>
          {activeBase !== 'kejetia' && (
            <div className="lm-dir-tip">Tip: switch to the Kejetia view to see the walkways</div>
          )}
        </div>
      )}

      {/* Remote user banner */}
      {distanceFromMarket && !remoteBannerDismissed && distanceFromMarket > 10000 && (
        <div className="lm-remote-banner">
          <button className="lm-remote-close" onClick={() => setRemoteBannerDismissed(true)} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
          <div className="lm-remote-header">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/></svg>
            <span className="lm-remote-distance">
              {distanceFromMarket >= 1000000
                ? `${(distanceFromMarket / 1000000).toFixed(1)}M km away`
                : distanceFromMarket >= 1000
                ? `${(distanceFromMarket / 1000).toFixed(0)} km away`
                : `${Math.round(distanceFromMarket)} m away`}
            </span>
          </div>
          <div className="lm-remote-sub">Kejetia Market, Kumasi, Ghana</div>
          <div className="lm-remote-actions">
            <button className="lm-remote-btn lm-remote-btn-primary" onClick={flyToKejetia}>
              Fly to Market
            </button>
            <a
              className="lm-remote-btn"
              href={directionsUrl({
                name: 'Kejetia Market',
                lat: KEJETIA_CENTER.lat,
                lng: KEJETIA_CENTER.lng,
                origin: userLocation ? 'My location' : undefined,
                originLat: userLocation?.lat,
                originLng: userLocation?.lng,
              })}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>
              Directions
            </a>
            <button className="lm-remote-btn" onClick={() => {
              const map = mapInstanceRef.current
              if (map) map.flyTo([KEJETIA_CENTER.lat, KEJETIA_CENTER.lng], 17, { duration: 1.2, easeLinearity: 0.25 })
            }}>
              Browse Stores
            </button>
          </div>
        </div>
      )}

      {/* Notice toast */}
      {notice && <div className="lm-map-notice">{notice}</div>}
    </div>
  )
}
