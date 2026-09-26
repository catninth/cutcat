import { memo, useMemo } from "react";
import {
  clipPlaybackDurationUs,
  getClip,
  getClipProjectStartUs,
} from "../lib/editor";
import {
  formatBytes,
  formatDuration,
  formatTimecode,
} from "../lib/time";
import type {
  EditorProject,
  ExportSettings,
  MediaSource,
  TimelineClip,
} from "../types/editor";
import { Icon } from "./Icon";

interface InspectorProps {
  sources: MediaSource[];
  project: EditorProject;
  selectedClipId: string | null;
  exportSettings: ExportSettings;
  exporting: boolean;
  onPatchClip: (
    clipId: string,
    patch: Partial<Pick<TimelineClip, "speed" | "volume" | "muted">>,
  ) => void;
  onDetachAudio: (clipId: string) => void;
  onExportSettingsChange: (settings: ExportSettings) => void;
  onExport: () => void;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export const Inspector = memo(function Inspector({
  sources,
  project,
  selectedClipId,
  exportSettings,
  exporting,
  onPatchClip,
  onDetachAudio,
  onExportSettingsChange,
  onExport,
}: InspectorProps) {
  const mediaById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const selected = getClip(project, selectedClipId);
  const selectedMedia = selected
    ? mediaById.get(selected.mediaId) ?? null
    : null;
  const selectedHasAudio =
    selected?.kind === "audio" ||
    (selected?.kind === "video" &&
      Boolean(selectedMedia?.hasAudio) &&
      !selected.audioDetached);
  const canDetach =
    selected?.kind === "video" &&
    Boolean(selectedMedia?.hasAudio) &&
    !selected.audioDetached;
  const canFastCopy =
    project.videoClips.length === 1 &&
    project.audioClips.length === 0 &&
    project.videoClips[0].speed === 1 &&
    project.videoClips[0].volume === 1 &&
    !project.videoClips[0].muted &&
    !project.videoClips[0].audioDetached &&
    exportSettings.resolution === "source";
  const fps = selectedMedia?.fps || 30;

  return (
    <aside className="inspector" aria-label="Properties and export">
      <header className="inspector-header">
        <span>PROPERTIES</span>
        <Icon name="info" size={17} />
      </header>

      <div className="inspector-scroll">
        <section className="inspector-section">
          <div className="section-heading-row">
            <h2>Media</h2>
            <span>{sources.length}</span>
          </div>
          {sources.length > 0 ? (
            <div className="source-list">
              {sources.map((source) => (
                <div
                  className={`source-card ${
                    selectedMedia?.id === source.id ? "is-current" : ""
                  }`}
                  key={source.id}
                >
                  <div className="source-card-icon">
                    <Icon
                      name={source.kind === "audio" ? "music" : "film"}
                      size={19}
                    />
                  </div>
                  <div>
                    <strong title={source.name}>{source.name}</strong>
                    <span>
                      {source.kind === "audio" ? "Audio" : "Video"} ·{" "}
                      {formatBytes(source.sizeBytes)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="inspector-empty">No media loaded.</p>
          )}

          {selectedMedia ? (
            <dl className="property-grid source-properties">
              {selectedMedia.hasVideo ? (
                <>
                  <dt>Resolution</dt>
                  <dd>
                    {selectedMedia.width} × {selectedMedia.height}
                  </dd>
                  <dt>Frame rate</dt>
                  <dd>
                    {selectedMedia.fps.toFixed(
                      selectedMedia.fps % 1 ? 2 : 0,
                    )}{" "}
                    fps
                  </dd>
                  <dt>Video</dt>
                  <dd>{selectedMedia.videoCodec ?? "—"}</dd>
                </>
              ) : null}
              <dt>Audio</dt>
              <dd>{selectedMedia.audioCodec ?? "none"}</dd>
              <dt>Duration</dt>
              <dd>{formatDuration(selectedMedia.durationUs)}</dd>
            </dl>
          ) : null}
        </section>

        <section className="inspector-section clip-inspector">
          <h2>Selected clip</h2>
          {selected ? (
            <>
              <dl className="property-grid">
                <dt>Type</dt>
                <dd>{selected.kind === "video" ? "V1 video" : "A1 audio"}</dd>
                <dt>Source start</dt>
                <dd>{formatTimecode(selected.sourceInUs, fps)}</dd>
                <dt>Source end</dt>
                <dd>{formatTimecode(selected.sourceOutUs, fps)}</dd>
                <dt>Timeline duration</dt>
                <dd>{formatTimecode(clipPlaybackDurationUs(selected), fps)}</dd>
                <dt>Timeline position</dt>
                <dd>
                  {formatTimecode(
                    getClipProjectStartUs(project, selected.id),
                    fps,
                  )}
                </dd>
              </dl>

              <div className="clip-control-grid">
                <label className="field">
                  <span>Speed</span>
                  <select
                    name="clip-speed"
                    value={selected.speed}
                    onChange={(event) =>
                      onPatchClip(selected.id, {
                        speed: Number(event.target.value),
                      })
                    }
                  >
                    {SPEEDS.map((speed) => (
                      <option key={speed} value={speed}>
                        {speed}×
                      </option>
                    ))}
                  </select>
                </label>

                <div className="field">
                  <span>Volume</span>
                  <div className="inspector-volume-row">
                    <input
                      aria-label="Selected clip volume"
                      disabled={!selectedHasAudio}
                      max="1"
                      min="0"
                      name="clip-volume"
                      step="0.05"
                      type="range"
                      value={selected.volume}
                      onChange={(event) =>
                        onPatchClip(selected.id, {
                          volume: Number(event.target.value),
                          muted: false,
                        })
                      }
                    />
                    <output>{Math.round(selected.volume * 100)}%</output>
                  </div>
                </div>

                <button
                  className={`clip-action-button ${
                    selected.muted ? "is-active" : ""
                  }`}
                  type="button"
                  aria-pressed={selected.muted}
                  disabled={!selectedHasAudio}
                  onClick={() =>
                    onPatchClip(selected.id, { muted: !selected.muted })
                  }
                >
                  <Icon name={selected.muted ? "mute" : "volume"} size={17} />
                  {selected.muted ? "Unmute" : "Mute clip"}
                </button>

                {canDetach ? (
                  <button
                    className="clip-action-button"
                    type="button"
                    onClick={() => onDetachAudio(selected.id)}
                  >
                    <Icon name="unlink" size={17} />
                    Detach audio to A1
                  </button>
                ) : null}

                {selected.kind === "video" && selected.audioDetached ? (
                  <p className="clip-control-note">
                    Audio detached. The A1 clip can be edited separately.
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <p className="inspector-empty">
              Select a clip to adjust its volume and speed.
            </p>
          )}
        </section>

        <section className="inspector-section export-section">
          <div className="section-heading-row">
            <h2>Export</h2>
            <span>MP4</span>
          </div>

          <label className="field">
            <span>Quality</span>
            <select
              name="export-quality"
              value={exportSettings.preset}
              disabled={project.videoClips.length === 0 || exporting}
              onChange={(event) =>
                onExportSettingsChange({
                  ...exportSettings,
                  preset: event.target.value as ExportSettings["preset"],
                })
              }
            >
              <option value="fast">Fast · CRF 23</option>
              <option value="balanced">Balanced · CRF 20</option>
              <option value="quality">High quality · CRF 18</option>
            </select>
          </label>

          <label className="field">
            <span>Resolution</span>
            <select
              name="export-resolution"
              value={exportSettings.resolution}
              disabled={project.videoClips.length === 0 || exporting}
              onChange={(event) => {
                const resolution = event.target
                  .value as ExportSettings["resolution"];
                onExportSettingsChange({
                  ...exportSettings,
                  resolution,
                  mode:
                    resolution !== "source" &&
                    exportSettings.mode === "fastCopy"
                      ? "precise"
                      : exportSettings.mode,
                });
              }}
            >
              <option value="source">Project / first video</option>
              <option value="1080">1080p maximum</option>
              <option value="720">720p maximum</option>
            </select>
          </label>

          <fieldset
            className="mode-choice"
            disabled={project.videoClips.length === 0 || exporting}
          >
            <legend>Cut accuracy</legend>
            <label>
              <input
                type="radio"
                name="export-mode"
                value="precise"
                checked={exportSettings.mode === "precise"}
                onChange={() =>
                  onExportSettingsChange({
                    ...exportSettings,
                    mode: "precise",
                  })
                }
              />
              <span>
                <strong>Accurate</strong>
                <small>Multiple sources, audio mixing, speed</small>
              </span>
            </label>
            <label className={!canFastCopy ? "is-disabled" : ""}>
              <input
                type="radio"
                name="export-mode"
                value="fastCopy"
                checked={exportSettings.mode === "fastCopy"}
                disabled={!canFastCopy}
                onChange={() =>
                  onExportSettingsChange({
                    ...exportSettings,
                    mode: "fastCopy",
                  })
                }
              />
              <span>
                <strong>Fast copy</strong>
                <small>For a single unmodified clip only</small>
              </span>
            </label>
          </fieldset>

          <button
            className="export-panel-button"
            type="button"
            disabled={project.videoClips.length === 0 || exporting}
            onClick={onExport}
          >
            <Icon name="export" />
            {exporting ? "Exporting…" : "Export video"}
          </button>
        </section>
      </div>
    </aside>
  );
});
