fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "humble_bridge_result", "humble_status", "humble_login", "humble_sync",
            "humble_reveal", "humble_cancel", "humble_logout", "export_keys", "copy_text", "open_external", "set_ui_language",
            "humble_clear_cache", "humble_reset_login", "humble_reset_all",
            "updates_get", "updates_set", "updates_check", "updates_download", "updates_apply", "updates_ready"
        ])
    )).expect("build metadata");
}
