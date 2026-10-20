import { STR } from './i18n.js'
import { computeCosts, trimSplit, costsCsv } from './costs.js'

const $ = (sel) => document.querySelector(sel)
const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const enc = encodeURIComponent

const DAY_COLORS = ['#e2603b', '#0f7a66', '#3b6fe2', '#c98a12', '#9b4dca', '#d6336c', '#2b8a3e', '#5c7cfa', '#e8590c', '#1098ad']
const PEOPLE_COLORS = ['#e2603b', '#0f7a66', '#3b6fe2', '#9b4dca', '#c98a12', '#d6336c', '#2b8a3e', '#1098ad']
const KIND_ICON = { sight: '🏛️', food: '🍜', activity: '🎯', transport: '🚐', stay: '🛏️', shopping: '🛍️', nightlife: '🌙', other: '📍' }
const FX_CHOICES = ['THB', 'USD', 'EUR', 'JPY', 'GBP', 'SGD', 'KRW', 'CNY', 'AUD', 'VND', 'MYR']
const STORE_KEY = 'puenteaw.trips.v1'

const S = {
  lang: 'en',
  provider: { id: '', label: '' },
  storage: 'browser', // 'server' when the backend has Postgres
  user: null, // { id, username } when signed in
  trip: null, // { id, editKey?, owned, plan, people, split, hero, weather, packed, savedAt }
  tab: 'itinerary',
  mapDay: 'all',
  fx: { code: '', rate: null },
  busy: false,
}

/* ── storage (best effort: private windows may refuse) ───────────── */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* full or blocked */ } },
}
const trips = () => store.get(STORE_KEY, [])
const tripData = (tr) => ({ plan: tr.plan, people: tr.people, split: tr.split, hero: tr.hero, weather: tr.weather, packed: tr.packed })

/** The browser list holds the trips this person owns (a cache of the server copy when there is one). */
function cacheTrip(trip, replaceId = trip.id) {
  const list = trips().filter((x) => x.id !== trip.id && x.id !== replaceId)
  list.unshift({ ...trip, savedAt: Date.now() })
  store.set(STORE_KEY, list.slice(0, 30))
  renderTripCount()
}

let saveTimer = null
function saveTrip({ now = false } = {}) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persist, now ? 0 : 600)
}
async function persist() {
  const trip = S.trip
  if (!trip?.owned) return // someone else's shared trip: nothing to save
  cacheTrip(trip)
  if (S.storage !== 'server') return
  try {
    if (!(trip.onServer ?? Boolean(trip.editKey))) {
      // not on the server yet (made before it had a database, or a copy of a shared trip): upload it
      const r = await fetch('/api/trips', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: tripData(trip) }) })
      if (!r.ok) throw new Error(String(r.status))
      const { id, editKey } = await r.json()
      const oldId = trip.id
      Object.assign(trip, { id, editKey, onServer: true })
      cacheTrip(trip, oldId)
      if (S.trip === trip) { history.replaceState(null, '', `#trip=${id}`); renderShareState() }
      return
    }
    const r = await fetch(`/api/trips/${enc(trip.id)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...(trip.editKey ? { 'x-edit-key': trip.editKey } : {}) }, body: JSON.stringify({ data: tripData(trip) }),
    })
    if (!r.ok) throw new Error(String(r.status))
  } catch {
    toast(t('saveFailed'))
  }
}

function toast(msg) {
  document.querySelector('.toast')?.remove()
  const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg, role: 'status' })
  document.body.append(el)
  setTimeout(() => el.remove(), 2600)
}

/** Only http(s) links from stored data reach an href or src. */
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? String(u) : '')

/* ── i18n ───────────────────────────────────────────────────────── */
const t = (key, ...args) => {
  const v = STR[S.lang][key] ?? STR.en[key]
  return typeof v === 'function' ? v(...args) : v
}
function applyLang() {
  document.documentElement.lang = S.lang
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t) })
  document.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('on', b.dataset.lang === S.lang))
  $('#description').placeholder = t('placeholder')
  $('#change').placeholder = t('refinePlaceholder')
  $('#exampleChips').innerHTML = t('exampleTrips').map((ex, i) => `<button type="button" class="chip" data-ex="${i}">${h(ex)}</button>`).join('')
  renderProvider()
  renderAccount()
  if (S.trip) renderResult()
}

/* ── money ──────────────────────────────────────────────────────── */
function fmt(amount, currency) {
  const whole = Math.abs(amount) >= 100 || Number.isInteger(amount)
  try {
    return new Intl.NumberFormat(S.lang === 'th' ? 'th-TH' : 'en-US', {
      style: 'currency', currency, maximumFractionDigits: whole ? 0 : 2, minimumFractionDigits: 0,
    }).format(amount)
  } catch {
    return `${Math.round(amount).toLocaleString()} ${currency}`
  }
}
const money = (amount) => fmt(amount, S.trip.plan.currency)
const alt = (amount) => (S.fx.rate ? `≈ ${fmt(amount * S.fx.rate, S.fx.code)}` : '')

/* ── helpers ────────────────────────────────────────────────────── */
const initial = (name) => (Array.from(String(name).trim().replace(/^[เแโใไ]/, ''))[0] || '?').toUpperCase()
const avatar = (name, i) => `<span class="avatar" style="background:${PEOPLE_COLORS[i % PEOPLE_COLORS.length]}" title="${h(name)}">${h(initial(name))}</span>`
const hasCoords = (it) => Number.isFinite(it.lat) && Number.isFinite(it.lng) && (it.lat !== 0 || it.lng !== 0)
const allItems = () => S.trip.plan.days.flatMap((d) => d.items)
const findItem = (id) => allItems().find((it) => it.id === id) ?? S.trip.plan.extras.find((x) => x.id === id)

function km(a, b) {
  const R = 6371, r = (d) => (d * Math.PI) / 180
  const x = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}
const mapsPlace = (it) => `https://www.google.com/maps/search/?api=1&query=${enc(it.placeQuery || it.name)}`
function mapsDirections(from, to) {
  const mode = hasCoords(from) && hasCoords(to) && km(from, to) < 1.5 ? 'walking' : 'driving'
  return `https://www.google.com/maps/dir/?api=1&origin=${enc(from.placeQuery || from.name)}&destination=${enc(to.placeQuery || to.name)}&travelmode=${mode}`
}
function mapsDayRoute(items) {
  const pts = items.map((it) => it.placeQuery || it.name)
  if (pts.length < 2) return pts.length ? mapsPlace(items[0]) : null
  const mid = pts.slice(1, -1).slice(0, 8)
  return `https://www.google.com/maps/dir/?api=1&origin=${enc(pts[0])}&destination=${enc(pts.at(-1))}${mid.length ? `&waypoints=${enc(mid.join('|'))}` : ''}`
}
function dateLabel(iso) {
  if (!iso) return ''
  try { return new Date(`${iso}T00:00:00`).toLocaleDateString(S.lang === 'th' ? 'th-TH' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) } catch { return iso }
}
function priceLabel(it) {
  if (!it.unitPrice) return `<span class="price free">${h(t('free'))}</span>`
  const amount = money(it.unitPrice * it.qty)
  return `<span class="price">${h(amount)} <small>${h(it.per === 'person' ? t('perPerson') : t('shared'))}</small></span>`
}

/* ── provider ───────────────────────────────────────────────────── */
async function loadProvider() {
  try {
    const r = await fetch('/api/health').then((x) => x.json())
    S.provider = { id: r.provider, label: r.label }
    S.storage = r.storage === 'server' ? 'server' : 'browser'
    if (r.currency && !store.get('puenteaw.currency')) $('#currency').value = r.currency
  } catch { /* offline */ }
  renderProvider()
}
function renderProvider() {
  $('#provider').textContent = S.provider.label ? t('plannedWith', S.provider.label) : ''
}

/* ── planning ───────────────────────────────────────────────────── */
function showStage(text, sub = '') {
  $('#stage').textContent = text
  $('#stageSub').textContent = sub
}
function showError(msg) {
  const el = $('#error')
  el.textContent = msg
  el.classList.remove('hidden')
}

async function runPlan(body, { refine = false } = {}) {
  if (S.busy) return
  S.busy = true
  $('#error').classList.add('hidden')
  $('#planBtn').disabled = true
  const previousTrip = S.trip
  $('#result').classList.add('hidden')
  $('#progress').classList.remove('hidden')
  showStage(t('stageRead'))
  if (!refine) $('#composer').classList.add('compact')

  let gotPlan = false
  try {
    const resp = await fetch('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!resp.ok || !resp.body) {
      const j = await resp.json().catch(() => ({}))
      throw new Error(j.error || t('errorGeneric'))
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const ev = JSON.parse(line)
        if (ev.type === 'error') throw new Error(ev.message || t('errorGeneric'))
        if (ev.type === 'plan') gotPlan = true
        handleEvent(ev, previousTrip)
      }
    }
    if (!gotPlan) throw new Error(t('errorGeneric'))
  } catch (err) {
    $('#progress').classList.add('hidden')
    showError(err.message || t('errorGeneric'))
    if (previousTrip && !gotPlan) {
      S.trip = previousTrip
      $('#result').classList.remove('hidden')
    } else if (!gotPlan) {
      $('#composer').classList.remove('compact')
    }
  } finally {
    S.busy = false
    $('#planBtn').disabled = false
    renderFootnote()
  }
}

function handleEvent(ev, previousTrip) {
  switch (ev.type) {
    case 'meta':
      S.provider = { id: ev.provider, label: ev.label }
      renderProvider()
      break
    case 'progress':
      showStage(ev.extras ? t('stageExtras') : ev.day > 0 ? t('stageDay', ev.day) : t('stageRead'), t('received', ev.chars.toLocaleString()))
      break
    case 'plan': {
      const plan = ev.plan
      const count = plan.travelers
      // keep names the traveler already typed when refining the same trip
      const known = previousTrip?.people ?? []
      const people = Array.from({ length: count }, (_, i) => plan.travelerNames[i] || known[i] || t('person', i + 1))
      S.trip = {
        id: ev.trip?.id ?? previousTrip?.id ?? newId(),
        editKey: ev.trip?.editKey ?? previousTrip?.editKey,
        onServer: Boolean(ev.trip) || Boolean(previousTrip?.onServer),
        owned: true,
        plan, people, split: {}, hero: previousTrip?.hero ?? null, weather: null, packed: {}, savedAt: Date.now(),
      }
      S.mapDay = 'all'
      S.tab = 'itinerary'
      $('#progress').classList.add('hidden')
      $('#result').classList.remove('hidden')
      renderResult()
      $('#footnote').textContent = t('stagePhotos')
      location.hash = `trip=${S.trip.id}`
      saveTrip({ now: true })
      $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' })
      break
    }
    case 'patch': {
      const it = findItem(ev.id)
      if (!it) break
      if (Number.isFinite(ev.lat)) { it.lat = ev.lat; it.lng = ev.lng; it.verified = ev.verified }
      if (ev.photo) it.photo = ev.photo
      const ph = document.querySelector(`[data-photo="${ev.id}"]`)
      if (ph) ph.innerHTML = photoInner(it)
      const ap = document.querySelector(`[data-approx="${ev.id}"]`)
      if (ap) ap.classList.toggle('hidden', it.verified !== false)
      scheduleMap()
      break
    }
    case 'hero':
      S.trip.hero = ev.photo
      renderHero()
      break
    case 'weather':
      S.trip.weather = ev.weather
      renderWeather()
      break
    case 'done':
      renderFootnote()
      saveTrip()
      break
  }
}
const newId = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).slice(0, 12)

/* ── result ─────────────────────────────────────────────────────── */
function renderResult() {
  renderHero()
  const showSample = S.provider.id === 'mock'
  $('#sampleNote').textContent = t('sampleNote')
  $('#sampleNote').classList.toggle('hidden', !showSample)
  renderShareState()
  renderWeather()
  renderTabs()
  renderDays()
  renderMapFilter()
  scheduleMap()
  renderCosts()
  renderEssentials()
  renderFootnote()
  $('#change').value = ''
}

function renderShareState() {
  const shared = S.trip && !S.trip.owned
  $('#sharedNote').classList.toggle('hidden', !shared)
  $('#shareBtn').classList.toggle('hidden', !(S.storage === 'server' && S.trip?.owned && (S.trip.onServer ?? Boolean(S.trip.editKey))))
  $('#refineForm').classList.toggle('hidden', shared)
}

function renderHero() {
  const { plan, hero } = S.trip
  $('#heroPlace').textContent = [plan.destination.name, plan.destination.country].filter(Boolean).join(' · ')
  $('#title').textContent = plan.title
  $('#summary').textContent = plan.summary
  const dates = plan.startDate ? `${dateLabel(plan.days[0]?.date || plan.startDate)} – ${dateLabel(plan.days.at(-1)?.date)}` : ''
  const pills = [t('days', plan.days.length), t('travelers', S.trip.people.length), plan.budgetLevel, dates].filter(Boolean)
  $('#pills').innerHTML = pills.map((p) => `<span class="pill">${h(p)}</span>`).join('')
  const el = $('#hero')
  if (safeUrl(hero?.url)) {
    el.style.backgroundImage = `url("${safeUrl(hero.url).replace(/["\\()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}")`
    $('#heroCredit').href = safeUrl(hero.link) || '#'
    $('#heroCredit').textContent = `📷 ${hero.title} · Wikimedia`
    $('#heroCredit').classList.remove('hidden')
  } else {
    el.style.backgroundImage = ''
    $('#heroCredit').classList.add('hidden')
  }
}

const WMO = (c) => (c == null ? '🌡️' : c === 0 ? '☀️' : c <= 2 ? '🌤️' : c === 3 ? '☁️' : c <= 48 ? '🌫️' : c <= 57 ? '🌦️' : c <= 67 ? '🌧️' : c <= 77 ? '❄️' : c <= 82 ? '🌦️' : '⛈️')
function renderWeather() {
  const w = S.trip.weather
  const el = $('#weather')
  if (!w?.days?.length) { el.classList.add('hidden'); return }
  el.innerHTML = `<span class="weather-label">${h(w.kind === 'forecast' ? t('weatherForecast') : t('weatherLastYear'))}</span>` +
    w.days.map((d) => `<div class="wday">
      <div class="wd">${h(w.kind === 'forecast' ? dateLabel(d.date) : new Date(`${d.date}T00:00:00`).toLocaleDateString(S.lang === 'th' ? 'th-TH' : 'en-GB', { day: 'numeric', month: 'short' }))}</div>
      <div class="wi">${WMO(d.code)}</div>
      <div class="wt">${d.max != null ? Math.round(d.max) : '–'}° <span style="color:var(--muted);font-weight:400">${d.min != null ? Math.round(d.min) : '–'}°</span></div>
      <div class="wr">${d.rainChance != null ? `☔ ${d.rainChance}%` : d.rain != null ? `☔ ${d.rain} mm` : ''}</div>
    </div>`).join('')
  el.classList.remove('hidden')
}

function renderTabs() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab))
  for (const name of ['itinerary', 'costs', 'essentials']) $(`#tab-${name}`).classList.toggle('hidden', name !== S.tab)
  if (S.tab === 'itinerary' && map) setTimeout(() => { map.invalidateSize(); drawMap() }, 30)
}

function renderFootnote() {
  if (!S.trip) return
  $('#footnote').textContent = [S.provider.label && t('plannedWith', S.provider.label), t('estimates')].filter(Boolean).join(' · ')
}

/* ── itinerary ──────────────────────────────────────────────────── */
function photoInner(it) {
  const icon = `<div class="ph">${KIND_ICON[it.kind] ?? '📍'}</div>`
  if (!safeUrl(it.photo?.url)) return icon
  const credit = it.photo.source === 'nearby' ? `${t('nearbyPhoto')}: ${it.photo.title}` : it.photo.title
  return `${icon}<img src="${h(safeUrl(it.photo.url))}" alt="${h(it.name)}" loading="lazy" onload="this.classList.add('loaded')" onerror="this.remove()">` +
    `<a class="credit" href="${h(safeUrl(it.photo.link) || '#')}" target="_blank" rel="noopener" onclick="event.stopPropagation()">📷 ${h(credit)}</a>`
}

function renderDays() {
  const { plan } = S.trip
  $('#days').innerHTML = plan.days.map((d, di) => {
    const color = DAY_COLORS[di % DAY_COLORS.length]
    const route = mapsDayRoute(d.items)
    const dayTotal = d.items.reduce((s, it) => s + (it.per === 'person' ? it.unitPrice * it.qty : (it.unitPrice * it.qty) / Math.max(1, S.trip.people.length)), 0)
    return `<section class="day" id="day-${d.day}">
      <div class="day-head">
        <div>
          <div class="day-num" style="color:${color}">${h(t('day'))} ${d.day}${d.date ? ` · ${h(dateLabel(d.date))}` : ''}</div>
          <h3 class="day-title">${h(d.title)}</h3>
          <div class="day-meta">${h(d.area)}${dayTotal ? ` · ~${h(money(dayTotal))} ${h(t('perPerson'))}` : ''}</div>
        </div>
        ${route ? `<a class="day-route" href="${h(route)}" target="_blank" rel="noopener">🗺️ ${h(t('dayRoute'))}</a>` : ''}
      </div>
      <ol class="stops">
        ${d.items.map((it, i) => {
          const prev = d.items[i - 1]
          const wiki = it.photo?.source === 'wikipedia' ? safeUrl(it.photo.link) : it.wikiTitle ? `https://en.wikipedia.org/wiki/${enc(it.wikiTitle)}` : ''
          return `<li class="stop">
            <div class="stop-time"><div class="stop-num" style="background:${color}">${i + 1}</div><div class="stop-clock">${h(it.time)}</div></div>
            <article class="card" data-item="${it.id}" data-day="${d.day}">
              <div class="photo" data-photo="${it.id}">${photoInner(it)}</div>
              <div class="card-body">
                <div class="card-top">
                  <span class="kind">${KIND_ICON[it.kind] ?? ''} ${h(t('kinds')[it.kind] ?? it.kind)}</span>
                  ${it.durationMin ? `<span class="dur">⏱ ${it.durationMin >= 90 ? `${Math.round(it.durationMin / 30) / 2} h` : `${it.durationMin} ${h(t('min'))}`}</span>` : ''}
                  ${priceLabel(it)}
                </div>
                <h4>${h(it.name)}</h4>
                <p>${h(it.description)}</p>
                ${it.priceNote ? `<p style="font-size:13px;margin-top:4px">💰 ${h(it.priceNote)}</p>` : ''}
                ${it.tip ? `<p class="tip">💡 ${h(it.tip)}</p>` : ''}
                <div class="links">
                  <a href="${h(mapsPlace(it))}" target="_blank" rel="noopener">📍 ${h(t('openMaps'))}</a>
                  ${prev ? `<a href="${h(mapsDirections(prev, it))}" target="_blank" rel="noopener">🧭 ${h(t('directions'))}</a>` : ''}
                  ${wiki ? `<a href="${h(wiki)}" target="_blank" rel="noopener">📖 ${h(t('about'))}</a>` : ''}
                  <span class="approx ${it.verified === false ? '' : 'hidden'}" data-approx="${it.id}">≈ ${h(t('approxPin'))}</span>
                </div>
              </div>
            </article>
          </li>`
        }).join('')}
      </ol>
    </section>`
  }).join('')
}

/* ── map ────────────────────────────────────────────────────────── */
let map = null
let layer = null
const markers = new Map()
let mapTimer = null
const scheduleMap = () => { clearTimeout(mapTimer); mapTimer = setTimeout(drawMap, 150) }

function ensureMap() {
  if (map || !window.L) return
  map = L.map('map', { scrollWheelZoom: false, zoomControl: true })
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map)
  layer = L.layerGroup().addTo(map)
}

function renderMapFilter() {
  const days = S.trip.plan.days
  $('#mapFilter').innerHTML = [`<button type="button" class="chip ${S.mapDay === 'all' ? 'on' : ''}" data-mapday="all">${h(t('all'))}</button>`]
    .concat(days.map((d, i) => `<button type="button" class="chip ${S.mapDay === String(d.day) ? 'on' : ''}" data-mapday="${d.day}" style="${S.mapDay === String(d.day) ? '' : `color:${DAY_COLORS[i % DAY_COLORS.length]}`}">${h(t('day'))} ${d.day}</button>`))
    .join('')
}

function drawMap() {
  if (!S.trip || S.tab !== 'itinerary') return
  ensureMap()
  if (!map) return
  layer.clearLayers()
  markers.clear()
  const bounds = []
  S.trip.plan.days.forEach((d, di) => {
    if (S.mapDay !== 'all' && S.mapDay !== String(d.day)) return
    const color = DAY_COLORS[di % DAY_COLORS.length]
    const pts = []
    d.items.forEach((it, i) => {
      if (!hasCoords(it)) return
      const ll = [it.lat, it.lng]
      pts.push(ll)
      bounds.push(ll)
      const icon = L.divIcon({ className: '', html: `<div class="pin" style="background:${color}">${i + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] })
      const m = L.marker(ll, { icon, title: it.name }).addTo(layer)
      m.bindPopup(`<b>${h(it.name)}</b>${h(t('day'))} ${d.day} · ${h(it.time)}<br><a href="${h(mapsPlace(it))}" target="_blank" rel="noopener">${h(t('openMaps'))} ↗</a>`)
      m.on('click', () => focusCard(it.id))
      markers.set(it.id, m)
    })
    if (pts.length > 1) L.polyline(pts, { color, weight: 3, opacity: .75, dashArray: '6 8' }).addTo(layer)
  })
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 })
  else if (hasCoords(S.trip.plan.destination)) map.setView([S.trip.plan.destination.lat, S.trip.plan.destination.lng], 12)
}

function focusCard(id) {
  document.querySelectorAll('.card.focus').forEach((c) => c.classList.remove('focus'))
  const card = document.querySelector(`.card[data-item="${id}"]`)
  if (!card) return
  card.classList.add('focus')
  card.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/* ── costs ──────────────────────────────────────────────────────── */
function renderCosts() {
  const { plan, people, split } = S.trip
  const c = computeCosts(plan, people, split)
  const kinds = Object.entries(c.byKind).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  const maxKind = Math.max(1, ...kinds.map(([, v]) => v))
  const groups = [...plan.days.map((d) => ({ key: d.day, label: `${t('day')} ${d.day} · ${d.title}` })), { key: null, label: t('extras') }]
  const rowsByGroup = (key) => c.rows.filter((r) => r.day === key)

  const fxOptions = [`<option value="">${h(t('none'))}</option>`, ...FX_CHOICES.filter((x) => x !== plan.currency).map((x) => `<option ${S.fx.code === x ? 'selected' : ''}>${x}</option>`)].join('')

  $('#tab-costs').innerHTML = `
    <div class="cost-top">
      <div class="stat hl"><div class="lbl">${h(t('groupTotal'))}</div><div class="val" data-k="total">${h(money(c.total))}</div><div class="alt" data-k="totalAlt">${h(alt(c.total))}</div></div>
      <div class="stat"><div class="lbl">${h(t('average'))}</div><div class="val" data-k="avg">${h(money(c.average))}</div><div class="alt" data-k="avgAlt">${h(alt(c.average))}</div></div>
      <div class="stat"><div class="lbl">${h(t('showIn'))}</div><select class="select" id="fxSel" style="margin-top:8px">${fxOptions}</select><div class="alt" style="margin-top:6px">${S.fx.rate ? `1 ${plan.currency} = ${S.fx.rate.toPrecision(4)} ${S.fx.code}` : ''}</div></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>${h(t('whoGoes'))}</h3><button type="button" class="ghost" id="addPerson">+ ${h(t('addPerson'))}</button></div>
      <div class="people">
        ${people.map((p, i) => `<div class="person">${avatar(p, i)}<input value="${h(p)}" data-person="${i}" aria-label="${h(t('person', i + 1))}"><span class="owe" data-owe="${i}">${h(money(c.perPerson[i]))}</span>${people.length > 1 ? `<button type="button" class="rm" data-rmperson="${i}" aria-label="${h(t('delete'))}">✕</button>` : ''}</div>`).join('')}
      </div>
      <p class="hint">${h(t('tapToToggle'))}</p>
    </div>

    <div class="panel">
      <h3>${h(t('byCategory'))}</h3>
      <div class="bars">
        ${kinds.map(([k, v]) => `<div class="bar-row"><span>${KIND_ICON[k] ?? ''} ${h(t('kinds')[k] ?? k)}</span><div class="bar"><span style="width:${(v / maxKind) * 100}%"></span></div><span class="amt">${h(money(v))}</span></div>`).join('')}
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h3>${h(t('tabCosts'))}</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="ghost add-cost" id="addCost">+ ${h(t('addCost'))}</button>
          <button type="button" class="ghost" id="exportCsv">⬇ ${h(t('exportCsv'))}</button>
        </div>
      </div>
      <div class="table-scroll">
      <table class="ctable">
        <thead><tr><th>${h(t('item'))}</th><th class="num">${h(t('unit'))}</th><th class="num">${h(t('qty'))}</th><th>${h(t('type'))}</th><th>${h(t('joins'))}</th><th class="num">${h(t('total'))}</th><th class="num">${h(t('perHead'))}</th><th></th></tr></thead>
        <tbody>
          ${groups.map((g) => {
            const rows = rowsByGroup(g.key)
            if (!rows.length) return ''
            return `<tr class="group"><td colspan="8">${h(g.label)}</td></tr>` + rows.map((r) => costRow(r)).join('')
          }).join('')}
        </tbody>
        <tfoot><tr><td colspan="5">${h(t('total'))}</td><td class="num" data-k="total2">${h(money(c.total))}</td><td class="num" data-k="avg2">${h(money(c.average))}</td><td></td></tr></tfoot>
      </table>
      </div>
    </div>`
}

function costRow(r) {
  const custom = r.id.startsWith('c')
  const people = S.trip.people
  return `<tr data-row="${r.id}">
    <td class="c-name">${custom
      ? `<input class="name" value="${h(r.name)}" data-edit="name" data-id="${r.id}">`
      : `${KIND_ICON[r.kind] ?? ''} ${h(r.name)}${r.priceNote ? `<span class="note">${h(r.priceNote)}</span>` : ''}`}</td>
    <td class="num" data-l="${h(t('unit'))}"><input class="n" type="number" min="0" step="any" inputmode="decimal" value="${r.unitPrice}" data-edit="unitPrice" data-id="${r.id}"></td>
    <td class="num" data-l="${h(t('qty'))}"><input class="n q" type="number" min="0" step="any" inputmode="decimal" value="${r.qty}" data-edit="qty" data-id="${r.id}"></td>
    <td data-l="${h(t('type'))}"><span class="toggle"><button type="button" class="${r.per === 'person' ? 'on' : ''}" data-per="person" data-id="${r.id}">${h(t('each'))}</button><button type="button" class="${r.per === 'group' ? 'on' : ''}" data-per="group" data-id="${r.id}">${h(t('sharedBill'))}</button></span></td>
    <td class="c-joins" data-l="${h(t('joins'))}"><div class="joins">${people.map((p, i) => `<button type="button" class="${r.participants.includes(i) ? '' : 'off'}" data-join="${i}" data-id="${r.id}" aria-pressed="${r.participants.includes(i)}">${avatar(p, i)}</button>`).join('')}</div></td>
    <td class="num" data-l="${h(t('total'))}" data-rtotal="${r.id}">${h(money(r.total))}</td>
    <td class="num" data-l="${h(t('perHead'))}" data-reach="${r.id}">${h(money(r.each))}</td>
    <td>${custom ? `<button type="button" class="row-del" data-del="${r.id}" aria-label="${h(t('delete'))}">✕</button>` : ''}</td>
  </tr>`
}

/** Update figures in place while typing, so inputs keep focus. */
function refreshCostNumbers() {
  const { plan, people, split } = S.trip
  const c = computeCosts(plan, people, split)
  const set = (sel, v) => { const el = document.querySelector(sel); if (el) el.textContent = v }
  set('[data-k="total"]', money(c.total)); set('[data-k="total2"]', money(c.total))
  set('[data-k="avg"]', money(c.average)); set('[data-k="avg2"]', money(c.average))
  set('[data-k="totalAlt"]', alt(c.total)); set('[data-k="avgAlt"]', alt(c.average))
  c.perPerson.forEach((v, i) => set(`[data-owe="${i}"]`, money(v)))
  for (const r of c.rows) { set(`[data-rtotal="${r.id}"]`, money(r.total)); set(`[data-reach="${r.id}"]`, money(r.each)) }
}

/* ── essentials ─────────────────────────────────────────────────── */
function renderEssentials() {
  const { plan, packed } = S.trip
  const block = (title, body) => (body ? `<div class="panel"><h3>${h(title)}</h3>${body}</div>` : '')
  $('#tab-essentials').innerHTML = `<div class="ess">
    ${block(t('bestTime'), plan.bestTime && `<p style="margin:0">${h(plan.bestTime)}</p>`)}
    ${block(t('gettingAround'), plan.gettingAround && `<p style="margin:0">${h(plan.gettingAround)}</p>`)}
    ${block(t('tips'), plan.tips.length && `<ul>${plan.tips.map((x) => `<li>${h(x)}</li>`).join('')}</ul>`)}
    ${block(t('packing'), plan.packing.length && `<ul class="checklist">${plan.packing.map((x, i) => `<li><label><input type="checkbox" data-pack="${i}" ${packed?.[i] ? 'checked' : ''}><span>${h(x)}</span></label></li>`).join('')}</ul>`)}
    ${block(t('phrases'), plan.phrases.length && plan.phrases.map((p) => `<div class="phrase"><span class="loc">${h(p.local)}</span><span class="pr">${h(p.pronunciation)}</span><span class="mn">${h(p.meaning)}</span></div>`).join(''))}
  </div>`
}

/* ── saved trips ────────────────────────────────────────────────── */
function renderTripCount() {
  const n = trips().length
  $('#tripCount').textContent = n ? String(n) : ''
}
let accountTrips = []
async function renderTripList() {
  let rows = trips().map((tr) => ({ id: tr.id, title: tr.plan.title, place: tr.plan.destination.name, days: tr.plan.days.length, when: tr.savedAt }))
  if (S.user) {
    try {
      const r = await fetch('/api/me/trips')
      if (r.ok) {
        accountTrips = (await r.json()).trips
        rows = accountTrips.map((tr) => ({ id: tr.id, title: tr.title, place: tr.destination, days: tr.days, when: tr.updatedAt }))
      }
    } catch { /* offline: show the browser's copy */ }
  }
  const head = S.user ? `<li class="empty">${h(t('signedInAs', S.user.username))}</li>` : ''
  $('#tripList').innerHTML = head + (rows.length
    ? rows.map((tr) => `<li><div class="t" data-open="${h(tr.id)}"><b>${h(tr.title)}</b><span>${h(tr.place)} · ${h(t('days', tr.days))} · ${h(new Date(tr.when).toLocaleDateString(S.lang === 'th' ? 'th-TH' : 'en-GB'))}</span></div><button class="ghost" type="button" data-deltrip="${h(tr.id)}">${h(t('delete'))}</button></li>`).join('')
    : `<li class="empty">${h(t('noTrips'))}</li>`)
  if (S.user) $('#tripCount').textContent = rows.length ? String(rows.length) : ''
}
async function openTrip(id) {
  const cached = trips().find((x) => x.id === id)
  if (cached) showTrip({ packed: {}, split: {}, owned: true, ...cached })
  if (S.storage !== 'server') return Boolean(cached)
  try {
    const r = await fetch(`/api/trips/${enc(id)}`, { headers: cached?.editKey ? { 'x-edit-key': cached.editKey } : {} })
    if (r.status === 404) {
      if (!cached) showError(t('notFound'))
      else if (!cached.editKey) saveTrip({ now: true }) // saved before the server had a database: upload it
      return Boolean(cached)
    }
    if (!r.ok) return Boolean(cached)
    const j = await r.json()
    const owned = Boolean(j.canEdit)
    const trip = { packed: {}, split: {}, ...j.data, id: j.id, editKey: owned ? cached?.editKey : undefined, owned, onServer: true }
    // the server copy wins unless this browser holds unsaved newer edits
    if (!cached || !owned || new Date(j.updatedAt).getTime() >= (cached.savedAt ?? 0) - 2000) showTrip(trip)
    return true
  } catch {
    return Boolean(cached)
  }
}

function showTrip(trip) {
  S.trip = trip
  const id = trip.id
  S.tab = 'itinerary'
  S.mapDay = 'all'
  S.fx = { code: '', rate: null }
  $('#composer').classList.add('compact')
  $('#error').classList.add('hidden')
  $('#progress').classList.add('hidden')
  $('#result').classList.remove('hidden')
  location.hash = `trip=${id}`
  renderResult()
}
function resetToComposer() {
  S.trip = null
  history.replaceState(null, '', location.pathname)
  $('#result').classList.add('hidden')
  $('#error').classList.add('hidden')
  $('#composer').classList.remove('compact')
  $('#description').focus()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

/* ── events ─────────────────────────────────────────────────────── */
function bind() {
  document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    S.lang = b.dataset.lang
    store.set('puenteaw.lang', S.lang)
    applyLang()
  }))

  $('#planForm').addEventListener('submit', (e) => {
    e.preventDefault()
    const description = $('#description').value.trim()
    if (!description) return
    store.set('puenteaw.currency', $('#currency').value)
    S.trip = null
    runPlan({ description, currency: $('#currency').value })
  })
  $('#description').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#planForm').requestSubmit()
  })
  $('#exampleChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ex]')
    if (!b) return
    $('#description').value = t('exampleTrips')[Number(b.dataset.ex)]
    $('#description').focus()
  })

  $('#refineForm').addEventListener('submit', (e) => {
    e.preventDefault()
    const change = $('#change').value.trim()
    if (!change || !S.trip) return
    const own = S.trip.owned ? { tripId: S.trip.id, editKey: S.trip.editKey } : {}
    runPlan({ previous: S.trip.plan, change, currency: S.trip.plan.currency, ...own }, { refine: true })
  })

  $('#newBtn').addEventListener('click', resetToComposer)
  $('#brand').addEventListener('click', (e) => { e.preventDefault(); resetToComposer() })
  $('#printBtn').addEventListener('click', () => window.print())
  $('#shareBtn').addEventListener('click', async () => {
    const url = `${location.origin}/#trip=${S.trip.id}`
    try {
      if (navigator.share && window.matchMedia('(pointer: coarse)').matches) await navigator.share({ title: S.trip.plan.title, url })
      else { await navigator.clipboard.writeText(url); toast(t('linkCopied')) }
    } catch { /* dismissed */ }
  })
  $('#saveCopyBtn').addEventListener('click', async () => {
    const copy = { ...S.trip, id: newId(), editKey: undefined, owned: true, onServer: false }
    S.trip = copy
    await persist() // uploads it and gives it a new id and edit key
    renderShareState()
    location.hash = `trip=${S.trip.id}`
  })

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]')
    if (!b) return
    const wasCosts = S.tab === 'costs'
    S.tab = b.dataset.tab
    if (wasCosts && S.tab === 'itinerary') renderDays() // prices may have been edited
    if (S.tab === 'costs') renderCosts()
    renderTabs()
  })

  $('#days').addEventListener('click', (e) => {
    if (e.target.closest('a')) return
    const card = e.target.closest('.card')
    if (!card) return
    const m = markers.get(card.dataset.item)
    if (S.mapDay !== 'all' && S.mapDay !== card.dataset.day) { S.mapDay = 'all'; renderMapFilter(); drawMap() }
    const mk = markers.get(card.dataset.item) ?? m
    document.querySelectorAll('.card.focus').forEach((c) => c.classList.remove('focus'))
    card.classList.add('focus')
    if (mk && map) {
      map.flyTo(mk.getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.6 })
      mk.openPopup()
      if (window.matchMedia('(max-width: 960px)').matches) $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  })
  $('#mapFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mapday]')
    if (!b) return
    S.mapDay = b.dataset.mapday
    renderMapFilter()
    drawMap()
  })

  // costs tab
  const costs = $('#tab-costs')
  costs.addEventListener('input', (e) => {
    const el = e.target
    if (el.dataset.edit) {
      const it = findItem(el.dataset.id)
      if (!it) return
      if (el.dataset.edit === 'name') it.name = el.value
      else it[el.dataset.edit] = Math.max(0, Number(el.value) || 0)
      refreshCostNumbers()
      saveTrip()
    } else if (el.dataset.person != null) {
      S.trip.people[Number(el.dataset.person)] = el.value
      saveTrip()
    }
  })
  costs.addEventListener('change', (e) => {
    if (e.target.id === 'fxSel') return setFx(e.target.value)
    if (e.target.dataset.person != null) { renderCosts(); renderHero() }
    if (e.target.dataset.edit) renderCosts()
  })
  costs.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    const trip = S.trip
    if (b.dataset.per) {
      const it = findItem(b.dataset.id)
      if (it) it.per = b.dataset.per
    } else if (b.dataset.join != null) {
      const i = Number(b.dataset.join)
      const cur = Array.isArray(trip.split[b.dataset.id]) ? trip.split[b.dataset.id] : trip.people.map((_, k) => k)
      const next = cur.includes(i) ? cur.filter((k) => k !== i) : [...cur, i].sort((a, z) => a - z)
      trip.split[b.dataset.id] = next
      trip.split = trimSplit(trip.split, trip.people.length)
    } else if (b.id === 'addPerson') {
      trip.people.push(t('person', trip.people.length + 1))
      // existing explicit lists stay as they are; the newcomer joins "everyone" rows
    } else if (b.dataset.rmperson != null) {
      const gone = Number(b.dataset.rmperson)
      trip.people.splice(gone, 1)
      for (const [id, list] of Object.entries(trip.split)) trip.split[id] = list.filter((k) => k !== gone).map((k) => (k > gone ? k - 1 : k))
      trip.split = trimSplit(trip.split, trip.people.length)
    } else if (b.id === 'addCost') {
      trip.plan.extras.push({ id: `c${Date.now().toString(36)}`, name: t('newCost'), kind: 'other', unitPrice: 0, qty: 1, per: 'group', priceNote: '' })
    } else if (b.dataset.del) {
      trip.plan.extras = trip.plan.extras.filter((x) => x.id !== b.dataset.del)
      delete trip.split[b.dataset.del]
    } else if (b.id === 'exportCsv') {
      const csv = costsCsv(trip.plan, trip.people, trip.split, trip.plan.currency)
      const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
      const a = Object.assign(document.createElement('a'), { href: url, download: `${trip.plan.title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60) || 'trip'}-costs.csv` })
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      return
    } else {
      return
    }
    renderCosts()
    renderHero()
    saveTrip()
  })

  $('#tab-essentials').addEventListener('change', (e) => {
    const i = e.target.dataset.pack
    if (i == null) return
    S.trip.packed = { ...S.trip.packed, [i]: e.target.checked }
    saveTrip()
  })

  // account
  $('#accountBtn').addEventListener('click', () => openAuth('in'))
  $('#authClose').addEventListener('click', () => $('#authDialog').close())
  $('#authSwitch').addEventListener('click', () => openAuth(authMode === 'up' ? 'in' : 'up'))
  $('#authForm').addEventListener('submit', (e) => { e.preventDefault(); submitAuth() })
  $('#signOutBtn').addEventListener('click', signOut)
  $('#authDialog').addEventListener('click', (e) => { if (e.target.id === 'authDialog') $('#authDialog').close() })

  // drawer
  $('#tripsBtn').addEventListener('click', () => { renderTripList(); $('#drawer').classList.remove('hidden') })
  $('#drawerClose').addEventListener('click', () => $('#drawer').classList.add('hidden'))
  $('#drawer').addEventListener('click', (e) => {
    if (e.target.id === 'drawer') return $('#drawer').classList.add('hidden')
    const open = e.target.closest('[data-open]')
    if (open) { openTrip(open.dataset.open); $('#drawer').classList.add('hidden'); return }
    const del = e.target.closest('[data-deltrip]')
    if (del) {
      const id = del.dataset.deltrip
      const gone = trips().find((x) => x.id === id)
      if (S.storage === 'server' && (gone?.editKey || S.user)) {
        fetch(`/api/trips/${enc(id)}`, { method: 'DELETE', headers: gone?.editKey ? { 'x-edit-key': gone.editKey } : {} })
          .catch(() => {})
          .finally(() => S.user && renderTripList())
      }
      store.set(STORE_KEY, trips().filter((x) => x.id !== del.dataset.deltrip))
      if (S.trip?.id === del.dataset.deltrip) resetToComposer()
      renderTripList()
      renderTripCount()
    }
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#drawer').classList.add('hidden') })
}

/* ── account ────────────────────────────────────────────────────── */
let authMode = 'in' // 'in' | 'up'
function renderAccount() {
  const btn = $('#accountBtn')
  btn.classList.toggle('hidden', S.storage !== 'server')
  btn.classList.toggle('signed', Boolean(S.user))
  btn.textContent = S.user ? `👤 ${S.user.username}` : t('signIn')
}
function openAuth(mode) {
  authMode = mode ?? authMode
  const signed = Boolean(S.user)
  $('#authIn').classList.toggle('hidden', signed)
  $('#authOut').classList.toggle('hidden', !signed)
  if (signed) {
    $('#authWho').textContent = t('signedInAs', S.user.username)
  } else {
    $('#authTitle').textContent = authMode === 'up' ? t('signUp') : t('signIn')
    $('#authSubmit').textContent = authMode === 'up' ? t('signUp') : t('signIn')
    $('#authSwitch').textContent = authMode === 'up' ? t('haveAccount') : t('noAccount')
    $('#authPass').autocomplete = authMode === 'up' ? 'new-password' : 'current-password'
    $('#authUserHint').classList.toggle('hidden', authMode !== 'up')
    $('#authPassHint').classList.toggle('hidden', authMode !== 'up')
    $('#authError').classList.add('hidden')
  }
  const dlg = $('#authDialog')
  if (!dlg.open) dlg.showModal()
  if (!signed) $('#authUser').focus()
}
async function submitAuth() {
  const username = $('#authUser').value.trim()
  const password = $('#authPass').value
  const err = (code) => { $('#authError').textContent = t('errors')[code] ?? t('errorGeneric'); $('#authError').classList.remove('hidden') }
  $('#authSubmit').disabled = true
  try {
    const r = await fetch(authMode === 'up' ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return err(j.error)
    $('#authPass').value = ''
    $('#authDialog').close()
    await signedIn(j.user)
    toast(t('welcome', j.user.username))
  } catch {
    err('')
  } finally {
    $('#authSubmit').disabled = false
  }
}
/** Move this browser's trips into the account, then reload the current one so it is editable everywhere. */
async function signedIn(user) {
  S.user = user
  renderAccount()
  const pairs = trips().filter((x) => x.editKey).map((x) => ({ id: x.id, editKey: x.editKey }))
  if (pairs.length) await fetch('/api/me/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trips: pairs }) }).catch(() => {})
  renderTripList()
  if (S.trip) openTrip(S.trip.id)
}
async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
  S.user = null
  // the trips live in the account now; do not leave them on a shared computer
  store.set(STORE_KEY, [])
  $('#authDialog').close()
  renderAccount()
  renderTripCount()
  resetToComposer()
}
async function loadAccount() {
  try {
    const r = await fetch('/api/auth/me').then((x) => x.json())
    S.user = r.user
  } catch { S.user = null }
  renderAccount()
  if (S.user) renderTripList()
}

const fxCache = new Map()
async function setFx(code) {
  if (!code) { S.fx = { code: '', rate: null }; renderCosts(); return }
  const base = S.trip.plan.currency
  try {
    if (!fxCache.has(base)) {
      const r = await fetch(`/api/fx?base=${enc(base)}`)
      if (!r.ok) throw new Error()
      fxCache.set(base, await r.json())
    }
    const rate = fxCache.get(base).rates?.[code]
    S.fx = rate ? { code, rate } : { code: '', rate: null }
  } catch {
    S.fx = { code: '', rate: null }
  }
  renderCosts()
}

/* ── boot ───────────────────────────────────────────────────────── */
S.lang = store.get('puenteaw.lang', navigator.language?.startsWith('th') ? 'th' : 'en')
const savedCurrency = store.get('puenteaw.currency')
if (savedCurrency) $('#currency').value = savedCurrency
bind()
applyLang()
renderTripCount()
await loadProvider()
await loadAccount()
const fromHash = location.hash.match(/trip=([\w-]+)/)
if (fromHash) openTrip(fromHash[1])
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/trip=([\w-]+)/)
  if (m && m[1] !== S.trip?.id) openTrip(m[1])
})
