// Google Gemini — streamGenerateContent over SSE with a JSON response schema.
import { config } from '../config.js'
import { PLAN_SCHEMA } from '../schema.js'

export const id = 'google'
export const label = () => `Gemini (${config.GOOGLE_MODEL})`
export const configured = () => Boolean(config.GOOGLE_API_KEY)

/** Gemini's responseSchema is an OpenAPI subset: drop the keywords it rejects. */
function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (['additionalProperties', '$schema', 'strict'].includes(k)) continue
    out[k] = cleanSchema(v)
  }
  return out
}

export async function generate({ system, user, onText }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.GOOGLE_MODEL)}:streamGenerateContent?alt=sse`
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      maxOutputTokens: 32000,
      temperature: 0.6,
      responseMimeType: 'application/json',
      responseSchema: cleanSchema(PLAN_SCHEMA),
    },
  }
  let resp
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.GOOGLE_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    })
  } catch (err) {
    throw new Error(`Could not reach Gemini: ${err.message}`)
  }
  if (!resp.ok) throw new Error(friendlyStatus(resp.status, await resp.text().catch(() => '')))

  let text = ''
  let finish = null
  let usage = {}
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of resp.body) {
    buf += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      let ev
      try { ev = JSON.parse(line.slice(5)) } catch { continue }
      const cand = ev.candidates?.[0]
      const piece = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text || '').join('')
      if (piece) { text += piece; onText?.(piece) }
      if (cand?.finishReason) finish = cand.finishReason
      if (ev.usageMetadata) usage = ev.usageMetadata
    }
  }
  if (finish === 'SAFETY') throw new Error('Gemini blocked this request for safety. Try rewording the description.')
  if (finish === 'MAX_TOKENS') throw new Error('The plan was too long to finish. Try fewer days.')
  return { json: JSON.parse(text), usage: { in: usage.promptTokenCount ?? 0, out: usage.candidatesTokenCount ?? 0 } }
}

function friendlyStatus(status, text) {
  const msg = (() => { try { return JSON.parse(text)?.error?.message } catch { return null } })()
  if (status === 400 && /API key not valid/i.test(msg ?? '')) return 'Google rejected the API key (check GOOGLE_API_KEY).'
  if (status === 403) return 'Google rejected the API key (check GOOGLE_API_KEY).'
  if (status === 404) return `Gemini has no model called ${config.GOOGLE_MODEL}.`
  if (status === 429) return 'Gemini is rate limited right now. Wait a moment and try again.'
  return msg?.slice(0, 200) || `Gemini request failed (${status}).`
}
