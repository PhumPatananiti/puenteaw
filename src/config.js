import 'dotenv/config'

const env = (k, d = '') => (process.env[k] ?? '').trim() || d

export const config = {
  PORT: Number(env('PORT', '4100')),
  LLM_PROVIDER: env('LLM_PROVIDER', 'google').toLowerCase(),
  ANTHROPIC_API_KEY: env('ANTHROPIC_API_KEY'),
  ANTHROPIC_MODEL: env('ANTHROPIC_MODEL', 'claude-opus-5-5'),
  ANTHROPIC_EFFORT: env('ANTHROPIC_EFFORT', 'medium'),
  ANTHROPIC_FALLBACKS: env('ANTHROPIC_FALLBACKS', 'default'),
  GOOGLE_API_KEY: env('GOOGLE_API_KEY'),
  GOOGLE_MODEL: env('GOOGLE_MODEL', 'gemini-3.5-flash-lite'),
  DEFAULT_CURRENCY: env('DEFAULT_CURRENCY', 'THB').toUpperCase(),
  DATABASE_URL: env('DATABASE_URL'),
  // auto = TLS except for localhost and Railway's private network
  DATABASE_SSL: env('DATABASE_SSL', 'auto').toLowerCase(),
}

/** Wikipedia, Photon and Open-Meteo all ask callers to identify themselves. */
export const USER_AGENT = 'PuenTeaw/0.1 (personal trip planner prototype)'
