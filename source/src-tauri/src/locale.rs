use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{Manager, WebviewWindow};
static LANGUAGE: AtomicUsize = AtomicUsize::new(0);
const LANGUAGES: [&str;9] = ["ru","en","de","it","es","fr","zh","ja","ko"];
pub fn text(key:&str) -> &'static str {
    let index=LANGUAGE.load(Ordering::Relaxed).min(8);
    match key {
        "login"=>["Humble Bundle — вход в аккаунт","Humble Bundle — sign in","Humble Bundle — Anmelden","Humble Bundle — accesso","Humble Bundle — iniciar sesión","Humble Bundle — connexion","Humble Bundle — 登录","Humble Bundle — ログイン","Humble Bundle — 로그인"][index],
        "export"=>["Экспорт ключей","Export keys","Schlüssel exportieren","Esporta chiavi","Exportar claves","Exporter les clés","导出密钥","キーをエクスポート","키 내보내기"][index],
        "txt"=>["Текстовый файл","Text file","Textdatei","File di testo","Archivo de texto","Fichier texte","文本文件","テキストファイル","텍스트 파일"][index],
        "csv"=>["Таблица CSV","CSV table","CSV-Tabelle","Tabella CSV","Tabla CSV","Tableau CSV","CSV 表格","CSV テーブル","CSV 표"][index],
        _=>"Humble Library"
    }
}
#[tauri::command]
pub fn set_ui_language(window:WebviewWindow,app:tauri::AppHandle,language:String)->Result<(),String>{
    if window.label()!="main" {return Err("Недоступная операция".into());}
    let index=LANGUAGES.iter().position(|value|*value==language).ok_or("Неподдерживаемый язык")?;
    LANGUAGE.store(index,Ordering::Relaxed);
    if let Some(window)=app.get_webview_window("humble-account"){let _=window.set_title(text("login"));}
    Ok(())
}
