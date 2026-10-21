"""Windows implementation: lock detection + WMI display brightness."""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import logging
import shutil
import subprocess
import sys
import time
from typing import List, Optional

from .platform_base import Platform, clamp_percent

log = logging.getLogger(__name__)

DESKTOP_READOBJECTS = 0x0001
UOI_NAME = 2
ERROR_ACCESS_DENIED = 5
CREATE_NO_WINDOW = 0x08000000
TH32CS_SNAPPROCESS = 0x00000002
MAX_PATH = 260

# WTSQuerySessionInformationW / WTS_CONNECTSTATE_CLASS
WTS_CURRENT_SESSION = -1  # (DWORD)-1
WTS_CONNECT_STATE = 8
WTS_CLIENT_PROTOCOL_TYPE = 16
WTS_IS_REMOTE_SESSION = 29
WTS_ACTIVE = 0


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("cntUsage", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD),
        ("szExeFile", wt.WCHAR * MAX_PATH),
    ]


class WindowsPlatform(Platform):
    """Lock detection via the input desktop name, brightness via WMI.

    ``OpenInputDesktop`` points at the ``Default`` desktop while unlocked and at
    the ``Winlogon`` secure desktop while the session is locked.  If opening it
    fails, fall back to looking for ``LogonUI.exe`` in our own session and
    return ``None`` when even that is inconclusive (never guess "locked").
    """

    name = "windows"

    def __init__(self) -> None:
        super().__init__()
        if not sys.platform.startswith("win"):
            raise RuntimeError("WindowsPlatform 只能在 Windows 上使用")
        self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._user32.OpenInputDesktop.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
        self._user32.OpenInputDesktop.restype = wt.HANDLE
        self._user32.GetUserObjectInformationW.argtypes = [
            wt.HANDLE,
            ctypes.c_int,
            wt.LPVOID,
            wt.DWORD,
            ctypes.POINTER(wt.DWORD),
        ]
        self._user32.GetUserObjectInformationW.restype = wt.BOOL
        self._user32.CloseDesktop.argtypes = [wt.HANDLE]
        self._user32.CloseDesktop.restype = wt.BOOL
        self._kernel32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
        self._kernel32.CreateToolhelp32Snapshot.restype = wt.HANDLE
        self._kernel32.Process32FirstW.argtypes = [
            wt.HANDLE,
            ctypes.POINTER(PROCESSENTRY32W),
        ]
        self._kernel32.Process32FirstW.restype = wt.BOOL
        self._kernel32.Process32NextW.argtypes = [
            wt.HANDLE,
            ctypes.POINTER(PROCESSENTRY32W),
        ]
        self._kernel32.Process32NextW.restype = wt.BOOL
        self._kernel32.CloseHandle.argtypes = [wt.HANDLE]
        self._kernel32.CloseHandle.restype = wt.BOOL
        self._kernel32.GetCurrentProcessId.restype = wt.DWORD
        self._kernel32.ProcessIdToSessionId.argtypes = [
            wt.DWORD,
            ctypes.POINTER(wt.DWORD),
        ]
        self._kernel32.ProcessIdToSessionId.restype = wt.BOOL
        self._wtsapi = ctypes.WinDLL("wtsapi32", use_last_error=True)
        self._wtsapi.WTSQuerySessionInformationW.argtypes = [
            wt.HANDLE,
            wt.DWORD,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(wt.DWORD),
        ]
        self._wtsapi.WTSQuerySessionInformationW.restype = wt.BOOL
        self._wtsapi.WTSFreeMemory.argtypes = [ctypes.c_void_p]
        self._wtsapi.WTSFreeMemory.restype = None
        self._powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if not self._powershell:  # pragma: no cover - very unusual
            self._powershell = shutil.which("pwsh.exe") or shutil.which("pwsh")

    # ------------------------------------------------------------ lock state
    def is_session_active(self) -> Optional[bool]:
        """False when our session is disconnected (detached RDP, etc.).

        A disconnected session still runs its processes, but its window station
        is not on the physical display anymore; dimming "the screen" from there
        would darken whatever the console user is looking at.
        """
        state = self._connect_state()
        if state is None:
            return None
        return state == WTS_ACTIVE

    def _connect_state(self) -> Optional[int]:
        return self._wts_query_dword(WTS_CONNECT_STATE)

    def is_remote_session(self) -> Optional[bool]:
        # WTSIsRemoteSession returns BOOLEAN = 1 byte on this platform, so it
        # must not be read as a DWORD.
        raw = self._wts_query_bytes(WTS_IS_REMOTE_SESSION)
        if raw:
            return bool(raw[0])
        # Fallback: WTSClientProtocolType is 0=console, 1=ICA, 2=RDP (USHORT).
        raw = self._wts_query_bytes(WTS_CLIENT_PROTOCOL_TYPE)
        if raw and len(raw) >= 2:
            return int.from_bytes(raw[:2], "little") != 0
        return None

    def _wts_query_dword(self, info_class: int) -> Optional[int]:
        raw = self._wts_query_bytes(info_class)
        if not raw or len(raw) < 4:
            return None
        return int.from_bytes(raw[:4], "little")

    def _wts_query_bytes(self, info_class: int) -> Optional[bytes]:
        buffer = ctypes.c_void_p()
        size = wt.DWORD(0)
        try:
            ok = self._wtsapi.WTSQuerySessionInformationW(
                None,
                WTS_CURRENT_SESSION,
                info_class,
                ctypes.byref(buffer),
                ctypes.byref(size),
            )
            if not ok or not buffer or not size.value:
                return None
            return ctypes.string_at(buffer, size.value)
        except (OSError, ValueError):
            return None
        finally:
            if buffer:
                self._wtsapi.WTSFreeMemory(buffer)

    def is_locked(self) -> Optional[bool]:
        if self.is_session_active() is False:
            self.last_error = "当前会话已断开（非活动会话），不判断锁屏"
            log.debug(self.last_error)
            return None
        handle = self._user32.OpenInputDesktop(0, False, DESKTOP_READOBJECTS)
        if not handle:
            error = ctypes.get_last_error()
            log.debug("OpenInputDesktop 失败，错误码=%s，尝试 LogonUI 兜底", error)
            return self._logonui_in_own_session()
        try:
            buf = ctypes.create_unicode_buffer(256)
            needed = wt.DWORD(0)
            ok = self._user32.GetUserObjectInformationW(
                handle,
                UOI_NAME,
                buf,
                ctypes.sizeof(buf),
                ctypes.byref(needed),
            )
            if not ok:
                log.debug("GetUserObjectInformationW 失败，错误码=%s", ctypes.get_last_error())
                return self._logonui_in_own_session()
            desktop_name = (buf.value or "").lower()
            if not desktop_name:
                return self._logonui_in_own_session()
            return desktop_name != "default"
        finally:
            self._user32.CloseDesktop(handle)

    def _logonui_in_own_session(self) -> Optional[bool]:
        try:
            enumerated, pid = self._find_logonui_in_own_session()
        except OSError as exc:
            log.debug("枚举进程失败: %s", exc)
            return None
        if not enumerated:
            return None  # cannot tell -> do not pretend "unlocked"
        return bool(pid)

    def _find_logonui_in_own_session(self) -> tuple[bool, Optional[int]]:
        """Return (enumeration_succeeded, logonui_pid_in_own_session_or_None)."""
        invalid = ctypes.c_void_p(-1).value
        try:
            snapshot = self._kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        except OSError:
            return False, None
        if snapshot is None or snapshot == invalid or snapshot == -1:
            return False, None
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        own_session = wt.DWORD(0)
        self._kernel32.ProcessIdToSessionId(
            self._kernel32.GetCurrentProcessId(), ctypes.byref(own_session)
        )
        try:
            ok = self._kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
            while ok:
                if (entry.szExeFile or "").lower() == "logonui.exe":
                    session = wt.DWORD(0)
                    if (
                        self._kernel32.ProcessIdToSessionId(
                            entry.th32ProcessID, ctypes.byref(session)
                        )
                        and session.value == own_session.value
                    ):
                        return True, int(entry.th32ProcessID)
                ok = self._kernel32.Process32NextW(snapshot, ctypes.byref(entry))
        finally:
            self._kernel32.CloseHandle(snapshot)
        return True, None

    # ------------------------------------------------------------- brightness
    def get_brightness(self) -> Optional[int]:
        script = (
            "$ErrorActionPreference='Stop';"
            "$m=@(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness);"
            "if($m.Count -eq 0){exit 7};"
            "Write-Output ([int]$m[0].CurrentBrightness)"
        )
        rc, out, err = self._run_powershell(script)
        if rc != 0:
            self.last_error = "读取亮度失败(rc=%s): %s" % (rc, (err or out).strip()[:300])
            log.debug(self.last_error)
            return None
        try:
            value = int(out.strip().splitlines()[-1])
        except (ValueError, IndexError):
            self.last_error = "亮度输出无法解析: %r" % (out[:120],)
            log.debug(self.last_error)
            return None
        if not 0 <= value <= 100:
            self.last_error = "亮度超出范围: %s" % value
            return None
        self.last_error = None
        return value

    def set_brightness(self, percent: int) -> bool:
        value = clamp_percent(percent)
        script = (
            "$ErrorActionPreference='Stop';"
            "$m=@(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods);"
            "if($m.Count -eq 0){exit 7};"
            "foreach($x in $m){"
            "Invoke-CimMethod -InputObject $x -MethodName WmiSetBrightness "
            "-Arguments @{Timeout=1;Brightness=[byte]%d} | Out-Null };"
            "Write-Output 'OK'"
        ) % value
        rc, out, err = self._run_powershell(script)
        if rc != 0:
            self.last_error = "设置亮度失败(rc=%s): %s" % (rc, (err or out).strip()[:300])
            log.warning(self.last_error)
            return False
        # WMI can report success while the panel ignores it (auto-brightness,
        # driver quirk), so verify by reading the brightness back.
        time.sleep(0.25)
        readback = self.get_brightness()
        if readback is None:
            self.last_error = "亮度已下发但无法读回校验: %s" % (self.last_error or "读取失败")
            log.warning(self.last_error)
            return True
        if abs(readback - value) <= 2:
            self.last_error = None
            log.debug("WMI 设置亮度=%d 成功（读回 %s）", value, readback)
            return True
        self.last_error = "亮度设置未生效: 目标 %d%%，读回 %s%%" % (value, readback)
        log.warning(self.last_error)
        return False

    # ---------------------------------------------------------------- helpers
    def _run_powershell(self, script: str):
        if not self._powershell:  # pragma: no cover
            return 127, "", "找不到 powershell.exe / pwsh.exe"
        cmd: List[str] = [
            self._powershell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ]
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                creationflags=CREATE_NO_WINDOW,
            )
            return proc.returncode, proc.stdout or "", proc.stderr or ""
        except subprocess.TimeoutExpired:
            return 124, "", "PowerShell 超时"
        except OSError as exc:
            return 126, "", str(exc)
