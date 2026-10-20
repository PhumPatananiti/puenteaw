// No key configured: replay the built-in sample so the interface can be tried.
import { readFile } from 'node:fs/promises'

export const id = 'mock'
export const label = () => 'Sample trip (no API key)'
export const configured = () => true

const SAMPLE = new URL('../../data/sample-plan.json', import.meta.url)

export async function generate({ onText }) {
  const text = await readFile(SAMPLE, 'utf8')
  // Drip the JSON out so the progress view behaves as it does with a real model.
  for (let i = 0; i < text.length; i += 600) {
    onText?.(text.slice(i, i + 600))
    await new Promise((r) => setTimeout(r, 40))
  }
  return { json: JSON.parse(text), usage: { in: 0, out: 0 } }
}
