@echo off
rem Launch Route Viewer (latest code) as a desktop app. In a terminal: .\run
rem VS Code terminals set ELECTRON_RUN_AS_NODE, which runs Electron as plain Node - clear it first.
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
