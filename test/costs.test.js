import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computeCosts, trimSplit, costsCsv } from '../public/costs.js'
import { normalizePlan } from '../src/schema.js'

const plan = {
  days: [{ day: 1, items: [
    { id: 'a', name: 'Temple', kind: 'sight', unitPrice: 50, qty: 1, per: 'person' },
    { id: 'b', name: 'Taxi', kind: 'transport', unitPrice: 300, qty: 2, per: 'group' },
    { id: 'c', name: 'Park', kind: 'sight', unitPrice: 0, qty: 1, per: 'person' },
  ] }],
  extras: [{ id: 'h', name: 'Hotel', kind: 'stay', unitPrice: 1000, qty: 3, per: 'group' }],
}
const people = ['A', 'B', 'C']

test('per-person rows charge each participant, group rows split the bill', () => {
  const c = computeCosts(plan, people)
  const row = (id) => c.rows.find((r) => r.id === id)
  assert.equal(row('a').total, 150)
  assert.equal(row('a').each, 50)
  assert.equal(row('b').total, 600)
  assert.equal(row('b').each, 200)
  assert.equal(row('h').each, 1000)
  assert.equal(c.total, 150 + 600 + 3000)
  assert.deepEqual(c.perPerson, [1250, 1250, 1250])
  assert.equal(c.average, 1250)
  assert.equal(c.byDay.extras, 3000)
  assert.equal(c.byKind.transport, 600)
})

test('opting people out moves their share onto the others', () => {
  const c = computeCosts(plan, people, { a: [0, 1], b: [0] })
  assert.equal(c.rows.find((r) => r.id === 'a').total, 100)
  assert.equal(c.rows.find((r) => r.id === 'b').each, 600)
  assert.deepEqual(c.perPerson, [50 + 600 + 1000, 50 + 1000, 1000])
  // the per-person column always adds back up to the group total
  assert.equal(c.perPerson.reduce((s, v) => s + v, 0), c.total)
})

test('a row nobody takes part in costs nothing', () => {
  const c = computeCosts(plan, people, { h: [] })
  assert.equal(c.rows.find((r) => r.id === 'h').total, 0)
  assert.equal(c.total, 750)
})

test('trimSplit drops removed travelers and collapses full lists', () => {
  assert.deepEqual(trimSplit({ a: [0, 2], b: [0, 1] }, 2), { a: [0] })
})

test('CSV has a column per traveler and a totals line', () => {
  const csv = costsCsv(plan, people, { a: [0] }, 'THB').split('\n')
  assert.equal(csv[0], 'Day,Item,Category,Unit price (THB),Qty,Paid,Total,A,B,C')
  assert.equal(csv[1], '1,Temple,sight,50.00,1,each,50.00,50.00,,')
  assert.match(csv.at(-1), /^,Total,,,,,3650.00,/)
})

test('the sample plan normalizes and every row is priced', () => {
  const raw = JSON.parse(readFileSync(new URL('../data/sample-plan.json', import.meta.url), 'utf8'))
  const p = normalizePlan(raw)
  assert.equal(p.days.length, 3)
  assert.equal(p.travelerNames.length, 4)
  const ids = [...p.days.flatMap((d) => d.items), ...p.extras].map((x) => x.id)
  assert.equal(new Set(ids).size, ids.length)
  const c = computeCosts(p, p.travelerNames)
  assert.ok(c.total > 10000 && c.total < 60000, `sample total ${c.total}`)
})

test('normalizePlan repairs sloppy model output', () => {
  const p = normalizePlan({ travelers: '0', currency: 'baht', days: [{ items: [{ name: 'X', kind: 'weird', unitPrice: '-5', qty: 'x', per: 'shared' }] }] }, 'USD')
  assert.equal(p.travelers, 1)
  assert.equal(p.currency, 'USD')
  const it = p.days[0].items[0]
  assert.deepEqual([it.kind, it.unitPrice, it.qty, it.per], ['other', 0, 1, 'person'])
})
