"""Camera luminance measurement (OpenCV).

Why manual exposure: webcam auto-exposure normalizes a dark room to a
surprisingly bright image (on the test machine the same dark room read
~70..85 mean while a fixed short exposure read ~0..9), which makes absolute
darkness thresholds useless.  When the platform allows it we lock a short
manual exposure for the burst, take the brightest frame, then restore auto
exposure so normal camera apps keep working.

Some drivers refuse manual exposure; then we fall back to auto exposure and
the configured thresholds have to be calibrated by the user (`probe` shows
both values).
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger(__name__)

CREATE_NO_WINDOW = 0x08000000

_BACKEND_ATTRS = {
    "dshow": "CAP_DSHOW",
    "msmf": "CAP_MSMF",
    "avfoundation": "CAP_AVFOUNDATION",
    "any": "CAP_ANY",
}

# Fallback order after the preferred backend fails to open the device.
_FALLBACKS = {
    "dshow": ["dshow", "msmf", "any"],
    "msmf": ["msmf", "dshow", "any"],
    "avfoundation": ["avfoundation", "any"],
    "any": ["any"],
}

_WARNED_MANUAL = False


class CameraError(RuntimeError):
    """Camera could not be opened or produced no frame."""


def _cv2():
    try:
        import cv2  # noqa: PLC0415 - lazy import keeps config/decide importable without OpenCV
    except ImportError as exc:  # pragma: no cover - depends on local install
        raise CameraError("opencv-python 未安装（pip install opencv-python）: %s" % exc) from exc
    return cv2


def default_backend() -> str:
    if sys.platform.startswith("win"):
        return "dshow"
    if sys.platform == "darwin":
        return "avfoundation"
    return "any"


def resolve_backend(name: Optional[str]) -> str:
    value = (name or "auto").strip().lower()
    if value == "auto":
        value = default_backend()
    if value not in _BACKEND_ATTRS:
        raise CameraError("不支持的摄像头后端: %r" % (name,))
    return value


def _open_capture(index: int, backend: str):
    cv2 = _cv2()
    errors: List[str] = []
    for candidate in _FALLBACKS.get(backend, [backend, "any"]):
        code = getattr(cv2, _BACKEND_ATTRS[candidate], None)
        if code is None:
            continue
        cap = cv2.VideoCapture(int(index), code)
        if cap.isOpened():
            try:
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            except Exception:  # noqa: BLE001 - property writes are best-effort
                pass
            return cap, candidate
        cap.release()
        errors.append(candidate)
    raise CameraError(
        "摄像头 index=%s 打不开（尝试后端: %s）" % (index, ", ".join(errors) or backend)
    )


def _manual_exposure_values() -> Tuple[float, float]:
    """(manual_flag, auto_flag) for CAP_PROP_AUTO_EXPOSURE on this platform."""
    if sys.platform.startswith("win"):
        # DirectShow/UVC: 0.25 = manual, 1.0 = auto (verified on the test machine)
        return 0.25, 1.0
    if sys.platform == "darwin":
        # AVFoundation exposureMode: 0 = locked, 1 = auto, 2 = continuous
        return 0.0, 1.0
    # V4L2: 1 = manual, 3 = auto
    return 1.0, 3.0


def _enable_manual_exposure(cv2, cap, exposure: float) -> bool:
    manual_flag, _auto_flag = _manual_exposure_values()
    try:
        ok_auto = bool(cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, manual_flag))
        ok_exp = bool(cap.set(cv2.CAP_PROP_EXPOSURE, float(exposure)))
        return bool(ok_auto and ok_exp)
    except Exception:  # noqa: BLE001 - unsupported properties must not crash
        return False


def _restore_auto_exposure(cv2, cap) -> bool:
    _manual_flag, auto_flag = _manual_exposure_values()
    try:
        return bool(cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, auto_flag))
    except Exception:  # noqa: BLE001
        return False


def _capture_burst(cv2, cap, samples: int, warmup: int, deadline: float) -> Tuple[float, Any]:
    """Discard warm-up frames, then return (brightest mean luma, last frame)."""
    started = time.monotonic()
    for _ in range(max(0, int(warmup))):
        cap.read()
        if time.monotonic() - started > deadline:
            break
    frame_means: List[float] = []
    last_frame = None
    attempts = 0
    while len(frame_means) < max(1, int(samples)):
        if time.monotonic() - started > deadline:
            break
        ok, frame = cap.read()
        if not ok or frame is None:
            attempts += 1
            if attempts >= 25:
                break
            time.sleep(0.05)
            continue
        last_frame = frame
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        frame_means.append(float(gray.mean()))
        time.sleep(0.05)
    if not frame_means:
        raise CameraError("摄像头没有读到画面")
    return round(max(frame_means), 1), last_frame


def measure_luma(
    index: int,
    *,
    samples: int = 5,
    warmup: int = 3,
    backend: str = "auto",
    manual_exposure: Optional[float] = None,
    timeout_seconds: float = 15.0,
) -> float:
    """Measure ambient luminance 0..255 for one camera index.

    Returns the brightest frame mean of the burst (conservative: one dark frame
    can never fake darkness).  When ``manual_exposure`` is set, the camera is
    switched to that fixed exposure for the burst and auto exposure is
    restored afterwards.  Raises :class:`CameraError` when no frame arrives.
    """
    global _WARNED_MANUAL
    cv2 = _cv2()
    backend = resolve_backend(backend)
    started = time.monotonic()
    cap, used_backend = _open_capture(index, backend)
    manual_ok = None
    try:
        if manual_exposure is not None:
            manual_ok = _enable_manual_exposure(cv2, cap, manual_exposure)
            if not manual_ok and not _WARNED_MANUAL:
                _WARNED_MANUAL = True
                log.warning(
                    "摄像头不支持手动曝光（index=%s backend=%s），回退自动曝光；"
                    "暗/亮阈值需要按 probe 的实测值调整",
                    index,
                    used_backend,
                )
            # after an exposure change, let the sensor settle
            time.sleep(0.25)
            for _ in range(2):
                cap.read()
                time.sleep(0.05)
        luma, _frame = _capture_burst(cv2, cap, samples, warmup, timeout_seconds)
        log.debug(
            "摄像头 index=%s 后端=%s 手动曝光=%s 亮度=%.1f 用时=%.1fs",
            index,
            used_backend,
            manual_exposure if manual_ok else "auto",
            luma,
            time.monotonic() - started,
        )
        return luma
    except CameraError:
        raise
    except Exception as exc:  # noqa: BLE001 - normalize driver errors
        raise CameraError("摄像头 index=%s 测光异常: %s" % (index, exc)) from exc
    finally:
        if manual_exposure is not None:
            if not _restore_auto_exposure(cv2, cap):
                # Driver accepted manual mode but refuses to go back: warn loudly,
                # otherwise the user's next video call could be black.
                log.warning(
                    "摄像头 index=%s 恢复自动曝光失败（下次测光会再试）", index
                )
                time.sleep(0.1)
                _restore_auto_exposure(cv2, cap)
        try:
            cap.release()
        except Exception:  # noqa: BLE001
            pass


def probe_cameras(
    max_index: int = 4,
    *,
    samples: int = 5,
    warmup: int = 3,
    backend: str = "auto",
    manual_exposure: Optional[float] = None,
    save_dir: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """Try each camera index: auto-exposure luma + manual-exposure luma + jpgs."""
    global _WARNED_MANUAL
    cv2 = _cv2()
    backend = resolve_backend(backend)
    if save_dir is not None:
        save_dir = Path(save_dir)
        save_dir.mkdir(parents=True, exist_ok=True)
    results: List[Dict[str, Any]] = []
    for index in range(int(max_index) + 1):
        entry: Dict[str, Any] = {
            "index": index,
            "backend": backend,
            "opened": False,
            "auto_luma": None,
            "manual_luma": None,
            "manual_ok": None,
            "channels": None,
            "size": None,
            "saved_auto": None,
            "saved_manual": None,
            "error": None,
            "seconds": None,
        }
        started = time.monotonic()
        cap = None
        try:
            cap, used = _open_capture(index, backend)
            entry["backend"] = used
            entry["opened"] = True
            time.sleep(0.4)
            for _ in range(max(0, int(warmup))):
                cap.read()
            auto_luma, auto_frame = _capture_burst(cv2, cap, samples, 0, 15.0)
            entry["auto_luma"] = auto_luma
            if auto_frame is not None:
                height, width = auto_frame.shape[:2]
                entry["size"] = [int(width), int(height)]
                entry["channels"] = [
                    round(float(auto_frame[..., c].mean()), 1) for c in range(3)
                ]
                if save_dir is not None:
                    out = save_dir / ("camera-%d-auto.jpg" % index)
                    if cv2.imwrite(str(out), auto_frame):
                        entry["saved_auto"] = str(out)
            if manual_exposure is not None:
                entry["manual_ok"] = _enable_manual_exposure(cv2, cap, manual_exposure)
                if not entry["manual_ok"] and not _WARNED_MANUAL:
                    _WARNED_MANUAL = True
                    log.warning("摄像头 index=%s 不支持手动曝光，回退自动曝光", index)
                if entry["manual_ok"]:
                    time.sleep(0.3)
                    for _ in range(2):
                        cap.read()
                    manual_luma, manual_frame = _capture_burst(cv2, cap, samples, 0, 15.0)
                    entry["manual_luma"] = manual_luma
                    if manual_frame is not None and save_dir is not None:
                        out = save_dir / ("camera-%d-manual.jpg" % index)
                        if cv2.imwrite(str(out), manual_frame):
                            entry["saved_manual"] = str(out)
                _restore_auto_exposure(cv2, cap)
        except CameraError as exc:
            entry["error"] = str(exc)
        except Exception as exc:  # noqa: BLE001 - probing must never crash the CLI
            entry["error"] = "%s: %s" % (type(exc).__name__, exc)
        finally:
            if manual_exposure is not None and cap is not None:
                _restore_auto_exposure(cv2, cap)
            if cap is not None:
                try:
                    cap.release()
                except Exception:  # noqa: BLE001
                    pass
        entry["seconds"] = round(time.monotonic() - started, 2)
        results.append(entry)
    return results


# --------------------------------------------------------------- device names
# OpenCV cannot open a DirectShow device by name (verified), but its CAP_DSHOW
# indices follow ICreateDevEnum order.  This tiny PowerShell helper enumerates
# that same order with friendly names so we can show "index 1 = Integrated
# Camera" and let the user pick by name instead of guessing.
_PS_ENUM_DEVICES = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICreateDevEnum {
    [PreserveSig] int CreateClassEnumerator([In] ref Guid pType, out IEnumMoniker ppEnumMoniker, int dwFlags);
}

[ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyBag {
    [PreserveSig] int Read([MarshalAs(UnmanagedType.LPWStr)] string pszPropName, [MarshalAs(UnmanagedType.Struct)] out object pVar, IntPtr pErrorLog);
    [PreserveSig] int Write([MarshalAs(UnmanagedType.LPWStr)] string pszPropName, [MarshalAs(UnmanagedType.Struct)] ref object pVar);
}

public class LockBrightDevices {
    public static string[] List(string categoryClsid, out string diag) {
        diag = "";
        var list = new System.Collections.Generic.List<string>();
        try {
            var clsid = new Guid(categoryClsid);
            var type = Type.GetTypeFromCLSID(new Guid("62BE5D10-60EB-11d0-BD3B-00A0C911CE86"));
            var devEnum = (ICreateDevEnum)Activator.CreateInstance(type);
            IEnumMoniker enumMoniker;
            int hr = devEnum.CreateClassEnumerator(ref clsid, out enumMoniker, 0);
            if (hr != 0 || enumMoniker == null) { diag = "CreateClassEnumerator hr=0x" + hr.ToString("X8"); return list.ToArray(); }
            var monikers = new IMoniker[1];
            while (enumMoniker.Next(1, monikers, IntPtr.Zero) == 0) {
                string name = "";
                try {
                    var bag = monikers[0] as IPropertyBag;
                    if (bag != null) {
                        object v;
                        if (bag.Read("FriendlyName", out v, IntPtr.Zero) == 0 && v != null) name = v.ToString();
                    }
                } catch { }
                if (name.Length == 0) name = "<no name>";
                list.Add(name);
            }
        } catch (Exception e) { diag = "exception: " + e.Message; }
        return list.ToArray();
    }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$diag = ''
$items = [LockBrightDevices]::List('{860BB310-5D01-11d0-BD3B-00A0C911CE86}', [ref]$diag)
if ($items.Count -eq 0) {
    Write-Output ('ERR|' + $diag)
} else {
    foreach ($it in $items) { Write-Output ('CAM|' + $it) }
}
"""


def _parse_ps_camera_output(text: str) -> List[str]:
    """Parse ``CAM|name`` lines from _PS_ENUM_DEVICES (pure, unit tested)."""
    names: List[str] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if line.startswith("CAM|"):
            name = line[4:].strip()
            if name:
                names.append(name)
    return names


def enumerate_camera_names() -> List[str]:
    """DirectShow camera names in CAP_DSHOW index order (Windows only).

    Returns [] on other platforms or when the enumeration fails.  Never raises.
    """
    if not sys.platform.startswith("win"):
        return []
    exe = shutil.which("powershell.exe") or shutil.which("powershell")
    if not exe:
        return []
    try:
        proc = subprocess.run(
            [
                exe,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                _PS_ENUM_DEVICES,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.debug("枚举摄像头名称失败: %s", exc)
        return []
    if proc.returncode != 0:
        log.debug("枚举摄像头名称失败(rc=%s): %s", proc.returncode, (proc.stderr or "")[:300])
        return []
    names = _parse_ps_camera_output(proc.stdout or "")
    log.debug("枚举到摄像头: %s", names)
    return names


def camera_name_map() -> Dict[int, str]:
    return {index: name for index, name in enumerate(enumerate_camera_names())}


def find_camera_by_name(fragment: str) -> Optional[Tuple[int, str]]:
    """Return (index, full name) for the first DirectShow name containing fragment."""
    wanted = (fragment or "").strip().lower()
    if not wanted:
        return None
    for index, name in enumerate(enumerate_camera_names()):
        if wanted in name.lower():
            return index, name
    return None


def open_camera(index: int, backend: str = "auto"):
    """Open a camera for interactive preview; caller must release it."""
    backend = resolve_backend(backend)
    return _open_capture(index, backend)

