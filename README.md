# PuenTeaw · เพื่อนเที่ยว

Describe a trip in your own words (English or Thai) and PuenTeaw plans it with Gemini:

- **Itinerary**: day by day, with a time, photo, description, price and local tip for every stop
- **Map**: numbered pins and a route for each day (OpenStreetMap), plus Google Maps links for each place, directions between stops and a link that opens the whole day's route
- **Photos**: from Wikipedia and Wikimedia Commons, each credited and linked to its source
- **Weather**: a real forecast when the trip is within 16 days, otherwise last year's weather on the same dates
- **Costs & split**: every priced item in one table. Mark each item as paid *each* or as a *shared* bill, and tap faces to choose who joins it; each person's total updates live. You can edit prices, add your own costs, view totals in a second currency, and export the table to CSV.
- **Essentials**: tips, a packing checklist, local phrases and how to get around
- **Refine**: "make day 2 cheaper", "add a beach day" and so on
- **Saved & shareable trips** (Postgres): every trip gets a link. Anyone with the link can view it; only the browser that made it can edit it, and viewers can save their own copy. Without a database, trips stay in the browser.
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

For saved trips locally: `createdb puenteaw_dev` and set `DATABASE_URL=postgres://localhost/puenteaw_dev`. Tables are created automatically on start.

Claude also works as the planner: set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.

## Deploy on Railway

1. Add the GitHub repo as a service, and add a **Postgres** database to the same project.
2. Open the puenteaw service, go to **Variables**, and add:
   - `GOOGLE_API_KEY`: your Gemini key
   - `DATABASE_URL`: `${{Postgres.DATABASE_URL}}` (a reference variable, so it uses Railway's private network)
3. Under **Settings → Networking**, choose **Generate Domain**.

Railway runs `npm start` and supplies `PORT`. On first boot the app creates its tables (`trips`, `plan_requests`, `schema_migrations`). The deploy log should end with `trips: Postgres`.

## Data

| Table | Holds |
|---|---|
| `trips` | One row per trip: the plan, travelers, split and photos as `jsonb`, plus title, destination and day count for listing. Only a SHA-256 hash of each trip's edit key is stored. |
| `plan_requests` | One row per planner call: the prompt, provider, ok/error, tokens and duration. Use it to watch usage and cost. |

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
| `src/db.js` | Postgres pool, versioned migrations, trip storage, planner log |
| `src/enrich/` | Location check, photos, weather, exchange rates |
| `public/costs.js` | The per-person split math (pure functions, shared by the page and the tests) |
| `public/app.js` | The page |

```bash
npm test                                                        # unit tests
TEST_DATABASE_URL=postgres://localhost/puenteaw_dev npm test    # plus database tests
```

Prices are AI estimates. Check them before you book.
