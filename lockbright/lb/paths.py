"""Filesystem locations (config / state / logs / probe images).

``LOCKBRIGHT_HOME`` overrides the home directory so tests and dry runs never
touch the real user config.
"""
from __future__ import annotations

import os
from pathlib import Path


def home_dir() -> Path:
    override = os.environ.get("LOCKBRIGHT_HOME")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".lockbright"


def config_path() -> Path:
    return home_dir() / "config.json"


def state_path() -> Path:
    return home_dir() / "state.json"


def log_path() -> Path:
    return home_dir() / "lockbright.log"


def probe_dir() -> Path:
    return home_dir() / "probe"


def ensure_home() -> Path:
    home = home_dir()
    home.mkdir(parents=True, exist_ok=True)
    return home
