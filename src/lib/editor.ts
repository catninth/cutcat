import type {
  EditorProject,
  MediaSource,
  PositionedAudioClip,
  PositionedVideoClip,
  TimelineAudioClip,
  TimelineClip,
  TimelineVideoClip,
  TrimEdge,
} from "../types/editor";
import { frameDurationUs, snapToFrame } from "./time";

export const EMPTY_PROJECT: EditorProject = {
  videoClips: [],
  audioClips: [],
};

export function clipPlaybackDurationUs(
  clip: Pick<TimelineClip, "sourceInUs" | "sourceOutUs" | "speed">,
): number {
  return Math.max(
    0,
    Math.round((clip.sourceOutUs - clip.sourceInUs) / Math.max(clip.speed, 0.01)),
  );
}

export function positionVideoClips(
  clips: TimelineVideoClip[],
): PositionedVideoClip[] {
  let projectStartUs = 0;

  return clips.map((clip) => {
    const projectEndUs = projectStartUs + clipPlaybackDurationUs(clip);
    const positioned = { ...clip, projectStartUs, projectEndUs };
    projectStartUs = projectEndUs;
    return positioned;
  });
}

export function positionAudioClips(
  clips: TimelineAudioClip[],
): PositionedAudioClip[] {
  return clips.map((clip) => ({
    ...clip,
    projectStartUs: clip.timelineStartUs,
    projectEndUs: clip.timelineStartUs + clipPlaybackDurationUs(clip),
  }));
}

export function projectDurationUs(project: EditorProject): number {
  const videoEnd = positionVideoClips(project.videoClips).at(-1)?.projectEndUs ?? 0;
  let audioEnd = 0;
  for (const clip of project.audioClips) {
    audioEnd = Math.max(
      audioEnd,
      clip.timelineStartUs + clipPlaybackDurationUs(clip),
    );
  }
  return Math.max(videoEnd, audioEnd);
}

export function findVideoClipAtProjectTime(
  clips: TimelineVideoClip[],
  projectTimeUs: number,
): PositionedVideoClip | null {
  const positioned = positionVideoClips(clips);
  if (positioned.length === 0) return null;
  const clamped = Math.max(0, projectTimeUs);
  return (
    positioned.find(
      (clip) => clamped >= clip.projectStartUs && clamped < clip.projectEndUs,
    ) ??
    (clamped === positioned.at(-1)?.projectEndUs
      ? positioned.at(-1) ?? null
      : null)
  );
}

export function projectToSourceTime(
  clips: TimelineVideoClip[],
  projectTimeUs: number,
): { clip: PositionedVideoClip; sourceTimeUs: number } | null {
  const clip = findVideoClipAtProjectTime(clips, projectTimeUs);
  if (!clip) return null;
  const projectOffsetUs = Math.min(
    Math.max(projectTimeUs - clip.projectStartUs, 0),
    clipPlaybackDurationUs(clip),
  );
  return {
    clip,
    sourceTimeUs: Math.min(
      clip.sourceOutUs,
      clip.sourceInUs + projectOffsetUs * clip.speed,
    ),
  };
}

export function getClip(
  project: EditorProject,
  clipId: string | null,
): TimelineClip | null {
  if (!clipId) return null;
  return (
    project.videoClips.find((clip) => clip.id === clipId) ??
    project.audioClips.find((clip) => clip.id === clipId) ??
    null
  );
}

export function getClipProjectStartUs(
  project: EditorProject,
  clipId: string,
): number {
  const video = positionVideoClips(project.videoClips).find(
    (clip) => clip.id === clipId,
  );
  if (video) return video.projectStartUs;
  return (
    project.audioClips.find((clip) => clip.id === clipId)?.timelineStartUs ?? 0
  );
}

export function splitClipAtProjectTime(
  project: EditorProject,
  clipId: string,
  projectTimeUs: number,
  mediaById: Map<string, MediaSource>,
  createId: () => string = () => crypto.randomUUID(),
): EditorProject | null {
  const videoIndex = project.videoClips.findIndex((clip) => clip.id === clipId);
  if (videoIndex >= 0) {
    const target = positionVideoClips(project.videoClips)[videoIndex];
    const media = mediaById.get(target.mediaId);
    const fps = media?.fps || 30;
    const frameUs = frameDurationUs(fps);
    const sourceTimeUs = snapToFrame(
      target.sourceInUs +
        Math.max(0, projectTimeUs - target.projectStartUs) * target.speed,
      fps,
    );
    if (
      sourceTimeUs - target.sourceInUs < frameUs ||
      target.sourceOutUs - sourceTimeUs < frameUs
    ) {
      return null;
    }
    const original = project.videoClips[videoIndex];
    const left = { ...original, sourceOutUs: sourceTimeUs };
    const right = { ...original, id: createId(), sourceInUs: sourceTimeUs };
    return {
      ...project,
      videoClips: [
        ...project.videoClips.slice(0, videoIndex),
        left,
        right,
        ...project.videoClips.slice(videoIndex + 1),
      ],
    };
  }

  const audioIndex = project.audioClips.findIndex((clip) => clip.id === clipId);
  if (audioIndex < 0) return null;
  const original = project.audioClips[audioIndex];
  const media = mediaById.get(original.mediaId);
  const fps = media?.fps || 30;
  const frameUs = frameDurationUs(fps);
  const projectOffsetUs = projectTimeUs - original.timelineStartUs;
  const sourceTimeUs = snapToFrame(
    original.sourceInUs + projectOffsetUs * original.speed,
    fps,
  );
  if (
    projectOffsetUs <= 0 ||
    sourceTimeUs - original.sourceInUs < frameUs ||
    original.sourceOutUs - sourceTimeUs < frameUs
  ) {
    return null;
  }
  const left = { ...original, sourceOutUs: sourceTimeUs };
  const right = {
    ...original,
    id: createId(),
    sourceInUs: sourceTimeUs,
    timelineStartUs: projectTimeUs,
  };
  return {
    ...project,
    audioClips: [
      ...project.audioClips.slice(0, audioIndex),
      left,
      right,
      ...project.audioClips.slice(audioIndex + 1),
    ],
  };
}

export function trimProjectClip(
  project: EditorProject,
  clipId: string,
  edge: TrimEdge,
  requestedSourceUs: number,
  media: MediaSource,
): EditorProject {
  const fps = media.fps || 30;
  const frameUs = frameDurationUs(fps);
  const trim = <T extends TimelineClip>(clip: T): T => {
    const snapped = snapToFrame(requestedSourceUs, fps);
    if (edge === "start") {
      return {
        ...clip,
        sourceInUs: Math.min(
          Math.max(0, snapped),
          clip.sourceOutUs - frameUs,
        ),
      };
    }
    return {
      ...clip,
      sourceOutUs: Math.max(
        Math.min(media.durationUs, snapped),
        clip.sourceInUs + frameUs,
      ),
    };
  };

  const videoIndex = project.videoClips.findIndex((clip) => clip.id === clipId);
  if (videoIndex >= 0) {
    const next = [...project.videoClips];
    next[videoIndex] = trim(next[videoIndex]);
    return { ...project, videoClips: next };
  }

  const audioIndex = project.audioClips.findIndex((clip) => clip.id === clipId);
  if (audioIndex < 0) return project;
  const previous = project.audioClips[audioIndex];
  const trimmed = trim(previous) as TimelineAudioClip;
  if (edge === "start") {
    trimmed.timelineStartUs +=
      (trimmed.sourceInUs - previous.sourceInUs) / previous.speed;
  }
  const next = [...project.audioClips];
  next[audioIndex] = trimmed;
  return { ...project, audioClips: next };
}

export function patchClip(
  project: EditorProject,
  clipId: string,
  patch: Partial<Pick<TimelineClip, "speed" | "volume" | "muted">>,
): EditorProject {
  const speed = patch.speed === undefined
    ? undefined
    : Math.min(8, Math.max(0.1, patch.speed));
  const volume = patch.volume === undefined
    ? undefined
    : Math.min(1, Math.max(0, patch.volume));
  const normalized = {
    ...patch,
    ...(speed === undefined ? {} : { speed }),
    ...(volume === undefined ? {} : { volume }),
  };
  return {
    videoClips: project.videoClips.map((clip) =>
      clip.id === clipId ? { ...clip, ...normalized } : clip,
    ),
    audioClips: project.audioClips.map((clip) =>
      clip.id === clipId ? { ...clip, ...normalized } : clip,
    ),
  };
}

export function deleteClip(project: EditorProject, clipId: string): EditorProject {
  return {
    videoClips: project.videoClips.filter((clip) => clip.id !== clipId),
    audioClips: project.audioClips.filter((clip) => clip.id !== clipId),
  };
}

export function reorderVideoClips(
  project: EditorProject,
  clipId: string,
  targetIndex: number,
): EditorProject {
  const currentIndex = project.videoClips.findIndex((clip) => clip.id === clipId);
  if (currentIndex < 0) return project;
  const next = [...project.videoClips];
  const [moved] = next.splice(currentIndex, 1);
  const adjustedIndex = currentIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(Math.max(0, Math.min(next.length, adjustedIndex)), 0, moved);
  return { ...project, videoClips: next };
}

export function moveAudioClip(
  project: EditorProject,
  clipId: string,
  timelineStartUs: number,
): EditorProject {
  return {
    ...project,
    audioClips: project.audioClips.map((clip) =>
      clip.id === clipId
        ? { ...clip, timelineStartUs: Math.max(0, timelineStartUs) }
        : clip,
    ),
  };
}

export function detachAudio(
  project: EditorProject,
  clipId: string,
  createId: () => string = () => crypto.randomUUID(),
): { project: EditorProject; audioClipId: string } | null {
  const index = project.videoClips.findIndex((clip) => clip.id === clipId);
  if (index < 0 || project.videoClips[index].audioDetached) return null;
  const positioned = positionVideoClips(project.videoClips)[index];
  const video = project.videoClips[index];
  const audioClipId = createId();
  const nextVideos = [...project.videoClips];
  nextVideos[index] = { ...video, audioDetached: true };
  const audio: TimelineAudioClip = {
    id: audioClipId,
    kind: "audio",
    mediaId: video.mediaId,
    sourceInUs: video.sourceInUs,
    sourceOutUs: video.sourceOutUs,
    timelineStartUs: positioned.projectStartUs,
    speed: video.speed,
    volume: video.volume,
    muted: video.muted,
    linkedVideoClipId: video.id,
  };
  return {
    project: {
      videoClips: nextVideos,
      audioClips: [...project.audioClips, audio],
    },
    audioClipId,
  };
}

export function chooseRulerStep(secondsPerPixel: number): number {
  const minimumStepSeconds = secondsPerPixel * 92;
  const steps = [
    1 / 30,
    1 / 15,
    0.1,
    0.2,
    0.5,
    1,
    2,
    5,
    10,
    15,
    30,
    60,
    120,
    300,
    600,
  ];
  return steps.find((step) => step >= minimumStepSeconds) ?? 600;
}
