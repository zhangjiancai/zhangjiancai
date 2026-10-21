"""Unit tests for the daemon loop with a fake platform and fake camera."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lb.camera import CameraError  # noqa: E402
from lb.config import Config  # noqa: E402
from lb.daemon import Daemon  # noqa: E402
from lb.decide import State  # noqa: E402
from lb.platform_base import Platform  # noqa: E402


class FakePlatform(Platform):
    name = "fake"

    def __init__(self, brightness: int = 100, locked: bool = False, fail_set: bool = False):
        super().__init__()
        self.brightness = brightness
        self.locked = locked
        self.fail_set = fail_set
        self.set_calls = []

    def is_locked(self):
        return self.locked

    def get_brightness(self):
        return self.brightness

    def set_brightness(self, percent):
        if self.fail_set:
            self.last_error = "fake set failure"
            return False
        self.brightness = percent
        self.set_calls.append(percent)
        return True


def at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, 21, hour, minute, 0)


class DaemonTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state_file = Path(self.tmp.name) / "state.json"
        self.cfg = Config()
        self.now = at(23, 0)

    def tearDown(self):
        self.tmp.cleanup()

    def make_daemon(self, platform: FakePlatform, luma_sequence, clock=None):
        sequence = list(luma_sequence)

        def luma_fn():
            if not sequence:
                raise AssertionError("unexpected camera measurement")
            return sequence.pop(0)

        return Daemon(
            self.cfg,
            platform,
            now_fn=clock or (lambda: self.now),
            luma_fn=luma_fn,
            state_file=self.state_file,
        )

    def test_dims_after_confirmation_and_restores_on_light(self):
        platform = FakePlatform(brightness=100, locked=True)
        daemon = self.make_daemon(platform, [3.0, 3.0, 60.0])
        actions1, state1 = daemon.tick()
        self.assertEqual(actions1, [])
        self.assertEqual(state1.dark_streak, 1)

        actions2, state2 = daemon.tick()
        self.assertEqual(len(actions2), 1)
        self.assertEqual(platform.brightness, 0)
        self.assertTrue(state2.dimmed)
        self.assertEqual(state2.baseline_brightness, 100)

        saved = json.loads(self.state_file.read_text(encoding="utf-8"))
        self.assertTrue(saved["dimmed"])
        self.assertEqual(saved["baseline_brightness"], 100)

        actions3, state3 = daemon.tick()
        self.assertEqual(len(actions3), 1)
        self.assertEqual(platform.brightness, 100)
        self.assertFalse(state3.dimmed)

    def test_remote_session_counts_as_locked(self):
        class RemotePlatform(FakePlatform):
            def is_remote_session(self):
                return True

        platform = RemotePlatform(brightness=100, locked=False)
        daemon = self.make_daemon(platform, [3.0, 3.0])
        daemon.tick()
        actions, state = daemon.tick()
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, "dim")
        self.assertEqual(platform.brightness, 0)
        self.assertTrue(state.dimmed)

    def test_remote_not_locked_when_disabled(self):
        class RemotePlatform(FakePlatform):
            def is_remote_session(self):
                return True

        self.cfg = Config(treat_remote_as_locked=False)
        platform = RemotePlatform(brightness=100, locked=False)
        daemon = self.make_daemon(platform, [])
        actions, _ = daemon.tick()
        self.assertEqual(actions, [])
        self.assertEqual(platform.set_calls, [])

    def test_dim_failure_keeps_state_and_retries(self):
        platform = FakePlatform(brightness=100, locked=True, fail_set=True)
        daemon = self.make_daemon(platform, [3.0, 3.0])
        daemon.tick()
        actions, state = daemon.tick()
        self.assertEqual(len(actions), 1)
        self.assertFalse(state.dimmed)
        self.assertEqual(platform.brightness, 100)
        self.assertEqual(
            json.loads(self.state_file.read_text(encoding="utf-8"))["dimmed"], False
        )

    def test_unlock_restores_saved_baseline(self):
        self.state_file.write_text(
            json.dumps(
                {
                    "dimmed": True,
                    "baseline_brightness": 60,
                    "last_morning_date": None,
                    "dark_streak": 0,
                }
            ),
            encoding="utf-8",
        )
        platform = FakePlatform(brightness=0, locked=False)
        daemon = self.make_daemon(platform, [])
        actions, state = daemon.tick()
        self.assertEqual(len(actions), 1)
        self.assertEqual(platform.brightness, 60)
        self.assertFalse(state.dimmed)

    def test_morning_sets_max_without_camera(self):
        platform = FakePlatform(brightness=20, locked=False)
        daemon = self.make_daemon(platform, [])
        self.now = at(7, 31)
        actions, state = daemon.tick()
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, "morning")
        self.assertEqual(platform.brightness, 100)
        self.assertEqual(state.last_morning_date, "2026-10-21")
        self.assertTrue(self.state_file.exists())

    def test_dim_abandoned_when_unlocked_before_write(self):
        """Measuring takes seconds; a lock->unlock race must not dim."""

        class FlipPlatform(FakePlatform):
            def __init__(self):
                super().__init__(brightness=100, locked=True)
                self.lock_calls = 0

            def is_locked(self):
                self.lock_calls += 1
                # tick1: True; tick2: True (tick) then False (recheck)
                return self.lock_calls < 3

        platform = FlipPlatform()
        daemon = self.make_daemon(platform, [3.0, 3.0])
        daemon.tick()
        actions, state = daemon.tick()
        self.assertEqual(actions, [])
        self.assertFalse(state.dimmed)
        self.assertEqual(platform.set_calls, [])
        self.assertEqual(platform.brightness, 100)

    def test_inactive_session_skips_everything(self):
        class InactivePlatform(FakePlatform):
            def is_session_active(self):
                return False

        platform = InactivePlatform(brightness=100, locked=True)
        daemon = Daemon(
            self.cfg,
            platform,
            now_fn=lambda: self.now,
            luma_fn=lambda: 3.0,
            state_file=self.state_file,
        )
        for _ in range(3):
            actions, state = daemon.tick()
            self.assertEqual(actions, [])
            self.assertFalse(state.dimmed)
        self.assertEqual(platform.set_calls, [])

    def test_camera_failure_does_not_crash(self):
        def failing_luma():
            raise CameraError("test camera failure")

        platform = FakePlatform(brightness=100, locked=True)
        daemon = Daemon(
            self.cfg,
            platform,
            now_fn=lambda: self.now,
            luma_fn=failing_luma,
            state_file=self.state_file,
        )
        actions, state = daemon.tick()
        self.assertEqual(actions, [])
        self.assertFalse(state.dimmed)
        self.assertEqual(platform.set_calls, [])

    def test_dry_run_does_not_touch_brightness_or_state(self):
        platform = FakePlatform(brightness=100, locked=True)
        daemon = Daemon(
            self.cfg,
            platform,
            now_fn=lambda: self.now,
            luma_fn=lambda: 3.0,
            state_file=self.state_file,
            dry_run=True,
        )
        daemon.tick()
        daemon.tick()
        self.assertEqual(platform.set_calls, [])
        self.assertFalse(self.state_file.exists())

    def test_state_roundtrip(self):
        state = State(
            dimmed=True,
            baseline_brightness=42,
            last_morning_date="2026-10-20",
            dark_streak=2,
        )
        self.state_file.write_text(
            json.dumps(state.to_dict()), encoding="utf-8"
        )
        daemon = self.make_daemon(FakePlatform(), [])
        self.assertEqual(daemon.state.to_dict(), state.to_dict())

    def test_corrupt_state_file_resets(self):
        self.state_file.write_text("{not json", encoding="utf-8")
        daemon = self.make_daemon(FakePlatform(), [])
        self.assertEqual(daemon.state.to_dict(), State().to_dict())


if __name__ == "__main__":
    unittest.main(verbosity=2)
