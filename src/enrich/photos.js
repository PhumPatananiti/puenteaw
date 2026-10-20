// Place photos from Wikipedia / Wikimedia Commons — free, no key, and every
// image links back to its source page for credit.
import { getJson, memo } from './http.js'

const WIKI = 'https://en.wikipedia.org/w/api.php'
const COMMONS = 'https://commons.wikimedia.org/w/api.php'
const qs = (o) => new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...o }).toString()

const pageFields = {
  prop: 'pageimages|extracts|info',
  piprop: 'thumbnail',
  pithumbsize: '900',
  exintro: '1',
  explaintext: '1',
  exsentences: '2',
  inprop: 'url',
}

const fromPage = (pg, source) =>
  pg?.thumbnail?.source
    ? { url: pg.thumbnail.source, link: pg.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(pg.title)}`, title: pg.title, extract: pg.extract || '', source }
    : null

const byTitle = memo(async (title) => {
  const j = await getJson(`${WIKI}?${qs({ action: 'query', titles: title, redirects: '1', ...pageFields })}`)
  return fromPage(j?.query?.pages?.[0], 'wikipedia')
})

const commonsSearch = memo(async (query) => {
  const j = await getJson(`${COMMONS}?${qs({
    action: 'query', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '1',
    prop: 'imageinfo', iiprop: 'url', iiurlwidth: '900',
  })}`)
  const pg = j?.query?.pages?.[0]
  const info = pg?.imageinfo?.[0]
  if (!info?.thumburl) return null
  return { url: info.thumburl, link: info.descriptionurl, title: pg.title.replace(/^File:/, '').replace(/\.\w+$/, ''), extract: '', source: 'commons' }
})

const nearby = memo(async (key, lat, lng) => {
  const j = await getJson(`${WIKI}?${qs({
    action: 'query', generator: 'geosearch', ggscoord: `${lat}|${lng}`, ggsradius: '800', ggslimit: '6', ...pageFields,
  })}`)
  const pages = (j?.query?.pages ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const hit = pages.find((p) => p.thumbnail?.source)
  return hit ? { ...fromPage(hit, 'nearby') } : null
})

/** Best available photo for a stop, or null. */
export async function photoFor(item, city) {
  if (item.wikiTitle) {
    const p = await byTitle(item.wikiTitle)
    if (p) return p
  }
  const c = await commonsSearch(`${item.name} ${city}`.trim())
  if (c) return c
  if (item.lat && item.lng) return nearby(`${item.lat.toFixed(4)},${item.lng.toFixed(4)}`, item.lat, item.lng)
  return null
}

export async function destinationPhoto(dest) {
  return (await byTitle(dest.name)) || (await commonsSearch(`${dest.name} ${dest.country}`))
}
