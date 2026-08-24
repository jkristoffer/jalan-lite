# Jalan Lite

A lightweight Singapore bus-arrival app based on the Claude Design prototype.

## What it does

- Saves commute presets locally in the browser.
- Activates presets by weekday and time window.
- Shows the next three arrivals for selected bus services.
- Keeps the LTA DataMall Account Key server-side in a Vercel Function.

## Vercel setup

Add the project environment variable `LTA_API_KEY` with your LTA DataMall Account Key, then redeploy.

The API function uses LTA DataMall Bus Arrival v3.
