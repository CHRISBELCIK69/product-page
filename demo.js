const STRAT_COLORS = ['#2dd4bf','#fb923c','#818cf8','#22c55e','#f472b6'];
const DEMO_STRAT_IDS = ['trailing_pct_25','fixed_stop','bracket','profit_lock','break_even'];

const STRAT_DESCS = {
  trailing_pct_25: 'Trails 25% below running high — locks in gains as price rises',
  fixed_stop:      'Flat stop 25% below entry — never moves, simplest downside protection',
  bracket:         'Take profit at 50%, then trail 25% — structured risk/reward',
  profit_lock:     'Hard stop until up 50%, then trails 25% — waits for confirmation before trailing',
  break_even:      'Hard stop until up 30%, then moves stop to entry price'
};

const SC_META = {
  win:  { insight: 'Tight trailing stop shook out 52 min in — Fixed Stop held for 5× more gain' },
  lose: { insight: 'Fastest exit saved $200 vs profit-lock waiting for a reversal that never came' },
  chop: { insight: "Bracket's structured take-profit captured gains that trailing strategies gave back" }
};

const SCENARIOS = {
  win:  { file: '/demo-data/win.json' },
  lose: { file: '/demo-data/lose.json' },
  chop: { file: '/demo-data/chop.json' }
};

const SC_KEYS = ['win','lose','chop'];
let active = null;
let stratVisible = [true,true,true,true,true];
let _lastSc = null;

function fmtExit(r) {
  return { eod:'EOD exit', trailing_stop:'Trailing stop', hard_stop:'Hard stop',
           expiry:'Expiry', profit_target:'Profit target', break_even_stop:'Break-even stop' }[r] || r;
}
function fmtTime(ts) { return ts.slice(11,16); }
function fmtDate(ts) { const [y,m,d] = ts.slice(0,10).split('-'); return m+'/'+d+'/'+y.slice(2); }

// ── Canvas helpers ────────────────────────────────────────────────────────────
function paintCanvas(id, msg) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth || 700;
  const H = parseInt(canvas.getAttribute('height') || 148);
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#0B0E11';
  ctx.fillRect(0, 0, W, H);
  if (msg) {
    ctx.fillStyle = '#5A6270';
    ctx.font = '13px "JetBrains Mono",monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(msg, W / 2, H / 2);
  }
}

function showLoading() {
  document.getElementById('stratToggles').innerHTML = '';
  document.getElementById('stratTable').innerHTML = '';
  document.getElementById('contractMeta').innerHTML = '';
  paintCanvas('demoChart', 'Loading…');
  paintCanvas('underlyingChart', '');
}

// ── Scenario fetch ────────────────────────────────────────────────────────────
function setScenario(key) {
  if (key === active) return;
  active = key;
  stratVisible = [true,true,true,true,true];
  SC_KEYS.forEach(k => document.getElementById('sc_'+k).classList.toggle('active', k===key));
  showLoading();

  const cfg = SCENARIOS[key];
  fetch(cfg.file)
  .then(r => r.json())
  .then(data => {
    if (key !== active) return;

    const bars    = data.bars;
    const ubBars  = data.underlyingBars || [];
    const byId    = {};
    (data.strategies || []).forEach(s => { byId[s.id] = s; });
    const strategies = DEMO_STRAT_IDS.map(id => byId[id]).filter(Boolean);

    if (!bars.length) { paintCanvas('demoChart', 'No option bars found'); return; }

    _lastSc = { occ:data.occ, expiry:data.expiry, bars, ubBars, strategies };
    renderMeta(_lastSc, key);
    buildToggles(_lastSc);
    drawChart(_lastSc);
    drawUnderlyingChart(_lastSc);
    renderTable(_lastSc);
  })
  .catch(() => paintCanvas('demoChart', 'Load failed'));
}

// ── Toggle buttons ────────────────────────────────────────────────────────────
function buildToggles(sc) {
  document.getElementById('stratToggles').innerHTML = sc.strategies.map((s, i) => {
    const c = STRAT_COLORS[i];
    return `<button class="strat-toggle active" data-idx="${i}"
      style="border-color:${c};background:${c};color:var(--ink)"
      onclick="toggleStrat(${i})">${s.name}</button>`;
  }).join('');
}

function toggleStrat(idx) {
  stratVisible[idx] = !stratVisible[idx];
  const btn = document.querySelector(`.strat-toggle[data-idx="${idx}"]`);
  if (btn) {
    const c = STRAT_COLORS[idx];
    btn.style.background  = stratVisible[idx] ? c : 'transparent';
    btn.style.color       = stratVisible[idx] ? 'var(--ink)' : c;
  }
  if (_lastSc) drawChart(_lastSc);
}

// ── Meta bar ──────────────────────────────────────────────────────────────────
function renderMeta(sc, key) {
  const s0 = sc.strategies[0];
  const typeLabel = {C:'Call',P:'Put'}[sc.occ.slice(-9,-8)] || '';
  document.getElementById('contractMeta').innerHTML =
    `<span class="meta-occ">${sc.occ}</span>` +
    `<span class="meta-sep">&middot;</span>` +
    `<span>${typeLabel} &middot; exp ${fmtDate(sc.expiry)}</span>` +
    (s0 ? `<span class="meta-sep">&middot;</span><span>entry $${s0.entryPrice.toFixed(2)}</span>` : '');
}

// ── Option price chart ────────────────────────────────────────────────────────
function drawChart(sc) {
  const canvas = document.getElementById('demoChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth || 700;
  const H = 268;
  canvas.width = W*dpr; canvas.height = H*dpr;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  ctx.scale(dpr, dpr);

  const P = {t:14,r:14,b:30,l:58};
  const CW = W-P.l-P.r, CH = H-P.t-P.b;
  const bars = sc.bars, N = bars.length;
  if (!N) return;

  const bt = {};
  bars.forEach((b,i) => { bt[b.time] = i; });

  let pMin = bars.reduce((m,b) => Math.min(m,b.close), Infinity);
  let pMax = bars.reduce((m,b) => Math.max(m,b.close), -Infinity);
  sc.strategies.forEach((s,si) => {
    if (!stratVisible[si]) return;
    (s.stopTrace||[]).forEach(pt => {
      if (bt[pt.time]!==undefined) { pMin=Math.min(pMin,pt.stopPrice); pMax=Math.max(pMax,pt.stopPrice); }
    });
  });
  const pr = pMax-pMin || 1;
  pMin -= pr*.06; pMax += pr*.06;

  const tx = i => P.l + i/Math.max(N-1,1)*CW;
  const ty = p => P.t + (1-(p-pMin)/(pMax-pMin))*CH;

  ctx.fillStyle='#0B0E11'; ctx.fillRect(0,0,W,H);

  ctx.font='11px "JetBrains Mono",monospace';
  for (let g=0; g<=4; g++) {
    const p = pMin+(1-g/4)*(pMax-pMin), y = ty(p);
    ctx.strokeStyle='rgba(255,255,255,0.04)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(P.l,y); ctx.lineTo(P.l+CW,y); ctx.stroke();
    ctx.fillStyle='#8B94A0'; ctx.textAlign='right';
    ctx.fillText('$'+(p<2?p.toFixed(2):p.toFixed(0)), P.l-5, y+4);
  }

  ctx.font='9.5px "JetBrains Mono",monospace'; ctx.fillStyle='#5A6270';
  ['09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30'].forEach(h => {
    const idx = bars.findIndex(b => b.time.slice(11,16)>=h);
    if (idx<0) return;
    ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(tx(idx),P.t); ctx.lineTo(tx(idx),P.t+CH); ctx.stroke();
    if (['09:30','10:00','11:00','12:00','13:00','14:00','15:00'].includes(h)) {
      ctx.textAlign='center'; ctx.fillText(h, tx(idx), P.t+CH+20);
    }
  });

  sc.strategies.forEach((s,si) => {
    if (!stratVisible[si]) return;
    const pts = (s.stopTrace||[]).map(pt=>({xi:bt[pt.time],y:pt.stopPrice})).filter(p=>p.xi!==undefined);
    if (pts.length<2) return;
    ctx.strokeStyle=STRAT_COLORS[si]; ctx.lineWidth=2; ctx.globalAlpha=0.82;
    ctx.beginPath();
    pts.forEach((pt,j) => { j===0?ctx.moveTo(tx(pt.xi),ty(pt.y)):ctx.lineTo(tx(pt.xi),ty(pt.y)); });
    ctx.stroke();
    const last=pts[pts.length-1];
    ctx.globalAlpha=1; ctx.fillStyle=STRAT_COLORS[si];
    ctx.beginPath(); ctx.arc(tx(last.xi), ty(last.y)+(si-2)*6, 4, 0, Math.PI*2); ctx.fill();
  });
  ctx.globalAlpha=1;

  const grad = ctx.createLinearGradient(0,P.t,0,P.t+CH);
  grad.addColorStop(0,'rgba(255,255,255,0.07)'); grad.addColorStop(1,'rgba(255,255,255,0)');
  ctx.beginPath();
  bars.forEach((b,i) => { i===0?ctx.moveTo(tx(i),ty(b.close)):ctx.lineTo(tx(i),ty(b.close)); });
  ctx.lineTo(tx(N-1),P.t+CH); ctx.lineTo(tx(0),P.t+CH); ctx.closePath();
  ctx.fillStyle=grad; ctx.fill();

  ctx.strokeStyle='rgba(255,255,255,0.92)'; ctx.lineWidth=2;
  ctx.beginPath();
  bars.forEach((b,i) => { i===0?ctx.moveTo(tx(i),ty(b.close)):ctx.lineTo(tx(i),ty(b.close)); });
  ctx.stroke();

  const s0=sc.strategies[0];
  if (s0) {
    const ei=bt[s0.entryTs]??0, ep=bars[ei]?.close??bars[0].close;
    ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(tx(ei),ty(ep),5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#0B0E11'; ctx.beginPath(); ctx.arc(tx(ei),ty(ep),2,0,Math.PI*2); ctx.fill();
  }
}

// ── Underlying (SPY) chart ──────────────────────────────────────────────────
function drawUnderlyingChart(sc) {
  const canvas = document.getElementById('underlyingChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth || 700;
  const H = 148;
  canvas.width = W*dpr; canvas.height = H*dpr;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  ctx.scale(dpr, dpr);

  const bars = sc.ubBars, N = bars ? bars.length : 0;
  const P = {t:10,r:14,b:28,l:58};
  const CW = W-P.l-P.r, CH = H-P.t-P.b;

  ctx.fillStyle='#0B0E11'; ctx.fillRect(0,0,W,H);

  if (!N) {
    ctx.fillStyle='#5A6270'; ctx.font='12px "JetBrains Mono",monospace';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('Underlying data unavailable', W/2, H/2);
    return;
  }

  let pMin = bars.reduce((m,b)=>Math.min(m,b.close),Infinity);
  let pMax = bars.reduce((m,b)=>Math.max(m,b.close),-Infinity);
  const pr = pMax-pMin||1; pMin-=pr*.08; pMax+=pr*.08;

  const tx = i => P.l+i/Math.max(N-1,1)*CW;
  const ty = p => P.t+(1-(p-pMin)/(pMax-pMin))*CH;

  ctx.font='11px "JetBrains Mono",monospace';
  for (let g=0; g<=3; g++) {
    const p=pMin+(1-g/3)*(pMax-pMin), y=ty(p);
    ctx.strokeStyle='rgba(255,255,255,0.04)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(P.l,y); ctx.lineTo(P.l+CW,y); ctx.stroke();
    ctx.fillStyle='#8B94A0'; ctx.textAlign='right';
    ctx.fillText('$'+p.toFixed(0), P.l-5, y+4);
  }

  ctx.font='9.5px "JetBrains Mono",monospace'; ctx.fillStyle='#5A6270';
  ['09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30'].forEach(h => {
    const idx = bars.findIndex(b=>b.time.slice(11,16)>=h);
    if (idx<0) return;
    ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(tx(idx),P.t); ctx.lineTo(tx(idx),P.t+CH); ctx.stroke();
    if (['09:30','10:00','11:00','12:00','13:00','14:00','15:00'].includes(h)) {
      ctx.textAlign='center'; ctx.fillText(h, tx(idx), P.t+CH+18);
    }
  });

  const grad=ctx.createLinearGradient(0,P.t,0,P.t+CH);
  grad.addColorStop(0,'rgba(99,179,237,0.13)'); grad.addColorStop(1,'rgba(99,179,237,0)');
  ctx.beginPath();
  bars.forEach((b,i) => { i===0?ctx.moveTo(tx(i),ty(b.close)):ctx.lineTo(tx(i),ty(b.close)); });
  ctx.lineTo(tx(N-1),P.t+CH); ctx.lineTo(tx(0),P.t+CH); ctx.closePath();
  ctx.fillStyle=grad; ctx.fill();

  ctx.strokeStyle='rgba(147,197,253,0.88)'; ctx.lineWidth=1.6;
  ctx.beginPath();
  bars.forEach((b,i) => { i===0?ctx.moveTo(tx(i),ty(b.close)):ctx.lineTo(tx(i),ty(b.close)); });
  ctx.stroke();

  const s0=sc.strategies[0];
  if (s0) {
    const ei=bars.findIndex(b=>b.time.slice(0,16)>=s0.entryTs.slice(0,16));
    if (ei>=0) {
      ctx.strokeStyle='rgba(255,255,255,0.22)'; ctx.lineWidth=1; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(tx(ei),P.t); ctx.lineTo(tx(ei),P.t+CH); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

// ── Strategy table ────────────────────────────────────────────────────────────
function renderTable(sc) {
  const bestPnl = Math.max(...sc.strategies.map(s=>s.pnl));
  const exitMap = {eod:'eod',trailing_stop:'trailing_stop',hard_stop:'hard_stop',
                   profit_target:'profit_target',break_even_stop:'break_even_stop'};
  document.getElementById('stratTable').innerHTML = sc.strategies.map((s,i) => {
    const pos=s.pnl>0, neg=s.pnl<0;
    const pnlStr=(pos?'+':neg?'−':'')+'$'+Math.abs(s.pnl).toFixed(0);
    return `<div class="strat-row${s.pnl===bestPnl?' best':''}">
      <div class="stop-head">
        <span class="sdot" style="background:${STRAT_COLORS[i]}"></span>
        <span class="sname">${s.name}</span>
      </div>
      <div class="sdesc">${STRAT_DESCS[s.id]||''}</div>
      <div class="sright">
        <span class="spnl ${pos?'pos':neg?'neg':'zero'}">${pnlStr}</span>
        <span class="sexit-badge ${exitMap[s.exitReason]||'eod'}">${fmtExit(s.exitReason)}</span>
      </div>
    </div>`;
  }).join('');
}

// ── Init ──────────────────────────────────────────────────────────────────────
paintCanvas('demoChart','');
paintCanvas('underlyingChart','');
setScenario('win');

window.addEventListener('resize', () => {
  if (_lastSc) { drawChart(_lastSc); drawUnderlyingChart(_lastSc); }
});
