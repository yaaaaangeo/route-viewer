$ErrorActionPreference = 'Continue'
$root = 'c:\Users\User\Downloads\route-viewer-main\route-viewer-main'
$node = Join-Path $root 'tooling\node-v24.19.0-win-x64'
$env:Path = "$node;" + $env:Path
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
Set-Location $root

& "$node\node.exe" "$root\node_modules\electron-builder\cli.js" --win nsis portable
Write-Output "=== build exit: $LASTEXITCODE ==="
Get-ChildItem "$root\release" -File -ErrorAction SilentlyContinue |
  Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}} | Format-Table -AutoSize
