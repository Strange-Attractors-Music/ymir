#!/usr/bin/env bash
set -euo pipefail

# Ymir Installer for Linux Mint / Debian / Ubuntu
# Installs Ymir application, desktop tray runner, and shared asset library.

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default XDG destinations
PREFIX="${PREFIX:-${HOME}/.local}"
BIN_DIR="${BIN_DIR:-${PREFIX}/bin}"
LIB_DIR="${LIB_DIR:-${PREFIX}/lib/ymir}"
DATA_DIR="${DATA_DIR:-${PREFIX}/share/ymir}"
APPLICATIONS_DIR="${APPLICATIONS_DIR:-${PREFIX}/share/applications}"
ICONS_DIR="${ICONS_DIR:-${PREFIX}/share/icons/hicolor/64x64/apps}"

PORT=4174
INSTALL_LIBRARY=true

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --prefix PATH         Install prefix (default: ~/.local)
  --bin-dir PATH        Directory for 'ymir' binary (default: ~/.local/bin)
  --lib-dir PATH        Directory for Ymir app files (default: ~/.local/lib/ymir)
  --library-dir PATH    Directory for Ymir asset library (default: ~/.local/share/ymir)
  --skip-library        Do not install or overwrite assets in the library directory
  -h, --help            Show this help message

Requirements:
  - Node.js (v18+) and npm
  - Python 3 (v3.10+) with GTK3/GObject introspection (standard on Mint/Ubuntu)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      PREFIX="$2"
      BIN_DIR="${PREFIX}/bin"
      LIB_DIR="${PREFIX}/lib/ymir"
      DATA_DIR="${PREFIX}/share/ymir"
      APPLICATIONS_DIR="${PREFIX}/share/applications"
      ICONS_DIR="${PREFIX}/share/icons/hicolor/64x64/apps"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="$2"
      shift 2
      ;;
    --lib-dir)
      LIB_DIR="$2"
      shift 2
      ;;
    --library-dir)
      DATA_DIR="$2"
      shift 2
      ;;
    --skip-library)
      INSTALL_LIBRARY=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

echo "=========================================="
echo "Installing Ymir for Linux Mint / Ubuntu"
echo "=========================================="
echo "  Binary:       ${BIN_DIR}/ymir"
echo "  Application:  ${LIB_DIR}"
echo "  Library:      ${DATA_DIR}"
echo ""

# 1. Check prerequisites
if ! command -v node >/dev/null 2>&1; then
  echo "Error: 'node' (Node.js) is required but not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: 'npm' is required but not found in PATH." >&2
  exit 1
fi

SYSTEM_PYTHON=""
for py in /usr/bin/python3 python3; do
  if command -v "$py" >/dev/null 2>&1; then
    SYSTEM_PYTHON="$(command -v "$py")"
    break
  fi
done

if [[ -z "$SYSTEM_PYTHON" ]]; then
  echo "Error: Python 3 is required but not found." >&2
  exit 1
fi

# 2. Prepare directories
mkdir -p "${BIN_DIR}" "${LIB_DIR}" "${DATA_DIR}" "${APPLICATIONS_DIR}" "${ICONS_DIR}"

# 3. Install application files into LIB_DIR
echo "--> Copying application files to ${LIB_DIR}..."
mkdir -p "${LIB_DIR}/browser" "${LIB_DIR}/tools" "${LIB_DIR}/materials" "${LIB_DIR}/colors" "${LIB_DIR}/effects"

cp -r "${SOURCE_DIR}/browser/"* "${LIB_DIR}/browser/"
cp -r "${SOURCE_DIR}/tools/"* "${LIB_DIR}/tools/"
cp "${SOURCE_DIR}/package.json" "${LIB_DIR}/"
[[ -f "${SOURCE_DIR}/package-lock.json" ]] && cp "${SOURCE_DIR}/package-lock.json" "${LIB_DIR}/"
[[ -f "${SOURCE_DIR}/vite.config.mjs" ]] && cp "${SOURCE_DIR}/vite.config.mjs" "${LIB_DIR}/"

# Copy materials, colors, effects to app so default viewer always has fallback assets
if [[ -d "${SOURCE_DIR}/materials" ]]; then
  cp -r "${SOURCE_DIR}/materials/"* "${LIB_DIR}/materials/"
fi
if [[ -d "${SOURCE_DIR}/colors" ]]; then
  cp -r "${SOURCE_DIR}/colors/"* "${LIB_DIR}/colors/"
fi
if [[ -d "${SOURCE_DIR}/effects" ]]; then
  cp -r "${SOURCE_DIR}/effects/"* "${LIB_DIR}/effects/"
fi

# 4. Install npm dependencies (including Trinity WebGL renderer)
echo "--> Installing Node.js dependencies (Trinity renderer)..."
(
  cd "${LIB_DIR}"
  if [[ -f "${SOURCE_DIR}/node_modules/trinity/package.json" ]]; then
    # Fast path: copy already-installed node_modules
    mkdir -p "${LIB_DIR}/node_modules"
    cp -r "${SOURCE_DIR}/node_modules/"* "${LIB_DIR}/node_modules/"
  else
    npm ci --omit=dev || npm install --omit=dev
  fi
)

# 4a. Prefer the locally built Trinity release when this workspace checkout is
# installed. The package URL remains the portable fallback for standalone Ymir
# checkouts that do not have the sibling Trinity source tree.
TRINITY_SOURCE_DIR="${SOURCE_DIR}/../trinity"
if [[ -f "${TRINITY_SOURCE_DIR}/package.json" ]] && node -e 'process.exit(require(process.argv[1]).name==="trinity"?0:1)' "${TRINITY_SOURCE_DIR}/package.json"; then
  TRINITY_VERSION="$(node -p 'require(process.argv[1]).version' "${TRINITY_SOURCE_DIR}/package.json")"
  TRINITY_BUNDLE="${TRINITY_SOURCE_DIR}/dist/trinity-${TRINITY_VERSION}.mjs"
  if [[ -f "${TRINITY_BUNDLE}" ]]; then
    echo "--> Installing the workspace-built Trinity ${TRINITY_VERSION} renderer..."
    cp "${TRINITY_SOURCE_DIR}/package.json" "${LIB_DIR}/node_modules/trinity/package.json"
    mkdir -p "${LIB_DIR}/node_modules/trinity/dist"
    cp "${TRINITY_BUNDLE}" "${LIB_DIR}/node_modules/trinity/dist/"
    if [[ -f "${TRINITY_SOURCE_DIR}/dist/SHA256SUMS" ]]; then
      cp "${TRINITY_SOURCE_DIR}/dist/SHA256SUMS" "${LIB_DIR}/node_modules/trinity/dist/"
    fi
  fi
fi

# 5. Set up Python virtual environment for tray dependencies (pystray, Pillow, system GTK3)
echo "--> Setting up Python environment for system tray integration..."
VENV_DIR="${LIB_DIR}/.venv"
if [[ -x "${VENV_DIR}/bin/python" ]]; then
  echo "--> Existing virtual environment found; keeping intact."
elif command -v uv >/dev/null 2>&1; then
  uv venv --python "${SYSTEM_PYTHON}" --system-site-packages "${VENV_DIR}"
  uv pip install --python "${VENV_DIR}/bin/python" pystray pillow
else
  "${SYSTEM_PYTHON}" -m venv --system-site-packages "${VENV_DIR}"
  "${VENV_DIR}/bin/pip" install --quiet pystray pillow
fi

# 6. Install or sync asset library to DATA_DIR
if [[ "$INSTALL_LIBRARY" == "true" ]]; then
  if [[ -f "${DATA_DIR}/catalog.json" ]]; then
    echo "--> Existing catalog found at ${DATA_DIR}; keeping existing library intact."
  else
    echo "--> Installing initial asset library to ${DATA_DIR}..."
    for item in catalog.json models props textures generators; do
      if [[ -e "${SOURCE_DIR}/${item}" ]]; then
        cp -r "${SOURCE_DIR}/${item}" "${DATA_DIR}/"
      fi
    done
  fi
  # Keep live shader suites and their referenced effects/color generators in
  # sync even when an existing catalog and user library are being preserved.
  for item in materials colors effects; do
    if [[ -d "${SOURCE_DIR}/${item}" ]]; then
      mkdir -p "${DATA_DIR}/${item}"
      cp -r "${SOURCE_DIR}/${item}/." "${DATA_DIR}/${item}/"
    fi
  done
fi

# 7. Generate application icon
ICON_FILE="${ICONS_DIR}/ymir.png"
echo "--> Generating desktop icon at ${ICON_FILE}..."
"${VENV_DIR}/bin/python" -c "
import sys
from pathlib import Path
sys.path.insert(0, '${LIB_DIR}/tools')
from tray import create_tray_icon_image
img = create_tray_icon_image(64)
img.save('${ICON_FILE}')
" || true

# 8. Create desktop shortcut (.desktop file)
DESKTOP_FILE="${APPLICATIONS_DIR}/ymir.desktop"
echo "--> Creating desktop launcher at ${DESKTOP_FILE}..."
cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Type=Application
Name=Ymir
Comment=Ymir 3D Model, Prop & Material Catalog Browser
Exec=${BIN_DIR}/ymir
Icon=${ICON_FILE}
Terminal=false
Categories=Graphics;3DGraphics;AudioVideo;
StartupNotify=true
EOF
chmod +x "${DESKTOP_FILE}"

# 9. Create terminal executable (~/.local/bin/ymir)
EXE_FILE="${BIN_DIR}/ymir"
echo "--> Creating executable binary at ${EXE_FILE}..."
cat > "${EXE_FILE}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

LIB_DIR="${LIB_DIR}"
PYTHON="${VENV_DIR}/bin/python"
DEFAULT_LIBRARY="${DATA_DIR}"

if [[ ! -x "\${PYTHON}" ]]; then
  PYTHON="\$(command -v python3)"
fi

export YMIR_LIBRARY="\${YMIR_LIBRARY:-\${DEFAULT_LIBRARY}}"

exec "\${PYTHON}" "\${LIB_DIR}/tools/tray.py" "\$@"
EOF
chmod +x "${EXE_FILE}"

echo ""
echo "=========================================="
echo "Installation complete!"
echo "=========================================="
echo "You can now run 'ymir' from your terminal."
echo "If '${BIN_DIR}' is not in your PATH, add it to your ~/.bashrc:"
echo "  export PATH=\"${BIN_DIR}:\$PATH\""
echo "=========================================="
