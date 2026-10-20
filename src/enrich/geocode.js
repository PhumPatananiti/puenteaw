// Models know roughly where places are; OpenStreetMap (via Photon) knows
// exactly. Snap a stop to the OSM match only when it is near the model's
// guess, so a same-named place in another city never wins.
import { getJson, memo, distanceKm } from './http.js'

const lookup = memo(async (query, lat, lng) => {
  const bias = lat && lng ? `&lat=${lat}&lon=${lng}` : ''
  const j = await getJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1${bias}`)
  const f = j?.features?.[0]
  if (!f?.geometry?.coordinates) return null
  const [lon, la] = f.geometry.coordinates
  return { lat: la, lng: lon }
})

/** Returns { lat, lng, verified } for a stop. */
export async function locate(item, dest) {
  const guess = item.lat && item.lng ? { lat: item.lat, lng: item.lng } : null
  const anchor = guess ?? (dest.lat && dest.lng ? dest : null)
  const hit = await lookup(item.placeQuery, anchor?.lat, anchor?.lng)
  if (hit && guess && distanceKm(hit, guess) < 8) return { ...hit, verified: true }
  if (hit && !guess && anchor && distanceKm(hit, anchor) < 80) return { ...hit, verified: true }
  return guess ? { ...guess, verified: false } : null
}
