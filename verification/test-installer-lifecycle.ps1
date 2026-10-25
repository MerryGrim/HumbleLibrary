[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReceiptPath,
    [ValidateSet('russian','english','german','italian','spanish','french','chinesesimplified','japanese','korean')][string]$Language = 'english',
    [switch]$RunFixture
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$receipt=Get-Content -LiteralPath $ReceiptPath -Raw -Encoding utf8 | ConvertFrom-Json
$qaId='{143F965D-8D2E-46BA-A48B-A9150F63C7AC}'
if (-not $receipt.qaFixture -or $receipt.appId -cne $qaId) { throw 'Only a separately compiled QA installer may run this test.' }
$target=[IO.Path]::GetFullPath([string]$receipt.qaTarget)
$qaRoot=[IO.Path]::GetFullPath((Join-Path $projectRoot 'verification/current'))+[IO.Path]::DirectorySeparatorChar
if (-not $target.StartsWith($qaRoot,[StringComparison]::OrdinalIgnoreCase) -or $target.Length -le $qaRoot.Length -or $target.Contains('"')) { throw 'The QA target is outside this project verification/current.' }
$installer=[IO.Path]::GetFullPath([string]$receipt.installer)
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ine $receipt.installerSha256 -or -not $installer.EndsWith('-Setup-QA-Windows-x64.exe',[StringComparison]::Ordinal)) { throw 'QA installer identity/hash mismatch.' }
$qaRegistry='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$qaId+'_is1'
$mainRegistry='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{F016A35B-FA4D-4E51-B2D6-6F8E59E6E804}_is1'
function Registration-Snapshot([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    Get-ItemProperty -LiteralPath $Path | Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString | ConvertTo-Json -Compress
}
function Assert-LocalNoLinks([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'QA paths must not traverse links.'}};$next=[IO.Path]::GetDirectoryName($cursor);if(-not $next -or $next -eq $cursor){break};$cursor=$next}
}
Assert-LocalNoLinks $target
if (Test-Path -LiteralPath $target) { throw 'Use a fresh target that does not already exist.' }
if (Test-Path -LiteralPath $qaRegistry) { throw 'A QA registration already exists; preserve it and choose a coordinated clean fixture.' }
$shortcutName='Humble Library Installer QA.lnk'
$shortcuts=@((Join-Path ([Environment]::GetFolderPath('Programs')) $shortcutName),(Join-Path ([Environment]::GetFolderPath('Desktop')) $shortcutName))
foreach($shortcut in $shortcuts){if(Test-Path -LiteralPath $shortcut){throw 'A QA shortcut already exists; it will not be overwritten.'}}
if (-not $RunFixture) { Write-Output 'QA inputs validated. No installation executed. Add -RunFixture only for the coordinated isolated lifecycle run.'; return }
$mainBefore=Registration-Snapshot $mainRegistry
[void][IO.Directory]::CreateDirectory((Join-Path $target 'Data'))
$sentinel=Join-Path $target 'Data/installer-qa-sentinel.bin'
$unknown=Join-Path $target 'user-owned-qa-file.txt'
$neighbor=Join-Path (Split-Path -Parent $target) 'installer-neighbor-sentinel.txt'
if(Test-Path -LiteralPath $neighbor){throw 'Neighbor fixture already exists; preserve it.'}
[IO.File]::WriteAllText($sentinel,'SYNTHETIC-USER-DATA-PRESERVE',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($unknown,'SYNTHETIC-UNKNOWN-FILE-PRESERVE',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($neighbor,'SYNTHETIC-NEIGHBOR-PRESERVE',[Text.UTF8Encoding]::new($false))
$preserved=@($sentinel,$unknown,$neighbor)|ForEach-Object{[pscustomobject]@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash}}
$phases=[Collections.Generic.List[object]]::new()
function Run-Setup([string]$Phase) {
    $arguments='/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LANG='+$Language+' /DIR="'+$target+'"'
    $process=Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    if($process.ExitCode -ne 0){throw "QA setup $Phase failed: $($process.ExitCode)"}
    foreach($entry in $receipt.payload){$file=Join-Path $target $entry.name;if(-not [IO.File]::Exists($file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $entry.sha256){throw "QA $Phase payload mismatch: $($entry.name)"}}
    if(Test-Path -LiteralPath (Join-Path $target 'portable.marker')){throw 'Installed payload must not have portable.marker.'}
    if(-not(Test-Path -LiteralPath $qaRegistry)){throw 'QA registration was not created.'}
    $phases.Add([ordered]@{phase=$Phase;exitCode=$process.ExitCode;payloadVerified=$true})
}
Run-Setup 'install'
[IO.File]::WriteAllText((Join-Path $target 'README.md'),'SYNTHETIC-MANAGED-FILE-CHANGE',[Text.UTF8Encoding]::new($false))
Run-Setup 'reinstall'
$uninstaller=Join-Path $target '.uninstall/unins000.exe'
Assert-LocalNoLinks $uninstaller
if(-not [IO.File]::Exists($uninstaller)){throw 'QA uninstaller was not created.'}
$process=Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -Wait -PassThru -WindowStyle Hidden
if($process.ExitCode -ne 0){throw "QA uninstall failed: $($process.ExitCode)"}
foreach($entry in $receipt.payload){if(Test-Path -LiteralPath (Join-Path $target $entry.name)){throw "Owned file remains after QA uninstall: $($entry.name)"}}
foreach($entry in $preserved){if(-not [IO.File]::Exists($entry.path) -or (Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash -ine $entry.sha256){throw 'Synthetic user data/neighbor file changed.'}}
if(Test-Path -LiteralPath $qaRegistry){throw 'QA registration remains after uninstall.'}
foreach($shortcut in $shortcuts){if(Test-Path -LiteralPath $shortcut){throw 'QA shortcut remains after uninstall.'}}
if((Registration-Snapshot $mainRegistry) -cne $mainBefore){throw 'Production application registration changed during QA.'}
$phases.Add([ordered]@{phase='uninstall';exitCode=$process.ExitCode;ownedFilesRemoved=$true;syntheticDataPreserved=$true})
$result=[ordered]@{schema=1;qaFixture=$true;applicationLaunched=$false;realProfileAccessed=$false;productionRegistrationUnchanged=$true;version=$receipt.version;language=$Language;target=$target;installerSha256=$receipt.installerSha256;phases=$phases.ToArray();preserved=$preserved;at=[DateTime]::UtcNow.ToString('o')}
$report=Join-Path (Split-Path -Parent $target) ('lifecycle-'+$Language+'.json')
if(Test-Path -LiteralPath $report){throw 'Lifecycle report already exists; preserve existing evidence.'}
[IO.File]::WriteAllText($report,($result|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))
Write-Output $report
