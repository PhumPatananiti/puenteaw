// Per-person cost split. Pure functions: the page and the tests both use it.
//
// Every priced thing in a plan is a row. A row is either
//   per "person" — each participant pays unitPrice × qty, or
//   per "group"  — one bill of unitPrice × qty shared by the participants.
// `split[rowId]` lists which travelers (by index) take part; missing = everyone.

/** Flatten a plan into cost rows: daily stops first, then extras. */
export function costRows(plan) {
  const rows = []
  for (const d of plan.days ?? []) {
    for (const it of d.items ?? []) rows.push({ ...pick(it), day: d.day, source: 'item' })
  }
  for (const x of plan.extras ?? []) rows.push({ ...pick(x), day: null, source: 'extra' })
  return rows
}

const pick = (x) => ({ id: x.id, name: x.name, kind: x.kind, unitPrice: num(x.unitPrice), qty: num(x.qty, 1), per: x.per === 'group' ? 'group' : 'person', priceNote: x.priceNote ?? '' })
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)

export function participantsOf(rowId, split, peopleCount) {
  const all = Array.from({ length: peopleCount }, (_, i) => i)
  const chosen = split?.[rowId]
  if (!Array.isArray(chosen)) return all
  return chosen.filter((i) => Number.isInteger(i) && i >= 0 && i < peopleCount)
}

/**
 * @returns {{
 *   rows: Array<row & { participants:number[], total:number, each:number }>,
 *   perPerson: number[], total:number, average:number,
 *   byKind: Record<string, number>, byDay: Record<string, number>
 * }}
 */
export function computeCosts(plan, people, split = {}) {
  const n = Math.max(1, people.length)
  const perPerson = Array(n).fill(0)
  const byKind = {}
  const byDay = {}
  let total = 0

  const rows = costRows(plan).map((r) => {
    const participants = participantsOf(r.id, split, n)
    const bill = r.unitPrice * r.qty
    const k = participants.length
    const rowTotal = k === 0 ? 0 : r.per === 'person' ? bill * k : bill
    const each = k === 0 ? 0 : r.per === 'person' ? bill : bill / k
    for (const i of participants) perPerson[i] += each
    total += rowTotal
    byKind[r.kind] = (byKind[r.kind] ?? 0) + rowTotal
    const dayKey = r.day == null ? 'extras' : String(r.day)
    byDay[dayKey] = (byDay[dayKey] ?? 0) + rowTotal
    return { ...r, participants, total: rowTotal, each }
  })

  return { rows, perPerson, total, average: total / n, byKind, byDay }
}

/** Keep split lists valid after the number of travelers changes. */
export function trimSplit(split, peopleCount) {
  const out = {}
  for (const [id, list] of Object.entries(split ?? {})) {
    const kept = list.filter((i) => i < peopleCount)
    // a list that now covers everyone is the same as "everyone"
    if (kept.length !== peopleCount) out[id] = kept
  }
  return out
}

/** CSV of the cost table, one column per traveler. */
export function costsCsv(plan, people, split, currency) {
  const { rows, perPerson, total } = computeCosts(plan, people, split)
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const r2 = (v) => (Math.round(v * 100) / 100).toFixed(2)
  const head = ['Day', 'Item', 'Category', `Unit price (${currency})`, 'Qty', 'Paid', 'Total', ...people]
  const lines = [head.map(esc).join(',')]
  for (const r of rows) {
    lines.push([
      r.day ?? 'Extra', r.name, r.kind, r2(r.unitPrice), r.qty, r.per === 'person' ? 'each' : 'shared', r2(r.total),
      ...people.map((_, i) => (r.participants.includes(i) ? r2(r.each) : '')),
    ].map(esc).join(','))
  }
  lines.push(['', 'Total', '', '', '', '', r2(total), ...perPerson.map(r2)].map(esc).join(','))
  return lines.join('\n')
}
