//! One-shot updater for portable and per-user installed applications. Executed by a copy of the trusted current EXE,
//! before Tauri starts. Only four signed, fixed application files are writable.
use super::*;
use serde_json::Value;
use std::{collections::BTreeSet, fs::{File, OpenOptions}, process::{Child, Command}, time::Instant};

const JOURNAL: &str = ".hl-app-update.dpapi";
const JOURNAL_HEADER: &[u8] = b"HLUPJ1\0";
const JOURNAL_ENTROPY: &[u8] = b"HumbleLibrary/update-transaction/v1";
const MAX_UNPACKED: usize = 160 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Job {
    pub schema: u32, pub id: String, pub parent_pid: u32, pub parent_created: u64,
    pub original_exe: PathBuf, pub repository: String,
    #[serde(default)] pub mode: InstallationMode,
    pub manifest: PathBuf, pub signature: PathBuf, pub payload: PathBuf,
}
#[derive(Deserialize)] #[serde(deny_unknown_fields)]
struct Bundle { schema: u32, version: String, files: Vec<BundleFile> }
#[derive(Deserialize)] #[serde(deny_unknown_fields)]
struct BundleFile { name: String, data: String }
#[derive(Clone, Serialize, Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change { name: String, old_hash: Option<String>, new_hash: String }
#[derive(Clone, Serialize, Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema: u32, id: String, original_exe: PathBuf, job_dir: PathBuf, repository: String,
    #[serde(default)] mode: InstallationMode,
    from_version: String, version: String, helper_pid: u32, helper_created: u64,
    helper_sha256: String, app_sha256: String, marker_sha256: String, state: String,
    child_pid: Option<u32>, child_created: Option<u64>, files: Vec<Change>,
}
#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt { id: String, version: String, app_sha256: String }
#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HelperReady { id: String, helper_pid: u32, helper_created: u64 }

pub(crate) fn valid_id(id: &str) -> bool { uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id) }
pub(crate) fn is_application_executable(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()).is_some_and(|name| {
        #[cfg(windows)] { name.eq_ignore_ascii_case("HumbleLibrary.exe") }
        #[cfg(not(windows))] { name == "HumbleLibrary.exe" }
    })
}
fn canonical(path: &Path) -> Result<PathBuf, String> { no_links(path)?; fs::canonicalize(path).map_err(err) }
fn same(a: &Path, b: &Path) -> bool {
    #[cfg(windows)] { use std::os::windows::ffi::OsStrExt; a.as_os_str().encode_wide().map(|c| if (65..=90).contains(&c) { c + 32 } else { c }).eq(b.as_os_str().encode_wide().map(|c| if (65..=90).contains(&c) { c + 32 } else { c })) }
    #[cfg(not(windows))] { a == b }
}
fn optional_hash(path: &Path) -> Result<Option<String>, String> {
    no_links(path)?;
    match fs::metadata(path) { Ok(metadata) if metadata.is_file() => hash_file(path).map(Some), Ok(_) => Err("Путь обновления не является файлом.".into()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None), Err(e) => Err(err(e)) }
}
fn json(path: &Path, value: &impl Serialize) -> Result<(), String> { atomic(path, &serde_json::to_vec_pretty(value).map_err(err)?) }
#[cfg(windows)]
fn protect_journal(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
    if bytes.is_empty() || bytes.len() > 65536 { return Err("Некорректный размер защищённого журнала обновления.".into()); }
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr().cast_mut() };
    let entropy = CRYPT_INTEGER_BLOB { cbData: JOURNAL_ENTROPY.len() as u32, pbData: JOURNAL_ENTROPY.as_ptr().cast_mut() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe { if decrypt { CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) } else { CryptProtectData(&input, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) } };
    if ok == 0 { return Err("Защищённый журнал обновления повреждён или принадлежит другому пользователю Windows.".into()); }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()); }
    Ok(result)
}
#[cfg(not(windows))]
fn protect_journal(_: &[u8], _: bool) -> Result<Vec<u8>, String> { Err("Защищённое восстановление обновлений поддерживается только в Windows.".into()) }
fn encode_journal(journal: &Journal) -> Result<Vec<u8>, String> {
    let mut bytes = JOURNAL_HEADER.to_vec();
    bytes.extend(protect_journal(&serde_json::to_vec(journal).map_err(err)?, false)?);
    Ok(bytes)
}
fn decode_journal(bytes: &[u8]) -> Result<Journal, String> {
    if !bytes.starts_with(JOURNAL_HEADER) { return Err("Незащищённый журнал обновления запрещён.".into()); }
    serde_json::from_slice(&protect_journal(&bytes[JOURNAL_HEADER.len()..], true)?).map_err(|_| "Некорректный защищённый журнал обновления.".into())
}
fn save(journal: &Journal) -> Result<(), String> { atomic(&journal.original_exe.parent().ok_or("Не найден каталог программы.")?.join(JOURNAL), &encode_journal(journal)?) }
fn lock_input(path: &Path) -> Result<File, String> {
    no_links(path)?;
    let mut options = OpenOptions::new(); options.read(true);
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(1); }
    let file = options.open(path).map_err(err)?;
    if !file.metadata().map_err(err)?.is_file() { return Err("Вход обновления не является файлом.".into()); }
    Ok(file)
}
fn update_lock(root: &Path) -> Result<File, String> {
    let path = root.join(".hl-app-update.lock"); no_links(&path)?;
    let mut options = OpenOptions::new(); options.create(true).read(true).write(true);
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.share_mode(0); }
    options.open(path).map_err(|_| "Другая копия программы уже устанавливает обновление.".into())
}

#[cfg(windows)] mod windows {
    use super::*;
    use windows_sys::Win32::{Foundation::*, System::Threading::*};
    pub(super) struct Process(HANDLE);
    impl Drop for Process { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    impl Process {
        pub(super) fn open(pid: u32) -> Result<Option<Self>, String> {
            unsafe { let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid); if handle.is_null() { return if GetLastError() == ERROR_INVALID_PARAMETER { Ok(None) } else { Err(err(std::io::Error::last_os_error())) }; } Ok(Some(Self(handle))) }
        }
        pub(super) fn identity(&self) -> Result<(u64, PathBuf), String> {
            unsafe {
                let mut created: FILETIME = std::mem::zeroed(); let mut exit: FILETIME = std::mem::zeroed(); let mut kernel: FILETIME = std::mem::zeroed(); let mut user: FILETIME = std::mem::zeroed();
                if GetProcessTimes(self.0, &mut created, &mut exit, &mut kernel, &mut user) == 0 { return Err(err(std::io::Error::last_os_error())); }
                let mut buffer = vec![0u16; 32768]; let mut size = buffer.len() as u32;
                if QueryFullProcessImageNameW(self.0, 0, buffer.as_mut_ptr(), &mut size) == 0 { return Err(err(std::io::Error::last_os_error())); }
                use std::os::windows::ffi::OsStringExt;
                Ok((((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64, canonical(&PathBuf::from(std::ffi::OsString::from_wide(&buffer[..size as usize])))?))
            }
        }
        pub(super) fn wait(&self, duration: Duration) -> Result<bool, String> {
            match unsafe { WaitForSingleObject(self.0, duration.as_millis().min(u32::MAX as u128 - 1) as u32) } { WAIT_OBJECT_0 => Ok(true), WAIT_TIMEOUT => Ok(false), _ => Err(err(std::io::Error::last_os_error())) }
        }
    }
}
pub(crate) fn process_identity(pid: u32) -> Result<(u64, PathBuf), String> {
    #[cfg(windows)] { windows::Process::open(pid)?.ok_or("Процесс обновления уже завершился.")?.identity() }
    #[cfg(not(windows))] { let _ = pid; Err("Установка обновлений поддерживается только в Windows.".into()) }
}
pub(crate) fn standard_user() -> Result<(), String> {
    #[cfg(windows)] {
        use windows_sys::Win32::{Foundation::CloseHandle, Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY}, System::Threading::{GetCurrentProcess, OpenProcessToken}};
        unsafe {
            let mut token=std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&mut token)==0 { return Err("Не удалось проверить права пользователя Windows.".into()); }
            let mut elevation:TOKEN_ELEVATION=std::mem::zeroed(); let mut returned=0;
            let ok=GetTokenInformation(token,TokenElevation,(&mut elevation as *mut TOKEN_ELEVATION).cast(),std::mem::size_of::<TOKEN_ELEVATION>() as u32,&mut returned);
            CloseHandle(token);
            if ok==0 { return Err("Не удалось проверить права пользователя Windows.".into()); }
            if elevation.TokenIsElevated!=0 { return Err("Запустите Humble Library от обычного пользователя, без прав администратора, чтобы установить обновление.".into()); }
        }
        Ok(())
    }
    #[cfg(not(windows))] { Err("Установка обновлений поддерживается только в Windows.".into()) }
}
fn alive(pid: u32, created: u64, executable: &Path) -> Result<bool, String> {
    #[cfg(windows)] {
        let Some(process) = windows::Process::open(pid)? else { return Ok(false); };
        if process.wait(Duration::ZERO)? { return Ok(false); }
        let (actual_created, image) = process.identity()?;
        Ok(actual_created == created && same(&image, executable))
    }
    #[cfg(not(windows))] { let _ = (pid, created, executable); Ok(false) }
}
pub(crate) fn launch(executable: &Path, job_path: &Path) -> Result<Child, String> {
    no_links(executable)?; no_links(job_path)?;
    let mut command = Command::new(executable); command.arg("--apply-update").arg(job_path).current_dir(executable.parent().ok_or("Не найден помощник обновления.")?);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command.spawn().map_err(|_| "Не удалось запустить помощник обновления.".into())
}
fn start_application(executable: &Path, restart: Option<&str>) -> Result<Child, String> {
    no_links(executable)?;
    let mut command = Command::new(executable); command.current_dir(executable.parent().ok_or("Не найден каталог программы.")?);
    if let Some(id) = restart { command.arg("--update-restart").arg(id); }
    command.spawn().map_err(|_| "Не удалось перезапустить Humble Library.".into())
}
fn load_job(path: &Path, job_dir: &Path) -> Result<Job, String> {
    if !same(&canonical(path)?, &job_dir.join("job.json")) { return Err("Задание обновления находится вне каталога помощника.".into()); }
    let mut job: Job = serde_json::from_slice(&read_limited(path, 32768)?).map_err(|_| "Некорректное задание обновления.")?;
    if job.schema != 1 || !valid_id(&job.id) || job.parent_pid <= 4 || job.parent_created == 0 || job.repository.is_empty() || !valid_repository(&job.repository) || !is_application_executable(&job.original_exe) { return Err("Некорректные параметры обновления.".into()); }
    job.original_exe = canonical(&job.original_exe)?;
    let data_root=authorized_data_root(&job.original_exe,job.mode)?;
    if !same(&canonical(&data_root.join("Updates").join(&job.id))?, job_dir) { return Err("Обновление разрешено только в собственном каталоге данных Humble Library.".into()); }
    job.manifest = canonical(&job.manifest)?; job.signature = canonical(&job.signature)?; job.payload = canonical(&job.payload)?;
    if !same(&job.manifest, &job_dir.join("manifest.json")) || !same(&job.signature, &job_dir.join("manifest.sig")) || job.payload.parent().is_none_or(|parent| !same(parent, job_dir)) { return Err("Файлы обновления находятся вне каталога задания.".into()); }
    Ok(job)
}
fn verified(job: &Job) -> Result<Manifest, String> {
    let manifest = validate_signed_manifest(&read_limited(&job.manifest, MAX_MANIFEST)?, &read_limited(&job.signature, 256)?, &job.repository)?;
    if job.payload.file_name().and_then(|name| name.to_str()) != Some(manifest.portable.name.as_str()) { return Err("Имя скачанного пакета не совпадает с подписью.".into()); }
    if fs::metadata(&job.payload).map_err(err)?.len() != manifest.portable.size || hash_file(&job.payload)? != manifest.portable.sha256 { return Err("Скачанный пакет повреждён.".into()); }
    Ok(manifest)
}
fn decode_bundle(bundle: Bundle, version: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
    if bundle.schema != 1 || bundle.version != version || bundle.files.len() != FILES.len() { return Err("Неподдерживаемый состав пакета обновления.".into()); }
    let mut seen = BTreeSet::new(); let mut files = Vec::new(); let mut total = 0usize;
    for entry in bundle.files {
        if !FILES.contains(&entry.name.as_str()) || !seen.insert(entry.name.clone()) || entry.data.len() > (MAX_PAYLOAD as usize + 2) / 3 * 4 { return Err("Пакет содержит неизвестный, повторный или слишком большой файл.".into()); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(entry.data).map_err(|_| "Некорректные данные файла обновления.")?;
        total = total.saturating_add(bytes.len());
        if bytes.is_empty() || bytes.len() > MAX_PAYLOAD as usize || total > MAX_UNPACKED { return Err("Распакованный пакет превышает допустимый размер.".into()); }
        files.push((entry.name, bytes));
    }
    if !FILES.iter().all(|name| seen.contains(*name)) { return Err("В пакете отсутствуют обязательные файлы.".into()); }
    Ok(files)
}
pub(crate) fn verified_files(path: &Path, manifest: &Manifest) -> Result<Vec<(String, Vec<u8>)>, String> {
    no_links(path)?;
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(File::open(path).map_err(err)?).take(MAX_UNPACKED as u64 + 1).read_to_end(&mut bytes).map_err(|_| "Не удалось распаковать обновление.")?;
    if bytes.len() > MAX_UNPACKED { return Err("Распакованный пакет слишком большой.".into()); }
    let bundle: Bundle = serde_json::from_slice(&bytes).map_err(|_| "Неподдерживаемый формат пакета обновления.")?;
    let files = decode_bundle(bundle, &manifest.version)?;
    if files.iter().find(|(name, _)| name == "HumbleLibrary.exe").is_none_or(|(_, bytes)| hash_bytes(bytes) != manifest.app_sha256) { return Err("Контрольная сумма программы не совпадает с подписью.".into()); }
    Ok(files)
}
fn validate_journal(journal: &Journal, root: &Path) -> Result<(), String> {
    let data_root=authorized_data_root(&journal.original_exe,journal.mode)?;
    validate_journal_in_data_root(journal,root,&data_root)
}
fn validate_journal_in_data_root(journal: &Journal, root: &Path, data_root: &Path) -> Result<(), String> {
    if journal.schema != 1 || !valid_id(&journal.id) || journal.files.len() != FILES.len() || journal.helper_pid <= 4 || journal.helper_created == 0
        || !same(&journal.original_exe, &root.join("HumbleLibrary.exe")) || !same(&journal.job_dir, &canonical(&data_root.join("Updates").join(&journal.id))?)
        || !valid_hash(&journal.helper_sha256) || !valid_hash(&journal.app_sha256) || !valid_hash(&journal.marker_sha256)
        || !["preparing", "prepared", "applying", "restarting", "completed", "rolledBack", "needsRecovery"].contains(&journal.state.as_str()) { return Err("Некорректный журнал восстановления обновления.".into()); }
    no_links(&journal.job_dir)?;
    if hash_bytes(&marker_bytes(root,journal.mode)?) != journal.marker_sha256 { return Err("Режим установки программы изменился во время обновления.".into()); }
    let mut seen = BTreeSet::new();
    for file in &journal.files {
        if !FILES.contains(&file.name.as_str()) || !seen.insert(&file.name) || !valid_hash(&file.new_hash) || file.old_hash.as_ref().is_some_and(|hash| !valid_hash(hash)) { return Err("Некорректный список файлов восстановления.".into()); }
    }
    let executable = journal.files.iter().find(|file| file.name == "HumbleLibrary.exe").ok_or("Нет программы в журнале восстановления.")?;
    if executable.old_hash.as_deref() != Some(journal.helper_sha256.as_str()) || executable.new_hash != journal.app_sha256 { return Err("Контрольные суммы программы в журнале не совпадают.".into()); }
    if semver::Version::parse(&journal.version).map_err(err)? <= semver::Version::parse(&journal.from_version).map_err(err)? { return Err("Некорректный переход версий в журнале восстановления.".into()); }
    Ok(())
}
fn load_journal(root: &Path) -> Result<Option<Journal>, String> {
    let path = root.join(JOURNAL); no_links(&path)?;
    if !path.exists() { return Ok(None); }
    let journal = decode_journal(&read_limited(&path, 65536)?)?;
    validate_journal(&journal, root)?;
    Ok(Some(journal))
}
fn prepare(job: &Job, job_dir: &Path, manifest: &Manifest, files: &[(String, Vec<u8>)]) -> Result<Journal, String> {
    let root = job.original_exe.parent().ok_or("Не найден каталог программы.")?;
    fs::create_dir(job_dir.join("new")).map_err(err)?; fs::create_dir(job_dir.join("backup")).map_err(err)?;
    let mut changes = Vec::new();
    for name in FILES {
        changes.push(Change { name: name.into(), old_hash: optional_hash(&root.join(name))?, new_hash: files.iter().find(|(file, _)| file == name).map(|(_, bytes)| hash_bytes(bytes)).ok_or("Нет обязательного файла обновления.")? });
    }
    let (created, _) = process_identity(std::process::id())?;
    let mut journal = Journal { schema: 1, id: job.id.clone(), original_exe: job.original_exe.clone(), job_dir: job_dir.into(), mode:job.mode, repository: job.repository.clone(), from_version: env!("CARGO_PKG_VERSION").into(), version: manifest.version.clone(), helper_pid: std::process::id(), helper_created: created, helper_sha256: hash_file(&job_dir.join("HumbleLibrary.exe"))?, app_sha256: manifest.app_sha256.clone(), marker_sha256: hash_bytes(&marker_bytes(root,job.mode)?), state: "preparing".into(), child_pid: None, child_created: None, files: changes };
    save(&journal)?;
    for change in &journal.files { if let Some(expected) = &change.old_hash { let bytes = read_limited(&root.join(&change.name), MAX_PAYLOAD as usize)?; if hash_bytes(&bytes) != *expected { return Err("Файл программы изменился при подготовке обновления.".into()); } write_new(&job_dir.join("backup").join(&change.name), &bytes)?; } }
    for (name, bytes) in files { write_new(&job_dir.join("new").join(name), bytes)?; }
    journal.state = "prepared".into(); save(&journal)?;
    Ok(journal)
}
fn replace(source: &Path, target: &Path, expected_source: &str, expected_target: &Option<String>) -> Result<(), String> {
    no_links(source)?; no_links(target)?;
    let parent=target.parent().ok_or("Не найден каталог программы.")?; no_links(parent)?;
    // The staged package/profile can live on a different volume from a custom
    // installed app folder. Keep the verified source, and commit only a new
    // temporary beside the target: the final rename is always same-volume.
    let _source_lock=lock_input(source)?;
    let bytes=read_limited(source,MAX_PAYLOAD as usize)?;
    if hash_bytes(&bytes)!=expected_source || optional_hash(target)?!=*expected_target { return Err("Файл программы изменился перед заменой. Обновление остановлено.".into()); }
    let temporary=parent.join(format!(".hl-update-replace-{}.tmp",uuid::Uuid::new_v4()));
    no_links(&temporary)?;
    let mut file=OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(err)?;
    let result=(|| -> Result<(),String> {
        file.write_all(&bytes).map_err(err)?; file.sync_all().map_err(err)?; drop(file);
        let start=Instant::now();
        loop {
            if hash_file(&temporary)?!=expected_source || optional_hash(target)?!=*expected_target { return Err("Файл программы изменился перед заменой. Обновление остановлено.".into()); }
            match fs::rename(&temporary,target) {
                Ok(()) => return Ok(()),
                Err(e) if cfg!(windows) && matches!(e.raw_os_error(),Some(5|32|33)) && start.elapsed()<Duration::from_secs(5) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => return Err(err(e)),
            }
        }
    })();
    if result.is_err() {
        // Only this create_new temporary is eligible for cleanup. The source,
        // backups and a target changed by another process remain untouched.
        no_links(&temporary)?;
        match fs::remove_file(&temporary) { Ok(()) => {}, Err(e) if e.kind()==std::io::ErrorKind::NotFound => {}, Err(e) => return Err(err(e)) }
    }
    result
}
fn rollback(journal: &Journal) -> Result<(), String> {
    let data_root=authorized_data_root(&journal.original_exe,journal.mode)?;
    rollback_in_data_root(journal,&data_root)
}
fn rollback_in_data_root(journal: &Journal, data_root: &Path) -> Result<(), String> {
    let root = journal.original_exe.parent().ok_or("Не найден каталог программы.")?;
    validate_journal_in_data_root(journal, root, data_root)?;
    // Validate the entire transaction before the first rollback mutation.
    for change in &journal.files {
        let current = optional_hash(&root.join(&change.name))?;
        if current == change.old_hash { continue; }
        if current.as_ref().is_some_and(|hash| hash != &change.new_hash) { return Err("Внешние изменения файлов сохранены. Требуется ручное восстановление.".into()); }
        if let Some(old) = &change.old_hash { if optional_hash(&journal.job_dir.join("backup").join(&change.name))?.as_ref() != Some(old) { return Err("Резервная копия обновления повреждена. Файлы сохранены для восстановления.".into()); } }
    }
    for change in journal.files.iter().rev() {
        let target = root.join(&change.name); let current = optional_hash(&target)?;
        if current == change.old_hash { continue; }
        if current.as_ref().is_some_and(|hash| hash != &change.new_hash) { return Err("Файл изменился во время восстановления.".into()); }
        if let Some(old) = &change.old_hash {
            replace(&journal.job_dir.join("backup").join(&change.name), &target, old, &current)?;
        } else if current.is_some() { no_links(&target)?; fs::remove_file(target).map_err(err)?; }
    }
    Ok(())
}
fn healthy(journal: &Journal) -> Result<bool, String> {
    let path = journal.job_dir.join("healthy.json"); if !path.is_file() { return Ok(false); }
    let receipt: Receipt = serde_json::from_slice(&read_limited(&path, 4096)?).map_err(|_| "Некорректное подтверждение запуска.")?;
    Ok(receipt.id == journal.id && receipt.version == journal.version && receipt.app_sha256 == journal.app_sha256)
}
fn write_result(job_dir: &Path, ok: bool, message: Option<&str>) {
    let _ = json(&job_dir.join("result.json"), &serde_json::json!({"ok":ok,"error":message,"at":now()}));
}
fn run_inner(job_path: &Path) -> Result<(), String> {
    standard_user()?;
    let executable = canonical(&std::env::current_exe().map_err(err)?)?;
    let job_dir = executable.parent().ok_or("Не найден каталог помощника.")?;
    if !is_application_executable(&executable) { return Err("Неверное имя помощника обновления.".into()); }
    let _job_lock = lock_input(job_path)?;
    let job = load_job(job_path, job_dir)?;
    let root = job.original_exe.parent().ok_or("Не найден каталог программы.")?;
    let _transaction_lock = update_lock(root)?;
    let _manifest_lock = lock_input(&job.manifest)?; let _signature_lock = lock_input(&job.signature)?; let _payload_lock = lock_input(&job.payload)?;
    let manifest = verified(&job)?;
    if semver::Version::parse(&manifest.version).map_err(err)? <= semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(err)? { return Err("Подписанный пакет не новее доверенного помощника.").map_err(String::from); }
    let existing = load_journal(root)?;
    if let Some(journal) = &existing { if journal.id != job.id || journal.mode != job.mode || journal.repository != job.repository || journal.version != manifest.version || journal.app_sha256 != manifest.app_sha256 || hash_file(&executable)? != journal.helper_sha256 { return Err("Существующий журнал относится к другому обновлению.".into()); } }
    #[cfg(windows)] {
        let parent = windows::Process::open(job.parent_pid)?.ok_or("Исходный процесс программы не найден.")?;
        let (created, parent_exe) = parent.identity()?;
        if created != job.parent_created || !same(&parent_exe, &job.original_exe) { return Err("Процесс программы не совпадает с заданием обновления.".into()); }
        let receipt = HelperReady { id: job.id.clone(), helper_pid: std::process::id(), helper_created: process_identity(std::process::id())?.0 };
        json(&job_dir.join("helper-ready.json"), &receipt)?;
        if !parent.wait(Duration::from_secs(60))? { return Err("Программа не завершилась: обновление отменено.".into()); }
    }
    #[cfg(not(windows))] { return Err("Обновления поддерживаются только в Windows.".into()); }
    #[allow(unreachable_code)]
    if let Some(mut journal) = existing {
        if journal.state == "completed" { return Ok(()); }
        journal.state = "needsRecovery".into(); save(&journal)?;
        rollback(&journal)?;
        journal.state = "rolledBack".into(); save(&journal)?;
        write_result(job_dir, false, Some("Прерванное обновление отменено. Восстановлена предыдущая версия."));
        fs::remove_file(root.join(JOURNAL)).map_err(err)?;
        start_application(&job.original_exe, None)?;
        return Ok(());
    }
    let files = match verified_files(&job.payload, &manifest) {
        Ok(files) => files,
        Err(message) => { write_result(job_dir, false, Some(&message)); start_application(&job.original_exe, None)?; return Err(message); }
    };
    let mut journal = match prepare(&job, job_dir, &manifest, &files) {
        Ok(journal) => journal,
        Err(message) => {
            if let Some(journal) = load_journal(root)? { rollback(&journal)?; fs::remove_file(root.join(JOURNAL)).map_err(err)?; }
            write_result(job_dir, false, Some(&message)); start_application(&job.original_exe, None)?; return Err(message);
        }
    };
    let mut child: Option<Child> = None;
    let applied = (|| -> Result<(), String> {
        journal.state = "applying".into(); save(&journal)?;
        for change in &journal.files { replace(&job_dir.join("new").join(&change.name), &root.join(&change.name), &change.new_hash, &change.old_hash)?; }
        journal.state = "restarting".into(); save(&journal)?;
        let started = start_application(&job.original_exe, Some(&job.id))?;
        let child_pid = started.id(); child = Some(started);
        let (created, _) = process_identity(child_pid)?;
        journal.child_pid = Some(child_pid); journal.child_created = Some(created); save(&journal)?;
        let start = Instant::now();
        loop {
            if healthy(&journal)? { break; }
            if child.as_mut().unwrap().try_wait().map_err(err)?.is_some() { return Err("Новая версия завершилась до готовности интерфейса.".into()); }
            if start.elapsed() > Duration::from_secs(60) { return Err("Новая версия не подтвердила запуск интерфейса.".into()); }
            std::thread::sleep(Duration::from_millis(100));
        }
        journal.state = "completed".into(); save(&journal)?;
        write_result(job_dir, true, None);
        fs::remove_file(root.join(JOURNAL)).map_err(err)?;
        Ok(())
    })();
    if let Err(message) = applied {
        if let Some(child) = &mut child { let _ = child.kill(); let _ = child.wait(); }
        journal.state = "needsRecovery".into(); save(&journal)?;
        if let Err(rollback_error) = rollback(&journal) { write_result(job_dir, false, Some(&rollback_error)); return Err(rollback_error); }
        journal.state = "rolledBack".into(); save(&journal)?;
        write_result(job_dir, false, Some(&message));
        fs::remove_file(root.join(JOURNAL)).map_err(err)?;
        start_application(&job.original_exe, None)?;
    }
    Ok(())
}
pub(crate) fn run(job_path: &Path) -> Result<(), String> {
    let result = run_inner(job_path);
    if let Err(error) = &result { if let Some(parent) = job_path.parent() { if parent.file_name().and_then(|name| name.to_str()).is_some_and(valid_id) { write_result(parent, false, Some(error)); } } }
    result
}
pub(crate) fn ready_for_parent(directory: &Path, id: &str, pid: u32) -> Result<bool, String> {
    let path = directory.join("helper-ready.json"); if !path.is_file() { return Ok(false); }
    let receipt: HelperReady = serde_json::from_slice(&read_limited(&path, 4096)?).map_err(|_| "Некорректный ответ помощника обновления.")?;
    Ok(receipt.id == id && receipt.helper_pid == pid && alive(pid, receipt.helper_created, &canonical(&directory.join("HumbleLibrary.exe"))?)?)
}
fn restart_id() -> Option<String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 2 && args[0] == "--update-restart" { args[1].to_str().filter(|id| valid_id(id)).map(str::to_owned) } else { None }
}
pub(crate) fn confirm_ready() -> Result<(), String> {
    let Some(id) = restart_id() else { return Ok(()); };
    let executable = canonical(&std::env::current_exe().map_err(err)?)?;
    let root = executable.parent().ok_or("Не найден каталог программы.")?;
    let Some(journal) = load_journal(root)? else { return Ok(()); };
    if journal.id != id || journal.state != "restarting" || journal.version != env!("CARGO_PKG_VERSION") || !same(&executable, &journal.original_exe) || hash_file(&executable)? != journal.app_sha256 || !alive(journal.helper_pid, journal.helper_created, &journal.job_dir.join("HumbleLibrary.exe"))? { return Err("Не удалось подтвердить запуск обновления.".into()); }
    let job = load_job(&journal.job_dir.join("job.json"), &journal.job_dir)?;
    let manifest = verified(&job)?;
    if manifest.app_sha256 != journal.app_sha256 || manifest.version != journal.version { return Err("Обновление не совпадает с подписанным пакетом.".into()); }
    json(&journal.job_dir.join("healthy.json"), &Receipt { id, version: journal.version, app_sha256: journal.app_sha256 })
}
pub(crate) fn startup() -> Result<bool, String> {
    let executable = canonical(&std::env::current_exe().map_err(err)?)?;
    let root = executable.parent().ok_or("Не найден каталог программы.")?;
    let Some(journal) = load_journal(root)? else { return Ok(false); };
    let job_path = journal.job_dir.join("job.json");
    let mut job = load_job(&job_path, &journal.job_dir)?;
    let manifest = verified(&job)?;
    if journal.version != manifest.version || journal.app_sha256 != manifest.app_sha256 || journal.repository != manifest.repository { return Err("Журнал не совпадает с подписанным обновлением.".into()); }
    if alive(journal.helper_pid, journal.helper_created, &journal.job_dir.join("HumbleLibrary.exe"))? {
        if restart_id().as_deref() == Some(&journal.id) && journal.state == "restarting" && hash_file(&executable)? == journal.app_sha256 { return Ok(false); }
        return Ok(true);
    }
    if matches!(journal.state.as_str(), "completed" | "rolledBack") { fs::remove_file(root.join(JOURNAL)).map_err(err)?; return Ok(false); }
    if let (Some(pid), Some(created)) = (journal.child_pid, journal.child_created) {
        if pid != std::process::id() && alive(pid, created, &journal.original_exe)? { return Err("Закройте другую копию Humble Library перед восстановлением обновления.".into()); }
    }
    let helper_path = journal.job_dir.join("HumbleLibrary.exe");
    if hash_file(&helper_path)? != journal.helper_sha256 { return Err("Помощник восстановления изменён. Файлы обновления сохранены.".into()); }
    let (created, image) = process_identity(std::process::id())?;
    if !same(&image, &journal.original_exe) { return Err("Восстановление запущено из другого каталога.".into()); }
    job.parent_pid = std::process::id(); job.parent_created = created;
    json(&job_path, &job)?;
    // A dead helper may have left its readiness receipt. Remove only this exact
    // owned file; recovery will issue a fresh receipt after validating the job.
    let ready = journal.job_dir.join("helper-ready.json"); no_links(&ready)?; if ready.is_file() { fs::remove_file(ready).map_err(err)?; }
    let mut runner = launch(&helper_path, &job_path)?;
    for _ in 0..100 {
        if runner.try_wait().map_err(err)?.is_some() { return Err("Помощник восстановления завершился до подтверждения запуска.".into()); }
        match ready_for_parent(&journal.job_dir, &journal.id, runner.id()) {
            Ok(true) => return Ok(true),
            Ok(false) => {},
            Err(message) => { let _ = runner.kill(); let _ = runner.wait(); return Err(message); }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = runner.kill(); let _ = runner.wait();
    Err("Помощник восстановления не ответил. Резервные копии сохранены.".into())
}
pub(crate) fn last_error() -> Option<String> {
    let stage: Stage = serde_json::from_slice(&read_limited(&updates().join("staged.json"), 4096).ok()?).ok()?;
    if !valid_id(&stage.directory) { return None; }
    let result: Value = serde_json::from_slice(&read_limited(&updates().join(stage.directory).join("result.json"), 8192).ok()?).ok()?;
    if result.get("ok").and_then(Value::as_bool) != Some(false) { return None; }
    result.get("error").and_then(Value::as_str).map(|message| message.chars().take(1000).collect())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn replacement_copies_to_target_parent_preserves_source_and_external_target() {
        let base=std::env::temp_dir().join(format!("hl-replace-unit-{}",uuid::Uuid::new_v4())); fs::create_dir_all(base.join("source")).unwrap(); fs::create_dir(base.join("target")).unwrap(); let base=canonical(&base).unwrap();
        let source=base.join("source/HumbleLibrary.exe"); let target=base.join("target/HumbleLibrary.exe"); let new=b"NEW-REPLACEMENT-FIXTURE"; let old=b"OLD-REPLACEMENT-FIXTURE";
        fs::write(&source,new).unwrap(); fs::write(&target,old).unwrap(); replace(&source,&target,&hash_bytes(new),&Some(hash_bytes(old))).unwrap();
        assert_eq!(fs::read(&source).unwrap(),new); assert_eq!(fs::read(&target).unwrap(),new); assert_eq!(hash_file(&target).unwrap(),hash_bytes(new));
        fs::write(&target,b"EXTERNAL-EDIT").unwrap(); assert!(replace(&source,&target,&hash_bytes(new),&Some(hash_bytes(old))).is_err()); assert_eq!(fs::read(&target).unwrap(),b"EXTERNAL-EDIT"); assert_eq!(fs::read(&source).unwrap(),new);
        assert!(!fs::read_dir(target.parent().unwrap()).unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().starts_with(".hl-update-replace-")));
        assert_eq!(base.parent().unwrap(),canonical(&std::env::temp_dir()).unwrap()); assert!(base.file_name().unwrap().to_string_lossy().starts_with("hl-replace-unit-")); fs::remove_dir_all(base).unwrap();
    }
    #[test] #[cfg(windows)] fn replacement_failure_cleans_target_temporary_without_touching_verified_source() {
        let base=std::env::temp_dir().join(format!("hl-replace-lock-unit-{}",uuid::Uuid::new_v4())); fs::create_dir_all(&base).unwrap(); let base=canonical(&base).unwrap(); let source=base.join("source.fixture"); let target=base.join("HumbleLibrary.exe");
        fs::write(&source,b"NEW-LOCK-FIXTURE").unwrap(); fs::write(&target,b"OLD-LOCK-FIXTURE").unwrap();
        let target_lock=lock_input(&target).unwrap(); assert!(replace(&source,&target,&hash_bytes(b"NEW-LOCK-FIXTURE"),&Some(hash_bytes(b"OLD-LOCK-FIXTURE"))).is_err()); drop(target_lock);
        assert_eq!(fs::read(&source).unwrap(),b"NEW-LOCK-FIXTURE"); assert_eq!(fs::read(&target).unwrap(),b"OLD-LOCK-FIXTURE"); assert!(!fs::read_dir(&base).unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().starts_with(".hl-update-replace-")));
        assert_eq!(base.parent().unwrap(),canonical(&std::env::temp_dir()).unwrap()); assert!(base.file_name().unwrap().to_string_lossy().starts_with("hl-replace-lock-unit-")); fs::remove_dir_all(base).unwrap();
    }
    #[test] #[cfg(windows)] #[ignore="Requires distinct C user Temp and workspace volumes; uses only fresh synthetic fixture folders."]
    fn real_cross_volume_commit_and_restore_preserve_verified_sources() {
        let user=std::env::var_os("USERPROFILE").map(PathBuf::from).expect("USERPROFILE is required"); let c_parent=canonical(&user.join("AppData/Local/Temp")).unwrap();
        let project=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf(); let d_parent=project.join("verification/current"); no_links(&d_parent).unwrap(); fs::create_dir_all(&d_parent).unwrap(); let d_parent=canonical(&d_parent).unwrap();
        let volume=|path:&Path| path.components().next().unwrap().as_os_str().to_string_lossy().to_ascii_lowercase(); assert_ne!(volume(&c_parent),volume(&d_parent),"This explicit fixture requires different filesystem volumes");
        let id=uuid::Uuid::new_v4().to_string(); let c_root=c_parent.join(format!("hl-cross-volume-unit-{id}")); let d_root=d_parent.join(format!("hl-cross-volume-unit-{id}")); fs::create_dir(&c_root).unwrap(); fs::create_dir(&d_root).unwrap(); let c_root=canonical(&c_root).unwrap(); let d_root=canonical(&d_root).unwrap();
        let source=c_root.join("stage.fixture"); let target=d_root.join("HumbleLibrary.exe"); fs::write(&source,b"NEW-CROSS-VOLUME-FIXTURE").unwrap(); fs::write(&target,b"OLD-CROSS-VOLUME-FIXTURE").unwrap();
        replace(&source,&target,&hash_bytes(b"NEW-CROSS-VOLUME-FIXTURE"),&Some(hash_bytes(b"OLD-CROSS-VOLUME-FIXTURE"))).unwrap(); assert_eq!(fs::read(&source).unwrap(),b"NEW-CROSS-VOLUME-FIXTURE"); assert_eq!(fs::read(&target).unwrap(),b"NEW-CROSS-VOLUME-FIXTURE");
        let backup=d_root.join("backup.fixture"); let restore=c_root.join("HumbleLibrary.exe"); fs::write(&backup,b"OLD-CROSS-VOLUME-FIXTURE").unwrap(); fs::write(&restore,b"NEW-CROSS-VOLUME-FIXTURE").unwrap();
        replace(&backup,&restore,&hash_bytes(b"OLD-CROSS-VOLUME-FIXTURE"),&Some(hash_bytes(b"NEW-CROSS-VOLUME-FIXTURE"))).unwrap(); assert_eq!(fs::read(&backup).unwrap(),b"OLD-CROSS-VOLUME-FIXTURE"); assert_eq!(fs::read(&restore).unwrap(),b"OLD-CROSS-VOLUME-FIXTURE");
        for root in [&c_root,&d_root] { assert!(!fs::read_dir(root).unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().starts_with(".hl-update-replace-"))); assert!(root.file_name().unwrap().to_string_lossy().starts_with("hl-cross-volume-unit-")); }
        assert_eq!(c_root.parent().unwrap(),c_parent); assert_eq!(d_root.parent().unwrap(),d_parent); fs::remove_dir_all(c_root).unwrap(); fs::remove_dir_all(d_root).unwrap();
    }
    #[test] fn operating_system_executable_filename_policy() {
        assert!(is_application_executable(Path::new("HumbleLibrary.exe")));
        #[cfg(windows)] for name in ["humblelibrary.exe", "HUMBLELIBRARY.EXE", "hUmBlElIbRaRy.ExE"] { assert!(is_application_executable(Path::new(name))); }
        #[cfg(not(windows))] assert!(!is_application_executable(Path::new("humblelibrary.exe")));
        for name in ["Other.exe", "HumbleLibrary.exe.bak", "HumbleLibrary", "HumbleLibrary.exe.exe", ""] { assert!(!is_application_executable(Path::new(name))); }
    }
    fn bundle() -> Bundle { Bundle { schema: 1, version: "0.2.0".into(), files: FILES.iter().map(|name| BundleFile { name: (*name).into(), data: base64::engine::general_purpose::STANDARD.encode(format!("fixture:{name}")) }).collect() } }
    #[test] fn exact_owned_files_only_and_data_never_unpack() { assert_eq!(decode_bundle(bundle(), "0.2.0").unwrap().len(), 4); for name in ["../HumbleLibrary.exe", "Data/library.dpapi", "portable.marker", "installed.marker", "helper.ps1", "humblelibrary.exe"] { let mut b=bundle(); b.files[0].name=name.into(); assert!(decode_bundle(b,"0.2.0").is_err()); } }
    #[test] fn duplicate_missing_version_and_empty_payloads_rejected() { let mut b=bundle(); b.files[1].name=b.files[0].name.clone(); assert!(decode_bundle(b,"0.2.0").is_err()); let mut b=bundle(); b.files.pop(); assert!(decode_bundle(b,"0.2.0").is_err()); assert!(decode_bundle(bundle(),"0.3.0").is_err()); let mut b=bundle(); b.files[0].data.clear(); assert!(decode_bundle(b,"0.2.0").is_err()); }
    #[test] fn fixed_uuid_job_directory() { assert!(valid_id("01234567-89ab-4def-8123-456789abcdef")); for id in ["../Data", "0123456789ab4def8123456789abcdef", "01234567-89AB-4DEF-8123-456789ABCDEF", ""] { assert!(!valid_id(id)); } }
    #[test] fn rollback_preserves_data_and_external_edits() {
        let root = std::env::temp_dir().join(format!("hl-update-unit-{}", uuid::Uuid::new_v4())); fs::create_dir_all(&root).unwrap();
        let root = canonical(&root).unwrap(); let id=uuid::Uuid::new_v4().to_string(); let job_dir=root.join("Data/Updates").join(&id); fs::create_dir_all(job_dir.join("backup")).unwrap();
        fs::write(root.join("portable.marker"),b"fixture").unwrap(); fs::write(root.join("Data/library.dpapi"),b"USER-DATA-FIXTURE").unwrap();
        let mut changes=Vec::new(); for name in FILES { let old=format!("old:{name}").into_bytes(); let new=format!("new:{name}").into_bytes(); fs::write(root.join(name),&new).unwrap(); fs::write(job_dir.join("backup").join(name),&old).unwrap(); changes.push(Change{name:name.into(),old_hash:Some(hash_bytes(&old)),new_hash:hash_bytes(&new)}); }
        let journal=Journal{schema:1,id,original_exe:root.join("HumbleLibrary.exe"),job_dir,mode:InstallationMode::Portable,repository:"fixture/Library".into(),from_version:"0.1.0".into(),version:"0.2.0".into(),helper_pid:12345,helper_created:1,helper_sha256:hash_bytes(b"old:HumbleLibrary.exe"),app_sha256:hash_bytes(b"new:HumbleLibrary.exe"),marker_sha256:hash_file(&root.join("portable.marker")).unwrap(),state:"needsRecovery".into(),child_pid:None,child_created:None,files:changes};
        assert!(decode_journal(&serde_json::to_vec(&journal).unwrap()).is_err());
        #[cfg(windows)] {
            let encrypted=encode_journal(&journal).unwrap(); assert!(!encrypted.windows(b"needsRecovery".len()).any(|window|window==b"needsRecovery")); assert_eq!(decode_journal(&encrypted).unwrap().helper_sha256,journal.helper_sha256);
            let mut corrupt=encrypted; let middle=corrupt.len()/2; corrupt[middle]^=0x55; assert!(decode_journal(&corrupt).is_err());
            save(&journal).unwrap(); assert_eq!(load_journal(&root).unwrap().unwrap().files[0].old_hash,journal.files[0].old_hash);
        }
        fs::write(root.join("README.md"),b"EXTERNAL-EDIT").unwrap(); assert!(rollback(&journal).is_err()); assert_eq!(fs::read(root.join("HumbleLibrary.exe")).unwrap(),b"new:HumbleLibrary.exe");
        fs::write(root.join("README.md"),b"new:README.md").unwrap(); rollback(&journal).unwrap(); assert_eq!(fs::read(root.join("HumbleLibrary.exe")).unwrap(),b"old:HumbleLibrary.exe"); assert_eq!(fs::read(root.join("Data/library.dpapi")).unwrap(),b"USER-DATA-FIXTURE");
        assert_eq!(root.parent().unwrap(), canonical(&std::env::temp_dir()).unwrap());
        assert!(root.file_name().unwrap().to_string_lossy().starts_with("hl-update-unit-"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn installed_recovery_binds_derived_profile_and_preserves_user_data() {
        let base=std::env::temp_dir().join(format!("hl-installed-update-unit-{}",uuid::Uuid::new_v4())); fs::create_dir_all(base.join("Application")).unwrap(); let base=canonical(&base).unwrap(); let root=base.join("Application"); let local=base.join("LocalAppData");
        fs::write(root.join("installed.marker"),br#"{"schema":1,"application":"HumbleLibrary","scope":"current-user"}"#).unwrap();
        let data_root=data_root_at(&root.join("HumbleLibrary.exe"),InstallationMode::Installed,Some(&local)).unwrap(); let id=uuid::Uuid::new_v4().to_string(); let job_dir=data_root.join("Updates").join(&id); fs::create_dir_all(job_dir.join("backup")).unwrap();
        fs::write(data_root.join("library.dpapi"),b"PROFILE-LIBRARY-FIXTURE").unwrap(); fs::create_dir_all(data_root.join("Account")).unwrap(); fs::write(data_root.join("Account/session.fixture"),b"PROFILE-SESSION-FIXTURE").unwrap(); fs::create_dir_all(root.join("Data")).unwrap(); fs::write(root.join("Data/unrelated.fixture"),b"APP-NEIGHBOR-FIXTURE").unwrap();
        let mut changes=Vec::new(); for name in FILES { let old=format!("old:{name}").into_bytes(); let new=format!("new:{name}").into_bytes(); fs::write(root.join(name),&new).unwrap(); fs::write(job_dir.join("backup").join(name),&old).unwrap(); changes.push(Change{name:name.into(),old_hash:Some(hash_bytes(&old)),new_hash:hash_bytes(&new)}); }
        let journal=Journal{schema:1,id,original_exe:root.join("HumbleLibrary.exe"),job_dir:canonical(&job_dir).unwrap(),mode:InstallationMode::Installed,repository:"fixture/Library".into(),from_version:"0.1.0".into(),version:"0.2.0".into(),helper_pid:12345,helper_created:1,helper_sha256:hash_bytes(b"old:HumbleLibrary.exe"),app_sha256:hash_bytes(b"new:HumbleLibrary.exe"),marker_sha256:hash_bytes(&marker_bytes(&root,InstallationMode::Installed).unwrap()),state:"needsRecovery".into(),child_pid:None,child_created:None,files:changes};
        assert!(validate_journal_in_data_root(&journal,&root,&data_root).is_ok());
        let mut forged=journal.clone(); forged.job_dir=root.join("Data/Updates").join(&journal.id); assert!(validate_journal_in_data_root(&forged,&root,&data_root).is_err()); forged=journal.clone(); forged.mode=InstallationMode::Portable; assert!(validate_journal_in_data_root(&forged,&root,&data_root).is_err());
        #[cfg(windows)] { let encrypted=encode_journal(&journal).unwrap(); assert_eq!(decode_journal(&encrypted).unwrap().mode,InstallationMode::Installed); }
        rollback_in_data_root(&journal,&data_root).unwrap(); assert_eq!(fs::read(root.join("HumbleLibrary.exe")).unwrap(),b"old:HumbleLibrary.exe");
        assert_eq!(fs::read(data_root.join("library.dpapi")).unwrap(),b"PROFILE-LIBRARY-FIXTURE"); assert_eq!(fs::read(data_root.join("Account/session.fixture")).unwrap(),b"PROFILE-SESSION-FIXTURE"); assert_eq!(fs::read(root.join("Data/unrelated.fixture")).unwrap(),b"APP-NEIGHBOR-FIXTURE");
        fs::write(root.join("installed.marker"),br#"{"schema":1,"application":"HumbleLibrary","scope":"all-users"}"#).unwrap(); assert!(validate_journal_in_data_root(&journal,&root,&data_root).is_err());
        assert_eq!(base.parent().unwrap(),canonical(&std::env::temp_dir()).unwrap()); assert!(base.file_name().unwrap().to_string_lossy().starts_with("hl-installed-update-unit-")); fs::remove_dir_all(base).unwrap();
    }
}
