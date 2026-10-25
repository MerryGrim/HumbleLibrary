#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() == Some(std::ffi::OsStr::new("--apply-update")) {
        let result = args.next().ok_or_else(|| "Не указан файл задания обновления".to_string()).and_then(|path| {
            if args.next().is_some() { return Err("Неожиданные аргументы обновления".into()); }
            humble_library_lib::run_update_helper(path.into())
        });
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    match humble_library_lib::startup_update_recovery() {
        Ok(true) => return,
        Ok(false) => {},
        Err(error) => { eprintln!("{error}"); std::process::exit(1); }
    }
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu --disable-gpu-compositing");
    humble_library_lib::run();
}
