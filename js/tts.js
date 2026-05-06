// ============================================================
// TEXT TO SPEECH - ElevenLabs integration
// ============================================================
//
// Generates audio from a script using an ElevenLabs voice, loads
// the resulting audio into the existing AudioEngine so the
// visualizer reacts to it, and optionally auto-records the canvas
// (+ audio) to a WebM video for the full duration of playback.

const TTS = {
    // --- Credential persistence ---
    STORAGE_KEYS: {
        apiKey: 'twill9000_eleven_api_key',
        voiceId: 'twill9000_eleven_voice_id',
        model: 'twill9000_eleven_model',
        script: 'twill9000_tts_script',
        stability: 'twill9000_tts_stability',
        similarity: 'twill9000_tts_similarity',
        style: 'twill9000_tts_style',
        speed: 'twill9000_tts_speed'
    },

    lastAudioUrl: null,
    lastAudioBlob: null,
    lastAudioFilename: null,
    generating: false,

    init() {
        // Restore persisted fields
        const apiInput = document.getElementById('tts-api-key');
        const voiceInput = document.getElementById('tts-voice-id');
        const modelSelect = document.getElementById('tts-model');
        const scriptArea = document.getElementById('tts-script');
        const autoRecord = document.getElementById('tts-auto-record');

        if (apiInput) apiInput.value = localStorage.getItem(this.STORAGE_KEYS.apiKey) || '';
        if (voiceInput) voiceInput.value = localStorage.getItem(this.STORAGE_KEYS.voiceId) || '';
        const savedModel = localStorage.getItem(this.STORAGE_KEYS.model);
        if (modelSelect && savedModel) {
            // Migrate deprecated model IDs to current equivalents.
            const migrated = this.migrateModelId(savedModel);
            if (migrated !== savedModel) localStorage.setItem(this.STORAGE_KEYS.model, migrated);
            // Only apply if the option still exists in the dropdown.
            if ([...modelSelect.options].some(o => o.value === migrated)) {
                modelSelect.value = migrated;
            }
        }
        if (scriptArea) scriptArea.value = localStorage.getItem(this.STORAGE_KEYS.script) || '';

        // Persist on change
        apiInput?.addEventListener('input', () => localStorage.setItem(this.STORAGE_KEYS.apiKey, apiInput.value));
        voiceInput?.addEventListener('input', () => localStorage.setItem(this.STORAGE_KEYS.voiceId, voiceInput.value));
        modelSelect?.addEventListener('change', () => localStorage.setItem(this.STORAGE_KEYS.model, modelSelect.value));
        scriptArea?.addEventListener('input', () => localStorage.setItem(this.STORAGE_KEYS.script, scriptArea.value));

        // Voice tuning sliders (range + matching number input, restored + persisted)
        this.initTuningControl('tts-stability', this.STORAGE_KEYS.stability, 0.5);
        this.initTuningControl('tts-similarity', this.STORAGE_KEYS.similarity, 0.75);
        this.initTuningControl('tts-style', this.STORAGE_KEYS.style, 0);
        this.initTuningControl('tts-speed', this.STORAGE_KEYS.speed, 1);

        // Button handlers
        document.getElementById('btn-tts-generate')?.addEventListener('click', () => this.run({ record: false }));
        document.getElementById('btn-tts-generate-record')?.addEventListener('click', () => this.run({ record: true }));
        document.getElementById('btn-tts-one-click')?.addEventListener('click', () => this.run({ record: true, autoDownload: true }));
        document.getElementById('btn-tts-one-click-alpha')?.addEventListener('click', () => this.run({ record: true, autoDownload: true, recordMode: 'png-alpha' }));
        document.getElementById('btn-tts-download')?.addEventListener('click', () => this.downloadLast());
    },

    // Restore slider value from localStorage (if present), keep range <-> number in sync,
    // and persist on every change.
    initTuningControl(id, storageKey, defaultVal) {
        const range = document.getElementById(id);
        const num = document.getElementById(id + '-num');
        if (!range) return;
        const saved = localStorage.getItem(storageKey);
        const initial = saved !== null ? saved : String(defaultVal);
        range.value = initial;
        if (num) num.value = initial;
        range.addEventListener('input', () => {
            if (num) num.value = range.value;
            localStorage.setItem(storageKey, range.value);
        });
        if (num) num.addEventListener('input', () => {
            range.value = num.value;
            localStorage.setItem(storageKey, num.value);
        });
    },

    setStatus(msg) {
        const el = document.getElementById('tts-status');
        if (el) el.textContent = msg || '';
    },

    // Map deprecated ElevenLabs model IDs to the current recommended equivalent.
    migrateModelId(id) {
        const MAP = {
            eleven_turbo_v2_5: 'eleven_flash_v2_5',
            eleven_turbo_v2: 'eleven_flash_v2',
            eleven_monolingual_v1: 'eleven_multilingual_v2',
            eleven_multilingual_v1: 'eleven_multilingual_v2'
        };
        return MAP[id] || id;
    },

    // Trigger a browser download of the most recently generated audio.
    downloadLast() {
        if (!this.lastAudioBlob) { UI.toast('Generate audio first'); return; }
        const filename = this.lastAudioFilename || `twill9000_tts_${Date.now()}.mp3`;
        const url = URL.createObjectURL(this.lastAudioBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Also pre-fill the chromakey MP3 field so chromakey post-processing
        // can swap in the pristine MP3 audio without the user re-typing.
        const ckAudio = document.getElementById('chromakey-audio-file');
        if (ckAudio && !ckAudio.value) ckAudio.value = filename;
        // Revoke on next tick so the download can start first.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    readInputs() {
        const num = (id, fallback) => {
            const v = parseFloat(document.getElementById(id)?.value);
            return Number.isFinite(v) ? v : fallback;
        };
        return {
            apiKey: (document.getElementById('tts-api-key')?.value || '').trim(),
            voiceId: (document.getElementById('tts-voice-id')?.value || '').trim(),
            model: this.migrateModelId(document.getElementById('tts-model')?.value || 'eleven_flash_v2_5'),
            script: (document.getElementById('tts-script')?.value || '').trim(),
            autoRecordToggle: document.getElementById('tts-auto-record')?.checked ?? true,
            stability: num('tts-stability', 0.5),
            similarity: num('tts-similarity', 0.75),
            style: num('tts-style', 0),
            speed: num('tts-speed', 1)
        };
    },

    async generateAudio({ apiKey, voiceId, model, script, stability, similarity, style, speed }) {
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
                text: script,
                model_id: model,
                voice_settings: {
                    stability,
                    similarity_boost: similarity,
                    style,
                    use_speaker_boost: true,
                    speed
                }
            })
        });
        if (!res.ok) {
            let detail = '';
            try {
                const j = await res.json();
                detail = j?.detail?.message || j?.detail || JSON.stringify(j);
            } catch { detail = res.statusText; }
            throw new Error(`ElevenLabs ${res.status}: ${detail}`);
        }
        const blob = await res.blob();
        return blob;
    },

    // Play the generated blob through the existing AudioEngine so the
    // visualizer reacts, returning a promise that resolves when playback ends.
    // A fade-out is scheduled near the end of the clip so the visualizer
    // decays alongside the audio instead of hard-cutting. Playback starts
    // at full volume (no fade-in) so the first syllable isn't muffled.
    playThroughVisualizer(blob) {
        if (this.lastAudioUrl) {
            URL.revokeObjectURL(this.lastAudioUrl);
            this.lastAudioUrl = null;
        }
        const url = URL.createObjectURL(blob);
        this.lastAudioUrl = url;
        // Make this audio available to the generic "Play & Record" button AND
        // to the "download again" button so both use an identical filename.
        if (!this.lastAudioFilename) {
            this.lastAudioFilename = `twill9000_tts_${Date.now()}.mp3`;
        }
        STATE.lastAudioSource = { blob, filename: this.lastAudioFilename };

        return new Promise((resolve, reject) => {
            const el = audio.el;
            let fadeOutFired = false;
            // Schedule a fade-out so the signal reaches silence right as the
            // clip finishes. timeupdate is the only reliable hook for
            // "we're N ms from the end"; onEnded is the fallback for clips
            // too short to get a timely timeupdate event.
            const onTimeUpdate = () => {
                if (fadeOutFired) return;
                const fadeOutMs = Exporter.FADE?.OUT_MS ?? 400;
                const remainingMs = (el.duration - el.currentTime) * 1000;
                if (remainingMs <= fadeOutMs + 20) {
                    fadeOutFired = true;
                    Exporter.triggerFadeOut();
                }
            };
            const onEnded = () => {
                el.removeEventListener('ended', onEnded);
                el.removeEventListener('error', onError);
                el.removeEventListener('timeupdate', onTimeUpdate);
                if (!fadeOutFired) Exporter.triggerFadeOut();
                resolve();
            };
            const onError = (e) => {
                el.removeEventListener('ended', onEnded);
                el.removeEventListener('error', onError);
                el.removeEventListener('timeupdate', onTimeUpdate);
                reject(new Error('Audio playback error'));
            };
            el.addEventListener('ended', onEnded);
            el.addEventListener('error', onError);
            el.addEventListener('timeupdate', onTimeUpdate);

            audio.resume();
            audio.stopMic();
            // Start at full volume. Fade-out is triggered near the end of
            // the clip via the timeupdate listener above.
            audio.setFullVolume();
            el.src = url;
            el.play()
                .then(() => {
                    STATE.playing = true;
                    UI.updatePlay();
                    const statusText = document.getElementById('status-text');
                    if (statusText) statusText.textContent = 'TTS audio (ElevenLabs)';
                })
                .catch(err => {
                    el.removeEventListener('ended', onEnded);
                    el.removeEventListener('error', onError);
                    el.removeEventListener('timeupdate', onTimeUpdate);
                    reject(err);
                });
        });
    },

    async run({ record, autoDownload, recordMode = 'video' }) {
        if (this.generating) { UI.toast('Already generating...'); return; }
        const inputs = this.readInputs();
        if (!inputs.apiKey) { UI.toast('Enter your ElevenLabs API key'); return; }
        if (!inputs.voiceId) { UI.toast('Enter a voice ID'); return; }
        if (!inputs.script) { UI.toast('Enter a script'); return; }

        const shouldRecord = record && inputs.autoRecordToggle;
        const usePng = shouldRecord && recordMode === 'png-alpha';

        this.generating = true;
        const generateBtns = [
            document.getElementById('btn-tts-generate'),
            document.getElementById('btn-tts-generate-record'),
            document.getElementById('btn-tts-one-click'),
            document.getElementById('btn-tts-one-click-alpha')
        ];
        generateBtns.forEach(b => b && (b.disabled = true));
        this.setStatus('Generating audio...');

        let blob;
        try {
            blob = await this.generateAudio(inputs);
        } catch (err) {
            this.setStatus('');
            UI.toast('TTS failed: ' + err.message);
            this.generating = false;
            generateBtns.forEach(b => b && (b.disabled = false));
            return;
        }

        // Stash for manual download and reveal the download button.
        this.lastAudioBlob = blob;
        this.lastAudioFilename = `twill9000_tts_${Date.now()}.mp3`;
        const dlBtn = document.getElementById('btn-tts-download');
        if (dlBtn) dlBtn.style.display = '';

        this.setStatus(shouldRecord ? (usePng ? 'Recording transparent PNGs...' : 'Recording video...') : 'Playing...');
        UI.toast(shouldRecord ? 'Recording...' : 'Playing TTS');

        // Kick off recording BEFORE playback so first frames are captured
        if (shouldRecord) {
            if (usePng) {
                STATE.pngAlpha = true;
                const alphaToggle = document.getElementById('s-png-alpha');
                if (alphaToggle) alphaToggle.checked = true;
                if (!STATE.recordingPng) Exporter.startPng();
            } else if (!STATE.recording) {
                Exporter.startVideo();
            }
        }

        try {
            await this.playThroughVisualizer(blob);
        } catch (err) {
            UI.toast('Playback error: ' + err.message);
        }

        STATE.playing = false;
        UI.updatePlay();

        if (shouldRecord) {
            // Cool-down: keep recording past the end of the audio so the
            // visualizer can relax back to rest before we cut the file.
            this.setStatus(usePng ? 'Cooling down (PNGs)...' : 'Cooling down...');
            await Exporter.waitForCooldown();
            if (usePng && STATE.recordingPng) {
                await Exporter.stopPng();
                this.setStatus('PNG sequence saved');
            } else if (STATE.recording) {
                Exporter.stopVideo();
                this.setStatus('Video saved');
            }
        } else {
            this.setStatus('Done');
        }

        // One-click flow: also download the MP3.
        if (autoDownload) {
            // Small delay so the video/zip download kicks off first.
            setTimeout(() => this.downloadLast(), 800);
        }

        this.generating = false;
        generateBtns.forEach(b => b && (b.disabled = false));
        setTimeout(() => this.setStatus(''), 4000);
    }
};
