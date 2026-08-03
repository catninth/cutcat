# Third-party notices

## FFmpeg

CutCat development builds prepare FFmpeg and ffprobe through the
`ffmpeg-static` and `ffprobe-static` npm packages. The exact FFmpeg binary build
configuration determines redistribution obligations.

The current `ffmpeg-static` package declares `GPL-3.0-or-later` and commonly
ships a GPL-enabled FFmpeg build containing `libx264`. Distributing a CutCat
bundle with that binary requires GPL compliance. Do not ship a binary built
with FFmpeg's `--enable-nonfree` option.

Before any public release:

1. Pin and record the binary SHA-256.
2. Archive `ffmpeg -version` and `ffmpeg -buildconf`.
3. Provide the corresponding FFmpeg source and build instructions as required.
4. Include FFmpeg copyright and license text.
5. Audit codec patent and licensing requirements for target markets.

Official compliance guidance: <https://ffmpeg.org/legal.html>
