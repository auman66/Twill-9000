// ============================================================
// STAGE BRIDGE - Twill 9000
// ============================================================
//
// Runs on stage.html only. The audience-facing surface: canvas-only,
// no UI chrome, driven by an optional preset JSON and runtime
// postMessage commands from a parent frame (e.g. interactive_presenter
// Stage View).
//
// Message protocol (all messages sent with `window.postMessage`):
//
//   Parent -> stage:
//     { type: 'viz:set-config',   patch: {<partial CONFIG>} }
//     { type: 'viz:set-shape',    shape: 'circle'|'random'|'svg-N'|'custom' }
//     { type: 'viz:set-palette',  palette: 'cyan'|'fire'|... }
//     { type: 'viz:load-preset',  preset: {<full CONFIG snapshot>} }
//     { type: 'viz:start-mic' }
//     { type: 'viz:stop-mic' }
//     { type: 'viz:ping' }
//
//   Stage -> parent:
//     { type: 'viz:ready',  palettes: [...], shapes: [...] }
//     { type: 'viz:pong',   at: <epoch ms> }
//     { type: 'viz:error',  error: '<msg>' }
//
// Origin handling: by default, all origins are accepted (local-only
// deployment). To lock it down, set ?allow=<origin> in the query
// string or window.STAGE_ALLOWED_ORIGIN.
// ============================================================

(function () {
    'use strict';

    const params = new URLSearchParams(window.location.search);
    const allowedOrigin = params.get('allow')
        || window.STAGE_ALLOWED_ORIGIN
        || '*';

    // -------- boot --------
    const boot = async () => {
        window.audio = new AudioEngine();
        window.viz = new Visualizer(document.getElementById('canvas'));

        // Preset: default.json (if present) then ?preset=<url> override
        // then window.STAGE_PRESET (for inline injection in tests).
        const presetUrl = params.get('preset') || 'presets/default.json';
        if (presetUrl) {
            try {
                const r = await fetch(presetUrl, { cache: 'no-cache' });
                if (r.ok) {
                    const data = await r.json();
                    applyPatch(data);
                }
            } catch (e) {
                // Non-fatal: stage just uses CONFIG defaults.
                console.warn('[stage] preset load failed:', e.message);
            }
        }
        if (window.STAGE_PRESET) applyPatch(window.STAGE_PRESET);

        viz.loop();

        // Unlock overlay: browsers require a user gesture to start
        // audio. Click anywhere to resume + start mic if configured.
        const unlock = document.getElementById('stage-unlock');
        const unlockOnce = () => {
            audio.resume();
            if (unlock) unlock.classList.add('hidden');
            window.removeEventListener('pointerdown', unlockOnce);
            window.removeEventListener('keydown', unlockOnce);
        };
        window.addEventListener('pointerdown', unlockOnce);
        window.addEventListener('keydown', unlockOnce);

        // Announce readiness to any parent frame.
        announceReady();
    };

    // -------- message dispatch --------
    window.addEventListener('message', (ev) => {
        if (allowedOrigin !== '*' && ev.origin !== allowedOrigin) return;
        const msg = ev.data;
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        if (!msg.type.startsWith('viz:')) return;

        try {
            handle(msg);
        } catch (e) {
            post({ type: 'viz:error', error: e.message });
        }
    });

    function handle(msg) {
        switch (msg.type) {
            case 'viz:set-config':
                applyPatch(msg.patch);
                break;
            case 'viz:set-shape':
                applyShape(msg.shape);
                break;
            case 'viz:set-palette':
                if (typeof msg.palette === 'string' && PALETTES[msg.palette]) {
                    CONFIG.palette = msg.palette;
                }
                break;
            case 'viz:load-preset':
                // Full replace (still deep-merged; we don't wipe
                // the reactive STATE).
                applyPatch(msg.preset);
                break;
            case 'viz:start-mic':
                audio.startMic();
                break;
            case 'viz:stop-mic':
                audio.stopMic();
                break;
            case 'viz:ping':
                post({ type: 'viz:pong', at: Date.now() });
                break;
            default:
                // Unknown viz:* message — ignore quietly for
                // forward-compat.
                break;
        }
    }

    // -------- helpers --------
    function applyPatch(patch) {
        if (!patch || typeof patch !== 'object') return;
        CONFIG_UTILS.deepMerge(CONFIG, patch);
        // If the patch changed the active shape to an SVG id, load
        // its Path2D.
        if (typeof patch.shape === 'string') applyShape(patch.shape);
        // Audio engine needs a re-sync if fftSize / smoothing changed.
        if (patch.fftSize != null || patch.smoothing != null) audio.update();
    }

    function applyShape(shape) {
        if (typeof shape !== 'string') return;
        CONFIG.shape = shape;
        if (shape.startsWith('svg-')) {
            const id = parseInt(shape.split('-')[1], 10);
            const svg = SVG_SHAPES.find((s) => s.id === id);
            if (svg) loadSvgShape(svg);
        }
    }

    // Mirrors UI.loadSvgShape, but lives here so stage.html doesn't
    // need to load ui.js at all.
    function loadSvgShape(svgData) {
        const vbParts = svgData.vb.split(/[\s,]+/).map(Number);
        const svgW = vbParts[2];
        const svgH = vbParts[3];
        const maxDim = Math.max(svgW, svgH);
        const svgScale = 2 / maxDim;
        const path2d = new Path2D(svgData.d);

        const rough = new Path2D();
        rough.addPath(path2d, new DOMMatrix().translate(-svgW / 2, -svgH / 2));

        const size = 200;
        const oc = document.createElement('canvas');
        oc.width = size;
        oc.height = size;
        const octx = oc.getContext('2d');
        const scale = (size * 0.4) * svgScale;
        octx.translate(size / 2, size / 2);
        octx.scale(scale, scale);
        octx.fillStyle = '#fff';
        octx.fill(rough);

        const img = octx.getImageData(0, 0, size, size).data;
        let sumX = 0, sumY = 0, count = 0;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (img[(y * size + x) * 4] > 128) {
                    sumX += x;
                    sumY += y;
                    count++;
                }
            }
        }
        const centroidPx = count > 0 ? sumX / count : size / 2;
        const centroidPy = count > 0 ? sumY / count : size / 2;
        const offsetX = (centroidPx - size / 2) / scale;
        const offsetY = (centroidPy - size / 2) / scale;

        const centered = new Path2D();
        centered.addPath(path2d, new DOMMatrix().translate(-svgW / 2 - offsetX, -svgH / 2 - offsetY));
        STATE.customSvgPath = centered;
        STATE.customSvgScale = svgScale;
        STATE.svgEdgeCache = { shapeKey: null, bars: 0, distances: null };
    }

    function announceReady() {
        post({
            type: 'viz:ready',
            palettes: Object.keys(PALETTES),
            shapes: ['circle', 'random']
                .concat(SVG_SHAPES.map((s) => 'svg-' + s.id))
        });
    }

    function post(msg) {
        // Prefer the direct parent if framed; fall back to opener
        // for the popup case. With `*` we're explicit that these are
        // unprivileged readiness/error frames.
        const target = window.parent !== window ? window.parent : window.opener;
        if (target) {
            try { target.postMessage(msg, allowedOrigin); } catch (e) { /* ignore */ }
        }
    }

    // Minimal UI shim so audio.js calls that reference UI.toast /
    // UI.updatePlay / UI.updateSeek are safe (we also already made
    // those calls null-tolerant in audio.js; this is belt-and-braces).
    if (typeof window.UI === 'undefined') {
        window.UI = {
            toast(msg) { console.log('[stage]', msg); },
            updatePlay() { /* no-op on stage */ },
            updateSeek() { /* no-op on stage */ }
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
