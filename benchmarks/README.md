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

The OneMap request receives each requested departure time. LTA-native results still use live `BusArrival` data at the moment of observation, because the current API does not replay historical bus arrivals. Each sample records `ltaObservationTime`; timing deltas should therefore be used for coverage and confidence regression, not treated as historical ETA accuracy.

The report marks a provisional promotion gate as `eligible` only when there are at least eight samples, both APIs are complete, at least 90% of samples have a ranked LTA path, low-confidence paths are at most 25%, and the median LTA-vs-OneMap delta is at most five minutes. This is an advisory gate; it does not switch the user-facing router.
