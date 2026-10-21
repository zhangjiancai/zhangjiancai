"""macOS implementation: lock-screen detection + display brightness.

Deliverable of the macOS specialist.  Pure standard library (``ctypes`` /
``plistlib`` / ``subprocess``); no pyobjc, no pip packages, no Homebrew
dependency required (the ``brightness`` CLI is only an optional last resort).

Two independent capabilities
============================

**Lock state** -- reads the I/O Kit registry with
``ioreg -n Root -d1 -a`` (XML plist, see ``man 8 ioreg``), finds the
``IOConsoleUsers`` array and inspects ``CGSSessionScreenIsLocked``.
``ioreg`` runs in a few milliseconds (unlike ``log show``) and works while the
running process has no GUI at all.  A pyobjc ``CGSessionCopyCurrentDictionary``
fallback is used only if the ioreg output cannot be parsed *and* pyobjc happens
to be installed.

**Brightness** -- tried in this order (each step is lazy and optional):

1. IOKit public API ``IODisplayGetFloatParameter`` /
   ``IODisplaySetFloatParameter`` on ``IODisplayConnect`` services
   (``kIODisplayBrightnessKey`` == ``"brightness"``).  This is the documented
   API and the primary implementation requested by the spec.
2. ``DisplayServices`` private framework (``DisplayServicesGetBrightness`` /
   ``DisplayServicesSetBrightness``) -- the path that actually works on Apple
   Silicon / macOS 11+, where ``IODisplayConnect`` brightness is unsupported
   (nriley/brightness and many other tools use the same SPI).
3. ``CoreDisplay`` private SPI
   (``CoreDisplay_Display_GetUserBrightness`` /
   ``CoreDisplay_Display_SetUserBrightness``) -- Intel Macs running macOS
   10.12.4 .. 10.15, where the public IOKit *set* is overridden by CoreDisplay
   (Night Shift support).  Not needed when step 2 is available.
4. The optional ``brightness`` CLI (brew / source build), read via
   ``brightness -l`` and write via ``brightness <0..1>``.

When setting through IOKit the code reads the brightness back and, if the
read-back disagrees, continues with the private-SPI fallbacks: on modern macOS
``IODisplaySetFloatParameter`` can return success while the value is silently
overridden by CoreDisplay.  Whatever happens, no method raises: failures
return ``None`` / ``False`` and set :attr:`last_error`.

Lazy loading is deliberate: importing this module on Windows (or on a Mac
without any of these frameworks) must never load a macOS framework at import
time.  On a non-macOS system the methods simply report an error.

All of this is statically verified only (``py_compile`` + interface checks) --
it has NOT been run on a real Mac.  See ``docs/MACOS-NOTES.md`` for the
evidence, the TCC camera caveats and the list of things to verify first.
"""
from __future__ import annotations

import ctypes
import logging
import math
import os
import plistlib
import re
import shutil
import subprocess
import sys
from typing import Dict, List, Optional, Sequence, Tuple

from .platform_base import Platform, clamp_percent

log = logging.getLogger(__name__)

# --------------------------------------------------------------- frameworks
_COREFOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
_COREGRAPHICS = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
_IOKIT = "/System/Library/Frameworks/IOKit.framework/IOKit"
# Private frameworks: paths are stable on macOS 11+, but the symbols may change
# between releases -- every access is guarded and falls through to the next
# strategy (see module docstring and docs/MACOS-NOTES.md).
_DISPLAY_SERVICES = (
    "/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices"
)
_CORE_DISPLAY = "/System/Library/Frameworks/CoreDisplay.framework/CoreDisplay"

# kCFStringEncodingUTF8 (CoreFoundation/CFString.h)
_KCFSTRING_ENCODING_UTF8 = 0x08000100
# kIODisplayBrightnessKey == CFSTR("brightness") in IOKit/graphics/IOGraphicsLib.h
_IOKIT_BRIGHTNESS_KEY = b"brightness"

# Two readings within 6 percentage points count as "the write took effect".
_BRIGHTNESS_TOLERANCE = 0.06
_SUBPROCESS_TIMEOUT = 10  # seconds; ioreg and brightness both answer in ms
_MAX_DISPLAYS = 32

_IOREG = "/usr/sbin/ioreg"
_IOREG_ARGS = ("-n", "Root", "-d1", "-a")
_BRIGHTNESS_CLI = "brightness"
_BRIGHTNESS_CLI_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin")

_CLI_DISPLAY_RE = re.compile(r"^\s*display\s+(\d+):\s*(.*)$")
_CLI_BRIGHTNESS_RE = re.compile(r"brightness\s+([0-9]+(?:\.[0-9]+)?)")
_CLI_FAILURE_RE = re.compile(r"failed|unable|cannot|error", re.IGNORECASE)


# ------------------------------------------------------------------- helpers
def _valid_level(level: object) -> bool:
    """True for a finite brightness level in the documented 0.0..1.0 range."""
    if not isinstance(level, (int, float)) or isinstance(level, bool):
        return False
    value = float(level)
    return math.isfinite(value) and 0.0 <= value <= 1.0


def _to_percent(level: float) -> int:
    """0.0..1.0 -> 0..100, rounded (the Platform contract wants an int)."""
    return max(0, min(100, int(round(float(level) * 100.0))))


def _plist_bool(value: object) -> Optional[bool]:
    """Interpret an ioreg/plist value as bool; ``None`` when it is not a bool."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    return None


def _find_plist_value(payload: object, key: str, depth: int = 0) -> object:
    """Find ``key`` in a plist payload that may be a dict *or* a list.

    ``ioreg -a`` has been observed to return both a top-level dict and a
    top-level array depending on macOS version/situation, so the parser cannot
    assume a shape.  Depth-limited to avoid pathological recursion.
    """
    if depth > 5:
        return None
    if isinstance(payload, dict):
        if key in payload:
            return payload[key]
        for value in payload.values():
            if isinstance(value, (dict, list)):
                found = _find_plist_value(value, key, depth + 1)
                if found is not None:
                    return found
        return None
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, (dict, list)):
                found = _find_plist_value(item, key, depth + 1)
                if found is not None:
                    return found
    return None


def _short_bytes(data: Optional[bytes], limit: int = 240) -> str:
    if not data:
        return ""
    return data.decode("utf-8", "replace").strip()[:limit]


class MacPlatform(Platform):
    """Lock state via ioreg; brightness via IOKit, with macOS fallbacks.

    Unlike :class:`lb.platform_windows.WindowsPlatform` this class does *not*
    raise from ``__init__`` on a non-macOS host: the project's static checks run
    on Windows, and the constructor must stay import-safe / instantiate-safe
    there.  Every capability is lazily initialised and every public method obeys
    the "never raise" contract (:attr:`last_error` carries the reason).
    """

    name = "macos"

    def __init__(self) -> None:
        super().__init__()
        # slot -> loaded CDLL, or None when loading failed / is not attempted.
        self._libs: Dict[str, Optional[ctypes.CDLL]] = {}
        self._bound: set = set()
        self._cf_key: Optional[int] = None
        self._cli_path: Optional[str] = None
        self._cli_checked = False
        self._lock_reason = ""
        self._closed = False

    # ------------------------------------------------------- library loading
    def _load_library(self, slot: str, path: str) -> Optional[ctypes.CDLL]:
        """dlopen ``path`` once; cache success *and* failure per slot."""
        if slot in self._libs:
            return self._libs[slot]
        if self._closed or sys.platform != "darwin":
            self._libs[slot] = None
            return None
        try:
            library = ctypes.CDLL(path)
        except OSError as exc:  # framework missing / not loadable
            log.debug("加载 %s 失败: %s", path, exc)
            self._libs[slot] = None
            return None
        self._libs[slot] = library
        return library

    def _corefoundation(self) -> Optional[ctypes.CDLL]:
        library = self._load_library("cf", _COREFOUNDATION)
        if library is None or "cf" in self._bound:
            return library
        try:
            library.CFStringCreateWithCString.argtypes = [
                ctypes.c_void_p,
                ctypes.c_char_p,
                ctypes.c_uint32,
            ]
            library.CFStringCreateWithCString.restype = ctypes.c_void_p
            library.CFRelease.argtypes = [ctypes.c_void_p]
            library.CFRelease.restype = None
        except AttributeError as exc:  # pragma: no cover - always present
            log.warning("CoreFoundation 缺少符号: %s", exc)
            self._libs["cf"] = None
            return None
        self._bound.add("cf")
        return library

    def _coregraphics(self) -> Optional[ctypes.CDLL]:
        library = self._load_library("cg", _COREGRAPHICS)
        if library is None or "cg" in self._bound:
            return library
        try:
            library.CGMainDisplayID.argtypes = []
            library.CGMainDisplayID.restype = ctypes.c_uint32
            library.CGGetOnlineDisplayList.argtypes = [
                ctypes.c_uint32,
                ctypes.POINTER(ctypes.c_uint32),
                ctypes.POINTER(ctypes.c_uint32),
            ]
            library.CGGetOnlineDisplayList.restype = ctypes.c_int32
            # boolean_t is unsigned int on Darwin, not C _Bool.
            library.CGDisplayIsBuiltin.argtypes = [ctypes.c_uint32]
            library.CGDisplayIsBuiltin.restype = ctypes.c_uint32
        except AttributeError as exc:  # pragma: no cover - always present
            log.warning("CoreGraphics 缺少符号: %s", exc)
            self._libs["cg"] = None
            return None
        self._bound.add("cg")
        return library

    def _iokit(self) -> Optional[ctypes.CDLL]:
        library = self._load_library("iokit", _IOKIT)
        if library is None or "iokit" in self._bound:
            return library
        try:
            library.IOServiceMatching.argtypes = [ctypes.c_char_p]
            library.IOServiceMatching.restype = ctypes.c_void_p
            library.IOServiceGetMatchingServices.argtypes = [
                ctypes.c_uint32,  # mach_port_t, 0 == kIOMasterPortDefault
                ctypes.c_void_p,  # CFDictionaryRef matching (consumed)
                ctypes.POINTER(ctypes.c_uint32),  # io_iterator_t *
            ]
            library.IOServiceGetMatchingServices.restype = ctypes.c_int
            library.IOIteratorNext.argtypes = [ctypes.c_uint32]
            library.IOIteratorNext.restype = ctypes.c_uint32
            library.IOObjectRelease.argtypes = [ctypes.c_uint32]
            library.IOObjectRelease.restype = ctypes.c_int
            library.IODisplayGetFloatParameter.argtypes = [
                ctypes.c_uint32,  # io_service_t
                ctypes.c_uint32,  # IOOptionBits
                ctypes.c_void_p,  # CFStringRef parameter
                ctypes.POINTER(ctypes.c_float),
            ]
            library.IODisplayGetFloatParameter.restype = ctypes.c_int
            library.IODisplaySetFloatParameter.argtypes = [
                ctypes.c_uint32,
                ctypes.c_uint32,
                ctypes.c_void_p,
                ctypes.c_float,
            ]
            library.IODisplaySetFloatParameter.restype = ctypes.c_int
        except AttributeError as exc:
            log.debug("IOKit 缺少 IODisplay* 符号: %s", exc)
            self._libs["iokit"] = None
            return None
        self._bound.add("iokit")
        return library

    def _display_services(self) -> Optional[ctypes.CDLL]:
        library = self._load_library("ds", _DISPLAY_SERVICES)
        if library is None or "ds" in self._bound:
            return library
        try:
            library.DisplayServicesGetBrightness.argtypes = [
                ctypes.c_uint32,  # CGDirectDisplayID
                ctypes.POINTER(ctypes.c_float),
            ]
            library.DisplayServicesGetBrightness.restype = ctypes.c_int
            library.DisplayServicesSetBrightness.argtypes = [
                ctypes.c_uint32,
                ctypes.c_float,
            ]
            library.DisplayServicesSetBrightness.restype = ctypes.c_int
        except AttributeError as exc:
            log.debug("DisplayServices 缺少符号（系统版本较旧?）: %s", exc)
            self._libs["ds"] = None
            return None
        self._bound.add("ds")
        return library

    def _core_display(self) -> Optional[ctypes.CDLL]:
        library = self._load_library("cd", _CORE_DISPLAY)
        if library is None or "cd" in self._bound:
            return library
        try:
            library.CoreDisplay_Display_GetUserBrightness.argtypes = [ctypes.c_uint32]
            library.CoreDisplay_Display_GetUserBrightness.restype = ctypes.c_double
            library.CoreDisplay_Display_SetUserBrightness.argtypes = [
                ctypes.c_uint32,
                ctypes.c_double,
            ]
            library.CoreDisplay_Display_SetUserBrightness.restype = None
        except AttributeError as exc:
            log.debug("CoreDisplay 缺少亮度 SPI: %s", exc)
            self._libs["cd"] = None
            return None
        self._bound.add("cd")
        return library

    # ------------------------------------------------- IOKit brightness key
    def _brightness_key(self) -> Optional[int]:
        """Create ``CFSTR("brightness")`` once (ctypes cannot expand CFSTR)."""
        if self._cf_key is not None:
            return self._cf_key
        corefoundation = self._corefoundation()
        if corefoundation is None:
            return None
        key = corefoundation.CFStringCreateWithCString(
            None, _IOKIT_BRIGHTNESS_KEY, _KCFSTRING_ENCODING_UTF8
        )
        if not key:  # pragma: no cover - only on OOM
            log.warning("CFStringCreateWithCString 失败")
            return None
        self._cf_key = int(key)
        return self._cf_key

    # ----------------------------------------------------------- displays
    def _online_displays(self) -> List[int]:
        coregraphics = self._coregraphics()
        if coregraphics is None:
            return []
        displays = (ctypes.c_uint32 * _MAX_DISPLAYS)()
        count = ctypes.c_uint32(0)
        try:
            error = coregraphics.CGGetOnlineDisplayList(
                _MAX_DISPLAYS, displays, ctypes.byref(count)
            )
        except Exception:  # noqa: BLE001 - ctypes call must not escape
            return []
        if error != 0:  # kCGErrorSuccess == 0
            log.debug("CGGetOnlineDisplayList 失败: %s", error)
            return []
        total = min(int(count.value), _MAX_DISPLAYS)
        return [int(displays[index]) for index in range(total)]

    def _target_display_id(self) -> Optional[int]:
        """Prefer the built-in panel, then the main display, then the first one.

        The built-in panel is the one whose brightness this tool is about; the
        "main" display may well be an external monitor (observed in the wild,
        e.g. nriley/brightness issue #38), and external displays usually do not
        expose controllable brightness through these APIs.
        """
        coregraphics = self._coregraphics()
        if coregraphics is None:
            return None
        displays = self._online_displays()
        for display in displays:
            try:
                if coregraphics.CGDisplayIsBuiltin(display):
                    return display
            except Exception:  # noqa: BLE001
                continue
        try:
            main = int(coregraphics.CGMainDisplayID())
        except Exception:  # noqa: BLE001
            main = 0
        if main:
            return main
        return displays[0] if displays else None

    # ------------------------------------------------------- IOKit services
    def _iokit_display_services(self) -> List[int]:
        """Enumerate ``IODisplayConnect`` services (caller releases them)."""
        library = self._iokit()
        if library is None:
            return []
        try:
            matching = library.IOServiceMatching(b"IODisplayConnect")
        except Exception:  # noqa: BLE001
            return []
        if not matching:
            return []
        iterator = ctypes.c_uint32(0)
        try:
            result = library.IOServiceGetMatchingServices(
                0, matching, ctypes.byref(iterator)
            )
        except Exception:  # noqa: BLE001
            return []
        if result != 0 or not iterator.value:
            return []
        services: List[int] = []
        try:
            while True:
                service = library.IOIteratorNext(iterator.value)
                if not service:
                    break
                services.append(int(service))
        finally:
            try:
                library.IOObjectRelease(iterator.value)
            except Exception:  # noqa: BLE001
                pass
        return services

    @staticmethod
    def _release_services(library: ctypes.CDLL, services: Sequence[int]) -> None:
        for service in services:
            try:
                library.IOObjectRelease(service)
            except Exception:  # noqa: BLE001
                pass

    def _read_via_iokit(self) -> Optional[float]:
        library = self._iokit()
        key = self._brightness_key()
        if library is None or key is None:
            return None
        services = self._iokit_display_services()
        if not services:
            log.debug("没有 IODisplayConnect 服务（Apple Silicon 上常见）")
            return None
        levels: List[float] = []
        try:
            for service in services:
                value = ctypes.c_float(0.0)
                try:
                    result = library.IODisplayGetFloatParameter(
                        service, 0, key, ctypes.byref(value)
                    )
                except Exception:  # noqa: BLE001
                    continue
                if result == 0 and _valid_level(value.value):
                    levels.append(float(value.value))
                else:
                    log.debug(
                        "IODisplayGetFloatParameter(0x%x) 返回 %s（%s）",
                        service,
                        result,
                        "kIOReturnUnsupported" if result == -536870201 else "失败",
                    )
        finally:
            self._release_services(library, services)
        if not levels:
            return None
        if len(levels) > 1:
            log.debug("IOKit 读到多个显示器亮度 %s，取第一个", levels)
        return levels[0]

    def _write_via_iokit(self, level: float) -> bool:
        library = self._iokit()
        key = self._brightness_key()
        if library is None or key is None:
            return False
        services = self._iokit_display_services()
        if not services:
            return False
        written = 0
        try:
            # Set *every* IODisplayConnect that accepts the parameter: the
            # built-in panel is what matters, but we cannot map a display ID to
            # a service without deprecated CGDisplayIOServicePort, and setting
            # all supported displays is harmless (external monitors normally
            # reject the call and are skipped).
            for service in services:
                try:
                    result = library.IODisplaySetFloatParameter(
                        service, 0, key, ctypes.c_float(level)
                    )
                except Exception:  # noqa: BLE001
                    continue
                if result == 0:
                    written += 1
                else:
                    log.debug(
                        "IODisplaySetFloatParameter(0x%x) 返回 %s", service, result
                    )
        finally:
            self._release_services(library, services)
        if written:
            log.debug("IOKit 设置亮度 %.3f: %d/%d 个服务成功", level, written, len(services))
        return written > 0

    # --------------------------------------------------- DisplayServices SPI
    def _read_via_display_services(self) -> Optional[float]:
        library = self._display_services()
        display = self._target_display_id()
        if library is None or display is None:
            return None
        value = ctypes.c_float(0.0)
        try:
            result = library.DisplayServicesGetBrightness(
                display, ctypes.byref(value)
            )
        except Exception:  # noqa: BLE001
            return None
        if result != 0 or not _valid_level(value.value):
            log.debug(
                "DisplayServicesGetBrightness(0x%x) 返回 %s", display, result
            )
            return None
        return float(value.value)

    def _write_via_display_services(self, level: float) -> bool:
        library = self._display_services()
        display = self._target_display_id()
        if library is None or display is None:
            return False
        try:
            result = library.DisplayServicesSetBrightness(
                display, ctypes.c_float(level)
            )
        except Exception:  # noqa: BLE001
            return False
        if result != 0:
            log.debug(
                "DisplayServicesSetBrightness(0x%x) 返回 %s", display, result
            )
            return False
        log.debug("DisplayServices 设置亮度 %.3f（display 0x%x）成功", level, display)
        return True

    # ----------------------------------------------------- CoreDisplay SPI
    def _read_via_core_display(self) -> Optional[float]:
        library = self._core_display()
        display = self._target_display_id()
        if library is None or display is None:
            return None
        try:
            level = float(library.CoreDisplay_Display_GetUserBrightness(display))
        except Exception:  # noqa: BLE001
            return None
        return level if _valid_level(level) else None

    def _write_via_core_display(self, level: float) -> bool:
        library = self._core_display()
        display = self._target_display_id()
        if library is None or display is None:
            return False
        try:
            library.CoreDisplay_Display_SetUserBrightness(display, ctypes.c_double(level))
        except Exception:  # noqa: BLE001
            return False
        current = self._read_via_core_display()
        if current is not None and abs(current - level) > _BRIGHTNESS_TOLERANCE:
            log.debug(
                "CoreDisplay 写入 %.3f 后读回 %.3f，判定未生效", level, current
            )
            return False
        log.debug("CoreDisplay 设置亮度 %.3f（display 0x%x）成功", level, display)
        return True

    # --------------------------------------------------------- CLI fallback
    def _brightness_cli(self) -> Optional[str]:
        """Locate the optional ``brightness`` CLI (never required)."""
        if self._cli_checked:
            return self._cli_path
        self._cli_checked = True
        candidates: List[str] = []
        found = shutil.which(_BRIGHTNESS_CLI)
        if found:
            candidates.append(found)
        for directory in _BRIGHTNESS_CLI_DIRS:
            candidates.append(os.path.join(directory, _BRIGHTNESS_CLI))
        for candidate in candidates:
            if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                self._cli_path = candidate
                log.debug("使用 brightness CLI 兜底: %s", candidate)
                return candidate
        return None

    @staticmethod
    def _parse_cli_list(output: str) -> List[Dict[str, object]]:
        """Parse ``brightness -l`` output.

        Expected shape (nriley/brightness)::

            display 0: main, active, awake, online, built-in, ID 0x1
            display 0: brightness 0.500000

        ``-l`` also prints the flag line, and a display whose brightness cannot
        be read prints an error on stderr instead.  The parser is tolerant about
        ordering and about a missing flag line.
        """
        entries: List[Dict[str, object]] = []
        current: Optional[Dict[str, object]] = None
        for line in output.splitlines():
            match = _CLI_DISPLAY_RE.match(line)
            if not match:
                continue
            rest = match.group(2).strip()
            brightness_match = _CLI_BRIGHTNESS_RE.search(rest)
            if brightness_match:
                if current is None:  # tolerate missing flag line
                    current = {"main": False, "builtin": False, "level": None}
                    entries.append(current)
                try:
                    level = float(brightness_match.group(1))
                except ValueError:  # pragma: no cover - regex guarantees a float
                    continue
                current["level"] = level if _valid_level(level) else None
            else:
                current = {
                    "main": "main" in rest,
                    "builtin": "built-in" in rest or "builtin" in rest,
                    "level": None,
                }
                entries.append(current)
        return entries

    def _read_via_cli(self) -> Optional[float]:
        cli = self._brightness_cli()
        if cli is None:
            return None
        try:
            process = subprocess.run(
                [cli, "-l"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=_SUBPROCESS_TIMEOUT,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            log.debug("brightness -l 执行失败: %s", exc)
            return None
        if process.returncode != 0:
            log.debug(
                "brightness -l 返回码 %s: %s",
                process.returncode,
                (process.stderr or "").strip()[:200],
            )
            return None
        entries = self._parse_cli_list(process.stdout or "")
        # Prefer the built-in panel, then the main display, then any readable one.
        for entry in entries:
            if entry["builtin"] and entry["level"] is not None:
                return float(entry["level"])  # type: ignore[arg-type]
        for entry in entries:
            if entry["main"] and entry["level"] is not None:
                return float(entry["level"])  # type: ignore[arg-type]
        for entry in entries:
            if entry["level"] is not None:
                return float(entry["level"])  # type: ignore[arg-type]
        log.debug("brightness -l 输出没有解析到亮度: %r", (process.stdout or "")[:200])
        return None

    def _write_via_cli(self, level: float) -> bool:
        cli = self._brightness_cli()
        if cli is None:
            return False
        try:
            process = subprocess.run(
                [cli, "%.4f" % level],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=_SUBPROCESS_TIMEOUT,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            log.debug("brightness CLI 执行失败: %s", exc)
            return False
        stderr = (process.stderr or "").strip()
        # The CLI exits 0 even when individual displays fail; errors go to stderr.
        if process.returncode != 0 or _CLI_FAILURE_RE.search(stderr):
            log.debug(
                "brightness CLI 设置失败 rc=%s stderr=%r",
                process.returncode,
                stderr[:300],
            )
            return False
        log.debug("brightness CLI 设置亮度 %.3f 成功", level)
        return True

    # ------------------------------------------------------ verification
    def _verify_level(self, level: float) -> Optional[bool]:
        """True = read-back matches, False = mismatch, None = cannot read.

        DisplayServices is preferred because it reports the *user* brightness
        that the public IOKit write is known to be overridden by on macOS
        10.12.4+ (Night Shift); IOKit read is the fallback on older systems.
        """
        for value in (
            self._read_via_display_services(),
            self._read_via_iokit(),
        ):
            if value is not None:
                return abs(value - level) <= _BRIGHTNESS_TOLERANCE
        return None

    # --------------------------------------------------------- public API
    def is_locked(self) -> Optional[bool]:
        """True=locked, False=unlocked, None=cannot tell.  Never raises."""
        try:
            if sys.platform != "darwin":
                self.last_error = "MacPlatform 只能在 macOS 上使用（当前 %s）" % sys.platform
                return None
            locked = self._locked_from_ioreg()
            if locked is not None:
                self.last_error = None
                return locked
            locked = self._locked_from_quartz()
            if locked is not None:
                self.last_error = None
                return locked
            self.last_error = "无法判断锁屏状态: %s; Quartz 兜底不可用" % (
                self._lock_reason or "未知原因"
            )
            log.debug(self.last_error)
            return None
        except Exception as exc:  # noqa: BLE001 - contract: never raise
            self.last_error = "锁屏检测异常: %r" % (exc,)
            log.exception("锁屏检测异常")
            return None

    def _locked_from_ioreg(self) -> Optional[bool]:
        """Parse ``ioreg -n Root -d1 -a`` -> IOConsoleUsers -> lock flag.

        Semantics chosen for a missing ``CGSSessionScreenIsLocked`` key: the
        session is treated as **unlocked**.  Evidence: when the screen is
        unlocked the key is normally absent from ``IOConsoleUsers`` (this is the
        convention several tools rely on), and if a future macOS stopped
        emitting the key we would rather miss a "dim while locked" opportunity
        than dim the screen while the user is actually using it -- the daemon's
        ``restore_on_unlock`` path still works.  Only a completely missing
        ``IOConsoleUsers`` (no GUI session / unparsable output) yields ``None``.
        """
        self._lock_reason = ""
        ioreg = _IOREG if os.path.exists(_IOREG) else (shutil.which("ioreg") or _IOREG)
        try:
            process = subprocess.run(
                [ioreg] + list(_IOREG_ARGS),
                capture_output=True,
                timeout=_SUBPROCESS_TIMEOUT,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            self._lock_reason = "ioreg 执行失败: %s" % exc
            log.debug(self._lock_reason)
            return None
        if process.returncode != 0:
            self._lock_reason = "ioreg 返回 %d: %s" % (
                process.returncode,
                _short_bytes(process.stderr),
            )
            log.debug(self._lock_reason)
            return None
        output = process.stdout or b""
        if not output.strip():
            self._lock_reason = "ioreg 没有输出"
            log.debug(self._lock_reason)
            return None
        try:
            payload = plistlib.loads(output)
        except Exception as exc:  # noqa: BLE001 - plistlib raises several types
            self._lock_reason = "ioreg XML plist 解析失败: %s" % exc
            log.debug(self._lock_reason)
            return None
        console_users = _find_plist_value(payload, "IOConsoleUsers")
        if console_users is None:
            self._lock_reason = "ioreg 输出中没有 IOConsoleUsers"
            log.debug(self._lock_reason)
            return None
        if isinstance(console_users, dict):
            console_users = [console_users]
        if not isinstance(console_users, list):
            self._lock_reason = "IOConsoleUsers 类型异常: %s" % type(console_users).__name__
            log.debug(self._lock_reason)
            return None
        entries = [item for item in console_users if isinstance(item, dict)]
        if not entries:
            self._lock_reason = "IOConsoleUsers 为空或格式异常"
            log.debug(self._lock_reason)
            return None
        # Fast user switching: prefer the session that is actually on console.
        on_console = [
            item
            for item in entries
            if _plist_bool(item.get("kCGSSessionOnConsoleKey")) is True
        ]
        candidates = on_console or entries
        saw_flag = False
        for item in candidates:
            flag = _plist_bool(item.get("CGSSessionScreenIsLocked"))
            if flag is None:
                continue
            saw_flag = True
            if flag:
                return True
        if saw_flag:
            return False
        # Key absent everywhere: see the docstring for the safety reasoning.
        log.debug("IOConsoleUsers 没有 CGSSessionScreenIsLocked，按未锁屏处理")
        return False

    def _locked_from_quartz(self) -> Optional[bool]:
        """Optional pyobjc fallback; ``CGSSessionScreenIsLocked`` is undocumented.

        ``CGSessionCopyCurrentDictionary()`` is a public CoreGraphics function,
        but the ``CGSSessionScreenIsLocked`` key is not one of the documented
        window-server session properties, and pyobjc is not a dependency of this
        project -- so this path is only a last resort when pyobjc happens to be
        installed.
        """
        try:
            import Quartz  # type: ignore[import-not-found]  # pyobjc, optional
        except Exception:  # noqa: BLE001 - ImportError and pyobjc bridge errors
            return None
        try:
            session = Quartz.CGSessionCopyCurrentDictionary()
            if session is None:
                return None
            try:
                raw = session.get("CGSSessionScreenIsLocked")
            except Exception:  # noqa: BLE001 - not a plain dict
                return None
            if raw is None:
                return False
            return bool(raw)
        except Exception as exc:  # noqa: BLE001
            log.debug("Quartz 锁屏查询失败: %s", exc)
            return None

    def get_brightness(self) -> Optional[int]:
        """Current brightness 0..100 or None.  Never raises."""
        try:
            if sys.platform != "darwin":
                self.last_error = "MacPlatform 只能在 macOS 上使用（当前 %s）" % sys.platform
                return None
            errors: List[str] = []
            readers: Sequence[Tuple[str, object]] = (
                ("IOKit", self._read_via_iokit),
                ("DisplayServices", self._read_via_display_services),
                ("CoreDisplay", self._read_via_core_display),
                ("brightness CLI", self._read_via_cli),
            )
            for name, reader in readers:
                try:
                    level = reader()  # type: ignore[operator]
                except Exception as exc:  # noqa: BLE001
                    errors.append("%s 异常: %r" % (name, exc))
                    continue
                if level is not None and _valid_level(level):
                    self.last_error = None
                    log.debug("亮度来源: %s (%.3f)", name, level)
                    return _to_percent(level)
                errors.append("%s 不可用" % name)
            self.last_error = "读取亮度失败: " + "; ".join(errors)
            log.debug(self.last_error)
            return None
        except Exception as exc:  # noqa: BLE001 - contract: never raise
            self.last_error = "读取亮度异常: %r" % (exc,)
            log.exception("读取亮度异常")
            return None

    def set_brightness(self, percent: int) -> bool:
        """Set the built-in display brightness (clamped).  Never raises."""
        try:
            if sys.platform != "darwin":
                self.last_error = "MacPlatform 只能在 macOS 上使用（当前 %s）" % sys.platform
                return False
            try:
                value = clamp_percent(percent)
            except (TypeError, ValueError):
                self.last_error = "亮度参数非法: %r" % (percent,)
                return False
            level = value / 100.0
            errors: List[str] = []

            # 1) Documented IOKit API (primary per spec).  On modern macOS the
            #    value can be silently overridden, hence the read-back check.
            try:
                if self._write_via_iokit(level):
                    verified = self._verify_level(level)
                    if verified is not False:
                        self.last_error = None
                        log.debug("通过 IOKit 设置亮度 %d%%", value)
                        return True
                    errors.append("IOKit 写入成功但读回不一致")
                    log.debug("IOKit 写入后读回不一致，尝试 DisplayServices")
                else:
                    errors.append("IOKit 无可用 IODisplayConnect")
            except Exception as exc:  # noqa: BLE001
                errors.append("IOKit 异常: %r" % (exc,))

            # 2) DisplayServices private SPI: the working path on Apple Silicon.
            try:
                if self._write_via_display_services(level):
                    self.last_error = None
                    log.debug("通过 DisplayServices 设置亮度 %d%%", value)
                    return True
                errors.append("DisplayServices 不可用")
            except Exception as exc:  # noqa: BLE001
                errors.append("DisplayServices 异常: %r" % (exc,))

            # 3) CoreDisplay SPI: Intel macOS 10.12.4+ where IOKit set is overridden.
            try:
                if self._write_via_core_display(level):
                    self.last_error = None
                    log.debug("通过 CoreDisplay 设置亮度 %d%%", value)
                    return True
                errors.append("CoreDisplay 不可用")
            except Exception as exc:  # noqa: BLE001
                errors.append("CoreDisplay 异常: %r" % (exc,))

            # 4) Optional brightness CLI.
            try:
                if self._write_via_cli(level):
                    self.last_error = None
                    log.debug("通过 brightness CLI 设置亮度 %d%%", value)
                    return True
                errors.append("brightness CLI 不可用或失败")
            except Exception as exc:  # noqa: BLE001
                errors.append("brightness CLI 异常: %r" % (exc,))

            self.last_error = "设置亮度 %d%% 失败: %s" % (value, "; ".join(errors))
            log.debug(self.last_error)
            return False
        except Exception as exc:  # noqa: BLE001 - contract: never raise
            self.last_error = "设置亮度异常: %r" % (exc,)
            log.exception("设置亮度异常")
            return False

    def close(self) -> None:
        """Release the cached CFString.  Safe to call more than once."""
        corefoundation = self._libs.get("cf")
        if corefoundation is not None and self._cf_key is not None:
            try:
                corefoundation.CFRelease(ctypes.c_void_p(self._cf_key))
            except Exception:  # noqa: BLE001
                pass
        self._cf_key = None
        for slot in list(self._libs):
            self._libs[slot] = None
        self._bound.clear()
        self._closed = True


# ------------------------------------------------------------ self check
def _self_check(argv: Sequence[str]) -> int:
    """Manual diagnostic: ``python3 -m lb.platform_mac [set <0-100>]``."""
    platform = MacPlatform()
    print("platform : %s (sys.platform=%s)" % (platform.name, sys.platform))
    locked = platform.is_locked()
    print("is_locked: %s  last_error=%r" % (locked, platform.last_error))
    brightness = platform.get_brightness()
    print("brightness: %s  last_error=%r" % (brightness, platform.last_error))
    exit_code = 0
    if len(argv) >= 2 and argv[0] == "set":
        try:
            percent = int(argv[1])
        except ValueError:
            print("用法: python3 -m lb.platform_mac [set <0-100>]", file=sys.stderr)
            platform.close()
            return 2
        ok = platform.set_brightness(percent)
        after = platform.get_brightness()
        print(
            "set_brightness(%d): %s  读回=%s  last_error=%r"
            % (percent, ok, after, platform.last_error)
        )
        exit_code = 0 if ok else 1
    platform.close()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(_self_check(sys.argv[1:]))
