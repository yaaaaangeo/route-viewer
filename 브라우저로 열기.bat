@echo off
setlocal
cd /d "%~dp0"

rem ==========================================================
rem  Route Viewer - browser mode launcher
rem
rem  Why this exists: browser mode needs server.js running. Besides the
rem  page and sync, server.js proxies the background map tiles
rem  (/tiles/z/x/y.png): it fetches them from OSM with an identifying
rem  User-Agent and caches them in tile-cache\, so the browser never
rem  talks to OSM directly. When this PC's Edge fetched OSM tiles itself
rem  it got the "Access blocked" 403 image, while a fresh Edge profile
rem  did not - a difference that cannot be seen or fixed from outside.
rem  If tiles get refused, the server window logs "[tiles] ...".
rem
rem  Server settings (HOST etc.) are deliberately left alone - other
rem  devices may rely on the existing sync behaviour.
rem
rem  This file is ASCII on purpose: cmd.exe parses batch files byte by
rem  byte in the active code page, so non-ASCII text here gets read as
rem  commands and the script breaks.
rem ==========================================================

set "PORT=8080"
rem Must be /src/index.html, not "/". The server does serve src\index.html at
rem "/", but then the browser resolves the page's relative links against "/",
rem so css/style.css becomes /css/style.css and 404s - the page loads with no
rem styling at all. /src/index.html makes those relative links resolve right.
set "URL=http://127.0.0.1:%PORT%/src/index.html"

rem node: prefer PATH, fall back to the portable node in tooling\
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=%~dp0tooling\node-v24.19.0-win-x64\node.exe"
if /i not "%NODE%"=="node" if not exist "%NODE%" (
  echo [ERROR] Node.js not found. Install Node.js, then run this again.
  pause
  exit /b 1
)

rem already running? then just open the browser
netstat -an | findstr /c:":%PORT% " | findstr /i "LISTENING" >nul
if not errorlevel 1 (
  echo Server is already running. Opening %URL%
  start "" "%URL%"
  exit /b 0
)

echo Starting server...
start "Route Viewer server - close this window to stop it" "%NODE%" server.js

rem wait for the port to accept connections, then open the browser
set /a tries=0
:wait
set /a tries+=1
netstat -an | findstr /c:":%PORT% " | findstr /i "LISTENING" >nul
if not errorlevel 1 goto ready
if %tries% geq 20 goto failed
ping -n 2 127.0.0.1 >nul
goto wait

:ready
echo Opening %URL%
start "" "%URL%"
exit /b 0

:failed
echo [ERROR] The server did not start within 20 seconds.
echo Check the "Route Viewer server" window for the reason.
pause
exit /b 1
