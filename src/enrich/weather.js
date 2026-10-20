// Open-Meteo: a real forecast when the trip is within the forecast window,
// otherwise last year's weather on the same dates as a guide.
import { getJson } from './http.js'

const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max'
const iso = (d) => d.toISOString().slice(0, 10)

export async function weatherFor({ lat, lng }, startDate, days) {
  if (!startDate || !lat || !lng || !days) return null
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + days - 1)
  const today = new Date(`${iso(new Date())}T00:00:00Z`)
  const ahead = (end - today) / 86400000

  if (end >= today && ahead <= 15) {
    const from = start < today ? today : start
    const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=${DAILY}&timezone=auto&start_date=${iso(from)}&end_date=${iso(end)}`)
    return shape(j, 'forecast')
  }
  if (start > today) {
    const ly = (d) => { const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() - 1); return iso(x) }
    const j = await getJson(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&daily=${DAILY.replace(',precipitation_probability_max', '')}&timezone=auto&start_date=${ly(start)}&end_date=${ly(end)}`)
    return shape(j, 'lastYear')
  }
  return null
}

function shape(j, kind) {
  const d = j?.daily
  if (!d?.time?.length) return null
  return {
    kind,
    days: d.time.map((date, i) => ({
      date,
      code: d.weather_code?.[i] ?? null,
      max: d.temperature_2m_max?.[i] ?? null,
      min: d.temperature_2m_min?.[i] ?? null,
      rain: d.precipitation_sum?.[i] ?? null,
      rainChance: d.precipitation_probability_max?.[i] ?? null,
    })),
  }
}
