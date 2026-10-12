# Packages extension/ into dist/send-to-jdownloader-<version>.zip ready for AMO signing.
# Uses Windows' built-in bsdtar so zip entries use forward slashes (PowerShell 5.1 Compress-Archive does not, and AMO rejects that).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root 'extension'
$manifest = Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
$out = Join-Path $root "dist\send-to-jdownloader-$($manifest.version).zip"
New-Item -ItemType Directory -Force (Join-Path $root 'dist') | Out-Null
if (Test-Path $out) { Remove-Item $out -Force }
$files = Get-ChildItem $src -Recurse -File | ForEach-Object { $_.FullName.Substring($src.Length + 1) -replace '\\', '/' }
& "$env:SystemRoot\System32\tar.exe" -a -cf $out -C $src @files
Write-Host "Built $out"
& "$env:SystemRoot\System32\tar.exe" -tf $out
