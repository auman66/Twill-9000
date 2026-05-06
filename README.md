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
- Screenshot (PNG / transparent) and video export (WebM)
- Microphone input or audio file upload
- **ElevenLabs TTS integration** — paste a script and voice ID, the app generates audio and records it through the visualizer
- **Batch mode** — CSV-driven, generates 30+ clips in a single one-click run, with optional per-row voice tuning overrides

## Usage

Serve over HTTP (required for the browser audio APIs):

```
python3 -m http.server 8080
```

Open `http://localhost:8080/index.html` in your browser.

## ElevenLabs setup

1. In the **Text to Speech** section of the sidebar, paste your ElevenLabs API key (password field — stored in `localStorage` only, never sent anywhere except `api.elevenlabs.io`).
2. Paste a voice ID (from ElevenLabs' Voice Library) into the Voice ID field.
3. Optionally tune stability, similarity, style, and speed sliders.

## Single-clip workflow

One-off clips can be produced with the Text to Speech section alone:

- **Generate Audio** — renders TTS and plays it through the visualizer.
- **⬇ Download MP3** — saves the audio after generation.
- **Generate, Record & Download Both** — generates, records an opaque WebM through the canvas+audio pipeline, downloads both the video and the MP3.
- **Generate + Transparent PNG Recording** — captures a transparent PNG sequence (ZIP) + the MP3. Requires post-processing with ffmpeg to produce a final transparent video — see the Assemble Video buttons in the Export section, which give you a copy-pasteable command for `.mov`, `.webm`, or `.mp4`.

## Batch workflow (30+ clips)

For bulk jobs, the **Batch (CSV)** section at the top of the sidebar drives everything.

### 1. Prepare a CSV

The CSV needs two required columns: `name,script`. Optional override columns are supported and apply **per-row only** — they don't cascade to later rows.

Required columns:

| column | type   | purpose                                                        |
| ------ | ------ | -------------------------------------------------------------- |
| `name` | string | Used as the filename prefix. Normalized to snake_case on save. |
| `script` | string | The text spoken by the TTS voice.                             |

Optional override columns (any blank cell inherits from the sidebar):

| column       | type   | notes                                                             |
| ------------ | ------ | ----------------------------------------------------------------- |
| `voice_id`   | string | Any ElevenLabs voice ID. Aliases: `voice`, `voiceid`.            |
| `model`      | string | e.g. `eleven_flash_v2_5`, `eleven_v3`, `eleven_multilingual_v2`. |
| `stability`  | 0–1    | Lower = more expressive, higher = more monotone.                 |
| `similarity` | 0–1    | Alias: `similarity_boost`.                                        |
| `style`      | 0–1    | Style exaggeration (v2+ models).                                 |
| `speed`      | 0.7–1.2| Playback speed.                                                   |

Two templates ship in the repo — download links are in the sidebar help text, or use them directly:

- `batch-example.csv` — minimal two-column example.
- `batch-example-overrides.csv` — demonstrates per-row overrides and the non-cascading behavior.

### 2. Run the batch

1. In the sidebar, set your ElevenLabs API key, default voice ID, model, and tuning sliders. These apply to every row whose override cells are blank.
2. Scroll up to the **Batch (CSV)** section. Click **Choose CSV...** and select your file.
3. Pick an **Output Mode**:
   - **MP3 only** — fastest. Audio only, no visualizer needed.
   - **Opaque WebM** — canvas + audio baked into one video file per clip. Done in one step, no post-processing.
   - **Transparent PNG ZIP + MP3** — produces a PNG sequence + separate MP3 per clip. Requires `convert-all.sh` afterward to mux into final videos.
4. Click **▶ Run Batch** and walk away. Progress is shown in the sidebar.

> **Browser prompt:** after ~5 individual file downloads, Chrome asks "Allow this site to download multiple files?" — click **Allow** once. The rest run unattended.

> **Don't switch tabs** during a batch. Browsers throttle `requestAnimationFrame` for background tabs, which disrupts both recording cadence and the visualizer analyser.

When the batch finishes, a `batch_manifest_<timestamp>.json` downloads automatically. It lists every clip, the actual filename on disk, and which settings were applied (including which were overridden per-row).

### 3. Organize the outputs

Browsers can only route downloads to the default Downloads folder, so you need to move the files into a per-project folder before running the convert-all script.

For an "intros" batch, the layout would be:

```
exports/
  intros/
    welcome-intro_1738098765432.zip
    welcome-intro_1738098765432.mp3
    episode-01-hook_1738098766000.zip
    episode-01-hook_1738098766000.mp3
    …
    batch_manifest_1738098770000.json
    convert-all_1738098771000.sh
```

From the terminal:

```bash
# Create the target folder
mkdir -p exports/intros

# Move the batch outputs from Downloads
mv ~/Downloads/*.zip ~/Downloads/*.mp3 exports/intros/
mv ~/Downloads/batch_manifest_*.json ~/Downloads/convert-all_*.sh exports/intros/
```

(The `exports/` folder is git-ignored by default.)

### 4. Convert PNG batches to final videos

If you ran the batch in **Transparent PNG** mode, generate a `convert-all.sh` script from the sidebar after the batch finishes:

1. Under **Convert-All Script**, pick an output format:
   - `.mov` (HEVC alpha) — Keynote / QuickTime / Safari / Final Cut. Transparent background preserved.
   - `.webm` (VP9 alpha) — Chrome / Firefox / Google Slides. Transparent background preserved.
   - `.mp4` (H.264 opaque) — PowerPoint / universal fallback. No transparency.
2. Click **Download convert-all.sh** and move it into the same folder as your ZIPs and MP3s.
3. From the terminal, cd into that folder and run the script:

```bash
cd exports/intros
bash convert-all_*.sh
```

The script:

- Loops over every `<name>_<timestamp>.zip` + matching `<name>_<timestamp>.mp3` pair.
- Unzips each ZIP into a temporary `frames_<name>_<timestamp>/` directory.
- Runs `ffmpeg` with the correct codec + muxing flags for the format you picked.
- Deletes the temporary frames directory on its way out.
- Echoes `[N / TOTAL] name...` progress and `-> output.ext` per clip.

Requires `ffmpeg` on your `$PATH` (`brew install ffmpeg` if you don't have it). Apple Silicon Macs benefit from hardware-accelerated HEVC encoding on `.mov` — expect ~real-time encoding for that format.

When it's done, the folder contains one finished video per clip alongside the source ZIPs and MP3s. The source files can be deleted once you've confirmed the videos look right.

### Walk-through for the intros folder

Putting it all together, a complete run looks like:

```bash
# 1. Start the server
python3 -m http.server 8080

# 2. In the browser (http://localhost:8080/index.html):
#    - Set API key + default voice in the sidebar
#    - Batch section: choose intros.csv
#    - Output Mode: Transparent PNG ZIP + MP3
#    - Click Run Batch, allow multiple downloads when prompted
#    - When it finishes, pick .mov under Convert-All Script,
#      click Download convert-all.sh

# 3. Back in the terminal:
mkdir -p exports/intros
mv ~/Downloads/*.zip ~/Downloads/*.mp3 exports/intros/
mv ~/Downloads/batch_manifest_*.json ~/Downloads/convert-all_*.sh exports/intros/
cd exports/intros
bash convert-all_*.sh

# 4. Done. exports/intros/ now contains one .mov per clip.
```

## Export formats reference

| Format              | Transparency | Keynote | PowerPoint | Google Slides | Chrome | Safari  |
| ------------------- | :----------: | :-----: | :--------: | :-----------: | :----: | :-----: |
| `.mov` (HEVC alpha) |      ✅      |   ✅    |     ❌     |      ❌       |   ❌   |   ✅    |
| `.webm` (VP9 alpha) |      ✅      |  ⚠️\*   |     ❌     |     ⚠️\*      |   ✅   |   ❌    |
| `.mp4` (H.264)      |      ❌      |   ✅    |     ✅     |      ✅       |   ✅   |   ✅    |

\* Slides plays the file but may composite it over a solid background; Keynote accepts WebM since 13 but prefers HEVC alpha for Mac-native workflows.

## Inspired by

[WaveForge by PROGAMERYT-op](https://github.com/PROGAMERYT-op/WaveForge)
