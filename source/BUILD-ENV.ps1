$ErrorActionPreference = 'Stop'
$env:CARGO_HOME = 'D:\AI\Tools\Rust\cargo'
$env:RUSTUP_HOME = 'D:\AI\Tools\Rust\rustup'
$env:Path = 'D:\AI\Tools\node-v24.21.0-win-x64;' + $env:CARGO_HOME + '\bin;' + $env:Path
$env:npm_config_cache = 'D:\AI\Cache\npm'
$env:TEMP = 'D:\AI\Temp'
$env:TMP = $env:TEMP
$env:CARGO_TARGET_DIR = Join-Path $PSScriptRoot 'src-tauri\target'
