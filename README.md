# CutCat

Gyors, fókuszált desktop videóvágó React, Tauri 2 és FFmpeg alapon.

CutCat 0.2 több videó- és hangforrást kezel magnetic V1 videosávon és szabadon pozicionálható A1 hangsávon. A szerkesztés non-destructive: a forrásfájl nem változik, csak a klipek sorrendje és beállításai.

## Kész funkciók

- több videó és MP3/hang drag-and-drop közvetlenül a timeline-ra;
- `ffprobe` metadata: hossz, felbontás, fps, video- és audiokodek;
- frame-pontos playhead, preview és frame-step;
- javított kétoldali trim: bal fogantyú húzásakor a bal klipszél mozog;
- valódi Kijelölés (`V`) és Vágás (`C`) timeline-eszköz;
- split jobb klikkből, toolbarból vagy `S`-sel, natív böngészőmenü nélkül;
- videók drag-and-drop sorrendezése, hangsávok szabad mozgatása;
- klipszintű hangerő, némítás és 0.25×–4× sebesség;
- videóhang leválasztása külön, vágható A1 klippé;
- ripple delete, undo/redo, timeline zoom és fit;
- többforrásos H.264/AAC MP4 export, normalizált képméret és hangkeverés;
- opcionális gyors stream-copy egyetlen szegmenshez;
- FFmpeg progress, megszakítás és biztonságos partial-output;
- böngészős frontend fallback gyors UI-fejlesztéshez.

A kutatás, UX-döntések, FFmpeg filtergraph és architektúra: [docs/RESEARCH.md](docs/RESEARCH.md).

## Indítás

Szükséges:

- Node.js 24 vagy újabb;
- Rust stable;
- Windows alatt a `stable-x86_64-pc-windows-msvc` toolchain, Visual Studio Build Tools „Desktop development with C++” workload és Windows SDK;
- WebView2 Runtime.

```powershell
npm install
npm run tauri:dev
```

Az `npm install` a platformhoz illő FFmpeg és ffprobe sidecart bemásolja a `src-tauri/binaries` könyvtárba target-triple névvel.

Csak a React UI:

```powershell
npm run dev
```

A böngészős mód importot, preview-t és timeline-szerkesztést ad. Natív fájlpath hiányában exportot nem indít.

## Használat

1. Húzz egy vagy több videót/MP3-at a timeline-ra.
2. `Kijelölés` módban jelölj, trimelj és rendezd át a klipeket.
3. `Vágás` módban kattints a kívánt klippontba.
4. Jobb klikk egy videón → `Hang leválasztása`, ha külön A1 klip kell.
5. Állíts sebességet, hangerőt vagy némítást a kijelölt kliphez.
6. Válassz exportminőséget és felbontást, majd `Export`.

Gyorsbillentyűk:

| Billentyű | Művelet |
| --- | --- |
| `V` | Kijelölés és mozgatás eszköz |
| `C` | Vágás eszköz |
| `Space` | Lejátszás / szünet |
| `S` | Split a playheadnél |
| `M` | Kijelölt klip némítása |
| `Alt` + `←` / `→` | Kijelölt videó sorrendjének módosítása |
| `Delete` / `Backspace` | Kijelölt szegmens ripple törlése |
| `←` / `→` | 1 frame lépés |
| `Shift` + `←` / `→` | 5 frame lépés |
| `+` / `-` | Timeline zoom |
| `0` | Timeline fit |
| `Ctrl/Cmd+Z` | Visszavonás |
| `Ctrl/Cmd+Shift+Z`, `Ctrl+Y` | Újra |

## Ellenőrzés és build

```powershell
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:portable
npm run tauri:build
```

Az `npm run tauri:portable` telepítő nélkül készíti el a release `.exe`-t és
sidecarokat a `src-tauri/target/release` mappában. A teljes telepítőcsomaghoz
használd a `npm run tauri:build` parancsot.

## Szerkezet

```text
src/
  components/       React editor UI
  hooks/            undo/redo history
  lib/              timeline matematika, idő és Tauri bridge
  types/            IPC és editor típusok
src-tauri/
  src/media.rs      canonical import + ffprobe
  src/export.rs     validálás, filtergraph, progress, cancel
  capabilities/     minimális Tauri jogosultságok
scripts/
  prepare-ffmpeg.mjs
```

## FFmpeg licenc

A fejlesztői csomag `ffmpeg-static` és `ffprobe-static` binárist használ. Release előtt kötelező a választott binary build konfigurációjának és licencének auditja. A `libx264`-et tartalmazó GPL FFmpeg build terjesztése GPL-kötelezettségeket hoz; `--enable-nonfree` build nem redisztribuálható. Részletek: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) és [FFmpeg Legal](https://ffmpeg.org/legal.html).
