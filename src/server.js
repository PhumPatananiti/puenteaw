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
import * as db from './db.js'
import * as auth from './auth.js'

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1) // Railway and similar hosts sit behind one proxy; use the real client IP
app.use(express.json({ limit: '400kb' }))
app.use('/api', auth.attachUser(db.isEnabled))
app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { extensions: ['html'] }))

// A plan costs real tokens, so cap requests per address (in memory, per process).
const hits = new Map()
function allow(key, limit = 30, windowMs = 3600_000) {
  const now = Date.now()
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= limit) return false
  recent.push(now)
  hits.set(key, recent)
  return true
}
setInterval(() => {
  const now = Date.now()
  for (const [k, list] of hits) if (!list.some((t) => now - t < 3600_000)) hits.delete(k)
}, 600_000).unref()

app.get('/api/health', (_req, res) => {
  const p = pickProvider()
  res.json({ ok: true, provider: p.id, label: p.label(), currency: config.DEFAULT_CURRENCY, storage: db.isEnabled() ? 'server' : 'browser' })
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
  const tripId = db.isTripId(req.body?.tripId) ? req.body.tripId : null
  const editKey = typeof req.body?.editKey === 'string' ? req.body.editKey : ''

  if (previous ? change.length < 2 || change.length > 1000 : description.length < 8 || description.length > 4000) {
    return res.status(400).json({ error: previous ? 'Describe the change in a few words.' : 'Describe your trip in at least a few words.' })
  }
  const provider = pickProvider()
  if (provider.id !== 'mock' && !allow(`plan:${req.ip}`)) {
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

  const started = Date.now()
  const log = { kind: previous ? 'refine' : 'new', prompt: previous ? change : description, provider: provider.id, tripId: null, userId: req.user?.id ?? null }
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
    log.usage = usage
    // Save new trips straight away so the share link works even if the tab closes.
    let trip = null
    if (db.isEnabled()) {
      try {
        if (previous && tripId && (await db.canEdit(tripId, editKey, req.user?.id))) trip = { id: tripId }
        else if (!previous) trip = await db.createTrip({ plan, people: [], split: {} }, req.user?.id ?? null)
      } catch (err) {
        console.error('[db] could not save trip:', err.message)
      }
    }
    log.tripId = trip?.id ?? null
    send({ type: 'plan', plan, usage, trip })
    db.logPlanRequest({ ...log, ok: true, ms: Date.now() - started })
  } catch (err) {
    console.error('[plan]', err.message)
    const message = err instanceof SyntaxError ? 'The planner returned an unreadable plan. Please try again.' : err.message
    send({ type: 'error', message })
    db.logPlanRequest({ ...log, ok: false, error: message, ms: Date.now() - started })
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

/* ── saved trips (Postgres) ─────────────────────────────────────── */

const MAX_TRIP_BYTES = 350_000
/** Light shape check: the page escapes everything it renders, this just keeps junk out. */
function tripData(body) {
  const d = body?.data
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  if (!d.plan || typeof d.plan !== 'object' || !Array.isArray(d.plan.days)) return null
  if (d.people != null && (!Array.isArray(d.people) || d.people.length > 50 || d.people.some((p) => typeof p !== 'string' || p.length > 60))) return null
  const clean = { plan: d.plan, people: d.people ?? [], split: d.split ?? {}, hero: d.hero ?? null, weather: d.weather ?? null, packed: d.packed ?? {} }
  return Buffer.byteLength(JSON.stringify(clean)) <= MAX_TRIP_BYTES ? clean : null
}
const needDb = (_req, res, next) => (db.isEnabled() ? next() : res.status(503).json({ error: 'Trip storage is not configured on this server.' }))
const editKeyOf = (req) => String(req.get('x-edit-key') ?? '')
const STATUS = { ok: 200, forbidden: 403, missing: 404 }

app.post('/api/trips', needDb, async (req, res) => {
  if (!allow(`save:${req.ip}`, 60)) return res.status(429).json({ error: 'Too many saves from this address. Try again later.' })
  const data = tripData(req.body)
  if (!data) return res.status(400).json({ error: 'That trip could not be saved.' })
  res.status(201).json(await db.createTrip(data, req.user?.id ?? null))
})

app.post('/api/trips/summaries', needDb, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(db.isTripId).slice(0, 50)
  res.json({ trips: ids.length ? await db.tripSummaries(ids) : [] })
})

app.get('/api/trips/:id', needDb, async (req, res) => {
  if (!db.isTripId(req.params.id)) return res.status(404).json({ error: 'Trip not found.' })
  const trip = await db.getTrip(req.params.id)
  if (!trip) return res.status(404).json({ error: 'Trip not found.' })
  res.json({ ...trip, canEdit: await db.canEdit(trip.id, editKeyOf(req), req.user?.id) })
})

app.put('/api/trips/:id', needDb, async (req, res) => {
  if (!db.isTripId(req.params.id)) return res.status(404).json({ error: 'Trip not found.' })
  const data = tripData(req.body)
  if (!data) return res.status(400).json({ error: 'That trip could not be saved.' })
  const result = await db.updateTrip(req.params.id, editKeyOf(req), data, req.user?.id)
  res.status(STATUS[result]).json({ ok: result === 'ok' })
})

app.delete('/api/trips/:id', needDb, async (req, res) => {
  if (!db.isTripId(req.params.id)) return res.status(404).json({ error: 'Trip not found.' })
  const result = await db.deleteTrip(req.params.id, editKeyOf(req), req.user?.id)
  res.status(STATUS[result]).json({ ok: result === 'ok' })
})

/* ── accounts (username + password) ─────────────────────────────── */

const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in.' }))
const me = (u) => ({ id: String(u.id), username: u.username })

function credentials(body) {
  const username = String(body?.username ?? '').trim().normalize('NFKC')
  const password = String(body?.password ?? '')
  return { username, password }
}

app.get('/api/auth/me', (req, res) => {
  res.json({ enabled: db.isEnabled(), user: req.user ? me(req.user) : null })
})

app.post('/api/auth/register', needDb, async (req, res) => {
  if (!allow(`register:${req.ip}`, 10)) return res.status(429).json({ error: 'too_many' })
  const { username, password } = credentials(req.body)
  if (!auth.USERNAME_RE.test(username)) return res.status(400).json({ error: 'bad_username' })
  if (password.length < auth.MIN_PASSWORD || password.length > auth.MAX_PASSWORD) return res.status(400).json({ error: 'bad_password' })
  const user = await auth.register(username, password)
  if (user === 'taken') return res.status(409).json({ error: 'taken' })
  auth.setSessionCookie(req, res, await auth.createSession(user.id))
  res.status(201).json({ user: me(user) })
})

app.post('/api/auth/login', needDb, async (req, res) => {
  if (!allow(`login:${req.ip}`, 20, 15 * 60_000)) return res.status(429).json({ error: 'too_many' })
  const { username, password } = credentials(req.body)
  const user = username && password ? await auth.checkLogin(username, password) : null
  if (!user) return res.status(401).json({ error: 'wrong_login' })
  auth.setSessionCookie(req, res, await auth.createSession(user.id))
  res.json({ user: me(user) })
})

app.post('/api/auth/logout', async (req, res) => {
  await auth.endSession(auth.readToken(req)).catch(() => {})
  auth.clearSessionCookie(req, res)
  res.json({ ok: true })
})

app.get('/api/me/trips', needDb, needUser, async (req, res) => {
  res.json({ trips: await db.tripsOfUser(req.user.id) })
})

/** After signing in: move trips this browser made (it holds their edit keys) into the account. */
app.post('/api/me/claim', needDb, needUser, async (req, res) => {
  const pairs = (Array.isArray(req.body?.trips) ? req.body.trips : []).slice(0, 50)
  res.json({ claimed: await db.claimTrips(req.user.id, pairs) })
})

app.use('/api', (err, _req, res, _next) => {
  console.error('[api]', err.message)
  res.status(err.status === 400 || err.type === 'entity.too.large' ? 400 : 500).json({ error: 'Something went wrong on the server.' })
})

await db.initDb()
const server = app.listen(config.PORT, () => {
  const p = pickProvider()
  console.log(`PuenTeaw on http://localhost:${config.PORT} — planner: ${p.label()} — trips: ${db.isEnabled() ? 'Postgres' : 'browser only'}`)
})
// Railway sends SIGTERM on redeploy: finish open requests, then close the pool.
process.on('SIGTERM', () => server.close(() => db.closeDb().then(() => process.exit(0))))
