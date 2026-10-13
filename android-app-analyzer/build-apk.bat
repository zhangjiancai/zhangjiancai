@echo off
setlocal
cd /d "%~dp0"

echo ==========================================================
echo   App Analyzer  -  Build APK
echo ==========================================================
echo.

call :find_java
if errorlevel 1 goto fail_java
echo [OK] JAVA_HOME=%JAVA_HOME%
"%JAVA_HOME%\bin\java.exe" -version 2>&1 | findstr /i version
echo.

if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not exist "%ANDROID_HOME%\platforms" goto fail_sdk
echo [OK] ANDROID_HOME=%ANDROID_HOME%
echo.

echo ----------------------------------------------------------
echo  Building... (first run takes longer, later runs use cache)
echo ----------------------------------------------------------
call gradlew.bat assembleDebug :iconpack:assembleDebug --console=plain
if errorlevel 1 goto fail_build

echo.
echo ==========================================================
echo   BUILD SUCCESSFUL
echo ==========================================================
echo.
echo   App APK      : %~dp0app\build\outputs\apk\debug\app-debug.apk
echo   IconPack APK : %~dp0iconpack\build\outputs\apk\debug\iconpack-debug.apk
echo.
echo Install to a phone (USB debugging enabled):
echo   "%ANDROID_HOME%\platform-tools\adb.exe" install -r "%~dp0app\build\outputs\apk\debug\app-debug.apk"
echo.
echo NOTE: the IconPack APK is a placeholder until you export icons from the
echo       app and unzip them into iconpack\src\main\generated\ , then rerun
echo       this script.
echo.
pause
exit /b 0

:find_java
if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" exit /b 0
set "CAND=%LOCALAPPDATA%\Programs\Android Studio\jbr"
if exist "%CAND%\bin\java.exe" (
    set "JAVA_HOME=%CAND%"
    exit /b 0
)
set "CAND=C:\Program Files\Android\Android Studio\jbr"
if exist "%CAND%\bin\java.exe" (
    set "JAVA_HOME=%CAND%"
    exit /b 0
)
set "CAND=D:\Program Files\Android\Android Studio\jbr"
if exist "%CAND%\bin\java.exe" (
    set "JAVA_HOME=%CAND%"
    exit /b 0
)
set "CAND=C:\Program Files\Java\jdk-17"
if exist "%CAND%\bin\java.exe" (
    set "JAVA_HOME=%CAND%"
    exit /b 0
)
exit /b 1

:fail_java
echo [ERROR] No JDK found.
echo   Install Android Studio (its bundled JBR is enough), or set JAVA_HOME:
echo     set "JAVA_HOME=D:\Program Files\Android\Android Studio\jbr"
echo.
pause
exit /b 1

:fail_sdk
echo [ERROR] Android SDK not found at %ANDROID_HOME%
echo   Install Android Studio, or set ANDROID_HOME to your SDK path.
echo.
pause
exit /b 1

:fail_build
echo.
echo [FAILED] Build failed. Copy the error above and send it to me.
echo.
pause
exit /b 1
