// Claude through the official SDK, streamed so long plans do not hit HTTP
// timeouts and so the browser can watch the plan being written.
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { PLAN_SCHEMA } from '../schema.js'

export const id = 'anthropic'
export const label = () => `Claude (${config.ANTHROPIC_MODEL})`
export const configured = () => Boolean(config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)

let client = null
const getClient = () => (client ??= new Anthropic({ maxRetries: 2, ...(config.ANTHROPIC_API_KEY ? { apiKey: config.ANTHROPIC_API_KEY } : {}) }))

let fallbacksOn = config.ANTHROPIC_FALLBACKS !== 'off'

export async function generate({ system, user, onText }) {
  const base = {
    model: config.ANTHROPIC_MODEL,
    max_tokens: 64000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: { effort: config.ANTHROPIC_EFFORT, format: { type: 'json_schema', schema: PLAN_SCHEMA } },
  }
  const run = async (params, beta) => {
    const stream = beta ? getClient().beta.messages.stream(params) : getClient().messages.stream(params)
    if (onText) stream.on('text', onText)
    return stream.finalMessage()
  }

  let msg
  try {
    if (fallbacksOn) {
      // Server-side refusal fallback (beta): a declined request re-runs on
      // Anthropic's recommended substitute inside the same call.
      try {
        msg = await run({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, true)
      } catch (err) {
        if (!(err instanceof Anthropic.BadRequestError) || !/fallback/i.test(err.message)) throw err
        fallbacksOn = false
        msg = await run(base, false)
      }
    } else {
      msg = await run(base, false)
    }
  } catch (err) {
    throw new Error(friendly(err))
  }

  if (msg.stop_reason === 'refusal') throw new Error('Claude declined to plan this trip. Try rewording the description.')
  if (msg.stop_reason === 'max_tokens') throw new Error('The plan was too long to finish. Try fewer days.')
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return { json: JSON.parse(text), usage: { in: msg.usage?.input_tokens ?? 0, out: msg.usage?.output_tokens ?? 0 } }
}

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key (check ANTHROPIC_API_KEY).'
  if (err instanceof Anthropic.NotFoundError) return `This account cannot use ${config.ANTHROPIC_MODEL}.`
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate limited right now. Wait a moment and try again.'
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach Claude. Check the internet connection.'
  return err.message
}
