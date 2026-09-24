@echo off
setlocal
if "%DORMOUSE_NODE%"=="" goto fallback
if "%DORMOUSE_CLI_JS%"=="" goto fallback
rem DORMOUSE_NODE is the editor's Electron binary; it only behaves as Node when
rem ELECTRON_RUN_AS_NODE is set. Set it here rather than relying on the ambient
rem env to carry it: without it Electron launches its GUI, ignores the script,
rem and exits 0 — so `dor` would silently do nothing.
set "ELECTRON_RUN_AS_NODE=1"
"%DORMOUSE_NODE%" "%DORMOUSE_CLI_JS%" %*
rem Never move this into a ( ) block: cmd expands %ERRORLEVEL% when it parses
rem the block, before node runs, and `dor` would exit with a stale code.
exit /b %ERRORLEVEL%

:fallback
node "%~dp0\..\dist\dor.js" %*
exit /b %ERRORLEVEL%
