#!/usr/bin/env python3
"""Generate the Windows multi-resolution icon for Ymir installer and shortcuts."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "tools"))

try:
    from tray import create_tray_icon_image
except ImportError as exc:
    raise SystemExit(f"Failed to import create_tray_icon_image: {exc}")

TARGET = Path(__file__).resolve().parent / "icon.ico"
ICON_SIZES = [
    (16, 16),
    (24, 24),
    (32, 32),
    (48, 48),
    (64, 64),
    (128, 128),
    (256, 256),
]


def build_icon(target: Path = TARGET) -> Path:
    img = create_tray_icon_image(256)
    target.parent.mkdir(parents=True, exist_ok=True)
    img.save(target, format="ICO", sizes=ICON_SIZES)
    print(f"Rendered {target} ({target.stat().st_size} bytes)")
    return target


if __name__ == "__main__":
    build_icon()
