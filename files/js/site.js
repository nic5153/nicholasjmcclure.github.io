/*
 * Shared page chrome: header navigation, footer, and the starfield background.
 * Each page sets <body data-page="..."> so the current link is highlighted.
 */
(function () {
    'use strict';

    const NAV = [
        { id: 'home', href: 'index.html', label: 'Home' },
        {
            id: 'observing', label: 'Observing', children: [
                { id: 'variability', href: 'variability.html', label: 'Variability Analysis', note: "Tonight's time-series targets your rig can capture" },
                { id: 'dso', href: 'observing.html', label: 'Deep-Sky Planner', note: 'Framing, visibility and exposure plans' },
                { id: 'vault', href: 'vault.html', label: 'Data Vault', note: 'Upload and browse observing sessions' }
            ]
        },
        { id: 'astrophotography', href: 'astrophotography.html', label: 'Astrophotography' },
        { id: 'outreach', href: 'outreach.html', label: 'Outreach' },
        { id: 'poster', href: 'poster.html', label: 'Poster' },
        { id: 'cv', href: 'cv.html', label: 'CV' }
    ];

    const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="5.2" fill="#8fd3ff"/><ellipse cx="16" cy="16" rx="13" ry="5.6" fill="none" stroke="#b7a6ff" stroke-width="1.4" transform="rotate(-28 16 16)"/><circle cx="26.4" cy="9.6" r="1.8" fill="#e7ecf6"/></svg>';
    const CHEV = '<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

    const page = document.body.dataset.page || '';

    function renderHeader() {
        const header = document.createElement('header');
        header.className = 'site-header';
        const links = NAV.map(item => {
            if (item.children) {
                const active = item.children.some(child => child.id === page);
                const menu = item.children.map(child => `<a href="${child.href}"${child.id === page ? ' aria-current="page"' : ''}>${child.label}<span>${child.note}</span></a>`).join('');
                return `<li class="has-menu"><button type="button" aria-expanded="false" aria-haspopup="true" class="${active ? 'is-active' : ''}">${item.label}${CHEV}</button><div class="dropdown" role="menu">${menu}</div></li>`;
            }
            return `<li><a href="${item.href}"${item.id === page ? ' aria-current="page"' : ''}>${item.label}</a></li>`;
        }).join('');
        const mobile = NAV.map(item => item.children
            ? `<p class="eyebrow group-label">${item.label}</p>${item.children.map(child => `<a href="${child.href}"${child.id === page ? ' aria-current="page"' : ''}>${child.label}</a>`).join('')}`
            : `<a href="${item.href}"${item.id === page ? ' aria-current="page"' : ''}>${item.label}</a>`).join('');
        header.innerHTML = `
            <div class="container-wide bar">
                <a class="brand" href="index.html">${LOGO}<span>Nicholas J. McClure<small>Astrophysics &middot; Time-domain astronomy</small></span></a>
                <nav aria-label="Primary"><ul class="nav-links">${links}</ul></nav>
                <button class="menu-toggle" type="button" aria-label="Open menu" aria-expanded="false">
                    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
                </button>
            </div>
            <div class="mobile-panel">${mobile}</div>`;
        document.body.prepend(header);

        const canHover = () => window.matchMedia('(hover: hover)').matches;
        header.querySelectorAll('.has-menu').forEach(item => {
            const button = item.querySelector('button');
            let closeTimer = null;
            const open = state => {
                clearTimeout(closeTimer);
                item.classList.toggle('open', state);
                button.setAttribute('aria-expanded', String(state));
            };
            button.addEventListener('click', event => {
                event.stopPropagation();
                // With a mouse the menu is already open from hovering; a click on the label should not
                // close it. Keyboard activation (event.detail === 0) still toggles.
                if (canHover() && event.detail > 0 && item.classList.contains('open')) return;
                open(!item.classList.contains('open'));
            });
            item.addEventListener('mouseenter', () => { if (canHover()) open(true); });
            item.addEventListener('mouseleave', () => {
                if (!canHover()) return;
                clearTimeout(closeTimer);
                closeTimer = setTimeout(() => open(false), 300); // grace period for diagonal mouse paths
            });
            item.addEventListener('keydown', event => { if (event.key === 'Escape') { open(false); button.focus(); } });
        });
        document.addEventListener('click', () => header.querySelectorAll('.has-menu.open').forEach(item => {
            item.classList.remove('open');
            item.querySelector('button').setAttribute('aria-expanded', 'false');
        }));
        const toggle = header.querySelector('.menu-toggle');
        toggle.addEventListener('click', () => {
            const isOpen = header.classList.toggle('menu-open');
            toggle.setAttribute('aria-expanded', String(isOpen));
        });
    }

    function renderFooter() {
        const footer = document.createElement('footer');
        footer.className = 'site-footer';
        footer.innerHTML = `
            <div class="container-wide bar">
                <span>&copy; ${new Date().getFullYear()} Nicholas J. McClure</span>
                <div class="footer-links">
                    <a href="mailto:nic5153mcclure@gmail.com">Email</a>
                    <a href="https://github.com/nic5153" target="_blank" rel="noopener">GitHub</a>
                    <a href="https://orcid.org/0009-0000-9626-2192" target="_blank" rel="noopener">ORCID</a>
                    <a href="http://www.linkedin.com/in/nicholas-mcclure-3a463524a" target="_blank" rel="noopener">LinkedIn</a>
                </div>
            </div>`;
        document.body.appendChild(footer);
    }

    function starfield() {
        if (document.body.dataset.starfield === 'off') return;
        const canvas = document.createElement('canvas');
        canvas.id = 'starfield';
        canvas.setAttribute('aria-hidden', 'true');
        document.body.prepend(canvas);
        const ctx = canvas.getContext('2d');
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.dataset.starfield === 'static';
        let stars = [];
        let width = 0;
        let height = 0;
        let seed = 7;
        const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

        function build() {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            width = window.innerWidth;
            height = window.innerHeight;
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            seed = 7;
            const count = Math.round(width * height / 5200);
            stars = Array.from({ length: count }, () => {
                const tint = random();
                return {
                    x: random() * width,
                    y: random() * height,
                    r: Math.pow(random(), 3) * 1.25 + 0.25,
                    a: 0.25 + random() * 0.6,
                    color: tint > 0.88 ? '255,226,190' : tint > 0.7 ? '190,214,255' : '235,240,255',
                    phase: random() * Math.PI * 2,
                    speed: 0.25 + random() * 0.9,
                    twinkle: random() > 0.82
                };
            });
        }

        function draw(time) {
            ctx.clearRect(0, 0, width, height);
            const t = time / 1000;
            for (const star of stars) {
                const alpha = star.twinkle && !reduce ? star.a * (0.65 + 0.35 * Math.sin(t * star.speed + star.phase)) : star.a;
                ctx.beginPath();
                ctx.fillStyle = `rgba(${star.color},${alpha.toFixed(3)})`;
                ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        let last = 0;
        function loop(time) {
            if (document.hidden) { requestAnimationFrame(loop); return; }
            if (time - last > 66) { draw(time); last = time; }
            requestAnimationFrame(loop);
        }

        build();
        draw(0);
        window.addEventListener('resize', () => { build(); draw(performance.now()); });
        if (!reduce) requestAnimationFrame(loop);
    }

    // Loaded as the first element of <body>: draw the header immediately (no layout jump) and add the
    // footer once the rest of the page has been parsed.
    starfield();
    renderHeader();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderFooter);
    } else {
        renderFooter();
    }
})();
