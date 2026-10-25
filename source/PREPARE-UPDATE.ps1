[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PortableDirectory,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$PrivateKeyPath = (Join-Path (Split-Path $PSScriptRoot -Parent) '.release-secrets/update-key.dpapi'),
    [string]$PublicKeyPath = (Join-Path $PSScriptRoot 'src-tauri/update-public-key.json')
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Use PowerShell 7 for release signing tools.' }
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Only canonical stable versions are supported.' }
if ($Repository -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}$' -or $Repository.EndsWith('.git') -or $Repository.Split('/')[1] -in @('.', '..')) { throw 'Repository must be owner/repository, not a URL.' }
$hlInput = (Resolve-Path -LiteralPath $PortableDirectory).ProviderPath
$hlOutput = [IO.Path]::GetFullPath($OutputDirectory)
$hlExeVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $hlInput 'HumbleLibrary.exe')).ProductVersion
if ($hlExeVersion -ne $Version) { throw 'Application version does not match the signed release version.' }
$hlFiles = @('HumbleLibrary.exe', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md')
$hlEntries = @()
foreach ($hlName in $hlFiles) {
    $hlPath = Join-Path $hlInput $hlName
    $hlItem = Get-Item -LiteralPath $hlPath
    if ($hlItem.PSIsContainer -or ($hlItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $hlItem.Length -le 0 -or $hlItem.Length -gt 96MB) { throw "Invalid update file: $hlName" }
    $hlEntries += [ordered]@{name=$hlName; data=[Convert]::ToBase64String([IO.File]::ReadAllBytes($hlPath))}
}
$hlBundleBytes = [Text.UTF8Encoding]::new($false).GetBytes((([ordered]@{schema=1;version=$Version;files=$hlEntries}) | ConvertTo-Json -Compress -Depth 6))
if ($hlBundleBytes.Length -gt 160MB) { throw 'Unpacked update JSON exceeds 160 MiB.' }
$hlMemory = [IO.MemoryStream]::new()
try {
    $hlGzip = [IO.Compression.GZipStream]::new($hlMemory, [IO.Compression.CompressionLevel]::Optimal, $true)
    try { $hlGzip.Write($hlBundleBytes, 0, $hlBundleBytes.Length) } finally { $hlGzip.Dispose() }
    $hlPayload = $hlMemory.ToArray()
} finally { $hlMemory.Dispose() }
if ($hlPayload.Length -gt 96MB) { throw 'Compressed update exceeds 96 MiB.' }
$hlPayloadName = "HumbleLibrary-$Version-Windows-x64.hlupdate"
$hlPayloadHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($hlPayload)).ToLowerInvariant()
$hlAppHash = (Get-FileHash -LiteralPath (Join-Path $hlInput 'HumbleLibrary.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
$hlManifest = [ordered]@{
    schema=1; application='HumbleLibrary'; repository=$Repository; version=$Version; channel='stable'; target='windows-x64'; appSha256=$hlAppHash
    portable=[ordered]@{name=$hlPayloadName;url="https://github.com/$Repository/releases/download/v$Version/$hlPayloadName";size=$hlPayload.Length;sha256=$hlPayloadHash}
}
$hlManifestBytes = [Text.UTF8Encoding]::new($false).GetBytes((($hlManifest | ConvertTo-Json -Depth 6) + "`n"))
Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
$hlPrivate = $null
$hlKey = $null
$hlSigner = $null
try {
    $hlPrivate = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($PrivateKeyPath), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $hlKey = [Security.Cryptography.CngKey]::Import($hlPrivate, [Security.Cryptography.CngKeyBlobFormat]::EccPrivateBlob)
    $hlPublic = Get-Content -LiteralPath $PublicKeyPath -Raw | ConvertFrom-Json
    if ($hlPublic.algorithm -ne 'ecdsa-p256-sha256-p1363' -or [Convert]::ToBase64String($hlKey.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)) -cne $hlPublic.key) { throw 'Private key does not match the pinned application public key.' }
    $hlSigner = [Security.Cryptography.ECDsaCng]::new($hlKey)
    $hlSignature = $hlSigner.SignData($hlManifestBytes, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation)
    if ($hlSignature.Length -ne 64 -or -not $hlSigner.VerifyData($hlManifestBytes, $hlSignature, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation)) { throw 'Signing verification failed.' }
} finally {
    if ($hlPrivate) { [Array]::Clear($hlPrivate, 0, $hlPrivate.Length) }
    if ($hlSigner) { $hlSigner.Dispose() }
    if ($hlKey) { $hlKey.Dispose() }
}
[void][IO.Directory]::CreateDirectory($hlOutput)
$hlOutputs = [ordered]@{
    $hlPayloadName=$hlPayload
    'update-manifest.json'=$hlManifestBytes
    'update-manifest.sig'=[Text.UTF8Encoding]::new($false).GetBytes([Convert]::ToBase64String($hlSignature)+"`n")
}
foreach ($hlName in $hlOutputs.Keys) { if (Test-Path -LiteralPath (Join-Path $hlOutput $hlName)) { throw "Output already exists: $hlName" } }
foreach ($hlName in $hlOutputs.Keys) { [IO.File]::WriteAllBytes((Join-Path $hlOutput $hlName), $hlOutputs[$hlName]) }
$hlReceipt = [ordered]@{version=$Version;repository=$Repository;files=@($hlOutputs.Keys | ForEach-Object { $hlFile=Get-Item -LiteralPath (Join-Path $hlOutput $_); [ordered]@{name=$_;size=$hlFile.Length;sha256=(Get-FileHash -LiteralPath $hlFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} })}
[IO.File]::WriteAllText((Join-Path $hlOutput 'update-receipt.json'), ($hlReceipt | ConvertTo-Json -Depth 6)+"`n", [Text.UTF8Encoding]::new($false))
$hlReceipt | ConvertTo-Json -Depth 6
