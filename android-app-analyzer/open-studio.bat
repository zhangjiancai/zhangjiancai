@echo off
REM Open this project in Android Studio.
REM The project path is derived from this script's own location (%~dp0),
REM so it keeps working no matter where the project is moved to.
REM (The old version hard-coded C:\Users\zjc20\.qclaw\workspace\... and was broken.)

setlocal
set "PROJECT=%~dp0"

set "STUDIO="
if exist "%LOCALAPPDATA%\Programs\Android Studio\bin\studio64.exe" set "STUDIO=%LOCALAPPDATA%\Programs\Android Studio\bin\studio64.exe"
if not defined STUDIO if exist "C:\Program Files\Android\Android Studio\bin\studio64.exe" set "STUDIO=C:\Program Files\Android\Android Studio\bin\studio64.exe"
if not defined STUDIO if exist "D:\Program Files\Android\Android Studio\bin\studio64.exe" set "STUDIO=D:\Program Files\Android\Android Studio\bin\studio64.exe"

if not defined STUDIO (
    echo [ERROR] Android Studio not found.
    echo   Looked in:
    echo     %%LOCALAPPDATA%%\Programs\Android Studio\bin\studio64.exe
    echo     C:\Program Files\Android\Android Studio\bin\studio64.exe
    echo     D:\Program Files\Android\Android Studio\bin\studio64.exe
    echo.
    pause
    exit /b 1
)

echo Opening Android Studio...
echo   Studio  : %STUDIO%
echo   Project : %PROJECT%
echo.
start "" "%STUDIO%" "%PROJECT%"
exit /b 0
