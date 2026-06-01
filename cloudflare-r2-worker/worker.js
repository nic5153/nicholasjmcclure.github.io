const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

function corsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGIN || "*")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
  const requestOrigin = request ? request.headers.get("origin") || "" : "";
  const origin = allowed.includes("*") || !requestOrigin
    ? "*"
    : allowed.includes(requestOrigin)
      ? requestOrigin
      : allowed.includes("null") && requestOrigin === "null"
        ? "null"
        : allowed[0] || "*";

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-expose-headers": "content-disposition,content-length,content-type",
    "access-control-max-age": "86400"
  };
}

function json(data, status, env, request) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(env, request) }
  });
}

function unauthorized(env, request) {
  return json({ ok: false, error: "Unauthorized" }, 401, env, request);
}

function cleanSegment(value, fallback) {
  return String(value || fallback)
    .trim()
    .replace(/[^a-z0-9._ -]/gi, "")
    .replace(/\s+/g, "_")
    .slice(0, 80) || fallback;
}

function requireAuth(request, env) {
  const expected = env.UPLOAD_TOKEN;
  const header = request.headers.get("authorization") || "";
  return expected && header === `Bearer ${expected}`;
}

function plannerOwnerId(env) {
  return cleanSegment(env.PLANNER_OWNER_ID || "primary-owner", "primary-owner");
}

function plannerBundleId(env) {
  return `${plannerOwnerId(env)}-bundle`;
}

function uploadKey(searchParams) {
  const target = cleanSegment(searchParams.get("target"), "unknown-target");
  const kind = cleanSegment(searchParams.get("kind"), "Unknown");
  const sessionDate = cleanSegment(searchParams.get("date"), new Date().toISOString().slice(0, 10));
  const filename = cleanSegment(searchParams.get("filename"), "frame.fits");
  const collection = cleanSegment(searchParams.get("collection"), "session").toLowerCase();
  const rig = cleanSegment(searchParams.get("rig"), "unknown-rig");
  const temperature = cleanSegment(searchParams.get("temperature"), "unknown");
  const gain = cleanSegment(searchParams.get("gain"), "unknown");
  const offset = cleanSegment(searchParams.get("offset"), "unknown");
  const exposure = cleanSegment(searchParams.get("exposure"), "unknown");
  const binning = cleanSegment(searchParams.get("binning"), "unknown");
  const filter = cleanSegment(searchParams.get("filter"), "unknown");
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const calibrationSettings = `gain-${gain}_offset-${offset}_temp-${temperature}C_exp-${exposure}s_bin-${binning}_filter-${filter}`;
  const folder = collection === "calibration"
    ? `calibration/${kind}/${sessionDate}/${rig}/${calibrationSettings}`
    : `${sessionDate}/${target}/${kind}`;
  return {
    key: `${folder}/${unique}-${filename}`,
    target,
    kind,
    sessionDate,
    filename,
    collection,
    rig,
    temperature,
    gain,
    offset,
    exposure,
    binning,
    filter
  };
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeR2Key(value) {
  return String(value).split("/").map(awsEncode).join("/");
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

async function hmac(key, value) {
  const rawKey = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

async function presignR2Put(env, key) {
  const accountId = String(env.R2_ACCOUNT_ID || "").trim();
  const bucket = String(env.R2_BUCKET_NAME || "").trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "").trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    return { ok: false, error: "Direct R2 upload is not configured" };
  }

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const host = `${bucket}.${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodeR2Key(key)}`;
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": "21600",
    "X-Amz-SignedHeaders": "host"
  };
  const canonicalQuery = Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
    .join("&");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hex(await sha256(canonicalRequest))
  ].join("\n");
  const dateKey = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));

  return {
    ok: true,
    key,
    url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
  };
}

const TARGET_ALIASES = {
  "m1": { sesame: "M 1", display: "M1 Crab Nebula" },
  "crab": { sesame: "M 1", display: "M1 Crab Nebula" },
  "crab nebula": { sesame: "M 1", display: "M1 Crab Nebula" },
  "m13": { sesame: "M 13", display: "M13 Hercules Cluster" },
  "hercules cluster": { sesame: "M 13", display: "M13 Hercules Cluster" },
  "m27": { sesame: "M 27", display: "M27 Dumbbell Nebula" },
  "dumbbell": { sesame: "M 27", display: "M27 Dumbbell Nebula" },
  "dumbbell nebula": { sesame: "M 27", display: "M27 Dumbbell Nebula" },
  "m31": { sesame: "M 31", display: "M31 Andromeda Galaxy" },
  "andromeda": { sesame: "M 31", display: "M31 Andromeda Galaxy" },
  "andromeda galaxy": { sesame: "M 31", display: "M31 Andromeda Galaxy" },
  "m42": { sesame: "M 42", display: "M42 Orion Nebula" },
  "orion nebula": { sesame: "M 42", display: "M42 Orion Nebula" },
  "m45": { sesame: "M 45", display: "M45 Pleiades" },
  "pleiades": { sesame: "M 45", display: "M45 Pleiades" },
  "m51": { sesame: "M 51", display: "M51 Whirlpool Galaxy" },
  "whirlpool": { sesame: "M 51", display: "M51 Whirlpool Galaxy" },
  "whirlpool galaxy": { sesame: "M 51", display: "M51 Whirlpool Galaxy" },
  "m57": { sesame: "M 57", display: "M57 Ring Nebula" },
  "ring nebula": { sesame: "M 57", display: "M57 Ring Nebula" },
  "m81": { sesame: "M 81", display: "M81 Bode's Galaxy" },
  "bodes galaxy": { sesame: "M 81", display: "M81 Bode's Galaxy" },
  "bode's galaxy": { sesame: "M 81", display: "M81 Bode's Galaxy" },
  "m82": { sesame: "M 82", display: "M82 Cigar Galaxy" },
  "cigar galaxy": { sesame: "M 82", display: "M82 Cigar Galaxy" },
  "m101": { sesame: "M 101", display: "M101 Pinwheel Galaxy" },
  "pinwheel": { sesame: "M 101", display: "M101 Pinwheel Galaxy" },
  "pinwheel galaxy": { sesame: "M 101", display: "M101 Pinwheel Galaxy" },
  "algol": { sesame: "bet Per", display: "Algol" },
  "beta lyrae": { sesame: "bet Lyr", display: "Beta Lyrae" },
  "rr lyrae": { sesame: "RR Lyr", display: "RR Lyrae" },
  "delta cephei": { sesame: "del Cep", display: "Delta Cephei" },
  "w uma": { sesame: "W UMa", display: "W Ursae Majoris" },
  "w ursae majoris": { sesame: "W UMa", display: "W Ursae Majoris" }
};

function normalizeTargetName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function targetQueryCandidates(name) {
  const normalized = normalizeTargetName(name);
  const messier = normalized.match(/^m\s*(\d{1,3})$/);
  const candidates = [];
  if (messier) {
    candidates.push({ sesame: `M ${Number(messier[1])}`, display: `M${Number(messier[1])}`, match: "messier" });
  }
  const compact = normalized.replace(/\s+/g, "");
  const exact = TARGET_ALIASES[normalized] || TARGET_ALIASES[compact];
  if (exact) candidates.push({ ...exact, match: "alias" });

  let best = null;
  for (const [alias, target] of Object.entries(TARGET_ALIASES)) {
    const distance = levenshtein(normalized, alias);
    const threshold = alias.length <= 6 ? 1 : alias.length <= 12 ? 2 : 3;
    if (distance <= threshold && (!best || distance < best.distance)) {
      best = { ...target, match: "fuzzy", matchedAlias: alias, distance };
    }
  }
  if (best) candidates.push(best);
  candidates.push({ sesame: name, display: name, match: "input" });

  return candidates.filter((candidate, index, array) =>
    array.findIndex(other => other.sesame === candidate.sesame) === index
  );
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function tags(xml, name) {
  return [...String(xml).matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "gi"))]
    .map(match => decodeXml(match[1].trim()));
}

async function resolveSesame(name) {
  const url = `https://cds.unistra.fr/cgi-bin/nph-sesame/-oxpI/SNV?${encodeURIComponent(name)}`;
  const response = await fetch(url, { headers: { "user-agent": "observing-vault/1.0" } });
  const xml = await response.text();
  const resolverMatch = xml.match(/<Resolver name="([^"]+)">([\s\S]*?)<\/Resolver>/i);
  const resolverXml = resolverMatch ? resolverMatch[2] : xml;
  const raDeg = Number(tag(resolverXml, "jradeg"));
  const decDeg = Number(tag(resolverXml, "jdedeg"));

  return {
    ok: Number.isFinite(raDeg) && Number.isFinite(decDeg),
    source: resolverMatch ? resolverMatch[1] : "CDS Sesame",
    queryName: name,
    objectName: tag(resolverXml, "oname") || tag(xml, "name") || name,
    objectType: tag(resolverXml, "otype"),
    jpos: tag(resolverXml, "jpos"),
    raDeg,
    decDeg,
    spectralType: tag(resolverXml, "spType"),
    morphology: tag(resolverXml, "MType"),
    aliases: tags(resolverXml, "alias").slice(0, 20),
    magnitudes: [...String(resolverXml).matchAll(/<mag band="([^"]+)">[\s\S]*?<v>([\s\S]*?)<\/v>[\s\S]*?<\/mag>/gi)]
      .map(match => ({ band: match[1], value: decodeXml(match[2]) }))
  };
}

async function querySimbadTap(query) {
  const body = new URLSearchParams({
    REQUEST: "doQuery",
    LANG: "ADQL",
    FORMAT: "json",
    QUERY: query
  });
  const response = await fetch("https://simbad.cds.unistra.fr/simbad/sim-tap/sync", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "observing-vault/1.0"
    },
    body
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, error: text.slice(0, 240), rows: [] };
  try {
    const result = JSON.parse(text);
    const columns = (result.metadata || []).map(column => column.name);
    const rows = (result.data || []).map(values =>
      Object.fromEntries(columns.map((column, index) => [column, values[index]]))
    );
    return { ok: true, rows };
  } catch {
    return { ok: false, error: "SIMBAD returned non-JSON response", rows: [] };
  }
}

function coordinateDistanceSquared(row, raDeg, decDeg) {
  const decScale = Math.cos(decDeg * Math.PI / 180);
  return Math.pow((Number(row.ra) - raDeg) * decScale, 2) + Math.pow(Number(row.dec) - decDeg, 2);
}

async function querySimbadMetadata(raDeg, decDeg) {
  if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg)) return { ok: false, error: "No coordinates" };
  const metadata = await querySimbadTap(`
    SELECT TOP 100 oid, main_id, otype, otype_txt, galdim_majaxis, galdim_minaxis,
      morph_type, sp_type, ra, dec
    FROM basic
    WHERE 1 = CONTAINS(
      POINT('ICRS', ra, dec),
      CIRCLE('ICRS', ${raDeg}, ${decDeg}, 0.002)
    )
  `);
  if (!metadata.ok || !metadata.rows.length) return { ok: false, error: metadata.error || "No SIMBAD metadata row" };
  const nearest = metadata.rows
    .filter(row => Number.isFinite(Number(row.ra)) && Number.isFinite(Number(row.dec)))
    .sort((a, b) => coordinateDistanceSquared(a, raDeg, decDeg) - coordinateDistanceSquared(b, raDeg, decDeg))[0];
  if (!nearest) return { ok: false, error: "No coordinate-matched SIMBAD row" };
  const fluxes = await querySimbadTap(`
    SELECT filter, flux
    FROM flux
    WHERE oidref = ${Number(nearest.oid)}
      AND filter IN ('V', 'G', 'B')
  `);
  const magnitudes = fluxes.ok
    ? fluxes.rows
      .map(row => ({ band: row.filter, value: Number(row.flux) }))
      .filter(item => Number.isFinite(item.value))
    : [];
  const preferredMagnitude = ["V", "G", "B"]
    .map(band => magnitudes.find(item => item.band === band))
    .find(Boolean);
  return {
    ok: true,
    source: "SIMBAD TAP",
    objectName: nearest.main_id,
    objectType: nearest.otype_txt || nearest.otype,
    objectTypeCode: nearest.otype,
    angularSizeArcmin: Number.isFinite(Number(nearest.galdim_majaxis)) ? Number(nearest.galdim_majaxis) : null,
    angularMinorSizeArcmin: Number.isFinite(Number(nearest.galdim_minaxis)) ? Number(nearest.galdim_minaxis) : null,
    morphology: nearest.morph_type || "",
    spectralType: nearest.sp_type || "",
    preferredMagnitude: preferredMagnitude?.value ?? null,
    preferredMagnitudeBand: preferredMagnitude?.band || "",
    magnitudes
  };
}

async function queryGaia(raDeg, decDeg) {
  if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg)) return { ok: false, error: "No coordinates" };
  const query = `
    SELECT TOP 5 source_id, ra, dec, parallax, parallax_error, pmra, pmdec,
      phot_g_mean_mag, phot_bp_mean_mag, phot_rp_mean_mag, ruwe
    FROM gaiadr3.gaia_source
    WHERE 1 = CONTAINS(
      POINT('ICRS', ra, dec),
      CIRCLE('ICRS', ${raDeg}, ${decDeg}, 0.0166667)
    )
    ORDER BY phot_g_mean_mag ASC
  `;
  const body = new URLSearchParams({
    REQUEST: "doQuery",
    LANG: "ADQL",
    FORMAT: "json",
    QUERY: query
  });
  const response = await fetch("https://gea.esac.esa.int/tap-server/tap/sync", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "observing-vault/1.0"
    },
    body
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, error: text.slice(0, 240) };
  try {
    const data = JSON.parse(text);
    return { ok: true, rows: Array.isArray(data.data) ? data.data : data };
  } catch {
    return { ok: false, error: "Gaia returned non-JSON response", raw: text.slice(0, 240) };
  }
}

async function queryArxiv(name) {
  const params = new URLSearchParams({
    search_query: `all:"${name}" AND cat:astro-ph*`,
    start: "0",
    max_results: "3",
    sortBy: "submittedDate",
    sortOrder: "descending"
  });
  const response = await fetch(`https://export.arxiv.org/api/query?${params.toString()}`, {
    headers: { "user-agent": "observing-vault/1.0 (contact: nic5153mcclure@gmail.com)" }
  });
  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].slice(0, 3).map(match => {
    const entry = match[1];
    return {
      id: tag(entry, "id"),
      title: tag(entry, "title").replace(/\s+/g, " "),
      updated: tag(entry, "updated"),
      summary: tag(entry, "summary").replace(/\s+/g, " ").slice(0, 500),
      authors: tags(entry, "name").slice(0, 8)
    };
  });
  return { ok: response.ok, entries };
}

async function queryTns(name, env) {
  if (!env.TNS_API_KEY || !env.TNS_BOT_ID || !env.TNS_BOT_NAME) {
    return { ok: false, configured: false, error: "TNS bot credentials are not configured" };
  }
  const body = new URLSearchParams({
    api_key: env.TNS_API_KEY,
    data: JSON.stringify({ objname: name, objname_exact_match: 0 })
  });
  const response = await fetch("https://www.wis-tns.org/api/get/search", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": `tns_marker{"tns_id":${env.TNS_BOT_ID},"type":"bot","name":"${env.TNS_BOT_NAME}"}`
    },
    body
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, configured: true, data };
}

async function geocodePlace(query) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "1",
    addressdetails: "1"
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: {
      "user-agent": "observing-vault/1.0 (contact: nic5153mcclure@gmail.com)",
      "accept-language": "en"
    }
  });
  const data = await response.json().catch(() => []);
  const first = Array.isArray(data) ? data[0] : null;
  if (!response.ok || !first) {
    return { ok: false, error: "Location not found" };
  }
  return {
    ok: true,
    name: first.display_name,
    lat: Number(first.lat),
    lon: Number(first.lon),
    type: first.type,
    importance: first.importance
  };
}

async function hourlyWeather(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: "Invalid coordinates" };
  }
  const params = new URLSearchParams({
    latitude: lat.toFixed(5),
    longitude: lon.toFixed(5),
    hourly: "temperature_2m,relative_humidity_2m,precipitation_probability,cloud_cover,wind_speed_10m",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    forecast_days: "5",
    timezone: "auto"
  });
  const forecastResponse = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  const forecastData = await forecastResponse.json().catch(() => ({}));
  if (!forecastResponse.ok) {
    return { ok: false, error: forecastData?.reason || "Five-day forecast request failed" };
  }
  const hourly = forecastData.hourly || {};
  const times = hourly.time || [];
  return {
    ok: true,
    updated: new Date().toISOString(),
    timezone: forecastData.timezone,
    units: forecastData.hourly_units,
    periods: times.map((startTime, index) => {
      const precipitation = hourly.precipitation_probability?.[index] ?? 0;
      const cloudCover = hourly.cloud_cover?.[index] ?? 0;
      let shortForecast = cloudCover <= 20 ? "Clear" : cloudCover <= 55 ? "Partly Cloudy" : "Cloudy";
      if (precipitation > 45) shortForecast += " / Rain Risk";
      return {
        startTime,
        temperature: hourly.temperature_2m?.[index],
        temperatureUnit: "F",
        windSpeed: hourly.wind_speed_10m?.[index],
        shortForecast,
        probabilityOfPrecipitation: precipitation,
        relativeHumidity: hourly.relative_humidity_2m?.[index],
        cloudCover
      };
    })
  };
}

function escapeAdql(value) {
  return String(value || "")
    .replace(/[%_]/g, "")
    .replace(/'/g, "''")
    .trim()
    .slice(0, 96);
}

async function queryExoplanetArchive(name) {
  const queryName = escapeAdql(name);
  if (!queryName) return { ok: false, error: "Missing exoplanet name" };
  const query = `
    SELECT TOP 12
      pl_name, hostname, rastr, decstr, ra, dec, sy_vmag, sy_gaiamag, sy_dist,
      st_spectype, st_teff, st_rad, st_mass, st_logg, st_met,
      pl_orbper, pl_orbpererr1, pl_orbpererr2,
      pl_tranmid, pl_tranmiderr1, pl_tranmiderr2, pl_tranmid_systemref,
      pl_trandur, pl_trandurerr1, pl_trandurerr2, pl_trandep, pl_ratror,
      pl_rade, pl_radj, pl_bmasse, pl_bmassj, pl_orbsmax, pl_orbincl,
      pl_imppar, pl_insol, pl_eqt, ttv_flag, tran_flag, disc_year, discoverymethod
    FROM pscomppars
    WHERE tran_flag = 1
      AND (
        LOWER(pl_name) = LOWER('${queryName}')
        OR LOWER(hostname) = LOWER('${queryName}')
        OR LOWER(pl_name) LIKE LOWER('%${queryName}%')
        OR LOWER(hostname) LIKE LOWER('%${queryName}%')
      )
  `.replace(/\s+/g, " ").trim();
  const params = new URLSearchParams({ query, format: "json" });
  const response = await fetch(`https://exoplanetarchive.ipac.caltech.edu/TAP/sync?${params}`, {
    headers: { "user-agent": "observing-vault/1.0 (NightVector transit planner)" }
  });
  const data = await response.json().catch(() => []);
  if (!response.ok) {
    return { ok: false, error: data?.message || "NASA Exoplanet Archive request failed" };
  }
  const rows = Array.isArray(data) ? data : [];
  const normalized = queryName.toLowerCase();
  rows.sort((left, right) => {
    const rank = row => String(row.pl_name || "").toLowerCase() === normalized
      ? 0
      : String(row.hostname || "").toLowerCase() === normalized
        ? 1
        : 2;
    return rank(left) - rank(right) || String(left.pl_name || "").localeCompare(String(right.pl_name || ""));
  });
  return {
    ok: true,
    source: "NASA Exoplanet Archive PSCompPars",
    updated: new Date().toISOString(),
    query: name,
    rows
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env, request) });
    }

    if (request.method === "GET" && url.pathname === "/target-info") {
      const name = url.searchParams.get("name");
      if (!name) {
        return json({ ok: false, error: "Missing target name" }, 400, env, request);
      }

      const candidates = targetQueryCandidates(name);
      let resolved = { ok: false };
      let usedCandidate = candidates[0];
      for (const candidate of candidates) {
        const attempt = await resolveSesame(candidate.sesame).catch(error => ({ ok: false, error: String(error) }));
        if (attempt.ok) {
          resolved = attempt;
          usedCandidate = candidate;
          break;
        }
      }
      if (usedCandidate?.display && resolved.ok) {
        resolved = {
          ...resolved,
          commonName: usedCandidate.display,
          lookupMatch: usedCandidate.match,
          matchedAlias: usedCandidate.matchedAlias
        };
      }

      const [simbad, gaia, arxiv, tns] = await Promise.all([
        resolved.ok ? querySimbadMetadata(resolved.raDeg, resolved.decDeg).catch(error => ({ ok: false, error: String(error) })) : { ok: false, error: "Not resolved" },
        resolved.ok ? queryGaia(resolved.raDeg, resolved.decDeg).catch(error => ({ ok: false, error: String(error) })) : { ok: false, error: "Not resolved" },
        queryArxiv(usedCandidate?.display || name).catch(error => ({ ok: false, error: String(error), entries: [] })),
        queryTns(name, env).catch(error => ({ ok: false, error: String(error) }))
      ]);
      if (simbad.ok) {
        resolved = {
          ...resolved,
          simbad,
          objectType: simbad.objectType || resolved.objectType,
          objectTypeCode: simbad.objectTypeCode,
          angularSizeArcmin: simbad.angularSizeArcmin,
          angularMinorSizeArcmin: simbad.angularMinorSizeArcmin,
          preferredMagnitude: simbad.preferredMagnitude,
          preferredMagnitudeBand: simbad.preferredMagnitudeBand,
          morphology: simbad.morphology || resolved.morphology,
          spectralType: simbad.spectralType || resolved.spectralType,
          magnitudes: simbad.magnitudes?.length ? simbad.magnitudes : resolved.magnitudes
        };
      }

      return json({ ok: true, candidates, resolved, simbad, gaia, arxiv, tns }, 200, env, request);
    }

    if (request.method === "GET" && url.pathname === "/geocode") {
      const q = url.searchParams.get("q");
      if (!q) {
        return json({ ok: false, error: "Missing location query" }, 400, env, request);
      }
      const result = await geocodePlace(q);
      return json(result, result.ok ? 200 : 404, env, request);
    }

    if (request.method === "GET" && url.pathname === "/weather") {
      const lat = Number(url.searchParams.get("lat"));
      const lon = Number(url.searchParams.get("lon"));
      const result = await hourlyWeather(lat, lon);
      return json(result, result.ok ? 200 : 400, env, request);
    }

    if (request.method === "GET" && url.pathname === "/exoplanet-info") {
      const name = url.searchParams.get("name");
      const result = await queryExoplanetArchive(name);
      return json(result, result.ok ? 200 : 400, env, request);
    }

    if (!requireAuth(request, env)) {
      return unauthorized(env, request);
    }

    if (request.method === "GET" && url.pathname === "/planner-sync") {
      if (!env.PLANNER_DB) {
        return json({ ok: false, error: "Planner D1 binding is not configured" }, 501, env, request);
      }
      const row = await env.PLANNER_DB
        .prepare("SELECT profile_json, updated_at FROM planner_profiles WHERE id = ?1 AND owner_id = ?2")
        .bind(plannerBundleId(env), plannerOwnerId(env))
        .first();
      if (!row) {
        return json({ ok: true, exists: false }, 200, env, request);
      }
      return json({
        ok: true,
        exists: true,
        updatedAt: row.updated_at,
        bundle: JSON.parse(row.profile_json)
      }, 200, env, request);
    }

    if (request.method === "POST" && url.pathname === "/planner-sync") {
      if (!env.PLANNER_DB) {
        return json({ ok: false, error: "Planner D1 binding is not configured" }, 501, env, request);
      }
      const payload = await request.json().catch(() => ({}));
      const bundle = payload.bundle;
      if (!bundle || !Array.isArray(bundle.plannerProfiles) || !bundle.plannerProfiles.length) {
        return json({ ok: false, error: "Invalid planner profile bundle" }, 400, env, request);
      }
      const profileJson = JSON.stringify(bundle);
      if (profileJson.length > 2_000_000) {
        return json({ ok: false, error: "Planner profile bundle is too large" }, 413, env, request);
      }
      await env.PLANNER_DB
        .prepare(`
          INSERT INTO planner_profiles (id, owner_id, name, profile_json, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            profile_json = excluded.profile_json,
            updated_at = CURRENT_TIMESTAMP
        `)
        .bind(plannerBundleId(env), plannerOwnerId(env), "NightVector Cloud Bundle", profileJson)
        .run();
      return json({ ok: true, updatedAt: new Date().toISOString() }, 200, env, request);
    }

    if (request.method === "GET" && url.pathname === "/presign-upload") {
      const { key } = uploadKey(url.searchParams);
      const signed = await presignR2Put(env, key);
      return json(signed, signed.ok ? 200 : 501, env, request);
    }

    if (request.method === "POST" && url.pathname === "/presign-uploads") {
      const payload = await request.json().catch(() => ({}));
      const uploads = Array.isArray(payload.uploads) ? payload.uploads : [];
      if (!uploads.length || uploads.length > 100) {
        return json({ ok: false, error: "Provide between 1 and 100 uploads" }, 400, env, request);
      }
      const signedUploads = await Promise.all(uploads.map(async upload => {
        const params = new URLSearchParams({
          target: upload.target || "unknown-target",
          kind: upload.kind || "Unknown",
          date: upload.date || new Date().toISOString().slice(0, 10),
          filename: upload.filename || "frame.fits",
          collection: upload.collection || "session",
          rig: upload.rig || "unknown-rig",
          temperature: upload.temperature ?? "unknown",
          gain: upload.gain ?? "unknown",
          offset: upload.offset ?? "unknown",
          exposure: upload.exposure ?? "unknown",
          binning: upload.binning ?? "unknown",
          filter: upload.filter || "unknown"
        });
        const { key } = uploadKey(params);
        return presignR2Put(env, key);
      }));
      const failure = signedUploads.find(upload => !upload.ok);
      if (failure) {
        return json(failure, 501, env, request);
      }
      return json({ ok: true, uploads: signedUploads }, 200, env, request);
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      const { key, target, kind, sessionDate, filename, collection, rig, temperature, gain, offset, exposure, binning, filter } = uploadKey(url.searchParams);

      await env.OBS_BUCKET.put(key, request.body, {
        httpMetadata: {
          contentType: request.headers.get("content-type") || "application/fits"
        },
        customMetadata: {
          target,
          kind,
          sessionDate,
          originalFilename: filename,
          collection,
          rig,
          temperature,
          gain,
          offset,
          exposure,
          binning,
          filter
        }
      });

      return json({ ok: true, key }, 200, env, request);
    }

    if (request.method === "GET" && url.pathname === "/list") {
      const prefix = url.searchParams.get("prefix") || "";
      const cursor = url.searchParams.get("cursor") || undefined;
      const list = await env.OBS_BUCKET.list({
        prefix,
        cursor,
        limit: 1000,
        include: ["customMetadata"]
      });
      return json({
        ok: true,
        truncated: list.truncated,
        cursor: list.cursor,
        objects: list.objects.map(object => ({
          key: object.key,
          size: object.size,
          uploaded: object.uploaded,
          metadata: object.customMetadata || {}
        }))
      }, 200, env, request);
    }

    if (request.method === "GET" && url.pathname === "/download") {
      const key = url.searchParams.get("key");
      if (!key) {
        return json({ ok: false, error: "Missing key" }, 400, env, request);
      }

      const object = await env.OBS_BUCKET.get(key);
      if (!object) {
        return json({ ok: false, error: "Object not found" }, 404, env, request);
      }

      const filename = key.split("/").pop() || "download";
      return new Response(object.body, {
        headers: {
          ...corsHeaders(env, request),
          "content-type": object.httpMetadata?.contentType || "application/octet-stream",
          "content-length": String(object.size),
          "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`
        }
      });
    }

    return json({ ok: false, error: "Not found" }, 404, env, request);
  }
};
