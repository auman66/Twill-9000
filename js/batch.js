// ============================================================
// BATCH - CSV-driven bulk generation + recording
// ============================================================
//
// Feed a CSV with columns `name,script` (plus optional extras) and the
// runner iterates each row sequentially:
//   1. Generate TTS via ElevenLabs using the sidebar voice + tuning
//   2. Play it through the visualizer
//   3. Record the output in the chosen mode (mp3 / webm / png)
//   4. Stream each finished file to the browser as a download
//
// After the batch finishes, a manifest JSON is downloaded. For PNG mode,
// a bash script can be generated that muxes every ZIP+MP3 pair into a
// final video using local ffmpeg.
//
// Output mode notes:
//   mp3   - just the MP3 file. No video, no visualizer needed. Fastest.
//   webm  - canvas + audio captured via MediaRecorder. One file per clip.
//           No post-processing required. Background is opaque.
//   png   - transparent PNG sequence (ZIP) + MP3. Two files per clip.
//           Needs `bash convert-all.sh` afterward to produce videos.

const Batch = {
    // Parsed CSV rows waiting to be processed.
    rows: [],
    running: false,
    stopRequested: false,
    // Manifest entries collected as we go. Dumped as JSON at the end.
    manifest: [],
    mode: 'webm',

    init() {
        document.getElementById('btn-batch-choose')?.addEventListener('click', () => {
            document.getElementById('batch-file-input').click();
        });
        document.getElementById('batch-file-input')?.addEventListener('change', e => this.onFile(e.target.files[0]));
        document.getElementById('batch-mode')?.addEventListener('change', e => { this.mode = e.target.value; });
        document.getElementById('btn-batch-run')?.addEventListener('click', () => this.run());
        document.getElementById('btn-batch-stop')?.addEventListener('click', () => { this.stopRequested = true; this.setProgress('Stopping after current clip...'); });
        document.getElementById('btn-batch-download-script')?.addEventListener('click', () => this.downloadConvertScript());

        this.mode = document.getElementById('batch-mode')?.value || 'webm';
    },

    // --- UI helpers ---
    setProgress(text) {
        const el = document.getElementById('batch-progress');
        if (el) el.textContent = text || '';
    },
    setProgressBar(current, total) {
        const bar = document.getElementById('batch-progress-bar');
        if (!bar) return;
        if (total > 0) {
            bar.style.display = 'block';
            bar.max = total;
            bar.value = current;
        } else {
            bar.style.display = 'none';
        }
    },
    setFileStatus(text) {
        const el = document.getElementById('batch-file-status');
        if (el) el.textContent = text;
    },

    // --- CSV handling ---
    onFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            try {
                this.rows = this.parseCsv(e.target.result);
                if (!this.rows.length) {
                    this.setFileStatus('No valid rows found.');
                    document.getElementById('btn-batch-run').disabled = true;
                    return;
                }
                this.setFileStatus(`Loaded ${this.rows.length} clip${this.rows.length === 1 ? '' : 's'} from ${file.name}`);
                document.getElementById('btn-batch-run').disabled = false;
            } catch (err) {
                this.setFileStatus('Parse error: ' + err.message);
                document.getElementById('btn-batch-run').disabled = true;
            }
        };
        reader.readAsText(file);
    },

    // Tiny CSV parser. Handles quoted fields (double-quote escaping inside
    // quotes, embedded commas, embedded newlines). Good enough for scripts.
    parseCsv(text) {
        const rows = [];
        let i = 0, field = '', row = [], inQuotes = false;
        const n = text.length;
        while (i < n) {
            const ch = text[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                field += ch; i++; continue;
            }
            if (ch === '"') { inQuotes = true; i++; continue; }
            if (ch === ',') { row.push(field); field = ''; i++; continue; }
            if (ch === '\r') { i++; continue; }
            if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
            field += ch; i++;
        }
        // Tail
        if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

        if (!rows.length) return [];
        // First row must be header. Required: name, script.
        // Optional per-row overrides (blank = inherit from sidebar):
        //   voice_id, model, stability, similarity, style, speed
        const header = rows[0].map(h => h.trim().toLowerCase());
        const nameIdx = header.indexOf('name');
        const scriptIdx = header.indexOf('script');
        if (nameIdx === -1 || scriptIdx === -1) {
            throw new Error('CSV must have "name" and "script" columns');
        }
        const idxOf = (...keys) => {
            for (const k of keys) {
                const i = header.indexOf(k);
                if (i !== -1) return i;
            }
            return -1;
        };
        // Accept a couple of aliases so people don't have to memorize exact column names.
        const overrideIdx = {
            voiceId: idxOf('voice_id', 'voiceid', 'voice'),
            model: idxOf('model'),
            stability: idxOf('stability'),
            similarity: idxOf('similarity', 'similarity_boost'),
            style: idxOf('style'),
            speed: idxOf('speed')
        };

        // Read a numeric override, returning undefined if blank/missing/NaN so
        // the caller can cleanly fall back to the sidebar default.
        const num = (cols, idx) => {
            if (idx === -1) return undefined;
            const raw = (cols[idx] || '').trim();
            if (!raw) return undefined;
            const v = parseFloat(raw);
            return Number.isFinite(v) ? v : undefined;
        };
        const str = (cols, idx) => {
            if (idx === -1) return undefined;
            const raw = (cols[idx] || '').trim();
            return raw || undefined;
        };

        const out = [];
        for (let r = 1; r < rows.length; r++) {
            const cols = rows[r];
            // Skip fully-empty rows (trailing blank lines are common).
            if (cols.every(c => !c || !c.trim())) continue;
            const name = (cols[nameIdx] || '').trim();
            const script = (cols[scriptIdx] || '').trim();
            if (!name || !script) continue;
            // Collect only the overrides that are explicitly set. Anything
            // absent here means "use sidebar default at run time."
            const overrides = {};
            const vid = str(cols, overrideIdx.voiceId); if (vid !== undefined) overrides.voiceId = vid;
            const mdl = str(cols, overrideIdx.model); if (mdl !== undefined) overrides.model = mdl;
            const stab = num(cols, overrideIdx.stability); if (stab !== undefined) overrides.stability = stab;
            const sim = num(cols, overrideIdx.similarity); if (sim !== undefined) overrides.similarity = sim;
            const sty = num(cols, overrideIdx.style); if (sty !== undefined) overrides.style = sty;
            const spd = num(cols, overrideIdx.speed); if (spd !== undefined) overrides.speed = spd;
            out.push({ name, script, overrides, rowNum: r + 1 });
        }
        return out;
    },

    // --- Filesystem-safe name ---
    safeName(name) {
        return name
            .replace(/[^a-z0-9\-_]+/gi, '_')    // anything weird -> underscore
            .replace(/^_+|_+$/g, '')            // trim leading/trailing underscores
            .replace(/_{2,}/g, '_')             // collapse runs
            .toLowerCase()
            || 'clip';
    },

    // Browser-side file download. Uses the standard invisible <a> trick.
    download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    },

    // --- Runner ---
    async run() {
        if (this.running) return;
        if (!this.rows.length) { UI.toast('Load a CSV first'); return; }

        // Pre-flight: TTS inputs must be set (key, voice). Script comes from CSV.
        const base = TTS.readInputs();
        if (!base.apiKey) { UI.toast('Enter your ElevenLabs API key first'); return; }
        if (!base.voiceId) { UI.toast('Enter a voice ID first'); return; }

        this.running = true;
        this.stopRequested = false;
        this.manifest = [];
        this.mode = document.getElementById('batch-mode')?.value || 'webm';

        document.getElementById('btn-batch-run').disabled = true;
        document.getElementById('btn-batch-stop').disabled = false;
        document.getElementById('btn-batch-choose').disabled = true;
        document.getElementById('batch-post').style.display = 'none';
        this.setProgressBar(0, this.rows.length);

        // If PNG mode, pre-enable transparent capture.
        if (this.mode === 'png') {
            STATE.pngAlpha = true;
            const alphaToggle = document.getElementById('s-png-alpha');
            if (alphaToggle) alphaToggle.checked = true;
        }

        // Heads-up about the download permission prompt (most browsers).
        UI.toast('If your browser prompts about multiple downloads, click Allow once.');

        let completed = 0, failed = 0;
        for (let i = 0; i < this.rows.length; i++) {
            if (this.stopRequested) break;
            const row = this.rows[i];
            this.setProgress(`Clip ${i + 1} / ${this.rows.length}: ${row.name}`);
            this.setProgressBar(i, this.rows.length);

            try {
                const entry = await this.processClip(row, base);
                this.manifest.push(entry);
                completed++;
            } catch (err) {
                console.error(`[batch] clip "${row.name}" failed:`, err);
                this.manifest.push({ name: row.name, error: err.message || String(err) });
                failed++;
                // Keep going. A single clip failure shouldn't torpedo the batch.
            }
            this.setProgressBar(i + 1, this.rows.length);
        }

        // Download manifest so the convert-all script (and the user) can
        // reconcile filenames later if they lose track.
        const manifestBlob = new Blob([JSON.stringify({
            generator: 'Twill 9000 Batch',
            mode: this.mode,
            runAt: new Date().toISOString(),
            voiceId: base.voiceId,
            model: base.model,
            voiceSettings: {
                stability: base.stability,
                similarity_boost: base.similarity,
                style: base.style,
                speed: base.speed
            },
            totalClips: this.rows.length,
            completed,
            failed,
            clips: this.manifest
        }, null, 2)], { type: 'application/json' });
        this.download(manifestBlob, `batch_manifest_${Date.now()}.json`);

        this.setProgress(`Done. ${completed} succeeded, ${failed} failed${this.stopRequested ? ' (stopped early)' : ''}.`);
        if ((this.mode === 'png' || this.mode === 'webm') && completed > 0) {
            document.getElementById('batch-post').style.display = '';
        }

        this.running = false;
        document.getElementById('btn-batch-run').disabled = false;
        document.getElementById('btn-batch-stop').disabled = true;
        document.getElementById('btn-batch-choose').disabled = false;
    },

    // Process a single CSV row. Generates TTS, plays it, records + downloads
    // in the appropriate mode, and returns a manifest entry describing the
    // produced files.
    //
    // Per-row CSV overrides (if present) are layered on top of the sidebar
    // defaults *for this clip only* — the next row reads its own overrides,
    // so changes do NOT cascade.
    async processClip(row, base) {
        const safeName = this.safeName(row.name);
        const timestamp = Date.now();
        // Merge: start from the sidebar defaults, overlay anything the CSV
        // row explicitly set. `row.overrides` only contains fields that were
        // filled in for this row; blanks aren't present in the object, so
        // they can't shadow the base values.
        const settings = { ...base, ...(row.overrides || {}) };

        // 1. Generate TTS
        this.setProgress(`Clip ${row.name}: generating TTS...`);
        const audioBlob = await TTS.generateAudio({
            apiKey: settings.apiKey,
            voiceId: settings.voiceId,
            model: settings.model,
            script: row.script,
            stability: settings.stability,
            similarity: settings.similarity,
            style: settings.style,
            speed: settings.speed
        });

        const audioFilename = `${safeName}_${timestamp}.mp3`;

        if (this.mode === 'mp3') {
            this.download(audioBlob, audioFilename);
            return {
                name: row.name, safeName, timestamp,
                files: { audio: audioFilename },
                settings: this.manifestSettings(settings, row.overrides)
            };
        }

        // Ensure TTS state is wired so the visualizer and other paths see it.
        TTS.lastAudioBlob = audioBlob;
        TTS.lastAudioFilename = audioFilename;
        STATE.lastAudioSource = { blob: audioBlob, filename: audioFilename };

        if (this.mode === 'webm') {
            const entry = await this.recordWebmClip(row, safeName, timestamp, audioBlob, audioFilename);
            entry.settings = this.manifestSettings(settings, row.overrides);
            return entry;
        }
        if (this.mode === 'png') {
            const entry = await this.recordPngClip(row, safeName, timestamp, audioBlob, audioFilename);
            entry.settings = this.manifestSettings(settings, row.overrides);
            return entry;
        }
        throw new Error('Unknown batch mode: ' + this.mode);
    },

    // Build a compact settings record for the manifest. Flags which values
    // were overridden per-row vs inherited from the sidebar so the user can
    // audit what was actually applied to each clip.
    manifestSettings(effective, overrides) {
        const overridden = Object.keys(overrides || {});
        return {
            voiceId: effective.voiceId,
            model: effective.model,
            stability: effective.stability,
            similarity: effective.similarity,
            style: effective.style,
            speed: effective.speed,
            overridden: overridden.length ? overridden : undefined
        };
    },

    async recordWebmClip(row, safeName, timestamp, audioBlob, audioFilename) {
        this.setProgress(`Clip ${row.name}: recording video...`);

        // Preregister resolver so stopVideo's onstop hands us the blob instead
        // of downloading with its default filename.
        const videoPromise = new Promise(resolve => { Exporter.nextVideoResolver = resolve; });
        Exporter.startVideo();

        try {
            await TTS.playThroughVisualizer(audioBlob);
        } finally {
            STATE.playing = false;
            UI.updatePlay();
        }

        await Exporter.waitForCooldown();
        Exporter.stopVideo();
        const { blob: videoBlob, ext } = await videoPromise;

        const videoFilename = `${safeName}_${timestamp}.${ext}`;
        this.download(videoBlob, videoFilename);
        // Also save the original ElevenLabs MP3. The WebM's Opus audio track
        // is a heavily re-compressed version of this (MediaRecorder defaults
        // to ~85kbps Opus), which sounds muffled after a second pass through
        // AAC. Keeping the pristine MP3 around lets the chromakey post-step
        // swap it in, giving us single-pass lossy video + untouched audio.
        this.download(audioBlob, audioFilename);
        return {
            name: row.name,
            safeName,
            timestamp,
            files: { video: videoFilename, audio: audioFilename }
        };
    },

    async recordPngClip(row, safeName, timestamp, audioBlob, audioFilename) {
        this.setProgress(`Clip ${row.name}: recording PNGs...`);

        // Ensure alpha is on (set once at batch start, but defensive).
        STATE.pngAlpha = true;
        Exporter.startPng();

        try {
            await TTS.playThroughVisualizer(audioBlob);
        } finally {
            STATE.playing = false;
            UI.updatePlay();
        }

        await Exporter.waitForCooldown();
        const zipFilename = `${safeName}_${timestamp}.zip`;
        const result = await Exporter.stopPng({ filename: zipFilename, skipDownload: true });
        this.download(result.blob, zipFilename);
        // Also download the audio alongside.
        this.download(audioBlob, audioFilename);
        return {
            name: row.name,
            safeName,
            timestamp,
            files: { zip: zipFilename, audio: audioFilename, frames: result.frameCount }
        };
    },

    // --- convert-all.sh generation ---
    downloadConvertScript() {
        const target = document.getElementById('batch-convert-target')?.value || 'mov';
        // WebM-mode batches used the opaque recorder; if the user picked the
        // chromakey preset during recording, the bg is green and we can key
        // it out now. Different entry filter / ffmpeg command than the PNG
        // path, so handle separately.
        if (this.mode === 'webm') {
            const webmEntries = this.manifest.filter(e => e.files?.video);
            if (!webmEntries.length) { UI.toast('No recorded videos in manifest'); return; }
            const script = this.buildChromakeyScript(webmEntries, target);
            const blob = new Blob([script], { type: 'text/x-shellscript' });
            this.download(blob, `chromakey-all_${Date.now()}.sh`);
            UI.toast('chromakey-all.sh downloaded. Run it where your WebM files live.');
            return;
        }
        // PNG mode
        const pngEntries = this.manifest.filter(e => e.files?.zip && e.files?.audio);
        if (!pngEntries.length) { UI.toast('No PNG+audio clips in manifest'); return; }
        const script = this.buildConvertScript(pngEntries, target);
        const blob = new Blob([script], { type: 'text/x-shellscript' });
        this.download(blob, `convert-all_${Date.now()}.sh`);
        UI.toast('convert-all.sh downloaded. Run it where your ZIPs and MP3s live.');
    },

    // Produces a bash script that takes each recorded WebM (which has a
    // solid green background because the user used the Chromakey preset)
    // and chromakeys the green out to produce a transparent video in the
    // chosen format.
    //
    // Audio handling: newer batches also save the pristine ElevenLabs MP3
    // next to the WebM. When present we use it as the audio source so the
    // final video has untouched voice instead of re-compressed Opus. Older
    // batches without a paired MP3 fall back to the WebM's internal audio
    // track.
    buildChromakeyScript(entries, target) {
        // Tightened chromakey (0.12:0.04) catches green edges without
        // nibbling the visuals; despill cleans residual green from
        // semi-transparent edge pixels. Tested against a real recording.
        const chroma = 'chromakey=0x00ff00:0.12:0.04';
        const despill = 'despill=type=green:mix=0.6';

        const ffmpegArgs = (entry, outFile) => {
            const video = entry.files.video;
            const mp3 = entry.files.audio;   // may be null on older batches
            const hasMp3 = !!mp3;

            if (target === 'mov') {
                // HEVC+alpha via VideoToolbox. Audio goes to AAC.
                const base = [
                    '-i', `"${video}"`,
                    ...(hasMp3 ? ['-i', `"${mp3}"`] : []),
                    '-vf', `"${chroma},${despill},format=rgba"`,
                    '-c:v', 'hevc_videotoolbox',
                    '-allow_sw', '1',
                    '-alpha_quality', '0.85',
                    '-vtag', 'hvc1',
                    '-pix_fmt', 'bgra',
                    '-b:v', '10M',
                    '-c:a', 'aac', '-b:a', '192k'
                ];
                if (hasMp3) {
                    // Video from stream 0, audio from stream 1 (the MP3).
                    // No -shortest: preserve the visualizer cool-down tail
                    // after the audio ends (video is longer than the MP3).
                    return [...base, '-map', '0:v:0', '-map', '1:a:0', `"${outFile}"`];
                }
                return [...base, `"${outFile}"`];
            }
            if (target === 'webm') {
                const base = [
                    '-i', `"${video}"`,
                    ...(hasMp3 ? ['-i', `"${mp3}"`] : []),
                    '-vf', `"format=rgba,${chroma},${despill}"`,
                    '-c:v', 'libvpx-vp9',
                    '-pix_fmt', 'yuva420p',
                    '-b:v', '4M',
                    '-auto-alt-ref', '0',
                    '-lag-in-frames', '0',
                    '-c:a', 'libopus', '-b:a', '192k'
                ];
                if (hasMp3) {
                    return [...base, '-map', '0:v:0', '-map', '1:a:0', `"${outFile}"`];
                }
                return [...base, `"${outFile}"`];
            }
            // mp4: no chromakey (transparency wouldn't render anyway in
            // slide decks that use .mp4). Still swap in the clean MP3
            // if we have it.
            const base = [
                '-i', `"${video}"`,
                ...(hasMp3 ? ['-i', `"${mp3}"`] : []),
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-crf', '18',
                '-preset', 'medium',
                '-c:a', 'aac', '-b:a', '192k',
                '-movflags', '+faststart'
            ];
            if (hasMp3) {
                return [...base, '-map', '0:v:0', '-map', '1:a:0', `"${outFile}"`];
            }
            return [...base, `"${outFile}"`];
        };

        const functions = [];
        const names = [];
        entries.forEach((e, idx) => {
            const out = `${e.safeName}_${e.timestamp}_keyed.${target}`;
            const fnName = `clip_${idx}`;
            const video = e.files.video;
            const mp3 = e.files.audio;
            names.push(fnName);
            const checks = [
                `  if [ ! -f "${video}" ]; then echo "  skipping, missing ${video}"; return 0; fi`
            ];
            if (mp3) {
                checks.push(`  if [ ! -f "${mp3}" ]; then echo "  skipping, missing ${mp3}"; return 0; fi`);
            }
            functions.push(
                `${fnName}() {`,
                `  echo "[$((${idx} + 1)) / ${entries.length}] ${e.safeName}..."`,
                ...checks,
                `  ffmpeg -y -loglevel error ${ffmpegArgs(e, out).join(' ')}`,
                `  echo "  -> ${out}"`,
                `}`
            );
        });

        const lines = [
            '#!/usr/bin/env bash',
            '# Auto-generated by Twill 9000 Batch.',
            '# Chromakeys the green (#00ff00) background out of each recorded WebM.',
            '# If a matching MP3 is present, it\'s used as the audio source so',
            '# voice quality stays at the original ElevenLabs 128kbps MP3 rather',
            '# than being re-encoded from the WebM\'s Opus (which sounds muffled).',
            '# Run from the folder that contains the downloaded videos.',
            '# Requires ffmpeg on PATH.',
            'set -euo pipefail',
            '',
            ...functions,
            '',
            ...names,
            '',
            'echo "Done."'
        ];
        return lines.join('\n') + '\n';
    },

    // Produces a bash script that walks every ZIP/MP3 pair and muxes each
    // into the chosen format with ffmpeg. Mirrors the commands the
    // Assembler's Copy buttons produce for individual clips.
    buildConvertScript(entries, target) {
        const fps = 30;
        const ffmpegArgs = (framesDir, audio, outFile) => {
            if (target === 'mov') {
                return [
                    '-framerate', fps,
                    '-i', `"${framesDir}/frame_%05d.png"`,
                    '-i', `"${audio}"`,
                    '-c:v', 'hevc_videotoolbox',
                    '-allow_sw', '1',
                    '-alpha_quality', '0.75',
                    '-vtag', 'hvc1',
                    '-pix_fmt', 'bgra',
                    '-b:v', '6M',
                    '-c:a', 'aac', '-b:a', '192k', '-shortest',
                    `"${outFile}"`
                ];
            }
            if (target === 'webm') {
                return [
                    '-framerate', fps,
                    '-i', `"${framesDir}/frame_%05d.png"`,
                    '-i', `"${audio}"`,
                    '-c:v', 'libvpx-vp9',
                    '-pix_fmt', 'yuva420p',
                    '-b:v', '4M',
                    '-auto-alt-ref', '0',
                    '-lag-in-frames', '0',
                    '-c:a', 'libopus', '-b:a', '192k', '-shortest',
                    `"${outFile}"`
                ];
            }
            // mp4
            return [
                '-framerate', fps,
                '-i', `"${framesDir}/frame_%05d.png"`,
                '-i', `"${audio}"`,
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-crf', '18',
                '-preset', 'medium',
                '-c:a', 'aac', '-b:a', '192k', '-shortest',
                '-movflags', '+faststart',
                `"${outFile}"`
            ];
        };

        // Each clip becomes a bash function so we can cleanly `return` on
        // missing inputs. Then a small driver at the bottom iterates them.
        const functions = [];
        const names = [];
        entries.forEach((e, idx) => {
            const zip = e.files.zip;
            const audio = e.files.audio;
            const out = `${e.safeName}_${e.timestamp}.${target}`;
            const framesDir = `frames_${e.safeName}_${e.timestamp}`;
            const fnName = `clip_${idx}`;
            names.push(fnName);
            functions.push(
                `${fnName}() {`,
                `  echo "[$((${idx} + 1)) / ${entries.length}] ${e.safeName}..."`,
                `  if [ ! -f "${zip}" ]; then echo "  skipping, missing ${zip}"; return 0; fi`,
                `  if [ ! -f "${audio}" ]; then echo "  skipping, missing ${audio}"; return 0; fi`,
                `  rm -rf "${framesDir}"`,
                `  unzip -q "${zip}" -d "${framesDir}"`,
                `  ffmpeg -y -loglevel error ${ffmpegArgs(framesDir, audio, out).join(' ')}`,
                `  rm -rf "${framesDir}"`,
                `  echo "  -> ${out}"`,
                `}`
            );
        });

        const lines = [
            '#!/usr/bin/env bash',
            '# Auto-generated by Twill 9000 Batch.',
            '# Run from the folder that contains the downloaded ZIPs + MP3s (usually ~/Downloads).',
            '# Requires ffmpeg on PATH. Intermediate `frames_<name>/` folders are cleaned up',
            '# after each clip is muxed.',
            'set -euo pipefail',
            '',
            ...functions,
            '',
            ...names.map(n => n),
            '',
            'echo "Done."'
        ];

        return lines.join('\n') + '\n';
    }
};
