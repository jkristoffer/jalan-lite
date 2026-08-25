(() => {
  const STORAGE_KEY = 'jalan-lite-routes-v1';
  const DEFAULT_CENTER = { lat: 1.3521, lng: 103.8198 };
  const LIVE_REFRESH_INTERVAL = 45000;
  const shell = document.createElement('section');
  const launcher = document.createElement('button');
  const disruptionTools = window.JalanDisruptions;
  const liveTools = window.JalanLiveStatus;
  const runtime = window.JalanRuntime;
  const routeRequests = runtime.createRequestCoordinator();
  const liveRequests = runtime.createRequestCoordinator();

  let saved = load();
  let draftState = draft(saved);
  let pickerField = null;
  let mapPosition = { center: { ...DEFAULT_CENTER }, zoom: 14, label: 'Singapore' };
  let routeState = { status: 'idle', data: null, error: '' };
  let map = null;
  let mapGeneration = 0;
  let viewing = false;
  let selectedLegIndex = null;
  let liveRefreshTimer = null;
  let liveRefreshInFlight = false;
  let liveUpdatedAt = 0;
  let liveRefreshStatus = 'idle';
  let disruptionDemoOpen = false;
  let disruptionDemoStep = 'alert';
  let disruptionDemoTimer = null;
  let notificationState = 'idle';
  let notificationMessage = '';
  let focusMode = false;
  let focusClockTimer = null;
  let focusWakeLock = null;
  let temporalTimer = null;

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
      <div class="route-setup-copy"><div class="route-kicker">Bus + MRT · Singapore</div><h1>Where are you going?</h1><p>Set a start and destination to see your public-transport journey.</p>${network()}</div>
      <div class="route-form">
        <div class="route-input-card">${locationRow('origin', 'From', 'Choose where you start', 'origin')}${locationRow('destination', 'To', 'Choose where you’re going', 'destination')}</div>
        <div class="route-time-mode" role="group" aria-label="Journey time preference"><button type="button" class="route-time-mode-button${draftState.timeMode === 'depart' ? ' selected' : ''}" data-route-action="time-mode" data-time-mode="depart">Leave at</button><button type="button" class="route-time-mode-button${draftState.timeMode === 'arrive' ? ' selected' : ''}" data-route-action="time-mode" data-time-mode="arrive">Arrive by</button></div>
        <label class="route-time-field"><span><span class="route-field-label">${draftState.timeMode === 'arrive' ? 'Arrive by' : 'Leave at'}</span><small>Used to calculate the commute timetable</small></span><input id="route-time-input" type="time" value="${escapeHtml(draftState.departureTime || '08:30')}" step="300"></label>
        <button class="route-primary" data-route-action="save" ${draftState.origin && draftState.destination ? '' : 'disabled'}>${saved ? 'Save changes' : 'Plan this commute'}</button>
      </div>
      <button class="route-link" data-route-action="bus">I only need bus arrivals</button>
      <button class="route-link demo-disruption-link" data-route-action="demo-disruption">Preview disruption flow</button>
    </div>`;
  }

  function picker() {
    const value = draftState[pickerField] || '';
    return `<div class="route-picker"><div class="picker-topbar"><button class="picker-back" aria-label="Back" data-route-action="cancel">‹</button><div><div class="route-kicker">${pickerField === 'origin' ? 'From' : 'To'}</div><div class="picker-title">Choose on map</div></div></div><div class="mapbox-stage"><div id="route-map" class="route-map"></div><div class="picker-crosshair"><span></span></div><div id="map-fallback" class="map-fallback" hidden><strong>Map unavailable</strong><span>Type the location below instead.</span></div><button class="picker-locate" aria-label="Use my current location" data-route-action="locate">◎ My location</button></div><div class="picker-sheet"><div class="route-card-label">Selected area</div><div id="picker-label" class="picker-place">${escapeHtml(mapPosition.label)}</div><div id="picker-coords" class="picker-coords">${mapPosition.center.lat.toFixed(5)}, ${mapPosition.center.lng.toFixed(5)}</div><button class="route-primary" data-route-action="confirm">Use this point</button><div class="picker-divider"><span>or type a place</span></div><div class="picker-manual-row"><input id="picker-manual-input" class="picker-manual-input" value="${escapeHtml(value)}" placeholder="Tampines MRT, postal code, Blk 123…"><button class="picker-manual-button" data-route-action="manual" ${value ? '' : 'disabled'}>Use</button></div></div></div>`;
  }

  function journey() {
    const itinerary = routeState.data;
    const currentRoute = itinerary?.service === 'now' || itinerary?.service === 'next';
    const departure = itinerary?.startTime ? timeAt(itinerary.startTime) : timeLabel(saved?.departureTime || draftState.departureTime);
    const arrival = itinerary?.endTime ? timeAt(itinerary.endTime) : '—';
    const arriveBy = !currentRoute && saved?.timeMode === 'arrive';
    const requested = currentRoute ? (itinerary.service === 'next' ? 'Next available' : 'Now') : timeLabel(saved?.departureTime || draftState.departureTime);
    const leftLabel = currentRoute ? (itinerary.service === 'next' ? 'Next departure' : 'Leave now') : (arriveBy ? 'Arrive by' : 'Leave at');
    return '<section class="journey-card"><div class="journey-row"><span class="route-node origin"></span><div><div class="journey-label">From</div><div class="journey-place">' + escapeHtml(saved.origin) + '</div></div></div><div class="journey-row"><span class="route-node destination"></span><div><div class="journey-label">To</div><div class="journey-place">' + escapeHtml(saved.destination) + '</div></div></div><div class="journey-time-grid"><div><span class="route-field-label">' + leftLabel + '</span><strong>' + escapeHtml(arriveBy ? requested : (currentRoute ? departure : departure)) + '</strong></div><div><span class="route-field-label">' + (arriveBy ? 'Expected departure' : 'Expected arrival') + '</span><strong>' + escapeHtml(arriveBy ? (departure || '—') : (arrival || '—')) + '</strong></div></div></section>';
  }

  function timing(leg) {
    if (leg.mode === 'BUS' && leg.live?.arrivals) {
      const arrivals = leg.live.arrivals.filter(Number.isFinite).slice(0, 3);
      if (arrivals.length) return `<div class="leg-live"><span class="live-dot"></span>${arrivals.map((value) => `<b>${value === 0 ? 'Arr' : `${value} min`}</b>`).join('')}<em>live</em></div>`;
    }
    if (leg.mode === 'BUS' && leg.liveStatus === 'loading') return '<div class="leg-live muted">Checking live arrivals…</div>';
    if (leg.mode === 'BUS' && leg.liveStatus === 'error') return '<div class="leg-live scheduled"><b>Schedule fallback</b><em>LTA unavailable</em></div>';
    if (leg.mode === 'BUS' && leg.liveStatus === 'ready') return '<div class="leg-live scheduled"><b>No live arrival</b><em>LTA</em></div>';
    if (leg.mode === 'SUBWAY' && leg.trainStatus === 'loading') return '<div class="leg-live muted">Checking LTA train updates…</div>';
    if (leg.mode === 'SUBWAY' && leg.trainRealtime?.alertText) return `<div class="leg-live alert"><span class="live-dot"></span><b>${escapeHtml(leg.trainRealtime.alertText)}</b><em>LTA alert</em></div>`;
    if (leg.mode === 'SUBWAY' && leg.trainRealtime && (leg.trainRealtime.departureTime || leg.trainRealtime.arrivalTime)) {
      const departure = leg.trainRealtime.departureTime ? timeAt(leg.trainRealtime.departureTime) : '—';
      const arrival = leg.trainRealtime.arrivalTime ? timeAt(leg.trainRealtime.arrivalTime) : '—';
      const delay = leg.trainRealtime.delay ? ` · ${Math.round(leg.trainRealtime.delay / 60)} min delay` : '';
      return `<div class="leg-live train"><span class="live-dot"></span><b>${departure} → ${arrival}</b><em>live${delay}</em></div>`;
    }
    if (leg.mode === 'SUBWAY' && leg.trainStatus === 'ready') return '<div class="leg-live scheduled"><b>Scheduled timing</b><em>OneMap</em></div>';
    if (leg.mode === 'SUBWAY' && leg.trainStatus === 'error') return '<div class="leg-live scheduled"><b>Schedule fallback</b><em>LTA unavailable</em></div>';
    if (leg.mode === 'SUBWAY' && leg.departureTime) return `<div class="leg-live scheduled"><b>${timeAt(leg.departureTime)}</b><em>scheduled</em></div>`;
    return '';
  }

  function legConfidence(leg) {
    return liveTools.statusForLeg(leg);
  }

  function confidenceMarkup(leg) {
    const status = legConfidence(leg);
    const age = liveTools.ageLabel(status.updatedAt);
    const detail = `${status.source}${age ? ` · ${age}` : ''}`;
    return `<div class="timeline-confidence ${escapeHtml(status.tone)}"><span class="timeline-confidence-label">${escapeHtml(status.label)}</span><span>${escapeHtml(detail)}</span></div>`;
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

  function todayAt(value) {
    const [hours, minutes] = String(value || '').split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date.getTime();
  }

  function focusTimes() {
    const itinerary = routeState.data;
    const departure = itinerary?.startTime ? toTimestamp(itinerary.startTime) : todayAt(saved?.departureTime);
    const arrival = itinerary?.endTime
      ? toTimestamp(itinerary.endTime)
      : departure + ((Number(itinerary?.duration) || 0) * 1000);
    return { departure, arrival };
  }


  function temporalLegs(itinerary, departure) {
    let cursor = departure;
    return (itinerary?.legs || []).map((leg, index) => {
      const start = toTimestamp(leg.departureTime) || cursor;
      const duration = Math.max(0, Number(leg.duration) || 0) * 1000;
      const end = toTimestamp(leg.arrivalTime) || (start + duration);
      cursor = Math.max(cursor, end);
      return { leg, index, start, end };
    });
  }

  function actionLabel(leg, active = false) {
    if (!leg) return 'Follow your saved commute';
    if (leg.mode === 'WALK') return leg.toName ? 'Walk to ' + leg.toName : 'Walk to your next stop';
    if (leg.mode === 'BUS') return (active ? 'Ride ' : 'Take ') + 'Bus ' + (leg.routeName || 'service');
    if (leg.mode === 'SUBWAY') return (active ? 'Ride ' : 'Take ') + (leg.lineName ? 'MRT · ' + leg.lineName : 'the MRT');
    return active ? 'Continue your journey' : 'Follow the route';
  }

  function actionDetail(leg, now = Date.now()) {
    if (!leg) return 'Waiting for the route timetable.';
    const details = [];
    const places = [leg.fromName, leg.toName].filter(Boolean).join(' → ');
    if (places) details.push(places);
    if (leg.stopCount) details.push(leg.stopCount + ' stop' + (leg.stopCount === 1 ? '' : 's'));
    if (leg.distance) details.push(distanceLabel(leg.distance));
    if (leg.duration) details.push(durationLabel(leg.duration));
    if (leg.mode === 'BUS' && Array.isArray(leg.live?.arrivals)) {
      const first = leg.live.arrivals.find((value) => Number.isFinite(value));
      if (Number.isFinite(first)) details.push(first === 0 ? 'Arriving now' : 'Next bus in ' + first + ' min');
    }
    const status = legConfidence(leg);
    const age = liveTools.ageLabel(status.updatedAt, now);
    details.push(status.label + ' · ' + status.source + (age ? ' · ' + age : ''));
    return details.join(' · ');
  }

  function journeyTemporalState(now = Date.now()) {
    const itinerary = routeState.data;
    const { departure, arrival } = focusTimes();
    if (!itinerary || !departure || !arrival) {
      return {
        phase: 'loading',
        label: 'GETTING READY',
        countdownMs: 0,
        currentAction: 'Waiting for your route',
        detail: 'The route timetable is still being prepared.',
        nextAction: '',
        confidenceLeg: null,
        isStale: false,
      };
    }

    const legs = temporalLegs(itinerary, departure);
    if (now < departure) {
      const first = legs[0];
      const next = legs.slice(1).find((entry) => entry.leg.mode !== 'WALK') || legs[1];
      return {
        phase: 'upcoming',
        label: itinerary.service === 'next' ? 'NEXT DEPARTURE' : 'LEAVE IN',
        countdownMs: departure - now,
        currentAction: actionLabel(first?.leg),
        detail: actionDetail(first?.leg, now),
        nextAction: next ? actionLabel(next.leg) : '',
        confidenceLeg: next?.leg || first?.leg || null,
        isStale: false,
      };
    }

    if (now < arrival) {
      const active = legs.find((entry) => now >= entry.start && now < entry.end);
      const upcoming = legs.find((entry) => entry.start > now);
      const current = active || upcoming;
      return {
        phase: active ? 'in_progress' : 'between_legs',
        label: active ? 'NOW' : 'NEXT',
        countdownMs: active ? arrival - now : Math.max(0, (upcoming?.start || arrival) - now),
        currentAction: actionLabel(current?.leg, Boolean(active)),
        detail: actionDetail(current?.leg, now),
        nextAction: active ? (legs.slice(active.index + 1).find((entry) => entry.leg.mode !== 'WALK')?.leg ? actionLabel(legs.slice(active.index + 1).find((entry) => entry.leg.mode !== 'WALK').leg) : '') : '',
        confidenceLeg: current?.leg || null,
        isStale: false,
      };
    }

    return {
      phase: 'complete',
      label: 'TRIP TIME PASSED',
      countdownMs: 0,
      currentAction: 'Ready for a fresh route',
      detail: 'The planned arrival at ' + (saved?.destination || 'your destination') + ' was ' + timeAt(arrival) + '.',
      nextAction: '',
      confidenceLeg: null,
      isStale: true,
    };
  }

  function temporalCountdownLabel(state) {
    if (!state || !state.countdownMs) return '';
    const totalMinutes = Math.max(1, Math.ceil(state.countdownMs / 60000));
    if (state.phase === 'upcoming') return totalMinutes < 60 ? totalMinutes + ' min' : Math.floor(totalMinutes / 60) + ' hr ' + (totalMinutes % 60 ? (totalMinutes % 60) + ' min' : '');
    if (state.phase === 'in_progress' || state.phase === 'between_legs') return 'Arrive in ' + (totalMinutes < 60 ? totalMinutes + ' min' : Math.floor(totalMinutes / 60) + ' hr');
    return '';
  }

  function focusInfo(now = Date.now()) {
    const state = journeyTemporalState(now);
    if (state.phase === 'loading') return { phase: 'loading', label: 'GETTING READY', countdown: '—', context: state.currentAction };
    const phase = state.phase === 'upcoming' ? 'depart' : state.phase === 'complete' ? 'complete' : 'arrive';
    return {
      phase,
      label: state.phase === 'complete' ? 'TRIP TIME PASSED' : state.label,
      countdown: state.countdownMs ? countdownLabel(state.countdownMs) : '—',
      context: state.phase === 'complete' ? state.detail : state.currentAction,
    };
  }

  function countdownLabel(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function focusView() {
    const info = focusInfo();
    const freshness = liveFreshness();
    return `<div class="focus-view"><div class="focus-topbar"><div><div class="route-kicker">Jalan · focus mode</div><div class="focus-route">${escapeHtml(saved.origin)} → ${escapeHtml(saved.destination)}</div></div><button class="focus-exit" data-route-action="exit-focus">Exit</button></div><main class="focus-face"><div id="focus-phase" class="focus-phase focus-phase-${escapeHtml(info.phase)}">${escapeHtml(info.label)}</div><div id="focus-countdown" class="focus-countdown" role="timer" aria-live="off" aria-label="${escapeHtml(info.label)} ${escapeHtml(info.countdown)}">${escapeHtml(info.countdown)}</div><div id="focus-context" class="focus-context">${escapeHtml(info.context)}</div></main><div class="focus-footer"><span id="focus-freshness">${escapeHtml(freshness)}</span><span>Live route data updates automatically</span></div></div>`;
  }

  function updateFocusDom() {
    if (!focusMode) return;
    const info = focusInfo();
    const phase = document.getElementById('focus-phase');
    const countdown = document.getElementById('focus-countdown');
    const context = document.getElementById('focus-context');
    const freshness = document.getElementById('focus-freshness');
    if (phase) { phase.textContent = info.label; phase.className = `focus-phase focus-phase-${info.phase}`; }
    if (countdown) { countdown.textContent = info.countdown; countdown.setAttribute('aria-label', `${info.label} ${info.countdown}`); }
    if (context) context.textContent = info.context;
    if (freshness) freshness.textContent = liveFreshness();
  }

  function stopFocusClock() {
    if (focusClockTimer) window.clearInterval(focusClockTimer);
    focusClockTimer = null;
  }

  async function requestFocusWakeLock() {
    if (!focusMode || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { focusWakeLock = await navigator.wakeLock.request('screen'); } catch { focusWakeLock = null; }
  }

  async function releaseFocusWakeLock() {
    if (!focusWakeLock) return;
    try { await focusWakeLock.release(); } catch {}
    focusWakeLock = null;
  }

  function enterFocusMode() {
    if (!routeState.data) return;
    stopLiveRefresh();
    focusMode = true;
    render();
    requestFocusWakeLock();
    focusClockTimer = window.setInterval(updateFocusDom, 1000);
  }

  function exitFocusMode() {
    focusMode = false;
    stopFocusClock();
    releaseFocusWakeLock();
    render();
    refreshLiveTimings();
  }

  function timeline(itinerary) {
    const legs = itinerary?.legs || [];
    if (!legs.length) return '<div class="timeline-empty">No step-by-step details returned.</div>';
    return `<div class="timeline">${legs.map((leg, index) => `${transferPoint(legs[index - 1], leg)}<button type="button" class="timeline-item${selectedLegIndex === index ? ' selected' : ''}${leg.mode === 'SUBWAY' && leg.trainRealtime?.alertText ? ' affected' : ''}" data-route-action="leg" data-route-leg="${index}"><div class="timeline-rail"><span class="timeline-dot ${leg.mode.toLowerCase()}"></span></div><div class="timeline-body"><div class="timeline-head"><strong>${escapeHtml(legTitle(leg))}</strong><span class="timeline-mode">${leg.mode === 'SUBWAY' ? 'MRT' : escapeHtml(leg.mode)}</span></div><div class="timeline-meta">${escapeHtml(legMeta(leg))}</div>${confidenceMarkup(leg)}${leg.mode === 'SUBWAY' && leg.trainRealtime?.alertText ? '<div class="timeline-alert-label">LTA service alert</div>' : ''}<div class="timeline-foot"><span>${escapeHtml(legTimes(leg))}</span>${leg.mode === 'WALK' ? '' : timing(leg)}</div></div></button>`).join('')}</div>`;
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
    return `<section class="best-route-card"><div class="route-card-top"><div><div class="route-card-label">${escapeHtml(routeLabel(itinerary))}</div><h2>${durationLabel(itinerary.duration)}</h2><p class="route-card-helper">Tap a journey leg to see it on the map.</p></div><div class="route-summary-meta">${itinerary.transfers} transfer${itinerary.transfers === 1 ? '' : 's'}</div></div><button class="focus-launch-button" data-route-action="focus">Enter Focus mode</button>${rerouting}${notice}${disruptionBanner(itinerary)}${alternatives(itinerary)}${timeline(itinerary)}<button class="route-view-button" data-route-action="viewer">View route on map</button></section>`;
  }

  function temporalCard() {
    const state = journeyTemporalState();
    if (state.phase === 'loading') return '';
    const confidence = state.confidenceLeg ? legConfidence(state.confidenceLeg) : null;
    const confidenceText = confidence ? confidence.label + ' · ' + confidence.source : '';
    const actionButton = state.isStale
      ? '<button class="route-primary journey-temporal-action" data-route-action="refresh-now">Recalculate from now</button>'
      : '<button class="route-primary journey-temporal-action" data-route-action="refresh-now" hidden>Recalculate from now</button>';
    return '<section id="journey-temporal-card" class="journey-temporal journey-temporal-' + state.phase + '" aria-live="polite">'
      + '<div class="journey-temporal-top"><div><div id="journey-temporal-label" class="route-card-label">' + escapeHtml(state.label) + '</div><strong id="journey-temporal-countdown">' + escapeHtml(temporalCountdownLabel(state)) + '</strong></div>'
      + (confidenceText ? '<span id="journey-temporal-confidence" class="journey-temporal-confidence">' + escapeHtml(confidenceText) + '</span>' : '<span id="journey-temporal-confidence" class="journey-temporal-confidence" hidden></span>')
      + '</div><h2 id="journey-temporal-action">' + escapeHtml(state.currentAction) + '</h2><p id="journey-temporal-detail">' + escapeHtml(state.detail) + '</p>'
      + '<div id="journey-temporal-next" class="journey-temporal-next"' + (state.nextAction ? '' : ' hidden') + '><span>Then</span><strong>' + escapeHtml(state.nextAction) + '</strong></div>'
      + actionButton + '</section>';
  }

  function modeStatusLabel(status) {
    return ({ live: 'live', partial: 'partly live', alert: 'alert', checking: 'checking', fallback: 'fallback', scheduled: 'scheduled' })[status] || '—';
  }

  function notificationSupportIssue() {
    if (window.isSecureContext === false) return 'Notifications require a secure HTTPS connection.';
    if (!('Notification' in window)) return 'This browser does not support web notifications.';
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'Push notifications are not available in this browser.';
    return '';
  }

  function notificationsCard() {
    const copy = notificationState === 'pending'
      ? 'The browser flow is ready, but server-side push delivery still needs to be connected.'
      : notificationState === 'denied'
        ? 'Notifications are blocked. Allow them in browser settings, then try again.'
        : notificationState === 'unsupported'
          ? notificationMessage
          : notificationState === 'error'
            ? notificationMessage
            : 'Get a push alert when LTA reports a disruption affecting this saved commute.';
    const buttonLabel = notificationState === 'loading' ? 'Checking…' : notificationState === 'pending' ? 'Check setup again' : notificationState === 'denied' ? 'Try again' : 'Enable disruption alerts';
    const tone = ['pending', 'denied', 'unsupported', 'error'].includes(notificationState) ? ` notification-${notificationState}` : '';
    return `<section class="notifications-card${tone}"><div class="route-card-label">Disruption alerts</div><h2>Know before you leave.</h2><p>${escapeHtml(copy)}</p>${notificationMessage && notificationState !== 'unsupported' && notificationState !== 'error' ? `<div class="notification-status" role="status">${escapeHtml(notificationMessage)}</div>` : ''}<button type="button" class="notification-button" data-route-action="notifications" ${notificationState === 'loading' ? 'disabled' : ''}>${buttonLabel}</button></section>`;
  }

  function decodePushKey(value) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const binary = window.atob(`${value.replace(/-/g, '+').replace(/_/g, '/')}${padding}`);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  async function enableNotifications() {
    const issue = notificationSupportIssue();
    if (issue) {
      notificationState = 'unsupported';
      notificationMessage = issue;
      render();
      return;
    }

    notificationState = 'loading';
    notificationMessage = 'Checking push setup…';
    render();
    try {
      const response = await fetch('/api/push-config');
      const data = await runtime.readJson(response, 'Push setup returned an invalid response.');
      if (!response.ok || !runtime.isPushConfigPayload(data)) {
        notificationState = 'pending';
        notificationMessage = 'Add the VAPID key and subscription store before asking for permission.';
        render();
        return;
      }

      const permission = window.Notification.permission === 'granted' ? 'granted' : await window.Notification.requestPermission();
      if (permission !== 'granted') {
        notificationState = 'denied';
        notificationMessage = 'Permission was not granted on this device.';
        render();
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodePushKey(data.publicKey) });
      localStorage.setItem('jalan-lite-push-subscription-v1', JSON.stringify(subscription.toJSON()));
      notificationState = 'pending';
      notificationMessage = 'Permission granted on this device. Server delivery still needs to be connected.';
      render();
    } catch (error) {
      notificationState = 'error';
      notificationMessage = error?.message || 'Could not prepare notifications on this device.';
      render();
    }
  }

  function dashboard() {
    const itinerary = routeState.data;
    const hasBus = itinerary?.legs.some((leg) => leg.mode === 'BUS');
    const hasMrt = itinerary?.legs.some((leg) => leg.mode === 'SUBWAY');
    const summary = itinerary ? liveTools.summary(itinerary) : { tone: 'neutral', label: 'Checking route', detail: '' };
    const busStatus = hasBus ? liveTools.modeStatus(itinerary, 'BUS') : null;
    const mrtStatus = hasMrt ? liveTools.modeStatus(itinerary, 'SUBWAY') : null;
    const sourceCopy = `${hasBus ? (busStatus === 'live' ? 'Bus legs use LTA real-time arrivals.' : 'Bus legs use LTA arrivals when available, with OneMap timings as fallback.') : ''}${hasMrt ? (mrtStatus === 'live' ? ' MRT legs use LTA GTFS-Realtime trip updates.' : ' MRT legs use OneMap schedule timings when live train data is unavailable.') : ''}${hasBus || hasMrt ? ' Live feeds refresh every 45 seconds while this screen is open.' : ' This route only needs OneMap route data.'}`;
    const sourceHeading = `Bus ${hasBus ? modeStatusLabel(busStatus) : '—'} · MRT ${hasMrt ? modeStatusLabel(mrtStatus) : '—'}`;
    const refreshDisabled = liveRefreshInFlight || liveRefreshStatus === 'loading' || !hasLiveTiming(itinerary);
    const refreshLabel = liveRefreshInFlight || liveRefreshStatus === 'loading' ? 'Updating…' : 'Refresh live data';
    return `<div class="route-panel">${brand()}<div class="route-header"><div><div class="route-kicker">Saved commute</div><h1>Your commute</h1></div><button class="route-link compact" data-route-action="edit">Edit</button></div>${journey()}${temporalCard()}${card()}<section class="timing-card"><div class="timing-heading"><div><div class="route-card-label">Timing confidence</div><h2>${sourceHeading}</h2></div><div class="timing-status"><span class="live-state live-state-${escapeHtml(summary.tone)}">${escapeHtml(summary.label)}</span><span id="live-freshness" class="live-freshness">${escapeHtml(liveFreshness())}</span></div></div><p>${escapeHtml(summary.detail)} ${escapeHtml(sourceCopy)}</p><div class="timing-controls"><span class="timing-control-note">${escapeHtml(liveFreshness())}</span><button type="button" class="timing-refresh" data-route-action="refresh-live" ${refreshDisabled ? 'disabled' : ''}>${refreshLabel}</button></div><button class="route-link demo-disruption-link" data-route-action="demo-disruption">Preview disruption flow</button></section>${notificationsCard()}<div class="route-actions"><button class="route-primary" data-route-action="refresh">Recalculate route</button><button class="route-link" data-route-action="bus">Open bus arrivals</button><button class="route-link" data-route-action="clear">Remove saved commute</button></div></div>`;
  }

  function demoTimeline(rerouted) {
    const legs = rerouted ? [
      { mode: 'WALK', title: 'Walk to Paya Lebar MRT', meta: '320 m · 4 min', times: '8:30 → 8:34' },
      { mode: 'SUBWAY', title: 'MRT · Circle Line', meta: 'Paya Lebar → Promenade · 5 stops', times: '8:36 → 8:51' },
      { mode: 'WALK', title: 'Walk to destination', meta: '650 m · 9 min', times: '8:51 → 9:00' },
    ] : [
      { mode: 'WALK', title: 'Walk to Paya Lebar MRT', meta: '320 m · 4 min', times: '8:30 → 8:34' },
      { mode: 'SUBWAY', title: 'MRT · East West Line', meta: 'Paya Lebar → City Hall · 6 stops', times: '8:37 → 8:55', affected: true },
      { mode: 'WALK', title: 'Walk to destination', meta: '600 m · 8 min', times: '8:55 → 9:03' },
    ];
    return `<div class="route-demo-timeline">${legs.map((leg, index) => `<div class="route-demo-leg${leg.affected ? ' affected' : ''}"><div class="timeline-rail"><span class="timeline-dot ${leg.mode.toLowerCase()}"></span></div><div class="timeline-body"><div class="timeline-head"><strong>${escapeHtml(leg.title)}</strong><span class="timeline-mode">${leg.mode === 'SUBWAY' ? 'MRT' : escapeHtml(leg.mode)}</span></div><div class="timeline-meta">${escapeHtml(leg.meta)}</div>${leg.affected ? '<div class="timeline-alert-label">Affected service</div>' : ''}<div class="timeline-foot"><span>${escapeHtml(leg.times)}</span>${leg.mode === 'SUBWAY' ? `<span class="route-demo-live">${leg.affected ? 'Alert' : 'Live alternative'}</span>` : ''}</div></div></div>${index === 0 ? '<div class="route-demo-transfer">Boarding point · Paya Lebar MRT</div>' : ''}`).join('')}</div>`;
  }

  function disruptionDemo() {
    const rerouted = disruptionDemoStep === 'rerouted';
    const fallback = disruptionDemoStep === 'fallback';
    const rerouting = disruptionDemoStep === 'rerouting';
    const duration = rerouted ? '30 min' : '33 min';
    const summary = rerouted ? 'Rerouted via Circle Line' : fallback ? 'Current route kept' : 'East West Line disruption';
    const alertClass = rerouted ? ' resolved' : '';
    const status = rerouting ? '<div class="route-demo-status" role="status">Checking OneMap alternatives…</div>' : fallback ? '<div class="route-inline-notice" role="status">No unaffected alternative was found. Your current route remains available.</div>' : rerouted ? '<div class="route-demo-success" role="status">Rerouted via Circle Line to avoid the affected service.</div>' : '';
    let actions = '';
    if (rerouting) actions = '<button class="route-primary" data-route-action="demo-reroute" disabled>Checking alternatives…</button>';
    else if (rerouted) actions = '<button class="route-primary" data-route-action="demo-reset">Replay alert</button><button class="route-link" data-route-action="demo-fallback">Preview no-safe-route fallback</button>';
    else if (fallback) actions = '<button class="route-primary" data-route-action="demo-reroute">Try reroute again</button><button class="route-link" data-route-action="demo-reset">Back to alert</button>';
    else actions = '<button class="route-primary" data-route-action="demo-reroute">Find a better route</button><button class="route-link" data-route-action="demo-fallback">Preview no-safe-route fallback</button>';
    return `<div class="route-demo"><div class="route-demo-inner">${brand()}<div class="route-demo-topbar"><button class="picker-back" data-route-action="demo-close">‹</button><div><div class="route-kicker">Interaction preview</div><div class="picker-title">Disruption flow</div></div></div><div class="route-demo-intro"><div class="route-kicker">Mock LTA incident</div><h1>${escapeHtml(summary)}</h1><p>See how Jalan warns the commuter, finds an alternative, and handles a route with no safe replacement.</p></div><section class="route-demo-alert${alertClass}"><div class="route-demo-alert-top"><span class="route-disruption-label"><span class="live-dot"></span>LTA service alert</span><span class="route-demo-preview-tag">PREVIEW</span></div><h2>East West Line disruption</h2><p>Trains are delayed between Paya Lebar and City Hall.</p></section>${status}<section class="route-demo-card"><div class="route-demo-summary"><div><span class="route-card-label">Journey</span><strong>${duration}</strong></div><span>${rerouted ? '0 transfers' : '1 transfer'}</span></div><div class="route-demo-route-label">${escapeHtml(rerouted ? 'Replacement route' : 'Original route')}</div>${demoTimeline(rerouted)}</section><div class="route-demo-actions">${actions}</div><p class="route-demo-footnote">Mock UI only — no live route or LTA data was changed.</p></div></div>`;
  }

  function hasLiveTiming(itinerary) {
    return Boolean(itinerary?.legs?.some((leg) => leg.mode === 'SUBWAY' || (leg.mode === 'BUS' && /^\d{5}$/.test(leg.stopCode) && leg.routeName)));
  }

  function liveHasError(itinerary) {
    return Boolean(itinerary?.legs?.some((leg) => (leg.mode === 'BUS' && leg.liveStatus === 'error') || (leg.mode === 'SUBWAY' && leg.trainStatus === 'error')));
  }

  function snapshotLiveState(itinerary) {
    if (!itinerary) return null;
    return {
      itinerary,
      liveAlerts: itinerary.liveAlerts,
      trainFeedUpdatedAt: itinerary.trainFeedUpdatedAt,
      legs: itinerary.legs.map((leg) => ({
        leg,
        live: leg.live,
        liveUpdatedAt: leg.liveUpdatedAt,
        liveStatus: leg.liveStatus,
        trainStatus: leg.trainStatus,
        trainRealtime: leg.trainRealtime,
      })),
    };
  }

  function restoreLiveState(snapshot) {
    if (!snapshot) return;
    snapshot.legs.forEach((entry) => {
      entry.leg.live = entry.live;
      entry.leg.liveUpdatedAt = entry.liveUpdatedAt;
      entry.leg.liveStatus = entry.liveStatus;
      entry.leg.trainStatus = entry.trainStatus;
      entry.leg.trainRealtime = entry.trainRealtime;
    });
    snapshot.itinerary.liveAlerts = snapshot.liveAlerts;
    snapshot.itinerary.trainFeedUpdatedAt = snapshot.trainFeedUpdatedAt;
  }

  function liveFreshness() {
    if (liveRefreshStatus === 'loading') return 'Updating…';
    if (liveRefreshStatus === 'degraded' && !liveUpdatedAt) return 'LTA unavailable';
    if (!liveUpdatedAt) return 'Not checked';
    const age = Math.max(0, Math.floor((Date.now() - liveUpdatedAt) / 1000));
    const ageLabel = age < 60 ? 'just now' : `${Math.floor(age / 60)} min ago`;
    return liveRefreshStatus === 'degraded' ? `Stale · ${ageLabel}` : `Checked ${ageLabel}`;
  }

  function updateLiveFreshnessDom() {
    const node = document.getElementById('live-freshness');
    if (node) node.textContent = liveFreshness();
    const note = document.querySelector('.timing-control-note');
    if (note) note.textContent = liveFreshness();
    const button = document.querySelector('[data-route-action="refresh-live"]');
    if (button) {
      button.disabled = liveRefreshInFlight || liveRefreshStatus === 'loading';
      button.textContent = liveRefreshInFlight || liveRefreshStatus === 'loading' ? 'Updating…' : 'Refresh live data';
    }
  }

  function canRefreshLive() {
    return Boolean(saved && routeState.status === 'ready' && routeState.data && hasLiveTiming(routeState.data) && !pickerField && !viewing && !disruptionDemoOpen && !document.hidden && !shell.hidden);
  }

  function stopLiveRefresh() {
    if (liveRefreshTimer) window.clearTimeout(liveRefreshTimer);
    liveRefreshTimer = null;
  }

  function cancelAsyncWork() {
    stopLiveRefresh();
    routeRequests.abort();
    liveRequests.abort();
    liveRefreshInFlight = false;
    stopTemporalClock();
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
    if (!canRefreshLive() || liveRefreshInFlight || liveRequests.hasActive()) {
      syncLiveRefresh();
      return;
    }
    const itinerary = routeState.data;
    const request = liveRequests.start();
    liveRefreshInFlight = true;
    liveRefreshStatus = 'loading';
    updateLiveFreshnessDom();
    try {
      await Promise.all([liveBus(itinerary, request.controller.signal), liveTrain(itinerary, request.controller.signal)]);
      if (liveRequests.isCurrent(request) && routeState.data === itinerary) {
        const degraded = liveHasError(itinerary);
        if (!degraded && hasLiveTiming(itinerary)) liveUpdatedAt = Date.now();
        liveRefreshStatus = degraded ? 'degraded' : (hasLiveTiming(itinerary) ? 'ready' : 'idle');
        updateLiveFreshnessDom();
        if (canRefreshLive()) render();
      }
    } catch (error) {
      if (error?.name !== 'AbortError' && liveRequests.isCurrent(request) && routeState.data === itinerary) {
        liveRefreshStatus = 'degraded';
        updateLiveFreshnessDom();
      }
    } finally {
      if (liveRequests.isCurrent(request)) {
        liveRequests.finish(request);
        liveRefreshInFlight = false;
        syncLiveRefresh();
      }
    }
  }

  function viewer() {
    const itinerary = routeState.data;
    const currentRoute = itinerary?.service === 'now' || itinerary?.service === 'next';
    const modeLabel = currentRoute ? (itinerary.service === 'next' ? 'Next departure' : 'Leave now') : (saved?.timeMode === 'arrive' ? 'Arrive by' : 'Leave at');
    const modeTime = currentRoute ? timeAt(itinerary.startTime) : timeLabel(saved.departureTime);
    return '<div class="route-viewer"><div class="picker-topbar"><button class="picker-back" aria-label="Back" data-route-action="close-viewer">‹</button><div><div class="route-kicker">' + escapeHtml(modeLabel) + ' ' + escapeHtml(modeTime) + '</div><div class="picker-title">' + escapeHtml(saved.origin) + ' → ' + escapeHtml(saved.destination) + '</div></div></div><div class="route-viewer-map-wrap"><div id="route-viewer-map" class="route-viewer-map"></div><div id="viewer-fallback" class="map-fallback" hidden><strong>Map unavailable</strong><span>The step-by-step route is still shown below.</span></div></div><div class="route-viewer-sheet"><div class="route-viewer-summary"><div><span class="route-card-label">Journey</span><strong>' + (itinerary ? durationLabel(itinerary.duration) : '—') + '</strong></div><span>' + (itinerary ? itinerary.transfers : 0) + ' transfer' + (itinerary?.transfers === 1 ? '' : 's') + '</span></div>' + (itinerary ? timeline(itinerary) : '') + '</div></div>';
  }

  function destroyMap() {
    mapGeneration += 1;
    if (map) {
      try { map.remove(); } catch {}
    }
    map = null;
  }

  function stopTemporalClock() {
    if (temporalTimer) window.clearInterval(temporalTimer);
    temporalTimer = null;
  }

  function updateTemporalDom() {
    if (document.hidden || focusMode || viewing || pickerField || disruptionDemoOpen) return;
    const card = document.getElementById('journey-temporal-card');
    if (!card) return;
    const state = journeyTemporalState();
    const confidence = state.confidenceLeg ? legConfidence(state.confidenceLeg) : null;
    const label = document.getElementById('journey-temporal-label');
    const countdown = document.getElementById('journey-temporal-countdown');
    const action = document.getElementById('journey-temporal-action');
    const detail = document.getElementById('journey-temporal-detail');
    const next = document.getElementById('journey-temporal-next');
    const confidenceNode = document.getElementById('journey-temporal-confidence');
    const refresh = card.querySelector('[data-route-action="refresh-now"]');
    card.className = 'journey-temporal journey-temporal-' + state.phase;
    if (label) label.textContent = state.label;
    if (countdown) countdown.textContent = temporalCountdownLabel(state);
    if (action) action.textContent = state.currentAction;
    if (detail) detail.textContent = state.detail;
    if (next) {
      next.hidden = !state.nextAction;
      next.querySelector('strong').textContent = state.nextAction;
    }
    if (confidenceNode) {
      confidenceNode.hidden = !confidence;
      confidenceNode.textContent = confidence ? confidence.label + ' · ' + confidence.source : '';
    }
    if (refresh) {
      refresh.hidden = !state.isStale;
      refresh.disabled = routeState.status === 'rerouting';
      refresh.textContent = routeState.status === 'rerouting' ? 'Updating route…' : 'Recalculate from now';
    }
  }

  function syncTemporalClock() {
    stopTemporalClock();
    if (document.hidden || focusMode || viewing || pickerField || disruptionDemoOpen || !saved || !routeState.data || routeState.status === 'loading') return;
    temporalTimer = window.setInterval(updateTemporalDom, 30000);
  }

  function render() {
    destroyMap();
    shell.hidden = false;
    shell.innerHTML = pickerField ? picker() : (disruptionDemoOpen ? disruptionDemo() : (focusMode ? focusView() : (viewing ? viewer() : (saved ? dashboard() : setup()))));
    bind();
    if (pickerField) requestAnimationFrame(renderPickerMap);
    if (viewing) requestAnimationFrame(renderViewerMap);
    if (saved && !pickerField && !viewing && saved.originPoint && saved.destinationPoint && routeState.status === 'idle') routeData();
    syncLiveRefresh();
    syncTemporalClock();
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

  async function reverseLabel(generation = mapGeneration) {
    if (generation !== mapGeneration || !pickerField) return;
    try {
      const response = await fetch(`/api/location?lat=${mapPosition.center.lat}&lng=${mapPosition.center.lng}`);
      const data = await runtime.readJson(response, 'Location lookup unavailable.');
      if (generation !== mapGeneration || !pickerField) return;
      mapPosition.label = response.ok && data.label ? data.label : 'Pinned location';
    } catch { if (generation === mapGeneration && pickerField) mapPosition.label = 'Pinned location'; }
    if (generation !== mapGeneration || !pickerField) return;
    updatePickerDom();
  }

  async function mapToken() {
    const response = await fetch('/api/map-config');
    const data = await runtime.readJson(response, 'Map service returned an invalid response.');
    if (!response.ok || typeof data.token !== 'string' || !data.token.startsWith('pk.')) throw new Error(data.error || 'Map unavailable');
    return data.token;
  }

  async function renderPickerMap() {
    const generation = mapGeneration;
    const container = document.getElementById('route-map');
    const fallback = document.getElementById('map-fallback');
    if (!container || !pickerField) return;
    if (!window.mapboxgl) { fallback.hidden = false; return; }
    try {
      mapboxgl.accessToken = await mapToken();
      if (generation !== mapGeneration || !pickerField || !document.getElementById('route-map')) return;
      const nextMap = new mapboxgl.Map({ container, style: 'mapbox://styles/mapbox/streets-v12', center: [mapPosition.center.lng, mapPosition.center.lat], zoom: mapPosition.zoom, minZoom: 10.5, maxZoom: 18.5, maxBounds: [[103.55, 1.15], [104.1, 1.49]], dragRotate: false, touchPitch: false });
      if (generation !== mapGeneration || !pickerField) { nextMap.remove(); return; }
      map = nextMap;
      nextMap.touchZoomRotate.disableRotation();
      nextMap.on('load', () => { if (generation === mapGeneration && pickerField && map === nextMap) reverseLabel(generation); });
      nextMap.on('move', () => { if (generation !== mapGeneration || map !== nextMap) return; const center = nextMap.getCenter(); mapPosition.center = { lat: center.lat, lng: center.lng }; mapPosition.zoom = nextMap.getZoom(); mapPosition.label = 'Pinned location'; updatePickerDom(); });
      nextMap.on('moveend', () => { if (generation === mapGeneration && pickerField && map === nextMap) reverseLabel(generation); });
      nextMap.on('error', () => { if (generation === mapGeneration && fallback) fallback.hidden = false; });
    } catch { if (generation === mapGeneration && fallback) fallback.hidden = false; }
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
    const generation = mapGeneration;
    const container = document.getElementById('route-viewer-map');
    const fallback = document.getElementById('viewer-fallback');
    const itinerary = routeState.data;
    if (!container || !itinerary) return;
    if (!window.mapboxgl) { fallback.hidden = false; return; }
    try {
      mapboxgl.accessToken = await mapToken();
      if (generation !== mapGeneration || !viewing || !document.getElementById('route-viewer-map')) return;
      const features = itinerary.legs.map((leg, index) => { const coordinates = leg.geometry ? decodePolyline(leg.geometry) : []; return coordinates.length > 1 ? { type: 'Feature', properties: { mode: leg.mode, index }, geometry: { type: 'LineString', coordinates } } : null; }).filter(Boolean);
      const selectedLeg = Number.isInteger(selectedLegIndex) ? itinerary.legs[selectedLegIndex] : null;
      const selectedFeature = features.find((feature) => feature.properties.index === selectedLegIndex);
      const nextMap = new mapboxgl.Map({ container, style: 'mapbox://styles/mapbox/streets-v12', center: [saved.originPoint.lng, saved.originPoint.lat], zoom: 12.5, dragRotate: false, touchPitch: false });
      if (generation !== mapGeneration || !viewing) { nextMap.remove(); return; }
      map = nextMap;
      nextMap.touchZoomRotate.disableRotation();
      nextMap.on('load', () => {
        if (generation !== mapGeneration || !viewing || map !== nextMap) return;
        if (features.length) {
          nextMap.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features } });
          const opacity = selectedLeg ? 0.22 : 0.88;
          nextMap.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'WALK'], paint: { 'line-color': '#777', 'line-width': 4, 'line-opacity': opacity, 'line-dasharray': [1, 1.5] } });
          nextMap.addLayer({ id: 'route-bus', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'BUS'], paint: { 'line-color': '#1f7a4d', 'line-width': 6, 'line-opacity': opacity } });
          nextMap.addLayer({ id: 'route-mrt', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'SUBWAY'], paint: { 'line-color': '#222', 'line-width': 7, 'line-opacity': opacity } });
          if (selectedLeg) nextMap.addLayer({ id: 'route-selected', type: 'line', source: 'route', filter: ['==', ['get', 'index'], selectedLegIndex], paint: { 'line-color': '#D42E12', 'line-width': 9, 'line-opacity': 1 } });
          const bounds = new mapboxgl.LngLatBounds();
          const focusFeatures = selectedFeature ? [selectedFeature] : features;
          focusFeatures.forEach((feature) => feature.geometry.coordinates.forEach((coordinate) => bounds.extend(coordinate)));
          if (selectedLeg?.fromPoint) bounds.extend([selectedLeg.fromPoint.lng, selectedLeg.fromPoint.lat]);
          if (selectedLeg?.toPoint) bounds.extend([selectedLeg.toPoint.lng, selectedLeg.toPoint.lat]);
          if (!bounds.isEmpty()) nextMap.fitBounds(bounds, { padding: 48, duration: 0 });
        } else if (selectedLeg?.fromPoint || selectedLeg?.toPoint) {
          const bounds = new mapboxgl.LngLatBounds();
          if (selectedLeg.fromPoint) bounds.extend([selectedLeg.fromPoint.lng, selectedLeg.fromPoint.lat]);
          if (selectedLeg.toPoint) bounds.extend([selectedLeg.toPoint.lng, selectedLeg.toPoint.lat]);
          if (!bounds.isEmpty()) nextMap.fitBounds(bounds, { padding: 72, duration: 0 });
        }
        new mapboxgl.Marker({ color: '#16181A' }).setLngLat([saved.originPoint.lng, saved.originPoint.lat]).addTo(nextMap);
        new mapboxgl.Marker({ color: '#D42E12' }).setLngLat([saved.destinationPoint.lng, saved.destinationPoint.lat]).addTo(nextMap);
        if (selectedLeg) {
          const from = selectedLeg.fromPoint || (selectedFeature?.geometry.coordinates[0] ? { lng: selectedFeature.geometry.coordinates[0][0], lat: selectedFeature.geometry.coordinates[0][1] } : null);
          const lastCoordinate = selectedFeature?.geometry.coordinates[selectedFeature.geometry.coordinates.length - 1];
          const to = selectedLeg.toPoint || (lastCoordinate ? { lng: lastCoordinate[0], lat: lastCoordinate[1] } : null);
          if (from) new mapboxgl.Marker({ color: '#005EC4' }).setLngLat([from.lng, from.lat]).addTo(nextMap);
          if (to) new mapboxgl.Marker({ color: '#D42E12' }).setLngLat([to.lng, to.lat]).addTo(nextMap);
        }
      });
      nextMap.on('error', () => { if (generation === mapGeneration && fallback) fallback.hidden = false; });
    } catch { if (generation === mapGeneration && fallback) fallback.hidden = false; }
  }

  async function manualLocation() {
    const input = document.getElementById('picker-manual-input');
    const value = input?.value.trim();
    if (!value) return;
    try {
      const response = await fetch(`/api/location?q=${encodeURIComponent(value)}`);
      const data = await runtime.readJson(response, 'Location lookup unavailable.');
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
    const code = stopCode(from);
    return { index, mode, routeName, lineName, label: mode === 'WALK' ? `Walk ${distanceLabel(leg.distance)}` : `${mode === 'SUBWAY' ? 'MRT' : mode}${routeName ? ` ${routeName}` : ''}`, detail: [placeName(from), placeName(to)].filter(Boolean).join(' → '), fromName: placeName(from), toName: placeName(to), fromId: placeId(from), toId: placeId(to), fromPoint: placePoint(from), toPoint: placePoint(to), stopCode: code, departureTime: toTimestamp(leg.startTime || leg.departureTime || from.departure || from.departureTime), arrivalTime: toTimestamp(leg.endTime || leg.arrivalTime || to.arrival || to.arrivalTime), duration: Number(leg.duration) || 0, distance: Number(leg.distance) || 0, stopCount: mode === 'WALK' ? null : stopCount(leg), liveStatus: mode === 'BUS' ? (/^\d{5}$/.test(code) && Boolean(routeName) ? 'loading' : 'unavailable') : null, trainStatus: mode === 'SUBWAY' ? 'loading' : null, liveUpdatedAt: '', geometry: String(leg.legGeometry?.points || leg.geometry || '') };
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

  async function liveBus(itinerary, signal) {
    const busLegs = itinerary.legs.filter((leg) => leg.mode === 'BUS');
    busLegs.forEach((leg) => { leg.live = null; leg.liveUpdatedAt = ''; leg.liveStatus = /^\d{5}$/.test(leg.stopCode) && leg.routeName ? 'loading' : 'unavailable'; });
    await Promise.all(busLegs.filter((leg) => /^\d{5}$/.test(leg.stopCode) && leg.routeName).map(async (leg) => {
      try {
        const response = await fetch(`/api/bus-arrivals?stopCode=${leg.stopCode}&services=${encodeURIComponent(leg.routeName)}`, { signal });
        const data = await runtime.readJson(response, 'LTA bus feed returned an invalid response.');
        if (signal?.aborted) return;
        if (response.ok && runtime.isBusArrivalsPayload(data)) { leg.live = data.services?.[0] || null; leg.liveUpdatedAt = data.updatedAt || ''; leg.liveStatus = 'ready'; } else { leg.liveStatus = 'error'; leg.liveUpdatedAt = ''; }
      } catch (error) { if (error?.name !== 'AbortError' && !signal?.aborted) { leg.liveStatus = 'error'; leg.liveUpdatedAt = ''; } }
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
    return disruptionTools.alertMatchesLeg(leg, alert);
  }

  function relevantTrainAlerts(itinerary, payload) {
    return disruptionTools.relevantAlerts(itinerary, payload);
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

  async function liveTrain(itinerary, signal) {
    const legs = itinerary.legs.filter((leg) => leg.mode === 'SUBWAY');
    if (!legs.length) return;
    legs.forEach((leg) => { leg.trainStatus = 'loading'; leg.trainRealtime = null; leg.liveUpdatedAt = ''; });
    const routes = [...new Set(legs.flatMap((leg) => [leg.routeName, leg.lineName]).filter(Boolean))];
    const stops = [...new Set(legs.flatMap((leg) => [leg.fromId, leg.toId]).filter(Boolean))];
    try {
      const query = new URLSearchParams();
      if (routes.length) query.set('routes', routes.join(','));
      if (stops.length) query.set('stops', stops.join(','));
      const response = await fetch(`/api/train-realtime?${query}`, { signal });
      const payload = await runtime.readJson(response, 'LTA train feed returned an invalid response.');
      if (!response.ok) throw new Error(payload.error || 'LTA train feed unavailable.');
      if (signal?.aborted) return;
      if (!runtime.isTrainRealtimePayload(payload)) throw new Error('LTA train feed returned an invalid response.');
      itinerary.liveAlerts = relevantTrainAlerts(itinerary, payload);
      itinerary.trainFeedUpdatedAt = payload.updatedAt || '';
      legs.forEach((leg) => {
        leg.trainRealtime = trainMatch(leg, payload);
        leg.liveUpdatedAt = itinerary.trainFeedUpdatedAt;
        leg.trainStatus = 'ready';
      });
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) return;
      legs.forEach((leg) => { leg.trainStatus = 'error'; leg.liveUpdatedAt = ''; });
    }
  }

  async function selectAlternative(key) {
    const current = routeState.data;
    const choice = alternativeOptions(current).find((option) => option.key === key);
    if (!choice || itinerarySignature(choice.itinerary) === itinerarySignature(current)) return;
    const request = liveRequests.start();
    selectedLegIndex = null;
    liveUpdatedAt = 0;
    liveRefreshInFlight = true;
    liveRefreshStatus = 'loading';
    const selected = { ...choice.itinerary, alternatives: current.alternatives, choiceLabel: choice.label };
    routeState = { status: 'ready', data: selected, error: '' };
    render();
    try {
      await Promise.all([liveBus(selected, request.controller.signal), liveTrain(selected, request.controller.signal)]);
      if (liveRequests.isCurrent(request) && routeState.data === selected) { const degraded = liveHasError(selected); if (!degraded && hasLiveTiming(selected)) liveUpdatedAt = Date.now(); liveRefreshStatus = degraded ? 'degraded' : (hasLiveTiming(selected) ? 'ready' : 'idle'); render(); }
    } finally {
      if (liveRequests.isCurrent(request)) { liveRequests.finish(request); liveRefreshInFlight = false; syncLiveRefresh(); }
    }
  }

  async function routeData({ preserveCurrent = false, fromNow = false } = {}) {
    if (preserveCurrent && routeState.status === 'rerouting') return;
    const previous = (preserveCurrent || fromNow) ? routeState.data : null;
    const previousLiveState = snapshotLiveState(previous);
    const request = routeRequests.start();
    liveRequests.abort();
    liveRefreshInFlight = false;
    const previousUpdatedAt = liveUpdatedAt;
    const previousRefreshStatus = liveRefreshStatus;
    selectedLegIndex = null;
    liveUpdatedAt = 0;
    liveRefreshStatus = 'loading';
    routeState = { status: previous ? 'rerouting' : 'loading', data: previous || null, error: '', notice: '' }; render();
    const savedRoute = saved;
    const start = `${savedRoute.originPoint.lat},${savedRoute.originPoint.lng}`; const end = `${savedRoute.destinationPoint.lat},${savedRoute.destinationPoint.lng}`; const time = fromNow ? '' : (savedRoute.departureTime ? `&time=${encodeURIComponent(savedRoute.departureTime)}` : ''); const timeMode = `&timeMode=${encodeURIComponent(fromNow ? 'depart' : (savedRoute.timeMode === 'arrive' ? 'arrive' : 'depart'))}`;
    let liveRequest = null;
    try {
      const response = await fetch(`/api/route?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${time}${timeMode}`, { signal: request.controller.signal });
      const data = await runtime.readJson(response, 'Routing unavailable.');
      if (!routeRequests.isCurrent(request)) return;
      if (!response.ok) throw new Error(data.error || 'Routing unavailable.');
      if (!runtime.isRoutePayload(data)) throw new Error('Routing returned an invalid itinerary.');
      const routed = normalizeRoute(data);
      if (!routed) throw new Error('No public-transport itinerary.');
      let itinerary = routed;
      let notice = fromNow ? 'Route updated from the current time.' : '';
      if (preserveCurrent && previous) {
        const candidate = disruptionTools.bestUnblocked(routed, previous.liveAlerts || []);
        if (!candidate) {
          restoreLiveState(previousLiveState);
          liveUpdatedAt = previousUpdatedAt;
          liveRefreshStatus = previousRefreshStatus;
          routeState = { status: 'ready', data: previous, error: '', notice: 'No unaffected alternative was returned. Your current route is still shown.' };
          render();
          return;
        }
        itinerary = { ...candidate, alternatives: routed.alternatives, choiceLabel: 'Rerouted' };
        notice = `Rerouted via ${disruptionTools.serviceLabel(itinerary)} to avoid the affected service.`;
      }
      routeState = { status: 'ready', data: itinerary, error: '', notice };
      liveRequest = liveRequests.start();
      liveRefreshInFlight = true;
      render();
      await Promise.all([liveBus(itinerary, liveRequest.controller.signal), liveTrain(itinerary, liveRequest.controller.signal)]);
      if (routeRequests.isCurrent(request) && liveRequests.isCurrent(liveRequest) && routeState.data === itinerary) {
        const degraded = liveHasError(itinerary);
        if (!degraded && hasLiveTiming(itinerary)) liveUpdatedAt = Date.now();
        liveRefreshStatus = degraded ? 'degraded' : (hasLiveTiming(itinerary) ? 'ready' : 'idle');
        render();
      }
    } catch (error) {
      if (error?.name === 'AbortError' || !routeRequests.isCurrent(request)) return;
      if (previous) {
        restoreLiveState(previousLiveState);
        liveUpdatedAt = previousUpdatedAt;
        liveRefreshStatus = previousRefreshStatus;
        routeState = { status: 'ready', data: previous, error: '', notice: fromNow ? `Could not recalculate from the current time: ${error.message || 'routing is unavailable.'} Your current route is still shown.` : `Could not recalculate around the disruption: ${error.message || 'routing is unavailable.'} Your current route is still shown.` };
      } else {
        routeState = { status: 'error', data: null, error: error.message || 'Routing unavailable.' };
      }
      render();
    } finally {
      if (liveRequest && liveRequests.isCurrent(liveRequest)) {
        liveRequests.finish(liveRequest);
        liveRefreshInFlight = false;
        syncLiveRefresh();
      }
      routeRequests.finish(request);
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
        if (action === 'demo-disruption') { stopLiveRefresh(); disruptionDemoOpen = true; disruptionDemoStep = 'alert'; render(); }
        else if (action === 'demo-close') { if (disruptionDemoTimer) window.clearTimeout(disruptionDemoTimer); disruptionDemoTimer = null; disruptionDemoOpen = false; disruptionDemoStep = 'alert'; render(); refreshLiveTimings(); }
        else if (action === 'demo-reroute') { if (disruptionDemoStep === 'rerouting') return; disruptionDemoStep = 'rerouting'; render(); disruptionDemoTimer = window.setTimeout(() => { disruptionDemoTimer = null; if (disruptionDemoOpen) { disruptionDemoStep = 'rerouted'; render(); } }, 700); }
        else if (action === 'demo-reset') { if (disruptionDemoTimer) window.clearTimeout(disruptionDemoTimer); disruptionDemoTimer = null; disruptionDemoStep = 'alert'; render(); }
        else if (action === 'demo-fallback') { if (disruptionDemoTimer) window.clearTimeout(disruptionDemoTimer); disruptionDemoTimer = null; disruptionDemoStep = 'fallback'; render(); }
        else if (action === 'bus') { cancelAsyncWork(); destroyMap(); shell.hidden = true; launcher.hidden = false; }
        else if (action === 'edit') { cancelAsyncWork(); draftState = draft(saved); saved = null; routeState = { status: 'idle', data: null, error: '' }; render(); }
        else if (action === 'save') { if (draftState.origin && draftState.destination) { save({ id: 'route-1', ...draftState, updatedAt: new Date().toISOString() }); routeState = { status: 'idle', data: null, error: '' }; render(); } }
        else if (action === 'clear') { cancelAsyncWork(); localStorage.removeItem(STORAGE_KEY); saved = null; draftState = draft(); routeState = { status: 'idle', data: null, error: '' }; liveUpdatedAt = 0; liveRefreshStatus = 'idle'; render(); }
        else if (action === 'cancel') closePicker();
        else if (action === 'confirm') { draftState[pickerField] = mapPosition.label === 'Singapore' ? 'Pinned location' : mapPosition.label; draftState[`${pickerField}Point`] = { ...mapPosition.center }; closePicker(); }
        else if (action === 'manual') manualLocation();
        else if (action === 'locate') locate();
        else if (action === 'refresh-now') routeData({ fromNow: true });
        else if (action === 'refresh') { routeState = { status: 'idle', data: null, error: '' }; render(); }
        else if (action === 'refresh-live') refreshLiveTimings();
        else if (action === 'focus') enterFocusMode();
        else if (action === 'exit-focus') exitFocusMode();
        else if (action === 'notifications') enableNotifications();
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
      stopTemporalClock();
      releaseFocusWakeLock();
      return;
    }
    if (focusMode) requestFocusWakeLock();
    refreshLiveTimings();
    syncLiveRefresh();
    syncTemporalClock();
  });

  launcher.onclick = () => { shell.hidden = false; launcher.hidden = true; render(); };
  document.body.append(shell, launcher);
  render();
})();
