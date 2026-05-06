// ============================================================
// EXPORTER - Twill 9000
// ============================================================

// Audio fade-out at end of recorded clips. Set to 0 to disable \u2014 the
// visualizer's natural decay handles the tail cleanly, and any imposed
// ramp makes the center shape appear to fade/dissolve alongside the audio.
const FADE = {
    OUT_MS: 0
};

// Auto-recording cool-down window. After the audio ends we keep recording
// for at least MIN_TAIL_MS so the visualizer can relax back toward rest,
// then keep going (polling each rAF) until the analyser's raw frequency
// data has decayed, capped at MAX_TAIL_MS.
const COOLDOWN = {
    MIN_TAIL_MS: 500,
    MAX_TAIL_MS: 2000,
    // Max single-bin freq value (0-255) that counts as "settled". The bars
    // are rendered directly from these samples so this correlates with
    // what you actually see on screen, unlike voiceEnergy which is an
    // RMS aggregate that decays on its own timeline.
    FREQ_MAX_THRESHOLD: 8,
    MAX_ACTIVE_RINGS: 0             // require all burst rings to have expired
};

const Exporter = {
    // Expose the fade constants so callers can await them precisely.
    FADE,

    // Fade-out helper. Ramps the pre-analyser gain from its current value
    // down to silence across FADE.OUT_MS. No-op when FADE.OUT_MS is 0 (the
    // current default) so callers can invoke unconditionally.
    triggerFadeOut() {
        if (FADE.OUT_MS > 0) audio.fadeOut(FADE.OUT_MS);
    },

    screenshot(transparent) {
        const c = document.createElement('canvas');
        c.width = viz.w; c.height = viz.h;
        const ctx = c.getContext('2d', { alpha: transparent });
        viz.render(ctx, viz.w, viz.h, audio.freq, transparent);
        c.toBlob(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `twill9000_${transparent?'alpha_':''}${Date.now()}.png`;
            a.click(); URL.revokeObjectURL(a.href);
        }, 'image/png');
        UI.toast(transparent ? 'Transparent PNG saved' : 'Screenshot saved');
    },

    startVideo() {
        if (STATE.recording) { this.stopVideo(); return; }
        try {
            const stream = viz.c.captureStream(30);
            try {
                const audioStream = audio.dest.stream;
                audioStream.getAudioTracks().forEach(t => stream.addTrack(t));
            } catch(e) { /* no audio track is ok */ }

            // Try codecs in order of preference
            let options = { videoBitsPerSecond: 8000000 };
            const codecs = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
            for (const codec of codecs) {
                if (MediaRecorder.isTypeSupported(codec)) { options.mimeType = codec; break; }
            }

            const mr = new MediaRecorder(stream, options);
            STATE.recordedChunks = [];
            mr.ondataavailable = e => { if (e.data.size > 0) STATE.recordedChunks.push(e.data); };
            mr.onstop = () => {
                const mimeType = mr.mimeType || 'video/webm';
                const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
                const blob = new Blob(STATE.recordedChunks, { type: mimeType });
                // If batch mode (or any caller) pre-registered a resolver, hand
                // them the blob + metadata and skip the auto-download. Otherwise
                // trigger the normal one-shot download.
                const resolver = this.nextVideoResolver;
                this.nextVideoResolver = null;
                if (resolver) {
                    resolver({ blob, ext, mimeType });
                } else {
                    const filename = `twill9000_${Date.now()}.${ext}`;
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = filename;
                    a.click(); URL.revokeObjectURL(a.href);
                    UI.toast('Video saved');
                    // Pre-fill the chromakey input so the user can one-click
                    // copy the chromakey command without having to re-type
                    // the filename.
                    const ckInput = document.getElementById('chromakey-input-file');
                    if (ckInput && !ckInput.value) ckInput.value = filename;
                }
                document.getElementById('btn-record-video').textContent = 'Record Video';
                document.getElementById('btn-record-video').classList.remove('active');
            };
            mr.onerror = e => {
                UI.toast('Recording error: ' + e.error);
                document.getElementById('btn-record-video').textContent = 'Record Video';
                document.getElementById('btn-record-video').classList.remove('active');
                STATE.recording = false;
            };
            mr.start(100);
            STATE.recording = true;
            STATE.mediaRecorder = mr;
            document.getElementById('btn-record-video').textContent = 'Stop Recording';
            document.getElementById('btn-record-video').classList.add('active');
            UI.toast('Recording started (' + (options.mimeType || 'default') + ')');
        } catch(e) {
            UI.toast('Recording failed: ' + e.message);
        }
    },

    stopVideo() {
        if (STATE.mediaRecorder) { STATE.mediaRecorder.stop(); STATE.recording = false; STATE.mediaRecorder = null; }
    },

    // Hybrid cool-down used by auto-record flows (both WebM and PNG sequence).
    // Always waits MIN_TAIL_MS, then polls the analyser's raw freq buffer
    // (what the bars actually render from) until it's at rest OR we hit
    // MAX_TAIL_MS. Also checks active pulse rings so big end-of-clip bursts
    // are given time to fade. Tolerates missing STATE fields.
    waitForCooldown() {
        return new Promise(resolve => {
            const started = performance.now();
            const tick = () => {
                const elapsed = performance.now() - started;
                // Hard cap: don't hold the recorder open forever.
                if (elapsed >= COOLDOWN.MAX_TAIL_MS) return resolve();
                // Minimum tail always runs, then we start checking.
                if (elapsed >= COOLDOWN.MIN_TAIL_MS) {
                    // Peak bin value across the voice range. The bars are a
                    // direct readout of `freq`, so this is what the viewer
                    // sees (unlike voiceEnergy, which is a separate smoother).
                    let peak = 0;
                    const f = audio?.freq;
                    if (f) {
                        const end = Math.min(186, f.length);
                        for (let i = 4; i < end; i++) if (f[i] > peak) peak = f[i];
                    }
                    const rings = STATE.pulseRings?.length || 0;
                    if (peak < COOLDOWN.FREQ_MAX_THRESHOLD && rings <= COOLDOWN.MAX_ACTIVE_RINGS) {
                        return resolve();
                    }
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
    },

    startPng() {
        if (STATE.recordingPng) { this.stopPng(); return; }
        STATE.pngFrames = [];
        STATE.recordingPng = true;
        // Snapshot the alpha setting at start so the Assembler's metadata
        // matches what was actually captured, even if the user toggles mid-run.
        STATE.pngAlphaAtStart = !!STATE.pngAlpha;
        document.getElementById('btn-record-png').textContent = '\u2B1B Stop (building zip...)';
        document.getElementById('btn-record-png').classList.add('active');
        UI.toast('Recording PNG frames (max 30s @ 30fps)');
    },

    // Options bag:
    //   filename : override the default `twill9000_pngseq_<ts>.zip`
    //   skipDownload : if true, build the zip and return it without triggering
    //                  a browser download. Batch mode uses this so it can
    //                  control exactly when each file hits the disk.
    // Returns { blob, filename, frameCount }.
    async stopPng(opts = {}) {
        STATE.recordingPng = false;
        const btn = document.getElementById('btn-record-png');
        btn.textContent = 'Building ZIP...';
        // STATE.pngFrames contains Promises<Blob> pushed in capture order by
        // the visualizer loop. We resolve them all here so frames are
        // guaranteed to appear in the ZIP in the order they were captured.
        // (Each promise was created synchronously with canvas.toBlob, but the
        // blob arrival is async; awaiting in order realigns everything.)
        const pending = STATE.pngFrames.slice();
        document.getElementById('export-status').textContent = `${pending.length} frames captured, finalizing...`;
        const blobs = await Promise.all(pending);
        const files = [];
        for (let i = 0; i < blobs.length; i++) {
            const blob = blobs[i];
            if (!blob) continue;  // skip any that failed to encode
            const buf = await blob.arrayBuffer();
            files.push({ name: `frame_${String(i).padStart(5,'0')}.png`, data: new Uint8Array(buf) });
        }
        const zipFilename = opts.filename || `twill9000_pngseq_${Date.now()}.zip`;
        // Stash decoded frame bytes for in-browser video assembly. This survives
        // the pngFrames clear below so "Assemble video" can use them without
        // re-parsing the ZIP.
        STATE.lastPngCapture = {
            frames: files.map(f => f.data),
            transparent: !!STATE.pngAlphaAtStart,
            capturedAt: Date.now(),
            zipFilename
        };
        if (typeof Assembler !== 'undefined') Assembler.onPngCaptureReady();

        const zip = this.buildZip(files);
        if (!opts.skipDownload) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(zip);
            a.download = zipFilename;
            a.click(); URL.revokeObjectURL(a.href);
            UI.toast(`Exported ${files.length} frames as ZIP`);
        }
        btn.textContent = 'Record PNG Sequence';
        btn.classList.remove('active');
        STATE.pngFrames = [];
        document.getElementById('export-status').textContent = '';
        return { blob: zip, filename: zipFilename, frameCount: files.length };
    },

    startJson() {
        if (STATE.recordingJson) { this.stopJson(); return; }
        STATE.jsonFrames = [];
        STATE.recordingJson = true;
        document.getElementById('btn-export-json').textContent = '\u2B1B Stop Recording Data';
        document.getElementById('btn-export-json').classList.add('active');
        UI.toast('Recording frame data');
    },

    stopJson() {
        STATE.recordingJson = false;
        const json = JSON.stringify({
            generator: 'Twill 9000 Stage',
            sampleRate: audio.ctx.sampleRate,
            fftSize: CONFIG.fftSize,
            voiceMode: CONFIG.voiceMode,
            totalFrames: STATE.jsonFrames.length,
            frames: STATE.jsonFrames
        }, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `twill9000_framedata_${Date.now()}.json`;
        a.click(); URL.revokeObjectURL(a.href);
        document.getElementById('btn-export-json').textContent = 'Export Frame Data (JSON)';
        document.getElementById('btn-export-json').classList.remove('active');
        UI.toast(`Exported ${STATE.jsonFrames.length} frames of data`);
        STATE.jsonFrames = [];
    },

    // Minimal ZIP builder (STORE method, no compression)
    buildZip(files) {
        let offset = 0;
        const enc = new TextEncoder();
        const entries = files.map(f => {
            const name = enc.encode(f.name);
            const crc = this.crc32(f.data);
            const localOff = offset;
            offset += 30 + name.length + f.data.length;
            return { name, data: f.data, crc, localOff };
        });
        const cdOffset = offset;
        let cdSize = 0;
        entries.forEach(e => cdSize += 46 + e.name.length);
        const total = offset + cdSize + 22;
        const buf = new ArrayBuffer(total);
        const v = new DataView(buf);
        const u8 = new Uint8Array(buf);
        let p = 0;
        // Local file headers + data
        entries.forEach(e => {
            v.setUint32(p,0x04034b50,true); p+=4;
            v.setUint16(p,20,true); p+=2; v.setUint16(p,0,true); p+=2;
            v.setUint16(p,0,true); p+=2; v.setUint16(p,0,true); p+=2; v.setUint16(p,0,true); p+=2;
            v.setUint32(p,e.crc,true); p+=4;
            v.setUint32(p,e.data.length,true); p+=4; v.setUint32(p,e.data.length,true); p+=4;
            v.setUint16(p,e.name.length,true); p+=2; v.setUint16(p,0,true); p+=2;
            u8.set(e.name,p); p+=e.name.length;
            u8.set(e.data,p); p+=e.data.length;
        });
        // Central directory
        entries.forEach(e => {
            v.setUint32(p,0x02014b50,true); p+=4;
            v.setUint16(p,20,true); p+=2; v.setUint16(p,20,true); p+=2;
            v.setUint16(p,0,true); p+=2; v.setUint16(p,0,true); p+=2;
            v.setUint16(p,0,true); p+=2; v.setUint16(p,0,true); p+=2;
            v.setUint32(p,e.crc,true); p+=4;
            v.setUint32(p,e.data.length,true); p+=4; v.setUint32(p,e.data.length,true); p+=4;
            v.setUint16(p,e.name.length,true); p+=2;
            v.setUint16(p,0,true); p+=2; v.setUint16(p,0,true); p+=2;
            v.setUint16(p,0,true); p+=2; v.setUint16(p,0,true); p+=2;
            v.setUint32(p,0,true); p+=4;
            v.setUint32(p,e.localOff,true); p+=4;
            u8.set(e.name,p); p+=e.name.length;
        });
        // EOCD
        v.setUint32(p,0x06054b50,true); p+=4;
        v.setUint16(p,0,true); p+=2; v.setUint16(p,0,true); p+=2;
        v.setUint16(p,entries.length,true); p+=2; v.setUint16(p,entries.length,true); p+=2;
        v.setUint32(p,cdSize,true); p+=4; v.setUint32(p,cdOffset,true); p+=4;
        v.setUint16(p,0,true);
        return new Blob([buf], { type: 'application/zip' });
    },

    crc32(data) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < data.length; i++) {
            c ^= data[i];
            for (let j = 0; j < 8; j++) c = (c>>>1)^(c&1?0xEDB88320:0);
        }
        return (c^0xFFFFFFFF)>>>0;
    }
};
