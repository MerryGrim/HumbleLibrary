//! Native acknowledgement for the account bridge, without exposing page data.
use serde_json::Value;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::WebviewWindow;
use tokio::sync::oneshot;

const ACK_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DispatchError {
    WrongOrigin,
    MissingBridge,
    MissingTransport,
    Busy,
    ScriptError,
    TimedOut,
}

impl DispatchError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::WrongOrigin => "AUTH_WRONG_ORIGIN",
            Self::MissingBridge => "AUTH_BRIDGE_MISSING",
            Self::MissingTransport => "AUTH_IPC_MISSING",
            Self::Busy => "AUTH_BRIDGE_BUSY",
            Self::ScriptError => "AUTH_SCRIPT_ERROR",
            Self::TimedOut => "AUTH_SCRIPT_TIMEOUT",
        }
    }
}

fn decode_ack(raw: &str) -> Result<(), DispatchError> {
    // ExecuteScript already JSON-encodes its result. Accept only this closed
    // vocabulary; page strings, objects, URLs and exception text are discarded.
    let value: String = serde_json::from_str(raw).map_err(|_| DispatchError::ScriptError)?;
    match value.as_str() {
        "dispatched" => Ok(()),
        "wrong_origin" => Err(DispatchError::WrongOrigin),
        "missing_bridge" => Err(DispatchError::MissingBridge),
        "missing_transport" => Err(DispatchError::MissingTransport),
        "busy" => Err(DispatchError::Busy),
        _ => Err(DispatchError::ScriptError),
    }
}

fn dispatch_script(args: &Value, bootstrap: bool) -> Result<String, DispatchError> {
    let args = serde_json::to_string(args).map_err(|_| DispatchError::ScriptError)?;
    if args.len() > 64 * 1024 { return Err(DispatchError::ScriptError); }
    let bootstrap = if bootstrap {
        format!(r#"
            if (typeof window.__humbleLibraryFlight?.read !== 'function'
                || typeof window.__humbleLibraryFlight?.decode !== 'function') {{
                {}
            }}
            if (typeof window.__humbleLibraryPage?.decodeLibraryHtml !== 'function'
                || typeof window.__humbleLibraryPage?.scriptPathsFromHtml !== 'function') {{
                {}
            }}
            if (typeof window.__humbleLibraryItems?.normalize !== 'function'
                || typeof window.__humbleLibraryItems?.normalizeVault !== 'function') {{
                {}
            }}
            if (typeof window.__humbleLibrarySync?.run !== 'function') {{
                {}
            }}
            if (typeof window.__humbleLibraryBundleImage !== 'function') {{
                {}
            }}
            if (typeof window.__humbleLibraryRequest !== 'function') {{
                {}
            }}
        "#, include_str!("humble_flight.js"), include_str!("humble_page.js"), include_str!("humble_items.js"), include_str!("humble_sync.js"), include_str!("humble_bundle_images.js"), include_str!("humble_bridge.js"))
    } else {
        String::new()
    };
    Ok(format!(r#"(() => {{
        try {{
            if (window.top !== window || ![
                'https://www.humblebundle.com', 'https://humblebundle.com'
            ].includes(location.origin)) return 'wrong_origin';
            {bootstrap}
            if (typeof window.__humbleLibraryRequest !== 'function'
                || typeof window.__humbleLibraryFlight?.read !== 'function'
                || typeof window.__humbleLibraryFlight?.decode !== 'function'
                || typeof window.__humbleLibraryPage?.decodeLibraryHtml !== 'function'
                || typeof window.__humbleLibraryPage?.scriptPathsFromHtml !== 'function'
                || typeof window.__humbleLibraryItems?.normalize !== 'function'
                || typeof window.__humbleLibraryItems?.normalizeVault !== 'function'
                || typeof window.__humbleLibrarySync?.run !== 'function'
                || typeof window.__humbleLibraryBundleImage !== 'function') return 'missing_bridge';
            if (typeof window.__TAURI_INTERNALS__?.invoke !== 'function') return 'missing_transport';
            if (typeof window.__humbleLibraryBridgeState === 'function'
                && window.__humbleLibraryBridgeState() === 'busy') return 'busy';
            const pending = window.__humbleLibraryRequest({args});
            if (pending && typeof pending.catch === 'function') pending.catch(() => {{}});
            return 'dispatched';
        }} catch (_) {{ return 'script_error'; }}
    }})()"#))
}

async fn evaluate_ack(window: &WebviewWindow, script: String) -> Result<(), DispatchError> {
    let (sender, receiver) = oneshot::channel();
    // Tauri's callback is Fn, while oneshot sends once. Never return any raw
    // result to a log or UI, including when the page was replaced during eval.
    let sender = Arc::new(Mutex::new(Some(sender)));
    window.eval_with_callback(script, move |raw| {
        if let Ok(mut sender) = sender.lock() {
            if let Some(sender) = sender.take() { let _ = sender.send(decode_ack(&raw)); }
        }
    }).map_err(|_| DispatchError::ScriptError)?;
    match tokio::time::timeout(ACK_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(DispatchError::ScriptError),
        Err(_) => Err(DispatchError::TimedOut),
    }
}

async fn dispatch_using<E, F>(args: &Value, mut evaluate: E) -> Result<(), DispatchError>
where E: FnMut(String) -> F, F: Future<Output = Result<(), DispatchError>> {
    let result = evaluate(dispatch_script(args, false)?).await;
    if result != Err(DispatchError::MissingBridge) { return result; }
    // A late document initialization may omit the normal startup injection.
    // This acknowledgement is returned before invoking the request. Only that
    // case permits one bootstrap attempt; an uncertain dispatch is never sent again.
    evaluate(dispatch_script(args, true)?).await
}

pub(crate) async fn dispatch(window: &WebviewWindow, args: &Value) -> Result<(), DispatchError> {
    dispatch_using(args, |script| evaluate_ack(window, script)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acknowledgement_accepts_only_the_closed_json_string_vocabulary() {
        assert_eq!(decode_ack(r#""dispatched""#), Ok(()));
        assert_eq!(decode_ack(r#""wrong_origin""#), Err(DispatchError::WrongOrigin));
        assert_eq!(decode_ack(r#""missing_bridge""#), Err(DispatchError::MissingBridge));
        assert_eq!(decode_ack(r#""missing_transport""#), Err(DispatchError::MissingTransport));
        assert_eq!(decode_ack(r#""busy""#), Err(DispatchError::Busy));
        for raw in ["", "null", "true", "42", "{}", "[]", r#"{"status":"dispatched"}"#, r#""untrusted page error""#, r#""https://example.test/?secret=value""#, r#""script_error""#] {
            assert_eq!(decode_ack(raw), Err(DispatchError::ScriptError));
        }
    }

    #[test]
    fn diagnostic_codes_contain_only_fixed_application_text() {
        for error in [DispatchError::WrongOrigin, DispatchError::MissingBridge, DispatchError::MissingTransport, DispatchError::Busy, DispatchError::ScriptError, DispatchError::TimedOut] {
            assert!(error.code().starts_with("AUTH_"));
            assert!(error.code().bytes().all(|byte| byte.is_ascii_uppercase() || byte == b'_'));
        }
    }

    #[test]
    fn serialized_arguments_cannot_escape_into_the_dispatch_script() {
        let args = serde_json::json!({"nonce":"synthetic", "value":"\"; globalThis.canary = true; //"});
        let script = dispatch_script(&args, false).unwrap();
        assert!(script.contains(&serde_json::to_string(&args).unwrap()));
        assert!(!script.contains("console."));
        assert!(!script.contains("document.cookie"));
    }

    #[test]
    fn uncertain_or_accepted_dispatch_is_never_replayed() {
        for result in [Ok(()), Err(DispatchError::WrongOrigin), Err(DispatchError::MissingTransport), Err(DispatchError::Busy), Err(DispatchError::ScriptError), Err(DispatchError::TimedOut)] {
            let calls = std::cell::Cell::new(0);
            let actual = tauri::async_runtime::block_on(dispatch_using(&serde_json::json!({"operation":"sync"}), |_| {
                calls.set(calls.get() + 1);
                std::future::ready(result)
            }));
            assert_eq!(actual, result);
            assert_eq!(calls.get(), 1);
        }
    }

    #[test]
    fn only_pre_dispatch_missing_dependencies_allow_one_bootstrap() {
        let calls = std::cell::RefCell::new(Vec::new());
        let actual = tauri::async_runtime::block_on(dispatch_using(&serde_json::json!({"operation":"auth"}), |script| {
            calls.borrow_mut().push(script);
            std::future::ready(Err(DispatchError::MissingBridge))
        }));
        assert_eq!(actual, Err(DispatchError::MissingBridge));
        assert_eq!(calls.borrow().len(), 2);
        assert!(!calls.borrow()[0].contains("Data-only subset of React Flight"));
        assert!(calls.borrow()[1].contains("Data-only subset of React Flight"));
        for script in calls.borrow().iter() {
            let guard = script.find("return 'missing_bridge'").unwrap();
            let invoke = script.rfind("const pending = window.__humbleLibraryRequest").unwrap();
            assert!(guard < invoke);
        }
        assert!(ACK_TIMEOUT <= Duration::from_secs(3));
    }
}
