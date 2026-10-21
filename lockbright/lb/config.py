"""Configuration loading / validation.

The config lives at ``~/.lockbright/config.json`` (override the directory with
``LOCKBRIGHT_HOME``).  Unknown keys are ignored with a warning so that older
config files keep working; invalid values raise :class:`ConfigError` with a
message that names the offending key.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from .paths import config_path

log = logging.getLogger(__name__)

DEFAULT_CAMERA_BACKEND = "auto"
KNOWN_BACKENDS = {"auto", "dshow", "msmf", "avfoundation", "any"}
KNOWN_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR"}


class ConfigError(ValueError):
    """Raised when the config file cannot be parsed or contains bad values."""


@dataclass
class Config:
    # timing
    check_interval_seconds: int = 60
    night_start: str = "20:00"
    morning_time: str = "07:30"
    # brightness targets
    morning_brightness: int = 100
    dim_brightness: int = 0
    fallback_restore_brightness: int = 80
    # darkness detection
    dark_luma_threshold: float = 20.0
    restore_luma_threshold: float = 40.0
    dark_confirm_samples: int = 2
    restore_on_unlock: bool = True
    # remote login (RDP) also counts as "locked screen" for dimming purposes
    treat_remote_as_locked: bool = True
    # camera
    camera_index: int = 0
    camera_name: Optional[str] = None
    camera_samples: int = 5
    camera_warmup_frames: int = 3
    camera_backend: str = DEFAULT_CAMERA_BACKEND
    camera_manual_exposure: bool = True
    # -4 is the longest manual exposure this class of UVC webcam accepts
    # (values -1..-3 get clamped to -4).  At -6 a lit room read only ~10,
    # i.e. the same as a dark room; -4 gives ~58 lit vs ~9 dark here.
    camera_exposure: float = -4.0
    # logging
    log_level: str = "INFO"
    log_max_bytes: int = 1_048_576
    log_backup_count: int = 3

    # ---------------------------------------------------------------- helpers
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Config":
        if not isinstance(data, dict):
            raise ConfigError("配置文件顶层必须是 JSON 对象")
        cfg = cls()
        known = {f.name for f in fields(cls)}
        for key in data:
            if key not in known:
                log.warning("配置里有未知字段，已忽略: %s", key)
        for f in fields(cls):
            if f.name not in data:
                continue
            raw = data[f.name]
            try:
                if f.name == "camera_name":
                    text = "" if raw is None else str(raw).strip()
                    value = text or None
                elif f.type is bool or f.type == "bool":
                    value: Any = _as_bool(raw)
                elif f.type is int or f.type == "int":
                    value = _as_int(raw)
                elif f.type is float or f.type == "float":
                    value = round(float(raw), 2)
                else:
                    value = str(raw).strip()
            except (TypeError, ValueError) as exc:
                raise ConfigError("配置项 %s 的值无效: %r (%s)" % (f.name, raw, exc))
            setattr(cfg, f.name, value)
        cfg.validate()
        return cfg

    def validate(self) -> None:
        if not 1 <= self.check_interval_seconds <= 86_400:
            raise ConfigError("check_interval_seconds 必须在 1..86400 之间")
        if not 0 <= self.morning_brightness <= 100:
            raise ConfigError("morning_brightness 必须在 0..100 之间")
        if not 0 <= self.dim_brightness <= 100:
            raise ConfigError("dim_brightness 必须在 0..100 之间")
        if not 0 <= self.fallback_restore_brightness <= 100:
            raise ConfigError("fallback_restore_brightness 必须在 0..100 之间")
        if not 0 <= self.dark_luma_threshold <= 255:
            raise ConfigError("dark_luma_threshold 必须在 0..255 之间")
        if not 0 <= self.restore_luma_threshold <= 255:
            raise ConfigError("restore_luma_threshold 必须在 0..255 之间")
        if self.dark_confirm_samples < 1:
            raise ConfigError("dark_confirm_samples 必须 >= 1")
        if self.camera_index < 0:
            raise ConfigError("camera_index 必须 >= 0")
        if self.camera_name is not None:
            if not isinstance(self.camera_name, str) or len(self.camera_name) > 200:
                raise ConfigError("camera_name 必须是字符串（设备名片段）或 null")
            if not self.camera_name.strip():
                raise ConfigError("camera_name 不能是空字符串（不用就设为 null）")
        if self.camera_samples < 1:
            raise ConfigError("camera_samples 必须 >= 1")
        if self.camera_warmup_frames < 0:
            raise ConfigError("camera_warmup_frames 必须 >= 0")
        if self.camera_backend not in KNOWN_BACKENDS:
            raise ConfigError(
                "camera_backend 必须是 %s 之一" % ", ".join(sorted(KNOWN_BACKENDS))
            )
        if not -20.0 <= self.camera_exposure <= 0.0:
            raise ConfigError("camera_exposure 必须在 -20..0 之间（如 -6 表示 1/64 秒）")
        if self.log_level.upper() not in KNOWN_LOG_LEVELS:
            raise ConfigError("log_level 必须是 DEBUG/INFO/WARNING/ERROR 之一")
        if self.log_max_bytes < 4096:
            raise ConfigError("log_max_bytes 必须 >= 4096")
        if self.log_backup_count < 1:
            raise ConfigError("log_backup_count 必须 >= 1")
        parse_hhmm(self.night_start)
        parse_hhmm(self.morning_time)
        if self.restore_luma_threshold <= self.dark_luma_threshold:
            raise ConfigError(
                "restore_luma_threshold 必须大于 dark_luma_threshold"
                "（否则会调暗/恢复来回震荡）"
            )
        if self.morning_brightness <= self.dim_brightness:
            raise ConfigError("morning_brightness 必须大于 dim_brightness")
        if self.night_start_minutes() == self.morning_minutes():
            raise ConfigError("night_start 与 morning_time 不能相同（夜间时段会为空）")

    # ------------------------------------------------------------- time logic
    def night_start_minutes(self) -> int:
        return parse_hhmm(self.night_start)

    def morning_minutes(self) -> int:
        return parse_hhmm(self.morning_time)


def parse_hhmm(value: str) -> int:
    """Parse ``"HH:MM"`` into minutes since midnight, raising ConfigError."""
    text = str(value).strip()
    parts = text.split(":")
    if len(parts) != 2:
        raise ConfigError("时间格式应为 HH:MM，收到: %r" % (value,))
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        raise ConfigError("时间格式应为 HH:MM，收到: %r" % (value,))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ConfigError("时间超出范围（00:00..23:59）: %r" % (value,))
    return hour * 60 + minute


def _as_bool(raw: Any) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    text = str(raw).strip().lower()
    if text in {"true", "1", "yes", "y", "on"}:
        return True
    if text in {"false", "0", "no", "n", "off"}:
        return False
    raise ValueError("不是布尔值")


def _as_int(raw: Any) -> int:
    if isinstance(raw, bool):
        return int(raw)
    return int(raw)


def write_default_config(path: Optional[Path] = None) -> Path:
    """Write the default config file, creating parent directories."""
    target = Path(path) if path is not None else config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(Config().to_dict(), indent=2, ensure_ascii=False) + "\n"
    target.write_text(payload, encoding="utf-8")
    return target


def save_config(cfg: Config, path: Optional[Path] = None) -> Path:
    """Persist ``cfg`` back to the config file atomically (camera selection)."""
    target = Path(path) if path is not None else config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(cfg.to_dict(), indent=2, ensure_ascii=False) + "\n"
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, target)
    return target


def load_config(path: Optional[Path] = None, create_if_missing: bool = True) -> Tuple[Config, Path]:
    """Load config from ``path`` (default home config), creating defaults if absent."""
    target = Path(path) if path is not None else config_path()
    if not target.exists():
        if create_if_missing:
            write_default_config(target)
            log.info("已生成默认配置: %s", target)
        return Config(), target
    try:
        raw_text = target.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise ConfigError("读取配置失败 %s: %s" % (target, exc))
    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ConfigError("配置文件不是合法 JSON (%s): %s" % (target, exc))
    cfg = Config.from_dict(data)
    return cfg, target
