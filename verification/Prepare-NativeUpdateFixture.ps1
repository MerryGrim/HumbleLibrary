$ErrorActionPreference='Stop'
$hlProject=Split-Path $PSScriptRoot -Parent
. (Join-Path $hlProject 'source/BUILD-ENV.ps1')
$hlStamp=[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)
$hlFixture=Join-Path $PSScriptRoot "current/native-update-$hlStamp"
[void][IO.Directory]::CreateDirectory($hlFixture)
$hlUtf8=[Text.UTF8Encoding]::new($false)
$hlCopies=@{}
foreach($hlVersion in @('0.1.0','0.1.1')) {
  $hlTree=Join-Path $hlFixture "source-$hlVersion"
  $hlTauri=Join-Path $hlTree 'src-tauri'
  [void][IO.Directory]::CreateDirectory($hlTauri)
  foreach($hlPart in @('src','icons','capabilities')) { Copy-Item -LiteralPath (Join-Path $hlProject "source/src-tauri/$hlPart") -Destination (Join-Path $hlTauri $hlPart) -Recurse }
  foreach($hlPart in @('Cargo.toml','Cargo.lock','build.rs','tauri.conf.json','update-public-key.json')) { Copy-Item -LiteralPath (Join-Path $hlProject "source/src-tauri/$hlPart") -Destination (Join-Path $hlTauri $hlPart) }
  $hlCargo=Get-Content -LiteralPath (Join-Path $hlTauri 'Cargo.toml') -Raw
  $hlCargo=[regex]::Replace($hlCargo,'(?m)^version = "[^"]+"',"version = `"$hlVersion`"")
  [IO.File]::WriteAllText((Join-Path $hlTauri 'Cargo.toml'),$hlCargo,$hlUtf8)
  $hlLib=Get-Content -LiteralPath (Join-Path $hlTauri 'src/lib.rs') -Raw
  $hlLib=$hlLib.Replace('.title("Humble Library")','.title("Humble Library Update Fixture").visible(false)')
  [IO.File]::WriteAllText((Join-Path $hlTauri 'src/lib.rs'),$hlLib,$hlUtf8)
  $hlConfig=Get-Content -LiteralPath (Join-Path $hlTauri 'tauri.conf.json') -Raw | ConvertFrom-Json
  $hlConfig.version=$hlVersion
  $hlConfig.identifier='ru.humblelibrary.updater-fixture'
  $hlConfig.build.beforeBuildCommand=$null
  $hlConfig.build.beforeDevCommand=$null
  $hlConfig.build.PSObject.Properties.Remove('devUrl')
  [IO.File]::WriteAllText((Join-Path $hlTauri 'tauri.conf.json'),($hlConfig|ConvertTo-Json -Depth 12),$hlUtf8)
  [void][IO.Directory]::CreateDirectory((Join-Path $hlTree 'dist'))
  [IO.File]::WriteAllText((Join-Path $hlTree 'dist/index.html'),'<!doctype html><html><head><meta charset="utf-8"><title>Updater fixture</title></head><body><h1 id="version">Updater fixture</h1><button id="apply">Apply signed fixture update</button><pre id="result">Loading fixture</pre><script src="fixture.js"></script></body></html>',$hlUtf8)
  $hlJs=@'
const invoke=(...args)=>window.__TAURI_INTERNALS__.invoke(...args);
const result=document.getElementById('result');
const apply=async()=>{try{result.textContent='Applying signed fixture';await invoke('updates_set',{enabled:false,repository:'fixture/HumbleLibrary'});await invoke('updates_apply',{version:'0.1.1'});}catch(error){result.textContent=String(error);}};
invoke('updates_ready').then(()=>invoke('updates_get')).then(value=>{document.getElementById('version').textContent='Native updater fixture '+value.currentVersion;result.textContent='Interface ready';if(value.currentVersion==='0.1.0')setTimeout(apply,750);}).catch(error=>result.textContent=String(error));
document.getElementById('apply').onclick=apply;
'@
  [IO.File]::WriteAllText((Join-Path $hlTree 'dist/fixture.js'),$hlJs,$hlUtf8)
  & cargo generate-lockfile --offline --manifest-path (Join-Path $hlTauri 'Cargo.toml')
  if($LASTEXITCODE -ne 0){throw 'Fixture lock failed'}
  & cargo build --release --locked --offline --features tauri/custom-protocol --manifest-path (Join-Path $hlTauri 'Cargo.toml')
  if($LASTEXITCODE -ne 0){throw 'Fixture build failed'}
  $hlPortable=Join-Path $hlFixture "portable-$hlVersion"
  [void][IO.Directory]::CreateDirectory($hlPortable)
  Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/humble-library.exe') -Destination (Join-Path $hlPortable 'HumbleLibrary.exe')
  foreach($hlDoc in @('README.md','LICENSE','THIRD_PARTY_NOTICES.md')) {[IO.File]::WriteAllText((Join-Path $hlPortable $hlDoc),"SYNTHETIC native update fixture $hlVersion $hlDoc",$hlUtf8)}
  [IO.File]::WriteAllText((Join-Path $hlPortable 'portable.marker'),'SYNTHETIC portable fixture',$hlUtf8)
  $hlCopies[$hlVersion]=$hlPortable
}
$hlSigned=Join-Path $hlFixture 'signed'
& (Join-Path $hlProject 'source/PREPARE-UPDATE.ps1') -PortableDirectory $hlCopies['0.1.1'] -Version '0.1.1' -Repository 'fixture/HumbleLibrary' -OutputDirectory $hlSigned | Out-Null
$hlId=[guid]::NewGuid().ToString()
$hlUpdates=Join-Path $hlCopies['0.1.0'] 'Data/Updates'
$hlStage=Join-Path $hlUpdates $hlId
[void][IO.Directory]::CreateDirectory($hlStage)
Copy-Item -LiteralPath (Join-Path $hlSigned 'update-manifest.json') -Destination (Join-Path $hlStage 'manifest.json')
Copy-Item -LiteralPath (Join-Path $hlSigned 'update-manifest.sig') -Destination (Join-Path $hlStage 'manifest.sig')
Copy-Item -LiteralPath (Join-Path $hlSigned 'HumbleLibrary-0.1.1-Windows-x64.hlupdate') -Destination $hlStage
[IO.File]::WriteAllText((Join-Path $hlUpdates 'staged.json'),(@{version='0.1.1';repository='fixture/HumbleLibrary';directory=$hlId}|ConvertTo-Json -Compress),$hlUtf8)
[IO.File]::WriteAllText((Join-Path $hlCopies['0.1.0'] 'Data/SENTINEL.txt'),'SYNTHETIC DATA MUST SURVIVE EXACTLY',$hlUtf8)
$hlResult=@{root=$hlFixture;old=$hlCopies['0.1.0'];candidate=$hlCopies['0.1.1'];signed=$hlSigned;sentinelSha256=(Get-FileHash -LiteralPath (Join-Path $hlCopies['0.1.0'] 'Data/SENTINEL.txt') -Algorithm SHA256).Hash;scope='Local synthetic fixtures, production updater code, separate app identifier, no Humble account'}
[IO.File]::WriteAllText((Join-Path $hlFixture 'fixture.json'),($hlResult|ConvertTo-Json -Depth 5),$hlUtf8)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'current/native-update-active.txt'),$hlFixture,$hlUtf8)
$hlResult|ConvertTo-Json -Depth 5
