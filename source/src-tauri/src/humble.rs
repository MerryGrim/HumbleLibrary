use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

const LABEL: &str = "humble-account";
// Humble creates a fresh flow when the official sign-in form is opened.
// Never retain a flow identifier from an earlier sign-in attempt.
const LOGIN_URL: &str = "https://auth.humblebundle.com/login";
const LIBRARY_URL: &str = "https://www.humblebundle.com/home/library";
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
    #[serde(default)] pub details_failed: bool,
    #[serde(default)] pub source_url: Option<String>,
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
    pub enumeration_complete: Option<bool>,
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
    account_key: Option<String>,
    enumeration_complete: Option<bool>,
    source_projection:Option<crate::storage::SourceProjection>,
    retained_licenses:Vec<crate::storage::RetainedLicense>,
}
struct Pending { nonce: String, operation: String, sender: oneshot::Sender<Value>, last_activity: tokio::time::Instant }
impl Pending { fn new(nonce:String,operation:String,sender:oneshot::Sender<Value>)->Self{Self{nonce,operation,sender,last_activity:tokio::time::Instant::now()}} }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginAttempt { pub attempt_id: String }
#[derive(Clone, Debug)]
struct AuthProbe { attempt_id: String, probe_id: String }
#[derive(Default)]
struct LoginLifecycle { current: Option<String>, probing: Option<String>, landing_requested: bool }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthLocation { Wait, NavigateLibrary, Ready }
impl LoginLifecycle {
    fn begin(&mut self) -> LoginAttempt {
        let attempt_id = uuid::Uuid::new_v4().to_string();
        self.current = Some(attempt_id.clone()); self.probing = None; self.landing_requested = false;
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
    fn auth_location(&mut self, probe: &AuthProbe, url: &tauri::Url) -> AuthLocation {
        if !self.matches(probe) || !official(url) { return AuthLocation::Wait; }
        if library_page(url) {
            self.landing_requested = true;
            return AuthLocation::Ready;
        }
        if !matches!(url.path(), "/" | "/home" | "/home/" | "/home/keys" | "/home/purchases") {
            return AuthLocation::Wait;
        }
        if self.landing_requested { return AuthLocation::Wait; }
        self.landing_requested = true;
        AuthLocation::NavigateLibrary
    }
    fn finish_probe(&mut self, probe: &AuthProbe) { if self.matches(probe) { self.probing = None; } }
    fn complete(&mut self, probe: &AuthProbe) -> bool {
        if !self.matches(probe) { return false; }
        self.current = None; self.probing = None; self.landing_requested = false; true
    }
    fn cancel(&mut self) -> Option<LoginAttempt> { self.probing = None; self.landing_requested = false; self.current.take().map(|attempt_id| LoginAttempt { attempt_id }) }
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
    modern_binding_verified: AtomicBool,
    maintenance: AtomicBool,
    maintenance_ready: AtomicBool,
    // An interrupted native purge must not overlap a new login/update. This
    // guard deliberately survives until restart if completion is uncertain.
    maintenance_update_guard: Mutex<Option<crate::app_updates::Operation>>,
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
    url.scheme() == "https" && matches!(url.host_str(), Some("www.humblebundle.com" | "humblebundle.com"))
        && url.port_or_known_default() == Some(443) && url.username().is_empty() && url.password().is_none()
}

fn library_page(url: &tauri::Url) -> bool {
    official(url) && (url.path() == "/home/library" || url.path().starts_with("/home/library/"))
}

fn profile() -> std::path::PathBuf { crate::storage::root().join("Account").join("humble-web") }
fn current_window(state: &HumbleState, token: &str) -> bool { state.window_instance.lock().ok().is_some_and(|value| value.as_deref() == Some(token)) }
fn trace_page(url: &tauri::Url) {
    use crate::auth_trace::{self, Stage};
    let stage = if official(url) {
        if url.host_str() == Some("www.humblebundle.com") { Stage::StorefrontWww } else { Stage::StorefrontApex }
    } else if url.scheme() == "https" && url.host_str() == Some("auth.humblebundle.com") {
        Stage::IdentityProvider
    } else { Stage::OtherPage };
    auth_trace::record(stage, None, None, None);
}
fn trace_reason(reason: &str) -> crate::auth_trace::Code {
    use crate::auth_trace::Code;
    match reason {
        "auth" => Code::AuthRejected,
        "rateLimited" => Code::RateLimited,
        "network" => Code::Network,
        "protocol" => Code::Protocol,
        "cancelled" => Code::Cancelled,
        "AUTH_WRONG_ORIGIN" => Code::WrongOrigin,
        "AUTH_BRIDGE_MISSING" => Code::MissingBridge,
        "AUTH_IPC_MISSING" => Code::MissingTransport,
        "AUTH_SCRIPT_ERROR" => Code::ScriptError,
        "AUTH_SCRIPT_TIMEOUT" => Code::ScriptTimeout,
        "AUTH_REPLY_TIMEOUT" => Code::ReplyTimeout,
        _ => Code::Service,
    }
}
fn sync_failure_diagnostic(operation: &str, payload: &Value) -> Option<(crate::auth_trace::Stage, crate::auth_trace::Code, Option<u16>)> {
    if operation != "sync" || payload.get("kind").and_then(Value::as_str) != Some("result")
        || payload.get("ok").and_then(Value::as_bool) != Some(false) { return None; }
    let stage = crate::auth_trace::sync_failure_stage(payload.get("phase")?.as_str()?)?;
    let code = payload.get("protocolCode").and_then(Value::as_str).and_then(crate::auth_trace::protocol_code)
        .unwrap_or_else(|| trace_reason(payload.get("reason").and_then(Value::as_str).unwrap_or("service")));
    let status = payload.get("httpStatus").and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok()).filter(|status| (100..=599).contains(status));
    Some((stage, code, status))
}
fn sync_failure_context(operation: &str, payload: &Value) -> Option<crate::auth_trace::SyncFailureContext> {
    let (stage, _, _) = sync_failure_diagnostic(operation, payload)?;
    let count = |name: &str| -> Result<Option<u64>, ()> {
        match payload.get(name) { None => Ok(None), Some(value) => value.as_u64().map(Some).ok_or(()) }
    };
    if crate::auth_trace::purchased_phase(stage) {
        crate::auth_trace::SyncFailureContext::new(count("requestedPage").ok()?, count("pageRows").ok()?, count("overlapRows").ok()?)
    } else if crate::auth_trace::detail_phase(stage) {
        crate::auth_trace::SyncFailureContext::new_detail(count("detailComponentsCount").ok()?, count("completedDetails").ok()?, count("totalDetails").ok()?)
    } else { None }
}
fn detail_warning_diagnostic(operation: &str, payload: &Value) -> Option<(crate::auth_trace::Stage, crate::auth_trace::Code, Option<u16>, Option<crate::auth_trace::SyncFailureContext>)> {
    let object = payload.as_object()?;
    if operation != "sync" || object.get("kind").and_then(Value::as_str) != Some("detailWarning")
        || object.get("ok").is_some_and(|value| value.as_bool() != Some(false))
        || object.keys().any(|key| !["kind","ok","reason","phase","httpStatus","protocolCode","detailComponentsCount","completedDetails","totalDetails"].contains(&key.as_str())) { return None; }
    let stage = crate::auth_trace::sync_failure_stage(object.get("phase")?.as_str()?)?;
    if !crate::auth_trace::detail_phase(stage) { return None; }
    let status = match object.get("httpStatus") {
        None => None,
        Some(value) => Some(value.as_u64().and_then(|value| u16::try_from(value).ok()).filter(|value| (100..=599).contains(value))?),
    };
    let reason = object.get("reason")?.as_str()?;
    if reason != "protocol" && !(reason == "service" && status == Some(404)) { return None; }
    let code = match object.get("protocolCode") {
        None => trace_reason(reason),
        Some(value) => crate::auth_trace::protocol_code(value.as_str()?)?,
    };
    let mut normalized = payload.clone();
    normalized["kind"] = json!("result"); normalized["ok"] = json!(false);
    let context = sync_failure_context("sync", &normalized);
    if ["detailComponentsCount","completedDetails","totalDetails"].iter().any(|key| object.contains_key(*key)) && context.is_none() { return None; }
    Some((stage,code,status,context))
}
fn sync_progress_payload(operation: &str, payload: &Value) -> Result<Value, String> {
    if operation != "sync" || payload.get("kind").and_then(Value::as_str) != Some("progress") { return Err(error("protocol")); }
    let completed=payload.get("completed").and_then(Value::as_u64).ok_or_else(|| error("protocol"))?;
    let total=payload.get("total").and_then(Value::as_u64).ok_or_else(|| error("protocol"))?;
    if completed > total || total > 10000 { return Err(error("protocol")); }
    let mut result=json!({"completed":completed,"total":total});
    if let Some(stage)=payload.get("stage") {
        if !matches!(stage.as_str(),Some("purchases"|"keys")) { return Err(error("protocol")); }
        result["stage"]=stage.clone();
    }
    Ok(result)
}
fn sync_warning_diagnostic(operation:&str,payload:&Value)->Option<(crate::auth_trace::Stage,crate::auth_trace::Code,Option<u16>,Option<crate::auth_trace::SyncFailureContext>)>{
    let object=payload.as_object()?;
    if operation!="sync"||object.get("kind").and_then(Value::as_str)!=Some("syncWarning")||object.keys().any(|key|!["kind","phase","reason","protocolCode","httpStatus","requestedPage","detailComponentsCount","completedDetails","totalDetails"].contains(&key.as_str())){return None}
    let stage=crate::auth_trace::sync_failure_stage(object.get("phase")?.as_str()?)?;
    let reason=object.get("reason")?.as_str()?;
    if !["auth","cancelled","network","rateLimited","service","protocol"].contains(&reason){return None}
    let code=match object.get("protocolCode"){None=>trace_reason(reason),Some(value)=>crate::auth_trace::protocol_code(value.as_str()?)?};
    let status=match object.get("httpStatus"){None=>None,Some(value)=>Some(value.as_u64().and_then(|value|u16::try_from(value).ok()).filter(|value|(100..=599).contains(value))?)};
    if object.get("requestedPage").is_some_and(|value|!value.as_u64().is_some_and(|value|(1..=2000).contains(&value))){return None}
    if object.contains_key("requestedPage")&&!crate::auth_trace::purchased_phase(stage){return None}
    let detail_fields=["detailComponentsCount","completedDetails","totalDetails"].iter().any(|key|object.contains_key(*key));
    let context=if crate::auth_trace::purchased_phase(stage){
        if detail_fields{return None}crate::auth_trace::SyncFailureContext::new(object.get("requestedPage").and_then(Value::as_u64),None,None)
    }else if crate::auth_trace::detail_phase(stage){
        let count=|name:&str|match object.get(name){None=>Some(None),Some(value)=>value.as_u64().map(Some)};
        let context=crate::auth_trace::SyncFailureContext::new_detail(count("detailComponentsCount")?,count("completedDetails")?,count("totalDetails")?);if detail_fields&&context.is_none(){return None}context
    }else{if detail_fields{return None}None};
    Some((stage,code,status,context))
}
fn sync_activity_payload(operation:&str,payload:&Value)->Option<Value>{
    let object=payload.as_object()?;
    if operation!="sync"||object.get("kind").and_then(Value::as_str)!=Some("syncActivity")||object.keys().any(|key|!["kind","phase","state","attempt","delayMs","reason"].contains(&key.as_str())){return None}
    let phase=object.get("phase")?.as_str()?;crate::auth_trace::sync_failure_stage(phase)?;
    let state=object.get("state")?.as_str()?;let attempt=object.get("attempt")?.as_u64()?;let delay=object.get("delayMs")?.as_u64()?;
    if !(1..=4).contains(&attempt)||delay>60000{return None}
    let reason=object.get("reason");
    match state{"reading" if delay==0&&reason.is_none()=>{},"waiting" if reason.is_none()||reason.and_then(Value::as_str).is_some_and(|reason|["network","rateLimited","service"].contains(&reason))=>{},_=>return None}
    let mut output=json!({"phase":phase,"state":state,"attempt":attempt,"delayMs":delay});if let Some(reason)=reason{output["reason"]=reason.clone()}Some(output)
}
fn cancel_pending_auth(state: &HumbleState) {
    if let Ok(mut pending) = state.pending.lock() {
        if pending.as_ref().is_some_and(|pending| pending.operation == "auth") {
            if let Some(pending) = pending.take() { let _ = pending.sender.send(json!({"ok":false,"reason":"cancelled"})); }
        }
    }
}
fn account_navigation(state: &HumbleState, instance: &str, url: &tauri::Url) -> bool {
    if state.maintenance.load(Ordering::Acquire) {
        return url.as_str() == "about:blank";
    }
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() { return false; }
    if current_window(state, instance) {
        trace_page(url);
        state.ready.store(false, Ordering::Release);
        if let Ok(mut login) = state.login.lock() { login.probing = None; }
        cancel_pending_auth(state);
    }
    true
}
fn set_auth_state(app: &tauri::AppHandle, state: &HumbleState, auth_state: AuthState) {
    if auth_state!=AuthState::Authenticated{state.modern_binding_verified.store(false,Ordering::Release);}
    if let Ok(mut library) = state.library.lock() { library.auth_state = auth_state; } else { return; }
    let _ = app.emit_to("main", "humble-session-status", auth_state.status());
}
fn valid_session_proof(operation: &str, payload: &Value) -> bool {
    operation == "sync" && payload.as_object().is_some_and(|object| object.len() == 2 && object.get("kind").and_then(Value::as_str) == Some("session") && object.get("authenticated").and_then(Value::as_bool) == Some(true))
}

fn snapshot(state: &HumbleState) -> Result<Status, String> {
    let mut library = state.library.lock().map_err(|_| error("service"))?;
    if !library.loaded {
        let stored = crate::storage::load_snapshot()?;
        validate_bundles(&stored.bundles)?;
        if stored.source_projection.is_some(){validate_parent_bundles(&stored.bundles)?}
        library.bundles = stored.bundles;
        library.account_key = stored.account_key;
        library.enumeration_complete = stored.enumeration_complete;
        library.last_sync = stored.last_sync;
        library.source_projection = stored.source_projection;
        library.retained_licenses = stored.retained_licenses;
        library.loaded = true;
    }
    Ok(library_status(&library))
}
fn old_modern_projection(library:&Library)->bool{library.account_key.is_some()&&library.source_projection!=Some(crate::storage::SourceProjection::BundlesV1)}
fn library_status(library:&Library)->Status{let migrating=old_modern_projection(library);Status{connected:library.auth_state==AuthState::Authenticated,auth_state:library.auth_state,last_sync:library.last_sync.clone(),bundles:library.bundles.iter().filter(|bundle|!migrating||bundle.id.starts_with("bundle-")).cloned().collect(),warning:library.warning.clone().or_else(||library_incomplete_warning(library)),enumeration_complete:if migrating{None}else{library.enumeration_complete}}}
fn library_incomplete_warning(library:&Library)->Option<String>{
    if old_modern_projection(library){return Some("Обновите библиотеку, чтобы загрузить покупки из Humble Bundle.".into())}
    if library.enumeration_complete==Some(false)&&(library.account_key.is_some()||!library.bundles.is_empty()){Some("Список покупок загружен не полностью. Доступные бандлы сохранены; обновите библиотеку, чтобы продолжить.".into())}else{partial_details_warning(&library.bundles)}
}
fn library_snapshot(library:&Library)->crate::storage::LibrarySnapshot{crate::storage::LibrarySnapshot{bundles:library.bundles.clone(),account_key:library.account_key.clone(),enumeration_complete:library.enumeration_complete,last_sync:library.last_sync.clone(),source_projection:library.source_projection,retained_licenses:library.retained_licenses.clone()}}

fn partial_details_warning(bundles: &[Bundle]) -> Option<String> {
    bundles.iter().any(|bundle| bundle.details_failed).then(|| "Не все бандлы удалось обновить. Ранее сохранённые ключи оставлены в библиотеке.".into())
}

fn safe_source_url(value: &str) -> bool {
    if value.len() > 8192 { return false; }
    let Ok(url) = tauri::Url::parse(value) else { return false; };
    if !official(&url) || url.query().is_some() || url.fragment().is_some() || url.as_str() != value { return false; }
    if url.path() == "/home/library" { return true; }
    let Some(tail) = url.path().strip_prefix("/home/library/") else { return false; };
    let parts: Vec<_> = tail.split('/').collect();
    let id = match parts.as_slice() { [id] => *id, ["content" | "group", id] => *id, _ => return false };
    !id.is_empty() && id.len() <= 256 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte,b'_'|b'-'))
}

fn merge_failed_details(mut bundles: Vec<Bundle>, previous: &[Bundle]) -> Result<Vec<Bundle>, String> {
    validate_bundles(&bundles)?;
    let cached: std::collections::HashMap<_,_> = previous.iter().map(|bundle| (bundle.id.as_str(),bundle)).collect();
    for bundle in &mut bundles {
        if !bundle.details_failed { continue; }
        // A failed detail contributes owned metadata only. Retain keys solely
        // from the same previously validated bundle identity.
        if !bundle.items.is_empty() { return Err(error("protocol")); }
        if let Some(before) = cached.get(bundle.id.as_str()) { bundle.items = before.items.clone(); }
    }
    validate_bundles(&bundles)?;
    Ok(bundles)
}
struct SyncResult { bundles:Vec<Bundle>, account_key:Option<String>, enumeration_complete:bool, timestamp:Option<String>, source_projection:Option<crate::storage::SourceProjection> }
fn decode_sync_result(reply:&Value)->Result<SyncResult,String>{
    let enumeration_complete=reply.get("enumerationComplete").and_then(Value::as_bool).ok_or_else(||error("protocol"))?;
    let account_key=match reply.get("sourceProtocol").and_then(Value::as_str){
        Some("modern") if reply.get("sourceProjection").and_then(Value::as_str)==Some("bundles-v1")&&reply.get("parentIndexComplete").and_then(Value::as_bool)==Some(true)=>Some(reply.get("accountKey").and_then(Value::as_str).filter(|key|crate::storage::valid_account_key(key)).ok_or_else(||error("protocol"))?.to_owned()),
        Some("legacy") if enumeration_complete&&reply.get("accountKey").is_none()&&reply.get("sourceProjection").is_none()&&reply.get("parentIndexComplete").is_none()=>None,
        _=>return Err(error("protocol")),
    };
    let timestamp=match reply.get("syncedAt"){None|Some(Value::Null)=>None,Some(Value::String(stamp))if stamp.len()<=100&&!stamp.contains('\0')=>Some(stamp.clone()),_=>return Err(error("protocol"))};
    let bundles:Vec<Bundle>=serde_json::from_value(reply.get("bundles").cloned().ok_or_else(||error("protocol"))?).map_err(|_|error("protocol"))?;
    let source_projection=account_key.as_ref().map(|_|crate::storage::SourceProjection::BundlesV1);
    if source_projection.is_some(){validate_parent_bundles(&bundles)?}
    Ok(SyncResult{bundles,account_key,enumeration_complete,timestamp,source_projection})
}
fn parent_bundle(bundle:&Bundle)->bool{
    let Some(id)=bundle.id.strip_prefix("bundle-").filter(|id|!id.is_empty()&&id.bytes().all(|byte|byte.is_ascii_alphanumeric()||matches!(byte,b'_'|b'-')))else{return false};
    bundle.source_url.as_ref().is_some_and(|value|safe_source_url(value)&&tauri::Url::parse(value).is_ok_and(|url|url.path()==format!("/home/library/{id}")))
}
fn validate_parent_bundles(bundles:&[Bundle])->Result<(),String>{validate_bundles(bundles)?;if bundles.iter().all(parent_bundle){Ok(())}else{Err(error("protocol"))}}
fn retained_licenses(previous:&crate::storage::LibrarySnapshot)->Result<Vec<crate::storage::RetainedLicense>,String>{
    let mut values:std::collections::BTreeSet<_>=previous.retained_licenses.iter().cloned().collect();
    for bundle in &previous.bundles{
        let parent_id=parent_bundle(bundle).then(||bundle.id.clone());
        for item in &bundle.items{if let Some(key)=&item.key{values.insert(crate::storage::RetainedLicense{id:item.id.clone(),key:key.clone(),parent_id:parent_id.clone()});}}
    }
    let values:Vec<_>=values.into_iter().collect();if !crate::storage::valid_retained_licenses(&values){return Err(error("protocol"))}Ok(values)
}
fn restore_retained_licenses(bundles:&mut[Bundle],licenses:&[crate::storage::RetainedLicense]){
    let mut candidates:std::collections::HashMap<(&str,&str),Option<&str>>=std::collections::HashMap::new();
    // Older flat-product caches and schema-3 pools do not establish a parent.
    // Preserve those codes privately; a shared entitlement ID cannot bind them
    // to a newly discovered bundle purchase.
    for license in licenses{
        let Some(parent)=license.parent_id.as_deref()else{continue};
        candidates.entry((parent,&license.id)).and_modify(|key|{if *key!=Some(license.key.as_str()){*key=None}}).or_insert(Some(&license.key));
    }
    for bundle in bundles.iter_mut().filter(|bundle|!bundle.details_failed){
        for item in &mut bundle.items{
            if item.key.is_none(){if let Some(Some(key))=candidates.get(&(bundle.id.as_str(),item.id.as_str())){item.key=Some((*key).to_owned());item.status="revealed".into();}}
        }
    }
}
fn apply_sync_result<F>(library:&mut Library,result:SyncResult,cancelled:&AtomicBool,persist:F)->Result<Status,String>
where F:FnOnce(&crate::storage::LibrarySnapshot,Option<&crate::storage::LibrarySnapshot>)->Result<(),String>{
    let previous=library_snapshot(library);
    let same_account=result.account_key.is_some()&&result.account_key==library.account_key;
    let grouped=result.source_projection==Some(crate::storage::SourceProjection::BundlesV1);
    if result.account_key.is_some()!=grouped{return Err(error("protocol"))}
    if grouped{validate_parent_bundles(&result.bundles)?}
    let same_projection=same_account&&result.source_projection==previous.source_projection;
    let needs_archive=(!same_account||grouped&&!same_projection)&&(!previous.bundles.is_empty()||!previous.retained_licenses.is_empty());
    let old:Vec<_>=if same_account{previous.bundles.iter().filter(|bundle|!grouped||parent_bundle(bundle)).cloned().collect()}else{Vec::new()};
    let retained_licenses=if same_account&&grouped{retained_licenses(&previous)?}else{Vec::new()};
    let mut bundles=merge_failed_details(result.bundles,&old)?;
    if grouped{restore_retained_licenses(&mut bundles,&retained_licenses)}
    for bundle in &mut bundles{
        let Some(before)=old.iter().find(|before|before.id==bundle.id)else{continue};
        if bundle.purchased_at.is_none(){bundle.purchased_at=before.purchased_at.clone();}
        for item in &mut bundle.items{
            if item.key.is_some(){continue}
            if let Some(known)=before.items.iter().find(|known|known.id==item.id&&known.key.is_some()){*item=known.clone()}
        }
        for known in before.items.iter().filter(|item|item.key.is_some()){
            if !bundle.items.iter().any(|item|item.id==known.id){bundle.items.push(known.clone())}
        }
    }
    if same_account&&same_projection&&!result.enumeration_complete{
        for before in old{if !bundles.iter().any(|bundle|bundle.id==before.id){bundles.push(before.clone())}}
    }
    validate_bundles(&bundles)?;
    let complete=result.enumeration_complete&&!bundles.iter().any(|bundle|bundle.details_failed);
    let stored=crate::storage::LibrarySnapshot{bundles,account_key:result.account_key,enumeration_complete:Some(result.enumeration_complete),last_sync:if complete{result.timestamp}else if same_account{previous.last_sync.clone()}else{None},source_projection:result.source_projection,retained_licenses};
    // Cancellation is checked at the commit boundary, after all validation and
    // merging, while the operation and library mutexes are still held.
    if cancelled.load(Ordering::Acquire){return Err(error("cancelled"))}
    let saved=persist(&stored,needs_archive.then_some(&previous));
    if needs_archive&&saved.is_err(){return Err(error("service"))}
    library.loaded=true;library.auth_state=AuthState::Authenticated;library.bundles=stored.bundles;library.account_key=stored.account_key;library.enumeration_complete=stored.enumeration_complete;library.last_sync=stored.last_sync;library.source_projection=stored.source_projection;library.retained_licenses=stored.retained_licenses;
    library.warning=saved.err().map(|_|"Библиотека обновлена, но сохранить её на диске не удалось.".into());
    Ok(library_status(library))
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

fn reveal_cached_item<'a>(bundle: &'a Bundle, item_id: &str) -> Result<&'a KeyItem, String> {
    let item = bundle.items.iter().find(|item| item.id == item_id).ok_or_else(|| error("notFound"))?;
    if item.key.is_some() { return Ok(item); }
    if item.status != "hidden" { return Err(error(if item.status == "unavailable" { "unavailable" } else { "external" })); }
    if bundle.details_failed { return Err(error("external")); }
    Ok(item)
}
fn reveal_bound_item<'a>(bundle:&'a Bundle,item_id:&str,modern_account:bool,verified:bool)->Result<&'a KeyItem,String>{
    let item=reveal_cached_item(bundle,item_id)?;
    if item.key.is_some(){return Ok(item)}
    let modern=modern_account||["content-","group-","bundle-","vault-"].iter().any(|prefix|bundle.id.starts_with(prefix));
    if modern&&!verified{return Err("Обновите библиотеку, чтобы загрузить покупки из Humble Bundle.".into())}Ok(item)
}

fn accept_revealed_item(previous: &KeyItem, mut item: KeyItem) -> Result<KeyItem, String> {
    if item.id != previous.id || !["revealed","unavailable","external"].contains(&item.status.as_str()) { return Err(error("protocol")); }
    // The already-checked item identity binds the result. Display metadata can
    // change after a reveal and must not discard an otherwise valid key.
    item.title = previous.title.clone(); item.platform = previous.platform.clone();
    item.instructions = previous.instructions.clone(); item.redeem_url = previous.redeem_url.clone();
    validate_item(&item)?;
    Ok(item)
}

fn validate_bundles(bundles: &[Bundle]) -> Result<(), String> {
    if bundles.len() > 10000 { return Err(error("protocol")); }
    let mut ids = std::collections::HashSet::new();
    let mut count = 0usize;
    for bundle in bundles {
        if bundle.id.is_empty() || bundle.id.len() > 256 && !(bundle.id.len()<=263&&parent_bundle(bundle)) || !bundle.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !ids.insert(&bundle.id) || !valid_text(&bundle.title, 4000) || bundle.image_url.len() > 8192 || !safe_https(&bundle.image_url)
            || bundle.purchased_at.as_ref().is_some_and(|date| date.len() > 400 || date.contains('\0')) {
            return Err(error("protocol"));
        }
        if bundle.source_url.as_ref().is_some_and(|url| !safe_source_url(url))
            || bundle.details_failed && bundle.source_url.is_none() { return Err(error("protocol")); }
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
            let _ = window.set_skip_taskbar(false);
            if window.is_maximized().ok() == Some(false) { let _ = window.center(); }
            let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
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
    let url = if state.maintenance.load(Ordering::Acquire) { "about:blank" }
        else if visible { LOGIN_URL } else { LIBRARY_URL };
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url.parse().map_err(|_| error("window"))?))
        .title(crate::locale::text("login"))
        .inner_size(1000.0, 760.0).min_inner_size(700.0, 540.0)
        .center()
        .data_directory(profile()).additional_browser_args(BROWSER_ARGS)
        .visible(visible).skip_taskbar(!visible)
        .initialization_script(include_str!("humble_flight.js"))
        .initialization_script(include_str!("humble_page.js"))
        .initialization_script(include_str!("humble_items.js"))
        .initialization_script(include_str!("humble_sync.js"))
        .initialization_script(include_str!("humble_bundle_images.js"))
        .initialization_script(include_str!("humble_bridge.js"))
        // HTTPS identity-provider redirects remain usable; remote IPC is granted
        // separately and exclusively to the two exact storefront origins.
        .on_navigation(move |url| {
            let state = handle.state::<HumbleState>();
            account_navigation(&state, &navigation_instance, url)
        })
        .on_page_load(move |window, payload| {
            let state = window.app_handle().state::<HumbleState>();
            if state.maintenance.load(Ordering::Acquire) {
                if payload.event() == tauri::webview::PageLoadEvent::Finished
                    && payload.url().as_str() == "about:blank" && current_window(&state, &loaded_instance) {
                    state.maintenance_ready.store(true, Ordering::Release);
                }
                return;
            }
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
            if let Some(attempt) = cancelled {
                crate::auth_trace::record(crate::auth_trace::Stage::LoginCancelled, None, None, None);
                let _ = events.emit_to("main", "humble-login-cancelled", attempt);
            }
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
            if !current_window(&state, &instance)
                || !state.login.lock().ok().is_some_and(|login| login.current.as_deref() == Some(attempt_id.as_str())) { return; }
            if tokio::time::Instant::now() >= deadline {
                crate::auth_trace::record(crate::auth_trace::Stage::LoginTimedOut, None, None, None);
                return;
            }
            // A same-document redirect can outlive the last page-load callback.
            // The current origin and a successful bridge reply are the proof;
            // a stale readiness hint must not stop login recovery forever.
            if window.url().ok().is_some_and(|url| official(&url)) {
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
        let location = window.url().ok().and_then(|url| state.login.lock().ok().map(|mut login| login.auth_location(&probe, &url))).unwrap_or(AuthLocation::Wait);
        if location != AuthLocation::Ready {
            // The identity service may return to a public homepage. Load the
            // known protected library once, in this existing attempt/window,
            // before asking its bridge for authoritative session proof.
            if location == AuthLocation::NavigateLibrary {
                if let Ok(url) = LIBRARY_URL.parse() {
                    if window.navigate(url).is_err() {
                        crate::auth_trace::record(crate::auth_trace::Stage::ProbeRejected, Some(crate::auth_trace::Code::Service), None, None);
                    }
                }
            }
            if let Ok(mut login) = state.login.lock() { login.finish_probe(&probe); }
            return;
        }
        // Existing window only: a cancelled login can never recreate a window.
        let reply = request_existing(&window, &state, "auth", None, None).await;
        if !current_window(&state, &instance) || !state.login.lock().ok().is_some_and(|login| login.matches(&probe)) { return; }
        let verified = reply.as_ref().ok().is_some_and(|reply| reply.get("ok").and_then(Value::as_bool) == Some(true) && reply.get("authenticated").and_then(Value::as_bool) == Some(true));
        if !verified {
            let reason = reply.as_ref().ok().and_then(|value| value.get("reason")).and_then(Value::as_str).unwrap_or("network");
            let status = reply.as_ref().ok().and_then(|value| value.get("httpStatus")).and_then(Value::as_u64).and_then(|value| u16::try_from(value).ok());
            let stage = if reason == "AUTH_REPLY_TIMEOUT" { crate::auth_trace::Stage::ProbeNoReply } else { crate::auth_trace::Stage::ProbeRejected };
            crate::auth_trace::record(stage, Some(trace_reason(reason)), status, None);
            if let Ok(mut login) = state.login.lock() {
                if login.matches(&probe) && current_window(&state, &instance) && reply.as_ref().ok().is_some_and(|reply| reply.get("reason").and_then(Value::as_str) == Some("auth")) {
                    set_auth_state(&app, &state, AuthState::Unauthenticated);
                }
                login.finish_probe(&probe);
            }
            return;
        }
        crate::auth_trace::record(crate::auth_trace::Stage::SessionConfirmed, None, None, None);
        let main_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = main_app.state::<HumbleState>();
            if !current_window(&state, &instance) { return; }
            let completed = state.login.lock().ok().is_some_and(|mut login| login.complete(&probe));
            if !completed { return; }
            crate::auth_trace::record(crate::auth_trace::Stage::LoginCompleted, None, None, None);
            state.ready.store(true, Ordering::Release);
            set_auth_state(&main_app, &state, AuthState::Authenticated);
            // Hiding preserves the same browser/bridge and never cancels a
            // sync or reveal that starts after the completion event.
            let _ = window.hide(); let _ = window.set_skip_taskbar(true);
            if let Some(main) = main_app.get_webview_window("main") {
                if main.is_maximized().ok() == Some(false) { let _ = main.center(); }
                let _ = main.show(); let _ = main.unminimize(); let _ = main.set_focus();
            }
            let _ = main_app.emit_to("main", "humble-login-completed", LoginAttempt { attempt_id: probe.attempt_id });
        });
    });
}

async fn request(app: &tauri::AppHandle, state: &HumbleState, operation: &str, bundle_id: Option<&str>, item_id: Option<&str>) -> Result<Value, String> {
    let window = ensure_window(app, false)?;
    if !window.url().ok().is_some_and(|url| library_page(&url)) {
        state.ready.store(false, Ordering::Release);
        window.navigate(LIBRARY_URL.parse().map_err(|_| error("window"))?).map_err(|_| error("window"))?;
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
        *pending = Some(Pending::new(nonce.clone(),operation.into(),sender));
    }
    let args = json!({ "nonce": nonce, "operation": operation, "bundleId": bundle_id, "itemId": item_id });
    if matches!(operation, "auth" | "sync") {
        if let Err(failure) = crate::auth_dispatch::dispatch(window, &args).await {
            if let Ok(mut pending) = state.pending.lock() {
                if pending.as_ref().is_some_and(|pending| pending.nonce == nonce) { pending.take(); }
            }
            if operation == "auth" { return Ok(json!({"kind":"result","ok":false,"reason":failure.code()})); }
            return Err(error(match failure {
                crate::auth_dispatch::DispatchError::WrongOrigin => "auth",
                crate::auth_dispatch::DispatchError::Busy => "busy",
                crate::auth_dispatch::DispatchError::TimedOut => "network",
                _ => "service",
            }));
        }
        if operation == "auth" { crate::auth_trace::record(crate::auth_trace::Stage::DispatchAccepted, None, None, None); }
    } else {
        let script = format!("window.__humbleLibraryRequest && window.__humbleLibraryRequest({args});");
        if window.eval(&script).is_err() {
            state.pending.lock().map_err(|_| error("service"))?.take();
            return Err(error("window"));
        }
    }
    let response = if operation=="sync"{receive_sync(receiver,state,&nonce,Duration::from_secs(90),Duration::from_secs(2*60*60)).await}else{tokio::time::timeout(Duration::from_secs(if operation=="auth"{20}else{60}),receiver).await.map_err(|_|()).and_then(|reply|reply.map_err(|_|()))};
    if let Ok(mut pending) = state.pending.lock() { if pending.as_ref().is_some_and(|pending| pending.nonce == nonce) { pending.take(); } }
    let reply = match response {
        Ok(reply) => reply,
        _ => {
            let _ = window.eval(&format!("window.__humbleLibraryCancel && window.__humbleLibraryCancel({});", serde_json::to_string(&nonce).unwrap_or_default()));
            if operation == "auth" { return Ok(json!({"kind":"result","ok":false,"reason":"AUTH_REPLY_TIMEOUT"})); }
            return Err(error(if operation == "reveal" { "uncertain" } else { "network" }));
        }
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
async fn receive_sync(mut receiver:oneshot::Receiver<Value>,state:&HumbleState,nonce:&str,inactivity:Duration,absolute:Duration)->Result<Value,()>{
    let started=tokio::time::Instant::now();
    loop{
        let last=state.pending.lock().map_err(|_|())?.as_ref().filter(|pending|pending.nonce==nonce).map(|pending|pending.last_activity).unwrap_or(started);
        let deadline=(last+inactivity).min(started+absolute);
        match tokio::time::timeout_at(deadline,&mut receiver).await{
            Ok(Ok(reply))=>return Ok(reply),Ok(Err(_))=>return Err(()),Err(_)=>{
                let now=tokio::time::Instant::now();let last=state.pending.lock().map_err(|_|())?.as_ref().filter(|pending|pending.nonce==nonce).map(|pending|pending.last_activity).unwrap_or(started);
                if now>=started+absolute||now>=last+inactivity{return Err(())}
            }
        }
    }
}

#[tauri::command]
pub fn humble_status(window: WebviewWindow, state: tauri::State<'_, HumbleState>) -> Result<Status, String> { main_only(&window)?; snapshot(&state) }

#[tauri::command]
pub async fn humble_login(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>) -> Result<LoginAttempt, String> {
    main_only(&window)?;
    if state.maintenance.load(Ordering::Acquire) { return Err(error("busy")); }
    let _operation = crate::app_updates::operation()?;
    let _guard = state.operation.try_lock().map_err(|_| error("busy"))?;
    state.modern_binding_verified.store(false,Ordering::Release);
    crate::auth_trace::begin();
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
    if state.maintenance.load(Ordering::Acquire) { return Err(error("busy")); }
    let _operation = crate::app_updates::operation()?;
    let _guard = state.operation.try_lock().map_err(|_| error("busy"))?;
    state.cancelled.store(false, Ordering::Release);
    state.modern_binding_verified.store(false,Ordering::Release);
    crate::auth_trace::record(crate::auth_trace::Stage::SyncStarted, None, None, None);
    let outcome = async {
    let _ = snapshot(&state)?;
    let reply = request(&app, &state, "sync", None, None).await?;
    let incoming=decode_sync_result(&reply)?;let modern=incoming.account_key.is_some();
    let result={let mut library=state.library.lock().map_err(|_|error("service"))?;apply_sync_result(&mut library,incoming,&state.cancelled,crate::storage::save_snapshot)?};
    state.modern_binding_verified.store(modern,Ordering::Release);
    if let Some(warning) = &result.warning { let _ = app.emit_to("main", "humble-warning", warning); }
    Ok::<Status, String>(result)
    }.await;
    match &outcome {
        Ok(status) => crate::auth_trace::record(if status.enumeration_complete==Some(true)&&!status.bundles.iter().any(|bundle|bundle.details_failed){crate::auth_trace::Stage::SyncCompleted}else{crate::auth_trace::Stage::SyncPartial}, None, None, Some(status.bundles.len())),
        Err(message) => {
            let reason = ["auth", "rateLimited", "network", "protocol", "cancelled"].into_iter()
                .find(|reason| error(reason) == *message).unwrap_or("service");
            crate::auth_trace::record(crate::auth_trace::Stage::SyncFailed, Some(trace_reason(reason)), None, None);
        }
    }
    outcome
}

#[tauri::command]
pub async fn humble_reveal(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>, bundle_id: String, item_id: String) -> Result<KeyItem, String> {
    main_only(&window)?;
    if state.maintenance.load(Ordering::Acquire) { return Err(error("busy")); }
    let _operation = crate::app_updates::operation()?;
    let _guard = state.operation.try_lock().map_err(|_| error("busy"))?;
    state.cancelled.store(false, Ordering::Release);
    let before = snapshot(&state)?;
    let before_bundle = before.bundles.iter().find(|bundle| bundle.id == bundle_id).ok_or_else(|| error("notFound"))?;
    let modern_account=state.library.lock().map_err(|_|error("service"))?.account_key.is_some();
    let old = reveal_bound_item(before_bundle,&item_id,modern_account,state.modern_binding_verified.load(Ordering::Acquire))?;
    if old.key.is_some() { return Ok(old.clone()); }
    let reply = request(&app, &state, "reveal", Some(&bundle_id), Some(&item_id)).await?;
    let item: KeyItem = serde_json::from_value(reply.get("item").cloned().ok_or_else(|| error("protocol"))?).map_err(|_| error("protocol"))?;
    let item = accept_revealed_item(old,item)?;
    {
        let mut library = state.library.lock().map_err(|_| error("service"))?;
        let slot = library.bundles.iter_mut().find(|bundle| bundle.id == bundle_id).and_then(|bundle| bundle.items.iter_mut().find(|entry| entry.id == item_id)).ok_or_else(|| error("notFound"))?;
        *slot = item.clone();
        library.auth_state = AuthState::Authenticated;
        library.warning = crate::storage::save_snapshot(&library_snapshot(&library),None).err().map(|_| "Данные товара обновлены, но сохранить библиотеку на диске не удалось. Скопируйте доступный ключ или экспортируйте его.".into());
        if let Some(warning) = &library.warning { let _ = app.emit_to("main", "humble-warning", warning); }
    }
    set_auth_state(&app, &state, AuthState::Authenticated);
    Ok(item)
}

#[tauri::command]
pub fn humble_cancel(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>) -> Result<(), String> {
    main_only(&window)?;
    if state.maintenance.load(Ordering::Acquire) { return Err(error("busy")); }
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

fn maintenance_available(state: &HumbleState) -> bool {
    !state.maintenance.load(Ordering::Acquire)
        && state.login.lock().ok().is_some_and(|login| login.current.is_none())
        && state.pending.lock().ok().is_some_and(|pending| pending.is_none())
}

#[derive(Clone,Copy,Debug,PartialEq,Eq)]
enum MaintenanceMode { Cache, Login, AllHumble }

fn clear_library_using<F>(library: &mut Library, persist: F) -> Result<Status, String>
where F: FnOnce(&[Bundle]) -> Result<(), String> {
    // The caller holds the library mutex before persistence. Once this last
    // fallible step succeeds, old in-memory metadata cannot be restored.
    persist(&[])?;
    *library=Library { loaded:true,auth_state:AuthState::Unauthenticated,..Library::default() };
    Ok(Status { connected:false,auth_state:AuthState::Unauthenticated,last_sync:None,bundles:Vec::new(),warning:None,enumeration_complete:None })
}

async fn maintain_browser_data<T,F>(main: &WebviewWindow, app: &tauri::AppHandle, state: &HumbleState, mode: MaintenanceMode, finish: F) -> Result<T, String>
where F: FnOnce(&HumbleState) -> Result<T,crate::browser_data::ClearError> {
    use crate::browser_data::{self, ClearError, ClearKind};
    if !maintenance_available(state) { return Err(error("busy")); }
    let updating = crate::app_updates::operation()?;
    let _guard = state.operation.try_lock().map_err(|_| error("busy"))?;
    if !maintenance_available(state)
        || state.maintenance.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err(error("busy")); }
    state.maintenance_ready.store(false, Ordering::Release);
    state.ready.store(false, Ordering::Release);
    let result: Result<T, ClearError> = async {
        // The blank document stops account scripts from repopulating cookies or
        // storage while their own profile is cleared. A missing account window
        // is created blank and hidden: maintenance never contacts Humble.
        let account = ensure_window(app, false).map_err(|_| ClearError::Unavailable)?;
        if account.url().ok().is_some_and(|url| url.as_str() == "about:blank") {
            state.maintenance_ready.store(true, Ordering::Release);
        } else {
            account.navigate("about:blank".parse().map_err(|_| ClearError::Unavailable)?).map_err(|_| ClearError::Unavailable)?;
        }
        for _ in 0..150 {
            if state.maintenance_ready.load(Ordering::Acquire) { break; }
            if app.get_webview_window(LABEL).is_none() { return Err(ClearError::Unavailable); }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if !state.maintenance_ready.load(Ordering::Acquire) { return Err(ClearError::Unavailable); }
        if mode != MaintenanceMode::Login { browser_data::clear(main, ClearKind::Cache).await?; }
        browser_data::clear(&account, if mode == MaintenanceMode::Cache { ClearKind::Cache } else { ClearKind::AllProfile }).await?;
        if mode == MaintenanceMode::Cache {
            // The last WebView owns the profile's session lifetime. Keep this
            // blank view parked so cache cleanup does not discard session-only
            // cookies by closing the account's entire browser environment.
            account.hide().map_err(|_| ClearError::Failed)?;
            account.set_skip_taskbar(true).map_err(|_| ClearError::Failed)?;
            return finish(state);
        }
        // Login mode retains saved keys. AllHumble finalizes the library only
        // after confirmed profile clearing and account-window destruction.
        set_auth_state(app, state, AuthState::Unauthenticated);
        account.destroy().map_err(|_| ClearError::Failed)?;
        for _ in 0..50 {
            if app.get_webview_window(LABEL).is_none() { return finish(state); }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err(ClearError::Failed)
    }.await;
    state.maintenance_ready.store(false, Ordering::Release);
    if result.as_ref().is_err_and(|failure| failure.uncertain()) {
        // WebView2 may still be clearing data after an interrupted callback or
        // timeout. Keep both login and updater blocked until the app restarts.
        if let Ok(mut held) = state.maintenance_update_guard.lock() { *held = Some(updating); }
    } else {
        state.maintenance.store(false, Ordering::Release);
    }
    result.map_err(|_| match mode {
        MaintenanceMode::Login => "Не удалось сбросить вход. Перезапустите приложение и повторите.",
        MaintenanceMode::Cache => "Не удалось очистить кэш браузера. Перезапустите приложение и повторите.",
        MaintenanceMode::AllHumble => "Не удалось полностью очистить данные Humble. Перезапустите приложение и повторите.",
    }.to_string())
}

#[tauri::command]
pub async fn humble_clear_cache(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>) -> Result<(), String> {
    main_only(&window)?;
    maintain_browser_data(&window, &app, &state, MaintenanceMode::Cache, |_| Ok(())).await
}

#[tauri::command]
pub async fn humble_reset_login(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>) -> Result<(), String> {
    main_only(&window)?;
    maintain_browser_data(&window, &app, &state, MaintenanceMode::Login, |_| Ok(())).await
}

#[tauri::command]
pub async fn humble_reset_all(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>) -> Result<Status, String> {
    main_only(&window)?;
    maintain_browser_data(&window,&app,&state,MaintenanceMode::AllHumble,|state| {
        let mut library=state.library.lock().map_err(|_| crate::browser_data::ClearError::Failed)?;
        clear_library_using(&mut library,|_|crate::storage::clear_library_all()).map_err(|_| crate::browser_data::ClearError::Failed)
    }).await
}

#[tauri::command]
pub async fn humble_logout(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, HumbleState>) -> Result<(), String> {
    main_only(&window)?;
    if state.maintenance.load(Ordering::Acquire) { return Err(error("busy")); }
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
    let pending = slot.as_mut().filter(|pending| pending.nonce == nonce).ok_or_else(|| error("service"))?;
    if payload.get("kind").and_then(Value::as_str)==Some("syncActivity"){
        let activity=sync_activity_payload(&pending.operation,&payload).ok_or_else(||error("protocol"))?;
        pending.last_activity=tokio::time::Instant::now();
        if activity["state"]=="waiting"{
            crate::auth_trace::record_retry(crate::auth_trace::sync_failure_stage(activity["phase"].as_str().unwrap()).unwrap(),activity["reason"].as_str().map(trace_reason),activity["attempt"].as_u64().unwrap() as u8,activity["delayMs"].as_u64().unwrap() as u32);
        }
        let _=app.emit_to("main","humble-sync-activity",activity);return Ok(())
    }
    if payload.get("kind").and_then(Value::as_str)==Some("syncWarning"){
        let(stage,code,status,context)=sync_warning_diagnostic(&pending.operation,&payload).ok_or_else(||error("protocol"))?;
        crate::auth_trace::record_sync_failure(stage,code,status,context);return Ok(())
    }
    if payload.get("kind").and_then(Value::as_str) == Some("detailWarning") {
        let (stage,code,status,context) = detail_warning_diagnostic(&pending.operation, &payload).ok_or_else(|| error("protocol"))?;
        crate::auth_trace::record_sync_failure(stage,code,status,context);
        return Ok(());
    }
    if payload.get("kind").and_then(Value::as_str) == Some("session") {
        if !valid_session_proof(&pending.operation, &payload) { return Err(error("protocol")); }
        set_auth_state(&app, &state, AuthState::Authenticated);
        return Ok(());
    }
    if payload.get("kind").and_then(Value::as_str) == Some("progress") {
        let progress=sync_progress_payload(&pending.operation,&payload)?;
        pending.last_activity=tokio::time::Instant::now();
        let _ = app.emit_to("main", "humble-progress", progress);
        return Ok(());
    }
    if payload.get("kind").and_then(Value::as_str) != Some("result") { return Err(error("protocol")); }
    if pending.operation == "auth" && payload.get("ok").and_then(Value::as_bool) == Some(true) {
        let valid = payload.as_object().is_some_and(|object| object.len() == 3 && object.contains_key("kind") && object.contains_key("ok") && object.get("authenticated").and_then(Value::as_bool) == Some(true));
        if !valid { return Err(error("protocol")); }
    }
    if let Some((stage, code, status)) = sync_failure_diagnostic(&pending.operation, &payload) {
        crate::auth_trace::record_sync_failure(stage, code, status, sync_failure_context(&pending.operation, &payload));
    }
    if let Some(pending) = slot.take() { let _ = pending.sender.send(payload); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn sync_failure_diagnostics_require_a_failed_sync_and_known_phase() {
        let payload = json!({"kind":"result","ok":false,"phase":"purchasedSchema","reason":"protocol","httpStatus":200});
        assert_eq!(sync_failure_diagnostic("sync", &payload), Some((crate::auth_trace::Stage::PurchasedSchema, crate::auth_trace::Code::Protocol, Some(200))));
        for operation in ["auth", "reveal", "unknown"] { assert_eq!(sync_failure_diagnostic(operation, &payload), None); }
        for invalid in [
            json!({"kind":"result","ok":true,"phase":"purchasedSchema"}),
            json!({"kind":"progress","ok":false,"phase":"purchasedSchema"}),
            json!({"kind":"result","ok":false,"phase":"https://example.test/private"}),
            json!({"kind":"result","ok":false,"phase":{"private":"data"}}),
            json!({"kind":"result","ok":false}),
        ] { assert_eq!(sync_failure_diagnostic("sync", &invalid), None); }
        let bounded = sync_failure_diagnostic("sync", &json!({"kind":"result","ok":false,"phase":"libraryPage","reason":"arbitrary private text","httpStatus":600})).unwrap();
        assert_eq!(bounded, (crate::auth_trace::Stage::LibraryPage, crate::auth_trace::Code::Service, None));
        let typed = json!({"kind":"result","ok":false,"phase":"purchasedWire","reason":"protocol","protocolCode":"flightEnvelope","httpStatus":200});
        assert_eq!(sync_failure_diagnostic("sync", &typed), Some((crate::auth_trace::Stage::PurchasedWire, crate::auth_trace::Code::FlightEnvelope, Some(200))));
        assert_eq!(sync_failure_diagnostic("auth", &typed), None);
        let unknown = json!({"kind":"result","ok":false,"phase":"purchasedIdentity","reason":"protocol","protocolCode":"arbitrary private text"});
        assert_eq!(sync_failure_diagnostic("sync", &unknown), Some((crate::auth_trace::Stage::PurchasedIdentity, crate::auth_trace::Code::Protocol, None)));
    }
    #[test] fn sync_failure_context_rejects_unbounded_or_non_numeric_fields() {
        let mut payload = json!({"kind":"result","ok":false,"phase":"purchasedIdentity","reason":"protocol","requestedPage":2,"pageRows":5,"overlapRows":5});
        assert_eq!(sync_failure_context("sync", &payload), crate::auth_trace::SyncFailureContext::new(Some(2),Some(5),Some(5)));
        assert_eq!(sync_failure_context("auth", &payload), None);
        for invalid in [json!("2"),json!(2.5),json!(-1),json!(2001),json!({"private":"data"})] {
            payload["requestedPage"] = invalid;
            assert_eq!(sync_failure_context("sync", &payload), None);
        }
        payload["requestedPage"] = json!(2);
        payload["overlapRows"] = json!(6);
        assert_eq!(sync_failure_context("sync", &payload), None);
        payload["overlapRows"] = json!(5);
        payload["phase"] = json!("detailSchema");
        assert_eq!(sync_failure_context("sync", &payload), None);
        payload["phase"] = json!("purchasedIdentity");
        payload["ok"] = json!(true);
        assert_eq!(sync_failure_context("sync", &payload), None);
    }
    #[test] fn detail_failure_context_rejects_private_unbounded_or_inconsistent_values() {
        let mut payload = json!({"kind":"result","ok":false,"phase":"detailSchema","reason":"protocol","protocolCode":"detailComponents","detailComponentsCount":2,"completedDetails":3,"totalDetails":4});
        let expected = crate::auth_trace::SyncFailureContext::new_detail(Some(2),Some(3),Some(4));
        assert_eq!(sync_failure_context("sync", &payload), expected);
        assert_eq!(sync_failure_diagnostic("sync", &payload).unwrap().1, crate::auth_trace::Code::DetailComponents);
        for invalid in [json!("2"),json!(2.5),json!(-1),json!(10001),json!({"private":"data"})] {
            payload["detailComponentsCount"] = invalid;
            assert_eq!(sync_failure_context("sync", &payload), None);
        }
        payload["detailComponentsCount"] = json!(2);
        payload["completedDetails"] = json!(5);
        assert_eq!(sync_failure_context("sync", &payload), None);
        payload["completedDetails"] = json!(3);
        assert_eq!(sync_failure_context("auth", &payload), None);
        payload["phase"] = json!("purchasedIdentity");
        assert_eq!(sync_failure_context("sync", &payload), None);
        payload["phase"] = json!("detailSchema");
        payload["ok"] = json!(true);
        assert_eq!(sync_failure_context("sync", &payload), None);
    }
    #[test] fn library_landing_recognizes_only_the_protected_storefront_routes() {
        for url in [
            "https://www.humblebundle.com/home/library",
            "https://www.humblebundle.com/home/library/",
            "https://humblebundle.com/home/library/12345678-1234-1234-1234-123456789abc",
        ] { assert!(library_page(&url.parse().unwrap())); }
        for url in [
            "https://www.humblebundle.com/",
            "https://www.humblebundle.com/home/keys",
            "https://www.humblebundle.com/home/library-other",
            "https://auth.humblebundle.com/home/library",
            "http://www.humblebundle.com/home/library",
            "https://www.humblebundle.com:444/home/library",
            "https://www.humblebundle.com.evil.test/home/library",
        ] { assert!(!library_page(&url.parse().unwrap())); }
    }
    #[test] fn library_landing_is_once_per_attempt_and_never_proves_authentication() {
        let mut login = LoginLifecycle::default();
        let attempt = login.begin();
        let first = login.start_probe().unwrap();
        assert_eq!(login.auth_location(&first, &LOGIN_URL.parse().unwrap()), AuthLocation::Wait);
        assert!(!login.landing_requested);
        assert_eq!(login.auth_location(&first, &"https://www.humblebundle.com/".parse().unwrap()), AuthLocation::NavigateLibrary);
        assert_eq!(login.current.as_deref(), Some(attempt.attempt_id.as_str()));
        login.finish_probe(&first);
        let second = login.start_probe().unwrap();
        assert_eq!(login.auth_location(&second, &"https://www.humblebundle.com/".parse().unwrap()), AuthLocation::Wait);
        assert_eq!(login.auth_location(&second, &LIBRARY_URL.parse().unwrap()), AuthLocation::Ready);
        // The location only enables a subsequent authenticated read. It does
        // not complete the attempt or hide the window by itself.
        assert_eq!(login.current.as_deref(), Some(attempt.attempt_id.as_str()));
        assert!(login.matches(&second));
    }
    #[test] fn library_landing_does_not_interrupt_identity_callback_paths() {
        let mut login = LoginLifecycle::default();
        login.begin(); let probe = login.start_probe().unwrap();
        for path in ["/login", "/signin", "/auth/callback", "/oauth/callback", "/sso/complete", "/store/example"] {
            let url = format!("https://www.humblebundle.com{path}").parse().unwrap();
            assert_eq!(login.auth_location(&probe, &url), AuthLocation::Wait);
            assert!(!login.landing_requested);
        }
        assert_eq!(login.auth_location(&probe, &"https://www.humblebundle.com/home".parse().unwrap()), AuthLocation::NavigateLibrary);
    }
    #[test] fn library_landing_does_not_survive_cancel_or_replace_a_new_attempt() {
        let mut login = LoginLifecycle::default();
        login.begin(); let stale = login.start_probe().unwrap();
        let homepage = "https://www.humblebundle.com/".parse().unwrap();
        assert_eq!(login.auth_location(&stale, &homepage), AuthLocation::NavigateLibrary);
        login.cancel();
        assert!(!login.landing_requested);
        assert_eq!(login.auth_location(&stale, &homepage), AuthLocation::Wait);
        let current = login.begin(); let active = login.start_probe_for(Some(&current.attempt_id)).unwrap();
        assert_eq!(login.auth_location(&stale, &homepage), AuthLocation::Wait);
        assert_eq!(login.auth_location(&active, &homepage), AuthLocation::NavigateLibrary);
        assert!(login.complete(&active));
        assert!(!login.landing_requested);
    }
    #[test] fn browser_maintenance_refuses_active_login_pending_work_and_reentry() {
        let state = HumbleState::default();
        assert!(maintenance_available(&state));
        state.login.lock().unwrap().begin();
        assert!(!maintenance_available(&state));
        state.login.lock().unwrap().cancel();
        assert!(maintenance_available(&state));
        let (sender, _receiver) = oneshot::channel();
        *state.pending.lock().unwrap() = Some(Pending::new("synthetic-maintenance".into(),"sync".into(),sender));
        assert!(!maintenance_available(&state));
        state.pending.lock().unwrap().take();
        state.maintenance.store(true, Ordering::Release);
        assert!(!maintenance_available(&state));
        assert!(account_navigation(&state, "unused", &"about:blank".parse().unwrap()));
        assert!(!account_navigation(&state, "unused", &"https://www.humblebundle.com/".parse().unwrap()));
        assert!(!account_navigation(&state, "unused", &"https://auth.humblebundle.com/login".parse().unwrap()));
        state.maintenance.store(false, Ordering::Release);
        assert!(maintenance_available(&state));
    }
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
        *state.pending.lock().unwrap() = Some(Pending::new("synthetic".into(),"auth".into(),sender));
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
    fn bundle() -> Bundle { Bundle { id: "order_fixture_1".into(), title: "Mixed bundle".into(), image_url: "https://cdn.humblebundle.com/cover.png".into(), purchased_at: None, items: vec![KeyItem { id: "a:0:steam".into(), title: "Game".into(), platform: "Steam".into(), key: Some("TEST-ONLY-KEY".into()), status: "revealed".into(), instructions: None, redeem_url: None }], details_failed:false,source_url:None } }
    fn failed_bundle(id: &str) -> Bundle {
        let mut value=bundle(); value.id=id.into(); value.title="Synthetic missing detail".into(); value.items.clear(); value.details_failed=true;
        value.source_url=Some(format!("https://www.humblebundle.com/home/library/{id}")); value
    }
    #[test] fn failed_last_detail_commits_other_bundles_and_keeps_only_same_identity_keys() {
        let mut cached=bundle(); cached.id="bundle_last".into(); cached.title="Old title".into();
        let mut title_decoy=bundle(); title_decoy.id="different_identity".into(); title_decoy.title="Synthetic missing detail".into(); title_decoy.items[0].key=Some("TEST-ONLY-WRONG-TITLE-MATCH".into());
        let mut first=bundle(); first.id="bundle_first".into(); let mut second=bundle(); second.id="bundle_second".into();
        let previous=vec![cached.clone(),title_decoy]; let before=serde_json::to_vec(&previous).unwrap();
        let merged=merge_failed_details(vec![first,second,failed_bundle("bundle_last")],&previous).unwrap();
        assert_eq!(merged.len(),3); assert!(!merged[0].details_failed); assert!(!merged[1].details_failed); assert!(merged[2].details_failed);
        assert_eq!(serde_json::to_value(&merged[2].items).unwrap(),serde_json::to_value(&cached.items).unwrap());
        assert_eq!(serde_json::to_vec(&previous).unwrap(),before);
        assert!(partial_details_warning(&merged).is_some());
        let roundtrip:Vec<Bundle>=serde_json::from_slice(&serde_json::to_vec(&merged).unwrap()).unwrap();
        validate_bundles(&roundtrip).unwrap(); assert!(roundtrip[2].details_failed); assert!(partial_details_warning(&roundtrip).is_some());
        let fresh=merge_failed_details(vec![failed_bundle("never_cached")],&previous).unwrap();
        assert!(fresh[0].items.is_empty()); assert!(fresh[0].details_failed); assert!(partial_details_warning(&fresh).is_some());
        let mut recovered=cached; recovered.items[0].key=Some("TEST-ONLY-RECOVERED".into());
        let recovered=merge_failed_details(vec![recovered],&merged).unwrap();
        assert!(!recovered[0].details_failed); assert_eq!(recovered[0].items[0].key.as_deref(),Some("TEST-ONLY-RECOVERED")); assert_eq!(partial_details_warning(&recovered),None);
    }
    #[test] fn failed_detail_metadata_never_supplies_keys_or_uses_a_foreign_source() {
        let previous=vec![bundle()]; let before=serde_json::to_vec(&previous).unwrap();
        let mut invalid=failed_bundle("order_fixture_1"); invalid.items=bundle().items;
        assert!(merge_failed_details(vec![invalid],&previous).is_err());
        let mut invalid=failed_bundle("order_fixture_1"); invalid.source_url=None;
        assert!(merge_failed_details(vec![invalid],&previous).is_err());
        let mut invalid=failed_bundle("order_fixture_1"); invalid.source_url=Some("https://example.test/home/library/order_fixture_1".into());
        assert!(merge_failed_details(vec![invalid],&previous).is_err());
        assert_eq!(serde_json::to_vec(&previous).unwrap(),before);
        for source in ["https://www.humblebundle.com/home/library","https://humblebundle.com/home/library/fixture-a","https://www.humblebundle.com/home/library/content/fixture_a","https://www.humblebundle.com/home/library/group/fixture-a"] { assert!(safe_source_url(source)); }
        for source in ["","http://www.humblebundle.com/home/library/a","https://auth.humblebundle.com/home/library/a","https://www.humblebundle.com.evil.test/home/library/a","https://user:pass@www.humblebundle.com/home/library/a","https://www.humblebundle.com:444/home/library/a","https://www.humblebundle.com/home/library/a?private=x","https://www.humblebundle.com/home/library/a#private","https://www.humblebundle.com/login","https://www.humblebundle.com/home/library/a/extra","https://www.humblebundle.com/home/library/content/a/../b","https://www.humblebundle.com/home/library/%61"] { assert!(!safe_source_url(source),"Unexpected source URL acceptance"); }
    }
    #[test] fn detail_warning_is_closed_sync_only_and_does_not_authenticate() {
        let valid=json!({"kind":"detailWarning","reason":"protocol","phase":"detailSchema","protocolCode":"detailComponents","httpStatus":200,"detailComponentsCount":2,"completedDetails":3,"totalDetails":4});
        assert!(detail_warning_diagnostic("sync",&valid).is_some());
        for operation in ["auth","reveal","other"] { assert!(detail_warning_diagnostic(operation,&valid).is_none()); }
        for (key,value) in [("ok",json!(true)),("phase",json!("purchasedSchema")),("reason",json!("auth")),("reason",json!("network")),("reason",json!("rateLimited")),("reason",json!("cancelled")),("protocolCode",json!("PRIVATE-INPUT")),("body",json!("PRIVATE-INPUT")),("completedDetails",json!(5)),("httpStatus",json!(600)),("totalDetails",json!("4"))] {
            let mut invalid=valid.clone(); invalid[key]=value; assert!(detail_warning_diagnostic("sync",&invalid).is_none());
        }
        let not_found=json!({"kind":"detailWarning","reason":"service","phase":"detailPage","httpStatus":404,"completedDetails":0,"totalDetails":1});
        assert!(detail_warning_diagnostic("sync",&not_found).is_some());
        let mut invalid=not_found; invalid["httpStatus"]=json!(500); assert!(detail_warning_diagnostic("sync",&invalid).is_none());
        assert!(!valid_session_proof("sync",&valid)); assert!(!valid_session_proof("auth",&valid));
        let mut legacy=serde_json::to_value(bundle()).unwrap(); legacy.as_object_mut().unwrap().remove("detailsFailed"); legacy.as_object_mut().unwrap().remove("sourceUrl");
        let restored:Bundle=serde_json::from_value(legacy).unwrap(); assert!(!restored.details_failed); assert!(restored.source_url.is_none());
    }
    #[test] fn revealed_values_survive_display_metadata_changes_but_not_identity_or_key_state_errors() {
        let before=bundle().items.remove(0);
        let mut response=before.clone(); response.title="A new upstream title".into(); response.platform="A new platform label".into(); response.key=Some("TEST-ONLY-NEW-REVEAL".into());
        let accepted=accept_revealed_item(&before,response).unwrap();
        assert_eq!(accepted.key.as_deref(),Some("TEST-ONLY-NEW-REVEAL")); assert_eq!(accepted.title,before.title); assert_eq!(accepted.platform,before.platform);
        let mut pending=before.clone(); pending.status="external".into(); pending.key=None;
        let accepted=accept_revealed_item(&before,pending).unwrap(); assert_eq!(accepted.status,"external"); assert_eq!(accepted.key,None);
        for (status,key) in [("hidden",None),("revealed",None),("external",Some("TEST-ONLY-INCONSISTENT")),("unavailable",Some("TEST-ONLY-INCONSISTENT"))] {
            let mut invalid=before.clone(); invalid.status=status.into(); invalid.key=key.map(str::to_owned); assert!(accept_revealed_item(&before,invalid).is_err());
        }
        let mut wrong=before.clone(); wrong.id="different_identity".into(); assert!(accept_revealed_item(&before,wrong).is_err());
        let mut malformed=before.clone(); malformed.key=Some("\0".into()); assert!(accept_revealed_item(&before,malformed).is_err());
    }
    #[test] fn failed_details_keep_known_key_shortcut_and_block_hidden_reveal_before_requests() {
        let mut cached=bundle(); cached.details_failed=true; cached.source_url=Some("https://www.humblebundle.com/home/library/order_fixture_1".into());
        assert_eq!(reveal_cached_item(&cached,"a:0:steam").unwrap().key.as_deref(),Some("TEST-ONLY-KEY"));
        cached.items[0].key=None; cached.items[0].status="hidden".into(); assert_eq!(reveal_cached_item(&cached,"a:0:steam").unwrap_err(),error("external"));
        cached.details_failed=false; assert!(reveal_cached_item(&cached,"a:0:steam").is_ok());
    }
    #[test] fn modern_hidden_reveal_requires_current_session_binding_but_cached_codes_and_legacy_do_not() {
        let mut cached=bundle();cached.id="content-SYNTHETIC_ITEM_1".into();
        assert!(reveal_bound_item(&cached,"a:0:steam",true,false).unwrap().key.is_some());
        cached.items[0].key=None;cached.items[0].status="hidden".into();
        assert_eq!(reveal_bound_item(&cached,"a:0:steam",true,false).unwrap_err(),"Обновите библиотеку, чтобы загрузить покупки из Humble Bundle.");
        assert!(reveal_bound_item(&cached,"a:0:steam",true,true).is_ok());assert!(reveal_bound_item(&cached,"a:0:steam",false,false).is_err());
        cached.id="SYNTHETIC_LEGACY_ORDER".into();assert!(reveal_bound_item(&cached,"a:0:steam",false,false).is_ok());
    }
    #[test] fn successful_reveal_preserves_cached_presentation_even_when_fresh_metadata_is_malformed() {
        let mut before=bundle().items.remove(0);before.instructions=Some("Synthetic cached instructions".into());before.redeem_url=Some("https://www.humblebundle.com/home/library/fixture".into());
        for url in [format!("https://example.test/{}","x".repeat(9000)),"javascript:SYNTHETIC-UNSAFE".into()] {
            let mut response=before.clone();response.key=Some("TEST-ONLY-SUCCESSFUL-REVEAL".into());response.title="\0".into();response.platform=String::new();response.instructions=Some(format!("\0{}","x".repeat(50_000)));response.redeem_url=Some(url);
            let accepted=accept_revealed_item(&before,response).unwrap();
            assert_eq!(accepted.key.as_deref(),Some("TEST-ONLY-SUCCESSFUL-REVEAL"));assert_eq!(accepted.title,before.title);assert_eq!(accepted.platform,before.platform);assert_eq!(accepted.instructions,before.instructions);assert_eq!(accepted.redeem_url,before.redeem_url);
        }
    }
    #[test] fn progress_stages_are_closed_optional_and_sync_only() {
        let legacy=json!({"kind":"progress","completed":1,"total":3});
        assert_eq!(sync_progress_payload("sync",&legacy).unwrap(),json!({"completed":1,"total":3}));
        for stage in ["purchases","keys"] {
            let mut payload=legacy.clone(); payload["stage"]=json!(stage); payload["ignored"] = json!("SYNTHETIC-PRIVATE-DATA");
            assert_eq!(sync_progress_payload("sync",&payload).unwrap(),json!({"completed":1,"total":3,"stage":stage}));
        }
        for invalid in [json!("unknown"),json!("keys?private=x"),json!(null),json!(2),json!({"private":"data"})] {
            let mut payload=legacy.clone(); payload["stage"]=invalid;
            assert!(sync_progress_payload("sync",&payload).is_err());
        }
        for operation in ["auth","reveal","other"] { assert!(sync_progress_payload(operation,&legacy).is_err()); }
        let (sender,mut receiver)=oneshot::channel();
        let mut pending=Some(Pending::new("synthetic".into(),"sync".into(),sender));
        let invalid=json!({"kind":"progress","completed":1,"total":3,"stage":"invalid"});
        assert!(sync_progress_payload(&pending.as_ref().unwrap().operation,&invalid).is_err());
        assert!(matches!(receiver.try_recv(),Err(tokio::sync::oneshot::error::TryRecvError::Empty)));
        pending.take().unwrap().sender.send(json!({"kind":"result","ok":true})).unwrap();
        assert_eq!(receiver.try_recv().unwrap(),json!({"kind":"result","ok":true}));
    }
    #[test] fn all_humble_reset_persists_empty_before_clearing_memory_metadata() {
        let mut library=Library{loaded:true,auth_state:AuthState::Authenticated,bundles:vec![bundle()],last_sync:Some("SYNTHETIC-LAST-SYNC".into()),warning:Some("SYNTHETIC-WARNING".into()),..Library::default()};
        let disk=std::cell::RefCell::new(serde_json::to_vec(&library.bundles).unwrap());
        let result=clear_library_using(&mut library,|bundles|{assert!(bundles.is_empty());*disk.borrow_mut()=serde_json::to_vec(bundles).unwrap();Ok(())}).unwrap();
        assert!(!result.connected);assert_eq!(result.auth_state,AuthState::Unauthenticated);assert!(result.bundles.is_empty()&&result.last_sync.is_none()&&result.warning.is_none());
        assert!(library.loaded&&library.bundles.is_empty()&&library.last_sync.is_none()&&library.warning.is_none());assert_eq!(library.auth_state,AuthState::Unauthenticated);
        let restarted:Vec<Bundle>=serde_json::from_slice(&disk.borrow()).unwrap();assert!(restarted.is_empty());validate_bundles(&restarted).unwrap();
    }
    #[test] fn failed_empty_library_persistence_preserves_keys_and_never_claims_clear_success() {
        let mut library=Library{loaded:true,auth_state:AuthState::Unauthenticated,bundles:vec![bundle()],last_sync:Some("SYNTHETIC-LAST-SYNC".into()),warning:Some("SYNTHETIC-WARNING".into()),..Library::default()};
        let before=serde_json::to_vec(&library.bundles).unwrap();
        let result=clear_library_using(&mut library,|bundles|{assert!(bundles.is_empty());Err("SYNTHETIC-DISK-FAILURE".into())});
        assert!(result.is_err());assert_eq!(serde_json::to_vec(&library.bundles).unwrap(),before);assert_eq!(library.last_sync.as_deref(),Some("SYNTHETIC-LAST-SYNC"));assert_eq!(library.warning.as_deref(),Some("SYNTHETIC-WARNING"));
    }
    fn grouped_fixture(id:&str)->Bundle{let mut value=bundle();value.id=format!("bundle-{id}");value.source_url=Some(format!("https://www.humblebundle.com/home/library/{id}"));value}
    fn grouped_result(bundles:Vec<Bundle>,complete:bool)->SyncResult{SyncResult{bundles,account_key:Some("a".repeat(64)),enumeration_complete:complete,timestamp:Some("SYNTHETIC-NEW".into()),source_projection:Some(crate::storage::SourceProjection::BundlesV1)}}
    #[test] fn old_bound_position_projection_is_hidden_without_changing_cache_or_legacy_orders(){
        let mut positions=Vec::new();for id in ["content-first","group-first","vault-first"]{let mut row=bundle();row.id=id.into();positions.push(row)}positions.push(grouped_fixture("parent"));
        let mut library=Library{loaded:true,bundles:positions,account_key:Some("a".repeat(64)),enumeration_complete:Some(true),..Library::default()};let before=serde_json::to_vec(&library.bundles).unwrap();
        let status=library_status(&library);assert_eq!(status.bundles.len(),1);assert_eq!(status.bundles[0].id,"bundle-parent");assert_eq!(status.enumeration_complete,None);assert_eq!(status.warning.as_deref(),Some("Обновите библиотеку, чтобы загрузить покупки из Humble Bundle."));assert_eq!(serde_json::to_vec(&library.bundles).unwrap(),before);
        library.account_key=None;assert_eq!(library_status(&library).bundles.len(),4);
    }
    #[test] fn same_owner_projection_migration_archives_positions_and_preserves_unscoped_codes_privately(){
        let mut first=bundle();first.id="content-old-a".into();first.items[0].id="entitlement-a".into();first.items[0].key=Some("TEST-ONLY-CODE-A".into());
        let mut second=first.clone();second.id="content-old-b".into();second.items[0].id="entitlement-b".into();second.items[0].key=Some("TEST-ONLY-CODE-B".into());
        let mut library=Library{loaded:true,bundles:vec![first,second],account_key:Some("a".repeat(64)),enumeration_complete:Some(true),last_sync:Some("SYNTHETIC-OLD".into()),..Library::default()};
        let mut fresh=grouped_fixture("parent-a");fresh.items[0].id="entitlement-a".into();fresh.items[0].key=None;fresh.items[0].status="hidden".into();fresh.items[0].title="Fresh item title".into();fresh.items[0].platform="Fresh platform".into();fresh.items[0].redeem_url=Some("https://www.humblebundle.com/home/library/parent-a".into());
        let stored=std::cell::RefCell::new(None);let status=apply_sync_result(&mut library,grouped_result(vec![fresh],false),&AtomicBool::new(false),|current,archive|{let old=archive.unwrap();assert_eq!(old.bundles.len(),2);assert!(old.source_projection.is_none());assert_eq!(current.bundles.len(),1);*stored.borrow_mut()=Some(current.clone());Ok(())}).unwrap();
        assert_eq!(status.bundles.len(),1);assert_eq!(status.bundles[0].id,"bundle-parent-a");let item=&status.bundles[0].items[0];assert!(item.key.is_none());assert_eq!(item.status,"hidden");assert_eq!(item.title,"Fresh item title");assert_eq!(item.platform,"Fresh platform");assert_eq!(item.redeem_url.as_deref(),Some("https://www.humblebundle.com/home/library/parent-a"));assert_eq!(status.last_sync.as_deref(),Some("SYNTHETIC-OLD"));
        let encoded_status=serde_json::to_string(&status).unwrap();assert!(!encoded_status.contains("TEST-ONLY-CODE-A")&&!encoded_status.contains("TEST-ONLY-CODE-B")&&!encoded_status.contains("retainedLicenses")&&!encoded_status.contains("sourceProjection"));
        let stored=stored.into_inner().unwrap();assert_eq!(stored.retained_licenses.len(),2);assert!(stored.retained_licenses.iter().all(|license|license.parent_id.is_none()));assert_eq!(stored.retained_licenses.iter().map(|license|license.key.as_str()).collect::<Vec<_>>(),vec!["TEST-ONLY-CODE-A","TEST-ONLY-CODE-B"]);let mut restarted=Library{loaded:true,bundles:stored.bundles,account_key:stored.account_key,enumeration_complete:stored.enumeration_complete,last_sync:stored.last_sync,source_projection:stored.source_projection,retained_licenses:stored.retained_licenses,..Library::default()};
        let mut fresh=grouped_fixture("parent-b");fresh.items[0].id="entitlement-b".into();fresh.items[0].key=None;fresh.items[0].status="hidden".into();
        let status=apply_sync_result(&mut restarted,grouped_result(vec![fresh],false),&AtomicBool::new(false),|_,archive|{assert!(archive.is_none());Ok(())}).unwrap();assert_eq!(status.bundles.len(),2);assert!(status.bundles[0].items[0].key.is_none());assert!(status.bundles.iter().all(parent_bundle));assert_eq!(restarted.retained_licenses.len(),2);
        let snapshot=library_snapshot(&restarted);assert_eq!(snapshot.retained_licenses,restarted.retained_licenses);assert_eq!(snapshot.source_projection,Some(crate::storage::SourceProjection::BundlesV1));
        clear_library_using(&mut restarted,|_|Ok(())).unwrap();assert!(restarted.retained_licenses.is_empty()&&restarted.source_projection.is_none());
    }
    #[test] fn projection_migration_does_not_map_conflicting_codes_or_match_titles_and_failure_is_atomic(){
        let mut one=bundle();one.id="content-old-one".into();one.items[0].id="ambiguous-id".into();one.items[0].key=Some("TEST-ONLY-FIRST".into());let mut two=one.clone();two.id="content-old-two".into();two.items[0].key=Some("TEST-ONLY-SECOND".into());
        let mut library=Library{loaded:true,bundles:vec![one,two],account_key:Some("a".repeat(64)),..Library::default()};let before=serde_json::to_vec(&library.bundles).unwrap();let mut fresh=grouped_fixture("parent");fresh.items[0].id="ambiguous-id".into();fresh.items[0].key=None;fresh.items[0].status="hidden".into();let mut same_title=fresh.items[0].clone();same_title.id="different-id".into();fresh.items.push(same_title);
        assert!(apply_sync_result(&mut library,grouped_result(vec![fresh.clone()],true),&AtomicBool::new(false),|_,archive|{assert!(archive.is_some());Err("SYNTHETIC-ARCHIVE-FAILURE".into())}).is_err());assert_eq!(serde_json::to_vec(&library.bundles).unwrap(),before);assert!(library.source_projection.is_none()&&library.retained_licenses.is_empty());
        let status=apply_sync_result(&mut library,grouped_result(vec![fresh],true),&AtomicBool::new(false),|_,_|Ok(())).unwrap();assert!(status.bundles[0].items.iter().all(|item|item.key.is_none()&&item.status=="hidden"));assert_eq!(library.retained_licenses.len(),2);
    }
    #[test] fn retained_license_never_moves_from_one_known_parent_into_another_with_the_same_item_id(){
        let mut old_parent=grouped_fixture("parent-a");old_parent.items[0].id="shared-entitlement".into();old_parent.items[0].key=Some("TEST-ONLY-PARENT-A".into());
        // A canonical parent from an earlier schema still supplies provenance.
        let mut library=Library{loaded:true,bundles:vec![old_parent],account_key:Some("a".repeat(64)),..Library::default()};
        let mut fresh=grouped_fixture("parent-b");fresh.items[0].id="shared-entitlement".into();fresh.items[0].key=None;fresh.items[0].status="hidden".into();
        let status=apply_sync_result(&mut library,grouped_result(vec![fresh],true),&AtomicBool::new(false),|_,archive|{assert!(archive.is_some());Ok(())}).unwrap();
        assert_eq!(status.bundles.len(),1);assert_eq!(status.bundles[0].id,"bundle-parent-b");assert!(status.bundles[0].items[0].key.is_none());assert_eq!(status.bundles[0].items[0].status,"hidden");
        assert_eq!(library.retained_licenses,vec![crate::storage::RetainedLicense{id:"shared-entitlement".into(),key:"TEST-ONLY-PARENT-A".into(),parent_id:Some("bundle-parent-a".into())}]);
    }
    #[test] fn retained_license_restoration_is_scoped_to_parent_and_item_and_keeps_fresh_metadata(){
        let licenses=vec![
            crate::storage::RetainedLicense{id:"shared-entitlement".into(),key:"  TEST-ONLY-PARENT-A-Ü  ".into(),parent_id:Some("bundle-parent-a".into())},
            crate::storage::RetainedLicense{id:"shared-entitlement".into(),key:"TEST-ONLY-PARENT-B".into(),parent_id:Some("bundle-parent-b".into())},
            crate::storage::RetainedLicense{id:"shared-entitlement".into(),key:"TEST-ONLY-UNSCOPED".into(),parent_id:None},
        ];
        let mut library=Library{loaded:true,account_key:Some("a".repeat(64)),source_projection:Some(crate::storage::SourceProjection::BundlesV1),retained_licenses:licenses,..Library::default()};
        let fresh:Vec<_>=["parent-a","parent-b","parent-c"].into_iter().map(|parent|{let mut value=grouped_fixture(parent);value.items[0].id="shared-entitlement".into();value.items[0].key=None;value.items[0].status="hidden".into();value.items[0].title=format!("Fresh {parent}");value.items[0].platform="Fresh platform".into();value.items[0].redeem_url=Some(format!("https://www.humblebundle.com/home/library/{parent}"));value}).collect();
        let status=apply_sync_result(&mut library,grouped_result(fresh,true),&AtomicBool::new(false),|_,archive|{assert!(archive.is_none());Ok(())}).unwrap();
        assert_eq!(status.bundles[0].items[0].key.as_deref(),Some("  TEST-ONLY-PARENT-A-Ü  "));assert_eq!(status.bundles[1].items[0].key.as_deref(),Some("TEST-ONLY-PARENT-B"));assert!(status.bundles[2].items[0].key.is_none());
        for bundle in &status.bundles{assert_eq!(bundle.items[0].title,format!("Fresh {}",bundle.id.strip_prefix("bundle-").unwrap()));assert_eq!(bundle.items[0].platform,"Fresh platform");assert_eq!(bundle.items[0].redeem_url,bundle.source_url);}
        assert_eq!(library.retained_licenses.len(),3);
    }
    #[test] fn conflicting_scoped_retained_codes_do_not_assign_a_license_and_unscoped_code_is_not_a_fallback(){
        let licenses=[("TEST-ONLY-FIRST",Some("bundle-parent")),("TEST-ONLY-SECOND",Some("bundle-parent")),("TEST-ONLY-GLOBAL",None)].into_iter().map(|(key,parent)|crate::storage::RetainedLicense{id:"shared-entitlement".into(),key:key.into(),parent_id:parent.map(str::to_owned)}).collect();
        let mut library=Library{loaded:true,account_key:Some("a".repeat(64)),source_projection:Some(crate::storage::SourceProjection::BundlesV1),retained_licenses:licenses,..Library::default()};
        let mut fresh=grouped_fixture("parent");fresh.items[0].id="shared-entitlement".into();fresh.items[0].key=None;fresh.items[0].status="hidden".into();
        let status=apply_sync_result(&mut library,grouped_result(vec![fresh],true),&AtomicBool::new(false),|_,_|Ok(())).unwrap();assert!(status.bundles[0].items[0].key.is_none());assert_eq!(status.bundles[0].items[0].status,"hidden");assert_eq!(library.retained_licenses.len(),3);
    }
    #[test] fn scoped_retained_license_does_not_cross_account_boundaries(){
        let mut library=Library{loaded:true,account_key:Some("b".repeat(64)),source_projection:Some(crate::storage::SourceProjection::BundlesV1),retained_licenses:vec![crate::storage::RetainedLicense{id:"shared-entitlement".into(),key:"TEST-ONLY-OTHER-ACCOUNT".into(),parent_id:Some("bundle-parent".into())}],..Library::default()};
        let mut fresh=grouped_fixture("parent");fresh.items[0].id="shared-entitlement".into();fresh.items[0].key=None;fresh.items[0].status="hidden".into();
        let status=apply_sync_result(&mut library,grouped_result(vec![fresh],true),&AtomicBool::new(false),|_,archive|{assert_eq!(archive.unwrap().retained_licenses.len(),1);Ok(())}).unwrap();assert!(status.bundles[0].items[0].key.is_none());assert!(library.retained_licenses.is_empty());
    }
    #[test] fn modern_projection_requires_authoritative_index_and_exact_parent_routes(){
        let good=json!({"sourceProtocol":"modern","sourceProjection":"bundles-v1","parentIndexComplete":true,"accountKey":"a".repeat(64),"enumerationComplete":true,"bundles":[grouped_fixture("parent")]});assert!(decode_sync_result(&good).is_ok());
        for(field,value)in[("sourceProjection",json!("positions-v1")),("parentIndexComplete",json!(false)),("parentIndexComplete",json!("true"))]{let mut bad=good.clone();bad[field]=value;assert!(decode_sync_result(&bad).is_err());}
        for field in ["sourceProjection","parentIndexComplete"]{let mut bad=good.clone();bad.as_object_mut().unwrap().remove(field);assert!(decode_sync_result(&bad).is_err());}
        for id in ["content-parent","group-parent","vault-parent"]{let mut bad=good.clone();bad["bundles"][0]["id"]=json!(id);assert!(decode_sync_result(&bad).is_err());}
        for url in ["https://www.humblebundle.com/home/library/content/parent","https://www.humblebundle.com/home/library/different","https://www.humblebundle.com/home/library/parent?x=1","https://u:p@www.humblebundle.com/home/library/parent"]{let mut bad=good.clone();bad["bundles"][0]["sourceUrl"]=json!(url);assert!(decode_sync_result(&bad).is_err());}
        let longest=grouped_fixture(&"x".repeat(256));assert_eq!(longest.id.len(),263);assert!(validate_parent_bundles(&[longest.clone()]).is_ok());let mut too_long=grouped_fixture(&"x".repeat(257));assert!(validate_parent_bundles(&[too_long.clone()]).is_err());too_long.id="x".repeat(263);assert!(validate_bundles(&[too_long]).is_err());let mut wrong_route=longest;wrong_route.source_url=Some("https://www.humblebundle.com/home/library/other".into());assert!(validate_bundles(&[wrong_route]).is_err());
    }
    #[test] fn same_account_partial_preserves_unreached_rows_known_codes_and_full_sync_time() {
        let key="a".repeat(64);let unseen=grouped_fixture("unreached");let mut first=grouped_fixture("first");first.purchased_at=Some("2026-01-02T03:04:05Z".into());
        let mut library=Library{loaded:true,bundles:vec![first,unseen],account_key:Some(key.clone()),enumeration_complete:Some(true),last_sync:Some("SYNTHETIC-OLD-TIME".into()),source_projection:Some(crate::storage::SourceProjection::BundlesV1),..Library::default()};
        let mut incoming=grouped_fixture("first");incoming.items[0].key=None;incoming.items[0].status="hidden".into();
        let result=SyncResult{bundles:vec![incoming],account_key:Some(key.clone()),enumeration_complete:false,timestamp:Some("SYNTHETIC-NEW-TIME".into()),source_projection:Some(crate::storage::SourceProjection::BundlesV1)};
        let status=apply_sync_result(&mut library,result,&AtomicBool::new(false),|stored,archive|{assert!(archive.is_none());assert_eq!(stored.bundles.len(),2);assert_eq!(stored.last_sync.as_deref(),Some("SYNTHETIC-OLD-TIME"));Ok(())}).unwrap();
        assert_eq!(status.enumeration_complete,Some(false));assert_eq!(status.bundles.len(),2);assert_eq!(status.bundles[0].items[0].key.as_deref(),Some("TEST-ONLY-KEY"));assert_eq!(status.bundles[0].purchased_at.as_deref(),Some("2026-01-02T03:04:05Z"));assert!(status.warning.is_some());assert!(!serde_json::to_string(&status).unwrap().contains(&key));
        let mut fresh=grouped_fixture("first");fresh.items.clear();
        let status=apply_sync_result(&mut library,SyncResult{bundles:vec![fresh],account_key:Some(key),enumeration_complete:true,timestamp:Some("SYNTHETIC-FULL-TIME".into()),source_projection:Some(crate::storage::SourceProjection::BundlesV1)},&AtomicBool::new(false),|_,_|Ok(())).unwrap();
        assert_eq!(status.bundles.len(),1);assert_eq!(status.bundles[0].items[0].key.as_deref(),Some("TEST-ONLY-KEY"));assert_eq!(status.bundles[0].purchased_at.as_deref(),Some("2026-01-02T03:04:05Z"));assert_eq!(status.last_sync.as_deref(),Some("SYNTHETIC-FULL-TIME"));assert!(status.warning.is_none());
    }
    #[test] fn unknown_or_different_account_archives_before_replacement_without_key_mixing() {
        for previous_key in [None,Some("a".repeat(64))]{
            let mut cached=grouped_fixture("first");cached.purchased_at=Some("2026-01-02T03:04:05Z".into());let mut library=Library{loaded:true,bundles:vec![cached],account_key:previous_key,enumeration_complete:Some(true),last_sync:Some("OLD".into()),..Library::default()};
            let mut incoming=grouped_fixture("first");incoming.items[0].key=None;incoming.items[0].status="hidden".into();
            let result=SyncResult{bundles:vec![incoming.clone()],account_key:Some("b".repeat(64)),enumeration_complete:false,timestamp:Some("NEW".into()),source_projection:Some(crate::storage::SourceProjection::BundlesV1)};
            let before=serde_json::to_vec(&library.bundles).unwrap();
            assert!(apply_sync_result(&mut library,result,&AtomicBool::new(false),|_,archive|{assert_eq!(archive.unwrap().bundles[0].items[0].key.as_deref(),Some("TEST-ONLY-KEY"));Err("SYNTHETIC-ARCHIVE-FAILURE".into())}).is_err());
            assert_eq!(serde_json::to_vec(&library.bundles).unwrap(),before);
            let result=SyncResult{bundles:vec![incoming],account_key:Some("b".repeat(64)),enumeration_complete:false,timestamp:Some("NEW".into()),source_projection:Some(crate::storage::SourceProjection::BundlesV1)};
            let status=apply_sync_result(&mut library,result,&AtomicBool::new(false),|_,archive|{assert!(archive.is_some());Ok(())}).unwrap();
            assert!(status.bundles[0].items[0].key.is_none());assert!(status.bundles[0].purchased_at.is_none());assert_eq!(status.last_sync,None);assert!(library.retained_licenses.is_empty());
        }
    }
    #[test] fn cancellation_at_commit_does_not_persist_or_replace_old_state() {
        let mut library=Library{loaded:true,bundles:vec![bundle()],account_key:Some("a".repeat(64)),..Library::default()};let before=serde_json::to_vec(&library.bundles).unwrap();let called=std::cell::Cell::new(false);
        let result=apply_sync_result(&mut library,SyncResult{bundles:Vec::new(),account_key:Some("a".repeat(64)),enumeration_complete:true,timestamp:None,source_projection:Some(crate::storage::SourceProjection::BundlesV1)},&AtomicBool::new(true),|_,_|{called.set(true);Ok(())});
        assert_eq!(result.err(),Some(error("cancelled")));assert!(!called.get());assert_eq!(serde_json::to_vec(&library.bundles).unwrap(),before);
    }
    #[test] fn reset_status_keeps_unknown_distinct_from_known_incomplete() {
        let reset=library_status(&Library{loaded:true,auth_state:AuthState::Unauthenticated,..Library::default()});
        assert_eq!(reset.enumeration_complete,None);assert!(reset.warning.is_none());assert_eq!(serde_json::to_value(&reset).unwrap().get("enumerationComplete"),Some(&Value::Null));
        let partial=library_status(&Library{loaded:true,account_key:Some("a".repeat(64)),enumeration_complete:Some(false),source_projection:Some(crate::storage::SourceProjection::BundlesV1),..Library::default()});
        assert_eq!(partial.enumeration_complete,Some(false));assert!(partial.warning.is_some());assert_eq!(serde_json::to_value(&partial).unwrap().get("enumerationComplete"),Some(&Value::Bool(false)));
    }
    #[test] fn new_sync_metadata_activity_and_warning_contracts_reject_unbounded_or_private_fields() {
        let valid=json!({"sourceProtocol":"modern","sourceProjection":"bundles-v1","parentIndexComplete":true,"accountKey":"a".repeat(64),"enumerationComplete":false,"bundles":[],"syncedAt":"SYNTHETIC"});assert!(decode_sync_result(&valid).is_ok());
        for (field,value) in [("accountKey",json!("private")),("sourceProtocol",json!("other")),("enumerationComplete",json!("true"))]{let mut invalid=valid.clone();invalid[field]=value;assert!(decode_sync_result(&invalid).is_err());}
        assert!(decode_sync_result(&json!({"sourceProtocol":"legacy","enumerationComplete":true,"bundles":[]})).is_ok());assert!(decode_sync_result(&json!({"sourceProtocol":"legacy","enumerationComplete":false,"bundles":[]})).is_err());
        assert!(library_incomplete_warning(&Library{account_key:Some("a".repeat(64)),enumeration_complete:Some(false),..Library::default()}).is_some());assert!(library_incomplete_warning(&Library{enumeration_complete:Some(false),..Library::default()}).is_none());
        let activity=json!({"kind":"syncActivity","phase":"purchasedPage","state":"reading","attempt":1,"delayMs":0});assert!(sync_activity_payload("sync",&activity).is_some());assert!(sync_activity_payload("auth",&activity).is_none());
        for (field,value) in [("attempt",json!(5)),("delayMs",json!(1)),("reason",json!("service")),("body",json!("PRIVATE")),("phase",json!("PRIVATE"))]{let mut invalid=activity.clone();invalid[field]=value;assert!(sync_activity_payload("sync",&invalid).is_none());}
        let waiting=json!({"kind":"syncActivity","phase":"purchasedPage","state":"waiting","attempt":2,"delayMs":60000,"reason":"rateLimited"});assert!(sync_activity_payload("sync",&waiting).is_some());
        let warning=json!({"kind":"syncWarning","phase":"purchasedSchema","reason":"service","protocolCode":"libraryRejected","httpStatus":200,"requestedPage":19});assert!(sync_warning_diagnostic("sync",&warning).is_some());assert!(sync_warning_diagnostic("auth",&warning).is_none());
        for (field,value) in [("requestedPage",json!(2001)),("protocolCode",json!("PRIVATE")),("url",json!("PRIVATE"))]{let mut invalid=warning.clone();invalid[field]=value;assert!(sync_warning_diagnostic("sync",&invalid).is_none());}
        let detail=json!({"kind":"syncWarning","phase":"detailSchema","reason":"protocol","protocolCode":"detailComponents","detailComponentsCount":0,"completedDetails":2,"totalDetails":3});assert!(sync_warning_diagnostic("sync",&detail).is_some());
        for(field,value)in[("phase",json!("purchasedPage")),("requestedPage",json!(1)),("completedDetails",json!(4)),("totalDetails",json!("3")),("detailComponentsCount",json!(10001))]{let mut invalid=detail.clone();invalid[field]=value;assert!(sync_warning_diagnostic("sync",&invalid).is_none());}
    }
    #[test] fn sync_watchdog_times_out_silence_and_renews_activity_without_extending_absolute_limit() {
        tauri::async_runtime::block_on(async{
            let state=HumbleState::default();let(sender,receiver)=oneshot::channel();*state.pending.lock().unwrap()=Some(Pending::new("quiet".into(),"sync".into(),sender));
            assert!(receive_sync(receiver,&state,"quiet",Duration::from_millis(20),Duration::from_millis(300)).await.is_err());
            let state=std::sync::Arc::new(HumbleState::default());let(sender,receiver)=oneshot::channel();*state.pending.lock().unwrap()=Some(Pending::new("renew".into(),"sync".into(),sender));let publisher=state.clone();
            let task=tauri::async_runtime::spawn(async move{for _ in 0..4{tokio::time::sleep(Duration::from_millis(40)).await;publisher.pending.lock().unwrap().as_mut().unwrap().last_activity=tokio::time::Instant::now();}publisher.pending.lock().unwrap().take().unwrap().sender.send(json!({"ok":true})).unwrap();});
            assert_eq!(receive_sync(receiver,&state,"renew",Duration::from_millis(120),Duration::from_millis(500)).await.unwrap(),json!({"ok":true}));task.await.unwrap();
            let state=HumbleState::default();let(sender,receiver)=oneshot::channel();*state.pending.lock().unwrap()=Some(Pending::new("absolute".into(),"sync".into(),sender));assert!(receive_sync(receiver,&state,"absolute",Duration::from_secs(5),Duration::from_millis(20)).await.is_err());
        });
    }
    #[test] fn origin_is_exact() { for url in ["https://www.humblebundle.com/home/keys", "https://www.humblebundle.com:443/home", "https://humblebundle.com/", "https://humblebundle.com:443/home"] { assert!(official(&url.parse().unwrap())); } for url in ["https://www.humblebundle.com.evil.test/", "http://www.humblebundle.com/", "https://auth.humblebundle.com/login", "https://humblebundle.com:444/", "https://www.humblebundle.com:444/", "https://u:p@www.humblebundle.com/"] { assert!(!official(&url.parse().unwrap())); } }
    #[test] fn platforms_are_not_whitelisted() { for platform in ["Steam", "GOG", "Unity Asset Store", "Unknown vendor", "Издатель"] { let mut b = bundle(); b.items[0].platform = platform.into(); assert!(validate_bundles(&[b]).is_ok()); } }
    #[test] fn key_contents_are_not_steam_shaped() { for key in ["aB-cD", "license@example.test", "12345678901234567890", "https://vendor.test/redeem?token=fixture", "{\"code\":\"fixture\",\"password\":\"fixture\"}"] { let mut b=bundle(); b.items[0].key=Some(key.into()); assert!(validate_bundles(&[b]).is_ok()); } }
    #[test] fn hidden_never_claims_to_have_key() { let mut b=bundle(); b.items[0].status="hidden".into(); assert!(validate_bundles(&[b.clone()]).is_err()); b.items[0].key=None; assert!(validate_bundles(&[b]).is_ok()); }
    #[test] fn duplicates_and_hostile_metadata_rejected() { let b=bundle(); assert!(validate_bundles(&[b.clone(),b.clone()]).is_err()); let mut c=b.clone(); c.items.push(c.items[0].clone()); assert!(validate_bundles(&[c]).is_err()); let mut c=b.clone(); c.image_url="javascript:alert(1)".into(); assert!(validate_bundles(&[c]).is_err()); let mut c=b; c.items[0].redeem_url=Some("https://u:p@example.test/".into()); assert!(validate_bundles(&[c]).is_err()); }
    #[test] fn secret_service_text_is_not_an_error_message() { let secret="PRIVATE-KEY-FIXTURE"; assert!(!error(secret).contains(secret)); }
}
