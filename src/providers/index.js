import { config } from '../config.js'
import * as google from './google.js'
import * as anthropic from './anthropic.js'
import * as mock from './mock.js'

const byId = { google, anthropic, mock }

/** Gemini is the planner; with no key configured the sample trip stands in. */
export function pickProvider() {
  const want = byId[config.LLM_PROVIDER]
  if (want?.configured()) return want
  if (config.LLM_PROVIDER === 'auto' && anthropic.configured()) return google.configured() ? google : anthropic
  if (google.configured()) return google
  return mock
}
