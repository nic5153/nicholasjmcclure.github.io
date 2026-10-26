/*
 * NightVector astronomy + photometry core.
 *
 * Plain script (no build step); exposes window.Astro.  Accuracy targets are
 * those that matter for planning a night with a small telescope:
 *   - Sun position ~0.01 deg, Moon ~0.3 deg (Astronomical Almanac low-precision series)
 *   - twilight / rise / set times to ~1 min
 *   - BJD_TDB / HJD -> UTC conversions to ~10 s (Sun used as barycentre proxy)
 *   - photometric noise from a standard CCD equation + scintillation (Young 1967,
 *     Osborn et al. 2015) + comparison-star noise; sky from Krisciunas & Schaefer (1991).
 */
(function (global) {
    'use strict';

    const D2R = Math.PI / 180;
    const R2D = 180 / Math.PI;
    const J2000 = 2451545.0;
    const DAY_MS = 86400000;
    const TT_MINUS_UTC_DAYS = 69.184 / 86400; // TAI-UTC = 37 s (since 2017) + 32.184 s
    const AU_LIGHT_DAYS = 499.004783836 / 86400;

    const sind = x => Math.sin(x * D2R);
    const cosd = x => Math.cos(x * D2R);
    const tand = x => Math.tan(x * D2R);
    const asind = x => Math.asin(Math.max(-1, Math.min(1, x))) * R2D;
    const atan2d = (y, x) => Math.atan2(y, x) * R2D;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const norm360 = x => ((x % 360) + 360) % 360;
    const norm180 = x => { const v = norm360(x); return v > 180 ? v - 360 : v; };

    // ------------------------------------------------------------------ time

    const jdFromMs = ms => ms / DAY_MS + 2440587.5;
    const msFromJd = jd => (jd - 2440587.5) * DAY_MS;
    const jdFromDate = date => jdFromMs(+date);
    const dateFromJd = jd => new Date(msFromJd(jd));

    /** Offset of an IANA zone from UTC in minutes at the given instant (positive east). */
    function tzOffsetMinutes(timeZone, ms) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).formatToParts(new Date(ms));
        const get = type => Number(parts.find(p => p.type === type).value);
        const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
        return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
    }

    /** UTC instant (ms) of a wall-clock time in an IANA zone. */
    function zonedToUtc(timeZone, year, month, day, hour = 0, minute = 0) {
        let guess = Date.UTC(year, month - 1, day, hour, minute);
        for (let i = 0; i < 3; i += 1) {
            const offset = tzOffsetMinutes(timeZone, guess);
            const next = Date.UTC(year, month - 1, day, hour, minute) - offset * 60000;
            if (next === guess) break;
            guess = next;
        }
        return guess;
    }

    /** Calendar date (YYYY-MM-DD) of an instant in a zone. */
    function zonedDateString(timeZone, ms) {
        return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    }

    function addDays(dateString, days) {
        const [y, m, d] = dateString.split('-').map(Number);
        const t = new Date(Date.UTC(y, m - 1, d + days));
        return t.toISOString().slice(0, 10);
    }

    /** The "observing night" of a date: the evening of that date in the site's zone. */
    function nightDateNow(timeZone, ms = Date.now()) {
        const offsetHours = tzOffsetMinutes(timeZone, ms) / 60;
        const localHour = (new Date(ms).getUTCHours() + offsetHours + 24) % 24;
        const today = zonedDateString(timeZone, ms);
        return localHour < 12 ? addDays(today, -1) : today; // before local noon you are still in last night
    }

    function formatTime(ms, timeZone, withSeconds = false) {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone, hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined, hourCycle: 'h23'
        }).format(new Date(ms));
    }

    function formatDate(ms, timeZone, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
        return new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(new Date(ms));
    }

    function tzAbbrev(timeZone, ms) {
        const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
            .formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName');
        return part ? part.value : timeZone;
    }

    function formatDuration(hours) {
        if (!Number.isFinite(hours)) return '—';
        const totalMinutes = Math.round(hours * 60);
        const h = Math.floor(totalMinutes / 60);
        const m = totalMinutes % 60;
        return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    }

    // ------------------------------------------------------------------ coordinates

    function parseRa(value) {
        if (typeof value === 'number') return value;
        const text = String(value || '').trim();
        if (/^[+-]?\d+(\.\d+)?$/.test(text)) return Number(text);
        const parts = text.split(/[:hms\s]+/).filter(Boolean).map(Number);
        if (parts.length < 2 || parts.some(Number.isNaN)) return NaN;
        return (parts[0] + parts[1] / 60 + (parts[2] || 0) / 3600) * 15;
    }

    function parseDec(value) {
        if (typeof value === 'number') return value;
        const text = String(value || '').trim();
        if (/^[+-]?\d+(\.\d+)?$/.test(text)) return Number(text);
        const sign = text.startsWith('-') ? -1 : 1;
        const parts = text.replace(/^[+-]/, '').split(/[:d'"°\s]+/).filter(Boolean).map(Number);
        if (parts.length < 2 || parts.some(Number.isNaN)) return NaN;
        return sign * (parts[0] + parts[1] / 60 + (parts[2] || 0) / 3600);
    }

    function formatRa(deg, digits = 1) {
        const total = norm360(deg) / 15;
        let h = Math.floor(total);
        let m = Math.floor((total - h) * 60);
        let s = ((total - h) * 60 - m) * 60;
        if (Number(s.toFixed(digits)) >= 60) { s = 0; m += 1; }
        if (m >= 60) { m = 0; h = (h + 1) % 24; }
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(digits).padStart(digits ? 3 + digits : 2, '0')}`;
    }

    function formatDec(deg, digits = 0) {
        const sign = deg < 0 ? '-' : '+';
        const a = Math.abs(deg);
        let d = Math.floor(a);
        let m = Math.floor((a - d) * 60);
        let s = ((a - d) * 60 - m) * 60;
        if (Number(s.toFixed(digits)) >= 60) { s = 0; m += 1; }
        if (m >= 60) { m = 0; d += 1; }
        return `${sign}${String(d).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(digits).padStart(digits ? 3 + digits : 2, '0')}`;
    }

    function separation(ra1, dec1, ra2, dec2) {
        const c = sind(dec1) * sind(dec2) + cosd(dec1) * cosd(dec2) * cosd(ra1 - ra2);
        return Math.acos(clamp(c, -1, 1)) * R2D;
    }

    /** IAU 1976 precession of J2000 coordinates to the mean equinox of jd (Meeus 21.4). */
    function precess(raDeg, decDeg, jd) {
        const t = (jd - J2000) / 36525;
        const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) / 3600;
        const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) / 3600;
        const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) / 3600;
        const a = cosd(decDeg) * sind(raDeg + zeta);
        const b = cosd(theta) * cosd(decDeg) * cosd(raDeg + zeta) - sind(theta) * sind(decDeg);
        const c = sind(theta) * cosd(decDeg) * cosd(raDeg + zeta) + cosd(theta) * sind(decDeg);
        return { ra: norm360(atan2d(a, b) + z), dec: asind(c) };
    }

    function galacticLatitude(raDeg, decDeg) {
        return asind(sind(decDeg) * sind(27.12825) + cosd(decDeg) * cosd(27.12825) * cosd(raDeg - 192.85948));
    }

    /** Greenwich mean sidereal time in degrees (IAU 1982; UT1 ~ UTC). */
    function gmst(jd) {
        const t = (jd - J2000) / 36525;
        return norm360(280.46061837 + 360.98564736629 * (jd - J2000) + 0.000387933 * t * t - t * t * t / 38710000);
    }

    const lst = (jd, lonDeg) => norm360(gmst(jd) + lonDeg);

    /** Altitude / azimuth (deg; azimuth from north through east). */
    function altAz(raDeg, decDeg, latDeg, lstDeg) {
        const ha = lstDeg - raDeg;
        const sinAlt = sind(decDeg) * sind(latDeg) + cosd(decDeg) * cosd(latDeg) * cosd(ha);
        const alt = asind(sinAlt);
        const y = -sind(ha) * cosd(decDeg);
        const x = sind(decDeg) * cosd(latDeg) - cosd(decDeg) * sind(latDeg) * cosd(ha);
        return { alt, az: norm360(atan2d(y, x)), ha: norm180(ha) };
    }

    /** Airmass (Kasten & Young 1989); null below the horizon. */
    function airmass(altDeg) {
        if (!(altDeg > 0)) return null;
        return 1 / (sind(altDeg) + 0.50572 * Math.pow(altDeg + 6.07995, -1.6364));
    }

    // ------------------------------------------------------------------ Sun & Moon

    /** Low-precision Sun (Astronomical Almanac); equatorial of date. */
    function sun(jd) {
        const n = jd - J2000;
        const L = norm360(280.460 + 0.9856474 * n);
        const g = norm360(357.528 + 0.9856003 * n);
        const lambda = norm360(L + 1.915 * sind(g) + 0.020 * sind(2 * g));
        const eps = 23.439 - 0.0000004 * n;
        const r = 1.00014 - 0.01671 * cosd(g) - 0.00014 * cosd(2 * g);
        return {
            ra: norm360(atan2d(cosd(eps) * sind(lambda), cosd(lambda))),
            dec: asind(sind(eps) * sind(lambda)),
            lambda, eps, r
        };
    }

    /** Low-precision Moon (Astronomical Almanac, ~0.3 deg); geocentric equatorial of date. */
    function moon(jd) {
        const t = (jd - J2000) / 36525;
        const lambda = norm360(218.32 + 481267.881 * t
            + 6.29 * sind(135.0 + 477198.87 * t) - 1.27 * sind(259.3 - 413335.36 * t)
            + 0.66 * sind(235.7 + 890534.22 * t) + 0.21 * sind(269.9 + 954397.74 * t)
            - 0.19 * sind(357.5 + 35999.05 * t) - 0.11 * sind(186.5 + 966404.03 * t));
        const beta = 5.13 * sind(93.3 + 483202.02 * t) + 0.28 * sind(228.2 + 960400.89 * t)
            - 0.28 * sind(318.3 + 6003.15 * t) - 0.17 * sind(217.6 - 407332.21 * t);
        const parallax = 0.9508 + 0.0518 * cosd(135.0 + 477198.87 * t) + 0.0095 * cosd(259.3 - 413335.36 * t)
            + 0.0078 * cosd(235.7 + 890534.22 * t) + 0.0028 * cosd(269.9 + 954397.74 * t);
        const eps = 23.439 - 0.0000004 * (jd - J2000);
        const l = cosd(beta) * cosd(lambda);
        const m = cosd(eps) * cosd(beta) * sind(lambda) - sind(eps) * sind(beta);
        const nn = sind(eps) * cosd(beta) * sind(lambda) + cosd(eps) * sind(beta);
        return { ra: norm360(atan2d(m, l)), dec: asind(nn), lambda, beta, parallax, distanceKm: 6378.14 / sind(parallax) };
    }

    /** Topocentric lunar altitude: geocentric altitude minus parallax in altitude. */
    function moonAltAz(jd, latDeg, lonDeg) {
        const m = moon(jd);
        const h = altAz(m.ra, m.dec, latDeg, lst(jd, lonDeg));
        return { ...h, alt: h.alt - asind(sind(m.parallax) * cosd(h.alt)), ra: m.ra, dec: m.dec };
    }

    function sunAlt(jd, latDeg, lonDeg) {
        const s = sun(jd);
        return altAz(s.ra, s.dec, latDeg, lst(jd, lonDeg)).alt;
    }

    /** Illuminated fraction, phase angle (deg, 0 = full) and waxing flag. */
    function moonPhase(jd) {
        const s = sun(jd);
        const m = moon(jd);
        const elong = Math.acos(clamp(sind(s.dec) * sind(m.dec) + cosd(s.dec) * cosd(m.dec) * cosd(s.ra - m.ra), -1, 1)) * R2D;
        const rSunKm = s.r * 149597870.7;
        const phaseAngle = atan2d(rSunKm * sind(elong), m.distanceKm - rSunKm * cosd(elong));
        return {
            fraction: (1 + cosd(phaseAngle)) / 2,
            phaseAngle: Math.abs(phaseAngle),
            waxing: norm360(m.lambda - s.lambda) < 180,
            elongation: elong
        };
    }

    /** Roots of f(jd) - level between jd0 and jd1, scanned at `step` days and refined by bisection. */
    function crossings(f, level, jd0, jd1, step = 10 / 1440) {
        const out = [];
        let a = jd0;
        let fa = f(a) - level;
        for (let b = jd0 + step; b <= jd1 + 1e-9; b += step) {
            const fb = f(b) - level;
            if (fa === 0 || fa * fb < 0) {
                let lo = a; let hi = b; let flo = fa;
                for (let i = 0; i < 18; i += 1) {
                    const mid = (lo + hi) / 2;
                    const fm = f(mid) - level;
                    if (flo * fm <= 0) { hi = mid; } else { lo = mid; flo = fm; }
                }
                out.push({ jd: (lo + hi) / 2, rising: fb > fa });
            }
            a = b; fa = fb;
        }
        return out;
    }

    /**
     * Night summary for the evening of `dateString` (YYYY-MM-DD, site-local) from local noon to the next noon.
     * `darkLimit` is the Sun altitude that counts as dark enough to observe (e.g. -12).
     */
    function night(dateString, site, darkLimit = -12) {
        const [y, m, d] = dateString.split('-').map(Number);
        const startMs = zonedToUtc(site.tz, y, m, d, 12, 0);
        const endMs = zonedToUtc(site.tz, ...addDays(dateString, 1).split('-').map(Number), 12, 0);
        const jd0 = jdFromMs(startMs);
        const jd1 = jdFromMs(endMs);
        const sunF = jd => sunAlt(jd, site.lat, site.lon);
        const pick = (level, rising) => {
            const hit = crossings(sunF, level, jd0, jd1, 5 / 1440).find(c => c.rising === rising);
            return hit ? hit.jd : null;
        };
        const events = {
            sunset: pick(-0.833, false), sunrise: pick(-0.833, true),
            civilDusk: pick(-6, false), civilDawn: pick(-6, true),
            nauticalDusk: pick(-12, false), nauticalDawn: pick(-12, true),
            astroDusk: pick(-18, false), astroDawn: pick(-18, true)
        };
        // Dark window at the chosen limit; polar edge cases fall back to "always" / "never".
        let darkStart = pick(darkLimit, false);
        let darkEnd = pick(darkLimit, true);
        const midAlt = sunF((jd0 + jd1) / 2);
        if (darkStart === null && darkEnd === null) {
            if (midAlt <= darkLimit) { darkStart = jd0; darkEnd = jd1; }
        } else {
            if (darkStart === null) darkStart = jd0;
            if (darkEnd === null) darkEnd = jd1;
        }
        const moonF = jd => moonAltAz(jd, site.lat, site.lon).alt;
        // Topocentric centre at -0.833 deg (refraction + semidiameter) marks rise/set.
        const moonEvents = crossings(moonF, -0.833, jd0, jd1, 10 / 1440);
        const midnight = darkStart !== null && darkEnd !== null ? (darkStart + darkEnd) / 2 : (jd0 + jd1) / 2;
        const phase = moonPhase(midnight);
        return {
            date: dateString, jd0, jd1, startMs, endMs, darkLimit,
            ...events,
            darkStart, darkEnd,
            darkHours: darkStart !== null && darkEnd !== null ? (darkEnd - darkStart) * 24 : 0,
            midnight,
            moonRise: (moonEvents.find(e => e.rising) || {}).jd ?? null,
            moonSet: (moonEvents.find(e => !e.rising) || {}).jd ?? null,
            moon: { ...phase, ...moonAltAz(midnight, site.lat, site.lon) }
        };
    }

    // ------------------------------------------------------------------ timing corrections

    /** Light-time correction (days) from Earth to the Sun for a target; HJD = JD + value. */
    function lightTimeToSun(jd, raDeg, decDeg) {
        const s = sun(jd);
        // Earth's heliocentric position is minus the Sun's geocentric position.
        const x = -s.r * cosd(s.lambda);
        const yEcl = -s.r * sind(s.lambda);
        const X = x;
        const Y = yEcl * cosd(s.eps);
        const Z = yEcl * sind(s.eps);
        const nx = cosd(decDeg) * cosd(raDeg);
        const ny = cosd(decDeg) * sind(raDeg);
        const nz = sind(decDeg);
        return (X * nx + Y * ny + Z * nz) * AU_LIGHT_DAYS;
    }

    /** JD(UTC) at which an event with barycentric time BJD_TDB is seen at Earth. */
    function bjdTdbToJdUtc(bjd, raDeg, decDeg) {
        let jd = bjd - TT_MINUS_UTC_DAYS;
        for (let i = 0; i < 3; i += 1) jd = bjd - TT_MINUS_UTC_DAYS - lightTimeToSun(jd, raDeg, decDeg);
        return jd;
    }

    function jdUtcToBjdTdb(jd, raDeg, decDeg) {
        return jd + TT_MINUS_UTC_DAYS + lightTimeToSun(jd, raDeg, decDeg);
    }

    /** JD(UTC) of an event given as HJD (UTC-based, as used by VSX/GCVS). */
    function hjdToJdUtc(hjd, raDeg, decDeg) {
        let jd = hjd;
        for (let i = 0; i < 3; i += 1) jd = hjd - lightTimeToSun(jd, raDeg, decDeg);
        return jd;
    }

    function jdUtcToHjd(jd, raDeg, decDeg) {
        return jd + lightTimeToSun(jd, raDeg, decDeg);
    }

    // ------------------------------------------------------------------ sky brightness

    const BORTLE_SQM = { 1: 21.9, 2: 21.6, 3: 21.4, 4: 20.8, 5: 20.1, 6: 19.5, 7: 18.9, 8: 18.4, 9: 17.8 };

    /**
     * Sky surface brightness (V mag/arcsec^2) at a target, including the Moon
     * (Krisciunas & Schaefer 1991), airmass brightening and twilight.
     */
    function skyBrightness({ darkZenith, targetAlt, moonAlt, moonSep, moonPhaseAngle, sunAltDeg, k = 0.2 }) {
        const Z = 90 - clamp(targetAlt, 1, 90);
        const X = Z2X(Z);
        const nL = mu => 34.08 * Math.exp(20.7233 - 0.92104 * mu);
        let b = nL(darkZenith) * X * Math.pow(10, -0.4 * k * (X - 1));
        if (moonAlt > 0 && Number.isFinite(moonSep)) {
            const alpha = clamp(moonPhaseAngle, 0, 180);
            const I = Math.pow(10, -0.4 * (3.84 + 0.026 * alpha + 4e-9 * Math.pow(alpha, 4)));
            const rho = Math.max(moonSep, 5);
            const f = Math.pow(10, 5.36) * (1.06 + cosd(rho) ** 2) + Math.pow(10, 6.15 - rho / 40);
            const Xm = Z2X(90 - moonAlt);
            b += f * I * Math.pow(10, -0.4 * k * Xm) * (1 - Math.pow(10, -0.4 * k * X));
        }
        if (Number.isFinite(sunAltDeg) && sunAltDeg > -18) {
            // Twilight: zenith ~17.5 mag/arcsec^2 at -12 deg, fading ~0.65 mag per degree to natural darkness at -18.
            const muTw = 17.5 + 0.65 * (-12 - sunAltDeg);
            b += nL(Math.min(muTw, 21.9));
        }
        return (20.7233 - Math.log(b / 34.08)) / 0.92104;
    }

    function Z2X(zDeg) {
        return 1 / Math.sqrt(1 - 0.96 * sind(Math.min(zDeg, 89.9)) ** 2);
    }

    // ------------------------------------------------------------------ photometry

    /**
     * Band photon zero points: photons s^-1 cm^-2 above the atmosphere for a V = 0 solar-type star.
     * L/clear filters collect ~3x the photons of Johnson V.  k = typical extinction (mag/airmass).
     */
    const BANDS = {
        L: { label: 'Luminance', zp: 2.8e6, k: 0.20 },
        CLEAR: { label: 'No filter (400–1000 nm)', zp: 4.2e6, k: 0.18 },
        V: { label: 'Johnson V', zp: 0.85e6, k: 0.17 },
        G: { label: 'Green', zp: 0.80e6, k: 0.17 },
        R: { label: 'Red', zp: 0.85e6, k: 0.12 },
        B: { label: 'Blue', zp: 0.85e6, k: 0.25 }
    };

    /** Derived optics of a rig profile. */
    function optics(rig) {
        const focal = rig.focalLength * (rig.reducer || 1);
        const scale = 206.265 * rig.pixelSize / focal; // arcsec / px
        const d = rig.aperture / 10; // cm
        const area = Math.PI / 4 * d * d * (1 - (rig.obstruction || 0) ** 2);
        return {
            focal,
            fRatio: focal / rig.aperture,
            scale,
            fovW: scale * rig.sensorW / 60,
            fovH: scale * rig.sensorH / 60,
            area,
            apertureCm: d
        };
    }

    /** Fraction of a Gaussian PSF (FWHM w") falling in the central pixel (pixel p"). */
    function peakFraction(w, p) {
        const sigma = w / 2.3548;
        const e = erf(p / (2 * Math.SQRT2 * sigma));
        return e * e;
    }

    function erf(x) {
        // Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7)
        const s = Math.sign(x);
        const a = Math.abs(x);
        const t = 1 / (1 + 0.3275911 * a);
        const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
        return s * y;
    }

    function roundExposure(t) {
        if (t >= 60) return Math.max(60, Math.round(t / 10) * 10);
        if (t >= 10) return Math.round(t / 5) * 5;
        if (t >= 1) return Math.round(t);
        return Math.round(t * 10) / 10;
    }

    /**
     * Expected number of comparison stars brighter than `mag` in the field (Galactic-latitude scaled
     * star counts: log N(<V) per deg^2 ~ -3.4 + 0.42 V at |b| ~ 30 deg).
     */
    function starsBrighterThan(mag, fieldDeg2, galLat) {
        const density = 0.5 + 3.5 * Math.exp(-Math.abs(galLat) / 15);
        return fieldDeg2 * density * Math.pow(10, -3.4 + 0.42 * mag);
    }

    /** Magnitude at which `n` comparison stars are expected in the field. */
    function comparisonDepthMag(n, fieldDeg2, galLat) {
        const density = 0.5 + 3.5 * Math.exp(-Math.abs(galLat) / 15);
        return (Math.log10(n / (fieldDeg2 * density)) + 3.4) / 0.42;
    }

    /**
     * Plan a time-series exposure and predict differential-photometry noise.
     *   mag        target magnitude (brightest state, used for saturation)
     *   magFaint   magnitude used for noise (e.g. at eclipse minimum); defaults to mag
     *   X          airmass;  sky  sky brightness (V mag/arcsec^2)
     *   tMax       longest exposure the cadence allows (s)
     */
    function photometryPlan({ rig, mag, magFaint = mag, X = 1.2, sky = 19.5, tMax = 60, galLat = 30, elevation = 1000 }) {
        const o = optics(rig);
        const band = BANDS[rig.filter] || BANDS.L;
        const tau = rig.throughput;
        const rate = m => band.zp * Math.pow(10, -0.4 * (m + band.k * X)) * o.area * tau; // e-/s
        const skyPix = band.zp * Math.pow(10, -0.4 * sky) * o.area * tau * o.scale * o.scale; // e-/s/px
        const fullWell = rig.fullWell * (rig.saturationFraction || 0.7);
        const tMin = rig.minExposure || 1;
        const seeing = Math.max(rig.seeing, 1.2 * o.scale);
        const maxDefocus = Math.max(rig.maxDefocus || seeing, seeing);
        const R = rate(mag);
        const peak = (t, w) => R * t * peakFraction(w, o.scale) + skyPix * t + (rig.darkCurrent || 0) * t;

        let t = Math.max(tMin, tMax);
        let w = seeing;
        let tooBright = false;
        if (peak(t, w) > fullWell) {
            // Defocus first (keeps the duty cycle and averages scintillation), then shorten.
            let lo = seeing; let hi = maxDefocus;
            if (peak(t, hi) <= fullWell) {
                for (let i = 0; i < 30; i += 1) { const mid = (lo + hi) / 2; if (peak(t, mid) > fullWell) lo = mid; else hi = mid; }
                w = Math.ceil(hi * 2) / 2;
            } else {
                w = maxDefocus;
                const perSecond = R * peakFraction(w, o.scale) + skyPix + (rig.darkCurrent || 0);
                t = fullWell / perSecond;
                if (t < tMin) { tooBright = true; t = tMin; }
            }
        }
        t = Math.max(tMin, roundExposure(t));
        for (let i = 0; i < 20 && !tooBright && t > tMin && peak(t, w) > fullWell * 1.02; i += 1) {
            t = Math.max(tMin, roundExposure(t * 0.85));
        }

        const apRadius = Math.max(1.2 * w, 3 * o.scale); // arcsec, encloses ~98% of a Gaussian
        const npix = Math.PI * (apRadius / o.scale) ** 2;
        const scint = 1.5 * 0.09 * Math.pow(o.apertureCm, -2 / 3) * Math.pow(X, 1.75) * Math.exp(-(elevation || 0) / 8000) / Math.sqrt(2 * t);
        const frameNoise = m => {
            const n = rate(m) * t * 0.98;
            const variance = n + npix * (skyPix * t + (rig.darkCurrent || 0) * t + rig.readNoise ** 2) + (scint * n) ** 2;
            return { n, sigma: Math.sqrt(variance) / n };
        };
        const target = frameNoise(magFaint);
        // Ensemble of comparison stars: as bright as the target if the field offers them, else the
        // brightness at which ~3 stars are expected.  Each contributes independent photon+scintillation noise.
        const fieldDeg2 = (o.fovW * o.fovH) / 3600;
        const compMag = Math.max(mag, comparisonDepthMag(3, fieldDeg2, galLat));
        const comp = frameNoise(compMag);
        const nComp = 3;
        const sigmaFrame = Math.sqrt(target.sigma ** 2 + comp.sigma ** 2 / nComp);
        const cadence = t + (rig.overhead || 0);
        return {
            exposure: t,
            cadence,
            psf: w,
            defocused: w > seeing + 0.25,
            tooBright,
            peakElectrons: peak(t, w),
            peakFraction: peak(t, w) / rig.fullWell,
            starElectrons: target.n,
            skyPerPixel: skyPix * t,
            apertureRadius: apRadius,
            sigmaFrame,
            sigmaTarget: target.sigma,
            sigmaComp: comp.sigma / Math.sqrt(nComp),
            scintillation: scint,
            compMag,
            compsAvailable: starsBrighterThan(mag + 1, fieldDeg2, galLat),
            /** Noise of the mean over `seconds` of data, with a correlated floor. */
            binned(seconds, floor = rig.redNoise || 0) {
                const n = Math.max(1, Math.floor(seconds / cadence));
                return Math.sqrt(sigmaFrame * sigmaFrame / n + floor * floor);
            },
            framesIn: seconds => Math.max(1, Math.floor(seconds / cadence))
        };
    }

    /** Sky-limited sub-exposure (Glover criterion: sky >= swamp * RN^2) for imaging. */
    function skyLimitedSub({ rig, sky, filter = rig.filter, swamp = 10 }) {
        const o = optics(rig);
        const band = BANDS[filter] || BANDS.L;
        const skyPix = band.zp * Math.pow(10, -0.4 * sky) * o.area * rig.throughput * o.scale * o.scale;
        return { seconds: swamp * rig.readNoise ** 2 / skyPix, skyPerSecond: skyPix };
    }

    /** Surface-brightness SNR for extended objects: hours to reach `snr` per (2" x 2") element. */
    function hoursForSurfaceBrightness({ rig, mu, sky, filter = rig.filter, snr = 10, element = 4 }) {
        const o = optics(rig);
        const band = BANDS[filter] || BANDS.L;
        const perArcsec = m => band.zp * Math.pow(10, -0.4 * m) * o.area * rig.throughput; // e-/s/arcsec^2
        const s = perArcsec(mu) * element;
        const b = perArcsec(sky) * element;
        // Sky-limited: SNR = s t / sqrt((s + b) t)  ->  t = snr^2 (s + b) / s^2
        return snr * snr * (s + b) / (s * s) / 3600;
    }

    global.Astro = {
        D2R, R2D, J2000, TT_MINUS_UTC_DAYS, BORTLE_SQM, BANDS,
        sind, cosd, tand, clamp, norm360, norm180,
        jdFromMs, msFromJd, jdFromDate, dateFromJd,
        tzOffsetMinutes, zonedToUtc, zonedDateString, addDays, nightDateNow,
        formatTime, formatDate, formatDuration, tzAbbrev,
        parseRa, parseDec, formatRa, formatDec, separation, precess, galacticLatitude,
        gmst, lst, altAz, airmass,
        sun, moon, moonAltAz, sunAlt, moonPhase, crossings, night,
        lightTimeToSun, bjdTdbToJdUtc, jdUtcToBjdTdb, hjdToJdUtc, jdUtcToHjd,
        skyBrightness, optics, peakFraction, photometryPlan, skyLimitedSub, hoursForSurfaceBrightness,
        starsBrighterThan, comparisonDepthMag, roundExposure
    };
})(window);
