mod commands;
use tauri::{Manager, window::Color};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_decorations(false)?;
            window.set_background_color(Some(Color(11, 11, 11, 255)))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_saves,
            commands::create_save,
            commands::auto_save,
            commands::get_diff,
            commands::rollback_to,
            commands::delete_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
