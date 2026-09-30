// Browser-geolocation helper with a graceful fallback chain and
// human-readable failure messages.
//
// Why a chain: `getCurrentPosition({ enableHighAccuracy: true })` can hang or
// fail outright on laptops/desktops — Windows privacy "Location" off, no GPS
// chip, VPN, etc. We try an accurate fix first, then a standard (coarse) one.
// A rough fix the browser can usually work out (Wi‑Fi / cell towers / IP) is
// far better than "location unknown", and the accuracy value lets the map draw
// an honest uncertainty circle around it.

export const GEO_MESSAGES = {
  unavailable: 'Location is not supported in this browser.',
  denied:
    'Location access was blocked. Allow “Location” for this site in your browser, ' +
    'and on Windows: Settings → Privacy & security → Location.',
  unavailableOs:
    'The browser could not get your location. On Windows check Settings → ' +
    'Privacy & security → Location, then try again.',
  timeout:
    'Getting your location timed out. Check your device/browser location settings and try again.',
}

// Turn a GeolocationPositionError into a short, actionable message.
export function describeGeoError(err) {
  if (!err) return GEO_MESSAGES.unavailable
  const code = Number(err.code)
  if (code === 1) return GEO_MESSAGES.denied
  if (code === 2) return GEO_MESSAGES.unavailableOs
  if (code === 3) return GEO_MESSAGES.timeout
  return err.message || GEO_MESSAGES.unavailable
}

// Cold GPS starts routinely take longer than 8 s (first fix outdoors is
// often 10–20 s), so the accurate attempt gets 12 s before the coarse leg
// takes over — a real GPS fix is worth waiting for, it is the difference
// between a ±10 m dot and a ±1 km guess. The coarse leg stays short.
const HIGH_ACCURACY_OPTS = { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
const STANDARD_OPTS = { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }

function getOnce(opts) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('navigator.geolocation unavailable'))
      return
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, opts)
  })
}

/**
 * locateWithFallback() → { lat, lng, accuracy, fallback }
 *   lat/lng  — the fix
 *   accuracy — metres (rough estimates are reported as such)
 *   fallback — true when the accurate attempt failed and a coarse fix was used
 * Throws a GeolocationPositionError if both attempts fail (or permission is
 * denied — a hard denial is never retried with a different accuracy).
 */
export async function locateWithFallback() {
  try {
    const pos = await getOnce(HIGH_ACCURACY_OPTS)
    const accuracy = Number(pos.coords.accuracy) > 0 ? Number(pos.coords.accuracy) : 50
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy, fallback: false }
  } catch (err) {
    // A hard denial is a hard denial — do not loop or downgrade it.
    if (Number(err?.code) === 1) throw err
    try {
      const pos = await getOnce(STANDARD_OPTS)
      const accuracy = Number(pos.coords.accuracy) > 0 ? Number(pos.coords.accuracy) : 1500
      return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy, fallback: true }
    } catch (err2) {
      throw err2 || err
    }
  }
}