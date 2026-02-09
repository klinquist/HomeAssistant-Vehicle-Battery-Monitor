# Vehicle Battery Monitor → Home Assistant (MQTT bridge)

Supports the **Ancel** BM6 or BM7 (BM300 Pro) Bluetooth battery monitors, commonly found on Amazon or AliExpress for roughly $20–40 each.

This runs on a *separate* computer (near the BLE devices), and is intended to run well on a Raspberry Pi. It scans for BM6/BM7 (BM300 Pro) monitors, reads voltage / battery % / temperature, and publishes them to Home Assistant via **MQTT Discovery**.

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

## Notes

- Home Assistant cannot “prompt to name” devices when using pure MQTT discovery. The bridge publishes a default name (e.g. `BM6 aa:bb:cc:dd:ee:ff`). You can rename the device/entities in Home Assistant UI.
- Devices are stored via retained MQTT messages under `bm6bm7/registry/#` (no device list in `config.json`).
- If a device isn’t currently in range (e.g. vehicle is away), the bridge skips reads and marks it `offline` via availability.
- If you’re running this from a copy on another machine (like a Pi), make sure you’ve updated that copy after changes here (e.g. `git pull`, or re-copy this repo folder).
- Linux is the primary target (BlueZ via `node-ble`). macOS can work via the optional `@abandonware/noble` path.
