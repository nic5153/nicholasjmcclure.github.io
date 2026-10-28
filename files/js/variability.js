/*
 * Variability Analysis planner.
 *
 * For the selected night it predicts every transit, eclipse minimum, pulsation
 * maximum or monitoring window in the catalogs, checks that the whole window is
 * dark and above the site's altitude/horizon limits, builds an exposure plan for
 * the rig, predicts the photometric scatter, and classifies each event as
 * Go / Marginal / Skip with the reasons.
 */
(function () {
    'use strict';

    const A = window.Astro;
    const NV = window.NVSettings;
    const $ = id => document.getElementById(id);

    const GROUPS = {
        transit: { label: 'Exoplanet transit', color: 'var(--c-transit)', hex: '#8fd3ff' },
        eclipse: { label: 'Eclipsing binary', color: 'var(--c-eclipse)', hex: '#b7a6ff' },
        pulsator: { label: 'Pulsating star', color: 'var(--c-pulsator)', hex: '#f3c45a' },
        cv: { label: 'Cataclysmic variable', color: 'var(--c-cv)', hex: '#f59fb8' }
    };
    const VSX_GROUP = { EA: 'eclipse', EB: 'eclipse', EW: 'eclipse', CVE: 'cv', CV: 'cv', RR: 'pulsator', DS: 'pulsator', CEP: 'pulsator' };
    const CLASS_LABEL = {
        TRANSIT: 'Transiting exoplanet', EA: 'Detached eclipsing binary', EB: 'β Lyrae-type eclipsing binary',
        EW: 'Contact binary (W UMa)', CVE: 'Eclipsing cataclysmic variable', CV: 'Cataclysmic variable',
        RR: 'RR Lyrae star', DS: 'δ Scuti / SX Phoenicis star', CEP: 'Cepheid'
    };
    const SHORTLIST_SIZE = { transit: 8, eclipse: 8, pulsator: 6, cv: 4 };
    const PAGE_SIZE = 60;

    const state = {
        settings: NV.load(),
        date: null,
        night: null,
        grid: null,
        targets: [],
        catalogDates: {},
        results: [],
        tab: 'shortlist',
        showMarginal: true,
        showRejected: false,
        sort: 'time',
        search: '',
        limit: PAGE_SIZE,
        selectedId: null,
        plan: readPlan(),
        computing: false
    };

    // ------------------------------------------------------------------ utilities

    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const clamp = A.clamp;
    const norm = text => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const fmt = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
    const MIN = 1 / 1440;

    function tz() { return state.settings.site.tz || 'UTC'; }
    function t(jd) { return jd == null ? '—' : A.formatTime(A.msFromJd(jd), tz()); }
    function tUtc(jd) { return jd == null ? '—' : A.formatTime(A.msFromJd(jd), 'UTC'); }

    function readPlan() {
        try { return JSON.parse(localStorage.getItem('nv.plan.v1') || '{}') || {}; } catch { return {}; }
    }
    function writePlan() {
        try { localStorage.setItem('nv.plan.v1', JSON.stringify(state.plan)); } catch { /* ignore */ }
    }
    function planIds() { return state.plan[state.date] || []; }

    /** Half a unit in the last quoted decimal: the implied precision of a catalogue value. */
    function periodDecimalsSigma(value) {
        const text = String(value);
        const decimals = text.includes('.') ? text.split('.')[1].length : 0;
        return 0.5 * Math.pow(10, -decimals);
    }

    /** Timing uncertainty (minutes) of a VSX ephemeris after `cycles` periods. */
    function vsxSigmaMinutes(star, cycles) {
        return Math.hypot(periodDecimalsSigma(star.epoch), Math.abs(cycles) * periodDecimalsSigma(star.period)) * 1440;
    }

    function download(filename, text, type) {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    // ------------------------------------------------------------------ catalogs

    async function loadCatalogs() {
        const [planets, variables] = await Promise.all([
            fetch('files/data/exoplanets.json').then(r => r.json()),
            fetch('files/data/variables.json').then(r => r.json())
        ]);
        state.catalogDates = { planets: planets.generated, variables: variables.generated };
        const toObjects = data => data.rows.map(row => Object.fromEntries(data.fields.map((field, i) => [field, row[i]])));
        const targets = [];
        for (const p of toObjects(planets)) {
            if (!(p.period > 0) || !Number.isFinite(p.t0) || !(p.dur_h > 0) || !(p.depth_ppt > 0)) continue;
            targets.push({ kind: 'planet', key: `P:${p.name}`, name: p.name, ra: p.ra, dec: p.dec, group: 'transit', cls: 'TRANSIT', d: p });
        }
        for (const s of toObjects(variables)) {
            const group = VSX_GROUP[s.cls];
            if (!group) continue;
            targets.push({ kind: 'vsx', key: `V:${s.name}`, name: s.name, ra: s.ra, dec: s.dec, group, cls: s.cls, d: s });
        }
        state.targets = targets;
        $('catalog-dates').textContent = `planets ${String(planets.generated).slice(0, 10)}, variable stars ${String(variables.generated).slice(0, 10)}`;
    }

    // ------------------------------------------------------------------ night grid (shared: nv-sky.js)

    const { buildGrid, sample, coverInterval, maxOverlap, altRange, culmination } = window.NVSky;
    const track = (grid, target) => window.NVSky.track(grid, target.ra, target.dec);
    const conditions = (grid, trk, jd) => window.NVSky.conditions(grid, trk, jd, state.settings.rig.filter);

    function photometry(grid, trk, jd, opts) {
        const cond = conditions(grid, trk, jd);
        const plan = A.photometryPlan({
            rig: state.settings.rig, mag: opts.mag, magFaint: opts.magFaint ?? opts.mag, X: cond.X, sky: cond.sky,
            tMax: opts.tMax, galLat: trk.galLat, elevation: state.settings.site.elevation
        });
        return { cond, plan };
    }

    /** Explain why [a, b] is not fully usable. */
    function blockers(grid, trk, a, b) {
        const out = [];
        const check = (jd, edge) => {
            const sun = sample(grid, grid.sunAlt, jd);
            const alt = sample(grid, trk.alt, jd);
            if (jd < grid.start || jd > grid.end || sun > grid.darkLimit) out.push(`${edge} in twilight or daylight (${t(jd)})`);
            else if (alt < grid.minAlt) out.push(`target at ${Math.round(alt)}° (below ${grid.minAlt}°) at ${edge.toLowerCase()} (${t(jd)})`);
            else out.push(`horizon mask blocks the ${edge.toLowerCase()} (${t(jd)})`);
        };
        const startOk = trk.intervals.some(iv => iv[0] <= a && iv[1] >= a);
        const endOk = trk.intervals.some(iv => iv[0] <= b && iv[1] >= b);
        if (!startOk) check(a, 'Start');
        if (!endOk) check(b, 'End');
        if (startOk && endOk) out.push('target dips below the limits during the window');
        return out;
    }

    // ------------------------------------------------------------------ event evaluation

    function baseResult(target, trk, extra) {
        const d = target.d;
        return {
            target, key: target.key, group: target.group, cls: target.cls, name: target.name,
            ra: target.ra, dec: target.dec, raNow: trk.ra, decNow: trk.dec,
            reasons: [], links: [], contacts: [],
            ...extra,
            period: d.period
        };
    }

    function judge(r) {
        const crit = state.settings.criteria;
        if (r.plan && r.plan.tooBright) {
            r.reasons.unshift({ level: 'bad', text: `Too bright: saturates even at ${r.plan.exposure}s with ${state.settings.rig.maxDefocus}" defocus` });
        } else if (Number.isFinite(r.snr)) {
            if (r.snr < crit.marginalSnr) r.reasons.unshift({ level: 'bad', text: `Signal too small for this rig: S/N ≈ ${fmt(r.snr, 1)} (${r.snrBasis})` });
            else if (r.snr < crit.goSnr) r.reasons.unshift({ level: 'warn', text: `Low S/N ≈ ${fmt(r.snr, 1)} (${r.snrBasis})` });
            else r.reasons.unshift({ level: 'good', text: `S/N ≈ ${fmt(r.snr, 0)} (${r.snrBasis})` });
        }
        if (r.cond && r.cond.moonAlt > 0 && r.cond.moonSep < 25) {
            r.reasons.push({ level: r.cond.moonSep < 12 ? 'warn' : 'info', text: `Moon ${Math.round(r.cond.moonSep)}° away (${Math.round(state.grid.moonPhase.fraction * 100)}% lit)` });
        }
        if (r.plan && r.plan.compsAvailable < 2 && !r.plan.tooBright) {
            r.reasons.push({ level: 'info', text: `Few comparison stars of similar brightness in the ${fmt(A.optics(state.settings.rig).fovW, 0)}′ field; ensemble assumed near V ${fmt(r.plan.compMag, 1)}` });
        }
        r.verdict = r.reasons.some(x => x.level === 'bad') ? 'skip' : r.reasons.some(x => x.level === 'warn') ? 'marginal' : 'go';
        r.score = scoreOf(r);
        r.id = `${r.key}|${Math.round(r.t * 1440)}`;
        return r;
    }

    function scoreOf(r) {
        const crit = state.settings.criteria;
        const snrPart = Number.isFinite(r.snr) ? Math.min(r.snr / crit.goSnr, 2.5) / 2.5 : 0;
        const altPart = clamp((r.altMin - 20) / 50, 0, 1);
        const cov = { full: 1, tom: 0.85, run: 0.9, partial: 0.45, none: 0 }[r.coverage] ?? 0.5;
        const moonPart = r.cond && r.cond.moonAlt > 0 ? Math.min(1, r.cond.moonSep / 60) : 1;
        let weight = 1;
        if (r.group === 'transit') {
            weight = { alert: 1.3, high: 1.2, medium: 1.1, low: 1.0, ttv: 1.05 }[r.target.d.flag] ?? 0.95;
        } else if (r.cls === 'EW') weight = 0.85;
        else if (r.cls === 'EB') weight = 0.9;
        else if (r.cls === 'CEP') weight = 0.55;
        else if (r.cls === 'CVE') weight = 1.15;
        else if (r.cls === 'CV') weight = 0.9;
        const verdictFactor = { go: 1, marginal: 0.55, skip: 0.1 }[r.verdict];
        return (0.45 * snrPart + 0.25 * cov + 0.2 * altPart + 0.1 * moonPart) * weight * verdictFactor * catalogQuality(r);
    }

    function ingressDays(p, T14) {
        const k = p.rp_rs || Math.sqrt(p.depth_ppt / 1000);
        let b = p.a_rs && p.inc ? p.a_rs * A.cosd(p.inc) : 0.4;
        b = Math.min(Math.abs(b), 1 + k - 1e-3);
        const top = (1 - k) ** 2 - b * b;
        const bottom = (1 + k) ** 2 - b * b;
        const T23 = top > 0 && bottom > 0 ? T14 * Math.sqrt(top / bottom) : 0;
        return Math.max((T14 - T23) / 2, T14 * 0.03);
    }

    function evalPlanet(target, grid, trk, out) {
        const p = target.d;
        const crit = state.settings.criteria;
        const T14 = p.dur_h / 24;
        const bA = A.jdUtcToBjdTdb(grid.start, p.ra, p.dec) - T14;
        const bB = A.jdUtcToBjdTdb(grid.end, p.ra, p.dec) + T14;
        const kMin = Math.ceil((bA - p.t0) / p.period);
        const kMax = Math.floor((bB - p.t0) / p.period);
        for (let k = kMin; k <= kMax && k - kMin < 6; k += 1) {
            const tc = A.bjdTdbToJdUtc(p.t0 + k * p.period, p.ra, p.dec);
            const t1 = tc - T14 / 2;
            const t4 = tc + T14 / 2;
            const sigmaMin = Math.hypot(p.t0_unc || 0, k * (p.period_unc || 0)) * 1440;
            const pad = Math.min(sigmaMin, 45) * MIN;
            const base = crit.baseline * MIN;
            const start = t1 - base - pad;
            const end = t4 + base + pad;
            const tau = ingressDays(p, T14);
            const r = baseResult(target, trk, {
                kind: 'Transit', t: tc, start, end, durationH: p.dur_h,
                contacts: [{ label: 'Ingress (T1)', jd: t1 }, { label: 'Mid-transit', jd: tc }, { label: 'Egress (T4)', jd: t4 }],
                depth: p.depth_ppt / 1000, depthText: `${fmt(p.depth_ppt, p.depth_ppt < 10 ? 1 : 0)} ppt`,
                magValue: p.vmag ?? (p.rmag != null ? p.rmag + 0.4 : null),
                ephem: { sigmaMin, cycles: k, source: p.src === 'E' ? 'ExoClock' : 'NASA Exoplanet Archive' },
                ingress: tau
            });
            const mag = r.magValue ?? 12.5;
            r.magText = p.vmag != null ? `V ${fmt(p.vmag, 1)}` : p.rmag != null ? `R ${fmt(p.rmag, 1)}` : '—';
            const cover = coverInterval(trk.intervals, start, end);
            let inFraction = 1;
            let baseFraction = 2;
            let evalAt = tc;
            if (cover) {
                r.coverage = 'full';
                r.reasons.push({ level: 'good', text: `Full transit with ${crit.baseline} min baselines${pad > 2 * MIN ? ` + ${Math.round(pad / MIN)} min timing margin` : ''}, dark and above ${grid.minAlt}°` });
            } else {
                const ov = maxOverlap(trk.intervals, t1, t4);
                inFraction = ov.length / T14;
                if (inFraction <= 0.02) continue;
                const iv = ov.interval;
                const pre = iv[0] <= t1 - 15 * MIN;
                const post = iv[1] >= t4 + 15 * MIN;
                baseFraction = (pre ? 1 : 0) + (post ? 1 : 0);
                evalAt = clamp(tc, iv[0], iv[1]);
                if (inFraction >= 0.5 && baseFraction > 0) {
                    r.coverage = 'partial';
                    r.reasons.push({ level: 'warn', text: `Partial transit: ${pre ? 'ingress' : 'egress'} side only, ${Math.round(inFraction * 100)}% of the transit observable` });
                } else {
                    r.coverage = 'none';
                    r.reasons.push({ level: 'bad', text: `Not observable as a light curve: ${blockers(grid, trk, start, end).join('; ')}` });
                }
            }
            const { cond, plan } = photometry(grid, trk, evalAt, {
                mag, tMax: clamp(tau * 86400 / 5, 30, 120) // >= 5 frames across ingress
            });
            r.cond = cond;
            r.plan = plan;
            const nIn = Math.max(1, T14 * inFraction * 86400 / plan.cadence);
            const nOut = Math.max(1, baseFraction * base * 86400 / plan.cadence);
            const sigmaDepth = Math.sqrt(plan.sigmaFrame ** 2 * (1 / nIn + 1 / nOut) + (state.settings.rig.redNoise || 0) ** 2);
            r.snr = r.depth / sigmaDepth;
            r.snrBasis = `depth ${fmt(p.depth_ppt, 1)} ppt vs ±${fmt(sigmaDepth * 1000, 2)} ppt on the in-transit level`;
            r.noise5 = plan.binned(300);
            [r.altMin, r.altMax] = altRange(grid, trk, Math.max(start, grid.start), Math.min(end, grid.end));
            if (sigmaMin > 20) r.reasons.push({ level: 'warn', text: `Ephemeris uncertainty ±${Math.round(sigmaMin)} min at this epoch` });
            else r.reasons.push({ level: 'info', text: `Ephemeris ±${sigmaMin < 1 ? '<1' : Math.round(sigmaMin)} min (${r.ephem.source})` });
            if (p.flag && ['alert', 'high'].includes(p.flag)) r.reasons.push({ level: 'good', text: `ExoClock priority: ${p.flag} (new timings wanted)` });
            if (p.min_tel_in) r.reasons.push({ level: 'info', text: `ExoClock minimum aperture ≈ ${fmt(p.min_tel_in, 1)} in (yours: ${fmt(state.settings.rig.aperture / 25.4, 1)} in)` });
            out.push(judge(r));
        }
    }

    function eclipseFraction(star) {
        if (star.dur > 0) return { value: star.dur / 100, estimated: false };
        if (star.cls === 'CVE') return { value: 0.09, estimated: true };
        return { value: clamp(0.13 / Math.sqrt(star.period), 0.03, 0.25), estimated: true };
    }

    function evalVsx(target, grid, trk, out) {
        const s = target.d;
        if (s.cls === 'EA' || s.cls === 'EB' || s.cls === 'EW' || s.cls === 'CVE') return evalEclipse(target, grid, trk, out);
        if (s.cls === 'RR') return evalRR(target, grid, trk, out);
        return evalRun(target, grid, trk, out);
    }

    /**
     * Quiescent brightness of a CV.  VSX lists the outburst (or nova) peak as "max" and the faintest
     * state as "min", so quiescence is the faint limit, less a nominal 1 mag eclipse for eclipsing systems.
     * (Using the peak would turn old novae like V Per, V~18 today, into "bright" targets.)
     */
    function quiescentMag(s) {
        const eclipsing = s.cls === 'CVE';
        if (s.amp != null) return s.max + s.amp - (eclipsing ? 1.0 : 0);
        return s.max + (eclipsing ? 4 : 3);
    }

    const GCVS_NAME = /^((V\d{3,4})|([A-Z]{1,2})|([a-z]{2,3}( ?\d)?)|(\d{1,3} [a-z]{0,3}))\s[A-Z][a-z]{2}$/;

    /** Prefer well-studied stars (GCVS names, firm classifications) in rankings. */
    function catalogQuality(r) {
        if (r.group === 'transit') return 1;
        const type = r.target.d.type || '';
        let q = 1;
        if (/[|:]/.test(type)) q *= 0.6;
        if (GCVS_NAME.test(r.name)) q *= 1.2;
        return q;
    }

    function evalEclipse(target, grid, trk, out) {
        const s = target.d;
        const P = s.period;
        const isCv = s.cls === 'CVE';
        const phases = s.cls === 'EA' || isCv ? [0] : [0, 0.5];
        const D = s.cls === 'EA' || isCv ? eclipseFraction(s) : null;
        const hA = A.jdUtcToHjd(grid.start, s.ra, s.dec) - P;
        const hB = A.jdUtcToHjd(grid.end, s.ra, s.dec) + P;
        const kMin = Math.floor((hA - s.epoch) / P);
        const kMax = Math.ceil((hB - s.epoch) / P);
        if (kMax - kMin > 80) return; // very short periods are handled as runs elsewhere
        const baseMag = isCv ? quiescentMag(s) : s.max;
        const ampMag = isCv ? 1.0 : (s.amp ?? 0.1);
        for (let k = kMin; k <= kMax; k += 1) {
            for (const phase of phases) {
                const hjd = s.epoch + (k + phase) * P;
                const tm = A.hjdToJdUtc(hjd, s.ra, s.dec);
                if (tm < grid.start - 0.1 || tm > grid.end + 0.1) continue;
                const cycles = Math.abs(k + phase);
                const sigmaMin = vsxSigmaMinutes(s, cycles);
                const pad = Math.min(sigmaMin, 30) * MIN;
                let full; let tom; let durationDays;
                if (D) {
                    durationDays = D.value * P;
                    const half = Math.max(0.35 * durationDays, 15 * MIN);
                    full = [tm - durationDays / 2 - 10 * MIN - pad, tm + durationDays / 2 + 10 * MIN + pad];
                    tom = [tm - half - pad, tm + half + pad];
                } else {
                    durationDays = 0.2 * P;
                    const half = Math.max(0.08 * P, 20 * MIN);
                    full = [tm - 0.25 * P - pad, tm + 0.25 * P + pad];
                    tom = [tm - half - pad, tm + half + pad];
                }
                const secondary = phase === 0.5;
                const depthMag = secondary ? (s.cls === 'EB' ? ampMag * 0.5 : ampMag * 0.9) : ampMag;
                const kind = isCv ? 'Eclipse' : secondary ? 'Secondary minimum' : phases.length > 1 ? 'Primary minimum' : 'Minimum';
                const coverFull = coverInterval(trk.intervals, full[0], full[1]);
                const coverTom = coverFull || coverInterval(trk.intervals, tom[0], tom[1]);
                const window = coverFull ? full : tom;
                const r = baseResult(target, trk, {
                    kind, t: tm, start: window[0], end: window[1], durationH: durationDays * 24,
                    contacts: D
                        ? [{ label: 'Eclipse start', jd: tm - durationDays / 2 }, { label: kind, jd: tm }, { label: 'Eclipse end', jd: tm + durationDays / 2 }]
                        : [{ label: kind, jd: tm }],
                    depth: 1 - Math.pow(10, -0.4 * depthMag),
                    depthText: `${fmt(depthMag, 2)} mag`,
                    magValue: baseMag,
                    magText: isCv ? `V≈${fmt(baseMag, 1)} q` : `${s.band || 'V'} ${fmt(s.max, 1)}`,
                    ephem: { sigmaMin, cycles: k + phase, source: 'VSX' },
                    eclipse: { D, durationDays, full, tom, secondary, depthMag }
                });
                if (coverFull) {
                    r.coverage = 'full';
                    r.reasons.push({ level: 'good', text: D ? `Entire eclipse (${A.formatDuration(durationDays * 24)}) covered with margins` : 'Whole minimum covered (±0.25 P)' });
                } else if (coverTom) {
                    r.coverage = 'tom';
                    r.reasons.push({ level: 'good', text: `Minimum ±${Math.round((tm - tom[0]) / MIN)} min covered: enough for a time of minimum` });
                } else {
                    const ov = maxOverlap(trk.intervals, tom[0], tom[1]);
                    if (ov.length <= 0) continue;
                    r.coverage = 'none';
                    r.reasons.push({ level: 'bad', text: `Minimum not covered: ${blockers(grid, trk, tom[0], tom[1]).join('; ')}` });
                }
                if (D && D.estimated) r.reasons.push({ level: 'info', text: `Eclipse duration not in VSX; estimated ${A.formatDuration(durationDays * 24)} from the period` });
                if (sigmaMin > 30) r.reasons.push({ level: 'warn', text: `Old or imprecise ephemeris: ±${Math.round(sigmaMin)} min after ${Math.round(cycles)} cycles` });
                if (isCv) r.reasons.push({ level: 'info', text: `Quiescent brightness estimated V≈${fmt(baseMag, 1)}; much brighter in outburst (check AAVSO)` });
                const durS = durationDays * 86400;
                const tMax = isCv ? clamp(durS / 25, 5, 60) : D ? clamp(durS / 40, 10, 120) : clamp(P * 86400 / 150, 10, 120);
                const bin = isCv ? clamp(durS / 10, 30, 120) : D ? clamp(durS / 20, 120, 600) : clamp(P * 86400 / 60, 120, 600);
                const { cond, plan } = photometry(grid, trk, tm, { mag: isCv ? baseMag : s.max, magFaint: baseMag + depthMag, tMax });
                r.cond = cond;
                r.plan = plan;
                const noise = plan.binned(bin);
                r.snr = r.depth / noise;
                r.snrBasis = `${fmt(depthMag, 2)} mag dip vs ±${fmt(noise * 1000, 1)} ppt per ${Math.round(bin / 60)}-min bin`;
                r.noise5 = plan.binned(300);
                [r.altMin, r.altMax] = altRange(grid, trk, Math.max(r.start, grid.start), Math.min(r.end, grid.end));
                if (!D) {
                    const longest = trk.intervals.reduce((m, iv) => Math.max(m, iv[1] - iv[0]), 0);
                    if (longest >= P) r.reasons.push({ level: 'good', text: `A full orbit (${A.formatDuration(P * 24)}) fits in tonight's window` });
                }
                out.push(judge(r));
            }
        }
    }

    function evalRR(target, grid, trk, out) {
        const s = target.d;
        const P = s.period;
        const isC = /RRC/i.test(s.type);
        const rise = (s.dur > 0 ? s.dur / 100 : isC ? 0.35 : 0.13) * P;
        const before = clamp(1.2 * rise, 40 * MIN, 150 * MIN);
        const after = clamp(0.08 * P, 30 * MIN, 75 * MIN);
        const hA = A.jdUtcToHjd(grid.start, s.ra, s.dec) - P;
        const hB = A.jdUtcToHjd(grid.end, s.ra, s.dec) + P;
        for (let k = Math.floor((hA - s.epoch) / P); k <= Math.ceil((hB - s.epoch) / P); k += 1) {
            const tmax = A.hjdToJdUtc(s.epoch + k * P, s.ra, s.dec);
            if (tmax < grid.start - 0.1 || tmax > grid.end + 0.1) continue;
            const sigmaMin = vsxSigmaMinutes(s, k);
            const pad = Math.min(sigmaMin, 30) * MIN;
            const start = tmax - before - pad;
            const end = tmax + after + pad;
            const amp = s.amp ?? 0.5;
            const r = baseResult(target, trk, {
                kind: 'Maximum', t: tmax, start, end, durationH: (end - start) * 24,
                contacts: [{ label: 'Rise begins (approx.)', jd: tmax - rise }, { label: 'Maximum', jd: tmax }],
                depth: 1 - Math.pow(10, -0.4 * amp), depthText: `${fmt(amp, 2)} mag`,
                magValue: s.max, magText: `${s.band || 'V'} ${fmt(s.max, 1)}`,
                ephem: { sigmaMin, cycles: k, source: 'VSX' }
            });
            if (coverInterval(trk.intervals, start, end)) {
                r.coverage = 'full';
                r.reasons.push({ level: 'good', text: `Rising branch and maximum covered (${A.formatDuration((end - start) * 24)})` });
            } else {
                const ov = maxOverlap(trk.intervals, start, end);
                if (ov.length <= 0) continue;
                const hasMax = ov.interval[0] <= tmax - 20 * MIN && ov.interval[1] >= tmax + 20 * MIN;
                if (hasMax && ov.length >= 0.6 * (end - start)) {
                    r.coverage = 'partial';
                    r.reasons.push({ level: 'warn', text: `Maximum covered but not the full rise (${Math.round(ov.length / (end - start) * 100)}% of window)` });
                } else {
                    r.coverage = 'none';
                    r.reasons.push({ level: 'bad', text: `Maximum not covered: ${blockers(grid, trk, start, end).join('; ')}` });
                }
            }
            if (sigmaMin > 30) r.reasons.push({ level: 'warn', text: `Ephemeris may have drifted ±${Math.round(sigmaMin)} min (RR Lyrae periods also change)` });
            const { cond, plan } = photometry(grid, trk, tmax, { mag: s.max, magFaint: s.max + amp, tMax: clamp(rise * 86400 / 60, 15, 90) });
            r.cond = cond;
            r.plan = plan;
            const noise = plan.binned(300);
            r.snr = r.depth / noise;
            r.snrBasis = `${fmt(amp, 2)} mag amplitude vs ±${fmt(noise * 1000, 1)} ppt per 5 min`;
            r.noise5 = noise;
            [r.altMin, r.altMax] = altRange(grid, trk, Math.max(start, grid.start), Math.min(end, grid.end));
            out.push(judge(r));
        }
    }

    /** δ Scuti, Cepheids and non-eclipsing CVs: a continuous run placed around culmination. */
    function evalRun(target, grid, trk, out) {
        const s = target.d;
        const P = s.period;
        let need; let tMax; let bin; let kind; let note;
        let mag = s.max;
        let magFaint = s.max + (s.amp ?? 0.1);
        let depth = 1 - Math.pow(10, -0.4 * (s.amp ?? 0.1));
        let depthText = `${fmt(s.amp, 2)} mag`;
        if (s.cls === 'DS') {
            need = P <= 0.25 ? Math.max(1.2 * P, 1 / 24) : 3 / 24;
            tMax = clamp(P * 86400 / 60, 5, 60);
            bin = clamp(P * 86400 / 30, 60, 300);
            kind = 'Pulsation run';
            note = `Covers ${fmt(need / P, 1)} pulsation cycles (P = ${A.formatDuration(P * 24)})`;
        } else if (s.cls === 'CEP') {
            need = 30 * MIN;
            tMax = 60;
            bin = 300;
            kind = 'Nightly point';
            note = `One measurement per night samples the ${fmt(P, 2)} d cycle`;
        } else {
            need = 2 / 24;
            tMax = 60;
            bin = 120;
            kind = 'Flickering run';
            mag = quiescentMag(s);
            magFaint = mag;
            depth = 1 - Math.pow(10, -0.4 * 0.1);
            depthText = '~0.1 mag';
            note = `Quiescent brightness estimated V≈${fmt(mag, 1)}; CVs are much brighter in outburst (check AAVSO)`;
        }
        const ivs = trk.intervals.slice().sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
        const iv = ivs[0];
        const length = iv[1] - iv[0];
        if (length < 0.3 * need) return;
        const peak = culmination(grid, trk, iv);
        const span = Math.min(need, length);
        const start = clamp(peak - span / 2, iv[0], iv[1] - span);
        const end = start + span;
        const center = (start + end) / 2;
        const r = baseResult(target, trk, {
            kind, t: center, start, end, durationH: span * 24,
            contacts: [{ label: 'Run start', jd: start }, { label: 'Run end', jd: end }],
            depth, depthText, magValue: mag,
            magText: s.cls === 'CV' ? `V≈${fmt(mag, 1)} q` : `${s.band || 'V'} ${fmt(s.max, 1)}`,
            ephem: { sigmaMin: null, cycles: null, source: 'VSX' }
        });
        if (s.cls === 'DS' && Number.isFinite(s.epoch)) {
            const kStart = Math.ceil((A.jdUtcToHjd(start, s.ra, s.dec) - s.epoch) / P);
            for (let k = kStart; k <= kStart + 6; k += 1) {
                const jd = A.hjdToJdUtc(s.epoch + k * P, s.ra, s.dec);
                if (jd > end) break;
                r.contacts.push({ label: 'Predicted maximum', jd });
            }
            r.contacts.sort((a, b) => a.jd - b.jd);
        }
        if (span >= need - MIN) {
            r.coverage = 'run';
            r.reasons.push({ level: 'good', text: note });
        } else {
            r.coverage = 'partial';
            r.reasons.push({ level: 'warn', text: `Only ${A.formatDuration(span * 24)} available (want ${A.formatDuration(need * 24)})` });
            if (s.cls === 'CV') r.reasons.push({ level: 'info', text: note });
        }
        if (s.cls === 'CV' && span >= need - MIN) r.reasons.push({ level: 'info', text: 'Look for flickering, orbital humps or superhumps' });
        const { cond, plan } = photometry(grid, trk, center, { mag, magFaint, tMax });
        r.cond = cond;
        r.plan = plan;
        const noise = plan.binned(bin);
        r.snr = depth / noise;
        r.snrBasis = `${depthText} variation vs ±${fmt(noise * 1000, 1)} ppt per ${Math.round(bin / 60)}-min bin`;
        r.noise5 = plan.binned(300);
        [r.altMin, r.altMax] = altRange(grid, trk, start, end);
        out.push(judge(r));
    }

    function evaluateTarget(target, grid) {
        const trk = track(grid, target);
        if (!trk) return [];
        const out = [];
        if (target.kind === 'planet') evalPlanet(target, grid, trk, out);
        else evalVsx(target, grid, trk, out);
        out.forEach(r => { r.trk = trk; });
        return out;
    }

    // ------------------------------------------------------------------ compute & render

    function recompute() {
        state.computing = true;
        $('list-status').innerHTML = '<span class="spinner"></span> Computing tonight…';
        setTimeout(() => {
            const t0 = performance.now();
            const s = state.settings;
            state.night = A.night(state.date, s.site, Number(s.site.darkLimit));
            state.grid = buildGrid(state.night, s);
            const results = [];
            if (state.night.darkHours > 0.25) {
                for (const target of state.targets) results.push(...evaluateTarget(target, state.grid));
            }
            state.results = results;
            state.computing = false;
            state.limit = PAGE_SIZE;
            renderContext();
            renderList();
            renderPlan();
            const selected = results.find(r => r.id === state.selectedId) || results.find(r => r.key === state.selectedKey);
            if (selected) renderDetail(selected); else renderDetailEmpty();
            console.info(`NightVector: ${results.length} events from ${state.targets.length} targets in ${Math.round(performance.now() - t0)} ms`);
        }, 20);
    }

    function bestPerTarget(list) {
        const byKey = new Map();
        for (const r of list) {
            const prev = byKey.get(r.key);
            if (!prev) { byKey.set(r.key, { best: r, count: 1 }); continue; }
            prev.count += 1;
            if (r.score > prev.best.score) prev.best = r;
        }
        return [...byKey.values()].map(entry => Object.assign(entry.best, { siblings: entry.count - 1 }));
    }

    function visibleResults() {
        const all = bestPerTarget(state.results);
        const allowed = r => r.verdict === 'go' || (r.verdict === 'marginal' && state.showMarginal) || (r.verdict === 'skip' && state.showRejected);
        if (state.search) {
            const q = norm(state.search);
            return all.filter(r => norm(r.name).includes(q) || norm(r.target.d.host).includes(q));
        }
        if (state.tab === 'shortlist') {
            const picks = [];
            for (const group of Object.keys(SHORTLIST_SIZE)) {
                const ranked = all.filter(r => r.group === group && (r.verdict === 'go' || (r.verdict === 'marginal' && state.showMarginal))).sort((a, b) => b.score - a.score);
                const go = ranked.filter(r => r.verdict === 'go');
                const take = go.length >= SHORTLIST_SIZE[group] ? go : ranked;
                picks.push(...take.slice(0, SHORTLIST_SIZE[group]));
            }
            return sortResults(picks);
        }
        return sortResults(all.filter(r => r.group === state.tab && allowed(r)));
    }

    function sortResults(list) {
        const by = {
            time: (a, b) => a.start - b.start,
            score: (a, b) => b.score - a.score,
            mag: (a, b) => (a.magValue ?? 99) - (b.magValue ?? 99),
            depth: (a, b) => b.depth - a.depth
        }[state.sort];
        if (state.sort === 'time') {
            // Chronological, with rejected rows (when shown) after everything usable.
            return list.sort((a, b) => (a.verdict === 'skip') - (b.verdict === 'skip') || by(a, b));
        }
        return list.sort(by);
    }

    function counts() {
        const all = bestPerTarget(state.results);
        const out = { shortlist: 0 };
        for (const group of Object.keys(GROUPS)) {
            out[group] = all.filter(r => r.group === group && r.verdict === 'go').length;
        }
        return out;
    }

    function verdictChip(r) {
        const map = { go: ['chip-go', 'Go'], marginal: ['chip-warn', 'Marginal'], skip: ['chip-stop', 'Skip'] };
        const [cls, label] = map[r.verdict];
        return `<span class="chip ${cls}"><span class="dot"></span>${label}</span>`;
    }

    function timelineBar(r) {
        return window.NVContext.timelineBar(state.grid, state.night, [r.start, r.end], r.t, GROUPS[r.group].hex);
    }

    function renderAxis() {
        $('tl-axis').innerHTML = state.grid ? window.NVContext.axisLabels(state.grid, tz()) : '';
    }

    function rowHtml(r) {
        const planned = planIds().includes(r.id);
        const sub = r.group === 'transit'
            ? `${esc(r.target.d.host || 'Host')} · P ${fmt(r.period, 3)} d`
            : `${esc(r.target.d.type)} · P ${r.period < 1 ? A.formatDuration(r.period * 24) : `${fmt(r.period, 3)} d`}`;
        const extra = r.siblings > 0 ? ` · +${r.siblings} more tonight` : '';
        const p = r.plan;
        return `<tr data-id="${esc(r.id)}" class="${r.id === state.selectedId ? 'is-selected' : ''}">
            <td><button class="star-btn" type="button" data-star="${esc(r.id)}" aria-pressed="${planned}" title="${planned ? 'Remove from plan' : 'Add to plan'}">${planned ? '★' : '☆'}</button></td>
            <td><span class="cls-dot" style="background:${GROUPS[r.group].hex}"></span><span class="name">${esc(r.name)}</span><span class="sub">${sub}${extra}</span></td>
            <td><span class="name" style="font-weight:500">${esc(r.kind)} ${t(r.t)}</span><span class="sub">${r.durationH ? A.formatDuration(r.durationH) : ''}${r.coverage === 'partial' ? ' · partial' : r.coverage === 'tom' ? ' · minimum only' : ''}</span></td>
            <td class="num">${t(r.start)}–${t(r.end)}</td>
            <td class="tl">${timelineBar(r)}</td>
            <td class="num hide-sm">${Math.round(r.altMin)}–${Math.round(r.altMax)}°</td>
            <td class="num hide-sm">${esc(r.magText)}</td>
            <td class="num">${esc(r.depthText)}</td>
            <td class="num hide-md">${p ? `${p.exposure}s${p.defocused ? ' ◌' : ''}` : '—'}</td>
            <td class="num hide-md">${Number.isFinite(r.noise5) ? fmt(r.noise5 * 1000, 1) : '—'}</td>
            <td class="num">${Number.isFinite(r.snr) ? (r.snr >= 100 ? '99+' : fmt(r.snr, 0)) : '—'}</td>
            <td>${verdictChip(r)}</td>
        </tr>`;
    }

    function renderList() {
        renderAxis();
        const c = counts();
        document.querySelectorAll('[data-count]').forEach(el => {
            const key = el.dataset.count;
            el.textContent = key === 'shortlist' ? '' : String(c[key] ?? 0);
        });
        const rows = visibleResults();
        const body = $('target-rows');
        const empty = $('list-empty');
        const shown = rows.slice(0, state.limit);
        body.innerHTML = shown.map(rowHtml).join('');
        if (!rows.length) {
            empty.classList.remove('hidden');
            empty.innerHTML = emptyMessage();
        } else {
            empty.classList.add('hidden');
        }
        const more = $('show-more');
        more.classList.toggle('hidden', rows.length <= state.limit);
        const total = state.results.length;
        const go = bestPerTarget(state.results).filter(r => r.verdict === 'go').length;
        $('list-status').textContent = state.night && state.night.darkHours <= 0.25
            ? 'No usable darkness on this night at the chosen Sun limit.'
            : `${shown.length} of ${rows.length} shown · ${go} capturable targets tonight from ${state.targets.length.toLocaleString()} in the catalogs (${total.toLocaleString()} events checked)`;
    }

    function emptyMessage() {
        if (state.search) {
            const q = norm(state.search);
            const rank = tg => {
                const n = norm(tg.name);
                if (n === q) return 0;
                if (/^[a-z]?$/.test(n.slice(q.length)) && n.startsWith(q)) return 1; // "WASP-12" -> WASP-12b
                return n.startsWith(q) ? 2 : 3;
            };
            const matches = state.targets.filter(tg => norm(tg.name).includes(q) || norm(tg.d.host).includes(q))
                .sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length).slice(0, 8);
            if (!matches.length) return `<h3>No catalog match for “${esc(state.search)}”</h3><p class="small">Catalogs include confirmed transiting planets and VSX eclipsing binaries, RR Lyrae, δ Scuti, Cepheids and CVs brighter than about V 13.</p>`;
            return `<h3>No event for these targets tonight</h3><p class="small">They are below your limits, or their transit / minimum / maximum falls outside the dark window.</p>
                <div class="stack" style="max-width: 460px; margin: 16px auto 0; text-align: left;">${matches.map(tg => `
                    <div class="row-between inset"><span><strong>${esc(tg.name)}</strong> <span class="dim small">${esc(CLASS_LABEL[tg.cls])}</span></span>
                    <button class="btn btn-sm" type="button" data-next="${esc(tg.key)}">Find next nights</button></div>`).join('')}</div>`;
        }
        if (state.night && state.night.darkHours <= 0.25) return '<h3>No dark time</h3><p class="small">The Sun does not reach your darkness limit on this night.</p>';
        return `<h3>Nothing passes the cuts</h3><p class="small">Try showing marginal or rejected targets, lowering the minimum altitude, or checking the rig settings in Setup.</p>`;
    }

    // ------------------------------------------------------------------ context strip (shared: nv-context.js)

    function renderContext() {
        window.NVContext.render({ settings: state.settings, night: state.night, darkLimit: state.settings.site.darkLimit });
    }

    function loadWeather() {
        return window.NVContext.loadWeather(state.settings, state.night);
    }

    // ------------------------------------------------------------------ detail panel

    function renderDetailEmpty() {
        $('detail').innerHTML = '<div class="empty-state"><h3>Select a target</h3><p class="small">Altitude, predicted light curve, exposure settings and export appear here.</p></div>';
    }

    function altitudeChart(r) {
        return window.NVSky.altitudeChart(state.grid, r.trk, { tz: tz(), color: GROUPS[r.group].hex, window: [r.start, r.end], mark: r.t });
    }

    function modelFlux(r, jd) {
        const tt = jd - r.t;
        if (r.group === 'transit') {
            const T14 = r.durationH / 24;
            const tau = r.ingress;
            const a = Math.abs(tt);
            if (a >= T14 / 2) return 1;
            if (a <= T14 / 2 - tau) return 1 - r.depth;
            return 1 - r.depth * (T14 / 2 - a) / tau;
        }
        if (r.eclipse) {
            if (r.eclipse.D) {
                const half = r.eclipse.durationDays / 2;
                const u = Math.abs(tt) / half;
                return u >= 1 ? 1 : 1 - r.depth * Math.pow(1 - u * u, 0.6);
            }
            const phase = tt / r.period;
            const primary = !r.eclipse.secondary;
            const d1 = primary ? r.depth : r.depth / (r.cls === 'EB' ? 0.5 : 0.9);
            const d2 = r.cls === 'EB' ? d1 * 0.5 : d1 * 0.9;
            const ph = primary ? phase : phase + 0.5;
            const c = Math.cos(4 * Math.PI * ph);
            const which = Math.cos(2 * Math.PI * ph) > 0 ? d1 : d2;
            return 1 - which * Math.pow((1 + c) / 2, 1.4);
        }
        if (r.cls === 'RR' || r.cls === 'CEP' || r.cls === 'DS') {
            const P = r.period;
            const ref = r.cls === 'RR' ? r.t : r.target.d.epoch ? A.hjdToJdUtc(r.target.d.epoch, r.ra, r.dec) : r.t;
            let phase = ((jd - ref) / P) % 1;
            if (phase > 0.5) phase -= 1;
            if (phase < -0.5) phase += 1;
            const riseFrac = r.cls === 'DS' ? 0.35 : r.cls === 'CEP' ? 0.3 : 0.13;
            let b;
            if (phase <= 0 && phase > -riseFrac) b = 1 + phase / riseFrac;
            else if (phase > 0) b = Math.exp(-phase / 0.28);
            else b = Math.exp(-(phase + 1) / 0.28);
            const amp = r.depth;
            return 1 - amp + amp * clamp(b, 0, 1);
        }
        // CV flickering: smooth pseudo-random variation
        const s = tt * 1440;
        return 1 + 0.04 * Math.sin(s / 3.1) + 0.025 * Math.sin(s / 1.3 + 1) + 0.015 * Math.sin(s / 0.47 + 2);
    }

    function lightCurveChart(r) {
        const W = 640; const H = 200; const L = 44; const R = 8; const T = 10; const B = 22;
        const a = r.start - 10 * MIN;
        const b = r.end + 10 * MIN;
        const cadence = r.plan.cadence / 86400;
        const sigma = r.plan.sigmaFrame;
        let seed = 12345;
        const gauss = () => {
            seed = (seed * 16807) % 2147483647; const u = seed / 2147483647;
            seed = (seed * 16807) % 2147483647; const v = seed / 2147483647;
            return Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * v);
        };
        const pts = [];
        const stride = Math.max(1, Math.ceil(((b - a) / cadence) / 700));
        for (let jd = a; jd <= b; jd += cadence) pts.push({ jd, f: modelFlux(r, jd) + gauss() * sigma });
        const shown = pts.filter((_, i) => i % stride === 0);
        const binW = 5 * MIN;
        const bins = [];
        for (let jd = a; jd < b; jd += binW) {
            const inBin = pts.filter(p => p.jd >= jd && p.jd < jd + binW);
            if (inBin.length) bins.push({ jd: jd + binW / 2, f: inBin.reduce((s, p) => s + p.f, 0) / inBin.length, e: sigma / Math.sqrt(inBin.length) });
        }
        const model = [];
        for (let jd = a; jd <= b; jd += (b - a) / 400) model.push({ jd, f: modelFlux(r, jd) });
        const values = shown.map(p => p.f).concat(model.map(p => p.f));
        let lo = Math.min(...values);
        let hi = Math.max(...values);
        const pad = (hi - lo) * 0.08 || 0.002;
        lo -= pad; hi += pad;
        const x = jd => L + (jd - a) / (b - a) * (W - L - R);
        const y = f => T + (hi - f) / (hi - lo) * (H - T - B);
        const dots = shown.map(p => `<circle cx="${x(p.jd).toFixed(1)}" cy="${y(p.f).toFixed(1)}" r="1.3" fill="#9aa8bf" opacity="0.55"/>`).join('');
        const binned = bins.map(p => `<line x1="${x(p.jd).toFixed(1)}" x2="${x(p.jd).toFixed(1)}" y1="${y(p.f + p.e).toFixed(1)}" y2="${y(p.f - p.e).toFixed(1)}" stroke="${GROUPS[r.group].hex}" opacity="0.8"/><circle cx="${x(p.jd).toFixed(1)}" cy="${y(p.f).toFixed(1)}" r="2.6" fill="${GROUPS[r.group].hex}"/>`).join('');
        const line = model.map((p, i) => `${i ? 'L' : 'M'}${x(p.jd).toFixed(1)},${y(p.f).toFixed(1)}`).join('');
        const contactLines = r.contacts.filter(c => c.jd > a && c.jd < b).map(c => `<line x1="${x(c.jd)}" x2="${x(c.jd)}" y1="${T}" y2="${H - B}" stroke="rgba(231,236,246,0.25)" stroke-dasharray="2 4"/>`).join('');
        const yTicks = [hi - pad, (hi + lo) / 2, lo + pad].map(f => `<text x="${L - 6}" y="${y(f) + 3}" text-anchor="end">${f.toFixed(3)}</text>`).join('');
        const tickJds = [];
        for (let jd = Math.ceil(a * 96) / 96; jd < b; jd += 1 / 96) tickJds.push(jd); // every 15 min
        const tickStep = Math.max(1, Math.ceil(tickJds.length / 6));
        const ticks = tickJds.filter((_, i) => i % tickStep === 0)
            .map(jd => `<text x="${x(jd).toFixed(1)}" y="${H - 6}" text-anchor="middle">${t(jd)}</text>`).join('');
        return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Simulated light curve">
            ${contactLines}${dots}<path d="${line}" fill="none" stroke="#e7ecf6" stroke-width="1.4" opacity="0.9"/>${binned}${yTicks}${ticks}
        </svg>`;
    }

    function linksFor(r) {
        const raS = A.formatRa(r.ra, 1);
        const decS = A.formatDec(r.dec, 0);
        const links = [
            [`https://app.aavso.org/vsp/?ra=${encodeURIComponent(raS)}&dec=${encodeURIComponent(decS)}&fov=30&maglimit=15`, 'AAVSO finder'],
            [`https://aladin.cds.unistra.fr/AladinLite/?target=${encodeURIComponent(`${raS} ${decS}`)}&fov=0.6&survey=CDS%2FP%2FDSS2%2Fcolor`, 'Aladin'],
            [`https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${encodeURIComponent(`${r.ra} ${r.dec}`)}&Radius=1&Radius.unit=arcmin`, 'SIMBAD']
        ];
        if (r.group === 'transit') {
            if (r.target.d.src === 'E') links.push([`https://www.exoclock.space/database/planets/${encodeURIComponent(r.name)}/`, 'ExoClock']);
            links.push([`https://exoplanetarchive.ipac.caltech.edu/overview/${encodeURIComponent(r.target.d.host || r.name)}`, 'NASA archive']);
        } else {
            links.push([`https://vsx.aavso.org/index.php?view=results.get&ident=${encodeURIComponent(r.name)}`, 'VSX']);
            links.push([`https://www.aavso.org/LCGv2/?star=${encodeURIComponent(r.name)}`, 'AAVSO light curve']);
        }
        return links.map(([href, label]) => `<a class="btn btn-sm" href="${href}" target="_blank" rel="noopener">${label}</a>`).join('');
    }

    function renderDetail(r) {
        state.selectedId = r.id;
        state.selectedKey = r.key;
        const p = r.plan;
        const s = state.settings;
        const optics = A.optics(s.rig);
        const pNow = A.precess(r.ra, r.dec, state.night.midnight);
        const reasons = r.reasons.map(x => `<li class="${x.level === 'good' ? 'good' : x.level === 'warn' ? 'warn' : x.level === 'bad' ? 'bad' : ''}">${esc(x.text)}</li>`).join('');
        const contacts = r.contacts.map(c => `<dt>${esc(c.label)}</dt><dd>${t(c.jd)} <span class="dim">(${tUtc(c.jd)} UT)</span></dd>`).join('');
        const frames = Math.ceil((r.end - r.start) * 86400 / p.cadence);
        const planned = planIds().includes(r.id);
        const ephem = r.ephem && r.ephem.sigmaMin != null
            ? `<dt>Ephemeris</dt><dd>${esc(r.ephem.source)} · ±${r.ephem.sigmaMin < 1 ? '<1' : Math.round(r.ephem.sigmaMin)} min · E=${Math.round(r.ephem.cycles)}</dd>` : `<dt>Data</dt><dd>${esc(r.ephem.source)}</dd>`;
        $('detail').innerHTML = `
            <div class="detail-section">
                <div class="row-between">
                    <div class="grow">
                        <p class="eyebrow" style="color:${GROUPS[r.group].hex}">${esc(CLASS_LABEL[r.cls])}</p>
                        <h2 style="margin-top:6px;">${esc(r.name)}</h2>
                        <p class="muted small" style="margin-top:4px;">${esc(r.kind)} at ${t(r.t)} ${A.tzAbbrev(tz(), A.msFromJd(r.t))} · ${esc(r.target.d.type || (r.target.d.host ? `host ${r.target.d.host}` : ''))}</p>
                    </div>
                    ${verdictChip(r)}
                </div>
                <ul class="reason-list" style="margin-top: 14px;">${reasons}</ul>
            </div>
            <div class="detail-section">
                <h3>Observing window</h3>
                <div class="mini-grid">
                    <div class="stat"><div class="label">Start</div><div class="value">${t(r.start)}</div><div class="sub">${tUtc(r.start)} UT</div></div>
                    <div class="stat"><div class="label">End</div><div class="value">${t(r.end)}</div><div class="sub">${tUtc(r.end)} UT</div></div>
                    <div class="stat"><div class="label">Length</div><div class="value">${A.formatDuration((r.end - r.start) * 24)}</div><div class="sub">alt ${Math.round(r.altMin)}–${Math.round(r.altMax)}°</div></div>
                </div>
                <div style="margin-top: 12px;">${altitudeChart(r)}</div>
                <dl class="kv" style="margin-top: 10px;">${contacts}</dl>
            </div>
            <div class="detail-section">
                <h3>Predicted light curve</h3>
                ${lightCurveChart(r)}
                <p class="xsmall dim" style="margin-top: 6px;">Grey: simulated ${p.exposure}s frames with the predicted scatter; coloured: 5-minute means. Shape is schematic; depth, timing and noise are from the model.</p>
            </div>
            <div class="detail-section">
                <h3>Exposure plan (${esc(s.rig.filter)} filter)</h3>
                <div class="mini-grid">
                    <div class="stat"><div class="label">Exposure</div><div class="value">${p.exposure} s</div><div class="sub">cadence ${fmt(p.cadence, 1)} s</div></div>
                    <div class="stat"><div class="label">Focus</div><div class="value">${p.defocused ? `defocus ${fmt(p.psf, 0)}″` : 'in focus'}</div><div class="sub">aperture r≈${fmt(p.apertureRadius, 1)}″</div></div>
                    <div class="stat"><div class="label">Frames</div><div class="value">${frames}</div><div class="sub">for the window</div></div>
                    <div class="stat"><div class="label">Peak pixel</div><div class="value">${Math.round(p.peakFraction * 100)}% FW</div><div class="sub">≈${Math.round(p.peakFraction * 65535).toLocaleString()} ADU</div></div>
                    <div class="stat"><div class="label">Scatter / frame</div><div class="value">${fmt(p.sigmaFrame * 1000, 1)} ppt</div><div class="sub">scint. ${fmt(p.scintillation * 1000, 1)} ppt</div></div>
                    <div class="stat"><div class="label">Scatter / 5 min</div><div class="value">${fmt(r.noise5 * 1000, 2)} ppt</div><div class="sub">sky ${fmt(r.cond.sky, 1)} mag/″²</div></div>
                </div>
                <dl class="kv" style="margin-top: 12px;">
                    <dt>Brightness</dt><dd>${esc(r.magText)} · depth ${esc(r.depthText)}</dd>
                    <dt>Airmass at event</dt><dd>${fmt(r.cond.X, 2)} (alt ${Math.round(r.cond.alt)}°)</dd>
                    <dt>Moon</dt><dd>${r.cond.moonAlt > 0 ? `${Math.round(r.cond.moonSep)}° away, ${Math.round(state.grid.moonPhase.fraction * 100)}% lit` : 'below horizon'}</dd>
                    <dt>Comparison stars</dt><dd>≈${fmt(p.compsAvailable, 1)} within 1 mag in field</dd>
                    <dt>Gain / offset</dt><dd>${esc(s.rig.gain)} / ${esc(s.rig.offset)} · ${esc(s.rig.readout || '')} · no dithering</dd>
                </dl>
            </div>
            <div class="detail-section">
                <h3>Field of view (${fmt(optics.fovW, 0)}′ × ${fmt(optics.fovH, 0)}′, north up)</h3>
                <div style="position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--border);background:#05070d;aspect-ratio:${s.rig.sensorW}/${s.rig.sensorH};">
                    <img src="${window.NVSky.fieldImageUrl(r.ra, r.dec, optics, 1.0, 560)}" alt="DSS2 image of the ${esc(r.name)} field" loading="lazy" style="width:100%;height:100%;object-fit:cover;opacity:0.92;">
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;">
                        <circle cx="50" cy="50" r="2.4" fill="none" stroke="${GROUPS[r.group].hex}" stroke-width="0.5" vector-effect="non-scaling-stroke"/>
                        <line x1="50" x2="50" y1="40" y2="46" stroke="${GROUPS[r.group].hex}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
                        <line x1="54" x2="60" y1="50" y2="50" stroke="${GROUPS[r.group].hex}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
                    </svg>
                </div>
                <p class="xsmall dim" style="margin-top:6px;">DSS2 colour via CDS hips2fits. Pick comparison stars of similar brightness and colour away from the field edges.</p>
            </div>
            <div class="detail-section">
                <h3>Target</h3>
                <dl class="kv">
                    <dt>RA / Dec (J2000)</dt><dd>${A.formatRa(r.ra, 1)} ${A.formatDec(r.dec, 0)}</dd>
                    <dt>RA / Dec (of date)</dt><dd>${A.formatRa(pNow.ra, 1)} ${A.formatDec(pNow.dec, 0)}</dd>
                    <dt>Period</dt><dd>${r.period < 1 ? `${fmt(r.period * 24, 3)} h` : `${fmt(r.period, 5)} d`}</dd>
                    ${ephem}
                </dl>
                <div class="link-row" style="margin-top: 12px;">${linksFor(r)}</div>
            </div>
            <div class="detail-section">
                <div class="row">
                    <button class="btn ${planned ? '' : 'btn-primary'} btn-sm" type="button" data-star="${esc(r.id)}">${planned ? 'Remove from plan' : 'Add to plan'}</button>
                    <button class="btn btn-sm" type="button" data-next="${esc(r.key)}">Find next nights</button>
                    ${r.group === 'transit' ? '<button class="btn btn-sm" type="button" id="d-refine">Check NASA timing</button>' : ''}
                </div>
                <div id="d-extra" style="margin-top: 12px;"></div>
            </div>`;
        const refine = $('d-refine');
        if (refine) refine.addEventListener('click', () => refineTiming(r));
        document.querySelectorAll('#target-rows tr').forEach(row => row.classList.toggle('is-selected', row.dataset.id === r.id));
    }

    async function refineTiming(r) {
        const box = $('d-extra');
        box.innerHTML = '<p class="small muted"><span class="spinner"></span> Asking the NASA Exoplanet Archive Transit Service…</p>';
        const endpoint = state.settings.cloud.endpoint.replace(/\/$/, '');
        const params = new URLSearchParams({ name: r.target.d.name.replace(/([a-z])$/i, ' $1').replace(/\s+/g, ' ').trim(), begin: String(r.t - 2), end: String(r.t + 2) });
        try {
            let result = await (await fetch(`${endpoint}/transit-timing?${params}`)).json();
            if (!result.ok && r.target.d.host) {
                params.set('name', `${r.target.d.host} ${r.name.slice(-1)}`);
                result = await (await fetch(`${endpoint}/transit-timing?${params}`)).json();
            }
            // The Transit Service reports mid-times as BJD_TDB (verified against identical ephemerides),
            // so convert to UTC before comparing.
            const rows = (result.rows || []).map(row => ({ mid: A.bjdTdbToJdUtc(Number(row.midpointjd), r.ra, r.dec), unc: Number(row.propmidpointunc) * 1440, ref: row.refname }))
                .filter(row => Number.isFinite(row.mid));
            const match = rows.sort((a, b) => Math.abs(a.mid - r.t) - Math.abs(b.mid - r.t))[0];
            if (!result.ok || !match) throw new Error(result.error || 'no matching transit');
            // The service may return a neighbouring transit; compare like cycles by removing whole periods.
            const cycles = Math.round((match.mid - r.t) / r.period);
            const diff = (match.mid - cycles * r.period - r.t) * 1440;
            const which = cycles === 0
                ? `mid-transit ${t(match.mid)} (${tUtc(match.mid)} UT)`
                : `ephemeris (checked on the transit ${Math.abs(cycles)} orbit${Math.abs(cycles) === 1 ? '' : 's'} ${cycles > 0 ? 'later' : 'earlier'})`;
            box.innerHTML = `<div class="notice notice-info">NASA Transit Service ${which}, ±${fmt(match.unc, 1)} min${match.ref ? `, ${esc(match.ref)}` : ''}. Difference from this planner: ${diff >= 0 ? '+' : ''}${fmt(diff, 1)} min.</div>`;
        } catch (error) {
            box.innerHTML = `<p class="small muted">NASA timing check unavailable (${esc(error.message)}).</p>`;
        }
    }

    async function nextNights(key) {
        const target = state.targets.find(tg => tg.key === key);
        if (!target) return;
        let box = $('d-extra');
        if (!box || state.selectedKey !== key) {
            $('detail').innerHTML = `<div class="detail-section"><p class="eyebrow">${esc(CLASS_LABEL[target.cls])}</p><h2 style="margin-top:6px;">${esc(target.name)}</h2><p class="small muted" style="margin-top:6px;">No usable event on ${esc(state.date)}.</p><div id="d-extra" style="margin-top: 12px;"></div></div>`;
            box = $('d-extra');
            state.selectedKey = key;
        }
        const highest = 90 - Math.abs(state.settings.site.lat - target.dec);
        if (highest < Number(state.settings.site.minAlt)) {
            box.innerHTML = `<p class="small muted">${esc(target.name)} (Dec ${A.formatDec(target.dec, 0)}) never rises above ${Math.max(0, Math.round(highest))}° from this site, below your ${state.settings.site.minAlt}° limit.</p>`;
            return;
        }
        box.innerHTML = '<p class="small muted"><span class="spinner"></span> Searching the next 60 nights…</p>';
        await new Promise(resolve => setTimeout(resolve, 20));
        const found = [];
        const saved = { grid: state.grid, night: state.night };
        for (let d = 1; d <= 60 && found.length < 8; d += 1) {
            const date = A.addDays(state.date, d);
            const night = A.night(date, state.settings.site, Number(state.settings.site.darkLimit));
            if (night.darkHours <= 0.25) continue;
            const grid = buildGrid(night, state.settings);
            state.grid = grid; state.night = night; // judge() reads moon phase from state.grid
            const events = evaluateTarget(target, grid).filter(r => r.verdict !== 'skip');
            for (const ev of events) found.push({ date, ev });
        }
        state.grid = saved.grid; state.night = saved.night;
        box.innerHTML = found.length
            ? `<h3 style="font-size:0.78rem;font-family:var(--font-mono);letter-spacing:0.12em;text-transform:uppercase;color:var(--text-dim);margin-bottom:8px;">Upcoming opportunities</h3>
               <div class="stack" style="--gap:6px">${found.map(({ date, ev }) => `<div class="row-between inset" style="margin-top:6px;"><span class="small"><strong>Night of ${A.formatDate(Date.parse(`${date}T12:00:00Z`), 'UTC')}</strong> · ${esc(ev.kind)} ${A.formatTime(A.msFromJd(ev.t), tz())} · ${Math.round(ev.altMin)}–${Math.round(ev.altMax)}°</span><span class="row">${verdictChip(ev)}<button class="btn btn-sm" type="button" data-goto-night="${date}">Open</button></span></div>`).join('')}</div>`
            : '<p class="small muted">No Go or Marginal events in the next 60 nights with the current settings.</p>';
    }

    // ------------------------------------------------------------------ plan & export

    function plannedResults() {
        const ids = planIds();
        return ids.map(id => state.results.find(r => r.id === id)).filter(Boolean).sort((a, b) => a.start - b.start);
    }

    function togglePlan(id) {
        const ids = new Set(planIds());
        if (ids.has(id)) ids.delete(id); else ids.add(id);
        state.plan[state.date] = [...ids];
        // Drop plans for nights more than two weeks old.
        for (const date of Object.keys(state.plan)) if (date < A.addDays(state.date, -14)) delete state.plan[date];
        writePlan();
        renderPlan();
        renderList();
        const selected = state.results.find(r => r.id === state.selectedId);
        if (selected) renderDetail(selected);
    }

    function renderPlan() {
        const items = plannedResults();
        const body = $('plan-body');
        if (!items.length) {
            body.innerHTML = '<p class="muted small">Star (☆) targets in the list to build a schedule. Overlapping windows are flagged.</p>';
            return;
        }
        let total = 0;
        body.innerHTML = items.map((r, i) => {
            const prev = items[i - 1];
            const conflict = prev && r.start < prev.end;
            total += r.end - r.start;
            return `<div class="plan-item ${conflict ? 'conflict' : ''}">
                <div><span class="cls-dot" style="background:${GROUPS[r.group].hex}"></span><strong>${esc(r.name)}</strong> <span class="dim small">${esc(r.kind)}</span></div>
                <button class="btn btn-ghost btn-sm" type="button" data-star="${esc(r.id)}" aria-label="Remove">✕</button>
                <div class="when">${t(r.start)}–${t(r.end)} · ${r.plan.exposure}s × ${Math.ceil((r.end - r.start) * 86400 / r.plan.cadence)}${conflict ? ` · overlaps ${esc(prev.name)}` : ''}</div>
                <div>${verdictChip(r)}</div>
            </div>`;
        }).join('') + `<p class="xsmall dim" style="margin-top:8px;">${items.length} targets · ${A.formatDuration(total * 24)} of imaging</p>`;
    }

    function exportCsv() {
        const items = plannedResults().length ? plannedResults() : visibleResults();
        const header = ['name', 'class', 'event', 'event_local', 'event_utc', 'start_local', 'end_local', 'start_utc', 'end_utc', 'ra_j2000', 'dec_j2000', 'mag', 'depth', 'exposure_s', 'defocus_fwhm_arcsec', 'frames', 'sigma_5min_ppt', 'snr', 'verdict', 'alt_min', 'alt_max'];
        const lines = items.map(r => [
            r.name, CLASS_LABEL[r.cls], r.kind, t(r.t), tUtc(r.t), t(r.start), t(r.end), tUtc(r.start), tUtc(r.end),
            A.formatRa(r.ra, 1), A.formatDec(r.dec, 0), r.magText, r.depthText, r.plan.exposure, r.plan.defocused ? fmt(r.plan.psf, 0) : '',
            Math.ceil((r.end - r.start) * 86400 / r.plan.cadence), fmt(r.noise5 * 1000, 2), fmt(r.snr, 1), r.verdict, Math.round(r.altMin), Math.round(r.altMax)
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
        download(`nightvector_${state.date}.csv`, [header.join(','), ...lines].join('\n'), 'text/csv');
    }

    // ------------------------------------------------------------------ wiring

    function setDate(date) {
        state.date = date;
        $('night-date').value = date;
        recompute();
    }

    function bind() {
        $('prev-night').addEventListener('click', () => setDate(A.addDays(state.date, -1)));
        $('next-night').addEventListener('click', () => setDate(A.addDays(state.date, 1)));
        $('tonight').addEventListener('click', () => setDate(A.nightDateNow(tz())));
        $('night-date').addEventListener('change', event => { if (event.target.value) setDate(event.target.value); });
        $('tabs').addEventListener('click', event => {
            const button = event.target.closest('[data-tab]');
            if (!button) return;
            state.tab = button.dataset.tab;
            state.limit = PAGE_SIZE;
            document.querySelectorAll('#tabs [data-tab]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
            renderList();
        });
        $('show-marginal').addEventListener('change', event => { state.showMarginal = event.target.checked; renderList(); });
        $('show-rejected').addEventListener('change', event => { state.showRejected = event.target.checked; renderList(); });
        $('sort').addEventListener('change', event => { state.sort = event.target.value; renderList(); });
        let searchTimer;
        $('search').addEventListener('input', event => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => { state.search = event.target.value.trim(); state.limit = PAGE_SIZE; renderList(); }, 150);
        });
        $('show-more').addEventListener('click', () => { state.limit += PAGE_SIZE; renderList(); });
        $('target-rows').addEventListener('click', event => {
            const star = event.target.closest('[data-star]');
            if (star) { event.stopPropagation(); togglePlan(star.dataset.star); return; }
            const row = event.target.closest('tr[data-id]');
            if (!row) return;
            const r = state.results.find(x => x.id === row.dataset.id);
            if (r) {
                renderDetail(r);
                if (window.matchMedia('(max-width: 1280px)').matches) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
        document.addEventListener('click', event => {
            const next = event.target.closest('[data-next]');
            if (next) { nextNights(next.dataset.next); return; }
            const star = event.target.closest('#detail [data-star], #plan-body [data-star]');
            if (star) { togglePlan(star.dataset.star); return; }
            const open = event.target.closest('[data-goto-night]');
            if (open) { const key = state.selectedKey; setDate(open.dataset.gotoNight); state.selectedKey = key; }
        });
        $('plan-csv').addEventListener('click', exportCsv);
        window.NVSetup.mount({
            criteria: 'photometry',
            getSettings: () => state.settings,
            onSave(next, { siteChanged }) {
                state.settings = next;
                if (siteChanged) { state.date = A.nightDateNow(tz()); $('night-date').value = state.date; loadWeather(); }
                recompute();
            }
        });
        ['open-setup', 'ctx-site', 'ctx-rig'].forEach(id => $(id).addEventListener('click', () => window.NVSetup.open()));
        setInterval(() => { if (!state.computing && state.grid) renderList(); }, 5 * 60 * 1000);
    }

    async function init() {
        window.__nightVector = state; // handy for inspecting results from the console
        bind();
        const hashTab = location.hash.replace('#', '');
        if (['transit', 'eclipse', 'pulsator', 'cv'].includes(hashTab)) {
            state.tab = hashTab;
            document.querySelectorAll('#tabs [data-tab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === hashTab)));
        }
        state.date = A.nightDateNow(tz());
        $('night-date').value = state.date;
        try {
            await loadCatalogs();
        } catch (error) {
            $('list-status').textContent = `Could not load target catalogs (${error.message}).`;
            return;
        }
        recompute();
        loadWeather();
    }

    init();
})();
