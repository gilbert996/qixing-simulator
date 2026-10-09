(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TAU = Math.PI * 2;
  const STEP = 1 / 240;
  const HISTORY_KEY = 'qixing-ball-lab.history.v1';
  const names = ['第一位', '第二位', '第三位', '第四位', '第五位', '第六位', '第七位'];
  const canvas = $('main-wheel');
  if (!window.QixingPhysics || !window.QixingPhysics.BallDrumPhysics) {
    $('session-message').textContent = '物理引擎未加载，请刷新页面。';
    $('start-button').disabled = true;
    return;
  }
  const drums = Array.from({ length: 7 }, (_, i) => new QixingPhysics.BallDrumPhysics({ count: i === 6 ? 15 : 10 }));
  const results = Array(7).fill(null);
  const started = Array(7).fill(false);
  const soundCounts = Array(7).fill(0);
  const miniCanvases = [];
  const miniButtons = [];
  const resultSlots = [];
  let selected = 0, mode = 'auto', running = false, simTime = 0, accumulator = 0, lastFrame = 0;
  let history = loadHistory(), currentView = 'simulator', pending = [], dirty = true;
  let audioContext = null, soundEnabled = false, lastSound = 0, toastTimer;

  function loadHistory() {
    try {
      const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (!Array.isArray(value)) return [];
      return value.filter((row) => row && Array.isArray(row.numbers) && row.numbers.length === 7 &&
        row.numbers.every((v, i) => Number.isInteger(v) && v >= 0 && v <= (i === 6 ? 14 : 9)) &&
        Number.isFinite(row.timestamp) && Number.isFinite(new Date(row.timestamp).getTime()) && Number.isInteger(row.id) && row.id > 0 &&
        Number.isFinite(row.duration) && ['auto', 'manual'].includes(row.mode)).slice(0, 100);
    } catch { return []; }
  }
  function randomUnit() {
    if (window.crypto && window.crypto.getRandomValues) {
      const buffer = new Uint32Array(1);
      window.crypto.getRandomValues(buffer);
      return buffer[0] / 4294967296;
    }
    return Math.random();
  }
  function propulsion() {
    const base = 7 + Number($('power').value) * 0.08;
    return (base + randomUnit() * 2) * (randomUnit() < 0.5 ? -1 : 1);
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').classList.add('visible');
    toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 2600);
  }
  function setView(view) {
    if (!['simulator', 'history', 'about'].includes(view)) view = 'simulator';
    currentView = view;
    document.body.dataset.view = view;
    document.querySelectorAll('.view').forEach((section) => { section.hidden = section.id !== `view-${view}`; });
    document.querySelectorAll('[data-view]').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    $('page-crumb').textContent = { simulator: '模拟开奖', history: '运行记录', about: '关于装置' }[view];
    if (location.hash !== `#${view}`) window.history.replaceState(null, '', `#${view}`);
    dirty = true;
  }
  function selectDrum(index) {
    selected = index;
    miniButtons.forEach((button, i) => {
      button.classList.toggle('selected', i === selected);
      button.setAttribute('aria-pressed', String(i === selected));
    });
    $('selected-index').textContent = String(index + 1).padStart(2, '0');
    $('selected-name').textContent = names[index];
    $('selected-range').textContent = `${index === 6 ? 15 : 10} 颗号码球 · 0–${index === 6 ? 14 : 9}`;
    canvas.setAttribute('aria-label', `${names[index]}摇奖球仓；逐仓模式下按空格开始摇奖`);
    refreshControls();
    dirty = true;
  }
  function setMode(nextMode) {
    if (running) return;
    mode = nextMode;
    document.querySelectorAll('[data-mode]').forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    document.body.classList.toggle('manual', mode === 'manual');
    $('drag-hint').querySelector('span').textContent = mode === 'manual'
      ? '选中球仓，点击按钮或按空格摇奖' : '选择下方球仓，观察号码球的运动';
    refreshControls();
  }
  function updateParameters() {
    const power = Number($('power').value), friction = Number($('friction').value);
    $('power').style.setProperty('--fill', `${power}%`);
    $('friction').style.setProperty('--fill', `${friction}%`);
    $('power-label').textContent = power < 33 ? '轻柔' : power > 66 ? '强劲' : '标准';
    $('friction-label').textContent = friction < 33 ? '顺滑' : friction > 66 ? '紧实' : '适中';
    const coefficient = 0.05 + friction * 0.003;
    $('friction-detail').textContent = coefficient.toFixed(2);
    if (!running) drums.forEach((drum) => { drum.friction = coefficient; });
  }
  function refreshControls() {
    const busySelected = started[selected] && results[selected] === null;
    const completedSelected = results[selected] !== null;
    $('start-button').disabled = mode === 'auto' ? running : running && (busySelected || completedSelected);
    $('start-button').querySelector('span').textContent = mode === 'auto'
      ? running ? results.every((value) => value !== null) ? '等待球仓停稳…' : '正在模拟开奖…' : '开始模拟开奖'
      : busySelected && running ? '当前球仓摇奖中…'
        : completedSelected && running ? '请选下一个球仓' : `摇出${names[selected]}号码`;
    $('mobile-start-button').disabled = $('start-button').disabled;
    $('mobile-start-button').querySelector('span').textContent = $('start-button').querySelector('span').textContent;
    $('power').disabled = running;
    $('friction').disabled = running;
    $('default-params').disabled = running;
    document.querySelectorAll('[data-mode]').forEach((button) => { button.disabled = running; });
    $('copy-result').disabled = !results.every((value) => value !== null);
    $('engine-status').classList.toggle('running', running);
    $('engine-status').innerHTML = `<span class="status-dot"></span>${running ? '球仓运行中' : '装置就绪'}`;
  }
  function beginRound() {
    running = true; simTime = 0; accumulator = 0; pending = [];
    results.fill(null); started.fill(false); soundCounts.fill(0);
    drums.forEach((drum) => drum.reset());
    updateResult();
    refreshControls();
    dirty = true;
  }
  function launch(index) {
    if (started[index]) return;
    started[index] = true;
    soundCounts[index] = 0;
    drums[index].kick(propulsion());
    miniButtons[index].classList.add('spinning');
    resultSlots[index].classList.add('spinning');
    resultSlots[index].textContent = '·';
    miniButtons[index].querySelector('.mini-value').textContent = '··';
    refreshControls();
  }
  function start() {
    if ($('start-button').disabled) return;
    ensureAudio();
    if (!running) beginRound();
    if (mode === 'auto') {
      pending = drums.map((_, index) => ({ index, time: index * 0.13 }));
      $('session-message').textContent = '充分混合后开闸，等待七颗球自然落下。';
    } else {
      launch(selected);
      $('session-message').textContent = `${names[selected]}正在摇奖，可选择其他球仓继续。`;
    }
  }
  function updateResult() {
    results.forEach((value, index) => {
      resultSlots[index].textContent = value === null ? '–' : String(value);
      resultSlots[index].setAttribute('aria-label', `${names[index]}，${value === null ? '等待出球' : `出球号码 ${value}`}`);
      resultSlots[index].classList.toggle('revealed', value !== null);
      resultSlots[index].classList.toggle('spinning', started[index] && value === null);
      miniButtons[index].classList.toggle('spinning', started[index] && value === null);
      miniButtons[index].querySelector('.mini-value').textContent = value === null ? '–' : String(value);
      miniButtons[index].setAttribute('aria-label', `${names[index]}球仓${value === null ? '' : `，出球号码 ${value}`}`);
    });
    const completed = results.filter((value) => value !== null).length;
    $('result-summary').textContent = running ? `已出球 ${completed} / 7 颗` : completed === 7 ? '七颗号码球，已全部落定。' : '下一组号码，正在等待出发。';
    $('result-timing').textContent = running ? '每颗号码球均由真实物理出口选出。' : '七颗号码球全部落下后，结果自动保存。';
  }
  function completeRound() {
    running = false;
    const row = {
      id: history.reduce((max, record) => Math.max(max, record.id), 0) + 1,
      numbers: [...results], timestamp: Date.now(), duration: Number(simTime.toFixed(2)), mode
    };
    history.unshift(row); history = history.slice(0, 100);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }
    catch { toast('本次结果已生成；当前浏览器无法保存历史。'); }
    updateResult();
    $('session-message').textContent = '本次摇奖完成，开启下一次新的可能。';
    $('result-timing').textContent = `模拟用时 ${row.duration.toFixed(1)} 秒 · 第 ${String(row.id).padStart(3, '0')} 次运行`;
    renderHistory(); refreshControls(); dirty = true;
  }
  function reset() {
    running = false; pending = []; simTime = 0; accumulator = 0;
    results.fill(null); started.fill(false); soundCounts.fill(0);
    drums.forEach((drum) => drum.reset());
    $('session-message').textContent = '装置已重置，准备开始新的摇奖。';
    updateResult(); refreshControls(); updateParameters(); dirty = true;
  }
  function formatNumbers(values) { return `${values.slice(0, 6).join(' ')} + ${values[6]}`; }
  async function copyNumbers(values) {
    const text = formatNumbers(values);
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const input = document.createElement('textarea');
        input.value = text; input.style.cssText = 'position:fixed;top:-1000px';
        document.body.appendChild(input); input.select();
        const success = document.execCommand('copy'); input.remove();
        if (!success) throw new Error('Clipboard unavailable');
      }
      toast(`号码已复制：${text}`);
    } catch { toast(`请手动复制号码：${text}`); }
  }
  function historyRow(record, full) {
    const row = document.createElement('div'); row.className = 'history-row';
    const id = document.createElement('span'); id.className = 'history-id'; id.textContent = `#${String(record.id).padStart(3, '0')}`;
    const numbers = document.createElement('div'); numbers.className = 'history-numbers';
    record.numbers.forEach((value, index) => {
      if (index === 6) { const plus = document.createElement('i'); plus.textContent = '+'; numbers.appendChild(plus); }
      const ball = document.createElement('span'); ball.textContent = String(value); if (index === 6) ball.className = 'back'; numbers.appendChild(ball);
    });
    const tag = document.createElement('span'); tag.className = 'history-mode'; tag.textContent = record.mode === 'manual' ? '逐仓摇奖' : '七仓联动';
    const time = document.createElement('time'); time.className = 'history-time'; time.dateTime = new Date(record.timestamp).toISOString();
    time.textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...(full ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(record.timestamp);
    const copy = document.createElement('button'); copy.className = 'history-copy'; copy.setAttribute('aria-label', `复制第 ${record.id} 次号码`); copy.innerHTML = '<svg><use href="#i-copy"/></svg>'; copy.addEventListener('click', () => copyNumbers(record.numbers));
    row.append(id, numbers, tag, time, copy); return row;
  }
  function renderHistory() {
    $('nav-history-count').textContent = history.length;
    $('recent-count').textContent = history.length;
    $('history-total').textContent = history.length;
    $('export-history').disabled = history.length === 0;
    for (const [id, list] of [['recent-history', history.slice(0, 3)], ['full-history', history]]) {
      const target = $(id); target.replaceChildren();
      if (!list.length) { target.innerHTML = '<div class="empty-history"><svg><use href="#i-history"/></svg>还没有记录，第一场摇奖从这里开始。</div>'; }
      else list.forEach((row) => target.appendChild(historyRow(row, id === 'full-history')));
    }
  }
  function exportHistory() {
    if (!history.length) return;
    const rows = [['次数', '北京时间', '第一位', '第二位', '第三位', '第四位', '第五位', '第六位', '第七位', '模式', '模拟时长（秒）']];
    const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    history.forEach((record) => rows.push([record.id, formatter.format(record.timestamp), ...record.numbers, record.mode === 'manual' ? '逐仓摇奖' : '七仓联动', record.duration]));
    const content = '\ufeff' + rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = '七星彩模拟记录.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); toast('记录已导出。');
  }
  async function ensureAudio() {
    if (!soundEnabled) return;
    try {
      if (!audioContext) { const Audio = window.AudioContext || window.webkitAudioContext; if (!Audio) throw new Error('Unsupported audio'); audioContext = new Audio(); }
      if (audioContext.state === 'suspended') await audioContext.resume();
    } catch { soundEnabled = false; updateSoundButton(); toast('当前浏览器无法开启声音。'); }
  }
  function updateSoundButton() {
    $('sound-toggle').setAttribute('aria-pressed', String(soundEnabled));
    $('sound-toggle').title = soundEnabled ? '关闭碰撞声音' : '开启碰撞声音';
    $('sound-toggle').querySelector('use').setAttribute('href', soundEnabled ? '#i-sound' : '#i-muted');
    $('sound-toggle').querySelector('span').textContent = soundEnabled ? '声音开启' : '声音关闭';
  }
  function collisionSound(strength) {
    if (!soundEnabled || !audioContext || audioContext.state !== 'running') return;
    const time = audioContext.currentTime;
    if (time - lastSound < 0.045) return;
    lastSound = time;
    const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
    oscillator.type = 'triangle'; oscillator.frequency.setValueAtTime(440 + Math.min(1, strength) * 550, time);
    oscillator.frequency.exponentialRampToValueAtTime(170, time + 0.025);
    gain.gain.setValueAtTime(Math.min(0.045, 0.012 + Math.abs(strength) * 0.015), time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.042);
    oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(time); oscillator.stop(time + 0.05);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }

  function circle(ctx, x, y, radius, fill, stroke, width = 1) {
    ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
  }
  function drawBall(ctx, ball, radius, back, large) {
    const x = ball.x * radius, y = ball.y * radius, r = (ball.radius || ball.r || 0.12) * radius;
    const palette = back ? ['#e3bb72', '#ca9157', '#8f6539'] : ['#9bbb78', '#597f50', '#244c37'];
    const gradient = ctx.createRadialGradient(x - r * .35, y - r * .4, r * .08, x + r * .12, y + r * .18, r * 1.3);
    gradient.addColorStop(0, palette[0]); gradient.addColorStop(.55, palette[1]); gradient.addColorStop(1, palette[2]);
    ctx.save(); ctx.shadowColor = '#19352525'; ctx.shadowBlur = large ? 2 : .3; ctx.shadowOffsetY = large ? 1.5 : .3;
    circle(ctx, x, y, r, gradient, back ? '#9e74443d' : '#365a3e3d', .4); ctx.restore();
    if (large || r > 3) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(ball.angle || 0);
      circle(ctx, r * .04, r * .05, r * .58, '#fffdf1e8');
      ctx.fillStyle = back ? '#855a2e' : '#365135';
      ctx.font = `600 ${r * (ball.number > 9 ? .77 : .90)}px "Segoe UI",sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(ball.number), r * .04, r * .10); ctx.restore();
    }
    ctx.beginPath(); ctx.arc(x - r * .12, y - r * .1, r * .79, Math.PI * 1.15, Math.PI * 1.58); ctx.strokeStyle = '#ffffff55'; ctx.lineWidth = Math.max(.5, r * .07); ctx.stroke();
  }
  function drawDrum(target, drum, back, large) {
    const rect = target.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
    if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
    const ctx = target.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
    const scale = rect.width / 356, radius = 108 * scale, centerX = rect.width / 2, centerY = 139 * scale;
    ctx.save(); ctx.translate(centerX, centerY);
    // The tube and rotor are drawn from the same geometry as the solver.
    const tubeHalf = drum.outletHalfWidth || drum.gateHalfWidth || .18;
    const tubeBottom = drum.tubeBottom || drum.tubeFloor || 1.60;
    if (large) {
      const shadow = ctx.createRadialGradient(0, radius * 1.75, 0, 0, radius * 1.75, radius * .9);
      shadow.addColorStop(0, '#41583e20'); shadow.addColorStop(1, '#41583e00');
      ctx.save(); ctx.scale(1, .18); circle(ctx, 0, radius * 1.75 / .18, radius * .85, shadow); ctx.restore();
      ctx.strokeStyle = '#c2ccb5'; ctx.lineWidth = radius * .028;
      for (const sign of [-1, 1]) { ctx.beginPath(); ctx.moveTo(sign * radius * .75, radius * .64); ctx.lineTo(sign * radius * .78, radius * 1.68); ctx.lineTo(sign * radius * .48, radius * 1.68); ctx.stroke(); }
      ctx.fillStyle = '#d7dfcd'; ctx.beginPath(); ctx.roundRect(-radius * .9, radius * 1.66, radius * 1.8, radius * .075, radius * .025); ctx.fill();
    }
    // Transparent receiver; selected ball keeps its simulated x/y position.
    ctx.fillStyle = '#e2ebd326'; ctx.strokeStyle = '#a4b79370'; ctx.lineWidth = large ? 1.5 : .55;
    ctx.beginPath(); ctx.roundRect(-tubeHalf * radius, radius * .88, tubeHalf * 2 * radius, (tubeBottom - .88) * radius, radius * .025); ctx.fill(); ctx.stroke();
    const glass = ctx.createRadialGradient(-radius * .3, -radius * .4, radius * .1, 0, 0, radius);
    glass.addColorStop(0, '#fefffca8'); glass.addColorStop(.65, '#edf4e538'); glass.addColorStop(1, '#cfddbd4d');
    circle(ctx, 0, 0, radius, glass);
    // Rotor blades correspond to the actual rotating capsule colliders.
    ctx.save(); ctx.lineCap = 'round';
    const segments = drum.getRotorSegments ? drum.getRotorSegments() : [];
    segments.forEach((segment) => {
      ctx.beginPath(); ctx.moveTo(segment.a.x * radius, segment.a.y * radius); ctx.lineTo(segment.b.x * radius, segment.b.y * radius);
      ctx.strokeStyle = '#9eb18d4a'; ctx.lineWidth = segment.radius * radius * 2; ctx.stroke();
      ctx.strokeStyle = '#f7fbef9c'; ctx.lineWidth = Math.max(.3, segment.radius * radius * .5); ctx.stroke();
    });
    circle(ctx, 0, 0, radius * (drum.hubRadius || .11), '#b6c6a08c', '#eff4e799', .8); ctx.restore();
    drum.balls.forEach((ball) => drawBall(ctx, ball, radius, back, large));
    if (drum.captured && typeof drum.captured === 'object' && !drum.balls.includes(drum.captured)) drawBall(ctx, drum.captured, radius, back, large);
    // The bottom arc is interrupted at the physical outlet, with a visible gate.
    const gap = Math.asin(Math.min(.5, tubeHalf));
    ctx.beginPath(); ctx.arc(0, 0, radius * 1.015, Math.PI / 2 + gap, Math.PI / 2 - gap + TAU);
    ctx.strokeStyle = back ? '#bb9e71' : '#8fa97b'; ctx.lineWidth = large ? 4 * scale : .9; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, radius * 1.042, 0, TAU); ctx.strokeStyle = '#bcc8ad73'; ctx.lineWidth = large ? 1.2 * scale : .35; ctx.stroke();
    if (!drum.gateOpen) {
      ctx.beginPath(); ctx.moveTo(-tubeHalf * radius, radius * .988); ctx.lineTo(tubeHalf * radius, radius * .988);
      ctx.strokeStyle = '#a5b28f'; ctx.lineWidth = Math.max(.8, 4 * scale); ctx.stroke();
    }
    if (large) {
      ctx.beginPath(); ctx.arc(0, 0, radius * .957, Math.PI * 1.05, Math.PI * 1.70); ctx.strokeStyle = '#ffffffc9'; ctx.lineWidth = 3 * scale; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(-radius * .12, -radius * .35, radius * .71, radius * .17, -.6, Math.PI, TAU); ctx.strokeStyle = '#ffffff54'; ctx.lineWidth = 8 * scale; ctx.stroke();
      for (const angle of [-.3, Math.PI + .3]) {
        const x = Math.cos(angle) * radius * 1.036, y = Math.sin(angle) * radius * 1.036;
        circle(ctx, x, y, radius * .032, '#c8b390', '#b49f7a', .5); circle(ctx, x, y, radius * .015, '#eadfc9');
      }
    }
    ctx.restore();
  }
  function updateMeters() {
    const drum = drums[selected];
    $('speed-value').innerHTML = `${Math.abs(drum.rotorVelocity || 0).toFixed(2)} <small>rad/s</small>`;
    $('energy-value').innerHTML = `${drum.count - (drum.captured ? 1 : 0)} <small>颗</small>`;
    $('wheel-state').textContent = results[selected] !== null ? '已出球' : !started[selected] ? '待机' : drum.gateOpen ? '出球中' : '混合中';
    $('collision-value').textContent = `${drums.reduce((total, drum) => total + (drum.impactCount || 0), 0)} 次碰撞`;
  }
  function tick(time) {
    const elapsed = lastFrame ? Math.min((time - lastFrame) / 1000, .1) : 0; lastFrame = time;
    if (running && !document.hidden) {
      accumulator += elapsed;
      while (accumulator + 1e-10 >= STEP) {
        simTime += STEP;
        while (pending.length && pending[0].time <= simTime) launch(pending.shift().index);
        for (let index = 0; index < 7; index++) {
          if (!started[index]) continue;
          const drum = drums[index]; if (!drum.settled) drum.step(STEP);
          if (drum.impactCount > soundCounts[index]) {
            soundCounts[index] = drum.impactCount;
            if (index === selected) collisionSound(drum.lastImpulse || .2);
          }
          if (results[index] === null && drum.getValue() !== null && drum.getValue() !== undefined) {
            results[index] = drum.getValue(); updateResult(); refreshControls();
            if (mode === 'manual') $('session-message').textContent = `${names[index]}出球 ${results[index]}。选择未出球的球仓继续。`;
          }
        }
        accumulator -= STEP;
        if (results.every((value) => value !== null) && drums.every((drum) => drum.settled)) { completeRound(); break; }
      }
      dirty = true;
    }
    if (dirty && currentView === 'simulator') {
      drawDrum(canvas, drums[selected], selected === 6, true);
      miniCanvases.forEach((target, index) => drawDrum(target, drums[index], index === 6, false));
      updateMeters(); dirty = false;
    }
    requestAnimationFrame(tick);
  }

  drums.forEach((drum, index) => {
    const button = document.createElement('button'); button.className = `mini-wheel${index === 0 ? ' selected' : ''}`;
    button.setAttribute('aria-label', `${names[index]}球仓`); button.setAttribute('aria-pressed', String(index === 0));
    button.innerHTML = `<span class="mini-caption">${index === 6 ? '第七位 · 后区' : names[index]}</span><canvas aria-hidden="true"></canvas><span class="mini-value">–</span>`;
    button.addEventListener('click', () => selectDrum(index)); $('wheel-strip').appendChild(button);
    miniButtons.push(button); miniCanvases.push(button.querySelector('canvas'));
    if (index === 6) { const plus = document.createElement('span'); plus.className = 'result-plus'; plus.textContent = '+'; $('result-numbers').appendChild(plus); }
    const slot = document.createElement('span'); slot.className = `result-ball${index === 6 ? ' back' : ''}`; slot.textContent = '–'; slot.setAttribute('aria-label', `${names[index]}，等待出球`); $('result-numbers').appendChild(slot); resultSlots.push(slot);
  });
  $('start-button').addEventListener('click', start);
  $('mobile-start-button').addEventListener('click', start);
  $('reset-button').addEventListener('click', reset);
  $('copy-result').addEventListener('click', () => { if (results.every((value) => value !== null)) copyNumbers(results); });
  $('sound-toggle').addEventListener('click', async () => { soundEnabled = !soundEnabled; updateSoundButton(); await ensureAudio(); });
  $('export-history').addEventListener('click', exportHistory);
  $('power').addEventListener('input', updateParameters); $('friction').addEventListener('input', updateParameters);
  $('default-params').addEventListener('click', () => { $('power').value = '50'; $('friction').value = '50'; updateParameters(); });
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.go)));
  document.querySelector('.brand').addEventListener('click', () => setView('simulator'));
  canvas.addEventListener('keydown', (event) => { if (mode === 'manual' && [' ', 'Enter'].includes(event.key)) { event.preventDefault(); start(); } });
  document.addEventListener('visibilitychange', () => { lastFrame = 0; accumulator = 0; dirty = true; });
  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
  window.addEventListener('resize', () => { dirty = true; });
  if (window.ResizeObserver) new ResizeObserver(() => { dirty = true; }).observe(canvas);
  renderHistory(); updateParameters(); setView(location.hash.slice(1) || 'simulator'); refreshControls();
  requestAnimationFrame(tick);
})();
