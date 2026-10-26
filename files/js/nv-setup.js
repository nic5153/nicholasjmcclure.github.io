/*
 * Shared "Setup" dialog for the NightVector planners: observing site, telescope
 * and camera, plus page-specific criteria (photometry or imaging).
 *   NVSetup.mount({ criteria: 'photometry' | 'imaging', onSave(settings, { siteChanged }) })
 *   NVSetup.open()
 */
(function (global) {
    'use strict';

    const NV = global.NVSettings;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const $ = id => document.getElementById(id);

    const SITE_HTML = `
        <fieldset>
            <legend>Observing site</legend>
            <div class="row" style="margin-bottom: 12px;">
                <input class="input grow" id="site-search" placeholder="Search a place, e.g. Tucson" style="flex: 1 1 220px;">
                <button class="btn btn-sm" id="site-search-btn" type="button">Search</button>
                <button class="btn btn-sm" id="site-gps" type="button">Use my location</button>
            </div>
            <div id="site-results" class="stack" style="margin-bottom: 12px;"></div>
            <div class="form-grid">
                <label class="field" style="grid-column: span 2;"><span>Name</span><input class="input" id="f-site-name"></label>
                <label class="field"><span>Latitude (&deg;)</span><input class="input mono" id="f-lat" type="number" step="any" min="-90" max="90"></label>
                <label class="field"><span>Longitude (&deg;, east +)</span><input class="input mono" id="f-lon" type="number" step="any" min="-180" max="180"></label>
                <label class="field"><span>Elevation (m)</span><input class="input mono" id="f-elev" type="number" step="1"></label>
                <label class="field"><span>Time zone</span><input class="input mono" id="f-tz" placeholder="America/Phoenix"></label>
                <label class="field"><span>Sky (Bortle)</span>
                    <select class="input" id="f-bortle">
                        <option value="1">1 &middot; excellent dark site</option><option value="2">2 &middot; truly dark</option><option value="3">3 &middot; rural</option>
                        <option value="4">4 &middot; rural / suburban</option><option value="5">5 &middot; suburban</option><option value="6">6 &middot; bright suburban</option>
                        <option value="7">7 &middot; suburban / urban</option><option value="8">8 &middot; city</option><option value="9">9 &middot; inner city</option>
                    </select>
                </label>
                <label class="field"><span>SQM override</span><input class="input mono" id="f-sqm" type="number" step="0.1" placeholder="e.g. 19.8"><small>mag/arcsec&sup2;, blank = from Bortle</small></label>
                <label class="field"><span>Minimum altitude (&deg;)</span><input class="input mono" id="f-minalt" type="number" step="1" min="5" max="80"></label>
                <label class="field"><span>Photometry: Sun below</span>
                    <select class="input" id="f-dark">
                        <option value="-12">&minus;12&deg; (nautical)</option><option value="-15">&minus;15&deg;</option><option value="-18">&minus;18&deg; (astronomical)</option>
                    </select>
                </label>
                <label class="field" style="grid-column: 1 / -1;"><span>Horizon mask (optional)</span><input class="input mono" id="f-horizon" placeholder="az:alt pairs, e.g. 0:20, 90:35, 180:25, 270:40"><small>Minimum altitude by azimuth (N=0, E=90), interpolated. The larger of this and the minimum altitude applies.</small></label>
            </div>
        </fieldset>`;

    const RIG_HTML = `
        <fieldset>
            <legend>Telescope &amp; camera</legend>
            <div class="form-grid">
                <label class="field" style="grid-column: span 2;"><span>Preset</span>
                    <select class="input" id="f-preset">
                        <option value="c8-reduced-atr585m">C8 + 0.63x reducer + ATR585M</option>
                        <option value="c8-native-atr585m">C8 native f/10 + ATR585M</option>
                        <option value="custom">Custom</option>
                    </select>
                </label>
                <label class="field"><span>Aperture (mm)</span><input class="input mono" id="f-aperture" type="number" step="0.1"></label>
                <label class="field"><span>Central obstruction</span><input class="input mono" id="f-obstruction" type="number" step="0.01" min="0" max="0.6"><small>fraction of diameter</small></label>
                <label class="field"><span>Focal length (mm)</span><input class="input mono" id="f-focal" type="number" step="1"></label>
                <label class="field"><span>Reducer</span><input class="input mono" id="f-reducer" type="number" step="0.01"></label>
                <label class="field"><span>Pixel size (&micro;m)</span><input class="input mono" id="f-pixel" type="number" step="0.01"></label>
                <label class="field"><span>Sensor width (px)</span><input class="input mono" id="f-sw" type="number" step="1"></label>
                <label class="field"><span>Sensor height (px)</span><input class="input mono" id="f-sh" type="number" step="1"></label>
                <label class="field"><span>Read noise (e&minus;)</span><input class="input mono" id="f-rn" type="number" step="0.01"></label>
                <label class="field"><span>Full well (e&minus;)</span><input class="input mono" id="f-fw" type="number" step="100"></label>
                <label class="field"><span>System throughput</span><input class="input mono" id="f-tau" type="number" step="0.01" min="0.05" max="1"><small>QE &times; optics &times; filter</small></label>
                <label class="field"><span>Photometry filter</span>
                    <select class="input" id="f-filter">
                        <option value="L">L (luminance)</option><option value="CLEAR">No filter</option><option value="V">V</option>
                        <option value="G">G</option><option value="R">R</option><option value="B">B</option>
                    </select>
                </label>
                <label class="field"><span>Gain / offset</span><input class="input mono" id="f-gain" placeholder="100 / 30"></label>
                <label class="field"><span>Typical seeing (")</span><input class="input mono" id="f-seeing" type="number" step="0.1"></label>
                <label class="field"><span>Max defocus FWHM (")</span><input class="input mono" id="f-defocus" type="number" step="1"></label>
                <label class="field"><span>Overhead per frame (s)</span><input class="input mono" id="f-overhead" type="number" step="0.5"><small>download + software</small></label>
                <label class="field"><span>Shortest exposure (s)</span><input class="input mono" id="f-minexp" type="number" step="0.1"></label>
            </div>
        </fieldset>`;

    const PHOTOMETRY_HTML = `
        <fieldset>
            <legend>Photometry criteria</legend>
            <div class="form-grid">
                <label class="field"><span>Transit baseline (min each side)</span><input class="input mono" id="f-baseline" type="number" step="5" min="0"></label>
                <label class="field"><span>Go if S/N &ge;</span><input class="input mono" id="f-go" type="number" step="1"></label>
                <label class="field"><span>Marginal if S/N &ge;</span><input class="input mono" id="f-marginal" type="number" step="1"></label>
                <label class="field"><span>Systematics floor (ppt)</span><input class="input mono" id="f-red" type="number" step="0.1"><small>correlated noise per bin</small></label>
            </div>
        </fieldset>`;

    const IMAGING_HTML = `
        <fieldset>
            <legend>Imaging criteria</legend>
            <div class="form-grid">
                <label class="field"><span>Imaging: Sun below</span>
                    <select class="input" id="f-img-dark">
                        <option value="-12">&minus;12&deg; (nautical)</option><option value="-15">&minus;15&deg;</option><option value="-18">&minus;18&deg; (astronomical)</option>
                    </select>
                </label>
                <label class="field"><span>Minimum time on target (h)</span><input class="input mono" id="f-img-hours" type="number" step="0.25" min="0.25"></label>
                <label class="field"><span>Longest sub-exposure (s)</span><input class="input mono" id="f-img-maxsub" type="number" step="10"><small>limited by guiding / tracking</small></label>
                <label class="field"><span>Read-noise swamp factor</span><input class="input mono" id="f-img-swamp" type="number" step="1"><small>sky &ge; factor &times; RN&sup2; per sub</small></label>
                <label class="field"><span>Imaging read noise (e&minus;)</span><input class="input mono" id="f-img-rn" type="number" step="0.01"><small>e.g. HCG mode</small></label>
                <label class="field"><span>Max integration worth planning (h)</span><input class="input mono" id="f-img-maxint" type="number" step="1"></label>
            </div>
        </fieldset>`;

    const FIELDS = {
        'f-site-name': ['site', 'name', String], 'f-lat': ['site', 'lat', Number], 'f-lon': ['site', 'lon', Number],
        'f-elev': ['site', 'elevation', Number], 'f-tz': ['site', 'tz', String], 'f-bortle': ['site', 'bortle', Number],
        'f-sqm': ['site', 'sqm', v => (v === '' ? null : Number(v))], 'f-minalt': ['site', 'minAlt', Number],
        'f-dark': ['site', 'darkLimit', Number], 'f-horizon': ['site', 'horizon', String],
        'f-preset': ['rig', 'preset', String], 'f-aperture': ['rig', 'aperture', Number], 'f-obstruction': ['rig', 'obstruction', Number],
        'f-focal': ['rig', 'focalLength', Number], 'f-reducer': ['rig', 'reducer', Number], 'f-pixel': ['rig', 'pixelSize', Number],
        'f-sw': ['rig', 'sensorW', Number], 'f-sh': ['rig', 'sensorH', Number], 'f-rn': ['rig', 'readNoise', Number],
        'f-fw': ['rig', 'fullWell', Number], 'f-tau': ['rig', 'throughput', Number], 'f-filter': ['rig', 'filter', String],
        'f-seeing': ['rig', 'seeing', Number], 'f-defocus': ['rig', 'maxDefocus', Number], 'f-overhead': ['rig', 'overhead', Number],
        'f-minexp': ['rig', 'minExposure', Number],
        'f-baseline': ['criteria', 'baseline', Number], 'f-go': ['criteria', 'goSnr', Number], 'f-marginal': ['criteria', 'marginalSnr', Number],
        'f-img-dark': ['imaging', 'darkLimit', Number], 'f-img-hours': ['imaging', 'minHours', Number], 'f-img-maxsub': ['imaging', 'maxSub', Number],
        'f-img-swamp': ['imaging', 'swamp', Number], 'f-img-rn': ['imaging', 'readNoise', Number], 'f-img-maxint': ['imaging', 'maxIntegration', Number]
    };

    let options = { criteria: 'photometry', onSave: () => {} };
    let getSettings = () => NV.load();

    function present(id) { return Boolean($(id)); }

    function fill(settings) {
        for (const [id, [section, key]] of Object.entries(FIELDS)) {
            if (!present(id)) continue;
            const value = settings[section]?.[key];
            $(id).value = value ?? '';
        }
        $('f-gain').value = `${settings.rig.gain} / ${settings.rig.offset}`;
        if (present('f-red')) $('f-red').value = ((settings.rig.redNoise || 0) * 1000).toFixed(2);
        $('site-results').innerHTML = '';
    }

    function read(current) {
        const next = JSON.parse(JSON.stringify(current));
        for (const [id, [section, key, cast]] of Object.entries(FIELDS)) {
            if (!present(id)) continue;
            const value = cast($(id).value.trim());
            if (cast === Number && !Number.isFinite(value)) continue;
            next[section] = next[section] || {};
            next[section][key] = value;
        }
        const [gain, offset] = $('f-gain').value.split('/').map(v => v.trim());
        if (gain) next.rig.gain = Number(gain) || gain;
        if (offset) next.rig.offset = Number(offset) || offset;
        if (present('f-red')) {
            const red = Number($('f-red').value);
            if (Number.isFinite(red)) next.rig.redNoise = red / 1000;
        }
        try { new Intl.DateTimeFormat('en-US', { timeZone: next.site.tz }); } catch { next.site.tz = current.site.tz; }
        if (Math.abs(next.site.lat) > 90) next.site.lat = current.site.lat;
        if (Math.abs(next.site.lon) > 180) next.site.lon = current.site.lon;
        next.site.minAlt = Math.min(85, Math.max(0, next.site.minAlt));
        if (next.site.lat !== current.site.lat || next.site.lon !== current.site.lon || next.site.name !== current.site.name) next.site.isDefault = false;
        return next;
    }

    function applyPreset(key) {
        const preset = NV.RIG_PRESETS[key];
        if (!preset) return;
        $('f-aperture').value = preset.aperture; $('f-obstruction').value = preset.obstruction; $('f-focal').value = preset.focalLength;
        $('f-reducer').value = preset.reducer; $('f-pixel').value = preset.pixelSize; $('f-sw').value = preset.sensorW; $('f-sh').value = preset.sensorH;
        $('f-rn').value = preset.readNoise; $('f-fw').value = preset.fullWell; $('f-tau').value = preset.throughput;
    }

    function setSiteFields(place) {
        $('f-site-name').value = place.name;
        $('f-lat').value = Number(place.lat).toFixed(5);
        $('f-lon').value = Number(place.lon).toFixed(5);
        if (Number.isFinite(place.elevation)) $('f-elev').value = Math.round(place.elevation);
        if (place.tz) $('f-tz').value = place.tz;
    }

    async function siteSearch() {
        const q = $('site-search').value.trim();
        if (!q) return;
        const box = $('site-results');
        box.innerHTML = '<p class="small muted"><span class="spinner"></span> Searching&hellip;</p>';
        try {
            const places = await NV.geocode(q);
            box.innerHTML = places.length
                ? places.map((p, i) => `<button type="button" class="btn btn-sm" data-place="${i}" style="justify-content:flex-start;width:100%;">${esc(p.name)} <span class="dim">${p.lat.toFixed(3)}, ${p.lon.toFixed(3)} &middot; ${esc(p.tz)}</span></button>`).join('')
                : '<p class="small muted">No places found.</p>';
            box.querySelectorAll('[data-place]').forEach(btn => btn.addEventListener('click', () => { setSiteFields(places[Number(btn.dataset.place)]); box.innerHTML = ''; }));
        } catch {
            box.innerHTML = '<p class="small muted">Place search is unavailable right now; enter coordinates manually.</p>';
        }
    }

    function useGps() {
        const box = $('site-results');
        if (!navigator.geolocation) { box.innerHTML = '<p class="small muted">Location is not available in this browser.</p>'; return; }
        box.innerHTML = '<p class="small muted"><span class="spinner"></span> Waiting for location permission&hellip;</p>';
        navigator.geolocation.getCurrentPosition(async pos => {
            const lat = pos.coords.latitude;
            const lon = pos.coords.longitude;
            let extra = {};
            try { extra = await NV.lookupPoint(lat, lon); } catch { /* keep manual time zone */ }
            setSiteFields({ name: 'My location', lat, lon, elevation: extra.elevation ?? pos.coords.altitude, tz: extra.tz });
            box.innerHTML = '';
        }, () => { box.innerHTML = '<p class="small muted">Location permission denied.</p>'; }, { enableHighAccuracy: false, timeout: 15000 });
    }

    function mount(opts) {
        options = { ...options, ...opts };
        getSettings = opts.getSettings || getSettings;
        const dialog = document.createElement('dialog');
        dialog.className = 'sheet';
        dialog.id = 'setup';
        dialog.innerHTML = `
            <form method="dialog" id="setup-form" novalidate>
                <div class="sheet-head">
                    <h2 style="font-size: 1.1rem;">Setup</h2>
                    <button class="btn btn-ghost btn-sm" value="cancel" type="submit">Close</button>
                </div>
                <div class="sheet-body">
                    ${SITE_HTML}${RIG_HTML}${options.criteria === 'imaging' ? IMAGING_HTML : PHOTOMETRY_HTML}
                    <p class="xsmall dim">Settings are stored in this browser and shared by the Variability and Deep-Sky planners.</p>
                </div>
                <div class="sheet-foot">
                    <button class="btn btn-ghost" id="setup-reset" type="button">Reset to defaults</button>
                    <button class="btn btn-primary" type="submit" value="save">Save &amp; recompute</button>
                </div>
            </form>`;
        document.body.appendChild(dialog);
        $('f-preset').addEventListener('change', event => applyPreset(event.target.value));
        $('site-search-btn').addEventListener('click', siteSearch);
        $('site-search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); siteSearch(); } });
        $('site-gps').addEventListener('click', useGps);
        $('setup-reset').addEventListener('click', () => fill(NV.defaults()));
        $('setup-form').addEventListener('submit', event => {
            if (!event.submitter || event.submitter.value !== 'save') return;
            const current = getSettings();
            const next = read(current);
            const siteChanged = JSON.stringify(current.site) !== JSON.stringify(next.site);
            NV.save(next);
            options.onSave(next, { siteChanged });
        });
    }

    function open() {
        fill(getSettings());
        $('setup').showModal();
    }

    global.NVSetup = { mount, open };
})(window);
