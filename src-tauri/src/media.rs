use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{process::Output, ShellExt};

const MAX_PROBE_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum MediaKind {
    Video,
    Audio,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    path: String,
    name: String,
    kind: MediaKind,
    duration_us: i64,
    width: u32,
    height: u32,
    fps: f64,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    has_video: bool,
    has_audio: bool,
    size_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct ProbeDocument {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    duration: Option<String>,
    #[serde(default)]
    disposition: ProbeDisposition,
}

#[derive(Debug, Default, Deserialize)]
struct ProbeDisposition {
    #[serde(default)]
    attached_pic: u8,
}

#[derive(Debug, Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

#[tauri::command]
pub async fn import_media(app: AppHandle, path: String) -> Result<MediaMetadata, String> {
    let canonical = validate_input_file(&path)?;
    let probe = probe_document(&app, &canonical).await?;
    let video = probe.streams.iter().find(|stream| stream.is_video());
    let audio = probe.streams.iter().find(|stream| stream.is_audio());

    if video.is_none() && audio.is_none() {
        return Err("A fájl nem tartalmaz támogatott video- vagy audiosávot.".to_owned());
    }

    let duration_seconds = probe
        .format
        .as_ref()
        .and_then(|format| parse_positive_number(format.duration.as_deref()))
        .or_else(|| video.and_then(|stream| parse_positive_number(stream.duration.as_deref())))
        .or_else(|| audio.and_then(|stream| parse_positive_number(stream.duration.as_deref())))
        .ok_or_else(|| "A média hossza nem olvasható.".to_owned())?;

    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Err("A média hossza érvénytelen.".to_owned());
    }

    let has_video = video.is_some();
    let has_audio = audio.is_some();
    let kind = if has_video {
        MediaKind::Video
    } else {
        MediaKind::Audio
    };
    let fps = video
        .map(|stream| {
            parse_frame_rate(
                stream
                    .avg_frame_rate
                    .as_deref()
                    .or(stream.r_frame_rate.as_deref()),
            )
        })
        .unwrap_or(0.0);
    let file_metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("A médiafájl adatai nem olvashatók: {error}"))?;
    let name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("media")
        .to_owned();

    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|error| format!("Az előnézeti hozzáférés nem engedélyezhető: {error}"))?;

    Ok(MediaMetadata {
        path: canonical.to_string_lossy().into_owned(),
        name,
        kind,
        duration_us: (duration_seconds * 1_000_000.0).round() as i64,
        width: video.and_then(|stream| stream.width).unwrap_or(0),
        height: video.and_then(|stream| stream.height).unwrap_or(0),
        fps,
        video_codec: video.and_then(|stream| stream.codec_name.clone()),
        audio_codec: audio.and_then(|stream| stream.codec_name.clone()),
        has_video,
        has_audio,
        size_bytes: file_metadata.len(),
    })
}

pub(crate) async fn probe_video_dimensions(
    app: &AppHandle,
    path: &Path,
) -> Result<(u32, u32), String> {
    let probe = probe_document(app, path).await?;
    let video = probe
        .streams
        .iter()
        .find(|stream| stream.is_video())
        .ok_or_else(|| "A forrás nem tartalmaz videosávot.".to_owned())?;
    let width = video
        .width
        .filter(|value| *value > 0)
        .ok_or_else(|| "A videó szélessége nem olvasható.".to_owned())?;
    let height = video
        .height
        .filter(|value| *value > 0)
        .ok_or_else(|| "A videó magassága nem olvasható.".to_owned())?;
    Ok((width, height))
}

pub fn validate_input_file(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("Hiányzó fájlútvonal.".to_owned());
    }

    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err("Csak abszolút helyi fájlútvonal engedélyezett.".to_owned());
    }

    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("A médiafájl nem érhető el: {error}"))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("A médiafájl nem olvasható: {error}"))?;

    if !metadata.is_file() {
        return Err("A kiválasztott útvonal nem fájl.".to_owned());
    }

    Ok(canonical)
}

async fn probe_document(app: &AppHandle, path: &Path) -> Result<ProbeDocument, String> {
    let arguments = vec![
        "-v".to_owned(),
        "error".to_owned(),
        "-of".to_owned(),
        "json".to_owned(),
        "-show_format".to_owned(),
        "-show_streams".to_owned(),
        "-i".to_owned(),
        path.to_string_lossy().into_owned(),
    ];
    let output = run_probe(app, arguments).await?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe nem tudta beolvasni a médiát: {}",
            short_stderr(&output.stderr)
        ));
    }
    if output.stdout.len() > MAX_PROBE_OUTPUT_BYTES {
        return Err("A média metadata-válasza túl nagy.".to_owned());
    }

    serde_json::from_slice(&output.stdout).map_err(|error| format!("Hibás ffprobe válasz: {error}"))
}

impl ProbeStream {
    fn is_video(&self) -> bool {
        self.codec_type.as_deref() == Some("video") && self.disposition.attached_pic == 0
    }

    fn is_audio(&self) -> bool {
        self.codec_type.as_deref() == Some("audio")
    }
}

async fn run_probe(app: &AppHandle, arguments: Vec<String>) -> Result<Output, String> {
    let sidecar_error = match app.shell().sidecar("ffprobe") {
        Ok(command) => match command.args(&arguments).output().await {
            Ok(output) => return Ok(output),
            Err(error) => error.to_string(),
        },
        Err(error) => error.to_string(),
    };

    app.shell()
        .command("ffprobe")
        .args(arguments)
        .output()
        .await
        .map_err(|path_error| {
            format!(
                "ffprobe nem indítható. Futtasd az `npm run ffmpeg:prepare` parancsot. Sidecar: {sidecar_error}; PATH: {path_error}"
            )
        })
}

fn parse_positive_number(value: Option<&str>) -> Option<f64> {
    value?.parse::<f64>().ok().filter(|number| *number > 0.0)
}

fn parse_frame_rate(value: Option<&str>) -> f64 {
    let Some(value) = value else {
        return 30.0;
    };
    let mut parts = value.split('/');
    let numerator = parts.next().and_then(|part| part.parse::<f64>().ok());
    let denominator = parts.next().and_then(|part| part.parse::<f64>().ok());

    match (numerator, denominator) {
        (Some(numerator), Some(denominator)) if numerator > 0.0 && denominator > 0.0 => {
            numerator / denominator
        }
        _ => value
            .parse::<f64>()
            .ok()
            .filter(|fps| *fps > 0.0)
            .unwrap_or(30.0),
    }
}

fn short_stderr(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("ismeretlen ffprobe hiba")
        .chars()
        .take(280)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(codec_type: &str, attached_pic: u8) -> ProbeStream {
        ProbeStream {
            codec_type: Some(codec_type.to_owned()),
            codec_name: Some("test".to_owned()),
            width: Some(600),
            height: Some(600),
            avg_frame_rate: None,
            r_frame_rate: None,
            duration: None,
            disposition: ProbeDisposition { attached_pic },
        }
    }

    #[test]
    fn attached_picture_is_not_a_video_track() {
        assert!(!stream("video", 1).is_video());
        assert!(stream("video", 0).is_video());
    }

    #[test]
    fn audio_stream_is_detected_independently() {
        assert!(stream("audio", 0).is_audio());
        assert!(!stream("video", 0).is_audio());
    }
}
