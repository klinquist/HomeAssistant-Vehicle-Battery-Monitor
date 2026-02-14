# Vehicle Battery Monitor → Home Assistant (MQTT bridge)

Supports the **Ancel** BM6 or BM7 (BM300 Pro) Bluetooth battery monitors, commonly found on Amazon or AliExpress for $20–40 each.

This runs on a *separate* computer (near the BLE devices), and is intended to run well on a Raspberry Pi. It scans for BM6/BM7 (BM300 Pro) monitors, reads voltage / battery % / temperature, and publishes them to Home Assistant via **MQTT Discovery**.

## Requirements

- Node.js 18+
- Bluetooth (BlueZ on Linux)

## Home Assistant setup

1. Ensure Home Assistant has the **MQTT** integration set up (e.g. Mosquitto broker add-on, or any external broker).
2. Make sure this bridge can reach the broker and authenticate.

## Bridge setup (on the BLE machine)

```sh
cd HomeAssistant-Vehicle-Battery-Monitor
npm install
cp config.example.json config.json
node src/index.js
```

Edit `config.json` to set your MQTT broker URL (Home Assistant host) and any username/password before starting the bridge.

### `config.json` options

- `mqtt.url`: MQTT broker URL (usually your Home Assistant host).
- `mqtt.username` / `mqtt.password`: MQTT credentials if required.
- `mqtt.discoveryPrefix`: Home Assistant MQTT discovery prefix (default `homeassistant`).
- `mqtt.bridgeId`: Optional bridge ID to namespace bridge/registry topics and the bridge entities in Home Assistant. Set to `"auto"` to derive the last 4 hex chars of the Bluetooth MAC (Linux/BlueZ).
- `mqtt.clientId`: MQTT client ID for this bridge. If empty or set to `bm6bm7-bridge`, it will be auto-suffixed when `bridgeId` is set.
- `scanMs`: BLE scan duration in ms when you press “Scan BM6/BM7”.
- `connectScanMs`: How long to scan for known devices before polling.
- `readTimeoutMs`: Timeout waiting for a device to respond.
- `pollIntervalSec`: How often to poll all known devices (default once per day).
- `failureBackoffSec`: Backoff time after a failed read before trying that device again.

## Usage (from Home Assistant)

- After the bridge starts, it publishes two MQTT-discovered buttons in Home Assistant:
  - `Scan BM6/BM7`: scans for devices and adds them (publishes discovery + stores them in a retained MQTT registry)
  - `Update BM6/BM7 Now`: immediately polls all known devices and updates sensor states
- The bridge also polls on a schedule (`pollIntervalSec`, default once per day).
- For visibility/debugging:
  - Use the `BM6/BM7 Bridge Status` sensor (attributes include last scan/poll times and counts).
  - The status sensor also includes `next_poll_at` so you can see when the next scheduled poll will run.
  - In Home Assistant → MQTT → “Listen to a topic”, listen on `bm6bm7/bridge/#` and `bm6bm7/registry/#`.
  - Watch the bridge process logs (e.g. `journalctl -u <your-service>` if you run it as a systemd service).
    - Logs now include pre-scan timing, per-device read attempts, and retries.

This is meant to run continuously under a process manager like `pm2` (or systemd).

## Autostart (Raspberry Pi)

Raspberry Pi OS uses `systemd` by default. You can install a service with the included script:

```sh
cd HomeAssistant-Vehicle-Battery-Monitor
chmod +x scripts/install-systemd.sh
sudo ./scripts/install-systemd.sh
```

The install script checks for Node.js 18+ (warns if older), validates that `config.json` exists and includes all keys from `config.example.json`, and runs `npm install` if `node_modules` is missing.

Logs: `sudo journalctl -u vehicle-battery-monitor -f`

## Notes

- Home Assistant cannot “prompt to name” devices when using pure MQTT discovery. The bridge publishes a default name (e.g. `BM6 aa:bb:cc:dd:ee:ff`). You can rename the device/entities in Home Assistant UI.
- Devices are stored via retained MQTT messages under `bm6bm7/registry/#` (or `bm6bm7/<bridgeId>/registry/#` if you set `mqtt.bridgeId`).
- If a device isn’t currently in range (e.g. vehicle is away), the bridge skips reads and marks it `offline` via availability.
- Linux is the primary target (BlueZ via `node-ble`). macOS can work via the optional `@abandonware/noble` path.

## Multiple bridges

- Set a unique `mqtt.bridgeId` per host (or `"auto"`).
- If `mqtt.clientId` is empty or set to `bm6bm7-bridge`, it defaults to `bm6bm7-bridge-<bridgeId>`.
- Enabling `bridgeId` creates a new Bridge device (buttons/status) in Home Assistant; remove the old one if you want.
- To clean up old retained topics, clear `bm6bm7/bridge/#` and `bm6bm7/registry/#` on the broker.
