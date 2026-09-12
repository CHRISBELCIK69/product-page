// ============================================================
// hero-candles.js
// Decorative candlestick chart that prints into the hero canvas
// bar-by-bar — a noisy random walk with a gentle upward drift, so
// individual bars vary in length and some are genuine red pullbacks,
// while the 26-bar sequence still trends up overall. Timed to finish
// right as .hero-content's fade-in starts (product-page.css).
// ============================================================

(function () {
  const canvas = document.getElementById('heroCandles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const BAR_COUNT = 26;
  const BAR_MS    = 45;   // gap before the next bar starts printing
  const GROW_MS   = 140;  // how long each bar takes to grow to full height

  let bars = [];
  let W = 0, H = 0;

  function genBars() {
    bars = [];
    const base       = 38;   // starting price level
    const totalRise  = 34;   // guaranteed rise from first bar to last
    let prevClose = base;
    for (let i = 0; i < BAR_COUNT; i++) {
      // Bars scatter around a steadily rising trend line rather than a
      // pure random walk — a walk's noise can easily wander the whole
      // chart down over just 26 steps, and the ask was randomness
      // *within* an upward trajectory, not instead of it.
      const trendLevel = base + (totalRise * (i + 1)) / BAR_COUNT;
      const noise = (Math.random() - 0.5) * 7;
      const open  = prevClose;
      const close = Math.max(3, trendLevel + noise);
      const wick  = 0.4 + Math.random() * 2.2;        // wick length varies bar to bar
      const high  = Math.max(open, close) + Math.random() * wick;
      const low   = Math.max(1, Math.min(open, close) - Math.random() * wick);
      bars.push({ open, close, high, low });
      prevClose = close;
    }
  }

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    W = rect.width; H = rect.height;
    canvas.width  = W * dpr; canvas.height = H * dpr;
    canvas.style.width  = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(upTo, growth) {
    ctx.clearRect(0, 0, W, H);
    if (!bars.length || !upTo) return;

    const lo  = Math.min(...bars.map(b => b.low));
    const hi  = Math.max(...bars.map(b => b.high));
    const pad = (hi - lo) * 0.15 || 1;
    const min = lo - pad, max = hi + pad;

    const gap    = W / BAR_COUNT;
    const bodyW  = Math.max(3, gap * 0.5);
    const y      = p => H - ((p - min) / (max - min)) * H;

    for (let i = 0; i < upTo && i < bars.length; i++) {
      const b       = bars[i];
      const isLast  = i === upTo - 1;
      const g       = isLast ? growth : 1;
      const x       = gap * i + gap / 2;
      const up      = b.close >= b.open;
      const color   = up ? 'rgba(45,212,191,0.55)' : 'rgba(229,72,77,0.5)';

      const openY   = y(b.open), closeY = y(b.close);
      const bodyTop = Math.min(openY, closeY);
      const bodyH   = Math.max(1.5, Math.abs(closeY - openY));
      const grownH  = Math.max(1.5, bodyH * g);
      // Grows from the open edge, same as a live bar printing in.
      const grownTop = up ? (bodyTop + bodyH) - grownH : bodyTop;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y(b.high));
      ctx.lineTo(x, y(b.low));
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.fillRect(x - bodyW / 2, grownTop, bodyW, grownH);
    }
  }

  function animate() {
    if (reduceMotion) { draw(bars.length, 1); return; }

    const GROW_STEPS = 6;
    let i = 0;

    function nextBar() {
      i++;
      if (i > bars.length) return;
      let step = 0;
      function growStep() {
        step++;
        draw(i, step / GROW_STEPS);
        if (step < GROW_STEPS) {
          setTimeout(growStep, GROW_MS / GROW_STEPS);
        } else if (i < bars.length) {
          setTimeout(nextBar, BAR_MS);
        }
      }
      growStep();
    }
    nextBar();
  }

  genBars();
  resize();
  animate();

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resize(); draw(bars.length, 1); }, 150);
  });
})();
