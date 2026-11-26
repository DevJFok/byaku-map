import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { firebaseConfig } from "./config.js";

// Firebase is initialized but not used yet (no Auth, no Firestore in this version).
initializeApp(firebaseConfig);

// ---- Data sources. Field names are checked on load; mismatches show in the panel. ----
const SOURCES = {
  lines: {
    url: "https://data.ny.gov/resource/s692-irgq.json", // MTA Subway Service Lines
    limit: 500,
    routeFields: ["service", "route_id", "rt_symbol", "route_symbol"],
    geomFields: ["geometry", "the_geom", "shape"],
  },
  stations: {
    url: "https://data.ny.gov/resource/39hk-dx4f.json", // MTA Subway Stations
    limit: 2000,
    lat: "gtfs_latitude",
    lon: "gtfs_longitude",
    name: "stop_name",
  },
  crime: {
    url: "https://data.cityofnewyork.us/resource/5uac-w243.json", // NYPD Complaint Data (current + historic)
    limit: 50000,
    lat: "latitude",
    lon: "longitude",
    date: "cmplnt_fr_dt",
    offense: "ofns_desc",
    severity: "law_cat_cd", // FELONY / MISDEMEANOR / VIOLATION
    lookbackDays: 365,
    radiusM: 400, // radius for the apartment's own summary
  },
};
const SUBWAY_WALK_M = 1200; // roughly a 15-minute walk, straight-line for now

// Official MTA route colors.
const ROUTE_COLORS = {
  "1": "#EE352E", "2": "#EE352E", "3": "#EE352E",
  "4": "#00933C", "5": "#00933C", "6": "#00933C",
  "7": "#B933AD",
  "A": "#0039A6", "C": "#0039A6", "E": "#0039A6",
  "B": "#FF6319", "D": "#FF6319", "F": "#FF6319", "M": "#FF6319",
  "G": "#6CBE45",
  "J": "#996633", "Z": "#996633",
  "L": "#A7A9AC",
  "N": "#FCCC0A", "Q": "#FCCC0A", "R": "#FCCC0A", "W": "#FCCC0A",
  "S": "#808183", "SI": "#0039A6",
};
const SEVERITY_WEIGHT = { FELONY: 1.0, MISDEMEANOR: 0.6, VIOLATION: 0.3 };

const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");

// Basemap: OpenStreetMap, free, no billing needed.
// preferCanvas draws the overlays on the map itself, so they stay locked to the
// basemap while dragging (SVG overlays could drift on some browsers, including iPhone Safari).
// Canvas overlays and zoom animation don't stay in step: during the zoom
// animation the basemap scales while the overlays jump. Turning off the zoom
// animation keeps the blocks and lines locked to the basemap.
const map = L.map("map", { zoomAnimation: false }).setView([40.7580, -73.9855], 13);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const listingLayer = L.layerGroup().addTo(map);
const subwayLayer = L.layerGroup();
const crimeLayer = L.layerGroup();
// Crime blocks sit in their own pane under the subway lines, so lines and stations stay clickable.
map.createPane("crimePane");
map.getPane("crimePane").style.zIndex = 350;
// Crime blocks: 2x2 Manhattan-style city blocks per cell (approximate sizes).
// A short Manhattan block is about 80 m north-south, a long one about 275 m east-west.
const CELL_M = { ns: 160, ew: 550 };
const CRIME_MIN_ZOOM = 15; // below this the view is too wide to show blocks cleanly
const CRIME_ORIGIN = [40.70, -74.02]; // fixed grid origin so blocks stay put while panning
const stationMarkers = [];

let stationsCache = null;
const saved = JSON.parse(localStorage.getItem("byaku.listings") || "[]");

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function showError(msg) {
  statusEl.innerHTML = `<span class="error">${msg}</span>`;
}

function sinceDate(days) {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

async function geocode(address) {
  const q = encodeURIComponent(/new york|, ny/i.test(address) ? address : `${address}, New York, NY`);
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`);
  if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
  const [hit] = await res.json();
  if (!hit) throw new Error("Address not found. Try adding the borough or zip code.");
  return { lat: Number(hit.lat), lon: Number(hit.lon), display: hit.display_name };
}

async function loadStations() {
  if (stationsCache) return stationsCache;
  const cfg = SOURCES.stations;
  const res = await fetch(`${cfg.url}?$limit=${cfg.limit}`);
  if (!res.ok) throw new Error(`Station data failed (${res.status})`);
  const rows = await res.json();
  if (rows[0] && !(cfg.lat in rows[0] && cfg.lon in rows[0])) {
    throw new Error(`Station fields differ from config. Available: ${Object.keys(rows[0]).join(", ")}`);
  }
  stationsCache = rows
    .filter((r) => r[cfg.lat] && r[cfg.lon])
    .map((r) => ({ name: r[cfg.name] || "Station", lat: Number(r[cfg.lat]), lon: Number(r[cfg.lon]) }));
  return stationsCache;
}

function esc(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Popup on any overlay click: the clicked item's info plus the closest subway station.
async function showOverlayPopup(latlng, infoHtml) {
  let stationLine = "";
  try {
    const stations = await loadStations();
    let best = null;
    for (const s of stations) {
      const d = distanceM(latlng.lat, latlng.lng, s.lat, s.lon);
      if (!best || d < best.d) best = { ...s, d };
    }
    if (best) {
      const walkMin = Math.max(1, Math.round(best.d / 80)); // about 80 m per minute on foot
      stationLine = `Closest subway station: <b>${esc(best.name)}</b><br>${Math.round(best.d)} m away (about ${walkMin} min walk)`;
    }
  } catch (err) {
    stationLine = "Subway station data unavailable.";
  }
  L.popup({ maxWidth: 280 }).setLatLng(latlng).setContent(`${infoHtml}<br>${stationLine}`).openOn(map);
}

async function refreshSubwayOverlay() {
  subwayLayer.clearLayers();
  statusEl.textContent = "Loading subway lines…";

  // 1) Route lines, colored by route.
  const lineCfg = SOURCES.lines;
  const res = await fetch(`${lineCfg.url}?$limit=${lineCfg.limit}`);
  if (!res.ok) throw new Error(`Subway line data failed (${res.status})`);
  const rows = await res.json();
  if (!rows.length) throw new Error("Subway line data returned no rows.");
  const routeField = lineCfg.routeFields.find((f) => f in rows[0]);
  const geomField = lineCfg.geomFields.find((f) => f in rows[0]);
  if (!routeField || !geomField) {
    throw new Error(`Subway line fields differ from config. Available: ${Object.keys(rows[0]).join(", ")}`);
  }
  let lineCount = 0;
  rows.forEach((r) => {
    const route = String(r[routeField] || "").trim().toUpperCase();
    const geom = r[geomField];
    if (!geom || !geom.coordinates) return;
    const parts = geom.type === "MultiLineString" ? geom.coordinates : [geom.coordinates];
    parts.forEach((part) => {
      L.polyline(part.map(([lon, lat]) => [lat, lon]), {
        color: ROUTE_COLORS[route] || "#555555",
        weight: 4,
        opacity: 0.9,
      }).bindTooltip(`${route} train`)
        .on("click", (e) => showOverlayPopup(e.latlng, `<b>${esc(route)} train</b>`))
        .addTo(subwayLayer);
      lineCount++;
    });
  });

  // 2) Stations on top, so shared stations (transfers) stand out.
  const stations = await loadStations();
  stationMarkers.length = 0;
  stations.forEach((s) => {
    const m = L.circleMarker([s.lat, s.lon], { radius: 4, color: "#000000", weight: 1, fillColor: "#FFFFFF", fillOpacity: 1 })
      .bindTooltip(s.name, { direction: "right", offset: [6, 0] })
      .on("click", (e) => showOverlayPopup(e.latlng, `<b>${esc(s.name)}</b> (subway station)`))
      .addTo(subwayLayer);
    stationMarkers.push(m);
  });
  updateStationLabels();
  statusEl.textContent = `Showing ${lineCount} subway route segments and ${stations.length} stations.`;
}

function blockColor(t) {
  // t from 0 (lowest) to 1 (highest): yellow to red.
  return `rgb(255, ${Math.round(255 * (1 - t))}, 0)`;
}

// Crime blocks are precomputed (see scripts/build_blocks.py) and loaded once.
let crimeData = null;
// Share of blocks with a strictly higher score, i.e. how much safer this block is than the rest.
function percentSafer(score, sortedScores) {
  let lo = 0, hi = sortedScores.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedScores[mid] <= score) lo = mid + 1; else hi = mid; }
  const higher = sortedScores.length - lo;
  return Math.round((higher / sortedScores.length) * 100);
}

async function refreshCrimeOverlay() {
  crimeLayer.clearLayers();
  statusEl.textContent = "Loading crime blocks…";
  if (!crimeData) {
    const res = await fetch("data/blocks-manhattan.geojson");
    if (!res.ok) throw new Error(`Crime blocks not available (${res.status}). Run the build-crime-blocks workflow on GitHub.`);
    crimeData = await res.json();
  }
  const max = crimeData.maxScore || 1;
  const sorted = crimeData.features.map((f) => f.properties.score).sort((a, b) => a - b);
  L.geoJSON(crimeData.features, {
    pane: "crimePane",
    style: (f) => ({ color: "#ffffff", weight: 0.5, fillColor: blockColor(f.properties.score / max), fillOpacity: 0.5 }),
    onEachFeature: (f, layer) => {
      const p = f.properties;
      layer.bindTooltip(`${p.count} complaints in the last ${crimeData.lookbackDays} days`);
      layer.on("click", (e) => {
        const pct = percentSafer(p.score, sorted);
        const info = `<b>Crime block</b><br>${p.count} complaints in the last ${crimeData.lookbackDays} days<br>` +
          `Safer than <b>${pct}%</b> of Manhattan blocks`;
        showOverlayPopup(e.latlng, info);
      });
    },
  }).addTo(crimeLayer);
  statusEl.textContent = `Crime blocks cover the last ${crimeData.lookbackDays} days (updated ${crimeData.generated.slice(0, 10)}). Red is more severe.`;
}

// Station names stay on the map once zoomed in; otherwise they show on hover.
function updateStationLabels() {
  const show = map.hasLayer(subwayLayer) && map.getZoom() >= 15;
  stationMarkers.forEach((m) => (show ? m.openTooltip() : m.closeTooltip()));
}

// Keep the map's size in sync when the side panel is shown or hidden.
window.addEventListener("resize", () => map.invalidateSize());
map.on("zoomend", () => updateStationLabels());

// ---- Hospitals (precomputed, see scripts/build_blocks.py) ----
const hospitalLayer = L.layerGroup();
let hospitalsLoaded = false;
async function refreshHospitalOverlay() {
  statusEl.textContent = "Loading hospitals…";
  if (!hospitalsLoaded) {
    const res = await fetch("data/hospitals-manhattan.geojson");
    if (!res.ok) throw new Error(`Hospital data not available (${res.status}). Run the build-crime-blocks workflow on GitHub.`);
    const data = await res.json();
    L.geoJSON(data.features, {
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 6, color: "#ffffff", weight: 2, fillColor: "#d32f2f", fillOpacity: 1 }),
      onEachFeature: (f, layer) => layer
        .bindTooltip(`${f.properties.name} (hospital)`)
        .on("click", (e) => showOverlayPopup(e.latlng, `<b>${esc(f.properties.name)}</b> (hospital)`)),
    }).addTo(hospitalLayer);
    hospitalsLoaded = true;
  }
  statusEl.textContent = "Hospitals shown as red dots.";
}

document.getElementById("layer-hospitals").addEventListener("change", async (e) => {
  if (e.target.checked) {
    hospitalLayer.addTo(map);
    try { await refreshHospitalOverlay(); } catch (err) { showError(err.message); }
  } else {
    map.removeLayer(hospitalLayer);
    statusEl.textContent = "";
  }
});

// ---- Layer toggles ----
document.getElementById("layer-subway").addEventListener("change", async (e) => {
  if (e.target.checked) {
    subwayLayer.addTo(map);
    try { await refreshSubwayOverlay(); } catch (err) { showError(err.message); }
  } else {
    map.removeLayer(subwayLayer);
    statusEl.textContent = "";
  }
});

document.getElementById("layer-crime").addEventListener("change", async (e) => {
  if (e.target.checked) {
    crimeLayer.addTo(map);
    try { await refreshCrimeOverlay(); } catch (err) { showError(err.message); }
  } else {
    map.removeLayer(crimeLayer);
    statusEl.textContent = "";
  }
});


// ---- Apartments ----
function renderListing(item) {
  const marker = L.marker([item.lat, item.lon]).addTo(listingLayer);
  marker.bindPopup(`<b>$${item.base_rent}</b> · ${item.unit_type}<br>${item.address}`);
  marker.on("click", () => showDetails(item));
}

async function crimeNearby(lat, lon) {
  const c = SOURCES.crime;
  const latDelta = c.radiusM / 111000, lonDelta = c.radiusM / (111000 * Math.cos((lat * Math.PI) / 180));
  const where = `${c.date} >= '${sinceDate(c.lookbackDays)}' AND ${c.lat} >= ${lat - latDelta} AND ${c.lat} <= ${lat + latDelta} AND ${c.lon} >= ${lon - lonDelta} AND ${c.lon} <= ${lon + lonDelta}`;
  const res = await fetch(`${c.url}?$select=${c.lat},${c.lon}&$limit=${c.limit}&$where=${encodeURIComponent(where)}`);
  if (!res.ok) throw new Error(`Crime data failed (${res.status})`);
  const rows = await res.json();
  const count = rows.filter((r) => distanceM(lat, lon, Number(r[c.lat]), Number(r[c.lon])) <= c.radiusM).length;
  return { count, lookbackDays: c.lookbackDays, radiusM: c.radiusM };
}

async function showDetails(item) {
  detailsEl.innerHTML = `<div class="card"><b>${item.address}</b><br>$${item.base_rent} · ${item.unit_type}<br>
    <span class="muted">Loading neighborhood info…</span></div>`;
  const stations = await loadStations().catch((e) => { showError(e.message); return []; });
  const near = stations
    .map((s) => ({ ...s, d: distanceM(item.lat, item.lon, s.lat, s.lon) }))
    .filter((s) => s.d <= SUBWAY_WALK_M)
    .sort((a, b) => a.d - b.d);
  const crime = await crimeNearby(item.lat, item.lon).catch((e) => ({ error: e.message }));
  const crimeText = crime.error
    ? `<span class="error">${crime.error}</span>`
    : `${crime.count} reported complaints within ${crime.radiusM} m over the last ${crime.lookbackDays} days`;
  const subwayText = near.length
    ? near.slice(0, 5).map((s) => `${s.name} (${Math.round(s.d)} m)`).join("<br>")
    : "No subway station within about a 15-minute walk";
  detailsEl.innerHTML = `<div class="card"><b>${item.address}</b><br>$${item.base_rent} · ${item.unit_type}
    <h4>Subway</h4>${subwayText}
    <h4>Crime</h4>${crimeText}
    <h4>Hospitals</h4><span class="muted">Not yet</span>
    <h4>Your spots</h4><span class="muted">Not yet</span></div>`;
}

document.getElementById("listing-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  statusEl.textContent = "Finding address…";
  try {
    const rent = Number(f.base_rent.value);
    if (rent > 5500) throw new Error("Over the $5,500 base rent limit.");
    const geo = await geocode(f.address.value.trim());
    const item = {
      address: geo.display,
      unit_type: f.unit_type.value,
      base_rent: rent,
      source_url: f.source_url.value.trim() || null, // stored as text only; never fetched
      lat: geo.lat,
      lon: geo.lon,
    };
    saved.push(item);
    localStorage.setItem("byaku.listings", JSON.stringify(saved));
    renderListing(item);
    map.setView([item.lat, item.lon], 15);
    statusEl.textContent = "Added.";
    showDetails(item);
    f.reset();
  } catch (err) {
    showError(err.message);
  }
});

saved.forEach(renderListing);

// ---- My Google Maps lists (from a Takeout upload; see README) ----
const LIST_STORE = "byaku.mapLists";
const LIST_COLORS = ["#1565c0", "#6a1b9a", "#2e7d32", "#ef6c00", "#00838f", "#ad1457", "#5d4037"];
const listLayer = L.layerGroup().addTo(map);
let mapLists = JSON.parse(localStorage.getItem(LIST_STORE) || "{}"); // name -> { color, places: [{name, lat, lon, address}] }
const hiddenLists = new Set();

// Pull coordinates out of a Google Maps place URL (the !3d/!4d pair or the @lat,lon form).
function coordsFromUrl(url) {
  const m = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(url || "") || /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url || "");
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}

// Small CSV parser that handles quoted fields with commas and line breaks.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Returns { places, skipped } for one uploaded Takeout file.
function readListFile(fileName, text) {
  const places = [];
  let skipped = 0;
  if (/\.json$/i.test(fileName) || text.trimStart().startsWith("{")) {
    const data = JSON.parse(text);
    (data.features || []).forEach((f) => {
      const [lon, lat] = (f.geometry && f.geometry.coordinates) || [];
      const loc = f.properties && (f.properties.location || f.properties.Location) || {};
      if (typeof lat !== "number" || typeof lon !== "number") { skipped++; return; }
      places.push({ name: loc["Business Name"] || f.properties.Title || "Saved place", lat, lon, address: loc.Address || "" });
    });
  } else {
    const [header, ...rows] = parseCsv(text);
    const col = (n) => header.indexOf(n);
    const iTitle = col("Title"), iUrl = col("URL"), iNote = col("Note");
    rows.forEach((r) => {
      if (!r.length || !r[iUrl]) return;
      const c = coordsFromUrl(r[iUrl]);
      if (!c) { skipped++; return; }
      places.push({ name: r[iTitle] || "Saved place", lat: c.lat, lon: c.lon, address: r[iNote] || "" });
    });
  }
  return { places, skipped };
}

function saveLists() {
  localStorage.setItem(LIST_STORE, JSON.stringify(mapLists));
}

function renderListToggles() {
  const box = document.getElementById("list-toggles");
  box.innerHTML = "";
  Object.keys(mapLists).forEach((name) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !hiddenLists.has(name);
    cb.addEventListener("change", () => {
      cb.checked ? hiddenLists.delete(name) : hiddenLists.add(name);
      drawLists();
    });
    const swatch = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${mapLists[name].color};margin:0 4px"></span>`;
    label.append(cb);
    label.insertAdjacentHTML("beforeend", `${swatch}${esc(name)} (${mapLists[name].places.length})`);
    box.append(label);
  });
}

function drawLists() {
  listLayer.clearLayers();
  Object.entries(mapLists).forEach(([name, list]) => {
    if (hiddenLists.has(name)) return;
    list.places.forEach((p) => {
      L.circleMarker([p.lat, p.lon], { radius: 6, color: "#ffffff", weight: 2, fillColor: list.color, fillOpacity: 1 })
        .bindTooltip(esc(p.name))
        .on("click", (e) => showOverlayPopup(e.latlng,
          `<b>${esc(p.name)}</b><br>On list: ${esc(name)}${p.address ? `<br>${esc(p.address)}` : ""}`))
        .addTo(listLayer);
    });
  });
}

document.getElementById("list-files").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  const notes = [];
  for (const file of files) {
    const listName = file.name.replace(/\.(json|csv)$/i, "");
    try {
      const { places, skipped } = readListFile(file.name, await file.text());
      const color = mapLists[listName]?.color || LIST_COLORS[Object.keys(mapLists).length % LIST_COLORS.length];
      mapLists[listName] = { color, places };
      hiddenLists.delete(listName);
      notes.push(`"${listName}": ${places.length} placed${skipped ? `, ${skipped} skipped (no coordinates; short links can't be placed)` : ""}`);
    } catch (err) {
      notes.push(`"${file.name}" could not be read: ${err.message}`);
    }
  }
  saveLists();
  renderListToggles();
  drawLists();
  statusEl.textContent = notes.join(". ") + ".";
  e.target.value = "";
});

document.getElementById("list-clear").addEventListener("click", () => {
  mapLists = {};
  hiddenLists.clear();
  saveLists();
  renderListToggles();
  drawLists();
  statusEl.textContent = "Imported lists removed.";
});

renderListToggles();
drawLists();
