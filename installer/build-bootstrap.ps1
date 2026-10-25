param(
    [Parameter(Mandatory = $true)][string]$InnerSetup,
    [Parameter(Mandatory = $true)][string]$OutputExe,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [string]$VisualStudioPath = '',
    [switch]$QaFixture
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$inner = (Resolve-Path -LiteralPath $InnerSetup).Path
$target = [IO.Path]::GetFullPath($OutputExe)
if ([IO.File]::Exists($target)) { throw 'Bootstrap output already exists.' }
if ([string]::IsNullOrWhiteSpace($VisualStudioPath)) {
    $locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not [IO.File]::Exists($locator)) { throw 'Install Visual Studio Build Tools with Desktop C++ and Windows SDK.' }
    $VisualStudioPath = (& $locator -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
}
$vcvars = Join-Path $VisualStudioPath 'VC/Auxiliary/Build/vcvarsall.bat'
if (-not [IO.File]::Exists($vcvars)) { throw 'vcvarsall.bat was not found.' }
$environmentLines = & $env:ComSpec /d /s /c ('""' + $vcvars + '" x64 >nul && set"')
if ($LASTEXITCODE -ne 0) { throw 'C++ toolchain initialization failed.' }
foreach ($line in $environmentLines) {
    $separator = $line.IndexOf('=')
    if ($separator -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0,$separator),$line.Substring($separator+1),'Process') }
}
$compiler = (Get-Command cl.exe -ErrorAction Stop).Source
$linker = (Get-Command link.exe -ErrorAction Stop).Source
$resourceCompiler = (Get-Command rc.exe -ErrorAction Stop).Source
$stage = [IO.Path]::GetDirectoryName($inner)
$icon = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../source/src-tauri/icons/icon.ico'))
$manifest = Join-Path $PSScriptRoot 'bootstrap.manifest'
$resourcePath = Join-Path $stage 'bootstrap.rc'
$resourceObj = Join-Path $stage 'bootstrap.res'
$objectPath = Join-Path $stage 'bootstrap.obj'
$versionNumbers = @($Version.Split('.') | ForEach-Object { [int]$_ })
while ($versionNumbers.Count -lt 4) { $versionNumbers += 0 }
$numeric = $versionNumbers -join ','
function RcPath([string]$Path) { return $Path.Replace('\','\\').Replace('"','\"') }
$resource = @"
#include <windows.h>
1 ICON "$(RcPath $icon)"
1 RT_MANIFEST "$(RcPath $manifest)"
101 RCDATA "$(RcPath $inner)"
1 VERSIONINFO
FILEVERSION $numeric
PRODUCTVERSION $numeric
FILEFLAGSMASK 0x3fL
FILEFLAGS 0
FILEOS 0x40004L
FILETYPE 0x1L
BEGIN
 BLOCK "StringFileInfo"
 BEGIN
  BLOCK "040904b0"
  BEGIN
   VALUE "FileDescription", "Humble Library Setup\0"
   VALUE "FileVersion", "$Version\0"
   VALUE "ProductName", "Humble Library\0"
   VALUE "ProductVersion", "$Version\0"
   VALUE "CompanyName", "Nyanma\0"
  END
 END
 BLOCK "VarFileInfo"
 BEGIN
  VALUE "Translation", 0x409, 1200
 END
END
"@
[IO.File]::WriteAllText($resourcePath,$resource,[Text.UTF8Encoding]::new($true))
& $resourceCompiler /nologo '/c65001' ('/fo'+$resourceObj) $resourcePath
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap resources failed.' }
$compileArguments = @('/nologo','/std:c++17','/O1','/MT','/W4','/WX','/EHsc','/utf-8','/guard:cf','/DUNICODE','/D_UNICODE','/c',('/Fo'+$objectPath))
if ($QaFixture) { $compileArguments += '/DHL_SETUP_QA' }
$compileArguments += (Join-Path $PSScriptRoot 'bootstrap.cpp')
& $compiler @compileArguments
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap C++ compilation failed.' }
& $linker /NOLOGO /SUBSYSTEM:WINDOWS /MACHINE:X64 /DYNAMICBASE /NXCOMPAT /GUARD:CF ('/OUT:'+$target) $objectPath $resourceObj kernel32.lib user32.lib gdi32.lib shell32.lib advapi32.lib comctl32.lib dwmapi.lib ole32.lib
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap linking failed.' }
$receipt = [ordered]@{
    version=$Version
    outerBytes=(Get-Item -LiteralPath $target).Length
    outerSha256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    innerBytes=(Get-Item -LiteralPath $inner).Length
    innerSha256=(Get-FileHash -LiteralPath $inner -Algorithm SHA256).Hash
    sourceSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'bootstrap.cpp') -Algorithm SHA256).Hash
    manifestSha256=(Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash
    compiler=$compiler
    compilerSha256=(Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash
    staticRuntime=$true
    qaFixture=[bool]$QaFixture
    installExecuted=$false
}
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ($target+'.bootstrap.json') -Encoding utf8
Write-Output $target
