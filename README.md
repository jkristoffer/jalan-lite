# Jalan Lite

A lightweight Singapore bus-arrival app based on the Claude Design prototype.

## What it does

- Saves commute presets locally in the browser.
- Activates presets by weekday and time window.
- Shows the next three arrivals for selected bus services.
- Uses device location to find nearby LTA bus stops.
- Uses Mapbox GL JS for the stop-selection map.
- Keeps the LTA DataMall Account Key server-side in a Vercel Function.
- Uses LTA GTFS-Realtime train trip updates and service alerts for MRT legs when the feed has a matching line or station.
- Supports both Leave at and Arrive by commute planning through OneMap transit routing.
- Lets users tap a journey leg to focus its geometry and boarding/alighting points on the map.
- Refreshes live bus and train timings every 45 seconds while the commute screen is active.
- Surfaces matching LTA train service alerts and can recalculate a replacement route while preserving the current route if routing fails.
- Chooses reroute alternatives that avoid the affected MRT line or station when OneMap returns one.
- Includes a clearly labelled mock disruption flow for demos and QA without changing live route data.
- Shows per-leg live, scheduled, or fallback confidence with LTA/OneMap sources and refresh age.

## Vercel setup

Add these project environment variables, then redeploy:

- `LTA_API_KEY` — your LTA DataMall Account Key.
- `MAPBOX_PUBLIC_TOKEN` — a Mapbox public access token beginning with `pk.`.

The Mapbox token is a public browser token; the API endpoint only keeps it out of source control. Restrict the token to your Jalan Lite domains in Mapbox when you move beyond testing.

The bus API function uses LTA DataMall Bus Arrival v3.
