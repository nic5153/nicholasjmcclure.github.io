/*
 * NightVector night geometry shared by the planners: a 5-minute grid over the
 * night (Sun, Moon, sidereal time) and per-target altitude tracks with the
 * intervals in which the target is usable (dark, above the altitude limit and
 * the horizon mask).
 */
(function (global) {
    'use strict';

    const A = global.Astro;
    const NV = global.NVSettings;
    const MIN = 1 / 1440;
    const clamp = A.clamp;

    function buildGrid(night, settings, { darkLimit = Number(settings.site.darkLimit) || -12, minAlt = Number(settings.site.minAlt) || 30 } = {}) {
        const site = settings.site;
        const step = 5 * MIN;
        const start = night.sunset ?? night.jd0;
        const end = night.sunrise ?? night.jd1;
        const jds = [];
        for (let jd = start; jd <= end + 1e-9; jd += step) jds.push(jd);
        const n = jds.length;
        const cosL = new Float64Array(n);
        const sinL = new Float64Array(n);
        const sunAlt = new Float64Array(n);
        const moonAlt = new Float64Array(n);
        const moonRa = new Float64Array(n);
        const moonDec = new Float64Array(n);
        for (let i = 0; i < n; i += 1) {
            const l = A.lst(jds[i], site.lon);
            cosL[i] = A.cosd(l);
            sinL[i] = A.sind(l);
            sunAlt[i] = A.sunAlt(jds[i], site.lat, site.lon);
            const m = A.moonAltAz(jds[i], site.lat, site.lon);
            moonAlt[i] = m.alt;
            moonRa[i] = m.ra;
            moonDec[i] = m.dec;
        }
        return {
            jds, n, step, start, end, cosL, sinL, sunAlt, moonAlt, moonRa, moonDec,
            sinPhi: A.sind(site.lat), cosPhi: A.cosd(site.lat), lat: site.lat,
            minAlt, darkLimit,
            horizon: NV.parseHorizon(site.horizon),
            moonPhase: A.moonPhase(night.midnight),
            precessJd: night.midnight,
            sky: NV.skyMu(settings),
            night
        };
    }

    function frac(grid, jd) {
        return clamp((jd - grid.start) / grid.step, 0, grid.n - 1);
    }

    function sample(grid, arr, jd) {
        const f = frac(grid, jd);
        const i = Math.floor(f);
        const j = Math.min(grid.n - 1, i + 1);
        return arr[i] + (arr[j] - arr[i]) * (f - i);
    }

    /** Altitude track and usable intervals (dark + above altitude/horizon limits) for RA/Dec J2000. */
    function track(grid, ra, dec) {
        const maxPossible = 90 - Math.abs(grid.lat - dec);
        if (maxPossible < grid.minAlt) return null;
        const p = A.precess(ra, dec, grid.precessJd);
        const ca = A.cosd(p.ra);
        const sa = A.sind(p.ra);
        const sd = A.sind(p.dec);
        const cd = A.cosd(p.dec);
        const alt = new Float32Array(grid.n);
        const margin = new Float32Array(grid.n);
        let maxAlt = -90;
        for (let i = 0; i < grid.n; i += 1) {
            const cosH = grid.cosL[i] * ca + grid.sinL[i] * sa;
            const a = Math.asin(clamp(sd * grid.sinPhi + cd * grid.cosPhi * cosH, -1, 1)) * A.R2D;
            alt[i] = a;
            if (a > maxAlt) maxAlt = a;
            let limit = grid.minAlt;
            if (grid.horizon) {
                const sinH = grid.sinL[i] * ca - grid.cosL[i] * sa;
                const az = A.norm360(Math.atan2(-sinH * cd, sd * grid.cosPhi - cd * grid.sinPhi * cosH) * A.R2D);
                limit = Math.max(limit, NV.horizonAlt(grid.horizon, az));
            }
            margin[i] = Math.min(a - limit, grid.darkLimit - grid.sunAlt[i]);
        }
        if (maxAlt < grid.minAlt) return null;
        const intervals = [];
        let open = null;
        const cross = (i, j) => grid.jds[i] + (grid.jds[j] - grid.jds[i]) * margin[i] / (margin[i] - margin[j]);
        for (let i = 0; i < grid.n; i += 1) {
            const ok = margin[i] >= 0;
            if (ok && open === null) open = i === 0 ? grid.jds[0] : cross(i - 1, i);
            if (!ok && open !== null) { intervals.push([open, cross(i - 1, i)]); open = null; }
        }
        if (open !== null) intervals.push([open, grid.jds[grid.n - 1]]);
        if (!intervals.length) return null;
        return {
            ra: p.ra, dec: p.dec, alt, intervals, maxAlt,
            usableHours: intervals.reduce((sum, iv) => sum + (iv[1] - iv[0]) * 24, 0),
            galLat: A.galacticLatitude(ra, dec)
        };
    }

    function coverInterval(intervals, a, b) {
        return intervals.find(iv => iv[0] <= a + 0.5 * MIN && iv[1] >= b - 0.5 * MIN) || null;
    }

    function maxOverlap(intervals, a, b) {
        let best = { length: 0, interval: null };
        for (const iv of intervals) {
            const length = Math.min(iv[1], b) - Math.max(iv[0], a);
            if (length > best.length) best = { length, interval: iv };
        }
        return best;
    }

    function altRange(grid, trk, a, b) {
        let lo = 90; let hi = -90;
        for (let jd = a; jd <= b + 1e-9; jd += 5 * MIN) {
            const v = sample(grid, trk.alt, jd);
            lo = Math.min(lo, v); hi = Math.max(hi, v);
        }
        const last = sample(grid, trk.alt, b);
        return [Math.min(lo, last), Math.max(hi, last)];
    }

    /** Time of highest altitude inside an interval. */
    function culmination(grid, trk, iv) {
        let best = iv[0]; let bestAlt = -90;
        for (let jd = iv[0]; jd <= iv[1]; jd += 5 * MIN) {
            const v = sample(grid, trk.alt, jd);
            if (v > bestAlt) { bestAlt = v; best = jd; }
        }
        return best;
    }

    /** Sky brightness, airmass and Moon geometry for a tracked target at time jd. */
    function conditions(grid, trk, jd, filter = 'L') {
        const alt = sample(grid, trk.alt, jd);
        const i = Math.round(frac(grid, jd));
        const moonAlt = sample(grid, grid.moonAlt, jd);
        const moonSep = A.separation(trk.ra, trk.dec, grid.moonRa[i], grid.moonDec[i]);
        const sunAltDeg = sample(grid, grid.sunAlt, jd);
        const band = A.BANDS[filter] || A.BANDS.L;
        const sky = A.skyBrightness({
            darkZenith: grid.sky, targetAlt: Math.max(alt, 5), moonAlt, moonSep,
            moonPhaseAngle: grid.moonPhase.phaseAngle, sunAltDeg, k: band.k
        });
        return { alt, X: A.airmass(Math.max(alt, 5)), moonAlt, moonSep, sunAlt: sunAltDeg, sky };
    }

    /** SVG altitude chart for the night with twilight shading, usable band and an optional highlighted window. */
    function altitudeChart(grid, trk, { tz, color = '#8fd3ff', window = null, mark = null, label = 'target' } = {}) {
        const W = 640; const H = 210; const L = 30; const R = 8; const T = 10; const B = 22;
        const span = grid.end - grid.start;
        const x = jd => L + (jd - grid.start) / span * (W - L - R);
        const y = alt => T + (90 - clamp(alt, 0, 90)) / 90 * (H - T - B);
        let shade = '';
        for (let i = 0; i < grid.n - 1; i += 1) {
            const sun = grid.sunAlt[i];
            const opacity = sun > -6 ? 0.30 : sun > -12 ? 0.18 : sun > -18 ? 0.08 : 0;
            if (opacity) shade += `<rect x="${x(grid.jds[i]).toFixed(1)}" y="${T}" width="${(x(grid.jds[i + 1]) - x(grid.jds[i]) + 0.6).toFixed(1)}" height="${H - T - B}" fill="#8fb3ff" opacity="${opacity}"/>`;
        }
        const usable = trk.intervals.map(iv => `<rect x="${x(iv[0]).toFixed(1)}" y="${H - B - 4}" width="${(x(iv[1]) - x(iv[0])).toFixed(1)}" height="4" fill="#5ad38c" opacity="0.85"/>`).join('');
        const win = window ? `<rect x="${x(window[0]).toFixed(1)}" y="${T}" width="${Math.max(2, x(window[1]) - x(window[0])).toFixed(1)}" height="${H - T - B}" fill="${color}" opacity="0.16"/>` : '';
        const markLine = mark ? `<line x1="${x(mark).toFixed(1)}" x2="${x(mark).toFixed(1)}" y1="${T}" y2="${H - B}" stroke="${color}" stroke-width="1.5"/>` : '';
        const path = (arr, step = 1) => {
            let d = '';
            for (let i = 0; i < grid.n; i += step) d += `${d ? 'L' : 'M'}${x(grid.jds[i]).toFixed(1)},${y(arr[i]).toFixed(1)}`;
            return d;
        };
        const gridLines = [0, 30, 60, 90].map(a => `<line x1="${L}" x2="${W - R}" y1="${y(a)}" y2="${y(a)}" stroke="rgba(148,163,184,0.15)"/><text x="${L - 6}" y="${y(a) + 3}" text-anchor="end">${a}°</text>`).join('');
        const minAlt = `<line x1="${L}" x2="${W - R}" y1="${y(grid.minAlt)}" y2="${y(grid.minAlt)}" stroke="#f28b82" stroke-dasharray="4 4" opacity="0.7"/>`;
        let ticks = '';
        const firstHour = Math.ceil((grid.start - 2440587.5) * 24) / 24 + 2440587.5;
        for (let jd = firstHour; jd < grid.end; jd += 1 / 24) {
            const hh = A.formatTime(A.msFromJd(jd), tz).slice(0, 2);
            if (Number(hh) % 2) continue;
            ticks += `<text x="${x(jd).toFixed(1)}" y="${H - 6}" text-anchor="middle">${hh}</text>`;
        }
        const now = A.jdFromMs(Date.now());
        const nowLine = now > grid.start && now < grid.end ? `<line x1="${x(now)}" x2="${x(now)}" y1="${T}" y2="${H - B}" stroke="#f3c45a" stroke-width="1"/>` : '';
        const legend = `<g transform="translate(${L + 8},${T + 12})"><line x1="0" x2="14" y1="-3" y2="-3" stroke="#e7ecf6" stroke-width="2"/><text x="18" y="0">${label}</text>`
            + `<line x1="70" x2="84" y1="-3" y2="-3" stroke="#9aa8bf" stroke-dasharray="3 3"/><text x="88" y="0">moon</text>`
            + `<rect x="128" y="-5" width="14" height="4" fill="#5ad38c"/><text x="146" y="0">usable</text></g>`;
        return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Altitude through the night">
            ${shade}${gridLines}${minAlt}${win}${usable}
            <path d="${path(grid.moonAlt, 2)}" fill="none" stroke="#9aa8bf" stroke-width="1.2" stroke-dasharray="3 4" opacity="0.8"/>
            <path d="${path(trk.alt)}" fill="none" stroke="#e7ecf6" stroke-width="2"/>
            ${markLine}${nowLine}${ticks}${legend}
        </svg>`;
    }

    /** DSS2 colour cutout (CDS hips2fits) covering `scale` x the camera field, north up. */
    function fieldImageUrl(ra, dec, optics, scale = 1.25, width = 640) {
        const aspect = optics.fovH / optics.fovW;
        const params = new URLSearchParams({
            hips: 'CDS/P/DSS2/color', width: String(width), height: String(Math.round(width * aspect)),
            fov: String((optics.fovW * scale / 60).toFixed(4)), projection: 'TAN', coordsys: 'icrs',
            ra: String(ra), dec: String(dec), format: 'jpg'
        });
        return `https://alasky.cds.unistra.fr/hips-image-services/hips2fits?${params}`;
    }

    global.NVSky = { MIN, buildGrid, sample, frac, track, coverInterval, maxOverlap, altRange, culmination, conditions, altitudeChart, fieldImageUrl };
})(window);
