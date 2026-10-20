import express from 'express'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { pickProvider } from './providers/index.js'
import { SYSTEM, userTurn } from './prompt.js'
import { normalizePlan } from './schema.js'
import { photoFor, destinationPhoto } from './enrich/photos.js'
import { locate } from './enrich/geocode.js'
import { weatherFor } from './enrich/weather.js'
import { ratesFor } from './enrich/fx.js'
import { pool } from './enrich/http.js'

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1) // Railway and similar hosts sit behind one proxy; use the real client IP
app.use(express.json({ limit: '400kb' }))
app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { extensions: ['html'] }))

// A plan costs real tokens, so cap requests per address (in memory, per process).
const hits = new Map()
function allow(ip, limit = 30, windowMs = 3600_000) {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= limit) return false
  recent.push(now)
  hits.set(ip, recent)
  return true
}

app.get('/api/health', (_req, res) => {
  const p = pickProvider()
  res.json({ ok: true, provider: p.id, label: p.label(), currency: config.DEFAULT_CURRENCY })
})

app.get('/api/fx', async (req, res) => {
  const data = await ratesFor(req.query.base)
  if (!data) return res.status(502).json({ error: 'Exchange rates are unavailable right now.' })
  res.json(data)
})

app.post('/api/plan', async (req, res) => {
  const description = String(req.body?.description ?? '').trim()
  const change = String(req.body?.change ?? '').trim()
  const previous = req.body?.previous && typeof req.body.previous === 'object' ? req.body.previous : null
  const currency = /^[A-Z]{3}$/.test(req.body?.currency ?? '') ? req.body.currency : config.DEFAULT_CURRENCY

  if (previous ? change.length < 2 || change.length > 1000 : description.length < 8 || description.length > 4000) {
    return res.status(400).json({ error: previous ? 'Describe the change in a few words.' : 'Describe your trip in at least a few words.' })
  }
  const provider = pickProvider()
  if (provider.id !== 'mock' && !allow(req.ip)) {
    return res.status(429).json({ error: 'Too many plans from this address in the last hour. Try again later.' })
  }

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.flushHeaders()
  let closed = false
  res.on('close', () => { closed = true })
  const send = (ev) => { if (!closed) res.write(`${JSON.stringify(ev)}\n`) }

  send({ type: 'meta', provider: provider.id, label: provider.label() })

  // Progress: how much JSON has arrived and which day the model is on.
  let text = ''
  let lastSent = 0
  const onText = (piece) => {
    text += piece
    const now = Date.now()
    if (now - lastSent < 250) return
    lastSent = now
    const day = (text.match(/"day"\s*:/g) ?? []).length
    send({ type: 'progress', chars: text.length, day, extras: /"extras"\s*:/.test(text) })
  }

  let plan
  try {
    const today = new Date().toISOString().slice(0, 10)
    const prevForModel = previous ? stripForModel(previous) : null
    const { json, usage } = await provider.generate({
      system: SYSTEM,
      user: userTurn({ description, today, currency, previous: prevForModel, change }),
      onText,
    })
    plan = normalizePlan(json, currency)
    if (!plan.days.length) throw new Error('The planner returned no days. Try describing the trip again.')
    send({ type: 'plan', plan, usage })
  } catch (err) {
    console.error('[plan]', err.message)
    send({ type: 'error', message: err instanceof SyntaxError ? 'The planner returned an unreadable plan. Please try again.' : err.message })
    return res.end()
  }

  // Enrichment streams in after the plan so the page can render immediately.
  const city = plan.destination.name
  const stops = plan.days.flatMap((d) => d.items)
  await Promise.all([
    destinationPhoto(plan.destination).then((photo) => photo && send({ type: 'hero', photo })),
    weatherFor(plan.destination, plan.startDate, plan.days.length).then((weather) => weather && send({ type: 'weather', weather })),
    pool(stops, 6, async (it) => {
      if (closed) return
      const geo = await locate(it, plan.destination)
      const target = geo ? { ...it, lat: geo.lat, lng: geo.lng } : it
      const photo = await photoFor(target, city)
      send({ type: 'patch', id: it.id, ...(geo ?? {}), photo })
    }),
  ]).catch((err) => console.error('[enrich]', err.message))

  send({ type: 'done' })
  res.end()
})

/** Send the model only what it wrote, not the photos and fixes we added. */
function stripForModel(p) {
  const { days = [], extras = [], hero, weather, ...rest } = p
  return {
    ...rest,
    days: days.map(({ items = [], ...d }) => ({ ...d, items: items.map(({ id, photo, verified, ...it }) => it) })),
    extras: extras.map(({ id, ...x }) => x),
  }
}

app.listen(config.PORT, () => {
  const p = pickProvider()
  console.log(`PuenTeaw on http://localhost:${config.PORT} — planner: ${p.label()}`)
})
