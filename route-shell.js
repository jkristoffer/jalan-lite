(() => {
  const STORAGE_KEY = 'jalan-lite-routes-v1';
  const DEFAULT_CENTER = { lat: 1.3521, lng: 103.8198 };
  const LIVE_REFRESH_INTERVAL = 45000;
  const shell = document.createElement('section');
  const launcher = document.createElement('button');

  let saved = load();
  let draftState = draft(saved);
  let pickerField = null;
  let mapPosition = { center: { ...DEFAULT_CENTER }, zoom: 14, label: 'Singapore' };
  let routeState = { status: 'idle', data: null, error: '' };
  let map = null;
  let viewing = false;
  let selectedLegIndex = null;
  let liveRefreshTimer = null;
  let liveRefreshInFlight = false;
  let liveUpdatedAt = 0;
  let liveRefreshStatus = 'idle';

  shell.className = 'route-shell';
  launcher.className = 'route-launcher';
  launcher.type = 'button';
  launcher.textContent = 'Commute';
  launcher.hidden = true;

  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));

  const durationLabel = (seconds) => `${Math.max(1, Math.round((Number(seconds) || 0) / 60))} min`;

  const distanceLabel = (metres) => {
    const value = Number(metres) || 0;
    return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
  };

  function toTimestamp(value) {
    if (value === null || value === undefined || value === '') return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function timeAt(value) {
    const timestamp = toTimestamp(value);
    return timestamp
      ? new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp))
      : '';
  }

  function timeLabel(value) {
    if (!value) return 'Now';
    const [hours, minutes] = value.split(':').map(Number);
    const date = new Date(Date.UTC(2020, 0, 1, hours, minutes));
    return new Intl.DateTimeFormat('en-SG', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(date);
  }

  function draft(value) {
    return {
      origin: value?.origin || '',
      destination: value?.destination || '',
      originPoint: value?.originPoint || null,
      destinationPoint: value?.destinationPoint || null,
      departureTime: value?.departureTime || '08:30',
      timeMode: value?.timeMode === 'arrive' ? 'arrive' : 'depart',
    };
  }

  function load() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return value && typeof value.origin === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  function save(value) {
    saved = value;
    draftState = draft(value);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  function brand() {
    return '<div class="route-brand"><div class="route-wordmark">jalan</div><div class="route-country">SG</div></div>';
  }

  function network() {
    return '<div class="sg-network"><span class="sg-line ns">NS</span><span class="sg-line ew">EW</span><span class="sg-line ne">NE</span><span class="sg-line cc">CC</span><span class="sg-line dt">DT</span><span class="sg-line te">TE</span></div>';
  }

  function setup() {
    const locationRow = (field, label, placeholder, node) => `<button class="route-location-row" data-route-pick="${field}">
      <span class="route-node ${node}"></span>
      <span class="route-field-copy"><span class="route-field-label">${label}</span><span class="route-location-value${draftState[field] ? '' : ' placeholder'}">${escapeHtml(draftState[field] || placeholder)}</span></span>
      <span class="route-map-action">Choose</span>
    </button>`;

    return `<div class="route-panel">
      ${brand()}
      <div class="route-setup-copy"><div class="route-kicker">Bus + MRT · Singapore</div><h1>Where are you going?</h1><p>Pick on the map, use your location, or type a Singapore place.</p>${network()}</div>
      <div class="route-form">
        <div class="route-input-card">${locationRow('origin', 'From', 'Choose where you start', 'origin')}${locationRow('destination', 'To', 'Choose where you’re going', 'destination')}</div>
        <div class="route-time-mode" role="group" aria-label="Journey time preference"><button type="button" class="route-time-mode-button${draftState.timeMode === 'depart' ? ' selected' : ''}" data-route-action="time-mode" data-time-mode="depart">Leave at</button><button type="button" class="route-time-mode-button${draftState.timeMode === 'arrive' ? ' selected' : ''}" data-route-action="time-mode" data-time-mode="arrive">Arrive by</button></div>
        <label class="route-time-field"><span><span class="route-field-label">${draftState.timeMode === 'arrive' ? 'Arrive by' : 'Leave at'}</span><small>Used to calculate the commute timetable</small></span><input id="route-time-input" type="time" value="${escapeHtml(draftState.departureTime || '08:30')}" step="300"></label>
        <button class="route-primary" data-route-action="save" ${draftState.origin && draftState.destination ? '' : 'disabled'}>${saved ? 'Update' : 'Save'} commute</button>
      </div>
      <button class="route-link" data-route-action="bus">I only need bus arrivals</button>
    </div>`;
  }

  function picker() {
    const value = draftState[pickerField] || '';
    return `<div class="route-picker"><div class="picker-topbar"><button class="picker-back" data-route-action="cancel">‹</button><div><div class="route-kicker">${pickerField === 'origin' ? 'From' : 'To'}</div><div class="picker-title">Choose on map</div></div></div><div class="mapbox-stage"><div id="route-map" class="route-map"></div><div class="picker-crosshair"><span></span></div><div id="map-fallback" class="map-fallback" hidden><strong>Map unavailable</strong><span>Type the location below instead.</span></div><button class="picker-locate" data-route-action="locate">◎ My location</button></div><div class="picker-sheet"><div class="route-card-label">Selected area</div><div id="picker-label" class="picker-place">${escapeHtml(mapPosition.label)}</div><div id="picker-coords" class="picker-coords">${mapPosition.center.lat.toFixed(5)}, ${mapPosition.center.lng.toFixed(5)}</div><button class="route-primary" data-route-action="confirm">Use this point</button><div class="picker-divider"><span>or type a place</span></div><div class="picker-manual-row"><input id="picker-manual-input" class="picker-manual-input" value="${escapeHtml(value)}" placeholder="Tampines MRT, postal code, Blk 123…"><button class="picker-manual-button" data-route-action="manual" ${value ? '' : 'disabled'}>Use</button></div></div></div>`;
  }

  function journey() {
    const itinerary = routeState.data;
    const departure = itinerary?.startTime ? timeAt(itinerary.startTime) : timeLabel(saved?.departureTime || draftState.departureTime);
    const arrival = itinerary?.endTime ? timeAt(itinerary.endTime) : '—';
    const arriveBy = saved?.timeMode === 'arrive';
    const requested = timeLabel(saved?.departureTime || draftState.departureTime);
    return `<section class="journey-card"><div class="journey-row"><span class="route-node origin"></span><div><div class="journey-label">From</div><div class="journey-place">${escapeHtml(saved.origin)}</div></div></div><div class="journey-row"><span class="route-node destination"></span><div><div class="journey-label">To</div><div class="journey-place">${escapeHtml(saved.destination)}</div></div></div><div class="journey-time-grid"><div><span class="route-field-label">${arriveBy ? 'Arrive by' : 'Leave at'}</span><strong>${escapeHtml(arriveBy ? requested : departure)}</strong></div><div><span class="route-field-label">${arriveBy ? 'Expected departure' : 'Expected arrival'}</span><strong>${escapeHtml(arriveBy ? (departure || '—') : (arrival || '—'))}</strong></div></div></section>`;
  }

  function timing(leg) {
    if (leg.mode === 'BUS' && leg.live?.arrivals) {
      const arrivals = leg.live.arrivals.filter(Number.isFinite).slice(0, 3);
      if (arrivals.length) return `<div class="leg-live"><span class="live-dot"></span>${arrivals.map((value) => `<b>${value === 0 ? 'Arr' : `${value} min`}</b>`).join('')}<em>live</em></div>`;
    }
    if (leg.mode === 'BUS' && leg.liveStatus === 'loading') return '<div class="leg-live muted">Checking live arrivals…</div>';
    if (leg.mode === 'SUBWAY' && leg.trainStatus === 'loading') return '<div class="leg-live muted">Checking LTA train updates…</div>';
    if (leg.mode === 'SUBWAY' && leg.trainRealtime?.alertText) return `<div class="leg-live alert"><span class="live-dot"></span><b>${escapeHtml(leg.trainRealtime.alertText)}</b><em>LTA alert</em></div>`;
    if (leg.mode === 'SUBWAY' && leg.trainRealtime && (leg.trainRealtime.departureTime || leg.trainRealtime.arrivalTime)) {
      const departure = leg.trainRealtime.departureTime ? timeAt(leg.trainRealtime.departureTime) : '—';
      const arrival = leg.trainRealtime.arrivalTime ? timeAt(leg.trainRealtime.arrivalTime) : '—';
      const delay = leg.trainRealtime.delay ? ` · ${Math.round(leg.trainRealtime.delay / 60)} min delay` : '';
      return `<div class="leg-live train"><span class="live-dot"></span><b>${departure} → ${arrival}</b><em>live${delay}</em></div>`;
    }
    if (leg.mode === 'SUBWAY' && leg.trainStatus === 'ready') return '<div class="leg-live train"><span class="live-dot"></span><b>Realtime feed connected</b><em>LTA</em></div>';
    if (leg.mode === 'SUBWAY' && leg.trainStatus === 'error') return '<div class="leg-live scheduled"><b>Schedule fallback</b><em>LTA unavailable</em></div>';
    if (leg.mode === 'SUBWAY' && leg.departureTime) return `<div class="leg-live scheduled"><b>${timeAt(leg.departureTime)}</b><em>scheduled</em></div>`;
    return '';
  }

  function transferPoint(previous, current) {
    if (!previous || !current || !['BUS', 'SUBWAY'].includes(previous.mode) || !['BUS', 'SUBWAY'].includes(current.mode)) return '';
    const name = current.fromName || previous.toName;
    if (!name || name === previous.fromName) return '';
    return `<div class="timeline-transfer"><span>Transfer</span><strong>${escapeHtml(name)}</strong></div>`;
  }

  function legTitle(leg) {
    if (leg.mode === 'WALK') return leg.toName ? `Walk to ${leg.toName}` : 'Walk';
    if (leg.mode === 'BUS') return `Bus ${leg.routeName || 'service'}`;
    if (leg.mode === 'SUBWAY') return leg.lineName ? `MRT · ${leg.lineName}` : 'MRT';
    return leg.mode;
  }

  function legMeta(leg) {
    const points = [leg.fromName, leg.toName].filter(Boolean).join(' → ');
    const details = [];
    if (points) details.push(points);
    if (leg.stopCount) details.push(`${leg.stopCount} stop${leg.stopCount === 1 ? '' : 's'}`);
    if (leg.distance) details.push(distanceLabel(leg.distance));
    return details.join(' · ');
  }

  function legTimes(leg) {
    if (leg.departureTime && leg.arrivalTime) return `${timeAt(leg.departureTime)} → ${timeAt(leg.arrivalTime)}`;
    if (leg.departureTime) return `Departs ${timeAt(leg.departureTime)}`;
    return leg.duration ? durationLabel(leg.duration) : '';
  }

  function timeline(itinerary) {
    const legs = itinerary?.legs || [];
    if (!legs.length) return '<div class="timeline-empty">No step-by-step details returned.</div>';
    return `<div class="timeline">${legs.map((leg, index) => `${transferPoint(legs[index - 1], leg)}<button type="button" class="timeline-item${selectedLegIndex === index ? ' selected' : ''}${leg.mode === 'SUBWAY' && leg.trainRealtime?.alertText ? ' affected' : ''}" data-route-action="leg" data-route-leg="${index}"><div class="timeline-rail"><span class="timeline-dot ${leg.mode.toLowerCase()}"></span></div><div class="timeline-body"><div class="timeline-head"><strong>${escapeHtml(legTitle(leg))}</strong><span class="timeline-mode">${leg.mode === 'SUBWAY' ? 'MRT' : escapeHtml(leg.mode)}</span></div><div class="timeline-meta">${escapeHtml(legMeta(leg))}</div>${leg.mode === 'SUBWAY' && leg.trainRealtime?.alertText ? '<div class="timeline-alert-label">LTA service alert</div>' : ''}<div class="timeline-foot"><span>${escapeHtml(legTimes(leg))}</span>${leg.mode === 'WALK' ? '' : timing(leg)}</div></div></button>`).join('')}</div>`;
  }

  function itinerarySignature(itinerary) {
    return (itinerary?.legs || []).map((leg) => [leg.mode, leg.routeName, leg.fromId || leg.fromName, leg.toId || leg.toName].join(':')).join('|');
  }

  function alternativeOptions(itinerary) {
    const source = itinerary?.alternatives || [itinerary];
    const usable = source.filter(Boolean);
    if (usable.length < 2) return [];
    const fastest = usable.reduce((best, item) => (!best || item.duration < best.duration ? item : best), null);
    const lessWalking = usable.reduce((best, item) => (!best || item.walkDuration < best.walkDuration || (item.walkDuration === best.walkDuration && item.duration < best.duration) ? item : best), null);
    const fewerTransfers = usable.reduce((best, item) => (!best || item.transfers < best.transfers || (item.transfers === best.transfers && item.duration < best.duration) ? item : best), null);
    const options = [{ key: 'fastest', label: 'Fastest', itinerary: fastest }, { key: 'walking', label: 'Less walking', itinerary: lessWalking }, { key: 'transfers', label: 'Fewer transfers', itinerary: fewerTransfers }];
    const seen = new Set();
    return options.filter((option) => {
      const signature = itinerarySignature(option.itinerary);
      if (!signature || seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
  }

  function alternatives(itinerary) {
    const options = alternativeOptions(itinerary);
    if (options.length < 2) return '';
    const selectedSignature = itinerarySignature(itinerary);
    const tabs = options.map((option) => '<button class="route-alternative' + (itinerarySignature(option.itinerary) === selectedSignature ? ' selected' : '') + '" data-route-action="alternative" data-route-alternative="' + option.key + '"><strong>' + escapeHtml(option.label) + '</strong><span>' + durationLabel(option.itinerary.duration) + ' · ' + option.itinerary.transfers + ' transfer' + (option.itinerary.transfers === 1 ? '' : 's') + '</span></button>').join('');
    return '<div class="route-alternatives"><div class="route-card-label">Compare routes</div><div class="route-alternative-tabs">' + tabs + '</div></div>';
  }

  function routeLabel(itinerary) {
    const choice = itinerary.choiceLabel ? `${itinerary.choiceLabel} · ` : '';
    if (itinerary.service === 'next') return `${choice}Next available route · ${timeAt(itinerary.startTime)}`;
    if (itinerary.service === 'planned') return `${choice}${saved?.timeMode === 'arrive' ? 'Route arriving by' : 'Route leaving at'} ${timeLabel(saved.departureTime)}`;
    return `${choice}Best route now`;
  }

  function disruptionBanner(itinerary) {
    const alerts = (itinerary?.liveAlerts || []).filter((alert) => alert.header || alert.description);
    if (!alerts.length) return '';
    const first = alerts[0];
    const rerouting = routeState.status === 'rerouting';
    const detail = first.description && first.description !== first.header ? `<p>${escapeHtml(first.description)}</p>` : '';
    const count = alerts.length > 1 ? `${alerts.length} LTA alerts` : 'Affects this journey';
    return `<div class="route-disruption" role="alert"><div class="route-disruption-top"><span class="route-disruption-label"><span class="live-dot"></span>LTA service alert</span><span class="route-disruption-count">${escapeHtml(count)}</span></div><strong>${escapeHtml(first.header || first.description)}</strong>${detail}<button class="route-disruption-action" data-route-action="reroute" ${rerouting ? 'disabled' : ''}>${rerouting ? 'Finding a better route…' : 'Find a better route'}</button></div>`;
  }

  function card() {
    if (!saved.originPoint || !saved.destinationPoint) return '<section class="best-route-card"><div class="route-card-label">Journey timeline</div><h2>Map both endpoints</h2><p>Choose exact points so Jalan can calculate the journey.</p></section>';
    if (routeState.status === 'loading') return '<section class="best-route-card"><div class="route-card-label">Journey timeline</div><h2>Finding route…</h2><p>Checking Singapore public transport.</p></section>';
    if (routeState.status === 'error') return `<section class="best-route-card"><div class="route-card-label">Journey timeline</div><h2>Routing unavailable</h2><p>${escapeHtml(routeState.error)}</p><button class="route-link" data-route-action="refresh">Retry</button></section>`;
    const itinerary = routeState.data;
    if (!itinerary) return '';
    const rerouting = routeState.status === 'rerouting' ? '<div class="route-rerouting" role="status">Recalculating with the latest route data…</div>' : '';
    const notice = routeState.notice ? `<div class="route-inline-notice" role="status">${escapeHtml(routeState.notice)}</div>` : '';
    return `<section class="best-route-card"><div class="route-card-top"><div><div class="route-card-label">${escapeHtml(routeLabel(itinerary))}</div><h2>${durationLabel(itinerary.duration)}</h2></div><div class="route-summary-meta">${itinerary.transfers} transfer${itinerary.transfers === 1 ? '' : 's'}</div></div>${rerouting}${notice}${disruptionBanner(itinerary)}${alternatives(itinerary)}${timeline(itinerary)}<button class="route-view-button" data-route-action="viewer">View route on map</button></section>`;
  }

  function dashboard() {
    const itinerary = routeState.data;
    const hasBus = itinerary?.legs.some((leg) => leg.mode === 'BUS');
    const hasMrt = itinerary?.legs.some((leg) => leg.mode === 'SUBWAY');
    const trainLive = itinerary?.legs.some((leg) => leg.mode === 'SUBWAY' && leg.trainStatus === 'ready');
    const sourceCopy = `${hasBus ? 'Bus legs show LTA real-time arrivals. ' : ''}${hasMrt ? (trainLive ? 'MRT legs use LTA GTFS-Realtime trip updates when available.' : 'MRT legs use OneMap schedule timings with a live-feed fallback.') : ''}${hasBus || hasMrt ? ' Live timings refresh every 45 seconds while this screen is open.' : ''}`;
    const sourceHeading = `Bus ${hasBus ? 'live' : '—'} · MRT ${hasMrt ? (trainLive ? 'live' : 'scheduled') : '—'}`;
    return `<div class="route-panel">${brand()}<div class="route-header"><div><div class="route-kicker">Saved commute</div><h1>Ready when you are.</h1></div><button class="route-link compact" data-route-action="edit">Edit</button></div>${journey()}${card()}<section class="timing-card"><div class="timing-heading"><div><div class="route-card-label">Timing sources</div><h2>${sourceHeading}</h2></div><div class="timing-status"><span class="live-state">LTA</span><span id="live-freshness" class="live-freshness">${escapeHtml(liveFreshness())}</span></div></div><p>${escapeHtml(sourceCopy || 'Live timing appears with the calculated route.')}</p></section><div class="route-actions"><button class="route-primary" data-route-action="refresh">Refresh route + timings</button><button class="route-link" data-route-action="bus">Open bus arrivals</button><button class="route-link" data-route-action="clear">Remove saved commute</button></div></div>`;
  }

  function hasLiveTiming(itinerary) {
    return Boolean(itinerary?.legs?.some((leg) => leg.mode === 'BUS' || leg.mode === 'SUBWAY'));
  }

  function liveHasError(itinerary) {
    return Boolean(itinerary?.legs?.some((leg) => (leg.mode === 'BUS' && leg.liveStatus === 'error') || (leg.mode === 'SUBWAY' && leg.trainStatus === 'error')));
  }

  function liveFreshness() {
    if (liveRefreshStatus === 'loading') return 'Updating…';
    if (liveRefreshStatus === 'degraded' && !liveUpdatedAt) return 'LTA unavailable';
    if (!liveUpdatedAt) return 'Checking…';
    const age = Math.max(0, Math.floor((Date.now() - liveUpdatedAt) / 1000));
    const ageLabel = age < 60 ? 'just now' : `${Math.floor(age / 60)} min ago`;
    return liveRefreshStatus === 'degraded' ? `Stale · ${ageLabel}` : `Updated ${ageLabel}`;
  }

  function updateLiveFreshnessDom() {
    const node = document.getElementById('live-freshness');
    if (node) node.textContent = liveFreshness();
  }

  function canRefreshLive() {
    return Boolean(saved && routeState.status === 'ready' && routeState.data && hasLiveTiming(routeState.data) && !pickerField && !viewing && !document.hidden && !shell.hidden);
  }

  function stopLiveRefresh() {
    if (liveRefreshTimer) window.clearTimeout(liveRefreshTimer);
    liveRefreshTimer = null;
  }

  function syncLiveRefresh() {
    if (!canRefreshLive()) {
      stopLiveRefresh();
      return;
    }
    if (!liveRefreshTimer) {
      liveRefreshTimer = window.setTimeout(() => {
        liveRefreshTimer = null;
        refreshLiveTimings();
      }, LIVE_REFRESH_INTERVAL);
    }
  }

  async function refreshLiveTimings() {
    if (!canRefreshLive() || liveRefreshInFlight) {
      syncLiveRefresh();
      return;
    }
    const itinerary = routeState.data;
    liveRefreshInFlight = true;
    liveRefreshStatus = 'loading';
    updateLiveFreshnessDom();
    try {
      await Promise.all([liveBus(itinerary), liveTrain(itinerary)]);
      if (routeState.data === itinerary) {
        const degraded = liveHasError(itinerary);
        if (!degraded) liveUpdatedAt = Date.now();
        liveRefreshStatus = degraded ? 'degraded' : 'ready';
        updateLiveFreshnessDom();
        if (canRefreshLive()) render();
      }
    } catch {
      if (routeState.data === itinerary) {
        liveRefreshStatus = 'degraded';
        updateLiveFreshnessDom();
      }
    } finally {
      liveRefreshInFlight = false;
      syncLiveRefresh();
    }
  }

  function viewer() {
    const itinerary = routeState.data;
    const modeLabel = saved?.timeMode === 'arrive' ? 'Arrive by' : 'Leave at';
    return `<div class="route-viewer"><div class="picker-topbar"><button class="picker-back" data-route-action="close-viewer">‹</button><div><div class="route-kicker">${escapeHtml(modeLabel)} ${escapeHtml(timeLabel(saved.departureTime))}</div><div class="picker-title">${escapeHtml(saved.origin)} → ${escapeHtml(saved.destination)}</div></div></div><div class="route-viewer-map-wrap"><div id="route-viewer-map" class="route-viewer-map"></div><div id="viewer-fallback" class="map-fallback" hidden><strong>Map unavailable</strong><span>The step-by-step route is still shown below.</span></div></div><div class="route-viewer-sheet"><div class="route-viewer-summary"><div><span class="route-card-label">Journey</span><strong>${itinerary ? durationLabel(itinerary.duration) : '—'}</strong></div><span>${itinerary ? itinerary.transfers : 0} transfer${itinerary?.transfers === 1 ? '' : 's'}</span></div>${itinerary ? timeline(itinerary) : ''}</div></div>`;
  }

  function destroyMap() {
    if (map) {
      try { map.remove(); } catch {}
    }
    map = null;
  }

  function render() {
    destroyMap();
    shell.hidden = false;
    shell.innerHTML = pickerField ? picker() : (viewing ? viewer() : (saved ? dashboard() : setup()));
    bind();
    if (pickerField) requestAnimationFrame(renderPickerMap);
    if (viewing) requestAnimationFrame(renderViewerMap);
    if (saved && !pickerField && !viewing && saved.originPoint && saved.destinationPoint && routeState.status === 'idle') routeData();
    syncLiveRefresh();
  }

  function openPicker(field) {
    pickerField = field;
    const point = draftState[`${field}Point`];
    mapPosition = { center: point ? { ...point } : { ...DEFAULT_CENTER }, zoom: point ? 16 : 13.5, label: draftState[field] || 'Pinned location' };
    render();
  }

  function closePicker() {
    pickerField = null;
    render();
  }

  function updatePickerDom() {
    const label = document.getElementById('picker-label');
    const coordinates = document.getElementById('picker-coords');
    if (label) label.textContent = mapPosition.label;
    if (coordinates) coordinates.textContent = `${mapPosition.center.lat.toFixed(5)}, ${mapPosition.center.lng.toFixed(5)}`;
  }

  async function reverseLabel() {
    try {
      const response = await fetch(`/api/location?lat=${mapPosition.center.lat}&lng=${mapPosition.center.lng}`);
      const data = await response.json();
      mapPosition.label = response.ok && data.label ? data.label : 'Pinned location';
    } catch { mapPosition.label = 'Pinned location'; }
    updatePickerDom();
  }

  async function mapToken() {
    const response = await fetch('/api/map-config');
    const data = await response.json();
    if (!response.ok || !data.token) throw new Error(data.error || 'Map unavailable');
    return data.token;
  }

  async function renderPickerMap() {
    const container = document.getElementById('route-map');
    const fallback = document.getElementById('map-fallback');
    if (!container || !pickerField) return;
    if (!window.mapboxgl) { fallback.hidden = false; return; }
    try {
      mapboxgl.accessToken = await mapToken();
      map = new mapboxgl.Map({ container, style: 'mapbox://styles/mapbox/streets-v12', center: [mapPosition.center.lng, mapPosition.center.lat], zoom: mapPosition.zoom, minZoom: 10.5, maxZoom: 18.5, maxBounds: [[103.55, 1.15], [104.1, 1.49]], dragRotate: false, touchPitch: false });
      map.touchZoomRotate.disableRotation();
      map.on('load', reverseLabel);
      map.on('move', () => { const center = map.getCenter(); mapPosition.center = { lat: center.lat, lng: center.lng }; mapPosition.zoom = map.getZoom(); mapPosition.label = 'Pinned location'; updatePickerDom(); });
      map.on('moveend', reverseLabel);
      map.on('error', () => { fallback.hidden = false; });
    } catch { fallback.hidden = false; }
  }

  function decodePolyline(value, precision = 5) {
    let index = 0; let latitude = 0; let longitude = 0; const output = []; const factor = 10 ** precision;
    while (index < value.length) {
      let shift = 0; let result = 0; let byte;
      do { byte = value.charCodeAt(index++) - 63; result |= (byte & 31) << shift; shift += 5; } while (byte >= 32);
      latitude += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { byte = value.charCodeAt(index++) - 63; result |= (byte & 31) << shift; shift += 5; } while (byte >= 32);
      longitude += (result & 1) ? ~(result >> 1) : (result >> 1);
      output.push([longitude / factor, latitude / factor]);
    }
    return output;
  }

  async function renderViewerMap() {
    const container = document.getElementById('route-viewer-map');
    const fallback = document.getElementById('viewer-fallback');
    const itinerary = routeState.data;
    if (!container || !itinerary) return;
    if (!window.mapboxgl) { fallback.hidden = false; return; }
    try {
      mapboxgl.accessToken = await mapToken();
      const features = itinerary.legs.map((leg, index) => { const coordinates = leg.geometry ? decodePolyline(leg.geometry) : []; return coordinates.length > 1 ? { type: 'Feature', properties: { mode: leg.mode, index }, geometry: { type: 'LineString', coordinates } } : null; }).filter(Boolean);
      const selectedLeg = Number.isInteger(selectedLegIndex) ? itinerary.legs[selectedLegIndex] : null;
      const selectedFeature = features.find((feature) => feature.properties.index === selectedLegIndex);
      map = new mapboxgl.Map({ container, style: 'mapbox://styles/mapbox/streets-v12', center: [saved.originPoint.lng, saved.originPoint.lat], zoom: 12.5, dragRotate: false, touchPitch: false });
      map.touchZoomRotate.disableRotation();
      map.on('load', () => {
        if (features.length) {
          map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features } });
          const opacity = selectedLeg ? 0.22 : 0.88;
          map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'WALK'], paint: { 'line-color': '#777', 'line-width': 4, 'line-opacity': opacity, 'line-dasharray': [1, 1.5] } });
          map.addLayer({ id: 'route-bus', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'BUS'], paint: { 'line-color': '#1f7a4d', 'line-width': 6, 'line-opacity': opacity } });
          map.addLayer({ id: 'route-mrt', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'SUBWAY'], paint: { 'line-color': '#222', 'line-width': 7, 'line-opacity': opacity } });
          if (selectedLeg) map.addLayer({ id: 'route-selected', type: 'line', source: 'route', filter: ['==', ['get', 'index'], selectedLegIndex], paint: { 'line-color': '#D42E12', 'line-width': 9, 'line-opacity': 1 } });
          const bounds = new mapboxgl.LngLatBounds();
          const focusFeatures = selectedFeature ? [selectedFeature] : features;
          focusFeatures.forEach((feature) => feature.geometry.coordinates.forEach((coordinate) => bounds.extend(coordinate)));
          if (selectedLeg?.fromPoint) bounds.extend([selectedLeg.fromPoint.lng, selectedLeg.fromPoint.lat]);
          if (selectedLeg?.toPoint) bounds.extend([selectedLeg.toPoint.lng, selectedLeg.toPoint.lat]);
          if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 48, duration: 0 });
        } else if (selectedLeg?.fromPoint || selectedLeg?.toPoint) {
          const bounds = new mapboxgl.LngLatBounds();
          if (selectedLeg.fromPoint) bounds.extend([selectedLeg.fromPoint.lng, selectedLeg.fromPoint.lat]);
          if (selectedLeg.toPoint) bounds.extend([selectedLeg.toPoint.lng, selectedLeg.toPoint.lat]);
          if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 72, duration: 0 });
        }
        new mapboxgl.Marker({ color: '#16181A' }).setLngLat([saved.originPoint.lng, saved.originPoint.lat]).addTo(map);
        new mapboxgl.Marker({ color: '#D42E12' }).setLngLat([saved.destinationPoint.lng, saved.destinationPoint.lat]).addTo(map);
        if (selectedLeg) {
          const from = selectedLeg.fromPoint || (selectedFeature?.geometry.coordinates[0] ? { lng: selectedFeature.geometry.coordinates[0][0], lat: selectedFeature.geometry.coordinates[0][1] } : null);
          const lastCoordinate = selectedFeature?.geometry.coordinates[selectedFeature.geometry.coordinates.length - 1];
          const to = selectedLeg.toPoint || (lastCoordinate ? { lng: lastCoordinate[0], lat: lastCoordinate[1] } : null);
          if (from) new mapboxgl.Marker({ color: '#005EC4' }).setLngLat([from.lng, from.lat]).addTo(map);
          if (to) new mapboxgl.Marker({ color: '#D42E12' }).setLngLat([to.lng, to.lat]).addTo(map);
        }
      });
      map.on('error', () => { if (fallback) fallback.hidden = false; });
    } catch { if (fallback) fallback.hidden = false; }
  }

  async function manualLocation() {
    const input = document.getElementById('picker-manual-input');
    const value = input?.value.trim();
    if (!value) return;
    try {
      const response = await fetch(`/api/location?q=${encodeURIComponent(value)}`);
      const data = await response.json();
      draftState[pickerField] = data.label || value;
      draftState[`${pickerField}Point`] = response.ok && data.point ? data.point : null;
    } catch { draftState[pickerField] = value; draftState[`${pickerField}Point`] = null; }
    closePicker();
  }

  function locate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((position) => {
      mapPosition.center = { lat: position.coords.latitude, lng: position.coords.longitude };
      mapPosition.zoom = 16.5;
      mapPosition.label = 'My location';
      if (map) map.easeTo({ center: [mapPosition.center.lng, mapPosition.center.lat], zoom: mapPosition.zoom }); else updatePickerDom();
    }, () => {}, { timeout: 7000, maximumAge: 60000 });
  }

  function normalizedMode(value) {
    const mode = String(value || '').toUpperCase();
    if (mode === 'WALK' || mode === 'WALKING') return 'WALK';
    if (mode === 'BUS') return 'BUS';
    if (['SUBWAY', 'RAIL', 'TRAIN', 'TRAM', 'LIGHTRAIL'].includes(mode)) return 'SUBWAY';
    return mode || 'OTHER';
  }

  function placeName(place) { return String(place?.name || place?.stopName || place?.stationName || place?.description || '').trim(); }
  function placeId(place) { return String(place?.stopId || place?.stationId || place?.id || place?.stopCode || '').trim(); }
  function stopCode(place) { return String(place?.stopCode || '').trim(); }
  function placePoint(place) {
    const lat = Number(place?.lat ?? place?.latitude);
    const lng = Number(place?.lon ?? place?.lng ?? place?.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }

  function stopCount(leg) {
    const stops = leg?.intermediateStops || leg?.stops || [];
    if (Array.isArray(stops) && stops.length) return stops.length + 1;
    const count = Number(leg?.numStops || leg?.stopCount || 0);
    return Number.isFinite(count) && count > 0 ? count : null;
  }

  function normalizeLeg(leg, index) {
    const mode = normalizedMode(leg.mode); const from = leg.from || {}; const to = leg.to || {};
    const routeName = String(leg.routeShortName || leg.route || leg.routeId || '').trim();
    const lineName = String(leg.routeLongName || leg.routeName || routeName).trim();
    return { index, mode, routeName, lineName, label: mode === 'WALK' ? `Walk ${distanceLabel(leg.distance)}` : `${mode === 'SUBWAY' ? 'MRT' : mode}${routeName ? ` ${routeName}` : ''}`, detail: [placeName(from), placeName(to)].filter(Boolean).join(' → '), fromName: placeName(from), toName: placeName(to), fromId: placeId(from), toId: placeId(to), fromPoint: placePoint(from), toPoint: placePoint(to), stopCode: stopCode(from), departureTime: toTimestamp(leg.startTime || leg.departureTime || from.departure || from.departureTime), arrivalTime: toTimestamp(leg.endTime || leg.arrivalTime || to.arrival || to.arrivalTime), duration: Number(leg.duration) || 0, distance: Number(leg.distance) || 0, stopCount: mode === 'WALK' ? null : stopCount(leg), liveStatus: mode === 'BUS' ? 'loading' : null, geometry: String(leg.legGeometry?.points || leg.geometry || '') };
  }

  function normalizeItinerary(itinerary, service) {
    const legs = (itinerary?.legs || []).map(normalizeLeg); const transitLegs = legs.filter((leg) => ['BUS', 'SUBWAY'].includes(leg.mode));
    const startTime = toTimestamp(itinerary?.startTime || legs[0]?.departureTime); const endTime = toTimestamp(itinerary?.endTime || legs[legs.length - 1]?.arrivalTime);
    return { duration: Number(itinerary?.duration) || (startTime && endTime ? Math.max(0, Math.round((endTime - startTime) / 1000)) : 0), transfers: Number.isFinite(Number(itinerary?.transfers)) ? Number(itinerary.transfers) : Math.max(0, transitLegs.length - 1), startTime, endTime, service, walkDuration: legs.filter((leg) => leg.mode === 'WALK').reduce((sum, leg) => sum + leg.duration, 0), walkDistance: legs.filter((leg) => leg.mode === 'WALK').reduce((sum, leg) => sum + leg.distance, 0), legs };
  }

  function normalizeRoute(raw) {
    const plan = raw?.plan || raw?.data?.plan; const itineraries = Array.isArray(plan?.itineraries) ? plan.itineraries : [];
    const alternatives = itineraries.map((itinerary) => normalizeItinerary(itinerary, raw?._jalan?.service || 'now')); const primary = alternatives[0];
    if (!primary) return null; primary.alternatives = alternatives; return primary;
  }

  async function liveBus(itinerary) {
    await Promise.all(itinerary.legs.filter((leg) => leg.mode === 'BUS' && /^\d{5}$/.test(leg.stopCode) && leg.routeName).map(async (leg) => {
      try {
        const response = await fetch(`/api/bus-arrivals?stopCode=${leg.stopCode}&services=${encodeURIComponent(leg.routeName)}`); const data = await response.json();
        if (response.ok) { leg.live = data.services?.[0] || null; leg.liveStatus = 'ready'; } else leg.liveStatus = 'error';
      } catch { leg.liveStatus = 'error'; }
    }));
  }

  function trainLineKey(value) {
    const token = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const aliases = {
      NSL: ['NSL', 'NS', 'NORTHSOUTH', 'NORTHSOUTHLINE'],
      EWL: ['EWL', 'EW', 'EASTWEST', 'EASTWESTLINE'],
      NEL: ['NEL', 'NE', 'NORTHEAST', 'NORTHEASTLINE'],
      CCL: ['CCL', 'CC', 'CIRCLE', 'CIRCLELINE'],
      DTL: ['DTL', 'DT', 'DOWNTOWN', 'DOWNTOWNLINE'],
      TEL: ['TEL', 'TE', 'THOMSONEASTCOAST', 'THOMSONEASTCOASTLINE'],
      BPL: ['BPL', 'BP', 'BUKITPANJANG', 'BUKITPANJANGLRT'],
      SGL: ['SGL', 'SE', 'SENGKANG', 'SENGKANGLRT'],
      PGL: ['PGL', 'PE', 'PUNGGOL', 'PUNGGOLLRT'],
    };
    return Object.entries(aliases).find(([, values]) => values.some((alias) => token === alias || token.includes(alias)))?.[0] || token;
  }

  function sameStop(left, right) {
    const a = String(left || '').toUpperCase();
    const b = String(right || '').toUpperCase();
    return Boolean(a && b && (a === b || a.endsWith(b) || b.endsWith(a)));
  }

  function trainAlertMatches(leg, alert) {
    const selectors = alert?.selectors || [];
    if (!selectors.length) return true;
    const routeKey = trainLineKey(leg.routeName || leg.lineName);
    return selectors.some((selector) => {
      const routeMatch = selector.routeId && routeKey && trainLineKey(selector.routeId) === routeKey;
      const stopMatch = selector.stopId && (sameStop(selector.stopId, leg.fromId) || sameStop(selector.stopId, leg.toId));
      return routeMatch || stopMatch;
    });
  }

  function relevantTrainAlerts(itinerary, payload) {
    const legs = (itinerary?.legs || []).filter((leg) => leg.mode === 'SUBWAY');
    const seen = new Set();
    return (payload?.alerts || [])
      .filter((alert) => legs.some((leg) => trainAlertMatches(leg, alert)))
      .filter((alert) => {
        const key = alert.id || alert.header || alert.description;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3);
  }

  function trainMatch(leg, payload) {
    const updates = payload?.updates || [];
    const routeKey = trainLineKey(leg.routeName || leg.lineName);
    const routeUpdates = updates.filter((update) => !update.routeId || !routeKey || trainLineKey(update.routeId) === routeKey);
    const candidates = routeUpdates.length ? routeUpdates : updates.filter((update) => update.stops?.some((stop) => sameStop(stop.stopId, leg.fromId) || sameStop(stop.stopId, leg.toId)));
    const update = candidates.find((item) => item.stops?.some((stop) => sameStop(stop.stopId, leg.fromId)) && item.stops?.some((stop) => sameStop(stop.stopId, leg.toId))) || candidates.find((item) => item.stops?.some((stop) => sameStop(stop.stopId, leg.fromId))) || candidates[0];
    if (!update) return null;

    const orderedStops = [...(update.stops || [])].sort((a, b) => (a.stopSequence || 0) - (b.stopSequence || 0));
    const fromStop = orderedStops.find((stop) => sameStop(stop.stopId, leg.fromId)) || orderedStops.find((stop) => stop.departureTime || stop.arrivalTime);
    const toStop = orderedStops.find((stop) => sameStop(stop.stopId, leg.toId)) || [...orderedStops].reverse().find((stop) => stop.arrivalTime || stop.departureTime);
    const alert = (payload.alerts || []).find((item) => (item.header || item.description) && trainAlertMatches(leg, item));
    return {
      departureTime: fromStop?.departureTime || fromStop?.arrivalTime || 0,
      arrivalTime: toStop?.arrivalTime || toStop?.departureTime || 0,
      delay: fromStop?.departureDelay || fromStop?.arrivalDelay || update.delay || 0,
      alertText: alert?.header || alert?.description || '',
    };
  }

  async function liveTrain(itinerary) {
    const legs = itinerary.legs.filter((leg) => leg.mode === 'SUBWAY');
    if (!legs.length) return;
    legs.forEach((leg) => { leg.trainStatus = 'loading'; });
    const routes = [...new Set(legs.flatMap((leg) => [leg.routeName, leg.lineName]).filter(Boolean))];
    const stops = [...new Set(legs.flatMap((leg) => [leg.fromId, leg.toId]).filter(Boolean))];
    try {
      const query = new URLSearchParams();
      if (routes.length) query.set('routes', routes.join(','));
      if (stops.length) query.set('stops', stops.join(','));
      const response = await fetch(`/api/train-realtime?${query}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'LTA train feed unavailable.');
      itinerary.liveAlerts = relevantTrainAlerts(itinerary, payload);
      itinerary.trainFeedUpdatedAt = payload.updatedAt || '';
      legs.forEach((leg) => {
        leg.trainRealtime = trainMatch(leg, payload);
        leg.trainStatus = 'ready';
      });
    } catch {
      legs.forEach((leg) => { leg.trainStatus = 'error'; });
    }
  }

  async function selectAlternative(key) {
    const current = routeState.data;
    const choice = alternativeOptions(current).find((option) => option.key === key);
    if (!choice || itinerarySignature(choice.itinerary) === itinerarySignature(current)) return;
    selectedLegIndex = null;
    liveUpdatedAt = 0;
    liveRefreshStatus = 'loading';
    const selected = { ...choice.itinerary, alternatives: current.alternatives, choiceLabel: choice.label };
    routeState = { status: 'ready', data: selected, error: '' };
    render();
    await Promise.all([liveBus(selected), liveTrain(selected)]);
    if (routeState.data === selected) { const degraded = liveHasError(selected); if (!degraded) liveUpdatedAt = Date.now(); liveRefreshStatus = degraded ? 'degraded' : 'ready'; render(); }
  }

  async function routeData({ preserveCurrent = false } = {}) {
    if (preserveCurrent && routeState.status === 'rerouting') return;
    const previous = preserveCurrent ? routeState.data : null;
    const previousUpdatedAt = liveUpdatedAt;
    const previousRefreshStatus = liveRefreshStatus;
    selectedLegIndex = null;
    liveUpdatedAt = 0;
    liveRefreshStatus = 'loading';
    routeState = { status: previous ? 'rerouting' : 'loading', data: previous || null, error: '', notice: '' }; render();
    const start = `${saved.originPoint.lat},${saved.originPoint.lng}`; const end = `${saved.destinationPoint.lat},${saved.destinationPoint.lng}`; const time = saved.departureTime ? `&time=${encodeURIComponent(saved.departureTime)}` : ''; const timeMode = `&timeMode=${encodeURIComponent(saved.timeMode === 'arrive' ? 'arrive' : 'depart')}`;
    try {
      const response = await fetch(`/api/route?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${time}${timeMode}`); const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Routing unavailable.'); const itinerary = normalizeRoute(data); if (!itinerary) throw new Error('No public-transport itinerary.');
      routeState = { status: 'ready', data: itinerary, error: '' }; render(); await Promise.all([liveBus(itinerary), liveTrain(itinerary)]); if (routeState.data === itinerary) { const degraded = liveHasError(itinerary); if (!degraded) liveUpdatedAt = Date.now(); liveRefreshStatus = degraded ? 'degraded' : 'ready'; render(); }
    } catch (error) {
      if (previous) {
        liveUpdatedAt = previousUpdatedAt;
        liveRefreshStatus = previousRefreshStatus;
        routeState = { status: 'ready', data: previous, error: '', notice: `Could not find a better route: ${error.message || 'routing is unavailable.'} Your current route is still shown.` };
      } else {
        routeState = { status: 'error', data: null, error: error.message || 'Routing unavailable.' };
      }
      render();
    }
  }

  function bind() {
    shell.querySelectorAll('[data-route-pick]').forEach((button) => { button.onclick = () => openPicker(button.dataset.routePick); });
    const input = document.getElementById('picker-manual-input'); const useButton = shell.querySelector('[data-route-action="manual"]');
    if (input) { input.oninput = () => { useButton.disabled = !input.value.trim(); }; input.onkeydown = (event) => { if (event.key === 'Enter') manualLocation(); }; }
    const timeInput = document.getElementById('route-time-input'); if (timeInput) timeInput.oninput = () => { draftState.departureTime = timeInput.value || '08:30'; };
    shell.querySelectorAll('[data-route-action]').forEach((button) => {
      button.onclick = () => {
        const action = button.dataset.routeAction;
        if (action === 'bus') { stopLiveRefresh(); destroyMap(); shell.hidden = true; launcher.hidden = false; }
        else if (action === 'edit') { draftState = draft(saved); saved = null; routeState = { status: 'idle', data: null, error: '' }; render(); }
        else if (action === 'save') { if (draftState.origin && draftState.destination) { save({ id: 'route-1', ...draftState, updatedAt: new Date().toISOString() }); routeState = { status: 'idle', data: null, error: '' }; render(); } }
        else if (action === 'clear') { stopLiveRefresh(); localStorage.removeItem(STORAGE_KEY); saved = null; draftState = draft(); routeState = { status: 'idle', data: null, error: '' }; liveUpdatedAt = 0; liveRefreshStatus = 'idle'; render(); }
        else if (action === 'cancel') closePicker();
        else if (action === 'confirm') { draftState[pickerField] = mapPosition.label === 'Singapore' ? 'Pinned location' : mapPosition.label; draftState[`${pickerField}Point`] = { ...mapPosition.center }; closePicker(); }
        else if (action === 'manual') manualLocation();
        else if (action === 'locate') locate();
        else if (action === 'refresh') { routeState = { status: 'idle', data: null, error: '' }; render(); }
        else if (action === 'time-mode') { draftState.timeMode = button.dataset.timeMode === 'arrive' ? 'arrive' : 'depart'; render(); }
        else if (action === 'leg' && routeState.data) { const index = Number(button.dataset.routeLeg); if (Number.isInteger(index) && index >= 0 && index < routeState.data.legs.length) { selectedLegIndex = index; viewing = true; render(); } }
        else if (action === 'alternative') selectAlternative(button.dataset.routeAlternative);
        else if (action === 'reroute') routeData({ preserveCurrent: true });
        else if (action === 'viewer' && routeState.data) { selectedLegIndex = null; viewing = true; render(); }
        else if (action === 'close-viewer') { viewing = false; selectedLegIndex = null; render(); refreshLiveTimings(); }
      };
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopLiveRefresh();
      return;
    }
    refreshLiveTimings();
    syncLiveRefresh();
  });

  launcher.onclick = () => { shell.hidden = false; launcher.hidden = true; render(); };
  document.body.append(shell, launcher);
  render();
})();
