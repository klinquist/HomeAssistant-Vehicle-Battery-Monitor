#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="vehicle-battery-monitor"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_PATH="$(command -v node || true)"
REQUIRED_NODE_MAJOR=18
if [[ -n "${NODE_PATH}" ]]; then
  NODE_PATH="$(readlink -f "${NODE_PATH}")"
fi

if [[ -z "${NODE_PATH}" ]]; then
  echo "Error: node not found in PATH."
  exit 1
fi

NODE_VERSION="$("${NODE_PATH}" -p "process.versions.node")"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ -z "${NODE_MAJOR}" || ! "${NODE_MAJOR}" =~ ^[0-9]+$ ]]; then
  echo "Error: could not detect Node.js version."
  exit 1
fi
if (( NODE_MAJOR < REQUIRED_NODE_MAJOR )); then
  echo "Error: Node.js ${REQUIRED_NODE_MAJOR}+ required (found ${NODE_VERSION}). Continuing anyway." >&2
fi

CONFIG_FILE="${REPO_DIR}/config.json"
EXAMPLE_FILE="${REPO_DIR}/config.example.json"
if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "Error: Missing config.json. Copy config.example.json to config.json and edit it."
  exit 1
fi

"${NODE_PATH}" -e '
"${NODE_PATH}" -e '
const fs = require("fs");
const [,, configPath, examplePath] = process.argv;
function load(path) {
  const raw = fs.readFileSync(path, "utf8");
  return JSON.parse(raw);
}
function collectPaths(obj, prefix = "") {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const paths = [];
  for (const key of Object.keys(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      paths.push(next);
      paths.push(...collectPaths(value, next));
    } else {
      paths.push(next);
    }
  }
  return paths;
}
function hasPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) {
      return false;
    }
    cur = cur[part];
  }
  return true;
}
let config;
let example;
try {
  config = load(configPath);
} catch (err) {
  console.error(`Error: failed to parse ${configPath}: ${err.message || err}`);
  process.exit(1);
}
try {
  example = load(examplePath);
} catch (err) {
  console.error(`Error: failed to parse ${examplePath}: ${err.message || err}`);
  process.exit(1);
}
const expected = Array.from(new Set(collectPaths(example))).sort();
const missing = expected.filter((path) => !hasPath(config, path));
if (missing.length) {
  console.error("Error: config.json is missing required keys:");
  for (const path of missing) {
    console.error(`  - ${path}`);
  }
  process.exit(1);
}
' "${CONFIG_FILE}" "${EXAMPLE_FILE}"

NODE_MODULES_DIR="${REPO_DIR}/node_modules"
if [[ ! -d "${NODE_MODULES_DIR}" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm not found in PATH. Please install npm and run npm install." >&2
    exit 1
  fi
  echo "node_modules not found; running npm install..."
  (cd "${REPO_DIR}" && npm install)
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
