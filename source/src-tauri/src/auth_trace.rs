//! Closed, local diagnostics for the sign-in lifecycle. No page/account data.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

const MAX_EVENTS: usize = 64;
const MAX_REPORT_BYTES: usize = 16 * 1024;
static TRACE: LazyLock<Mutex<Option<Trace>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Stage {
    LoginStarted,
    StorefrontWww,
    StorefrontApex,
    IdentityProvider,
    OtherPage,
    DispatchAccepted,
    ProbeRejected,
    ProbeNoReply,
    SessionConfirmed,
    LoginCompleted,
    LoginCancelled,
    LoginTimedOut,
    SyncStarted,
    SyncCompleted,
    SyncPartial,
    SyncRetry,
    SyncFailed,
    LibraryPage,
    LibrarySchema,
    ActionDiscovery,
    PurchasedPage,
    PurchasedWire,
    PurchasedSchema,
    PurchasedIdentity,
    PurchasedComplete,
    DetailPage,
    DetailSchema,
    KeySchema,
}

pub(crate) fn purchased_phase(stage: Stage) -> bool {
    matches!(stage, Stage::PurchasedPage | Stage::PurchasedWire | Stage::PurchasedSchema | Stage::PurchasedIdentity | Stage::PurchasedComplete)
}

pub(crate) fn detail_phase(stage: Stage) -> bool {
    matches!(stage, Stage::DetailPage | Stage::DetailSchema | Stage::KeySchema)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SyncFailureContext {
    requested_page: Option<u16>,
    page_rows: Option<u16>,
    overlap_rows: Option<u16>,
    detail_components_count: Option<u16>,
    completed_details: Option<u16>,
    total_details: Option<u16>,
}

impl SyncFailureContext {
    pub(crate) fn new(requested_page: Option<u64>, page_rows: Option<u64>, overlap_rows: Option<u64>) -> Option<Self> {
        if requested_page.is_some_and(|value| !(1..=2000).contains(&value))
            || page_rows.is_some_and(|value| value > 10_000)
            || overlap_rows.is_some_and(|value| value > 10_000)
            || page_rows.zip(overlap_rows).is_some_and(|(rows, overlap)| overlap > rows) { return None; }
        if requested_page.is_none() && page_rows.is_none() && overlap_rows.is_none() { return None; }
        Some(Self {
            requested_page: requested_page.map(|value| value as u16),
            page_rows: page_rows.map(|value| value as u16),
            overlap_rows: overlap_rows.map(|value| value as u16),
            detail_components_count: None,
            completed_details: None,
            total_details: None,
        })
    }

    pub(crate) fn new_detail(detail_components_count: Option<u64>, completed_details: Option<u64>, total_details: Option<u64>) -> Option<Self> {
        if detail_components_count.is_some_and(|value| value > 10_000)
            || completed_details.is_some_and(|value| value > 10_000)
            || total_details.is_some_and(|value| value > 10_000)
            || completed_details.zip(total_details).is_some_and(|(completed, total)| completed > total) { return None; }
        if detail_components_count.is_none() && completed_details.is_none() && total_details.is_none() { return None; }
        Some(Self {
            requested_page: None,
            page_rows: None,
            overlap_rows: None,
            detail_components_count: detail_components_count.map(|value| value as u16),
            completed_details: completed_details.map(|value| value as u16),
            total_details: total_details.map(|value| value as u16),
        })
    }
}

/// Only application-owned sync phases can become persisted diagnostic stages.
pub(crate) fn sync_failure_stage(phase: &str) -> Option<Stage> {
    Some(match phase {
        "libraryPage" => Stage::LibraryPage,
        "librarySchema" => Stage::LibrarySchema,
        "actionDiscovery" => Stage::ActionDiscovery,
        "purchasedPage" => Stage::PurchasedPage,
        "purchasedWire" => Stage::PurchasedWire,
        "purchasedSchema" => Stage::PurchasedSchema,
        "purchasedIdentity" => Stage::PurchasedIdentity,
        "purchasedComplete" => Stage::PurchasedComplete,
        "detailPage" => Stage::DetailPage,
        "detailSchema" => Stage::DetailSchema,
        "keySchema" => Stage::KeySchema,
        _ => return None,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Code {
    AuthRejected,
    RateLimited,
    Network,
    Protocol,
    Service,
    Cancelled,
    WrongOrigin,
    MissingBridge,
    MissingTransport,
    ScriptError,
    ScriptTimeout,
    ReplyTimeout,
    FlightWire,
    FlightEnvelope,
    FlightServerError,
    FlightReference,
    FlightScalar,
    FlightType,
    LibraryPagination,
    LibraryEntry,
    LibraryIdentity,
    LibraryRejected,
    LibraryResponse,
    DetailEnvelope,
    DetailComponents,
    DetailEntry,
    DetailIdentity,
}

pub(crate) fn protocol_code(code: &str) -> Option<Code> {
    Some(match code {
        "flightWire" => Code::FlightWire,
        "flightEnvelope" => Code::FlightEnvelope,
        "flightServerError" => Code::FlightServerError,
        "flightReference" => Code::FlightReference,
        "flightScalar" => Code::FlightScalar,
        "flightType" => Code::FlightType,
        "libraryPagination" => Code::LibraryPagination,
        "libraryEntry" => Code::LibraryEntry,
        "libraryIdentity" => Code::LibraryIdentity,
        "libraryRejected" => Code::LibraryRejected,
        "libraryResponse" => Code::LibraryResponse,
        "detailEnvelope" => Code::DetailEnvelope,
        "detailComponents" => Code::DetailComponents,
        "detailEntry" => Code::DetailEntry,
        "detailIdentity" => Code::DetailIdentity,
        _ => return None,
    })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Event {
    elapsed_ms: u64,
    stage: Stage,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<Code>,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundle_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    requested_page: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_rows: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    overlap_rows: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail_components_count: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_details: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_details: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_phase: Option<Stage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    delay_ms: Option<u32>,
}

struct Trace {
    started: Instant,
    events: VecDeque<Event>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    schema: u8,
    app_version: &'static str,
    events: &'a VecDeque<Event>,
}

impl Trace {
    fn new() -> Self { Self { started: Instant::now(), events: VecDeque::new() } }

    fn push(&mut self, stage: Stage, code: Option<Code>, http_status: Option<u16>, bundle_count: Option<usize>) {
        if self.events.len() == MAX_EVENTS { self.events.pop_front(); }
        self.events.push_back(Event {
            elapsed_ms: self.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            stage,
            code,
            http_status: http_status.filter(|status| (100..=599).contains(status)),
            bundle_count: if matches!(stage,Stage::SyncCompleted|Stage::SyncPartial) {
                bundle_count.filter(|count| *count <= 10_000).map(|count| count as u32)
            } else { None },
            requested_page: None,
            page_rows: None,
            overlap_rows: None,
            detail_components_count: None,
            completed_details: None,
            total_details: None,
            retry_phase:None,attempt:None,delay_ms:None,
        });
    }

    fn push_with_context(&mut self, stage: Stage, code: Option<Code>, http_status: Option<u16>, bundle_count: Option<usize>, context: Option<SyncFailureContext>) {
        self.push(stage, code, http_status, bundle_count);
        if purchased_phase(stage) {
            if let (Some(event), Some(context)) = (self.events.back_mut(), context) {
                event.requested_page = context.requested_page;
                event.page_rows = context.page_rows;
                event.overlap_rows = context.overlap_rows;
            }
        }
        if detail_phase(stage) {
            if let (Some(event), Some(context)) = (self.events.back_mut(), context) {
                event.detail_components_count = context.detail_components_count;
                event.completed_details = context.completed_details;
                event.total_details = context.total_details;
            }
        }
    }

    fn serialize(&self) -> Option<Vec<u8>> {
        let bytes = serde_json::to_vec_pretty(&Report { schema: 1, app_version: env!("CARGO_PKG_VERSION"), events: &self.events }).ok()?;
        (bytes.len() <= MAX_REPORT_BYTES).then_some(bytes)
    }
}

fn persist(trace: &Trace) {
    let Some(bytes) = trace.serialize() else { return; };
    let folder = crate::storage::root().join("Diagnostics");
    if fs::create_dir_all(&folder).is_err() { return; }
    let temporary = folder.join(format!(".auth-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_data()?;
        drop(file);
        fs::rename(&temporary, folder.join("auth-last.json"))
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
}

/// Start a new report only for a user-requested sign-in attempt.
pub(crate) fn begin() {
    let Ok(mut current) = TRACE.lock() else { return; };
    let mut trace = Trace::new();
    trace.push(Stage::LoginStarted, None, None, None);
    persist(&trace);
    *current = Some(trace);
}

/// Inputs are enums and bounded numbers; callers cannot pass URLs or text.
/// The mutex keeps snapshots ordered. Disk errors never affect authentication.
pub(crate) fn record(stage: Stage, code: Option<Code>, http_status: Option<u16>, bundle_count: Option<usize>) {
    record_event(stage, code, http_status, bundle_count, None);
}

pub(crate) fn record_sync_failure(stage: Stage, code: Code, http_status: Option<u16>, context: Option<SyncFailureContext>) {
    record_event(stage, Some(code), http_status, None, context);
}
pub(crate) fn record_retry(phase:Stage,code:Option<Code>,attempt:u8,delay_ms:u32){
    if !(1..=4).contains(&attempt)||delay_ms>60000||sync_failure_stage(serde_json::to_value(phase).ok().and_then(|value|value.as_str().map(str::to_owned)).as_deref().unwrap_or("")).is_none(){return}
    let Ok(mut current)=TRACE.lock()else{return};let Some(trace)=current.as_mut()else{return};
    trace.push(Stage::SyncRetry,code,None,None);if let Some(event)=trace.events.back_mut(){event.retry_phase=Some(phase);event.attempt=Some(attempt);event.delay_ms=Some(delay_ms)}persist(trace);
}

fn record_event(stage: Stage, code: Option<Code>, http_status: Option<u16>, bundle_count: Option<usize>, context: Option<SyncFailureContext>) {
    let Ok(mut current) = TRACE.lock() else { return; };
    let Some(trace) = trace_for_stage(&mut current, stage) else { return; };
    trace.push_with_context(stage, code, http_status, bundle_count, context);
    persist(trace);
}

fn trace_for_stage(current: &mut Option<Trace>, stage: Stage) -> Option<&mut Trace> {
    // A manual refresh can run after restart without opening sign-in again.
    // Keep that attempt diagnosable without inventing a login or replacing an
    // active sign-in trace. Other isolated callbacks never start a report.
    if current.is_none() && stage == Stage::SyncStarted { *current = Some(Trace::new()); }
    current.as_mut()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_keeps_only_the_bounded_recent_events() {
        let mut trace = Trace::new();
        for _ in 0..MAX_EVENTS + 10 { trace.push(Stage::ProbeRejected, Some(Code::AuthRejected), Some(401), None); }
        assert_eq!(trace.events.len(), MAX_EVENTS);
        let bytes = trace.serialize().unwrap();
        assert!(bytes.len() <= MAX_REPORT_BYTES);
        let report: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(report["schema"], 1);
        assert_eq!(report["events"].as_array().unwrap().len(), MAX_EVENTS);
        let mut fields: Vec<_> = report.as_object().unwrap().keys().map(String::as_str).collect();
        fields.sort_unstable();
        assert_eq!(fields, ["appVersion", "events", "schema"]);
    }

    #[test]
    fn diagnostics_drop_invalid_status_and_oversize_counts() {
        let mut trace = Trace::new();
        trace.push(Stage::SyncFailed, Some(Code::Protocol), Some(99), Some(10_001));
        trace.push(Stage::SyncCompleted, None, Some(599), Some(10_000));
        trace.push(Stage::ProbeRejected, Some(Code::ReplyTimeout), Some(600), Some(3));
        let invalid = &trace.events[0];
        assert_eq!(invalid.http_status, None);
        assert_eq!(invalid.bundle_count, None);
        let valid = &trace.events[1];
        assert_eq!(valid.http_status, Some(599));
        assert_eq!(valid.bundle_count, Some(10_000));
        assert_eq!(trace.events[2].http_status, None);
        assert_eq!(trace.events[2].bundle_count, None);
    }

    #[test]
    fn diagnostic_schema_rejects_arbitrary_text_and_extra_fields() {
        for raw in [
            r#"{"elapsedMs":0,"stage":"https://example.test/","code":null}"#,
            r#"{"elapsedMs":0,"stage":"probeRejected","code":"arbitrary private text"}"#,
            r#"{"elapsedMs":0,"stage":"probeRejected","url":"https://example.test/"}"#,
            r#"{"elapsedMs":0,"stage":"probeRejected","body":"arbitrary private text"}"#,
        ] { assert!(serde_json::from_str::<Event>(raw).is_err()); }
        let event: Event = serde_json::from_str(r#"{"elapsedMs":0,"stage":"probeRejected","code":"authRejected","httpStatus":401}"#).unwrap();
        assert_eq!(event.stage, Stage::ProbeRejected);
        assert_eq!(event.code, Some(Code::AuthRejected));
    }

    #[test]
    fn sync_phases_use_only_the_closed_stage_vocabulary() {
        for phase in ["libraryPage", "librarySchema", "actionDiscovery", "purchasedPage", "purchasedWire", "purchasedSchema", "purchasedIdentity", "purchasedComplete", "detailPage", "detailSchema", "keySchema"] {
            let stage = sync_failure_stage(phase).unwrap();
            assert_eq!(serde_json::to_value(stage).unwrap(), serde_json::json!(phase));
            let mut trace = Trace::new();
            trace.push(stage, Some(Code::Protocol), Some(200), Some(10));
            let report: serde_json::Value = serde_json::from_slice(&trace.serialize().unwrap()).unwrap();
            let event = &report["events"][0];
            assert_eq!(event["stage"], phase);
            assert!(event.get("bundleCount").is_none());
            assert!(event.get("phase").is_none());
        }
        for phase in ["", "syncStarted", "LibraryPage", "libraryPage?token=private", "https://example.test/", "arbitrary private text"] {
            assert_eq!(sync_failure_stage(phase), None);
        }
    }

    #[test]
    fn protocol_diagnostics_use_only_fixed_codes() {
        for code in ["flightWire", "flightEnvelope", "flightServerError", "flightReference", "flightScalar", "flightType", "libraryResponse", "libraryRejected", "libraryPagination", "libraryEntry", "libraryIdentity", "detailEnvelope", "detailComponents", "detailEntry", "detailIdentity"] {
            let value = protocol_code(code).unwrap();
            assert_eq!(serde_json::to_value(value).unwrap(), serde_json::json!(code));
        }
        for value in ["", "protocol", "FlightWire", "https://example.test/private", "arbitrary private text"] { assert_eq!(protocol_code(value), None); }
    }

    #[test]
    fn manual_sync_starts_a_trace_without_replacing_an_active_login() {
        let mut current = None;
        for stage in [Stage::SyncFailed, Stage::SessionConfirmed, Stage::KeySchema] {
            assert!(trace_for_stage(&mut current, stage).is_none());
        }
        let manual = trace_for_stage(&mut current, Stage::SyncStarted).unwrap();
        manual.push(Stage::SyncStarted, None, None, None);
        assert_eq!(manual.events.len(), 1);
        assert_eq!(manual.events[0].stage, Stage::SyncStarted);

        let mut login = Trace::new();
        login.push(Stage::LoginStarted, None, None, None);
        let started = login.started;
        current = Some(login);
        let retained = trace_for_stage(&mut current, Stage::SyncStarted).unwrap();
        retained.push(Stage::SyncStarted, None, None, None);
        assert_eq!(retained.started, started);
        assert_eq!(retained.events.len(), 2);
        assert_eq!(retained.events[0].stage, Stage::LoginStarted);
    }

    #[test]
    fn sync_failure_counts_are_bounded_and_restricted_to_purchased_phases() {
        let context = SyncFailureContext::new(Some(2000), Some(10_000), Some(10_000)).unwrap();
        for values in [(Some(0),None,None),(Some(2001),None,None),(None,Some(10_001),None),(None,None,Some(10_001)),(Some(2),Some(3),Some(4))] {
            assert_eq!(SyncFailureContext::new(values.0,values.1,values.2), None);
        }
        let mut trace = Trace::new();
        trace.push_with_context(Stage::LibrarySchema, Some(Code::Protocol), Some(200), None, Some(context));
        assert_eq!(trace.events[0].requested_page, None);
        assert_eq!(trace.events[0].page_rows, None);
        assert_eq!(trace.events[0].overlap_rows, None);
        for _ in 0..MAX_EVENTS { trace.push_with_context(Stage::PurchasedIdentity, Some(Code::FlightServerError), Some(599), None, Some(context)); }
        let bytes = trace.serialize().unwrap();
        assert!(bytes.len() <= MAX_REPORT_BYTES);
        let event = trace.events.back().unwrap();
        assert_eq!((event.requested_page,event.page_rows,event.overlap_rows), (Some(2000),Some(10_000),Some(10_000)));
    }

    #[test]
    fn detail_failure_counts_are_bounded_and_restricted_to_detail_phases() {
        let context = SyncFailureContext::new_detail(Some(10_000), Some(10_000), Some(10_000)).unwrap();
        for values in [(Some(10_001),None,None),(None,Some(10_001),None),(None,None,Some(10_001)),(None,Some(3),Some(2))] {
            assert_eq!(SyncFailureContext::new_detail(values.0,values.1,values.2), None);
        }
        assert_eq!(SyncFailureContext::new_detail(None,None,None), None);
        let mut trace = Trace::new();
        for stage in [Stage::LoginCompleted,Stage::PurchasedSchema,Stage::SyncFailed] {
            trace.push_with_context(stage, Some(Code::Protocol), Some(200), None, Some(context));
            let event = trace.events.back().unwrap();
            assert_eq!((event.detail_components_count,event.completed_details,event.total_details),(None,None,None));
        }
        for stage in [Stage::DetailPage,Stage::DetailSchema,Stage::KeySchema] {
            trace.push_with_context(stage, Some(Code::DetailComponents), Some(200), None, Some(context));
            let event = trace.events.back().unwrap();
            assert_eq!((event.detail_components_count,event.completed_details,event.total_details),(Some(10_000),Some(10_000),Some(10_000)));
            assert_eq!((event.requested_page,event.page_rows,event.overlap_rows),(None,None,None));
        }
        for _ in 0..MAX_EVENTS { trace.push_with_context(Stage::DetailSchema, Some(Code::DetailComponents), Some(599), None, Some(context)); }
        assert!(trace.serialize().unwrap().len() <= MAX_REPORT_BYTES);
    }
}
