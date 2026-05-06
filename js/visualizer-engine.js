// ============================================================
// VISUALIZER RENDERING ENGINE - Twill 9000
// ============================================================

class Visualizer {
    constructor(canvas) {
        this.c = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.resize();
        window.addEventListener('resize', () => { clearTimeout(this._rt); this._rt = setTimeout(() => this.resize(), 100); });
    }
    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const rect = this.c.getBoundingClientRect();
        this.c.width = rect.width * dpr;
        this.c.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);
        this.w = rect.width; this.h = rect.height;
        this.cx = this.w / 2; this.cy = this.h / 2;
    }
    getColor(i) { const p = PALETTES[CONFIG.palette]; return p[i % p.length]; }
    getVoiceBands(freq, count) {
        const bands = new Float32Array(count);
        const s = 4, e = Math.min(186, freq.length), step = (e - s) / count;
        for (let i = 0; i < count; i++) bands[i] = freq[Math.floor(s + i * step)] / 255;
        return bands;
    }

    render(ctx, w, h, freq, transparent) {
        // Chromakey-safe rendering: the visualizer has dozens of alpha
        // modulations for fades / breathing / layered glows that make sense
        // on a dark background but break once the output gets chroma-keyed
        // \u2014 partially transparent pixels blend with the green and get
        // eaten by the chromakey filter. We shadow `globalAlpha` on this
        // context instance so every downstream assignment is pinned to 1.0
        // for the duration of this frame. Growth/shrinkage animations
        // still work (size is driven by voice energy, not opacity).
        //
        // Side effect: motion trails (fx.trails) and bg pulse use partial
        // alpha to blend, so they effectively become full bg fills while
        // this shim is active. Disable those effects for chromakey output.
        //
        // We only do this for the opaque main canvas path; the
        // `transparent` screenshot path keeps real alpha.
        const pinAlpha = !transparent;
        let alphaWasShadowed = false;
        if (pinAlpha) {
            Object.defineProperty(ctx, 'globalAlpha', {
                configurable: true,
                get() { return 1; },
                set() { /* no-op: keep visuals solid for chromakey */ }
            });
            alphaWasShadowed = true;
        }
        try {
            this._renderInner(ctx, w, h, freq, transparent);
        } finally {
            if (alphaWasShadowed) {
                delete ctx.globalAlpha;
                ctx.globalAlpha = 1;
            }
        }
    }

    _renderInner(ctx, w, h, freq, transparent) {
        const cx = w/2, cy = h/2;
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
                const pulseIntensity = STATE.bassEnergy * 0.3 + STATE.voiceEnergy * 0.15;
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
        const ve = STATE.voiceEnergy, em = STATE.isEmphasis, sens = CONFIG.sensitivity;

        // Pulse lines behind everything
        if (fx.pulseLines) this.drawPulseLines(ctx, w, h, cx, cy, freq);

        // Pulse rings
        if (fx.pulseRings) this.drawPulseRings(ctx, cx, cy);

        // Particles
        if (fx.particles) this.drawParticles(ctx, w, h, cx, cy);

        // Shape + bars drawn last so it's always in front
        switch(STATE.mode) {
            case 0: if (fx.showShape) this.radialEQ(ctx, w, h, cx, cy, bands, ve, em, sens); break;
        }

        // Vignette overlay (drawn last)
        if (fx.vignette && !transparent) this.drawVignette(ctx, w, h, cx, cy);
    }

    // --- SHAPE HELPERS ---
    // Traces a shape path at origin (caller must translate to center)
    traceShapePath(ctx, shapeKey, radius) {
        if (shapeKey === 'circle' || !SHAPES[shapeKey]) {
            ctx.arc(0, 0, radius, 0, Math.PI * 2);
            return;
        }
        if (shapeKey === 'custom' && STATE.customSvgPath) {
            // Custom SVG: scale to fit radius
            const s = radius * STATE.customSvgScale;
            ctx.save();
            ctx.scale(s, s);
            // We can't trace a Path2D into beginPath, so we handle custom in draw methods
            ctx.restore();
            return;
        }
        const gen = SHAPES[shapeKey];
        if (!gen) { ctx.arc(0, 0, radius, 0, Math.PI * 2); return; }
        const pts = gen(radius);
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
    }

    // Compute normalized edge distances for an SVG Path2D shape
    // Returns array of distances (0-1) for each bar angle
    // Uses isPointInPath binary search
    computeSvgEdgeDistances(path2d, svgScale, bars) {
        const oc = document.createElement('canvas');
        oc.width = 10; oc.height = 10;
        const octx = oc.getContext('2d');
        const angleStep = (Math.PI * 2) / bars;
        const distances = new Float32Array(bars);
        for (let i = 0; i < bars; i++) {
            const angle = i * angleStep;
            const rdx = -Math.sin(angle);
            const rdy = Math.cos(angle);
            let lo = 0, hi = 1.2;
            for (let iter = 0; iter < 14; iter++) {
                const mid = (lo + hi) / 2;
                const px = rdx * mid / svgScale;
                const py = rdy * mid / svgScale;
                if (octx.isPointInPath(path2d, px, py)) lo = mid;
                else hi = mid;
            }
            distances[i] = lo;
        }
        return distances;
    }

    getActiveShape() {
        if (CONFIG.shape === 'random') {
            const rs = STATE.currentRandomShape;
            if (rs && rs.startsWith('svg-')) return 'custom';
            return rs || 'circle';
        }
        if (CONFIG.shape.startsWith('svg-')) return 'custom';
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
        const shapeR = innerR * Math.min(fillScale, 1.0);  // cap at innerR
        const overflow = Math.max(0, fillScale - 1.0);      // energy beyond the cap
        const strokeR = shapeR * (1.01 + ve * 0.12) + innerR * overflow * sep * 1.2;

        // Pick new random shape on the downswing after cooldown elapses
        // Triggers when energy is falling and in the mid-low range (not peak, not dead)
        const now = performance.now();
        const cooldownElapsed = (now - STATE.shapeChangeTimer) > CONFIG.shapeSpeed * 1000;
        const falling = ve < STATE.lastVoiceEnergy;
        const midLow = ve > CONFIG.shapeChangePoint * 0.3 && ve < CONFIG.shapeChangePoint;
        if (CONFIG.shape === 'random' && cooldownElapsed && falling && midLow) {
            const svgKeys = SVG_SHAPES.map(s => 'svg-' + s.id);
            const picked = svgKeys[Math.floor(Math.random() * svgKeys.length)];
            STATE.currentRandomShape = picked;
            const id = parseInt(picked.split('-')[1]);
            const svg = SVG_SHAPES.find(s => s.id === id);
            if (svg) UI.loadSvgShape(svg);
            STATE.shapeChangeTimer = now;
        }
        STATE.lastVoiceEnergy = ve;

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
        const isCustom = shapeKey === 'custom' && STATE.customSvgPath;

        // Precompute bar start distances based on shape edge
        const barStarts = new Float32Array(bars);
        if (isCustom && STATE.customSvgPath) {
            // SVG shape: use cached edge distances (binary search with isPointInPath)
            const cacheKey = CONFIG.shape + '|' + STATE.currentRandomShape;
            const cache = STATE.svgEdgeCache;
            if (cache.shapeKey !== cacheKey || cache.bars !== bars || !cache.distances) {
                cache.shapeKey = cacheKey;
                cache.bars = bars;
                cache.distances = this.computeSvgEdgeDistances(STATE.customSvgPath, STATE.customSvgScale, bars);
            }
            // Scale normalized distances to innerR (fixed bar position)
            for (let i = 0; i < bars; i++) {
                barStarts[i] = cache.distances[i] * innerR;
            }
        } else if (shapeKey !== 'circle' && SHAPES[shapeKey]) {
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
                    const ax = pts[j].x, ay = pts[j].y;
                    const bx = pts[(j+1)%n].x, by = pts[(j+1)%n].y;
                    const edx = bx - ax, edy = by - ay;
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
        const isMirror = CONFIG.barStyle === 'mirror';
        const drawShapeFill = () => {
            ctx.shadowBlur = 0;
            // Mirror mode forces hollow (no fill)
            const forceHollow = isMirror;
            const useFillColor = (CONFIG.hollowShape || forceHollow) ? CONFIG.bgColor : fillColor;
            // Keep the shape fully opaque regardless of voice energy. An
            // earlier "breathing" effect modulated this with sustainedEnergy
            // (0.35 at rest, 1.0 at peak) — but with a green chromakey
            // background the partial transparency lets green show through
            // the shape during silence. Solid is safer; the bars + ring
            // animations still carry the reactive feel.
            const useFillAlpha = 1.0;
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
                if (shapeKey === 'circle' || !SHAPES[shapeKey]) {
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
                    const grad = ctx.createLinearGradient(0, barStart, 0, barStart + barH);
                    grad.addColorStop(0, color);
                    grad.addColorStop(1, color + '00');
                    ctx.fillStyle = grad;
                } else {
                    ctx.fillStyle = color;
                }

                ctx.globalAlpha = 1.0;  // chromakey-safe: bars always solid

                // Outward bar
                if (fx.roundedBars) {
                    ctx.beginPath();
                    ctx.moveTo(0, barStart);
                    ctx.lineTo(0, barStart + barH);
                    ctx.strokeStyle = ctx.fillStyle;
                    ctx.lineWidth = fx.barWidth;
                    ctx.lineCap = 'round';
                    ctx.stroke();
                } else {
                    ctx.fillRect(-halfW, barStart, fx.barWidth, barH);
                }

                // Mirror: also draw inward bar
                if (CONFIG.barStyle === 'mirror') {
                    const innerH = barH * 0.8; // inward slightly shorter than outward
                    if (fx.gradientBars) {
                        const grad2 = ctx.createLinearGradient(0, barStart, 0, barStart - innerH);
                        grad2.addColorStop(0, color);
                        grad2.addColorStop(1, color + '00');
                        ctx.fillStyle = grad2;
                    }
                    if (fx.roundedBars) {
                        ctx.beginPath();
                        ctx.moveTo(0, barStart);
                        ctx.lineTo(0, barStart - innerH);
                        ctx.strokeStyle = ctx.fillStyle;
                        ctx.lineWidth = fx.barWidth;
                        ctx.lineCap = 'round';
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

        // Hollow stroke border - hugs fill when quiet, separates when loud.
        // Alpha is pinned to 1.0: the old modulation (0.6 at rest -> 0.95
        // on peak) made the ring visibly fade over silence, which with a
        // chromakey green background showed green through it. The ring
        // still reacts to voice energy via width/separation, so it's still
        // visually alive.
        const ringAlpha = 1.0;
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
            if (shapeKey === 'circle' || !SHAPES[shapeKey]) {
                ctx.arc(0, 0, strokeR, 0, Math.PI * 2);
            } else {
                const gen = SHAPES[shapeKey];
                const pts = gen(strokeR);
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
                ctx.closePath();
            }
            ctx.strokeStyle = borderColor;            ctx.globalAlpha = ringAlpha;
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
                x: cx, y: cy,
                radius: innerR * (0.8 + ve * 0.4),
                maxRadius: Math.min(cx, cy) * 0.9,
                alpha: 0.6,
                color: borderColor,
                lineWidth: 2 + ve * 3,
                shape: shapeKey  // remember which shape to expand
            });
        }

        // Spawn particles on emphasis
        if (CONFIG.fx.particles && em) {
            const count = 8 + Math.floor(ve * 15);
            for (let i = 0; i < count; i++) {
                const angle = Math.random() * Math.PI * 2;
                const speed = 0.5 + Math.random() * 1.5 + ve * 2;
                STATE.particles.push({
                    x: cx, y: cy,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    life: 1.0,
                    decay: 0.008 + Math.random() * 0.012,
                    size: 1.5 + Math.random() * 2.5,
                    color: p[Math.floor(Math.random() * p.length)]
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
                color: p[Math.floor(Math.random() * p.length)]
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
            const sk = ring.shape || 'circle';
            if (sk === 'circle' || !SHAPES[sk]) {
                ctx.arc(0, 0, ring.radius, 0, Math.PI * 2);
            } else {
                const gen = SHAPES[sk];
                const pts = gen(ring.radius);
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
                ctx.closePath();
            }
            ctx.strokeStyle = ring.color;
            // Chromakey-safe: always solid. Ring still grows + thins to
            // visually dissipate, but no alpha fade that the chromakey
            // filter can eat.
            ctx.globalAlpha = 1.0;
            ctx.lineWidth = ring.lineWidth;
            ctx.stroke();
            ctx.restore();

            // Expand and shrink (no alpha fade; the shrinking lineWidth
            // provides the "fade out" feel without using transparency).
            const speed = 2 + (ring.maxRadius - ring.radius) * 0.02;
            ring.radius += speed;
            ring.lineWidth *= 0.94;  // slightly faster shrink to compensate

            if (ring.lineWidth < 0.5 || ring.radius > ring.maxRadius) {
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
            // Chromakey-safe: size shrinks to zero via pt.life, but alpha
            // stays at 1.0 so the particle is fully opaque the whole time.
            ctx.arc(pt.x, pt.y, pt.size * pt.life, 0, Math.PI * 2);
            ctx.fillStyle = pt.color;
            ctx.globalAlpha = 1.0;
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

    // --- PULSE LINES ---
    // Stage-quality horizontal lines extending from center shape to screen edges
    drawPulseLines(ctx, w, h, cx, cy, freq) {
        const p = PALETTES[CONFIG.palette];
        const ve = STATE.lineEnergy || STATE.voiceEnergy;
        const se = STATE.sustainedEnergy;
        const fx = CONFIG.fx;
        const innerR = Math.min(cx, cy) * CONFIG.radialRadius;
        const intensity = fx.pulseLineIntensity;
        const lineW = fx.pulseLineWidth;
        const style = fx.pulseLineStyle || 'smooth';

        const wave = audio.wave;
        const bands = this.getVoiceBands(freq, 128);
        const time = performance.now() / 1000;

        const lineColor = fx.pulseLineColor || CONFIG.strokeColor || p[0];
        // Secondary color for accents (next palette color)
        const lineColor2 = fx.pulseLineColor || p[1] || lineColor;

        // Spawn ripple on emphasis
        if (STATE.isEmphasis) {
            STATE.pulseLineRipples.push({
                pos: 0, speed: 0.015 + ve * 0.025,
                amplitude: 25 + ve * 60, width: 0.1 + ve * 0.08,
                alpha: 0.9 + ve * 0.1, color: lineColor2
            });
        }

        const shapeEdge = fx.showShape ? innerR * (0.72 + ve * 0.56) : 0;
        const layout = fx.pulseLineLayout || 'center';

        ctx.save();

        // getDisp: compute vertical displacement
        // t = 0..1 normalized position along the line
        // envelope = amplitude multiplier (center-peaked for full, edge-fade for center)
        const getDisp = (t, envelope) => {
            const bandIdx = Math.floor(t * (bands.length - 1));
            const bandVal = bands[bandIdx] || 0;
            const waveIdx = Math.floor(t * (wave.length - 1));
            const waveVal = ((wave[waveIdx] || 128) - 128) / 128;
            const sens = fx.pulseLineSensitivity;
            const freqDisp = bandVal * 80 * intensity * sens;
            const waveDisp = waveVal * 50 * intensity * se;
            let d = (freqDisp + waveDisp) * envelope;
            d += Math.sin(t * 6 + time * 1.5) * 2 * envelope;
            for (const ripple of STATE.pulseLineRipples) {
                const dist = Math.abs(t - ripple.pos);
                if (dist < ripple.width) {
                    d += Math.cos((dist / ripple.width) * Math.PI) * 0.5 * ripple.amplitude * ripple.alpha;
                }
            }
            return d;
        };

        // makeGrad: horizontal gradient
        const makeGrad = (x1, x2, color) => {
            const c = color || lineColor;
            const grad = ctx.createLinearGradient(x1, cy, x2, cy);
            if (layout === 'full') {
                grad.addColorStop(0, c + '00');
                grad.addColorStop(0.15, c + '66');
                grad.addColorStop(0.5, c);
                grad.addColorStop(0.85, c + '66');
                grad.addColorStop(1, c + '00');
            } else {
                grad.addColorStop(0, c);
                grad.addColorStop(0.5, c + 'aa');
                grad.addColorStop(0.85, c + '33');
                grad.addColorStop(1, c + '00');
            }
            return grad;
        };

        // computePoints: array of {t, x, d} for a run
        const computePoints = (x1, x2, numSegs) => {
            const pts = [];
            for (let i = 0; i <= numSegs; i++) {
                const t = i / numSegs;
                const x = x1 + (x2 - x1) * t;
                let envelope;
                if (layout === 'full') {
                    // center-peaked: 0 at edges, 1 at center (like reference image)
                    envelope = Math.sin(t * Math.PI);
                } else {
                    // edge-fade: 1 near shape, 0 at edge
                    envelope = Math.pow(1 - t, 0.8);
                }
                pts.push({ t, x, d: i === 0 && layout === 'center' ? 0 : getDisp(t, envelope) });
            }
            return pts;
        };

        // drawBezierPath: smooth bezier through points
        const drawBezierPath = (pts, sign) => {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, cy + pts[0].d * sign);
            for (let i = 1; i < pts.length; i++) {
                const prev = pts[i - 1];
                const curr = pts[i];
                const cpx = (prev.x + curr.x) / 2;
                ctx.quadraticCurveTo(prev.x, cy + prev.d * sign, cpx, cy + (prev.d + curr.d) / 2 * sign);
            }
            const last = pts[pts.length - 1];
            ctx.lineTo(last.x, cy + last.d * sign);
        };

        // Build run list: full = one pass left-to-right, center = two passes from shape edge outward
        const runs = [];
        const segStep = 3;
        if (layout === 'full') {
            const numSegs = Math.max(4, Math.floor(w / segStep));
            runs.push({
                pts: computePoints(0, w, numSegs),
                x1: 0, x2: w
            });
        } else {
            const rightDist = w - cx - shapeEdge;
            const leftDist = cx - shapeEdge;
            const rSegs = Math.max(4, Math.floor(rightDist / segStep));
            const lSegs = Math.max(4, Math.floor(leftDist / segStep));
            runs.push({
                pts: computePoints(cx + shapeEdge, w, rSegs),
                x1: cx + shapeEdge, x2: w
            });
            runs.push({
                pts: computePoints(cx - shapeEdge, 0, lSegs),
                x1: cx - shapeEdge, x2: 0
            });
        }

        // --- RENDER ---
        const mirrorCount = fx.pulseLineMirror ? 2 : 1;
        const isMirrored = fx.pulseLineMirror;

        for (const run of runs) {
            const { pts, x1, x2 } = run;
            const grad = makeGrad(Math.min(x1, x2), Math.max(x1, x2));
            const grad2 = makeGrad(Math.min(x1, x2), Math.max(x1, x2), lineColor2);
            const gradW = makeGrad(Math.min(x1, x2), Math.max(x1, x2), '#ffffff');

            // Helper: fill between mirrored waves given an array of {x, y} points
            // topPts are the y values for sign=1, fills to their mirror (cy - (y - cy))
            const fillMirrored = (topPts) => {
                if (!isMirrored) return;
                ctx.beginPath();
                // Top edge
                ctx.moveTo(topPts[0].x, topPts[0].y);
                for (let i = 1; i < topPts.length; i++) {
                    const prev = topPts[i-1], curr = topPts[i];
                    ctx.quadraticCurveTo(prev.x, prev.y, (prev.x+curr.x)/2, (prev.y+curr.y)/2);
                }
                // Bottom edge (mirrored around cy), reversed
                for (let i = topPts.length - 1; i >= 0; i--) {
                    const curr = topPts[i];
                    const mirY = cy - (curr.y - cy);
                    if (i === topPts.length - 1) {
                        ctx.lineTo(curr.x, mirY);
                    } else {
                        const next = topPts[i+1];
                        const mirYn = cy - (next.y - cy);
                        ctx.quadraticCurveTo(next.x, mirYn, (curr.x+next.x)/2, (mirY+mirYn)/2);
                    }
                }
                ctx.closePath();
                ctx.fillStyle = lineColor;
                ctx.globalAlpha = 1;
                ctx.fill();
            };

            // Pre-stroke mirror fill (drawn once, style-specific shape)
            if (isMirrored && fx.pulseLineFill) {
                if (style === 'smooth' || style === 'ribbon') {
                    // Bezier curve fill
                    fillMirrored(pts.map(p => ({ x: p.x, y: cy + p.d })));
                } else if (style === 'sharp') {
                    // Triangular peaks fill
                    const peakStep = Math.max(2, Math.floor(pts.length / 60));
                    const sharpPts = [{ x: pts[0].x, y: cy }];
                    for (let i = peakStep; i < pts.length; i += peakStep) {
                        const pt = pts[i];
                        const prevPt = pts[Math.max(0, i - peakStep)];
                        const midX = prevPt.x + (pt.x - prevPt.x) * 0.45;
                        sharpPts.push({ x: midX, y: cy });
                        sharpPts.push({ x: midX + (pt.x - prevPt.x) * 0.05, y: cy + pt.d * 2.2 });
                        sharpPts.push({ x: pt.x, y: cy });
                    }
                    fillMirrored(sharpPts);
                } else if (style === 'sine') {
                    // Clean sine fill matching stroke
                    const sineFillFreq = 12 + ve * 6;
                    const sineFillSpeed = time * 3;
                    const sineFillAmp = (20 + ve * 120 + se * 60) * intensity;
                    const sineFillStep = Math.max(1, Math.floor(pts.length / 200));
                    const sineFillPts = [];
                    for (let i = 0; i < pts.length; i += sineFillStep) {
                        const pt = pts[i];
                        let envFade;
                        if (layout === 'full') { envFade = Math.sin(pt.t * Math.PI); }
                        else { envFade = Math.pow(1 - pt.t, 0.8); }
                        sineFillPts.push({ x: pt.x, y: cy + Math.sin(pt.t * sineFillFreq - sineFillSpeed) * sineFillAmp * envFade });
                    }
                    fillMirrored(sineFillPts);
                } else if (style === 'noise') {
                    // Noise uses smooth displacement as fill base (noise is per-frame random, can't match)
                    fillMirrored(pts.map(p => ({ x: p.x, y: cy + p.d })));
                }
            }

            // Draw stroke layers for each mirror pass
            for (let mirror = 0; mirror < mirrorCount; mirror++) {
                const sign = mirror === 0 ? 1 : -1;
                const mirrorAlpha = mirror === 0 ? 1.0 : (isMirrored ? 0.8 : 1.0);

                switch (style) {

                // ============================================================
                // SMOOTH WAVE
                // ============================================================
                case 'smooth': {
                    drawBezierPath(pts, sign);
                    // Outer glow
                    ctx.strokeStyle = grad;
                    ctx.lineWidth = (lineW + ve * 4) * 3;
                    ctx.globalAlpha = 0.08 * mirrorAlpha;
                    ctx.stroke();
                    // Mid glow
                    ctx.lineWidth = (lineW + ve * 3) * 1.8;
                    ctx.globalAlpha = 0.2 * mirrorAlpha * (0.5 + se);
                    ctx.stroke();
                    // Core
                    ctx.lineWidth = lineW + ve * 2;
                    ctx.globalAlpha = (0.6 + se * 0.4) * mirrorAlpha;
                    ctx.stroke();
                    // Hot center
                    ctx.strokeStyle = gradW;
                    ctx.lineWidth = Math.max(1, lineW * 0.3);
                    ctx.globalAlpha = (0.15 + ve * 0.4) * mirrorAlpha;
                    ctx.stroke();
                    break;
                }

                // ============================================================
                // SHARP PEAKS
                // ============================================================
                case 'sharp': {
                    const peakStep = Math.max(2, Math.floor(pts.length / 60));
                    ctx.beginPath();
                    ctx.moveTo(pts[0].x, cy);
                    for (let i = peakStep; i < pts.length; i += peakStep) {
                        const pt = pts[i];
                        const d = pt.d * sign * 2.2;
                        const prevPt = pts[Math.max(0, i - peakStep)];
                        const midX = prevPt.x + (pt.x - prevPt.x) * 0.45;
                        ctx.lineTo(midX, cy);
                        ctx.lineTo(midX + (pt.x - prevPt.x) * 0.05, cy + d);
                        ctx.lineTo(pt.x, cy);
                    }
                    ctx.strokeStyle = grad;
                    ctx.lineWidth = (lineW + ve * 2) * 2;
                    ctx.globalAlpha = 0.12 * mirrorAlpha;
                    ctx.lineJoin = 'bevel';
                    ctx.stroke();
                    ctx.lineWidth = lineW + ve * 1.5;
                    ctx.globalAlpha = (0.7 + se * 0.3) * mirrorAlpha;
                    ctx.stroke();
                    break;
                }

                // ============================================================
                // BLOCKS - LED wall spectrum
                // ============================================================
                case 'blocks': {
                    const gap = 2;
                    const blockW = Math.max(4, Math.floor(12 + ve * 6));
                    const blockCount = Math.floor(Math.abs(x2 - x1) / (blockW + gap));
                    for (let i = 0; i < blockCount; i++) {
                        const t = (i + 0.5) / blockCount;
                        const ptIdx = Math.floor(t * (pts.length - 1));
                        const d = Math.abs(pts[ptIdx].d);
                        const bh = Math.max(2, d * 1.5);
                        const x = pts[ptIdx].x - blockW / 2;
                        let envelope;
                        if (layout === 'full') {
                            envelope = Math.sin(t * Math.PI);
                        } else {
                            envelope = Math.pow(1 - t, 0.6);
                        }
                        const alpha = mirrorAlpha * envelope * (0.5 + se * 0.5);
                        if (alpha < 0.01) continue;
                        const barGrad = ctx.createLinearGradient(0, cy, 0, cy + bh * sign);
                        barGrad.addColorStop(0, lineColor);
                        barGrad.addColorStop(0.6, lineColor2);
                        barGrad.addColorStop(1, lineColor2 + '44');
                        ctx.fillStyle = barGrad;
                        ctx.globalAlpha = alpha;
                        if (sign > 0) ctx.fillRect(x, cy + 1, blockW, bh);
                        else ctx.fillRect(x, cy - 1 - bh, blockW, bh);
                        ctx.fillStyle = '#ffffff';
                        ctx.globalAlpha = alpha * 0.5;
                        if (sign > 0) ctx.fillRect(x, cy + bh - 2, blockW, 2);
                        else ctx.fillRect(x, cy - bh + 1, blockW, 2);
                    }
                    break;
                }

                // ============================================================
                // DOUBLE HELIX
                // ============================================================
                case 'helix': {
                    const freq1 = 8 + ve * 4;
                    const speed1 = time * 2.5;
                    for (let strand = 0; strand < 2; strand++) {
                        const phase = strand * Math.PI;
                        ctx.beginPath();
                        for (let i = 0; i < pts.length; i++) {
                            const pt = pts[i];
                            const twist = Math.sin(pt.t * freq1 - speed1 + phase) * (20 + pt.d * 0.7) * intensity;
                            let envelope;
                            if (layout === 'full') { envelope = Math.sin(pt.t * Math.PI); }
                            else { envelope = Math.pow(1 - pt.t, 0.8); }
                            const y = cy + (pt.d * 0.5 + twist) * sign * envelope;
                            if (i === 0) ctx.moveTo(pt.x, y);
                            else {
                                const prev = pts[i-1];
                                const prevTwist = Math.sin(prev.t * freq1 - speed1 + phase) * (20 + prev.d * 0.7) * intensity;
                                let prevEnv;
                                if (layout === 'full') { prevEnv = Math.sin(prev.t * Math.PI); }
                                else { prevEnv = Math.pow(1 - prev.t, 0.8); }
                                const py = cy + (prev.d * 0.5 + prevTwist) * sign * prevEnv;
                                ctx.quadraticCurveTo(prev.x, py, (prev.x + pt.x) / 2, (py + y) / 2);
                            }
                        }
                        const sc = strand === 0 ? lineColor : lineColor2;
                        const sg = makeGrad(Math.min(x1,x2), Math.max(x1,x2), sc);
                        ctx.strokeStyle = sg;
                        ctx.lineWidth = (lineW + ve * 2) * 2;
                        ctx.globalAlpha = 0.1 * mirrorAlpha;
                        ctx.stroke();
                        ctx.lineWidth = lineW + ve * 1.5;
                        ctx.globalAlpha = (0.5 + se * 0.4) * mirrorAlpha * (strand === 0 ? 1 : 0.7);
                        ctx.stroke();
                    }
                    break;
                }

                // ============================================================
                // SCATTER
                // ============================================================
                case 'scatter': {
                    const dotStep = Math.max(1, Math.floor(pts.length / 120));
                    for (let i = dotStep; i < pts.length; i += dotStep) {
                        const pt = pts[i];
                        const d = pt.d * sign;
                        let envelope;
                        if (layout === 'full') { envelope = Math.sin(pt.t * Math.PI); }
                        else { envelope = Math.pow(1 - pt.t, 0.7); }
                        const alpha = mirrorAlpha * envelope * (0.4 + se * 0.6);
                        if (alpha < 0.01) continue;
                        const jx = (Math.random() - 0.5) * 6 * ve;
                        const jy = (Math.random() - 0.5) * 6 * ve;
                        const size = (1.5 + Math.abs(d) * 0.08) * lineW * 0.6;
                        ctx.beginPath();
                        ctx.arc(pt.x + jx, cy + d + jy, Math.max(0.8, size), 0, Math.PI * 2);
                        ctx.fillStyle = lineColor;
                        ctx.globalAlpha = alpha;
                        ctx.fill();
                        ctx.beginPath();
                        ctx.arc(pt.x + jx, cy + d + jy, size * 2.5, 0, Math.PI * 2);
                        ctx.fillStyle = lineColor;
                        ctx.globalAlpha = alpha * 0.12;
                        ctx.fill();
                    }
                    drawBezierPath(pts, sign);
                    ctx.strokeStyle = grad;
                    ctx.lineWidth = 0.5;
                    ctx.globalAlpha = 0.15 * mirrorAlpha * se;
                    ctx.stroke();
                    break;
                }

                // ============================================================
                // RIBBON
                // ============================================================
                case 'ribbon': {
                    ctx.beginPath();
                    ctx.moveTo(pts[0].x, cy);
                    for (let i = 1; i < pts.length; i++) {
                        const prev = pts[i-1], curr = pts[i];
                        ctx.quadraticCurveTo(prev.x, cy + prev.d * sign, (prev.x+curr.x)/2, cy + (prev.d+curr.d)/2 * sign);
                    }
                    const last = pts[pts.length - 1];
                    ctx.lineTo(last.x, cy + last.d * sign);
                    ctx.lineTo(last.x, cy);
                    ctx.closePath();
                    const maxD = Math.max(30, 60 * intensity * ve);
                    const ribbonGrad = ctx.createLinearGradient(0, cy, 0, cy + maxD * sign);
                    ribbonGrad.addColorStop(0, lineColor + '05');
                    ribbonGrad.addColorStop(0.3, lineColor + '30');
                    ribbonGrad.addColorStop(0.7, lineColor2 + '20');
                    ribbonGrad.addColorStop(1, lineColor2 + '00');
                    ctx.fillStyle = ribbonGrad;
                    ctx.globalAlpha = (0.5 + se * 0.5) * mirrorAlpha;
                    ctx.fill();
                    drawBezierPath(pts, sign);
                    ctx.strokeStyle = grad;
                    ctx.lineWidth = lineW + ve * 1.5;
                    ctx.globalAlpha = (0.7 + se * 0.3) * mirrorAlpha;
                    ctx.stroke();
                    ctx.strokeStyle = gradW;
                    ctx.lineWidth = Math.max(0.5, lineW * 0.25);
                    ctx.globalAlpha = (0.1 + ve * 0.3) * mirrorAlpha;
                    ctx.stroke();
                    break;
                }

                // ============================================================
                // SEGMENTS
                // ============================================================
                case 'segments': {
                    const segLen = 20 + ve * 15;
                    const gapLen = 8 + (1 - ve) * 20;
                    let drawing = true, accumulated = 0;
                    const segs = [];
                    let currSeg = [];
                    for (let i = 0; i < pts.length; i++) {
                        accumulated += segStep;
                        if (drawing) {
                            currSeg.push({ x: pts[i].x, y: cy + pts[i].d * sign, t: pts[i].t });
                            if (accumulated > segLen) { segs.push(currSeg); currSeg = []; accumulated = 0; drawing = false; }
                        } else {
                            if (accumulated > gapLen) { accumulated = 0; drawing = true; }
                        }
                    }
                    if (currSeg.length > 1) segs.push(currSeg);
                    for (const seg of segs) {
                        if (seg.length < 2) continue;
                        const avgT = seg[Math.floor(seg.length/2)].t;
                        let envelope;
                        if (layout === 'full') { envelope = Math.sin(avgT * Math.PI); }
                        else { envelope = Math.pow(1 - avgT, 0.7); }
                        ctx.beginPath();
                        ctx.moveTo(seg[0].x, seg[0].y);
                        for (let j = 1; j < seg.length; j++) {
                            const prev = seg[j-1], curr = seg[j];
                            ctx.quadraticCurveTo(prev.x, prev.y, (prev.x+curr.x)/2, (prev.y+curr.y)/2);
                        }
                        ctx.strokeStyle = lineColor;
                        ctx.lineWidth = (lineW + ve * 2) * 2.5;
                        ctx.globalAlpha = 0.08 * mirrorAlpha * envelope;
                        ctx.lineCap = 'round';
                        ctx.stroke();
                        ctx.lineWidth = lineW + ve * 2;
                        ctx.globalAlpha = (0.6 + se * 0.4) * mirrorAlpha * envelope;
                        ctx.stroke();
                        const r = lineW * 0.8 + ve;
                        ctx.fillStyle = '#ffffff';
                        ctx.globalAlpha = (0.3 + ve * 0.4) * mirrorAlpha * envelope;
                        ctx.beginPath(); ctx.arc(seg[0].x, seg[0].y, r, 0, Math.PI*2); ctx.fill();
                        ctx.beginPath(); ctx.arc(seg[seg.length-1].x, seg[seg.length-1].y, r, 0, Math.PI*2); ctx.fill();
                    }
                    break;
                }

                // ============================================================
                // SINE PULSE
                // ============================================================
                case 'sine': {
                    // Clean oscilloscope: audio drives amplitude, not per-point noise
                    const sineFreq = 12 + ve * 6;
                    const sineSpeed = time * 3;
                    // Smooth amplitude from voice energy (no raw freq jitter)
                    const sineAmp = (20 + ve * 120 + se * 60) * intensity;
                    // Use fewer points for smoother curve
                    const sineStep = Math.max(1, Math.floor(pts.length / 200));
                    const sinePts = [];
                    for (let i = 0; i < pts.length; i += sineStep) {
                        const pt = pts[i];
                        let envFade;
                        if (layout === 'full') { envFade = Math.sin(pt.t * Math.PI); }
                        else { envFade = Math.pow(1 - pt.t, 0.8); }
                        const sineVal = Math.sin(pt.t * sineFreq - sineSpeed) * sineAmp * envFade;
                        // Only add ripple, no freq noise
                        let rippleD = 0;
                        for (const ripple of STATE.pulseLineRipples) {
                            const dist = Math.abs(pt.t - ripple.pos);
                            if (dist < ripple.width) {
                                rippleD += Math.cos((dist / ripple.width) * Math.PI) * 0.5 * ripple.amplitude * ripple.alpha;
                            }
                        }
                        sinePts.push({ x: pt.x, y: cy + (sineVal + rippleD) * sign });
                    }
                    ctx.beginPath();
                    ctx.moveTo(sinePts[0].x, sinePts[0].y);
                    for (let i = 1; i < sinePts.length; i++) {
                        const prev = sinePts[i-1], curr = sinePts[i];
                        ctx.quadraticCurveTo(prev.x, prev.y, (prev.x+curr.x)/2, (prev.y+curr.y)/2);
                    }
                    ctx.strokeStyle = grad;
                    ctx.lineWidth = (lineW + ve * 3) * 2;
                    ctx.globalAlpha = 0.1 * mirrorAlpha;
                    ctx.stroke();
                    ctx.lineWidth = lineW + ve * 2;
                    ctx.globalAlpha = (0.6 + se * 0.4) * mirrorAlpha;
                    ctx.stroke();
                    ctx.strokeStyle = gradW;
                    ctx.lineWidth = Math.max(0.5, lineW * 0.3);
                    ctx.globalAlpha = (0.2 + ve * 0.5) * mirrorAlpha;
                    ctx.stroke();
                    break;
                }

                // ============================================================
                // NOISE
                // ============================================================
                case 'noise': {
                    for (let pass = 0; pass < 3; pass++) {
                        const spread = [0.3, 0.7, 1.2][pass];
                        const alphaM = [0.5, 0.3, 0.12][pass];
                        const widthM = [1, 1.5, 3][pass];
                        ctx.beginPath();
                        ctx.moveTo(pts[0].x, cy);
                        for (let i = 1; i < pts.length; i++) {
                            const pt = pts[i];
                            const noise = (Math.random() - 0.5) * 2;
                            let envFade;
                            if (layout === 'full') { envFade = Math.sin(pt.t * Math.PI); }
                            else { envFade = Math.pow(1 - pt.t, 0.7); }
                            const disp = (pt.d * 0.3 + noise * (8 + Math.abs(pt.d) * spread) * intensity) * sign * envFade;
                            ctx.lineTo(pt.x, cy + disp);
                        }
                        ctx.strokeStyle = pass === 0 ? grad : grad2;
                        ctx.lineWidth = (lineW + ve) * widthM;
                        ctx.globalAlpha = alphaM * mirrorAlpha * (0.4 + se * 0.6);
                        ctx.stroke();
                    }
                    break;
                }

                // ============================================================
                // HEARTBEAT - audio-reactive EKG
                // ============================================================
                case 'heartbeat': {
                    const beatSpacing = 80 + (1 - ve) * 60;
                    ctx.beginPath();
                    let px = 0;
                    for (let i = 0; i < pts.length; i++) {
                        const pt = pts[i];
                        px += segStep;
                        let envFade;
                        if (layout === 'full') { envFade = Math.sin(pt.t * Math.PI); }
                        else { envFade = Math.pow(1 - pt.t, 0.7); }
                        const phase = px % beatSpacing;
                        const norm = phase / beatSpacing;
                        // Audio-driven amplitude: use actual displacement
                        const amp = (40 + Math.abs(pt.d) * 2) * intensity;
                        let y = cy;

                        if (norm < 0.1) {
                            y = cy;
                        } else if (norm < 0.15) {
                            const pv = (norm - 0.1) / 0.05;
                            y = cy - Math.sin(pv * Math.PI) * amp * 0.08 * sign * envFade;
                        } else if (norm < 0.2) {
                            y = cy;
                        } else if (norm < 0.23) {
                            const q = (norm - 0.2) / 0.03;
                            y = cy + Math.sin(q * Math.PI) * amp * 0.12 * sign * envFade;
                        } else if (norm < 0.3) {
                            const r = (norm - 0.23) / 0.07;
                            y = cy - Math.sin(r * Math.PI) * amp * sign * envFade;
                        } else if (norm < 0.35) {
                            const s = (norm - 0.3) / 0.05;
                            y = cy + Math.sin(s * Math.PI) * amp * 0.25 * sign * envFade;
                        } else if (norm < 0.45) {
                            y = cy;
                        } else if (norm < 0.55) {
                            const tw = (norm - 0.45) / 0.1;
                            y = cy - Math.sin(tw * Math.PI) * amp * 0.15 * sign * envFade;
                        } else {
                            y = cy;
                        }

                        for (const ripple of STATE.pulseLineRipples) {
                            const dist = Math.abs(pt.t - ripple.pos);
                            if (dist < ripple.width) {
                                y += Math.cos((dist / ripple.width) * Math.PI) * 0.5 * ripple.amplitude * ripple.alpha * sign;
                            }
                        }

                        if (i === 0) ctx.moveTo(pt.x, y);
                        else ctx.lineTo(pt.x, y);
                    }
                    // Glow
                    ctx.strokeStyle = grad;
                    ctx.lineWidth = (lineW + ve * 2) * 2.5;
                    ctx.globalAlpha = 0.1 * mirrorAlpha;
                    ctx.lineJoin = 'round';
                    ctx.stroke();
                    // Core
                    ctx.lineWidth = lineW + ve * 1.5;
                    ctx.globalAlpha = (0.7 + se * 0.3) * mirrorAlpha;
                    ctx.stroke();
                    // Hot line
                    ctx.strokeStyle = gradW;
                    ctx.lineWidth = Math.max(0.5, lineW * 0.2);
                    ctx.globalAlpha = (0.15 + ve * 0.35) * mirrorAlpha;
                    ctx.stroke();
                    break;
                }

                default: break;
                } // end switch
            } // end mirror loop
        } // end runs loop

        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        ctx.restore();

        // Update ripples
        for (let i = STATE.pulseLineRipples.length - 1; i >= 0; i--) {
            const r = STATE.pulseLineRipples[i];
            r.pos += r.speed;
            r.alpha *= 0.97;
            r.amplitude *= 0.98;
            if (r.pos > 1.2 || r.alpha < 0.01) {
                STATE.pulseLineRipples.splice(i, 1);
            }
        }
    }

    // --- VIGNETTE ---
    drawVignette(ctx, w, h, cx, cy) {
        const radius = Math.max(w, h) * 0.7;
        const grad = ctx.createRadialGradient(cx, cy, radius * 0.3, cx, cy, radius);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(1, 'rgba(0,0,0,0.6)');
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
        // IMPORTANT: push the toBlob *promise* (not the resolved blob) so the
        // array preserves capture order. Without this, toBlob callbacks can
        // resolve out of order (their encode time varies), which shifts the
        // final video relative to the audio and makes it look like the audio
        // starts before the visual.
        if (STATE.recordingPng && STATE.pngFrames.length < STATE.pngFrameCap) {
            if (STATE.pngAlpha) {
                // Transparent frames: render to an offscreen alpha canvas without
                // drawing the background. Matches Exporter.screenshot(true) behavior.
                if (!this._alphaCanvas || this._alphaCanvas.width !== this.w || this._alphaCanvas.height !== this.h) {
                    this._alphaCanvas = document.createElement('canvas');
                    this._alphaCanvas.width = this.w;
                    this._alphaCanvas.height = this.h;
                    this._alphaCtx = this._alphaCanvas.getContext('2d', { alpha: true });
                }
                this.render(this._alphaCtx, this.w, this.h, data.freq, true);
                STATE.pngFrames.push(new Promise(res => {
                    this._alphaCanvas.toBlob(b => res(b), 'image/png');
                }));
            } else {
                STATE.pngFrames.push(new Promise(res => {
                    this.c.toBlob(b => res(b), 'image/png');
                }));
            }
        }
        // JSON frame data capture
        if (STATE.recordingJson) {
            STATE.jsonFrames.push({
                time: audio.el.currentTime || 0,
                voiceEnergy: Math.round(STATE.voiceEnergy*1000)/1000,
                isEmphasis: STATE.isEmphasis,
                bands: Array.from(this.getVoiceBands(data.freq, 32)).map(v => Math.round(v*1000)/1000)
            });
        }
    }
}
