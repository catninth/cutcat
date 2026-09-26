# CutCat — timeline and export research

Research date: 2026-07-30

## MVP decision

CutCat is a non-destructive editor. Imported source files remain unchanged; the project stores only source time ranges, clip order, and per-clip settings. The V1 video track uses magnetic/ripple ordering. A1 audio clips can be positioned freely on the timeline and receive separate visual layers when they overlap.

```text
OS file drop / Open
        |
        v
canonical path + ffprobe metadata
        |
        v
MediaSource[] + EditorProject { videoClips, audioClips }
        |
        +-- HTML video preview
        +-- React timeline editing
        +-- FFmpeg filtergraph export
```

All internal time values are integer microseconds. They are converted to floating-point seconds only at the HTML media API and FFmpeg argument boundaries.

## 0.2 research decisions

- Primary storyline: V1 clips retain magnetic ordering; drag-and-drop reordering shows the insertion position without overwriting other clips. Final Cut Pro uses the same ripple-based storyline model and insertion-based reordering. [Apple: ripple edits](https://support.apple.com/en-tm/guide/final-cut-pro/ver9847ec25/mac), [Apple: reorder clips](https://support.apple.com/en-ca/guide/final-cut-pro/verc147f195/mac)
- Two tools: `V` Select for trimming, selection, and movement; `C` Cut at the click position. This follows the selection/razor split used by midrange and professional editors. [Adobe: Tools panel](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/tools-panel-and-options-panel.html)
- Import multiple files at once to the end of V1; standalone audio goes on A1. Direct timeline drops and sequential placement of multiple media files are established editing patterns. [Microsoft: Clipchamp editing](https://support.microsoft.com/en-us/clipchamp/how-to-edit-a-video-in-clipchamp), [Apple: add multiple clips](https://support.apple.com/en-mide/guide/final-cut-pro/ver4e30143/mac)
- Per-clip speed/volume/mute: each new clip retains its own values after a split. Changing speed sets the timeline duration to `sourceDuration / speed`. [Microsoft: speed](https://support.microsoft.com/en-us/clipchamp/how-to-speed-up-or-slow-down-a-video), [Apple: retime clips](https://support.apple.com/en-lamr/guide/final-cut-pro/ver40b00150/mac)
- Detach audio: a single undo step disables the video's embedded audio and creates a separate A1 clip with the same source range. [Apple: detach audio](https://support.apple.com/en-my/guide/final-cut-pro/ver549f212d/mac)
- Every drag operation needs a keyboard alternative: focusable clips/handles, arrow-key trimming, and `Alt+←/→` reordering. This follows the WCAG dragging-movements requirement. [W3C WCAG 2.2: Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
- MP3 is a first-class MediaSource. An `ffprobe` audio stream is required; album art marked `attached_pic` does not count as a video stream.

## Timeline UX

Established patterns:

- Adobe Premiere: a trim cursor appears over clip edges; dragging edges sets In/Out points, while razor/split creates a separate edit point. Timeline editing is non-destructive. [Adobe: edit video](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/edit-video-in-premiere.html), [Adobe: trim](https://helpx.adobe.com/uk/premiere/desktop/edit-projects/trim-clips/trim-a-clip.html)
- Premiere navigation: time ruler, playhead, arrow-key frame stepping, `+`/`-` zoom, and zoom centered on the playhead. [Adobe: navigate sequences](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigate-sequences-in-the-timeline.html)
- Clipchamp: drop media directly onto the timeline, handles on both edges of the selected clip, split at the playhead, `S`, `Delete`, zoom/fit. [Microsoft: edit a video](https://support.microsoft.com/en-us/clipchamp/how-to-edit-a-video-in-clipchamp), [Microsoft: trim assets](https://support.microsoft.com/en-us/clipchamp/how-to-trim-videos-images-or-audio-assets)
- Shotcut: `S` to split, `Space` for playback, `+`/`-` to zoom, `0` to fit, snapping, and ripple trim; trimming can be reversed because the source remains unchanged. [Shotcut shortcuts](https://shotcut.org/howtos/keyboard-shortcuts/), [Shotcut timeline](https://www.shotcut.org/blog/multitrack-timeline/)
- Kdenlive: Selection and Razor are the basic timeline tools; separate context menus for clips and empty timeline space. [Kdenlive editing](https://docs.kdenlive.org/en/cutting_and_assembling/editing.html), [Kdenlive right-click menus](https://docs.kdenlive.org/en/cutting_and_assembling/right_click_menu.html)

CutCat interactions:

- The entire empty timeline is a drop target. Clicking opens the native file picker.
- Clicking a clip selects it. Edge trim handles have a hit area of at least 12 px.
- Clicking the ruler or a clip moves the playhead. Dragging scrubs.
- Right-click a clip: `Cut here`, `Delete`.
- `S`: split at the playhead. `Delete`/`Backspace`: ripple delete the selected segment.
- `Space`: play/pause. `Left`/`Right`: one frame. `Shift+Left`/`Shift+Right`: five frames.
- `+`/`-`: timeline zoom. `0`: fit. `Ctrl/Cmd + scroll wheel`: zoom around the pointer.
- `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, and `Ctrl+Y` on Windows: undo/redo.
- Minimum clip duration: one frame. Trimming and splitting snap to the frame grid.
- Pointer capture keeps dragging stable even when the pointer leaves the handle.
- Keyboard alternative: clips and handles are focusable; arrow keys trim focused handles.

## Tauri architecture

- Windows requires native `getCurrentWebview().onDragDropEvent()`: it provides real paths without disabling Tauri drops for HTML5 drag and drop. The listener is removed on unmount. [Tauri drag/drop API](https://v2.tauri.app/reference/javascript/api/namespacewebview/#ondragdropevent)
- Rust `import_media` canonicalizes the path, checks for a regular file, then parses `ffprobe` JSON.
- Preview URL: `convertFileSrc(canonicalPath)`. The asset protocol receives runtime scope for the exact imported file only; there is no glob covering the entire home directory. [Tauri `convertFileSrc`](https://v2.tauri.app/reference/javascript/api/namespacecore/#convertfilesrc)
- FFmpeg and ffprobe are Tauri sidecars. A platform-specific target-triple suffix is required. [Tauri sidecar](https://v2.tauri.app/develop/sidecar/)
- The frontend has no raw shell or FFmpeg argument API. Only typed `import_media`, `start_export`, and `cancel_export` commands are exposed.
- Export progress arrives through `Channel<ExportEvent>`; FFmpeg `-progress pipe:1` produces `key=value` blocks. [Tauri channels](https://v2.tauri.app/develop/calling-rust/#channels), [FFmpeg progress](https://ffmpeg.org/ffmpeg.html#Main-options)

## FFmpeg export

Default `Compatible MP4`:

```text
-c:v libx264 -preset veryfast -crf 20
-pix_fmt yuv420p
-c:a aac -b:a 192k
-movflags +faststart
```

Frame-accurate filtergraph for multiple sources and per-clip effects:

```text
[0:v]trim=start=S0:end=E0,setpts=PTS-STARTPTS[v0];
[0:a]atrim=start=S0:end=E0,asetpts=PTS-STARTPTS[a0];
[0:v]trim=start=S1:end=E1,setpts=PTS-STARTPTS[v1];
[0:a]atrim=start=S1:end=E1,asetpts=PTS-STARTPTS[a1];
[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]
```

Video branches are normalized to a shared canvas (`scale` + `pad` + `setsar`), then joined with `concat=v=1:a=0`. Embedded and detached/external audio use separate branches: `atrim`, `asetpts`, chained `atempo`, `volume`, and sample-accurate `adelay`, followed by `amix` and a limiter. Sources without audio receive no audio branch. [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html)

`Fast copy` is available only for one contiguous segment:

```text
-ss START -i INPUT -t DURATION -map 0:v:0? -map 0:a:0? -c copy
```

This is fast and lossless, but the start point depends on keyframes when using stream copy, so frame accuracy is not guaranteed. [FFmpeg `-ss` and stream copy](https://ffmpeg.org/ffmpeg.html#Main-options)

Output is first written to a unique `.partial.mp4` file and renamed only after FFmpeg exits successfully and the file is nonempty. Overwriting input files is prohibited. Presets come from an enum allowlist; the frontend does not send filtergraphs.

## Visual system

Theme: a precise editing bench, not a generic “dark SaaS dashboard”.

- `Bench` `#101519`: main workspace
- `Slate` `#182027`: panels
- `Rail` `#263139`: timeline rail
- `Paper` `#E7ECEE`: primary text
- `Fog` `#8E9BA2`: secondary text
- `Tungsten` `#F2B84B`: cuts/playhead/primary action
- `Ice` `#82D6D2`: selected clip and focus

Typography:

- display: Bahnschrift / DIN Alternate
- UI: Segoe UI Variable / system-ui
- timecode: Cascadia Mono / ui-monospace

Signature element: two small, angular “cat ear” notches on the playhead head and trim handles. This is the only playful motif; the other elements are strict, compact, and minimal.

```text
+---------------------------------------------------------------+
| CUT/CAT       project                         Undo  Export     |
+----------------------------------------------+----------------+
|                                              | Inspector      |
|                  PREVIEW                     | source/export  |
|                                              | settings       |
|              playback + timecode             |                |
+----------------------------------------------+----------------+
| Select  Split  | ruler       playhead          -  fit  +      |
| V1             | [ clip ][ clip ][ clip ]                    |
|                |  thumbnails / source time                    |
+---------------------------------------------------------------+
```

## 0.2 scope

Included:

- import multiple local video and audio files by drag and drop or dialog;
- preview and project-time playback across split segments;
- trim both edges;
- split from the context menu, toolbar, and `S`;
- video reordering, A1 audio movement, and overlapping audio;
- per-clip speed/volume/mute and audio detachment;
- ripple delete, undo/redo, zoom/fit;
- metadata inspector;
- accurate and fast export, progress, and cancellation;
- browser fallback for standalone frontend development.

Later:

- real audio waveforms;
- thumbnail cache/proxy;
- transitions, titles, and multiple individually named video tracks;
- project files and autosave;
- hardware encoder capability detection.

## License note

The FFmpeg build configuration determines the distribution license. `--enable-gpl` and `libx264` entail GPL obligations; builds with `--enable-nonfree` cannot be redistributed. Before a release, audit the pinned binary, SHA-256, buildconf, source/build instructions, and license. [FFmpeg legal](https://ffmpeg.org/legal.html)
