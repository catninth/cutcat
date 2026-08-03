export type Microseconds = number;
export type MediaKind = "video" | "audio";
export type ClipKind = "video" | "audio";

export interface MediaSource {
  id: string;
  path: string | null;
  url: string;
  name: string;
  kind: MediaKind;
  durationUs: Microseconds;
  width: number;
  height: number;
  fps: number;
  videoCodec: string | null;
  audioCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  sizeBytes: number;
  canExport: boolean;
}

export interface TimelineVideoClip {
  id: string;
  kind: "video";
  mediaId: string;
  sourceInUs: Microseconds;
  sourceOutUs: Microseconds;
  speed: number;
  volume: number;
  muted: boolean;
  audioDetached: boolean;
}

export interface TimelineAudioClip {
  id: string;
  kind: "audio";
  mediaId: string;
  sourceInUs: Microseconds;
  sourceOutUs: Microseconds;
  timelineStartUs: Microseconds;
  speed: number;
  volume: number;
  muted: boolean;
  linkedVideoClipId: string | null;
}

export type TimelineClip = TimelineVideoClip | TimelineAudioClip;

export interface EditorProject {
  videoClips: TimelineVideoClip[];
  audioClips: TimelineAudioClip[];
}

export interface PositionedVideoClip extends TimelineVideoClip {
  projectStartUs: Microseconds;
  projectEndUs: Microseconds;
}

export interface PositionedAudioClip extends TimelineAudioClip {
  projectStartUs: Microseconds;
  projectEndUs: Microseconds;
}

export type PositionedClip = PositionedVideoClip | PositionedAudioClip;
export type TrimEdge = "start" | "end";
export type EditorTool = "select" | "razor";
export type ExportPreset = "fast" | "balanced" | "quality";
export type ExportMode = "precise" | "fastCopy";
export type ExportResolution = "source" | "1080" | "720";

export interface ExportSettings {
  preset: ExportPreset;
  mode: ExportMode;
  resolution: ExportResolution;
}

export interface ExportSource {
  id: string;
  path: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface ExportVideoClip {
  mediaId: string;
  sourceInUs: number;
  sourceOutUs: number;
  speed: number;
  volume: number;
  muted: boolean;
  includeAudio: boolean;
}

export interface ExportAudioClip {
  mediaId: string;
  sourceInUs: number;
  sourceOutUs: number;
  timelineStartUs: number;
  speed: number;
  volume: number;
  muted: boolean;
}

export interface ExportSpec {
  sources: ExportSource[];
  videoClips: ExportVideoClip[];
  audioClips: ExportAudioClip[];
  outputPath: string;
  preset: ExportPreset;
  mode: ExportMode;
  resolution: ExportResolution;
}

export type ExportEvent =
  | { event: "started"; jobId: string }
  | {
      event: "progress";
      progress: number;
      outTimeUs: number;
      speed: string | null;
    }
  | { event: "completed"; outputPath: string }
  | { event: "cancelled" }
  | { event: "failed"; message: string };

export interface ExportStatus {
  phase: "idle" | "running" | "completed" | "cancelled" | "failed";
  jobId: string | null;
  progress: number;
  speed: string | null;
  outputPath: string | null;
  message: string | null;
}
