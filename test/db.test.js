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

test('accounts: sign up, duplicate names, login, sessions', { skip }, async () => {
  const auth = await import('../src/auth.js')
  const name = `tester_${Date.now().toString(36)}`
  const user = await auth.register(name, 'correct horse battery')
  assert.ok(user.id)
  assert.equal(await auth.register(name.toUpperCase(), 'another password'), 'taken')

  assert.equal(await auth.checkLogin(name, 'wrong password'), null)
  assert.equal(await auth.checkLogin('nobody_here_123', 'whatever123'), null)
  const back = await auth.checkLogin(name.toUpperCase(), 'correct horse battery')
  assert.equal(String(back.id), String(user.id))

  // the stored hash is scrypt, never the password
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id])
  assert.match(rows[0].password_hash, /^scrypt\$/)
  assert.ok(!rows[0].password_hash.includes('correct horse'))

  const token = await auth.createSession(user.id)
  const req = { headers: { cookie: `other=1; pt_session=${token}` } }
  let seen
  await auth.attachUser(() => true)(req, {}, () => { seen = req.user })
  assert.equal(seen.username, name)
  await auth.endSession(token)
  await auth.attachUser(() => true)(req, {}, () => { seen = req.user })
  assert.equal(seen, null)

  await db.query('DELETE FROM users WHERE id = $1', [user.id])
})

test('accounts own trips; claiming needs the edit key', { skip }, async () => {
  const auth = await import('../src/auth.js')
  const a = await auth.register(`own_a_${Date.now().toString(36)}`, 'password-a-123')
  const b = await auth.register(`own_b_${Date.now().toString(36)}`, 'password-b-123')

  const mine = await db.createTrip(data('Account trip'), a.id)
  made.push(mine)
  assert.equal(await db.canEdit(mine.id, '', a.id), true)
  assert.equal(await db.canEdit(mine.id, '', b.id), false)
  assert.equal(await db.updateTrip(mine.id, '', data('Edited by owner'), a.id), 'ok')
  assert.equal(await db.updateTrip(mine.id, '', data('Edited by B'), b.id), 'forbidden')
  assert.deepEqual((await db.tripsOfUser(a.id)).map((x) => x.id), [mine.id])

  const loose = await db.createTrip(data('Made before signing in'))
  made.push(loose)
  assert.deepEqual(await db.claimTrips(b.id, [{ id: loose.id, editKey: 'wrong' }]), [])
  assert.deepEqual(await db.claimTrips(b.id, [{ id: loose.id, editKey: loose.editKey }]), [loose.id])
  // already owned: a second account cannot take it even with the key
  assert.deepEqual(await db.claimTrips(a.id, [{ id: loose.id, editKey: loose.editKey }]), [])
  assert.equal(await db.canEdit(loose.id, '', b.id), true)

  await db.query('DELETE FROM users WHERE id = ANY($1)', [[a.id, b.id]])
  // deleting an account keeps its trips reachable by link, just unowned
  assert.ok(await db.getTrip(mine.id))
})
