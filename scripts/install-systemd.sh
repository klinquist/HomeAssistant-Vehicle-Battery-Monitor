#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="vehicle-battery-monitor"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_PATH="$(command -v node || true)"
if [[ -n "${NODE_PATH}" ]]; then
  NODE_PATH="$(readlink -f "${NODE_PATH}")"
fi

if [[ -z "${NODE_PATH}" ]]; then
  echo "Error: node not found in PATH."
  exit 1
fi

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

cat <<EOF | sudo tee "${SERVICE_FILE}" >/dev/null
[Unit]
Description=Vehicle Battery Monitor MQTT Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=${NODE_PATH} ${REPO_DIR}/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

echo "Installed and started ${SERVICE_NAME}."
echo "Logs: sudo journalctl -u ${SERVICE_NAME} -f"
