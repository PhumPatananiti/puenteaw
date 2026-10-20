// Postgres storage for trips and a log of planner calls. Optional: with no
// DATABASE_URL the app keeps trips in the browser only.
import pg from 'pg'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { config } from './config.js'

// Versioned, append-only. Never edit a shipped migration; add a new one.
const MIGRATIONS = [
  `CREATE TABLE trips (
     id            text PRIMARY KEY,
     edit_key_hash text NOT NULL,
     title         text NOT NULL,
     destination   text NOT NULL DEFAULT '',
     days          integer NOT NULL DEFAULT 0 CHECK (days >= 0),
     data          jsonb NOT NULL,
     created_at    timestamptz NOT NULL DEFAULT now(),
     updated_at    timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE plan_requests (
     id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     trip_id       text REFERENCES trips (id) ON DELETE SET NULL,
     kind          text NOT NULL CHECK (kind IN ('new', 'refine')),
     prompt        text NOT NULL,
     provider      text NOT NULL,
     ok            boolean NOT NULL,
     error         text,
     input_tokens  integer,
     output_tokens integer,
     duration_ms   integer NOT NULL,
     created_at    timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX plan_requests_created_at_idx ON plan_requests (created_at);
   CREATE INDEX plan_requests_trip_id_idx ON plan_requests (trip_id);`,
]

let pool = null
let enabled = false
export const isEnabled = () => enabled

/** Railway's private network (and localhost) needs no TLS; its public proxy does, with its own cert. */
function sslFor(url) {
  if (config.DATABASE_SSL === 'true') return { rejectUnauthorized: false }
  if (config.DATABASE_SSL === 'false') return false
  const host = (() => { try { return new URL(url).hostname } catch { return '' } })()
  return /^(localhost|127\.0\.0\.1|::1)$|\.railway\.internal$/.test(host) ? false : { rejectUnauthorized: false }
}

/** Connect and migrate. Retries for a while because the database may boot after the app. */
export async function initDb() {
  if (!config.DATABASE_URL) return false
  pool = new pg.Pool({ connectionString: config.DATABASE_URL, ssl: sslFor(config.DATABASE_URL), max: 5, idleTimeoutMillis: 30_000 })
  pool.on('error', (err) => console.error('[db] idle client error:', err.message))
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await migrate()
      enabled = true
      return true
    } catch (err) {
      console.error(`[db] connect/migrate failed (attempt ${attempt}/10): ${err.message}`)
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)))
    }
  }
  console.error('[db] giving up — trips will be kept in the browser only until restart')
  return false
}

async function migrate() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // one replica migrates at a time
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['puenteaw.migrations'])
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    const { rows } = await client.query('SELECT coalesce(max(version), 0) AS v FROM schema_migrations')
    for (let v = rows[0].v + 1; v <= MIGRATIONS.length; v++) {
      await client.query(MIGRATIONS[v - 1])
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v])
      console.log(`[db] applied migration ${v}`)
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function closeDb() {
  await pool?.end().catch(() => {})
}

/* ── trips ─────────────────────────────────────────────────────── */

const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function newTripId() {
  // 14 chars from a 57-letter alphabet ≈ 81 bits: unguessable, still short in a URL
  const bytes = randomBytes(14)
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')
}
const hashKey = (key) => createHash('sha256').update(String(key)).digest()
export const isTripId = (id) => typeof id === 'string' && /^[A-Za-z0-9]{10,32}$/.test(id)

const summaryOf = (data) => ({
  title: String(data?.plan?.title ?? 'Trip').slice(0, 200),
  destination: [data?.plan?.destination?.name, data?.plan?.destination?.country].filter(Boolean).join(', ').slice(0, 200),
  days: Array.isArray(data?.plan?.days) ? data.plan.days.length : 0,
})

/** Create a trip; returns { id, editKey }. The key is shown once and only its hash is stored. */
export async function createTrip(data) {
  const id = newTripId()
  const editKey = randomBytes(24).toString('base64url')
  const s = summaryOf(data)
  await pool.query(
    'INSERT INTO trips (id, edit_key_hash, title, destination, days, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, hashKey(editKey).toString('hex'), s.title, s.destination, s.days, data],
  )
  return { id, editKey }
}

export async function getTrip(id) {
  const { rows } = await pool.query('SELECT id, data, updated_at FROM trips WHERE id = $1', [id])
  return rows[0] ? { id: rows[0].id, data: rows[0].data, updatedAt: rows[0].updated_at } : null
}

async function keyMatches(id, editKey) {
  if (!editKey) return false
  const { rows } = await pool.query('SELECT edit_key_hash FROM trips WHERE id = $1', [id])
  if (!rows[0]) return null
  const stored = Buffer.from(rows[0].edit_key_hash, 'hex')
  const given = hashKey(editKey)
  return stored.length === given.length && timingSafeEqual(stored, given)
}

/** 'ok' | 'forbidden' | 'missing' */
export async function updateTrip(id, editKey, data) {
  const ok = await keyMatches(id, editKey)
  if (ok === null) return 'missing'
  if (!ok) return 'forbidden'
  const s = summaryOf(data)
  await pool.query(
    'UPDATE trips SET data = $2, title = $3, destination = $4, days = $5, updated_at = now() WHERE id = $1',
    [id, data, s.title, s.destination, s.days],
  )
  return 'ok'
}

export async function deleteTrip(id, editKey) {
  const ok = await keyMatches(id, editKey)
  if (ok === null) return 'missing'
  if (!ok) return 'forbidden'
  await pool.query('DELETE FROM trips WHERE id = $1', [id])
  return 'ok'
}

export async function canEdit(id, editKey) {
  return (await keyMatches(id, editKey)) === true
}

export async function tripSummaries(ids) {
  const { rows } = await pool.query(
    'SELECT id, title, destination, days, updated_at FROM trips WHERE id = ANY($1::text[]) ORDER BY updated_at DESC',
    [ids],
  )
  return rows.map((r) => ({ id: r.id, title: r.title, destination: r.destination, days: r.days, updatedAt: r.updated_at }))
}

/* ── planner log ───────────────────────────────────────────────── */

export async function logPlanRequest(entry) {
  if (!enabled) return
  try {
    await pool.query(
      `INSERT INTO plan_requests (trip_id, kind, prompt, provider, ok, error, input_tokens, output_tokens, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [entry.tripId ?? null, entry.kind, String(entry.prompt).slice(0, 4000), entry.provider, entry.ok,
        entry.error ? String(entry.error).slice(0, 500) : null, entry.usage?.in ?? null, entry.usage?.out ?? null, Math.round(entry.ms)],
    )
  } catch (err) {
    console.error('[db] could not log plan request:', err.message)
  }
}
