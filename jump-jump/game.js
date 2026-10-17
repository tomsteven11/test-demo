(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  常量
   * ------------------------------------------------------------------ */
  const ISO_X = 0.8660254;          // 等距投影：x 轴向右上、z 轴向左上
  const ISO_Y = 0.5;
  const SPEED = 260;                // 蓄力 1 秒 = 跳 260 单位（距离与按压时长成正比）
  const MAX_CHARGE = 1.4;           // 最长蓄力（秒）
  const BLOCK_H = 56;               // 方块侧面高度
  const EDGE_TOL = 11;              // 踩到边缘 11 单位以内：失衡坠落动画
  const GRAVITY = 2400;
  const KEY_BEST = 'jumpjump.best';
  const KEY_MUTE = 'jumpjump.muted';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const easeOutBack = (t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  };

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, val) { try { localStorage.setItem(key, String(val)); } catch (e) { /* 隐私模式等场景忽略 */ } },
  };

  /* ------------------------------------------------------------------ *
   *  DOM
   * ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const el = {
    hud: $('hud'), score: $('score'), combo: $('combo'),
    bestPill: $('best-pill'), bestLive: $('best-live'),
    hint: $('hint'), mute: $('mute'),
    start: $('start'), over: $('over'),
    btnStart: $('btn-start'), btnRestart: $('btn-restart'),
    bestStart: $('best-start'), bestOver: $('best-over'),
    finalScore: $('final-score'), newRecord: $('new-record'),
  };

  /* ------------------------------------------------------------------ *
   *  音效（WebAudio 合成，无外部资源）
   * ------------------------------------------------------------------ */
  const Sound = {
    ctx: null,
    muted: store.get(KEY_MUTE) === '1',
    charge: null,

    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try { this.ctx = new AC(); } catch (e) { return; }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    },
    ready() { return this.ctx && !this.muted; },

    tone(f0, f1, dur, type, vol, delay) {
      if (!this.ready()) return;
      const c = this.ctx, t = c.currentTime + (delay || 0);
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(c.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    },

    chargeStart() {
      if (!this.ready() || this.charge) return;
      const c = this.ctx, osc = c.createOscillator(), g = c.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 180;
      g.gain.value = 0.0001;
      g.gain.exponentialRampToValueAtTime(0.05, c.currentTime + 0.05);
      osc.connect(g).connect(c.destination);
      osc.start();
      this.charge = { osc, g };
    },
    chargeSet(ratio) {
      if (!this.charge) return;
      this.charge.osc.frequency.setTargetAtTime(180 + ratio * 460, this.ctx.currentTime, 0.04);
    },
    chargeStop() {
      if (!this.charge) return;
      const { osc, g } = this.charge, t = this.ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0.0001, t, 0.02);
      osc.stop(t + 0.12);
      this.charge = null;
    },

    jump() { this.tone(320, 760, 0.18, 'sine', 0.12); },
    land(perfect, combo) {
      this.tone(160, 70, 0.14, 'sine', 0.2);
      if (perfect) {
        const base = 523.25 * Math.pow(2, (Math.min(combo, 8) - 1) * 2 / 12);
        this.tone(base, base, 0.22, 'triangle', 0.16, 0.04);
        this.tone(base * 1.5, base * 1.5, 0.28, 'triangle', 0.12, 0.1);
      } else {
        this.tone(440, 440, 0.12, 'triangle', 0.1, 0.03);
      }
    },
    fall() { this.tone(520, 90, 0.7, 'sawtooth', 0.09); },
    setMuted(m) {
      this.muted = m;
      store.set(KEY_MUTE, m ? '1' : '0');
      if (m) this.chargeStop();
    },
  };

  /* ------------------------------------------------------------------ *
   *  视口 / 投影
   * ------------------------------------------------------------------ */
  let W = 0, H = 0, S = 1;
  const cam = { x: 0, y: 0 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S = Math.max(0.5, Math.min(W / 440, H / 780));
  }

  const projX = (x, z) => (x - z) * ISO_X;
  const projY = (x, z) => -(x + z) * ISO_Y;
  function P(x, z, h) {
    return {
      x: W / 2 + (projX(x, z) - cam.x) * S,
      y: H * 0.58 + (projY(x, z) - cam.y - (h || 0)) * S,
    };
  }

  /* ------------------------------------------------------------------ *
   *  游戏状态
   * ------------------------------------------------------------------ */
  const G = {
    state: 'menu',          // menu | ready | charging | jumping | falling | over
    score: 0,
    combo: 0,
    best: parseInt(store.get(KEY_BEST), 10) || 0,
    time: 0,
    lastId: 0,
    bgHue: 205,
    chargeStart: 0,
    charge: 0,
    jumped: false,
    overAt: 0,
  };

  let blocks = [];
  let cur = null;
  let next = null;
  let player = null;
  let jumpInfo = null;
  let fallInfo = null;
  let particles = [];
  let rings = [];
  let floaters = [];
  let sameAxisRun = 0;
  let lastAxis = 0;

  const hsl = (h, s, l, a) => `hsl(${((h % 360) + 360) % 360} ${s}% ${l}% / ${a === undefined ? 1 : a})`;

  function makeBlock(prev) {
    const diff = clamp(G.score / 40, 0, 1);
    const b = {
      id: ++G.lastId,
      shape: Math.random() < 0.62 ? 'box' : 'cyl',
      r: rand(23, 46 - diff * 8),
      hue: 0,
      born: G.time,
      dip: 0, dipV: 0, dipT: 0,
      x: 0, z: 0,
    };
    if (!prev) {
      b.hue = rand(0, 360);
      b.r = 40;
      b.shape = 'box';
      return b;
    }
    b.hue = prev.hue + rand(45, 150);
    const gap = rand(24 + diff * 8, 80 + diff * 62);
    const dist = prev.r + gap + b.r;
    let axis = Math.random() < 0.5 ? 0 : 1;
    if (axis === lastAxis && sameAxisRun >= 3) axis = 1 - axis;
    sameAxisRun = axis === lastAxis ? sameAxisRun + 1 : 1;
    lastAxis = axis;
    b.x = prev.x + (axis === 0 ? dist : 0);
    b.z = prev.z + (axis === 1 ? dist : 0);
    return b;
  }

  function dropOffset(b) {
    const t = clamp((G.time - b.born) / 0.6, 0, 1);
    return 420 * (1 - easeOutBack(t));
  }

  function topHeight(b) { return dropOffset(b) - b.dip; }

  // 点到方块顶面的有符号距离，<=0 表示在顶面内
  function sdist(b, x, z) {
    if (b.shape === 'cyl') return Math.hypot(x - b.x, z - b.z) - b.r;
    const dx = Math.abs(x - b.x) - b.r;
    const dz = Math.abs(z - b.z) - b.r;
    return Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0);
  }

  const perfectRadius = (b) => clamp(b.r * 0.3, 10, 14);

  function spawnNext() {
    next = makeBlock(cur);
    blocks.push(next);
    while (blocks.length > 6) blocks.shift();
  }

  function reset() {
    G.score = 0;
    G.combo = 0;
    G.lastId = 0;
    G.jumped = false;
    G.charge = 0;
    blocks = [];
    particles = [];
    rings = [];
    floaters = [];
    sameAxisRun = 0;
    lastAxis = 0;
    jumpInfo = null;
    fallInfo = null;
    Sound.chargeStop();

    cur = makeBlock(null);
    cur.born = G.time - 0.05;
    blocks.push(cur);
    spawnNext();
    next.born = G.time + 0.18;

    player = { x: cur.x, z: cur.z, h: 320, vh: 0, rot: 0, pivot: 22, sq: 0, sqV: 0, sqT: 0 };
    cam.x = (projX(cur.x, cur.z) + projX(next.x, next.z)) / 2;
    cam.y = (projY(cur.x, cur.z) + projY(next.x, next.z)) / 2;
    setScore(0, false);
    setCombo(0);
  }

  /* ------------------------------------------------------------------ *
   *  界面
   * ------------------------------------------------------------------ */
  function setScore(v, animate) {
    el.score.textContent = v;
    if (animate) {
      el.score.classList.remove('pop');
      void el.score.offsetWidth;
      el.score.classList.add('pop');
    }
  }

  function setCombo(n) {
    if (n >= 2) {
      el.combo.textContent = `连击 ×${n}`;
      el.combo.classList.remove('hidden');
      el.combo.classList.remove('pop');
      void el.combo.offsetWidth;
      el.combo.classList.add('pop');
    } else {
      el.combo.classList.add('hidden');
    }
  }

  function refreshBest() {
    el.bestStart.textContent = G.best;
    el.bestOver.textContent = G.best;
    el.bestLive.textContent = G.best;
  }

  function startGame() {
    if (G.state !== 'menu' && G.state !== 'over') return;
    Sound.unlock();
    if (G.state === 'over') reset();
    G.state = 'ready';
    el.start.classList.add('hidden');
    el.over.classList.add('hidden');
    el.hud.classList.remove('hidden');
    el.bestPill.classList.remove('hidden');
    el.hint.classList.toggle('hidden', G.jumped);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  function gameOver() {
    G.state = 'over';
    G.overAt = performance.now();
    const record = G.score > G.best && G.score > 0;
    if (record) {
      G.best = G.score;
      store.set(KEY_BEST, G.best);
    }
    refreshBest();
    el.finalScore.textContent = G.score;
    el.newRecord.classList.toggle('hidden', !record);
    el.hud.classList.add('hidden');
    el.hint.classList.add('hidden');
    el.over.classList.remove('hidden');
  }

  /* ------------------------------------------------------------------ *
   *  输入：蓄力 / 起跳
   * ------------------------------------------------------------------ */
  function canCharge() {
    return G.state === 'ready' && player.h <= 0.5;
  }

  function pressStart() {
    if (!canCharge()) return;
    Sound.unlock();
    G.state = 'charging';
    G.chargeStart = performance.now();
    G.charge = 0;
    Sound.chargeStart();
  }

  function pressEnd() {
    if (G.state !== 'charging') return;
    const charge = clamp((performance.now() - G.chargeStart) / 1000, 0, MAX_CHARGE);
    Sound.chargeStop();
    beginJump(charge);
  }

  function pressCancel() {
    if (G.state !== 'charging') return;
    Sound.chargeStop();
    G.state = 'ready';
    G.charge = 0;
    cur.dipT = 0;
    player.sqT = 0;
  }

  function beginJump(charge) {
    const dx = next.x - player.x, dz = next.z - player.z;
    const len = Math.hypot(dx, dz) || 1;
    const dist = charge * SPEED;
    const screenDx = dx - dz;
    jumpInfo = {
      sx: player.x, sz: player.z,
      ux: dx / len, uz: dz / len,
      dist,
      T: 0.34 + dist / 700,
      t: 0,
      peak: 46 + dist * 0.2,
      flip: dist > 100,
      sign: screenDx >= 0 ? 1 : -1,
    };
    G.state = 'jumping';
    G.jumped = true;
    el.hint.classList.add('hidden');
    cur.dipT = 0;
    cur.dipV = -60;
    player.sqT = -0.14;
    Sound.jump();
  }

  const stage = $('app');
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    pressStart();
  });
  window.addEventListener('pointerup', pressEnd);
  window.addEventListener('pointercancel', pressCancel);
  window.addEventListener('blur', pressCancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pressCancel(); });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.code !== 'Enter') return;
    e.preventDefault();
    if (e.repeat) return;
    if (G.state === 'menu') startGame();
    else if (G.state === 'over') { if (performance.now() - G.overAt > 600) startGame(); }
    else if (e.code === 'Space') pressStart();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { e.preventDefault(); pressEnd(); }
  });

  el.btnStart.addEventListener('click', startGame);
  el.btnRestart.addEventListener('click', startGame);

  function syncMuteButton() { el.mute.classList.toggle('muted', Sound.muted); }
  el.mute.addEventListener('click', () => {
    Sound.unlock();
    Sound.setMuted(!Sound.muted);
    syncMuteButton();
    el.mute.blur();
  });

  /* ------------------------------------------------------------------ *
   *  落地判定
   * ------------------------------------------------------------------ */
  function land() {
    const q = player;
    q.h = 0;
    q.rot = 0;
    q.pivot = 22;

    const sdNext = sdist(next, q.x, q.z);
    const sdCur = sdist(cur, q.x, q.z);

    if (sdNext <= 0) {
      const dc = Math.hypot(q.x - next.x, q.z - next.z);
      const perfect = dc <= perfectRadius(next);
      let pts = 1;
      if (perfect) { G.combo += 1; pts = 2 * G.combo; } else { G.combo = 0; }
      G.score += pts;
      setScore(G.score, true);
      setCombo(G.combo);

      const target = next;
      target.dipV = 140;
      player.sq = 0.34;
      player.sqV = 0;
      player.sqT = 0;
      burst(q.x, q.z, topHeight(target), target.hue, perfect ? 16 : 9);
      if (perfect) rings.push({ x: target.x, z: target.z, h: topHeight(target), r: 0, t: 0, hue: target.hue });
      floaters.push({ x: q.x, z: q.z, h: 64, t: 0, text: `+${pts}`, size: perfect ? 30 : 24, color: '#2b2d52' });
      if (perfect) {
        floaters.push({
          x: q.x, z: q.z, h: 92, t: 0.08,
          text: G.combo > 1 ? `完美 ×${G.combo}` : '完美',
          size: 17, color: '#ee5a6f',
        });
      }
      Sound.land(perfect, G.combo);

      cur = next;
      spawnNext();
      G.state = 'ready';
      return;
    }

    if (sdCur <= 0) {
      cur.dipV = 90;
      player.sq = 0.28;
      player.sqT = 0;
      Sound.land(false, 0);
      G.state = 'ready';
      return;
    }

    const edgeNext = sdNext <= EDGE_TOL, edgeCur = sdCur <= EDGE_TOL;
    let edgeBlock = null;
    if (edgeNext || edgeCur) edgeBlock = sdNext <= sdCur ? next : cur;

    const toward = (q.x - next.x) * jumpInfo.ux + (q.z - next.z) * jumpInfo.uz;
    let lean = 1;
    if (edgeBlock) {
      const ex = (q.x - edgeBlock.x) - (q.z - edgeBlock.z);
      lean = ex >= 0 ? 1 : -1;
    } else {
      lean = jumpInfo.sign;
    }

    fallInfo = {
      t: 0,
      edge: !!edgeBlock,
      lean,
      behind: toward > 0 ? next : cur,
    };
    player.pivot = edgeBlock ? 0 : 22;
    G.combo = 0;
    setCombo(0);
    G.state = 'falling';
    Sound.fall();
  }

  function burst(x, z, h, hue, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), sp = rand(40, 110);
      particles.push({
        x, z, h: h + 2,
        vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vh: rand(80, 190),
        life: 0, max: rand(0.45, 0.8), size: rand(2.2, 4.2), hue: hue + rand(-12, 12), grav: 520,
      });
    }
  }

  /* ------------------------------------------------------------------ *
   *  更新
   * ------------------------------------------------------------------ */
  function spring(o, key, vKey, target, k, c, dt) {
    o[vKey] += ((target - o[key]) * k - o[vKey] * c) * dt;
    o[key] += o[vKey] * dt;
  }

  function update(dt) {
    G.time += dt;

    for (const b of blocks) spring(b, 'dip', 'dipV', b.dipT, 320, 16, dt);
    spring(player, 'sq', 'sqV', player.sqT, 300, 17, dt);

    switch (G.state) {
      case 'menu':
      case 'ready':
        if (player.h > 0) {
          player.vh -= 1800 * dt;
          player.h += player.vh * dt;
          if (player.h <= 0) {
            player.h = 0;
            player.vh = 0;
            player.sq = 0.3;
            cur.dipV = 120;
            burst(player.x, player.z, 0, cur.hue, 8);
          }
        } else {
          player.sqT = Math.sin(G.time * 2.6) * 0.025;
        }
        break;

      case 'charging': {
        const c = clamp((performance.now() - G.chargeStart) / 1000, 0, MAX_CHARGE);
        G.charge = c;
        const r = c / MAX_CHARGE;
        player.sqT = 0.1 + r * 0.42;
        cur.dipT = 3 + r * 9;
        Sound.chargeSet(r);
        if (Math.random() < 0.7) {
          const a = rand(0, TAU), rad = rand(22, 34);
          particles.push({
            x: player.x + Math.cos(a) * rad, z: player.z + Math.sin(a) * rad, h: topHeight(cur) + rand(0, 14),
            vx: -Math.cos(a) * rad * 2.6, vz: -Math.sin(a) * rad * 2.6, vh: rand(10, 40),
            life: 0, max: 0.38, size: rand(1.8, 3.2), hue: cur.hue, grav: 0,
          });
        }
        break;
      }

      case 'jumping': {
        const j = jumpInfo;
        j.t += dt;
        const u = clamp(j.t / j.T, 0, 1);
        player.x = j.sx + j.ux * j.dist * u;
        player.z = j.sz + j.uz * j.dist * u;
        player.h = 4 * j.peak * u * (1 - u);
        player.rot = j.flip ? j.sign * TAU * easeInOut(u) : 0;
        player.pivot = 22;
        if (u >= 1) land();
        break;
      }

      case 'falling': {
        const f = fallInfo;
        f.t += dt;
        if (f.edge) {
          const tilt = 0.28;
          const k = Math.min(f.t / tilt, 1);
          player.rot = f.lean * (k * k * 1.1 + Math.max(f.t - tilt, 0) * 2.4);
          player.h = f.t < tilt ? 0 : -0.5 * GRAVITY * Math.pow(f.t - tilt, 2);
        } else {
          player.rot = f.lean * f.t * 1.2;
          player.h = -0.5 * GRAVITY * f.t * f.t;
        }
        if (f.t > 0.95) gameOver();
        break;
      }
      default:
        break;
    }

    // 镜头：平滑跟随当前块与下一块的中点
    const tx = (projX(cur.x, cur.z) + projX(next.x, next.z)) / 2;
    const ty = (projY(cur.x, cur.z) + projY(next.x, next.z)) / 2;
    const k = 1 - Math.exp(-dt * 4.5);
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.z += p.vz * dt;
      p.vh -= p.grav * dt;
      p.h += p.vh * dt;
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      rings[i].t += dt;
      rings[i].r = 18 + rings[i].t * 150;
      if (rings[i].t > 0.55) rings.splice(i, 1);
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      floaters[i].t += dt;
      if (floaters[i].t > 1.1) floaters.splice(i, 1);
    }

    const targetHue = 205 + Math.floor(G.score / 6) * 30;
    const diff = ((targetHue - G.bgHue + 540) % 360) - 180;
    G.bgHue += diff * (1 - Math.exp(-dt * 0.8));
  }

  /* ------------------------------------------------------------------ *
   *  渲染
   * ------------------------------------------------------------------ */
  const bubbles = Array.from({ length: 9 }, () => ({
    x: Math.random(), y: Math.random(), r: rand(40, 130), par: rand(0.05, 0.22), a: rand(0.18, 0.4),
  }));

  function drawBackground() {
    const h = G.bgHue;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, hsl(h, 80, 90));
    g.addColorStop(1, hsl(h + 38, 75, 78));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (const b of bubbles) {
      const r = b.r * S;
      const span = W + r * 2;
      let x = (b.x * W - cam.x * b.par * S) % span;
      if (x < 0) x += span;
      let y = (b.y * H + cam.y * b.par * S * 0.6) % (H + r * 2);
      if (y < 0) y += H + r * 2;
      ctx.beginPath();
      ctx.arc(x - r, y - r, r, 0, TAU);
      ctx.fillStyle = `rgba(255,255,255,${b.a * 0.5})`;
      ctx.fill();
    }
  }

  function drawBlock(b) {
    const ht = topHeight(b);
    const down = BLOCK_H * S;
    const topC = hsl(b.hue, 72, 70), leftC = hsl(b.hue, 66, 58), rightC = hsl(b.hue, 62, 47);

    ctx.save();
    ctx.shadowColor = 'rgba(40,40,90,0.22)';
    ctx.shadowBlur = 22 * S;
    ctx.shadowOffsetY = 12 * S;

    if (b.shape === 'box') {
      const r = b.r;
      const A = P(b.x - r, b.z - r, ht);
      const B = P(b.x + r, b.z - r, ht);
      const C = P(b.x + r, b.z + r, ht);
      const D = P(b.x - r, b.z + r, ht);

      ctx.fillStyle = leftC;
      ctx.beginPath();
      ctx.moveTo(D.x, D.y); ctx.lineTo(A.x, A.y); ctx.lineTo(A.x, A.y + down); ctx.lineTo(D.x, D.y + down);
      ctx.closePath(); ctx.fill();

      ctx.fillStyle = rightC;
      ctx.beginPath();
      ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(B.x, B.y + down); ctx.lineTo(A.x, A.y + down);
      ctx.closePath(); ctx.fill();
      ctx.restore();

      ctx.fillStyle = topC;
      ctx.beginPath();
      ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(C.x, C.y); ctx.lineTo(D.x, D.y);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      const c = P(b.x, b.z, ht);
      const rx = b.r * 1.2247 * S, ry = b.r * 0.7071 * S;
      const g = ctx.createLinearGradient(c.x - rx, 0, c.x + rx, 0);
      g.addColorStop(0, leftC);
      g.addColorStop(0.55, leftC);
      g.addColorStop(1, rightC);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(c.x + rx, c.y);
      ctx.ellipse(c.x, c.y + down, rx, ry, 0, 0, Math.PI);
      ctx.lineTo(c.x - rx, c.y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = topC;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, rx, ry, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  function drawRing(r) {
    const c = P(r.x, r.z, r.h);
    const a = 1 - r.t / 0.55;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, r.r * 1.2247 * S, r.r * 0.7071 * S, 0, 0, TAU);
    ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`;
    ctx.lineWidth = 3 * S * a + 0.5;
    ctx.stroke();
  }

  function surfaceUnder(x, z) {
    if (sdist(cur, x, z) <= 0) return cur;
    if (sdist(next, x, z) <= 0) return next;
    return null;
  }

  function drawPlayer() {
    const p = player;
    const standing = G.state === 'menu' || G.state === 'ready' || G.state === 'charging';
    const yoff = standing ? topHeight(cur) : 0;
    const feet = P(p.x, p.z, p.h + yoff);

    if (G.state !== 'falling') {
      const under = surfaceUnder(p.x, p.z);
      if (under) {
        const s = P(p.x, p.z, topHeight(under));
        const k = clamp(1 - p.h / 160, 0.25, 1);
        ctx.beginPath();
        ctx.ellipse(s.x, s.y, 13 * S * k, 7.5 * S * k, 0, 0, TAU);
        ctx.fillStyle = `rgba(30,30,70,${0.26 * k})`;
        ctx.fill();
      }
    }

    ctx.save();
    ctx.translate(feet.x, feet.y);
    ctx.scale(S, S);
    ctx.translate(0, -p.pivot);
    ctx.rotate(p.rot);
    ctx.translate(0, p.pivot);
    const sq = clamp(p.sq, -0.3, 0.6);
    ctx.scale(1 + sq * 0.45, 1 - sq);

    const body = ctx.createLinearGradient(-12, 0, 12, 0);
    body.addColorStop(0, '#6c6fe0');
    body.addColorStop(1, '#2f2f86');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(-12, -2);
    ctx.lineTo(-5, -26);
    ctx.quadraticCurveTo(0, -29, 5, -26);
    ctx.lineTo(12, -2);
    ctx.quadraticCurveTo(0, 6, -12, -2);
    ctx.closePath();
    ctx.fill();

    const head = ctx.createRadialGradient(-3, -39, 1, 0, -35, 10);
    head.addColorStop(0, '#8d90f5');
    head.addColorStop(1, '#3b3ba0');
    ctx.fillStyle = head;
    ctx.beginPath();
    ctx.arc(0, -35, 9, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawParticles() {
    for (const p of particles) {
      const a = 1 - p.life / p.max;
      const c = P(p.x, p.z, p.h);
      ctx.beginPath();
      ctx.arc(c.x, c.y, p.size * S * (0.5 + a * 0.5), 0, TAU);
      ctx.fillStyle = hsl(p.hue, 80, 62, a);
      ctx.fill();
    }
  }

  function drawFloaters() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of floaters) {
      if (f.t < 0) continue;
      const k = f.t / 1.1;
      const c = P(f.x, f.z, f.h + k * 44);
      const a = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      const pop = k < 0.15 ? 0.6 + (k / 0.15) * 0.5 : 1.1 - Math.min((k - 0.15) * 0.4, 0.1);
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.font = `800 ${f.size * S * pop}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.lineWidth = 4 * S;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeText(f.text, c.x, c.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, c.x, c.y);
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    drawBackground();

    let playerDrawn = false;
    const behind = G.state === 'falling' && player.h < -6 ? fallInfo.behind : null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (behind === b) { drawPlayer(); playerDrawn = true; }
      drawBlock(b);
    }
    if (!playerDrawn) drawPlayer();

    for (const r of rings) drawRing(r);
    drawParticles();
    drawFloaters();
  }

  /* ------------------------------------------------------------------ *
   *  主循环
   * ------------------------------------------------------------------ */
  let last = 0;
  function frame(ts) {
    const dt = clamp((ts - (last || ts)) / 1000, 0, 0.05);
    last = ts;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  // 调试/自动化测试用的只读状态接口
  window.__jumpjump = {
    get state() { return G.state; },
    get score() { return G.score; },
    get combo() { return G.combo; },
    get best() { return G.best; },
    get chargeMs() { return G.charge * 1000; },
    dbg() { return { p: player, n: next, c: cur, j: jumpInfo, f: fallInfo }; },
    speed: SPEED,
    maxCharge: MAX_CHARGE,
    // 当前位置到下一块中心所需的蓄力时长（毫秒）
    holdForCenter() { return Math.hypot(next.x - player.x, next.z - player.z) / SPEED * 1000; },
    holdForEdge() { return (Math.hypot(next.x - player.x, next.z - player.z) + next.r + 30) / SPEED * 1000; },
  };

  resize();
  syncMuteButton();
  refreshBest();
  reset();
  requestAnimationFrame(frame);
})();
