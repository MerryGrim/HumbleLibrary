//! Bounded, callback-confirmed clearing of this application's WebView2 profiles.
//! No filesystem deletion, cookie values, page contents or remote requests.
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClearKind { Cache, AllProfile }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClearError { Unavailable, Failed, Interrupted, TimedOut }

impl ClearError {
    pub(crate) fn uncertain(self) -> bool { matches!(self, Self::Interrupted | Self::TimedOut) }
}

type Completion = Arc<Mutex<Option<oneshot::Sender<Result<(), ClearError>>>>>;

fn complete(completion: &Completion, result: Result<(), ClearError>) {
    if let Ok(mut sender) = completion.lock() {
        if let Some(sender) = sender.take() { let _ = sender.send(result); }
    }
}

#[cfg(windows)]
fn kinds(kind: ClearKind) -> webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_BROWSING_DATA_KINDS {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match kind {
        ClearKind::Cache => COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE,
        ClearKind::AllProfile => COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE,
    }
}

pub(crate) async fn clear(window: &tauri::WebviewWindow, kind: ClearKind) -> Result<(), ClearError> {
    #[cfg(not(windows))]
    { let _ = (window, kind); Err(ClearError::Unavailable) }
    #[cfg(windows)]
    {
        use webview2_com::{ClearBrowsingDataCompletedHandler, Microsoft::Web::WebView2::Win32::{ICoreWebView2_13, ICoreWebView2Profile2}};
        use windows::core::Interface;
        let (sender, receiver) = oneshot::channel();
        let completion = Arc::new(Mutex::new(Some(sender)));
        // with_webview runs its closure on the WebView's UI thread. COM objects
        // and the completion handler are created and used only on that thread.
        window.with_webview(move |webview| {
            let profile = unsafe {
                webview.controller().CoreWebView2()
                    .and_then(|core| core.cast::<ICoreWebView2_13>())
                    .and_then(|core| core.Profile())
                    .and_then(|profile| profile.cast::<ICoreWebView2Profile2>())
            };
            let Ok(profile) = profile else { complete(&completion, Err(ClearError::Unavailable)); return; };
            let callback_completion = completion.clone();
            let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |status| {
                complete(&callback_completion, if status.is_ok() { Ok(()) } else { Err(ClearError::Failed) });
                Ok(())
            }));
            if unsafe { profile.ClearBrowsingData(kinds(kind), &handler) }.is_err() {
                complete(&completion, Err(ClearError::Failed));
            }
        }).map_err(|_| ClearError::Unavailable)?;
        match tokio::time::timeout(Duration::from_secs(60), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ClearError::Interrupted),
            Err(_) => Err(ClearError::TimedOut),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completion_reports_the_first_real_callback_result_once() {
        let (sender, mut receiver) = oneshot::channel();
        let completion = Arc::new(Mutex::new(Some(sender)));
        complete(&completion, Err(ClearError::Failed));
        complete(&completion, Ok(()));
        assert_eq!(receiver.try_recv().unwrap(), Err(ClearError::Failed));
        assert!(completion.lock().unwrap().is_none());
    }
    #[cfg(windows)]
    #[test]
    fn cache_scope_excludes_cookies_storage_and_other_profile_data() {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        assert_eq!(kinds(ClearKind::Cache), COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE);
        for excluded in [COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES, COREWEBVIEW2_BROWSING_DATA_KINDS_LOCAL_STORAGE,
            COREWEBVIEW2_BROWSING_DATA_KINDS_INDEXED_DB, COREWEBVIEW2_BROWSING_DATA_KINDS_BROWSING_HISTORY,
            COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE] {
            assert_eq!((kinds(ClearKind::Cache) & excluded).0, 0);
        }
        assert_eq!(kinds(ClearKind::AllProfile), COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE);
        assert!(ClearError::TimedOut.uncertain());
        assert!(ClearError::Interrupted.uncertain());
        assert!(!ClearError::Failed.uncertain());
    }
}
