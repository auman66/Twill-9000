// ============================================================
// UI - Twill 9000
// ============================================================

const UI = {
    init() {
        // Mode grid (optional, may not exist in simplified sidebar)
        const mg = document.getElementById('mode-grid');
        if (mg) {
            MODE_NAMES.forEach((name, i) => {
                const btn = document.createElement('div');
                btn.className = 'mode-btn' + (i===0?' active':'');
                btn.textContent = name;
                btn.onclick = () => { STATE.mode = i; this.updateMode(); };
                mg.appendChild(btn);
            });
        }

        // Bind events
        document.getElementById('btn-upload').onclick = () => document.getElementById('file-input').click();
        document.getElementById('file-input').onchange = e => this.handleFile(e.target.files[0]);
        document.getElementById('btn-play').onclick = () => audio.toggle();
        document.getElementById('btn-stop').onclick = () => audio.stop();
        document.getElementById('btn-mic').onclick = () => { audio.mic ? audio.stopMic() : audio.startMic(); };
        document.getElementById('seek-bar').oninput = e => { if (audio.el.duration) audio.el.currentTime = (e.target.value/100)*audio.el.duration; };
        const volSlider = document.getElementById('vol-slider');
        const volNum = document.getElementById('vol-slider-num');
        volSlider.oninput = () => { audio.update(); if (volNum) volNum.value = volSlider.value; };
        if (volNum) volNum.oninput = () => { volSlider.value = volNum.value; audio.update(); };
        document.getElementById('toggle-sidebar').onclick = () => {
            const sb = document.getElementById('sidebar');
            sb.classList.toggle('collapsed');
            document.getElementById('toggle-sidebar').textContent = sb.classList.contains('collapsed') ? '\u25B6' : '\u25C0';
            setTimeout(() => viz.resize(), 200);
        };

        // Settings
        // Helper: sync range slider with number input
        const syncNum = (rangeEl) => {
            const numEl = document.getElementById(rangeEl.id + '-num');
            if (!numEl) return;
            numEl.value = rangeEl.value;
            rangeEl.addEventListener('input', () => { numEl.value = rangeEl.value; });
            numEl.addEventListener('input', () => { rangeEl.value = numEl.value; rangeEl.dispatchEvent(new Event('input')); });
        };

        const link = (id, key, type) => {
            const el = document.getElementById(id); if (!el) return;
            el.oninput = el.onchange = e => {
                CONFIG[key] = type==='bool'?e.target.checked : type==='int'?parseInt(e.target.value) : type==='str'?e.target.value : parseFloat(e.target.value);
                if (key === 'smoothing' || key === 'fftSize') audio.update();
                this.saveToStorage();
            };
            if (el.type === 'range') syncNum(el);
        };
        link('s-voice-mode','voiceMode','bool');
        link('s-sensitivity','sensitivity','float');
        link('s-smoothing','voiceSmoothing','float');
        link('s-palette','palette','str');
        link('s-radial-bars','radialBars','int');
        link('s-radial-radius','radialRadius','float');
        link('s-ring-separation','ringSeparation','float');
        link('s-shape-speed','shapeSpeed','float');
        link('s-shape-change-point','shapeChangePoint','float');

        // FX toggle/slider bindings
        const fxLink = (id, key, type) => {
            const el = document.getElementById(id); if (!el) return;
            el.oninput = el.onchange = e => {
                CONFIG.fx[key] = type==='bool' ? e.target.checked : type==='int' ? parseInt(e.target.value) : type==='str' ? e.target.value : parseFloat(e.target.value);
                this.saveToStorage();
            };
            if (el.type === 'range') syncNum(el);
        };
        fxLink('s-fx-show-shape', 'showShape', 'bool');
        fxLink('s-fx-show-bars', 'showBars', 'bool');
        fxLink('s-fx-rotate', 'rotate', 'bool');
        fxLink('s-fx-rotate-speed', 'rotateSpeed', 'float');
        fxLink('s-fx-glow', 'glow', 'bool');
        fxLink('s-fx-glow-strength', 'glowStrength', 'int');
        fxLink('s-fx-trails', 'trails', 'bool');
        fxLink('s-fx-trail-alpha', 'trailAlpha', 'float');
        fxLink('s-fx-pulse-rings', 'pulseRings', 'bool');
        fxLink('s-fx-particles', 'particles', 'bool');
        fxLink('s-fx-gradient-bars', 'gradientBars', 'bool');
        fxLink('s-fx-bar-width', 'barWidth', 'int');
        fxLink('s-fx-rounded-bars', 'roundedBars', 'bool');
        fxLink('s-fx-vignette', 'vignette', 'bool');
        fxLink('s-fx-bg-pulse', 'bgPulse', 'bool');
        fxLink('s-fx-pulse-lines', 'pulseLines', 'bool');
        fxLink('s-fx-pulse-line-style', 'pulseLineStyle', 'str');
        fxLink('s-fx-pulse-line-layout', 'pulseLineLayout', 'str');
        fxLink('s-fx-pulse-line-width', 'pulseLineWidth', 'float');
        fxLink('s-fx-pulse-line-intensity', 'pulseLineIntensity', 'float');
        fxLink('s-fx-pulse-line-mirror', 'pulseLineMirror', 'bool');
        fxLink('s-fx-pulse-line-fill', 'pulseLineFill', 'bool');
        fxLink('s-fx-pulse-line-sensitivity', 'pulseLineSensitivity', 'float');
        fxLink('s-fx-pulse-line-smoothing', 'pulseLineSmoothing', 'float');

        // Pulse line color picker
        const plColorInput = document.getElementById('s-fx-pulse-line-color');
        const plAutoToggle = document.getElementById('s-fx-pulse-line-color-auto');
        plAutoToggle.onchange = () => {
            CONFIG.fx.pulseLineColor = plAutoToggle.checked ? null : plColorInput.value;
            this.saveToStorage();
        };
        plColorInput.oninput = () => {
            if (!plAutoToggle.checked) CONFIG.fx.pulseLineColor = plColorInput.value;
            this.saveToStorage();
        };

        // --- Shape grid ---
        const shapeGrid = document.getElementById('shape-grid');
        const svgFileInput = document.getElementById('svg-file-input');
        if (!shapeGrid || !svgFileInput) { console.warn('Shape grid elements missing'); }

        // Helper: select a shape and highlight it
        const selectShape = (key) => {
            CONFIG.shape = key;
            shapeGrid.querySelectorAll('.shape-thumb').forEach(el => {
                el.classList.toggle('active', el.dataset.shape === key);
            });
            document.getElementById('btn-shape-random').classList.toggle('active', key === 'random');
            // If it's an SVG shape, load its Path2D
            if (key.startsWith('svg-')) {
                const id = parseInt(key.split('-')[1]);
                const svg = SVG_SHAPES.find(s => s.id === id);
                if (svg) this.loadSvgShape(svg);
            }
        };

        // Helper: create a thumbnail button
        const addThumb = (key, svgContent) => {
            const el = document.createElement('div');
            el.className = 'shape-thumb' + (CONFIG.shape === key ? ' active' : '');
            el.dataset.shape = key;
            el.innerHTML = svgContent;
            el.onclick = () => selectShape(key);
            shapeGrid.appendChild(el);
        };

        // Add circle shape
        addThumb('circle', '<svg viewBox="-1 -1 2 2"><circle r="0.8" fill="currentColor"/></svg>');

        // Add SVG library shapes
        SVG_SHAPES.forEach(s => {
            const svgEl = '<svg viewBox="' + s.vb + '"><path d="' + s.d + '" fill="currentColor"/></svg>';
            addThumb('svg-' + s.id, svgEl);
        });

        // Random button
        document.getElementById('btn-shape-random').onclick = () => selectShape('random');

        // Custom SVG upload
        document.getElementById('btn-shape-upload').onclick = () => svgFileInput.click();
        svgFileInput.onchange = e => {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(ev.target.result, 'image/svg+xml');
                    const paths = doc.querySelectorAll('path');
                    if (!paths.length) { this.toast('No paths found in SVG'); return; }
                    let combinedD = '';
                    paths.forEach(p => { combinedD += p.getAttribute('d') + ' '; });
                    const path2d = new Path2D(combinedD.trim());
                    const svg = doc.querySelector('svg');
                    let svgW = 100, svgH = 100;
                    const vb = svg?.getAttribute('viewBox');
                    if (vb) {
                        const parts = vb.split(/[\s,]+/).map(Number);
                        svgW = parts[2] || 100; svgH = parts[3] || 100;
                    } else {
                        svgW = parseFloat(svg?.getAttribute('width')) || 100;
                        svgH = parseFloat(svg?.getAttribute('height')) || 100;
                    }
                    const maxDim = Math.max(svgW, svgH);
                    const svgScale = 2 / maxDim;

                    // First pass: rough center at viewBox center
                    const rough = new Path2D();
                    rough.addPath(path2d, new DOMMatrix().translate(-svgW/2, -svgH/2));

                    // Render to offscreen canvas to find actual visual centroid
                    const cSize = 200;
                    const oc = document.createElement('canvas');
                    oc.width = cSize; oc.height = cSize;
                    const octx = oc.getContext('2d');
                    const cScale = (cSize * 0.4) * svgScale;
                    octx.translate(cSize/2, cSize/2);
                    octx.scale(cScale, cScale);
                    octx.fillStyle = '#fff';
                    octx.fill(rough);

                    const img = octx.getImageData(0, 0, cSize, cSize).data;
                    let sumX = 0, sumY = 0, count = 0;
                    for (let y = 0; y < cSize; y++) {
                        for (let x = 0; x < cSize; x++) {
                            if (img[(y * cSize + x) * 4] > 128) {
                                sumX += x; sumY += y; count++;
                            }
                        }
                    }
                    const centroidPx = count > 0 ? sumX / count : cSize/2;
                    const centroidPy = count > 0 ? sumY / count : cSize/2;
                    const offsetX = (centroidPx - cSize/2) / cScale;
                    const offsetY = (centroidPy - cSize/2) / cScale;

                    const centered = new Path2D();
                    centered.addPath(path2d, new DOMMatrix().translate(-svgW/2 - offsetX, -svgH/2 - offsetY));
                    STATE.customSvgPath = centered;
                    STATE.customSvgScale = svgScale;
                    STATE.svgEdgeCache = { shapeKey: null, bars: 0, distances: null };
                    CONFIG.shape = 'custom';
                    // Deselect grid thumbs
                    shapeGrid.querySelectorAll('.shape-thumb').forEach(el => el.classList.remove('active'));
                    document.getElementById('btn-shape-random').classList.remove('active');
                    this.toast('Custom SVG loaded: ' + file.name);
                } catch(err) {
                    this.toast('Error parsing SVG: ' + err.message);
                }
            };
            reader.readAsText(file);
        };

        // --- Shape color pickers ---
        const fillColorInput = document.getElementById('s-shape-fill-color');
        const fillAutoToggle = document.getElementById('s-shape-fill-auto');
        const strokeColorInput = document.getElementById('s-shape-stroke-color');
        const strokeAutoToggle = document.getElementById('s-shape-stroke-auto');

        fillAutoToggle.onchange = () => {
            CONFIG.shapeColor = fillAutoToggle.checked ? null : fillColorInput.value;
            this.saveToStorage();
        };
        fillColorInput.oninput = () => {
            if (!fillAutoToggle.checked) CONFIG.shapeColor = fillColorInput.value;
            this.saveToStorage();
        };
        strokeAutoToggle.onchange = () => {
            CONFIG.strokeColor = strokeAutoToggle.checked ? null : strokeColorInput.value;
            this.saveToStorage();
        };
        strokeColorInput.oninput = () => {
            if (!strokeAutoToggle.checked) CONFIG.strokeColor = strokeColorInput.value;
            this.saveToStorage();
        };

        // Hollow + bar style
        document.getElementById('s-hollow').onchange = e => { CONFIG.hollowShape = e.target.checked; this.saveToStorage(); };
        document.getElementById('s-bar-style').onchange = e => { CONFIG.barStyle = e.target.value; this.saveToStorage(); };

        // Background color
        document.getElementById('s-bg-color').oninput = e => { CONFIG.bgColor = e.target.value; this.saveToStorage(); };
        // Background image
        document.getElementById('btn-bg-image').onclick = () => document.getElementById('bg-file-input').click();
        document.getElementById('bg-file-input').onchange = e => {
            const file = e.target.files[0]; if (!file) return;
            const img = new Image();
            img.onload = () => {
                STATE.bgImageEl = img;
                document.getElementById('btn-bg-clear').style.display = '';
                this.toast('Background image set');
            };
            img.src = URL.createObjectURL(file);
        };
        document.getElementById('btn-bg-clear').onclick = () => {
            STATE.bgImageEl = null;
            document.getElementById('btn-bg-clear').style.display = 'none';
            this.toast('Background cleared');
        };

        // Export buttons
        document.getElementById('btn-screenshot').onclick = () => Exporter.screenshot(false);
        document.getElementById('btn-screenshot-alpha').onclick = () => Exporter.screenshot(true);
        document.getElementById('btn-record-video').onclick = () => Exporter.startVideo();
        document.getElementById('btn-record-png').onclick = () => Exporter.startPng();
        document.getElementById('btn-export-json').onclick = () => { STATE.recordingJson ? Exporter.stopJson() : Exporter.startJson(); };

        // Settings: save/load/reset
        document.getElementById('btn-save-preset').onclick = () => this.savePreset();
        document.getElementById('btn-load-preset').onclick = () => document.getElementById('preset-file-input').click();
        document.getElementById('preset-file-input').onchange = e => {
            const file = e.target.files[0]; if (!file) return;
            const r = new FileReader();
            r.onload = ev => {
                try {
                    const data = JSON.parse(ev.target.result);
                    this.applyConfig(data);
                    this.toast('Preset loaded: ' + file.name);
                } catch(err) { this.toast('Invalid preset file'); }
            };
            r.readAsText(file);
            e.target.value = '';
        };
        document.getElementById('btn-reset-settings').onclick = () => {
            this.applyConfig(DEFAULT_CONFIG);
            localStorage.removeItem('twill9000_settings');
            this.toast('Settings reset to defaults');
        };

        // Restore from localStorage on init
        this.loadFromStorage();

        // Drag & drop
        window.ondragover = e => { e.preventDefault(); document.getElementById('drop-overlay').style.display='flex'; };
        window.ondragleave = e => { if(!e.relatedTarget) document.getElementById('drop-overlay').style.display='none'; };
        window.ondrop = e => { e.preventDefault(); document.getElementById('drop-overlay').style.display='none'; if(e.dataTransfer.files.length) this.handleFile(e.dataTransfer.files[0]); };

        // Keyboard
        document.addEventListener('keydown', e => {
            if (e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
            if (e.code==='Space') { e.preventDefault(); audio.toggle(); }
            if (e.code==='KeyM') { STATE.mode = (STATE.mode+1)%MODE_NAMES.length; this.updateMode(); }
        });

        this.updateMode();
    },

    handleFile(file) {
        if (!file) return;
        if (file.name.endsWith('.json')) {
            const r = new FileReader(); r.onload = e => {
                try { Object.assign(CONFIG, JSON.parse(e.target.result)); this.toast('Preset loaded'); } catch(e) { this.toast('Invalid preset'); }
            }; r.readAsText(file);
        } else {
            audio.playFile(URL.createObjectURL(file));
            document.getElementById('status-text').textContent = file.name.length > 25 ? file.name.slice(0,25)+'...' : file.name;
        }
    },

    updateMode() {
        document.querySelectorAll('.mode-btn').forEach((b,i) => b.classList.toggle('active', i===STATE.mode));
        document.querySelectorAll('.mode-settings').forEach(el => el.classList.toggle('active', el.dataset.mode === String(STATE.mode)));
    },
    updatePlay() {
        document.getElementById('btn-play').textContent = STATE.playing ? '\u23F8 Pause' : '\u25B6 Play';
    },
    updateSeek() {
        if (!audio.el.duration || isNaN(audio.el.duration)) return;
        document.getElementById('seek-bar').value = (audio.el.currentTime/audio.el.duration)*100;
    },
    toast(msg) {
        const t = document.createElement('div'); t.className='toast'; t.textContent=msg;
        const container = document.getElementById('toast-container');
        if (container) container.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    },
    loadSvgShape(svgData) {
        const vbParts = svgData.vb.split(/[\s,]+/).map(Number);
        const svgW = vbParts[2], svgH = vbParts[3];
        const maxDim = Math.max(svgW, svgH);
        const svgScale = 2 / maxDim;
        const path2d = new Path2D(svgData.d);

        // First pass: rough center at viewBox center
        const rough = new Path2D();
        rough.addPath(path2d, new DOMMatrix().translate(-svgW/2, -svgH/2));

        // Render to offscreen canvas to find actual visual centroid
        const size = 200;
        const oc = document.createElement('canvas');
        oc.width = size; oc.height = size;
        const octx = oc.getContext('2d');
        const scale = (size * 0.4) * svgScale;
        octx.translate(size/2, size/2);
        octx.scale(scale, scale);
        octx.fillStyle = '#fff';
        octx.fill(rough);

        // Scan pixels to find centroid
        const img = octx.getImageData(0, 0, size, size).data;
        let sumX = 0, sumY = 0, count = 0;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (img[(y * size + x) * 4] > 128) {
                    sumX += x; sumY += y; count++;
                }
            }
        }

        // Compute centroid offset in path coordinates
        const centroidPx = count > 0 ? sumX / count : size/2;
        const centroidPy = count > 0 ? sumY / count : size/2;
        const offsetX = (centroidPx - size/2) / scale;
        const offsetY = (centroidPy - size/2) / scale;

        // Re-center path at actual visual centroid
        const centered = new Path2D();
        centered.addPath(path2d, new DOMMatrix().translate(-svgW/2 - offsetX, -svgH/2 - offsetY));
        STATE.customSvgPath = centered;
        STATE.customSvgScale = svgScale;

        // Invalidate edge cache
        STATE.svgEdgeCache = { shapeKey: null, bars: 0, distances: null };
    },

    // --- SETTINGS PERSISTENCE ---

    // Save current CONFIG as a JSON file download
    savePreset() {
        const data = CONFIG_UTILS.snapshot(CONFIG);
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `twill9000_preset_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        this.toast('Preset saved');
    },

    // Apply a config object to CONFIG and sync all UI controls
    applyConfig(data) {
        if (!data) return;
        CONFIG_UTILS.deepMerge(CONFIG, data);

        // Sync all UI controls to match CONFIG
        this.syncUIFromConfig();
        this.saveToStorage();
    },

    // Push CONFIG values into all DOM controls
    syncUIFromConfig() {
        const setVal = (id, val) => {
            const el = document.getElementById(id); if (!el) return;
            if (el.type === 'checkbox') el.checked = val;
            else el.value = val;
            // Also sync the number input if it exists
            const num = document.getElementById(id + '-num');
            if (num) num.value = val;
        };

        // Top-level CONFIG fields
        setVal('s-voice-mode', CONFIG.voiceMode);
        setVal('s-sensitivity', CONFIG.sensitivity);
        setVal('s-smoothing', CONFIG.voiceSmoothing);
        setVal('s-palette', CONFIG.palette);
        setVal('s-radial-bars', CONFIG.radialBars);
        setVal('s-radial-radius', CONFIG.radialRadius);
        setVal('s-ring-separation', CONFIG.ringSeparation);
        setVal('s-shape-speed', CONFIG.shapeSpeed);
        setVal('s-shape-change-point', CONFIG.shapeChangePoint);
        setVal('s-bg-color', CONFIG.bgColor);
        setVal('s-shape-fill-color', CONFIG.shapeColor || '#ef213a');
        setVal('s-shape-fill-auto', CONFIG.shapeColor === null);
        setVal('s-shape-stroke-color', CONFIG.strokeColor || '#1866ee');
        setVal('s-shape-stroke-auto', CONFIG.strokeColor === null);
        setVal('s-hollow', CONFIG.hollowShape);
        setVal('s-bar-style', CONFIG.barStyle);
        setVal('vol-slider', 0.8);

        // FX fields
        setVal('s-fx-show-shape', CONFIG.fx.showShape);
        setVal('s-fx-show-bars', CONFIG.fx.showBars);
        setVal('s-fx-rotate', CONFIG.fx.rotate);
        setVal('s-fx-rotate-speed', CONFIG.fx.rotateSpeed);
        setVal('s-fx-glow', CONFIG.fx.glow);
        setVal('s-fx-glow-strength', CONFIG.fx.glowStrength);
        setVal('s-fx-trails', CONFIG.fx.trails);
        setVal('s-fx-trail-alpha', CONFIG.fx.trailAlpha);
        setVal('s-fx-pulse-rings', CONFIG.fx.pulseRings);
        setVal('s-fx-particles', CONFIG.fx.particles);
        setVal('s-fx-gradient-bars', CONFIG.fx.gradientBars);
        setVal('s-fx-bar-width', CONFIG.fx.barWidth);
        setVal('s-fx-rounded-bars', CONFIG.fx.roundedBars);
        setVal('s-fx-vignette', CONFIG.fx.vignette);
        setVal('s-fx-bg-pulse', CONFIG.fx.bgPulse);
        setVal('s-fx-pulse-lines', CONFIG.fx.pulseLines);
        setVal('s-fx-pulse-line-style', CONFIG.fx.pulseLineStyle);
        setVal('s-fx-pulse-line-layout', CONFIG.fx.pulseLineLayout);
        setVal('s-fx-pulse-line-width', CONFIG.fx.pulseLineWidth);
        setVal('s-fx-pulse-line-intensity', CONFIG.fx.pulseLineIntensity);
        setVal('s-fx-pulse-line-color', CONFIG.fx.pulseLineColor || '#1866ee');
        setVal('s-fx-pulse-line-color-auto', CONFIG.fx.pulseLineColor === null);
        setVal('s-fx-pulse-line-mirror', CONFIG.fx.pulseLineMirror);
        setVal('s-fx-pulse-line-fill', CONFIG.fx.pulseLineFill);
        setVal('s-fx-pulse-line-sensitivity', CONFIG.fx.pulseLineSensitivity);
        setVal('s-fx-pulse-line-smoothing', CONFIG.fx.pulseLineSmoothing);

        // Shape grid selection
        const shapeGrid = document.getElementById('shape-grid');
        if (shapeGrid) {
            shapeGrid.querySelectorAll('.shape-thumb').forEach(el => {
                el.classList.toggle('active', el.dataset.shape === CONFIG.shape);
            });
        }
        const randomBtn = document.getElementById('btn-shape-random');
        if (randomBtn) randomBtn.classList.toggle('active', CONFIG.shape === 'random');

        // Load SVG path if needed
        if (CONFIG.shape && CONFIG.shape.startsWith('svg-')) {
            const id = parseInt(CONFIG.shape.split('-')[1]);
            const svg = SVG_SHAPES.find(s => s.id === id);
            if (svg) this.loadSvgShape(svg);
        }

        audio.update();
    },

    // Auto-save to localStorage
    saveToStorage() {
        try {
            const data = CONFIG_UTILS.snapshot(CONFIG);
            localStorage.setItem('twill9000_settings', JSON.stringify(data));
        } catch(e) { /* silent fail */ }
    },

    // Load from localStorage on startup
    loadFromStorage() {
        try {
            const raw = localStorage.getItem('twill9000_settings');
            if (raw) {
                const data = JSON.parse(raw);
                // Version check: if config structure changed, discard stale data
                if (!data.fx || typeof data.fx.pulseLineLayout === 'undefined') {
                    localStorage.removeItem('twill9000_settings');
                    return;
                }
                this.applyConfig(data);
            }
        } catch(e) { localStorage.removeItem('twill9000_settings'); }
    }
};
