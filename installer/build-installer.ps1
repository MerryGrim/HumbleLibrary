[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputPath,
    [string]$OutputPath = '',
    [string]$IsccPath = 'D:/AI/Tools/InnoSetup7/ISCC.exe',
    [string]$VisualStudioPath = '',
    [switch]$QaFixture,
    [string]$QaTargetPath = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Use PowerShell 7 to build the installer.' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$metadata = Get-Content -LiteralPath (Join-Path $projectRoot 'source/package.json') -Raw -Encoding utf8 | ConvertFrom-Json
$version = [string]$metadata.version
if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or @($version.Split('.') | Where-Object { [long]$_ -gt 65535 }).Count) { throw 'The application needs a canonical Windows-compatible stable package version.' }

function Assert-NoLinks([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    if ($cursor.StartsWith('\\')) { throw 'Installer build paths must be local, not UNC paths.' }
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Links/reparse points are not permitted: $cursor" }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function File-Receipt([string]$Path, [string]$Name) {
    $item = Get-Item -LiteralPath $Path -Force
    [ordered]@{name=$Name;bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
}
function Write-NewJson([string]$Path, $Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12) + "`n")
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

$payload = (Resolve-Path -LiteralPath $InputPath).ProviderPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
Assert-NoLinks $payload
if (-not [IO.Directory]::Exists($payload)) { throw 'InputPath must be a frozen application directory.' }
$ownedFiles = @('HumbleLibrary.exe','README.md','LICENSE','THIRD_PARTY_NOTICES.md')
$allowedInputs = $ownedFiles + @('portable.marker','installed.marker')
$extra = @(Get-ChildItem -LiteralPath $payload -Force | Where-Object { $_.Name -cnotin $allowedInputs -or $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
if ($extra.Count) { throw 'Input contains unknown files, directories or reparse points. Use a clean four-file release directory; never a user profile.' }
if ((Test-Path -LiteralPath (Join-Path $payload 'portable.marker')) -and (Test-Path -LiteralPath (Join-Path $payload 'installed.marker'))) { throw 'Input must not mix installed and portable markers.' }
foreach ($name in $ownedFiles) {
    $file = Join-Path $payload $name
    if (-not [IO.File]::Exists($file)) { throw "Required release file is missing: $name" }
    $item = Get-Item -LiteralPath $file
    if ($item.Length -le 0 -or $item.Length -gt 96MB) { throw "Invalid release file size: $name" }
}
$app = Join-Path $payload 'HumbleLibrary.exe'
$exe = [IO.File]::ReadAllBytes($app)
if ($exe.Length -lt 64 -or [BitConverter]::ToUInt16($exe,0) -ne 0x5a4d) { throw 'HumbleLibrary.exe must be a Windows PE executable.' }
$peOffset = [BitConverter]::ToUInt32($exe,0x3c)
if ($peOffset -gt $exe.Length-26 -or [BitConverter]::ToUInt32($exe,[int]$peOffset) -ne 0x4550 -or [BitConverter]::ToUInt16($exe,[int]$peOffset+4) -ne 0x8664) { throw 'The installer requires a Windows x64 application.' }
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($app).ProductVersion -cne $version) { throw "Application ProductVersion must equal package.json version $version." }
$exe = $null

$markerPath = Join-Path $PSScriptRoot 'installed.marker'
$marker = [Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($markerPath)).Trim()
if ($marker -cne '{"schema":1,"application":"HumbleLibrary","scope":"current-user"}') { throw 'installed.marker does not match the native installed-mode contract.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'generate-resources.cjs') --check
if ($LASTEXITCODE -ne 0) { throw 'Installer language/license resources are stale.' }
$languages = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'languages.json') -Raw -Encoding utf8 | ConvertFrom-Json)
if ($languages.Count -ne 9) { throw 'All nine application languages are required.' }
if (-not [IO.File]::Exists($IsccPath)) {
    $located = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if (-not $located) { throw 'Inno Setup 7 was not found. Supply -IsccPath.' }
    $IsccPath = $located.Source
}
$compilerRoot = Split-Path -Parent $IsccPath
foreach ($language in $languages) { if (-not [IO.File]::Exists((Join-Path $compilerRoot $language.messages))) { throw "Compiler language is missing: $($language.messages)" } }

if ($QaFixture) {
    if ([string]::IsNullOrWhiteSpace($QaTargetPath)) { throw '-QaFixture requires an explicit isolated -QaTargetPath.' }
    $qaRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'verification/current')) + [IO.Path]::DirectorySeparatorChar
    $QaTargetPath = [IO.Path]::GetFullPath($QaTargetPath)
    Assert-NoLinks $QaTargetPath
    if (-not $QaTargetPath.StartsWith($qaRoot,[StringComparison]::OrdinalIgnoreCase) -or $QaTargetPath.Length -le $qaRoot.Length) { throw 'QA installation target must be inside this project verification/current.' }
} elseif (-not [string]::IsNullOrWhiteSpace($QaTargetPath)) { throw 'QaTargetPath is only accepted with -QaFixture.' }
if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $projectRoot ("Releases/$version") }
$destination = [IO.Path]::GetFullPath($OutputPath)
Assert-NoLinks $destination
if ($destination.Equals($payload,[StringComparison]::OrdinalIgnoreCase) -or $destination.StartsWith($payload+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Installer outputs must be outside the source application directory.' }
$outputName = "HumbleLibrary-$version-Setup" + $(if ($QaFixture) { '-QA' } else { '' }) + '-Windows-x64'
$outputExe = Join-Path $destination ($outputName+'.exe')
foreach ($suffix in @('.exe','.exe.bootstrap.json','.payload.json','.build.json')) { if (Test-Path -LiteralPath (Join-Path $destination ($outputName+$suffix))) { throw "Output already exists: $outputName$suffix" } }
$payloadBefore = @($ownedFiles | ForEach-Object { File-Receipt (Join-Path $payload $_) $_ })
$sourceFiles = @('HumbleLibrary.iss','InstallerLanguages.iss','InstallerLanguages.h','MiraMintButtons.iss','MiraMintDialogs.iss','bootstrap.cpp','bootstrap.manifest','build-bootstrap.ps1','build-installer.ps1','languages.json','generate-resources.cjs','installed.marker','LICENSE','licenses/manifest.json','licenses/MiraMint-MIT.txt','licenses/bootstrap/Microsoft-STL-LICENSE.txt','licenses/bootstrap/NOTICE.md') + @($languages | ForEach-Object { 'licenses/HumbleLibrary-'+$_.code+'.txt' })
$sourcesBefore = @($sourceFiles | ForEach-Object { File-Receipt (Join-Path $PSScriptRoot $_) $_ })
$stage = Join-Path $PSScriptRoot ('work/build-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($stage)
[void][IO.Directory]::CreateDirectory($destination)
$oldTemp = $env:TEMP; $oldTmp = $env:TMP
try {
    $env:TEMP=$stage; $env:TMP=$stage
    $arguments = @('/Qp',"/DInputPath=$payload","/DOutputPath=$stage","/DAppVersion=$version","/DSetupVersion=$version",'/DOutputName=HumbleLibrary.Inner')
    if ($QaFixture) { $arguments += @('/DQaFixture=1',"/DQaTargetPath=$QaTargetPath") }
    $arguments += (Join-Path $PSScriptRoot 'HumbleLibrary.iss')
    & $IsccPath @arguments
    if ($LASTEXITCODE -ne 0) { throw "Inno compilation failed with code $LASTEXITCODE." }
    $inner = Join-Path $stage 'HumbleLibrary.Inner.exe'
    if (-not [IO.File]::Exists($inner)) { throw 'Inno did not create the internal setup executable.' }
    & (Join-Path $PSScriptRoot 'build-bootstrap.ps1') -InnerSetup $inner -OutputExe $outputExe -Version $version -VisualStudioPath $VisualStudioPath -QaFixture:$QaFixture
    if (-not [IO.File]::Exists($outputExe)) { throw 'The native bootstrap was not created.' }
} finally { $env:TEMP=$oldTemp; $env:TMP=$oldTmp }
$payloadAfter = @($ownedFiles | ForEach-Object { File-Receipt (Join-Path $payload $_) $_ })
$sourcesAfter = @($sourceFiles | ForEach-Object { File-Receipt (Join-Path $PSScriptRoot $_) $_ })
if (($payloadBefore | ConvertTo-Json -Compress) -cne ($payloadAfter | ConvertTo-Json -Compress) -or ($sourcesBefore | ConvertTo-Json -Compress) -cne ($sourcesAfter | ConvertTo-Json -Compress)) { throw 'Installer inputs changed during compilation. This candidate is not accepted.' }
$payloadManifest = $payloadBefore + @(File-Receipt $markerPath 'installed.marker')
$payloadManifestPath = Join-Path $destination ($outputName+'.payload.json')
Write-NewJson $payloadManifestPath $payloadManifest
$bootstrap = Get-Content -LiteralPath ($outputExe+'.bootstrap.json') -Raw -Encoding utf8 | ConvertFrom-Json
$receipt = [ordered]@{
    schema=1;version=$version;qaFixture=[bool]$QaFixture;qaTarget=$(if($QaFixture){$QaTargetPath}else{$null});appId=$(if($QaFixture){'{143F965D-8D2E-46BA-A48B-A9150F63C7AC}'}else{'{F016A35B-FA4D-4E51-B2D6-6F8E59E6E804}'});
    installer=$outputExe;installerBytes=(Get-Item -LiteralPath $outputExe).Length;installerSha256=(Get-FileHash -LiteralPath $outputExe -Algorithm SHA256).Hash.ToLowerInvariant();
    payload=$payloadManifest;payloadManifest=$payloadManifestPath;payloadManifestSha256=(Get-FileHash -LiteralPath $payloadManifestPath -Algorithm SHA256).Hash.ToLowerInvariant();
    inputStable=$true;sources=$sourcesBefore;compiler=[IO.Path]::GetFullPath($IsccPath);compilerSha256=(Get-FileHash -LiteralPath $IsccPath -Algorithm SHA256).Hash.ToLowerInvariant();bootstrap=$bootstrap;
    languages=@($languages | ForEach-Object {$_.code});wizardFlow=@('language','welcome','license','directory','optionalDesktopShortcut','ready','install','finish');
    perUser=$true;requiresAdministrator=$false;startsApplication=$false;networkDownloads=$false;userDataIncluded=$false;userDataDeletedOnUninstall=$false;
    defaultDestination='%LOCALAPPDATA%/Programs/HumbleLibrary';dataPreserved='%LOCALAPPDATA%/HumbleLibrary/Data';nativeCaptionRemoved=$true;nativeDwmCornersRequested=$true;
    nativeUiVerified=$false;installExecuted=$false;timestampUtc=[DateTime]::UtcNow.ToString('o');buildWork=$stage
}
Write-NewJson (Join-Path $destination ($outputName+'.build.json')) $receipt
Write-Output $outputExe
