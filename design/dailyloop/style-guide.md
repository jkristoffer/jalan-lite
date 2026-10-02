# DailyLoop UI style guide

Working foundation for the saved commute dashboard: Now, Route, and Live. The source of truth for the implementation tokens is the `--dl-*` layer on `.route-shell` in [`route-shell.css`](../../route-shell.css). This guide describes the direction for future slices; it does not replace the existing semantic aliases or component hooks.

**Canonical visual direction: Paper Transit Instrument.** The saved concept artwork ([`paper-transit-instrument.png`](paper-transit-instrument.png)) is the visual reference for future dashboard slices. It treats the commute as a working paper transit artifact: a folded map, marked timetable, and indexed field notes brought to screen with restraint. The artwork guides material cues and hierarchy; it is not a request to replace the live map, route data, or interaction model with a static illustration.

## Product purpose

DailyLoop helps a daily commuter make the next good decision quickly: leave, board, transfer, or wait. The dashboard should reduce uncertainty without asking the user to study a transit map or interpret a dense operations screen.

The three views have distinct jobs:

- **Now** answers, “What should I do next?” It leads with the temporal journey state, countdown, and next action.
- **Route** answers, “How does this trip fit together?” It makes the map, route summary, transport path, alternatives, and disruption response legible.
- **Live** answers, “How much should I trust this right now?” It leads with timing confidence, freshness, and the state of each transit leg.

## Aesthetic direction: Paper Transit Instrument

Paper Transit Instrument is a calm, tactile transit artifact: part timetable, part folded route map, part marked-up field index, and part quiet control board. It should feel dependable and measured at a glance, with the useful marks of a well-handled paper instrument translated into a responsive interface.

Translate the concept through structure before decoration. Use the warm page surface, deep ink, restrained transit rails, ruled sections, indexed labels, and deliberate whitespace already defined by the `--dl-*` contract. Map folds become seams, section breaks, and route groupings; timetable and perforation cues become small repeated rules, dividers, or edge marks; letterpress/ink texture becomes typographic weight, tight editorial tracking, and occasional restrained one-color marks; transit rails become the existing route timeline rails and dots; confidence stamps become compact, explicit status/source labels; artifact/index metaphors become route codes, freshness metadata, source notes, and clearly ordered Now, Route, and Live sections.

Materiality is a screen cue, not a surface to simulate literally. If a future slice adds paper grain, fold marks, perforation, or letterpress texture, keep it static, low-contrast, sparse, and performance-safe (prefer CSS or a tiny optimized asset over large repeating rasters, filters, or animation). Never place texture behind critical text or controls, reduce contrast, obscure map controls, compete with a state signal, or become necessary to understand the route. Transit color remains a signal, not decoration: leaf means live/current, sky means next/information, and mandarin means attention or disruption.

The dashboard remains page-first and full viewport. Primary sections flow as normal content with horizontal rules rather than floating cards. Paper cues must support hierarchy through scale, whitespace, alignment, and data grouping; they must not introduce a second theme, generic dashboard chrome, or decorative illustration in place of live content. Small controls and status chips may retain compact borders or pill shapes when that improves recognition and touchability.

## Design tokens

Tokens live on `.route-shell` so they inherit through every dashboard pane without introducing a second theme. They are intentionally namespaced with `--dl-`.

### Palette

| Token | Exact value | Use |
| --- | --- | --- |
| `--dl-color-surface` | `#FAFAF8` | Warm off-white page and dashboard surface |
| `--dl-color-ink` | `#101725` | Deep navy for primary type, selected controls, and strong rules |
| `--dl-color-charcoal` | `#596262` | Supporting copy, source labels, and quiet metadata |
| `--dl-color-soft-grey` | `#DFE5E1` | Low-contrast section and row rules |
| `--dl-color-edge` | `#BCC2B9` | Control borders and neutral outlines |
| `--dl-color-leaf` | `#4A8D53` | Live/current transport signal and positive state |
| `--dl-color-sky` | `#5992C4` | Next leg, information, and checking state |
| `--dl-color-mandarin` | `#E69641` | Attention, affected, fallback, and disruption state |

Use alpha tints of these colors for quiet state backgrounds. Do not add a new hue to express a state. Existing non-dashboard setup, picker, and viewer surfaces may retain their local legacy values until they receive a separate migration.

### Semantic states

| Token | Meaning | Visual treatment |
| --- | --- | --- |
| `--dl-state-live` | Fresh live data | Leaf accent with explicit live copy |
| `--dl-state-current` | The leg or action happening now | Leaf rail or emphasis |
| `--dl-state-next` | The next leg or action | Sky rail or emphasis |
| `--dl-state-info` | Informational emphasis | Sky rule or focus accent |
| `--dl-state-checking` | Data is being refreshed or checked | Sky accent; keep loading copy visible |
| `--dl-state-alert` | User attention is required | Mandarin accent and concise explanation |
| `--dl-state-affected` | A route leg is disrupted | Mandarin rail, label, and reroute context |
| `--dl-state-fallback` | Live source is unavailable or stale | Mandarin accent plus honest fallback copy |
| `--dl-state-neutral` | Source, freshness, or non-signal metadata | Charcoal text and soft rules |

Never communicate a state by color alone. Pair the accent with a text label such as “Live”, “Next”, “Affected”, “Fallback”, or “Checking”. Selected state can use `--dl-color-ink` and must also be represented by the existing selected class and accessible state.

### Typography

- Use `--dl-font-ui` (`'Barlow', sans-serif`) for headings, interface labels, buttons, explanatory copy, and navigation.
- Use `--dl-font-data` (`'IBM Plex Mono', monospace`) for times, countdowns, route codes, freshness, confidence labels, and compact metadata.
- Keep headings compact and editorial with tight tracking. Keep data labels uppercase only when the label benefits from instrument-like scanning.
- Use tabular numerals for countdowns and time comparisons where supported. Do not introduce another font or rely on a generic system stack for a new dashboard component.
- Supporting copy should remain readable at normal zoom, with a comfortable line height and a constrained measure rather than long full-width lines.

### Spacing scale

Use the named scale rather than inventing a new spacing value for a new slice.

| Token | Value | Typical use |
| --- | --- | --- |
| `--dl-space-4` | `4px` | Icon/label nudge, micro gap |
| `--dl-space-8` | `8px` | Chip padding, compact grouping |
| `--dl-space-12` | `12px` | Metadata group, compact control spacing |
| `--dl-space-16` | `16px` | Component inset or local section gap |
| `--dl-space-24` | `24px` | Section padding and primary separation |
| `--dl-space-32` | `32px` | Major dashboard rhythm or pane gap |
| `--dl-space-48` | `48px` | Intro/header breathing room |

The scale is a guide, not a reason to rewrite stable local spacing. Preserve an existing value when changing it would alter behavior or a carefully tuned responsive state.

### Shape, borders, and depth

- `--dl-radius-major` is `0`. Now, Route, and Live major surfaces are flat, transparent/page-surface sections with rules and spacing. They do not become floating cards on desktop or mobile.
- `--dl-radius-control` is `999px`. Reserve pills for buttons, compact status labels, and other controls where the shape communicates interaction or status.
- `--dl-radius-chip` is `6px`. Use it for route-mode/network chips, not containers.
- `--dl-radius-compact` is `12px`. Use only for small interactive or alert blocks where a compact boundary is needed.
- `--dl-border-rule` is `1px solid var(--dl-color-soft-grey)` for editorial section and row separation.
- `--dl-border-control` is `1px solid var(--dl-color-edge)` for neutral controls and status outlines.
- `--dl-border-ink` is `1px solid var(--dl-color-ink)` for primary or high-contrast controls.
- `--dl-shadow-none` is `none` for dashboard major surfaces. Avoid adding card shadows to solve hierarchy; use spacing, type, and rules. An existing transient overlay may retain its local treatment until it is separately redesigned.

The older `--paper`, `--ink`, `--muted`, `--line`, `--edge`, `--surface`, `--info`, `--success`, `--warning`, `--urgent`, and related semantic aliases remain compatibility contracts. Do not remove, remap, or globally redefine them as part of a dashboard slice.

## Layout patterns

1. `.route-shell` owns the fixed viewport and scrolling surface. `.route-panel.dashboard-mode` uses the available width with readable horizontal padding and safe-area insets.
2. The dashboard header establishes brand, saved commute context, and secondary actions before the `Now` / `Route` / `Live` navigation.
3. `.dashboard-nav` and `.dashboard-nav-button` are the tab control. Keep the existing tab/tabpanel ARIA relationship, selected class, and route action behavior intact.
4. `.dashboard-pager` and `.dashboard-track` preserve pane navigation. A pane may be visually simplified, but it must remain a real `tabpanel` with its existing state and focus flow.
5. Now is action-first: temporal hero, route context, compact inline map/live context, then quiet focus/actions.
6. Route is map-first: full-width `.route-inline-map-sticky`, route summary, transport timeline, alternatives, and disruption/reroute state.
7. Live is confidence-first: timing confidence, freshness/source pairing, live leg rows, deliberate refresh/disruption actions, notification opt-in, then bottom route actions.
8. Inline maps are context panes, not decorative cards. Keep `.route-inline-map-wrap`, the actual map container, fallback container, map header, and map-focus behavior functional and full width.
9. Use horizontal rules to mark section boundaries. Avoid nesting a new major rounded surface inside another major surface.

At wider widths the dashboard may use the available horizontal space for balanced columns, such as the Live leg grid. Reserve enough width for the status/source stack and let the text column absorb remaining space. Around `430px` and below, stack the secondary columns, keep copy wrap-safe, and remove any accidental horizontal overflow.

## Component rules

### Tabs

Use the existing `.dashboard-nav` / `.dashboard-nav-button` pair. Tabs are a compact control strip and may have a small radius. The selected tab uses a strong ink treatment and remains distinguishable without relying on color alone. Do not replace tabs with links, accordions, or an invented view switcher.

### Buttons and links

- `.route-primary` is the high-priority action: solid deep navy, readable label, and a touch target of at least 44px.
- `.timing-refresh`, notification opt-in, and similar secondary controls use an outlined control treatment and can be pill-shaped.
- `.route-link` is a quiet text action with a visible underline and clear hover/focus state.
- Disabled and loading states remain legible: preserve the label, use reduced emphasis rather than hiding the control, and keep the cursor/focus behavior honest.
- Preserve every existing `data-route-action` hook. Visual refinement must not turn a button into a non-interactive wrapper.

### Status and confidence

The timing confidence heading is the first answer in Live. Pair the source heading with a live-state label and freshness copy. Status pills are short, readable, and reserved for state; explanatory copy belongs in normal text below.

Use `.live-state`, `.live-freshness`, `.live-leg-confidence`, `.route-summary-meta`, and the existing current/next labels. Keep the text label visible when the accent changes. Fallback and affected states should explain what is uncertain and what the user can do next.

### Route rows and timelines

`.live-leg-row` remains a real button. Group its title/mode, confidence/source, route metadata, and timing as separate scan zones. Bus and MRT may use leaf and sky accents, but current and next state take priority over the transport mode. Keep the status stack in a bounded column on wide layouts and allow it to wrap/ellipsis safely on narrow layouts.

`.timeline-item` remains selectable. Use the rail and dots to make walking, bus, and MRT read as one path. Current uses leaf, next uses sky, selected uses deep navy, and affected uses mandarin. Emphasis should be a rail, rule, or restrained tint—not a new floating card.

### Maps

The map header should state the context and offer the existing map action/focus path. `.route-inline-map-sticky` and `.route-inline-map-wrap` stay full width in Route; the Now map remains compact. Do not cover map controls, replace the real Mapbox/OneMap container, or style the fallback as if it were live data.

### Alerts and disruption

Use the existing `.dashboard-alert-strip`, `.route-disruption`, `.route-inline-notice`, and floating notice patterns. Lead with a short label, state the affected service or consequence, and expose the existing action. Mandarin is an attention rail, not a page background. Keep disruption blocks scannable and separate from ordinary route rows.

### Notifications and bottom actions

Notification opt-in is lower priority than timing confidence and route state. Separate it with a rule, keep its explanation concise, and give its opt-in control a deliberate secondary treatment. Bottom route actions follow another rule and should not compete with the primary Now action.

## Responsive and accessibility guidance

- Keep the `430px` behavior intentional: stack timing/status groups, let route and source copy wrap or ellipsis within its own column, make controls full width where the existing mobile layout does so, and prevent page-level horizontal scrolling.
- At `700px` and above, use wider editorial spacing and balanced live-leg columns only when the status/source group remains readable.
- Preserve `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` in viewport-bound layouts.
- Maintain the existing tab/tabpanel ARIA semantics, button semantics, labels, hidden-state behavior, and live-region updates.
- Keep visible `:focus-visible` treatment with sufficient contrast and an offset that is not clipped by a row or map wrapper.
- Meet readable contrast for body text, state labels, and controls. Never use a faint tint as the only indication of selection, current position, affected status, or loading.
- Respect reduced-motion preferences if introducing motion in a future slice. Motion must not be required to understand a route state.

## Do / don’t

### Do

- Let the next commuter decision dominate the page.
- Use the exact palette and `--dl-*` tokens for new dashboard work.
- Use a rule, rail, or spacing change to create hierarchy.
- Pair every state accent with explicit text.
- Keep maps, route data, selectors, and accessibility behavior intact.
- Test narrow widths mentally and visually for wrap, truncation, and touch targets.

### Don’t

- Don’t add rounded/shadowed major cards to the flat dashboard.
- Don’t introduce gradients, arbitrary hues, generic or unapproved decorative illustrations, or generic dashboard chrome; approved contextual transparent watercolor assets are permitted only under the documented Watercolor assets constraints.
- Don’t make every element a pill; reserve pills for controls and statuses.
- Don’t hard-code a static route, alert, timing value, or unsupported feature into the UI.
- Don’t change `data-route-action`, IDs, ARIA attributes, map container IDs, live state classes, or JS behavior for a visual slice.
- Don’t use color alone to communicate a route state.

## Watercolor assets

The isolated Paper Transit page may use the approved [`watercolor hero`](../../paper-transit/assets/dailyloop-watercolor-hero.webp) ([PNG master](../../paper-transit/assets/dailyloop-watercolor-hero.png)) and [`botanical transit flourish`](../../paper-transit/assets/botanical-transit-flourish.webp) ([PNG master](../../paper-transit/assets/botanical-transit-flourish.png)) as atmospheric/supporting decoration. Keep these assets transparent and unframed, with all meaningful copy and state in live HTML; use WebP first with an alpha-preserving PNG fallback, explicit dimensions, eager/high-priority loading for the hero, and lazy loading for supporting art. Decorative images use empty `alt`, `aria-hidden`, and `pointer-events: none`; section-level clipping and deliberate mobile cropping must prevent overflow. Watercolor must never become required to understand a route, state, or action.

## Future UI slice checklist

- [ ] The change serves Now, Route, or Live’s stated job and keeps the next decision clear.
- [ ] New colors, spacing, borders, radii, and typography use the `--dl-*` foundation or an existing compatible alias.
- [ ] Major dashboard surfaces remain flat, page-surface based, and shadow-free.
- [ ] Existing selectors, IDs, `data-route-action` hooks, map containers, ARIA, and live state classes are unchanged.
- [ ] Current, next, selected, affected, loading, fallback, and disabled states remain explicit and readable.
- [ ] Layout remains usable around `430px` and at wider desktop widths without overflow.
- [ ] Keyboard focus, contrast, touch targets, and text wrapping have been considered.
- [ ] The diff is limited to the owned files and receives the narrow requested validation check.
