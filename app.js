(() => {
  const MAX_SPORES = 20;
  // µm per ruler unit at each magnification, as read from the user's calibrated ruler.
  const MICRONS_PER_UNIT = { '400': 2.5, '1000': 1.0 };
  const SPORE_STEPS = [
    'tap one end of its length',
    'tap the other end of its length',
    'tap one edge of its width',
    'tap the opposite edge of its width',
  ];

  const $ = (id) => document.getElementById(id);
  const canvas = $('view');
  const ctx = canvas.getContext('2d');
  const magSelect = $('mag');
  const umInput = $('umPerUnit');
  const unitsInput = $('unitsSpan');

  // points: image-pixel coordinates in tap order.
  // Points 0-1 are the two ruler taps. After that, every spore takes four points:
  // its length (two ends), then its width (two edges).
  const state = {
    img: null,
    points: [],
    view: { s: 1, x: 0, y: 0 },
    fitScale: 1,
    pointers: new Map(),
    tap: null,
    pinch: null,
  };

  // ---------- helpers ----------

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
  // Sample standard deviation; needs at least two values.
  const sd = (xs) => {
    if (xs.length < 2) return null;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1));
  };
  const fmtStat = (xs, digits, unit) => {
    if (!xs.length) return '–';
    const s = sd(xs);
    const sdText = s === null ? '' : `  (SD ${s.toFixed(digits)})`;
    return `${mean(xs).toFixed(digits)}${unit}${sdText}`;
  };

  function micronsPerUnit() {
    const v = parseFloat(umInput.value);
    return v > 0 ? v : null;
  }

  function unitsSpan() {
    const v = parseFloat(unitsInput.value);
    return v > 0 ? v : null;
  }

  // Micrometres per photo pixel, or null until the ruler is calibrated.
  function scale() {
    const p = state.points;
    const um = micronsPerUnit();
    const units = unitsSpan();
    if (p.length < 2 || !um || !units) return null;
    return (units * um) / dist(p[0], p[1]);
  }

  // Completed spores as { length, width, q } in micrometres.
  function spores() {
    const s = scale();
    const out = [];
    if (!s) return out;
    const p = state.points;
    for (let i = 2; i + 3 < p.length; i += 4) {
      const length = dist(p[i], p[i + 1]) * s;
      const width = dist(p[i + 2], p[i + 3]) * s;
      out.push({ length, width, q: length / width });
    }
    return out;
  }

  // ---------- layout and drawing ----------

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function fitPhoto() {
    if (!state.img) return;
    const { w, h } = sizeCanvas();
    const s = Math.min(w / state.img.width, h / state.img.height);
    state.fitScale = s;
    state.view = {
      s,
      x: (w - state.img.width * s) / 2,
      y: (h - state.img.height * s) / 2,
    };
    draw();
  }

  function toScreen(p) {
    return { x: p.x * state.view.s + state.view.x, y: p.y * state.view.s + state.view.y };
  }

  function drawLine(a, b, color, label) {
    const A = toScreen(a);
    const B = toScreen(b);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
    ctx.stroke();
    for (const P of [A, B]) {
      ctx.beginPath();
      ctx.arc(P.x, P.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    if (label) {
      const mx = (A.x + B.x) / 2;
      const my = (A.y + B.y) / 2;
      ctx.font = '600 14px -apple-system, Helvetica, Arial, sans-serif';
      const tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(mx - tw / 2, my - 22, tw, 20);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, my - 12);
    }
  }

  function draw() {
    const { w, h } = sizeCanvas();
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);
    $('empty').classList.toggle('hidden', !!state.img);
    if (!state.img) return;

    const v = state.view;
    ctx.drawImage(state.img, v.x, v.y, state.img.width * v.s, state.img.height * v.s);

    const p = state.points;
    if (p.length >= 2) drawLine(p[0], p[1], '#ffb020', 'ruler');
    for (let i = 2, n = 1; i < p.length; i += 4, n++) {
      if (i + 1 < p.length) drawLine(p[i], p[i + 1], '#3a9cff', String(n));
      if (i + 3 < p.length) drawLine(p[i + 2], p[i + 3], '#38d46a', null);
    }

    // A point waiting for its partner is shown as a white dot.
    if (p.length % 2 === 1) {
      const last = toScreen(p[p.length - 1]);
      ctx.beginPath();
      ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
  }

  // ---------- results ----------

  function renderTable(list) {
    const wrap = $('spores');
    wrap.replaceChildren();
    if (!list.length) return;

    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const label of ['Spore', 'Length (µm)', 'Width (µm)', 'Q']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.appendChild(th);
    }
    const body = table.createTBody();
    list.forEach((s, i) => {
      const row = body.insertRow();
      for (const text of [String(i + 1), s.length.toFixed(1), s.width.toFixed(1), s.q.toFixed(2)]) {
        row.insertCell().textContent = text;
      }
    });
    const avg = body.insertRow();
    avg.className = 'avg';
    for (const text of [
      'Average',
      mean(list.map((s) => s.length)).toFixed(1),
      mean(list.map((s) => s.width)).toFixed(1),
      mean(list.map((s) => s.q)).toFixed(2),
    ]) {
      avg.insertCell().textContent = text;
    }
    wrap.appendChild(table);
  }

  function updateResults() {
    const list = spores();
    $('count').textContent = `${list.length} of ${MAX_SPORES}`;
    $('avgLen').textContent = list.length ? fmtStat(list.map((s) => s.length), 1, ' µm') : '–';
    $('avgWidth').textContent = list.length ? fmtStat(list.map((s) => s.width), 1, ' µm') : '–';
    $('avgQ').textContent = list.length ? fmtStat(list.map((s) => s.q), 2, '') : '–';
    renderTable(list);
  }

  function stepText() {
    const n = state.points.length;
    if (!state.img) return 'Take or choose a photo to begin.';
    if (!micronsPerUnit()) return 'Enter the µm per ruler unit for your magnification.';
    if (!unitsSpan()) return 'Enter how many ruler units your two calibration taps span.';
    if (n < 2) return 'Step 1: tap two ruler marks, then type how many units apart they are.';
    const spore = Math.floor((n - 2) / 4) + 1;
    if (spore > MAX_SPORES) return `Done: ${MAX_SPORES} spores measured. Copy the table or start over.`;
    return `Spore ${spore} of ${MAX_SPORES}: ${SPORE_STEPS[(n - 2) % 4]}.`;
  }

  function updateText() {
    $('step').textContent = stepText();
    $('undo').disabled = state.points.length === 0;
    $('clear').disabled = state.points.length === 0;
    $('copyStatus').textContent = '';
  }

  function update() {
    draw();
    updateText();
    updateResults();
  }

  // ---------- photo loading ----------

  function loadFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      state.img = img;
      state.points = [];
      fitPhoto();
      update();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      $('step').textContent = 'That file could not be opened. Try another photo.';
    };
    img.src = url;
  }

  $('camera').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  $('library').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });

  // ---------- calibration inputs ----------

  magSelect.addEventListener('change', () => {
    if (MICRONS_PER_UNIT[magSelect.value]) umInput.value = MICRONS_PER_UNIT[magSelect.value];
    update();
  });
  umInput.addEventListener('input', update);
  unitsInput.addEventListener('input', update);

  // ---------- buttons ----------

  $('undo').addEventListener('click', () => { state.points.pop(); update(); });
  $('clear').addEventListener('click', () => { state.points = []; update(); });
  $('fit').addEventListener('click', () => { resetTouch(); fitPhoto(); });

  $('copy').addEventListener('click', async () => {
    const list = spores();
    if (!list.length) {
      $('copyStatus').textContent = 'No spores to copy yet.';
      return;
    }
    const lines = ['Spore\tLength (µm)\tWidth (µm)\tQ'];
    list.forEach((s, i) => lines.push(`${i + 1}\t${s.length.toFixed(1)}\t${s.width.toFixed(1)}\t${s.q.toFixed(2)}`));
    lines.push(`Average\t${mean(list.map((s) => s.length)).toFixed(1)}\t${mean(list.map((s) => s.width)).toFixed(1)}\t${mean(list.map((s) => s.q)).toFixed(2)}`);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      $('copyStatus').textContent = 'Copied.';
    } catch (_) {
      $('copyStatus').textContent = 'Could not copy. Select the table and copy it instead.';
    }
  });

  // ---------- touch: tap to place, drag and pinch to move/zoom ----------

  // Forget every finger we are tracking, so a missed lift can't skew the next pinch.
  function resetTouch() {
    state.pointers.clear();
    state.pinch = null;
    state.tap = null;
  }

  function localPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function addPointAt(screenPos) {
    if (state.points.length >= 2 + 4 * MAX_SPORES) return;
    const v = state.view;
    const img = {
      x: (screenPos.x - v.x) / v.s,
      y: (screenPos.y - v.y) / v.s,
    };
    // Ignore taps outside the photo.
    if (img.x < 0 || img.y < 0 || img.x > state.img.width || img.y > state.img.height) return;
    state.points.push(img);
    update();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.img) return;
    const pos = localPos(e);
    state.pointers.set(e.pointerId, pos);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* not needed for a tap */ }

    if (state.pointers.size === 1) {
      state.tap = { x: pos.x, y: pos.y, moved: false, multi: false };
    } else {
      state.tap.multi = true;
      state.tap.moved = true;
      const [a, b] = [...state.pointers.values()];
      state.pinch = { dist: dist(a, b), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state.pointers.has(e.pointerId) || !state.img) return;
    const prev = state.pointers.get(e.pointerId);
    const pos = localPos(e);
    state.pointers.set(e.pointerId, pos);

    if (state.pointers.size === 1) {
      if (dist(pos, state.tap) > 8) state.tap.moved = true;
      if (state.tap.moved) {
        state.view.x += pos.x - prev.x;
        state.view.y += pos.y - prev.y;
        draw();
      }
    } else if (state.pinch) {
      const [a, b] = [...state.pointers.values()];
      const d = dist(a, b);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const v = state.view;
      // Keep the photo point under the previous midpoint anchored under the new one.
      const ax = (state.pinch.mid.x - v.x) / v.s;
      const ay = (state.pinch.mid.y - v.y) / v.s;
      const s = clamp(v.s * (d / state.pinch.dist), state.fitScale, state.fitScale * 10);
      state.view = { s, x: mid.x - ax * s, y: mid.y - ay * s };
      state.pinch = { dist: d, mid };
      draw();
    }
    e.preventDefault();
  });

  function endPointer(e) {
    if (!state.pointers.has(e.pointerId)) return;
    const wasSingle = state.pointers.size === 1;
    state.pointers.delete(e.pointerId);
    if (wasSingle && state.tap && !state.tap.moved && !state.tap.multi && e.type === 'pointerup') {
      addPointAt(state.tap);
    }
    if (state.pointers.size < 2) state.pinch = null;
    if (state.pointers.size === 1) {
      // Leftover finger after a pinch: do not treat it as a tap later.
      const [only] = [...state.pointers.values()];
      state.tap = { x: only.x, y: only.y, moved: true, multi: true };
    }
    if (state.pointers.size === 0) state.tap = null;
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', resetTouch);

  // Keep the layout right if the phone rotates or the window resizes.
  window.addEventListener('resize', () => {
    if (state.img) fitPhoto();
  });

  update();
})();
