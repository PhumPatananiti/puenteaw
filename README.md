# PuenTeaw · เพื่อนเที่ยว

Describe a trip in your own words (English or Thai) and PuenTeaw plans it with Gemini:

- **Itinerary**: day by day, with a time, photo, description, price and local tip for every stop
- **Map**: numbered pins and a route for each day (OpenStreetMap), plus Google Maps links for each place, directions between stops and a link that opens the whole day's route
- **Photos**: from Wikipedia and Wikimedia Commons, each credited and linked to its source
- **Weather**: a real forecast when the trip is within 16 days, otherwise last year's weather on the same dates
- **Costs & split**: every priced item in one table. Mark each item as paid *each* or as a *shared* bill, and tap faces to choose who joins it; each person's total updates live. You can edit prices, add your own costs, view totals in a second currency, and export the table to CSV.
- **Essentials**: tips, a packing checklist, local phrases and how to get around
- **Refine**: "make day 2 cheaper", "add a beach day" and so on
- **My trips**: saved in the browser, and a link opens the trip again
- English / Thai interface, with light and dark themes. The page works on phones, and it prints.

## Run it

```bash
cd puenteaw
npm install
cp .env.example .env     # then paste your key after GOOGLE_API_KEY=
npm run dev              # http://localhost:4100
```

Get a Gemini key at https://aistudio.google.com. The default model is `gemini-3.5-flash-lite`; change `GOOGLE_MODEL` in `.env` to use another one. **Restart after you edit `.env`**, because the dev watcher only reloads code files.

Without a key the app runs on a built-in sample trip (Chiang Mai), so you can try the interface.

Claude also works as the planner: set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.

## How it works

```
browser ──POST /api/plan──▶ Gemini (JSON schema, streamed)
   ▲                           │
   │  NDJSON stream:           ▼
   │  progress → plan → photo / pin / weather patches
   └──────────────── enrichment (all free, no keys):
                     Photon/OSM (exact pins), Wikipedia + Commons (photos),
                     Open-Meteo (weather), open.er-api.com (exchange rates)
```

| File | What it does |
|---|---|
| `src/schema.js` | The plan's JSON schema, and `normalizePlan`, which repairs output that drifts from it |
| `src/prompt.js` | Planner instructions, including how to price items: per person vs a shared group bill |
| `src/providers/` | `google.js` (default), `anthropic.js` (optional), and `mock.js` (the sample trip) |
| `src/enrich/` | Location check, photos, weather, exchange rates |
| `public/costs.js` | The per-person split math (pure functions, shared by the page and the tests) |
| `public/app.js` | The page |

```bash
npm test
```

Prices are AI estimates. Check them before you book.
