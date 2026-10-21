"""Unit tests for camera-name parsing / selection helpers (no camera opened)."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lb.camera import _parse_ps_camera_output  # noqa: E402
from lb.config import Config, load_config, save_config  # noqa: E402


class CameraNameParseTests(unittest.TestCase):
    def test_parses_cam_lines_in_order(self):
        output = (
            "CAM|Integrated Webcam\n"
            "some Add-Type noise\n"
            "CAM|Integrated Camera\n"
            "CAM|ToDesk Camera\n"
            "ERR|\n"
        )
        self.assertEqual(
            _parse_ps_camera_output(output),
            ["Integrated Webcam", "Integrated Camera", "ToDesk Camera"],
        )

    def test_empty_or_error_output(self):
        self.assertEqual(_parse_ps_camera_output(""), [])
        self.assertEqual(_parse_ps_camera_output("ERR|exception: boom"), [])
        self.assertEqual(_parse_ps_camera_output("CAM|\nCAM|   \n"), [])

    def test_strips_whitespace(self):
        self.assertEqual(_parse_ps_camera_output("  CAM| Foo Bar  \n"), ["Foo Bar"])


class CameraSelectionConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "config.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_camera_name_loaded(self):
        self.path.write_text('{"camera_name": "Integrated Webcam"}', encoding="utf-8")
        cfg, _ = load_config(self.path)
        self.assertEqual(cfg.camera_name, "Integrated Webcam")

    def test_empty_camera_name_becomes_none(self):
        self.path.write_text('{"camera_name": "   "}', encoding="utf-8")
        cfg, _ = load_config(self.path)
        self.assertIsNone(cfg.camera_name)

    def test_null_camera_name(self):
        self.path.write_text('{"camera_name": null}', encoding="utf-8")
        cfg, _ = load_config(self.path)
        self.assertIsNone(cfg.camera_name)

    def test_save_config_roundtrip(self):
        cfg = Config(camera_index=2, camera_name="Integrated Camera", morning_time="06:45")
        saved = save_config(cfg, self.path)
        self.assertEqual(saved, self.path)
        loaded, _ = load_config(self.path)
        self.assertEqual(loaded, cfg)

    def test_save_config_preserves_other_fields(self):
        cfg = Config(camera_index=1, camera_name=None, dim_brightness=5)
        save_config(cfg, self.path)
        loaded, _ = load_config(self.path)
        self.assertEqual(loaded.dim_brightness, 5)
        self.assertEqual(loaded.camera_index, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
