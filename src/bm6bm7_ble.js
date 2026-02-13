"use strict";

const crypto = require("crypto");

const BM6_KEY = Buffer.from([108, 101, 97, 103, 101, 110, 100, 255, 254, 48, 49, 48, 48, 48, 48, 57]);
const BM7_KEY = Buffer.from([108, 101, 97, 103, 101, 110, 100, 255, 254, 48, 49, 48, 48, 48, 48, 64]);
const COMMAND_HEX = "d1550700000000000000000000000000";
const NOTIFY_UUID = "fff4";
const WRITE_UUID = "fff3";
const BASE_UUID_SUFFIX = "00001000800000805f9b34fb";

function normalizeAddress(address) {
  if (!address) return "";
  return String(address).toLowerCase();
}

function isBmDeviceName(name) {
  return name === "BM6" || name === "BM300 Pro";
}

function inferModelFromAdvertisedName(name) {
  if (name === "BM6") return "bm6";
  if (name === "BM300 Pro") return "bm7";
  return "";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encryptCommand(key) {
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  const plaintext = Buffer.from(COMMAND_HEX, "hex");
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptPayload(payload, key) {
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
  return decrypted.toString("hex");
}

function normalizeUuid(uuid) {
  return String(uuid).toLowerCase().replace(/-/g, "");
}

function expandUuid(uuid) {
  const normalized = normalizeUuid(uuid);
  if (normalized.length === 4) return `0000${normalized}${BASE_UUID_SUFFIX}`;
  if (normalized.length === 8) return `${normalized}${BASE_UUID_SUFFIX}`;
  return normalized;
}

function uuidMatches(candidate, shortUuid) {
  return expandUuid(candidate) === expandUuid(shortUuid);
}

function parseBatteryMessage(messageHex, model) {
  if (!messageHex || messageHex.length < 32) return null;

  if (model === "bm6") {
    if (!messageHex.startsWith("d15507")) return null;
  } else if (model === "bm7") {
    if (!messageHex.startsWith("d1550700")) return null;
  } else {
    return null;
  }

  const signByte = messageHex.slice(6, 8);
  if (signByte !== "00" && signByte !== "01") return null;

  const voltage = parseInt(messageHex.slice(15, 18), 16) / 100;
  const soc = parseInt(messageHex.slice(12, 14), 16);
  const tempValue = parseInt(messageHex.slice(8, 10), 16);
  const temperature = signByte === "01" ? -tempValue : tempValue;

  if (!Number.isFinite(voltage) || !Number.isFinite(soc) || !Number.isFinite(temperature)) {
    return null;
  }

  return { voltage, soc, temperature };
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
  });
}

async function ensurePoweredBluez(adapter) {
  const powered = await adapter.isPowered();
  if (!powered) throw new Error("Bluetooth adapter is not powered on.");
}

async function scanDevicesBluez(adapter, scanMs) {
  await ensurePoweredBluez(adapter);
  const wasDiscovering = await adapter.isDiscovering();
  if (!wasDiscovering) await adapter.startDiscovery();

  await wait(scanMs);
  const deviceIds = await adapter.devices();

  const results = [];
  for (const id of deviceIds) {
    const device = await adapter.getDevice(id);
    let name = "";
    try {
      name = await device.getName();
    } catch {
      name = "";
    }
    if (!isBmDeviceName(name)) continue;

    let rssi = null;
    try {
      rssi = await device.getRSSI();
    } catch {
      rssi = null;
    }

    let address = "";
    try {
      address = await device.getAddress();
    } catch {
      address = id;
    }

    results.push({ address: normalizeAddress(address || id), rssi, name });
  }

  if (!wasDiscovering) await adapter.stopDiscovery();
  return results;
}

async function findDevicesByAddressBluez(adapter, addresses, scanMs) {
  const targets = addresses.map(normalizeAddress).filter(Boolean);
  const found = new Map();

  if (!targets.length) return found;

  await ensurePoweredBluez(adapter);
  const wasDiscovering = await adapter.isDiscovering();
  if (!wasDiscovering) await adapter.startDiscovery();

  const results = await Promise.all(
    targets.map(async (address) => {
      try {
        const device = await adapter.waitDevice(address, scanMs, 1000);
        return { address, device };
      } catch {
        return null;
      }
    })
  );

  for (const result of results) {
    if (result) found.set(result.address, result.device);
  }

  if (!wasDiscovering) await adapter.stopDiscovery();
  return found;
}

async function findCharacteristicByUuid(gattServer, shortUuid) {
  const services = await gattServer.services();
  for (const serviceId of services) {
    const service = await gattServer.getPrimaryService(serviceId);
    const characteristics = await service.characteristics();
    const match = characteristics.find((charId) => uuidMatches(charId, shortUuid));
    if (match) return service.getCharacteristic(match);
  }
  return null;
}

async function readBatteryDataBluez(device, model, readTimeoutMs) {
  const key = model === "bm6" ? BM6_KEY : BM7_KEY;
  const command = encryptCommand(key);

  let notifyChar = null;
  try {
    await withTimeout(device.connect(), readTimeoutMs, `Timed out connecting to ${model.toUpperCase()}.`);
    const gattServer = await device.gatt();
    const writeChar = await findCharacteristicByUuid(gattServer, WRITE_UUID);
    notifyChar = await findCharacteristicByUuid(gattServer, NOTIFY_UUID);
    if (!writeChar || !notifyChar) throw new Error(`Missing required characteristics on ${model.toUpperCase()}.`);

    let cleanup = () => {};
    const dataPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${model.toUpperCase()} data.`));
      }, readTimeoutMs);

      function onValueChanged(buffer) {
        const messageHex = decryptPayload(buffer, key);
        const parsed = parseBatteryMessage(messageHex, model);
        if (parsed) {
          cleanup();
          resolve(parsed);
        }
      }

      cleanup = () => {
        clearTimeout(timeout);
        try {
          notifyChar.removeListener("valuechanged", onValueChanged);
        } catch {
          // ignore
        }
      };

      notifyChar.on("valuechanged", onValueChanged);
    });

    try {
      if (typeof notifyChar.stopNotifications === "function") {
        try {
          await notifyChar.stopNotifications();
        } catch {
          // ignore
        }
      }
      await notifyChar.startNotifications();
      await writeChar.writeValueWithResponse(command);
      return await dataPromise;
    } catch (err) {
      cleanup();
      dataPromise.catch(() => {});
      throw err;
    } finally {
      cleanup();
      if (typeof notifyChar.stopNotifications === "function") {
        try {
          await notifyChar.stopNotifications();
        } catch {
          // ignore
        }
      }
    }
  } finally {
    try {
      await device.disconnect();
    } catch {
      // ignore
    }
  }
}

function createNobleClient() {
  let noble;
  try {
    noble = require("@abandonware/noble");
  } catch (err) {
    throw new Error("Missing @abandonware/noble dependency. Run npm install.");
  }

  function waitForNobleState(timeoutMs) {
    if (noble.state && noble.state !== "unknown") return Promise.resolve(noble.state);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(noble.state || "unknown");
      }, timeoutMs);
      const onChange = (state) => {
        cleanup();
        resolve(state);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        noble.removeListener("stateChange", onChange);
      };
      noble.on("stateChange", onChange);
    });
  }

  async function ensureNoblePowered() {
    if (noble.state === "poweredOn") return;
    const state = await waitForNobleState(5000);
    if (state !== "poweredOn") throw new Error(`Bluetooth not ready (state: ${state}).`);
  }

  function startNobleScan() {
    return new Promise((resolve, reject) => {
      noble.startScanning([], true, (err) => (err ? reject(err) : resolve()));
    });
  }

  function stopNobleScan() {
    try {
      noble.stopScanning();
    } catch {
      // ignore
    }
  }

  function getNobleAddress(peripheral) {
    return normalizeAddress(peripheral.id || peripheral.address);
  }

  function getNobleName(peripheral) {
    return String((peripheral.advertisement && peripheral.advertisement.localName) || "").trim();
  }

  async function scanDevices(scanMs) {
    await ensureNoblePowered();
    stopNobleScan();
    const found = new Map();
    const onDiscover = (peripheral) => {
      const name = getNobleName(peripheral);
      if (!isBmDeviceName(name)) return;
      const address = getNobleAddress(peripheral);
      if (!address) return;
      found.set(address, { address, rssi: peripheral.rssi, name });
    };
    noble.on("discover", onDiscover);
    try {
      await startNobleScan();
      await wait(scanMs);
    } finally {
      stopNobleScan();
      noble.removeListener("discover", onDiscover);
    }
    return Array.from(found.values());
  }

  async function findDevicesByAddress(addresses, scanMs) {
    const targetSet = new Set(addresses.map(normalizeAddress).filter(Boolean));
    const found = new Map();
    if (!targetSet.size) return found;

    await ensureNoblePowered();
    stopNobleScan();

    return new Promise((resolve, reject) => {
      const finish = () => {
        stopNobleScan();
        noble.removeListener("discover", onDiscover);
        resolve(found);
      };

      const timeout = setTimeout(finish, scanMs);
      const onDiscover = (peripheral) => {
        const address = getNobleAddress(peripheral);
        if (!address || !targetSet.has(address)) return;
        if (!found.has(address)) found.set(address, peripheral);
        if (found.size === targetSet.size) {
          clearTimeout(timeout);
          finish();
        }
      };

      noble.on("discover", onDiscover);
      startNobleScan().catch((err) => {
        clearTimeout(timeout);
        noble.removeListener("discover", onDiscover);
        reject(err);
      });
    });
  }

  function connectPeripheral(peripheral, timeoutMs, label) {
    return withTimeout(
      new Promise((resolve, reject) => {
        peripheral.connect((err) => (err ? reject(err) : resolve()));
      }),
      timeoutMs,
      `Timed out connecting to ${label}.`
    );
  }

  function disconnectPeripheral(peripheral) {
    return new Promise((resolve) => peripheral.disconnect(() => resolve()));
  }

  function discoverCharacteristics(peripheral) {
    return new Promise((resolve, reject) => {
      peripheral.discoverAllServicesAndCharacteristics((err, services, characteristics) => {
        if (err) return reject(err);
        resolve(characteristics || []);
      });
    });
  }

  function subscribeCharacteristic(characteristic) {
    return new Promise((resolve, reject) => {
      characteristic.subscribe((err) => (err ? reject(err) : resolve()));
    });
  }

  function writeCharacteristic(characteristic, buffer) {
    return new Promise((resolve, reject) => {
      characteristic.write(buffer, false, (err) => (err ? reject(err) : resolve()));
    });
  }

  async function readBatteryData(peripheral, model, readTimeoutMs) {
    const key = model === "bm6" ? BM6_KEY : BM7_KEY;
    const command = encryptCommand(key);

    let notifyChar = null;
    try {
      await connectPeripheral(peripheral, readTimeoutMs, model.toUpperCase());
      const characteristics = await discoverCharacteristics(peripheral);
      const writeChar = characteristics.find((char) => uuidMatches(char.uuid, WRITE_UUID));
      notifyChar = characteristics.find((char) => uuidMatches(char.uuid, NOTIFY_UUID));
      if (!writeChar || !notifyChar) throw new Error(`Missing required characteristics on ${model.toUpperCase()}.`);

      const dataPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${model.toUpperCase()} data.`));
        }, readTimeoutMs);

        function onData(buffer) {
          const messageHex = decryptPayload(buffer, key);
          const parsed = parseBatteryMessage(messageHex, model);
          if (parsed) {
            cleanup();
            resolve(parsed);
          }
        }

        function cleanup() {
          clearTimeout(timeout);
          notifyChar.removeListener("data", onData);
          if (typeof notifyChar.unsubscribe === "function") notifyChar.unsubscribe(() => {});
        }

        notifyChar.on("data", onData);
        subscribeCharacteristic(notifyChar)
          .then(() => writeCharacteristic(writeChar, command))
          .catch((err) => {
            cleanup();
            reject(err);
          });
      });

      return await dataPromise;
    } finally {
      try {
        await disconnectPeripheral(peripheral);
      } catch {
        // ignore
      }
    }
  }

  return {
    scanDevices,
    findDevicesByAddress,
    readBatteryData,
    destroy: async () => stopNobleScan(),
  };
}

async function createBleClient() {
  if (process.platform === "darwin") return createNobleClient();

  const { createBluetooth } = require("node-ble");
  const { bluetooth, destroy } = createBluetooth();
  const adapter = await bluetooth.defaultAdapter();
  return {
    scanDevices: (scanMs) => scanDevicesBluez(adapter, scanMs),
    findDevicesByAddress: (addresses, scanMs) => findDevicesByAddressBluez(adapter, addresses, scanMs),
    readBatteryData: (device, model, readTimeoutMs) => readBatteryDataBluez(device, model, readTimeoutMs),
    destroy,
  };
}

module.exports = {
  createBleClient,
  inferModelFromAdvertisedName,
  isBmDeviceName,
  normalizeAddress,
};
