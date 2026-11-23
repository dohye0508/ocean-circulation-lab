(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const Q = new URLSearchParams(location.search);
  const canvas = $('scene');
  let sim;
  try { sim = new OceanSim(canvas); } catch (e) {
    $('unsupported').hidden = false;
    $('unsupported').textContent = '이 브라우저에서는 실행할 수 없습니다. 최신 Chrome이나 Edge에서 열어 주세요.';
    return;
  }
  const cam = new OrbitCamera();
  cam.zoomF = 0.84;
  const T_TANK = 20, LOG_AT = 240, rho = OceanSim.seaRho;
  // 자동 실험에서 차례로 돌리는 조건
  const SWEEP = { temp: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 25, 30], salt: [0, 2, 5, 10, 15, 20, 30, 40, 50, 60, 80, 100] };
  const state = { exp: 'temp', color: 2, playing: false, speed: 5, stats: null, vmax: 0.3,
    wallAt: null, bottomAt: null, logged: false, logs: { temp: [], salt: [] }, batch: null, auto: false,
    recView: 'graph', xAxis: 'cond' };
  window.lab = { sim, cam, state, redraw: () => drawLog(), foam: () => foam.map(f => [+f.x.toFixed(1), +f.z.toFixed(1)]) };

  // 컵에서 나오는 물이 수조 물(20 °C 맹물)보다 얼마나 무거운가 (kg/m³, 실제 바닷물 밀도식)
  const drhoOf = (exp, v) => exp === 'temp' ? rho(v, 0) - rho(T_TANK, 0) : rho(T_TANK, v) - rho(T_TANK, 0);
  const condVal = () => state.exp === 'temp' ? sim.params.Tcup : sim.params.Ssalt;
  const drho = () => drhoOf(state.exp, condVal());
  const signed = (v, d = 1) => (v > 0.05 ? '+' : v < -0.05 ? '−' : '') + Math.abs(v).toFixed(d);
  const condLabel = (exp, v) => exp === 'temp' ? v + ' °C' : v + ' psu';

  function sync() {
    const p = sim.params;
    $('tcup').value = p.Tcup; $('salinity').value = p.Ssalt;
    $('condOut').textContent = state.exp === 'temp' ? p.Tcup + ' °C' + (p.Tcup <= 2 ? ' 얼음물' : '') : p.Ssalt + ' psu';
    p.ice = p.Tcup <= 2 ? 1 : 0;
    document.querySelectorAll('[data-for]').forEach(el => { el.hidden = el.dataset.for !== state.exp; });
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.exp === state.exp));
    $('logCond').textContent = state.exp === 'temp' ? '컵 속 물' : '염분';
    // 세 번째 색 보기 칸: 수온 실험은 수온, 염분 실험은 염분
    const pb = $('propBtn'); pb.textContent = state.exp === 'temp' ? '수온' : '염분'; pb.dataset.mode = state.exp === 'temp' ? 1 : 4;
    if (state.color === 1 || state.color === 4) state.color = +pb.dataset.mode;
    setColor(state.color);
    showResults(); drawLog();
  }
  function selectExp(exp) {
    if (state.auto) stopAuto();
    state.exp = exp;
    Object.assign(sim.params, { mode: exp === 'temp' ? 0 : 1, T0: T_TANK, pos: 4, Tcup: 1, Ssalt: 50 });
    sync(); restart();
  }
  // 수면에 띄운 스티로폼 조각 6개 (교과서 유의점: 물의 이동을 볼 수 있도록 스티로폼 조각을 띄운다)
  const FOAM0 = [[10, 5], [15, 14], [20, 7], [24, 13], [27, 4], [12, 10]];
  let foam = [], foamT = 0;
  const foamBuf = new Float32Array(32);
  function resetFoam() { foam = FOAM0.map(([x, z], i) => ({ x, z, a: i * 0.9 })); foamT = 0; }
  function moveFoam() {
    const dt = sim.time - foamT; foamT = sim.time; if (dt <= 0 || dt > 2) return;
    for (const f of foam) {
      const [u, w] = sim.surfaceVel(f.x, f.z);
      f.x = Math.max(1.2, Math.min(28.8, f.x + u * dt)); f.z = Math.max(1, Math.min(19, f.z + w * dt));
      // 컵에 닿으면 밀려난다
      const cx = sim.params.pos, dx = f.x - cx, dz = f.z - 10, d = Math.hypot(dx, dz);
      if (d < 4) { f.x = cx + dx / (d || 1) * 4; f.z = 10 + dz / (d || 1) * 4; }
    }
  }
  function restart() {
    resetFoam();
    sim.reset(); state.stats = null; state.wallAt = null; state.bottomAt = null; state.logged = false; acc = 0;
    sim.ripple(sim.params.pos, 10, 2.5, 0.25);
    showResults(); drawLog();
  }
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => selectExp(b.dataset.exp)));
  $('tcup').addEventListener('input', e => { sim.params.Tcup = +e.target.value; sync(); restart(); });
  $('salinity').addEventListener('input', e => { sim.params.Ssalt = +e.target.value; sync(); restart(); });
  $('reset').addEventListener('click', restart);
  $('clearLog').addEventListener('click', () => { state.logs[state.exp] = []; drawLog(); });
  function setPlaying(on) {
    state.playing = on;
    $('playIcon').innerHTML = on ? '<rect class="fill" x="6.5" y="5" width="4" height="14" rx="1"/><rect class="fill" x="13.5" y="5" width="4" height="14" rx="1"/>' : '<path class="fill" d="M8 5.5v13l11-6.5z"/>';
    $('play').setAttribute('aria-label', on ? '멈춤' : '재생'); $('play').title = on ? '멈춤 (스페이스바)' : '재생 (스페이스바)';
    showResults();
  }
  $('play').addEventListener('click', () => { if (state.auto) stopAuto(); setPlaying(!state.playing); });
  addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); if (state.auto) stopAuto(); setPlaying(!state.playing); } });

  // 색으로 보기: 0 끔, 2 밀도, 1 수온, 4 염분, 3 흐름. 척도는 모두 고정.
  const spdMax = () => state.exp === 'temp' ? 4 : 10;
  const densMax = () => state.exp === 'temp' ? 1.5 : 8;
  const MID = (Math.sqrt(13) - 1) / 12; // 눌러 담은 척도에서 가운데 색의 위치
  function legendText() {
    const m = state.color; if (!m) return;
    const L = m === 1 ? ['0 °C', '12.5 °C', '25 °C']
      : m === 4 ? ['0 psu', +(35 * MID).toFixed(1) + ' psu', '35 psu']
      : m === 3 ? ['느림 0', spdMax() / 4 + ' cm/s', '빠름 ' + spdMax() + ' cm/s']
      : ['수조 물 0', '+' + +(densMax() * MID).toFixed(2) + ' kg/m³', '+' + densMax() + ' kg/m³'];
    $('lgLo').textContent = L[0]; $('lgMid').textContent = L[1]; $('lgHi').textContent = L[2];
  }
  function setColor(m) {
    state.color = m;
    document.querySelectorAll('#colorMode button').forEach(b => b.classList.toggle('on', +b.dataset.mode === m));
    $('legend').classList.toggle('off', m === 0);
    legendText();
  }
  document.querySelectorAll('#colorMode button').forEach(b => b.addEventListener('click', () => setColor(+b.dataset.mode)));

  // 결과: 종속 변인은 가라앉는지 여부와 바닥을 따라 퍼지는 빠르기
  const sank = s => s && s.depth != null && s.depth >= 15;
  const motion = s => sank(s) ? '가라앉음' : s.time < 20 ? '…' : drho() < -0.05 ? '위로 퍼짐' : '제자리';
  // 퍼지는 속도: 바닥에 닿은 뒤 반대편 벽까지 바닥을 따라 나아간 평균 빠르기 (cm/s)
  function speedNow(s) {
    if (!sank(s) || state.bottomAt == null) return 0;
    if (state.wallAt != null) return s.wallDist / Math.max(0.5, state.wallAt - state.bottomAt);
    return Math.min(s.far, s.wallDist) / Math.max(0.5, s.time - state.bottomAt);
  }
  function showResults() {
    const s = state.stats;
    $('rDrho').textContent = signed(drho(), 2) + ' kg/m³';
    if (!s) { for (const id of ['rSank', 'rWall']) $(id).textContent = '—'; return; }
    $('rSank').textContent = motion(s);
    $('rWall').textContent = state.wallAt != null ? Math.round(state.wallAt) + '초' : sank(s) ? Math.min(s.far, s.wallDist).toFixed(0) + ' cm 퍼짐' : '—';
  }

  // 실험 기록: 실행마다 점 하나
  function record() {
    const s = state.stats; if (!s || state.logged) return;
    state.logged = true;
    const list = state.logs[state.exp], v = condVal();
    const i = list.findIndex(r => r.v === v); if (i >= 0) list.splice(i, 1);
    list.push({ v, drho: drho(), speed: state.wallAt != null ? speedNow(s) : 0, partial: sank(s) && state.wallAt == null, wall: state.wallAt });
    drawLog();
  }
  function drawLog() {
    const s = state.stats, live = s && !state.logged ? { live: true, v: condVal(), drho: drho(), speed: speedNow(s), wall: null } : null;
    const rows = state.logs[state.exp].slice().reverse();
    if (live) rows.unshift(live);
    $('logBody').innerHTML = rows.slice(0, 7).map(r => '<tr' + (r.live ? ' class="live"' : '') + '><td>' + (r.live ? '<span class="rec"></span>' : '') + condLabel(state.exp, r.v) +
      '</td><td>' + signed(r.drho, 2) + '</td><td>' + (r.live ? '…' : r.wall != null ? Math.round(r.wall) + '초' : '못 감') +
      '</td><td>' + r.speed.toFixed(2) + ' cm/s</td></tr>').join('') || '<tr><td colspan="4">재생하면 여기에 기록됩니다.</td></tr>';
    drawGraph(live);
  }

  // 추세선: log(속도)를 log(밀도 차)의 2차식으로 맞춘다. 약한 흐름은 점성과 섞임 때문에 더 가파르게 느려지고,
  // 강한 흐름은 컵 구멍에서 나오는 양이 정해져 있어 덜 빨라지므로 곡선이 휘어질 수 있어야 한다.
  function powerFit(pts) {
    const P = pts.filter(p => p.drho > 0.05 && p.speed > 0.01 && !p.partial);
    if (P.length < 3) return null;
    const X = P.map(p => Math.log(p.drho)), Y = P.map(p => Math.log(p.speed)), n = P.length;
    const deg = n >= 5 ? 2 : 1, m = deg + 1;
    const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
    for (let i = 0; i < n; i++) for (let r = 0; r < m; r++) { for (let c = 0; c < m; c++) A[r][c] += X[i] ** (r + c); A[r][m] += Y[i] * X[i] ** r; }
    for (let c = 0; c < m; c++) { let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = 0; r < m; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]; } }
    const k = A.map((row, i) => row[m] / row[i]);
    const lo = Math.min(...X), hi = Math.max(...X);
    return { at: dr => { const x = Math.log(dr); return Math.exp(k.reduce((s, c, i) => s + c * x ** i, 0)); }, lo: Math.exp(lo), hi: Math.exp(hi), n };
  }
  const COL = { temp: '#2f64c8', salt: '#c8402a' };
  function drawGraph(live) {
    const W = 380, H = 236, L = 44, R = 12, T = 12, B = 38, gw = W - L - R, gh = H - T - B;
    const byRho = state.xAxis === 'rho';
    const exps = byRho ? ['temp', 'salt'] : [state.exp];
    const pts = exps.flatMap(e => state.logs[e].map(r => ({ ...r, e })));
    if (live && (!byRho || live.drho > 0.05)) pts.push({ ...live, e: state.exp });
    // 축: 조건별은 슬라이더 범위, 밀도 차는 로그 눈금. 세로축은 실험마다 고정.
    const xr = byRho ? [0.1, 100] : state.exp === 'temp' ? [0, 30] : [0, 100];
    const ymax = byRho ? 2.5 : state.exp === 'temp' ? 1 : 2.5;
    const xOf = byRho ? v => L + gw * (Math.log10(Math.max(v, xr[0])) - Math.log10(xr[0])) / (Math.log10(xr[1]) - Math.log10(xr[0]))
      : v => L + gw * (v - xr[0]) / (xr[1] - xr[0]);
    const yOf = v => T + gh * (1 - Math.min(v, ymax) / ymax);
    let g = '';
    const xt = byRho ? [0.1, 0.3, 1, 3, 10, 30, 100] : state.exp === 'temp' ? [0, 5, 10, 15, 20, 25, 30] : [0, 20, 40, 60, 80, 100];
    const yt = [0, ymax / 2, ymax];
    for (const v of yt) g += `<line x1="${L}" x2="${W - R}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="#e6ebee"/><text x="${L - 6}" y="${yOf(v) + 4}" text-anchor="end">${v}</text>`;
    for (const v of xt) g += `<line x1="${xOf(v)}" x2="${xOf(v)}" y1="${T + gh}" y2="${T + gh + 4}" stroke="#9aa6ae"/><text x="${xOf(v)}" y="${T + gh + 16}" text-anchor="middle">${v}</text>`;
    g += `<line x1="${L}" x2="${W - R}" y1="${T + gh}" y2="${T + gh}" stroke="#9aa6ae"/><line x1="${L}" x2="${L}" y1="${T}" y2="${T + gh}" stroke="#9aa6ae"/>`;
    if (!byRho && state.exp === 'temp') g += `<line x1="${xOf(20)}" x2="${xOf(20)}" y1="${T}" y2="${T + gh}" stroke="#b8c2c8" stroke-dasharray="3 3"/><text x="${xOf(20) + 4}" y="${T + 12}">수조 물 20 °C</text>`;
    const xl = byRho ? '수조 물과의 밀도 차 (kg/m³, 로그 눈금)' : state.exp === 'temp' ? '컵 속 물의 온도 (°C)' : '소금물의 염분 (psu)';
    g += `<text class="ttl" x="${L + gw / 2}" y="${H - 4}" text-anchor="middle">${xl}</text>`;
    g += `<text class="ttl" transform="translate(12 ${T + gh / 2}) rotate(-90)" text-anchor="middle">퍼지는 속도 (cm/s)</text>`;
    // 추세선
    const fit = powerFit(pts.filter(p => !p.live));
    if (fit) {
      let d = '';
      for (let i = 0; i <= 120; i++) {
        const x = byRho ? Math.pow(10, Math.log10(xr[0]) + (Math.log10(xr[1]) - Math.log10(xr[0])) * i / 120) : xr[0] + (xr[1] - xr[0]) * i / 120;
        const dr = byRho ? x : drhoOf(state.exp, x);
        // 측정한 범위 안에서만 곡선을 그린다 (범위 밖으로 늘이지 않음)
        if (dr > 0.05 && (dr < fit.lo * 0.97 || dr > fit.hi * 1.03)) { d += ''; continue; }
        const y = dr > 0.05 ? fit.at(dr) : 0;
        d += (d ? 'L' : 'M') + xOf(x).toFixed(1) + ' ' + yOf(y).toFixed(1);
      }
      g += `<path d="${d}" fill="none" stroke="#33434f" stroke-width="1.6" stroke-dasharray="5 4"/>`;
    }
    for (const p of pts) {
      const x = xOf(byRho ? p.drho : p.v), y = yOf(p.speed), c = COL[p.e];
      g += p.live ? `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${c}" stroke-width="2"/>`
        : `<circle cx="${x}" cy="${y}" r="4.5" fill="${c}" stroke="#fff" stroke-width="1"/>`;
    }
    if (byRho) g += `<circle cx="${L + 10}" cy="${T + 8}" r="4" fill="${COL.temp}"/><text x="${L + 18}" y="${T + 12}">수온 실험</text><circle cx="${L + 82}" cy="${T + 8}" r="4" fill="${COL.salt}"/><text x="${L + 90}" y="${T + 12}">염분 실험</text>`;
    $('graph').innerHTML = g;
    window.lab.fit = fit;
  }
  document.querySelectorAll('#recView button').forEach(b => b.addEventListener('click', () => {
    state.recView = b.dataset.v;
    document.querySelectorAll('#recView button').forEach(x => x.classList.toggle('on', x === b));
    $('graphView').hidden = state.recView !== 'graph'; $('tableView').hidden = state.recView !== 'table';
  }));
  document.querySelectorAll('#axisSwitch button').forEach(b => b.addEventListener('click', () => {
    state.xAxis = b.dataset.x;
    document.querySelectorAll('#axisSwitch button').forEach(x => x.classList.toggle('on', x === b));
    drawLog();
  }));

  // 여러 조건 자동 실험: 조건을 하나씩 바꿔 가며 끝까지 빠르게 돌리고 점을 찍는다.
  function startAuto() {
    setPlaying(false);
    state.auto = true; state.batch = SWEEP[state.exp].slice();
    $('autoRun').classList.add('running');
    applyCond(state.batch[0]);
  }
  function stopAuto() {
    state.auto = false; state.batch = null;
    $('autoRun').classList.remove('running'); $('autoRun').textContent = '여러 조건 자동 실험';
  }
  $('autoRun').addEventListener('click', () => state.auto ? stopAuto() : startAuto());
  // 재생 속도: 누를 때마다 1× → 2× → 5× → 10× → 20×
  const SPEEDS = [1, 2, 5, 10, 20];
  $('speedBtn').addEventListener('click', () => {
    state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
    $('speedBtn').textContent = state.speed + '×';
  });
  // 실험 기록 접기/펼치기
  $('recToggle').addEventListener('click', () => {
    const f = $('record').classList.toggle('folded');
    $('recToggle').textContent = f ? '‹' : '›';
    $('recToggle').title = f ? '펼치기' : '접기';
  });

  // 수조 돌려 보기
  let drag = null;
  // 수면을 누르고 끌면 잔물결이 생기고, 수면 밖을 끌면 수조가 돌아간다.
  let lastCam = null;
  function surfaceAt(e) {
    if (!lastCam) return null;
    const r = canvas.getBoundingClientRect(), c = lastCam;
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1 - c.shift[0], ny = (1 - (e.clientY - r.top) / r.height) * 2 - 1 - c.shift[1];
    const d = [0, 1, 2].map(k => c.fwd[k] + nx * c.tan * c.aspect * c.right[k] + ny * c.tan * c.up[k]);
    if (d[1] >= 0) return null;
    const t = (20 - c.pos[1]) / d[1], x = c.pos[0] + d[0] * t, z = c.pos[2] + d[2] * t;
    if (x < 0 || x > 30 || z < 0 || z > 20) return null;
    if (Math.hypot(x - sim.params.pos, z - 10) < 3) return null; // 컵 안쪽은 제외
    return [x, z];
  }
  canvas.addEventListener('pointerdown', e => {
    const hit = surfaceAt(e);
    drag = { x: e.clientX, y: e.clientY, water: !!hit, last: hit };
    if (hit) sim.ripple(hit[0], hit[1], 1.0, 0.15);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    if (drag.water) {
      const hit = surfaceAt(e);
      if (hit) {
        // 지나간 길을 0.7 cm 간격으로 메워 물결이 끊기지 않게 한다
        const a = drag.last || hit, n = Math.min(20, Math.ceil(Math.hypot(hit[0] - a[0], hit[1] - a[1]) / 0.7));
        for (let i = 1; i <= Math.max(1, n); i++) { const t = i / Math.max(1, n); sim.ripple(a[0] + (hit[0] - a[0]) * t, a[1] + (hit[1] - a[1]) * t, 1.0, 0.15 / Math.sqrt(Math.max(1, n))); }
      }
      drag.last = hit;
    }
    else cam.rotate(e.clientX - drag.x, e.clientY - drag.y);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', e => { e.preventDefault(); cam.zoomF = Math.min(2.5, Math.max(0.5, cam.zoomF * Math.exp(e.deltaY * 0.001))); }, { passive: false });

  // 화면 모양: port 폰·패드 세로 좁은 화면, land 폰 가로, desk 그 밖
  function layout() { return innerWidth <= 900 ? (innerHeight >= innerWidth ? 'port' : 'land') : 'desk'; }
  function resize() { const d = Math.min(devicePixelRatio || 1, 1.5); canvas.width = Math.round(canvas.clientWidth * d); canvas.height = Math.round(canvas.clientHeight * d); }
  addEventListener('resize', resize);
  function camera() {
    const W = canvas.clientWidth, H = canvas.clientHeight, lay = layout();
    const bare = Q.get('bare') === '1';
    const folded = $('record').classList.contains('folded');
    // 화면 모양에 따라 수조가 보일 자리: 폰 세로는 위쪽, 폰 가로·패드·데스크탑은 패널 오른쪽
    const panelW = bare ? 0 : lay === 'land' ? 280 : lay === 'port' ? 0 : 340;
    const left = panelW, right = bare || lay === 'port' || folded ? 20 : 460;
    const top = lay === 'port' ? 16 : 40, bottom = bare ? 40 : lay === 'port' ? document.querySelector('.panel').offsetHeight + 10 : lay === 'land' ? 16 : 40;
    const visW = W - left - right, visH = H - top - bottom, tan = Math.tan(cam.fov / 2), aspect = W / H;
    const need = Math.max(25 / (tan * aspect * (visW / W) * 0.92), 16 / (tan * (visH / H) * 0.92));
    const saved = cam.dist; cam.dist = Math.max(need, 30) * cam.zoomF * (lay === 'desk' ? 1 : 1.18);
    const c = cam.compute(canvas.width, canvas.height, [(left - right) / W, (bottom - top) / H]);
    cam.dist = saved; return c;
  }
  function render() {
    const m = state.color, c = camera(); lastCam = c;
    foam.forEach((f, i) => foamBuf.set([f.x, f.z, f.a, 1], i * 4));
    sim.render(c, { foam: foamBuf, mode: m, slice: false, arrows: true, vmax: state.vmax, densMax: densMax(), spdMax: spdMax(), inkK: m ? 0.15 : 0.75 });
  }

  let last = 0, acc = 0, lastStats = 0, target = Q.has('t') ? +Q.get('t') : null;
  function frame(now) {
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0; last = now;
    let steps = 0;
    if (state.batch && state.batch.length) {
      // 여러 조건을 차례로 끝까지 돌려 기록을 채운다.
      while (!state.logged && steps < 40) { sim.step(); steps++; if (steps % 10 === 0) collect(); }
      if (state.auto) $('autoRun').textContent = '자동 실험 중 ' + (SWEEP[state.exp].length - state.batch.length + 1) + '/' + SWEEP[state.exp].length + ' · 멈추기';
      if (now - lastStats > 250) { lastStats = now; showResults(); drawLog(); }
      if (state.logged) {
        state.batch.shift();
        if (state.batch.length) applyCond(state.batch[0]);
        else if (state.auto) { stopAuto(); window.lab.autoDone = true; }
      }
    } else if (target != null) {
      while (sim.time < target && steps < 30) { sim.step(); steps++; if (steps % 10 === 0) collect(); }
      if (sim.time >= target) { target = null; collect(); window.lab.ready = true; }
      showResults(); drawLog();
    } else if (state.playing) {
      acc += dt * state.speed;
      while (acc >= OceanSim.grid.DT && steps < 40) { sim.step(); acc -= OceanSim.grid.DT; steps++; }
      if (steps === 40) acc = 0;
      if (now - lastStats > 250) { collect(); lastStats = now; showResults(); drawLog(); }
    }
    $('progress').style.width = Math.min(100, sim.time / LOG_AT * 100) + '%';
    const sec = Math.floor(sim.time); $('clock').textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    render();
    requestAnimationFrame(frame);
  }
  function collect() {
    const s = sim.stats(); state.stats = s; window.lab.stats = s;
    moveFoam();
    if (state.bottomAt == null && s.depth != null && s.depth >= 19) state.bottomAt = s.time;
    if (state.wallAt == null && sank(s) && s.far >= s.wallDist) { state.wallAt = s.time; record(); }
    if (s.time >= LOG_AT) record();
    state.vmax = state.vmax * 0.7 + Math.max(0.1, s.vmax * 0.8) * 0.3;
  }
  function applyCond(v) {
    if (state.exp === 'temp') sim.params.Tcup = v; else sim.params.Ssalt = v;
    sync(); restart();
  }

  selectExp(Q.get('exp') === 'salt' ? 'salt' : 'temp');
  if (Q.has('Tc')) sim.params.Tcup = +Q.get('Tc');
  if (Q.has('S')) sim.params.Ssalt = +Q.get('S');
  if (Q.has('Tc') || Q.has('S')) { sync(); restart(); }
  if (Q.get('cam') === 'front') cam.set('front');
  if (Q.has('yaw')) cam.yaw = +Q.get('yaw');
  if (Q.has('zoom')) cam.zoomF = +Q.get('zoom');
  if (Q.has('pitch')) cam.pitch = +Q.get('pitch');
  if (Q.get('play') === '1') setPlaying(true);
  setColor(Q.has('color') ? +Q.get('color') : 2);
  sync();
  // ?batch=1,10,20 : 앞의 조건들을 먼저 끝까지 돌려 기록한 뒤, 마지막에 원래 조건을 t초까지 보여 준다.
  if (Q.has('batch')) {
    const keep = condVal();
    state.batch = Q.get('batch').split(',').map(Number);
    if (state.batch.length) applyCond(state.batch[0]);
    const origFrame = target; target = null;
    const wait = setInterval(() => { if (!state.batch.length) { clearInterval(wait); applyCond(keep); state.batch = null; target = origFrame; } }, 50);
  }
  // ?auto=1 : 자동 실험을 바로 시작한다 (검증용)
  if (Q.has('sweep')) SWEEP[state.exp] = Q.get('sweep').split(',').map(Number);
  if (Q.get('auto') === '1') startAuto();
  if (Q.get('xaxis') === 'rho') document.querySelector('#axisSwitch button[data-x="rho"]').click();
  if (Q.get('bare') === '1') document.querySelector('.panel').style.display = 'none';
  // 좁은 화면(패드 가로 포함)에서는 실험 기록을 처음에 접어 둔다
  if (innerWidth < 1280 && !Q.has('record')) { $('record').style.transition = 'none'; requestAnimationFrame(() => requestAnimationFrame(() => { $('record').style.transition = ''; })); $('record').classList.add('folded'); $('recToggle').textContent = '‹'; $('recToggle').title = '펼치기'; }
  resize();
  requestAnimationFrame(frame);
})();
