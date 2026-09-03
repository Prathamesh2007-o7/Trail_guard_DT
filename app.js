const CONFIG = {
  minimumMovementMeters: 5,
  maxAccuracyMeters: 100,
  maxSpeedMps: 15,
  offTrailMeters: 40,
  gps: {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 15000
  }
};

const STORAGE_KEY = 'trailguard.hikes.v1';
const ACTIVE_KEY = 'trailguard.active.v1';

const state = {
  view: 'home',
  session: null,
  pending: null,
  selected: null,
  maps: {},
  layers: {},
  watchId: null,
  timer: null,
  follows: {
    live: true,
    backtrack: true
  }
};

const $ = (id) => document.getElementById(id);

const formatDistance = (meters) =>
  meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;

const formatDuration = (seconds) => {
  seconds = Math.max(0, Math.floor(seconds));
  const hrs = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const secs = String(seconds % 60).padStart(2, '0');
  return `${hrs}:${mins}:${secs}`;
};

const shortDuration = (seconds) =>
  seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
    : `${Math.max(1, Math.round(seconds / 60))} min`;

const gpsLabel = (accuracy) =>
  accuracy < 10 ? 'Excellent' : accuracy < 30 ? 'Good' : accuracy < 75 ? 'Weak' : 'Poor';

const pointLatLng = (p) => [p.latitude, p.longitude];

function haversine(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.longitude - a.longitude) * r) * Math.cos(b.latitude * r);
  const x =
    Math.cos(a.latitude * r) * Math.sin(b.latitude * r) -
    Math.sin(a.latitude * r) * Math.cos(b.latitude * r) * Math.cos((b.longitude - a.longitude) * r);

  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function compass(b) {
  return ['↑ N', '↗ NE', '→ E', '↘ SE', '↓ S', '↙ SW', '← W', '↖ NW'][Math.round(b / 45) % 8];
}

function totalDistance(points) {
  return points.slice(1).reduce((sum, p, i) => sum + haversine(points[i], p), 0);
}

function pointFromPosition(position) {
  const c = position.coords;
  return {
    latitude: c.latitude,
    longitude: c.longitude,
    timestamp: position.timestamp || Date.now(),
    accuracy: c.accuracy,
    altitude: c.altitude,
    speed: c.speed,
    heading: c.heading
  };
}

function getHikes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHikes(hikes) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(hikes));
}

function activeSeconds(s) {
  const endTime = s.endTime || Date.now();
  const pauseDuration = s.pausedMs + (s.pausedAt ? Date.now() - s.pausedAt : 0);
  return Math.floor((endTime - s.startTime - pauseDuration) / 1000);
}

function showView(name) {
  state.view = name;

  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(`${name}View`).classList.add('active');

  document
    .querySelectorAll('.nav-item')
    .forEach((b) => b.classList.toggle('active', b.dataset.nav === name));

  if (!['active', 'route', 'backtrack'].includes(name)) {
    stopTimer();
  }
}

function renderHome() {
  const hikes = getHikes();
  const distance = hikes.reduce((n, h) => n + h.distance, 0);

  $('totalHikes').textContent = hikes.length;
  $('totalDistance').textContent = (distance / 1000).toFixed(1);
  $('recentHikes').innerHTML = hikes.length
    ? hikes.slice(0, 3).map(hikeCard).join('')
    : '<div class="empty-state">No hikes recorded yet.<br>Start a hike to build your trail history.</div>';
}

function hikeCard(h) {
  const dateStr = new Date(h.startTime).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  return `
    <article class="hike-card">
      <div class="hike-card-top">
        <div>
          <h3>${escapeHtml(h.name || 'Trail hike')}</h3>
          <p>${dateStr}</p>
        </div>
        <span>⌁</span>
      </div>
      <div class="hike-metrics">
        <div>
          <strong>${formatDistance(h.distance)}</strong>
          <span>Distance</span>
        </div>
        <div>
          <strong>${shortDuration(h.duration)}</strong>
          <span>Duration</span>
        </div>
      </div>
      <div class="hike-actions">
        <button class="button secondary" data-view-hike="${h.id}">View</button>
        <button class="button primary" data-backtrack-hike="${h.id}">↩ Backtrack</button>
      </div>
    </article>
  `;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[c]));
}

function renderHistory() {
  const hikes = getHikes();
  $('historyList').innerHTML = hikes.length
    ? hikes.map(hikeCard).join('')
    : '<div class="empty-state">No saved hikes yet. Your completed hikes will appear here.</div>';
}

function ensureMap(name, id) {
  if (!state.maps[name]) {
    state.maps[name] = L.map(id, { zoomControl: false });
    L.control.zoom({ position: 'topright' }).addTo(state.maps[name]);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    }).addTo(state.maps[name]);
  }

  setTimeout(() => state.maps[name].invalidateSize(), 100);
  return state.maps[name];
}

function clearLayers(name) {
  if (state.layers[name]) {
    state.layers[name].forEach((l) => l.remove());
  }
  state.layers[name] = [];
}

function addLayer(name, layer) {
  (state.layers[name] ||= []).push(layer);
  return layer;
}

function markerIcon(text, cls) {
  const style =
    cls === 'you' ? 'background:#1f6244;color:#fff' : 'background:#fff;color:#173b2a';

  return L.divIcon({
    className: '',
    html: `<div style="${style};width:max-content;padding:5px 8px;border-radius:12px;font:800 10px/1.1 system-ui;box-shadow:0 3px 10px #17302640;white-space:nowrap">${text}</div>`,
    iconSize: [64, 30],
    iconAnchor: [32, 30]
  });
}

function pointAlong(points, t) {
  const total = totalDistance(points);

  if (!total || points.length < 2) {
    return {
      ...points[0],
      _bearing: points.length > 1 ? bearing(points[0], points[1]) : 0
    };
  }

  const target = total * t;
  let acc = 0;

  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1], points[i]);

    if (d && acc + d >= target) {
      const frac = (target - acc) / d;
      return {
        latitude: points[i - 1].latitude + (points[i].latitude - points[i - 1].latitude) * frac,
        longitude: points[i - 1].longitude + (points[i].longitude - points[i - 1].longitude) * frac,
        _bearing: bearing(points[i - 1], points[i])
      };
    }
    acc += d;
  }

  const a = points[points.length - 2] || points[0];
  const b = points[points.length - 1];
  return { ...b, _bearing: bearing(a, b) };
}

function chevronIcon(rotationDeg) {
  return L.divIcon({
    className: '',
    html: `<div class="route-chevron" style="transform:rotate(${rotationDeg}deg)">➤</div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

function drawLive() {
  const s = state.session;
  if (!s || !s.points.length) return;

  const map = ensureMap('live', 'liveMap');
  clearLayers('live');

  const points = s.points;
  const trail = addLayer(
    'live',
    L.polyline(points.map(pointLatLng), { color: '#287353', weight: 5, lineCap: 'round' }).addTo(map)
  );

  addLayer('live', L.marker(pointLatLng(points[0]), { icon: markerIcon('🏕 START', 'start') }).addTo(map));

  const last = points.at(-1);
  addLayer('live', L.marker(pointLatLng(last), { icon: markerIcon('● YOU', 'you') }).addTo(map));

  if (last.accuracy) {
    addLayer(
      'live',
      L.circle(pointLatLng(last), {
        radius: last.accuracy,
        color: '#2e7f5a',
        weight: 1,
        fillOpacity: 0.08
      }).addTo(map)
    );
  }

  if (state.follows.live) {
    map.setView(pointLatLng(last), Math.max(map.getZoom(), 16));
  } else if (points.length === 1) {
    map.fitBounds(trail.getBounds(), { padding: [45, 45], maxZoom: 16 });
  }
}

function updateLiveUi() {
  const s = state.session;
  if (!s) return;

  const last = s.points.at(-1);

  $('liveDistance').innerHTML = `${(s.distance / 1000).toFixed(2)} <small>km</small>`;
  $('liveTime').textContent = formatDuration(activeSeconds(s));
  $('liveGps').textContent = last ? gpsLabel(last.accuracy) : '—';
  $('liveStatus').textContent = s.paused ? 'Paused' : 'Recording';
  $('recordingStatus').textContent = s.paused ? 'PAUSED' : 'RECORDING';
  $('pauseButton').textContent = s.paused ? 'Resume' : 'Pause';
  $('liveCoordinates').textContent = last
    ? `${last.latitude.toFixed(5)}, ${last.longitude.toFixed(5)} · ±${Math.round(last.accuracy)} m`
    : 'Waiting for GPS…';
}

function startTimer() {
  stopTimer();
  state.timer = setInterval(updateLiveUi, 1000);
}

function stopTimer() {
  clearInterval(state.timer);
  state.timer = null;
}

function persistActive() {
  if (state.session) {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(state.session));
  }
}

function clearActive() {
  localStorage.removeItem(ACTIVE_KEY);
}

function validPoint(point, previous) {
  if (
    !Number.isFinite(point.latitude) ||
    !Number.isFinite(point.longitude) ||
    Math.abs(point.latitude) > 90 ||
    Math.abs(point.longitude) > 180 ||
    point.accuracy > CONFIG.maxAccuracyMeters
  ) {
    return false;
  }

  if (!previous) return true;

  const seconds = Math.max(1, (point.timestamp - previous.timestamp) / 1000);
  const distance = haversine(previous, point);

  return distance >= CONFIG.minimumMovementMeters && distance / seconds <= CONFIG.maxSpeedMps;
}

function receiveLocationUpdate(position) {
  const point = pointFromPosition(position);

  if (state.view === 'backtrack') {
    updateBacktrack(point);
    return;
  }

  const s = state.session;
  if (!s || s.paused) return;

  const previous = s.points.at(-1);
  if (!validPoint(point, previous)) return;

  s.points.push(point);
  if (previous) {
    s.distance += haversine(previous, point);
  }

  persistActive();
  drawLive();
  updateLiveUi();
}

function gpsError(error, initializing = false) {
  const messages = {
    1: 'Location permission was denied. Enable it in your browser settings to record a hike.',
    2: 'GPS is unavailable. Check your signal and try again.',
    3: 'GPS timed out. Move to an open area and try again.'
  };

  const message = messages[error.code] || 'Could not get your location.';

  if (initializing) {
    $('gpsMessage').textContent = message;
    $('gpsRetry').classList.remove('hidden');
  } else {
    showModal('GPS issue', message, [['OK', closeModal, 'primary']]);
  }
}

function requestInitialLocation() {
  showView('gps');
  $('gpsMessage').textContent = 'Keep TrailGuard open and allow location access.';
  $('gpsDetails').classList.add('hidden');
  $('gpsRetry').classList.add('hidden');

  if (!navigator.geolocation) {
    gpsError({ code: 2 }, true);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const p = pointFromPosition(pos);
      $('gpsDetails').innerHTML = `Accuracy: ±${Math.round(p.accuracy)} m<br>${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}`;
      $('gpsDetails').classList.remove('hidden');
      beginHike(p);
    },
    (err) => gpsError(err, true),
    CONFIG.gps
  );
}

function beginHike(firstPoint) {
  state.session = {
    id: crypto.randomUUID(),
    startTime: Date.now(),
    endTime: null,
    paused: false,
    pausedAt: null,
    pausedMs: 0,
    points: [firstPoint],
    distance: 0
  };

  persistActive();
  showView('active');
  state.follows.live = true;

  drawLive();
  updateLiveUi();
  startTimer();

  state.watchId = navigator.geolocation.watchPosition(
    receiveLocationUpdate,
    (err) => gpsError(err),
    CONFIG.gps
  );
}

function togglePause() {
  const s = state.session;
  if (!s) return;

  if (s.paused) {
    s.pausedMs += Date.now() - s.pausedAt;
    s.paused = false;
    s.pausedAt = null;
  } else {
    s.paused = true;
    s.pausedAt = Date.now();
  }

  persistActive();
  updateLiveUi();
}

function finishHike() {
  const s = state.session;
  if (!s) return;

  if (s.paused) {
    s.pausedMs += Date.now() - s.pausedAt;
    s.paused = false;
    s.pausedAt = null;
  }

  s.endTime = Date.now();
  s.duration = activeSeconds(s);
  s.averageSpeed = s.duration ? s.distance / s.duration : 0;
  state.pending = s;

  stopTracking();
  clearActive();
  showView('complete');

  const stats = [
    ['Distance', formatDistance(s.distance)],
    ['Duration', shortDuration(s.duration)],
    ['Average speed', `${(s.averageSpeed * 3.6).toFixed(1)} km/h`],
    ['GPS points', s.points.length],
    ['Start time', new Date(s.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })],
    ['End time', new Date(s.endTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })]
  ];

  $('completeStats').innerHTML = stats
    .map((x) => `<div class="complete-stat"><span>${x[0]}</span><strong>${x[1]}</strong></div>`)
    .join('');
}

function stopTracking() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  stopTimer();
  state.session = null;
}

function savePending() {
  if (!state.pending) return;

  const hikes = getHikes();
  hikes.unshift({
    ...state.pending,
    name: 'Trail hike',
    startCoordinate: state.pending.points[0],
    endCoordinate: state.pending.points.at(-1)
  });

  saveHikes(hikes);
  state.selected = hikes[0];
  state.pending = null;

  renderHome();
  renderHistory();
  showView('history');
}

function selectHike(id, backtrack = false) {
  state.selected = getHikes().find((h) => h.id === id);
  if (!state.selected) return;

  if (backtrack) {
    startBacktrack();
  } else {
    showRoute();
  }
}

function showRoute() {
  showView('route');
  const h = state.selected;

  $('routeName').textContent = (h.name || 'Trail hike').toUpperCase();
  $('routeStats').innerHTML = `
    <div><span>DISTANCE</span><strong>${formatDistance(h.distance)}</strong></div>
    <div><span>DURATION</span><strong>${shortDuration(h.duration)}</strong></div>
    <div><span>POINTS</span><strong>${h.points.length}</strong></div>
  `;

  const map = ensureMap('route', 'routeMap');
  clearLayers('route');

  const line = addLayer(
    'route',
    L.polyline(h.points.map(pointLatLng), { color: '#287353', weight: 5 }).addTo(map)
  );

  addLayer('route', L.marker(pointLatLng(h.points[0]), { icon: markerIcon('🏕 START', 'start') }).addTo(map));
  addLayer('route', L.marker(pointLatLng(h.points.at(-1)), { icon: markerIcon('END', 'end') }).addTo(map));

  map.fitBounds(line.getBounds(), { padding: [50, 50], maxZoom: 16 });
}

function nearestTrailPoint(current, points) {
  let best = { index: 0, distance: Infinity };
  points.forEach((p, i) => {
    const d = haversine(current, p);
    if (d < best.distance) {
      best = { index: i, distance: d };
    }
  });
  return best;
}

function startBacktrack() {
  if (!navigator.geolocation) {
    showModal('GPS unavailable', 'This browser cannot provide a current location.', [
      ['OK', closeModal, 'primary']
    ]);
    return;
  }

  showView('backtrack');
  const h = state.selected;
  const map = ensureMap('backtrack', 'backtrackMap');
  clearLayers('backtrack');

  const line = addLayer(
    'backtrack',
    L.polyline(h.points.map(pointLatLng), { color: '#5d9e82', weight: 5, opacity: 0.7 }).addTo(map)
  );

  addLayer('backtrack', L.marker(pointLatLng(h.points[0]), { icon: markerIcon('🏕 START', 'start') }).addTo(map));

  map.fitBounds(line.getBounds(), { padding: [60, 60], maxZoom: 16 });
  state.follows.backtrack = true;

  state.watchId = navigator.geolocation.watchPosition(
    receiveLocationUpdate,
    (err) => gpsError(err),
    CONFIG.gps
  );
}

function updateBacktrack(current) {
  const h = state.selected;
  if (!h) return;

  const near = nearestTrailPoint(current, h.points);
  const remaining = h.points.slice(0, near.index + 1).reverse();
  const remainingDistance = totalDistance(remaining) + near.distance;
  const next = h.points[Math.max(0, near.index - 1)];
  const b = bearing(current, next);

  $('distanceToStart').textContent = formatDistance(remainingDistance);
  $('distanceFromTrail').textContent = formatDistance(near.distance);
  $('directionArrow').textContent = compass(b).split(' ')[0];
  $('directionText').textContent = compass(b);
  $('backtrackStatus').textContent = `Head ${compass(b).replace(/[↑↗→↘↓↙←↖] /, '')} to return toward the start.`;

  const off = near.distance > CONFIG.offTrailMeters;
  $('trailAlert').className = `trail-alert ${off ? 'warning' : 'good'}`;
  $('trailAlert').innerHTML = off
    ? `<strong>⚠ Possible trail deviation detected</strong><span>You are approximately ${Math.round(near.distance)} m from your recorded route.</span>`
    : `<strong>● Back on trail</strong><span>Following your recorded route toward the start.</span>`;

  const map = ensureMap('backtrack', 'backtrackMap');

  if (state.layers.backtrackYou) {
    state.layers.backtrackYou.remove();
  }
  state.layers.backtrackYou = L.marker(pointLatLng(current), { icon: markerIcon('● YOU', 'you') }).addTo(map);

  // Google-Maps-style guidance line: from your live position, back along the recorded trail to the start.
  const guideColor = off ? '#e3822f' : '#2c7bf2';
  const guideLine = [current, ...remaining];

  if (state.layers.backtrackGuide) {
    state.layers.backtrackGuide.remove();
  }
  if (guideLine.length > 1) {
    state.layers.backtrackGuide = L.polyline(guideLine.map(pointLatLng), {
      color: guideColor,
      weight: 7,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map);
  }

  if (state.layers.backtrackArrows) {
    state.layers.backtrackArrows.forEach((m) => m.remove());
  }
  state.layers.backtrackArrows =
    guideLine.length > 1
      ? [0.15, 0.38, 0.62, 0.85].map((t) => {
          const p = pointAlong(guideLine, t);
          return L.marker(pointLatLng(p), {
            icon: chevronIcon(p._bearing - 90),
            interactive: false,
            keyboard: false
          }).addTo(map);
        })
      : [];

  if (state.follows.backtrack) {
    map.setView(pointLatLng(current), Math.max(map.getZoom(), 16));
  }
}

function endBacktrack() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  showRoute();
}

function deleteSelected() {
  const h = state.selected;
  showModal(
    'Delete this hike?',
    `“${h.name || 'Trail hike'}” will be permanently removed from this device.`,
    [
      ['Cancel', closeModal, 'secondary'],
      [
        'Delete',
        () => {
          saveHikes(getHikes().filter((x) => x.id !== h.id));
          closeModal();
          renderHome();
          renderHistory();
          showView('history');
        },
        'danger'
      ]
    ]
  );
}

function showModal(title, text, actions) {
  $('modalTitle').textContent = title;
  $('modalText').textContent = text;
  $('modalActions').innerHTML = '';

  actions.forEach(([label, fn, kind]) => {
    const b = document.createElement('button');
    b.className =
      kind === 'danger' ? 'button danger' : kind === 'primary' ? 'button primary' : 'button secondary';
    b.textContent = label;
    b.onclick = fn;
    $('modalActions').appendChild(b);
  });

  $('modal').classList.remove('hidden');
}
