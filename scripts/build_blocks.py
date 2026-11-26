#!/usr/bin/env python3
"""Build Manhattan city-block shapes from OpenStreetMap roads, then add up
recent NYPD complaints per block. Writes data/blocks-manhattan.geojson.

Run by the GitHub Actions workflow "build-crime-blocks" (monthly, or on demand).
Data: OpenStreetMap (ODbL) and NYPD Complaint Data (NYC Open Data).
"""
import datetime
import json
import math
import os
import urllib.parse
import urllib.request

from shapely.geometry import LineString, Point
from shapely.ops import polygonize, unary_union
from shapely.strtree import STRtree

# Manhattan bounding box: south, west, north, east.
BBOX = (40.699, -74.022, 40.882, -73.906)
# Public Overpass servers; tried in order until one answers.
OVERPASS_SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
NYPD = "https://data.cityofnewyork.us/resource/5uac-w243.json"
OUT = "data/blocks-manhattan.geojson"
LOOKBACK_DAYS = 365
SEVERITY = {"FELONY": 1.0, "MISDEMEANOR": 0.6, "VIOLATION": 0.3}
ROAD_TYPES = "primary|secondary|tertiary|residential|unclassified|living_street|trunk|motorway"
MIN_BLOCK_M2, MAX_BLOCK_M2 = 2000, 120000  # keeps city blocks, drops parks and tiny slivers

LAT0 = 40.78
M_PER_DEG_LON = math.cos(math.radians(LAT0)) * 111320
M_PER_DEG_LAT = 110574


def to_xy(lon, lat):
    return (lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT)


def to_lonlat(x, y):
    return (x / M_PER_DEG_LON, y / M_PER_DEG_LAT)


def fetch_roads():
    s, w, n, e = BBOX
    query = (
        f'[out:json][timeout:300];'
        f'way["highway"~"^({ROAD_TYPES})$"]({s},{w},{n},{e});'
        f'out geom;'
    )
    body = urllib.parse.urlencode({"data": query}).encode()
    last_error = None
    for server in OVERPASS_SERVERS:
        try:
            req = urllib.request.Request(server, data=body, headers={"User-Agent": "byaku-map-build/1.0"})
            with urllib.request.urlopen(req, timeout=400) as resp:
                print(f"roads from {server}")
                return json.load(resp)["elements"]
        except OSError as err:  # includes URLError and timeouts
            print(f"{server} failed: {err}")
            last_error = err
    raise RuntimeError(f"All Overpass servers failed: {last_error}")


def build_blocks(elements):
    lines = []
    for way in elements:
        geom = way.get("geometry")
        if geom and len(geom) >= 2:
            lines.append(LineString([to_xy(p["lon"], p["lat"]) for p in geom]))
    faces = list(polygonize(unary_union(lines)))
    blocks = [p for p in faces if MIN_BLOCK_M2 <= p.area <= MAX_BLOCK_M2]
    print(f"roads: {len(lines)}, faces: {len(faces)}, blocks kept: {len(blocks)}")
    return blocks


def fetch_crime():
    since = (datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    s, w, n, e = BBOX
    where = (
        f"cmplnt_fr_dt >= '{since}' AND latitude >= {s} AND latitude <= {n} "
        f"AND longitude >= {w} AND longitude <= {e}"
    )
    rows, offset, page_size = [], 0, 50000
    while True:
        params = {
            "$select": "latitude,longitude,law_cat_cd",
            "$where": where,
            "$limit": page_size,
            "$offset": offset,
            "$order": ":id",
        }
        with urllib.request.urlopen(f"{NYPD}?{urllib.parse.urlencode(params)}", timeout=300) as resp:
            page = json.load(resp)
        rows.extend(page)
        print(f"complaints fetched: {len(rows)}")
        if len(page) < page_size:
            return rows
        offset += page_size


def score_blocks(blocks, complaints):
    tree = STRtree(blocks)
    scores = [0.0] * len(blocks)
    counts = [0] * len(blocks)
    for row in complaints:
        try:
            lat, lon = float(row["latitude"]), float(row["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        pt = Point(to_xy(lon, lat))
        for idx in tree.query(pt):
            if blocks[idx].contains(pt):
                scores[idx] += SEVERITY.get(str(row.get("law_cat_cd", "")).upper(), 0.5)
                counts[idx] += 1
                break
    return scores, counts


def to_geojson(blocks, scores, counts):
    features = []
    for block, score, count in zip(blocks, scores, counts):
        simple = block.simplify(0.5)
        coords = [[round(x, 6), round(y, 6)] for x, y in (to_lonlat(*pt) for pt in simple.exterior.coords)]
        features.append({
            "type": "Feature",
            "properties": {"score": round(score, 2), "count": count},
            "geometry": {"type": "Polygon", "coordinates": [coords]},
        })
    return {
        "type": "FeatureCollection",
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "lookbackDays": LOOKBACK_DAYS,
        "maxScore": max(scores) if scores else 1,
        "source": "Block shapes: OpenStreetMap contributors (ODbL). Complaints: NYPD Complaint Data, NYC Open Data.",
        "features": features,
    }


def fetch_hospitals():
    s, w, n, e = BBOX
    query = (
        f'[out:json][timeout:300];'
        f'(node["amenity"="hospital"]({s},{w},{n},{e});way["amenity"="hospital"]({s},{w},{n},{e}););'
        f'out center;'
    )
    body = urllib.parse.urlencode({"data": query}).encode()
    last_error = None
    for server in OVERPASS_SERVERS:
        try:
            req = urllib.request.Request(server, data=body, headers={"User-Agent": "byaku-map-build/1.0"})
            with urllib.request.urlopen(req, timeout=400) as resp:
                elements = json.load(resp)["elements"]
            break
        except OSError as err:
            print(f"{server} failed: {err}")
            last_error = err
    else:
        raise RuntimeError(f"All Overpass servers failed: {last_error}")
    features = []
    for el in elements:
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        tags = el.get("tags", {})
        features.append({
            "type": "Feature",
            "properties": {"name": tags.get("name", "Hospital")},
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        })
    print(f"hospitals: {len(features)}")
    return {
        "type": "FeatureCollection",
        "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "source": "Hospital locations: OpenStreetMap contributors (ODbL).",
        "features": features,
    }


def main():
    blocks = build_blocks(fetch_roads())
    complaints = fetch_crime()
    scores, counts = score_blocks(blocks, complaints)
    out = to_geojson(blocks, scores, counts)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {OUT}: {len(out['features'])} blocks")

    hospitals = fetch_hospitals()
    with open("data/hospitals-manhattan.geojson", "w") as f:
        json.dump(hospitals, f, separators=(",", ":"))
    print(f"wrote data/hospitals-manhattan.geojson: {len(hospitals['features'])} hospitals")


if __name__ == "__main__":
    main()
