# 构建并运行到设备/模拟器
#
#     .\run-app.ps1 -Run      启动模拟器 -> 编译 -> 安装 -> 启动应用
#     .\run-app.ps1 -Build    只启动模拟器并编译
#     .\run-app.ps1 -Stop     停止模拟器
#
# 与 build-apk.bat 的区别：那个只产出 APK，这个会真的装到设备/模拟器上跑起来。

param(
    [switch]$Build,
    [switch]$Run,
    [switch]$Stop
)

$ErrorActionPreference = "Continue"

$ProjectPath = $PSScriptRoot
$AndroidSdk  = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$Adb         = "$AndroidSdk\platform-tools\adb.exe"
$Emulator    = "$AndroidSdk\emulator\emulator.exe"
$ApkPath     = "$ProjectPath\app\build\outputs\apk\debug\app-debug.apk"

function Write-Head($text) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host " $text" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
}

# ---------------------------------------------------------------- JDK
# 直接调 gradlew 会因为 PATH 里没有 java、JAVA_HOME 也没设而立刻失败，
# 报 "ERROR: JAVA_HOME is not set"。这里和 build-apk.bat 一样自己去找。
function Resolve-JavaHome {
    if ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\java.exe")) { return $env:JAVA_HOME }
    $cands = @(
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr",
        "C:\Program Files\Android\Android Studio\jbr",
        "D:\Program Files\Android\Android Studio\jbr",
        "C:\Program Files\Java\jdk-17"
    )
    foreach ($c in $cands) {
        if (Test-Path "$c\bin\java.exe") { return $c }
    }
    return $null
}

# ---------------------------------------------------------------- 模拟器
function Test-EmulatorRunning {
    $out = & $Adb devices 2>&1
    return [bool]($out | Select-String "emulator-\d+\s+device")
}

function Get-FirstAvd {
    $avds = & $Emulator -list-avds 2>&1 | Where-Object { $_ -and $_ -notmatch '^INFO' }
    return ($avds | Select-Object -First 1)
}

function Start-EmulatorIfNeeded {
    if (Test-EmulatorRunning) {
        Write-Host "[OK] 已有模拟器在运行" -ForegroundColor Green
        return $true
    }
    $avd = Get-FirstAvd
    if (-not $avd) {
        Write-Host "[ERROR] 没有可用的 AVD，请先在 Android Studio 的 Device Manager 里创建一个" -ForegroundColor Red
        return $false
    }
    Write-Host "启动模拟器: $avd" -ForegroundColor Yellow
    Start-Process -FilePath $Emulator -ArgumentList @("-avd", $avd, "-no-snapshot-load", "-no-audio") -WindowStyle Hidden

    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 5
        if ((& $Adb shell getprop sys.boot_completed 2>&1) -match '1') {
            Write-Host "[OK] 模拟器已就绪（约 $($i * 5) 秒）" -ForegroundColor Green
            return $true
        }
        Write-Host "." -NoNewline -ForegroundColor Gray
    }
    Write-Host ""
    Write-Host "[ERROR] 模拟器启动超时" -ForegroundColor Red
    return $false
}

# ---------------------------------------------------------------- 编译
function Invoke-Build {
    Write-Head "步骤 1/2  编译"

    $javaHome = Resolve-JavaHome
    if (-not $javaHome) {
        Write-Host "[ERROR] 找不到 JDK。装 Android Studio（自带 JBR 就够），或手动设置 JAVA_HOME：" -ForegroundColor Red
        Write-Host '  set "JAVA_HOME=D:\Program Files\Android\Android Studio\jbr"' -ForegroundColor Yellow
        return $false
    }
    $env:JAVA_HOME = $javaHome
    if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = $AndroidSdk }
    Write-Host "[OK] JAVA_HOME = $javaHome" -ForegroundColor Green

    Push-Location $ProjectPath
    try {
        # 原来的写法把 return $true 写在 ForEach-Object 里，那只是退出管道、不会退出函数，
        # 构建失败也会被判成成功。这里改成先收集输出再判断。
        $log = & .\gradlew.bat assembleDebug --console=plain 2>&1
        $ok  = [bool]($log | Select-String -Pattern '^BUILD SUCCESSFUL')
        if (-not $ok) {
            Write-Host "[ERROR] 编译失败：" -ForegroundColor Red
            $log | Select-String -Pattern '^e: |FAILURE|What went wrong' | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
            return $false
        }
    } finally {
        Pop-Location
    }

    if (-not (Test-Path $ApkPath)) {
        Write-Host "[ERROR] 编译成功但没找到 APK：$ApkPath" -ForegroundColor Red
        return $false
    }
    Write-Host "[OK] 编译成功" -ForegroundColor Green
    return $true
}

# ---------------------------------------------------------------- 安装运行
function Install-AndRun {
    Write-Head "步骤 2/2  安装并启动"
    if (-not (Test-Path $ApkPath)) {
        Write-Host "[ERROR] APK 不存在，请先编译" -ForegroundColor Red
        return $false
    }
    $result = & $Adb install -r $ApkPath 2>&1
    if ($result -notmatch "Success") {
        Write-Host "[ERROR] 安装失败: $result" -ForegroundColor Red
        return $false
    }
    Write-Host "[OK] 安装成功" -ForegroundColor Green
    & $Adb shell am start -n com.appanalyzer/.MainActivity | Out-Null
    Write-Host "[OK] 已启动。首次运行请授予「使用情况访问」权限。" -ForegroundColor Green
    return $true
}

# ---------------------------------------------------------------- 主流程
if ($Stop) {
    if (Test-EmulatorRunning) { & $Adb emu kill | Out-Null; Write-Host "模拟器已停止" -ForegroundColor Green }
    else { Write-Host "没有正在运行的模拟器" -ForegroundColor Gray }
    exit 0
}

if (-not $Build -and -not $Run) {
    Write-Host "用法：" -ForegroundColor Cyan
    Write-Host "  .\run-app.ps1 -Run     启动模拟器、编译、安装并启动应用" -ForegroundColor White
    Write-Host "  .\run-app.ps1 -Build   只启动模拟器并编译" -ForegroundColor White
    Write-Host "  .\run-app.ps1 -Stop    停止模拟器" -ForegroundColor White
    Write-Host ""
    Write-Host "只想要 APK 文件的话，直接双击 build-apk.bat" -ForegroundColor Gray
    exit 0
}

if (-not (Start-EmulatorIfNeeded)) { exit 1 }
if (-not (Invoke-Build)) { exit 1 }
if ($Run) { if (-not (Install-AndRun)) { exit 1 } }
exit 0
