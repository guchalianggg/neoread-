@echo off
setlocal
set "PROJECT=%~dp0NeoRead-main\NeoRead-main"
set "ELECTRON=%PROJECT%\apps\desktop\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" goto missing
for %%F in ("apps\desktop\dist\entry.cjs" "apps\desktop\bin\neoread-server.exe" "apps\web\dist\index.html" "apps\agent\dist\main.mjs" "apps\processor\dist\main.mjs") do (
  if not exist "%PROJECT%\%%~F" goto missing
)
set "ELECTRON_RUN_AS_NODE="
start "" /D "%PROJECT%\apps\desktop" "%ELECTRON%" "%PROJECT%\apps\desktop" >nul 2>&1
exit /b %errorlevel%
:missing
echo NeoRead development build is missing.
echo Run pnpm build in: %PROJECT%
pause
exit /b 1
