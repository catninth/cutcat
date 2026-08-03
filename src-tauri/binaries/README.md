# FFmpeg sidecars

`npm install` futtatja a `scripts/prepare-ffmpeg.mjs` scriptet. Ez az
`ffmpeg-static` és `ffprobe-static` binárisokat a Tauri által elvárt
target-triple névre másolja ebbe a mappába.

A nagy platformbinárisok nincsenek Gitben.

Kézi frissítés:

```powershell
npm.cmd run ffmpeg:prepare
```

Release előtt ellenőrizd az FFmpeg build konfigurációját és a
`THIRD_PARTY_NOTICES.md` licenc-megjegyzéseit.
