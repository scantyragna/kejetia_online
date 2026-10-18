// Kejetia in-market walkway graph + routing.
//
// This is the "last mile" navigation layer: routing INSIDE Kejetia Market —
// exactly the part Google Maps cannot do (no street addresses, no walking
// paths through the stalls). Combined with hop 1 (road routing to the market,
// e.g. Google Directions) this gives full "your location -> any store" trips.
//
// The graph is a seeded skeleton:
//   - Nodes come from the KML landmarks plus the market centre hub.
//   - Walkway edges are auto-generated between each node's nearest neighbours
//     so routing works out of the box.
//
// To make routes accurate, replace the auto skeleton with real walkways
// traced on the ground — see docs/market-data-collection.md. Drop traced
// nodes/edges into EXTRA_NODES / EXPLICIT_EDGES below and they take
// precedence over the auto edges (an explicit edge between two nodes
// suppresses the auto straight edge between them).

import { KEJETIA_CENTER } from './map-geo.js'

// ---------------------------------------------------------------------------
// Graph nodes (real lat/lng)
// ---------------------------------------------------------------------------
export const NODES = [
  { id: 'center', name: 'Kejetia Market Center', lat: KEJETIA_CENTER.lat, lng: KEJETIA_CENTER.lng },
  { id: 'mtn-kejetia', name: 'MTN Kejetia', lat: 6.7013732, lng: -1.6239055 },
  { id: 'costa-pharmacy', name: 'Costa Pharmacy', lat: 6.6985695, lng: -1.6248983 },
  { id: 'kejetia-ko', name: 'Kejetia K.O', lat: 6.6992577, lng: -1.6215281 },
  { id: 'new-market-bus-terminal', name: 'New Market Bus Terminal', lat: 6.698037, lng: -1.6219142 },
  { id: 'kejetia-pz', name: 'Kejetia PZ', lat: 6.6965156, lng: -1.6217816 },
  { id: 'kejetia-motor-park', name: 'Kejetia Motor Park', lat: 6.6989108, lng: -1.6235637 },
  { id: 'kejetia-mall', name: 'Kejetia Mall', lat: 6.6999001, lng: -1.6246492 },
  { id: 'kejetia-roundabout', name: 'Kejetia Roundabout', lat: 6.7009696, lng: -1.6240544 },
  { id: 'kejetia-dubai', name: 'Kejetia Dubai', lat: 6.700346, lng: -1.617822 },
  { id: 'quality-skincare', name: 'Quality Skincare', lat: 6.6986734, lng: -1.6232407 },
]

// Walkway nodes traced on the ground (see docs/market-data-collection.md).
// Each entry is a node; connect them up with EXPLICIT_EDGES.
export const EXTRA_NODES = []

// Real walkway connections between node ids, e.g.
//   { from: 'new-market-bus-terminal', to: 'center' }
// When an explicit edge exists between two nodes the auto-seeded straight
// edge between them is dropped, so traced walkways win over the skeleton.
export const EXPLICIT_EDGES = []

// ---------------------------------------------------------------------------
// Build the graph
// ---------------------------------------------------------------------------
const ALL_NODES = [...NODES, ...EXTRA_NODES]
const nodeById = {}
ALL_NODES.forEach((n) => { nodeById[n.id] = n })

// Haversine distance in metres.
export function metersBetween(aLat, aLng, bLat, bLng) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

const nodeMeters = (a, b) => metersBetween(a.lat, a.lng, b.lat, b.lng)

const explicitPairs = new Set(
  EXPLICIT_EDGES.map(({ from, to }) => [from, to].sort().join('|'))
)

// Auto-seed: connect each node to its 3 nearest neighbours (skip explicit pairs).
const adj = {}
ALL_NODES.forEach((n) => { adj[n.id] = [] })
const addEdge = (aId, bId, w) => {
  adj[aId].push({ to: bId, w })
  adj[bId].push({ to: aId, w })
}
ALL_NODES.forEach((a) => {
  const neighbours = ALL_NODES
    .filter((b) => b.id !== a.id)
    .map((b) => ({ b, d: nodeMeters(a, b) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 3)
  neighbours.forEach(({ b, d }) => {
    const pair = [a.id, b.id].sort().join('|')
    if (explicitPairs.has(pair)) return
    addEdge(a.id, b.id, d)
  })
})
// Guarantee the market centre can reach everything.
ALL_NODES.forEach((n) => {
  if (n.id !== 'center' && !explicitPairs.has(['center', n.id].sort().join('|'))) {
    addEdge('center', n.id, nodeMeters(nodeById.center, n))
  }
})

// Snapshot of the auto-seeded skeleton, kept so community walkways can
// suppress the straight-line guesses they replace (see registerCommunityWalkways).
const SKELETON_EDGES = []
Object.entries(adj).forEach(([fromId, list]) => {
  list.forEach(({ to, w }) => {
    if (fromId < to) SKELETON_EDGES.push({ from: fromId, to, w })
  })
})

// ---------------------------------------------------------------------------
// Community walkways — the Map Studio payoff.
//
// Confirmed walkways (status = 'published', gathered on foot in the studio)
// are injected into this graph at runtime, so every approved session makes
// everybody's in-market directions more accurate. Two things happen per
// walkway:
//   1. Its vertices become real nodes, connected edge-to-edge with true
//      Haversine lengths. (The seeded skeleton only knows 11 KML points and
//      connects them with straight lines through walls.)
//   2. Any skeleton edge the walkway shadows — both its endpoints lying
//      within SHADOW_M of the traced polyline — is removed, because a traced
//      path is ground truth and the straight chord it replaces was a guess.
// Stairs are weighted higher so routing prefers a level walk when one
// exists, the way people actually move through a market.
// ---------------------------------------------------------------------------
const SHADOW_M = 45
const STAIRS_WEIGHT = 2.5
const registeredCommunityIds = new Set()

function pointToPolylineM(lat, lng, line) {
  // Distance from a point to a polyline (segment-wise min).
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const d = pointToSegmentM(lat, lng, line[i - 1], line[i])
    if (d < best) best = d
  }
  return best
}

function pointToSegmentM(lat, lng, a, b) {
  // Planar approximation is fine at market scale (~1.5 km).
  const mPerLat = 111320
  const mPerLng = 111320 * Math.cos((lat * Math.PI) / 180)
  const ax = a[1] * mPerLng, ay = a[0] * mPerLat
  const bx = b[1] * mPerLng, by = b[0] * mPerLat
  const px = lng * mPerLng, py = lat * mPerLat
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

// Remove a community node: drop it from the graph and every edge touching it.
function removeCommunityNode(id) {
  delete adj[id]
  delete nodeById[id]
  const idx = ALL_NODES.findIndex((n) => n.id === id)
  if (idx >= 0) ALL_NODES.splice(idx, 1)
  Object.keys(adj).forEach((k) => {
    adj[k] = adj[k].filter((e) => e.to !== id)
  })
}

/**
 * Merge confirmed community walkways into the routing graph.
 * Idempotent: re-calling with the same list is a no-op; re-calling after an
 * admin publishes/updates a walkway re-registers just that one.
 *
 * @param {Array} walkways rows with { id, kind, name, geometry }
 *        (geometry: [[lat,lng], …] or a JSON string, as stored).
 */
export function registerCommunityWalkways(walkways) {
  const list = Array.isArray(walkways) ? walkways : []
  const seen = new Set()

  list.forEach((w) => {
    if (!w?.id) return
    seen.add(w.id)
    if (registeredCommunityIds.has(w.id)) return
    let geom = w.geometry
    if (typeof geom === 'string') {
      try { geom = JSON.parse(geom) } catch { return }
    }
    if (!Array.isArray(geom) || geom.length < 2) return
    const pts = geom
      .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : null))
      .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    if (pts.length < 2) return

    const prefix = `cw-${w.id}`
    const factor = w.kind === 'stairs' ? STAIRS_WEIGHT : 1
    const label = w.name || w.kind || 'walkway'

    // 1. Suppress the skeleton chords this walkway replaces.
    SKELETON_EDGES.forEach((e) => {
      const a = nodeById[e.from]
      const b = nodeById[e.to]
      if (!a || !b) return
      if (
        pointToPolylineM(a.lat, a.lng, pts) <= SHADOW_M &&
        pointToPolylineM(b.lat, b.lng, pts) <= SHADOW_M
      ) {
        adj[e.from] = (adj[e.from] || []).filter((x) => x.to !== e.to)
        adj[e.to] = (adj[e.to] || []).filter((x) => x.to !== e.from)
      }
    })

    // 2. Add the traced vertices as nodes, wired end to end.
    const ids = []
    pts.forEach(([lat, lng], i) => {
      const id = `${prefix}-${i}`
      if (!nodeById[id]) {
        const node = { id, name: label, lat, lng }
        ALL_NODES.push(node)
        nodeById[id] = node
        adj[id] = []
      }
      ids.push(id)
    })
    for (let i = 1; i < ids.length; i++) {
      const wgt = nodeMeters(nodeById[ids[i - 1]], nodeById[ids[i]]) * factor
      addEdge(ids[i - 1], ids[i], Math.max(1, wgt))
    }

    // 3. Let the walkway's endpoints act as entry/exit points: connect each
    //    end to whichever existing node is closest, so a shopper's GPS fix
    //    can hop onto the traced path.
    ;[ids[0], ids[ids.length - 1]].forEach((endId) => {
      const end = nodeById[endId]
      let best = null
      let bestD = Infinity
      ALL_NODES.forEach((n) => {
        if (n.id === endId || n.id.startsWith(`${prefix}-`)) return
        const d = nodeMeters(end, n)
        if (d < bestD) { bestD = d; best = n }
      })
      if (best && bestD < 120) addEdge(endId, best.id, bestD)
    })

    registeredCommunityIds.add(w.id)
  })

  // A walkway the admin later rejected/removed leaves the graph again.
  registeredCommunityIds.forEach((id) => {
    if (seen.has(id)) return
    registeredCommunityIds.delete(id)
    ALL_NODES.filter((n) => n.id.startsWith(`cw-${id}-`)).forEach((n) => removeCommunityNode(n.id))
  })
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
export function nearestNode(lat, lng) {
  let best = null
  let bestD = Infinity
  ALL_NODES.forEach((n) => {
    const d = metersBetween(lat, lng, n.lat, n.lng)
    if (d < bestD) {
      bestD = d
      best = n
    }
  })
  return best
}

// Classic Dijkstra over the (small) graph.
function dijkstra(startId, endId) {
  const dist = {}
  const prev = {}
  const done = new Set()
  ALL_NODES.forEach((n) => { dist[n.id] = Infinity })
  dist[startId] = 0
  for (;;) {
    let cur = null
    let best = Infinity
    ALL_NODES.forEach((n) => {
      if (!done.has(n.id) && dist[n.id] < best) {
        best = dist[n.id]
        cur = n.id
      }
    })
    if (cur === null || cur === endId) break
    done.add(cur)
    ;(adj[cur] || []).forEach(({ to, w }) => {
      if (done.has(to)) return
      const nd = dist[cur] + w
      if (nd < dist[to]) {
        dist[to] = nd
        prev[to] = cur
      }
    })
  }
  if (dist[endId] === Infinity) return null
  const path = [endId]
  let cur = endId
  while (cur !== startId) {
    cur = prev[cur]
    path.unshift(cur)
  }
  return path
}

// ---------------------------------------------------------------------------
// Turn-by-turn instructions
// ---------------------------------------------------------------------------
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

function initialBearing(a, b) {
  const toRad = (d) => (d * Math.PI) / 180
  const toDeg = (r) => (r * 180) / Math.PI
  const f1 = toRad(a.lat)
  const f2 = toRad(b.lat)
  const dl = toRad(b.lng - a.lng)
  const y = Math.sin(dl) * Math.cos(f2)
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

const bearingToDir = (b) => DIRS[Math.round(b / 45) % 8]

// Signed turn between two bearings: 'left' | 'right' | 'straight'.
function turnDir(from, to) {
  let d = (to - from) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  if (Math.abs(d) < 20) return 'straight'
  return d > 0 ? 'right' : 'left'
}

function buildSteps(nodePath, toName) {
  const steps = []
  let acc = 0
  let accDir = null
  let lastBearing = null
  for (let i = 0; i < nodePath.length - 1; i++) {
    const a = nodeById[nodePath[i]]
    const b = nodeById[nodePath[i + 1]]
    const m = Math.max(5, Math.round(nodeMeters(a, b) / 5) * 5)
    const bearing = initialBearing(a, b)
    if (lastBearing === null) {
      acc = m
      accDir = bearingToDir(bearing)
      lastBearing = bearing
      continue
    }
    const turn = turnDir(lastBearing, bearing)
    if (turn === 'straight') {
      acc += m
    } else {
      steps.push({ text: `Head ${accDir} for ${acc} m`, meters: acc })
      steps.push({ text: `Turn ${turn} at ${a.name}`, meters: 0 })
      acc = m
      accDir = bearingToDir(bearing)
    }
    lastBearing = bearing
  }
  if (acc > 0) steps.push({ text: `Head ${accDir} for ${acc} m`, meters: acc })
  steps.push({ text: `Arrive at ${toName}`, meters: 0 })
  return steps
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// Route from any point to any point through the market walkways.
// Returns { path: [[lat,lng],...], meters, minutes, steps } or null.
export function routeInMarket(fromLat, fromLng, toLat, toLng, toName = 'your destination') {
  const start = nearestNode(fromLat, fromLng)
  const end = nearestNode(toLat, toLng)
  const ids = dijkstra(start.id, end.id)
  if (!ids) return null

  const path = ids.map((id) => [nodeById[id].lat, nodeById[id].lng])
  path.push([toLat, toLng]) // the exact destination (the stall itself)

  let total = 0
  for (let i = 0; i < path.length - 1; i++) {
    total += metersBetween(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1])
  }

  return {
    path,
    meters: Math.round(total),
    minutes: Math.max(1, Math.round(total / 78)), // ~78 m/min walking
    steps: buildSteps(ids, toName),
  }
}
