#!/usr/bin/env python3
"""LockBright CLI.

    python run.py run                # foreground daemon (what the auto-start task runs)
    python run.py run --once         # one observation, print what happened
    python run.py probe              # environment + camera index diagnostics
    python run.py status             # config + state + current brightness/lock
    python run.py set-brightness 30  # manual brightness test
    python run.py simulate --locked --luma 3 --at 23:00 --apply
    python run.py init               # write default config, do not run
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import replace
from datetime import datetime, time as dtime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from lb import __version__  # noqa: E402
from lb.camera import (  # noqa: E402
    CameraError,
    camera_name_map,
    open_camera,
    probe_cameras,
)
from lb.config import (  # noqa: E402
    Config,
    ConfigError,
    load_config,
    parse_hhmm,
    save_config,
    write_default_config,
)
from lb.daemon import Daemon, apply_decision  # noqa: E402
from lb.decide import State, in_night_window  # noqa: E402
from lb.paths import (  # noqa: E402
    config_path,
    ensure_home,
    home_dir,
    log_path,
    probe_dir,
    state_path,
)

log = logging.getLogger("lockbright")


# --------------------------------------------------------------------- utils
def _fix_stdio_encoding() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - old/odd streams
            pass


def _stderr_is_log_file(target: Path) -> bool:
    """True when stderr is already redirected to our log file (launchd does this).

    Without this check the LaunchAgent redirects stderr to lockbright.log *and*
    our RotatingFileHandler writes the same lines again, so every line would be
    duplicated and rotation would fight launchd's open file descriptor.
    """
    try:
        stderr_stat = os.fstat(sys.stderr.fileno())
        log_stat = os.stat(target)
    except (OSError, ValueError, AttributeError):
        return False
    return (stderr_stat.st_dev, stderr_stat.st_ino) == (
        log_stat.st_dev,
        log_stat.st_ino,
    )


def setup_logging(
    cfg: Config, *, console: bool = True, file_logging: bool = True
) -> None:
    ensure_home()
    level = getattr(logging, cfg.log_level.upper(), logging.INFO)
    root = logging.getLogger()
    root.setLevel(level)
    for handler in list(root.handlers):
        root.removeHandler(handler)
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )
    log_file: Optional[Path] = None
    if file_logging:
        log_file = log_path()
        try:
            handler: logging.Handler = RotatingFileHandler(
                str(log_file),
                maxBytes=cfg.log_max_bytes,
                backupCount=cfg.log_backup_count,
                encoding="utf-8",
            )
        except OSError:
            handler = logging.StreamHandler(stream=sys.stderr)
        handler.setFormatter(fmt)
        root.addHandler(handler)
    if console and sys.stderr is not None:
        if log_file is not None and _stderr_is_log_file(log_file):
            logging.getLogger(__name__).debug(
                "stderr 已重定向到日志文件，跳过控制台 handler，避免重复日志"
            )
        else:
            console_handler = logging.StreamHandler(stream=sys.stderr)
            console_handler.setFormatter(
                logging.Formatter("%(levelname)s %(name)s: %(message)s")
            )
            root.addHandler(console_handler)


def create_platform():
    import platform as _platform

    system = _platform.system()
    if system == "Windows":
        from lb.platform_windows import WindowsPlatform

        return WindowsPlatform()
    if system == "Darwin":
        from lb.platform_mac import MacPlatform

        return MacPlatform()
    raise SystemExit("暂不支持的系统: %s（LockBright 支持 Windows 与 macOS）" % system)


def load_state_file(path: Optional[Path] = None) -> State:
    target = Path(path) if path is not None else state_path()
    try:
        if target.exists():
            return State.from_dict(json.loads(target.read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc:
        print("状态文件读取失败，按空状态处理: %s" % exc, file=sys.stderr)
    return State()


def save_state_file(state: State, path: Optional[Path] = None) -> None:
    target = Path(path) if path is not None else state_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(
        json.dumps(state.to_dict(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, target)


def _kv(label: str, value: Any) -> None:
    print("  %-18s %s" % (label + ":", value))


def _parse_at(value: Optional[str]) -> Optional[dtime]:
    if not value:
        return None
    minutes = parse_hhmm(value)
    hour, minute = divmod(minutes, 60)
    return dtime(hour, minute)


# ------------------------------------------------------------------ commands
def cmd_init(args: argparse.Namespace) -> int:
    target = Path(args.config) if args.config else config_path()
    if target.exists():
        print("配置已存在: %s" % target)
    else:
        write_default_config(target)
        print("已生成默认配置: %s" % target)
    print("用编辑器按需修改后，安装/重启服务即可生效。")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    cfg, config_file = load_config(args.config)
    setup_logging(cfg, console=True, file_logging=False)
    print("LockBright %s — 状态" % __version__)
    _kv("配置", config_file)
    _kv("数据目录", home_dir())
    _kv("状态文件", state_path())
    _kv("日志", log_path())
    _kv("夜间时段", "%s - 次日 %s" % (cfg.night_start, cfg.morning_time))
    _kv("早上亮度", "%d%%" % cfg.morning_brightness)
    _kv("调暗亮度", "%d%%" % cfg.dim_brightness)
    _kv("黑/亮阈值", "%s / %s" % (cfg.dark_luma_threshold, cfg.restore_luma_threshold))
    _kv("检查间隔", "%d 秒" % cfg.check_interval_seconds)
    _kv("摄像头", "index=%d backend=%s%s" % (
        cfg.camera_index,
        cfg.camera_backend,
        ("  name=%r" % cfg.camera_name) if cfg.camera_name else "",
    ))
    platform = create_platform()
    try:
        _kv("当前亮度", platform.get_brightness())
        _kv("是否锁屏", platform.is_locked())
        _kv("会话是否活动", platform.is_session_active())
        remote = platform.is_remote_session()
        _kv("是否远程会话", remote)
        effective = platform.is_locked()
        if effective is False and cfg.treat_remote_as_locked and remote is True:
            effective = True
        _kv("有效锁屏（远控计入）", effective)
    finally:
        platform.close()
    state = load_state_file()
    print("  运行状态:")
    _kv("  dimmed", state.dimmed)
    _kv("  baseline", state.baseline_brightness)
    _kv("  早上已执行", state.last_morning_date)
    _kv("  连续黑暗次数", state.dark_streak)
    now = datetime.now()
    night = in_night_window(
        now.time().replace(microsecond=0),
        dtime(*divmod(cfg.night_start_minutes(), 60)),
        dtime(*divmod(cfg.morning_minutes(), 60)),
    )
    _kv("  当前在夜间时段", night)
    if platform.last_error:
        _kv("  平台错误", platform.last_error)
    _kv("现在", now.strftime("%Y-%m-%d %H:%M:%S"))
    return 0


def cmd_probe(args: argparse.Namespace) -> int:
    cfg, config_file = load_config(args.config)
    setup_logging(cfg, console=True, file_logging=False)
    print("LockBright %s — 环境探测" % __version__)
    print("  提示：探测会短暂打开摄像头（指示灯会亮一下），所有截图存到 %s" % probe_dir())
    try:
        import cv2  # noqa: PLC0415

        cv2_version = cv2.__version__
    except ImportError:
        cv2_version = "未安装（pip install opencv-python）"
    _kv("Python", sys.version.split()[0])
    _kv("OpenCV", cv2_version)
    _kv("配置", config_file)
    _kv("数据目录", home_dir())
    _kv("日志", log_path())
    platform = create_platform()
    try:
        _kv("平台", getattr(platform, "name", "?"))
        _kv("当前亮度", platform.get_brightness())
        _kv("当前锁屏", platform.is_locked())
        if platform.last_error:
            _kv("平台错误", platform.last_error)
    finally:
        platform.close()
    backend = args.backend or cfg.camera_backend
    max_index = max(0, int(args.camera_max))
    save_dir = None if args.no_save else probe_dir()
    manual = cfg.camera_exposure if cfg.camera_manual_exposure else None
    names = camera_name_map()
    print(
        "\n  摄像头探测（backend=%s，index 0..%d，手动曝光=%s）:"
        % (backend, max_index, manual if manual is not None else "关")
    )
    print("  自动曝光的亮度和真实环境光关系不大；手动曝光值才是判断依据。")
    try:
        results = probe_cameras(
            max_index,
            samples=cfg.camera_samples,
            warmup=cfg.camera_warmup_frames,
            backend=backend,
            manual_exposure=manual,
            save_dir=save_dir,
        )
    except CameraError as exc:
        print("  OpenCV 不可用: %s" % exc)
        return 1
    recommended = None
    for entry in results:
        status = "OK" if entry["opened"] and entry["auto_luma"] is not None else "失败"
        details = "index=%d %-4s" % (entry["index"], status)
        name = names.get(entry["index"])
        if name:
            details += " 名称=%s" % name
        details += " 自动=%-6s 手动=%-6s" % (
            entry["auto_luma"] if entry["auto_luma"] is not None else "-",
            entry["manual_luma"] if entry["manual_luma"] is not None else "-",
        )
        if entry["size"]:
            details += " 分辨率=%dx%d" % (entry["size"][0], entry["size"][1])
        if entry["manual_ok"] is False:
            details += "（不支持手动曝光）"
        details += " 用时=%.1fs" % (entry["seconds"] or 0.0)
        if entry["saved_auto"]:
            details += " 图=%s" % entry["saved_auto"]
        if entry["saved_manual"]:
            details += " 手动图=%s" % entry["saved_manual"]
        if entry["error"]:
            details += " 错误=%s" % entry["error"]
        print("  " + details)
        if recommended is None and status == "OK":
            recommended = entry["index"]
    if names:
        print("  摄像头名称来自 DirectShow 枚举顺序，和 OpenCV index 一一对应。")
    if recommended is None:
        print("\n  没有可用的摄像头。检查：摄像头隐私开关、是否被其他程序占用、Opencv 是否安装。")
        return 1
    else:
        print("\n  建议 camera_index = %d" % recommended)
        if recommended != cfg.camera_index:
            print("  （当前配置是 %d，改成上面的值后重启服务生效）" % cfg.camera_index)
        if manual is not None:
            print(
                "  手动曝光正常时：关灯读数应接近 0，开灯读数应明显高于 dark_luma_threshold=%s。"
                % cfg.dark_luma_threshold
            )
            print("  可在开灯/关灯两种情况下各跑一次 probe，对比“手动”列的读数来微调阈值。")
        if save_dir is not None:
            print("  到 %s 看截图，确认拍到的是房间而不是黑屏/红外画面。" % save_dir)
        print("  想实时看画面并选中某颗摄像头: python run.py cameras / preview --index N")
    return 0


def _save_preview_snapshot(cv2, frame, index: int, explicit: Optional[Path]) -> Optional[str]:
    target = (
        Path(explicit)
        if explicit is not None
        else probe_dir()
        / ("preview-%d-%s.jpg" % (index, datetime.now().strftime("%Y%m%d-%H%M%S")))
    )
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if cv2.imwrite(str(target), frame):
            return str(target)
    except Exception as exc:  # noqa: BLE001 - snapshot is best effort
        print("保存截图失败: %s" % exc, file=sys.stderr)
    return None


def cmd_cameras(args: argparse.Namespace) -> int:
    """List every camera with name / luma / snapshot so the user can choose one."""
    cfg, config_file = load_config(args.config)
    setup_logging(cfg, console=True, file_logging=False)
    print("LockBright %s — 摄像头列表" % __version__)
    _kv("配置", config_file)
    backend = args.backend or cfg.camera_backend
    max_index = max(0, int(args.camera_max))
    manual = cfg.camera_exposure if cfg.camera_manual_exposure else None
    names = camera_name_map()
    print("  名称来源: %s" % ("DirectShow 设备枚举（与 index 对应）" if names else "未知（OpenCV 不提供名称，请看截图/预览）"))
    print("  正在逐个打开摄像头（每颗约 3~6 秒，指示灯会亮一下）...\n")
    try:
        results = probe_cameras(
            max_index,
            samples=cfg.camera_samples,
            warmup=cfg.camera_warmup_frames,
            backend=backend,
            manual_exposure=manual,
            save_dir=None if args.no_save else probe_dir(),
        )
    except CameraError as exc:
        print("OpenCV 不可用: %s" % exc)
        return 1
    print("  %-5s %-32s %-4s %-5s %-5s %-11s %s" % ("index", "名称", "状态", "自动", "手动", "分辨率", "备注"))
    recommended = None
    for entry in results:
        name = names.get(entry["index"], "(未命名/虚拟摄像头)")
        if len(name) > 30:
            name = name[:29] + "…"
        status = "OK" if entry["opened"] and entry["auto_luma"] is not None else "失败"
        size = "%dx%d" % (entry["size"][0], entry["size"][1]) if entry["size"] else "-"
        notes: List[str] = []
        if entry["manual_ok"] is False:
            notes.append("不支持手动曝光")
        if entry["error"]:
            notes.append("错误: %s" % entry["error"])
        if entry["index"] == cfg.camera_index:
            notes.append("← 当前配置")
        if entry["saved_auto"]:
            notes.append("截图 %s" % entry["saved_auto"])
        print(
            "  %-5d %-32s %-4s %-5s %-5s %-11s %s"
            % (
                entry["index"],
                name,
                status,
                entry["auto_luma"] if entry["auto_luma"] is not None else "-",
                entry["manual_luma"] if entry["manual_luma"] is not None else "-",
                size,
                "; ".join(notes),
            )
        )
        if recommended is None and status == "OK":
            recommended = entry["index"]
    if not names:
        print("\n  提示: 这台系统上拿不到摄像头名称，先看截图或跑 preview 确认画面再选 index。")
    if recommended is None:
        print("\n  没有找到能正常出画面的摄像头（详见上面的错误）。")
        return 1
    print("\n  预览/选择: python run.py preview --index %d" % recommended)
    print("  （预览窗口里按 0-9 切换摄像头、Enter 选中，加 --set 会把选择写进配置）")
    return 0


def cmd_preview(args: argparse.Namespace) -> int:
    """Live preview one camera, switch with number keys, optionally save choice."""
    cfg, config_file = load_config(args.config)
    setup_logging(cfg, console=True, file_logging=False)
    try:
        import cv2  # noqa: PLC0415
    except ImportError:
        print("需要 OpenCV: python -m pip install opencv-python", file=sys.stderr)
        return 1
    names = camera_name_map()
    backend = args.backend or cfg.camera_backend
    index = args.index if args.index is not None else cfg.camera_index
    if args.index is None and cfg.camera_name:
        wanted = cfg.camera_name.lower()
        for candidate_index, candidate_name in names.items():
            if wanted in candidate_name.lower():
                index = candidate_index
                break
    snapshot_path = Path(args.snapshot) if args.snapshot else None
    headless = bool(args.headless)
    seconds = float(args.seconds or 0)
    selected: Optional[int] = None
    if not headless:
        print("预览窗口已打开：q/Esc 退出，s 保存截图，0-9 切换摄像头，Enter 选中。")
        print("预览用自动曝光（方便看清画面）；守护进程实际测光用手动短曝光，两者读数不同。")
    while True:
        try:
            cap, used = open_camera(index, backend)
        except CameraError as exc:
            print("打开摄像头 index=%d 失败: %s" % (index, exc), file=sys.stderr)
            if args.index is not None or headless:
                return 1
            break
        name = names.get(index, "")
        print(
            "已打开 index=%d%s（后端 %s）"
            % (index, (" / " + name) if name else "", used)
        )
        switch_to: Optional[int] = None
        stop = False
        frames = 0
        deadline = time.monotonic() + seconds if seconds > 0 else None
        try:
            while True:
                ok, frame = cap.read()
                if not ok or frame is None:
                    print("读帧失败，换个摄像头试试", file=sys.stderr)
                    break
                frames += 1
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                luma = float(gray.mean())
                if headless:
                    if frames < 10:
                        continue
                    saved = _save_preview_snapshot(cv2, frame, index, snapshot_path)
                    print(
                        "headless 预览: index=%d 自动曝光平均亮度=%.1f 帧数=%d 截图=%s"
                        % (index, luma, frames, saved or "（保存失败）")
                    )
                    stop = True
                    break
                shown = frame.copy()
                lines = [
                    "LockBright preview   index %d   %s" % (index, name),
                    "auto luma: %.1f" % luma,
                    "q:quit  s:snapshot  0-9:switch  Enter:select",
                ]
                for row, text in enumerate(lines):
                    cv2.putText(
                        shown,
                        text,
                        (10, 26 + row * 24),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (0, 255, 0) if row == 0 else (0, 255, 255),
                        1,
                        cv2.LINE_AA,
                    )
                cv2.imshow("LockBright - camera preview", shown)
                key = cv2.waitKey(30) & 0xFF
                if key in (27, ord("q")):
                    stop = True
                    break
                if key == ord("s"):
                    saved = _save_preview_snapshot(cv2, frame, index, snapshot_path)
                    print("截图: %s" % (saved or "保存失败"))
                if key in (13, 10):
                    selected = index
                    stop = True
                    break
                if ord("0") <= key <= ord("9"):
                    new_index = key - ord("0")
                    if new_index != index:
                        switch_to = new_index
                        stop = True
                        break
                if deadline is not None and time.monotonic() >= deadline:
                    stop = True
                    break
        finally:
            try:
                cap.release()
            except Exception:  # noqa: BLE001
                pass
            if not headless:
                try:
                    cv2.destroyAllWindows()
                except Exception:  # noqa: BLE001
                    pass
        if switch_to is not None:
            index = switch_to
            continue
        break
    if selected is not None:
        name = names.get(selected) or None
        if args.set:
            new_cfg = replace(cfg, camera_index=selected, camera_name=name)
            target = save_config(new_cfg, config_path() if args.config is None else Path(args.config))
            print("已选中 index=%d%s，写入配置: %s" % (selected, (" / " + name) if name else "", target))
            print("重启服务后生效：Windows 用 Stop/Start-ScheduledTask LockBright；macOS 用 launchctl kickstart。")
        else:
            print(
                "选中 index=%d%s。加 --set 重新运行可写入配置。"
                % (selected, (" / " + name) if name else "")
            )
    return 0


def cmd_set_brightness(args: argparse.Namespace) -> int:
    cfg, _ = load_config(args.config)
    setup_logging(cfg, console=True, file_logging=False)
    percent = int(args.percent)
    if not 0 <= percent <= 100:
        print("亮度必须在 0..100 之间", file=sys.stderr)
        return 2
    platform = create_platform()
    try:
        before = platform.get_brightness()
        ok = platform.set_brightness(percent)
        after = platform.get_brightness()
    finally:
        platform.close()
    _kv("设置前", before)
    _kv("目标", percent)
    _kv("设置后", after)
    _kv("结果", "成功" if ok else "失败")
    if platform.last_error:
        _kv("错误", platform.last_error)
    if not ok:
        return 1
    if after is not None and after != percent:
        print("注意: 读回的亮度与目标不一致（可能被系统自动亮度覆盖）", file=sys.stderr)
    return 0


def cmd_simulate(args: argparse.Namespace) -> int:
    cfg, _ = load_config(args.config)
    setup_logging(cfg, console=True, file_logging=False)
    platform = create_platform()
    try:
        if args.reset:
            state = State()
        else:
            state = load_state_file(Path(args.state_file) if args.state_file else None)
        locked: Optional[bool]
        if args.locked:
            locked = True
        elif args.unlocked:
            locked = False
        else:
            locked = None
        now = datetime.now()
        at = _parse_at(args.at)
        if at is not None:
            now = datetime.combine(now.date(), at)
        luma = args.luma
        new_state, actions, errors = apply_decision(
            cfg, state, platform, now, locked, luma, dry_run=not args.apply
        )
        print("LockBright simulate — %s" % ("真实执行（会改亮度）" if args.apply else "dry-run（不改亮度）"))
        _kv("时间", now.strftime("%Y-%m-%d %H:%M:%S"))
        _kv("锁屏", locked)
        _kv("亮度采样", luma if luma is not None else "（本轮不测光）")
        if actions:
            for action in actions:
                print("  动作: %s" % action.describe())
        else:
            print("  动作: 无")
        for message in errors:
            print("  失败: %s" % message)
        if args.apply:
            target_path = Path(args.state_file) if args.state_file else state_path()
            if new_state != state:
                save_state_file(new_state, target_path)
                _kv("状态已保存", target_path)
            _kv("当前亮度", platform.get_brightness())
        else:
            _kv("预计状态", new_state.to_dict())
        return 0 if not errors else 1
    finally:
        platform.close()


def cmd_run(args: argparse.Namespace) -> int:
    ensure_home()
    # Bootstrap file logging with defaults *before* parsing the config: under
    # pythonw there is no stderr, so a bad config.json would otherwise be lost.
    try:
        setup_logging(Config(), console=True, file_logging=True)
    except Exception:  # noqa: BLE001 - logging bootstrap must never block start
        pass
    cfg, config_file = load_config(args.config)
    if args.interval is not None:
        cfg = replace(cfg, check_interval_seconds=max(1, int(args.interval)))
    setup_logging(cfg, console=True, file_logging=True)
    log.info("配置文件: %s", config_file)
    platform = create_platform()
    daemon = Daemon(
        cfg,
        platform,
        dry_run=args.dry_run,
        locked_override=True if args.force_locked else (False if args.force_unlocked else None),
    )
    try:
        if args.once:
            actions, state = daemon.tick()
            print("LockBright once — platform=%s" % getattr(platform, "name", "?"))
            print(
                "  锁屏=%s%s 亮度=%s 状态=%s"
                % (
                    daemon.last_locked,
                    "（人工指定）" if daemon.locked_override is not None else "",
                    platform.get_brightness(),
                    state.to_dict(),
                )
            )
            if actions:
                for action in actions:
                    print("  动作: %s" % action.describe())
            else:
                print("  动作: 无")
            return 0
        daemon.run_forever()
        return 0
    finally:
        try:
            platform.close()
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------- main
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lockbright",
        description="锁屏后若环境变黑则调暗屏幕，早上定时拉满亮度（Windows / macOS）。",
    )
    parser.add_argument("--version", action="version", version="LockBright " + __version__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="生成默认配置")
    p_init.add_argument("--config", type=Path, default=None)
    p_init.set_defaults(func=cmd_init)

    p_status = sub.add_parser("status", help="显示配置/状态/当前亮度/锁屏状态")
    p_status.add_argument("--config", type=Path, default=None)
    p_status.set_defaults(func=cmd_status)

    p_probe = sub.add_parser("probe", help="探测环境与摄像头序号")
    p_probe.add_argument("--config", type=Path, default=None)
    p_probe.add_argument("--camera-max", type=int, default=4, help="最大摄像头序号（默认 4）")
    p_probe.add_argument("--backend", default=None, help="dshow/msmf/avfoundation/any/auto")
    p_probe.add_argument("--no-save", action="store_true", help="不保存探测截图")
    p_probe.set_defaults(func=cmd_probe)

    p_cams = sub.add_parser("cameras", help="列出所有摄像头（名称/测光/截图）")
    p_cams.add_argument("--config", type=Path, default=None)
    p_cams.add_argument("--camera-max", type=int, default=4, help="最大摄像头序号（默认 4）")
    p_cams.add_argument("--backend", default=None, help="dshow/msmf/avfoundation/any/auto")
    p_cams.add_argument("--no-save", action="store_true", help="不保存截图")
    p_cams.set_defaults(func=cmd_cameras)

    p_prev = sub.add_parser("preview", help="实时预览摄像头，可选中并写入配置")
    p_prev.add_argument("--config", type=Path, default=None)
    p_prev.add_argument("--index", type=int, default=None, help="要预览的摄像头 index（默认用配置）")
    p_prev.add_argument("--backend", default=None, help="dshow/msmf/avfoundation/any/auto")
    p_prev.add_argument("--seconds", type=float, default=0, help="自动关闭前的秒数（0=手动退出）")
    p_prev.add_argument("--set", action="store_true", help="窗口里按 Enter 选中后写入配置")
    p_prev.add_argument("--headless", action="store_true", help="不开窗口，只抓一帧并保存截图")
    p_prev.add_argument("--snapshot", default=None, help="截图路径（默认 ~/.lockbright/probe/）")
    p_prev.set_defaults(func=cmd_preview)

    p_set = sub.add_parser("set-brightness", help="手动设置屏幕亮度 0..100")
    p_set.add_argument("percent", type=int)
    p_set.add_argument("--config", type=Path, default=None)
    p_set.set_defaults(func=cmd_set_brightness)

    p_sim = sub.add_parser("simulate", help="用给定条件跑一次决策（默认 dry-run）")
    p_sim.add_argument("--config", type=Path, default=None)
    lock_group = p_sim.add_mutually_exclusive_group()
    lock_group.add_argument("--locked", action="store_true", help="假设已锁屏")
    lock_group.add_argument("--unlocked", action="store_true", help="假设未锁屏")
    lock_group.add_argument("--unknown", action="store_true", help="假设锁屏状态未知（默认）")
    p_sim.add_argument("--luma", type=float, default=None, help="假设的环境亮度 0..255")
    p_sim.add_argument("--at", default=None, help="假设时间 HH:MM（默认现在）")
    p_sim.add_argument("--apply", action="store_true", help="真的设置亮度并保存状态")
    p_sim.add_argument("--reset", action="store_true", help="从空状态开始（忽略状态文件）")
    p_sim.add_argument("--state-file", default=None)
    p_sim.set_defaults(func=cmd_simulate)

    p_run = sub.add_parser("run", help="运行守护循环")
    p_run.add_argument("--config", type=Path, default=None)
    p_run.add_argument("--once", action="store_true", help="只跑一次观察/决策")
    p_run.add_argument("--dry-run", action="store_true", help="不真正设置亮度、不写状态")
    p_run.add_argument("--interval", type=int, default=None, help="覆盖检查间隔（秒）")
    run_lock_group = p_run.add_mutually_exclusive_group()
    run_lock_group.add_argument(
        "--force-locked",
        action="store_true",
        help="诊断用：假装已锁屏（仍用真实摄像头和亮度）",
    )
    run_lock_group.add_argument(
        "--force-unlocked",
        action="store_true",
        help="诊断用：假装未锁屏",
    )
    p_run.set_defaults(func=cmd_run)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ConfigError as exc:
        logging.getLogger("lockbright").error("配置错误: %s", exc)
        print("配置错误: %s" % exc, file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("已中断", file=sys.stderr)
        return 130
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        logging.getLogger("lockbright").exception("未处理的错误")
        print("出错: %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    _fix_stdio_encoding()
    sys.exit(main())
