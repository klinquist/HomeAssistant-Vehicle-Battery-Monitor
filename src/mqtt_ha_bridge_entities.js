"use strict";

function buildBridgeDevicePayload() {
  return {
    identifiers: ["bm6bm7_bridge"],
    name: "BM6/BM7 Bridge",
    manufacturer: "bluetooth-battery-monitor",
    model: "MQTT bridge",
  };
}

function buttonConfig({ discoveryPrefix, uniqueId, name, commandTopic }) {
  return {
    configTopic: `${discoveryPrefix}/button/${uniqueId}/config`,
    payload: {
      name,
      unique_id: uniqueId,
      command_topic: commandTopic,
      payload_press: "PRESS",
      availability_topic: "bm6bm7/bridge/availability",
      payload_available: "online",
      payload_not_available: "offline",
      device: buildBridgeDevicePayload(),
    },
  };
}

function sensorConfig({ discoveryPrefix, uniqueId, name, stateTopic, valueTemplate }) {
  return {
    configTopic: `${discoveryPrefix}/sensor/${uniqueId}/config`,
    payload: {
      name,
      unique_id: uniqueId,
      state_topic: stateTopic,
      value_template: valueTemplate,
      json_attributes_topic: stateTopic,
      availability_topic: "bm6bm7/bridge/availability",
      payload_available: "online",
      payload_not_available: "offline",
      entity_category: "diagnostic",
      icon: "mdi:bluetooth",
      device: buildBridgeDevicePayload(),
    },
  };
}

function buildBridgeButtons(discoveryPrefix) {
  return [
    buttonConfig({
      discoveryPrefix,
      uniqueId: "bm6bm7_bridge_scan",
      name: "Scan BM6/BM7",
      commandTopic: "bm6bm7/bridge/cmd/scan",
    }),
    buttonConfig({
      discoveryPrefix,
      uniqueId: "bm6bm7_bridge_update",
      name: "Update BM6/BM7 Now",
      commandTopic: "bm6bm7/bridge/cmd/poll",
    }),
  ];
}

function buildBridgeSensors(discoveryPrefix) {
  return [
    sensorConfig({
      discoveryPrefix,
      uniqueId: "bm6bm7_bridge_status",
      name: "BM6/BM7 Bridge Status",
      stateTopic: "bm6bm7/bridge/state",
      valueTemplate: "{{ value_json.status }}",
    }),
  ];
}

function buildBridgeDiscovery(discoveryPrefix) {
  return [...buildBridgeButtons(discoveryPrefix), ...buildBridgeSensors(discoveryPrefix)];
}

module.exports = {
  buildBridgeDiscovery,
};
