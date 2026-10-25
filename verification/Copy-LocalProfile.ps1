param([Parameter(Mandatory)][string]$SourcePortable,[Parameter(Mandatory)][string]$DestinationPortable)
$ErrorActionPreference='Stop'
$hlRoot=[IO.Path]::GetFullPath((Join-Path (Split-Path $PSScriptRoot -Parent) 'Releases')).TrimEnd('\')+'\'
$hlSource=[IO.Path]::GetFullPath($SourcePortable).TrimEnd('\')
$hlTarget=[IO.Path]::GetFullPath($DestinationPortable).TrimEnd('\')
if(-not $hlSource.StartsWith($hlRoot,[StringComparison]::OrdinalIgnoreCase) -or -not $hlTarget.StartsWith($hlRoot,[StringComparison]::OrdinalIgnoreCase) -or $hlSource -eq $hlTarget){throw 'Profiles must be separate local release folders'}
$hlApps=@(Get-CimInstance Win32_Process -Filter "name='HumbleLibrary.exe'" | Where-Object{$_.ExecutablePath -eq (Join-Path $hlSource 'HumbleLibrary.exe') -or $_.ExecutablePath -eq (Join-Path $hlTarget 'HumbleLibrary.exe')})
$hlBrowsers=@(Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe'" | Where-Object{$_.CommandLine -like ('*'+$hlSource+'\Data*') -or $_.CommandLine -like ('*'+$hlTarget+'\Data*')})
if($hlApps.Count -or $hlBrowsers.Count){throw 'Close the local client before copying its profile'}
$hlSourceData=Join-Path $hlSource 'Data'
$hlTargetData=Join-Path $hlTarget 'Data'
if(-not(Test-Path -LiteralPath $hlSourceData)){@{copied=$false;reason='No previous profile'}|ConvertTo-Json;return}
if(Test-Path -LiteralPath $hlTargetData){throw 'Destination profile already exists; it will not be overwritten'}
if(@(Get-ChildItem -LiteralPath $hlSourceData -Recurse -Force -Attributes ReparsePoint).Count){throw 'Profile links cannot be copied'}
$hlStaging=Join-Path $hlTarget ('Data-copy-'+[guid]::NewGuid().ToString('N'))
Copy-Item -LiteralPath $hlSourceData -Destination $hlStaging -Recurse -Force
$hlCount=0;$hlBytes=0L
foreach($hlFile in Get-ChildItem -LiteralPath $hlSourceData -Recurse -Force -File){
  $hlRelative=[IO.Path]::GetRelativePath($hlSourceData,$hlFile.FullName)
  $hlCopy=Join-Path $hlStaging $hlRelative
  if((Get-Item -LiteralPath $hlCopy).Length -ne $hlFile.Length -or (Get-FileHash -LiteralPath $hlCopy -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $hlFile.FullName -Algorithm SHA256).Hash){throw 'Local profile copy does not match; original is preserved'}
  $hlCount++;$hlBytes+=$hlFile.Length
}
# Both resolved absolute rename targets are fixed children of the new release.
if(-not [IO.Path]::GetFullPath($hlStaging).StartsWith($hlTarget+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFullPath($hlTargetData) -ne (Join-Path $hlTarget 'Data')){throw 'Invalid profile rename target'}
[IO.Directory]::Move($hlStaging,$hlTargetData)
@{copied=$true;originalPreserved=$true;allFilesMatch=$true;fileCount=$hlCount;bytes=$hlBytes}|ConvertTo-Json
