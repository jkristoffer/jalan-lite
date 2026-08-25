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

Capture complete JSON responses for every endpoint request into a versioned snapshot:

```sh
node benchmarks/routing-benchmark.js \
  --base-url https://jalan-lite.vercel.app \
  --date 2026-08-25 \
  --record benchmarks/snapshots/routing-2026-08-25.json
```

Replay the same benchmark without contacting OneMap, LTA, or the deployed app:

```sh
node benchmarks/routing-benchmark.js \
  --replay benchmarks/snapshots/routing-2026-08-25.json
```

Replay is strict: a request that is not present in the snapshot fails instead of falling back to live data. Use `--force` with `--record` only when intentionally replacing an existing snapshot. The snapshot captures complete endpoint responses and their observation metadata; it is therefore a deterministic benchmark/regression record, not a reconstruction of upstream data that was not returned by the endpoints.

Each sample sends the same `requestedClock` timestamp to both endpoints. OneMap and scheduled LTA rail use that requested Singapore clock. Production LTA bus arrivals remain live-at-observation-time, so the report records `ltaObservationTime`; timing deltas from the live matrix are still coverage and confidence evidence, not historical ETA accuracy.

For deterministic timing-layer checks, run the normalized BusArrival replay:

```sh
node benchmarks/replay-benchmark.js
```

The replay verifies both a monitored future bus and a frequency-based estimate at a fixed clock without network access. It intentionally does not replace the full network route benchmark: bus-stop and route discovery still require a separate live or recorded network fixture.

The report marks a provisional promotion gate as `eligible` only when there are at least eight samples, both APIs are complete, at least 90% of samples have a ranked LTA path, low-confidence paths are at most 25%, and the median LTA-vs-OneMap delta is at most five minutes. This is an advisory gate; it does not switch the user-facing router.
