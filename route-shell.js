(() => {
  const STORAGE_KEY = 'jalan-lite-routes-v1';
  const DEFAULT_CENTER = { lat: 1.3521, lng: 103.8198 };
  const shell = document.createElement('section');
  const launcher = document.createElement('button');

  let saved = load();
  let draftState = draft(saved);
  let pickerField = null;
  let mapPosition = { center: { ...DEFAULT_CENTER }, zoom: 14, label: 'Singapore' };
  let routeState = { status: 'idle', data: null, error: '' };
  let map = null;
  let viewing = false;

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
        <label class="route-time-field"><span><span class="route-field-label">Leave at</span><small>Used to calculate the commute timetable</small></span><input id="route-time-input" type="time" value="${escapeHtml(draftState.departureTime || '08:30')}" step="300"></label>
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
    return `<section class="journey-card"><div class="journey-row"><span class="route-node origin"></span><div><div class="journey-label">From</div><div class="journey-place">${escapeHtml(saved.origin)}</div></div></div><div class="journey-row"><span class="route-node destination"></span><div><div class="journey-label">To</div><div class="journey-place">${escapeHtml(saved.destination)}</div></div></div><div class="journey-time-grid"><div><span class="route-field-label">Leave at</span><strong>${escapeHtml(departure)}</strong></div><div><span class="route-field-label">Expected arrival</span><strong>${escapeHtml(arrival || '—')}</strong></div></div></section>`;
  }

  function timing(leg) {
    if (leg.mode === 'BUS' && leg.live?.arrivals) {
      const arrivals = leg.live.arrivals.filter(Number.isFinite).slice(0, 3);
      if (arrivals.length) return `<div class="leg-live"><span class="live-dot"></span>${arrivals.map((value) => `<b>${value === 0 ? 'Arr' : `${value} min`}</b>`).join('')}<em>live</em></div>`;
    }
    if (leg.mode === 'BUS' && leg.liveStatus === 'loading') return '<div class="leg-live muted">Checking live arrivals…</div>';
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
    return `<div class="timeline">${legs.map((leg, index) => `${transferPoint(legs[index - 1], leg)}<div class="timeline-item" data-route-leg="${index}"><div class="timeline-rail"><span class="timeline-dot ${leg.mode.toLowerCase()}"></span></div><div class="timeline-body"><div class="timeline-head"><strong>${escapeHtml(legTitle(leg))}</strong><span class="timeline-mode">${leg.mode === 'SUBWAY' ? 'MRT' : escapeHtml(leg.mode)}</span></div><div class="timeline-meta">${escapeHtml(legMeta(leg))}</div><div class="timeline-foot"><span>${escapeHtml(legTimes(leg))}</span>${leg.mode === 'WALK' ? '' : timing(leg)}</div></div></div>`).join('')}</div>`;
  }

  function routeLabel(itinerary) {
    if (itinerary.service === 'next') return `Next available route · ${timeAt(itinerary.startTime)}`;
    if (itinerary.service === 'planned') return `Route for ${timeLabel(saved.departureTime)}`;
    return 'Best route now';
  }

  function card() {
    if (!saved.originPoint || !saved.destinationPoint) return '<section class="best-route-card"><div class="route-card-label">Journey timeline</div><h2>Map both endpoints</h2><p>Choose exact points so Jalan can calculate the journey.</p></section>';
    if (routeState.status === 'loading') return '<section class="best-route-card"><div class="route-card-label">Journey timeline</div><h2>Finding route…</h2><p>Checking Singapore public transport.</p></section>';
    if (routeState.status === 'error') return `<section class="best-route-card"><div class="route-card-label">Journey timeline</div><h2>Routing unavailable</h2><p>${escapeHtml(routeState.error)}</p><button class="route-link" data-route-action="refresh">Retry</button></section>`;
    const itinerary = routeState.data;
    if (!itinerary) return '';
    return `<section class="best-route-card"><div class="route-card-top"><div><div class="route-card-label">${escapeHtml(routeLabel(itinerary))}</div><h2>${durationLabel(itinerary.duration)}</h2></div><div class="route-summary-meta">${itinerary.transfers} transfer${itinerary.transfers === 1 ? '' : 's'}</div></div>${timeline(itinerary)}<button class="route-view-button" data-route-action="viewer">View route on map</button></section>`;
  }

  function dashboard() {
    const itinerary = routeState.data;
    const hasBus = itinerary?.legs.some((leg) => leg.mode === 'BUS');
    const hasMrt = itinerary?.legs.some((leg) => leg.mode === 'SUBWAY');
    const sourceCopy = `${hasBus ? 'Bus legs show LTA real-time arrivals. ' : ''}${hasMrt ? 'MRT times are currently schedule-based.' : ''}`;
    return `<div class="route-panel">${brand()}<div class="route-header"><div><div class="route-kicker">Saved commute</div><h1>Ready when you are.</h1></div><button class="route-link compact" data-route-action="edit">Edit</button></div>${journey()}${card()}<section class="timing-card"><div class="timing-heading"><div><div class="route-card-label">Timing sources</div><h2>Bus live · MRT scheduled</h2></div><span class="live-state">LTA</span></div><p>${escapeHtml(sourceCopy || 'Live timing appears with the calculated route.')}</p></section><div class="route-actions"><button class="route-primary" data-route-action="refresh">Refresh route + timings</button><button class="route-link" data-route-action="bus">Open bus arrivals</button><button class="route-link" data-route-action="clear">Remove saved commute</button></div></div>`;
  }

  function viewer() {
    const itinerary = routeState.data;
    return `<div class="route-viewer"><div class="picker-topbar"><button class="picker-back" data-route-action="close-viewer">‹</button><div><div class="route-kicker">${escapeHtml(timeLabel(saved.departureTime))}</div><div class="picker-title">${escapeHtml(saved.origin)} → ${escapeHtml(saved.destination)}</div></div></div><div class="route-viewer-map-wrap"><div id="route-viewer-map" class="route-viewer-map"></div><div id="viewer-fallback" class="map-fallback" hidden><strong>Map unavailable</strong><span>The step-by-step route is still shown below.</span></div></div><div class="route-viewer-sheet"><div class="route-viewer-summary"><div><span class="route-card-label">Journey</span><strong>${itinerary ? durationLabel(itinerary.duration) : '—'}</strong></div><span>${itinerary ? itinerary.transfers : 0} transfer${itinerary?.transfers === 1 ? '' : 's'}</span></div>${itinerary ? timeline(itinerary) : ''}</div></div>`;
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
      map = new mapboxgl.Map({ container, style: 'mapbox://styles/mapbox/streets-v12', center: [saved.originPoint.lng, saved.originPoint.lat], zoom: 12.5, dragRotate: false, touchPitch: false });
      map.touchZoomRotate.disableRotation();
      map.on('load', () => {
        if (features.length) {
          map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features } });
          map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'WALK'], paint: { 'line-color': '#777', 'line-width': 4, 'line-dasharray': [1, 1.5] } });
          map.addLayer({ id: 'route-bus', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'BUS'], paint: { 'line-color': '#1f7a4d', 'line-width': 6 } });
          map.addLayer({ id: 'route-mrt', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'SUBWAY'], paint: { 'line-color': '#222', 'line-width': 7 } });
          const bounds = new mapboxgl.LngLatBounds();
          features.forEach((feature) => feature.geometry.coordinates.forEach((coordinate) => bounds.extend(coordinate)));
          if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 48, duration: 0 });
        }
        new mapboxgl.Marker({ color: '#16181A' }).setLngLat([saved.originPoint.lng, saved.originPoint.lat]).addTo(map);
        new mapboxgl.Marker({ color: '#D42E12' }).setLngLat([saved.destinationPoint.lng, saved.destinationPoint.lat]).addTo(map);
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
    return { index, mode, routeName, lineName, label: mode === 'WALK' ? `Walk ${distanceLabel(leg.distance)}` : `${mode === 'SUBWAY' ? 'MRT' : mode}${routeName ? ` ${routeName}` : ''}`, detail: [placeName(from), placeName(to)].filter(Boolean).join(' → '), fromName: placeName(from), toName: placeName(to), fromId: placeId(from), toId: placeId(to), stopCode: stopCode(from), departureTime: toTimestamp(leg.startTime || leg.departureTime || from.departure || from.departureTime), arrivalTime: toTimestamp(leg.endTime || leg.arrivalTime || to.arrival || to.arrivalTime), duration: Number(leg.duration) || 0, distance: Number(leg.distance) || 0, stopCount: mode === 'WALK' ? null : stopCount(leg), liveStatus: mode === 'BUS' ? 'loading' : null, geometry: String(leg.legGeometry?.points || leg.geometry || '') };
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

  async function routeData() {
    routeState = { status: 'loading', data: null, error: '' }; render();
    const start = `${saved.originPoint.lat},${saved.originPoint.lng}`; const end = `${saved.destinationPoint.lat},${saved.destinationPoint.lng}`; const time = saved.departureTime ? `&time=${encodeURIComponent(saved.departureTime)}` : '';
    try {
      const response = await fetch(`/api/route?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${time}`); const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Routing unavailable.'); const itinerary = normalizeRoute(data); if (!itinerary) throw new Error('No public-transport itinerary.');
      routeState = { status: 'ready', data: itinerary, error: '' }; render(); await liveBus(itinerary); if (routeState.data === itinerary) render();
    } catch (error) { routeState = { status: 'error', data: null, error: error.message || 'Routing unavailable.' }; render(); }
  }

  function bind() {
    shell.querySelectorAll('[data-route-pick]').forEach((button) => { button.onclick = () => openPicker(button.dataset.routePick); });
    const input = document.getElementById('picker-manual-input'); const useButton = shell.querySelector('[data-route-action="manual"]');
    if (input) { input.oninput = () => { useButton.disabled = !input.value.trim(); }; input.onkeydown = (event) => { if (event.key === 'Enter') manualLocation(); }; }
    const timeInput = document.getElementById('route-time-input'); if (timeInput) timeInput.oninput = () => { draftState.departureTime = timeInput.value || '08:30'; };
    shell.querySelectorAll('[data-route-action]').forEach((button) => {
      button.onclick = () => {
        const action = button.dataset.routeAction;
        if (action === 'bus') { destroyMap(); shell.hidden = true; launcher.hidden = false; }
        else if (action === 'edit') { draftState = draft(saved); saved = null; routeState = { status: 'idle', data: null, error: '' }; render(); }
        else if (action === 'save') { if (draftState.origin && draftState.destination) { save({ id: 'route-1', ...draftState, updatedAt: new Date().toISOString() }); routeState = { status: 'idle', data: null, error: '' }; render(); } }
        else if (action === 'clear') { localStorage.removeItem(STORAGE_KEY); saved = null; draftState = draft(); routeState = { status: 'idle', data: null, error: '' }; render(); }
        else if (action === 'cancel') closePicker();
        else if (action === 'confirm') { draftState[pickerField] = mapPosition.label === 'Singapore' ? 'Pinned location' : mapPosition.label; draftState[`${pickerField}Point`] = { ...mapPosition.center }; closePicker(); }
        else if (action === 'manual') manualLocation();
        else if (action === 'locate') locate();
        else if (action === 'refresh') { routeState = { status: 'idle', data: null, error: '' }; render(); }
        else if (action === 'viewer' && routeState.data) { viewing = true; render(); }
        else if (action === 'close-viewer') { viewing = false; render(); }
      };
    });
  }

  launcher.onclick = () => { shell.hidden = false; launcher.hidden = true; render(); };
  document.body.append(shell, launcher);
  render();
})();
