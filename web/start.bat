@echo off
rem SPHEREx Blink - ONE click: starts the local web server and opens the app in the browser.
rem The app has no backend: it only needs a static file server. Python is installed automatically if it is missing.
setlocal enabledelayedexpansion
cd /d "%~dp0"
call :findpy
if defined PY goto :run

echo Python was not found. Installing Python 3.12 for this user (about 1 minute)...
where winget >nul 2>&1
if not errorlevel 1 winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
call :findpy
if defined PY goto :run
echo Could not install Python automatically.
echo Install Python 3.12 from https://www.python.org/downloads/ and double-click this file again.
echo Or simply open the online version: https://spherex-blink.github.io/
pause
exit /b 1

:run
echo.
echo  SPHEREx Blink is running at  http://localhost:8000
echo  Quest / phone / anyone else:      https://spherex-blink.github.io/   (HTTPS, needed for VR)
echo  Keep this window open. Close it to stop.
echo.
start "" http://localhost:8000
%PY% -m http.server 8000
pause
exit /b 0

:findpy
set "PY="
if exist "..\.venv\Scripts\python.exe" set "PY="..\.venv\Scripts\python.exe""
if defined PY exit /b 0
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%D\python.exe" set "PY="%%D\python.exe""
if defined PY exit /b 0
py -3 -c "import sys" >nul 2>&1 && set "PY=py -3"
if defined PY exit /b 0
python -c "import sys" >nul 2>&1 && set "PY=python"
exit /b 0
