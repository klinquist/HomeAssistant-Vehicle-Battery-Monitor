"use strict";

function macToId(mac) {
  return String(mac || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildDevicePayload(address, deviceName, model) {
  const id = macToId(address);
  const normalizedModel = model === "bm6" ? "BM6" : model === "bm7" ? "BM7/BM300 Pro" : "Unknown";
  return {
    identifiers: [`bm6bm7_${id}`],
    name: deviceName,
    manufacturer: "BM6/BM7",
    model: normalizedModel,
  };
}

function sensorConfig({
  discoveryPrefix,
  address,
  deviceName,
  model,
  sensorKey,
  name,
  unit,
  deviceClass,
  expireAfterSec,
}) {
  const id = macToId(address);
  const uniqueId = `bm6bm7_${id}_${sensorKey}`;
  const objectId = `bm6bm7_${id}_${sensorKey}`;

  const payload = {
    name,
    unique_id: uniqueId,
    object_id: objectId,
    state_topic: `bm6bm7/${id}/state/${sensorKey}`,
    availability_topic: `bm6bm7/${id}/availability`,
    payload_available: "online",
    payload_not_available: "offline",
    device_class: deviceClass,
    unit_of_measurement: unit,
    state_class: "measurement",
    device: buildDevicePayload(address, deviceName, model),
  };

  if (Number.isFinite(expireAfterSec) && expireAfterSec > 0) {
    payload.expire_after = expireAfterSec;
  }

  return {
    configTopic: `${discoveryPrefix}/sensor/${uniqueId}/config`,
    payload,
  };
}

function buildAllSensorConfigs({ discoveryPrefix, address, deviceName, model, expireAfterSec }) {
  return [
    sensorConfig({
      discoveryPrefix,
      address,
      deviceName,
      model,
      expireAfterSec,
      sensorKey: "voltage",
      name: "Voltage",
      unit: "V",
      deviceClass: "voltage",
    }),
    sensorConfig({
      discoveryPrefix,
      address,
      deviceName,
      model,
      expireAfterSec,
      sensorKey: "battery",
      name: "Battery",
      unit: "%",
      deviceClass: "battery",
    }),
    sensorConfig({
      discoveryPrefix,
      address,
      deviceName,
      model,
      expireAfterSec,
      sensorKey: "temperature",
      name: "Temperature",
      unit: "°C",
      deviceClass: "temperature",
    }),
  ];
}

module.exports = {
  macToId,
  buildAllSensorConfigs,
};
