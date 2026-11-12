@echo off
setlocal
cd /d "%~dp0"

set "PYEXE="
if exist "O:\program\python\python.exe" set "PYEXE=O:\program\python\python.exe"
if not defined PYEXE (
    where py >nul 2>nul && set "PYEXE=py"
)
if not defined PYEXE (
    where python >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE goto nopython

%PYEXE% "%~dp0LocalHttpsBridge.py" %*
if errorlevel 1 goto fail
goto :eof

:nopython
echo [ERROR] Python not found. Install Python 3.8+ and retry.
pause
exit /b 1

:fail
echo.
echo [ERROR] Program exited with an error. See messages above.
pause
exit /b 1
