(function () {
    'use strict';

    /* ---------------------------------------------------------------------
       CONSTANTS & STATE
    --------------------------------------------------------------------- */

    const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
    const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';

    const state = {
        unit: 'celsius', // 'celsius' | 'fahrenheit'
        lastQuery: null, // { type: 'city', name } | { type: 'coords', lat, lon, label }
        lastData: null,
        retryCount: 0,
    };

    // WMO weather interpretation codes -> { label, icon, group }
    // group is used to choose the sky scene (clear / cloudy / rain / snow / storm / fog)
    const WMO = {
        0: { label: 'Clear sky', icon: 'sun', group: 'clear' },
        1: { label: 'Mainly clear', icon: 'sun', group: 'clear' },
        2: { label: 'Partly cloudy', icon: 'cloud-sun', group: 'cloudy' },
        3: { label: 'Overcast', icon: 'cloud', group: 'cloudy' },
        45: { label: 'Fog', icon: 'cloud-fog', group: 'fog' },
        48: { label: 'Depositing rime fog', icon: 'cloud-fog', group: 'fog' },
        51: { label: 'Light drizzle', icon: 'cloud-drizzle', group: 'rain' },
        53: { label: 'Moderate drizzle', icon: 'cloud-drizzle', group: 'rain' },
        55: { label: 'Dense drizzle', icon: 'cloud-drizzle', group: 'rain' },
        56: { label: 'Light freezing drizzle', icon: 'cloud-drizzle', group: 'rain' },
        57: { label: 'Dense freezing drizzle', icon: 'cloud-drizzle', group: 'rain' },
        61: { label: 'Slight rain', icon: 'cloud-rain', group: 'rain' },
        63: { label: 'Moderate rain', icon: 'cloud-rain', group: 'rain' },
        65: { label: 'Heavy rain', icon: 'cloud-rain-wind', group: 'rain' },
        66: { label: 'Light freezing rain', icon: 'cloud-rain', group: 'rain' },
        67: { label: 'Heavy freezing rain', icon: 'cloud-rain-wind', group: 'rain' },
        71: { label: 'Slight snow', icon: 'cloud-snow', group: 'snow' },
        73: { label: 'Moderate snow', icon: 'cloud-snow', group: 'snow' },
        75: { label: 'Heavy snow', icon: 'cloud-snow', group: 'snow' },
        77: { label: 'Snow grains', icon: 'cloud-snow', group: 'snow' },
        80: { label: 'Slight rain showers', icon: 'cloud-rain', group: 'rain' },
        81: { label: 'Moderate rain showers', icon: 'cloud-rain', group: 'rain' },
        82: { label: 'Violent rain showers', icon: 'cloud-rain-wind', group: 'rain' },
        85: { label: 'Slight snow showers', icon: 'cloud-snow', group: 'snow' },
        86: { label: 'Heavy snow showers', icon: 'cloud-snow', group: 'snow' },
        95: { label: 'Thunderstorm', icon: 'cloud-lightning', group: 'storm' },
        96: { label: 'Thunderstorm, slight hail', icon: 'cloud-lightning', group: 'storm' },
        99: { label: 'Thunderstorm, heavy hail', icon: 'cloud-lightning', group: 'storm' },
    };

    function wmoInfo(code) {
        return WMO[code] || { label: 'Unknown', icon: 'cloud', group: 'cloudy' };
    }

    /* ---------------------------------------------------------------------
       DOM REFERENCES
    --------------------------------------------------------------------- */

    const els = {
        searchForm: document.getElementById('search-form'),
        cityInput: document.getElementById('city-input'),
        locateBtn: document.getElementById('locate-btn'),
        unitC: document.getElementById('unit-c'),
        unitF: document.getElementById('unit-f'),
        clockTime: document.getElementById('clock-time'),

        emptyState: document.getElementById('empty-state'),
        loadingState: document.getElementById('loading-state'),
        errorState: document.getElementById('error-state'),
        errorTitle: document.getElementById('error-title'),
        errorCopy: document.getElementById('error-copy'),
        retryBtn: document.getElementById('retry-btn'),
        dashboard: document.getElementById('dashboard'),

        cityName: document.getElementById('city-name'),
        countryName: document.getElementById('country-name'),
        heroTemp: document.getElementById('hero-temp'),
        heroUnit: document.getElementById('hero-unit'),
        heroIcon: document.getElementById('hero-icon'),
        heroCondition: document.getElementById('hero-condition'),
        heroFeelslike: document.getElementById('hero-feelslike'),
        heroDate: document.getElementById('hero-date'),
        heroDaynight: document.getElementById('hero-daynight'),

        statHumidity: document.getElementById('stat-humidity'),
        statWind: document.getElementById('stat-wind'),
        statPressure: document.getElementById('stat-pressure'),
        statVisibility: document.getElementById('stat-visibility'),

        hourlyScroll: document.getElementById('hourly-scroll'),
        dailyGrid: document.getElementById('daily-grid'),

        instSunrise: document.getElementById('inst-sunrise'),
        instSunset: document.getElementById('inst-sunset'),
        instWinddir: document.getElementById('inst-winddir'),
        instDewpoint: document.getElementById('inst-dewpoint'),
        instCloudcover: document.getElementById('inst-cloudcover'),
        instUv: document.getElementById('inst-uv'),

        footerCoords: document.getElementById('footer-coords'),

        skyScene: document.getElementById('sky-scene'),
        celestialBody: document.getElementById('celestial-body'),
        stars: document.getElementById('stars'),
        cloudsLayer: document.getElementById('clouds-layer'),
        rainLayer: document.getElementById('rain-layer'),
        snowLayer: document.getElementById('snow-layer'),
        lightningFlash: document.getElementById('lightning-flash'),
        particles: document.getElementById('particles'),
    };

    /* ---------------------------------------------------------------------
       LENIS SMOOTH SCROLL
    --------------------------------------------------------------------- */

    let lenis;
    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouchDevice) {
        // Lenis's synthetic scroll smoothing fights native touch/momentum scrolling
        // on mobile and has caused visual tearing/ghosting on some Android Chrome
        // builds. Desktop (fine pointer) keeps the smooth-scroll feel; touch devices
        // fall back to native scrolling, which is also more accessible/expected there.
        try {
            lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
            function raf(time) {
                lenis.raf(time);
                requestAnimationFrame(raf);
            }
            requestAnimationFrame(raf);
        } catch (e) {
            // Lenis unavailable — native scroll still works fine.
        }
    }

    /* ---------------------------------------------------------------------
       ICONS
    --------------------------------------------------------------------- */

    function refreshIcons() {
        if (window.lucide) window.lucide.createIcons();
    }
    refreshIcons();

    /* ---------------------------------------------------------------------
       CLOCK
    --------------------------------------------------------------------- */

    let clockTimezoneOffsetSeconds = null; // offset from UTC, from API, for the searched city

    function tickClock() {
        let d;
        if (clockTimezoneOffsetSeconds !== null) {
            const utcMs = Date.now();
            d = new Date(utcMs + clockTimezoneOffsetSeconds * 1000);
            els.clockTime.textContent = d.toISOString().slice(11, 16);
        } else {
            d = new Date();
            els.clockTime.textContent = d.toTimeString().slice(0, 5);
        }
    }
    tickClock();
    setInterval(tickClock, 1000 * 15);

    /* ---------------------------------------------------------------------
       UNIT TOGGLE
    --------------------------------------------------------------------- */

    els.unitC.addEventListener('click', () => setUnit('celsius'));
    els.unitF.addEventListener('click', () => setUnit('fahrenheit'));

    function setUnit(unit) {
        if (state.unit === unit) return;
        state.unit = unit;
        els.unitC.classList.toggle('is-active', unit === 'celsius');
        els.unitC.setAttribute('aria-pressed', String(unit === 'celsius'));
        els.unitF.classList.toggle('is-active', unit === 'fahrenheit');
        els.unitF.setAttribute('aria-pressed', String(unit === 'fahrenheit'));
        if (state.lastData) renderWeather(state.lastData, { animateTemp: true });
    }

    function convertTemp(celsius) {
        return state.unit === 'fahrenheit' ? (celsius * 9) / 5 + 32 : celsius;
    }
    function unitSymbol() {
        return state.unit === 'fahrenheit' ? '°F' : '°C';
    }
    function fmtTemp(celsius) {
        return Math.round(convertTemp(celsius));
    }

    /* ---------------------------------------------------------------------
       SEARCH & GEOLOCATION
    --------------------------------------------------------------------- */

    els.searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const query = els.cityInput.value.trim();
        if (!query) return;
        searchCity(query);
    });

    document.getElementById('empty-suggestions').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-city]');
        if (!btn) return;
        els.cityInput.value = btn.dataset.city;
        searchCity(btn.dataset.city);
    });

    els.locateBtn.addEventListener('click', () => {
        if (!navigator.geolocation) {
            showError('Location unavailable', 'Your browser does not support geolocation. Try searching by city name instead.');
            return;
        }
        els.locateBtn.classList.add('is-loading');
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                els.locateBtn.classList.remove('is-loading');
                loadWeatherByCoords(pos.coords.latitude, pos.coords.longitude, 'Your location');
            },
            () => {
                els.locateBtn.classList.remove('is-loading');
                showError('Couldn\'t get your location', 'Location access was blocked or unavailable. Try searching for a city instead.');
            },
            { timeout: 10000 }
        );
    });

    els.retryBtn.addEventListener('click', () => {
        if (!state.lastQuery) return;
        if (state.lastQuery.type === 'city') {
            searchCity(state.lastQuery.name);
        } else {
            loadWeatherByCoords(state.lastQuery.lat, state.lastQuery.lon, state.lastQuery.label);
        }
    });

    async function searchCity(name) {
        state.lastQuery = { type: 'city', name };
        showLoading();
        try {
            const geoRes = await fetchWithRetry(
                `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`
            );
            const geoData = await geoRes.json();
            if (!geoData.results || geoData.results.length === 0) {
                showError('We couldn\'t find that place.', `No results for "${name}". Check the spelling, or try a nearby larger city.`);
                return;
            }
            const place = geoData.results[0];
            await loadWeatherByCoords(
                place.latitude,
                place.longitude,
                place.name,
                place.country,
                place.admin1
            );
        } catch (err) {
            showError('We couldn\'t read the sky there.', 'Something went wrong reaching the weather service. Check your connection and try again.');
        }
    }

    async function loadWeatherByCoords(lat, lon, label, country, admin1) {
        state.lastQuery = { type: 'coords', lat, lon, label };
        showLoading();
        try {
            const params = new URLSearchParams({
                latitude: lat,
                longitude: lon,
                current: [
                    'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
                    'weather_code', 'wind_speed_10m', 'wind_direction_10m',
                    'surface_pressure', 'visibility', 'is_day', 'cloud_cover', 'dew_point_2m'
                ].join(','),
                hourly: ['temperature_2m', 'weather_code', 'is_day'].join(','),
                daily: [
                    'weather_code', 'temperature_2m_max', 'temperature_2m_min',
                    'sunrise', 'sunset', 'uv_index_max'
                ].join(','),
                timezone: 'auto',
                forecast_days: 6,
            });

            const res = await fetchWithRetry(`${WEATHER_URL}?${params.toString()}`);
            const data = await res.json();
            if (!res.ok || data.error) {
                throw new Error(data.reason || 'Weather service error');
            }

            data._meta = { label, country, admin1, lat, lon };
            state.lastData = data;
            state.retryCount = 0;
            renderWeather(data, { animateTemp: false, isFreshLoad: true });
        } catch (err) {
            showError('We couldn\'t read the sky there.', 'Something went wrong reaching the weather service. Check your connection and try again.');
        }
    }

    async function fetchWithRetry(url, attempts = 2) {
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error('Network response was not ok');
                return res;
            } catch (err) {
                lastErr = err;
                await new Promise((r) => setTimeout(r, 500 * (i + 1)));
            }
        }
        throw lastErr;
    }

    /* ---------------------------------------------------------------------
       STATE SWITCHING (empty / loading / error / dashboard)
    --------------------------------------------------------------------- */

    function showLoading() {
        els.emptyState.classList.add('hidden');
        els.errorState.classList.add('hidden');
        els.dashboard.classList.add('hidden');
        els.loadingState.classList.remove('hidden');
    }

    function showError(title, copy) {
        els.loadingState.classList.add('hidden');
        els.emptyState.classList.add('hidden');
        els.dashboard.classList.add('hidden');
        els.errorState.classList.remove('hidden');
        els.errorTitle.textContent = title;
        els.errorCopy.textContent = copy;
        els.errorState.classList.remove('shake');
        // Force reflow to restart animation
        void els.errorState.offsetWidth;
        els.errorState.classList.add('shake');
        refreshIcons();
    }

    function showDashboard() {
        els.loadingState.classList.add('hidden');
        els.emptyState.classList.add('hidden');
        els.errorState.classList.add('hidden');
        els.dashboard.classList.remove('hidden');
    }

    /* ---------------------------------------------------------------------
       RENDERING
    --------------------------------------------------------------------- */

    function renderWeather(data, opts = {}) {
        const meta = data._meta || {};
        const current = data.current;
        const daily = data.daily;
        const hourly = data.hourly;
        const isDay = current.is_day === 1;
        const info = wmoInfo(current.weather_code);

        clockTimezoneOffsetSeconds = data.utc_offset_seconds;

        // Location
        els.cityName.textContent = meta.label || 'Current location';
        els.countryName.textContent = [meta.admin1, meta.country].filter(Boolean).join(', ');

        // Hero temp with count-up animation
        const targetTemp = fmtTemp(current.temperature_2m);
        if (opts.animateTemp || opts.isFreshLoad) {
            animateNumber(els.heroTemp, targetTemp);
        } else {
            els.heroTemp.textContent = targetTemp;
        }
        els.heroUnit.textContent = unitSymbol();

        // Icon + condition
        els.heroIcon.innerHTML = `<i data-lucide="${info.icon}"></i>`;
        els.heroCondition.textContent = info.label;
        els.heroFeelslike.textContent = `${fmtTemp(current.apparent_temperature)}${unitSymbol()}`;

        // Date/time
        const localDate = new Date(Date.now() + data.utc_offset_seconds * 1000);
        els.heroDate.textContent = localDate.toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
        });
        els.heroDaynight.textContent = isDay ? 'Daytime' : 'Night';

        // Stats strip
        els.statHumidity.textContent = `${Math.round(current.relative_humidity_2m)}%`;
        els.statWind.textContent = `${Math.round(current.wind_speed_10m)} km/h`;
        els.statPressure.textContent = `${Math.round(current.surface_pressure)} hPa`;
        const visKm = current.visibility != null ? (current.visibility / 1000).toFixed(1) : '--';
        els.statVisibility.textContent = `${visKm} km`;

        // Instruments
        els.instSunrise.textContent = formatTimeLocal(daily.sunrise[0]);
        els.instSunset.textContent = formatTimeLocal(daily.sunset[0]);
        els.instWinddir.textContent = `${Math.round(current.wind_direction_10m)}°`;
        els.instDewpoint.textContent = `${fmtTemp(current.dew_point_2m)}${unitSymbol()}`;
        els.instCloudcover.textContent = `${Math.round(current.cloud_cover)}%`;
        els.instUv.textContent = daily.uv_index_max ? daily.uv_index_max[0].toFixed(1) : '--';

        // Footer coords
        if (meta.lat != null) {
            els.footerCoords.textContent = `${meta.lat.toFixed(2)}°, ${meta.lon.toFixed(2)}°`;
        }

        // Hourly forecast (next 24h from now)
        renderHourly(hourly, data.utc_offset_seconds);

        // Daily forecast
        renderDaily(daily);

        refreshIcons();
        showDashboard();
        applySkyScene(info.group, isDay);

        if (opts.isFreshLoad) {
            animateDashboardEntrance();
        }
    }

    function formatTimeLocal(isoString) {
        // Open-Meteo returns naive local-time strings (timezone=auto already applied server-side).
        // Parse as UTC and read back with UTC getters so we don't re-apply the browser's own
        // timezone on top of it.
        const d = new Date(isoString + (isoString.endsWith('Z') ? '' : 'Z'));
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }

    function renderHourly(hourly, utcOffsetSeconds) {
        els.hourlyScroll.innerHTML = '';
        // Open-Meteo's hourly.time strings are naive local-time ISO strings (no offset suffix),
        // e.g. "2026-07-04T14:00". Compare them as UTC-parsed values against "now" shifted by
        // the same offset so both sides live in the same naive-local frame.
        const nowInLocalFrameMs = Date.now() + utcOffsetSeconds * 1000;
        let startIdx = hourly.time.findIndex((t) => Date.parse(t + 'Z') >= nowInLocalFrameMs);
        if (startIdx < 0) startIdx = 0;

        const frag = document.createDocumentFragment();
        for (let i = startIdx; i < Math.min(startIdx + 24, hourly.time.length); i++) {
            const info = wmoInfo(hourly.weather_code[i]);
            const card = document.createElement('div');
            card.className = 'hour-card';
            card.innerHTML = `
        <span class="hour-time">${i === startIdx ? 'Now' : formatTimeLocal(hourly.time[i])}</span>
        <i data-lucide="${info.icon}" class="hour-icon"></i>
        <span class="hour-temp">${fmtTemp(hourly.temperature_2m[i])}°</span>
      `;
            frag.appendChild(card);
        }
        els.hourlyScroll.appendChild(frag);
        refreshIcons();
    }

    function renderDaily(daily) {
        els.dailyGrid.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (let i = 0; i < daily.time.length && i < 5; i++) {
            const d = new Date(daily.time[i]);
            const info = wmoInfo(daily.weather_code[i]);
            const dayLabel = i === 0 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
            const card = document.createElement('div');
            card.className = 'day-card';
            card.innerHTML = `
        <span class="day-name">${dayLabel}</span>
        <i data-lucide="${info.icon}" class="day-icon"></i>
        <span class="day-temps">
          <span class="day-temp-high">${fmtTemp(daily.temperature_2m_max[i])}°</span>
          <span class="day-temp-low">${fmtTemp(daily.temperature_2m_min[i])}°</span>
        </span>
      `;
            frag.appendChild(card);
        }
        els.dailyGrid.appendChild(frag);
        refreshIcons();
    }

    /* ---------------------------------------------------------------------
       NUMBER COUNT-UP ANIMATION
    --------------------------------------------------------------------- */

    function animateNumber(el, target) {
        const start = parseInt(el.textContent, 10) || 0;
        const obj = { val: start };
        if (window.gsap) {
            gsap.to(obj, {
                val: target,
                duration: 0.8,
                ease: 'power2.out',
                onUpdate: () => { el.textContent = Math.round(obj.val); },
            });
        } else {
            el.textContent = target;
        }
    }

    /* ---------------------------------------------------------------------
       SKY SCENE — dynamic background based on weather group + day/night
    --------------------------------------------------------------------- */

    let currentSkyClass = null;

    function applySkyScene(group, isDay) {
        const key = `${group}-${isDay ? 'day' : 'night'}`;
        if (key === currentSkyClass) return; // avoid re-triggering particle rebuilds needlessly
        currentSkyClass = key;

        const classMap = {
            'clear-day': 'sky-clear-day',
            'clear-night': 'sky-clear-night',
            'cloudy-day': 'sky-cloudy-day',
            'cloudy-night': 'sky-cloudy-night',
            'rain-day': 'sky-rain',
            'rain-night': 'sky-rain-night',
            'snow-day': 'sky-snow',
            'snow-night': 'sky-snow',
            'storm-day': 'sky-storm',
            'storm-night': 'sky-storm',
            'fog-day': 'sky-fog',
            'fog-night': 'sky-fog',
        };
        const targetClass = classMap[key] || 'sky-clear-day';

        // Swap body class (all sky-* classes removed first)
        document.body.className = document.body.className
            .split(' ')
            .filter((c) => !c.startsWith('sky-'))
            .join(' ');
        document.body.classList.add(targetClass);

        // Celestial body
        els.celestialBody.className = 'celestial-body ' + (isDay ? 'is-sun' : 'is-moon');
        els.celestialBody.style.opacity = (group === 'storm' || group === 'fog') ? '0.35' : '1';

        // Stars only at night
        els.stars.classList.toggle('is-visible', !isDay);
        if (!isDay && els.stars.children.length === 0) buildStars();

        // Clouds for cloudy/rain/snow/storm
        const showClouds = ['cloudy', 'rain', 'snow', 'storm', 'fog'].includes(group);
        els.cloudsLayer.classList.toggle('is-visible', showClouds);
        if (showClouds) buildClouds(group);
        else els.cloudsLayer.innerHTML = '';

        // Rain
        const showRain = group === 'rain' || group === 'storm';
        els.rainLayer.classList.toggle('is-visible', showRain);
        if (showRain) buildRain(group === 'storm' ? 90 : 55);
        else els.rainLayer.innerHTML = '';

        // Snow
        const showSnow = group === 'snow';
        els.snowLayer.classList.toggle('is-visible', showSnow);
        if (showSnow) buildSnow();
        else els.snowLayer.innerHTML = '';

        // Particles (sunny ambience)
        const showParticles = group === 'clear' && isDay;
        els.particles.classList.toggle('is-visible', showParticles);
        if (showParticles) buildParticles();
        else els.particles.innerHTML = '';

        // Lightning loop for storms
        stopLightning();
        if (group === 'storm') startLightning();
    }

    function buildStars() {
        els.stars.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 45; i++) {
            const s = document.createElement('div');
            s.className = 'star';
            const size = Math.random() * 2 + 1;
            s.style.width = `${size}px`;
            s.style.height = `${size}px`;
            s.style.top = `${Math.random() * 70}%`;
            s.style.left = `${Math.random() * 100}%`;
            s.style.animationDelay = `${Math.random() * 3}s`;
            frag.appendChild(s);
        }
        els.stars.appendChild(frag);
    }

    function buildClouds(group) {
        els.cloudsLayer.innerHTML = '';
        const dense = group === 'storm' || group === 'rain' || group === 'fog';
        const count = dense ? 6 : 4;
        const frag = document.createDocumentFragment();
        for (let i = 0; i < count; i++) {
            const c = document.createElement('div');
            c.className = 'cloud-shape' + (dense ? ' dense' : '');
            const width = 140 + Math.random() * 160;
            const height = width * 0.4;
            c.style.width = `${width}px`;
            c.style.height = `${height}px`;
            c.style.top = `${5 + Math.random() * 35}%`;
            c.style.left = `${Math.random() * 100}%`;
            const duration = 40 + Math.random() * 40;
            c.style.animation = `drift-cloud ${duration}s linear infinite`;
            c.style.animationDelay = `-${Math.random() * duration}s`;
            c.style.opacity = String(0.5 + Math.random() * 0.4);
            frag.appendChild(c);
        }
        els.cloudsLayer.appendChild(frag);
    }

    function buildRain(count) {
        els.rainLayer.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (let i = 0; i < count; i++) {
            const d = document.createElement('div');
            d.className = 'raindrop';
            d.style.left = `${Math.random() * 100}%`;
            d.style.height = `${40 + Math.random() * 40}px`;
            const duration = 0.5 + Math.random() * 0.5;
            d.style.animationDuration = `${duration}s`;
            d.style.animationDelay = `-${Math.random() * duration}s`;
            frag.appendChild(d);
        }
        els.rainLayer.appendChild(frag);
    }

    function buildSnow() {
        els.snowLayer.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 60; i++) {
            const s = document.createElement('div');
            s.className = 'snowflake';
            const size = 3 + Math.random() * 5;
            s.style.width = `${size}px`;
            s.style.height = `${size}px`;
            s.style.left = `${Math.random() * 100}%`;
            const duration = 6 + Math.random() * 8;
            s.style.animationDuration = `${duration}s`;
            s.style.animationDelay = `-${Math.random() * duration}s`;
            frag.appendChild(s);
        }
        els.snowLayer.appendChild(frag);
    }

    function buildParticles() {
        els.particles.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 24; i++) {
            const p = document.createElement('div');
            p.className = 'particle-dot';
            p.style.left = `${Math.random() * 100}%`;
            p.style.top = `${Math.random() * 60}%`;
            const duration = 4 + Math.random() * 4;
            p.style.animationDuration = `${duration}s`;
            p.style.animationDelay = `-${Math.random() * duration}s`;
            frag.appendChild(p);
        }
        els.particles.appendChild(frag);
    }

    let lightningInterval = null;
    function startLightning() {
        function strike() {
            els.lightningFlash.classList.remove('flash');
            void els.lightningFlash.offsetWidth;
            els.lightningFlash.classList.add('flash');
        }
        strike();
        lightningInterval = setInterval(strike, 4000 + Math.random() * 5000);
    }
    function stopLightning() {
        if (lightningInterval) clearInterval(lightningInterval);
        lightningInterval = null;
        els.lightningFlash.classList.remove('flash');
    }

    /* ---------------------------------------------------------------------
       ENTRANCE ANIMATIONS (GSAP / Motion)
    --------------------------------------------------------------------- */

    function animateHeaderEntrance() {
        if (!window.gsap) return;
        gsap.fromTo(
            '[data-anim="header-item"]',
            { y: -16, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.6, stagger: 0.08, ease: 'power2.out' }
        );
    }

    function animateEmptyEntrance() {
        if (!window.gsap) return;
        gsap.fromTo(
            '#empty-state',
            { opacity: 0, y: 12 },
            { opacity: 1, y: 0, duration: 0.7, ease: 'power2.out' }
        );
    }

    function animateDashboardEntrance() {
        // Wire up scroll-reveal only now, since sections are finally visible/laid out
        // (calling this while the dashboard was display:none left them stuck invisible).
        observeSectionsForReveal();

        if (!window.gsap) return;
        gsap.fromTo(
            '[data-anim="hero-item"]',
            { y: 24, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.7, stagger: 0.1, ease: 'power3.out' }
        );
        gsap.fromTo(
            '[data-anim="stat-card"]',
            { y: 20, opacity: 0, scale: 0.96 },
            { y: 0, opacity: 1, scale: 1, duration: 0.55, stagger: 0.07, delay: 0.25, ease: 'power2.out' }
        );
        gsap.fromTo(
            '.hour-card',
            { y: 16, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.45, stagger: 0.03, delay: 0.4, ease: 'power2.out' }
        );
        gsap.fromTo(
            '.day-card',
            { y: 16, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.5, stagger: 0.06, delay: 0.5, ease: 'power2.out' }
        );
        gsap.fromTo(
            '[data-anim="instrument"]',
            { y: 16, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.5, stagger: 0.05, delay: 0.6, ease: 'power2.out' }
        );
    }

    // Scroll-triggered reveals for sections re-entering view (simple IntersectionObserver,
    // keeps things lightweight without requiring GSAP ScrollTrigger plugin).
    // NOTE: this must only be wired up AFTER the dashboard is visible — observing
    // elements while their container is display:none means they can never intersect,
    // so they'd stay stuck at opacity:0 forever. See observeSectionsForReveal() call
    // inside renderWeather()/animateDashboardEntrance(), not init().
    const revealObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.style.opacity = '1';
                    entry.target.style.transform = 'translateY(0)';
                    revealObserver.unobserve(entry.target);
                }
            });
        },
        { threshold: 0.15 }
    );

    let sectionsObserved = false;

    function observeSectionsForReveal() {
        const sections = document.querySelectorAll('.forecast-section, .instruments-section');
        sections.forEach((section) => {
            // Reset any prior inline styles first (safe to call on every fresh render)
            section.style.transition = 'opacity 0.6s cubic-bezier(0.16,1,0.3,1), transform 0.6s cubic-bezier(0.16,1,0.3,1)';
            section.style.opacity = '0';
            section.style.transform = 'translateY(24px)';
            revealObserver.unobserve(section); // avoid double-observing on repeat renders
            revealObserver.observe(section);
        });
        sectionsObserved = true;
    }

    /* ---------------------------------------------------------------------
       BUTTON PRESS MICRO-INTERACTIONS (Motion)
    --------------------------------------------------------------------- */

    function wireButtonPress(selector) {
        document.querySelectorAll(selector).forEach((btn) => {
            btn.addEventListener('pointerdown', () => {
                if (window.Motion && window.Motion.animate) {
                    window.Motion.animate(btn, { scale: 0.94 }, { duration: 0.12 });
                }
            });
            btn.addEventListener('pointerup', () => {
                if (window.Motion && window.Motion.animate) {
                    window.Motion.animate(btn, { scale: 1 }, { duration: 0.2 });
                }
            });
        });
    }

    /* ---------------------------------------------------------------------
       PAUSE BACKGROUND ANIMATIONS DURING SCROLL
       Dozens of concurrently-animated decorative elements (stars, clouds,
       rain, snow, particles, the moon's drift) plus the browser having to
       recomposite the whole page every scroll frame is what was causing
       torn/corrupted rendering on weaker GPUs. Pausing those animations for
       the duration of the scroll — and for a short moment after it ends —
       removes that overlap. Uses a simple debounce so it only re-enables
       once scrolling has actually stopped.
    --------------------------------------------------------------------- */

    let scrollPauseTimeout = null;
    function handleScrollForAnimationPause() {
        document.body.classList.add('is-scrolling');
        clearTimeout(scrollPauseTimeout);
        scrollPauseTimeout = setTimeout(() => {
            document.body.classList.remove('is-scrolling');
        }, 200);
    }
    window.addEventListener('scroll', handleScrollForAnimationPause, { passive: true });

    /* ---------------------------------------------------------------------
       INIT
    --------------------------------------------------------------------- */

    /* ---------------------------------------------------------------------
       SKY SCENE
       .sky-scene is now `position: fixed` and viewport-sized via CSS
       (`inset: 0`), so it no longer needs to be measured/resized in JS to
       match the full document height. That JSdriven resizing (plus the
       forced GPU layer promotion it required) was what produced a
       multi-thousand-pixel-tall compositor layer on long pages — the actual
       cause of the striped/torn rendering and blank patches on mobile.
    --------------------------------------------------------------------- */

    function init() {
        animateHeaderEntrance();
        animateEmptyEntrance();
        wireButtonPress('.chip, .retry-btn, .unit-btn, .locate-btn');
        applySkyScene('clear', new Date().getHours() >= 6 && new Date().getHours() < 19);
    }

    document.addEventListener('DOMContentLoaded', init);
})();