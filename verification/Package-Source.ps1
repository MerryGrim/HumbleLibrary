$ErrorActionPreference='Stop'
$hlRoot=Split-Path $PSScriptRoot -Parent
$hlVersion=(Get-Content -LiteralPath (Join-Path $hlRoot 'source/package.json') -Raw|ConvertFrom-Json).version
Set-Location $hlRoot
$hlRoots=@('source','verification','installer','docs','.github' | Where-Object { Test-Path -LiteralPath $_ -PathType Container })
$hlFiles=@(& rg --files --hidden @hlRoots -g '!source/node_modules/**' -g '!source/src-tauri/target/**' -g '!source/src-tauri/gen/**' -g '!source/dist/**' -g '!verification/current/**' -g '!installer/output/**' -g '!installer/build/**' -g '!installer/work/**')
$hlFiles+=@('README.md','LICENSE','THIRD_PARTY_NOTICES.md','AGENTS.md','.gitignore','.gitattributes','Build-HumbleLibrary.cmd','Start-HumbleLibrary.cmd')
$hlFiles=@($hlFiles|Sort-Object -Unique)
if($hlFiles|Where-Object{$_ -match '(?i)(?:^|[\\/])(?:Data|Account|Exports|\.release-secrets|node_modules|target|current|output|build|work)(?:[\\/]|$)|\.dpapi$'}){throw 'Private or generated path entered source archive'}
$hlArchivePath=Join-Path $hlRoot "Releases/$hlVersion/HumbleLibrary-$hlVersion-Sources.zip"
if(Test-Path -LiteralPath $hlArchivePath){throw 'Source archive already exists'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$hlArchive=[IO.Compression.ZipFile]::Open($hlArchivePath,[IO.Compression.ZipArchiveMode]::Create)
$hlManifest=@()
try{
  foreach($hlRelative in $hlFiles){
    $hlAbsolute=[IO.Path]::GetFullPath((Join-Path $hlRoot $hlRelative))
    if(-not $hlAbsolute.StartsWith($hlRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Source escaped project'}
    $hlItem=Get-Item -LiteralPath $hlAbsolute
    if($hlItem.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Source archive cannot follow links'}
    $hlName=$hlRelative.Replace('\','/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($hlArchive,$hlAbsolute,$hlName,[IO.Compression.CompressionLevel]::Optimal)
    $hlManifest+=@{name=$hlName;size=$hlItem.Length;sha256=(Get-FileHash -LiteralPath $hlAbsolute -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
}finally{$hlArchive.Dispose()}
$hlReceipt=@{privateKeyIncluded=$false;accountDataIncluded=$false;sourceFiles=$hlManifest;archive=(Split-Path $hlArchivePath -Leaf);sha256=(Get-FileHash -LiteralPath $hlArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText((Join-Path $hlRoot "Releases/$hlVersion/source-receipt.json"),($hlReceipt|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
@{files=$hlManifest.Count;sourceArchive=$hlArchivePath;sha256=$hlReceipt.sha256;accountDataIncluded=$false;privateKeyIncluded=$false}|ConvertTo-Json
