# Routing benchmark

This harness compares the preserved OneMap route endpoint with the parallel LTA-native multimodal endpoint over four fixed Singapore journeys.

Run the default two-time matrix against production:

```sh
node benchmarks/routing-benchmark.js --date 2026-08-25 --times 08:00,18:00
```

Useful options:

```sh
node benchmarks/routing-benchmark.js \
  --base-url http://localhost:3000 \
  --scenarios city-hall-loyang \
  --times 18:00 \
  --json
```

Save the compact benchmark result without retaining endpoint response bodies:

```sh
node benchmarks/routing-benchmark.js \
  --base-url https://jalan-lite.vercel.app \
  --date 2026-08-25 \
  --record benchmarks/snapshots/routing-2026-08-25.json
```

Replay the saved result without contacting OneMap, LTA, or the deployed app:

```sh
node benchmarks/routing-benchmark.js \
  --replay benchmarks/snapshots/routing-2026-08-25.json
```

The result file stores route durations, confidence/source, coverage, and comparison outcomes. It is a historical report, not a replay of the router implementation.

For routing-code changes, capture compressed raw LTA/GTFS inputs separately:

```sh
node benchmarks/capture-lta-fixture.js \
  --stops 65029,77009 \
  --output benchmarks/fixtures/lta-network-2026-08-25.json.gz
```

The capture automatically adds BusArrival payloads for candidate boarding and one-transfer stops in the selected static network; `--stops` remains an additive way to include known stops.

Then run the LTA-native router offline from that fixture:

```sh
node benchmarks/replay-lta-fixture.js \
  --fixture benchmarks/fixtures/lta-network-2026-08-25.json.gz \
  --date 2026-08-25
```

Raw replay normalizes live BusArrival timestamps against the fixture `capturedAt`; `--date` and `--times` continue to control scheduled rail time.

Compare that offline replay with a compact routing snapshot:

```sh
node benchmarks/compare-lta-fixture.js \
  --fixture benchmarks/fixtures/lta-network-2026-08-25.json.gz \
  --snapshot benchmarks/snapshots/routing-2026-08-25.json
```

The comparator emits automation-friendly JSON by default; pass `--text` for a concise human-readable report (`--json` is also accepted). It takes the exact `requestedDate`, `scenarioIds`, and `departureTimes` matrix from the snapshot, so it does not accept replay date/time/scenario overrides. It fails on missing or invalid files, invalid capture timestamps, missing required snapshot metadata, or any missing/extra matrix sample. It never contacts LTA, OneMap, or the production app. Each sample includes replay/snapshot status and best-path minutes, source, confidence, rankability, and services, the signed replay-minus-snapshot minute delta, and whether applying the snapshot's OneMap baseline changes the LTA outcome. Aggregates include matrix and ranked-path coverage, status/path/source/rankability/exact-minute matches, median minute delta, and the fixture/snapshot capture timestamps with their signed observation gap.

By default, static bus rows are limited to the fixed benchmark journeys and their one-transfer neighborhoods; `--full-static` keeps the entire static feed. The fixture contains raw BusStops, BusRoutes, BusServices, selected BusArrival payloads, and the parsed GTFS train schedule. It never stores API credentials. Use `--force` only when intentionally replacing an existing file.

Each sample sends the same `requestedClock` timestamp to both endpoints. OneMap and scheduled LTA rail use that requested Singapore clock. Production LTA bus arrivals remain live-at-observation-time, so the report records `ltaObservationTime`; timing deltas from the live matrix are still coverage and confidence evidence, not historical ETA accuracy.

For deterministic timing-layer checks, run the normalized BusArrival replay:

```sh
node benchmarks/replay-benchmark.js
```

The replay verifies both a monitored future bus and a frequency-based estimate at a fixed clock without network access. It intentionally does not replace the full network route benchmark: bus-stop and route discovery still require a separate live or recorded network fixture.

The report marks a provisional promotion gate as `eligible` only when there are at least eight samples, both APIs are complete, at least 90% of samples have a ranked LTA path, low-confidence paths are at most 25%, and the median LTA-vs-OneMap delta is at most five minutes. This is an advisory gate; it does not switch the user-facing router.
