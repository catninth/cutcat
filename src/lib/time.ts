import type { Microseconds } from "../types/editor";

export const US_PER_SECOND = 1_000_000;

export function secondsToUs(seconds: number): Microseconds {
  return Math.round(seconds * US_PER_SECOND);
}

export function usToSeconds(timeUs: Microseconds): number {
  return timeUs / US_PER_SECOND;
}

export function frameDurationUs(fps: number): Microseconds {
  return Math.max(1, Math.round(US_PER_SECOND / Math.max(fps, 1)));
}

export function snapToFrame(timeUs: Microseconds, fps: number): Microseconds {
  const frameUs = frameDurationUs(fps);
  return Math.round(timeUs / frameUs) * frameUs;
}

export function formatTimecode(timeUs: Microseconds, fps = 30): string {
  const safeTimeUs = Math.max(0, Math.round(timeUs));
  const nominalFps = Math.max(1, Math.round(fps));
  const totalFrames = Math.round(safeTimeUs / frameDurationUs(fps));
  const totalSeconds = Math.floor(totalFrames / nominalFps);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const frames = totalFrames % nominalFps;

  return [hours, minutes, seconds, frames]
    .map((part) => part.toString().padStart(2, "0"))
    .join(":");
}

export function formatDuration(timeUs: Microseconds): string {
  const totalSeconds = Math.max(0, Math.round(timeUs / US_PER_SECOND));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
        .toString()
        .padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}
