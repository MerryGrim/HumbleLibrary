use std::{fs, io::Write, path::{Path,PathBuf}, sync::Mutex};
use serde::{Deserialize,Serialize};
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
}
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
    if snapshot.account_key.as_ref().is_some_and(|key|!valid_account_key(key))||snapshot.last_sync.as_ref().is_some_and(|stamp|stamp.len()>100||stamp.contains('\0'))||!valid_private_metadata(&snapshot.account_key,snapshot.source_projection,&snapshot.retained_licenses){return Err("Не удалось сохранить формат библиотеки".into())}
    serde_json::to_vec(&StoredSnapshot{schema:3,bundles:snapshot.bundles.clone(),account_key:snapshot.account_key.clone(),enumeration_complete:snapshot.enumeration_complete,last_sync:snapshot.last_sync.clone(),source_projection:snapshot.source_projection,retained_licenses:snapshot.retained_licenses.clone()}).map_err(|_|"Не удалось сохранить библиотеку".into())
}
fn decode(bytes:&[u8])->Result<LibrarySnapshot,String> {
    let value:serde_json::Value=serde_json::from_slice(bytes).map_err(|_|"Не удалось прочитать формат локальной библиотеки")?;
    if value.is_array(){return serde_json::from_value(value).map(|bundles|LibrarySnapshot{bundles,..LibrarySnapshot::default()}).map_err(|_|"Не удалось прочитать формат локальной библиотеки".into())}
    let schema=value.get("schema").and_then(serde_json::Value::as_u64);
    if !matches!(schema,Some(2|3))||schema==Some(2)&&(value.get("sourceProjection").is_some()||value.get("retainedLicenses").is_some())||schema==Some(3)&&(value.get("sourceProjection").is_none()||value.get("retainedLicenses").is_none()){return Err("Не удалось прочитать формат локальной библиотеки".into())}
    let stored:StoredSnapshot=serde_json::from_value(value).map_err(|_|"Не удалось прочитать формат локальной библиотеки")?;
    if stored.account_key.as_ref().is_some_and(|key|!valid_account_key(key))||stored.last_sync.as_ref().is_some_and(|stamp|stamp.len()>100||stamp.contains('\0'))||!valid_private_metadata(&stored.account_key,stored.source_projection,&stored.retained_licenses){return Err("Не удалось прочитать формат локальной библиотеки".into())}
    Ok(LibrarySnapshot{bundles:stored.bundles,account_key:stored.account_key,enumeration_complete:stored.enumeration_complete,last_sync:stored.last_sync,source_projection:stored.source_projection,retained_licenses:stored.retained_licenses})
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
    if let Some(previous)=archive.filter(|previous|!previous.bundles.is_empty()||!previous.retained_licenses.is_empty()) {
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
    save_at(folder,&LibrarySnapshot::default(),None)
}
pub fn load_snapshot()->Result<LibrarySnapshot,String>{let _guard=WRITE.lock().map_err(|_|"Хранилище занято")?;load_at(&root())}
pub fn save_snapshot(snapshot:&LibrarySnapshot,archive:Option<&LibrarySnapshot>)->Result<(),String>{let _guard=WRITE.lock().map_err(|_|"Хранилище занято")?;save_at(&root(),snapshot,archive)}
pub fn clear_library_all()->Result<(),String>{let _guard=WRITE.lock().map_err(|_|"Хранилище занято")?;clear_at(&root())}
pub fn save_library(bundles:&[Bundle])->Result<(),String>{save_snapshot(&LibrarySnapshot{bundles:bundles.to_vec(),..LibrarySnapshot::default()},None)}

#[cfg(test)]
mod tests {
    use super::*;
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
