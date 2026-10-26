/*
 * Night summary strip shared by the planners (site, dark window, Moon,
 * cloud forecast, rig) plus the hourly weather cache.
 */
(function (global) {
    'use strict';

    const A = global.Astro;
    const NV = global.NVSettings;
    const $ = id => document.getElementById(id);
    const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

    let weather = null;
    let weatherKey = '';
    let weatherFailed = false;
    let last = { settings: null, night: null };

    function render({ settings, night, darkLimit }) {
        last = { settings, night };
        const tz = settings.site.tz;
        const t = jd => (jd == null ? '—' : A.formatTime(A.msFromJd(jd), tz));
        const o = A.optics(settings.rig);
        $('ctx-site-name').textContent = settings.site.name.replace(/ \(default.*\)/, '');
        $('ctx-site-sub').textContent = `${fmt(settings.site.lat, 2)}°, ${fmt(settings.site.lon, 2)}° · Bortle ${settings.site.bortle} (${fmt(NV.skyMu(settings), 1)}) · ≥${settings.site.minAlt}°`;
        $('ctx-dark-label').textContent = `Dark window (Sun < ${darkLimit}°)`;
        const start = night.darkStart;
        const end = night.darkEnd;
        if (start !== null && end !== null && night.darkHours > 0) {
            $('ctx-dark').textContent = `${t(start)} – ${t(end)}`;
            $('ctx-dark-sub').textContent = `${A.formatDuration(night.darkHours)} · sunset ${t(night.sunset)} · sunrise ${t(night.sunrise)} ${A.tzAbbrev(tz, A.msFromJd(night.midnight))}`;
        } else {
            $('ctx-dark').textContent = 'None';
            $('ctx-dark-sub').textContent = 'Sun never reaches the darkness limit';
        }
        const m = night.moon;
        $('ctx-moon').textContent = `${Math.round(m.fraction * 100)}% ${m.waxing ? 'waxing' : 'waning'}`;
        const parts = [night.moonRise !== null ? `rises ${t(night.moonRise)}` : '', night.moonSet !== null ? `sets ${t(night.moonSet)}` : ''].filter(Boolean);
        $('ctx-moon-sub').textContent = parts.join(' · ') || (m.alt > 0 ? 'up all night' : 'down all night');
        $('ctx-rig-name').textContent = `${fmt(settings.rig.aperture / 25.4, 0)}" f/${fmt(o.fRatio, 1)} · ${settings.rig.filter}`;
        $('ctx-rig-sub').textContent = `${fmt(o.fovW, 0)}′×${fmt(o.fovH, 0)}′ · ${fmt(o.scale, 2)}″/px · RN ${settings.rig.readNoise} e⁻`;
        const notice = $('site-notice');
        if (settings.site.isDefault) {
            notice.classList.remove('hidden');
            notice.innerHTML = 'Using a default site (Tucson, AZ). Open <strong>Setup</strong> to set your location, sky brightness and horizon so the list matches where you observe.';
        } else {
            notice.classList.add('hidden');
        }
        renderWeather(settings, night);
    }

    async function loadWeather(settings) {
        const s = settings.site;
        const key = `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`;
        if (weatherKey === key && (weather || weatherFailed)) { renderWeather(); return; }
        weatherKey = key;
        weatherFailed = false;
        try {
            weather = await NV.weather(s);
        } catch {
            weather = null;
            weatherFailed = true;
        }
        renderWeather();
    }

    function renderWeather(settings = last.settings, night = last.night) {
        // The forecast may arrive before or after the night is computed; use whichever is newest.
        settings = settings || last.settings;
        night = night || last.night;
        const strip = $('ctx-cloud-strip');
        if (!night || !weather || !settings) {
            $('ctx-weather').textContent = weatherFailed ? 'Unavailable' : '—';
            strip.innerHTML = '';
            return;
        }
        const tz = settings.site.tz;
        const a = A.msFromJd(night.sunset ?? night.jd0);
        const b = A.msFromJd(night.sunrise ?? night.jd1);
        const hours = weather.filter(h => h.ms >= a - 1800000 && h.ms <= b + 1800000);
        if (!hours.length) {
            $('ctx-weather').textContent = 'Beyond forecast';
            strip.innerHTML = '';
            return;
        }
        const dA = A.msFromJd(night.darkStart ?? night.jd0);
        const dB = A.msFromJd(night.darkEnd ?? night.jd1);
        const dark = hours.filter(h => h.ms >= dA - 1800000 && h.ms <= dB + 1800000);
        const avg = dark.length ? dark.reduce((sum, h) => sum + (h.cloud || 0), 0) / dark.length : NaN;
        $('ctx-weather').textContent = Number.isFinite(avg) ? `${Math.round(avg)}% avg cloud` : '—';
        strip.innerHTML = hours.map(h => {
            const c = h.cloud ?? 0;
            const color = c < 25 ? 'var(--go)' : c < 60 ? 'var(--warn)' : 'var(--stop)';
            return `<span title="${A.formatTime(h.ms, tz)}: ${c}% cloud, ${h.rain ?? 0}% rain" style="height:${Math.max(18, 100 - c * 0.8)}%;background:${color}"></span>`;
        }).join('');
    }

    /** Hour labels (every 2 h) positioned over a night grid, for table timeline headers. */
    function axisLabels(grid, tz) {
        const span = grid.end - grid.start;
        const out = [];
        const firstHour = Math.ceil((grid.start - 2440587.5) * 24) / 24 + 2440587.5;
        for (let jd = firstHour; jd < grid.end; jd += 1 / 24) {
            const label = A.formatTime(A.msFromJd(jd), tz);
            const hour = Number(label.slice(0, 2));
            if (Number(label.slice(3, 5)) !== 0 || hour % 2 !== 0) continue;
            const pct = (jd - grid.start) / span * 100;
            if (pct < 6 || pct > 94) continue;
            out.push(`<span style="left:${pct}%">${String(hour).padStart(2, '0')}</span>`);
        }
        return out.join('');
    }

    /** Mini timeline bar: dark window, a highlighted window and a tick. */
    function timelineBar(grid, night, win, tick, color) {
        const span = grid.end - grid.start;
        const x = jd => A.clamp((jd - grid.start) / span * 100, 0, 100);
        const darkA = night.darkStart ?? grid.start;
        const darkB = night.darkEnd ?? grid.end;
        const now = A.jdFromMs(Date.now());
        const nowMark = now > grid.start && now < grid.end ? `<span class="now" style="left:${x(now)}%"></span>` : '';
        return `<div class="tl-bar"><span class="dark" style="left:${x(darkA)}%;width:${x(darkB) - x(darkA)}%"></span>`
            + `<span class="win" style="left:${x(win[0])}%;width:${Math.max(1.2, x(win[1]) - x(win[0]))}%;background:${color}"></span>`
            + (tick ? `<span class="mid" style="left:${x(tick)}%"></span>` : '') + `${nowMark}</div>`;
    }

    global.NVContext = { render, loadWeather, renderWeather, axisLabels, timelineBar };
})(window);
