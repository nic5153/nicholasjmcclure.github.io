/*
 * Deep-Sky Planner: which galaxies, nebulae and clusters are worth imaging on
 * the selected night with this rig.  For each object it checks usable time in
 * darkness above the site limits, framing against the camera field, and the
 * integration needed to reach a clean signal at the object's mean surface
 * brightness under that night's sky (Moon included).
 */
(function () {
    'use strict';

    const A = window.Astro;
    const NV = window.NVSettings;
    const SKY = window.NVSky;
    const CTX = window.NVContext;
    const $ = id => document.getElementById(id);
    const MIN = SKY.MIN;
    const PAGE_SIZE = 60;

    const GROUP_COLOR = { galaxy: '#b7a6ff', nebula: '#f59fb8', pn: '#8fd3ff', cluster: '#f3c45a' };
    const PROJECT_KEY = 'nv.dsoProjects.v1';
    const CUSTOM_KEY = 'nv.dsoCustom.v1';

    const state = {
        settings: NV.load(),
        date: null,
        night: null,
        grid: null,
        objects: [],
        results: [],
        tab: 'all',
        showMarginal: true,
        showRejected: false,
        sort: 'score',
        search: '',
        limit: PAGE_SIZE,
        selectedId: null,
        rotate: false,
        projects: readJson(PROJECT_KEY, null),
        custom: readJson(CUSTOM_KEY, null)
    };

    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
    const norm = text => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const clamp = A.clamp;
    function tz() { return state.settings.site.tz || 'UTC'; }
    function t(jd) { return jd == null ? '—' : A.formatTime(A.msFromJd(jd), tz()); }
    function tUtc(jd) { return jd == null ? '—' : A.formatTime(A.msFromJd(jd), 'UTC'); }

    function readJson(key, fallback) {
        try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; }
    }
    function writeJson(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    }

    function groupOf(type) {
        const t = type.toLowerCase();
        if (t.startsWith('galaxy')) return 'galaxy';
        if (t.includes('planetary')) return 'pn';
        if (t.includes('cluster') && !t.includes('nebula')) return 'cluster';
        if (t.includes('association')) return 'cluster';
        return 'nebula';
    }

    // ------------------------------------------------------------------ data & migration

    async function loadCatalog() {
        const data = await fetch('files/data/dso.json').then(r => r.json());
        const objects = data.rows.map(row => Object.fromEntries(data.fields.map((f, i) => [f, row[i]])));
        state.objects = objects.map(o => ({ ...o, key: `D:${o.id}`, group: groupOf(o.type), messier: /^M\d+$/.test(o.id) }));
    }

    /** One-time import of projects and custom DSO targets from the original NightVector page. */
    function migrateLegacy() {
        if (state.projects === null) {
            const projects = [];
            const profiles = readJson('observingPlannerProfiles', []);
            for (const profile of Array.isArray(profiles) ? profiles : []) {
                for (const program of profile.programs || []) {
                    for (const plan of program.plans || []) {
                        if (plan.mode !== 'dso' || !plan.target) continue;
                        const ra = A.parseRa(plan.target.ra);
                        const dec = A.parseDec(plan.target.dec);
                        if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
                        projects.push({
                            id: `p-${Date.now()}-${projects.length}`, name: plan.target.name, ra, dec,
                            size: Number(plan.target.size) || null, mag: Number(plan.target.mag) || null,
                            goalHours: Number(plan.goalHours) || 4, capturedHours: Number(plan.capturedHours) || 0,
                            note: program.name ? `Imported from “${program.name}”` : 'Imported'
                        });
                    }
                }
            }
            state.projects = projects;
            writeJson(PROJECT_KEY, projects);
        }
        if (state.custom === null) {
            const legacy = readJson('observingCustomTargets', []);
            state.custom = (Array.isArray(legacy) ? legacy : []).filter(t => (t.mode || []).includes('dso')).map(t => ({
                id: t.name, name: '', type: t.type || 'Galaxy', ra: A.parseRa(t.ra), dec: A.parseDec(t.dec),
                maj: Number(t.size) || null, min: null, pa: null, mag: Number(t.mag) || null, sb: null, const: '', ref: 'custom'
            })).filter(t => Number.isFinite(t.ra) && Number.isFinite(t.dec));
            writeJson(CUSTOM_KEY, state.custom);
        }
    }

    function allObjects() {
        const custom = (state.custom || []).map(o => ({ ...o, key: `C:${o.id}`, group: groupOf(o.type), messier: false, custom: true }));
        return [...state.objects, ...custom];
    }

    // ------------------------------------------------------------------ evaluation

    function imagingRig() {
        const s = state.settings;
        return { ...s.rig, readNoise: Number(s.imaging.readNoise) || s.rig.readNoise };
    }

    /**
     * Mean surface brightness in V mag/arcsec^2.  Galaxies use the OpenNGC value (B, within D25);
     * others spread the integrated magnitude over the catalogued ellipse.  Catalogue magnitudes of
     * emission/reflection nebulae and SNRs often belong to embedded stars (NGC 1980's "2.5" is iota Ori),
     * so their broadband surface brightness is floored at 21 mag/arcsec^2.
     */
    function meanSurfaceBrightness(o) {
        const maj = o.maj;
        const min = o.min || maj;
        let mu = null;
        if (o.group === 'galaxy' && Number.isFinite(o.sb)) mu = o.sb - 0.8; // OpenNGC SurfBr is B mag/arcsec^2; B-V ~ 0.8
        else if (Number.isFinite(o.mag) && maj > 0) mu = o.mag + 2.5 * Math.log10(Math.PI / 4 * maj * min) + 8.89;
        else if (o.group === 'nebula') mu = 22.5;
        if (mu !== null && o.group === 'nebula') mu = Math.max(mu, 21.0);
        return mu;
    }

    function framing(o, optics) {
        const maj = o.maj;
        const min = o.min || maj;
        if (!(maj > 0)) return { kind: 'unknown', label: 'Size unknown', fill: null };
        const fill = maj / optics.fovW;
        if (maj <= 0.85 * optics.fovW && min <= 0.85 * optics.fovH) {
            if (maj < 0.4) return { kind: 'tiny', label: 'Very small', fill };
            if (maj < 1.2) return { kind: 'small', label: 'Small', fill };
            return { kind: 'fits', label: `Fits · ${Math.round(fill * 100)}%`, fill };
        }
        if (maj <= optics.fovW && min <= optics.fovH) return { kind: 'tight', label: 'Tight fit', fill };
        const panels = Math.ceil(maj / (0.85 * optics.fovW)) * Math.ceil(min / (0.85 * optics.fovH));
        return { kind: 'mosaic', label: `Mosaic ${panels} panels`, fill, panels };
    }

    function subExposure(sky, filter) {
        const s = state.settings;
        const raw = A.skyLimitedSub({ rig: imagingRig(), sky, filter, swamp: Number(s.imaging.swamp) || 10 }).seconds;
        const capped = clamp(raw, 15, Number(s.imaging.maxSub) || 180);
        return capped >= 60 ? Math.round(capped / 10) * 10 : Math.round(capped / 5) * 5;
    }

    function evaluate(o, grid) {
        const trk = SKY.track(grid, o.ra, o.dec);
        if (!trk) return null;
        const s = state.settings;
        const optics = A.optics(s.rig);
        const iv = trk.intervals.slice().sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
        const best = (iv[1] - iv[0]) * 24;
        const peak = SKY.culmination(grid, trk, iv);
        const cond = SKY.conditions(grid, trk, peak, 'L');
        const frame = framing(o, optics);
        const mu = meanSurfaceBrightness(o);
        const starry = o.group === 'cluster';
        // "Clean image": S/N 30 per 2" x 2" element at the mean surface brightness, in luminance.
        const hours = starry ? 0.5 : mu ? A.hoursForSurfaceBrightness({ rig: imagingRig(), mu, sky: cond.sky, filter: 'L', snr: 30, element: 4 }) : null;
        const subL = subExposure(cond.sky, 'L');
        const subRGB = subExposure(cond.sky, 'G');
        const reasons = [];
        const minHours = Number(s.imaging.minHours) || 1.5;
        const maxInt = Number(s.imaging.maxIntegration) || 12;
        if (best < minHours * 0.999) reasons.push({ level: best >= minHours * 0.6 ? 'warn' : 'bad', text: `Only ${A.formatDuration(best)} usable tonight (want ${A.formatDuration(minHours)})` });
        else reasons.push({ level: 'good', text: `${A.formatDuration(best)} usable, ${t(iv[0])}–${t(iv[1])}, highest ${Math.round(trk.maxAlt)}° at ${t(peak)}` });
        if (frame.kind === 'mosaic') reasons.push({ level: 'bad', text: `${fmt(o.maj, 0)}′ × ${fmt(o.min || o.maj, 0)}′ is larger than the ${fmt(optics.fovW, 0)}′ × ${fmt(optics.fovH, 0)}′ field (${frame.label.toLowerCase()})` });
        else if (frame.kind === 'tight') reasons.push({ level: 'warn', text: 'Fills the whole frame: little room for framing errors' });
        else if (frame.kind === 'tiny') reasons.push({ level: 'bad', text: `Very small (${fmt(o.maj * 60, 0)}″): a few dozen pixels at ${fmt(optics.scale, 2)}″/px` });
        else if (frame.kind === 'small') reasons.push({ level: 'info', text: `Small (${fmt(o.maj, 1)}′): needs good seeing; consider a crop` });
        else if (frame.kind === 'fits') reasons.push({ level: 'good', text: `Fits the field, spanning ${Math.round(frame.fill * 100)}% of the long side` });
        if (starry) reasons.push({ level: 'good', text: 'Star cluster: short integrations work well' });
        else if (hours === null) reasons.push({ level: 'warn', text: 'No brightness data; integration unknown' });
        else if (hours > maxInt * 2) reasons.push({ level: 'bad', text: `Needs ≈${fmt(hours, 0)} h at tonight's sky (${fmt(cond.sky, 1)} mag/″²); limit ${maxInt} h` });
        else if (hours > maxInt) reasons.push({ level: 'warn', text: `Needs ≈${fmt(hours, 0)} h at tonight's sky: a multi-night project` });
        else reasons.push({ level: 'good', text: `≈${hours < 1 ? `${Math.max(5, Math.round(hours * 60))} min` : `${fmt(hours, 1)} h`} for a clean image at tonight's sky` });
        if (cond.moonAlt > 0 && cond.moonSep < 35) reasons.push({ level: cond.moonSep < 20 ? 'warn' : 'info', text: `Moon ${Math.round(cond.moonSep)}° away (${Math.round(grid.moonPhase.fraction * 100)}% lit)` });
        if (o.custom) reasons.push({ level: 'info', text: 'Custom target' });
        const verdict = reasons.some(r => r.level === 'bad') ? 'skip' : reasons.some(r => r.level === 'warn') ? 'marginal' : 'go';
        const sizeScore = frame.kind === 'fits' ? clamp(1 - Math.abs(frame.fill - 0.5) / 0.6, 0.35, 1) : { tight: 0.5, small: 0.45, tiny: 0.1, mosaic: 0.15, unknown: 0.3 }[frame.kind];
        const signalScore = starry ? 0.8 : hours === null ? 0.3 : 1 / (1 + hours / 3);
        const timeScore = clamp(best / 5, 0, 1);
        const altScore = clamp((trk.maxAlt - 25) / 55, 0, 1);
        const moonScore = cond.moonAlt > 0 ? clamp(cond.moonSep / 90, 0, 1) : 1;
        const fame = (o.messier ? 1.25 : 1) * (o.name ? 1.1 : 1);
        const score = (0.3 * signalScore + 0.25 * sizeScore + 0.2 * timeScore + 0.15 * altScore + 0.1 * moonScore) * fame * { go: 1, marginal: 0.55, skip: 0.1 }[verdict];
        return {
            id: o.key, o, trk, window: iv, peak, best, cond, frame, mu, hours, subL, subRGB, reasons, verdict, score
        };
    }

    // ------------------------------------------------------------------ compute & list

    function recompute() {
        $('list-status').innerHTML = '<span class="spinner"></span> Computing tonight…';
        setTimeout(() => {
            const s = state.settings;
            const darkLimit = Number(s.imaging.darkLimit) || -18;
            state.night = A.night(state.date, s.site, darkLimit);
            state.grid = SKY.buildGrid(state.night, s, { darkLimit });
            state.results = state.night.darkHours > 0.25 ? allObjects().map(o => evaluate(o, state.grid)).filter(Boolean) : [];
            state.limit = PAGE_SIZE;
            CTX.render({ settings: s, night: state.night, darkLimit });
            renderList();
            renderProjects();
            const selected = state.results.find(r => r.id === state.selectedId);
            if (selected) renderDetail(selected);
        }, 20);
    }

    function visible() {
        let list = state.results;
        if (state.search) {
            const q = norm(state.search);
            list = list.filter(r => norm(`${r.o.id} ${r.o.name} ${r.o.ref}`).includes(q));
        } else if (state.tab === 'projects') {
            list = list.filter(isProject); // every project, whatever tonight's verdict
        } else {
            if (state.tab !== 'all') list = list.filter(r => r.o.group === state.tab);
            list = list.filter(r => r.verdict === 'go' || (r.verdict === 'marginal' && state.showMarginal) || (r.verdict === 'skip' && state.showRejected));
        }
        const by = {
            score: (a, b) => b.score - a.score,
            transit: (a, b) => b.trk.maxAlt - a.trk.maxAlt,
            time: (a, b) => a.window[0] - b.window[0],
            size: (a, b) => (b.o.maj || 0) - (a.o.maj || 0),
            easy: (a, b) => (a.hours ?? 99) - (b.hours ?? 99)
        }[state.sort];
        return list.slice().sort((a, b) => (a.verdict === 'skip') - (b.verdict === 'skip') || by(a, b));
    }

    function chip(verdict) {
        const [cls, label] = { go: ['chip-go', 'Go'], marginal: ['chip-warn', 'Marginal'], skip: ['chip-stop', 'Skip'] }[verdict];
        return `<span class="chip ${cls}"><span class="dot"></span>${label}</span>`;
    }

    function integrationText(r) {
        if (r.o.group === 'cluster') return '<1 h';
        if (r.hours === null) return '—';
        if (r.hours < 1) return `${Math.max(5, Math.round(r.hours * 60))} min`;
        return r.hours >= 99 ? '>99 h' : `${fmt(r.hours, r.hours < 10 ? 1 : 0)} h`;
    }

    function isProject(r) {
        return state.projects.some(p => p.key === r.id || (!p.key && p.name === r.o.id));
    }

    function rowHtml(r) {
        const o = r.o;
        const starred = isProject(r);
        const sub = [o.name, o.type, o.const].filter(Boolean).join(' · ');
        const size = o.maj ? `${fmt(o.maj, o.maj < 10 ? 1 : 0)}′${o.min && o.min !== o.maj ? `×${fmt(o.min, o.min < 10 ? 1 : 0)}′` : ''}` : '—';
        return `<tr data-id="${esc(r.id)}" class="${r.id === state.selectedId ? 'is-selected' : ''}">
            <td><button class="star-btn" type="button" data-star="${esc(r.id)}" aria-pressed="${starred}" title="${starred ? 'In projects' : 'Add to projects'}">${starred ? '★' : '☆'}</button></td>
            <td><span class="cls-dot" style="background:${GROUP_COLOR[o.group]}"></span><span class="name">${esc(o.id)}</span><span class="sub">${esc(sub)}</span></td>
            <td class="num">${t(r.window[0])}–${t(r.window[1])}</td>
            <td class="tl">${CTX.timelineBar(state.grid, state.night, r.window, r.peak, GROUP_COLOR[o.group])}</td>
            <td class="num hide-sm">${Math.round(r.trk.maxAlt)}°</td>
            <td class="num">${size}</td>
            <td><span class="small ${r.frame.kind === 'mosaic' || r.frame.kind === 'tiny' ? 'dim' : ''}">${esc(r.frame.label)}</span></td>
            <td class="num hide-sm">${o.mag != null ? fmt(o.mag, 1) : '—'}</td>
            <td class="num hide-md">${r.cond.moonAlt > 0 ? `${Math.round(r.cond.moonSep)}°` : 'down'}</td>
            <td class="num">${integrationText(r)}</td>
            <td>${chip(r.verdict)}</td>
        </tr>`;
    }

    function renderList() {
        $('tl-axis').innerHTML = state.grid ? CTX.axisLabels(state.grid, tz()) : '';
        const counts = { all: 0, galaxy: 0, nebula: 0, pn: 0, cluster: 0 };
        for (const r of state.results) if (r.verdict === 'go') { counts.all += 1; counts[r.o.group] += 1; }
        counts.projects = state.projects.length;
        document.querySelectorAll('[data-count]').forEach(el => { el.textContent = String(counts[el.dataset.count] ?? 0); });
        const rows = visible();
        const shown = rows.slice(0, state.limit);
        $('target-rows').innerHTML = shown.map(rowHtml).join('');
        const empty = $('list-empty');
        empty.classList.toggle('hidden', rows.length > 0);
        if (!rows.length) {
            empty.innerHTML = state.tab === 'projects' && !state.search
                ? (state.projects.length
                    ? '<h3>No project is above your limits tonight</h3><p class="small">Use “Best nights ahead” on a project to find when it is well placed.</p>'
                    : '<h3>No projects yet</h3><p class="small">Star (☆) objects to keep them here across nights and track captured hours.</p>')
                : state.night && state.night.darkHours <= 0.25
                ? '<h3>No dark time</h3><p class="small">The Sun does not reach the imaging darkness limit on this night.</p>'
                : state.search ? `<h3>No match for “${esc(state.search)}” above your limits tonight</h3><p class="small">It may be below the minimum altitude, or not in the catalog (add it as a custom target).</p>`
                    : '<h3>Nothing passes the cuts</h3><p class="small">Show marginal or rejected objects, or relax the limits in Setup.</p>';
        }
        $('show-more').classList.toggle('hidden', rows.length <= state.limit);
        $('list-status').textContent = `${shown.length} of ${rows.length} shown · ${counts.all} worth imaging tonight from ${allObjects().length.toLocaleString()} objects`;
    }

    // ------------------------------------------------------------------ detail

    function framingPreview(r) {
        const optics = A.optics(state.settings.rig);
        const scale = r.frame.kind === 'mosaic' ? Math.min(3, (r.o.maj / optics.fovW) * 1.15) : 1.6;
        // Image spans `scale` x the field width; SVG units are arcmin-proportional (100 units = image width).
        const W = 100;
        const H = 100 * optics.fovH / optics.fovW;
        const pxPerArcmin = W / (optics.fovW * scale);
        const ellipse = r.o.maj ? `<ellipse cx="${W / 2}" cy="${H / 2}" rx="${(r.o.min || r.o.maj) / 2 * pxPerArcmin}" ry="${r.o.maj / 2 * pxPerArcmin}" transform="rotate(${-(r.o.pa || 0)} ${W / 2} ${H / 2})" fill="none" stroke="${GROUP_COLOR[r.o.group]}" stroke-width="0.35" stroke-dasharray="1.2 0.8"/>` : '';
        const frameW = (state.rotate ? optics.fovH : optics.fovW) * pxPerArcmin;
        const frameH = (state.rotate ? optics.fovW : optics.fovH) * pxPerArcmin;
        return `<div class="framing" style="aspect-ratio:${W}/${H};">
            <img src="${SKY.fieldImageUrl(r.o.ra, r.o.dec, optics, scale, 640)}" alt="DSS2 image around ${esc(r.o.id)}" loading="lazy">
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
                <rect x="${(W - frameW) / 2}" y="${(H - frameH) / 2}" width="${frameW}" height="${frameH}" fill="none" stroke="#e7ecf6" stroke-width="0.4"/>
                ${ellipse}
            </svg>
        </div>`;
    }

    function planFor(r) {
        const s = state.settings;
        const hours = Math.max(0, r.best);
        const overhead = (s.rig.overhead || 3) + 2; // download + dither settle, averaged
        const lSeconds = hours * 3600 * 0.5;
        const cSeconds = hours * 3600 * 0.5 / 3;
        return [
            { filter: 'L', sub: r.subL, count: Math.floor(lSeconds / (r.subL + overhead)) },
            { filter: 'R', sub: r.subRGB, count: Math.floor(cSeconds / (r.subRGB + overhead)) },
            { filter: 'G', sub: r.subRGB, count: Math.floor(cSeconds / (r.subRGB + overhead)) },
            { filter: 'B', sub: r.subRGB, count: Math.floor(cSeconds / (r.subRGB + overhead)) }
        ].filter(line => line.count > 0);
    }

    function renderDetail(r) {
        state.selectedId = r.id;
        const o = r.o;
        const s = state.settings;
        const optics = A.optics(s.rig);
        const lines = planFor(r);
        const total = lines.reduce((sum, l) => sum + l.sub * l.count, 0) / 3600;
        const pNow = A.precess(o.ra, o.dec, state.night.midnight);
        const reasons = r.reasons.map(x => `<li class="${{ good: 'good', warn: 'warn', bad: 'bad' }[x.level] || ''}">${esc(x.text)}</li>`).join('');
        const starred = isProject(r);
        const raS = A.formatRa(o.ra, 1);
        const decS = A.formatDec(o.dec, 0);
        const links = [
            [`https://aladin.cds.unistra.fr/AladinLite/?target=${encodeURIComponent(`${raS} ${decS}`)}&fov=${(optics.fovW * 2 / 60).toFixed(2)}&survey=CDS%2FP%2FDSS2%2Fcolor`, 'Aladin'],
            [`https://simbad.cds.unistra.fr/simbad/sim-id?Ident=${encodeURIComponent(o.ref || o.id)}`, 'SIMBAD']
        ];
        if (o.group === 'galaxy') links.push([`https://ned.ipac.caltech.edu/byname?objname=${encodeURIComponent(o.ref || o.id)}`, 'NED']);
        const progress = Math.min(100, Math.round(total / Math.max(r.hours || total, 0.1) * 100));
        $('detail').innerHTML = `
            <div class="detail-section">
                <div class="row-between">
                    <div class="grow">
                        <p class="eyebrow" style="color:${GROUP_COLOR[o.group]}">${esc(o.type)}${o.const ? ` · ${esc(o.const)}` : ''}</p>
                        <h2 style="margin-top:6px;">${esc(o.id)}${o.name ? ` <span class="muted" style="font-weight:500;">${esc(o.name)}</span>` : ''}</h2>
                        <p class="muted small" style="margin-top:4px;">${o.ref ? `${esc(o.ref)} · ` : ''}${o.maj ? `${fmt(o.maj, 1)}′ × ${fmt(o.min || o.maj, 1)}′` : 'size unknown'}${o.mag != null ? ` · mag ${fmt(o.mag, 1)}` : ''}${r.mu ? ` · μ ≈ ${fmt(r.mu, 1)} mag/″²` : ''}</p>
                    </div>
                    ${chip(r.verdict)}
                </div>
                <ul class="reason-list" style="margin-top: 14px;">${reasons}</ul>
            </div>
            <div class="detail-section">
                <div class="row-between" style="margin-bottom:10px;"><h3 style="margin:0;">Framing (${fmt(optics.fovW, 0)}′ × ${fmt(optics.fovH, 0)}′, north up)</h3>
                    <button class="btn btn-sm" type="button" id="d-rotate">${state.rotate ? 'Landscape' : 'Rotate 90°'}</button></div>
                ${framingPreview(r)}
                <p class="xsmall dim" style="margin-top:6px;">White box: sensor field. Dashed ellipse: catalogued size and position angle. DSS2 via CDS hips2fits.</p>
            </div>
            <div class="detail-section">
                <h3>Tonight</h3>
                ${SKY.altitudeChart(state.grid, r.trk, { tz: tz(), color: GROUP_COLOR[o.group], window: r.window, mark: r.peak, label: o.id })}
                <dl class="kv" style="margin-top: 10px;">
                    <dt>Usable window</dt><dd>${t(r.window[0])}–${t(r.window[1])} (${A.formatDuration(r.best)})</dd>
                    <dt>Highest</dt><dd>${Math.round(r.trk.maxAlt)}° at ${t(r.peak)} (${tUtc(r.peak)} UT)</dd>
                    <dt>Sky at best time</dt><dd>${fmt(r.cond.sky, 1)} mag/″² ${r.cond.moonAlt > 0 ? `· Moon ${Math.round(r.cond.moonSep)}° away` : '· Moon down'}</dd>
                </dl>
            </div>
            <div class="detail-section">
                <h3>Exposure plan</h3>
                <div class="mini-grid">
                    <div class="stat"><div class="label">L sub</div><div class="value">${r.subL} s</div><div class="sub">sky-limited</div></div>
                    <div class="stat"><div class="label">RGB sub</div><div class="value">${r.subRGB} s</div><div class="sub">each filter</div></div>
                    <div class="stat"><div class="label">Needed</div><div class="value">${integrationText(r)}</div><div class="sub">S/N 30 per 2″</div></div>
                </div>
                <table class="data" style="margin-top: 12px;">
                    <thead><tr><th>Filter</th><th class="num">Sub</th><th class="num">Frames</th><th class="num">Time</th></tr></thead>
                    <tbody>${lines.map(l => `<tr style="cursor:default"><td>${l.filter}</td><td class="num">${l.sub} s</td><td class="num">${l.count}</td><td class="num">${A.formatDuration(l.sub * l.count / 3600)}</td></tr>`).join('')}</tbody>
                </table>
                <p class="small muted" style="margin-top: 10px;">Tonight collects ≈${A.formatDuration(total)} of light${r.hours && o.group !== 'cluster' ? ` (${progress}% of the estimated need)` : ''}. Gain/offset ${esc(s.rig.gain)}/${esc(s.rig.offset)}; dither every 3–5 frames.</p>
            </div>
            <div class="detail-section">
                <h3>Coordinates</h3>
                <dl class="kv">
                    <dt>J2000</dt><dd>${raS} ${decS}</dd>
                    <dt>Of date</dt><dd>${A.formatRa(pNow.ra, 1)} ${A.formatDec(pNow.dec, 0)}</dd>
                    ${o.pa != null ? `<dt>Position angle</dt><dd>${fmt(o.pa, 0)}°</dd>` : ''}
                </dl>
                <div class="link-row" style="margin-top: 12px;">${links.map(([href, label]) => `<a class="btn btn-sm" href="${href}" target="_blank" rel="noopener">${label}</a>`).join('')}</div>
            </div>
            <div class="detail-section">
                <div class="row">
                    <button class="btn btn-sm ${starred ? '' : 'btn-primary'}" type="button" data-star="${esc(r.id)}">${starred ? 'In projects' : 'Add to projects'}</button>
                    <button class="btn btn-sm" type="button" id="d-nights">Best nights ahead</button>
                </div>
                <div id="d-extra" style="margin-top: 12px;"></div>
            </div>`;
        $('d-rotate').addEventListener('click', () => { state.rotate = !state.rotate; renderDetail(r); });
        $('d-nights').addEventListener('click', () => bestNights(o));
        document.querySelectorAll('#target-rows tr').forEach(row => row.classList.toggle('is-selected', row.dataset.id === r.id));
    }

    async function bestNights(o) {
        const box = $('d-extra');
        box.innerHTML = '<p class="small muted"><span class="spinner"></span> Checking the next 30 nights…</p>';
        await new Promise(resolve => setTimeout(resolve, 20));
        const s = state.settings;
        const darkLimit = Number(s.imaging.darkLimit) || -18;
        const out = [];
        for (let d = 0; d < 30; d += 1) {
            const date = A.addDays(state.date, d);
            const night = A.night(date, s.site, darkLimit);
            if (night.darkHours <= 0.25) continue;
            const grid = SKY.buildGrid(night, s, { darkLimit });
            const r = evaluate(o, grid);
            if (r) out.push({ date, r, moon: night.moon.fraction });
        }
        out.sort((a, b) => (a.r.hours ?? 99) / Math.max(a.r.best, 0.1) - (b.r.hours ?? 99) / Math.max(b.r.best, 0.1));
        box.innerHTML = out.length
            ? `<p class="small muted" style="margin-bottom:6px;">Ranked by how much of the needed integration each night delivers.</p>${out.slice(0, 8).map(({ date, r, moon }) => `
                <div class="row-between inset" style="margin-top:6px;">
                    <span class="small"><strong>Night of ${A.formatDate(Date.parse(`${date}T12:00:00Z`), 'UTC')}</strong> · ${A.formatDuration(r.best)} usable · Moon ${Math.round(moon * 100)}% · ${integrationText(r)} needed</span>
                    <span class="row">${chip(r.verdict)}<button class="btn btn-sm" type="button" data-goto-night="${date}">Open</button></span>
                </div>`).join('')}`
            : '<p class="small muted">Not observable in the next 30 nights with the current limits.</p>';
    }

    // ------------------------------------------------------------------ projects

    function renderProjects() {
        const list = $('project-list');
        const projects = state.projects;
        $('project-count').textContent = projects.length ? `${projects.length} active` : '';
        if (!projects.length) {
            list.innerHTML = '<p class="muted small">Star (☆) an object to track integration across nights.</p>';
            return;
        }
        list.innerHTML = projects.map(p => {
            const r = state.results.find(x => x.id === p.key) || state.results.find(x => x.o.id === p.name);
            const pct = Math.min(100, Math.round((p.capturedHours || 0) / Math.max(p.goalHours || 1, 0.1) * 100));
            const tonight = r ? `${chip(r.verdict)} <span class="xsmall dim">${t(r.window[0])}–${t(r.window[1])}</span>` : '<span class="xsmall dim">not up tonight</span>';
            return `<div class="project" data-project="${esc(p.id)}">
                <div class="row-between"><button class="btn btn-ghost btn-sm" type="button" data-open-project="${esc(p.id)}" style="padding-left:0;font-weight:700;color:var(--text);">${esc(p.name)}</button><span class="row" style="gap:6px;">${tonight}</span></div>
                <div class="progress" style="margin:6px 0;"><span style="width:${pct}%"></span></div>
                <div class="row-between xsmall dim">
                    <span>Captured <input class="input mono" type="number" min="0" step="0.25" value="${p.capturedHours || 0}" data-field="capturedHours"> of <input class="input mono" type="number" min="0.25" step="0.25" value="${p.goalHours || 4}" data-field="goalHours"> h</span>
                    <button class="btn btn-ghost btn-sm" type="button" data-remove-project="${esc(p.id)}">Remove</button>
                </div>
            </div>`;
        }).join('');
        list.querySelectorAll('input[data-field]').forEach(input => input.addEventListener('change', () => {
            const id = input.closest('[data-project]').dataset.project;
            const project = state.projects.find(p => p.id === id);
            project[input.dataset.field] = Math.max(0, Number(input.value) || 0);
            writeJson(PROJECT_KEY, state.projects);
            renderProjects();
        }));
    }

    function toggleProject(id) {
        const r = state.results.find(x => x.id === id);
        if (!r) return;
        const existing = state.projects.find(p => p.key === r.id || (!p.key && p.name === r.o.id));
        if (existing) state.projects = state.projects.filter(p => p !== existing);
        else state.projects.push({ id: `p-${Date.now()}`, key: r.id, name: r.o.id, ra: r.o.ra, dec: r.o.dec, goalHours: Math.max(1, Math.ceil(r.hours || 4)), capturedHours: 0 });
        writeJson(PROJECT_KEY, state.projects);
        renderProjects();
        renderList();
        if (state.selectedId === id) renderDetail(r);
    }

    // ------------------------------------------------------------------ custom targets & cloud

    async function lookupCustom() {
        const name = $('c-name').value.trim();
        if (!name) return;
        $('c-status').textContent = 'Looking up…';
        try {
            const data = await (await fetch(`${state.settings.cloud.endpoint.replace(/\/$/, '')}/target-info?${new URLSearchParams({ name })}`)).json();
            const res = data.resolved || {};
            if (!data.ok || !Number.isFinite(res.raDeg)) throw new Error(data.error || 'not found');
            $('c-ra').value = A.formatRa(res.raDeg, 1);
            $('c-dec').value = A.formatDec(res.decDeg, 0);
            if (Number.isFinite(Number(res.angularSizeArcmin))) $('c-size').value = Number(res.angularSizeArcmin);
            if (Number.isFinite(Number(res.preferredMagnitude))) $('c-mag').value = Number(res.preferredMagnitude);
            $('c-status').textContent = `Resolved via ${res.source || 'SIMBAD'}.`;
        } catch (error) {
            $('c-status').textContent = `Lookup failed (${error.message}); enter coordinates manually.`;
        }
    }

    function addCustom() {
        const name = $('c-name').value.trim();
        const ra = A.parseRa($('c-ra').value);
        const dec = A.parseDec($('c-dec').value);
        if (!name || !Number.isFinite(ra) || !Number.isFinite(dec)) { $('c-status').textContent = 'Name, RA and Dec are required.'; return; }
        state.custom = state.custom.filter(c => c.id !== name);
        state.custom.push({ id: name, name: '', type: $('c-type').value, ra, dec, maj: Number($('c-size').value) || null, min: null, pa: null, mag: Number($('c-mag').value) || null, sb: null, const: '', ref: 'custom' });
        writeJson(CUSTOM_KEY, state.custom);
        $('c-status').textContent = `Added ${name}.`;
        state.search = name;
        $('search').value = name;
        recompute();
    }

    function cloudBundle() {
        const legacy = readJson('observingPlannerProfiles', []);
        return {
            format: 'nightvector-cloud-bundle-v2',
            savedAt: new Date().toISOString(),
            // The Worker requires a non-empty plannerProfiles array; keep the original profiles when present.
            plannerProfiles: Array.isArray(legacy) && legacy.length ? legacy : [{ id: 'nightvector-v2', name: 'NightVector', programs: [] }],
            settings: state.settings,
            dsoProjects: state.projects,
            dsoCustom: state.custom,
            variabilityPlans: readJson('nv.plan.v1', {}),
            variabilityQueue: readJson('nv.queue.v1', [])
        };
    }

    async function cloudSave() {
        const token = $('cloud-token').value.trim();
        if (!token) { $('cloud-status').textContent = 'Enter the upload token first.'; return; }
        $('cloud-status').textContent = 'Saving…';
        try {
            const response = await fetch(`${state.settings.cloud.endpoint.replace(/\/$/, '')}/planner-sync`, {
                method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ bundle: cloudBundle() })
            });
            const result = await response.json().catch(() => ({}));
            $('cloud-status').textContent = response.ok && result.ok ? `Saved ${new Date().toLocaleString()}.` : `Save failed: ${result.error || response.status}`;
        } catch {
            $('cloud-status').textContent = 'Could not reach the Worker.';
        }
    }

    async function cloudLoad() {
        const token = $('cloud-token').value.trim();
        if (!token) { $('cloud-status').textContent = 'Enter the upload token first.'; return; }
        $('cloud-status').textContent = 'Loading…';
        try {
            const response = await fetch(`${state.settings.cloud.endpoint.replace(/\/$/, '')}/planner-sync`, { headers: { authorization: `Bearer ${token}` } });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.ok) throw new Error(result.error || response.status);
            if (!result.exists) { $('cloud-status').textContent = 'No cloud backup yet.'; return; }
            const bundle = result.bundle || {};
            if (bundle.format === 'nightvector-cloud-bundle-v2') {
                if (bundle.settings) { state.settings = NV.load(); Object.assign(state.settings, bundle.settings); NV.save(state.settings); }
                if (Array.isArray(bundle.dsoProjects)) state.projects = bundle.dsoProjects;
                if (Array.isArray(bundle.dsoCustom)) state.custom = bundle.dsoCustom;
                if (bundle.variabilityPlans) writeJson('nv.plan.v1', bundle.variabilityPlans);
                if (Array.isArray(bundle.variabilityQueue)) writeJson('nv.queue.v1', bundle.variabilityQueue);
            } else if (Array.isArray(bundle.plannerProfiles)) {
                writeJson('observingPlannerProfiles', bundle.plannerProfiles);
                state.projects = null;
                migrateLegacy();
            }
            writeJson(PROJECT_KEY, state.projects);
            writeJson(CUSTOM_KEY, state.custom);
            $('cloud-status').textContent = `Loaded backup from ${result.updatedAt || 'the cloud'}.`;
            recompute();
        } catch (error) {
            $('cloud-status').textContent = `Load failed: ${error.message}`;
        }
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
        $('night-date').addEventListener('change', e => { if (e.target.value) setDate(e.target.value); });
        $('tabs').addEventListener('click', e => {
            const b = e.target.closest('[data-tab]');
            if (!b) return;
            state.tab = b.dataset.tab;
            state.limit = PAGE_SIZE;
            document.querySelectorAll('#tabs [data-tab]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
            renderList();
        });
        $('show-marginal').addEventListener('change', e => { state.showMarginal = e.target.checked; renderList(); });
        $('show-rejected').addEventListener('change', e => { state.showRejected = e.target.checked; renderList(); });
        $('sort').addEventListener('change', e => { state.sort = e.target.value; renderList(); });
        let timer;
        $('search').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => { state.search = e.target.value.trim(); state.limit = PAGE_SIZE; renderList(); }, 150); });
        $('show-more').addEventListener('click', () => { state.limit += PAGE_SIZE; renderList(); });
        $('target-rows').addEventListener('click', e => {
            const star = e.target.closest('[data-star]');
            if (star) { e.stopPropagation(); toggleProject(star.dataset.star); return; }
            const row = e.target.closest('tr[data-id]');
            const r = row && state.results.find(x => x.id === row.dataset.id);
            if (r) {
                renderDetail(r);
                if (window.matchMedia('(max-width: 1280px)').matches) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
        document.addEventListener('click', e => {
            const star = e.target.closest('#detail [data-star]');
            if (star) { toggleProject(star.dataset.star); return; }
            const open = e.target.closest('[data-goto-night]');
            if (open) { setDate(open.dataset.gotoNight); return; }
            const openProject = e.target.closest('[data-open-project]');
            if (openProject) {
                const p = state.projects.find(x => x.id === openProject.dataset.openProject);
                const r = p && (state.results.find(x => x.id === p.key) || state.results.find(x => x.o.id === p.name));
                if (r) renderDetail(r);
                else $('detail').innerHTML = `<div class="empty-state"><h3>${esc(p?.name || '')}</h3><p class="small">Not above your limits on this night.</p></div>`;
                return;
            }
            const remove = e.target.closest('[data-remove-project]');
            if (remove) {
                state.projects = state.projects.filter(p => p.id !== remove.dataset.removeProject);
                writeJson(PROJECT_KEY, state.projects);
                renderProjects();
                renderList();
            }
        });
        $('c-lookup').addEventListener('click', lookupCustom);
        $('c-add').addEventListener('click', addCustom);
        $('cloud-save').addEventListener('click', cloudSave);
        $('cloud-load').addEventListener('click', cloudLoad);
        window.NVSetup.mount({
            criteria: 'imaging',
            getSettings: () => state.settings,
            onSave(next, { siteChanged }) {
                state.settings = next;
                if (siteChanged) { state.date = A.nightDateNow(tz()); $('night-date').value = state.date; CTX.loadWeather(state.settings); }
                recompute();
            }
        });
        ['open-setup', 'ctx-site', 'ctx-rig'].forEach(id => $(id).addEventListener('click', () => window.NVSetup.open()));
    }

    async function init() {
        window.__nightVectorDso = state;
        bind();
        migrateLegacy();
        state.date = A.nightDateNow(tz());
        $('night-date').value = state.date;
        const requested = new URLSearchParams(location.search).get('mode');
        if (requested === 'eclipse' || requested === 'photometry') {
            // Old NightVector links: these modes now live in Variability Analysis.
            location.replace(`variability.html#${requested === 'eclipse' ? 'eclipse' : 'pulsator'}`);
            return;
        }
        try {
            await loadCatalog();
        } catch (error) {
            $('list-status').textContent = `Could not load the object catalog (${error.message}).`;
            return;
        }
        recompute();
        CTX.loadWeather(state.settings);
    }

    init();
})();
