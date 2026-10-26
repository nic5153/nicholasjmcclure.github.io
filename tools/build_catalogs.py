#!/usr/bin/env python3
"""Build the static target catalogs used by the NightVector planner pages.

The planner pages run entirely in the browser, but several archives they need
(ExoClock, the NASA Exoplanet Archive TAP service, VizieR) do not allow
cross-origin browser requests.  This script downloads them once and writes
compact JSON snapshots to files/data/, which GitHub Pages serves same-origin.

Usage (standard library only):
    python tools/build_catalogs.py            # rebuild everything
    python tools/build_catalogs.py exo vsx    # rebuild selected catalogs
    python tools/build_catalogs.py vsx --durations 300
        # also fetch up to 300 more eclipse/rise durations from the VSX API (1 request/s)

Outputs
    files/data/exoplanets.json  transiting planets (ExoClock + NASA archive)
    files/data/variables.json   eclipsing binaries, pulsators, CVs (AAVSO VSX)
    files/data/dso.json         deep-sky objects (OpenNGC)

Re-run every month or so to pick up new planets and refined ephemerides.
VSX eclipse durations are cached in tools/.cache/ so re-runs are incremental.
"""

import csv
import io
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "files" / "data"
CACHE = Path(__file__).resolve().parent / ".cache"
UA = {"User-Agent": "nightvector-catalog-build/1.0 (+https://github.com/nic5153/nicholasjmcclure.github.io)"}

MIN_DEC = -45.0  # southern limit; anything further south never clears ~15 deg from Tucson/Lubbock


def fetch(url, data=None, timeout=600):
    req = urllib.request.Request(url, data=data, headers=UA)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return response.read()
        except Exception as error:  # noqa: BLE001 - retry any transport error
            if attempt == 3:
                raise
            print(f"  retrying ({error})", flush=True)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("unreachable")


def fetch_cached(url, cache_name, **kwargs):
    """Fetch url, keeping a copy in tools/.cache; fall back to that copy if the host is unreachable."""
    CACHE.mkdir(exist_ok=True)
    path = CACHE / cache_name
    try:
        raw = fetch(url, **kwargs)
        path.write_bytes(raw)
        return raw
    except Exception as error:  # noqa: BLE001
        if not path.exists():
            raise
        age_days = (time.time() - path.stat().st_mtime) / 86400
        print(f"  {url} unreachable ({error}); using cached copy from {age_days:.1f} days ago")
        return path.read_bytes()


def num(value, digits=None):
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(out):
        return None
    return round(out, digits) if digits is not None else out


def sexagesimal_to_deg(text, hours):
    text = str(text or "").strip()
    if not text:
        return None
    sign = -1 if text.startswith("-") else 1
    parts = [float(p) for p in text.lstrip("+-").replace("h", ":").replace("d", ":").replace("m", ":").replace("s", "").split(":") if p]
    while len(parts) < 3:
        parts.append(0.0)
    value = parts[0] + parts[1] / 60 + parts[2] / 3600
    return sign * value * (15 if hours else 1)


def key_name(name):
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


def write(name, payload):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    path.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1024:.0f} KB, {len(payload['rows'])} rows)")


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------- exoplanets

def nasa_tap(query):
    params = urllib.parse.urlencode({"query": " ".join(query.split()), "format": "json"})
    return json.loads(fetch(f"https://exoplanetarchive.ipac.caltech.edu/TAP/sync?{params}"))


def build_exoplanets():
    print("ExoClock planets ...", flush=True)
    exoclock = json.loads(fetch_cached("https://www.exoclock.space/database/planets_json", "exoclock_planets.json"))
    rows = []
    seen = set()
    for item in exoclock.values():
        ra = sexagesimal_to_deg(item.get("ra_j2000"), True)
        dec = sexagesimal_to_deg(item.get("dec_j2000"), False)
        period = num(item.get("period_days"))
        t0 = num(item.get("t0_bjd_tdb"))
        duration = num(item.get("duration_hours"))
        depth_mmag = num(item.get("depth_r_mmag"))
        if None in (ra, dec, period, t0, duration, depth_mmag) or dec < MIN_DEC:
            continue
        depth_ppt = (1 - 10 ** (-0.4 * depth_mmag / 1000)) * 1000
        name = item["name"]
        seen.add(key_name(name))
        rows.append([
            name, item.get("star") or "", round(ra, 5), round(dec, 5),
            num(item.get("v_mag"), 2), num(item.get("r_mag"), 2),
            period, num(item.get("period_unc")), t0, num(item.get("t0_unc")),
            round(duration, 3), round(depth_ppt, 3),
            num(item.get("rp_over_rs"), 4), num(item.get("sma_over_rs"), 3), num(item.get("inclination"), 2),
            item.get("priority") or "", num(item.get("min_telescope_inches"), 1), "E",
        ])
    print(f"  {len(rows)} ExoClock planets")

    print("NASA Exoplanet Archive (pscomppars) ...", flush=True)
    nasa = nasa_tap(f"""
        SELECT pl_name, hostname, ra, dec, sy_vmag, sy_gaiamag, pl_orbper, pl_orbpererr1, pl_tranmid,
               pl_tranmiderr1, pl_trandur, pl_trandep, pl_ratror, pl_ratdor, pl_orbincl, ttv_flag
        FROM pscomppars
        WHERE tran_flag = 1 AND pl_orbper IS NOT NULL AND pl_tranmid IS NOT NULL AND pl_trandur IS NOT NULL
          AND dec > {MIN_DEC} AND (sy_vmag < 14.5 OR sy_gaiamag < 14.5)
    """)
    added = 0
    for item in nasa:
        if key_name(item["pl_name"]) in seen:
            continue
        depth_pct = num(item.get("pl_trandep"))
        ratror = num(item.get("pl_ratror"))
        if depth_pct is None and ratror:
            depth_pct = ratror * ratror * 100
        if not depth_pct or depth_pct < 0.1:
            continue  # < 1 ppt: beyond reach of small ground-based telescopes
        vmag = num(item.get("sy_vmag"), 2)
        if vmag is None and num(item.get("sy_gaiamag")) is not None:
            vmag = round(num(item["sy_gaiamag"]) + 0.1, 2)  # G is ~0.1 mag brighter than V for FGK hosts
        rows.append([
            item["pl_name"], item.get("hostname") or "", round(num(item["ra"]), 5), round(num(item["dec"]), 5),
            vmag, None, num(item["pl_orbper"]), num(item.get("pl_orbpererr1")),
            num(item["pl_tranmid"]), num(item.get("pl_tranmiderr1")), round(num(item["pl_trandur"]), 3),
            round(depth_pct * 10, 3), ratror, num(item.get("pl_ratdor"), 3), num(item.get("pl_orbincl"), 2),
            "ttv" if str(item.get("ttv_flag")) == "1" else "", None, "N",
        ])
        added += 1
    print(f"  {added} additional NASA archive planets")
    rows.sort(key=lambda row: row[0].lower())
    write("exoplanets.json", {
        "generated": now_iso(),
        "sources": [
            "ExoClock project ephemerides (Kokori et al. 2023, ApJS 265, 4), exoclock.space",
            "NASA Exoplanet Archive Planetary Systems Composite Parameters (doi:10.26133/NEA13)",
        ],
        "notes": "t0 is BJD_TDB; depth_ppt is the fractional transit depth in parts per thousand; src E=ExoClock, N=NASA.",
        "fields": ["name", "host", "ra", "dec", "vmag", "rmag", "period", "period_unc", "t0", "t0_unc",
                   "dur_h", "depth_ppt", "rp_rs", "a_rs", "inc", "flag", "min_tel_in", "src"],
        "rows": rows,
    })


# --------------------------------------------------------------------------- variable stars

VSX_TYPES = ["EA", "EB", "EW", "RR", "HADS", "DSCT", "SXPHE", "DCEP", "CEP", "CW", "UG", "NL", "AM", "DQ", "IP", "N"]


def vizier_tap(query):
    body = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": " ".join(query.split())}).encode()
    result = json.loads(fetch_cached("https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync", "vizier_vsx.json", data=body))
    columns = [column["name"] for column in result["metadata"]]
    return [dict(zip(columns, values)) for values in result["data"]]


# Cataclysmic variables: dwarf novae, nova-likes, polars, intermediate polars, old/recurrent novae.
# Symbiotic stars (ZAND) are left out: their slow, irregular variability is not a time-series target.
CV_PREFIXES = ("UG", "NL", "AM", "DQ", "IP", "NA", "NB", "NC", "NR")


def classify(vsx_type):
    """Map a VSX variability type string onto the planner's observing classes."""
    parts = [p for p in re.split(r"[+/|]", vsx_type.upper().replace(":", "").strip()) if p]
    if not parts or any(p.startswith("ZAND") for p in parts):
        return None
    head = parts[0]
    cv = any(p.startswith(CV_PREFIXES) or p == "N" for p in parts)
    eclipse = next((p for p in parts if p == "E" or p.startswith(("EA", "EB", "EW"))), None)
    if cv:
        return "CVE" if eclipse else "CV"
    if eclipse:
        return "EW" if eclipse.startswith("EW") else "EB" if eclipse.startswith("EB") else "EA"
    if head.startswith("RR"):
        return "RR"
    if head.startswith(("HADS", "DSCT", "SXPHE")):
        return "DS"
    if head.startswith(("DCEP", "CEP", "CW")):
        return "CEP"
    return None


def vsx_object(name):
    params = urllib.parse.urlencode({"view": "api.object", "ident": name, "format": "json"})
    req = urllib.request.Request(f"https://vsx.aavso.org/index.php?{params}", headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            data = json.loads(response.read())
    except Exception:  # noqa: BLE001 - no retries: a refusal here means we are being rate-limited
        return None
    obj = data.get("VSXObject") if isinstance(data, dict) else None
    if not isinstance(obj, dict):
        return None
    return {"D": obj.get("EclipseDuration"), "M": obj.get("RiseDuration")}


def build_variables():
    print("VizieR B/vsx ...", flush=True)
    like = " OR ".join(f"Type LIKE '{t}%'" for t in VSX_TYPES)
    rows = vizier_tap(f"""
        SELECT OID, Name, RAJ2000, DEJ2000, Type, l_max, "max", n_max, f_min, l_min, "min", n_min, Epoch, Period
        FROM "B/vsx/vsx"
        WHERE V = 0 AND DEJ2000 > {MIN_DEC} AND "max" < 14 AND Period IS NOT NULL AND ({like} OR Type LIKE '%+E%')
    """)
    print(f"  {len(rows)} candidate rows")
    kept = []
    for row in rows:
        vsx_type = (row.get("Type") or "").strip()
        cls = classify(vsx_type)
        if not cls:
            continue
        mag_max = num(row.get("max"))
        mag_min = num(row.get("min"))
        period = num(row.get("Period"))
        if mag_max is None or period is None or period <= 0:
            continue
        band_max = (row.get("n_max") or "").strip()
        band_min = (row.get("n_min") or "").strip()
        if (row.get("f_min") or "").strip() == "(":
            amp = mag_min  # VSX stores an amplitude in parentheses when no minimum is listed
        elif mag_min is not None and (not band_min or band_min == band_max):
            amp = mag_min - mag_max
        else:
            amp = None
        if (row.get("l_max") or "").strip() == "<":
            continue  # only an upper limit on brightness
        epoch = num(row.get("Epoch"))
        if cls in ("EA", "EB", "EW", "CVE", "RR") and epoch is None:
            continue  # cannot predict minima/maxima without an epoch
        if cls == "CV":
            if mag_max > 13.5:
                continue
        else:
            if amp is None or amp < (0.15 if cls == "DS" else 0.1):
                continue
            if mag_max > 13.0:
                continue
        if cls == "EA" and period > 60:
            continue  # very long-period systems: eclipses are rare and multi-night
        if cls == "CEP" and period > 60:
            continue
        kept.append({
            "oid": row.get("OID"), "name": row["Name"].strip(), "type": vsx_type, "cls": cls,
            "ra": round(num(row["RAJ2000"]), 5), "dec": round(num(row["DEJ2000"]), 5),
            "max": round(mag_max, 2), "amp": None if amp is None else round(amp, 3), "band": band_max,
            "period": period, "epoch": epoch,
        })
    print(f"  {len(kept)} after class/amplitude/brightness cuts")

    # Eclipse durations (EA, CVE) and rise durations (RR) only exist in the live VSX API, which
    # rate-limits bulk use (HTTP 405 after a few hundred quick requests).  Durations are therefore
    # fetched politely, a limited number per run (--durations N), brightest stars first, and cached.
    # Stars without a cached duration get an estimate in the browser (flagged as estimated).
    CACHE.mkdir(exist_ok=True)
    cache_path = CACHE / "vsx_durations.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    need = sorted((row for row in kept if row["cls"] in ("EA", "CVE", "RR") and str(row["oid"]) not in cache),
                  key=lambda row: row["max"])[:DURATION_FETCH_LIMIT]
    print(f"  {len(cache)} cached VSX durations; fetching {len(need)} more (limit {DURATION_FETCH_LIMIT}) ...", flush=True)
    for index, row in enumerate(need, 1):
        info = vsx_object(row["name"])
        if info is None:
            print(f"    VSX stopped answering after {index - 1} requests; keeping what we have")
            break
        cache[str(row["oid"])] = info
        if index % 100 == 0:
            print(f"    {index}/{len(need)}", flush=True)
            cache_path.write_text(json.dumps(cache))
        time.sleep(1.0)
    cache_path.write_text(json.dumps(cache))

    out = []
    for row in kept:
        info = cache.get(str(row["oid"])) or {}
        duration = num(info.get("D")) if row["cls"] in ("EA", "CVE") else num(info.get("M")) if row["cls"] == "RR" else None
        out.append([
            row["name"], row["type"], row["cls"], row["ra"], row["dec"], row["max"], row["amp"], row["band"],
            row["period"], row["epoch"], duration,
        ])
    out.sort(key=lambda r: (r[5], r[0]))
    write("variables.json", {
        "generated": now_iso(),
        "sources": ["AAVSO International Variable Star Index (VSX), Watson et al. 2006; via VizieR B/vsx and the VSX API"],
        "notes": ("epoch is HJD (time of primary minimum for eclipsing systems, maximum for pulsators); "
                  "dur is the eclipse duration (EA/CVE) or rise duration (RR) in percent of the period; "
                  "cls: EA detached EB, EB beta Lyr, EW contact, CVE eclipsing CV, CV cataclysmic, RR RR Lyrae, "
                  "DS delta Scuti/SX Phe, CEP Cepheid."),
        "fields": ["name", "type", "cls", "ra", "dec", "max", "amp", "band", "period", "epoch", "dur"],
        "rows": out,
    })


# --------------------------------------------------------------------------- deep-sky objects

DSO_TYPES = {
    "G": "Galaxy", "GPair": "Galaxy pair", "GTrpl": "Galaxy triplet", "GGroup": "Galaxy group",
    "PN": "Planetary nebula", "HII": "Emission nebula", "EmN": "Emission nebula", "RfN": "Reflection nebula",
    "Neb": "Nebula", "Cl+N": "Cluster + nebula", "SNR": "Supernova remnant", "GCl": "Globular cluster",
    "OCl": "Open cluster", "*Ass": "Stellar association",
}


def pretty_designation(name):
    """NGC0224 -> NGC 224, IC0434 -> IC 434, Mel022 -> Mel 22."""
    match = re.match(r"^([A-Za-z]+)0*(\d+)(.*)$", name.strip())
    return f"{match[1]} {match[2]}{match[3]}" if match else name.strip()


def build_dso():
    print("OpenNGC ...", flush=True)
    base = "https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/"
    records = []
    for name in ("NGC.csv", "addendum.csv"):
        text = fetch(base + name).decode("utf-8")
        records.extend(csv.DictReader(io.StringIO(text), delimiter=";"))
    print(f"  {len(records)} OpenNGC records")
    rows = []
    for rec in records:
        kind = rec.get("Type", "")
        if kind not in DSO_TYPES:
            continue
        ra = sexagesimal_to_deg(rec.get("RA"), True)
        dec = sexagesimal_to_deg(rec.get("Dec"), False)
        if ra is None or dec is None or dec < MIN_DEC:
            continue
        messier = (rec.get("M") or "").strip()
        vmag = num(rec.get("V-Mag"))
        bmag = num(rec.get("B-Mag"))
        mag = vmag if vmag is not None else (bmag - 0.8 if bmag is not None else None)  # rough B-V for galaxies
        major = num(rec.get("MajAx"))
        minor = num(rec.get("MinAx"))
        if not messier:
            limit = 12.0 if kind in ("G", "GPair", "GTrpl", "GGroup") else 11.5 if kind != "PN" else 12.5
            if mag is None or mag > limit or major is None or major < 0.3:
                continue
        common = (rec.get("Common names") or "").split(",")[0].strip()
        catalog_name = pretty_designation(rec["Name"])
        label = f"M{int(messier)}" if messier else catalog_name
        rows.append([
            label, common, DSO_TYPES[kind], round(ra, 5), round(dec, 5),
            None if major is None else round(major, 2), None if minor is None else round(minor, 2),
            num(rec.get("PosAng")), None if mag is None else round(mag, 2), num(rec.get("SurfBr"), 2),
            rec.get("Const", ""), catalog_name if messier else "",
        ])
    # Drop duplicate Messier rows (OpenNGC lists a few objects under several names).
    unique = {}
    for row in rows:
        unique.setdefault(row[0], row)
    rows = sorted(unique.values(), key=lambda r: (not r[0].startswith("M"), int("".join(c for c in r[0] if c.isdigit()) or 0) if r[0].startswith("M") else 0, r[0]))
    write("dso.json", {
        "generated": now_iso(),
        "sources": ["OpenNGC by Mattia Verga, CC BY-SA 4.0, github.com/mattiaverga/OpenNGC"],
        "license": "CC BY-SA 4.0 (derived from OpenNGC)",
        "notes": "size in arcmin; mag is V (or B-0.8 when only B is known); sb is the OpenNGC mean surface brightness (galaxies) in B mag/arcsec^2.",
        "fields": ["id", "name", "type", "ra", "dec", "maj", "min", "pa", "mag", "sb", "const", "ref"],
        "rows": rows,
    })


BUILDERS = {"exo": build_exoplanets, "vsx": build_variables, "dso": build_dso}
DURATION_FETCH_LIMIT = 0

if __name__ == "__main__":
    args = sys.argv[1:]
    if "--durations" in args:
        position = args.index("--durations")
        DURATION_FETCH_LIMIT = int(args[position + 1])
        del args[position:position + 2]
    for key in args or list(BUILDERS):
        BUILDERS[key]()
