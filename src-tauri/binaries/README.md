# FFmpeg sidecars

`npm install` runs `scripts/prepare-ffmpeg.mjs`. This copies the
`ffmpeg-static` and `ffprobe-static` binaries into this directory
using the target-triple filenames required by Tauri.

Large platform binaries are not tracked in Git.

Manual update:

```powershell
npm.cmd run ffmpeg:prepare
```

Before a release, check the FFmpeg build configuration and the
license notes in `THIRD_PARTY_NOTICES.md`.
