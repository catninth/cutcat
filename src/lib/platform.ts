import type {
  ExportEvent,
  ExportSpec,
  MediaKind,
  MediaSource,
} from "../types/editor";

interface BackendMediaMetadata {
  path: string;
  name: string;
  kind: MediaKind;
  durationUs: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string | null;
  audioCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  sizeBytes: number;
}

const MEDIA_EXTENSION =
  /\.(mp4|mov|mkv|webm|avi|m4v|mts|m2ts|mp3|wav|m4a|aac|flac|ogg|opus)$/i;
const AUDIO_EXTENSION = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;

export function isNativeRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function importMediaFromPath(path: string): Promise<MediaSource> {
  const { convertFileSrc, invoke } = await import("@tauri-apps/api/core");
  const metadata = await invoke<BackendMediaMetadata>("import_media", { path });
  return {
    id: crypto.randomUUID(),
    ...metadata,
    url: convertFileSrc(metadata.path),
    canExport: true,
  };
}

export async function openMediaPaths(): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selection = await open({
    multiple: true,
    directory: false,
    title: "Open media",
    filters: [
      {
        name: "Video and audio",
        extensions: [
          "mp4",
          "mov",
          "mkv",
          "webm",
          "avi",
          "m4v",
          "mts",
          "m2ts",
          "mp3",
          "wav",
          "m4a",
          "aac",
          "flac",
          "ogg",
          "opus",
        ],
      },
    ],
  });
  if (Array.isArray(selection)) return selection;
  return typeof selection === "string" ? [selection] : [];
}

export async function chooseExportPath(
  suggestedName: string,
): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    title: "Export video",
    defaultPath: suggestedName,
    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
  });
}

export async function subscribeToNativeFileDrop(
  onState: (state: {
    active: boolean;
    paths?: string[];
    position?: { x: number; y: number };
  }) => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => undefined;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "over") {
      onState({ active: true, position: event.payload.position });
    } else if (event.payload.type === "drop") {
      onState({
        active: false,
        paths: event.payload.paths,
        position: event.payload.position,
      });
    } else {
      onState({ active: false });
    }
  });
}

export async function startExport(
  spec: ExportSpec,
  onEvent: (event: ExportEvent) => void,
): Promise<string> {
  const { Channel, invoke } = await import("@tauri-apps/api/core");
  const channel = new Channel<ExportEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("start_export", { spec, onEvent: channel });
}

export async function cancelExport(jobId: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("cancel_export", { jobId });
}

export async function importBrowserFile(file: File): Promise<MediaSource> {
  const url = URL.createObjectURL(file);
  const kind: MediaKind =
    file.type.startsWith("audio/") || AUDIO_EXTENSION.test(file.name)
      ? "audio"
      : "video";
  try {
    const metadata = await readBrowserMetadata(url, kind);
    return {
      id: crypto.randomUUID(),
      path: null,
      url,
      name: file.name,
      kind,
      durationUs: Math.round(metadata.duration * 1_000_000),
      width: metadata.width,
      height: metadata.height,
      fps: 30,
      videoCodec: kind === "video" ? "browser preview" : null,
      audioCodec: kind === "audio" ? "browser preview" : null,
      hasVideo: kind === "video",
      hasAudio: true,
      sizeBytes: file.size,
      canExport: false,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function readBrowserMetadata(
  url: string,
  kind: MediaKind,
): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const element = document.createElement(kind === "video" ? "video" : "audio");
    element.preload = "metadata";
    element.onloadedmetadata = () => {
      const video = element instanceof HTMLVideoElement ? element : null;
      resolve({
        duration: element.duration,
        width: video?.videoWidth ?? 0,
        height: video?.videoHeight ?? 0,
      });
      element.removeAttribute("src");
      element.load();
    };
    element.onerror = () => {
      reject(new Error("The browser could not open this media file."));
      element.removeAttribute("src");
      element.load();
    };
    element.src = url;
  });
}

export function isMediaFile(file: File): boolean {
  return (
    file.type.startsWith("video/") ||
    file.type.startsWith("audio/") ||
    MEDIA_EXTENSION.test(file.name)
  );
}

export function isMediaPath(path: string): boolean {
  return MEDIA_EXTENSION.test(path);
}
