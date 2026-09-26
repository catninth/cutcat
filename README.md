# CutCat

A fast, focused desktop video editor built with React, Tauri 2, and FFmpeg.

CutCat 0.2 handles multiple video and audio sources on a magnetic V1 video track and a freely positioned A1 audio track. Editing is non-destructive: source files remain unchanged; only clip order and settings change.

## Implemented features

- drag and drop multiple videos and MP3/audio files directly onto the timeline;
- `ffprobe` metadata: duration, resolution, fps, and video/audio codecs;
- frame-accurate playhead, preview, and frame stepping;
- corrected two-sided trimming: dragging the left handle moves the left clip edge;
- dedicated Select (`V`) and Cut (`C`) timeline tools;
- split from the context menu, toolbar, or `S`, without the native browser menu;
- drag and drop to reorder videos and move audio clips freely;
- per-clip volume, mute, and 0.25×–4× speed;
- detach video audio into a separate, trimmable A1 clip;
- ripple delete, undo/redo, timeline zoom, and fit;
- multi-source H.264/AAC MP4 export with normalized frame dimensions and audio mixing;
- optional fast stream copy for a single segment;
- FFmpeg progress, cancellation, and safe partial output;
- browser frontend fallback for fast UI development.

Research, UX decisions, FFmpeg filtergraphs, and architecture: [docs/RESEARCH.md](docs/RESEARCH.md).

## Getting started

Requirements:

- Node.js 24 or later;
- Rust stable;
- on Windows: the `stable-x86_64-pc-windows-msvc` toolchain, Visual Studio Build Tools with the “Desktop development with C++” workload, and the Windows SDK;
- WebView2 Runtime.

```powershell
npm install
npm run tauri:dev
```

`npm install` copies the platform-specific FFmpeg and ffprobe sidecars into `src-tauri/binaries` with target-triple filenames.

To run only the React UI:

```powershell
npm run dev
```

Browser mode supports importing, previewing, and timeline editing. Export requires native file paths and is unavailable in this mode.

## Usage

1. Drop one or more videos/MP3 files onto the timeline.
2. Use `Select` mode to select, trim, and reorder clips.
3. Use `Cut` mode to click the desired cut point in a clip.
4. Right-click a video and choose `Detach audio` to create a separate A1 clip.
5. Adjust speed, volume, or mute for the selected clip.
6. Choose export quality and resolution, then select `Export`.

Keyboard shortcuts:

| Key | Action |
| --- | --- |
| `V` | Select and move tool |
| `C` | Cut tool |
| `Space` | Play / pause |
| `S` | Split at the playhead |
| `M` | Mute the selected clip |
| `Alt` + `←` / `→` | Reorder the selected video |
| `Delete` / `Backspace` | Ripple delete the selected segment |
| `←` / `→` | Step by 1 frame |
| `Shift` + `←` / `→` | Step by 5 frames |
| `+` / `-` | Timeline zoom |
| `0` | Timeline fit |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Shift+Z`, `Ctrl+Y` | Redo |

## Checks and builds

```powershell
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:portable
npm run tauri:build
```

`npm run tauri:portable` builds the release `.exe` and
sidecars in `src-tauri/target/release` without an installer. For the full installer package,
use `npm run tauri:build`.

## Structure

```text
src/
  components/       React editor UI
  hooks/            undo/redo history
  lib/              timeline math, time, and Tauri bridge
  types/            IPC and editor types
src-tauri/
  src/media.rs      canonical import + ffprobe
  src/export.rs     validation, filtergraph, progress, cancellation
  capabilities/     minimal Tauri permissions
scripts/
  prepare-ffmpeg.mjs
```

## FFmpeg license

The development package uses `ffmpeg-static` and `ffprobe-static` binaries. Before a release, audit the selected binary's build configuration and license. Distributing a GPL FFmpeg build containing `libx264` entails GPL obligations; builds with `--enable-nonfree` cannot be redistributed. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [FFmpeg Legal](https://ffmpeg.org/legal.html).
