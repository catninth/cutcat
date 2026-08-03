# CutCat — timeline és export kutatás

Kutatás dátuma: 2026-07-30

## MVP-döntés

CutCat non-destructive szerkesztő. Import után a forrásfájl változatlan marad; a projekt csak forrás-időszakaszokat, sorrendet és klipszintű beállításokat tárol. A V1 videosáv magnetic/ripple sorrendű. Az A1 hangklipek szabad timeline-pozícióval rendelkeznek és átfedéskor külön vizuális réteget kapnak.

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

Minden belső idő egész mikroszekundum. Lebegőpontos másodperc csak HTML media API és FFmpeg argument határán készül.

## 0.2 kutatási döntések

- Primary storyline: a V1 klipek magnetic sorrendben maradnak; drag-and-drop átrendezés beszúrási helyet mutat és nem ír felül más klipet. Final Cut Pro ugyanezt a ripple-alapú történetszál-modellt és beszúrásos átrendezést használja. [Apple: ripple edits](https://support.apple.com/en-tm/guide/final-cut-pro/ver9847ec25/mac), [Apple: reorder clips](https://support.apple.com/en-ca/guide/final-cut-pro/verc147f195/mac)
- Két eszköz: `V` Kijelölés trimhez/kijelöléshez/mozgatáshoz, `C` Vágás kattintási pontnál. Ez megfelel a középkategóriás és profi szerkesztők selection/razor felosztásának. [Adobe: Tools panel](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/tools-panel-and-options-panel.html)
- Több fájl egy importtal a V1 végére, önálló hang az A1-re. A közvetlen timeline-drop és a több média egymás utáni elhelyezése bevett szerkesztői minta. [Microsoft: Clipchamp editing](https://support.microsoft.com/en-us/clipchamp/how-to-edit-a-video-in-clipchamp), [Apple: add multiple clips](https://support.apple.com/en-mide/guide/final-cut-pro/ver4e30143/mac)
- Klipszintű speed/volume/mute: split után minden új klip saját értékeket tart meg. Sebesség módosításakor a timeline-hossz `sourceDuration / speed`. [Microsoft: speed](https://support.microsoft.com/en-us/clipchamp/how-to-speed-up-or-slow-down-a-video), [Apple: retime clips](https://support.apple.com/en-lamr/guide/final-cut-pro/ver40b00150/mac)
- Hang leválasztás: egy undo-lépésben a videó beágyazott hangja kikapcsol, ugyanazon forrástartománnyal külön A1 klip jön létre. [Apple: detach audio](https://support.apple.com/en-my/guide/final-cut-pro/ver549f212d/mac)
- Egér nélküli alternatíva kell minden drag művelethez: fókuszolható klipek/fogantyúk, nyilas trim, `Alt+←/→` sorrendváltás. Ez a WCAG dragging-movements követelménye. [W3C WCAG 2.2: Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
- MP3 first-class MediaSource. `ffprobe` audio stream kell; album art `attached_pic` nem számít videosávnak.

## Timeline UX

Szakmai minták:

- Adobe Premiere: clip széle fölött trim kurzor, szélek húzásával In/Out állítás; razor/split külön edit pontot készít. A timeline szerkesztés non-destructive. [Adobe: edit video](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/edit-video-in-premiere.html), [Adobe: trim](https://helpx.adobe.com/uk/premiere/desktop/edit-projects/trim-clips/trim-a-clip.html)
- Premiere navigáció: time ruler, playhead, frame-step nyilakkal, `+`/`-` zoom, zoom a playhead körül. [Adobe: navigate sequences](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigate-sequences-in-the-timeline.html)
- Clipchamp: média közvetlen timeline drop, kijelölt clip két szélén fogantyú, split a playheadnél, `S`, `Delete`, zoom/fit. [Microsoft: edit a video](https://support.microsoft.com/en-us/clipchamp/how-to-edit-a-video-in-clipchamp), [Microsoft: trim assets](https://support.microsoft.com/en-us/clipchamp/how-to-trim-videos-images-or-audio-assets)
- Shotcut: `S` split, `Space` playback, `+`/`-` zoom, `0` fit, snapping, ripple trim; a trim visszahúzható, mert a forrás nem változik. [Shotcut shortcuts](https://shotcut.org/howtos/keyboard-shortcuts/), [Shotcut timeline](https://www.shotcut.org/blog/multitrack-timeline/)
- Kdenlive: Selection és Razor mint alap timeline eszközök; külön clip és üres-timeline context menu. [Kdenlive editing](https://docs.kdenlive.org/en/cutting_and_assembling/editing.html), [Kdenlive right-click menus](https://docs.kdenlive.org/en/cutting_and_assembling/right_click_menu.html)

CutCat interakció:

- Üres timeline teljes felülete drop target. Kattintás natív fájlválasztót nyit.
- Clip kattintás kijelöl. Szélek legalább 12 px hit-area méretű trim fogantyúk.
- Ruler vagy clip kattintás mozgatja a playheadet. Húzás scrub.
- Jobb kattintás a clipen: `Vágás itt`, `Törlés`.
- `S`: split a playheadnél. `Delete`/`Backspace`: kijelölt szegmens ripple törlése.
- `Space`: play/pause. `Left`/`Right`: egy frame. `Shift+Left`/`Shift+Right`: öt frame.
- `+`/`-`: timeline zoom. `0`: fit. `Ctrl/Cmd + görgő`: zoom a mutató körül.
- `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` és Windows-on `Ctrl+Y`: undo/redo.
- Minimum clip idő: egy frame. Trim és split a frame-rácshoz snapel.
- Pointer capture tartja stabilan a drag műveletet akkor is, ha a kurzor elhagyja a fogantyút.
- Egér nélküli alternatíva: clip és fogantyúk fókuszolhatók; fogantyúkon nyíl trimel.

## Tauri architektúra

- Windows alatt natív `getCurrentWebview().onDragDropEvent()` kell: valódi pathot ad és nem igényli a HTML5 drop kedvéért a Tauri drop kikapcsolását. Listener unmountkor leáll. [Tauri drag/drop API](https://v2.tauri.app/reference/javascript/api/namespacewebview/#ondragdropevent)
- Rust `import_media` canonicalize-ol, regular file-t ellenőriz, majd `ffprobe` JSON-t parseol.
- Preview URL: `convertFileSrc(canonicalPath)`. Asset protocol csak az importált exact fájlra kap runtime scope-ot; nincs teljes home könyvtár glob. [Tauri `convertFileSrc`](https://v2.tauri.app/reference/javascript/api/namespacecore/#convertfilesrc)
- FFmpeg és ffprobe Tauri sidecar. Platformonként target-triple suffix szükséges. [Tauri sidecar](https://v2.tauri.app/develop/sidecar/)
- Frontend nem kap nyers shell vagy FFmpeg argument API-t. Csak tipizált `import_media`, `start_export`, `cancel_export`.
- Export progress `Channel<ExportEvent>` útvonalon jön; FFmpeg `-progress pipe:1` `key=value` blokkokat ad. [Tauri channels](https://v2.tauri.app/develop/calling-rust/#channels), [FFmpeg progress](https://ffmpeg.org/ffmpeg.html#Main-options)

## FFmpeg export

Alapértelmezett `Compatible MP4`:

```text
-c:v libx264 -preset veryfast -crf 20
-pix_fmt yuv420p
-c:a aac -b:a 192k
-movflags +faststart
```

Több forrás és klipszintű effekt frame-pontos filtergraphja:

```text
[0:v]trim=start=S0:end=E0,setpts=PTS-STARTPTS[v0];
[0:a]atrim=start=S0:end=E0,asetpts=PTS-STARTPTS[a0];
[0:v]trim=start=S1:end=E1,setpts=PTS-STARTPTS[v1];
[0:a]atrim=start=S1:end=E1,asetpts=PTS-STARTPTS[a1];
[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]
```

Videóágak egységes canvasra kerülnek (`scale` + `pad` + `setsar`), majd `concat=v=1:a=0`. Beágyazott és leválasztott/külső hang külön ág: `atrim`, `asetpts`, láncolt `atempo`, `volume`, sample-pontos `adelay`; végül `amix` és limiter. Audio nélküli forrás nem kap hangágat. [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html)

`Fast copy` csak egy összefüggő szegmenshez elérhető:

```text
-ss START -i INPUT -t DURATION -map 0:v:0? -map 0:a:0? -c copy
```

Ez gyors és veszteségmentes, de stream copy esetén a kezdés keyframe-függő, ezért nem garantált a frame-pontosság. [FFmpeg `-ss` és stream copy](https://ffmpeg.org/ffmpeg.html#Main-options)

Output előbb egyedi `.partial.mp4`, majd csak sikeres FFmpeg exit és nem üres fájl után rename. Input felülírás tiltott. Preset enum allowlistből jön; frontend nem küld filtergraphot.

## Vizuális rendszer

Téma: precíz vágóasztal, nem általános „dark SaaS dashboard”.

- `Bench` `#101519`: fő munkafelület
- `Slate` `#182027`: panelek
- `Rail` `#263139`: timeline sín
- `Paper` `#E7ECEE`: fő szöveg
- `Fog` `#8E9BA2`: másodlagos szöveg
- `Tungsten` `#F2B84B`: vágás/playhead/primary action
- `Ice` `#82D6D2`: kijelölt clip és fókusz

Betű:

- display: Bahnschrift / DIN Alternate
- UI: Segoe UI Variable / system-ui
- timecode: Cascadia Mono / ui-monospace

Signature elem: playhead teteje és trim fogantyúja két apró, szögletes „macskafül” notch. Egyetlen játékos motívum; többi elem szigorú, kompakt, minimális.

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

## 0.2 határ

Benne:

- több lokális videó és hang import drag-and-drop vagy dialog;
- preview és projekt-idő alapú lejátszás split szegmenseken át;
- trim mindkét szélen;
- split jobb klikkből, toolbarból és `S`-sel;
- video reorder, A1 hangmozgatás és átfedő hangok;
- klipszintű speed/volume/mute, hang leválasztás;
- ripple delete, undo/redo, zoom/fit;
- metadata inspector;
- exact és fast export, progress és cancel;
- browser fallback a frontend önálló fejlesztéséhez.

Későbbi:

- valódi audio waveform;
- thumbnail cache/proxy;
- transitions, titles, több külön névvel rendelkező videosáv;
- projektfájl és autosave;
- hardware encoder capability detection.

## Licenc megjegyzés

FFmpeg build konfiguráció dönti el a terjesztési licencet. `--enable-gpl` és `libx264` GPL-kötelezettséget hoz; `--enable-nonfree` build nem redisztribuálható. Release előtt pinned binary, SHA-256, buildconf, forrás/build utasítás és licence audit szükséges. [FFmpeg legal](https://ffmpeg.org/legal.html)
