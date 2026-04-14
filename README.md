# Twill 9000

AI voice audio visualizer with configurable shapes, visual effects, and real-time speech reactivity. Built for large-screen event displays.

## Features

- Radial EQ visualization with configurable bar count, width, and style (Bars / Mirror)
- 8 built-in geometric shapes + 24 SVG shapes as center elements
- Custom SVG upload support
- Two-phase breathing animation (fill grows, ring separates)
- Shape fill and border color customization
- Hollow mode
- Visual FX: glow, motion trails, pulse rings, particles, gradient bars, rounded bars, vignette, background pulse, rotation
- Voice energy analysis with emphasis detection
- Sustained energy tracking for smooth speech reactivity
- Screenshot (PNG/transparent) and video export (WebM)
- Microphone input or audio file upload

#Usage

Serve over HTTP (required for audio APIs):

```
python3 -m http.server 8080
```

Open `http://localhost:8080/visualizer.html`

## Inspired by 
[WaveForge by PROGAMERYT-op](https://github.com/PROGAMERYT-op/WaveForge)
