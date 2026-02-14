#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const mqtt = require("mqtt");

const { buildAllSensorConfigs, macToId } = require("./mqtt_ha_discovery");
const { createBleClient, inferModelFromAdvertisedName, normalizeAddress } = require("./bm6bm7_ble");
const { buildBridgeDiscovery } = require("./mqtt_ha_bridge_entities");
const { registryTopicForAddress, parseRegistryPayload, buildRegistryPayload, mergeEntry } = require("./registry");

process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("Uncaught exception:", err);
});

function nowIso() {
  return new Date().toISOString();
}

function formatErr(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function normalizeBridgeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function readBluetoothMacFromSysfs() {
  const root = "/sys/class/bluetooth";
  try {
    const entries = fs.readdirSync(root);
    for (const entry of entries) {
      if (!/^hci\d+$/.test(entry)) continue;
      const addrPath = path.join(root, entry, "address");
      if (!fs.existsSync(addrPath)) continue;
      const raw = fs.readFileSync(addrPath, "utf8").trim();
      if (raw) return raw;
    }
  } catch {
    // ignore
  }
  return "";
}

function macSuffix(mac, length) {
  const hex = String(mac || "").toLowerCase().replace(/[^0-9a-f]+/g, "");
  if (hex.length < length) return "";
  return hex.slice(-length);
}

function resolveBridgeId(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const token = trimmed.toLowerCase();
  if (token === "auto" || token === "btmac4" || token === "mac4") {
    const mac = readBluetoothMacFromSysfs();
    return normalizeBridgeId(macSuffix(mac, 4));
  }
  return normalizeBridgeId(trimmed);
}

function buildBridgeTopics(bridgeId) {
  const base = bridgeId ? `bm6bm7/${bridgeId}` : "bm6bm7";
  return {
    bridgeId,
    base,
    registryPrefix: `${base}/registry`,
    bridgeAvailabilityTopic: `${base}/bridge/availability`,
    bridgeStateTopic: `${base}/bridge/state`,
    bridgeCmdPrefix: `${base}/bridge/cmd`,
  };
}

function parseArgs(argv) {
  const args = { scan: false, configPath: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scan") args.scan = true;
    else if (arg === "--config") args.configPath = argv[i + 1] || "";
  }
  return args;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function loadConfig(args) {
  const defaultPath = path.join(__dirname, "..", "config.json");
  const configPath = args.configPath ? path.resolve(process.cwd(), args.configPath) : defaultPath;
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath} (copy config.example.json to config.json).`);
  }
  const cfg = readJson(configPath);

  const mqttCfg = cfg.mqtt || {};
  const bridgeIdRaw = typeof mqttCfg.bridgeId === "string" ? mqttCfg.bridgeId : "";
  const bridgeIdHint = String(bridgeIdRaw || "").trim().toLowerCase();
  const bridgeIdAuto = bridgeIdHint === "auto" || bridgeIdHint === "btmac4" || bridgeIdHint === "mac4";
  const bridgeId = resolveBridgeId(bridgeIdRaw);
  const clientIdRaw = typeof mqttCfg.clientId === "string" ? mqttCfg.clientId.trim() : "";
  const defaultClientId = "bm6bm7-bridge";
  const clientId =
    clientIdRaw && (!bridgeId || clientIdRaw !== defaultClientId)
      ? clientIdRaw
      : bridgeId
        ? `${defaultClientId}-${bridgeId}`
        : defaultClientId;
  return {
    mqtt: {
      url: mqttCfg.url || "mqtt://localhost:1883",
      username: mqttCfg.username || "",
      password: mqttCfg.password || "",
      discoveryPrefix: mqttCfg.discoveryPrefix || "homeassistant",
      clientId,
      bridgeId,
      bridgeIdAuto,
    },
    scanMs: Number.isFinite(cfg.scanMs) ? cfg.scanMs : 7000,
    connectScanMs: Number.isFinite(cfg.connectScanMs) ? cfg.connectScanMs : 20000,
    readTimeoutMs: Number.isFinite(cfg.readTimeoutMs) ? cfg.readTimeoutMs : 20000,
    pollIntervalSec: Number.isFinite(cfg.pollIntervalSec) ? cfg.pollIntervalSec : 300,
    failureBackoffSec: Number.isFinite(cfg.failureBackoffSec) ? cfg.failureBackoffSec : 300,
  };
}

function connectMqtt(mqttCfg, bridgeTopics) {
  const client = mqtt.connect(mqttCfg.url, {
    clientId: mqttCfg.clientId,
    username: mqttCfg.username || undefined,
    password: mqttCfg.password || undefined,
    will: {
      topic: bridgeTopics.bridgeAvailabilityTopic,
      payload: "offline",
      retain: true,
      qos: 0,
    },
  });
  return client;
}

function mqttPublish(client, topic, payload, { retain = false } = {}) {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { retain }, (err) => (err ? reject(err) : resolve()));
  });
}

async function publishDiscoveryForDevice(client, mqttCfg, device, expireAfterSec) {
  const configs = buildAllSensorConfigs({
    discoveryPrefix: mqttCfg.discoveryPrefix,
    address: device.address,
    deviceName: device.name,
    model: device.model,
    expireAfterSec,
  });
  for (const item of configs) {
    await mqttPublish(client, item.configTopic, JSON.stringify(item.payload), { retain: true });
  }
}

async function publishBridgeDiscovery(client, mqttCfg, bridgeTopics) {
  const messages = buildBridgeDiscovery({
    discoveryPrefix: mqttCfg.discoveryPrefix,
    bridgeId: bridgeTopics.bridgeId,
    availabilityTopic: bridgeTopics.bridgeAvailabilityTopic,
    stateTopic: bridgeTopics.bridgeStateTopic,
    commandPrefix: bridgeTopics.bridgeCmdPrefix,
  });
  for (const message of messages) {
    await mqttPublish(client, message.configTopic, JSON.stringify(message.payload), { retain: true });
  }
}

async function publishAvailability(client, address, online) {
  const id = macToId(address);
  await mqttPublish(client, `bm6bm7/${id}/availability`, online ? "online" : "offline", { retain: true });
}

async function publishState(client, address, reading) {
  const id = macToId(address);
  const retain = true;
  await mqttPublish(client, `bm6bm7/${id}/state/voltage`, String(reading.voltage), { retain });
  await mqttPublish(client, `bm6bm7/${id}/state/battery`, String(reading.soc), { retain });
  await mqttPublish(client, `bm6bm7/${id}/state/temperature`, String(reading.temperature), { retain });
}

async function publishBridgeState(client, state, bridgeTopics) {
  await mqttPublish(client, bridgeTopics.bridgeStateTopic, JSON.stringify(state), { retain: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args);
  const bridgeTopics = buildBridgeTopics(config.mqtt.bridgeId);
  if (config.mqtt.bridgeIdAuto && !config.mqtt.bridgeId) {
    // eslint-disable-next-line no-console
    console.error("Bridge ID auto mode enabled but Bluetooth MAC was not found; using default topics.");
  }
  const known = new Map(); // address -> {address, name, model, createdAt, updatedAt}
  const discoveredModels = new Map(); // address -> model (bm6/bm7)
  const discoverySignature = new Map(); // address -> signature
  const lastSeenMsByAddress = new Map(); // address -> ms
  const availabilityByAddress = new Map(); // address -> boolean
  const backoffUntilMsByAddress = new Map(); // address -> ms
  const expireAfterSec = Math.max(0, Math.round(config.pollIntervalSec * 2 + 30));
  const seenRecentlyMs = Math.max(config.pollIntervalSec * 2 * 1000, 60 * 60 * 1000);
  const modelWarningOnce = new Set();
  let scanRunning = false;

  const bridgeState = {
    status: "starting",
    devices_known: 0,
    last_scan_started: "",
    last_scan_finished: "",
    last_scan_found: 0,
    last_poll_started: "",
    last_poll_finished: "",
    last_poll_ok: 0,
    last_poll_fail: 0,
    next_poll_at: "",
    last_error: "",
    updated_at: nowIso(),
  };

  async function setBridgeState(patch) {
    bridgeState.devices_known = known.size;
    Object.assign(bridgeState, patch);
    bridgeState.updated_at = nowIso();
    try {
      await publishBridgeState(mqttClient, bridgeState, bridgeTopics);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Bridge state publish failed:", err && err.message ? err.message : err);
    }
  }

  function logInfo(message, extra) {
    // eslint-disable-next-line no-console
    console.log(`[${new Date().toISOString()}] ${message}`, extra || "");
  }

  function logError(message, err) {
    // eslint-disable-next-line no-console
    console.error(`[${new Date().toISOString()}] ${message}`, err || "");
  }

  async function announceNextPoll(delayMs, reason) {
    const when = new Date(Date.now() + Math.max(0, delayMs));
    const nextPollAt = when.toISOString();
    await setBridgeState({ next_poll_at: nextPollAt });
    logInfo("Next poll scheduled.", { at: nextPollAt, reason: reason || "" });
  }

  const mqttClient = connectMqtt(config.mqtt, bridgeTopics);
  mqttClient.on("connect", async () => {
    try {
      await mqttPublish(mqttClient, bridgeTopics.bridgeAvailabilityTopic, "online", { retain: true });
      await publishBridgeDiscovery(mqttClient, config.mqtt, bridgeTopics);
      mqttClient.subscribe(`${bridgeTopics.registryPrefix}/#`);
      mqttClient.subscribe(`${bridgeTopics.bridgeCmdPrefix}/#`);
      await setBridgeState({ status: "idle", last_error: "" });
      logInfo("MQTT connected; bridge ready.", {
        connectScanMs: config.connectScanMs,
        readTimeoutMs: config.readTimeoutMs,
        pollIntervalSec: config.pollIntervalSec,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("MQTT publish failed:", err);
    }
  });

  mqttClient.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("MQTT error:", err);
  });

  const ble = await createBleClient();
  let stopping = false;
  let bleLock = Promise.resolve();

  function withBleLock(task) {
    const run = async () => task();
    const next = bleLock.then(run, run);
    bleLock = next.catch(() => {});
    return next;
  }

  async function scanOnce() {
    const results = await withBleLock(() => ble.scanDevices(config.scanMs));
    const now = Date.now();
    for (const item of results) {
      const address = normalizeAddress(item.address);
      const model = inferModelFromAdvertisedName(item.name);
      if (model) discoveredModels.set(address, model);
      if (Number.isFinite(item.rssi)) {
        lastSeenMsByAddress.set(address, now);
      }

      if (!known.has(address)) {
        const defaultName = item.name === "BM6" ? `BM6 ${address}` : `BM7 ${address}`;
        known.set(address, { address, name: defaultName, model, createdAt: "", updatedAt: "" });
      } else {
        const existing = known.get(address);
        if (!existing.model && model) existing.model = model;
        if (!existing.name) {
          existing.name = item.name === "BM6" ? `BM6 ${address}` : `BM7 ${address}`;
        }
      }
    }
    return results;
  }

  async function upsertRegistry(device) {
    const entry = mergeEntry(known.get(device.address), device);
    known.set(device.address, entry);
    const topic = registryTopicForAddress(entry.address, bridgeTopics.registryPrefix);
    await mqttPublish(mqttClient, topic, buildRegistryPayload(entry), { retain: true });
    discoverySignature.delete(entry.address);
    await ensureDiscoveryPublished(entry.address);
    await setBridgeState({});
  }

  async function setAvailability(address, online) {
    const previous = availabilityByAddress.get(address);
    if (previous === online) return;
    availabilityByAddress.set(address, online);
    try {
      await publishAvailability(mqttClient, address, online);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Availability publish failed:", err && err.message ? err.message : err);
    }
  }

  async function ensureDiscoveryPublished(address) {
    const device = known.get(address);
    if (!device) return;
    if (!device.model) device.model = discoveredModels.get(address) || "";
    const signature = `${device.model}|${device.name}|${config.mqtt.discoveryPrefix}|${expireAfterSec}`;
    if (discoverySignature.get(address) === signature) {
      return;
    }
    await publishDiscoveryForDevice(mqttClient, config.mqtt, device, expireAfterSec);
    discoverySignature.set(address, signature);
  }

  async function pollOnce() {
    await setBridgeState({ status: "polling", last_poll_started: nowIso(), last_poll_ok: 0, last_poll_fail: 0, last_error: "" });
    logInfo("Poll started.", { devices: known.size, connectScanMs: config.connectScanMs, readTimeoutMs: config.readTimeoutMs });

    if (scanRunning) {
      logInfo("Pre-scan skipped because a scan is already running.");
    } else {
      try {
        logInfo("Pre-scan started.");
        const preScanResults = await scanOnce();
        logInfo("Pre-scan finished.", { found: preScanResults.length });
      } catch (err) {
        logError("Pre-scan failed.", err && err.message ? err.message : err);
      }
    }

    const addresses = Array.from(known.keys());
    for (const address of addresses) {
      await ensureDiscoveryPublished(address);
    }

    const now = Date.now();
    const eligibleAddresses = addresses.filter((address) => {
      const backoffUntil = backoffUntilMsByAddress.get(address) || 0;
      if (now < backoffUntil) return false;
      return true;
    });

    if (!eligibleAddresses.length) return;

    const found = await withBleLock(() => ble.findDevicesByAddress(eligibleAddresses, config.connectScanMs));
    if (found.size !== eligibleAddresses.length) {
      const missing = eligibleAddresses.filter((address) => !found.get(address));
      logInfo("Devices missing after connect scan.", { missing, found: found.size, expected: eligibleAddresses.length });
    }
    let okCount = 0;
    let failCount = 0;
    for (const address of eligibleAddresses) {
      const device = known.get(address);
      if (!device) continue;

      const model = device.model || discoveredModels.get(address) || "";
      if (model !== "bm6" && model !== "bm7") {
        if (!modelWarningOnce.has(address)) {
          modelWarningOnce.add(address);
          // eslint-disable-next-line no-console
          console.error(`Skipping ${address}: unknown model. Press Scan or publish registry with model bm6/bm7.`);
        }
        await setAvailability(address, false);
        continue;
      }

      const handle = found.get(address);
      if (!handle) {
        await setAvailability(address, false);
        logError(`Read failed (${address}).`, "Device not found in connect scan.");
        failCount += 1;
        continue;
      }

      const label = device.name ? `${device.name} (${address})` : address;

      const attemptRead = async (attempt, attemptModel) => {
        logInfo("Read attempt.", { address, model: attemptModel, attempt });
        return withBleLock(() => ble.readBatteryData(handle, attemptModel, config.readTimeoutMs));
      };

      try {
        let reading;
        try {
          reading = await attemptRead(1, model);
        } catch (err) {
          const message = String(err && err.message ? err.message : err);
          logError(`Read attempt 1 failed for ${label}.`, message);

          if (message.toLowerCase().includes("timed out waiting")) {
            const fallback = model === "bm6" ? "bm7" : "bm6";
            logInfo("Retrying with model fallback.", { address, from: model, to: fallback });
            reading = await attemptRead(2, fallback);
            device.model = fallback;
            discoveredModels.set(address, fallback);
            await upsertRegistry(device);
          } else {
            // Retry once with same model after short delay
            await new Promise((r) => setTimeout(r, 1500));
            reading = await attemptRead(2, model);
          }
        }

        await publishState(mqttClient, address, reading);
        await setAvailability(address, true);
        lastSeenMsByAddress.set(address, Date.now());
        backoffUntilMsByAddress.delete(address);
        logInfo("Reading ok.", {
          address,
          name: device.name || "",
          model: device.model || model,
          voltage: reading.voltage,
          soc: reading.soc,
          temperature: reading.temperature,
        });
        okCount += 1;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`Read failed (${address}):`, err && err.message ? err.message : err);
        await setAvailability(address, false);
        backoffUntilMsByAddress.set(address, Date.now() + Math.max(1, config.failureBackoffSec) * 1000);
        failCount += 1;
      }
    }

    await setBridgeState({
      status: "idle",
      last_poll_finished: nowIso(),
      last_poll_ok: okCount,
      last_poll_fail: failCount,
    });
    logInfo("Poll finished.", { ok: okCount, fail: failCount });
  }

  function schedulePollLoop() {
    const pollMs = Math.max(5, config.pollIntervalSec) * 1000;
    let timer = null;

    const tick = async () => {
      if (stopping) return;
      try {
        await pollOnce();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Poll failed:", err && err.message ? err.message : err);
      } finally {
        if (!stopping) {
          timer = setTimeout(tick, pollMs);
          await announceNextPoll(pollMs, "interval");
        }
      }
    };

    timer = setTimeout(tick, 2000);
    announceNextPoll(2000, "startup").catch(() => {});
    return () => timer && clearTimeout(timer);
  }

  mqttClient.on("message", async (topic, payloadBuf) => {
    const payload = payloadBuf ? payloadBuf.toString("utf8") : "";

    if (topic.startsWith(`${bridgeTopics.registryPrefix}/`)) {
      const entry = parseRegistryPayload(payload);
      if (!entry) return;
      known.set(entry.address, entry);
      discoverySignature.delete(entry.address);
      try {
        await ensureDiscoveryPublished(entry.address);
        await setBridgeState({});
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Discovery publish failed:", err && err.message ? err.message : err);
      }
      return;
    }

    if (topic === `${bridgeTopics.bridgeCmdPrefix}/scan`) {
      if (payload && payload !== "PRESS") return;
      if (scanRunning) {
        logInfo("Scan requested but already running; ignoring.");
        await setBridgeState({ last_error: "Scan already in progress" });
        return;
      }
      scanRunning = true;
      logInfo("Scan command received.");
      try {
        await setBridgeState({ status: "scanning", last_scan_started: nowIso(), last_scan_found: 0, last_error: "" });
        const results = await scanOnce();
        await setBridgeState({ last_scan_found: results.length });
        logInfo("Scan finished.", { found: results.length });
        for (const item of results) {
          const address = normalizeAddress(item.address);
          const model = inferModelFromAdvertisedName(item.name);
          const existing = known.get(address);
          const name = existing && existing.name ? "" : (item.name === "BM6" ? `BM6 ${address}` : `BM7 ${address}`);
          await upsertRegistry({ address, model, name });
        }
        await setBridgeState({ status: "idle", last_scan_finished: nowIso() });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Scan command failed:", err && err.message ? err.message : err);
        await setBridgeState({ status: "error", last_error: formatErr(err), last_scan_finished: nowIso() });
        logError("Scan command failed.", err && err.message ? err.message : err);
      } finally {
        scanRunning = false;
      }
      return;
    }

    if (topic === `${bridgeTopics.bridgeCmdPrefix}/poll`) {
      if (payload && payload !== "PRESS") return;
      logInfo("Poll command received.");
      try {
        await pollOnce();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Poll command failed:", err && err.message ? err.message : err);
        await setBridgeState({ status: "error", last_error: formatErr(err), last_poll_finished: nowIso() });
        logError("Poll command failed.", err && err.message ? err.message : err);
      }
    }
  });

  if (args.scan) {
    const results = await scanOnce();
    // eslint-disable-next-line no-console
    console.log("Address           RSSI  Name");
    results.forEach((d) => {
      // eslint-disable-next-line no-console
      console.log(`${d.address} ${d.rssi} ${d.name}`);
    });
    stopping = true;
    await ble.destroy();
    mqttClient.end(true);
    return;
  }

  const cancelPoll = schedulePollLoop();

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    cancelPoll();
    try {
      await mqttPublish(mqttClient, bridgeTopics.bridgeAvailabilityTopic, "offline", { retain: true });
    } catch {
      // ignore
    }
    try {
      await ble.destroy();
    } catch {
      // ignore
    }
    for (const address of known.keys()) {
      try {
        await setAvailability(address, false);
      } catch {
        // ignore
      }
    }
    mqttClient.end(true);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive; all work is event/timer driven.
  await new Promise(() => {});
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
