$ErrorActionPreference = 'Continue'
# 이 스크립트가 있는 tools 폴더의 상위 = 프로젝트 폴더 (예전엔 다른 PC 경로가 하드코딩돼 있었다)
# 더 간단히: npm.cmd run test:e2e (tests/run-e2e.js — 같은 일을 한다)
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root 'tooling\node-v24.19.0-win-x64'
if (Test-Path $node) { $env:Path = "$node;" + $env:Path }
$env:ROUTE_VIEWER_E2E = Join-Path $root 'tests\e2e-driver.js'
$env:ELECTRON_ENABLE_LOGGING = '1'
# VS Code 안에서 실행하면 이 변수들이 상속돼 electron.exe 가 그냥 node 로 동작한다
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:\ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue
Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
Set-Location $root

# 매번 깨끗한 프로필에서 시작하도록 임시 userData 폴더 사용
$tmp = Join-Path $env:TEMP ("rv-e2e-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

& "$root\node_modules\electron\dist\electron.exe" "$root" --user-data-dir="$tmp"
$code = $LASTEXITCODE
Write-Output "=== e2e exit: $code ==="
Write-Output "userData: $tmp"
