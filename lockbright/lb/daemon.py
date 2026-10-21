"""Daemon loop: observe -> decide -> apply -> persist.

No OS-specific code lives here; a :class:`~lb.platform_base.Platform` instance
provides lock state / brightness and a callable provides luminance.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import threading
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Callable, List, Optional, Tuple

from .camera import CameraError, measure_luma
from .config import Config
from .decide import DIM, MORNING, RESTORE, Action, State, decide, needs_camera
from .paths import state_path
from .platform_base import Platform

log = logging.getLogger(__name__)

LumaFn = Callable[[], float]
NowFn = Callable[[], datetime]


def apply_decision(
    config: Config,
    state: State,
    platform: Platform,
    now: datetime,
    locked: Optional[bool],
    luma: Optional[float],
    *,
    dry_run: bool = False,
    recheck_locked: Optional[Callable[[], Optional[bool]]] = None,
) -> Tuple[State, List[Action], List[str]]:
    """Decide + apply one observation.  Returns (new_state, actions, errors).

    ``recheck_locked`` is called right before a DIM is written: measuring one
    burst takes 1-4 s and the user may have unlocked in the meantime, in which
    case dimming would be wrong.
    """
    new_state, actions = decide(config, state, now, locked, luma)
    applied: List[Action] = []
    errors: List[str] = []
    for action in actions:
        if dry_run:
            log.info("[dry-run] 将执行 %s", action.describe())
            applied.append(action)
            continue
        if action.kind == DIM:
            if recheck_locked is not None:
                still_locked = recheck_locked()
                if still_locked is not True:
                    log.info(
                        "准备调暗时复查锁屏状态=%s（测量期间可能已解锁），放弃本轮调暗",
                        still_locked,
                    )
                    # roll back the optimistic dim state, keep the tick harmless
                    new_state = replace(
                        new_state,
                        dimmed=state.dimmed,
                        baseline_brightness=state.baseline_brightness,
                        dark_streak=0,
                    )
                    continue
            current = platform.get_brightness()
            baseline = (
                current
                if current is not None and current > config.dim_brightness
                else config.fallback_restore_brightness
            )
            ok = platform.set_brightness(action.target)
            applied.append(action)
            if ok:
                new_state = replace(new_state, baseline_brightness=baseline)
                log.info(
                    "调暗屏幕: %d%% -> %d%%（%s；原亮度记录为 %d%%）",
                    current if current is not None else -1,
                    action.target,
                    action.reason,
                    baseline,
                )
            else:
                message = "调暗失败: %s" % (platform.last_error or "未知错误")
                errors.append(message)
                log.error(message)
                # roll back optimistic state so the next tick retries
                new_state = replace(
                    new_state,
                    dimmed=state.dimmed,
                    baseline_brightness=state.baseline_brightness,
                )
        else:  # RESTORE / MORNING
            ok = platform.set_brightness(action.target)
            applied.append(action)
            if ok:
                log.info(
                    "%s: 亮度设为 %d%%（%s）",
                    "早上拉满" if action.kind == MORNING else "恢复亮度",
                    action.target,
                    action.reason,
                )
            else:
                message = "设置亮度 %d%% 失败: %s" % (
                    action.target,
                    platform.last_error or "未知错误",
                )
                errors.append(message)
                log.error(message)
                new_state = replace(
                    new_state,
                    dimmed=state.dimmed,
                    baseline_brightness=state.baseline_brightness,
                    last_morning_date=state.last_morning_date,
                )
    return new_state, applied, errors


class Daemon:
    def __init__(
        self,
        config: Config,
        platform: Platform,
        *,
        now_fn: Optional[NowFn] = None,
        luma_fn: Optional[LumaFn] = None,
        state_file: Optional[Path] = None,
        dry_run: bool = False,
        locked_override: Optional[bool] = None,
    ) -> None:
        self.config = self._resolve_camera_name(config)
        config = self.config
        self.platform = platform
        self.now_fn: NowFn = now_fn or datetime.now
        self.state_file = Path(state_file) if state_file is not None else state_path()
        self.dry_run = dry_run
        # test/diagnostic hook: pretend locked/unlocked while still using the
        # real camera and brightness backend
        self.locked_override = locked_override
        self.last_locked: Optional[bool] = None
        self._inactive_skips = 0
        self.state = self.load_state()
        self._camera_failures = 0
        if luma_fn is None:
            self.luma_fn: LumaFn = lambda: measure_luma(
                config.camera_index,
                samples=config.camera_samples,
                warmup=config.camera_warmup_frames,
                backend=config.camera_backend,
                manual_exposure=(
                    config.camera_exposure if config.camera_manual_exposure else None
                ),
            )
        else:
            self.luma_fn = luma_fn

    @staticmethod
    def _resolve_camera_name(config: Config) -> Config:
        """Turn ``camera_name`` (substring) into the matching index at startup.

        Camera indices can shift when devices are plugged/unplugged, so a name
        is more stable.  Resolution needs one enumeration at startup only; if it
        fails the configured index is kept.
        """
        configured = (config.camera_name or "").strip()
        if not configured:
            return config
        try:
            from .camera import find_camera_by_name

            found = find_camera_by_name(configured)
        except Exception:  # noqa: BLE001 - enumeration is best-effort
            log.exception("按名字解析摄像头失败，继续用 index=%d", config.camera_index)
            found = None
        if found is None:
            log.warning(
                "配置的 camera_name=%r 没匹配到摄像头（用 index=%d）；"
                "跑 `python run.py cameras` 看可用名称",
                config.camera_name,
                config.camera_index,
            )
            return config
        index, full_name = found
        if index != config.camera_index:
            log.info(
                "camera_name=%r 解析为 index=%d（%s），覆盖配置的 index=%d",
                configured,
                index,
                full_name,
                config.camera_index,
            )
        return replace(config, camera_index=index)

    # ----------------------------------------------------------------- state
    def load_state(self) -> State:
        try:
            if self.state_file.exists():
                data = json.loads(self.state_file.read_text(encoding="utf-8"))
                return State.from_dict(data)
        except (OSError, ValueError) as exc:
            log.warning("状态文件读取失败，重置状态: %s", exc)
        return State()

    def save_state(self) -> None:
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.state_file.with_name(self.state_file.name + ".tmp")
            tmp.write_text(
                json.dumps(self.state.to_dict(), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            os.replace(tmp, self.state_file)
        except OSError as exc:
            log.warning("状态文件写入失败: %s", exc)

    # ------------------------------------------------------------------ tick
    def measure_luma_safe(self) -> Optional[float]:
        try:
            luma = self.luma_fn()
            self._camera_failures = 0
            return luma
        except CameraError as exc:
            self._camera_failures += 1
            if self._camera_failures == 1 or self._camera_failures % 10 == 0:
                log.warning(
                    "摄像头测光失败（连续 %d 次）: %s", self._camera_failures, exc
                )
            return None
        except Exception as exc:  # noqa: BLE001 - keep the daemon alive
            self._camera_failures += 1
            log.exception("摄像头测光异常（连续 %d 次）: %s", self._camera_failures, exc)
            return None

    def _effective_locked(self) -> Optional[bool]:
        """Lock state plus the "remote login counts as locked" rule.

        While we are connected over RDP the physical machine shows its
        console/lock screen, so the user asked for this to be treated like a
        locked screen (camera measurement + dimming still apply).
        """
        locked = self.platform.is_locked()
        if locked is False and self.config.treat_remote_as_locked:
            try:
                remote = self.platform.is_remote_session()
            except Exception:  # noqa: BLE001 - probe must not break the loop
                remote = None
            if remote is True:
                log.debug("当前是远程会话（RDP），按已锁屏处理")
                return True
        return locked

    def tick(self, now: Optional[datetime] = None) -> Tuple[List[Action], State]:
        now = now or self.now_fn()
        try:
            session_active = self.platform.is_session_active()
        except Exception:  # noqa: BLE001 - never break the loop over a probe
            session_active = None
        if session_active is False and self.locked_override is None:
            # Detached RDP session / fast-user-switched-away session: our window
            # station is not on the physical display.  Changing "the screen"
            # brightness from here would hit whoever is actually looking at it.
            self._inactive_skips += 1
            if self.state.dimmed:
                baseline = self.state.baseline_brightness
                target = (
                    baseline
                    if baseline is not None
                    and 0 <= baseline <= 100
                    and baseline > self.config.dim_brightness
                    else self.config.fallback_restore_brightness
                )
                if self.platform.set_brightness(target):
                    self.state = replace(
                        self.state, dimmed=False, baseline_brightness=None, dark_streak=0
                    )
                    self.save_state()
                    log.info(
                        "会话变为非活动，已把亮度恢复到 %d%%（避免留下黑屏）", target
                    )
                else:
                    log.warning(
                        "会话变为非活动，尝试恢复亮度 %d%% 失败: %s",
                        target,
                        self.platform.last_error or "未知错误",
                    )
            elif self._inactive_skips == 1 or self._inactive_skips % 30 == 0:
                log.info(
                    "当前会话不是活动会话（例如 RDP 已断开），跳过亮度动作（已跳过 %d 次）",
                    self._inactive_skips,
                )
            self.last_locked = None
            return [], self.state
        self._inactive_skips = 0
        locked = (
            self.locked_override
            if self.locked_override is not None
            else self._effective_locked()
        )
        self.last_locked = locked
        if locked is None:
            log.debug("锁屏状态未知，本轮不做锁屏相关动作")
        luma: Optional[float] = None
        if needs_camera(self.config, self.state, now, locked):
            luma = self.measure_luma_safe()
            if luma is not None and self.state.dimmed:
                log.info(
                    "已调暗状态下测光: luma=%.1f（>=%.1f 视为开灯并恢复亮度）",
                    luma,
                    self.config.restore_luma_threshold,
                )
        before = self.state
        new_state, actions, _errors = apply_decision(
            self.config,
            self.state,
            self.platform,
            now,
            locked,
            luma,
            dry_run=self.dry_run,
            recheck_locked=(
                None if self.locked_override is not None else self._effective_locked
            ),
        )
        self.state = new_state
        if not self.dry_run and new_state != before:
            self.save_state()
        if not actions:
            log.debug(
                "tick: locked=%s luma=%s dimmed=%s streak=%d",
                locked,
                luma,
                new_state.dimmed,
                new_state.dark_streak,
            )
        return actions, new_state

    # ------------------------------------------------------------------ loop
    def run_forever(self) -> None:
        self._log_startup()
        stop = threading.Event()

        def _handle(signum, _frame):  # noqa: ANN001
            log.info("收到信号 %s，准备退出", signum)
            stop.set()

        for name in ("SIGINT", "SIGTERM"):
            sig = getattr(signal, name, None)
            if sig is not None:
                try:
                    signal.signal(sig, _handle)
                except (ValueError, OSError):
                    pass
        ticks = 0
        try:
            while not stop.is_set():
                try:
                    self.tick()
                except Exception:  # noqa: BLE001 - never let one bad tick kill the loop
                    log.exception("tick 异常（已忽略，继续运行）")
                ticks += 1
                if ticks % 30 == 0:
                    log.info(
                        "heartbeat: 已运行 %d 个检查周期，dimmed=%s，亮度=%s",
                        ticks,
                        self.state.dimmed,
                        self.platform.get_brightness(),
                    )
                stop.wait(max(1, int(self.config.check_interval_seconds)))
        finally:
            log.info("LockBright 退出")
            try:
                self.platform.close()
            except Exception:  # noqa: BLE001
                pass

    def _log_startup(self) -> None:
        log.info(
            "LockBright 启动: platform=%s 间隔=%ds 夜间=%s-%s 早上=%s 目标=%d%% 调暗=%d%%",
            getattr(self.platform, "name", "?"),
            self.config.check_interval_seconds,
            self.config.night_start,
            self.config.morning_time,
            self.config.morning_time,
            self.config.morning_brightness,
            self.config.dim_brightness,
        )
        log.info(
            "摄像头: index=%d name=%r 手动曝光=%s 后端=%s",
            self.config.camera_index,
            self.config.camera_name,
            self.config.camera_exposure if self.config.camera_manual_exposure else "关",
            self.config.camera_backend,
        )
        log.info(
            "状态: dimmed=%s baseline=%s last_morning=%s dark_streak=%d",
            self.state.dimmed,
            self.state.baseline_brightness,
            self.state.last_morning_date,
            self.state.dark_streak,
        )
        log.info(
            "模式: 远程会话按锁屏处理=%s", self.config.treat_remote_as_locked
        )
        log.info("初始亮度=%s 锁屏=%s", self.platform.get_brightness(), self.platform.is_locked())
