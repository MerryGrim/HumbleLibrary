use std::{fs, path::PathBuf, sync::Mutex};
use crate::humble::Bundle;

static WRITE: Mutex<()> = Mutex::new(());

pub fn root() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let folder = exe.parent().unwrap_or(std::path::Path::new("."));
    if folder.join("portable.marker").is_file() { return folder.join("Data"); }
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
        .unwrap_or_else(|| folder.to_path_buf()).join("HumbleLibrary/Data")
}

#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
    if bytes.len() > 64 * 1024 * 1024 { return Err("Локальная библиотека слишком велика".into()); }
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr().cast_mut() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe {
        if decrypt { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
        else { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
    };
    if ok == 0 { return Err("Windows не смогла открыть защищённую библиотеку этого пользователя".into()); }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()); }
    Ok(result)
}

#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>, String> { Err("Защищённое хранилище доступно в Windows".into()) }

pub fn load_library() -> Result<Vec<Bundle>, String> {
    let _guard = WRITE.lock().map_err(|_| "Хранилище занято")?;
    let path = root().join("library.dpapi");
    if !path.exists() { return Ok(Vec::new()); }
    let metadata = fs::metadata(&path).map_err(|_| "Не удалось прочитать локальную библиотеку")?;
    if metadata.len() > 64 * 1024 * 1024 { return Err("Локальная библиотека слишком велика".into()); }
    let bytes = fs::read(path).map_err(|_| "Не удалось прочитать локальную библиотеку")?;
    serde_json::from_slice(&protect(&bytes, true)?).map_err(|_| "Не удалось прочитать формат локальной библиотеки".into())
}

pub fn save_library(bundles: &[Bundle]) -> Result<(), String> {
    let _guard = WRITE.lock().map_err(|_| "Хранилище занято")?;
    let folder = root();
    fs::create_dir_all(&folder).map_err(|_| "Не удалось создать локальное хранилище")?;
    let bytes = serde_json::to_vec(bundles).map_err(|_| "Не удалось сохранить библиотеку")?;
    let encrypted = protect(&bytes, false)?;
    let temporary = folder.join(format!("library-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, encrypted).map_err(|_| "Не удалось записать локальную библиотеку")?;
    fs::rename(&temporary, folder.join("library.dpapi")).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        "Не удалось заменить локальную библиотеку"
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(windows)]
    fn windows_protection_roundtrip_and_tamper() {
        let source = br#"[{"synthetic":"HL-LOCAL-QA-ONLY"}]"#;
        let encrypted = super::protect(source, false).unwrap();
        assert!(!encrypted.windows(source.len()).any(|w| w == source));
        assert_eq!(super::protect(&encrypted, true).unwrap(), source);
        let mut damaged = encrypted;
        let last = damaged.len() - 1; damaged[last] ^= 0xff;
        assert!(super::protect(&damaged, true).is_err());
    }
}
