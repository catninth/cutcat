import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  chooseRulerStep,
  clipPlaybackDurationUs,
  getClip,
  moveAudioClip,
  positionAudioClips,
  positionVideoClips,
  projectDurationUs,
  reorderVideoClips,
  trimProjectClip,
} from "../lib/editor";
import {
  formatDuration,
  formatTimecode,
  frameDurationUs,
  US_PER_SECOND,
} from "../lib/time";
import type {
  EditorProject,
  EditorTool,
  MediaSource,
  TimelineClip,
  TrimEdge,
} from "../types/editor";
import { Icon } from "./Icon";

interface TimelineProps {
  sources: MediaSource[];
  project: EditorProject;
  projectTimeUs: number;
  selectedClipId: string | null;
  dropActive: boolean;
  onDropActiveChange: (active: boolean) => void;
  onOpenFile: () => void;
  onBrowserFiles: (files: File[]) => void;
  onSeek: (timeUs: number) => void;
  onSelectClip: (clipId: string) => void;
  onCommitProject: (project: EditorProject) => void;
  onSplit: (clipId: string, timeUs: number) => void;
  onDelete: (clipId: string) => void;
  onDetachAudio: (clipId: string) => void;
  onToggleMute: (clipId: string) => void;
  onAnnounce: (message: string) => void;
}

interface TrimDrag {
  pointerId: number;
  clipId: string;
  edge: TrimEdge;
  startClientX: number;
  initialSourceUs: number;
  initialProject: EditorProject;
  media: MediaSource;
}

interface ContextMenuState {
  x: number;
  y: number;
  clipId: string;
  projectTimeUs: number;
}

const MIN_PPS = 8;
const MAX_PPS = 480;
const VIDEO_DRAG_TYPE = "application/x-cutcat-video-clip";
const AUDIO_DRAG_TYPE = "application/x-cutcat-audio-clip";

export const Timeline = memo(function Timeline({
  sources,
  project,
  projectTimeUs,
  selectedClipId,
  dropActive,
  onDropActiveChange,
  onOpenFile,
  onBrowserFiles,
  onSeek,
  onSelectClip,
  onCommitProject,
  onSplit,
  onDelete,
  onDetachAudio,
  onToggleMute,
  onAnnounce,
}: TimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trimDragRef = useRef<TrimDrag | null>(null);
  const pendingDraftRef = useRef<EditorProject | null>(null);
  const animationRef = useRef<number | null>(null);
  const fittedOnceRef = useRef(false);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(80);
  const [tool, setTool] = useState<EditorTool>("select");
  const [draftProject, setDraftProject] = useState<EditorProject | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [browserDropActive, setBrowserDropActive] = useState(false);
  const [draggingVideoId, setDraggingVideoId] = useState<string | null>(null);
  const [videoDropIndex, setVideoDropIndex] = useState<number | null>(null);
  const [draggingAudioId, setDraggingAudioId] = useState<string | null>(null);
  const [audioDropTimeUs, setAudioDropTimeUs] = useState<number | null>(null);

  const visibleProject = draftProject ?? project;
  const mediaById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const positionedVideo = useMemo(
    () => positionVideoClips(visibleProject.videoClips),
    [visibleProject.videoClips],
  );
  const positionedAudio = useMemo(
    () => positionAudioClips(visibleProject.audioClips),
    [visibleProject.audioClips],
  );
  const audioLaneById = useMemo(() => {
    const laneEnds: number[] = [];
    const lanes = new Map<string, number>();
    const sorted = [...positionedAudio].sort(
      (a, b) => a.projectStartUs - b.projectStartUs || a.id.localeCompare(b.id),
    );
    for (const clip of sorted) {
      let lane = laneEnds.findIndex((endUs) => endUs <= clip.projectStartUs);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = clip.projectEndUs;
      lanes.set(clip.id, lane);
    }
    return lanes;
  }, [positionedAudio]);
  const durationUs = projectDurationUs(visibleProject);
  const durationSeconds = durationUs / US_PER_SECOND;
  const rulerFps = positionedVideo[0]
    ? mediaById.get(positionedVideo[0].mediaId)?.fps || 30
    : 30;
  const hasClips =
    project.videoClips.length > 0 || project.audioClips.length > 0;

  const fitTimeline = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || durationSeconds <= 0) return;
    setPixelsPerSecond(
      Math.max(
        MIN_PPS,
        Math.min(MAX_PPS, (viewport.clientWidth - 40) / durationSeconds),
      ),
    );
    viewport.scrollLeft = 0;
  }, [durationSeconds]);

  useEffect(() => {
    if (!hasClips) {
      fittedOnceRef.current = false;
      return;
    }
    if (fittedOnceRef.current) return;
    fittedOnceRef.current = true;
    const frame = requestAnimationFrame(fitTimeline);
    return () => cancelAnimationFrame(frame);
  }, [fitTimeline, hasClips]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  const timeFromClientX = useCallback(
    (clientX: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return 0;
      const rect = viewport.getBoundingClientRect();
      const contentX = clientX - rect.left + viewport.scrollLeft - 16;
      return Math.min(
        Math.max(durationUs, US_PER_SECOND),
        Math.max(0, (contentX / pixelsPerSecond) * US_PER_SECOND),
      );
    },
    [durationUs, pixelsPerSecond],
  );

  const zoom = useCallback(
    (factor: number, anchorClientX?: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const anchorX =
        anchorClientX === undefined
          ? viewport.clientWidth / 2
          : anchorClientX - rect.left;
      const contentSecond =
        (viewport.scrollLeft + anchorX - 16) / pixelsPerSecond;
      const nextPps = Math.max(
        MIN_PPS,
        Math.min(MAX_PPS, pixelsPerSecond * factor),
      );
      setPixelsPerSecond(nextPps);
      requestAnimationFrame(() => {
        viewport.scrollLeft = Math.max(
          0,
          contentSecond * nextPps - anchorX + 16,
        );
      });
    },
    [pixelsPerSecond],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.matches("input, select, textarea, button:not(.clip-body)") ||
        target.isContentEditable
      ) {
        return;
      }
      if (event.key.toLowerCase() === "v" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        setTool("select");
        onAnnounce("Select tool active.");
      } else if (
        event.key.toLowerCase() === "c" &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        setTool("razor");
        onAnnounce("Cut tool active.");
      } else if (event.key === "Escape") {
        setTool("select");
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoom(1.25);
      } else if (event.key === "-") {
        event.preventDefault();
        zoom(0.8);
      } else if (event.key === "0") {
        event.preventDefault();
        fitTimeline();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fitTimeline, onAnnounce, zoom]);

  const scheduleDraft = (next: EditorProject) => {
    pendingDraftRef.current = next;
    if (animationRef.current !== null) return;
    animationRef.current = requestAnimationFrame(() => {
      setDraftProject(pendingDraftRef.current);
      animationRef.current = null;
    });
  };

  const startTrim = (
    event: React.PointerEvent<HTMLButtonElement>,
    clip: TimelineClip,
    edge: TrimEdge,
  ) => {
    const media = mediaById.get(clip.mediaId);
    if (!media) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectClip(clip.id);
    trimDragRef.current = {
      pointerId: event.pointerId,
      clipId: clip.id,
      edge,
      startClientX: event.clientX,
      initialSourceUs: edge === "start" ? clip.sourceInUs : clip.sourceOutUs,
      initialProject: project,
      media,
    };
    pendingDraftRef.current = project;
    setDraftProject(project);
  };

  const moveTrim = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = trimDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const clip = getClip(drag.initialProject, drag.clipId);
    if (!clip) return;
    const timelineDeltaUs =
      ((event.clientX - drag.startClientX) / pixelsPerSecond) * US_PER_SECOND;
    scheduleDraft(
      trimProjectClip(
        drag.initialProject,
        drag.clipId,
        drag.edge,
        drag.initialSourceUs + timelineDeltaUs * clip.speed,
        drag.media,
      ),
    );
  };

  const finishTrim = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = trimDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    const finalProject = pendingDraftRef.current ?? drag.initialProject;
    const finalClip = getClip(finalProject, drag.clipId);
    trimDragRef.current = null;
    pendingDraftRef.current = null;
    setDraftProject(null);
    onCommitProject(finalProject);
    if (finalClip) {
      onAnnounce(
        `${drag.edge === "start" ? "Clip start" : "Clip end"}: ${formatTimecode(
          drag.edge === "start" ? finalClip.sourceInUs : finalClip.sourceOutUs,
          drag.media.fps,
        )}`,
      );
    }
  };

  const keyboardTrim = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    clip: TimelineClip,
    edge: TrimEdge,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const media = mediaById.get(clip.mediaId);
    if (!media) return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const frames = event.shiftKey ? 5 : 1;
    const current =
      edge === "start" ? clip.sourceInUs : clip.sourceOutUs;
    onCommitProject(
      trimProjectClip(
        project,
        clip.id,
        edge,
        current + direction * frames * frameDurationUs(media.fps || 30),
        media,
      ),
    );
  };

  const openContextMenu = (
    clipId: string,
    timeUs: number,
    x: number,
    y: number,
  ) => {
    onSelectClip(clipId);
    onSeek(timeUs);
    setContextMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - 248)),
      y: Math.max(8, Math.min(y, window.innerHeight - 250)),
      clipId,
      projectTimeUs: timeUs,
    });
  };

  const rulerStep = chooseRulerStep(1 / pixelsPerSecond);
  const ticks = useMemo(() => {
    if (durationSeconds <= 0) return [];
    const count = Math.min(600, Math.ceil(durationSeconds / rulerStep) + 1);
    return Array.from({ length: count }, (_, index) => index * rulerStep);
  }, [durationSeconds, rulerStep]);

  const contentWidth = durationSeconds * pixelsPerSecond + 48;
  const playheadX =
    16 + (Math.min(projectTimeUs, durationUs) / US_PER_SECOND) * pixelsPerSecond;
  const mergedDropActive = dropActive || browserDropActive;
  const trimDrag = trimDragRef.current;
  const menuClip = getClip(project, contextMenu?.clipId ?? null);

  const commitVideoReorder = (clipId: string, targetIndex: number) => {
    const next = reorderVideoClips(project, clipId, targetIndex);
    onCommitProject(next);
    onSelectClip(clipId);
    onAnnounce("Clip order changed.");
  };

  return (
    <section
      className={`timeline-panel ${mergedDropActive ? "is-drop-active" : ""} tool-${tool}`}
      aria-label="Timeline"
      onDragEnter={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        setBrowserDropActive(true);
        onDropActiveChange(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setBrowserDropActive(false);
        onDropActiveChange(false);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.files.length > 0) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        setBrowserDropActive(false);
        onDropActiveChange(false);
        onBrowserFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <header className="timeline-toolbar">
        <div className="timeline-title">
          <span>TIMELINE</span>
          <small>
            {hasClips
              ? `${project.videoClips.length} video · ${project.audioClips.length} audio · ${formatDuration(durationUs)}`
              : "No media"}
          </small>
        </div>
        <div className="timeline-tools">
          <button
            className={`tool-button ${tool === "select" ? "is-active" : ""}`}
            type="button"
            aria-pressed={tool === "select"}
            title="Select and move (V)"
            onClick={() => {
              setTool("select");
              onAnnounce("Select tool active.");
            }}
          >
            <span className="cursor-glyph" aria-hidden="true" />
            Select
          </button>
          <button
            className={`tool-button ${tool === "razor" ? "is-active" : ""}`}
            type="button"
            aria-pressed={tool === "razor"}
            disabled={!hasClips}
            title="Cut at click position (C)"
            onClick={() => {
              setTool("razor");
              onAnnounce("Cut tool active.");
            }}
          >
            <Icon name="scissors" size={16} />
            Cut
          </button>
          <span className="toolbar-divider" />
          <button
            className="icon-button"
            type="button"
            aria-label="Zoom out timeline"
            disabled={!hasClips}
            onClick={() => zoom(0.8)}
          >
            <Icon name="minus" />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Fit timeline"
            disabled={!hasClips}
            onClick={fitTimeline}
          >
            <Icon name="fit" />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Zoom in timeline"
            disabled={!hasClips}
            onClick={() => zoom(1.25)}
          >
            <Icon name="plus" />
          </button>
        </div>
      </header>

      <div className="timeline-body">
        <div className="track-headers" aria-hidden="true">
          <div className="ruler-header" />
          <div className="track-header">
            <strong>V1</strong>
            <span>VIDEO</span>
          </div>
          <div className="track-header audio-track-header">
            <strong>A1</strong>
            <span>AUDIO</span>
          </div>
        </div>

        <div
          ref={viewportRef}
          className="timeline-scroll"
          aria-label="Timeline editor"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Home") {
              event.preventDefault();
              onSeek(0);
            } else if (event.key === "End") {
              event.preventDefault();
              onSeek(durationUs);
            }
          }}
          onClick={(event) => {
            if ((event.target as Element).closest("[data-no-seek]")) return;
            onSeek(timeFromClientX(event.clientX));
          }}
          onWheel={(event) => {
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault();
              zoom(event.deltaY > 0 ? 0.9 : 1.1, event.clientX);
            }
          }}
        >
          <div className="timeline-content" style={{ width: contentWidth }}>
            <div className="time-ruler" aria-hidden="true">
              {ticks.map((time) => (
                <div
                  className="ruler-tick"
                  key={time}
                  style={{ left: 16 + time * pixelsPerSecond }}
                >
                  <span>
                    {rulerStep < 1
                      ? formatTimecode(time * US_PER_SECOND, rulerFps)
                      : formatTimecode(time * US_PER_SECOND, rulerFps).slice(0, 8)}
                  </span>
                </div>
              ))}
            </div>

            <div
              className="video-track"
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(VIDEO_DRAG_TYPE)) return;
                event.preventDefault();
                const timeUs = timeFromClientX(event.clientX);
                const index = positionedVideo.findIndex(
                  (clip) =>
                    timeUs < (clip.projectStartUs + clip.projectEndUs) / 2,
                );
                setVideoDropIndex(index < 0 ? positionedVideo.length : index);
              }}
              onDrop={(event) => {
                const clipId = event.dataTransfer.getData(VIDEO_DRAG_TYPE);
                if (!clipId || videoDropIndex === null) return;
                event.preventDefault();
                event.stopPropagation();
                commitVideoReorder(clipId, videoDropIndex);
                setDraggingVideoId(null);
                setVideoDropIndex(null);
              }}
            >
              {positionedVideo.map((clip, index) => {
                const source = mediaById.get(clip.mediaId);
                const sourceClip =
                  visibleProject.videoClips.find((item) => item.id === clip.id) ??
                  clip;
                const visualTrimOffsetUs =
                  trimDrag?.clipId === clip.id &&
                  trimDrag.edge === "start" &&
                  sourceClip.kind === "video"
                    ? Math.max(
                        0,
                        (sourceClip.sourceInUs -
                          getClip(trimDrag.initialProject, clip.id)!.sourceInUs) /
                          sourceClip.speed,
                      )
                    : 0;
                const left =
                  16 +
                  ((clip.projectStartUs + visualTrimOffsetUs) / US_PER_SECOND) *
                    pixelsPerSecond;
                const width =
                  (clipPlaybackDurationUs(sourceClip) / US_PER_SECOND) *
                  pixelsPerSecond;
                const selected = selectedClipId === clip.id;

                return (
                  <div
                    className={`timeline-clip video-clip ${
                      selected ? "is-selected" : ""
                    } ${draggingVideoId === clip.id ? "is-dragging" : ""}`}
                    data-no-seek
                    key={clip.id}
                    style={{ left, width: Math.max(width, 4) }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openContextMenu(
                        clip.id,
                        timeFromClientX(event.clientX),
                        event.clientX,
                        event.clientY,
                      );
                    }}
                  >
                    <button
                      className="clip-body"
                      type="button"
                      draggable={tool === "select"}
                      aria-label={`Video clip ${index + 1}, ${source?.name ?? "unknown"}, ${formatDuration(
                        clipPlaybackDurationUs(clip),
                      )}, ${clip.speed}×${clip.muted ? ", muted" : ""}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        const timeUs = timeFromClientX(event.clientX);
                        if (tool === "razor") {
                          onSplit(clip.id, timeUs);
                        } else {
                          onSelectClip(clip.id);
                          onSeek(timeUs);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.shiftKey && event.key === "F10") {
                          event.preventDefault();
                          const rect = event.currentTarget.getBoundingClientRect();
                          openContextMenu(
                            clip.id,
                            clip.projectStartUs,
                            rect.left + 24,
                            rect.bottom,
                          );
                        }
                      }}
                      onDragStart={(event) => {
                        if (tool !== "select") {
                          event.preventDefault();
                          return;
                        }
                        event.dataTransfer.setData(VIDEO_DRAG_TYPE, clip.id);
                        event.dataTransfer.effectAllowed = "move";
                        setDraggingVideoId(clip.id);
                        onSelectClip(clip.id);
                      }}
                      onDragEnd={() => {
                        setDraggingVideoId(null);
                        setVideoDropIndex(null);
                      }}
                    >
                      <div className="clip-filmstrip" aria-hidden="true">
                        {Array.from({ length: 14 }, (_, frame) => (
                          <span key={frame} />
                        ))}
                      </div>
                      <div className="clip-copy">
                        <strong>{source?.name ?? "Video"}</strong>
                        <span>
                          {formatTimecode(clip.sourceInUs, source?.fps || 30)} –{" "}
                          {formatTimecode(clip.sourceOutUs, source?.fps || 30)}
                        </span>
                      </div>
                      <div className="clip-badges" aria-hidden="true">
                        {clip.speed !== 1 ? <span>{clip.speed}×</span> : null}
                        {clip.muted || clip.audioDetached ? (
                          <span>
                            <Icon
                              name={clip.audioDetached ? "unlink" : "mute"}
                              size={12}
                            />
                          </span>
                        ) : null}
                      </div>
                    </button>
                    <button
                      className="trim-handle trim-handle-start"
                      type="button"
                      aria-label="Trim video start"
                      data-no-seek
                      disabled={tool === "razor"}
                      onKeyDown={(event) =>
                        keyboardTrim(event, sourceClip, "start")
                      }
                      onPointerDown={(event) =>
                        startTrim(event, sourceClip, "start")
                      }
                      onPointerMove={moveTrim}
                      onPointerUp={finishTrim}
                      onPointerCancel={finishTrim}
                    />
                    <button
                      className="trim-handle trim-handle-end"
                      type="button"
                      aria-label="Trim video end"
                      data-no-seek
                      disabled={tool === "razor"}
                      onKeyDown={(event) =>
                        keyboardTrim(event, sourceClip, "end")
                      }
                      onPointerDown={(event) =>
                        startTrim(event, sourceClip, "end")
                      }
                      onPointerMove={moveTrim}
                      onPointerUp={finishTrim}
                      onPointerCancel={finishTrim}
                    />
                  </div>
                );
              })}
              {videoDropIndex !== null && draggingVideoId ? (
                <div
                  className="insertion-caret"
                  aria-hidden="true"
                  style={{
                    left:
                      16 +
                      ((positionedVideo[videoDropIndex]?.projectStartUs ??
                        positionedVideo.at(-1)?.projectEndUs ??
                        0) /
                        US_PER_SECOND) *
                        pixelsPerSecond,
                  }}
                />
              ) : null}
            </div>

            <div
              className="audio-track"
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(AUDIO_DRAG_TYPE)) return;
                event.preventDefault();
                setAudioDropTimeUs(timeFromClientX(event.clientX));
              }}
              onDrop={(event) => {
                const clipId = event.dataTransfer.getData(AUDIO_DRAG_TYPE);
                if (!clipId || audioDropTimeUs === null) return;
                event.preventDefault();
                event.stopPropagation();
                onCommitProject(moveAudioClip(project, clipId, audioDropTimeUs));
                onSelectClip(clipId);
                setDraggingAudioId(null);
                setAudioDropTimeUs(null);
                onAnnounce("Audio track position changed.");
              }}
            >
              {positionedAudio.length === 0 ? (
                <span className="audio-track-empty">
                  MP3 or detached audio goes here
                </span>
              ) : null}
              {positionedAudio.map((clip, index) => {
                const source = mediaById.get(clip.mediaId);
                const sourceClip =
                  visibleProject.audioClips.find((item) => item.id === clip.id) ??
                  clip;
                const left =
                  16 +
                  (clip.projectStartUs / US_PER_SECOND) * pixelsPerSecond;
                const width =
                  (clipPlaybackDurationUs(sourceClip) / US_PER_SECOND) *
                  pixelsPerSecond;
                return (
                  <div
                    className={`timeline-clip audio-clip ${
                      selectedClipId === clip.id ? "is-selected" : ""
                    } ${draggingAudioId === clip.id ? "is-dragging" : ""}`}
                    data-no-seek
                    key={clip.id}
                    style={{
                      left,
                      top: 7 + (audioLaneById.get(clip.id) ?? 0) * 47,
                      width: Math.max(width, 4),
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openContextMenu(
                        clip.id,
                        timeFromClientX(event.clientX),
                        event.clientX,
                        event.clientY,
                      );
                    }}
                  >
                    <button
                      className="clip-body"
                      type="button"
                      draggable={tool === "select"}
                      aria-label={`Audio clip ${index + 1}, ${source?.name ?? "unknown"}, ${formatDuration(
                        clipPlaybackDurationUs(clip),
                      )}, ${clip.speed}×${clip.muted ? ", muted" : ""}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        const timeUs = timeFromClientX(event.clientX);
                        if (tool === "razor") onSplit(clip.id, timeUs);
                        else {
                          onSelectClip(clip.id);
                          onSeek(timeUs);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.shiftKey && event.key === "F10") {
                          event.preventDefault();
                          const rect = event.currentTarget.getBoundingClientRect();
                          openContextMenu(
                            clip.id,
                            clip.projectStartUs,
                            rect.left + 24,
                            rect.bottom,
                          );
                        }
                      }}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(AUDIO_DRAG_TYPE, clip.id);
                        event.dataTransfer.effectAllowed = "move";
                        setDraggingAudioId(clip.id);
                        onSelectClip(clip.id);
                      }}
                      onDragEnd={() => {
                        setDraggingAudioId(null);
                        setAudioDropTimeUs(null);
                      }}
                    >
                      <div className="audio-waveform" aria-hidden="true">
                        {Array.from({ length: 28 }, (_, bar) => (
                          <i
                            key={bar}
                            style={{
                              height: `${20 + ((bar * 37) % 72)}%`,
                              opacity: clip.muted ? 0.22 : 0.72,
                            }}
                          />
                        ))}
                      </div>
                      <div className="clip-copy">
                        <strong>{source?.name ?? "Audio"}</strong>
                        <span>
                          {Math.round(clip.volume * 100)}% · {clip.speed}×
                        </span>
                      </div>
                      {clip.muted ? (
                        <div className="clip-badges" aria-hidden="true">
                          <span>
                            <Icon name="mute" size={12} />
                          </span>
                        </div>
                      ) : null}
                    </button>
                    <button
                      className="trim-handle trim-handle-start"
                      type="button"
                      aria-label="Trim audio start"
                      data-no-seek
                      disabled={tool === "razor"}
                      onKeyDown={(event) =>
                        keyboardTrim(event, sourceClip, "start")
                      }
                      onPointerDown={(event) =>
                        startTrim(event, sourceClip, "start")
                      }
                      onPointerMove={moveTrim}
                      onPointerUp={finishTrim}
                      onPointerCancel={finishTrim}
                    />
                    <button
                      className="trim-handle trim-handle-end"
                      type="button"
                      aria-label="Trim audio end"
                      data-no-seek
                      disabled={tool === "razor"}
                      onKeyDown={(event) =>
                        keyboardTrim(event, sourceClip, "end")
                      }
                      onPointerDown={(event) =>
                        startTrim(event, sourceClip, "end")
                      }
                      onPointerMove={moveTrim}
                      onPointerUp={finishTrim}
                      onPointerCancel={finishTrim}
                    />
                  </div>
                );
              })}
              {draggingAudioId && audioDropTimeUs !== null ? (
                <div
                  className="audio-drop-ghost"
                  aria-hidden="true"
                  style={{
                    left:
                      16 +
                      (audioDropTimeUs / US_PER_SECOND) * pixelsPerSecond,
                  }}
                />
              ) : null}
            </div>

            {hasClips ? (
              <div
                className="playhead"
                aria-hidden="true"
                style={{ transform: `translateX(${playheadX}px)` }}
              >
                <span />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {!hasClips ? (
        <button className="timeline-empty-drop" type="button" onClick={onOpenFile}>
          <span className="drop-icon">
            <Icon name="film" size={25} />
            <i aria-hidden="true">+</i>
          </span>
          <strong>Drop videos or music here</strong>
          <span>you can add multiple files at once</span>
          <small>MP4, MOV, MKV, WebM, MP3, WAV, M4A</small>
        </button>
      ) : null}

      {mergedDropActive ? (
        <div className="drop-overlay" aria-live="polite">
          <div>
            <Icon name="film" size={30} />
            <strong>Drop onto the timeline</strong>
            <span>Videos go at the end of V1; audio goes on A1.</span>
          </div>
        </div>
      ) : null}

      {contextMenu && menuClip ? (
        <div
          className="context-menu"
          role="menu"
          aria-label="Clip actions"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          data-no-seek
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onSplit(contextMenu.clipId, contextMenu.projectTimeUs);
              setContextMenu(null);
            }}
          >
            <Icon name="scissors" size={16} />
            Cut here
            <kbd>S</kbd>
          </button>
          {menuClip.kind === "video" &&
          !menuClip.audioDetached &&
          mediaById.get(menuClip.mediaId)?.hasAudio ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onDetachAudio(menuClip.id);
                setContextMenu(null);
              }}
            >
              <Icon name="unlink" size={16} />
              Detach audio
              <kbd />
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onToggleMute(menuClip.id);
              setContextMenu(null);
            }}
          >
            <Icon name={menuClip.muted ? "volume" : "mute"} size={16} />
            {menuClip.muted ? "Unmute" : "Mute clip"}
            <kbd>M</kbd>
          </button>
          {menuClip.kind === "video" ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={
                  project.videoClips.findIndex((clip) => clip.id === menuClip.id) ===
                  0
                }
                onClick={() => {
                  const index = project.videoClips.findIndex(
                    (clip) => clip.id === menuClip.id,
                  );
                  commitVideoReorder(menuClip.id, index - 1);
                  setContextMenu(null);
                }}
              >
                <Icon name="back" size={16} />
                Move one position earlier
                <kbd>Alt+←</kbd>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={
                  project.videoClips.findIndex((clip) => clip.id === menuClip.id) ===
                  project.videoClips.length - 1
                }
                onClick={() => {
                  const index = project.videoClips.findIndex(
                    (clip) => clip.id === menuClip.id,
                  );
                  commitVideoReorder(menuClip.id, index + 2);
                  setContextMenu(null);
                }}
              >
                <Icon name="forward" size={16} />
                Move one position later
                <kbd>Alt+→</kbd>
              </button>
            </>
          ) : null}
          <button
            className="is-danger"
            type="button"
            role="menuitem"
            onClick={() => {
              onDelete(menuClip.id);
              setContextMenu(null);
            }}
          >
            <Icon name="trash" size={16} />
            Delete clip
            <kbd>Del</kbd>
          </button>
        </div>
      ) : null}
    </section>
  );
});
