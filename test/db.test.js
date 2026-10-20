// Runs only when TEST_DATABASE_URL points at a disposable database, e.g.
//   createdb puenteaw_dev && TEST_DATABASE_URL=postgres://localhost/puenteaw_dev npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const url = process.env.TEST_DATABASE_URL
const skip = url ? false : 'set TEST_DATABASE_URL to run database tests'
let db
const made = []

before(async () => {
  if (!url) return
  process.env.DATABASE_URL = url
  db = await import('../src/db.js')
  assert.equal(await db.initDb(), true)
})
after(async () => {
  if (!db) return
  for (const id of made) await db.deleteTrip(id.id, id.editKey).catch(() => {})
  await db.closeDb()
})

const data = (title) => ({ plan: { title, destination: { name: 'Chiang Mai', country: 'Thailand' }, days: [{ day: 1, items: [] }, { day: 2, items: [] }] }, people: ['A', 'B'], split: {} })

test('a trip round-trips and only its edit key can change it', { skip }, async () => {
  const t = await db.createTrip(data('First'))
  made.push(t)
  assert.ok(db.isTripId(t.id))
  assert.ok(t.editKey.length >= 30)

  const got = await db.getTrip(t.id)
  assert.equal(got.data.plan.title, 'First')

  assert.equal(await db.updateTrip(t.id, 'wrong-key', data('Hacked')), 'forbidden')
  assert.equal(await db.updateTrip(t.id, '', data('Hacked')), 'forbidden')
  assert.equal(await db.updateTrip(t.id, t.editKey, data('Second')), 'ok')
  assert.equal((await db.getTrip(t.id)).data.plan.title, 'Second')
  assert.equal(await db.canEdit(t.id, t.editKey), true)
  assert.equal(await db.canEdit(t.id, 'nope'), false)
})

test('summaries list titles, destinations and day counts', { skip }, async () => {
  const t = await db.createTrip(data('Summary me'))
  made.push(t)
  const [s] = await db.tripSummaries([t.id, 'doesNotExist123'])
  assert.deepEqual([s.id, s.title, s.destination, s.days], [t.id, 'Summary me', 'Chiang Mai, Thailand', 2])
})

test('missing trips and deletes', { skip }, async () => {
  assert.equal(await db.getTrip('noSuchTrip1234'), null)
  assert.equal(await db.updateTrip('noSuchTrip1234', 'x', data('x')), 'missing')
  const t = await db.createTrip(data('Delete me'))
  assert.equal(await db.deleteTrip(t.id, 'bad'), 'forbidden')
  assert.equal(await db.deleteTrip(t.id, t.editKey), 'ok')
  assert.equal(await db.getTrip(t.id), null)
})

test('plan requests are logged and migrations are idempotent', { skip }, async () => {
  const t = await db.createTrip(data('Logged'))
  made.push(t)
  await db.logPlanRequest({ tripId: t.id, kind: 'new', prompt: 'test prompt', provider: 'mock', ok: true, usage: { in: 10, out: 20 }, ms: 1234.5 })
  // running init again must not re-apply migration 1
  assert.equal(await db.initDb(), true)
})
