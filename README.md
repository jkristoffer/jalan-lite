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

## Vercel setup

Add these project environment variables, then redeploy:

- `LTA_API_KEY` — your LTA DataMall Account Key.
- `MAPBOX_PUBLIC_TOKEN` — a Mapbox public access token beginning with `pk.`.

The Mapbox token is a public browser token; the API endpoint only keeps it out of source control. Restrict the token to your Jalan Lite domains in Mapbox when you move beyond testing.

The bus API function uses LTA DataMall Bus Arrival v3.
