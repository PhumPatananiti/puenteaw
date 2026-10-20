// Travelers paste Google Maps links ("เริ่มที่พัก https://maps.app.goo.gl/…").
// A model cannot open them, so resolve each short link to the place name and
// exact coordinates Google redirects to, and hand that to the planner.
import { USER_AGENT } from '../config.js'
import { pool } from './http.js'

const LINK_RE = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps)\/[^\s)<>"'，、]+/gi
const MAX_LINKS = 15

export function findMapLinks(text) {
  return [...new Set(String(text ?? '').match(LINK_RE) ?? [])].slice(0, MAX_LINKS)
}

/** Pull "name" and "lat,lng" out of a full google.com/maps URL. */
export function parseMapsUrl(url) {
  let name = ''
  const place = url.match(/\/maps\/place\/([^/@?]+)/)
  if (place) {
    try { name = decodeURIComponent(place[1].replace(/\+/g, ' ')).trim() } catch { name = place[1].replace(/\+/g, ' ') }
  }
  if (!name) {
    const q = url.match(/[?&](?:q|query)=([^&]+)/)
    if (q) { try { name = decodeURIComponent(q[1].replace(/\+/g, ' ')).trim() } catch { /* leave empty */ } }
  }
  // !3d…!4d… is the place itself; @lat,lng is only where the map was centred
  const pin = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/)
  const view = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  const ll = pin ?? view
  // a q= of bare coordinates is a dropped pin rather than a named place
  if (/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(name)) {
    const [la, ln] = name.split(',').map(Number)
    return { name: '', lat: la, lng: ln }
  }
  return { name, lat: ll ? Number(ll[1]) : null, lng: ll ? Number(ll[2]) : null }
}

async function follow(url) {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    if (/google\.[a-z.]+\/maps\//.test(current) && !/goo\.gl/.test(current)) return current
    const resp = await fetch(current, { redirect: 'manual', headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(6000) })
    const next = resp.headers.get('location')
    if (!next) return current
    current = new URL(next, current).toString()
  }
  return current
}

/** [{ url, name, lat, lng }] for every link that resolved to a place. */
export async function resolveMapLinks(text) {
  const links = findMapLinks(text)
  const out = []
  await pool(links, 5, async (url) => {
    try {
      const full = await follow(url)
      const p = parseMapsUrl(full)
      if (p.name || (p.lat != null && p.lng != null)) out.push({ url, ...p })
    } catch { /* unresolvable link: the model still sees the raw text */ }
  })
  // keep the order the traveler wrote them in
  return out.sort((a, b) => links.indexOf(a.url) - links.indexOf(b.url))
}

/**
 * Put linked places exactly where Google says they are, whatever coordinates
 * the model wrote, and attach the link to a stop the model named but forgot to link.
 */
export function pinLinkedPlaces(plan, linked) {
  if (!linked.length) return plan
  const byUrl = new Map(linked.map((l) => [l.url, l]))
  const norm = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const unused = new Set(linked)
  const stops = plan.days.flatMap((d) => d.items)
  for (const it of stops) {
    const hit = byUrl.get(it.mapsUrl)
    if (hit) { pin(it, hit); unused.delete(hit) }
  }
  for (const l of unused) {
    if (!l.name) continue
    const it = stops.find((s) => !s.mapsUrl && (norm(s.name).includes(norm(l.name)) || norm(l.name).includes(norm(s.name))))
    if (it) pin(it, l)
  }
  return plan
  function pin(it, l) {
    it.mapsUrl = l.url
    if (l.lat != null && l.lng != null) { it.lat = l.lat; it.lng = l.lng; it.pinned = true }
  }
}
