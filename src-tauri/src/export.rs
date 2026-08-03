use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use uuid::Uuid;

use crate::media::{probe_video_dimensions, validate_input_file};

const MAX_ERROR_LINES: usize = 32;
const MAX_SOURCES: usize = 256;
const MAX_CLIPS: usize = 1_000;
const MIN_SPEED: f64 = 0.25;
const MAX_SPEED: f64 = 4.0;
const MAX_VOLUME: f64 = 2.0;
const AUDIO_SAMPLE_RATE: i64 = 48_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    sources: Vec<ExportSource>,
    video_clips: Vec<ExportVideoClip>,
    audio_clips: Vec<ExportAudioClip>,
    output_path: String,
    preset: ExportPreset,
    mode: ExportMode,
    resolution: ExportResolution,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportSource {
    id: String,
    path: String,
    has_video: bool,
    has_audio: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportVideoClip {
    media_id: String,
    source_in_us: i64,
    source_out_us: i64,
    speed: f64,
    volume: f64,
    muted: bool,
    include_audio: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportAudioClip {
    media_id: String,
    source_in_us: i64,
    source_out_us: i64,
    timeline_start_us: i64,
    speed: f64,
    volume: f64,
    muted: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ExportPreset {
    Fast,
    Balanced,
    Quality,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum ExportMode {
    Precise,
    FastCopy,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
enum ExportResolution {
    #[serde(rename = "source")]
    Source,
    #[serde(rename = "1080")]
    P1080,
    #[serde(rename = "720")]
    P720,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ExportEvent {
    Started {
        #[serde(rename = "jobId")]
        job_id: String,
    },
    Progress {
        progress: f64,
        #[serde(rename = "outTimeUs")]
        out_time_us: i64,
        speed: Option<String>,
    },
    Completed {
        #[serde(rename = "outputPath")]
        output_path: String,
    },
    Cancelled,
    Failed {
        message: String,
    },
}

#[derive(Default)]
struct ExportJobs {
    children: HashMap<String, CommandChild>,
    cancelled: HashSet<String>,
}

#[derive(Default)]
pub struct ExportState {
    jobs: Mutex<ExportJobs>,
}

impl Drop for ExportState {
    fn drop(&mut self) {
        if let Ok(jobs) = self.jobs.get_mut() {
            for (_, child) in jobs.children.drain() {
                let _ = child.kill();
            }
        }
    }
}

#[tauri::command]
pub async fn start_export(
    app: AppHandle,
    state: State<'_, ExportState>,
    spec: ExportSpec,
    on_event: Channel<ExportEvent>,
) -> Result<String, String> {
    let validated = validate_spec(spec)?;
    let duration_us = timeline_duration_us(&validated.spec.video_clips)?;
    let target_resolution = match validated.spec.resolution {
        ExportResolution::P1080 => (1920, 1080),
        ExportResolution::P720 => (1280, 720),
        ExportResolution::Source => {
            let first_clip = validated
                .spec
                .video_clips
                .first()
                .ok_or_else(|| "Az exporthoz videoszegmens kell.".to_owned())?;
            let input_index = validated
                .source_inputs
                .get(&first_clip.media_id)
                .copied()
                .ok_or_else(|| "A videoszegmens forrása hiányzik.".to_owned())?;
            let dimensions = probe_video_dimensions(&app, &validated.inputs[input_index]).await?;
            even_dimensions(dimensions)
        }
    };
    let job_id = Uuid::new_v4().to_string();
    let arguments = build_arguments(
        &validated.spec,
        &validated.inputs,
        &validated.source_inputs,
        &validated.partial,
        target_resolution,
    )?;
    let (mut receiver, child) = spawn_ffmpeg(&app, &arguments)?;

    {
        let mut jobs = state
            .jobs
            .lock()
            .map_err(|_| "Az export állapota nem elérhető.".to_owned())?;
        if !jobs.children.is_empty() {
            let _ = child.kill();
            return Err("Már fut egy export.".to_owned());
        }
        jobs.children.insert(job_id.clone(), child);
    }

    let _ = on_event.send(ExportEvent::Started {
        job_id: job_id.clone(),
    });

    let mut out_time_us = 0_i64;
    let mut speed: Option<String> = None;
    let mut errors = VecDeque::with_capacity(MAX_ERROR_LINES);
    let mut exit_code = None;
    let mut command_error: Option<String> = None;

    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                if let Some((key, value)) = line.trim().split_once('=') {
                    match key {
                        "out_time_us" | "out_time_ms" => {
                            out_time_us = value.parse::<i64>().unwrap_or(out_time_us);
                        }
                        "speed" => speed = Some(value.to_owned()),
                        "progress" => {
                            let progress =
                                (out_time_us as f64 / duration_us as f64).clamp(0.0, 1.0);
                            let _ = on_event.send(ExportEvent::Progress {
                                progress,
                                out_time_us,
                                speed: speed.clone(),
                            });
                        }
                        _ => {}
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_owned();
                if !line.is_empty() {
                    if errors.len() == MAX_ERROR_LINES {
                        errors.pop_front();
                    }
                    errors.push_back(line);
                }
            }
            CommandEvent::Error(error) => command_error = Some(error),
            CommandEvent::Terminated(payload) => exit_code = payload.code,
            _ => {}
        }
    }

    let was_cancelled = {
        let mut jobs = state
            .jobs
            .lock()
            .map_err(|_| "Az export állapota nem elérhető.".to_owned())?;
        jobs.children.remove(&job_id);
        jobs.cancelled.remove(&job_id)
    };

    if was_cancelled {
        remove_partial(&validated.partial);
        let _ = on_event.send(ExportEvent::Cancelled);
        return Err("Az export megszakítva.".to_owned());
    }

    if exit_code != Some(0) || command_error.is_some() {
        remove_partial(&validated.partial);
        let details = command_error
            .or_else(|| errors.iter().rev().find(|line| !line.is_empty()).cloned())
            .unwrap_or_else(|| format!("FFmpeg kilépési kód: {exit_code:?}"));
        let message = format!("FFmpeg export hiba: {details}");
        let _ = on_event.send(ExportEvent::Failed {
            message: message.clone(),
        });
        return Err(message);
    }

    let output_metadata = std::fs::metadata(&validated.partial)
        .map_err(|error| format!("A részleges export nem olvasható: {error}"))?;
    if output_metadata.len() == 0 {
        remove_partial(&validated.partial);
        return Err("FFmpeg üres kimeneti fájlt készített.".to_owned());
    }

    if validated.output.exists() {
        std::fs::remove_file(&validated.output)
            .map_err(|error| format!("A meglévő kimenet nem írható felül: {error}"))?;
    }
    std::fs::rename(&validated.partial, &validated.output)
        .map_err(|error| format!("Az export nem véglegesíthető: {error}"))?;

    let output_path = validated.output.to_string_lossy().into_owned();
    let _ = on_event.send(ExportEvent::Completed {
        output_path: output_path.clone(),
    });
    Ok(output_path)
}

#[tauri::command]
pub fn cancel_export(state: State<'_, ExportState>, job_id: String) -> Result<(), String> {
    let child = {
        let mut jobs = state
            .jobs
            .lock()
            .map_err(|_| "Az export állapota nem elérhető.".to_owned())?;
        let child = jobs
            .children
            .remove(&job_id)
            .ok_or_else(|| "Az export folyamat már nem fut.".to_owned())?;
        jobs.cancelled.insert(job_id);
        child
    };

    child
        .kill()
        .map_err(|error| format!("Az FFmpeg folyamat nem állítható le: {error}"))
}

struct ValidatedExport {
    spec: ExportSpec,
    inputs: Vec<PathBuf>,
    source_inputs: HashMap<String, usize>,
    output: PathBuf,
    partial: PathBuf,
}

fn validate_spec(spec: ExportSpec) -> Result<ValidatedExport, String> {
    if spec.sources.is_empty() {
        return Err("Az exporthoz legalább egy forrás kell.".to_owned());
    }
    if spec.sources.len() > MAX_SOURCES {
        return Err("Túl sok médiaforrás az exporthoz.".to_owned());
    }
    if spec.video_clips.is_empty() {
        return Err("Az exporthoz legalább egy videoszegmens kell.".to_owned());
    }
    if spec.video_clips.len() + spec.audio_clips.len() > MAX_CLIPS {
        return Err("Túl sok szegmens az exporthoz.".to_owned());
    }

    let mut source_by_id = HashMap::with_capacity(spec.sources.len());
    for source in &spec.sources {
        if source.id.trim().is_empty() {
            return Err("Hiányzó médiaforrás-azonosító.".to_owned());
        }
        if source_by_id.insert(source.id.as_str(), source).is_some() {
            return Err(format!("Duplikált médiaforrás: {}", source.id));
        }
    }

    let mut used_media_ids = HashSet::new();
    for clip in &spec.video_clips {
        validate_clip_range(
            clip.source_in_us,
            clip.source_out_us,
            clip.speed,
            clip.volume,
        )?;
        let source = source_by_id
            .get(clip.media_id.as_str())
            .ok_or_else(|| format!("Hiányzó videóforrás: {}", clip.media_id))?;
        if !source.has_video {
            return Err(format!(
                "A médiaforrás nem tartalmaz videosávot: {}",
                clip.media_id
            ));
        }
        if clip.include_audio && !source.has_audio {
            return Err(format!(
                "A médiaforrás nem tartalmaz audiosávot: {}",
                clip.media_id
            ));
        }
        used_media_ids.insert(clip.media_id.as_str());
    }
    for clip in &spec.audio_clips {
        validate_clip_range(
            clip.source_in_us,
            clip.source_out_us,
            clip.speed,
            clip.volume,
        )?;
        if clip.timeline_start_us < 0 {
            return Err("Az audioszegmens timeline-pozíciója nem lehet negatív.".to_owned());
        }
        let source = source_by_id
            .get(clip.media_id.as_str())
            .ok_or_else(|| format!("Hiányzó audioforrás: {}", clip.media_id))?;
        if !source.has_audio {
            return Err(format!(
                "A médiaforrás nem tartalmaz audiosávot: {}",
                clip.media_id
            ));
        }
        used_media_ids.insert(clip.media_id.as_str());
    }

    timeline_duration_us(&spec.video_clips)?;
    if spec.mode == ExportMode::FastCopy && !fast_copy_compatible(&spec) {
        return Err(
            "Gyors másolás csak egy 1× sebességű videoszegmenshez, külső hangsáv és átméretezés nélkül használható."
                .to_owned(),
        );
    }

    let mut inputs = Vec::new();
    let mut canonical_inputs = HashMap::<PathBuf, usize>::new();
    let mut source_inputs = HashMap::new();
    for source in &spec.sources {
        if !used_media_ids.contains(source.id.as_str()) {
            continue;
        }
        let canonical = validate_input_file(&source.path)?;
        let input_index = if let Some(index) = canonical_inputs.get(&canonical) {
            *index
        } else {
            let index = inputs.len();
            inputs.push(canonical.clone());
            canonical_inputs.insert(canonical, index);
            index
        };
        source_inputs.insert(source.id.clone(), input_index);
    }

    let requested_output = Path::new(&spec.output_path);
    if !requested_output.is_absolute() {
        return Err("A kimenethez abszolút útvonal kell.".to_owned());
    }
    let parent = requested_output
        .parent()
        .ok_or_else(|| "A kimeneti mappa hiányzik.".to_owned())?
        .canonicalize()
        .map_err(|error| format!("A kimeneti mappa nem érhető el: {error}"))?;
    let file_stem = requested_output
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or("cutcat-export");
    let output = parent.join(format!("{file_stem}.mp4"));

    if inputs.iter().any(|input| input == &output) {
        return Err("A forrásfájl nem írható felül.".to_owned());
    }

    let partial = parent.join(format!(".{file_stem}.{}.partial.mp4", Uuid::new_v4()));

    Ok(ValidatedExport {
        spec,
        inputs,
        source_inputs,
        output,
        partial,
    })
}

fn validate_clip_range(
    source_in_us: i64,
    source_out_us: i64,
    speed: f64,
    volume: f64,
) -> Result<(), String> {
    if source_in_us < 0 || source_out_us <= source_in_us {
        return Err("Érvénytelen szegmens-időtartomány.".to_owned());
    }
    if !speed.is_finite() || !(MIN_SPEED..=MAX_SPEED).contains(&speed) {
        return Err(format!(
            "A sebesség {MIN_SPEED}× és {MAX_SPEED}× között lehet."
        ));
    }
    if !volume.is_finite() || !(0.0..=MAX_VOLUME).contains(&volume) {
        return Err(format!("A hangerő 0 és {MAX_VOLUME} között lehet."));
    }
    if playback_duration_us(source_in_us, source_out_us, speed)? <= 0 {
        return Err("A szegmens lejátszási hossza túl rövid.".to_owned());
    }
    Ok(())
}

fn fast_copy_compatible(spec: &ExportSpec) -> bool {
    if spec.video_clips.len() != 1
        || !spec.audio_clips.is_empty()
        || spec.resolution != ExportResolution::Source
    {
        return false;
    }
    let clip = &spec.video_clips[0];
    if !approximately(clip.speed, 1.0) {
        return false;
    }
    !clip.include_audio || clip.muted || clip.volume == 0.0 || approximately(clip.volume, 1.0)
}

fn build_arguments(
    spec: &ExportSpec,
    inputs: &[PathBuf],
    source_inputs: &HashMap<String, usize>,
    partial: &Path,
    target_resolution: (u32, u32),
) -> Result<Vec<String>, String> {
    let mut arguments = vec![
        "-hide_banner".to_owned(),
        "-y".to_owned(),
        "-progress".to_owned(),
        "pipe:1".to_owned(),
        "-stats_period".to_owned(),
        "0.2".to_owned(),
        "-nostats".to_owned(),
    ];

    if spec.mode == ExportMode::FastCopy {
        let clip = &spec.video_clips[0];
        let input_index = source_inputs
            .get(&clip.media_id)
            .copied()
            .ok_or_else(|| "A gyors export forrása hiányzik.".to_owned())?;
        arguments.extend([
            "-ss".to_owned(),
            seconds(clip.source_in_us),
            "-i".to_owned(),
            inputs[input_index].to_string_lossy().into_owned(),
            "-t".to_owned(),
            seconds(playback_duration_us(
                clip.source_in_us,
                clip.source_out_us,
                clip.speed,
            )?),
            "-map".to_owned(),
            "0:v:0".to_owned(),
        ]);
        if clip.include_audio && !clip.muted && clip.volume > 0.0 {
            arguments.extend(["-map".to_owned(), "0:a:0?".to_owned()]);
        }
        arguments.extend([
            "-c".to_owned(),
            "copy".to_owned(),
            "-avoid_negative_ts".to_owned(),
            "make_zero".to_owned(),
            "-movflags".to_owned(),
            "+faststart".to_owned(),
            partial.to_string_lossy().into_owned(),
        ]);
        return Ok(arguments);
    }

    for input in inputs {
        arguments.extend(["-i".to_owned(), input.to_string_lossy().into_owned()]);
    }
    let graph = build_filtergraph(spec, source_inputs, target_resolution)?;
    arguments.extend([
        "-filter_complex".to_owned(),
        graph.graph,
        "-map".to_owned(),
        "[outv]".to_owned(),
    ]);
    if graph.has_audio {
        arguments.extend(["-map".to_owned(), "[outa]".to_owned()]);
    }

    let (preset, crf) = match spec.preset {
        ExportPreset::Fast => ("ultrafast", "23"),
        ExportPreset::Balanced => ("veryfast", "20"),
        ExportPreset::Quality => ("medium", "18"),
    };
    arguments.extend([
        "-c:v".to_owned(),
        "libx264".to_owned(),
        "-preset".to_owned(),
        preset.to_owned(),
        "-crf".to_owned(),
        crf.to_owned(),
        "-pix_fmt".to_owned(),
        "yuv420p".to_owned(),
    ]);

    if graph.has_audio {
        arguments.extend([
            "-c:a".to_owned(),
            "aac".to_owned(),
            "-b:a".to_owned(),
            "192k".to_owned(),
        ]);
    }
    arguments.extend([
        "-movflags".to_owned(),
        "+faststart".to_owned(),
        partial.to_string_lossy().into_owned(),
    ]);
    Ok(arguments)
}

struct GraphBuild {
    graph: String,
    has_audio: bool,
}

struct AudioBranch<'a> {
    media_id: &'a str,
    source_in_us: i64,
    source_out_us: i64,
    timeline_start_us: i64,
    speed: f64,
    volume: f64,
}

fn build_filtergraph(
    spec: &ExportSpec,
    source_inputs: &HashMap<String, usize>,
    target_resolution: (u32, u32),
) -> Result<GraphBuild, String> {
    let duration_us = timeline_duration_us(&spec.video_clips)?;
    let mut attached_start_us = 0_i64;
    let mut audio_branches = Vec::new();
    for clip in &spec.video_clips {
        if clip.include_audio && !clip.muted && clip.volume > 0.0 {
            audio_branches.push(AudioBranch {
                media_id: &clip.media_id,
                source_in_us: clip.source_in_us,
                source_out_us: clip.source_out_us,
                timeline_start_us: attached_start_us,
                speed: clip.speed,
                volume: clip.volume,
            });
        }
        attached_start_us = attached_start_us
            .checked_add(playback_duration_us(
                clip.source_in_us,
                clip.source_out_us,
                clip.speed,
            )?)
            .ok_or_else(|| "A timeline hossza túl nagy.".to_owned())?;
    }
    for clip in &spec.audio_clips {
        if !clip.muted && clip.volume > 0.0 && clip.timeline_start_us < duration_us {
            audio_branches.push(AudioBranch {
                media_id: &clip.media_id,
                source_in_us: clip.source_in_us,
                source_out_us: clip.source_out_us,
                timeline_start_us: clip.timeline_start_us,
                speed: clip.speed,
                volume: clip.volume,
            });
        }
    }

    let mut video_consumers = BTreeMap::new();
    for clip in &spec.video_clips {
        let input_index = input_index(source_inputs, &clip.media_id)?;
        *video_consumers.entry(input_index).or_insert(0) += 1;
    }
    let mut audio_consumers = BTreeMap::new();
    for branch in &audio_branches {
        let input_index = input_index(source_inputs, branch.media_id)?;
        *audio_consumers.entry(input_index).or_insert(0) += 1;
    }

    let mut chains = Vec::new();
    let mut video_pads = prepare_input_pads(&video_consumers, "v", "split", "vsrc", &mut chains);
    let mut audio_pads = prepare_input_pads(&audio_consumers, "a", "asplit", "asrc", &mut chains);
    let (target_width, target_height) = target_resolution;

    for (index, clip) in spec.video_clips.iter().enumerate() {
        let input_index = input_index(source_inputs, &clip.media_id)?;
        let input_pad = take_pad(&mut video_pads, input_index, "video")?;
        let output_label = if spec.video_clips.len() == 1 {
            "outv".to_owned()
        } else {
            format!("v{index}")
        };
        chains.push(format!(
            "{input_pad}trim=start={}:end={},settb=AVTB,setpts=(PTS-STARTPTS)/{},scale=w={target_width}:h={target_height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=w={target_width}:h={target_height}:x=(ow-iw)/2:y=(oh-ih)/2:color=black,setsar=1,format=yuv420p[{output_label}]",
            seconds(clip.source_in_us),
            seconds(clip.source_out_us),
            decimal(clip.speed),
        ));
    }

    if spec.video_clips.len() > 1 {
        let inputs = (0..spec.video_clips.len())
            .map(|index| format!("[v{index}]"))
            .collect::<String>();
        chains.push(format!(
            "{inputs}concat=n={}:v=1:a=0[outv]",
            spec.video_clips.len()
        ));
    }

    let mut audio_labels = Vec::with_capacity(audio_branches.len());
    for (index, branch) in audio_branches.iter().enumerate() {
        let input_index = input_index(source_inputs, branch.media_id)?;
        let input_pad = take_pad(&mut audio_pads, input_index, "audio")?;
        let output_label = format!("a{index}");
        let mut chain = format!(
            "{input_pad}atrim=start={}:end={},asetpts=PTS-STARTPTS",
            seconds(branch.source_in_us),
            seconds(branch.source_out_us)
        );
        for factor in atempo_factors(branch.speed) {
            chain.push_str(&format!(",atempo={}", decimal(factor)));
        }
        chain.push_str(&format!(
            ",aresample={AUDIO_SAMPLE_RATE},aformat=sample_fmts=fltp:sample_rates={AUDIO_SAMPLE_RATE}:channel_layouts=stereo,volume={}",
            decimal(branch.volume)
        ));
        let delay_samples = timeline_delay_samples(branch.timeline_start_us)?;
        if delay_samples > 0 {
            chain.push_str(&format!(",adelay={delay_samples}S:all=1"));
        }
        chain.push_str(&format!("[{output_label}]"));
        chains.push(chain);
        audio_labels.push(output_label);
    }

    if !audio_labels.is_empty() {
        let duration = seconds(duration_us);
        let inputs = audio_labels
            .iter()
            .map(|label| format!("[{label}]"))
            .collect::<String>();
        let mix = if audio_labels.len() == 1 {
            format!(
                "{inputs}alimiter=limit=0.95:latency=1,apad=whole_dur={duration},atrim=duration={duration}[outa]"
            )
        } else {
            format!(
                "{inputs}amix=inputs={}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:latency=1,apad=whole_dur={duration},atrim=duration={duration}[outa]",
                audio_labels.len()
            )
        };
        chains.push(mix);
    }

    Ok(GraphBuild {
        graph: chains.join(";"),
        has_audio: !audio_labels.is_empty(),
    })
}

fn prepare_input_pads(
    consumers: &BTreeMap<usize, usize>,
    stream_type: &str,
    split_filter: &str,
    label_prefix: &str,
    chains: &mut Vec<String>,
) -> HashMap<usize, VecDeque<String>> {
    let mut result = HashMap::new();
    for (&input_index, &count) in consumers {
        let mut pads = VecDeque::with_capacity(count);
        if count == 1 {
            pads.push_back(format!("[{input_index}:{stream_type}:0]"));
        } else {
            let labels = (0..count)
                .map(|branch| format!("[{label_prefix}{input_index}_{branch}]"))
                .collect::<Vec<_>>();
            chains.push(format!(
                "[{input_index}:{stream_type}:0]{split_filter}={count}{}",
                labels.join("")
            ));
            pads.extend(labels);
        }
        result.insert(input_index, pads);
    }
    result
}

fn take_pad(
    pads: &mut HashMap<usize, VecDeque<String>>,
    input_index: usize,
    stream_name: &str,
) -> Result<String, String> {
    pads.get_mut(&input_index)
        .and_then(VecDeque::pop_front)
        .ok_or_else(|| format!("Hiányzó {stream_name} filter bemenet."))
}

fn input_index(source_inputs: &HashMap<String, usize>, media_id: &str) -> Result<usize, String> {
    source_inputs
        .get(media_id)
        .copied()
        .ok_or_else(|| format!("Hiányzó médiaforrás: {media_id}"))
}

fn timeline_duration_us(clips: &[ExportVideoClip]) -> Result<i64, String> {
    clips.iter().try_fold(0_i64, |total, clip| {
        total
            .checked_add(playback_duration_us(
                clip.source_in_us,
                clip.source_out_us,
                clip.speed,
            )?)
            .ok_or_else(|| "A timeline hossza túl nagy.".to_owned())
    })
}

fn playback_duration_us(source_in_us: i64, source_out_us: i64, speed: f64) -> Result<i64, String> {
    let duration = (source_out_us - source_in_us) as f64 / speed;
    if !duration.is_finite() || duration <= 0.0 || duration > i64::MAX as f64 {
        return Err("Érvénytelen lejátszási idő.".to_owned());
    }
    Ok(duration.round() as i64)
}

fn timeline_delay_samples(timeline_start_us: i64) -> Result<i64, String> {
    let samples = timeline_start_us as f64 * AUDIO_SAMPLE_RATE as f64 / 1_000_000.0;
    if !samples.is_finite() || samples < 0.0 || samples > i64::MAX as f64 {
        return Err("Érvénytelen audio timeline-pozíció.".to_owned());
    }
    Ok(samples.round() as i64)
}

fn atempo_factors(speed: f64) -> Vec<f64> {
    let mut remaining = speed;
    let mut factors = Vec::new();
    while remaining > 2.0 {
        factors.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        factors.push(0.5);
        remaining /= 0.5;
    }
    if !approximately(remaining, 1.0) {
        factors.push(remaining);
    }
    factors
}

fn even_dimensions((width, height): (u32, u32)) -> (u32, u32) {
    ((width - width % 2).max(2), (height - height % 2).max(2))
}

fn approximately(left: f64, right: f64) -> bool {
    (left - right).abs() < 0.000_001
}

fn decimal(value: f64) -> String {
    let formatted = format!("{value:.6}");
    let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn seconds(time_us: i64) -> String {
    format!("{:.6}", time_us as f64 / 1_000_000.0)
}

fn spawn_ffmpeg(
    app: &AppHandle,
    arguments: &[String],
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let sidecar_error = match app.shell().sidecar("ffmpeg") {
        Ok(command) => match command.args(arguments).spawn() {
            Ok(process) => return Ok(process),
            Err(error) => error.to_string(),
        },
        Err(error) => error.to_string(),
    };

    app.shell()
        .command("ffmpeg")
        .args(arguments)
        .spawn()
        .map_err(|path_error| {
            format!(
                "FFmpeg nem indítható. Futtasd az `npm run ffmpeg:prepare` parancsot. Sidecar: {sidecar_error}; PATH: {path_error}"
            )
        })
}

fn remove_partial(path: &Path) {
    if path.is_file() {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str, has_video: bool, has_audio: bool) -> ExportSource {
        ExportSource {
            id: id.to_owned(),
            path: format!("{id}.mp4"),
            has_video,
            has_audio,
        }
    }

    fn video(media_id: &str, source_in_us: i64, source_out_us: i64, speed: f64) -> ExportVideoClip {
        ExportVideoClip {
            media_id: media_id.to_owned(),
            source_in_us,
            source_out_us,
            speed,
            volume: 1.0,
            muted: false,
            include_audio: true,
        }
    }

    fn audio(
        media_id: &str,
        source_in_us: i64,
        source_out_us: i64,
        timeline_start_us: i64,
    ) -> ExportAudioClip {
        ExportAudioClip {
            media_id: media_id.to_owned(),
            source_in_us,
            source_out_us,
            timeline_start_us,
            speed: 1.0,
            volume: 0.2,
            muted: false,
        }
    }

    fn spec(
        sources: Vec<ExportSource>,
        video_clips: Vec<ExportVideoClip>,
        audio_clips: Vec<ExportAudioClip>,
    ) -> ExportSpec {
        ExportSpec {
            sources,
            video_clips,
            audio_clips,
            output_path: "output.mp4".to_owned(),
            preset: ExportPreset::Balanced,
            mode: ExportMode::Precise,
            resolution: ExportResolution::Source,
        }
    }

    fn input_map(entries: &[(&str, usize)]) -> HashMap<String, usize> {
        entries
            .iter()
            .map(|(id, index)| ((*id).to_owned(), *index))
            .collect()
    }

    #[test]
    fn graph_concatenates_normalized_multi_source_video() {
        let project = spec(
            vec![
                source("cam-a", true, true),
                source("cam-b", true, true),
                source("music", false, true),
            ],
            vec![
                video("cam-a", 5_000_000, 13_000_000, 2.0),
                video("cam-b", 2_000_000, 8_000_000, 1.0),
            ],
            vec![audio("music", 10_000_000, 18_500_000, 1_500_000)],
        );
        let graph = build_filtergraph(
            &project,
            &input_map(&[("cam-a", 0), ("cam-b", 1), ("music", 2)]),
            (1920, 1080),
        )
        .unwrap();

        assert!(graph.graph.contains(
            "[0:v:0]trim=start=5.000000:end=13.000000,settb=AVTB,setpts=(PTS-STARTPTS)/2"
        ));
        assert!(graph
            .graph
            .contains("scale=w=1920:h=1080:force_original_aspect_ratio=decrease"));
        assert!(graph.graph.contains("[v0][v1]concat=n=2:v=1:a=0[outv]"));
        assert!(graph.graph.contains("[0:a:0]atrim=start=5.000000"));
        assert!(graph.graph.contains("atempo=2"));
        assert!(graph.graph.contains("adelay=192000S:all=1"));
        assert!(graph.graph.contains("[2:a:0]atrim=start=10.000000"));
        assert!(graph.graph.contains("adelay=72000S:all=1"));
        assert!(graph.graph.contains(
            "[a0][a1][a2]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0"
        ));
        assert!(graph.has_audio);
    }

    #[test]
    fn graph_splits_reused_video_and_audio_inputs() {
        let project = spec(
            vec![source("camera", true, true)],
            vec![
                video("camera", 0, 2_000_000, 1.0),
                video("camera", 4_000_000, 6_000_000, 1.0),
            ],
            vec![],
        );
        let graph = build_filtergraph(&project, &input_map(&[("camera", 0)]), (1280, 720)).unwrap();

        assert!(graph.graph.contains("[0:v:0]split=2[vsrc0_0][vsrc0_1]"));
        assert!(graph.graph.contains("[0:a:0]asplit=2[asrc0_0][asrc0_1]"));
    }

    #[test]
    fn graph_omits_muted_attached_and_external_audio() {
        let mut video_clip = video("camera", 0, 2_000_000, 1.0);
        video_clip.muted = true;
        let mut audio_clip = audio("music", 0, 2_000_000, 0);
        audio_clip.muted = true;
        let project = spec(
            vec![source("camera", true, true), source("music", false, true)],
            vec![video_clip],
            vec![audio_clip],
        );
        let graph = build_filtergraph(
            &project,
            &input_map(&[("camera", 0), ("music", 1)]),
            (1280, 720),
        )
        .unwrap();

        assert!(!graph.graph.contains("atrim"));
        assert!(!graph.graph.contains("amix"));
        assert!(!graph.has_audio);
    }

    #[test]
    fn duration_accounts_for_clip_speed() {
        let clips = vec![
            video("camera", 0, 8_000_000, 2.0),
            video("camera", 0, 3_000_000, 0.5),
        ];
        assert_eq!(timeline_duration_us(&clips).unwrap(), 10_000_000);
    }

    #[test]
    fn atempo_is_chained_for_extreme_supported_speeds() {
        assert_eq!(atempo_factors(4.0), vec![2.0, 2.0]);
        assert_eq!(atempo_factors(0.25), vec![0.5, 0.5]);
        assert_eq!(atempo_factors(1.0), Vec::<f64>::new());
    }

    #[test]
    fn fast_copy_rejects_speed_audio_tracks_and_resize() {
        let mut project = spec(
            vec![source("camera", true, true)],
            vec![video("camera", 0, 2_000_000, 1.0)],
            vec![],
        );
        project.mode = ExportMode::FastCopy;
        assert!(fast_copy_compatible(&project));

        project.video_clips[0].speed = 2.0;
        assert!(!fast_copy_compatible(&project));
        project.video_clips[0].speed = 1.0;
        project.audio_clips.push(audio("camera", 0, 1_000_000, 0));
        assert!(!fast_copy_compatible(&project));
        project.audio_clips.clear();
        project.resolution = ExportResolution::P720;
        assert!(!fast_copy_compatible(&project));
    }
}
