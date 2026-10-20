// Accounts: a username and a password, nothing else. Passwords are hashed
// with scrypt; a signed-in browser holds a random session token in an
// httpOnly cookie, and only the token's SHA-256 hash is stored.
import { scrypt as scryptCb, randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { query } from './db.js'

const scrypt = promisify(scryptCb)
const COOKIE = 'pt_session'
const SESSION_DAYS = 30
const N = 16384, R = 8, P = 1, KEYLEN = 64

export const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,30}$/u
export const MIN_PASSWORD = 8
export const MAX_PASSWORD = 200

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, hash] = String(stored).split('$')
  if (alg !== 'scrypt') return false
  const expected = Buffer.from(hash, 'base64')
  const got = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) })
  return got.length === expected.length && timingSafeEqual(got, expected)
}
// compared against when the username does not exist, so a miss takes as long as a wrong password
const DUMMY_HASH = await hashPassword(randomBytes(12).toString('hex'))

const tokenHash = (token) => createHash('sha256').update(token).digest('hex')

/** 'taken' when the username exists (case-insensitive), else the new user. */
export async function register(username, password) {
  const hash = await hashPassword(password)
  try {
    const { rows } = await query('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username', [username, hash])
    return rows[0]
  } catch (err) {
    if (err.code === '23505') return 'taken'
    throw err
  }
}

/** The user when the password matches, else null. */
export async function checkLogin(username, password) {
  const { rows } = await query('SELECT id, username, password_hash FROM users WHERE lower(username) = lower($1)', [username])
  const ok = await verifyPassword(password, rows[0]?.password_hash ?? DUMMY_HASH)
  return ok && rows[0] ? { id: rows[0].id, username: rows[0].username } : null
}

export async function createSession(userId) {
  const token = randomBytes(32).toString('base64url')
  await query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [tokenHash(token), userId])
  // tidy up while we are here
  query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {})
  return token
}

export async function endSession(token) {
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)])
}

async function userForToken(token) {
  const { rows } = await query(
    'SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()',
    [tokenHash(token)],
  )
  return rows[0] ?? null
}

/* ── cookies ───────────────────────────────────────────────────── */

export function readToken(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === COOKIE) return decodeURIComponent(v.join('='))
  }
  return ''
}

export function setSessionCookie(req, res, token) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86400_000, path: '/' })
}
export function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' })
}

/** Express middleware: sets req.user to { id, username } for a valid session. */
export function attachUser(enabled) {
  return async (req, _res, next) => {
    req.user = null
    const token = enabled() ? readToken(req) : ''
    if (token) {
      try { req.user = await userForToken(token) } catch (err) { console.error('[auth]', err.message) }
    }
    next()
  }
}
