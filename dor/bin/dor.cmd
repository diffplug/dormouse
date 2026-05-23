@echo off
setlocal
if not "%DORMOUSE_NODE%"=="" if not "%DORMOUSE_CLI_JS%"=="" (
  "%DORMOUSE_NODE%" "%DORMOUSE_CLI_JS%" %*
  exit /b %ERRORLEVEL%
)

node "%~dp0\..\dist\dor.js" %*
