# Jalan Lite

A lightweight Singapore bus-arrival app based on the Claude Design prototype.

## What it does

- Saves commute presets locally in the browser.
- Activates presets by weekday and time window.
- Shows the next three arrivals for selected bus services.
- Uses device location to find nearby LTA bus stops.
- Uses Mapbox GL JS for the stop-selection map.
- Keeps the LTA DataMall Account Key server-side in a Vercel Function.
- Uses LTA GTFS-Realtime train trip updates and service alerts for MRT legs when the feed matches the boarding and alighting stations in order.
- Supports Leave now, dated Leave at and Arrive by planning in Singapore time through OneMap transit routing.
- Lets users tap a journey leg to focus its geometry and boarding/alighting points on the map.
- Refreshes live bus and train timings every 45 seconds while the commute screen is active.
- Surfaces matching LTA train service alerts and can recalculate a replacement route while preserving the current route if routing fails.
- Chooses reroute alternatives that avoid the affected MRT line or station when OneMap returns one.
- Provides the mock disruption flow only through `?demo=disruption` for demos and QA.
- Shows per-leg live, scheduled, or fallback confidence with LTA/OneMap sources and refresh age.
- Checks disruptions while the app is open; the commuter UI makes no background push-delivery promise.

- Presents selectable place-search results, then a journey preview before saving.
- Keeps recurring Journeys and Bus stops in Saved, with weekday schedules and date-specific exceptions.
- Advances active journeys only through manual confirmations; same-tab reload restores progress.
- Migrates routines to verified v2 browser storage while leaving legacy records untouched.

See [product-fix acceptance and verification limits](design/dailyloop/product-fixes.md).

## Design direction

The saved commute dashboard follows the canonical **Paper Transit Instrument** direction: a tactile map-fold and timetable visual language translated into a readable screen UI. See the [Paper Transit Instrument concept artwork](design/dailyloop/paper-transit-instrument.png) and [DailyLoop UI style guide](design/dailyloop/style-guide.md) before adding a UI slice; the shared CSS token source remains the `--dl-*` layer on `.route-shell`.

## Vercel setup

Add these project environment variables, then redeploy:

- `LTA_API_KEY` — your LTA DataMall Account Key.
- `MAPBOX_PUBLIC_TOKEN` — a Mapbox public access token beginning with `pk.`.
- `ONEMAP_EMAIL` — the email address for the OneMap account used for routing.
- `ONEMAP_PASSWORD` — the OneMap account password; keep this value in Vercel Environment Variables and out of source control.

The OneMap function exchanges these credentials for an access token, keeps it in memory, and renews it automatically during the final five minutes of its three-day validity. Do not commit OneMap credentials or access tokens; `ONEMAP_ACCESS_TOKEN` and `ONEMAP_TOKEN` are supported only as a fallback when the credential pair is not configured.

The Mapbox token is a public browser token; the API endpoint only keeps it out of source control. Restrict the token to your Jalan Lite domains in Mapbox when you move beyond testing.

The bus API function uses LTA DataMall Bus Arrival v3.

## Local development

Install dependencies and start the Vercel development runtime:

```bash
npm install
npm run dev
```

Open `http://localhost:3000/`. Use the Vercel runtime rather than a static file server because the map, route, and live-data features depend on functions under `/api`.
