// ============================================================
// ASSEMBLER - Build a copy-paste ffmpeg command for the user
// ============================================================
//
// After a PNG-sequence recording finishes we show the user the exact shell
// commands they need to run locally to produce a finished video. Three formats:
//
//   .mov  — HEVC + alpha via VideoToolbox. Mac-native (Keynote, QuickTime,
//           Safari, Final Cut). Transparent background preserved.
//   .webm — VP9 + alpha via libvpx-vp9. Plays in Chrome/Firefox, accepted by
//           Google Slides. Transparent background preserved.
//   .mp4  — H.264 opaque. Works literally everywhere. No transparency.
//
// Much more reliable than trying to run ffmpeg in the browser, which was
// blocked by cross-origin worker restrictions under a plain
// `python3 -m http.server` setup.

const Assembler = {
    FRAMERATE: 30,

    // Format registry. `needsAlpha` gates whether the button is enabled for
    // opaque recordings. `buildArgs` returns the ffmpeg argv given the inputs.
    FORMATS: {
        mov: {
            label: 'HEVC alpha (.mov)',
            ext: 'mov',
            needsAlpha: true,
            buildArgs: ({ framesDir, audio, shQuote, outBase, fps }) => [
                '-framerate', fps,
                '-i', `${framesDir}/frame_%05d.png`,
                ...(audio ? ['-i', shQuote(audio)] : []),
                '-c:v', 'hevc_videotoolbox',
                '-allow_sw', '1',
                '-alpha_quality', '0.75',
                '-vtag', 'hvc1',
                '-pix_fmt', 'bgra',
                '-b:v', '6M',
                ...(audio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
                `${outBase}.mov`
            ]
        },
        webm: {
            label: 'VP9 alpha (.webm)',
            ext: 'webm',
            needsAlpha: true,
            buildArgs: ({ framesDir, audio, shQuote, outBase, fps }) => [
                '-framerate', fps,
                '-i', `${framesDir}/frame_%05d.png`,
                ...(audio ? ['-i', shQuote(audio)] : []),
                '-c:v', 'libvpx-vp9',
                '-pix_fmt', 'yuva420p',
                '-b:v', '4M',
                // VP9 quality knobs that keep alpha visible and render cleanly
                // in Chrome/Slides. auto-alt-ref must be off or alpha breaks.
                '-auto-alt-ref', '0',
                '-lag-in-frames', '0',
                ...(audio ? ['-c:a', 'libopus', '-b:a', '192k', '-shortest'] : []),
                `${outBase}.webm`
            ]
        },
        mp4: {
            label: 'MP4 (H.264, opaque)',
            ext: 'mp4',
            needsAlpha: false,
            buildArgs: ({ framesDir, audio, shQuote, outBase, fps }) => [
                '-framerate', fps,
                '-i', `${framesDir}/frame_%05d.png`,
                ...(audio ? ['-i', shQuote(audio)] : []),
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-crf', '18',
                '-preset', 'medium',
                ...(audio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
                '-movflags', '+faststart',
                `${outBase}.mp4`
            ]
        }
    },

    init() {
        document.getElementById('btn-copy-mov')?.addEventListener('click', () => this.copyCommand('mov'));
        document.getElementById('btn-copy-webm')?.addEventListener('click', () => this.copyCommand('webm'));
        document.getElementById('btn-copy-mp4')?.addEventListener('click', () => this.copyCommand('mp4'));
    },

    // Called by Exporter.stopPng after frames land and the ZIP has been
    // downloaded, so we know the exact filename on disk.
    onPngCaptureReady() {
        const cap = STATE.lastPngCapture;
        if (!cap) return;
        const setDisabled = (id, disabled) => {
            const b = document.getElementById(id);
            if (b) b.disabled = disabled;
        };
        // Alpha-requiring formats are only enabled for transparent recordings.
        setDisabled('btn-copy-mov', !cap.transparent);
        setDisabled('btn-copy-webm', !cap.transparent);
        setDisabled('btn-copy-mp4', false);
        this.renderCommand();
    },

    // Build a safely-quoted filename for shell use.
    shQuote(name) {
        if (!name) return "''";
        return `'${name.replace(/'/g, `'\\''`)}'`;
    },

    buildCommand(format) {
        const cap = STATE.lastPngCapture;
        const spec = this.FORMATS[format];
        if (!cap || !spec) return null;
        const zip = cap.zipFilename || 'twill9000_pngseq_UNKNOWN.zip';
        const audio = STATE.lastAudioSource?.filename || null;
        const framesDir = 'frames_' + String(cap.capturedAt || Date.now());
        const outBase = `twill9000_${cap.capturedAt || Date.now()}`;

        const args = spec.buildArgs({
            framesDir,
            audio,
            shQuote: this.shQuote.bind(this),
            outBase,
            fps: String(this.FRAMERATE)
        });

        const lines = [
            `# 1. Unzip the frames into a folder`,
            `unzip ${this.shQuote(zip)} -d ${framesDir}`,
            ``,
            `# 2. Mux frames${audio ? ' + audio' : ''} into ${spec.label}`,
            `ffmpeg ${args.join(' ')}`,
        ];

        if (!audio) {
            lines.unshift(
                `# NOTE: No audio file was captured with this recording.`,
                `# The video will be silent.`,
                ``,
            );
        }
        return lines.join('\n');
    },

    renderCommand() {
        const cap = STATE.lastPngCapture;
        const pre = document.getElementById('assemble-cmd-output');
        const hint = document.getElementById('assemble-hint');
        if (!pre) return;
        if (!cap) {
            pre.textContent = '';
            pre.style.display = 'none';
            if (hint) hint.textContent = 'Record a PNG sequence to get copy-paste commands.';
            return;
        }
        // Default preview: .mov if transparent (Mac-native), else .mp4.
        const format = cap.transparent ? 'mov' : 'mp4';
        pre.textContent = this.buildCommand(format);
        pre.style.display = 'block';
        if (hint) {
            const audio = STATE.lastAudioSource?.filename ? ` + ${STATE.lastAudioSource.filename}` : ' (no audio)';
            hint.textContent = `${cap.frames.length} frames in ${cap.zipFilename}${audio}. Click a button to copy a command, then paste into Terminal.`;
        }
    },

    copyCommand(format) {
        const cap = STATE.lastPngCapture;
        const spec = this.FORMATS[format];
        if (!cap) { UI.toast('Record a PNG sequence first'); return; }
        if (!spec) return;
        if (spec.needsAlpha && !cap.transparent) {
            UI.toast(`${spec.label} requires a transparent PNG recording`);
            return;
        }
        const cmd = this.buildCommand(format);
        const pre = document.getElementById('assemble-cmd-output');
        if (pre) { pre.textContent = cmd; pre.style.display = 'block'; }

        const done = () => UI.toast(`${spec.label} command copied. Paste into Terminal.`);
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(cmd).then(done).catch(() => this.fallbackCopy(cmd, done));
        } else {
            this.fallbackCopy(cmd, done);
        }
    },

    fallbackCopy(text, done) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch { UI.toast('Copy failed — select text manually'); }
        ta.remove();
    }
};

// ============================================================
// CHROMAKEY - Convert an opaque green-screen WebM to transparent video
// ============================================================
//
// The PNG-sequence path had async timing bugs we couldn't fix in time. The
// practical alternative: record a normal opaque WebM with a pure green
// background, then chromakey the green out in post with ffmpeg. This uses
// the reliable MediaRecorder capture path so audio and video stay in sync.
//
// Workflow:
//   1. Click "Chromakey Green Preset" in the Scene section (sets bg to
//      #00ff00 and disables post-effects that would stain the green).
//   2. Record with any of the "Record Video" / "Generate, Record & Download
//      Both" buttons. You get a .webm / .mp4 file.
//   3. Paste the filename here, pick an output target, copy the command.

const Chromakey = {
    // chromakey=<color>:<similarity>:<blend>
    //   similarity ~= how far from the target color counts as key.
    //   blend      ~= softness on the edges (0 = hard cut).
    //
    // 0.12/0.04 is tighter than ffmpeg's defaults — catches green edges
    // without nibbling into visualizer colors. Combined with despill below
    // to clean up any residual green tint on semi-transparent edge pixels.
    SIMILARITY: 0.12,
    BLEND: 0.04,

    init() {
        document.getElementById('btn-chromakey-mov')?.addEventListener('click', () => this.copyCommand('mov'));
        document.getElementById('btn-chromakey-webm')?.addEventListener('click', () => this.copyCommand('webm'));
        document.getElementById('btn-chromakey-mp4')?.addEventListener('click', () => this.copyCommand('mp4'));
    },

    shQuote(name) {
        if (!name) return "''";
        return `'${name.replace(/'/g, `'\\''`)}'`;
    },

    buildCommand(format) {
        const raw = (document.getElementById('chromakey-input-file')?.value || '').trim();
        if (!raw) return null;
        // Strip quotes if user pasted with them.
        const input = raw.replace(/^["']|["']$/g, '');
        const base = input.replace(/\.[^/.]+$/, '');        // strip extension
        const ts = Date.now();
        const out = `${base}_keyed_${ts}.${format}`;

        // Optional separate MP3 for pristine audio. The WebM's built-in
        // Opus track sounds muffled after re-encoding (the source is
        // ~85kbps Opus from MediaRecorder); the original ElevenLabs MP3
        // is 128kbps and a single pass is lossless in perception.
        const audioRaw = (document.getElementById('chromakey-audio-file')?.value || '').trim();
        const audio = audioRaw ? audioRaw.replace(/^["']|["']$/g, '') : null;

        const chromaFilter = `chromakey=0x00ff00:${this.SIMILARITY}:${this.BLEND}`;
        const despillFilter = 'despill=type=green:mix=0.6';

        // Helper: build input args. If an external MP3 is provided we feed
        // it as a second input and -map the two tracks explicitly so the
        // WebM's internal audio gets ignored. We deliberately skip
        // `-shortest` so the full video (including the visualizer cool-down
        // tail after the audio ends) is preserved. Output plays audio,
        // then silence while the bars settle.
        const inputs = audio
            ? ['-i', this.shQuote(input), '-i', this.shQuote(audio)]
            : ['-i', this.shQuote(input)];
        const audioMap = audio ? ['-map', '0:v:0', '-map', '1:a:0'] : [];

        let args;
        if (format === 'mov') {
            args = [
                ...inputs,
                '-vf', `"${chromaFilter},${despillFilter},format=rgba"`,
                '-c:v', 'hevc_videotoolbox',
                '-allow_sw', '1',
                '-alpha_quality', '0.85',
                '-vtag', 'hvc1',
                '-pix_fmt', 'bgra',
                '-b:v', '10M',
                '-c:a', 'aac', '-b:a', '192k',
                ...audioMap,
                this.shQuote(out)
            ];
        } else if (format === 'webm') {
            args = [
                ...inputs,
                '-vf', `"format=rgba,${chromaFilter},${despillFilter}"`,
                '-c:v', 'libvpx-vp9',
                '-pix_fmt', 'yuva420p',
                '-b:v', '4M',
                '-auto-alt-ref', '0',
                '-lag-in-frames', '0',
                '-c:a', 'libopus', '-b:a', '192k',
                ...audioMap,
                this.shQuote(out)
            ];
        } else {
            // Opaque MP4 — no chromakey, transparency wouldn't render in
            // .mp4 anyway. Still swap clean MP3 if provided.
            args = [
                ...inputs,
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-crf', '18',
                '-preset', 'medium',
                '-c:a', 'aac', '-b:a', '192k',
                '-movflags', '+faststart',
                ...audioMap,
                this.shQuote(out)
            ];
        }
        return `ffmpeg -y ${args.join(' ')}`;
    },

    copyCommand(format) {
        const cmd = this.buildCommand(format);
        if (!cmd) { UI.toast('Enter the WebM filename first'); return; }
        const pre = document.getElementById('chromakey-cmd-output');
        if (pre) { pre.textContent = cmd; pre.style.display = 'block'; }

        const done = () => UI.toast(`.${format} chromakey command copied`);
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(cmd).then(done).catch(() => this.fallbackCopy(cmd, done));
        } else {
            this.fallbackCopy(cmd, done);
        }
    },

    fallbackCopy(text, done) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch { UI.toast('Copy failed'); }
        ta.remove();
    }
};
