# Launches only a previously prepared hidden, isolated installed-mode fixture.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$FixtureDirectory,[ValidateRange(1,50)][int]$WaitSeconds=40,[switch]$Resume,[switch]$Cleanup)
$ErrorActionPreference='Stop'
$hlUtf8=[Text.UTF8Encoding]::new($false)
$hlCurrent=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'current')).TrimEnd('\')+'\'
$hlFixture=[IO.Path]::GetFullPath($FixtureDirectory).TrimEnd('\')
if(-not $hlFixture.StartsWith($hlCurrent,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture must stay under verification/current'}
$hlInfo=Get-Content -LiteralPath (Join-Path $hlFixture 'fixture.json') -Raw|ConvertFrom-Json
function Confirm-OwnedPath([string]$Path) {
  $hlResolved=[IO.Path]::GetFullPath($Path)
  if(-not $hlResolved.StartsWith($hlFixture+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture path escaped isolated root'}
  return $hlResolved
}
$hlOld=Confirm-OwnedPath $hlInfo.old
$hlExe=Confirm-OwnedPath (Join-Path $hlOld 'HumbleLibrary.exe')
$hlData=Confirm-OwnedPath $hlInfo.dataRoot
$hlLocalAppData=Confirm-OwnedPath $hlInfo.localAppData
$hlCandidate=Confirm-OwnedPath $hlInfo.candidate
$hlStatePath=Join-Path $hlFixture 'run-state.json'
$hlReportPath=Join-Path $hlFixture 'installed-native-transition-report.json'
function Get-OwnedProcesses {
  @(Get-CimInstance Win32_Process -Filter "name='HumbleLibrary.exe'"|Where-Object{
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($hlFixture+'\',[StringComparison]::OrdinalIgnoreCase) -and
    ($_.ExecutablePath -eq $hlExe -or $_.ExecutablePath.StartsWith((Join-Path $hlData 'Updates')+'\',[StringComparison]::OrdinalIgnoreCase))
  })
}
function Stop-OwnedProcesses {
  foreach($hlOwned in Get-OwnedProcesses){
    $hlCheck=Get-CimInstance Win32_Process -Filter "ProcessId=$($hlOwned.ProcessId)"
    if($hlCheck -and $hlCheck.ExecutablePath -eq $hlOwned.ExecutablePath -and $hlCheck.CreationDate -eq $hlOwned.CreationDate){Stop-Process -Id $hlCheck.ProcessId -Force -ErrorAction SilentlyContinue}
  }
}
if($Cleanup){Stop-OwnedProcesses;@{fixture=$hlFixture;ownedProcessesStopped=$true}|ConvertTo-Json;return}
if([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Installed updater fixture must run without elevation'}
if(Test-Path -LiteralPath (Join-Path $hlOld 'portable.marker')){throw 'Installed fixture has an unexpected portable marker'}
if(-not(Test-Path -LiteralPath (Join-Path $hlOld 'installed.marker'))){throw 'Installed marker missing'}
if($Resume){
  if(-not(Test-Path -LiteralPath $hlStatePath)){throw 'No existing fixture run to resume'}
}else{
  if(Test-Path -LiteralPath $hlStatePath){throw 'Fixture already started; use -Resume or -Cleanup'}
  if(@(Get-OwnedProcesses).Count){throw 'An owned fixture process is already running'}
  $hlStart=[Diagnostics.ProcessStartInfo]::new($hlExe)
  $hlStart.WorkingDirectory=$hlOld
  $hlStart.UseShellExecute=$false
  $hlStart.CreateNoWindow=$true
  $hlStart.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
  $hlStart.Environment['LOCALAPPDATA']=$hlLocalAppData
  $hlChild=[Diagnostics.Process]::Start($hlStart)
  [IO.File]::WriteAllText($hlStatePath,(@{pid=$hlChild.Id;executable=$hlExe;startedUtc=[DateTime]::UtcNow.ToString('O');childLocalAppData=$hlLocalAppData}|ConvertTo-Json),$hlUtf8)
}
$hlWatch=[Diagnostics.Stopwatch]::StartNew()
$hlResultFile=$null
while($hlWatch.Elapsed.TotalSeconds -lt $WaitSeconds){
  $hlResults=@(Get-ChildItem -LiteralPath (Join-Path $hlData 'Updates') -Filter result.json -Recurse -File)
  if($hlResults.Count){$hlResultFile=$hlResults|Sort-Object LastWriteTimeUtc -Descending|Select-Object -First 1;break}
  Start-Sleep -Milliseconds 250
}
if(-not $hlResultFile){@{status='pending';fixture=$hlFixture;elapsedSeconds=$hlWatch.Elapsed.TotalSeconds;ownedProcesses=@(Get-OwnedProcesses|Select-Object ProcessId,ExecutablePath);next='Run this script with -Resume to wait another bounded interval; -Cleanup stops only owned fixture processes'}|ConvertTo-Json -Depth 5;return}
$hlResult=Get-Content -LiteralPath $hlResultFile.FullName -Raw|ConvertFrom-Json
try{
  if(-not $hlResult.ok){throw ('Installed native update failed: '+$hlResult.error)}
  $hlChecks=@()
  foreach($hlName in @('HumbleLibrary.exe','README.md','LICENSE','THIRD_PARTY_NOTICES.md')){
    $hlActual=(Get-FileHash -LiteralPath (Join-Path $hlOld $hlName) -Algorithm SHA256).Hash.ToLowerInvariant()
    $hlExpected=(Get-FileHash -LiteralPath (Join-Path $hlCandidate $hlName) -Algorithm SHA256).Hash.ToLowerInvariant()
    if($hlActual -cne $hlExpected){throw "Updated installed file differs: $hlName"}
    $hlChecks+=@{name=$hlName;sha256=$hlActual;matchesCandidate=$true}
  }
  foreach($hlControl in $hlInfo.controls){
    $hlPath=Confirm-OwnedPath (Join-Path $hlData $hlControl.name)
    if((Get-FileHash -LiteralPath $hlPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hlControl.sha256){throw 'Synthetic installed user-data control changed'}
  }
  if((Get-FileHash -LiteralPath (Join-Path $hlOld 'installed.marker') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hlInfo.markerSha256){throw 'Installed mode marker changed'}
  if(Test-Path -LiteralPath (Join-Path $hlOld 'portable.marker')){throw 'Update changed the fixture to portable mode'}
  if(Test-Path -LiteralPath (Join-Path $hlOld 'Data')){throw 'Installed mode incorrectly wrote portable Data beside the EXE'}
  if(Test-Path -LiteralPath (Join-Path $hlOld '.hl-app-update.dpapi')){throw 'Completed installed transaction journal remains'}
  $hlHealthyPath=Join-Path $hlResultFile.Directory.FullName 'healthy.json'
  if(-not(Test-Path -LiteralPath $hlHealthyPath)){throw 'Healthy restart receipt missing'}
  $hlHealthy=Get-Content -LiteralPath $hlHealthyPath -Raw|ConvertFrom-Json
  if($hlHealthy.version -ne '0.2.0' -or $hlHealthy.appSha256 -cne $hlChecks[0].sha256){throw 'Healthy restart receipt does not match the installed candidate'}
  $hlApps=@(Get-OwnedProcesses|Where-Object{$_.ExecutablePath -eq $hlExe})
  if($hlApps.Count -ne 1){throw 'Expected exactly one healthy updated fixture app'}
  $hlVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($hlExe).ProductVersion
  if($hlVersion -ne '0.2.0'){throw 'Installed file version did not advance'}
  $hlFinal=@{passed=$true;fromVersion='0.1.9';version=$hlVersion;mode='installed';files=$hlChecks;dataControlsPreserved=@($hlInfo.controls).Count;installedMarkerPreserved=$true;portableMarkerAbsent=$true;portableDataAbsent=$true;healthyRestartConfirmed=$true;journalFinalized=$true;localAppDataScopedToChild=$true;realUserProfileAccessed=$false;elapsedSeconds=$hlWatch.Elapsed.TotalSeconds;scope='Actual production native updater and IPC with hidden synthetic frontend, isolated identifier and child-only LOCALAPPDATA; locally signed fixture package, no GitHub/Humble network or account'}
  [IO.File]::WriteAllText($hlReportPath,($hlFinal|ConvertTo-Json -Depth 7),$hlUtf8)
  $hlFinal|ConvertTo-Json -Depth 7
}catch{
  [IO.File]::WriteAllText($hlReportPath,(@{passed=$false;message=$_.Exception.Message;scope='Isolated installed updater fixture only'}|ConvertTo-Json),$hlUtf8)
  throw
}finally{Stop-OwnedProcesses}
