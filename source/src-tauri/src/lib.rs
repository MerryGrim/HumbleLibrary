mod humble;
mod storage;
mod locale;
mod app_updates;
mod browser_data;
mod auth_dispatch;
mod auth_trace;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("Недоступная операция".into()); }
    Ok(())
}

#[tauri::command]
async fn export_keys(window: WebviewWindow, contents: String, default_name: String) -> Result<Option<String>, String> {
    main_only(&window)?;
    let _operation = app_updates::operation()?;
    if contents.len() > 32 * 1024 * 1024 || contents.is_empty() { return Err("Нет ключей для экспорта или файл слишком велик".into()); }
    let name: String = default_name.chars().filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c)).take(140).collect();
    let name = if name.trim().is_empty() { "humble-keys.txt".to_string() } else { name };
    tauri::async_runtime::spawn_blocking(move || {
        let csv = name.ends_with(".csv");
        let dialog = rfd::FileDialog::new().set_title(locale::text("export")).set_file_name(name);
        let dialog = if csv { dialog.add_filter(locale::text("csv"), &["csv"]) } else { dialog.add_filter(locale::text("txt"), &["txt"]) };
        let Some(path) = dialog.save_file() else { return Ok(None); };
        std::fs::write(&path, contents.as_bytes()).map_err(|_| "Не удалось записать файл. Выберите другую папку".to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }).await.map_err(|_| "Не удалось открыть окно сохранения".to_string())?
}

#[tauri::command]
fn copy_text(window: WebviewWindow, text: String) -> Result<(), String> {
    main_only(&window)?;
    if text.is_empty() || text.len() > 1024 * 1024 { return Err("Нет данных для копирования".into()); }
    arboard::Clipboard::new().and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|_| "Не удалось скопировать ключ в буфер обмена".into())
}

#[tauri::command]
fn open_external(window: WebviewWindow, url: String) -> Result<(), String> {
    main_only(&window)?;
    let parsed = tauri::Url::parse(&url).map_err(|_| "Некорректная ссылка")?;
    if !["https", "http"].contains(&parsed.scheme()) || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Разрешены только веб-ссылки".into());
    }
    webbrowser::open(&url).map_err(|_| "Не удалось открыть ссылку".into())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_maximized().ok() == Some(false) { let _ = window.center(); }
                let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
            }
        }))
        .manage(humble::HumbleState::default())
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::Destroyed) { window.app_handle().exit(0); }
        })
        .invoke_handler(tauri::generate_handler![
            humble::humble_login, humble::humble_status, humble::humble_sync,
            humble::humble_reveal, humble::humble_logout, humble::humble_bridge_result,
            humble::humble_cancel, export_keys, copy_text, open_external, locale::set_ui_language,
            humble::humble_clear_cache, humble::humble_reset_login, humble::humble_reset_all, humble::humble_import_legacy,
            app_updates::updates_get, app_updates::updates_set, app_updates::updates_check,
            app_updates::updates_download, app_updates::updates_apply, app_updates::updates_ready
        ])
        .setup(|app| {
            let _ = std::fs::create_dir_all(storage::root());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Humble Library").inner_size(1280.0, 800.0).min_inner_size(940.0, 620.0)
                .center()
                .decorations(false).drag_and_drop(false)
                .data_directory(storage::root().join("Interface"))
                .additional_browser_args("--disable-gpu --disable-gpu-compositing")
                .on_navigation(|url| {
                    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") ||
                    (cfg!(debug_assertions) && url.host_str() == Some("localhost") && url.port() == Some(1430))
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Не удалось запустить Humble Library");
}

pub fn run_update_helper(path: std::path::PathBuf) -> Result<(), String> { app_updates::run_helper(&path) }
pub fn startup_update_recovery() -> Result<bool, String> { app_updates::startup_recover() }
