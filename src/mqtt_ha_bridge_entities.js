"use strict";

function bridgeUniqueId(bridgeId, suffix) {
  const base = bridgeId ? `bm6bm7_bridge_${bridgeId}` : "bm6bm7_bridge";
  return `${base}_${suffix}`;
}

function buildBridgeDevicePayload(bridgeId) {
  const id = bridgeId ? `bm6bm7_bridge_${bridgeId}` : "bm6bm7_bridge";
  const name = bridgeId ? `BM6/BM7 Bridge ${bridgeId}` : "BM6/BM7 Bridge";
  return {
    identifiers: [id],
    name,
    manufacturer: "bluetooth-battery-monitor",
    model: "MQTT bridge",
  };
}

function buttonConfig({ discoveryPrefix, uniqueId, name, commandTopic, availabilityTopic, bridgeId }) {
  return {
    configTopic: `${discoveryPrefix}/button/${uniqueId}/config`,
    payload: {
      name,
      unique_id: uniqueId,
      command_topic: commandTopic,
      payload_press: "PRESS",
      availability_topic: availabilityTopic,
      payload_available: "online",
      payload_not_available: "offline",
      device: buildBridgeDevicePayload(bridgeId),
    },
  };
}

function sensorConfig({ discoveryPrefix, uniqueId, name, stateTopic, valueTemplate, availabilityTopic, bridgeId }) {
  return {
    configTopic: `${discoveryPrefix}/sensor/${uniqueId}/config`,
    payload: {
      name,
      unique_id: uniqueId,
      state_topic: stateTopic,
      value_template: valueTemplate,
      json_attributes_topic: stateTopic,
      availability_topic: availabilityTopic,
      payload_available: "online",
      payload_not_available: "offline",
      entity_category: "diagnostic",
      icon: "mdi:bluetooth",
      device: buildBridgeDevicePayload(bridgeId),
    },
  };
}

function buildBridgeButtons({ discoveryPrefix, bridgeId, availabilityTopic, commandPrefix }) {
  return [
    buttonConfig({
      discoveryPrefix,
      uniqueId: bridgeUniqueId(bridgeId, "scan"),
      name: "Scan BM6/BM7",
      commandTopic: `${commandPrefix}/scan`,
      availabilityTopic,
      bridgeId,
    }),
    buttonConfig({
      discoveryPrefix,
      uniqueId: bridgeUniqueId(bridgeId, "update"),
      name: "Update BM6/BM7 Now",
      commandTopic: `${commandPrefix}/poll`,
      availabilityTopic,
      bridgeId,
    }),
  ];
}

function buildBridgeSensors({ discoveryPrefix, bridgeId, availabilityTopic, stateTopic }) {
  return [
    sensorConfig({
      discoveryPrefix,
      uniqueId: bridgeUniqueId(bridgeId, "status"),
      name: "BM6/BM7 Bridge Status",
      stateTopic,
      valueTemplate: "{{ value_json.status }}",
      availabilityTopic,
      bridgeId,
    }),
  ];
}

function buildBridgeDiscovery({ discoveryPrefix, bridgeId, availabilityTopic, stateTopic, commandPrefix }) {
  return [
    ...buildBridgeButtons({ discoveryPrefix, bridgeId, availabilityTopic, commandPrefix }),
    ...buildBridgeSensors({ discoveryPrefix, bridgeId, availabilityTopic, stateTopic }),
  ];
}

module.exports = {
  buildBridgeDiscovery,
};
