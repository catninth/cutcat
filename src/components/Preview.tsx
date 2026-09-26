import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  clipPlaybackDurationUs,
  getClip,
  positionAudioClips,
  projectDurationUs,
  projectToSourceTime,
} from "../lib/editor";
import {
  formatTimecode,
  frameDurationUs,
  usToSeconds,
} from "../lib/time";
import type {
  EditorProject,
  MediaSource,
  TimelineClip,
} from "../types/editor";
import { Icon } from "./Icon";

interface PreviewProps {
  sources: MediaSource[];
  project: EditorProject;
  selectedClipId: string | null;
  projectTimeUs: number;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  onTimeChange: (timeUs: number) => void;
  onPatchClip: (
    clipId: string,
    patch: Partial<Pick<TimelineClip, "volume" | "muted">>,
  ) => void;
}

export const Preview = memo(function Preview({
  sources,
  project,
  selectedClipId,
  projectTimeUs,
  playing,
  onPlayingChange,
  onTimeChange,
  onPatchClip,
}: PreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const animationRef = useRef<number | null>(null);
  const projectTimeRef = useRef(projectTimeUs);
  const lastTickRef = useRef(0);
  const lastPublishedTickRef = useRef(0);
  projectTimeRef.current = projectTimeUs;

  const mediaById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const durationUs = projectDurationUs(project);
  const active = projectToSourceTime(project.videoClips, projectTimeUs);
  const activeMedia = active ? mediaById.get(active.clip.mediaId) ?? null : null;
  const selectedClip = getClip(project, selectedClipId);
  const selectedMedia = selectedClip
    ? mediaById.get(selectedClip.mediaId) ?? null
    : null;
  const selectedHasAudio =
    selectedClip?.kind === "audio" ||
    (selectedClip?.kind === "video" &&
      Boolean(selectedMedia?.hasAudio) &&
      !selectedClip.audioDetached);
  const fps = activeMedia?.fps || selectedMedia?.fps || 30;
  const hasTimelineContent =
    project.videoClips.length > 0 || project.audioClips.length > 0;

  const syncVideo = useCallback(
    (force = false) => {
      const video = videoRef.current;
      const located = projectToSourceTime(
        project.videoClips,
        projectTimeRef.current,
      );
      if (!video || !located) {
        video?.pause();
        return;
      }
      const clip = located.clip;
      const source = mediaById.get(clip.mediaId);
      if (!source) return;
      const expected = usToSeconds(located.sourceTimeUs);
      video.playbackRate = clip.speed;
      video.volume =
        clip.audioDetached || clip.muted ? 0 : Math.min(1, clip.volume);
      if (force || Math.abs(video.currentTime - expected) > 0.14) {
        video.currentTime = expected;
      }
    },
    [mediaById, project.videoClips],
  );

  const syncAudio = useCallback(
    (timeUs: number, shouldPlay: boolean, force = false) => {
      for (const clip of positionAudioClips(project.audioClips)) {
        const audio = audioRefs.current.get(clip.id);
        if (!audio) continue;
        const activeNow =
          timeUs >= clip.projectStartUs && timeUs < clip.projectEndUs;
        if (!activeNow) {
          audio.pause();
          continue;
        }
        const sourceTimeUs =
          clip.sourceInUs + (timeUs - clip.projectStartUs) * clip.speed;
        const expected = usToSeconds(sourceTimeUs);
        audio.playbackRate = clip.speed;
        audio.volume = clip.muted ? 0 : Math.min(1, clip.volume);
        if (force || Math.abs(audio.currentTime - expected) > 0.14) {
          audio.currentTime = expected;
        }
        if (shouldPlay && audio.paused) {
          void audio.play().catch(() => undefined);
        } else if (!shouldPlay) {
          audio.pause();
        }
      }
    },
    [project.audioClips],
  );

  useEffect(() => {
    syncVideo(!playing);
    syncAudio(projectTimeUs, playing, !playing);
  }, [playing, projectTimeUs, syncAudio, syncVideo]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      syncVideo(true);
      void video.play().catch(() => onPlayingChange(false));
    } else {
      video.pause();
    }
  }, [activeMedia?.id, onPlayingChange, playing, syncVideo]);

  useEffect(() => {
    if (!playing || durationUs <= 0) {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      lastTickRef.current = 0;
      lastPublishedTickRef.current = 0;
      return;
    }

    const tick = (now: number) => {
      if (lastTickRef.current === 0) lastTickRef.current = now;
      const elapsedUs = (now - lastTickRef.current) * 1_000;
      lastTickRef.current = now;
      const next = Math.min(durationUs, projectTimeRef.current + elapsedUs);
      projectTimeRef.current = next;
      if (
        now - lastPublishedTickRef.current >= 33 ||
        next >= durationUs
      ) {
        lastPublishedTickRef.current = now;
        onTimeChange(next);
      }
      if (next >= durationUs) {
        onPlayingChange(false);
        lastTickRef.current = 0;
        lastPublishedTickRef.current = 0;
        return;
      }
      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      lastTickRef.current = 0;
      lastPublishedTickRef.current = 0;
    };
  }, [durationUs, onPlayingChange, onTimeChange, playing]);

  const step = (direction: -1 | 1) => {
    onPlayingChange(false);
    onTimeChange(
      Math.min(
        durationUs,
        Math.max(0, projectTimeUs + frameDurationUs(fps) * direction),
      ),
    );
  };

  const togglePlayback = () => {
    if (projectTimeUs >= durationUs && durationUs > 0) onTimeChange(0);
    onPlayingChange(!playing);
  };

  return (
    <section className="preview-panel" aria-label="Video preview">
      <div className="preview-stage">
        {activeMedia?.hasVideo ? (
          <button
            className="preview-media-button"
            type="button"
            aria-label={
              playing ? "Pause preview" : "Play preview"
            }
            onClick={togglePlayback}
          >
            <video
              ref={videoRef}
              className="preview-video"
              src={activeMedia.url}
              playsInline
              preload="auto"
              onLoadedMetadata={() => {
                syncVideo(true);
                if (playing) {
                  void videoRef.current
                    ?.play()
                    .catch(() => onPlayingChange(false));
                }
              }}
            />
          </button>
        ) : (
          <div className="preview-empty">
            <div className="preview-empty-mark">
              <Icon
                name={project.audioClips.length > 0 ? "music" : "film"}
                size={36}
                strokeWidth={1.4}
              />
            </div>
            <p>
              {project.audioClips.length > 0
                ? "Audio project"
                : "Preview"}
            </p>
            <span>
              {project.audioClips.length > 0
                ? "Add video to the V1 track; audio is ready to play."
                : "Media dropped onto the timeline appears here."}
            </span>
          </div>
        )}
        <div className="preview-safe-frame" aria-hidden="true" />
        <div className="audio-preview-elements" aria-hidden="true">
          {project.audioClips.map((clip) => {
            const source = mediaById.get(clip.mediaId);
            return source ? (
              <audio
                key={clip.id}
                ref={(node) => {
                  if (node) audioRefs.current.set(clip.id, node);
                  else audioRefs.current.delete(clip.id);
                }}
                src={source.url}
                preload="auto"
                onLoadedMetadata={() =>
                  syncAudio(projectTimeRef.current, playing, true)
                }
              />
            ) : null;
          })}
        </div>
      </div>

      <div className="transport">
        <div className="transport-left">
          <button
            className="icon-button"
            type="button"
            aria-label="Jump to start"
            disabled={!hasTimelineContent}
            onClick={() => {
              onPlayingChange(false);
              onTimeChange(0);
            }}
          >
            <Icon name="back" />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Previous frame"
            disabled={!hasTimelineContent}
            onClick={() => step(-1)}
          >
            <Icon name="back" size={16} />
          </button>
          <button
            className="play-button"
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            disabled={!hasTimelineContent}
            onClick={togglePlayback}
          >
            <Icon name={playing ? "pause" : "play"} size={20} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Next frame"
            disabled={!hasTimelineContent}
            onClick={() => step(1)}
          >
            <Icon name="forward" size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Jump to end"
            disabled={!hasTimelineContent}
            onClick={() => {
              onPlayingChange(false);
              onTimeChange(durationUs);
            }}
          >
            <Icon name="forward" />
          </button>
        </div>

        <output className="transport-timecode" aria-live="off">
          <strong>{formatTimecode(projectTimeUs, fps)}</strong>
          <span>/ {formatTimecode(durationUs, fps)}</span>
        </output>

        <div className="transport-volume">
          <button
            className={`icon-button ${selectedClip?.muted ? "is-muted" : ""}`}
            type="button"
            aria-label={
              selectedClip?.muted
                ? "Unmute selected clip"
                : "Mute selected clip"
            }
            aria-pressed={Boolean(selectedClip?.muted)}
            disabled={!selectedClip || !selectedHasAudio}
            onClick={() =>
              selectedClip &&
              onPatchClip(selectedClip.id, { muted: !selectedClip.muted })
            }
          >
            <Icon name={selectedClip?.muted ? "mute" : "volume"} />
          </button>
          <input
            aria-label="Selected clip volume"
            disabled={!selectedClip || !selectedHasAudio}
            max="1"
            min="0"
            name="selected-clip-volume"
            step="0.05"
            type="range"
            value={selectedClip?.volume ?? 1}
            onChange={(event) =>
              selectedClip &&
              onPatchClip(selectedClip.id, {
                volume: Number(event.target.value),
                muted: false,
              })
            }
          />
          <output className="volume-value">
            {Math.round((selectedClip?.volume ?? 1) * 100)}%
          </output>
        </div>
      </div>
    </section>
  );
});
