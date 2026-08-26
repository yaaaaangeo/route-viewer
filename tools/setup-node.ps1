$ErrorActionPreference = 'Stop'
$root = 'c:\Users\User\Downloads\route-viewer-main\route-viewer-main'
$tooling = Join-Path $root 'tooling'
New-Item -ItemType Directory -Force -Path $tooling | Out-Null

$idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
$lts = $idx | Where-Object { $_.lts -ne $false } | Select-Object -First 1
$ver = $lts.version
Write-Output "Node LTS: $ver"

$zipName = "node-$ver-win-x64"
$zipPath = Join-Path $tooling "$zipName.zip"
$target  = Join-Path $tooling $zipName

if (-not (Test-Path (Join-Path $target 'node.exe'))) {
  Write-Output "Downloading https://nodejs.org/dist/$ver/$zipName.zip"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/$zipName.zip" -OutFile $zipPath -TimeoutSec 900 -UseBasicParsing
  Write-Output "Extracting..."
  Expand-Archive -Path $zipPath -DestinationPath $tooling -Force
  Remove-Item $zipPath -Force
}

& (Join-Path $target 'node.exe') --version
Write-Output "NODE_HOME=$target"
