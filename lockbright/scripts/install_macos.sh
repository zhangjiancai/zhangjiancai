#!/bin/bash
# LockBright — macOS 安装脚本（生成并加载 LaunchAgent）
#
# 用法:
#   bash scripts/install_macos.sh
#
# 可覆盖的环境变量（测试/自定义用）:
#   APP_DIR          安装目录（默认 ~/Library/Application Support/LockBright/app）
#   LAUNCH_AGENTS_DIR   LaunchAgent plist 目录（默认 ~/Library/LaunchAgents）
#   LOCKBRIGHT_HOME  数据目录（默认 ~/.lockbright）
#   PYTHON_BIN       指定解释器（默认自动寻找 >= 3.9 且带 cv2 的 python3）
#   DRY_RUN=1        只打印将要写入的 plist / 执行的命令，不落盘、不 launchctl
#   SKIP_PLATFORM_CHECK=1  跳过 macOS 检查与 launchctl（用于非 Mac 上的静态检查）
#
# 重要（相机权限/TCC）:
#   macOS 的摄像头权限按“负责进程”记账。LaunchAgent 里直接跑的 python3
#   没有 app bundle / NSCameraUsageDescription，可能不弹授权框而被静默拒绝。
#   推荐流程：先在本终端前台跑一次 `run.py probe` 完成 Terminal 的相机授权并
#   确认能读到画面，再回来看 LaunchAgent 的日志；若 LaunchAgent 下相机失败，
#   见脚本末尾的替代方案与 docs/MACOS-NOTES.md。
#
# 亮度调整不需要 TCC 授权；但锁屏状态/亮度 API 需要当前用户的图形（Aqua）会话。
set -euo pipefail

LABEL="com.lockbright.agent"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_DIR="${APP_DIR:-$HOME/Library/Application Support/LockBright/app}"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOCKBRIGHT_HOME="${LOCKBRIGHT_HOME:-$HOME/.lockbright}"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
LOG_FILE="$LOCKBRIGHT_HOME/lockbright.log"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
SERVICE="$DOMAIN/$LABEL"
DRY_RUN="${DRY_RUN:-0}"
SKIP_PLATFORM_CHECK="${SKIP_PLATFORM_CHECK:-0}"

say() { printf '%s\n' "$*"; }
warn() { printf '警告: %s\n' "$*" >&2; }
err() { printf '错误: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

xml_escape() {
    # 路径里可能有 & < >（虽然少见），写进 XML plist 前必须转义。
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# ---------------------------------------------------------------- 基本检查
if [ "$SKIP_PLATFORM_CHECK" != "1" ]; then
    [ "$(uname -s)" = "Darwin" ] || die "此脚本只适用于 macOS；只做静态检查请设 SKIP_PLATFORM_CHECK=1"
fi

case "$APP_DIR" in
    ""|"/"|"$HOME"|"$HOME/"|"/Applications"|"/System"|"/Library"|"/Users")
        die "APP_DIR 不安全，拒绝使用: $APP_DIR" ;;
    /*) ;;
    *) die "APP_DIR 必须是绝对路径: $APP_DIR" ;;
esac
case "$LOCKBRIGHT_HOME" in
    ""|"/"|"$HOME"|"$HOME/")
        die "LOCKBRIGHT_HOME 不安全，拒绝使用: $LOCKBRIGHT_HOME" ;;
    /*) ;;
    *) die "LOCKBRIGHT_HOME 必须是绝对路径: $LOCKBRIGHT_HOME" ;;
esac

[ -f "$REPO_ROOT/run.py" ] || die "找不到 $REPO_ROOT/run.py，请在 LockBright 仓库里运行本脚本"
[ -d "$REPO_ROOT/lb" ] || die "找不到 $REPO_ROOT/lb/，请在 LockBright 仓库里运行本脚本"

# ---------------------------------------------------------------- 删除保护
# 下面会 rm -rf "$APP_DIR/lb"，所以 APP_DIR 绝对不能是源码目录或其祖先。
REPO_REAL="$(cd "$REPO_ROOT" && pwd -P)"
case "$REPO_REAL" in
    "$APP_DIR"|"$APP_DIR"/*)
        die "APP_DIR 不能是源码目录或其祖先（会毁掉源码）: APP_DIR=$APP_DIR" ;;
esac
# 默认布局只接受 .../LockBright/app；测试/自定义目录需要显式放行。
case "$APP_DIR" in
    */LockBright/app) ;;
    *)
        if [ "${ALLOW_UNSAFE_APP_DIR:-0}" != "1" ]; then
            die "APP_DIR 必须以 /LockBright/app 结尾（测试/自定义请设 ALLOW_UNSAFE_APP_DIR=1）: $APP_DIR"
        fi
        ;;
esac
case "$LOCKBRIGHT_HOME" in
    "$REPO_REAL"|"$REPO_REAL"/*)
        die "LOCKBRIGHT_HOME 不能是源码目录或其子目录: $LOCKBRIGHT_HOME" ;;
esac

# ---------------------------------------------------------------- Python
find_python() {
    local candidate
    local IFS='
'
    for candidate in \
        ${PYTHON_BIN:-} \
        /opt/homebrew/bin/python3 \
        /usr/local/bin/python3 \
        "$(command -v python3 2>/dev/null || true)" \
        /usr/bin/python3
    do
        [ -n "$candidate" ] || continue
        [ -x "$candidate" ] || continue
        if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

PYTHON="$(find_python || true)"
[ -n "$PYTHON" ] || die "找不到 Python 3.9+。请先安装（推荐: brew install python@3.12），或设置 PYTHON_BIN=/path/to/python3"
say "Python: $PYTHON ($("$PYTHON" -c 'import sys; print(sys.version.split()[0])'))"

if ! "$PYTHON" -c 'import cv2' >/dev/null 2>&1; then
    cat >&2 <<EOF
错误: 这个 Python 没有 OpenCV（import cv2 失败），无法测光。请先安装依赖:
    "$PYTHON" -m pip install -r "$REPO_ROOT/requirements.txt"

如果 pip 报 externally-managed-environment（Homebrew Python 的 PEP 668 限制），
推荐用虚拟环境，再把 PYTHON_BIN 指到虚拟环境里的 python3:
    "$PYTHON" -m venv "$LOCKBRIGHT_HOME/venv"
    "$LOCKBRIGHT_HOME/venv/bin/python3" -m pip install -r "$REPO_ROOT/requirements.txt"
    PYTHON_BIN="$LOCKBRIGHT_HOME/venv/bin/python3" bash "$0"

注意: LaunchAgent 里用的是上面这个解释器的绝对路径；以后升级/移动 Python
（包括重建 venv）会让 macOS 相机授权失效，需要重新授权并重跑本脚本。
EOF
    exit 1
fi
say "OpenCV: $("$PYTHON" -c 'import cv2; print(cv2.__version__)')"

# ---------------------------------------------------------------- 复制文件
say ""
say "应用目录: $APP_DIR"
if [ "$DRY_RUN" = "1" ]; then
    say "[dry-run] 跳过复制文件"
else
    mkdir -p "$APP_DIR"
    # 只清理本工具自己的文件，APP_DIR 是用户可覆盖的，不能整个 rm -rf。
    rm -rf "$APP_DIR/lb"
    rm -f "$APP_DIR/run.py" "$APP_DIR/config.example.json" "$APP_DIR/requirements.txt"
    cp "$REPO_ROOT/run.py" "$APP_DIR/run.py"
    cp -R "$REPO_ROOT/lb" "$APP_DIR/lb"
    find "$APP_DIR/lb" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
    if [ -f "$REPO_ROOT/config.example.json" ]; then
        cp "$REPO_ROOT/config.example.json" "$APP_DIR/config.example.json"
    else
        warn "仓库里没有 config.example.json（运行时会用内置默认值）"
    fi
    if [ -f "$REPO_ROOT/requirements.txt" ]; then
        cp "$REPO_ROOT/requirements.txt" "$APP_DIR/requirements.txt"
    fi
    say "已复制: run.py / lb/ / config.example.json / requirements.txt"
fi

# ---------------------------------------------------------------- 数据目录
if [ "$DRY_RUN" = "1" ]; then
    say "[dry-run] 跳过创建数据目录 $LOCKBRIGHT_HOME"
else
    mkdir -p "$LOCKBRIGHT_HOME"
    if "$PYTHON" "$APP_DIR/run.py" init >/dev/null 2>&1; then
        say "配置: $LOCKBRIGHT_HOME/config.json（已存在则保留原文件）"
    else
        warn "run.py init 失败（可忽略；首次运行会自动生成默认配置）"
    fi
fi

# ---------------------------------------------------------------- plist
render_plist() {
    cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(xml_escape "$PYTHON")</string>
        <string>$(xml_escape "$APP_DIR/run.py")</string>
        <string>run</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(xml_escape "$APP_DIR")</string>
    <key>RunAtLoad</key>
    <true/>
    <!-- 进程退出就重启（守护进程应长期运行；停止请用 launchctl bootout） -->
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <!-- 必须是 Aqua：相机/亮度/窗口服务都需要用户的图形会话 -->
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>PYTHONUNBUFFERED</key>
        <string>1</string>
        <key>LOCKBRIGHT_HOME</key>
        <string>$(xml_escape "$LOCKBRIGHT_HOME")</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$(xml_escape "$LOG_FILE")</string>
    <key>StandardErrorPath</key>
    <string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
PLIST_EOF
}

say ""
if [ "$DRY_RUN" = "1" ]; then
    say "[dry-run] 将写入 $PLIST:"
    render_plist
else
    mkdir -p "$LAUNCH_AGENTS_DIR"
    render_plist > "$PLIST"
    if command -v plutil >/dev/null 2>&1; then
        plutil -lint "$PLIST" >/dev/null || die "生成的 plist 校验失败: $PLIST"
    fi
    say "已写入 LaunchAgent: $PLIST"
fi

# ---------------------------------------------------------------- launchctl
say ""
if [ "$DRY_RUN" = "1" ]; then
    say "[dry-run] 将执行:"
    say "  launchctl bootout $SERVICE   # 忽略失败（旧任务可能不存在）"
    say "  launchctl bootstrap $DOMAIN \"$PLIST\""
    say "  sleep 3 && launchctl print $SERVICE"
elif [ "$SKIP_PLATFORM_CHECK" = "1" ]; then
    say "SKIP_PLATFORM_CHECK=1：跳过 launchctl（未真正加载服务）"
else
    say "重载 LaunchAgent ..."
    launchctl bootout "$SERVICE" >/dev/null 2>&1 || true
    # 很老的 macOS 没有 bootout；再试一次 unload（失败忽略）。
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
        err "launchctl bootstrap 失败。手动重试:"
        err "  launchctl bootout $SERVICE"
        err "  launchctl bootstrap $DOMAIN \"$PLIST\""
        exit 1
    fi
    sleep 3
    print_info="$(launchctl print "$SERVICE" 2>&1 || true)"
    state="$(printf '%s\n' "$print_info" | sed -n 's/^[[:space:]]*state = //p' | head -n 1)"
    pid="$(printf '%s\n' "$print_info" | sed -n 's/^[[:space:]]*pid = //p' | head -n 1)"
    if [ -n "$state" ]; then
        say "服务状态: state=${state} pid=${pid:-?}"
    else
        warn "launchctl print 没有输出状态，请手动检查: launchctl print $SERVICE"
        warn "（常见原因：当前没有图形登录会话，或 plist 权限/路径不对）"
    fi
fi

# ---------------------------------------------------------------- 日志
if [ "$DRY_RUN" != "1" ] && [ -f "$LOG_FILE" ]; then
    say ""
    say "最近日志（$LOG_FILE）:"
    tail -n 15 "$LOG_FILE" | sed 's/^/  /'
fi

# ---------------------------------------------------------------- 后续说明
if [ "$DRY_RUN" = "1" ]; then
    say ""
    say "dry-run 结束（未改动系统）。"
    exit 0
fi

cat <<EOF

============================================================
安装完成，但还有一步：摄像头权限（macOS TCC）
============================================================
亮度调整不需要授权；**摄像头需要**。macOS 10.14+ 的相机权限按“负责进程”
记账，从 LaunchAgent 启动的 python3 与从 Terminal 启动的 python3 不是同一个
“负责进程”，所以推荐按下面顺序做（这是本项目已知的最大风险点）：

1) 先在本 Terminal 前台跑一次探测（会亮一下摄像头指示灯）:
       cd "$APP_DIR"
       "$PYTHON" run.py probe
   - 若弹出 “Terminal 想要访问摄像头” → 点“允许”。
   - 若没有弹框/被拒: 打开 系统设置 > 隐私与安全性 > 摄像头，
     确认 Terminal（或你用的终端 App）已勾选；必要时在终端执行
     tccutil reset Camera com.apple.Terminal 后重跑 probe。
   - 看到 probe 输出里有相机亮度值，说明前台授权成功。

2) 再让 LaunchAgent 重新加载/重启，观察它能不能用相机:
       launchctl kickstart -k $SERVICE
       tail -f "$LOG_FILE"
   （守护进程只在“锁屏 + 夜间 + 需要判断”时才打开相机，所以可能要等到
     晚上锁屏后才会出现相机相关日志。也可以临时把 config.json 的 night_start
     改早、check_interval_seconds 改小来快速验证，验证后改回。）

3) 如果日志/行为显示 LaunchAgent 下相机打不开（大概率是静默拒绝、不弹框）:
   a. 最简单：晚上不用 LaunchAgent，直接在 Terminal 里前台跑
          "$PYTHON" "$APP_DIR/run.py" run
      Terminal 已有相机权限，这条路径最稳（缺点：要留一个终端窗口）。
   b. 把 LockBright 包装成 .app（Info.plist 里加 NSCameraUsageDescription）
      再用“登录项”启动；具体步骤见 docs/MACOS-NOTES.md 第 5 节。
   c. 用 LaunchAgent 打开 Terminal 来运行脚本（相机请求会记到 Terminal 名下）：
      见 docs/MACOS-NOTES.md 5.4 方案 C（未实测，仅作为兜底）。
   注意：在 系统设置 > 摄像头 里手动点 “+” 添加 python 解释器，等于给所有
   python 脚本开放摄像头，不推荐。

常用命令:
  查看状态:   launchctl print $SERVICE
  查看日志:   tail -f "$LOG_FILE"
  配置/状态:  "$PYTHON" "$APP_DIR/run.py" status
  重启服务:   launchctl kickstart -k $SERVICE
  卸载:       bash "$REPO_ROOT/scripts/uninstall_macos.sh"

数据目录（配置/状态/日志）: $LOCKBRIGHT_HOME
日志: $LOG_FILE
EOF
