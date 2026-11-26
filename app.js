import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { firebaseConfig } from "./config.js";

// Firebase is initialized but not used yet (no Auth, no Firestore in v1).
initializeApp(firebaseConfig);

// ---- Data source settings. Field names are checked on first run (see errors in the panel). ----
const SOURCES = {
  subway: {
    url: "https://data.ny.gov/resource/39hk-dx4f.json",
    limit: 2000,
    lat: "gtfs_latitude",
    lon: "gtfs_longitude",
    name: "stop_name",
  },
  crime: {
    url: "https://data.cityofnewyork.us/resource/5uac-w243.json",
    lat: "latitude",
    lon: "longitude",
    date: "cmplnt_fr_dt",
    offense: "ofns_desc",
    lookbackDays: 365,
    radiusM: 400,
  },
};
const SUBWAY_WALK_M = 1200; // roughly a 15-minute walk, straight-line for v1

const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");
const map = L.map("map").setView([40.7580, -73.9855], 13);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
const layers = { listing: L.layerGroup().addTo(map), subway: L.layerGroup().addTo(map) };

const saved = JSON.parse(localStorage.getItem("byaku.listings") || "[]");

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function geocode(address) {
  const q = encodeURIComponent(/new york|, ny/i.test(address) ? address : `${address}, New York, NY`);
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`);
  if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
  const [hit] = await res.json();
  if (!hit) throw new Error("Address not found. Try adding the borough or zip code.");
  return { lat: Number(hit.lat), lon: Number(hit.lon), display: hit.display_name };
}

async function loadSubway() {
  const cfg = SOURCES.subway;
  const res = await fetch(`${cfg.url}?$limit=${cfg.limit}`);
  if (!res.ok) throw new Error(`Subway data failed (${res.status})`);
  const rows = await res.json();
  if (rows[0] && !(cfg.lat in rows[0] && cfg.lon in rows[0])) {
    throw new Error(`Subway fields differ from config. Available: ${Object.keys(rows[0]).join(", ")}`);
  }
  return rows
    .filter((r) => r[cfg.lat] && r[cfg.lon])
    .map((r) => ({ name: r[cfg.name] || "Station", lat: Number(r[cfg.lat]), lon: Number(r[cfg.lon]) }));
}

async function crimeNearby(lat, lon) {
  const c = SOURCES.crime;
  const since = new Date(Date.now() - c.lookbackDays * 864e5).toISOString().slice(0, 10);
  const latDelta = c.radiusM / 111000, lonDelta = c.radiusM / (111000 * Math.cos((lat * Math.PI) / 180));
  const where = `${c.date} >= '${since}' AND ${c.lat} > ${lat - latDelta} AND ${c.lat} < ${lat + latDelta} AND ${c.lon} > ${lon - lonDelta} AND ${c.lon} < ${lon + lonDelta}`;
  const res = await fetch(`${c.url}?$select=${c.offense},${c.lat},${c.lon}&$limit=5000&$where=${encodeURIComponent(where)}`);
  if (!res.ok) throw new Error(`Crime data failed (${res.status})`);
  const rows = await res.json();
  const inRadius = rows.filter((r) => distanceM(lat, lon, Number(r[c.lat]), Number(r[c.lon])) <= c.radiusM);
  return { count: inRadius.length, lookbackDays: c.lookbackDays, radiusM: c.radiusM };
}

function renderListing(item) {
  const marker = L.marker([item.lat, item.lon]).addTo(layers.listing);
  marker.bindPopup(`<b>$${item.base_rent}</b> · ${item.unit_type}<br>${item.address}`);
  marker.on("click", () => showDetails(item));
}

async function showDetails(item) {
  detailsEl.innerHTML = `<div class="card"><b>${item.address}</b><br>$${item.base_rent} · ${item.unit_type}<br>
    <span class="muted">Loading neighborhood info…</span></div>`;
  const stations = (await loadSubway().catch((e) => { statusEl.innerHTML = `<span class="error">${e.message}</span>`; return []; }));
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
    <h4>Hospitals</h4><span class="muted">Not in v1 yet</span>
    <h4>Your spots</h4><span class="muted">Not in v1 yet</span></div>`;
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
    statusEl.innerHTML = `<span class="error">${err.message}</span>`;
  }
});

// Show subway stations on the map and restore saved listings.
loadSubway().then((stations) => {
  stations.forEach((s) => L.circleMarker([s.lat, s.lon], { radius: 3, color: "#0039a6" }).bindTooltip(s.name).addTo(layers.subway));
}).catch((e) => { statusEl.innerHTML = `<span class="error">${e.message}</span>`; });
saved.forEach(renderListing);
