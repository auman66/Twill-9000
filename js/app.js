// ============================================================
// APP BOOTSTRAP - Twill 9000
// ============================================================

let audio, viz;

document.addEventListener('DOMContentLoaded', () => {
    audio = new AudioEngine();
    viz = new Visualizer(document.getElementById('canvas'));
    UI.init();
    viz.loop();
});
