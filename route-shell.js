(() => {
  const STORAGE_KEY = 'jalan-lite-routes-v1';
  const routineStorage = window.JalanRoutines;
  const DEFAULT_CENTER = { lat: 1.3521, lng: 103.8198 };
  const LIVE_REFRESH_INTERVAL = 45000;
  const PLANNING_WINDOW_MS = 90 * 60 * 1000;
  const shell = document.createElement('section');
  const launcher = document.createElement('button');
  const disruptionTools = window.JalanDisruptions;
  const liveTools = window.JalanLiveStatus;
  const runtime = window.JalanRuntime;
  const routeRequests = runtime.createRequestCoordinator();
  const liveRequests = runtime.createRequestCoordinator();

  const scheduleTools = window.JalanSchedule;
  const journeyTools = window.JalanJourney;
  const singaporeDate = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const singaporeTime = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16);
  let completedOccurrences = [];
  try { completedOccurrences = JSON.parse(sessionStorage.getItem('jalan-lite-completed-occurrences') || '[]'); if (!Array.isArray(completedOccurrences)) completedOccurrences = []; } catch {}
  let activeSession = journeyTools?.load() || null;
  let saved = activeSession?.plan || load();
  let draftState = draft(saved);
  let pickerField = null;
  let mapPosition = { center: { ...DEFAULT_CENTER }, zoom: 14, label: 'Singapore' };
  let routeState = activeSession?.itinerary ? {status:'ready',data:activeSession.itinerary,error:''} : { status: 'idle', data: null, error: '' };
  let map = null;
  let mapSelectionMarkers = [];
  let mapGeneration = 0;
  let viewing = false;
  let selectedLegIndex = null;
  let expandedLiveLegIndex = null;
  let routeMapLocation = null;
  let routeLocationInFlight = false;
  let liveRefreshTimer = null;
  let liveRefreshInFlight = false;
  let liveUpdatedAt = 0;
  let liveRefreshStatus = 'idle';
  let disruptionDemoOpen = new URLSearchParams(location.search).get('demo') === 'disruption';
  let disruptionDemoStep = 'alert';
  let disruptionDemoTimer = null;
  let focusMode = false;
  let focusClockTimer = null;
  let focusWakeLock = null;
  let temporalTimer = null;
  let dashboardPane = 'now';
  let dashboardScrollUnlockTimer = null;
  let dashboardScrollAnimationFrame = null;
  let dismissedNotice = '';
  let routinesOpen = false;
  let saveFormOpen = false;
  let recoveryOpen = false;
  let recoveryOrigin = null;
  let formError = '';
  const storageHealth = routineStorage.load();
  if (storageHealth.ok === false) formError = 'Saved data could not be migrated or read safely. Existing records are retained; changes may not persist on this browser.';
  let searchGeneration = 0;
  let searchResults = [];
  let searchMessage = '';
  let searchQuery = '';
  let savedCategory = 'route';


  shell.className = 'route-shell';
  launcher.className = 'route-launcher';
  launcher.type = 'button';
  launcher.textContent = 'Saved';
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

  function newRouteId() {
    return 'route-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function draft(value) {
    return {
      id: value?.id || null,
      name: value?.name || '',
      homeWorkLabel: ['home', 'work'].includes(value?.homeWorkLabel) ? value.homeWorkLabel : null,
      notifications: {
        disruptionAlerts: Boolean(value?.notifications?.disruptionAlerts),
        routeAlerts: Boolean(value?.notifications?.routeAlerts),
      },
      origin: value?.origin || '',
      destination: value?.destination || '',
      originPoint: value?.originPoint || null,
      destinationPoint: value?.destinationPoint || null,
      departureTime: value?.departureTime || singaporeTime(),
      date: value?.date || singaporeDate(),
      days: value && 'days' in value ? value.days : [1,2,3,4,5],
      exceptions: value?.exceptions || {},
      usualRouteSignature: value?.usualRouteSignature || '',
      linkedRoutineId: value?.linkedRoutineId || null,
      timeMode: value?.timeMode || 'now',
    };
  }

  function legacyLoad() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return value && typeof value.origin === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  function routeRoutineId(value) {
    return value?.id ? 'route:' + value.id : '';
  }

  function syncLegacyRoute(routines) {
    const routine = routines.find(value => value.type === 'route');
    return routine ? routineStorage.routeFromRoutine(routine) : null;
  }

  function occurrenceFor(routine) {
    const candidate = window.JalanSchedule?.nextOccurrence(routine);
    return candidate && completedOccurrences.includes(candidate.routineId + ':' + candidate.date) ? window.JalanSchedule.nextOccurrence(routine, Date.now(), {includeOverdue:false}) : candidate;
  }

  function load() {
    if (!routineStorage) return legacyLoad();
    const loaded = routineStorage.load();
    const occurrences = loaded.routines.filter(value => value.type === 'route').map(occurrenceFor).filter(Boolean);
    const occurrence = occurrences.sort((a,b) => (a.overdue ? 0 : 1)-(b.overdue ? 0 : 1) || a.timestamp-b.timestamp)[0];
    const routine = occurrence ? loaded.routines.find(value => value.id === occurrence.routineId) : loaded.routines.find(value => value.type === 'route');
    return routine ? { ...routineStorage.routeFromRoutine(routine), ...(occurrence ? { date: occurrence.date, departureTime: occurrence.time, timeMode: occurrence.timeMode, overdue: occurrence.overdue } : {}) } : null;
  }

  function save(value) {
    const loaded = routineStorage.load();
    const record = routineStorage.routineFromRoute(value);
    const result = routineStorage.save([record, ...loaded.routines.filter(r => r.id !== record.id)]);
    if (!result.ok) { formError = 'Could not save on this browser. Your draft is still here. Please retry.'; return false; }
    const preview = saved;
    saved = { ...value, persisted: true, ...(preview ? {date:preview.date,departureTime:preview.departureTime,timeMode:preview.timeMode,origin:preview.origin,originPoint:preview.originPoint,destination:preview.destination,destinationPoint:preview.destinationPoint} : {}) };
    if (activeSession) { activeSession = {...activeSession,plan:saved}; journeyTools.save(activeSession); }
    draftState = draft(saved);
    formError = '';
    return true;
  }

  function clearSavedRoute() {
    if (!routineStorage) return;
    const loaded = routineStorage.load();
    const activeId = routeRoutineId(saved);
    const next = activeId
      ? loaded.routines.filter((routine) => routine.id !== activeId)
      : loaded.routines.filter((routine) => routine.type !== 'route');
    if (!routineStorage.save(next).ok) { formError = 'Could not remove this journey. Please retry.'; return saved; }
    return syncLegacyRoute(next);
  }

  function brand() {
    return '<div class="route-brand"><svg class="dailyloop-mark" aria-hidden="true" viewBox="0 0 32 32" fill="none"><path d="M16 3.5a12.5 12.5 0 0 0 0 25" stroke="var(--leaf-green,#4A8D53)" stroke-width="3" stroke-linecap="round"/><path d="M16 28.5a12.5 12.5 0 0 0 0-25" stroke="var(--sky-blue,#5992C4)" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="3.5" r="1.75" fill="var(--mandarin,#E69641)"/></svg><div class="route-wordmark">DailyLoop</div><div class="route-country">SG</div></div>';
  }

  function network() {
    return '<div class="sg-network"><span class="sg-line ns">NS</span><span class="sg-line ew">EW</span><span class="sg-line ne">NE</span><span class="sg-line cc">CC</span><span class="sg-line dt">DT</span><span class="sg-line te">TE</span></div>';
  }

  function routineTime(value) {
    return value ? timeLabel(value) : 'Flexible time';
  }

  function routineDays(days) {
    if (!Array.isArray(days) || !days.length) return 'Any day';
    if ([1, 2, 3, 4, 5].every((day) => days.includes(day)) && days.length === 5) return 'Mon–Fri';
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].filter((_, index) => days.includes(index)).join(' · ');
  }

  function routineRecords() {
    return routineStorage ? routineStorage.load().routines : [];
  }

  function routineSchedule(routine) {
    if (routine.type === 'route') {
      const label = routine.schedule.timeMode === 'arrive' ? 'Arrive by' : 'Leave at';
      return `${routineDays(routine.schedule.days)} · ${label} ${routineTime(routine.schedule.departureTime)}`;
    }
    const start = routineTime(routine.schedule.startTime);
    const end = routine.schedule.endTime ? `–${routineTime(routine.schedule.endTime)}` : '';
    return `${routineDays(routine.schedule.days)} · ${start}${end}`;
  }

  function routineItem(routine) {
    const isRoute = routine.type === 'route';
    const detail = isRoute
      ? `${routine.route.origin} → ${routine.route.destination}`
      : `${routine.bus.stopCode} · ${routine.bus.stopName}`;
    const extra = isRoute
      ? routineSchedule(routine)
      : `${routine.bus.services.join(' · ')} · ${routineSchedule(routine)}`;
    const label = routine.homeWorkLabel === 'home' ? 'Home' : routine.homeWorkLabel === 'work' ? 'Work' : '';
    const labelMarkup = label ? '<span class="routine-home-work">' + label + '</span>' : '';
    const alertMarkup = '';
    const busId = routine.legacy?.key === routineStorage?.STORAGE_KEYS.presets ? routine.legacy.id : routine.id.replace(/^bus:/, '');
    const routineId = escapeHtml(isRoute ? routine.id : busId);
    return '<article class="routine-item ' + (isRoute ? 'routine-item-route' : 'routine-item-bus') + '">' +
      '<div class="routine-item-top"><div class="routine-item-tags"><span class="routine-kind ' + (isRoute ? 'route' : 'bus') + '">' + (isRoute ? 'ROUTE' : 'BUS') + '</span>' + labelMarkup + alertMarkup + '</div><span class="routine-item-schedule">' + escapeHtml(routineSchedule(routine)) + '</span></div>' +
      '<h2>' + escapeHtml(routine.name) + '</h2>' +
      '<p>' + escapeHtml(detail) + '</p>' +
      '<div class="routine-item-extra">' + escapeHtml(extra) + '</div>' +
      '<div class="routine-item-actions"><button type="button" class="routine-action-primary" data-route-action="open-routine" data-routine-id="' + routineId + '">' + (isRoute ? 'Open journey' : 'Open bus arrivals') + '</button><button type="button" class="routine-action-secondary" data-route-action="edit-routine" data-routine-id="' + routineId + '">Edit</button><button type="button" class="routine-action-remove" data-route-action="remove-routine" data-routine-id="' + routineId + '" data-routine-label="' + escapeHtml(routine.name) + '">Remove</button></div>' +
      '</article>';
  }

  function routinesView() {
    const records = routineRecords().filter(r => r.type === savedCategory);
    return `<div class="route-panel routines-mode"><div class="routine-library-header"><button class="routine-back" aria-label="Back to journey" data-route-action="close-routines">‹</button><h1>Saved</h1></div>
      <div class="route-time-mode" role="group" aria-label="Saved categories"><button data-route-action="saved-category" data-category="route" aria-pressed="${savedCategory === 'route'}">Journeys</button><button data-route-action="saved-category" data-category="bus" aria-pressed="${savedCategory === 'bus'}">Bus stops</button></div>
      ${formError ? `<p role="alert">${escapeHtml(formError)}</p>` : ''}
      <div class="routine-library-actions"><button class="route-primary" data-route-action="${savedCategory === 'route' ? 'new-route' : 'bus'}">${savedCategory === 'route' ? 'Plan a journey' : 'Add a bus stop'}</button></div>
      ${records.length ? records.map(routineItem).join('') : `<div class="routine-empty"><h2>No ${savedCategory === 'route' ? 'journeys' : 'bus stops'} saved yet</h2><p>${savedCategory === 'route' ? 'Plan a journey, then save your routine.' : 'Save a stop and the services you use.'}</p></div>`}</div>`;
  }

  function routineById(id) {
    return routineRecords().find((routine) => routine.id === id || (routine.type === 'bus' && (routine.legacy?.id === id || routine.id.replace(/^bus:/, '') === id)));
  }

  function openRoutineLibrary() {
    stopLiveRefresh();
    stopTemporalClock();
    routinesOpen = true;
    render();
  }

  function openBusView(id = '') {
    cancelAsyncWork();
    destroyMap();
    shell.hidden = true;
    document.querySelector('.app-shell').hidden = false;
    launcher.hidden = false;
    if (id && window.JalanBus?.open) window.JalanBus.open(id); else window.JalanBus?.list();
  }

  function leaveActive() {
    if (!activeSession) return true;
    if (!window.confirm('End the active journey to open a different plan?')) return false;
    journeyTools.clear(); activeSession = null; return true;
  }

  function beginRouteEdit() {
    if (!leaveActive()) return;
    cancelAsyncWork();
    dashboardPane = 'now';
    draftState = draft(saved);
    saved = null;
    routeState = { status: 'idle', data: null, error: '' };
    routinesOpen = false;
    render();
  }

  function startNewRoute() {
    if (!leaveActive()) return false;
    cancelAsyncWork();
    dashboardPane = 'now';
    saved = null;
    saveFormOpen = false;
    formError = '';
    draftState = draft({ id: newRouteId(), name: 'New commute' });
    routeState = { status: 'idle', data: null, error: '' };
    routinesOpen = false;
    render();
  }

  function openRoutine(id) {
    if (!leaveActive()) return;
    const routine = routineById(id);
    routinesOpen = false;
    if (!routine) { render(); return; }
    if (routine.type === 'bus') {
      const busId = routine.legacy?.id || routine.id.replace(/^bus:/, '');
      openBusView(busId);
      return;
    }
    const ordered = [routine, ...routineRecords().filter((value) => value.id !== routine.id)];
    const occurrence = occurrenceFor(routine);
    saved = { ...routineStorage.routeFromRoutine(routine), ...(occurrence ? { date: occurrence.date, departureTime: occurrence.time, timeMode: occurrence.timeMode, overdue: occurrence.overdue } : {}) };
    saveFormOpen = false;
    draftState = draft(saved);
    dashboardPane = 'now';
    routeState = { status: 'idle', data: null, error: '' };
    render();
  }

  function editRoutine(id) {
    const routine = routineById(id);
    routinesOpen = false;
    if (!routine) { render(); return; }
    if (routine.type === 'bus') {
      const busId = routine.legacy?.id || routine.id.replace(/^bus:/, '');
      openBusView(busId);
      window.JalanBus?.edit(busId);
      return;
    }
    saved = routineStorage.routeFromRoutine(routine);
    beginRouteEdit();
  }

  function removeRoutine(id, label = 'this routine') {
    const routine = routineById(id);
    if (!routine || !routineStorage) return;
    if (typeof window.confirm === 'function' && !window.confirm(`Remove ${label}?`)) return;
    const loaded = routineStorage.load();
    const next = loaded.routines.filter((value) => value.id !== routine.id);
    if (!routineStorage.save(next).ok) { formError = 'Could not remove the saved item. Please retry.'; render(); return; }
    if (routine.type === 'bus') window.JalanBus?.sync();
    else {
      const remainingRoute = next.find((value) => value.type === 'route');
      const removingActive = routeRoutineId(saved) === routine.id;
      syncLegacyRoute(next);
      if (removingActive) {
        saved = remainingRoute ? routineStorage.routeFromRoutine(remainingRoute) : null;
        draftState = draft(saved);
        routeState = { status: 'idle', data: null, error: '' };
      }
    }
    window.JalanBus?.sync();
    routinesOpen = true;
    render();
  }

  function routineMetaFields() {
    const label = draftState.homeWorkLabel || '';
    return '<div class="routine-meta-fields">' +
      '<label class="routine-meta-field"><span class="route-field-label">Routine name</span><input id="route-routine-name" class="routine-meta-input" value="' + escapeHtml(draftState.name) + '" placeholder="e.g. Home to Work"></label>' +
      '<label class="routine-meta-field"><span class="route-field-label">Location label</span><select id="route-home-work" class="routine-meta-select"><option value=""' + (!label ? ' selected' : '') + '>No label</option><option value="home"' + (label === 'home' ? ' selected' : '') + '>Home</option><option value="work"' + (label === 'work' ? ' selected' : '') + '>Work</option></select></label>' +
      '</div>';
  }

  function setup() {
    const locationRow = (field, label, placeholder, node) => `<button class="route-location-row" data-route-pick="${field}">
      <span class="route-node ${node}"></span>
      <span class="route-field-copy"><span class="route-field-label">${label}</span><span class="route-location-value${draftState[field] ? '' : ' placeholder'}">${escapeHtml(draftState[field] || placeholder)}</span></span>
      <span class="route-map-action">Choose</span>
    </button>`;

    return `<div class="route-panel">
      <div class="route-topbar">${brand()}<button type="button" class="route-link compact" data-route-action="routines">Saved</button></div>
      <div class="route-setup-copy"><div class="route-kicker">Bus + MRT · Singapore</div><h1>Where are you going?</h1><p>Set a start and destination to see your public-transport journey.</p>${network()}</div>
      <div class="route-form">
        <div class="route-input-card">${locationRow('origin', 'From', 'Choose where you start', 'origin')}${locationRow('destination', 'To', 'Choose where you’re going', 'destination')}</div>
        ${travelFields()}
        ${formError ? `<p role="alert">${escapeHtml(formError)} ${formError.includes('scheduled time') ? '<button data-route-action="tomorrow">Use tomorrow</button>' : ''}</p>` : ''}
        <button class="route-primary" data-route-action="plan" ${draftState.originPoint && draftState.destinationPoint ? '' : 'disabled'}>Show journey</button>
      </div>
      <button class="route-link" data-route-action="bus">I only need bus arrivals</button>

    </div>`;
  }

  function travelFields() {
    return `<div class="route-time-mode" role="group" aria-label="Journey time preference">${[['now','Leave now'],['depart','Leave at'],['arrive','Arrive by']].map(([mode,label]) => `<button type="button" class="route-time-mode-button${draftState.timeMode === mode ? ' selected' : ''}" aria-pressed="${draftState.timeMode === mode}" data-route-action="time-mode" data-time-mode="${mode}">${label}</button>`).join('')}</div>
      ${draftState.timeMode === 'now' ? `<p class="schedule-context">Today · ${singaporeDate()} · Singapore time</p>` : `<div class="travel-date-fields"><label>Date (Singapore)<input id="route-date-input" type="date" min="${singaporeDate()}" value="${escapeHtml(draftState.date)}"></label><label>${draftState.timeMode === 'arrive' ? 'Arrive by' : 'Leave at'}<input id="route-time-input" type="time" value="${escapeHtml(draftState.departureTime)}"></label></div>`}`;
  }

  function picker() {
    return `<div class="route-picker"><div class="picker-topbar"><button class="picker-back" aria-label="Back" data-route-action="cancel">‹</button><h1 class="picker-title">${pickerField === 'origin' ? 'Starting place' : pickerField === 'recovery' ? 'Replan from' : 'Destination'}</h1></div>
      <div class="place-search"><label for="picker-manual-input">Search a place or postal code</label><div class="picker-manual-row"><input id="picker-manual-input" class="picker-manual-input" value="${escapeHtml(searchQuery)}" placeholder="Tampines MRT"><button class="picker-manual-button" data-route-action="manual">Search</button></div><div id="place-results" aria-live="polite">${searchResultsMarkup()}</div></div>
      <details class="map-picker-details"><summary>Choose a map pin or use my location</summary><div class="mapbox-stage"><div id="route-map" class="route-map"></div><div class="picker-crosshair"><span></span></div><div id="map-fallback" class="map-fallback" hidden>Map unavailable. Search above.</div><button class="picker-locate" data-route-action="locate">◎ My location</button></div><div class="picker-sheet"><div id="picker-label" class="picker-place">${escapeHtml(mapPosition.label)}</div><div id="picker-coords" class="picker-coords">${mapPosition.center.lat.toFixed(5)}, ${mapPosition.center.lng.toFixed(5)}</div><button class="route-primary" data-route-action="confirm">Use this point</button></div></details></div>`;
  }

  function searchResultsMarkup() {
    return `<p role="status">${escapeHtml(searchMessage)}</p>` + searchResults.map((item,index) => `<button class="place-result" data-place-index="${index}"><strong>${escapeHtml(item.name || item.label)}</strong><span>${escapeHtml(item.address)}</span><small>${Number(item.lat).toFixed(5)}, ${Number(item.lng).toFixed(5)} · Map position</small></button>`).join('');
  }

  function choosePlace(label, point) {
    if (pickerField === 'recovery') { recoveryOrigin = { ...point, name: label }; pickerField = null; recoveryOpen = false; routeData({fromNow:true, origin:recoveryOrigin}); return; }
    draftState[pickerField] = label;
    draftState[pickerField + 'Point'] = point;
    closePicker();
  }

  function journey() {
    const itinerary = routeState.data;
    const currentRoute = itinerary?.service === 'now' || itinerary?.service === 'next';
    const departure = itinerary?.startTime ? timeAt(itinerary.startTime) : timeLabel(saved?.departureTime || draftState.departureTime);
    const arrival = itinerary?.endTime ? timeAt(itinerary.endTime) : '—';
    const arriveBy = !currentRoute && saved?.timeMode === 'arrive';
    const requested = currentRoute ? (itinerary.service === 'next' ? 'Next available' : 'Now') : timeLabel(saved?.departureTime || draftState.departureTime);
    const leftLabel = currentRoute ? (itinerary.service === 'next' ? 'Next departure' : 'Leave now') : (arriveBy ? 'Arrive by' : 'Leave at');
    const leftValue = arriveBy ? requested : departure;
    const rightLabel = arriveBy ? 'Expected departure' : 'Expected arrival';
    const rightValue = arriveBy ? (departure || '—') : (arrival || '—');
    const routeMeta = itinerary ? durationLabel(itinerary.duration) + ' · ' + itinerary.transfers + ' transfer' + (itinerary.transfers === 1 ? '' : 's') : '';
    const routeStatus = itinerary ? liveTools.summary(itinerary).label : 'Planned';
    const routeTitle = '<div class="now-route-title"><strong>' + escapeHtml(saved.origin) + '</strong><span aria-hidden="true">→</span><strong>' + escapeHtml(saved.destination) + '</strong></div>';
    return '<div class="journey-hero-route">' +
      '<div class="now-route-header">' + routeTitle + '<button type="button" class="now-route-more" aria-label="Edit saved commute" data-route-action="edit">•••</button></div>' +
      '<div class="now-route-context"><span class="route-card-label">YOUR JOURNEY</span><span class="now-route-status">' + escapeHtml(routeStatus) + '</span></div>' +
      '<div class="journey-hero-location"><span class="route-node origin"></span><div><div class="journey-label">From</div><div class="journey-place">' + escapeHtml(saved.origin) + '</div></div></div>' +
      '<div class="journey-hero-location"><span class="route-node destination"></span><div><div class="journey-label">To</div><div class="journey-place">' + escapeHtml(saved.destination) + '</div></div></div>' +
      '<div class="now-route-time"><div><span class="route-field-label">' + escapeHtml(leftLabel) + '</span><strong>' + escapeHtml(leftValue || '—') + '</strong></div><span class="now-route-time-arrow" aria-hidden="true">→</span><div><span class="route-field-label">' + escapeHtml(rightLabel) + '</span><strong>' + escapeHtml(rightValue) + '</strong></div></div>' +
      (routeMeta ? '<div class="now-route-meta">' + escapeHtml(routeMeta) + '</div>' : '') +
      '</div>';
  }

  function journeyHero() {
    return '<section class="journey-hero">' + temporalCard() + '<div class="compact-journey"><strong>' + escapeHtml(saved.name || 'Journey preview') + '</strong><span>' + escapeHtml(saved.date || singaporeDate()) + ' · Singapore time</span><details><summary>Journey details</summary>' + journey() + '</details></div>' + (routeState.data ? '<button class="route-link" data-route-action="save-form">' + (routineById(routeRoutineId(saved)) ? 'Edit routine' : 'Save as a routine') + '</button>' : '') + (routineById(routeRoutineId(saved)) ? '<div class="routine-day-actions"><button data-route-action="skip-today">Skip today</button><button data-route-action="change-today">Change time today</button><button data-route-action="return">Add return journey</button></div>' : '') + '</section>';
  }

  function journeyLegPreview(itinerary) {
    const legs = itinerary?.legs || [];
    if (!legs.length) return '';
    const journeyState = journeyLegState(itinerary);
    const anchorIndex = Number.isInteger(journeyState.currentIndex)
      ? journeyState.currentIndex
      : journeyState.nextIndex;
    const maxStart = Math.max(0, legs.length - 3);
    const start = Number.isInteger(anchorIndex) ? Math.min(maxStart, Math.max(0, anchorIndex - 1)) : 0;
    const visible = legs.slice(start, start + 3).map((leg, offset) => ({ leg, index: start + offset }));
    const overflow = Math.max(0, legs.length - visible.length);
    const rows = visible.map(({ leg, index }) => {
      const current = journeyState.currentIndex === index;
      const next = journeyState.nextIndex === index;
      const marker = current ? 'Now' : next ? 'Next' : '';
      const mode = leg.mode === 'SUBWAY' ? 'MRT' : leg.mode;
      const aria = legTitle(leg) + (marker ? ', ' + marker.toLowerCase() : '');
      return '<button type="button" class="journey-leg-preview-item' + (current ? ' current' : '') + (next ? ' next' : '') + '" data-route-action="leg" data-route-leg="' + index + '" aria-label="' + escapeHtml(aria) + '"><span class="journey-leg-preview-mode ' + escapeHtml(String(leg.mode || '').toLowerCase()) + '">' + escapeHtml(mode) + '</span><span class="journey-leg-preview-copy"><strong>' + escapeHtml(legTitle(leg)) + '</strong><span>' + escapeHtml(legMeta(leg)) + '</span></span><span class="journey-leg-preview-time">' + escapeHtml(legTimes(leg) || '—') + (marker ? '<small>' + escapeHtml(marker) + '</small>' : '') + '</span></button>';
    }).join('');
    const more = overflow > 0
      ? '<button type="button" class="journey-leg-preview-more" data-route-action="dashboard-pane" data-dashboard-pane="route" aria-label="Open Route to see ' + overflow + ' more of ' + legs.length + ' journey legs">+' + overflow + ' more of ' + legs.length + ' legs<span aria-hidden="true">→</span></button>'
      : '';
    return '<div class="journey-leg-preview"><div class="route-card-label">Journey preview</div><div class="journey-leg-preview-list">' + rows + more + '</div></div>';
  }

  function timing(leg) {
    if (leg.mode === 'BUS' && leg.live?.arrivals && legConfidence(leg).key === 'live') {
      const arrivals = leg.live.arrivals.filter(Number.isFinite).slice(0, 3);
      if (arrivals.length) return `<div class="leg-live"><span class="live-dot"></span>${arrivals.map((value) => `<b>${value === 0 ? 'Arr' : `${value} min`}</b>`).join('')}<em>at stop now</em></div>`;
    }
    if (legConfidence(leg).key === 'stale') return '<div class="leg-live scheduled">Stale feed · scheduled connection</div>';
    if (leg.mode === 'BUS' && leg.liveStatus === 'loading') return '<div class="leg-live muted">Checking live arrivals…</div>';
    if (leg.mode === 'BUS' && leg.liveStatus === 'error') return '<div class="leg-live scheduled"><b>Schedule fallback</b><em>LTA unavailable</em></div>';
    if (leg.mode === 'BUS' && leg.liveStatus === 'ready') return '<div class="leg-live scheduled"><b>No live arrival</b><em>LTA</em></div>';
    if (leg.mode === 'SUBWAY' && leg.trainStatus === 'loading') return '<div class="leg-live muted">Checking LTA train updates…</div>';
    if (leg.mode === 'SUBWAY' && leg.trainRealtime?.alertText) return `<div class="leg-live alert"><span class="live-dot"></span><b>${escapeHtml(leg.trainRealtime.alertText)}</b><em>LTA alert</em></div>`;
    if (leg.mode === 'SUBWAY' && legConfidence(leg).key === 'live' && leg.trainRealtime && (leg.trainRealtime.departureTime || leg.trainRealtime.arrivalTime)) {
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

  function liveCategory(status) {
    if (!status) return 'Checking';
    if (status.key === 'live') return 'Live';
    if (status.key === 'alert') return 'Alert';
    if (status.key === 'fallback') return 'Fallback';
    if (status.key === 'partial') return 'Partly live';
    if (status.key === 'checking') return 'Checking';
    return status.label || 'Scheduled';
  }

  function confidenceMarkup(leg) {
    const status = legConfidence(leg);
    const age = liveTools.ageLabel(status.updatedAt);
    const detail = `${status.source}${age ? ` · ${age}` : ''}`;
    return `<div class="timeline-confidence ${escapeHtml(status.tone)}"><span class="timeline-confidence-label">${escapeHtml(liveCategory(status))}</span><span>${escapeHtml(detail)}</span></div>`;
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
    return Date.parse(`${saved?.date || singaporeDate()}T${value || '00:00'}:00+08:00`) || 0;
  }

  function focusTimes() {
    const itinerary = routeState.data;
    const departure = itinerary?.startTime ? toTimestamp(itinerary.startTime) : todayAt(saved?.departureTime);
    const arrival = itinerary?.endTime
      ? toTimestamp(itinerary.endTime)
      : departure + ((Number(itinerary?.duration) || 0) * 1000);
    return { departure, arrival };
  }

  function journeyLegState(itinerary) {
    const guidance = activeSession && journeyTools.guidance(activeSession, itinerary);
    return {currentIndex: guidance && guidance.phase !== 'complete' ? guidance.legIndex : null, nextIndex: guidance ? guidance.legIndex + 1 : 0};
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
      if (Number.isFinite(first)) details.push('At stop now: ' + (first === 0 ? 'arriving' : first + ' min') + ' (not a confirmed connection)');
    }
    const status = legConfidence(leg);
    const age = liveTools.ageLabel(status.updatedAt, now);
    details.push(liveCategory(status) + ' · ' + status.source + (age ? ' · ' + age : ''));
    return details.join(' · ');
  }

  function journeyTemporalState(now = Date.now()) {
    const itinerary = routeState.data;
    const {departure, arrival} = focusTimes();
    if (!itinerary) return {phase:'loading',label:'PLANNING',currentAction:'Finding your route',detail:'Checking public transport.',countdownMs:0};
    const guidance = activeSession ? journeyTools.guidance(activeSession,itinerary,now) : null;
    const overdue = !guidance && departure < now - 60000;
    return {phase:guidance ? (guidance.phase === 'complete' ? 'complete' : 'in_progress') : departure > now + PLANNING_WINDOW_MS ? 'planning' : 'upcoming',
      label:guidance ? 'CONFIRMED JOURNEY' : overdue ? 'DEPARTURE PASSED' : 'PLANNED DEPARTURE',
      currentAction:guidance ? guidance.label : overdue ? 'Running late? Update your plan' : actionLabel(itinerary.legs[0]),
      detail:guidance ? guidance.detail : 'Start commute when you leave. Progress changes only when you confirm it.',
      countdownMs:Math.max(0,(guidance ? arrival : departure)-now), primaryTime:timeAt(departure),
      nextAction:'', confidenceLeg:itinerary.legs[guidance?.legIndex || 0], isStale:overdue};
  }

  function temporalCountdownLabel(state) {
    if (!state || !state.countdownMs) return '';
    const totalMinutes = Math.max(1, Math.ceil(state.countdownMs / 60000));
    if (state.phase === 'planning' || state.phase === 'upcoming') return totalMinutes < 60 ? totalMinutes + ' min' : Math.floor(totalMinutes / 60) + ' hr ' + (totalMinutes % 60 ? (totalMinutes % 60) + ' min' : '');
    if (state.phase === 'in_progress' || state.phase === 'between_legs') return 'Arrive in ' + (totalMinutes < 60 ? totalMinutes + ' min' : Math.floor(totalMinutes / 60) + ' hr');
    return '';
  }

  function temporalActionKicker(state) {
    if (!state || state.phase === 'loading') return 'ROUTE STATUS';
    if (state.phase === 'planning') return 'YOUR PLAN';
    if (state.phase === 'in_progress') return 'DO THIS NOW';
    if (state.phase === 'complete') return 'NEXT STEP';
    return 'NEXT ACTION';
  }

  function temporalActionText(state) {
    return state?.phase === 'complete' ? 'Plan a fresh route' : (state?.currentAction || 'Follow your saved commute');
  }

  function focusInfo(now = Date.now()) {
    const state = journeyTemporalState(now);
    if (state.phase === 'loading') return { phase: 'loading', label: 'GETTING READY', countdown: '—', context: state.currentAction };
    const phase = state.phase === 'planning' || state.phase === 'upcoming' ? 'depart' : state.phase === 'complete' ? 'complete' : 'arrive';
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
    return `<div class="focus-view"><div class="focus-topbar"><div><div class="route-kicker">DailyLoop · route guidance</div><div class="focus-route">${escapeHtml(saved.origin)} → ${escapeHtml(saved.destination)}</div></div><button class="focus-exit" data-route-action="exit-focus">Exit</button></div><main class="focus-face"><div id="focus-phase" class="focus-phase focus-phase-${escapeHtml(info.phase)}">${escapeHtml(info.label)}</div><div id="focus-countdown" class="focus-countdown" role="timer" aria-live="off" aria-label="${escapeHtml(info.label)} ${escapeHtml(info.countdown)}">${escapeHtml(info.countdown)}</div><div id="focus-context" class="focus-context">${escapeHtml(info.context)}</div></main><div class="focus-footer"><span id="focus-freshness">${escapeHtml(freshness)}</span><span>Guidance view · no location tracking</span></div></div>`;
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
    const journeyState = journeyLegState(itinerary);
    return '<div class="timeline">' + legs.map((leg, index) => {
      const current = journeyState.currentIndex === index;
      const next = journeyState.nextIndex === index;
      const marker = current
        ? '<span class="timeline-current-label current">Now</span>'
        : next
          ? '<span class="timeline-current-label next">Next</span>'
          : '';
      const stateClass = (current ? ' current' : '') + (next ? ' next' : '');
      const affected = leg.mode === 'SUBWAY' && leg.trainRealtime?.alertText ? ' affected' : '';
      return transferPoint(legs[index - 1], leg) + '<button type="button" class="timeline-item' + (selectedLegIndex === index ? ' selected' : '') + stateClass + affected + '" data-route-action="leg" data-route-leg="' + index + '" aria-label="' + escapeHtml(legTitle(leg) + (current ? ', now' : next ? ', next' : '')) + '"><div class="timeline-rail"><span class="timeline-dot ' + leg.mode.toLowerCase() + '"></span></div><div class="timeline-body"><div class="timeline-head"><strong>' + escapeHtml(legTitle(leg)) + '</strong><span class="timeline-head-side">' + marker + '<span class="timeline-mode">' + (leg.mode === 'SUBWAY' ? 'MRT' : escapeHtml(leg.mode)) + '</span></span></div><div class="timeline-meta">' + escapeHtml(legMeta(leg)) + '</div>' + confidenceMarkup(leg) + (leg.mode === 'SUBWAY' && leg.trainRealtime?.alertText ? '<div class="timeline-alert-label">LTA service alert</div>' : '') + '<div class="timeline-foot"><span>' + escapeHtml(legTimes(leg)) + '</span>' + (leg.mode === 'WALK' ? '' : timing(leg)) + '</div></div></button>';
    }).join('') + '</div>';
  }

  function alternativeOptions(itinerary) {
    return window.JalanRouteAlternatives.alternativeOptions(itinerary);
  }

  const itinerarySignature = window.JalanRouteAlternatives.itinerarySignature;

  function alternatives(itinerary) {
    const options = alternativeOptions(itinerary);
    if (options.length < 2) return '';
    const selectedSignature = itinerarySignature(itinerary);
    const tabs = options.map((option) => '<button class="route-alternative' + (itinerarySignature(option.itinerary) === selectedSignature ? ' selected' : '') + '" data-route-action="alternative" data-route-alternative="' + option.key + '"><strong>' + escapeHtml(option.label) + '</strong><span>' + durationLabel(option.itinerary.duration) + ' · ' + option.itinerary.transfers + ' transfer' + (option.itinerary.transfers === 1 ? '' : 's') + ' · walk ' + durationLabel(option.itinerary.walkDuration) + ' / ' + distanceLabel(option.itinerary.walkDistance) + ' · arrive ' + timeAt(option.itinerary.endTime) + ' · ' + escapeHtml(liveTools.summary(option.itinerary).label) + '</span></button>').join('');
    return '<div class="route-alternatives"><div class="route-card-label">Compare routes</div><div class="route-alternative-tabs">' + tabs + '</div>' + (routineById(routeRoutineId(saved)) ? '<button class="route-link" data-route-action="save-usual">Use selected as my usual route</button>' : '') + '</div>';
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
    if (!saved.originPoint || !saved.destinationPoint) return '<section class="best-route-card"><div class="route-card-label">Journey timeline</div><h2>Map both endpoints</h2><p>Choose exact points so DailyLoop can calculate the journey.</p></section>';
    if (routeState.status === 'loading') return '<section class="best-route-card"><div class="route-card-label">Journey timeline</div><h2>Finding route…</h2><p>Checking Singapore public transport.</p></section>';
    if (routeState.status === 'error') return `<section class="best-route-card"><div class="route-card-label">Journey timeline</div><h2>Routing unavailable</h2><p>${escapeHtml(routeState.error)}</p><button class="route-link" data-route-action="refresh">Retry</button></section>`;
    const itinerary = routeState.data;
    if (!itinerary) return '';
    const rerouting = routeState.status === 'rerouting' ? '<div class="route-rerouting" role="status">Recalculating with the latest route data…</div>' : '';
    const notice = routeState.notice ? `<div class="route-inline-notice" role="status">${escapeHtml(routeState.notice)}</div>` : '';
    return `<section class="best-route-card"><div class="route-card-top"><div><div class="route-card-label">${escapeHtml(routeLabel(itinerary))}</div><h2>${durationLabel(itinerary.duration)}</h2><p class="route-card-helper">Tap a journey leg to see it on the map.</p></div><div class="route-summary-meta">${itinerary.transfers} transfer${itinerary.transfers === 1 ? '' : 's'}</div></div>${rerouting}${notice}${disruptionBanner(itinerary)}${alternatives(itinerary)}${timeline(itinerary)}</section>`;
  }

  function temporalCard() {
    const itinerary = routeState.data;
    if (!itinerary) return `<div class="journey-hero-state"><h2>${routeState.status === 'error' ? 'Route unavailable' : 'Finding your route…'}</h2><p role="status">${escapeHtml(routeState.error || 'Checking Singapore public transport.')}</p>${routeState.status === 'error' ? '<button class="route-primary" data-route-action="recover">Replan from now</button><button class="route-link" data-route-action="edit">Change date or places</button>' : ''}</div>`;
    const state = journeyTemporalState();
    const guidance = activeSession && journeyTools.guidance(activeSession,itinerary);
    const confidence = liveTools.summary(itinerary);
    const busy = routeState.status === 'rerouting';
    return `<div id="manual-journey-state" class="journey-hero-state" aria-live="polite"><div class="route-card-label">${escapeHtml(state.label)}</div><h2>${escapeHtml(state.currentAction)}</h2><p>${escapeHtml(state.detail)}</p><div class="manual-timing"><span>Leave <strong>${timeAt(itinerary.startTime)}</strong></span><span>Expected arrival <strong>${timeAt(itinerary.endTime)}</strong></span></div><p class="confidence-summary">${escapeHtml(confidence.label)} · ${escapeHtml(confidence.detail)}</p>
      ${guidance?.phase === 'complete' ? '<button class="route-primary" data-route-action="finish">Finish journey</button>' : `<button class="route-primary" data-route-action="${guidance ? 'advance' : state.isStale ? 'recover' : 'start'}" ${busy ? 'disabled' : ''}>${guidance ? escapeHtml(guidance.confirmationLabel || guidance.label) : state.isStale ? 'Replan from now' : 'Start commute'}</button>`}
      ${guidance?.phase !== 'complete' ? `<button class="route-link" data-route-action="recover" ${busy ? 'disabled' : ''}>${guidance ? 'Missed it / Running late' : 'Running late? Choose where to replan'}</button>` : ''}
      ${routeState.notice ? `<p role="status">${escapeHtml(routeState.notice)}</p>${routeState.notice.startsWith('Could not') ? '<button class="route-link" data-route-action="recover">Retry replanning</button>' : ''}` : ''}${formError ? `<p role="alert">${escapeHtml(formError)}</p>` : ''}</div>`;
  }

  function modeStatusLabel(status) {
    return ({ stale: 'Stale', live: 'Live', partial: 'Partly live', alert: 'Alert', checking: 'Checking', fallback: 'Fallback', scheduled: 'Scheduled' })[status] || '—';
  }

  function notificationsCard() {
    return '<section class="notifications-card"><div class="route-card-label">In-app disruption checks</div><h2>Updates while DailyLoop is open</h2><p>We check available LTA feeds while you use the app. Keep it open to see service alerts and find another route.</p></section>';
  }

  function dashboardPaneIndex(pane) {
    const index = ['now', 'route', 'live'].indexOf(pane);
    return index < 0 ? 0 : index;
  }

  function dashboardPaneLabel(pane) {
    return ({ now: 'Now', route: 'Route', live: 'Live' })[pane] || 'Now';
  }

  function dashboardAlerts() {
    return (routeState.data?.liveAlerts || []).filter((alert) => alert.header || alert.description);
  }

  function routeNotice() {
    const notice = routeState.notice;
    if (!notice || notice === dismissedNotice) return '';
    return '<div class="floating-route-notice" role="status" aria-live="polite"><span>' + escapeHtml(notice) + '</span><button type="button" class="floating-route-notice-dismiss" aria-label="Dismiss route notice" data-route-action="dismiss-notice">×</button></div>';
  }

  function dashboardAlert() {
    const alerts = dashboardAlerts();
    if (!alerts.length) return '';
    const first = alerts[0];
    const count = alerts.length > 1 ? `${alerts.length} alerts` : 'Affects this journey';
    return `<div class='dashboard-alert-strip' role='alert'><span class='dashboard-alert-icon'><svg aria-hidden='true' viewBox='0 0 24 24' fill='none'><path d='m10.2 4.5-7.1 12.3A2 2 0 0 0 4.8 19.8h14.4a2 2 0 0 0 1.7-3L13.8 4.5a2 2 0 0 0-3.6 0Z' fill='currentColor'/><path d='M12 8.5v5M12 16.5h.01' stroke='white' stroke-width='2' stroke-linecap='round'/></svg><span>Live alert</span></span><strong>${escapeHtml(first.header || first.description)}</strong><span class='dashboard-alert-count'>${escapeHtml(count)}</span><button class='route-link' data-route-action='dashboard-pane' data-dashboard-pane='live'>View <span aria-hidden='true'>›</span></button></div>`;
  }

  function dashboardNav() {
    const active = dashboardPane;
    const alerts = dashboardAlerts();
    const panes = ['now', 'route', 'live'];
    return `<nav class='dashboard-nav' aria-label='Commute sections' role='tablist'>${panes.map((pane) => { const selected = pane === active; const badge = pane === 'live' && alerts.length ? `<span class='dashboard-nav-badge'>${alerts.length}</span>` : ''; return `<button id='dashboard-tab-${pane}' type='button' role='tab' aria-selected='${selected}' aria-controls='dashboard-pane-${pane}' class='dashboard-nav-button${selected ? ' selected' : ''}' data-route-action='dashboard-pane' data-dashboard-pane='${pane}'>${dashboardPaneLabel(pane)}${badge}</button>`; }).join('')}</nav>`;
  }

  function liveLegList(itinerary) {
    const entries = (itinerary?.legs || [])
      .map((leg, index) => ({ leg, index }))
      .filter(({ leg }) => ['BUS', 'SUBWAY'].includes(leg.mode));
    if (!entries.length) return '';
    const journeyState = journeyLegState(itinerary);
    return '<div class="live-leg-list"><div class="route-card-label">Live journey legs</div><div class="live-leg-lines">' +
      entries.map(({ leg, index }) => {
        const current = journeyState.currentIndex === index;
        const next = journeyState.nextIndex === index;
        const status = legConfidence(leg);
        const age = liveTools.ageLabel(status.updatedAt);
        const source = status.source + (age ? ' · ' + age : '');
        const expanded = expandedLiveLegIndex === index;
        const detailId = 'live-leg-detail-' + index;
        const marker = current
          ? '<span class="timeline-current-label current">Now</span>'
          : next
            ? '<span class="timeline-current-label next">Next</span>'
            : '';
        const label = legTitle(leg) + (current ? ', now' : next ? ', next' : '');
        return '<div class="live-leg-row' + (current ? ' current' : '') + (next ? ' next' : '') + (expanded ? ' expanded' : '') + '" data-live-mode="' + escapeHtml(String(leg.mode || '').toLowerCase()) + '">' +
          '<button type="button" class="live-leg-toggle" data-route-action="toggle-live-leg" data-route-leg="' + index + '" data-live-label="' + escapeHtml(label) + '" aria-expanded="' + String(expanded) + '" aria-controls="' + detailId + '" aria-label="' + escapeHtml((expanded ? 'Hide' : 'Show') + ' details for ' + label) + '">' +
            '<span class="live-leg-top"><span class="live-leg-title"><strong>' + escapeHtml(legTitle(leg)) + '</strong>' + marker + '</span><span class="live-leg-status"><span class="live-leg-confidence ' + escapeHtml(status.tone) + '">' + escapeHtml(liveCategory(status)) + '</span><span class="live-leg-source">' + escapeHtml(source) + '</span></span></span>' +
            '<span class="live-leg-meta">' + escapeHtml(legMeta(leg)) + '</span>' +
            '<span class="live-leg-bottom"><span>' + escapeHtml(legTimes(leg)) + '</span>' + timing(leg) + '<span class="live-leg-disclosure" aria-hidden="true">' + (expanded ? 'Hide details' : 'Details') + ' · ' + (expanded ? '−' : '+') + '</span></span>' +
          '</button>' +
          '<div class="live-leg-actions"><button type="button" class="route-link live-leg-focus" data-route-action="leg" data-route-leg="' + index + '" aria-label="Show ' + escapeHtml(label) + ' on the Route map">Focus on Route map <span aria-hidden="true">→</span></button></div>' +
          '<div id="' + detailId + '" class="live-leg-detail" role="region" aria-label="' + escapeHtml(label + ' timing details') + '"' + (expanded ? '' : ' hidden') + '><p>' + escapeHtml(liveLegDetail(leg)) + '</p></div>' +
          '</div>';
      }).join('') +
      '</div></div>';
  }

  function liveLegDetail(leg, now = Date.now()) {
    const status = legConfidence(leg);
    const age = liveTools.ageLabel(status.updatedAt, now);
    const detail = [];
    const scheduled = legTimes(leg);
    if (scheduled) detail.push('Timetable: ' + scheduled);

    if (leg.mode === 'BUS') {
      const arrivals = Array.isArray(leg.live?.arrivals) ? leg.live.arrivals.filter(Number.isFinite).slice(0, 3) : [];
      if (arrivals.length) detail.push('Arrivals at this stop now, not confirmed connections: ' + arrivals.map((value) => value === 0 ? 'arriving' : value + ' min').join(', ') + '.');
      else if (leg.liveStatus === 'loading') detail.push('Live bus arrivals are being checked.');
      else if (leg.liveStatus === 'error') detail.push('Fallback: OneMap scheduled timing because LTA arrivals are unavailable.');
      else if (leg.liveStatus === 'ready') detail.push('No live bus arrival was returned; the OneMap timetable is shown.');
      else detail.push('No live bus arrival feed is available; the OneMap timetable is shown.');
    } else if (leg.mode === 'SUBWAY') {
      if (leg.trainStatus === 'loading') detail.push('Live train updates are being checked.');
      else if (leg.trainRealtime?.alertText) detail.push('LTA alert: ' + leg.trainRealtime.alertText);
      else if (leg.trainRealtime && (leg.trainRealtime.departureTime || leg.trainRealtime.arrivalTime)) {
        const departure = leg.trainRealtime.departureTime ? timeAt(leg.trainRealtime.departureTime) : '—';
        const arrival = leg.trainRealtime.arrivalTime ? timeAt(leg.trainRealtime.arrivalTime) : '—';
        const delay = Number(leg.trainRealtime.delay);
        detail.push('LTA update: ' + departure + ' → ' + arrival + (Number.isFinite(delay) && delay > 0 ? ' · reported delay ' + Math.round(delay / 60) + ' min' : '') + '.');
      } else if (leg.trainStatus === 'error') detail.push('Fallback: OneMap scheduled timing because LTA train updates are unavailable.');
      else if (leg.trainStatus === 'ready') detail.push('No live train update was returned; the OneMap timetable is shown.');
      else detail.push('No live train feed is available; the OneMap timetable is shown.');
    }

    if (['BUS','SUBWAY'].includes(leg.mode)) { const atStop = activeSession?.phase === 'waiting' && activeSession.legIndex === leg.index; const connection = atStop ? liveTools.reachableConnection(leg, Date.now()) : null; detail.push(connection?.reachable ? 'From your confirmed stop, reachable estimate with a two-minute boarding margin: ' + timeAt(connection.departureAt) + '.' : 'Connection remains scheduled or estimated until you confirm reaching this stop; allow a two-minute boarding margin.'); }
    detail.push('Status: ' + liveCategory(status) + '. Source: ' + status.source + (age ? ' · ' + age : '') + '.');
    return detail.join(' ');
  }

  function toggleLiveLeg(button) {
    const index = Number(button?.dataset.routeLeg);
    if (!Number.isInteger(index)) return;
    const opening = button.getAttribute('aria-expanded') !== 'true';
    expandedLiveLegIndex = opening ? index : null;
    shell.querySelectorAll('.live-leg-toggle').forEach((toggle) => {
      const isOpen = opening && Number(toggle.dataset.routeLeg) === index;
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.setAttribute('aria-label', (isOpen ? 'Hide' : 'Show') + ' details for ' + (toggle.dataset.liveLabel || 'this leg'));
      const row = toggle.closest('.live-leg-row');
      if (row) row.classList.toggle('expanded', isOpen);
      const detail = document.getElementById(toggle.getAttribute('aria-controls'));
      if (detail) detail.hidden = !isOpen;
      const disclosure = toggle.querySelector('.live-leg-disclosure');
      if (disclosure) disclosure.textContent = isOpen ? 'Hide details · −' : 'Details · +';
    });
  }

  function timingCard() {
    const itinerary = routeState.data;
    const hasBus = itinerary?.legs.some((leg) => leg.mode === 'BUS');
    const hasMrt = itinerary?.legs.some((leg) => leg.mode === 'SUBWAY');
    const liveOpen = liveWindowOpen(itinerary);
    const summary = itinerary ? liveTools.summary(itinerary) : { tone: 'neutral', label: 'Checking route', detail: '' };
    const busStatus = hasBus ? liveTools.modeStatus(itinerary, 'BUS') : null;
    const mrtStatus = hasMrt ? liveTools.modeStatus(itinerary, 'SUBWAY') : null;
    const sourceCopy = hasBus || hasMrt
      ? (hasBus ? (busStatus === 'live' ? 'Bus legs use LTA real-time arrivals.' : 'Bus legs use LTA arrivals when available, with OneMap timings as fallback.') : '') +
        (hasMrt ? (mrtStatus === 'live' ? ' MRT legs use LTA GTFS-Realtime trip updates.' : ' MRT legs use OneMap schedule timings when live train data is unavailable.') : '') +
        (liveOpen ? ' Live feeds refresh every 45 seconds while this screen is open.' : ' Live feeds become available within 90 minutes of departure.')
      : ' This route only needs OneMap route data.';
    const sourceHeading = `Bus ${hasBus ? modeStatusLabel(busStatus) : '—'} · MRT ${hasMrt ? modeStatusLabel(mrtStatus) : '—'}`;
    const refreshDisabled = liveRefreshInFlight || liveRefreshStatus === 'loading' || !hasLiveTiming(itinerary) || !liveOpen;
    const refreshLabel = liveRefreshInFlight || liveRefreshStatus === 'loading'
      ? 'Updating…'
      : !liveOpen
        ? 'Available closer to departure'
        : !hasLiveTiming(itinerary)
          ? 'No live feed'
          : 'Refresh live data';
    return `<section class='timing-card'><div class='timing-heading'><div><div class='route-card-label'>Timing confidence</div><h2>${sourceHeading}</h2></div><div class='timing-status'><span class='live-state live-state-${escapeHtml(summary.tone)}'>${escapeHtml(liveCategory(summary))}</span><span id='live-freshness' class='live-freshness'>${escapeHtml(liveFreshness())}</span></div></div><p>${escapeHtml(summary.detail)} ${escapeHtml(sourceCopy)}</p>${liveLegList(itinerary)}<div class='timing-controls'><span class='timing-control-note'>${escapeHtml(liveFreshness())}</span><button type='button' class='timing-refresh' data-route-action='refresh-live' ${refreshDisabled ? 'disabled' : ''}>${refreshLabel}</button></div></section>`;
  }

  function routeActions() {
    return `<div class='route-actions dashboard-actions'><button class='route-primary' data-route-action='refresh'>Recalculate route</button><button class='route-link' data-route-action='bus'>Open bus arrivals</button><button class='route-link' data-route-action='clear'>Remove saved commute</button></div>`;
  }

  function updateDashboardNavDom() {
    const active = dashboardPaneIndex(dashboardPane);
    shell.querySelectorAll('.dashboard-nav-button').forEach((button) => {
      const selected = dashboardPaneIndex(button.dataset.dashboardPane) === active;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    shell.querySelectorAll('.dashboard-pane').forEach((pane, index) => {
      pane.setAttribute('aria-hidden', String(index !== active));
    });
  }

  function clearDashboardScrollUnlock() {
    if (dashboardScrollUnlockTimer) window.clearTimeout(dashboardScrollUnlockTimer);
    if (dashboardScrollAnimationFrame) window.cancelAnimationFrame(dashboardScrollAnimationFrame);
    dashboardScrollUnlockTimer = null;
    dashboardScrollAnimationFrame = null;
  }

  function syncDashboardPager() {
    const pager = document.getElementById('dashboard-pager');
    if (!pager) return;
    clearDashboardScrollUnlock();
    const panes = ['now', 'route', 'live'];
    const align = () => {
      const target = pager.clientWidth * dashboardPaneIndex(dashboardPane);
      const previousBehavior = pager.style.scrollBehavior;
      pager.style.scrollBehavior = 'auto';
      pager.scrollTo({ left: target, top: 0, behavior: 'auto' });
      pager.style.scrollBehavior = previousBehavior;
    };
    align();
    window.requestAnimationFrame(align);
    updateDashboardNavDom();
    let scrollTimer = null;
    const syncFromScroll = () => {
      scrollTimer = null;
      if (dashboardScrollUnlockTimer) return;
      const index = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
      dashboardPane = panes[Math.max(0, Math.min(panes.length - 1, index))];
      updateDashboardNavDom();
      if (['now', 'route'].includes(dashboardPane)) requestInlineRouteMap();
      else if (map) destroyMap();
    };
    pager.addEventListener('scroll', () => {
      if (dashboardScrollUnlockTimer) return;
      if (scrollTimer) window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(syncFromScroll, 120);
    }, { passive: true });
  }

  function requestInlineRouteMap() {
    if (!['now', 'route'].includes(dashboardPane) || !saved || !routeState.data || viewing || focusMode || pickerField || disruptionDemoOpen) return;
    const suffix = dashboardPane === 'now' ? 'now' : 'route';
    const container = document.getElementById(`route-inline-map-${suffix}`);
    if (!container) return;
    if (map) {
      const mapContainer = map.getContainer?.();
      if (mapContainer === container) {
        window.requestAnimationFrame(() => { if (map) map.resize(); });
        return;
      }
      destroyMap();
    }
    window.requestAnimationFrame(() => renderInlineRouteMap(`route-inline-map-${suffix}`, `route-inline-fallback-${suffix}`));
  }

  function animateDashboardPane(pager, target) {
    const start = pager.scrollLeft;
    const distance = target - start;
    if (Math.abs(distance) < 1) { pager.scrollLeft = target; return; }
    const startedAt = performance.now();
    const duration = 260;
    const frame = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      pager.scrollLeft = start + (distance * eased);
      if (progress < 1 && dashboardScrollUnlockTimer) dashboardScrollAnimationFrame = window.requestAnimationFrame(frame);
      else { pager.scrollLeft = target; dashboardScrollAnimationFrame = null; }
    };
    dashboardScrollAnimationFrame = window.requestAnimationFrame(frame);
  }

  function setDashboardPane(pane) {
    dashboardPane = ['now', 'route', 'live'].includes(pane) ? pane : 'now';
    updateDashboardNavDom();
    const pager = document.getElementById('dashboard-pager');
    if (pager) {
      clearDashboardScrollUnlock();
      const target = pager.clientWidth * dashboardPaneIndex(dashboardPane);
      dashboardScrollUnlockTimer = window.setTimeout(() => {
        dashboardScrollUnlockTimer = null;
        if (Math.abs(pager.scrollLeft - target) > 2) pager.scrollLeft = target;
        updateDashboardNavDom();
      }, 500);
      animateDashboardPane(pager, target);
    }
    if (['now', 'route'].includes(dashboardPane)) requestInlineRouteMap();
    else if (map) destroyMap();
  }

  function routeMapPanel(pane = 'route') {
    const ready = Boolean(routeState.data);
    const isNow = pane === 'now';
    const mapId = `route-inline-map-${pane}`;
    const fallbackId = `route-inline-fallback-${pane}`;
    const heading = routeState.status === 'error' ? 'Map unavailable' : ready ? (isNow ? 'Live route data' : 'Route map') : 'Preparing route map';
    const detail = routeState.status === 'error' ? 'The journey timeline is still available below.' : ready ? 'Tap a leg to focus it.' : 'The map will appear once the route is ready.';
    const selectedLeg = ready && Number.isInteger(selectedLegIndex) ? routeState.data.legs?.[selectedLegIndex] : null;
    const hint = selectedLeg ? 'Showing ' + legTitle(selectedLeg) : ready ? 'Tap a leg to focus' : 'Route updates here';
    const openRoute = isNow ? '<button type="button" class="route-inline-map-open" aria-label="Open route details" data-route-action="dashboard-pane" data-dashboard-pane="route">›</button>' : '';
    const signals = isNow && ready
      ? (routeState.data.legs || []).map((leg, index) => ({ leg, index })).filter(({ leg }) => ['BUS', 'SUBWAY'].includes(leg.mode)).slice(0, 3).map(({ leg, index }) => {
        const status = legConfidence(leg);
        return '<button type="button" class="route-map-signal" data-route-action="leg" data-route-leg="' + index + '"><span class="route-map-signal-mark ' + leg.mode.toLowerCase() + '">' + (leg.mode === 'BUS' ? '▣' : '▤') + '</span><span class="route-map-signal-copy"><strong>' + escapeHtml(legTitle(leg)) + '</strong><span>' + escapeHtml(liveCategory(status)) + '</span></span><span class="route-map-signal-arrow" aria-hidden="true">›</span></button>';
      }).join('')
      : '';
    const recenterControls = !isNow && ready
      ? '<div class="route-map-controls"><button type="button" class="route-map-recenter" data-route-action="recenter-route" aria-label="Center route map on my current location" aria-controls="route-location-status"><svg class="route-map-recenter-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5.5" stroke="currentColor" stroke-width="1.6"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span>Recenter map</span></button><span id="route-location-status" class="route-location-status" role="status" aria-live="polite">One-shot device location</span></div>'
      : '';
    return '<section class="route-inline-map-sticky route-inline-map-' + pane + '"><div class="route-inline-map-heading"><div><span class="route-card-label">' + escapeHtml(heading) + '</span><span class="route-inline-map-hint">' + escapeHtml(hint) + '</span></div>' + openRoute + '</div><div class="route-inline-map-wrap"><div id="' + mapId + '" class="route-inline-map" role="img" aria-label="Route map showing ' + escapeHtml(saved.origin) + ' to ' + escapeHtml(saved.destination) + '"></div><div id="' + fallbackId + '" class="map-fallback"' + (ready ? ' hidden' : '') + '><strong>' + escapeHtml(heading) + '</strong><span>' + escapeHtml(detail) + '</span></div></div>' + recenterControls + (signals ? '<div class="route-map-signals">' + signals + '</div>' : '') + '</section>';
  }

  function dashboard() {
    return '<div class="route-panel dashboard-mode"><div class="dashboard-topbar">' + brand() + '<button type="button" class="dashboard-routines-button" data-route-action="routines"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M6.5 4.5h11a1 1 0 0 1 1 1v14l-6.5-3.6-6.5 3.6v-14a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span>Saved</span></button></div><div class="route-header"><div><div class="route-kicker">Daily journey</div><h1>Your next step</h1></div></div>' + dashboardNav() + routeNotice() + dashboardAlert() + '<div id="dashboard-pager" class="dashboard-pager" aria-label="Commute content"><div class="dashboard-track"><section id="dashboard-pane-now" class="dashboard-pane" role="tabpanel" aria-labelledby="dashboard-tab-now">' + journeyHero() + '</section><section id="dashboard-pane-route" class="dashboard-pane" role="tabpanel" aria-labelledby="dashboard-tab-route">' + routeMapPanel('route') + card() + '</section><section id="dashboard-pane-live" class="dashboard-pane" role="tabpanel" aria-labelledby="dashboard-tab-live">' + timingCard() + notificationsCard() + routeActions() + '</section></div></div></div>';
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
    return `<div class="route-demo"><div class="route-demo-inner">${brand()}<div class="route-demo-topbar"><button class="picker-back" data-route-action="demo-close">‹</button><div><div class="route-kicker">Interaction preview</div><div class="picker-title">Disruption flow</div></div></div><div class="route-demo-intro"><div class="route-kicker">Mock LTA incident</div><h1>${escapeHtml(summary)}</h1><p>See how DailyLoop warns the commuter, finds an alternative, and handles a route with no safe replacement.</p></div><section class="route-demo-alert${alertClass}"><div class="route-demo-alert-top"><span class="route-disruption-label"><span class="live-dot"></span>LTA service alert</span><span class="route-demo-preview-tag">PREVIEW</span></div><h2>East West Line disruption</h2><p>Trains are delayed between Paya Lebar and City Hall.</p></section>${status}<section class="route-demo-card"><div class="route-demo-summary"><div><span class="route-card-label">Journey</span><strong>${duration}</strong></div><span>${rerouted ? '0 transfers' : '1 transfer'}</span></div><div class="route-demo-route-label">${escapeHtml(rerouted ? 'Replacement route' : 'Original route')}</div>${demoTimeline(rerouted)}</section><div class="route-demo-actions">${actions}</div><p class="route-demo-footnote">Mock UI only — no live route or LTA data was changed.</p></div></div>`;
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
      const liveOpen = liveWindowOpen(routeState.data);
      const liveAvailable = hasLiveTiming(routeState.data);
      const busy = liveRefreshInFlight || liveRefreshStatus === 'loading';
      button.disabled = busy || !liveOpen || !liveAvailable;
      button.textContent = busy
        ? 'Updating…'
        : !liveOpen
          ? 'Available closer to departure'
          : !liveAvailable
            ? 'No live feed'
            : 'Refresh live data';
    }
  }

  function liveWindowOpen(itinerary = routeState.data, now = Date.now()) {
    const departure = toTimestamp(itinerary?.startTime) || todayAt(saved?.departureTime);
    return !departure || departure - now <= PLANNING_WINDOW_MS;
  }

  function canRefreshLive() {
    return Boolean(saved && routeState.status === 'ready' && routeState.data && liveWindowOpen() && !pickerField && !viewing && !routinesOpen && !saveFormOpen && !recoveryOpen && !disruptionDemoOpen && !document.hidden && !shell.hidden);
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
    mapSelectionMarkers.forEach((marker) => { try { marker.remove(); } catch {} });
    mapSelectionMarkers = [];
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
    if (document.hidden || focusMode || viewing || pickerField || disruptionDemoOpen || routinesOpen || saveFormOpen || recoveryOpen) return;
    const host = document.getElementById('manual-journey-state');
    if (host) { host.outerHTML = temporalCard(); bind(); }
    syncLiveRefresh();
  }

  function syncTemporalClock() {
    stopTemporalClock();
    if (document.hidden || focusMode || viewing || pickerField || disruptionDemoOpen || !saved || !routeState.data || routeState.status === 'loading') return;
    temporalTimer = window.setInterval(updateTemporalDom, 30000);
  }

  function saveForm() {
    return `<div class="route-panel"><button class="route-link" data-route-action="cancel-save">‹ Back to preview</button><h1>Save your routine</h1>${routineMetaFields()}<fieldset class="routine-days"><legend>Repeat on</legend>${[[1,'Mon'],[2,'Tue'],[3,'Wed'],[4,'Thu'],[5,'Fri'],[6,'Sat'],[0,'Sun']].map(([day,label]) => `<label><input type="checkbox" data-routine-day="${day}" ${(draftState.days === null || draftState.days.includes(day)) ? 'checked' : ''}>${label}</label>`).join('')}</fieldset>${travelFields().replace(/<button[^>]*data-time-mode="now"[^>]*>Leave now<\/button>/, '')}<p>The chosen route becomes your usual route. This schedule is used for future occurrences. Your current preview keeps its original travel time.</p>${formError ? `<p role="alert">${escapeHtml(formError)}</p>` : ''}<button class="route-primary" data-route-action="save">Save routine</button></div>`;
  }

  function recoveryView() {
    const point = activeSession ? journeyTools.guidance(activeSession,routeState.data).lastConfirmedPoint : saved.originPoint;
    return `<div class="route-panel"><button class="route-link" data-route-action="cancel-recovery">‹ Keep current journey</button><h1>Where are you now?</h1><p>Replan from a place you confirm. Your current journey stays available if routing fails.</p><button class="route-primary" data-route-action="recover-last" ${point ? '' : 'disabled'}>Use ${activeSession ? 'last confirmed point' : 'planned starting place'}</button><button class="route-link" data-route-action="recover-search">Search / choose a pin</button><button class="route-link" data-route-action="recover-location">Use my current location</button>${formError ? `<p role="alert">${escapeHtml(formError)}</p>` : ''}</div>`;
  }

  function planDraft() {
    if (!draftState.originPoint || !draftState.destinationPoint) return;
    if (draftState.timeMode !== 'now' && (!draftState.date || Date.parse(`${draftState.date}T${draftState.departureTime}:00+08:00`) <= Date.now())) { formError = 'That scheduled time has passed. Choose a future time or tomorrow.'; render(); return; }
    saved = {...draftState, id:draftState.id || newRouteId(), persisted:false};
    formError = ''; saveFormOpen = false;
    routeState = {status:'idle',data:null,error:''}; render();
  }

  function persistSession() {
    const result = journeyTools.save(activeSession);
    if (result === false || result?.ok === false) formError = 'Journey is active, but this browser could not save progress for reload.';
  }

  function dayException(kind) {
    const record = routineById(routeRoutineId(saved));
    if (!record) return;
    const date = singaporeDate();
    let exception = {skip:true};
    if (kind === 'time') {
      const time = window.prompt('Today’s time in Singapore (HH:MM)', saved.departureTime || singaporeTime());
      if (time === null) return;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { formError = 'Enter a time as HH:MM.'; render(); return; }
      exception = {departureTime:time,timeMode:record.schedule.timeMode};
    }
    const next = {...record, exceptions:{...record.exceptions,[date]:exception}};
    if (!routineStorage.save(routineRecords().map(r => r.id === record.id ? next : r)).ok) { formError = 'Could not save today’s change. Please retry.'; render(); return; }
    if (activeSession) { routeState.notice = 'Routine updated. Your active journey continues unchanged.'; render(); } else openRoutine(record.id);
  }

  function render() {
    destroyMap();
    shell.hidden = false;
    document.querySelector('.app-shell').hidden = true;
    shell.innerHTML = saveFormOpen ? saveForm() : recoveryOpen && !pickerField ? recoveryView() : routinesOpen ? routinesView() : (pickerField ? picker() : (disruptionDemoOpen ? disruptionDemo() : (focusMode ? focusView() : (viewing ? viewer() : (saved ? dashboard() : setup())))));
    bind();
    if (routinesOpen || saveFormOpen || (recoveryOpen && !pickerField)) return;
    if (pickerField) { updateSearchResults(); const details = shell.querySelector('.map-picker-details'); if (details) details.ontoggle = () => { if (details.open) { if (map) map.resize(); else renderPickerMap(); } }; }
    if (viewing) requestAnimationFrame(() => renderViewerMap());
    if (saved && !pickerField && !viewing && saved.originPoint && saved.destinationPoint && routeState.status === 'idle') routeData();
    syncLiveRefresh();
    syncTemporalClock();
    syncDashboardPager();
    requestInlineRouteMap();
  }

  function openPicker(field) {
    pickerField = field;
    searchGeneration++; searchResults = []; searchMessage = ''; searchQuery = '';
    const point = draftState[`${field}Point`];
    mapPosition = { center: point ? { ...point } : { ...DEFAULT_CENTER }, zoom: point ? 16 : 13.5, label: draftState[field] || 'Pinned location' };
    render();
  }

  function closePicker() {
    searchGeneration++;
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

  function mapFeatures(itinerary) {
    return (itinerary?.legs || []).map((leg, index) => {
      const coordinates = leg.geometry ? decodePolyline(leg.geometry) : [];
      return coordinates.length > 1
        ? { type: 'Feature', properties: { mode: leg.mode, index }, geometry: { type: 'LineString', coordinates } }
        : null;
    }).filter(Boolean);
  }

  function updateInlineRouteSelection(targetMap = map) {
    const itinerary = routeState.data;
    if (!itinerary) return;

    const selectedLeg = Number.isInteger(selectedLegIndex) ? itinerary.legs[selectedLegIndex] : null;
    shell.querySelectorAll('.route-inline-map-hint').forEach((hint) => {
      hint.textContent = selectedLeg ? 'Showing ' + legTitle(selectedLeg) : 'Tap a leg to focus';
    });

    shell.querySelectorAll('.timeline-item[data-route-leg]').forEach((item) => {
      item.classList.toggle('selected', Number(item.dataset.routeLeg) === selectedLegIndex);
    });

    if (!targetMap || !window.mapboxgl) return;
    const features = mapFeatures(itinerary);
    const selectedFeature = features.find((feature) => feature.properties.index === selectedLegIndex);
    const selectedOpacity = selectedLeg ? 0.22 : 0.88;

    try {
      ['route-walk', 'route-bus', 'route-mrt'].forEach((layerId) => {
        if (targetMap.getLayer(layerId)) targetMap.setPaintProperty(layerId, 'line-opacity', selectedOpacity);
      });
      if (targetMap.getLayer('route-selected')) targetMap.removeLayer('route-selected');
      if (selectedFeature) {
        targetMap.addLayer({
          id: 'route-selected',
          type: 'line',
          source: 'route',
          filter: ['==', ['get', 'index'], selectedLegIndex],
          paint: { 'line-color': '#D42E12', 'line-width': 9, 'line-opacity': 1 },
        });
      }

      mapSelectionMarkers.forEach((marker) => { try { marker.remove(); } catch {} });
      mapSelectionMarkers = [];
      if (selectedLeg) {
        const from = selectedLeg.fromPoint || (selectedFeature?.geometry.coordinates[0] ? { lng: selectedFeature.geometry.coordinates[0][0], lat: selectedFeature.geometry.coordinates[0][1] } : null);
        const lastCoordinate = selectedFeature?.geometry.coordinates[selectedFeature.geometry.coordinates.length - 1];
        const to = selectedLeg.toPoint || (lastCoordinate ? { lng: lastCoordinate[0], lat: lastCoordinate[1] } : null);
        if (from) mapSelectionMarkers.push(new mapboxgl.Marker({ color: '#005EC4' }).setLngLat([from.lng, from.lat]).addTo(targetMap));
        if (to) mapSelectionMarkers.push(new mapboxgl.Marker({ color: '#D42E12' }).setLngLat([to.lng, to.lat]).addTo(targetMap));
      }

      const bounds = new mapboxgl.LngLatBounds();
      const focusFeatures = selectedFeature ? [selectedFeature] : features;
      focusFeatures.forEach((feature) => feature.geometry.coordinates.forEach((coordinate) => bounds.extend(coordinate)));
      if (selectedLeg?.fromPoint) bounds.extend([selectedLeg.fromPoint.lng, selectedLeg.fromPoint.lat]);
      if (selectedLeg?.toPoint) bounds.extend([selectedLeg.toPoint.lng, selectedLeg.toPoint.lat]);
      if (!bounds.isEmpty()) targetMap.fitBounds(bounds, { padding: 48, duration: 0 });
    } catch {}
  }

  async function renderViewerMap(containerId = 'route-viewer-map', fallbackId = 'viewer-fallback', viewerMode = true) {
    const generation = mapGeneration;
    const container = document.getElementById(containerId);
    const fallback = document.getElementById(fallbackId);
    const itinerary = routeState.data;
    const active = () => viewerMode ? viewing : Boolean(saved && routeState.data && !pickerField && !focusMode && !disruptionDemoOpen);
    const showFallback = () => {
      if (!fallback) return;
      fallback.hidden = false;
      const title = fallback.querySelector('strong');
      const detail = fallback.querySelector('span');
      if (title) title.textContent = 'Map unavailable';
      if (detail) detail.textContent = 'The journey timeline is still available below.';
    };
    if (!container || !itinerary || !saved?.originPoint) return;
    if (!window.mapboxgl) { showFallback(); return; }
    try {
      mapboxgl.accessToken = await mapToken();
      if (generation !== mapGeneration || !active() || !document.getElementById(containerId)) return;
      const features = mapFeatures(itinerary);
      const routePaneMap = !viewerMode && containerId === 'route-inline-map-route';
      const initialCenter = routePaneMap && routeMapLocation
        ? [routeMapLocation.lng, routeMapLocation.lat]
        : [saved.originPoint.lng, saved.originPoint.lat];
      const initialZoom = routePaneMap && routeMapLocation ? 14 : 12.5;
      const nextMap = new mapboxgl.Map({ container, style: 'mapbox://styles/mapbox/streets-v12', center: initialCenter, zoom: initialZoom, dragRotate: false, touchPitch: false });
      if (generation !== mapGeneration || !active()) { nextMap.remove(); return; }
      map = nextMap;
      nextMap.touchZoomRotate.disableRotation();
      nextMap.on('load', () => {
        if (generation !== mapGeneration || !active() || map !== nextMap) return;
        if (features.length) {
          nextMap.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features } });
          nextMap.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'WALK'], paint: { 'line-color': '#777', 'line-width': 4, 'line-opacity': 0.88, 'line-dasharray': [1, 1.5] } });
          nextMap.addLayer({ id: 'route-bus', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'BUS'], paint: { 'line-color': '#1f7a4d', 'line-width': 6, 'line-opacity': 0.88 } });
          nextMap.addLayer({ id: 'route-mrt', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'SUBWAY'], paint: { 'line-color': '#222', 'line-width': 7, 'line-opacity': 0.88 } });
        }
        new mapboxgl.Marker({ color: '#16181A' }).setLngLat([saved.originPoint.lng, saved.originPoint.lat]).addTo(nextMap);
        new mapboxgl.Marker({ color: '#D42E12' }).setLngLat([saved.destinationPoint.lng, saved.destinationPoint.lat]).addTo(nextMap);
        updateInlineRouteSelection(nextMap);
        if (routePaneMap && routeMapLocation) {
          const point = routeMapLocation;
          routeMapLocation = null;
          try {
            nextMap.easeTo({ center: [point.lng, point.lat], zoom: Math.max(14, nextMap.getZoom()), duration: 0 });
            updateRouteLocationStatus('Route map centered on your location. One-shot only.');
          } catch {
            updateRouteLocationStatus('Location found, but the route map could not recenter.');
          }
        }
      });
      nextMap.on('error', () => { if (generation === mapGeneration) showFallback(); });
    } catch { if (generation === mapGeneration) showFallback(); }
  }
  function renderInlineRouteMap(containerId = 'route-inline-map-route', fallbackId = 'route-inline-fallback-route') {
    return renderViewerMap(containerId, fallbackId, false);
  }

  async function manualLocation() {
    const value = document.getElementById('picker-manual-input')?.value.trim();
    if (!value) return;
    searchQuery = value;
    const generation = ++searchGeneration;
    const field = pickerField;
    searchResults = []; searchMessage = 'Searching…'; updateSearchResults();
    try {
      const response = await fetch(`/api/location?q=${encodeURIComponent(value)}`);
      const data = await runtime.readJson(response, 'Location search unavailable.');
      if (generation !== searchGeneration || field !== pickerField) return;
      if (!response.ok) throw new Error(data.error || 'Location search unavailable.');
      searchResults = (data.results || []).filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lng));
      searchMessage = searchResults.length ? 'Choose the matching place. Coordinates show its map position.' : 'No matching places. Try another name or postal code.';
    } catch (error) { if (generation !== searchGeneration || field !== pickerField) return; searchMessage = error.message; }
    updateSearchResults();
  }

  function updateSearchResults() {
    const host = document.getElementById('place-results');
    if (!host) return;
    host.innerHTML = searchResultsMarkup();
    host.querySelectorAll('[data-place-index]').forEach(button => button.onclick = () => {
      const item = searchResults[Number(button.dataset.placeIndex)];
      if (item) choosePlace(item.label || item.name, {lat:item.lat,lng:item.lng});
    });
  }

  function locate() {
    if (!navigator.geolocation) { searchMessage = 'Current location is unavailable. Search for a place instead.'; updateSearchResults(); return; }
    navigator.geolocation.getCurrentPosition((position) => {
      mapPosition.center = { lat: position.coords.latitude, lng: position.coords.longitude };
      mapPosition.zoom = 16.5;
      mapPosition.label = 'My location';
      if (map) map.easeTo({ center: [mapPosition.center.lng, mapPosition.center.lat], zoom: mapPosition.zoom }); else updatePickerDom();
    }, () => { searchMessage = 'Could not get your location. Search or choose a map pin.'; updateSearchResults(); }, { timeout: 7000, maximumAge: 0 });
  }

  function routeLocationMessage(error) {
    if (error?.code === 1) return 'Location permission was not granted.';
    if (error?.code === 2) return 'Current location is unavailable.';
    if (error?.code === 3) return 'Location lookup timed out.';
    return 'Could not get your current location.';
  }

  function updateRouteLocationStatus(message) {
    const status = document.getElementById('route-location-status');
    if (status) status.textContent = message;
  }

  function recenterRouteMap() {
    const button = shell.querySelector('[data-route-action="recenter-route"]');
    if (routeLocationInFlight) return;
    if (!navigator.geolocation) {
      updateRouteLocationStatus('Device location is not supported here.');
      return;
    }

    routeLocationInFlight = true;
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    }
    updateRouteLocationStatus('Finding your location once…');
    navigator.geolocation.getCurrentPosition((position) => {
      routeLocationInFlight = false;
      const point = { lat: position.coords.latitude, lng: position.coords.longitude };
      routeMapLocation = point;
      const mapContainer = map?.getContainer?.();
      const routeMapActive = map && mapContainer?.id === 'route-inline-map-route';
      if (routeMapActive) {
        try {
          const zoom = typeof map.getZoom === 'function' ? Math.max(14, map.getZoom()) : 14;
          map.easeTo({ center: [point.lng, point.lat], zoom, duration: 0 });
          routeMapLocation = null;
          updateRouteLocationStatus('Route map centered on your location. One-shot only.');
        } catch {
          updateRouteLocationStatus('Location found, but the route map could not recenter.');
        }
      } else if (!window.mapboxgl) {
        routeMapLocation = null;
        updateRouteLocationStatus('Location found, but the route map is unavailable here.');
      } else {
        updateRouteLocationStatus('Location found; the route map will recenter when ready.');
      }
      const activeButton = shell.querySelector('[data-route-action="recenter-route"]');
      if (activeButton) {
        activeButton.disabled = false;
        activeButton.removeAttribute('aria-busy');
      }
    }, (error) => {
      routeLocationInFlight = false;
      routeMapLocation = null;
      updateRouteLocationStatus(routeLocationMessage(error));
      const activeButton = shell.querySelector('[data-route-action="recenter-route"]');
      if (activeButton) {
        activeButton.disabled = false;
        activeButton.removeAttribute('aria-busy');
      }
    }, { enableHighAccuracy: false, timeout: 7000, maximumAge: 60000 });
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

  function trainMatch(leg, payload, now = Date.now()) {
    const routeKey = trainLineKey(leg.routeName || leg.lineName);
    const matches = (payload?.updates || []).filter(update => !update.routeId || trainLineKey(update.routeId) === routeKey).flatMap(update => {
      const stops = [...(update.stops || [])].sort((a,b) => (a.stopSequence || 0)-(b.stopSequence || 0));
      const fromIndex = stops.findIndex(stop => sameStop(stop.stopId,leg.fromId));
      const toIndex = stops.findIndex((stop,index) => index > fromIndex && sameStop(stop.stopId,leg.toId));
      if (fromIndex < 0 || toIndex <= fromIndex) return [];
      const from = stops[fromIndex], to = stops[toIndex];
      const departureTime = toTimestamp(from.departureTime || from.arrivalTime);
      const arrivalTime = toTimestamp(to.arrivalTime || to.departureTime);
      if (!departureTime || departureTime < now || !arrivalTime || arrivalTime < departureTime) return [];
      return [{departureTime,arrivalTime,delay:from.departureDelay || from.arrivalDelay || update.delay || 0}];
    }).sort((a,b) => a.departureTime-b.departureTime);
    const alert = (payload?.alerts || []).find(item => (item.header || item.description) && trainAlertMatches(leg,item));
    return matches.length || alert ? {...(matches[0] || {}),alertText:alert?.header || alert?.description || ''} : null;
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
    if (activeSession) { recoveryOpen = true; formError = 'Choose your current starting point before changing routes.'; render(); return; }
    liveRequests.abort();
    const selected = { ...choice.itinerary, alternatives: current.alternatives, choiceLabel: choice.label };
    const liveOpen = liveWindowOpen(selected);
    const request = liveOpen ? liveRequests.start() : null;
    selectedLegIndex = null;
    expandedLiveLegIndex = null;
    liveUpdatedAt = 0;
    liveRefreshInFlight = liveOpen;
    liveRefreshStatus = liveOpen ? 'loading' : 'idle';
    if (activeSession) { activeSession = journeyTools.replaceRoute(activeSession,selected,{confirmed:true,plan:saved}); persistSession(); }
    saved.usualRouteSignature = itinerarySignature(selected);
    routeState = { status: 'ready', data: selected, error: '' };
    render();
    if (!liveOpen) { selected.legs.forEach(leg => { if (leg.mode === 'BUS') leg.liveStatus = 'unavailable'; if (leg.mode === 'SUBWAY') leg.trainStatus = 'unavailable'; }); render(); return; }
    try {
      await Promise.all([liveBus(selected, request.controller.signal), liveTrain(selected, request.controller.signal)]);
      if (liveRequests.isCurrent(request) && routeState.data === selected) { const degraded = liveHasError(selected); if (!degraded && hasLiveTiming(selected)) liveUpdatedAt = Date.now(); liveRefreshStatus = degraded ? 'degraded' : (hasLiveTiming(selected) ? 'ready' : 'idle'); render(); }
    } finally {
      if (liveRequests.isCurrent(request)) { liveRequests.finish(request); liveRefreshInFlight = false; syncLiveRefresh(); }
    }
  }

  async function routeData({ preserveCurrent = false, fromNow = false, origin = null } = {}) {
    if (preserveCurrent && routeState.status === 'rerouting') return;
    if (!fromNow && saved.overdue) { routeState = {status:'error',data:null,error:'This departure has passed. Replan from your current starting point.'}; render(); return; }
    const previous = (preserveCurrent || fromNow) ? routeState.data : null;
    const previousLiveState = snapshotLiveState(previous);
    dismissedNotice = '';
    const request = routeRequests.start();
    liveRequests.abort();
    liveRefreshInFlight = false;
    const previousUpdatedAt = liveUpdatedAt;
    const previousRefreshStatus = liveRefreshStatus;
    selectedLegIndex = null;
    expandedLiveLegIndex = null;
    liveUpdatedAt = 0;
    liveRefreshStatus = 'loading';
    routeState = { status: previous ? 'rerouting' : 'loading', data: previous || null, error: '', notice: '' }; render();
    const savedRoute = saved;
    const routeOrigin = origin || savedRoute.originPoint;
    const start = `${routeOrigin.lat},${routeOrigin.lng}`; const end = `${savedRoute.destinationPoint.lat},${savedRoute.destinationPoint.lng}`; const time = fromNow || savedRoute.timeMode === 'now' ? '' : (savedRoute.departureTime ? `&time=${encodeURIComponent(savedRoute.departureTime)}` : ''); const timeMode = `&timeMode=${encodeURIComponent(fromNow ? 'depart' : (savedRoute.timeMode === 'arrive' ? 'arrive' : 'depart'))}`;
    let liveRequest = null;
    try {
      const response = await fetch(`/api/route?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${time}${timeMode}${fromNow || savedRoute.timeMode === 'now' ? '' : '&date=' + encodeURIComponent(savedRoute.date || singaporeDate())}`, { signal: request.controller.signal });
      const data = await runtime.readJson(response, 'Routing unavailable.');
      if (!routeRequests.isCurrent(request)) return;
      if (!response.ok) throw new Error(data.error || 'Routing unavailable.');
      if (!runtime.isRoutePayload(data)) throw new Error('Routing returned an invalid itinerary.');
      const routed = normalizeRoute(data);
      if (!routed) throw new Error('No public-transport itinerary.');
      const preferred = window.JalanRouteAlternatives.preferredRoute?.(routed,{usualSignature:savedRoute.usualRouteSignature,alerts:previous?.liveAlerts || []});
      let itinerary = {...(preferred?.itinerary || routed),alternatives:routed.alternatives};
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
      if (savedRoute.usualRouteSignature && preferred?.detail) notice = [notice,preferred.detail].filter(Boolean).join(' ');
      if (activeSession && (fromNow || itinerarySignature(itinerary) !== itinerarySignature(previous))) {
        if (!window.confirm('Use this new route from your confirmed starting point? This replaces the current journey steps.')) { routeState = {status:'ready',data:previous,error:'',notice:'Current journey kept.'}; render(); return; }
        activeSession = journeyTools.replaceRoute(activeSession,itinerary,{confirmed:true,confirmedOrigin:routeOrigin,plan:{...savedRoute,originPoint:routeOrigin,date:singaporeDate(),timeMode:'now'}}); persistSession();
      }
      if (fromNow) saved = {...savedRoute,date:singaporeDate(),timeMode:'now',originPoint:routeOrigin,overdue:false};
      routeState = { status: 'ready', data: itinerary, error: '', notice };
      if (!liveWindowOpen(itinerary)) {
        itinerary.legs.forEach(leg => { if (leg.mode === 'BUS') leg.liveStatus = 'unavailable'; if (leg.mode === 'SUBWAY') leg.trainStatus = 'unavailable'; });
        liveRefreshInFlight = false;
        liveRefreshStatus = 'idle';
        render();
        return;
      }
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
    shell.querySelectorAll('[data-routine-day]').forEach(input => input.onchange = () => { draftState.days = [...shell.querySelectorAll('[data-routine-day]:checked')].map(el => Number(el.dataset.routineDay)); });
    shell.querySelectorAll('[data-route-pick]').forEach((button) => { button.onclick = () => openPicker(button.dataset.routePick); });
    const input = document.getElementById('picker-manual-input'); const useButton = shell.querySelector('[data-route-action="manual"]');
    if (input) { input.oninput = () => { searchQuery = input.value; searchGeneration++; searchResults = []; searchMessage = ''; updateSearchResults(); useButton.disabled = !input.value.trim(); }; input.onkeydown = (event) => { if (event.key === 'Enter') manualLocation(); }; }
    const dateInput = document.getElementById('route-date-input'); if (dateInput) dateInput.oninput = () => { draftState.date = dateInput.value; };
    const timeInput = document.getElementById('route-time-input'); if (timeInput) timeInput.oninput = () => { draftState.departureTime = timeInput.value || '08:30'; };
    const routineNameInput = document.getElementById('route-routine-name'); if (routineNameInput) routineNameInput.oninput = () => { draftState.name = routineNameInput.value; };
    const homeWorkInput = document.getElementById('route-home-work'); if (homeWorkInput) homeWorkInput.onchange = () => { draftState.homeWorkLabel = homeWorkInput.value || null; };
    shell.querySelectorAll('[data-route-action]').forEach((button) => {
      button.onclick = () => {
        const action = button.dataset.routeAction;
        if (action === 'demo-disruption') { stopLiveRefresh(); disruptionDemoOpen = true; disruptionDemoStep = 'alert'; render(); }
        else if (action === 'demo-close') { if (disruptionDemoTimer) window.clearTimeout(disruptionDemoTimer); disruptionDemoTimer = null; disruptionDemoOpen = false; disruptionDemoStep = 'alert'; render(); refreshLiveTimings(); }
        else if (action === 'demo-reroute') { if (disruptionDemoStep === 'rerouting') return; disruptionDemoStep = 'rerouting'; render(); disruptionDemoTimer = window.setTimeout(() => { disruptionDemoTimer = null; if (disruptionDemoOpen) { disruptionDemoStep = 'rerouted'; render(); } }, 700); }
        else if (action === 'demo-reset') { if (disruptionDemoTimer) window.clearTimeout(disruptionDemoTimer); disruptionDemoTimer = null; disruptionDemoStep = 'alert'; render(); }
        else if (action === 'demo-fallback') { if (disruptionDemoTimer) window.clearTimeout(disruptionDemoTimer); disruptionDemoTimer = null; disruptionDemoStep = 'fallback'; render(); }
        else if (action === 'routines') openRoutineLibrary();
        else if (action === 'close-routines') { routinesOpen = false; render(); }
        else if (action === 'open-routine') openRoutine(button.dataset.routineId);
        else if (action === 'edit-routine') editRoutine(button.dataset.routineId);
        else if (action === 'remove-routine') removeRoutine(button.dataset.routineId, button.dataset.routineLabel || 'this routine');
        else if (action === 'new-route') startNewRoute();
        else if (action === 'bus') openBusView();
        else if (action === 'edit') beginRouteEdit();
        else if (action === 'plan') planDraft();
        else if (action === 'tomorrow') { draftState.date = singaporeDate(Date.now()+86400000); formError = ''; render(); }
        else if (action === 'save-form') { draftState = draft(routineById(routeRoutineId(saved)) ? {...routineStorage.routeFromRoutine(routineById(routeRoutineId(saved))),date:saved.date} : saved); if (draftState.days === null) draftState.days = [0,1,2,3,4,5,6]; if (draftState.timeMode === 'now') draftState.timeMode = 'depart'; saveFormOpen = true; render(); }
        else if (action === 'cancel-save') { saveFormOpen = false; formError = ''; render(); }
        else if (action === 'save') {
          if (!draftState.days?.length) { formError = 'Choose at least one repeat day.'; render(); return; }
          if (save({ ...draftState, timeMode:draftState.timeMode === 'now' ? 'depart' : draftState.timeMode, usualRouteSignature:itinerarySignature(routeState.data), id:draftState.id || newRouteId(), name:draftState.name.trim() || 'Saved journey' })) { saveFormOpen = false; }
          render();
        }
        else if (action === 'save-usual') { const record = routineById(routeRoutineId(saved)); if (record) { const value = {...routineStorage.routeFromRoutine(record),usualRouteSignature:itinerarySignature(routeState.data)}; const current = saved; if (save(value)) { saved = {...current,usualRouteSignature:value.usualRouteSignature}; routeState.notice = 'Usual route saved.'; } render(); } }
        else if (action === 'saved-category') { savedCategory = button.dataset.category; render(); }
        else if (action === 'start') { activeSession = journeyTools.start({occurrenceId:routeRoutineId(saved)+':'+(saved.date || singaporeDate()),itinerary:routeState.data,origin:saved.originPoint,destination:saved.destinationPoint,plan:saved}); persistSession(); render(); }
        else if (action === 'advance') { activeSession = journeyTools.advance(activeSession,routeState.data); persistSession(); render(); }
        else if (action === 'finish') { completedOccurrences.push(activeSession.occurrenceId); try {sessionStorage.setItem('jalan-lite-completed-occurrences',JSON.stringify(completedOccurrences));} catch {} journeyTools.clear(); activeSession = null; saved = load(); routeState = {status:'idle',data:null,error:''}; render(); }
        else if (action === 'recover' || action === 'refresh-now') { recoveryOpen = true; render(); }
        else if (action === 'cancel-recovery') { recoveryOpen = false; render(); }
        else if (action === 'recover-search') openPicker('recovery');
        else if (action === 'recover-last') { recoveryOrigin = activeSession ? journeyTools.guidance(activeSession,routeState.data).lastConfirmedPoint : saved.originPoint; recoveryOpen = false; routeData({fromNow:true,origin:recoveryOrigin}); }
        else if (action === 'recover-location') { if (!navigator.geolocation) { formError = 'Location unavailable. Search or choose a pin.'; render(); return; } navigator.geolocation.getCurrentPosition(position => { recoveryOrigin = {lat:position.coords.latitude,lng:position.coords.longitude}; recoveryOpen = false; routeData({fromNow:true,origin:recoveryOrigin}); },() => {formError = 'Location unavailable. Search or choose a pin.'; render();},{timeout:10000,maximumAge:0}); }
        else if (action === 'skip-today') dayException('skip');
        else if (action === 'change-today') dayException('time');
        else if (action === 'return') { const outbound = saved; if (startNewRoute() === false) return; draftState = draft({...outbound,id:newRouteId(),name:'Return journey',origin:outbound.destination,destination:outbound.origin,originPoint:outbound.destinationPoint,destinationPoint:outbound.originPoint,linkedRoutineId:routeRoutineId(outbound),exceptions:{},date:singaporeDate(),timeMode:'depart',departureTime:'18:00',usualRouteSignature:''}); render(); }
        else if (action === 'clear') { cancelAsyncWork(); dashboardPane = 'now'; const replacement = clearSavedRoute(); saved = replacement; draftState = draft(replacement); routeState = { status: 'idle', data: null, error: '' }; liveUpdatedAt = 0; liveRefreshStatus = 'idle'; render(); }
        else if (action === 'cancel') closePicker();
        else if (action === 'confirm') choosePlace(mapPosition.label === 'Singapore' ? 'Pinned location' : mapPosition.label, { ...mapPosition.center });
        else if (action === 'manual') manualLocation();
        else if (action === 'locate') locate();
        else if (action === 'recenter-route') recenterRouteMap();
        else if (action === 'toggle-live-leg') toggleLiveLeg(button);
        else if (action === 'dashboard-pane') setDashboardPane(button.dataset.dashboardPane);
        else if (action === 'dismiss-notice') { dismissedNotice = routeState.notice || ''; button.closest('.floating-route-notice')?.remove(); }
        else if (action === 'refresh') { if (activeSession) recoveryOpen = true; else routeState = { status: 'idle', data: null, error: '' }; render(); }
        else if (action === 'refresh-live') refreshLiveTimings();
        else if (action === 'focus') enterFocusMode();
        else if (action === 'exit-focus') exitFocusMode();
        else if (action === 'time-mode') { draftState.timeMode = button.dataset.timeMode; render(); }
        else if (action === 'leg' && routeState.data) { const index = Number(button.dataset.routeLeg); if (Number.isInteger(index) && index >= 0 && index < routeState.data.legs.length) { selectedLegIndex = index; if (viewing) dashboardPane = 'route'; else setDashboardPane('route'); updateInlineRouteSelection(); } }
        else if (action === 'alternative') selectAlternative(button.dataset.routeAlternative);
        else if (action === 'reroute') { if (activeSession) { recoveryOpen = true; render(); } else routeData({ preserveCurrent:true,fromNow:true }); }
        else if (action === 'viewer' && routeState.data) { selectedLegIndex = null; setDashboardPane('route'); }
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

  launcher.onclick = () => { shell.hidden = false; launcher.hidden = true; openRoutineLibrary(); };
  document.body.append(shell, launcher);
  const nextOccurrence = !activeSession && scheduleTools.nextRelevant(routineRecords());
  const nextSaved = nextOccurrence && routineById(nextOccurrence.routineId);
  if (nextSaved?.type === 'bus') openBusView(nextSaved.legacy?.id || nextSaved.id.replace(/^bus:/, ''));
  else render();
})();
