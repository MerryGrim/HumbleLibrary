use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

const LABEL: &str = "humble-account";
const ORIGIN: &str = "https://www.humblebundle.com";
// The identity service creates a fresh flow; never retain a flow from a prior login.
const LOGIN_URL: &str = "https://auth.humblebundle.com/login";
const BROWSER_ARGS: &str = "--disable-gpu --disable-gpu-compositing";
const MAX_PAYLOAD: usize = 64 * 1024 * 1024;
const AUTH_WATCH_INTERVAL: Duration = Duration::from_secs(5);
const AUTH_WATCH_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub id: String,
    pub title: String,
    #[serde(default)] pub image_url: String,
    #[serde(default)] pub purchased_at: Option<String>,
    #[serde(default)] pub items: Vec<KeyItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyItem {
    pub id: String,
    pub title: String,
    pub platform: String,
    pub key: Option<String>,
    pub status: String,
    #[serde(default)] pub instructions: Option<String>,
    #[serde(default)] pub redeem_url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub connected: bool,
    pub auth_state: AuthState,
    pub last_sync: Option<String>,
    pub bundles: Vec<Bundle>,
    pub warning: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthState { #[default] Unknown, Authenticated, Unauthenticated }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus { pub connected: bool, pub auth_state: AuthState }
impl AuthState {
    fn status(self) -> SessionStatus { SessionStatus { connected: self == Self::Authenticated, auth_state: self } }
}

#[derive(Default)]
struct Library {
    loaded: bool,
    auth_state: AuthState,
    bundles: Vec<Bundle>,
    last_sync: Option<String>,
    warning: Option<String>,
}
struct Pending { nonce: String, operation: String, sender: oneshot::Sender<Value> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginAttempt { pub attempt_id: String }
#[derive(Clone, Debug)]
struct AuthProbe { attempt_id: String, probe_id: String }
#[derive(Default)]
struct LoginLifecycle { current: Option<String>, probing: Option<String> }
impl LoginLifecycle {
    fn begin(&mut self) -> LoginAttempt {
        let attempt_id = uuid::Uuid::new_v4().to_string();
        self.current = Some(attempt_id.clone()); self.probing = None;
        LoginAttempt { attempt_id }
    }
    fn start_probe(&mut self) -> Option<AuthProbe> {
        if self.probing.is_some() { return None; }
        let attempt_id = self.current.clone()?; let probe_id = uuid::Uuid::new_v4().to_string();
        self.probing = Some(probe_id.clone()); Some(AuthProbe { attempt_id, probe_id })
    }
    fn start_probe_for(&mut self, expected_attempt: Option<&str>) -> Option<AuthProbe> {
        if expected_attempt.is_some_and(|attempt| self.current.as_deref() != Some(attempt)) { return None; }
        self.start_probe()
    }
    fn matches(&self, probe: &AuthProbe) -> bool { self.current.as_deref() == Some(probe.attempt_id.as_str()) && self.probing.as_deref() == Some(probe.probe_id.as_str()) }
    fn finish_probe(&mut self, probe: &AuthProbe) { if self.matches(probe) { self.probing = None; } }
    fn complete(&mut self, probe: &AuthProbe) -> bool {
        if !self.matches(probe) { return false; }
        self.current = None; self.probing = None; true
    }
    fn cancel(&mut self) -> Option<LoginAttempt> { self.probing = None; self.current.take().map(|attempt_id| LoginAttempt { attempt_id }) }
}
#[derive(Default)]
pub struct HumbleState {
    library: Mutex<Library>,
    pending: Mutex<Option<Pending>>,
    operation: tokio::sync::Mutex<()>,
    ready: AtomicBool,
    login: Mutex<LoginLifecycle>,
    window_instance: Mutex<Option<String>>,
    cancelled: AtomicBool,
}

fn error(reason: &str) -> String {
    match reason {
        "auth" => "Войдите в Humble Bundle в отдельном окне, затем обновите библиотеку.",
        "rateLimited" => "Humble Bundle временно ограничил запросы. Подождите и повторите действие.",
        "network" => "Не удалось связаться с Humble Bundle. Проверьте подключение.",
        "cancelled" => "Операция остановлена. Уже отправленное раскрытие могло завершиться: обновите библиотеку перед повтором.",
        "notFound" => "Товар больше не найден в этой покупке. Обновите библиотеку.",
        "unavailable" => "Этот ключ сейчас недоступен. Проверьте товар на сайте Humble Bundle.",
        "external" => "Для этого товара требуется действие на странице Humble Bundle или сайте издателя.",
        "uncertain" => "Humble Bundle не подтвердил результат раскрытия. Обновите библиотеку перед повтором.",
        "protocol" => "Humble Bundle вернул неподдерживаемый ответ. Откройте сайт для проверки.",
        "busy" => "Дождитесь завершения текущей операции или остановите её.",
        "window" => "Не удалось открыть окно Humble Bundle.",
        _ => "Не удалось выполнить действие в Humble Bundle. Попробуйте обновить библиотеку.",
    }.into()
}

fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err(error("service")) }
}

fn official(url: &tauri::Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("www.humblebundle.com")
        && url.port_or_known_default() == Some(443) && url.username().is_empty() && url.password().is_none()
}

fn profile() -> std::path::PathBuf { crate::storage::root().join("Account").join("humble-web") }
fn current_window(state: &HumbleState, token: &str) -> bool { state.window_instance.lock().ok().is_some_and(|value| value.as_deref() == Some(token)) }
fn cancel_pending_auth(state: &HumbleState) {
    if let Ok(mut pending) = state.pending.lock() {
        if pending.as_ref().is_some_and(|pending| pending.operation == "auth") {
            if let Some(pending) = pending.take() { let _ = pending.sender.send(json!({"ok":false,"reason":"cancelled"})); }
        }
    }
}
fn account_navigation(state: &HumbleState, instance: &str, url: &tauri::Url) -> bool {
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() { return false; }
    if current_window(state, instance) {
        state.ready.store(false, Ordering::Release);
        if let Ok(mut login) = state.login.lock() { login.probing = None; }
        cancel_pending_auth(state);
    }
    true
}
fn set_auth_state(app: &tauri::AppHandle, state: &HumbleState, auth_state: AuthState) {
    if let Ok(mut library) = state.library.lock() { library.auth_state = auth_state; } else { return; }
    let _ = app.emit_to("main", "humble-session-status", auth_state.status());
}
fn valid_session_proof(operation: &str, payload: &Value) -> bool {
    operation == "sync" && payload.as_object().is_some_and(|object| object.len() == 2 && object.get("kind").and_then(Value::as_str) == Some("session") && object.get("authenticated").and_then(Value::as_bool) == Some(true))
}

fn snapshot(state: &HumbleState) -> Result<Status, String> {
    let mut library = state.library.lock().map_err(|_| error("service"))?;
    if !library.loaded {
        let bundles = crate::storage::load_library()?;
        validate_bundles(&bundles)?;
        library.bundles = bundles;
        library.loaded = true;
    }
    Ok(Status { connected: library.auth_state == AuthState::Authenticated, auth_state: library.auth_state, last_sync: library.last_sync.clone(), bundles: library.bundles.clone(), warning: library.warning.clone() })
}

fn safe_https(value: &str) -> bool {
    value.is_empty() || tauri::Url::parse(value).ok().is_some_and(|url| url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() && url.password().is_none())
}

fn valid_text(value: &str, limit: usize) -> bool { !value.is_empty() && value.len() <= limit && !value.chars().any(|c| c == '\0' || (c.is_control() && !matches!(c, '\r' | '\n' | '\t'))) }

fn validate_item(item: &KeyItem) -> Result<(), String> {
    if !valid_text(&item.id, 1024) || !valid_text(&item.title, 4000) || !valid_text(&item.platform, 640)
        || !["hidden", "revealed", "unavailable", "external"].contains(&item.status.as_str())
        || item.key.as_ref().is_some_and(|value| !valid_text(value, 262144))
        || (item.status == "revealed") != item.key.is_some()
        || item.instructions.as_ref().is_some_and(|value| value.len() > 48000 || value.contains('\0'))
        || item.redeem_url.as_ref().is_some_and(|url| url.len() > 8192 || !safe_https(url)) {
        return Err(error("protocol"));
    }
    Ok(())
}

fn validate_bundles(bundles: &[Bundle]) -> Result<(), String> {
    if bundles.len() > 10000 { return Err(error("protocol")); }
    let mut ids = std::collections::HashSet::new();
    let mut count = 0usize;
    for bundle in bundles {
        if bundle.id.is_empty() || bundle.id.len() > 256 || !bundle.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !ids.insert(&bundle.id) || !valid_text(&bundle.title, 4000) || bundle.image_url.len() > 8192 || !safe_https(&bundle.image_url)
            || bundle.purchased_at.as_ref().is_some_and(|date| date.len() > 400 || date.contains('\0')) {
            return Err(error("protocol"));
        }
        let mut item_ids = std::collections::HashSet::new();
        count += bundle.items.len();
        if count > 100000 { return Err(error("protocol")); }
        for item in &bundle.items {
            validate_item(item)?;
            if !item_ids.insert(&item.id) { return Err(error("protocol")); }
        }
    }
    Ok(())
}

fn ensure_window(app: &tauri::AppHandle, visible: bool) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        if visible {
            let state = app.state::<HumbleState>();
            state.ready.store(false, Ordering::Release);
            window.navigate(LOGIN_URL.parse().map_err(|_| error("window"))?).map_err(|_| error("window"))?;
            let _ = window.set_skip_taskbar(false); let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
        }
        return Ok(window);
    }
    let handle = app.clone();
    let events = app.clone();
    let instance = uuid::Uuid::new_v4().to_string();
    let navigation_instance = instance.clone(); let loaded_instance = instance.clone(); let destroyed_instance = instance.clone();
    let state = app.state::<HumbleState>();
    state.ready.store(false, Ordering::Release);
    *state.window_instance.lock().map_err(|_| error("service"))? = Some(instance.clone());
    let url = if visible { LOGIN_URL } else { "https://www.humblebundle.com/home/keys" };
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url.parse().map_err(|_| error("window"))?))
        .title(crate::locale::text("login"))
        .inner_size(1000.0, 760.0).min_inner_size(700.0, 540.0)
        .data_directory(profile()).additional_browser_args(BROWSER_ARGS)
        .visible(visible).skip_taskbar(!visible)
        .initialization_script(include_str!("humble_bundle_images.js"))
        .initialization_script(include_str!("humble_bridge.js"))
        // HTTPS identity-provider redirects remain usable; remote IPC is granted
        // separately and exclusively to the official Humble origin.
        .on_navigation(move |url| {
            let state = handle.state::<HumbleState>();
            account_navigation(&state, &navigation_instance, url)
        })
        .on_page_load(move |window, payload| {
            let state = window.app_handle().state::<HumbleState>();
            if payload.event() == tauri::webview::PageLoadEvent::Finished && official(payload.url()) && current_window(&state, &loaded_instance) {
                state.ready.store(true, Ordering::Release);
                schedule_auth_probe(window.app_handle().clone(), window.clone(), loaded_instance.clone(), None);
            }
        })
        .build().map_err(|_| {
            if current_window(&state, &instance) { if let Ok(mut current) = state.window_instance.lock() { *current = None; } }
            error("window")
        })?;
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let state = events.state::<HumbleState>();
            if !current_window(&state, &destroyed_instance) { return; }
            if let Ok(mut current) = state.window_instance.lock() { *current = None; }
            state.ready.store(false, Ordering::Release);
            let cancelled = state.login.lock().ok().and_then(|mut login| login.cancel());
            if let Some(attempt) = cancelled { let _ = events.emit_to("main", "humble-login-cancelled", attempt); }
            if let Ok(mut pending) = state.pending.lock() { if let Some(pending) = pending.take() { let _ = pending.sender.send(json!({"ok":false,"reason":"cancelled"})); } };
        }
    });
    Ok(window)
}

fn watch_auth_attempt(app: tauri::AppHandle, window: WebviewWindow, instance: String, attempt_id: String) {
    // Modern sign-in pages may commit their session without navigating. Observe
    // only an explicit attempt, using the same read-only proof as a page load.
    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::Instant::now() + AUTH_WATCH_TIMEOUT;
        loop {
            tokio::time::sleep(AUTH_WATCH_INTERVAL).await;
            let state = app.state::<HumbleState>();
            if tokio::time::Instant::now() >= deadline
                || !current_window(&state, &instance)
                || !state.login.lock().ok().is_some_and(|login| login.current.as_deref() == Some(attempt_id.as_str())) { return; }
            if state.ready.load(Ordering::Acquire) && window.url().ok().is_some_and(|url| official(&url)) {
                schedule_auth_probe(app.clone(), window.clone(), instance.clone(), Some(&attempt_id));
            }
        }
    });
}

fn schedule_auth_probe(app: tauri::AppHandle, window: WebviewWindow, instance: String, expected_attempt: Option<&str>) {
    let is_watcher = expected_attempt.is_some();
    let probe = {
        let state = app.state::<HumbleState>();
        if !current_window(&state, &instance) { return; }
        let next = state.login.lock().ok().and_then(|mut login| login.start_probe_for(expected_attempt));
        next
    };
    let Some(probe) = probe else { return; };
    // Page callbacks never construct WebView2 or block on an authenticated read.
    tauri::async_runtime::spawn(async move {
        let state = app.state::<HumbleState>();
        let Ok(_updating) = crate::app_updates::operation() else {
            if let Ok(mut login) = state.login.lock() { login.finish_probe(&probe); }
            return;
        };
        // A watcher must never queue behind a long sync/reveal and run later
        // as a stale poll. A future tick can try again while its attempt lives.
        let _guard = if is_watcher {
            match state.operation.try_lock() {
                Ok(guard) => guard,
                Err(_) => {
                    if let Ok(mut login) = state.login.lock() { login.finish_probe(&probe); }
                    return;
                }
            }
        } else {
            state.operation.lock().await
        };
        if !current_window(&state, &instance) || !state.login.lock().ok().is_some_and(|login| login.matches(&probe)) || !window.url().ok().is_some_and(|url| official(&url)) {
            if let Ok(mut login) = state.login.lock() { login.finish_probe(&probe); }
            return;
        }
        // Existing window only: a cancelled login can never recreate a window.
        let reply = request_existing(&window, &state, "auth", None, None).await;
        let verified = reply.as_ref().ok().is_some_and(|reply| reply.get("ok").and_then(Value::as_bool) == Some(true) && reply.get("authenticated").and_then(Value::as_bool) == Some(true));
        if !verified {
            if let Ok(mut login) = state.login.lock() {
                if login.matches(&probe) && current_window(&state, &instance) && reply.as_ref().ok().is_some_and(|reply| reply.get("reason").and_then(Value::as_str) == Some("auth")) {
                    set_auth_state(&app, &state, AuthState::Unauthenticated);
                }
                login.finish_probe(&probe);
            }
            return;
        }
        let main_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = main_app.state::<HumbleState>();
            if !current_window(&state, &instance) { return; }
            let completed = state.login.lock().ok().is_some_and(|mut login| login.complete(&probe));
            if !completed { return; }
            set_auth_state(&main_app, &state, AuthState::Authenticated);
            // Hiding preserves the same browser/bridge and never cancels a
            // sync or reveal that starts after the completion event.
            let _ = window.hide(); let _ = window.set_skip_taskbar(true);
            if let Some(main) = main_app.get_webview_window("main") { let _ = main.show(); let _ = main.unminimize(); let _ = main.set_focus(); }
            let _ = main_app.emit_to("main", "humble-login-completed", LoginAttempt { attempt_id: probe.attempt_id });
        });
    });
}

async fn request(app: &tauri::AppHandle, state: &HumbleState, operation: &str, bundle_id: Option<&str>, item_id: Option<&str>) -> Result<Value, String> {
    let window = ensure_window(app, false)?;
    if !window.url().ok().is_some_and(|url| official(&url)) {
        state.ready.store(false, Ordering::Release);
        window.navigate(format!("{ORIGIN}/home/keys").parse().map_err(|_| error("window"))?).map_err(|_| error("window"))?;
    }
    for _ in 0..300 {
        if state.cancelled.load(Ordering::Acquire) { return Err(error("cancelled")); }
        if state.ready.load(Ordering::Acquire) { break; }
        if app.get_webview_window(LABEL).is_none() { return Err(error("cancelled")); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !state.ready.load(Ordering::Acquire) { return Err(error("auth")); }
    if state.cancelled.load(Ordering::Acquire) { return Err(error("cancelled")); }
    request_existing(&window, state, operation, bundle_id, item_id).await
}

async fn request_existing(window: &WebviewWindow, state: &HumbleState, operation: &str, bundle_id: Option<&str>, item_id: Option<&str>) -> Result<Value, String> {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = state.pending.lock().map_err(|_| error("service"))?;
        if pending.is_some() { return Err(error("busy")); }
        *pending = Some(Pending { nonce: nonce.clone(), operation: operation.into(), sender });
    }
    let args = json!({ "nonce": nonce, "operation": operation, "bundleId": bundle_id, "itemId": item_id });
    let script = format!("window.__humbleLibraryRequest && window.__humbleLibraryRequest({args});");
    if window.eval(&script).is_err() {
        state.pending.lock().map_err(|_| error("service"))?.take();
        return Err(error("window"));
    }
    let seconds = if operation == "sync" { 1800 } else if operation == "auth" { 20 } else { 60 };
    let response = tokio::time::timeout(Duration::from_secs(seconds), receiver).await;
    if let Ok(mut pending) = state.pending.lock() { if pending.as_ref().is_some_and(|pending| pending.nonce == nonce) { pending.take(); } }
    let reply = match response {
        Ok(Ok(reply)) => reply,
        _ => { let _ = window.eval(&format!("window.__humbleLibraryCancel && window.__humbleLibraryCancel({});", serde_json::to_string(&nonce).unwrap_or_default())); return Err(error(if operation == "reveal" { "uncertain" } else { "network" })); }
    };
    // Probe consumers retain the closed reason to apply it only while the
    // corresponding explicit-login attempt/window is still current.
    if operation == "auth" { return Ok(reply); }
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        let reason = reply.get("reason").and_then(Value::as_str).unwrap_or("service");
        if reason == "auth" {
            set_auth_state(window.app_handle(), state, AuthState::Unauthenticated);
        }
        return Err(error(reason));
    }
    Ok(reply)
}

#[tauri::command]
pub fn humble_status(window: WebviewWindow, state: tauri::State<'_, HumbleState>) -> Result<Status, String> { main_only(&window)?; snapshot(&state) }

#[tauri::command]
pub async fn humble_login(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>) -> Result<LoginAttempt, String> {
    main_only(&window)?;
    let _operation = crate::app_updates::operation()?;
    let _guard = state.operation.try_lock().map_err(|_| error("busy"))?;
    let attempt = state.login.lock().map_err(|_| error("service"))?.begin();
    let account = match ensure_window(&app, true) {
        Ok(account) => account,
        Err(message) => {
            if let Ok(mut login) = state.login.lock() { if login.current.as_deref() == Some(attempt.attempt_id.as_str()) { login.cancel(); } }
            return Err(message);
        }
    };
    if let Some(instance) = state.window_instance.lock().ok().and_then(|instance| instance.clone()) {
        watch_auth_attempt(app.clone(), account, instance, attempt.attempt_id.clone());
    }
    Ok(attempt)
}

#[tauri::command]
pub async fn humble_sync(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>) -> Result<Status, String> {
    main_only(&window)?;
    let _operation = crate::app_updates::operation()?;
    let _guard = state.operation.try_lock().map_err(|_| error("busy"))?;
    state.cancelled.store(false, Ordering::Release);
    let reply = request(&app, &state, "sync", None, None).await?;
    let bundles: Vec<Bundle> = serde_json::from_value(reply.get("bundles").cloned().ok_or_else(|| error("protocol"))?).map_err(|_| error("protocol"))?;
    validate_bundles(&bundles)?;
    let timestamp = reply.get("syncedAt").and_then(Value::as_str).filter(|stamp| stamp.len() <= 100).map(str::to_owned);
    let save = crate::storage::save_library(&bundles);
    {
        let mut library = state.library.lock().map_err(|_| error("service"))?;
        library.loaded = true;
        library.auth_state = AuthState::Authenticated;
        library.bundles = bundles;
        library.last_sync = timestamp;
        library.warning = save.err().map(|_| "Библиотека обновлена, но сохранить её на диске не удалось.".into());
    }
    let result = snapshot(&state)?;
    if let Some(warning) = &result.warning { let _ = app.emit_to("main", "humble-warning", warning); }
    Ok(result)
}

#[tauri::command]
pub async fn humble_reveal(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>, bundle_id: String, item_id: String) -> Result<KeyItem, String> {
    main_only(&window)?;
    let _operation = crate::app_updates::operation()?;
    let _guard = state.operation.try_lock().map_err(|_| error("busy"))?;
    state.cancelled.store(false, Ordering::Release);
    let before = snapshot(&state)?;
    let old = before.bundles.iter().find(|bundle| bundle.id == bundle_id).and_then(|bundle| bundle.items.iter().find(|item| item.id == item_id)).ok_or_else(|| error("notFound"))?;
    if old.key.is_some() { return Ok(old.clone()); }
    if old.status != "hidden" { return Err(error(if old.status == "unavailable" { "unavailable" } else { "external" })); }
    let reply = request(&app, &state, "reveal", Some(&bundle_id), Some(&item_id)).await?;
    let item: KeyItem = serde_json::from_value(reply.get("item").cloned().ok_or_else(|| error("protocol"))?).map_err(|_| error("protocol"))?;
    validate_item(&item)?;
    if item.id != item_id || item.title != old.title || item.platform != old.platform || !["revealed", "unavailable"].contains(&item.status.as_str()) { return Err(error("protocol")); }
    {
        let mut library = state.library.lock().map_err(|_| error("service"))?;
        let slot = library.bundles.iter_mut().find(|bundle| bundle.id == bundle_id).and_then(|bundle| bundle.items.iter_mut().find(|entry| entry.id == item_id)).ok_or_else(|| error("notFound"))?;
        *slot = item.clone();
        library.auth_state = AuthState::Authenticated;
        library.warning = crate::storage::save_library(&library.bundles).err().map(|_| "Данные товара обновлены, но сохранить библиотеку на диске не удалось. Скопируйте доступный ключ или экспортируйте его.".into());
        if let Some(warning) = &library.warning { let _ = app.emit_to("main", "humble-warning", warning); }
    }
    set_auth_state(&app, &state, AuthState::Authenticated);
    Ok(item)
}

#[tauri::command]
pub fn humble_cancel(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>) -> Result<(), String> {
    main_only(&window)?;
    state.cancelled.store(true, Ordering::Release);
    let pending = state.pending.lock().map_err(|_| error("service"))?.take();
    if let Some(pending) = pending {
        if let Some(web) = app.get_webview_window(LABEL) {
            let nonce = serde_json::to_string(&pending.nonce).map_err(|_| error("service"))?;
            let _ = web.eval(&format!("window.__humbleLibraryCancel && window.__humbleLibraryCancel({nonce});"));
        }
        let _ = pending.sender.send(json!({"ok": false, "reason": "cancelled"}));
    }
    Ok(())
}

#[tauri::command]
pub async fn humble_logout(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>) -> Result<(), String> {
    main_only(&window)?;
    let _operation = crate::app_updates::operation()?;
    let _guard = state.operation.try_lock().map_err(|_| error("busy"))?;
    let web = ensure_window(&app, false)?;
    let cookies = web.cookies().map_err(|_| error("service"))?;
    for cookie in cookies { web.delete_cookie(cookie).map_err(|_| error("service"))?; }
    let _ = web.eval("try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}");
    let _ = web.destroy();
    state.ready.store(false, Ordering::Release);
    *state.library.lock().map_err(|_| error("service"))? = Library { loaded: true, auth_state: AuthState::Unauthenticated, ..Library::default() };
    set_auth_state(&app, &state, AuthState::Unauthenticated);
    // The in-memory logout is effective even when an independent disk error occurs.
    crate::storage::save_library(&[])
}

#[tauri::command]
pub fn humble_bridge_result(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>, nonce: String, payload: Value) -> Result<(), String> {
    if window.label() != LABEL || !window.url().ok().is_some_and(|url| official(&url)) || nonce.len() != 32 { return Err(error("service")); }
    if serde_json::to_vec(&payload).map_err(|_| error("protocol"))?.len() > MAX_PAYLOAD { return Err(error("protocol")); }
    let mut slot = state.pending.lock().map_err(|_| error("service"))?;
    let pending = slot.as_ref().filter(|pending| pending.nonce == nonce).ok_or_else(|| error("service"))?;
    if payload.get("kind").and_then(Value::as_str) == Some("session") {
        if !valid_session_proof(&pending.operation, &payload) { return Err(error("protocol")); }
        set_auth_state(&app, &state, AuthState::Authenticated);
        return Ok(());
    }
    if payload.get("kind").and_then(Value::as_str) == Some("progress") {
        if pending.operation != "sync" { return Err(error("protocol")); }
        let completed = payload.get("completed").and_then(Value::as_u64).ok_or_else(|| error("protocol"))?;
        let total = payload.get("total").and_then(Value::as_u64).ok_or_else(|| error("protocol"))?;
        if completed > total || total > 10000 { return Err(error("protocol")); }
        let _ = app.emit_to("main", "humble-progress", json!({"completed":completed,"total":total}));
        return Ok(());
    }
    if payload.get("kind").and_then(Value::as_str) != Some("result") { return Err(error("protocol")); }
    if pending.operation == "auth" && payload.get("ok").and_then(Value::as_bool) == Some(true) {
        let valid = payload.as_object().is_some_and(|object| object.len() == 3 && object.contains_key("kind") && object.contains_key("ok") && object.get("authenticated").and_then(Value::as_bool) == Some(true));
        if !valid { return Err(error("protocol")); }
    }
    if let Some(pending) = slot.take() { let _ = pending.sender.send(payload); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn session_defaults_unknown_and_connected_has_one_source_of_truth() {
        assert_eq!(Library::default().auth_state,AuthState::Unknown);
        for (auth_state,connected,name) in [(AuthState::Unknown,false,"unknown"),(AuthState::Authenticated,true,"authenticated"),(AuthState::Unauthenticated,false,"unauthenticated")] {
            let status=auth_state.status(); assert_eq!(status.connected,connected); let value=serde_json::to_value(status).unwrap(); assert_eq!(value["authState"],name); assert_eq!(value["connected"],connected);
        }
    }
    #[test] fn early_session_metadata_is_sync_only_and_contains_no_account_data() {
        let proof=json!({"kind":"session","authenticated":true}); assert!(valid_session_proof("sync",&proof));
        for operation in ["auth","reveal",""] { assert!(!valid_session_proof(operation,&proof)); }
        for proof in [json!({"kind":"session","authenticated":false}),json!({"kind":"session","authenticated":true,"orders":[]}),json!({"kind":"progress","authenticated":true}),json!({"kind":"session"})] { assert!(!valid_session_proof("sync",&proof)); }
    }
    #[test] fn auth_attempt_single_probe_and_completion_once() {
        let mut login=LoginLifecycle::default(); assert!(login.start_probe().is_none());
        let attempt=login.begin(); let probe=login.start_probe().unwrap(); assert_eq!(probe.attempt_id,attempt.attempt_id); assert!(login.start_probe().is_none());
        assert!(login.complete(&probe)); assert!(!login.complete(&probe)); assert!(login.cancel().is_none()); assert!(login.start_probe().is_none());
    }
    #[test] fn cancelled_or_late_auth_cannot_complete_reopened_login() {
        let mut login=LoginLifecycle::default(); let old=login.begin(); let stale=login.start_probe().unwrap(); assert_eq!(login.cancel().unwrap().attempt_id,old.attempt_id);
        let new=login.begin(); let active=login.start_probe().unwrap(); assert_ne!(old.attempt_id,new.attempt_id); assert!(!login.complete(&stale)); login.finish_probe(&stale); assert!(login.matches(&active)); assert!(login.complete(&active));
    }
    #[test] fn auth_watcher_is_bound_to_one_attempt_and_never_queues_parallel_probes() {
        let mut login = LoginLifecycle::default();
        let old = login.begin(); let current = login.begin();
        assert!(login.start_probe_for(Some(&old.attempt_id)).is_none());
        let first = login.start_probe_for(Some(&current.attempt_id)).unwrap();
        assert!(login.start_probe_for(Some(&current.attempt_id)).is_none());
        login.finish_probe(&first);
        // A failed initial read can be followed by a fresh proof without a
        // document navigation (e.g. an AJAX login or delayed cookie commit).
        let later = login.start_probe_for(Some(&current.attempt_id)).unwrap();
        assert_ne!(first.probe_id, later.probe_id);
        assert!(!login.complete(&first)); assert!(login.complete(&later));
        assert!(login.start_probe_for(Some(&current.attempt_id)).is_none());
        let cancelled = login.begin(); login.cancel();
        assert!(login.start_probe_for(Some(&cancelled.attempt_id)).is_none());
    }
    #[test] fn rejected_account_navigation_preserves_ready_page_and_pending_authentication() {
        let state = HumbleState::default();
        *state.window_instance.lock().unwrap() = Some("instance".into());
        state.ready.store(true, Ordering::Release);
        let attempt = state.login.lock().unwrap().begin();
        let probe = state.login.lock().unwrap().start_probe_for(Some(&attempt.attempt_id)).unwrap();
        let (sender, mut receiver) = oneshot::channel();
        *state.pending.lock().unwrap() = Some(Pending { nonce: "synthetic".into(), operation: "auth".into(), sender });
        for url in ["mailto:help@example.test", "about:blank", "http://www.humblebundle.com/", "https://u:p@example.test/"] {
            assert!(!account_navigation(&state, "instance", &url.parse().unwrap()));
            assert!(state.ready.load(Ordering::Acquire));
            assert!(state.login.lock().unwrap().matches(&probe));
            assert!(state.pending.lock().unwrap().is_some());
        }
        assert!(account_navigation(&state, "instance", &"https://identity.example.test/signin".parse().unwrap()));
        assert!(!state.ready.load(Ordering::Acquire));
        assert!(!state.login.lock().unwrap().matches(&probe));
        assert!(state.pending.lock().unwrap().is_none());
        assert_eq!(receiver.try_recv().unwrap(), json!({"ok":false,"reason":"cancelled"}));
        assert_eq!(state.login.lock().unwrap().current.as_deref(), Some(attempt.attempt_id.as_str()));
    }
    #[test] fn navigation_invalidates_old_probe_even_in_same_attempt() {
        let mut login=LoginLifecycle::default(); login.begin(); let old=login.start_probe().unwrap(); login.probing=None; let new=login.start_probe().unwrap(); assert_eq!(old.attempt_id,new.attempt_id); assert_ne!(old.probe_id,new.probe_id);
        login.finish_probe(&old); assert!(!login.complete(&old)); assert!(login.matches(&new)); assert!(login.complete(&new));
    }
    #[test] fn old_window_instance_cannot_match_new_window() {
        let state=HumbleState::default(); *state.window_instance.lock().unwrap()=Some("new-instance".into()); assert!(!current_window(&state,"old-instance")); assert!(current_window(&state,"new-instance"));
    }
    fn bundle() -> Bundle { Bundle { id: "order_fixture_1".into(), title: "Mixed bundle".into(), image_url: "https://cdn.humblebundle.com/cover.png".into(), purchased_at: None, items: vec![KeyItem { id: "a:0:steam".into(), title: "Game".into(), platform: "Steam".into(), key: Some("TEST-ONLY-KEY".into()), status: "revealed".into(), instructions: None, redeem_url: None }] } }
    #[test] fn origin_is_exact() { for url in ["https://www.humblebundle.com/home/keys", "https://www.humblebundle.com:443/home"] { assert!(official(&url.parse().unwrap())); } for url in ["https://www.humblebundle.com.evil.test/", "http://www.humblebundle.com/", "https://humblebundle.com/", "https://www.humblebundle.com:444/", "https://u:p@www.humblebundle.com/"] { assert!(!official(&url.parse().unwrap())); } }
    #[test] fn platforms_are_not_whitelisted() { for platform in ["Steam", "GOG", "Unity Asset Store", "Unknown vendor", "Издатель"] { let mut b = bundle(); b.items[0].platform = platform.into(); assert!(validate_bundles(&[b]).is_ok()); } }
    #[test] fn key_contents_are_not_steam_shaped() { for key in ["aB-cD", "license@example.test", "12345678901234567890", "https://vendor.test/redeem?token=fixture", "{\"code\":\"fixture\",\"password\":\"fixture\"}"] { let mut b=bundle(); b.items[0].key=Some(key.into()); assert!(validate_bundles(&[b]).is_ok()); } }
    #[test] fn hidden_never_claims_to_have_key() { let mut b=bundle(); b.items[0].status="hidden".into(); assert!(validate_bundles(&[b.clone()]).is_err()); b.items[0].key=None; assert!(validate_bundles(&[b]).is_ok()); }
    #[test] fn duplicates_and_hostile_metadata_rejected() { let b=bundle(); assert!(validate_bundles(&[b.clone(),b.clone()]).is_err()); let mut c=b.clone(); c.items.push(c.items[0].clone()); assert!(validate_bundles(&[c]).is_err()); let mut c=b.clone(); c.image_url="javascript:alert(1)".into(); assert!(validate_bundles(&[c]).is_err()); let mut c=b; c.items[0].redeem_url=Some("https://u:p@example.test/".into()); assert!(validate_bundles(&[c]).is_err()); }
    #[test] fn secret_service_text_is_not_an_error_message() { let secret="PRIVATE-KEY-FIXTURE"; assert!(!error(secret).contains(secret)); }
}
