[CmdletBinding()]
param(
    [string]$PrivateKeyPath = (Join-Path (Split-Path $PSScriptRoot -Parent) '.release-secrets/update-key.dpapi'),
    [string]$PublicKeyPath = (Join-Path $PSScriptRoot 'src-tauri/update-public-key.json')
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Use PowerShell 7 for release signing tools.' }
if (Test-Path -LiteralPath $PrivateKeyPath) { throw 'A signing key already exists. Keep it; do not replace a deployed public key.' }
if (Test-Path -LiteralPath $PublicKeyPath) { throw 'Public key already exists. Key rotation requires a separate migration.' }
Add-Type -AssemblyName System.Security.Cryptography
Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
$umParameters = [Security.Cryptography.CngKeyCreationParameters]::new()
$umParameters.ExportPolicy = [Security.Cryptography.CngExportPolicies]::AllowPlaintextExport
$umParameters.KeyUsage = [Security.Cryptography.CngKeyUsages]::Signing
$umKey = [Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::ECDsaP256, [NullString]::Value, $umParameters)
try {
    $umPrivate = $umKey.Export([Security.Cryptography.CngKeyBlobFormat]::EccPrivateBlob)
    $umPublic = $umKey.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
    $umProtected = [Security.Cryptography.ProtectedData]::Protect($umPrivate, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PrivateKeyPath)))
    [IO.File]::WriteAllBytes([IO.Path]::GetFullPath($PrivateKeyPath), $umProtected)
    $umPublicJson = [ordered]@{algorithm='ecdsa-p256-sha256-p1363';key=[Convert]::ToBase64String($umPublic)} | ConvertTo-Json
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($PublicKeyPath), $umPublicJson+"`n", [Text.UTF8Encoding]::new($false))
    Write-Host 'Update signing key created. Only the public key belongs in version control.'
} finally {
    if ($umPrivate) { [Array]::Clear($umPrivate,0,$umPrivate.Length) }
    $umKey.Dispose()
}
