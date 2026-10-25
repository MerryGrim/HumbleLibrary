# Creates only isolated source/build/signing fixtures. Does not launch a client.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$hlProject=Split-Path $PSScriptRoot -Parent
. (Join-Path $hlProject 'source/BUILD-ENV.ps1')
$hlStamp=[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)
$hlFixture=Join-Path $PSScriptRoot "current/installed-update-$hlStamp"
[void][IO.Directory]::CreateDirectory($hlFixture)
$hlUtf8=[Text.UTF8Encoding]::new($false)
$hlLocalAppData=Join-Path $hlFixture 'LocalAppData'
$hlInstall=Join-Path $hlLocalAppData 'Programs/HumbleLibrary'
$hlData=Join-Path $hlLocalAppData 'HumbleLibrary/Data'
$hlCandidate=Join-Path $hlFixture 'candidate-0.2.0'
$hlCopies=@{'0.1.9'=$hlInstall;'0.2.0'=$hlCandidate}
$hlOwnedFiles=@('HumbleLibrary.exe','README.md','LICENSE','THIRD_PARTY_NOTICES.md')
foreach($hlVersion in @('0.1.9','0.2.0')) {
  $hlTree=Join-Path $hlFixture "source-$hlVersion"
  $hlTauri=Join-Path $hlTree 'src-tauri'
  [void][IO.Directory]::CreateDirectory($hlTauri)
  foreach($hlPart in @('src','icons','capabilities')) {Copy-Item -LiteralPath (Join-Path $hlProject "source/src-tauri/$hlPart") -Destination (Join-Path $hlTauri $hlPart) -Recurse}
  foreach($hlPart in @('Cargo.toml','Cargo.lock','build.rs','tauri.conf.json','update-public-key.json')) {Copy-Item -LiteralPath (Join-Path $hlProject "source/src-tauri/$hlPart") -Destination (Join-Path $hlTauri $hlPart)}
  $hlCargo=Get-Content -LiteralPath (Join-Path $hlTauri 'Cargo.toml') -Raw
  $hlCargo=[regex]::Replace($hlCargo,'(?m)^version = "[^"]+"',"version = `"$hlVersion`"")
  [IO.File]::WriteAllText((Join-Path $hlTauri 'Cargo.toml'),$hlCargo,$hlUtf8)
  $hlLib=Get-Content -LiteralPath (Join-Path $hlTauri 'src/lib.rs') -Raw
  if(-not $hlLib.Contains('.title("Humble Library")')){throw 'Fixture hidden-window patch target changed'}
  $hlLib=$hlLib.Replace('.title("Humble Library")','.title("Humble Library Installed Update Fixture").visible(false)')
  [IO.File]::WriteAllText((Join-Path $hlTauri 'src/lib.rs'),$hlLib,$hlUtf8)
  $hlConfig=Get-Content -LiteralPath (Join-Path $hlTauri 'tauri.conf.json') -Raw|ConvertFrom-Json
  $hlConfig.version=$hlVersion
  $hlConfig.identifier='ru.humblelibrary.installed-updater-fixture'
  $hlConfig.build.beforeBuildCommand=$null
  $hlConfig.build.beforeDevCommand=$null
  $hlConfig.build.PSObject.Properties.Remove('devUrl')
  [IO.File]::WriteAllText((Join-Path $hlTauri 'tauri.conf.json'),($hlConfig|ConvertTo-Json -Depth 12),$hlUtf8)
  [void][IO.Directory]::CreateDirectory((Join-Path $hlTree 'dist'))
  [IO.File]::WriteAllText((Join-Path $hlTree 'dist/index.html'),'<!doctype html><html><head><meta charset="utf-8"><title>Installed updater fixture</title></head><body><p id="result">SYNTHETIC fixture only</p><script src="fixture.js"></script></body></html>',$hlUtf8)
  $hlJs=@'
const invoke=(...args)=>window.__TAURI_INTERNALS__.invoke(...args);
const result=document.getElementById('result');
const apply=async()=>{try{result.textContent='Applying local signed installed fixture';await invoke('updates_set',{enabled:false,repository:'fixture/HumbleLibrary'});await invoke('updates_apply',{version:'0.2.0'});}catch(error){result.textContent=String(error);}};
invoke('updates_ready').then(()=>invoke('updates_get')).then(value=>{result.textContent='Synthetic interface ready '+value.currentVersion;if(value.currentVersion==='0.1.9')setTimeout(apply,750);}).catch(error=>result.textContent=String(error));
'@
  [IO.File]::WriteAllText((Join-Path $hlTree 'dist/fixture.js'),$hlJs,$hlUtf8)
  & cargo generate-lockfile --offline --manifest-path (Join-Path $hlTauri 'Cargo.toml')
  if($LASTEXITCODE -ne 0){throw 'Installed fixture lock failed'}
  & cargo build --release --locked --offline --features tauri/custom-protocol --manifest-path (Join-Path $hlTauri 'Cargo.toml')
  if($LASTEXITCODE -ne 0){throw 'Installed fixture build failed'}
  [void][IO.Directory]::CreateDirectory($hlCopies[$hlVersion])
  Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/humble-library.exe') -Destination (Join-Path $hlCopies[$hlVersion] 'HumbleLibrary.exe')
  foreach($hlDoc in $hlOwnedFiles|Where-Object{$_ -ne 'HumbleLibrary.exe'}) {[IO.File]::WriteAllText((Join-Path $hlCopies[$hlVersion] $hlDoc),"SYNTHETIC installed update fixture $hlVersion $hlDoc",$hlUtf8)}
}
[IO.File]::WriteAllText((Join-Path $hlInstall 'installed.marker'),'{"schema":1,"application":"HumbleLibrary","scope":"current-user"}',$hlUtf8)
if(Test-Path -LiteralPath (Join-Path $hlInstall 'portable.marker')){throw 'Installed fixture must not have a portable marker'}
$hlSigned=Join-Path $hlFixture 'signed'
& (Join-Path $hlProject 'source/PREPARE-UPDATE.ps1') -PortableDirectory $hlCandidate -Version '0.2.0' -Repository 'fixture/HumbleLibrary' -OutputDirectory $hlSigned|Out-Null
$hlId=[guid]::NewGuid().ToString()
$hlUpdates=Join-Path $hlData 'Updates'
$hlStage=Join-Path $hlUpdates $hlId
[void][IO.Directory]::CreateDirectory($hlStage)
Copy-Item -LiteralPath (Join-Path $hlSigned 'update-manifest.json') -Destination (Join-Path $hlStage 'manifest.json')
Copy-Item -LiteralPath (Join-Path $hlSigned 'update-manifest.sig') -Destination (Join-Path $hlStage 'manifest.sig')
Copy-Item -LiteralPath (Join-Path $hlSigned 'HumbleLibrary-0.2.0-Windows-x64.hlupdate') -Destination $hlStage
[IO.File]::WriteAllText((Join-Path $hlUpdates 'staged.json'),(@{version='0.2.0';repository='fixture/HumbleLibrary';directory=$hlId}|ConvertTo-Json -Compress),$hlUtf8)
$hlControls=@()
foreach($hlRelative in @('SENTINEL.txt','settings-control.json','Account/SENTINEL.txt','Interface/SENTINEL.txt')) {
  $hlPath=Join-Path $hlData $hlRelative
  [void][IO.Directory]::CreateDirectory((Split-Path $hlPath -Parent))
  [IO.File]::WriteAllText($hlPath,"SYNTHETIC INSTALLED USER DATA MUST SURVIVE: $hlRelative",$hlUtf8)
  $hlControls+=@{name=$hlRelative;sha256=(Get-FileHash -LiteralPath $hlPath -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$hlSourceHashes=@(Get-ChildItem -LiteralPath (Join-Path $hlProject 'source/src-tauri/src') -File|Sort-Object Name|ForEach-Object{@{name=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
$hlResult=@{root=$hlFixture;old=$hlInstall;candidate=$hlCandidate;signed=$hlSigned;localAppData=$hlLocalAppData;dataRoot=$hlData;controls=$hlControls;markerSha256=(Get-FileHash -LiteralPath (Join-Path $hlInstall 'installed.marker') -Algorithm SHA256).Hash.ToLowerInvariant();sourceHashes=$hlSourceHashes;identifier='ru.humblelibrary.installed-updater-fixture';fromVersion='0.1.9';version='0.2.0';productionTargetOverwritten=$true;scope='Production native updater modules, synthetic frontend and control files, local signature, separate identifier; no account or real user profile. LOCALAPPDATA override is applied only by the child launcher.'}
[IO.File]::WriteAllText((Join-Path $hlFixture 'fixture.json'),($hlResult|ConvertTo-Json -Depth 7),$hlUtf8)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'current/installed-update-active.txt'),$hlFixture,$hlUtf8)
$hlResult|ConvertTo-Json -Depth 7
