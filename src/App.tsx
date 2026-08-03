import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Inspector } from "./components/Inspector";
import { Icon } from "./components/Icon";
import { Preview } from "./components/Preview";
import { Timeline } from "./components/Timeline";
import { useHistory } from "./hooks/useHistory";
import {
  EMPTY_PROJECT,
  clipPlaybackDurationUs,
  deleteClip,
  detachAudio,
  getClip,
  patchClip,
  positionAudioClips,
  projectDurationUs,
  reorderVideoClips,
  splitClipAtProjectTime,
} from "./lib/editor";
import {
  cancelExport,
  chooseExportPath,
  importBrowserFile,
  importMediaFromPath,
  isMediaFile,
  isMediaPath,
  isNativeRuntime,
  openMediaPaths,
  startExport,
  subscribeToNativeFileDrop,
} from "./lib/platform";
import { frameDurationUs } from "./lib/time";
import type {
  EditorProject,
  ExportEvent,
  ExportSettings,
  ExportStatus,
  MediaSource,
  TimelineAudioClip,
  TimelineClip,
  TimelineVideoClip,
} from "./types/editor";

const initialExportSettings: ExportSettings = {
  preset: "balanced",
  mode: "precise",
  resolution: "source",
};

const idleExportStatus: ExportStatus = {
  phase: "idle",
  jobId: null,
  progress: 0,
  speed: null,
  outputPath: null,
  message: null,
};

function cleanError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Ismeretlen hiba történt.";
}

function suggestedExportName(sources: MediaSource[]): string {
  const base = sources[0]?.name.replace(/\.[^.]+$/, "") || "video";
  return `${base}-cutcat.mp4`;
}

function createVideoClip(media: MediaSource): TimelineVideoClip {
  return {
    id: crypto.randomUUID(),
    kind: "video",
    mediaId: media.id,
    sourceInUs: 0,
    sourceOutUs: media.durationUs,
    speed: 1,
    volume: 1,
    muted: false,
    audioDetached: false,
  };
}

function createAudioClip(
  media: MediaSource,
  timelineStartUs: number,
): TimelineAudioClip {
  return {
    id: crypto.randomUUID(),
    kind: "audio",
    mediaId: media.id,
    sourceInUs: 0,
    sourceOutUs: media.durationUs,
    timelineStartUs,
    speed: 1,
    volume: 1,
    muted: false,
    linkedVideoClipId: null,
  };
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelRequestedRef = useRef(false);
  const sourcesRef = useRef<MediaSource[]>([]);
  const [sources, setSources] = useState<MediaSource[]>([]);
  sourcesRef.current = sources;
  const {
    value: project,
    commit: commitProject,
    reset: resetProject,
    undo: undoProject,
    redo: redoProject,
    canUndo,
    canRedo,
    getValue: getProject,
  } = useHistory<EditorProject>(EMPTY_PROJECT);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [projectTimeUs, setProjectTimeUs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [exportSettings, setExportSettings] = useState(initialExportSettings);
  const [exportStatus, setExportStatus] =
    useState<ExportStatus>(idleExportStatus);

  const mediaById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const durationUs = projectDurationUs(project);
  const selectedClip = getClip(project, selectedClipId);
  const exporting = exportStatus.phase === "running";
  const hasClips =
    project.videoClips.length > 0 || project.audioClips.length > 0;

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => {
      setToast((current) => (current === message ? null : current));
    }, 4000);
  }, []);

  useEffect(() => {
    const preventNativeMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventNativeMenu);
    return () => document.removeEventListener("contextmenu", preventNativeMenu);
  }, []);

  useEffect(
    () => () => {
      for (const source of sourcesRef.current) {
        if (source.path === null && source.url.startsWith("blob:")) {
          URL.revokeObjectURL(source.url);
        }
      }
    },
    [],
  );

  const installSources = useCallback(
    (nextSources: MediaSource[]) => {
      if (nextSources.length === 0) return;
      const current = getProject();
      const wasEmpty =
        current.videoClips.length === 0 && current.audioClips.length === 0;
      const nextVideoClips = [...current.videoClips];
      const nextAudioClips = [...current.audioClips];
      let audioCursor =
        positionAudioClips(current.audioClips).reduce(
          (end, clip) => Math.max(end, clip.projectEndUs),
          0,
        ) || 0;
      const createdIds: string[] = [];

      for (const source of nextSources) {
        if (source.hasVideo) {
          const clip = createVideoClip(source);
          nextVideoClips.push(clip);
          createdIds.push(clip.id);
        } else if (source.hasAudio) {
          const clip = createAudioClip(source, audioCursor);
          nextAudioClips.push(clip);
          audioCursor += clipPlaybackDurationUs(clip);
          createdIds.push(clip.id);
        }
      }

      const nextProject = {
        videoClips: nextVideoClips,
        audioClips: nextAudioClips,
      };
      setSources((currentSources) => [...currentSources, ...nextSources]);
      if (wasEmpty) resetProject(nextProject);
      else commitProject(nextProject);
      setSelectedClipId(createdIds[0] ?? null);
      setProjectTimeUs(
        createdIds[0]
          ? nextAudioClips.find((clip) => clip.id === createdIds[0])
              ?.timelineStartUs ?? projectDurationUs(current)
          : 0,
      );
      setPlaying(false);
      setExportStatus(idleExportStatus);
    },
    [commitProject, getProject, resetProject],
  );

  const importPaths = useCallback(
    async (paths: string[]) => {
      const accepted = paths.filter(isMediaPath);
      if (accepted.length === 0) {
        notify("Nem támogatott fájl. Videót vagy hangfájlt válassz.");
        return;
      }
      setImporting(true);
      try {
        const results = await Promise.allSettled(
          accepted.map(importMediaFromPath),
        );
        const imported = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        installSources(imported);
        const failed = results.length - imported.length;
        notify(
          failed > 0
            ? `${imported.length} média betöltve, ${failed} sikertelen.`
            : `${imported.length} média betöltve.`,
        );
      } catch (error) {
        notify(cleanError(error));
      } finally {
        setImporting(false);
      }
    },
    [installSources, notify],
  );

  const importFiles = useCallback(
    async (files: File[]) => {
      const accepted = files.filter(isMediaFile);
      if (accepted.length === 0) {
        notify("Nem támogatott fájl. Videót vagy hangfájlt válassz.");
        return;
      }
      setImporting(true);
      try {
        const results = await Promise.allSettled(
          accepted.map(importBrowserFile),
        );
        const imported = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        installSources(imported);
        const failed = results.length - imported.length;
        notify(
          failed > 0
            ? `${imported.length} média betöltve, ${failed} sikertelen.`
            : `${imported.length} média betöltve. Natív exporthoz indítsd Tauri alatt.`,
        );
      } catch (error) {
        notify(cleanError(error));
      } finally {
        setImporting(false);
      }
    },
    [installSources, notify],
  );

  const openFile = useCallback(async () => {
    if (!isNativeRuntime()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const paths = await openMediaPaths();
      if (paths.length > 0) await importPaths(paths);
    } catch (error) {
      notify(cleanError(error));
    }
  }, [importPaths, notify]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void subscribeToNativeFileDrop((state) => {
      setDropActive(state.active);
      if (state.paths) void importPaths(state.paths);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importPaths]);

  useEffect(() => {
    setProjectTimeUs((timeUs) => Math.min(timeUs, durationUs));
    if (selectedClipId && !getClip(project, selectedClipId)) {
      setSelectedClipId(
        project.videoClips[0]?.id ?? project.audioClips[0]?.id ?? null,
      );
    }
    const video = project.videoClips[0];
    const canFastCopy =
      project.videoClips.length === 1 &&
      project.audioClips.length === 0 &&
      video?.speed === 1 &&
      video.volume === 1 &&
      !video.muted &&
      !video.audioDetached &&
      exportSettings.resolution === "source";
    if (exportSettings.mode === "fastCopy" && !canFastCopy) {
      setExportSettings((settings) => ({ ...settings, mode: "precise" }));
    }
  }, [
    durationUs,
    exportSettings.mode,
    exportSettings.resolution,
    project,
    selectedClipId,
  ]);

  const splitAt = useCallback(
    (clipId: string, timeUs: number) => {
      const next = splitClipAtProjectTime(
        getProject(),
        clipId,
        timeUs,
        new Map(sourcesRef.current.map((source) => [source.id, source])),
      );
      if (!next) {
        notify("A vágási pont legyen a klip belsejében, legalább egy frame-re a széltől.");
        return;
      }
      setPlaying(false);
      commitProject(next);
      notify("Klip elvágva.");
    },
    [commitProject, getProject, notify],
  );

  const removeClip = useCallback(
    (clipId: string) => {
      const next = deleteClip(getProject(), clipId);
      setPlaying(false);
      commitProject(next);
      setSelectedClipId(
        next.videoClips[0]?.id ?? next.audioClips[0]?.id ?? null,
      );
      notify("Klip törölve. Ctrl+Z-vel visszavonható.");
    },
    [commitProject, getProject, notify],
  );

  const detachClipAudio = useCallback(
    (clipId: string) => {
      const source = sourcesRef.current.find(
        (item) => item.id === getClip(getProject(), clipId)?.mediaId,
      );
      if (!source?.hasAudio) {
        notify("Ez a klip nem tartalmaz leválasztható hangot.");
        return;
      }
      const result = detachAudio(getProject(), clipId);
      if (!result) {
        notify("A hang már le van választva.");
        return;
      }
      setPlaying(false);
      commitProject(result.project);
      setSelectedClipId(result.audioClipId);
      notify("Hang leválasztva az A1 sávra.");
    },
    [commitProject, getProject, notify],
  );

  const updateClip = useCallback(
    (
      clipId: string,
      patch: Partial<Pick<TimelineClip, "speed" | "volume" | "muted">>,
    ) => {
      setPlaying(false);
      commitProject(patchClip(getProject(), clipId, patch));
    },
    [commitProject, getProject],
  );

  const toggleClipMute = useCallback(
    (clipId: string) => {
      const clip = getClip(getProject(), clipId);
      if (clip) updateClip(clipId, { muted: !clip.muted });
    },
    [getProject, updateClip],
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
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setPlaying(false);
        if (event.shiftKey) redoProject();
        else undoProject();
        return;
      }
      if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        setPlaying(false);
        redoProject();
        return;
      }
      if (!hasClips) return;

      if (event.code === "Space") {
        event.preventDefault();
        setPlaying((value) => !value);
      } else if (event.key.toLowerCase() === "s" && selectedClipId) {
        event.preventDefault();
        splitAt(selectedClipId, projectTimeUs);
      } else if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedClipId
      ) {
        event.preventDefault();
        removeClip(selectedClipId);
      } else if (event.key.toLowerCase() === "m" && selectedClipId) {
        event.preventDefault();
        toggleClipMute(selectedClipId);
      } else if (
        event.altKey &&
        selectedClip?.kind === "video" &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        const index = project.videoClips.findIndex(
          (clip) => clip.id === selectedClip.id,
        );
        const target =
          event.key === "ArrowLeft" ? index - 1 : index + 2;
        commitProject(reorderVideoClips(project, selectedClip.id, target));
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        const activeMedia = selectedClip
          ? mediaById.get(selectedClip.mediaId)
          : null;
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const frames = event.shiftKey ? 5 : 1;
        setProjectTimeUs((timeUs) =>
          Math.min(
            durationUs,
            Math.max(
              0,
              timeUs +
                direction *
                  frames *
                  frameDurationUs(activeMedia?.fps || 30),
            ),
          ),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    commitProject,
    durationUs,
    hasClips,
    mediaById,
    project,
    projectTimeUs,
    redoProject,
    removeClip,
    selectedClip,
    selectedClipId,
    splitAt,
    toggleClipMute,
    undoProject,
  ]);

  const beginExport = useCallback(async () => {
    if (project.videoClips.length === 0) return;
    const referencedIds = new Set([
      ...project.videoClips.map((clip) => clip.mediaId),
      ...project.audioClips.map((clip) => clip.mediaId),
    ]);
    const referencedSources = sources.filter((source) =>
      referencedIds.has(source.id),
    );
    if (
      !isNativeRuntime() ||
      referencedSources.some((source) => !source.canExport || !source.path)
    ) {
      notify("Export csak a natív CutCat alkalmazásban érhető el.");
      return;
    }

    const outputPath = await chooseExportPath(
      suggestedExportName(referencedSources),
    );
    if (!outputPath) return;
    cancelRequestedRef.current = false;
    setPlaying(false);
    setExportStatus({
      phase: "running",
      jobId: null,
      progress: 0,
      speed: null,
      outputPath: null,
      message: null,
    });

    const onEvent = (event: ExportEvent) => {
      if (event.event === "started") {
        setExportStatus((status) => ({ ...status, jobId: event.jobId }));
      } else if (event.event === "progress") {
        setExportStatus((status) => ({
          ...status,
          progress: event.progress,
          speed: event.speed,
        }));
      } else if (event.event === "completed") {
        setExportStatus((status) => ({
          ...status,
          phase: "completed",
          progress: 1,
          outputPath: event.outputPath,
        }));
      } else if (event.event === "cancelled") {
        setExportStatus((status) => ({ ...status, phase: "cancelled" }));
      } else if (event.event === "failed") {
        setExportStatus((status) => ({
          ...status,
          phase: "failed",
          message: event.message,
        }));
      }
    };

    try {
      const finalPath = await startExport(
        {
          sources: referencedSources.map((source) => ({
            id: source.id,
            path: source.path!,
            hasVideo: source.hasVideo,
            hasAudio: source.hasAudio,
          })),
          videoClips: project.videoClips.map((clip) => ({
            mediaId: clip.mediaId,
            sourceInUs: clip.sourceInUs,
            sourceOutUs: clip.sourceOutUs,
            speed: clip.speed,
            volume: clip.volume,
            muted: clip.muted,
            includeAudio:
              !clip.audioDetached &&
              Boolean(mediaById.get(clip.mediaId)?.hasAudio),
          })),
          audioClips: project.audioClips.map((clip) => ({
            mediaId: clip.mediaId,
            sourceInUs: clip.sourceInUs,
            sourceOutUs: clip.sourceOutUs,
            timelineStartUs: clip.timelineStartUs,
            speed: clip.speed,
            volume: clip.volume,
            muted: clip.muted,
          })),
          outputPath,
          ...exportSettings,
        },
        onEvent,
      );
      setExportStatus((status) => ({
        ...status,
        phase: "completed",
        progress: 1,
        outputPath: finalPath,
      }));
    } catch (error) {
      setExportStatus((status) => ({
        ...status,
        phase: cancelRequestedRef.current ? "cancelled" : "failed",
        message: cancelRequestedRef.current ? null : cleanError(error),
      }));
    }
  }, [exportSettings, mediaById, notify, project, sources]);

  const requestCancelExport = async () => {
    if (!exportStatus.jobId) return;
    cancelRequestedRef.current = true;
    try {
      await cancelExport(exportStatus.jobId);
    } catch (error) {
      notify(cleanError(error));
    }
  };

  const projectTitle =
    sources.length === 0
      ? "Névtelen projekt"
      : sources.length === 1
        ? sources[0].name
        : `${sources.length} médiaelem`;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-workspace">
        Ugrás az előnézethez
      </a>
      <header className="app-header">
        <h1 className="brand" aria-label="CutCat">
          <span>CUT</span>
          <i aria-hidden="true" />
          <span>CAT</span>
          <small>FRAME EDITOR</small>
        </h1>

        <div className="project-identity">
          <span className={hasClips ? "status-dot is-ready" : "status-dot"} />
          <strong>{projectTitle}</strong>
          <small>{hasClips ? "Helyi projekt" : "Nincs mentve"}</small>
        </div>

        <div className="header-actions">
          <button className="header-button" type="button" onClick={openFile}>
            <Icon name="folder" />
            Média hozzáadása
          </button>
          <span className="header-divider" />
          <button
            className="icon-button"
            type="button"
            aria-label="Visszavonás"
            title="Visszavonás (Ctrl+Z)"
            disabled={!canUndo || exporting}
            onClick={() => {
              setPlaying(false);
              undoProject();
            }}
          >
            <Icon name="undo" />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Újra"
            title="Újra (Ctrl+Shift+Z)"
            disabled={!canRedo || exporting}
            onClick={() => {
              setPlaying(false);
              redoProject();
            }}
          >
            <Icon name="redo" />
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={project.videoClips.length === 0 || exporting}
            onClick={beginExport}
          >
            <Icon name="export" />
            Export
          </button>
        </div>
      </header>

      <main className="workspace" id="main-workspace" tabIndex={-1}>
        <Preview
          sources={sources}
          project={project}
          selectedClipId={selectedClipId}
          projectTimeUs={projectTimeUs}
          playing={playing}
          onPlayingChange={setPlaying}
          onTimeChange={setProjectTimeUs}
          onPatchClip={updateClip}
        />
        <Inspector
          sources={sources}
          project={project}
          selectedClipId={selectedClipId}
          exportSettings={exportSettings}
          exporting={exporting}
          onPatchClip={updateClip}
          onDetachAudio={detachClipAudio}
          onExportSettingsChange={setExportSettings}
          onExport={beginExport}
        />
      </main>

      <Timeline
        sources={sources}
        project={project}
        projectTimeUs={projectTimeUs}
        selectedClipId={selectedClipId}
        dropActive={dropActive}
        onDropActiveChange={setDropActive}
        onOpenFile={openFile}
        onBrowserFiles={importFiles}
        onSeek={(timeUs) => {
          setPlaying(false);
          setProjectTimeUs(timeUs);
        }}
        onSelectClip={setSelectedClipId}
        onCommitProject={(nextProject) => {
          setPlaying(false);
          commitProject(nextProject);
        }}
        onSplit={splitAt}
        onDelete={removeClip}
        onDetachAudio={detachClipAudio}
        onToggleMute={toggleClipMute}
        onAnnounce={notify}
      />

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        aria-label="Videó- és hangfájlok kiválasztása"
        accept="video/*,audio/*,.mkv,.mts,.m2ts,.flac,.opus"
        multiple
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) void importFiles(files);
          event.currentTarget.value = "";
        }}
      />

      {importing ? (
        <div className="busy-indicator" role="status">
          <span />
          Média elemzése…
        </div>
      ) : null}

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}

      {exportStatus.phase !== "idle" ? (
        <div className="modal-backdrop">
          <section
            className="export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-title"
          >
            <header>
              <div
                className={`export-state-icon is-${exportStatus.phase}`}
                aria-hidden="true"
              >
                {exportStatus.phase === "completed" ? (
                  <Icon name="check" size={25} />
                ) : exportStatus.phase === "failed" ? (
                  <Icon name="close" size={25} />
                ) : (
                  <Icon name="export" size={25} />
                )}
              </div>
              <div>
                <h2 id="export-title">
                  {exportStatus.phase === "running"
                    ? "Videó exportálása"
                    : exportStatus.phase === "completed"
                      ? "Export kész"
                      : exportStatus.phase === "cancelled"
                        ? "Export megszakítva"
                        : "Export sikertelen"}
                </h2>
                <p>
                  {exportStatus.phase === "running"
                    ? "FFmpeg összerakja a videó- és hangsávokat."
                    : exportStatus.outputPath ??
                      exportStatus.message ??
                      "Nem készült kimeneti fájl."}
                </p>
              </div>
            </header>

            {exportStatus.phase === "running" ? (
              <>
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label="Export előrehaladása"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(exportStatus.progress * 100)}
                >
                  <span
                    style={{
                      transform: `scaleX(${Math.max(
                        0,
                        Math.min(1, exportStatus.progress),
                      )})`,
                    }}
                  />
                </div>
                <div className="progress-meta">
                  <strong>{Math.round(exportStatus.progress * 100)}%</strong>
                  <span>{exportStatus.speed ?? "előkészítés"}</span>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!exportStatus.jobId}
                  onClick={requestCancelExport}
                >
                  Megszakítás
                </button>
              </>
            ) : (
              <button
                className="primary-button modal-close-button"
                type="button"
                onClick={() => setExportStatus(idleExportStatus)}
              >
                Bezárás
              </button>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
