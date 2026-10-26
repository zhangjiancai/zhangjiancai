#!/usr/bin/env python3
"""Windows watchdog for LockBright.

Runs from the ``LockBrightWatchdog`` scheduled task every 2 minutes (hidden
``pythonw``, interactive token).  If the LockBright scheduled task is not
running and no daemon process exists, it starts the task again.

Why this exists: Task Scheduler's "restart on failure" does not reliably cover
externally-terminated processes, and after an RDP/console session switch the
old daemon used to block the new logon instance.  The daemon's own task now
uses ``MultipleInstancesPolicy=StopExisting``; this watchdog is the second line
of defence for crashes/kills.

It never starts a second copy while one is running, and it only writes a line
to ``~/.lockbright/watchdog.log`` when it actually restarts the daemon.
"""
from __future__ import annotations

import datetime
import os
import subprocess
import sys

CREATE_NO_WINDOW = 0x08000000
TASK_NAME = "LockBright"


def _creation_flags() -> int:
    return CREATE_NO_WINDOW if sys.platform.startswith("win") else 0


def _run(cmd: list[str], timeout: int = 25) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=_creation_flags(),
    )


def _find_powershell() -> str | None:
    import shutil

    return shutil.which("powershell.exe") or shutil.which("powershell")


def _log(app_dir: str, message: str) -> None:
    try:
        log_dir = os.path.join(os.path.expanduser("~"), ".lockbright")
        os.makedirs(log_dir, exist_ok=True)
        path = os.path.join(log_dir, "watchdog.log")
        stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("%s watchdog: %s\n" % (stamp, message))
    except OSError:
        pass


def main(argv: list[str] | None = None) -> int:
    if not sys.platform.startswith("win"):
        return 0
    app_dir = os.path.dirname(os.path.abspath(__file__))
    run_py = os.path.join(app_dir, "run.py")
    powershell = _find_powershell()
    if not powershell:
        _log(app_dir, "powershell.exe not found; cannot check")
        return 1

    # One PowerShell call: how many daemons are running + task state.
    escaped_run_py = run_py.replace("'", "''")
    script = (
        "$p=@(Get-CimInstance Win32_Process "
        "-Filter \"Name='pythonw.exe' OR Name='python.exe'\" -ErrorAction SilentlyContinue | "
        "Where-Object { $_.CommandLine -and $_.CommandLine.Contains('%s') });"
        "Write-Output ('PROC=' + $p.Count);"
        "$t=Get-ScheduledTask -TaskName '%s' -ErrorAction SilentlyContinue;"
        "if($t){ Write-Output ('STATE=' + [string]$t.State) } else { Write-Output 'STATE=MISSING' }"
    ) % (escaped_run_py, TASK_NAME)
    try:
        proc = _run(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ]
        )
    except (OSError, subprocess.SubprocessError) as exc:
        _log(app_dir, "probe failed: %s" % exc)
        return 1
    proc_count = -1
    state = ""
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("PROC="):
            try:
                proc_count = int(line[5:])
            except ValueError:
                proc_count = -1
        elif line.startswith("STATE="):
            state = line[6:].strip()
    if proc_count > 0:
        return 0  # daemon alive, nothing to do
    if state == "Running":
        return 0  # scheduler says it is starting/running; do not double-start
    if proc_count < 0:
        _log(app_dir, "cannot count daemon processes (state=%s); skip" % (state or "?"))
        return 1

    # Daemon is missing: start the scheduled task (not python directly, so the
    # task owns/restarts the process tree).
    try:
        started = _run(["schtasks.exe", "/Run", "/TN", TASK_NAME], timeout=20)
    except (OSError, subprocess.SubprocessError) as exc:
        _log(app_dir, "schtasks /Run failed: %s" % exc)
        return 1
    detail = (started.stderr or started.stdout or "").strip()
    if started.returncode == 0:
        _log(app_dir, "LockBright was not running (state=%s); task start requested" % (state or "?"))
        return 0
    _log(
        app_dir,
        "starting LockBright failed (rc=%s, state=%s): %s"
        % (started.returncode, state or "?", detail[:300]),
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
