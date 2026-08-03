import { describe, expect, it } from "vitest";
import type {
  EditorProject,
  MediaSource,
  TimelineAudioClip,
  TimelineVideoClip,
} from "../types/editor";
import {
  clipPlaybackDurationUs,
  deleteClip,
  detachAudio,
  moveAudioClip,
  patchClip,
  positionVideoClips,
  projectDurationUs,
  projectToSourceTime,
  reorderVideoClips,
  splitClipAtProjectTime,
  trimProjectClip,
} from "./editor";
import { formatTimecode } from "./time";

const media: MediaSource = {
  id: "media-a",
  path: "C:/video.mp4",
  url: "asset://video.mp4",
  name: "video.mp4",
  kind: "video",
  durationUs: 10_000_000,
  width: 1920,
  height: 1080,
  fps: 25,
  videoCodec: "h264",
  audioCodec: "aac",
  hasVideo: true,
  hasAudio: true,
  sizeBytes: 100,
  canExport: true,
};

const video = (id: string, sourceInUs = 0, sourceOutUs = 10_000_000): TimelineVideoClip => ({
  id,
  kind: "video",
  mediaId: media.id,
  sourceInUs,
  sourceOutUs,
  speed: 1,
  volume: 1,
  muted: false,
  audioDetached: false,
});

const audio = (id: string): TimelineAudioClip => ({
  id,
  kind: "audio",
  mediaId: media.id,
  sourceInUs: 0,
  sourceOutUs: 4_000_000,
  timelineStartUs: 2_000_000,
  speed: 1,
  volume: 1,
  muted: false,
  linkedVideoClipId: null,
});

const mediaById = new Map([[media.id, media]]);

describe("timeline model", () => {
  it("positions video clips magnetically and accounts for speed", () => {
    const clips = [video("a", 0, 4_000_000), { ...video("b", 0, 4_000_000), speed: 2 }];
    const positioned = positionVideoClips(clips);
    expect(positioned[0].projectEndUs).toBe(4_000_000);
    expect(positioned[1].projectStartUs).toBe(4_000_000);
    expect(positioned[1].projectEndUs).toBe(6_000_000);
  });

  it("maps project time through playback speed", () => {
    const located = projectToSourceTime([{ ...video("a"), speed: 2 }], 2_000_000);
    expect(located?.sourceTimeUs).toBe(4_000_000);
  });

  it("splits a video while preserving per-clip properties", () => {
    const project: EditorProject = {
      videoClips: [{ ...video("a"), volume: 0.5, speed: 2 }],
      audioClips: [],
    };
    const result = splitClipAtProjectTime(
      project,
      "a",
      2_000_000,
      mediaById,
      () => "b",
    );
    expect(result?.videoClips).toEqual([
      expect.objectContaining({ id: "a", sourceOutUs: 4_000_000, volume: 0.5, speed: 2 }),
      expect.objectContaining({ id: "b", sourceInUs: 4_000_000, volume: 0.5, speed: 2 }),
    ]);
  });

  it("trims detached audio start while keeping its right edge fixed", () => {
    const project: EditorProject = { videoClips: [], audioClips: [audio("a")] };
    const next = trimProjectClip(project, "a", "start", 1_000_000, media);
    expect(next.audioClips[0].sourceInUs).toBe(1_000_000);
    expect(next.audioClips[0].timelineStartUs).toBe(3_000_000);
    expect(
      next.audioClips[0].timelineStartUs +
        clipPlaybackDurationUs(next.audioClips[0]),
    ).toBe(6_000_000);
  });

  it("detaches embedded audio at the video timeline position", () => {
    const project: EditorProject = {
      videoClips: [video("first", 0, 2_000_000), video("second", 2_000_000, 6_000_000)],
      audioClips: [],
    };
    const result = detachAudio(project, "second", () => "audio-b");
    expect(result?.project.videoClips[1].audioDetached).toBe(true);
    expect(result?.project.audioClips[0]).toMatchObject({
      id: "audio-b",
      timelineStartUs: 2_000_000,
      sourceInUs: 2_000_000,
      sourceOutUs: 6_000_000,
      linkedVideoClipId: "second",
    });
  });

  it("reorders video clips without changing instances", () => {
    const project: EditorProject = {
      videoClips: [video("a"), video("b"), video("c")],
      audioClips: [],
    };
    expect(reorderVideoClips(project, "c", 0).videoClips.map((clip) => clip.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(reorderVideoClips(project, "a", 3).videoClips.map((clip) => clip.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("moves audio independently and includes it in project duration", () => {
    const project = moveAudioClip(
      { videoClips: [video("v", 0, 2_000_000)], audioClips: [audio("a")] },
      "a",
      8_000_000,
    );
    expect(project.audioClips[0].timelineStartUs).toBe(8_000_000);
    expect(projectDurationUs(project)).toBe(12_000_000);
  });

  it("patches only selected clip volume, mute and speed", () => {
    const project: EditorProject = {
      videoClips: [video("a"), video("b")],
      audioClips: [],
    };
    const next = patchClip(project, "a", { volume: 0.25, muted: true, speed: 1.5 });
    expect(next.videoClips[0]).toMatchObject({ volume: 0.25, muted: true, speed: 1.5 });
    expect(next.videoClips[1]).toMatchObject({ volume: 1, muted: false, speed: 1 });
  });

  it("deletes either track without deleting other clips", () => {
    const project: EditorProject = {
      videoClips: [video("v")],
      audioClips: [audio("a")],
    };
    expect(deleteClip(project, "a").audioClips).toEqual([]);
    expect(deleteClip(project, "a").videoClips).toHaveLength(1);
  });

  it("formats rounded frame boundaries without rollover error", () => {
    expect(formatTimecode(2_999_970, 30)).toBe("00:00:03:00");
    expect(formatTimecode(500_000, 30)).toBe("00:00:00:15");
  });
});
