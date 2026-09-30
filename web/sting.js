// The Kova logo sting (docs/design/Kova Logo Motion.dc.html, kova-sting.jsx) as the launch splash.
// Same scenes, curves and layout as the design: Signal → Waves → Settle, a short hold, then out.
// Plays once per session, on top of the app while it connects; a tap skips it; honours Reduce Motion.
(function () {
  try {
    if (sessionStorage.getItem('kova_sting')) return;
    sessionStorage.setItem('kova_sting', '1');
  } catch (e) { /* private mode: play anyway */ }
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const AMBER = '#f2b14c', INK = '#f1efea', BG = '#111214';
  // Design cues (seconds). The design holds 1.8 s and loops; a launch splash holds briefly and hands over.
  const C = { Signal: 0, Waves: 1.4, Settle: 3.2, Hold: 4.8, Out: 5.3 };
  const SPEED = 1.35, END = C.Out + 0.6;
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const linear = t => t;
  const tw = (from, to, start, end, ease) => T => { const p = Math.min(1, Math.max(0, (T - start) / (end - start))); return from + (to - from) * ease(p); };

  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); parent && parent.appendChild(n); return n; };

  const root = document.createElement('div');
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = `position:fixed;inset:0;z-index:2147483000;background:${BG};overflow:hidden;cursor:pointer`;
  // A 1920×1080 stage, scaled so the lockup fills most of the screen's width (phones) or height (desktops).
  const stage = document.createElement('div');
  stage.style.cssText = 'position:absolute;left:50%;top:50%;width:1920px;height:1080px;transform-origin:50% 50%';
  root.appendChild(stage);
  const scene = document.createElement('div');
  scene.style.cssText = 'position:absolute;inset:0;transform-origin:50% 50%';
  stage.appendChild(scene);
  const glowEl = document.createElement('div');
  glowEl.style.cssText = 'position:absolute;width:1040px;height:1040px;border-radius:50%;background:radial-gradient(circle, rgba(242,177,76,0.16) 0%, rgba(242,177,76,0) 62%)';
  scene.appendChild(glowEl);
  const markBox = document.createElement('div');
  markBox.style.cssText = 'position:absolute';
  scene.appendChild(markBox);
  const svg = el('svg', { viewBox: '0 0 48 48', width: '100%', height: '100%', style: 'overflow:visible' }, markBox);
  const ring1 = el('circle', { cx: 24, cy: 38.5, fill: 'none', stroke: AMBER, 'stroke-width': 0.8 }, svg);
  const ring2 = el('circle', { cx: 24, cy: 38.5, fill: 'none', stroke: AMBER, 'stroke-width': 0.6 }, svg);
  const S = 21.93, s = 10.97;
  const half = (d, len) => el('path', { d, fill: 'none', stroke: INK, 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-dasharray': len }, svg);
  const small = [half('M24 24.5L16 32', s), half('M24 24.5L32 32', s)];
  const big = [half('M24 11L8 26', S), half('M24 11L40 26', S)];
  const dotEl = el('circle', { cx: 24, cy: 38.5, fill: AMBER }, svg);
  const word = document.createElement('div');
  word.style.cssText = `position:absolute;left:850px;top:540px;transform:translateY(-50%);display:flex;font-family:Manrope,sans-serif;font-weight:800;font-size:210px;letter-spacing:-0.04em;line-height:1;color:${INK}`;
  const letters = 'Kova'.split('').map(ch => { const sp = document.createElement('span'); sp.textContent = ch; sp.style.display = 'inline-block'; word.appendChild(sp); return sp; });
  scene.appendChild(word);

  const fit = () => {
    const vw = innerWidth, vh = innerHeight;
    // Desktops: the design's own 1920×1080 composition, fitted. Phones: the settled lockup (x ≈ 565–1300) fills ~80% of the width.
    const k = vw >= 900 ? Math.min(vw / 1920, vh / 1080) : Math.min(vw * 0.8 / 760, vh / 1080 * 1.4);
    stage.style.transform = `translate(-50%,-50%) scale(${k})`;
  };
  fit();
  addEventListener('resize', fit);

  const dot = tw(0, 1, C.Signal + 0.2, C.Signal + 0.75, easeOutBack);
  const r1 = tw(0, 1, C.Signal + 0.55, C.Signal + 1.4, easeOutCubic);
  const r2 = tw(0, 1, C.Waves + 0.9, C.Waves + 1.7, easeOutCubic);
  const sP = tw(0, 1, C.Waves, C.Waves + 0.6, easeInOutCubic), sY = tw(7, 0, C.Waves, C.Waves + 0.7, easeOutCubic);
  const bP = tw(0, 1, C.Waves + 0.4, C.Waves + 1.1, easeInOutCubic), bY = tw(9, 0, C.Waves + 0.4, C.Waves + 1.2, easeOutCubic);
  const settleF = tw(0, 1, C.Settle, C.Settle + 0.9, easeInOutCubic);
  const camF = tw(0.97, 1.03, 0, C.Out, linear);
  const glowF = tw(0, 1, C.Waves, C.Settle, easeOutCubic);
  const pulseF = tw(0, 1, C.Hold - 0.2, C.Hold + 0.9, easeOutCubic);
  const outF = tw(1, 0, C.Out, C.Out + 0.6, easeInOutCubic);
  const letterF = letters.map((_, i) => tw(0, 1, C.Settle + 0.35 + i * 0.08, C.Settle + 0.95 + i * 0.08, easeOutCubic));

  const draw = T => {
    const settle = settleF(T), size = 360 - settle * 110, cx = 960 - settle * 270;
    scene.style.opacity = outF(T);
    scene.style.transform = `scale(${camF(T)})`;
    glowEl.style.left = (cx - 520) + 'px'; glowEl.style.top = '20px';
    glowEl.style.opacity = glowF(T) * (1 + 0.4 * Math.sin(pulseF(T) * Math.PI));
    markBox.style.cssText = `position:absolute;left:${cx - size / 2}px;top:${540 - size / 2}px;width:${size}px;height:${size}px`;
    const a = r1(T), b = r2(T), d = dot(T);
    ring1.setAttribute('r', 3.5 + a * 14); ring1.setAttribute('opacity', a > 0 && a < 1 ? 0.7 * (1 - a) : 0);
    ring2.setAttribute('r', 3.5 + b * 22); ring2.setAttribute('opacity', b > 0 && b < 1 ? 0.5 * (1 - b) : 0);
    const sp = sP(T), bp = bP(T);
    small.forEach(p => { p.setAttribute('stroke-dashoffset', s * (1 - sp)); p.setAttribute('opacity', sp > 0.01 ? 1 : 0); p.setAttribute('transform', `translate(0 ${sY(T)})`); });
    big.forEach(p => { p.setAttribute('stroke-dashoffset', S * (1 - bp)); p.setAttribute('opacity', bp > 0.01 ? 1 : 0); p.setAttribute('transform', `translate(0 ${bY(T)})`); });
    dotEl.setAttribute('r', 3.5 * Math.max(0, d));
    letters.forEach((sp2, i) => { const p = letterF[i](T); sp2.style.opacity = p; sp2.style.transform = `translateY(${(1 - p) * 60}px)`; });
  };

  let t0 = null, done = false;
  const finish = () => { if (done) return; done = true; removeEventListener('resize', fit); root.remove(); };
  const frame = now => {
    if (done) return;
    if (t0 == null) t0 = now;
    const T = (now - t0) / 1000 * SPEED;
    draw(Math.min(T, END));
    if (T >= END) finish(); else requestAnimationFrame(frame);
  };
  // Tap to skip: jump to the fade-out.
  root.addEventListener('click', () => { if (t0 != null) t0 = performance.now() - C.Out / SPEED * 1000; });
  draw(0);
  const mount = () => { document.body.appendChild(root); requestAnimationFrame(frame); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
