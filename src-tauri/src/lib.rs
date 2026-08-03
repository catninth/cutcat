mod export;
mod media;

use export::ExportState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(ExportState::default())
        .invoke_handler(tauri::generate_handler![
            media::import_media,
            export::start_export,
            export::cancel_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running CutCat");
}
