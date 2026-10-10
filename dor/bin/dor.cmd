@echo off
setlocal
if "%DORMOUSE_NODE%"=="" goto fallback
if "%DORMOUSE_CLI_JS%"=="" goto fallback
rem Under VS Code, DORMOUSE_NODE is the editor's Electron binary; it only
rem behaves as Node when ELECTRON_RUN_AS_NODE is set, which plain Node
rem ignores. Set it here rather than relying on the ambient env to carry it:
rem without it Electron launches its GUI, ignores the script, and exits 0 —
rem so `dor` would silently do nothing.
set "ELECTRON_RUN_AS_NODE=1"
"%DORMOUSE_NODE%" "%DORMOUSE_CLI_JS%" %*
rem Never move this into a ( ) block: cmd expands %ERRORLEVEL% when it parses
rem the block, before node runs, and `dor` would exit with a stale code.
exit /b %ERRORLEVEL%

:fallback
node "%~dp0\..\dist\dor.js" %*
exit /b %ERRORLEVEL%
