// The shape every provider must return. It is written to satisfy Claude's
// strict structured outputs (every object closed, every field required, no
// nulls) so the same schema also works, lightly cleaned, for Gemini.

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const int = (description) => ({ type: 'integer', description })
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const arr = (items, description) => ({ type: 'array', items, description })

export const KINDS = ['sight', 'food', 'activity', 'transport', 'stay', 'shopping', 'nightlife', 'other']

const price = {
  unitPrice: num('Realistic price of one unit in the plan currency. 0 when free.'),
  qty: num('How many units (nights, tickets, rides). Usually 1.'),
  per: { type: 'string', enum: ['person', 'group'], description: 'person = every traveler pays unitPrice×qty each; group = one shared bill split between the travelers who take part (taxi, room, private boat).' },
  priceNote: str('Short note on what the price covers or how it was estimated. "" when obvious.'),
}

const item = obj({
  time: str('Start time, 24h "HH:MM".'),
  name: str('Name of the place or activity.'),
  kind: { type: 'string', enum: KINDS },
  description: str('One or two vivid sentences on what the traveler does here.'),
  placeQuery: str('Search text that finds this exact place on Google Maps, including the city.'),
  wikiTitle: str('Exact English Wikipedia article title for the place, or "" if it has none.'),
  lat: num('Latitude, decimal degrees.'),
  lng: num('Longitude, decimal degrees.'),
  durationMin: int('Expected minutes spent.'),
  ...price,
  tip: str('One practical local tip, or "".'),
})

const extra = obj({
  name: str('A cost that is not a timed stop: flights, the hotel for the whole stay, SIM card, insurance, visa.'),
  kind: { type: 'string', enum: KINDS },
  ...price,
})

export const PLAN_SCHEMA = obj({
  title: str('Short, inviting trip title.'),
  summary: str('Two or three sentences describing the trip.'),
  destination: obj({
    name: str('Main city or region.'),
    country: str('Country.'),
    lat: num('Latitude of the destination centre.'),
    lng: num('Longitude of the destination centre.'),
  }),
  startDate: str('First day as YYYY-MM-DD if the traveler gave or implied a date, else "".'),
  travelers: int('Number of travelers.'),
  travelerNames: arr({ type: 'string' }, 'Names of travelers if the description mentions them, else [].'),
  currency: str('ISO 4217 code all prices are in.'),
  budgetLevel: { type: 'string', enum: ['budget', 'moderate', 'comfort', 'luxury'] },
  bestTime: str('One sentence on weather or season for these dates.'),
  gettingAround: str('One or two sentences on local transport.'),
  days: arr(obj({
    day: int('Day number starting at 1.'),
    date: str('YYYY-MM-DD when startDate is known, else "".'),
    title: str('Theme of the day.'),
    area: str('Neighbourhood or area the day centres on.'),
    items: arr(item, '4 to 7 stops in time order, including meals and transport legs that cost money.'),
  }), 'One entry per day.'),
  extras: arr(extra, 'Costs outside the daily schedule: accommodation for the stay, flights or long-distance transport, SIM, insurance.'),
  tips: arr({ type: 'string' }, '4 to 6 practical tips.'),
  packing: arr({ type: 'string' }, '6 to 10 packing items specific to this trip.'),
  phrases: arr(obj({
    local: str('Phrase in the local language.'),
    pronunciation: str('Romanised pronunciation.'),
    meaning: str('Meaning in the traveler\'s language.'),
  }), '4 to 6 useful local phrases, or [] if the traveler already speaks the local language.'),
})

const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const s = (v) => (typeof v === 'string' ? v.trim() : '')
const list = (v) => (Array.isArray(v) ? v : [])
const kind = (v) => (KINDS.includes(v) ? v : 'other')

function priceOf(x) {
  return {
    unitPrice: Math.max(0, Math.round(n(x.unitPrice) * 100) / 100),
    qty: Math.max(0, n(x.qty, 1)) || 1,
    per: x.per === 'group' ? 'group' : 'person',
    priceNote: s(x.priceNote),
  }
}

/** Models drift from schemas (Gemini especially); make the plan safe to render. */
export function normalizePlan(raw, fallbackCurrency = 'THB') {
  const p = raw && typeof raw === 'object' ? raw : {}
  const travelers = Math.min(50, Math.max(1, Math.round(n(p.travelers, 1))))
  const names = list(p.travelerNames).map(s).filter(Boolean).slice(0, travelers)
  let seq = 0
  return {
    title: s(p.title) || 'Your trip',
    summary: s(p.summary),
    destination: {
      name: s(p.destination?.name),
      country: s(p.destination?.country),
      lat: n(p.destination?.lat),
      lng: n(p.destination?.lng),
    },
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(s(p.startDate)) ? s(p.startDate) : '',
    travelers,
    travelerNames: names,
    currency: /^[A-Z]{3}$/.test(s(p.currency).toUpperCase()) ? s(p.currency).toUpperCase() : fallbackCurrency,
    budgetLevel: s(p.budgetLevel) || 'moderate',
    bestTime: s(p.bestTime),
    gettingAround: s(p.gettingAround),
    days: list(p.days).map((d, i) => ({
      day: i + 1,
      date: /^\d{4}-\d{2}-\d{2}$/.test(s(d.date)) ? s(d.date) : '',
      title: s(d.title),
      area: s(d.area),
      items: list(d.items).map((it) => ({
        id: `i${++seq}`,
        time: s(it.time),
        name: s(it.name) || 'Stop',
        kind: kind(it.kind),
        description: s(it.description),
        placeQuery: s(it.placeQuery) || s(it.name),
        wikiTitle: s(it.wikiTitle),
        lat: n(it.lat),
        lng: n(it.lng),
        durationMin: Math.max(0, Math.round(n(it.durationMin, 60))),
        ...priceOf(it),
        tip: s(it.tip),
      })),
    })),
    extras: list(p.extras).map((x) => ({ id: `x${++seq}`, name: s(x.name) || 'Cost', kind: kind(x.kind), ...priceOf(x) })),
    tips: list(p.tips).map(s).filter(Boolean),
    packing: list(p.packing).map(s).filter(Boolean),
    phrases: list(p.phrases)
      .map((ph) => ({ local: s(ph.local), pronunciation: s(ph.pronunciation), meaning: s(ph.meaning) }))
      .filter((ph) => ph.local),
  }
}
