param([string]$ReleaseDirectory='', [switch]$VerifyExisting)
$ErrorActionPreference='Stop'
$hlRoot=Split-Path $PSScriptRoot -Parent
$hlVersion=(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw|ConvertFrom-Json).version
if(-not $ReleaseDirectory){$ReleaseDirectory=Join-Path $hlRoot "Releases/$hlVersion"}
$hlPortable=Join-Path $ReleaseDirectory 'HumbleLibrary'
[void][IO.Directory]::CreateDirectory($hlPortable)
$hlExe=Join-Path $PSScriptRoot 'src-tauri/target/release/humble-library.exe'
if([Diagnostics.FileVersionInfo]::GetVersionInfo($hlExe).ProductVersion -ne $hlVersion){throw 'Wrong executable version'}
$hlRunning=@(Get-CimInstance Win32_Process -Filter "name='HumbleLibrary.exe'" | Where-Object{$_.ExecutablePath -eq (Join-Path $hlPortable 'HumbleLibrary.exe')})
if($hlRunning.Count){throw 'Close the running portable app before replacing its executable'}
Copy-Item -LiteralPath $hlExe -Destination (Join-Path $hlPortable 'HumbleLibrary.exe')
foreach($hlName in @('README.md','LICENSE','THIRD_PARTY_NOTICES.md')){Copy-Item -LiteralPath (Join-Path $hlRoot $hlName) -Destination (Join-Path $hlPortable $hlName)}
$hlMarker=Join-Path $hlPortable 'portable.marker'
if(-not(Test-Path -LiteralPath $hlMarker)){[IO.File]::WriteAllText($hlMarker,'Humble Library portable',[Text.UTF8Encoding]::new($false))}
$hlNames=@('HumbleLibrary.exe','README.md','LICENSE','THIRD_PARTY_NOTICES.md','portable.marker')
$hlZip=Join-Path $ReleaseDirectory "HumbleLibrary-$hlVersion-Windows-x64-Portable.zip"
if(Test-Path -LiteralPath $hlZip){if(-not $VerifyExisting){throw 'Portable archive already exists; preserve it and use a fresh release directory or verify its unchanged bytes'}}
else{Compress-Archive -LiteralPath @($hlNames|ForEach-Object{Join-Path $hlPortable $_}) -DestinationPath $hlZip -CompressionLevel Optimal}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$hlArchive=[IO.Compression.ZipFile]::OpenRead($hlZip)
try{
  $hlActualNames=($hlArchive.Entries.FullName|Sort-Object)-join '|'
  $hlExpectedNames=($hlNames|Sort-Object)-join '|'
  if($hlActualNames -cne $hlExpectedNames){throw 'Unexpected portable archive entry'}
  foreach($hlEntry in $hlArchive.Entries){
    $hlStream=$hlEntry.Open()
    try{$hlHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($hlStream))}finally{$hlStream.Dispose()}
    if($hlHash -cne (Get-FileHash -LiteralPath (Join-Path $hlPortable $hlEntry.FullName) -Algorithm SHA256).Hash){throw 'Portable archive byte mismatch'}
  }
}finally{$hlArchive.Dispose()}
$hlReceipt=@{version=$hlVersion;portable=$hlPortable;zip=$hlZip;dataIncluded=$false;files=@($hlNames|ForEach-Object{$hlFile=Get-Item -LiteralPath (Join-Path $hlPortable $_);@{name=$_;size=$hlFile.Length;sha256=(Get-FileHash -LiteralPath $hlFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}});zipSha256=(Get-FileHash -LiteralPath $hlZip -Algorithm SHA256).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText((Join-Path $ReleaseDirectory 'portable-receipt.json'),($hlReceipt|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$hlReceipt|ConvertTo-Json -Depth 5
