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

## Surfaces

Twill 9000 has two entry points:

| URL | Purpose |
| --- | --- |
| `/stage.html` | **Audience-facing.** Fullscreen canvas, no UI chrome. Loads `presets/default.json` on boot. Reads runtime commands from a parent frame via `postMessage`. Intended for embedding in another app (e.g. as an iframe). |
| `/control.html` | **Authoring / tuning.** Full sidebar with every shape, FX, reactivity, and export control. Use this to design a look, then click **Save Preset** to download the JSON. Replace `presets/default.json` with it to ship that look on the stage surface. |

The root `/` redirects to `/stage.html`. Use `/?mode=control` to jump straight to the authoring surface.

## Usage

Serve over HTTP (required for audio APIs):

```
python3 -m http.server 8080
```

- Audience screen: `http://localhost:8080/stage.html`
- Tuning the look: `http://localhost:8080/control.html`

## Embedding (postMessage protocol)

`stage.html` listens for messages from `window.parent` (or `window.opener`). All messages must have `type: 'viz:<verb>'`. Unknown messages are ignored.

### Parent → stage

| Message | Effect |
| --- | --- |
| `{type:'viz:set-config', patch:{<partial CONFIG>}}` | Deep-merges `patch` into the live `CONFIG`. Most flexible primitive. |
| `{type:'viz:set-shape', shape:'circle'\|'random'\|'svg-<N>'\|'custom'}` | Convenience shortcut. Loads the `Path2D` for the named SVG shape. |
| `{type:'viz:set-palette', palette:'cyan'\|'fire'\|'ocean'\|'sunset'\|'arctic'\|'gold'\|'white'}` | Convenience shortcut. |
| `{type:'viz:load-preset', preset:{<full CONFIG snapshot>}}` | Same as `viz:set-config` with a full preset JSON payload (e.g. from `Save Preset`). |
| `{type:'viz:start-mic'}` / `{type:'viz:stop-mic'}` | Controls mic capture. |
| `{type:'viz:ping'}` | Liveness probe; stage replies with `viz:pong`. |

### Stage → parent

| Message | When |
| --- | --- |
| `{type:'viz:ready', palettes:[...], shapes:[...]}` | Fired once on boot so the parent knows the bridge is up and what options are available. |
| `{type:'viz:pong', at:<epoch ms>}` | Reply to `viz:ping`. |
| `{type:'viz:error', error:'<msg>'}` | Bridge threw while handling a message. |

### Origin allowlist

By default `stage.html` accepts any origin (local-only deployment). To restrict it, either:

- Set `?allow=<origin>` on the stage URL (e.g. `/stage.html?allow=https://app.example.com`), or
- Set `window.STAGE_ALLOWED_ORIGIN` from an inline script before `stage-bridge.js` loads.

### Audio autoplay

Browsers require a user gesture to start an `AudioContext`. `stage.html` shows a translucent "Click anywhere to activate audio" overlay on first load. Any pointer or key event unlocks it.

## File layout

```
stage.html           audience-facing
control.html         authoring UI (formerly index.html)
index.html           redirect landing page
css/visualizer.css   control UI styles
css/stage.css        stage styles (fullscreen canvas)
js/
  config.js          CONFIG, STATE, PALETTES, SVG_SHAPES, CONFIG_UTILS
  audio.js           AudioEngine + voice analyzer
  visualizer-engine.js  canvas renderer (pure; reads CONFIG/STATE)
  exporter.js        PNG/WebM/JSON capture (control only)
  ui.js              sidebar bindings (control only)
  app.js             boot for control.html
  stage-bridge.js    boot + postMessage bridge for stage.html
presets/
  default.json      loaded by stage.html on boot
```

## Inspired by
[WaveForge by PROGAMERYT-op](https://github.com/PROGAMERYT-op/WaveForge)
