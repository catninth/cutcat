import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const projectRoot = resolve(import.meta.dirname, "..");
const binaryDir = resolve(projectRoot, "src-tauri", "binaries");
const hostTuple =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const executableSuffix = process.platform === "win32" ? ".exe" : "";

const binaries = [
  { name: "ffmpeg", source: ffmpegPath },
  { name: "ffprobe", source: ffprobeStatic.path },
];

mkdirSync(binaryDir, { recursive: true });

for (const binary of binaries) {
  if (!binary.source || !existsSync(binary.source)) {
    throw new Error(`${binary.name} binary missing after npm install.`);
  }

  const destination = resolve(
    binaryDir,
    `${binary.name}-${hostTuple}${executableSuffix}`,
  );
  copyFileSync(binary.source, destination);

  if (process.platform !== "win32") {
    chmodSync(destination, 0o755);
  }

  console.log(
    `Prepared ${binary.name}: ${basename(destination)} (${hostTuple})`,
  );
}
