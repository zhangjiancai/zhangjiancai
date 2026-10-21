#!/bin/bash
# LockBright — macOS 卸载脚本（可逆）
#
# 默认只停止服务、删除 LaunchAgent 和 app 副本，**保留** ~/.lockbright
# 里的配置/状态/日志；重跑 install_macos.sh 即可恢复。
# 加 --purge 才删除 ~/.lockbright（配置、状态、日志、probe 截图全部丢失）。
#
# 用法:
#   bash scripts/uninstall_macos.sh            # 保留配置
#   bash scripts/uninstall_macos.sh --purge    # 连配置一起删
#
# 可覆盖的环境变量（测试用）: APP_DIR / LAUNCH_AGENTS_DIR / LOCKBRIGHT_HOME
#
# 注意: 本脚本只移除 LockBright 自己创建的东西；不会碰系统设置里的
# Terminal / python 相机授权（TCC），需要的话由用户自行在“系统设置 >
# 隐私与安全性 > 摄像头”里清理。
set -euo pipefail

LABEL="com.lockbright.agent"
APP_DIR="${APP_DIR:-$HOME/Library/Application Support/LockBright/app}"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOCKBRIGHT_HOME="${LOCKBRIGHT_HOME:-$HOME/.lockbright}"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
UID_NUM="$(id -u)"
SERVICE="gui/$UID_NUM/$LABEL"
PURGE=0

usage() {
    cat <<'USAGE'
用法: uninstall_macos.sh [--purge]

  (无参数)   停止并移除 LaunchAgent + app 副本，保留 ~/.lockbright 数据
  --purge    额外删除 ~/.lockbright（配置/状态/日志，不可恢复）
  -h, --help 显示本帮助
USAGE
}

say() { printf '%s\n' "$*"; }
warn() { printf '警告: %s\n' "$*" >&2; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "未知参数: $arg" ;;
    esac
done

# 只允许删除明确的、用户自己的路径；APP_DIR/LOCKBRIGHT_HOME 可被环境变量覆盖，
# 所以这里必须挡掉 "/"、$HOME 等危险值。
case "$APP_DIR" in
    ""|"/"|"$HOME"|"$HOME/"|"/Applications"|"/System"|"/Library"|"/Users")
        die "APP_DIR 不安全，拒绝删除: $APP_DIR" ;;
    /*) ;;
    *) die "APP_DIR 必须是绝对路径: $APP_DIR" ;;
esac
case "$LOCKBRIGHT_HOME" in
    ""|"/"|"$HOME"|"$HOME/")
        die "LOCKBRIGHT_HOME 不安全，拒绝删除: $LOCKBRIGHT_HOME" ;;
    /*) ;;
    *) die "LOCKBRIGHT_HOME 必须是绝对路径: $LOCKBRIGHT_HOME" ;;
esac

# ---------------------------------------------------------------- 删除保护
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
case "$REPO_ROOT" in
    "$APP_DIR"|"$APP_DIR"/*)
        die "APP_DIR 不能是源码目录或其祖先，拒绝删除: $APP_DIR" ;;
esac
case "$REPO_ROOT" in
    "$LOCKBRIGHT_HOME"|"$LOCKBRIGHT_HOME"/*)
        die "LOCKBRIGHT_HOME 不能是源码目录或其祖先，拒绝删除: $LOCKBRIGHT_HOME" ;;
esac
case "$APP_DIR" in
    */LockBright/app) ;;
    *)
        if [ "${ALLOW_UNSAFE_APP_DIR:-0}" != "1" ]; then
            die "APP_DIR 必须以 /LockBright/app 结尾（测试/自定义请设 ALLOW_UNSAFE_APP_DIR=1）: $APP_DIR"
        fi
        ;;
esac
if [ -d "$APP_DIR" ]; then
    if [ ! -f "$APP_DIR/run.py" ] || [ ! -d "$APP_DIR/lb" ]; then
        die "APP_DIR 看起来不是 LockBright 安装目录（缺 run.py/lb），拒绝删除: $APP_DIR"
    fi
fi

say "LockBright 卸载（$LABEL）"
say "  app 目录:   $APP_DIR"
say "  LaunchAgent: $PLIST"
if [ "$PURGE" = "1" ]; then
    say "  用户数据:   $LOCKBRIGHT_HOME（--purge：将删除）"
else
    say "  用户数据:   $LOCKBRIGHT_HOME（保留，--purge 才删除）"
fi
say ""

removed=0

# ---------------------------------------------------------------- 停止服务
if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
    if launchctl print "$SERVICE" >/dev/null 2>&1; then
        say "停止 LaunchAgent ..."
    fi
    launchctl bootout "$SERVICE" >/dev/null 2>&1 || true
    # 很老的 macOS 只有 unload（失败忽略）。
    if [ -f "$PLIST" ]; then
        launchctl unload "$PLIST" >/dev/null 2>&1 || true
    fi
    if launchctl print "$SERVICE" >/dev/null 2>&1; then
        warn "服务似乎仍在运行。可手动检查: launchctl print $SERVICE"
        warn "必要时: launchctl bootout $SERVICE"
    else
        say "服务已停止/未加载"
    fi
else
    say "非 macOS 或没有 launchctl：跳过停止服务（静态检查模式）"
fi

# ---------------------------------------------------------------- 删文件
if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    say "已删除: $PLIST"
    removed=1
fi

if [ -d "$APP_DIR" ]; then
    rm -rf "$APP_DIR"
    say "已删除: $APP_DIR"
    removed=1
    # 如果父目录 ~/Library/Application Support/LockBright 因安装而为空，顺手清掉。
    parent_dir="$(dirname "$APP_DIR")"
    if [ -d "$parent_dir" ] && [ -z "$(ls -A "$parent_dir" 2>/dev/null)" ]; then
        rmdir "$parent_dir" 2>/dev/null || true
        say "已删除空目录: $parent_dir"
    fi
fi

# ---------------------------------------------------------------- 用户数据
if [ "$PURGE" = "1" ]; then
    if [ -d "$LOCKBRIGHT_HOME" ]; then
        data_ok=0
        for marker in config.json state.json lockbright.log; do
            [ -e "$LOCKBRIGHT_HOME/$marker" ] && data_ok=1
        done
        if [ "$data_ok" != "1" ]; then
            warn "LOCKBRIGHT_HOME 看起来不是 LockBright 数据目录，拒绝删除: $LOCKBRIGHT_HOME"
        else
            rm -rf "$LOCKBRIGHT_HOME"
            say "已删除（--purge）: $LOCKBRIGHT_HOME"
            removed=1
        fi
    else
        say "用户数据目录本来就不存在: $LOCKBRIGHT_HOME"
    fi
else
    say "保留用户数据: $LOCKBRIGHT_HOME（配置/状态/日志；彻底删除: 加 --purge）"
fi

say ""
if [ "$removed" = "0" ]; then
    say "没有发现已安装的 LockBright（可能已经卸载过）。"
else
    say "卸载完成。"
fi
say "恢复方法: bash \"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install_macos.sh\""
if [ "$PURGE" != "1" ] && [ -d "$LOCKBRIGHT_HOME" ]; then
    say "（$LOCKBRIGHT_HOME 里的配置被保留，重新安装后会继续使用。）"
fi
