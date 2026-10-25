//! Signed GitHub updates for portable and per-user installed applications.
//! Automatic checks are bounded to once
//! per day; no timer, background process or account credentials are involved.
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, LazyLock, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager, WebviewWindow};

#[path = "updater_helper.rs"] mod helper;
pub const FILES: [&str; 4] = ["HumbleLibrary.exe", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"];
pub const DEFAULT_REPOSITORY: &str = "MerryGrim/HumbleLibrary";
pub(crate) const MAX_PAYLOAD: u64 = 96 * 1024 * 1024;
pub(crate) const MAX_MANIFEST: usize = 65536;
static CHECK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static APPLYING: AtomicBool = AtomicBool::new(false);
static OPERATIONS: AtomicUsize = AtomicUsize::new(0);
static OPTIONS: LazyLock<Mutex<Options>> = LazyLock::new(|| Mutex::new(read_limited(&settings_path(), 8192).ok().and_then(|bytes| serde_json::from_slice::<Options>(&bytes).ok()).filter(|p| valid_repository(&p.repository)).unwrap_or_default()));

pub struct Operation;
impl Drop for Operation { fn drop(&mut self) { OPERATIONS.fetch_sub(1, Ordering::SeqCst); } }
pub fn applying() -> bool { APPLYING.load(Ordering::SeqCst) }
pub fn operation() -> Result<Operation, String> {
    if applying() { return Err("Дождитесь завершения обновления программы.".into()); }
    OPERATIONS.fetch_add(1, Ordering::SeqCst);
    let operation = Operation;
    if applying() { drop(operation); return Err("Дождитесь завершения обновления программы.".into()); }
    Ok(operation)
}
fn main_only(window: &WebviewWindow) -> Result<(), String> { if window.label() == "main" { Ok(()) } else { Err("Недоступная операция".into()) } }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct Options { enabled: bool, repository: String, last_check: u64 }
impl Default for Options { fn default() -> Self { Self { enabled: true, repository: DEFAULT_REPOSITORY.into(), last_check: 0 } } }
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InstallationMode { #[default] Portable, Installed }
impl InstallationMode {
    fn name(self) -> &'static str { match self { Self::Portable => "portable", Self::Installed => "installed" } }
    fn marker_name(self) -> &'static str { match self { Self::Portable => "portable.marker", Self::Installed => "installed.marker" } }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstalledMarker { schema: u32, application: String, scope: String }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    pub enabled: bool, pub repository: String, pub configured: bool,
    pub current_version: String, pub last_check: u64, pub mode: String,
    pub supported: bool, pub last_apply_error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release { pub version: String, pub notes: String, pub url: String, pub size: u64, pub staged: bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck { pub status: String, pub release: Option<Release>, pub checked_at: u64 }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress { phase: &'static str, received: u64, total: u64, percent: u8 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Payload { pub name: String, pub url: String, pub size: u64, pub sha256: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Manifest {
    pub schema: u32, pub application: String, pub repository: String, pub version: String,
    pub channel: String, pub target: String, pub app_sha256: String, pub portable: Payload,
}
#[derive(Deserialize)] struct PublicKey { algorithm: String, key: String }
#[derive(Deserialize)] struct GithubRelease { tag_name: String, draft: bool, prerelease: bool, body: Option<String>, assets: Vec<Asset> }
#[derive(Deserialize)] struct Asset { name: String, browser_download_url: String, size: u64, state: String }
#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stage { version: String, repository: String, directory: String }
#[derive(Serialize, Deserialize)] struct Cached { repository: String, current: String, result: UpdateCheck }

pub(crate) fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn settings_path() -> PathBuf { crate::storage::root().join("Settings/app-updates.json") }
pub(crate) fn updates() -> PathBuf { crate::storage::root().join("Updates") }
pub(crate) fn err(error: impl std::fmt::Display) -> String { format!("Обновление: {error}") }
pub(crate) fn no_links(path: &Path) -> Result<(), String> {
    let mut cursor = Some(path);
    while let Some(part) = cursor {
        match fs::symlink_metadata(part) {
            Ok(metadata) => {
                #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { return Err("Ссылки и точки перенаправления в пути обновления запрещены.".into()); } }
                if metadata.file_type().is_symlink() { return Err("Ссылки в пути обновления запрещены.".into()); }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(err(e)),
        }
        cursor = part.parent();
    }
    Ok(())
}
pub(crate) fn read_limited(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    no_links(path)?;
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(err)?.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() > limit { return Err("Файл обновления превышает допустимый размер.".into()); }
    Ok(bytes)
}
pub(crate) fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    no_links(path)?;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(err)?;
    file.write_all(bytes).map_err(err)?; file.sync_all().map_err(err)
}
pub(crate) fn atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    no_links(path)?;
    if let Some(parent) = path.parent() { no_links(parent)?; fs::create_dir_all(parent).map_err(err)?; }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    write_new(&temporary, bytes)?;
    let result = fs::rename(&temporary, path).map_err(err);
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}
pub(crate) fn hash_bytes(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub(crate) fn hash_file(path: &Path) -> Result<String, String> {
    no_links(path)?;
    let mut file = fs::File::open(path).map_err(err)?;
    let mut hash = Sha256::new(); let mut buffer = [0u8; 65536];
    loop { let count = file.read(&mut buffer).map_err(err)?; if count == 0 { break; } hash.update(&buffer[..count]); }
    Ok(format!("{:x}", hash.finalize()))
}
pub(crate) fn valid_hash(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
pub(crate) fn valid_repository(value: &str) -> bool {
    if value.is_empty() { return true; }
    let mut parts = value.split('/'); let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else { return false; };
    !owner.is_empty() && owner.len() <= 39 && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !owner.starts_with('-') && !owner.ends_with('-') && !repo.is_empty() && repo.len() <= 100
        && repo != "." && repo != ".." && !repo.ends_with(".git")
        && repo.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}
fn public_key() -> Result<Vec<u8>, String> {
    let public: PublicKey = serde_json::from_str(include_str!("../update-public-key.json")).map_err(|_| "Ключ обновлений не настроен.")?;
    if public.algorithm != "ecdsa-p256-sha256-p1363" { return Err("Ключ обновлений не настроен.".into()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(public.key).map_err(|_| "Некорректный ключ обновлений.")?;
    if bytes.len() != 72 || bytes[..4] != 0x31534345u32.to_le_bytes() || bytes[4..8] != 32u32.to_le_bytes() { return Err("Некорректный ключ обновлений.".into()); }
    Ok(bytes)
}
#[cfg(windows)]
fn verify_with_key(data: &[u8], signature: &[u8], public: &[u8]) -> Result<(), String> {
    use windows_sys::Win32::Security::Cryptography::*;
    if signature.len() != 64 || public.len() != 72 { return Err("Некорректная подпись обновления.".into()); }
    unsafe {
        let mut algorithm = std::ptr::null_mut();
        if BCryptOpenAlgorithmProvider(&mut algorithm, BCRYPT_ECDSA_P256_ALGORITHM, std::ptr::null(), 0) < 0 { return Err("Не удалось проверить подпись Windows.".into()); }
        let mut imported = std::ptr::null_mut();
        let imported_ok = BCryptImportKeyPair(algorithm, std::ptr::null_mut(), BCRYPT_ECCPUBLIC_BLOB, &mut imported, public.as_ptr(), public.len() as u32, 0) >= 0;
        let digest = Sha256::digest(data);
        let verified = imported_ok && BCryptVerifySignature(imported, std::ptr::null(), digest.as_ptr(), digest.len() as u32, signature.as_ptr(), signature.len() as u32, 0) >= 0;
        if !imported.is_null() { BCryptDestroyKey(imported); }
        BCryptCloseAlgorithmProvider(algorithm, 0);
        if !verified { return Err("Подпись обновления не прошла проверку.".into()); }
    }
    Ok(())
}
#[cfg(not(windows))]
fn verify_with_key(_: &[u8], _: &[u8], _: &[u8]) -> Result<(), String> { Err("Обновления поддерживаются только в Windows.".into()) }
fn asset_url(repository: &str, version: &str, name: &str) -> String { format!("https://github.com/{repository}/releases/download/v{version}/{name}") }
pub(crate) fn validate_manifest(manifest: &Manifest, repository: &str) -> Result<(), String> {
    let version = semver::Version::parse(&manifest.version).map_err(|_| "Некорректная версия обновления.")?;
    let name = format!("HumbleLibrary-{}-Windows-x64.hlupdate", manifest.version);
    if repository.is_empty() || !valid_repository(repository) || manifest.schema != 1 || manifest.application != "HumbleLibrary"
        || manifest.repository != repository || manifest.channel != "stable" || !version.pre.is_empty() || !version.build.is_empty()
        || manifest.target != "windows-x64" || !valid_hash(&manifest.app_sha256)
        || manifest.portable.name != name || manifest.portable.url != asset_url(repository, &manifest.version, &name)
        || manifest.portable.size == 0 || manifest.portable.size > MAX_PAYLOAD || !valid_hash(&manifest.portable.sha256) {
        return Err("Некорректный манифест или источник обновления.".into());
    }
    Ok(())
}
pub(crate) fn validate_signed_manifest(bytes: &[u8], signature: &[u8], repository: &str) -> Result<Manifest, String> {
    if bytes.is_empty() || bytes.len() > MAX_MANIFEST || signature.len() > 256 { return Err("Некорректный размер манифеста обновления.".into()); }
    let signature = base64::engine::general_purpose::STANDARD.decode(std::str::from_utf8(signature).map_err(|_| "Некорректная подпись обновления.")?.trim()).map_err(|_| "Некорректная подпись обновления.")?;
    verify_with_key(bytes, &signature, &public_key()?)?;
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|_| "Некорректный манифест обновления.")?;
    validate_manifest(&manifest, repository)?;
    Ok(manifest)
}
fn marker_bytes(root: &Path, mode: InstallationMode) -> Result<Vec<u8>, String> {
    let selected = root.join(mode.marker_name());
    let other = root.join(match mode { InstallationMode::Portable => "installed.marker", InstallationMode::Installed => "portable.marker" });
    no_links(&selected)?; no_links(&other)?;
    if other.exists() || !fs::metadata(&selected).map_err(err)?.is_file() { return Err("Режим установки Humble Library не определён однозначно.".into()); }
    let bytes = read_limited(&selected, 4096)?;
    if mode == InstallationMode::Installed {
        let marker: InstalledMarker = serde_json::from_slice(&bytes).map_err(|_| "Повреждён маркер установленной Humble Library.")?;
        if marker.schema != 1 || marker.application != "HumbleLibrary" || marker.scope != "current-user" { return Err("Не поддерживается этот маркер установки Humble Library.".into()); }
    }
    Ok(bytes)
}
fn installation_mode(exe: &Path) -> Result<Option<InstallationMode>, String> {
    if !cfg!(windows) || !helper::is_application_executable(exe) { return Ok(None); }
    no_links(exe)?;
    let root = exe.parent().ok_or("Не найден каталог Humble Library.")?;
    let portable = root.join("portable.marker"); let installed = root.join("installed.marker");
    no_links(&portable)?; no_links(&installed)?;
    match (portable.exists(), installed.exists()) {
        (true, false) => { marker_bytes(root, InstallationMode::Portable)?; Ok(Some(InstallationMode::Portable)) },
        (false, true) => { marker_bytes(root, InstallationMode::Installed)?; Ok(Some(InstallationMode::Installed)) },
        (false, false) => Ok(None),
        (true, true) => Err("Рядом с программой найдены конфликтующие маркеры установки.".into()),
    }
}
fn portable_executable(exe: &Path) -> bool { installation_mode(exe).ok().flatten() == Some(InstallationMode::Portable) }
fn data_root_at(exe: &Path, mode: InstallationMode, local_app_data: Option<&Path>) -> Result<PathBuf, String> {
    let root = exe.parent().ok_or("Не найден каталог Humble Library.")?;
    let result = match mode {
        InstallationMode::Portable => root.join("Data"),
        InstallationMode::Installed => local_app_data.ok_or("Windows не предоставила каталог данных пользователя.")?.join("HumbleLibrary/Data"),
    };
    if !result.is_absolute() { return Err("Каталог данных обновления должен быть абсолютным локальным путём.".into()); }
    #[cfg(windows)] {
        use std::path::{Component, Prefix};
        if !matches!(result.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))) { return Err("Обновление с сетевого пути не поддерживается.".into()); }
    }
    no_links(&result)?;
    Ok(result)
}
pub(crate) fn authorized_data_root(exe: &Path, mode: InstallationMode) -> Result<PathBuf, String> {
    if installation_mode(exe)? != Some(mode) { return Err("Режим установки изменился до запуска обновления.".into()); }
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    data_root_at(exe, mode, local_app_data.as_deref())
}
fn write_preflight(root: &Path) -> Result<(), String> {
    no_links(root)?;
    let path = root.join(format!(".hl-update-write-{}.tmp", uuid::Uuid::new_v4()));
    write_new(&path, b"HumbleLibrary update write permission probe")?;
    fs::remove_file(path).map_err(err)
}
fn options() -> Result<Options, String> { OPTIONS.lock().map(|options| options.clone()).map_err(|_| "Не удалось прочитать настройки обновлений.".into()) }
fn settings() -> Result<UpdateSettings, String> {
    let options = options()?;
    let mode = std::env::current_exe().ok().and_then(|exe| installation_mode(&exe).ok().flatten());
    Ok(UpdateSettings { enabled: options.enabled, repository: options.repository.clone(), configured: !options.repository.is_empty() && public_key().is_ok(), current_version: env!("CARGO_PKG_VERSION").into(), last_check: options.last_check, mode: mode.map(InstallationMode::name).unwrap_or("unsupported").into(), supported: mode.is_some() && helper::standard_user().is_ok(), last_apply_error: helper::last_error() })
}
#[tauri::command]
pub fn updates_get(window: WebviewWindow) -> Result<UpdateSettings, String> { main_only(&window)?; settings() }
#[tauri::command]
pub async fn updates_set(window: WebviewWindow, enabled: bool, repository: String) -> Result<UpdateSettings, String> {
    main_only(&window)?;
    let _guard = CHECK.try_lock().map_err(|_| "Дождитесь завершения проверки обновлений.")?;
    let repository = repository.trim().to_string();
    if !valid_repository(&repository) { return Err("Укажите GitHub-репозиторий в формате владелец/репозиторий.".into()); }
    if applying() { return Err("Дождитесь завершения обновления.".into()); }
    let mut options = OPTIONS.lock().map_err(|_| "Не удалось сохранить настройки.")?;
    let next = Options { enabled, last_check: if options.repository == repository { options.last_check } else { 0 }, repository };
    atomic(&settings_path(), &serde_json::to_vec(&next).map_err(err)?)?;
    *options = next; drop(options);
    settings()
}
fn client(redirects: bool) -> Result<reqwest::Client, String> {
    let redirect = if redirects { reqwest::redirect::Policy::custom(|attempt| {
        let url = attempt.url();
        if attempt.previous().len() >= 5 || url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port_or_known_default() != Some(443)
            || !matches!(url.host_str(), Some("github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com")) { attempt.stop() } else { attempt.follow() }
    }) } else { reqwest::redirect::Policy::none() };
    reqwest::Client::builder().user_agent(concat!("HumbleLibrary/", env!("CARGO_PKG_VERSION"))).connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(if redirects { 600 } else { 30 })).redirect(redirect).build().map_err(|_| "Не удалось подготовить соединение GitHub.".into())
}
async fn read_response(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() { return Err("Релизы GitHub недоступны, репозиторий закрыт или пакет ещё не опубликован.".into()); }
    if response.content_length().is_some_and(|size| size > limit as u64) { return Err("Ответ обновления превышает допустимый размер.".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Не удалось прочитать ответ GitHub.")? {
        if bytes.len().saturating_add(chunk.len()) > limit { return Err("Ответ обновления превышает допустимый размер.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn asset(repository: &str, version: &str, name: &str, limit: usize) -> Result<Vec<u8>, String> {
    read_response(client(true)?.get(asset_url(repository, version, name)).send().await.map_err(|_| "Не удалось загрузить сведения об обновлении.")?, limit).await
}
fn candidate(releases: Vec<GithubRelease>, repository: &str, current: &str) -> Result<Option<GithubRelease>, String> {
    let current = semver::Version::parse(current).map_err(err)?;
    Ok(releases.into_iter().filter(|release| {
        let Some(tag) = release.tag_name.strip_prefix('v') else { return false; };
        let Ok(version) = semver::Version::parse(tag) else { return false; };
        !release.draft && !release.prerelease && version.pre.is_empty() && version.build.is_empty() && version > current
            && ["update-manifest.json", "update-manifest.sig"].into_iter().all(|name| release.assets.iter().any(|asset| asset.name == name && asset.state == "uploaded" && asset.size > 0 && asset.browser_download_url == asset_url(repository, tag, name)))
    }).max_by_key(|release| semver::Version::parse(release.tag_name.trim_start_matches('v')).unwrap()))
}
async fn query(repository: &str) -> Result<Option<(Release, Vec<u8>, Vec<u8>, Manifest)>, String> {
    let response = client(false)?.get(format!("https://api.github.com/repos/{repository}/releases?per_page=100"))
        .header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28").send().await.map_err(|_| "Не удалось проверить обновления. Проверьте подключение к интернету.")?;
    let releases: Vec<GithubRelease> = serde_json::from_slice(&read_response(response, 2 * 1024 * 1024).await?).map_err(|_| "GitHub вернул неподдерживаемый список релизов.")?;
    let Some(release) = candidate(releases, repository, env!("CARGO_PKG_VERSION"))? else { return Ok(None); };
    let version = release.tag_name.trim_start_matches('v');
    let bytes = asset(repository, version, "update-manifest.json", MAX_MANIFEST).await?;
    let signature = asset(repository, version, "update-manifest.sig", 256).await?;
    let manifest = validate_signed_manifest(&bytes, &signature, repository)?;
    if manifest.version != version { return Err("Версия подписанного пакета не совпадает с релизом.".into()); }
    let payload = &manifest.portable;
    if !release.assets.iter().any(|asset| asset.name == payload.name && asset.state == "uploaded" && asset.size == payload.size && asset.browser_download_url == payload.url) { return Err("Подписанный пакет отсутствует среди файлов релиза.".into()); }
    let staged = staged_directory(version, repository).is_ok();
    Ok(Some((Release { version: version.into(), notes: release.body.unwrap_or_default().chars().take(12000).collect(), url: format!("https://github.com/{repository}/releases/tag/v{version}"), size: payload.size, staged }, bytes, signature, manifest)))
}
fn empty(status: &str) -> UpdateCheck { UpdateCheck { status: status.into(), release: None, checked_at: now() } }
#[tauri::command]
pub async fn updates_check(window: WebviewWindow, manual: bool) -> Result<UpdateCheck, String> {
    main_only(&window)?;
    let _guard = CHECK.try_lock().map_err(|_| "Проверка обновлений уже выполняется.")?;
    let options = options()?;
    if options.repository.is_empty() || public_key().is_err() { return Ok(empty("notConfigured")); }
    if !manual && !options.enabled { return Ok(empty("disabled")); }
    if !manual && now().saturating_sub(options.last_check) < 86400 {
        if let Ok(bytes) = read_limited(&updates().join("check.json"), 65536) { if let Ok(cache) = serde_json::from_slice::<Cached>(&bytes) { if cache.repository == options.repository && cache.current == env!("CARGO_PKG_VERSION") { return Ok(cache.result); } } }
        return Ok(UpdateCheck { status: "throttled".into(), release: None, checked_at: options.last_check });
    }
    {
        let mut saved = OPTIONS.lock().map_err(|_| "Не удалось сохранить проверку обновлений.")?;
        saved.last_check = now(); atomic(&settings_path(), &serde_json::to_vec(&*saved).map_err(err)?)?;
    }
    let found = query(&options.repository).await?;
    let result = match found { Some((release, _, _, _)) => UpdateCheck { status: "available".into(), release: Some(release), checked_at: now() }, None => empty("current") };
    atomic(&updates().join("check.json"), &serde_json::to_vec(&Cached { repository: options.repository, current: env!("CARGO_PKG_VERSION").into(), result: result.clone() }).map_err(err)?)?;
    Ok(result)
}
fn staged_directory(version: &str, repository: &str) -> Result<PathBuf, String> {
    let stage: Stage = serde_json::from_slice(&read_limited(&updates().join("staged.json"), 4096)?).map_err(|_| "Сначала скачайте обновление.")?;
    if stage.version != version || stage.repository != repository || !helper::valid_id(&stage.directory) { return Err("Сначала скачайте обновление.".into()); }
    let directory = updates().join(&stage.directory); no_links(&directory)?;
    let manifest = validate_signed_manifest(&read_limited(&directory.join("manifest.json"), MAX_MANIFEST)?, &read_limited(&directory.join("manifest.sig"), 256)?, repository)?;
    if manifest.version != version || fs::metadata(directory.join(&manifest.portable.name)).map_err(err)?.len() != manifest.portable.size || hash_file(&directory.join(&manifest.portable.name))? != manifest.portable.sha256 { return Err("Скачанный пакет обновления повреждён.").map_err(String::from); }
    Ok(directory)
}
fn create_attempt(source: &Path, manifest: &Manifest, base: &Path) -> Result<(String, PathBuf), String> {
    let id = uuid::Uuid::new_v4().to_string(); let directory = base.join(&id);
    no_links(&directory)?; fs::create_dir_all(&directory).map_err(err)?;
    for (name, limit) in [("manifest.json", MAX_MANIFEST), ("manifest.sig", 256), (&manifest.portable.name, MAX_PAYLOAD as usize)] {
        write_new(&directory.join(name), &read_limited(&source.join(name), limit)?)?;
    }
    if fs::metadata(directory.join(&manifest.portable.name)).map_err(err)?.len() != manifest.portable.size || hash_file(&directory.join(&manifest.portable.name))? != manifest.portable.sha256 { return Err("Копия подписанного пакета повреждена. Исходный пакет сохранён.".into()); }
    Ok((id, directory))
}
#[tauri::command]
pub async fn updates_download(window: WebviewWindow, app: tauri::AppHandle, version: String) -> Result<UpdateCheck, String> {
    main_only(&window)?;
    let _guard = CHECK.try_lock().map_err(|_| "Дождитесь завершения текущей проверки.")?;
    let _operation = operation()?;
    let options = options()?;
    if options.repository.is_empty() { return Ok(empty("notConfigured")); }
    let Some((mut release, bytes, signature, manifest)) = query(&options.repository).await? else { return Err("Более новая версия не найдена.").map_err(String::from); };
    if release.version != version { return Err("Список релизов изменился. Повторите проверку.").map_err(String::from); }
    let id = uuid::Uuid::new_v4().to_string(); let directory = updates().join(&id); no_links(&directory)?; fs::create_dir_all(&directory).map_err(err)?;
    let payload = &manifest.portable;
    let response = client(true)?.get(&payload.url).send().await.map_err(|_| "Не удалось скачать пакет обновления.")?;
    if !response.status().is_success() || response.content_length().is_some_and(|size| size != payload.size) { return Err("Размер пакета не совпадает с подписанным манифестом.").map_err(String::from); }
    let mut response = response;
    let temporary = directory.join("download.partial");
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(err)?;
    let mut received = 0u64; let mut hash = Sha256::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Загрузка обновления прервана.")? {
        received = received.saturating_add(chunk.len() as u64);
        if received > payload.size || received > MAX_PAYLOAD { return Err("Скачанный пакет слишком большой.").map_err(String::from); }
        file.write_all(&chunk).map_err(err)?; hash.update(&chunk);
        let _ = app.emit_to("main", "update-progress", Progress { phase: "download", received, total: payload.size, percent: ((received.saturating_mul(100) / payload.size).min(100)) as u8 });
    }
    file.sync_all().map_err(err)?; drop(file);
    if received != payload.size || format!("{:x}", hash.finalize()) != payload.sha256 { return Err("Контрольная сумма обновления не совпадает.").map_err(String::from); }
    fs::rename(&temporary, directory.join(&payload.name)).map_err(err)?;
    write_new(&directory.join("manifest.json"), &bytes)?; write_new(&directory.join("manifest.sig"), &signature)?;
    // Decode before publication of the staged pointer; unknown/traversal/Data entries are rejected.
    helper::verified_files(&directory.join(&payload.name), &manifest)?;
    atomic(&updates().join("staged.json"), &serde_json::to_vec(&Stage { version: version.clone(), repository: options.repository, directory: id }).map_err(err)?)?;
    release.staged = true;
    let _ = app.emit_to("main", "update-progress", Progress { phase: "ready", received, total: received, percent: 100 });
    Ok(UpdateCheck { status: "available".into(), release: Some(release), checked_at: now() })
}
#[tauri::command]
pub async fn updates_apply(window: WebviewWindow, app: tauri::AppHandle, version: String) -> Result<(), String> {
    main_only(&window)?;
    let _guard = CHECK.try_lock().map_err(|_| "Дождитесь завершения текущей проверки.")?;
    let original = std::env::current_exe().map_err(err)?;
    let mode = installation_mode(&original)?.ok_or("Автоматическая установка поддерживается только в переносимой или установленной для текущего пользователя Humble Library.")?;
    helper::standard_user()?;
    if app.get_webview_window("humble-account").is_some_and(|account| account.is_visible().unwrap_or(true)) { return Err("Сначала закройте окно входа Humble Bundle, затем установите обновление.").map_err(String::from); }
    if APPLYING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Err("Обновление уже запускается.").map_err(String::from); }
    let result = async {
        if OPERATIONS.load(Ordering::SeqCst) != 0 { return Err("Сначала завершите синхронизацию, раскрытие ключей или экспорт.").map_err(String::from); }
        // Recheck after APPLYING blocks new operation guards. A login that was
        // finishing during the first visible-window check must remain open.
        if app.get_webview_window("humble-account").is_some_and(|account| account.is_visible().unwrap_or(true)) { return Err("Сначала закройте окно входа Humble Bundle, затем установите обновление.").map_err(String::from); }
        if installation_mode(&original)? != Some(mode) { return Err("Режим установки изменился до запуска обновления.".into()); }
        write_preflight(original.parent().ok_or("Не найден каталог программы.")?)?;
        let authorized_updates = authorized_data_root(&original, mode)?.join("Updates");
        if fs::canonicalize(&updates()).map_err(err)? != fs::canonicalize(&authorized_updates).map_err(err)? { return Err("Каталог скачанного обновления не относится к этой установке.".into()); }
        let options = options()?;
        let staged = staged_directory(&version, &options.repository)?;
        let manifest = validate_signed_manifest(&read_limited(&staged.join("manifest.json"), MAX_MANIFEST)?, &read_limited(&staged.join("manifest.sig"), 256)?, &options.repository)?;
        if semver::Version::parse(&manifest.version).map_err(err)? <= semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(err)? { return Err("Установка этой версии не требуется.").map_err(String::from); }
        // Fresh fixed inputs for every launch attempt make pre-journal failures
        // retryable without deleting or reusing an unknown helper/job file.
        let (id, directory) = create_attempt(&staged, &manifest, &updates())?;
        atomic(&updates().join("staged.json"), &serde_json::to_vec(&Stage { version: version.clone(), repository: options.repository.clone(), directory: id.clone() }).map_err(err)?)?;
        no_links(&original)?;
        let (created, executable) = helper::process_identity(std::process::id())?;
        if fs::canonicalize(&original).map_err(err)? != executable { return Err("Не удалось проверить процесс программы.").map_err(String::from); }
        let job = helper::Job { schema: 1, id, parent_pid: std::process::id(), parent_created: created, original_exe: original.clone(), mode, repository: options.repository, manifest: directory.join("manifest.json"), signature: directory.join("manifest.sig"), payload: directory.join(&manifest.portable.name) };
        let helper_path = directory.join("HumbleLibrary.exe");
        write_new(&helper_path, &read_limited(&original, MAX_PAYLOAD as usize)?)?;
        if hash_file(&helper_path)? != hash_file(&original)? { return Err("Не удалось проверить помощник обновления.").map_err(String::from); }
        let job_path = directory.join("job.json"); write_new(&job_path, &serde_json::to_vec(&job).map_err(err)?)?;
        if let Some(account) = app.get_webview_window("humble-account") { let _ = account.destroy(); }
        let mut runner = helper::launch(&helper_path, &job_path)?;
        for _ in 0..100 {
            if runner.try_wait().map_err(err)?.is_some() { return Err("Помощник не смог подготовить обновление. Программа продолжает работу.").map_err(String::from); }
            match helper::ready_for_parent(&directory, &job.id, runner.id()) {
                Ok(true) => { app.exit(0); return Ok(()); },
                Ok(false) => {},
                Err(message) => { let _ = runner.kill(); let _ = runner.wait(); return Err(message); }
            }
            if directory.join("result.json").is_file() { let _ = runner.kill(); let _ = runner.wait(); return Err("Помощник не смог подготовить обновление. Программа продолжает работу.").map_err(String::from); }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = runner.kill(); let _ = runner.wait();
        Err("Помощник обновления не ответил. Программа продолжает работу.".into())
    }.await;
    if result.is_err() { APPLYING.store(false, Ordering::SeqCst); }
    result
}
#[tauri::command]
pub fn updates_ready(window: WebviewWindow) -> Result<(), String> { main_only(&window)?; confirm_ready() }
pub fn confirm_ready() -> Result<(), String> { helper::confirm_ready() }
pub fn run_helper(path: &Path) -> Result<(), String> { helper::run(path) }
pub fn startup_recover() -> Result<bool, String> { helper::startup() }

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn default_feed_enabled_preserves_explicit_saved_preferences() {
        let fresh=Options::default(); assert!(fresh.enabled); assert_eq!(fresh.repository,"MerryGrim/HumbleLibrary"); assert_eq!(fresh.last_check,0);
        for source in [r#"{"enabled":false,"repository":"custom/Source","lastCheck":123}"#,r#"{"enabled":false,"repository":"","lastCheck":456}"#] {
            let saved:Options=serde_json::from_str(source).unwrap(); assert!(!saved.enabled); assert_ne!(saved.repository,DEFAULT_REPOSITORY); assert!(saved.last_check>0); let roundtrip:Options=serde_json::from_slice(&serde_json::to_vec(&saved).unwrap()).unwrap(); assert_eq!(roundtrip.repository,saved.repository); assert_eq!(roundtrip.enabled,saved.enabled);
        }
        let partial:Options=serde_json::from_str(r#"{"enabled":false}"#).unwrap(); assert!(!partial.enabled); assert_eq!(partial.repository,DEFAULT_REPOSITORY);
    }
    fn manifest() -> Manifest { Manifest { schema: 1, application: "HumbleLibrary".into(), repository: "fixture/Library".into(), version: "0.2.0".into(), channel: "stable".into(), target: "windows-x64".into(), app_sha256: "a".repeat(64), portable: Payload { name: "HumbleLibrary-0.2.0-Windows-x64.hlupdate".into(), url: "https://github.com/fixture/Library/releases/download/v0.2.0/HumbleLibrary-0.2.0-Windows-x64.hlupdate".into(), size: 123, sha256: "b".repeat(64) } } }
    #[test] fn repository_input_is_not_a_url_or_path() { for value in ["", "MerryGrim/HumbleLibrary", "owner/repo.test", "a_b/repo"] { assert_eq!(valid_repository(value), value != "a_b/repo"); } for value in ["https://github.com/a/b", "a/b/c", "a/..", "a/b.git", "../b", "a/b?token=x", "a/b#x", "a\\b"] { assert!(!valid_repository(value)); } }
    #[test] fn manifest_binds_repository_tag_target_and_owned_payload() { assert!(validate_manifest(&manifest(), "fixture/Library").is_ok()); for change in 0..8 { let mut m = manifest(); match change { 0 => m.repository = "other/Library".into(), 1 => m.version = "0.2.0-beta.1".into(), 2 => m.target = "linux-x64".into(), 3 => m.portable.name = "../Data/user.json".into(), 4 => m.portable.url = "https://evil.test/payload".into(), 5 => m.portable.size = MAX_PAYLOAD + 1, 6 => m.application = "Other".into(), _ => m.app_sha256 = "A".repeat(64) }; assert!(validate_manifest(&m, "fixture/Library").is_err()); } }
    #[test] fn hashes_are_exact_and_lowercase() { assert_eq!(hash_bytes(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); assert!(valid_hash(&"f".repeat(64))); assert!(!valid_hash(&"F".repeat(64))); }
    #[test] #[cfg(windows)] fn portable_mode_accepts_windows_executable_case_and_requires_marker() {
        let root=std::env::temp_dir().join(format!("hl-update-mode-unit-{}",uuid::Uuid::new_v4())); fs::create_dir_all(&root).unwrap(); let root=fs::canonicalize(root).unwrap();
        assert!(!portable_executable(&root.join("humblelibrary.exe"))); fs::write(root.join("portable.marker"),b"fixture").unwrap();
        for name in ["HumbleLibrary.exe","humblelibrary.exe","HUMBLELIBRARY.EXE"] { assert!(portable_executable(&root.join(name))); }
        for name in ["Other.exe","HumbleLibrary.exe.bak","HumbleLibrary"] { assert!(!portable_executable(&root.join(name))); }
        assert_eq!(root.parent().unwrap(),fs::canonicalize(std::env::temp_dir()).unwrap()); assert!(root.file_name().unwrap().to_string_lossy().starts_with("hl-update-mode-unit-")); fs::remove_dir_all(root).unwrap();
    }
    #[test] #[cfg(windows)] fn installed_marker_requires_per_user_schema_and_no_conflicting_portable_marker() {
        let root=std::env::temp_dir().join(format!("hl-installed-mode-unit-{}",uuid::Uuid::new_v4())); fs::create_dir_all(&root).unwrap(); let root=fs::canonicalize(root).unwrap(); let exe=root.join("humblelibrary.exe");
        assert!(installation_mode(&exe).unwrap().is_none());
        fs::write(root.join("installed.marker"),br#"{"schema":1,"application":"HumbleLibrary","scope":"current-user"}"#).unwrap(); assert_eq!(installation_mode(&exe).unwrap(),Some(InstallationMode::Installed)); assert!(!portable_executable(&exe));
        let derived=data_root_at(&exe,InstallationMode::Installed,Some(&root.join("UserProfile"))).unwrap(); assert_eq!(derived,root.join("UserProfile/HumbleLibrary/Data")); assert_ne!(derived,root.join("Data")); assert_eq!(data_root_at(&exe,InstallationMode::Portable,None).unwrap(),root.join("Data"));
        fs::write(root.join("portable.marker"),b"fixture").unwrap(); assert!(installation_mode(&exe).is_err()); fs::remove_file(root.join("portable.marker")).unwrap();
        for marker in [br#"{"schema":1,"application":"Other","scope":"current-user"}"#.as_slice(),br#"{"schema":1,"application":"HumbleLibrary","scope":"all-users"}"#.as_slice(),br#"{"schema":2,"application":"HumbleLibrary","scope":"current-user"}"#.as_slice(),br#"{"schema":1,"application":"HumbleLibrary","scope":"current-user","extra":true}"#.as_slice(),b"".as_slice()] { fs::write(root.join("installed.marker"),marker).unwrap(); assert!(installation_mode(&exe).is_err()); }
        fs::write(root.join("installed.marker"),vec![b' ';4097]).unwrap(); assert!(installation_mode(&exe).is_err()); fs::remove_file(root.join("installed.marker")).unwrap(); fs::create_dir(root.join("installed.marker")).unwrap(); assert!(installation_mode(&exe).is_err());
        assert_eq!(root.parent().unwrap(),fs::canonicalize(std::env::temp_dir()).unwrap()); assert!(root.file_name().unwrap().to_string_lossy().starts_with("hl-installed-mode-unit-")); fs::remove_dir_all(root).unwrap();
    }
    #[test] fn each_apply_attempt_uses_fresh_inputs_and_preserves_stale_helper() {
        let root=std::env::temp_dir().join(format!("hl-update-attempt-unit-{}",uuid::Uuid::new_v4())); fs::create_dir_all(root.join("source")).unwrap(); let root=fs::canonicalize(root).unwrap();
        let source=root.join("source"); let mut manifest=manifest(); let payload=b"synthetic-compressed-payload"; manifest.portable.size=payload.len() as u64; manifest.portable.sha256=hash_bytes(payload);
        fs::write(source.join("manifest.json"),b"synthetic metadata").unwrap(); fs::write(source.join("manifest.sig"),b"synthetic signature").unwrap(); fs::write(source.join(&manifest.portable.name),payload).unwrap();
        let (first,first_dir)=create_attempt(&source,&manifest,&root.join("attempts")).unwrap(); fs::write(first_dir.join("HumbleLibrary.exe"),b"stale helper fixture").unwrap(); fs::write(first_dir.join("job.json"),b"stale job fixture").unwrap();
        let (second,second_dir)=create_attempt(&first_dir,&manifest,&root.join("attempts")).unwrap(); assert_ne!(first,second); assert!(!second_dir.join("HumbleLibrary.exe").exists()); assert!(!second_dir.join("job.json").exists()); assert_eq!(fs::read(first_dir.join("HumbleLibrary.exe")).unwrap(),b"stale helper fixture"); assert_eq!(hash_file(&second_dir.join(&manifest.portable.name)).unwrap(),manifest.portable.sha256);
        assert_eq!(root.parent().unwrap(),fs::canonicalize(std::env::temp_dir()).unwrap()); assert!(root.file_name().unwrap().to_string_lossy().starts_with("hl-update-attempt-unit-")); fs::remove_dir_all(root).unwrap();
    }
    #[test] fn malformed_or_unsigned_manifest_is_rejected() { assert!(validate_signed_manifest(b"{}", b"not base64", "fixture/Library").is_err()); assert!(validate_signed_manifest(b"{}", b"", "fixture/Library").is_err()); }
    #[test] #[cfg(windows)] fn cng_p1363_signature_roundtrip_tamper_and_wrong_key_rejected() {
        use windows_sys::Win32::Security::Cryptography::*;
        unsafe {
            let mut algorithm=std::ptr::null_mut(); assert!(BCryptOpenAlgorithmProvider(&mut algorithm,BCRYPT_ECDSA_P256_ALGORITHM,std::ptr::null(),0)>=0);
            let mut signing=std::ptr::null_mut(); assert!(BCryptGenerateKeyPair(algorithm,&mut signing,256,0)>=0); assert!(BCryptFinalizeKeyPair(signing,0)>=0);
            let mut size=0; assert!(BCryptExportKey(signing,std::ptr::null_mut(),BCRYPT_ECCPUBLIC_BLOB,std::ptr::null_mut(),0,&mut size,0)>=0); let mut public=vec![0u8;size as usize]; assert!(BCryptExportKey(signing,std::ptr::null_mut(),BCRYPT_ECCPUBLIC_BLOB,public.as_mut_ptr(),size,&mut size,0)>=0);
            let bytes=b"signed synthetic Humble Library update manifest"; let digest=Sha256::digest(bytes); let mut signature=vec![0u8;64]; assert!(BCryptSignHash(signing,std::ptr::null(),digest.as_ptr(),32,signature.as_mut_ptr(),64,&mut size,0)>=0);
            BCryptDestroyKey(signing); BCryptCloseAlgorithmProvider(algorithm,0);
            assert!(verify_with_key(bytes,&signature,&public).is_ok()); assert!(verify_with_key(b"changed manifest",&signature,&public).is_err()); signature[0]^=1; assert!(verify_with_key(bytes,&signature,&public).is_err()); public[10]^=1; assert!(verify_with_key(bytes,&signature,&public).is_err());
        }
    }
    #[test] fn candidate_never_downgrades_or_uses_wrong_feed_assets() { let release = |tag: &str, draft, prerelease, repo| GithubRelease { tag_name: tag.into(), draft, prerelease, body: None, assets: ["update-manifest.json", "update-manifest.sig"].map(|name| Asset { name: name.into(), browser_download_url: asset_url(repo, tag.trim_start_matches('v'), name), size: 1, state: "uploaded".into() }).into() }; assert!(candidate(vec![release("v0.1.0", false, false, "fixture/Library"), release("v0.3.0-beta.1", false, true, "fixture/Library"), release("v0.3.0", true, false, "fixture/Library"), release("v0.4.0", false, false, "other/Repo")], "fixture/Library", "0.1.0").unwrap().is_none()); assert_eq!(candidate(vec![release("v0.2.0", false, false, "fixture/Library"), release("v0.3.0", false, false, "fixture/Library")], "fixture/Library", "0.1.0").unwrap().unwrap().tag_name, "v0.3.0"); }
}
