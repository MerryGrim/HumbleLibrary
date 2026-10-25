. "$PSScriptRoot\BUILD-ENV.ps1"
Set-Location $PSScriptRoot
& npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
& npm.cmd run tauri -- build --no-bundle -- --locked
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
