import { USER_AGENT } from '../config.js'

/** GET JSON with a timeout; null on any failure (enrichment is best-effort). */
export async function getJson(url, { timeout = 8000 } = {}) {
  try {
    const resp = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(timeout) })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

/** Small LRU-ish memo so the same place is not looked up twice. */
export function memo(fn, max = 2000) {
  const cache = new Map()
  return async (key, ...args) => {
    if (cache.has(key)) return cache.get(key)
    const p = fn(key, ...args).catch(() => null)
    cache.set(key, p)
    if (cache.size > max) cache.delete(cache.keys().next().value)
    const v = await p
    if (v == null) cache.delete(key) // retry failures next time
    return v
  }
}

/** Run async jobs with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

export function distanceKm(a, b) {
  const R = 6371
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
