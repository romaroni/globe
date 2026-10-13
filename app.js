/* Every Second on Earth: a simulated, real-time globe of life events.
 * Annual country counts → per-second Poisson streams → population-weighted city → local-time rhythm. */
(() => {
  const { animate, spring, stagger } = Motion;

  const TYPES = [
    { id: 'birth',      label: 'Births',         one: 'Birth' },
    { id: 'death',      label: 'Deaths',         one: 'Death' },
    { id: 'marriage',   label: 'Marriages',      one: 'Wedding' },
    { id: 'divorce',    label: 'Divorces',       one: 'Divorce' },
    { id: 'graduation', label: 'Graduations',    one: 'Graduation' },
    { id: 'business',   label: 'New businesses', one: 'New business' },
    { id: 'patent',     label: 'Patent filings', one: 'Patent filed' },
    { id: 'migration',  label: 'Migrations',     one: 'Migration', arc: true },
  ];
  const rootStyle = getComputedStyle(document.documentElement);
  for (const t of TYPES) t.color = rootStyle.getPropertyValue(`--c-${t.id}`).trim();
  const TYPE = Object.fromEntries(TYPES.map(t => [t.id, t]));

  const SECONDS_PER_YEAR = 365.25 * 86400;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Daily rhythm by local hour (h, 0–24) and local weekday (d, 0 = Sunday) ----------------
  const bump = (h, c, w) => { let d = Math.abs(h - c); d = Math.min(d, 24 - d); return Math.exp(-(d * d) / (2 * w * w)); };
  const office = (h, d) => (d > 0 && d < 6 ? 1 : 0.12) * (h >= 8.5 && h < 17.5 ? 1 : 0.04);
  const RHYTHM = {
    birth:      h => 0.85 + 0.35 * bump(h, 10, 3),        // scheduled deliveries skew to the morning
    death:      h => 0.9 + 0.2 * bump(h, 5, 4),           // slight early-morning peak
    marriage:   (h, d) => (d === 6 ? 3 : d === 5 || d === 0 ? 1.6 : 0.7) * (0.03 + bump(h, 15, 3)),
    divorce:    office,                                    // courts and registries keep office hours
    business:   office,
    patent:     (h, d) => office(h, d) + 0.05,             // plus round-the-clock online filing
    graduation: (h, d) => (d === 0 ? 0.4 : 1) * (0.02 + bump(h, 13, 3)),
    migration:  h => 0.4 + bump(h, 14, 5),                 // arrivals, mostly daytime
  };
  // Normalise each curve to a weekly mean of 1 so annual totals are preserved; thinning uses max.
  for (const t of TYPES) {
    let sum = 0, max = 0, n = 0;
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h += 0.25) { const v = RHYTHM[t.id](h, d); sum += v; max = Math.max(max, v); n++; }
    t.boost = max / (sum / n);   // candidate rate multiplier
    t.wmax = max;
  }

  // ---- Sampling helpers ------------------------------------------------------------------------
  const pick = (cum) => {        // cum: Float64Array of cumulative weights
    const r = Math.random() * cum[cum.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const poisson = (lambda) => {
    if (lambda > 40) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss()));
    const L = Math.exp(-lambda); let k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
  const cumulative = (arr, f) => { const c = new Float64Array(arr.length); let s = 0; arr.forEach((x, i) => { s += f(x); c[i] = s; }); return c; };

  // Motion's spring generator, sampled once into a lookup table for the bloom of every dot.
  const BLOOM_MS = 1400, BLOOM_STEPS = 140;
  const bloomGen = spring({ keyframes: [0, 1], stiffness: reduceMotion ? 300 : 140, damping: reduceMotion ? 40 : 11, mass: 1 });
  const BLOOM = new Float32Array(BLOOM_STEPS + 1).map((_, i) => bloomGen.next((i / BLOOM_STEPS) * BLOOM_MS).value);
  const bloomAt = ms => BLOOM[Math.min(BLOOM_STEPS, Math.max(0, Math.round(ms / BLOOM_MS * BLOOM_STEPS)))];

  // ---- State -----------------------------------------------------------------------------------
  const canvas = document.getElementById('globe');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  const BASE_SPIN = reduceMotion ? 0.5 : 1;   // °/s at 1×; scales with playback speed
  const view = { zoom: reduceMotion ? 1 : 0.82, speed: 1, spin: 1 };   // spin: 0–1 factor, 0 while dragging
  const rotation = [new Date().getTimezoneOffset() / 4, -18, 0];                         // start over the viewer's longitude
  let simMs = Date.now();
  const enabled = Object.fromEntries(TYPES.map(t => [t.id, true]));
  const counts = Object.fromEntries(TYPES.map(t => [t.id, 0]));
  const events = [];   // { type, lon, lat, t0, life, city, country } or arcs with from/to
  let world, countries, streams, lastTickerAt = 0, latestForTicker = null;

  const projection = d3.geoOrthographic().clipAngle(90).precision(0.6);
  const path = d3.geoPath(projection, ctx);
  const graticule = d3.geoGraticule10();
  const sphere = { type: 'Sphere' };
  let landFeature, borderMesh, stars;

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    stars = makeStars();
  }
  function makeStars() {
    const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
    const g = c.getContext('2d'); g.fillStyle = '#ece6d6';
    const n = Math.round(W * H / 9000);
    for (let i = 0; i < n; i++) {
      g.globalAlpha = Math.random() * 0.35 + 0.05;
      g.fillRect(Math.random() * c.width, Math.random() * c.height, DPR * (Math.random() < 0.1 ? 1.4 : 0.8), DPR * (Math.random() < 0.1 ? 1.4 : 0.8));
    }
    return c;
  }
  function layoutProjection() {
    const wide = W > 900;
    const r = Math.min(wide ? W * 0.36 : W * 0.46, H * (wide ? 0.44 : 0.36)) * view.zoom;
    const cx = wide ? W * 0.56 : W / 2;
    const cy = wide ? H / 2 : H * 0.54;
    projection.scale(r).translate([cx, cy]).rotate(rotation);
    return { r, cx, cy };
  }

  // ---- Data → streams ----------------------------------------------------------------------------
  function buildStreams(data) {
    countries = data.countries.map(c => ({
      ...c,
      cityCum: cumulative(c.cities, x => x[3]),
      lon: c.cities[0][1], lat: c.cities[0][2],
    }));
    const s = {};
    for (const t of TYPES) {
      if (t.arc) continue;
      const list = countries.filter(c => c.rates[t.id] > 0);
      const perSec = list.reduce((a, c) => a + c.rates[t.id], 0) / SECONDS_PER_YEAR;
      s[t.id] = { list, cum: cumulative(list, c => c.rates[t.id]), perSec };
    }
    const dest = countries.filter(c => c.migration > 0), orig = countries.filter(c => c.migration < 0);
    s.migration = {
      list: dest, cum: cumulative(dest, c => c.migration), orig,
      perSec: dest.reduce((a, c) => a + c.migration, 0) / SECONDS_PER_YEAR,
    };
    return s;
  }
  const pickCity = c => c.cities[pick(c.cityCum)];
  const localClock = (lon) => {
    const ms = simMs + lon * 240000;                        // 4 min per degree of longitude (solar time)
    const h = ((ms / 3600000) % 24 + 24) % 24;
    const dow = ((Math.floor(ms / 86400000) + 4) % 7 + 7) % 7;   // 1970-01-01 was a Thursday
    return { h, dow };
  };

  function spawn(simDtSec, now) {
    const life = 2600 / Math.pow(view.speed, 0.12);
    for (const t of TYPES) {
      const st = streams[t.id];
      if (!st || !st.list.length) continue;
      const n = poisson(st.perSec * simDtSec * t.boost);
      for (let i = 0; i < n; i++) {
        const c = st.list[pick(st.cum)];
        const city = pickCity(c);
        const { h, dow } = localClock(city[1]);
        if (Math.random() * t.wmax > RHYTHM[t.id](h, dow)) continue;   // thinning by local hour
        counts[t.id]++;
        if (!enabled[t.id]) continue;
        let ev;
        if (t.arc) {
          const from = pickOrigin(st.orig, city);
          if (!from) continue;
          ev = { type: t.id, from: [from.city[1], from.city[2]], to: [city[1], city[2]], t0: now, life: life * 1.8,
                 interp: d3.geoInterpolate([from.city[1], from.city[2]], [city[1], city[2]]),
                 dist: d3.geoDistance([from.city[1], from.city[2]], [city[1], city[2]]),
                 city: city[0], country: c.name, fromCity: from.city[0], fromCountry: from.country.name, h };
        } else {
          ev = { type: t.id, lon: city[1], lat: city[2], t0: now, life, city: city[0], country: c.name, h };
        }
        events.push(ev);
        latestForTicker = ev;
      }
    }
    if (events.length > 5000) events.splice(0, events.length - 5000);
  }
  // Origins are weighted by net emigration with a distance decay, so most moves are regional.
  function pickOrigin(orig, destCity) {
    if (!orig.length) return null;
    const w = new Float64Array(orig.length); let s = 0;
    for (let i = 0; i < orig.length; i++) {
      const o = orig[i];
      s += -o.migration * Math.exp(-d3.geoDistance([o.lon, o.lat], [destCity[1], destCity[2]]) / 0.9);
      w[i] = s;
    }
    const o = orig[pick(w)];
    return { country: o, city: pickCity(o) };
  }

  // ---- Rendering ------------------------------------------------------------------------------
  function sunPosition() {
    const d = new Date(simMs);
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    const doy = (simMs - start) / 86400000;
    const decl = 23.44 * Math.sin(2 * Math.PI * (doy - 81) / 365);
    const utcH = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    return [-(utcH - 12) * 15, decl];
  }

  function draw(now) {
    const { r, cx, cy } = layoutProjection();
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(stars, 0, 0, W, H);

    // atmosphere
    const glow = ctx.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.22);
    glow.addColorStop(0, 'rgba(120, 150, 190, 0.16)');
    glow.addColorStop(1, 'rgba(120, 150, 190, 0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, r * 1.22, 0, 2 * Math.PI); ctx.fill();

    ctx.beginPath(); path(sphere); ctx.fillStyle = rootStyle.getPropertyValue('--ocean'); ctx.fill();
    ctx.beginPath(); path(graticule); ctx.strokeStyle = 'rgba(232,226,210,0.04)'; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.beginPath(); path(landFeature); ctx.fillStyle = rootStyle.getPropertyValue('--land'); ctx.fill();
    ctx.beginPath(); path(borderMesh); ctx.strokeStyle = 'rgba(232,226,210,0.13)'; ctx.lineWidth = 0.5; ctx.stroke();

    // night side, soft-edged
    const sun = sunPosition();
    const anti = [sun[0] + 180, -sun[1]];
    for (const [rad, a] of [[96, 0.10], [92, 0.12], [88, 0.16]]) {
      ctx.beginPath(); path(d3.geoCircle().center(anti).radius(rad)()); ctx.fillStyle = `rgba(0,0,0,${a})`; ctx.fill();
    }

    ctx.beginPath(); path(sphere); ctx.strokeStyle = 'rgba(232,226,210,0.22)'; ctx.lineWidth = 0.8; ctx.stroke();

    // events
    const center = [-rotation[0], -rotation[1]];
    ctx.globalCompositeOperation = 'lighter';
    let w = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const el = now - e.t0, age = el / e.life;
      if (age >= 1) continue;
      events[w++] = e;
      if (!enabled[e.type]) continue;
      ctx.fillStyle = ctx.strokeStyle = TYPE[e.type].color;
      if (e.interp) { drawArc(e, age, center, cx, cy); continue; }
      if (d3.geoDistance([e.lon, e.lat], center) > Math.PI / 2 - 0.01) continue;
      const [x, y] = projection([e.lon, e.lat]);
      const fade = 1 - age;
      const s = bloomAt(el);
      ctx.globalAlpha = 0.55 * fade * fade;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 1.5 + 9 * s, 0, 2 * Math.PI); ctx.stroke();
      ctx.globalAlpha = 0.18 * fade;
      ctx.beginPath(); ctx.arc(x, y, 1 + 4 * s, 0, 2 * Math.PI); ctx.fill();
      ctx.globalAlpha = fade;
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 2 * Math.PI); ctx.fill();
    }
    events.length = w;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  function drawArc(e, age, center, cx, cy) {
    const head = ease(Math.min(1, age * 1.5));
    const tail = Math.max(0, ease(Math.min(1, Math.max(0, age * 1.5 - 0.35))));
    const fade = age < 0.67 ? 1 : 1 - (age - 0.67) / 0.33;
    const lift = 0.04 + 0.22 * (e.dist / Math.PI);
    const N = 36;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let pen = false;
    for (let k = 0; k <= N; k++) {
      const f = tail + (head - tail) * (k / N);
      const p = e.interp(f);
      if (d3.geoDistance(p, center) > Math.PI / 2) { pen = false; continue; }
      const [x, y] = projection(p);
      const a = 1 + lift * Math.sin(Math.PI * f);
      const X = cx + (x - cx) * a, Y = cy + (y - cy) * a;
      if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; }
    }
    ctx.globalAlpha = 0.75 * fade; ctx.stroke();
    // origin and destination marks
    for (const [pt, on] of [[e.from, true], [e.to, head > 0.98]]) {
      if (!on || d3.geoDistance(pt, center) > Math.PI / 2) continue;
      const [x, y] = projection(pt);
      ctx.globalAlpha = fade; ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 2 * Math.PI); ctx.fill();
    }
  }

  // ---- UI ---------------------------------------------------------------------------------------
  const legendEl = document.getElementById('legend');
  const countEls = {}, rateEls = {};
  const fmtCount = n => n.toLocaleString('en-US');
  const fmtRate = v => v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2);

  function buildLegend() {
    for (const t of TYPES) {
      const li = document.createElement('li');
      li.innerHTML = `<button type="button" id="toggle-${t.id}" aria-pressed="true" style="--c:${t.color}">
        <span class="swatch${t.arc ? ' arc' : ''}"></span><span class="label">${t.label}</span>
        <span class="count">0</span><span class="rate"></span></button>`;
      const btn = li.firstElementChild;
      btn.addEventListener('click', () => {
        enabled[t.id] = !enabled[t.id];
        btn.setAttribute('aria-pressed', String(enabled[t.id]));
        animate(btn.querySelector('.swatch'), { scale: [1.8, 1] }, { type: 'spring', stiffness: 400, damping: 15 });
      });
      countEls[t.id] = btn.querySelector('.count');
      rateEls[t.id] = btn.querySelector('.rate');
      legendEl.appendChild(li);
    }
  }
  function updateLegend() {
    for (const t of TYPES) {
      countEls[t.id].textContent = fmtCount(counts[t.id]);
      const st = streams[t.id];
      rateEls[t.id].textContent = st ? fmtRate(st.perSec * view.speed) : '–';
    }
  }

  const clockEl = document.getElementById('clock');
  function updateClock() {
    const d = new Date(simMs);
    const p = n => String(n).padStart(2, '0');
    const date = d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
    clockEl.innerHTML = `${date} · UTC <strong>${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}</strong>`;
  }

  // Speed: segmented control with a spring-animated pill; the playback rate eases between values.
  const speedEl = document.getElementById('speed'), pill = document.getElementById('speed-pill');
  let speedAnim;
  function placePill(btn, instant) {
    const x = btn.offsetLeft - 2, width = btn.offsetWidth;
    if (instant) { pill.style.transform = `translateX(${x}px)`; pill.style.width = `${width}px`; return; }
    animate(pill, { x, width }, { type: 'spring', stiffness: 420, damping: 34 });
  }
  speedEl.addEventListener('click', ev => {
    const btn = ev.target.closest('button'); if (!btn) return;
    for (const b of speedEl.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
    placePill(btn);
    speedAnim?.stop();
    speedAnim = animate(view.speed, +btn.dataset.speed, { duration: 0.8, ease: 'easeInOut', onUpdate: v => { view.speed = v; } });
  });

  // Ticker: one recent event every ~0.7s, springing in from the right.
  const tickerEl = document.getElementById('ticker');
  function pushTicker(e) {
    const t = TYPE[e.type];
    const hh = Math.floor(e.h), mm = Math.floor((e.h - hh) * 60);
    const li = document.createElement('li');
    li.style.setProperty('--c', t.color);
    const where = e.interp
      ? `${esc(e.fromCity)} <em>→</em> ${esc(e.city)}<em>, ${esc(e.country)}</em>`
      : `${esc(e.city)}<em>, ${esc(e.country)}</em>`;
    li.innerHTML = `<span class="dot"></span><span class="what">${t.one} <em>·</em> ${where}</span><span class="when">${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}</span>`;
    tickerEl.prepend(li);
    animate(li, { opacity: [0, 1], x: [24, 0] }, { type: 'spring', stiffness: 260, damping: 26 });
    const items = tickerEl.children;
    for (let i = 0; i < items.length; i++) items[i].style.opacity = i === 0 ? '' : String(Math.max(0.15, 1 - i * 0.17));
    while (items.length > 6) items[items.length - 1].remove();
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function buildAbout(data) {
    const sources = {
      birth: 'World Bank WDI crude birth rate × population',
      death: 'World Bank WDI crude death rate × population',
      marriage: 'Our World in Data crude marriage rate (UN, OECD, Eurostat), newest year since 1995',
      divorce: 'Hand-compiled crude divorce rates from Eurostat, CDC, national statistics offices',
      graduation: 'Modeled: birth cohort from 22 years earlier × WDI tertiary enrolment ratio × 0.7',
      business: 'World Bank WDI new businesses registered',
      patent: 'World Bank WDI patent applications, residents + non-residents',
      migration: 'World Bank WDI net migration (UN WPP); origins weighted by net emigration and distance',
    };
    const rows = TYPES.map(t => `<tr><td>${t.label}</td><td>${sources[t.id]}</td>
      <td class="n">${data.coverage[t.id] || 0}</td><td class="n">${(data.totals[t.id] / 1e6).toFixed(1)}M/yr</td></tr>`).join('');
    document.getElementById('about-body').innerHTML = `
      <p>Each country's annual count becomes a random stream of events in real time. Every event lands in one of the
      country's cities, picked with odds proportional to population, then is kept or dropped by a local-hour rhythm:
      weddings cluster on Saturday afternoons, divorces and new businesses on weekday office hours, births lean to the morning.</p>
      <p>Coverage and methods differ by country and type, so a missing country means missing data, not zero events.</p>
      <table><tbody>${rows}</tbody></table>
      <p>Countries counted · yearly total. Cities: GeoNames (15k+ residents, top 250 per country). Data built ${data.generated}.</p>`;
  }

  // ---- Drag to rotate --------------------------------------------------------------------------
  let drag = null, spinAnim;
  canvas.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, r0: rotation.slice() };
    canvas.setPointerCapture(e.pointerId); canvas.classList.add('dragging');
    spinAnim?.stop(); view.spin = 0;
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const k = 75 / projection.scale();
    rotation[0] = drag.r0[0] + (e.clientX - drag.x) * k;
    rotation[1] = Math.max(-70, Math.min(70, drag.r0[1] - (e.clientY - drag.y) * k));
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null; canvas.classList.remove('dragging');
    spinAnim = animate(0, 1, { duration: 2.2, ease: 'easeIn', onUpdate: v => { view.spin = v; } });
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ---- Loop -------------------------------------------------------------------------------------
  let last = performance.now(), lastUi = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    simMs += dt * 1000 * view.speed;
    rotation[0] += BASE_SPIN * view.spin * view.speed * dt;
    spawn(dt * view.speed, now);
    draw(now);
    if (now - lastUi > 100) { updateLegend(); updateClock(); lastUi = now; }
    if (latestForTicker && now - lastTickerAt > 700) { pushTicker(latestForTicker); latestForTicker = null; lastTickerAt = now; }
    requestAnimationFrame(frame);
  }

  Promise.all([fetch('data/events.json').then(r => r.json()), fetch('data/countries-110m.json').then(r => r.json())])
    .then(([data, topo]) => {
      world = topo;
      landFeature = topojson.feature(world, world.objects.countries);
      borderMesh = topojson.mesh(world, world.objects.countries, (a, b) => a !== b);
      streams = buildStreams(data);
      buildLegend(); buildAbout(data);
      resize();
      placePill(document.getElementById('speed-1'), true);
      document.getElementById('loading').remove();
      if (!reduceMotion) {
        animate(view.zoom, 1, { type: 'spring', stiffness: 50, damping: 13, onUpdate: v => { view.zoom = v; } });
        animate(legendEl.children, { opacity: [0.25, 1], y: [6, 0] }, { delay: stagger(0.05, { startDelay: 0.15 }), duration: 0.5 });
      }
      requestAnimationFrame(t => { last = t; frame(t); });
    })
    .catch(err => {
      document.getElementById('loading').textContent = `Couldn't load the data files (${err.message}). Serve this folder over HTTP.`;
    });
  addEventListener('resize', () => { if (streams) resize(); });
})();
