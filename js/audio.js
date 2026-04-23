// ============================================================
// AUDIO ENGINE - Twill 9000
// ============================================================

class AudioEngine {
    constructor() {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.analyser = this.ctx.createAnalyser();
        this.gain = this.ctx.createGain();
        this.dest = this.ctx.createMediaStreamDestination();
        this.analyser.fftSize = CONFIG.fftSize;
        this.analyser.smoothingTimeConstant = CONFIG.smoothing;
        this.gain.connect(this.ctx.destination);
        this.gain.connect(this.dest);
        this.el = new Audio();
        this.el.crossOrigin = 'anonymous';
        this.src = this.ctx.createMediaElementSource(this.el);
        this.src.connect(this.analyser);
        this.analyser.connect(this.gain);
        this.freq = new Uint8Array(this.analyser.frequencyBinCount);
        this.wave = new Uint8Array(this.analyser.fftSize);
        this.mic = null;
        this.el.addEventListener('ended', () => { STATE.playing = false; if (typeof UI !== 'undefined' && UI.updatePlay) UI.updatePlay(); });
        this.el.addEventListener('timeupdate', () => { if (typeof UI !== 'undefined' && UI.updateSeek) UI.updateSeek(); });
    }
    resume() { if (this.ctx.state === 'suspended') this.ctx.resume(); }
    playFile(url) {
        this.resume(); this.stopMic();
        this.el.src = url;
        this.el.play().then(() => { STATE.playing = true; if (typeof UI !== 'undefined' && UI.updatePlay) UI.updatePlay(); if (typeof UI !== 'undefined' && UI.toast) UI.toast('Audio loaded'); }).catch(e => { if (typeof UI !== 'undefined' && UI.toast) UI.toast('Error: ' + e.message); });
    }
    toggle() {
        this.resume();
        if (this.mic) return;
        if (!this.el.src) { if (typeof UI !== 'undefined' && UI.toast) UI.toast('Load audio first'); return; }
        if (this.el.paused) { this.el.play(); STATE.playing = true; } else { this.el.pause(); STATE.playing = false; }
        if (typeof UI !== 'undefined' && UI.updatePlay) UI.updatePlay();
    }
    stop() { this.el.pause(); this.el.currentTime = 0; STATE.playing = false; if (typeof UI !== 'undefined' && UI.updatePlay) UI.updatePlay(); }
    async startMic() {
        this.resume(); this.stop();
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.mic = this.ctx.createMediaStreamSource(stream);
            this.mic.connect(this.analyser);
            STATE.playing = true;
            const btn = document.getElementById('btn-mic');
            if (btn) btn.classList.add('active');
            if (typeof UI !== 'undefined' && UI.toast) UI.toast('Mic active');
        } catch(e) { if (typeof UI !== 'undefined' && UI.toast) UI.toast('Mic denied'); }
    }
    stopMic() {
        if (this.mic) {
            this.mic.disconnect();
            this.mic = null;
            const btn = document.getElementById('btn-mic');
            if (btn) btn.classList.remove('active');
        }
    }
    update() {
        this.analyser.fftSize = CONFIG.fftSize;
        this.analyser.smoothingTimeConstant = CONFIG.smoothing;
        const volSlider = document.getElementById('vol-slider');
        if (volSlider) this.gain.gain.value = parseFloat(volSlider.value);
        if (this.freq.length !== this.analyser.frequencyBinCount) {
            this.freq = new Uint8Array(this.analyser.frequencyBinCount);
            this.wave = new Uint8Array(this.analyser.fftSize);
        }
    }
    getData() {
        this.analyser.getByteFrequencyData(this.freq);
        this.analyser.getByteTimeDomainData(this.wave);
        return { freq: this.freq, wave: this.wave };
    }
}

// ============================================================
// VOICE ANALYZER
// ============================================================

function analyzeVoice(freq) {
    // Compute voice energy (100Hz-4kHz)
    const start = 4, end = Math.min(186, freq.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += freq[i] * freq[i];
    const rms = Math.sqrt(sum / (end - start)) / 255;
    const sm = CONFIG.voiceSmoothing;
    STATE.voiceEnergy = STATE.voiceEnergy * sm + rms * (1 - sm);
    STATE.voiceActive = STATE.voiceEnergy > 0.04;

    // Separate smoothed energy for pulse lines (independent smoothing)
    const lsm = CONFIG.fx.pulseLineSmoothing;
    STATE.lineEnergy = (STATE.lineEnergy || 0) * lsm + rms * (1 - lsm);

    // Bass energy (20Hz-200Hz) for background pulse
    const bassEnd = Math.min(10, freq.length);
    let bassSum = 0;
    for (let i = 0; i < bassEnd; i++) bassSum += freq[i] * freq[i];
    const bassRms = Math.sqrt(bassSum / bassEnd) / 255;
    STATE.bassEnergy = STATE.bassEnergy * 0.9 + bassRms * 0.1;

    // Sustained energy: ramps up quickly with voice, decays very slowly
    // Stays bright during brief pauses between words
    if (STATE.voiceEnergy > STATE.sustainedEnergy) {
        STATE.sustainedEnergy = STATE.sustainedEnergy * 0.3 + STATE.voiceEnergy * 0.7; // very fast rise
    } else {
        STATE.sustainedEnergy = STATE.sustainedEnergy * 0.999; // extremely slow decay (~10+ sec to fade)
    }

    // Emphasis detection (replaces beat detection)
    const energy = rms * 255;
    STATE.emphasisHistory.push(energy);
    if (STATE.emphasisHistory.length > 50) STATE.emphasisHistory.shift();
    const avg = STATE.emphasisHistory.reduce((a,b) => a+b, 0) / STATE.emphasisHistory.length;
    if (STATE.emphasisTimer > 0) { STATE.emphasisTimer--; STATE.isEmphasis = false; return; }
    if (energy > avg * 1.15 && energy > 25) { STATE.isEmphasis = true; STATE.emphasisTimer = 15; }
    else STATE.isEmphasis = false;
}
