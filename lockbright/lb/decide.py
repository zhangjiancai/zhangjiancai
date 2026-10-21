"""Pure decision logic (no I/O) for LockBright.

``decide()`` is side-effect free: it takes the current state plus one
observation (time, lock state, optional luminance) and returns the next state
and a list of brightness actions to perform.  The daemon applies the actions
and rolls the state back if a write fails, so the whole behaviour is unit
testable without a display or a camera.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, time as dtime
from typing import Any, Dict, List, Optional, Tuple

from .config import Config

MORNING = "morning"
DIM = "dim"
RESTORE = "restore"


@dataclass
class State:
    """Persisted runtime state."""

    dimmed: bool = False
    baseline_brightness: Optional[int] = None
    last_morning_date: Optional[str] = None  # ISO date "YYYY-MM-DD"
    dark_streak: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "dimmed": self.dimmed,
            "baseline_brightness": self.baseline_brightness,
            "last_morning_date": self.last_morning_date,
            "dark_streak": self.dark_streak,
        }

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "State":
        state = cls()
        if not isinstance(data, dict):
            return state
        state.dimmed = bool(data.get("dimmed", False))
        baseline = data.get("baseline_brightness")
        try:
            state.baseline_brightness = None if baseline is None else int(baseline)
        except (TypeError, ValueError):
            state.baseline_brightness = None
        last_morning = data.get("last_morning_date")
        if isinstance(last_morning, str):
            state.last_morning_date = last_morning
        try:
            state.dark_streak = max(0, int(data.get("dark_streak", 0)))
        except (TypeError, ValueError):
            state.dark_streak = 0
        return state


@dataclass(frozen=True)
class Action:
    kind: str  # "morning" | "dim" | "restore"
    target: int
    reason: str

    def describe(self) -> str:
        return "%s(brightness=%d, %s)" % (self.kind, self.target, self.reason)


def in_night_window(now: dtime, night_start: dtime, morning: dtime) -> bool:
    """True when ``now`` is inside [night_start, morning) (crossing midnight)."""
    if night_start <= morning:
        return night_start <= now < morning
    return now >= night_start or now < morning


def _time_of(now: datetime) -> dtime:
    return now.time().replace(microsecond=0)


def _morning_pending(config: Config, state: State, now: datetime, in_night: bool) -> bool:
    """True when today's morning restore still has to run.

    It only fires outside the night window: if the daemon starts at 23:00 after
    being off all day we must not flash 100% brightness in the middle of the
    night, then dim again two minutes later.  The next morning it catches up.
    """
    if in_night:
        return False
    now_t = _time_of(now)
    morning = dtime(*(divmod(config.morning_minutes(), 60)))
    return now_t >= morning and state.last_morning_date != now.date().isoformat()


def decide(
    config: Config,
    state: State,
    now: datetime,
    locked: Optional[bool],
    luma: Optional[float],
) -> Tuple[State, List[Action]]:
    """Return (new_state, actions).  Pure: does not mutate ``state``."""
    new_state = replace(state)
    actions: List[Action] = []
    night_start = dtime(*(divmod(config.night_start_minutes(), 60)))
    morning = dtime(*(divmod(config.morning_minutes(), 60)))
    now_t = _time_of(now)
    night_now = in_night_window(now_t, night_start, morning)

    # 1) morning catch-up (independent of lock state, once per calendar day)
    if _morning_pending(config, new_state, now, night_now):
        actions.append(
            Action(MORNING, config.morning_brightness, "早上 %s 到点" % config.morning_time)
        )
        new_state.last_morning_date = now.date().isoformat()
        new_state.dimmed = False
        new_state.baseline_brightness = None
        new_state.dark_streak = 0
        return new_state, actions

    if locked is True:
        if new_state.dimmed:
            if luma is not None and luma >= config.restore_luma_threshold:
                actions.append(
                    Action(
                        RESTORE,
                        _restore_target(config, new_state),
                        "开灯了（亮度 %.1f >= %.1f）" % (luma, config.restore_luma_threshold),
                    )
                )
                new_state.dimmed = False
                new_state.baseline_brightness = None
                new_state.dark_streak = 0
                return new_state, actions
            if not night_now:
                actions.append(
                    Action(RESTORE, _restore_target(config, new_state), "离开夜间时段")
                )
                new_state.dimmed = False
                new_state.baseline_brightness = None
                new_state.dark_streak = 0
                return new_state, actions
            return new_state, actions

        # not dimmed yet
        if not night_now:
            new_state.dark_streak = 0
            return new_state, actions
        if luma is None:
            # A failed measurement must not contribute a confirmation sample,
            # and old samples must not survive a failed tick.
            new_state.dark_streak = 0
            return new_state, actions
        if luma < config.dark_luma_threshold:
            new_state.dark_streak = state.dark_streak + 1
            if new_state.dark_streak >= config.dark_confirm_samples:
                actions.append(
                    Action(
                        DIM,
                        config.dim_brightness,
                        "锁屏且关灯（亮度 %.1f < %.1f，连续 %d 次）"
                        % (luma, config.dark_luma_threshold, new_state.dark_streak),
                    )
                )
                new_state.dimmed = True
                new_state.dark_streak = 0
            return new_state, actions
        new_state.dark_streak = 0
        return new_state, actions

    if locked is False:
        new_state.dark_streak = 0
        if new_state.dimmed and config.restore_on_unlock:
            actions.append(
                Action(RESTORE, _restore_target(config, new_state), "解锁恢复亮度")
            )
            new_state.dimmed = False
            new_state.baseline_brightness = None
        return new_state, actions

    # locked is None -> cannot act on lock-dependent rules
    new_state.dark_streak = 0
    return new_state, actions


def _restore_target(config: Config, state: State) -> int:
    baseline = state.baseline_brightness
    if baseline is None or not 0 <= baseline <= 100:
        return config.fallback_restore_brightness
    if baseline <= config.dim_brightness:
        # We could not capture a usable baseline before dimming; never restore
        # to "dark", use the fallback instead.
        return config.fallback_restore_brightness
    return baseline


def needs_camera(config: Config, state: State, now: datetime, locked: Optional[bool]) -> bool:
    """Whether this tick needs a luminance measurement (saves camera wake-ups)."""
    if locked is not True:
        return False
    night_start = dtime(*(divmod(config.night_start_minutes(), 60)))
    morning = dtime(*(divmod(config.morning_minutes(), 60)))
    night_now = in_night_window(_time_of(now), night_start, morning)
    if _morning_pending(config, state, now, night_now):
        return False  # morning action will run; no measurement needed
    return state.dimmed or night_now
