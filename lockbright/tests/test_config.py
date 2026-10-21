"""Unit tests for config parsing / validation / defaults file creation."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lb.config import (  # noqa: E402
    Config,
    ConfigError,
    load_config,
    parse_hhmm,
)


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "config.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_file_created(self):
        cfg, path = load_config(self.path)
        self.assertTrue(path.exists())
        self.assertEqual(cfg, Config())
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["check_interval_seconds"], 60)

    def test_load_partial_config(self):
        self.path.write_text(
            json.dumps({"dim_brightness": 5, "restore_on_unlock": "false"}),
            encoding="utf-8",
        )
        cfg, _ = load_config(self.path)
        self.assertEqual(cfg.dim_brightness, 5)
        self.assertFalse(cfg.restore_on_unlock)

    def test_unknown_keys_are_ignored(self):
        self.path.write_text(json.dumps({"future_option": 1}), encoding="utf-8")
        cfg, _ = load_config(self.path)
        self.assertEqual(cfg, Config())

    def test_invalid_json_raises(self):
        self.path.write_text("{oops", encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(self.path)

    def test_out_of_range_values_raise(self):
        for bad in ({"dim_brightness": 101}, {"check_interval_seconds": 0}, {"dark_luma_threshold": -1}):
            self.path.write_text(json.dumps(bad), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_config(self.path)

    def test_invalid_backend_raises(self):
        self.path.write_text(json.dumps({"camera_backend": "v4l2"}), encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(self.path)

    def test_invalid_time_raises(self):
        for bad in ("25:00", "7:60", "0730", "07:3x"):
            self.path.write_text(json.dumps({"morning_time": bad}), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_config(self.path)

    def test_cross_field_validation(self):
        bad_configs = (
            {"dark_luma_threshold": 50, "restore_luma_threshold": 40},
            {"morning_brightness": 0, "dim_brightness": 10},
            {"night_start": "20:00", "morning_time": "20:00"},
        )
        for bad in bad_configs:
            self.path.write_text(json.dumps(bad), encoding="utf-8")
            with self.assertRaises(ConfigError, msg=str(bad)):
                load_config(self.path)

    def test_parse_hhmm(self):
        self.assertEqual(parse_hhmm("00:00"), 0)
        self.assertEqual(parse_hhmm("07:30"), 450)
        self.assertEqual(parse_hhmm("23:59"), 1439)

    def test_from_dict_accepts_numeric_booleans(self):
        cfg = Config.from_dict({"restore_on_unlock": 0})
        self.assertFalse(cfg.restore_on_unlock)

    def test_missing_file_without_create_uses_defaults(self):
        cfg, path = load_config(self.path, create_if_missing=False)
        self.assertEqual(cfg, Config())
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
