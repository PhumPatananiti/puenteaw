import { config } from '../config.js'
import * as google from './google.js'
import * as anthropic from './anthropic.js'
import * as mock from './mock.js'

const byId = { google, anthropic, mock }

/**
 * Gemini is the planner. The sample trip stands in only when asked for
 * (LLM_PROVIDER=mock) or during local development without a key; in
 * production a missing key returns null so the page shows a real error.
 */
export function pickProvider() {
  if (config.LLM_PROVIDER === 'mock') return mock
  const want = byId[config.LLM_PROVIDER]
  if (want?.configured()) return want
  if (google.configured()) return google
  if (anthropic.configured()) return anthropic
  return config.IS_PRODUCTION ? null : mock
}
