#!/usr/bin/env bash
# Jio installer for Raspberry Pi OS (and other Debian-flavoured Linux).
# Run from the repo root: sudo bash deploy/install.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "please run with sudo: sudo bash deploy/install.sh" >&2
  exit 1
fi

INSTALL_DIR=/opt/jio
SERVICE_USER="${SUDO_USER:-pi}"
REPO_URL="${JIO_REPO_URL:-https://github.com/WHCreativeDesign/Jio.git}"
BRANCH="${JIO_BRANCH:-main}"

echo ">> installing system packages..."
apt-get update -qq
apt-get install -y -qq python3 python3-venv git

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo ">> ${INSTALL_DIR} is already a git checkout, updating it..."
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
  echo ">> cloning jio to ${INSTALL_DIR}..."
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

echo ">> creating virtualenv..."
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --quiet -r "$INSTALL_DIR/requirements.txt"

echo ">> setting ownership (${SERVICE_USER})..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

echo ">> installing systemd service (runs as ${SERVICE_USER})..."
cp "$INSTALL_DIR/deploy/jio.service" "/etc/systemd/system/jio@.service"
systemctl daemon-reload
systemctl enable --now "jio@${SERVICE_USER}"

IP="$(hostname -I | awk '{print $1}')"
echo ""
echo "== jio is up! open http://${IP}:8420 from any device on your network =="
echo "== self-update is available from the CONFIG tab, or set auto_update in the config file =="
