@echo off
setlocal
if not "%DORMOUSE_NODE%"=="" if not "%DORMOUSE_CLI_JS%"=="" (
  rem DORMOUSE_NODE is the editor's Electron binary; it only behaves as Node when
  rem ELECTRON_RUN_AS_NODE is set. Set it here rather than relying on the ambient
  rem env to carry it: without it Electron launches its GUI, ignores the script,
  rem and exits 0 — so `dor` would silently do nothing.
  set "ELECTRON_RUN_AS_NODE=1"
  "%DORMOUSE_NODE%" "%DORMOUSE_CLI_JS%" %*
  exit /b %ERRORLEVEL%
)

node "%~dp0\..\dist\dor.js" %*
