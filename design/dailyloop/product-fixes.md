# DailyLoop product fixes — local acceptance

Implemented 2026-10-02. Paper Transit Instrument remains the visual direction. Changes are local; no publication or deployment was performed. Existing checkout changes were retained.

| Finding | Implemented outcome | Acceptance evidence |
| --- | --- | --- |
| Place ambiguity | Search presents named, addressed candidates with map coordinates; only explicit selection changes an endpoint. Map pins and one-shot location remain available. | API candidate tests; browser ambiguous search and delayed stale response rejected. |
| Travel intent | Leave now default; dated Leave at / Arrive by; all routing dates use Singapore time; expired scheduled requests require correction. | API date/time tests, including midnight and foreign device timezone. |
| First use | Show journey precedes Save as a routine. Preview has no persistence side effect. | Browser preview produced no saved records; save form visibly defaults new routines to weekdays. |
| Saved library | Journeys and Bus stops share Saved navigation and category-specific empty states. Relevant saved occurrence is surfaced; an active session takes priority. | Browser navigation, empty bus state, authoritative empty v2 store with retained v1 records. |
| Recurrence | Weekday selection, independent reversed-endpoint return plans, Skip today / Change time today, usual-route signatures. Legacy unrestricted routes remain daily. | Storage/schedule tests; regression for preserving the dated preview while editing recurrence. |
| Persistence | Versioned v2 store; verified migration and writes; legacy keys retained; empty v2 authoritative. Failed save leaves an editable draft with an error. | Migration/failure tests and verified v2 browser quota-failure simulation. |
| Progress and recovery | Explicit departure, walking completion, boarding, alighting, arrival; session reload; recovery from confirmed stop, searched point, pin or current location. Failed routing retains old progress. Completed occurrences excluded within the tab. | Journey tests; browser reload, waiting/boarding distinction, missed-bus failed recovery retains stop and phase. |
| Timing confidence | Freshness expires after 90 seconds. Mixed/scheduled/stale feeds have qualified labels. Stop arrivals are distinct from reachable connections. Reachability only claimed at a confirmed stop with a two-minute margin. Train times require matching ordered stations. | Confidence and train-match regressions. |
| Route comparison | Distinct Fastest / Fewer transfers / Less walking options where useful, arrival/walk/transfer/confidence comparison, explicit usual-route persistence and fallback explanation. | Alternative/preference tests; UI integration retains comparison options when usual route is selected. |
| Hierarchy and alerts | Now leads with next action and timing; Route has map/full steps; Live explains sources. In-app alerts only; demo available via `?demo=disruption`. | Browser 390×844 primary action bottom at 513px; desktop no horizontal overflow; keyboard focus; independent reviewer found no remaining blockers. |

## Focused validation

- `node --test api/location-route.test.js api/_onemap-auth.test.js`: 21 passed.
- `node --test routine-storage.test.js routine-schedule.test.js`: 18 passed.
- `node --test journey-state.test.js route-live-status.test.js route-alternatives.test.js`: 30 passed. Final recovery-coordinate guard also passed its 10 journey tests.
- `node --test route-runtime.test.js route-reroute.test.js api/upstream-resilience.test.js`: 18 passed.
- `node --test route-shell-product.test.js`: 5 passed.
- JavaScript syntax and diff whitespace checks passed.
- Independent read-only review covered data preservation, misleading guidance, and incomplete flows. Reported blockers were corrected and re-reviewed.

The isolated browser used synthetic saved records and mocked routing/location/feed responses on a local static server. Its actual v2 storage runtime and versioned shell assets were checked; no browser runtime errors were reported in the final checks. Live provider/network accuracy, physical-device geolocation, installed-PWA upgrade behavior, and production remain unverified. No broad suite was repeated after focused checks passed.

## Integration contracts

- `JalanSchedule` emits dated Singapore occurrences separately from saved routines.
- `JalanJourney` stores confirmed progress and the itinerary/dated plan in session storage; clock passage never advances physical progress.
- `JalanRoutines.save` and journey persistence return `{ok}`; the UI retains drafts when persistence fails.
- The primary owns shared UI, wiring and integration. Three bounded workers owned places/dates, routines/schedules, and guidance/confidence/alternatives; their outputs were integrated. The independent fourth reviewer was read-only.
