use std::{fs, io::Write, path::{Path,PathBuf}, sync::Mutex};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
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

#[derive(Clone,Default)]
pub struct LibrarySnapshot {
    pub bundles:Vec<Bundle>,
    pub account_key:Option<String>,
    pub enumeration_complete:Option<bool>,
    pub last_sync:Option<String>,
    pub source_projection:Option<SourceProjection>,
    pub retained_licenses:Vec<RetainedLicense>,
    pub recovered_bundles:Vec<RecoveryPurchase>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RecoveryPurchase { pub source_hash:String, pub source_account_key:Option<String>, pub original_parent:Bundle }
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct RecoveryInbox { schema:u8, account_key:String, recovered_bundles:Vec<RecoveryPurchase> }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct RecoverySummary { pub source_files:usize, pub source_purchases:usize, pub source_license_rows:usize }
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
pub enum SourceProjection { #[serde(rename="bundles-v1")] BundlesV1 }
#[derive(Clone,Debug,PartialEq,Eq,PartialOrd,Ord,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedLicense {
    pub id:String,
    pub key:String,
    #[serde(default,rename="parentId",skip_serializing_if="Option::is_none")]
    pub parent_id:Option<String>,
}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct StoredSnapshot {
    schema:u8,
    bundles:Vec<Bundle>,
    #[serde(default,skip_serializing_if="Option::is_none")] account_key:Option<String>,
    #[serde(deserialize_with="deserialize_completion")] enumeration_complete:Option<bool>,
    #[serde(default)] last_sync:Option<String>,
    #[serde(default)] source_projection:Option<SourceProjection>,
    #[serde(default)] retained_licenses:Vec<RetainedLicense>,
    #[serde(default,skip_serializing_if="Vec::is_empty")] recovered_bundles:Vec<RecoveryPurchase>,
}
fn deserialize_completion<'de,D:serde::Deserializer<'de>>(deserializer:D)->Result<Option<bool>,D::Error>{Option::<bool>::deserialize(deserializer)}
pub fn valid_account_key(value:&str)->bool { value.len()==64&&value.bytes().all(|byte|byte.is_ascii_digit()||(b'a'..=b'f').contains(&byte)) }
fn valid_retained_parent(value:&str)->bool {
    value.strip_prefix("bundle-").is_some_and(|id|!id.is_empty()&&id.len()<=256&&id.bytes().all(|byte|byte.is_ascii_alphanumeric()||matches!(byte,b'_'|b'-')))
}
pub fn valid_retained_licenses(licenses:&[RetainedLicense])->bool {
    licenses.len()<=100000&&licenses.iter().all(|license|!license.id.is_empty()&&license.id.len()<=1024&&!license.id.chars().any(char::is_control)&&!license.key.is_empty()&&license.key.len()<=262144&&!license.key.chars().any(|c|c=='\0'||c.is_control()&&!matches!(c,'\r'|'\n'|'\t'))&&license.parent_id.as_deref().is_none_or(valid_retained_parent))&&licenses.iter().map(|license|license.id.len()+license.key.len()+license.parent_id.as_ref().map_or(0,String::len)).sum::<usize>()<=32*1024*1024
}
fn valid_private_metadata(account_key:&Option<String>,projection:Option<SourceProjection>,licenses:&[RetainedLicense])->bool {
    valid_retained_licenses(licenses)&&(licenses.is_empty()||account_key.is_some()&&projection==Some(SourceProjection::BundlesV1))&&(projection.is_none()||account_key.is_some())
}
fn encode(snapshot:&LibrarySnapshot)->Result<Vec<u8>,String> {
    if snapshot.account_key.as_ref().is_some_and(|key|!valid_account_key(key))||snapshot.last_sync.as_ref().is_some_and(|stamp|stamp.len()>100||stamp.contains('\0'))||!valid_private_metadata(&snapshot.account_key,snapshot.source_projection,&snapshot.retained_licenses)||!valid_recovery(&snapshot.recovered_bundles,snapshot.account_key.as_deref()){return Err("Не удалось сохранить формат библиотеки".into())}
    serde_json::to_vec(&StoredSnapshot{schema:3,bundles:snapshot.bundles.clone(),account_key:snapshot.account_key.clone(),enumeration_complete:snapshot.enumeration_complete,last_sync:snapshot.last_sync.clone(),source_projection:snapshot.source_projection,retained_licenses:snapshot.retained_licenses.clone(),recovered_bundles:snapshot.recovered_bundles.clone()}).map_err(|_|"Не удалось сохранить библиотеку".into())
}
fn decode(bytes:&[u8])->Result<LibrarySnapshot,String> {
    let value:serde_json::Value=serde_json::from_slice(bytes).map_err(|_|"Не удалось прочитать формат локальной библиотеки")?;
    if value.is_array(){return serde_json::from_value(value).map(|bundles|LibrarySnapshot{bundles,..LibrarySnapshot::default()}).map_err(|_|"Не удалось прочитать формат локальной библиотеки".into())}
    let schema=value.get("schema").and_then(serde_json::Value::as_u64);
    if !matches!(schema,Some(2|3))||schema==Some(2)&&(value.get("sourceProjection").is_some()||value.get("retainedLicenses").is_some()||value.get("recoveredBundles").is_some())||schema==Some(3)&&(value.get("sourceProjection").is_none()||value.get("retainedLicenses").is_none()){return Err("Не удалось прочитать формат локальной библиотеки".into())}
    let stored:StoredSnapshot=serde_json::from_value(value).map_err(|_|"Не удалось прочитать формат локальной библиотеки")?;
    if stored.account_key.as_ref().is_some_and(|key|!valid_account_key(key))||stored.last_sync.as_ref().is_some_and(|stamp|stamp.len()>100||stamp.contains('\0'))||!valid_private_metadata(&stored.account_key,stored.source_projection,&stored.retained_licenses)||!valid_recovery(&stored.recovered_bundles,stored.account_key.as_deref()){return Err("Не удалось прочитать формат локальной библиотеки".into())}
    Ok(LibrarySnapshot{bundles:stored.bundles,account_key:stored.account_key,enumeration_complete:stored.enumeration_complete,last_sync:stored.last_sync,source_projection:stored.source_projection,retained_licenses:stored.retained_licenses,recovered_bundles:stored.recovered_bundles})
}
fn legacy_parent(bundle:&Bundle)->bool { !bundle.recovered&&bundle.source_url.is_none()&&crate::humble::validate_bundles(std::slice::from_ref(bundle)).is_ok() }
fn valid_recovery(values:&[RecoveryPurchase],account:Option<&str>)->bool {
    if values.len()>10000||!values.is_empty()&&account.is_none(){return false}
    let mut identities=std::collections::HashSet::new();let mut items=0;
    for value in values{
        items+=value.original_parent.items.len();
        if items>100000||!valid_account_key(&value.source_hash)||value.source_account_key.as_deref().is_some_and(|source|Some(source)!=account)||!legacy_parent(&value.original_parent)||!identities.insert((&value.source_hash,&value.original_parent.id)){return false}
    }
    serde_json::to_vec(values).is_ok_and(|bytes|bytes.len()<=32*1024*1024)
}
fn encrypted_file(path:&Path)->Result<Vec<u8>,String>{
    let metadata=fs::metadata(path).map_err(|_|"Не удалось прочитать сохранённую библиотеку")?;
    if !metadata.is_file()||metadata.len()>64*1024*1024{return Err("Неподдерживаемый формат сохранённой библиотеки".into())}
    fs::read(path).map_err(|_|"Не удалось прочитать сохранённую библиотеку".into())
}
fn write_inbox_at(folder:&Path,inbox:&RecoveryInbox)->Result<(),String>{
    let bytes=serde_json::to_vec(inbox).map_err(|_|"Не удалось подготовить восстановление")?;let encrypted=protect(&bytes,false)?;
    fs::create_dir_all(folder).map_err(|_|"Не удалось подготовить восстановление")?;
    let temporary=folder.join(format!("recovery-{}.tmp",uuid::Uuid::new_v4()));
    if let Err(failure)=write_new(&temporary,&encrypted){let _=fs::remove_file(&temporary);return Err(failure)}
    fs::rename(&temporary,folder.join("recovery-inbox.dpapi")).map_err(|_|{let _=fs::remove_file(&temporary);"Не удалось сохранить подготовленное восстановление".into()})
}
pub fn prepare_recovery_inbox_at(folder:&Path,paths:&[PathBuf],allow_unbound:bool)->Result<RecoverySummary,String>{
    let _guard=WRITE.lock().map_err(|_|"Хранилище занято")?;
    if paths.is_empty()||paths.len()>16{return Err("Выберите от одного до шестнадцати файлов библиотеки".into())}
    let target=load_at(folder)?;crate::humble::validate_parent_bundles(&target.bundles)?;let account=target.account_key.as_deref().filter(|_|target.source_projection==Some(SourceProjection::BundlesV1)).ok_or("Сначала обновите библиотеку текущего аккаунта")?;
    let mut values=Vec::new();let inbox_path=folder.join("recovery-inbox.dpapi");
    if inbox_path.exists(){let pending:RecoveryInbox=serde_json::from_slice(&protect(&encrypted_file(&inbox_path)?,true)?).map_err(|_|"Не удалось прочитать подготовленное восстановление")?;if pending.schema!=1||pending.account_key!=account||!valid_recovery(&pending.recovered_bundles,Some(account)){return Err("Подготовленное восстановление относится к другому аккаунту или повреждено".into())}values=pending.recovered_bundles;}
    let mut summary=RecoverySummary{source_files:0,source_purchases:0,source_license_rows:0};let mut total_bytes=0;
    for path in paths{
        let encrypted=encrypted_file(path)?;total_bytes+=encrypted.len();if total_bytes>64*1024*1024{return Err("Сохранённые библиотеки слишком велики".into())}
        let source=decode(&protect(&encrypted,true)?)?;
        crate::humble::validate_bundles(&source.bundles)?;
        if source.account_key.as_deref().is_some_and(|source|source!=account)||source.account_key.is_none()&&!allow_unbound{return Err("Импорт этой библиотеки не разрешён для текущего аккаунта".into())}
        if source.source_projection.is_some()||!source.recovered_bundles.is_empty()||source.bundles.iter().any(|bundle|!legacy_parent(bundle)){return Err("Выберите исходную библиотеку старых покупок Humble Bundle".into())}
        let source_hash=format!("{:x}",Sha256::digest(&encrypted));summary.source_files+=1;
        for bundle in source.bundles.into_iter().filter(|bundle|bundle.items.iter().any(|item|item.key.is_some())){
            summary.source_purchases+=1;summary.source_license_rows+=bundle.items.iter().filter(|item|item.key.is_some()).count();
            if !values.iter().any(|value|value.source_hash==source_hash&&value.original_parent.id==bundle.id){values.push(RecoveryPurchase{source_hash:source_hash.clone(),source_account_key:source.account_key.clone(),original_parent:bundle});}
        }
    }
    if !valid_recovery(&values,Some(account)){return Err("Неподдерживаемый формат сохранённых покупок".into())}
    write_inbox_at(folder,&RecoveryInbox{schema:1,account_key:account.to_owned(),recovered_bundles:values})?;Ok(summary)
}
pub fn consume_recovery_inbox_at(folder:&Path)->Result<LibrarySnapshot,String>{
    let _guard=WRITE.lock().map_err(|_|"Хранилище занято")?;let mut target=load_at(folder)?;let path=folder.join("recovery-inbox.dpapi");if !path.exists(){return Ok(target)}
    let inbox:RecoveryInbox=serde_json::from_slice(&protect(&encrypted_file(&path)?,true)?).map_err(|_|"Не удалось прочитать подготовленное восстановление")?;
    if inbox.schema!=1||!valid_recovery(&inbox.recovered_bundles,Some(&inbox.account_key)){return Err("Подготовленное восстановление относится к другому аккаунту или повреждено".into())}
    if target.source_projection!=Some(SourceProjection::BundlesV1)||target.account_key.as_deref()!=Some(inbox.account_key.as_str()){return Ok(target)}
    crate::humble::validate_parent_bundles(&target.bundles)?;
    let previous=target.clone();let mut changed=false;
    for value in inbox.recovered_bundles{if !target.recovered_bundles.iter().any(|known|known.source_hash==value.source_hash&&known.original_parent.id==value.original_parent.id){target.recovered_bundles.push(value);changed=true}}
    if !valid_recovery(&target.recovered_bundles,target.account_key.as_deref()){return Err("Сохранённые покупки слишком велики".into())}
    if changed{save_at(folder,&target,Some(&previous))?}
    // If cleanup fails, the validated inbox is harmless and consumed again
    // idempotently after restart. Never remove it before the durable commit.
    let _=fs::remove_file(path);Ok(target)
}
fn load_at(folder:&Path)->Result<LibrarySnapshot,String> {
    let path=folder.join("library.dpapi");
    if !path.exists(){return Ok(LibrarySnapshot::default())}
    let metadata = fs::metadata(&path).map_err(|_| "Не удалось прочитать локальную библиотеку")?;
    if metadata.len() > 64 * 1024 * 1024 { return Err("Локальная библиотека слишком велика".into()); }
    let bytes = fs::read(path).map_err(|_| "Не удалось прочитать локальную библиотеку")?;
    decode(&protect(&bytes,true)?)
}
fn write_new(path:&Path,bytes:&[u8])->Result<(),String>{
    let mut file=fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|_|"Не удалось записать локальную библиотеку")?;
    file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|_|"Не удалось записать локальную библиотеку".into())
}
fn save_at(folder:&Path,snapshot:&LibrarySnapshot,archive:Option<&LibrarySnapshot>)->Result<(),String>{
    fs::create_dir_all(folder).map_err(|_|"Не удалось создать локальное хранилище")?;
    if let Some(previous)=archive.filter(|previous|!previous.bundles.is_empty()||!previous.retained_licenses.is_empty()||!previous.recovered_bundles.is_empty()) {
        let encrypted=protect(&encode(previous)?,false)?;
        let path=folder.join(format!("library-archive-{}.dpapi",uuid::Uuid::new_v4()));
        write_new(&path,&encrypted).map_err(|_|"Не удалось сохранить архив предыдущей библиотеки")?;
    }
    let encrypted=protect(&encode(snapshot)?,false)?;
    let temporary = folder.join(format!("library-{}.tmp", uuid::Uuid::new_v4()));
    if let Err(failure)=write_new(&temporary,&encrypted){let _=fs::remove_file(&temporary);return Err(failure)}
    fs::rename(&temporary, folder.join("library.dpapi")).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        "Не удалось заменить локальную библиотеку"
    })?;
    Ok(())
}
fn owned_archive(name:&str)->bool {
    let Some(token)=name.strip_prefix("library-archive-").and_then(|tail|tail.strip_suffix(".dpapi"))else{return false};
    uuid::Uuid::parse_str(token).ok().is_some_and(|id|id.to_string()==token)
}
fn clear_at(folder:&Path)->Result<(),String>{
    if folder.exists(){
        for entry in fs::read_dir(folder).map_err(|_|"Не удалось очистить архивы библиотеки")?{
            let entry=entry.map_err(|_|"Не удалось очистить архивы библиотеки")?;
            if !entry.file_name().to_str().is_some_and(owned_archive){continue}
            if !entry.file_type().map_err(|_|"Не удалось очистить архивы библиотеки")?.is_file(){return Err("Не удалось очистить архивы библиотеки".into())}
            fs::remove_file(entry.path()).map_err(|_|"Не удалось очистить архивы библиотеки")?;
        }
    }
    save_at(folder,&LibrarySnapshot::default(),None)?;
    let inbox=folder.join("recovery-inbox.dpapi");if inbox.exists(){fs::remove_file(inbox).map_err(|_|"Не удалось очистить подготовленное восстановление")?;}Ok(())
}
pub fn load_snapshot()->Result<LibrarySnapshot,String>{let _guard=WRITE.lock().map_err(|_|"Хранилище занято")?;load_at(&root())}
pub fn save_snapshot(snapshot:&LibrarySnapshot,archive:Option<&LibrarySnapshot>)->Result<(),String>{let _guard=WRITE.lock().map_err(|_|"Хранилище занято")?;save_at(&root(),snapshot,archive)}
pub fn clear_library_all()->Result<(),String>{let _guard=WRITE.lock().map_err(|_|"Хранилище занято")?;clear_at(&root())}
pub fn save_library(bundles:&[Bundle])->Result<(),String>{save_snapshot(&LibrarySnapshot{bundles:bundles.to_vec(),..LibrarySnapshot::default()},None)}

#[cfg(test)]
mod tests {
    use super::*;
    fn synthetic_parent(id:&str)->Bundle{let mut value=sample();value.id=format!("bundle-{id}");value.source_url=Some(format!("https://www.humblebundle.com/home/library/{id}"));value}
    fn recovery_target()->LibrarySnapshot{LibrarySnapshot{bundles:vec![synthetic_parent("current")],account_key:Some("a".repeat(64)),source_projection:Some(SourceProjection::BundlesV1),enumeration_complete:Some(true),..LibrarySnapshot::default()}}
    fn legacy_file(path:&Path,bundles:&[Bundle]){write_new(path,&protect(&serde_json::to_vec(bundles).unwrap(),false).unwrap()).unwrap();}
    fn sample()->Bundle{serde_json::from_value(serde_json::json!({"id":"SYNTHETIC","title":"Synthetic bundle","items":[{"id":"SYNTHETIC_KEY","title":"Synthetic key","platform":"Unknown platform","key":"TEST-ONLY-CODE","status":"revealed"}]})).unwrap()}
    #[test] fn legacy_and_schema_two_preserve_completion_without_exposing_owner_in_errors(){
        let legacy=decode(&serde_json::to_vec(&vec![sample()]).unwrap()).unwrap();assert_eq!(legacy.enumeration_complete,None);assert_eq!(legacy.account_key,None);
        let snapshot=LibrarySnapshot{bundles:vec![sample()],account_key:Some("a".repeat(64)),enumeration_complete:Some(false),last_sync:Some("SYNTHETIC-TIME".into()),..LibrarySnapshot::default()};let loaded=decode(&encode(&snapshot).unwrap()).unwrap();assert_eq!(loaded.account_key,snapshot.account_key);assert_eq!(loaded.enumeration_complete,Some(false));assert_eq!(loaded.last_sync,snapshot.last_sync);
        for value in [serde_json::json!({"schema":4,"bundles":[],"enumerationComplete":true}),serde_json::json!({"schema":2,"bundles":[],"accountKey":"PRIVATE","enumerationComplete":true})]{let failure=decode(&serde_json::to_vec(&value).unwrap()).err().unwrap();assert!(!failure.contains("PRIVATE"));}
    }
    #[test] fn schema_two_preserves_required_nullable_completion_state(){
        for completeness in [None,Some(false),Some(true)]{
            let snapshot=LibrarySnapshot{enumeration_complete:completeness,..LibrarySnapshot::default()};
            let bytes=encode(&snapshot).unwrap();let wire:serde_json::Value=serde_json::from_slice(&bytes).unwrap();
            assert_eq!(wire.get("enumerationComplete"),Some(&serde_json::json!(completeness)));
            assert_eq!(decode(&bytes).unwrap().enumeration_complete,completeness);
        }
        for wire in [serde_json::json!({"schema":2,"bundles":[]}),serde_json::json!({"schema":2,"bundles":[],"enumerationComplete":"false"})]{assert!(decode(&serde_json::to_vec(&wire).unwrap()).is_err());}
        for completeness in [false,true]{let wire=serde_json::json!({"schema":2,"bundles":[],"enumerationComplete":completeness});assert_eq!(decode(&serde_json::to_vec(&wire).unwrap()).unwrap().enumeration_complete,Some(completeness));}
    }
    #[test] fn schema_three_preserves_private_projection_and_validates_retained_license_bounds(){
        let snapshot=LibrarySnapshot{account_key:Some("a".repeat(64)),source_projection:Some(SourceProjection::BundlesV1),retained_licenses:vec![RetainedLicense{id:"SYNTHETIC-ID".into(),key:"TEST-ONLY-RETAINED".into(),parent_id:None}],..LibrarySnapshot::default()};
        let encoded=encode(&snapshot).unwrap();let wire:serde_json::Value=serde_json::from_slice(&encoded).unwrap();assert_eq!(wire["schema"],3);assert_eq!(wire["sourceProjection"],"bundles-v1");let loaded=decode(&encoded).unwrap();assert_eq!(loaded.source_projection,snapshot.source_projection);assert_eq!(loaded.retained_licenses,snapshot.retained_licenses);assert_eq!(loaded.enumeration_complete,None);
        let old=decode(&serde_json::to_vec(&serde_json::json!({"schema":2,"bundles":[],"accountKey":"a".repeat(64),"enumerationComplete":false})).unwrap()).unwrap();assert!(old.source_projection.is_none()&&old.retained_licenses.is_empty());assert_eq!(old.enumeration_complete,Some(false));
        for(field,value)in[("sourceProjection",serde_json::json!("positions-v1")),("sourceProjection",serde_json::Value::Null),("accountKey",serde_json::Value::Null),("retainedLicenses",serde_json::Value::Null),("retainedLicenses",serde_json::json!([{"id":"SYNTHETIC-ID","key":"TEST-ONLY-RETAINED","url":"PRIVATE"}]))]{let mut bad=wire.clone();bad[field]=value;let error=decode(&serde_json::to_vec(&bad).unwrap()).err().unwrap();assert!(!error.contains("PRIVATE")&&!error.contains("TEST-ONLY-RETAINED"));}
        for field in ["sourceProjection","retainedLicenses","enumerationComplete"]{let mut bad=wire.clone();bad.as_object_mut().unwrap().remove(field);assert!(decode(&serde_json::to_vec(&bad).unwrap()).is_err());}
        for license in [RetainedLicense{id:"bad\nID".into(),key:"SYNTHETIC".into(),parent_id:None},RetainedLicense{id:"SYNTHETIC".into(),key:String::new(),parent_id:None},RetainedLicense{id:"SYNTHETIC".into(),key:"x".repeat(262145),parent_id:None}]{assert!(!valid_retained_licenses(&[license]));}
        assert!(!valid_retained_licenses(&vec![RetainedLicense{id:"SYNTHETIC".into(),key:"TEST-ONLY".into(),parent_id:None};100001]));
    }
    #[test] fn retained_parent_provenance_is_optional_for_old_schema3_and_roundtrips_exact_code_bytes(){
        let old=serde_json::json!({"schema":3,"bundles":[],"accountKey":"a".repeat(64),"enumerationComplete":true,"sourceProjection":"bundles-v1","retainedLicenses":[{"id":"SYNTHETIC-ID","key":"  TEST-ONLY-Ü  "}]});
        let mut snapshot=decode(&serde_json::to_vec(&old).unwrap()).unwrap();assert_eq!(snapshot.retained_licenses[0].parent_id,None);assert_eq!(snapshot.retained_licenses[0].key,"  TEST-ONLY-Ü  ");
        let unknown=decode(&encode(&snapshot).unwrap()).unwrap();assert_eq!(unknown.retained_licenses,snapshot.retained_licenses);
        snapshot.retained_licenses[0].parent_id=Some("bundle-SYNTHETIC_PARENT".into());
        let encoded=encode(&snapshot).unwrap();let wire:serde_json::Value=serde_json::from_slice(&encoded).unwrap();assert_eq!(wire["retainedLicenses"][0]["parentId"],"bundle-SYNTHETIC_PARENT");assert_eq!(decode(&encoded).unwrap().retained_licenses,snapshot.retained_licenses);
        let longest=format!("bundle-{}","x".repeat(256));assert!(valid_retained_licenses(&[RetainedLicense{id:"SYNTHETIC".into(),key:"TEST-ONLY".into(),parent_id:Some(longest)}]));
        for parent in [String::new(),"content-parent".into(),"bundle-".into(),"bundle-../parent".into(),format!("bundle-{}","x".repeat(257))]{assert!(!valid_retained_licenses(&[RetainedLicense{id:"SYNTHETIC".into(),key:"TEST-ONLY".into(),parent_id:Some(parent)}]));}
    }
    #[test] fn retained_parent_bytes_count_toward_the_existing_private_pool_size_limit(){
        let mut licenses=vec![RetainedLicense{id:"x".into(),key:"x".repeat(262143),parent_id:None};128];assert!(valid_retained_licenses(&licenses));
        for license in &mut licenses{license.parent_id=Some("bundle-parent".into());}assert!(!valid_retained_licenses(&licenses));
    }
    #[test] #[cfg(windows)] fn legacy_recovery_keeps_119_missing_codes_accessible_inside_original_76_orders(){
        let folder=std::env::temp_dir().join(format!("hl-recovery-counts-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&folder).unwrap();
        let mut old:Vec<_>=(0..76).map(|index|{let mut value=sample();value.id=format!("legacy_order_{index}");value.title=format!("Original legacy purchase {index}");value.items.clear();value}).collect();
        for index in 0..355{let mut item=sample().items.remove(0);item.id=format!("original_machine_{index}:0:steam");item.key=Some(format!("SYNTHETIC-OLD-{index}"));old[index%76].items.push(item);}
        let mut target=recovery_target();target.bundles=(0..26).map(|index|{let mut value=synthetic_parent(&format!("modern-{index}"));value.items.clear();value}).collect();
        for index in 0..279{let mut item=sample().items.remove(0);item.id=format!("modern_entitlement_{index}");item.key=Some(if index<236{format!("SYNTHETIC-OLD-{index}")}else{format!("SYNTHETIC-NEW-{}",index-236)});target.bundles[index%26].items.push(item);}
        save_at(&folder,&target,None).unwrap();let before=fs::read(folder.join("library.dpapi")).unwrap();let source=folder.join("explicit-legacy.dpapi");legacy_file(&source,&old);let original=fs::read(&source).unwrap();
        assert!(prepare_recovery_inbox_at(&folder,std::slice::from_ref(&source),false).is_err());
        let summary=prepare_recovery_inbox_at(&folder,std::slice::from_ref(&source),true).unwrap();assert_eq!(summary.source_purchases,76);assert_eq!(summary.source_license_rows,355);assert_eq!(fs::read(folder.join("library.dpapi")).unwrap(),before);
        let inbox=fs::read(folder.join("recovery-inbox.dpapi")).unwrap();assert!(!inbox.windows(b"SYNTHETIC-OLD-354".len()).any(|part|part==b"SYNTHETIC-OLD-354"));
        let recovered=consume_recovery_inbox_at(&folder).unwrap();assert_eq!(serde_json::to_value(&recovered.bundles).unwrap(),serde_json::to_value(&target.bundles).unwrap());assert_eq!(recovered.recovered_bundles.len(),76);
        let view=crate::humble::recovered_view(&recovered.recovered_bundles,&recovered.bundles);assert_eq!(view.len(),76);assert_eq!(view.iter().map(|bundle|bundle.items.len()).sum::<usize>(),119);
        let unique:std::collections::HashSet<_>=recovered.bundles.iter().chain(&view).flat_map(|bundle|&bundle.items).filter_map(|item|item.key.as_deref()).collect();assert_eq!(unique.len(),398);assert!(view.iter().all(|bundle|bundle.recovered&&bundle.id.starts_with("recovered-")&&bundle.items.iter().all(|item|item.status=="revealed")));
        assert_eq!(fs::read(&source).unwrap(),original);assert!(!folder.join("recovery-inbox.dpapi").exists());
        let restarted=load_at(&folder).unwrap();assert_eq!(serde_json::to_value(&restarted.recovered_bundles).unwrap(),serde_json::to_value(&recovered.recovered_bundles).unwrap());
        prepare_recovery_inbox_at(&folder,std::slice::from_ref(&source),true).unwrap();let repeated=consume_recovery_inbox_at(&folder).unwrap();assert_eq!(repeated.recovered_bundles.len(),76);
        assert_eq!(fs::read_dir(&folder).unwrap().map(Result::unwrap).filter(|entry|entry.file_name().to_str().is_some_and(owned_archive)).count(),1);
    }
    #[test] #[cfg(windows)] fn recovery_versions_preserve_original_metadata_and_group_one_purchase_with_distinct_code_variants(){
        let folder=std::env::temp_dir().join(format!("hl-recovery-versions-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&folder).unwrap();save_at(&folder,&recovery_target(),None).unwrap();
        let mut first=sample();first.title="Original early title".into();first.items[0].key=Some("  SYNTHETIC-OLD-Ü  ".into());first.items[0].instructions=Some("Original instructions".into());
        let mut latest=first.clone();latest.title="Original latest title".into();latest.purchased_at=Some("2020-01-02".into());latest.items[0].key=Some("SYNTHETIC-NEW-VERSION".into());latest.items[0].platform="Original latest platform".into();
        let paths=[folder.join("first.dpapi"),folder.join("latest.dpapi")];legacy_file(&paths[0],std::slice::from_ref(&first));legacy_file(&paths[1],std::slice::from_ref(&latest));
        prepare_recovery_inbox_at(&folder,&paths,true).unwrap();let result=consume_recovery_inbox_at(&folder).unwrap();assert_eq!(result.recovered_bundles.len(),2);
        assert_eq!(serde_json::to_value(&result.recovered_bundles[0].original_parent).unwrap(),serde_json::to_value(&first).unwrap());assert_eq!(serde_json::to_value(&result.recovered_bundles[1].original_parent).unwrap(),serde_json::to_value(&latest).unwrap());
        let view=crate::humble::recovered_view(&result.recovered_bundles,&result.bundles);assert_eq!(view.len(),1);assert_eq!(view[0].title,latest.title);assert_eq!(view[0].purchased_at,latest.purchased_at);assert_eq!(view[0].items.len(),2);assert_ne!(view[0].items[0].id,view[0].items[1].id);assert_eq!(view[0].items[0].key,first.items[0].key);assert_eq!(view[0].items[0].instructions,first.items[0].instructions);assert_eq!(view[0].items[1].platform,latest.items[0].platform);
    }
    #[test] #[cfg(windows)] fn recovery_inbox_never_crosses_accounts_and_reset_clears_it_and_recovered_sources(){
        let folder=std::env::temp_dir().join(format!("hl-recovery-owner-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&folder).unwrap();let mut target=recovery_target();save_at(&folder,&target,None).unwrap();let source=folder.join("legacy.dpapi");legacy_file(&source,&[sample()]);prepare_recovery_inbox_at(&folder,&[source],true).unwrap();let inbox=fs::read(folder.join("recovery-inbox.dpapi")).unwrap();
        target.account_key=Some("b".repeat(64));save_at(&folder,&target,None).unwrap();let other=consume_recovery_inbox_at(&folder).unwrap();assert!(other.recovered_bundles.is_empty());assert_eq!(fs::read(folder.join("recovery-inbox.dpapi")).unwrap(),inbox);
        clear_at(&folder).unwrap();let empty=load_at(&folder).unwrap();assert!(empty.recovered_bundles.is_empty());assert!(!folder.join("recovery-inbox.dpapi").exists());
    }
    #[test] #[cfg(windows)] fn recovery_rejects_foreign_bound_sources_and_malformed_parent_duplicates_without_changes(){
        let folder=std::env::temp_dir().join(format!("hl-recovery-invalid-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&folder).unwrap();save_at(&folder,&recovery_target(),None).unwrap();let before=fs::read(folder.join("library.dpapi")).unwrap();
        let source=folder.join("foreign.dpapi");let foreign=LibrarySnapshot{bundles:vec![sample()],account_key:Some("b".repeat(64)),..LibrarySnapshot::default()};write_new(&source,&protect(&encode(&foreign).unwrap(),false).unwrap()).unwrap();assert!(prepare_recovery_inbox_at(&folder,&[source],true).is_err());
        let duplicate=folder.join("duplicate.dpapi");legacy_file(&duplicate,&[sample(),sample()]);assert!(prepare_recovery_inbox_at(&folder,&[duplicate],true).is_err());assert_eq!(fs::read(folder.join("library.dpapi")).unwrap(),before);assert!(!folder.join("recovery-inbox.dpapi").exists());
    }
    #[test] #[cfg(windows)] fn grouped_migration_pool_and_archive_survive_encrypted_restart_and_reset(){
        let folder=std::env::temp_dir().join(format!("hl-grouped-migration-{}",uuid::Uuid::new_v4()));let old=LibrarySnapshot{bundles:vec![sample()],account_key:Some("a".repeat(64)),enumeration_complete:Some(true),..LibrarySnapshot::default()};save_at(&folder,&old,None).unwrap();
        let mut parent=sample();parent.id="bundle-parent".into();parent.source_url=Some("https://www.humblebundle.com/home/library/parent".into());let grouped=LibrarySnapshot{bundles:vec![parent],account_key:old.account_key.clone(),enumeration_complete:Some(false),source_projection:Some(SourceProjection::BundlesV1),retained_licenses:vec![RetainedLicense{id:"SYNTHETIC-UNREACHED".into(),key:"TEST-ONLY-UNREACHED".into(),parent_id:None},RetainedLicense{id:"SYNTHETIC-SCOPED".into(),key:"  TEST-ONLY-SCOPED-Ü  ".into(),parent_id:Some("bundle-parent".into())}],..LibrarySnapshot::default()};save_at(&folder,&grouped,Some(&old)).unwrap();
        let encrypted=fs::read(folder.join("library.dpapi")).unwrap();assert!(!encrypted.windows(b"TEST-ONLY-UNREACHED".len()).any(|part|part==b"TEST-ONLY-UNREACHED"));let restarted=load_at(&folder).unwrap();assert_eq!(restarted.bundles[0].id,"bundle-parent");assert_eq!(restarted.source_projection,Some(SourceProjection::BundlesV1));assert_eq!(restarted.retained_licenses,grouped.retained_licenses);assert_eq!(restarted.enumeration_complete,Some(false));
        let archives:Vec<_>=fs::read_dir(&folder).unwrap().map(Result::unwrap).filter(|entry|entry.file_name().to_str().is_some_and(owned_archive)).collect();assert_eq!(archives.len(),1);let archived=decode(&protect(&fs::read(archives[0].path()).unwrap(),true).unwrap()).unwrap();assert_eq!(archived.bundles[0].id,"SYNTHETIC");assert_eq!(archived.bundles[0].items[0].key.as_deref(),Some("TEST-ONLY-CODE"));
        clear_at(&folder).unwrap();let reset=load_at(&folder).unwrap();assert!(reset.bundles.is_empty()&&reset.account_key.is_none()&&reset.source_projection.is_none()&&reset.retained_licenses.is_empty()&&reset.enumeration_complete.is_none());assert!(fs::read_dir(&folder).unwrap().map(Result::unwrap).all(|entry|!entry.file_name().to_str().is_some_and(owned_archive)));
    }
    #[test] #[cfg(windows)] fn reset_roundtrip_keeps_unknown_distinct_from_known_incomplete(){
        let folder=std::env::temp_dir().join(format!("hl-reset-completeness-{}",uuid::Uuid::new_v4()));
        let incomplete=LibrarySnapshot{account_key:Some("a".repeat(64)),enumeration_complete:Some(false),..LibrarySnapshot::default()};
        save_at(&folder,&incomplete,None).unwrap();let before=load_at(&folder).unwrap();assert_eq!(before.enumeration_complete,Some(false));assert_eq!(before.account_key,incomplete.account_key);
        clear_at(&folder).unwrap();let reset=load_at(&folder).unwrap();assert_eq!(reset.enumeration_complete,None);assert!(reset.bundles.is_empty()&&reset.account_key.is_none()&&reset.last_sync.is_none());
        let wire:serde_json::Value=serde_json::from_slice(&protect(&fs::read(folder.join("library.dpapi")).unwrap(),true).unwrap()).unwrap();assert_eq!(wire.get("enumerationComplete"),Some(&serde_json::Value::Null));
    }
    #[test] #[cfg(windows)] fn encrypted_archives_precede_replacement_and_reset_removes_only_owned_files(){
        let folder=std::env::temp_dir().join(format!("hl-schema-two-{}",uuid::Uuid::new_v4()));fs::create_dir_all(folder.join("Exports")).unwrap();fs::write(folder.join("Exports/keep.txt"),b"SYNTHETIC-EXPORT").unwrap();fs::write(folder.join("library-archive-unrelated.dpapi"),b"SYNTHETIC-OTHER").unwrap();
        let old=LibrarySnapshot{bundles:vec![sample()],account_key:Some("a".repeat(64)),enumeration_complete:Some(true),last_sync:Some("OLD".into()),..LibrarySnapshot::default()};save_at(&folder,&old,None).unwrap();
        let new=LibrarySnapshot{bundles:Vec::new(),account_key:Some("b".repeat(64)),enumeration_complete:Some(false),last_sync:None,..LibrarySnapshot::default()};save_at(&folder,&new,Some(&old)).unwrap();
        let archives:Vec<_>=fs::read_dir(&folder).unwrap().map(Result::unwrap).filter(|entry|entry.file_name().to_str().is_some_and(owned_archive)).collect();assert_eq!(archives.len(),1);
        let encrypted=fs::read(archives[0].path()).unwrap();assert!(!encrypted.windows(b"TEST-ONLY-CODE".len()).any(|window|window==b"TEST-ONLY-CODE"));let archived=decode(&protect(&encrypted,true).unwrap()).unwrap();assert_eq!(archived.bundles[0].items[0].key.as_deref(),Some("TEST-ONLY-CODE"));assert_eq!(load_at(&folder).unwrap().account_key,new.account_key);
        let before=fs::read(folder.join("library.dpapi")).unwrap();let bad_archive=LibrarySnapshot{account_key:Some("INVALID".into()),..old};assert!(save_at(&folder,&new,Some(&bad_archive)).is_err());assert_eq!(fs::read(folder.join("library.dpapi")).unwrap(),before);
        clear_at(&folder).unwrap();let empty=load_at(&folder).unwrap();assert!(empty.bundles.is_empty()&&empty.account_key.is_none()&&empty.last_sync.is_none()&&empty.enumeration_complete.is_none());assert!(fs::read_dir(&folder).unwrap().map(Result::unwrap).all(|entry|!entry.file_name().to_str().is_some_and(owned_archive)));assert_eq!(fs::read(folder.join("Exports/keep.txt")).unwrap(),b"SYNTHETIC-EXPORT");assert!(folder.join("library-archive-unrelated.dpapi").exists());
    }
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
