#!/usr/bin/env python3
"""System tray application and server launcher for Ymir.

Runs the Ymir asset server (Node.js tools/serve.mjs) with a configurable library
directory, provides a Cinnamon-compatible GTK tray icon on Linux, opens the web
browser, and offers library folder browsing and clean shutdown.
"""

from __future__ import annotations

import argparse
import errno
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

# Paths
TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
SERVE_SCRIPT = TOOLS_DIR / "serve.mjs"
VENDOR_DIR = REPO_ROOT / "vendor"

# Fallback path candidates for vendored dependencies
for candidate in [
    VENDOR_DIR,
    REPO_ROOT.parent / "samplepack" / "vendor",
    REPO_ROOT.parent / "samplepack" / ".venv" / "lib" / "python3.12" / "site-packages",
]:
    if candidate.is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

_IS_WINDOWS = sys.platform == "win32"
if not _IS_WINDOWS and "PYSTRAY_BACKEND" not in os.environ:
    os.environ["PYSTRAY_BACKEND"] = "gtk"

APP_TITLE = "Ymir"
DEFAULT_PORT = 4174


def _install_gtk_popup_patch(icon_class) -> bool:
    """Pass GTK's popup-menu button and timestamp through to Gtk.Menu.popup on Cinnamon."""
    if getattr(icon_class, "__module__", "") != "pystray._gtk":
        return False
    original_popup = getattr(icon_class, "_on_status_icon_popup_menu", None)
    if original_popup is None or getattr(icon_class, "_ymir_gtk_popup_patch", False):
        return False
    gtk = original_popup.__globals__.get("Gtk")
    if gtk is None:
        return False

    def _on_status_icon_popup_menu(icon, _status_icon, button, activate_time):
        if icon._menu_handle:
            icon._menu_handle.popup(
                None,
                None,
                gtk.StatusIcon.position_menu,
                icon._status_icon,
                button,
                activate_time,
            )

    icon_class._on_status_icon_popup_menu = _on_status_icon_popup_menu
    icon_class._ymir_gtk_popup_patch = True
    return True


def create_tray_icon_image(size: int = 64):
    """Generate a crisp, high-contrast dark badge with an elegant cyan/amber 3D prism wireframe."""
    try:
        from PIL import Image, ImageDraw
    except ImportError as exc:
        raise RuntimeError(f"Pillow is required to generate the tray icon: {exc}") from exc

    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = s * 0.05
    # Dark circular badge with vibrant cyan-slate boundary
    draw.ellipse(
        (pad, pad, s - pad, s - pad),
        fill=(13, 17, 23, 252),
        outline=(56, 189, 248, 170),
        width=max(2, int(s * 0.025)),
    )

    cx, cy = s / 2, s / 2
    top = (cx, s * 0.16)
    bottom = (cx, s * 0.84)
    left = (s * 0.20, cy)
    right = (s * 0.80, cy)
    front = (cx, s * 0.56)
    back = (cx, s * 0.44)

    # Back wireframe (depth cue)
    dim_edge = (71, 85, 105, 120)
    w_thin = max(1, int(s * 0.015))
    draw.line([top, back], fill=dim_edge, width=w_thin)
    draw.line([bottom, back], fill=dim_edge, width=w_thin)
    draw.line([left, back], fill=dim_edge, width=w_thin)
    draw.line([right, back], fill=dim_edge, width=w_thin)

    # Facet fills (3D crystal appearance)
    draw.polygon([top, left, front], fill=(6, 182, 212, 140))      # Cyan top-left
    draw.polygon([top, right, front], fill=(245, 158, 11, 150))    # Amber top-right
    draw.polygon([bottom, left, front], fill=(14, 116, 144, 200))  # Deep cyan bottom-left
    draw.polygon([bottom, right, front], fill=(180, 83, 9, 210))   # Deep amber bottom-right

    # Wireframe front edges
    edge_cyan = (56, 189, 248, 255)
    edge_amber = (251, 191, 36, 255)
    spine_front = (240, 249, 255, 255)
    w = max(2, int(s * 0.025))

    draw.line([top, left], fill=edge_cyan, width=w)
    draw.line([left, bottom], fill=edge_cyan, width=w)
    draw.line([left, front], fill=edge_cyan, width=w)

    draw.line([top, right], fill=edge_amber, width=w)
    draw.line([right, bottom], fill=edge_amber, width=w)
    draw.line([right, front], fill=edge_amber, width=w)

    draw.line([top, front], fill=spine_front, width=w)
    draw.line([front, bottom], fill=spine_front, width=w)

    # Vertex node points
    node_r = max(2, int(s * 0.028))
    for pt, col in [
        (top, spine_front),
        (bottom, spine_front),
        (left, edge_cyan),
        (right, edge_amber),
        (front, spine_front),
    ]:
        draw.ellipse((pt[0] - node_r, pt[1] - node_r, pt[0] + node_r, pt[1] + node_r), fill=col)

    return img.resize((size, size), Image.Resampling.LANCZOS)


def resolve_library_path(arg_path: str | None = None) -> Path:
    """Resolve library directory according to priority rules:

    1. Explicit --library CLI argument
    2. $YMIR_LIBRARY environment variable
    3. ~/.local/share/ymir (if it exists)
    4. REPO_ROOT (fallback)
    """
    if arg_path:
        return Path(arg_path).expanduser().resolve()
    env_path = os.environ.get("YMIR_LIBRARY")
    if env_path:
        return Path(env_path).expanduser().resolve()
    default_share = Path.home() / ".local" / "share" / "ymir"
    if default_share.is_dir():
        return default_share.resolve()
    if _IS_WINDOWS:
        local_app = os.environ.get("LOCALAPPDATA")
        if local_app:
            win_lib = Path(local_app) / "Ymir"
            if win_lib.is_dir():
                return win_lib.resolve()
        app_data = os.environ.get("APPDATA")
        if app_data:
            win_lib = Path(app_data) / "Ymir"
            if win_lib.is_dir():
                return win_lib.resolve()
    return REPO_ROOT.resolve()


def is_port_in_use(port: int) -> bool:
    """Check if a TCP port is currently open and listening."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def is_server_already_running(port: int) -> bool:
    """Check if our Ymir asset server is already responding on this port."""
    for path in ["/api/session", "/ymir/browser/"]:
        try:
            url = f"http://127.0.0.1:{port}{path}"
            req = urllib.request.Request(url, headers={"User-Agent": "YmirTrayCheck"})
            with urllib.request.urlopen(req, timeout=1.2) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            continue
    return False


def _powershell_quote(value: str) -> str:
    """Quote one PowerShell single-quoted string literal."""
    return "'" + str(value).replace("'", "''") + "'"


def _windows_toast_classic(summary: str, body: str) -> bool:
    """Show a Windows toast notification through WinRT via PowerShell (Windows 10+)."""
    script = ";".join([
        "$ErrorActionPreference = 'Stop'",
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
        "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent("
        "[Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
        "$texts = $template.GetElementsByTagName('text')",
        f"$texts.Item(0).AppendChild($template.CreateTextNode({_powershell_quote(summary)})) | Out-Null",
        f"$texts.Item(1).AppendChild($template.CreateTextNode({_powershell_quote(body)})) | Out-Null",
        "$toast = [Windows.UI.Notifications.ToastNotification]::new($template)",
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("
        f"{_powershell_quote(APP_TITLE)}).Show($toast)",
    ])
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            check=False,
            capture_output=True,
            timeout=10,
        )
        return completed.returncode == 0
    except Exception:
        return False


def notify(summary: str, body: str, icon_name: str = "dialog-information",
           icon=None) -> None:
    """Send a desktop notification using notify-send or platform mechanism."""
    if _IS_WINDOWS:
        if icon is not None:
            try:
                icon.notify(body, summary)
                return
            except Exception:
                pass
        _windows_toast_classic(summary, body)
        return
    try:
        subprocess.run(
            ["notify-send", "-a", APP_TITLE, "-i", icon_name, summary, body],
            check=False,
            capture_output=True,
        )
    except Exception:
        pass


def open_browser(url: str) -> None:
    """Open URL in the user's default web browser."""
    if _IS_WINDOWS:
        try:
            if webbrowser.open(url):
                return
        except Exception:
            pass
        try:
            os.startfile(url)  # type: ignore[attr-defined]
            return
        except Exception:
            pass
    try:
        subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        webbrowser.open(url)


def open_folder(path: Path) -> None:
    """Open directory in the system file manager."""
    if not path.exists():
        path.mkdir(parents=True, exist_ok=True)
    if _IS_WINDOWS:
        try:
            os.startfile(str(path))  # type: ignore[attr-defined]
            return
        except Exception:
            pass
        try:
            subprocess.Popen(["explorer", str(path)])
            return
        except Exception:
            pass
    try:
        subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def run_cli_server(port: int, library_dir: Path) -> int:
    """Run the Node.js asset server in the foreground with CLI logs and Ctrl+C shutdown."""
    node_bin = shutil.which("node") or "node"
    cmd = [
        node_bin,
        str(SERVE_SCRIPT),
        "--port", str(port),
        "--library", str(library_dir),
    ]
    print(f"Starting {APP_TITLE} asset server (CLI mode)...")
    print(f"  Library: {library_dir}")
    print(f"  URL:     http://127.0.0.1:{port}/")
    print("Press Ctrl+C to stop.\n")

    proc = subprocess.Popen(cmd, cwd=str(REPO_ROOT))

    def _sig_handler(sig, frame):
        if proc.poll() is None:
            proc.terminate()

    signal.signal(signal.SIGINT, _sig_handler)
    signal.signal(signal.SIGTERM, _sig_handler)

    try:
        ret = proc.wait()
        return 0 if ret in (0, -signal.SIGTERM, -signal.SIGINT) else ret
    except (KeyboardInterrupt, SystemExit):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                proc.kill()
        return 0


class YmirTrayController:
    """Coordinates the Node.js asset server subprocess and the GTK/Cinnamon tray icon."""

    def __init__(self, port: int = DEFAULT_PORT, library_dir: Path | None = None,
                 auto_open: bool = True) -> None:
        self.port = port
        self.library_dir = library_dir or resolve_library_path()
        self.auto_open = auto_open
        self.url = f"http://127.0.0.1:{self.port}/"
        self.proc: subprocess.Popen | None = None
        self.icon = None
        self._shutdown_lock = threading.Lock()
        self._is_shutting_down = False
        self._log_thread: threading.Thread | None = None

    def start_server(self) -> bool:
        """Start or verify the Node.js asset server."""
        if is_server_already_running(self.port):
            notify(
                f"{APP_TITLE} already active",
                f"Opening existing browser at {self.url}",
                icon_name="dialog-information",
                icon=self.icon,
            )
            if self.auto_open:
                open_browser(self.url)
            return False

        # If port is occupied by something else, search nearby ports
        selected_port = self.port
        if is_port_in_use(selected_port):
            for p in range(self.port + 1, self.port + 11):
                if not is_port_in_use(p):
                    selected_port = p
                    break
            else:
                notify(
                    f"{APP_TITLE} Startup Error",
                    f"Port {self.port} is busy and no nearby port available.",
                    icon_name="dialog-error",
                    icon=self.icon,
                )
                return False

        self.port = selected_port
        self.url = f"http://127.0.0.1:{self.port}/"

        node_bin = shutil.which("node") or "node"
        cmd = [
            node_bin,
            str(SERVE_SCRIPT),
            "--port", str(self.port),
            "--library", str(self.library_dir),
        ]

        try:
            self.proc = subprocess.Popen(
                cmd,
                cwd=str(REPO_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except Exception as exc:
            notify(
                f"{APP_TITLE} Startup Error",
                f"Failed to launch Node server: {exc}",
                icon_name="dialog-error",
                icon=self.icon,
            )
            return False

        def _drain_output():
            if not self.proc or not self.proc.stdout:
                return
            for line in self.proc.stdout:
                line_str = line.strip()
                if line_str:
                    print(f"[{APP_TITLE} Server] {line_str}", flush=True)

        self._log_thread = threading.Thread(target=_drain_output, name="ymir-node-log", daemon=True)
        self._log_thread.start()

        # Wait for the server to begin responding
        start_time = time.time()
        ready = False
        while time.time() - start_time < 5.0:
            if self.proc.poll() is not None:
                notify(
                    f"{APP_TITLE} Server Exited",
                    f"Server exited unexpectedly with code {self.proc.returncode}",
                    icon_name="dialog-error",
                    icon=self.icon,
                )
                return False
            if is_server_already_running(self.port):
                ready = True
                break
            time.sleep(0.1)

        if not ready:
            print(f"Notice: server on port {self.port} took longer than expected to report ready.", flush=True)

        return True

    def build_menu(self):
        import pystray
        return pystray.Menu(
            pystray.MenuItem("Open Ymir Browser", lambda icon, item: open_browser(self.url), default=True),
            pystray.MenuItem("Open Library Folder", lambda icon, item: open_folder(self.library_dir)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit Ymir", lambda icon, item: self.shutdown()),
        )

    def run(self) -> int:
        if not self.start_server():
            return 0

        try:
            import pystray
            if not _IS_WINDOWS:
                _install_gtk_popup_patch(pystray.Icon)

            icon_image = create_tray_icon_image(64)
            self.icon = pystray.Icon(
                "Ymir",
                icon_image,
                f"{APP_TITLE} (Port {self.port})",
                menu=self.build_menu(),
            )
        except Exception as exc:
            print(f"Warning: could not initialize system tray ({exc}). Running with background server.", file=sys.stderr)
            if self.auto_open:
                open_browser(self.url)
            try:
                if self.proc:
                    return self.proc.wait()
            except KeyboardInterrupt:
                self.shutdown()
                return 0

        notify(
            f"{APP_TITLE} is running",
            f"Active at {self.url}\nRight-click panel icon for menu or Quit.",
            icon_name="dialog-information",
            icon=self.icon,
        )

        if self.auto_open:
            open_browser(self.url)

        def _handle_signal(sig, frame):
            self.shutdown()

        signal.signal(signal.SIGINT, _handle_signal)
        signal.signal(signal.SIGTERM, _handle_signal)

        try:
            self.icon.run()
        except KeyboardInterrupt:
            self.shutdown()

        return 0

    def shutdown(self) -> None:
        with self._shutdown_lock:
            if self._is_shutting_down:
                return
            self._is_shutting_down = True

        notify(f"{APP_TITLE} stopped", "The server has been shut down.", "process-stop", icon=self.icon)

        if self.icon:
            try:
                self.icon.stop()
            except Exception:
                pass

        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=3.0)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=1.0)
            except Exception:
                pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ymir tray application and server launcher")
    parser.add_argument("port", nargs="?", type=int, help=f"HTTP port (default: {DEFAULT_PORT})")
    parser.add_argument("--port", dest="port_option", type=int, help=f"HTTP port (default: {DEFAULT_PORT})")
    parser.add_argument("-l", "--library", dest="library", type=str,
                        help="Path to Ymir library root (default: $YMIR_LIBRARY, ~/.local/share/ymir, or repo root)")
    parser.add_argument("--no-tray", "--cli", dest="cli", action="store_true",
                        help="Run the HTTP server in the foreground without the tray")
    parser.add_argument("--no-open", dest="no_open", action="store_true",
                        help="Do not automatically open the browser on launch")
    args = parser.parse_args(argv)

    port = args.port_option if args.port_option is not None else (args.port if args.port is not None else DEFAULT_PORT)
    if not 1 <= port <= 65535:
        print(f"error: invalid port: {port}", file=sys.stderr)
        return 2

    library_dir = resolve_library_path(args.library)

    # Detect headless environment (no GUI display server)
    is_headless = not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))

    if args.cli or is_headless:
        if is_headless and not args.cli:
            print("Notice: No DISPLAY or WAYLAND_DISPLAY found; running in CLI mode.", file=sys.stderr)
        return run_cli_server(port=port, library_dir=library_dir)

    controller = YmirTrayController(port=port, library_dir=library_dir, auto_open=not args.no_open)
    return controller.run()


if __name__ == "__main__":
    sys.exit(main())
