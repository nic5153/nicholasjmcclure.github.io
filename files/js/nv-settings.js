/*
 * NightVector shared settings (site, rig, observing criteria) for the planner pages.
 * Stored in localStorage under nv.settings.v2.  Older NightVector keys
 * (observingSite, observingRigProfiles, observingRigId) are migrated once.
 */
(function (global) {
    'use strict';

    const KEY = 'nv.settings.v2';

    const RIG_PRESETS = {
        'c8-reduced-atr585m': {
            name: 'C8 + 0.63x reducer + ATR585M',
            aperture: 203.2, obstruction: 0.34, focalLength: 2032, reducer: 0.63,
            pixelSize: 2.9, sensorW: 3840, sensorH: 2160,
            camera: 'ToupTek ATR585M (IMX585, mono)',
            readNoise: 2.74, fullWell: 38900, darkCurrent: 0.002, throughput: 0.5,
            readout: 'LCG'
        },
        'c8-native-atr585m': {
            name: 'C8 native f/10 + ATR585M',
            aperture: 203.2, obstruction: 0.34, focalLength: 2032, reducer: 1,
            pixelSize: 2.9, sensorW: 3840, sensorH: 2160,
            camera: 'ToupTek ATR585M (IMX585, mono)',
            readNoise: 2.74, fullWell: 38900, darkCurrent: 0.002, throughput: 0.5,
            readout: 'LCG'
        }
    };

    function defaults() {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        return {
            version: 2,
            site: {
                name: 'Tucson, AZ (default - set your site)',
                lat: 32.2217, lon: -110.9265, elevation: 760, tz: 'America/Phoenix',
                bortle: 6, sqm: null, minAlt: 30, darkLimit: -12, horizon: '',
                isDefault: true, browserTz: tz
            },
            rig: {
                preset: 'c8-reduced-atr585m',
                ...RIG_PRESETS['c8-reduced-atr585m'],
                filter: 'L', gain: 100, offset: 30, seeing: 3.0, maxDefocus: 20, overhead: 3, minExposure: 1,
                saturationFraction: 0.7, redNoise: 0.0006
            },
            criteria: { baseline: 30, goSnr: 10, marginalSnr: 5 },
            imaging: { darkLimit: -18, minHours: 1.5, maxSub: 180, swamp: 10, readNoise: 2.74, maxIntegration: 12 },
            cloud: { endpoint: 'https://observing-vault.nic5153mcclure.workers.dev' }
        };
    }

    function merge(base, extra) {
        const out = { ...base };
        for (const [key, value] of Object.entries(extra || {})) {
            out[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object'
                ? merge(base[key], value)
                : value;
        }
        return out;
    }

    function readJson(key) {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
    }

    function migrateLegacy(settings) {
        const site = readJson('observingSite');
        if (site && Number.isFinite(Number(site.lat)) && Number.isFinite(Number(site.lon))) {
            settings.site.lat = Number(site.lat);
            settings.site.lon = Number(site.lon);
            settings.site.name = site.name && site.name !== 'Transit planner site' ? site.name : 'Saved site';
            settings.site.tz = settings.site.browserTz;
            settings.site.isDefault = false;
        }
        const rigs = readJson('observingRigProfiles');
        const rigId = localStorage.getItem('observingRigId');
        const custom = Array.isArray(rigs) ? rigs.find(rig => rig.id === rigId) : null;
        if (custom && custom.aperture && custom.nativeFocalLength && custom.pixelSize) {
            settings.rig = {
                ...settings.rig, preset: 'custom', name: custom.name,
                aperture: Number(custom.aperture), focalLength: Number(custom.nativeFocalLength),
                reducer: Number(custom.reducer || 1), pixelSize: Number(custom.pixelSize),
                sensorW: Number(custom.sensorWidthPx), sensorH: Number(custom.sensorHeightPx),
                camera: custom.camera || 'Custom camera'
            };
        }
        return settings;
    }

    function load() {
        const stored = readJson(KEY);
        if (stored && stored.version === 2) return merge(defaults(), stored);
        return migrateLegacy(defaults());
    }

    function save(settings) {
        try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage full or blocked */ }
        // Keep the legacy key in sync so older pages and the data vault agree on the site.
        try {
            localStorage.setItem('observingSite', JSON.stringify({ name: settings.site.name, lat: settings.site.lat, lon: settings.site.lon }));
        } catch { /* ignore */ }
    }

    function skyMu(settings) {
        const s = settings.site;
        return Number.isFinite(Number(s.sqm)) && Number(s.sqm) > 15 ? Number(s.sqm) : (global.Astro.BORTLE_SQM[s.bortle] || 19.5);
    }

    /** Parse "az:alt, az:alt" horizon points into a sorted list; returns null if empty. */
    function parseHorizon(text) {
        const points = String(text || '').split(/[,;\n]+/).map(part => part.trim()).filter(Boolean).map(part => {
            const [az, alt] = part.split(/[:=\s]+/).map(Number);
            return Number.isFinite(az) && Number.isFinite(alt) ? { az: ((az % 360) + 360) % 360, alt } : null;
        }).filter(Boolean).sort((a, b) => a.az - b.az);
        return points.length ? points : null;
    }

    /** Minimum altitude allowed at azimuth `az` (linear interpolation around the circle). */
    function horizonAlt(points, az) {
        if (!points) return -90;
        if (points.length === 1) return points[0].alt;
        for (let i = 0; i < points.length; i += 1) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            const span = (b.az - a.az + 360) % 360 || 360;
            const offset = (az - a.az + 360) % 360;
            if (offset <= span) return a.alt + (b.alt - a.alt) * offset / span;
        }
        return points[0].alt;
    }

    /** Geocode a place name with Open-Meteo (CORS-enabled; returns elevation and IANA time zone). */
    async function geocode(query) {
        const url = `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: query, count: '6', language: 'en', format: 'json' })}`;
        const response = await fetch(url);
        const data = await response.json();
        return (data.results || []).map(r => ({
            name: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
            lat: r.latitude, lon: r.longitude, elevation: r.elevation, tz: r.timezone
        }));
    }

    /** Elevation and time zone for coordinates (used after GPS or manual entry). */
    async function lookupPoint(lat, lon) {
        const url = `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), current: 'temperature_2m', timezone: 'auto' })}`;
        const data = await (await fetch(url)).json();
        return { tz: data.timezone, elevation: data.elevation };
    }

    /** Hourly cloud cover / precipitation / wind for the site, times in UTC ms. */
    async function weather(site) {
        const params = new URLSearchParams({
            latitude: site.lat.toFixed(4), longitude: site.lon.toFixed(4),
            hourly: 'cloud_cover,precipitation_probability,relative_humidity_2m,wind_speed_10m',
            wind_speed_unit: 'mph', forecast_days: '7', timezone: 'GMT'
        });
        const data = await (await fetch(`https://api.open-meteo.com/v1/forecast?${params}`)).json();
        const h = data.hourly || {};
        return (h.time || []).map((time, i) => ({
            ms: Date.parse(`${time}:00Z`),
            cloud: h.cloud_cover?.[i], rain: h.precipitation_probability?.[i],
            humidity: h.relative_humidity_2m?.[i], wind: h.wind_speed_10m?.[i]
        }));
    }

    global.NVSettings = { KEY, RIG_PRESETS, defaults, load, save, skyMu, parseHorizon, horizonAlt, geocode, lookupPoint, weather };
})(window);
