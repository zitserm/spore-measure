(() => {
  // µm per tick at each magnification, from the user's stage micrometer.
  const MICRONS_PER_TICK = { '100': 10, '400': 2.5, '1000': 1.0 };

  const $ = (id) => document.getElementById(id);
  const canvas = $('view');
  const ctx = canvas.getContext('2d');
  const magSelect = $('mag');
  const umInput = $('umPerTick');
  const ticksInput = $('ticks');

  // ruler: two taps in full-resolution photo pixels.
  // spores: results from the server, each with a contour in full-resolution pixels.
  // excluded: ids of spores the user has tapped out.
  const state = {
    img: null,
    photoFile: null,
    ruler: [],
    spores: [],
    excluded: new Set(),
    fixMode: false,
    fixing: null,   // { anchor, pts } while the user is fixing one spore
    fixes: [],      // { anchor, lengthPx, widthPx } in photo pixels, kept across re-measures
    view: { s: 1, x: 0, y: 0 },
    fitScale: 1,
    pointers: new Map(),
    tap: null,
    pinch: null,
    busy: false,
  };

  // ---------- helpers ----------

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
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

  function micronsPerTick() {
    const v = parseFloat(umInput.value);
    return v > 0 ? v : null;
  }

  function ticksBetween() {
    const v = parseFloat(ticksInput.value);
    return v > 0 ? v : null;
  }

  // µm per full-resolution pixel, from the ruler taps and tick count (same as the server).
  function umPerFullPx() {
    const ticks = ticksBetween();
    const um = micronsPerTick();
    if (!ticks || !um || state.ruler.length < 2) return null;
    const rulerPx = dist(state.ruler[0], state.ruler[1]);
    return rulerPx > 0 ? (ticks * um) / rulerPx : null;
  }

  // Put the user's manual sizes onto the measured spores. A fix is matched to the spore
  // that contains its tap, so it survives re-measuring. Spores without a fix get their
  // automatic values back.
  function applyFixes() {
    const k = umPerFullPx();
    for (const spore of state.spores) {
      const fix = state.fixes.find((f) => insideContour(spore.contour, f.anchor.x, f.anchor.y));
      if (fix && k) {
        spore.length = fix.lengthPx * k;
        spore.width = fix.widthPx * k;
        spore.q = spore.width > 0 ? spore.length / spore.width : null;
        spore.manual = true;
      } else if (spore.auto) {
        spore.length = spore.auto.length;
        spore.width = spore.auto.width;
        spore.q = spore.auto.q;
        spore.manual = false;
      }
    }
  }

  function includedSpores() {
    return state.spores.filter((s) => !state.excluded.has(s.id));
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

  function contourPath(contour) {
    const path = new Path2D();
    contour.forEach(([x, y], i) => {
      const p = toScreen({ x, y });
      if (i === 0) path.moveTo(p.x, p.y);
      else path.lineTo(p.x, p.y);
    });
    path.closePath();
    return path;
  }

  function drawRuler() {
    const r = state.ruler;
    if (r.length === 0) return;
    const A = toScreen(r[0]);
    const B = r.length > 1 ? toScreen(r[1]) : null;
    ctx.strokeStyle = '#ffb020';
    ctx.lineWidth = 2;
    if (B) {
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.stroke();
    }
    for (const P of B ? [A, B] : [A]) {
      ctx.beginPath();
      ctx.arc(P.x, P.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffb020';
      ctx.fill();
    }
  }

  function drawSpores() {
    state.spores.forEach((spore) => {
      const out = state.excluded.has(spore.id);
      const color = out ? '#888' : (spore.flag ? '#ff5a5a' : '#38d46a');
      const path = contourPath(spore.contour);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.setLineDash(out ? [6, 4] : []);
      ctx.stroke(path);
      ctx.setLineDash([]);
      // Number label at the first contour point.
      const p = toScreen({ x: spore.contour[0][0], y: spore.contour[0][1] });
      ctx.font = '600 13px -apple-system, Helvetica, Arial, sans-serif';
      const text = String(spore.id);
      const tw = ctx.measureText(text).width + 8;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(p.x - tw / 2, p.y - 20, tw, 18);
      ctx.fillStyle = out ? '#bbb' : '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, p.x, p.y - 11);
    });
  }

  // Points placed so far while fixing a spore.
  // The length and width points of every saved fix (cyan), and of the fix in progress (white).
  // Only shown in fix mode.
  function drawPoints(list, color) {
    const pts = list.map(toScreen);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawFixing() {
    if (!state.fixMode) return;
    for (const fix of state.fixes) {
      if (fix.pts) drawPoints(fix.pts, '#38d4ff');
    }
    if (state.fixing) drawPoints(state.fixing.pts, '#fff');
  }

  function draw() {
    const { w, h } = sizeCanvas();
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);
    $('empty').classList.toggle('hidden', !!state.img);
    if (!state.img) return;

    const v = state.view;
    ctx.drawImage(state.img, v.x, v.y, state.img.width * v.s, state.img.height * v.s);
    drawRuler();
    drawSpores();
    drawFixing();
  }

  function stepText() {
    if (!state.img) return 'Take or choose a photo to begin.';
    if (!micronsPerTick()) return 'Enter the µm per tick for your magnification.';
    if (state.ruler.length < 2) {
      return state.ruler.length === 0
        ? 'Step 3: tap the first ruler tick.'
        : 'Step 3: tap the second ruler tick.';
    }
    if (!ticksBetween()) return 'Enter how many ticks lie between your two taps.';
    if (!state.spores.length) return 'Step 4: tap Measure spores.';
    if (state.fixMode) {
      if (!state.fixing) return 'Fix mode: tap inside the spore you want to re-measure.';
      return [
        'Tap one end of the length.',
        'Tap the other end of the length.',
        'Tap one side of the width.',
        'Tap the other side of the width.',
      ][state.fixing.pts.length];
    }
    return 'Tap a numbered outline to leave that spore out.';
  }

  // ---------- results ----------

  function renderTable() {
    const wrap = $('spores');
    wrap.replaceChildren();
    const list = includedSpores();
    if (!list.length) return;

    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const label of ['Spore', 'Length (µm)', 'Width (µm)', 'Q', 'Note']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.appendChild(th);
    }
    const body = table.createTBody();
    list.forEach((s) => {
      const row = body.insertRow();
      for (const text of [
        String(s.id),
        s.length.toFixed(1),
        s.width.toFixed(1),
        s.q === null ? '–' : s.q.toFixed(2),
        s.manual ? 'manual size' : (s.flag || ''),
      ]) {
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
      '',
    ]) {
      avg.insertCell().textContent = text;
    }
    wrap.appendChild(table);
  }

  function updateResults() {
    const list = includedSpores();
    $('count').textContent = `${list.length} of ${state.spores.length}`;
    $('avgLen').textContent = list.length ? fmtStat(list.map((s) => s.length), 1, ' µm') : '–';
    $('avgWidth').textContent = list.length ? fmtStat(list.map((s) => s.width), 1, ' µm') : '–';
    $('avgQ').textContent = list.length ? fmtStat(list.map((s) => s.q), 2, '') : '–';
    renderTable();
  }

  function update() {
    draw();
    $('step').textContent = stepText();
    $('undo').disabled = state.ruler.length === 0 || state.busy;
    $('measure').disabled = state.busy || !state.img || state.ruler.length < 2 || !ticksBetween() || !micronsPerTick();
    $('measure').textContent = state.busy ? 'Measuring…' : 'Measure spores';
    $('fixMode').disabled = state.busy || !state.spores.length;
    $('save').disabled = state.busy || !state.spores.length;
    $('clearFixes').disabled = state.busy || !state.fixes.length;
    $('undoFix').disabled = state.busy || !state.fixing;
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
      state.photoFile = file;
      state.ruler = [];
      state.spores = [];
      state.excluded = new Set();
      state.fixes = [];
      state.fixing = null;
      state.fixMode = false;
      $('fixMode').textContent = "Fix a spore's size: off";
      $('fixMode').setAttribute('aria-pressed', 'false');
      $('measureStatus').textContent = '';
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
    if (MICRONS_PER_TICK[magSelect.value]) umInput.value = MICRONS_PER_TICK[magSelect.value];
    update();
  });
  umInput.addEventListener('input', update);
  ticksInput.addEventListener('input', update);

  // ---------- buttons ----------

  $('undo').addEventListener('click', () => {
    state.ruler.pop();
    state.spores = [];
    state.excluded = new Set();
    $('measureStatus').textContent = '';
    update();
  });
  $('fit').addEventListener('click', () => { resetTouch(); fitPhoto(); });

  async function measure() {
    if (!state.photoFile || state.ruler.length < 2) return;
    state.busy = true;
    $('measureStatus').textContent = 'Finding and measuring spores. This can take several seconds.';
    update();
    const form = new FormData();
    form.append('image', state.photoFile, state.photoFile.name || 'photo.jpg');
    form.append('ruler', JSON.stringify(state.ruler.map((p) => [p.x, p.y])));
    form.append('ticks', String(ticksBetween()));
    form.append('um_per_tick', String(micronsPerTick()));
    try {
      const res = await fetch('/measure', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
      state.spores = data.spores;
      state.spores.forEach((s) => { s.auto = { length: s.length, width: s.width, q: s.q }; });
      applyFixes();
      $('measureStatus').textContent = data.spores.length
        ? `Found ${data.spores.length} spores.`
        : 'No spores found. Try a sharper photo, or check the ruler taps.';
    } catch (err) {
      $('measureStatus').textContent = `Could not measure: ${err.message}. Is the Mac server running?`;
    } finally {
      state.busy = false;
      update();
    }
  }

  $('measure').addEventListener('click', measure);

  $('fixMode').addEventListener('click', () => {
    state.fixMode = !state.fixMode;
    state.fixing = null;
    $('fixMode').textContent = `Fix a spore's size: ${state.fixMode ? 'on' : 'off'}`;
    $('fixMode').setAttribute('aria-pressed', String(state.fixMode));
    update();
  });

  // Removes the last point of the spore being fixed. With no points left, it cancels the pick.
  $('undoFix').addEventListener('click', () => {
    if (!state.fixing) return;
    if (state.fixing.pts.length) state.fixing.pts.pop();
    else state.fixing = null;
    update();
  });

  $('clearFixes').addEventListener('click', () => {
    state.fixes = [];
    state.fixing = null;
    applyFixes();
    update();
  });

  $('copy').addEventListener('click', async () => {
    const list = includedSpores();
    if (!list.length) {
      $('copyStatus').textContent = 'No spores to copy yet.';
      return;
    }
    const lines = ['Spore\tLength (µm)\tWidth (µm)\tQ'];
    list.forEach((s) => lines.push(`${s.id}\t${s.length.toFixed(1)}\t${s.width.toFixed(1)}\t${s.q === null ? '' : s.q.toFixed(2)}`));
    lines.push(`Average\t${mean(list.map((s) => s.length)).toFixed(1)}\t${mean(list.map((s) => s.width)).toFixed(1)}\t${mean(list.map((s) => s.q)).toFixed(2)}`);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      $('copyStatus').textContent = 'Copied.';
    } catch (_) {
      $('copyStatus').textContent = 'Could not copy. Select the table and copy it instead.';
    }
  });

  // Save the full-size photo with the spore outlines and numbers, as a PNG.
  // Works at the photo's own resolution, whatever the current zoom on screen.
  $('save').addEventListener('click', () => {
    if (!state.img || !state.spores.length) return;
    const W = state.img.width;
    const H = state.img.height;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const g = out.getContext('2d');
    g.drawImage(state.img, 0, 0, W, H);

    const line = Math.max(3, W / 500);
    const font = Math.max(14, W / 60);

    if (state.ruler.length === 2) {
      const [a, b] = state.ruler;
      g.strokeStyle = '#ffb020';
      g.lineWidth = line;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }

    for (const spore of state.spores) {
      if (state.excluded.has(spore.id)) continue;
      const path = new Path2D();
      spore.contour.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
      path.closePath();
      g.lineWidth = line;
      g.strokeStyle = spore.flag ? '#ff5a5a' : '#38d46a';
      g.stroke(path);

      const [x0, y0] = spore.contour[0];
      const text = String(spore.id);
      g.font = `600 ${font}px -apple-system, Helvetica, Arial, sans-serif`;
      const tw = g.measureText(text).width + font * 0.5;
      g.fillStyle = 'rgba(0, 0, 0, 0.7)';
      g.fillRect(x0 - tw / 2, y0 - font * 1.4, tw, font * 1.2);
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, x0, y0 - font * 0.8);
    }

    // Draw the length and width points of each fix, so the manual sizes can be checked.
    for (const fix of state.fixes) {
      const spore = state.spores.find((s) => insideContour(s.contour, fix.anchor.x, fix.anchor.y));
      if (!spore || state.excluded.has(spore.id) || !fix.pts) continue;
      const [p0, p1, p2, p3] = fix.pts;
      g.strokeStyle = '#38d4ff';
      g.lineWidth = line;
      g.beginPath();
      g.moveTo(p0.x, p0.y);
      g.lineTo(p1.x, p1.y);
      g.moveTo(p2.x, p2.y);
      g.lineTo(p3.x, p3.y);
      g.stroke();
    }

    // Over plain http on the home network, iPhone cannot share or download to Photos directly.
    // Show the picture full screen instead; press and hold it to Save Image.
    $('previewImg').src = out.toDataURL('image/png');
    $('preview').classList.remove('hidden');
  });

  $('previewClose').addEventListener('click', () => {
    $('preview').classList.add('hidden');
    $('previewImg').removeAttribute('src');
  });

  // ---------- touch: tap to place or toggle, drag and pinch to move/zoom ----------

  function resetTouch() {
    state.pointers.clear();
    state.pinch = null;
    state.tap = null;
  }

  function localPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Ray-casting point-in-polygon test, in photo pixel coordinates.
  function insideContour(contour, x, y) {
    let inside = false;
    for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
      const [xi, yi] = contour[i];
      const [xj, yj] = contour[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // A tap either toggles a spore outline (after measuring) or places a ruler tap.
  // The spore under a tap, or the nearest one if the tap is just outside its outline.
  // Returns the spore and a point inside it (its centre), or null.
  function pickSpore(img) {
    let best = state.spores.find((s) => insideContour(s.contour, img.x, img.y)) || null;
    if (!best) {
      const tolerance = 0.04 * Math.max(state.img.width, state.img.height);
      let bestDist = tolerance;
      for (const s of state.spores) {
        for (const [x, y] of s.contour) {
          const d = Math.hypot(x - img.x, y - img.y);
          if (d < bestDist) {
            bestDist = d;
            best = s;
          }
        }
      }
    }
    if (!best) return null;
    const xs = best.contour.map((p) => p[0]);
    const ys = best.contour.map((p) => p[1]);
    return { spore: best, anchor: { x: mean(xs), y: mean(ys) } };
  }

  function handleTap(screenPos) {
    if (!state.img || state.busy) return;
    const v = state.view;
    const img = { x: (screenPos.x - v.x) / v.s, y: (screenPos.y - v.y) / v.s };
    if (state.spores.length && state.fixMode) {
      if (!state.fixing) {
        // Pick the spore first; the next four taps measure it.
        const pick = pickSpore(img);
        if (pick) {
          state.fixing = { anchor: pick.anchor, pts: [] };
          $('measureStatus').textContent = `Fixing spore ${pick.spore.id}.`;
        } else {
          $('measureStatus').textContent = 'No spore there. Tap inside a numbered outline.';
        }
        update();
        return;
      }
      state.fixing.pts.push(img);
      if (state.fixing.pts.length === 4) {
        const { anchor, pts } = state.fixing;
        const [a, b, c, d] = pts;
        // The longer pair is the length, the shorter pair is the width.
        const first = dist(a, b);
        const second = dist(c, d);
        const target = state.spores.find((s) => insideContour(s.contour, anchor.x, anchor.y));
        state.fixes = state.fixes.filter((f) => !(target && insideContour(target.contour, f.anchor.x, f.anchor.y)));
        state.fixes.push({ anchor, pts: pts.slice(), lengthPx: Math.max(first, second), widthPx: Math.min(first, second) });
        state.fixing = null;
        applyFixes();
        const done = state.spores.find((s) => target && s.id === target.id);
        if (done && done.manual) {
          $('measureStatus').textContent = `Spore ${done.id} set to ${done.length.toFixed(1)} × ${done.width.toFixed(1)} µm.`;
        }
      }
      update();
      return;
    }
    if (state.spores.length) {
      for (const spore of state.spores) {
        if (insideContour(spore.contour, img.x, img.y)) {
          if (state.excluded.has(spore.id)) state.excluded.delete(spore.id);
          else state.excluded.add(spore.id);
          update();
          return;
        }
      }
      return;
    }
    if (state.ruler.length >= 2) return;
    if (img.x < 0 || img.y < 0 || img.x > state.img.width || img.y > state.img.height) return;
    state.ruler.push(img);
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
      handleTap(state.tap);
    }
    if (state.pointers.size < 2) state.pinch = null;
    if (state.pointers.size === 1) {
      const [only] = [...state.pointers.values()];
      state.tap = { x: only.x, y: only.y, moved: true, multi: true };
    }
    if (state.pointers.size === 0) state.tap = null;
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', resetTouch);

  window.addEventListener('resize', () => {
    if (state.img) fitPhoto();
  });

  update();
})();
