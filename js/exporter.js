// ============================================================
// EXPORTER - Twill 9000
// ============================================================

const Exporter = {
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
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `twill9000_${Date.now()}.${ext}`;
                a.click(); URL.revokeObjectURL(a.href);
                UI.toast('Video saved');
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

    startPng() {
        if (STATE.recordingPng) { this.stopPng(); return; }
        STATE.pngFrames = [];
        STATE.recordingPng = true;
        document.getElementById('btn-record-png').textContent = '\u2B1B Stop (building zip...)';
        document.getElementById('btn-record-png').classList.add('active');
        UI.toast('Recording PNG frames (max 30s @ 30fps)');
    },

    async stopPng() {
        STATE.recordingPng = false;
        const btn = document.getElementById('btn-record-png');
        btn.textContent = 'Building ZIP...';
        document.getElementById('export-status').textContent = `${STATE.pngFrames.length} frames captured`;
        // Convert blobs to array buffers and build zip
        const files = [];
        for (let i = 0; i < STATE.pngFrames.length; i++) {
            const buf = await STATE.pngFrames[i].arrayBuffer();
            files.push({ name: `frame_${String(i).padStart(5,'0')}.png`, data: new Uint8Array(buf) });
        }
        const zip = this.buildZip(files);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(zip);
        a.download = `twill9000_pngseq_${Date.now()}.zip`;
        a.click(); URL.revokeObjectURL(a.href);
        btn.textContent = 'Record PNG Sequence';
        btn.classList.remove('active');
        STATE.pngFrames = [];
        UI.toast(`Exported ${files.length} frames as ZIP`);
        document.getElementById('export-status').textContent = '';
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
