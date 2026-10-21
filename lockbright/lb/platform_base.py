"""Platform abstraction: lock detection + display brightness read/write.

One module per OS (platform_windows.py / platform_macos.py) implements ``Platform``.
Contract: no method may raise; failures return None/False and set ``last_error``.
"""
from __future__ import annotations

from typing import Optional


class Platform:
    """Base class for OS-specific implementations."""

    name = "base"

    def __init__(self) -> None:
        self.last_error: Optional[str] = None

    def is_locked(self) -> Optional[bool]:
        """True = session locked, False = unlocked, None = cannot tell."""
        raise NotImplementedError

    def get_brightness(self) -> Optional[int]:
        """Current brightness 0-100, or None if unsupported/unreadable."""
        raise NotImplementedError

    def set_brightness(self, percent: int) -> bool:
        """Set brightness 0-100 (clamped). True on success."""
        raise NotImplementedError

    def is_session_active(self) -> Optional[bool]:
        """True = this process's login session is the active/interactive one.

        False means the session is disconnected/background (e.g. a detached RDP
        session), where changing the physical display brightness would hit the
        wrong person.  None = cannot tell (treated as active).  Never raises.
        """
        return None

    def is_remote_session(self) -> Optional[bool]:
        """True = this login session is a remote session (RDP etc.).

        Used by the "remote login also counts as locked" feature: while we are
        connected remotely the physical screen belongs to the console/lock
        screen, so dimming it when the room is dark is reasonable.  None =
        cannot tell.  Never raises.
        """
        return None

    def close(self) -> None:
        """Release resources. Optional."""


def clamp_percent(percent: int) -> int:
    return max(0, min(100, int(percent)))
