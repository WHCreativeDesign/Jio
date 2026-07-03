#!/usr/bin/env bash
# Jio installer for Raspberry Pi OS (and other Debian-flavoured Linux).
# Run from the repo root: sudo bash deploy/install.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "please run with sudo: sudo bash deploy/install.sh" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR=/opt/jio
SERVICE_USER="${SUDO_USER:-pi}"

echo ">> installing system packages..."
apt-get update -qq
apt-get install -y -qq python3 python3-venv

echo ">> copying jio to ${INSTALL_DIR}..."
mkdir -p "$INSTALL_DIR"
cp -r "$REPO_DIR/jio" "$REPO_DIR/requirements.txt" "$INSTALL_DIR/"

echo ">> creating virtualenv..."
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"

echo ">> installing systemd service (runs as ${SERVICE_USER})..."
cp "$REPO_DIR/deploy/jio.service" "/etc/systemd/system/jio@.service"
systemctl daemon-reload
systemctl enable --now "jio@${SERVICE_USER}"

IP="$(hostname -I | awk '{print $1}')"
echo ""
echo "== jio is up! open http://${IP}:8420 from any device on your network =="
