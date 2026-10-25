param([Parameter(Mandatory)][string]$FixtureDirectory)
$ErrorActionPreference='Stop'
$hlCurrent=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'current')).TrimEnd('\')+'\'
$hlFixture=[IO.Path]::GetFullPath($FixtureDirectory)
if(-not $hlFixture.StartsWith($hlCurrent,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture must stay under verification/current'}
$hlInfo=Get-Content -LiteralPath (Join-Path $hlFixture 'fixture.json') -Raw | ConvertFrom-Json
$hlOld=[IO.Path]::GetFullPath($hlInfo.old)
$hlExe=Join-Path $hlOld 'HumbleLibrary.exe'
if(-not $hlExe.StartsWith($hlCurrent,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid fixture executable path'}
$hlProcess=Start-Process -FilePath $hlExe -WindowStyle Hidden -PassThru
$hlStopwatch=[Diagnostics.Stopwatch]::StartNew()
$hlResult=$null
while($hlStopwatch.Elapsed.TotalSeconds -lt 90){
  $hlResults=@(Get-ChildItem -LiteralPath (Join-Path $hlOld 'Data/Updates') -Filter result.json -Recurse -File)
  if($hlResults.Count -gt 0){$hlResult=Get-Content -LiteralPath $hlResults[0].FullName -Raw | ConvertFrom-Json;break}
  Start-Sleep -Milliseconds 500
}
if(-not $hlResult){throw 'Native update fixture did not finish; inspect isolated fixture only'}
if(-not $hlResult.ok){throw ('Native update failed: '+$hlResult.error)}
$hlChecks=@()
foreach($hlFile in @('HumbleLibrary.exe','README.md','LICENSE','THIRD_PARTY_NOTICES.md')){
  $hlActual=(Get-FileHash -LiteralPath (Join-Path $hlOld $hlFile) -Algorithm SHA256).Hash
  $hlExpected=(Get-FileHash -LiteralPath (Join-Path $hlInfo.candidate $hlFile) -Algorithm SHA256).Hash
  if($hlActual -cne $hlExpected){throw "Updated file differs: $hlFile"}
  $hlChecks+=@{name=$hlFile;sha256=$hlActual.ToLowerInvariant();matchesCandidate=$true}
}
$hlSentinel=(Get-FileHash -LiteralPath (Join-Path $hlOld 'Data/SENTINEL.txt') -Algorithm SHA256).Hash
if($hlSentinel -cne $hlInfo.sentinelSha256){throw 'Synthetic user data changed'}
if(Test-Path -LiteralPath (Join-Path $hlOld '.hl-app-update.dpapi')){throw 'Completed transaction journal not finalized'}
$hlProcesses=@(Get-CimInstance Win32_Process -Filter "name='HumbleLibrary.exe'" | Where-Object{$_.ExecutablePath -eq $hlExe})
if($hlProcesses.Count -ne 1){throw 'Expected one running updated fixture application'}
$hlFinal=@{passed=$true;fromVersion='0.1.0';version=[Diagnostics.FileVersionInfo]::GetVersionInfo($hlExe).ProductVersion;scope='Actual production native updater modules and IPC with hidden synthetic frontend, isolated identifier and signed local package; no GitHub network or Humble account';files=$hlChecks;dataSentinelPreserved=$true;healthyRestartConfirmed=$true;journalFinalized=$true;elapsedSeconds=$hlStopwatch.Elapsed.TotalSeconds}
[IO.File]::WriteAllText((Join-Path $hlFixture 'native-transition-report.json'),($hlFinal|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
foreach($hlOwned in $hlProcesses){Stop-Process -Id $hlOwned.ProcessId -Force}
$hlFinal|ConvertTo-Json -Depth 6
