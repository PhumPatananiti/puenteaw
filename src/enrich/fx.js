// Exchange rates from open.er-api.com (free, no key, refreshed daily).
import { getJson } from './http.js'

const cache = new Map()
const SIX_HOURS = 6 * 3600 * 1000

export async function ratesFor(base) {
  const code = String(base || '').toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) return null
  const hit = cache.get(code)
  if (hit && Date.now() - hit.at < SIX_HOURS) return hit.data
  const j = await getJson(`https://open.er-api.com/v6/latest/${code}`)
  if (j?.result !== 'success') return hit?.data ?? null
  const data = { base: code, rates: j.rates, updated: j.time_last_update_utc }
  cache.set(code, { at: Date.now(), data })
  return data
}
