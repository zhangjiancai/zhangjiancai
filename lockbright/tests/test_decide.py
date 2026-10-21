"""Unit tests for the pure decision function (no OS, no camera)."""
from __future__ import annotations

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lb.config import Config  # noqa: E402
from lb.decide import DIM, MORNING, RESTORE, State, decide, in_night_window  # noqa: E402


def at(hour: int, minute: int = 0, day: int = 21) -> datetime:
    return datetime(2026, 10, day, hour, minute, 0)


class NightWindowTests(unittest.TestCase):
    def test_default_window_crosses_midnight(self):
        start = datetime(2026, 10, 21, 20, 0).time()
        morning = datetime(2026, 10, 21, 7, 30).time()
        self.assertTrue(in_night_window(datetime(2026, 10, 21, 20, 0).time(), start, morning))
        self.assertTrue(in_night_window(datetime(2026, 10, 21, 23, 59).time(), start, morning))
        self.assertTrue(in_night_window(datetime(2026, 10, 21, 3, 0).time(), start, morning))
        self.assertFalse(in_night_window(datetime(2026, 10, 21, 7, 30).time(), start, morning))
        self.assertFalse(in_night_window(datetime(2026, 10, 21, 12, 0).time(), start, morning))
        self.assertFalse(in_night_window(datetime(2026, 10, 21, 19, 59).time(), start, morning))

    def test_same_day_window(self):
        start = datetime(2026, 10, 21, 1, 0).time()
        morning = datetime(2026, 10, 21, 8, 0).time()
        self.assertTrue(in_night_window(datetime(2026, 10, 21, 1, 0).time(), start, morning))
        self.assertTrue(in_night_window(datetime(2026, 10, 21, 7, 59).time(), start, morning))
        self.assertFalse(in_night_window(datetime(2026, 10, 21, 0, 59).time(), start, morning))
        self.assertFalse(in_night_window(datetime(2026, 10, 21, 8, 0).time(), start, morning))


class DecideTests(unittest.TestCase):
    def setUp(self):
        self.cfg = Config()

    def test_unlocked_does_nothing(self):
        state, actions = decide(self.cfg, State(), at(22), False, 5.0)
        self.assertEqual(actions, [])
        self.assertFalse(state.dimmed)
        self.assertEqual(state.dark_streak, 0)

    def test_locked_unknown_does_nothing(self):
        state, actions = decide(self.cfg, State(), at(22), None, 3.0)
        self.assertEqual(actions, [])
        self.assertEqual(state.dark_streak, 0)

    def test_daytime_locked_dark_does_not_dim(self):
        # morning catch-up already ran today, so only the daytime rule applies
        state = State(last_morning_date="2026-10-21")
        _, actions = decide(self.cfg, state, at(15), True, 3.0)
        self.assertEqual(actions, [])

    def test_dark_requires_confirmation(self):
        state1, actions1 = decide(self.cfg, State(), at(23), True, 3.0)
        self.assertEqual(actions1, [])
        self.assertEqual(state1.dark_streak, 1)
        self.assertFalse(state1.dimmed)

        state2, actions2 = decide(self.cfg, state1, at(23, 1), True, 3.0)
        self.assertEqual(len(actions2), 1)
        self.assertEqual(actions2[0].kind, DIM)
        self.assertEqual(actions2[0].target, self.cfg.dim_brightness)
        self.assertTrue(state2.dimmed)
        self.assertEqual(state2.dark_streak, 0)

    def test_bright_sample_resets_streak(self):
        state1, _ = decide(self.cfg, State(), at(23), True, 3.0)
        self.assertEqual(state1.dark_streak, 1)
        state2, actions = decide(self.cfg, state1, at(23, 1), True, 100.0)
        self.assertEqual(actions, [])
        self.assertEqual(state2.dark_streak, 0)

    def test_missing_luma_does_not_dim(self):
        state, actions = decide(self.cfg, State(), at(23), True, None)
        self.assertEqual(actions, [])
        self.assertEqual(state.dark_streak, 0)

    def test_failed_measurement_resets_previous_streak(self):
        state = State(dark_streak=1)
        new_state, actions = decide(self.cfg, state, at(23, 1), True, None)
        self.assertEqual(actions, [])
        self.assertEqual(new_state.dark_streak, 0)

    def test_lights_on_while_dimmed_restores(self):
        state = State(dimmed=True, baseline_brightness=70)
        new_state, actions = decide(self.cfg, state, at(23, 30), True, 60.0)
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, RESTORE)
        self.assertEqual(actions[0].target, 70)
        self.assertFalse(new_state.dimmed)
        self.assertIsNone(new_state.baseline_brightness)

    def test_still_dark_while_dimmed_keeps_state(self):
        state = State(dimmed=True, baseline_brightness=70)
        new_state, actions = decide(self.cfg, state, at(23, 30), True, 3.0)
        self.assertEqual(actions, [])
        self.assertTrue(new_state.dimmed)

    def test_unlock_restores_baseline(self):
        state = State(dimmed=True, baseline_brightness=65)
        new_state, actions = decide(self.cfg, state, at(23, 30), False, None)
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, RESTORE)
        self.assertEqual(actions[0].target, 65)
        self.assertFalse(new_state.dimmed)

    def test_unlock_without_restore_option_keeps_dimmed(self):
        cfg = Config(restore_on_unlock=False)
        state = State(dimmed=True, baseline_brightness=65)
        new_state, actions = decide(cfg, state, at(23, 30), False, None)
        self.assertEqual(actions, [])
        self.assertTrue(new_state.dimmed)

    def test_restore_uses_fallback_when_baseline_missing(self):
        state = State(dimmed=True, baseline_brightness=None)
        _, actions = decide(self.cfg, state, at(23, 30), False, None)
        self.assertEqual(actions[0].target, self.cfg.fallback_restore_brightness)

    def test_restore_does_not_use_dark_baseline(self):
        state = State(dimmed=True, baseline_brightness=0)
        _, actions = decide(self.cfg, state, at(23, 30), False, None)
        self.assertEqual(actions[0].target, self.cfg.fallback_restore_brightness)

    def test_leaving_night_window_restores(self):
        state = State(dimmed=True, baseline_brightness=80)
        # 07:30 is already outside the window but morning catch-up fires first
        new_state, actions = decide(self.cfg, state, at(7, 30), True, 3.0)
        self.assertEqual(actions[0].kind, MORNING)
        self.assertFalse(new_state.dimmed)

    def test_morning_catch_up_once_per_day(self):
        state, actions = decide(self.cfg, State(), at(7, 31), False, None)
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, MORNING)
        self.assertEqual(actions[0].target, self.cfg.morning_brightness)

        state2, actions2 = decide(self.cfg, state, at(7, 32), False, None)
        self.assertEqual(actions2, [])
        self.assertEqual(state2.last_morning_date, "2026-10-21")

    def test_morning_catch_up_clears_dim(self):
        state = State(dimmed=True, baseline_brightness=70)
        new_state, actions = decide(self.cfg, state, at(7, 31), False, None)
        self.assertEqual(actions[0].kind, MORNING)
        self.assertFalse(new_state.dimmed)
        self.assertIsNone(new_state.baseline_brightness)

    def test_morning_differs_after_midnight(self):
        state = State(last_morning_date="2026-10-20")
        new_state, actions = decide(self.cfg, state, at(8, 0, day=21), False, None)
        self.assertEqual(actions[0].kind, MORNING)
        self.assertEqual(new_state.last_morning_date, "2026-10-21")

    def test_morning_does_not_flash_at_night(self):
        # daemon restarted at 23:00 with stale last_morning_date: it must not
        # set max brightness in the middle of the night
        state = State(last_morning_date="2026-10-20")
        _, actions = decide(self.cfg, state, at(23, 0), True, 3.0)
        self.assertEqual(actions, [])

    def test_before_morning_time_nothing_happens(self):
        _, actions = decide(self.cfg, State(), at(7, 0), False, None)
        self.assertEqual(actions, [])

    def test_invalid_baseline_uses_fallback(self):
        state = State(dimmed=True, baseline_brightness=999)
        _, actions = decide(self.cfg, state, at(23, 30), False, None)
        self.assertEqual(actions[0].target, self.cfg.fallback_restore_brightness)


if __name__ == "__main__":
    unittest.main(verbosity=2)
