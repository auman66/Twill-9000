// ============================================================
// VISUALIZER RENDERING ENGINE - Twill 9000
// ============================================================

class Visualizer {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.resize();
    window.addEventListener("resize", () => {
      clearTimeout(this._rt);
      this._rt = setTimeout(() => this.resize(), 100);
    });
  }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.c.getBoundingClientRect();
    this.c.width = rect.width * dpr;
    this.c.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.w = rect.width;
    this.h = rect.height;
    this.cx = this.w / 2;
    this.cy = this.h / 2;
  }
  getColor(i) {
    const p = PALETTES[CONFIG.palette];
    return p[i % p.length];
  }
  getVoiceBands(freq, count) {
    const bands = new Float32Array(count);
    const s = 4,
      e = Math.min(186, freq.length),
      step = (e - s) / count;
    for (let i = 0; i < count; i++)
      bands[i] = freq[Math.floor(s + i * step)] / 255;
    return bands;
  }

  render(ctx, w, h, freq, transparent) {
    const cx = w / 2,
      cy = h / 2;
    const fx = CONFIG.fx;

    if (!transparent) {
      if (fx.trails) {
        // Motion trails: overlay semi-transparent background instead of full clear
        ctx.fillStyle = CONFIG.bgColor;
        ctx.globalAlpha = fx.trailAlpha;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      } else if (STATE.bgImageEl && STATE.bgImageEl.complete) {
        ctx.drawImage(STATE.bgImageEl, 0, 0, w, h);
      } else {
        ctx.fillStyle = CONFIG.bgColor;
        ctx.fillRect(0, 0, w, h);
      }

      // Background pulse: subtle brightness on voice activity
      if (fx.bgPulse && STATE.voiceActive) {
        const pulseIntensity =
          STATE.bassEnergy * 0.3 + STATE.voiceEnergy * 0.15;
        const p = PALETTES[CONFIG.palette];
        ctx.fillStyle = p[0];
        ctx.globalAlpha = Math.min(pulseIntensity, 0.08);
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      }
    } else {
      ctx.clearRect(0, 0, w, h);
    }

    const bands = this.getVoiceBands(freq, 64);
    const ve = STATE.voiceEnergy,
      em = STATE.isEmphasis,
      sens = CONFIG.sensitivity;

    switch (STATE.mode) {
      case 0:
        this.radialEQ(ctx, w, h, cx, cy, bands, ve, em, sens);
        break;
    }

    // Pulse rings (drawn after main visualization)
    if (fx.pulseRings) this.drawPulseRings(ctx, cx, cy);

    // Particles (drawn on top)
    if (fx.particles) this.drawParticles(ctx, w, h, cx, cy);

    // Vignette overlay (drawn last)
    if (fx.vignette && !transparent) this.drawVignette(ctx, w, h, cx, cy);
  }

  // --- SHAPE HELPERS ---
  // Traces a shape path at origin (caller must translate to center)
  traceShapePath(ctx, shapeKey, radius) {
    if (shapeKey === "circle" || !SHAPES[shapeKey]) {
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      return;
    }
    if (shapeKey === "custom" && STATE.customSvgPath) {
      // Custom SVG: scale to fit radius
      const s = radius * STATE.customSvgScale;
      ctx.save();
      ctx.scale(s, s);
      // We can't trace a Path2D into beginPath, so we handle custom in draw methods
      ctx.restore();
      return;
    }
    const gen = SHAPES[shapeKey];
    if (!gen) {
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      return;
    }
    const pts = gen(radius);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  // Compute normalized edge distances for an SVG Path2D shape
  // Returns array of distances (0-1) for each bar angle
  // Uses isPointInPath binary search
  computeSvgEdgeDistances(path2d, svgScale, bars) {
    const oc = document.createElement("canvas");
    oc.width = 10;
    oc.height = 10;
    const octx = oc.getContext("2d");
    const angleStep = (Math.PI * 2) / bars;
    const distances = new Float32Array(bars);
    for (let i = 0; i < bars; i++) {
      const angle = i * angleStep;
      const rdx = -Math.sin(angle);
      const rdy = Math.cos(angle);
      let lo = 0,
        hi = 1.2;
      for (let iter = 0; iter < 14; iter++) {
        const mid = (lo + hi) / 2;
        const px = (rdx * mid) / svgScale;
        const py = (rdy * mid) / svgScale;
        if (octx.isPointInPath(path2d, px, py)) lo = mid;
        else hi = mid;
      }
      distances[i] = lo;
    }
    return distances;
  }

  getActiveShape() {
    if (CONFIG.shape === "random") {
      const rs = STATE.currentRandomShape;
      if (rs && rs.startsWith("svg-")) return "custom";
      return rs || "circle";
    }
    if (CONFIG.shape.startsWith("svg-")) return "custom";
    return CONFIG.shape;
  }

  // --- MODE 1: RADIAL EQ ---
  radialEQ(ctx, w, h, cx, cy, bands, ve, em, sens) {
    const bars = CONFIG.radialBars;
    const b = this.getVoiceBands(audio.freq, bars);
    const innerR = Math.min(cx, cy) * CONFIG.radialRadius;
    const maxBarH = Math.min(cx, cy) * 0.5;
    const angleStep = (Math.PI * 2) / bars;
    const p = PALETTES[CONFIG.palette];
    const fillColor = CONFIG.shapeColor || p[0];
    const borderColor = CONFIG.strokeColor || p[0];
    const kick = em ? 1.1 : 1.0;
    const fx = CONFIG.fx;
    const halfW = fx.barWidth / 2;
    const shapeKey = this.getActiveShape();
    // Two-phase breathing with configurable ring separation:
    // Phase 1: fill grows toward innerR, ring hugs fill as border
    // Phase 2: fill caps at innerR (hits bars), ring separates outward
    // ringSeparation controls Phase 2 only: 0 = ring stays at bar base, 1 = max push
    const sep = CONFIG.ringSeparation;
    const fillScale = 0.72 + ve * 0.56;
    const shapeR = innerR * Math.min(fillScale, 1.0); // cap at innerR
    const overflow = Math.max(0, fillScale - 1.0); // energy beyond the cap
    const strokeR = shapeR * (1.01 + ve * 0.12) + innerR * overflow * sep * 1.2;

    // Pick new random shape on emphasis with explicit chance + cooldown controls.
    if (STATE.randomShapeCooldown > 0) STATE.randomShapeCooldown--;
    if (CONFIG.shape === "random" && em && STATE.randomShapeCooldown <= 0) {
      const chance = Math.max(0, Math.min(1, CONFIG.randomChangeChance / 100));
      const cooldownFrames = Math.max(1, CONFIG.randomChangeCooldown | 0);
      if (Math.random() < chance) {
        const svgKeys = SVG_SHAPES.map((s) => "svg-" + s.id);
        const picked = svgKeys[Math.floor(Math.random() * svgKeys.length)];
        STATE.currentRandomShape = picked;
        const id = parseInt(picked.split("-")[1]);
        const svg = SVG_SHAPES.find((s) => s.id === id);
        if (svg) UI.loadSvgShape(svg);
        STATE.randomShapeCooldown = cooldownFrames;
      }
    }

    ctx.save();
    ctx.translate(cx, cy);

    // Rotation
    if (fx.rotate) {
      STATE.rotationAngle += fx.rotateSpeed * 0.02;
      ctx.rotate(STATE.rotationAngle);
    }

    // Enable glow if active
    if (fx.glow) {
      ctx.shadowColor = fillColor;
      ctx.shadowBlur = fx.glowStrength * (0.5 + ve);
    }

    // Determine if using custom SVG path (needed for barStarts computation)
    const isCustom = shapeKey === "custom" && STATE.customSvgPath;

    // Precompute bar start distances based on shape edge
    const barStarts = new Float32Array(bars);
    if (isCustom && STATE.customSvgPath) {
      // SVG shape: use cached edge distances (binary search with isPointInPath)
      const cacheKey = CONFIG.shape + "|" + STATE.currentRandomShape;
      const cache = STATE.svgEdgeCache;
      if (
        cache.shapeKey !== cacheKey ||
        cache.bars !== bars ||
        !cache.distances
      ) {
        cache.shapeKey = cacheKey;
        cache.bars = bars;
        cache.distances = this.computeSvgEdgeDistances(
          STATE.customSvgPath,
          STATE.customSvgScale,
          bars,
        );
      }
      // Scale normalized distances to innerR (fixed bar position)
      for (let i = 0; i < bars; i++) {
        barStarts[i] = cache.distances[i] * innerR;
      }
    } else if (shapeKey !== "circle" && SHAPES[shapeKey]) {
      // Built-in polygon: ray-edge intersection
      const gen = SHAPES[shapeKey];
      const pts = gen(innerR);
      const n = pts.length;
      for (let i = 0; i < bars; i++) {
        const angle = i * angleStep;
        const rdx = -Math.sin(angle);
        const rdy = Math.cos(angle);
        let bestT = innerR;
        for (let j = 0; j < n; j++) {
          const ax = pts[j].x,
            ay = pts[j].y;
          const bx = pts[(j + 1) % n].x,
            by = pts[(j + 1) % n].y;
          const edx = bx - ax,
            edy = by - ay;
          const denom = rdx * edy - rdy * edx;
          if (Math.abs(denom) < 0.001) continue;
          const t = (ax * edy - ay * edx) / denom;
          const u = (ax * rdy - ay * rdx) / denom;
          if (t > 0.1 && u >= -0.001 && u <= 1.001) {
            bestT = t;
            break;
          }
        }
        barStarts[i] = bestT;
      }
    } else {
      barStarts.fill(innerR);
    }

    // Shape fill helper
    const isMirror = CONFIG.barStyle === "mirror";
    const drawShapeFill = () => {
      ctx.shadowBlur = 0;
      // Mirror mode forces hollow (no fill)
      const forceHollow = isMirror;
      const useFillColor =
        CONFIG.hollowShape || forceHollow ? CONFIG.bgColor : fillColor;
      const useFillAlpha =
        CONFIG.hollowShape || forceHollow
          ? 1.0
          : 0.35 + STATE.sustainedEnergy * 1.3;
      if (isCustom) {
        const s = shapeR * STATE.customSvgScale;
        ctx.save();
        ctx.scale(s, s);
        ctx.fillStyle = useFillColor;
        ctx.globalAlpha = useFillAlpha;
        ctx.fill(STATE.customSvgPath);
        ctx.restore();
      } else {
        ctx.beginPath();
        if (shapeKey === "circle" || !SHAPES[shapeKey]) {
          ctx.arc(0, 0, shapeR, 0, Math.PI * 2);
        } else {
          const gen = SHAPES[shapeKey];
          const pts = gen(shapeR);
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
        }
        ctx.fillStyle = useFillColor;
        ctx.globalAlpha = useFillAlpha;
        ctx.fill();
      }
    };

    // Mirror mode: fill before bars (hollow, bars visible both sides)
    // Bars mode: fill drawn after bars below
    if (isMirror) drawShapeFill();

    // Radial bars / mirror
    if (fx.showBars) {
      {
        // Bars or Mirror: individual bars
        const mirrorScale = isMirror ? 0.2 : 1.0;
        for (let i = 0; i < bars; i++) {
          const val = b[i];
          // Mirror: boost frequency contrast, reduce baseline so bars vary more
          const barH = isMirror
            ? maxBarH * (val * sens * 1.5 + ve * 0.02) * kick * mirrorScale
            : maxBarH * (val * sens + ve * 0.1) * kick;
          if (barH < 1) continue;
          const angle = i * angleStep;
          const color = p[i % p.length];
          const barStart = barStarts[i];

          ctx.save();
          ctx.rotate(angle);

          if (fx.glow) {
            ctx.shadowColor = color;
            ctx.shadowBlur = fx.glowStrength * (0.3 + val * 0.7);
          }

          if (fx.gradientBars) {
            const grad = ctx.createLinearGradient(
              0,
              barStart,
              0,
              barStart + barH,
            );
            grad.addColorStop(0, color);
            grad.addColorStop(1, color + "00");
            ctx.fillStyle = grad;
          } else {
            ctx.fillStyle = color;
          }

          ctx.globalAlpha = 0.4 + val * 0.6;

          // Outward bar
          if (fx.roundedBars) {
            ctx.beginPath();
            ctx.moveTo(0, barStart);
            ctx.lineTo(0, barStart + barH);
            ctx.strokeStyle = ctx.fillStyle;
            ctx.lineWidth = fx.barWidth;
            ctx.lineCap = "round";
            ctx.stroke();
          } else {
            ctx.fillRect(-halfW, barStart, fx.barWidth, barH);
          }

          // Mirror: also draw inward bar
          if (CONFIG.barStyle === "mirror") {
            const innerH = barH * 0.8; // inward slightly shorter than outward
            if (fx.gradientBars) {
              const grad2 = ctx.createLinearGradient(
                0,
                barStart,
                0,
                barStart - innerH,
              );
              grad2.addColorStop(0, color);
              grad2.addColorStop(1, color + "00");
              ctx.fillStyle = grad2;
            }
            if (fx.roundedBars) {
              ctx.beginPath();
              ctx.moveTo(0, barStart);
              ctx.lineTo(0, barStart - innerH);
              ctx.strokeStyle = ctx.fillStyle;
              ctx.lineWidth = fx.barWidth;
              ctx.lineCap = "round";
              ctx.stroke();
            } else {
              ctx.fillRect(-halfW, barStart - innerH, fx.barWidth, innerH);
            }
          }

          ctx.restore();
        }
      }
    } // end showBars

    // Bars mode: fill AFTER bars (covers bar bases)
    if (!isMirror) drawShapeFill();

    // Hollow stroke border - hugs fill when quiet, separates when loud
    const ringAlpha = overflow > 0 ? 0.8 + ve * 0.2 : 0.6 + ve * 0.35;
    const ringWidth = overflow > 0 ? 4.0 + overflow * 22 : 2.5 + ve * 5;
    if (fx.glow) {
      ctx.shadowColor = borderColor;
      ctx.shadowBlur = fx.glowStrength * ve;
    }
    if (isCustom) {
      const s = strokeR * STATE.customSvgScale;
      ctx.save();
      ctx.scale(s, s);
      ctx.strokeStyle = borderColor;
      ctx.globalAlpha = ringAlpha;
      ctx.lineWidth = ringWidth / s;
      ctx.stroke(STATE.customSvgPath);
      ctx.restore();
    } else {
      ctx.beginPath();
      if (shapeKey === "circle" || !SHAPES[shapeKey]) {
        ctx.arc(0, 0, strokeR, 0, Math.PI * 2);
      } else {
        const gen = SHAPES[shapeKey];
        const pts = gen(strokeR);
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
      }
      ctx.strokeStyle = borderColor;
      ctx.globalAlpha = ringAlpha;
      ctx.lineWidth = ringWidth;
      ctx.stroke();
    }

    // Reset shadow
    ctx.shadowBlur = 0;
    ctx.restore();
    ctx.globalAlpha = 1;

    // Spawn pulse ring on emphasis
    if (CONFIG.fx.pulseRings && em) {
      STATE.pulseRings.push({
        x: cx,
        y: cy,
        radius: innerR * (0.8 + ve * 0.4),
        maxRadius: Math.min(cx, cy) * 0.9,
        alpha: 0.6,
        color: borderColor,
        lineWidth: 2 + ve * 3,
        shape: shapeKey, // remember which shape to expand
      });
    }

    // Spawn particles on emphasis
    if (CONFIG.fx.particles && em) {
      const count = 8 + Math.floor(ve * 15);
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.5 + Math.random() * 1.5 + ve * 2;
        STATE.particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1.0,
          decay: 0.008 + Math.random() * 0.012,
          size: 1.5 + Math.random() * 2.5,
          color: p[Math.floor(Math.random() * p.length)],
        });
      }
    }

    // Ambient particles when voice is active (gentle drift)
    if (CONFIG.fx.particles && STATE.voiceActive && Math.random() < 0.3) {
      const angle = Math.random() * Math.PI * 2;
      const dist = innerR * (0.8 + ve * 0.4);
      const speed = 0.2 + Math.random() * 0.6;
      STATE.particles.push({
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1.0,
        decay: 0.005 + Math.random() * 0.008,
        size: 1 + Math.random() * 1.5,
        color: p[Math.floor(Math.random() * p.length)],
      });
    }
  }

  // --- PULSE RINGS ---
  drawPulseRings(ctx, cx, cy) {
    for (let i = STATE.pulseRings.length - 1; i >= 0; i--) {
      const ring = STATE.pulseRings[i];
      ctx.save();
      ctx.translate(ring.x, ring.y);
      ctx.beginPath();
      const sk = ring.shape || "circle";
      if (sk === "circle" || !SHAPES[sk]) {
        ctx.arc(0, 0, ring.radius, 0, Math.PI * 2);
      } else {
        const gen = SHAPES[sk];
        const pts = gen(ring.radius);
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
        ctx.closePath();
      }
      ctx.strokeStyle = ring.color;
      ctx.globalAlpha = ring.alpha;
      ctx.lineWidth = ring.lineWidth;
      ctx.stroke();
      ctx.restore();

      // Expand and fade
      const speed = 2 + (ring.maxRadius - ring.radius) * 0.02;
      ring.radius += speed;
      ring.alpha -= 0.012;
      ring.lineWidth *= 0.97;

      if (ring.alpha <= 0 || ring.radius > ring.maxRadius) {
        STATE.pulseRings.splice(i, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  // --- PARTICLES ---
  drawParticles(ctx, w, h, cx, cy) {
    // Cap particle count to avoid performance issues
    if (STATE.particles.length > 300) {
      STATE.particles.splice(0, STATE.particles.length - 300);
    }

    for (let i = STATE.particles.length - 1; i >= 0; i--) {
      const pt = STATE.particles[i];

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.size * pt.life, 0, Math.PI * 2);
      ctx.fillStyle = pt.color;
      ctx.globalAlpha = pt.life * 0.7;
      ctx.fill();

      // Update position and life
      pt.x += pt.vx;
      pt.y += pt.vy;
      pt.vx *= 0.99;
      pt.vy *= 0.99;
      pt.life -= pt.decay;

      if (pt.life <= 0) {
        STATE.particles.splice(i, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  // --- VIGNETTE ---
  drawVignette(ctx, w, h, cx, cy) {
    const radius = Math.max(w, h) * 0.7;
    const grad = ctx.createRadialGradient(cx, cy, radius * 0.3, cx, cy, radius);
    grad.addColorStop(0, "transparent");
    grad.addColorStop(1, "rgba(0,0,0,0.6)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    const data = audio.getData();
    analyzeVoice(data.freq);
    // Main canvas render
    this.render(this.ctx, this.w, this.h, data.freq, false);
    // PNG sequence capture
    if (STATE.recordingPng && STATE.pngFrames.length < 900) {
      this.c.toBlob((blob) => {
        if (blob) STATE.pngFrames.push(blob);
      }, "image/png");
    }
    // JSON frame data capture
    if (STATE.recordingJson) {
      STATE.jsonFrames.push({
        time: audio.el.currentTime || 0,
        voiceEnergy: Math.round(STATE.voiceEnergy * 1000) / 1000,
        isEmphasis: STATE.isEmphasis,
        bands: Array.from(this.getVoiceBands(data.freq, 32)).map(
          (v) => Math.round(v * 1000) / 1000,
        ),
      });
    }
  }
}
